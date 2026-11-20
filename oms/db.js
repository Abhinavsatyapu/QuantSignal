// OMS persistence (Postgres / Neon). Every order, state change, fill, config change and operator action is stored.
"use strict";
const SCHEMA = `
CREATE TABLE IF NOT EXISTS oms_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idem_key        text NOT NULL UNIQUE,                 -- idempotency key; also sent to the broker as client_order_id
  env             text NOT NULL,                        -- paper | live
  symbol          text NOT NULL,
  side            text NOT NULL CHECK (side IN ('buy','sell')),
  qty             numeric NOT NULL CHECK (qty > 0),
  type            text NOT NULL CHECK (type IN ('market','limit','stop','stop_limit')),
  limit_price     numeric, stop_price numeric,
  tif             text NOT NULL DEFAULT 'day',
  extended_hours  boolean NOT NULL DEFAULT false,
  stop_loss       numeric, take_profit numeric,         -- protective legs (sent as OTO / bracket on opening orders)
  intent          text NOT NULL DEFAULT 'open',         -- open | close (reduces an existing position)
  source          text NOT NULL DEFAULT 'manual',       -- manual | signal | automation
  reason          text NOT NULL,
  status          text NOT NULL,                        -- proposed, blocked, approved, submitted, acknowledged, partially_filled, filled, canceled, expired, rejected, replaced, declined
  risk            jsonb,
  broker_order_id text UNIQUE,
  broker_status   text,
  filled_qty      numeric NOT NULL DEFAULT 0,
  filled_avg_price numeric,
  est_fees        numeric NOT NULL DEFAULT 0,
  error           text,
  parent_id       uuid REFERENCES oms_orders(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  approved_at     timestamptz, submitted_at timestamptz, acknowledged_at timestamptz, filled_at timestamptz, closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS oms_orders_status ON oms_orders(status);
CREATE TABLE IF NOT EXISTS oms_events (
  id bigserial PRIMARY KEY, order_id uuid NOT NULL REFERENCES oms_orders(id), at timestamptz NOT NULL DEFAULT now(),
  from_status text, to_status text NOT NULL, detail jsonb
);
CREATE INDEX IF NOT EXISTS oms_events_order ON oms_events(order_id, at);
CREATE TABLE IF NOT EXISTS oms_fills (
  id text PRIMARY KEY,                                  -- broker activity id (dedupes re-reads)
  order_id uuid REFERENCES oms_orders(id), broker_order_id text, symbol text NOT NULL, side text NOT NULL,
  qty numeric NOT NULL, price numeric NOT NULL, at timestamptz NOT NULL, est_fees numeric NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS oms_fills_symbol ON oms_fills(symbol, at);
CREATE TABLE IF NOT EXISTS oms_config (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS oms_audit (
  id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), action text NOT NULL, reason text, ok boolean NOT NULL DEFAULT true, detail jsonb
);
CREATE TABLE IF NOT EXISTS oms_recon (id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), ok boolean NOT NULL, diffs jsonb);
`;
const TERMINAL = ["filled", "canceled", "expired", "rejected", "replaced", "declined", "blocked"];
const OPEN_AT_BROKER = ["submitted", "acknowledged", "partially_filled"];

function create(pool) {
  const q = (text, params) => pool.query(text, params);
  return {
    q, TERMINAL, OPEN_AT_BROKER,
    init: () => q(SCHEMA),
    async getConfig(key, dflt) { const r = await q("SELECT value FROM oms_config WHERE key=$1", [key]); return r.rows.length ? r.rows[0].value : dflt; },
    setConfig: (key, value) => q("INSERT INTO oms_config(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [key, JSON.stringify(value)]),
    audit: (action, reason, detail, ok = true) => q("INSERT INTO oms_audit(action,reason,ok,detail) VALUES($1,$2,$3,$4)", [action, reason || null, ok, detail ? JSON.stringify(detail) : null]),
    async order(id) { const r = await q("SELECT * FROM oms_orders WHERE id=$1", [id]); return r.rows[0] || null; },
    async byIdem(k) { const r = await q("SELECT * FROM oms_orders WHERE idem_key=$1", [k]); return r.rows[0] || null; },
    async byBroker(bid) { const r = await q("SELECT * FROM oms_orders WHERE broker_order_id=$1", [bid]); return r.rows[0] || null; },
    // state change + event in one transaction; refuses to move out of a terminal state
    async transition(id, to, patch = {}, detail = null) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const cur = (await c.query("SELECT status FROM oms_orders WHERE id=$1 FOR UPDATE", [id])).rows[0];
        if (!cur) throw new Error("order not found");
        if (TERMINAL.includes(cur.status) && cur.status !== to) { await c.query("ROLLBACK"); return false; }
        const cols = Object.keys(patch), sets = cols.map((k, i) => `${k}=$${i + 3}`);
        await c.query(`UPDATE oms_orders SET status=$2, updated_at=now()${sets.length ? ", " + sets.join(", ") : ""} WHERE id=$1`, [id, to, ...cols.map(k => patch[k])]);
        if (cur.status !== to || detail) await c.query("INSERT INTO oms_events(order_id,from_status,to_status,detail) VALUES($1,$2,$3,$4)", [id, cur.status, to, detail ? JSON.stringify(detail) : null]);
        await c.query("COMMIT"); return true;
      } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
    },
  };
}
module.exports = { create, TERMINAL, OPEN_AT_BROKER };
