// Zone Monitor data engine — free sources only, no API keys.
//   Credit regime : FRED (ICE BofA HY & IG option-adjusted spreads, HY effective yield, 10-year Treasury)
//   Breadth       : RSP / SPY ratio (equal-weight vs cap-weight S&P 500) from Yahoo, Stooq as backup
//   Gamma (GEX)   : Cboe public delayed option chains (≈15 min delayed): net dealer gamma per name, SPY gamma flip,
//                   +GEX breadth across the stock-perp universe, history kept per trading day
//   Regime dial   : combines trend, credit, breadth and gamma. Context only — never a trading rule.
"use strict";
const fs = require("fs");

const SRC = {
  fred: process.env.FRED_BASE || "https://fred.stlouisfed.org/graph/fredgraph.csv?id=",
  yahoo: process.env.YAHOO_BASE || "https://query1.finance.yahoo.com/v8/finance/chart/",
  stooq: process.env.STOOQ_BASE || "https://stooq.com/q/d/l/?i=d&s=",
  cboe: process.env.CBOE_BASE || "https://cdn-api.cboe.com/api/global/delayed_quotes/options/",
  cboeHist: process.env.CBOE_HIST || "https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/",
  hl: process.env.HL_API || "https://api.hyperliquid.xyz/info",
};
const HIST_FILE = process.env.ZONE_HISTORY || "/tmp/zone-history.json";
const UA = { "User-Agent": "Mozilla/5.0 (QuantSignal Zone Monitor)" };

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
  const state = (d20 >= 25 || pctRank(d5hist, d5) >= 85) ? "FEAR" : (d20 >= 10 || d5 >= 8) ? "WATCH" : (d20 <= -15) ? "EASING" : "CALM";
  const week = d5 >= 10 ? "FEAR" : d5 >= 4 ? "WATCH" : "CALM", month = d20 >= 25 ? "FEAR" : d20 >= 10 ? "WATCH" : "CALM";
  return { asOf: hy.at(-1).d, hy: last, line, vsLineBp: Math.round((last - line) * 100), peak90: hi90, peakDay: hiDay, atHighs: last >= hi90 - 0.02,
           d5, d20, d60, d5pct: pctRank(d5hist, d5), ig: ig ? ig.at(-1).v : null, igD60: bp(ig, 60), t10: t10 ? t10.at(-1).v : null, t10d20, t10d60,
           hyYield: hyy ? hyy.at(-1).v : null, hyYieldD60: bp(hyy, 60), driver, state, week, month,
           trend: d5 > 2 ? "widening" : d5 < -2 ? "tightening" : "flat" };
}

// ---------- daily prices (Yahoo, Stooq backup) ----------
const why = e => (e && (e.cause && (e.cause.code || e.cause.message)) || e.message || String(e));
async function daily(sym, log) {
  const tried = [];
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
  return { asOf: spy.at(-1).d, ratio: rv.at(-1), ratioEma50: e50, aboveEma50: rv.at(-1) > e50, d10: chg(10), d20: chg(20), state,
           spy: s.at(-1), spy10, spyAboveEma20: s.at(-1) > e20, spyEma20: e20, spyAbove200: s.at(-1) > sma200, spy5: (s.at(-1) / at(s, 5) - 1) * 100,
           qqq: { last: q.at(-1), high: hi, highDay: hiDay, low: lo, lowDay: loDay, fromHigh: fromHi, bounce },
           history: ratio.slice(-120).map(x => [x.d, +x.v.toFixed(5)]) };
}

// ---------- gamma (Cboe) ----------
const nPdf = x => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
function bsGamma(S, K, T, iv) { if (!(S > 0 && K > 0 && T > 0 && iv > 0)) return 0; const d1 = (Math.log(S / K) + (0.04 + iv * iv / 2) * T) / (iv * Math.sqrt(T)); return nPdf(d1) / (S * iv * Math.sqrt(T)); }
function parseOcc(sym) { const m = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(sym || "")); if (!m) return null; return { exp: Date.UTC(2000 + +m[2], +m[3] - 1, +m[4], 21), cp: m[5], K: +m[6] / 1000 }; }
// net dealer gamma ($ per 1% move), naive convention: dealers long calls / short puts
async function gexFor(t, withFlip = false) {
  const j = await get(SRC.cboe + encodeURIComponent(t) + ".json?_=" + Date.now(), "json", 30000);
  const d = j && j.data; if (!d || !Array.isArray(d.options)) throw new Error("no chain");
  const S = Number(d.current_price || d.close || d.prev_day_close), now = Date.now(); if (!(S > 0)) throw new Error("no price");
  let call = 0, put = 0; const legs = withFlip ? [] : null;
  for (const o of d.options) {
    const p = parseOcc(o.option), oi = Number(o.open_interest || 0); if (!p || p.exp < now || !(oi > 0)) continue;
    const g = Number(o.gamma); if (!Number.isFinite(g) || g <= 0) continue;
    const dollar = g * oi * 100 * S * S * 0.01;
    if (p.cp === "C") call += dollar; else put += dollar;
    if (legs && p.exp - now < 60 * 864e5 && Number(o.iv) > 0) legs.push([p.cp === "C" ? 1 : -1, p.K, Math.max((p.exp - now) / 365 / 864e5, 1 / 365), Number(o.iv), oi]);
  }
  const net = call - put, gross = call + put; if (!(gross > 0)) throw new Error("no open interest");
  const out = { t, spot: S, net, norm: net / gross, call, put, quoteTime: j.timestamp || null };
  if (legs && legs.length) {               // gamma flip: spot where net gamma changes sign (±12% grid)
    const netAt = x => legs.reduce((s, [sg, K, T, iv, oi]) => s + sg * bsGamma(x, K, T, iv) * oi * 100 * x * x * 0.01, 0);
    let prev = null, flip = null;
    for (let k = -48; k <= 48; k++) { const x = S * (1 + k * 0.0025), v = netAt(x); if (prev && Math.sign(v) !== Math.sign(prev.v)) { const f = prev.x + (x - prev.x) * (-prev.v) / (v - prev.v); if (flip == null || Math.abs(f - S) < Math.abs(flip - S)) flip = f; } prev = { x, v }; }
    out.flip = flip; out.netAtSpot = netAt(S);
  }
  return out;
}

// sector map for the Hyperliquid stock-perp universe (unknown names go to "Other")
const SECTOR = {
  "AI & Semiconductors": "NVDA AMD AVGO TSM MU INTC QCOM ARM MRVL SMCI AMAT LRCX KLAC ASML SNDK WDC STX ALAB CRDO COHR AAOI AXTI MPWR ON TXN ADI NXPI SKHY SOXL",
  "Software & Cloud": "MSFT ORCL CRM ADBE NOW SNOW PLTR CRWD PANW NET DDOG MDB SHOP INTU WDAY TEAM ZS OKTA NBIS CRWV IREN CORZ APP U RBLX",
  "Internet & Media": "GOOGL GOOG META AMZN NFLX BABA PDD UBER LYFT ABNB DASH SPOT RDDT PINS SNAP JD BIDU DIS",
  "Consumer & Retail": "AAPL TSLA COST WMT NKE SBUX MCD HD LOW TGT LULU CMG KO PEP PG DKNG HIMS RIVN LCID F GM",
  "Crypto & Fintech": "COIN HOOD MSTR CRCL SOFI PYPL SQ XYZ AFRM UPST BMNR MARA RIOT CLSK BITF HUT GLXY CIFR BNC",
  "Banks & Finance": "JPM BAC C WFC GS MS SCHW BLK V MA AXP COF",
  "Healthcare & Biotech": "LLY NVO UNH JNJ PFE MRK ABBV AMGN MRNA ISRG TMDX",
  "Energy & Industrials": "XOM CVX OXY BA GE CAT DE LMT RTX NOC GD KTOS AVAV RKLB ASTS LUNR JOBY ACHR SPCX VST CEG OKLO SMR NNE CCJ LEU UUUU USAR MP",
  "ETFs & Index": "SPY QQQ IWM DIA TQQQ SQQQ SOXS UVXY TLT GLD SLV EWY EWJ FXI KWEB MAGS SMH XLE XLF ARKK",
};
const sectorOf = (() => { const m = new Map(); for (const [s, list] of Object.entries(SECTOR)) for (const t of list.split(" ")) m.set(t, s); return t => m.get(t) || "Other"; })();

async function universe() {
  try {
    const r = await fetch(SRC.hl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs", dex: "xyz" }), signal: AbortSignal.timeout(15000) });
    const [meta, ctx] = await r.json();
    return meta.universe.map((u, i) => ({ t: String(u.name).split(":").pop(), mark: Number(ctx[i]?.markPx), prev: Number(ctx[i]?.prevDayPx), delisted: u.isDelisted }))
      .filter(x => !x.delisted && /^[A-Z]{1,5}$/.test(x.t));
  } catch { return Object.values(SECTOR).join(" ").split(" ").map(t => ({ t })); }
}

let history = (() => { try { return JSON.parse(fs.readFileSync(HIST_FILE, "utf8")); } catch { return {}; } })();   // day -> {breadth, spyNorm, n}
const saveHist = () => { try { fs.writeFileSync(HIST_FILE, JSON.stringify(history)); } catch {} };

async function gamma(log) {
  const uni = await universe(), day = nyNow().day;
  const spy = await gexFor("SPY", true), qqq = await gexFor("QQQ", true).catch(() => null);
  const names = [], fails = []; let i = 0;
  const tickers = [...new Set(uni.map(x => x.t))].filter(t => !["SPY", "QQQ"].includes(t));
  const reasons = {}, sleep = ms => new Promise(r => setTimeout(r, ms));
  async function worker() { while (i < tickers.length) { const t = tickers[i++];
    for (let attempt = 0; attempt < 3; attempt++) {
      try { const g = await gexFor(t); const u = uni.find(x => x.t === t); names.push({ ...g, sector: sectorOf(t), chg: u && u.prev > 0 && u.mark > 0 ? (u.mark / u.prev - 1) * 100 : null }); break; }
      catch (e) { const k = e.status ? "HTTP " + e.status : why(e); if ((e.status === 429 || e.status >= 500 || !e.status) && attempt < 2) { await sleep((e.status === 429 ? 8000 : 2000) * (attempt + 1)); continue; } reasons[k] = (reasons[k] || 0) + 1; fails.push(t); break; }
    }
    await sleep(400); } }
  await worker();
  // second, slower pass for names Cboe throttled (HTTP 429)
  const throttled = fails.filter(t => !names.some(n => n.t === t)); const retry = [];
  if (reasons["HTTP 429"]) { delete reasons["HTTP 429"]; for (const t of throttled) retry.push(t); fails.length = 0; await sleep(30000);
    for (const t of retry) { try { const g = await gexFor(t); const u = uni.find(x => x.t === t); names.push({ ...g, sector: sectorOf(t), chg: u && u.prev > 0 && u.mark > 0 ? (u.mark / u.prev - 1) * 100 : null }); }
      catch (e) { const k = e.status ? "HTTP " + e.status : why(e); reasons[k] = (reasons[k] || 0) + 1; fails.push(t); } await sleep(1500); } }
  const pos = names.filter(n => n.norm > 0).length, br = names.length ? pos / names.length * 100 : null;
  history[day] = { breadth: br, spyNorm: spy.norm, n: names.length }; const days = Object.keys(history).sort(); for (const d of days.slice(0, -400)) delete history[d]; saveHist();
  const series = Object.keys(history).sort().map(d => [d, history[d].breadth, history[d].spyNorm]);
  const bvals = series.map(x => x[1]).filter(Number.isFinite), back = n => series.length > n ? series[series.length - 1 - n][1] : null;
  const cohorts = Object.entries(names.reduce((m, n) => ((m[n.sector] = m[n.sector] || []).push(n), m), {})).map(([s, a]) => ({
    sector: s, n: a.length, posBreadth: a.filter(x => x.norm > 0).length / a.length * 100, avgNorm: mean(a.map(x => x.norm)),
    medChg: median(a.map(x => x.chg).filter(Number.isFinite)), names: a.sort((x, y) => y.norm - x.norm).map(x => [x.t, +x.norm.toFixed(3)]),
  })).sort((a, b) => b.n - a.n);
  if (log) log(`zone gamma: ${names.length} names ok, ${fails.length} skipped ${JSON.stringify(reasons)}`);
  return { day, spy, qqq, breadth: br, names: names.length, missing: fails.length, d1: back(1) != null ? br - back(1) : null, d7: back(7) != null ? br - back(7) : null,
           pctile: pctRank(bvals, br), historyDays: series.length, series: series.slice(-60), cohorts,
           tide: back(1) == null ? "BUILDING" : (br - (back(5) ?? back(1))) <= -3 ? "FALLING" : (br - (back(5) ?? back(1))) >= 3 ? "RISING" : "FLAT",
           top: names.sort((a, b) => b.norm - a.norm).slice(0, 8).map(x => [x.t, +x.norm.toFixed(3)]), bottom: names.slice(-8).map(x => [x.t, +x.norm.toFixed(3)]) };
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

// ---------- cache + scheduling ----------
const cache = { credit: null, breadth: null, gamma: null, at: {}, err: {} }, TTL = { credit: 6 * 3600e3, breadth: 15 * 60e3, gamma: 60 * 60e3 };
const running = {};
async function refresh(key, fn, log) {
  if (running[key]) return running[key];
  running[key] = (async () => { try { cache[key] = await fn(log); cache.at[key] = Date.now(); cache.err[key] = null; } catch (e) { cache.err[key] = e.message; if (log) log(`zone ${key}: ${e.message}`); } finally { running[key] = null; } })();
  return running[key];
}
function start(log) {
  const tick = () => { for (const [k, fn] of [["credit", credit], ["breadth", breadth], ["gamma", gamma]]) if (!cache.at[k] || Date.now() - cache.at[k] > TTL[k]) refresh(k, fn, log); };
  tick(); setInterval(tick, 60e3).unref();
}
function snapshot() {
  const c = cache.credit, b = cache.breadth, g = cache.gamma;
  return { updatedAt: new Date().toISOString(), ny: nyNow(), credit: c, breadth: b, gamma: g, econ: econ(), dial: dial(c, b, g),
           ages: Object.fromEntries(Object.entries(cache.at).map(([k, v]) => [k, v ? Math.round((Date.now() - v) / 1000) : null])), errors: cache.err,
           loading: Object.fromEntries(["credit", "breadth", "gamma"].map(k => [k, !!running[k]])) };
}
module.exports = { start, snapshot, _test: { credit, breadth, gamma, gexFor, bsGamma, parseOcc, dial, econ } };
