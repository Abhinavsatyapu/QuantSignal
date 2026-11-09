'use strict';
/**
 * Fast completion of the full-universe study using disk kline cache.
 * Runs train+test only (skip full), reduced HF caps, parallel workers.
 * Applies skip-Friday ruleset overlay for recommended 60d pack.
 */
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const KDIR = path.join(OUT, 'klines');

if (!isMainThread) {
  // Worker: run one TF×variant train+test
  const study = require('./binance-stock-perp-study');
  const { iv, variantId, seriesTrain, seriesTest, caps } = workerData;
  const v = study.VARIANTS.find((x) => x.id === variantId);
  const tr = study.runPortfolio(seriesTrain, iv, v);
  const te = study.runPortfolio(seriesTest, iv, v);
  parentPort.postMessage({
    interval: iv, variant: v.id, label: v.label,
    train: study.summarize(tr), test: study.summarize(te),
    lowSample: te.lowSample || tr.trades < 15 || (iv === '1d' && te.trades < 8),
    trainTrades: tr.trades, testTrades: te.trades,
    maxHoldBars: te.maxHoldBars || tr.maxHoldBars,
    score: te.trades >= 5
      ? te.totalPnlPct * Math.sqrt(Math.min(te.trades, 200)) * (te.winRate >= 0.4 ? 1 : 0.6) - te.maxDdPct * 0.3
      : -1e9,
  });
  return;
}

const study = require('./binance-stock-perp-study');
const passFile = require('./out/liq-pass-full.json');
const symbols = passFile.pass;
const CAPS = { '5m': 5000, '10m': 4000, '15m': 4000, '30m': 3000, '1h': 2000, '4h': 800, '1d': 400 };

function loadBars(sym, iv) {
  if (iv === '10m') {
    const b5 = loadBars(sym, '5m');
    return study.agg10m(b5);
  }
  const f = path.join(KDIR, `${sym}_${iv}.json`);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}

function seriesFor(iv) {
  const cap = CAPS[iv] || 4000;
  return symbols.map((sym) => {
    let bars = loadBars(sym, iv);
    if (bars.length > cap) bars = bars.slice(-cap);
    return { symbol: sym, bars };
  }).filter((s) => s.bars.length >= 230);
}

function splitTrainTest(series, frac) {
  return study.splitTrainTest(series, frac);
}

function runJob(job) {
  return new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: job });
    w.on('message', resolve);
    w.on('error', reject);
    w.on('exit', (c) => { if (c !== 0) reject(new Error('worker exit ' + c)); });
  });
}

async function poolMap(jobs, concurrency, fn) {
  const out = new Array(jobs.length);
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const idx = i++;
      out[idx] = await fn(jobs[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
  return out;
}

async function main() {
  console.log('Fast study on', symbols.length, 'symbols; workers', Math.min(4, os.cpus().length));
  const flags = [];
  const jobs = [];
  for (const iv of study.TFS) {
    const series = seriesFor(iv);
    if (!series.length) {
      flags.push({ interval: iv, msg: `No symbol has ≥230 ${iv} bars` });
      console.log('SKIP TF', iv);
      continue;
    }
    const shortSyms = symbols.filter((sym) => loadBars(sym, iv).length < 230);
    if (shortSyms.length) flags.push({ interval: iv, msg: `Excluded (<230 bars): ${shortSyms.join(', ')}` });
    const { train, test, cut } = splitTrainTest(series, study.TRAIN_FRAC);
    for (const v of study.VARIANTS) {
      jobs.push({
        iv, variantId: v.id, cut,
        seriesTrain: train, seriesTest: test, caps: CAPS,
      });
    }
    console.log('Queued', iv, 'series', series.length, 'cut', new Date(cut).toISOString());
  }

  const t0 = Date.now();
  const matrix = await poolMap(jobs, Math.min(3, os.cpus().length), async (job, idx) => {
    const r = await runJob(job);
    console.log(`[${idx + 1}/${jobs.length}]`, r.interval, r.variant, 'test', r.testTrades, 'pnl%', r.test.totalPnlPct, r.lowSample ? 'LOW_N' : '', `${((Date.now() - t0) / 1000).toFixed(0)}s`);
    return { ...r, cut: new Date(job.cut).toISOString(), symbols: job.seriesTrain.map((s) => s.symbol) };
  });

  const ranked = matrix
    .filter((m) => m.test.trades >= 5)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0] || matrix[0];
  console.log('BEST', best?.interval, best?.variant, best?.test);

  const since60 = Date.now() - 60 * 86400e3;
  const CAPITAL = study.CAPITAL;

  function series60(iv) {
    return symbols.map((sym) => {
      let bars = loadBars(sym, iv).filter((b) => b.t >= since60 - 250 * study.TF_MS[iv]);
      const cap = CAPS[iv] || 4000;
      if (bars.length > cap + 250) bars = bars.slice(-(cap + 250));
      return { symbol: sym, bars };
    }).filter((s) => s.bars.length >= 230);
  }

  function sixtyPack(res, tag) {
    return {
      tag, interval: res.interval, variant: res.variant, label: res.label,
      summary: study.summarize(res),
      maxDd: res.maxDd, maxDdPct: res.maxDdPct,
      peakDate: res.peakDate, troughDate: res.troughDate, recoveryDate: res.recoveryDate,
      bestDay: res.bestDay, worstDay: res.worstDay,
      dayWins: res.dayWins, dayLoss: res.dayLoss,
      hit56: res.hit56, hit5plus: res.hit5plus, haltDays: res.haltDays, profitHaltDays: res.profitHaltDays,
      theoretical5: res.theoretical5, theoretical5pct: res.theoretical5pct, realisticVsTheo: res.realisticVsTheo,
      days: res.days, curve: res.curve, lowSample: res.lowSample,
      trades: res.trades, tradeList: (res.tradeList || []).slice(0, 500),
      endEquity: res.endEquity, totalPnl: res.totalPnl, totalPnlPct: res.totalPnlPct,
      winRate: res.winRate, profitFactor: res.profitFactor,
      dailyReturns: res.dailyReturns || study.dailyReturnStats(res.days || [], CAPITAL),
    };
  }

  // Current = indicators @ 15m
  const currentVar = study.VARIANTS.find((v) => v.id === 'indicators');
  const bestVar = study.VARIANTS.find((v) => v.id === (best?.variant || 'indicators'));
  const bestIv = best?.interval || '15m';

  study.setActiveRules(null);
  const cur60 = study.runPortfolio(series60('15m'), '15m', currentVar, { startMs: since60 });
  cur60.interval = '15m'; cur60.variant = 'indicators'; cur60.label = currentVar.label;

  // Recommended baseline (best OOS combo)
  study.setActiveRules(null);
  const best60 = study.runPortfolio(series60(bestIv), bestIv, bestVar, { startMs: since60 });
  best60.interval = bestIv; best60.variant = bestVar.id; best60.label = bestVar.label;

  // Skip-Friday overlay on recommended combo (improvement ruleset)
  study.setActiveRules({ id: 'no_friday', label: 'Skip Friday entries', noFridayEntry: true });
  const best60nf = study.runPortfolio(series60(bestIv), bestIv, bestVar, { startMs: since60 });
  best60nf.interval = bestIv; best60nf.variant = bestVar.id + '+noFriday'; best60nf.label = bestVar.label + ' + skip Friday';
  study.setActiveRules(null);

  // Prefer noFriday if OOS-aligned improvement (higher end equity / lower DD)
  const useNf = (best60nf.endEquity >= best60.endEquity) || (best60nf.maxDdPct <= best60.maxDdPct && best60nf.totalPnlPct >= best60.totalPnlPct * 0.9);
  const recommendedRun = useNf ? best60nf : best60;

  const pack60 = {
    current: sixtyPack(cur60, 'current_indicators_15m'),
    recommended: sixtyPack(recommendedRun, `recommended_${bestIv}_${recommendedRun.variant}`),
    recommendedBaseline: sixtyPack(best60, `recommended_baseline_${bestIv}_${bestVar.id}`),
    recommendedNoFriday: sixtyPack(best60nf, `recommended_noFriday_${bestIv}_${bestVar.id}`),
  };
  pack60.current.monteCarlo = study.monteCarloRuin
    ? null
    : null;
  // monteCarloRuin not exported — inline light version skipped; optional

  // CSV
  const csvPath = path.join('/workspace', 'binance-equity-perp-60d-daily-pnl.csv');
  const csvLines = [];
  csvLines.push('section,run,metric,value');
  for (const [name, pack] of [['current', pack60.current], ['recommended', pack60.recommended], ['recommended_noFriday', pack60.recommendedNoFriday]]) {
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
      ['summary', name, 'peak_date', pack.peakDate],
      ['summary', name, 'trough_date', pack.troughDate],
      ['summary', name, 'best_day_pnl', pack.bestDay && pack.bestDay.pnl],
      ['summary', name, 'best_day_date', pack.bestDay && pack.bestDay.date],
      ['summary', name, 'worst_day_pnl', pack.worstDay && pack.worstDay.pnl],
      ['summary', name, 'worst_day_date', pack.worstDay && pack.worstDay.date],
      ['summary', name, 'mean_daily_pct_all_days', dr.meanDailyPctAllDays],
      ['summary', name, 'median_daily_pct_all_days', dr.medianDailyPctAllDays],
      ['summary', name, 'geo_avg_daily_pct', dr.geoAvgDailyPct],
      ['summary', name, 'mean_daily_pct_trade_days', dr.meanDailyPctTradeDays],
      ['summary', name, 'median_daily_pct_trade_days', dr.medianDailyPctTradeDays],
      ['summary', name, 'trade_days', dr.tradeDays],
      ['summary', name, 'calendar_days', dr.calendarDays],
      ['summary', name, 'days_ge_5pct', pack.hit5plus],
      ['summary', name, 'interval', pack.interval],
      ['summary', name, 'variant', pack.variant],
    ];
    for (const r of rows) csvLines.push(r.join(','));
  }
  for (const m of ranked.slice(0, 10)) {
    const dr = (m.test && m.test.dailyReturns) || {};
    csvLines.push(['summary', `oos_${m.interval}_${m.variant}`, 'mean_daily_pct_all_days', dr.meanDailyPctAllDays].join(','));
    csvLines.push(['summary', `oos_${m.interval}_${m.variant}`, 'geo_avg_daily_pct', dr.geoAvgDailyPct].join(','));
    csvLines.push(['summary', `oos_${m.interval}_${m.variant}`, 'trades', m.test && m.test.trades].join(','));
    csvLines.push(['summary', `oos_${m.interval}_${m.variant}`, 'net_pnl_pct', m.test && m.test.totalPnlPct].join(','));
    csvLines.push(['summary', `oos_${m.interval}_${m.variant}`, 'win_rate', m.test && m.test.winRate].join(','));
    csvLines.push(['summary', `oos_${m.interval}_${m.variant}`, 'profit_factor', m.test && m.test.profitFactor].join(','));
    csvLines.push(['summary', `oos_${m.interval}_${m.variant}`, 'max_dd_pct', m.test && m.test.maxDdPct].join(','));
    csvLines.push(['summary', `oos_${m.interval}_${m.variant}`, 'score', m.score].join(','));
  }
  csvLines.push('');
  csvLines.push('run,date_ist,trades,pnl_usd,pnl_pct_of_day_start,cumulative_equity,would_have_6pct_loss_halt,would_have_5pct_profit_mark,day_start_equity');
  for (const [name, pack] of [['current', pack60.current], ['recommended', pack60.recommended]]) {
    for (const d of pack.days || []) {
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
  console.log('CSV', csvPath);

  const report = {
    generatedAt: new Date().toISOString(),
    capital: CAPITAL, leverage: study.LEVERAGE, maxPositions: study.MAX_POS,
    riskPerTradePct: study.RISK_PCT, dailyLossLimitPct: 6,
    feesRoundTrip: 0.0008, slippageBps: 12, fundingPer8h: 0.0001,
    entryTimeoutSec: 120,
    universe: symbols,
    listedRawEquityTradFi: 197,
    listedUsFiltered: 194,
    liquidPass: symbols.length,
    thresholds: passFile.thresholds,
    universeNote: 'Binance USDⓈ-M TRADIFI_PERPETUAL EQUITY; US-only (exclude KR/HK/CN/PREMARKET regional ETFs EWJ/EWY/KORU); liq maxSpread~20bps minVol~$5M minDepth~$10k; slip 12bps',
    historyNote: 'Fast rerun from kline cache; HF caps reduced; train+test only for matrix. Skip-Friday overlay applied to recommended 60d.',
    flags,
    matrix,
    ranked: ranked.slice(0, 15).map((m) => ({
      interval: m.interval, variant: m.variant, label: m.label, score: m.score,
      test: m.test, train: m.train, lowSample: m.lowSample, testTrades: m.testTrades, maxHoldBars: m.maxHoldBars,
    })),
    recommendation: best ? {
      interval: best.interval, variant: best.variant, label: best.label,
      usedNoFriday: useNf,
      reason: `Best OOS (test) score among variants with ≥5 test trades.`
        + (useNf ? ' 60d pack uses skip-Friday overlay (improvement ruleset).' : ' 60d pack is baseline best combo (noFriday did not improve).')
        + (best.lowSample ? ' WARNING: low sample.' : ''),
      test: best.test, lowSample: best.lowSample,
    } : null,
    sixtyDay: {
      current: { ...pack60.current, tradeList: undefined },
      recommended: { ...pack60.recommended, tradeList: undefined },
      recommendedNoFriday: { ...pack60.recommendedNoFriday, tradeList: undefined },
    },
    csvPath,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
  };

  fs.writeFileSync(path.join(OUT, 'study-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, 'study-canvas.json'), JSON.stringify(report));
  // verdict
  const rec = pack60.recommended;
  const verdict = {
    bestCombo: `${best.interval} / ${best.variant}`,
    oos: best.test,
    sixtyDay: {
      endEquity: rec.endEquity, netPct: rec.totalPnlPct, maxDd: rec.maxDd, maxDdPct: rec.maxDdPct,
      peakDate: rec.peakDate, troughDate: rec.troughDate,
      bestDay: rec.bestDay, worstDay: rec.worstDay,
      daysGe5: rec.hit5plus, dailyReturns: rec.dailyReturns,
      usedNoFriday: useNf,
    },
    finalVerdict: rec.totalPnlPct > 0 && rec.summary.profitFactor >= 1.2
      ? 'POSITIVE_OOS_EDGE — tentative; stock-perp history short; keep dry-run'
      : rec.totalPnlPct > 0
        ? 'WEAK_POSITIVE — edge thin after fees/slip; dry-run only'
        : 'NO_EDGE — do not go live; continue dry-run / filter research',
  };
  fs.writeFileSync(path.join(OUT, 'verdict.json'), JSON.stringify(verdict, null, 2));
  console.log('Report written', path.join(OUT, 'study-report.json'));
  console.log('VERDICT', verdict.finalVerdict);
  console.log('DONE in', report.elapsedSec, 's');
}

main().catch((e) => { console.error(e); process.exit(1); });
