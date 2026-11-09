'use strict';
/**
 * 8-signal × timeframe grid on 62 liquid US equity TradFi perps.
 * Signals (exactly 8):
 *  1) ind_trend     — SMA200/EMA20/EMA50/SMA50 stack (bull or bear)
 *  2) ind_momentum  — MACD histogram sign + RSI in directional band
 *  3) ind_pressure  — ADX≥20 with +DI/−DI dominance + EMA20 slope
 *  4) ind_flow      — volume≥1× avg + close vs VWAP + OBV slope
 *  5) liq_grab      — liquidity_grab kind
 *  6) liq_sweep     — liquidity_sweep kind
 *  7) liq_buy_side  — buy_side_liquidity_taken (typically SHORT)
 *  8) liq_sell_side — sell_side_liquidity_taken (typically LONG)
 * Each runs STANDALONE (that signal alone must fire for an entry).
 */
const fs = require('fs');
const path = require('path');
const study = require('./binance-stock-perp-study');
require('../public/indicators.js');
require('../public/strategy-liquidity-signals.js');

const OUT = path.join(__dirname, 'out');
const pass = require('./out/liq-pass-full.json').pass;
const TFS = ['5m', '10m', '15m', '30m', '1h', '4h', '1d'];
const SIGNAL_DEFS = [
  { id: 'ind_trend', label: 'Trend stack (SMA200 + EMA20/50 + SMA50)', family: 'indicator' },
  { id: 'ind_momentum', label: 'MACD hist + RSI band', family: 'indicator' },
  { id: 'ind_pressure', label: 'ADX≥20 DI dominance + EMA20 slope', family: 'indicator' },
  { id: 'ind_flow', label: 'Volume≥1× + VWAP side + OBV slope', family: 'indicator' },
  { id: 'liq_grab', label: 'Liquidity grab (wick through + close back)', family: 'liquidity', kind: 'liquidity_grab' },
  { id: 'liq_sweep', label: 'Liquidity sweep (break + reclaim)', family: 'liquidity', kind: 'liquidity_sweep' },
  { id: 'liq_buy_side', label: 'Buy-side liquidity taken', family: 'liquidity', kind: 'buy_side_liquidity_taken' },
  { id: 'liq_sell_side', label: 'Sell-side liquidity taken', family: 'liquidity', kind: 'sell_side_liquidity_taken' },
];

function usCashSession(entryTs) {
  // US cash ≈14:30–21:00 UTC (ET 9:30–16:00 ignoring DST edge)
  const d = new Date(entryTs);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= (14 * 60 + 30) && mins < (21 * 60);
}

function loadRaw(iv) {
  const cap = ({ '5m': 2000, '15m': 1600, '30m': 1200, '1h': 1000, '4h': 700, '1d': 400 })[iv] || 1200;
  return pass.map((sym) => {
    const f = path.join(OUT, 'klines', `${sym}_${iv === '10m' ? '5m' : iv}.json`);
    if (!fs.existsSync(f)) return null;
    let bars = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (iv === '10m') bars = study.agg10m ? null : agg10m(bars);
    if (iv !== '10m' && bars.length > cap) bars = bars.slice(-cap);
    if (iv === '10m' && bars.length > 1200) bars = bars.slice(-1200);
    return bars.length >= 230 ? { symbol: sym, bars } : null;
  }).filter(Boolean);
}

function agg10m(bars5) {
  const out = [];
  for (let i = 0; i + 1 < bars5.length; i++) {
    const a = bars5[i], b = bars5[i + 1];
    if (Math.floor(a.t / 600e3) !== Math.floor(b.t / 600e3)) continue;
    if (a.t % 600e3 !== 0) continue;
    out.push({ t: a.t, T: b.T, o: a.o, h: Math.max(a.h, b.h), l: Math.min(a.l, b.l), c: b.c, v: a.v + b.v });
    i++;
  }
  return out;
}

// expose agg if study has it
if (typeof study.agg10m === 'function') {
  // use study version via re-load
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

function dirFromSignal(bars, i, sig) {
  if (i < 220) return null;
  const window = bars.slice(Math.max(0, i + 1 - 260), i + 1);
  if (sig.family === 'liquidity') {
    try {
      const liq = globalThis.LiquiditySignals.detect(window, {});
      const sigs = (liq.signals || []).filter((s) => s.kind === sig.kind);
      const L = sigs.filter((s) => s.side === 'LONG').length;
      const S = sigs.filter((s) => s.side === 'SHORT').length;
      if (L > S) return 'LONG';
      if (S > L) return 'SHORT';
    } catch {}
    return null;
  }
  // indicator families — use Technicals internals via analyze checks + components
  try {
    const a = globalThis.Technicals.analyze(window, window[window.length - 1].T + 1, { minStopPct: 1.5 });
    const last = window[window.length - 1];
    const bull = last.c > a.sma200 && a.ema20 > a.ema50 && last.c > a.sma50;
    const bear = last.c < a.sma200 && a.ema20 < a.ema50 && last.c < a.sma50;
    const longMom = a.histogram > 0 && a.rsi >= 45 && a.rsi <= 70;
    const shortMom = a.histogram < 0 && a.rsi >= 30 && a.rsi <= 55;
    const longPress = a.adx >= 20 && a.plusDi > a.minusDi && a.ema20 > (window.at(-5)?.c ? a.ema20 : a.ema20); // slope via checks
    // Better: use checks array positions from analyze
    // longChecks=[bull,hist>0,RSI,vol,emaSlope,ADX,vwap,obv]
    const checks = a.checks || [];
    // Recompute slope explicitly
    const closes = window.map((b) => b.c);
    // ema20 already end; compare to value 4 bars ago approx via price vs ema
    const emaSlopeUp = a.ema20 != null && window.length > 5 && a.ema20 > window[window.length - 5].c * 0.999; // weak
    // Use analyze direction components more cleanly:
    if (sig.id === 'ind_trend') {
      if (bull) return 'LONG';
      if (bear) return 'SHORT';
      return null;
    }
    if (sig.id === 'ind_momentum') {
      if (longMom) return 'LONG';
      if (shortMom) return 'SHORT';
      return null;
    }
    if (sig.id === 'ind_pressure') {
      const slopeUp = checks[4] === true && (a.direction === 'LONG' || bull || a.histogram > 0);
      // checks depend on which side was scored — recompute both
      const longOk = a.adx >= 20 && a.plusDi > a.minusDi;
      const shortOk = a.adx >= 20 && a.minusDi > a.plusDi;
      // EMA slope from longChecks definition: e20[now] > e20[now-4] — approximate with price momentum
      const e20now = a.ema20;
      // rebuild quick ema slope using Technicals.ema if available
      const e20s = globalThis.Technicals.ema(closes, 20);
      const eNow = e20s.at(-1), ePrev = e20s.at(-5);
      if (longOk && eNow != null && ePrev != null && eNow > ePrev) return 'LONG';
      if (shortOk && eNow != null && ePrev != null && eNow < ePrev) return 'SHORT';
      return null;
    }
    if (sig.id === 'ind_flow') {
      if (a.volumeRatio >= 1 && last.c > a.vwap && a.obvSlope > 0) return 'LONG';
      if (a.volumeRatio >= 1 && last.c < a.vwap && a.obvSlope < 0) return 'SHORT';
      return null;
    }
  } catch {}
  return null;
}

function install(sig, opts = {}) {
  globalThis.__qsSignalAt = function (bars, i) {
    const dir = dirFromSignal(bars, i, sig);
    if (!dir) return null;
    if (opts.usCashOnly && !usCashSession(bars[i].t)) return null;
    const entry = bars[i].c;
    const a = atr(bars, i, 14) || Math.abs(bars[i].h - bars[i].l) || entry * 0.015;
    const dist = Math.max(entry * 0.015, 1.5 * a);
    const stop = dir === 'LONG' ? entry - dist : entry + dist;
    const tp = dir === 'LONG' ? entry + 2 * dist : entry - 2 * dist;
    return { direction: dir, score: 6, entry, stop, tp, source: sig.id, i, t: bars[i].t };
  };
}

function pack(sum) {
  return {
    trades: sum.trades || 0,
    winRate: sum.winRate || 0,
    profitFactor: sum.profitFactor || 0,
    totalPnlPct: sum.totalPnlPct || 0,
    maxDdPct: sum.maxDdPct || 0,
    endEquity: sum.endEquity,
    lowSample: !!sum.lowSample || (sum.trades || 0) < 8,
  };
}

function scoreRow(oos) {
  if (!oos || oos.trades < 5) return -1e9;
  return (oos.totalPnlPct || 0) * Math.sqrt(Math.min(oos.trades, 80))
    * ((oos.winRate || 0) >= 0.45 ? 1.1 : 0.75)
    + Math.min(oos.profitFactor || 0, 6) * 8
    - (oos.maxDdPct || 0) * 0.5;
}

function main() {
  const FILTERS = [
    { id: 'all_hours', label: 'All hours', usCashOnly: false },
    { id: 'us_cash', label: 'US cash only (14:30–21:00 UTC)', usCashOnly: true },
  ];
  const rows = [];
  console.log('Signals:', SIGNAL_DEFS.map((s) => s.id).join(', '));
  console.log('Universe', pass.length, 'TFs', TFS.join(','), 'filters', FILTERS.map((f) => f.id).join(','));

  for (const filt of FILTERS) {
    console.log('\n######## FILTER', filt.id, '·', filt.label);
    for (const iv of TFS) {
      console.log('\n===', filt.id, iv);
      let series;
      if (iv === '10m') {
        series = pass.map((sym) => {
          const f = path.join(OUT, 'klines', `${sym}_5m.json`);
          if (!fs.existsSync(f)) return null;
          let bars5 = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (bars5.length > 4000) bars5 = bars5.slice(-4000);
          const bars = agg10m(bars5);
          return bars.length >= 230 ? { symbol: sym, bars: bars.slice(-1200) } : null;
        }).filter(Boolean);
      } else {
        series = loadRaw(iv);
      }
      console.log('symbols', series.length);
      if (series.length < 5) continue;
      const { train, test } = study.splitTrainTest(series, study.TRAIN_FRAC);

      for (const sig of SIGNAL_DEFS) {
        const t0 = Date.now();
        install(sig, { usCashOnly: filt.usCashOnly });
        study.setActiveRules(filt.usCashOnly ? { usCashOnly: true } : null);
        const te = study.runPortfolio(test, iv === '10m' ? '10m' : iv, { id: sig.id, mode: 'custom' });
        const full = study.runPortfolio(series, iv === '10m' ? '10m' : iv, { id: sig.id, mode: 'custom' });
        delete globalThis.__qsSignalAt;
        study.setActiveRules(null);
        const oos = pack(study.summarize(te));
        const all = pack(study.summarize(full));
        const row = {
          signal: sig.id, label: sig.label, family: sig.family, interval: iv,
          filter: filt.id, filterLabel: filt.label, usCashOnly: filt.usCashOnly,
          symbols: series.length,
          trades: all.trades, winRate: all.winRate, profitFactor: all.profitFactor,
          netPct: all.totalPnlPct, maxDdPct: all.maxDdPct,
          oosTrades: oos.trades, oosWinRate: oos.winRate, oosPF: oos.profitFactor,
          oosNetPct: oos.totalPnlPct, oosMaxDdPct: oos.maxDdPct,
          lowN: oos.lowSample || oos.trades < 8,
          score: scoreRow(oos),
          ms: Date.now() - t0,
        };
        rows.push(row);
        console.log(sig.id.padEnd(14), 'OOS N', row.oosTrades, 'WR', (100 * row.oosWinRate).toFixed(0) + '%',
          'PF', row.oosPF, 'net', row.oosNetPct.toFixed(1) + '%', row.lowN ? 'LOW_N' : '', `${row.ms}ms`);
      }
    }
  }

  function bests(subset) {
    const bestPerSignal = {};
    for (const sig of SIGNAL_DEFS) {
      const cand = subset.filter((r) => r.signal === sig.id && r.oosTrades >= 5).sort((a, b) => b.score - a.score);
      bestPerSignal[sig.id] = cand[0] || subset.filter((r) => r.signal === sig.id).sort((a, b) => b.score - a.score)[0] || null;
    }
    const overall = [...subset].filter((r) => r.oosTrades >= 5).sort((a, b) => b.score - a.score);
    return { bestPerSignal, bestOverall: overall.slice(0, 10) };
  }
  const allHours = rows.filter((r) => r.filter === 'all_hours');
  const usCash = rows.filter((r) => r.filter === 'us_cash');
  const byFilter = {
    all_hours: bests(allHours),
    us_cash: bests(usCash),
  };
  const overall = [...rows].filter((r) => r.oosTrades >= 5).sort((a, b) => b.score - a.score);

  const report = {
    generatedAt: new Date().toISOString(),
    universe: pass.length,
    signalDefinitions: SIGNAL_DEFS,
    filters: FILTERS,
    note: 'Standalone entries: only that signal’s direction. Stops = max(1.5% , 1.5×ATR) with 2R target. 10m built by aggregating 5m. LOW N if OOS trades < 8. Ran with and without US-cash session filter (14:30–21:00 UTC).',
    rows,
    bestPerSignal: byFilter.all_hours.bestPerSignal,
    bestOverall: byFilter.all_hours.bestOverall,
    byFilter,
    bestOverallCombined: overall.slice(0, 10),
  };
  fs.writeFileSync(path.join(OUT, 'signal-tf-grid.json'), JSON.stringify(report, null, 2));

  const csv = ['filter,signal,interval,trades,winRate,PF,netPct,maxDdPct,oosTrades,oosWR,oosPF,oosNetPct,oosMaxDd,lowN,score'];
  for (const r of rows) {
    csv.push([
      r.filter, r.signal, r.interval, r.trades, r.winRate.toFixed(3), r.profitFactor, r.netPct.toFixed(3), r.maxDdPct.toFixed(3),
      r.oosTrades, r.oosWinRate.toFixed(3), r.oosPF, r.oosNetPct.toFixed(3), r.oosMaxDdPct.toFixed(3), r.lowN ? 1 : 0, r.score.toFixed(2),
    ].join(','));
  }
  const csvPath = '/workspace/binance-signal-tf-grid.csv';
  fs.writeFileSync(csvPath, csv.join('\n') + '\n');
  fs.copyFileSync(csvPath, path.join(OUT, 'signal-tf-grid.csv'));
  report.csvPath = csvPath;
  fs.writeFileSync(path.join(OUT, 'signal-tf-grid.json'), JSON.stringify(report, null, 2));

  for (const fid of ['all_hours', 'us_cash']) {
    const b = byFilter[fid];
    console.log('\nBEST PER SIGNAL [' + fid + ']');
    for (const sig of SIGNAL_DEFS) {
      const x = b.bestPerSignal[sig.id];
      if (!x) { console.log(sig.id, 'none'); continue; }
      console.log(sig.id, '→', x.interval, 'OOS N', x.oosTrades, 'WR', (100 * x.oosWinRate).toFixed(0) + '%', 'PF', x.oosPF, 'net', x.oosNetPct.toFixed(2) + '%', x.lowN ? 'LOW_N' : '');
    }
    console.log('\nBEST OVERALL [' + fid + ']');
    b.bestOverall.slice(0, 5).forEach((r, i) => console.log(i + 1, r.signal, r.interval, 'OOS', r.oosTrades, r.oosNetPct.toFixed(2) + '%', 'PF', r.oosPF));
  }
  console.log('\nBEST OVERALL COMBINED');
  overall.slice(0, 5).forEach((r, i) => console.log(i + 1, r.filter, r.signal, r.interval, 'OOS', r.oosTrades, r.oosNetPct.toFixed(2) + '%', 'PF', r.oosPF));
}

main();
