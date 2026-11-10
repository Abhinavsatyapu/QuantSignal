'use strict';

/** Cluster same-side prints at one price within a short window (iceberg / sliced flow). */
function clusterPrints(trades, opts = {}) {
  const windowMs = opts.windowMs != null ? opts.windowMs : 3000;
  const minNotional = opts.minClusterNotional != null ? opts.minClusterNotional : 50000;
  const rows = (trades || []).map((t) => ({
    id: t.id, price: Number(t.price), qty: Number(t.qty),
    notional: Number(t.notional != null ? t.notional : Number(t.price) * Number(t.qty)),
    side: t.side, ts: Number(t.ts),
  })).filter((t) => t.price > 0 && t.qty > 0 && t.side && t.ts)
    .sort((a, b) => a.ts - b.ts || a.price - b.price);
  const used = new Set();
  const clusters = [];
  for (let i = 0; i < rows.length; i++) {
    if (used.has(i)) continue;
    const seed = rows[i];
    const members = [seed];
    used.add(i);
    for (let j = i + 1; j < rows.length; j++) {
      if (used.has(j)) continue;
      const t = rows[j];
      if (t.side !== seed.side) continue;
      if (t.price !== seed.price) continue;
      if (t.ts - seed.ts > windowMs) break;
      if (t.ts - members[members.length - 1].ts > windowMs) continue;
      members.push(t);
      used.add(j);
    }
    const notional = members.reduce((s, m) => s + m.notional, 0);
    const qty = members.reduce((s, m) => s + m.qty, 0);
    if (notional >= minNotional && members.length >= 1) {
      clusters.push({
        side: seed.side,
        price: seed.price,
        qty: +qty.toFixed(6),
        notional: +notional.toFixed(2),
        prints: members.length,
        startTs: members[0].ts,
        endTs: members[members.length - 1].ts,
      });
    }
  }
  clusters.sort((a, b) => b.notional - a.notional);
  return clusters;
}

/**
 * Track book walls across snapshots. A wall is shown only after it has been
 * seen in `needSeen` snapshots and has not gone missing for `maxGapMs`.
 */
function updateWallMemory(memory, symbol, walls, now, opts = {}) {
  const needSeen = opts.needSeen != null ? opts.needSeen : 2;
  const maxAgeMs = opts.maxAgeMs != null ? opts.maxAgeMs : 30 * 60e3;
  const mem = memory || {};
  const bySym = mem[symbol] || {};
  const seenNow = new Set();
  for (const w of walls || []) {
    const key = (w.side || '') + '@' + Number(w.price);
    seenNow.add(key);
    const prev = bySym[key] || { side: w.side, price: Number(w.price), seen: 0, firstAt: now, lastAt: 0, notional: 0, qty: 0 };
    prev.seen += 1;
    prev.lastAt = now;
    prev.notional = Number(w.notional) || prev.notional;
    prev.qty = Number(w.qty) || prev.qty;
    bySym[key] = prev;
  }
  for (const [key, rec] of Object.entries(bySym)) {
    if (!seenNow.has(key) && now - rec.lastAt > maxAgeMs) delete bySym[key];
  }
  mem[symbol] = bySym;
  const persistent = Object.values(bySym)
    .filter((r) => r.seen >= needSeen && now - r.lastAt <= maxAgeMs)
    .map((r) => ({
      side: r.side, price: r.price, qty: r.qty, notional: r.notional,
      snapshots: r.seen, firstAt: r.firstAt, lastAt: r.lastAt, persistent: true,
    }))
    .sort((a, b) => b.notional - a.notional);
  return { memory: mem, walls: persistent };
}

module.exports = { clusterPrints, updateWallMemory };
