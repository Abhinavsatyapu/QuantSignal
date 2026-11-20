// Keyless market data. Alpaca and Unusual Whales are not required.
// Verified from this host: Yahoo chart v8, Yahoo options v7 (crumb), Nasdaq quote + option chain,
// Treasury.gov daily yield CSV, CNN Fear & Greed (browser User-Agent).
// FRED CSV is attempted and reported when it times out. Stooq sits behind a browser check and is not used.
"use strict";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const cache = new Map();

function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.value);
  const p = Promise.resolve().then(fn).then(value => { cache.set(key, { at: Date.now(), value }); return value; });
  return p;
}
async function text(url, ms = 20000, headers) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json,text/plain,*/*", ...headers }, redirect: "follow", signal: AbortSignal.timeout(ms) });
  const body = await r.text();
  if (!r.ok) throw new Error("HTTP " + r.status + " from " + new URL(url).host);
  if (body.trim().startsWith("<")) throw new Error("HTML from " + new URL(url).host);
  return body;
}
async function json(url, ms, headers) { return JSON.parse(await text(url, ms, headers)); }

let crumb = null, crumbAt = 0;
async function yahooCrumb() {
  if (crumb && Date.now() - crumbAt < 20 * 60e3) return crumb;
  const jar = new Map();
  const take = (res) => { const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""]; for (const c of raw) { const p = String(c).split(";")[0]; const i = p.indexOf("="); if (i > 0) jar.set(p.slice(0, i), p.slice(i + 1)); } };
  const a = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(15000) });
  take(a); await a.arrayBuffer();
  const cookie = [...jar.entries()].map(([k, v]) => k + "=" + v).join("; ");
  const b = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: cookie }, signal: AbortSignal.timeout(15000) });
  take(b);
  const c = (await b.text()).trim();
  if (!b.ok || !c || c.startsWith("<") || c.startsWith("{")) throw new Error("Yahoo crumb unavailable");
  crumb = { crumb: c, cookie: [...jar.entries()].map(([k, v]) => k + "=" + v).join("; ") };
  crumbAt = Date.now();
  return crumb;
}

async function chart(symbol, range = "2y", interval = "1d") {
  const key = "chart:" + symbol + ":" + range + ":" + interval;
  return cached(key, 5 * 60e3, async () => {
    const j = await json("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?range=" + range + "&interval=" + interval + "&includePrePost=false");
    const r = j.chart && j.chart.result && j.chart.result[0];
    if (!r || !r.timestamp) throw new Error("Yahoo chart empty for " + symbol);
    const q = r.indicators.quote[0] || {};
    const bars = r.timestamp.map((t, i) => ({
      d: new Date(t * 1000).toISOString().slice(0, 10),
      o: num(q.open && q.open[i]), h: num(q.high && q.high[i]), l: num(q.low && q.low[i]), c: num(q.close && q.close[i]), v: num(q.volume && q.volume[i]) || 0,
    })).filter(b => b.c > 0);
    const price = num(r.meta && r.meta.regularMarketPrice) || (bars.at(-1) && bars.at(-1).c);
    return { symbol, price, currency: r.meta && r.meta.currency, bars, source: "Yahoo chart v8" };
  });
}

function leg(row) {
  return {
    strike: num(row.strike), oi: num(row.openInterest) || 0, vol: num(row.volume) || 0,
    bid: num(row.bid), ask: num(row.ask), last: num(row.lastPrice), iv: num(row.impliedVolatility),
  };
}
async function options(symbol) {
  return cached("opt:" + symbol, 10 * 60e3, async () => {
    const c = await yahooCrumb();
    const j = await json("https://query1.finance.yahoo.com/v7/finance/options/" + encodeURIComponent(symbol) + "?crumb=" + encodeURIComponent(c.crumb), 25000, { Cookie: c.cookie });
    const r = j.optionChain && j.optionChain.result && j.optionChain.result[0];
    const block = r && r.options && r.options[0];
    if (!r || !block) throw new Error("Yahoo options empty for " + symbol);
    const spot = num(r.quote && (r.quote.regularMarketPrice || r.quote.preMarketPrice));
    if (!(spot > 0)) throw new Error("Yahoo options has no spot for " + symbol);
    return {
      symbol, spot, expiry: block.expirationDate ? block.expirationDate * 1000 : null,
      calls: (block.calls || []).map(leg).filter(x => x.strike > 0),
      puts: (block.puts || []).map(leg).filter(x => x.strike > 0),
      source: "Yahoo options v7 · nearest listed expiry",
    };
  });
}

async function nasdaqInfo(symbol) {
  return cached("nq:" + symbol, 5 * 60e3, async () => {
    const j = await json("https://api.nasdaq.com/api/quote/" + encodeURIComponent(symbol) + "/info?assetclass=etf", 20000, { Accept: "application/json" });
    const p = j.data && j.data.primaryData;
    if (!p) throw new Error("Nasdaq quote empty for " + symbol);
    return { symbol, last: num(String(p.lastSalePrice || "").replace(/[$,]/g, "")), change: p.percentageChange || null, source: "Nasdaq quote" };
  });
}

async function fearGreed() {
  return cached("cnn", 10 * 60e3, async () => {
    const j = await json("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", 20000, { Accept: "application/json", Referer: "https://www.cnn.com/markets/fear-and-greed" });
    const f = j.fear_and_greed;
    if (!f || !Number.isFinite(num(f.score))) throw new Error("CNN Fear & Greed payload missing a score");
    return { score: num(f.score), rating: f.rating, prevClose: num(f.previous_close), week: num(f.previous_1_week), month: num(f.previous_1_month), asOf: f.timestamp, source: "CNN Fear & Greed" };
  });
}

async function treasury() {
  return cached("ust", 6 * 3600e3, async () => {
    const body = await text("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/all/202611?type=daily_treasury_yield_curve&field_tdr_date_value=2026&page&_format=csv", 20000, { Accept: "text/csv" });
    const lines = body.trim().split(/\r?\n/).filter(Boolean);
    const head = lines[0].split(",").map(s => s.replace(/^"|"$/g, ""));
    const last = lines[1].split(",").map(s => s.replace(/^"|"$/g, ""));
    const row = Object.fromEntries(head.map((h, i) => [h, last[i]]));
    const y = k => num(row[k]);
    return { asOf: row.Date, m3: y("3 Mo"), y2: y("2 Yr"), y10: y("10 Yr"), y30: y("30 Yr"), source: "Treasury.gov daily yield curve CSV" };
  });
}

async function fred(id) {
  try {
    return await cached("fred:" + id, 6 * 3600e3, async () => {
      const body = await text("https://fred.stlouisfed.org/graph/fredgraph.csv?id=" + encodeURIComponent(id), 8000);
      const rows = body.trim().split(/\r?\n/).slice(1).map(l => l.split(",")).filter(x => x[1] && x[1] !== ".").map(x => ({ d: x[0], v: Number(x[1]) })).filter(x => Number.isFinite(x.v));
      if (rows.length < 5) throw new Error("FRED " + id + " too short");
      return { id, rows: rows.slice(-400), source: "FRED CSV" };
    });
  } catch (e) { return { id, error: e.message, source: "FRED CSV" }; }
}

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
module.exports = { chart, options, nasdaqInfo, fearGreed, treasury, fred, _cache: cache };
