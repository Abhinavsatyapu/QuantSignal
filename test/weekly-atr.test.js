// "Weekly ATR distances" strike selection: ATR maths, weekly bars, strike snapping, trading days, the end-to-end method on
// a synthetic Black-Scholes chain (fixture: exercises the maths only), the price-history fallback and run persistence.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'), os = require('os'), fs = require('fs');
require('../public/strategy-engine.js');
require('../public/strategy-optimizer.js');
require('../public/strategy-weekly-atr.js');
const S = globalThis.Strategy;
const EXP = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10), NOW = S.expiryCloseMs(EXP) - 4.7 * 864e5;
function chain(spot, iv, { oi = 500 } = {}) {
  const T = (S.expiryCloseMs(EXP) - NOW) / (365 * 864e5), out = [];
  for (let i = -20; i <= 20; i++) { const K = Math.round((spot + i * 2.5) / 2.5) * 2.5; for (const type of ['call', 'put']) {
    const mid = S.bs(spot, K, T, iv, 0.04, type), g = S.bsGreeks(spot, K, T, iv, 0.04, type), half = Math.max(0.01, mid * 0.01);
    out.push({ symbol: 'T' + type[0] + K, type, strike: K, expiry: EXP, multiplier: 100, bid: Math.max(0, +(mid - half).toFixed(2)), ask: +(mid + half).toFixed(2), iv, greeks: g, quoteTime: new Date(NOW).toISOString(), bidSize: 50, askSize: 50, openInterest: oi, volume: 100 });
  } }
  return out;
}
const perp = (x) => ({ available: true, symbol: 'xyz:TEST', bid: x - 0.01, ask: x + 0.01, mid: x, szDecimals: 2, maxLeverage: 10, funding: 0.00001 });
const WA = { atr: 6.3, n: 14, upperMult: 1, lowerMult: 1, scaleToExpiry: false, tradingDays: 5, source: 'fixture weekly bars', sourceKind: 'fixture' };
const run = (cfg = {}, wa = {}, extra = {}) => S.optimize({ nowMs: NOW, ticker: 'TEST', expiry: EXP, contracts: chain(100, 0.6), stock: { price: 100, source: 'fixture' }, perp: perp(100), cfg: { targetMode: 'fixed', targetPnl: 400, ...cfg },
  market: { direction: 'LONG', score: 7, maxScore: 8, trend: 'UP', momentum: 'UP', rsi: 60 }, weeklyAtr: { ...WA, ...wa }, ...extra });

test('weekly ATR: Wilder smoothing of weekly true ranges matches a hand calculation (gaps use the previous close)', () => {
  const bars = [{ week: 'w0', h: 10, l: 8, c: 9 }, { week: 'w1', h: 11, l: 9, c: 10 }, { week: 'w2', h: 13, l: 10, c: 12 }, { week: 'w3', h: 12, l: 7, c: 8 }, { week: 'w4', h: 9, l: 6, c: 7 }, { week: 'w5', h: 15, l: 14, c: 14.5 }];
  const a = S.wilderAtr(bars, 3);
  assert.deepEqual(a.trueRanges, [2, 3, 5, 3, 8]); // w5: gap up from 7 → TR = 15 − 7
  assert.ok(Math.abs(a.atr - 130 / 27) < 1e-12, String(a.atr)); // seed (2+3+5)/3 → (·2+3)/3 → (·2+8)/3
  assert.equal(a.barsUsed, 6); assert.equal(a.firstWeek, 'w0'); assert.equal(a.lastWeek, 'w5');
  assert.equal(S.wilderAtr(bars.slice(0, 3), 3), null); // needs N + 1 bars
  const flat = Array.from({ length: 20 }, (_, i) => ({ week: 'w' + i, h: 101, l: 99, c: 100 }));
  assert.ok(Math.abs(S.wilderAtr(flat, 14).atr - 2) < 1e-12);
});

test('weekly bars from daily OHLC: Monday-start weeks, first open / max high / min low / last close, forming week dropped', () => {
  const d = (date, o, h, l, c) => ({ date, o, h, l, c });
  const daily = [d('2026-10-07', 101, 104, 100, 103), d('2026-10-05', 100, 102, 99, 101), d('2026-10-06', 101, 103, 98, 102), d('2026-10-09', 103, 106, 102, 105), d('2026-10-10', 105, 105.5, 104, 104.5),
    d('2026-10-12', 104, 108, 103, 107), d('2026-10-13', 107, 109, 106, 108), d('2026-10-19', 108, 110, 107, 109), d('2026-10-20', NaN, 1, 1, 1)];
  const w = S.weeklyBarsFromDaily(daily, { beforeWeek: '2026-10-19' });
  assert.deepEqual(w.map(b => b.week), ['2026-10-05', '2026-10-12']);
  assert.deepEqual([w[0].o, w[0].h, w[0].l, w[0].c, w[0].days], [100, 106, 98, 104.5, 5]); // Saturday perp bar belongs to the same week
  assert.deepEqual([w[1].o, w[1].h, w[1].l, w[1].c, w[1].days], [104, 109, 103, 108, 2]);
  assert.equal(S.weekStartOf('2026-10-26'), '2026-10-26'); assert.equal(S.weekStartOf('2026-11-01'), '2026-10-26');
});

test('strike snapping: nearest listed strike, ties go away from spot; trading days to expiry (NY sessions)', () => {
  const ks = [95, 97.5, 100, 102.5, 105];
  assert.equal(S.snapStrike(ks, 103.6, 100), 102.5);
  assert.equal(S.snapStrike(ks, 103.9, 100), 105);
  assert.equal(S.snapStrike(ks, 101.25, 100), 102.5); // tie → farther from spot
  assert.equal(S.snapStrike(ks, 98.75, 100), 97.5);
  assert.equal(S.snapStrike([], 100, 100), null);
  assert.equal(S.tradingDaysTo('2026-10-30', Date.parse('2026-10-26T14:00:00Z')), 5); // Mon 10:00 NY → Fri
  assert.equal(S.tradingDaysTo('2026-10-30', Date.parse('2026-10-26T21:00:00Z')), 4); // after Monday's close
  assert.equal(S.tradingDaysTo('2026-11-06', Date.parse('2026-10-26T14:00:00Z')), 10);
  assert.equal(S.tradingDaysTo('2026-10-30', Date.parse('2026-10-24T14:00:00Z')), 5); // Saturday
});

test('weekly ATR method: CE / PE shorts = nearest strikes to spot ± mult × ATR; distances in $ and %; perp follows the signal', () => {
  const o = run();
  assert.equal(o.status, 'OK', JSON.stringify(o.errors)); assert.equal(o.method, 'weekly_atr');
  const w = o.weeklyAtr;
  assert.equal(w.ceTarget, 106.3); assert.ok(Math.abs(w.peTarget - 93.7) < 1e-9);
  assert.equal(w.ceShort, 107.5); assert.equal(w.peShort, 92.5); // 106.3 → 107.5 (1.2 away vs 1.3), 93.7 → 92.5
  assert.ok(Math.abs(w.ceDistance.dollars - 7.5) < 1e-9 && Math.abs(w.ceDistance.pct - 7.5) < 1e-9 && Math.abs(w.peDistance.pct + 7.5) < 1e-9);
  assert.equal(w.scale, 1); assert.equal(w.effectiveAtr, 6.3);
  for (const x of [o.best, ...o.variants.filter(v => v.reachable).map(v => v.best)]) {
    assert.ok(x.legs.some(l => l.side === 'sell' && l.type === 'call' && l.strike === 107.5), 'sells the CE short');
    assert.ok(x.legs.some(l => l.side === 'sell' && l.type === 'put' && l.strike === 92.5), 'sells the PE short');
    assert.deepEqual([x.exits[0].price, x.exits[1].price], [107.5, 92.5]); // exits / profit targets = the two shorts
  }
  assert.equal(o.best.futuresSide, 'LONG'); // LONG signal → LONG perp, bearish options: put debit + call credit
  assert.ok(o.best.legs.some(l => l.side === 'buy' && l.type === 'put' && l.strike === 100)); // debit long = first OTM strike (≈0.1σ)
  assert.ok(o.best.why[0].includes('Weekly ATR distances'));
  const bear = run({ direction: 'BEARISH' });
  assert.equal(bear.status, 'OK', JSON.stringify(bear.errors)); assert.equal(bear.best.futuresSide, 'SHORT');
  assert.ok(bear.best.legs.some(l => l.side === 'buy' && l.type === 'call' && l.strike === 100));
  const asym = run({}, { upperMult: 1.5, lowerMult: 0.5 }); // 109.45 → 110, 96.85 → 97.5
  assert.equal(asym.weeklyAtr.ceShort, 110); assert.equal(asym.weeklyAtr.peShort, 97.5);
});

test('weekly ATR method: both lot ratios, perp floored to 5, margin = FQ × entry / 2, theta check, full what-if', () => {
  const o = run(), b = o.best, f = b.futures;
  assert.deepEqual(new Set(o.variants.map(v => v.key)), new Set(['1C:2P', '2C:1P']));
  assert.equal(o.variants.filter(v => v.recommended).length, 1); assert.equal(o.recommendation.mode, 'weekly_atr');
  assert.equal(Math.abs(f.signedQty) % 5, 0); assert.ok(Math.abs(f.signedQty) <= Math.abs(f.equalisingQty) + 1e-9 && Math.abs(f.equalisingQty) - Math.abs(f.signedQty) < 5);
  assert.ok(Math.abs(b.capital.futuresMargin - Math.abs(f.signedQty) * f.entry / 2) < 1e-6); assert.equal(b.capital.leverage, 5);
  assert.ok(['CREDIT', 'NEAR-NEUTRAL', 'DEBIT'].includes(b.theta.status));
  assert.ok(b.exits[0].pnlExpiry >= 400 && b.exits[1].pnlExpiry >= 400);
  const w = b.whatIf;
  assert.ok(w && w.priceGrid.length && w.ivGrid.today.length && w.theta.flatPath.length && w.tail.sigma2 && w.tail.sigma3 && w.probs.profit > 0 && Number.isFinite(w.probs.expectedValue) && w.execution.exitsAtFullSpread && w.events);
  const r2 = S.rescale(o, b, b.lotSets * 2); // scaling works on weekly-ATR runs too
  assert.equal(Math.abs(r2.perpQty) % 5, 0); assert.equal(r2.target, (b.perLotSet.target) * b.lotSets * 2);
});

test('weekly ATR method: scale-to-expiry option, risk caps, liquidity moves and validation', () => {
  const sc = run({}, { scaleToExpiry: true, tradingDays: 10 }); // ATR × √2 = 8.91 → CE 108.91 → 110, PE 91.09 → 90
  assert.equal(sc.status, 'OK', JSON.stringify(sc.errors)); assert.ok(Math.abs(sc.weeklyAtr.scale - Math.SQRT2) < 1e-12);
  assert.equal(sc.weeklyAtr.ceShort, 110); assert.equal(sc.weeklyAtr.peShort, 90);
  const capped = run({ account: { capital: 100000, maxLossPct: 0.05, riskSigma: 2 } });
  assert.equal(capped.status, 'NO_ACCEPTABLE_STRUCTURE'); assert.ok(capped.errors[0].includes('RISK LIMIT'));
  const c = chain(100, 0.6).map(q => (q.type === 'call' && q.strike === 107.5 ? { ...q, openInterest: 1 } : q));
  const moved = run({}, {}, { contracts: c });
  assert.equal(moved.weeklyAtr.ceSnapped, 107.5); assert.notEqual(moved.weeklyAtr.ceShort, 107.5); assert.ok(moved.weeklyAtr.ceMoved);
  assert.ok(moved.warnings.some(x => /fails the liquidity filters/.test(x)));
  assert.equal(run({}, { upperMult: 0 }).status, 'INVALID'); assert.equal(run({}, { atr: null }).status, 'INVALID');
});

test('server: weekly ATR source falls back from perp candles to stock daily OHLC; runs persist method, ATR, N and multipliers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-watr-'));
  process.env.QS_DB = path.join(dir, 't.db'); process.env.NODE_ENV = 'test'; delete process.env.DATABASE_URL;
  const hl = require('../server/hl'), strategy = require('../server/strategy');
  // 30 weeks of synthetic daily bars (Mon–Fri), range 2 every day + 1-point weekly drift
  const days = []; const mon0 = Date.parse(S.weekStartOf(new Date().toISOString().slice(0, 10)) + 'T00:00:00Z') - 30 * 7 * 864e5;
  for (let w = 0; w < 30; w++) for (let k = 0; k < 5; k++) { const t = mon0 + (w * 7 + k) * 864e5, c = 100 + w; days.push({ t, o: c, h: c + 1, l: c - 1, c }); }
  hl.candles = async () => { throw Error('HTTP 500'); };
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ data: { tradesTable: { rows: days.slice().reverse().map(x => { const d = new Date(x.t).toISOString().slice(0, 10).split('-'); return { date: d[1] + '/' + d[2] + '/' + d[0], open: '$' + x.o, high: '$' + x.h, low: '$' + x.l, close: '$' + x.c }; }) } } }) });
  try {
    const a = await strategy.weeklyAtrFor('TEST', perp(100), { n: 14, source: 'auto' });
    assert.equal(a.sourceKind, 'stock'); assert.match(a.source, /Nasdaq TEST daily OHLC/); assert.match(a.source, /Hyperliquid candles unavailable/);
    assert.ok(Math.abs(a.atr - 2) < 1e-9, String(a.atr)); // weekly H − L = 2 and |H − prevC| = 2 → ATR 2
    hl.candles = async () => days.map(x => ({ ...x, T: x.t + 864e5 - 1, v: 1 }));
    const b = await strategy.weeklyAtrFor('TEST2', perp(100), { n: 14, source: 'auto' });
    assert.equal(b.sourceKind, 'perp'); assert.match(b.source, /Hyperliquid xyz:TEST daily candles/);
  } finally { global.fetch = origFetch; }
  const o = run();
  const { id } = strategy.saveRun({ out: o, chain: { contracts: chain(100, 0.6), label: 'fixture', stock: { price: 100, source: 'fixture' } }, perp: perp(100), t: 'TEST', expiry: EXP, method: 'weekly_atr', cfg: { upperMult: 1, lowerMult: 1, atrPeriod: 14 }, market: null, source: 'builder' });
  assert.ok(id);
  const { db } = require('../server/db'), row = db.prepare('SELECT method, weekly_atr, inputs FROM strategy_runs WHERE id=?').get(id);
  assert.equal(row.method, 'weekly_atr');
  const w = JSON.parse(row.weekly_atr), inp = JSON.parse(row.inputs);
  assert.deepEqual([w.method, w.atr, w.n, w.upperMult, w.lowerMult, w.ceShort, w.peShort], ['weekly_atr', 6.3, 14, 1, 1, 107.5, 92.5]);
  assert.equal(inp.weeklyAtr.atr, 6.3); assert.equal(inp.cfg.atrPeriod, 14);
  assert.ok(strategy.exportAll().runs.some(r => r.method === 'weekly_atr' && r.weekly_atr)); // JSON backup carries it too
  // optimizer runs store the distance-band parameters and the chosen distances
  const opt = S.optimize({ nowMs: NOW, ticker: 'TEST', expiry: EXP, contracts: chain(100, 0.6), stock: { price: 100, source: 'fixture' }, perp: perp(100), cfg: { targetMode: 'fixed', targetPnl: 400 }, bandAtr: { atr: 9, source: 'fixture' }, market: { direction: 'LONG', score: 7, maxScore: 8, trend: 'UP', momentum: 'UP', rsi: 60 } });
  assert.equal(opt.status, 'OK', JSON.stringify(opt.errors));
  const r2 = strategy.saveRun({ out: opt, chain: { contracts: chain(100, 0.6), label: 'fixture', stock: { price: 100, source: 'fixture' } }, perp: perp(100), t: 'TEST', expiry: EXP, method: 'optimizer', cfg: { minShortSigma: 1, minShortAtr: 1, maxShortSigma: 2.5 }, market: null, source: 'builder' });
  const db2 = db.prepare('SELECT distance_band, inputs FROM strategy_runs WHERE id=?').get(r2.id), band = JSON.parse(db2.distance_band);
  assert.deepEqual([band.band.minShortSigma, band.band.minShortAtr, band.band.maxShortSigma, band.band.weeklyAtr], [1, 1, 2.5, 9]);
  assert.equal(band.chosen.ce.strike, opt.best.exits[0].price); assert.ok(band.pairs.length >= 1);
  assert.ok(JSON.parse(db2.inputs).distanceBand.band.minDist >= 9);
});
