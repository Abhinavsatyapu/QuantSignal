'use strict';
// Strategy Builder API: any US ticker + expiry + target P&L → four option legs + Hyperliquid stock-perp quantity.
// One engine (public/strategy-engine.js) is shared with the browser; every recommendation is stored in SQLite so later
// runs can be compared with realised outcomes, and per-ticker parameters are calibrated from the reference sheets + history.
const express = require('express');
const fs = require('fs');
const path = require('path');
require('../public/strategy-engine.js');
require('../public/strategy-optimizer.js');
require('../public/strategy-weekly-atr.js');
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
  persist.mark('reference_trades', 'all'); // reference-sheet dataset mirrored to durable storage too
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

// Sheet anchor for the optimizer's short-distance band: the per-ticker sheet geometry (σ distances of the debit short, credit
// short, debit long and credit wing) for each lot-ratio group, plus the same shorts as % of spot. "credit2" = the credit spread
// carries 2× the debit lots (the sheets' usual structure), "credit05" = the other ratio. Ticker rows are used when there are
// ≥ 3 of them for that group, else the pooled rows of that group, else the pooled credit2 calibration.
// Per-sheet weekly-ATR multiples, frozen by scripts/strike-audit.js (no network at request time)
let sheetAtrFile = null;
function sheetAtr() {
  if (sheetAtrFile) return sheetAtrFile;
  try { sheetAtrFile = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/reference/sheet-atr.json'), 'utf8')).pages || {}; } catch { sheetAtrFile = {}; }
  return sheetAtrFile;
}
function atrMedians(pages) {
  const A = sheetAtr(), rows = pages.map(p => A[p]).filter(Boolean), m = (k) => { const v = median(rows.map(x => x[k]).filter(Number.isFinite)); return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null; };
  return rows.length ? { debitShortAtr: m('debitShortAtr'), creditShortAtr: m('creditShortAtr'), wingAtr: m('wingAtr'), ceShortAtr: m('ceShortAtr'), peShortAtr: m('peShortAtr'), atrRows: rows.length } : {};
}
function sheetAnchor(ticker, opts = {}) {
  const { rows, res } = reference(), cal = calibration(ticker), exS = new Set([opts.excludePage, ...(opts.excludePages || [])].filter(x => x != null)), ex = { has: (p) => exS.has(p) };
  const clamp = (x, lo, hi, d) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d), r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
  const pick = (t, ratio) => res.map((r, i) => ({ r, d: rows[i] })).filter(({ r, d }) => !ex.has(d.page) && (!t || d.symbol === t) && r.pattern && r.pattern !== 'mixed' && r.creditToDebitLots === ratio && r.sigmaGeometry);
  const pctOf = (r) => { const callIsCredit = /call credit/i.test(r.pattern); return { debit: Math.abs(callIsCredit ? r.shortPutPct : r.shortCallPct), credit: Math.abs(callIsCredit ? r.shortCallPct : r.shortPutPct) }; };
  const make = (list, label) => ({ n: list.length, source: label, rows: list.map(({ d }) => d.page),
    debitLongSigma: r2(clamp(median(list.map(x => x.r.sigmaGeometry.debitLongOtm)), 0, 0.5, 0.1)), debitShortSigma: r2(clamp(median(list.map(x => x.r.sigmaGeometry.debitShort)), 0.3, 1.8, 0.9)),
    creditShortSigma: r2(clamp(median(list.map(x => x.r.sigmaGeometry.creditShort)), 0.25, 1.6, 0.63)), wingSigma: r2(clamp(median(list.map(x => x.r.sigmaGeometry.creditWing)), 0.15, 1.2, 0.47)),
    debitShortPct: r2(median(list.map(x => pctOf(x.r).debit))), creditShortPct: r2(median(list.map(x => pctOf(x.r).credit))),
    ...atrMedians(list.map(({ d }) => d.page)) });
  const group = (ratio, name) => {
    const own = ticker ? pick(ticker, ratio) : [], all = pick(null, ratio);
    if (own.length >= 3) return { ...make(own, `${ticker} reference sheets, ${name} (${own.length} rows)`), scope: 'ticker', _rows: own };
    if (all.length >= 3) return { ...make(all, `all reference sheets, ${name} (${all.length} rows)` + (own.length ? ` · only ${own.length} ${ticker} row(s), too few` : ` · no ${ticker || ''} rows`)), scope: 'pooled', _rows: all };
    return null;
  };
  const credit2 = group(2, 'credit 2× debit lots'), credit05 = group(0.5, 'credit ½× debit lots');
  // CE / PE short as × weekly ATR over all of this ticker's sheets (≥3 rows) or all sheets → Weekly ATR method defaults
  const tk = ticker ? rows.filter(d => d.symbol === ticker && !ex.has(d.page)).map(d => d.page) : [], allPages = rows.filter(d => !ex.has(d.page)).map(d => d.page), tkA = atrMedians(tk);
  const atrMultiples = tkA.atrRows >= 3 ? { ce: tkA.ceShortAtr, pe: tkA.peShortAtr, n: tkA.atrRows, scope: 'ticker', source: `${ticker} reference sheets (${tkA.atrRows} rows)` } : (() => { const a = atrMedians(allPages); return { ce: a.ceShortAtr, pe: a.peShortAtr, n: a.atrRows, scope: 'pooled', source: `all reference sheets (${a.atrRows} rows)` }; })();
  return { ticker, source: credit2 ? credit2.source : cal.source, groups: { credit2, credit05 }, atrMultiples, calibration: { source: cal.source, debitLongSigma: cal.debitLongSigma, debitShortSigma: cal.debitShortSigma, creditShortSigma: cal.creditShortSigma, wingSigma: cal.wingSigma } };
}
async function sheetAnchorWithAtr(ticker) {
  // the sheet × weekly ATR medians come from data/reference/sheet-atr.json (frozen Nasdaq history), already on every group
  const a = sheetAnchor(ticker);
  Object.values(a.groups).forEach(g => { if (g) delete g._rows; });
  a.atrNote = Object.keys(sheetAtr()).length ? 'sheet × weekly ATR = |short − spot| at the sheet open ÷ Wilder 14-week ATR (Nasdaq daily OHLC, weeks completed before the open; data/reference/sheet-atr.json)' : 'sheet × weekly ATR unavailable (data/reference/sheet-atr.json missing)';
  return a;
}

// ---- columns added later (idempotent)
for (const col of ['recommended_variant TEXT', 'chosen_variant TEXT', 'variants TEXT', 'lot_sets INTEGER', 'source TEXT', 'plan_id INTEGER', 'market TEXT', 'considered TEXT', 'multiplier REAL', 'taken INTEGER', 'entry_fills TEXT', 'exit_fills TEXT', 'closed_at INTEGER', 'auto_outcome TEXT', 'auto_checked_at INTEGER', 'model_version INTEGER', 'weekly_atr TEXT', 'distance_band TEXT']) { try { db.exec('ALTER TABLE strategy_runs ADD COLUMN ' + col); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
// What the reference sheets did per perp side (1C:2P vs 2C:1P), used as one input to the variant recommendation.
let refLots = null;
function referenceLots() {
  if (refLots) return refLots;
  refLots = { LONG: { '1C:2P': 0, '2C:1P': 0 }, SHORT: { '1C:2P': 0, '2C:1P': 0 } };
  for (const r of reference().rows) { const side = r.futureQty > 0 ? 'LONG' : 'SHORT', c = Math.abs(r.callAUnits), p = Math.abs(r.putAUnits); if (p === 2 * c) refLots[side]['1C:2P']++; else if (c === 2 * p) refLots[side]['2C:1P']++; }
  return refLots;
}
// Market conditions from the app's own indicator engine (Technicals.analyze on Hyperliquid 15m candles of the perp).
async function marketFor(perp) {
  if (!perp || !perp.available) return null;
  try {
    const { Technicals } = globalThis, candles = await hl.candles('mainnet', perp.symbol, '15m'), a = Technicals.analyze(candles, Date.now(), { minStopPct: 0.5 });
    const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
    return { interval: '15m', direction: a.direction, score: a.score, maxScore: a.maxScore, trend: a.ema20 > a.ema50 ? 'UP' : a.ema20 < a.ema50 ? 'DOWN' : 'FLAT', momentum: a.histogram > 0 ? 'UP' : a.histogram < 0 ? 'DOWN' : 'FLAT', rsi: r2(a.rsi), adx: r2(a.adx), ema20: r2(a.ema20), ema50: r2(a.ema50), closedAt: a.closedAt };
  } catch (e) { return { error: 'Indicators unavailable: ' + e.message }; }
}

// ---- event calendar (Nasdaq public JSON; best effort — returns a note when unavailable)
const eventCache = new Map();
async function eventsFor(t) {
  const c = eventCache.get(t); if (c && Date.now() - c.at < 6 * 36e5) return c.v;
  const get = async (u) => { const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 QuantSignal', Accept: 'application/json' }, signal: AbortSignal.timeout(6000) }); if (!r.ok) throw Error('HTTP ' + r.status); return r.json(); };
  const iso = (m) => (m ? m[3] + '-' + m[1] + '-' + m[2] : null), v = { source: 'Nasdaq public calendar', notes: [] };
  try { const e = await get('https://api.nasdaq.com/api/analyst/' + t + '/earnings-date'); v.earningsDate = iso(String(e?.data?.reportText || '').match(/on\s+(\d{2})\/(\d{2})\/(\d{4})/)); v.earningsText = e?.data?.reportText || null; } catch (e) { v.notes.push('earnings date unavailable (' + e.message + ')'); }
  try { const d = await get('https://api.nasdaq.com/api/quote/' + t + '/dividends?assetclass=stocks'); v.exDividendDate = iso(String(d?.data?.exDividendDate || '').match(/(\d{2})\/(\d{2})\/(\d{4})/)); v.annualDividend = d?.data?.annualizedDividend || null; } catch (e) { v.notes.push('dividend data unavailable (' + e.message + ')'); }
  eventCache.set(t, { at: Date.now(), v }); return v;
}
// ---- scoring weights: stored in SQLite, tuned from closed runs (transparent; see GET /strategy/weights)
db.exec(`CREATE TABLE IF NOT EXISTS strategy_weights(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, weights TEXT NOT NULL, source TEXT NOT NULL, closed_runs INTEGER NOT NULL, detail TEXT)`);
function currentWeights() {
  const x = db.prepare('SELECT * FROM strategy_weights ORDER BY id DESC LIMIT 1').get();
  // untuned defaults are refreshed when the code's defaults change (e.g. reference-sheet geometry 0.5× → 1.5×); tuned rows are kept
  if (x && !(x.source.startsWith('defaults') && x.weights !== JSON.stringify(Strategy.DEFAULT_WEIGHTS))) return { ...x, weights: JSON.parse(x.weights), detail: x.detail ? JSON.parse(x.detail) : null };
  const w = { ...Strategy.DEFAULT_WEIGHTS };
  db.prepare('INSERT INTO strategy_weights(ts,weights,source,closed_runs,detail) VALUES(?,?,?,?,?)').run(Date.now(), JSON.stringify(w), 'defaults (fit to target 3×; robustness 2×; reference-sheet geometry 1.5×; exit fit 2×, EV 1.5×, POP 1.5×)', 0, x ? JSON.stringify({ previousVersion: x.id }) : null);
  return currentWeights();
}
const MIN_CLOSED_FOR_TUNING = 8;
const log = require('./log');
db.exec(`CREATE TABLE IF NOT EXISTS strategy_plans(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, inputs TEXT, result TEXT)`);
// ---- weekly-plan universe: liquid optionable names, two per sector (editable in the UI)
const PLAN_UNIVERSE = [['AAPL', 'Tech hardware'], ['MSFT', 'Software'], ['CRM', 'Software'], ['NVDA', 'Semiconductors'], ['AMD', 'Semiconductors'], ['META', 'Communication'], ['GOOGL', 'Communication'],
  ['AMZN', 'Consumer discretionary'], ['TSLA', 'Consumer discretionary'], ['JPM', 'Financials'], ['GS', 'Financials'], ['UNH', 'Health care'], ['LLY', 'Health care'], ['XOM', 'Energy'], ['CVX', 'Energy'],
  ['CAT', 'Industrials'], ['BA', 'Industrials'], ['WMT', 'Consumer staples'], ['COST', 'Consumer staples'], ['SPY', 'Index ETF'], ['QQQ', 'Index ETF']].map(([ticker, sector]) => ({ ticker, sector }));
// upstream fetches (Cboe / Alpaca / Hyperliquid): retry transient failures with backoff, then a clear message
async function withRetry(fn, tries = 3) { let e; for (let i = 0; i < tries; i++) { try { return await fn(); } catch (x) { e = x; if (x && x.status && x.status < 500 && x.status !== 429) break; await new Promise(r => setTimeout(r, 400 * 2 ** i)); } } throw e; }
function friendlyFetchError(e) { const m = String(e && e.message || e); return /fetch failed|ECONN|ETIMEDOUT|abort|timeout|5\d\d|429/i.test(m) ? 'Options data source unavailable after 3 attempts (' + m.slice(0, 80) + '). Try again in a minute.' : m; }
// ---- export / import (JSON backup of History, weights and settings) + durable mirror
const persist = require('./persist');
const RUN_COLS = ['ts', 'ticker', 'expiry', 'method', 'status', 'provider', 'quote_time', 'spot', 'atm_iv', 'perp_symbol', 'futures_qty', 'target_pnl', 'expected_up', 'expected_down', 'required_capital', 'inputs', 'chain_summary', 'legs', 'result', 'realised_pnl', 'realised_at', 'outcome_notes', 'recommended_variant', 'chosen_variant', 'variants', 'lot_sets', 'source', 'plan_id', 'market', 'considered', 'multiplier', 'taken', 'entry_fills', 'exit_fills', 'closed_at', 'auto_outcome', 'auto_checked_at', 'model_version', 'weekly_atr', 'distance_band'];
function exportAll() {
  const acct = db.prepare('SELECT settings, updated_at FROM account_settings WHERE id=1').get();
  return { format: 'quantsignal-strategy-export', version: 1, exportedAt: new Date().toISOString(), account: acct ? JSON.parse(acct.settings) : null,
    weights: db.prepare('SELECT ts, weights, source, closed_runs, detail FROM strategy_weights ORDER BY id').all(), runs: db.prepare(`SELECT ${RUN_COLS.join(',')} FROM strategy_runs ORDER BY id`).all() };
}
function importAll(x) {
  if (!x || x.format !== 'quantsignal-strategy-export') throw httpErr(400, 'Not a QuantSignal strategy export file');
  let runs = 0, skipped = 0, weights = 0;
  const has = db.prepare('SELECT 1 FROM strategy_runs WHERE ts=? AND ticker=? AND expiry=? AND method=?');
  const insR = db.prepare(`INSERT INTO strategy_runs(${RUN_COLS.join(',')}) VALUES(${RUN_COLS.map(() => '?').join(',')})`);
  const hasW = db.prepare('SELECT 1 FROM strategy_weights WHERE ts=? AND source=?'), insW = db.prepare('INSERT INTO strategy_weights(ts,weights,source,closed_runs,detail) VALUES(?,?,?,?,?)');
  db.transaction(() => {
    for (const r of x.runs || []) { if (!r || !r.ts || !r.ticker) continue; if (has.get(r.ts, r.ticker, r.expiry, r.method)) { skipped++; continue; } insR.run(...RUN_COLS.map(c => (r[c] === undefined ? null : r[c]))); runs++; }
    for (const w of (x.weights || []).sort((a, b) => a.ts - b.ts)) { if (!w || hasW.get(w.ts, w.source)) continue; insW.run(w.ts, typeof w.weights === 'string' ? w.weights : JSON.stringify(w.weights), w.source, w.closed_runs || 0, w.detail ?? null); weights++; }
    if (x.account) db.prepare('INSERT INTO account_settings(id,settings,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET settings=excluded.settings, updated_at=excluded.updated_at').run(JSON.stringify(x.account), Date.now());
  })();
  return { runs, skipped, weights, account: !!x.account };
}
const changed = (tbl, id) => persist.mark(tbl, id);
let restoreInfo = { backend: persist.backend(), restored: false, pending: true };
function initPersistence() { return persist.init(db).then(r => (restoreInfo = r)); }
// ---- account settings (the user's own capital, weekly target, risk limits) — one row, editable
db.exec(`CREATE TABLE IF NOT EXISTS account_settings(id INTEGER PRIMARY KEY CHECK (id = 1), settings TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
const ACCOUNT_DEFAULTS = { capital: 100000, weeklyTargetMin: 3000, weeklyTargetMax: 4000, maxLossPerTrade: 2000, maxWeeklyLoss: 5000, maxDeployPct: 60, maxConcurrent: 10, maxPairCorrelation: 0.7, riskSigma: 2, targetPerLotSet: 400, defaultLotSets: 1, maxPerSector: 2 };
const ACCOUNT_EXTRA_DEFAULTS = { targetMode: 'perLotSet', tickerTargets: {} };
function getAccount() { const x = db.prepare('SELECT settings, updated_at FROM account_settings WHERE id=1').get(); return { ...ACCOUNT_DEFAULTS, ...ACCOUNT_EXTRA_DEFAULTS, ...(x ? JSON.parse(x.settings) : {}), updatedAt: x ? x.updated_at : null, defaults: { ...ACCOUNT_DEFAULTS, ...ACCOUNT_EXTRA_DEFAULTS } }; }
const tickerTarget = (a, t) => (a.tickerTargets && Number(a.tickerTargets[t]) > 0 ? Number(a.tickerTargets[t]) : a.targetPerLotSet);
function setAccount(body) {
  const cur = getAccount(), out = {};
  for (const [k, d] of Object.entries(ACCOUNT_DEFAULTS)) {
    const v = body[k] === undefined || body[k] === '' ? cur[k] : Number(body[k]);
    if (!Number.isFinite(v) || v < 0) throw httpErr(400, k + ' must be a non-negative number');
    out[k] = v;
  }
  out.targetMode = body.targetMode === 'fixed' ? 'fixed' : body.targetMode === 'perLotSet' ? 'perLotSet' : cur.targetMode;
  const tt = body.tickerTargets === undefined ? cur.tickerTargets : body.tickerTargets; out.tickerTargets = {};
  for (const [k, v] of Object.entries(tt || {})) { const t = String(k).toUpperCase(); if (!T_RE.test(t)) throw httpErr(400, 'Bad ticker ' + k); if (v === '' || v == null) continue; if (!(Number(v) > 0)) throw httpErr(400, 'Target for ' + t + ' must be positive'); out.tickerTargets[t] = Number(v); }
  if (!(out.capital > 0)) throw httpErr(400, 'Account capital must be positive');
  if (!(out.targetPerLotSet > 0)) throw httpErr(400, 'Target per lot set must be positive');
  if (!Number.isInteger(out.defaultLotSets) || out.defaultLotSets < 1) throw httpErr(400, 'Default lot sets must be a whole number ≥ 1');
  if (out.weeklyTargetMax < out.weeklyTargetMin) throw httpErr(400, 'Weekly target max must be ≥ min');
  if (out.maxDeployPct > 100 || out.maxDeployPct <= 0) throw httpErr(400, 'Max deployed per trade must be 1–100%');
  if (!Number.isInteger(out.maxConcurrent) || out.maxConcurrent < 1 || out.maxConcurrent > 10) throw httpErr(400, 'Max concurrent structures must be a whole number 1–10');
  if (out.maxPairCorrelation > 1) throw httpErr(400, 'Max pair correlation must be 0–1');
  db.prepare('INSERT INTO account_settings(id,settings,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET settings=excluded.settings, updated_at=excluded.updated_at').run(JSON.stringify(out), Date.now());
  changed('account_settings', 1);
  return getAccount();
}
// week = Monday 00:00 America/New_York (the US trading week)
function weekStartNY(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday), d = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day - dow));
  return d.toISOString().slice(0, 10);
}
function weeklyPnl(weeks = 12) {
  const rows = db.prepare('SELECT id, ticker, realised_pnl, realised_at, ts FROM strategy_runs WHERE realised_pnl IS NOT NULL ORDER BY realised_at DESC LIMIT 2000').all(), by = new Map();
  for (const x of rows) { const w = weekStartNY(x.realised_at || x.ts), g = by.get(w) || { week: w, realised: 0, runs: [] }; g.realised += x.realised_pnl; g.runs.push({ id: x.id, ticker: x.ticker, pnl: x.realised_pnl }); by.set(w, g); }
  const acct = getAccount(), cur = weekStartNY(Date.now()); if (!by.has(cur)) by.set(cur, { week: cur, realised: 0, runs: [] });
  const list = [...by.values()].sort((a, b) => (a.week < b.week ? 1 : -1)).slice(0, weeks).map(g => ({ ...g, targetMin: acct.weeklyTargetMin, targetMax: acct.weeklyTargetMax, hit: g.realised >= acct.weeklyTargetMin, breachedLossLimit: g.realised <= -acct.maxWeeklyLoss }));
  const closed = list.filter(g => g.runs.length && g.week !== cur);
  return { currentWeek: cur, weeks: list, summary: { weeksWithResults: closed.length, weeksHitTarget: closed.filter(g => g.hit).length, totalRealised: closed.reduce((a, g) => a + g.realised, 0) } };
}
function accountLimitsForBuild() {
  const a = getAccount(), wk = weeklyPnl(1).weeks[0], realised = wk ? wk.realised : 0;
  return { riskSigma: a.riskSigma, capital: a.capital, maxLossPct: a.maxLossPerTrade / a.capital * 100, maxDeployPct: a.maxDeployPct, weeklyLossRemaining: Math.max(0, a.maxWeeklyLoss + Math.min(0, realised)), weekRealised: realised };
}
// hourly closes for correlations (Hyperliquid perp candles when there is a perp; Nasdaq daily closes otherwise; null when neither)
async function returnsFor(t, perp) {
  try {
    if (perp && perp.available && !perp.isStock) { const c = await hl.candles('mainnet', perp.symbol, '1h', 240); const cl = c.map(k => Number(k.c ?? k.close)).filter(Number.isFinite); if (cl.length > 50) return { source: 'Hyperliquid 1h', closes: cl, times: c.map(k => k.t ?? k.time) }; }
  } catch (e) { /* fall through */ }
  return null;
}
const nasdaqCache = new Map();
async function nasdaqDaily(t) {
  const c = nasdaqCache.get(t); if (c && Date.now() - c.at < 6 * 36e5) return c.v;
  try {
    const from = new Date(Date.now() - 150 * 864e5).toISOString().slice(0, 10);
    const r = await fetch(`https://api.nasdaq.com/api/quote/${t}/historical?assetclass=${['SPY', 'QQQ', 'IWM', 'DIA'].includes(t) ? 'etf' : 'stocks'}&fromdate=${from}&limit=120`, { headers: { 'User-Agent': 'Mozilla/5.0 QuantSignal', Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    const j = await r.json(), rows = (j?.data?.tradesTable?.rows || []).slice().reverse();
    const v = rows.length > 40 ? { source: 'Nasdaq daily closes', closes: rows.map(x => Number(String(x.close).replace(/[$,]/g, ''))), times: rows.map(x => x.date) } : null;
    nasdaqCache.set(t, { at: Date.now(), v }); return v;
  } catch (e) { return null; }
}
// ---- weekly ATR price history: the perp's Hyperliquid candles (the source the indicators use) first, then the stock's
// Nasdaq daily OHLC. Neither offers weekly bars here, so weekly bars are built from daily OHLC; the forming week is dropped.
const atrCache = new Map();
const ETF = ['SPY', 'QQQ', 'IWM', 'DIA'];
async function nasdaqDailyOHLC(t, days) {
  const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const r = await fetch(`https://api.nasdaq.com/api/quote/${t}/historical?assetclass=${ETF.includes(t) ? 'etf' : 'stocks'}&fromdate=${from}&limit=400`, { headers: { 'User-Agent': 'Mozilla/5.0 QuantSignal', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw Error('Nasdaq HTTP ' + r.status);
  const j = await r.json(), n = (x) => Number(String(x).replace(/[$,]/g, ''));
  return (j?.data?.tradesTable?.rows || []).map((x) => { const m = String(x.date).match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? { date: m[3] + '-' + m[1] + '-' + m[2], o: n(x.open), h: n(x.high), l: n(x.low), c: n(x.close) } : null; }).filter(Boolean);
}
async function weeklyAtrFor(t, perp, { n = 14, source = 'auto' } = {}) {
  const key = [t, perp && perp.symbol, n, source].join('|'), hit = atrCache.get(key);
  if (hit && Date.now() - hit.at < 36e5) return hit.v;
  const days = 7 * (n + 16), notes = [], recent = (bars) => bars.slice(-n).map(b => ({ week: b.week, o: b.o, h: b.h, l: b.l, c: b.c, days: b.days }));
  let v = null;
  if (source !== 'stock' && perp && perp.available && !perp.isStock) {
    try {
      const c = await withRetry(() => hl.candles('mainnet', perp.symbol, '1d', days));
      const bars = Strategy.weeklyBarsFromDaily(c.map(k => ({ date: new Date(k.t).toISOString().slice(0, 10), o: k.o, h: k.h, l: k.l, c: k.c })), { beforeWeek: Strategy.weekStartOf(new Date().toISOString().slice(0, 10)) });
      const a = Strategy.wilderAtr(bars, n);
      if (a) v = { ...a, sourceKind: 'perp', source: 'Hyperliquid ' + perp.symbol + ' daily candles → weekly bars (Mon–Sun UTC; the perp trades 24/7)', recentBars: recent(bars) };
      else notes.push('Hyperliquid ' + perp.symbol + ' has only ' + bars.length + ' completed weeks (need ' + (n + 1) + ')');
    } catch (e) { notes.push('Hyperliquid candles unavailable (' + e.message + ')'); }
  } else if (source !== 'stock') notes.push('no Hyperliquid perp for ' + t);
  if (!v && source !== 'perp') {
    try {
      const bars = Strategy.weeklyBarsFromDaily(await withRetry(() => nasdaqDailyOHLC(t, days)), { beforeWeek: weekStartNY(Date.now()) });
      const a = Strategy.wilderAtr(bars, n);
      if (a) v = { ...a, sourceKind: 'stock', source: 'Nasdaq ' + t + ' daily OHLC → weekly bars (Mon–Fri)' + (notes.length ? ' · fallback: ' + notes.join('; ') : ''), recentBars: recent(bars) };
      else notes.push('Nasdaq has only ' + bars.length + ' completed weeks for ' + t + ' (need ' + (n + 1) + ')');
    } catch (e) { notes.push('Nasdaq daily history unavailable (' + e.message + ')'); }
  }
  if (!v) throw httpErr(502, 'Weekly ATR unavailable for ' + t + ': ' + notes.join('; ') + '.');
  atrCache.set(key, { at: Date.now(), v });
  return v;
}
function corrOf(a, b) {
  if (!a || !b) return null;
  const mp = new Map(); a.times.forEach((t, i) => mp.set(t, a.closes[i]));
  const pa = [], pb = []; b.times.forEach((t, i) => { if (mp.has(t)) { pa.push(mp.get(t)); pb.push(b.closes[i]); } });
  if (pa.length < 40) return null;
  const ra = pa.slice(1).map((x, i) => Math.log(x / pa[i])), rb = pb.slice(1).map((x, i) => Math.log(x / pb[i]));
  const ma = ra.reduce((s, x) => s + x, 0) / ra.length, mb = rb.reduce((s, x) => s + x, 0) / rb.length;
  let c = 0, va = 0, vb = 0; for (let i = 0; i < ra.length; i++) { c += (ra[i] - ma) * (rb[i] - mb); va += (ra[i] - ma) ** 2; vb += (rb[i] - mb) ** 2; }
  return va > 0 && vb > 0 ? c / Math.sqrt(va * vb) : null;
}
// ---- learning loop -------------------------------------------------------------------------------------------
// Outcomes: ACTUAL (user closed a taken trade with fills / realised P&L) and AUTO (after expiry, the market path is
// replayed: first touch of the CE-short / PE-short exit → P&L at that moment with the entry IVs, else P&L at the expiry
// close). Auto outcomes make untaken strategies training data too; they are hypothetical and weighted 0.5.
function outcomeOf(r) {
  if (r.realised_pnl != null) return { pnl: r.realised_pnl, kind: 'actual', w: 1 };
  if (r.auto_outcome) { const a = JSON.parse(r.auto_outcome); if (Number.isFinite(a.pnl)) return { pnl: a.pnl, kind: 'auto', w: 0.5, auto: a }; }
  return null;
}
function calibrationStats() {
  const rows = db.prepare("SELECT id, ticker, result, legs, entry_fills, realised_pnl, auto_outcome, market FROM strategy_runs WHERE status='OK' AND method IN ('optimizer','weekly_atr')").all();
  const proj = [], hits = { ce: 0, pe: 0, none: 0, n: 0 }, slip = {}, byTicker = {};
  for (const r of rows) {
    const o = outcomeOf(r), x = JSON.parse(r.result || '{}'), bst = x.best; if (!bst) continue;
    if (o) { const p0 = Math.min(bst.expected.upExpiry, bst.expected.downExpiry); proj.push({ err: o.pnl - p0, rel: p0 ? o.pnl / p0 : null, kind: o.kind });
      const t = byTicker[r.ticker] || (byTicker[r.ticker] = { n: 0, sumErr: 0 }); t.n++; t.sumErr += o.pnl - p0; }
    if (o && o.auto) { hits.n++; if (o.auto.exit === 'CE') hits.ce++; else if (o.auto.exit === 'PE') hits.pe++; else hits.none++; }
    if (r.entry_fills) { // slippage = (fill − mid) / half-spread, signed so that worse-than-mid is positive, by spread bucket
      const fills = JSON.parse(r.entry_fills) || {}, legs = (JSON.parse(r.legs || '{}').legs) || [];
      for (const l of legs) { const f = Number((fills.legs || {})[l.contract]); if (!Number.isFinite(f) || !(l.ask > l.bid)) continue; const half = (l.ask - l.bid) / 2, sp = l.mid > 0 ? (l.ask - l.bid) / l.mid * 100 : 999;
        const b2 = sp < 5 ? '<5%' : sp < 15 ? '5–15%' : '>15%', v = (l.side === 'buy' ? f - l.mid : l.mid - f) / half; (slip[b2] || (slip[b2] = [])).push(v); }
    }
  }
  const mean = (a) => (a.length ? a.reduce((m, x) => m + x, 0) / a.length : null);
  return { outcomes: proj.length, actual: proj.filter(p => p.kind === 'actual').length, auto: proj.filter(p => p.kind === 'auto').length,
    projectionError: { mean: mean(proj.map(p => p.err)), meanAbs: mean(proj.map(p => Math.abs(p.err))), medianRealisedToProjected: median(proj.map(p => p.rel).filter(Number.isFinite)) },
    exitHitRate: hits.n ? { ce: hits.ce / hits.n, pe: hits.pe / hits.n, neither: hits.none / hits.n, n: hits.n } : null,
    slippageByBucket: Object.fromEntries(Object.entries(slip).map(([k, v]) => [k, { n: v.length, meanHalfSpreads: mean(v) }])),
    byTicker: Object.fromEntries(Object.entries(byTicker).map(([k, v]) => [k, { n: v.n, meanError: v.sumErr / v.n }])) };
}
function retuneWeights(reason = 'outcome recorded') {
  const rows = db.prepare("SELECT result, realised_pnl, auto_outcome, target_pnl FROM strategy_runs WHERE method IN ('optimizer','weekly_atr') AND status='OK' AND (realised_pnl IS NOT NULL OR auto_outcome IS NOT NULL)").all()
    .map(r => { const x = JSON.parse(r.result || '{}'), o = outcomeOf(r); return { f: x.best && x.best.factors, exp: x.best ? Math.min(x.best.expected.upExpiry, x.best.expected.downExpiry) : null, real: o && o.pnl, w: o ? o.w : 0, tgt: r.target_pnl }; })
    .filter(r => r.f && Number.isFinite(r.exp) && Number.isFinite(r.real) && r.tgt > 0);
  const cal = calibrationStats(), cur = currentWeights();
  if (rows.length < MIN_CLOSED_FOR_TUNING) return { tuned: false, closedRuns: rows.length, calibration: cal, note: 'Need ' + MIN_CLOSED_FOR_TUNING + ' runs with an outcome (actual or auto after expiry) to tune weights; model v' + cur.id + ' unchanged.' };
  const base = Strategy.DEFAULT_WEIGHTS, w = {}, detail = {}, sw = rows.reduce((m, r) => m + r.w, 0);
  const short = rows.map(r => (r.exp - r.real) / r.tgt); // shortfall vs projection (positive = worse than projected)
  const my = rows.reduce((m, r, i) => m + r.w * short[i], 0) / sw;
  for (const k of Object.keys(base)) {
    const xs = rows.map(r => (r.f[k] ? r.f[k].value : 0)), mx = rows.reduce((m, r, i) => m + r.w * xs[i], 0) / sw;
    const cov = rows.reduce((m, r, i) => m + r.w * (xs[i] - mx) * (short[i] - my), 0), vx = rows.reduce((m, r, i) => m + r.w * (xs[i] - mx) ** 2, 0), vy = rows.reduce((m, r, i) => m + r.w * (short[i] - my) ** 2, 0);
    const corr = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0; // weighted: factor high ↔ worse than projected → raise its weight
    w[k] = Math.round(base[k] * Math.min(2, Math.max(0.5, 1 + corr)) * 100) / 100; detail[k] = { correlationWithShortfall: Math.round(corr * 100) / 100, default: base[k], tuned: w[k] };
  }
  if (JSON.stringify(w) === JSON.stringify(cur.weights)) return { tuned: false, closedRuns: rows.length, calibration: cal, note: 'Weights unchanged by the new outcomes; model v' + cur.id + ' kept.' };
  // never overwrite: every tuning appends a new version (history kept in strategy_weights)
  const id = db.prepare('INSERT INTO strategy_weights(ts,weights,source,closed_runs,detail) VALUES(?,?,?,?,?)').run(Date.now(), JSON.stringify(w), 'tuned (' + reason + ') from ' + rows.length + ' outcomes (actual ×1, auto ×0.5): weight × clamp(1 + corr(factor, shortfall vs projection), 0.5, 2)', rows.length, JSON.stringify({ factors: detail, calibration: cal, previousVersion: cur.id })).lastInsertRowid;
  persist.mark('strategy_weights', id);
  return { tuned: true, version: id, closedRuns: rows.length, weights: w, detail, calibration: cal };
}
// replay the market after expiry for runs without an outcome (Hyperliquid 1h candles of the perp; Nasdaq daily bars otherwise)
async function autoOutcomes(limit = 15) {
  const now = Date.now(), rows = db.prepare("SELECT id, ts, ticker, expiry, perp_symbol, legs, result FROM strategy_runs WHERE status='OK' AND auto_outcome IS NULL AND (auto_checked_at IS NULL OR auto_checked_at < ?) ORDER BY id LIMIT 200").all(now - 6 * 36e5);
  let done = 0;
  for (const r of rows) {
    if (done >= limit) break;
    const close = Strategy.expiryCloseMs(r.expiry); if (!(close + 36e5 < now)) continue;
    db.prepare('UPDATE strategy_runs SET auto_checked_at=? WHERE id=?').run(now, r.id);
    try {
      const x = JSON.parse(r.result || '{}'), bst = x.best, L = JSON.parse(r.legs || '{}'); if (!bst || !L.legs) continue;
      const up = bst.exits[0].price, dn = bst.exits[1].price, basis = x.basis || 0, entry = (L.futures && L.futures.entry) || bst.futures.entry, qty = (L.futures && L.futures.signedQty) ?? bst.futures.signedQty;
      let bars = null, src = null;
      if (r.perp_symbol && !String(r.perp_symbol).startsWith('STOCK')) { try { const c = await hl.candles('mainnet', r.perp_symbol, '1h', Math.min(5000, Math.ceil((now - r.ts) / 36e5) + 2)); bars = c.filter(k => k.t >= r.ts - 36e5 && k.t <= close).map(k => ({ t: k.t, h: k.h - basis, l: k.l - basis, c: k.c - basis })); src = 'Hyperliquid 1h (perp − entry basis)'; } catch {} }
      if (!bars || !bars.length) { const d = await nasdaqDaily(r.ticker); if (d) { bars = d.times.map((t, i) => ({ t: Date.parse(t + ' 16:00 GMT-0400'), c: d.closes[i], h: d.closes[i], l: d.closes[i] })).filter(b2 => b2.t >= r.ts && b2.t <= close + 864e5); src = 'Nasdaq daily closes'; } }
      if (!bars || !bars.length) { db.prepare('UPDATE strategy_runs SET auto_outcome=? WHERE id=?').run(JSON.stringify({ error: 'no price history', checkedAt: now }), r.id); continue; }
      const ev = Strategy.evaluate({ legs: L.legs, future: { qty, entry, basis }, commission: (x.cfg || {}).commission ?? 0.65, futureFeePct: (x.cfg || {}).futureFeePct ?? 0.045, leverage: (x.cfg || {}).marginDivisor ?? 2, r: 0.04, nowMs: r.ts, expiryMs: close });
      const mm = (x.cfg || {}).mmLoss ?? 50; let out = null;
      for (const b2 of bars) { const which = b2.h >= up ? 'CE' : b2.l <= dn ? 'PE' : null; if (which) { const px = which === 'CE' ? up : dn, daysAhead = Math.max(0, (b2.t - r.ts) / 864e5); out = { exit: which, at: new Date(b2.t).toISOString(), price: px, pnl: (b2.t >= close ? ev.expiry(px) : ev.at(px, daysAhead)) - mm }; break; } }
      const last = bars[bars.length - 1];
      if (!out) out = { exit: null, at: new Date(last.t).toISOString(), price: last.c, pnl: ev.expiry(last.c) - mm };
      const projected = Math.min(bst.expected.upExpiry, bst.expected.downExpiry);
      db.prepare('UPDATE strategy_runs SET auto_outcome=? WHERE id=?').run(JSON.stringify({ ...out, projected, error: out.pnl - projected, source: src, model: 'first touch of an exit → P&L at that time with entry IVs (Black-Scholes); otherwise P&L at the expiry close', checkedAt: now }), r.id);
      persist.mark('strategy_runs', r.id); done++;
    } catch (e) { log.warn('auto_outcome.failed', { id: r.id, error: e.message }); }
  }
  if (done) { const t = retuneWeights('auto outcomes'); log.info('learning.pass', { autoOutcomes: done, tuned: t.tuned, version: t.version || null }); }
  return done;
}
let learnTimer = null;
function startLearningLoop() { if (learnTimer || process.env.NODE_ENV === 'test') return; learnTimer = setInterval(() => autoOutcomes().catch(e => log.warn('learning.loop_failed', { error: e.message })), 30 * 6e4); learnTimer.unref(); setTimeout(() => autoOutcomes().catch(() => {}), 60e3).unref(); }

// ---- ticker → Hyperliquid US stock perp
async function perpFor(ticker, stockSymbols) {
  const list = await stockSymbols(), t = ticker.toUpperCase();
  const sym = list.find(s => s === 'xyz:' + t) || list.find(s => s.split(':')[1] === t);
  if (!sym) return { available: false, reason: `No Hyperliquid US stock perp for ${t} (checked ${list.length} listed US-stock perps).` };
  try {
    const [book, meta] = await Promise.all([deriv.perpBook(sym), deriv.perpMeta(sym)]);
    if (!meta) return { available: false, symbol: sym, reason: sym + ' metadata unavailable' };
    return { available: true, symbol: sym, bid: book.bid, ask: book.ask, mid: book.mid, time: new Date(book.time).toISOString(), szDecimals: meta.szDecimals, maxLeverage: meta.maxLeverage, funding: Number.isFinite(meta.funding) ? meta.funding : null, bids: undefined };
  } catch (e) { return { available: false, symbol: sym, reason: e.message }; }
}
function whatIfSummary(w) {
  if (!w) return null;
  return { probs: w.probs, tail: { maxLossExpiry: w.tail.maxLossExpiry, unlimitedLoss: w.tail.unlimitedLoss, worst2Sigma: w.tail.worst2Sigma, sigma2: w.tail.sigma2, sigma3: w.tail.sigma3 }, robustness: { ...w.robustness, worstCell: w.robustness.worstCell },
    thetaPerDay: w.theta.optionsPerDay, execution: { exitsAtMid: w.execution.exitsAtMid, exitsAtHaircut: w.execution.exitsAtHaircut, exitsAtFullSpread: w.execution.exitsAtFullSpread, funding: w.execution.funding }, events: w.events, gates: w.gates, acceptable: w.acceptable };
}
const T_RE = /^[A-Z][A-Z0-9.]{0,9}$/;
const tick = s => { const t = String(s || '').trim().toUpperCase(); if (!T_RE.test(t)) throw httpErr(400, 'Enter a valid US ticker, e.g. NVDA'); return t; };
const num = (v, d) => (v === '' || v == null ? d : Number(v));

const weeklyAtrRecord = (w) => (w ? { method: 'weekly_atr', atr: w.atr, effectiveAtr: w.effectiveAtr, n: w.n, upperMult: w.upperMult, lowerMult: w.lowerMult, multSource: w.multSource, zoneMinSigma: w.zoneMinSigma, zoneMaxSigma: w.zoneMaxSigma, ceRawTarget: w.ceRawTarget, peRawTarget: w.peRawTarget, ceClamped: w.ceClamped, peClamped: w.peClamped, scaleToExpiry: w.scaleToExpiry, scale: w.scale, tradingDays: w.tradingDays, source: w.source, sourceKind: w.sourceKind,
  spot: w.spot, ceTarget: w.ceTarget, peTarget: w.peTarget, ceShort: w.ceShort, peShort: w.peShort, ceDistance: w.ceDistance, peDistance: w.peDistance, firstWeek: w.firstWeek, lastWeek: w.lastWeek } : null);
// optimizer short-distance band + the chosen distances (training data)
const distanceRecord = (out) => { const b = out.distanceBand, best = out.best;
  return { band: { mode: b.mode, sheetBandLow: b.sheetBandLow, sheetBandHigh: b.sheetBandHigh, minShortSigma: b.minShortSigma, minShortAtr: b.minShortAtr, maxShortSigma: b.maxShortSigma, sigma: b.sigma, weeklyAtr: b.weeklyAtr, weeklyAtrSource: b.weeklyAtrSource, anchorSource: b.anchorSource, fallback: b.fallback,
      variants: b.variants.map(v => ({ side: v.side, variant: v.variant, group: v.group, groupSource: v.groupSource, groupN: v.groupN, debitLongSigma: v.debitLongSigma, wingSigma: v.wingSigma, sheet: v.sheet, ce: v.ce, pe: v.pe, fallback: !!v.fallback })) },
    anchor: b.anchor, pairsTested: out.pairsTested ?? null, chosen: best && best.distances ? best.distances : null, chosenVariant: best ? best.futuresSide + ' ' + best.variant : null, chosenSigmas: best ? best.sigmas : null,
    pairs: (out.distancePairs || []).map(p => ({ side: p.side, variant: p.variant, ce: p.ce.strike, pe: p.pe.strike, ceSigmas: p.ce.sigmas, peSigmas: p.pe.sigmas, ceSheetSigmas: p.ce.sheet ? p.ce.sheet.sigmas : null, peSheetSigmas: p.pe.sheet ? p.pe.sheet.sigmas : null, sheetRef: p.sheetRef, exitUp: p.exitUp, exitDown: p.exitDown, pop: p.pop, ev: p.ev, worst2Sigma: p.worst2Sigma, score: p.score, chosen: p.chosen })) }; };
function saveRun({ out, chain, perp, t, expiry, method, cfg, market, source, planId, multiplier }) {
    const quoteTimes = chain.contracts.map(q => Date.parse(q.quoteTime)).filter(Number.isFinite);
    const quoteTime = quoteTimes.length ? new Date(Math.max(...quoteTimes)).toISOString() : chain.stock?.time || null;
    const data = { provider: chain.provider, label: chain.label, feed: chain.feed, delayed: !!chain.delayed, quoteTime, ageMinutes: quoteTime ? Math.round((Date.now() - Date.parse(quoteTime)) / 6e4) : null, stockSource: chain.stock?.source || null, partial: !!chain.partial, contractsAtExpiry: chain.contracts.length };
    const best = out.best, now = Date.now();
    const row = { ts: now, ticker: t, expiry, method, status: out.status, provider: chain.label, quote_time: quoteTime, spot: out.spot ?? null, atm_iv: out.atmIV ?? null, perp_symbol: perp.symbol || null,
      futures_qty: best?.futures?.signedQty ?? null, target_pnl: (out.cfg && out.cfg.targetPnl) ?? cfg.targetPnl ?? null, expected_up: best?.expected?.upExpiry ?? best?.target?.pnlAtTargetPrice ?? null, expected_down: best?.expected?.downExpiry ?? null, required_capital: best?.requiredCapital ?? null,
      inputs: JSON.stringify({ ticker: t, expiry, method, cfg, ...(out.weeklyAtr ? { weeklyAtr: weeklyAtrRecord(out.weeklyAtr) } : {}), ...(out.distanceBand ? { distanceBand: distanceRecord(out) } : {}) }), chain_summary: JSON.stringify({ ...data, liquidity: out.liquidity, atmIV: out.atmIV, expectedMove: out.expectedMove, spot: out.spot, basis: out.basis }),
      legs: JSON.stringify(best ? { legs: best.legs.map(({ greeks, ...l }) => ({ ...l, delta: greeks?.delta })), futures: best.futures } : null),
      result: JSON.stringify({ ...out, considered: undefined, best: best ? { ...best, curve: undefined, whatIf: whatIfSummary(best.whatIf) } : undefined, rejected: undefined, variants: undefined,
        alternatives: (out.alternatives || []).map(a => ({ variant: a.variant, side: a.futuresSide, legs: a.legs.map(l => (l.side === 'buy' ? '+' : '-') + l.qty + ' ' + l.strike + l.type[0].toUpperCase()).join(' '), perpQty: a.futures.signedQty, capital: a.capital.total, exits: a.exits.map(x => x.pnlExpiry), score: a.score, whatIf: whatIfSummary(a.whatIf) })) }),
      recommended_variant: out.recommendation && out.recommendation.id ? out.recommendation.id : null,
      variants: out.variants ? JSON.stringify(out.variants.map(({ best: vb, alternatives, ...v }) => ({ ...v, whatIf: vb ? whatIfSummary(vb.whatIf) : null }))) : null };
    const lotSets = best && best.lotSets ? best.lotSets : null;
    const { recommended_variant: recV, variants: varJson, ...baseRow } = row;
    const id = out.status === 'INVALID' ? null : ins.run(baseRow).lastInsertRowid;
    if (id) {
      const legIV = best ? best.legs.map(l => ({ contract: l.contract, iv: l.iv, bid: l.bid, ask: l.ask, mid: l.mid, oi: l.openInterest ?? null, vol: l.volume ?? null })) : null;
      db.prepare('UPDATE strategy_runs SET recommended_variant=?, variants=?, lot_sets=?, source=?, plan_id=?, market=?, considered=?, multiplier=?, model_version=? WHERE id=?').run(recV, varJson, lotSets, source || 'builder', planId || null,
        JSON.stringify({ indicators: market || null, spot: out.spot ?? null, atmIV: out.atmIV ?? null, expectedMove: out.expectedMove ?? null, basis: out.basis ?? null, ivSkew: out.ivSkew || null, quoteTime, source: chain.label, delayed: !!chain.delayed, perp: perp ? { symbol: perp.symbol, bid: perp.bid, ask: perp.ask, funding: perp.funding ?? null } : null, legs: legIV, direction: out.direction || null, events: best && best.whatIf ? best.whatIf.events : null }),
        out.considered ? JSON.stringify(out.considered) : null, multiplier || 1, out.weightsInfo ? out.weightsInfo.id : null, id);
      if (out.weeklyAtr) db.prepare('UPDATE strategy_runs SET weekly_atr=? WHERE id=?').run(JSON.stringify(weeklyAtrRecord(out.weeklyAtr)), id);
      if (out.distanceBand) db.prepare('UPDATE strategy_runs SET distance_band=? WHERE id=?').run(JSON.stringify(distanceRecord(out)), id);
      changed('strategy_runs', id);
    }
    return { id, data };
}
function router({ stockSymbols }) {
  const r = express.Router();
  startLearningLoop();
  const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(e.status || 400).json({ error: e.message }));
  r.get('/strategy/provider', (req, res) => res.json(deriv.providerInfo()));
  r.get('/strategy/expiries', wrap(async (req, res) => {
    const t = tick(req.query.ticker);
    const [ex, perp] = await Promise.all([withRetry(() => deriv.getExpiries(t)).catch(e => { throw httpErr(502, friendlyFetchError(e)); }), perpFor(t, stockSymbols)]);
    const today = new Date().toISOString().slice(0, 10);
    ex.expiries = ex.expiries.filter(e => e.date >= today).map(e => ({ ...e, dte: Math.round((Strategy.expiryCloseMs(e.date) - Date.now()) / 864e5 * 10) / 10 }));
    if (!ex.expiries.length) throw httpErr(404, 'No unexpired listed options for ' + t);
    res.json({ ticker: t, ...ex, perp, calibration: calibration(t) });
  }));
  // option chain + greeks + gamma exposure for one expiry (merged from the retired Options Studio / Gamma Book pages)
  r.get('/strategy/chain', wrap(async (req, res) => {
    const t = tick(req.query.ticker), expiry = String(req.query.expiry || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw httpErr(400, 'expiry=YYYY-MM-DD required');
    const chain = await withRetry(() => deriv.getChain({ symbol: t, near: expiry, far: expiry })).catch(e => { throw httpErr(502, friendlyFetchError(e)); });
    const spot = chain.stock && chain.stock.price, by = new Map();
    for (const c of chain.contracts) { const k = c.strike, row = by.get(k) || { strike: k }; row[c.type] = { bid: c.bid, ask: c.ask, mid: c.mid ?? (c.bid + c.ask) / 2, iv: c.iv, delta: c.greeks && c.greeks.delta, gamma: c.greeks && c.greeks.gamma, theta: c.greeks && c.greeks.theta, vega: c.greeks && c.greeks.vega, oi: c.openInterest ?? null, vol: c.volume ?? null }; by.set(k, row); }
    let rows = [...by.values()].sort((a2, b2) => a2.strike - b2.strike);
    if (spot) { const i = rows.findIndex(r2 => r2.strike >= spot); rows = rows.slice(Math.max(0, i - 15), i + 15); }
    // dealer gamma exposure proxy: Σ gamma × OI × 100 × S² × 1% (calls +, puts −) — the "GEX" convention; dealers' real positions are unknown
    for (const r2 of rows) r2.gex = spot ? ((r2.call && r2.call.gamma && r2.call.oi ? r2.call.gamma * r2.call.oi : 0) - (r2.put && r2.put.gamma && r2.put.oi ? r2.put.gamma * r2.put.oi : 0)) * 100 * spot * spot * 0.01 : null;
    const qt = chain.contracts.map(q => Date.parse(q.quoteTime)).filter(Number.isFinite);
    res.json({ ticker: t, expiry, spot, source: chain.label, delayed: !!chain.delayed, quoteTime: qt.length ? new Date(Math.max(...qt)).toISOString() : null, rows, totalGex: rows.reduce((m, r2) => m + (r2.gex || 0), 0), note: 'GEX assumes dealers are long calls / short puts (common convention); it is an indicator, not a measured position.' });
  }));
  r.post('/strategy/build', wrap(async (req, res) => {
    const b = req.body || {}, t = tick(b.ticker), notices = [];
    let expiry = String(b.expiry || '');
    const method = b.method === 'delta' ? 'delta' : b.method === 'reference' ? 'reference' : b.method === 'weekly_atr' ? 'weekly_atr' : 'optimizer';
    const opt = method === 'optimizer' || method === 'weekly_atr'; // weekly ATR = the optimizer's machinery with the two short strikes fixed
    // expiry: must be a listed, unexpired expiry; otherwise use the nearest valid one (≥ 1 day) and say so
    const ex = await withRetry(() => deriv.getExpiries(t)).catch(e => { throw httpErr(502, friendlyFetchError(e)); }), today = new Date().toISOString().slice(0, 10), listed = (ex.expiries || []).filter(e => e.date >= today).map(e => e.date);
    if (!listed.length) throw httpErr(404, 'No unexpired listed options for ' + t + ' (is it optionable?)');
    if (!listed.includes(expiry)) {
      const want = /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? expiry : null, cands = listed.filter(d => (Strategy.expiryCloseMs(d) - Date.now()) / 864e5 >= 1);
      const pick = want ? (cands.find(d => d >= want) || cands.at(-1) || listed[0]) : (cands.find(d => (Strategy.expiryCloseMs(d) - Date.now()) / 864e5 >= 2) || cands[0] || listed[0]);
      notices.push(want ? `${t} has no options expiring ${want} (no weekly on that date?); using the nearest listed expiry ${pick}.` : `No expiry chosen; using ${pick}.`);
      expiry = pick;
    }
    const [chain, perp] = await Promise.all([withRetry(() => deriv.getChain({ symbol: t, near: expiry, far: expiry })).catch(e => { throw httpErr(502, friendlyFetchError(e)); }), perpFor(t, stockSymbols)]);
    const c = b.cfg || {};
    let atrOpts = null;
    if (method === 'weekly_atr') {
      const sheetMult = (x) => x === undefined || x === null || x === '' || x === 'sheet'; // blank = the sheets' own × ATR for this ticker (pooled fallback)
      const am = sheetMult(c.upperMult) || sheetMult(c.lowerMult) ? sheetAnchor(ticker).atrMultiples : null, r2m = (x, d) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : d);
      atrOpts = { n: num(c.atrPeriod, 14), upperMult: sheetMult(c.upperMult) ? r2m(am && am.ce, 0.42) : num(c.upperMult, 0.42), lowerMult: sheetMult(c.lowerMult) ? r2m(am && am.pe, 0.41) : num(c.lowerMult, 0.41), multSource: sheetMult(c.upperMult) || sheetMult(c.lowerMult) ? (am ? am.source : 'pooled sheet medians') : 'user', zoneMinSigma: c.zoneMinSigma === undefined ? 0.7 : num(c.zoneMinSigma, null), zoneMaxSigma: c.zoneMaxSigma === undefined ? 1.2 : num(c.zoneMaxSigma, null), scaleToExpiry: c.scaleToExpiry === true || c.scaleToExpiry === 'true', source: ['perp', 'stock'].includes(c.atrSource) ? c.atrSource : 'auto' };
      const bad = Strategy.validateWeeklyAtr({ atr: 1, ...atrOpts }); if (bad.length) throw httpErr(400, bad.join('; '));
    }
    const [market, events, wAtr] = method === 'delta' ? [null, null, null] : await Promise.all([marketFor(perp), opt ? eventsFor(t).catch(e => ({ notes: [e.message] })) : null, method === 'weekly_atr' ? weeklyAtrFor(t, perp, atrOpts) : method === 'optimizer' ? weeklyAtrFor(t, perp, { n: 14 }).catch(e => ({ error: e.message })) : null]);
    const cal = calibration(t), anchor = method === 'optimizer' ? await sheetAnchorWithAtr(t) : null;
    const W = opt ? currentWeights() : null;
    const cfg = opt
      ? { targetMode: c.targetMode === 'fixed' ? 'fixed' : 'perLotSet', targetPerLotSet: num(c.targetPerLotSet, tickerTarget(getAccount(), t)), lotSets: num(c.lotSets, getAccount().defaultLotSets),
          targetPnl: c.targetMode === 'fixed' ? num(c.targetPnl ?? b.targetPnl) : null, direction: ['BULLISH', 'BEARISH', 'BOTH'].includes(c.direction) ? c.direction : ['BULLISH', 'BEARISH'].includes(c.signal) ? c.signal : 'AUTO',
          callLotUnits: num(c.callLotUnits, null), putLotUnits: num(c.putLotUnits, null), slippage: num(c.slippage, 0.5), capital: num(c.capital, null), maxLossPct: num(c.maxLossPct, null), minOpenInterest: num(c.minOpenInterest, 10),
          maxSpreadPct: num(c.maxSpreadPct, 25), maxLots: num(c.maxLots, 60), mmLoss: num(c.mmLoss, 50), marginDivisor: num(c.marginDivisor, 2), leverage: num(c.leverage, 5), futuresRound: num(c.futuresRound, 5), commission: num(c.commission, 0.65), futureFeePct: num(c.futureFeePct, 0.045), maxPriceGapPct: num(c.maxPriceGapPct, 5), account: accountLimitsForBuild(), minShortSigma: c.minShortSigma === undefined ? 0.7 : num(c.minShortSigma, null), minShortAtr: num(c.minShortAtr, null), maxShortSigma: num(c.maxShortSigma, 1.2), sheetBandLow: num(c.sheetBandLow, 0.8), sheetBandHigh: num(c.sheetBandHigh, 1.3),
          ...(atrOpts ? { atrPeriod: atrOpts.n, upperMult: atrOpts.upperMult, lowerMult: atrOpts.lowerMult, zoneMinSigma: atrOpts.zoneMinSigma, zoneMaxSigma: atrOpts.zoneMaxSigma, scaleToExpiry: atrOpts.scaleToExpiry, atrSource: atrOpts.source } : {}) }
      : method === 'reference'
      ? { signal: ['BULLISH', 'BEARISH', 'AUTO'].includes(c.signal) ? c.signal : (['LONG', 'SHORT'].includes(c.futuresSide) ? (c.futuresSide === 'LONG' ? 'BULLISH' : 'BEARISH') : 'AUTO'),
          callLotUnits: num(c.callLotUnits, null), putLotUnits: num(c.putLotUnits, null), futuresSide: ['LONG', 'SHORT'].includes(c.futuresSide) ? c.futuresSide : undefined, futuresRound: num(c.futuresRound, 5), futuresFactor: num(c.futuresFactor, 1), marginDivisor: num(c.marginDivisor, 2), maxPriceGapPct: num(c.maxPriceGapPct, 5), targetPnl: num(c.targetPnl), capital: num(c.capital), maxLossPct: num(c.maxLossPct, 50), mmLoss: num(c.mmLoss, 50), maxSpreadPct: num(c.maxSpreadPct, 25), maxLots: num(c.maxLots, 30), leverage: num(c.leverage, 5), commission: num(c.commission, 0.65), futureFeePct: num(c.futureFeePct, 0.045),
          ...(c.useCalibration === false ? {} : { debitLongSigma: cal.debitLongSigma, debitShortSigma: cal.debitShortSigma, creditShortSigma: cal.creditShortSigma, wingSigma: cal.wingSigma }),
          ...Object.fromEntries(['debitShortSigma', 'creditShortSigma', 'wingSigma'].filter(k => c[k] !== '' && c[k] != null && Number.isFinite(Number(c[k]))).map(k => [k, Number(c[k])])) }
      : { direction: ['LONG', 'SHORT', 'NEUTRAL'].includes(c.direction) ? c.direction : 'LONG', targetPnl: num(c.targetPnl), capital: num(c.capital), maxLossPct: num(c.maxLossPct, 50), ratio: num(c.ratio, 2), directionalPct: num(c.directionalPct, 25), maxSpreadPct: num(c.maxSpreadPct, 25), maxScale: num(c.maxLots, 25), leverage: num(c.leverage, 5), commission: num(c.commission, 0.65), futureFeePct: num(c.futureFeePct, 0.045) };
    const input = { ticker: t, expiry, contracts: chain.contracts, stock: chain.stock, perp, cfg, market: market && !market.error ? market : null, referenceLots: referenceLots(), events, weights: W ? W.weights : undefined };
    if (opt && market && market.error) input.market = market; // decideDirection explains the failure
    if (method === 'optimizer') { input.bandAtr = wAtr && !wAtr.error ? { atr: wAtr.atr, source: wAtr.source } : { error: (wAtr && wAtr.error) || 'not fetched' }; input.sheetAnchor = anchor; }
    if (method === 'weekly_atr' && wAtr) input.weeklyAtr = { ...wAtr, upperMult: atrOpts.upperMult, lowerMult: atrOpts.lowerMult, multSource: atrOpts.multSource, zoneMinSigma: atrOpts.zoneMinSigma, zoneMaxSigma: atrOpts.zoneMaxSigma, scaleToExpiry: atrOpts.scaleToExpiry, tradingDays: Strategy.tradingDaysTo(expiry), debitLongSigma: c.useCalibration === false ? 0.1 : cal.debitLongSigma, wingSigma: c.useCalibration === false ? 0.47 : cal.wingSigma };
    const out = opt ? Strategy.optimize(input) : method === 'reference' ? Strategy.buildReference(input) : Strategy.build(input);
    if (notices.length) out.warnings = [...notices, ...(out.warnings || [])];
    if (W) out.weightsInfo = { id: W.id, source: W.source, closedRuns: W.closed_runs };
    const best = out.best, { id, data } = saveRun({ out, chain, perp, t, expiry, method, cfg, market, source: 'builder' });
    if (market && market.error) out.marketNote = market.error;
    res.json({ id, data, perp, market, calibration: method === 'reference' ? cal : null, ...out,
      execution: best ? { enabled: false, reason: 'Order execution is not enabled. A later "Execute on Alpaca" step will submit this as one multi-leg (mleg) limit order; the perp leg is sent separately to Hyperliquid.', alpacaOrderPreview: Strategy.alpacaOrderPreview(best.legs) } : null });
  }));
  r.get('/strategy/history', wrap(async (req, res) => {
    const t = req.query.ticker ? tick(req.query.ticker) : null, lim = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = db.prepare(`SELECT id,ts,ticker,expiry,method,status,provider,quote_time,spot,atm_iv,perp_symbol,futures_qty,target_pnl,expected_up,expected_down,required_capital,legs,realised_pnl,realised_at,outcome_notes,recommended_variant,chosen_variant,lot_sets,source,plan_id,multiplier,model_version,taken,entry_fills,exit_fills,closed_at,auto_outcome,weekly_atr,distance_band FROM strategy_runs ${t ? 'WHERE ticker=?' : ''} ORDER BY id DESC LIMIT ${lim}`).all(...(t ? [t] : []));
    res.json({ runs: rows.map(x => ({ ...x, legs: x.legs ? JSON.parse(x.legs) : null, entry_fills: x.entry_fills ? JSON.parse(x.entry_fills) : null, exit_fills: x.exit_fills ? JSON.parse(x.exit_fills) : null, auto_outcome: x.auto_outcome ? JSON.parse(x.auto_outcome) : null, weekly_atr: x.weekly_atr ? JSON.parse(x.weekly_atr) : null, distance_band: x.distance_band ? JSON.parse(x.distance_band) : null })) });
  }));
  r.get('/strategy/history/:id', wrap(async (req, res) => {
    const x = db.prepare('SELECT * FROM strategy_runs WHERE id=?').get(Number(req.params.id)); if (!x) throw httpErr(404, 'Not found');
    for (const k of ['inputs', 'chain_summary', 'legs', 'result', 'variants', 'weekly_atr', 'distance_band']) x[k] = x[k] ? JSON.parse(x[k]) : null;
    res.json(x);
  }));
  r.post('/strategy/history/:id/outcome', wrap(async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}, pnl = Number(b.realisedPnl);
    if (!Number.isFinite(pnl) || Math.abs(pnl) > 1e9) throw httpErr(400, 'Realised P&L must be a number');
    const notes = String(b.notes || '').slice(0, 500);
    const info = db.prepare('UPDATE strategy_runs SET realised_pnl=?, realised_at=?, outcome_notes=? WHERE id=?').run(pnl, Date.now(), notes, id);
    if (!info.changes) throw httpErr(404, 'Run not found');
    const tuned = retuneWeights(); changed('strategy_runs', id); changed('strategy_weights', 'all');
    res.json({ ok: true, id, realisedPnl: pnl, weights: tuned });
  }));
  // Record which lot-ratio variant the user chose for a run (legs / perp qty / capital follow the chosen variant).
  r.post('/strategy/history/:id/variant', wrap(async (req, res) => {
    const id = Number(req.params.id), want = String((req.body || {}).variant || '');
    const x = db.prepare('SELECT variants FROM strategy_runs WHERE id=?').get(id); if (!x) throw httpErr(404, 'Run not found');
    const v = (x.variants ? JSON.parse(x.variants) : []).find(z => z.id === want);
    if (!v) throw httpErr(400, 'Unknown variant for this run'); if (!v.reachable) throw httpErr(400, 'That variant does not reach the target');
    db.prepare('UPDATE strategy_runs SET chosen_variant=?, legs=?, futures_qty=?, required_capital=?, expected_up=?, expected_down=? WHERE id=?')
      .run(v.id, JSON.stringify({ legs: v.legs, futures: { signedQty: v.perpQty } }), v.perpQty, v.totalCapital, v.exits[0].pnlExpiry, v.exits[1].pnlExpiry, id);
    changed('strategy_runs', id); res.json({ ok: true, id, chosenVariant: v.id });
  }));
  // ---- account settings, weekly P&L vs target, weekly plan
  r.get('/strategy/account', (req, res) => res.json(getAccount()));
  r.get('/strategy/export', (req, res) => { res.setHeader('Content-Disposition', 'attachment; filename="quantsignal-strategy-' + new Date().toISOString().slice(0, 10) + '.json"'); res.json(exportAll()); });
  r.post('/strategy/import', wrap(async (req, res) => { const out = importAll(req.body); for (const t of Object.keys(persist.TABLES)) changed(t, 'all'); res.json({ ok: true, ...out }); }));
  r.get('/strategy/storage', (req, res) => res.json({ ...persist.status(), restore: restoreInfo, runs: db.prepare('SELECT COUNT(*) n FROM strategy_runs').get().n }));
  r.put('/strategy/account', wrap(async (req, res) => res.json(setAccount(req.body || {}))));
  r.get('/strategy/performance-by-lots', (req, res) => {
    const rows = db.prepare("SELECT lot_sets, target_pnl, expected_up, expected_down, realised_pnl, required_capital FROM strategy_runs WHERE status='OK'").all(), by = new Map();
    for (const x of rows) { const k = x.lot_sets || 0, g = by.get(k) || { lotSets: k || null, runs: 0, closed: 0, realised: 0, wins: 0, hitTarget: 0, sumTarget: 0, sumRatio: 0, sumCapital: 0, worst: null }; g.runs++; g.sumCapital += x.required_capital || 0;
      if (x.realised_pnl != null) { g.closed++; g.realised += x.realised_pnl; if (x.realised_pnl > 0) g.wins++; if (x.target_pnl && x.realised_pnl >= x.target_pnl) g.hitTarget++; g.sumTarget += x.target_pnl || 0; g.sumRatio += x.target_pnl ? x.realised_pnl / x.target_pnl : 0; g.worst = g.worst == null ? x.realised_pnl : Math.min(g.worst, x.realised_pnl); }
      by.set(k, g); }
    const out = [...by.values()].sort((a, b) => (a.lotSets || 0) - (b.lotSets || 0)).map(g => ({ lotSets: g.lotSets, runs: g.runs, closed: g.closed, totalRealised: g.realised, avgRealised: g.closed ? g.realised / g.closed : null, winRate: g.closed ? g.wins / g.closed : null, targetHitRate: g.closed ? g.hitTarget / g.closed : null, avgRealisedVsTarget: g.closed ? g.sumRatio / g.closed : null, avgCapital: g.runs ? g.sumCapital / g.runs : null, worst: g.worst }));
    const base = out.find(g => g.lotSets === 1), note = !out.some(g => g.closed >= 5) ? 'Not enough closed runs to judge scaling yet (need ≥ 5 closed runs at a size). Record realised P&L in History.' : base && base.closed >= 5 && base.avgRealisedVsTarget >= 0.8 && base.worst > -getAccount().maxLossPerTrade ? 'At 1 lot set, results average ' + Math.round(base.avgRealisedVsTarget * 100) + '% of target with no loss beyond the per-trade cap: scaling up one step is supported by the data so far.' : 'Results at the current size do not yet justify scaling up (average below 80% of target or a loss beyond the per-trade cap).';
    res.json({ bySize: out, note });
  });
  r.get('/strategy/weekly-pnl', wrap(async (req, res) => res.json(weeklyPnl(Math.min(52, Number(req.query.weeks) || 12)))));
  const planCache = new Map();
  r.get('/strategy/universe', (req, res) => res.json({ universe: PLAN_UNIVERSE }));
  r.post('/strategy/weekly-plan', wrap(async (req, res) => {
    const b = req.body || {}, acct = getAccount(), lim = accountLimitsForBuild();
    const list = Array.isArray(b.tickers) && b.tickers.length ? b.tickers : PLAN_UNIVERSE.map(u => u.ticker);
    const tickers = [...new Set(list.map(tick))].slice(0, 24), sectorOf = (t) => (PLAN_UNIVERSE.find(u => u.ticker === t) || {}).sector || 'Other';
    const lotList = (Array.isArray(b.lotSets) && b.lotSets.length ? b.lotSets : [1, 2, 3]).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 20).slice(0, 4);
    if (!lotList.length) throw httpErr(400, 'Lot sets must be whole numbers 1–20');
    const key = JSON.stringify([tickers, lotList, acct, lim.weeklyLossRemaining]), hit = planCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 6e4) return res.json({ ...hit.v, cached: true });
    const W = currentWeights(), perTicker = [];
    const one = async (t) => {
      const ex = await withRetry(() => deriv.getExpiries(t)), dte = (d) => (Strategy.expiryCloseMs(d) - Date.now()) / 864e5;
      const listed = (ex.expiries || []).map(e => e.date).filter(d => dte(d) >= 1); if (!listed.length) return { ticker: t, sector: sectorOf(t), error: 'no listed expiry ≥ 1 day away' };
      const expiry = listed.find(d => dte(d) <= 9) || listed[0];
      const [chain, perp] = await Promise.all([withRetry(() => deriv.getChain({ symbol: t, near: expiry, far: expiry })), perpFor(t, stockSymbols)]);
      const [market, events, hlR, nqR, wAtr] = await Promise.all([marketFor(perp), eventsFor(t).catch(() => null), returnsFor(t, perp), nasdaqDaily(t), weeklyAtrFor(t, perp, { n: 14 }).catch(e => ({ error: e.message }))]);
      const cfg = { ...Strategy.OPT_DEFAULTS, targetMode: 'perLotSet', targetPerLotSet: tickerTarget(acct, t), lotSets: 1, direction: 'AUTO', account: lim };
      const out = Strategy.optimize({ ticker: t, expiry, contracts: chain.contracts, stock: chain.stock, perp, cfg, market: market && !market.error ? market : null, referenceLots: referenceLots(), events, weights: W.weights, bandAtr: wAtr && !wAtr.error ? { atr: wAtr.atr, source: wAtr.source } : { error: wAtr && wAtr.error }, sheetAnchor: sheetAnchor(t) });
      return { ticker: t, sector: sectorOf(t), expiry, perp, hlR, nqR, out, chain, market, cfg };
    };
    for (let i = 0; i < tickers.length; i += 4) perTicker.push(...(await Promise.all(tickers.slice(i, i + 4).map(t => one(t).catch(e => ({ ticker: t, sector: sectorOf(t), error: friendlyFetchError(e) }))))));
    const corrCache = new Map(), corr = (a, c) => { const k = [a.ticker, c.ticker].sort().join('/'); if (!corrCache.has(k)) { const h = corrOf(a.hlR, c.hlR), q = h == null ? corrOf(a.nqR, c.nqR) : null; corrCache.set(k, h != null ? { rho: h, source: 'Hyperliquid 1h returns' } : q != null ? { rho: q, source: 'Nasdaq daily returns' } : { rho: 0.8, source: 'unknown — assumed 0.8 (conservative)' }); } return corrCache.get(k); };
    const ok = perTicker.filter(x => !x.error && x.out.status === 'OK');
    const plans = lotList.map((L) => {
      const items = ok.map((x) => {
        const sc = Strategy.rescale(x.out, x.out.best, L * (x.out.best.lotSets || 1)), w = sc.whatIf, a = w.account;
        const ev = Strategy.evaluate({ legs: sc.legs, future: { qty: sc.perpQty, entry: x.out.best.futures.entry, basis: x.out.basis || 0 }, commission: x.out.cfg.commission, futureFeePct: x.out.cfg.futureFeePct, leverage: x.out.cfg.marginDivisor, r: x.out.cfg.r, nowMs: Date.now(), expiryMs: Strategy.expiryCloseMs(x.expiry) });
        return { x, sc, ev, riskLoss: a.riskLoss, rr: a.rewardToRisk, pProfit: w.probs.profit, evv: w.probs.expectedValue, rank: (a.rewardToRisk || 0) * w.probs.profit };
      }).sort((p, q) => q.rank - p.rank);
      const per = items.length ? items.reduce((m, it) => m + it.sc.target, 0) / items.length : acct.targetPerLotSet * L, needed = Math.ceil(acct.weeklyTargetMin / Math.max(1, per));
      const sel = [], skipped = [], sectors = {}; let cap = 0, risk = 0, tgt = 0;
      for (const it of items) {
        const t = it.x.ticker, why = [];
        if (!it.sc.ok) why.push(...it.sc.flags);
        if ((sectors[it.x.sector] || 0) >= acct.maxPerSector) why.push('sector ' + it.x.sector + ' already has ' + acct.maxPerSector);
        const hiCorr = sel.map(s2 => ({ t: s2.x.ticker, ...corr(it.x, s2.x) })).filter(c => Math.abs(c.rho) > acct.maxPairCorrelation);
        if (hiCorr.length) why.push('correlated with ' + hiCorr.map(c => c.t + ' ρ ' + c.rho.toFixed(2) + (/assumed/.test(c.source) ? ' (assumed)' : '')).join(', '));
        if (cap + it.sc.capital > acct.capital) why.push('capital: would use $' + Math.round(cap + it.sc.capital).toLocaleString('en-US') + ' of $' + acct.capital.toLocaleString('en-US'));
        if (risk + it.riskLoss > lim.weeklyLossRemaining) why.push('weekly loss cap: combined max loss would be $' + Math.round(risk + it.riskLoss).toLocaleString('en-US') + ' > $' + Math.round(lim.weeklyLossRemaining).toLocaleString('en-US'));
        if (sel.length >= acct.maxConcurrent) why.push('max ' + acct.maxConcurrent + ' concurrent structures');
        if (tgt >= acct.weeklyTargetMax) why.push('weekly target already covered');
        if (why.length) { skipped.push({ ticker: t, sector: it.x.sector, why }); continue; }
        sel.push(it); sectors[it.x.sector] = (sectors[it.x.sector] || 0) + 1; cap += it.sc.capital; risk += it.riskLoss; tgt += it.sc.target;
      }
      const m = sel.map(a => sel.map(c => (a === c ? 1 : corr(a.x, c.x).rho)));
      const comb = sel.length ? Strategy.combine(sel.map(it => ({ spot: it.x.out.spot, atmIV: it.x.out.atmIV, T: Math.max(1, it.x.out.days) / 365, pnl: (s0) => it.ev.expiry(s0) - it.x.out.cfg.mmLoss, riskLoss: it.riskLoss, capital: it.sc.capital })), m, { targetMin: acct.weeklyTargetMin, targetMax: acct.weeklyTargetMax, weeklyLossLimit: acct.maxWeeklyLoss, sims: 20000 }) : null;
      const pairs = []; for (let i = 0; i < sel.length; i++) for (let j = i + 1; j < sel.length; j++) pairs.push({ a: sel[i].x.ticker, b: sel[j].x.ticker, ...corr(sel[i].x, sel[j].x) });
      const cat = (w) => /^RISK LIMIT: max loss/.test(w) ? 'per-trade loss cap' : /^RISK LIMIT: capital/.test(w) ? 'capital per trade' : /remaining weekly loss|weekly loss cap/.test(w) ? 'weekly loss cap' : /^capital/.test(w) ? 'account capital' : /^correlated/.test(w) ? 'correlation' : /^sector/.test(w) ? 'sector cap' : /LIQUIDITY/.test(w) ? 'liquidity' : /concurrent/.test(w) ? 'max concurrent' : /already covered/.test(w) ? null : /below the .* target/.test(w) ? 'target not met at this size' : 'other';
      const limiter = skipped.length ? [...new Set(skipped.flatMap(s2 => s2.why.map(cat)).filter(Boolean))].join(', ') : null;
      return { multiplier: L, lotSets: L, perStructureTarget: per, needed, fits: sel.length, targetSum: tgt, coversWeeklyMin: tgt >= acct.weeklyTargetMin,
        summary: sel.length >= needed ? `${sel.length} structures at size ×${L} cover the $${acct.weeklyTargetMin.toLocaleString('en-US')} weekly minimum ($${Math.round(tgt).toLocaleString('en-US')} of targets).` : `Needs ${needed} structures at size ×${L} (≈ $${Math.round(per).toLocaleString('en-US')} target each) to reach $${acct.weeklyTargetMin.toLocaleString('en-US')}, but only ${sel.length} fit` + (limiter ? ` (limited by: ${limiter})` : '') + '.',
        capitalUsed: cap, combinedMaxLoss: risk, combined: comb, pairs,
        structures: sel.map(({ x, sc, riskLoss, rr, pProfit, evv }) => ({ ticker: x.ticker, sector: x.sector, expiry: x.expiry, side: x.out.best.futuresSide, variant: x.out.best.variant, hedge: x.out.best.futures.isStock ? 'stock' : x.out.best.futures.symbol, multiplier: L, lotSets: sc.lotSets, targetAdjusted: !!x.out.targetAdjusted,
          legs: sc.legs.map(l => ({ side: l.side, qty: l.qty, type: l.type, strike: l.strike, openInterest: l.openInterest ?? null, volume: l.volume ?? null })), perpQty: sc.perpQty, target: sc.target, exits: sc.exits, capital: sc.capital, margin: sc.futuresMargin,
          riskLoss, rewardToRisk: rr, probProfit: pProfit, ev: evv, liquidityFlags: sc.liquidity.flags, direction: x.out.direction && x.out.direction.reason })),
        skipped };
    });
    const good = plans.filter(p => p.coversWeeklyMin && p.combined);
    const rec = (good.length ? good.sort((a, c) => c.combined.probHitMin - a.combined.probHitMin || c.combined.expectedValue - a.combined.expectedValue)[0] : plans.slice().sort((a, c) => c.targetSum - a.targetSum)[0]) || null;
    const tickerStatus = perTicker.map(x => x.error ? { ticker: x.ticker, sector: x.sector, status: 'ERROR', reason: x.error } : { ticker: x.ticker, sector: x.sector, expiry: x.expiry, hedge: x.perp && x.perp.available ? x.perp.symbol : 'stock', status: x.out.status, reason: x.out.status === 'OK' ? null : (x.out.errors || []).join(' ') });
    const annual = { simpleMin: acct.weeklyTargetMin / acct.capital * 52, simpleMax: acct.weeklyTargetMax / acct.capital * 52, compoundMin: (1 + acct.weeklyTargetMin / acct.capital) ** 52 - 1, compoundMax: (1 + acct.weeklyTargetMax / acct.capital) ** 52 - 1 };
    const v = { account: acct, limits: lim, tickers: tickerStatus, plans: plans.sort((a, c) => a.lotSets - c.lotSets), recommendedLotSets: rec ? rec.lotSets : null, annual,
      honesty: 'A ' + (acct.weeklyTargetMin / acct.capital * 100).toFixed(1) + '–' + (acct.weeklyTargetMax / acct.capital * 100).toFixed(1) + '% weekly target is ~' + Math.round(annual.simpleMin * 100) + '–' + Math.round(annual.simpleMax * 100) + '% a year simple (' + Math.round(annual.compoundMin * 100) + '%+ compounded) — far above what professional funds sustain. The probabilities come from an options-implied lognormal model on delayed quotes and assume holding to expiry; they are estimates, never guarantees.', generatedAt: new Date().toISOString() };
    // save the plan and EVERY ticker's optimizer run (training data, whether or not it is traded)
    const planId = db.prepare('INSERT INTO strategy_plans(ts, inputs, result) VALUES(?,?,?)').run(Date.now(), JSON.stringify({ tickers, lotList, account: acct, limits: lim }),
      JSON.stringify({ ...v, plans: v.plans.map(p => ({ ...p, combined: p.combined ? { ...p.combined, commonMoveGrid: undefined } : null })) })).lastInsertRowid;
    const runIds = {};
    for (const x of perTicker) if (!x.error && x.out) { try { runIds[x.ticker] = saveRun({ out: x.out, chain: x.chain, perp: x.perp, t: x.ticker, expiry: x.expiry, method: 'optimizer', cfg: x.cfg, market: x.market, source: 'weekly-plan', planId, multiplier: 1 }).id; } catch (e) { log.warn('plan.save_run_failed', { ticker: x.ticker, error: e.message }); } }
    changed('strategy_plans', planId); v.planId = planId; v.runIds = runIds;
    for (const p of v.plans) for (const st of p.structures) st.runId = runIds[st.ticker] || null;
    planCache.set(key, { at: Date.now(), v });
    res.json(v);
  }));
  // ---- trade lifecycle: Taken / Not taken → entry fills → close with exit fills + realised P&L
  r.post('/strategy/history/:id/trade', wrap(async (req, res) => {
    const id = Number(req.params.id), b = req.body || {}, x = db.prepare('SELECT id, legs, result, taken, entry_fills FROM strategy_runs WHERE id=?').get(id);
    if (!x) throw httpErr(404, 'Run not found');
    const fillsOf = (f) => { if (f == null) return null; const legs = {}; for (const [k, v] of Object.entries(f.legs || {})) { if (v === '' || v == null) continue; const n = Number(v); if (!(n >= 0)) throw httpErr(400, 'Fill for ' + k + ' must be a non-negative price'); legs[k] = n; }
      const perp = f.perp === '' || f.perp == null ? null : Number(f.perp); if (perp != null && !(perp > 0)) throw httpErr(400, 'Perp fill must be positive'); return { legs, perp, at: Date.now(), note: String(f.note || '').slice(0, 300) }; };
    const sets = [], vals = [];
    if (b.taken !== undefined) { sets.push('taken=?'); vals.push(b.taken === true || b.taken === 1 || b.taken === 'yes' ? 1 : b.taken === null ? null : 0); }
    if (b.entryFills !== undefined) { sets.push('entry_fills=?'); vals.push(JSON.stringify(fillsOf(b.entryFills))); }
    if (b.exitFills !== undefined) { sets.push('exit_fills=?'); vals.push(JSON.stringify(fillsOf(b.exitFills))); }
    if (b.realisedPnl !== undefined && b.realisedPnl !== '') { const pnl = Number(b.realisedPnl); if (!Number.isFinite(pnl) || Math.abs(pnl) > 1e9) throw httpErr(400, 'Realised P&L must be a number'); sets.push('realised_pnl=?', 'realised_at=?', 'closed_at=?'); vals.push(pnl, Date.now(), Date.now()); }
    if (b.notes !== undefined) { sets.push('outcome_notes=?'); vals.push(String(b.notes).slice(0, 500)); }
    if (!sets.length) throw httpErr(400, 'Nothing to update');
    db.prepare(`UPDATE strategy_runs SET ${sets.join(', ')} WHERE id=?`).run(...vals, id); changed('strategy_runs', id);
    const tuned = b.realisedPnl !== undefined && b.realisedPnl !== '' ? retuneWeights('trade closed') : null;
    res.json({ ok: true, id, row: db.prepare('SELECT id, taken, entry_fills, exit_fills, realised_pnl, closed_at FROM strategy_runs WHERE id=?').get(id), learning: tuned });
  }));
  r.get('/strategy/model', (req, res) => {
    const cur = currentWeights();
    res.json({ version: { id: cur.id, at: new Date(cur.ts).toISOString(), source: cur.source, outcomes: cur.closed_runs, weights: cur.weights },
      history: db.prepare('SELECT id, ts, source, closed_runs FROM strategy_weights ORDER BY id DESC LIMIT 50').all().map(w => ({ ...w, at: new Date(w.ts).toISOString() })),
      calibration: calibrationStats(), minOutcomesForTuning: MIN_CLOSED_FOR_TUNING, loop: 'every 30 min: replay expired runs (auto outcomes) → re-tune; also re-tuned whenever a trade is closed',
      counts: db.prepare("SELECT COUNT(*) runs, SUM(realised_pnl IS NOT NULL) actual, SUM(auto_outcome IS NOT NULL AND realised_pnl IS NULL) auto, SUM(taken=1) taken FROM strategy_runs").get() });
  });
  r.post('/strategy/learn', wrap(async (req, res) => { const n = await autoOutcomes(50); res.json({ autoOutcomes: n, learning: retuneWeights('manual learning pass') }); }));
  r.get('/strategy/export.csv', (req, res) => {
    const rows = db.prepare('SELECT * FROM strategy_runs ORDER BY id').all(), cols = ['id', 'ts', 'source', 'plan_id', 'ticker', 'expiry', 'method', 'status', 'provider', 'quote_time', 'spot', 'atm_iv', 'perp_symbol', 'futures_qty', 'lot_sets', 'multiplier', 'target_pnl', 'expected_up', 'expected_down', 'required_capital', 'recommended_variant', 'chosen_variant', 'model_version', 'taken', 'realised_pnl', 'realised_at', 'closed_at'];
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
    const extra = (r) => { let a = {}, x = {}; try { a = r.auto_outcome ? JSON.parse(r.auto_outcome) : {}; } catch {} try { x = JSON.parse(r.result || '{}'); } catch {} const bst = x.best || {}, w = bst.whatIf || {};
      let wa = null; try { wa = r.weekly_atr ? JSON.parse(r.weekly_atr) : null; } catch {}
      return [wa ? wa.atr : null, wa ? wa.n : null, wa ? wa.upperMult : null, wa ? wa.lowerMult : null, wa ? wa.ceShort : null, wa ? wa.peShort : null, bst.variant, bst.futuresSide, (bst.legs || []).map(l => (l.side === 'buy' ? '+' : '-') + l.qty + ' ' + l.strike + (l.type === 'call' ? 'C' : 'P')).join(' '), w.probs && w.probs.profit, w.probs && w.probs.expectedValue, w.account && w.account.riskLoss, a.exit, a.pnl, a.error, (x.recommendation || {}).reason]; };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="quantsignal-runs-' + new Date().toISOString().slice(0, 10) + '.csv"');
    res.send([[...cols, 'weekly_atr', 'atr_n', 'atr_upper_mult', 'atr_lower_mult', 'atr_ce_short', 'atr_pe_short', 'variant', 'side', 'legs', 'prob_profit', 'expected_value', 'risk_loss', 'auto_exit', 'auto_pnl', 'auto_error_vs_projection', 'reason'].join(','), ...rows.map(r => [...cols.map(c => r[c]), ...extra(r)].map(esc).join(','))].join('\n'));
  });
  r.get('/strategy/weights', wrap(async (req, res) => res.json({ current: currentWeights(), history: db.prepare('SELECT id,ts,source,closed_runs FROM strategy_weights ORDER BY id DESC LIMIT 20').all(), minClosedForTuning: MIN_CLOSED_FOR_TUNING })));
  r.get('/strategy/calibration', wrap(async (req, res) => res.json(calibration(req.query.ticker ? tick(req.query.ticker) : null))));
  r.get('/strategy/sheet-anchor', wrap(async (req, res) => res.json(await sheetAnchorWithAtr(req.query.ticker ? tick(req.query.ticker) : null))));
  r.get('/strategy/reference', wrap(async (req, res) => { const { rows, res: an, summary } = reference(); res.json({ summary, rows: rows.map((x, i) => ({ ...x, analysis: an[i] })) }); }));
  return r;
}
module.exports = { initPersistence, exportAll, importAll, getAccount, router, calibration, reference, perpFor, saveRun, weeklyAtrFor, sheetAnchor, sheetAnchorWithAtr, currentWeights };
