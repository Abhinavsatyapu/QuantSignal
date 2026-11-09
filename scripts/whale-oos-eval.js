'use strict';
/**
 * Honest OOS eval: does whale confirmation (OI↑ + taker buy imbalance) improve
 * the best study combo (4h liq_buy_side) on the liquid universe?
 * Uses Binance futures/data openInterestHist + takerlongshortRatio (public).
 * If data insufficient, reports NO_EDGE / INCONCLUSIVE — never fabricates.
 */
const fs = require('fs');
const path = require('path');
const study = require('./binance-stock-perp-study');
const bn = require('../server/binance');

const OUT = path.join(__dirname, 'out');
const DATA = 'https://www.binance.com';
const pass = require('./out/liq-pass-full.json').pass;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dataGet(pathName, params) {
  const q = new URLSearchParams(params);
  const res = await fetch(DATA + pathName + '?' + q);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function whaleSeries(symbol) {
  // 1d period over ~60-90 points
  let oi = [], taker = [];
  try { oi = await dataGet('/futures/data/openInterestHist', { symbol, period: '4h', limit: 500 }); } catch (e) { return { error: e.message }; }
  try { taker = await dataGet('/futures/data/takerlongshortRatio', { symbol, period: '4h', limit: 500 }); } catch (e) { return { error: e.message }; }
  const byT = new Map();
  for (const h of oi) {
    const t = Number(h.timestamp);
    byT.set(t, { t, oi: Number(h.sumOpenInterest), oiUsd: Number(h.sumOpenInterestValue) });
  }
  for (const h of taker) {
    const t = Number(h.timestamp);
    const row = byT.get(t) || { t };
    const r = Number(h.buySellRatio);
    row.takerBuyRatio = r > 0 ? r / (1 + r) : null;
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
  // nearest bar at or before t
  let best = null;
  for (const r of rows) { if (r.t <= t) best = r; else break; }
  if (!best) return 0;
  let s = 0;
  if (best.oiChangePct != null) s += Math.max(-25, Math.min(25, best.oiChangePct * 2.5));
  if (best.takerBuyRatio != null) s += (best.takerBuyRatio - 0.5) * 40;
  return s;
}

async function main() {
  const KDIR = path.join(OUT, 'klines');
  const iv = '4h';
  const v = study.VARIANTS.find((x) => x.id === 'liq_buy_side');
  const symbols = pass.slice(0, 40); // rate-limit friendly
  const whaleCache = {};
  for (const sym of symbols) {
    process.stdout.write('whale ' + sym + '… ');
    whaleCache[sym] = await whaleSeries(sym);
    console.log(whaleCache[sym].error || ((whaleCache[sym].rows || []).length + ' bars'));
    await sleep(150);
  }

  // Load 4h bars
  const series = symbols.map((sym) => {
    const f = path.join(KDIR, `${sym}_${iv}.json`);
    if (!fs.existsSync(f)) return null;
    let bars = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (bars.length > 800) bars = bars.slice(-800);
    return { symbol: sym, bars };
  }).filter((s) => s && s.bars.length >= 230);

  const { train, test } = study.splitTrainTest(series, study.TRAIN_FRAC);
  const since60 = Date.now() - 60 * 86400e3;

  // Monkey-patch: wrap signalAt via activeRules-like filter using whale score
  // We re-implement by filtering trades from baseline runPortfolio tradeList
  const baseTrain = study.runPortfolio(train, iv, v);
  const baseTest = study.runPortfolio(test, iv, v);
  const base60 = study.runPortfolio(series.map((s) => ({ ...s, bars: s.bars.filter((b) => b.t >= since60 - 250 * study.TF_MS[iv]) })).filter((s) => s.bars.length >= 230), iv, v, { startMs: since60 });

  function filterTrades(res, minScore) {
    const kept = (res.tradeList || []).filter((t) => {
      const w = whaleCache[t.symbol];
      if (!w || w.error || !w.rows) return false;
      const score = whaleBiasAt(w.rows, t.entryTs || 0);
      const dir = t.dir || t.direction || t.side;
      if (dir === 'LONG' || dir === 'BUY') return score >= minScore;
      return score <= -minScore;
    });
    // Rebuild crude summary from kept trades
    const wins = kept.filter((t) => t.pnl > 0).length;
    const losses = kept.filter((t) => t.pnl <= 0).length;
    const totalPnl = kept.reduce((a, t) => a + (t.pnl || 0), 0);
    const grossWin = kept.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    const grossLoss = Math.abs(kept.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
    return {
      trades: kept.length, wins, losses,
      winRate: kept.length ? wins / kept.length : 0,
      totalPnl, totalPnlPct: (totalPnl / study.CAPITAL) * 100,
      endEquity: study.CAPITAL + totalPnl,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
      note: `whale confirm |score|≥${minScore}; filtered from baseline tradeList (approx, no full re-sim of compounding path)`,
    };
  }

  // Inspect tradeList fields
  const sample = (baseTest.tradeList || [])[0];
  console.log('sample trade keys', sample && Object.keys(sample));

  const report = {
    generatedAt: new Date().toISOString(),
    baseline: {
      train: study.summarize(baseTrain),
      test: study.summarize(baseTest),
      sixtyDay: study.summarize(base60),
    },
    whaleConfirm: {},
    symbolsTried: symbols.length,
    whaleDataErrors: Object.entries(whaleCache).filter(([, v]) => v.error).map(([k, v]) => k + ': ' + v.error),
  };

  for (const thr of [15, 25, 35]) {
    // Need entry timestamp on trades — check field names from runPortfolio
    report.whaleConfirm['thr_' + thr] = {
      test: filterTrades(baseTest, thr),
      sixtyDay: filterTrades(base60, thr),
    };
  }

  // Verdict
  const basePct = report.baseline.test.totalPnlPct;
  const best = Object.entries(report.whaleConfirm).map(([k, v]) => ({ k, ...v.test })).sort((a, b) => b.totalPnlPct - a.totalPnlPct)[0];
  let verdict = 'INCONCLUSIVE';
  if (!best || best.trades < 3) verdict = 'INCONCLUSIVE — too few whale-confirmed OOS trades';
  else if (best.totalPnlPct > basePct && best.profitFactor >= (report.baseline.test.profitFactor || 0)) verdict = 'IMPROVES_OOS — whale confirm helped on this sample (still LOW N)';
  else if (best.totalPnlPct > basePct) verdict = 'MIXED — higher PnL% but PF not clearly better';
  else verdict = 'NO_IMPROVEMENT — whale confirm did not beat baseline OOS on this sample';

  report.verdict = verdict;
  report.bestWhale = best;
  fs.writeFileSync(path.join(OUT, 'whale-oos-report.json'), JSON.stringify(report, null, 2));
  console.log('VERDICT', verdict);
  console.log('baseline test', report.baseline.test.trades, report.baseline.test.totalPnlPct, report.baseline.test.profitFactor);
  console.log('best whale', best);
  console.log('DONE');
}

main().catch((e) => { console.error(e); process.exit(1); });
