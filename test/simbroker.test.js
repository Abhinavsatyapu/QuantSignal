// Built-in paper broker: fills against quotes under the documented rules, with a controllable clock and quote feed.
const test = require("node:test"), assert = require("node:assert/strict"), Sim = require("../oms/simbroker");
const ET = (d, hm) => Date.parse(`${d}T${hm}:00-05:00`);                       // November: New York is UTC−5
function rig(t0 = ET("2026-11-23", "10:00")) {
  const Q = { AAPL: { last: 200, bid: 199.9, ask: 200.1 }, MSFT: { last: 400, bid: 399.8, ask: 400.2 } }; let t = t0;
  const mem = { data: null }, store = { load: async () => mem.data, save: async s => { mem.data = JSON.parse(JSON.stringify(s)); } };
  const b = Sim.create({ quote: async s => Q[s] ? { ...Q[s], source: "test" } : null, store, now: () => t, startCash: 100000 });
  return { b, Q, mem, set: ms => { t = ms; }, tick: async () => { t += 6000; await b.evaluate(true); } };
}
test("market buy fills at the ask during regular hours; cash, position and fill recorded", async () => {
  const { b } = rig(); const o = await b.submitOrder({ symbol: "AAPL", side: "buy", type: "market", qty: "10", time_in_force: "day", client_order_id: "t-1" });
  assert.equal(o.status, "filled"); assert.equal(Number(o.filled_avg_price), 200.1);
  const a = await b.account(), p = await b.positions(), f = await b.fills();
  assert.equal(Number(a.cash), 100000 - 2001); assert.equal(Number(p[0].qty), 10); assert.equal(f.length, 1); assert.equal(f[0].order_id, o.id); b.stop();
});
test("market order outside hours waits for the open, then fills at the then-current ask", async () => {
  const { b, Q, set } = rig(ET("2026-11-21", "11:00"));                         // Saturday
  const o = await b.submitOrder({ symbol: "AAPL", side: "buy", type: "market", qty: "1", time_in_force: "day" });
  assert.equal(o.status, "new"); assert.equal((await b.clock()).is_open, false);
  Q.AAPL = { last: 205, bid: 204.9, ask: 205.2 }; set(ET("2026-11-23", "09:31")); await b.evaluate(true);
  const g = await b.getOrder(o.id); assert.equal(g.status, "filled"); assert.equal(Number(g.filled_avg_price), 205.2); b.stop();
});
test("limit buy fills only when the ask reaches the limit; sell limit mirrors with the bid", async () => {
  const { b, Q, tick } = rig();
  const o = await b.submitOrder({ symbol: "AAPL", side: "buy", type: "limit", limit_price: "198", qty: "5", time_in_force: "gtc" });
  assert.equal(o.status, "new"); Q.AAPL = { last: 197.9, bid: 197.8, ask: 197.95 }; await tick();
  assert.equal(Number((await b.getOrder(o.id)).filled_avg_price), 197.95);
  const s = await b.submitOrder({ symbol: "AAPL", side: "sell", type: "limit", limit_price: "199", qty: "5", time_in_force: "gtc" });
  assert.equal(s.status, "new"); Q.AAPL = { last: 199.3, bid: 199.2, ask: 199.4 }; await tick();
  assert.equal(Number((await b.getOrder(s.id)).filled_avg_price), 199.2); assert.equal((await b.positions()).length, 0); b.stop();
});
test("stop triggers on the last trade, then fills at the touch", async () => {
  const { b, Q, tick } = rig();
  await b.submitOrder({ symbol: "AAPL", side: "buy", type: "market", qty: "10", time_in_force: "day" });
  const st = await b.submitOrder({ symbol: "AAPL", side: "sell", type: "stop", stop_price: "195", qty: "10", time_in_force: "gtc" });
  assert.equal(st.status, "new"); Q.AAPL = { last: 196, bid: 195.9, ask: 196.1 }; await tick(); assert.equal((await b.getOrder(st.id)).status, "new");
  Q.AAPL = { last: 194.5, bid: 194.4, ask: 194.6 }; await tick(); const g = await b.getOrder(st.id);
  assert.equal(g.status, "filled"); assert.equal(Number(g.filled_avg_price), 194.4); b.stop();
});
test("bracket: legs open after the fill; take-profit fill cancels the stop (one-cancels-other)", async () => {
  const { b, Q, tick } = rig();
  const o = await b.submitOrder({ symbol: "AAPL", side: "buy", type: "market", qty: "4", time_in_force: "day", order_class: "bracket", take_profit: { limit_price: "210" }, stop_loss: { stop_price: "190" } });
  const g = await b.getOrder(o.id); assert.equal(g.legs.length, 2);
  Q.AAPL = { last: 210.5, bid: 210.4, ask: 210.6 }; await tick();
  const legs = (await b.getOrder(o.id)).legs, tp = legs.find(l => l.type === "limit"), sl = legs.find(l => l.type === "stop");
  assert.equal(tp.status, "filled"); assert.equal(Number(tp.filled_avg_price), 210.4); assert.equal(sl.status, "canceled"); assert.equal((await b.positions()).length, 0); b.stop();
});
test("buying power: 2 × equity − gross; too large an order is rejected with 403", async () => {
  const { b } = rig();
  await assert.rejects(b.submitOrder({ symbol: "MSFT", side: "buy", type: "market", qty: "600", time_in_force: "day" }), e => e.status === 403 && /buying power/.test(e.message));
  const ok = await b.submitOrder({ symbol: "MSFT", side: "buy", type: "market", qty: "400", time_in_force: "day" }); assert.equal(ok.status, "filled");
  assert.equal(Math.round(Number((await b.account()).buying_power)), Math.round(2 * (100000 - 400 * 0.2) - 400 * 400)); b.stop();
});
test("day order expires at the close; ioc cancels when not fillable; after-close day order belongs to the next session", async () => {
  const { b, set } = rig(ET("2026-11-23", "15:50"));
  const d = await b.submitOrder({ symbol: "AAPL", side: "buy", type: "limit", limit_price: "150", qty: "1", time_in_force: "day" });
  const i = await b.submitOrder({ symbol: "AAPL", side: "buy", type: "limit", limit_price: "150", qty: "1", time_in_force: "ioc" });
  assert.equal(i.status, "canceled");
  set(ET("2026-11-23", "16:01")); await b.evaluate(true); assert.equal((await b.getOrder(d.id)).status, "expired");
  const late = await b.submitOrder({ symbol: "AAPL", side: "buy", type: "limit", limit_price: "150", qty: "1", time_in_force: "day" });
  set(ET("2026-11-23", "18:00")); await b.evaluate(true); assert.equal((await b.getOrder(late.id)).status, "new");
  set(ET("2026-11-24", "16:00")); await b.evaluate(true); assert.equal((await b.getOrder(late.id)).status, "expired"); b.stop();
});
test("short, cover, replace, cancel, close-all, unknown symbol, duplicate client id, persistence", async () => {
  const { b, Q, tick, mem } = rig();
  const s = await b.submitOrder({ symbol: "MSFT", side: "sell", type: "market", qty: "10", time_in_force: "day", client_order_id: "dup-1" });
  assert.equal(Number((await b.positions())[0].qty), -10);
  await assert.rejects(b.submitOrder({ symbol: "MSFT", side: "sell", type: "market", qty: "1", client_order_id: "dup-1" }), e => e.status === 422);
  await assert.rejects(b.submitOrder({ symbol: "ZZZZ", side: "buy", type: "market", qty: "1" }), e => e.status === 422);
  Q.MSFT = { last: 390, bid: 389.9, ask: 390.1 }; await tick();
  const pos = (await b.positions())[0]; assert.equal(Number(pos.unrealized_pl), Math.round((399.8 - 390) * 10 * 100) / 100);
  const l = await b.submitOrder({ symbol: "MSFT", side: "buy", type: "limit", limit_price: "300", qty: "3", time_in_force: "gtc" });
  const r = await b.replaceOrder(l.id, { qty: "4", limit_price: "301", client_order_id: "rep-1" });
  assert.equal((await b.getOrder(l.id)).status, "replaced"); assert.equal((await b.getOrder(l.id)).replaced_by, r.id); assert.equal(r.qty, "4");
  await b.cancelOrder(r.id); assert.equal((await b.getOrder(r.id)).status, "canceled");
  await b.closeAllPositions(); assert.equal((await b.positions()).length, 0);
  assert.ok(Math.abs(Number((await b.account()).equity) - (100000 + (399.8 - 390.1) * 10)) < 1e-6);
  await new Promise(r => setTimeout(r, 50)); assert.ok(mem.data && mem.data.fills.length >= 2, "state persisted"); b.stop();
});
test("session day and market hours (holiday, weekend, early/late)", () => {
  assert.equal(Sim.nyParts(ET("2026-11-26", "11:00")).regular, false);        // Thanksgiving
  assert.equal(Sim.nyParts(ET("2026-11-27", "09:29")).regular, false); assert.equal(Sim.nyParts(ET("2026-11-27", "09:30")).regular, true);
  assert.equal(Sim.sessionDay(ET("2026-11-20", "17:00")), "2026-11-23");      // Friday after close → Monday
});
