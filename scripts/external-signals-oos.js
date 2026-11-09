'use strict';
/**
 * Test well-known external approaches on the same 62 US-equity perp universe.
 * OOS (60% train / 40% test) + 3-fold walk-forward. US cash 14:30–21:00 UTC.
 * Sources cited in report JSON for canvas.
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
const SOURCES = [
  { id: 'ORB', title: 'Opening Range Breakout', url: 'https://en.wikipedia.org/wiki/Opening_range', note: 'Classic first-hour / opening-range breakout used by day traders (Crabel-style ORB folklore; Wikipedia Opening range).' },
  { id: 'VWAP', title: 'VWAP reclaim / rejection', url: 'https://www.investopedia.com/terms/v/vwap.asp', note: 'Institutional VWAP as fair-value anchor; reclaim/rejection entries (Investopedia VWAP).' },
  { id: 'RS_SPY', title: 'Relative strength vs SPY', url: 'https://www.investopedia.com/terms/r/relativestrength.asp', note: 'Relative strength vs benchmark (Investopedia Relative Strength).' },
  { id: 'BOS', title: 'Break of structure', url: 'https://www.babypips.com/learn/forex/market-structure', note: 'Market-structure swing break (BabyPips market structure / ICT BOS vernacular).' },
  { id: 'LIQ_MR', title: 'Mean-reversion at liquidity grab', url: 'https://www.investopedia.com/terms/m/meanreversion.asp', note: 'Fade liquidity grabs (mean reversion after stop-run; Investopedia Mean Reversion + ICT liquidity ideas).' },
  { id: 'SPY_REGIME', title: 'SPY trend regime filter', url: 'https://www.investopedia.com/articles/trading/07/adx.shtml', note: 'Trade only with SPY EMA trend / ADX-style regime (Investopedia ADX / trend regime).' },
];

function loadSeries(iv, cap) {
  return pass.map((sym) => {
    const f = path.join(OUT, 'klines', `${sym}_${iv}.json`);
    if (!fs.existsSync(f)) return null;
    let bars = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (bars.length > cap) bars = bars.slice(-cap);
    return bars.length >= 230 ? { symbol: sym, bars } : null;
  }).filter(Boolean);
}

function loadSpy() {
  const f = path.join(OUT, 'klines', 'SPYUSDT_30m.json');
  let bars = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (bars.length > 1200) bars = bars.slice(-1200);
  return bars;
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
    lowN: !!res.lowSample || res.trades < 20,
  };
}

function stops(bars, i, dir) {
  return ps.stopsFromBar(bars, i, dir, 1.5);
}

function spyDirAt(spyBars, t) {
  // last spy bar with t <= t
  let i = spyBars.length - 1;
  while (i > 50 && spyBars[i].t > t) i--;
  if (i < 50) return 'FLAT';
  const window = spyBars.slice(Math.max(0, i + 1 - 60), i + 1);
  const closes = window.map((b) => b.c);
  const ema = globalThis.Technicals.ema(closes, 20);
  const e = ema.at(-1), p = ema.at(-5);
  if (e == null || p == null) return 'FLAT';
  if (e > p && closes.at(-1) > e) return 'LONG';
  if (e < p && closes.at(-1) < e) return 'SHORT';
  return 'FLAT';
}

function installOrb(spyBars) {
  // Opening range = first two 30m bars of US cash (14:30 + 15:00 UTC) high/low; breakout after
  globalThis.__qsSignalAt = function (bars, i) {
    if (i < 220) return null;
    if (!ps.usCashUTC(bars[i].t)) return null;
    const d0 = new Date(bars[i].t);
    const dayKey = d0.toISOString().slice(0, 10);
    // find OR bars for this UTC day
    let orH = -Infinity, orL = Infinity, orDone = false;
    for (let j = Math.max(0, i - 40); j <= i; j++) {
      const dj = new Date(bars[j].t);
      if (dj.toISOString().slice(0, 10) !== dayKey) continue;
      const m = dj.getUTCHours() * 60 + dj.getUTCMinutes();
      if (m >= 14 * 60 + 30 && m < 15 * 60 + 30) {
        orH = Math.max(orH, bars[j].h);
        orL = Math.min(orL, bars[j].l);
        orDone = true;
      }
    }
    if (!orDone || !(orH > orL)) return null;
    const m = d0.getUTCHours() * 60 + d0.getUTCMinutes();
    if (m < 15 * 60 + 30) return null; // only after OR complete
    let dir = null;
    if (bars[i].c > orH) dir = 'LONG';
    else if (bars[i].c < orL) dir = 'SHORT';
    if (!dir) return null;
    // optional SPY regime soft agree
    const sd = spyDirAt(spyBars, bars[i].t);
    if (sd !== 'FLAT' && sd !== dir) return null;
    const s = stops(bars, i, dir);
    return { dir, direction: dir, ...s, score: 6, source: 'orb' };
  };
}

function installVwap() {
  globalThis.__qsSignalAt = function (bars, i) {
    if (i < 220) return null;
    if (!ps.usCashUTC(bars[i].t)) return null;
    try {
      const window = bars.slice(Math.max(0, i + 1 - 260), i + 1);
      const a = globalThis.Technicals.analyze(window, window.at(-1).T + 1, { minStopPct: 1.5 });
      const last = window.at(-1), prev = window.at(-2);
      if (!prev || !(a.vwap > 0)) return null;
      let dir = null;
      // reclaim: was below VWAP, closes above with vol
      if (prev.c < a.vwap && last.c > a.vwap && a.volumeRatio >= 1) dir = 'LONG';
      if (prev.c > a.vwap && last.c < a.vwap && a.volumeRatio >= 1) dir = 'SHORT';
      if (!dir) return null;
      const s = stops(bars, i, dir);
      return { dir, direction: dir, ...s, score: 6, source: 'vwap' };
    } catch { return null; }
  };
}

function installRsSpy(spyBars) {
  globalThis.__qsSignalAt = function (bars, i) {
    if (i < 220) return null;
    if (!ps.usCashUTC(bars[i].t)) return null;
    // 20-bar relative return vs SPY
    const look = 20;
    if (i < look) return null;
    const rSym = bars[i].c / bars[i - look].c - 1;
    let si = spyBars.length - 1;
    while (si > look && spyBars[si].t > bars[i].t) si--;
    if (si < look) return null;
    const rSpy = spyBars[si].c / spyBars[si - look].c - 1;
    const rs = rSym - rSpy;
    let dir = null;
    if (rs > 0.01 && bars[i].c > bars[i - 1].c) dir = 'LONG';
    if (rs < -0.01 && bars[i].c < bars[i - 1].c) dir = 'SHORT';
    if (!dir) return null;
    const s = stops(bars, i, dir);
    return { dir, direction: dir, ...s, score: 6, source: 'rs_spy' };
  };
}

function installBos() {
  globalThis.__qsSignalAt = function (bars, i) {
    if (i < 220) return null;
    if (!ps.usCashUTC(bars[i].t)) return null;
    // swing high/low over 10 bars; break of prior swing
    const n = 10;
    if (i < n * 2) return null;
    let sh = -Infinity, sl = Infinity;
    for (let j = i - n * 2; j < i - n; j++) {
      sh = Math.max(sh, bars[j].h);
      sl = Math.min(sl, bars[j].l);
    }
    let dir = null;
    if (bars[i].c > sh) dir = 'LONG';
    else if (bars[i].c < sl) dir = 'SHORT';
    if (!dir) return null;
    const s = stops(bars, i, dir);
    return { dir, direction: dir, ...s, score: 6, source: 'bos' };
  };
}

function installLiqMr() {
  globalThis.__qsSignalAt = function (bars, i) {
    if (i < 220) return null;
    if (!ps.usCashUTC(bars[i].t)) return null;
    try {
      const window = bars.slice(Math.max(0, i + 1 - 260), i + 1);
      const liq = globalThis.LiquiditySignals.detect(window, {});
      const grabs = (liq.signals || []).filter((s) => s.kind === 'liquidity_grab');
      if (!grabs.length) return null;
      // fade the grab: if grab was SHORT (sell-side run then reclaim) → LONG, etc.
      // Liquidity grab side is the reclaim direction typically
      const g = grabs[grabs.length - 1];
      const dir = g.side === 'LONG' || g.side === 'SHORT' ? g.side : null;
      if (!dir) return null;
      const s = stops(bars, i, dir);
      return { dir, direction: dir, ...s, score: 6, source: 'liq_mr' };
    } catch { return null; }
  };
}

function installComboPlusSpyRegime(spyBars) {
  globalThis.__qsSignalAt = function (bars, i) {
    const sig = ps.signalComboAnd3(bars, i, globalThis.Technicals, globalThis.LiquiditySignals, {
      windowBars: 3, usCashOnly: true, interval: '30m',
    });
    if (!sig) return null;
    const sd = spyDirAt(spyBars, bars[i].t);
    if (sd !== 'FLAT' && sd !== sig.dir) return null;
    return { dir: sig.dir, direction: sig.dir, entry: sig.entry, stop: sig.stop, tp: sig.tp, score: sig.score, source: 'combo_spy_regime' };
  };
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

function evalInstall(name, series, installFn) {
  const { train, test } = study.splitTrainTest(series, study.TRAIN_FRAC);
  const since60 = Date.now() - 60 * DAY;
  installFn();
  const tr = pack(study.runPortfolio(train, '30m', { id: name, mode: 'custom' }));
  installFn();
  const te = pack(study.runPortfolio(test, '30m', { id: name, mode: 'custom' }));
  installFn();
  const s60 = pack(study.runPortfolio(series, '30m', { id: name, mode: 'custom' }, { startMs: since60 }));
  delete globalThis.__qsSignalAt;
  const wf = walkForward(series, installFn, 3);
  const mean = (a, k) => a.reduce((s, x) => s + x[k], 0) / a.length;
  return {
    id: name,
    train: tr, oos: te, sixty: s60,
    wfMeanWR: +mean(wf, 'winRate').toFixed(1),
    wfMeanPF: +mean(wf, 'profitFactor').toFixed(2),
    wfMeanDD: +mean(wf, 'maxDdPct').toFixed(2),
    walkForward: wf,
  };
}

function main() {
  console.log('External signals OOS… universe', pass.length);
  const series = loadSeries('30m', 1200);
  const spyBars = loadSpy();
  console.log('30m', series.length, 'spy', spyBars.length);

  const candidates = [
    { id: 'orb_spy_agree', source: 'ORB', install: () => installOrb(spyBars) },
    { id: 'vwap_reclaim', source: 'VWAP', install: () => installVwap() },
    { id: 'rs_vs_spy', source: 'RS_SPY', install: () => installRsSpy(spyBars) },
    { id: 'bos_swing10', source: 'BOS', install: () => installBos() },
    { id: 'liq_grab_mr', source: 'LIQ_MR', install: () => installLiqMr() },
    { id: 'combo_plus_spy_regime', source: 'SPY_REGIME', install: () => installComboPlusSpyRegime(spyBars) },
    // baseline adopted combo for comparison
    { id: 'combo_and3_baseline', source: 'INTERNAL', install: () => {
      globalThis.__qsSignalAt = function (bars, i) {
        const sig = ps.signalComboAnd3(bars, i, globalThis.Technicals, globalThis.LiquiditySignals, {
          windowBars: 3, usCashOnly: true, interval: '30m',
        });
        if (!sig) return null;
        return { dir: sig.dir, direction: sig.dir, entry: sig.entry, stop: sig.stop, tp: sig.tp, score: sig.score, source: 'combo_and3' };
      };
    } },
  ];

  const results = [];
  for (const c of candidates) {
    console.log('\n===', c.id);
    const t0 = Date.now();
    const r = evalInstall(c.id, series, c.install);
    r.source = c.source;
    r.ms = Date.now() - t0;
    results.push(r);
    console.log('OOS', r.oos.trades, r.oos.winRate, r.oos.profitFactor, r.oos.netPct, 'WF', r.wfMeanWR, r.wfMeanPF, '60d', r.sixty.winRate, r.sixty.netPct, r.ms + 'ms');
  }

  const baseline = results.find((r) => r.id === 'combo_and3_baseline');
  const robust = results.filter((r) => {
    if (r.id === baseline.id) return false;
    if (r.oos.trades < 15) return false;
    if (r.oos.winRate < baseline.oos.winRate) return false;
    if (r.oos.profitFactor < baseline.oos.profitFactor) return false;
    if (r.wfMeanWR + 0.5 < baseline.wfMeanWR) return false;
    if (r.wfMeanPF < baseline.wfMeanPF * 0.95) return false;
    if (r.oos.maxDdPct > baseline.oos.maxDdPct * 1.15 + 0.5) return false;
    if (r.sixty.maxDdPct > baseline.sixty.maxDdPct * 1.15 + 1) return false;
    return true;
  }).sort((a, b) => b.oos.winRate - a.oos.winRate || b.oos.profitFactor - a.oos.profitFactor);

  const report = {
    generatedAt: new Date().toISOString(),
    sources: SOURCES,
    universe: pass.length,
    baselineId: baseline.id,
    baseline: { oos: baseline.oos, sixty: baseline.sixty, wfMeanWR: baseline.wfMeanWR, wfMeanPF: baseline.wfMeanPF },
    results: results.map(({ id, source, oos, sixty, wfMeanWR, wfMeanPF, wfMeanDD, train, ms }) => ({ id, source, oos, sixty, wfMeanWR, wfMeanPF, wfMeanDD, train, ms })),
    robustWinners: robust.map((r) => r.id),
    adoptExternal: robust[0] ? { id: robust[0].id, source: robust[0].source, oos: robust[0].oos, sixty: robust[0].sixty, wfMeanWR: robust[0].wfMeanWR, wfMeanPF: robust[0].wfMeanPF } : null,
    verdict: robust[0]
      ? `External ${robust[0].id} robustly beats combo baseline on OOS+WF WR/PF with DD/N gates.`
      : 'No external approach robustly beat combo_and3 baseline; keep combo.',
  };
  fs.writeFileSync(path.join(OUT, 'external-signals-oos.json'), JSON.stringify(report, null, 2));
  console.log('\n', report.verdict);
  console.log('Wrote scripts/out/external-signals-oos.json');
}
main();
