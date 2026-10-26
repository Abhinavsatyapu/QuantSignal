(function (root) {
  function quoteOK(q, now, maxSpreadPct, maxAgeMs = 120000) {
    const age = now - Date.parse(q.quoteTime),
      mid = (q.bid + q.ask) / 2;
    return (
      q.multiplier === 100 &&
      q.bid > 0 &&
      q.ask >= q.bid &&
      Number.isFinite(q.bid) &&
      Number.isFinite(q.ask) &&
      Number.isFinite(age) &&
      age >= -1000 &&
      age <= maxAgeMs &&
      q.iv > 0 &&
      Number.isFinite(q.iv) &&
      ["delta", "gamma", "theta", "vega"].every((k) =>
        Number.isFinite(q.greeks?.[k]),
      ) &&
      Math.abs(q.greeks.delta) <= 1 &&
      q.greeks.gamma >= 0 &&
      q.greeks.vega >= 0 &&
      ((q.ask - q.bid) / mid) * 100 <= maxSpreadPct
    );
  }
  function pairs(quotes, type, direction, move, atr, strategy = "directional") {
    const highBuy =
        strategy === "condor" ? type === "call" : direction === "LONG",
      buyTarget =
        type === "call" ? (highBuy ? 0.15 : 0.5) : highBuy ? 0.5 : 0.15,
      sellTarget =
        type === "call" ? (highBuy ? 0.4 : 0.2) : highBuy ? 0.2 : 0.4,
      list = quotes.filter((q) => q.type === type),
      result = [];
    for (const buy of list)
      for (const sell of list) {
        const width = Math.abs(buy.strike - sell.strike);
        if (
          buy.symbol === sell.symbol ||
          (highBuy ? buy.strike <= sell.strike : buy.strike >= sell.strike) ||
          width < Math.max(0.2 * move, 1.5 * atr) ||
          width > 2 * move
        )
          continue;
        const execution = buy.ask - buy.bid + sell.ask - sell.bid,
          score =
            Math.abs(Math.abs(buy.greeks.delta) - buyTarget) +
            Math.abs(Math.abs(sell.greeks.delta) - sellTarget) +
            (Math.abs(width - 0.5 * move) / move) * 0.25 +
            execution / width;
        result.push({ buy, sell, score, width });
      }
    return result.sort((a, b) => a.score - b.score).slice(0, 6);
  }
  function leg(q, side, qty, spot) {
    return {
      symbol: q.underlying,
      type: q.type,
      expiry: q.expiry,
      strike: q.strike,
      side,
      qty,
      multiplier: 100,
      premium: side === "buy" ? q.ask : q.bid,
      iv: q.iv,
      spot,
      source: (q.provider || "Provider") + " " + (side === "buy" ? "ask" : "bid"),
      contract: q.symbol,
      quote: q,
    };
  }
  function optimize(input) {
    const {
      symbol,
      chain,
      analysis,
      meta,
      price,
      now = Date.now(),
      cfg,
    } = input;
    if (!["LONG", "SHORT"].includes(analysis.direction))
      throw Error("WAIT: no indicator-qualified candle setup");
    if (
      !meta ||
      meta.isDelisted ||
      meta.maxLeverage < 5 ||
      !Number.isInteger(meta.szDecimals)
    )
      throw Error(
        "Venue does not support the required 5× leverage / lot metadata",
      );
    const maxAge = Number.isFinite(cfg?.maxQuoteAgeMs) && cfg.maxQuoteAgeMs > 0 ? cfg.maxQuoteAgeMs : 120000;
    const stockAge = now - Date.parse(chain.stock?.time);
    if (
      !(chain.stock?.price > 0) ||
      !Number.isFinite(stockAge) ||
      stockAge > maxAge ||
      stockAge < -1000 ||
      !(price > 0)
    )
      throw Error("Fresh underlying stock and perp prices required");
    if (
      now - analysis.closedAt > input.duration * 1.2 ||
      analysis.closedAt >= now
    )
      throw Error("Completed candle is stale");
    if (
      ![
        cfg.equity,
        cfg.capital,
        cfg.riskPct,
        cfg.maxSpreadPct,
        cfg.commission,
        cfg.futureFeePct,
        cfg.slippagePct,
      ].every(Number.isFinite) ||
      cfg.equity <= 0 ||
      cfg.capital <= 0 ||
      cfg.capital > cfg.equity ||
      cfg.riskPct <= 0 ||
      cfg.riskPct > 5 ||
      !Number.isInteger(cfg.maxLots) ||
      cfg.maxLots < 1 ||
      cfg.maxLots > 20 ||
      cfg.maxSpreadPct <= 0 ||
      cfg.maxSpreadPct > 100 ||
      cfg.commission < 0 ||
      cfg.futureFeePct < 0 ||
      cfg.slippagePct < 0
    )
      throw Error("Invalid capital, risk, lots or execution-cost settings");
    if (
      (cfg.callLots != null &&
        (!Number.isInteger(cfg.callLots) ||
          cfg.callLots < 1 ||
          cfg.callLots > 20)) ||
      (cfg.putLots != null &&
        (!Number.isInteger(cfg.putLots) ||
          cfg.putLots < 1 ||
          cfg.putLots > 40)) ||
      (cfg.directionalPct != null &&
        (!Number.isFinite(cfg.directionalPct) ||
          cfg.directionalPct < 0 ||
          cfg.directionalPct > 100))
    )
      throw Error("Invalid fixed lots or directional increment");
    const S = chain.stock.price,
      underlying = symbol.split(":")[1],
      quotes = chain.contracts.filter(
        (q) =>
          q.underlying === underlying &&
          quoteOK(q, now, cfg.maxSpreadPct, maxAge),
      ),
      expiryGroups = [...new Set(quotes.map((q) => q.expiry))],
      candidates = [];
    const p = Paper.create();
    p.cash = cfg.equity;
    p.initial = cfg.equity;
    p.settings = {
      ...p.settings,
      riskPct: cfg.riskPct / 2,
      marginPct: (cfg.capital / cfg.equity) * 100,
      targetR: cfg.targetR ?? 2,
      minStopPct: cfg.minStopPct ?? 1.5,
      feePct: cfg.futureFeePct,
      slippagePct: cfg.slippagePct,
    };
    Paper.update(
      p,
      { [symbol]: { price, time: now } },
      [
        {
          symbol,
          interval: input.interval,
          duration: input.duration,
          analysis,
        },
      ],
      { [symbol]: { ...meta, usStock: true } },
      now,
      true,
    );
    const futureCap = p.positions[0];
    if (!futureCap)
      throw Error(
        "Futures entry fails retest, structure, 2R target, margin or risk gate",
      );
    for (const expiry of expiryGroups) {
      const days = (Finance.closeMs(expiry) - now) / 86400000;
      if (!(days > 0)) continue;
      const group = quotes.filter((q) => q.expiry === expiry),
        atm = group
          .slice()
          .sort((a, b) => Math.abs(a.strike - S) - Math.abs(b.strike - S))
          .slice(0, 4),
        atmIV = atm.reduce((n, q) => n + q.iv, 0) / atm.length,
        move = S * atmIV * Math.sqrt(days / 365);
      if (!(move > 0)) continue;
      const calls = pairs(
          group,
          "call",
          analysis.direction,
          move,
          analysis.atr,
          cfg.strategy,
        ),
        puts = pairs(
          group,
          "put",
          analysis.direction,
          move,
          analysis.atr,
          cfg.strategy,
        );
      for (const c of calls)
        for (const p of puts)
          for (
            let nc = cfg.callLots ?? 1;
            nc <= (cfg.callLots ?? cfg.maxLots);
            nc++
          )
            for (
              let np = cfg.putLots ?? 1;
              np <= (cfg.putLots ?? cfg.maxLots);
              np++
            ) {
              const legs = [
                  leg(c.buy, "buy", nc, S),
                  leg(c.sell, "sell", nc, S),
                  leg(p.sell, "sell", np, S),
                  leg(p.buy, "buy", np, S),
                ],
                optionDelta = legs.reduce(
                  (n, l) =>
                    n +
                    (l.side === "buy" ? 1 : -1) *
                      l.qty *
                      100 *
                      l.quote.greeks.delta,
                  0,
                ),
                step = 10 ** -meta.szDecimals,
                neutralSignedQty = -optionDelta,
                signedQty =
                  Math.round(
                    (neutralSignedQty * (1 + (cfg.directionalPct ?? 0) / 100)) /
                      step,
                  ) * step,
                qty = Math.abs(signedQty);
              if (
                cfg.strategy === "condor" &&
                (!(p.sell.strike < c.sell.strike) ||
                  Finance.premiumCash(legs, 0) <= 0)
              )
                continue;
              if (
                cfg.requireSizes &&
                legs.some(
                  (l) =>
                    !Number.isFinite(
                      l.side === "buy" ? l.quote.askSize : l.quote.bidSize,
                    ) ||
                    (l.side === "buy" ? l.quote.askSize : l.quote.bidSize) <
                      l.qty,
                )
              )
                continue;
              if (
                !(qty > 0 && qty <= futureCap.qty) ||
                (analysis.direction === "LONG"
                  ? signedQty <= 0
                  : signedQty >= 0)
              )
                continue;
              const payoff = Finance.exactExpiry(legs, cfg.commission),
                optionRisk =
                  payoff.maxLoss +
                  legs.reduce((n, l) => n + l.qty * cfg.commission, 0),
                futureRisk =
                  (futureCap.estimatedStopLoss * qty) / futureCap.qty,
                risk = optionRisk + futureRisk,
                budget = (cfg.equity * cfg.riskPct) / 100,
                margin = (qty * futureCap.entry) / 5,
                entryFees = (qty * futureCap.entry * cfg.futureFeePct) / 100;
              if (
                !Number.isFinite(optionRisk) ||
                risk > budget ||
                margin + optionRisk + entryFees > cfg.capital
              )
                continue;
              const entryFuture = { entry: futureCap.entry, qty: signedQty },
                basis = price - S,
                costs = {
                  commission: cfg.commission,
                  futureFeePct: cfg.futureFeePct,
                  mmLoss: 0,
                  funding: 0,
                },
                shocks = [Math.max(0, S - move), S, S + move],
                scenario = shocks.map((stock) => ({
                  stock,
                  perp: Math.max(0, stock + basis),
                  ...SheetMath.totals(
                    legs,
                    entryFuture,
                    stock,
                    Math.max(0, stock + basis),
                    costs,
                  ),
                })),
                friction =
                  legs.reduce(
                    (n, l) =>
                      n +
                      (l.quote.ask - l.quote.bid) * l.qty * 100 +
                      2 * cfg.commission * l.qty,
                    0,
                  ) +
                  2 * entryFees,
                netDelta = optionDelta + signedQty,
                score =
                  c.score +
                  p.score +
                  friction / budget +
                  Math.max(0, -Math.min(...scenario.map((x) => x.net))) /
                    budget +
                  (0.05 * risk) / budget +
                  Math.abs(netDelta) / Math.max(1, qty);
              const candidate = {
                symbol,
                expiry,
                legs,
                optionDelta,
                neutralFutureQty: Math.abs(neutralSignedQty),
                directionalIncrement: qty - Math.abs(neutralSignedQty),
                strategy: cfg.strategy ?? "directional",
                futureQty: qty,
                signedFutureQty: signedQty,
                netDelta,
                optionGamma: legs.reduce(
                  (n, l) =>
                    n +
                    (l.side === "buy" ? 1 : -1) *
                      l.qty *
                      100 *
                      l.quote.greeks.gamma,
                  0,
                ),
                optionTheta: legs.reduce(
                  (n, l) =>
                    n +
                    (l.side === "buy" ? 1 : -1) *
                      l.qty *
                      100 *
                      l.quote.greeks.theta,
                  0,
                ),
                optionVega: legs.reduce(
                  (n, l) =>
                    n +
                    (l.side === "buy" ? 1 : -1) *
                      l.qty *
                      100 *
                      l.quote.greeks.vega,
                  0,
                ),
                atmIV,
                expectedMove: move,
                days,
                optionRisk,
                futureRisk,
                plannedRisk: risk,
                margin,
                friction,
                score,
                scenario,
                stop: futureCap.stop,
                target: futureCap.target,
                netRR: futureCap.netRR,
                stock: S,
                stockTime: chain.stock.time,
                price,
                fetchedAt: now,
                analysis,
                meta,
                interval: input.interval,
                cfg: { ...cfg },
                chainPartial: !!chain.partial,
                explanation:
                  "6 best call pairs × 6 best put pairs × integer call/put lots searched; rank minimizes delta-band deviation, spread friction and worst endpoint loss within the current IV-implied move. This is a deterministic selection score, not expected return or win probability.",
              };
              candidates.push(candidate);
              candidates.sort((a, b) => a.score - b.score);
              if (candidates.length > 3) candidates.pop();
            }
    }
    if (!candidates.length)
      throw Error(
        "No fresh four-leg candidate fits Greek coverage, spread liquidity, ATR/IV width, integer lots, hedge direction and capital/risk constraints",
      );
    return candidates.sort((a, b) => a.score - b.score).slice(0, 3);
  }
  root.LiveHedge = { optimize, quoteOK };
})(globalThis);
