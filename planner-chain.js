// Option chain for the Structure Planner: any ticker, any listed expiration, bid / ask / IV per strike.
// Alpaca (when ALPACA_KEY_ID / ALPACA_SECRET_KEY are set) first, then Nasdaq, then Yahoo. Read only.
"use strict";
const K = require("./keyless");
const ALP = { key: process.env.ALPACA_KEY_ID || "", secret: process.env.ALPACA_SECRET_KEY || "",
  data: process.env.ALPACA_DATA_URL || "https://data.alpaca.markets", trade: process.env.ALPACA_TRADING_URL || "https://paper-api.alpaca.markets" };
const cache = new Map();
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const closeMs = d => Date.parse(d + "T21:00:00Z");
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function labelDay(label) {     // "November 27, 2026" / "Nov 27" → YYYY-MM-DD
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?/.exec(String(label || "")); if (!m || MON[m[1].toLowerCase()] == null) return null;
  const now = new Date(); let y = m[3] ? +m[3] : now.getUTCFullYear(), ms = Date.UTC(y, MON[m[1].toLowerCase()], +m[2], 12);
  if (!m[3] && ms < Date.now() - 2 * 864e5) ms = Date.UTC(y + 1, MON[m[1].toLowerCase()], +m[2], 12); return iso(ms);
}
async function alp(base, path) {
  const r = await fetch(base + path, { headers: { "APCA-API-KEY-ID": ALP.key, "APCA-API-SECRET-KEY": ALP.secret, accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error("Alpaca HTTP " + r.status); return r.json();
}
const occ = s => { const m = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(s); return m && { exp: `20${m[2]}-${m[3]}-${m[4]}`, cp: m[5], K: +m[6] / 1000 }; };

async function fromAlpaca(sym, want) {
  const today = iso(Date.now()), exps = new Set(); let tok = "";
  do { const j = await alp(ALP.trade, `/v2/options/contracts?underlying_symbols=${sym}&status=active&expiration_date_gte=${today}&limit=10000${tok ? "&page_token=" + tok : ""}`);
    for (const c of j.option_contracts || []) exps.add(c.expiration_date); tok = j.next_page_token || ""; } while (tok);
  const expiries = [...exps].sort(); if (!expiries.length) throw new Error("no listed options");
  const expiry = want && exps.has(want) ? want : expiries[0], calls = [], puts = []; tok = "";
  do { const j = await alp(ALP.data, `/v1beta1/options/snapshots/${sym}?feed=indicative&limit=1000&expiration_date=${expiry}${tok ? "&page_token=" + tok : ""}`);
    for (const [s, x] of Object.entries(j.snapshots || {})) { const p = occ(s); if (!p) continue; const q = x.latestQuote || {};
      (p.cp === "C" ? calls : puts).push({ strike: p.K, bid: +q.bp || null, ask: +q.ap || null, last: x.latestTrade ? +x.latestTrade.p : null, iv: +x.impliedVolatility || null, oi: null }); }
    tok = j.next_page_token || ""; } while (tok);
  const t = await alp(ALP.data, `/v2/stocks/${sym}/trades/latest?feed=iex`), spot = +(t.trade && t.trade.p);
  if (!(spot > 0)) throw new Error("no spot");
  return { symbol: sym, spot, expiry, expiries, calls, puts, source: "Alpaca (indicative options, IEX spot)" };
}
function nasdaqRows(sym, j) {
  const d = j && j.data, spotM = /\$([0-9][0-9,.]*)/.exec(String(d && d.lastTrade || "")), spot = spotM ? K._num(spotM[1]) : null, by = new Map(); let group = null;
  for (const r of (d && d.table && d.table.rows) || []) {
    if (r.expirygroup) group = labelDay(r.expirygroup);
    const day = labelDay(r.expiryDate) || group; if (!day || !(K._num(r.strike) > 0)) continue;
    const b = by.get(day) || { calls: [], puts: [] }, Kx = K._num(r.strike);
    b.calls.push({ strike: Kx, bid: K._num(r.c_Bid), ask: K._num(r.c_Ask), last: K._num(r.c_Last), oi: K._num(r.c_Openinterest) });
    b.puts.push({ strike: Kx, bid: K._num(r.p_Bid), ask: K._num(r.p_Ask), last: K._num(r.p_Last), oi: K._num(r.p_Openinterest) });
    by.set(day, b);
  }
  return { spot, by };
}
async function fromNasdaq(sym, want) {
  let last;
  for (const a of K._assetClasses(sym)) {
    try {
      const base = `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/option-chain?assetclass=${a}`;
      const j = await K._fetchJson(`${base}&limit=500&offset=0&fromdate=all&todate=undefined&excode=oprac&callput=callput&money=all&type=all`, 25000, { Accept: "application/json" });
      let { spot, by } = nasdaqRows(sym, j);
      const expiries = [...by.keys()].filter(d => d >= iso(Date.now() - 864e5)).sort(); if (!(spot > 0) || !expiries.length) { last = new Error(a + " chain empty"); continue; }
      let expiry = want && by.has(want) ? want : expiries[0];
      if (want && !by.has(want)) { const j2 = await K._fetchJson(`${base}&limit=500&offset=0&fromdate=${want}&todate=${want}&excode=oprac&callput=callput&money=all&type=all`, 25000, { Accept: "application/json" });
        const r2 = nasdaqRows(sym, j2); if (r2.by.has(want)) { by = r2.by; expiry = want; } }
      const b = by.get(expiry), T = Math.max((closeMs(expiry) - Date.now()) / 365 / 864e5, 1 / 365);
      const fix = cp => r => K._withIv(r, spot, closeMs(expiry), cp);
      return { symbol: sym, spot, expiry, expiries, calls: b.calls.filter(r => r.bid || r.ask || r.last).map(fix("C")), puts: b.puts.filter(r => r.bid || r.ask || r.last).map(fix("P")), source: "Nasdaq option chain", T };
    } catch (e) { last = e; }
  }
  throw last || new Error("Nasdaq chain empty");
}
async function fromYahoo(sym, want) {
  const c = await K._yahooCrumb(), url = d => `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(sym)}?crumb=${encodeURIComponent(c.crumb)}${d ? "&date=" + d : ""}`;
  let j = await K._fetchJson(url(), 25000, { Cookie: c.cookie }), r = j.optionChain.result[0];
  const expiries = (r.expirationDates || []).map(s => iso(s * 1000)), pick = want && expiries.includes(want) ? want : expiries[0];
  if (pick !== expiries[0]) { j = await K._fetchJson(url(Date.parse(pick + "T00:00:00Z") / 1000), 25000, { Cookie: c.cookie }); r = j.optionChain.result[0]; }
  const blk = r.options[0], map = x => ({ strike: K._num(x.strike), bid: K._num(x.bid), ask: K._num(x.ask), last: K._num(x.lastPrice), iv: K._num(x.impliedVolatility), oi: K._num(x.openInterest) });
  const spot = K._num(r.quote.regularMarketPrice); if (!(spot > 0)) throw new Error("no spot");
  return { symbol: sym, spot, expiry: pick, expiries, calls: blk.calls.map(map), puts: blk.puts.map(map), source: "Yahoo options v7" };
}
async function chain(symbol, expiry) {
  const sym = String(symbol || "").trim().toUpperCase(); if (!/^[A-Z.]{1,6}$/.test(sym)) throw new Error("Enter a ticker like HOOD");
  const want = /^\d{4}-\d{2}-\d{2}$/.test(expiry || "") ? expiry : null, key = sym + "|" + (want || ""), hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60e3) return hit.v;
  const errs = [];
  for (const [name, fn] of [["alpaca", ALP.key && ALP.secret ? fromAlpaca : null], ["nasdaq", fromNasdaq], ["yahoo", fromYahoo]]) {
    if (!fn) continue;
    try { const v = await fn(sym, want); v.calls.sort((a, b) => a.strike - b.strike); v.puts.sort((a, b) => a.strike - b.strike); v.at = new Date().toISOString(); cache.set(key, { at: Date.now(), v }); return v; }
    catch (e) { errs.push(name + ": " + e.message); }
  }
  throw new Error(sym + " chain unavailable (" + errs.join("; ") + ")");
}
module.exports = { chain, _labelDay: labelDay, _nasdaqRows: nasdaqRows };
