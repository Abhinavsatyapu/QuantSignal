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
