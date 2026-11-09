'use strict';
const fs = require('fs');
const path = require('path');
const study = require('./binance-stock-perp-study');
require('../public/indicators.js');
require('../public/strategy-liquidity-signals.js');

const OUT = study.OUT;
const TRAIN_FRAC = study.TRAIN_FRAC;
const BASE_IV = '4h';
const BASE_VAR = study.VARIANTS.find((v) => v.id === 'any') || study.VARIANTS[0];

function loadSeries(interval) {
  const dir = path.join(OUT, 'klines');
  const syms = [...new Set(fs.readdirSync(dir).filter((f) => f.endsWith(`_${interval}.json`)).map((f) => f.replace(/_.*$/, '')))];
  return syms.map((sym) => ({
    symbol: sym,
    bars: JSON.parse(fs.readFileSync(path.join(dir, `${sym}_${interval}.json`), 'utf8')),
  })).filter((s) => s.bars.length > 250);
}

function metrics(r) {
  return {
    trades: r.trades,
    winRate: +((r.winRate || 0) * 100).toFixed(1) / 100,
    profitFactor: Number.isFinite(r.profitFactor) ? +r.profitFactor.toFixed(2) : (r.wins ? null : 0),
    maxDdPct: +r.maxDdPct.toFixed(2),
    totalPnl: +r.totalPnl.toFixed(2),
    totalPnlPct: +r.totalPnlPct.toFixed(2),
    lowSample: !!r.lowSample,
    avgHoldBars: r.avgHoldBars != null ? +r.avgHoldBars.toFixed(1) : null,
  };
}

function diagnose(tradeList) {
  const losses = (tradeList || []).filter((t) => t.pnl <= 0);
  const group = (arr, keyFn) => {
    const m = new Map();
    for (const t of arr) {
      const k = keyFn(t);
      const g = m.get(k) || { n: 0, pnl: 0, stops: 0, timeExits: 0 };
      g.n += 1; g.pnl += t.pnl;
      if (t.reason === 'stop') g.stops += 1;
      if (t.reason === 'max hold' || t.reason === 'eod_flatten') g.timeExits += 1;
      m.set(k, g);
    }
    return [...m.entries()].map(([k, v]) => ({ key: k, ...v, pnl: +v.pnl.toFixed(2) })).sort((a, b) => a.pnl - b.pnl);
  };
  const holdBucket = (t) => {
    const h = t.holdBars || 1;
    if (h <= 4) return '1-4 bars';
    if (h <= 20) return '5-20 bars';
    if (h <= 60) return '21-60 bars';
    return '61+ bars';
  };
  const session = (t) => {
    const h = t.entryHourIST != null ? t.entryHourIST : new Date(t.entryTs + 5.5 * 3600e3).getUTCHours();
    if (h >= 19 || h <= 2) return 'US_cash_IST';
    if (h >= 9 && h <= 16) return 'India_day';
    return 'off_hours';
  };
  return {
    nLosses: losses.length,
    nWins: (tradeList || []).filter((t) => t.pnl > 0).length,
    lossPnl: +losses.reduce((s, t) => s + t.pnl, 0).toFixed(2),
    byPair: group(losses, (t) => t.symbol).slice(0, 10),
    byReason: group(losses, (t) => t.reason),
    bySource: group(losses, (t) => t.source || 'unknown'),
    bySession: group(losses, session),
    byHold: group(losses, holdBucket),
    byDow: group(losses, (t) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][t.entryDowIST != null ? t.entryDowIST : new Date(t.entryTs + 5.5 * 3600e3).getUTCDay()]),
    stopVsTime: {
      stop: losses.filter((t) => t.reason === 'stop').length,
      maxHold: losses.filter((t) => t.reason === 'max hold').length,
      eod: losses.filter((t) => t.reason === 'eod_flatten').length,
    },
  };
}

function oosScore(m) {
  if (!m || m.trades < 3) return -1e9;
  return m.totalPnlPct * Math.sqrt(Math.min(m.trades, 200)) * (m.winRate >= 0.4 ? 1 : 0.6) - m.maxDdPct * 0.3;
}

function run(series, rules) {
  study.setActiveRules(rules || null);
  try { return study.runPortfolio(series, BASE_IV, BASE_VAR); }
  finally { study.setActiveRules(null); }
}

function main() {
  const series = loadSeries(BASE_IV);
  if (!series.length) throw new Error('No cached klines for ' + BASE_IV);
  const { train, test, cut } = study.splitTrainTest(series, TRAIN_FRAC);
  console.log('symbols', series.map((s) => s.symbol).join(','), 'cut', new Date(cut).toISOString());

  const baselineFull = run(series, null);
  const baselineTrain = run(train, null);
  const baselineTest = run(test, null);
  const diagnosis = { full: diagnose(baselineFull.tradeList), train: diagnose(baselineTrain.tradeList), test: diagnose(baselineTest.tradeList) };
  console.log('Losses by reason', diagnosis.full.byReason);
  console.log('Losses by pair', diagnosis.full.byPair);
  console.log('Losses by session', diagnosis.full.bySession);
  console.log('Losses by source', diagnosis.full.bySource);

  const proposals = [
    { id: 'baseline', label: 'Baseline 4h any' },
    { id: 'confirm_all', label: 'Require indicator+liquidity confirm', requireConfirm: true },
    { id: 'min_score_8', label: 'Min indicator score 8', minScore: 8 },
    { id: 'no_liq_only', label: 'Block liquidity-only entries', noLiquidityOnly: true },
    { id: 'us_cash', label: 'US cash hours only (IST)', usCashOnly: true },
    { id: 'no_friday', label: 'Skip Friday entries', noFridayEntry: true },
    { id: 'tighter_stop_rr25', label: 'ATR stop×2.2 + TP 2.5R', atrStopMult: 2.2, rr: 2.5 },
    { id: 'wider_stop_rr2', label: 'ATR stop×3.5 + TP 2R', atrStopMult: 3.5, rr: 2 },
    { id: 'shorter_hold', label: 'Max-hold ×0.6', maxHoldScale: 0.6 },
    { id: 'combo_confirm_score', label: 'Confirm + min score 7', requireConfirm: true, minScore: 7 },
    { id: 'combo_noliq_us', label: 'No liq-only + US cash', noLiquidityOnly: true, usCashOnly: true },
    { id: 'combo_best_guess', label: 'Confirm + no Fri + stop×2.5 RR2.5', requireConfirm: true, noFridayEntry: true, atrStopMult: 2.5, rr: 2.5 },
  ];

  const baseTest = metrics(baselineTest);
  const baseTrain = metrics(baselineTrain);
  const rows = [];
  for (const rules of proposals) {
    const isBase = rules.id === 'baseline';
    const tr = isBase ? baselineTrain : run(train, rules);
    const te = isBase ? baselineTest : run(test, rules);
    const full = isBase ? baselineFull : run(series, rules);
    const row = {
      id: rules.id, label: rules.label,
      train: metrics(tr), test: metrics(te), full: metrics(full),
      trainScore: oosScore(metrics(tr)), testScore: oosScore(metrics(te)),
      improvesOOS: false,
    };
    rows.push(row);
    console.log(rules.id, 'trainPnL%', row.train.totalPnlPct, 'testPnL%', row.test.totalPnlPct, 'testN', row.test.trades, 'testWR', row.test.winRate);
  }
  for (const r of rows) {
    r.improvesOOS = r.id !== 'baseline'
      && r.testScore > oosScore(baseTest)
      && r.test.totalPnlPct >= baseTest.totalPnlPct
      && (r.test.maxDdPct <= baseTest.maxDdPct * 1.25 || r.test.totalPnlPct > baseTest.totalPnlPct * 1.15)
      && r.test.trades >= 3;
  }
  const adoptable = rows.filter((r) => r.improvesOOS).sort((a, b) => b.testScore - a.testScore);
  const adopted = adoptable[0] || null;

  // Persist recommended ruleset for live config selection
  const recommendedConfig = adopted
    ? {
        id: adopted.id,
        label: adopted.label,
        interval: BASE_IV,
        variant: 'any',
        rules: proposals.find((p) => p.id === adopted.id),
        selectable: true,
        source: 'oos_improvement_pass',
      }
    : {
        id: 'baseline',
        label: 'Baseline 4h any',
        interval: BASE_IV,
        variant: 'any',
        rules: null,
        selectable: true,
        source: 'oos_baseline_no_improve',
      };

  const report = {
    generatedAt: new Date().toISOString(),
    baseline: { interval: BASE_IV, variant: BASE_VAR.id },
    trainFrac: TRAIN_FRAC,
    cutIso: new Date(cut).toISOString(),
    diagnosis,
    before: { train: baseTrain, test: baseTest, full: metrics(baselineFull) },
    proposals: rows,
    adopted: adopted ? {
      id: adopted.id, label: adopted.label,
      reason: 'Best OOS test score among proposals that beat baseline test PnL% (tuned on train only).',
      beforeTest: baseTest, afterTest: adopted.test,
      beforeTrain: baseTrain, afterTrain: adopted.train,
      full: adopted.full,
    } : null,
    recommendedConfig,
    honestNote: adopted
      ? 'Adopted rules improved out-of-sample test metrics vs baseline. Sample sizes remain small — treat as tentative; 5–6%/day still not evidenced.'
      : 'No proposed rule set beat baseline out-of-sample on the held-out test window. Baseline remains recommended. Train-only wins were not adopted.',
  };
  fs.writeFileSync(path.join(OUT, 'improvement-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, 'recommended-ruleset.json'), JSON.stringify(recommendedConfig, null, 2));
  console.log('\nADOPTED', adopted ? adopted.id : '(none — keep baseline)');
  console.log(report.honestNote);
}

main();
