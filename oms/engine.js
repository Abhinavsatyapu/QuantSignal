// OMS engine: order lifecycle, broker sync, reconciliation, recovery, kill switch, P&L.
// Lifecycle (stored per order, every change logged in oms_events):
//   proposed ─approve→ approved ─broker accepted request→ submitted ─broker ack→ acknowledged → partially_filled → filled
//   proposed ─decline→ declined · risk failure → blocked · broker refusal → rejected · cancel → canceled · expiry → expired
//   modify → replaced (a child order continues). An order is NEVER marked filled because a request was sent: only the
//   broker's order status / fill activities move it to partially_filled or filled.
"use strict";
const crypto = require("crypto");
const risk = require("./risk");
const { TERMINAL, OPEN_AT_BROKER } = require("./db");

const MAP = { new: "acknowledged", accepted: "acknowledged", pending_new: "acknowledged", accepted_for_bidding: "acknowledged", calculated: "acknowledged", held: "acknowledged",
              partially_filled: "partially_filled", filled: "filled", canceled: "canceled", done_for_day: "canceled", expired: "expired", rejected: "rejected", replaced: "replaced" };
const num = v => (v === null || v === undefined || v === "" ? null : Number(v));
const clean = s => String(s || "").trim();

function create({ db, broker, log = () => {}, now = () => Date.now() }) {
  let timer = null, syncing = null, lastSync = null, lastError = null;

  const limits = async () => ({ ...risk.DEFAULT_LIMITS, ...(await db.getConfig("limits", {})) });
  const openOrders = async () => (await db.q(`SELECT * FROM oms_orders WHERE status = ANY($1) ORDER BY created_at`, [[...OPEN_AT_BROKER, "approved"]])).rows;
  async function context(order) {
    const [account, positions, clock] = await Promise.all([broker.account(), broker.positions(), broker.clock()]);
    let refPrice = null;
    try { const t = await broker.latestTrade(order.symbol); refPrice = num(t && t.trade && t.trade.p); } catch { /* fall back to order prices */ }
    return { account, positions, clock, refPrice, openOrders: await openOrders(), limits: await limits(), peakEquity: await db.getConfig("peak_equity", null) };
  }
  function validateInput(i) {
    const e = [], o = {
      symbol: clean(i.symbol).toUpperCase(), side: clean(i.side).toLowerCase(), qty: num(i.qty), type: clean(i.type || "market").toLowerCase(),
      limit_price: num(i.limit_price), stop_price: num(i.stop_price), tif: clean(i.tif || "day").toLowerCase(), extended_hours: !!i.extended_hours,
      stop_loss: num(i.stop_loss), take_profit: num(i.take_profit), intent: i.intent === "close" ? "close" : "open", source: ["signal", "automation"].includes(i.source) ? i.source : "manual",
      reason: clean(i.reason), idem_key: clean(i.idem_key) };
    if (!["buy", "sell"].includes(o.side)) e.push("side must be buy or sell");
    if (!["market", "limit", "stop", "stop_limit"].includes(o.type)) e.push("type must be market, limit, stop or stop_limit");
    if (!["day", "gtc", "ioc", "fok", "opg", "cls"].includes(o.tif)) e.push("time in force not supported");
    if (!(o.qty > 0)) e.push("qty must be > 0");
    if (o.reason.length < 3) e.push("a reason is required on every order");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(o.idem_key)) e.push("idem_key (8–64 letters, digits, - or _) is required");
    if ((o.stop_loss || o.take_profit) && o.extended_hours) e.push("protective stop / take-profit legs are not available with extended-hours orders");
    if ((o.stop_loss || o.take_profit) && !["market", "limit"].includes(o.type)) e.push("protective legs need a market or limit entry");
    return { o, e };
  }

  async function propose(input) {
    const { o, e } = validateInput(input);
    if (e.length) { const err = new Error(e.join("; ")); err.status = 400; throw err; }
    const existing = await db.byIdem(o.idem_key);
    if (existing) return { order: existing, duplicate: true };                       // idempotent: same key → same order
    const ctx = await context(o);
    const r = risk.check({ order: o, ...ctx });
    const status = r.ok ? "proposed" : "blocked";
    const ins = await db.q(`INSERT INTO oms_orders (idem_key, env, symbol, side, qty, type, limit_price, stop_price, tif, extended_hours, stop_loss, take_profit, intent, source, reason, status, risk, est_fees)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (idem_key) DO NOTHING RETURNING *`,
      [o.idem_key, broker.mode, o.symbol, o.side, o.qty, o.type, o.limit_price, o.stop_price, o.tif, o.extended_hours, o.stop_loss, o.take_profit, r.metrics.intent, o.source, o.reason, status, JSON.stringify(r), r.metrics.estFees]);
    if (!ins.rows.length) return { order: await db.byIdem(o.idem_key), duplicate: true };   // lost a race with an identical request
    const order = ins.rows[0];
    await db.q("INSERT INTO oms_events(order_id,from_status,to_status,detail) VALUES($1,NULL,$2,$3)", [order.id, status, JSON.stringify({ blocks: r.blocks, warnings: r.warnings })]);
    await db.audit("propose", o.reason, { id: order.id, symbol: o.symbol, side: o.side, qty: o.qty, status, blocks: r.blocks }, r.ok);
    return { order, risk: r };
  }

  function brokerPayload(o) {
    const p = { symbol: o.symbol, qty: String(o.qty), side: o.side, type: o.type, time_in_force: o.tif, client_order_id: o.idem_key };
    if (o.limit_price != null) p.limit_price = String(o.limit_price);
    if (o.stop_price != null) p.stop_price = String(o.stop_price);
    if (o.extended_hours) p.extended_hours = true;
    if (o.intent === "open" && (o.stop_loss != null || o.take_profit != null)) {
      p.order_class = o.stop_loss != null && o.take_profit != null ? "bracket" : "oto";
      if (o.stop_loss != null) p.stop_loss = { stop_price: String(o.stop_loss) };
      if (o.take_profit != null) p.take_profit = { limit_price: String(o.take_profit) };
    }
    return p;
  }

  async function approve(id, reason) {
    if (clean(reason).length < 3) throw Object.assign(new Error("a reason is required to approve"), { status: 400 });
    // claim: only one approver can move proposed → approved
    const claim = await db.q("UPDATE oms_orders SET status='approved', approved_at=now(), updated_at=now() WHERE id=$1 AND status='proposed' RETURNING *", [id]);
    if (!claim.rows.length) { const cur = await db.order(id); throw Object.assign(new Error(cur ? `order is ${cur.status}, not proposed` : "order not found"), { status: 409 }); }
    let o = claim.rows[0];
    await db.q("INSERT INTO oms_events(order_id,from_status,to_status,detail) VALUES($1,'proposed','approved',$2)", [id, JSON.stringify({ reason })]);
    // risk again, with fresh account data, immediately before the broker
    const ctx = await context(o); ctx.openOrders = ctx.openOrders.filter(x => x.id !== id);
    const r = risk.check({ order: o, ...ctx });
    if (!r.ok) { await db.transition(id, "blocked", { risk: JSON.stringify(r) }, { stage: "pre-submit risk", blocks: r.blocks }); await db.audit("approve", reason, { id, blocked: r.blocks }, false); return { order: await db.order(id), risk: r }; }
    await db.audit("approve", reason, { id, symbol: o.symbol, side: o.side, qty: Number(o.qty), env: broker.mode });
    return submit(o, r);
  }

  async function submit(o, r) {
    try {
      const b = await broker.submitOrder(brokerPayload(o));
      await db.transition(o.id, "submitted", { broker_order_id: b.id, broker_status: b.status, submitted_at: new Date(now()) }, { broker_status: b.status });
      await applyBroker(await db.order(o.id), b);
    } catch (e) {
      if (e.status === 422 && /client_order_id/i.test(e.message)) {                    // already at the broker: link, don't resend
        const b = await broker.getOrderByClientId(o.idem_key);
        if (b) { await db.transition(o.id, "submitted", { broker_order_id: b.id, broker_status: b.status, submitted_at: new Date(now()) }, { note: "linked existing broker order" }); await applyBroker(await db.order(o.id), b); }
      } else if (e.status && e.status < 500) {                                          // broker refused the request
        await db.transition(o.id, "rejected", { error: e.message, closed_at: new Date(now()) }, { broker_error: e.message, http: e.status });
      } else {                                                                           // outcome unknown: keep it open and reconcile
        await db.transition(o.id, "submitted", { error: "submission outcome unknown: " + e.message, submitted_at: new Date(now()) }, { unknown: e.message });
      }
    }
    return { order: await db.order(o.id), risk: r };
  }

  // apply a broker order object to our row
  async function applyBroker(row, b) {
    if (!row || !b) return;
    const to = MAP[b.status] || row.status;
    const patch = { broker_status: b.status, filled_qty: num(b.filled_qty) || 0, filled_avg_price: num(b.filled_avg_price) };
    if (!row.broker_order_id) patch.broker_order_id = b.id;
    if (to === "acknowledged" && !row.acknowledged_at) patch.acknowledged_at = new Date(now());
    if (to === "filled") patch.filled_at = b.filled_at ? new Date(b.filled_at) : new Date(now());
    if (["filled", "canceled", "expired", "rejected", "replaced"].includes(to)) patch.closed_at = new Date(now());
    if (to === "rejected" && b.reject_reason) patch.error = b.reject_reason;
    const changed = to !== row.status || Number(row.filled_qty) !== patch.filled_qty;
    if (changed) await db.transition(row.id, to, patch, { broker_status: b.status, filled_qty: patch.filled_qty, filled_avg_price: patch.filled_avg_price });
    else await db.q("UPDATE oms_orders SET broker_status=$2, updated_at=now() WHERE id=$1", [row.id, b.status]);
    if (to === "replaced" && b.replaced_by) await adoptReplacement(row, b.replaced_by);
  }
  async function adoptReplacement(parent, newBrokerId) {
    if (await db.byBroker(newBrokerId)) return;
    const b = await broker.getOrder(newBrokerId); if (!b) return;
    const k = (await db.q("SELECT count(*)::int AS c FROM oms_orders WHERE parent_id=$1", [parent.id])).rows[0].c + 1;
    const ins = await db.q(`INSERT INTO oms_orders (idem_key, env, symbol, side, qty, type, limit_price, stop_price, tif, extended_hours, stop_loss, take_profit, intent, source, reason, status, broker_order_id, broker_status, parent_id, submitted_at, approved_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'submitted',$16,$17,$18,now(),now()) ON CONFLICT (idem_key) DO NOTHING RETURNING *`,
      [b.client_order_id || `${parent.idem_key}-r${k}`, parent.env, parent.symbol, parent.side, num(b.qty), b.type, num(b.limit_price), num(b.stop_price), b.time_in_force, parent.extended_hours,
       parent.stop_loss, parent.take_profit, parent.intent, parent.source, parent.reason + " (modified)", b.id, b.status, parent.id]);
    if (ins.rows[0]) { await db.q("INSERT INTO oms_events(order_id,from_status,to_status,detail) VALUES($1,NULL,'submitted',$2)", [ins.rows[0].id, JSON.stringify({ replaces: parent.id })]); await applyBroker(ins.rows[0], b); }
  }

  async function decline(id, reason) {
    if (clean(reason).length < 3) throw Object.assign(new Error("a reason is required"), { status: 400 });
    const r = await db.q("UPDATE oms_orders SET status='declined', closed_at=now(), updated_at=now() WHERE id=$1 AND status='proposed' RETURNING *", [id]);
    if (!r.rows.length) throw Object.assign(new Error("only proposed orders can be declined"), { status: 409 });
    await db.q("INSERT INTO oms_events(order_id,from_status,to_status,detail) VALUES($1,'proposed','declined',$2)", [id, JSON.stringify({ reason })]);
    await db.audit("decline", reason, { id }); return { order: r.rows[0] };
  }

  async function cancel(id, reason) {
    if (clean(reason).length < 3) throw Object.assign(new Error("a reason is required"), { status: 400 });
    const o = await db.order(id);
    if (!o) throw Object.assign(new Error("order not found"), { status: 404 });
    if (!OPEN_AT_BROKER.includes(o.status) || !o.broker_order_id) throw Object.assign(new Error(`order is ${o.status}; only orders open at the broker can be cancelled`), { status: 409 });
    await broker.cancelOrder(o.broker_order_id);                                         // request only — status changes when the broker confirms
    await db.q("INSERT INTO oms_events(order_id,from_status,to_status,detail) VALUES($1,$2,$2,$3)", [id, o.status, JSON.stringify({ cancel_requested: true, reason })]);
    await db.audit("cancel", reason, { id, broker_order_id: o.broker_order_id });
    await syncOrder(await db.order(id)).catch(() => {});
    return { order: await db.order(id) };
  }

  async function modify(id, changes, reason) {
    if (clean(reason).length < 3) throw Object.assign(new Error("a reason is required"), { status: 400 });
    const o = await db.order(id);
    if (!o || !["acknowledged", "partially_filled"].includes(o.status) || !o.broker_order_id) throw Object.assign(new Error("only working orders at the broker can be modified"), { status: 409 });
    const next = { ...o, qty: num(changes.qty) ?? num(o.qty), limit_price: num(changes.limit_price) ?? num(o.limit_price), stop_price: num(changes.stop_price) ?? num(o.stop_price), tif: changes.tif || o.tif };
    if (next.qty < Number(o.filled_qty)) throw Object.assign(new Error("new quantity is below what has already filled"), { status: 400 });
    const ctx = await context(next); ctx.openOrders = ctx.openOrders.filter(x => x.id !== id);
    const r = risk.check({ order: { ...next, intent: o.intent }, ...ctx });
    if (!r.ok) { await db.audit("modify", reason, { id, blocked: r.blocks }, false); return { order: o, risk: r }; }
    const k = (await db.q("SELECT count(*)::int AS c FROM oms_orders WHERE parent_id=$1", [id])).rows[0].c + 1;
    const body = { qty: String(next.qty), time_in_force: next.tif, client_order_id: `${o.idem_key}-r${k}` };
    if (next.limit_price != null && ["limit", "stop_limit"].includes(o.type)) body.limit_price = String(next.limit_price);
    if (next.stop_price != null && ["stop", "stop_limit"].includes(o.type)) body.stop_price = String(next.stop_price);
    const nb = await broker.replaceOrder(o.broker_order_id, body);
    await db.audit("modify", reason, { id, changes, new_broker_order_id: nb.id });
    await db.transition(id, "replaced", { closed_at: new Date(now()), broker_status: "replaced" }, { replaced_by: nb.id, reason });
    await adoptReplacement(await db.order(id), nb.id);
    return { order: await db.byBroker(nb.id), risk: r };
  }

  async function syncOrder(row) {
    let b = row.broker_order_id ? await broker.getOrder(row.broker_order_id) : await broker.getOrderByClientId(row.idem_key);
    if (!b && !row.broker_order_id && row.status === "submitted" && now() - new Date(row.submitted_at).getTime() > 120000) {
      await db.transition(row.id, "rejected", { error: "broker has no record of this order", closed_at: new Date(now()) }, { reconcile: "not found at broker after 2 min" }); return;
    }
    if (b) await applyBroker(row, b);
  }

  async function syncFills() {
    const cursor = await db.getConfig("fill_cursor", null);
    const acts = (await broker.fills(cursor)) || [];
    const L = await limits(); let last = cursor;
    for (const a of acts) {
      const qty = num(a.qty), price = num(a.price), at = a.transaction_time;
      const row = await db.byBroker(a.order_id);                                    // null = trade placed outside the OMS
      const fees = risk.estimateFees(a.side === "sell" || a.side === "sell_short" ? "sell" : "buy", qty, price, L);
      const ins = await db.q("INSERT INTO oms_fills(id,order_id,broker_order_id,symbol,side,qty,price,at,est_fees) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING RETURNING id",
        [a.id, row ? row.id : null, a.order_id, a.symbol, a.side, qty, price, at, fees]);
      if (ins.rows.length && row) await db.q("UPDATE oms_orders SET est_fees = (SELECT coalesce(sum(est_fees),0) FROM oms_fills WHERE order_id=$1) WHERE id=$1", [row.id]);
      if (!last || at > last) last = at;
    }
    if (last !== cursor && last) await db.setConfig("fill_cursor", last);
  }

  async function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        if (!broker.configured()) { lastError = "broker keys not set"; return; }
        for (const row of await openOrders()) {
          if (row.status === "approved") continue;                                       // handled by recovery
          await syncOrder(row).catch(e => log("oms sync order " + row.id + ": " + e.message));
        }
        await syncFills();
        const acct = await broker.account(), eq = num(acct.equity), peak = await db.getConfig("peak_equity", null);
        if (eq && (!peak || eq > peak)) await db.setConfig("peak_equity", eq);
        lastSync = new Date(now()).toISOString(); lastError = null;
      } catch (e) { lastError = e.message; log("oms sync: " + e.message); }
      finally { syncing = null; }
    })();
    return syncing;
  }

  // positions: broker is the source of truth; compare with net quantities implied by OMS fills
  async function reconcile() {
    const pos = await broker.positions();
    const ours = (await db.q(`SELECT symbol, sum(CASE WHEN side IN ('buy') THEN qty ELSE -qty END) AS net FROM oms_fills GROUP BY symbol`)).rows;
    const m = new Map(ours.map(r => [r.symbol, Number(r.net)])), diffs = [];
    for (const p of pos) { const b = Number(p.qty), o = m.get(p.symbol) || 0; if (Math.abs(b - o) > 1e-9) diffs.push({ symbol: p.symbol, broker: b, oms: o, note: "position differs: trades outside the OMS or fills before it started" }); m.delete(p.symbol); }
    for (const [s, o] of m) if (Math.abs(o) > 1e-9) diffs.push({ symbol: s, broker: 0, oms: o, note: "OMS fills imply a position the broker does not have" });
    await db.q("INSERT INTO oms_recon(ok,diffs) VALUES($1,$2)", [diffs.length === 0, JSON.stringify(diffs)]);
    return { ok: diffs.length === 0, diffs, at: new Date(now()).toISOString() };
  }

  // after a restart: approved-but-unconfirmed orders are looked up by client_order_id, never blindly resent
  async function recover() {
    const rows = (await db.q("SELECT * FROM oms_orders WHERE status='approved'")).rows;
    for (const r of rows) {
      const b = broker.configured() ? await broker.getOrderByClientId(r.idem_key).catch(() => null) : null;
      if (b) { await db.transition(r.id, "submitted", { broker_order_id: b.id, broker_status: b.status, submitted_at: new Date(now()) }, { recovery: "found at broker" }); await applyBroker(await db.order(r.id), b); }
      else await db.transition(r.id, "proposed", {}, { recovery: "submission not confirmed before restart; approve again" });
    }
    return rows.length;
  }

  async function setKill(on, reason, { cancelAll = false, flatten = false } = {}) {
    if (clean(reason).length < 3) throw Object.assign(new Error("a reason is required"), { status: 400 });
    const L = await db.getConfig("limits", {}); L.killSwitch = !!on; await db.setConfig("limits", L);
    const detail = { on: !!on, cancelAll, flatten };
    if (on && cancelAll) detail.cancel = await broker.cancelAll().catch(e => ({ error: e.message }));
    if (on && flatten) detail.flatten = await broker.closeAllPositions().catch(e => ({ error: e.message }));
    await db.audit("kill_switch", reason, detail); await sync();
    return detail;
  }
  async function setLimits(patch, reason) {
    if (clean(reason).length < 3) throw Object.assign(new Error("a reason is required"), { status: 400 });
    const allowed = Object.keys(risk.DEFAULT_LIMITS).filter(k => k !== "killSwitch"), cur = await db.getConfig("limits", {}), next = { ...cur };
    for (const k of allowed) if (patch[k] !== undefined) { const v = typeof risk.DEFAULT_LIMITS[k] === "boolean" ? !!patch[k] : Number(patch[k]); if (typeof v === "number" && !(v >= 0)) continue; next[k] = v; }
    await db.setConfig("limits", next); await db.audit("limits", reason, { before: cur, after: next });
    return { ...risk.DEFAULT_LIMITS, ...next };
  }

  // realized P&L (FIFO over OMS fills) per symbol
  async function pnl() {
    const fills = (await db.q("SELECT symbol, side, qty, price, est_fees, at FROM oms_fills ORDER BY at, id")).rows;
    const lots = {}, realized = {};
    for (const f of fills) {
      const s = f.symbol, sign = f.side === "buy" ? 1 : -1; let q = Number(f.qty) * sign; const px = Number(f.price);
      lots[s] = lots[s] || []; realized[s] = (realized[s] || 0) - Number(f.est_fees || 0);
      while (q !== 0 && lots[s].length && Math.sign(lots[s][0].q) !== Math.sign(q)) {
        const lot = lots[s][0], m = Math.min(Math.abs(q), Math.abs(lot.q));
        realized[s] += m * (px - lot.px) * Math.sign(lot.q);
        lot.q -= m * Math.sign(lot.q); q -= m * Math.sign(q); if (Math.abs(lot.q) < 1e-12) lots[s].shift();
      }
      if (Math.abs(q) > 1e-12) lots[s].push({ q, px });
    }
    return Object.entries(realized).map(([symbol, r]) => ({ symbol, realized: Math.round(r * 100) / 100 }));
  }

  async function status() {
    const out = { mode: broker.mode, configured: broker.configured(), liveRequestedButNotApproved: broker.liveRequestedButNotApproved, lastSync, lastError, limits: await limits() };
    if (broker.configured()) {
      try { [out.account, out.clock, out.positions] = await Promise.all([broker.account(), broker.clock(), broker.positions()]); }
      catch (e) { out.brokerError = e.message; }
    }
    out.peakEquity = await db.getConfig("peak_equity", null);
    out.recon = (await db.q("SELECT at, ok, diffs FROM oms_recon ORDER BY id DESC LIMIT 1")).rows[0] || null;
    return out;
  }

  async function start() {
    await db.init(); await recover();
    const loop = async () => { await sync(); const busy = (await openOrders()).length > 0; timer = setTimeout(loop, busy ? 5000 : 30000); };
    timer = setTimeout(loop, 1000); if (timer.unref) timer.unref();
    setInterval(() => broker.configured() && reconcile().catch(e => log("oms reconcile: " + e.message)), 10 * 60e3).unref?.();
  }
  const stop = () => clearTimeout(timer);
  const newKey = () => crypto.randomUUID().replace(/-/g, "");
  return { start, stop, propose, approve, decline, cancel, modify, sync, syncFills, reconcile, recover, setKill, setLimits, pnl, status, newKey, brokerPayload };
}
module.exports = { create, MAP };
