'use strict';
/**
 * Explicit order lifecycle state machine for Binance USDⓈ-M equity perps.
 * States: SIGNAL → ENTRY_PENDING → PARTIAL → FILLED → PROTECTED → EXITING → CLOSED
 * Terminal: CANCELLED | ERROR
 *
 * Transitions are idempotent (same target = ok no-op) and persisted by the caller.
 * This module is pure (no I/O) so unit/fuzz tests can drive it with a mock exchange.
 */
const { roundStep, roundTick } = require('./binance');

const STATES = Object.freeze({
  SIGNAL: 'SIGNAL',
  ENTRY_PENDING: 'ENTRY_PENDING',
  PARTIAL: 'PARTIAL',
  FILLED: 'FILLED',
  PROTECTED: 'PROTECTED',
  EXITING: 'EXITING',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
  ERROR: 'ERROR',
});

/** Legacy status values mapped into the SM. */
const LEGACY = Object.freeze({
  pending: STATES.ENTRY_PENDING,
  open: STATES.PROTECTED,
  closed: STATES.CLOSED,
  cancelled: STATES.CANCELLED,
  error: STATES.ERROR,
});

const OPEN_STATES = new Set([
  STATES.ENTRY_PENDING, STATES.PARTIAL, STATES.FILLED, STATES.PROTECTED, STATES.EXITING,
]);

const TERMINAL = new Set([STATES.CLOSED, STATES.CANCELLED, STATES.ERROR]);

/** Allowed next states. Self-transitions are always allowed (idempotent). */
const ALLOWED = Object.freeze({
  [STATES.SIGNAL]:        [STATES.ENTRY_PENDING, STATES.CANCELLED, STATES.ERROR],
  [STATES.ENTRY_PENDING]: [STATES.PARTIAL, STATES.FILLED, STATES.CANCELLED, STATES.ERROR],
  [STATES.PARTIAL]:       [STATES.PARTIAL, STATES.FILLED, STATES.PROTECTED, STATES.CANCELLED, STATES.ERROR, STATES.EXITING],
  [STATES.FILLED]:        [STATES.PROTECTED, STATES.EXITING, STATES.CLOSED, STATES.ERROR, STATES.FILLED],
  [STATES.PROTECTED]:     [STATES.EXITING, STATES.CLOSED, STATES.ERROR, STATES.FILLED, STATES.PROTECTED],
  [STATES.EXITING]:       [STATES.CLOSED, STATES.ERROR, STATES.PROTECTED, STATES.EXITING],
  [STATES.CLOSED]:        [],
  [STATES.CANCELLED]:     [],
  [STATES.ERROR]:         [STATES.ENTRY_PENDING, STATES.FILLED, STATES.PROTECTED, STATES.EXITING, STATES.CLOSED, STATES.CANCELLED],
});

function normalize(status) {
  if (!status) return STATES.SIGNAL;
  if (STATES[status]) return status;
  if (LEGACY[status]) return LEGACY[status];
  return status;
}

function canTransition(from, to) {
  const a = normalize(from), b = normalize(to);
  if (a === b) return true;
  const next = ALLOWED[a];
  return Array.isArray(next) && next.includes(b);
}

/**
 * Attempt a transition. Returns { ok, from, to, noop, reason }.
 * Caller is responsible for persisting `to` when ok && !noop (or always when ok).
 */
function transition(from, to, meta = {}) {
  const a = normalize(from), b = normalize(to);
  if (a === b) return { ok: true, from: a, to: b, noop: true, reason: 'idempotent' };
  if (TERMINAL.has(a) && a !== STATES.ERROR) {
    return { ok: false, from: a, to: b, noop: false, reason: `terminal state ${a}` };
  }
  if (!canTransition(a, b)) {
    return { ok: false, from: a, to: b, noop: false, reason: `illegal ${a} → ${b}` };
  }
  return { ok: true, from: a, to: b, noop: false, reason: meta.reason || null };
}

/** Classify Binance REST error codes into actionable categories. */
function classifyError(err) {
  const code = Number(err && (err.code ?? err?.response?.data?.code));
  const msg = String((err && (err.message || err.msg)) || '');
  const m = msg.match(/-?\d{3,5}/);
  const c = Number.isFinite(code) ? code : (m ? Number(m[0]) : NaN);
  if (c === -2022) return { code: c, kind: 'reduce_only_reject', retry: true, action: 'refresh_qty' };
  if (c === -2021) return { code: c, kind: 'would_immediately_trigger', retry: true, action: 'nudge_stop_tp' };
  if (c === -1021) return { code: c, kind: 'timestamp', retry: true, action: 'sync_time' };
  if (c === -1003 || c === -1015 || /rate limit|too many requests/i.test(msg)) {
    return { code: c || -1003, kind: 'rate_limit', retry: true, action: 'backoff' };
  }
  if (c === -2011) return { code: c, kind: 'unknown_order', retry: false, action: 'ignore' }; // already gone
  if (c === -2013) return { code: c, kind: 'order_not_exist', retry: false, action: 'ignore' };
  if (c === -1111 || c === -1116) return { code: c, kind: 'precision', retry: true, action: 'refilter' };
  return { code: c || null, kind: 'other', retry: false, action: 'error', message: msg };
}

/**
 * Validate / snap price & qty against exchange filters.
 * Includes PERCENT_PRICE band vs mark when provided.
 */
function applyFilters({ price, qty, mark, filters, side }) {
  const f = filters || {};
  const tick = f.tickSize > 0 ? f.tickSize : 0.01;
  const step = f.stepSize > 0 ? f.stepSize : 0.001;
  const minQty = f.minQty != null ? f.minQty : 0;
  const minNotional = f.minNotional != null ? f.minNotional : 5;
  const reasons = [];

  let px = price != null ? roundTick(price, tick) : null;
  let q = qty != null ? roundStep(qty, step) : null;

  if (q != null && q < minQty) reasons.push(`qty ${q} < minQty ${minQty}`);
  if (px != null && q != null && px * q < minNotional) reasons.push(`notional ${px * q} < minNotional ${minNotional}`);

  // PERCENT_PRICE: multiplierUp/Down around mark (or percentPrice / percentPriceBySide)
  if (px != null && mark > 0) {
    const up = Number(f.multiplierUp != null ? f.multiplierUp : (f.percentPrice != null ? 1 + f.percentPrice : 1.05));
    const down = Number(f.multiplierDown != null ? f.multiplierDown : (f.percentPrice != null ? 1 - f.percentPrice : 0.95));
    const hi = mark * up, lo = mark * down;
    if (px > hi || px < lo) {
      reasons.push(`price ${px} outside PERCENT_PRICE [${lo}, ${hi}] vs mark ${mark}`);
      // Snap into band rather than hard-fail when possible
      px = roundTick(Math.min(hi, Math.max(lo, px)), tick);
    }
  }

  // For STOP / TP: ensure stop is on the correct side of mark (caller may still nudge)
  return {
    ok: reasons.length === 0 || (px != null && q != null && q >= minQty && (px == null || px * q >= minNotional)),
    price: px,
    qty: q,
    reasons,
    tickSize: tick,
    stepSize: step,
    minQty,
    minNotional,
  };
}

/** Build STOP_MARKET + TAKE_PROFIT (limit) reduceOnly protective pair. Never OCO-native; caller cancels sibling on fill. */
function buildProtectiveOrders({ symbol, direction, stopPx, tpPx, stopCid, tpCid, qty, filters, mark }) {
  const closeSide = direction === 'LONG' || direction === 'BUY' ? 'SELL' : 'BUY';
  const stopF = applyFilters({ price: stopPx, qty, mark, filters });
  const tpF = applyFilters({ price: tpPx, qty, mark, filters });
  const stop = stopF.price, tp = tpF.price, q = stopF.qty != null ? stopF.qty : tpF.qty;
  const base = { symbol, side: closeSide, workingType: 'MARK_PRICE', priceProtect: 'true' };
  const stopOrder = q != null
    ? { ...base, type: 'STOP_MARKET', stopPrice: String(stop), quantity: String(q), reduceOnly: 'true', newClientOrderId: stopCid }
    : { ...base, type: 'STOP_MARKET', stopPrice: String(stop), closePosition: 'true', newClientOrderId: stopCid };
  // TAKE_PROFIT limit: triggers at stopPrice, rests as limit at price (both = tp)
  const tpOrder = q != null
    ? { ...base, type: 'TAKE_PROFIT', stopPrice: String(tp), price: String(tp), quantity: String(q), reduceOnly: 'true', timeInForce: 'GTC', newClientOrderId: tpCid }
    : { ...base, type: 'TAKE_PROFIT', stopPrice: String(tp), price: String(tp), closePosition: 'true', timeInForce: 'GTC', newClientOrderId: tpCid };
  return { stop: stopOrder, tp: tpOrder, stopPx: stop, tpPx: tp, qty: q, stopCid, tpCid, filterReasons: [...stopF.reasons, ...tpF.reasons] };
}

/** Nudge stop/tp away from mark so -2021 "would immediately trigger" clears. */
function nudgeAwayFromMark({ direction, stopPx, tpPx, mark, tickSize, bps = 15 }) {
  const tick = tickSize > 0 ? tickSize : 0.01;
  const pad = Math.max(tick, mark * (bps / 10000));
  const long = direction === 'LONG' || direction === 'BUY';
  let stop = stopPx, tp = tpPx;
  if (long) {
    if (!(stop < mark)) stop = mark - pad;
    if (!(tp > mark)) tp = mark + pad;
  } else {
    if (!(stop > mark)) stop = mark + pad;
    if (!(tp < mark)) tp = mark - pad;
  }
  return { stopPx: roundTick(stop, tick), tpPx: roundTick(tp, tick) };
}

/** Invariant checks used by unit + fuzz tests. */
function checkInvariants(trade, { openOrders = [], now = Date.now(), maxUnprotectedSec = 5 } = {}) {
  const violations = [];
  const st = normalize(trade.status);
  const posQty = Number(trade.filled_qty || trade.qty || 0);
  const stopQty = trade.protect_qty != null ? Number(trade.protect_qty) : posQty;
  const entryCids = (trade._entries || []).length;

  if (trade._entryCount != null && trade._entryCount > 1) {
    violations.push({ inv: 'one_entry_per_signal', detail: `entries=${trade._entryCount}` });
  }
  if (trade.signal_id != null && trade._dupeSignal) {
    violations.push({ inv: 'one_entry_per_signal', detail: 'duplicate signal accepted' });
  }

  if (OPEN_STATES.has(st) && st !== STATES.ENTRY_PENDING && st !== STATES.PARTIAL) {
    if (posQty > 0 && st === STATES.FILLED) {
      const since = trade.filled_at || trade.unprotected_since || trade.ts || 0;
      if (now - since > maxUnprotectedSec * 1000) {
        violations.push({ inv: 'unprotected_timeout', detail: `${((now - since) / 1000).toFixed(1)}s > ${maxUnprotectedSec}s` });
      }
    }
    if (st === STATES.PROTECTED) {
      if (!(Math.abs(stopQty - posQty) <= 1e-9 * Math.max(1, posQty))) {
        violations.push({ inv: 'protective_qty_eq_position', detail: `protect=${stopQty} pos=${posQty}` });
      }
      if (trade.stop_status !== 'ATTACHED' || trade.tp_status !== 'ATTACHED') {
        violations.push({ inv: 'protective_qty_eq_position', detail: `stop=${trade.stop_status} tp=${trade.tp_status}` });
      }
    }
  }

  if (TERMINAL.has(st) || st === STATES.CLOSED) {
    const orphans = openOrders.filter((o) => o.symbol === trade.symbol && (
      o.clientOrderId === trade.entry_cid || o.clientOrderId === trade.stop_cid || o.clientOrderId === trade.tp_cid ||
      o.orderId === trade.entry_oid || o.orderId === trade.stop_oid || o.orderId === trade.tp_oid
    ));
    if (orphans.length) {
      violations.push({ inv: 'no_orphan_orders', detail: orphans.map((o) => o.clientOrderId || o.orderId).join(',') });
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Decide OCO action when an open order update arrives for a protected trade.
 * Returns { cancelSibling, siblingCid, closeReason, nextState }.
 */
function onProtectiveFill(trade, filledKind /* 'stop' | 'tp' */) {
  const st = normalize(trade.status);
  if (st !== STATES.PROTECTED && st !== STATES.EXITING) {
    return { cancelSibling: false, nextState: st, reason: 'not_protected' };
  }
  if (filledKind === 'stop') {
    return { cancelSibling: true, siblingCid: trade.tp_cid, siblingKind: 'tp', closeReason: 'SL', nextState: STATES.EXITING };
  }
  if (filledKind === 'tp') {
    return { cancelSibling: true, siblingCid: trade.stop_cid, siblingKind: 'stop', closeReason: 'TP', nextState: STATES.EXITING };
  }
  return { cancelSibling: false, nextState: st };
}

/** Race: both SL and TP appear filled in the same reconcile tick — prefer the one with earlier updateTime / first seen. */
function resolveProtectiveRace(stopFill, tpFill) {
  if (stopFill && !tpFill) return 'stop';
  if (tpFill && !stopFill) return 'tp';
  if (!stopFill && !tpFill) return null;
  const st = Number(stopFill.updateTime || stopFill.time || 0);
  const tt = Number(tpFill.updateTime || tpFill.time || 0);
  if (st && tt) return st <= tt ? 'stop' : 'tp';
  // Ambiguous: prefer SL (risk-off)
  return 'stop';
}

/** Active trade statuses for "already have a position/entry on this symbol". */
function isActiveStatus(status) {
  return OPEN_STATES.has(normalize(status));
}

module.exports = {
  STATES, LEGACY, OPEN_STATES, TERMINAL, ALLOWED,
  normalize, canTransition, transition,
  classifyError, applyFilters, buildProtectiveOrders, nudgeAwayFromMark,
  checkInvariants, onProtectiveFill, resolveProtectiveRace, isActiveStatus,
};
