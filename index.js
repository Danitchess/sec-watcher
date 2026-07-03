// =====================================================================
// SEC Watcher v2
// Surveille les nouveaux depots SEC EDGAR (flux "toutes societes" 8-K /
// 10-Q / 10-K), demande a un LLM si le ton est positif / negatif / neutre,
// genere un site web (docs/index.html, GitHub Pages) et envoie un email
// digest (Brevo). Zero dependance (fetch natif Node 20+).
// =====================================================================

import fs from "node:fs/promises";

const {
  SEC_USER_AGENT,          // OBLIGATOIRE par la SEC, ex: "PE Watcher pe@email.com"
  LLM_API_URL,             // ex: "https://api.groq.com/openai/v1/chat/completions"
  LLM_API_KEY,
  LLM_MODEL,               // ex: "llama-3.3-70b-versatile"
  BREVO_API_KEY,           // cle API Brevo (facultatif : pas d'email si absent)
  EMAIL_FROM,              // expediteur VERIFIE dans Brevo
  EMAIL_TO,                // ton adresse de reception
  FINNHUB_API_KEY,         // cle Finnhub (facultatif : pas de cours/capi si absent)
} = process.env;

// Types surveilles. 8-K = evenements importants (meilleur signal +/-).
const FORMS_WATCHED = ["8-K"];
// Combien de depots on analyse au max par passage (budget LLM).
const MAX_ANALYZE = Number(process.env.MAX_ANALYZE || 3);
// Quels sentiments declenchent un email. Defaut : positif uniquement.
// Mets "positif,negatif" pour les deux, ou "" (vide) pour tout recevoir.
const NOTIFY_SENTIMENT = new Set(
  (process.env.NOTIFY_SENTIMENT ?? "positif")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
// Score minimum pour declencher un email POSITIF (defaut 75 : assez positif).
const NOTIFY_MIN_SCORE = Number(process.env.NOTIFY_MIN_SCORE ?? 75);
// Score maximum pour declencher un email NEGATIF (defaut 25 : assez negatif).
const NOTIFY_MAX_SCORE = Number(process.env.NOTIFY_MAX_SCORE ?? 25);
// Combien de resultats on garde dans l'historique du site.
const HISTORY_SIZE = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Filtre optionnel : si companies.json contient des CIK, on ne garde que ceux-la.
// Vide ([]) = on surveille TOUTES les societes (mode firehose).
async function loadFilter() {
  try {
    const arr = JSON.parse(await fs.readFile("companies.json", "utf8"));
    return new Set(arr.map((c) => String(Number(c.cik)))); // CIK sans zeros
  } catch {
    return new Set();
  }
}

async function secFetch(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": SEC_USER_AGENT, "Accept-Encoding": "gzip, deflate" },
  });
  if (!res.ok) throw new Error(`SEC ${res.status} sur ${url}`);
  await sleep(300); // sous la limite ~10 req/s
  return res;
}

// ---- Flux "derniers depots" pour un type de formulaire, toutes societes ----
async function fetchLatestFilings(form) {
  const url =
    `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent` +
    `&type=${encodeURIComponent(form)}&company=&dateb=&owner=include&count=100&output=atom`;
  const xml = await (await secFetch(url)).text();
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  const out = [];
  for (const e of entries) {
    const href = (e.match(/<link[^>]*href="([^"]*)"/) || [])[1] || "";
    const title = (e.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
    const updated = (e.match(/<updated>([^<]*)<\/updated>/) || [])[1] || "";
    // href: .../data/{cik}/{accnodash}/{acc}-index.htm
    const m = href.match(/\/data\/(\d+)\/([0-9]+)\//);
    if (!m) continue;
    const cik = String(Number(m[1]));
    const accFolder = m[2]; // identifiant unique du depot
    const company = (title.match(/\s-\s(.*?)\s*\(\d+\)/) || [])[1] || title;
    out.push({ form, cik, accFolder, company, indexUrl: href, updated });
  }
  return out;
}

// ---- Trouve le document principal d'un depot via son index.json ----
async function getPrimaryDoc(indexUrl) {
  const folder = indexUrl.replace(/\/[^/]+$/, "");
  const data = await (await secFetch(`${folder}/index.json`)).json();
  const items = data.directory?.item || [];
  // priorite : type == form, sinon premier .htm qui n'est pas un index/xbrl
  const pick =
    items.find((i) => /htm$/i.test(i.name) && i.type && /^(8-K|10-Q|10-K)/.test(i.type)) ||
    items.find((i) => /\.htm$/i.test(i.name) && !/index/i.test(i.name) && !/^R\d/.test(i.name));
  if (!pick) throw new Error("doc principal introuvable");
  return `${folder}/${pick.name}`;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function analyzeSentiment(company, form, text) {
  const excerpt = text.slice(0, 12000);
  const prompt = `Tu analyses un depot SEC de type ${form} de la societe ${company}.
Reponds UNIQUEMENT en JSON, sans texte autour, sans backticks :
{"sentiment":"positif|negatif|neutre","score":0-100,"resume":"une phrase courte en francais","activite":"","chiffres":{"revenu":"","benefice":"","bpa":"","croissance":"","dividende":""}}
Le score = a quel point le ton est positif (100) ou negatif (0).
Pour "activite" : en une phrase courte en francais, ce que fait l'entreprise, UNIQUEMENT si le texte du depot le decrit. Si le texte ne dit pas ce que fait l'entreprise, laisse "". N'invente pas d'apres tes connaissances.
Pour "chiffres" : extrais UNIQUEMENT des montants reellement ecrits dans le texte du depot, avec leur unite monetaire ($, Mds$...) et la variation % si donnee (ex. "143,8 Mds$ (+16%)"). Ne mets JAMAIS le score ni un nombre qui n'est pas un montant cite tel quel. Si un chiffre n'apparait pas explicitement dans le texte, laisse "". N'invente jamais, ne deduis jamais.

Extrait :
"""${excerpt}"""`;

  const res = await fetch(LLM_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 500,
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const raw = (data.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.chiffres) parsed.chiffres = {};
    if (!parsed.activite) parsed.activite = "";
    return parsed;
  } catch {
    return { sentiment: "inconnu", score: 50, resume: raw.slice(0, 200), activite: "", chiffres: {} };
  }
}

// Garde-fou : on ne garde un chiffre que si son montant apparait VRAIMENT dans
// le texte du depot. Sinon (l'IA l'a invente ou mal case), on l'efface.
function verifierChiffres(chiffres, text) {
  if (!chiffres) return {};
  // Normalise le texte : virgules -> points, espaces retires autour des nombres.
  const normText = text.replace(/,/g, ".").replace(/\s+/g, " ");
  const clean = {};
  for (const [k, v] of Object.entries(chiffres)) {
    if (!v || !String(v).trim()) continue;
    // Extrait le 1er nombre du chiffre annonce (ex. "0,1449$ (+2%)" -> "0.1449").
    const m = String(v).replace(/,/g, ".").match(/\d+(?:\.\d+)?/);
    if (!m) continue;
    const num = m[0];
    // On accepte si ce nombre (ou sa version sans .00) est present dans le texte.
    const variantes = [num, num.replace(/\.0+$/, "")];
    if (variantes.some((n) => n.length >= 2 && normText.includes(n))) {
      clean[k] = v;
    }
  }
  return clean;
}

// ---- Email digest via Brevo ----
async function sendEmail(results) {
  if (!BREVO_API_KEY || !EMAIL_TO || !EMAIL_FROM) return;
  // EMAIL_TO peut contenir plusieurs adresses separees par des virgules.
  const recipients = EMAIL_TO.split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((email) => ({ email }));
  const rows = results
    .map(
      (r) =>
        `<tr><td>${EMOJI[r.sentiment] || "?"} ${r.company}</td><td>${r.form}</td>` +
        `<td><b>${r.sentiment}</b> (${r.score})</td><td>${r.resume}${r.activite ? `<br><i>${r.activite}</i>` : ""}</td>` +
        `<td>${fmtChiffres(r.chiffres)}${r.marche ? `<br><b>Marche :</b><br>${fmtMarche(r.marche)}` : ""}</td>` +
        `<td><a href="${r.url}">voir</a></td></tr>`
    )
    .join("");
  const html =
    `<h2>SEC Watcher — ${results.length} nouveau(x) depot(s)</h2>` +
    `<p style="color:#888;font-size:12px">Chiffres extraits du depot, a verifier. Outil de reperage, pas un conseil financier.</p>` +
    `<table border="1" cellpadding="6" cellspacing="0">` +
    `<tr><th>Societe</th><th>Type</th><th>Sentiment</th><th>Resume</th><th>Chiffres cles</th><th></th></tr>` +
    `${rows}</table>`;

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: "SEC Watcher", email: EMAIL_FROM },
      to: recipients,
      subject: `SEC Watcher — ${results.length} alerte(s)`,
      htmlContent: html,
    }),
  });
  if (!res.ok) console.error("Brevo a echoue:", (await res.text()).slice(0, 200));
}

const EMOJI = { positif: "🟢", negatif: "🔴", neutre: "⚪", inconnu: "❔" };

// Met en forme les chiffres cles extraits (ignore les champs vides).
function fmtChiffres(ch) {
  if (!ch) return "—";
  const labels = {
    revenu: "Revenu",
    benefice: "Benefice",
    bpa: "BPA",
    croissance: "Croissance",
    dividende: "Dividende",
  };
  const parts = Object.entries(labels)
    .filter(([k]) => ch[k] && String(ch[k]).trim())
    .map(([k, label]) => `${label} : ${ch[k]}`);
  return parts.length ? parts.join("<br>") : "—";
}

// ---- Donnees de marche (Finnhub, facultatif) ----
// Recupere la table officielle SEC : CIK -> ticker (1 appel par passage).
async function loadTickerMap() {
  if (!FINNHUB_API_KEY) return new Map();
  try {
    const data = await (await secFetch("https://www.sec.gov/files/company_tickers.json")).json();
    const map = new Map();
    for (const k of Object.keys(data)) {
      map.set(String(data[k].cik_str), data[k].ticker);
    }
    return map;
  } catch (e) {
    console.error("Table tickers:", e.message);
    return new Map();
  }
}

// Formate une capitalisation donnee en millions de dollars.
function fmtCap(millions) {
  const n = Number(millions);
  if (!n || isNaN(n)) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} T$`; // milliers de milliards
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} Mds$`;
  return `${n.toFixed(0)} M$`;
}

// Interroge Finnhub : cours actuel (+ variation) et capitalisation.
async function getMarketData(ticker) {
  const base = "https://finnhub.io/api/v1";
  const q = await (await fetch(`${base}/quote?symbol=${ticker}&token=${FINNHUB_API_KEY}`)).json();
  const p = await (await fetch(`${base}/stock/profile2?symbol=${ticker}&token=${FINNHUB_API_KEY}`)).json();
  const cur = p.currency || "USD";
  const cours = q.c
    ? `${q.c.toFixed(2)} ${cur}` + (q.dp != null ? ` (${q.dp > 0 ? "+" : ""}${q.dp.toFixed(1)}%)` : "")
    : "";
  return { ticker, cours, capitalisation: fmtCap(p.marketCapitalization), secteur: p.finnhubIndustry || "" };
}

// Met en forme le bloc marche (ignore les champs vides).
function fmtMarche(m) {
  if (!m) return "";
  const parts = [];
  if (m.secteur) parts.push(`Secteur : ${m.secteur}`);
  if (m.cours) parts.push(`Cours : ${m.cours}`);
  if (m.capitalisation) parts.push(`Capitalisation : ${m.capitalisation}`);
  if (m.ticker) parts.push(`Ticker : ${m.ticker}`);
  return parts.join("<br>");
}

// ---- Generation du site statique (docs/index.html pour GitHub Pages) ----
async function buildSite(history) {
  const cards = history
    .map(
      (r) => `<article class="${r.sentiment}">
      <header><span class="dot"></span><b>${r.company}</b> <span class="form">${r.form}</span></header>
      <p class="score">${r.sentiment.toUpperCase()} — ${r.score}/100</p>
      <p>${r.resume}</p>
      ${r.activite ? `<p class="activite">${r.activite}</p>` : ""}
      ${fmtChiffres(r.chiffres) !== "—" ? `<p class="chiffres">${fmtChiffres(r.chiffres)}</p>` : ""}
      ${r.marche ? `<p class="marche">${fmtMarche(r.marche)}</p>` : ""}
      <footer><time>${r.date}</time> · <a href="${r.url}" target="_blank">Voir le depot SEC</a></footer>
    </article>`
    )
    .join("");
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SEC Watcher</title><style>
:root{font-family:system-ui,sans-serif}
body{max-width:820px;margin:0 auto;padding:24px;background:#0f1115;color:#e6e6e6}
h1{font-size:1.4rem}
.meta{color:#8a8f98;font-size:.85rem;margin-bottom:20px}
article{background:#1a1d24;border-radius:12px;padding:14px 16px;margin:12px 0;border-left:4px solid #555}
article.positif{border-color:#2ecc71}article.negatif{border-color:#e74c3c}article.neutre{border-color:#95a5a6}
header{display:flex;align-items:center;gap:8px}
.form{background:#2a2e38;padding:2px 8px;border-radius:6px;font-size:.75rem;color:#9aa0aa}
.score{font-weight:600;margin:6px 0;font-size:.9rem}
.chiffres{background:#13161c;border-radius:8px;padding:8px 10px;font-size:.82rem;color:#b8c2cc;line-height:1.5;margin:8px 0}
.activite{font-style:italic;color:#c9cdd4;font-size:.88rem;margin:4px 0}
.marche{background:#10231a;border-radius:8px;padding:8px 10px;font-size:.82rem;color:#9fe3bf;line-height:1.5;margin:8px 0}
footer{color:#8a8f98;font-size:.8rem;margin-top:8px}
a{color:#6ab0f3}
</style></head><body>
<h1>📈 SEC Watcher</h1>
<p class="meta">Derniere mise a jour : ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC ·
Outil de reperage, pas un conseil financier.</p>
${cards || "<p>Aucune alerte pour l'instant.</p>"}
</body></html>`;
  await fs.writeFile("docs/index.html", html);
}

// ---- Programme principal ----
async function main() {
  const filter = await loadFilter();
  const tickerMap = await loadTickerMap();
  let state = { seen: [] };
  try {
    state = JSON.parse(await fs.readFile("state.json", "utf8"));
    if (!Array.isArray(state.seen)) state.seen = [];
  } catch {
    state = { seen: [] };
  }
  let history = [];
  try {
    history = JSON.parse(await fs.readFile("results.json", "utf8"));
  } catch {
    history = [];
  }

  const seenSet = new Set(state.seen);
  const firstRun = state.seen.length === 0;

  // 1) Recupere les derniers depots de tous les types surveilles.
  let candidates = [];
  for (const form of FORMS_WATCHED) {
    try {
      candidates.push(...(await fetchLatestFilings(form)));
    } catch (e) {
      console.error(`Flux ${form}:`, e.message);
    }
  }

  // 2) Filtre : non vus + (pas de watchlist OU CIK dans la watchlist).
  const fresh = candidates.filter(
    (c) => !seenSet.has(c.accFolder) && (filter.size === 0 || filter.has(c.cik))
  );

  // Premier passage : on marque tout comme vu sans rien envoyer.
  if (firstRun) {
    candidates.forEach((c) => seenSet.add(c.accFolder));
    state.seen = [...seenSet].slice(-1000);
    await fs.writeFile("state.json", JSON.stringify(state, null, 2));
    await buildSite(history);
    console.log("Initialisation : etat enregistre, aucune alerte envoyee.");
    return;
  }

  // 3) Budget : on analyse au plus MAX_ANALYZE (les plus recents).
  const toAnalyze = fresh.slice(0, MAX_ANALYZE);
  const results = [];
  for (const c of toAnalyze) {
    try {
      const docUrl = await getPrimaryDoc(c.indexUrl);
      const text = htmlToText(await (await secFetch(docUrl)).text());
      const a = await analyzeSentiment(c.company, c.form, text);
      const chiffres = verifierChiffres(a.chiffres, text);
      results.push({
        company: c.company,
        cik: c.cik,
        form: c.form,
        sentiment: a.sentiment,
        score: a.score,
        resume: a.resume,
        activite: a.activite || "",
        chiffres,
        url: docUrl,
        date: (c.updated || "").slice(0, 16).replace("T", " "),
      });
      console.log(`${c.company} ${c.form} -> ${a.sentiment}`);
    } catch (e) {
      console.error(`Erreur ${c.company}:`, e.message);
    }
  }

  // 4) On marque TOUT le frais comme vu (y compris le non-analyse = echantillon).
  candidates.forEach((c) => seenSet.add(c.accFolder));
  state.seen = [...seenSet].slice(-1000);
  await fs.writeFile("state.json", JSON.stringify(state, null, 2));

  // 5) Selection des depots a notifier (assez marquants dans le bon sens).
  // - positif : score >= NOTIFY_MIN_SCORE (ex. >= 75)
  // - negatif : score <= NOTIFY_MAX_SCORE (ex. <= 25)
  // - neutre/inconnu : seulement si explicitement demande dans NOTIFY_SENTIMENT.
  const toEmail = results.filter((r) => {
    const label = (r.sentiment || "").toLowerCase();
    if (NOTIFY_SENTIMENT.size && !NOTIFY_SENTIMENT.has(label)) return false;
    const score = Number(r.score);
    if (label === "positif") return score >= NOTIFY_MIN_SCORE;
    if (label === "negatif") return score <= NOTIFY_MAX_SCORE;
    return true;
  });

  // 6) Donnees de marche : UNIQUEMENT sur les depots notables (max 10/passage)
  //    pour rester sous la limite gratuite de Finnhub (~300 appels/jour).
  if (FINNHUB_API_KEY && toEmail.length) {
    for (const r of toEmail.slice(0, 10)) {
      const ticker = tickerMap.get(String(r.cik));
      if (!ticker) continue;
      try {
        r.marche = await getMarketData(ticker);
      } catch (e) {
        console.error(`Marche ${r.company}:`, e.message);
      }
    }
  }

  // 7) Historique + site + email (refletent maintenant les donnees de marche).
  history = [...results, ...history].slice(0, HISTORY_SIZE);
  await fs.writeFile("results.json", JSON.stringify(history, null, 2));
  await buildSite(history);
  if (toEmail.length) await sendEmail(toEmail);

  console.log(
    `Termine. ${results.length} analyse(s), ${toEmail.length} email(s), ${fresh.length} nouveaux au total.`
  );
}

main();