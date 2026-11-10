'use strict';

const INTERVAL_MS = {
  '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3,
  '30m': 1800e3, '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '1d': 86400e3,
};

function intervalMs(iv) { return INTERVAL_MS[iv] || 1800e3; }

function mergeBars(prev, incoming, keep = 260) {
  const by = new Map();
  for (const b of prev || []) if (b && b.t != null) by.set(b.t, b);
  for (const b of incoming || []) if (b && b.t != null) by.set(b.t, b);
  return [...by.values()].sort((a, b) => a.t - b.t).slice(-keep);
}

function nextFetchLimit(cached, interval, now = Date.now(), { warmup = 200, incremental = 6, minBars = 80 } = {}) {
  if (!cached || cached.length < minBars) return warmup;
  const last = cached[cached.length - 1];
  const ms = intervalMs(interval);
  const lastT = Number(last.T || (last.t + ms - 1));
  // If we already have a bar that covers "now" or the previous close, only pull a handful of new/forming bars.
  if (now - lastT < ms * 3) return incremental;
  return warmup;
}

function createKlineCache() {
  const map = new Map(); // key → bars
  const key = (symbol, interval) => String(symbol).toUpperCase() + '|' + interval;

  function get(symbol, interval) { return map.get(key(symbol, interval)) || []; }

  function put(symbol, interval, bars) {
    const merged = mergeBars(get(symbol, interval), bars, 260);
    map.set(key(symbol, interval), merged);
    return merged;
  }

  function limitFor(symbol, interval, now) {
    return nextFetchLimit(get(symbol, interval), interval, now);
  }

  return { get, put, limitFor, mergeBars, nextFetchLimit, size: () => map.size, clear: () => map.clear() };
}

module.exports = { intervalMs, mergeBars, nextFetchLimit, createKlineCache };
