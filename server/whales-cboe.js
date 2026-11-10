'use strict';

function parseOcc(sym) {
  const s = String(sym || '');
  for (let i = 1; i <= 6; i++) {
    const rest = s.slice(i);
    if (rest.length >= 15 && /^\d{6}[CP]\d+$/.test(rest)) {
      const yy = Number(rest.slice(0, 2)), mm = Number(rest.slice(2, 4)), dd = Number(rest.slice(4, 6));
      const exp = new Date(Date.UTC(2000 + yy, mm - 1, dd));
      if (Number.isNaN(exp.getTime()) || exp.getUTCMonth() !== mm - 1) return null;
      return { root: s.slice(0, i), expiry: exp.toISOString().slice(0, 10), cp: rest[6], strike: Number(rest.slice(7)) / 1000 };
    }
  }
  return null;
}

function unusualFromChain(payload, asofDate) {
  const data = (payload && payload.data) || {};
  const und = {
    symbol: data.symbol, current_price: data.current_price, price_change: data.price_change,
    price_change_percent: data.price_change_percent, volume: data.volume, iv30: data.iv30,
    bid: data.bid, ask: data.ask, last_trade_time: data.last_trade_time,
  };
  const asof = asofDate instanceof Date ? asofDate : new Date(asofDate);
  const asofStr = asof.toISOString().slice(0, 10);
  const rows = [];
  let live = 0;
  for (const o of data.options || []) {
    const meta = parseOcc(o.option || '');
    if (!meta) continue;
    if (meta.expiry < asofStr) continue;
    live += 1;
    const vol = Number(o.volume || 0);
    const oi = Number(o.open_interest || 0);
    const bid = Number(o.bid || 0), ask = Number(o.ask || 0);
    const mid = (bid || ask) ? (bid + ask) / 2 : Number(o.last_trade_price || 0);
    const prem = vol * mid * 100;
    const ratio = oi ? (vol / oi) : (vol ? Infinity : 0);
    if (vol >= 200 && (ratio >= 1.5 || prem >= 250000)) {
      rows.push({
        ...meta, contract: o.option, volume: vol, openInterest: oi,
        volumeToOi: ratio === Infinity ? null : Math.round(ratio * 100) / 100,
        mid: Math.round(mid * 10000) / 10000, premiumUsd: Math.round(prem * 100) / 100,
        delta: o.delta, iv: o.iv,
      });
    }
  }
  rows.sort((a, b) => b.premiumUsd - a.premiumUsd);
  return {
    timestamp: payload && payload.timestamp,
    underlying: und,
    liveContracts: live,
    unusualCount: rows.length,
    unusualTop: rows.slice(0, 15),
    definition: 'Unexpired; volume ≥ 200 and (volume/OI ≥ 1.5 or premium ≥ $250k). Delayed snapshot, not a sweep tape.',
  };
}

module.exports = { parseOcc, unusualFromChain };
