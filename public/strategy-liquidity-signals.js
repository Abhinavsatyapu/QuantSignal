'use strict';
// Deterministic price-action / liquidity signals for QuantSignal Binance trader.
// Pivot lookback L, equal-level tolerance tolPct, reclaim window N (candles).
// Candle shape: { t,o,h,l,c,v } or [t,o,h,l,c,v]. Exported on globalThis.LiquiditySignals
(function (root) {
  const num = (x) => Number(x);
  const bar = (c) => (Array.isArray(c)
    ? { t: c[0], o: num(c[1]), h: num(c[2]), l: num(c[3]), c: num(c[4]), v: num(c[5]) }
    : { t: c.t, o: num(c.o), h: num(c.h), l: num(c.l), c: num(c.c), v: num(c.v) });

  function swings(candles, lookback) {
    const L = Math.max(2, lookback | 0), out = { highs: [], lows: [] };
    for (let i = L; i < candles.length - L; i++) {
      const c = candles[i];
      let isH = true, isL = true;
      for (let j = 1; j <= L; j++) {
        if (!(c.h > candles[i - j].h && c.h >= candles[i + j].h)) isH = false;
        if (!(c.l < candles[i - j].l && c.l <= candles[i + j].l)) isL = false;
      }
      if (isH) out.highs.push({ i, price: c.h, t: c.t });
      if (isL) out.lows.push({ i, price: c.l, t: c.t });
    }
    return out;
  }

  function equalCluster(levels, tolPct) {
    // Group prices within tolPct of each other; return clusters with count >= 2 (equal highs/lows)
    const sorted = levels.slice().sort((a, b) => a.price - b.price), clusters = [];
    for (const lv of sorted) {
      const hit = clusters.find((cl) => Math.abs(cl.price - lv.price) / cl.price <= tolPct);
      if (hit) { hit.members.push(lv); hit.price = (hit.price * (hit.members.length - 1) + lv.price) / hit.members.length; }
      else clusters.push({ price: lv.price, members: [lv] });
    }
    return clusters.filter((cl) => cl.members.length >= 2);
  }

  /**
   * Scan the last closed candle (and reclaim window) for liquidity events.
   * opts: { lookback=5, tolPct=0.0015 (0.15%), reclaimN=3 }
   * Returns { signals: [...], pivots }
   * Each signal: { id, side:'LONG'|'SHORT', kind, level, barIndex, reason }
   */
  function detect(rawCandles, opts = {}) {
    const lookback = opts.lookback ?? 5;
    const tolPct = opts.tolPct ?? 0.0015;
    const reclaimN = opts.reclaimN ?? 3;
    const candles = (rawCandles || []).map(bar).filter((c) => c.h >= c.l && c.c > 0);
    if (candles.length < lookback * 2 + 5) return { signals: [], pivots: { highs: [], lows: [] } };
    const piv = swings(candles, lookback);
    const eqHigh = equalCluster(piv.highs, tolPct);
    const eqLow = equalCluster(piv.lows, tolPct);
    const signals = [];
    const last = candles.length - 1; // evaluate on last closed bar
    const cur = candles[last];

    // Prior swing high/low (most recent pivot strictly before last bar)
    const priorHigh = [...piv.highs].filter((p) => p.i < last).pop();
    const priorLow = [...piv.lows].filter((p) => p.i < last).pop();
    const eqH = eqHigh.filter((cl) => cl.members.every((m) => m.i < last)).pop();
    const eqL = eqLow.filter((cl) => cl.members.every((m) => m.i < last)).pop();

    // (a) Liquidity grab: wick through level, close back inside SAME candle
    if (priorHigh && cur.h > priorHigh.price && cur.c < priorHigh.price) {
      signals.push({ id: 'liquidity_grab_high', kind: 'liquidity_grab', side: 'SHORT', level: priorHigh.price, barIndex: last,
        reason: `Wick through prior swing high ${priorHigh.price.toFixed(4)}, close back below on same candle` });
    }
    if (priorLow && cur.l < priorLow.price && cur.c > priorLow.price) {
      signals.push({ id: 'liquidity_grab_low', kind: 'liquidity_grab', side: 'LONG', level: priorLow.price, barIndex: last,
        reason: `Wick through prior swing low ${priorLow.price.toFixed(4)}, close back above on same candle` });
    }
    // Equal highs/lows grab
    if (eqH && cur.h > eqH.price && cur.c < eqH.price) {
      signals.push({ id: 'liquidity_grab_eq_high', kind: 'liquidity_grab', side: 'SHORT', level: eqH.price, barIndex: last,
        reason: `Wick through equal highs ${eqH.price.toFixed(4)} (${eqH.members.length} touches), close back below` });
    }
    if (eqL && cur.l < eqL.price && cur.c > eqL.price) {
      signals.push({ id: 'liquidity_grab_eq_low', kind: 'liquidity_grab', side: 'LONG', level: eqL.price, barIndex: last,
        reason: `Wick through equal lows ${eqL.price.toFixed(4)} (${eqL.members.length} touches), close back above` });
    }

    // (b) Liquidity sweep: break beyond level then reclaim within N candles
    for (let breakI = Math.max(lookback, last - reclaimN); breakI < last; breakI++) {
      const b = candles[breakI];
      const ph = [...piv.highs].filter((p) => p.i < breakI).pop();
      const pl = [...piv.lows].filter((p) => p.i < breakI).pop();
      if (ph && b.h > ph.price && b.c > ph.price && cur.c < ph.price && last - breakI <= reclaimN) {
        signals.push({ id: 'liquidity_sweep_high', kind: 'liquidity_sweep', side: 'SHORT', level: ph.price, barIndex: last,
          reason: `Broke above swing high ${ph.price.toFixed(4)} at bar ${breakI}, reclaimed below within ${last - breakI} candles` });
        break;
      }
      if (pl && b.l < pl.price && b.c < pl.price && cur.c > pl.price && last - breakI <= reclaimN) {
        signals.push({ id: 'liquidity_sweep_low', kind: 'liquidity_sweep', side: 'LONG', level: pl.price, barIndex: last,
          reason: `Broke below swing low ${pl.price.toFixed(4)} at bar ${breakI}, reclaimed above within ${last - breakI} candles` });
        break;
      }
    }

    // (c) Buy-side liquidity taken: prior swing highs / equal highs taken out, close back below → bearish
    const buySideLevel = eqH ? eqH.price : (priorHigh ? priorHigh.price : null);
    if (buySideLevel != null && cur.h > buySideLevel && cur.c < buySideLevel) {
      // already covered by grab; tag specifically
      if (!signals.some((s) => s.id.startsWith('buy_side'))) {
        signals.push({ id: 'buy_side_liquidity_taken', kind: 'buy_side_liquidity_taken', side: 'SHORT', level: buySideLevel, barIndex: last,
          reason: `Buy-side liquidity (highs at ${buySideLevel.toFixed(4)}) taken; close back below → bearish` });
      }
    }

    // (d) Sell-side liquidity taken: prior swing lows / equal lows taken, close back above → bullish
    const sellSideLevel = eqL ? eqL.price : (priorLow ? priorLow.price : null);
    if (sellSideLevel != null && cur.l < sellSideLevel && cur.c > sellSideLevel) {
      if (!signals.some((s) => s.id.startsWith('sell_side'))) {
        signals.push({ id: 'sell_side_liquidity_taken', kind: 'sell_side_liquidity_taken', side: 'LONG', level: sellSideLevel, barIndex: last,
          reason: `Sell-side liquidity (lows at ${sellSideLevel.toFixed(4)}) taken; close back above → bullish` });
      }
    }

    // Dedupe by kind+side keeping first
    const seen = new Set(), uniq = [];
    for (const s of signals) { const k = s.kind + ':' + s.side; if (!seen.has(k)) { seen.add(k); uniq.push(s); } }
    return { signals: uniq, pivots: piv, equalHighs: eqHigh, equalLows: eqLow };
  }

  /** Direction vote from liquidity signals on the last bar. */
  function direction(rawCandles, opts) {
    const { signals } = detect(rawCandles, opts);
    const long = signals.filter((s) => s.side === 'LONG').length;
    const short = signals.filter((s) => s.side === 'SHORT').length;
    if (long > short) return { direction: 'LONG', signals, score: long };
    if (short > long) return { direction: 'SHORT', signals, score: short };
    return { direction: null, signals, score: 0 };
  }

  const api = { swings, equalCluster, detect, direction, DEFAULTS: { lookback: 5, tolPct: 0.0015, reclaimN: 3 } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LiquiditySignals = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
