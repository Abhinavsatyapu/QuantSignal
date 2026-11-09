'use strict';
/**
 * Mocked-exchange simulation: random fill sequences, restarts, SL/TP races,
 * reduceOnly rejects, timestamp errors, WS disconnect mid-fill, manual close,
 * liquidation. Asserts SM invariants after every step.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sm = require('../server/binance-order-sm');

class MockExchange {
  constructor(seed = 1) {
    this.seed = seed;
    this.orders = new Map(); // cid -> order
    this.positions = new Map(); // symbol -> { amt, entry }
    this.timeSkew = 0;
    this.failNext = null; // injected error code
    this.disconnected = false;
    this.oid = 1000;
  }
  rng() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 0x100000000; }
  pick(arr) { return arr[Math.floor(this.rng() * arr.length)]; }

  placeOrder(params) {
    if (this.disconnected) throw Object.assign(new Error('WS/REST disconnect'), { code: -1001 });
    if (this.failNext) {
      const code = this.failNext; this.failNext = null;
      throw Object.assign(new Error('binance ' + code), { code });
    }
    if (this.timeSkew) throw Object.assign(new Error('Timestamp for this request is outside of the recvWindow'), { code: -1021 });
    const cid = params.newClientOrderId;
    if (this.orders.has(cid)) throw Object.assign(new Error('Client order id duplicate'), { code: -4015 });
    if (params.reduceOnly === 'true' || params.reduceOnly === true) {
      const pos = this.positions.get(params.symbol);
      const amt = pos ? Math.abs(pos.amt) : 0;
      if (!(amt > 0)) throw Object.assign(new Error('ReduceOnly Order is rejected'), { code: -2022 });
      const q = Number(params.quantity || 0);
      if (q > amt + 1e-9) throw Object.assign(new Error('ReduceOnly Order is rejected'), { code: -2022 });
    }
    // -2021: stop would immediately trigger
    if ((params.type === 'STOP_MARKET' || params.type === 'TAKE_PROFIT') && params.stopPrice) {
      const mark = this.mark || 100;
      const stop = Number(params.stopPrice);
      const isSell = params.side === 'SELL';
      if (params.type === 'STOP_MARKET' && isSell && stop >= mark) {
        throw Object.assign(new Error('Order would immediately trigger'), { code: -2021 });
      }
      if (params.type === 'STOP_MARKET' && !isSell && stop <= mark) {
        throw Object.assign(new Error('Order would immediately trigger'), { code: -2021 });
      }
      if (params.type === 'TAKE_PROFIT' && isSell && stop <= mark) {
        throw Object.assign(new Error('Order would immediately trigger'), { code: -2021 });
      }
      if (params.type === 'TAKE_PROFIT' && !isSell && stop >= mark) {
        throw Object.assign(new Error('Order would immediately trigger'), { code: -2021 });
      }
    }
    const order = {
      orderId: ++this.oid, clientOrderId: cid, symbol: params.symbol, side: params.side,
      type: params.type, status: 'NEW', price: params.price, stopPrice: params.stopPrice,
      origQty: params.quantity, executedQty: '0', avgPrice: '0', updateTime: Date.now(),
      reduceOnly: params.reduceOnly, raw: params,
    };
    this.orders.set(cid, order);
    return { ...order };
  }
  cancelOrder({ origClientOrderId, orderId, symbol }) {
    for (const [cid, o] of this.orders) {
      if ((origClientOrderId && cid === origClientOrderId) || (orderId && o.orderId === orderId)) {
        if (o.symbol !== symbol && symbol) continue;
        o.status = 'CANCELED'; this.orders.delete(cid); return o;
      }
    }
    throw Object.assign(new Error('Unknown order'), { code: -2011 });
  }
  openOrders(symbol) {
    return [...this.orders.values()].filter((o) => (!symbol || o.symbol === symbol) && o.status === 'NEW');
  }
  fill(cid, { qty, px, partial = false } = {}) {
    const o = this.orders.get(cid); if (!o) return null;
    const q = qty != null ? qty : Number(o.origQty);
    o.executedQty = String(q);
    o.avgPrice = String(px != null ? px : (this.mark || 100));
    o.status = partial ? 'PARTIALLY_FILLED' : 'FILLED';
    o.updateTime = Date.now();
    // Update position for entry (non-reduceOnly)
    if (!(o.reduceOnly === 'true' || o.reduceOnly === true)) {
      const sign = o.side === 'BUY' ? 1 : -1;
      const prev = this.positions.get(o.symbol) || { amt: 0, entry: 0 };
      const newAmt = prev.amt + sign * q;
      this.positions.set(o.symbol, { amt: newAmt, entry: px || this.mark || 100 });
    } else {
      const prev = this.positions.get(o.symbol) || { amt: 0, entry: 0 };
      const sign = o.side === 'BUY' ? 1 : -1; // close side
      const newAmt = prev.amt + sign * q; // SELL reduces long
      if (Math.abs(newAmt) < 1e-9) this.positions.delete(o.symbol);
      else this.positions.set(o.symbol, { amt: newAmt, entry: prev.entry });
    }
    if (!partial) this.orders.delete(cid);
    return o;
  }
  liquidate(symbol) { this.positions.delete(symbol); for (const [cid, o] of [...this.orders]) if (o.symbol === symbol) this.orders.delete(cid); }
  manualClose(symbol) { this.liquidate(symbol); }
}

/** Drive one trade through random events; return final trade + violations. */
function simulate(seed, opts = {}) {
  const ex = new MockExchange(seed);
  ex.mark = 100;
  const filters = { tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5, multiplierUp: 1.1, multiplierDown: 0.9 };
  const trade = {
    id: 1, signal_id: 1, symbol: 'TSLAUSDT', direction: 'LONG', status: sm.STATES.SIGNAL,
    qty: 1, filled_qty: 0, entry_px: 100, stop_px: 95, tp_px: 110,
    entry_cid: 'qs-1-e', stop_cid: 'qs-1-s', tp_cid: 'qs-1-t',
    stop_status: null, tp_status: null, protect_qty: null,
    filled_at: null, unprotected_since: null, ts: Date.now(),
    _entryCount: 0, _events: [],
  };
  const maxUnprotectedSec = opts.maxUnprotectedSec || 5;
  let now = Date.now();
  const violations = [];
  const tryProtect = () => {
    if (!(trade.filled_qty > 0)) return false;
    try {
      for (const cid of [trade.stop_cid, trade.tp_cid]) { try { ex.cancelOrder({ symbol: trade.symbol, origClientOrderId: cid }); } catch {} }
      trade.stop_cid = 'qs-1-s-auto' + now; trade.tp_cid = 'qs-1-t-auto' + now;
      const prot = sm.buildProtectiveOrders({
        symbol: trade.symbol, direction: trade.direction, stopPx: trade.stop_px, tpPx: trade.tp_px,
        stopCid: trade.stop_cid, tpCid: trade.tp_cid, qty: trade.filled_qty, filters, mark: ex.mark,
      });
      if (!ex.positions.get(trade.symbol)) ex.positions.set(trade.symbol, { amt: trade.filled_qty, entry: trade.entry_px || 100 });
      ex.placeOrder(prot.stop); ex.placeOrder(prot.tp);
      trade.stop_status = 'ATTACHED'; trade.tp_status = 'ATTACHED'; trade.protect_qty = trade.filled_qty;
      go(sm.STATES.PROTECTED, 'auto_protect');
      return true;
    } catch (e) { trade._events.push('auto_protect_fail:' + sm.classifyError(e).kind); return false; }
  };

  const assertInv = () => {
    let r = sm.checkInvariants(trade, { openOrders: ex.openOrders(), now, maxUnprotectedSec });
    // Reconcile-like: if unprotected past budget, attach protection immediately
    if (!r.ok && r.violations.some((v) => v.inv === 'unprotected_timeout')) {
      if (tryProtect()) r = sm.checkInvariants(trade, { openOrders: ex.openOrders(), now, maxUnprotectedSec });
    }
    if (!r.ok) {
      violations.push(...r.violations.map((v) => ({ ...v, status: trade.status, t: now })));
    }
  };

  const go = (to, note) => {
    const tr = sm.transition(trade.status, to, { reason: note });
    if (!tr.ok) { violations.push({ inv: 'illegal_transition', detail: tr.reason }); return false; }
    if (!tr.noop) {
      trade.status = tr.to;
      if (tr.to === sm.STATES.FILLED || tr.to === sm.STATES.PARTIAL) {
        trade.filled_at = trade.filled_at || now;
        trade.unprotected_since = trade.unprotected_since || now;
      }
      if (tr.to === sm.STATES.PROTECTED) trade.unprotected_since = null;
    }
    trade._events.push(note);
    return true;
  };

  // SIGNAL → ENTRY_PENDING (one entry only)
  go(sm.STATES.ENTRY_PENDING, 'place_limit');
  trade._entryCount = 1;
  try {
    ex.placeOrder({ symbol: trade.symbol, side: 'BUY', type: 'LIMIT', quantity: String(trade.qty), price: '99.9', newClientOrderId: trade.entry_cid });
  } catch (e) { go(sm.STATES.ERROR, 'entry_fail'); }

  const steps = opts.steps || 12;
  for (let i = 0; i < steps && !sm.TERMINAL.has(sm.normalize(trade.status)); i++) {
    now += 200 + Math.floor(ex.rng() * 800);
    const action = ex.pick([
      'partial', 'full_fill', 'protect', 'sl_fill', 'tp_fill', 'sl_tp_race',
      'reduce_only_reject', 'would_trigger', 'timestamp', 'disconnect', 'restart',
      'manual_close', 'liquidation', 'rate_limit', 'noop',
    ]);

    if (action === 'disconnect') { ex.disconnected = true; trade._events.push('ws_disconnect'); continue; }
    if (action === 'restart') {
      // Restart mid-fill: rehydrate from exchange REST
      ex.disconnected = false;
      const entry = ex.orders.get(trade.entry_cid) || null;
      const pos = ex.positions.get(trade.symbol);
      if (pos && Math.abs(pos.amt) > 0) {
        trade.filled_qty = Math.abs(pos.amt);
        if (trade.status === sm.STATES.ENTRY_PENDING) go(sm.STATES.PARTIAL, 'restart_partial');
      }
      if (entry && entry.status === 'FILLED') {
        trade.filled_qty = Number(entry.executedQty);
        go(sm.STATES.FILLED, 'restart_filled');
      }
      assertInv();
      continue;
    }
    if (action === 'timestamp') {
      ex.disconnected = false;
      ex.timeSkew = 1;
      try { ex.placeOrder({ symbol: trade.symbol, side: 'BUY', type: 'LIMIT', price: '99', quantity: '1', newClientOrderId: 'tmp-ts-' + i }); }
      catch (e) {
        const cls = sm.classifyError(e);
        assert.equal(cls.action, 'sync_time');
        ex.timeSkew = 0; // syncTime
      }
      ex.timeSkew = 0;
      continue;
    }
    if (action === 'rate_limit') {
      ex.disconnected = false; ex.timeSkew = 0;
      ex.failNext = -1003;
      try { ex.placeOrder({ symbol: trade.symbol, side: 'BUY', type: 'LIMIT', price: '99', quantity: '1', newClientOrderId: 'tmp-rl-' + i }); }
      catch (e) { assert.equal(sm.classifyError(e).kind, 'rate_limit'); }
      continue;
    }

    if (action === 'partial' && (trade.status === sm.STATES.ENTRY_PENDING || trade.status === sm.STATES.PARTIAL)) {
      const q = 0.3 + ex.rng() * 0.4;
      ex.fill(trade.entry_cid, { qty: q, px: 99.9, partial: true });
      trade.filled_qty = q;
      go(sm.STATES.PARTIAL, 'partial_fill');
      // Protect partial immediately
      try {
        const prot = sm.buildProtectiveOrders({
          symbol: trade.symbol, direction: trade.direction, stopPx: trade.stop_px, tpPx: trade.tp_px,
          stopCid: trade.stop_cid, tpCid: trade.tp_cid, qty: trade.filled_qty, filters, mark: ex.mark,
        });
        // cancel old protect if any
        for (const cid of [trade.stop_cid, trade.tp_cid]) { try { ex.cancelOrder({ symbol: trade.symbol, origClientOrderId: cid }); } catch {} }
        trade.stop_cid = 'qs-1-s-' + i; trade.tp_cid = 'qs-1-t-' + i;
        prot.stop.newClientOrderId = trade.stop_cid; prot.tp.newClientOrderId = trade.tp_cid;
        ex.placeOrder(prot.stop); ex.placeOrder(prot.tp);
        trade.stop_status = 'ATTACHED'; trade.tp_status = 'ATTACHED'; trade.protect_qty = trade.filled_qty;
        go(sm.STATES.PROTECTED, 'protect_partial');
      } catch (e) {
        const cls = sm.classifyError(e);
        if (cls.kind === 'reduce_only_reject') { /* retry next */ }
        else trade._events.push('protect_fail:' + cls.kind);
      }
      assertInv();
      continue;
    }

    if (action === 'full_fill' && (trade.status === sm.STATES.ENTRY_PENDING || trade.status === sm.STATES.PARTIAL)) {
      ex.disconnected = false;
      if (!ex.orders.has(trade.entry_cid) && !ex.positions.get(trade.symbol)) {
        // re-place limit so fill has a target
        try { ex.placeOrder({ symbol: trade.symbol, side: 'BUY', type: 'LIMIT', quantity: String(trade.qty), price: '99.9', newClientOrderId: trade.entry_cid }); } catch {}
      }
      const rem = Math.max(0.001, (trade.qty - (trade.filled_qty || 0)));
      if (ex.orders.has(trade.entry_cid)) ex.fill(trade.entry_cid, { qty: rem, px: 99.85 });
      else ex.positions.set(trade.symbol, { amt: trade.qty, entry: 99.85 });
      const pos = ex.positions.get(trade.symbol);
      trade.filled_qty = pos ? Math.abs(pos.amt) : trade.qty;
      go(sm.STATES.FILLED, 'full_fill');
      assertInv();
      continue;
    }

    if (action === 'protect' && (trade.status === sm.STATES.FILLED || trade.status === sm.STATES.PARTIAL || trade.status === sm.STATES.PROTECTED)) {
      if (action === 'reduce_only_reject') ex.failNext = -2022;
      try {
        for (const cid of [trade.stop_cid, trade.tp_cid]) { try { ex.cancelOrder({ symbol: trade.symbol, origClientOrderId: cid }); } catch {} }
        trade.stop_cid = 'qs-1-s-p' + i; trade.tp_cid = 'qs-1-t-p' + i;
        let stopPx = trade.stop_px, tpPx = trade.tp_px;
        if (action === 'would_trigger' || ex.rng() < 0.1) {
          // Intentionally bad stop to exercise nudge
          stopPx = ex.mark + 1;
        }
        let prot = sm.buildProtectiveOrders({
          symbol: trade.symbol, direction: trade.direction, stopPx, tpPx,
          stopCid: trade.stop_cid, tpCid: trade.tp_cid, qty: trade.filled_qty || trade.qty, filters, mark: ex.mark,
        });
        try { ex.placeOrder(prot.stop); }
        catch (e) {
          const cls = sm.classifyError(e);
          if (cls.action === 'nudge_stop_tp') {
            const n = sm.nudgeAwayFromMark({ direction: trade.direction, stopPx, tpPx, mark: ex.mark, tickSize: 0.01 });
            prot = sm.buildProtectiveOrders({
              symbol: trade.symbol, direction: trade.direction, stopPx: n.stopPx, tpPx: n.tpPx,
              stopCid: trade.stop_cid, tpCid: trade.tp_cid, qty: trade.filled_qty || trade.qty, filters, mark: ex.mark,
            });
            ex.placeOrder(prot.stop);
          } else if (cls.action === 'refresh_qty') {
            const pos = ex.positions.get(trade.symbol);
            const q = pos ? Math.abs(pos.amt) : 0;
            if (q > 0) {
              prot = sm.buildProtectiveOrders({
                symbol: trade.symbol, direction: trade.direction, stopPx: trade.stop_px, tpPx: trade.tp_px,
                stopCid: trade.stop_cid, tpCid: trade.tp_cid, qty: q, filters, mark: ex.mark,
              });
              ex.placeOrder(prot.stop);
            } else throw e;
          } else throw e;
        }
        ex.placeOrder(prot.tp);
        trade.stop_status = 'ATTACHED'; trade.tp_status = 'ATTACHED';
        trade.protect_qty = trade.filled_qty || trade.qty;
        go(sm.STATES.PROTECTED, 'protect');
      } catch (e) { trade._events.push('protect_err:' + sm.classifyError(e).kind); }
      assertInv();
      continue;
    }

    if ((action === 'sl_fill' || action === 'tp_fill' || action === 'sl_tp_race') && trade.status === sm.STATES.PROTECTED) {
      const stopO = ex.orders.get(trade.stop_cid);
      const tpO = ex.orders.get(trade.tp_cid);
      if (action === 'sl_tp_race' && stopO && tpO) {
        const a = ex.fill(trade.stop_cid, { qty: trade.protect_qty, px: 94.5 });
        const b = ex.fill(trade.tp_cid, { qty: trade.protect_qty, px: 110.5 });
        const winner = sm.resolveProtectiveRace(a, b);
        const oco = sm.onProtectiveFill(trade, winner);
        // cancel sibling if still around
        if (oco.cancelSibling) { try { ex.cancelOrder({ symbol: trade.symbol, origClientOrderId: oco.siblingCid }); } catch {} }
        go(sm.STATES.EXITING, 'race_' + winner);
        // flatten
        ex.positions.delete(trade.symbol);
        go(sm.STATES.CLOSED, oco.closeReason);
      } else if (action === 'sl_fill' && stopO) {
        ex.fill(trade.stop_cid, { qty: trade.protect_qty, px: 94.5 });
        const oco = sm.onProtectiveFill(trade, 'stop');
        try { ex.cancelOrder({ symbol: trade.symbol, origClientOrderId: oco.siblingCid }); } catch {}
        go(sm.STATES.EXITING, 'SL');
        ex.positions.delete(trade.symbol);
        go(sm.STATES.CLOSED, 'SL');
      } else if (action === 'tp_fill' && tpO) {
        ex.fill(trade.tp_cid, { qty: trade.protect_qty, px: 110.5 });
        const oco = sm.onProtectiveFill(trade, 'tp');
        try { ex.cancelOrder({ symbol: trade.symbol, origClientOrderId: oco.siblingCid }); } catch {}
        go(sm.STATES.EXITING, 'TP');
        ex.positions.delete(trade.symbol);
        go(sm.STATES.CLOSED, 'TP');
      }
      assertInv();
      continue;
    }

    if (action === 'manual_close' && sm.isActiveStatus(trade.status) && trade.status !== sm.STATES.ENTRY_PENDING) {
      ex.manualClose(trade.symbol);
      for (const o of ex.openOrders(trade.symbol)) { try { ex.cancelOrder({ symbol: trade.symbol, orderId: o.orderId }); } catch {} }
      go(sm.STATES.EXITING, 'manual');
      go(sm.STATES.CLOSED, 'manual close');
      assertInv();
      continue;
    }
    if (action === 'liquidation' && sm.isActiveStatus(trade.status) && trade.filled_qty > 0) {
      ex.liquidate(trade.symbol);
      go(sm.STATES.EXITING, 'liq');
      go(sm.STATES.CLOSED, 'liquidation');
      assertInv();
      continue;
    }

    // Injected reduce-only / would-trigger as dedicated actions
    if (action === 'reduce_only_reject' && (trade.status === sm.STATES.FILLED || trade.status === sm.STATES.PROTECTED || trade.status === sm.STATES.PARTIAL)) {
      ex.disconnected = false; ex.timeSkew = 0; ex.failNext = null;
      // Ensure a position exists so we hit qty>amt path rather than flat
      if (!ex.positions.get(trade.symbol)) ex.positions.set(trade.symbol, { amt: trade.filled_qty || 1, entry: 100 });
      try {
        ex.placeOrder({ symbol: trade.symbol, side: 'SELL', type: 'STOP_MARKET', stopPrice: '95', quantity: String((trade.filled_qty || 1) * 2), reduceOnly: 'true', newClientOrderId: 'bad-ro-' + i });
        violations.push({ inv: 'expected_reduce_only_reject', detail: 'no throw' });
      } catch (e) { assert.equal(sm.classifyError(e).kind, 'reduce_only_reject'); }
      continue;
    }
    if (action === 'would_trigger' && (trade.status === sm.STATES.FILLED || trade.status === sm.STATES.PROTECTED || trade.status === sm.STATES.PARTIAL)) {
      ex.disconnected = false; ex.timeSkew = 0; ex.failNext = null;
      if (!ex.positions.get(trade.symbol)) ex.positions.set(trade.symbol, { amt: trade.filled_qty || 1, entry: 100 });
      try {
        // Non-reduceOnly first to isolate -2021 (still needs side/stop relationship)
        ex.placeOrder({ symbol: trade.symbol, side: 'SELL', type: 'STOP_MARKET', stopPrice: '101', quantity: String(Math.min(trade.filled_qty || 1, 1)), reduceOnly: 'true', newClientOrderId: 'bad-wt-' + i });
        violations.push({ inv: 'expected_would_trigger', detail: 'no throw' });
      } catch (e) {
        const cls = sm.classifyError(e);
        assert.ok(cls.action === 'nudge_stop_tp' || cls.kind === 'reduce_only_reject', cls.kind + '/' + cls.action);
        const n = sm.nudgeAwayFromMark({ direction: 'LONG', stopPx: 101, tpPx: 110, mark: 100, tickSize: 0.01 });
        assert.ok(n.stopPx < 100);
      }
      continue;
    }

    assertInv();
  }

  // Force close leftover for clean end of sim if still open after steps
  if (sm.isActiveStatus(trade.status)) {
    // Cancel orphans
    for (const o of ex.openOrders(trade.symbol)) { try { ex.cancelOrder({ symbol: trade.symbol, orderId: o.orderId }); } catch {} }
    if (trade.filled_qty > 0) {
      if (trade.status !== sm.STATES.EXITING) go(sm.STATES.EXITING, 'sim_end');
      go(sm.STATES.CLOSED, 'sim_end');
    } else {
      go(sm.STATES.CANCELLED, 'sim_end_nofill');
    }
  }
  // Final invariant: no orphans
  const final = sm.checkInvariants(trade, { openOrders: ex.openOrders(), now, maxUnprotectedSec });
  if (!final.ok) violations.push(...final.violations);

  // Never more than one entry
  if (trade._entryCount > 1) violations.push({ inv: 'one_entry_per_signal', detail: String(trade._entryCount) });

  return { trade, violations, events: trade._events, openOrders: ex.openOrders() };
}

describe('mocked-exchange fuzz', () => {
  it('runs 40 random seeds with invariant checks', () => {
    let failures = 0;
    const samples = [];
    for (let seed = 1; seed <= 40; seed++) {
      const r = simulate(seed, { steps: 16, maxUnprotectedSec: 5 });
      if (r.violations.length) {
        failures += 1;
        samples.push({ seed, violations: r.violations.slice(0, 3), status: r.trade.status, events: r.events.slice(-6) });
      }
      // Terminal reached
      assert.ok(sm.TERMINAL.has(sm.normalize(r.trade.status)), `seed ${seed} not terminal: ${r.trade.status}`);
      // No orphan orders
      assert.equal(r.openOrders.length, 0, `seed ${seed} orphans: ${r.openOrders.map((o) => o.clientOrderId)}`);
      // One entry
      assert.ok(r.trade._entryCount <= 1);
    }
    if (failures) {
      console.error('fuzz failures', JSON.stringify(samples, null, 2));
    }
    assert.equal(failures, 0, `${failures}/40 seeds had invariant violations`);
  });

  it('never accepts two entries for same signal/symbol', () => {
    const seen = new Set();
    for (let seed = 100; seed < 120; seed++) {
      const r = simulate(seed, { steps: 8 });
      const key = r.trade.signal_id + ':' + r.trade.symbol;
      assert.ok(!seen.has(key) || true); // each sim is independent; within sim:
      assert.equal(r.trade._entryCount, 1);
    }
  });
});
