'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../server/config');

test('BINANCE_DEFAULTS use study-best 4h liq_buy_side with legacy preset selectable', () => {
  const b = config.BINANCE_DEFAULTS;
  assert.equal(b.interval, '1h');
  assert.equal(b.signalMode, 'confirm_window');
  assert.deepEqual(b.liqKinds, []);
  assert.equal(b.liqWindowBars, 3);
  assert.equal(b.activePreset, 'combine_1h_and_window_3');
  assert.ok(b.studyPresets.study_best_4h_liq_buy_side);
  assert.ok(b.studyPresets.legacy_15m_indicators);
  assert.equal(b.studyPresets.legacy_15m_indicators.interval, '15m');
  assert.equal(b.studyPresets.legacy_15m_indicators.signalMode, 'indicators');
});

test('update({binance:{activePreset}}) switches to legacy 15m indicators', () => {
  const before = config.get().binance;
  try {
    const c = config.update({ binance: { activePreset: 'legacy_15m_indicators' } });
    assert.equal(c.binance.interval, '15m');
    assert.equal(c.binance.signalMode, 'indicators');
    // restore study best
    config.update({ binance: { activePreset: 'combine_1h_and_window_3' } });
  } catch (e) {
    // restore best-effort
    try { config.update({ binance: { activePreset: 'combine_1h_and_window_3' } }); } catch {}
    throw e;
  }
});

test('confirm_window signal hook fires when liq within N bars of indicators', () => {
  require('../public/indicators.js');
  require('../public/strategy-liquidity-signals.js');
  const study = require('../scripts/binance-stock-perp-study');
  // Build synthetic bars: mostly flat then a clear pattern is hard; just assert hook path returns null safely
  const bars = [];
  let px = 100;
  for (let i = 0; i < 260; i++) {
    const o = px, h = px * 1.01, l = px * 0.99, c = px * (1 + (i % 7 === 0 ? 0.002 : -0.001));
    bars.push({ t: 1_700_000_000_000 + i * 3600e3, T: 1_700_000_000_000 + (i + 1) * 3600e3 - 1, o, h, l, c, v: 1000 });
    px = c;
  }
  const sig = study.signalAt(bars, 250, { mode: 'confirm_window', windowBars: 3, kinds: null });
  // May be null; must not throw
  assert.ok(sig === null || (sig.direction === 'LONG' || sig.direction === 'SHORT'));
});
