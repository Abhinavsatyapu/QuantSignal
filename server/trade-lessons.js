'use strict';
/**
 * Learning loop: tag closed trades with failure/success causes; suggest rule updates.
 * Suggestions only — never auto-change live trading rules.
 */
const store = require('./db');

function ensure() {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS bn_trade_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER NOT NULL,
      symbol TEXT,
      direction TEXT,
      pnl REAL,
      exit_reason TEXT,
      causes TEXT NOT NULL,
      meta TEXT,
      success INTEGER DEFAULT 0,
      ts INTEGER NOT NULL,
      UNIQUE(trade_id)
    );
    CREATE TABLE IF NOT EXISTS bn_rule_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      setup TEXT,
      suggestion TEXT NOT NULL,
      evidence TEXT,
      status TEXT DEFAULT 'pending' -- pending|accepted|rejected|dismissed
    );
  `);
}

function usCashSession(entryTs) {
  const d = new Date(entryTs);
  const dow = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const open = 14 * 60 + 30, close = 21 * 60;
  if (dow === 0 || dow === 6) return { label: 'weekend', cash: false };
  if (mins < open) return { label: 'premarket_utc', cash: false };
  if (mins >= close) return { label: 'afterhours_utc', cash: false };
  return { label: 'us_cash', cash: true };
}

/** Lightweight live tagging (no full kline MAE without bars). */
function classifyClosedTrade(trade) {
  const causes = [];
  const meta = {};
  const ts = trade.ts || trade.entry_ts || trade.entryTime || Date.now();
  const sess = usCashSession(ts);
  meta.session = sess.label;
  if (!sess.cash) causes.push('illiquid_session');
  const dow = new Date(ts + 5.5 * 3600e3).getUTCDay();
  const hour = new Date(ts + 5.5 * 3600e3).getUTCHours();
  if (dow === 5 && hour >= 18) causes.push('weekend_risk_window');
  const reason = String(trade.exit_reason || trade.reason || '');
  if (/stop/i.test(reason)) causes.push('stop_exit');
  if (/tp|target/i.test(reason)) causes.push('target_exit');
  const pnl = Number(trade.pnl);
  if (!(pnl > 0) && !causes.length) causes.push('unclassified_loss');
  if (pnl > 0 && !causes.filter((c) => c !== 'target_exit').length) causes.push('win_thesis_ok');
  return { causes, meta, success: pnl > 0 ? 1 : 0 };
}

function recordLesson(trade) {
  ensure();
  const id = trade.id;
  if (!id) return null;
  const { causes, meta, success } = classifyClosedTrade(trade);
  // correlated cluster: other losses same IST day
  try {
    const dayStart = (() => {
      const ist = new Date((trade.exit_ts || Date.now()) + 5.5 * 3600e3);
      const ymd = ist.toISOString().slice(0, 10);
      return Date.parse(ymd + 'T00:00:00+05:30');
    })();
    const peers = store.db.prepare(
      "SELECT id,symbol,pnl FROM bn_trades WHERE status IN ('closed','CLOSED') AND exit_ts>=? AND exit_ts<? AND pnl<0"
    ).all(dayStart, dayStart + 86400e3);
    if (peers.length >= 2 && Number(trade.pnl) < 0) {
      if (!causes.includes('correlated_cluster')) causes.push('correlated_cluster');
      meta.correlatedPeers = peers.map((p) => p.symbol);
    }
  } catch {}
  store.db.prepare(
    `INSERT INTO bn_trade_lessons(trade_id,symbol,direction,pnl,exit_reason,causes,meta,success,ts)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(trade_id) DO UPDATE SET causes=excluded.causes, meta=excluded.meta, pnl=excluded.pnl, success=excluded.success`
  ).run(
    id,
    trade.symbol || null,
    trade.direction || trade.side || null,
    trade.pnl ?? null,
    trade.exit_reason || trade.reason || null,
    JSON.stringify(causes),
    JSON.stringify(meta),
    success,
    Date.now()
  );
  try { require('./persist').mark('bn_trade_lessons', String(id)); } catch {}
  try { maybeRefreshSuggestions(); } catch {}
  return { trade_id: id, causes, meta, success };
}

function summarizeLessons(limit = 200) {
  ensure();
  const rows = store.db.prepare('SELECT * FROM bn_trade_lessons ORDER BY id DESC LIMIT ?').all(limit);
  const causeCount = {};
  let losses = 0, wins = 0;
  for (const r of rows) {
    if (r.success) wins++; else losses++;
    let causes = [];
    try { causes = JSON.parse(r.causes); } catch { causes = []; }
    for (const c of causes) causeCount[c] = (causeCount[c] || 0) + 1;
  }
  return { n: rows.length, wins, losses, causeCount, recent: rows.slice(0, 20) };
}

function buildSuggestions() {
  ensure();
  const s = summarizeLessons(500);
  const suggestions = [];
  const lossN = Math.max(s.losses, 1);
  const illiq = s.causeCount.illiquid_session || 0;
  const corr = s.causeCount.correlated_cluster || 0;
  const noise = s.causeCount.noise_stop_out || s.causeCount.stop_exit || 0;
  if (illiq / lossN >= 0.25) {
    suggestions.push({
      setup: 'all',
      suggestion: 'Enable usCashOnly entry filter (US cash session ≈14:30–21:00 UTC) — postmortem ADOPT on Setup B',
      evidence: { illiquid_session: illiq, losses: s.losses },
    });
  }
  if (corr / lossN >= 0.3) {
    suggestions.push({
      setup: 'all',
      suggestion: 'Cap correlated exposure: max 1 new entry per IST day when SPY/QQQ (or ≥2 names) already losing',
      evidence: { correlated_cluster: corr, losses: s.losses },
    });
  }
  if ((s.causeCount.against_htf_trend || 0) / lossN >= 0.15) {
    suggestions.push({
      setup: 'all',
      suggestion: 'Require 1d EMA20/50 HTF alignment with trade direction',
      evidence: { against_htf_trend: s.causeCount.against_htf_trend },
    });
  }
  const out = [];
  for (const sug of suggestions) {
    const info = store.db.prepare(
      `INSERT INTO bn_rule_suggestions(ts,setup,suggestion,evidence,status) VALUES(?,?,?,?, 'pending')`
    ).run(Date.now(), sug.setup, sug.suggestion, JSON.stringify(sug.evidence));
    out.push({ id: info.lastInsertRowid, ...sug, status: 'pending' });
  }
  return out;
}

function listSuggestions(status = 'pending') {
  ensure();
  return store.db.prepare('SELECT * FROM bn_rule_suggestions WHERE status=? ORDER BY id DESC LIMIT 50').all(status);
}

function setSuggestionStatus(id, status) {
  ensure();
  if (!['accepted', 'rejected', 'dismissed', 'pending'].includes(status)) throw Error('bad status');
  store.db.prepare('UPDATE bn_rule_suggestions SET status=? WHERE id=?').run(status, id);
  return store.db.prepare('SELECT * FROM bn_rule_suggestions WHERE id=?').get(id);
}

let _lessonCount = 0;
function maybeRefreshSuggestions() {
  _lessonCount++;
  if (_lessonCount % 10 === 0) buildSuggestions();
}

ensure();
module.exports = { maybeRefreshSuggestions,
  ensure, classifyClosedTrade, recordLesson, summarizeLessons, buildSuggestions, listSuggestions, setSuggestionStatus,
};
