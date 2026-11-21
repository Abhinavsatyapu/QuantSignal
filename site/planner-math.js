// Structure Planner maths — shared by the page (window.PlannerMath) and the server (POST /api/payoff).
// Implements the method written on the Structure Planner print:
//   legs Black-Scholes at each leg's IV, rate 4 %; lot 100.
//   mark (dotted) = options marked to model on the date + held shares (core N + adjustment) × move from share entry
//                   + the ladder's inventory as rungs fill against the move (no round trips) − spread cost.
//   net at expiry = options at intrinsic + held shares + ladder inventory + the ladder's seed walked straight
//                   (sold up the rungs for a bullish ladder, bought back down for a bearish one) − spread cost.
//   1-day σ = spot × mean IV / √252.  Horizon σ for a date = mean IV × √(days/365) (min 1 day), lognormal band.
//   verdict: viable = spot in a profitable zone with ≥ 1 one-day σ of room both ways; tight = less on a side;
//            not viable = < 0.5 σ, or marked to lose at spot.
//   max loss (±Nσ) = worst mark (net of spread) for any price inside ±N horizon-σ on every date to expiry.
//   win rate = P(net at expiry > 0) under a lognormal at the legs' mean IV (risk-neutral drift at 4 %).
(function (root, factory) { if (typeof module === "object" && module.exports) module.exports = factory(); else root.PlannerMath = factory(); })(this, function () {
  "use strict";
  const R = 0.04, LOT = 100, DAY = 864e5;
  const pdf = x => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  function cdf(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; }

  // Black-Scholes price and greeks per share. theta per calendar day, vega and rho per 1 point.
  function bs(cp, S, K, T, iv, r = R) {
    const call = cp === "C";
    if (!(T > 0) || !(iv > 0)) { const v = call ? Math.max(S - K, 0) : Math.max(K - S, 0);
      return { price: v, delta: call ? (S > K ? 1 : 0) : (S < K ? -1 : 0), gamma: 0, theta: 0, vega: 0, rho: 0 }; }
    const sq = Math.sqrt(T), d1 = (Math.log(S / K) + (r + iv * iv / 2) * T) / (iv * sq), d2 = d1 - iv * sq, disc = Math.exp(-r * T);
    const price = call ? S * cdf(d1) - K * disc * cdf(d2) : K * disc * cdf(-d2) - S * cdf(-d1);
    const theta = (-S * pdf(d1) * iv / (2 * sq) - (call ? 1 : -1) * r * K * disc * cdf(call ? d2 : -d2)) / 365;
    return { price, delta: call ? cdf(d1) : cdf(d1) - 1, gamma: pdf(d1) / (S * iv * sq), theta, vega: S * pdf(d1) * sq / 100,
             rho: (call ? 1 : -1) * K * T * disc * cdf(call ? d2 : -d2) / 100 };
  }
  // implied vol from a price (bisection), for legs priced by hand without an IV
  function impliedVol(price, cp, S, K, T) {
    if (!(price > 0) || !(T > 0)) return null; let lo = 0.01, hi = 5;
    for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; bs(cp, S, K, T, m).price > price ? (hi = m) : (lo = m); } return (lo + hi) / 2;
  }

  // ---- ladder (grid) walked straight from the entry to P ----
  function rungs(g, E) { const out = []; for (let k = 1; k <= g.rungs; k++) out.push(E + (g.direction === "bearish" ? 1 : -1) * k * g.spacing); return out; }
  function ladder(g, E, P) {                 // inventory the ladder builds against the move (no round trips)
    if (!g || !g.launch || !(g.rungs > 0) || !(g.qty > 0) || !(g.spacing > 0)) return { shares: 0, pnl: 0 };
    let shares = 0, pnl = 0;
    for (const r of rungs(g, E)) {
      if (g.direction === "bearish" ? P >= r - 1e-9 : P <= r + 1e-9) { const q = g.direction === "bearish" ? -g.qty : g.qty; shares += q; pnl += q * (P - r); }
    }
    return { shares, pnl };
  }
  function seed(g, E, P) {                   // the ladder's starting inventory, unwound up (bullish) or down (bearish) the rungs
    if (!g || !g.launch || !(g.rungs > 0) || !(g.qty > 0) || !(g.spacing > 0)) return { shares: 0, pnl: 0 };
    const bull = g.direction !== "bearish", n = g.rungs * g.qty; let left = n, pnl = 0;
    for (let k = 1; k <= g.rungs; k++) { const r = E + (bull ? 1 : -1) * k * g.spacing;
      if (bull ? P >= r - 1e-9 : P <= r + 1e-9) { left -= g.qty; pnl += g.qty * (bull ? r - E : E - r); } }
    pnl += left * (bull ? P - E : E - P);
    return { shares: bull ? left : -left, pnl };
  }

  // ---- model ----
  // input: { spot, legs:[{cp:"C"|"P", K, exp:"YYYY-MM-DD", side:1|-1, size, price, iv, bid, ask}], today:"YYYY-MM-DD",
  //          grid:{launch, direction, spacing, target, rungs, qty, coreN, adj, entry, targetNet, band, spread} }
  const dayDiff = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / DAY);
  const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * DAY).toISOString().slice(0, 10);
  function build(input) {
    const S = +input.spot, g = Object.assign({ launch: false, direction: "bullish", spacing: 1, target: 1, rungs: 10, qty: 10, coreN: 0, adj: 0, entry: null, targetNet: 0, band: 2, spread: true }, input.grid || {});
    const E = g.entry > 0 ? +g.entry : S, today = input.today;
    const legs = (input.legs || []).filter(l => l && l.K > 0 && l.size > 0 && l.exp).map(l => ({ ...l, K: +l.K, size: +l.size, price: +l.price || 0, side: +l.side >= 0 ? 1 : -1, iv: +l.iv > 0 ? +l.iv : null }));
    const expiry = legs.length ? legs.map(l => l.exp).sort().at(-1) : today;
    for (const l of legs) if (!l.iv) l.iv = impliedVol(l.price, l.cp, S, l.K, Math.max(dayDiff(today, l.exp), 1) / 365) || 0.5;
    const meanIv = legs.length ? legs.reduce((s, l) => s + l.iv, 0) / legs.length : 0.3;
    const spreadCost = g.spread ? legs.reduce((s, l) => s + (l.bid > 0 && l.ask >= l.bid ? (l.ask - l.bid) * l.size * LOT : 0), 0) : 0;
    const netCost = legs.reduce((s, l) => s + l.side * l.size * l.price * LOT, 0);
    const held = (+g.coreN || 0) + (+g.adj || 0);
    const T = (l, d) => Math.max(dayDiff(d, l.exp), 0) / 365;
    const optAt = (P, d) => legs.reduce((s, l) => s + l.side * l.size * LOT * (bs(l.cp, P, l.K, T(l, d), l.iv).price - l.price), 0);
    const optExp = P => legs.reduce((s, l) => s + l.side * l.size * LOT * (bs(l.cp, P, l.K, 0, l.iv).price - l.price), 0);
    const parts = (P, d) => { const o = optAt(P, d), core = (+g.coreN || 0) * (P - E), adj = (+g.adj || 0) * (P - E), lad = ladder(g, E, P);
      return { price: P, options: o, core, optHedge: o + core, grid: lad.pnl, adj, spread: -spreadCost, net: o + core + adj + lad.pnl - spreadCost, shares: lad.shares }; };
    const mark = (P, d) => parts(P, d).net;
    const atExpiry = P => optExp(P) + held * (P - E) + ladder(g, E, P).pnl + seed(g, E, P).pnl - spreadCost;
    const sigma1 = S * meanIv / Math.sqrt(252);
    const hσ = d => meanIv * Math.sqrt(Math.max(dayDiff(today, d), 1) / 365);
    const bandOf = (d, n) => [S * Math.exp(-n * hσ(d)), S * Math.exp(n * hσ(d))];
    // dates: today, every weekday after it, and the expiry
    const dates = [today]; for (let d = addDays(today, 1); d <= expiry; d = addDays(d, 1)) { const w = new Date(d + "T12:00:00Z").getUTCDay(); if (w !== 0 && w !== 6 || d === expiry) dates.push(d); }
    const [lo, hi] = bandOf(expiry, 2.6), N = 400, xs = Array.from({ length: N + 1 }, (_, i) => lo + (hi - lo) * i / N);
    function zones(f) {                       // profitable zones of f over the chart range
      const out = []; let start = null;
      for (let i = 0; i <= N; i++) { const x = xs[i], v = f(x);
        if (v > 0 && start == null) start = i === 0 ? -Infinity : root(f, xs[i - 1], x);
        if (v <= 0 && start != null) { out.push([start, root(f, xs[i - 1], x)]); start = null; } }
      if (start != null) out.push([start, Infinity]); return out;
    }
    function root(f, a, b) { let fa = f(a); for (let i = 0; i < 50; i++) { const m = (a + b) / 2, fm = f(m); if (Math.sign(fm) === Math.sign(fa)) { a = m; fa = fm; } else b = m; } return (a + b) / 2; }
    function extreme(f, a, b, max) { let best = null; for (let i = 0; i <= 240; i++) { const x = a + (b - a) * i / 240, v = f(x); if (!best || (max ? v > best.v + 0.005 : v < best.v - 0.005)) best = { x, v }; } return best; }
    const rows = dates.map(d => {
      const f = P => mark(P, d), z = zones(f), here = z.find(([a, b]) => S > a && S < b), m = f(S);
      const [bl, bh] = bandOf(d, g.band), worst = extreme(f, bl, bh, false), best = extreme(f, ...bandOf(expiry, g.band), true);
      let tgt = null; if (g.targetNet > 0) { const above = xs.find(x => x >= S && f(x) >= g.targetNet), below = [...xs].reverse().find(x => x <= S && f(x) >= g.targetNet); tgt = above != null ? root(P => f(P) - g.targetNet, Math.max(S, above - (hi - lo) / N), above) : below != null ? root(P => f(P) - g.targetNet, below, Math.min(S, below + (hi - lo) / N)) : null; }
      return { date: d, dte: dayDiff(d, expiry), markAtSpot: m, perShare: (f(S + 0.01) - f(S - 0.01)) / 0.02, zones: z, profitableAtSpot: !!here,
        bleedsBelow: here && Number.isFinite(here[0]) ? here[0] : null, bleedsAbove: here && Number.isFinite(here[1]) ? here[1] : null,
        roomDown: here ? (Number.isFinite(here[0]) ? (S - here[0]) / sigma1 : Infinity) : null, roomUp: here ? (Number.isFinite(here[1]) ? (here[1] - S) / sigma1 : Infinity) : null,
        targetAt: tgt, best, worst };
    });
    // max loss across every date inside ±Nσ, with the slope past the band
    let ml = null, up = null, down = null;
    for (const r of rows) { const f = P => mark(P, r.date), [bl, bh] = bandOf(r.date, g.band);
      const w = r.worst; if (!ml || w.v < ml.v) ml = { ...w, date: r.date, edge: w.x <= S ? "down" : "up" };
      const wu = extreme(f, S, bh, false), wd = extreme(f, bl, S, false); if (!up || wu.v < up.v) up = wu; if (!down || wd.v < down.v) down = wd; }
    const slope = ml ? (ml.edge === "down" ? mark(ml.x - 1, ml.date) - mark(ml.x, ml.date) : mark(ml.x + 1, ml.date) - mark(ml.x, ml.date)) : 0;
    // max profit, breakevens and win rate from the expiry curve
    const wide = [S * 0.2, S * 3], maxP = extreme(atExpiry, wide[0], wide[1], true), be = [];
    for (let i = 1; i <= 600; i++) { const a = wide[0] + (wide[1] - wide[0]) * (i - 1) / 600, b = wide[0] + (wide[1] - wide[0]) * i / 600; if (Math.sign(atExpiry(a)) !== Math.sign(atExpiry(b))) be.push(root(atExpiry, a, b)); }
    const Te = Math.max(dayDiff(today, expiry), 1) / 365, sd = meanIv * Math.sqrt(Te);
    const pAbove = x => x <= 0 ? 1 : !Number.isFinite(x) ? 0 : cdf((Math.log(S / x) + (R - meanIv * meanIv / 2) * Te) / sd);
    const ez = [], cuts = [wide[0] * 0.01, ...be, wide[1] * 100];          // profit zones at expiry between breakevens
    for (let i = 0; i + 1 < cuts.length; i++) { const mid = (cuts[i] + cuts[i + 1]) / 2; if (atExpiry(mid) > 0) ez.push([i === 0 ? 0 : cuts[i], i + 2 === cuts.length ? Infinity : cuts[i + 1]]); }
    const win = ez.reduce((s, [a, b]) => s + pAbove(a) - pAbove(b), 0);
    const greeks = legs.reduce((a, l) => { const x = bs(l.cp, S, l.K, T(l, today), l.iv), k = l.side * l.size * LOT;
      a.delta += k * x.delta; a.gamma += k * x.gamma; a.theta += k * x.theta; a.vega += k * x.vega; a.rho += k * x.rho; return a; }, { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 });
    const seedShares = g.launch ? (g.direction === "bearish" ? -1 : 1) * g.rungs * g.qty : 0;
    // verdict from today's mark
    const t0 = rows[0], room = t0.profitableAtSpot ? Math.min(t0.roomDown, t0.roomUp) : null;
    const nextUp = t0.zones.find(([a]) => a > S), nextDown = [...t0.zones].reverse().find(([, b]) => b < S);
    const verdict = !legs.length ? { level: "red", text: "Add legs to plan a position" }
      : !t0.profitableAtSpot ? { level: "red", text: nextUp && (!nextDown || nextUp[0] - S <= S - nextDown[1]) ? `Viable only if spot > ${nextUp[0].toFixed(2)}` : nextDown ? `Viable only if spot < ${nextDown[1].toFixed(2)}` : "Not viable — no profitable zone in range" }
      : room >= 1 ? { level: "green", text: `Viable — ${fmtRoom(t0.roomDown)} room down, ${fmtRoom(t0.roomUp)} up` }
      : room >= 0.5 ? { level: "amber", text: `Tight — ${fmtRoom(t0.roomDown)} down, ${fmtRoom(t0.roomUp)} up` } : { level: "red", text: `Not viable — under 0.5σ of room (${fmtRoom(Math.min(t0.roomDown, t0.roomUp))})` };
    return { spot: S, entry: E, today, expiry, meanIv, sigma1, netCost, spreadCost, held, seedShares, legs, grid: g, dates, rows, verdict,
      maxLoss: ml && { value: ml.v, price: ml.x, date: ml.date, pct: (ml.x / S - 1) * 100, perDollar: slope, up: { value: up.v, price: up.x, pct: (up.x / S - 1) * 100 }, down: { value: down.v, price: down.x, pct: (down.x / S - 1) * 100 } },
      maxProfit: maxP.v, maxProfitGross: maxP.v + spreadCost, breakevens: be, winRate: win, greeks, netDelta: greeks.delta + seedShares + held,
      now: t0.markAtSpot, range: [lo, hi], parts, mark, atExpiry, optExp, bandOf,
      gridLine: P => ladder(g, E, P).pnl + seed(g, E, P).pnl, adjLine: P => (+g.adj || 0) * (P - E), seed: P => seed(g, E, P), ladder: P => ladder(g, E, P) };
  }
  function fmtRoom(v) { return v == null ? "—" : v === Infinity ? "open" : v.toFixed(1) + "σ"; }
  // price-movement table for a date
  function moves(m, d) {
    const h = m.bandOf(d, 1), s1 = Math.log(h[1] / m.spot);
    const pts = [[-10, "-10.0 %"], [-7.5, "-7.5 %"], [-5, "-5.0 %"], [-3, "-3.0 %"], [-2, "-2.0 %"], [-1, "-1.0 %"], [0, "spot"], [1, "+1.0 %"], [2, "+2.0 %"], [3, "+3.0 %"], [5, "+5.0 %"], [7.5, "+7.5 %"], [10, "+10.0 %"]]
      .map(([p, l]) => ({ label: l, P: m.spot * (1 + p / 100), spot: p === 0 }));
    for (const k of [-2, -1, 1, 2]) { const P = m.spot * Math.exp(k * s1); pts.push({ label: `${k > 0 ? "+" : "−"}${Math.abs(k)}σ (${(P / m.spot - 1) * 100 > 0 ? "+" : ""}${((P / m.spot - 1) * 100).toFixed(1)}%)`, P, sigma: true }); }
    return pts.sort((a, b) => a.P - b.P).map(x => ({ ...x, ...m.parts(x.P, d) }));
  }
  // name the structure from its legs
  function name(legs) {
    const out = [], by = cp => legs.filter(l => l.cp === cp).sort((a, b) => a.K - b.K);
    for (const cp of ["P", "C"]) { const L = by(cp), word = cp === "P" ? "put" : "call";
      if (L.length === 2 && L[0].side !== L[1].side) { const lowLong = L[0].side > 0;
        out.push(`${word} ${cp === "P" ? (lowLong ? "credit" : "debit") : (lowLong ? "debit" : "credit")} spread`); }
      else for (const l of L) out.push(`${l.side > 0 ? "long" : "short"} ${word}`); }
    return out.join(" + ") || "no legs";
  }
  // plain JSON summary (POST /api/payoff)
  function summary(input) {
    const m = build(input);
    return { spot: m.spot, expiry: m.expiry, verdict: m.verdict, netCost: m.netCost, spreadCost: m.spreadCost, maxLoss: m.maxLoss, maxProfit: m.maxProfit,
      breakevens: m.breakevens, winRate: m.winRate, greeks: m.greeks, netDelta: m.netDelta, sigma1: m.sigma1, meanIv: m.meanIv, now: m.now, structure: name(m.legs),
      byDate: m.rows.map(r => ({ date: r.date, dte: r.dte, markAtSpot: r.markAtSpot, perShare: r.perShare, zones: r.zones.map(z => z.map(v => Number.isFinite(v) ? v : null)),
        bleedsBelow: r.bleedsBelow, bleedsAbove: r.bleedsAbove, targetAt: r.targetAt, best: r.best, worst: r.worst })),
      moves: moves(m, m.today).map(({ label, price, options, core, optHedge, grid, adj, spread, net, shares }) => ({ label, price, options, core, optHedge, grid, adj, spread, net, shares })) };
  }
  return { bs, impliedVol, build, moves, name, summary, fmtRoom, dayDiff, addDays, ladder, seed, R, LOT };
});
