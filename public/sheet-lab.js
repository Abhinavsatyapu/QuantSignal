const S = (id) => document.getElementById(id),
  keys = ["dayUp", "dayDown", "expiryUp", "expiryDown"],
  labels = [
    "1 day · upside",
    "1 day · downside",
    "Expiry · upside",
    "Expiry · downside",
  ],
  money = (n) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(n),
  units = (n) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(n),
  esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    ),
  tone = (n) => (n > 0 ? "positive" : n < 0 ? "negative" : "neutral");
let scenarioResult = null,
  revision = 0,
  auditData = null,
  originalLoaded = false,
  originalPromise = null;
S("scenarioInputs").innerHTML = keys
  .map(
    (key, i) =>
      `<article class="scenario-input"><span class="tag">${i < 2 ? "ONE-DAY ESTIMATE" : "EXPIRY ESTIMATE"}</span><h3>${labels[i]}</h3><label>Options book P&amp;L ($)<input id="${key}Option" type="number" step="any" required placeholder="Signed gain or loss"></label><label>Scenario perp / futures price ($)<input id="${key}Price" type="number" min="0" step="any" required placeholder="Scenario futures exit price"></label><label>Separate option costs ($)<input id="${key}Costs" type="number" min="0" step="any" value="0" required></label><label>Funding cost / credit ($)<input id="${key}Funding" type="number" step="any" value="0" required></label><label>Other costs ($)<input id="${key}Other" type="number" min="0" step="any" value="0" required></label></article>`,
  )
  .join("");
const fields = [...S("scenarioForm").querySelectorAll("input,select")];
function save() {
  try {
    if (!S("scSave").checked) {
      localStorage.removeItem("quantsignal.sheetScenario.v1");
      return;
    }
    localStorage.setItem(
      "quantsignal.sheetScenario.v1",
      JSON.stringify(
        Object.fromEntries(
          fields.map((x) => [
            x.id,
            x.type === "checkbox" ? x.checked : x.value,
          ]),
        ),
      ),
    );
  } catch {
    S("scStatus").textContent =
      "Browser storage unavailable. Calculations remain available in this tab.";
  }
}
function invalidate() {
  revision++;
  scenarioResult = null;
  S("scResults").hidden = true;
  S("scStatus").textContent =
    "Inputs changed · calculate again to refresh all results.";
  save();
}
try {
  const saved = JSON.parse(
    localStorage.getItem("quantsignal.sheetScenario.v1") || "null",
  );
  if (saved)
    for (const x of fields)
      if (Object.hasOwn(saved, x.id)) {
        if (x.type === "checkbox") x.checked = saved[x.id] === true;
        else if (typeof saved[x.id] === "string") x.value = saved[x.id];
      }
} catch {}
fields.forEach((x) => x.addEventListener("input", invalidate));
// Prefill the futures position from the Manual Four-Leg Lab hand-off (only when the form is empty).
(() => {
  const pos = globalThis.Deriv?.get().position;
  if (!pos || S("scSymbol").value) return;
  S("scSymbol").value = pos.symbol || "";
  if (Number.isFinite(pos.signedQty) && pos.signedQty !== 0) {
    S("scSide").value = pos.signedQty < 0 ? "short" : "long";
    S("scQty").value = String(Math.abs(pos.signedQty));
  }
  if (pos.entry > 0) S("scEntry").value = pos.entry;
  if (Number.isFinite(pos.optionDelta)) {
    S("scDelta").value = pos.optionDelta;
    S("scTarget").value = "0";
  }
  S("scStatus").textContent = "Futures position prefilled from " + (pos.from || "another derivatives page") + ". Enter your four scenario option P&Ls and perp prices.";
})();
function collect() {
  return {
    symbol: S("scSymbol").value,
    side: S("scSide").value,
    entry: S("scEntry").value,
    qty: S("scQty").value,
    multiplier: S("scMultiplier").value,
    leverage: S("scLeverage").value,
    step: S("scStep").value,
    feePct: S("scFee").value,
    baskets: S("scBaskets").value,
    basketLoss: S("scBasketLoss").value,
    minimumNet: S("scMinimum").value,
    optionDelta: S("scDelta").value,
    targetDelta: S("scTarget").value,
    optionPnlAfterFees: S("scAfterFees").checked,
    scenarios: keys.map((key) => ({
      key,
      optionPnl: S(key + "Option").value,
      futurePrice: S(key + "Price").value,
      optionCosts: S(key + "Costs").value,
      funding: S(key + "Funding").value,
      otherCosts: S(key + "Other").value,
    })),
  };
}
async function api(path, body) {
  const r = await fetch(
    path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        }
      : { signal: AbortSignal.timeout(15000) },
  );
  let data;
  try {
    data = await r.json();
  } catch {
    throw Error(
      "Server returned an invalid response. Reopen the signed-in site.",
    );
  }
  if (!r.ok) throw Error(data.error || "Calculation unavailable");
  return data;
}
function table(head, rows) {
  return (
    "<table><thead><tr>" +
    head.map((x) => "<th>" + esc(x) + "</th>").join("") +
    "</tr></thead><tbody>" +
    rows
      .map(
        (r) => "<tr>" + r.map((x) => "<td>" + x + "</td>").join("") + "</tr>",
      )
      .join("") +
    "</tbody></table>"
  );
}
function pnl(n) {
  return '<span class="' + tone(n) + '">' + money(n) + "</span>";
}
function render(r) {
  S("scResults").hidden = false;
  S("scResultTitle").textContent =
    r.symbol +
    " · " +
    r.input.side.toUpperCase() +
    " " +
    units(Math.abs(r.signedQty)) +
    " units";
  S("scMetrics").innerHTML = [
    ["Worst of these four cases", r.minimumObservedNet],
    ["Best of these four cases", r.maximumObservedNet],
    ["Futures margin estimate", r.estimatedInitialMargin],
    ["Basket allowance per case", r.basketCost],
  ]
    .map(
      ([label, value]) =>
        '<div class="metric"><small>' +
        label +
        '</small><strong class="' +
        tone(value) +
        '">' +
        money(value) +
        "</strong></div>",
    )
    .join("");
  const max = Math.max(1, ...r.rows.map((x) => Math.abs(x.net)));
  S("scBars").innerHTML = r.rows
    .map(
      (x) =>
        '<div class="bar-row"><span>' +
        esc(x.label) +
        '</span><div class="bar-track"><i class="bar-zero"></i><i class="bar-fill ' +
        tone(x.net) +
        '" style="left:' +
        (x.net < 0 ? 50 - (Math.abs(x.net) / max) * 50 : 50) +
        "%;width:" +
        (Math.abs(x.net) / max) * 50 +
        '%"></i></div><b class="' +
        tone(x.net) +
        '">' +
        money(x.net) +
        "</b></div>",
    )
    .join("");
  S("scBreakdown").innerHTML = table(
    [
      "Scenario",
      "Options P&L input",
      "Futures price",
      "Futures gross",
      "Option costs",
      "Futures fees",
      "Funding",
      "Other costs",
      "Basket allowance",
      "NET P&L",
    ],
    r.rows.map((x) => [
      esc(x.label),
      pnl(x.optionPnl),
      money(x.futurePrice),
      pnl(x.futureGross),
      money(x.optionCosts),
      money(x.entryFee + x.exitFee),
      money(x.funding),
      money(x.otherCosts),
      money(x.basketCost),
      "<b>" + pnl(x.net) + "</b>",
    ]),
  );
  S("scEquations").replaceChildren(
    ...r.rows.map((x) => {
      const d = document.createElement("details"),
        s = document.createElement("summary"),
        c = document.createElement("code"),
        p = document.createElement("p");
      s.textContent = x.label + " · step-by-step calculation";
      c.textContent = x.formula;
      p.textContent =
        "Futures price move " +
        units(x.priceMove) +
        " × signed quantity " +
        units(x.signedQty) +
        " × multiplier " +
        units(x.multiplier) +
        " = gross " +
        money(x.futureGross) +
        ". Entry fee " +
        money(x.entryFee) +
        "; scenario exit fee " +
        money(x.exitFee) +
        ". Funding is signed: a negative cost adds to P&L.";
      d.append(s, c, p);
      return d;
    }),
  );
  S("scSizing").innerHTML = Object.entries(r.balances)
    .map(
      ([key, b]) =>
        '<article class="sizing-card"><small>' +
        (key === "day" ? "ONE-DAY BALANCE" : "EXPIRY BALANCE") +
        "</small>" +
        (b.blocked
          ? "<p>" + esc(b.blocked) + "</p>"
          : "<strong>" +
            b.side +
            " " +
            units(Math.abs(b.signedQty)) +
            "</strong><p>Resulting upside " +
            pnl(b.firstNet) +
            " · downside " +
            pnl(b.secondNet) +
            ". Difference after quantity rounding " +
            money(b.difference) +
            '.</p><button type="button" class="secondary" data-balance="' +
            key +
            '">Use this quantity in inputs</button><details><summary>How this quantity is derived</summary><p>' +
            esc(b.formula) +
            "</p><p>Unrounded signed quantity " +
            units(b.rawQty) +
            ". Positive = long; negative = short.</p></details>") +
        "</article>",
    )
    .join("");
  S("scSizing")
    .querySelectorAll("[data-balance]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          const q = r.balances[b.dataset.balance].signedQty;
          S("scSide").value = q < 0 ? "short" : "long";
          S("scQty").value = String(Number(Math.abs(q).toFixed(8)));
          invalidate();
          S("scStatus").textContent =
            "Quantity copied for analysis. Recalculate to assess all four cases. No order submitted.";
          S("scQty").focus();
        }),
    );
  const f = r.feasible;
  S("scFeasible").className = "callout" + (f.possible ? "" : " fail");
  S("scFeasible").textContent = f.possible
    ? "Scenario-feasible " +
      f.direction.toUpperCase() +
      " quantity range: " +
      units(f.minimumQty) +
      " to " +
      (f.unboundedUpper
        ? "no upper bound within these four supplied cases"
        : units(f.maximumQty)) +
      ", for minimum net " +
      money(f.minimumNet) +
      " in every case. This ignores capital constraints and says nothing about unentered scenarios."
    : "No " +
      f.direction.toUpperCase() +
      " quantity can achieve at least " +
      money(f.minimumNet) +
      " in all four supplied scenarios at the stated costs. Changing quantity alone cannot meet that criterion.";
  const d = r.delta;
  S("scDeltaResult").textContent = d
    ? "Delta comparison: current combined " +
      units(d.currentCombinedDelta) +
      " shares; target " +
      units(d.targetDelta) +
      "; required total futures " +
      (d.requiredSignedQty < 0 ? "SHORT " : "LONG ") +
      units(Math.abs(d.requiredSignedQty)) +
      "; adjustment " +
      (d.adjustmentSignedQty < 0 ? "SELL " : "BUY ") +
      units(Math.abs(d.adjustmentSignedQty)) +
      " units. Result after rounding: " +
      units(d.resultingDelta) +
      ". " +
      d.assumption
    : "No delta sizing requested. Enter both optional delta fields to compare delta sizing with scenario balancing.";
  S("scWarnings").replaceChildren(
    ...r.warnings.map((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      return li;
    }),
  );
}
S("scenarioForm").onsubmit = async (e) => {
  e.preventDefault();
  if (!S("scenarioForm").reportValidity()) return;
  const version = revision;
  S("scCalculate").disabled = true;
  S("scResults").hidden = true;
  scenarioResult = null;
  S("scStatus").textContent = "Calculating all four cases in the backend…";
  try {
    const result = await api("/api/sheet-scenarios", collect());
    if (version !== revision) return;
    scenarioResult = result;
    render(result);
    save();
    S("scStatus").textContent =
      "Backend calculation complete " +
      new Date(result.calculatedAt).toLocaleTimeString() +
      ". These are manual scenarios, not live forecasts.";
  } catch (err) {
    if (version === revision) S("scStatus").textContent = err.message;
  } finally {
    S("scCalculate").disabled = false;
  }
};
S("scClear").onclick = () => {
  if (
    !confirm(
      "Clear these calculator inputs? This does not change paper-trading or exchange positions.",
    )
  )
    return;
  S("scenarioForm").reset();
  invalidate();
};
S("scDownload").onclick = () => {
  if (!scenarioResult) return;
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(scenarioResult, null, 2)], {
        type: "application/json",
      }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = "sheet-scenario-calculation.json";
  a.click();
  URL.revokeObjectURL(url);
};
function auditRender() {
  if (!auditData) return;
  const r = auditData.rows.find((x) => x.page === Number(S("auditPage").value));
  if (!r) return;
  S("auditImage").hidden = true;
  const x = r.sourceInputs;
  S("auditDetail").innerHTML =
    "<h3>Page " +
    r.page +
    " · " +
    esc(r.symbol) +
    ' <span class="' +
    (r.status === "REPRODUCES" ? "positive" : "negative") +
    '">' +
    esc(r.status) +
    '</span></h3><p class="note">Recorded entry ' +
    money(x.futureEntry) +
    " · signed futures quantity " +
    units(x.futureQty) +
    " · upside move " +
    units(x.up) +
    " · downside move " +
    units(x.down) +
    " · basket allowance " +
    money(x.mmLoss) +
    ".</p>" +
    table(
      [
        "Case",
        "Transcribed options P&L",
        "Reconstructed net",
        "Printed net",
        "Difference",
      ],
      [
        "Today / mark upside",
        "Expiry upside",
        "Today / mark downside",
        "Expiry downside",
      ].map((label, i) => [
        label,
        money(r.sourceScenarioOptions?.[i] ?? 0),
        r.nets ? money(r.nets[i]) : "Blocked",
        money(r.printedNet?.[i] ?? 0),
        r.netDifferences ? pnl(r.netDifferences[i]) : "Blocked",
      ]),
    ) +
    table(
      [
        "Option leg",
        "Strike",
        "Contracts",
        "Signed share units",
        "Historical premium",
        "Entry cash flow",
      ],
      r.legs.map((l) => [
        l.side.toUpperCase() + " " + l.type.toUpperCase(),
        money(l.strike),
        units(l.contracts),
        units(l.units),
        l.premium == null ? "Unreadable" : money(l.premium),
        l.entryCash == null ? "Blocked" : money(l.entryCash),
      ]),
    ) +
    (r.expiry
      ? '<p class="note">Intrinsic expiry cross-check, assuming identical stock/perp moves: upside ' +
        money(r.expiry.computed[0]) +
        " versus printed " +
        money(r.expiry.printed[0]) +
        ", downside " +
        money(r.expiry.computed[1]) +
        " versus printed " +
        money(r.expiry.printed[1]) +
        ". Differences may reflect source inputs, transcription, basis or formula errors; inspect the image.</p>"
      : "") +
    (r.balances
      ? '<p class="note">Recorded futures ' +
        units(r.balances.recordedQty) +
        "; one-day equalization benchmark " +
        units(r.balances.dayQty) +
        ". The original sizing formula and Greeks are unavailable.</p>"
      : "") +
    '<ul class="note">' +
    r.issues.map((t) => "<li>" + esc(t) + "</li>").join("") +
    '</ul><p class="note">' +
    esc(r.formula || "Exact audit blocked") +
    " " +
    esc(r.confidence) +
    '</p><p class="note">The PDF’s “today” option values are mark-to-market scenarios, not proof of a full 24-hour holding period. Their exact repricing cannot be reconstructed without historical scenario premiums/IV/time inputs.</p>' +
    (r.closedSummary
      ? '<p class="note">Recorded booked P&amp;L ' +
        money(r.closedSummary[0]) +
        " + market-making P&amp;L " +
        money(r.closedSummary[1]) +
        "; printed booked total " +
        money(r.closedSummary[2]) +
        ".</p>"
      : "");
}
S("auditPage").onchange = auditRender;
S("auditOriginal").onclick = async () => {
  S("auditOriginal").disabled = true;
  try {
    if (!originalLoaded) {
      originalPromise ??= new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "/sheet-data.js";
        script.onload = () => {
          originalLoaded = true;
          resolve();
        };
        script.onerror = () => {
          originalPromise = null;
          reject(Error("Could not load original PDF images"));
        };
        document.body.append(script);
      });
      await originalPromise;
    }
    const row = SHEET_DATA.find((r) => r.page === Number(S("auditPage").value));
    if (!row) throw Error("Source page unavailable");
    S("auditImage").src = row.image;
    S("auditImage").hidden = false;
  } catch (e) {
    S("auditSummary").textContent = e.message;
  } finally {
    S("auditOriginal").disabled = false;
  }
};
api("/api/sheet-audit")
  .then((d) => {
    auditData = d;
    const match = d.rows.filter((r) => r.status === "REPRODUCES").length,
      review = d.rows.length - match;
    S("auditSummary").textContent =
      d.rows.length +
      " pages indexed · " +
      match +
      " reproduce under the stated assumptions · " +
      review +
      " have review flags. Missing per-leg premiums block exact option audits on pages 60 and 73. Source: " +
      d.source +
      ". " +
      d.sizingNote;
    S("auditPage").replaceChildren(
      ...d.rows.map(
        (r) =>
          new Option(
            "Page " + r.page + " · " + r.symbol + " · " + r.status,
            r.page,
          ),
      ),
    );
    S("auditAll").innerHTML = table(
      [
        "Page",
        "Asset",
        "Status",
        "Recorded futures",
        "Balanced-day benchmark",
        "Review notes",
      ],
      d.rows.map((r) => [
        String(r.page),
        esc(r.symbol),
        esc(r.status),
        units(r.sourceInputs.futureQty),
        r.balances ? units(r.balances.dayQty) : "Blocked",
        esc(r.issues.join(" · ") || "Reproduces under audit assumptions"),
      ]),
    );
    auditRender();
  })
  .catch(
    (e) =>
      (S("auditSummary").textContent = "PDF audit unavailable: " + e.message),
  );
