'use strict';
/**
 * Binance US-equity (TradFi) perp study — real klines only.
 * TFs: 5m, 10m (agg 5m), 15m, 30m, 1h, 4h, 1d
 * Matrix: indicators | each liq kind alone | confirm | any | indicators+all4
 * Portfolio: $800, 5x, max 4, 2% risk, 6% daily loss halt, fee/funding/slippage,
 * limit→market after 2 min. Holding / max-hold scale with TF.
 * Dedicated last-60-calendar-days section + CSV.
 */
const fs = require('fs');
const path = require('path');
const bn = require('../server/binance');
const universe = require('../server/binance-universe');
require('../public/indicators.js');
require('../public/strategy-liquidity-signals.js');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const CAPITAL = 800;
const LEVERAGE = 5;
const MAX_POS = 4;
const RISK_PCT = 2;          // % capital risked per trade via stop
const DAILY_LOSS_PCT = 6;
const FEE_RT = 0.0008;       // taker+taker approx round-trip (limit maker + market taker mixed → ~8 bps RT)
const SLIP_BPS = 12;         // market/stop slip ≈ half of 20bps max spread + impact
const FUNDING_8H = 0.0001;   // ~1 bp per 8h funding period (conservative avg)
const ENTRY_TIMEOUT_MS = 120_000;
const MIN_SCORE = 6;
const TRAIN_FRAC = 0.6;
/** Optional improvement-pass hooks (null = baseline). Mutated only by study-improve. */
let activeRules = null;
function setActiveRules(r) { activeRules = r; }
function getActiveRules() { return activeRules; }

const TFS = ['5m', '10m', '15m', '30m', '1h', '4h', '1d'];
const TF_MS = { '5m': 300e3, '10m': 600e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };

const VARIANTS = [
  { id: 'indicators', label: 'Indicators only', mode: 'indicators' },
  { id: 'liq_grab', label: 'Liquidity grab alone', mode: 'liquidity', kinds: ['liquidity_grab'] },
  { id: 'liq_sweep', label: 'Sweep alone', mode: 'liquidity', kinds: ['liquidity_sweep'] },
  { id: 'liq_buy_side', label: 'Buy-side taken alone', mode: 'liquidity', kinds: ['buy_side_liquidity_taken'] },
  { id: 'liq_sell_side', label: 'Sell-side taken alone', mode: 'liquidity', kinds: ['sell_side_liquidity_taken'] },
  { id: 'confirm_grab', label: 'Indicators + grab confirm', mode: 'confirm', kinds: ['liquidity_grab'] },
  { id: 'confirm_sweep', label: 'Indicators + sweep confirm', mode: 'confirm', kinds: ['liquidity_sweep'] },
  { id: 'confirm_all', label: 'Indicators + any liq confirm', mode: 'confirm', kinds: null },
  { id: 'any', label: 'Indicators OR any liquidity', mode: 'any', kinds: null },
  { id: 'liq_all', label: 'All 4 liquidity signals', mode: 'liquidity', kinds: null },
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchAllKlines(client, symbol, interval, sinceMs) {
  // Paginate forward from sinceMs until near-now (or empty). Enough pages for 5m ~120d+.
  const out = [];
  let start = sinceMs || 0;
  const now = Date.now();
  const step = TF_MS[interval] || 60000;
  for (let page = 0; page < 80; page++) {
    const rows = await client.publicGet('/fapi/v1/klines', {
      symbol, interval, limit: 1500, startTime: start || undefined,
    });
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) {
      const t = +r[0], T = +r[6];
      if (out.length && out.at(-1).t === t) continue;
      out.push({ t, T, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
    }
    const lastT = +rows.at(-1)[0];
    if (rows.length < 1500) break;
    start = lastT + 1;
    if (lastT >= now - step * 2) break;
    await sleep(60);
  }
  return out;
}

function agg10m(bars5) {
  const out = [];
  for (let i = 0; i + 1 < bars5.length; i++) {
    const a = bars5[i], b = bars5[i + 1];
    // Align to even 10m boundaries
    if (Math.floor(a.t / 600e3) !== Math.floor(b.t / 600e3)) continue;
    if (a.t % 600e3 !== 0) continue;
    out.push({ t: a.t, T: b.T, o: a.o, h: Math.max(a.h, b.h), l: Math.min(a.l, b.l), c: b.c, v: a.v + b.v });
    i++; // consumed pair
  }
  return out;
}

function toISTDate(ms) {
  // Asia/Calcutta = UTC+5:30
  const d = new Date(ms + 5.5 * 3600e3);
  return d.toISOString().slice(0, 10);
}

function maxHoldBars(interval) {
  const hours = { '5m': 8, '10m': 12, '15m': 18, '30m': 36, '1h': 72, '4h': 14 * 24, '1d': 60 * 24 };
  const h = hours[interval] || 24;
  let bars = Math.max(1, Math.round((h * 3600e3) / TF_MS[interval]));
  if (activeRules && activeRules.maxHoldScale != null) bars = Math.max(1, Math.round(bars * activeRules.maxHoldScale));
  return bars;
}

function signalAt(bars, i, variant) {
  if (i < 220) return null;
  const rules = activeRules;
  // Trailing window only — full-history slice made the study O(n²) and unusable
  const window = bars.slice(Math.max(0, i + 1 - 260), i + 1);
  let ind = null;
  try { ind = globalThis.Technicals.analyze(window, window[i].T + 1, { minStopPct: 1.5 }); }
  catch { return null; }
  const liq = globalThis.LiquiditySignals.detect(window, {});
  let sigs = liq.signals || [];
  if (variant.kinds) sigs = sigs.filter((s) => variant.kinds.includes(s.kind));
  const liqDir = (() => {
    const L = sigs.filter((s) => s.side === 'LONG').length;
    const S = sigs.filter((s) => s.side === 'SHORT').length;
    if (L > S) return 'LONG'; if (S > L) return 'SHORT'; return null;
  })();

  let dir = null, source = variant.id, score = 0, stop = null, tp = null;
  if (variant.mode === 'indicators') {
    if (['LONG', 'SHORT'].includes(ind.direction) && ind.score >= MIN_SCORE) {
      dir = ind.direction; score = ind.score; stop = ind.stop; tp = ind.tp1; source = 'indicators';
    }
  } else if (variant.mode === 'liquidity') {
    if (liqDir) { dir = liqDir; score = 6 + Math.max(sigs.filter(s=>s.side===dir).length, 1); source = 'liquidity'; }
  } else if (variant.mode === 'confirm') {
    if (['LONG', 'SHORT'].includes(ind.direction) && ind.score >= MIN_SCORE && liqDir === ind.direction) {
      dir = ind.direction; score = ind.score; stop = ind.stop; tp = ind.tp1; source = 'confirm';
    }
  } else if (variant.mode === 'any') {
    if (['LONG', 'SHORT'].includes(ind.direction) && ind.score >= MIN_SCORE) {
      dir = ind.direction; score = ind.score; stop = ind.stop; tp = ind.tp1; source = 'indicators';
    } else if (liqDir) { dir = liqDir; score = 6; source = 'liquidity'; }
  }
  if (!dir) return null;
  if (rules) {
    if (rules.requireConfirm) {
      // re-gate: need indicators + matching liq
      if (!(['LONG', 'SHORT'].includes(ind.direction) && ind.score >= (rules.minScore || MIN_SCORE) && liqDir === ind.direction)) return null;
      dir = ind.direction; score = ind.score; stop = ind.stop; tp = ind.tp1; source = 'confirm';
    }
    if (rules.noLiquidityOnly && source === 'liquidity') return null;
    const minSc = rules.minScore != null ? rules.minScore : MIN_SCORE;
    if (score < minSc && source !== 'liquidity') return null;
    if (rules.minScore != null && source === 'liquidity' && score < rules.minScore) return null;
    const ist = new Date(bars[i].t + 5.5 * 3600e3);
    const hour = ist.getUTCHours();
    const dow = ist.getUTCDay();
    if (rules.usCashOnly && !(hour >= 19 || hour <= 2)) return null;
    if (rules.noFridayEntry && dow === 5) return null;
  }
  const entry = bars[i].c;
  const atrMult = (rules && rules.atrStopMult != null) ? rules.atrStopMult : 3;
  const rrMult = (rules && rules.rr != null) ? rules.rr : 2;
  if (!(stop > 0) || rules) {
    const atr = ind?.atr || (bars[i].h - bars[i].l);
    const dist = Math.max(atrMult * atr, entry * 0.015);
    stop = dir === 'LONG' ? entry - dist : entry + dist;
  }
  {
    const risk = Math.abs(entry - stop);
    tp = dir === 'LONG' ? entry + rrMult * risk : entry - rrMult * risk;
  }
  return { dir, entry, stop, tp, score, source, barT: bars[i].t, barTclose: bars[i].T };
}

function sizeQty(equity, entry, stop, markDepthCap) {
  const riskUsd = equity * (RISK_PCT / 100);
  const stopDist = Math.abs(entry - stop);
  if (!(stopDist > 0)) return 0;
  let notional = riskUsd / (stopDist / entry);
  const maxNotional = equity * LEVERAGE;
  notional = Math.min(notional, maxNotional);
  if (markDepthCap > 0) notional = Math.min(notional, markDepthCap);
  const qty = notional / entry;
  if (qty * entry < 5) return 0; // dust
  return qty;
}

/**
 * Multi-symbol portfolio backtest over a shared timeline.
 * series: { symbol, bars: [...] }[]
 */
function runPortfolio(series, interval, variant, opts = {}) {
  const startMs = opts.startMs || 0;
  const endMs = opts.endMs || Infinity;
  const maxHold = maxHoldBars(interval);
  const barMs = TF_MS[interval];

  // Build unified event list of bar closes
  const events = [];
  for (const s of series) {
    for (let i = 0; i < s.bars.length; i++) {
      const b = s.bars[i];
      if (b.t < startMs || b.t > endMs) continue;
      events.push({ symbol: s.symbol, i, t: b.t, T: b.T });
    }
  }
  events.sort((a, b) => a.t - b.t || a.symbol.localeCompare(b.symbol));

  const bySym = Object.fromEntries(series.map((s) => [s.symbol, s.bars]));
  let equity = CAPITAL;
  let dayPnl = 0, dayStartEquity = CAPITAL, dayKey = null;
  let haltCount = 0, profitHaltCount = 0; // would-have counters only
  const open = []; // {symbol,dir,qty,entry,stop,tp,entryBar,entryTs,fees}
  const trades = [];
  const daily = new Map(); // IST date -> {pnl, trades, equity, halt, targetHit23, targetHit810}

  function ensureDay(ts) {
    const k = toISTDate(ts);
    if (k !== dayKey) {
      // roll previous
      if (dayKey) {
        const d = daily.get(dayKey) || { date: dayKey, pnl: 0, trades: 0, equity, halt: false };
        d.equity = equity;
        d.pnlPct = dayStartEquity ? (d.pnl / dayStartEquity) * 100 : 0;
        d.targetHit56 = d.pnlPct >= 5 && d.pnlPct <= 6.5; // hit 5–6% band (compounding day)
        d.targetHit5plus = d.pnlPct >= 5;
        daily.set(dayKey, d);
      }
      dayKey = k;
      dayPnl = 0;
      dayStartEquity = equity; // compound: today's risk/% based on equity at IST midnight
      if (!daily.has(k)) daily.set(k, { date: k, pnl: 0, trades: 0, equity, wouldHalt6: false, wouldProfitHalt5: false, dayStartEquity });
      else daily.get(k).dayStartEquity = dayStartEquity;
    }
    return daily.get(k);
  }

  function markOpen(sym, ts) {
    const bars = bySym[sym];
    // last bar with t <= ts
    let px = null;
    for (let i = bars.length - 1; i >= 0; i--) { if (bars[i].t <= ts) { px = bars[i].c; break; } }
    return px;
  }

  function closePos(pos, exitPx, reason, ts) {
    const sign = pos.dir === 'LONG' ? 1 : -1;
    const gross = (exitPx - pos.entry) * pos.qty * sign;
    const fee = pos.qty * exitPx * (FEE_RT / 2); // exit leg
    const holdBars = Math.max(1, Math.round((ts - pos.entryTs) / barMs));
    const fundPeriods = (holdBars * barMs) / (8 * 3600e3);
    const funding = pos.qty * pos.entry * FUNDING_8H * fundPeriods; // approx cost
    const pnl = gross - fee - funding - (pos.entryFee || 0);
    equity += pnl;
    dayPnl += pnl;
    const d = ensureDay(ts);
    d.pnl += pnl;
    d.trades += 1;
    // Informational only — do NOT halt trading (user: keep trading through target/loss days)
    if (dayPnl <= -(dayStartEquity * DAILY_LOSS_PCT / 100)) {
      if (!d.wouldHalt6) { d.wouldHalt6 = true; haltCount += 1; }
    }
    if (dayStartEquity && (dayPnl / dayStartEquity) * 100 >= 5) {
      if (!d.wouldProfitHalt5) { d.wouldProfitHalt5 = true; profitHaltCount += 1; }
    }
    const holdBarsOut = Math.max(1, Math.round((ts - pos.entryTs) / barMs));
    const ist = new Date(pos.entryTs + 5.5 * 3600e3);
    trades.push({
      symbol: pos.symbol, dir: pos.dir, entry: pos.entry, exit: exitPx, qty: pos.qty,
      pnl, reason, entryTs: pos.entryTs, exitTs: ts, source: pos.source, interval,
      holdBars: holdBarsOut, entryHourIST: ist.getUTCHours(), entryDowIST: ist.getUTCDay(),
      stopDistPct: pos.entry ? (Math.abs(pos.entry - pos.stop) / pos.entry) * 100 : null,
      rr: pos.stop && pos.tp ? Math.abs(pos.tp - pos.entry) / Math.max(1e-9, Math.abs(pos.entry - pos.stop)) : null,
    });
  }

  for (const ev of events) {
    const bars = bySym[ev.symbol];
    const bar = bars[ev.i];
    ensureDay(bar.t);

    // Manage open positions for this symbol
    for (let oi = open.length - 1; oi >= 0; oi--) {
      const pos = open[oi];
      if (pos.symbol !== ev.symbol) continue;
      const held = ev.i - pos.entryBar;
      // SL / TP intrabar
      let exit = null, reason = null;
      if (pos.dir === 'LONG') {
        if (bar.l <= pos.stop) { exit = pos.stop * (1 - SLIP_BPS / 1e4); reason = 'stop'; }
        else if (bar.h >= pos.tp) { exit = pos.tp; reason = 'tp'; }
      } else {
        if (bar.h >= pos.stop) { exit = pos.stop * (1 + SLIP_BPS / 1e4); reason = 'stop'; }
        else if (bar.l <= pos.tp) { exit = pos.tp; reason = 'tp'; }
      }
      if (!exit && held >= maxHold) { exit = bar.c; reason = 'max hold'; }
      if (exit) { closePos(pos, exit, reason, bar.t); open.splice(oi, 1); }
    }

    if (open.length >= MAX_POS) continue;
    if (open.some((p) => p.symbol === ev.symbol)) continue;

    const sig = signalAt(bars, ev.i, variant);
    if (!sig) continue;

    // Limit-then-market after 2 min: next bar
    if (ev.i + 1 >= bars.length) continue;
    const next = bars[ev.i + 1];
    let fillPx = null, entryType = 'limit';
    const limitPx = sig.entry;
    if (sig.dir === 'LONG') {
      if (next.l <= limitPx) fillPx = limitPx;
      else { fillPx = next.o * (1 + SLIP_BPS / 1e4); entryType = 'market_fallback'; }
    } else {
      if (next.h >= limitPx) fillPx = limitPx;
      else { fillPx = next.o * (1 - SLIP_BPS / 1e4); entryType = 'market_fallback'; }
    }
    // Recompute stop/tp relative to fill
    const risk = Math.abs(sig.entry - sig.stop);
    const stop = sig.dir === 'LONG' ? fillPx - risk : fillPx + risk;
    const tp = sig.dir === 'LONG' ? fillPx + 2 * risk : fillPx - 2 * risk;
    const qty = sizeQty(equity, fillPx, stop, 0);
    if (!(qty > 0)) continue;
    const entryFee = qty * fillPx * (entryType === 'limit' ? FEE_RT / 4 : FEE_RT / 2);
    open.push({
      symbol: ev.symbol, dir: sig.dir, qty, entry: fillPx, stop, tp,
      entryBar: ev.i + 1, entryTs: next.t, entryFee, source: sig.source, entryType,
    });
  }

  // Flatten remaining at last mark
  let lastT = 0;
  for (const s of series) { const t = s.bars.at(-1)?.t || 0; if (t > lastT) lastT = t; }
  for (const pos of open.splice(0)) {
    const px = markOpen(pos.symbol, lastT) || pos.entry;
    closePos(pos, px, 'eod_flatten', lastT);
  }
  ensureDay(lastT + 1); // flush

  const days = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
  // equity curve + drawdown
  let peak = CAPITAL, maxDd = 0, maxDdPct = 0, peakDate = days[0]?.date, troughDate = days[0]?.date, recoveryDate = null;
  let peakAt = days[0]?.date, troughAt = null, recovered = false;
  let eq = CAPITAL;
  const curve = [];
  for (const d of days) {
    eq = d.equity;
    curve.push({ date: d.date, equity: eq, pnl: d.pnl });
    if (eq >= peak) {
      peak = eq; peakAt = d.date;
      if (troughAt && !recovered) { recoveryDate = d.date; recovered = true; }
    } else {
      const dd = peak - eq, ddPct = (dd / peak) * 100;
      if (dd > maxDd) {
        maxDd = dd; maxDdPct = ddPct; peakDate = peakAt; troughDate = d.date; troughAt = d.date; recovered = false; recoveryDate = null;
      }
    }
  }
  if (troughAt && !recovered) {
    // still in drawdown
    recoveryDate = null;
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const dayWins = days.filter((d) => d.pnl > 0).length;
  const dayLoss = days.filter((d) => d.pnl < 0).length;
  const bestDay = days.reduce((a, b) => (a == null || b.pnl > a.pnl ? b : a), null);
  const worstDay = days.reduce((a, b) => (a == null || b.pnl < a.pnl ? b : a), null);
  const dayPct = (d) => {
    const base = d.dayStartEquity || CAPITAL;
    return base ? (d.pnl / base) * 100 : 0;
  };
  const hit56 = days.filter((d) => { const p = dayPct(d); return p >= 5 && p <= 6.5; }).length;
  const hit5plus = days.filter((d) => dayPct(d) >= 5).length;
  const haltDays = days.filter((d) => d.wouldHalt6).length; // reference: days a 6% loss halt WOULD have fired
  const profitHaltDays = days.filter((d) => d.wouldProfitHalt5).length; // reference only
  // Theoretical 5%/day compounded curve vs actual
  const nDays = Math.max(1, days.length);
  const theoretical5 = CAPITAL * Math.pow(1.05, nDays);
  const theoretical5pct = ((theoretical5 - CAPITAL) / CAPITAL) * 100;
  const realisticVsTheo = theoretical5 > CAPITAL ? (equity - CAPITAL) / (theoretical5 - CAPITAL) : 0;

  const totalPnl = equity - CAPITAL;
  const lowSample = trades.length < 30 || (interval === '1d' && trades.length < 15) || days.length < 20;

  return {
    interval, variant: variant.id, label: variant.label,
    trades: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    totalPnl, totalPnlPct: (totalPnl / CAPITAL) * 100,
    endEquity: equity,
    profitFactor: losses.reduce((s, t) => s + Math.abs(t.pnl), 0)
      ? wins.reduce((s, t) => s + t.pnl, 0) / losses.reduce((s, t) => s + Math.abs(t.pnl), 0) : (wins.length ? Infinity : 0),
    maxDd, maxDdPct, peakDate, troughDate, recoveryDate,
    dayWins, dayLoss, bestDay, worstDay, hit56, hit5plus, haltDays, haltCount, profitHaltDays, profitHaltCount,
    theoretical5, theoretical5pct, realisticVsTheo,
    days, curve, tradeList: trades, lowSample, maxHoldBars: maxHold,
    avgHoldBars: trades.length ? trades.reduce((s, t) => s + Math.max(1, Math.round((t.exitTs - t.entryTs) / barMs)), 0) / trades.length : 0,
    dailyReturns: dailyReturnStats(days, CAPITAL),
  };
}


/** Daily return stats from day rows (pnlPct or pnl/dayStartEquity). */
function dailyReturnStats(days, startEquity) {
  const rows = days || [];
  const allPct = rows.map((d) => {
    if (d.pnlPct != null) return d.pnlPct;
    const base = d.dayStartEquity || startEquity || CAPITAL;
    return base ? (d.pnl / base) * 100 : 0;
  });
  const tradePct = rows.filter((d) => (d.trades || 0) > 0).map((d) => {
    if (d.pnlPct != null) return d.pnlPct;
    const base = d.dayStartEquity || startEquity || CAPITAL;
    return base ? (d.pnl / base) * 100 : 0;
  });
  const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const median = (arr) => {
    if (!arr.length) return 0;
    const a = [...arr].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const endEq = rows.length ? rows[rows.length - 1].equity : (startEquity || CAPITAL);
  const startEq = startEquity || CAPITAL;
  const n = Math.max(1, allPct.length);
  const geoDaily = startEq > 0 && endEq > 0 ? (Math.pow(endEq / startEq, 1 / n) - 1) * 100 : 0;
  return {
    meanDailyPctAllDays: +mean(allPct).toFixed(4),
    medianDailyPctAllDays: +median(allPct).toFixed(4),
    geoAvgDailyPct: +geoDaily.toFixed(4),
    meanDailyPctTradeDays: +mean(tradePct).toFixed(4),
    medianDailyPctTradeDays: +median(tradePct).toFixed(4),
    tradeDays: tradePct.length,
    calendarDays: allPct.length,
  };
}

function splitTrainTest(series, frac) {
  let minT = Infinity, maxT = -Infinity;
  for (const s of series) for (const b of s.bars) { if (b.t < minT) minT = b.t; if (b.t > maxT) maxT = b.t; }
  if (!(maxT > minT)) return { train: series, test: series.map((s) => ({ ...s, bars: [] })), cut: minT };
  const cut = minT + (maxT - minT) * frac;
  return {
    train: series.map((s) => ({ ...s, bars: s.bars.filter((b) => b.t <= cut) })),
    test: series.map((s) => ({ ...s, bars: s.bars.filter((b) => b.t > cut) })),
    cut,
  };
}

async function main() {
  const client = bn.Client({});
  console.log('Discovering equity perps…');
  let eqs = await universe.listEquityPerps(client);
  console.log('Found', eqs.length, eqs.map((e) => e.symbol).join(', '));

  // Liquidity screen (live) — loosened defaults (20bps / $5M vol / $10k depth)
  const LIQ_OPTS = {
    minQuoteVolume24h: universe.DEFAULT_LIQ.minQuoteVolume24h,
    maxSpreadBps: universe.DEFAULT_LIQ.maxSpreadBps,
    minDepthUsd: universe.DEFAULT_LIQ.minDepthUsd,
    minOpenInterestUsd: universe.DEFAULT_LIQ.minOpenInterestUsd,
    maxNotionalPctOfDepth: universe.DEFAULT_LIQ.maxNotionalPctOfDepth,
  };
  console.log('Liquidity thresholds', LIQ_OPTS, 'SLIP_BPS', SLIP_BPS);
  const liqRows = [];
  for (const e of eqs) {
    try {
      const snap = await universe.liquiditySnapshot(client, e.symbol, LIQ_OPTS);
      console.log(e.symbol, snap.ok ? 'OK' : 'SKIP', 'vol', Math.round(snap.quoteVolume / 1e6) + 'M',
        'spread', snap.spreadBps.toFixed(2), 'depth', Math.round(snap.depthUsd),
        snap.ok ? '' : snap.reasons.join('; '));
      liqRows.push({ ...e, liq: snap });
      await sleep(100);
    } catch (err) { console.log(e.symbol, 'liq err', err.message); }
  }
  const picked = liqRows.filter((x) => x.liq.ok).sort((a, b) => b.liq.quoteVolume - a.liq.quoteVolume);
  const skipped = liqRows.filter((x) => !x.liq.ok).map((x) => x.symbol);
  const symbols = picked.map((x) => x.symbol);
  console.log('PASS', symbols.length, symbols.join(', '));
  console.log('SKIP', skipped.length, skipped.join(', '));
  if (!symbols.length) throw new Error('No symbols passed loosened liquidity filter');

  // Fetch klines — need history for 1d (220 bars) where available; for 60d section need 60d
  const since60 = Date.now() - 60 * 86400e3;
  const sinceStudy = Date.now() - 400 * 86400e3; // enough for 1d warm-up where listed early

  const cache = {}; // `${sym}:${iv}` -> bars
  async function getBars(sym, iv) {
    const key = sym + ':' + iv;
    if (cache[key]) return cache[key];
    const disk = path.join(OUT, 'klines', `${sym}_${iv}.json`);
    if (iv === '10m') {
      const b5 = await getBars(sym, '5m');
      cache[key] = agg10m(b5);
      return cache[key];
    }
    if (fs.existsSync(disk)) {
      try {
        const bars = JSON.parse(fs.readFileSync(disk, 'utf8'));
        if (Array.isArray(bars) && bars.length > 50) {
          cache[key] = bars;
          console.log('Cache hit', sym, iv, bars.length);
          return bars;
        }
      } catch {}
    }
    console.log('Fetching', sym, iv);
    const bars = await fetchAllKlines(client, sym, iv, sinceStudy);
    cache[key] = bars;
    fs.mkdirSync(path.dirname(disk), { recursive: true });
    fs.writeFileSync(disk, JSON.stringify(bars));
    console.log(' ', sym, iv, bars.length, 'bars', bars[0] ? new Date(bars[0].t).toISOString() : '-', '→', bars.at(-1) ? new Date(bars.at(-1).t).toISOString() : '-');
    return bars;
  }

  // Prefetch native intervals
  for (const sym of symbols) {
    for (const iv of ['5m', '15m', '30m', '1h', '4h', '1d']) {
      try { await getBars(sym, iv); await sleep(60); }
      catch (e) { console.log('fetch fail', sym, iv, e.message); cache[sym + ':' + iv] = []; }
    }
    // 10m from 5m
    await getBars(sym, '10m');
  }

  const matrix = [];
  const flags = [];

  for (const iv of TFS) {
    // Cap ultra-high-frequency history for matrix runtime (keep warm-up + ~60-90 trading days)
    const capBars = { '5m': 12000, '10m': 8000, '15m': 6000, '30m': 4000, '1h': 2500, '4h': 900, '1d': 400 };
    const series = symbols.map((sym) => {
      let bars = cache[sym + ':' + iv] || [];
      const cap = capBars[iv] || 5000;
      if (bars.length > cap) bars = bars.slice(-cap);
      return { symbol: sym, bars };
    }).filter((s) => s.bars.length >= 230);
    if (!series.length) {
      flags.push({ interval: iv, msg: `No symbol has ≥230 ${iv} bars — skipped (stock-perp history too short)` });
      console.log('SKIP TF', iv, 'insufficient history');
      continue;
    }
    const shortSyms = symbols.filter((sym) => (cache[sym + ':' + iv] || []).length < 230);
    if (shortSyms.length) flags.push({ interval: iv, msg: `Excluded (history <230 bars): ${shortSyms.join(', ')}` });

    const { train, test, cut } = splitTrainTest(series, TRAIN_FRAC);
    for (const v of VARIANTS) {
      const tr = runPortfolio(train, iv, v);
      const te = runPortfolio(test, iv, v);
      const full = runPortfolio(series, iv, v);
      matrix.push({
        interval: iv, variant: v.id, label: v.label,
        train: summarize(tr), test: summarize(te), full: summarize(full),
        lowSample: te.lowSample || tr.trades < 15 || (iv === '1d' && te.trades < 8),
        trainTrades: tr.trades, testTrades: te.trades, fullTrades: full.trades,
        cut: new Date(cut).toISOString(),
        symbols: series.map((s) => s.symbol),
        maxHoldBars: full.maxHoldBars,
      });
      console.log(iv, v.id, 'test trades', te.trades, 'pnl%', te.totalPnlPct.toFixed(1), te.lowSample ? 'LOW_N' : '');
    }
  }

  // Rank by OOS (test) expectancy: totalPnlPct * sqrt(trades) with winRate floor, prefer more trades
  const ranked = matrix
    .filter((m) => m.test.trades >= 5)
    .map((m) => ({
      ...m,
      score: m.test.totalPnlPct * Math.sqrt(Math.min(m.test.trades, 200)) * (m.test.winRate >= 0.4 ? 1 : 0.6)
        - m.test.maxDdPct * 0.3,
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0] || matrix.sort((a, b) => b.full.totalPnlPct - a.full.totalPnlPct)[0];
  console.log('BEST', best?.interval, best?.variant, best?.test);

  // Current strategy = indicators @ configured default 15m
  const currentIv = '15m';
  const currentVar = VARIANTS.find((v) => v.id === 'indicators');
  const bestVar = VARIANTS.find((v) => v.id === (best?.variant || 'indicators'));
  const bestIv = best?.interval || '15m';

  function seriesFor(iv) {
    return symbols.map((sym) => ({ symbol: sym, bars: (cache[sym + ':' + iv] || []).filter((b) => b.t >= since60 - 250 * TF_MS[iv]) }))
      .filter((s) => s.bars.length >= 230);
  }

  const cur60series = seriesFor(currentIv);
  const best60series = seriesFor(bestIv);

  // Warm-up included in bars; restrict trade window to last 60d
  const cur60 = runPortfolio(cur60series, currentIv, currentVar, { startMs: since60 });
  const best60 = runPortfolio(best60series, bestIv, bestVar, { startMs: since60 });

  // Also run full-history 60d clip for daily table export
  function sixtyPack(res, tag) {
    return {
      tag, interval: res.interval, variant: res.variant, label: res.label,
      summary: summarize(res),
      maxDd: res.maxDd, maxDdPct: res.maxDdPct,
      peakDate: res.peakDate, troughDate: res.troughDate, recoveryDate: res.recoveryDate,
      bestDay: res.bestDay, worstDay: res.worstDay,
      dayWins: res.dayWins, dayLoss: res.dayLoss,
      hit56: res.hit56, hit5plus: res.hit5plus, haltDays: res.haltDays, profitHaltDays: res.profitHaltDays,
      theoretical5: res.theoretical5, theoretical5pct: res.theoretical5pct, realisticVsTheo: res.realisticVsTheo,
      days: res.days, curve: res.curve, lowSample: res.lowSample,
      trades: res.trades, tradeList: res.tradeList.slice(0, 500),
      endEquity: res.endEquity, totalPnl: res.totalPnl, totalPnlPct: res.totalPnlPct,
      winRate: res.winRate, profitFactor: res.profitFactor,
      dailyReturns: res.dailyReturns || dailyReturnStats(res.days || [], CAPITAL),
    };
  }

  const pack60 = {
    current: sixtyPack(cur60, 'current_indicators_15m'),
    recommended: sixtyPack(best60, `recommended_${bestIv}_${best?.variant}`),
  };
  pack60.current.monteCarlo = monteCarloRuin((cur60.tradeList || []).map((t) => t.pnl));
  pack60.recommended.monteCarlo = monteCarloRuin((best60.tradeList || []).map((t) => t.pnl));
  pack60.current.hit56PctDays = cur60.days.length ? 100 * cur60.hit56 / cur60.days.length : 0;
  pack60.recommended.hit56PctDays = best60.days.length ? 100 * best60.hit56 / best60.days.length : 0;
  pack60.current.achievable56 = pack60.current.hit56PctDays >= 30 && (cur60.realisticVsTheo || 0) >= 0.25;
  pack60.recommended.achievable56 = pack60.recommended.hit56PctDays >= 30 && (best60.realisticVsTheo || 0) >= 0.25;

  // CSV: daily P&L for both
  const csvPath = path.join('/workspace', 'binance-equity-perp-60d-daily-pnl.csv');
  const csvLines = [];
  csvLines.push('section,run,metric,value');
  for (const [name, pack] of [['current', pack60.current], ['recommended', pack60.recommended]]) {
    const dr = pack.dailyReturns || {};
    const rows = [
      ['summary', name, 'end_equity', pack.endEquity],
      ['summary', name, 'net_pnl', pack.totalPnl],
      ['summary', name, 'net_pnl_pct', pack.totalPnlPct],
      ['summary', name, 'trades', pack.trades],
      ['summary', name, 'win_rate', pack.winRate],
      ['summary', name, 'profit_factor', pack.profitFactor],
      ['summary', name, 'max_dd_usd', pack.maxDd],
      ['summary', name, 'max_dd_pct', pack.maxDdPct],
      ['summary', name, 'mean_daily_pct_all_days', dr.meanDailyPctAllDays],
      ['summary', name, 'median_daily_pct_all_days', dr.medianDailyPctAllDays],
      ['summary', name, 'geo_avg_daily_pct', dr.geoAvgDailyPct],
      ['summary', name, 'mean_daily_pct_trade_days', dr.meanDailyPctTradeDays],
      ['summary', name, 'median_daily_pct_trade_days', dr.medianDailyPctTradeDays],
      ['summary', name, 'trade_days', dr.tradeDays],
      ['summary', name, 'calendar_days', dr.calendarDays],
      ['summary', name, 'days_ge_5pct', pack.hit5plus],
      ['summary', name, 'days_5_to_6pct_band', pack.hit56],
    ];
    for (const r of rows) csvLines.push(r.join(','));
  }
  // Top OOS combos daily-return summary
  for (const m of ranked.slice(0, 8)) {
    const dr = (m.test && m.test.dailyReturns) || {};
    csvLines.push(['summary', `oos_${m.interval}_${m.variant}`, 'mean_daily_pct_all_days', dr.meanDailyPctAllDays].join(','));
    csvLines.push(['summary', `oos_${m.interval}_${m.variant}`, 'median_daily_pct_all_days', dr.medianDailyPctAllDays].join(','));
    csvLines.push(['summary', `oos_${m.interval}_${m.variant}`, 'geo_avg_daily_pct', dr.geoAvgDailyPct].join(','));
    csvLines.push(['summary', `oos_${m.interval}_${m.variant}`, 'mean_daily_pct_trade_days', dr.meanDailyPctTradeDays].join(','));
    csvLines.push(['summary', `oos_${m.interval}_${m.variant}`, 'trades', m.test && m.test.trades].join(','));
    csvLines.push(['summary', `oos_${m.interval}_${m.variant}`, 'net_pnl_pct', m.test && m.test.totalPnlPct].join(','));
  }
  csvLines.push('');
  csvLines.push('run,date_ist,trades,pnl_usd,pnl_pct_of_day_start,cumulative_equity,would_have_6pct_loss_halt,would_have_5pct_profit_mark,day_start_equity');
  for (const [name, pack] of [['current', pack60.current], ['recommended', pack60.recommended]]) {
    for (const d of pack.days) {
      const base = d.dayStartEquity || CAPITAL;
      csvLines.push([
        name, d.date, d.trades,
        (d.pnl ?? 0).toFixed(4),
        (base ? ((d.pnl ?? 0) / base) * 100 : 0).toFixed(4),
        (d.equity ?? 0).toFixed(4),
        d.wouldHalt6 ? 1 : 0,
        d.wouldProfitHalt5 ? 1 : 0,
        (base).toFixed(4),
      ].join(','));
    }
  }
  fs.writeFileSync(csvPath, csvLines.join('\n'));
  console.log('CSV written', csvPath, 'lines', csvLines.length);

  // Crypto majors secondary reference (BTC/ETH 15m indicators) — optional short
  let cryptoRef = null;
  try {
    const btc = await fetchAllKlines(client, 'BTCUSDT', '15m', since60 - 250 * TF_MS['15m']);
    const eth = await fetchAllKlines(client, 'ETHUSDT', '15m', since60 - 250 * TF_MS['15m']);
    const cref = runPortfolio(
      [{ symbol: 'BTCUSDT', bars: btc }, { symbol: 'ETHUSDT', bars: eth }],
      '15m', currentVar, { startMs: since60 },
    );
    cryptoRef = { note: 'Secondary reference only — not the bot universe', ...summarize(cref), trades: cref.trades };
  } catch (e) { cryptoRef = { error: e.message }; }

  const report = {
    generatedAt: new Date().toISOString(),
    capital: CAPITAL, leverage: LEVERAGE, maxPositions: MAX_POS,
    riskPerTradePct: RISK_PCT, dailyLossLimitPct: DAILY_LOSS_PCT,
    feesRoundTrip: FEE_RT, slippageBps: SLIP_BPS, fundingPer8h: FUNDING_8H,
    entryTimeoutSec: ENTRY_TIMEOUT_MS / 1000,
    universe: symbols,
    universeNote: 'Binance USDⓈ-M TRADIFI_PERPETUAL EQUITY only; liquidity maxSpread~20bps, minVol~$5M, minDepth~$10k (≈$1k≤10% of ±0.5% depth); slip '+SLIP_BPS+'bps',
    historyNote: 'US stock perps have short listing history (onboarded 2026). 1d and late-listed names (e.g. QQQ) often fall below the 220-bar indicator warm-up — flagged as low sample.',
    flags,
    matrix,
    ranked: ranked.slice(0, 15).map((m) => ({
      interval: m.interval, variant: m.variant, label: m.label, score: m.score,
      test: m.test, train: m.train, lowSample: m.lowSample, testTrades: m.testTrades, maxHoldBars: m.maxHoldBars,
    })),
    recommendation: best ? {
      interval: best.interval, variant: best.variant, label: best.label,
      reason: `Best OOS (test) score among variants with ≥5 test trades. Max-hold scales with TF (${best.maxHoldBars} bars).`
        + (best.lowSample ? ' WARNING: low sample size — treat as tentative.' : ''),
      test: best.test, lowSample: best.lowSample,
    } : null,
    sixtyDay: pack60,
    csvPath,
    cryptoRef,
  };

  const jsonPath = path.join(OUT, 'study-report.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  // Compact days for canvas (avoid huge embed)
  const canvasData = {
    ...report,
    matrix: report.matrix.map((m) => ({ ...m, /* drop nested heavies if any */ })),
    sixtyDay: {
      current: { ...pack60.current, tradeList: undefined },
      recommended: { ...pack60.recommended, tradeList: undefined },
    },
  };
  fs.writeFileSync(path.join(OUT, 'study-canvas.json'), JSON.stringify(canvasData));
  console.log('Report', jsonPath);
  console.log('DONE');
}


function monteCarloRuin(tradePnls, opts = {}) {
  const nPaths = opts.nPaths || 2000;
  const ruinPct = opts.ruinPct || 50; // equity down 50% from start = ruin
  const start = opts.start || CAPITAL;
  const ruinLevel = start * (1 - ruinPct / 100);
  if (!tradePnls.length) return { nPaths, ruinRate: null, p05: null, p50: null, p95: null, note: 'no trades' };
  let ruins = 0;
  const finals = [];
  for (let p = 0; p < nPaths; p++) {
    let eq = start, ruined = false;
    for (let i = 0; i < tradePnls.length; i++) {
      const j = Math.floor(Math.random() * tradePnls.length);
      // scale pnl roughly with equity (compounding approx)
      const scale = eq / start;
      eq += tradePnls[j] * scale;
      if (eq <= ruinLevel) { ruined = true; break; }
      if (eq <= 0) { eq = 0; ruined = true; break; }
    }
    if (ruined) ruins++;
    finals.push(eq);
  }
  finals.sort((a, b) => a - b);
  const q = (a) => finals[Math.min(finals.length - 1, Math.floor(a * finals.length))];
  return {
    nPaths, ruinPct, ruinRate: ruins / nPaths,
    p05: q(0.05), p50: q(0.5), p95: q(0.95),
    note: `Bootstrap reshuffle of ${tradePnls.length} trades × ${nPaths} paths; ruin = −${ruinPct}% equity`,
  };
}

function summarize(r) {
  return {
    trades: r.trades, wins: r.wins, losses: r.losses, winRate: +r.winRate.toFixed(3),
    totalPnl: +r.totalPnl.toFixed(2), totalPnlPct: +r.totalPnlPct.toFixed(2),
    endEquity: +r.endEquity.toFixed(2), profitFactor: r.profitFactor === Infinity ? 999 : +((r.profitFactor || 0).toFixed(2)),
    maxDd: +r.maxDd.toFixed(2), maxDdPct: +r.maxDdPct.toFixed(2),
    peakDate: r.peakDate, troughDate: r.troughDate, recoveryDate: r.recoveryDate,
    dayWins: r.dayWins, dayLoss: r.dayLoss,
    bestDayPnl: r.bestDay ? +r.bestDay.pnl.toFixed(2) : null, bestDayDate: r.bestDay?.date,
    worstDayPnl: r.worstDay ? +r.worstDay.pnl.toFixed(2) : null, worstDayDate: r.worstDay?.date,
    hit56: r.hit56, hit5plus: r.hit5plus, haltDays: r.haltDays, profitHaltDays: r.profitHaltDays,
    hit56PctDays: r.days && r.days.length ? +(100 * r.hit56 / r.days.length).toFixed(1) : 0,
    hit5plusPctDays: r.days && r.days.length ? +(100 * r.hit5plus / r.days.length).toFixed(1) : 0,
    theoretical5Equity: r.theoretical5 != null ? +r.theoretical5.toFixed(2) : null,
    theoretical5pct: r.theoretical5pct != null ? +r.theoretical5pct.toFixed(1) : null,
    realisticVsTheo: r.realisticVsTheo != null ? +r.realisticVsTheo.toFixed(3) : null,
    lowSample: r.lowSample,
    avgHoldBars: +((r.avgHoldBars || 0).toFixed(1)), maxHoldBars: r.maxHoldBars,
    dailyReturns: r.dailyReturns || dailyReturnStats(r.days || [], CAPITAL),
  };
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  CAPITAL, LEVERAGE, MAX_POS, RISK_PCT, TRAIN_FRAC, TFS, TF_MS, VARIANTS, OUT,
  signalAt, runPortfolio, splitTrainTest, maxHoldBars, summarize, toISTDate, agg10m, sizeQty, setActiveRules, getActiveRules, dailyReturnStats,
};
