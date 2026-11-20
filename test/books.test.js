"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("../books-math");

const day = "2026-11-20";
const now = Date.parse("2026-11-20T15:00:00Z"); // 10:00 ET in November (EST)

test("gex sign matches the capture's boundary", () => {
  assert.equal(m.gexSign(0.30), "NEU");
  assert.equal(m.gexSign(0.31), "POS");
  assert.equal(m.gexSign(-0.30), "NEU");
  assert.equal(m.gexSign(-0.31), "NEG");
  assert.equal(m.gexSign(0), "NEU");
});

test("book tier: liquid, thin, and ordinary", () => {
  assert.equal(m.bookTier("SQQQ", 52, 80000), "A");
  assert.equal(m.bookTier("KDP", 35, 20000), "B");
  assert.equal(m.bookTier("QSI", 1.03, 80000), "THIN");
  assert.equal(m.bookTier("XYZ", 40, 1000), "THIN");
});

test("posture from spot versus the flip", () => {
  // ABBV: positive gamma, spot still under the flip → neutral
  assert.equal(m.postureOf(0.30, 285.70, 287.91, 285, 290), "NEUTRAL");
  // TMO: positive and through the flip → mean revert
  assert.equal(m.postureOf(0.16, 699, 698.93, 685, 700), "MEAN REVERT");
  // BEAM: deep short gamma, spot has not cleared the flip → trend
  assert.equal(m.postureOf(-0.73, 20.70, 20.09, 23, 22), "TREND");
  // above the flip by more than 5% while short → neutral, the move already left the short-gamma pocket
  assert.equal(m.postureOf(-0.50, 9.39, 7.68, 10, 9), "NEUTRAL");
});

test("phase state machine", () => {
  assert.deepEqual(m.phaseOf(0.40, []), { phase: "FRESH", provisional: true });
  assert.deepEqual(m.phaseOf(-0.40, []), { phase: "SHORT_GAMMA", provisional: true });
  assert.equal(m.phaseOf(-0.002, []).phase, null);
  assert.equal(m.phaseOf(0.40, [{ norm: -0.10 }]).phase, "FRESH");
  assert.equal(m.phaseOf(0.50, [{ norm: 0.45 }]).phase, "HELD");
  assert.equal(m.phaseOf(0.20, [{ norm: 0.45 }]).phase, "DECAYING");
  assert.equal(m.phaseOf(0.02, [{ norm: 0.40 }]).phase, "EXIT");
  assert.equal(m.phaseOf(-0.40, [{ norm: -0.36 }]).phase, "SHORT_GAMMA");
});

test("ignition threshold and exhaustion", () => {
  assert.equal(m.ignitionOf(0.29, "B", 0), null);
  assert.deepEqual(m.ignitionOf(0.30, "A", 0).book, "A");
  assert.equal(m.ignitionOf(0.32, "THIN", 0).book, "THIN");
  assert.equal(m.ignitionOf(0.49, "B", 300000).flowTag, "confirmed");
  assert.equal(m.ignitionOf(0.49, "B", -300000).flowTag, "opposed");
  assert.equal(m.flowOf(0.88, 0.05, 0.4, 0.3, 10, 1000).flow, "EXHAUSTION");
  assert.ok(m.flowOf(0.88, 0.05, 0.4, 0.3, 10, 1000).tags.includes("IV"));
  assert.equal(m.flowOf(0.88, 0.40, null, null, 0, 0).flow, "NEUTRAL");
  assert.equal(m.flowOf(0.20, 0.01, null, null, 0, 0).flow, "NEUTRAL");
});

test("reversal kinds", () => {
  const revert = m.reversalOf({ phase: "HELD", posture: "MEAN REVERT", basePosture: "MEAN REVERT", norm: 0.4, dgex: 0.01 });
  assert.equal(revert.kind, "REVERT");
  const pending = m.reversalOf({ phase: null, posture: "MEAN REVERT", basePosture: "NEUTRAL", norm: 0.2, dgex: 0.05 });
  assert.equal(pending.kind, "REVERT-PENDING");
  const exhaust = m.reversalOf({ phase: "EXIT", posture: "NEUTRAL", basePosture: "TREND", norm: -0.1, dgex: 0.05 });
  assert.equal(exhaust.kind, "TREND-EXHAUST");
  assert.equal(m.reversalOf({ phase: "SHORT_GAMMA", posture: "TREND", norm: -0.4 }), null);
  const failed = m.reversalOf({ phase: "EXIT", posture: "TREND", basePosture: "MEAN REVERT", norm: -0.1, dgex: -0.2 });
  assert.equal(failed.kind, "REVERT-FAILED");
});

test("confirmed break window", () => {
  const book = (spot, dgex, name = "KDP") => ({ [name]: { book: "B", spot, dgex, flow: "NEUTRAL", posture: "NEUTRAL", norm: 0.4 } });
  const polls = [
    { day, mins: 8 * 60 + 5, book: book(35, 0.40) },
    { day, mins: 9 * 60 + 31, book: book(35, 0.42) },
    { day, mins: 10 * 60 + 30, book: book(35.2, 0.41) },
  ];
  assert.equal(m.confirmedBreaks(polls, { day, mins: 8 * 60 }).status, "idle");
  assert.equal(m.confirmedBreaks(polls, { day, mins: 10 * 60 }).status, "fingerprint");
  const live = m.confirmedBreaks(polls, { day, mins: 10 * 60 + 40 });
  assert.equal(live.status, "live");
  assert.deepEqual(live.names, ["KDP"]);
  const frozen = m.confirmedBreaks(polls, { day, mins: 12 * 60 });
  assert.equal(frozen.status, "frozen");
  assert.deepEqual(frozen.names, ["KDP"]);
  // extension too small, or the book was not on at 09:30
  const weak = [{ day, mins: 9 * 60 + 31, book: book(35, 0.42) }, { day, mins: 10 * 60 + 30, book: book(35.05, 0.42) }];
  assert.deepEqual(m.confirmedBreaks(weak, { day, mins: 10 * 60 + 40 }).names, []);
  const late = [{ day, mins: 10 * 60, book: book(35, 0.5) }, { day, mins: 10 * 60 + 30, book: book(36, 0.5) }];
  assert.equal(m.confirmedBreaks(late, { day, mins: 10 * 60 + 40 }).status, "waiting");
});

test("tape prints the book, the first fire, and exhaustion", () => {
  const rows = [{ symbol: "KDP", book: "B", dgex: 0.49, atmPrem: 0, posture: "NEUTRAL", flow: "NEUTRAL", flowTags: [] }];
  const first = m.tapeFromPolls(null, rows, { day, mins: 8 * 60 + 38 });
  assert.equal(first.length, 2);
  assert.match(first[0].text, /IGN-B/);
  assert.match(first[0].text, /first poll/);
  assert.equal(first[1].kind, "TRACKER FIRE");
  const again = m.tapeFromPolls({ KDP: { book: "B", flow: "NEUTRAL" } }, rows, { day, mins: 9 * 60 });
  assert.equal(again.length, 0);
  const exh = m.tapeFromPolls({ SQQQ: { book: null, flow: "NEUTRAL" } }, [{ symbol: "SQQQ", book: null, dgex: 0.05, atmPrem: 0, posture: "MEAN REVERT", flow: "EXHAUSTION", flowTags: ["IV", "VOL"] }], { day, mins: 6 * 60 + 48 });
  assert.equal(exh[0].kind, "FLOW STATE");
  assert.match(exh[0].text, /\[IV\+VOL\]/);
});

test("implied vol round trip and chain structure", () => {
  const px = m.bsPrice(100, 100, 30 / 365, 0.25, "C");
  const iv = m.impliedVol(px, 100, 100, 30 / 365, "C");
  assert.ok(Math.abs(iv - 0.25) < 0.02, iv);
  const exp = m.parseExpiry("Nov 20", day);
  const later = m.parseExpiry("Nov 27", day);
  const chain = {
    symbol: "TEST", spot: 100, today: day, source: "fixture",
    legs: [
      { cp: "C", K: 100, exp: exp.ms, expIso: exp.iso, oi: 100, vol: 10, mid: 2, iv: 0.3, gamma: 0.04 },
      { cp: "P", K: 100, exp: exp.ms, expIso: exp.iso, oi: 50, vol: 4, mid: 2, iv: 0.3, gamma: 0.04 },
      { cp: "P", K: 90, exp: later.ms, expIso: later.iso, oi: 500, vol: 1, mid: 1, iv: 0.3, gamma: 0.01 },
      { cp: "C", K: 110, exp: later.ms, expIso: later.iso, oi: 400, vol: 1, mid: 1, iv: 0.3, gamma: 0.01 },
    ],
  };
  const s = m.structure(chain, now);
  assert.ok(s.norm > 0, s.norm);
  assert.equal(s.putWall, 90);
  assert.equal(s.callWall, 110);
  assert.ok(s.flip > 80 && s.flip < 120, s.flip);
  assert.ok(s.pct0 > 0 && s.pct0 < 100);
  assert.equal(s.atmPrem, 10 * 2 * 100 - 4 * 2 * 100);
});

test("evaluateSymbol ties a baseline to an ignition and a broke flag", () => {
  const exp = m.parseExpiry("Nov 27", day);
  const chain = {
    symbol: "KDP", spot: 36, today: day, source: "fixture",
    legs: [
      { cp: "C", K: 36, exp: exp.ms, expIso: exp.iso, oi: 20000, vol: 100, mid: 1, iv: 0.3, gamma: 0.08 },
      { cp: "P", K: 34, exp: exp.ms, expIso: exp.iso, oi: 20000, vol: 40, mid: 1, iv: 0.3, gamma: 0.02 },
    ],
  };
  const structure = m.structure(chain, now);
  const row = m.evaluateSymbol({
    symbol: "KDP", structure, history: [{ norm: structure.norm - 0.45 }],
    baseline: { norm: structure.norm - 0.45, spot: 34, putWall: 34, callWall: 36, flip: 35, ivAtm: 0.2 },
    broke: true, sessionRet: 4, ret5: 1, creditState: "FEAR", spyRet: 0.2,
  });
  assert.equal(row.book, "B");
  assert.ok(row.dgex >= 0.30);
  assert.equal(row.broke, true);
  assert.equal(row.credit.wait, true);          // not pharma, and the credit week is FEAR
  assert.equal(row.credit.size, "1×");
  assert.equal(row.credit.align, "reacting");
  assert.equal(row.flow, "NEUTRAL");
});

test("gates: dial, tide, swing, o-gap", () => {
  assert.equal(m.bullDial({ spyAboveEma20: false, creditCalm: false, spyLongGamma: true }).buyGated, true);
  assert.equal(m.bullDial({ spyAboveEma20: true, creditCalm: true, spyLongGamma: true }).score, 3);
  assert.equal(m.bullDial({ spyAboveEma20: true, creditCalm: true, spyLongGamma: true }).buyGated, false);
  const falling = m.tideState([{ v: 60 }, { v: 58 }, { v: 55 }, { v: 52 }, { v: 50 }, { v: 46 }]);
  assert.equal(falling.tide, "FALLING");
  assert.equal(m.tideAdvice(falling).code, "HALVE");
  const washed = m.tideState([...Array(19).fill(70), 40].map(v => ({ v })));
  assert.equal(m.tideAdvice(washed).code, "WASHED");
  assert.equal(m.ignitionContext(-0.4, -0.1).code, "AVOID");
  assert.equal(m.ignitionContext(-0.4, -0.39).code, "CAUTION");
  assert.equal(m.ogapGate(-0.2, 22).code, "SHUT");
  assert.equal(m.ogapGate(0.2, 22).code, "OPEN");
  const swing = m.swingCheck({ fromHigh: -6, bounce: 0, low: 645, last: 645, highDay: "2026-11-11" }, 22, -0.29);
  assert.equal(swing.confirmed, false);
  assert.ok(swing.need.length >= 3);
});

test("broke D-1 and expiry parsing", () => {
  assert.equal(m.brokeD1([{ d: "2026-11-18", l: 10, c: 11 }, { d: "2026-11-19", l: 9, c: 9.5 }], day), true);
  assert.equal(m.brokeD1([{ d: "2026-11-18", l: 10, c: 11 }, { d: "2026-11-19", l: 10.5, c: 11 }], day), false);
  assert.equal(m.parseExpiry("Nov 20", day).iso, "2026-11-20");
  assert.equal(m.parseExpiry("Jan 15", day).iso, "2027-01-15");
  assert.equal(m.parseNum("--"), null);
  assert.equal(m.parseNum("1,234"), 1234);
});
