// Built-in paper broker: the same interface as oms/alpaca.js, so the OMS (risk checks, approvals, lifecycle, fills,
// reconciliation) works without an outside account. Orders fill against LIVE quotes (Nasdaq last / bid / ask by
// default); nothing is ever sent to a real broker.
//
// Fill rules (documented on the OMS page):
//   market   — fills during regular hours (9:30–16:00 ET, weekdays, NYSE holidays closed): buy at the ask, sell at the bid
//              (last trade if the side is missing). Outside hours it waits for the open.
//   limit    — buy fills when the ask (or last) is at or below the limit, at the better of the two; sell mirrors with the
//              bid. extended_hours limit orders may fill 4:00–20:00 ET.
//   stop     — triggers when the last trade reaches the stop (buy: last ≥ stop, sell: last ≤ stop), then fills as market.
//   stop_limit — triggers the same way, then works as a limit.
//   time in force — day: expires at 16:00 ET (20:00 with extended hours); ioc / fok: cancelled if not fillable at once;
//              gtc: stays open.
//   bracket / oto — after the parent fills, a take-profit limit and / or a stop-loss stop are opened; when one fills the
//              other is cancelled (one-cancels-other).
//   buying power — 2 × equity − gross position value (Reg T style); an order that would exceed it is rejected.
// No partial fills and no market impact are modelled; quotes are as delayed as the source (shown on the OMS page).
"use strict";
const crypto = require("crypto");

class BrokerError extends Error { constructor(status, message) { super(message); this.status = status; } }
const OPEN = ["new", "accepted", "partially_filled", "held"];
const HOLIDAYS = new Set(["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"]);

function nyParts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`, mins = +p.hour * 60 + +p.minute, trading = !["Sat", "Sun"].includes(p.weekday) && !HOLIDAYS.has(day);
  return { day, mins, trading, regular: trading && mins >= 570 && mins < 960, extended: trading && mins >= 240 && mins < 1200 };
}

// the session a day order belongs to: today if placed before the close on a trading day, else the next trading day
function sessionDay(ms, ext) {
  let t = ms, c = nyParts(t);
  if (c.trading && c.mins < (ext ? 1200 : 960)) return c.day;
  for (let i = 0; i < 10; i++) { t += 864e5; c = nyParts(t); if (c.trading) return c.day; }
  return c.day;
}
function create({ quote, store, now = () => Date.now(), startCash = 100000, log = () => {} } = {}) {
  if (typeof quote !== "function") throw new Error("simbroker needs a quote(symbol) function");
  let S = null; const ready = (async () => {
    const saved = store ? await store.load().catch(() => null) : null;
    S = saved && saved.v === 1 ? saved : { v: 1, cash: startCash, start: startCash, lastEquity: startCash, lastEquityDay: null, orders: [], positions: {}, fills: [], seq: 0 };
  })();
  let saving = null, dirty = false;
  const persist = () => { dirty = true; if (!store || saving) return; saving = (async () => { while (dirty) { dirty = false; await store.save(S).catch(e => log("sim save failed: " + e.message)); } saving = null; })(); };
  const iso = ms => new Date(ms).toISOString();
  const S2 = v => v == null ? null : String(v);
  const qcache = new Map();
  async function q(sym) {
    const hit = qcache.get(sym); if (hit && now() - hit.at < 5000) return hit.v;
    const v = await quote(sym); if (!v || !(v.last > 0)) throw new BrokerError(422, `no live quote for ${sym}`);
    qcache.set(sym, { at: now(), v }); return v;
  }
  const mark = (sym, qv) => qv ? qv.last : (S.positions[sym] && S.positions[sym].mark) || 0;

  // ---- account maths ----
  function valuation() {
    let longV = 0, shortV = 0;
    for (const [sym, p] of Object.entries(S.positions)) { const v = p.qty * (p.mark || p.avg); if (v >= 0) longV += v; else shortV += v; }
    const equity = S.cash + longV + shortV, gross = longV - shortV;
    return { equity, longV, shortV, gross, buyingPower: Math.max(0, 2 * equity - gross) };
  }
  function rollDay() { const d = nyParts(now()).day; if (S.lastEquityDay !== d) { if (S.lastEquityDay) S.lastEquity = valuation().equity; S.lastEquityDay = d; persist(); } }

  // ---- order objects (Alpaca shape) ----
  function newOrder(o, extra = {}) {
    return { id: crypto.randomUUID(), client_order_id: o.client_order_id || crypto.randomUUID(), symbol: String(o.symbol).toUpperCase(), side: o.side, type: o.type,
      qty: S2(o.qty), filled_qty: "0", filled_avg_price: null, limit_price: S2(o.limit_price), stop_price: S2(o.stop_price), time_in_force: o.time_in_force || "day",
      extended_hours: !!o.extended_hours, order_class: o.order_class || "simple", status: "new", created_at: iso(now()), submitted_at: iso(now()), updated_at: iso(now()),
      filled_at: null, canceled_at: null, expired_at: null, replaced_by: null, replaces: null, triggered: false, legs: null, parent: null,
      tp: o.take_profit ? S2(o.take_profit.limit_price) : null, sl: o.stop_loss ? S2(o.stop_loss.stop_price) : null, day: sessionDay(now(), !!o.extended_hours), ...extra };
  }
  const view = o => { const { tp, sl, day, parent, triggered, ...rest } = o; return { ...rest, legs: o.legs ? o.legs.map(id => view(S.orders.find(x => x.id === id))).filter(Boolean) : null }; };
  const find = id => S.orders.find(o => o.id === id);

  function applyFill(o, px) {
    const qty = Number(o.qty), sign = o.side === "buy" ? 1 : -1, p = S.positions[o.symbol] || { qty: 0, avg: 0, mark: px };
    const nq = p.qty + sign * qty;
    if (p.qty === 0 || Math.sign(p.qty) === sign) p.avg = (p.avg * Math.abs(p.qty) + px * qty) / Math.abs(nq);   // adding to a position
    else if (Math.sign(nq) === -Math.sign(p.qty)) p.avg = px;                                                     // flipped through zero
    p.qty = nq; p.mark = px;
    if (Math.abs(p.qty) < 1e-9) delete S.positions[o.symbol]; else S.positions[o.symbol] = p;
    S.cash -= sign * qty * px;
    o.filled_qty = String(qty); o.filled_avg_price = String(px); o.status = "filled"; o.filled_at = o.updated_at = iso(now());
    S.fills.push({ id: crypto.randomUUID(), activity_type: "FILL", type: "fill", order_id: o.id, symbol: o.symbol, side: o.side, qty: String(qty), cum_qty: String(qty), leaves_qty: "0",
      price: String(px), transaction_time: iso(now() + (S.seq++ % 1000) / 1000) });
    if (S.fills.length > 5000) S.fills.splice(0, S.fills.length - 5000);
    // bracket / oto: open the exit legs; OCO between them
    if (o.order_class !== "simple" && !o.parent && (o.tp || o.sl)) {
      const exit = o.side === "buy" ? "sell" : "buy", legs = [];
      if (o.tp) legs.push(newOrder({ symbol: o.symbol, side: exit, type: "limit", qty: o.qty, limit_price: o.tp, time_in_force: "gtc" }, { parent: o.id, order_class: o.order_class }));
      if (o.sl) legs.push(newOrder({ symbol: o.symbol, side: exit, type: "stop", qty: o.qty, stop_price: o.sl, time_in_force: "gtc" }, { parent: o.id, order_class: o.order_class }));
      S.orders.push(...legs); o.legs = legs.map(l => l.id);
    }
    if (o.parent) for (const sib of S.orders) if (sib.parent === o.parent && sib.id !== o.id && OPEN.includes(sib.status)) { sib.status = "canceled"; sib.canceled_at = sib.updated_at = iso(now()); }
  }
  // price an order against a quote; returns the fill price or null
  function fillPrice(o, qv, clock) {
    const buy = o.side === "buy", touch = buy ? (qv.ask || qv.last) : (qv.bid || qv.last);
    const canTrade = clock.regular || (o.extended_hours && o.type === "limit" && clock.extended);
    if (!canTrade) return null;
    let type = o.type;
    if ((type === "stop" || type === "stop_limit") && !o.triggered) {
      const sp = Number(o.stop_price); if (buy ? qv.last >= sp : qv.last <= sp) { o.triggered = true; } else return null;
    }
    if (type === "stop") type = "market"; if (type === "stop_limit") type = "limit";
    if (type === "market") return touch;
    const lp = Number(o.limit_price); return buy ? (touch <= lp ? Math.min(lp, touch) : null) : (touch >= lp ? Math.max(lp, touch) : null);
  }
  function expired(o, clock) {
    if (o.time_in_force !== "day") return false;
    return clock.day > o.day || (clock.day === o.day && clock.mins >= (o.extended_hours ? 1200 : 960));
  }
  let evaluating = null, lastEval = 0;
  async function evaluate(force) {
    await ready;
    if (evaluating) return evaluating;
    if (!force && now() - lastEval < 2000) return;
    evaluating = (async () => {
      lastEval = now(); rollDay(); const clock = nyParts(now()); let changed = false;
      for (const o of S.orders.filter(x => OPEN.includes(x.status))) {
        if (expired(o, clock)) { o.status = "expired"; o.expired_at = o.updated_at = iso(now()); changed = true; continue; }
        let qv; try { qv = await q(o.symbol); } catch { continue; }
        const px = fillPrice(o, qv, clock);
        if (px != null) { applyFill(o, px); changed = true; }
        else if (["ioc", "fok"].includes(o.time_in_force)) { o.status = "canceled"; o.canceled_at = o.updated_at = iso(now()); changed = true; }
      }
      // marks for open positions
      for (const sym of Object.keys(S.positions)) { try { const qv = await q(sym); S.positions[sym].mark = qv.last; } catch {} }
      if (changed) persist();
    })().finally(() => { evaluating = null; });
    return evaluating;
  }

  async function submitOrder(o) {
    await ready;
    if (!o || !o.symbol || !["buy", "sell"].includes(o.side) || !(Number(o.qty) > 0)) throw new BrokerError(422, "invalid order");
    if (!["market", "limit", "stop", "stop_limit"].includes(o.type)) throw new BrokerError(422, "unsupported order type " + o.type);
    if (o.client_order_id && S.orders.some(x => x.client_order_id === o.client_order_id)) throw new BrokerError(422, "client_order_id must be unique");
    const qv = await q(String(o.symbol).toUpperCase());
    const ord = newOrder(o), px = ord.limit_price ? Number(ord.limit_price) : (o.side === "buy" ? (qv.ask || qv.last) : (qv.bid || qv.last));
    const v = valuation(), pos = S.positions[ord.symbol], cur = pos ? pos.qty : 0, sign = o.side === "buy" ? 1 : -1;
    const addGross = Math.max(0, Math.abs(cur + sign * Number(o.qty)) - Math.abs(cur)) * px;
    if (addGross > v.buyingPower + 1e-6) throw new BrokerError(403, `insufficient buying power (need ${addGross.toFixed(2)}, have ${v.buyingPower.toFixed(2)})`);
    S.orders.push(ord); persist();
    await evaluate(true);
    return view(ord);
  }
  async function getOrder(id) { await evaluate(); const o = find(id); return o ? view(o) : null; }
  async function getOrderByClientId(cid) { await evaluate(); const o = S.orders.find(x => x.client_order_id === cid); return o ? view(o) : null; }
  async function cancelOrder(id) { await ready; const o = find(id); if (!o) return null; if (!OPEN.includes(o.status)) throw new BrokerError(422, "order is " + o.status);
    o.status = "canceled"; o.canceled_at = o.updated_at = iso(now()); for (const l of o.legs || []) { const x = find(l); if (x && OPEN.includes(x.status)) { x.status = "canceled"; x.canceled_at = iso(now()); } } persist(); return null; }
  async function replaceOrder(id, b) {
    await ready; const o = find(id); if (!o || !OPEN.includes(o.status)) throw new BrokerError(422, "order is not open");
    const n = newOrder({ symbol: o.symbol, side: o.side, type: o.type, qty: b.qty ?? o.qty, limit_price: b.limit_price ?? o.limit_price, stop_price: b.stop_price ?? o.stop_price,
      time_in_force: b.time_in_force || o.time_in_force, extended_hours: o.extended_hours, client_order_id: b.client_order_id, order_class: o.order_class }, { replaces: o.id, tp: o.tp, sl: o.sl });
    o.status = "replaced"; o.replaced_by = n.id; o.updated_at = iso(now()); S.orders.push(n); persist(); await evaluate(true); return view(n);
  }
  async function cancelAll() { await ready; const out = []; for (const o of S.orders) if (OPEN.includes(o.status)) { o.status = "canceled"; o.canceled_at = iso(now()); out.push({ id: o.id, status: 200 }); } persist(); return out; }
  async function closeAllPositions() {
    await cancelAll(); const out = [];
    for (const [sym, p] of Object.entries(S.positions)) { const o = newOrder({ symbol: sym, side: p.qty > 0 ? "sell" : "buy", type: "market", qty: Math.abs(p.qty), time_in_force: "day" }); S.orders.push(o); out.push({ symbol: sym, status: 200, body: view(o) }); }
    persist(); await evaluate(true); return out;
  }
  async function account() {
    await evaluate(); const v = valuation();
    return { id: "built-in-paper", account_number: "PAPER-SIM", status: "ACTIVE", currency: "USD", cash: S2(S.cash.toFixed(2)), equity: S2(v.equity.toFixed(2)), last_equity: S2(S.lastEquity.toFixed(2)),
      long_market_value: S2(v.longV.toFixed(2)), short_market_value: S2(v.shortV.toFixed(2)), buying_power: S2(v.buyingPower.toFixed(2)), portfolio_value: S2(v.equity.toFixed(2)),
      pattern_day_trader: false, trading_blocked: false, starting_cash: S2(S.start) };
  }
  async function positions() {
    await evaluate();
    return Object.entries(S.positions).map(([sym, p]) => { const m = p.mark || p.avg, mv = p.qty * m, cost = p.qty * p.avg;
      return { symbol: sym, qty: S2(p.qty), side: p.qty > 0 ? "long" : "short", avg_entry_price: S2(p.avg), current_price: S2(m), market_value: S2(mv.toFixed(2)), cost_basis: S2(cost.toFixed(2)),
        unrealized_pl: S2((mv - cost).toFixed(2)), unrealized_plpc: S2(cost ? ((mv - cost) / Math.abs(cost)).toFixed(6) : 0) }; });
  }
  async function clock() { const c = nyParts(now()); return { timestamp: iso(now()), is_open: c.regular, session: c.regular ? "regular" : c.extended ? "extended" : "closed", day: c.day }; }
  async function fills(after) { await evaluate(); return S.fills.filter(f => !after || f.transaction_time > after).slice(0, 100); }
  async function latestTrade(sym) { const v = await q(String(sym).toUpperCase()); return { symbol: sym, trade: { p: v.last, t: v.at || iso(now()) }, quote: { bp: v.bid, ap: v.ask }, source: v.source }; }
  async function asset(sym) { try { await q(String(sym).toUpperCase()); return { symbol: sym, tradable: true, shortable: true, easy_to_borrow: true, fractionable: false }; } catch { return null; } }
  async function reset(cash = startCash) { await ready; S = { v: 1, cash, start: cash, lastEquity: cash, lastEquityDay: nyParts(now()).day, orders: [], positions: {}, fills: [], seq: 0 }; persist(); return account(); }

  const timer = setInterval(() => { if (S && S.orders.some(o => OPEN.includes(o.status))) evaluate().catch(() => {}); }, 5000); timer.unref?.();
  return { name: "Built-in paper broker", mode: "paper", configured: () => true, liveRequestedButNotApproved: false,
    account, clock, positions, asset, submitOrder, getOrderByClientId, getOrder, replaceOrder, cancelOrder, cancelAll, closeAllPositions, fills, latestTrade, reset, evaluate,
    _state: () => S, stop: () => clearInterval(timer) };
}
// Postgres-backed state (one jsonb row), used when the OMS has a database
function pgStore(pool) {
  const ready = pool.query("CREATE TABLE IF NOT EXISTS oms_sim (id int PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())");
  return { load: async () => { await ready; const r = await pool.query("SELECT data FROM oms_sim WHERE id=1"); return r.rows[0] ? r.rows[0].data : null; },
           save: async s => { await ready; await pool.query("INSERT INTO oms_sim(id,data,updated_at) VALUES(1,$1,now()) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()", [JSON.stringify(s)]); } };
}
module.exports = { create, pgStore, nyParts, sessionDay, BrokerError };
