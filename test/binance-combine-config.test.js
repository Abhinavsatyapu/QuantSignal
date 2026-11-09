'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../server/config');

test('BINANCE_DEFAULTS adopt combo 30m uscash with legacy presets selectable', () => {
  const b = config.BINANCE_DEFAULTS;
  assert.equal(b.activePreset, 'combo_30m_trend_flow_buyside_and3_uscash');
  assert.equal(b.interval, '30m');
  assert.equal(b.signalMode, 'combo_and3');
  assert.equal(b.liqWindowBars, 3);
  assert.equal(b.allowSignedOrders, false);
  assert.equal(b.studyPresets.combo_30m_trend_flow_buyside_and3_uscash.entryFilters.usCashOnly, true);
  assert.ok(b.studyPresets.combine_1h_and_window_3_uscash);
  assert.ok(b.studyPresets.study_best_4h_liq_buy_side);
  assert.ok(b.studyPresets.legacy_15m_indicators);
  assert.equal(b.studyPresets.legacy_15m_indicators.interval, '15m');
});

test('update({binance:{activePreset}}) switches to legacy 15m indicators', () => {
  try {
    const c = config.update({ binance: { activePreset: 'legacy_15m_indicators' } });
    assert.equal(c.binance.interval, '15m');
    assert.equal(c.binance.signalMode, 'indicators');
    config.update({ binance: { activePreset: 'combo_30m_trend_flow_buyside_and3_uscash' } });
  } catch (e) {
    try { config.update({ binance: { activePreset: 'combo_30m_trend_flow_buyside_and3_uscash' } }); } catch {}
    throw e;
  }
});

test('confirm_window signal hook does not throw', () => {
  require('../public/indicators.js');
  require('../public/strategy-liquidity-signals.js');
  const study = require('../scripts/binance-stock-perp-study');
  const bars = [];
  let px = 100;
  for (let i = 0; i < 260; i++) {
    const o = px, h = px * 1.01, l = px * 0.99, c = px * (1 + (i % 7 === 0 ? 0.002 : -0.001));
    bars.push({ t: 1_700_000_000_000 + i * 3600e3, T: 1_700_000_000_000 + (i + 1) * 3600e3 - 1, o, h, l, c, v: 1000 });
    px = c;
  }
  const sig = study.signalAt(bars, 250, { mode: 'confirm_window', windowBars: 3, kinds: null });
  assert.ok(sig === null || ['LONG', 'SHORT'].includes(sig.dir || sig.direction));
});

test('setup B uscash preset still selectable', () => {
  const c = config.update({ binance: { activePreset: 'combine_1h_and_window_3_uscash' } });
  assert.equal(c.binance.interval, '1h');
  assert.equal(c.binance.signalMode, 'confirm_window');
  assert.equal(c.binance.entryFilters.usCashOnly, true);
  config.update({ binance: { activePreset: 'combo_30m_trend_flow_buyside_and3_uscash' } });
});

test('combo preset applies 30m combo_and3 + usCash', () => {
  const c = config.update({ binance: { activePreset: 'combo_30m_trend_flow_buyside_and3_uscash' } });
  assert.equal(c.binance.interval, '30m');
  assert.equal(c.binance.signalMode, 'combo_and3');
  assert.equal(c.binance.entryFilters.usCashOnly, true);
});
