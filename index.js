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
} = process.env;

// Types surveilles. 8-K = evenements importants (meilleur signal +/-).
const FORMS_WATCHED = ["8-K"];
// Combien de depots on analyse au max par passage (budget LLM).
const MAX_ANALYZE = Number(process.env.MAX_ANALYZE || 20);
// Quels sentiments declenchent un email. Defaut : positif uniquement.
// Mets "positif,negatif" pour les deux, ou "" (vide) pour tout recevoir.
const NOTIFY_SENTIMENT = new Set(
  (process.env.NOTIFY_SENTIMENT ?? "positif")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
// Score minimum pour declencher un email (0 = pas de seuil). Defaut : 75.
const NOTIFY_MIN_SCORE = Number(process.env.NOTIFY_MIN_SCORE ?? 75);
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
{"sentiment":"positif|negatif|neutre","score":0-100,"resume":"une phrase courte en francais"}
Le score = a quel point le ton est positif (100) ou negatif (0).

Extrait :
"""${excerpt}"""`;

  const res = await fetch(LLM_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 300,
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const raw = (data.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    return { sentiment: "inconnu", score: 50, resume: raw.slice(0, 200) };
  }
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
        `<td><b>${r.sentiment}</b> (${r.score})</td><td>${r.resume}</td>` +
        `<td><a href="${r.url}">voir</a></td></tr>`
    )
    .join("");
  const html =
    `<h2>SEC Watcher — ${results.length} nouveau(x) depot(s)</h2>` +
    `<table border="1" cellpadding="6" cellspacing="0">` +
    `<tr><th>Societe</th><th>Type</th><th>Sentiment</th><th>Resume</th><th></th></tr>` +
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

// ---- Generation du site statique (docs/index.html pour GitHub Pages) ----
async function buildSite(history) {
  const cards = history
    .map(
      (r) => `<article class="${r.sentiment}">
      <header><span class="dot"></span><b>${r.company}</b> <span class="form">${r.form}</span></header>
      <p class="score">${r.sentiment.toUpperCase()} — ${r.score}/100</p>
      <p>${r.resume}</p>
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
      results.push({
        company: c.company,
        form: c.form,
        sentiment: a.sentiment,
        score: a.score,
        resume: a.resume,
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

  // 5) Historique + site + email.
  history = [...results, ...history].slice(0, HISTORY_SIZE);
  await fs.writeFile("results.json", JSON.stringify(history, null, 2));
  await buildSite(history);

  // Email : sentiment choisi (defaut positif) ET score suffisant (defaut 75).
  const toEmail = results.filter((r) => {
    const labelOk = NOTIFY_SENTIMENT.size === 0 || NOTIFY_SENTIMENT.has(r.sentiment.toLowerCase());
    const scoreOk = Number(r.score) >= NOTIFY_MIN_SCORE;
    return labelOk && scoreOk;
  });
  if (toEmail.length) await sendEmail(toEmail);

  console.log(
    `Termine. ${results.length} analyse(s), ${toEmail.length} email(s), ${fresh.length} nouveaux au total.`
  );
}

main();