'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');

const FEATURED = ['AAPL', 'NVDA', 'TSLA', 'HOOD'];
const CUSIP = {
  AAPL: '037833100', NVDA: '67066G104', TSLA: '88160R101', HOOD: '770700102',
};
const CIK = {
  AAPL: '0000320193', NVDA: '0001045810', TSLA: '0001318605', HOOD: '0001783879',
};

function secUserAgent() {
  return process.env.SEC_USER_AGENT || 'QuantSignal Research research@example.com';
}

function cacheDir() {
  const dir = path.join(config.ROOT || path.join(__dirname, '..'), 'data', 'whales-cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function toIST(ms) {
  if (!ms) return null;
  try {
    return new Date(ms).toLocaleString('en-IN', {
      timeZone: 'Asia/Calcutta', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }) + ' IST';
  } catch { return new Date(ms).toISOString(); }
}

function lagLabel(asOfMs, now = Date.now()) {
  if (!asOfMs) return null;
  const ms = now - Number(asOfMs);
  if (!Number.isFinite(ms)) return null;
  const h = ms / 3600e3;
  if (h < 0) return '0m lag';
  if (h < 1) return Math.max(0, Math.round(h * 60)) + 'm lag';
  if (h < 48) return (Math.round(h * 10) / 10) + 'h lag';
  return (Math.round((h / 24) * 10) / 10) + 'd lag';
}

function cashTicker(sym) {
  const s = String(sym || '').toUpperCase();
  return s.endsWith('USDT') ? s.slice(0, -4) : s;
}

function perpSymbol(ticker) {
  const t = String(ticker || '').toUpperCase().replace(/USDT$/, '');
  return t + 'USDT';
}

function isRthNewYork(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const wd = get('weekday');
  if (['Sat', 'Sun'].includes(wd)) return false;
  const mins = Number(get('hour')) * 60 + Number(get('minute'));
  return mins >= (9 * 60 + 30) && mins < (16 * 60);
}

function isEdgarWindow(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const wd = get('weekday');
  if (['Sat', 'Sun'].includes(wd)) return false;
  const mins = Number(get('hour')) * 60 + Number(get('minute'));
  return mins >= (6 * 60) && mins < (22 * 60 + 30);
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}

async function httpJson(url, { timeout = 25000, headers = {}, method = 'GET', body = null, userAgent = 'QuantSignalDashboard/1.0' } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      signal: ctl.signal,
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/json, application/xml, text/plain, */*',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body == null ? undefined : (Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    let json = null, text = null;
    if (ctype.includes('json') || buf[0] === 0x7b || buf[0] === 0x5b) {
      try { json = JSON.parse(buf.toString('utf8')); } catch { text = buf.toString('utf8'); }
    } else {
      text = buf.toString('utf8');
      try { if (text && (text[0] === '{' || text[0] === '[')) json = JSON.parse(text); } catch {}
    }
    return {
      ok: res.ok, status: res.status,
      json, text, buf,
      lastModified: res.headers.get('last-modified') || null,
    };
  } finally { clearTimeout(t); }
}

function sourceMeta({ name, asOf, asOfMs, lag, note, status = 'ok' }) {
  return { name, asOf: asOf || (asOfMs ? toIST(asOfMs) : null), asOfMs: asOfMs || null, lag: lag || lagLabel(asOfMs), note: note || null, status };
}

module.exports = {
  FEATURED, CUSIP, CIK, secUserAgent, cacheDir, toIST, lagLabel, cashTicker, perpSymbol,
  isRthNewYork, isEdgarWindow, writeJsonAtomic, readJson, httpJson, sourceMeta,
};
