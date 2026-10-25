'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const { DATA_DIR } = require('./config');

const db = new Database(process.env.QS_DB || path.join(DATA_DIR, 'quantsignal.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(`
CREATE TABLE IF NOT EXISTS signals(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, coin TEXT NOT NULL,
  direction TEXT NOT NULL, interval TEXT, entry REAL, stop REAL, tp REAL, score INTEGER, closed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'new', reason TEXT, dedupe_key TEXT UNIQUE, raw TEXT);
CREATE TABLE IF NOT EXISTS trades(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, signal_id INTEGER, coin TEXT NOT NULL, direction TEXT NOT NULL,
  mode TEXT NOT NULL, network TEXT NOT NULL, size REAL, entry_px REAL, stop_px REAL, tp_px REAL, notional REAL, leverage REAL,
  status TEXT NOT NULL, exit_px REAL, exit_ts INTEGER, exit_reason TEXT, pnl REAL, orders TEXT, response TEXT);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL, msg TEXT NOT NULL, data TEXT);
CREATE TABLE IF NOT EXISTS scans(
  coin TEXT NOT NULL, interval TEXT NOT NULL, ts INTEGER NOT NULL, closed_at INTEGER, direction TEXT, score INTEGER, data TEXT,
  PRIMARY KEY(coin, interval));
CREATE TABLE IF NOT EXISTS equity_days(day TEXT PRIMARY KEY, start_equity REAL NOT NULL, mode TEXT);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`);

const j = v => (v === undefined ? null : JSON.stringify(v));
const stmts = {
  event: db.prepare('INSERT INTO events(ts,level,msg,data) VALUES(?,?,?,?)'),
  signal: db.prepare(`INSERT OR IGNORE INTO signals(ts,source,coin,direction,interval,entry,stop,tp,score,closed_at,status,reason,dedupe_key,raw)
    VALUES(@ts,@source,@coin,@direction,@interval,@entry,@stop,@tp,@score,@closed_at,@status,@reason,@dedupe_key,@raw)`),
  signalStatus: db.prepare('UPDATE signals SET status=?, reason=? WHERE id=?'),
  trade: db.prepare(`INSERT INTO trades(ts,signal_id,coin,direction,mode,network,size,entry_px,stop_px,tp_px,notional,leverage,status,orders,response)
    VALUES(@ts,@signal_id,@coin,@direction,@mode,@network,@size,@entry_px,@stop_px,@tp_px,@notional,@leverage,@status,@orders,@response)`),
  closeTrade: db.prepare('UPDATE trades SET status=?, exit_px=?, exit_ts=?, exit_reason=?, pnl=? WHERE id=?'),
  scan: db.prepare(`INSERT INTO scans(coin,interval,ts,closed_at,direction,score,data) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(coin,interval) DO UPDATE SET ts=excluded.ts, closed_at=excluded.closed_at, direction=excluded.direction, score=excluded.score, data=excluded.data`),
};

function log(level, msg, data) {
  const ts = Date.now();
  stmts.event.run(ts, level, msg, j(data));
  const line = `[${new Date(ts).toISOString()}] ${level.toUpperCase()} ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  (level === 'error' ? console.error : console.log)(line);
}

function insertSignal(s) {
  const info = stmts.signal.run({ ts: Date.now(), interval: null, entry: null, stop: null, tp: null, score: null, closed_at: null, status: 'new', reason: null, dedupe_key: null, ...s, raw: j(s.raw) });
  return info.changes ? info.lastInsertRowid : null;
}
const setSignalStatus = (id, status, reason) => id && stmts.signalStatus.run(status, reason || null, id);
function insertTrade(t) {
  return stmts.trade.run({ signal_id: null, size: null, entry_px: null, stop_px: null, tp_px: null, notional: null, leverage: null, ...t, ts: Date.now(), orders: j(t.orders), response: j(t.response) }).lastInsertRowid;
}
const closeTrade = (id, status, px, reason, pnl) => stmts.closeTrade.run(status, px, Date.now(), reason, pnl, id);
const saveScan = (coin, interval, a) => stmts.scan.run(coin, interval, Date.now(), a.closedAt ?? null, a.direction ?? null, a.score ?? null, j(a));

const parse = r => { if (!r) return r; for (const k of ['raw', 'orders', 'response', 'data']) if (typeof r[k] === 'string') { try { r[k] = JSON.parse(r[k]); } catch {} } return r; };
const all = (sql, ...a) => db.prepare(sql).all(...a).map(parse);
const one = (sql, ...a) => parse(db.prepare(sql).get(...a));

module.exports = { db, log, insertSignal, setSignalStatus, insertTrade, closeTrade, saveScan, all, one };
