// Keyless market data for hosts where Yahoo rate-limits, Stooq hangs, and Cboe returns 403.
// Nasdaq (api.nasdaq.com) is the primary quote, daily-bar, and option-chain source.
// Yahoo is the fallback, with a crumb/cookie session, a browser User-Agent, and backoff on 429.
"use strict";
const math = require("./books-math");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const ETFS = new Set("SPY QQQ IWM DIA TLT IEF HYG GLD USO UUP RSP XLB XLC XLE XLF XLI XLK XLP XLRE XLU XLV XLY".split(" "));
const cache = new Map();
const pause = new Map();
const feeds = {};
const MONTH = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

const num = v => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[$,]/g, "").trim());
  return Number.isFinite(n) ? n : null;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
function note(name, ok, detail, ms, error) {
  feeds[name] = { name, ok: !!ok, detail: detail || "", ms: ms == null ? null : Math.round(ms), error: error ? String(error.message || error) : null, at: new Date().toISOString() };
}
function assetClasses(symbol) {
  if (!symbol || symbol.startsWith("^")) return [];
  return ETFS.has(symbol) ? ["etf", "stocks"] : ["stocks", "etf"];
}

async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && hit.value && Date.now() - hit.at < ttl) return hit.value;
  if (hit && hit.inflight) return hit.inflight;
  const inflight = Promise.resolve().then(fn).then(value => {
    cache.set(key, { at: Date.now(), value });
    return value;
  }).catch(e => {
    cache.set(key, { at: hit && hit.value ? hit.at : 0, value: hit && hit.value });
    if (hit && hit.value) return hit.value;
    throw e;
  });
  cache.set(key, { at: hit && hit.at || 0, value: hit && hit.value, inflight });
  return inflight;
}

async function fetchText(url, ms = 20000, headers, tries = 3) {
  const host = new URL(url).host;
  if ((pause.get(host) || 0) > Date.now()) throw new Error("HTTP 429 backoff on " + host);
  let wait = 600, last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json,text/csv,text/plain,*/*", ...headers }, redirect: "follow", signal: AbortSignal.timeout(ms) });
      const body = await r.text();
      if (r.status === 429 || r.status === 503) {
        pause.set(host, Date.now() + wait);
        last = new Error("HTTP " + r.status + " from " + host);
        await sleep(wait);
        wait = Math.min(wait * 2, 8000);
        continue;
      }
      if (!r.ok) throw new Error("HTTP " + r.status + " from " + host);
      if (body.trim().startsWith("<")) throw new Error("HTML from " + host);
      return body;
    } catch (e) {
      last = e;
      if (i === tries - 1) break;
      await sleep(wait);
      wait = Math.min(wait * 2, 8000);
    }
  }
  throw last;
}
const fetchJson = async (url, ms, headers, tries) => JSON.parse(await fetchText(url, ms, headers, tries));

let crumb = null, crumbAt = 0;
async function yahooCrumb() {
  if (crumb && Date.now() - crumbAt < 30 * 60e3) return crumb;
  const jar = new Map();
  const take = (res) => {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
    for (const c of raw) { const p = String(c).split(";")[0]; const i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); }
  };
  const a = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(12000) });
  take(a); await a.arrayBuffer().catch(() => {});
  const cookie = [...jar.entries()].map(([k, v]) => k + "=" + v).join("; ");
  const b = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: cookie }, signal: AbortSignal.timeout(12000) });
  take(b);
  const c = (await b.text()).trim();
  if (!b.ok || !c || c.startsWith("<") || c.startsWith("{")) throw new Error("Yahoo crumb unavailable");
  crumb = { crumb: c, cookie: [...jar.entries()].map(([k, v]) => k + "=" + v).join("; ") || cookie };
  crumbAt = Date.now();
  return crumb;
}

function parseHistRows(rows) {
  const bars = [];
  for (const r of rows || []) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(r.date || ""));
    const c = num(r.close);
    if (!m || !(c > 0)) continue;
    bars.push({ d: `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`, o: num(r.open) || c, h: num(r.high) || c, l: num(r.low) || c, c, v: num(r.volume) || 0 });
  }
  bars.sort((a, b) => a.d < b.d ? -1 : 1);
  return bars;
}
function parseExpiryLabel(label, now = new Date()) {
  const m = /([A-Za-z]+)\s+(\d{1,2})(?:,?\s*(\d{4}))?/.exec(String(label || ""));
  if (!m) return null;
  const month = MONTH[m[1].slice(0, 3).toLowerCase()];
  if (month == null) return null;
  let year = m[3] ? +m[3] : now.getUTCFullYear();
  let ms = Date.UTC(year, month, +m[2], 21);
  if (!m[3] && ms < now.getTime() - 36 * 3600e3) ms = Date.UTC(year + 1, month, +m[2], 21);
  return ms;
}
function midOf(bid, ask, last) {
  const b = num(bid), a = num(ask), l = num(last);
  if (b > 0 && a > 0 && a >= b && String(ask) !== "--") return (a + b) / 2;
  if (l > 0) return l;
  return null;
}

async function nasdaqHistory(symbol) {
  const classes = assetClasses(symbol);
  if (!classes.length) throw new Error("no Nasdaq history for " + symbol);
  const to = new Date();
  const from = new Date(to.getTime() - 760 * 864e5);
  const fmt = d => d.toISOString().slice(0, 10);
  let last;
  for (const asset of classes) {
    try {
      const j = await fetchJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=${asset}&fromdate=${fmt(from)}&todate=${fmt(to)}&limit=9999`, 25000, { Accept: "application/json" });
      const bars = parseHistRows(j.data && j.data.tradesTable && j.data.tradesTable.rows);
      if (bars.length > 40) return bars;
      last = new Error(asset + " history short");
    } catch (e) { last = e; }
  }
  throw last || new Error("Nasdaq history empty");
}
async function yahooChart(symbol, range, interval) {
  const c = await yahooCrumb();
  let last;
  for (const host of ["query1", "query2"]) {
    try {
      const j = await fetchJson(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&crumb=${encodeURIComponent(c.crumb)}`, 20000, { Cookie: c.cookie });
      const r = j.chart && j.chart.result && j.chart.result[0];
      if (!r || !r.timestamp) throw new Error("empty");
      const q = r.indicators.quote[0] || {};
      const bars = r.timestamp.map((t, i) => ({
        d: new Date(t * 1000).toISOString().slice(0, 10),
        o: num(q.open && q.open[i]), h: num(q.high && q.high[i]), l: num(q.low && q.low[i]), c: num(q.close && q.close[i]), v: num(q.volume && q.volume[i]) || 0,
      })).filter(b => b.c > 0);
      const price = num(r.meta && r.meta.regularMarketPrice) || (bars.at(-1) && bars.at(-1).c);
      return { symbol, price, bars, source: "Yahoo chart v8" };
    } catch (e) { last = e; }
  }
  throw last || new Error("Yahoo chart failed");
}

// Daily history is cached 15 min; the last price is overlaid from a live quote (cached 45 s) on every call.
async function chart(symbol, range = "2y", interval = "1d") {
  const base = await chartBase(symbol, range, interval);
  if (interval !== "1d" || !base || !Array.isArray(base.bars) || !base.bars.length) return base;
  try {
    const q = await nasdaqInfo(symbol);
    if (!(q.last > 0)) return base;
    const bars = base.bars.slice(), lb = bars.at(-1);
    if (q.day && q.day > lb.d) bars.push({ d: q.day, o: q.last, h: q.last, l: q.last, c: q.last, v: 0 });
    else if (!q.day || q.day === lb.d) bars[bars.length - 1] = { ...lb, c: q.last, h: Math.max(lb.h ?? q.last, q.last), l: Math.min(lb.l ?? q.last, q.last) };
    return { ...base, price: q.last, bars, quoteAt: new Date().toISOString() };
  } catch { return base; }
}
async function chartBase(symbol, range, interval) {
  return cached("chart:" + symbol + ":" + range + ":" + interval, 15 * 60e3, async () => {
    const t0 = Date.now();
    try {
      const bars = await nasdaqHistory(symbol);
      let price = bars.at(-1).c;
      try {
        const q = await nasdaqInfo(symbol);
        if (q.last > 0) price = q.last;
        if (q.day && q.day > bars.at(-1).d && q.last > 0) bars.push({ d: q.day, o: q.last, h: q.last, l: q.last, c: q.last, v: 0 });
      } catch { /* history alone is enough */ }
      note("nasdaq-chart", true, symbol + " " + bars.length + " bars", Date.now() - t0);
      return { symbol, price, bars, source: "Nasdaq historical" };
    } catch (e) {
      note("nasdaq-chart", false, symbol, Date.now() - t0, e);
      const t1 = Date.now();
      try {
        const y = await yahooChart(symbol, range, interval);
        note("yahoo-chart", true, symbol, Date.now() - t1);
        return y;
      } catch (e2) {
        note("yahoo-chart", false, symbol, Date.now() - t1, e2);
        throw new Error(symbol + " chart: Nasdaq " + e.message + "; Yahoo " + e2.message);
      }
    }
  });
}

function withIv(row, spot, expiry, cp) {
  const T = expiry ? Math.max((expiry - Date.now()) / (365 * 864e5), 1 / 365) : null;
  const mid = midOf(row.bid, row.ask, row.last);
  const iv = row.iv > 0 ? row.iv : (mid && T ? math.impliedVol(mid, spot, row.strike, T, cp) : null);
  return { ...row, iv };
}
async function nasdaqOptions(symbol) {
  const classes = assetClasses(symbol);
  let last;
  for (const asset of classes) {
    try {
      const j = await fetchJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/option-chain?assetclass=${asset}&limit=200&offset=0&money=at`, 25000, { Accept: "application/json" });
      const data = j.data;
      const spotMatch = /\$([0-9][0-9,.]*)/.exec(String(data && data.lastTrade || ""));
      const spot = spotMatch ? num(spotMatch[1]) : null;
      const raw = ((data && data.table && data.table.rows) || []).filter(r => num(r.strike) > 0);
      if (!(spot > 0) || raw.length < 4) { last = new Error(asset + " chain thin"); continue; }
      const byExp = new Map();
      for (const r of raw) {
        const exp = parseExpiryLabel(r.expiryDate || r.expirygroup);
        if (!exp) continue;
        const call = { strike: num(r.strike), oi: num(r.c_Openinterest) || 0, vol: num(r.c_Volume) || 0, bid: num(r.c_Bid), ask: num(r.c_Ask), last: num(r.c_Last) };
        const put = { strike: num(r.strike), oi: num(r.p_Openinterest) || 0, vol: num(r.p_Volume) || 0, bid: num(r.p_Bid), ask: num(r.p_Ask), last: num(r.p_Last) };
        const bag = byExp.get(exp) || { calls: [], puts: [] };
        if (call.oi || call.vol) bag.calls.push(withIv(call, spot, exp, "C"));
        if (put.oi || put.vol) bag.puts.push(withIv(put, spot, exp, "P"));
        byExp.set(exp, bag);
      }
      const expiry = [...byExp.keys()].filter(ms => ms >= Date.now() - 36 * 3600e3).sort((a, b) => a - b)[0];
      const bag = expiry && byExp.get(expiry);
      if (!bag || bag.calls.length + bag.puts.length < 4) { last = new Error(asset + " no expiry"); continue; }
      return { symbol, spot, expiry, calls: bag.calls, puts: bag.puts, source: "Nasdaq option chain" };
    } catch (e) { last = e; }
  }
  throw last || new Error("Nasdaq options empty");
}
async function yahooOptions(symbol) {
  const c = await yahooCrumb();
  const j = await fetchJson("https://query1.finance.yahoo.com/v7/finance/options/" + encodeURIComponent(symbol) + "?crumb=" + encodeURIComponent(c.crumb), 25000, { Cookie: c.cookie });
  const r = j.optionChain && j.optionChain.result && j.optionChain.result[0];
  const block = r && r.options && r.options[0];
  if (!r || !block) throw new Error("Yahoo options empty for " + symbol);
  const spot = num(r.quote && (r.quote.regularMarketPrice || r.quote.preMarketPrice));
  if (!(spot > 0)) throw new Error("Yahoo options has no spot for " + symbol);
  const map = row => ({ strike: num(row.strike), oi: num(row.openInterest) || 0, vol: num(row.volume) || 0, bid: num(row.bid), ask: num(row.ask), last: num(row.lastPrice), iv: num(row.impliedVolatility) });
  return { symbol, spot, expiry: block.expirationDate ? block.expirationDate * 1000 : null, calls: (block.calls || []).map(map).filter(x => x.strike > 0), puts: (block.puts || []).map(map).filter(x => x.strike > 0), source: "Yahoo options v7" };
}
async function options(symbol) {
  return cached("opt:" + symbol, 3 * 60e3, async () => {
    const t0 = Date.now();
    try {
      const o = await nasdaqOptions(symbol);
      note("nasdaq-options", true, symbol + " " + (o.calls.length + o.puts.length) + " contracts", Date.now() - t0);
      return o;
    } catch (e) {
      note("nasdaq-options", false, symbol, Date.now() - t0, e);
      const t1 = Date.now();
      try {
        const y = await yahooOptions(symbol);
        note("yahoo-options", true, symbol, Date.now() - t1);
        return y;
      } catch (e2) {
        note("yahoo-options", false, symbol, Date.now() - t1, e2);
        throw new Error(symbol + " options: Nasdaq " + e.message + "; Yahoo " + e2.message);
      }
    }
  });
}

async function nasdaqInfo(symbol) {
  return cached("nq:" + symbol, 45e3, async () => {
    const t0 = Date.now();
    const classes = assetClasses(symbol);
    let last;
    for (const asset of classes.length ? classes : ["stocks"]) {
      try {
        const j = await fetchJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=${asset}`, 15000, { Accept: "application/json" });
        const p = j.data && j.data.primaryData;
        const lastSale = num(p && p.lastSalePrice);
        if (!(lastSale > 0)) throw new Error("empty");
        note("nasdaq-quote", true, symbol + " " + lastSale, Date.now() - t0);
        const stamp = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(p.lastTradeTimestamp || "");
        const mon = stamp && MONTH[stamp[1].slice(0, 3).toLowerCase()];
        const day = stamp && mon != null ? `${stamp[3]}-${String(mon + 1).padStart(2, "0")}-${String(+stamp[2]).padStart(2, "0")}` : null;
        return { symbol, last: lastSale, day, change: p.percentageChange || null, source: "Nasdaq quote" };
      } catch (e) { last = e; }
    }
    note("nasdaq-quote", false, symbol, Date.now() - t0, last);
    throw last || new Error("Nasdaq quote empty");
  });
}

async function fearGreed() {
  return cached("cnn", 15 * 60e3, async () => {
    const t0 = Date.now();
    try {
      const j = await fetchJson("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", 15000, { Accept: "application/json", Referer: "https://www.cnn.com/markets/fear-and-greed" });
      const f = j.fear_and_greed;
      if (!f || !Number.isFinite(num(f.score))) throw new Error("CNN Fear & Greed payload missing a score");
      note("cnn", true, f.rating + " " + num(f.score).toFixed(1), Date.now() - t0);
      return { score: num(f.score), rating: f.rating, prevClose: num(f.previous_close), week: num(f.previous_1_week), month: num(f.previous_1_month), asOf: f.timestamp, source: "CNN Fear & Greed" };
    } catch (e) { note("cnn", false, "", Date.now() - t0, e); throw e; }
  });
}
async function treasury() {
  return cached("ust", 6 * 3600e3, async () => {
    const t0 = Date.now();
    try {
      const body = await fetchText("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/all/202611?type=daily_treasury_yield_curve&field_tdr_date_value=2026&page&_format=csv", 20000, { Accept: "text/csv" });
      const lines = body.trim().split(/\r?\n/).filter(Boolean);
      const head = lines[0].split(",").map(s => s.replace(/^"|"$/g, ""));
      const last = lines[1].split(",").map(s => s.replace(/^"|"$/g, ""));
      const row = Object.fromEntries(head.map((h, i) => [h, last[i]]));
      note("treasury", true, row.Date, Date.now() - t0);
      return { asOf: row.Date, m3: num(row["3 Mo"]), y2: num(row["2 Yr"]), y10: num(row["10 Yr"]), y30: num(row["30 Yr"]), source: "Treasury.gov daily yield curve CSV" };
    } catch (e) { note("treasury", false, "", Date.now() - t0, e); throw e; }
  });
}
async function fred(id) {
  const t0 = Date.now();
  try {
    return await cached("fred:" + id, 6 * 3600e3, async () => {
      const body = await fetchText("https://fred.stlouisfed.org/graph/fredgraph.csv?id=" + encodeURIComponent(id), 8000);
      const rows = body.trim().split(/\r?\n/).slice(1).map(l => l.split(",")).filter(x => x[1] && x[1] !== ".").map(x => ({ d: x[0], v: Number(x[1]) })).filter(x => Number.isFinite(x.v));
      if (rows.length < 5) throw new Error("FRED " + id + " too short");
      note("fred", true, id + " " + rows.length, Date.now() - t0);
      return { id, rows: rows.slice(-400), source: "FRED CSV" };
    });
  } catch (e) { note("fred", false, id, Date.now() - t0, e); return { id, error: e.message, source: "FRED CSV" }; }
}

async function probe() {
  const jobs = [
    ["nasdaq-quote", () => nasdaqInfo("SPY")],
    ["nasdaq-chart", () => chart("SPY")],
    ["nasdaq-options", () => options("SPY")],
    ["treasury", () => treasury()],
    ["cnn", () => fearGreed()],
    ["fred", () => fred("DGS10")],
  ];
  await Promise.all(jobs.map(async ([, fn]) => { try { await fn(); } catch { /* status already recorded */ } }));
  return { at: new Date().toISOString(), feeds: Object.values(feeds) };
}
function sources() { return { at: new Date().toISOString(), feeds: Object.values(feeds) }; }

module.exports = { _fetchJson: fetchJson, _yahooCrumb: yahooCrumb, _withIv: withIv, _num: num, _assetClasses: assetClasses, chart, options, nasdaqInfo, fearGreed, treasury, fred, probe, sources, _parseHist: parseHistRows, _parseExpiry: parseExpiryLabel, _cache: cache };
