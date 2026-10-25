let ratioResult = null,
  ratioBusy = false,
  ratioNext = Infinity,
  ratioInputVersion = 0;
$("#ratioExpiry").value = futureFriday(7);
function ratioClear() {
  ratioResult = null;
  for (const id of [
    "ratioMetrics",
    "ratioLegs",
    "ratioSpreads",
    "ratioPayoff",
    "ratioTicket",
    "ratioAssumptions",
  ])
    $("#" + id).innerHTML = "";
  for (const id of [
    "ratioSignal",
    "ratioReference",
    "ratioRisk",
    "ratioFormulas",
    "ratioBounds",
  ])
    $("#" + id).textContent = "";
  $("#ratioExport").disabled = true;
  $("#ratioCopy").disabled = true;
  $("#ratioValidity").textContent = "NO VALID SNAPSHOT";
  const c = $("#ratioChart").getContext("2d");
  c?.clearRect(0, 0, 1000, 360);
}
function ratioPayload() {
  const map = {
      callLots: "ratioCallLots",
      directionalPct: "ratioAdvantage",
      equity: "ratioEquity",
      capital: "ratioCapital",
      maxLoss: "ratioMaxLoss",
      maxSpreadPct: "ratioSpread",
      commission: "ratioCommission",
      feePct: "ratioFee",
      slippagePct: "ratioSlippage",
      targetR: "ratioTargetR",
      minStopPct: "ratioMinStop",
    },
    numeric = {};
  for (const [k, id] of Object.entries(map)) {
    if (!String($("#" + id).value).trim())
      throw Error(
        "Account equity, allocation and maximum planned loss are required",
      );
    numeric[k] = Number($("#" + id).value);
  }
  return {
    ...numeric,
    symbol: $("#ratioSymbol").value,
    near: $("#ratioExpiry").value,
    far: $("#ratioExpiry").value,
    interval: $("#ratioInterval").value,
    strategy: $("#ratioStrategy").value,
    allowStale: Deriv.allowStale(),
  };
}
async function ratioCalculate() {
  if (ratioBusy) return;
  ratioBusy = true;
  const version = ratioInputVersion;
  ratioClear();
  $("#ratioStatus").textContent =
    "Server fetching fresh candles, complete chain, Greeks and order-book depth…";
  try {
    if (!(await Deriv.dataReady()))
      throw Error(
        "Options data is not configured on the server (ALPACA_KEY_ID / ALPACA_SECRET_KEY). See Options Studio → Options data.",
      );
    const body = ratioPayload(),
      response = await fetch("/api/ratio-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
      });
    if (
      response.redirected ||
      !response.headers.get("Content-Type")?.includes("application/json")
    )
      throw Error(
        "Site sign-in or a non-JSON response blocked the backend calculation",
      );
    const data = await response.json();
    if (version !== ratioInputVersion) return;
    if (!response.ok) throw Error(data.error || "Live setup blocked");
    if (data.status === "WAIT") {
      $("#ratioSignal").textContent =
        "WAIT · " + data.reason + " · " + data.symbol;
      $("#ratioReference").textContent =
        "Live perp mid " +
        quotePrice(data.reference.perpMid) +
        " · " +
        new Date(data.reference.bookTime).toLocaleString();
      $("#ratioStatus").textContent =
        "No indicator-qualified directional setup. No quantities or legs are issued.";
      return;
    }
    if (data.status !== "CALCULATED" || data.legs?.length !== 4)
      throw Error("Invalid server calculation");
    ratioResult = data;
    ratioRender();
    $("#ratioStatus").textContent =
      "Calculated on this server from " + (data.provider || "provider data") + (data.quoteState && data.quoteState !== "fresh" ? " · " + data.quoteState : "") + ". Review the snapshot, account inputs and actual exchange quotes before manual entry. No orders were sent.";
    Deriv.set({ ticker: Deriv.tickerOf(data.symbol), expiry: data.expiry });
  } catch (e) {
    if (version === ratioInputVersion) {
      ratioClear();
      $("#ratioStatus").textContent = "Setup blocked: " + e.message;
    }
  } finally {
    ratioBusy = false;
    ratioNext = Date.now() + 30000;
  }
}
function ratioRender() {
  const r = ratioResult;
  if (!r) return;
  const d = r.direction,
    checks = [
      "Trend EMA/SMA",
      "MACD",
      "RSI",
      "Volume",
      "EMA slope",
      "ADX/DMI",
      "VWAP",
      "OBV",
    ];
  $("#ratioSignal").textContent =
    `${r.symbol} · ${d} · ${r.analysis.score}/8 rules · candle ${new Date(r.analysis.closedAt).toLocaleString()} · ${r.analysis.checks.map((pass, i) => checks[i] + ": " + (pass ? "PASS" : "FAIL")).join(" · ")} · candle confirmation ${r.analysis.candleConfirmed ? "PASS" : "FAIL"}`;
  $("#ratioMetrics").innerHTML = [
    [
      "Futures " + (d === "LONG" ? "BUY" : "SELL") + " quantity",
      r.orderPreview.futures.quantity.toFixed(r.szDecimals) + " units",
    ],
    ["Neutral hedge", r.neutralFutureQty.toFixed(4) + " units"],
    ["Directional increment", r.directionalIncrement.toFixed(4) + " units"],
    ["Net share delta", r.netDelta.toFixed(4)],
    ["5× futures margin", money(r.margin)],
    ["Planned combined risk", money(r.plannedCombinedRisk)],
  ]
    .map(
      ([k, v]) => `<article><span>${k}</span><strong>${v}</strong></article>`,
    )
    .join("");
  $("#ratioReference").textContent =
    `Actual current reference: Hyperliquid bid ${quotePrice(r.reference.perpBid)}, ask ${quotePrice(r.reference.perpAsk)}, mid ${quotePrice(r.reference.perpMid)} at ${new Date(r.reference.bookTime).toLocaleString()} · stock ${quotePrice(r.reference.stock)} at ${r.reference.stockTime ? new Date(r.reference.stockTime).toLocaleString() : "unavailable"} (${escapeHtml(r.provider || "")}) · observed side-price/stock basis ${quotePrice(r.reference.basis)} · available futures depth within entry limit ${r.availableFuturesDepth.toFixed(r.szDecimals)} units`;
  $("#ratioRisk").textContent =
    `SL ${quotePrice(r.stop)} · futures target ${quotePrice(r.target)} · ${r.netFutureRR.toFixed(2)}R after modeled costs. Option max loss ${money(r.optionRisk)} + futures stop risk ${money(r.futureStopRisk)} = ${money(r.plannedCombinedRisk)} against ${money(r.budget)} budget. Gaps, liquidation and changing basis can exceed this planned loss.`;
  $("#ratioLegs").innerHTML =
    '<table class="stream-table"><thead><tr><th>Leg / contract</th><th>Strike / expiry</th><th>Lots / signed units</th><th>Provider entry premium</th><th>Premium cash</th><th>Δ / contribution</th><th>Γ / Θ / Vega / IV</th><th>Bid/ask size &amp; time</th></tr></thead><tbody>' +
    r.legs
      .map(
        (l) =>
          `<tr><td>${l.side.toUpperCase()} ${l.type.toUpperCase()}<small>${escapeHtml(l.contract)}</small></td><td>${l.strike}<small>${l.expiry}</small></td><td>${l.qty} / ${l.signedUnits}</td><td>${quotePrice(l.premium)} · ${l.side === "buy" ? "ASK" : "BID"}</td><td>${money(l.premiumCash)}</td><td>${l.quote.greeks.delta.toFixed(4)} / ${l.deltaContribution.toFixed(4)}</td><td>${l.quote.greeks.gamma.toFixed(4)} / ${l.quote.greeks.theta.toFixed(4)} / ${l.quote.greeks.vega.toFixed(4)} / ${(l.iv * 100).toFixed(2)}%</td><td>${l.quote.bidSize ?? "—"} / ${l.quote.askSize ?? "—"}<small>${l.quote.quoteTime ? new Date(l.quote.quoteTime).toLocaleString() : "—"}${Deriv.isStale(l.quote) ? " · STALE" : ""}</small></td></tr>`,
      )
      .join("") +
    "</tbody></table>";
  $("#ratioSpreads").innerHTML =
    r.spreads
      .map(
        (s) =>
          `<article><span>${s.type.toUpperCase()} ${s.classification} · ${s.lots} lots · width ${s.width}</span><strong>${money(Math.abs(s.cash))}</strong></article>`,
      )
      .join("") +
    `<article><span>Net premium before commission</span><strong>${money(r.netPremiumBeforeCommission)}</strong></article><article><span>Entry commission</span><strong>${money(r.entryCommission)}</strong></article><article><span>Net opening cash</span><strong>${money(r.openingCash)}</strong></article>`;
  $("#ratioFormulas").textContent =
    `Option delta ${r.optionDelta.toFixed(4)} = sum of signed delta contributions. Neutral futures = −option delta; final signed futures ${r.future.qty.toFixed(r.szDecimals)} includes your directional increment and venue rounding. ${Object.entries(
      r.formula,
    )
      .map(([k, v]) => k + ": " + v)
      .join(" · ")}`;
  $("#ratioPayoff").innerHTML =
    '<table class="stream-table"><thead><tr><th>Stock move</th><th>Stock / perp scenario</th><th>Expiry options</th><th>Futures gross</th><th>Futures fees</th><th>Combined expiry</th><th>Current-time model</th></tr></thead><tbody>' +
    r.model
      .map(
        (m) =>
          `<tr><td>${m.shockPct}%</td><td>${quotePrice(m.stock)} / ${quotePrice(m.perp)}</td><td>${money(m.options)}</td><td>${money(m.futureGross)}</td><td>${money(m.futureFees)}</td><td>${money(m.combined)}</td><td>${m.currentTimeModel == null ? "Unavailable" : money(m.currentTimeModel)}</td></tr>`,
      )
      .join("") +
    "</tbody></table>";
  $("#ratioBounds").textContent =
    `Combined expiry extrema under constant basis: max profit ${r.bounds.profitUnbounded ? "UNBOUNDED" : money(r.bounds.maxProfit)}; max loss ${r.bounds.lossUnbounded ? "UNBOUNDED" : money(r.bounds.maxLoss)}. Break-evens ${r.bounds.breakEvens.map(quotePrice).join(", ") || "none / flat interval possible"}. These include costs but no funding or forced liquidation.`;
  $("#ratioTicket").innerHTML =
    `<p class="market-note">Manual preview only · ${r.strategy === "condor" ? "ratio iron condor" : "sheet directional hedge"} · ${r.callLots} call lots / ${r.putLots} put lots on each corresponding leg. Use actual exchange limit prices and verify available balance. Futures entry estimate ${quotePrice(r.future.entry)} includes the entered slippage allowance.</p>`;
  $("#ratioAssumptions").innerHTML = r.assumptions
    .map((t) => '<p class="market-note">' + escapeHtml(t) + "</p>")
    .join("");
  ratioDraw(r.curve);
  ratioValidity();
}
function ratioValidity() {
  const valid = ratioResult && Date.now() < ratioResult.quoteExpiresAt;
  $("#ratioValidity").textContent = !ratioResult
    ? "NO SNAPSHOT"
    : valid
      ? "SNAPSHOT · " +
        Math.ceil((ratioResult.quoteExpiresAt - Date.now()) / 1000) +
        "s"
      : "EXPIRED · REFRESH";
  $("#ratioExport").disabled = !valid;
  $("#ratioCopy").disabled = !valid;
}
function ratioDraw(points) {
  const canvas = $("#ratioChart"),
    c = canvas.getContext("2d");
  if (!c || !points.length) return;
  const W = canvas.width || 1000,
    H = canvas.height || 360,
    min = Math.min(0, ...points.map((p) => p.combined)),
    max = Math.max(0, ...points.map((p) => p.combined)),
    y = (v) => H - 35 - ((v - min) / (max - min || 1)) * (H - 70);
  c.clearRect(0, 0, W, H);
  c.strokeStyle = "#5f8cff";
  c.beginPath();
  points.forEach((p, i) => {
    const x = 60 + (i / (points.length - 1)) * (W - 80);
    i ? c.lineTo(x, y(p.combined)) : c.moveTo(x, y(p.combined));
  });
  c.stroke();
  c.fillStyle = "#aab7ce";
  c.fillText(money(max), 4, 20);
  c.fillText(money(min), 4, H - 20);
  c.fillText("Stock price · combined expiry payoff", W / 3, H - 5);
}
async function ratioLoadSymbols() {
  try {
    const data = await streamJson("/api/stream/universe?scope=stocks"),
      prior = $("#ratioSymbol").value;
    $("#ratioSymbol").innerHTML = data.symbols
      .map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)
      .join("");
    const shared = Deriv.perpFor(Deriv.get().ticker, data.symbols);
    $("#ratioSymbol").value = shared || (data.symbols.includes(prior)
      ? prior
      : data.symbols.find((s) => s === "xyz:HOOD") || data.symbols[0]);
    const ex = Deriv.get().expiry;
    if (ex && ex > isoDay(new Date())) $("#ratioExpiry").value = ex;
  } catch (e) {
    $("#ratioStatus").textContent = "Stock directory unavailable: " + e.message;
  }
}
function ratioChanged() {
  ratioInputVersion++;
  if ($("#ratioSymbol").value) Deriv.set({ ticker: Deriv.tickerOf($("#ratioSymbol").value), expiry: $("#ratioExpiry").value });
  $("#ratioPutLots").value = String(Number($("#ratioCallLots").value) * 2);
  ratioClear();
  $("#ratioStatus").textContent =
    "Inputs changed. Fetch a new backend calculation.";
  ratioNext = Date.now() + 30000;
}
for (const id of [
  "ratioSymbol",
  "ratioExpiry",
  "ratioCallLots",
  "ratioStrategy",
  "ratioInterval",
  "ratioEquity",
  "ratioCapital",
  "ratioMaxLoss",
  "ratioAdvantage",
  "ratioTargetR",
  "ratioMinStop",
  "ratioSpread",
  "ratioCommission",
  "ratioFee",
  "ratioSlippage",
])
  $("#" + id).onchange = ratioChanged;
$("#ratioCalculate").onclick = ratioCalculate;
$("#ratioLoadSymbols").onclick = ratioLoadSymbols;
$("#ratioConnect").onclick = () =>
  document.querySelector('[data-view="options"]').click();
$("#ratioCopy").onclick = async () => {
  if (!ratioResult || Date.now() >= ratioResult.quoteExpiresAt) return;
  await navigator.clipboard.writeText(
    JSON.stringify(ratioResult.orderPreview, null, 2),
  );
  $("#ratioStatus").textContent =
    "Manual order preview copied. No exchange orders sent.";
};
$("#ratioExport").onclick = () => {
  if (!ratioResult || Date.now() >= ratioResult.quoteExpiresAt) return;
  const blob = new Blob([JSON.stringify(ratioResult, null, 2)], {
      type: "application/json",
    }),
    a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ratio-live-calculation.json";
  a.click();
  URL.revokeObjectURL(a.href);
};
setInterval(() => {
  if (activeView !== "ratio" || document.hidden) return;
  ratioValidity();
  if ($("#ratioAuto").checked && !ratioBusy && Date.now() >= ratioNext)
    ratioCalculate();
}, 1000);
window.addEventListener("viewchange", (e) => {
  if (e.detail === "ratio") {
    ratioLoadSymbols();
    ratioValidity();
  }
});
if (location.pathname === "/ratio")
  document.querySelector('[data-view="ratio"]').click();
