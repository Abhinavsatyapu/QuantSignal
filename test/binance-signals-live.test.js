'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const live = require('../server/binance-signals-live');
const prices = require('../server/binance-prices');
const ps = require('../server/binance-preset-signals');

test('nextBarCloseAt snaps to the next 30m boundary', () => {
  const t = Date.UTC(2026, 10, 10, 15, 12, 0); // 15:12 UTC
  const close = live.nextBarCloseAt('30m', t);
  assert.equal(close, Date.UTC(2026, 10, 10, 15, 30, 0));
  assert.equal(live.intervalMs('30m'), 1800e3);
});

test('rr and status mapping include skipped reasons', () => {
  const row = { entry: 100, stop: 97, tp: 106, status: 'skipped', reason: 'outside US cash hours', raw: JSON.stringify({ conditions: { trend: true, flow: true, buySide: true } }), ts: Date.UTC(2026, 10, 10, 10, 0), symbol: 'NVDAUSDT', direction: 'LONG' };
  const e = live.enrichSignal(row);
  assert.equal(e.rr, 2);
  assert.equal(e.statusLabel, 'skipped');
  assert.match(e.reason, /US cash/);
  assert.equal(e.conditions.trend, true);
  assert.equal(e.conditions.buySide, true);
  assert.match(e.tsIst, /IST/);
  const taken = live.enrichSignal({ ...row, status: 'open', reason: null });
  assert.equal(taken.statusLabel, 'taken');
  const pending = live.enrichSignal({ ...row, status: 'dry_run', reason: 'DRY-RUN fill' });
  assert.equal(pending.statusLabel, 'pending');
  const maxed = live.enrichSignal({ ...row, status: 'rejected', reason: 'Max concurrent (4/4)' });
  assert.equal(maxed.statusLabel, 'skipped');
});

test('ws backoff doubles then caps; watchdog only on stale open sockets', () => {
  assert.equal(prices.nextWsBackoff(0), 1000);
  assert.equal(prices.nextWsBackoff(1000), 2000);
  assert.equal(prices.nextWsBackoff(16000), 30000);
  assert.equal(prices.nextWsBackoff(30000), 30000);
  const now = 100000;
  assert.equal(prices.wsNeedsWatchdog(now - 5000, 'ws', now, 15000), false);
  assert.equal(prices.wsNeedsWatchdog(now - 20000, 'ws', now, 15000), true);
  assert.equal(prices.wsNeedsWatchdog(now - 20000, 'rest', now, 15000), false);
  assert.equal(prices.wsNeedsWatchdog(0, 'ws', now, 15000), true);
});

test('Prices.stop prevents reconnect scheduling', async () => {
  const p = prices.Prices({ symbols: ['NVDAUSDT'], client: { urls: () => ({ ws: 'ws://127.0.0.1:9' }), markPrice: async () => [], publicGet: async () => [] } });
  p.start();
  p.stop();
  assert.equal(p.state.stopped, true);
  assert.equal(p.state.ws, null);
  assert.equal(p.state.reconnectTimer, null);
  const snap = p.snapshot();
  assert.ok('reconnects' in snap);
  assert.ok('watchdogRestarts' in snap);
  await new Promise((r) => setTimeout(r, 30));
});

test('comboConditionSnapshot is safe on short history and does not invent a trade', () => {
  const snap = ps.comboConditionSnapshot([], 0, {}, {});
  assert.equal(snap.trend, false);
  assert.equal(snap.flow, false);
  assert.equal(snap.buySide, false);
  const short = ps.signalComboAnd3([], 0, {}, {}, { usCashOnly: false });
  assert.equal(short, null);
});
