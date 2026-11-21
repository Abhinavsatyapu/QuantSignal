// OMS end to end with the built-in paper broker on a real Postgres: propose → risk → approve → fill at the live ask →
// fill import → realized P&L → reconciliation, and the broker state surviving a restart.
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { Pool } = require("pg");
const Sim = require("../oms/simbroker"), DB = require("../oms/db"), Engine = require("../oms/engine");
const ADMIN = process.env.TEST_DATABASE_URL;
test("OMS + built-in paper broker, end to end", { skip: !ADMIN && "set TEST_DATABASE_URL" }, async t => {
  const name = "omssim_" + Math.random().toString(36).slice(2, 10), admin = new Pool({ connectionString: ADMIN }); await admin.query(`CREATE DATABASE ${name}`);
  const pool = new Pool({ connectionString: ADMIN.replace(/\/[^/]*$/, "/" + name) }); pool.on("error", () => {});
  let T = Date.parse("2026-11-23T10:00:00-05:00"); const Q = { AAPL: { last: 200, bid: 199.95, ask: 200.05 } };
  const mk = () => Sim.create({ quote: async s => Q[s] && { ...Q[s], source: "test" }, store: Sim.pgStore(pool), now: () => T });
  let broker = mk(); const db = DB.create(pool); await db.init(); const engine = Engine.create({ db, broker, now: () => T });
  t.after(async () => { engine.stop(); broker.stop(); await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });

  const p = await engine.propose({ symbol: "AAPL", side: "buy", qty: 10, type: "market", tif: "day", stop_loss: 195, reason: "sim e2e entry", idem_key: "sime2e-0001" });
  assert.equal(p.order.status, "proposed", JSON.stringify(p.risk && p.risk.blocks));
  const a = await engine.approve(p.order.id, "approve sim e2e");
  for (let i = 0; i < 4; i++) { T += 6000; await engine.sync(); }
  let o = await db.order(p.order.id);
  assert.equal(o.status, "filled"); assert.equal(Number(o.filled_avg_price), 200.05);
  const fills = (await db.q("SELECT * FROM oms_fills ORDER BY at")).rows;
  assert.ok(fills.some(f => f.order_id === o.id && Number(f.price) === 200.05), "parent fill imported");
  // stop-loss leg (oto) is working at the broker; price falls through it
  Q.AAPL = { last: 194.5, bid: 194.4, ask: 194.6 }; for (let i = 0; i < 3; i++) { T += 6000; await engine.sync(); }
  assert.equal((await broker.positions()).length, 0, "stop leg closed the position");
  const pnl = await engine.pnl(), row = (pnl.bySymbol || pnl).find ? (pnl.bySymbol || pnl).find(x => x.symbol === "AAPL") : null;
  const fees = (await db.q("SELECT coalesce(sum(est_fees),0)::float AS f FROM oms_fills")).rows[0].f;
  assert.ok(row, "AAPL row in pnl"); assert.ok(Math.abs(Number(row.realized) - ((194.4 - 200.05) * 10 - fees)) < 1e-6, `realized P&L from fills, net of fees: ${row.realized} vs ${(194.4 - 200.05) * 10 - fees}`);
  const rec = await engine.reconcile(); assert.equal(rec.ok, true, JSON.stringify(rec.diffs));
  // restart: a new broker instance reads the same account from Postgres
  const cash = Number((await broker.account()).cash); broker.stop(); broker = mk();
  await new Promise(r => setTimeout(r, 100)); assert.equal(Number((await broker.account()).cash), cash);
  const st = await engine.status(); assert.equal(st.configured, true);
});
