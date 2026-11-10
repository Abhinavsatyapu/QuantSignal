'use strict';
// Shared, memory-light rate limiter for Binance public REST (scanner, prices, whales, universe).

function createLimiter(opts = {}) {
  const maxConcurrent = opts.maxConcurrent > 0 ? opts.maxConcurrent : 2;
  const minIntervalMs = opts.minIntervalMs >= 0 ? opts.minIntervalMs : 80;
  const q = [];
  let inflight = 0;
  let lastStart = 0;
  let pauseUntil = 0;
  let timer = null;

  function cmp(a, b) { return (a.pri - b.pri) || (a.id - b.id); }

  function arm(ms) {
    if (timer) return;
    timer = setTimeout(() => { timer = null; pump(); }, Math.max(0, ms));
  }

  function pump() {
    const now = Date.now();
    if (pauseUntil > now) { arm(pauseUntil - now); return; }
    if (inflight >= maxConcurrent) return;
    if (!q.length) return;
    const wait = lastStart + minIntervalMs - now;
    if (wait > 0) { arm(wait); return; }
    q.sort(cmp);
    const job = q.shift();
    if (job.signal && job.signal.aborted) {
      job.reject(abortError(job.signal));
      return pump();
    }
    inflight += 1;
    lastStart = Date.now();
    Promise.resolve()
      .then(() => job.fn())
      .then(job.resolve, job.reject)
      .finally(() => { inflight -= 1; pump(); });
    if (q.length) arm(minIntervalMs);
  }

  let seq = 0;
  function schedule(fn, opts2 = {}) {
    const pri = opts2.priority === 'high' ? 0 : opts2.priority === 'low' ? 2 : 1;
    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject, pri, id: ++seq, signal: opts2.signal || null, done: false };
      const finish = (kind, value) => {
        if (job.done) return;
        job.done = true;
        if (kind === 'ok') resolve(value);
        else reject(value);
      };
      job.resolve = (v) => finish('ok', v);
      job.reject = (e) => finish('err', e);
      if (job.signal) {
        const onAb = () => {
          const i = q.indexOf(job);
          if (i >= 0) q.splice(i, 1);
          job.reject(abortError(job.signal));
        };
        if (job.signal.aborted) { job.reject(abortError(job.signal)); return; }
        job.signal.addEventListener('abort', onAb, { once: true });
      }
      q.push(job);
      pump();
    });
  }

  function pause(ms) {
    pauseUntil = Math.max(pauseUntil, Date.now() + Math.max(0, ms));
    arm(pauseUntil - Date.now());
  }

  function stats() {
    return { inflight, queued: q.length, pauseUntil, maxConcurrent, minIntervalMs };
  }

  return { schedule, pause, stats };
}

function abortError(signal) {
  const err = new Error((signal && signal.reason) || 'aborted');
  err.name = 'AbortError';
  return err;
}

const shared = createLimiter({ maxConcurrent: 2, minIntervalMs: 80 });

module.exports = {
  createLimiter,
  schedule: (fn, opts) => shared.schedule(fn, opts),
  pause: (ms) => shared.pause(ms),
  stats: () => shared.stats(),
  shared,
  abortError,
};
