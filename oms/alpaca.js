// Alpaca broker adapter (REST). Keys come only from server environment variables and never leave this process.
// Paper only. Live host orders are refused. ALPACA_ENV and OMS_LIVE_APPROVED no longer open the live API.
"use strict";

function config(env = process.env) {
  const trading = env.ALPACA_TRADING_URL || "https://paper-api.alpaca.markets";
  return {
    keyId: env.ALPACA_KEY_ID || "", secret: env.ALPACA_SECRET_KEY || "",
    mode: "paper",
    trading,
    data: env.ALPACA_DATA_URL || "https://data.alpaca.markets",
    liveRequestedButNotApproved: env.ALPACA_ENV === "live" || /\/\/api\.alpaca\.markets\b/.test(trading),
  };
}

class BrokerError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

function create(env = process.env, fetchImpl = fetch) {
  const c = config(env);
  const configured = () => !!(c.keyId && c.secret);
  async function call(base, method, path, body, { allow404 = false } = {}) {
    if (!configured()) throw new BrokerError(503, "Alpaca keys are not set on the server (ALPACA_KEY_ID / ALPACA_SECRET_KEY)");
    const r = await fetchImpl(base + path, {
      method, signal: AbortSignal.timeout(15000),
      headers: { "APCA-API-KEY-ID": c.keyId, "APCA-API-SECRET-KEY": c.secret, "Content-Type": "application/json", Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text.slice(0, 200) }; }
    if (allow404 && r.status === 404) return null;
    if (!r.ok) throw new BrokerError(r.status, (j && (j.message || j.raw)) || "Alpaca HTTP " + r.status, j);
    return j;
  }
  const T = (m, p, b, o) => call(c.trading, m, p, b, o);
  return {
    mode: c.mode, configured, liveRequestedButNotApproved: c.liveRequestedButNotApproved,
    account: () => T("GET", "/v2/account"),
    clock: () => T("GET", "/v2/clock"),
    positions: () => T("GET", "/v2/positions"),
    asset: sym => T("GET", "/v2/assets/" + encodeURIComponent(sym), null, { allow404: true }),
    submitOrder: o => { if (/\/\/api\.alpaca\.markets\b/.test(c.trading)) throw new BrokerError(403, "Live orders are disabled. This portal stays on the paper host."); return T("POST", "/v2/orders", o); },
    getOrderByClientId: cid => T("GET", "/v2/orders:by_client_order_id?client_order_id=" + encodeURIComponent(cid), null, { allow404: true }),
    getOrder: id => T("GET", "/v2/orders/" + encodeURIComponent(id) + "?nested=true", null, { allow404: true }),
    replaceOrder: (id, o) => T("PATCH", "/v2/orders/" + encodeURIComponent(id), o),
    cancelOrder: id => T("DELETE", "/v2/orders/" + encodeURIComponent(id), null, { allow404: true }),
    cancelAll: () => T("DELETE", "/v2/orders"),
    closeAllPositions: () => T("DELETE", "/v2/positions?cancel_orders=true"),
    fills: afterIso => T("GET", "/v2/account/activities/FILL?direction=asc&page_size=100" + (afterIso ? "&after=" + encodeURIComponent(afterIso) : "")),
    latestTrade: sym => call(c.data, "GET", "/v2/stocks/" + encodeURIComponent(sym) + "/trades/latest?feed=iex"),
  };
}
module.exports = { create, config, BrokerError };
