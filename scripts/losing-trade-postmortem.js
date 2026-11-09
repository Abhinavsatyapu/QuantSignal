'use strict';
/**
 * Losing-trade post-mortem for Setup A (4h liq_buy_side) and Setup B (1h AND window 3).
 * Classifies failures, proposes fixes, walk-forward tests, reports adopt/reject.
 */
const fs = require('fs');
const path = require('path');
const study = require('./binance-stock-perp-study');
require('../public/indicators.js');
require('../public/strategy-liquidity-signals.js');

const OUT = path.join(__dirname, 'out');
const pass = require('./out/liq-pass-full.json').pass;
const since60 = Date.now() - 60 * 86400e3;
const MIN_SCORE = 6;
const CAPITAL = study.CAPITAL;

function load(iv, cap) {
  return pass.map((sym) => {
    const f = path.join(OUT, 'klines', `${sym}_${iv}.json`);
    if (!fs.existsSync(f)) return null;
    let bars = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (bars.length > cap) bars = bars.slice(-cap);
    return bars.length >= 230 ? { symbol: sym, bars } : null;
  }).filter(Boolean);
}

function atr(bars, i, n = 14) {
  if (i < n) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) {
    const h = bars[j].h, l = bars[j].l, pc = bars[j - 1].c;
    s += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return s / n;
}

function ema(vals, n) {
  if (vals.length < n) return null;
  const k = 2 / (n + 1);
  let e = vals.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}

function htfTrend(bars1d, t) {
  const upto = (bars1d || []).filter((b) => b.t <= t);
  if (upto.length < 60) return null;
  const c = upto.map((b) => b.c);
  const e20 = ema(c, 20), e50 = ema(c, 50);
  if (e20 == null || e50 == null) return null;
  if (e20 > e50 * 1.002) return 'LONG';
  if (e20 < e50 * 0.998) return 'SHORT';
  return 'FLAT';
}

function usCashSession(entryTs) {
  // Approximate US cash equities: 14:30–21:00 UTC (ET 9:30–16:00 ignoring DST edge)
  const d = new Date(entryTs);
  const dow = d.getUTCDay(); // 0 Sun
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const open = 14 * 60 + 30, close = 21 * 60;
  if (dow === 0 || dow === 6) return { label: 'weekend', cash: false };
  if (mins < open) return { label: 'premarket_utc', cash: false };
  if (mins >= close) return { label: 'afterhours_utc', cash: false };
  return { label: 'us_cash', cash: true };
}

function maeMfe(bars, entryI, exitI, dir, entry) {
  let mae = 0, mfe = 0, hitStopThenTarget = false;
  const sign = dir === 'LONG' ? 1 : -1;
  for (let i = entryI; i <= exitI && i < bars.length; i++) {
    const adverse = sign === 1 ? entry - bars[i].l : bars[i].h - entry;
    const favor = sign === 1 ? bars[i].h - entry : entry - bars[i].l;
    mae = Math.max(mae, adverse);
    mfe = Math.max(mfe, favor);
  }
  return { mae, mfe, maeAtr: null, mfeAtr: null };
}

function findBarIndex(bars, ts) {
  let best = -1;
  for (let i = 0; i < bars.length; i++) if (bars[i].t <= ts) best = i;
  return best;
}

// --- Setup B hook ---
const pcCache = new WeakMap();
function precompute(bars) {
  let pc = pcCache.get(bars);
  if (pc) return pc;
  const indDir = new Array(bars.length).fill(null);
  const indScore = new Array(bars.length).fill(0);
  const indStop = new Array(bars.length).fill(null);
  const indTp = new Array(bars.length).fill(null);
  const liqDir = new Array(bars.length).fill(null);
  const liqLevel = new Array(bars.length).fill(null);
  const liqAge = new Array(bars.length).fill(null);
  for (let i = 220; i < bars.length; i++) {
    const window = bars.slice(Math.max(0, i + 1 - 260), i + 1);
    try {
      const ind = globalThis.Technicals.analyze(window, window[window.length - 1].T + 1, { minStopPct: 1.5 });
      if (['LONG', 'SHORT'].includes(ind.direction) && (ind.score || 0) >= MIN_SCORE) {
        indDir[i] = ind.direction; indScore[i] = ind.score; indStop[i] = ind.stop; indTp[i] = ind.tp1;
      }
    } catch {}
    try {
      const liq = globalThis.LiquiditySignals.detect(window, {});
      const sigs = liq.signals || [];
      const L = sigs.filter((s) => s.side === 'LONG').length;
      const S = sigs.filter((s) => s.side === 'SHORT').length;
      if (L > S) liqDir[i] = 'LONG';
      else if (S > L) liqDir[i] = 'SHORT';
      if (sigs[0]) {
        liqLevel[i] = sigs[0].level;
        // age: bars since level roughly from barIndex in window
        liqAge[i] = sigs[0].barIndex != null ? (window.length - 1 - sigs[0].barIndex) : null;
      }
    } catch {}
  }
  pc = { indDir, indScore, indStop, indTp, liqDir, liqLevel, liqAge };
  pcCache.set(bars, pc);
  return pc;
}
function inWin(arr, i, dir, N) {
  for (let b = 0; b <= N; b++) { const j = i - b; if (j < 0) break; if (arr[j] === dir) return true; }
  return false;
}

function installSetupB(filters = {}) {
  globalThis.__qsSignalAt = function (bars, i) {
    if (i < 220) return null;
    const pc = precompute(bars);
    const N = 3;
    let dir = null, score = 0, stop = null, tp = null;
    const idir = pc.indDir[i], ldir = pc.liqDir[i];
    if (idir && inWin(pc.liqDir, i, idir, N)) {
      dir = idir; score = pc.indScore[i]; stop = pc.indStop[i]; tp = pc.indTp[i];
    } else if (ldir && inWin(pc.indDir, i, ldir, N)) {
      dir = ldir; score = pc.indScore[i] || 6; stop = pc.indStop[i]; tp = pc.indTp[i];
    }
    if (!dir) return null;

    // Apply entry filters (fixes)
    if (filters.usCashOnly) {
      const sess = usCashSession(bars[i].t);
      if (!sess.cash) return null;
    }
    if (filters.htfAlign) {
      const tr = htfTrend(filters.htfBars?.[bars.__sym] || filters.bars1dBySym?.[arguments[0]?.__symbol], bars[i].t);
      // passed via closure below
    }
    if (filters.requireHtf && filters.getHtf) {
      const tr = filters.getHtf(bars.__symbol, bars[i].t);
      if (tr && tr !== 'FLAT' && tr !== dir) return null;
    }
    if (filters.maxEntryAtr != null) {
      const a = atr(bars, i, 14);
      // need level — approximate: stop distance already encodes; use |entry - recent swing|
      // skip if no level
    }
    if (filters.minLevelFreshBars != null && pc.liqAge[i] != null && pc.liqAge[i] > filters.minLevelFreshBars) {
      // age too large = old level — reject if requiring FRESH (age small). Fresh = age <= threshold
    }
    if (filters.maxLevelAgeBars != null && pc.liqAge[i] != null && pc.liqAge[i] > filters.maxLevelAgeBars) return null;
    if (filters.widerStopAtr != null) {
      const a = atr(bars, i, 14);
      const entry = bars[i].c;
      if (a > 0) {
        stop = dir === 'LONG' ? entry - filters.widerStopAtr * a : entry + filters.widerStopAtr * a;
        tp = dir === 'LONG' ? entry + 2 * filters.widerStopAtr * a : entry - 2 * filters.widerStopAtr * a;
      }
    }
    if (!(stop > 0)) {
      const entry = bars[i].c;
      const a = atr(bars, i, 14) || Math.abs(bars[i].h - bars[i].l);
      const dist = Math.max(entry * 0.015, a);
      stop = dir === 'LONG' ? entry - dist : entry + dist;
      tp = dir === 'LONG' ? entry + 2 * dist : entry - 2 * dist;
    }
    // max entry extension: if stopDist already large vs ATR, late
    if (filters.maxStopAtr != null) {
      const a = atr(bars, i, 14);
      const entry = bars[i].c;
      if (a > 0 && Math.abs(entry - stop) / a > filters.maxStopAtr) return null;
    }
    return { direction: dir, score, entry: bars[i].c, stop, tp, source: 'setupB', i, t: bars[i].t };
  };
}

function installSetupA(filters = {}) {
  globalThis.__qsSignalAt = function (bars, i) {
    if (i < 220) return null;
    const window = bars.slice(Math.max(0, i + 1 - 260), i + 1);
    let dir = null, level = null, age = null;
    try {
      const liq = globalThis.LiquiditySignals.detect(window, {});
      const sigs = (liq.signals || []).filter((s) => s.kind === 'buy_side_liquidity_taken');
      const L = sigs.filter((s) => s.side === 'LONG').length;
      const S = sigs.filter((s) => s.side === 'SHORT').length;
      if (L > S) dir = 'LONG'; else if (S > L) dir = 'SHORT';
      if (sigs[0]) { level = sigs[0].level; age = window.length - 1 - (sigs[0].barIndex || 0); }
    } catch {}
    if (!dir) return null;
    if (filters.usCashOnly && !usCashSession(bars[i].t).cash) return null;
    if (filters.requireHtf && filters.getHtf) {
      const tr = filters.getHtf(bars.__symbol, bars[i].t);
      if (tr && tr !== 'FLAT' && tr !== dir) return null;
    }
    if (filters.maxLevelAgeBars != null && age != null && age > filters.maxLevelAgeBars) return null;
    const entry = bars[i].c;
    let stop, tp;
    if (filters.widerStopAtr != null) {
      const a = atr(bars, i, 14);
      if (!(a > 0)) return null;
      stop = dir === 'LONG' ? entry - filters.widerStopAtr * a : entry + filters.widerStopAtr * a;
      tp = dir === 'LONG' ? entry + 2 * filters.widerStopAtr * a : entry - 2 * filters.widerStopAtr * a;
    } else {
      // default study stop from indicators for structure, else ATR*1.5
      try {
        const ind = globalThis.Technicals.analyze(window, window[window.length - 1].T + 1, { minStopPct: 1.5 });
        stop = ind.stop; tp = ind.tp1;
      } catch {}
      if (!(stop > 0)) {
        const a = atr(bars, i, 14) || entry * 0.015;
        stop = dir === 'LONG' ? entry - 1.5 * a : entry + 1.5 * a;
        tp = dir === 'LONG' ? entry + 3 * a : entry - 3 * a;
      }
    }
    if (filters.maxStopAtr != null) {
      const a = atr(bars, i, 14);
      if (a > 0 && Math.abs(entry - stop) / a > filters.maxStopAtr) return null;
    }
    if (level != null && filters.maxEntryDistAtr != null) {
      const a = atr(bars, i, 14);
      if (a > 0 && Math.abs(entry - level) / a > filters.maxEntryDistAtr) return null;
    }
    return { direction: dir, score: 7, entry, stop, tp, source: 'setupA', i, t: bars[i].t, _level: level, _age: age };
  };
}

function clearHook() { delete globalThis.__qsSignalAt; }

function pack(sum) {
  const dr = sum.dailyReturns || {};
  return {
    trades: sum.trades, wins: sum.wins, losses: sum.losses, winRate: sum.winRate,
    profitFactor: sum.profitFactor, totalPnlPct: sum.totalPnlPct, endEquity: sum.endEquity,
    maxDdPct: sum.maxDdPct, avgDailyPctAllDays: dr.meanDailyPctAllDays,
    geoAvgDailyPct: dr.geoAvgDailyPct, meanDailyPctTradeDays: dr.meanDailyPctTradeDays,
    tradeDays: dr.tradeDays, calendarDays: dr.calendarDays, lowSample: !!sum.lowSample,
  };
}

function classifyTrade(t, barsBySym, bars1dBySym, spyBars) {
  const causes = [];
  const bars = barsBySym[t.symbol];
  if (!bars) return { causes: ['no_bars'], meta: {} };
  const entryI = findBarIndex(bars, t.entryTs);
  const exitI = findBarIndex(bars, t.exitTs);
  if (entryI < 1) return { causes: ['no_entry_bar'], meta: {} };
  const a = atr(bars, entryI, 14) || 0;
  const { mae, mfe } = maeMfe(bars, entryI, Math.max(entryI, exitI), t.dir, t.entry);
  const maeAtr = a > 0 ? mae / a : null;
  const mfeAtr = a > 0 ? mfe / a : null;
  const stopDist = Math.abs(t.entry - (t.stop || t.entry * (t.dir === 'LONG' ? 0.985 : 1.015)));
  // noise stop-out: hit stop (reason stop) but MFE would have reached ~2R
  const R = stopDist || (a * 1.5);
  if (t.reason === 'stop' && mfe >= 1.5 * R) causes.push('noise_stop_out');
  if (t.reason === 'stop' && maeAtr != null && maeAtr < 1.0 && mfeAtr != null && mfeAtr > 1.5) causes.push('stop_too_tight');

  const tr = htfTrend(bars1dBySym[t.symbol], t.entryTs);
  if (tr && tr !== 'FLAT' && tr !== t.dir) causes.push('against_htf_trend');

  const sess = usCashSession(t.entryTs);
  if (!sess.cash) causes.push('illiquid_session');

  // late entry: stopDist / ATR large OR entry far from bar mid-range
  if (a > 0 && stopDist / a > 2.5) causes.push('late_entry_extended');

  // weak/old level — use hour IST weekend already; level age from detect at entry
  try {
    const window = bars.slice(Math.max(0, entryI + 1 - 260), entryI + 1);
    const liq = globalThis.LiquiditySignals.detect(window, {});
    const sigs = liq.signals || [];
    if (sigs[0] && sigs[0].barIndex != null) {
      const age = window.length - 1 - sigs[0].barIndex;
      if (age > 8) causes.push('old_liquidity_level');
    } else if (!sigs.length && t.source === 'liquidity') causes.push('weak_liquidity_level');
  } catch {}

  // correlated: same IST day many losses — tagged later in batch
  // slippage proxy: exit reason market / large stopDist vs ATR
  if (a > 0 && Math.abs(t.exit - t.entry) / a > 4 && t.reason === 'stop') causes.push('gap_or_slippage_like');

  // news/earnings: unknown without calendar
  // IST Friday evening / weekend open risk
  if (t.entryDowIST === 5 && t.entryHourIST >= 18) causes.push('weekend_risk_window');

  if (!causes.length) causes.push('unclassified_stop_or_thesis');

  return {
    causes,
    meta: {
      mae, mfe, maeAtr, mfeAtr, atr: a, stopDist, session: sess.label,
      htf: tr, holdBars: t.holdBars, reason: t.reason,
      entryHourIST: t.entryHourIST, entryDowIST: t.entryDowIST,
    },
  };
}

function runSetup(name, series, iv, installer, filters, bars1dBySym) {
  // tag symbol on bars for filters
  for (const s of series) s.bars.__symbol = s.symbol;
  const getHtf = (sym, t) => htfTrend(bars1dBySym[sym], t);
  installer({ ...filters, getHtf, requireHtf: !!filters.requireHtf });
  const { train, test, cut } = study.splitTrainTest(series, study.TRAIN_FRAC);
  const tr = study.runPortfolio(train, iv, { id: name, mode: 'custom' });
  const te = study.runPortfolio(test, iv, { id: name, mode: 'custom' });
  const s60 = study.runPortfolio(series, iv, { id: name, mode: 'custom' }, { startMs: since60 });
  clearHook();
  return {
    name, iv, cut: new Date(cut).toISOString(),
    train: pack(study.summarize(tr)),
    oos: pack(study.summarize(te)),
    sixty: pack(study.summarize(s60)),
    tradeList: [...(tr.tradeList || []), ...(te.tradeList || [])],
    oosTrades: te.tradeList || [],
    sixtyTrades: s60.tradeList || [],
    allTrades: [...(tr.tradeList || []), ...(te.tradeList || []), ...(s60.tradeList || [])],
  };
}

function mistakeTable(lossesClassified) {
  const map = new Map();
  for (const row of lossesClassified) {
    for (const c of row.causes) {
      const g = map.get(c) || { cause: c, count: 0, pnl: 0, examples: [] };
      g.count++;
      g.pnl += row.pnl;
      if (g.examples.length < 3) g.examples.push({ symbol: row.symbol, dir: row.dir, pnl: +row.pnl.toFixed(2), entryTs: row.entryTs, reason: row.reason, meta: row.meta });
      map.set(c, g);
    }
  }
  const total = lossesClassified.length || 1;
  return [...map.values()]
    .map((g) => ({ ...g, pctOfLosses: +(100 * g.count / total).toFixed(1), pnl: +g.pnl.toFixed(2) }))
    .sort((a, b) => a.pnl - b.pnl);
}

function correlateLosses(losses) {
  // group by IST day
  const byDay = new Map();
  for (const t of losses) {
    const day = new Date(t.entryTs + 5.5 * 3600e3).toISOString().slice(0, 10);
    const arr = byDay.get(day) || [];
    arr.push(t);
    byDay.set(day, arr);
  }
  let multi = 0, multiPnl = 0;
  const examples = [];
  for (const [day, arr] of byDay) {
    if (arr.length >= 2) {
      multi += arr.length;
      multiPnl += arr.reduce((s, t) => s + t.pnl, 0);
      if (examples.length < 3) examples.push({ day, n: arr.length, symbols: arr.map((x) => x.symbol) });
    }
  }
  return { multiLossTradeCount: multi, multiPnl: +multiPnl.toFixed(2), examples };
}

function main() {
  console.log('Loading series…');
  const s4 = load('4h', 700);
  const s1h = load('1h', 1000);
  const s1d = load('1d', 400);
  const bars1dBySym = Object.fromEntries(s1d.map((x) => [x.symbol, x.bars]));
  const bars4 = Object.fromEntries(s4.map((x) => [x.symbol, x.bars]));
  const bars1h = Object.fromEntries(s1h.map((x) => [x.symbol, x.bars]));
  const spy = bars1dBySym.SPYUSDT || bars4.SPYUSDT;

  console.log('n', { s4: s4.length, s1h: s1h.length, s1d: s1d.length });

  // Baseline runs
  console.log('Setup A baseline…');
  const A0 = runSetup('A_baseline', s4, '4h', installSetupA, {}, bars1dBySym);
  console.log('Setup B baseline…');
  for (const s of s1h) precompute(s.bars);
  const B0 = runSetup('B_baseline', s1h, '1h', installSetupB, {}, bars1dBySym);

  function analyze(setup, barsBySym, label) {
    const losses = (setup.tradeList || []).filter((t) => t.pnl < 0);
    const classified = losses.map((t) => {
      const { causes, meta } = classifyTrade(t, barsBySym, bars1dBySym, spy);
      return { ...t, causes, meta };
    });
    // mark correlated
    const corr = correlateLosses(losses);
    for (const row of classified) {
      const day = new Date(row.entryTs + 5.5 * 3600e3).toISOString().slice(0, 10);
      const same = losses.filter((x) => new Date(x.entryTs + 5.5 * 3600e3).toISOString().slice(0, 10) === day);
      if (same.length >= 2 && !row.causes.includes('correlated_cluster')) row.causes.push('correlated_cluster');
    }
    const table = mistakeTable(classified);
    // recompute table after correlated tag
    const table2 = mistakeTable(classified);
    return {
      label,
      lossCount: losses.length,
      winCount: (setup.tradeList || []).filter((t) => t.pnl > 0).length,
      oos: setup.oos,
      sixty: setup.sixty,
      train: setup.train,
      mistakeTable: table2,
      correlation: corr,
      classifiedSample: classified.slice(0, 15).map((t) => ({
        symbol: t.symbol, dir: t.dir, pnl: +t.pnl.toFixed(2), reason: t.reason,
        causes: t.causes, session: t.meta.session, htf: t.meta.htf,
        maeAtr: t.meta.maeAtr != null ? +t.meta.maeAtr.toFixed(2) : null,
        mfeAtr: t.meta.mfeAtr != null ? +t.meta.mfeAtr.toFixed(2) : null,
      })),
    };
  }

  const postA = analyze(A0, bars4, 'Setup A · 4h liq_buy_side');
  const postB = analyze(B0, bars1h, 'Setup B · 1h AND window 3');
  console.log('A losses', postA.lossCount, 'top causes', postA.mistakeTable.slice(0, 5));
  console.log('B losses', postB.lossCount, 'top causes', postB.mistakeTable.slice(0, 5));

  // Proposed fixes from top causes
  const fixes = [
    { id: 'us_cash_only', desc: 'Trade only during US cash session (≈14:30–21:00 UTC)', filters: { usCashOnly: true } },
    { id: 'htf_align', desc: 'Require 1d EMA20/50 alignment with trade direction', filters: { requireHtf: true } },
    { id: 'wider_stop_2atr', desc: 'Place stop at 2×ATR beyond entry (reduce noise stop-outs)', filters: { widerStopAtr: 2 } },
    { id: 'max_stop_2_5atr', desc: 'Skip late/extended entries where stop distance > 2.5 ATR', filters: { maxStopAtr: 2.5 } },
    { id: 'fresh_level', desc: 'Reject liquidity signals with level age > 8 bars', filters: { maxLevelAgeBars: 8 } },
    { id: 'cash_htf', desc: 'US cash + HTF align combined', filters: { usCashOnly: true, requireHtf: true } },
    { id: 'cash_htf_fresh', desc: 'US cash + HTF + fresh level', filters: { usCashOnly: true, requireHtf: true, maxLevelAgeBars: 8 } },
    { id: 'cash_htf_maxext', desc: 'US cash + HTF + max stop 2.5 ATR', filters: { usCashOnly: true, requireHtf: true, maxStopAtr: 2.5 } },
  ];

  function testFixes(setupName, series, iv, installer, baseline) {
    const results = [];
    for (const f of fixes) {
      console.log('test', setupName, f.id, '…');
      const r = runSetup(`${setupName}_${f.id}`, series, iv, installer, f.filters, bars1dBySym);
      const o = r.oos, b = baseline.oos;
      const adopt =
        o.trades >= Math.max(5, Math.floor((b.trades || 5) * 0.5)) &&
        (o.winRate || 0) >= (b.winRate || 0) - 0.001 &&
        (o.profitFactor || 0) >= (b.profitFactor || 0) &&
        (o.trades >= 5);
      // stricter: WR AND PF must improve (or PF improve with WR not worse)
      const strict =
        o.trades >= Math.max(5, Math.floor((b.trades || 5) * 0.55)) &&
        (o.winRate || 0) >= (b.winRate || 0) &&
        (o.profitFactor || 0) > (b.profitFactor || 0);
      results.push({
        fix: f.id, desc: f.desc,
        oos: o, sixty: r.sixty, train: r.train,
        vsBaseline: {
          dWR: +(((o.winRate || 0) - (b.winRate || 0)) * 100).toFixed(1),
          dPF: +(((o.profitFactor || 0) - (b.profitFactor || 0))).toFixed(2),
          dNet: +(((o.totalPnlPct || 0) - (b.totalPnlPct || 0))).toFixed(2),
          tradeRatio: b.trades ? +(o.trades / b.trades).toFixed(2) : null,
        },
        adopt: !!strict,
        lowN: o.trades < 8 || !!o.lowSample,
      });
    }
    return results;
  }

  const fixA = testFixes('A', s4, '4h', installSetupA, A0);
  const fixB = testFixes('B', s1h, '1h', installSetupB, B0);

  const adoptedA = fixA.filter((x) => x.adopt);
  const adoptedB = fixB.filter((x) => x.adopt);

  // Pick best single/combo adopted by OOS score (PF * sqrt(N) * WR)
  function bestAdopted(list, baseline) {
    const ok = list.filter((x) => x.adopt);
    if (!ok.length) return null;
    ok.sort((a, b) => {
      const sa = (a.oos.profitFactor || 0) * Math.sqrt(a.oos.trades || 1) * (a.oos.winRate || 0);
      const sb = (b.oos.profitFactor || 0) * Math.sqrt(b.oos.trades || 1) * (b.oos.winRate || 0);
      return sb - sa;
    });
    return ok[0];
  }
  const bestA = bestAdopted(fixA, A0);
  const bestB = bestAdopted(fixB, B0);

  // Recommended setup: compare improved A vs improved B vs baselines
  const contenders = [
    { id: 'A_baseline', setup: 'A', oos: A0.oos, sixty: A0.sixty },
    { id: 'B_baseline', setup: 'B', oos: B0.oos, sixty: B0.sixty },
  ];
  if (bestA) contenders.push({ id: 'A_' + bestA.fix, setup: 'A', oos: bestA.oos, sixty: bestA.sixty, fix: bestA });
  if (bestB) contenders.push({ id: 'B_' + bestB.fix, setup: 'B', oos: bestB.oos, sixty: bestB.sixty, fix: bestB });
  contenders.sort((a, b) => {
    const sa = (a.oos.profitFactor || 0) * Math.sqrt(Math.max(a.oos.trades || 1, 1)) * ((a.oos.winRate || 0) >= 0.4 ? 1 : 0.7);
    const sb = (b.oos.profitFactor || 0) * Math.sqrt(Math.max(b.oos.trades || 1, 1)) * ((b.oos.winRate || 0) >= 0.4 ? 1 : 0.7);
    return sb - sa;
  });

  const report = {
    generatedAt: new Date().toISOString(),
    universe: pass.length,
    note: 'Active live preset unchanged (user picks). Dry-run only. Earnings calendar not free-wired — gaps tagged gap_or_slippage_like / unclassified.',
    setupA: postA,
    setupB: postB,
    fixes: { A: fixA, B: fixB },
    adoptedFixes: { A: adoptedA, B: adoptedB },
    bestFixA: bestA, bestFixB: bestB,
    recommended: contenders[0],
    contenders,
    learningLoop: {
      table: 'bn_trade_lessons',
      behavior: 'On each closed trade, tag failure/success causes and store; daily digest suggests rule updates; never auto-applies without approval.',
    },
  };

  fs.writeFileSync(path.join(OUT, 'postmortem-report.json'), JSON.stringify(report, null, 2));
  // compact markdown
  const lines = ['# Losing-trade post-mortem', '', `Universe ${pass.length} · generated ${report.generatedAt}`, ''];
  for (const [name, post] of [['A', postA], ['B', postB]]) {
    lines.push(`## Setup ${name}: ${post.label}`, '');
    lines.push(`Losses classified: ${post.lossCount} · OOS WR ${(100 * (post.oos.winRate || 0)).toFixed(0)}% PF ${post.oos.profitFactor} net ${post.oos.totalPnlPct}%`, '');
    lines.push('| Cause | Count | % losses | $ lost |', '|---|---:|---:|---:|');
    for (const r of post.mistakeTable.slice(0, 12)) {
      lines.push(`| ${r.cause} | ${r.count} | ${r.pctOfLosses}% | ${r.pnl} |`);
    }
    lines.push('');
  }
  lines.push('## Fix tests (adopt = OOS WR↑ AND PF↑, trades not collapsed)', '');
  for (const side of ['A', 'B']) {
    lines.push('### Setup ' + side);
    for (const f of report.fixes[side]) {
      lines.push(`- **${f.fix}** ${f.adopt ? 'ADOPT' : 'reject'}${f.lowN ? ' (low N)' : ''}: OOS N=${f.oos.trades} WR=${(100 * f.oos.winRate).toFixed(0)}% PF=${f.oos.profitFactor} net=${f.oos.totalPnlPct}% (ΔWR ${f.vsBaseline.dWR}pp ΔPF ${f.vsBaseline.dPF})`);
    }
    lines.push('');
  }
  lines.push('## Recommended', JSON.stringify(report.recommended, null, 2));
  fs.writeFileSync(path.join(OUT, 'POSTMORTEM.md'), lines.join('\n'));
  console.log('\nRecommended', report.recommended);
  console.log('Adopted A', adoptedA.map((x) => x.fix));
  console.log('Adopted B', adoptedB.map((x) => x.fix));
  console.log('Wrote postmortem-report.json');
}

main();
