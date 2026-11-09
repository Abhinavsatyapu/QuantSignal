'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const lessons = require('../server/trade-lessons');

test('classifyClosedTrade tags illiquid session outside US cash hours', () => {
  // Sunday UTC
  const ts = Date.UTC(2026, 10, 8, 12, 0, 0); // Sun
  const r = lessons.classifyClosedTrade({ id: 1, ts, pnl: -10, exit_reason: 'stop', symbol: 'NVDAUSDT', direction: 'LONG' });
  assert.ok(r.causes.includes('illiquid_session'));
  assert.equal(r.success, 0);
});

test('recordLesson upserts and summarizeLessons counts', () => {
  const row = { id: 990001, ts: Date.now(), symbol: 'TESTUSDT', direction: 'SHORT', pnl: -5, exit_reason: 'stop' };
  lessons.recordLesson(row);
  const s = lessons.summarizeLessons(50);
  assert.ok(s.n >= 1);
});
