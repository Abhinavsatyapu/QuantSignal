(() => {
  const $ = (id) => document.getElementById(id),
    f = $("positionForm"),
    cash = (n) =>
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(n),
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
      );
  let revision = 0,
    busy = false,
    last = null;
  $("cpLegs").innerHTML =
    "<table><thead><tr><th>Leg</th><th>BUY / SELL</th><th>OCC symbol / label</th><th>Contracts</th><th>Multiplier</th><th>Actual entry premium</th><th>Current close premium · manual</th></tr></thead><tbody>" +
    [0, 1, 2, 3]
      .map(
        (i) =>
          `<tr><td>${i + 1}</td><td><select id="cpSide${i}"><option value="buy">BUY / long</option><option value="sell">SELL / short</option></select></td><td><input id="cpOcc${i}" placeholder="Exact OCC for live quotes"></td><td><input id="cpContracts${i}" type="number" min="1" step="1"></td><td><input id="cpMultiplier${i}" type="number" min="1" step="1" value="100"></td><td><input id="cpEntry${i}" type="number" min="0" step="any"></td><td><input id="cpClose${i}" type="number" min="0" step="any"></td></tr>`,
      )
      .join("") +
    "</tbody></table>";
  function mode() {
    const legs = $("cpOptions").value !== "pnl",
      live = $("cpOptions").value === "alpaca",
      manual = $("cpSource").value === "manual";
    $("cpLegPanel").hidden = !legs;
    $("cpCredentials").hidden = !live;
    $("cpPnlLabel").hidden = legs;
    $("cpPnl").required = !legs;
    $("cpPnl").disabled = legs;
    $("cpAfterFeesLabel").hidden = legs;
    if (legs) $("cpAfterFees").checked = false;
    $("cpPriceLabel").hidden = !manual;
    $("cpPrice").required = manual;
    $("cpPrice").disabled = !manual;
    for (let i = 0; i < 4; i++) {
      for (const name of ["Contracts", "Multiplier", "Entry"]) {
        $("cp" + name + i).required = legs;
        $("cp" + name + i).disabled = !legs;
      }
      $("cpSide" + i).disabled = !legs;
      $("cpOcc" + i).disabled = !legs;
      $("cpOcc" + i).required = live;
      $("cpClose" + i).disabled = !legs || live;
      $("cpClose" + i).required = legs && !live;
    }
  }
  function invalidate() {
    revision++;
    last = null;
    $("cpResults").hidden = true;
    $("cpStatus").textContent =
      "Inputs changed. Reconcile again with current quotes.";
    mode();
  }
  f.addEventListener("input", invalidate);
  f.addEventListener("change", invalidate);
  mode();
  // Prefill from the Manual Four-Leg Lab / Live Hedge hand-off (only into empty fields).
  (() => {
    const pos = Deriv.get().position;
    if (!pos || $("cpSymbol").value) return;
    $("cpSymbol").value = pos.symbol || "";
    if (pos.entry > 0) $("cpEntry").value = pos.entry;
    if (Number.isFinite(pos.signedQty) && pos.signedQty !== 0) $("cpQty").value = pos.signedQty;
    if (Array.isArray(pos.legs) && pos.legs.length === 4) {
      $("cpOptions").value = "manualLegs";
      pos.legs.forEach((l, i) => {
        $("cpSide" + i).value = l.side;
        $("cpContracts" + i).value = l.qty;
        if (l.premium != null) $("cpEntry" + i).value = l.premium;
        if (l.contract) $("cpOcc" + i).value = l.contract;
      });
    }
    mode();
    $("cpStatus").textContent = "Prefilled from " + (pos.from || "another derivatives page") + ": verify your actual fills, then enter current close premiums (or choose live Alpaca bid/ask with OCC symbols).";
  })();
  function collect() {
    return {
      symbol: $("cpSymbol").value.trim(),
      priceSource: $("cpSource").value,
      optionSource: $("cpOptions").value,
      entry: $("cpEntry").value,
      signedQty: $("cpQty").value,
      multiplier: $("cpMult").value,
      currentPrice: $("cpPrice").value,
      optionPnl: $("cpPnl").value,
      optionPnlAfterFees: $("cpAfterFees").checked,
      futuresFees: $("cpFutFees").value,
      optionCosts: $("cpOptFees").value,
      funding: $("cpFunding").value,
      otherCosts: $("cpOther").value,
      legs: [0, 1, 2, 3].map((i) => ({
        side: $("cpSide" + i).value,
        symbol: $("cpOcc" + i).value,
        contracts: $("cpContracts" + i).value,
        multiplier: $("cpMultiplier" + i).value,
        entry: $("cpEntry" + i).value,
        close: $("cpClose" + i).value,
      })),
    };
  }
  function render(r) {
    $("cpResults").hidden = false;
    $("cpMetrics").innerHTML = [
      ["Options P&L", r.optionPnl],
      ["Futures gross P&L", r.futureGross],
      ["Net costs · positive deducted", r.costs],
      ["Combined NET P&L estimate", r.net],
    ]
      .map(
        ([name, value]) =>
          '<div class="metric"><small>' +
          name +
          '</small><strong class="' +
          (value < 0 ? "negative" : value > 0 ? "positive" : "neutral") +
          '">' +
          cash(value) +
          "</strong></div>",
      )
      .join("");
    $("cpEquation").textContent =
      "Futures: " +
      r.formula +
      ". Combined: options " +
      cash(r.optionPnl) +
      " + futures " +
      cash(r.futureGross) +
      " − signed costs " +
      cash(r.costs) +
      " = " +
      cash(r.net) +
      ". Costs = futures fees " +
      cash(r.futuresFees) +
      " + option costs " +
      cash(r.optionCosts) +
      " + funding " +
      cash(r.funding) +
      " + other " +
      cash(r.otherCosts) +
      ".";
    $("cpQuote").textContent =
      (r.quote
        ? r.quote.source +
          " · exchange timestamp " +
          new Date(r.quote.quoteTime).toLocaleString() +
          " · bid " +
          r.quote.bid +
          " / ask " +
          r.quote.ask
        : "Manually entered futures price · not live verified") +
      " · valuation price " +
      r.currentPrice +
      " · calculated " +
      new Date(r.calculatedAt).toLocaleString() +
      ".";
    $("cpLegResult").innerHTML = r.legs.length
      ? "<table><thead><tr><th>Leg</th><th>Signed contracts</th><th>Entry premium</th><th>Close premium</th><th>Entry cash flow</th><th>Closing cash flow</th><th>Options P&L</th><th>Quote time</th></tr></thead><tbody>" +
        r.legs
          .map(
            (l, i) =>
              "<tr>" +
              [
                esc(l.symbol || "Leg " + (i + 1)),
                l.signedContracts,
                cash(l.entry),
                cash(l.close),
                cash(l.entryCash),
                cash(l.closingCash),
                cash(l.pnl),
                l.quoteTime
                  ? esc(new Date(l.quoteTime).toLocaleString())
                  : "Manual",
              ]
                .map((t) => "<td>" + t + "</td>")
                .join("") +
              "</tr>",
          )
          .join("") +
        "</tbody></table>"
      : "";
    $("cpWarnings").textContent = r.warnings.join(" ");
    Deriv.set({ position: { ...(Deriv.get().position || {}), symbol: r.symbol, entry: r.entry, signedQty: r.signedQty } });
  }
  async function calculate(auto = false) {
    if (busy) return;
    if (!f.reportValidity()) {
      if (auto) $("cpAuto").checked = false;
      return;
    }
    busy = true;
    const version = revision;
    $("cpCalculate").disabled = true;
    $("cpResults").hidden = true;
    last = null;
    $("cpStatus").textContent =
      "Fetching selected quotes and reconciling in the backend…";
    try {
      const res = await fetch("/api/position-pnl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collect()),
        signal: AbortSignal.timeout(35000),
      });
      const r = await res.json();
      if (!res.ok) throw Error(r.error || "Position calculation unavailable.");
      if (version !== revision) return;
      last = r;
      render(r);
      $("cpStatus").textContent =
        "Current open-book estimate calculated. Only actual fills establish realized P&L.";
    } catch (e) {
      if (version === revision) {
        $("cpResults").hidden = true;
        $("cpStatus").textContent = "No current result: " + e.message;
      }
    } finally {
      busy = false;
      $("cpCalculate").disabled = false;
    }
  }
  f.onsubmit = (e) => {
    e.preventDefault();
    calculate();
  };
  setInterval(() => {
    if ($("cpAuto").checked && !document.hidden) calculate(true);
  }, 30000);
  // Results are kept on screen but flagged once their quotes age (previously they were hidden after 15 s).
  setInterval(() => {
    if (!last) return;
    const notes = [];
    if (last.quote && Date.now() - Date.parse(last.quote.quoteTime) > 15000)
      notes.push("Futures quote is " + Math.round((Date.now() - Date.parse(last.quote.quoteTime)) / 1000) + " s old");
    if (last.optionSource === "alpaca" && last.legs.some((l) => !l.quoteTime || Date.now() - Date.parse(l.quoteTime) > 60000))
      notes.push("one or more option quotes are over 60 s old (market closed or indicative feed)");
    $("cpStale").textContent = notes.length ? "STALE · " + notes.join(" · ") + ". Reconcile again for a current estimate." : "";
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && $("cpAuto").checked) calculate(true);
  });
})();
