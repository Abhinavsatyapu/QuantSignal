const el = (id) => document.getElementById(id),
  fmt = (n) =>
    n == null
      ? "Unbounded"
      : new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(n),
  cash = (n) => "$" + fmt(n);
let result = null,
  busy = false,
  version = 0,
  autoArmed = false;
const types = ["call", "call", "put", "put"],
  sides = ["sell", "buy", "buy", "sell"];
el("legs").innerHTML = types
  .map(
    (type, i) =>
      `<tr data-type="${type}"><td>${type.toUpperCase()}</td><td><select aria-label="${type} leg ${i + 1} side"><option value="${sides[i]}">${sides[i].toUpperCase()}</option><option value="${sides[i] === "buy" ? "sell" : "buy"}">${sides[i] === "buy" ? "SELL" : "BUY"}</option></select></td><td><input aria-label="Leg ${i + 1} strike" type="number" min="0.01" step="0.01"></td><td><input aria-label="Leg ${i + 1} contracts" type="number" min="1" step="1" value="${i < 2 ? 2 : 4}"></td><td><input aria-label="Leg ${i + 1} premium" type="number" min="0" step="0.01"></td><td><input aria-label="Leg ${i + 1} signed delta" type="number" min="${type === "call" ? 0 : -1}" max="${type === "call" ? 1 : 0}" step="0.0001"></td><td><input aria-label="Leg ${i + 1} IV" type="number" min="0" step="0.01"></td></tr>`,
  )
  .join("");
function clear() {
  autoArmed = false;
  version++;
  result = null;
  el("results").style.display = "none";
  el("status").textContent = "Inputs changed · calculate again.";
}
document.querySelectorAll("input,select").forEach((x) => {
  if (x.id !== "auto") x.addEventListener("input", clear);
});
el("mode").onchange = () => {
  el("target").disabled = el("mode").value !== "target";
  el("futureQty").disabled = el("mode").value !== "manual";
};
async function json(url, body) {
  const r = await fetch(
      url,
      body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20000),
          }
        : {},
    ),
    d = await r.json();
  if (!r.ok) throw Error(d.error || "Data unavailable");
  return d;
}
function draw(points) {
  const c = el("chart"),
    ctx = c.getContext("2d"),
    w = c.width,
    h = c.height,
    p = 55,
    min = Math.min(...points.map((v) => v.net), 0),
    max = Math.max(...points.map((v) => v.net), 0),
    lo = points[0].stock,
    hi = points.at(-1).stock,
    xx = (s) => p + ((s - lo) / (hi - lo)) * (w - 2 * p),
    yy = (v) => h - p - ((v - min) / Math.max(max - min, 1)) * (h - 2 * p);
  ctx.clearRect(0, 0, w, h);
  ctx.font = "13px sans-serif";
  ctx.strokeStyle = "#475569";
  ctx.fillStyle = "#cbd5e1";
  ctx.beginPath();
  ctx.moveTo(p, yy(0));
  ctx.lineTo(w - p, yy(0));
  ctx.stroke();
  ctx.fillText(cash(max), 5, p);
  ctx.fillText(cash(min), 5, h - p);
  ctx.fillText("Stock expiry price " + cash(lo), p, h - 12);
  ctx.fillText(cash(hi), w - p - 70, h - 12);
  ctx.strokeStyle = "#818cf8";
  ctx.lineWidth = 3;
  ctx.beginPath();
  points.forEach((v, i) =>
    i ? ctx.lineTo(xx(v.stock), yy(v.net)) : ctx.moveTo(xx(v.stock), yy(v.net)),
  );
  ctx.stroke();
}
function table(head, rows) {
  return (
    "<table><thead><tr>" +
    head.map((s) => "<th>" + s + "</th>").join("") +
    "</tr></thead><tbody>" +
    rows
      .map(
        (r) => "<tr>" + r.map((v) => "<td>" + v + "</td>").join("") + "</tr>",
      )
      .join("") +
    "</tbody></table>"
  );
}
function render(r) {
  el("results").style.display = "block";
  el("reference").textContent =
    r.symbol +
    " · live perp mid " +
    cash(r.perpMid) +
    " · stock reference " +
    cash(r.reference) +
    " · book " +
    new Date(r.bookTime).toLocaleString() +
    " · expiry " +
    r.expiry +
    " · manual option data unchanged";
  el("metrics").innerHTML = [
    ["Options signed delta", fmt(r.optionDelta) + " shares"],
    ["Futures " + r.futureSide, fmt(Math.abs(r.futureQty)) + " units"],
    ["Combined delta", fmt(r.netDelta) + " shares"],
    ["5× futures margin estimate", cash(r.margin)],
    [
      "Net option " + (r.credit >= 0 ? "credit" : "debit"),
      cash(Math.abs(r.credit)),
    ],
    ["Futures executable reference", cash(r.futureEntry)],
  ]
    .map(
      ([k, v]) =>
        '<div class="metric"><span>' + k + "</span><h3>" + v + "</h3></div>",
    )
    .join("");
  el("formula").textContent =
    "Options Δ = Σ(side sign × contracts × 100 × signed delta). Futures = target Δ − options Δ, rounded to venue quantity precision; manual mode uses your quantity. Option entry fees " +
    cash(r.optionEntryFees) +
    "; futures entry fee " +
    cash(r.futuresEntryFee) +
    ".";
  el("legAnalysis").innerHTML = table(
    [
      "Leg",
      "Strike",
      "Contracts",
      "Entry premium",
      "Position share delta",
      "Premium cash flow",
      "IV",
    ],
    r.legs.map((l) => [
      l.side.toUpperCase() + " " + l.type.toUpperCase(),
      cash(l.strike),
      fmt(l.qty),
      cash(l.premium),
      fmt(l.positionDelta),
      cash(l.premiumCashFlow),
      l.iv == null ? "Not entered" : fmt(l.iv) + "%",
    ]),
  );
  el("spread").innerHTML = table(
    ["Pair", "Net premium cash flow", "Structure"],
    r.spreads.map((s) => [
      s.type.toUpperCase(),
      (s.netCredit >= 0 ? "Credit " : "Debit ") + cash(Math.abs(s.netCredit)),
      s.paired
        ? "Equal-quantity vertical pair"
        : "Unequal quantities / sides; inspect uncovered exposure",
    ]),
  );
  el("bounds").textContent =
    "OPTIONS ONLY: max profit " +
    cash(r.optionsBounds.maxProfit) +
    " · max loss " +
    cash(r.optionsBounds.maxLoss) +
    " · breakevens " +
    (r.optionsBreakevens.map(cash).join(", ") || "None") +
    ". COMBINED: max profit " +
    cash(r.combinedBounds.maxProfit) +
    " · max loss " +
    cash(r.combinedBounds.maxLoss) +
    " · breakevens " +
    (r.combinedBreakevens.map(cash).join(", ") || "None") +
    ". Bounds use the stated fixed-basis expiry model; margin is not a loss limit.";
  draw(r.points);
  const marks = r.points.filter(
    (p, i) =>
      i % 10 === 0 ||
      r.legs.some((l) => l.strike === p.stock) ||
      p.stock === r.reference,
  );
  el("payoff").innerHTML = table(
    [
      "Stock at expiry",
      "Perp at expiry",
      "Options gross",
      "Futures gross",
      "Combined net",
    ],
    marks.map((p) => [
      cash(p.stock),
      cash(p.perp),
      cash(p.options),
      cash(p.futures),
      cash(p.net),
    ]),
  );
  el("warnings").replaceChildren(
    ...r.warnings.map((w) => {
      const li = document.createElement("li");
      li.textContent = w;
      return li;
    }),
  );
}
async function calculate() {
  if (busy) return;
  busy = true;
  const gen = version;
  el("calculate").disabled = true;
  el("results").style.display = "none";
  result = null;
  el("status").textContent =
    "Server validating inputs and fetching the live Hyperliquid book…";
  try {
    const legs = [...el("legs").children].map((row) => {
      const a = row.querySelectorAll("input");
      return {
        type: row.dataset.type,
        side: row.querySelector("select").value,
        strike: a[0].value,
        qty: a[1].value,
        premium: a[2].value,
        delta: a[3].value,
        iv: a[4].value,
      };
    });
    const r = await json("/api/manual-four-leg", {
      symbol: el("symbol").value,
      expiry: el("expiry").value,
      legs,
      mode: el("mode").value,
      target: el("target").value,
      qty: el("futureQty").value,
      basis: el("basis").value,
      commission: el("commission").value,
      feePct: el("feePct").value,
    });
    if (gen !== version) return;
    result = r;
    autoArmed = true;
    render(r);
    el("status").textContent =
      "Calculated on the server " +
      new Date().toLocaleTimeString() +
      ". Live perp; manually entered options. No orders submitted.";
  } catch (e) {
    if (gen === version) el("status").textContent = e.message;
  } finally {
    busy = false;
    el("calculate").disabled = false;
  }
}
el("calculate").onclick = calculate;
el("download").onclick = () => {
  if (!result) return;
  const a = document.createElement("a"),
    url = URL.createObjectURL(
      new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
    );
  a.href = url;
  a.download = "manual-four-leg-calculation.json";
  a.click();
  URL.revokeObjectURL(url);
};
json("/api/stream/universe?scope=stocks")
  .then((d) => {
    el("symbol").replaceChildren(
      new Option("Select a stock perp", ""),
      ...d.symbols.map((s) => new Option(s, s)),
    );
    prefillFromShared(d.symbols);
  })
  .catch((e) => (el("status").textContent = e.message));
setInterval(() => {
  if (el("auto").checked && !document.hidden && autoArmed) calculate();
}, 30000);

// ---- shared derivatives state: legs sent from Options Studio / Live Hedge Compare, and hand-off to Sheet Lab
function prefillFromShared(symbols) {
  const st = Deriv.get();
  const perp = Deriv.perpFor(st.ticker, symbols);
  if (perp) el("symbol").value = perp;
  if (st.expiry && st.expiry >= new Date().toISOString().slice(0, 10)) el("expiry").value = st.expiry;
  const legs = st.manualLegs;
  if (Array.isArray(legs) && legs.length === 4) {
    [...el("legs").children].forEach((row, i) => {
      const l = legs[i], a = row.querySelectorAll("input");
      if (!l || l.type !== row.dataset.type) return;
      row.querySelector("select").value = l.side;
      a[0].value = l.strike ?? "";
      a[1].value = l.qty ?? "";
      a[2].value = l.premium ?? "";
      a[3].value = l.delta ?? "";
      a[4].value = l.iv ?? "";
    });
    const missing = legs.some((l) => l.premium == null) ? " Some premiums are blank: enter your execution prices." : "";
    const noDelta = legs.some((l) => l.delta == null) ? " Some deltas are blank (no provider Greeks loaded): enter them from your broker." : "";
    el("prefillNote").textContent = "Legs prefilled from " + (st.manualFrom || "another page") + (perp ? " · " + perp : "") + "." + missing + noDelta;
    if (st.manualFuture && st.manualFuture.symbol === perp) {
      el("mode").value = "manual";
      el("mode").onchange();
      el("futureQty").value = st.manualFuture.signedQty;
    }
  } else if (perp) el("prefillNote").textContent = "Stock perp " + perp + " and expiry carried over from the other derivatives pages.";
}
el("symbol").addEventListener("change", () => Deriv.set({ ticker: Deriv.tickerOf(el("symbol").value) }));
el("expiry").addEventListener("change", () => Deriv.set({ expiry: el("expiry").value }));
el("toSheetLab").onclick = () => {
  if (!result) return;
  Deriv.set({
    ticker: Deriv.tickerOf(result.symbol),
    expiry: result.expiry,
    position: {
      from: "Manual Four-Leg Lab",
      symbol: result.symbol,
      entry: result.futureEntry,
      signedQty: result.futureQty,
      optionDelta: result.optionDelta,
      legs: result.legs.map((l, i) => {
        const src = (Deriv.get().manualLegs || [])[i];
        return { side: l.side, type: l.type, qty: l.qty, premium: l.premium, strike: l.strike, contract: src && src.strike == l.strike ? src.contract : undefined };
      }),
    },
  });
  location.href = "/sheet-lab#current-position";
};
