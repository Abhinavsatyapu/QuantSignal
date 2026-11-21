// The Structure Planner print (HOOD, 2026-11-21, expiry 2026-11-27) as the reference case.
const test = require("node:test"), assert = require("node:assert/strict"), P = require("../site/planner-math.js");
const input = { spot: 64.20, today: "2026-11-21",
  legs: [ { cp: "P", K: 60, exp: "2026-11-27", side: 1, size: 4, price: 2.33, iv: 1.2968, bid: 2.21, ask: 2.46 },
          { cp: "P", K: 62, exp: "2026-11-27", side: -1, size: 4, price: 3.20, iv: 1.3114, bid: 3.00, ask: 3.40 },
          { cp: "C", K: 65, exp: "2026-11-27", side: 1, size: 2, price: 1.89, iv: 0.6810, bid: 1.86, ask: 1.92 },
          { cp: "C", K: 69, exp: "2026-11-27", side: -1, size: 2, price: 0.70, iv: 0.6890, bid: 0.63, ask: 0.76 } ],
  grid: { launch: true, direction: "bullish", spacing: 1, target: 1, rungs: 10, qty: 10, coreN: 0, adj: 0, targetNet: 0, band: 2, spread: true } };
const m = P.build(input), near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: got ${a}, expected ${b} ± ${tol}`);
test("headline figures match the print", () => {
  near(m.netCost, -110, 0.01, "net cost"); near(m.spreadCost, 298, 0.01, "spread cost");
  near(m.sigma1, 4.02, 0.01, "1-day sigma"); near(m.greeks.delta, 77.61, 0.6, "delta");
  near(m.maxLoss.value, -1883.17, 2, "max loss"); near(m.maxLoss.price, 49.75, 0.1, "max-loss price"); near(m.maxLoss.perDollar, -100, 0.5, "per $1");
  near(m.maxProfit, 1162, 1, "max profit"); near(m.breakevens[0], 65.37, 0.1, "breakeven"); near(m.winRate * 100, 42.09, 0.15, "win rate"); near(m.greeks.gamma, 2.75, 0.01, "gamma"); near(m.greeks.theta, 2.25, 0.01, "theta"); near(m.greeks.vega, 0.69, 0.01, "vega"); near(m.greeks.rho, 0.84, 0.01, "rho"); near(m.now, -294.91, 0.01, "mark now");
  near(m.netDelta, 177.61, 0.6, "net delta with shares"); assert.equal(m.seedShares, 100);
  assert.match(m.verdict.text, /Viable only if spot > 6[78]\./); assert.equal(m.verdict.level, "red");
});
test("price-movement rows match the print", () => {
  const rows = P.moves(m, "2026-11-21"), r = l => rows.find(x => x.label === l);
  near(r("-10.0 %").grid, -175.2, 1, "grid at -10%"); assert.equal(r("-10.0 %").shares, 60);
  near(r("-2.0 %").grid, -2.84, 0.1, "grid at -2%"); assert.equal(r("-1.0 %").shares, 0); assert.equal(r("+5.0 %").grid, 0);
  near(r("spot").net, m.now, 1e-9, "spot row"); near(r("spot").spread, -298, 0.01, "spread column");
  near(rows.find(x => x.label.startsWith("−2σ")).price, 57.85, 0.1, "−2σ price (1-day horizon)");
});
test("by-date table: expiry row worst in ±2σ, DTE", () => {
  const last = m.rows.at(-1); assert.equal(last.date, "2026-11-27"); assert.equal(last.dte, 0); assert.equal(m.rows[0].dte, 6);
  near(last.worst.x, 49.75, 0.1, "expiry worst price"); near(last.worst.v, -1883.17, 2, "expiry worst");
  assert.deepEqual(m.rows.map(r => r.date), ["2026-11-21", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"]);
  near(m.rows[1].worst.x, 55.41, 0.1, "11-23 worst price"); near(m.rows[1].markAtSpot, -290.50, 0.01, "11-23 mark");
  near(m.rows[0].zones[0][0], 67.93, 0.01, "today profit above"); near(last.best.v, 612, 0.01, "expiry best"); near(last.best.x, 69, 0.3, "expiry best price");
});
test("structure name, json summary and bearish ladder", () => {
  assert.equal(P.name(m.legs), "put credit spread + call debit spread");
  const s = P.summary(input); assert.equal(s.byDate.length, 6); assert.ok(JSON.stringify(s).length > 100);
  const b = P.ladder({ launch: true, direction: "bearish", spacing: 1, rungs: 3, qty: 10 }, 100, 102.5); assert.equal(b.shares, -20); near(b.pnl, -10 * 1.5 - 10 * 0.5, 1e-9, "bearish ladder");
});
