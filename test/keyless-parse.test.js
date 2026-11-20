"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const k = require("../keyless");

test("Nasdaq historical rows become oldest-first bars", () => {
  const bars = k._parseHist([
    { date: "11/19/2026", close: "$349.21", volume: "40,906,860", open: "$352.91", high: "$355.28", low: "$346.47" },
    { date: "11/18/2026", close: "715.87", volume: "1,000", open: "710", high: "720", low: "700" },
  ]);
  assert.equal(bars[0].d, "2026-11-18");
  assert.equal(bars[1].d, "2026-11-19");
  assert.equal(bars[1].c, 349.21);
  assert.equal(bars[1].v, 40906860);
});

test("a bare November expiry stays in the session year when it is not already past", () => {
  const ms = k._parseExpiry("Nov 20", new Date("2026-11-20T15:00:00Z"));
  assert.equal(new Date(ms).toISOString().slice(0, 10), "2026-11-20");
});

test("the Docker image copies the keyless modules", () => {
  const docker = fs.readFileSync(require("path").join(__dirname, "..", "Dockerfile"), "utf8");
  for (const file of ["keyless.js", "portal-live.js", "portal-math.js"]) assert.match(docker, new RegExp(file));
});
