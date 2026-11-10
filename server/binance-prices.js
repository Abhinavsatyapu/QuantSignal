'use strict';
// Live Binance USDⓈ-M mark / book / kline feed for the UI and the trader.
// Public data only (no keys). Prefers WebSocket; falls back to REST polling when WS is geo-blocked.
const { EventEmitter } = require('events');
const bn = require('./binance');

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT'];

function Prices(opts = {}) {
  const symbols = (opts.symbols || DEFAULT_SYMBOLS).map((s) => String(s).toUpperCase());
  const client = opts.client || bn.Client({});
  const emitter = new EventEmitter();
  const state = {
    source: 'Binance USDⓈ-M',
    transport: 'idle', // ws | rest | blocked
    lastUpdateAt: 0,
    lastError: null,
    geoBlocked: false,
    marks: {}, // symbol → { markPrice, indexPrice, lastPrice, bid, ask, ts }
    ws: null,
    timers: [],
  };
  const MAX_REFRESH_MS = Number(opts.maxRefreshMs) > 0 ? Number(opts.maxRefreshMs) : 5000;
  const STALE_MS = Number(opts.staleMs) > 0 ? Number(opts.staleMs) : 10000;

  let restBusy = false;
  async function restTick() {
    if (restBusy) return;
    restBusy = true;
    try {
      const wanted = new Set(symbols);
      let markRows, bookRows;
      try {
        const [marks, books] = await Promise.all([
          client.markPrice(),
          client.publicGet('/fapi/v1/ticker/bookTicker').catch(() => []),
        ]);
        markRows = Array.isArray(marks) ? marks : (marks ? [marks] : []);
        bookRows = Array.isArray(books) ? books : (books ? [books] : []);
      } catch (e) {
        if (e.status === 451 || e.status === 403 || /restricted location/i.test(e.message || '')) state.geoBlocked = true;
        // Fallback: small concurrent batches instead of one request per symbol in parallel.
        markRows = [];
        bookRows = [];
        const chunk = 4;
        for (let i = 0; i < symbols.length; i += chunk) {
          const part = symbols.slice(i, i + chunk);
          const got = await Promise.all(part.map(async (symbol) => {
            try {
              const [m, t] = await Promise.all([
                client.markPrice(symbol),
                client.publicGet('/fapi/v1/ticker/bookTicker', { symbol }).catch(() => null),
              ]);
              return { m, t, symbol };
            } catch (err) {
              if (err.status === 451 || err.status === 403) state.geoBlocked = true;
              return null;
            }
          }));
          for (const row of got) {
            if (!row || !row.m) continue;
            markRows.push(Object.assign({ symbol: row.symbol }, row.m));
            if (row.t) bookRows.push(Object.assign({ symbol: row.symbol }, row.t));
          }
        }
      }
      const bookBy = new Map();
      for (const t of bookRows) {
        const sym = String(t.symbol || '').toUpperCase();
        if (wanted.has(sym)) bookBy.set(sym, t);
      }
      const now = Date.now();
      let n = 0;
      for (const m of markRows) {
        const symbol = String(m.symbol || '').toUpperCase();
        if (!wanted.has(symbol)) continue;
        const markPrice = Number(m.markPrice);
        if (!(markPrice > 0)) continue;
        const t = bookBy.get(symbol);
        const prev = state.marks[symbol] || {};
        state.marks[symbol] = {
          symbol,
          markPrice,
          indexPrice: Number(m.indexPrice),
          lastPrice: markPrice,
          bid: t ? Number(t.bidPrice) : (prev.bid ?? null),
          ask: t ? Number(t.askPrice) : (prev.ask ?? null),
          ts: now,
        };
        n++;
      }
      if (n) {
        state.lastUpdateAt = now;
        state.lastError = null;
        if (state.transport !== 'ws') state.transport = 'rest';
        emitter.emit('update', snapshot());
      }
    } catch (e) {
      state.lastError = e.message;
      if (e.status === 451 || /restricted location/i.test(e.message)) state.geoBlocked = true;
      emitter.emit('error', e);
    } finally {
      restBusy = false;
    }
  }

  function connectWs() {
    let WebSocket;
    try { WebSocket = require('ws'); } catch { state.transport = 'rest'; return; }
    const streams = symbols.flatMap((s) => {
      const x = s.toLowerCase();
      return [x + '@markPrice@1s', x + '@bookTicker'];
    }).join('/');
    const url = client.urls().ws + '/stream?streams=' + streams;
    try {
      if (state.ws) { try { state.ws.close(); } catch {} }
      const ws = new WebSocket(url);
      state.ws = ws;
      let opened = false;
      const failTimer = setTimeout(() => {
        if (!opened) { try { ws.close(); } catch {}; state.transport = state.geoBlocked ? 'blocked' : 'rest'; }
      }, 8000);
      ws.on('open', () => { opened = true; clearTimeout(failTimer); state.transport = 'ws'; state.lastUpdateAt = Date.now(); emitter.emit('ws', 'open'); });
      ws.on('message', (buf) => {
        let msg; try { msg = JSON.parse(String(buf)); } catch { return; }
        const d = msg.data || msg;
        const stream = msg.stream || '';
        const sym = (d.s || '').toUpperCase();
        if (!sym) return;
        const cur = state.marks[sym] || { symbol: sym };
        if (stream.includes('markPrice') || d.e === 'markPriceUpdate') {
          cur.markPrice = Number(d.p || d.markPrice); cur.indexPrice = Number(d.i || d.indexPrice); cur.ts = Date.now();
        } else if (stream.includes('bookTicker') || d.e === 'bookTicker') {
          cur.bid = Number(d.b); cur.ask = Number(d.a); cur.lastPrice = Number(d.b || d.a); cur.ts = Date.now();
          if (!(cur.markPrice > 0)) cur.markPrice = cur.lastPrice;
        }
        state.marks[sym] = cur; state.lastUpdateAt = Date.now();
        emitter.emit('update', snapshot());
      });
      ws.on('close', () => {
        state.transport = 'rest'; emitter.emit('ws', 'closed');
        setTimeout(connectWs, 5000); // auto-reconnect; REST keeps ticking in parallel
      });
      ws.on('error', (e) => {
        state.lastError = e.message;
        if (/451|403|restricted/i.test(e.message)) state.geoBlocked = true;
        state.transport = state.geoBlocked ? 'blocked' : 'rest';
        emitter.emit('ws', 'error', e);
      });
    } catch (e) {
      state.lastError = e.message; state.transport = 'rest';
    }
  }

  function snapshot() {
    const now = Date.now();
    const ageMs = state.lastUpdateAt ? Math.max(0, now - state.lastUpdateAt) : null;
    return {
      source: state.source,
      transport: state.transport,
      lastUpdateAt: state.lastUpdateAt,
      lastError: state.lastError,
      geoBlocked: state.geoBlocked,
      marks: { ...state.marks },
      symbols,
      serverNow: now,
      ageMs,
      stale: ageMs == null || ageMs > STALE_MS,
      maxRefreshMs: MAX_REFRESH_MS,
      staleMs: STALE_MS,
      note: state.geoBlocked
        ? 'Binance returned HTTP 451 (geo-restricted) from this host. Move the Render service to Frankfurt or Singapore, or use a non-US egress IP.'
        : null,
    };
  }

  function start() {
    // Always keep a REST heartbeat ≤5s so UI + bot stay fresh even if WS stalls.
    restTick();
    state.timers.push(setInterval(restTick, MAX_REFRESH_MS));
    state.timers.push(setInterval(() => {
      const age = state.lastUpdateAt ? Date.now() - state.lastUpdateAt : Infinity;
      if (age >= MAX_REFRESH_MS) restTick();
    }, 1000));
    connectWs();
  }
  function stop() {
    for (const t of state.timers) clearInterval(t);
    state.timers = [];
    if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  }
  function mark(symbol) { const m = state.marks[String(symbol).toUpperCase()]; return m && m.markPrice > 0 ? m.markPrice : null; }

  return { state, emitter, start, stop, snapshot, mark, restTick, symbols };
}

module.exports = { Prices, DEFAULT_SYMBOLS };
