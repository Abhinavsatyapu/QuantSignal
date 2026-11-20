// Zone Monitor data engine. Free sources, plus your Alpaca keys when set (ALPACA_KEY_ID / ALPACA_SECRET_KEY):
//   Alpaca (if keys): daily bars (IEX feed) and option chains (open interest + greeks, indicative feed) — preferred.
//   Credit regime : FRED (ICE BofA HY & IG option-adjusted spreads, HY effective yield, 10-year Treasury)
//   Breadth       : RSP / SPY ratio (equal-weight vs cap-weight S&P 500) from Yahoo, Stooq as backup
//   Gamma (GEX)   : Cboe public delayed option chains (≈15 min delayed): net dealer gamma per name, SPY gamma flip,
//                   +GEX breadth across the stock-perp universe, history kept per trading day
//   Regime dial   : combines trend, credit, breadth and gamma. Context only — never a trading rule.
"use strict";
const fs = require("fs"), store = require("./store");

const SRC = {
  fred: process.env.FRED_BASE || "https://fred.stlouisfed.org/graph/fredgraph.csv?id=",
  yahoo: process.env.YAHOO_BASE || "https://query1.finance.yahoo.com/v8/finance/chart/",
  stooq: process.env.STOOQ_BASE || "https://stooq.com/q/d/l/?i=d&s=",
  cboe: process.env.CBOE_BASE || "https://cdn-api.cboe.com/api/global/delayed_quotes/options/",
  cboeHist: process.env.CBOE_HIST || "https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/",
  hl: process.env.HL_API || "https://api.hyperliquid.xyz/info",
};
const UA = { "User-Agent": "Mozilla/5.0 (QuantSignal Zone Monitor)" };
const ALP = { key: process.env.ALPACA_KEY_ID || "", secret: process.env.ALPACA_SECRET_KEY || "",
  data: process.env.ALPACA_DATA_URL || "https://data.alpaca.markets", trade: process.env.ALPACA_TRADING_URL || "https://paper-api.alpaca.markets" };
const hasAlpaca = () => !!(ALP.key && ALP.secret);
let alpNext = 0;                                     // ~180 requests/min, under the free 200/min limit
async function alp(base, path, ms = 30000) {
  const wait = Math.max(0, alpNext - Date.now()); alpNext = Math.max(Date.now(), alpNext) + 340; if (wait) await new Promise(r => setTimeout(r, wait));
  const r = await fetch(base + path, { headers: { "APCA-API-KEY-ID": ALP.key, "APCA-API-SECRET-KEY": ALP.secret, accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} from Alpaca ${path.split("?")[0]}`), { status: r.status });
  return r.json();
}
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

// ---------- small helpers ----------
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const ema = (a, n) => { const k = 2 / (n + 1); let e = null; return a.map(v => (e = e == null ? v : v * k + e * (1 - k))); };
const pctRank = (arr, v) => arr.length ? Math.round(arr.filter(x => x <= v).length / arr.length * 100) : null;
const at = (a, back) => a.length > back ? a[a.length - 1 - back] : null;
async function get(url, type = "json", ms = 25000) {
  const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} from ${new URL(url).host}`), { status: r.status });
  return type === "json" ? r.json() : r.text();
}
function nyNow(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now)).map(x => [x.type, x.value]));
  const mins = +p.hour * 60 + +p.minute, wk = !["Sat", "Sun"].includes(p.weekday);
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, mins, open: wk && mins >= 570 && mins < 960 };
}

// ---------- FRED credit ----------
async function fredSeries(id) {
  const t = await get(SRC.fred + id, "text");
  const rows = t.trim().split(/\r?\n/).slice(1).map(l => l.split(",")).filter(x => x[1] && x[1] !== "." && x[1] !== "").map(x => ({ d: x[0], v: Number(x[1]) })).filter(x => Number.isFinite(x.v));
  if (rows.length < 70) throw new Error("FRED " + id + ": too little data");
  return rows.slice(-800);
}
async function credit() {
  const [hy, ig, hyy, t10] = await Promise.all(["BAMLH0A0HYM2", "BAMLC0A0CM", "BAMLH0A0HYM2EY", "DGS10"].map(id => fredSeries(id).catch(() => null)));
  if (!hy) throw new Error("HY spread unavailable");
  const v = hy.map(x => x.v), last = v.at(-1), bp = (a, n) => a && a.length > n ? Math.round((a.at(-1).v - at(a, n).v) * 100) : null;
  const d5hist = v.slice(5).map((x, i) => (x - v[i]) * 100), d5 = bp(hy, 5), d20 = bp(hy, 20), d60 = bp(hy, 60);
  const line = mean(v.slice(-60)), hi90 = Math.max(...v.slice(-90)), hiDay = hy.slice(-90).find(x => x.v === hi90)?.d;
  const t10d20 = bp(t10, 20), t10d60 = bp(t10, 60);
  // which leg moved the cost of HY debt: the spread or the Treasury
  const driver = hyy && t10 ? (Math.abs(d60 ?? 0) >= Math.abs(t10d60 ?? 0) ? "the spread" : "the Treasury leg") : null;
  const t10d5 = bp(t10, 5);
  const week = d5 >= 10 ? "FEAR" : d5 >= 4 ? "WATCH" : "CALM", month = d20 >= 40 ? "FEAR" : d20 >= 25 ? "WATCH" : "CALM";
  const rank = { CALM: 0, WATCH: 1, FEAR: 2 }, state = d20 <= -15 && week === "CALM" ? "EASING" : rank[week] >= rank[month] ? week : month;
  // start of the current stretch above the line
  let k = v.length - 1; while (k > 0 && v[k - 1] > line) k--; const scareSince = last > line ? hy[k].d : null;
  const fearDriven = (d20 ?? 0) > 0 && (t10d20 ?? 0) <= 0;   // spread widening while Treasury yields fall: flight to safety
  return { asOf: hy.at(-1).d, hy: last, line, vsLineBp: Math.round((last - line) * 100), peak90: hi90, peakDay: hiDay, atHighs: last >= hi90 - 0.02,
           d5, d20, d60, d5pct: pctRank(d5hist, d5), ig: ig ? ig.at(-1).v : null, igD60: bp(ig, 60), t10: t10 ? t10.at(-1).v : null, t10d5, t10d20, t10d60,
           hyYield: hyy ? hyy.at(-1).v : null, hyYieldD60: bp(hyy, 60), driver, state, week, month, scareSince, fearDriven,
           unresolved: state === "FEAR" && last > line, trend: d5 > 2 ? "widening" : d5 < -2 ? "tightening" : "flat" };
}

// ---------- daily prices (Yahoo, Stooq backup) ----------
const why = e => (e && (e.cause && (e.cause.code || e.cause.message)) || e.message || String(e));
async function daily(sym, log) {
  const tried = [];
  // 0) Alpaca daily bars (IEX feed) when keys are set
  if (hasAlpaca()) try {
    let rows = [], tok = "";
    const start = isoDay(Date.now() - 760 * 864e5);
    do { const j = await alp(ALP.data, `/v2/stocks/${encodeURIComponent(sym)}/bars?timeframe=1Day&start=${start}&adjustment=all&feed=iex&limit=10000${tok ? "&page_token=" + tok : ""}`);
      rows = rows.concat((j.bars || []).map(b => ({ d: String(b.t).slice(0, 10), c: Number(b.c) }))); tok = j.next_page_token || ""; } while (tok);
    rows = rows.filter(x => Number.isFinite(x.c) && x.c > 0);
    if (rows.length > 100) return rows.slice(-520);
    tried.push("alpaca: " + rows.length + " bars");
  } catch (e) { tried.push("alpaca: " + why(e)); }
  // 1) Cboe daily history (same host family as the option chains, reachable from cloud servers)
  try {
    const j = await get(SRC.cboeHist + encodeURIComponent(sym) + ".json");
    const arr = Array.isArray(j.data) ? j.data : Array.isArray(j.data && j.data.data) ? j.data.data : [];
    const rows = arr.map(x => ({ d: String(x.date || x.Date || "").slice(0, 10), c: Number(x.close ?? x.Close) })).filter(x => x.d && Number.isFinite(x.c) && x.c > 0).sort((a, b) => a.d < b.d ? -1 : 1);
    if (rows.length > 100) return rows.slice(-520);
    tried.push("cboe: " + (arr.length ? arr.length + " rows" : "unexpected format " + JSON.stringify(j).slice(0, 120)));
  } catch (e) { tried.push("cboe: " + why(e)); }
  // 2) Yahoo (two hosts)
  for (const host of [SRC.yahoo, SRC.yahoo.replace("query1", "query2")]) {
    try {
      const j = await get(host + encodeURIComponent(sym) + "?range=2y&interval=1d");
      const r = j.chart.result[0], q = r.indicators.quote[0], adj = r.indicators.adjclose?.[0]?.adjclose;
      const rows = r.timestamp.map((t, i) => ({ d: new Date(t * 1000).toISOString().slice(0, 10), c: (adj || q.close)[i] })).filter(x => Number.isFinite(x.c));
      if (rows.length > 100) return rows;
    } catch (e) { tried.push(new URL(host).host + ": " + why(e)); }
    if (host === SRC.yahoo.replace("query1", "query2")) break;
  }
  // 3) Stooq
  try {
    const t = await get(SRC.stooq + sym.toLowerCase() + ".us", "text");
    const rows = t.trim().split(/\r?\n/).slice(1).map(l => l.split(",")).map(x => ({ d: x[0], c: Number(x[4]) })).filter(x => Number.isFinite(x.c));
    if (rows.length >= 100) return rows.slice(-520);
    tried.push("stooq: " + t.slice(0, 60));
  } catch (e) { tried.push("stooq: " + why(e)); }
  throw new Error(sym + " daily prices unavailable (" + tried.join("; ") + ")");
}
async function breadth() {
  const rsp = await daily("RSP"), spy = await daily("SPY"), qqq = await daily("QQQ");
  const m = new Map(spy.map(x => [x.d, x.c])), ratio = rsp.filter(x => m.has(x.d)).map(x => ({ d: x.d, v: x.c / m.get(x.d) }));
  const rv = ratio.map(x => x.v), e50 = ema(rv, 50).at(-1), chg = n => (rv.at(-1) / at(rv, n) - 1) * 100;
  const s = spy.map(x => x.c), e20 = ema(s, 20).at(-1), sma200 = mean(s.slice(-200)), spy10 = (s.at(-1) / at(s, 10) - 1) * 100;
  const q = qqq.map(x => x.c), look = qqq.slice(-60), hi = Math.max(...look.map(x => x.c)), hiDay = look.find(x => x.c === hi).d;
  const afterHi = qqq.slice(qqq.findIndex(x => x.d === hiDay)), lo = Math.min(...afterHi.map(x => x.c)), loDay = afterHi.find(x => x.c === lo).d;
  const fromHi = (q.at(-1) / hi - 1) * 100, bounce = (q.at(-1) / lo - 1) * 100;
  const state = rv.at(-1) > e50 && chg(20) > 0 ? "BROADENING" : rv.at(-1) < e50 && chg(20) < 0 ? "NARROWING" : "MIXED";
  const tell = spy10 < 0 ? (chg(20) > 0 ? "mega-cap / tech led fall" : "broad selling") : (chg(20) > 0 ? "broad rally" : "narrow, mega-cap led rally");
  let hygIef = null; try { const h = await daily("HYG"), i2 = await daily("IEF"), mi = new Map(i2.map(x => [x.d, x.c])), r2 = h.filter(x => mi.has(x.d)).map(x => x.c / mi.get(x.d)); if (r2.length > 61) hygIef = (r2.at(-1) / at(r2, 60) - 1) * 100; } catch {}
  return { tell, hygIef, lowToday: loDay === qqq.at(-1).d, asOf: spy.at(-1).d, ratio: rv.at(-1), ratioEma50: e50, aboveEma50: rv.at(-1) > e50, d10: chg(10), d20: chg(20), state,
           spy: s.at(-1), spy10, spyAboveEma20: s.at(-1) > e20, spyEma20: e20, spyAbove200: s.at(-1) > sma200, spy5: (s.at(-1) / at(s, 5) - 1) * 100,
           qqq: { last: q.at(-1), high: hi, highDay: hiDay, low: lo, lowDay: loDay, fromHigh: fromHi, bounce },
           history: ratio.slice(-120).map(x => [x.d, +x.v.toFixed(5)]) };
}

// ---------- gamma (Cboe) ----------
const nPdf = x => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
function bsGamma(S, K, T, iv) { if (!(S > 0 && K > 0 && T > 0 && iv > 0)) return 0; const d1 = (Math.log(S / K) + (0.04 + iv * iv / 2) * T) / (iv * Math.sqrt(T)); return nPdf(d1) / (S * iv * Math.sqrt(T)); }
function parseOcc(sym) { const m = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(sym || "")); if (!m) return null; return { exp: Date.UTC(2000 + +m[2], +m[3] - 1, +m[4], 21), cp: m[5], K: +m[6] / 1000 }; }
// ---- option chains → legs {cp, K, exp, oi, g, iv} ----
async function chainCboe(t) {
  const j = await get(SRC.cboe + encodeURIComponent(t) + ".json?_=" + Date.now(), "json", 30000);
  const d = j && j.data; if (!d || !Array.isArray(d.options)) throw new Error("no chain");
  const S = Number(d.current_price || d.close || d.prev_day_close); if (!(S > 0)) throw new Error("no price");
  const legs = d.options.map(o => { const p = parseOcc(o.option); return p && { cp: p.cp, K: p.K, exp: p.exp, oi: Number(o.open_interest || 0), g: Number(o.gamma), iv: Number(o.iv) }; }).filter(Boolean);
  return { S, legs, quoteTime: j.timestamp || null, source: "cboe" };
}
async function chainAlpaca(t, spot) {
  const today = isoDay(Date.now()), lte = isoDay(Date.now() + 60 * 864e5), oi = new Map(); let tok = "";
  do { const j = await alp(ALP.trade, `/v2/options/contracts?underlying_symbols=${encodeURIComponent(t)}&status=active&expiration_date_gte=${today}&expiration_date_lte=${lte}&limit=10000${tok ? "&page_token=" + tok : ""}`);
    for (const c of j.option_contracts || []) if (Number(c.open_interest) > 0) oi.set(c.symbol, Number(c.open_interest)); tok = j.next_page_token || ""; } while (tok);
  if (!oi.size) throw new Error("no open interest");
  const legs = []; tok = "";
  do { const j = await alp(ALP.data, `/v1beta1/options/snapshots/${encodeURIComponent(t)}?feed=indicative&limit=1000&expiration_date_lte=${lte}${tok ? "&page_token=" + tok : ""}`);
    for (const [sym, x] of Object.entries(j.snapshots || {})) { const p = parseOcc(sym), n = oi.get(sym); if (!p || !n) continue;
      legs.push({ cp: p.cp, K: p.K, exp: p.exp, oi: n, g: Number(x.greeks && x.greeks.gamma), iv: Number(x.impliedVolatility) }); }
    tok = j.next_page_token || ""; } while (tok);
  let S = spot; if (!(S > 0)) { const q = await alp(ALP.data, `/v2/stocks/${encodeURIComponent(t)}/trades/latest?feed=iex`); S = Number(q.trade && q.trade.p); }
  if (!(S > 0)) throw new Error("no price");
  return { S, legs, quoteTime: new Date().toISOString(), source: "alpaca" };
}
// net dealer gamma ($ per 1% move), common convention: dealers long calls / short puts. Walls = strikes with the most call / put gamma.
async function gexFor(t, withFlip = true, spot) {
  const ch = hasAlpaca() ? await chainAlpaca(t, spot) : await chainCboe(t);
  const S = ch.S, now = Date.now(); let call = 0, put = 0; const flipLegs = [], byK = new Map();
  for (const o of ch.legs) {
    if (o.exp < now || !(o.oi > 0)) continue;
    const T = Math.max((o.exp - now) / 365 / 864e5, 1 / 365);
    const g = Number.isFinite(o.g) && o.g > 0 ? o.g : (o.iv > 0 ? bsGamma(S, o.K, T, o.iv) : 0); if (!(g > 0)) continue;
    const dollar = g * o.oi * 100 * S * S * 0.01;
    if (o.cp === "C") call += dollar; else put += dollar;
    if (Math.abs(o.K / S - 1) <= 0.25) { const w = byK.get(o.K) || { c: 0, p: 0 }; o.cp === "C" ? (w.c += dollar) : (w.p += dollar); byK.set(o.K, w); }
    if (withFlip && o.exp - now < 60 * 864e5 && o.iv > 0) flipLegs.push([o.cp === "C" ? 1 : -1, o.K, T, o.iv, o.oi]);
  }
  const net = call - put, gross = call + put; if (!(gross > 0)) throw new Error("no open interest");
  let callWall = null, putWall = null, cw = 0, pw = 0;
  for (const [K, w] of byK) { if (w.c > cw) { cw = w.c; callWall = K; } if (w.p > pw) { pw = w.p; putWall = K; } }
  const out = { t, spot: S, net, norm: net / gross, call, put, callWall, putWall, quoteTime: ch.quoteTime, source: ch.source };
  if (flipLegs.length) {                   // gamma flip: spot where net gamma changes sign (±12% grid)
    const netAt = x => flipLegs.reduce((s, [sg, K, T, iv, oi]) => s + sg * bsGamma(x, K, T, iv) * oi * 100 * x * x * 0.01, 0);
    let prev = null, flip = null;
    for (let k = -48; k <= 48; k++) { const x = S * (1 + k * 0.0025), v = netAt(x); if (prev && Math.sign(v) !== Math.sign(prev.v)) { const f = prev.x + (x - prev.x) * (-prev.v) / (v - prev.v); if (flip == null || Math.abs(f - S) < Math.abs(flip - S)) flip = f; } prev = { x, v }; }
    out.flip = flip;
  }
  return out;
}

// Universe: the tickers on your Zone Monitor print, grouped by industry (group names from the print; the per-ticker
// assignment is ours). Override with ZONE_TICKERS="AAPL,MSFT,..." if you want a different list.
const GROUPS = {
  "AI & Compute": "NVDA AMD INTC MU MRVL QCOM AMAT LRCX TER CRDO COHR AAOI SMH SOXX SNDK WDC DELL CRWV NBIS IREN IONQ QBTS",
  "Software & IT Services": "MSFT CRM ADBE WDAY TEAM DDOG SNOW NET CRWD PANW PLTR PATH SHOP MASS",
  "Internet & Telecom": "AMZN GOOG META RBLX GLW",
  "Pharma & Biotech": "LLY ABBV ARCT NTLA BEAM CRSP KYMR PRME RXRX SDGR ABSI TWST GENB IDNA IBB XBI PBE",
  "Medical Devices & Diagnostics": "ABT TMO TECH PACB BFLY TEM VCYT PSNL ADPT CERS",
  "Healthcare Services": "CVS",
  "Next-gen & Clean Energy": "ENPH FSLR BE CEG GEV",
  "Machinery & Equipment": "CAT URI AYI",
  "Aerospace, Defense & Space": "GE ASTS SPCX PL",
  "Banks & Lending": "SOFI PYPL",
  "Capital Markets & Asset Mgmt": "HOOD",
  "Crypto & Digital Assets": "COIN MSTR CRCL BMNR",
  "Consumer & Retail": "AAPL TSLA CVNA KDP",
  "Index & ETFs": "SPY QQQ IWM TQQQ SQQQ",
};
const EXTRA = { PURR: "Other", QSI: "Pharma & Biotech", PTRN: "Other" };
const sectorOf = (() => { const m = new Map(Object.entries(EXTRA)); for (const [s, list] of Object.entries(GROUPS)) for (const t of list.split(" ")) m.set(t, s); return t => m.get(t) || "Other"; })();
function tickers() {
  const env = (process.env.ZONE_TICKERS || "").split(/[ ,]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
  return env.length ? env : [...new Set(Object.values(GROUPS).join(" ").split(" "))];
}
async function spots(list) {      // last price + previous close for the whole list in one call (Alpaca), else Hyperliquid perps
  const out = new Map();
  if (hasAlpaca()) { for (let i = 0; i < list.length; i += 200) { try {
      const j = await alp(ALP.data, `/v2/stocks/snapshots?symbols=${list.slice(i, i + 200).join(",")}&feed=iex`);
      for (const [t, x] of Object.entries(j)) { const last = Number(x.latestTrade && x.latestTrade.p) || Number(x.dailyBar && x.dailyBar.c), prev = Number(x.prevDailyBar && x.prevDailyBar.c);
        out.set(t, { last, prev, chg: last > 0 && prev > 0 ? (last / prev - 1) * 100 : null }); } } catch {} } }
  if (!out.size) try {
    const r = await fetch(SRC.hl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs", dex: "xyz" }), signal: AbortSignal.timeout(15000) });
    const [meta, ctx] = await r.json();
    meta.universe.forEach((u, i) => { const t = String(u.name).split(":").pop(), last = Number(ctx[i]?.markPx), prev = Number(ctx[i]?.prevDayPx); out.set(t, { last, prev, chg: last > 0 && prev > 0 ? (last / prev - 1) * 100 : null }); });
  } catch {}
  return out;
}

let history = {};   // day -> {breadth, spyNorm, n, cohorts:{group: +GEX breadth}}; from Neon (or /tmp) at start
let levels = { today: null, base: null };   // per-ticker walls / flip / GEX: today's latest and the previous session's last (= daily baseline)

function legs(series) {           // drain / build leg of the +GEX breadth series
  const v = series.map(x => x[1]); if (v.length < 3) return null;
  const look = series.slice(-120), lv = look.map(x => x[1]), last = lv.at(-1);
  const pk = lv.lastIndexOf(Math.max(...lv));
  if (pk === lv.length - 1) { const pre = lv.slice(0, pk + 1), t0 = pre.lastIndexOf(Math.min(...pre)); return { kind: "BUILD", since: look[t0][0], sessions: lv.length - 1 - t0, offPeak: 0 }; }
  const after = lv.slice(pk), trough = Math.min(...after), ti = pk + after.lastIndexOf(trough);
  if (last - trough < (lv[pk] - trough) / 2) return { kind: "DRAIN", since: look[pk][0], sessions: lv.length - 1 - pk, trough: look[ti][0], offTrough: last - trough };
  return { kind: "BUILD", since: look[ti][0], sessions: lv.length - 1 - ti, offPeak: last - lv[pk] };
}

async function gamma(log) {
  const day = nyNow().day, list = tickers(), px = await spots(list);
  const names = [], fails = [], reasons = {}, sleep = ms => new Promise(r => setTimeout(r, ms));
  for (const t of list) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { const p = px.get(t); const g = await gexFor(t, true, p && p.last); names.push({ ...g, sector: sectorOf(t), chg: p ? p.chg : null }); break; }
      catch (e) { const k = e.status ? "HTTP " + e.status : why(e); if ((e.status === 429 || e.status >= 500 || !e.status) && attempt < 2) { await sleep((e.status === 429 ? 8000 : 2000) * (attempt + 1)); continue; } reasons[k] = (reasons[k] || 0) + 1; fails.push(t); break; }
    }
    if (!hasAlpaca()) await sleep(400);
  }
  const spy = names.find(n => n.t === "SPY"), qqq = names.find(n => n.t === "QQQ");
  if (!spy) throw new Error("SPY chain unavailable" + (Object.keys(reasons).length ? " (" + Object.keys(reasons).join(", ") + ")" : ""));
  const stocks = names.filter(n => GROUPS["Index & ETFs"].split(" ").indexOf(n.t) < 0);
  const pos = stocks.filter(n => n.norm > 0).length, br = stocks.length ? pos / stocks.length * 100 : null;
  const groups = stocks.reduce((m, n) => ((m[n.sector] = m[n.sector] || []).push(n), m), {});
  const cohortToday = Object.fromEntries(Object.entries(groups).map(([g, a]) => [g, a.filter(x => x.norm > 0).length / a.length * 100]));
  history[day] = { breadth: br, spyNorm: spy.norm, n: stocks.length, cohorts: cohortToday };
  for (const d of Object.keys(history).sort().slice(0, -400)) delete history[d];
  try { await store.saveDay(day, history[day]); } catch (e) { if (log) log("zone history save failed: " + e.message); }
  // daily baseline = last levels of the previous session
  const lv = Object.fromEntries(names.map(n => [n.t, { spot: n.spot, putWall: n.putWall, callWall: n.callWall, flip: n.flip ?? null, norm: n.norm }]));
  if (levels.today && levels.today.day !== day) levels.base = levels.today;
  levels.today = { day, at: new Date().toISOString(), names: lv };
  store.saveCache("levels", levels, Date.now()).catch(() => {});
  const days = Object.keys(history).sort(), series = days.map(d => [d, history[d].breadth, history[d].spyNorm]);
  const bvals = series.map(x => x[1]).filter(Number.isFinite), back = n => series.length > n ? series[series.length - 1 - n][1] : null;
  const cohorts = Object.entries(groups).map(([g, a]) => {
    const hist = days.map(d => history[d].cohorts && history[d].cohorts[g]).filter(Number.isFinite), now_ = cohortToday[g];
    return { sector: g, n: a.length, res: 100 / a.length, posBreadth: now_, pct: pctRank(hist, now_), d5: hist.length > 5 ? now_ - hist[hist.length - 6] : null,
             spark: hist.slice(-30), thin: a.length <= 10, avgNorm: mean(a.map(x => x.norm)), medChg: median(a.map(x => x.chg).filter(Number.isFinite)),
             names: a.sort((x, y) => y.norm - x.norm).map(x => [x.t, +x.norm.toFixed(3)]) };
  }).sort((a, b) => b.n - a.n || a.sector.localeCompare(b.sector));
  const cvals = cohorts.filter(c => !c.thin).map(c => c.posBreadth), dispersion = cvals.length > 1 ? Math.sqrt(mean(cvals.map(x => (x - mean(cvals)) ** 2))) : null;
  if (log) log(`zone gamma (${hasAlpaca() ? "alpaca" : "cboe"}): ${names.length} names ok, ${fails.length} skipped ${JSON.stringify(reasons)}`);
  const d7 = back(7) != null ? br - back(7) : null;
  return { day, source: hasAlpaca() ? "alpaca" : "cboe", spy, qqq, breadth: br, names: stocks.length, missing: fails.length, skipped: fails,
           d1: back(1) != null ? br - back(1) : null, d3: back(3) != null ? br - back(3) : null, d7, d10: back(10) != null ? br - back(10) : null,
           pctile: pctRank(bvals, br), historyDays: series.length, series: series.slice(-60), leg: legs(series), cohorts, dispersion,
           spyPrev: back(1) != null ? series[series.length - 2][2] : null,
           tide: back(1) == null ? "BUILDING" : (d7 ?? (br - back(1))) <= -3 ? "FALLING" : (d7 ?? (br - back(1))) >= 3 ? "RISING" : "FLAT",
           levels: names.map(n => n.t) };
}

// ---------- economic calendar (rule-based: weekly claims, first-Friday payrolls) ----------
function econ() {
  const ny = nyNow(), today = new Date(ny.day + "T12:00:00Z"), out = [];
  const add = (d, name, time) => out.push({ date: d.toISOString().slice(0, 10), name, time });
  const holidayThu = d => { const m = d.getUTCMonth(), dd = d.getUTCDate(); return (m === 10 && dd >= 22 && dd <= 28) || (m === 11 && dd === 25) || (m === 0 && dd === 1); };   // Thanksgiving, Christmas, New Year
  for (let k = -1; k < 21; k++) { const d = new Date(today.getTime() + k * 864e5); if (d.getUTCDay() !== 4) continue;
    const rel = holidayThu(d) ? new Date(d.getTime() - 864e5) : d; if (rel >= today) add(rel, "Jobless claims" + (rel !== d ? " (moved for the holiday)" : ""), "8:30 AM ET"); }
  for (let m = 0; m < 2; m++) {
    const f = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + m, 1, 12));
    while (f.getUTCDay() !== 5) f.setUTCDate(f.getUTCDate() + 1);
    if (f >= today) add(f, "Nonfarm payrolls (usually first Friday; confirm on bls.gov)", "8:30 AM ET");
  }
  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5).map(e => ({ ...e, inDays: Math.round((Date.parse(e.date + "T12:00:00Z") - today) / 864e5) }));
}

// ---------- regime dial ----------
function dial(c, b, g) {
  const parts = [];
  if (b) { parts.push(["SPY above 20-day EMA", b.spyAboveEma20]); parts.push(["SPY above 200-day", b.spyAbove200]); parts.push(["Breadth broadening (RSP/SPY)", b.state === "BROADENING"]); }
  if (c) parts.push(["Credit not under stress", c.state === "CALM" || c.state === "EASING"]);
  if (g) { parts.push(["SPY dealers long gamma", g.spy.norm > 0]); parts.push(["+GEX breadth ≥ 50%", g.breadth >= 50]); }
  const score = parts.filter(p => p[1]).length, max = parts.length;
  const label = !max ? "UNKNOWN" : score >= Math.ceil(max * 0.67) ? "BULL" : score <= Math.floor(max * 0.34) ? "BEAR" : "NEUTRAL";
  return { label, score, max, parts };
}

// ---------- swing-low check (conditions as printed on your Zone Monitor) ----------
function swing(b, g) {
  if (!b || !b.qqq) return null;
  const q = b.qqq, need = [];
  if (!g || !(g.breadth >= 34)) need.push(["+GEX breadth", g ? g.breadth : null, "≥ 34%"]);
  if (!g || !(g.spy.norm > 0)) need.push(["SPY gamma", g ? g.spy.norm : null, "above 0"]);
  if (b.lowToday) need.push(["today is the low", null, ""]);
  return { confirmed: q.fromHigh <= -3 && !need.length, inPullback: q.fromHigh <= -3, ...q, asOf: b.asOf, missing: need };
}

// ---------- cache + scheduling ----------
const cache = { credit: null, breadth: null, gamma: null, at: {}, err: {} }, TTL = { credit: 6 * 3600e3, breadth: 15 * 60e3, gamma: (hasAlpaca() ? 15 : 60) * 60e3 };
const running = {};
async function refresh(key, fn, log) {
  if (running[key]) return running[key];
  running[key] = (async () => { try { cache[key] = await fn(log); cache.at[key] = Date.now(); cache.err[key] = null; store.saveCache(key, cache[key], cache.at[key]).catch(e => log && log("zone cache save failed: " + e.message)); } catch (e) { cache.err[key] = e.message; if (log) log(`zone ${key}: ${e.message}`); } finally { running[key] = null; } })();
  return running[key];
}
async function start(log) {
  // restore the last saved readings and day history first, so a restarted server shows data immediately
  try {
    history = await store.loadHistory();
    const saved = await store.loadCache();
    for (const k of ["credit", "breadth", "gamma"]) if (saved[k]) { cache[k] = saved[k].data; cache.at[k] = saved[k].at; }
    if (saved.levels && saved.levels.data) levels = saved.levels.data;
    if (log) log(`zone store: ${store.mode()} · ${Object.keys(history).length} days of history · restored ${Object.keys(saved).join(", ") || "nothing"}`);
  } catch (e) { if (log) log("zone store unavailable, using memory only: " + e.message); }
  const tick = () => { for (const [k, fn] of [["credit", credit], ["breadth", breadth], ["gamma", gamma]]) if (!cache.at[k] || Date.now() - cache.at[k] > TTL[k]) refresh(k, fn, log); };
  tick(); setInterval(tick, 60e3).unref();
}
function snapshot() {
  const c = cache.credit, b = cache.breadth, g = cache.gamma;
  const L = levels.today ? Object.keys(levels.today.names).sort().map(t => ({ t, sector: sectorOf(t), now: levels.today.names[t], base: levels.base && levels.base.names[t] || null })) : [];
  return { updatedAt: new Date().toISOString(), ny: nyNow(), credit: c, breadth: b, gamma: g, econ: econ(), dial: dial(c, b, g), swing: swing(b, g),
           levels: { day: levels.today && levels.today.day, at: levels.today && levels.today.at, baseDay: levels.base && levels.base.day, rows: L }, dataSource: hasAlpaca() ? "alpaca" : "free",
           store: store.mode(), ages: Object.fromEntries(Object.entries(cache.at).map(([k, v]) => [k, v ? Math.round((Date.now() - v) / 1000) : null])), errors: cache.err,
           loading: Object.fromEntries(["credit", "breadth", "gamma"].map(k => [k, !!running[k]])) };
}
module.exports = { start, snapshot, _test: { credit, breadth, gamma, gexFor, legs, swing, bsGamma, parseOcc, dial, econ } };
