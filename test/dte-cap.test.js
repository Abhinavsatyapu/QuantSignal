"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const cap = require("../dte-cap");
const math = require("../books-math");

const spot = 100;
function strike(K, callBought, callSold, putBought, putSold, callVol = 10, putVol = 10) {
  return { K, callBought, callSold, putBought, putSold, callVol, putVol };
}

test("CAPPED is calls written above and puts not written below", () => {
  const row = cap.classifyName("AAA", spot, [
    strike(105, 0, 40, 0, 0, 40, 0),
    strike(95, 0, 0, 20, 5, 0, 25),
  ], "unusualwhales");
  assert.equal(row.state, "CAPPED");
  assert.equal(row.lidStrike, 105);
  assert.equal(row.written, 40);
  assert.ok(row.lidNet < 0);
  assert.ok(row.floorNet > 0);
});

test("the other three states are the control, not shorts", () => {
  assert.equal(cap.classifyName("F", spot, [strike(95, 0, 0, 0, 30, 0, 30)], "unusualwhales").state, "FLOOR ONLY");
  assert.equal(cap.classifyName("B", spot, [strike(105, 0, 10, 0, 0, 10, 0), strike(95, 0, 0, 0, 10, 0, 10)], "unusualwhales").state, "BOX");
  assert.equal(cap.classifyName("N", spot, [strike(105, 10, 0, 0, 0, 10, 0), strike(95, 0, 0, 10, 0, 0, 10)], "unusualwhales").state, "NEITHER");
  assert.equal(cap.classifyName("U", spot, [strike(105, null, null, null, null)], "none").state, "NO SIDE");
});

test("puts outside the 15% band do not write the floor", () => {
  const row = cap.classifyName("FAR", spot, [
    strike(110, 0, 20, 0, 0, 20, 0),
    strike(80, 0, 0, 0, 50, 0, 50),
  ], "unusualwhales");
  assert.equal(row.state, "CAPPED");
  assert.equal(row.floorNet, 0);
});

test("size is the tighter of $250 of risk and $25k notional", () => {
  const wide = cap.sizeShort(100, 105);
  assert.equal(wide.shares, 50); // 250/5 = 50, notional cap is 250
  const tight = cap.sizeShort(100, 100.5);
  assert.equal(tight.shares, 250); // 250/0.5 = 500, but 25000/100 = 250
  assert.equal(cap.sizeShort(100, 100), null);
});

test("a short stops at the lid and otherwise covers at 15:50", () => {
  const bars = [
    { mins: 10 * 60 + 31, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
    { mins: 11 * 60, open: 101, high: 106, low: 100, close: 104, volume: 1000 },
    { mins: 15 * 60 + 50, open: 90, high: 91, low: 89, close: 90, volume: 1000 },
  ];
  const stopped = cap.settle({ symbol: "AAA", lidStrike: 105, volume: 100, vsVwap: "below" }, bars, 16 * 60);
  assert.equal(stopped.status, "STOPPED");
  assert.equal(stopped.exitPx, 105);
  assert.equal(stopped.resolved, true);
  assert.ok(stopped.pnl < 0);
  const calm = [
    { mins: 10 * 60 + 31, open: 100, high: 101, low: 98, close: 99, volume: 1000 },
    { mins: 15 * 60 + 50, open: 97, high: 98, low: 96, close: 97, volume: 1000 },
  ];
  const covered = cap.settle({ symbol: "AAA", lidStrike: 110, volume: 80, vsVwap: "above" }, calm, 16 * 60);
  assert.equal(covered.status, "COVERED");
  assert.equal(covered.exitPx, 97);
  assert.ok(covered.pay > 0);
  const open = cap.settle({ symbol: "AAA", lidStrike: 110, volume: 80, vsVwap: "above" }, calm, 12 * 60);
  assert.equal(open.status, "OPEN");
  assert.equal(open.resolved, false);
});

test("scorecard retires only at 100 resolved shorts when a gated line fails", () => {
  const trade = (pay, status, pnl) => ({ resolved: true, status, entry: 100, exitPx: 100 * (1 - pay / 100), pay, pnl, volume: 10, vsVwap: "below" });
  const losing = Array.from({ length: 70 }, () => trade(-1, "COVERED", -10));
  const early = cap.scorecard({ "2026-11-18": { read: { names: [{ state: "CAPPED", rod: 0.5 }, { state: "NEITHER", rod: -0.2 }] }, trades: losing } });
  assert.equal(early.retired, false);
  assert.equal(early.count.resolved, 70);
  const many = Array.from({ length: 100 }, () => trade(-0.5, "COVERED", -20));
  const late = cap.scorecard({ "2026-11-19": { read: { names: [] }, trades: many } });
  assert.equal(late.retired, true);
  assert.ok(late.failed.includes("trades closing below entry"));
});

test("phase deepening, airpocket gap, and the 09:00 scanning line", () => {
  assert.equal(math.phaseOf(-0.5, [{ norm: -0.3 }]).phase, "DEEPENING");
  assert.equal(math.phaseOf(-0.4, [{ norm: -0.35 }]).phase, "SHORT_GAMMA");
  const under = math.airpocketOf({ spot: 100, putWall: 110, callWall: 112 });
  assert.equal(under.side, "UNDER");
  assert.ok(under.gap >= 2);
  assert.equal(math.airpocketOf({ spot: 100, putWall: 99, callWall: 101 }), null);
  const day = "2026-11-20";
  const polls = [{ day, mins: 8 * 60, book: {} }];
  assert.equal(math.confirmedBreaks(polls, { day, mins: 9 * 60 + 10 }).status, "scanning");
});
