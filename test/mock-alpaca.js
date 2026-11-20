// In-process mock of the Alpaca trading + data REST API, following Alpaca's documented order lifecycle:
// accepted → new → (partially_filled) → filled, plus rejected, canceled, replaced. Each GET of an order advances it one step,
// so tests can watch every intermediate state. Symbols: REJ* = refused at request time, LATE* = rejected after acceptance,
// SLOW* = never fills (for cancel/modify tests), qty ≥ 10 fills in two halves.
"use strict";
const http = require("http"), crypto = require("crypto");

function start(opts = {}) {
  const S = { equity: 100000, last_equity: 100000, is_open: true, prices: { AAPL: 200, MSFT: 400, TSLA: 300, SLOWX: 50, REJX: 10, LATEX: 20, NVDA: 150, ...(opts.prices || {}) },
              orders: new Map(), byClient: new Map(), positions: new Map(), fills: [], fail5xx: 0, calls: [] };
  const json = (res, code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  const now = () => new Date().toISOString();
  function fill(o, q) {
    const px = o.limit_price ? Number(o.limit_price) : S.prices[o.symbol];
    const prevQty = Number(o.filled_qty), newQty = prevQty + q;
    o.filled_avg_price = String(((Number(o.filled_avg_price || 0) * prevQty) + px * q) / newQty); o.filled_qty = String(newQty);
    const sign = o.side === "buy" ? 1 : -1, p = S.positions.get(o.symbol) || { qty: 0, cost: 0 };
    p.qty += sign * q; p.cost += sign * q * px; if (Math.abs(p.qty) < 1e-9) S.positions.delete(o.symbol); else S.positions.set(o.symbol, p);
    S.fills.push({ id: crypto.randomUUID(), activity_type: "FILL", order_id: o.id, symbol: o.symbol, side: o.side, qty: String(q), price: String(px), transaction_time: new Date(Date.now() + S.fills.length).toISOString() });
  }
  function advance(o) {
    if (["filled", "canceled", "rejected", "replaced", "expired"].includes(o.status)) return;
    if (o.status === "accepted") { o.status = "new"; return; }
    if (o.symbol.startsWith("LATE")) { o.status = "rejected"; o.reject_reason = "mock: rejected by exchange"; return; }
    if (o.symbol.startsWith("SLOW")) return;
    const total = Number(o.qty), done = Number(o.filled_qty);
    if (total >= 10 && done === 0) { fill(o, Math.floor(total / 2)); o.status = "partially_filled"; return; }
    fill(o, total - done); o.status = "filled"; o.filled_at = now();
  }
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", c => b += c); req.on("end", () => {
      const u = new URL(req.url, "http://x"), p = u.pathname, m = req.method, body = b ? JSON.parse(b) : null;
      S.calls.push(m + " " + p);
      if (req.headers["apca-api-key-id"] !== "K" || req.headers["apca-api-secret-key"] !== "S") return json(res, 401, { message: "unauthorized" });
      if (S.fail5xx > 0) { S.fail5xx--; return json(res, 503, { message: "mock outage" }); }
      if (m === "GET" && p === "/v2/account") return json(res, 200, { equity: String(S.equity), last_equity: String(S.last_equity), buying_power: String(S.equity * 2), cash: String(S.equity), status: "ACTIVE", trading_blocked: false, account_blocked: false });
      if (m === "GET" && p === "/v2/clock") return json(res, 200, { is_open: S.is_open, timestamp: now() });
      if (m === "GET" && p === "/v2/positions") return json(res, 200, [...S.positions].map(([s, x]) => ({ symbol: s, qty: String(x.qty), avg_entry_price: String(x.cost / x.qty), market_value: String(x.qty * S.prices[s]), unrealized_pl: String(x.qty * S.prices[s] - x.cost), side: x.qty > 0 ? "long" : "short" })));
      if (m === "DELETE" && p === "/v2/positions") { const out = [...S.positions.keys()]; S.positions.clear(); return json(res, 207, out.map(s => ({ symbol: s, status: 200 }))); }
      if (m === "GET" && /^\/v2\/stocks\/[^/]+\/trades\/latest$/.test(p)) { const s = p.split("/")[3]; return S.prices[s] ? json(res, 200, { symbol: s, trade: { p: S.prices[s], t: now() } }) : json(res, 404, { message: "no trade" }); }
      if (m === "POST" && p === "/v2/orders") {
        if (S.failSubmit > 0) { S.failSubmit--; return json(res, 503, { message: "mock outage" }); }
        if (S.byClient.has(body.client_order_id)) return json(res, 422, { message: "client_order_id must be unique" });
        if (body.symbol.startsWith("REJ")) return json(res, 403, { message: "insufficient buying power" });
        const o = { id: crypto.randomUUID(), client_order_id: body.client_order_id, symbol: body.symbol, side: body.side, qty: body.qty, type: body.type, time_in_force: body.time_in_force,
                    limit_price: body.limit_price || null, stop_price: body.stop_price || null, order_class: body.order_class || "simple", status: "accepted", filled_qty: "0", filled_avg_price: null, created_at: now() };
        S.orders.set(o.id, o); S.byClient.set(o.client_order_id, o.id); return json(res, 200, { ...o });
      }
      if (m === "GET" && p === "/v2/orders:by_client_order_id") { const id = S.byClient.get(u.searchParams.get("client_order_id")); if (!id) return json(res, 404, { message: "not found" }); const o = S.orders.get(id); advance(o); return json(res, 200, { ...o }); }
      if (m === "GET" && /^\/v2\/orders\/[^/]+$/.test(p)) { const o = S.orders.get(p.split("/")[3]); if (!o) return json(res, 404, { message: "not found" }); advance(o); return json(res, 200, { ...o }); }
      if (m === "PATCH" && /^\/v2\/orders\/[^/]+$/.test(p)) {
        const o = S.orders.get(p.split("/")[3]); if (!o || !["new", "accepted", "partially_filled"].includes(o.status)) return json(res, 422, { message: "order is not replaceable" });
        const n = { ...o, id: crypto.randomUUID(), client_order_id: body.client_order_id || crypto.randomUUID(), qty: body.qty || o.qty, limit_price: body.limit_price || o.limit_price, stop_price: body.stop_price || o.stop_price, status: "accepted", replaces: o.id };
        o.status = "replaced"; o.replaced_by = n.id; S.orders.set(n.id, n); S.byClient.set(n.client_order_id, n.id); return json(res, 200, { ...n });
      }
      if (m === "DELETE" && /^\/v2\/orders\/[^/]+$/.test(p)) { const o = S.orders.get(p.split("/")[3]); if (!o) return json(res, 404, { message: "not found" }); if (o.status === "filled") return json(res, 422, { message: "order already filled" }); o.status = "canceled"; res.writeHead(204); return res.end(); }
      if (m === "DELETE" && p === "/v2/orders") { const out = []; for (const o of S.orders.values()) if (["accepted", "new", "partially_filled"].includes(o.status)) { o.status = "canceled"; out.push({ id: o.id, status: 200 }); } return json(res, 207, out); }
      if (m === "GET" && p === "/v2/account/activities/FILL") { const after = u.searchParams.get("after"); return json(res, 200, S.fills.filter(f => !after || f.transaction_time > after)); }
      json(res, 404, { message: "mock: no route " + m + " " + p });
    });
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r({ S, url: "http://127.0.0.1:" + server.address().port, close: () => server.close() })));
}
module.exports = { start };
