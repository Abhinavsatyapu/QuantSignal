// ============================================================
//  GRID BOT BACKEND  —  server.js
//  Features: Symbol Dropdown, Auto Limits, Telegram Alerts
// ============================================================

require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const http      = require("http");
const WebSocket = require("ws");
const ccxt      = require("ccxt");
const https     = require("https");
const crypto    = require("crypto");

// ── Safety wrapper added for the QuantSignal portal ─────────────────────────
// TESTNET by default. Real-money trading needs BOTH BINANCE_TESTNET=no AND GRID_LIVE_APPROVED=yes (owner only).
const LIVE_REQUESTED = String(process.env.BINANCE_TESTNET || "").toLowerCase() === "no";
const LIVE = LIVE_REQUESTED && String(process.env.GRID_LIVE_APPROVED || "").toLowerCase() === "yes";
const MODE = LIVE ? "LIVE" : "TESTNET";
const H = LIVE ? { spot: H.spot, fapi: H.fapi, dapi: H.dapi }
               : { spot: "testnet.binance.vision", fapi: "testnet.binancefuture.com", dapi: "testnet.binancefuture.com" };
// Login: same password as the portal (OWNER_PASSWORD), HMAC-signed cookie, lockout after 5 wrong tries.
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const COOKIE = "gb";
const sign = v => crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("base64url");
const cookieOk = header => { const m = new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]+)").exec(header || ""); if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split("."); if (!exp || !sig || +exp < Date.now()) return false;
  const want = sign(exp); return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)); };
const fails = new Map();
// The QuantSignal portal proxies this bot under /grids (same sign-in as the portal) using a shared key.
const PORTAL_KEY = process.env.GRIDS_PORTAL_KEY || "";
const portalOk = req => { const k = String(req.headers["x-portal-key"] || ""); return PORTAL_KEY.length >= 24 && k.length === PORTAL_KEY.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(PORTAL_KEY)); };

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, verifyClient: (info) => cookieOk(info.req.headers.cookie) });

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: false, limit: "8kb" }));
app.use((req, res, next) => { res.set({ "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" }); next(); });
app.get("/health", (req, res) => res.send("ok"));
const loginPage = msg => `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Grids — sign in</title>
<body style="font:15px system-ui;background:#0f1218;color:#eef1f6;display:grid;place-items:center;min-height:100vh;margin:0">
<form method=post action="/login" style="background:#191d26;border:1px solid #272d3a;border-radius:14px;padding:26px;width:300px">
<h2 style="margin:0 0 6px">Grids — Market making bot</h2><p style="color:#a6aebd;margin:0 0 16px">${MODE === "LIVE" ? "LIVE account" : "Binance TESTNET (no real money)"}</p>
<input type=password name=password autofocus placeholder="Password" style="width:100%;padding:10px;border-radius:8px;border:1px solid #343c4d;background:#0f1218;color:#fff">
${msg ? `<p style="color:#ff8b93">${msg}</p>` : ""}<button style="margin-top:14px;width:100%;padding:10px;border:0;border-radius:8px;background:#5b8cff;color:#fff;font-weight:600">Sign in</button></form>`;
app.post("/login", (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress, f = fails.get(ip) || { n: 0, until: 0 };
  if (f.until > Date.now()) return res.status(429).send(loginPage("Too many tries — wait 15 minutes."));
  const pw = String(req.body.password || "");
  if (!OWNER_PASSWORD || pw.length !== OWNER_PASSWORD.length || !crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(OWNER_PASSWORD))) {
    f.n++; if (f.n >= 5) { f.until = Date.now() + 15 * 60e3; f.n = 0; } fails.set(ip, f); return res.status(401).send(loginPage(OWNER_PASSWORD ? "Wrong password." : "OWNER_PASSWORD is not set on the server."));
  }
  fails.delete(ip); const exp = String(Date.now() + 365 * 864e5);
  res.set("Set-Cookie", `${COOKIE}=${encodeURIComponent(exp + "." + sign(exp))}; Path=/; Max-Age=${365 * 86400}; HttpOnly; Secure; SameSite=Lax`).redirect(303, "/");
});
app.get("/logout", (req, res) => res.set("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`).redirect(303, "/"));
app.use((req, res, next) => {
  if (cookieOk(req.headers.cookie) || portalOk(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Sign in required" });
  res.status(200).send(loginPage(""));
});
// mutating calls must come from the page itself (blocks cross-site form posts)
app.use((req, res, next) => { if (req.method === "POST" && req.headers["x-gb"] !== "1") return res.status(403).json({ error: "Missing X-GB header" }); next(); });
const BANNER = (embedded) => `<div style="position:sticky;top:0;z-index:9999;padding:8px 14px;font:600 13px system-ui;${MODE === "LIVE" ? "background:#e2454f;color:#fff" : "background:#2f6fe0;color:#fff"}">
${MODE === "LIVE" ? "⚠ LIVE — REAL MONEY on Binance" : "TESTNET — Binance test exchange, no real money" + (LIVE_REQUESTED ? " (BINANCE_TESTNET=no is set, but GRID_LIVE_APPROVED is not)" : "")}
${embedded ? "" : ' · <a href="/logout" style="color:#fff">Sign out</a>'}</div>`;
const INDEX = require("fs").readFileSync(require("path").join(__dirname, "index.html"), "utf8");
app.get(["/", "/index.html"], (req, res) => res.type("html").send(INDEX.replace("<body>", "<body>" + BANNER(portalOk(req)))));

// ── Global bot state ────────────────────────────────────────
let botState = {
  running             : false,
  config              : null,
  exchange            : null,
  openOrders          : [],
  entryPrice          : null,
  lastPrice           : null,
  upperLimit          : null,
  lowerLimit          : null,
  fillHistory         : [],   // every individual fill
  pendingRoundTrips   : [],   // leg 1 filled, waiting for leg 2 (target) to fill
  completedRoundTrips : [],   // both legs filled = 1 complete round trip with PnL
  logs                : [],
  loopTimer           : null,

  // ── Hedge state ─────────────────────────────────────────────────
  hedge : {
    enabled          : false,   // true when futures API key is configured
    futuresExchange  : null,    // separate ccxt binancecoinm instance
    currentShortQty  : 0,       // current futures short size in SOL (positive = short)
    targetShortQty   : 0,       // 80% of spot inventory
    spotInventory    : 0,       // SOL held in spot wallet
    lastCheckTs      : 0,       // last time hedge was checked
    lastRebalanceTs  : 0,       // last time hedge was rebalanced
    symbol           : "SOL/USD:SOL",    // COIN-M perpetual symbol
    log              : [],      // hedge-specific log
  },
};

// ============================================================
//  TELEGRAM BOT ENGINE
//  FIXES vs previous version:
//  1. fetchAllSpotPrices() failure (Railway 451 block) no longer
//     causes "no balances" — falls back to botState.lastPrice
//     for the base asset and px map is pre-seeded with it
//  2. Binance API error responses {code, msg} are now shown
//     explicitly instead of silently showing "no balances"
//  3. COIN-M / USDM fetch errors are printed, not swallowed
//  4. Distance shown in /status and as 5th restart param
// ============================================================

const tgConv   = {};
let   tgOffset = 0;

function tgPost(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      host:"api.telegram.org", path:`/bot${token}/${method}`, method:"POST",
      headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(payload),"User-Agent":"node"},
    }, (res) => {
      let d=""; res.on("data",c=>d+=c);
      res.on("end",()=>{try{resolve(JSON.parse(d))}catch(e){resolve(null)}});
    });
    req.on("error",()=>resolve(null));
    req.write(payload); req.end();
  });
}

async function sendTelegram(token, chatId, message) {
  if (!token)  { console.log("[TELEGRAM] SKIPPED — TELEGRAM_BOT_TOKEN not set in .env"); return; }
  if (!chatId) { console.log("[TELEGRAM] SKIPPED — TELEGRAM_CHAT_ID not set in .env"); return; }
  console.log(`[TELEGRAM] Sending: ${String(message).substring(0,80)}`);
  const r = await tgPost("sendMessage", {chat_id:chatId, text:message, parse_mode:"HTML"});
  if (r?.ok) console.log("[TELEGRAM] delivered");
  else       console.error("[TELEGRAM] error:", r?.description||"unknown");
}

function tgSend(chatId, text, keyboard) {
  const body = {chat_id:chatId, text, parse_mode:"HTML", disable_web_page_preview:true};
  if (keyboard) body.reply_markup = {inline_keyboard:keyboard};
  return tgPost("sendMessage", body);
}

function tgEdit(chatId, msgId, text, keyboard) {
  const body = {chat_id:chatId, message_id:msgId, text, parse_mode:"HTML", disable_web_page_preview:true};
  body.reply_markup = {inline_keyboard: keyboard||[]};
  return tgPost("editMessageText", body);
}

function tgAck(queryId, toast) {
  return tgPost("answerCallbackQuery", {callback_query_id:queryId, text:toast||""});
}

function mainMenu() {
  return [
    [{text:"📊 Status",      callback_data:"cb_status"   },{text:"💼 Portfolio",  callback_data:"cb_portfolio"}],
    [{text:"🔄 Restart Bot", callback_data:"cb_restart"  },{text:"⏹ Stop Bot",   callback_data:"cb_stop"     }],
    [{text:"📈 PnL Report",  callback_data:"cb_report"   },{text:"❓ Help",       callback_data:"cb_help"     }],
  ];
}

function tgStatusText() {
  const s=botState, cfg=s.config;
  if (!s.running) return "<b>Grid Bot — 🔴 STOPPED</b>\n\nBot is not running.\nTap 🔄 Restart to bring it back.";
  const st=s.stats||{};
  return `<b>Grid Bot — 🟢 RUNNING</b>

📌 <b>Symbol :</b> <code>${cfg?.symbol||"—"}</code>
💵 <b>Price  :</b> <code>$${(s.lastPrice||0).toFixed(4)}</code>
🎯 <b>Entry  :</b> <code>$${(s.entryPrice||0).toFixed(4)}</code>
🔼 <b>Upper  :</b> <code>$${(s.upperLimit||0).toFixed(4)}</code>
🔽 <b>Lower  :</b> <code>$${(s.lowerLimit||0).toFixed(4)}</code>

📦 <b>Open Orders :</b> <code>${s.openOrders.length}</code>
✅ <b>Round Trips :</b> <code>${st.totalRoundTrips||0}</code>
💰 <b>Live PnL    :</b> <code>$${(st.totalPnl||0).toFixed(4)}</code>
📊 <b>Buys / Sells:</b> <code>${st.totalBuys||0} / ${st.totalSells||0}</code>

⚙️ <b>Sell spacing :</b> <code>$${cfg?.avgSellSpacing||"—"}</code>
⚙️ <b>Buy  spacing :</b> <code>$${cfg?.avgBuySpacing||"—"}</code>
⚙️ <b>Target spread:</b> <code>$${cfg?.targetSpread||"—"}</code>
⚙️ <b>Qty / step   :</b> <code>${cfg?.qtyPerStep||"—"}</code>
📏 <b>Distance     :</b> <code>$${cfg?.distance||"—"}</code>`;
}

function tgHelpText() {
  return `<b>🤖 Grid Bot — Commands</b>

/menu       Show control panel
/status     Live bot status &amp; params
/portfolio  Full portfolio in USDT
/report     24 h PnL report
/restart    Restart with new params
/stop       Stop the bot

<b>Restart — send 5 numbers on one line:</b>
<code>sellSpread  buySpread  targetSpread  qty  distance</code>

• <b>sellSpread</b>   sell order spacing   (e.g. 1.0)
• <b>buySpread</b>    buy  order spacing   (e.g. 1.0)
• <b>targetSpread</b> profit per RT        (e.g. 0.5)
• <b>qty</b>          coins per order      (e.g. 0.1)
• <b>distance</b>     upper/lower range    (e.g. 10)

Example: <code>1.0  1.0  0.5  0.1  10</code>`;
}

function restartPromptText(lastCfg) {
  const hint = lastCfg
    ? `\n📌 <b>Last used:</b>\n<code>${lastCfg.avgSellSpacing}  ${lastCfg.avgBuySpacing}  ${lastCfg.targetSpread}  ${lastCfg.qtyPerStep}  ${lastCfg.distance}</code>\n`
    : "";
  return `🔄 <b>Restart Bot</b>${hint}
Send <b>5 numbers</b> separated by spaces:

<code>sellSpread  buySpread  targetSpread  qty  distance</code>

• <b>sellSpread</b>   sell order spacing   e.g. <code>1.0</code>
• <b>buySpread</b>    buy  order spacing   e.g. <code>1.0</code>
• <b>targetSpread</b> profit per RT        e.g. <code>0.5</code>
• <b>qty</b>          coins per order      e.g. <code>0.1</code>
• <b>distance</b>     upper/lower range    e.g. <code>10</code>

Example:
<code>1.0  1.0  0.5  0.1  10</code>`;
}

function tgReportText() {
  const now=Date.now(), fromTs=now-24*60*60*1000;
  const r=getRoundTripReport(fromTs, now), cfg=botState.config;
  return `<b>📈 24 h PnL Report</b>

Symbol  : <code>${cfg?.symbol||"—"}</code>
RTs     : <code>${r.count}</code>
PnL/RT  : <code>+$${(r.perRtPnl||0).toFixed(4)}</code>
Total   : <b>+$${(r.pnl||0).toFixed(4)} USDT</b>
Buys    : <code>${r.periodBuys}</code>   Sells: <code>${r.periodSells}</code>
Win rate: <code>${r.winRate}%</code>`;
}

// ── Portfolio timestamp sync ─────────────────────────────────
// -1021 means Railway's clock drifted from Binance.
// We fetch Binance server time once per portfolio call, cache the
// offset for 60 s, then add it to every Date.now() in the signed
// requests below.  This is separate from syncExchangeTime() which
// only patches the CCXT exchange object.
let _portfolioTsOffset = 0;
let _portfolioTsLastFetch = 0;

async function getPortfolioTsOffset() {
  const now = Date.now();
  if (now - _portfolioTsLastFetch < 60_000) return _portfolioTsOffset; // cached
  try {
    const serverTime = await new Promise((resolve, reject) => {
      https.get({ host:H.spot, path:"/api/v3/time", headers:{"User-Agent":"node"} }, (res) => {
        let raw=""; res.on("data",c=>raw+=c);
        res.on("end",()=>{ try{resolve(JSON.parse(raw).serverTime)}catch(e){reject(e)} });
      }).on("error", reject);
    });
    _portfolioTsOffset    = serverTime - Date.now();
    _portfolioTsLastFetch = Date.now();
    console.log(`[PORTFOLIO TS] offset=${_portfolioTsOffset}ms`);
  } catch(e) {
    console.log(`[PORTFOLIO TS] sync failed (${e.message}), using 0`);
  }
  return _portfolioTsOffset;
}

// Corrected timestamp for Binance signed requests
async function binanceTs() { return Date.now() + await getPortfolioTsOffset(); }

function fapiSignedGet(path, apiKey, secretKey, ts) {
  return new Promise((resolve, reject) => {
    const q=`timestamp=${ts}&recvWindow=60000`;
    const sig=crypto.createHmac("sha256",secretKey).update(q).digest("hex");
    https.get({host:H.fapi,path:`${path}?${q}&signature=${sig}`,headers:{"X-MBX-APIKEY":apiKey,"User-Agent":"node"}},
      (res)=>{let raw="";res.on("data",c=>raw+=c);res.on("end",()=>{try{resolve(JSON.parse(raw))}catch(e){reject(new Error(raw.slice(0,200)))}});
    }).on("error",reject);
  });
}

// ── FIX 1: fetchAllSpotPrices via dapi (works from Railway) ──
// api.binance.com/api/v3/ticker/price is geo-blocked on Railway (451).
// We try it first, but pre-seed the map with botState.lastPrice so
// the base asset always converts correctly even if the fetch fails.
async function fetchAllSpotPrices() {
  const base      = (botState.config?.symbol||"SOL/FDUSD").split("/")[0];
  const livePrice = botState.lastPrice || 0;

  // Pre-seed with the live price we already have from the running bot
  const map = {};
  if (base && livePrice) map[`${base}USDT`] = livePrice;

  // Try to fetch full ticker list — may fail on Railway (geo-block)
  try {
    const raw = await new Promise((resolve, reject) => {
      https.get({host:H.spot,path:"/api/v3/ticker/price",headers:{"User-Agent":"node"}},
        (res)=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}});
      }).on("error",reject);
    });
    if (Array.isArray(raw)) {
      raw.forEach(t=>{ map[t.symbol]=parseFloat(t.price); });
      console.log(`[PORTFOLIO] fetched ${raw.length} ticker prices`);
    }
  } catch(e) {
    // Geo-blocked on Railway — not an error, we'll use the pre-seeded base price
    console.log(`[PORTFOLIO] ticker fetch skipped (${e.message}) — using live bot price for ${base}`);
  }

  return map;
}

// ── FIX 2: coinToUsdt uses botState.lastPrice as ultimate fallback ─
function coinToUsdt(asset, qty, px) {
  if (!qty||qty===0) return 0;
  if (asset==="USDT") return qty;
  const stables=["FDUSD","BUSD","TUSD","USDC","DAI","USDP"];
  if (stables.includes(asset)) return qty*(px[`${asset}USDT`]||1);
  if (px[`${asset}USDT`])      return qty*px[`${asset}USDT`];
  if (px[`${asset}BTC`]&&px["BTCUSDT"]) return qty*px[`${asset}BTC`]*px["BTCUSDT"];
  if (px[`${asset}ETH`]&&px["ETHUSDT"]) return qty*px[`${asset}ETH`]*px["ETHUSDT"];
  // Last resort: use bot's live price if this IS the base trading asset
  const base=(botState.config?.symbol||"SOL/FDUSD").split("/")[0];
  if (asset===base && botState.lastPrice) return qty*botState.lastPrice;
  return 0;
}

// ── FIX 3: tgPortfolioText with proper error surfacing ────────
async function tgPortfolioText() {
  const apiKey    = process.env.BINANCE_API_KEY;
  const secretKey = process.env.BINANCE_SECRET_KEY;
  const futKey    = process.env.FUTURES_API_KEY    || apiKey;
  const futSecret = process.env.FUTURES_SECRET_KEY || secretKey;
  if (!apiKey||!secretKey) return "❌ API keys not configured in .env";

  // Sync clock ONCE before any signed request — fixes -1021 on Railway
  const ts = await binanceTs();

  const px        = await fetchAllSpotPrices();
  const botSymbol = botState.config?.symbol||"SOL/FDUSD";
  const base      = botSymbol.split("/")[0];

  // spotGet uses the synced ts, not raw Date.now()
  const spotGet = (path) => new Promise((res,rej)=>{
    const q=`timestamp=${ts}&recvWindow=60000`;
    const sig=crypto.createHmac("sha256",secretKey).update(q).digest("hex");
    https.get({host:H.spot,path:`${path}?${q}&signature=${sig}`,
      headers:{"X-MBX-APIKEY":apiKey,"User-Agent":"node"}},
      (r)=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{res(JSON.parse(d))}catch(e){rej(e)}});
    }).on("error",rej);
  });

  // ── 1. SPOT ────────────────────────────────────────────────
  let spotLines="", spotTotal=0;
  try {
    const spotData = await spotGet("/api/v3/account");

    // FIX: detect Binance error response before trying to iterate
    if (spotData.code && spotData.msg) {
      spotLines = `  ❌ Binance error ${spotData.code}: ${spotData.msg}\n`;
    } else {
      const nonZero=(spotData.balances||[]).filter(b=>
        parseFloat(b.free||0)+parseFloat(b.locked||0)>0.00001
      );
      for (const b of nonZero) {
        const qty   =parseFloat(b.free||0)+parseFloat(b.locked||0);
        const usdVal=coinToUsdt(b.asset,qty,px);
        if (usdVal<0.01) continue;
        spotTotal+=usdVal;
        const lk=parseFloat(b.locked||0)>0?` <i>(${parseFloat(b.locked).toFixed(4)} locked)</i>`:"";
        spotLines+=`  <code>${b.asset.padEnd(8)}</code>${qty.toFixed(4)}${lk} ≈ <b>$${usdVal.toFixed(2)}</b>\n`;
      }
      if (!spotLines) spotLines="  (no non-zero balances)\n";
    }
  } catch(e) { spotLines=`  ❌ ${e.message}\n`; }

  // ── 2. COIN-M Futures ──────────────────────────────────────
  let coinmLines="", coinmTotal=0;
  try {
    const coinmData = await dapiSignedRequest("/dapi/v1/account", futKey, futSecret, ts);

    // FIX: detect Binance error response
    if (coinmData.code && coinmData.msg) {
      coinmLines = `  ❌ Binance error ${coinmData.code}: ${coinmData.msg}\n`;
    } else if (Array.isArray(coinmData.assets)) {
      for (const a of coinmData.assets) {
        const wallet =parseFloat(a.walletBalance   ||0);
        const unrealP=parseFloat(a.unrealizedProfit||0);
        const equity =wallet+unrealP;
        if (Math.abs(equity)<0.000001) continue;
        const coinPrice=px[`${a.asset}USDT`]||botState.lastPrice||0;
        const usdVal   =coinToUsdt(a.asset,equity,px);
        coinmTotal    +=usdVal;
        const pnlNote =unrealP!==0?` (uPnL ${unrealP>=0?"+":""}${unrealP.toFixed(4)} ${a.asset})`:"";
        const calcNote=coinPrice>0?` × $${coinPrice.toFixed(2)}`:"";
        coinmLines+=`  <code>${a.asset.padEnd(6)}</code>${equity.toFixed(4)}${calcNote}${pnlNote} = <b>$${usdVal.toFixed(2)}</b>\n`;
      }
      // Show open positions
      try {
        const pos=await dapiSignedRequest("/dapi/v1/positionRisk",futKey,futSecret,ts);
        if (Array.isArray(pos)) {
          pos.filter(p=>parseFloat(p.positionAmt)!==0).forEach(p=>{
            const side=parseFloat(p.positionAmt)<0?"SHORT":"LONG";
            const uPnl=parseFloat(p.unRealizedProfit||0);
            coinmLines+=`  📍 ${p.symbol} ${side}  uPnL: ${uPnl>=0?"+":""}$${uPnl.toFixed(2)}\n`;
          });
        }
      } catch(_){}
      if (!coinmLines) coinmLines="  (no balances)\n";
    } else {
      coinmLines=`  ⚠️ Unexpected response: ${JSON.stringify(coinmData).slice(0,120)}\n`;
    }
  } catch(e) { coinmLines=`  ❌ ${e.message}\n`; }

  // ── 3. USDM Futures ────────────────────────────────────────
  let usdmLines="", usdmTotal=0;
  try {
    const usdmData = await fapiSignedGet("/fapi/v2/account", futKey, futSecret, ts);

    // FIX: detect Binance error response
    if (usdmData.code && usdmData.msg) {
      usdmLines=`  ❌ Binance error ${usdmData.code}: ${usdmData.msg}\n`;
    } else if (Array.isArray(usdmData.assets)) {
      for (const a of usdmData.assets) {
        const w=parseFloat(a.walletBalance||0),u=parseFloat(a.unrealizedProfit||0);
        const equity=w+u;
        if (Math.abs(equity)<0.01) continue;
        usdmTotal+=equity;
        const pnlNote=u!==0?` (PnL ${u>=0?"+":""}$${u.toFixed(2)})`:"";
        usdmLines+=`  <code>${a.asset.padEnd(8)}</code>$${equity.toFixed(2)}${pnlNote}\n`;
      }
      // Open positions
      try {
        const posData=await fapiSignedGet("/fapi/v2/positionRisk",futKey,futSecret,ts);
        if (Array.isArray(posData)) {
          posData.filter(p=>parseFloat(p.positionAmt)!==0).forEach(p=>{
            const side=parseFloat(p.positionAmt)<0?"SHORT":"LONG";
            const uPnl=parseFloat(p.unRealizedProfit||0);
            usdmLines+=`  📍 ${p.symbol} ${side}  uPnL: ${uPnl>=0?"+":""}$${uPnl.toFixed(2)}\n`;
          });
        }
      } catch(_){}
      if (!usdmLines) usdmLines="  (no balances)\n";
    } else if (usdmData.totalWalletBalance!==undefined) {
      const w=parseFloat(usdmData.totalWalletBalance||0),u=parseFloat(usdmData.totalUnrealizedProfit||0);
      usdmTotal=w+u;
      usdmLines=`  <code>USDT    </code>$${usdmTotal.toFixed(2)} (PnL ${u>=0?"+":""}$${u.toFixed(2)})\n`;
    } else {
      usdmLines=`  ⚠️ Unexpected response: ${JSON.stringify(usdmData).slice(0,120)}\n`;
    }
  } catch(e) { usdmLines=`  ❌ ${e.message}\n`; }

  const grandTotal=spotTotal+coinmTotal+usdmTotal;
  const livePrice =botState.lastPrice||px[`${base}USDT`]||0;

  return `<b>💼 Portfolio Report</b>
<i>${new Date().toLocaleString()}</i>

━━━━━━━━━━━━━━━━━━━━━━━━━
🏦 <b>SPOT Wallet</b>
${spotLines}  Subtotal: <b>$${spotTotal.toFixed(2)}</b>

━━━━━━━━━━━━━━━━━━━━━━━━━
📉 <b>COIN-M Futures</b>
${coinmLines}  Subtotal: <b>$${coinmTotal.toFixed(2)}</b>

━━━━━━━━━━━━━━━━━━━━━━━━━
📈 <b>USDM Futures</b>
${usdmLines}  Subtotal: <b>$${usdmTotal.toFixed(2)}</b>

━━━━━━━━━━━━━━━━━━━━━━━━━
💵 <b>TOTAL: $${grandTotal.toFixed(2)} USDT</b>
<i>${base} price: $${livePrice.toFixed(4)}</i>`;
}

async function tgDoRestart(chatId, sellSpread, buySpread, targetSpread, qty, distance) {
  const prev=botState.config;
  if (!prev) {
    await tgSend(chatId,"❌ No previous config. Start from web UI first.",mainMenu());
    return;
  }
  await tgSend(chatId,
    `⏳ Restarting...\n\nSell spacing : <code>$${sellSpread}</code>\nBuy  spacing : <code>$${buySpread}</code>\nTarget spread: <code>$${targetSpread}</code>\nQty / step   : <code>${qty}</code>\nDistance     : <code>$${distance}</code>`
  );
  if (botState.running) {
    clearInterval(botState.loopTimer); botState.running=false;
    try{await cancelAllOrders();}catch(e){}
    log("Telegram restart: stopped previous session","warn");
  }
  const cfg={...prev,avgSellSpacing:sellSpread,avgBuySpacing:buySpread,targetSpread,qtyPerStep:qty,distance,
    apiKey:process.env.BINANCE_API_KEY, secretKey:process.env.BINANCE_SECRET_KEY,
    telegramToken:process.env.TELEGRAM_BOT_TOKEN, telegramChatId:process.env.TELEGRAM_CHAT_ID};
  try {
    const exchange=buildExchange(cfg.priceSource,cfg.apiKey,cfg.secretKey);
    await exchange.loadMarkets(); await syncExchangeTime(exchange);
    const entryPrice=await getCurrentPrice(exchange,cfg.symbol);
    const upperLimit=parseFloat((entryPrice+cfg.distance).toFixed(8));
    const lowerLimit=parseFloat((entryPrice-cfg.distance).toFixed(8));
    Object.assign(botState,{config:cfg,exchange,entryPrice,lastPrice:entryPrice,
      upperLimit,lowerLimit,running:true,openOrders:[],fillHistory:[],
      pendingRoundTrips:[],completedRoundTrips:[],logs:[],loopCount:0,lastNotifiedRt:0});
    try{await exchange.cancelAllOrders(cfg.symbol);}catch(e){
      try{const p2=await exchange.fetchOpenOrders(cfg.symbol);
          for(const o of p2){try{await exchange.cancelOrder(o.id,cfg.symbol);}catch(_){}}
      }catch(_){}
    }
    await maintainGrid(entryPrice);
    botState.loopTimer=setInterval(gridLoop,5000);
    log(`Telegram restart: RUNNING | Entry $${entryPrice} | ${cfg.symbol}`,"success");
    broadcast("state",buildStateSnapshot());
    await tgSend(chatId,
      `✅ <b>Bot Restarted!</b>\n\nSymbol : <code>${cfg.symbol}</code>\nEntry  : <code>$${entryPrice.toFixed(4)}</code>\nUpper  : <code>$${upperLimit.toFixed(4)}</code>\nLower  : <code>$${lowerLimit.toFixed(4)}</code>\nRange  : <code>±$${distance}</code>`,
      mainMenu());
  } catch(err) {
    log(`Telegram restart failed: ${err.message}`,"error");
    await tgSend(chatId,`❌ Restart failed:\n<code>${err.message}</code>`,mainMenu());
  }
}

async function handleTgUpdate(update) {
  const allowedId=String(process.env.TELEGRAM_CHAT_ID||"");
  if (update.callback_query) {
    const cb=update.callback_query, fromId=String(cb.from?.id||""), msgId=cb.message?.message_id;
    if ((!allowedId||fromId!==allowedId)){await tgAck(cb.id,"Unauthorized");return;}
    await tgAck(cb.id);
    switch(cb.data){
      case "cb_status":    await tgEdit(fromId,msgId,tgStatusText(),mainMenu()); break;
      case "cb_portfolio":
        await tgEdit(fromId,msgId,"⏳ Fetching balances from all accounts...",null);
        await tgEdit(fromId,msgId,await tgPortfolioText(),mainMenu()); break;
      case "cb_report":    await tgEdit(fromId,msgId,tgReportText(),mainMenu()); break;
      case "cb_help":      await tgEdit(fromId,msgId,tgHelpText(),mainMenu()); break;
      case "cb_stop":
        if (!botState.running){await tgEdit(fromId,msgId,"ℹ️ Bot already stopped.",mainMenu());break;}
        clearInterval(botState.loopTimer);botState.running=false;
        try{await cancelAllOrders();}catch(e){}
        log("Telegram cb_stop","warn");broadcast("state",buildStateSnapshot());
        await tgEdit(fromId,msgId,`🛑 <b>Bot Stopped</b>\n\nSymbol: <code>${botState.config?.symbol||"—"}</code>\nLast Price: <code>$${botState.lastPrice||"—"}</code>\nTime: ${new Date().toLocaleString()}`,mainMenu());break;
      case "cb_restart":
        tgConv[fromId]={step:"awaiting_params"};
        await tgEdit(fromId,msgId,restartPromptText(botState.config),[[{text:"❌ Cancel",callback_data:"cb_cancel_restart"}]]);break;
      case "cb_cancel_restart":
        delete tgConv[fromId];
        await tgEdit(fromId,msgId,"❌ Restart cancelled.",mainMenu());break;
      default: await tgEdit(fromId,msgId,tgStatusText(),mainMenu());
    }
    return;
  }
  if (update.message) {
    const msg=update.message, fromId=String(msg.chat?.id||""), text=(msg.text||"").trim();
    if ((!allowedId||fromId!==allowedId)) return;
    const conv=tgConv[fromId];
    if (conv?.step==="awaiting_params"&&!text.startsWith("/")) {
      const parts=text.split(/\s+/).map(Number);
      if (parts.length!==5||parts.some(isNaN)||parts.some(v=>v<=0)){
        await tgSend(fromId,
          `❌ Need exactly <b>5 positive numbers</b>:\n<code>sellSpread  buySpread  targetSpread  qty  distance</code>\n\nExample: <code>1.0  1.0  0.5  0.1  10</code>`,
          [[{text:"❌ Cancel",callback_data:"cb_cancel_restart"}]]);
        return;
      }
      delete tgConv[fromId];
      const [ss,bs,ts,q,dist]=parts;
      await tgDoRestart(fromId,ss,bs,ts,q,dist);
      return;
    }
    const cmd=text.split(/\s+/)[0].toLowerCase();
    switch(cmd){
      case "/start":
      case "/menu":
        await tgSend(fromId,`👋 <b>Grid Bot Control Panel</b>\n\nBot is <b>${botState.running?"🟢 RUNNING":"🔴 STOPPED"}</b>\n\nChoose an action:`,mainMenu());break;
      case "/status":   await tgSend(fromId,tgStatusText(),mainMenu()); break;
      case "/portfolio":
        await tgSend(fromId,"⏳ Fetching all account balances...");
        await tgSend(fromId,await tgPortfolioText(),mainMenu()); break;
      case "/report":   await tgSend(fromId,tgReportText(),mainMenu()); break;
      case "/stop":
        if (!botState.running){await tgSend(fromId,"ℹ️ Bot is not running.",mainMenu());break;}
        clearInterval(botState.loopTimer);botState.running=false;
        try{await cancelAllOrders();}catch(e){}
        log("Telegram /stop","warn");broadcast("state",buildStateSnapshot());
        await tgSend(fromId,`🛑 <b>Bot Stopped</b>\n\nLast Price: <code>$${botState.lastPrice||"—"}</code>\nTime: ${new Date().toLocaleString()}`,mainMenu());break;
      case "/restart":
        tgConv[fromId]={step:"awaiting_params"};
        await tgSend(fromId,restartPromptText(botState.config)); break;
      case "/help":     await tgSend(fromId,tgHelpText(),mainMenu()); break;
      default:
        if (!conv) await tgSend(fromId,"Use /menu or tap the buttons below:",mainMenu());
    }
  }
}

function startTelegramPoller() {
  const token=process.env.TELEGRAM_BOT_TOKEN;
  if (!token){console.log("[TG POLLER] Skipped — TELEGRAM_BOT_TOKEN not in .env");return;}
  console.log("[TG POLLER] Started — polling every 2 s");
  tgPost("setMyCommands",{commands:[
    {command:"menu",      description:"Show control panel"},
    {command:"status",    description:"Live bot status & params"},
    {command:"portfolio", description:"Full portfolio in USDT"},
    {command:"report",    description:"24 h PnL report"},
    {command:"restart",   description:"Restart with 5 new params"},
    {command:"stop",      description:"Stop the bot"},
    {command:"help",      description:"Command reference"},
  ]}).catch(()=>{});
  const poll=()=>{
    const path=`/bot${token}/getUpdates?offset=${tgOffset}&timeout=1&allowed_updates=message,callback_query`;
    https.get({host:"api.telegram.org",path,headers:{"User-Agent":"node"}},(res)=>{
      let raw="";res.on("data",c=>raw+=c);
      res.on("end",async()=>{
        try{
          const data=JSON.parse(raw);
          if (data.ok&&Array.isArray(data.result)){
            for(const upd of data.result){
              tgOffset=upd.update_id+1;
              handleTgUpdate(upd).catch(e=>console.error("[TG POLLER] err:",e.message));
            }
          }
        }catch(_){}
      });
    }).on("error",()=>{});
  };
  setInterval(poll,2000);
}


// ── WebSocket broadcast ──────────────────────────────────────
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ── Log helper ───────────────────────────────────────────────
function log(msg, level = "info") {
  const entry = { msg, level, ts: new Date().toISOString() };
  botState.logs.unshift(entry);
  if (botState.logs.length > 200) botState.logs.pop();
  broadcast("log", entry);
  console.log(`[${level.toUpperCase()}] ${msg}`);
}
// ============================================================
//  HEDGE ENGINE
//  Strategy: Short futures = 80% of spot SOL inventory
//  Only rebalance if gap >= 1 SOL (fee protection)
// ============================================================

function logHedge(msg, level = "info") {
  const entry = { msg: `[HEDGE] ${msg}`, level, ts: new Date().toISOString() };
  botState.logs.unshift(entry);
  if (botState.logs.length > 200) botState.logs.pop();
  broadcast("log", entry);
  console.log(`[HEDGE/${level.toUpperCase()}] ${msg}`);
  botState.hedge.log.unshift(entry);
  if (botState.hedge.log.length > 50) botState.hedge.log.pop();
}

// Fetch current spot SOL balance from Binance spot wallet
async function fetchSpotSOLBalance(exchange) {
  const balance = await exchange.fetchBalance();
  // Symbol base asset — e.g. SOL/FDUSD → base is SOL
  const base = (botState.config?.symbol || "SOL/FDUSD").split("/")[0];
  const free  = parseFloat(balance?.free?.[base]  || 0);
  const used  = parseFloat(balance?.used?.[base]  || 0);
  return parseFloat((free + used).toFixed(4));  // total held (including open sell orders)
}

// ── Raw signed HTTPS request to Binance COIN-M API ─────────────────────────
// Bypasses CCXT fetch entirely — avoids the "fetch failed" network issue
// COIN-M endpoint: dapi.binance.com
function dapiSignedRequest(path, apiKey, secretKey, tsOverride) {
  return new Promise((resolve, reject) => {
    const timestamp = tsOverride || Date.now();  // use synced ts when provided
    const queryStr  = `timestamp=${timestamp}&recvWindow=60000`;
    const signature = crypto.createHmac("sha256", secretKey).update(queryStr).digest("hex");
    const fullPath  = `${path}?${queryStr}&signature=${signature}`;

    https.get({
      host   : H.dapi,
      path   : fullPath,
      headers: { "X-MBX-APIKEY": apiKey, "User-Agent": "node" },
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error("Bad JSON: " + raw.slice(0, 200))); }
      });
    }).on("error", reject);
  });
}

// Fetch current short position from COIN-M via raw HTTPS (bypasses CCXT fetch)
// Returns SOL quantity (positive = short) or null if fetch failed
async function fetchFuturesShortQty(futuresEx, symbol) {
  try {
    const cfg       = botState.config;
    const apiKey    = process.env.FUTURES_API_KEY    || cfg.apiKey;
    const secretKey = process.env.FUTURES_SECRET_KEY || cfg.secretKey;
    const base      = symbol.split("/")[0].toUpperCase();  // "SOL"

    // GET /dapi/v1/positionRisk — returns all positions
    const data = await dapiSignedRequest("/dapi/v1/positionRisk", apiKey, secretKey);

    if (!Array.isArray(data)) {
      logHedge(`Unexpected positionRisk response: ${JSON.stringify(data).slice(0,200)}`, "error");
      return null;
    }

    // Log all non-zero positions
    const nonZero = data.filter(p => parseFloat(p.positionAmt) !== 0);
    logHedge(`COIN-M positions (${nonZero.length} open): ${nonZero.map(p => `${p.symbol}=${p.positionAmt}`).join(", ") || "none"}`);

    for (const pos of nonZero) {
      if (!pos.symbol.toUpperCase().startsWith(base)) continue;

      const contracts  = parseFloat(pos.positionAmt);   // negative = short
      const markPrice  = parseFloat(pos.markPrice || botState.lastPrice || 85);
      // COIN-M contract size = 10 USD for SOL perpetual
      const contractSz = 10;
      const solQty     = parseFloat((Math.abs(contracts) * contractSz / markPrice).toFixed(4));

      logHedge(`${pos.symbol}: ${contracts} contracts × $${contractSz} / $${markPrice} = ${solQty} SOL`);

      if (contracts < 0) return solQty;   // short ✅
      if (contracts > 0) {
        logHedge(`WARNING: LONG position ${solQty} SOL on ${pos.symbol}`, "warn");
        return 0;
      }
    }

    logHedge(`No ${base} COIN-M position found — flat`);
    return 0;

  } catch (err) {
    logHedge(`fetchFuturesShortQty ERROR: ${err.message}`, "error");
    return null;  // null = fetch failed → safety block will trigger
  }
}

// Core hedge rebalance — called every 12 loops (~60 seconds)
async function checkAndRebalanceHedge() {
  const h   = botState.hedge;
  const cfg = botState.config;
  if (!h.enabled || !h.futuresExchange) return;

  try {
    h.lastCheckTs = Date.now();

    // ── 1. Fetch current spot inventory ─────────────────────────────────────
    const spotQty = await fetchSpotSOLBalance(botState.exchange);
    h.spotInventory = spotQty;

    // ── 2. Calculate target short (80% of spot) ──────────────────────────────
    const targetShort = parseFloat((spotQty * 0.8).toFixed(4));
    h.targetShortQty  = targetShort;

    // ── 3. Always fetch live futures position ────────────────────────────────
    const currentShort = await fetchFuturesShortQty(h.futuresExchange, h.symbol);

    // ⚠️  SAFETY: if fetch returned null (API error), NEVER place an order
    if (currentShort === null) {
      logHedge(`⚠️ Position fetch failed — SKIPPING rebalance to prevent duplicate hedging`, "warn");
      return;
    }

    h.currentShortQty = currentShort;

    const diff    = parseFloat((targetShort - currentShort).toFixed(4));
    const absDiff = Math.abs(diff);

    logHedge(`Spot: ${spotQty} SOL | Target short: ${targetShort} | Current short: ${currentShort} | Diff: ${diff > 0 ? "+" : ""}${diff}`);

    // ── 4. Only rebalance if diff >= threshold (user-configured, default 1 SOL) ──
    const rebalanceThreshold = parseFloat(botState.config?.hedgeThreshold || 1);
    if (absDiff < rebalanceThreshold) {
      logHedge(`Diff ${absDiff.toFixed(4)} SOL < threshold ${rebalanceThreshold} SOL — no action (fee protection)`);
      return;
    }

    // ⚠️  SAFETY: if currentShort is 0 but spotInventory > 2 SOL, something is wrong
    if (currentShort === 0 && spotQty > 2 && diff > 0) {
      logHedge(`⚠️ SAFETY BLOCK: currentShort=0 but spot=${spotQty} SOL — position fetch may be unreliable. Check logs above and manually verify on Binance before re-enabling.`, "error");
      if (cfg?.telegramToken && cfg?.telegramChatId) {
        await sendTelegram(cfg.telegramToken, cfg.telegramChatId,
          `⚠️ HEDGE SAFETY BLOCK
Bot detected spot=${spotQty} SOL but futures short=0.
This may be a position read error.
NO ORDER was placed.
Please check your COIN-M position on Binance manually.`
        );
      }
      return;
    }

    // ── 5. Rebalance ─────────────────────────────────────────────────────────
    const currentPrice = botState.lastPrice || 0;

    // COIN-M orders are placed in CONTRACTS (each = $10 USD)
    // contracts = SOL qty × currentPrice / contractSize(10)
    // e.g. 2.4 SOL @ $85 = 2.4 × 85 / 10 = 20.4 → round to 20 contracts
    const contractSize = 10;  // SOLUSD COIN-M = $10 per contract
    const contractsNeeded = Math.round(absDiff * currentPrice / contractSize);

    if (contractsNeeded < 1) {
      logHedge(`Diff ${absDiff} SOL = ${(absDiff * currentPrice / contractSize).toFixed(2)} contracts — too small, skip`, "info");
      return;
    }

    // Limit price: slight offset from current price to get filled quickly
    // Selling (increasing short) → price slightly BELOW market (more likely to fill)
    // Buying  (reducing short)   → price slightly ABOVE market (more likely to fill)
    // 0.05% offset — tight enough to fill fast, avoids market order slippage
    const LIMIT_OFFSET = 0.0005;

    // Place order via raw HTTPS — CCXT coinm fetch is unreliable
    const apiKey    = process.env.FUTURES_API_KEY    || cfg.apiKey;
    const secretKey = process.env.FUTURES_SECRET_KEY || cfg.secretKey;

    // Get exact symbol name Binance uses (e.g. SOLUSD_PERP)
    // dapi.binance.com uses "SOLUSD_PERP" not "SOL/USD:SOL"
    const base        = h.symbol.split("/")[0].toUpperCase();  // "SOL"
    const binanceSymbol = `${base}USD_PERP`;

    if (diff > 0) {
      const limitPrice = parseFloat((currentPrice * (1 - LIMIT_OFFSET)).toFixed(2));
      logHedge(`Increasing short: ${absDiff} SOL = ${contractsNeeded} contracts | Limit SELL @ $${limitPrice}`, "info");

      const params = `symbol=${binanceSymbol}&side=SELL&type=LIMIT&quantity=${contractsNeeded}&price=${limitPrice}&timeInForce=GTC&timestamp=${Date.now()}&recvWindow=60000`;
      const sig    = crypto.createHmac("sha256", secretKey).update(params).digest("hex");
      const result = await new Promise((res, rej) => {
        const req = https.request({
          host: H.dapi, path: "/dapi/v1/order", method: "POST",
          headers: { "X-MBX-APIKEY": apiKey, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "node" },
        }, (r) => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{res(JSON.parse(d))}catch(e){rej(new Error(d))} }); });
        req.on("error", rej);
        req.write(`${params}&signature=${sig}`);
        req.end();
      });
      if (result.orderId) {
        logHedge(`Limit SELL placed: +${contractsNeeded} contracts @ $${limitPrice} | orderId: ${result.orderId}`, "success");
        h.currentShortQty = parseFloat((currentShort + absDiff).toFixed(4));
      } else {
        logHedge(`Order failed: ${JSON.stringify(result)}`, "error");
      }

    } else {
      const limitPrice = parseFloat((currentPrice * (1 + LIMIT_OFFSET)).toFixed(2));
      logHedge(`Reducing short: ${absDiff} SOL = ${contractsNeeded} contracts | Limit BUY @ $${limitPrice}`, "info");

      const params = `symbol=${binanceSymbol}&side=BUY&type=LIMIT&quantity=${contractsNeeded}&price=${limitPrice}&timeInForce=GTC&reduceOnly=true&timestamp=${Date.now()}&recvWindow=60000`;
      const sig    = crypto.createHmac("sha256", secretKey).update(params).digest("hex");
      const result = await new Promise((res, rej) => {
        const req = https.request({
          host: H.dapi, path: "/dapi/v1/order", method: "POST",
          headers: { "X-MBX-APIKEY": apiKey, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "node" },
        }, (r) => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{res(JSON.parse(d))}catch(e){rej(new Error(d))} }); });
        req.on("error", rej);
        req.write(`${params}&signature=${sig}`);
        req.end();
      });
      if (result.orderId) {
        logHedge(`Limit BUY placed: -${contractsNeeded} contracts @ $${limitPrice} | orderId: ${result.orderId}`, "success");
        h.currentShortQty = parseFloat((currentShort - absDiff).toFixed(4));
      } else {
        logHedge(`Order failed: ${JSON.stringify(result)}`, "error");
      }
    }

    h.lastRebalanceTs = Date.now();

    // ── 6. Telegram notification ──────────────────────────────────────────────
    if (cfg?.telegramToken && cfg?.telegramChatId) {
      const action = diff > 0 ? `Increased short +${absDiff} SOL` : `Reduced short -${absDiff} SOL`;
      await sendTelegram(cfg.telegramToken, cfg.telegramChatId,
        `🛡 Hedge Rebalanced
${action}
Spot: ${spotQty} SOL
Short: ${h.currentShortQty} SOL (target: ${targetShort})
Price: $${currentPrice.toFixed(2)}`
      );
    }

  } catch (err) {
    logHedge(`Rebalance error: ${err.message}`, "error");
  }
}



// ── Round helpers ────────────────────────────────────────────
function roundPrice(price, tickSize) {
  if (!tickSize) return parseFloat(price.toFixed(8));
  const decimals = (tickSize.toString().split(".")[1] || "").length;
  return parseFloat(price.toFixed(decimals));
}
function roundQty(qty, stepSize) {
  if (!stepSize) return parseFloat(qty.toFixed(8));
  const decimals = (stepSize.toString().split(".")[1] || "").length;
  return parseFloat(qty.toFixed(decimals));
}

// ── Build exchange (with API keys) ──────────────────────────
function buildExchange(priceSource, apiKey, secretKey) {
  const creds = {
    apiKey,
    secret                 : secretKey,
    adjustForTimeDifference: false,
    recvWindow             : 60000,
    options: {
      recvWindow           : 60000,
      // ── Disable ALL unnecessary API calls that cause 451 ────
      // CCXT by default calls sapi/v1/capital/config/getall (wallet info)
      // and fetchCurrencies on startup — Binance blocks these from non-UAE IPs
      fetchCurrencies      : false,   // skip currency/wallet info fetch
      defaultType          : "spot",  // will be overridden for futures below
    },
  };

  // Completely skip the capital/config endpoint
  // by overriding the CCXT method that calls it
  const buildBase = (exchange) => {
    if (!LIVE) exchange.setSandboxMode(true);      // Binance testnet unless live is approved
    exchange.fetchCurrencies = async () => ({});  // return empty, skip the call
    exchange.currencies      = {};
    exchange.currencies_by_id = {};
    return exchange;
  };

  if (priceSource === "binance_futures") {
    const ex = new ccxt.binanceusdm({ ...creds, options: { ...creds.options, defaultType: "future" } });
    return buildBase(ex);
  }
  if (priceSource === "binance_coinm") {
    const ex = new ccxt.binancecoinm({ ...creds, options: { ...creds.options, defaultType: "delivery" } });
    return buildBase(ex);
  }
  const ex = new ccxt.binance(creds);
  return buildBase(ex);
}

// ── Manual clock sync — overrides CCXT nonce() directly ────────────────
// CCXT calls exchange.nonce() to get the timestamp for every signed request.
// By replacing nonce() with our own function that adds the offset,
// we guarantee the correct time is used — nothing can override it.
async function syncExchangeTime(exchange) {
  try {
    // ── Fetch Binance server time via raw HTTPS (bypasses CCXT entirely) ──
    const serverTime = await new Promise((resolve, reject) => {
      // Pick the correct Binance endpoint based on exchange type
      const isUsdm   = exchange.id === "binanceusdm";
      const isCoinm  = exchange.id === "binancecoinm";
      const host     = H.spot;
      const path     = isUsdm ? "/fapi/v1/time" : isCoinm ? "/dapi/v1/time" : "/api/v3/time";

      https.get({ host, path, headers: { "User-Agent": "node" } }, (res) => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => {
          try { resolve(JSON.parse(raw).serverTime); }
          catch(e) { reject(new Error("Bad response: " + raw)); }
        });
      }).on("error", reject);
    });

    const localTime = Date.now();
    const offset    = serverTime - localTime;  // negative means local is ahead

    console.log("==============================================");
    console.log(`[TIME SYNC] Binance server : ${serverTime}`);
    console.log(`[TIME SYNC] Your PC clock  : ${localTime}`);
    console.log(`[TIME SYNC] Offset needed  : ${offset}ms`);
    console.log(`[TIME SYNC] Meaning        : your PC is ${Math.abs(offset)}ms ${offset < 0 ? "AHEAD of" : "BEHIND"} Binance`);
    console.log("==============================================");

    // ── Apply fix via ALL four CCXT mechanisms — one will stick ──

    // 1. timeDifference — used by older CCXT versions
    exchange.timeDifference = offset;

    // 2. options.timeDifference — used by some CCXT builds
    exchange.options.timeDifference = offset;

    // 3. nonce() — some CCXT versions call this for the timestamp
    exchange.nonce = () => Date.now() + offset;

    // 4. milliseconds() — CCXT 4.x uses THIS internally when signing requests
    //    This is the one that actually works in ccxt v4
    exchange.milliseconds = () => Date.now() + offset;

    console.log(`[TIME SYNC] All 4 timestamp hooks patched with offset ${offset}ms`);

  } catch (err) {
    console.warn("[TIME SYNC] Failed:", err.message);
  }
}

// buildPublicExchange removed — symbols now fetched client-side from browser

async function getCurrentPrice(exchange, symbol) {
  const ticker = await exchange.fetchTicker(symbol);
  return ticker.last;
}

async function getMarketInfo(exchange, symbol) {
  await exchange.loadMarkets();
  const market   = exchange.market(symbol);
  const tickSize = market.precision?.price  || 0.01;
  const stepSize = market.precision?.amount || 0.001;
  return { tickSize, stepSize };
}

// ============================================================
//  EMERGENCY STOP — cancel orders + send Telegram
// ============================================================
async function emergencyStop(reason) {
  if (!botState.running) return;
  clearInterval(botState.loopTimer);
  botState.running = false;
  log(`EMERGENCY STOP: ${reason}`, "error");
  try { await cancelAllOrders(); } catch(e) {}

  const cfg = botState.config;
  if (cfg?.telegramToken && cfg?.telegramChatId) {
    const msg =
      `GRID BOT STOPPED\n\n` +
      `Symbol: ${cfg.symbol}\n` +
      `Reason: ${reason}\n` +
      `Last Price: $${botState.lastPrice}\n` +
      `Upper Limit: $${botState.upperLimit}\n` +
      `Lower Limit: $${botState.lowerLimit}\n` +
      `Time: ${new Date().toLocaleString()}`;
    await sendTelegram(cfg.telegramToken, cfg.telegramChatId, msg);
  }
  broadcast("state", buildStateSnapshot());
}

// ============================================================
//  GRID LOOP — runs every 5 seconds
// ============================================================
async function gridLoop() {
  if (!botState.running) return;
  try {
    const currentPrice = await getCurrentPrice(botState.exchange, botState.config.symbol);
    botState.lastPrice = currentPrice;

    if (currentPrice >= botState.upperLimit) {
      await emergencyStop(`Price $${currentPrice} reached UPPER LIMIT $${botState.upperLimit}`);
      return;
    }
    if (currentPrice <= botState.lowerLimit) {
      await emergencyStop(`Price $${currentPrice} reached LOWER LIMIT $${botState.lowerLimit}`);
      return;
    }

    // 1. Check fills FIRST — must happen before sync removes filled orders from state
    await checkAndHandleFills(currentPrice);

    // 2. Sync every 5 loops (~25 seconds) to remove orphans — runs AFTER fills are processed
    botState.loopCount = (botState.loopCount || 0) + 1;
    if (botState.loopCount % 5 === 0) {
      await syncOrdersFromExchange();
    }

    // 3. Maintain grid last
    await maintainGrid(currentPrice);

    // 4. Hedge check every 12 loops (~60 seconds) — fee-safe frequency
    if (botState.loopCount % 12 === 0) {
      await checkAndRebalanceHedge();
    }

    // 5. Send Telegram when a new RT is completed (based on min buys/sells)
    const cfg2   = botState.config;
    const fills  = botState.fillHistory;
    const buys   = fills.filter(f => f.side === "buy").length;
    const sells  = fills.filter(f => f.side === "sell").length;
    const currRt = Math.min(buys, sells);
    if (currRt > (botState.lastNotifiedRt || 0) && cfg2?.telegramToken && cfg2?.telegramChatId) {
      const tsp      = cfg2.targetSpread || 0;
      const qty      = cfg2.qtyPerStep   || 0;
      const totalPnl = parseFloat((currRt * tsp * qty).toFixed(4));
      const perRtPnl = parseFloat((tsp * qty).toFixed(4));
      await sendTelegram(cfg2.telegramToken, cfg2.telegramChatId,
        `✅ Round Trip #${currRt} Complete!
Symbol: ${cfg2.symbol}
Price: $${currentPrice.toFixed(4)}
PnL this RT: +$${perRtPnl}
Total PnL: +$${totalPnl}
Total Buys: ${buys}  Sells: ${sells}`
      );
      botState.lastNotifiedRt = currRt;
      log(`📲 Telegram sent — RT #${currRt}  PnL: +$${totalPnl}`, "info");
    }

    broadcast("state", buildStateSnapshot());
  } catch (err) {
    log(`Loop error: ${err.message}`, "error");
  }
}

// ============================================================
//  CHECK FILLS
//  ┌─────────────────────────────────────────────────────┐
//  │  ENTRY fill  → place TARGET opposite side            │
//  │               open pendingRoundTrip                  │
//  │               maintainGrid re-fills the gap         │
//  │                                                      │
//  │  TARGET fill → complete roundTrip + PnL             │
//  │               maintainGrid auto places re-entry     │
//  └─────────────────────────────────────────────────────┘
// ============================================================
async function checkAndHandleFills(currentPrice) {
  const cfg = botState.config;
  if (botState.openOrders.length === 0) return;

  const stillOpen = [];

  for (const tracked of botState.openOrders) {
    try {
      const order = await botState.exchange.fetchOrder(tracked.id, cfg.symbol);

      if (order.status === "closed" || order.status === "filled") {
        const fillTs    = new Date().toISOString();
        const fillPrice = parseFloat(order.average || order.price || tracked.price);
        const fillQty   = parseFloat(order.filled  || order.amount || tracked.qty);

        log(`FILLED [${tracked.type.toUpperCase()}] ${tracked.side.toUpperCase()} @ $${fillPrice}  qty:${fillQty}`, "success");
        botState.fillHistory.unshift({ side: tracked.side, price: fillPrice, qty: fillQty, type: tracked.type, ts: fillTs });

        if (tracked.type === "entry") {
          // ── Compute target price purely from fill math ──────────────────────
          // entry SELL @ P → target BUY  @ P - targetSpread
          // entry BUY  @ P → target SELL @ P + targetSpread
          const { tickSize } = await getMarketInfo(botState.exchange, cfg.symbol);
          const targetSide  = tracked.side === "sell" ? "buy" : "sell";
          const targetPrice = tracked.side === "sell"
            ? roundPrice(fillPrice - cfg.targetSpread, tickSize)
            : roundPrice(fillPrice + cfg.targetSpread, tickSize);

          // ── Register pending RT keyed by entryPrice + entrySide ────────────
          // This is the ONLY key we need — deterministic, no ID needed
          const rtKey = `${tracked.side}_${fillPrice.toFixed(6)}`;
          // Avoid duplicate RTs for same entry price
          const alreadyPending = botState.pendingRoundTrips.some(rt => rt.rtKey === rtKey);
          if (!alreadyPending) {
            botState.pendingRoundTrips.push({
              rtKey,
              id         : `rt_${Date.now()}`,
              openSide   : tracked.side,
              openPrice  : fillPrice,
              targetSide,
              targetPrice,
              qty        : fillQty,
              openTs     : fillTs,
            });
            log(`Pending RT [${rtKey}]: target ${targetSide.toUpperCase()} @ $${targetPrice}`, "info");
          }

          // ── Place the actual target order on exchange ───────────────────────
          await placeTargetOrder(tracked.side, fillPrice, fillQty);

        } else if (tracked.type === "target") {
          // ── Target filled: find its pending RT by reverse math ──────────────
          // target BUY  @ P → came from entry SELL @ P + targetSpread
          // target SELL @ P → came from entry BUY  @ P - targetSpread
          const { tickSize } = await getMarketInfo(botState.exchange, cfg.symbol);
          const entrySide  = tracked.side === "buy" ? "sell" : "buy";
          const entryPrice = tracked.side === "buy"
            ? roundPrice(fillPrice + cfg.targetSpread, tickSize)
            : roundPrice(fillPrice - cfg.targetSpread, tickSize);
          const rtKey = `${entrySide}_${entryPrice.toFixed(6)}`;

          const idx = botState.pendingRoundTrips.findIndex(rt => rt.rtKey === rtKey);
          if (idx !== -1) {
            const rt        = botState.pendingRoundTrips.splice(idx, 1)[0];
            const buyPrice  = rt.openSide === "buy"  ? rt.openPrice : fillPrice;
            const sellPrice = rt.openSide === "sell" ? rt.openPrice : fillPrice;
            const pnl       = parseFloat(((sellPrice - buyPrice) * rt.qty).toFixed(8));

            botState.completedRoundTrips.unshift({
              id: rt.id, openSide: rt.openSide,
              openPrice: rt.openPrice, closePrice: fillPrice,
              qty: rt.qty, pnl,
              openTs: rt.openTs, closeTs: fillTs,
              durationMs: Date.now() - new Date(rt.openTs).getTime(),
            });
            log(`✅ ROUND TRIP  Buy@$${buyPrice.toFixed(4)} Sell@$${sellPrice.toFixed(4)}  PnL:$${pnl.toFixed(4)}`, "success");

            if (cfg?.telegramToken && cfg?.telegramChatId) {
              sendTelegram(cfg.telegramToken, cfg.telegramChatId,
                `✅ Round Trip
Symbol: ${cfg.symbol}
Buy: $${buyPrice.toFixed(4)}
Sell: $${sellPrice.toFixed(4)}
PnL: $${pnl.toFixed(4)}`
              );
            }
          } else {
            log(`Target ${tracked.side.toUpperCase()} @ $${fillPrice} filled — RT key [${rtKey}] not found in ${botState.pendingRoundTrips.length} pending`, "warn");
          }
        }

      } else if (order.status === "open" || order.status === "partially_filled") {
        stillOpen.push(tracked);
      }
      // canceled/expired orders are dropped silently

    } catch (err) {
      // If fetch fails, keep the order — don't lose it
      log(`fetchOrder error (${tracked.id}): ${err.message}`, "warn");
      stillOpen.push(tracked);
    }
  }

  botState.openOrders = stillOpen;
}

// ============================================================
//  PLACE TARGET ORDER
//
//  Rule: always 3 per side.
//  entry BUY  fills → target SELL placed on SELL side
//                   → cancel furthest entry SELL to keep sell side = 3
//  entry SELL fills → target BUY  placed on BUY  side
//                   → cancel furthest entry BUY  to keep buy  side = 3
//  maintainGrid then refills the emptied entry slot automatically
// ============================================================
// ============================================================
//  PLACE TARGET ORDER
//
//  entry SELL fills @ P → target BUY  @ P - targetSpread  (goes on BUY side)
//  entry BUY  fills @ P → target SELL @ P + targetSpread  (goes on SELL side)
//
//  Side rule: target side must stay at max 3 total orders
//  If full → cancel furthest ENTRY on that side to make room
//
//  Example (spacing=0.1, targetSpread=0.1):
//    Entry SELL @ 84.1 fills → Target BUY  @ 84.0  placed on BUY side
//    Entry SELL @ 84.2 fills → Target BUY  @ 84.1  placed on BUY side
//    Entry BUY  @ 83.9 fills → Target SELL @ 84.0  placed on SELL side
//    Entry BUY  @ 83.8 fills → Target SELL @ 83.9  placed on SELL side
// ============================================================
async function placeTargetOrder(filledSide, fillPrice, fillQty) {
  const cfg = botState.config;
  const { tickSize, stepSize } = await getMarketInfo(botState.exchange, cfg.symbol);

  // entry SELL @ P → target BUY  @ P - targetSpread
  // entry BUY  @ P → target SELL @ P + targetSpread
  const targetSide  = filledSide === "sell" ? "buy" : "sell";
  const targetPrice = filledSide === "sell"
    ? roundPrice(fillPrice - cfg.targetSpread, tickSize)
    : roundPrice(fillPrice + cfg.targetSpread, tickSize);
  const qty = roundQty(fillQty, stepSize);

  // Skip if already exists on exchange (tracked)
  const existing = botState.openOrders.find(
    o => o.side === targetSide && Math.abs(o.price - targetPrice) < 0.000001
  );
  if (existing) {
    log(`Target ${targetSide.toUpperCase()} @ $${targetPrice} already on exchange`, "info");
    return;
  }

  // Make room: if target side already has 3 orders, cancel furthest entry
  const sideOrders = botState.openOrders.filter(o => o.side === targetSide);
  if (sideOrders.length >= 3) {
    const victim = sideOrders
      .filter(o => o.type === "entry")
      .sort((a, b) => Math.abs(b.price - fillPrice) - Math.abs(a.price - fillPrice))[0];
    if (victim) {
      try {
        await botState.exchange.cancelOrder(victim.id, cfg.symbol);
        botState.openOrders = botState.openOrders.filter(o => o.id !== victim.id);
        log(`Removed ENTRY ${victim.side.toUpperCase()} @ $${victim.price} — making room for target`, "info");
      } catch (err) {
        log(`Could not remove entry: ${err.message}`, "warn");
      }
    }
  }

  try {
    const order = await botState.exchange.createLimitOrder(cfg.symbol, targetSide, qty, targetPrice);
    botState.openOrders.push({ id: order.id, side: targetSide, price: targetPrice, qty, type: "target" });
    log(`Target ${targetSide.toUpperCase()} placed @ $${targetPrice}`, "info");
  } catch (err) {
    log(`Target placement failed @ $${targetPrice}: ${err.message}`, "error");
  }
}



// ============================================================
//  MAINTAIN GRID
//
//  RULE: Exactly 3 orders on SELL side + 3 on BUY side = 6 total
//  Cancels:
//    - ENTRY on wrong side of price (price crossed it without fill)
//    - TARGET more than (spacing × 5) away from current price (stuck)
//  Places:
//    - Missing ENTRY orders at correct slots from snapped price
// ============================================================
async function maintainGrid(currentPrice) {
  const cfg = botState.config;
  const { tickSize, stepSize } = await getMarketInfo(botState.exchange, cfg.symbol);
  const qty = roundQty(cfg.qtyPerStep, stepSize);

  // ── Step 1: Cancel stale orders ─────────────────────────────────────────────
  // • ENTRY on wrong side of price → price moved past it without filling
  // • TARGET stuck too far from price → spacing × 5 threshold
  //   e.g. spacing=0.1 → cancel target if more than $0.50 from price
  // spacing×3 = if price moves 3 steps away, target is stale and blocks the grid
  // e.g. spacing=0.1 → cancel target if >$0.30 from price
  // Tight enough to catch volatile moves quickly (every 5 sec loop)
  const staleTargetDist = cfg.avgSellSpacing * 3;
  const keepOrders = [];
  for (const o of botState.openOrders) {
    let shouldCancel = false;
    let reason = "";

    if (o.type === "entry") {
      if (o.side === "sell" && o.price <= currentPrice) { shouldCancel = true; reason = "wrong-side (sell below price)"; }
      if (o.side === "buy"  && o.price >= currentPrice) { shouldCancel = true; reason = "wrong-side (buy above price)"; }
    } else {
      // TARGET: cancel if stuck more than 5×spacing away from current price
      const dist = Math.abs(o.price - currentPrice);
      if (dist > staleTargetDist) { shouldCancel = true; reason = `stuck $${dist.toFixed(4)} from price (limit $${staleTargetDist})`; }
    }

    if (shouldCancel) {
      try {
        await botState.exchange.cancelOrder(o.id, cfg.symbol);
        log(`Cancelled ${o.type.toUpperCase()} ${o.side.toUpperCase()} @ $${o.price} — ${reason}`, "info");
      } catch (err) {
        log(`Cancel failed (${o.id}): ${err.message}`, "warn");
        keepOrders.push(o);
      }
    } else {
      keepOrders.push(o);
    }
  }
  botState.openOrders = keepOrders;

  // ── Step 2: Count orders per side (ALL types count toward the 3 limit) ──────
  const sellSideCount = botState.openOrders.filter(o => o.price > currentPrice).length;
  const buySideCount  = botState.openOrders.filter(o => o.price < currentPrice).length;

  const sellNeeded = Math.max(0, 3 - sellSideCount);
  const buyNeeded  = Math.max(0, 3 - buySideCount);

  if (sellNeeded === 0 && buyNeeded === 0) {
    const eS = botState.openOrders.filter(o=>o.side==="sell").length;
    const eB = botState.openOrders.filter(o=>o.side==="buy").length;
    log(`Grid full: ${eS} sell-side + ${eB} buy-side = ${botState.openOrders.length} total`, "info");
    return;
  }

  // ── Step 3: Compute entry slots from snapped price ──────────────────────────
  // Snap to nearest spacing boundary so slots don't shift on every tick
  const spacing      = cfg.avgSellSpacing;
  const snappedPrice = roundPrice(Math.round(currentPrice / spacing) * spacing, tickSize);

  // All occupied prices (entries only — targets don't block entry slots)
  const occupiedEntryPrices = new Set(
    botState.openOrders.filter(o => o.type === "entry").map(o => o.price)
  );

  // ── Step 4: Place missing SELL entries (step×spacing above snapped price) ───
  if (sellNeeded > 0) {
    let placed = 0, step = 1;
    while (placed < sellNeeded && step <= 20) {
      const price = roundPrice(snappedPrice + step * cfg.avgSellSpacing, tickSize);
      step++;
      if (price <= currentPrice)        continue;
      if (price > botState.upperLimit)  continue;
      if (occupiedEntryPrices.has(price)) continue;
      try {
        const order = await botState.exchange.createLimitOrder(cfg.symbol, "sell", qty, price);
        log(`Entry SELL @ $${price}  [sell-side ${sellSideCount + placed + 1}/3]`, "info");
        botState.openOrders.push({ id: order.id, side: "sell", price, qty, type: "entry" });
        occupiedEntryPrices.add(price);
        placed++;
      } catch (err) {
        log(`Entry SELL failed @ $${price}: ${err.message}`, "error");
      }
    }
  }

  // ── Step 5: Place missing BUY entries (step×spacing below snapped price) ────
  if (buyNeeded > 0) {
    let placed = 0, step = 1;
    while (placed < buyNeeded && step <= 20) {
      const price = roundPrice(snappedPrice - step * cfg.avgBuySpacing, tickSize);
      step++;
      if (price >= currentPrice)        continue;
      if (price < botState.lowerLimit)  continue;
      if (occupiedEntryPrices.has(price)) continue;
      try {
        const order = await botState.exchange.createLimitOrder(cfg.symbol, "buy", qty, price);
        log(`Entry BUY  @ $${price}  [buy-side  ${buySideCount + placed + 1}/3]`, "info");
        botState.openOrders.push({ id: order.id, side: "buy", price, qty, type: "entry" });
        occupiedEntryPrices.add(price);
        placed++;
      } catch (err) {
        log(`Entry BUY  failed @ $${price}: ${err.message}`, "error");
      }
    }
  }

  const eS = botState.openOrders.filter(o=>o.price>currentPrice).length;
  const eB = botState.openOrders.filter(o=>o.price<currentPrice).length;
  log(`Grid[snap=$${snappedPrice}]: ${eS} sell-side + ${eB} buy-side = ${botState.openOrders.length} total`, "info");
}

// ============================================================
//  CANCEL ALL ORDERS
//  Step 1: Try Binance bulk cancel API (fastest)
//  Step 2: Fetch ALL open orders from exchange + cancel each
//  This ensures orphan orders are also cancelled on stop
// ============================================================
async function cancelAllOrders() {
  const cfg = botState.config;

  // Try bulk cancel first
  try {
    await botState.exchange.cancelAllOrders(cfg.symbol);
    log(`All orders cancelled via bulk API`, "success");
    botState.openOrders = [];
    return;
  } catch (err) {
    log(`Bulk cancel failed: ${err.message} — fetching all open orders...`, "warn");
  }

  // Fetch every open order directly from exchange (catches orphans too)
  try {
    const allOrders = await botState.exchange.fetchOpenOrders(cfg.symbol);
    log(`Found ${allOrders.length} open orders on exchange to cancel`, "info");
    for (const o of allOrders) {
      try {
        await botState.exchange.cancelOrder(o.id, cfg.symbol);
        log(`Cancelled order ${o.id} @ $${o.price}`, "info");
      } catch (e) {
        log(`Cancel error (${o.id}): ${e.message}`, "warn");
      }
    }
  } catch (err) {
    log(`fetchOpenOrders failed: ${err.message}`, "warn");
    // Last resort: cancel only tracked orders
    for (const o of botState.openOrders) {
      try {
        await botState.exchange.cancelOrder(o.id, cfg.symbol);
        log(`Cancelled tracked order ${o.id}`, "info");
      } catch (e) {
        log(`Cancel error (${o.id}): ${e.message}`, "warn");
      }
    }
  }
  botState.openOrders = [];
}

// ============================================================
//  SYNC OPEN ORDERS FROM EXCHANGE
//  - Orphan orders (on exchange but not in state) → CANCEL them
//  - Stale tracked orders (in state but not on exchange) → remove
// ============================================================
async function syncOrdersFromExchange() {
  const cfg = botState.config;
  try {
    const exchangeOrders = await botState.exchange.fetchOpenOrders(cfg.symbol);
    const exchangeIds    = new Set(exchangeOrders.map(o => o.id));
    const trackedIds     = new Set(botState.openOrders.map(o => o.id));

    // Cancel orphan orders — they are from previous sessions or network duplicates
    const orphans = exchangeOrders.filter(o => !trackedIds.has(o.id));
    if (orphans.length > 0) {
      log(`Found ${orphans.length} orphan orders — cancelling them`, "warn");
      for (const o of orphans) {
        try {
          await botState.exchange.cancelOrder(o.id, cfg.symbol);
          log(`Cancelled orphan ${o.side.toUpperCase()} @ $${o.price}`, "info");
        } catch (e) {
          log(`Orphan cancel failed (${o.id}): ${e.message}`, "warn");
        }
      }
    }

    // Remove stale tracked orders (filled or cancelled externally)
    const stale = botState.openOrders.filter(o => !exchangeIds.has(o.id));
    if (stale.length > 0) {
      log(`Removing ${stale.length} stale tracked orders`, "info");
      botState.openOrders = botState.openOrders.filter(o => exchangeIds.has(o.id));
    }

  } catch (err) {
    log(`syncOrdersFromExchange failed: ${err.message}`, "warn");
  }
}

// ── Calculate live stats from fill history ──────────────────
function calcLiveStats() {
  const fills = botState.fillHistory;

  // Buy average — average price of all buy fills
  const buys  = fills.filter(f => f.side === "buy");
  const sells = fills.filter(f => f.side === "sell");
  const buyAvg  = buys.length  ? buys.reduce((s,f)  => s + f.price, 0) / buys.length  : null;
  const sellAvg = sells.length ? sells.reduce((s,f) => s + f.price, 0) / sells.length : null;

  // Live PnL — sum of all completed round trip PnLs
  const totalPnl = botState.completedRoundTrips.reduce((s, rt) => s + rt.pnl, 0);

  const rt  = Math.min(buys.length, sells.length);
  const qty = botState.config?.qtyPerStep    || 0;
  const tsp = botState.config?.targetSpread  || 0;
  const simplePnl = parseFloat((rt * tsp * qty).toFixed(4));

  return {
    totalPnl       : simplePnl,
    buyAvg         : buyAvg  ? parseFloat(buyAvg.toFixed(4))  : null,
    sellAvg        : sellAvg ? parseFloat(sellAvg.toFixed(4)) : null,
    totalRoundTrips: rt,
    pendingLegs    : botState.pendingRoundTrips.length,
    totalBuys      : buys.length,
    totalSells     : sells.length,
    totalFills     : fills.length,
    targetSpread   : tsp,
    qtyPerStep     : qty,
    perRtPnl       : parseFloat((tsp * qty).toFixed(4)),
  };
}

// ── Filter round trips by period using fillHistory ───────────
// RT = min(buys, sells) in the period
// PnL = RT × targetSpread × qtyPerStep
function getRoundTripReport(fromTs, toTs) {
  const tsp      = botState.config?.targetSpread || 0;
  const qty      = botState.config?.qtyPerStep   || 0;
  const perRtPnl = parseFloat((tsp * qty).toFixed(6));
  // Allow ±10% tolerance around targetSpread for floating point & price rounding
  const tolerance = tsp * 0.10;

  // Filter fills in the period
  const periodFills = botState.fillHistory.filter(f => {
    const t = new Date(f.ts).getTime();
    return t >= fromTs && t <= toTs;
  });

  const periodBuys  = periodFills.filter(f => f.side === "buy").length;
  const periodSells = periodFills.filter(f => f.side === "sell").length;

  // ── Match valid round trips by price difference = targetSpread ─────────────
  // Rule: a buy at price B pairs with a sell at price B + targetSpread (±tolerance)
  //       a sell at price S pairs with a buy at price S - targetSpread (±tolerance)
  // Strategy: for each entry fill, find its matching target fill by price
  const usedBuyIdx  = new Set();
  const usedSellIdx = new Set();
  const rows        = [];

  const buyFills  = periodFills.filter(f => f.side === "buy") .sort((a,b) => new Date(a.ts)-new Date(b.ts));
  const sellFills = periodFills.filter(f => f.side === "sell").sort((a,b) => new Date(a.ts)-new Date(b.ts));

  // Pass 1: match entry BUYs with their target SELL (sellPrice - buyPrice ≈ targetSpread)
  for (let bi = 0; bi < buyFills.length; bi++) {
    if (usedBuyIdx.has(bi)) continue;
    const b = buyFills[bi];
    const expectedSell = b.price + tsp;

    for (let si = 0; si < sellFills.length; si++) {
      if (usedSellIdx.has(si)) continue;
      const s = sellFills[si];
      const diff = s.price - b.price;

      if (Math.abs(diff - tsp) <= tolerance && new Date(s.ts) >= new Date(b.ts)) {
        usedBuyIdx.add(bi);
        usedSellIdx.add(si);
        rows.push({
          openSide  : "BUY",
          buyPrice  : b.price,
          sellPrice : s.price,
          qty,
          pnl       : perRtPnl,
          openTs    : b.ts,
          closeTs   : s.ts,
          durationMs: new Date(s.ts) - new Date(b.ts),
        });
        break;
      }
    }
  }

  // Pass 2: match entry SELLs with their target BUY (sellPrice - buyPrice ≈ targetSpread)
  for (let si = 0; si < sellFills.length; si++) {
    if (usedSellIdx.has(si)) continue;
    const s = sellFills[si];

    for (let bi = 0; bi < buyFills.length; bi++) {
      if (usedBuyIdx.has(bi)) continue;
      const b = buyFills[bi];
      const diff = s.price - b.price;

      if (Math.abs(diff - tsp) <= tolerance && new Date(b.ts) >= new Date(s.ts)) {
        usedSellIdx.add(si);
        usedBuyIdx.add(bi);
        rows.push({
          openSide  : "SELL",
          buyPrice  : b.price,
          sellPrice : s.price,
          qty,
          pnl       : perRtPnl,
          openTs    : s.ts,
          closeTs   : b.ts,
          durationMs: new Date(b.ts) - new Date(s.ts),
        });
        break;
      }
    }
  }

  // Sort newest first
  rows.sort((a, b) => new Date(b.closeTs) - new Date(a.closeTs));

  const rt  = rows.length;
  const pnl = parseFloat((rt * perRtPnl).toFixed(4));

  return {
    count      : rt,
    pnl,
    wins       : rt,
    losses     : 0,
    winRate    : rt > 0 ? 100 : 0,
    roundTrips : rows,
    periodBuys,
    periodSells,
    perRtPnl,
  };
}

function buildStateSnapshot() {
  const h = botState.hedge;
  return {
    mode                : MODE,
    running             : botState.running,
    lastPrice           : botState.lastPrice,
    entryPrice          : botState.entryPrice,
    upperLimit          : botState.upperLimit,
    lowerLimit          : botState.lowerLimit,
    openOrders          : botState.openOrders,
    fillHistory         : botState.fillHistory.slice(0, 50),
    completedRoundTrips : botState.completedRoundTrips.slice(0, 50),
    pendingRoundTrips   : botState.pendingRoundTrips,
    stats               : calcLiveStats(),
    logsRecent          : botState.logs.slice(0, 50),
    hedge : {
      enabled         : h.enabled,
      spotInventory   : h.spotInventory,
      currentShortQty : h.currentShortQty,
      targetShortQty  : h.targetShortQty,
      lastCheckTs     : h.lastCheckTs,
      lastRebalanceTs : h.lastRebalanceTs,
      symbol          : h.symbol,
      log             : h.log.slice(0, 20),
    },
  };
}

// ============================================================
//  API ROUTES
// ============================================================

// ── GET /api/symbols REMOVED ────────────────────────────────
// Binance blocks requests from Railway's US servers (error 451).
// Symbols are now fetched directly from the browser (client-side)
// so the request comes from the user's UAE IP — Binance allows it.

// ── GET /api/status ─────────────────────────────────────────
app.get("/api/status", (req, res) => res.json(buildStateSnapshot()));

// ── GET /api/account — live portfolio overview ───────────────
app.get("/api/account", async (req, res) => {
  try {
    const apiKey    = process.env.BINANCE_API_KEY;
    const secretKey = process.env.BINANCE_SECRET_KEY;
    const futKey    = process.env.FUTURES_API_KEY    || apiKey;
    const futSecret = process.env.FUTURES_SECRET_KEY || secretKey;
    const livePrice = botState.lastPrice || 0;

    if (!apiKey || !secretKey) return res.status(400).json({ error: "API keys not configured" });

    // ── Spot balance via raw HTTPS ────────────────────────────────────────────
    function spotRequest(path) {
      return new Promise((resolve, reject) => {
        const ts  = Date.now();
        const q   = `timestamp=${ts}&recvWindow=60000`;
        const sig = crypto.createHmac("sha256", secretKey).update(q).digest("hex");
        https.get({ host:H.spot, path:`${path}?${q}&signature=${sig}`,
          headers:{"X-MBX-APIKEY":apiKey,"User-Agent":"node"} }, (r) => {
          let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} });
        }).on("error", reject);
      });
    }

    // ── COIN-M balance via raw HTTPS ──────────────────────────────────────────
    const spotBal = await spotRequest("/api/v3/account");
    const balances = spotBal.balances || [];

    const symbol = botState.config?.symbol || "SOL/FDUSD";
    const base   = symbol.split("/")[0];   // "SOL"
    const quote  = symbol.split("/")[1];   // "FDUSD"

    const quoteBal = balances.find(b => b.asset === quote);
    const solBal   = balances.find(b => b.asset === base);

    const spotFdusd    = quoteBal ? parseFloat(quoteBal.free) + parseFloat(quoteBal.locked) : 0;
    const spotSolQty   = solBal   ? parseFloat(solBal.free)   + parseFloat(solBal.locked)   : 0;
    const spotSolValue = parseFloat((spotSolQty * livePrice).toFixed(2));

    // ── Futures COIN-M balance ────────────────────────────────────────────────
    let futuresBalance = null, futuresUnrealizedPnl = null;
    try {
      const futData = await dapiSignedRequest("/dapi/v1/account", futKey, futSecret);
      // COIN-M: balance in SOL (the collateral)
      if (Array.isArray(futData.assets)) {
        const solAsset = futData.assets.find(a => a.asset === base);
        if (solAsset) {
          const walletBal  = parseFloat(solAsset.walletBalance  || 0);
          const unrealPnl  = parseFloat(solAsset.unrealizedProfit || 0);
          futuresBalance       = parseFloat((walletBal  * livePrice).toFixed(2));
          futuresUnrealizedPnl = parseFloat((unrealPnl  * livePrice).toFixed(2));
        }
      }
    } catch(e) {
      console.log("[ACCT] Futures fetch failed:", e.message);
    }

    const totalUsd = parseFloat((
      spotFdusd + spotSolValue +
      (futuresBalance || 0)
    ).toFixed(2));

    res.json({ spotFdusd, spotSolQty, spotSolValue, futuresBalance, futuresUnrealizedPnl, totalUsd, livePrice });

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/timecheck — diagnostic: shows your PC time vs Binance time ──
// Open http://localhost:3000/api/timecheck in browser to debug timestamp issues
app.get("/api/timecheck", async (req, res) => {
  const localTime = Date.now();
  try {
    const serverTime = await new Promise((resolve, reject) => {
      https.get({ host: H.spot, path: "/api/v3/time", headers: { "User-Agent": "node" } }, (r) => {
        let raw = "";
        r.on("data", c => raw += c);
        r.on("end", () => { try { resolve(JSON.parse(raw).serverTime); } catch(e) { reject(e); }});
      }).on("error", reject);
    });
    const offset = serverTime - localTime;
    res.json({
      binanceServerTime : serverTime,
      yourPCTime        : localTime,
      offsetMs          : offset,
      yourPCIs          : offset < 0 ? `${Math.abs(offset)}ms AHEAD of Binance` : `${offset}ms BEHIND Binance`,
      withinAllowedRange: Math.abs(offset) < 1000 ? "YES — should work fine" : "NO — this causes -1021 error",
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/start ─────────────────────────────────────────
app.post("/api/start", async (req, res) => {
  if (botState.running) return res.status(400).json({ error: "Bot is already running" });

  const cfg = req.body;

  // ── API keys come from .env — NOT from the frontend ─────
  cfg.apiKey    = process.env.BINANCE_API_KEY;
  cfg.secretKey = process.env.BINANCE_SECRET_KEY;

  // ── Telegram comes from .env — NOT from the frontend ────
  cfg.telegramToken  = process.env.TELEGRAM_BOT_TOKEN;
  cfg.telegramChatId = process.env.TELEGRAM_CHAT_ID;

  // Validate .env keys are present
  if (!cfg.apiKey || !cfg.secretKey) {
    return res.status(400).json({ error: "BINANCE_API_KEY or BINANCE_SECRET_KEY missing in .env file" });
  }

  // Validate form fields sent from frontend
  const required = ["priceSource","symbol","distance","avgSellSpacing","avgBuySpacing","targetSpread","qtyPerStep"];
  for (const field of required) {
    if (!cfg[field] && cfg[field] !== 0)
      return res.status(400).json({ error: `Missing field: ${field}` });
  }

  cfg.distance       = parseFloat(cfg.distance);
  cfg.avgSellSpacing = parseFloat(cfg.avgSellSpacing);
  cfg.avgBuySpacing  = parseFloat(cfg.avgBuySpacing);
  cfg.targetSpread   = parseFloat(cfg.targetSpread);
  cfg.qtyPerStep     = parseFloat(cfg.qtyPerStep);

  try {
    const exchange   = buildExchange(cfg.priceSource, cfg.apiKey, cfg.secretKey);

    // ── Step 1: loadMarkets is PUBLIC — no auth needed, safe to call first ──
    await exchange.loadMarkets();

    // ── Step 2: Sync time AFTER loadMarkets — because loadMarkets resets timeDifference to 0 ──
    await syncExchangeTime(exchange);

    // ── Step 3: Now make authenticated calls — timeDifference is correctly set ──
    const entryPrice = await getCurrentPrice(exchange, cfg.symbol);

    // AUTO-CALCULATE limits: entry ± distance
    const upperLimit = parseFloat((entryPrice + cfg.distance).toFixed(8));
    const lowerLimit = parseFloat((entryPrice - cfg.distance).toFixed(8));

    botState.config               = cfg;
    botState.exchange             = exchange;
    botState.entryPrice           = entryPrice;
    botState.lastPrice            = entryPrice;
    botState.upperLimit           = upperLimit;
    botState.lowerLimit           = lowerLimit;
    botState.running              = true;
    botState.openOrders           = [];
    botState.fillHistory          = [];
    botState.pendingRoundTrips    = [];
    botState.completedRoundTrips  = [];
    botState.logs                 = [];
    botState.loopCount            = 0;
    botState.lastNotifiedRt       = 0;

    // ── Hedge init ─────────────────────────────────────────────────────────
    const futuresApiKey    = process.env.FUTURES_API_KEY    || cfg.apiKey;
    const futuresSecretKey = process.env.FUTURES_SECRET_KEY || cfg.secretKey;

    if (cfg.hedgeEnabled && futuresApiKey && futuresSecretKey) {
      // ── COIN-M perpetual: SOL/USD:SOL ───────────────────────────────────────
      // User's position is on Binance COIN-M (collateral = SOL, quoted in USD)
      // NOT USDT-M (binanceusdm) — that requires USDT margin which user doesn't have there
      const futEx = new ccxt.binancecoinm({
        apiKey : futuresApiKey,
        secret : futuresSecretKey,
        adjustForTimeDifference: false,
        recvWindow: 60000,
        options: { recvWindow: 60000, defaultType: "delivery" },
      });
      futEx.fetchCurrencies = async () => ({});
      futEx.currencies = {};
      await futEx.loadMarkets();
      await syncExchangeTime(futEx);

      // COIN-M symbol format: SOL/USD:SOL  (base/quote:settlement)
      // e.g. SOL/FDUSD spot → hedge on SOL/USD:SOL COIN-M perpetual
      const base = cfg.symbol.split("/")[0];    // "SOL"
      const hedgeSymbol = `${base}/USD:${base}`; // "SOL/USD:SOL"

      // ── Read existing position on startup ────────────────────────────────────
      // We pass entryPrice explicitly because botState.lastPrice may be null here
      let existingShort = 0;
      try {
        const positions = await futEx.fetchPositions([hedgeSymbol]);
        for (const pos of positions) {
          if (pos.symbol === hedgeSymbol) {
            const contracts   = parseFloat(pos.info?.positionAmt ?? pos.contracts ?? 0);
            const contractSz  = parseFloat(pos.contractSize ?? pos.info?.multiplier ?? 10);
            const markPx      = parseFloat(pos.markPrice ?? pos.info?.markPrice ?? entryPrice);
            if (contracts < 0) {
              existingShort = parseFloat((Math.abs(contracts) * contractSz / markPx).toFixed(4));
            }
          }
        }
        log(`Hedge: existing COIN-M short = ${existingShort} ${base} (markPrice used for conversion)`, "info");
      } catch(e) {
        log(`Hedge: could not read existing position (${e.message}) — will fetch on first check`, "warn");
      }

      botState.hedge = {
        enabled          : true,
        futuresExchange  : futEx,
        currentShortQty  : existingShort,
        targetShortQty   : 0,
        spotInventory    : 0,
        lastCheckTs      : 0,
        lastRebalanceTs  : 0,
        symbol           : hedgeSymbol,
        log              : [],
      };
      const hedgePct = cfg.hedgePct || 80;
      log(`Hedge enabled: COIN-M ${hedgeSymbol} | ${hedgePct}% of spot | Existing short: ${existingShort} ${base}`, "success");
      log(`Rule: target = spotInventory × ${hedgePct}% | Only rebalance if diff ≥ 1 ${base}`, "info");
    } else {
      botState.hedge.enabled = false;
      log(`Hedge disabled: set FUTURES_API_KEY / FUTURES_SECRET_KEY in .env to enable`, "warn");
    }

    // Cancel any leftover orders from previous session before placing new grid
    log(`Cancelling any leftover orders from previous session...`, "info");
    try {
      await exchange.cancelAllOrders(cfg.symbol);
      log(`Previous orders cleared`, "info");
    } catch(e) {
      // If cancelAll fails try fetchAndCancel
      try {
        const prev = await exchange.fetchOpenOrders(cfg.symbol);
        for (const o of prev) {
          try { await exchange.cancelOrder(o.id, cfg.symbol); } catch(_) {}
        }
        log(`Cleared ${prev.length} previous orders one by one`, "info");
      } catch(_) {}
    }

    log(`Bot started! Entry: $${entryPrice} | ${cfg.symbol}`, "success");
    log(`Upper: $${upperLimit}  |  Lower: $${lowerLimit}`, "info");
    log(`Sell spacing: $${cfg.avgSellSpacing}  |  Buy spacing: $${cfg.avgBuySpacing}`, "info");

    // Telegram alert — reads from cfg which came from .env
    await sendTelegram(cfg.telegramToken, cfg.telegramChatId,
      `Grid Bot Started\nSymbol: ${cfg.symbol}\nEntry: $${entryPrice}\nUpper: $${upperLimit}\nLower: $${lowerLimit}\nTime: ${new Date().toLocaleString()}`
    );

    await maintainGrid(entryPrice);
    botState.loopTimer = setInterval(gridLoop, 5000);

    res.json({ success: true, entryPrice, upperLimit, lowerLimit });
  } catch (err) {
    log(`Start failed: ${err.message}`, "error");
    botState.running = false;
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/stop ───────────────────────────────────────────
app.post("/api/stop", async (req, res) => {
  if (!botState.running) return res.json({ message: "Bot was not running" });

  clearInterval(botState.loopTimer);
  botState.running = false;
  log("Manual stop — cancelling orders...", "warn");

  // ── Cancel orders (errors here won't block Telegram) ────────
  try {
    await cancelAllOrders();
    log("All orders cancelled. Bot stopped.", "success");
  } catch (err) {
    log(`Cancel error during stop: ${err.message}`, "warn");
  }

  // ── Send Telegram ALWAYS — read directly from process.env ───
  // Never rely on cfg which might be null or missing keys
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const symbol = botState.config?.symbol || "Unknown";
  const price  = botState.lastPrice      || "Unknown";

  console.log(`[STOP] Sending Telegram to token=${token ? "set" : "MISSING"} chatId=${chatId ? "set" : "MISSING"}`);

  await sendTelegram(token, chatId,
    `🛑 Grid Bot Manually Stopped

Symbol: ${symbol}
Last Price: $${price}
Time: ${new Date().toLocaleString()}`
  );

  res.json({ success: true });
  broadcast("state", buildStateSnapshot());
});

app.get("/api/logs", (req, res) => res.json(botState.logs));

// ── GET /api/report?period=24h|7d|30d|custom&from=ts&to=ts ──
app.get("/api/report", (req, res) => {
  const now    = Date.now();
  const period = req.query.period || "24h";
  let fromTs, toTs = now;

  if (period === "24h") {
    fromTs = now - 24 * 60 * 60 * 1000;
  } else if (period === "7d") {
    fromTs = now - 7  * 24 * 60 * 60 * 1000;
  } else if (period === "30d") {
    fromTs = now - 30 * 24 * 60 * 60 * 1000;
  } else if (period === "custom") {
    fromTs = parseInt(req.query.from) || (now - 24 * 60 * 60 * 1000);
    toTs   = parseInt(req.query.to)   || now;
  } else {
    fromTs = now - 24 * 60 * 60 * 1000;
  }

  res.json({ period, fromTs, toTs, ...getRoundTripReport(fromTs, toTs) });
});

wss.on("connection", (ws) => {
  console.log("Frontend connected");
  ws.send(JSON.stringify({ type: "state", data: buildStateSnapshot() }));
});

const PORT = process.env.PORT || 3000;
// Must bind to 0.0.0.0 on Railway (not just localhost)
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Grid Bot running on port ${PORT}\n`);
  startTelegramPoller();
});