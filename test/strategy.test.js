// Strategy engine tests. Chains here are synthetic Black-Scholes fixtures used only to exercise the math (never shown to users).
const test = require('node:test');
const assert = require('node:assert/strict');
require('../public/strategy-engine.js');
const { Strategy } = globalThis;

const NOW = Date.parse('2026-10-26T14:30:00Z'), EXP = '2026-10-30';
function chain(S, iv, { spreadPct = 2, strikes = null, step = 2.5 } = {}) {
  const T = (Strategy.expiryCloseMs(EXP) - NOW) / (365 * 864e5), out = [];
  const ks = strikes || Array.from({ length: 41 }, (_, i) => Math.round((S - 20 * step + i * step) / step) * step);
  for (const K of ks) for (const type of ['call', 'put']) {
    const mid = Strategy.bs(S, K, T, iv, 0.04, type), g = Strategy.bsGreeks(S, K, T, iv, 0.04, type), half = Math.max(0.01, mid * spreadPct / 200);
    out.push({ symbol: `TEST${EXP.replace(/-/g, '').slice(2)}${type[0].toUpperCase()}${String(K * 1000).padStart(8, '0')}`, type, strike: K, expiry: EXP, multiplier: 100, bid: Math.max(0, +(mid - half).toFixed(2)), ask: +(mid + half).toFixed(2), iv, greeks: g, quoteTime: new Date(NOW).toISOString(), bidSize: 50, askSize: 50, provider: 'fixture' });
  }
  return out;
}
const perp = (S) => ({ available: true, symbol: 'xyz:TEST', bid: S - 0.01, ask: S + 0.01, mid: S, szDecimals: 2, maxLeverage: 10 });

test('evaluate: expiry payoff equals a hand calculation (INTC reference sheet, page 10)', () => {
  // buy 5 × 120C @1.8, sell 5 × 125C @0.7, sell 10 × 113P @0.95, buy 10 × 110P @0.4, short 200 perp @118
  const legs = [{ type: 'call', side: 'buy', strike: 120, qty: 5, premium: 1.8 }, { type: 'call', side: 'sell', strike: 125, qty: 5, premium: 0.7 }, { type: 'put', side: 'sell', strike: 113, qty: 10, premium: 0.95 }, { type: 'put', side: 'buy', strike: 110, qty: 10, premium: 0.4 }];
  const ev = Strategy.evaluate({ legs, future: { qty: -200, entry: 118, basis: 0 }, nowMs: NOW, expiryMs: Strategy.expiryCloseMs(EXP) });
  // sheet: options +2500 / 0 and futures −1400 / +1000 at 125 / 113 → 1100 / 1000 before the 50 MM allowance (printed 1050 / 950)
  assert.equal(Math.round(ev.expiry(125)), 1100);
  assert.equal(Math.round(ev.expiry(113)), 1000);
  const hand = S => 500 * Math.max(S - 120, 0) - 500 * Math.max(S - 125, 0) - 1000 * Math.max(113 - S, 0) + 1000 * Math.max(110 - S, 0) + (-500 * 1.8 + 500 * 0.7 + 1000 * 0.95 - 1000 * 0.4) - 200 * (S - 118);
  for (const S of [90, 105, 110, 111.5, 113, 116, 118, 121, 125, 130, 150]) assert.ok(Math.abs(ev.expiry(S) - hand(S)) < 1e-6, 'S=' + S);
  for (const be of ev.breakevens) assert.ok(Math.abs(ev.expiry(be)) < 0.01); // breakevens are rounded to 1e-6
  assert.equal(ev.unlimitedLoss, true); // short perp: loss keeps growing above every strike (call spread is capped)
});

test('evaluate: greeks, capital and tails', () => {
  const legs = [{ type: 'call', side: 'buy', strike: 100, qty: 1, premium: 2, greeks: { delta: 0.5, gamma: 0.05, theta: -0.1, vega: 0.1 } }, { type: 'call', side: 'sell', strike: 105, qty: 1, premium: 0.5, greeks: { delta: 0.2, gamma: 0.03, theta: -0.05, vega: 0.06 } }];
  const ev = Strategy.evaluate({ legs, future: { qty: -10, entry: 100, basis: 0 }, nowMs: NOW, expiryMs: Strategy.expiryCloseMs(EXP), leverage: 5 });
  assert.ok(Math.abs(ev.greeks.optionDelta - 30) < 1e-9); assert.ok(Math.abs(ev.greeks.delta - 20) < 1e-9);
  assert.ok(Math.abs(ev.greeks.gamma - 2) < 1e-9); assert.ok(Math.abs(ev.greeks.theta - -5) < 1e-9);
  assert.equal(ev.optionsCapital, 150); assert.equal(ev.futuresMargin, 200);
  assert.equal(ev.unlimitedLoss, true); assert.equal(ev.maxLoss, null);
});

test('buildReference: structure follows the reference rules and reaches the target', () => {
  for (const side of ['SHORT', 'LONG']) {
    const out = Strategy.buildReference({ ticker: 'TEST', expiry: EXP, nowMs: NOW, contracts: chain(100, 0.6), stock: { price: 100, source: 'fixture' }, perp: perp(100), cfg: { futuresSide: side, targetPnl: 500, capital: 50000 } });
    assert.equal(out.status, 'OK', JSON.stringify(out.errors));
    const b = out.best, debit = side === 'SHORT' ? 'call' : 'put', credit = side === 'SHORT' ? 'put' : 'call';
    const d = b.legs.filter(l => l.type === debit), c = b.legs.filter(l => l.type === credit);
    assert.equal(c[0].qty, 2 * d[0].qty, 'credit lots = 2 × debit lots');
    const dLong = d.find(l => l.side === 'buy');
    assert.ok(Math.abs(dLong.strike - 100) <= 2.5, 'debit long leg nearest the money');
    assert.equal(Math.sign(b.futures.signedQty), side === 'SHORT' ? -1 : 1);
    assert.ok(b.expected.upExpiry >= 500 && b.expected.downExpiry >= 500);
    // the rounded perp is ≤ the equalising quantity
    assert.ok(Math.abs(b.futures.signedQty) <= Math.abs(b.futures.equalisingQty) + 1e-9);
    // scenario prices are the two short strikes
    const shorts = b.legs.filter(l => l.side === 'sell').map(l => l.strike).sort((x, y) => x - y);
    assert.deepEqual([b.scenarioPrices.down, b.scenarioPrices.up], shorts);
    // net credit/debit and curve consistency
    assert.ok(Math.abs(b.netCreditDebit - b.legs.reduce((n, l) => n + l.cashFlow, 0)) < 1e-6);
  }
});

test('buildReference: equalisation makes 1-day P&L equal at both short strikes when factor = 1', () => {
  const out = Strategy.buildReference({ ticker: 'TEST', expiry: EXP, nowMs: NOW, contracts: chain(100, 0.6), stock: { price: 100 }, perp: { ...perp(100), szDecimals: 6, bid: 100, ask: 100 }, cfg: { futuresSide: 'SHORT', targetPnl: 300, capital: 50000, futuresFactor: 1, commission: 0, futureFeePct: 0 } });
  assert.equal(out.status, 'OK');
  assert.ok(Math.abs(out.best.expected.upToday - out.best.expected.downToday) < 1, `${out.best.expected.upToday} vs ${out.best.expected.downToday}`);
});

test('buildReference: validation, no perp, no liquidity, unreachable target', () => {
  const base = { ticker: 'TEST', expiry: EXP, nowMs: NOW, stock: { price: 100 }, perp: perp(100) };
  assert.equal(Strategy.buildReference({ ...base, contracts: chain(100, 0.6), cfg: { futuresSide: 'LONG', targetPnl: -1, capital: 1000 } }).status, 'INVALID');
  assert.equal(Strategy.buildReference({ ...base, perp: { available: false, reason: 'none' }, contracts: chain(100, 0.6), cfg: { futuresSide: 'LONG', targetPnl: 100, capital: 1000 } }).status, 'NO_PERP');
  const wide = Strategy.buildReference({ ...base, contracts: chain(100, 0.6, { spreadPct: 80 }), cfg: { futuresSide: 'LONG', targetPnl: 100, capital: 50000 } });
  assert.equal(wide.status, 'NO_LIQUIDITY');
  const far = Strategy.buildReference({ ...base, contracts: chain(100, 0.6), cfg: { futuresSide: 'LONG', targetPnl: 1e6, capital: 5000 } });
  assert.equal(far.status, 'TARGET_NOT_REACHABLE'); assert.match(far.errors[0], /not reachable/);
  const past = Strategy.buildReference({ ...base, expiry: '2026-10-01', contracts: [], cfg: { futuresSide: 'LONG', targetPnl: 100, capital: 5000 } });
  assert.equal(past.status, 'INVALID');
});

test('classify: zero bid, crossed, wide and IV solved from mid', () => {
  const ctx = { spot: 100, T: 4 / 365, r: 0.04, maxSpreadPct: 25 };
  assert.equal(Strategy.classify({ type: 'call', strike: 100, bid: 0, ask: 1 }, ctx).ok, false);
  assert.equal(Strategy.classify({ type: 'call', strike: 100, bid: 2, ask: 1 }, ctx).ok, false);
  assert.equal(Strategy.classify({ type: 'call', strike: 100, bid: 1, ask: 2 }, ctx).ok, false);
  const k = Strategy.classify({ type: 'call', strike: 100, bid: 2.0, ask: 2.1 }, ctx);
  assert.equal(k.ok, true); assert.equal(k.q.ivSource, 'solved from mid');
  assert.ok(Math.abs(Strategy.bs(100, 100, ctx.T, k.q.iv, 0.04, 'call') - 2.05) < 1e-4);
});

test('alpacaOrderPreview builds an mleg payload with gcd quantity and ratio legs', () => {
  const p = Strategy.alpacaOrderPreview([{ contract: 'A', side: 'buy', qty: 5, premium: 1.8 }, { contract: 'B', side: 'sell', qty: 5, premium: 0.7 }, { contract: 'C', side: 'sell', qty: 10, premium: 0.95 }, { contract: 'D', side: 'buy', qty: 10, premium: 0.4 }]);
  assert.equal(p.order_class, 'mleg'); assert.equal(p.qty, '5'); assert.deepEqual(p.legs.map(l => l.ratio_qty), ['1', '1', '2', '2']);
  assert.equal(p.limit_price, '0.00'); // (1.8 − 0.7) − 2×(0.95 − 0.4) = 0
});
