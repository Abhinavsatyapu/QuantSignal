// Storage layer: SQLite working store mirrored to Postgres (pg-mem in-process Postgres here; Neon in production).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'), os = require('os'), fs = require('fs');
const { newDb } = require('pg-mem');

test('persist: rows mirror to Postgres and restore into an empty SQLite', async () => {
  process.env.DATABASE_URL = 'postgres://test@localhost:5432/test';
  const Database = require('better-sqlite3');
  const mem = newDb(), { Pool } = mem.adapters.createPg(), pool = new Pool();
  const persist = require('../server/persist');
  await persist.setPoolForTest(pool);
  const mk = (file) => { const d = new Database(file); d.exec(`CREATE TABLE strategy_runs(id INTEGER PRIMARY KEY, ts INTEGER, ticker TEXT, result TEXT, realised_pnl REAL);
    CREATE TABLE strategy_plans(id INTEGER PRIMARY KEY, ts INTEGER); CREATE TABLE strategy_weights(id INTEGER PRIMARY KEY, ts INTEGER, weights TEXT);
    CREATE TABLE account_settings(id INTEGER PRIMARY KEY, settings TEXT, updated_at INTEGER); CREATE TABLE reference_trades(page INTEGER PRIMARY KEY, symbol TEXT)`); return d; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-persist-'));
  const a = mk(path.join(dir, 'a.db'));
  a.prepare('INSERT INTO strategy_runs(id,ts,ticker,result) VALUES(1,?,?,?)').run(1, 'AAPL', JSON.stringify({ best: { x: 1 } }));
  a.prepare('INSERT INTO reference_trades(page,symbol) VALUES(10,?)').run('INTC');
  await persist.init(a); // pushes local rows the remote does not have
  let r = await pool.query("SELECT tbl, id, data FROM qs_rows ORDER BY tbl, id");
  assert.deepEqual(r.rows.map(x => x.tbl + '/' + x.id), ['reference_trades/10', 'strategy_runs/1']);
  // an update is mirrored after mark + flush
  a.prepare('UPDATE strategy_runs SET realised_pnl=420 WHERE id=1').run(); persist.mark('strategy_runs', 1); await persist.flush();
  r = await pool.query("SELECT data FROM qs_rows WHERE tbl='strategy_runs' AND id='1'");
  assert.equal(r.rows[0].data.realised_pnl, 420);
  // a fresh container (empty SQLite) is restored from Postgres
  const b = mk(path.join(dir, 'b.db'));
  const info = await persist.init(b);
  assert.equal(info.restored, true);
  const row = b.prepare('SELECT * FROM strategy_runs WHERE id=1').get();
  assert.equal(row.ticker, 'AAPL'); assert.equal(row.realised_pnl, 420); assert.deepEqual(JSON.parse(row.result), { best: { x: 1 } });
  assert.equal(b.prepare('SELECT symbol FROM reference_trades WHERE page=10').get().symbol, 'INTC');
  assert.equal(persist.status().backend, 'postgres');
  delete process.env.DATABASE_URL;
});
