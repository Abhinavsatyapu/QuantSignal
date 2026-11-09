'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ps = require('../server/binance-preset-signals');
const config = require('../server/config');
require('../public/indicators.js');
require('../public/strategy-liquidity-signals.js');

function bar(t, o, h, l, c, v = 1000) {
  return { t, T: t + 1800e3 - 1, o, h, l, c, v };
}

test('usCashUTC gates 14:30–21:00 UTC inclusive/exclusive bounds', () => {
  // 14:29 UTC — out
  assert.equal(ps.usCashUTC(Date.UTC(2026, 10, 10, 14, 29)), false);
  // 14:30 UTC — in
  assert.equal(ps.usCashUTC(Date.UTC(2026, 10, 10, 14, 30)), true);
  // 20:59 UTC — in
  assert.equal(ps.usCashUTC(Date.UTC(2026, 10, 10, 20, 59)), true);
  // 21:00 UTC — out
  assert.equal(ps.usCashUTC(Date.UTC(2026, 10, 10, 21, 0)), false);
});

test('isFridayUTC detects Friday', () => {
  // 2026-11-13 is Friday
  assert.equal(ps.isFridayUTC(Date.UTC(2026, 10, 13, 16, 0)), true);
  assert.equal(ps.isFridayUTC(Date.UTC(2026, 10, 12, 16, 0)), false);
});

test('agg10m pairs even 5m wall-clock bars', () => {
  const bars5 = [];
  let t = Date.UTC(2026, 10, 10, 14, 0);
  let px = 100;
  for (let i = 0; i < 6; i++) {
    bars5.push(bar(t, px, px + 1, px - 1, px + 0.2, 10));
    t += 300e3; px += 0.2;
  }
  // force even alignment
  bars5[0].t = Date.UTC(2026, 10, 10, 14, 0);
  bars5[1].t = Date.UTC(2026, 10, 10, 14, 5);
  bars5[1].T = bars5[1].t + 300e3 - 1;
  const a = ps.agg10m(bars5);
  assert.ok(a.length >= 1);
  assert.equal(a[0].t % 600e3, 0);
  assert.equal(a[0].o, bars5[0].o);
  assert.equal(a[0].c, bars5[1].c);
});

test('dedupeKey is unique per symbol/interval/bar/dir/mode', () => {
  const a = ps.dedupeKey('NVDAUSDT', '30m', 100, 'LONG', 'combo_and3');
  const b = ps.dedupeKey('NVDAUSDT', '30m', 100, 'LONG', 'combo_and3');
  const c = ps.dedupeKey('NVDAUSDT', '30m', 101, 'LONG', 'combo_and3');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('applyEntryFilters respects usCashOnly', () => {
  const during = Date.UTC(2026, 10, 10, 16, 0);
  const outside = Date.UTC(2026, 10, 10, 10, 0);
  assert.equal(ps.applyEntryFilters('LONG', { usCashOnly: true }, during), 'LONG');
  assert.equal(ps.applyEntryFilters('LONG', { usCashOnly: true }, outside), null);
});

test('signalComboAnd3 returns null on short history', () => {
  const bars = [];
  let t = Date.UTC(2026, 10, 1, 15, 0), px = 100;
  for (let i = 0; i < 50; i++) {
    bars.push(bar(t, px, px * 1.01, px * 0.99, px, 1000));
    t += 1800e3; px *= 1.001;
  }
  const sig = ps.signalComboAnd3(bars, bars.length - 1, globalThis.Technicals, globalThis.LiquiditySignals, {
    usCashOnly: false,
  });
  assert.equal(sig, null);
});

test('signalComboAnd3 does not throw on long synthetic series', () => {
  const bars = [];
  let t = Date.UTC(2026, 5, 1, 15, 0), px = 100;
  for (let i = 0; i < 280; i++) {
    const bull = i > 200;
    const o = px, c = px * (bull ? 1.004 : 0.998), h = Math.max(o, c) * 1.01, l = Math.min(o, c) * 0.99;
    bars.push(bar(t, o, h, l, c, 2000 + (i % 7) * 100));
    t += 1800e3; px = c;
  }
  // Place last bar in US cash
  bars[bars.length - 1].t = Date.UTC(2026, 10, 10, 16, 0);
  bars[bars.length - 1].T = bars[bars.length - 1].t + 1800e3 - 1;
  const sig = ps.signalComboAnd3(bars, bars.length - 1, globalThis.Technicals, globalThis.LiquiditySignals, {
    usCashOnly: true, windowBars: 3,
  });
  // May be null; must be null or LONG/SHORT with stops
  if (sig) {
    assert.ok(sig.dir === 'LONG' || sig.dir === 'SHORT');
    assert.ok(sig.stop > 0 && sig.tp > 0 && sig.entry > 0);
  } else {
    assert.equal(sig, null);
  }
});

test('active preset combo_30m applies 30m + combo_and3 + usCash', () => {
  const c = config.update({ binance: { activePreset: 'combo_30m_trend_flow_buyside_and3_uscash' } });
  assert.equal(c.binance.interval, '30m');
  assert.equal(c.binance.signalMode, 'combo_and3');
  assert.equal(c.binance.liqWindowBars, 3);
  assert.equal(c.binance.entryFilters.usCashOnly, true);
  assert.equal(c.binance.activePreset, 'combo_30m_trend_flow_buyside_and3_uscash');
});

test('BINANCE_DEFAULTS dry-run default is combo 30m uscash', () => {
  const b = config.BINANCE_DEFAULTS;
  assert.equal(b.activePreset, 'combo_30m_trend_flow_buyside_and3_uscash');
  assert.equal(b.allowSignedOrders, false);
  assert.equal(b.interval, '30m');
  assert.equal(b.signalMode, 'combo_and3');
});

test('combo preset ships maxStopAtr 2.5', () => {
  const c = config.update({ binance: { activePreset: 'combo_30m_trend_flow_buyside_and3_uscash' } });
  assert.equal(c.binance.entryFilters.maxStopAtr, 2.5);
});
