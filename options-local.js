// Live option data for the Options Studio, served by this server: no keys in the browser.
// Chains come from planner-chain (Alpaca with the server's keys when set, otherwise Nasdaq / Yahoo).
// Greeks are Black-Scholes at each contract's IV (rate 4 %). Any API key sent by a browser is ignored.
"use strict";
const pc = require("./planner-chain"), PM = require("./site/planner-math.js");
const ALP = { key: process.env.ALPACA_KEY_ID || "", secret: process.env.ALPACA_SECRET_KEY || "" };
const occ = (u, exp, cp, K) => `${u}${exp.slice(2).replace(/-/g, "")}${cp}${String(Math.round(K * 1000)).padStart(8, "0")}`;
const parse = s => { const m = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(s || "")); return m && { u: m[1], exp: `20${m[2]}-${m[3]}-${m[4]}`, cp: m[5], K: +m[6] / 1000 }; };
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

function contracts(ch) {
  const T = Math.max(PM.dayDiff(today(), ch.expiry), 0.25) / 365, out = [];
  for (const [list, cp] of [[ch.calls, "C"], [ch.puts, "P"]]) for (const q of list) {
    const bid = q.bid > 0 ? q.bid : null, ask = q.ask > 0 ? q.ask : null, mid = bid != null && ask != null && ask >= bid ? (bid + ask) / 2 : (q.last > 0 ? q.last : null);
    const iv0 = q.iv > 0 ? q.iv : (mid ? PM.impliedVol(mid, cp, ch.spot, q.strike, T) : null), iv = iv0 > 0.02 && iv0 < 4.9 ? iv0 : null, g = iv ? PM.bs(cp, ch.spot, q.strike, T, iv) : null;
    out.push({ symbol: occ(ch.symbol, ch.expiry, cp, q.strike), underlying: ch.symbol, expiry: ch.expiry, type: cp === "C" ? "call" : "put", strike: q.strike,
      bid, ask, mid, last: q.last > 0 ? q.last : null, iv: iv || null, openInterest: q.oi ?? null,
      greeks: g ? { delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega } : null, quoteTime: ch.at });
  }
  return out;
}
async function chainRange(symbol, near, far) {
  const first = await pc.chain(symbol), exps = first.expiries.filter(d => (!near || d >= near) && (!far || d <= far));
  const pick = (exps.length ? exps : [first.expiry]).slice(0, 8), all = [];
  for (const d of pick) { try { const c = d === first.expiry ? first : await pc.chain(symbol, d); if (c.expiry === d) all.push(...contracts(c)); } catch {} }
  return { first, contracts: all, partial: exps.length > pick.length };
}
async function universe() {
  if (!(ALP.key && ALP.secret)) throw new Error("full catalogue needs Alpaca keys on the server — any US ticker can still be typed");
  const r = await fetch("https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity&attributes=options_enabled", { headers: { "APCA-API-KEY-ID": ALP.key, "APCA-API-SECRET-KEY": ALP.secret }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error("Alpaca HTTP " + r.status);
  return (await r.json()).map(a => ({ symbol: a.symbol, name: a.name }));
}
async function handle(body) {
  const action = body.action || "chain";
  if (action === "universe") return { assets: await universe(), source: "Alpaca assets (server keys)" };
  if (action === "legs") {
    const groups = new Map(), stocks = {}, out = [];
    for (const s of body.contracts || []) { const p = parse(s); if (p) { const k = p.u + "|" + p.exp; groups.set(k, (groups.get(k) || []).concat(p)); } }
    for (const [k, list] of groups) { const [u, exp] = k.split("|");
      try { const ch = await pc.chain(u, exp); stocks[u] = { price: ch.spot, source: ch.source, time: ch.at };
        const cs = ch.expiry === exp ? contracts(ch) : []; for (const p of list) { const c = cs.find(x => x.symbol === occ(u, exp, p.cp, p.K)); if (c) out.push(c); } } catch {} }
    return { contracts: out, stocks, fetchedAt: new Date().toISOString() };
  }
  if (action !== "chain") return null;                 // other actions (Gamma Book) are not served here
  const symbol = String(body.symbol || "").toUpperCase(), r = await chainRange(symbol, body.near, body.far);
  return { contracts: r.contracts, nextPageToken: null, partial: r.partial, label: r.first.source + " · live, refreshed by the server",
    fetchedAt: new Date().toISOString(), stock: { price: r.first.spot, source: r.first.source, time: r.first.at } };
}
function status() { return { live: true, source: ALP.key && ALP.secret ? "Alpaca (server keys)" : "Nasdaq / Yahoo (no keys needed)" }; }
module.exports = { handle, status, _contracts: contracts, _parse: parse };
