// HTTP routes for the OMS, mounted under /api/oms/ behind the owner password gate.
// Every state-changing call must be a POST with JSON and the header "X-QS-OMS: 1" (blocks cross-site form posts).
"use strict";
const { Pool } = require("pg");
const DB = require("./db"), Engine = require("./engine"), Alpaca = require("./alpaca"), Sim = require("./simbroker");

function create({ env = process.env, log = console.log, broker, pool } = {}) {
  if (!pool && !env.DATABASE_URL) return { handle: (req, res) => send(res, 503, { error: "The OMS needs a database. Set DATABASE_URL (Neon) in Render → Environment." }), start: async () => {}, enabled: false };
  pool = pool || new Pool({ connectionString: env.DATABASE_URL, ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL) ? false : { rejectUnauthorized: true }, max: 4 });
  pool.on("error", () => {});
  // broker: Alpaca when its keys are set (unless OMS_BROKER=sim), otherwise the built-in paper broker on live quotes
  const useSim = !broker && (env.OMS_BROKER === "sim" || !(env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY));
  if (!broker && useSim) {
    const keyless = require("../keyless");
    broker = Sim.create({ quote: s => keyless.nasdaqInfo(s), store: Sim.pgStore(pool), startCash: Number(env.SIM_START_CASH) || 100000, log });
  }
  broker = broker || Alpaca.create(env);
  const brokerName = broker.name || "Alpaca paper";
  const db = DB.create(pool), engine = Engine.create({ db, broker, log });

  async function body(req) {
    let s = ""; for await (const c of req) { s += c; if (s.length > 20000) throw Object.assign(new Error("body too large"), { status: 413 }); }
    try { return s ? JSON.parse(s) : {}; } catch { throw Object.assign(new Error("invalid JSON"), { status: 400 }); }
  }
  async function handle(req, res, url) {
    const p = url.pathname.replace(/^\/api\/oms/, "") || "/", m = req.method;
    try {
      if (m === "POST" && req.headers["x-qs-oms"] !== "1") return send(res, 403, { error: "missing X-QS-OMS header" });
      const b = m === "POST" ? await body(req) : {};
      let r;
      if (m === "GET" && p === "/status") r = { ...(await engine.status()), broker: brokerName };
      else if (m === "POST" && p === "/sim/reset") {
        if (!broker.reset) return send(res, 400, { error: "reset is only for the built-in paper broker" });
        if (String(b.reason || "").trim().length < 3) return send(res, 400, { error: "a reason is required" });
        r = await broker.reset(Number(b.cash) > 0 ? Number(b.cash) : undefined); await db.audit("sim_reset", b.reason, { cash: r.cash }, true);
      }
      else if (m === "GET" && p === "/key") r = { idem_key: engine.newKey() };
      else if (m === "GET" && p === "/orders") {
        const st = url.searchParams.get("status"), lim = Math.min(500, Number(url.searchParams.get("limit")) || 200);
        r = (await db.q(`SELECT * FROM oms_orders ${st ? "WHERE status = ANY($2)" : ""} ORDER BY created_at DESC LIMIT $1`, st ? [lim, st.split(",")] : [lim])).rows;
      }
      else if (m === "GET" && /^\/orders\/[0-9a-f-]{36}$/.test(p)) {
        const id = p.split("/")[2], o = await db.order(id); if (!o) return send(res, 404, { error: "not found" });
        r = { order: o, events: (await db.q("SELECT * FROM oms_events WHERE order_id=$1 ORDER BY at, id", [id])).rows, fills: (await db.q("SELECT * FROM oms_fills WHERE order_id=$1 ORDER BY at", [id])).rows };
      }
      else if (m === "POST" && p === "/orders") r = await engine.propose(b);
      else if (m === "POST" && /^\/orders\/[0-9a-f-]{36}\/(approve|decline|cancel|modify)$/.test(p)) {
        const [, , id, act] = p.split("/");
        r = act === "approve" ? await engine.approve(id, b.reason) : act === "decline" ? await engine.decline(id, b.reason) : act === "cancel" ? await engine.cancel(id, b.reason) : await engine.modify(id, b, b.reason);
      }
      else if (m === "GET" && p === "/fills") r = (await db.q("SELECT * FROM oms_fills ORDER BY at DESC LIMIT 300")).rows;
      else if (m === "GET" && p === "/pnl") r = await engine.pnl();
      else if (m === "GET" && p === "/audit") r = (await db.q("SELECT * FROM oms_audit ORDER BY id DESC LIMIT 200")).rows;
      else if (m === "POST" && p === "/reconcile") r = await engine.reconcile();
      else if (m === "POST" && p === "/sync") { await engine.sync(); r = { ok: true }; }
      else if (m === "POST" && p === "/kill") r = await engine.setKill(!!b.on, b.reason, { cancelAll: !!b.cancelAll, flatten: !!b.flatten });
      else if (m === "POST" && p === "/limits") r = await engine.setLimits(b, b.reason);
      else return send(res, 404, { error: "unknown OMS endpoint" });
      send(res, 200, r);
    } catch (e) { send(res, e.status && e.status < 600 ? e.status : 500, { error: e.message }); if (!e.status || e.status >= 500) log("oms error: " + e.message); }
  }
  return { handle, start: () => engine.start().then(() => log(`oms: ready · paper · broker: ${brokerName}`)), engine, db, broker, enabled: true };
}
function send(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); }
module.exports = { create };
