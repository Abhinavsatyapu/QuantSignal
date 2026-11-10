'use strict';
/**
 * Shared dry-run study preset signal helpers.
 * Keep pure (no I/O) so unit tests and the scanner share one definition.
 */

function usCashUTC(ts) {
  const d = new Date(ts);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= (14 * 60 + 30) && mins < (21 * 60);
}

function isFridayUTC(ts) {
  return new Date(ts).getUTCDay() === 5;
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

function stopsFromBar(bars, i, dir, atrMult = 1.5) {
  const entry = bars[i].c;
  const a = atr(bars, i, 14) || Math.abs(bars[i].h - bars[i].l) || entry * 0.015;
  const dist = Math.max(entry * 0.015, atrMult * a);
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

function inWin(arr, i, dir, N) {
  for (let b = 0; b <= N; b++) {
    const j = i - b;
    if (j < 0) break;
    if (arr[j] === dir) return true;
  }
  return false;
}

/** Aggregate 5m bars into 10m (even wall-clock pairs). */
function agg10m(bars5) {
  const out = [];
  for (let i = 0; i + 1 < bars5.length; i++) {
    const a = bars5[i], b = bars5[i + 1];
    if (Math.floor(a.t / 600e3) !== Math.floor(b.t / 600e3)) continue;
    if (a.t % 600e3 !== 0) continue;
    out.push({ t: a.t, T: b.T, o: a.o, h: Math.max(a.h, b.h), l: Math.min(a.l, b.l), c: b.c, v: (a.v || 0) + (b.v || 0) });
    i++;
  }
  return out;
}

/**
 * Evaluate combo_30m_trend_flow_buyside_and3 at bar i.
 * bars: [{t,T,o,h,l,c,v}, ...] newest last; need >= 221 bars.
 * opts: { windowBars=3, usCashOnly=true, noFridayEntry=false, requireHtf=false, htfDir=null,
 *         maxStopAtr=null, minAtrPct=null, maxAtrPct=null, maxCluster=null, clusterCount=0 }
 */
function signalComboAnd3(bars, i, Technicals, LiquiditySignals, opts = {}) {
  if (i < 220 || !bars || !bars[i]) return null;
  const windowBars = opts.windowBars != null ? opts.windowBars : 3;
  const usCashOnly = opts.usCashOnly !== false;
  const noFridayEntry = !!opts.noFridayEntry;
  if (usCashOnly && !usCashUTC(bars[i].t)) return null;
  if (noFridayEntry && isFridayUTC(bars[i].t)) return null;

  // Precompute family dirs for i-windowBars..i (small window only)
  const trend = [], flow = [], buy = [];
  const start = Math.max(220, i - windowBars);
  for (let j = start; j <= i; j++) {
    try {
      const window = bars.slice(Math.max(0, j + 1 - 260), j + 1);
      const a = Technicals.analyze(window, window[window.length - 1].T + 1, { minStopPct: 1.5 });
      const liq = LiquiditySignals.detect(window, {});
      const last = window[window.length - 1];
      trend[j - start] = dirTrend(a, last);
      flow[j - start] = dirFlow(a, last);
      buy[j - start] = dirBuySide(liq);
    } catch {
      trend[j - start] = null; flow[j - start] = null; buy[j - start] = null;
    }
  }
  // Map local arrays to absolute via offset
  const get = (arr, abs) => arr[abs - start];
  let dir = null;
  for (const D of ['LONG', 'SHORT']) {
    let tOk = false, fOk = false, bOk = false;
    for (let j = start; j <= i; j++) {
      if (get(trend, j) === D) tOk = true;
      if (get(flow, j) === D) fOk = true;
      if (get(buy, j) === D) bOk = true;
    }
    if (tOk && fOk && bOk) { dir = D; break; }
  }
  if (!dir) return null;

  if (opts.requireHtf && opts.htfDir && opts.htfDir !== 'FLAT' && opts.htfDir !== dir) return null;
  if (opts.maxCluster != null && (opts.clusterCount || 0) >= opts.maxCluster) return null;

  const a14 = atr(bars, i, 14);
  const entry = bars[i].c;
  if (a14 > 0 && entry > 0) {
    const atrPct = (a14 / entry) * 100;
    if (opts.minAtrPct != null && atrPct < opts.minAtrPct) return null;
    if (opts.maxAtrPct != null && atrPct > opts.maxAtrPct) return null;
  }

  const s = stopsFromBar(bars, i, dir, opts.atrStopMult != null ? opts.atrStopMult : 1.5);
  if (opts.maxStopAtr != null && a14 > 0) {
    if (Math.abs(s.entry - s.stop) / a14 > opts.maxStopAtr) return null;
  }
  const conditions = {
    trend: true, flow: true, buySide: true,
    trendDir: get(trend, i), flowDir: get(flow, i), buyDir: get(buy, i),
    windowBars,
  };
  return {
    dir, direction: dir, score: 7, entry: s.entry, stop: s.stop, tp: s.tp,
    source: 'combo_and3', interval: opts.interval || '30m', t: bars[i].t, i,
    conditions,
  };
}

/** Last-bar trend / flow / buy-side dirs for the live board (does not change combo entry rules). */
function comboConditionSnapshot(bars, i, Technicals, LiquiditySignals, opts = {}) {
  if (i < 50 || !bars || !bars[i]) return { trend: false, flow: false, buySide: false, trendDir: null, flowDir: null, buyDir: null };
  try {
    const window = bars.slice(Math.max(0, i + 1 - 260), i + 1);
    const a = Technicals.analyze(window, window[window.length - 1].T + 1, { minStopPct: 1.5 });
    const liq = LiquiditySignals.detect(window, {});
    const last = window[window.length - 1];
    const trendDir = dirTrend(a, last);
    const flowDir = dirFlow(a, last);
    const buyDir = dirBuySide(liq);
    return { trend: !!trendDir, flow: !!flowDir, buySide: !!buyDir, trendDir, flowDir, buyDir, windowBars: opts.windowBars != null ? opts.windowBars : 3 };
  } catch {
    return { trend: false, flow: false, buySide: false, trendDir: null, flowDir: null, buyDir: null };
  }
}

/** Apply entry filters used by live scanner (UTC cash / Friday). */
function applyEntryFilters(dir, filters, nowTs = Date.now()) {
  if (!dir) return null;
  const f = filters || {};
  if (f.usCashOnly && !usCashUTC(nowTs)) return null;
  if (f.noFridayEntry && isFridayUTC(nowTs)) return null;
  return dir;
}

/** Dedupe key: one signal per symbol+interval+bar close+direction+mode */
function dedupeKey(symbol, interval, closedAt, dir, mode) {
  return ['bn', symbol, interval, closedAt || 'na', dir, mode].join('|');
}

module.exports = {
  usCashUTC, isFridayUTC, atr, stopsFromBar, dirTrend, dirFlow, dirBuySide,
  inWin, agg10m, signalComboAnd3, comboConditionSnapshot, applyEntryFilters, dedupeKey,
};
