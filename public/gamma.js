const GAMMA_KEY = "quantsignal.gamma.v1";
let gammaState = { ledger: Paper.create(), books: [], auto: false },
  gammaDraft = [],
  gammaReviewData = null,
  gammaBusy = false,
  gammaNext = 0;
try {
  const saved = JSON.parse(localStorage.getItem(GAMMA_KEY) || "null");
  if (saved?.ledger?.initial === 100000 && Array.isArray(saved.books))
    gammaState = saved;
} catch {}
gammaState.auto = false;
$("#gammaExpiry").value = futureFriday(14);
function gammaSave() {
  try {
    localStorage.setItem(GAMMA_KEY, JSON.stringify(gammaState));
  } catch {
    $("#gammaStatus").textContent +=
      " · Ledger could not be saved in this browser.";
  }
}
function gammaFresh(q, now = Date.now()) {
  return (
    q &&
    Number.isFinite(q.bid) &&
    q.bid >= 0 &&
    Number.isFinite(q.ask) &&
    q.ask > 0 &&
    q.ask >= q.bid &&
    q.quoteTime &&
    now - Date.parse(q.quoteTime) <= Deriv.maxQuoteAgeMs() &&
    Date.parse(q.quoteTime) <= now + 1000 &&
    Number.isFinite(q.greeks?.delta) &&
    Number.isFinite(q.greeks?.gamma) &&
    q.iv > 0
  );
}
async function gammaApi(body) {
  // Options data comes from this server (Alpaca keys are server-side only).
  if (!(await Deriv.dataReady()))
    throw Error(
      "Options data is not configured on the server (ALPACA_KEY_ID / ALPACA_SECRET_KEY). See Options Studio → Options data.",
    );
  const data = await streamJson("/api/options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (data.feed) optionState.feed = data.feed;
  return data;
}
function gammaLeg(q, side, qty, spot) {
  return {
    symbol: q.underlying,
    side,
    type: q.type,
    expiry: q.expiry,
    strike: q.strike,
    qty,
    multiplier: 100,
    premium: side === "buy" ? q.ask : q.bid,
    iv: q.iv,
    spot,
    source: (q.provider || "Provider") + " " + (side === "buy" ? "ask" : "bid") + (Deriv.isStale(q) ? " · STALE" : ""),
    contract: q.symbol,
    quote: q,
  };
}
function gammaPairSelect(available, type, buyTarget, sellTarget, highBuy) {
  const list = available.filter((q) => q.type === type);
  let best = null,
    cost = Infinity;
  for (const buy of list)
    for (const sell of list) {
      if (
        buy.symbol === sell.symbol ||
        (highBuy ? buy.strike <= sell.strike : buy.strike >= sell.strike)
      )
        continue;
      const d =
        Math.abs(buy.strike - buyTarget) + Math.abs(sell.strike - sellTarget);
      if (d < cost) {
        cost = d;
        best = [buy, sell];
      }
    }
  if (!best)
    throw Error(
      "No two distinct listed strikes preserve the " +
        type +
        " spread direction.",
    );
  return best;
}
function gammaSelect(contracts, symbol, expiry, S, direction, lots, width) {
  const available = contracts.filter(
      (q) => q.underlying === symbol && q.expiry === expiry && gammaFresh(q),
    ),
    long = direction === "LONG",
    calls = gammaPairSelect(
      available,
      "call",
      long ? S + 2 * width : S,
      long ? S + width : S + width,
      long,
    ),
    puts = gammaPairSelect(
      available,
      "put",
      long ? S : S - 2 * width,
      long ? S - width : S - width,
      long,
    );
  return [
    gammaLeg(calls[0], "buy", lots, S),
    gammaLeg(calls[1], "sell", lots, S),
    gammaLeg(puts[0], "buy", lots, S),
    gammaLeg(puts[1], "sell", lots, S),
  ];
}
function gammaRisk(legs) {
  if (
    legs.length !== 4 ||
    new Set(legs.map((l) => l.symbol)).size !== 1 ||
    new Set(legs.map((l) => l.expiry)).size !== 1 ||
    legs.some((l) => !Number.isInteger(l.qty) || l.qty < 1)
  )
    throw Error(
      "Use four same-stock, same-expiry legs with positive whole lots.",
    );
  for (const type of ["call", "put"]) {
    const pair = legs.filter((l) => l.type === type);
    if (
      pair.length !== 2 ||
      !pair.some((l) => l.side === "buy") ||
      !pair.some((l) => l.side === "sell") ||
      pair[0].qty !== pair[1].qty ||
      pair[0].strike === pair[1].strike
    )
      throw Error(
        "Each call/put pair requires one long and one short at distinct strikes with equal lots. Unequal lots are scenario-only.",
      );
  }
  const payoff = Finance.exactExpiry(Finance.validateLegs(legs), 0.65);
  if (!payoff || !Number.isFinite(payoff.maxLoss))
    throw Error("Unbounded option risk is not accepted.");
  return (
    Math.max(0, payoff.maxLoss) + legs.reduce((n, l) => n + l.qty * 0.65, 0)
  );
}
function gammaDraftRender() {
  const fields = ["strike", "qty", "premium"];
  $("#gammaDraft").innerHTML = gammaDraft
    .map(
      (l, i) =>
        `<tr><td>${l.side === "buy" ? "LONG" : "SHORT"} ${l.type.toUpperCase()}</td><td><input data-g="${i}" data-f="strike" type="number" value="${l.strike}" step="any"><small>${l.expiry}</small></td><td><input data-g="${i}" data-f="qty" type="number" value="${l.qty}" min="1" step="1"></td><td><input data-g="${i}" data-f="premium" type="number" value="${Number.isFinite(l.premium) ? l.premium : ""}" min="0" step="any"></td><td>${quotePrice(l.quote?.bid)} / ${quotePrice(l.quote?.ask)}</td><td>${l.quote?.greeks?.delta?.toFixed(3) || "—"} / ${l.quote?.greeks?.gamma?.toFixed(4) || "—"} / ${l.iv > 0 ? (l.iv * 100).toFixed(1) + "%" : "—"}</td><td>${escapeHtml(l.source)}<small>${l.quote?.quoteTime ? new Date(l.quote.quoteTime).toLocaleString() : "unavailable"}</small></td></tr>`,
    )
    .join("");
  $("#gammaDraft")
    .querySelectorAll("[data-f]")
    .forEach(
      (el) =>
        (el.onchange = () => {
          const l = gammaDraft[Number(el.dataset.g)];
          l[el.dataset.f] = Number(el.value);
          l.source = "Manual analysis override · not an executable quote";
          if (el.dataset.f === "strike") {
            l.contract = occForLeg(l);
            l.quote = null;
            l.iv = NaN;
          }
          gammaDraftRender();
          gammaSimulation();
        }),
    );
  gammaSimulation();
}
function gammaSimulation() {
  try {
    if (!gammaDraft.length) return;
    const shock = Number($("#gammaShock").value),
      options = Finance.pnl(
        Finance.validateLegs(gammaDraft),
        { timeMillis: Date.now(), shock, ivShift: 0, rate: 4, dividend: 0 },
        0.65,
      ),
      p = gammaReviewData?.future,
      futures = p
        ? (p.direction === "LONG" ? 1 : -1) *
            (gammaReviewData.price * (1 + shock / 100) - p.entry) *
            p.qty -
          p.entryFee
        : 0;
    $("#gammaSimulation").textContent =
      "Analysis only · theoretical options " +
      money(options) +
      " · futures " +
      money(futures) +
      " · combined " +
      money(options + futures) +
      ". Manual premiums are never used by automatic entry.";
  } catch (e) {
    $("#gammaSimulation").textContent = "Simulation unavailable: " + e.message;
  }
}
async function gammaEvaluate(rebuild = true) {
  const symbol = $("#gammaSymbol").value.trim(),
    expiry = $("#gammaExpiry").value,
    interval = paperState.settings.timeframe,
    lots = Number($("#gammaLots").value),
    putLots = Number($("#gammaPutLots").value || lots),
    riskPct = Number($("#gammaRisk").value);
  if (
    !Number.isInteger(lots) ||
    lots < 1 ||
    lots > 100 ||
    !Number.isInteger(putLots) ||
    putLots < 1 ||
    putLots > 100 ||
    !(riskPct >= 0.1 && riskPct <= 5)
  )
    throw Error("Use 1–100 whole option lots and combined risk of 0.1–5%.");
  if (!expiry || expiry <= isoDay(new Date()))
    throw Error("Choose an unexpired option date.");
  if (gammaState.books.some((b) => !b.closed && b.future.symbol === symbol))
    throw Error(
      "An existing paired book or pending option exit already uses this stock.",
    );
  const directory = await streamJson("/api/stream/universe?scope=stocks");
  if (!directory.symbols.includes(symbol))
    throw Error("Select a verified Hyperliquid US stock perp.");
  const [candles, prices, meta] = await Promise.all([
    streamCandles(symbol, interval),
    streamPrices([symbol]),
    streamJson("/api/hyperliquid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "meta", dex: symbol.split(":")[0] }),
    }),
  ]);
  const now = Date.now(),
    analysis = Technicals.analyze(candles, now, {
      minStopPct: paperState.settings.minStopPct,
    }),
    asset = meta.universe.find(
      (r) => r.name === symbol || r.name === symbol.split(":")[1],
    ),
    signal = { symbol, interval, duration: intervals[interval], analysis };
  $("#gammaDecision").textContent =
    `${symbol} · ${analysis.direction} · ${analysis.score}/8 rules · ADX ${analysis.adx.toFixed(1)} · RSI ${analysis.rsi.toFixed(1)} · MACD ${analysis.histogram.toFixed(4)} · candle confirmation ${analysis.candleConfirmed ? "PASS" : "FAIL"} · candle ${new Date(analysis.closedAt + 1).toLocaleString()} · ${analysis.reason} · ${analysis.stopBasis}`;
  if (analysis.direction === "WAIT")
    throw Error(
      "No indicator-qualified setup. No futures or option trade opened.",
    );
  const clone = JSON.parse(JSON.stringify(gammaState.ledger));
  clone.settings = {
    ...paperState.settings,
    partialExitEnabled: false,
    riskPct: riskPct / 2,
  };
  const reserve = gammaState.books
    .filter((b) => !b.closed)
    .reduce((n, b) => n + b.optionRisk, 0);
  clone.cash -=
    reserve +
    Math.max(
      0,
      -gammaState.books
        .filter((b) => !b.closed)
        .reduce((n, b) => n + (b.optionPnl || 0), 0),
    );
  const before = clone.positions.length;
  Paper.update(
    clone,
    { [symbol]: { price: prices[symbol], time: now } },
    [signal],
    { [symbol]: { ...asset, usStock: true } },
    now,
    true,
  );
  const future = clone.positions.find((p) => p.symbol === symbol);
  if (clone.positions.length === before || !future)
    throw Error(
      "Futures entry rejected: stale candle, retest, structure, duplicate setup, venue metadata or available-margin gate.",
    );
  const overrideText = $("#gammaFutureQty").value.trim();
  if (overrideText) {
    const requested = Number(overrideText),
      step = 10 ** -asset.szDecimals;
    if (
      !(requested > 0 && requested <= future.qty) ||
      Math.abs(requested / step - Math.round(requested / step)) > 1e-6
    )
      throw Error(
        "Futures override must respect venue lot increments and cannot exceed risk-sized " +
          future.qty +
          " units.",
      );
    const factor = requested / future.qty;
    clone.cash += future.entryFee * (1 - factor);
    future.qty = requested;
    future.entryFee *= factor;
    future.margin *= factor;
    future.estimatedStopLoss *= factor;
  }
  clone.cash +=
    reserve +
    Math.max(
      0,
      -gammaState.books
        .filter((b) => !b.closed)
        .reduce((n, b) => n + (b.optionPnl || 0), 0),
    );
  const underlying = symbol.split(":")[1];
  if (rebuild) {
    const data = await gammaApi({
      symbol: underlying,
      near: expiry,
      far: expiry,
    });
    if (!(data.stock?.price > 0))
      throw Error(
        "Alpaca underlying price unavailable. No option chain constructed from a fake spot.",
      );
    gammaDraft =
      typeof gammaBlueprint !== "undefined" && gammaBlueprint
        ? hedgePick(
            data.contracts,
            data.stock.price,
            underlying,
            expiry,
            analysis.direction,
            lots,
            putLots,
            gammaBlueprint,
          )
        : gammaSelect(
            data.contracts,
            underlying,
            expiry,
            data.stock.price,
            analysis.direction,
            lots,
            Math.max(
              data.stock.price * 0.005,
              Math.abs(future.entry - future.stop) / 3,
            ),
          );
    gammaDraft.forEach((l) => {
      if (l.type === "put") l.qty = putLots;
    });
    gammaDraftRender();
  }
  gammaReviewData = {
    future,
    clone,
    signal,
    price: prices[symbol],
    riskPct,
    time: now,
  };
  gammaSimulation();
  return gammaReviewData;
}
async function gammaOpen() {
  if (gammaBusy) return;
  gammaBusy = true;
  try {
    const review = await gammaEvaluate(gammaDraft.length !== 4),
      response = await gammaApi({
        action: "legs",
        contracts: gammaDraft.map(occForLeg),
      }),
      quotes = response.contracts,
      legs = gammaDraft.map((l) => {
        const q = quotes.find((q) => q.symbol === occForLeg(l));
        if (!gammaFresh(q))
          throw Error(
            "Fresh quotes and Greeks required for every leg. US options may be closed; enable analysis mode in Options Studio to use last available quotes.",
          );
        if (l.side === "sell" && !(q.bid > 0))
          throw Error(
            "Short-leg bid is zero; cannot simulate a credible fill.",
          );
        return gammaLeg(
          q,
          l.side,
          l.qty,
          response.stocks?.[l.symbol]?.price || l.spot,
        );
      });
    if (
      legs.some(
        (l) =>
          l.symbol !== review.future.symbol.split(":")[1] ||
          l.expiry !== $("#gammaExpiry").value,
      )
    )
      throw Error("Options must match the selected futures stock and expiry.");
    const lc = legs.find((l) => l.type === "call" && l.side === "buy"),
      sc = legs.find((l) => l.type === "call" && l.side === "sell"),
      lp = legs.find((l) => l.type === "put" && l.side === "buy"),
      sp = legs.find((l) => l.type === "put" && l.side === "sell");
    if (
      review.future.direction === "LONG"
        ? lc.strike <= sc.strike || lp.strike <= sp.strike
        : lc.strike >= sc.strike || lp.strike >= sp.strike
    )
      throw Error(
        "Option spread ordering disagrees with the indicator-qualified futures hedge. Review/rebuild the draft.",
      );
    const optionRisk = gammaRisk(legs),
      budget =
        ((Paper.account(gammaState.ledger).equity +
          Math.min(
            0,
            gammaState.books
              .filter((b) => !b.closed)
              .reduce((n, b) => n + (b.optionPnl || 0), 0),
          )) *
          review.riskPct) /
        100;
    if (optionRisk + review.future.estimatedStopLoss > budget)
      throw Error(
        "Option maximum loss + planned futures stop risk exceeds " +
          money(budget) +
          ". Reduce lots or adjust the risk input.",
      );
    const optionDelta = legs.reduce(
        (n, l) =>
          n + (l.side === "buy" ? 1 : -1) * l.quote.greeks.delta * l.qty * 100,
        0,
      ),
      futureDelta =
        (review.future.direction === "LONG" ? 1 : -1) * review.future.qty;
    if (Math.abs(futureDelta + optionDelta) >= Math.abs(futureDelta))
      throw Error(
        "This overlay increases absolute delta rather than reducing it. Edit strikes/lots and review again.",
      );
    if (Date.now() - review.time > 45000)
      throw Error(
        "Futures review expired during option fetch. Retry with fresh sources.",
      );
    if (
      review.future.margin + optionRisk >
      Paper.account(gammaState.ledger).free
    )
      throw Error(
        "Insufficient virtual buying power for futures margin plus option worst-case loss.",
      );
    gammaState.ledger = review.clone;
    gammaState.books.unshift({
      id: review.future.id,
      future: review.future,
      analysis: review.signal.analysis,
      legs,
      optionRisk,
      optionEntryCash: Finance.premiumCash(legs, 0.65),
      optionPnl:
        Finance.premiumCash(legs, 0.65) +
        legs.reduce(
          (n, l) =>
            n +
            (l.side === "buy" ? 1 : -1) *
              (l.side === "buy" ? l.quote.bid : l.quote.ask) *
              l.qty *
              100,
          0,
        ),
      optionDelta,
      openedAt: Date.now(),
      closed: false,
      markTime: Date.now(),
      status: "OPEN · provider bid/ask paper fills",
    });
    gammaDraft = legs;
    gammaDraftRender();
    gammaSave();
    gammaRender();
    $("#gammaStatus").textContent =
      "Paired paper book opened with live Hyperliquid mid and four " +
      (legs[0].quote?.provider || "provider") +
      " bid/ask fills" +
      (legs.some((l) => Deriv.isStale(l.quote)) ? " (STALE quotes · analysis mode)" : "") +
      ". No real exchange/broker orders.";
  } catch (e) {
    $("#gammaStatus").textContent = "Entry blocked: " + e.message;
  } finally {
    gammaBusy = false;
    gammaNext = Date.now() + 30000;
  }
}
function gammaRender() {
  const options = gammaState.books.reduce((n, b) => n + (b.optionPnl || 0), 0),
    futures =
      Paper.account(gammaState.ledger).total -
      gammaState.books
        .filter((b) => b.closed)
        .reduce((n, b) => n + (b.optionPnl || 0), 0);
  $("#gammaEquity").textContent = money(100000 + futures + options);
  $("#gammaFuturesPnl").textContent = money(futures);
  $("#gammaOptionsPnl").textContent = money(options);
  $("#gammaCombined").textContent = money(futures + options);
  $("#gammaAuto").textContent = gammaState.auto
    ? "Disable automatic paired entries"
    : "Enable automatic paired entries";
  $("#gammaBooks").innerHTML = gammaState.books.length
    ? gammaState.books
        .map((b) => {
          const p = gammaState.ledger.positions.find((p) => p.id === b.id),
            closed = gammaState.ledger.history.find((p) => p.id === b.id),
            delta =
              (p ? (p.direction === "LONG" ? 1 : -1) * p.qty : 0) +
              (b.closed ? 0 : b.optionDelta),
            gamma = b.closed
              ? 0
              : b.legs.reduce(
                  (n, l) =>
                    n +
                    (l.side === "buy" ? 1 : -1) *
                      (l.quote?.greeks?.gamma || 0) *
                      l.qty *
                      100,
                  0,
                );
          return `<article class="panel"><h3>${escapeHtml(b.future.symbol)} · ${b.future.direction}</h3><p class="market-note">${escapeHtml(b.status)} · ${Date.now() - b.markTime > 120000 ? "STALE options mark" : "provider liquidation mark"} · futures ${closed ? money(closed.net) : p ? money((p.direction === "LONG" ? 1 : -1) * (p.mark - p.entry) * p.qty - p.entryFee) : "—"} · options ${money(b.optionPnl)} · net delta ${delta.toFixed(2)} · signed gamma ${gamma.toFixed(4)}</p><p class="market-note">Setup audit: ${b.analysis?.score ?? b.future.score}/8 rules · ADX ${b.analysis?.adx?.toFixed(1) ?? "—"} · RSI ${b.analysis?.rsi?.toFixed(1) ?? "—"} · candle confirmation ${b.analysis?.candleConfirmed ? "PASS" : "unavailable"} · ${escapeHtml(b.analysis?.stopBasis || b.future.stopBasis)} · signal ${new Date(b.future.signalTime).toLocaleString()}</p><p class="market-note">Futures qty ${b.future.qty.toFixed(4)} · entry ${quotePrice(b.future.entry)} · SL ${quotePrice(b.future.stop)} · target ${quotePrice(b.future.target)} · ${b.future.netRR.toFixed(2)}R net planned</p>${b.legs.map((l) => '<p class="market-note">' + l.side.toUpperCase() + " " + l.type.toUpperCase() + " " + l.strike + " · " + l.expiry + " · " + l.qty + " lots · fixed entry premium " + quotePrice(l.premium) + "</p>").join("")}</article>`;
        })
        .join("")
    : '<div class="empty-state">No book executed. No samples or modeled premiums replace missing provider data.</div>';
}
async function gammaMonitor() {
  if (gammaBusy) return;
  gammaBusy = true;
  try {
    const positions = gammaState.ledger.positions,
      prices = positions.length
        ? await streamPrices(positions.map((p) => p.symbol))
        : {},
      now = Date.now(),
      quotes = Object.fromEntries(
        Object.entries(prices).map(([s, price]) => [s, { price, time: now }]),
      ),
      signals = [];
    for (const p of positions) {
      try {
        const analysis = Technicals.analyze(
          await streamCandles(p.symbol, p.interval),
          Date.now(),
          { minStopPct: paperState.settings.minStopPct },
        );
        signals.push({
          symbol: p.symbol,
          interval: p.interval,
          duration: intervals[p.interval],
          analysis,
        });
      } catch {}
    }
    Paper.update(gammaState.ledger, quotes, signals, {}, Date.now(), false);
    for (const b of gammaState.books.filter((b) => !b.closed)) {
      try {
        const data = await gammaApi({
          action: "legs",
          contracts: b.legs.map(occForLeg),
        });
        const legs = b.legs.map((l) => {
            const q = data.contracts.find((q) => q.symbol === occForLeg(l));
            if (!gammaFresh(q))
              throw Error(
                "Options quotes stale/missing · overlay remains open",
              );
            return { ...l, quote: q };
          }),
          mark = legs.reduce(
            (n, l) =>
              n +
              (l.side === "buy" ? 1 : -1) *
                (l.side === "buy" ? l.quote.bid : l.quote.ask) *
                l.qty *
                100,
            0,
          );
        b.legs = legs;
        b.optionDelta = legs.reduce(
          (n, l) =>
            n +
            (l.side === "buy" ? 1 : -1) * l.quote.greeks.delta * l.qty * 100,
          0,
        );
        b.optionPnl = b.optionEntryCash + mark;
        b.markTime = Date.now();
        if (!gammaState.ledger.positions.some((p) => p.id === b.id)) {
          b.optionPnl -= legs.reduce((n, l) => n + l.qty * 0.65, 0);
          gammaState.ledger.cash += b.optionPnl;
          b.closed = true;
          b.status =
            "CLOSED · futures exit and fresh four-leg liquidation quotes";
        } else b.status = "OPEN · fresh quotes";
      } catch (e) {
        b.status = "OPTIONS EXIT / MARK PENDING · " + e.message;
      }
    }
    gammaSave();
    gammaRender();
  } catch (e) {
    $("#gammaStatus").textContent = "Book refresh unavailable: " + e.message;
  } finally {
    gammaBusy = false;
    gammaNext = Date.now() + 30000;
  }
}
$("#gammaReview").onclick = async () => {
  if (gammaBusy) return;
  gammaBusy = true;
  try {
    await gammaEvaluate(true);
    $("#gammaStatus").textContent =
      "Live setup reviewed. Edit draft strikes/lots, then open a paired paper book; stale options still block execution.";
  } catch (e) {
    $("#gammaStatus").textContent = e.message;
  } finally {
    gammaBusy = false;
  }
};
$("#gammaOpen").onclick = gammaOpen;
$("#gammaRefresh").onclick = gammaMonitor;
$("#gammaConnect").onclick = () =>
  document.querySelector('[data-view="options"]').click();
$("#gammaAuto").onclick = () => {
  gammaState.auto = !gammaState.auto;
  gammaRender();
  if (gammaState.auto) gammaOpen();
};
$("#gammaShock").oninput = gammaSimulation;
window.addEventListener("viewchange", (e) => {
  if (e.detail === "gamma") {
    gammaRender();
    if (gammaState.books.length) gammaMonitor();
  }
});
setInterval(() => {
  if (document.hidden || gammaBusy || Date.now() < gammaNext) return;
  if (gammaState.books.some((b) => !b.closed))
    gammaMonitor().then(() => {
      if (
        gammaState.auto &&
        !gammaState.ledger.positions.some(
          (p) => p.symbol === $("#gammaSymbol").value.trim(),
        )
      )
        gammaOpen();
    });
  else if (gammaState.auto) gammaOpen();
}, 1000);
gammaRender();
if (location.pathname === "/gamma")
  document.querySelector('[data-view="gamma"]').click();

for (const id of ["gammaLots", "gammaPutLots"])
  $("#" + id).onchange = () => {
    gammaDraft = [];
    $("#gammaStatus").textContent =
      "Lot settings changed. Review again to build four fresh provider legs.";
  };

// ---- shared derivatives state (underlying / expiry) with the other derivatives pages
async function gammaSyncFromShared() {
  const st = Deriv.get();
  if (st.ticker && document.activeElement !== $("#gammaSymbol")) {
    const perp = Deriv.perpFor(st.ticker, await Deriv.perpSymbols());
    if (perp && !gammaState.books.some((b) => !b.closed && b.future.symbol === $("#gammaSymbol").value.trim())) $("#gammaSymbol").value = perp;
  }
  if (st.expiry && st.expiry > isoDay(new Date()) && document.activeElement !== $("#gammaExpiry")) $("#gammaExpiry").value = st.expiry;
}
$("#gammaSymbol").addEventListener("change", () => Deriv.set({ ticker: Deriv.tickerOf($("#gammaSymbol").value.trim()) }));
$("#gammaExpiry").addEventListener("change", () => Deriv.set({ expiry: $("#gammaExpiry").value }));
window.addEventListener("viewchange", (e) => { if (e.detail === "gamma") gammaSyncFromShared(); });
gammaSyncFromShared();
