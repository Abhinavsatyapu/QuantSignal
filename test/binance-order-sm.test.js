'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sm = require('../server/binance-order-sm');

describe('order state machine transitions', () => {
  it('allows the happy path SIGNAL→…→CLOSED', () => {
    const path = ['SIGNAL', 'ENTRY_PENDING', 'PARTIAL', 'FILLED', 'PROTECTED', 'EXITING', 'CLOSED'];
    for (let i = 0; i < path.length - 1; i++) {
      const tr = sm.transition(path[i], path[i + 1]);
      assert.equal(tr.ok, true, `${path[i]}→${path[i + 1]}: ${tr.reason}`);
      assert.equal(tr.noop, false);
    }
  });
  it('idempotent self-transition', () => {
    const tr = sm.transition('PROTECTED', 'PROTECTED');
    assert.equal(tr.ok, true);
    assert.equal(tr.noop, true);
  });
  it('rejects illegal jumps', () => {
    assert.equal(sm.transition('SIGNAL', 'PROTECTED').ok, false);
    assert.equal(sm.transition('CLOSED', 'FILLED').ok, false);
    assert.equal(sm.transition('CANCELLED', 'ENTRY_PENDING').ok, false);
  });
  it('maps legacy statuses', () => {
    assert.equal(sm.normalize('pending'), 'ENTRY_PENDING');
    assert.equal(sm.normalize('open'), 'PROTECTED');
    assert.equal(sm.normalize('closed'), 'CLOSED');
    assert.ok(sm.isActiveStatus('pending'));
    assert.ok(sm.isActiveStatus('PROTECTED'));
    assert.ok(!sm.isActiveStatus('CLOSED'));
  });
  it('ERROR can recover', () => {
    assert.equal(sm.transition('ERROR', 'FILLED').ok, true);
    assert.equal(sm.transition('ERROR', 'PROTECTED').ok, true);
  });
});

describe('classifyError', () => {
  it('maps known Binance codes', () => {
    assert.equal(sm.classifyError({ code: -2022, message: 'ReduceOnly' }).kind, 'reduce_only_reject');
    assert.equal(sm.classifyError({ code: -2021, message: 'would immediately trigger' }).action, 'nudge_stop_tp');
    assert.equal(sm.classifyError({ code: -1021, message: 'Timestamp' }).action, 'sync_time');
    assert.equal(sm.classifyError({ code: -1003, message: 'rate limit' }).kind, 'rate_limit');
    assert.equal(sm.classifyError({ message: 'code=-2011' }).kind, 'unknown_order');
  });
});

describe('filters + protective orders', () => {
  const filters = {
    tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5,
    multiplierUp: 1.05, multiplierDown: 0.95,
  };
  it('snaps to tick/step and enforces minNotional', () => {
    const r = sm.applyFilters({ price: 100.004, qty: 0.1234, mark: 100, filters });
    assert.equal(r.price, 100);
    assert.equal(r.qty, 0.123);
    assert.ok(r.ok);
    const low = sm.applyFilters({ price: 100, qty: 0.001, mark: 100, filters });
    assert.ok(low.reasons.some((x) => /minNotional/.test(x)) || !low.ok);
  });
  it('PERCENT_PRICE snaps into band', () => {
    const r = sm.applyFilters({ price: 120, qty: 1, mark: 100, filters });
    assert.ok(r.price <= 105 + 1e-9);
    assert.ok(r.reasons.some((x) => /PERCENT_PRICE/.test(x)));
  });
  it('builds STOP_MARKET + TAKE_PROFIT limit reduceOnly', () => {
    const o = sm.buildProtectiveOrders({
      symbol: 'TSLAUSDT', direction: 'LONG', stopPx: 95.004, tpPx: 110.006,
      stopCid: 'qs-1-s', tpCid: 'qs-1-t', qty: 0.1234, filters, mark: 100,
    });
    assert.equal(o.stop.type, 'STOP_MARKET');
    assert.equal(o.stop.reduceOnly, 'true');
    assert.equal(o.tp.type, 'TAKE_PROFIT');
    assert.equal(o.tp.price, String(o.tpPx));
    assert.equal(o.tp.timeInForce, 'GTC');
    assert.ok(Number(o.stop.stopPrice) < 100);
    assert.ok(Number(o.tp.price) > 100);
  });
  it('nudgeAwayFromMark fixes -2021 side', () => {
    const n = sm.nudgeAwayFromMark({ direction: 'LONG', stopPx: 101, tpPx: 99, mark: 100, tickSize: 0.01 });
    assert.ok(n.stopPx < 100);
    assert.ok(n.tpPx > 100);
  });
});

describe('OCO + race + invariants', () => {
  it('onProtectiveFill cancels sibling', () => {
    const trade = { status: 'PROTECTED', stop_cid: 's', tp_cid: 't' };
    const a = sm.onProtectiveFill(trade, 'stop');
    assert.equal(a.cancelSibling, true);
    assert.equal(a.siblingCid, 't');
    assert.equal(a.closeReason, 'SL');
    const b = sm.onProtectiveFill(trade, 'tp');
    assert.equal(b.siblingCid, 's');
    assert.equal(b.closeReason, 'TP');
  });
  it('resolveProtectiveRace prefers earlier updateTime, else SL', () => {
    assert.equal(sm.resolveProtectiveRace({ updateTime: 1 }, { updateTime: 2 }), 'stop');
    assert.equal(sm.resolveProtectiveRace({ updateTime: 5 }, { updateTime: 2 }), 'tp');
    assert.equal(sm.resolveProtectiveRace({}, {}), 'stop');
  });
  it('invariants: unprotected timeout, protect qty, orphans', () => {
    const now = 1_000_000;
    const bad = sm.checkInvariants({
      status: 'FILLED', filled_qty: 1, filled_at: now - 10_000, stop_status: 'MISSING', tp_status: 'MISSING',
      symbol: 'X', entry_cid: 'e', stop_cid: 's', tp_cid: 't',
    }, { now, maxUnprotectedSec: 5 });
    assert.ok(bad.violations.some((v) => v.inv === 'unprotected_timeout'));

    const prot = sm.checkInvariants({
      status: 'PROTECTED', filled_qty: 2, protect_qty: 2, stop_status: 'ATTACHED', tp_status: 'ATTACHED', symbol: 'X',
    }, { now });
    assert.equal(prot.ok, true);

    const mismatch = sm.checkInvariants({
      status: 'PROTECTED', filled_qty: 2, protect_qty: 1, stop_status: 'ATTACHED', tp_status: 'ATTACHED', symbol: 'X',
    }, { now });
    assert.ok(mismatch.violations.some((v) => v.inv === 'protective_qty_eq_position'));

    const orphan = sm.checkInvariants({
      status: 'CLOSED', symbol: 'X', stop_cid: 's', tp_cid: 't', entry_cid: 'e',
    }, { now, openOrders: [{ symbol: 'X', clientOrderId: 's' }] });
    assert.ok(orphan.violations.some((v) => v.inv === 'no_orphan_orders'));

    const dupe = sm.checkInvariants({ status: 'ENTRY_PENDING', _entryCount: 2, symbol: 'X' }, { now });
    assert.ok(dupe.violations.some((v) => v.inv === 'one_entry_per_signal'));
  });
});
