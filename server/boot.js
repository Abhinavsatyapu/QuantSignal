'use strict';
// Process guards and listen-first boot helpers. No secrets, no I/O on load.

function isTransientExternal(e) {
  if (!e) return false;
  const name = e.name || '';
  const msg = String(e.message || e);
  const code = e.code;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  if (e.status === 429 || e.status === 451) return true;
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'UND_ERR_CONNECT_TIMEOUT') return true;
  return /aborted due to timeout|TimeoutError|HTTP 429|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|network timeout|The operation was aborted/i.test(msg);
}

function installProcessGuards(logger) {
  if (installProcessGuards.installed) return;
  installProcessGuards.installed = true;
  const log = logger || {
    warn: (msg, meta) => console.warn(JSON.stringify({ level: 'warn', msg, ...(meta || {}) })),
    error: (msg, meta) => console.error(JSON.stringify({ level: 'error', msg, ...(meta || {}) })),
  };
  const report = (kind, e) => {
    const error = e && (e.message || String(e));
    if (isTransientExternal(e)) log.warn(kind + '.swallowed', { error });
    else log.error(kind, { error });
  };
  process.on('unhandledRejection', (e) => report('unhandledRejection', e));
  process.on('uncaughtException', (e) => report('uncaughtException', e));
}

function listenThenWarmup(app, { port, host, warmup, onListening, log } = {}) {
  const bindPort = port == null || port === '' ? (Number(process.env.PORT) || 8787) : Number(port);
  const bindHost = host || process.env.HOST || '0.0.0.0';
  let server;
  const listening = new Promise((resolve, reject) => {
    server = app.listen(bindPort, bindHost, () => {
      try { if (typeof onListening === 'function') onListening(server); }
      catch (e) { if (log && log.error) log.error('onListening', { error: e.message }); }
      resolve(server);
      setImmediate(() => {
        Promise.resolve()
          .then(() => (typeof warmup === 'function' ? warmup() : undefined))
          .catch((e) => { if (log && log.error) log.error('warmup.failed', { error: e && e.message }); });
      });
    });
    server.on('error', reject);
  });
  return { server, listening, host: bindHost, port: bindPort };
}

module.exports = { isTransientExternal, installProcessGuards, listenThenWarmup };
