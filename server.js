// QuantSignal Terminal (ChatGPT version) behind a password.
// ./site holds the ChatGPT site's own files, unchanged. Every /api/* request is passed through, unchanged, to the
// ChatGPT backend (UPSTREAM), so pages behave exactly as on ChatGPT. Password: OWNER_PASSWORD (Render env var).
const http = require("http"), { Readable } = require("stream"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000, SITE = path.join(__dirname, "site");
const PASSWORD = process.env.OWNER_PASSWORD || process.env.APP_PASSWORD || "";
const UPSTREAM = new URL(process.env.UPSTREAM || "https://quant-signal-frontend.satyapuabhinav1609.chatgpt.site");
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const DAYS = 365, fails = new Map();
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2", ".pdf": "application/pdf", ".txt": "text/plain" };
const KEY = crypto.createHash("sha256").update(SECRET + "|" + PASSWORD).digest();   // new password => old logins stop working
const sign = v => v + "." + crypto.createHmac("sha256", KEY).update(v).digest("hex");
const valid = c => { if (!c) return false; const i = c.lastIndexOf("."); const v = c.slice(0, i);
  const ok = c.length === sign(v).length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(sign(v))); return ok && Number(v) > Date.now(); };
const cookie = req => Object.fromEntries((req.headers.cookie || "").split(";").map(s => s.trim().split("=")).filter(a => a[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
const eq = (a, b) => { const x = crypto.createHash("sha256").update(a).digest(), y = crypto.createHash("sha256").update(b).digest(); return crypto.timingSafeEqual(x, y); };
const sec = { "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
const login = (msg = "") => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QuantSignal Terminal · Sign in</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1118;color:#e6edf3;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
form{width:min(340px,90vw);background:#121a24;border:1px solid #233041;border-radius:12px;padding:28px;display:grid;gap:14px}
h1{margin:0;font-size:20px}p{margin:0;color:#8b98a8;font-size:13px}input{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #2c3a4d;background:#0b1118;color:inherit}
button{font:inherit;font-weight:600;padding:10px;border:0;border-radius:8px;background:#2f6fde;color:#fff;cursor:pointer}.e{color:#f0857a}</style></head>
<body><form method="post" action="/login"><h1>QuantSignal Terminal</h1><p>Private dashboard. Enter the password to continue.</p>
<label for="pw" class="sr">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
${msg ? `<p class="e">${msg}</p>` : ""}<button type="submit">Sign in</button></form></body></html>`;

async function proxy(req, res, url) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!["host", "cookie", "connection", "content-length", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip", "forwarded", "origin", "referer", "accept-encoding"].includes(k)) headers[k] = v;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 120000);
  res.on("close", () => { if (!res.writableEnded) ctl.abort(); });   // browser went away
  try {
    let body;
    if (!["GET", "HEAD"].includes(req.method)) {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 5e6) throw new Error("request too large"); chunks.push(c); }
      body = Buffer.concat(chunks);
    }
    const r = await fetch(new URL(url.pathname + url.search, UPSTREAM), { method: req.method, headers, signal: ctl.signal, body });
    const h = {}; r.headers.forEach((v, k) => { if (!["set-cookie", "content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) h[k] = v; });
    res.writeHead(r.status, { ...h, "Cache-Control": "no-store" });
    if (r.body) Readable.fromWeb(r.body).on("error", () => res.end()).pipe(res); else res.end();   // NDJSON streams pass straight through
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Data service unreachable: " + (e.name === "AbortError" ? "timed out" : e.message) }));
  } finally { clearTimeout(timer); }
}

// ---------------- Alpha Vantage (live US stock quotes) ----------------
// Key stays on the server (ALPHAVANTAGE_API_KEY). One cached snapshot is shared by every open page, so a refresh
// costs at most ceil(symbols/100) bulk calls per AV_TTL seconds regardless of how many tabs are open.
const AV_KEY = process.env.ALPHAVANTAGE_API_KEY || "";
const AV_BASE = process.env.AV_BASE || "https://www.alphavantage.co/query";
const AV_TTL = Math.max(15, Number(process.env.AV_TTL || 30)) * 1000;
let avEntitlement = process.env.AV_ENTITLEMENT || "realtime";      // falls back to "delayed" if realtime isn't on the plan
const avCache = new Map();                                         // symbol -> {quote, at}
let avLastError = "", avLastAt = 0, avInflight = null;
const num = v => { const n = Number(String(v ?? "").replace("%", "")); return Number.isFinite(n) ? n : null; };
async function avCall(params) {
  const u = new URL(AV_BASE); for (const [k, v] of Object.entries({ ...params, apikey: AV_KEY })) if (v) u.searchParams.set(k, v);
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); const j = await r.json();
  const note = j.Information || j.Note || j["Error Message"] || (j.message && !j.data ? j.message : "");
  return { j, note: note ? String(note) : "" };
}
function normBulk(x) {
  const price = num(x.close ?? x.price), prev = num(x.previous_close);
  return { symbol: String(x.symbol || "").toUpperCase(), price, prevClose: prev, change: num(x.change) ?? (price != null && prev != null ? price - prev : null),
           changePct: num(x.change_percent) ?? (price != null && prev ? (price / prev - 1) * 100 : null), volume: num(x.volume),
           time: x.timestamp || null, extended: x.extended_hours_quote != null ? num(x.extended_hours_quote) : null };
}
async function avRefresh(symbols) {
  const fresh = symbols.filter(s => { const c = avCache.get(s); return !c || Date.now() - c.at > AV_TTL; });
  for (let i = 0; i < fresh.length; i += 100) {
    const batch = fresh.slice(i, i + 100);
    let { j, note } = await avCall({ function: "REALTIME_BULK_QUOTES", symbol: batch.join(","), entitlement: avEntitlement });
    if (!Array.isArray(j.data) && avEntitlement === "realtime" && /entitle|realtime|real-time/i.test(note)) {
      avEntitlement = "delayed"; ({ j, note } = await avCall({ function: "REALTIME_BULK_QUOTES", symbol: batch.join(","), entitlement: avEntitlement }));
    }
    if (!Array.isArray(j.data)) { avLastError = note || "Alpha Vantage returned no data"; throw new Error(avLastError); }
    const now = Date.now();
    for (const x of j.data) { const q = normBulk(x); if (q.symbol && q.price != null) avCache.set(q.symbol, { quote: q, at: now }); }
    for (const s of batch) if (!avCache.has(s)) avCache.set(s, { quote: { symbol: s, price: null, missing: true }, at: now });
  }
  avLastError = ""; avLastAt = Date.now();
}
async function avQuotes(req, res, url) {
  const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
  if (!AV_KEY) return send(503, { error: "Alpha Vantage key not set. Add ALPHAVANTAGE_API_KEY in Render → Environment." });
  const symbols = [...new Set(String(url.searchParams.get("symbols") || "").toUpperCase().split(",").map(s => s.trim()).filter(s => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)))].slice(0, 400);
  if (!symbols.length) return send(400, { error: "Pass ?symbols=TSLA,NVDA" });
  try {
    if (avInflight) await avInflight.catch(() => {});                // another tab is refreshing: reuse its results
    avInflight = avRefresh(symbols).finally(() => { avInflight = null; }); await avInflight;
  }
  catch (e) { if (![...symbols].some(s => avCache.has(s))) return send(502, { error: "Alpha Vantage: " + e.message }); }
  send(200, { source: "Alpha Vantage", entitlement: avEntitlement, ttlSec: AV_TTL / 1000, updatedAt: avLastAt ? new Date(avLastAt).toISOString() : null,
              warning: avLastError || null, quotes: symbols.map(s => (avCache.get(s) || { quote: { symbol: s, price: null, missing: true } }).quote) });
}

// ---------------- Market regime (Alpha Vantage) ----------------
// Slow-moving inputs are cached for hours, so the regime costs a handful of AV calls per day.
const regimeCache = { at: 0, data: null }, REGIME_TTL = 15 * 60e3;
const sma = (a, n) => a.length >= n ? a.slice(-n).reduce((x, y) => x + y, 0) / n : null;
async function avDaily(symbol) {
  const { j, note } = await avCall({ function: "TIME_SERIES_DAILY_ADJUSTED", symbol, outputsize: "full" });
  const ts = j["Time Series (Daily)"]; if (!ts) throw new Error(note || "no daily data for " + symbol);
  return Object.entries(ts).map(([d, v]) => ({ d, c: Number(v["5. adjusted close"] ?? v["4. close"]) })).filter(x => Number.isFinite(x.c)).sort((a, b) => a.d < b.d ? -1 : 1).slice(-400);
}
function trendOf(rows) {
  const c = rows.map(r => r.c), last = c.at(-1), s50 = sma(c, 50), s200 = sma(c, 200);
  const rets = c.slice(1).map((v, i) => Math.log(v / c[i]));
  const vol20 = k => { const r = rets.slice(k - 20, k); const m = r.reduce((a, b) => a + b, 0) / r.length; return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1) * 252) * 100; };
  const volNow = vol20(rets.length), hist = []; for (let k = Math.max(20, rets.length - 252); k <= rets.length; k++) hist.push(vol20(k));
  return { date: rows.at(-1).d, price: last, sma50: s50, sma200: s200, above50: last > s50, above200: last > s200, golden: s50 > s200,
           ret20: (last / c.at(-21) - 1) * 100, vol20: volNow, volPctile: Math.round(hist.filter(v => v <= volNow).length / hist.length * 100) };
}
async function buildRegime(breadth) {
  const [spy, qqq] = await Promise.all([avDaily("SPY"), avDaily("QQQ")]);
  const S = trendOf(spy), Q = trendOf(qqq);
  let rates = null, news = null;
  try { const { j } = await avCall({ function: "TREASURY_YIELD", interval: "daily", maturity: "10year" });
        const d = (j.data || []).filter(x => x.value !== ".").slice(0, 25); if (d.length > 20) rates = { date: d[0].date, y10: Number(d[0].value), chg20bp: Math.round((Number(d[0].value) - Number(d[20].value)) * 100) }; } catch {}
  try { const { j } = await avCall({ function: "NEWS_SENTIMENT", topics: "financial_markets", sort: "LATEST", limit: "50" });
        const f = (j.feed || []).map(x => Number(x.overall_sentiment_score)).filter(Number.isFinite); if (f.length) news = { score: f.reduce((a, b) => a + b, 0) / f.length, articles: f.length }; } catch {}
  const trend = [S.above200, S.above50, S.golden, Q.above200, Q.above50].filter(Boolean).length;          // 0..5
  const vol = S.volPctile >= 80 ? "stressed" : S.volPctile >= 50 ? "elevated" : "calm";
  let label = "Neutral";
  if (trend >= 4 && vol !== "stressed" && !(breadth && breadth.upPct < 35)) label = "Risk-on";
  if (trend <= 1 || (vol === "stressed" && trend <= 3) || (breadth && breadth.upPct < 25 && trend <= 2)) label = "Risk-off";
  const why = [`Trend ${trend}/5 (S&P ${S.above200 ? "above" : "below"} 200-day, Nasdaq-100 ${Q.above200 ? "above" : "below"} 200-day)`,
               `Volatility ${vol} (SPY 20-day ${S.vol20.toFixed(1)}%, ${S.volPctile}th percentile of the past year)`];
  if (breadth) why.push(`Breadth ${breadth.upPct.toFixed(0)}% of ${breadth.n} stock perps up today`);
  if (rates) why.push(`10-year yield ${rates.y10.toFixed(2)}% (${rates.chg20bp >= 0 ? "+" : ""}${rates.chg20bp} bp in 20 days)`);
  if (news) why.push(`News mood ${news.score >= 0.15 ? "bullish" : news.score <= -0.15 ? "bearish" : "neutral"} (${news.score.toFixed(2)} across ${news.articles} articles)`);
  return { label, trend, vol, spy: S, qqq: Q, rates, news, breadth, why, updatedAt: new Date().toISOString() };
}
async function avRegime(req, res, url) {
  const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
  if (!AV_KEY) return send(503, { error: "Alpha Vantage key not set. Add ALPHAVANTAGE_API_KEY in Render → Environment." });
  const up = num(url.searchParams.get("up")), n = num(url.searchParams.get("n"));
  const breadth = up != null && n ? { upPct: up / n * 100, n } : null;
  try {
    if (!regimeCache.data || Date.now() - regimeCache.at > REGIME_TTL) { regimeCache.data = await buildRegime(null); regimeCache.at = Date.now(); }
    const d = regimeCache.data;                 // breadth is live (from the page); recompute label with it
    const out = breadth ? await (async () => { const r = { ...d, breadth }; let label = "Neutral";
      if (d.trend >= 4 && d.vol !== "stressed" && breadth.upPct >= 35) label = "Risk-on";
      if (d.trend <= 1 || (d.vol === "stressed" && d.trend <= 3) || (breadth.upPct < 25 && d.trend <= 2)) label = "Risk-off";
      r.label = label; r.why = [...d.why.filter(w => !w.startsWith("Breadth")), `Breadth ${breadth.upPct.toFixed(0)}% of ${n} stock perps up today`]; return r; })() : d;
    send(200, out);
  } catch (e) { send(502, { error: "Alpha Vantage: " + e.message }); }
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x"), ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0];
  if (url.pathname === "/health") { res.writeHead(200); return res.end("ok"); }
  if (url.pathname === "/logout") { res.writeHead(302, { ...sec, "Set-Cookie": "qs=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax", Location: "/" }); return res.end(); }
  if (url.pathname === "/login" && req.method === "POST") {
    let body = ""; req.on("data", c => { body += c; if (body.length > 4096) req.destroy(); });
    return req.on("end", () => {
      const f = fails.get(ip) || { n: 0, t: 0 };
      if (f.n >= 5 && Date.now() - f.t < 15 * 60e3) { res.writeHead(429, { ...sec, "Content-Type": "text/html" }); return res.end(login("Too many attempts. Try again in 15 minutes.")); }
      const pw = new URLSearchParams(body).get("password") || "";
      if (!PASSWORD) { res.writeHead(500, { ...sec, "Content-Type": "text/html" }); return res.end(login("APP_PASSWORD is not set on the server.")); }
      if (!eq(pw, PASSWORD)) { fails.set(ip, { n: f.n + 1, t: Date.now() }); res.writeHead(401, { ...sec, "Content-Type": "text/html" }); return res.end(login("Wrong password.")); }
      fails.delete(ip);
      res.writeHead(302, { ...sec, "Set-Cookie": `qs=${encodeURIComponent(sign(String(Date.now() + DAYS * 864e5)))}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`, Location: "/" });
      res.end();
    });
  }
  if (!valid(cookie(req).qs)) {
    if (url.pathname.startsWith("/api/")) { res.writeHead(401, { ...sec, "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Sign in required" })); } res.writeHead(200, { ...sec, "Content-Type": "text/html; charset=utf-8" }); return res.end(login()); }
  if (url.pathname === "/api/av/quotes") return avQuotes(req, res, url);
  if (url.pathname === "/api/av/regime") return avRegime(req, res, url);
  if (url.pathname.startsWith("/api/")) return proxy(req, res, url);
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[\/\\])+/, "");
  let file = path.join(SITE, p);
  if (!file.startsWith(SITE)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file) && fs.existsSync(file + ".html")) file += ".html";
  if (!fs.existsSync(file)) file = path.join(SITE, "index.html");           // single-page-app routes like /paper
  res.writeHead(200, { ...sec, "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log("QuantSignal (ChatGPT version) on :" + PORT));
