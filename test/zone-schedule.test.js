"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const zone = require("../zone");
const { gammaTtl, refreshDue, HOLD_MS, TTL } = zone._test;

test("morning gamma polls are five minutes, and only inside 09:25–10:40 ET", () => {
  assert.equal(gammaTtl({ mins: 9 * 60 + 24 }), TTL.gamma);
  assert.equal(gammaTtl({ mins: 9 * 60 + 25 }), 5 * 60e3);
  assert.equal(gammaTtl({ mins: 10 * 60 + 30 }), 5 * 60e3);
  assert.equal(gammaTtl({ mins: 10 * 60 + 40 }), 5 * 60e3);
  assert.equal(gammaTtl({ mins: 10 * 60 + 41 }), TTL.gamma);
});

test("a failed pass waits ten minutes even against the five-minute morning TTL", () => {
  const now = 1_000_000_000;
  const morning = 5 * 60e3;
  const until = now + HOLD_MS;
  assert.equal(refreshDue(now, null, morning, until), false);
  assert.equal(refreshDue(now + HOLD_MS - 1, null, morning, until), false);
  assert.equal(refreshDue(now + HOLD_MS, null, morning, until), true);
  // the old backoff backdated by the 60-minute TTL, which is already due against a 5-minute window
  const backdated = now - 60 * 60e3 + HOLD_MS;
  assert.equal(now - backdated > morning, true);
});

test("a failed 10:30 poll retries when the hold ends, not after the regular TTL", () => {
  const failedAt = 1_000_000_000;
  const lastSuccess = failedAt - 5 * 60e3;
  const until = failedAt + HOLD_MS;
  const atHoldEnd = failedAt + HOLD_MS;
  // the last success is still inside the 15- or 60-minute TTL, so the TTL alone would not retry
  assert.equal(atHoldEnd - lastSuccess > TTL.gamma, false);
  assert.equal(refreshDue(atHoldEnd, lastSuccess, TTL.gamma, 0), false);
  assert.equal(refreshDue(atHoldEnd - 1, lastSuccess, TTL.gamma, until), false);
  assert.equal(refreshDue(atHoldEnd, lastSuccess, TTL.gamma, until), true);
});

test("Zone Monitor is not scheduled until start, so books can use their own chain", () => {
  const snap = zone.snapshot();
  assert.equal(snap.scheduled, false);
  assert.equal(snap.loading.gamma, false);
});
