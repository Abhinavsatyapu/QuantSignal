'use strict';
/**
 * Final accuracy pass on 62 liquid US equity perps.
 * Baseline BEFORE = legacy 15m indicators; STUDY = 4h liq_buy_side;
 * Candidates = ATR-stop overlays + AND-window combines + merged top combos.
 * Adopt only if OOS improves (PF + net%, adequate N) vs study baseline without collapsing trades.
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

function load(iv, cap) {
  return pass.map((sym) => {
    const f = path.join(OUT, 'klines', `${sym}_${iv}.json`);
    if (!fs.existsSync(f)) return null;
    let bars = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (bars.length > cap) bars = bars.slice(-cap);
    return bars.length >= 230 ? { symbol: sym, bars } : null;
  }).filter(Boolean);
}

function atrAt(bars, i, n = 14) {
  if (i < n) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) {
    const h = bars[j].h, l = bars[j].l, pc = bars[j - 1].c;
    s += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return s / n;
}

function pack(sum) {
  const dr = sum.dailyReturns || {};
  return {
    trades: sum.trades, winRate: sum.winRate, profitFactor: sum.profitFactor,
    totalPnlPct: sum.totalPnlPct, endEquity: sum.endEquity, maxDdPct: sum.maxDdPct,
    avgDailyPctAllDays: dr.meanDailyPctAllDays, geoAvgDailyPct: dr.geoAvgDailyPct,
    meanDailyPctTradeDays: dr.meanDailyPctTradeDays, tradeDays: dr.tradeDays,
    calendarDays: dr.calendarDays, lowSample: !!sum.lowSample,
  };
}

function scoreOos(o) {
  if (!o || o.trades < 5) return -1e9;
  return (o.totalPnlPct || 0) * Math.sqrt(Math.min(o.trades, 80))
    * ((o.winRate || 0) >= 0.45 ? 1.1 : 0.7)
    + Math.min(o.profitFactor || 0, 6) * 10
    - (o.maxDdPct || 0) * 0.8;
}

// --- precompute helpers for combine (reuse pattern) ---
const pcCache = new WeakMap();
function precompute(bars) {
  let pc = pcCache.get(bars);
  if (pc) return pc;
  const indDir = new Array(bars.length).fill(null);
  const indScore = new Array(bars.length).fill(0);
  const indStop = new Array(bars.length).fill(null);
  const indTp = new Array(bars.length).fill(null);
  const liqDir = new Array(bars.length).fill(null);
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
      if (L > S) liqDir[i] = 'LONG'; else if (S > L) liqDir[i] = 'SHORT';
    } catch {}
  }
  pc = { indDir, indScore, indStop, indTp, liqDir };
  pcCache.set(bars, pc);
  return pc;
}

function inWin(arr, i, dir, N) {
  for (let b = 0; b <= N; b++) { const j = i - b; if (j < 0) break; if (arr[j] === dir) return true; }
  return false;
}

function install(mode) {
  globalThis.__qsSignalAt = function (bars, i) {
    if (i < 220) return null;
    const pc = precompute(bars);
    let dir = null, score = 0, stop = null, tp = null, source = mode.id;
    if (mode.kind === 'variant') {
      // fall through to native by clearing hook temporarily — handled outside
      return null;
    }
    if (mode.kind === 'and_win') {
      const N = mode.N || 3;
      const idir = pc.indDir[i], ldir = pc.liqDir[i];
      if (idir && inWin(pc.liqDir, i, idir, N)) {
        dir = idir; score = pc.indScore[i]; stop = pc.indStop[i]; tp = pc.indTp[i];
      } else if (ldir && inWin(pc.indDir, i, ldir, N)) {
        dir = ldir; score = pc.indScore[i] || 6; stop = pc.indStop[i]; tp = pc.indTp[i];
      }
    } else if (mode.kind === 'or') {
      if (pc.indDir[i]) { dir = pc.indDir[i]; score = pc.indScore[i]; stop = pc.indStop[i]; tp = pc.indTp[i]; }
      else if (pc.liqDir[i]) { dir = pc.liqDir[i]; score = 6; }
    } else if (mode.kind === 'and_same') {
      if (pc.indDir[i] && pc.liqDir[i] && pc.indDir[i] === pc.liqDir[i]) {
        dir = pc.indDir[i]; score = pc.indScore[i]; stop = pc.indStop[i]; tp = pc.indTp[i];
      }
    }
    if (!dir) return null;
    // ATR stop overlay
    if (mode.atrMult) {
      const atr = atrAt(bars, i, 14);
      const entry = bars[i].c;
      if (atr > 0 && entry > 0) {
        stop = dir === 'LONG' ? entry - mode.atrMult * atr : entry + mode.atrMult * atr;
        const rr = mode.rr || 2;
        tp = dir === 'LONG' ? entry + rr * mode.atrMult * atr : entry - rr * mode.atrMult * atr;
      }
    } else if (!(stop > 0)) {
      const entry = bars[i].c;
      const atr = atrAt(bars, i, 14) || Math.abs(bars[i].h - bars[i].l);
      const dist = Math.max(entry * 0.015, atr || entry * 0.015);
      stop = dir === 'LONG' ? entry - dist : entry + dist;
      tp = dir === 'LONG' ? entry + 2 * dist : entry - 2 * dist;
    }
    return { direction: dir, score, entry: bars[i].c, stop, tp, source, i, t: bars[i].t };
  };
}

function clearHook() { delete globalThis.__qsSignalAt; }

function evalNative(series, iv, variant, label) {
  clearHook();
  const { train, test } = study.splitTrainTest(series, study.TRAIN_FRAC);
  const te = study.runPortfolio(test, iv, variant);
  const s60 = study.runPortfolio(series, iv, variant, { startMs: since60 });
  return { id: label, interval: iv, variant: variant.id, oos: pack(study.summarize(te)), sixty: pack(study.summarize(s60)), score: scoreOos(pack(study.summarize(te))) };
}

function evalHook(series, iv, mode) {
  install(mode);
  const { train, test } = study.splitTrainTest(series, study.TRAIN_FRAC);
  const v = { id: mode.id, label: mode.id, mode: 'custom' };
  const te = study.runPortfolio(test, iv, v);
  const s60 = study.runPortfolio(series, iv, v, { startMs: since60 });
  clearHook();
  return { id: mode.id, interval: iv, variant: mode.id, oos: pack(study.summarize(te)), sixty: pack(study.summarize(s60)), score: scoreOos(pack(study.summarize(te))) };
}

function main() {
  const s15 = load('15m', 1600);
  const s4 = load('4h', 700);
  const s1h = load('1h', 1000);
  const s30 = load('30m', 1200);
  console.log('symbols', { s15: s15.length, s4: s4.length, s1h: s1h.length, s30: s30.length });

  const vInd = study.VARIANTS.find((x) => x.id === 'indicators');
  const vBuy = study.VARIANTS.find((x) => x.id === 'liq_buy_side');
  const vSweep = study.VARIANTS.find((x) => x.id === 'liq_sweep');

  const rows = [];
  // BEFORE (legacy)
  console.log('legacy 15m indicators…');
  rows.push({ ...evalNative(s15, '15m', vInd, 'BEFORE_legacy_15m_indicators'), role: 'before' });

  // STUDY baseline (current recommended)
  console.log('study 4h liq_buy_side…');
  rows.push({ ...evalNative(s4, '4h', vBuy, 'STUDY_4h_liq_buy_side'), role: 'study' });

  // ATR overlay on study best via rules — use activeRules? simpler: hook that wraps native buy_side with ATR
  // Simulate ATR on liquidity-only buy_side by hooking detect path:
  console.log('4h liq_buy_side + ATR1.5…');
  install({ id: '4h_buy_atr15', kind: 'liq_buy_atr', atrMult: 1.5, rr: 2 });
  // custom: only buy_side liq
  globalThis.__qsSignalAt = function (bars, i) {
    if (i < 220) return null;
    const window = bars.slice(Math.max(0, i + 1 - 260), i + 1);
    let dir = null;
    try {
      const liq = globalThis.LiquiditySignals.detect(window, {});
      const sigs = (liq.signals || []).filter((s) => s.kind === 'buy_side_liquidity_taken');
      const L = sigs.filter((s) => s.side === 'LONG').length;
      const S = sigs.filter((s) => s.side === 'SHORT').length;
      if (L > S) dir = 'LONG'; else if (S > L) dir = 'SHORT';
    } catch {}
    if (!dir) return null;
    const atr = atrAt(bars, i, 14);
    const entry = bars[i].c;
    if (!(atr > 0)) return null;
    const stop = dir === 'LONG' ? entry - 1.5 * atr : entry + 1.5 * atr;
    const tp = dir === 'LONG' ? entry + 3 * atr : entry - 3 * atr;
    return { direction: dir, score: 7, entry, stop, tp, source: 'liq_buy_atr', i, t: bars[i].t };
  };
  {
    const { test } = study.splitTrainTest(s4, study.TRAIN_FRAC);
    const te = study.runPortfolio(test, '4h', { id: 'atr', mode: 'custom' });
    const s60 = study.runPortfolio(s4, '4h', { id: 'atr', mode: 'custom' }, { startMs: since60 });
    rows.push({ id: '4h_liq_buy_ATR1.5', interval: '4h', oos: pack(study.summarize(te)), sixty: pack(study.summarize(s60)), score: scoreOos(pack(study.summarize(te))), role: 'candidate' });
    console.log('ATR OOS', rows.at(-1).oos);
  }
  clearHook();

  console.log('4h liq_buy_side + ATR2.0…');
  globalThis.__qsSignalAt = function (bars, i) {
    if (i < 220) return null;
    const window = bars.slice(Math.max(0, i + 1 - 260), i + 1);
    let dir = null;
    try {
      const liq = globalThis.LiquiditySignals.detect(window, {});
      const sigs = (liq.signals || []).filter((s) => s.kind === 'buy_side_liquidity_taken');
      const L = sigs.filter((s) => s.side === 'LONG').length;
      const S = sigs.filter((s) => s.side === 'SHORT').length;
      if (L > S) dir = 'LONG'; else if (S > L) dir = 'SHORT';
    } catch {}
    if (!dir) return null;
    const atr = atrAt(bars, i, 14);
    const entry = bars[i].c;
    if (!(atr > 0)) return null;
    const stop = dir === 'LONG' ? entry - 2 * atr : entry + 2 * atr;
    const tp = dir === 'LONG' ? entry + 4 * atr : entry - 4 * atr;
    return { direction: dir, score: 7, entry, stop, tp, source: 'liq_buy_atr2', i, t: bars[i].t };
  };
  {
    const { test } = study.splitTrainTest(s4, study.TRAIN_FRAC);
    const te = study.runPortfolio(test, '4h', { id: 'atr2', mode: 'custom' });
    const s60 = study.runPortfolio(s4, '4h', { id: 'atr2', mode: 'custom' }, { startMs: since60 });
    rows.push({ id: '4h_liq_buy_ATR2.0', interval: '4h', oos: pack(study.summarize(te)), sixty: pack(study.summarize(s60)), score: scoreOos(pack(study.summarize(te))), role: 'candidate' });
  }
  clearHook();

  // Combine candidates on 1h (from prior matrix)
  for (const s of s1h) precompute(s.bars);
  console.log('1h AND window 3…');
  rows.push({ ...evalHook(s1h, '1h', { id: '1h_AND_window_3', kind: 'and_win', N: 3 }), role: 'candidate' });
  console.log('1h AND window 3 + ATR1.5…');
  rows.push({ ...evalHook(s1h, '1h', { id: '1h_AND_window_3_ATR1.5', kind: 'and_win', N: 3, atrMult: 1.5, rr: 2 }), role: 'candidate' });
  console.log('1h AND window 1…');
  rows.push({ ...evalHook(s1h, '1h', { id: '1h_AND_window_1', kind: 'and_win', N: 1 }), role: 'candidate' });
  console.log('1h OR…');
  rows.push({ ...evalHook(s1h, '1h', { id: '1h_OR', kind: 'or' }), role: 'candidate' });

  // 30m sweep (top3 single) + ATR
  console.log('30m liq_sweep…');
  rows.push({ ...evalNative(s30, '30m', vSweep, '30m_liq_sweep'), role: 'candidate' });

  // Merged: take tradeList from 4h buy + 1h AND_w3, union by symbol+day, re-sim crude — use higher TF priority
  // Practical merge: run 4h buy native; also allow 1h AND entries only when no open from same symbol — approximate by OR of signals on 4h grid only is unfair.
  // Instead: score candidates honestly without fake merge portfolio.

  const studyRow = rows.find((r) => r.role === 'study');
  const beforeRow = rows.find((r) => r.role === 'before');
  const cands = rows.filter((r) => r.role === 'candidate').sort((a, b) => b.score - a.score);

  // Adoption rule: beat STUDY on (profitFactor and totalPnlPct) with N>=5, or beat STUDY score by >10% with N>= study N and PF>=2.5
  let adopted = studyRow;
  const reasons = [];
  for (const c of cands) {
    const o = c.oos, s = studyRow.oos;
    if (o.trades < 5) { reasons.push(`${c.id}: reject low N=${o.trades}`); continue; }
    const betterPf = (o.profitFactor || 0) >= (s.profitFactor || 0) * 0.95 && (o.totalPnlPct || 0) > (s.totalPnlPct || 0);
    const betterAcc = (o.profitFactor || 0) > (s.profitFactor || 0) && (o.totalPnlPct || 0) >= (s.totalPnlPct || 0) * 0.85 && o.trades >= s.trades;
    const muchBetterScore = c.score > studyRow.score * 1.15 && (o.profitFactor || 0) >= 2.5 && o.trades >= Math.max(8, s.trades);
    if (betterPf || betterAcc || muchBetterScore) {
      adopted = c;
      reasons.push(`ADOPT ${c.id}: OOS net ${o.totalPnlPct}% PF ${o.profitFactor} N ${o.trades} vs study ${s.totalPnlPct}% PF ${s.profitFactor} N ${s.trades}`);
      break;
    }
    reasons.push(`${c.id}: no beat study (net ${o.totalPnlPct} PF ${o.profitFactor} N ${o.trades})`);
  }

  // Map adopted to live config
  let live = {
    activePreset: 'study_best_4h_liq_buy_side',
    interval: '4h', signalMode: 'liquidity', liqKinds: ['buy_side_liquidity_taken'], liqWindowBars: 0,
  };
  if (adopted.id === '1h_AND_window_3' || adopted.id === '1h_AND_window_3_ATR1.5') {
    live = { activePreset: 'combine_1h_and_window_3', interval: '1h', signalMode: 'confirm_window', liqKinds: [], liqWindowBars: 3 };
  } else if (adopted.id === '1h_AND_window_1') {
    live = { activePreset: 'combine_1h_and_window_1', interval: '1h', signalMode: 'confirm_window', liqKinds: [], liqWindowBars: 1 };
  } else if (adopted.id && adopted.id.includes('ATR')) {
    // ATR not yet a first-class live preset — keep study signal, note ATR not adopted into live without engine stop change
    reasons.push('ATR candidate needs engine stop wiring; keep study signal mode if ATR won on paper only');
  }

  // If study still wins, live stays study_best
  if (adopted.role === 'study') {
    live = { activePreset: 'study_best_4h_liq_buy_side', interval: '4h', signalMode: 'liquidity', liqKinds: ['buy_side_liquidity_taken'], liqWindowBars: 0 };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    universe: pass.length,
    before: beforeRow,
    study: studyRow,
    candidates: cands,
    adopted: { id: adopted.id, role: adopted.role, oos: adopted.oos, sixty: adopted.sixty, score: adopted.score },
    liveConfig: live,
    reasons,
    whale: 'INCONCLUSIVE / NO_ADOPT (confirm filter N≈0 or no OOS lift)',
    combineNote: 'Full AND/OR matrix in combine-modes-report.json; 4h AND same-bar weak; 1h AND-window competitive but must beat study to replace default.',
  };
  fs.writeFileSync(path.join(OUT, 'final-accuracy-report.json'), JSON.stringify(report, null, 2));
  console.log('\nBEFORE', beforeRow.id, beforeRow.oos);
  console.log('STUDY ', studyRow.id, studyRow.oos);
  console.log('ADOPTED', adopted.id, adopted.oos);
  console.log('LIVE', live);
  console.log('Top candidates');
  cands.slice(0, 8).forEach((c, i) => console.log(i + 1, c.id, 'score', c.score.toFixed(1), 'OOS', c.oos));
}

main();
