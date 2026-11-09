'use strict';
// Binance USDⓈ-M Futures auto-trader (parallel to Hyperliquid). Default DRY-RUN: no signed
// orders unless BINANCE_LIVE=yes AND keys AND allowSignedOrders. Entry: LIMIT first, then
// MARKET for unfilled qty after entryTimeoutSec (default 120). Restart-safe via bn_pending.
const crypto = require('crypto');
const config = require('./config');
const store = require('./db');
const bn = require('./binance');
const { Prices, DEFAULT_SYMBOLS } = require('./binance-prices');
const universe = require('./binance-universe');
const sm = require('./binance-order-sm');
require('../public/indicators.js');
require('../public/strategy-liquidity-signals.js');
const { Technicals, LiquiditySignals } = globalThis;

const state = {
  startedAt: Date.now(), lastSignalAt: 0, lastScanAt: 0, nextScanAt: 0, lastReconcileAt: 0,
  lastListenKeyAt: 0, scanBusy: false, lastScanError: null, streamStatus: 'idle',
  pausedReason: null, day: null, dayStartEquity: null, dayRealizedPnl: 0,
  positionsMissingStops: [], lastError: null, client: null, symbolInfo: null,
  marks: {}, executing: new Set(), timers: [], prices: null,
};

const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10); // legacy
/** Calendar day in Asia/Calcutta (IST, UTC+5:30) — used for daily P&L target / loss halt / compounding reset. */
const istDay = (t = Date.now()) => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);
const istDayStartMs = (dayStr) => Date.parse(dayStr + 'T00:00:00+05:30');
const cfgBn = () => ({ ...config.BINANCE_DEFAULTS, ...(config.get().binance || {}) });
const dirSign = (d) => (d === 'LONG' || d === 'BUY' ? 1 : -1);

function modeInfo() {
  const rt = bn.runtime();
  const c = cfgBn();
  const allowOrders = rt.keyPresent && rt.liveEnabled && !!c.allowSignedOrders;
  const allowTestnetOrders = rt.keyPresent && !rt.liveEnabled && !!c.allowTestnetOrders && process.env.BINANCE_ALLOW_TESTNET_ORDERS === 'yes';
  return {
    ...rt, dryRun: !(allowOrders || allowTestnetOrders),
    placingOn: allowOrders ? 'live' : allowTestnetOrders ? 'testnet' : 'dry_run',
    allowOrders, allowTestnetOrders,
  };
}

function ensureTables() {
  store.db.exec(`
CREATE TABLE IF NOT EXISTS bn_signals(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, symbol TEXT NOT NULL,
  direction TEXT NOT NULL, interval TEXT, entry REAL, stop REAL, tp REAL, score INTEGER, closed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'new', reason TEXT, dedupe_key TEXT UNIQUE, raw TEXT);
CREATE TABLE IF NOT EXISTS bn_trades(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, signal_id INTEGER, symbol TEXT NOT NULL, direction TEXT NOT NULL,
  mode TEXT NOT NULL, network TEXT NOT NULL, qty REAL, filled_qty REAL, entry_px REAL, stop_px REAL, tp_px REAL,
  notional REAL, leverage REAL, margin REAL, status TEXT NOT NULL, entry_type TEXT,
  exit_px REAL, exit_ts INTEGER, exit_reason TEXT, pnl REAL, fees REAL,
  entry_cid TEXT, stop_cid TEXT, tp_cid TEXT, entry_oid TEXT, stop_oid TEXT, tp_oid TEXT,
  stop_status TEXT, tp_status TEXT, orders TEXT, response TEXT);
CREATE TABLE IF NOT EXISTS bn_pending(
  id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER NOT NULL UNIQUE, symbol TEXT NOT NULL, direction TEXT NOT NULL,
  limit_cid TEXT NOT NULL, market_cid TEXT, limit_oid TEXT, target_qty REAL NOT NULL, filled_qty REAL NOT NULL DEFAULT 0,
  limit_px REAL, deadline_ts INTEGER NOT NULL, stop_px REAL, tp_px REAL, leverage REAL, status TEXT NOT NULL DEFAULT 'waiting',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bn_client_orders(
  client_order_id TEXT PRIMARY KEY, trade_id INTEGER, kind TEXT NOT NULL, symbol TEXT NOT NULL, ts INTEGER NOT NULL, exchange_order_id TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS bn_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL, msg TEXT NOT NULL, data TEXT);
CREATE TABLE IF NOT EXISTS bn_equity_days(day TEXT PRIMARY KEY, start_equity REAL NOT NULL, mode TEXT, realized_pnl REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS bn_scans(
  symbol TEXT NOT NULL, interval TEXT NOT NULL, ts INTEGER NOT NULL, closed_at INTEGER, direction TEXT, score INTEGER, data TEXT,
  PRIMARY KEY(symbol, interval));
CREATE INDEX IF NOT EXISTS idx_bn_trades_status ON bn_trades(status);
CREATE INDEX IF NOT EXISTS idx_bn_pending_status ON bn_pending(status);
`);
  // Additive lifecycle columns (idempotent ALTER)
  for (const col of [
    "ALTER TABLE bn_trades ADD COLUMN filled_at INTEGER",
    "ALTER TABLE bn_trades ADD COLUMN unprotected_since INTEGER",
    "ALTER TABLE bn_trades ADD COLUMN protect_qty REAL",
    "ALTER TABLE bn_trades ADD COLUMN lifecycle_note TEXT",
  ]) { try { store.db.exec(col); } catch {} }
}

function blog(level, msg, data) {
  const ts = Date.now();
  try { store.db.prepare('INSERT INTO bn_events(ts,level,msg,data) VALUES(?,?,?,?)').run(ts, level, msg, data == null ? null : JSON.stringify(data)); } catch {}
  store.log(level, '[bn] ' + msg, data);
}
function insertSignal(s) {
  const info = store.db.prepare(`INSERT OR IGNORE INTO bn_signals(ts,source,symbol,direction,interval,entry,stop,tp,score,closed_at,status,reason,dedupe_key,raw)
    VALUES(@ts,@source,@symbol,@direction,@interval,@entry,@stop,@tp,@score,@closed_at,@status,@reason,@dedupe_key,@raw)`)
    .run({ ts: Date.now(), interval: null, entry: null, stop: null, tp: null, score: null, closed_at: null, status: 'new', reason: null, dedupe_key: null, ...s, raw: s.raw == null ? null : JSON.stringify(s.raw) });
  return info.changes ? info.lastInsertRowid : null;
}
function setSignalStatus(id, status, reason) { if (id) store.db.prepare('UPDATE bn_signals SET status=?, reason=? WHERE id=?').run(status, reason || null, id); }
function insertTrade(t) {
  return store.db.prepare(`INSERT INTO bn_trades(ts,signal_id,symbol,direction,mode,network,qty,filled_qty,entry_px,stop_px,tp_px,notional,leverage,margin,status,entry_type,entry_cid,stop_cid,tp_cid,entry_oid,stop_oid,tp_oid,stop_status,tp_status,orders,response)
    VALUES(@ts,@signal_id,@symbol,@direction,@mode,@network,@qty,@filled_qty,@entry_px,@stop_px,@tp_px,@notional,@leverage,@margin,@status,@entry_type,@entry_cid,@stop_cid,@tp_cid,@entry_oid,@stop_oid,@tp_oid,@stop_status,@tp_status,@orders,@response)`)
    .run({
      signal_id: null, qty: null, filled_qty: 0, entry_px: null, stop_px: null, tp_px: null, notional: null, leverage: null, margin: null,
      entry_type: 'limit', entry_cid: null, stop_cid: null, tp_cid: null, entry_oid: null, stop_oid: null, tp_oid: null,
      stop_status: null, tp_status: null, ...t, ts: Date.now(),
      orders: t.orders == null ? null : JSON.stringify(t.orders), response: t.response == null ? null : JSON.stringify(t.response),
    }).lastInsertRowid;
}
function closeTrade(id, status, px, reason, pnl, fees) {
  const row = store.db.prepare('SELECT status FROM bn_trades WHERE id=?').get(id);
  const target = status === 'closed' ? sm.STATES.CLOSED : status === 'cancelled' ? sm.STATES.CANCELLED : (status || sm.STATES.CLOSED);
  if (row) {
    const tr = sm.transition(row.status, target, { reason });
    if (!tr.ok && !tr.noop) { blog('warn', `closeTrade illegal ${row.status}→${target}: ${tr.reason}`); }
  }
  store.db.prepare('UPDATE bn_trades SET status=?, exit_px=?, exit_ts=?, exit_reason=?, pnl=?, fees=COALESCE(?,fees) WHERE id=?')
    .run(target, px, Date.now(), reason, pnl, fees == null ? null : fees, id);
  try { require('./persist').mark('bn_trades', id); } catch {}
  try {
    const row = store.db.prepare('SELECT * FROM bn_trades WHERE id=?').get(id);
    if (row) require('./trade-lessons').recordLesson(row);
  } catch (e) { blog('warn', 'trade-lessons: ' + e.message); }
}
/** Idempotent persisted state transition. Returns transition result. */
function transitionTrade(id, to, meta = {}) {
  const row = store.db.prepare('SELECT * FROM bn_trades WHERE id=?').get(id);
  if (!row) return { ok: false, reason: 'missing trade' };
  const tr = sm.transition(row.status, to, meta);
  if (!tr.ok) { blog('warn', `SM reject #${id} ${tr.from}→${tr.to}: ${tr.reason}`); return tr; }
  if (tr.noop) return tr;
  const sets = ['status=?'];
  const vals = [tr.to];
  if (tr.to === sm.STATES.FILLED || tr.to === sm.STATES.PARTIAL) {
    sets.push('filled_at=COALESCE(filled_at,?)', 'unprotected_since=COALESCE(unprotected_since,?)');
    vals.push(Date.now(), Date.now());
  }
  if (tr.to === sm.STATES.PROTECTED) {
    sets.push('unprotected_since=NULL', 'protect_qty=?');
    vals.push(meta.protectQty != null ? meta.protectQty : (row.filled_qty || row.qty));
  }
  if (meta.note) { sets.push('lifecycle_note=?'); vals.push(meta.note); }
  vals.push(id);
  store.db.prepare(`UPDATE bn_trades SET ${sets.join(',')} WHERE id=?`).run(...vals);
  try { require('./persist').mark('bn_trades', id); } catch {}
  return tr;
}
function rememberCid(cid, tradeId, kind, symbol, exchangeOrderId, status) {
  store.db.prepare('INSERT OR REPLACE INTO bn_client_orders(client_order_id,trade_id,kind,symbol,ts,exchange_order_id,status) VALUES(?,?,?,?,?,?,?)')
    .run(cid, tradeId, kind, symbol, Date.now(), exchangeOrderId || null, status || 'new');
  try { require('./persist').mark('bn_client_orders', cid); } catch {}
}
function cidTaken(cid) { return !!store.db.prepare('SELECT 1 FROM bn_client_orders WHERE client_order_id=?').get(cid); }
function openTrades() {
  return store.db.prepare('SELECT * FROM bn_trades ORDER BY id DESC').all()
    .filter((t) => sm.isActiveStatus(t.status));
}
function pendingRows() { return store.db.prepare("SELECT * FROM bn_pending WHERE status='waiting' ORDER BY id").all(); }

function refreshDay(equity) {
  const day = istDay(), mode = modeInfo().placingOn;
  let row = store.db.prepare('SELECT * FROM bn_equity_days WHERE day=?').get(day);
  if (!row || row.mode !== mode) {
    // New IST day: lock start equity = current equity (compounding base for today's 2% risk / 5% target / 6% halt)
    store.db.prepare('INSERT OR REPLACE INTO bn_equity_days(day,start_equity,mode,realized_pnl) VALUES(?,?,?,0)').run(day, equity, mode);
    row = { day, start_equity: equity, mode, realized_pnl: 0 };
    if (state.pausedReason && /Daily profit target/.test(state.pausedReason)) state.pausedReason = null;
  }
  state.day = day; state.dayStartEquity = row.start_equity;
  const dayStart = istDayStartMs(day) || 0;
  const closed = store.db.prepare("SELECT COALESCE(SUM(pnl),0) p FROM bn_trades WHERE status IN ('closed','CLOSED') AND exit_ts>=?").get(dayStart);
  state.dayRealizedPnl = closed.p;
  return row;
}
function checkDailyLimits(equity) {
  const c = cfgBn();
  if (c.killSwitch) return { dayPnl: 0, dayPct: 0, lossBreached: false, profitReached: false };
  const start = state.dayStartEquity || equity;
  const dayPnl = equity - start;
  const dayPct = start ? (dayPnl / start) * 100 : 0;
  const lossBreached = c.dailyLossLimitPct > 0 && dayPct <= -c.dailyLossLimitPct;
  const profitReached = c.dailyProfitTargetPct > 0 && dayPct >= c.dailyProfitTargetPct;
  // Halts are OFF by default — targets/limits are informational unless explicitly enabled
  if (lossBreached && c.dailyLossHaltEnabled) {
    config.update({ binance: { killSwitch: true } });
    state.pausedReason = `Daily loss halt (${dayPct.toFixed(2)}% ≤ −${c.dailyLossLimitPct}%). Auto-paused.`;
    blog('warn', state.pausedReason, { equity, start, dayPnl });
  } else if (profitReached && c.dailyProfitHaltEnabled) {
    state.pausedReason = `Daily profit halt (+${dayPct.toFixed(2)}% ≥ ${c.dailyProfitTargetPct}%). New entries paused until next IST day.`;
  } else if (state.pausedReason && /Daily (loss|profit) halt/.test(state.pausedReason) && !c.dailyLossHaltEnabled && !c.dailyProfitHaltEnabled) {
    state.pausedReason = null;
  }
  return { dayPnl, dayPct, lossBreached, profitReached };
}
function equityNow() {
  const c = cfgBn();
  const realized = store.db.prepare("SELECT COALESCE(SUM(pnl),0) p FROM bn_trades WHERE status IN ('closed','CLOSED') AND mode='dry_run'").get().p;
  let unreal = 0;
  for (const t of openTrades()) {
    const st = sm.normalize(t.status); if (t.mode !== 'dry_run' || !(st === sm.STATES.PROTECTED || st === sm.STATES.FILLED || st === sm.STATES.PARTIAL)) continue;
    const mark = markOf(t.symbol);
    if (mark > 0 && t.entry_px > 0) unreal += (mark - t.entry_px) * (t.filled_qty || t.qty) * dirSign(t.direction);
  }
  return c.capital + realized + unreal;
}
function markOf(symbol) {
  if (state.prices) { const m = state.prices.mark(symbol); if (m > 0) return m; }
  return state.marks[symbol] || null;
}

async function ensureClient() {
  if (state.client) return state.client;
  state.client = bn.Client({});
  const mi = modeInfo();
  state.client.setNetwork(mi.placingOn === 'live' ? 'live' : 'testnet');
  try { await state.client.syncTime(); } catch (e) { blog('warn', 'time sync: ' + e.message); }
  return state.client;
}
async function refreshUniverse(force = false) {
  const c = cfgBn();
  try {
    const client = await ensureClient();
    const list = await universe.listEquityPerpsCached(client, { force, ttlMs: c.universeRefreshMs || 6 * 3600e3 });
    const liqOpts = {
      minQuoteVolume24h: c.minQuoteVolume24h, maxSpreadBps: c.maxSpreadBps,
      minDepthUsd: c.minDepthUsd, minOpenInterestUsd: c.minOpenInterestUsd,
      maxNotionalPctOfDepth: c.maxNotionalPctOfDepth,
    };
    const ok = [];
    for (const e of list) {
      try {
        const snap = await universe.liquiditySnapshot(client, e.symbol, liqOpts);
        if (snap.ok) ok.push(e.symbol);
        await new Promise((r) => setTimeout(r, 40));
      } catch {}
    }
    if (ok.length) {
      state.universeSymbols = ok;
      if (c.assetsAuto !== false) config.update({ binance: { assets: ok, assetsAuto: true } });
      blog('info', 'Universe refresh: ' + ok.length + '/' + list.length + ' liquid US equity perps');
    }
    return { listed: list.length, liquid: ok.length, symbols: ok };
  } catch (e) { blog('warn', 'universe refresh: ' + e.message); return { error: e.message }; }
}

async function loadExchangeInfo() {
  try { state.symbolInfo = await (await ensureClient()).exchangeInfo(); return state.symbolInfo; }
  catch (e) { state.lastError = e.message; blog('warn', 'exchangeInfo: ' + e.message); return null; }
}
function filt(symbol) {
  return state.symbolInfo ? bn.filtersOf(state.symbolInfo, symbol) : { symbol, stepSize: 0.001, tickSize: 0.1, minQty: 0.001, minNotional: 5 };
}

function protectiveOrders({ symbol, direction, stopPx, tpPx, stopCid, tpCid, qty }) {
  const f = filt(symbol);
  const mark = markOf(symbol);
  return sm.buildProtectiveOrders({
    symbol, direction, stopPx, tpPx, stopCid, tpCid, qty, filters: f, mark,
  });
}

/** Place one protective order with retries for -2022/-2021/-1021/rate-limit. */
async function placeProtectiveWithRetry(client, order, { trade, kind, mark }) {
  let attempt = 0, lastErr = null, params = { ...order };
  while (attempt < 4) {
    attempt += 1;
    try {
      const r = await client.placeOrder(params);
      return { ok: true, result: r, params };
    } catch (e) {
      lastErr = e;
      const cls = sm.classifyError(e);
      blog('warn', `protect ${kind} attempt ${attempt}: ${cls.kind} ${e.message}`);
      if (cls.action === 'sync_time') { try { await client.syncTime(); } catch {} continue; }
      if (cls.action === 'backoff') { await new Promise((r) => setTimeout(r, 250 * attempt * attempt)); continue; }
      if (cls.action === 'refresh_qty') {
        // -2022 reduceOnly: re-read position and shrink qty
        try {
          const pos = (await client.positionRisk()).find((p) => p.symbol === trade.symbol);
          const amt = Math.abs(Number(pos && pos.positionAmt) || 0);
          const f = filt(trade.symbol);
          const q = bn.roundStep(amt, f.stepSize);
          if (!(q > 0)) return { ok: false, error: e, kind: cls.kind, flat: true };
          params = { ...params, quantity: String(q) };
          continue;
        } catch { return { ok: false, error: e, kind: cls.kind }; }
      }
      if (cls.action === 'nudge_stop_tp') {
        const f = filt(trade.symbol);
        const m = mark || markOf(trade.symbol) || Number(params.stopPrice);
        const nudged = sm.nudgeAwayFromMark({
          direction: trade.direction,
          stopPx: kind === 'stop' ? Number(params.stopPrice) : trade.stop_px,
          tpPx: kind === 'tp' ? Number(params.stopPrice || params.price) : trade.tp_px,
          mark: m, tickSize: f.tickSize,
        });
        if (kind === 'stop') params = { ...params, stopPrice: String(nudged.stopPx) };
        else params = { ...params, stopPrice: String(nudged.tpPx), price: String(nudged.tpPx) };
        continue;
      }
      if (cls.action === 'ignore') return { ok: false, error: e, kind: cls.kind, ignore: true };
      return { ok: false, error: e, kind: cls.kind };
    }
  }
  return { ok: false, error: lastErr, kind: 'retries_exhausted' };
}

/** Attach (or re-attach) exchange-side SL/TP sized to filled qty. Idempotent via clientOrderId. */
async function attachProtection(trade, filledQty) {
  const mi = modeInfo();
  let stopCid = trade.stop_cid || bn.clientOrderId([trade.id, 's', crypto.randomBytes(2).toString('hex')]);
  let tpCid = trade.tp_cid || bn.clientOrderId([trade.id, 't', crypto.randomBytes(2).toString('hex')]);
  // New cids if previous attach failed (MISSING) so we do not skip due to cidTaken
  if (trade.stop_status === 'MISSING') stopCid = bn.clientOrderId([trade.id, 's', crypto.randomBytes(2).toString('hex')]);
  if (trade.tp_status === 'MISSING') tpCid = bn.clientOrderId([trade.id, 't', crypto.randomBytes(2).toString('hex')]);
  const f = filt(trade.symbol);
  const q = bn.roundStep(filledQty, f.stepSize);
  const prot = protectiveOrders({ symbol: trade.symbol, direction: trade.direction, stopPx: trade.stop_px, tpPx: trade.tp_px, stopCid, tpCid, qty: q });
  if (mi.dryRun) {
    store.db.prepare('UPDATE bn_trades SET stop_cid=?, tp_cid=?, stop_status=?, tp_status=?, filled_qty=?, protect_qty=?, stop_px=?, tp_px=? WHERE id=?')
      .run(stopCid, tpCid, 'ATTACHED', 'ATTACHED', filledQty, q, prot.stopPx, prot.tpPx, trade.id);
    rememberCid(stopCid, trade.id, 'stop', trade.symbol, 'DRY-SL-' + trade.id, 'NEW');
    rememberCid(tpCid, trade.id, 'tp', trade.symbol, 'DRY-TP-' + trade.id, 'NEW');
    transitionTrade(trade.id, sm.STATES.PROTECTED, { protectQty: q, note: 'dry_run_protect' });
    return { stopStatus: 'ATTACHED', tpStatus: 'ATTACHED', dryRun: true };
  }
  const client = await ensureClient();
  let stopStatus = trade.stop_status, tpStatus = trade.tp_status, stopOid = trade.stop_oid, tpOid = trade.tp_oid;
  const mark = markOf(trade.symbol);
  if (stopStatus !== 'ATTACHED') {
    const already = cidTaken(stopCid) && stopStatus === 'ATTACHED';
    if (!already) {
      const placed = await placeProtectiveWithRetry(client, prot.stop, { trade, kind: 'stop', mark });
      if (placed.ok) {
        stopOid = String(placed.result.orderId); stopStatus = 'ATTACHED';
        rememberCid(stopCid, trade.id, 'stop', trade.symbol, stopOid, placed.result.status);
        if (placed.params.stopPrice) store.db.prepare('UPDATE bn_trades SET stop_px=? WHERE id=?').run(Number(placed.params.stopPrice), trade.id);
      } else if (placed.flat) {
        transitionTrade(trade.id, sm.STATES.CLOSED, { note: 'flat_on_protect' });
        closeTrade(trade.id, 'closed', mark || trade.entry_px, 'flat before protect', 0);
        return { stopStatus: 'MISSING', tpStatus: 'MISSING', flat: true };
      } else { stopStatus = 'MISSING'; blog('error', `STOP attach failed ${trade.symbol}: ${(placed.error && placed.error.message) || placed.kind}`); }
    }
  }
  if (tpStatus !== 'ATTACHED') {
    const already = cidTaken(tpCid) && tpStatus === 'ATTACHED';
    if (!already) {
      const placed = await placeProtectiveWithRetry(client, prot.tp, { trade, kind: 'tp', mark });
      if (placed.ok) {
        tpOid = String(placed.result.orderId); tpStatus = 'ATTACHED';
        rememberCid(tpCid, trade.id, 'tp', trade.symbol, tpOid, placed.result.status);
        if (placed.params.price) store.db.prepare('UPDATE bn_trades SET tp_px=? WHERE id=?').run(Number(placed.params.price), trade.id);
      } else { tpStatus = 'MISSING'; blog('error', `TP attach failed ${trade.symbol}: ${(placed.error && placed.error.message) || placed.kind}`); }
    }
  }
  store.db.prepare('UPDATE bn_trades SET stop_cid=?, tp_cid=?, stop_oid=?, tp_oid=?, stop_status=?, tp_status=?, filled_qty=?, protect_qty=? WHERE id=?')
    .run(stopCid, tpCid, stopOid, tpOid, stopStatus, tpStatus, filledQty, q, trade.id);
  if (stopStatus === 'ATTACHED' && tpStatus === 'ATTACHED') {
    transitionTrade(trade.id, sm.STATES.PROTECTED, { protectQty: q, note: 'sl_tp_attached' });
  } else {
    transitionTrade(trade.id, sm.STATES.FILLED, { note: 'protection_incomplete' });
  }
  return { stopStatus, tpStatus };
}

/** Finalize a pending entry after limit fill / market fallback. Never double-fills: reads exchange filled qty first. */
async function finalizeEntry(pending, { forceMarket = false } = {}) {
  const mi = modeInfo();
  const trade = store.db.prepare('SELECT * FROM bn_trades WHERE id=?').get(pending.trade_id);
  if (!trade || sm.TERMINAL.has(sm.normalize(trade.status))) {
    store.db.prepare("UPDATE bn_pending SET status='done', updated_at=? WHERE id=?").run(Date.now(), pending.id);
    return { skipped: true };
  }
  let filled = Number(pending.filled_qty) || 0;
  let avgPx = trade.entry_px;
  let entryType = trade.entry_type || 'limit';

  if (mi.dryRun) {
    // Simulate: at deadline, assume full fill at limit (or mid if market fallback)
    const mark = markOf(pending.symbol) || pending.limit_px;
    if (forceMarket || Date.now() >= pending.deadline_ts) {
      if (filled < pending.target_qty) {
        const rem = pending.target_qty - filled;
        // market fallback fills remainder at mark with slight slippage
        const slip = (cfgBn().slippagePct || 0.5) / 100;
        const mktPx = mark * (1 + dirSign(pending.direction) * slip);
        avgPx = filled > 0 ? ((avgPx * filled) + (mktPx * rem)) / pending.target_qty : mktPx;
        filled = pending.target_qty;
        entryType = filled > 0 && pending.filled_qty > 0 ? 'limit+market' : 'market';
      } else entryType = 'limit';
    } else if (filled <= 0) {
      // progressive dry-run: fill fully at limit when "would have filled" — for dry-run we fill at deadline only unless mark crossed
      const crossed = pending.direction === 'LONG' ? mark <= pending.limit_px : mark >= pending.limit_px;
      if (crossed) { filled = pending.target_qty; avgPx = pending.limit_px; entryType = 'limit'; }
      else return { waiting: true, remainSec: Math.max(0, Math.round((pending.deadline_ts - Date.now()) / 1000)) };
    }
  } else {
    const client = await ensureClient();
    // Query order by clientOrderId to learn filled qty (restart-safe)
    let order;
    try { order = await client.signedGet('/fapi/v1/order', { symbol: pending.symbol, origClientOrderId: pending.limit_cid }); }
    catch (e) { blog('warn', 'query limit order: ' + e.message); order = null; }
    if (order) {
      filled = Number(order.executedQty) || 0;
      avgPx = Number(order.avgPrice) || pending.limit_px;
      if (['NEW', 'PARTIALLY_FILLED'].includes(order.status) && (forceMarket || Date.now() >= pending.deadline_ts)) {
        try { await client.cancelOrder({ symbol: pending.symbol, origClientOrderId: pending.limit_cid }); } catch (e) { blog('warn', 'cancel limit: ' + e.message); }
        // Re-read after cancel
        try { order = await client.signedGet('/fapi/v1/order', { symbol: pending.symbol, origClientOrderId: pending.limit_cid }); filled = Number(order.executedQty) || 0; avgPx = Number(order.avgPrice) || avgPx; } catch {}
      }
    }
    const remain = Math.max(0, pending.target_qty - filled);
    if (remain > 0 && (forceMarket || Date.now() >= pending.deadline_ts)) {
      const marketCid = pending.market_cid || bn.clientOrderId([trade.id, 'm', crypto.randomBytes(2).toString('hex')]);
      if (!cidTaken(marketCid)) {
        const f = filt(pending.symbol);
        const qty = bn.roundStep(remain, f.stepSize);
        if (qty >= (f.minQty || 0)) {
          const side = pending.direction === 'LONG' ? 'BUY' : 'SELL';
          const r = await client.placeOrder({ symbol: pending.symbol, side, type: 'MARKET', quantity: String(qty), newClientOrderId: marketCid, newOrderRespType: 'RESULT' });
          rememberCid(marketCid, trade.id, 'entry_market', pending.symbol, String(r.orderId), r.status);
          const mFilled = Number(r.executedQty) || qty;
          const mPx = Number(r.avgPrice) || markOf(pending.symbol) || avgPx;
          avgPx = filled > 0 ? ((avgPx * filled) + (mPx * mFilled)) / (filled + mFilled) : mPx;
          filled += mFilled;
          entryType = filled > mFilled ? 'limit+market' : 'market';
          store.db.prepare('UPDATE bn_pending SET market_cid=?, updated_at=? WHERE id=?').run(marketCid, Date.now(), pending.id);
        }
      }
    } else if (filled < pending.target_qty && Date.now() < pending.deadline_ts) {
      store.db.prepare('UPDATE bn_pending SET filled_qty=?, updated_at=? WHERE id=?').run(filled, Date.now(), pending.id);
      if (filled > 0) {
        store.db.prepare('UPDATE bn_trades SET filled_qty=?, entry_px=COALESCE(?,entry_px) WHERE id=?').run(filled, avgPx, trade.id);
        transitionTrade(trade.id, sm.STATES.PARTIAL, { note: 'partial_fill' });
        // Protect partial immediately so position is never naked
        const updatedPartial = store.db.prepare('SELECT * FROM bn_trades WHERE id=?').get(trade.id);
        await attachProtection(updatedPartial, filled);
      }
      return { waiting: true, filled, remainSec: Math.max(0, Math.round((pending.deadline_ts - Date.now()) / 1000)) };
    }
  }

  if (!(filled > 0)) {
    store.db.prepare("UPDATE bn_pending SET status='cancelled', updated_at=? WHERE id=?").run(Date.now(), pending.id);
    transitionTrade(trade.id, sm.STATES.CANCELLED, { note: 'limit_expired_no_fill' });
    store.db.prepare('UPDATE bn_trades SET exit_reason=?, exit_ts=? WHERE id=?').run('limit expired, no fill', Date.now(), trade.id);
    blog('warn', `Entry cancelled (no fill) ${pending.symbol}`);
    return { cancelled: true };
  }

  const notional = filled * avgPx;
  const margin = notional / (trade.leverage || cfgBn().leverage);
  const nextState = filled + 1e-12 < pending.target_qty ? sm.STATES.PARTIAL : sm.STATES.FILLED;
  store.db.prepare('UPDATE bn_trades SET filled_qty=?, entry_px=?, notional=?, margin=?, entry_type=?, qty=? WHERE id=?')
    .run(filled, avgPx, notional, margin, entryType, filled, trade.id);
  transitionTrade(trade.id, nextState, { note: entryType });
  store.db.prepare("UPDATE bn_pending SET status='done', filled_qty=?, updated_at=? WHERE id=?").run(filled, Date.now(), pending.id);
  const updated = store.db.prepare('SELECT * FROM bn_trades WHERE id=?').get(trade.id);
  await attachProtection(updated, filled);
  blog('info', `Entry finalized ${pending.direction} ${filled} ${pending.symbol} @ ${avgPx} (${entryType}) → ${nextState}`);
  return { ok: true, filled, avgPx, entryType, state: nextState };
}

async function processPendings() {
  for (const p of pendingRows()) {
    try {
      if (Date.now() >= p.deadline_ts) await finalizeEntry(p, { forceMarket: true });
      else await finalizeEntry(p, { forceMarket: false });
    } catch (e) { blog('warn', `pending #${p.id}: ${e.message}`); state.lastError = e.message; }
  }
}

async function handleSignal(sig) {
  const c = cfgBn();
  const mi = modeInfo();
  const id = insertSignal({
    source: sig.source, symbol: sig.symbol, direction: sig.direction, interval: sig.interval || null,
    entry: sig.entry ?? null, stop: sig.stop ?? null, tp: sig.tp ?? null, score: sig.score ?? null,
    closed_at: sig.closedAt ?? null, dedupe_key: sig.dedupeKey || null, raw: sig.raw,
  });
  if (!id) return { duplicate: true, message: 'Signal already processed' };
  state.lastSignalAt = Date.now();
  blog('info', `SIGNAL ${sig.source} ${sig.direction} ${sig.symbol}`, { signalId: id });
  const reject = (reason, status = 'rejected') => { setSignalStatus(id, status, reason); blog('warn', `Signal #${id}: ${reason}`); return { signalId: id, status, reason }; };

  if (!c.enabled) return reject('Binance trader disabled');
  if (c.killSwitch) return reject('Kill switch is ON');
  if (!c.autoTrade) return reject('Auto-trade disabled (logged only)');
  if (state.pausedReason && /Daily (loss|profit) halt/.test(state.pausedReason)) return reject(state.pausedReason);
  if (state.executing.has(sig.symbol)) return reject('Order in flight');
  state.executing.add(sig.symbol);
  try {
    const open = openTrades();
    if (open.some((t) => t.symbol === sig.symbol)) return reject(`Position or pending entry already exists for ${sig.symbol}`);
    if (open.length >= c.maxConcurrentPositions) return reject(`Max concurrent (${open.length}/${c.maxConcurrentPositions})`);

    const equity = equityNow();
    refreshDay(equity);
    const day = checkDailyLimits(equity);
    if (c.killSwitch) return reject(state.pausedReason || 'Kill switch ON');
    if (day && c.dailyProfitHaltEnabled && c.dailyProfitTargetPct > 0 && day.dayPct >= c.dailyProfitTargetPct) return reject(`Daily profit halt (+${day.dayPct.toFixed(2)}%)`);

    let mark = markOf(sig.symbol);
    if (!(mark > 0)) {
      try { const m = await (await ensureClient()).markPrice(sig.symbol); mark = Number(m.markPrice); state.marks[sig.symbol] = mark; }
      catch (e) { return reject('No mark: ' + e.message); }
    }
    if (!(mark > 0)) return reject('No mark for ' + sig.symbol);

    // Liquidity filter (Binance bot only — options Builder is unchanged)
    try {
      const liq = await universe.liquiditySnapshot(await ensureClient(), sig.symbol, {
        minQuoteVolume24h: c.minQuoteVolume24h, maxSpreadBps: c.maxSpreadBps,
        minDepthUsd: c.minDepthUsd, minOpenInterestUsd: c.minOpenInterestUsd,
        maxNotionalPctOfDepth: c.maxNotionalPctOfDepth,
      });
      if (!liq.ok) return reject('Illiquid: ' + liq.reasons.join('; '));
      sig._liq = liq;
    } catch (e) { return reject('Liquidity check failed: ' + e.message); }

    const sign = dirSign(sig.direction);
    const ref = sig.entry > 0 ? sig.entry : mark;
    let stopPct = sig.stop > 0 ? Math.abs(ref - sig.stop) / ref : c.defaultStopPct / 100;
    if (sig.stop > 0 && sign * (ref - sig.stop) <= 0) return reject('Stop on wrong side');
    if (!(stopPct > 0.0005) || stopPct > 0.5) return reject(`Bad stop ${(stopPct * 100).toFixed(2)}%`);
    let tpPct = sig.tp > 0 ? Math.abs(sig.tp - ref) / ref : stopPct * c.takeProfitR;
    const stopPx = mark * (1 - sign * stopPct);
    const tpPx = mark * (1 + sign * tpPct);
    // Limit price: join the book slightly inside mid (maker-friendly)
    const f = filt(sig.symbol);
    const limitPx = bn.roundTick(mark * (1 - sign * (c.limitOffsetPct || 0.02) / 100), f.tickSize);

    // Compounding: size off current equity (IST day-start used for daily %; live equity for risk $)
    const sizeEquity = Math.max(equity, state.dayStartEquity || equity);
    const sized = bn.sizePosition({
      capital: sizeEquity, leverage: c.leverage, riskPerTradePct: c.riskPerTradePct,
      maxConcurrent: c.maxConcurrentPositions, entry: mark, stopPct,
      stepSize: f.stepSize, minQty: f.minQty, minNotional: f.minNotional, openCount: open.length,
    });
    if (!sized.ok) return reject(sized.reason);
    if (sig._liq && sig._liq.maxNotional > 0 && sized.notional > sig._liq.maxNotional) {
      const f2 = filt(sig.symbol);
      const cappedQty = bn.roundStep(sig._liq.maxNotional / mark, f2.stepSize);
      if (!(cappedQty >= (f2.minQty || 0))) return reject('Depth-capped qty below minimum');
      sized.qty = cappedQty; sized.notional = cappedQty * mark; sized.margin = sized.notional / c.leverage;
      sized.stopLossUsd = sized.notional * stopPct;
      if (sized.stopLossUsd > sizeEquity * c.riskPerTradePct / 100 * 1.05) return reject('After depth cap, stop risk still too large — skip');
    }

    const entryCid = bn.clientOrderId([id, 'e', crypto.randomBytes(3).toString('hex')]);
    const stopCid = bn.clientOrderId([id, 's', crypto.randomBytes(3).toString('hex')]);
    const tpCid = bn.clientOrderId([id, 't', crypto.randomBytes(3).toString('hex')]);
    if (cidTaken(entryCid)) return reject('clientOrderId collision');

    const timeoutSec = c.entryTimeoutSec || 120;
    const deadline = Date.now() + timeoutSec * 1000;
    const side = sig.direction === 'LONG' ? 'BUY' : 'SELL';
    const limitParams = {
      symbol: sig.symbol, side, type: 'LIMIT', timeInForce: 'GTC',
      quantity: String(sized.qty), price: String(limitPx), newClientOrderId: entryCid, newOrderRespType: 'RESULT',
    };

    const tradeId = insertTrade({
      signal_id: id, symbol: sig.symbol, direction: sig.direction, mode: mi.placingOn === 'dry_run' ? 'dry_run' : mi.placingOn,
      network: mi.network, qty: sized.qty, filled_qty: 0, entry_px: limitPx, stop_px: stopPx, tp_px: tpPx,
      notional: sized.notional, leverage: c.leverage, margin: sized.margin, status: sm.STATES.ENTRY_PENDING, entry_type: 'limit',
      entry_cid: entryCid, stop_cid: stopCid, tp_cid: tpCid, stop_status: 'PENDING', tp_status: 'PENDING',
      orders: { limit: limitParams, deadline, timeoutSec },
    });
    rememberCid(entryCid, tradeId, 'entry_limit', sig.symbol, null, 'NEW');
    store.db.prepare(`INSERT INTO bn_pending(trade_id,symbol,direction,limit_cid,target_qty,filled_qty,limit_px,deadline_ts,stop_px,tp_px,leverage,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'waiting',?,?)`)
      .run(tradeId, sig.symbol, sig.direction, entryCid, sized.qty, 0, limitPx, deadline, stopPx, tpPx, c.leverage, Date.now(), Date.now());

    if (mi.dryRun) {
      setSignalStatus(id, 'dry_run', `Limit ${limitPx} working; market fallback in ${timeoutSec}s if unfilled`);
      blog('info', `DRY-RUN LIMIT ${side} ${sized.qty} ${sig.symbol} @ ${limitPx} (deadline ${timeoutSec}s)`, { tradeId });
      // Persist to Neon via mark if available
      try { require('./persist').mark('bn_trades', tradeId); require('./persist').mark('bn_pending', tradeId); } catch {}
      return { signalId: id, status: 'dry_run', tradeId, pending: true, deadline, limitPx };
    }

    const client = await ensureClient();
    await client.setMarginType(sig.symbol, c.marginType || 'ISOLATED');
    await client.setLeverage(sig.symbol, c.leverage);
    const entryRes = await client.placeOrder(limitParams);
    rememberCid(entryCid, tradeId, 'entry_limit', sig.symbol, String(entryRes.orderId), entryRes.status);
    store.db.prepare('UPDATE bn_trades SET entry_oid=? WHERE id=?').run(String(entryRes.orderId), tradeId);
    store.db.prepare('UPDATE bn_pending SET limit_oid=?, filled_qty=?, updated_at=? WHERE trade_id=?')
      .run(String(entryRes.orderId), Number(entryRes.executedQty) || 0, Date.now(), tradeId);
    setSignalStatus(id, 'pending', `Limit working; market fallback in ${timeoutSec}s`);
    // If already fully filled, finalize immediately
    if (Number(entryRes.executedQty) >= sized.qty) {
      const p = store.db.prepare('SELECT * FROM bn_pending WHERE trade_id=?').get(tradeId);
      await finalizeEntry(p, { forceMarket: false });
    }
    return { signalId: id, status: 'pending', tradeId, deadline, limitPx };
  } catch (e) {
    state.lastError = e.message;
    return reject(e.message, 'error');
  } finally { state.executing.delete(sig.symbol); }
}

async function reconcile() {
  const mi = modeInfo();
  const c = cfgBn();
  const maxUnprot = (c.maxUnprotectedSec != null ? c.maxUnprotectedSec : 5) * 1000;
  state.lastReconcileAt = Date.now();
  await processPendings();

  if (mi.dryRun) {
    const holdMs = universe.maxHoldMs(cfgBn().interval, cfgBn().maxHoldHours);
    for (const t of openTrades().filter((x) => x.mode === 'dry_run')) {
      const st = sm.normalize(t.status);
      // Unprotected timeout → re-attach
      if ((st === sm.STATES.FILLED || st === sm.STATES.PARTIAL) && (t.stop_status !== 'ATTACHED' || t.tp_status !== 'ATTACHED')) {
        const since = t.unprotected_since || t.filled_at || t.ts;
        if (Date.now() - since > maxUnprot) {
          await attachProtection(t, t.filled_qty || t.qty);
        }
      }
      if (!(st === sm.STATES.PROTECTED || st === sm.STATES.FILLED || st === sm.STATES.PARTIAL || st === 'open')) continue;
      if (Date.now() - t.ts >= holdMs) {
        const mark = markOf(t.symbol) || t.entry_px;
        const qty = t.filled_qty || t.qty;
        transitionTrade(t.id, sm.STATES.EXITING, { note: 'max_hold' });
        closeTrade(t.id, 'closed', mark, 'max hold time', (mark - t.entry_px) * qty * dirSign(t.direction));
        continue;
      }
      const mark = markOf(t.symbol);
      if (!(mark > 0)) continue;
      const sign = dirSign(t.direction), qty = t.filled_qty || t.qty;
      let hit = null;
      if (sign > 0 && mark <= t.stop_px) hit = 'SL';
      else if (sign > 0 && mark >= t.tp_px) hit = 'TP';
      else if (sign < 0 && mark >= t.stop_px) hit = 'SL';
      else if (sign < 0 && mark <= t.tp_px) hit = 'TP';
      if (hit) {
        const kind = hit === 'SL' ? 'stop' : 'tp';
        const oco = sm.onProtectiveFill(t, kind);
        transitionTrade(t.id, oco.nextState || sm.STATES.EXITING, { note: hit });
        closeTrade(t.id, 'closed', mark, hit, (mark - t.entry_px) * qty * sign);
      }
    }
    state.positionsMissingStops = openTrades().filter((t) => {
      const st = sm.normalize(t.status);
      return (st === sm.STATES.PROTECTED || st === sm.STATES.FILLED || st === sm.STATES.PARTIAL) && (t.stop_status === 'MISSING' || t.tp_status === 'MISSING');
    }).map((t) => ({ symbol: t.symbol, stop: t.stop_status, tp: t.tp_status, tradeId: t.id }));
    return { mode: 'dry_run', open: openTrades().filter((t) => sm.normalize(t.status) === sm.STATES.PROTECTED).length };
  }
  if (!mi.keyPresent) return { mode: 'no_keys' };
  const client = await ensureClient();
  let positions = [], orders = [];
  try { positions = await client.positionRisk(); orders = await client.openOrders(); }
  catch (e) {
    const cls = sm.classifyError(e);
    if (cls.action === 'sync_time') { try { await client.syncTime(); } catch {} }
    if (cls.action === 'backoff') { state.lastError = e.message; }
    // WS disconnect mid-fill: REST is source of truth — keep going next tick
    state.lastError = e.message; blog('warn', 'reconcile: ' + e.message); return { error: e.message, kind: cls.kind };
  }

  const missing = [];
  const posBySym = new Map();
  for (const p of positions) {
    const amt = Number(p.positionAmt); if (!(Math.abs(amt) > 0)) continue;
    posBySym.set(p.symbol, p);
  }

  for (const [symbol, p] of posBySym) {
    const amt = Number(p.positionAmt);
    const direction = amt > 0 ? 'LONG' : 'SHORT', closeSide = amt > 0 ? 'SELL' : 'BUY';
    const isStop = (o) => o.symbol === symbol && o.type === 'STOP_MARKET' && o.side === closeSide;
    const isTp = (o) => o.symbol === symbol && (o.type === 'TAKE_PROFIT' || o.type === 'TAKE_PROFIT_MARKET') && o.side === closeSide;
    const hasStop = orders.some(isStop);
    const hasTp = orders.some(isTp);
    let local = openTrades().find((t) => t.symbol === symbol);
    if (!local) {
      const entry = Number(p.entryPrice);
      const stopPct = cfgBn().defaultStopPct / 100, sign = dirSign(direction);
      const tradeId = insertTrade({
        symbol, direction, mode: mi.placingOn, network: mi.network, qty: Math.abs(amt), filled_qty: Math.abs(amt),
        entry_px: entry, stop_px: entry * (1 - sign * stopPct), tp_px: entry * (1 + sign * stopPct * cfgBn().takeProfitR),
        notional: Math.abs(amt) * entry, leverage: cfgBn().leverage, margin: Math.abs(amt) * entry / cfgBn().leverage,
        status: sm.STATES.FILLED, entry_type: 'adopted', stop_status: hasStop ? 'ATTACHED' : 'MISSING', tp_status: hasTp ? 'ATTACHED' : 'MISSING',
        orders: { orphan: true },
      });
      transitionTrade(tradeId, sm.STATES.FILLED, { note: 'adopted_orphan_position' });
      local = store.db.prepare('SELECT * FROM bn_trades WHERE id=?').get(tradeId);
      blog('warn', `Adopted orphan ${direction} ${symbol} as #${tradeId}`);
    }
    // Detect SL/TP fill race via order absence while still in PROTECTED
    if (sm.normalize(local.status) === sm.STATES.PROTECTED) {
      const stopGone = local.stop_cid && !orders.some((o) => o.clientOrderId === local.stop_cid || String(o.orderId) === String(local.stop_oid));
      const tpGone = local.tp_cid && !orders.some((o) => o.clientOrderId === local.tp_cid || String(o.orderId) === String(local.tp_oid));
      if (stopGone || tpGone) {
        // Query both to see which filled
        let stopFill = null, tpFill = null;
        try {
          if (local.stop_cid) stopFill = await client.signedGet('/fapi/v1/order', { symbol, origClientOrderId: local.stop_cid });
        } catch (e) { if (sm.classifyError(e).kind !== 'order_not_exist' && sm.classifyError(e).kind !== 'unknown_order') blog('warn', e.message); }
        try {
          if (local.tp_cid) tpFill = await client.signedGet('/fapi/v1/order', { symbol, origClientOrderId: local.tp_cid });
        } catch (e) { if (sm.classifyError(e).kind !== 'order_not_exist' && sm.classifyError(e).kind !== 'unknown_order') blog('warn', e.message); }
        const stopFilled = stopFill && ['FILLED', 'PARTIALLY_FILLED'].includes(stopFill.status);
        const tpFilled = tpFill && ['FILLED', 'PARTIALLY_FILLED'].includes(tpFill.status);
        const winner = sm.resolveProtectiveRace(stopFilled ? stopFill : null, tpFilled ? tpFill : null);
        if (winner) {
          const oco = sm.onProtectiveFill(local, winner);
          transitionTrade(local.id, oco.nextState, { note: oco.closeReason });
          // Cancel sibling (OCO)
          if (oco.cancelSibling && oco.siblingCid) {
            try { await client.cancelOrder({ symbol, origClientOrderId: oco.siblingCid }); }
            catch (e) {
              const cls = sm.classifyError(e);
              if (!cls.ignore && cls.kind !== 'unknown_order' && cls.kind !== 'order_not_exist') blog('warn', `OCO cancel ${oco.siblingKind}: ${e.message}`);
            }
          }
          const exitPx = Number((winner === 'stop' ? stopFill : tpFill).avgPrice) || markOf(symbol) || local.entry_px;
          const qty = local.filled_qty || local.qty;
          closeTrade(local.id, 'closed', exitPx, oco.closeReason, (exitPx - local.entry_px) * qty * dirSign(local.direction));
          // Cancel any leftover entry orders
          for (const o of orders.filter((x) => x.symbol === symbol)) {
            try { await client.cancelOrder({ symbol, orderId: o.orderId }); } catch {}
          }
          continue;
        }
      }
    }
    if (!hasStop || !hasTp) {
      missing.push({ symbol, hasStop, hasTp, tradeId: local.id });
      if (mi.allowOrders || mi.allowTestnetOrders) {
        await attachProtection({ ...local, stop_status: hasStop ? 'ATTACHED' : 'MISSING', tp_status: hasTp ? 'ATTACHED' : 'MISSING' }, Math.abs(amt));
      } else store.db.prepare('UPDATE bn_trades SET stop_status=?, tp_status=? WHERE id=?').run(hasStop ? 'ATTACHED' : 'MISSING', hasTp ? 'ATTACHED' : 'MISSING', local.id);
    } else {
      store.db.prepare('UPDATE bn_trades SET stop_status=?, tp_status=?, protect_qty=? WHERE id=?').run('ATTACHED', 'ATTACHED', Math.abs(amt), local.id);
      if (sm.normalize(local.status) !== sm.STATES.PROTECTED) transitionTrade(local.id, sm.STATES.PROTECTED, { protectQty: Math.abs(amt) });
    }
  }

  // Flat on exchange: manual close, liquidation, or full protective fill already handled
  for (const t of openTrades().filter((x) => x.mode !== 'dry_run')) {
    if (posBySym.has(t.symbol)) continue;
    const st = sm.normalize(t.status);
    if (st === sm.STATES.ENTRY_PENDING || st === sm.STATES.PARTIAL) continue; // still entering
    // Cancel any leftover reduceOnly / entry orders for this symbol (no orphans)
    for (const o of orders.filter((x) => x.symbol === t.symbol)) {
      try { await client.cancelOrder({ symbol: t.symbol, orderId: o.orderId }); }
      catch (e) { const cls = sm.classifyError(e); if (!cls.ignore) blog('warn', `orphan cancel: ${e.message}`); }
    }
    let reason = 'reconcile: flat on exchange';
    // Heuristic: if liq price was breached recently call it liquidation
    const mark = markOf(t.symbol);
    const liq = liqPrice(t);
    if (mark > 0 && liq > 0) {
      if (t.direction === 'LONG' && mark <= liq * 1.002) reason = 'liquidation';
      if (t.direction === 'SHORT' && mark >= liq * 0.998) reason = 'liquidation';
    }
    if (/manual|user/i.test(String(t.lifecycle_note || ''))) reason = 'manual close';
    transitionTrade(t.id, sm.STATES.EXITING, { note: reason });
    closeTrade(t.id, 'closed', mark || t.entry_px, reason, 0);
  }

  // Unprotected timeout for live FILLED
  for (const t of openTrades()) {
    const st = sm.normalize(t.status);
    if (st === sm.STATES.FILLED || (st === sm.STATES.PARTIAL && (t.stop_status !== 'ATTACHED' || t.tp_status !== 'ATTACHED'))) {
      const since = t.unprotected_since || t.filled_at || t.ts;
      if (Date.now() - since > maxUnprot && (mi.allowOrders || mi.allowTestnetOrders)) {
        blog('warn', `Unprotected >${c.maxUnprotectedSec || 5}s — re-attaching ${t.symbol}`);
        await attachProtection(t, t.filled_qty || t.qty);
      }
    }
  }

  state.positionsMissingStops = missing;
  return { mode: mi.placingOn, positions: posBySym.size, missingStops: missing.length };
}

async function scanOnce(reason) {
  const c = cfgBn();
  if (!c.scannerEnabled || !c.enabled || state.scanBusy) return;
  state.scanBusy = true; state.lastScanError = null;
  try {
    const client = await ensureClient();
    if (!state.symbolInfo) await loadExchangeInfo();
    for (const symbol of c.assets) {
      try {
        const kl = await client.klines(symbol, c.interval, 200);
        if (!kl.length) continue;
        state.marks[symbol] = kl[kl.length - 1].c;
        const candles = kl.map((k) => [k.t, k.o, k.h, k.l, k.c, k.v]);
        const a = Technicals.analyze(candles, { minStopPct: c.defaultStopPct });
        store.db.prepare(`INSERT INTO bn_scans(symbol,interval,ts,closed_at,direction,score,data) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(symbol,interval) DO UPDATE SET ts=excluded.ts, closed_at=excluded.closed_at, direction=excluded.direction, score=excluded.score, data=excluded.data`)
          .run(symbol, c.interval, Date.now(), a.closedAt ?? null, a.direction ?? null, a.score ?? null, JSON.stringify(a));
        const liqOpts = { lookback: c.liqLookback ?? 5, tolPct: c.liqTolPct ?? 0.0015, reclaimN: c.liqReclaimN ?? 3 };
        const liqRaw = LiquiditySignals.detect(kl, liqOpts);
        let liqSigs = liqRaw.signals || [];
        const kinds = Array.isArray(c.liqKinds) ? c.liqKinds : [];
        if (kinds.length) liqSigs = liqSigs.filter((s) => kinds.includes(s.kind));
        const liqDir = (() => {
          const L = liqSigs.filter((s) => s.side === 'LONG').length;
          const S = liqSigs.filter((s) => s.side === 'SHORT').length;
          if (L > S) return 'LONG'; if (S > L) return 'SHORT'; return null;
        })();
        const liqScore = Math.max(liqSigs.filter((s) => s.side === liqDir).length, liqDir ? 1 : 0);
        const liq = { direction: liqDir, score: liqScore, signals: liqSigs, allSignals: liqRaw.signals || [] };
        const mode = c.signalMode || 'indicators';
        let dir = null, score = a.score, sourceTag = 'scanner';
        if (mode === 'indicators') { if (['LONG','SHORT'].includes(a.direction) && (a.score||0) >= c.minScore) dir = a.direction; }
        else if (mode === 'liquidity') { if (liq.direction) { dir = liq.direction; score = 6 + liq.score; sourceTag = 'liquidity'; } }
        else if (mode === 'confirm') {
          if (['LONG','SHORT'].includes(a.direction) && (a.score||0) >= c.minScore && liq.direction === a.direction) { dir = a.direction; sourceTag = 'confirm'; }
        } else if (mode === 'confirm_window') {
          const N = Math.max(0, Number(c.liqWindowBars) || 3);
          let matched = false;
          if (['LONG','SHORT'].includes(a.direction) && (a.score||0) >= c.minScore) {
            if (liq.direction === a.direction) matched = true;
            else {
              for (let back = 1; back <= N; back++) {
                const slice = kl.slice(0, Math.max(0, kl.length - back));
                if (slice.length < 50) break;
                try {
                  const d = LiquiditySignals.detect(slice, liqOpts);
                  let sigs = d.signals || [];
                  if (kinds.length) sigs = sigs.filter((s) => kinds.includes(s.kind));
                  const L = sigs.filter((s) => s.side === 'LONG').length;
                  const S = sigs.filter((s) => s.side === 'SHORT').length;
                  const dd = L > S ? 'LONG' : S > L ? 'SHORT' : null;
                  if (dd === a.direction) { matched = true; break; }
                } catch {}
              }
            }
          }
          if (matched) { dir = a.direction; sourceTag = 'confirm_window'; }
        } else if (mode === 'any') {
          if (['LONG','SHORT'].includes(a.direction) && (a.score||0) >= c.minScore) dir = a.direction;
          else if (liq.direction) { dir = liq.direction; score = 6 + liq.score; sourceTag = 'liquidity'; }
        }
        // Apply selectable study ruleset entry filters (OOS-validated when set)
        const ruleset = (c.studyRulesets && c.activeStudyRuleset && c.studyRulesets[c.activeStudyRuleset]) || null;
        const filters = { ...(c.entryFilters || {}), ...((ruleset && ruleset.rules) || {}) };
        if (dir && filters.noFridayEntry) {
          const istDow = new Date(Date.now() + 5.5 * 3600e3).getUTCDay();
          if (istDow === 5) dir = null;
        }
        if (dir && filters.noLiquidityOnly && sourceTag === 'liquidity') dir = null;
        if (dir && filters.usCashOnly) {
          const h = new Date(Date.now() + 5.5 * 3600e3).getUTCHours();
          if (!(h >= 19 || h <= 2)) dir = null;
        }
        if (dir && filters.minScore != null && (score || 0) < filters.minScore && sourceTag !== 'liquidity') dir = null;
        if (dir) {
          const dedupeKey = 'bn|' + symbol + '|' + c.interval + '|' + (a.closedAt || Math.floor(Date.now() / 60e3)) + '|' + dir + '|' + mode;
          await handleSignal({ source: sourceTag, symbol, direction: dir, entry: a.entry ?? kl.at(-1).c, stop: a.stop ?? null, tp: a.target ?? null, interval: c.interval, score, closedAt: a.closedAt, dedupeKey, raw: { indicators: a, liquidity: liq, ruleset: ruleset ? ruleset.id : null } });
        }
      } catch (e) { blog('warn', `scan ${symbol}: ${e.message}`); }
    }
    state.lastScanAt = Date.now();
    const ms = ({ '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '4h': 14400e3 })[c.interval] || 900e3;
    state.nextScanAt = Date.now() + Math.min(ms, 60e3);
  } catch (e) { state.lastScanError = e.message; blog('error', 'scan: ' + e.message); }
  finally { state.scanBusy = false; }
}

function setKill(on, reason) {
  config.update({ binance: { killSwitch: !!on } });
  state.pausedReason = on ? (reason || 'Kill switch engaged') : null;
  blog('warn', on ? `KILL ON: ${state.pausedReason}` : 'Kill released');
}

function liqPrice(t) {
  // Isolated approx: long liq ≈ entry * (1 - 1/lev + mmr); short opposite. mmr ~0.4% for majors.
  const mmr = 0.004, lev = t.leverage || cfgBn().leverage, entry = t.entry_px;
  if (!(entry > 0 && lev > 0)) return null;
  return t.direction === 'LONG' ? entry * (1 - 1 / lev + mmr) : entry * (1 + 1 / lev - mmr);
}

function toISTDate(ms) {
  const d = new Date(Number(ms) + 5.5 * 3600e3);
  return d.toISOString().slice(0, 10);
}

/** Avg daily returns from actual closed bn_trades (dry-run or live) — not study backtest. */
function actualDailyReturns(lookbackDays = 60) {
  const since = Date.now() - lookbackDays * 86400e3;
  const rows = store.db.prepare("SELECT pnl, exit_ts FROM bn_trades WHERE status IN ('closed','CLOSED') AND exit_ts>=? ORDER BY exit_ts").all(since);
  const byDay = new Map();
  for (const r of rows) {
    const d = toISTDate(r.exit_ts);
    const g = byDay.get(d) || { date: d, pnl: 0, trades: 0 };
    g.pnl += Number(r.pnl) || 0; g.trades += 1;
    byDay.set(d, g);
  }
  // Build calendar span from first trade day or lookback
  const days = [];
  const startEq = Number(cfgBn().capital) || 800;
  let eq = startEq;
  const sorted = [...byDay.keys()].sort();
  if (!sorted.length) {
    return { lookbackDays, meanDailyPctAllDays: 0, medianDailyPctAllDays: 0, geoAvgDailyPct: 0,
      meanDailyPctTradeDays: 0, medianDailyPctTradeDays: 0, tradeDays: 0, calendarDays: 0, endEquity: startEq, netPnl: 0 };
  }
  // All calendar days from first to last trade day
  const t0 = Date.parse(sorted[0] + 'T00:00:00+05:30');
  const t1 = Date.parse(sorted[sorted.length - 1] + 'T00:00:00+05:30');
  for (let t = t0; t <= t1; t += 86400e3) {
    const d = toISTDate(t);
    const g = byDay.get(d) || { date: d, pnl: 0, trades: 0 };
    const dayStart = eq;
    eq += g.pnl;
    const pct = dayStart ? (g.pnl / dayStart) * 100 : 0;
    days.push({ date: d, pnl: g.pnl, trades: g.trades, equity: eq, dayStartEquity: dayStart, pnlPct: pct });
  }
  const allPct = days.map((d) => d.pnlPct);
  const tradePct = days.filter((d) => d.trades > 0).map((d) => d.pnlPct);
  const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const median = (a) => { if (!a.length) return 0; const b=[...a].sort((x,y)=>x-y); const m=Math.floor(b.length/2); return b.length%2?b[m]:(b[m-1]+b[m])/2; };
  const n = Math.max(1, allPct.length);
  const geo = startEq > 0 && eq > 0 ? (Math.pow(eq / startEq, 1 / n) - 1) * 100 : 0;
  return {
    lookbackDays, calendarDays: allPct.length, tradeDays: tradePct.length,
    meanDailyPctAllDays: +mean(allPct).toFixed(4),
    medianDailyPctAllDays: +median(allPct).toFixed(4),
    geoAvgDailyPct: +geo.toFixed(4),
    meanDailyPctTradeDays: +mean(tradePct).toFixed(4),
    medianDailyPctTradeDays: +median(tradePct).toFixed(4),
    endEquity: +eq.toFixed(2), netPnl: +(eq - startEq).toFixed(2),
  };
}

function positionsView() {
  const c = cfgBn(), mi = modeInfo(), equity = equityNow();
  refreshDay(equity);
  const day = checkDailyLimits(equity);
  const pricesSnap = state.prices ? state.prices.snapshot() : { source: 'Binance USDⓈ-M', transport: 'idle', lastUpdateAt: 0, marks: {} };
  const open = openTrades().filter((t) => { const s = sm.normalize(t.status); return s === sm.STATES.PROTECTED || s === sm.STATES.FILLED || s === sm.STATES.PARTIAL; }).map((t) => {
    const mark = markOf(t.symbol) || (pricesSnap.marks[t.symbol] && pricesSnap.marks[t.symbol].markPrice) || null;
    const qty = t.filled_qty || t.qty;
    const upnl = mark > 0 && t.entry_px > 0 ? (mark - t.entry_px) * qty * dirSign(t.direction) : null;
    const upnlPct = upnl != null && t.margin > 0 ? (upnl / t.margin) * 100 : null;
    return {
      id: t.id, symbol: t.symbol, side: t.direction, entryPx: t.entry_px, qty, leverage: t.leverage, margin: t.margin,
      stopPx: t.stop_px, tpPx: t.tp_px, markPx: mark, upnl, upnlPct, liqPx: liqPrice(t),
      entryType: t.entry_type, entryTime: t.ts, mode: t.mode,
      stopStatus: t.stop_status || 'UNKNOWN', tpStatus: t.tp_status || 'UNKNOWN',
      protectionOk: t.stop_status === 'ATTACHED' && t.tp_status === 'ATTACHED',
    };
  });
  const pending = pendingRows().map((p) => ({
    id: p.id, tradeId: p.trade_id, symbol: p.symbol, side: p.direction, limitPx: p.limit_px,
    targetQty: p.target_qty, filledQty: p.filled_qty, deadlineTs: p.deadline_ts,
    remainSec: Math.max(0, Math.round((p.deadline_ts - Date.now()) / 1000)),
    stopPx: p.stop_px, tpPx: p.tp_px, leverage: p.leverage, createdAt: p.created_at,
  }));
  const closed = store.db.prepare("SELECT * FROM bn_trades WHERE status IN ('closed','CLOSED') ORDER BY exit_ts DESC LIMIT 50").all()
    .map((t) => ({
      id: t.id, symbol: t.symbol, side: t.direction, entryPx: t.entry_px, exitPx: t.exit_px, qty: t.filled_qty || t.qty,
      reason: t.exit_reason, pnl: t.pnl, fees: t.fees, entryType: t.entry_type, openedAt: t.ts, closedAt: t.exit_ts, mode: t.mode,
    }));
  return {
    source: pricesSnap.source, transport: pricesSnap.transport, lastUpdateAt: pricesSnap.lastUpdateAt, ageMs: pricesSnap.ageMs, stale: pricesSnap.stale, serverNow: pricesSnap.serverNow,
    geoBlocked: !!pricesSnap.geoBlocked, priceNote: pricesSnap.note || null,
    mode: mi.placingOn, dryRun: mi.dryRun, capital: c.capital, equity,
    daily: {
      pnl: day.dayPnl, pnlPct: day.dayPct, targetPct: c.dailyProfitTargetPct, lossLimitPct: c.dailyLossLimitPct,
      lossHaltEnabled: !!c.dailyLossHaltEnabled, profitHaltEnabled: !!c.dailyProfitHaltEnabled,
      lossBreached: !!(day && day.lossBreached), profitReached: !!(day && day.profitReached),
      startEquity: state.dayStartEquity, realized: state.dayRealizedPnl,
      positionsUsed: open.length, maxPositions: c.maxConcurrentPositions,
      killSwitch: !!c.killSwitch, pausedReason: state.pausedReason,
    },
    open, pending, closed,
    missingStops: state.positionsMissingStops,
    actualReturns: actualDailyReturns(60),
  };
}

function health() {
  const mi = modeInfo(), c = cfgBn(), equity = equityNow();
  refreshDay(equity);
  const day = checkDailyLimits(equity);
  const ps = state.prices ? state.prices.snapshot() : {};
  return {
    ok: true, venue: 'binance-usdsm', enabled: !!c.enabled, mode: mi.placingOn, dryRun: mi.dryRun,
    keyPresent: mi.keyPresent, liveFlag: mi.liveEnabled, problems: mi.problems,
    capital: c.capital, leverage: c.leverage, maxConcurrent: c.maxConcurrentPositions,
    riskPerTradePct: c.riskPerTradePct, dailyLossLimitPct: c.dailyLossLimitPct, dailyProfitTargetPct: c.dailyProfitTargetPct,
    entryTimeoutSec: c.entryTimeoutSec || 120, killSwitch: !!c.killSwitch, pausedReason: state.pausedReason,
    equity, dayPnl: day.dayPnl, dayPnlPct: day.dayPct, openPositions: openTrades().filter((t) => sm.normalize(t.status) === sm.STATES.PROTECTED || sm.normalize(t.status) === sm.STATES.FILLED).length,
    pendingEntries: pendingRows().length,
    lastSignalAt: state.lastSignalAt || null, lastScanAt: state.lastScanAt || null, lastReconcileAt: state.lastReconcileAt || null,
    streamStatus: state.streamStatus, priceTransport: ps.transport || null, priceLastUpdateAt: ps.lastUpdateAt || null,
    geoBlocked: !!ps.geoBlocked, positionsMissingStops: state.positionsMissingStops,
    lastError: state.lastError, lastScanError: state.lastScanError, startedAt: state.startedAt,
    note: mi.dryRun
      ? 'DRY-RUN: no Binance orders sent. LIMIT→MARKET fallback simulated. Set keys + BINANCE_LIVE=yes + allowSignedOrders for live.'
      : 'Order placement enabled — SL/TP attached after fill.',
  };
}

function status() {
  const h = health(), c = cfgBn();
  return {
    ...h,
    settings: {
      enabled: c.enabled, capital: c.capital, leverage: c.leverage, marginType: c.marginType,
      maxConcurrentPositions: c.maxConcurrentPositions, riskPerTradePct: c.riskPerTradePct,
      dailyLossLimitPct: c.dailyLossLimitPct, dailyProfitTargetPct: c.dailyProfitTargetPct,
      takeProfitR: c.takeProfitR, defaultStopPct: c.defaultStopPct, slippagePct: c.slippagePct,
      entryTimeoutSec: c.entryTimeoutSec || 120, limitOffsetPct: c.limitOffsetPct || 0.02,
      assets: c.assets, interval: c.interval, minScore: c.minScore, scannerEnabled: c.scannerEnabled,
      autoTrade: c.autoTrade, killSwitch: c.killSwitch, allowSignedOrders: !!c.allowSignedOrders,
      allowTestnetOrders: !!c.allowTestnetOrders,
      signalMode: c.signalMode, liqKinds: c.liqKinds || [], liqWindowBars: c.liqWindowBars || 0, activePreset: c.activePreset || null,
      studyPresets: c.studyPresets || {}, assetsAuto: c.assetsAuto !== false,
      universeCount: (state.universeSymbols || c.assets || []).length,
    },
    marks: { ...state.marks, ...(state.prices ? Object.fromEntries(Object.entries(state.prices.state.marks).map(([k, v]) => [k, v.markPrice])) : {}) },
    positions: positionsView(),
    stats: store.db.prepare("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END),0) wins, COALESCE(SUM(pnl),0) pnl FROM bn_trades WHERE status IN ('closed','CLOSED')").get(),
    keyHint: bn.runtime().keyHint,
  };
}

function start() {
  ensureTables();
  const mi = modeInfo(), c = cfgBn();
  blog('info', `Binance trader starting mode=${mi.placingOn} dryRun=${mi.dryRun}`, { problems: mi.problems, assets: c.assets });
  // Resolve live TradFi equity perps (US-stock-linked) from exchangeInfo — never invent symbols
  ensureClient().then(async (cl) => {
    try {
      const eq = await universe.listEquityPerps(cl);
      const syms = eq.map((x) => x.symbol);
      if (syms.length) {
        blog('info', 'Equity perp universe: ' + syms.join(', '), { n: syms.length });
        if (!c.assetsLocked) config.update({ binance: { assets: syms } });
      } else blog('warn', 'No TRADING EQUITY/TradFi perpetuals found on Binance USD-M');
    } catch (e) { blog('warn', 'universe discovery: ' + e.message); }
  }).catch(() => {});
  state.prices = Prices({ symbols: c.assets.length ? c.assets : DEFAULT_SYMBOLS, client: null });
  // Wire price client after ensureClient asynchronously
  ensureClient().then((cl) => { state.prices = Prices({ symbols: c.assets, client: cl }); state.prices.start(); state.prices.emitter.on('update', (snap) => {
    for (const [sym, m] of Object.entries(snap.marks || {})) if (m.markPrice > 0) state.marks[sym] = m.markPrice;
  }); }).catch(() => { state.prices.start(); });

  const boot = async () => {
    try { await loadExchangeInfo(); } catch {}
    try { await reconcile(); } catch (e) { blog('warn', 'startup reconcile: ' + e.message); }
    try { await refreshUniverse(false); } catch (e) { blog('warn', 'startup universe: ' + e.message); }
    every(6 * 3600e3, async () => { await refreshUniverse(false); });
    try { await scanOnce('startup'); } catch (e) { blog('warn', 'startup scan: ' + e.message); }
  };
  boot();
  const every = (ms, fn) => { const id = setInterval(() => { fn().catch((e) => blog('warn', e.message)); }, ms); state.timers.push(id); };
  every(2000, async () => {
    await processPendings();
    const c2 = cfgBn();
    if (c2.scannerEnabled && c2.enabled && !state.scanBusy && Date.now() >= (state.nextScanAt || 0)) await scanOnce('candle');
  });
  every(15000, async () => { await reconcile(); });
  every(60e3, async () => { refreshDay(equityNow()); checkDailyLimits(equityNow()); });
}

function stop() {
  for (const t of state.timers) clearInterval(t);
  state.timers = [];
  if (state.prices) state.prices.stop();
  if (state.client) state.client.disconnect();
}

module.exports = {
  state, start, stop, handleSignal, reconcile, scanOnce, refreshUniverse, health, status, setKill, modeInfo,
  positionsView, processPendings, finalizeEntry, attachProtection, protectiveOrders, transitionTrade, placeProtectiveWithRetry,
  sizePosition: bn.sizePosition, ensureTables, openTrades, pendingRows, equityNow, markOf, sm,
  _insertTrade: insertTrade, _closeTrade: closeTrade, _rememberCid: rememberCid, _cidTaken: cidTaken,
};
