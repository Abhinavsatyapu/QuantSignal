'use strict';
// Public Binance USD-M liquidation tape. No REST history — persist the stream or show an empty window.
const { nextWsBackoff, wsNeedsWatchdog } = require('./binance-prices');
const { toIST, cashTicker } = require('./whales-util');

const KEEP_MS = 48 * 3600e3;
const WATCHDOG_MS = 20000;

function ForceOrderTape(opts = {}) {
  const allowed = new Set((opts.symbols || []).map((s) => String(s).toUpperCase()));
  const store = opts.store;
  const state = {
    transport: 'idle', lastAt: 0, lastError: null, reconnects: 0, watchdogRestarts: 0,
    wsBackoffMs: 0, stopped: true, ws: null, timers: [], reconnectTimer: null, count48h: 0,
  };

  function ensureTable() {
    if (!store || !store.db) return;
    store.db.exec(`CREATE TABLE IF NOT EXISTS bn_liquidations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT,
      qty REAL,
      price REAL,
      notional REAL,
      raw TEXT
    );
    CREATE INDEX IF NOT EXISTS bn_liq_ts ON bn_liquidations(ts);
    CREATE INDEX IF NOT EXISTS bn_liq_sym_ts ON bn_liquidations(symbol, ts);`);
  }

  function prune() {
    if (!store || !store.db) return;
    const cut = Date.now() - KEEP_MS;
    try { store.db.prepare('DELETE FROM bn_liquidations WHERE ts < ?').run(cut); } catch {}
  }

  function insert(row) {
    if (!store || !store.db) return;
    try {
      store.db.prepare('INSERT INTO bn_liquidations(ts,symbol,side,qty,price,notional,raw) VALUES(?,?,?,?,?,?,?)')
        .run(row.ts, row.symbol, row.side, row.qty, row.price, row.notional, row.raw != null ? JSON.stringify(row.raw) : null);
    } catch {}
  }

  function ingest(msg) {
    const o = (msg && (msg.o || msg.order || msg)) || {};
    const symbol = String(o.s || o.symbol || '').toUpperCase();
    if (!symbol) return null;
    if (allowed.size && !allowed.has(symbol)) return null;
    const price = Number(o.ap || o.p || o.price);
    const qty = Number(o.z || o.q || o.qty || o.l);
    const side = String(o.S || o.side || '').toUpperCase(); // BUY = long liq? Binance: S is side of the force order (sell = long liquidation)
    const ts = Number(o.T || msg.E || Date.now());
    if (!(price > 0) || !(qty > 0)) return null;
    const row = {
      symbol, side, price, qty, notional: +(price * qty).toFixed(2), ts,
      raw: { e: msg.e, X: o.X, o: o.o },
    };
    insert(row);
    state.lastAt = Date.now();
    state.lastError = null;
    return row;
  }

  function recent({ symbol, limit = 40, sinceMs } = {}) {
    if (!store || !store.db) return [];
    const since = sinceMs != null ? sinceMs : (Date.now() - KEEP_MS);
    const n = Math.min(200, Math.max(1, Number(limit) || 40));
    const rows = symbol
      ? store.db.prepare('SELECT ts,symbol,side,qty,price,notional FROM bn_liquidations WHERE symbol=? AND ts>=? ORDER BY ts DESC LIMIT ?').all(String(symbol).toUpperCase(), since, n)
      : store.db.prepare('SELECT ts,symbol,side,qty,price,notional FROM bn_liquidations WHERE ts>=? ORDER BY ts DESC LIMIT ?').all(since, n);
    return rows.map((r) => ({ ...r, tsIst: toIST(r.ts), ticker: cashTicker(r.symbol) }));
  }

  function countSince(ms) {
    if (!store || !store.db) return 0;
    try { return store.db.prepare('SELECT COUNT(*) AS n FROM bn_liquidations WHERE ts>=?').get(ms).n; } catch { return 0; }
  }

  function scheduleReconnect(reason) {
    if (state.stopped) return;
    if (state.reconnectTimer) return;
    state.wsBackoffMs = nextWsBackoff(state.wsBackoffMs);
    state.reconnects += 1;
    state.lastError = reason || state.lastError;
    state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; connect(); }, state.wsBackoffMs);
  }

  function connect() {
    if (state.stopped) return;
    let WebSocket;
    try { WebSocket = require('ws'); } catch { state.transport = 'unavailable'; return; }
    const url = (opts.url) || 'wss://fstream.binance.com/ws/!forceOrder@arr';
    try {
      if (state.ws) {
        try { state.ws.removeAllListeners(); state.ws.on('error', () => {}); state.ws.close(); } catch {}
        state.ws = null;
      }
      const ws = new WebSocket(url);
      state.ws = ws;
      let opened = false;
      const failTimer = setTimeout(() => { if (!opened && !state.stopped) { try { ws.close(); } catch {} } }, 8000);
      state.timers.push(failTimer);
      ws.on('open', () => {
        opened = true; clearTimeout(failTimer);
        state.transport = 'ws'; state.wsBackoffMs = 0; state.lastError = null; state.lastAt = Date.now();
      });
      ws.on('message', (buf) => {
        let msg; try { msg = JSON.parse(String(buf)); } catch { return; }
        ingest(msg);
        state.transport = 'ws';
      });
      ws.on('close', () => {
        if (state.ws === ws) state.ws = null;
        clearTimeout(failTimer);
        state.transport = 'closed';
        scheduleReconnect('websocket closed');
      });
      ws.on('error', (e) => {
        state.lastError = e.message;
        state.transport = 'error';
      });
    } catch (e) {
      state.lastError = e.message;
      scheduleReconnect(e.message);
    }
  }

  function start() {
    state.stopped = false;
    ensureTable();
    prune();
    state.timers.push(setInterval(prune, 30 * 60e3));
    state.timers.push(setInterval(() => {
      if (state.stopped) return;
      if (!wsNeedsWatchdog(state.lastAt, state.transport === 'ws' ? 'ws' : 'rest', Date.now(), WATCHDOG_MS)) return;
      // After a quiet book, lastAt can be stale even with a healthy socket (no liqs).
      // Only restart if the socket is missing or last open/message is very stale AND transport claims ws with no socket.
      if (!state.ws) {
        state.watchdogRestarts += 1;
        scheduleReconnect('watchdog: socket missing');
      }
    }, 10000));
    connect();
  }

  function stop() {
    state.stopped = true;
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    for (const t of state.timers) { clearInterval(t); clearTimeout(t); }
    state.timers = [];
    if (state.ws) {
      const prev = state.ws; state.ws = null;
      try { prev.removeAllListeners(); prev.on('error', () => {}); prev.close(); } catch {}
    }
  }

  function snapshot() {
    const n = countSince(Date.now() - KEEP_MS);
    state.count48h = n;
    return {
      source: 'Binance USDⓈ-M public WebSocket !forceOrder@arr',
      asOf: state.lastAt ? toIST(state.lastAt) : null,
      asOfMs: state.lastAt || null,
      lag: state.lastAt ? 'live stream' : null,
      transport: state.transport,
      lastError: state.lastError,
      reconnects: state.reconnects,
      watchdogRestarts: state.watchdogRestarts,
      count48h: n,
      recent: recent({ limit: 40 }),
      note: 'Largest force-order per symbol per second. No REST backfill — an empty window means no prints were captured since this process started (or none occurred), not “no liquidations ever.”',
    };
  }

  function setSymbols(symbols) {
    allowed.clear();
    for (const s of symbols || []) allowed.add(String(s).toUpperCase());
  }

  return { state, start, stop, ingest, recent, snapshot, setSymbols, ensureTable, prune };
}

module.exports = { ForceOrderTape, KEEP_MS };
