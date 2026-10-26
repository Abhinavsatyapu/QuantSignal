// Optimizer, what-if, sizing and plan maths. Chains are synthetic Black-Scholes fixtures (exercise the math only).
const test = require('node:test');
const assert = require('node:assert/strict');
require('../public/strategy-engine.js');
require('../public/strategy-optimizer.js');
const S = globalThis.Strategy;
// fixed time-to-expiry (4.7 days) so the fixtures do not depend on the wall-clock hour (the date-only expiry used to make T vary by up to a day)
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
const WIDE = { selection: 'band', minShortSigma: null, maxShortSigma: 2.5, sheetBandHigh: 2 }; // band selection (no two-stage rerun), sheet band only, wider: the flat-IV fixture needs farther shorts for $150 per lot set
const run = (cfg = {}, extra = {}) => S.optimize({ nowMs: NOW, ticker: 'TEST', expiry: EXP, contracts: chain(100, 0.6), stock: { price: 100, source: 'fixture' }, perp: perp(100), cfg: { targetMode: 'fixed', targetPnl: 400, ...cfg }, market: { direction: 'LONG', score: 7, maxScore: 8, trend: 'UP', momentum: 'UP', rsi: 60 }, ...extra });

test('decideDirection: signal, lean and override', () => {
  assert.deepEqual(S.decideDirection({ direction: 'LONG', score: 7, maxScore: 8, trend: 'UP', momentum: 'UP', rsi: 60 }).sides, ['LONG']);
  assert.deepEqual(S.decideDirection({ direction: 'SHORT', score: 7, maxScore: 8, trend: 'DOWN', momentum: 'DOWN', rsi: 40 }).sides, ['SHORT']);
  assert.deepEqual(S.decideDirection({ direction: 'WAIT', score: 3, maxScore: 8, trend: 'UP', momentum: 'UP', rsi: 60 }).sides, ['LONG']);
  // neutral lean (0/3) → the EMA trend decides, and the note says so
  const nt = S.decideDirection({ direction: 'WAIT', score: 3, maxScore: 8, trend: 'DOWN', momentum: 'UP', rsi: 50, ema20: 93.84, ema50: 94.25 });
  assert.deepEqual(nt.sides, ['SHORT']); assert.equal(nt.source, 'trend-neutral'); assert.match(nt.reason, /EMA trend decides: EMA20 93.84 below EMA50 94.25 \(trend DOWN\) → SHORT/);
  assert.deepEqual(S.decideDirection({ direction: 'WAIT', score: 3, maxScore: 8, trend: 'UP', momentum: 'DOWN', rsi: 50 }).sides, ['LONG']);
  assert.equal(S.decideDirection({ direction: 'WAIT', score: 3, maxScore: 8, trend: 'FLAT', momentum: 'FLAT', rsi: 50 }).sides.length, 2); // no trend at all → both sides
  assert.deepEqual(S.decideDirection({ direction: 'LONG' }, 'BEARISH').sides, ['SHORT']);
});

test('optimize: OK, perp floored to 5, both variants compared, target met at both exits, residual reported', () => {
  const o = run();
  assert.equal(o.status, 'OK', JSON.stringify(o.errors));
  const b = o.best;
  assert.equal(Math.abs(b.futures.signedQty) % 5, 0);
  assert.ok(Math.abs(b.futures.signedQty) <= Math.abs(b.futures.equalisingQty) + 1e-9);
  assert.ok(b.exits[0].pnlExpiry >= 400 && b.exits[1].pnlExpiry >= 400);
  assert.ok(Math.abs(b.residual.up - (b.exits[0].pnlExpiry - 400)) < 1e-9);
  assert.deepEqual(new Set(o.variants.map(v => v.key)), new Set(['1C:2P', '2C:1P']));
  assert.ok(o.considered.length > 0 && o.considered.every(c => typeof c.score === 'number' || c.score === null));
  assert.ok(o.recommendation.reason.includes('P(profit)'));
});

test('optimize: per-lot-set target scales with the lots (lot sets fixed, target = per-lot × lot sets)', () => {
  // wider sheet band: the flat-IV fixture needs farther shorts to pay $150 per lot set (this test is about lot scaling)
  const one = run({ targetMode: 'perLotSet', targetPerLotSet: 150, lotSets: 1, ...WIDE }), two = run({ targetMode: 'perLotSet', targetPerLotSet: 150, lotSets: 2, ...WIDE });
  assert.equal(one.status, 'OK', JSON.stringify(one.errors)); assert.equal(two.status, 'OK', JSON.stringify(two.errors));
  assert.equal(one.best.lotSets, 1); assert.equal(two.best.lotSets, 2);
  assert.equal(one.cfg.targetPnl, 150); assert.equal(two.cfg.targetPnl, 300);
  assert.ok(two.best.perLotSet.up >= 150 && two.best.perLotSet.down >= 150);
});

test('optimize: refuses an illiquid chain and falls back to a stock hedge without a perp', () => {
  const thin = S.optimize({ nowMs: NOW, ticker: 'TEST', expiry: EXP, contracts: chain(100, 0.6, { oi: 1 }), stock: { price: 100, source: 'fixture' }, perp: perp(100), cfg: { targetMode: 'fixed', targetPnl: 400 } });
  assert.notEqual(thin.status, 'OK');
  const st = run({}, { perp: { available: false, reason: 'no perp' } });
  assert.equal(st.hedgeType, 'STOCK'); assert.ok(st.warnings.some(w => /stock/i.test(w)));
  const gap = run({}, { perp: perp(110) });
  assert.notEqual(gap.status, 'OK'); // 10% perp/stock gap is refused
});

test('what-if: expiry column equals a hand payoff, IV shock 0 equals the base, flat path starts at P&L today', () => {
  const o = run(), b = o.best, w = b.whatIf, mm = o.cfg.mmLoss;
  const hand = (x) => b.legs.reduce((m, l) => m + (l.side === 'buy' ? 1 : -1) * l.qty * 100 * (Math.max(l.type === 'call' ? x - l.strike : l.strike - x, 0) - l.premium), 0)
    + b.futures.signedQty * ((x + (o.basis || 0)) - b.futures.entry);
  const ex = w.dates.length - 1, fees = b.fees.options + b.fees.futuresEntry;
  for (const p of w.priceGrid) {
    const exitFee = Math.abs(b.futures.signedQty) * (p.stock + (o.basis || 0)) * o.cfg.futureFeePct / 100;
    assert.ok(Math.abs(p.pnl[ex] - (hand(p.stock) - fees - exitFee - mm)) < 0.5, p.label + ' ' + p.pnl[ex] + ' vs ' + (hand(p.stock) - fees - exitFee - mm));
  }
  const z = w.ivGrid.shocks.indexOf(0);
  w.ivGrid.moves.forEach((m, i) => assert.ok(Math.abs(w.ivGrid.today[i][z] - w.priceGrid.find(p => p.kind === 'move' && Math.abs(p.pct - m) < 1e-9).pnl[0]) < 1e-6));
  assert.ok(Math.abs(w.theta.flatPath[0].pnl - w.priceGrid.find(p => p.kind === 'move' && p.pct === 0).pnl[0]) < 1e-6);
});

test('what-if: finish-above probability matches the closed-form lognormal; EV of a pure long hedge is the forward drift', () => {
  const o = run(), b = o.best, w = b.whatIf, T = Math.max(1e-6, (Date.parse(o.expiryCloseUtc) - NOW) / (365 * 864e5)), sig = o.atmIV, r = o.cfg.r;
  const N = (x) => 0.5 * (1 + erf(x / Math.SQRT2)), erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
  const d2 = (Math.log(o.spot / b.exits[0].price) + (r - sig * sig / 2) * T) / (sig * Math.sqrt(T));
  assert.ok(Math.abs(w.probs.finishAboveCE - N(d2)) < 0.01, w.probs.finishAboveCE + ' vs ' + N(d2));
  // combine() of a pure long 100-share position: EV = 100 × S × (e^{rT} − 1) (Monte Carlo, ±3 s.e.)
  const T2 = 5 / 365, c = S.combine([{ spot: 100, atmIV: 0.3, T: T2, pnl: (x) => 100 * (x - 100), riskLoss: 0, capital: 0 }], [[1]], { sims: 40000 });
  const se = 100 * 100 * 0.3 * Math.sqrt(T2) / Math.sqrt(40000);
  assert.ok(Math.abs(c.expectedValue - 10000 * (Math.exp(0.04 * T2) - 1)) < 3 * se, c.expectedValue);
  assert.ok(Math.abs(c.probProfit - 0.5) < 0.02);
});

test('account risk limits reject candidates that hit the target but breach the caps', () => {
  const o = run({ account: { capital: 100000, maxLossPct: 0.01, maxDeployPct: 60 } });
  assert.equal(o.status, 'NO_ACCEPTABLE_STRUCTURE');
  assert.ok(o.errors[0].includes('RISK LIMIT'));
});

test('rescale: legs × k, perp re-equalised and floored to 5, target × k, and the size check flags thin open interest', () => {
  const o = run({ targetMode: 'perLotSet', targetPerLotSet: 150, lotSets: 1, ...WIDE }), b = o.best;
  const r3 = S.rescale(o, b, 3);
  r3.legs.forEach((l, i) => assert.equal(l.qty, b.legs[i].qty * 3));
  assert.equal(Math.abs(r3.perpQty) % 5, 0); assert.ok(Math.abs(r3.perpQty) <= Math.abs(b.futures.equalisingQty * 3) + 1e-9 && Math.abs(b.futures.equalisingQty * 3) - Math.abs(r3.perpQty) < 5);
  assert.equal(r3.target, 450);
  const r1 = S.rescale(o, b, 1); assert.ok(Math.abs(r1.exits.up - b.exits[0].pnlExpiry) < 1);
  const thin = S.sizeCheck([{ side: 'sell', qty: 30, type: 'call', strike: 105, openInterest: 40, volume: 5, bidSize: 10 }]);
  assert.equal(thin.ok, false); assert.equal(thin.blocking.length, 1); assert.ok(thin.flags.length >= 3);
});

test('cholesky reproduces the correlation matrix', () => {
  const m = [[1, 0.5, 0.2], [0.5, 1, 0.3], [0.2, 0.3, 1]], L = S.cholesky(m);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let v = 0; for (let k = 0; k < 3; k++) v += L[i][k] * L[j][k]; assert.ok(Math.abs(v - m[i][j]) < 1e-12); }
});

// ---- short-strike band anchored to the reference sheets (per ticker / ratio / side), with optional σ / weekly-ATR floors
const ANCHOR = { source: 'fixture sheets', groups: {
  credit2: { n: 8, source: 'TEST sheets, credit 2× debit lots (8 rows)', debitLongSigma: 0.09, debitShortSigma: 0.79, creditShortSigma: 0.61, wingSigma: 0.33, debitShortPct: 6.7, creditShortPct: 5.4, debitShortAtr: 0.53, creditShortAtr: 0.42 },
  credit05: { n: 7, source: 'pooled sheets, credit ½× debit lots (7 rows)', debitLongSigma: 0.17, debitShortSigma: 0.99, creditShortSigma: 0.76, wingSigma: 0.51 } } };
const SHEET = { selection: 'band', minShortSigma: null, maxShortSigma: 2.5 }; // legacy band search, middle zone off → the 0.8–1.3× sheet band alone
const sheetRun = (cfg = {}, extra = {}) => run({ ...SHEET, ...cfg }, { bandAtr: { atr: 9, source: 'fixture' }, sheetAnchor: ANCHOR, ...extra });
const inB = (x, B) => x >= B.loSigmas - 1e-9 && x <= B.hiSigmas + 1e-9;
test('sheet band: each short searched within 0.8–1.3× its sheet distance (per ratio and side); rules, both ratios and sheet deviation reported', () => {
  const o = sheetRun(), b = o.distanceBand, sigma = o.expectedMove;
  assert.equal(o.status, 'OK', JSON.stringify(o.errors)); assert.equal(b.mode, 'sheet'); assert.equal(o.weights.reference, 1.5);
  assert.equal(b.minShortSigma, null); assert.equal(b.minShortAtr, null); // zone / floors off in this run
  // LONG hedge: CE short = credit-spread short, PE short = debit-spread short. 2C:1P (credit calls 2×) → credit2 group; 1C:2P → credit05
  const v2 = b.variants.find(v => v.variant === '2C:1P'), v1 = b.variants.find(v => v.variant === '1C:2P');
  assert.equal(v2.group, 'credit2'); assert.equal(v1.group, 'credit05');
  assert.ok(Math.abs(v2.ce.loSigmas - 0.8 * 0.61) < 1e-9 && Math.abs(v2.ce.hiSigmas - 1.3 * 0.61) < 1e-9 && Math.abs(v2.pe.loSigmas - 0.8 * 0.79) < 1e-9 && Math.abs(v2.pe.hiSigmas - 1.3 * 0.79) < 1e-9);
  assert.ok(Math.abs(v1.ce.sheetSigmas - 0.76) < 1e-9 && Math.abs(v1.pe.sheetSigmas - 0.99) < 1e-9);
  assert.equal(v2.sheet.ce.role, 'credit short'); assert.equal(v2.sheet.ce.pctSheets, 5.4); assert.equal(v2.sheet.pe.atrSheets, 0.53);
  for (const v of o.variants.filter(x => x.reachable)) {
    const e = b.variants.find(x => x.variant === v.key), d = v.distances;
    if (!e.fallback) { assert.ok(inB(d.ce.sigmas, e.ce), v.id + ' CE in band'); assert.ok(inB(-d.pe.sigmas, e.pe), v.id + ' PE in band'); }
    assert.ok(Math.abs(d.ce.sheet.sigmas - e.ce.sheetSigmas) < 1e-9 && Math.abs(d.pe.sheet.sigmas + e.pe.sheetSigmas) < 1e-9);
    assert.ok(Math.abs(d.ce.deviation.ratio - d.ce.sigmas / e.ce.sheetSigmas) < 1e-9); assert.ok(Math.abs(d.ce.atrs - d.ce.dollars / 9) < 1e-9);
    assert.ok(Math.abs(d.ce.sheet.dollars - e.ce.sheetSigmas * sigma) < 1e-9);
  }
  // the reference factor measures distance to THIS ratio's sheet geometry
  const bs = o.best.sigmas, g = o.best.sheetAnchor; assert.ok(Math.abs(o.best.factors.reference.value - (Math.abs(bs.debitShort - g.debitShortSigma) + Math.abs(bs.creditShort - g.creditShortSigma) + Math.abs(bs.wing - g.wingSigma)) / 3) < 2e-3);
  assert.ok(o.distancePairs.length >= 1 && o.distancePairs.length <= 12 && o.pairsTested >= o.distancePairs.length && o.distancePairs.filter(p => p.chosen).length === 1 && o.distancePairs.every(p => p.ce.sheet && p.pe.sheet));
  for (const k of ['exitFit', 'ev', 'pop', 'reference']) assert.ok(k in o.best.factors, k);
  assert.equal(Math.abs(o.best.futures.signedQty) % 5, 0); assert.ok(Math.abs(o.best.capital.futuresMargin - Math.abs(o.best.futures.signedQty) * o.best.futures.entry / 2) < 1e-6);
  assert.deepEqual(new Set(o.variants.map(v => v.key)), new Set(['1C:2P', '2C:1P']));
  // narrower than the earlier fixed 1σ / 1× ATR floor: the chosen shorts sit near the sheet distances, not ≥ 1σ out
  assert.ok(Math.abs(o.best.distances.ce.sigmas) < 1.3 && Math.abs(o.best.distances.pe.sigmas) < 1.3);
  // without a server anchor the pooled built-in medians are used
  const p = run(SHEET); assert.equal(p.distanceBand.anchorSource, 'built-in pooled reference-sheet medians'); assert.ok(Math.abs(p.distanceBand.variants[0].ce.sheetSigmas - 0.63) < 1e-9);
});
test('sheet band: optional σ / weekly-ATR floors (blank = off), max σ ceiling, asymmetric pairs, validation', () => {
  const f = sheetRun({ minShortSigma: 1 }); for (const v of f.distanceBand.variants) { assert.ok(v.ce.loSigmas >= 1 - 1e-9 && v.pe.loSigmas >= 1 - 1e-9); assert.equal(v.ce.binding, 'middle zone'); assert.ok(v.ce.hiSigmas > v.ce.loSigmas); }
  const a = sheetRun({ minShortAtr: 1 }), sig = a.expectedMove; for (const v of a.distanceBand.variants) assert.ok(v.ce.loSigmas >= 9 / sig - 1e-9);
  const off = sheetRun({ minShortSigma: '', minShortAtr: null }); assert.equal(off.distanceBand.minShortSigma, null); assert.equal(off.distanceBand.minShortAtr, null);
  const cap = sheetRun({ sheetBandHigh: 3, maxShortSigma: 0.9 }); for (const v of cap.distanceBand.variants) assert.ok(v.ce.hiSigmas <= 0.9 + 1e-9 && v.pe.hiSigmas <= 0.9 + 1e-9);
  const noAtr = run({ ...SHEET, minShortAtr: 1 }, { sheetAnchor: ANCHOR }); assert.equal(noAtr.distanceBand.weeklyAtr, null); assert.ok(noAtr.warnings.some(w => /Weekly ATR not supplied: the × weekly ATR floor is ignored/.test(w)));
  const wide = sheetRun({ sheetBandLow: 0.5, sheetBandHigh: 2 }); assert.equal(wide.status, 'OK', JSON.stringify(wide.errors));
  assert.ok(wide.considered.some(c => Math.abs(c.sig.ds - c.sig.cs) > 0.2), 'upper and lower distances vary independently');
  assert.equal(run({ sheetBandLow: 1.3, sheetBandHigh: 0.8 }).status, 'INVALID'); assert.equal(run({ sheetBandHigh: 4 }).status, 'INVALID'); assert.equal(run({ minShortSigma: 2, maxShortSigma: 1 }).status, 'INVALID');
});
test('sheet band: no liquid strike inside a band → nearest liquid strike used, and said so', () => {
  const o = sheetRun({ sheetBandLow: 1.0, sheetBandHigh: 1.01 }); // a 1%-wide band rarely contains a listed strike on a 2.5-wide grid
  assert.ok(o.distanceBand.fallback.length > 0); assert.ok(o.warnings.some(w => /No liquid .* inside the sheet band .* using the nearest liquid/.test(w)));
  assert.ok(o.distanceBand.variants.some(v => v.fallback));
});

test('legacy band selection, middle zone (0.7–1.2σ): both shorts searched in the zone, sheet anchor clamped into it, chosen shorts inside', () => {
  const o = run({ selection: 'band', minShortSigma: 0.7, maxShortSigma: 1.2 }, { bandAtr: { atr: 9, source: 'fixture' }, sheetAnchor: ANCHOR }), b = o.distanceBand;
  assert.equal(o.status, 'OK', JSON.stringify(o.errors)); assert.equal(b.mode, 'middle zone + sheet anchor'); assert.deepEqual([b.minShortSigma, b.maxShortSigma], [0.7, 1.2]);
  for (const v of b.variants) for (const k of ['ce', 'pe']) {
    assert.ok(Math.abs(v[k].loSigmas - 0.7) < 1e-9 && Math.abs(v[k].hiSigmas - 1.2) < 1e-9, v.variant + k);
    assert.ok(v[k].sheetSigmas >= 0.7 - 1e-9 && v[k].sheetSigmas <= 1.2 + 1e-9);
  }
  const v2 = b.variants.find(v => v.variant === '2C:1P'); // LONG 2C:1P: CE = credit short 0.61σ, PE = debit short 0.79σ → both anchored at the zone midpoint 0.95σ
  assert.equal(v2.rawSheet.creditShortSigma, 0.61); assert.ok(v2.ce.clampedToZone && Math.abs(v2.ce.sheetSigmas - 0.95) < 1e-9 && Math.abs(v2.pe.sheetSigmas - 0.95) < 1e-9);
  const wideSheet = run({ selection: 'band', minShortSigma: 0.7, maxShortSigma: 1.2 }, { sheetAnchor: { groups: { credit2: { ...ANCHOR.groups.credit2, debitShortSigma: 1.1, creditShortSigma: 1.6 } } } }).distanceBand.variants.find(v => v.variant === '2C:1P');
  assert.ok(Math.abs(wideSheet.pe.sheetSigmas - 1.1) < 1e-9 && Math.abs(wideSheet.ce.sheetSigmas - 1.2) < 1e-9); // wider sheets kept, clamped to the 1.2σ ceiling
  for (const v of o.variants.filter(x => x.reachable)) { const e = b.variants.find(x => x.variant === v.key); if (e.fallback) continue;
    assert.ok(v.distances.ce.sigmas >= 0.7 - 1e-9 && v.distances.ce.sigmas <= 1.2 + 1e-9, v.id + ' CE ' + v.distances.ce.sigmas); assert.ok(-v.distances.pe.sigmas >= 0.7 - 1e-9 && -v.distances.pe.sigmas <= 1.2 + 1e-9, v.id + ' PE'); }
  assert.ok(Math.abs(o.best.distances.ce.sheet.sigmas) >= 0.7 - 1e-9); // the deviation is measured against the clamped anchor
  assert.equal(o.weights.shortAnchor, 8); const bs = o.best.sigmas, ga = o.best.sheetAnchor; assert.ok(Math.abs(o.best.factors.shortAnchor.value - (Math.abs(bs.debitShort - ga.debitShortSigma) + Math.abs(bs.creditShort - ga.creditShortSigma)) / 2) < 2e-3);
});
