'use strict';
// Strategy Builder API: any US ticker + expiry + target P&L → four option legs + Hyperliquid stock-perp quantity.
// One engine (public/strategy-engine.js) is shared with the browser; every recommendation is stored in SQLite so later
// runs can be compared with realised outcomes, and per-ticker parameters are calibrated from the reference sheets + history.
const express = require('express');
require('../public/strategy-engine.js');
const { Strategy } = globalThis;
const deriv = require('./derivatives');
const alpaca = require('./alpaca');
const hl = require('./hl');
const { db } = require('./db');
const ref = require('../scripts/reference-analysis');
const { httpErr } = alpaca;

db.exec(`
CREATE TABLE IF NOT EXISTS strategy_runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ticker TEXT NOT NULL, expiry TEXT NOT NULL, method TEXT NOT NULL,
  status TEXT NOT NULL, provider TEXT, quote_time TEXT, spot REAL, atm_iv REAL, perp_symbol TEXT, futures_qty REAL,
  target_pnl REAL, expected_up REAL, expected_down REAL, required_capital REAL, inputs TEXT, chain_summary TEXT, legs TEXT, result TEXT,
  realised_pnl REAL, realised_at INTEGER, outcome_notes TEXT);
CREATE INDEX IF NOT EXISTS strategy_runs_ticker ON strategy_runs(ticker, ts);
CREATE TABLE IF NOT EXISTS reference_trades(
  page INTEGER PRIMARY KEY, symbol TEXT NOT NULL, open_date TEXT, expiry TEXT, data TEXT NOT NULL, analysis TEXT NOT NULL, loaded_at INTEGER NOT NULL);`);
const ins = db.prepare(`INSERT INTO strategy_runs(ts,ticker,expiry,method,status,provider,quote_time,spot,atm_iv,perp_symbol,futures_qty,target_pnl,expected_up,expected_down,required_capital,inputs,chain_summary,legs,result)
  VALUES(@ts,@ticker,@expiry,@method,@status,@provider,@quote_time,@spot,@atm_iv,@perp_symbol,@futures_qty,@target_pnl,@expected_up,@expected_down,@required_capital,@inputs,@chain_summary,@legs,@result)`);

// ---- reference dataset → DB (idempotent) and calibration
let refCache = null;
function reference() {
  if (refCache) return refCache;
  const { rows, res, summary } = ref.run();
  const up = db.prepare('INSERT OR REPLACE INTO reference_trades(page,symbol,open_date,expiry,data,analysis,loaded_at) VALUES(?,?,?,?,?,?,?)');
  db.transaction(() => rows.forEach((r, i) => up.run(r.page, r.symbol, r.openDate, r.expiry, JSON.stringify(r), JSON.stringify(res[i]), Date.now())))();
  refCache = { rows, res, summary };
  return refCache;
}
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
function calibration(ticker) {
  const { rows, res } = reference();
  const pick = t => res.filter((r, i) => (!t || rows[i].symbol === t) && r.pattern && r.pattern !== 'mixed' && r.creditToDebitLots === 2);
  const make = list => {
    const g = k => median(list.map(r => r.sigmaGeometry?.[k]));
    const ff = median(list.map(r => { const d = rows.find(x => x.page === r.page); return r.eqQtyToday ? Math.abs(d.futureQty) / Math.abs(r.eqQtyToday) : NaN; }));
    return { n: list.length, debitLongSigma: g('debitLongOtm'), debitShortSigma: g('debitShort'), creditShortSigma: g('creditShort'), wingSigma: g('creditWing'), futuresFactor: ff };
  };
  const all = make(pick(null)), own = ticker ? make(pick(ticker)) : null;
  const useOwn = own && own.n >= 3;
  const hist = ticker ? db.prepare('SELECT expected_up, expected_down, realised_pnl FROM strategy_runs WHERE ticker=? AND realised_pnl IS NOT NULL AND status=\'OK\'').all(ticker) : [];
  const realisation = median(hist.map(h => h.realised_pnl / Math.max(1, Math.min(h.expected_up, h.expected_down))));
  const clamp = (x, lo, hi, d) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
  const src = useOwn ? own : all;
  return {
    source: useOwn ? `reference sheets for ${ticker} (${own.n} rows)` : `all reference sheets (${all.n} rows)` + (ticker && own?.n ? ` · only ${own.n} ${ticker} rows, too few for a ticker-specific fit` : ''),
    debitLongSigma: Math.round(clamp(src.debitLongSigma, 0, 0.5, 0.1) * 100) / 100, debitShortSigma: Math.round(clamp(src.debitShortSigma, 0.4, 1.6, 0.9) * 100) / 100, creditShortSigma: Math.round(clamp(src.creditShortSigma, 0.3, 1.5, 0.63) * 100) / 100,
    wingSigma: Math.round(clamp(src.wingSigma, 0.2, 1.2, 0.47) * 100) / 100, futuresFactor: Math.round(clamp(src.futuresFactor, 0.7, 1.1, 0.95) * 100) / 100,
    global: all, ticker: own, history: { closedRuns: hist.length, medianRealisedToExpected: realisation },
  };
}

// ---- ticker → Hyperliquid US stock perp
async function perpFor(ticker, stockSymbols) {
  const list = await stockSymbols(), t = ticker.toUpperCase();
  const sym = list.find(s => s === 'xyz:' + t) || list.find(s => s.split(':')[1] === t);
  if (!sym) return { available: false, reason: `No Hyperliquid US stock perp for ${t} (checked ${list.length} listed US-stock perps).` };
  try {
    const [book, meta] = await Promise.all([deriv.perpBook(sym), deriv.perpMeta(sym)]);
    if (!meta) return { available: false, symbol: sym, reason: sym + ' metadata unavailable' };
    return { available: true, symbol: sym, bid: book.bid, ask: book.ask, mid: book.mid, time: new Date(book.time).toISOString(), szDecimals: meta.szDecimals, maxLeverage: meta.maxLeverage, bids: undefined };
  } catch (e) { return { available: false, symbol: sym, reason: e.message }; }
}
const T_RE = /^[A-Z][A-Z0-9.]{0,9}$/;
const tick = s => { const t = String(s || '').trim().toUpperCase(); if (!T_RE.test(t)) throw httpErr(400, 'Enter a valid US ticker, e.g. NVDA'); return t; };
const num = (v, d) => (v === '' || v == null ? d : Number(v));

function router({ stockSymbols }) {
  const r = express.Router();
  const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(e.status || 400).json({ error: e.message }));
  r.get('/strategy/provider', (req, res) => res.json(deriv.providerInfo()));
  r.get('/strategy/expiries', wrap(async (req, res) => {
    const t = tick(req.query.ticker);
    const [ex, perp] = await Promise.all([deriv.getExpiries(t), perpFor(t, stockSymbols)]);
    const today = new Date().toISOString().slice(0, 10);
    ex.expiries = ex.expiries.filter(e => e.date >= today).map(e => ({ ...e, dte: Math.round((Strategy.expiryCloseMs(e.date) - Date.now()) / 864e5 * 10) / 10 }));
    if (!ex.expiries.length) throw httpErr(404, 'No unexpired listed options for ' + t);
    res.json({ ticker: t, ...ex, perp, calibration: calibration(t) });
  }));
  r.post('/strategy/build', wrap(async (req, res) => {
    const b = req.body || {}, t = tick(b.ticker), expiry = String(b.expiry || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw httpErr(400, 'Choose an expiry from the list');
    const method = b.method === 'delta' ? 'delta' : 'reference';
    const [chain, perp] = await Promise.all([deriv.getChain({ symbol: t, near: expiry, far: expiry }), perpFor(t, stockSymbols)]);
    const cal = calibration(t), c = b.cfg || {};
    const cfg = method === 'reference'
      ? { signal: ['BULLISH', 'BEARISH', 'AUTO'].includes(c.signal) ? c.signal : (['LONG', 'SHORT'].includes(c.futuresSide) ? (c.futuresSide === 'LONG' ? 'BULLISH' : 'BEARISH') : 'AUTO'),
          callLotUnits: num(c.callLotUnits, 1), putLotUnits: num(c.putLotUnits, 2), futuresRound: num(c.futuresRound, 5), futuresFactor: num(c.futuresFactor, 1), marginDivisor: num(c.marginDivisor, 2), maxPriceGapPct: num(c.maxPriceGapPct, 5), targetPnl: num(c.targetPnl), capital: num(c.capital), maxLossPct: num(c.maxLossPct, 50), mmLoss: num(c.mmLoss, 50), maxSpreadPct: num(c.maxSpreadPct, 25), maxLots: num(c.maxLots, 30), leverage: num(c.leverage, 5), commission: num(c.commission, 0.65), futureFeePct: num(c.futureFeePct, 0.045),
          ...(c.useCalibration === false ? {} : { debitLongSigma: cal.debitLongSigma, debitShortSigma: cal.debitShortSigma, creditShortSigma: cal.creditShortSigma, wingSigma: cal.wingSigma }),
          ...Object.fromEntries(['debitShortSigma', 'creditShortSigma', 'wingSigma'].filter(k => c[k] !== '' && c[k] != null && Number.isFinite(Number(c[k]))).map(k => [k, Number(c[k])])) }
      : { direction: ['LONG', 'SHORT', 'NEUTRAL'].includes(c.direction) ? c.direction : 'LONG', targetPnl: num(c.targetPnl), capital: num(c.capital), maxLossPct: num(c.maxLossPct, 50), ratio: num(c.ratio, 2), directionalPct: num(c.directionalPct, 25), maxSpreadPct: num(c.maxSpreadPct, 25), maxScale: num(c.maxLots, 25), leverage: num(c.leverage, 5), commission: num(c.commission, 0.65), futureFeePct: num(c.futureFeePct, 0.045) };
    const input = { ticker: t, expiry, contracts: chain.contracts, stock: chain.stock, perp, cfg };
    const out = method === 'reference' ? Strategy.buildReference(input) : Strategy.build(input);
    const quoteTimes = chain.contracts.map(q => Date.parse(q.quoteTime)).filter(Number.isFinite);
    const quoteTime = quoteTimes.length ? new Date(Math.max(...quoteTimes)).toISOString() : chain.stock?.time || null;
    const data = { provider: chain.provider, label: chain.label, feed: chain.feed, delayed: !!chain.delayed, quoteTime, ageMinutes: quoteTime ? Math.round((Date.now() - Date.parse(quoteTime)) / 6e4) : null, stockSource: chain.stock?.source || null, partial: !!chain.partial, contractsAtExpiry: chain.contracts.length };
    const best = out.best;
    const row = { ts: Date.now(), ticker: t, expiry, method, status: out.status, provider: chain.label, quote_time: quoteTime, spot: out.spot ?? null, atm_iv: out.atmIV ?? null, perp_symbol: perp.symbol || null,
      futures_qty: best?.futures?.signedQty ?? null, target_pnl: cfg.targetPnl ?? null, expected_up: best?.expected?.upExpiry ?? best?.target?.pnlAtTargetPrice ?? null, expected_down: best?.expected?.downExpiry ?? null, required_capital: best?.requiredCapital ?? null,
      inputs: JSON.stringify({ ticker: t, expiry, method, cfg }), chain_summary: JSON.stringify({ ...data, liquidity: out.liquidity, atmIV: out.atmIV, expectedMove: out.expectedMove, spot: out.spot, basis: out.basis }),
      legs: JSON.stringify(best ? { legs: best.legs.map(({ greeks, ...l }) => ({ ...l, delta: greeks?.delta })), futures: best.futures } : null), result: JSON.stringify({ ...out, best: best ? { ...best, curve: undefined } : undefined, alternatives: undefined }) };
    const id = out.status === 'INVALID' ? null : ins.run(row).lastInsertRowid;
    res.json({ id, data, perp, calibration: method === 'reference' ? cal : null, ...out,
      execution: best ? { enabled: false, reason: 'Order execution is not enabled. A later "Execute on Alpaca" step will submit this as one multi-leg (mleg) limit order; the perp leg is sent separately to Hyperliquid.', alpacaOrderPreview: Strategy.alpacaOrderPreview(best.legs) } : null });
  }));
  r.get('/strategy/history', wrap(async (req, res) => {
    const t = req.query.ticker ? tick(req.query.ticker) : null, lim = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = db.prepare(`SELECT id,ts,ticker,expiry,method,status,provider,quote_time,spot,atm_iv,perp_symbol,futures_qty,target_pnl,expected_up,expected_down,required_capital,legs,realised_pnl,realised_at,outcome_notes FROM strategy_runs ${t ? 'WHERE ticker=?' : ''} ORDER BY id DESC LIMIT ${lim}`).all(...(t ? [t] : []));
    res.json({ runs: rows.map(x => ({ ...x, legs: x.legs ? JSON.parse(x.legs) : null })) });
  }));
  r.get('/strategy/history/:id', wrap(async (req, res) => {
    const x = db.prepare('SELECT * FROM strategy_runs WHERE id=?').get(Number(req.params.id)); if (!x) throw httpErr(404, 'Not found');
    for (const k of ['inputs', 'chain_summary', 'legs', 'result']) x[k] = x[k] ? JSON.parse(x[k]) : null;
    res.json(x);
  }));
  r.post('/strategy/history/:id/outcome', wrap(async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}, pnl = Number(b.realisedPnl);
    if (!Number.isFinite(pnl) || Math.abs(pnl) > 1e9) throw httpErr(400, 'Realised P&L must be a number');
    const notes = String(b.notes || '').slice(0, 500);
    const info = db.prepare('UPDATE strategy_runs SET realised_pnl=?, realised_at=?, outcome_notes=? WHERE id=?').run(pnl, Date.now(), notes, id);
    if (!info.changes) throw httpErr(404, 'Run not found');
    res.json({ ok: true, id, realisedPnl: pnl });
  }));
  r.get('/strategy/calibration', wrap(async (req, res) => res.json(calibration(req.query.ticker ? tick(req.query.ticker) : null))));
  r.get('/strategy/reference', wrap(async (req, res) => { const { rows, res: an, summary } = reference(); res.json({ summary, rows: rows.map((x, i) => ({ ...x, analysis: an[i] })) }); }));
  return r;
}
module.exports = { router, calibration, reference, perpFor };
