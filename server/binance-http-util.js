'use strict';
// Shared HTTP helpers for Binance public REST: abortable waits, hard deadlines,
// and IP-ban tracking so callers can fail fast and use non-REST fallbacks.

const { abortError } = require('./binance-limiter');

let bannedUntil = 0;
let lastBanMessage = null;

function parseBanUntil(text) {
  if (text == null) return 0;
  const s = String(text);
  const m = s.match(/banned until\s+(\d+)/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Binance uses ms since epoch; accept seconds too.
  return n < 1e12 ? n * 1000 : n;
}

function noteBan(textOrMs, now = Date.now()) {
  const until = typeof textOrMs === 'number' ? textOrMs : parseBanUntil(textOrMs);
  if (until > now && until > bannedUntil) {
    bannedUntil = until;
    if (typeof textOrMs === 'string') lastBanMessage = textOrMs.slice(0, 240);
  }
  return bannedUntil;
}

function noteBanFromError(err) {
  if (!err) return bannedUntil;
  const parts = [err.message, err.status, err.code];
  if (err.data) parts.push(typeof err.data === 'string' ? err.data : (err.data.msg || err.data.message));
  const text = parts.filter(Boolean).join(' ');
  if (err.status === 418 || err.status === 429 || /banned until|too many requests/i.test(text)) {
    const until = parseBanUntil(text);
    if (until) noteBan(until);
    else if (err.status === 418) noteBan(Date.now() + 60e3);
    else if (err.status === 429) noteBan(Date.now() + 5e3);
  }
  return bannedUntil;
}

function isBanned(now = Date.now()) { return now < bannedUntil; }
function bannedUntilMs() { return bannedUntil; }
function banInfo() {
  return { banned: isBanned(), bannedUntil: bannedUntil || null, message: lastBanMessage };
}
function _resetBanForTests() { bannedUntil = 0; lastBanMessage = null; }

function abortableSleep(ms, signal) {
  const wait = Math.max(0, Number(ms) || 0);
  if (signal && signal.aborted) return Promise.reject(abortError(signal));
  if (wait === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, wait);
    function onAbort() {
      clearTimeout(t);
      reject(abortError(signal));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function withDeadline(promise, ms, signal, label = 'timeout') {
  const limit = Number(ms) > 0 ? Number(ms) : 8000;
  if (signal && signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(label);
      err.name = 'TimeoutError';
      cleanup();
      reject(err);
    }, limit);
    function onAbort() {
      cleanup();
      reject(abortError(signal));
    }
    function cleanup() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then((v) => { cleanup(); resolve(v); }, (e) => { cleanup(); reject(e); });
  });
}

module.exports = {
  parseBanUntil, noteBan, noteBanFromError, isBanned, bannedUntilMs, banInfo,
  abortableSleep, withDeadline, _resetBanForTests,
};
