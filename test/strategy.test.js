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
    const out = Strategy.buildReferenceOne({ ticker: 'TEST', expiry: EXP, nowMs: NOW, contracts: chain(100, 0.6), stock: { price: 100, source: 'fixture' }, perp: perp(100), cfg: { futuresSide: side, targetPnl: 500, capital: side === 'LONG' ? 200000 : 50000 } });
    assert.equal(out.status, 'OK', JSON.stringify(out.errors));
    const b = out.best, debit = side === 'SHORT' ? 'call' : 'put';
    const d = b.legs.filter(l => l.type === debit), callQ = b.legs.find(l => l.type === 'call').qty, putQ = b.legs.find(l => l.type === 'put').qty;
    assert.equal(putQ, 2 * callQ, 'owner rule: calls 1 lot : puts 2 lots'); assert.equal(b.lotRule, '1:2');
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
  const out = Strategy.buildReference({ ticker: 'TEST', expiry: EXP, nowMs: NOW, contracts: chain(100, 0.6), stock: { price: 100 }, perp: { ...perp(100), szDecimals: 6, bid: 100, ask: 100 }, cfg: { futuresSide: 'SHORT', targetPnl: 300, capital: 50000, futuresRound: 1e-6, commission: 0, futureFeePct: 0 } });
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

const ruleBase = (cfg, extra = {}) => Strategy.buildReference({ ticker: 'TEST', expiry: EXP, nowMs: NOW, contracts: chain(100, 0.6), stock: { price: 100, source: 'fixture' }, perp: perp(100), cfg: { targetPnl: 500, capital: 200000, ...cfg }, ...extra });

test('owner rules: signal sets the perp side (bullish → LONG, bearish → SHORT), options hedge the other way', () => {
  const bull = ruleBase({ signal: 'BULLISH' }), bear = ruleBase({ signal: 'BEARISH' });
  assert.equal(bull.status, 'OK'); assert.equal(bear.status, 'OK');
  assert.equal(bull.best.futuresSide, 'LONG'); assert.ok(bull.best.futures.signedQty > 0); assert.equal(bull.best.signal, 'BULLISH');
  assert.equal(bear.best.futuresSide, 'SHORT'); assert.ok(bear.best.futures.signedQty < 0);
  // bullish signal → bearish option hedge: put debit (long put above short put) + call credit (short call below long call)
  const lp = bull.best.legs.find(l => l.type === 'put' && l.side === 'buy'), sp = bull.best.legs.find(l => l.type === 'put' && l.side === 'sell');
  assert.ok(lp.strike > sp.strike);
  assert.equal(Strategy.buildReferenceOne({ ticker: 'TEST', expiry: EXP, nowMs: NOW, contracts: chain(100, 0.6), stock: { price: 100, source: 'fixture' }, perp: perp(100), cfg: { targetPnl: 500, capital: 200000, signal: 'SIDEWAYS' } }).status, 'INVALID');
});

test('owner rules: futures qty rounded DOWN to a multiple of 5', () => {
  for (const signal of ['BULLISH', 'BEARISH']) {
    const f = ruleBase({ signal }).best.futures;
    assert.equal(Math.abs(f.signedQty) % 5, 0);
    assert.ok(Math.abs(f.signedQty) <= Math.abs(f.equalisingQty) && Math.abs(f.equalisingQty) - Math.abs(f.signedQty) < 5);
    assert.equal(f.roundTo, 5);
  }
  const f10 = ruleBase({ signal: 'BEARISH', futuresRound: 10 }).best.futures; assert.equal(Math.abs(f10.signedQty) % 10, 0);
});

test('owner rules: 1 call lot : 2 put lots by default, overridable', () => {
  const b = ruleBase({ signal: 'BEARISH' }).best;
  assert.equal(b.putLots, 2 * b.callLots);
  for (const l of b.legs) assert.equal(l.qty, l.type === 'call' ? b.callLots : b.putLots);
  const o = ruleBase({ signal: 'BULLISH', callLotUnits: 2, putLotUnits: 1 }).best;
  assert.equal(o.callLots, 2 * o.putLots); assert.equal(o.lotRule, '2:1');
  assert.equal(ruleBase({ signal: 'BULLISH', callLotUnits: 0 }).status, 'INVALID');
});

test('owner rules: futures margin = FQ × entry / 2 (configurable), 5× leverage shown, total capital adds up', () => {
  const b = ruleBase({ signal: 'BEARISH' }).best, c = b.capital, n = b.futures.qty * b.futures.entry;
  assert.ok(Math.abs(c.futuresNotional - n) < 1e-9);
  assert.ok(Math.abs(c.futuresMargin - n / 2) < 1e-9); assert.equal(c.marginDivisor, 2); assert.equal(c.leverage, 5);
  assert.ok(Math.abs(c.venueInitialMargin - n / 5) < 1e-9);
  assert.ok(Math.abs(c.total - (c.futuresMargin + c.optionsCapital + c.fees)) < 1e-6); assert.equal(c.total, b.requiredCapital);
  const b4 = ruleBase({ signal: 'BEARISH', marginDivisor: 4 }).best;
  assert.ok(Math.abs(b4.capital.futuresMargin - b4.futures.qty * b4.futures.entry / 4) < 1e-9);
});

test('owner rules: exits at the CE short and PE short with P&L today and at expiry', () => {
  const b = ruleBase({ signal: 'BEARISH' }).best, shortCall = b.legs.find(l => l.type === 'call' && l.side === 'sell').strike, shortPut = b.legs.find(l => l.type === 'put' && l.side === 'sell').strike;
  assert.equal(b.exits.length, 2); assert.equal(b.exits[0].price, shortCall); assert.equal(b.exits[1].price, shortPut);
  assert.ok(Math.abs(b.exits[0].pnlExpiry - b.expected.upExpiry) < 1e-9 && Math.abs(b.exits[1].pnlExpiry - b.expected.downExpiry) < 1e-9);
  assert.ok(b.exits.every(x => Number.isFinite(x.pnlToday)));
});

test('owner rules: theta check classifies credit / near-neutral / debit', () => {
  const leg = (side, qty, theta) => ({ side, qty, multiplier: 100, greeks: { theta } });
  assert.equal(Strategy.thetaCheck([leg('sell', 1, -0.2), leg('buy', 1, -0.1)]).status, 'CREDIT');
  assert.equal(Strategy.thetaCheck([leg('sell', 1, -0.1), leg('buy', 1, -0.12)]).status, 'NEAR-NEUTRAL');
  const d = Strategy.thetaCheck([leg('sell', 1, -0.05), leg('buy', 1, -0.2)]); assert.equal(d.status, 'DEBIT'); assert.equal(d.ok, false);
  const b = ruleBase({ signal: 'BEARISH' }).best; assert.ok(['CREDIT', 'NEAR-NEUTRAL', 'DEBIT'].includes(b.theta.status));
});

test('perp / stock price mismatch blocks a recommendation', () => {
  const out = ruleBase({ signal: 'BEARISH' }, { perp: perp(130) });
  assert.equal(out.status, 'PRICE_MISMATCH'); assert.match(out.errors[0], /differs/);
});

test('expiry close is 16:00 America/New_York, DST-aware', () => {
  require('../public/finance.js');
  for (const fn of [Strategy.expiryCloseMs, globalThis.Finance.closeMs]) {
    assert.equal(new Date(fn('2026-10-30')).toISOString(), '2026-10-30T20:00:00.000Z'); // EDT
    assert.equal(new Date(fn('2026-11-06')).toISOString(), '2026-11-06T21:00:00.000Z'); // EST
    assert.equal(new Date(fn('2027-03-19')).toISOString(), '2027-03-19T20:00:00.000Z'); // EDT again
  }
});
