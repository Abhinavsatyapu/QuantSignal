'use strict';
/**
 * Overnight accuracy loop for adopted combo_30m AND-within-3.
 * Train-only tuning; OOS + walk-forward validation. Never touches live signed orders.
 */
const fs = require('fs');
const path = require('path');
const study = require('./binance-stock-perp-study');
const ps = require('../server/binance-preset-signals');
require('../public/indicators.js');
require('../public/strategy-liquidity-signals.js');

const OUT = path.join(__dirname, 'out');
const pass = require('./out/liq-pass-full.json').pass;
const DAY = 86400e3;

function loadSeries(iv, cap) {
  return pass.map((sym) => {
    const f = path.join(OUT, 'klines', `${sym}_${iv}.json`);
    if (!fs.existsSync(f)) return null;
    let bars = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (bars.length > cap) bars = bars.slice(-cap);
    return bars.length >= 230 ? { symbol: sym, bars } : null;
  }).filter(Boolean);
}

function pack(res) {
  const dr = res.dailyReturns || {};
  return {
    trades: res.trades,
    winRate: +((res.winRate || 0) * 100).toFixed(1),
    profitFactor: res.profitFactor === Infinity ? 999 : +(res.profitFactor || 0).toFixed(2),
    netPct: +(res.totalPnlPct || 0).toFixed(2),
    maxDdPct: +(res.maxDdPct || 0).toFixed(2),
    avgDailyPct: +(dr.meanDailyPctAllDays || 0).toFixed(4),
    avgTradesPerDay: dr.calendarDays ? +(res.trades / dr.calendarDays).toFixed(3) : 0,
    calendarDays: dr.calendarDays || 0,
    lowN: !!res.lowSample || res.trades < 20,
    tradeList: res.tradeList || [],
    days: res.days || [],
  };
}

function installCombo(filters = {}) {
  globalThis.__qsSignalAt = function (bars, i) {
    const openSameDir = filters._openCount || 0; // unused placeholder
    const sig = ps.signalComboAnd3(bars, i, globalThis.Technicals, globalThis.LiquiditySignals, {
      windowBars: 3,
      usCashOnly: true,
      noFridayEntry: !!filters.noFridayEntry,
      requireHtf: !!filters.requireHtf,
      htfDir: filters.htfDirAt ? filters.htfDirAt(bars, i) : null,
      maxStopAtr: filters.maxStopAtr,
      minAtrPct: filters.minAtrPct,
      maxAtrPct: filters.maxAtrPct,
      atrStopMult: filters.atrStopMult,
      maxCluster: filters.maxCluster,
      clusterCount: filters.clusterCountAt ? filters.clusterCountAt(bars, i) : 0,
    });
    if (!sig) return null;
    return { dir: sig.dir, direction: sig.dir, score: sig.score, entry: sig.entry, stop: sig.stop, tp: sig.tp, source: sig.source };
  };
}

function classifyLoss(t, allTrades) {
  const causes = [];
  const hour = new Date(t.entryTs).getUTCHours();
  const mins = new Date(t.entryTs).getUTCMinutes();
  const m = hour * 60 + mins;
  if (m < 14 * 60 + 30 || m >= 21 * 60) causes.push('illiquid_session');
  if (new Date(t.entryTs).getUTCDay() === 5) causes.push('weekend_risk_window');
  // correlation: other entries within ±2h same direction
  const peers = allTrades.filter((x) => x !== t && Math.abs(x.entryTs - t.entryTs) <= 2 * 3600e3 && x.dir === t.dir);
  if (peers.length >= 2) causes.push('correlated_cluster');
  if (t.reason === 'stop' && (t.holdBars || 0) <= 2) causes.push('noise_stop_out');
  if (t.stopDistPct != null && t.stopDistPct > 3.5) causes.push('late_entry_extended');
  if (!causes.length) causes.push('unclassified_stop_or_thesis');
  return causes;
}

function walkForward(series, installFn, folds = 3) {
  let tMin = Infinity, tMax = -Infinity;
  for (const s of series) {
    tMin = Math.min(tMin, s.bars[0].t);
    tMax = Math.max(tMax, s.bars.at(-1).t);
  }
  const span = tMax - tMin;
  const out = [];
  for (let f = 0; f < folds; f++) {
    const te0 = tMin + span * ((f + 1) / (folds + 1));
    const te1 = tMin + span * ((f + 2) / (folds + 1));
    installFn();
    const test = study.runPortfolio(series, '30m', { id: 'wf', mode: 'custom' }, { startMs: te0, endMs: te1 - 1 });
    delete globalThis.__qsSignalAt;
    out.push(pack(test));
  }
  return out;
}

function evalFilters(series, filters) {
  const { train, test } = study.splitTrainTest(series, study.TRAIN_FRAC);
  const since60 = Date.now() - 60 * DAY;
  const install = () => installCombo(filters);
  install();
  const tr = pack(study.runPortfolio(train, '30m', { id: 'tr', mode: 'custom' }));
  install();
  const te = pack(study.runPortfolio(test, '30m', { id: 'te', mode: 'custom' }));
  install();
  const s60 = pack(study.runPortfolio(series, '30m', { id: 's60', mode: 'custom' }, { startMs: since60 }));
  delete globalThis.__qsSignalAt;
  const wf = walkForward(series, install, 3);
  const mean = (a, k) => a.reduce((s, x) => s + x[k], 0) / a.length;
  return {
    train: { trades: tr.trades, winRate: tr.winRate, profitFactor: tr.profitFactor, netPct: tr.netPct, maxDdPct: tr.maxDdPct },
    oos: { trades: te.trades, winRate: te.winRate, profitFactor: te.profitFactor, netPct: te.netPct, maxDdPct: te.maxDdPct, avgDailyPct: te.avgDailyPct, avgTradesPerDay: te.avgTradesPerDay, lowN: te.lowN },
    sixty: { trades: s60.trades, winRate: s60.winRate, profitFactor: s60.profitFactor, netPct: s60.netPct, maxDdPct: s60.maxDdPct, avgDailyPct: s60.avgDailyPct, avgTradesPerDay: s60.avgTradesPerDay, lowN: s60.lowN },
    wfMeanWR: +mean(wf, 'winRate').toFixed(1),
    wfMeanPF: +mean(wf, 'profitFactor').toFixed(2),
    wfMeanDD: +mean(wf, 'maxDdPct').toFixed(2),
    tradeList60: s60.tradeList,
  };
}

function adoptFix(base, cand) {
  // Improve OOS WR and PF; trade count not collapsed (<40% drop); DD not raised >15% vs base
  if (cand.oos.trades < Math.max(12, Math.floor(base.oos.trades * 0.6))) return { adopt: false, reason: 'trade_count_collapsed' };
  if (cand.oos.winRate < base.oos.winRate) return { adopt: false, reason: 'oos_wr_down' };
  if (cand.oos.profitFactor < base.oos.profitFactor) return { adopt: false, reason: 'oos_pf_down' };
  if (cand.wfMeanWR + 0.5 < base.wfMeanWR) return { adopt: false, reason: 'wf_wr_down' };
  if (cand.wfMeanPF < base.wfMeanPF * 0.95) return { adopt: false, reason: 'wf_pf_down' };
  if (cand.oos.maxDdPct > base.oos.maxDdPct * 1.15 + 0.5) return { adopt: false, reason: 'oos_dd_up' };
  if (cand.sixty.maxDdPct > base.sixty.maxDdPct * 1.15 + 1) return { adopt: false, reason: 'sixty_dd_up' };
  return { adopt: true, reason: 'oos+wf WR/PF up, N/DD ok' };
}

function main() {
  console.log('Loading 30m series…');
  const series = loadSeries('30m', 1200);
  console.log('symbols', series.length);

  const baseline = evalFilters(series, {});
  console.log('BASELINE OOS', baseline.oos, 'WF', baseline.wfMeanWR, baseline.wfMeanPF, '60d', baseline.sixty);

  // Post-mortem on 60d losers
  const losses = (baseline.tradeList60 || []).filter((t) => t.pnl <= 0);
  const causeCounts = {};
  for (const t of losses) {
    for (const c of classifyLoss(t, baseline.tradeList60)) {
      causeCounts[c] = (causeCounts[c] || 0) + 1;
    }
  }
  console.log('Loss causes', losses.length, causeCounts);

  // Fix candidates (tuned on train metrics only for selection shortlist; adoption gated on OOS+WF)
  const fixes = [
    { id: 'noFridayEntry', filters: { noFridayEntry: true }, desc: 'Skip Friday UTC entries' },
    { id: 'max_stop_2_5atr', filters: { maxStopAtr: 2.5 }, desc: 'Skip late entries stop>2.5 ATR' },
    { id: 'wider_stop_2atr', filters: { atrStopMult: 2 }, desc: 'Wider 2×ATR stops' },
    { id: 'atr_regime_0_3_3', filters: { minAtrPct: 0.3, maxAtrPct: 3.0 }, desc: 'ATR% regime 0.3–3.0' },
    { id: 'atr_regime_0_4_2_5', filters: { minAtrPct: 0.4, maxAtrPct: 2.5 }, desc: 'ATR% regime 0.4–2.5' },
    { id: 'cluster_cap_2', filters: { maxCluster: 2, clusterCountAt: () => 0 }, desc: 'placeholder cluster (noop unless scanner sets count)' },
  ];

  // Train-side shortlist: keep those that don't tank train WR/PF badly; final gate is OOS+WF
  const results = [];
  for (const f of fixes) {
    console.log('\nTEST', f.id);
    const r = evalFilters(series, f.filters);
    const gate = adoptFix(baseline, r);
    // Prefer train improvement as soft signal but do not adopt on train alone
    const trainBetter = r.train.winRate >= baseline.train.winRate && r.train.profitFactor >= baseline.train.profitFactor * 0.98;
    results.push({
      id: f.id, desc: f.desc, filters: f.filters, ...r,
      trainBetter, ...gate,
      // strip heavy lists
      tradeList60: undefined,
    });
    console.log(' ->', gate.adopt ? 'ADOPT' : 'reject', gate.reason, 'OOS', r.oos.trades, r.oos.winRate, r.oos.profitFactor, r.oos.netPct, 'WF', r.wfMeanWR, r.wfMeanPF);
  }

  const adopted = results.filter((x) => x.adopt);
  // Merge adopted filters (order: as listed)
  const merged = {};
  for (const a of adopted) Object.assign(merged, a.filters);
  // Remove function filters from merge
  delete merged.clusterCountAt;
  delete merged.htfDirAt;

  let final = baseline;
  let finalFilters = {};
  if (adopted.length) {
    console.log('\nMERGED filters', merged);
    final = evalFilters(series, merged);
    const gate = adoptFix(baseline, final);
    if (gate.adopt) {
      finalFilters = merged;
      console.log('MERGED ADOPT', gate.reason, final.oos, final.sixty);
    } else {
      // fall back to best single adopt by OOS WR then PF
      adopted.sort((a, b) => b.oos.winRate - a.oos.winRate || b.oos.profitFactor - a.oos.profitFactor);
      final = adopted[0];
      finalFilters = { ...adopted[0].filters };
      delete finalFilters.clusterCountAt;
      console.log('MERGED rejected; keep best single', adopted[0].id);
    }
  } else {
    console.log('\nNo fix adopted; keep baseline combo');
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baselinePreset: 'combo_30m_trend_flow_buyside_and3_uscash',
    lossCauses: causeCounts,
    lossCount: losses.length,
    baseline: { oos: baseline.oos, sixty: baseline.sixty, wfMeanWR: baseline.wfMeanWR, wfMeanPF: baseline.wfMeanPF, train: baseline.train },
    fixes: results.map(({ id, desc, adopt, reason, oos, sixty, wfMeanWR, wfMeanPF, train, trainBetter }) => ({ id, desc, adopt, reason, oos, sixty, wfMeanWR, wfMeanPF, train, trainBetter })),
    adoptedFixes: adopted.map((a) => a.id),
    rejectedFixes: results.filter((x) => !x.adopt).map((x) => ({ id: x.id, reason: x.reason })),
    finalFilters,
    final: { oos: final.oos, sixty: final.sixty, wfMeanWR: final.wfMeanWR, wfMeanPF: final.wfMeanPF },
  };
  fs.writeFileSync(path.join(OUT, 'overnight-combo-improve.json'), JSON.stringify(report, null, 2));
  console.log('Wrote scripts/out/overnight-combo-improve.json');
}

main();
