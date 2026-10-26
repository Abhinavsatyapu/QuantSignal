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
const run = (cfg = {}, extra = {}) => S.optimize({ nowMs: NOW, ticker: 'TEST', expiry: EXP, contracts: chain(100, 0.6), stock: { price: 100, source: 'fixture' }, perp: perp(100), cfg: { targetMode: 'fixed', targetPnl: 400, ...cfg }, market: { direction: 'LONG', score: 7, maxScore: 8, trend: 'UP', momentum: 'UP', rsi: 60 }, ...extra });

test('decideDirection: signal, lean and override', () => {
  assert.deepEqual(S.decideDirection({ direction: 'LONG', score: 7, maxScore: 8, trend: 'UP', momentum: 'UP', rsi: 60 }).sides, ['LONG']);
  assert.deepEqual(S.decideDirection({ direction: 'SHORT', score: 7, maxScore: 8, trend: 'DOWN', momentum: 'DOWN', rsi: 40 }).sides, ['SHORT']);
  assert.deepEqual(S.decideDirection({ direction: 'WAIT', score: 3, maxScore: 8, trend: 'UP', momentum: 'UP', rsi: 60 }).sides, ['LONG']);
  assert.equal(S.decideDirection({ direction: 'WAIT', score: 3, maxScore: 8, trend: 'UP', momentum: 'DOWN', rsi: 50 }).sides.length, 2);
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
  const one = run({ targetMode: 'perLotSet', targetPerLotSet: 150, lotSets: 1 }), two = run({ targetMode: 'perLotSet', targetPerLotSet: 150, lotSets: 2 });
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
  const o = run({ targetMode: 'perLotSet', targetPerLotSet: 150, lotSets: 1 }), b = o.best;
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
