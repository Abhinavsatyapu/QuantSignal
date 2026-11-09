'use strict';
/**
 * Fast Indicators × Liquidity combine matrix on 62 liquid universe.
 * (a) AND same-bar  (b) AND within N∈{1,3,6} bars  (c) OR
 * Precomputes indicator + liquidity direction per bar to avoid O(window) re-detect.
 */
const fs = require('fs');
const path = require('path');
const study = require('./binance-stock-perp-study');
require('../public/indicators.js');
require('../public/strategy-liquidity-signals.js');

const OUT = path.join(__dirname, 'out');
const pass = require('./out/liq-pass-full.json').pass;
const TFS = ['4h', '1h', '30m', '15m', '5m', '1d'];
const WINDOWS = [1, 3, 6];
const MIN_SCORE = 6;
const since60 = Date.now() - 60 * 86400e3;
const CAPITAL = study.CAPITAL;

function loadSeries(iv) {
  const cap = ({ '5m': 1800, '15m': 1600, '30m': 1200, '1h': 1000, '4h': 700, '1d': 400 })[iv] || 1200;
  return pass.map((sym) => {
    const f = path.join(OUT, 'klines', `${sym}_${iv}.json`);
    if (!fs.existsSync(f)) return null;
    let bars = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (bars.length > cap) bars = bars.slice(-cap);
    return bars.length >= 230 ? { symbol: sym, bars } : null;
  }).filter(Boolean);
}

function precompute(bars) {
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
        indDir[i] = ind.direction;
        indScore[i] = ind.score;
        indStop[i] = ind.stop;
        indTp[i] = ind.tp1;
      }
    } catch {}
    try {
      const liq = globalThis.LiquiditySignals.detect(window, {});
      const sigs = liq.signals || [];
      const L = sigs.filter((s) => s.side === 'LONG').length;
      const S = sigs.filter((s) => s.side === 'SHORT').length;
      if (L > S) liqDir[i] = 'LONG';
      else if (S > L) liqDir[i] = 'SHORT';
    } catch {}
  }
  return { indDir, indScore, indStop, indTp, liqDir };
}

function liqInWindow(liqDir, i, dir, N) {
  for (let b = 0; b <= N; b++) {
    const j = i - b;
    if (j < 0) break;
    if (liqDir[j] === dir) return true;
  }
  return false;
}
function indInWindow(indDir, i, dir, N) {
  for (let b = 0; b <= N; b++) {
    const j = i - b;
    if (j < 0) break;
    if (indDir[j] === dir) return true;
  }
  return false;
}

// Monkeypatch study.signalAt using per-symbol precompute cache keyed by bars ref
const cache = new WeakMap();
function getPC(bars) {
  let pc = cache.get(bars);
  if (!pc) { pc = precompute(bars); cache.set(bars, pc); }
  return pc;
}

function installSignalAt(modeSpec) {
  // Hook into study via globalThis.__qsSignalAt (local signalAt binding is not patchable)
  // modeSpec: { kind: 'and_same'|'and_win'|'or'|'ind'|'liq', N?: number }
  globalThis.__qsSignalAt = function patched(bars, i, variant) {
    if (i < 220) return null;
    const pc = getPC(bars);
    const idir = pc.indDir[i];
    const ldir = pc.liqDir[i];
    let dir = null, score = 0, stop = null, tp = null, source = modeSpec.kind;
    if (modeSpec.kind === 'ind') {
      if (idir) { dir = idir; score = pc.indScore[i]; stop = pc.indStop[i]; tp = pc.indTp[i]; }
    } else if (modeSpec.kind === 'liq') {
      if (ldir) { dir = ldir; score = 6; }
    } else if (modeSpec.kind === 'and_same') {
      if (idir && ldir && idir === ldir) {
        dir = idir; score = pc.indScore[i]; stop = pc.indStop[i]; tp = pc.indTp[i];
      }
    } else if (modeSpec.kind === 'and_win') {
      const N = modeSpec.N || 3;
      if (idir && liqInWindow(pc.liqDir, i, idir, N)) {
        dir = idir; score = pc.indScore[i]; stop = pc.indStop[i]; tp = pc.indTp[i];
      } else if (ldir && indInWindow(pc.indDir, i, ldir, N)) {
        dir = ldir; score = pc.indScore[i] || 6; stop = pc.indStop[i]; tp = pc.indTp[i];
      }
    } else if (modeSpec.kind === 'or') {
      if (idir) { dir = idir; score = pc.indScore[i]; stop = pc.indStop[i]; tp = pc.indTp[i]; source = 'indicators'; }
      else if (ldir) { dir = ldir; score = 6; source = 'liquidity'; }
    }
    if (!dir) return null;
    const entry = bars[i].c;
    if (!(stop > 0)) {
      const atr = Math.abs(bars[i].h - bars[i].l) || entry * 0.015;
      const dist = Math.max(entry * 0.015, atr);
      stop = dir === 'LONG' ? entry - dist : entry + dist;
      tp = dir === 'LONG' ? entry + 2 * dist : entry - 2 * dist;
    }
    return { direction: dir, score, entry, stop, tp, source, i, t: bars[i].t };
  };
}

function packMetrics(sum) {
  if (!sum) return null;
  const dr = sum.dailyReturns || {};
  return {
    trades: sum.trades, wins: sum.wins, losses: sum.losses, winRate: sum.winRate,
    totalPnl: sum.totalPnl, totalPnlPct: sum.totalPnlPct, endEquity: sum.endEquity,
    profitFactor: sum.profitFactor, maxDd: sum.maxDd, maxDdPct: sum.maxDdPct,
    bestDayPnl: sum.bestDayPnl, bestDayDate: sum.bestDayDate,
    worstDayPnl: sum.worstDayPnl, worstDayDate: sum.worstDayDate,
    hit5plus: sum.hit5plus, lowSample: !!sum.lowSample,
    avgDailyPctAllDays: dr.meanDailyPctAllDays, geoAvgDailyPct: dr.geoAvgDailyPct,
    medianDailyPctAllDays: dr.medianDailyPctAllDays,
    meanDailyPctTradeDays: dr.meanDailyPctTradeDays, medianDailyPctTradeDays: dr.medianDailyPctTradeDays,
    tradeDays: dr.tradeDays, calendarDays: dr.calendarDays,
  };
}

function main() {
  const rows = [];
  console.log('Universe', pass.length);

  for (const iv of TFS) {
    const series = loadSeries(iv);
    console.log('\n===', iv, 'n=', series.length);
    if (series.length < 5) continue;
    // Warm precompute once per series (shared across modes via WeakMap on bars arrays)
    console.log('precompute…');
    for (const s of series) getPC(s.bars);
    console.log('precompute done');

    const { train, test, cut } = study.splitTrainTest(series, study.TRAIN_FRAC);
    const modes = [
      { combine: 'AND_same_bar', kind: 'and_same', label: '(a) AND same-bar' },
      ...WINDOWS.map((N) => ({ combine: `AND_window_${N}`, kind: 'and_win', N, label: `(b) AND within ${N} bars` })),
      { combine: 'OR', kind: 'or', label: '(c) OR either' },
      { combine: 'indicators_only', kind: 'ind', label: 'ref: indicators only' },
      { combine: 'liquidity_only', kind: 'liq', label: 'ref: any liquidity only' },
    ];

    const series60 = series.map((s) => ({
      symbol: s.symbol,
      bars: s.bars, // full; startMs restricts entries
    }));

    for (const m of modes) {
      installSignalAt(m);
      const v = { id: m.combine, label: m.label, mode: 'custom' };
      const t0 = Date.now();
      const tr = study.runPortfolio(train, iv, v);
      const te = study.runPortfolio(test, iv, v);
      const s60 = study.runPortfolio(series60, iv, v, { startMs: since60 });
      const row = {
        interval: iv, combine: m.combine, windowBars: m.N ?? (m.kind === 'and_same' ? 0 : null),
        label: m.label, symbols: series.length, cut: new Date(cut).toISOString(),
        train: packMetrics(study.summarize(tr)),
        oos: packMetrics(study.summarize(te)),
        sixtyDay: packMetrics(study.summarize(s60)),
        elapsedMs: Date.now() - t0,
      };
      rows.push(row);
      console.log(iv, m.combine, 'OOS N', row.oos.trades, 'WR', (100 * (row.oos.winRate || 0)).toFixed(0) + '%',
        'PF', row.oos.profitFactor, 'net%', (row.oos.totalPnlPct || 0).toFixed(2),
        'DD%', (row.oos.maxDdPct || 0).toFixed(2),
        'avgDay%', (row.oos.avgDailyPctAllDays || 0).toFixed(3),
        '| 60d N', row.sixtyDay.trades, 'net%', (row.sixtyDay.totalPnlPct || 0).toFixed(2),
        `${row.elapsedMs}ms`);
    }
  }

  const combineOnly = rows.filter((r) => /^(AND_|OR$)/.test(r.combine));
  const ranked = combineOnly
    .filter((r) => r.oos && r.oos.trades >= 5)
    .map((r) => ({
      ...r,
      score: (r.oos.totalPnlPct || 0) * Math.sqrt(Math.min(r.oos.trades, 200)) * ((r.oos.winRate || 0) >= 0.4 ? 1 : 0.6)
        - (r.oos.maxDdPct || 0) * 0.3,
    }))
    .sort((a, b) => b.score - a.score);

  const report = {
    generatedAt: new Date().toISOString(),
    universe: pass.length,
    capital: CAPITAL,
    modesExplained: {
      a_AND_same_bar: 'Indicators (score≥6) AND any liquidity kind, same closed bar, same direction',
      b_AND_window_N: 'Indicators on bar i with liquidity same dir in [i-N,i], OR liquidity on i with indicators in [i-N,i]',
      c_OR: 'Either indicators OR any liquidity on the bar',
    },
    improveNote: 'Prior whale/HTF filter pass: NO_ADOPT vs 4h liq_buy_side baseline (whale confirm N≈0 on overlap; HTF flat).',
    rows,
    rankedTop: ranked.slice(0, 20).map((r) => ({
      interval: r.interval, combine: r.combine, label: r.label, score: +r.score.toFixed(2),
      oos: r.oos, sixtyDay: r.sixtyDay,
    })),
    bestCombine: ranked[0] || null,
  };

  const csvPath = '/workspace/binance-combine-modes-oos.csv';
  const csv = ['interval,combine,window,oos_trades,oos_wr,oos_pf,oos_pnl_pct,oos_max_dd_pct,oos_avg_daily_pct,d60_trades,d60_wr,d60_pf,d60_pnl_pct,d60_max_dd_pct,d60_avg_daily_pct'];
  for (const r of rows) {
    const o = r.oos || {}, s = r.sixtyDay || {};
    csv.push([
      r.interval, r.combine, r.windowBars ?? '',
      o.trades, (o.winRate || 0).toFixed(3), o.profitFactor, (o.totalPnlPct || 0).toFixed(3), (o.maxDdPct || 0).toFixed(3), (o.avgDailyPctAllDays || 0).toFixed(4),
      s.trades, (s.winRate || 0).toFixed(3), s.profitFactor, (s.totalPnlPct || 0).toFixed(3), (s.maxDdPct || 0).toFixed(3), (s.avgDailyPctAllDays || 0).toFixed(4),
    ].join(','));
  }
  fs.writeFileSync(csvPath, csv.join('\n') + '\n');
  report.csvPath = csvPath;
  fs.writeFileSync(path.join(OUT, 'combine-modes-report.json'), JSON.stringify(report, null, 2));
  // also merge key table into improve report pointer
  fs.writeFileSync(path.join(OUT, 'improve-oos-report.json'), JSON.stringify({
    ...(fs.existsSync(path.join(OUT, 'improve-oos-report.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'improve-oos-report.json'), 'utf8')) : {}),
    combineModes: { best: report.bestCombine, rankedTop: report.rankedTop, csvPath },
    combineGeneratedAt: report.generatedAt,
  }, null, 2));
  console.log('\nBEST', report.bestCombine && { iv: report.bestCombine.interval, combine: report.bestCombine.combine, oos: report.bestCombine.oos, d60: report.bestCombine.sixtyDay });
  console.log('Wrote', path.join(OUT, 'combine-modes-report.json'), csvPath);
}

main();
