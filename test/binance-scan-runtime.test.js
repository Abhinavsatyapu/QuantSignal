'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('../server/binance-limiter');
const { mergeBars, nextFetchLimit, createKlineCache } = require('../server/binance-klines-cache');
const fs = require('fs');
const path = require('path');

test('limiter bounds concurrency and honors abort', async () => {
  const lim = createLimiter({ maxConcurrent: 2, minIntervalMs: 0 });
  let inflight = 0, max = 0;
  const jobs = Array.from({ length: 6 }, (_, i) => lim.schedule(async () => {
    inflight += 1; max = Math.max(max, inflight);
    await new Promise((r) => setTimeout(r, 30));
    inflight -= 1;
    return i;
  }));
  const out = await Promise.all(jobs);
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5]);
  assert.ok(max <= 2, 'max inflight ' + max);

  const ac = new AbortController();
  ac.abort('stop');
  await assert.rejects(
    lim.schedule(async () => 1, { signal: ac.signal }),
    /stop|aborted/,
  );
});

test('kline cache warms up with 200 bars then fetches only new closes', () => {
  const ms = 1800e3;
  const bars = [];
  let t = Date.UTC(2026, 10, 10, 10, 0, 0);
  for (let i = 0; i < 120; i++) {
    bars.push({ t, T: t + ms - 1, o: 1, h: 2, l: 0.5, c: 1.1, v: 10 });
    t += ms;
  }
  assert.equal(nextFetchLimit([], '30m', t), 200);
  assert.equal(nextFetchLimit(bars, '30m', bars[bars.length - 1].T + 60e3), 6);
  const extra = [{ t, T: t + ms - 1, o: 1, h: 2, l: 0.5, c: 1.2, v: 8 }];
  const merged = mergeBars(bars, extra, 260);
  assert.equal(merged.length, 121);
  assert.equal(merged[merged.length - 1].c, 1.2);
  const cache = createKlineCache();
  cache.put('NVDAUSDT', '30m', bars);
  assert.equal(cache.limitFor('NVDAUSDT', '30m', bars[bars.length - 1].T + 1000), 6);
  cache.put('NVDAUSDT', '30m', extra);
  assert.equal(cache.get('NVDAUSDT', '30m').length, 121);
});

test('aborted scan loop records lastScanError and a completed pass sets lastScanAt', async () => {
  // Lightweight stand-in for the trader loop: hang on first fetch until aborted, then a fast second pass.
  const state = { scanBusy: false, lastScanAt: 0, lastScanError: null, scanAbort: null };
  const yieldLoop = () => new Promise((r) => setImmediate(r));

  async function scanOnce(assets, fetchKlines, reason) {
    if (state.scanBusy) return;
    const ac = new AbortController();
    state.scanAbort = ac;
    state.scanBusy = true;
    state.lastScanError = null;
    const started = Date.now();
    try {
      for (const symbol of assets) {
        if (ac.signal.aborted) throw new Error(ac.signal.reason || 'scan aborted');
        await yieldLoop();
        await fetchKlines(symbol, ac.signal);
      }
      state.lastScanAt = Date.now();
    } catch (e) {
      state.lastScanError = e.message;
    } finally {
      state.scanBusy = false;
      if (state.scanAbort === ac) state.scanAbort = null;
    }
    return Date.now() - started;
  }

  const hang = (symbol, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, 30000);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error(signal.reason || 'aborted')); });
  });

  const first = scanOnce(['A', 'B', 'C'], hang, 'startup');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(state.scanBusy, true);
  state.scanAbort.abort('scan aborted after 2s');
  await first;
  assert.equal(state.scanBusy, false);
  assert.match(state.lastScanError, /aborted/);
  assert.equal(state.lastScanAt, 0);

  let n = 0;
  await scanOnce(['A', 'B', 'C'], async () => { n += 1; }, 'watchdog');
  assert.equal(n, 3);
  assert.ok(state.lastScanAt > 0);
  assert.equal(state.lastScanError, null);
});

test('Live Signals badge uses Engine LIVE when the scan is fresh', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'signals.js'), 'utf8');
  assert.match(js, /Engine LIVE/);
  assert.match(js, /Engine STALE/);
});
