'use strict';
// Derivatives API: options chain (Alpaca, server-side keys), symbol directory, and the calculation endpoints used by
// Options Studio, Gamma Book, Live Hedge Compare, 1:2 Options + Futures, Manual Four-Leg Lab and Sheet Scenario Lab.
// Everything is computed here; nothing is forwarded to the original hosted backend.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const hl = require('./hl');
const alpaca = require('./alpaca');
const { INTERVALS } = require('./config');
for (const f of ['finance', 'indicators', 'paper-engine', 'sheet-math', 'live-hedge-engine']) require('../public/' + f + '.js');
const { Finance, Technicals, Paper, SheetMath, LiveHedge } = globalThis;
const { httpErr } = alpaca;

const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(e.status || (e instanceof TypeError ? 500 : 400)).json({ error: e.message }));
const fin = (v, name, { min = -Infinity, max = Infinity, int = false, optional = false } = {}) => {
  if ((v === '' || v == null) && optional) return null;
  if (v === '' || v == null || typeof v === 'boolean' || !Number.isFinite(Number(v))) throw httpErr(400, name + ' must be a number');
  const n = Number(v);
  if (n < min || n > max || (int && !Number.isInteger(n))) throw httpErr(400, `${name} must be ${int ? 'a whole number ' : ''}between ${min} and ${max}`);
  return n;
};
const round = (x, d) => { const f = 10 ** d; return Math.round(x * f) / f; };
const MAX_STALE_MS = 5 * 86400e3; // "allow last-close quotes" analysis mode (covers weekends/holidays)

// ------------------------------------------------------------------ optional public fallback (opt-in only)
// Provider abstraction: Alpaca when ALPACA_KEY_ID/ALPACA_SECRET_KEY are set; otherwise Cboe's public DELAYED quotes
// (cdn.cboe.com delayed_quotes JSON, ~15 min delayed in market hours; last session's close when the market is shut).
// Set OPTIONS_FALLBACK=off to disable the public fallback.
const fallbackEnabled = () => !['off', 'none', 'false', '0'].includes((process.env.OPTIONS_FALLBACK || '').toLowerCase()) && !alpaca.configured();
// Cboe prints New York local times without a zone; convert to UTC (DST aware).
function nyToUtc(local) {
  if (!local || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local)) return null;
  const guess = Date.parse(local + 'Z');
  for (const off of [4, 5]) { const t = guess + off * 3600e3; const hh = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(new Date(t)); if (Number(hh) === Number(local.slice(11, 13))) return new Date(t).toISOString(); }
  return new Date(guess + 4 * 3600e3).toISOString();
}
const cboeCache = new Map();
async function cboeRaw(t) {
  let c = cboeCache.get(t);
  if (!c || Date.now() - c.at > 60e3) {
    const r = await fetch('https://cdn.cboe.com/api/global/delayed_quotes/options/' + encodeURIComponent(t) + '.json', { headers: { 'User-Agent': 'Mozilla/5.0 QuantSignal' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (r.status === 403 || r.status === 404) throw httpErr(404, 'No listed options found for ' + t + ' (Cboe)');
    if (!r.ok) throw httpErr(502, 'Cboe delayed quotes HTTP ' + r.status);
    c = { at: Date.now(), data: await r.json(), modified: r.headers.get('last-modified') };
    cboeCache.set(t, c);
    if (cboeCache.size > 60) cboeCache.delete(cboeCache.keys().next().value);
  }
  return c;
}
async function cboeChain({ symbol, near, far }) {
  const t = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(t)) throw httpErr(400, 'Enter a valid US ticker');
  const c = await cboeRaw(t);
  const d = c.data.data || {}, qt = nyToUtc(d.last_trade_time) || (c.modified ? new Date(c.modified).toISOString() : null);
  const contracts = [];
  for (const o of d.options || []) {
    const p = alpaca.parseOcc(o.option); if (!p || p.root !== t.replace('.', '') || p.expiry < near || p.expiry > far) continue;
    const bid = Number(o.bid), ask = Number(o.ask);
    contracts.push({ symbol: o.option, underlying: t, root: p.root, expiry: p.expiry, type: p.type, strike: p.strike, multiplier: 100, bid, ask, bidSize: o.bid_size, askSize: o.ask_size,
      mid: ask > 0 && ask >= bid ? (bid + ask) / 2 : null, iv: o.iv > 0 ? o.iv : null, greeks: { delta: o.delta, gamma: o.gamma, theta: o.theta, vega: o.vega, rho: o.rho },
      quoteTime: qt, last: o.last_trade_price || null, lastTime: nyToUtc(o.last_trade_time), openInterest: o.open_interest, volume: o.volume, provider: 'Cboe delayed' });
  }
  return { provider: 'cboe', feed: 'delayed', label: 'Cboe public DELAYED quotes (~15 min; last close when the market is shut) · used because Alpaca keys are not configured', delayed: true, contracts, snapshotTime: qt, fileTime: c.modified ? new Date(c.modified).toISOString() : null,
    stock: d.current_price > 0 ? { price: d.current_price, bid: d.bid, ask: d.ask, time: qt, source: 'Cboe delayed' } : null, partial: false, nextPageToken: null, fetchedAt: new Date().toISOString() };
}
async function cboeExpiries(symbol) {
  const t = String(symbol || '').trim().toUpperCase(), c = await cboeRaw(t), d = c.data.data || {}, map = new Map();
  for (const o of d.options || []) { const p = alpaca.parseOcc(o.option); if (!p || p.root !== t.replace('.', '')) continue; const e = map.get(p.expiry) || { date: p.expiry, contracts: 0, quoted: 0 }; e.contracts++; if (o.bid > 0 && o.ask >= o.bid) e.quoted++; map.set(p.expiry, e); }
  return { provider: 'cboe', label: 'Cboe public DELAYED quotes', snapshotTime: nyToUtc(d.last_trade_time), stock: d.current_price > 0 ? { price: d.current_price, time: nyToUtc(d.last_trade_time), source: 'Cboe delayed' } : null, expiries: [...map.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}
async function getExpiries(symbol) {
  if (alpaca.configured()) return alpaca.expiries(symbol);
  if (fallbackEnabled()) return cboeExpiries(symbol);
  throw httpErr(503, alpaca.NO_KEYS);
}
function providerInfo() { return alpaca.configured() ? { provider: 'alpaca', ...alpaca.status() } : fallbackEnabled() ? { provider: 'cboe', feed: 'delayed', note: 'Alpaca keys not configured; Cboe public delayed quotes in use' } : { provider: null, note: alpaca.NO_KEYS }; }
async function getChain(body) { if (alpaca.configured()) return alpaca.chain(body); if (fallbackEnabled()) return cboeChain(body); throw httpErr(503, alpaca.NO_KEYS); }
async function getLegs(list) {
  if (alpaca.configured()) return alpaca.legs(list);
  if (!fallbackEnabled()) throw httpErr(503, alpaca.NO_KEYS);
  const roots = [...new Set(list.map(s => alpaca.parseOcc(s)?.root).filter(Boolean))], contracts = [], stocks = {};
  for (const r of roots) { const ch = await cboeChain({ symbol: r, near: '2000-01-01', far: '2100-01-01' }); contracts.push(...ch.contracts.filter(c => list.includes(c.symbol))); if (ch.stock) stocks[r] = ch.stock; }
  return { provider: 'cboe', feed: 'delayed', contracts, stocks, missing: list.filter(s => !contracts.some(c => c.symbol === s)), fetchedAt: new Date().toISOString() };
}

// ------------------------------------------------------------------ public US symbol directory (Nasdaq Trader)
let dirCache = null;
async function symbolDirectory() {
  if (dirCache && Date.now() - dirCache.at < 24 * 3600e3) return dirCache.data;
  const get = async u => { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 QuantSignal' }, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw Error('HTTP ' + r.status); return r.text(); };
  const [nas, oth] = await Promise.all([get('https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt'), get('https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt')]);
  const map = new Map();
  const parse = (txt, symCol, nameCol, etfCol, testCol) => { for (const line of txt.split('\n').slice(1)) { const c = line.split('|'); if (c.length < 5 || c[testCol] === 'Y' || /^File Creation/.test(c[0])) continue; const s = c[symCol].trim(); if (s && !map.has(s)) map.set(s, { symbol: s, name: c[nameCol].trim(), etf: c[etfCol] === 'Y', optionable: null }); } };
  parse(nas, 0, 1, 6, 3); parse(oth, 0, 1, 4, 6);
  const assets = [...map.values()].filter(a => /^[A-Z][A-Z.]{0,9}$/.test(a.symbol)).sort((a, b) => a.symbol.localeCompare(b.symbol));
  const data = { source: 'Nasdaq Trader US-listed symbol directory', verifiedOptions: false, assets };
  dirCache = { at: Date.now(), data };
  return data;
}

// ------------------------------------------------------------------ Hyperliquid helpers (US stock perps, mainnet public data)
async function perpBook(symbol) {
  const b = await hl.l2Book('mainnet', symbol);
  const bid = b.bids[0]?.px, ask = b.asks[0]?.px;
  if (!(bid > 0 && ask > 0)) throw httpErr(502, 'Live Hyperliquid order book unavailable for ' + symbol);
  return { ...b, bid, ask, mid: (bid + ask) / 2, time: b.time || Date.now() };
}
function depthPrice(levels, units) { // volume-weighted fill price for `units` against book levels
  let left = units, cost = 0;
  for (const l of levels) { const take = Math.min(left, l.sz); cost += take * l.px; left -= take; if (left <= 1e-12) break; }
  return left > 1e-9 ? null : cost / units;
}
async function perpMeta(symbol) {
  const dex = symbol.includes(':') ? symbol.split(':')[0] : '';
  const m = await hl.meta('mainnet', dex);
  return m.get(symbol) || m.get(symbol.split(':')[1]) || null;
}

// ------------------------------------------------------------------ Manual four-leg lab
function intrinsic(type, S, K) { return Math.max(type === 'call' ? S - K : K - S, 0); }
function piecewiseBounds(f, kinks, tailSlope) { // f linear between kinks (sorted, starting at the domain minimum)
  const pts = [...new Set(kinks)].sort((a, b) => a - b), vals = pts.map(f), roots = [];
  for (let i = 0; i < pts.length - 1; i++) { if (Math.abs(vals[i]) < 1e-9) roots.push(pts[i]); if (vals[i] * vals[i + 1] < 0) roots.push(pts[i] - vals[i] * (pts[i + 1] - pts[i]) / (vals[i + 1] - vals[i])); }
  const last = pts.at(-1), vl = vals.at(-1);
  if (Math.abs(vl) < 1e-9) roots.push(last);
  if (Math.abs(tailSlope) > 1e-9 && -vl / tailSlope > 0) roots.push(last - vl / tailSlope);
  const best = Math.max(...vals), worst = Math.min(...vals);
  return { maxProfit: tailSlope > 1e-9 ? null : best, maxLoss: tailSlope < -1e-9 ? null : Math.max(0, -worst), unlimitedProfit: tailSlope > 1e-9, unlimitedLoss: tailSlope < -1e-9, bestFinite: best, worstFinite: worst, breakevens: [...new Set(roots.map(r => round(r, 6)))] };
}
async function manualFourLeg(b) {
  const symbol = String(b.symbol || '').trim();
  if (!/^[a-z0-9]{1,20}:[A-Z0-9_]{1,20}$/.test(symbol)) throw httpErr(400, 'Select a stock perp');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.expiry || '') || b.expiry < new Date().toISOString().slice(0, 10)) throw httpErr(400, 'Choose an unexpired expiry date');
  if (!Array.isArray(b.legs) || b.legs.length !== 4) throw httpErr(400, 'Enter four option legs');
  const types = ['call', 'call', 'put', 'put'];
  const legs = b.legs.map((l, i) => {
    const type = l.type === 'put' ? 'put' : 'call';
    if (type !== types[i]) throw httpErr(400, 'Leg order must be call, call, put, put');
    if (!['buy', 'sell'].includes(l.side)) throw httpErr(400, `Leg ${i + 1}: choose buy or sell`);
    const strike = fin(l.strike, `Leg ${i + 1} strike`, { min: 0.01 }), qty = fin(l.qty, `Leg ${i + 1} contracts`, { min: 1, max: 10000, int: true });
    const premium = fin(l.premium, `Leg ${i + 1} premium`, { min: 0 }), delta = fin(l.delta, `Leg ${i + 1} delta`, type === 'call' ? { min: 0, max: 1 } : { min: -1, max: 0 });
    const iv = fin(l.iv, `Leg ${i + 1} IV`, { min: 0, max: 1000, optional: true });
    const sign = l.side === 'buy' ? 1 : -1;
    return { type, side: l.side, qty, strike, premium, delta, iv, positionDelta: sign * qty * 100 * delta, premiumCashFlow: -sign * qty * 100 * premium };
  });
  const basis = fin(b.basis, 'Stock minus perp basis'), commission = fin(b.commission, 'Option commission', { min: 0, max: 100 }), feePct = fin(b.feePct, 'Futures fee', { min: 0, max: 5 });
  const mode = ['neutral', 'target', 'manual'].includes(b.mode) ? b.mode : 'neutral';
  const [book, meta] = await Promise.all([perpBook(symbol), perpMeta(symbol)]);
  if (!meta) throw httpErr(400, symbol + ' is not listed on Hyperliquid');
  const optionDelta = legs.reduce((n, l) => n + l.positionDelta, 0);
  const requested = mode === 'manual' ? fin(b.qty, 'Manual futures units') : mode === 'target' ? fin(b.target, 'Target combined delta') - optionDelta : -optionDelta;
  const step = 10 ** -meta.szDecimals, futureQty = round(Math.round(requested / step) * step, meta.szDecimals);
  const futureEntry = futureQty > 0 ? book.ask : futureQty < 0 ? book.bid : book.mid, absQ = Math.abs(futureQty);
  const reference = book.mid + basis; // stock = perp + (stock − perp)
  const credit = legs.reduce((n, l) => n + l.premiumCashFlow, 0), optionEntryFees = commission * legs.reduce((n, l) => n + l.qty, 0);
  const futuresEntryFee = absQ * futureEntry * feePct / 100;
  const optionsAt = S => credit + legs.reduce((n, l) => n + (l.side === 'buy' ? 1 : -1) * l.qty * 100 * intrinsic(l.type, S, l.strike), 0);
  const perpAt = S => Math.max(0, S - basis);
  const netAt = S => { const F = perpAt(S); return optionsAt(S) + futureQty * (F - futureEntry) - optionEntryFees - futuresEntryFee - absQ * F * feePct / 100; };
  const strikes = legs.map(l => l.strike), callSlope = legs.filter(l => l.type === 'call').reduce((n, l) => n + (l.side === 'buy' ? 1 : -1) * l.qty * 100, 0);
  const optB = piecewiseBounds(S => optionsAt(S) - optionEntryFees, [0, ...strikes], callSlope);
  const comB = piecewiseBounds(netAt, [0, ...strikes, ...(basis > 0 ? [basis] : [])], callSlope + futureQty - absQ * feePct / 100);
  const grid = [0, ...Array.from({ length: 101 }, (_, i) => reference * (0.5 + i / 100)), ...strikes].filter(x => x >= 0);
  const points = [...new Set(grid)].sort((a, b) => a - b).map(S => { const F = perpAt(S), o = optionsAt(S), f = futureQty * (F - futureEntry); return { stock: S, perp: F, options: o, futures: f, gross: o + f, net: netAt(S) }; });
  const spreads = ['call', 'put'].map(type => { const p = legs.filter(l => l.type === type); return { type, netCredit: p.reduce((n, l) => n + l.premiumCashFlow, 0), paired: p.some(l => l.side === 'buy') && p.some(l => l.side === 'sell') && p[0].qty === p[1].qty && p[0].strike !== p[1].strike }; });
  const strip = x => { const { breakevens, ...rest } = x; return rest; };
  return {
    symbol, expiry: b.expiry, bookTime: book.time, reference, perpMid: book.mid, perpBid: book.bid, perpAsk: book.ask, basis, legs, spreads, credit, optionEntryFees, futuresEntryFee,
    optionDelta, requestedFutureQty: requested, futureQty, futureSide: futureQty > 0 ? 'LONG' : futureQty < 0 ? 'SHORT' : 'FLAT', futureEntry, szDecimals: meta.szDecimals,
    netDelta: optionDelta + futureQty, margin: absQ * futureEntry / 5,
    optionsBounds: strip(optB), combinedBounds: strip(comB), optionsBreakevens: optB.breakevens, combinedBreakevens: comB.breakevens, points,
    warnings: [
      'Manual premiums and Greeks are not independently verified; refresh them yourself.',
      'Top-of-book prices are references, not guaranteed fills; quantity is not validated against available depth. Check exchange minimum notional and contract units before execution.',
      'Perp price is not the stock spot price. Payoff assumes your stock-minus-perp basis stays constant.',
      'Same-expiry terminal payoff only; no early exercise, assignment, funding, liquidation, borrow or intraday stop model.',
      'Options entry commission and modeled futures entry/exit fees included; option expiry/exercise/exit costs excluded.',
      'Futures delta assumes one share-equivalent per perp unit; delta hedge changes as price and time change.',
      'No exchange orders submitted. Margin shown is a 5× estimate, not total portfolio capital or maximum loss.',
    ],
  };
}

// ------------------------------------------------------------------ Sheet scenario lab (pure arithmetic)
const SC_KEYS = [['dayUp', '1 day · upside'], ['dayDown', '1 day · downside'], ['expiryUp', 'Expiry · upside'], ['expiryDown', 'Expiry · downside']];
function sheetScenarios(b) {
  if (!['long', 'short'].includes(b.side)) throw httpErr(400, 'Choose futures long or short');
  const symbol = String(b.symbol || '').trim().slice(0, 42); if (!symbol) throw httpErr(400, 'Enter the asset / ticker');
  const entry = fin(b.entry, 'Futures entry', { min: 1e-6 }), qty = fin(b.qty, 'Futures quantity', { min: 0 }), m = fin(b.multiplier, 'Multiplier', { min: 1e-8 });
  const leverage = fin(b.leverage, 'Leverage', { min: 1, max: 100 }), step = fin(b.step, 'Quantity increment', { min: 1e-8 }), feePct = fin(b.feePct, 'Futures fee', { min: 0, max: 5 });
  const baskets = fin(b.baskets, 'Number of baskets', { min: 0, max: 100000, int: true }), basketLoss = fin(b.basketLoss, 'Basket loss', { min: 0 }), minimumNet = fin(b.minimumNet, 'Minimum net');
  const afterFees = b.optionPnlAfterFees === true, s = b.side === 'long' ? 1 : -1, fee = feePct / 100, basketCost = baskets * basketLoss, signedQty = s * qty;
  if (!Array.isArray(b.scenarios) || b.scenarios.length !== 4) throw httpErr(400, 'Enter all four scenarios');
  const sc = SC_KEYS.map(([key, label]) => {
    const x = b.scenarios.find(v => v && v.key === key); if (!x) throw httpErr(400, 'Missing scenario ' + label);
    const r = { key, label, optionPnl: fin(x.optionPnl, label + ' options P&L'), futurePrice: fin(x.futurePrice, label + ' perp price', { min: 1e-8 }), optionCosts: fin(x.optionCosts, label + ' option costs', { min: 0 }), funding: fin(x.funding, label + ' funding'), otherCosts: fin(x.otherCosts, label + ' other costs', { min: 0 }) };
    if (afterFees && r.optionCosts > 0) throw httpErr(400, 'Option P&L is marked as after fees: keep separate option costs at zero');
    return r;
  });
  const od = fin(b.optionDelta, 'Options delta', { optional: true }), td = fin(b.targetDelta, 'Target delta', { optional: true });
  if ((od == null) !== (td == null)) throw httpErr(400, 'Enter both delta fields, or neither');
  const A = r => r.optionPnl - r.optionCosts - r.funding - r.otherCosts - basketCost; // quantity-independent part
  const netFor = (r, q) => A(r) + q * m * (r.futurePrice - entry) - Math.abs(q) * m * (entry + r.futurePrice) * fee;
  const rows = sc.map(r => {
    const priceMove = r.futurePrice - entry, entryFee = qty * m * entry * fee, exitFee = qty * m * r.futurePrice * fee, futureGross = signedQty * m * priceMove;
    const totalCosts = r.optionCosts + entryFee + exitFee + r.funding + r.otherCosts + basketCost, gross = r.optionPnl + futureGross, net = gross - totalCosts;
    return { ...r, priceMove, signedQty, multiplier: m, entryFee, exitFee, futureGross, futureNet: futureGross - entryFee - exitFee - r.funding, basketCost, totalCosts, gross, net, optionNet: r.optionPnl - r.optionCosts, meetsMinimum: net >= minimumNet,
      formula: `${r.optionPnl} + (${signedQty} × ${m} × (${r.futurePrice} − ${entry})) − (${r.optionCosts}) − (${round(entryFee, 6)}) − (${round(exitFee, 6)}) − (${r.funding}) − (${r.otherCosts}) − (${basketCost}) = ${round(net, 6)}` };
  });
  const balance = (u, d) => {
    const sols = [];
    for (const sg of [1, -1]) {
      const den = m * (u.futurePrice - d.futurePrice) - sg * m * fee * (u.futurePrice - d.futurePrice);
      if (Math.abs(den) < 1e-12) continue;
      const q = (A(d) - A(u)) / den;
      if (sg > 0 ? q >= 0 : q <= 0) sols.push(q);
    }
    if (!sols.length) return { blocked: 'The two cases use the same perp price (or cannot be equalized): no balancing quantity exists.' };
    const rawQty = sols[0], q = Math.round(rawQty / step) * step, firstNet = netFor(u, q), secondNet = netFor(d, q);
    return { rawQty, signedQty: q, side: q < 0 ? 'SHORT' : 'LONG', firstNet, secondNet, minimumNet: Math.min(firstNet, secondNet), difference: firstNet - secondNet,
      formula: 'Solve options_up − costs_up + q×m×(F_up−entry) − |q|×m×(entry+F_up)×fee = the corresponding downside expression. This balances two supplied cases, not all possible outcomes.' };
  };
  const by = k => sc.find(r => r.key === k);
  const constraints = sc.map(r => ({ key: r.key, intercept: A(r), slope: s * m * (r.futurePrice - entry) - m * (entry + r.futurePrice) * fee }));
  let lo = 0, hi = Infinity, possible = true;
  for (const c of constraints) { const need = minimumNet - c.intercept; if (Math.abs(c.slope) < 1e-12) { if (need > 1e-9) possible = false; } else if (c.slope > 0) lo = Math.max(lo, need / c.slope); else hi = Math.min(hi, need / c.slope); }
  lo = Math.ceil(lo / step - 1e-9) * step; if (Number.isFinite(hi)) hi = Math.floor(hi / step + 1e-9) * step;
  if (hi < lo) possible = false;
  let delta = null;
  if (od != null) {
    const required = Math.round((td - od) / m / step) * step;
    delta = { optionsDelta: od, targetDelta: td, currentCombinedDelta: od + signedQty * m, requiredSignedQty: required, adjustmentSignedQty: required - signedQty, resultingDelta: od + required * m, assumption: 'One futures point tracks one stock dollar; verify the multiplier. This does not model changing basis, gamma, volatility or time decay.' };
  }
  const nets = rows.map(r => r.net);
  return {
    symbol, calculatedAt: Date.now(), input: { symbol, side: b.side, entry, qty, multiplier: m, leverage, step, feePct, baskets, basketLoss, minimumNet, optionPnlAfterFees: afterFees, scenarios: sc, optionDelta: od, targetDelta: td },
    signedQty, basketCost, rows, minimumObservedNet: Math.min(...nets), maximumObservedNet: Math.max(...nets), futuresNotional: qty * m * entry, estimatedInitialMargin: qty * m * entry / leverage,
    balances: { day: balance(by('dayUp'), by('dayDown')), expiry: balance(by('expiryUp'), by('expiryDown')) },
    feasible: { possible, direction: b.side, minimumQty: possible ? lo : null, maximumQty: possible && Number.isFinite(hi) ? hi : null, unboundedUpper: possible && !Number.isFinite(hi), minimumNet, constraints },
    delta,
    warnings: [
      'These are four alternative scenarios. Never add their P&Ls together.',
      'Options P&L must include entry premium, not merely the option exit value. Premium is not deducted again.',
      'One-day options P&L is supplied by you; no theta-only projection or automatic premium forecast is made.',
      'Enter perp scenario prices separately from stock option scenario prices; do not silently equate stock and perp.',
      'Sizing benchmarks hold manually entered funding and other costs fixed. Re-estimate quantity-dependent costs after changing size.',
      'Balanced quantities and scenario-feasible ranges are mathematical benchmarks, not trade recommendations or loss guarantees. Outcomes outside the four cases can be much worse.',
      'Margin is estimated. Liquidation, changing collateral, exercise/assignment and unentered costs are not modeled.',
      'All balances assume the same unchanged position from entry to each scenario. Partial exits and rehedging require separate calculations.',
    ],
  };
}

// ------------------------------------------------------------------ Historical PDF audit (78 transcribed pages)
let auditCache = null;
function sheetAudit() {
  if (auditCache) return auditCache;
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sheet-data.js'), 'utf8');
  const data = vm.runInNewContext(src + '\n;SHEET_DATA', {}, { timeout: 5000 });
  const T = 0.015, types = ['call', 'call', 'put', 'put'];
  const rows = data.map(r => {
    const issues = [], q = r.futureQty;
    const legs = r.strikes.map((k, i) => ({ type: types[i], side: r.units[i] > 0 ? 'buy' : 'sell', strike: k, units: r.units[i], contracts: Math.abs(r.units[i]) / 100, premium: r.premiums[i] ?? null, entryCash: r.premiums[i] == null ? null : -r.units[i] * r.premiums[i] }));
    const o = r.printedOptions;
    const nets = Array.isArray(o) && o.length === 4 ? [o[0] + q * r.up - r.mmLoss, o[1] + q * r.up - r.mmLoss, o[2] - q * r.down - r.mmLoss, o[3] - q * r.down - r.mmLoss] : null;
    const netDifferences = nets && r.printedNet ? nets.map((v, i) => round(v - r.printedNet[i], 6)) : null;
    if (netDifferences && netDifferences.some(d => Math.abs(d) > T)) issues.push('Printed net totals do not reproduce from transcribed option P&L, signed futures quantity, moves and basket loss.');
    let expiry = null;
    if (legs.some(l => l.premium == null)) issues.push('Individual premiums are unreadable or shown only as spread prices; exact leg audit blocked.');
    else {
      const at = S => legs.reduce((n, l) => n + l.units * (intrinsic(l.type, S, l.strike) - l.premium), 0);
      const computed = [at(r.futureEntry + r.up), at(r.futureEntry - r.down)].map(v => round(v, 6)), printed = [o[1], o[3]];
      expiry = { computed, printed, differences: computed.map((v, i) => round(v - printed[i], 6)) };
      if (expiry.differences.some(d => Math.abs(d) > T)) issues.push('Expiry intrinsic-value P&L differs under the assumption stock and perp move together by the printed distances.');
    }
    if (r.notes) issues.push(r.notes);
    const dayQty = r.up + r.down > 0 ? (o[2] - o[0]) / (r.up + r.down) : null;
    return { page: r.page, symbol: r.symbol, confidence: r.confidence, sourceInputs: { futureEntry: r.futureEntry, futureQty: q, up: r.up, down: r.down, mmLoss: r.mmLoss, strikes: r.strikes, units: r.units, premiums: r.premiums },
      sourceScenarioOptions: o, printedNet: r.printedNet, closedSummary: r.closedSummary || null, legs, issues, nets, netDifferences, expiry,
      balances: dayQty == null ? null : { dayQty, recordedQty: q, quantityDifference: q - dayQty }, status: issues.length ? 'REVIEW' : 'REPRODUCES',
      formula: 'Net = supplied options P&L + signed future units × scenario move − basket loss. No fee/funding data is provided here.' };
  });
  auditCache = { source: '78-page scanned PDF transcription; not original workbook formulas', sizingNote: 'Scenario equalization is a reconstruction benchmark. The PDF does not contain Greeks or a visible sizing formula; original quantities cannot be proven delta-derived.', rows };
  return auditCache;
}

// ------------------------------------------------------------------ Current position P&L (sheet lab)
async function positionPnl(b) {
  const symbol = String(b.symbol || '').trim();
  const src = b.priceSource === 'manual' ? 'manual' : 'hyperliquid', opt = ['pnl', 'manualLegs', 'alpaca'].includes(b.optionSource) ? b.optionSource : 'pnl';
  if (src === 'hyperliquid' && !/^[a-z0-9]{1,20}:[A-Z0-9_]{1,20}$/.test(symbol)) throw httpErr(400, 'Enter the exact Hyperliquid market symbol, for example xyz:CRCL.');
  const entry = fin(b.entry, 'Futures entry', { min: 1e-8 }), signedQty = fin(b.signedQty, 'Signed futures quantity'), m = fin(b.multiplier, 'Units per perp', { min: 1e-8 });
  if (signedQty === 0) throw httpErr(400, 'Enter a non-zero signed OPEN futures quantity');
  const futuresFees = fin(b.futuresFees, 'Futures fees', { min: 0 }), optionCosts = fin(b.optionCosts, 'Option costs', { min: 0 }), funding = fin(b.funding, 'Funding'), otherCosts = fin(b.otherCosts, 'Other costs', { min: 0 });
  const warnings = ['Open-position valuation / estimated close P&L, not confirmed realized P&L. No orders submitted.', 'Options P&L includes entry premiums once. Delta is a sensitivity, not a dollar P&L calculation.', 'Fees, funding and other costs are only included as entered; zero means excluded.', 'Perp and stock option prices come from separate markets; no identical-price or fixed-basis assumption is used.'];
  let currentPrice, quote = null;
  if (src === 'manual') currentPrice = fin(b.currentPrice, 'Current / exit futures price', { min: 1e-8 });
  else {
    const book = await perpBook(symbol), units = Math.abs(signedQty) * m, closeBuy = signedQty < 0;
    const px = depthPrice(closeBuy ? book.asks : book.bids, units);
    if (px == null) throw httpErr(400, 'Visible Hyperliquid depth is smaller than your position; enter a manual exit price.');
    currentPrice = px;
    quote = { currentPrice: px, bid: book.bid, ask: book.ask, mid: book.mid, quoteTime: new Date(book.time).toISOString(), source: 'Hyperliquid live L2 · depth-weighted ' + (closeBuy ? 'ask (buy to close)' : 'bid (sell to close)') };
  }
  let optionPnl = 0, legs = [];
  if (opt === 'pnl') {
    optionPnl = fin(b.optionPnl, 'Options book P&L');
    if (b.optionPnlAfterFees === true && optionCosts > 0) throw httpErr(400, 'Option P&L is marked as after fees: keep separate option costs at zero');
  } else {
    if (!Array.isArray(b.legs) || b.legs.length !== 4) throw httpErr(400, 'Enter four option legs');
    let quotes = null;
    if (opt === 'alpaca') {
      const occ = b.legs.map((l, i) => { const s = String(l.symbol || '').replace(/\s+/g, '').toUpperCase(); if (!alpaca.parseOcc(s)) throw httpErr(400, `Leg ${i + 1}: enter the exact OCC symbol, e.g. AAPL261120C00250000`); return s; });
      quotes = await getLegs(occ);
    }
    legs = b.legs.map((l, i) => {
      const side = l.side === 'sell' ? 'sell' : 'buy', sign = side === 'buy' ? 1 : -1;
      const contracts = fin(l.contracts, `Leg ${i + 1} contracts`, { min: 1, int: true }), mult = fin(l.multiplier, `Leg ${i + 1} multiplier`, { min: 1, int: true }), ent = fin(l.entry, `Leg ${i + 1} entry premium`, { min: 0 });
      let close, quoteTime = null, bid = null, ask = null; const sym = String(l.symbol || '').trim();
      if (opt === 'alpaca') {
        const q = quotes.contracts.find(c => c.symbol === sym.replace(/\s+/g, '').toUpperCase());
        if (!q) throw httpErr(502, `Leg ${i + 1}: no quote returned for ${sym}`);
        if (mult !== 100) throw httpErr(400, 'Live mode supports standard 100-share contracts only');
        bid = q.bid; ask = q.ask; quoteTime = q.quoteTime; close = side === 'buy' ? q.bid : q.ask;
        if (!(close >= 0) || close == null) throw httpErr(502, `Leg ${i + 1}: ${side === 'buy' ? 'bid' : 'ask'} unavailable`);
      } else close = fin(l.close, `Leg ${i + 1} close premium`, { min: 0 });
      const entryCash = -sign * contracts * mult * ent, closingCash = sign * contracts * mult * close;
      return { side, contracts, multiplier: mult, entry: ent, symbol: sym, close, quoteTime, bid, ask, signedContracts: sign * contracts, entryCash, closingCash, pnl: entryCash + closingCash };
    });
    optionPnl = legs.reduce((n, l) => n + l.pnl, 0);
    warnings.push(opt === 'alpaca' ? `Option closes use ${quotes.provider === 'alpaca' ? 'Alpaca ' + quotes.feed.toUpperCase() : 'delayed fallback'} bid (long) / ask (short); check quote times.` : 'Manual closing premiums are used as entered; their freshness and execution size are not verified.');
  }
  const futureGross = signedQty * m * (currentPrice - entry), costs = futuresFees + optionCosts + funding + otherCosts;
  return { symbol, signedQty, entry, currentPrice, multiplier: m, futureGross, optionPnl, costs, net: optionPnl + futureGross - costs, futuresFees, optionCosts, funding, otherCosts, legs, quote, optionSource: opt,
    calculatedAt: new Date().toISOString(), formula: `${signedQty} × ${m} × (${currentPrice} − ${entry}) = ${futureGross}`, warnings };
}

// ------------------------------------------------------------------ 1:2 Options + Futures (ratio setup)
async function ratioSetup(b, stockSymbols) {
  const symbol = String(b.symbol || '').trim();
  const universe = await stockSymbols();
  if (!universe.includes(symbol)) throw httpErr(400, 'Select a verified Hyperliquid US stock perp');
  const interval = INTERVALS[b.interval] ? b.interval : '15m';
  const debitLots = fin(b.callLots, 'Debit-spread lots', { min: 1, max: 10, int: true }); let callLots = debitLots, putLots = debitLots * 2;
  const equity = fin(b.equity, 'Account equity', { min: 1 }), capital = fin(b.capital, 'Allocation', { min: 1, max: equity }), maxLoss = fin(b.maxLoss, 'Maximum planned loss', { min: 0.01 });
  const riskPct = maxLoss / equity * 100; if (riskPct > 5) throw httpErr(400, 'Maximum planned loss cannot exceed 5% of equity');
  const cfg = { equity, capital, riskPct, maxLots: Math.min(20, debitLots * 2), callLots, putLots, directionalPct: fin(b.directionalPct, 'Directional increment', { min: 0, max: 100 }),
    maxSpreadPct: fin(b.maxSpreadPct, 'Maximum bid/ask width', { min: 0.1, max: 100 }), commission: fin(b.commission, 'Commission', { min: 0, max: 100 }), futureFeePct: fin(b.feePct, 'Futures fee', { min: 0, max: 5 }),
    slippagePct: fin(b.slippagePct, 'Slippage', { min: 0, max: 5 }), targetR: fin(b.targetR, 'Target R', { min: 1, max: 20 }), minStopPct: fin(b.minStopPct, 'Minimum stop', { min: 0.1, max: 10 }),
    strategy: b.strategy === 'condor' ? 'condor' : 'directional', maxQuoteAgeMs: b.allowStale === false ? 120000 : MAX_STALE_MS };
  const near = b.near, far = b.far || b.near;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(near || '') || near <= new Date().toISOString().slice(0, 10)) throw httpErr(400, 'Choose an unexpired option expiry');
  const ticker = symbol.split(':')[1];
  const [candles, meta, book, chainData] = await Promise.all([hl.candles('mainnet', symbol, interval), perpMeta(symbol), perpBook(symbol), getChain({ symbol: ticker, near, far })]);
  const now = Date.now(), analysis = Technicals.analyze(candles, now, { minStopPct: cfg.minStopPct });
  const reference = { perpBid: book.bid, perpAsk: book.ask, perpMid: book.mid, bookTime: book.time, stock: chainData.stock?.price ?? null, stockTime: chainData.stock?.time ?? null, basis: chainData.stock ? book.mid - chainData.stock.price : null, provider: chainData.label };
  if (analysis.direction === 'WAIT') return { status: 'WAIT', symbol, reason: analysis.reason, analysis, reference };
  // Reference sheets: the CREDIT spread carries 2× the lots of the DEBIT spread (70 of 78 sheets). LONG perp → call credit
  // spread + put debit spread; SHORT perp → call debit + put credit. (The original code always used puts = 2× calls.)
  if (cfg.strategy === 'directional') { if (analysis.direction === 'LONG') { callLots = debitLots * 2; putLots = debitLots; } else { callLots = debitLots; putLots = debitLots * 2; } cfg.callLots = callLots; cfg.putLots = putLots; }
  const [c] = LiveHedge.optimize({ symbol, chain: chainData, analysis, meta, price: book.mid, now, cfg, interval, duration: INTERVALS[interval] });
  const long = c.signedFutureQty > 0, slip = cfg.slippagePct / 100, limit = long ? book.ask * (1 + slip) : book.bid * (1 - slip);
  const depth = (long ? book.asks.filter(l => l.px <= limit) : book.bids.filter(l => l.px >= limit)).reduce((n, l) => n + l.sz, 0);
  const future = { qty: c.signedFutureQty, entry: limit }, basis = book.mid - c.stock;
  const legs = c.legs.map(l => { const sign = l.side === 'buy' ? 1 : -1; return { ...l, signedUnits: sign * l.qty * 100, premiumCash: -sign * l.qty * 100 * l.premium, deltaContribution: sign * l.qty * 100 * l.quote.greeks.delta }; });
  const spreads = ['call', 'put'].map(type => { const p = legs.filter(l => l.type === type), buy = p.find(l => l.side === 'buy'), sell = p.find(l => l.side === 'sell'), cash = p.reduce((n, l) => n + l.premiumCash, 0);
    const cls = type === 'call' ? (buy.strike < sell.strike ? 'bull call debit spread' : 'bear call credit spread') : (buy.strike > sell.strike ? 'bear put debit spread' : 'bull put credit spread');
    return { type, classification: cls, lots: buy.qty, width: Math.abs(buy.strike - sell.strike), cash }; });
  const netPremium = legs.reduce((n, l) => n + l.premiumCash, 0), entryCommission = cfg.commission * legs.reduce((n, l) => n + l.qty, 0);
  const costs = { commission: cfg.commission, futureFeePct: cfg.futureFeePct, funding: 0, mmLoss: 0 };
  const model = [-10, -5, -2.5, 0, 2.5, 5, 10].map(shockPct => {
    const stock = c.stock * (1 + shockPct / 100), perp = Math.max(0, stock + basis), t = SheetMath.totals(legs, future, stock, perp, costs);
    let cur = null; try { cur = Finance.pnl(legs, { timeMillis: now, shock: shockPct, ivShift: 0, rate: 4, dividend: 0 }, cfg.commission) + t.futureGross - t.futureFees; } catch {}
    return { shockPct, stock, perp, options: t.optionPnl, futureGross: t.futureGross, futureFees: t.futureFees, combined: t.net, currentTimeModel: cur };
  });
  const bounds = SheetMath.bounds(legs, future, basis, costs);
  const curve = Array.from({ length: 121 }, (_, i) => { const stock = Math.max(Math.max(0, -basis), c.stock * (0.85 + 0.3 * i / 120)); return { stock, combined: bounds.value(stock) }; });
  const oldest = Math.min(...legs.map(l => Date.parse(l.quote.quoteTime)).filter(Number.isFinite));
  const stale = !Number.isFinite(oldest) || now - oldest > 120000;
  return {
    status: 'CALCULATED', symbol, expiry: c.expiry, direction: analysis.direction, analysis, szDecimals: meta.szDecimals, strategy: cfg.strategy, callLots, putLots,
    neutralFutureQty: c.neutralFutureQty, directionalIncrement: c.directionalIncrement, netDelta: c.netDelta, optionDelta: c.optionDelta, margin: c.margin,
    plannedCombinedRisk: c.plannedRisk, optionRisk: c.optionRisk, futureStopRisk: c.futureRisk, budget: maxLoss, stop: c.stop, target: c.target, netFutureRR: c.netRR,
    reference: { ...reference, stock: c.stock, stockTime: c.stockTime, basis }, availableFuturesDepth: depth, future, legs, spreads,
    netPremiumBeforeCommission: netPremium, entryCommission, openingCash: netPremium - entryCommission,
    formula: { 'neutral futures': '−Σ(side sign × lots × 100 × provider delta)', 'directional futures': 'neutral × (1 + increment%) rounded to 10^−szDecimals', 'lots': 'credit-spread lots = 2 × debit-spread lots (1:2, per the reference sheets)', 'risk gate': 'option max loss + futures stop risk ≤ maximum planned loss', 'futures limit': 'best ' + (long ? 'ask × (1 + slippage)' : 'bid × (1 − slippage)') },
    model, bounds: { maxProfit: bounds.maxProfit === Infinity ? null : bounds.maxProfit, maxLoss: bounds.maxLoss === Infinity ? null : bounds.maxLoss, profitUnbounded: bounds.maxProfit === Infinity, lossUnbounded: bounds.maxLoss === Infinity, breakEvens: bounds.breakEvens, tailSlope: bounds.tailSlope }, curve,
    orderPreview: { note: 'Manual preview only. No orders were sent.', futures: { venue: 'Hyperliquid', symbol, side: long ? 'BUY' : 'SELL', quantity: Math.abs(c.signedFutureQty), limitPrice: limit }, options: legs.map(l => ({ contract: l.contract, side: l.side.toUpperCase(), contracts: l.qty, limitPrice: l.premium })) },
    quoteState: stale ? 'STALE / last available quotes' : 'fresh', provider: chainData.label, quoteExpiresAt: now + 60000,
    assumptions: [c.explanation, 'Options data: ' + chainData.label + '. ' + (stale ? 'Quotes are older than 2 minutes (market closed or indicative feed); use only for analysis.' : 'Quotes are under 2 minutes old.'),
      'Expiry payoff holds the observed perp-minus-stock basis constant; funding, assignment, early exercise and liquidation are not modeled.', 'Credit-spread lots are twice the debit-spread lots (the 1:2 structure of the reference sheets): ' + callLots + ' call / ' + putLots + ' put lots.', 'Futures quantity is a Greek delta hedge plus your directional increment; it must be rechecked as delta changes.'],
  };
}

// ------------------------------------------------------------------ router
function router({ stockSymbols }) {
  const r = express.Router();
  r.get('/derivatives/status', (req, res) => res.json({ alpaca: alpaca.status(), fallback: fallbackEnabled() ? 'cboe-delayed' : null, analysisMaxQuoteAgeMs: MAX_STALE_MS, liveMaxQuoteAgeMs: 120000,
    message: alpaca.configured() ? 'Alpaca connected on the server · options feed ' + alpaca.status().optionsFeed.toUpperCase() : fallbackEnabled() ? 'Alpaca keys not configured · using Cboe public DELAYED quotes (set ALPACA_KEY_ID / ALPACA_SECRET_KEY for Alpaca; OPTIONS_FALLBACK=off disables Cboe)' : alpaca.NO_KEYS }));
  r.get('/option-universe', wrap(async (req, res) => res.json(await symbolDirectory())));
  r.post('/options', wrap(async (req, res) => {
    const b = req.body || {};
    if (b.action === 'universe') return res.json(alpaca.configured() ? await alpaca.optionableAssets() : { ...(await symbolDirectory()), note: 'Alpaca keys not configured: US-listed symbol directory, optionability not verified (the fetched chain confirms it)' });
    if (b.action === 'legs') return res.json(await getLegs((b.contracts || []).map(s => String(s).toUpperCase())));
    res.json(await getChain({ symbol: b.symbol, near: b.near, far: b.far, pageToken: b.pageToken || null }));
  }));
  r.post('/manual-four-leg', wrap(async (req, res) => res.json(await manualFourLeg(req.body || {}))));
  r.post('/sheet-scenarios', wrap(async (req, res) => res.json(sheetScenarios(req.body || {}))));
  r.get('/sheet-scenarios', (req, res) => res.status(405).json({ error: 'Use POST' }));
  r.get('/sheet-audit', wrap(async (req, res) => res.json(sheetAudit())));
  r.post('/position-pnl', wrap(async (req, res) => res.json(await positionPnl(req.body || {}))));
  r.post('/ratio-setup', wrap(async (req, res) => res.json(await ratioSetup(req.body || {}, stockSymbols))));
  return r;
}

module.exports = { getChain, getExpiries, providerInfo, perpBook, perpMeta, nyToUtc, router, manualFourLeg, sheetScenarios, sheetAudit, positionPnl, ratioSetup, piecewiseBounds, symbolDirectory };
