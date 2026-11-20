// Backend risk engine. Pure function: given the order, the account, positions, open orders, clock and limits, return
// { ok, blocks[], warnings[], metrics }. Runs at proposal AND again at approval, immediately before the broker call.
"use strict";

const DEFAULT_LIMITS = {
  killSwitch: false,
  maxOrderNotional: 10000,          // $ per order
  maxPositionNotional: 20000,       // $ per symbol after this order
  maxGrossExposureX: 1.0,           // gross position value ≤ X × equity
  maxOpenPositions: 10,
  maxRiskPerTradePct: 1.0,          // (entry − stop) × qty ≤ % of equity
  requireStopOnOpen: true,
  maxDailyLossPct: 3.0,             // vs previous close equity
  maxDrawdownPct: 10.0,             // vs peak equity seen by the OMS
  allowShort: false,
  allowExtendedHours: true,         // extended hours: limit + DAY only (broker rule)
  regularSessionOnlyForMarket: true,
  feeSecPerMillion: 27.8,           // SEC Section 31 fee on sells ($ per $1M) — estimate; rate changes
  feeTafPerShare: 0.000166, feeTafMax: 8.30,
};

const n = v => (v === null || v === undefined || v === "" ? null : Number(v));

function estimateFees(side, qty, price, L = DEFAULT_LIMITS) {
  if (side !== "sell" || !(price > 0)) return 0;
  const sec = qty * price * L.feeSecPerMillion / 1e6, taf = Math.min(qty * L.feeTafPerShare, L.feeTafMax);
  return Math.round((sec + taf) * 100) / 100;
}

function check({ order, refPrice, account, positions, openOrders, clock, limits, peakEquity }) {
  const L = { ...DEFAULT_LIMITS, ...(limits || {}) }, blocks = [], warnings = [];
  const qty = n(order.qty), side = order.side, sym = String(order.symbol || "").toUpperCase();
  const equity = n(account && account.equity), lastEquity = n(account && account.last_equity);
  const pos = (positions || []).find(p => p.symbol === sym), posQty = pos ? n(pos.qty) : 0;   // signed (short < 0)
  const closing = posQty !== 0 && ((posQty > 0 && side === "sell") || (posQty < 0 && side === "buy"));
  const intent = order.intent === "close" || (closing && qty <= Math.abs(posQty)) ? "close" : "open";
  const entry = n(order.limit_price) || n(order.stop_price) || n(refPrice);
  const notional = entry ? qty * entry : null;

  if (L.killSwitch) blocks.push("Kill switch is ON — no new orders");
  if (!(qty > 0)) blocks.push("Quantity must be greater than 0");
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(sym)) blocks.push("Invalid symbol");
  if (!entry) blocks.push("No reference price for the order (give a limit price or wait for a live quote)");
  if (account && account.trading_blocked) blocks.push("Broker reports trading is blocked on this account");
  if (account && account.account_blocked) blocks.push("Broker reports the account is blocked");

  // session rules
  if (clock) {
    if (!clock.is_open) {
      if (order.type === "market" && L.regularSessionOnlyForMarket) blocks.push("Market orders are only allowed in the regular session");
      if (order.extended_hours && !(order.type === "limit" && order.tif === "day")) blocks.push("Outside regular hours only DAY limit orders with extended hours are allowed");
      if (order.extended_hours && !L.allowExtendedHours) blocks.push("Extended-hours trading is disabled in risk settings");
      if (!order.extended_hours && order.type !== "market") warnings.push("Market is closed: the order will wait for the next session");
    }
  }
  if (order.type === "limit" && !n(order.limit_price)) blocks.push("Limit orders need a limit price");
  if ((order.type === "stop" || order.type === "stop_limit") && !n(order.stop_price)) blocks.push("Stop orders need a stop price");
  if (order.type === "stop_limit" && !n(order.limit_price)) blocks.push("Stop-limit orders need a limit price");

  // account health — these block new risk, never closing orders
  let dailyPnlPct = null, ddPct = null;
  if (equity && lastEquity) dailyPnlPct = (equity / lastEquity - 1) * 100;
  if (equity && peakEquity) ddPct = (1 - equity / Math.max(peakEquity, equity)) * 100;
  if (intent === "open") {
    if (dailyPnlPct !== null && dailyPnlPct <= -L.maxDailyLossPct) blocks.push(`Daily loss limit hit (${dailyPnlPct.toFixed(2)}% ≤ −${L.maxDailyLossPct}%)`);
    if (ddPct !== null && ddPct >= L.maxDrawdownPct) blocks.push(`Max drawdown hit (${ddPct.toFixed(2)}% ≥ ${L.maxDrawdownPct}%)`);
    if (side === "sell" && posQty <= 0 && !L.allowShort) blocks.push("Short selling is disabled in risk settings");
    if (notional && notional > L.maxOrderNotional) blocks.push(`Order value $${notional.toFixed(0)} is above the $${L.maxOrderNotional} limit`);
    const newPosValue = Math.abs((posQty + (side === "buy" ? qty : -qty)) * (entry || 0));
    if (entry && newPosValue > L.maxPositionNotional) blocks.push(`Position in ${sym} would be $${newPosValue.toFixed(0)}, above the $${L.maxPositionNotional} limit`);
    const gross = (positions || []).reduce((s, p) => s + Math.abs(n(p.market_value) || 0), 0) + (notional || 0);
    if (equity && gross > L.maxGrossExposureX * equity) blocks.push(`Gross exposure would be ${(gross / equity).toFixed(2)}× equity, above ${L.maxGrossExposureX}×`);
    const openSyms = new Set((positions || []).filter(p => n(p.qty) !== 0).map(p => p.symbol));
    if (!openSyms.has(sym) && openSyms.size >= L.maxOpenPositions) blocks.push(`Already ${openSyms.size} open positions (limit ${L.maxOpenPositions})`);
    // stop-loss validation + per-trade risk
    const stop = n(order.stop_loss);
    if (!stop && L.requireStopOnOpen) blocks.push("A stop-loss is required on opening orders");
    if (stop && entry) {
      if (side === "buy" && stop >= entry) blocks.push("Stop-loss must be below the entry for a buy");
      if (side === "sell" && stop <= entry) blocks.push("Stop-loss must be above the entry for a short");
      const risk = Math.abs(entry - stop) * qty;
      if (equity && risk > equity * L.maxRiskPerTradePct / 100) blocks.push(`Risk to stop $${risk.toFixed(0)} is above ${L.maxRiskPerTradePct}% of equity ($${(equity * L.maxRiskPerTradePct / 100).toFixed(0)})`);
    }
    const tp = n(order.take_profit);
    if (tp && entry && ((side === "buy" && tp <= entry) || (side === "sell" && tp >= entry))) blocks.push("Take-profit is on the wrong side of the entry");
  }
  // duplicate protection: another live order for the same symbol and side
  const dup = (openOrders || []).find(o => o.symbol === sym && o.side === side && o.id !== order.id);
  if (dup) blocks.push(`Duplicate: an open ${side} order for ${sym} already exists (${String(dup.id).slice(0, 8)})`);
  if (closing && qty > Math.abs(posQty)) warnings.push("Quantity is larger than the position: the excess would open a new position");

  return { ok: blocks.length === 0, blocks, warnings, metrics: { intent, entry, notional, equity, dailyPnlPct, ddPct, posQty,
    riskToStop: n(order.stop_loss) && entry ? Math.abs(entry - n(order.stop_loss)) * qty : null, estFees: estimateFees(side, qty, entry || 0, L) } };
}
module.exports = { check, estimateFees, DEFAULT_LIMITS };
