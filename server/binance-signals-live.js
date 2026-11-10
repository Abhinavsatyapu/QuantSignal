'use strict';
// Presentation helpers for the Live Signals page. No order placement.

const INTERVAL_MS = {
  '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3,
  '30m': 1800e3, '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '1d': 86400e3,
};

function intervalMs(iv) { return INTERVAL_MS[iv] || 1800e3; }

function nextBarCloseAt(iv, now = Date.now()) {
  const ms = intervalMs(iv);
  return Math.ceil((now + 1) / ms) * ms;
}

function formatIst(ts) {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleString('en-IN', {
      timeZone: 'Asia/Calcutta', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }) + ' IST';
  } catch { return new Date(ts).toISOString(); }
}

function parseRaw(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function rrOf(row) {
  const e = Number(row.entry), s = Number(row.stop), t = Number(row.tp);
  if (!(e > 0 && s > 0 && t > 0)) return null;
  const risk = Math.abs(e - s), reward = Math.abs(t - e);
  if (!(risk > 0)) return null;
  return Math.round((reward / risk) * 100) / 100;
}

function mapStatus(row) {
  const s = String(row.status || 'new');
  const reason = row.reason || null;
  if (s === 'skipped') return { statusLabel: 'skipped', reason };
  if (s === 'dry_run' || s === 'pending') return { statusLabel: 'pending', reason };
  if (s === 'new') return { statusLabel: 'new', reason };
  if (s === 'taken' || s === 'filled' || s === 'open' || s === 'PROTECTED' || s === 'FILLED') return { statusLabel: 'taken', reason };
  if (s === 'rejected' && /max concurrent|already exists|Max concurrent/i.test(reason || '')) {
    return { statusLabel: 'skipped', reason };
  }
  if (s === 'rejected' && /duplicate|already processed/i.test(reason || '')) {
    return { statusLabel: 'skipped', reason: reason || 'duplicate' };
  }
  if (s === 'rejected') return { statusLabel: 'skipped', reason };
  return { statusLabel: s, reason };
}

function conditionsOf(row) {
  const raw = parseRaw(row.raw);
  const c = raw.conditions || raw.comboConditions || {};
  return {
    trend: !!c.trend,
    flow: !!c.flow,
    buySide: !!(c.buySide || c.buy_side),
    trendDir: c.trendDir || null,
    flowDir: c.flowDir || null,
    buyDir: c.buyDir || null,
  };
}

function enrichSignal(row) {
  const mapped = mapStatus(row);
  return {
    id: row.id,
    ts: row.ts,
    tsIst: formatIst(row.ts),
    source: row.source,
    symbol: row.symbol,
    direction: row.direction,
    interval: row.interval,
    entry: row.entry,
    stop: row.stop,
    tp: row.tp,
    rr: rrOf(row),
    score: row.score,
    closed_at: row.closed_at,
    status: row.status,
    statusLabel: mapped.statusLabel,
    reason: mapped.reason,
    conditions: conditionsOf(row),
  };
}

function enrichScan(row, mark) {
  let data = {};
  try { data = row.data ? JSON.parse(row.data) : {}; } catch { data = {}; }
  const cond = data.comboConditions || data.conditions || {};
  return {
    symbol: row.symbol,
    interval: row.interval,
    ts: row.ts,
    tsIst: formatIst(row.ts),
    closedAt: row.closed_at,
    direction: data.signalDir || row.direction || null,
    skipReason: data.skipReason || null,
    score: row.score,
    conditions: {
      trend: !!cond.trend, flow: !!cond.flow, buySide: !!(cond.buySide || cond.buy_side),
      trendDir: cond.trendDir || null, flowDir: cond.flowDir || null, buyDir: cond.buyDir || null,
    },
    mark: mark != null ? mark : null,
  };
}

module.exports = {
  intervalMs, nextBarCloseAt, formatIst, parseRaw, rrOf, mapStatus, conditionsOf, enrichSignal, enrichScan,
};
