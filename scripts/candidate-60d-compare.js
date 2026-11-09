'use strict';
/**
 * 60d candidate comparison vs Setup B (combine_1h_and_window_3_uscash).
 * Does NOT change live preset by itself — parent/adopter decides.
 */
const fs = require('fs');
const path = require('path');
const study = require('./binance-stock-perp-study');
require('../public/indicators.js');
require('../public/strategy-liquidity-signals.js');

const OUT = path.join(__dirname, 'out');
const pass = require('./out/liq-pass-full.json').pass;
const DAY = 86400e3;

function usCashUTC(ts) {
  const d = new Date(ts);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= (14 * 60 + 30) && mins < (21 * 60);
}
function isFridayUTC(ts) { return new Date(ts).getUTCDay() === 5; }
function atr(bars, i, n = 14) {
  if (i < n) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) {
    const h = bars[j].h, l = bars[j].l, pc = bars[j - 1].c;
    s += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return s / n;
}
function stops(bars, i, dir) {
  const entry = bars[i].c;
  const a = atr(bars, i, 14) || Math.abs(bars[i].h - bars[i].l) || entry * 0.015;
  const dist = Math.max(entry * 0.015, 1.5 * a);
  return {
    entry,
    stop: dir === 'LONG' ? entry - dist : entry + dist,
    tp: dir === 'LONG' ? entry + 2 * dist : entry - 2 * dist,
  };
}
function dirTrend(a, last) {
  const bull = last.c > a.sma200 && a.ema20 > a.ema50 && last.c > a.sma50;
  const bear = last.c < a.sma200 && a.ema20 < a.ema50 && last.c < a.sma50;
  if (bull) return 'LONG';
  if (bear) return 'SHORT';
  return null;
}
function dirFlow(a, last) {
  if (a.volumeRatio >= 1 && last.c > a.vwap && a.obvSlope > 0) return 'LONG';
  if (a.volumeRatio >= 1 && last.c < a.vwap && a.obvSlope < 0) return 'SHORT';
  return null;
}
function dirBuySide(liq) {
  const sigs = (liq.signals || []).filter((s) => s.kind === 'buy_side_liquidity_taken');
  const L = sigs.filter((s) => s.side === 'LONG').length;
  const S = sigs.filter((s) => s.side === 'SHORT').length;
  if (L > S) return 'LONG';
  if (S > L) return 'SHORT';
  return null;
}
function analyzeAt(bars, i) {
  const window = bars.slice(Math.max(0, i + 1 - 260), i + 1);
  const a = globalThis.Technicals.analyze(window, window[window.length - 1].T + 1, { minStopPct: 1.5 });
  const liq = globalThis.LiquiditySignals.detect(window, {});
  const last = window[window.length - 1];
  return { a, liq, last, trend: dirTrend(a, last), flow: dirFlow(a, last), buy: dirBuySide(liq) };
}
function precomputeSetupB(bars) {
  const n = bars.length;
  const indDir = new Array(n).fill(null);
  const liqDir = new Array(n).fill(null);
  const indStop = new Array(n).fill(null);
  const indTp = new Array(n).fill(null);
  const indScore = new Array(n).fill(0);
  for (let i = 220; i < n; i++) {
    try {
      const window = bars.slice(Math.max(0, i + 1 - 260), i + 1);
      const a = globalThis.Technicals.analyze(window, window[window.length - 1].T + 1, { minStopPct: 1.5 });
      if (['LONG', 'SHORT'].includes(a.direction) && (a.score || 0) >= 6) {
        indDir[i] = a.direction; indScore[i] = a.score; indStop[i] = a.stop; indTp[i] = a.tp1;
      }
      const liq = globalThis.LiquiditySignals.detect(window, {});
      const sigs = liq.signals || [];
      const L = sigs.filter((s) => s.side === 'LONG').length;
      const S = sigs.filter((s) => s.side === 'SHORT').length;
      if (L > S) liqDir[i] = 'LONG';
      else if (S > L) liqDir[i] = 'SHORT';
    } catch {}
  }
  return { indDir, liqDir, indStop, indTp, indScore };
}
function inWin(arr, i, dir, N) {
  for (let b = 0; b <= N; b++) {
    const j = i - b;
    if (j < 0) break;
    if (arr[j] === dir) return true;
  }
  return false;
}
function loadSeries(iv, cap) {
  return pass.map((sym) => {
    const f = path.join(OUT, 'klines', `${sym}_${iv}.json`);
    if (!fs.existsSync(f)) return null;
    let bars = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (bars.length > cap) bars = bars.slice(-cap);
    if (bars.length < 230) return null;
    return { symbol: sym, bars };
  }).filter(Boolean);
}
function pack(res) {
  const dr = res.dailyReturns || {};
  const calDays = dr.calendarDays || (res.days || []).length || 0;
  return {
    trades: res.trades,
    avgTradesPerDay: calDays ? +(res.trades / calDays).toFixed(3) : 0,
    winRate: +((res.winRate || 0) * 100).toFixed(1),
    profitFactor: res.profitFactor === Infinity ? 999 : +(res.profitFactor || 0).toFixed(2),
    netPct: +(res.totalPnlPct || 0).toFixed(2),
    maxDdPct: +(res.maxDdPct || 0).toFixed(2),
    avgDailyPct: +(dr.meanDailyPctAllDays || 0).toFixed(4),
    geoAvgDailyPct: +(dr.geoAvgDailyPct || 0).toFixed(4),
    endEquity: +(res.endEquity || 0).toFixed(2),
    calendarDays: calDays,
    tradeDays: dr.tradeDays || 0,
    lowN: !!res.lowSample || res.trades < 30,
  };
}
function walkForward(series, iv, installFn, folds = 3) {
  let tMin = Infinity, tMax = -Infinity;
  for (const s of series) {
    if (s.bars[0].t < tMin) tMin = s.bars[0].t;
    if (s.bars.at(-1).t > tMax) tMax = s.bars.at(-1).t;
  }
  const span = tMax - tMin;
  const out = [];
  for (let f = 0; f < folds; f++) {
    const te0 = tMin + span * ((f + 1) / (folds + 1));
    const te1 = tMin + span * ((f + 2) / (folds + 1));
    installFn();
    const train = study.runPortfolio(series, iv, { id: 'wf_tr', mode: 'custom' }, { endMs: te0 - 1 });
    const test = study.runPortfolio(series, iv, { id: 'wf_te', mode: 'custom' }, { startMs: te0, endMs: te1 - 1 });
    delete globalThis.__qsSignalAt;
    out.push({ fold: f + 1, train: pack(train), test: pack(test) });
  }
  return out;
}
function evalCandidate(c, seriesByIv) {
  const series = seriesByIv[c.interval];
  const since60 = Date.now() - 60 * DAY;
  const install = () => c.install();
  install();
  const full = study.runPortfolio(series, c.interval, { id: c.id, mode: 'custom' });
  const s60 = study.runPortfolio(series, c.interval, { id: c.id, mode: 'custom' }, { startMs: since60 });
  const { train, test } = study.splitTrainTest(series, study.TRAIN_FRAC);
  install();
  const tr = study.runPortfolio(train, c.interval, { id: c.id, mode: 'custom' });
  const te = study.runPortfolio(test, c.interval, { id: c.id, mode: 'custom' });
  delete globalThis.__qsSignalAt;
  const wf = walkForward(series, c.interval, install, 3);
  const wfTestNet = wf.map((x) => x.test.netPct);
  const wfTestWR = wf.map((x) => x.test.winRate);
  const wfTestPF = wf.map((x) => x.test.profitFactor);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return {
    id: c.id, name: c.name, interval: c.interval, notes: c.notes || '',
    full: pack(full), sixty: pack(s60), train: pack(tr), oos: pack(te),
    walkForward: wf,
    walkForwardMeanTestNetPct: +mean(wfTestNet).toFixed(2),
    walkForwardMeanTestWR: +mean(wfTestWR).toFixed(1),
    walkForwardMeanTestPF: +mean(wfTestPF).toFixed(2),
    walkForwardLowN: wf.some((x) => x.test.lowN),
  };
}

function main() {
  console.log('Universe', pass.length);
  const seriesByIv = { '30m': loadSeries('30m', 1200), '1h': loadSeries('1h', 1000) };
  console.log('30m', seriesByIv['30m'].length, '1h', seriesByIv['1h'].length);
  const bCache = new WeakMap();
  const getB = (bars) => { let x = bCache.get(bars); if (!x) { x = precomputeSetupB(bars); bCache.set(bars, x); } return x; };

  function installSetupB(noFriday) {
    globalThis.__qsSignalAt = function (bars, i) {
      if (i < 220) return null;
      if (!usCashUTC(bars[i].t)) return null;
      if (noFriday && isFridayUTC(bars[i].t)) return null;
      const pc = getB(bars);
      const N = 3;
      let dir = null, stop = null, tp = null, score = 6;
      const idir = pc.indDir[i], ldir = pc.liqDir[i];
      if (idir && inWin(pc.liqDir, i, idir, N)) { dir = idir; score = pc.indScore[i]; stop = pc.indStop[i]; tp = pc.indTp[i]; }
      else if (ldir && inWin(pc.indDir, i, ldir, N)) { dir = ldir; score = pc.indScore[i] || 6; stop = pc.indStop[i]; tp = pc.indTp[i]; }
      if (!dir) return null;
      if (!(stop > 0)) { const s = stops(bars, i, dir); stop = s.stop; tp = s.tp; }
      return { dir, direction: dir, score, entry: bars[i].c, stop, tp, source: 'setupB' };
    };
  }

  const candidates = [
    {
      id: 'setupB_uscash_noFri_ON',
      name: 'Setup B · 1h AND-w3 + US cash + noFriday ON (current live filters)',
      interval: '1h', notes: 'Current dry-run baseline',
      install: () => installSetupB(true),
    },
    {
      id: 'setupB_uscash_noFri_OFF',
      name: 'Setup B · 1h AND-w3 + US cash + noFriday OFF',
      interval: '1h', notes: 'Friday entries allowed',
      install: () => installSetupB(false),
    },
    {
      id: 'liq_buy_side_30m_uscash',
      name: 'liq_buy_side alone · 30m · US cash',
      interval: '30m',
      install() {
        globalThis.__qsSignalAt = function (bars, i) {
          if (i < 220) return null;
          if (!usCashUTC(bars[i].t)) return null;
          let dir = null;
          try {
            const window = bars.slice(Math.max(0, i + 1 - 260), i + 1);
            dir = dirBuySide(globalThis.LiquiditySignals.detect(window, {}));
          } catch {}
          if (!dir) return null;
          const s = stops(bars, i, dir);
          return { dir, direction: dir, score: 6, ...s, source: 'liq_buy_side' };
        };
      },
    },
    {
      id: 'combo30_and_window3',
      name: '30m combo trend+flow+buy-side · AND within 3 bars',
      interval: '30m',
      install() {
        const cache = new WeakMap();
        function pc(bars) {
          let x = cache.get(bars);
          if (x) return x;
          const n = bars.length;
          const trend = new Array(n).fill(null), flow = new Array(n).fill(null), buy = new Array(n).fill(null);
          for (let i = 220; i < n; i++) {
            try { const r = analyzeAt(bars, i); trend[i] = r.trend; flow[i] = r.flow; buy[i] = r.buy; } catch {}
          }
          x = { trend, flow, buy }; cache.set(bars, x); return x;
        }
        globalThis.__qsSignalAt = function (bars, i) {
          if (i < 220) return null;
          if (!usCashUTC(bars[i].t)) return null;
          const p = pc(bars);
          for (const D of ['LONG', 'SHORT']) {
            if (inWin(p.trend, i, D, 3) && inWin(p.flow, i, D, 3) && inWin(p.buy, i, D, 3)) {
              const s = stops(bars, i, D);
              return { dir: D, direction: D, score: 7, ...s, source: 'combo_and3' };
            }
          }
          return null;
        };
      },
    },
    {
      id: 'combo30_vote2of3',
      name: '30m combo trend+flow+buy-side · 2-of-3 voting',
      interval: '30m',
      install() {
        globalThis.__qsSignalAt = function (bars, i) {
          if (i < 220) return null;
          if (!usCashUTC(bars[i].t)) return null;
          let trend = null, flow = null, buy = null;
          try { const r = analyzeAt(bars, i); trend = r.trend; flow = r.flow; buy = r.buy; } catch { return null; }
          const votes = { LONG: 0, SHORT: 0 };
          for (const d of [trend, flow, buy]) if (d) votes[d] += 1;
          let dir = null;
          if (votes.LONG >= 2 && votes.LONG > votes.SHORT) dir = 'LONG';
          else if (votes.SHORT >= 2 && votes.SHORT > votes.LONG) dir = 'SHORT';
          if (!dir) return null;
          const s = stops(bars, i, dir);
          return { dir, direction: dir, score: 6 + Math.max(votes.LONG, votes.SHORT), ...s, source: 'combo_vote2' };
        };
      },
    },
  ];

  const results = [];
  for (const c of candidates) {
    console.log('\n===', c.id);
    const t0 = Date.now();
    const r = evalCandidate(c, seriesByIv);
    r.ms = Date.now() - t0;
    results.push(r);
    console.log('60d N', r.sixty.trades, 'WR', r.sixty.winRate, 'PF', r.sixty.profitFactor, 'net', r.sixty.netPct,
      'DD', r.sixty.maxDdPct, 'OOS N', r.oos.trades, 'WR', r.oos.winRate, 'PF', r.oos.profitFactor, 'net', r.oos.netPct,
      'WF WR', r.walkForwardMeanTestWR, 'WF PF', r.walkForwardMeanTestPF, r.sixty.lowN ? 'LOW_N' : '', r.ms + 'ms');
  }

  // Robust ranking vs Setup B baseline (noFri ON)
  const baseline = results.find((r) => r.id === 'setupB_uscash_noFri_ON');
  const baseDd = baseline.oos.maxDdPct;
  const ranked = results.map((r) => {
    const oosNok = r.oos.trades >= 12;
    const wfNok = !r.walkForwardLowN || r.walkForward.every((f) => f.test.trades >= 5);
    const ddOk = r.oos.maxDdPct <= Math.max(baseDd * 1.15, baseDd + 2); // no worse than B (+15% or +2pp)
    const score = (r.oos.winRate * 0.45 + r.walkForwardMeanTestWR * 0.25)
      + Math.min(r.oos.profitFactor, 5) * 8
      + Math.min(r.walkForwardMeanTestPF, 5) * 5
      + Math.min(r.oos.trades, 40) * 0.15
      - r.oos.maxDdPct * 0.4;
    return { ...r, robustEligible: oosNok && ddOk && r.oos.profitFactor >= 1 && r.walkForwardMeanTestPF >= 0.9, score: +score.toFixed(2) };
  }).sort((a, b) => b.score - a.score);

  const better = ranked.filter((r) => r.id !== baseline.id && r.robustEligible
    && r.oos.winRate >= baseline.oos.winRate
    && r.oos.profitFactor >= baseline.oos.profitFactor
    && r.walkForwardMeanTestWR >= baseline.walkForwardMeanTestWR - 1
    && r.walkForwardMeanTestPF >= baseline.walkForwardMeanTestPF * 0.95);

  const adopt = better[0] || baseline;
  const adoptReason = better[0]
    ? `Beats Setup B on OOS WR/PF with WF support, trades>=12, DD not worse than B (${baseDd}%).`
    : 'No candidate robustly beat Setup B on OOS+WF WR/PF with adequate N and DD; keep Setup B.';

  // Grid audit vs prior report
  const grid = JSON.parse(fs.readFileSync(path.join(OUT, 'signal-tf-grid.json'), 'utf8'));
  const cash = grid.rows.filter((r) => r.filter === 'us_cash');
  const reported = {
    ind_trend: { '5m': -15.6, '10m': 23.7, '15m': -0.3, '30m': 38.9, '1h': 9.3, '4h': -2.6 },
    ind_momentum: { '5m': -8.1, '10m': 25.9, '15m': 14.1, '30m': 28.1, '1h': 25.8, '4h': 2.0 },
    ind_pressure: { '5m': 4.1, '10m': 9.8, '15m': 12.6, '30m': 25.1, '1h': 6.8, '4h': 4.8 },
    ind_flow: { '5m': 21.6, '10m': 34.2, '15m': 26.3, '30m': 35.0, '1h': 15.9, '4h': -3.4 },
    liq_grab: { '5m': -6.8, '10m': 32.6, '15m': 2.3, '30m': 13.6, '1h': 21.9, '4h': -1.4 },
    liq_sweep: { '5m': -11.2, '10m': -11.8, '15m': 3.2, '30m': 21.0, '1h': -1.3, '4h': 3.8 },
    liq_buy_side: { '5m': 2.8, '10m': 24.1, '15m': 2.1, '30m': 39.3, '1h': 4.5, '4h': -0.9 },
    liq_sell_side: { '5m': -1.2, '10m': 11.6, '15m': -12.1, '30m': -9.8, '1h': 14.3, '4h': 4.6 },
  };
  const corrections = [];
  for (const [sig, ivs] of Object.entries(reported)) {
    for (const [iv, rep] of Object.entries(ivs)) {
      const row = cash.find((x) => x.signal === sig && x.interval === iv);
      const exact = row ? +Number(row.oosNetPct).toFixed(2) : null;
      if (exact == null || Math.abs(exact - rep) >= 0.05) {
        corrections.push({ signal: sig, interval: iv, reported: rep, jsonExact: exact, oosTrades: row?.oosTrades ?? 0, delta: exact == null ? null : +(exact - rep).toFixed(2) });
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    universe: pass.length,
    capital: study.CAPITAL, leverage: study.LEVERAGE, maxPositions: study.MAX_POS,
    riskPerTradePct: study.RISK_PCT, compounding: true, dailyHalts: false,
    usCash: '14:30–21:00 UTC',
    harnessNote: 'Fixed runPortfolio to honor sig.direction as well as sig.dir.',
    results, ranked: ranked.map((r) => ({ id: r.id, score: r.score, robustEligible: r.robustEligible, oos: r.oos, wfWR: r.walkForwardMeanTestWR, wfPF: r.walkForwardMeanTestPF })),
    baselineId: baseline.id,
    adopt: { id: adopt.id, name: adopt.name, interval: adopt.interval, reason: adoptReason, oos: adopt.oos, sixty: adopt.sixty, wfWR: adopt.walkForwardMeanTestWR, wfPF: adopt.walkForwardMeanTestPF },
    gridAudit: { corrections, caveat: 'Prior grid hooks returned direction not dir; longs may have been mishandled before harness fix. Display deltas mostly rounding.' },
  };
  fs.writeFileSync(path.join(OUT, 'candidate-60d-compare.json'), JSON.stringify(report, null, 2));
  console.log('\nADOPT', adopt.id, adoptReason);
  console.log('Grid corrections', corrections.length);
  console.log('Wrote scripts/out/candidate-60d-compare.json');
}
main();
