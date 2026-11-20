// OMS tests: real Postgres (TEST_DATABASE_URL, a server where we may create databases) + mock Alpaca.
// Run: TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres node --test test/
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { Pool } = require("pg");
const Mock = require("./mock-alpaca"), Alpaca = require("../oms/alpaca"), DB = require("../oms/db"), Engine = require("../oms/engine"), risk = require("../oms/risk");
const ADMIN = process.env.TEST_DATABASE_URL;

async function setup(t, { limits } = {}) {
  const name = "omstest_" + Math.random().toString(36).slice(2, 10), admin = new Pool({ connectionString: ADMIN });
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new Pool({ connectionString: ADMIN.replace(/\/[^/]*$/, "/" + name) }); pool.on("error", () => {});
  const mock = await Mock.start(), broker = Alpaca.create({ ALPACA_KEY_ID: "K", ALPACA_SECRET_KEY: "S", ALPACA_TRADING_URL: mock.url, ALPACA_DATA_URL: mock.url });
  const db = DB.create(pool); await db.init();
  if (limits) await db.setConfig("limits", limits);
  const engine = Engine.create({ db, broker });
  t.after(async () => { engine.stop(); mock.close(); await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  return { db, engine, mock, pool, broker };
}
const ord = (o = {}) => ({ symbol: "AAPL", side: "buy", qty: 5, type: "limit", limit_price: 200, tif: "day", stop_loss: 196, reason: "test entry", idem_key: "k" + Math.random().toString(36).slice(2, 12), ...o });
const statusOf = async (db, id) => (await db.order(id)).status;
async function syncUntil(engine, db, id, want, n = 8) { for (let i = 0; i < n; i++) { await engine.sync(); if (want.includes(await statusOf(db, id))) return; } }

test("paper mode is the default; live needs both switches", () => {
  assert.equal(Alpaca.config({}).mode, "paper");
  assert.equal(Alpaca.config({ ALPACA_ENV: "live" }).mode, "paper");
  assert.equal(Alpaca.config({ ALPACA_ENV: "live" }).liveRequestedButNotApproved, true);
  assert.equal(Alpaca.config({ ALPACA_ENV: "live", OMS_LIVE_APPROVED: "yes" }).mode, "live");
});

test("risk engine: blocks and passes", () => {
  const base = { account: { equity: "100000", last_equity: "100000" }, positions: [], openOrders: [], clock: { is_open: true }, limits: {}, peakEquity: 100000, refPrice: 200 };
  assert.equal(risk.check({ order: ord(), ...base }).ok, true);
  assert.match(risk.check({ order: ord({ stop_loss: null }), ...base }).blocks.join(), /stop-loss is required/);
  assert.match(risk.check({ order: ord({ stop_loss: 205 }), ...base }).blocks.join(), /below the entry/);
  assert.match(risk.check({ order: ord({ qty: 100 }), ...base }).blocks.join(), /above the \$10000 limit/);
  assert.match(risk.check({ order: ord({ qty: 40, stop_loss: 150 }), ...base, limits: { maxOrderNotional: 1e9, maxPositionNotional: 1e9 } }).blocks.join(), /Risk to stop/);
  assert.match(risk.check({ order: ord(), ...base, account: { equity: "96000", last_equity: "100000" } }).blocks.join(), /Daily loss limit/);
  assert.match(risk.check({ order: ord(), ...base, account: { equity: "89000", last_equity: "89000" }, peakEquity: 100000 }).blocks.join(), /Max drawdown/);
  assert.match(risk.check({ order: ord({ type: "market", limit_price: null }), ...base, clock: { is_open: false } }).blocks.join(), /regular session/);
  assert.match(risk.check({ order: ord({ side: "sell", stop_loss: 204 }), ...base }).blocks.join(), /Short selling is disabled/);
  assert.match(risk.check({ order: ord(), ...base, limits: { killSwitch: true } }).blocks.join(), /Kill switch/);
  assert.match(risk.check({ order: ord(), ...base, openOrders: [{ id: "x", symbol: "AAPL", side: "buy" }] }).blocks.join(), /Duplicate/);
  const many = Array.from({ length: 10 }, (_, i) => ({ symbol: "S" + i, qty: "1", market_value: "10" }));
  assert.match(risk.check({ order: ord(), ...base, positions: many }).blocks.join(), /open positions/);
  // closing a position skips the opening-only checks (no stop needed, allowed past the daily loss limit)
  const closing = risk.check({ order: ord({ side: "sell", stop_loss: null, qty: 5 }), ...base, account: { equity: "96000", last_equity: "100000" }, positions: [{ symbol: "AAPL", qty: "5", market_value: "1000" }] });
  assert.equal(closing.ok, true); assert.equal(closing.metrics.intent, "close");
  assert.equal(risk.estimateFees("sell", 100, 200), Math.round((100 * 200 * 27.8 / 1e6 + 100 * 0.000166) * 100) / 100);
});

test("full lifecycle: proposed → approved → submitted → acknowledged → partially_filled → filled, never filled on submit", async t => {
  const { engine, db, mock } = await setup(t);
  const { order } = await engine.propose(ord({ qty: 10, limit_price: 200, stop_loss: 198 }));
  assert.equal(order.status, "proposed");
  const a = await engine.approve(order.id, "looks good");
  assert.notEqual(a.order.status, "filled", "a fresh submission must not be marked filled");
  assert.ok(["submitted", "acknowledged"].includes(a.order.status));
  const sent = mock.S.orders.get(a.order.broker_order_id);
  assert.equal(sent.client_order_id, order.idem_key); assert.equal(sent.order_class, "oto");
  await engine.sync(); assert.equal(await statusOf(db, order.id), "acknowledged");
  await engine.sync(); const p = await db.order(order.id);
  assert.equal(p.status, "partially_filled"); assert.equal(Number(p.filled_qty), 5);
  await engine.sync(); const f = await db.order(order.id);
  assert.equal(f.status, "filled"); assert.equal(Number(f.filled_qty), 10); assert.equal(Number(f.filled_avg_price), 200);
  const ev = (await db.q("SELECT to_status FROM oms_events WHERE order_id=$1 ORDER BY id", [order.id])).rows.map(r => r.to_status);
  assert.deepEqual(ev, ["proposed", "approved", "submitted", "acknowledged", "partially_filled", "filled"]);
  assert.equal((await db.q("SELECT count(*)::int c FROM oms_fills WHERE order_id=$1", [order.id])).rows[0].c, 2);
});

test("idempotency: same key returns the same order; broker never gets a second copy", async t => {
  const { engine, mock } = await setup(t);
  const o = ord();
  const [a, b] = await Promise.all([engine.propose(o), engine.propose(o)]);
  assert.equal(a.order.id, b.order.id);
  await engine.approve(a.order.id, "approve: go");
  await assert.rejects(engine.approve(a.order.id, "approve: again"), /not proposed/);
  assert.equal([...mock.S.orders.values()].filter(x => x.client_order_id === o.idem_key).length, 1);
});

test("concurrent approvals: exactly one wins", async t => {
  const { engine, mock } = await setup(t);
  const { order } = await engine.propose(ord());
  const r = await Promise.allSettled([engine.approve(order.id, "approve: a"), engine.approve(order.id, "approve: b"), engine.approve(order.id, "approve: c")]);
  assert.equal(r.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(mock.S.orders.size, 1);
});

test("duplicate protection: second open buy for the same symbol is blocked", async t => {
  const { engine } = await setup(t);
  const a = await engine.propose(ord({ symbol: "SLOWX", limit_price: 50, stop_loss: 49 }));
  await engine.approve(a.order.id, "approve: first");
  const b = await engine.propose(ord({ symbol: "SLOWX", limit_price: 50, stop_loss: 49 }));
  assert.equal(b.order.status, "blocked"); assert.match(b.risk.blocks.join(), /Duplicate/);
});

test("rejections: refused at request → rejected; rejected later by exchange → rejected", async t => {
  const { engine, db } = await setup(t);
  const a = await engine.propose(ord({ symbol: "REJX", limit_price: 10, stop_loss: 9.8 }));
  assert.equal((await engine.approve(a.order.id, "approve: try")).order.status, "rejected");
  assert.match((await db.order(a.order.id)).error, /insufficient buying power/);
  const b = await engine.propose(ord({ symbol: "LATEX", limit_price: 20, stop_loss: 19.6 }));
  await engine.approve(b.order.id, "approve: try"); await syncUntil(engine, db, b.order.id, ["rejected"]);
  assert.equal(await statusOf(db, b.order.id), "rejected");
});

test("risk re-checked at approval: kill switch turned on after proposal blocks the submit", async t => {
  const { engine, db, mock } = await setup(t);
  const { order } = await engine.propose(ord());
  await engine.setKill(true, "stop everything");
  const r = await engine.approve(order.id, "approve: go");
  assert.equal(r.order.status, "blocked"); assert.equal(mock.S.orders.size, 0);
  const n = await engine.propose(ord()); assert.equal(n.order.status, "blocked");
  await engine.setKill(false, "resume");
  assert.equal((await engine.propose(ord({ symbol: "MSFT", limit_price: 400, stop_loss: 396 }))).order.status, "proposed");
  assert.ok((await db.q("SELECT count(*)::int c FROM oms_audit WHERE action='kill_switch'")).rows[0].c === 2);
});

test("kill switch with cancel-all cancels working orders at the broker", async t => {
  const { engine, db } = await setup(t);
  const { order } = await engine.propose(ord({ symbol: "SLOWX", limit_price: 50, stop_loss: 49 }));
  await engine.approve(order.id, "approve: go"); await engine.sync();
  await engine.setKill(true, "emergency", { cancelAll: true });
  await syncUntil(engine, db, order.id, ["canceled"]);
  assert.equal(await statusOf(db, order.id), "canceled");
});

test("cancel: status only changes when the broker confirms", async t => {
  const { engine, db } = await setup(t);
  const { order } = await engine.propose(ord({ symbol: "SLOWX", limit_price: 50, stop_loss: 49 }));
  await engine.approve(order.id, "approve: go"); await engine.sync();
  const r = await engine.cancel(order.id, "changed my mind");
  assert.equal(r.order.status, "canceled");
  await assert.rejects(engine.cancel(order.id, "again"), /only orders open/);
});

test("modify: old order becomes replaced, child order continues with new price", async t => {
  const { engine, db, mock } = await setup(t);
  const { order } = await engine.propose(ord({ symbol: "SLOWX", limit_price: 50, stop_loss: 49 }));
  await engine.approve(order.id, "approve: go"); await engine.sync();
  const r = await engine.modify(order.id, { limit_price: 50.5 }, "improve price");
  assert.equal(await statusOf(db, order.id), "replaced");
  assert.equal(Number(r.order.limit_price), 50.5); assert.equal(r.order.parent_id, order.id);
  assert.equal(mock.S.orders.get(r.order.broker_order_id).limit_price, "50.5");
});

test("restart recovery: approved-but-unconfirmed orders are looked up, never resent", async t => {
  const { engine, db, mock, broker } = await setup(t);
  const a = await engine.propose(ord());
  await db.q("UPDATE oms_orders SET status='approved' WHERE id=$1", [a.order.id]);            // crashed before the broker call
  const b = await engine.propose(ord({ symbol: "MSFT", limit_price: 400, stop_loss: 396 }));
  await db.q("UPDATE oms_orders SET status='approved' WHERE id=$1", [b.order.id]);            // crashed after the broker call
  await broker.submitOrder(engine.brokerPayload(await db.order(b.order.id)));
  const before = mock.S.orders.size;
  assert.equal(await engine.recover(), 2);
  assert.equal(await statusOf(db, a.order.id), "proposed");                                     // needs a new approval
  assert.ok(["submitted", "acknowledged"].includes(await statusOf(db, b.order.id)));           // linked to the existing broker order
  assert.equal(mock.S.orders.size, before);
});

test("broker outage during submit: order stays open and is reconciled, not duplicated", async t => {
  const { engine, db, mock } = await setup(t);
  const { order } = await engine.propose(ord());
  mock.S.failSubmit = 1;                                                                     // the submit call fails with 503
  const r = await engine.approve(order.id, "approve: go");
  assert.equal(r.order.status, "submitted"); assert.match(r.order.error, /unknown/);
  await engine.sync();                                                                       // broker never received it
  assert.equal(mock.S.orders.size, 0);
});

test("fills, realized P&L and reconciliation", async t => {
  const { engine, db, mock } = await setup(t);
  const a = await engine.propose(ord({ qty: 5, limit_price: 200, stop_loss: 196 }));
  await engine.approve(a.order.id, "approve: buy"); await syncUntil(engine, db, a.order.id, ["filled"]);
  mock.S.prices.AAPL = 210;
  const b = await engine.propose(ord({ side: "sell", qty: 5, limit_price: 210, stop_loss: null, reason: "take profit" }));
  assert.equal(b.order.intent, "close");
  await engine.approve(b.order.id, "approve: tp"); await syncUntil(engine, db, b.order.id, ["filled"]);
  const p = (await engine.pnl()).find(x => x.symbol === "AAPL");
  const fees = risk.estimateFees("sell", 5, 210);
  assert.equal(p.realized, Math.round((50 - fees) * 100) / 100);
  assert.equal((await engine.reconcile()).ok, true);
  mock.S.positions.set("TSLA", { qty: 3, cost: 900 });                                       // a trade made outside the OMS
  const rec = await engine.reconcile(); assert.equal(rec.ok, false); assert.equal(rec.diffs[0].symbol, "TSLA");
});

test("validation: reason and idempotency key are mandatory", async t => {
  const { engine } = await setup(t);
  await assert.rejects(engine.propose(ord({ reason: "" })), /reason is required/);
  await assert.rejects(engine.propose(ord({ idem_key: "x" })), /idem_key/);
  const { order } = await engine.propose(ord());
  await assert.rejects(engine.approve(order.id, ""), /reason is required/);
});
