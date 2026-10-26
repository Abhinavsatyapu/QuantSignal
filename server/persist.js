'use strict';
// Pluggable durable storage for the derivatives data (run History, plans, learning-weight versions, account settings,
// reference-sheet trades).
//   · No DATABASE_URL → local SQLite only (on Render free the filesystem resets on every deploy/restart).
//   · DATABASE_URL set (Neon / Supabase / Render Postgres) → every row is mirrored to Postgres (table qs_rows, one JSONB
//     row per SQLite row, keyed by table + id). On boot an empty SQLite is restored from Postgres, so History, weights and
//     settings survive restarts. SQLite stays the synchronous working store the engine uses; Postgres is the durable copy.
const log = require('./log');
const TABLES = { strategy_runs: 'id', strategy_plans: 'id', strategy_weights: 'id', account_settings: 'id', reference_trades: 'page' };
let pool = null, db = null, timer = null, lastSaved = null, lastError = null, restoreInfo = { pending: true };
const dirty = new Map(); // table → Set(ids) | 'all'
const backend = () => (process.env.DATABASE_URL ? 'postgres' : 'sqlite');
function makePool(PoolCls) {
  const url = process.env.DATABASE_URL, local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  // Neon/Supabase need TLS; certificates are verified unless PGSSL_NO_VERIFY=1 (self-signed providers only)
  return new PoolCls({ connectionString: url, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, ssl: local ? false : { rejectUnauthorized: process.env.PGSSL_NO_VERIFY !== '1' } });
}
async function migrate(p) {
  await p.query(`CREATE TABLE IF NOT EXISTS qs_rows(tbl TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(tbl, id))`);
  await p.query(`CREATE TABLE IF NOT EXISTS qs_meta(key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await p.query(`INSERT INTO qs_meta(key, value) VALUES('schema_version', '1'::jsonb) ON CONFLICT(key) DO NOTHING`);
}
async function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    // PG_DRIVER=neon-serverless → Neon's pg-compatible driver over WebSockets (port 443), for networks that block 5432
    let PoolCls = require('pg').Pool;
    if (process.env.PG_DRIVER === 'neon-serverless') { const n = require('@neondatabase/serverless'); n.neonConfig.webSocketConstructor = require('ws'); PoolCls = n.Pool; }
    pool = makePool(PoolCls); pool.on('error', (e) => { lastError = e.message; log.error('persist.pool_error', { error: e.message }); }); await migrate(pool); }
  return pool;
}
function setPoolForTest(p) { pool = p; return migrate(p); }
const pk = (tbl) => TABLES[tbl];
function rowsOf(tbl, ids) {
  const k = pk(tbl);
  if (ids === 'all') return db.prepare(`SELECT * FROM ${tbl}`).all();
  const st = db.prepare(`SELECT * FROM ${tbl} WHERE ${k}=?`); return [...ids].map((i) => st.get(i)).filter(Boolean);
}
async function flush() {
  const p = await getPool(); if (!p || !dirty.size) return { saved: 0 };
  const work = [...dirty.entries()]; dirty.clear(); let saved = 0;
  try {
    for (const [tbl, ids] of work) {
      const rows = rowsOf(tbl, ids);
      for (let i = 0; i < rows.length; i += 25) { // batched upserts (25 rows per statement)
        const chunk = rows.slice(i, i + 25), vals = [], ph = chunk.map((r, j) => { vals.push(tbl, String(r[pk(tbl)]), JSON.stringify(r)); return `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3},now())`; });
        await p.query(`INSERT INTO qs_rows(tbl,id,data,updated_at) VALUES ${ph.join(',')} ON CONFLICT(tbl,id) DO UPDATE SET data=excluded.data, updated_at=now()`, vals); saved += chunk.length;
      }
    }
    lastSaved = new Date().toISOString(); lastError = null; return { saved };
  } catch (e) { lastError = e.message; log.error('persist.save_failed', { error: e.message }); for (const [tbl, ids] of work) mark(tbl, ids === 'all' ? 'all' : [...ids]); throw e; }
}
function mark(tbl, id) {
  if (backend() !== 'postgres' || !TABLES[tbl]) return;
  if (id === 'all') dirty.set(tbl, 'all');
  else { const cur = dirty.get(tbl); if (cur === 'all') return; const s = cur || new Set(); for (const i of [].concat(id)) if (i != null) s.add(i); dirty.set(tbl, s); }
  clearTimeout(timer); timer = setTimeout(() => flush().catch(() => {}), 1500);
}
// restore every mirrored table into SQLite when the local store is empty (fresh container), then mirror anything local
async function init(sqlite) {
  db = sqlite;
  if (backend() !== 'postgres') return (restoreInfo = { backend: 'sqlite', restored: false });
  try {
    const p = await getPool(), localRuns = db.prepare('SELECT COUNT(*) n FROM strategy_runs').get().n;
    const { rows } = await p.query('SELECT tbl, data FROM qs_rows ORDER BY tbl, id');
    let restored = 0;
    if (!localRuns && rows.length) {
      const cols = {}; for (const t of Object.keys(TABLES)) cols[t] = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
      db.transaction(() => { for (const { tbl, data } of rows) { if (!cols[tbl]) continue; const ks = Object.keys(data).filter((k) => cols[tbl].has(k)); db.prepare(`INSERT OR REPLACE INTO ${tbl}(${ks.join(',')}) VALUES(${ks.map(() => '?').join(',')})`).run(...ks.map((k) => (data[k] !== null && typeof data[k] === 'object' ? JSON.stringify(data[k]) : data[k]))); restored++; } })();
    }
    // push local rows the remote does not have yet (first connection, or rows written while the DB was unreachable)
    const have = new Set(rows.map((r) => r.tbl + '/' + String(r.data[pk(r.tbl)])));
    for (const t of Object.keys(TABLES)) for (const r of db.prepare(`SELECT ${pk(t)} AS k FROM ${t}`).all()) if (!have.has(t + '/' + r.k)) mark(t, r.k);
    await flush();
    restoreInfo = { backend: 'postgres', restored: restored > 0, restoredRows: restored, remoteRows: rows.length };
    log.info('persist.init', restoreInfo);
  } catch (e) { lastError = e.message; restoreInfo = { backend: 'postgres', restored: false, error: e.message }; log.error('persist.init_failed', { error: e.message }); }
  return restoreInfo;
}
function status() { return { backend: backend(), durable: backend() === 'postgres' && !lastError, lastSaved, lastError, pending: dirty.size, restore: restoreInfo,
  note: backend() === 'postgres' ? 'History, plans, weights and settings are mirrored to Postgres (DATABASE_URL) and restored after restarts.' : 'Local SQLite only — on Render free the filesystem resets on every deploy/restart. Export a backup, or set DATABASE_URL to a Postgres database.' }; }
async function close() { clearTimeout(timer); try { await flush(); } catch {} if (pool) await pool.end().catch(() => {}); pool = null; }
module.exports = { init, mark, flush, status, backend, close, setPoolForTest, TABLES };
