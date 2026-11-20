// Persistence for the Zone Monitor: Neon / any Postgres when DATABASE_URL is set, otherwise a JSON file in /tmp.
// Two tables: zone_history (one row per trading day: +GEX breadth, SPY gamma) and zone_cache (latest credit / breadth /
// gamma snapshots, so a restarted server shows the last readings instantly instead of a 6-minute blank).
"use strict";
const fs = require("fs");
const URL_ = process.env.DATABASE_URL || "";
const FILE = process.env.ZONE_HISTORY || "/tmp/zone-history.json";
let pool = null, ready = null, mode = "file";

if (URL_) {
  const { Pool } = require("pg");
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(URL_);
  pool = new Pool({ connectionString: URL_, ssl: local ? false : { rejectUnauthorized: true }, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
  pool.on("error", () => {});                          // Neon closes idle connections; the pool reconnects on next use
  mode = "postgres";
  ready = pool.query(`
    CREATE TABLE IF NOT EXISTS zone_history (day date PRIMARY KEY, breadth double precision, spy_norm double precision, n integer, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS zone_cache (key text PRIMARY KEY, data jsonb NOT NULL, at timestamptz NOT NULL);`);
}
const fileRead = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; } };
const fileWrite = o => { try { fs.writeFileSync(FILE, JSON.stringify(o)); } catch {} };

async function loadHistory() {
  if (!pool) return fileRead().history || fileRead();
  await ready;
  const r = await pool.query("SELECT to_char(day,'YYYY-MM-DD') AS day, breadth, spy_norm, n FROM zone_history ORDER BY day DESC LIMIT 400");
  return Object.fromEntries(r.rows.map(x => [x.day, { breadth: x.breadth, spyNorm: x.spy_norm, n: x.n }]));
}
async function saveDay(day, v) {
  if (!pool) { const o = fileRead(); const h = o.history || {}; h[day] = v; fileWrite({ ...o, history: h }); return; }
  await ready;
  await pool.query(`INSERT INTO zone_history (day, breadth, spy_norm, n, updated_at) VALUES ($1,$2,$3,$4,now())
    ON CONFLICT (day) DO UPDATE SET breadth=EXCLUDED.breadth, spy_norm=EXCLUDED.spy_norm, n=EXCLUDED.n, updated_at=now()`, [day, v.breadth, v.spyNorm, v.n]);
}
async function loadCache() {
  if (!pool) return fileRead().cache || {};
  await ready;
  const r = await pool.query("SELECT key, data, extract(epoch from at)*1000 AS at FROM zone_cache");
  return Object.fromEntries(r.rows.map(x => [x.key, { data: x.data, at: Number(x.at) }]));
}
async function saveCache(key, data, at) {
  if (!pool) { const o = fileRead(); fileWrite({ ...o, cache: { ...(o.cache || {}), [key]: { data, at } } }); return; }
  await ready;
  await pool.query(`INSERT INTO zone_cache (key, data, at) VALUES ($1,$2,to_timestamp($3/1000.0)) ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data, at=EXCLUDED.at`, [key, JSON.stringify(data), at]);
}
module.exports = { mode: () => mode, loadHistory, saveDay, loadCache, saveCache };
