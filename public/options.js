const optionState = {
  legs: [],
  contracts: [],
  dataReady: false, // server has Alpaca keys (or an explicit fallback); keys never reach the browser
  providerLabel: "",
  connected: false,
  busy: false,
  lastFetch: 0,
  nextFetch: 0,
  feed: "indicative",
  stockFeed: "iex",
  dataSymbol: "",
  partial: false,
  generation: 0,
  controller: null,
  assets: [],
  assetsVerified: false,
  quoteMap: {},
  refreshBusy: false,
  lastLegFetch: 0,
  account: "paper",
  nextPageToken: null,
};
const isoDay = (d) => d.toISOString().slice(0, 10);
function futureFriday(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return isoDay(d);
}
$("#optionExpiry").value = futureFriday(14);
$("#optionFarExpiry").value = futureFriday(42);
$("#scenarioDate").value = $("#optionExpiry").value;
function legKey(l) {
  return [l.symbol, l.expiry, l.type, l.strike].join("|");
}
function legQuote(l) {
  return (
    optionState.quoteMap[legKey(l)] ||
    optionState.contracts.find(
      (c) =>
        c.underlying === l.symbol &&
        c.expiry === l.expiry &&
        c.type === l.type &&
        c.strike === l.strike,
    )
  );
}
function templateSpecs(name, S, w, near, far) {
  switch (name) {
    case "bullCall":
      return [
        ["buy", "call", S, near],
        ["sell", "call", S + w, near],
      ];
    case "bearPut":
      return [
        ["buy", "put", S, near],
        ["sell", "put", S - w, near],
      ];
    case "straddle":
      return [
        ["buy", "call", S, near],
        ["buy", "put", S, near],
      ];
    case "calendar":
      return [
        ["sell", "call", S, near],
        ["buy", "call", S, far],
      ];
    case "condor":
      return [
        ["buy", "put", S - 2 * w, near],
        ["sell", "put", S - w, near],
        ["sell", "call", S + w, near],
        ["buy", "call", S + 2 * w, near],
      ];
    case "butterfly":
      return [
        ["buy", "call", S - w, near],
        ["sell", "call", S, near],
        ["sell", "call", S, near],
        ["buy", "call", S + w, near],
      ];
    case "doubleCalendar":
      return [
        ["sell", "put", S - w, near],
        ["buy", "put", S - w, far],
        ["sell", "call", S + w, near],
        ["buy", "call", S + w, far],
      ];
    case "tripleVertical":
      return [
        ["buy", "call", S - 2 * w, near],
        ["sell", "call", S - w, near],
        ["buy", "call", S, near],
        ["sell", "call", S + w, near],
        ["buy", "call", S + 2 * w, near],
        ["sell", "call", S + 3 * w, near],
      ];
    default:
      throw Error("Unknown template.");
  }
}
function closestContract(symbol, expiry, type, strike) {
  return optionState.contracts
    .filter(
      (c) => c.underlying === symbol && c.expiry === expiry && c.type === type,
    )
    .sort(
      (a, b) => Math.abs(a.strike - strike) - Math.abs(b.strike - strike),
    )[0];
}
async function ensureSpot() {
  if (Number($("#optionSpot").value) > 0) return;
  const symbol = $("#optionUnderlying").value.trim().toUpperCase();
  if (optionState.dataReady) {
    try {
      const r = await fetch("/api/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol, near: $("#optionExpiry").value, far: $("#optionExpiry").value }) });
      const d = await r.json();
      if (r.ok && d.stock?.price > 0) {
        $("#optionSpot").value = d.stock.price;
        optionState.spotSource = d.stock.source;
        $("#optionDataStatus").textContent = "Reference price from " + d.stock.source + " @ " + (d.stock.time ? new Date(d.stock.time).toLocaleString() : "time unavailable") + ".";
        return;
      }
    } catch {}
  }
  try {
    const perps = await Deriv.perpSymbols(), perp = Deriv.perpFor(symbol, perps);
    if (!perp) return;
    const mids = await streamPrices([perp]);
    if (mids[perp] > 0) {
      $("#optionSpot").value = Number(mids[perp].toPrecision(6));
      optionState.spotSource = "Hyperliquid " + perp + " perp mid (proxy, not the stock quote)";
      $("#optionDataStatus").textContent = "Reference price = Hyperliquid " + perp + " perp mid " + quotePrice(mids[perp]) + " · a proxy for the stock price (basis may differ). Enter the stock price to override.";
    }
  } catch {}
}
function shareOptionState() {
  Deriv.set({
    ticker: $("#optionUnderlying").value.trim().toUpperCase(),
    expiry: $("#optionExpiry").value,
    farExpiry: $("#optionFarExpiry").value,
    legs: optionState.legs.map((l) => ({ symbol: l.symbol, side: l.side, type: l.type, strike: l.strike, expiry: l.expiry, qty: l.qty, premium: l.premium, iv: l.iv, delta: legQuote(l)?.greeks?.delta ?? null })),
  });
}
async function buildOptions() {
  await ensureSpot();
  try {
    const S = Number($("#optionSpot").value),
      w = Number($("#optionWidth").value),
      symbol = $("#optionUnderlying").value,
      near = $("#optionExpiry").value,
      far = $("#optionFarExpiry").value,
      name = $("#optionTemplate").value;
    if (!(S > 0 && w > 0) || !near || !far || near < isoDay(new Date()))
      throw Error(
        "Enter a positive reference price, width, and future expiries.",
      );
    if (["calendar", "doubleCalendar"].includes(name) && far <= near)
      throw Error("Calendar strategies require far expiry after near expiry.");
    const specs = templateSpecs(name, Math.round(S / w) * w, w, near, far);
    if (specs.some((x) => x[2] <= 0))
      throw Error("Strike width creates a non-positive strike.");
    optionState.legs = specs.map(([side, type, strike, expiry]) => {
      const contract = closestContract(symbol, expiry, type, strike);
      if (
        optionState.connected &&
        optionState.dataSymbol === symbol &&
        !contract
      )
        throw Error(
          "No loaded " +
            type +
            " contracts for " +
            expiry +
            ". Fetch the required expiry range or switch to manual mode.",
        );
      const actualStrike = contract?.strike ?? strike,
        iv = contract?.iv > 0 ? contract.iv : NaN,
        T = Math.max(
          0,
          (Date.parse(expiry + "T20:00:00Z") - Date.now()) / (365 * 86400000),
        ),
        price = contract ? (side === "buy" ? contract.ask : contract.bid) : NaN;
      return {
        symbol,
        side,
        type,
        strike: actualStrike,
        expiry,
        qty: 1,
        multiplier: 100,
        premium: price ?? NaN,
        iv,
        spot: S,
        liveSpot: !!contract,
        liveIv: !!contract,
        source: contract
          ? "Provider " +
            optionState.feed +
            " · " +
            (side === "buy" ? "ask" : "bid")
          : "Manual premium required · no provider quote",
      };
    });
    $("#optionLegCount").value = optionState.legs.length;
    $("#scenarioDate").value = near;
    $("#optionError").textContent = "";
    renderOptionLegs();
    simulateOptions();
    shareOptionState();
  } catch (e) {
    $("#optionError").textContent = e.message;
  }
}
function renderOptionLegs() {
  const fields = [
    "symbol",
    "side",
    "type",
    "expiry",
    "strike",
    "qty",
    "multiplier",
    "premium",
    "iv",
    "spot",
  ];
  $("#optionLegs").innerHTML = optionState.legs
    .map(
      (l, i) =>
        `<tr><td>${i + 1}</td>${fields
          .map((f) => {
            const value = f === "iv" ? l.iv * 100 : l[f];
            const attrs = `data-i="${i}" data-field="${f}" aria-label="Leg ${i + 1} ${f}"`;
            if (f === "side" || f === "type") {
              const choices = f === "side" ? ["buy", "sell"] : ["call", "put"];
              return `<td><select ${attrs}>${choices.map((v) => `<option ${v === value ? "selected" : ""}>${v}</option>`).join("")}</select></td>`;
            }
            return `<td><input ${attrs} type="${f === "symbol" ? "text" : f === "expiry" ? "date" : "number"}" value="${escapeHtml(Number.isNaN(value) ? "" : value)}" ${f !== "symbol" && f !== "expiry" ? 'step="any" min="0"' : ""}></td>`;
          })
          .join(
            "",
          )}<td class="leg-source" id="legQuote${i}">${quoteLegLabel(l)}<button data-quote="${i}" class="ghost">Use ${l.side === "buy" ? "ask" : "bid"}</button></td></tr>`,
    )
    .join("");
  $("#optionLegs")
    .querySelectorAll("[data-field]")
    .forEach(
      (input) =>
        (input.onchange = () => {
          const l = optionState.legs[Number(input.dataset.i)],
            field = input.dataset.field;
          if (field === "symbol") l[field] = input.value.trim().toUpperCase();
          else if (["side", "type", "expiry"].includes(field))
            l[field] = input.value;
          else
            l[field] =
              input.value === ""
                ? NaN
                : Number(input.value) / (field === "iv" ? 100 : 1);
          if (["symbol", "expiry", "type", "strike", "side"].includes(field)) {
            l.source = "Manual · contract changed";
            l.premium = NaN;
          } else if (field === "premium") l.source = "Manual premium override";
          if (field === "spot") l.liveSpot = false;
          if (field === "iv") l.liveIv = false;
          renderOptionLegs();
          simulateOptions();
          shareOptionState();
        }),
    );
  $("#optionLegs")
    .querySelectorAll("[data-quote]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          const l = optionState.legs[Number(b.dataset.quote)],
            q = legQuote(l),
            value = l.side === "buy" ? q?.ask : q?.bid;
          if (value == null || !Number.isFinite(value) || value < 0) {
            $("#optionError").textContent =
              "No valid matching bid/ask available. Connect and fetch this underlying and expiry, or enter a manual premium.";
            return;
          }
          if (q.bid != null && q.ask != null && q.ask < q.bid) {
            $("#optionError").textContent =
              "Crossed quote: ask is below bid. Enter a verified premium.";
            return;
          }
          l.premium = value;
          l.source =
            "Provider " +
            optionState.feed +
            " · " +
            (l.side === "buy" ? "ask" : "bid");
          if (q.iv > 0) {
            l.iv = q.iv;
            l.liveIv = true;
          }
          l.liveSpot = true;
          renderOptionLegs();
          simulateOptions();
        }),
    );
}
function quoteLegLabel(l) {
  const q = legQuote(l);
  return (
    `<span>${escapeHtml(l.source || "Manual input")}</span><br>` +
    (q
      ? `Bid ${q.bid == null ? "—" : quotePrice(q.bid)} · Ask ${q.ask == null ? "—" : quotePrice(q.ask)}<br>${q.quoteTime ? escapeHtml(new Date(q.quoteTime).toLocaleString()) : "Quote timestamp unavailable"}`
      : "No matching provider quote")
  );
}
function scenarioInput() {
  return {
    date: $("#scenarioDate").value,
    shock: Number($("#scenarioShock").value),
    ivShift: Number($("#scenarioIv").value),
    rate: Number($("#scenarioRate").value),
    dividend: Number($("#scenarioDividend").value),
    timeMillis: $("#scenarioMode").value === "live" ? Date.now() : undefined,
  };
}
function clearOptionResults(message) {
  $("#optionError").textContent = message;
  for (const id of [
    "optionNet",
    "optionPnl",
    "optionMaxProfit",
    "optionMaxLoss",
  ])
    $("#" + id).textContent = "—";
  $("#optionBreakevens").textContent = "";
  $("#optionScenarioTable").innerHTML = "";
  const c = $("#optionChart").getContext("2d");
  if (c) c.clearRect(0, 0, 1000, 360);
}
function simulateOptions() {
  try {
    const legs = Finance.validateLegs(optionState.legs),
      scenario = scenarioInput(),
      fee = Number($("#optionCommission").value);
    if (!Number.isFinite(fee) || fee < 0)
      throw Error("Entry commission must be non-negative.");
    if (
      !Number.isFinite(scenario.timeMillis) &&
      scenario.date < isoDay(new Date())
    )
      throw Error("Valuation date cannot be before today.");
    const exact = Finance.exactExpiry(legs, fee),
      allSameExpiry = new Set(legs.map((l) => l.expiry)).size === 1,
      expired =
        allSameExpiry &&
        (Number.isFinite(scenario.timeMillis)
          ? scenario.timeMillis >= Date.parse(legs[0].expiry + "T20:00:00Z")
          : scenario.date >= legs[0].expiry);
    $("#optionError").textContent = "";
    $("#optionNet").textContent = money(Finance.premiumCash(legs, fee));
    const pnl = Finance.pnl(legs, scenario, fee);
    $("#optionPnl").textContent = money(pnl);
    $("#optionPnl").className = pnl >= 0 ? "positive" : "negative";
    $("#optionPnlMode").textContent = expired
      ? "Expiry payoff · before exit costs"
      : Number.isFinite(scenario.timeMillis)
        ? "Current-time theoretical valuation"
        : "Theoretical valuation";
    $("#optionMaxProfit").textContent = exact
      ? exact.maxProfit === Infinity
        ? "Unlimited"
        : money(exact.maxProfit)
      : "Scenario only";
    $("#optionMaxLoss").textContent = exact
      ? exact.maxLoss === Infinity
        ? "Unlimited"
        : money(exact.maxLoss)
      : "Scenario only";
    $("#optionBoundMode").textContent = exact
      ? "At common expiry"
      : "Mixed stocks / expiries";
    $("#optionBreakevens").textContent = exact
      ? "Expiry break-even stock price(s): " +
        (exact.breakEvens.length
          ? exact.breakEvens.map(quotePrice).join(", ")
          : "None / no isolated root")
      : "Global break-even prices and extrema are not defined by this one-factor model for mixed expiries or stocks.";
    const model = legs.some((l) => l.source?.startsWith("Illustrative"));
    $("#optionsSource").textContent = model
      ? "ILLUSTRATIVE MODEL INPUTS"
      : legs.every((l) => l.source?.startsWith("Provider"))
        ? "PROVIDER ENTRY PREMIUMS"
        : "MANUAL / MIXED INPUTS";
    $("#optionModelNote").textContent =
      (model
        ? "Template premiums are illustrative model estimates, not exchange quotes. "
        : "") +
      "Chart: portfolio P&L at " +
      (Number.isFinite(scenario.timeMillis)
        ? new Date(scenario.timeMillis).toLocaleString()
        : scenario.date) +
      " for a shared −50% to +50% stock-price shock. Entry cash and entry commissions are included.";
    const points = Array.from({ length: 201 }, (_, i) => ({
      x: -50 + i * 0.5,
      y: Finance.pnl(legs, { ...scenario, shock: -50 + i * 0.5 }, fee),
    }));
    drawOptionChart(points, scenario.shock);
    $("#optionScenarioTable").innerHTML =
      '<table class="market-table"><thead><tr><th>Stock price move</th><th>Estimated portfolio P&L</th></tr></thead><tbody>' +
      [-30, -20, -10, 0, 10, 20, 30]
        .map(
          (shock) =>
            `<tr><td>${shock > 0 ? "+" : ""}${shock}%</td><td>${money(Finance.pnl(legs, { ...scenario, shock }, fee))}</td></tr>`,
        )
        .join("") +
      "</tbody></table>";
  } catch (e) {
    clearOptionResults(e.message);
  }
}
function drawOptionChart(points, shock) {
  const canvas = $("#optionChart"),
    ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = 1000,
    H = 360,
    pad = 65,
    min = Math.min(0, ...points.map((p) => p.y)),
    max = Math.max(0, ...points.map((p) => p.y)),
    range = max - min || 1,
    x = (v) => pad + ((v + 50) / 100) * (W - 2 * pad),
    y = (v) => H - pad - ((v - min) / range) * (H - 2 * pad);
  ctx.clearRect(0, 0, W, H);
  ctx.font = "12px system-ui";
  ctx.strokeStyle = "#253044";
  ctx.fillStyle = "#8d9bb0";
  for (let i = 0; i < 5; i++) {
    const v = min + (range * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, y(v));
    ctx.lineTo(W - pad, y(v));
    ctx.stroke();
    ctx.fillText("$" + Math.round(v).toLocaleString(), 5, y(v) + 4);
  }
  for (let move = -50; move <= 50; move += 10)
    ctx.fillText(move + "%", x(move) - 12, H - 30);
  ctx.strokeStyle = "#677896";
  ctx.beginPath();
  ctx.moveTo(pad, y(0));
  ctx.lineTo(W - pad, y(0));
  ctx.stroke();
  ctx.strokeStyle = "#8493ff";
  ctx.lineWidth = 3;
  ctx.beginPath();
  points.forEach((p, i) =>
    i ? ctx.lineTo(x(p.x), y(p.y)) : ctx.moveTo(x(p.x), y(p.y)),
  );
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = "#32d583";
  ctx.beginPath();
  ctx.moveTo(x(Math.max(-50, Math.min(50, shock))), pad);
  ctx.lineTo(x(Math.max(-50, Math.min(50, shock))), H - pad);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#a8b2c4";
  ctx.fillText(
    "Underlying price move · shared shock across stocks",
    330,
    H - 5,
  );
}
async function fetchOptionChain(append = false) {
  append = append === true;
  if (optionState.busy) return;
  if (!optionState.dataReady) {
    const st = await Deriv.status(true);
    optionState.dataReady = !!(st.alpaca?.configured || st.fallback);
    renderProviderStatus(st);
    if (!optionState.dataReady) {
      $("#optionError").textContent =
        "Options data is not configured on the server (ALPACA_KEY_ID / ALPACA_SECRET_KEY). Manual simulation is available.";
      return;
    }
  }
  const symbol = $("#optionUnderlying").value,
    near = $("#optionExpiry").value,
    far = $("#optionFarExpiry").value;
  if (!near || !far || near > far) {
    $("#optionError").textContent =
      "Choose an expiry range with far expiry on or after near expiry.";
    return;
  }
  const generation = optionState.generation;
  optionState.busy = true;
  $("#fetchOptionChain").disabled = true;
  $("#connectionStatus").textContent =
    "Fetching option snapshots through this server…";
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 90000);
  optionState.controller = controller;
  try {
    const response = await fetch("/api/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol,
        near,
        far,
        pageToken: append ? optionState.nextPageToken : null,
      }),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok)
      throw Error(data.error || "Options provider unavailable.");
    if (generation !== optionState.generation) return;
    optionState.contracts = append
      ? [
          ...new Map(
            [...optionState.contracts, ...data.contracts].map((c) => [
              c.symbol,
              c,
            ]),
          ).values(),
        ]
      : data.contracts;
    for (const c of data.contracts)
      optionState.quoteMap[
        [c.underlying, c.expiry, c.type, c.strike].join("|")
      ] = c;
    optionState.nextPageToken = data.nextPageToken;
    $("#loadMoreOptionChain").hidden = !data.nextPageToken;
    optionState.dataSymbol = symbol;
    optionState.feed = data.feed || optionState.feed;
    optionState.providerLabel = data.label || "";
    optionState.partial = data.partial;
    optionState.connected = true;
    optionState.lastFetch = Date.now();
    $("#connectionStatus").textContent =
      "Connected · " + data.label + " · read-only, no order access.";
    const times = data.contracts
        .map((c) => Date.parse(c.quoteTime))
        .filter(Number.isFinite),
      newest = times.length ? Math.max(...times) : 0,
      stale = !newest || Date.now() - newest > 120000;
    $("#optionDataStatus").textContent =
      `${optionState.contracts.length} standard contracts · ${data.label} · fetched ${new Date(data.fetchedAt).toLocaleTimeString()} · newest quote ${newest ? new Date(newest).toLocaleString() : "unavailable"}${stale ? " · STALE / market closed" : ""}${data.partial ? " · Partial chain: narrow your expiry range" : ""} · Adjusted contract roots excluded.`;
    if (data.stock) {
      $("#optionSpot").value = data.stock.price;
      optionState.spotSource = data.stock.source;
      $("#optionDataStatus").textContent +=
        " · stock reference " +
        data.stock.source +
        " @ " +
        new Date(data.stock.time).toLocaleString();
    } else
      $("#optionDataStatus").textContent +=
        " · Stock quote unavailable: enter a reference stock price manually.";
    for (const l of optionState.legs) {
      if (l.symbol !== symbol) continue;
      const q = legQuote(l);
      if (l.liveSpot && data.stock) l.spot = data.stock.price;
      if (l.liveIv && q?.iv > 0) l.iv = q.iv;
    }
    const expiries = [
      ...new Set(optionState.contracts.map((c) => c.expiry)),
    ].sort();
    $("#chainExpiryFilter").innerHTML =
      '<option value="all">All loaded expiries</option>' +
      expiries.map((e) => `<option>${e}</option>`).join("");
    renderChain();
    if (!$("#optionLegs").contains(document.activeElement)) renderOptionLegs();
    showMarketMark();
    $("#optionError").textContent = "";
    simulateOptions();
  } catch (e) {
    if (generation !== optionState.generation) return;
    $("#connectionStatus").textContent =
      "Fetch failed: " +
      (e.name === "AbortError" ? "Request timed out." : e.message);
    $("#optionError").textContent =
      "Previously fetched quotes, if any, are retained and may be stale.";
  } finally {
    clearTimeout(timeout);
    optionState.controller = null;
    optionState.busy = false;
    optionState.nextFetch = Date.now() + 30000;
    $("#fetchOptionChain").disabled = false;
    if (
      generation !== optionState.generation &&
      optionState.dataReady
    )
      fetchOptionChain();
  }
}
function renderChain() {
  const expiry = $("#chainExpiryFilter").value,
    type = $("#chainTypeFilter").value,
    strike = $("#chainStrikeFilter").value,
    spot = Number($("#optionSpot").value);
  const filtered = optionState.contracts
    .filter(
      (c) =>
        (expiry === "all" || c.expiry === expiry) &&
        (type === "all" || c.type === type) &&
        (!strike || c.strike === Number(strike)),
    )
    .sort(
      (a, b) =>
        a.expiry.localeCompare(b.expiry) ||
        Math.abs(a.strike - spot) - Math.abs(b.strike - spot) ||
        a.type.localeCompare(b.type),
    );
  const rows = filtered.slice(0, 200);
  $("#chainTable").innerHTML =
    '<p class="market-note">Showing ' +
    rows.length +
    " of " +
    filtered.length +
    ' matching contracts. Filter by expiry, type, or exact strike to see any loaded contract.</p><table class="market-table"><thead><tr><th>Contract</th><th>Expiry</th><th>Type</th><th>Strike</th><th>Bid</th><th>Ask</th><th>IV</th><th>Delta</th><th>Gamma</th><th>Theta</th><th>Vega</th><th>Quote time</th></tr></thead><tbody>' +
    rows
      .map(
        (c) =>
          `<tr><td>${escapeHtml(c.symbol)}</td><td>${c.expiry}</td><td>${c.type}</td><td>${quotePrice(c.strike)}</td><td>${c.bid === null ? "—" : quotePrice(c.bid)}</td><td>${c.ask === null ? "—" : quotePrice(c.ask)}</td><td>${c.iv === null ? "—" : (c.iv * 100).toFixed(1) + "%"}</td>${["delta", "gamma", "theta", "vega"].map((g) => "<td>" + (Number.isFinite(c.greeks?.[g]) ? c.greeks[g].toFixed(4) : "—") + "</td>").join("")}<td>${c.quoteTime ? escapeHtml(new Date(c.quoteTime).toLocaleString()) : "—"}</td></tr>`,
      )
      .join("") +
    "</tbody></table>";
}
function renderProviderStatus(st) {
  const el = $("#providerStatus");
  if (!el) return;
  const a = st?.alpaca || {};
  el.innerHTML = a.configured
    ? `<span class="label">SERVER-SIDE ALPACA · ${escapeHtml((a.optionsFeed || "").toUpperCase())}</span> Options feed <b>${escapeHtml(a.optionsFeed || "")}</b>${a.optionsFeed === "indicative" ? " (free: modified quotes, delayed trades; set ALPACA_OPTIONS_FEED=opra after subscribing)" : " (real-time OPRA)"} · stock feed <b>${escapeHtml(a.stockFeed || "")}</b> · ${escapeHtml(a.tradingApi || "")} keys. Keys stay on the server.`
    : st?.fallback
      ? `<span class="label watch">FALLBACK · DELAYED</span> ${escapeHtml(st.message || "")}`
      : `<span class="label short">NO OPTIONS DATA</span> ${escapeHtml(st?.message || "Alpaca keys are not configured on the server.")}`;
}
$("#allowStaleQuotes").checked = Deriv.allowStale();
$("#allowStaleQuotes").onchange = () => {
  Deriv.set({ allowStale: $("#allowStaleQuotes").checked });
  $("#connectionStatus").textContent = $("#allowStaleQuotes").checked
    ? "Analysis mode: last available (closed-market / indicative) quotes are accepted everywhere and labelled STALE."
    : "Strict mode: Gamma Book, Live Hedge and 1:2 pages require quotes under 2 minutes old.";
};
$("#connectOptions").onclick = async () => {
  optionState.generation++;
  optionState.controller?.abort();
  const st = await Deriv.status(true);
  renderProviderStatus(st);
  optionState.dataReady = !!(st.alpaca?.configured || st.fallback);
  if (!optionState.dataReady) {
    $("#connectionStatus").textContent = st.message || "Options data not configured on the server.";
    return;
  }
  $("#scenarioMode").value = "live";
  loadAlpacaUnderlyings();
  fetchOptionChain();
};
$("#disconnectOptions").onclick = () => {
  optionState.generation++;
  optionState.controller?.abort();
  optionState.connected = false;
  optionState.contracts = [];
  optionState.quoteMap = {};
  $("#connectionStatus").textContent = "Quotes cleared · auto-refresh stopped. Server keys are unaffected.";
  $("#optionDataStatus").textContent =
    "Manual mode · provider quotes cleared. Entry premiums remain as user-selected historical inputs.";
  optionState.legs.forEach((l) => {
    if (l.source.startsWith("Provider"))
      l.source = "Manual · previously selected provider premium";
  });
  renderOptionLegs();
  simulateOptions();
};
$("#fetchOptionChain").onclick = fetchOptionChain;
$("#buildOptions").onclick = buildOptions;
$("#optionLegCount").onchange = () => {
  const count = Number($("#optionLegCount").value);
  $("#optionTemplate").value =
    count === 2 ? "bullCall" : count === 4 ? "condor" : "tripleVertical";
  buildOptions();
};
$("#optionUnderlying").onchange = () => {
  optionState.generation++;
  optionState.controller?.abort();
  optionState.contracts = [];
  optionState.dataSymbol = "";
  $("#chainTable").innerHTML = "";
  $("#optionSpot").value = "";
  Deriv.set({ ticker: $("#optionUnderlying").value.trim().toUpperCase() });
  $("#optionDataStatus").textContent =
    "Underlying changed · fetch its option chain, then rebuild the strategy.";
  if (optionState.connected) fetchOptionChain();
};
for (const id of ["chainExpiryFilter", "chainTypeFilter", "chainStrikeFilter"])
  $("#" + id).oninput = renderChain;
for (const id of [
  "scenarioMode",
  "scenarioDate",
  "scenarioShock",
  "scenarioIv",
  "scenarioRate",
  "scenarioDividend",
  "optionCommission",
])
  $("#" + id).oninput = simulateOptions;
$("#scenarioSlider").oninput = (e) => {
  $("#scenarioShock").value = e.target.value;
  simulateOptions();
};
$("#exportOptions").onclick = () => {
  try {
    Finance.validateLegs(optionState.legs);
    const blob = new Blob(
        [
          JSON.stringify(
            {
              strategy: $("#optionTemplate").value,
              legs: optionState.legs,
              scenario: scenarioInput(),
              entryCommission: Number($("#optionCommission").value),
              exportedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "options-strategy.json";
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    $("#optionError").textContent = e.message;
  }
};
setInterval(() => {
  if (
    document.hidden ||
    activeView !== "options" ||
    !optionState.connected ||
    !$("#autoOptions").checked
  )
    return;
  const next = optionState.nextFetch || 0;
  $("#optionRefreshStatus").textContent =
    "Active-leg quote / IV refresh in " +
    Math.max(0, Math.ceil((next - Date.now()) / 1000)) +
    "s · 30-second interval";
  if (
    Date.now() >= next &&
    !optionState.busy &&
    !optionState.refreshBusy &&
    !optionState.refreshCycleBusy
  )
    refreshOptionData();
}, 1000);
clearOptionResults(
  "Fetch a chain (server-side Alpaca), or enter your own prices and IV. No sample premiums are generated.",
);
if (location.pathname === "/options")
  document.querySelector('[data-view="options"]').click();
function renderUnderlyingSuggestions() {
  const query = $("#optionUnderlying").value.trim().toUpperCase();
  const matching = optionState.assets
    .filter(
      (a) =>
        a.symbol.toUpperCase().includes(query) ||
        (a.name || "").toUpperCase().includes(query),
    )
    .slice(0, 200);
  $("#optionUniverse").innerHTML = matching
    .map(
      (a) =>
        `<option value="${escapeHtml(a.symbol)}" label="${escapeHtml(a.name || a.symbol)}"></option>`,
    )
    .join("");
}
async function loadPublicUnderlyings() {
  try {
    const r = await fetch("/api/option-universe");
    if (!r.ok) throw Error("Directory unavailable");
    const data = await r.json();
    if (optionState.assetsVerified) return;
    if (!Array.isArray(data.assets))
      throw Error("Invalid asset directory response");
    optionState.assets = data.assets;
    renderUnderlyingSuggestions();
    $("#optionUniverseStatus").textContent =
      data.assets.length.toLocaleString() +
      " US-listed symbols available to search · optionability is verified when a chain is fetched.";
  } catch {
    $("#optionUniverseStatus").textContent =
      "Symbol directory unavailable. You can enter any ticker manually; connect Alpaca to verify options availability.";
  }
}
async function loadAlpacaUnderlyings() {
  if (!optionState.dataReady) {
    $("#optionUniverseStatus").textContent =
      "Alpaca keys are not configured on the server, so optionability cannot be verified. US-listed symbols remain searchable.";
    return;
  }
  const generation = optionState.generation;
  $("#optionUniverseStatus").textContent =
    "Discovering all Alpaca optionable US underlyings…";
  try {
    const r = await fetch("/api/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "universe",
        }),
        signal: AbortSignal.timeout(30000),
      }),
      data = await r.json();
    if (!r.ok) throw Error(data.error || "Asset discovery failed");
    if (generation !== optionState.generation) return;
    if (!Array.isArray(data.assets))
      throw Error("Invalid asset directory response");
    optionState.assets = data.assets;
    optionState.assetsVerified = true;
    renderUnderlyingSuggestions();
    $("#optionUniverseStatus").textContent =
      data.assets.length.toLocaleString() +
      " Alpaca optionable underlyings loaded · " +
      data.source +
      ". The fetched chain confirms currently available contracts. Search any symbol or company name.";
  } catch (e) {
    if (generation === optionState.generation)
      $("#optionUniverseStatus").textContent =
        "Alpaca catalogue unavailable: " + e.message;
  }
}
function occForLeg(l) {
  const root = l.symbol.replace(/\s/g, ""),
    date = l.expiry.slice(2).replaceAll("-", ""),
    strike = Math.round(l.strike * 1000);
  if (
    !/^[A-Z.]{1,6}$/.test(root) ||
    !/^[0-9]{6}$/.test(date) ||
    !Number.isFinite(strike) ||
    strike <= 0 ||
    strike >= 1e8
  )
    throw Error(
      "Leg " + l.symbol + " cannot be represented as a standard OCC contract.",
    );
  return (
    root +
    date +
    (l.type === "call" ? "C" : "P") +
    String(strike).padStart(8, "0")
  );
}
function showMarketMark() {
  const legs = optionState.legs;
  if (!legs.length) return;
  let value = Finance.premiumCash(legs, Number($("#optionCommission").value)),
    missing = [],
    stale = false;
  for (const l of legs) {
    const q = legQuote(l);
    if (q?.mid == null) {
      missing.push(l.symbol);
      continue;
    }
    value += (l.side === "buy" ? 1 : -1) * q.mid * l.qty * l.multiplier;
    if (!q.quoteTime || Date.now() - Date.parse(q.quoteTime) > 120000)
      stale = true;
  }
  $("#optionMarkPnl").textContent = missing.length
    ? "Provider midpoint P&L unavailable: missing valid quotes for " +
      [...new Set(missing)].join(", ")
    : "Provider midpoint P&L: " +
      money(value) +
      " · " +
      optionState.feed.toUpperCase() +
      " · " +
      (stale ? "STALE / market closed quotes" : "latest provider snapshots") +
      " · entry commissions included; exit costs excluded.";
}
async function refreshActiveLegs() {
  if (optionState.refreshBusy || optionState.busy) return;
  optionState.refreshBusy = true;
  const generation = optionState.generation;
  try {
    Finance.validateLegs(optionState.legs);
    const contracts = optionState.legs.map(occForLeg);
    const r = await fetch("/api/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "legs",
          contracts,
        }),
        signal: AbortSignal.timeout(30000),
      }),
      data = await r.json();
    if (!r.ok) throw Error(data.error || "Active-leg refresh failed");
    if (generation !== optionState.generation) return;
    for (const q of data.contracts)
      optionState.quoteMap[
        [q.underlying, q.expiry, q.type, q.strike].join("|")
      ] = q;
    for (const l of optionState.legs) {
      const q = legQuote(l),
        stock = data.stocks[l.symbol];
      if (l.liveSpot && stock?.price > 0) l.spot = stock.price;
      if (l.liveIv && q?.iv > 0) l.iv = q.iv;
    }
    optionState.lastLegFetch = Date.now();
    if (!$("#optionLegs").contains(document.activeElement)) renderOptionLegs();
    simulateOptions();
    showMarketMark();
    $("#optionRefreshStatus").textContent =
      "Active-leg prices, IV, and Greeks fetched " +
      new Date(data.fetchedAt).toLocaleTimeString() +
      " · " +
      data.feed.toUpperCase();
  } catch (e) {
    if (generation === optionState.generation) {
      $("#optionRefreshStatus").textContent =
        "Refresh failed: " +
        e.message +
        " · previously fetched quotes may be stale.";
      showMarketMark();
    }
  } finally {
    optionState.refreshBusy = false;
    optionState.nextFetch = Date.now() + 30000;
  }
}
$("#optionUnderlying").addEventListener("input", renderUnderlyingSuggestions);
$("#loadOptionUniverse").onclick = loadAlpacaUnderlyings;
$("#loadMoreOptionChain").onclick = () => fetchOptionChain(true);
loadPublicUnderlyings();

async function refreshOptionData() {
  if (optionState.refreshCycleBusy) return;
  optionState.refreshCycleBusy = true;
  try {
    await fetchOptionChain();
    await refreshActiveLegs();
  } finally {
    optionState.refreshCycleBusy = false;
    optionState.nextFetch = Date.now() + 30000;
  }
}

// ---- hand-offs to the other derivatives pages
$("#optionsToManual").onclick = () => {
  try {
    const legs = optionState.legs;
    const calls = legs.filter((l) => l.type === "call"), puts = legs.filter((l) => l.type === "put");
    if (legs.length !== 4 || calls.length !== 2 || puts.length !== 2 || new Set(legs.map((l) => l.expiry)).size !== 1 || new Set(legs.map((l) => l.symbol)).size !== 1)
      throw Error("The Manual Four-Leg Lab needs exactly 2 calls + 2 puts on one stock and one expiry (e.g. the Iron condor template).");
    shareOptionState();
    Deriv.set({ expiry: legs[0].expiry, manualLegs: [...calls, ...puts].map((l) => ({ type: l.type, side: l.side, strike: l.strike, qty: l.qty, premium: Number.isFinite(l.premium) ? l.premium : null, delta: legQuote(l)?.greeks?.delta ?? null, iv: l.iv > 0 ? +(l.iv * 100).toFixed(2) : null, contract: legQuote(l)?.symbol })), manualFrom: "Options Studio" });
    location.href = "/manual";
  } catch (e) {
    $("#optionError").textContent = e.message;
  }
};
$("#optionExpiry").addEventListener("change", () => Deriv.set({ expiry: $("#optionExpiry").value }));
$("#optionFarExpiry").addEventListener("change", () => Deriv.set({ farExpiry: $("#optionFarExpiry").value }));
window.addEventListener("viewchange", (e) => {
  if (e.detail !== "options") return;
  const st = Deriv.get();
  if (st.ticker && st.ticker !== $("#optionUnderlying").value.trim().toUpperCase() && document.activeElement !== $("#optionUnderlying")) {
    $("#optionUnderlying").value = st.ticker;
    $("#optionUnderlying").onchange();
  }
  if (st.expiry && st.expiry > isoDay(new Date())) $("#optionExpiry").value = st.expiry;
});
(async () => {
  const st0 = Deriv.get();
  if (st0.ticker && /^[A-Z][A-Z0-9.]{0,9}$/.test(st0.ticker)) $("#optionUnderlying").value = st0.ticker;
  if (st0.expiry && st0.expiry > isoDay(new Date())) { $("#optionExpiry").value = st0.expiry; $("#scenarioDate").value = st0.expiry; }
  if (st0.farExpiry && st0.farExpiry > isoDay(new Date())) $("#optionFarExpiry").value = st0.farExpiry;
  const st = await Deriv.status();
  renderProviderStatus(st);
  optionState.dataReady = !!(st.alpaca?.configured || st.fallback);
  $("#connectionStatus").textContent = optionState.dataReady
    ? "Server options data available · press “Fetch chain”."
    : "Not connected: " + (st.message || "Alpaca keys missing on the server.") + " Manual input mode is available.";
  if (optionState.dataReady) loadAlpacaUnderlyings();
})();
