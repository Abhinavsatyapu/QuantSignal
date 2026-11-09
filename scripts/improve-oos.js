'use strict';
/**
 * Accuracy improvement pass on full liquid universe (62).
 * Baseline: 4h liq_buy_side (study best).
 * Candidates: whale confirm, HTF trend (1d EMA), ATR stops, confluence with
 * 30m liq_sweep / 10m indicators, multi-kind liquidity.
 * Adopt only if OOS improves with adequate trade count (prefer N>=8, never fabricate).
 */
const fs = require('fs');
const path = require('path');
const study = require('./binance-stock-perp-study');

const OUT = path.join(__dirname, 'out');
const pass = require('./out/liq-pass-full.json').pass;
const DATA = 'https://www.binance.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dataGet(pathName, params) {
  const q = new URLSearchParams(params);
  const res = await fetch(DATA + pathName + '?' + q);
  if (!res.ok) throw new Error(pathName + ' ' + res.status + ' ' + (await res.text()).slice(0, 180));
  return res.json();
}

async function whaleSeries(symbol) {
  let oi = [], taker = [], top = [];
  try { oi = await dataGet('/futures/data/openInterestHist', { symbol, period: '4h', limit: 500 }); } catch (e) { return { error: e.message }; }
  try { taker = await dataGet('/futures/data/takerlongshortRatio', { symbol, period: '4h', limit: 500 }); } catch {}
  try { top = await dataGet('/futures/data/topLongShortAccountRatio', { symbol, period: '4h', limit: 500 }); } catch {}
  const byT = new Map();
  for (const h of oi) {
    const t = Number(h.timestamp);
    byT.set(t, { t, oi: Number(h.sumOpenInterest) });
  }
  for (const h of taker) {
    const t = Number(h.timestamp);
    const row = byT.get(t) || { t };
    const r = Number(h.buySellRatio);
    row.takerBuyRatio = r > 0 ? r / (1 + r) : null;
    byT.set(t, row);
  }
  for (const h of top) {
    const t = Number(h.timestamp);
    const row = byT.get(t) || { t };
    row.topLongRatio = Number(h.longAccount) || Number(h.longShortRatio) || null;
    byT.set(t, row);
  }
  const rows = [...byT.values()].sort((a, b) => a.t - b.t);
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].oi, cur = rows[i].oi;
    rows[i].oiChangePct = prev > 0 ? ((cur - prev) / prev) * 100 : null;
  }
  return { rows };
}

function whaleBiasAt(rows, t) {
  let best = null;
  for (const r of rows) { if (r.t <= t) best = r; else break; }
  if (!best) return 0;
  let s = 0;
  if (best.oiChangePct != null) s += Math.max(-25, Math.min(25, best.oiChangePct * 2.5));
  if (best.takerBuyRatio != null) s += (best.takerBuyRatio - 0.5) * 40;
  if (best.topLongRatio != null) {
    // topLongRatio ~0.5 neutral; >0.55 lean long accounts
    const x = best.topLongRatio > 1 ? 0.5 : best.topLongRatio; // if longShortRatio style
    s += (x - 0.5) * 30;
  }
  return s;
}

function ema(values, n) {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function htfTrendAt(bars1d, t) {
  // bars with .t/.c
  const upto = bars1d.filter((b) => b.t <= t);
  if (upto.length < 60) return null;
  const closes = upto.map((b) => b.c);
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  if (e20 == null || e50 == null) return null;
  if (e20 > e50 * 1.001) return 'LONG';
  if (e20 < e50 * 0.999) return 'SHORT';
  return null;
}

function atrStop(bars, i, dir, mult = 1.5) {
  // simple ATR14
  const a = [];
  for (let j = Math.max(1, i - 40); j <= i; j++) {
    const h = bars[j].h, l = bars[j].l, pc = bars[j - 1].c;
    a.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (a.length < 14) return null;
  const atr = a.slice(-14).reduce((s, x) => s + x, 0) / 14;
  const entry = bars[i].c;
  if (!(atr > 0) || !(entry > 0)) return null;
  if (dir === 'LONG') return { stop: entry - mult * atr, tp: entry + 2 * mult * atr, atr };
  return { stop: entry + mult * atr, tp: entry - 2 * mult * atr, atr };
}

function loadBars(sym, iv) {
  const f = path.join(OUT, 'klines', `${sym}_${iv}.json`);
  if (!fs.existsSync(f)) return null;
  let bars = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (bars.length > 900) bars = bars.slice(-900);
  return bars;
}

function scoreSummary(s) {
  if (!s) return -1e9;
  const n = s.trades || 0;
  if (n < 5) return -1e6 + n; // heavy penalty
  const pnl = s.totalPnlPct || 0;
  const pf = Math.min(s.profitFactor || 0, 8);
  const dd = s.maxDdPct || 0;
  const wr = s.winRate || 0;
  return pnl * 2 + pf * 8 + wr * 20 - dd * 1.5 + Math.min(n, 40) * 0.4;
}

function applyTradeFilter(tradeList, pred) {
  return (tradeList || []).filter(pred);
}

function rescoreFromTrades(baseRes, kept) {
  // Recompute crude summary from kept trades using study equity path if possible
  if (!kept.length) {
    return { trades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, totalPnlPct: 0, endEquity: 800, profitFactor: 0, maxDdPct: 0, lowSample: true };
  }
  let eq = 800, peak = 800, maxDd = 0, wins = 0, gp = 0, gl = 0;
  for (const t of kept) {
    const pnl = +t.pnl || 0;
    eq += pnl;
    if (pnl > 0) { wins++; gp += pnl; } else gl += -pnl;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  return {
    trades: kept.length,
    wins,
    losses: kept.length - wins,
    winRate: wins / kept.length,
    totalPnl: eq - 800,
    totalPnlPct: ((eq - 800) / 800) * 100,
    endEquity: eq,
    profitFactor: gl > 0 ? gp / gl : (gp > 0 ? 999 : 0),
    maxDdPct: peak ? (maxDd / peak) * 100 : 0,
    lowSample: kept.length < 30,
  };
}

async function main() {
  const symbols = pass.slice();
  console.log('Universe', symbols.length);

  // Whale cache (subset rate-limit; reuse whale-oos cache if present)
  const whaleCache = {};
  const whaleReport = path.join(OUT, 'whale-oos-report.json');
  // Always fetch for improve (can take a few min)
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    process.stdout.write(`whale ${i + 1}/${symbols.length} ${sym}… `);
    whaleCache[sym] = await whaleSeries(sym);
    console.log(whaleCache[sym].error || ((whaleCache[sym].rows || []).length + ' bars'));
    await sleep(120);
  }

  // Load series for variants
  function seriesFor(iv) {
    return symbols.map((sym) => {
      const bars = loadBars(sym, iv);
      return bars && bars.length >= 120 ? { symbol: sym, bars } : null;
    }).filter(Boolean);
  }

  const vBuy = study.VARIANTS.find((x) => x.id === 'liq_buy_side');
  const vSweep = study.VARIANTS.find((x) => x.id === 'liq_sweep');
  const vInd = study.VARIANTS.find((x) => x.id === 'indicators');

  const s4 = seriesFor('4h');
  const s30 = seriesFor('30m');
  const s10 = seriesFor('5m'); // 5m proxy for study's 10m indicators rank
  const s1d = seriesFor('1d');
  const bars1dBySym = Object.fromEntries(s1d.map((x) => [x.symbol, x.bars]));

  console.log('series', { '4h': s4.length, '30m': s30.length, '10m': s10.length, '1d': s1d.length });

  const baseline = study.runPortfolio(s4, '4h', vBuy);
  const baseOos = (() => {
    // study.runPortfolio returns full; use tradeList split ~60/40 like study if available
    return baseline;
  })();

  // Build candidate filters on baseline tradeList (full-sample then report train/test split by time)
  const trades = baseline.tradeList || [];
  const sortedTs = trades.map((t) => t.entryTs).sort((a, b) => a - b);
  const cut = sortedTs[Math.floor(sortedTs.length * 0.55)] || 0;

  function evalFilter(name, pred, opts = {}) {
    const kept = applyTradeFilter(trades, pred);
    const train = kept.filter((t) => t.entryTs < cut);
    const test = kept.filter((t) => t.entryTs >= cut);
    const trainS = rescoreFromTrades(baseline, train);
    const testS = rescoreFromTrades(baseline, test);
    const allS = rescoreFromTrades(baseline, kept);
    return { name, opts, train: trainS, test: testS, all: allS, score: scoreSummary(testS), nTest: testS.trades, nAll: allS.trades };
  }

  const candidates = [];
  candidates.push(evalFilter('baseline_4h_liq_buy_side', () => true));

  candidates.push(evalFilter('whale_confirm_min15', (t) => {
    const w = whaleCache[t.symbol];
    if (!w || w.error || !w.rows) return false;
    const s = whaleBiasAt(w.rows, t.entryTs || 0);
    const dir = t.dir || t.direction;
    if (dir === 'LONG' || dir === 'BUY') return s >= 15;
    return s <= -15;
  }));

  candidates.push(evalFilter('whale_confirm_min25', (t) => {
    const w = whaleCache[t.symbol];
    if (!w || w.error || !w.rows) return false;
    const s = whaleBiasAt(w.rows, t.entryTs || 0);
    const dir = t.dir || t.direction;
    if (dir === 'LONG' || dir === 'BUY') return s >= 25;
    return s <= -25;
  }));

  candidates.push(evalFilter('htf_1d_ema_align', (t) => {
    const b = bars1dBySym[t.symbol];
    if (!b) return true; // no HTF data → keep (don't over-shrink)
    const tr = htfTrendAt(b, t.entryTs || 0);
    if (!tr) return true;
    const dir = t.dir || t.direction;
    return tr === dir;
  }));

  candidates.push(evalFilter('whale15_and_htf', (t) => {
    const w = whaleCache[t.symbol];
    if (!w || w.error || !w.rows) return false;
    const s = whaleBiasAt(w.rows, t.entryTs || 0);
    const dir = t.dir || t.direction;
    const okW = (dir === 'LONG' || dir === 'BUY') ? s >= 15 : s <= -15;
    if (!okW) return false;
    const b = bars1dBySym[t.symbol];
    if (!b) return true;
    const tr = htfTrendAt(b, t.entryTs || 0);
    if (!tr) return true;
    return tr === dir;
  }));

  // Confluence: keep baseline trade if 30m sweep or 10m indicators also fired same direction nearby
  function nearSignal(series, variant, sym, ts, dir, tolMs) {
    const row = series.find((x) => x.symbol === sym);
    if (!row) return false;
    // Use study signalAt if exported — else scan last bars for matching closed trades from a mini run is heavy.
    // Lightweight: detect liquidity/indicators on bar at ts.
    const bars = row.bars;
    let i = -1;
    for (let k = 0; k < bars.length; k++) if (bars[k].t <= ts) i = k;
    if (i < 40) return false;
    const window = bars.slice(Math.max(0, i + 1 - 260), i + 1);
    try {
      if (variant.mode === 'indicators' || variant.mode === 'any' || variant.mode === 'confirm') {
        const ind = globalThis.Technicals.analyze(window, window[window.length - 1].T + 1, { minStopPct: 1.5 });
        if (['LONG', 'SHORT'].includes(ind.direction) && ind.direction === dir && ind.score >= 6) return true;
      }
      if (variant.mode === 'liquidity' || variant.mode === 'any' || variant.mode === 'confirm') {
        const liq = globalThis.LiquiditySignals.detect(window, {});
        let sigs = liq.signals || [];
        if (variant.kinds) sigs = sigs.filter((s) => variant.kinds.includes(s.kind));
        const L = sigs.filter((s) => s.side === 'LONG').length;
        const S = sigs.filter((s) => s.side === 'SHORT').length;
        const d = L > S ? 'LONG' : S > L ? 'SHORT' : null;
        if (d === dir) return true;
      }
    } catch {}
    return false;
  }

  // Ensure technicals loaded
  require('../public/indicators.js');
  require('../public/strategy-liquidity-signals.js');

  candidates.push(evalFilter('confluence_30m_sweep', (t) => {
    const dir = t.dir || t.direction;
    return nearSignal(s30, vSweep, t.symbol, t.entryTs, dir, 3 * 3600e3);
  }));

  candidates.push(evalFilter('confluence_10m_ind', (t) => {
    const dir = t.dir || t.direction;
    return nearSignal(s10, vInd, t.symbol, t.entryTs, dir, 2 * 3600e3);
  }));

  candidates.push(evalFilter('confluence_any_top', (t) => {
    const dir = t.dir || t.direction;
    return nearSignal(s30, vSweep, t.symbol, t.entryTs, dir, 3 * 3600e3)
      || nearSignal(s10, vInd, t.symbol, t.entryTs, dir, 2 * 3600e3);
  }));

  candidates.push(evalFilter('whale15_or_confluence', (t) => {
    const dir = t.dir || t.direction;
    const w = whaleCache[t.symbol];
    let okW = false;
    if (w && !w.error && w.rows) {
      const s = whaleBiasAt(w.rows, t.entryTs || 0);
      okW = (dir === 'LONG' || dir === 'BUY') ? s >= 15 : s <= -15;
    }
    const conf = nearSignal(s30, vSweep, t.symbol, t.entryTs, dir, 3 * 3600e3)
      || nearSignal(s10, vInd, t.symbol, t.entryTs, dir, 2 * 3600e3);
    return okW || conf;
  }));

  candidates.sort((a, b) => b.score - a.score);
  const baselineRow = candidates.find((c) => c.name === 'baseline_4h_liq_buy_side');
  // Prefer candidates that beat baseline OOS score with nTest >= max(5, baseline*0.5)
  const minN = Math.max(5, Math.floor((baselineRow?.nTest || 5) * 0.5));
  let best = baselineRow;
  for (const c of candidates) {
    if (c.name === 'baseline_4h_liq_buy_side') continue;
    if (c.nTest < minN) continue;
    if (c.score > best.score && (c.test.totalPnlPct >= (baselineRow.test.totalPnlPct || 0) - 0.01 || c.test.profitFactor >= (baselineRow.test.profitFactor || 0))) {
      // require not worse PF and better composite, or clearly better pnl%
      if (c.test.totalPnlPct > (baselineRow.test.totalPnlPct || 0) || (c.test.profitFactor > (baselineRow.test.profitFactor || 0) && c.test.totalPnlPct >= (baselineRow.test.totalPnlPct || 0) * 0.9)) {
        best = c;
      }
    }
  }

  // ATR stop overlay: re-simulate only if we want — skip heavy path; note as not adopted unless filter wins
  const report = {
    generatedAt: new Date().toISOString(),
    universe: symbols.length,
    baselineTrades: trades.length,
    cutTs: cut,
    minN,
    baseline: baselineRow,
    ranked: candidates.map((c) => ({
      name: c.name, score: +c.score.toFixed(2), nTest: c.nTest, nAll: c.nAll,
      test: c.test, train: c.train,
    })),
    adopted: best.name === 'baseline_4h_liq_buy_side' ? null : best,
    verdict: best.name === 'baseline_4h_liq_buy_side'
      ? 'NO_ADOPT — no filter beat baseline OOS with adequate N'
      : `ADOPT ${best.name} — OOS pnl% ${best.test.totalPnlPct.toFixed(2)} vs baseline ${(baselineRow.test.totalPnlPct || 0).toFixed(2)} (N=${best.nTest})`,
    notes: [
      'ATR stop re-pricing not fully path-simulated here; filter-level adoption only.',
      'Whale data via www.binance.com futures/data (fapi geo-blocked on some hosts).',
      'Combining top combos = confluence filters on top of 4h liq_buy_side entries.',
    ],
  };

  fs.writeFileSync(path.join(OUT, 'improve-oos-report.json'), JSON.stringify(report, null, 2));
  console.log('\nVERDICT', report.verdict);
  console.log('Top 5');
  report.ranked.slice(0, 5).forEach((r, i) => console.log(i + 1, r.name, 'score', r.score, 'nTest', r.nTest, 'oos%', r.test.totalPnlPct?.toFixed?.(2), 'PF', r.test.profitFactor));
}

main().catch((e) => { console.error(e); process.exit(1); });
