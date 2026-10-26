// Liquidity & fill model: per-leg grades, market-fill cost, execution plan, and the "never recommend" gates
// (illiquid legs, negative EV after a market fill, too illiquid for the target) across Optimizer / Weekly ATR / Reference.
// Chains are synthetic Black-Scholes fixtures (exercise the math only).
const test = require('node:test');
const assert = require('node:assert/strict');
require('../public/strategy-engine.js');
require('../public/strategy-optimizer.js');
require('../public/strategy-weekly-atr.js');
const S = globalThis.Strategy;
const EXP = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10), NOW = S.expiryCloseMs(EXP) - 4.7 * 864e5;
// priceIv prices the options; quotedIv is the IV reported (and used by the EV). quotedIv < priceIv = options priced rich (real edge for a seller)
function chain(spot, priceIv, { quotedIv = priceIv, bad = () => false, oi = 500 } = {}) {
  const T = (S.expiryCloseMs(EXP) - NOW) / (365 * 864e5), out = [];
  for (let i = -20; i <= 20; i++) { const K = Math.round((spot + i * 2.5) / 2.5) * 2.5; for (const type of ['call', 'put']) {
    const mid = S.bs(spot, K, T, priceIv, 0.04, type), g = S.bsGreeks(spot, K, T, quotedIv, 0.04, type), b = bad(K, type), half = b ? Math.max(0.05, mid * 0.3) : Math.max(0.01, mid * 0.01);
    out.push({ symbol: 'T' + type[0] + K, type, strike: K, expiry: EXP, multiplier: 100, bid: Math.max(0, +(mid - half).toFixed(2)), ask: +(mid + half).toFixed(2), iv: quotedIv, greeks: g, quoteTime: new Date(NOW).toISOString(), bidSize: 50, askSize: 50, openInterest: b ? 20 : oi, volume: 100 });
  } }
  return out;
}
const perp = (x) => ({ available: true, symbol: 'xyz:TEST', bid: x - 0.01, ask: x + 0.01, mid: x, szDecimals: 2, maxLeverage: 10, funding: 0.00001 });
const opt = (contracts, cfg = {}, extra = {}) => S.optimize({ nowMs: NOW, ticker: 'TEST', expiry: EXP, contracts, stock: { price: 100, source: 'fixture' }, perp: perp(100), cfg: { targetMode: 'fixed', targetPnl: 400, ...cfg }, ...extra });

test('legLiquidity: Good / Thin / Illiquid from spread %, spread $, open interest, volume and a zero bid', () => {
  const g = (q) => S.legLiquidity({ strike: 100, ...q }, {}, 100);
  assert.equal(g({ bid: 2.0, ask: 2.06, openInterest: 900, volume: 200 }).grade, 'Good');
  assert.equal(g({ bid: 2.0, ask: 2.16, openInterest: 900, volume: 200 }).grade, 'Thin'); // 7.7% wide
  assert.equal(g({ bid: 2.0, ask: 2.06, openInterest: 300, volume: 200 }).grade, 'Thin'); // OI below 500
  assert.equal(g({ bid: 2.0, ask: 2.06, openInterest: 900, volume: 10 }).grade, 'Thin');  // volume below 50
  const zb = g({ bid: 0, ask: 0.1, openInterest: 900 }); assert.equal(zb.grade, 'Illiquid'); assert.equal(zb.zeroBid, true); assert.match(zb.why, /no bid/);
  assert.equal(g({ bid: 1.0, ask: 1.4, openInterest: 900, volume: 200 }).grade, 'Illiquid'); // 33% wide
  assert.equal(g({ bid: 2.0, ask: 2.06, openInterest: 40 }).grade, 'Illiquid');
  assert.equal(S.legLiquidity({ strike: 100, bid: 1.0, ask: 1.4, openInterest: 900 }, { liqIlliquidSpreadPct: 50 }, 100).grade, 'Thin'); // threshold is configurable
  assert.equal(S.roundStrike(150, 152), true); assert.equal(S.roundStrike(152.5, 152), false); assert.equal(S.roundStrike(37, 30), true);
});

test('fillAnalysis: market-fill cost = far side of every leg + perp half-spread; target / EV after slippage; verdicts', () => {
  // SPCX-like: +2 152.5C, −2 160C, +4 137P, −4 140P, −70 perp — premiums at mid (model charged nothing)
  const L = (side, qty, strike, type, bid, ask) => ({ side, qty, strike, type, bid, ask, mid: (bid + ask) / 2, premium: (bid + ask) / 2, openInterest: 50, volume: 5 });
  const legs = [L('buy', 2, 152.5, 'call', 3.0, 3.4), L('sell', 2, 160, 'call', 1.0, 1.4), L('buy', 4, 137, 'put', 0.8, 1.2), L('sell', 4, 140, 'put', 1.5, 1.9)];
  const f = S.fillAnalysis({ legs, hedge: { bid: 149.9, ask: 150.1, mid: 150 }, fq: -70, fEntry: 150, exits: [420, 450], target: 400, ev: 30, spot: 150 }, {});
  // options: each leg 0.20 half-spread × qty × 100 → 2·20 + 2·20 + 4·20 + 4·20 = 240; perp 70 × 0.10 = 7
  assert.ok(Math.abs(f.optionsMarket - 240) < 1e-6); assert.ok(Math.abs(f.perpMarket - 7) < 1e-6); assert.ok(Math.abs(f.marketSlippage - 247) < 1e-6);
  assert.ok(Math.abs(f.shareOfTarget - 247 / 400) < 1e-9); assert.equal(f.verdict, 'TOO_ILLIQUID'); assert.match(f.verdictText, /Too illiquid for this target/);
  assert.ok(Math.abs(f.targetAfterSlippage - (420 - 247)) < 1e-6); assert.ok(Math.abs(f.evAfterSlippage - (30 - 247)) < 1e-6);
  assert.equal(f.counts.Illiquid, 4); // OI 50 < 100
  // priced at natural already (Reference / Delta): nothing extra beyond what the model charged
  const nat = legs.map((l) => ({ ...l, premium: l.side === 'buy' ? l.ask : l.bid }));
  const g = S.fillAnalysis({ legs: nat, hedge: null, fq: 0, exits: [500], target: 400, ev: 10, spot: 150 }, {});
  assert.ok(Math.abs(g.modelCharged - 240) < 1e-6); assert.equal(g.extraVsModel, 0); assert.equal(g.targetAfterSlippage, 500); assert.equal(g.exitsAtLimit, 740);
  const why = S.recommendBlockers(f, {}); assert.equal(why.length, 3); assert.match(why[0], /expected value after a market fill is −\$217/);
  assert.equal(S.recommendBlockers(f, { requirePositiveEv: false, rejectIlliquidLegs: false, rejectTooIlliquid: false }).length, 0);
});

test('executionPlan: one combo at mid, steps toward natural, max net price that still pays the target; perp after the options', () => {
  const L = (side, qty, strike, type, bid, ask) => ({ side, qty, strike, type, bid, ask, mid: (bid + ask) / 2, premium: (bid + ask) / 2 });
  const legs = [L('buy', 2, 100, 'call', 2.0, 2.2), L('sell', 2, 105, 'call', 0.9, 1.0), L('sell', 4, 95, 'put', 1.0, 1.1), L('buy', 4, 92.5, 'put', 0.5, 0.6)];
  const fill = { exitsAtLimit: 500, perpMarket: 5, modelCharged: 0 };
  const p = S.executionPlan({ legs, fill, target: 400, hedge: { bid: 99.99, ask: 100.01, mid: 100, symbol: 'xyz:TEST' }, fq: 50, ticker: 'TEST' }, {});
  assert.equal(p.comboUnits, 2); assert.deepEqual(p.unitLegs.map((l) => l.ratio), [1, 1, 2, 2]);
  // per combo: +2.10 − 0.95 − 2·1.05 + 2·0.55 = 0.15 debit at mid; natural +2.2 − 0.9 − 2·1.0 + 2·0.6 = 0.5
  assert.ok(Math.abs(p.netMid - 0.15) < 1e-9); assert.ok(Math.abs(p.netNatural - 0.5) < 1e-9);
  // room = 500 − 5 − 400 = 95 → 95 / (2 × 100) = 0.475 per combo above mid
  assert.ok(Math.abs(p.maxNet - 0.625) < 1e-9); assert.equal(p.naturalWithinMax, true);
  assert.match(p.steps.join(' '), /ONE combo/); assert.match(p.steps.join(' '), /never leg in|do not leg in/); assert.match(p.steps.join(' '), /Only after the options combo has filled: BUY 50/);
  assert.match(p.note, /never sends orders to a broker/);
  const st = S.executionPlan({ legs, fill, target: 400, stale: 'Cboe delayed quotes, 9 h old' }, {}); assert.match(st.steps[0], /Re-run after the US open/);
});

test('optimizer gates: negative EV after a market fill is never recommended; a priced-rich chain passes with a liquid structure', () => {
  const flat = opt(chain(100, 0.6)); // fair-priced fixture: no edge, so every structure loses the spread on average
  assert.equal(flat.status, 'NO_ACCEPTABLE_STRUCTURE'); assert.equal(flat.liquidityVerdict.verdict, 'TOO_ILLIQUID');
  assert.match(flat.errors[0], /No liquid structure pays the \$400 target at natural \(market-fill\) prices .* positive expected value/);
  const rich = opt(chain(100, 0.6, { quotedIv: 0.45 }));
  assert.equal(rich.status, 'OK'); assert.ok(rich.best.fill.evAfterSlippage > 0); assert.equal(rich.best.fill.counts.Illiquid, 0);
  assert.equal(rich.liquidityVerdict.recommended, true); assert.ok(rich.execPlan && rich.execPlan.steps.length >= 4);
  assert.ok(rich.best.whatIf.liquidity && rich.best.whatIf.liquidity.evAfterSlippage > 0);
  // switching the gates off restores the old behaviour on the fair-priced fixture
  assert.equal(opt(chain(100, 0.6), { requirePositiveEv: false, rejectIlliquidLegs: false, rejectTooIlliquid: false }).status, 'OK');
});

test('optimizer: an illiquid rule strike moves to the nearest liquid strike, and illiquid legs never reach the pick', () => {
  const base = opt(chain(100, 0.6, { quotedIv: 0.45 })), legs = base.best.legs;
  const k = legs.find((l) => l.side === 'sell' && l.type === 'call').strike;
  const bad = (K, type) => type === 'call' && K === k;
  const out = opt(chain(100, 0.6, { quotedIv: 0.45, bad }));
  assert.equal(out.status, 'OK'); assert.ok(!out.best.legs.some((l) => l.type === 'call' && l.strike === k), 'illiquid strike avoided');
  assert.equal(out.best.fill.counts.Illiquid, 0);
  // either a leg was moved off the illiquid strike (and the move is explained) or a different structure won outright
  const moved = out.warnings.some((w) => /^Liquidity: .*is Illiquid.*→ moved to/.test(w)), sameShape = out.best.legs.map((l) => l.side + l.type).join() === legs.map((l) => l.side + l.type).join();
  assert.ok(moved || !sameShape || out.best.legs.some((l, i) => l.strike !== legs[i].strike));
});

test('weekly ATR method: same gates and fill model on by default', () => {
  const wa = { atr: 9, n: 14, source: 'fixture', upperMult: 0.42, lowerMult: 0.41, zoneMinSigma: 0.7, zoneMaxSigma: 1.2, scaleToExpiry: false };
  const out = opt(chain(100, 0.6, { quotedIv: 0.45 }), {}, { weeklyAtr: wa });
  if (out.status === 'OK') { assert.ok(out.best.fill.evAfterSlippage > 0); assert.equal(out.best.fill.counts.Illiquid, 0); assert.ok(out.execPlan); }
  else assert.match(out.errors.join(' '), /positive expected value|risk|target/);
  const flat = opt(chain(100, 0.6), {}, { weeklyAtr: wa }); assert.notEqual(flat.status, 'OK');
});

test('reference method: EV at natural prices, NOT RECOMMENDED when it is negative or a leg is illiquid; liquid-strike moves', () => {
  const run = (contracts, cfg = {}) => S.attachLiquidity(S.buildReference({ ticker: 'TEST', expiry: EXP, nowMs: NOW, contracts, stock: { price: 100 }, perp: perp(100), cfg: { futuresSide: 'LONG', targetPnl: 400, capital: 100000, ...cfg } }), cfg);
  const flat = run(chain(100, 0.6));
  assert.equal(flat.status, 'OK'); assert.ok(Number.isFinite(flat.best.fill.evAfterSlippage));
  assert.ok(flat.best.fill.evAfterSlippage < 0, 'fair-priced fixture: negative EV at natural'); assert.equal(flat.liquidityVerdict.recommended, false);
  assert.match(flat.liquidityVerdict.blockers.join(' '), /expected value after a market fill/); assert.ok(flat.warnings.some((w) => /^Not recommended:/.test(w)));
  assert.equal(run(chain(100, 0.6), { requirePositiveEv: false }).liquidityVerdict.recommended, true);
  // the EV integral: a structure's EV equals the lognormal mean of its expiry payoff (hand check with a coarse sum)
  const b = flat.best, E = S.evaluate({ legs: b.legs, future: { qty: b.futures.signedQty, entry: b.futures.entry, basis: flat.basis || 0 }, commission: flat.cfg.commission, futureFeePct: flat.cfg.futureFeePct, r: 0.04, nowMs: 0, expiryMs: flat.days * 864e5 });
  const iv = flat.atmIV, T = flat.days / 365; let hand = 0; for (let i = 0; i < 20000; i++) { const z = -6 + (i + 0.5) * 12 / 20000; hand += Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI) * 12 / 20000 * E.expiry(100 * Math.exp((0.04 - iv * iv / 2) * T + iv * Math.sqrt(T) * z)); }
  assert.ok(Math.abs(S.expectedValueAtExpiry(b, flat, flat.cfg) - (hand - (b.mmLoss || 0))) < 1);
  // make each chosen strike illiquid in turn: it is always avoided (another σ combo, or a move to a liquid neighbour), and every
  // reported move ends on a strike of the final structure with a better grade
  let reported = 0;
  for (const leg of flat.best.legs) {
    const m = run(chain(100, 0.6, { bad: (K, type) => type === leg.type && K === leg.strike }), { requirePositiveEv: false });
    assert.ok(!m.best.legs.some((l) => l.type === leg.type && l.strike === leg.strike), 'illiquid ' + leg.strike + leg.type + ' avoided');
    assert.equal(m.best.fill.counts.Illiquid, 0);
    for (const msg of m.liquidityMoves) { reported++; const to = +msg.match(/moved to ([\d.]+)/)[1]; assert.ok(m.best.legs.some((l) => l.strike === to)); assert.ok(m.warnings.some((w) => w.includes(msg))); }
  }
  assert.ok(reported > 0, 'at least one move explained');
});
