'use strict';
// Historical USD-M klines from data.binance.vision (official daily zips).
// Used when fapi REST is rate-limited or IP-banned. Tiny files; never load monthly archives.

const zlib = require('zlib');
const { abortableSleep, withDeadline } = require('./binance-http-util');
const { createLimiter, abortError } = require('./binance-limiter');

const VISION = 'https://data.binance.vision/data/futures/um/daily/klines';
const archiveLimiter = createLimiter({ maxConcurrent: 3, minIntervalMs: 40 });

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      return { cdOffset: buf.readUInt32LE(i + 16), cdSize: buf.readUInt32LE(i + 12) };
    }
  }
  return null;
}

function unzipFirst(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 30 || b.readUInt32LE(0) !== 0x04034b50) throw new Error('not a zip');
  const flags = b.readUInt16LE(6);
  const method = b.readUInt16LE(8);
  const nameLen = b.readUInt16LE(26);
  const extraLen = b.readUInt16LE(28);
  const dataStart = 30 + nameLen + extraLen;
  let compSize = b.readUInt32LE(18);
  if ((flags & 0x8) || !compSize) {
    const eocd = findEocd(b);
    if (eocd) {
      const cd = eocd.cdOffset;
      if (cd + 46 <= b.length && b.readUInt32LE(cd) === 0x02014b50) {
        compSize = b.readUInt32LE(cd + 20);
      }
    }
  }
  if (!compSize || dataStart + compSize > b.length) throw new Error('zip truncated');
  const comp = b.subarray(dataStart, dataStart + compSize);
  if (method === 0) return Buffer.from(comp);
  if (method === 8) return zlib.inflateRawSync(comp);
  throw new Error('unsupported zip method ' + method);
}

function parseKlineCsv(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  const bars = [];
  for (const line of lines) {
    if (/^\s*open_time/i.test(line)) continue;
    const cols = line.split(',');
    if (cols.length < 7) continue;
    const t = Number(cols[0]), o = +cols[1], h = +cols[2], l = +cols[3], c = +cols[4], v = +cols[5], T = Number(cols[6]);
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    bars.push({ t, o, h, l, c, v, T, closed: true });
  }
  return bars.sort((a, b) => a.t - b.t);
}

function utcYmd(d) {
  return d.toISOString().slice(0, 10);
}

function recentDates(days, now = new Date()) {
  const n = Math.max(1, days || 14);
  const out = [];
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = n - 1; i >= 0; i--) out.push(utcYmd(new Date(base - i * 86400e3)));
  return out;
}

function dayUrl(symbol, interval, ymd) {
  const sym = String(symbol).toUpperCase();
  return `${VISION}/${sym}/${interval}/${sym}-${interval}-${ymd}.zip`;
}

async function fetchDay(symbol, interval, ymd, opts = {}) {
  const timeoutMs = opts.timeoutMs || 8000;
  const signal = opts.signal || null;
  if (signal && signal.aborted) throw abortError(signal);
  const url = dayUrl(symbol, interval, ymd);
  const run = async () => {
    const res = await withDeadline(
      fetch(url, { headers: { 'User-Agent': 'QuantSignal-Binance/1.0', Accept: 'application/zip' }, signal: signal || AbortSignal.timeout(timeoutMs) }),
      timeoutMs,
      signal,
      'vision timeout',
    );
    if (res.status === 404) return [];
    if (!res.ok) throw new Error('vision HTTP ' + res.status);
    const buf = Buffer.from(await withDeadline(res.arrayBuffer(), timeoutMs, signal, 'vision body timeout'));
    return parseKlineCsv(unzipFirst(buf).toString('utf8'));
  };
  if (opts.skipLimiter) return run();
  return archiveLimiter.schedule(run, { signal });
}

async function fetchRecent(symbol, interval, opts = {}) {
  const days = opts.days || 14;
  const dates = recentDates(days, opts.now ? new Date(opts.now) : new Date());
  const all = [];
  for (const ymd of dates) {
    if (opts.signal && opts.signal.aborted) throw abortError(opts.signal);
    try {
      const rows = await fetchDay(symbol, interval, ymd, opts);
      for (const r of rows) all.push(r);
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw e;
      // Missing day (today often unpublished) or a single 5xx — keep going.
    }
    if (opts.pauseMs) await abortableSleep(opts.pauseMs, opts.signal);
  }
  return all;
}

async function warmMany(symbols, interval, opts = {}) {
  const cache = opts.cache;
  const minBars = opts.minBars || 220;
  const lim = createLimiter({ maxConcurrent: opts.concurrency || 3, minIntervalMs: 40 });
  const list = (symbols || []).map((s) => String(s).toUpperCase());
  let done = 0;
  const results = await Promise.all(list.map((symbol) => lim.schedule(async () => {
    if (opts.signal && opts.signal.aborted) throw abortError(opts.signal);
    if (cache && cache.get(symbol, interval).length >= minBars) { done += 1; if (opts.onProgress) opts.onProgress({ done, total: list.length, symbol }); return cache.get(symbol, interval); }
    const bars = await fetchRecent(symbol, interval, opts);
    done += 1;
    if (opts.onProgress) opts.onProgress({ done, total: list.length, symbol });
    if (cache && bars.length) return cache.put(symbol, interval, bars);
    return bars;
  }, { signal: opts.signal }).catch((e) => {
    if (opts.signal && opts.signal.aborted) throw e;
    done += 1;
    if (opts.onProgress) opts.onProgress({ done, total: list.length, symbol, error: e.message });
    return [];
  })));
  return results;
}

module.exports = {
  VISION, unzipFirst, parseKlineCsv, recentDates, dayUrl, fetchDay, fetchRecent, warmMany, archiveLimiter,
};
