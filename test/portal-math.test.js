"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("../portal-math");

function bars(closes, lows, highs, vols) {
  return closes.map((c, i) => ({ d: "2026-01-" + String(i + 1).padStart(2, "0"), o: c, h: highs ? highs[i] : c + 1, l: lows ? lows[i] : c - 1, c, v: vols ? vols[i] : 1000 }));
}

test("stall day is a low close on a down day, and the next session can break it", () => {
  const b = bars(Array.from({ length: 30 }, () => 50));
  b[23] = { d: b[23].d, o: 50, h: 51, l: 49, c: 50, v: 1000 };
  b[24] = { d: b[24].d, o: 50, h: 54, l: 40, c: 42, v: 5000 };
  b[25] = { d: b[25].d, o: 42, h: 43, l: 39, c: 41, v: 1000 };
  const events = m.stallDays(b);
  assert.equal(events.length, 1);
  assert.equal(events[0].broke, true);
  assert.equal(events[0].watch, 40);
});

test("SPY grade is A only when the last close is under the prior close and the 20-session average", () => {
  const up = bars(Array.from({ length: 25 }, (_, i) => 100 + i));
  assert.equal(m.gradeSpy(up).grade, "C");
  const down = bars(Array.from({ length: 25 }, (_, i) => 200 - i));
  assert.equal(m.gradeSpy(down).grade, "A");
});

test("airpocket fires when the day's high trades through the overhead wall", () => {
  const chain = { symbol: "SPY", spot: 100, calls: [{ strike: 110, oi: 50 }], puts: [{ strike: 70, oi: 10 }] };
  const quiet = m.airpockets([chain], { SPY: [{ h: 101, l: 99, c: 100 }] });
  assert.equal(quiet[0].tag, "STILL WATCHING");
  assert.equal(quiet[0].side, "UNDER");
  const hit = m.airpockets([chain], { SPY: [{ h: 110, l: 99, c: 108 }] });
  assert.equal(hit[0].tag, "FIRED");
});

test("rvol and flow velocity use the prior sessions, not a constant", () => {
  const b = bars(Array.from({ length: 25 }, () => 10), null, null, Array.from({ length: 25 }, (_, i) => i === 24 ? 3000 : 1000));
  assert.ok(m.rvol(b) > 2);
  assert.equal(m.flowVelocity(b), (3000 / 1000 - 1) * 100);
});

test("cohort ignition is above the 50-day, under the 200-day, and up over 20 sessions", () => {
  const c = Array.from({ length: 210 }, () => 200).concat(Array.from({ length: 30 }, () => 100)).concat(Array.from({ length: 12 }, (_, i) => 110 + i * 4));
  const phase = m.cohortPhase(bars(c));
  assert.equal(phase.phase, "IGNITION");
  assert.ok(phase.last > phase.e50 && phase.last < phase.e200);
});
