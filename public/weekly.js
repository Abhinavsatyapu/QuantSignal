// Weekly Plan page: account settings, realistic-odds panel, plan builder (sizes ×1/×2/×3), weekly P&L tracker, export/import.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const usd = (x, d = 0) => (x == null || !Number.isFinite(x) ? "—" : (x < 0 ? "−$" : "$") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = (x, d = 0) => (x == null || !Number.isFinite(x) ? "—" : (x * 100).toFixed(d) + "%");
  const cls = (x) => (x > 0 ? "pos" : x < 0 ? "neg" : "");
  const api = async (u, body, method) => { const r = await fetch("/api" + u, body !== undefined ? { method: method || "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}); const j = await r.json().catch(() => ({ error: "HTTP " + r.status })); if (!r.ok) throw Error(j.error || "HTTP " + r.status); return j; };
  let acct = null, universe = [], plan = null, tab = null;
  const fields = ["capital", "weeklyTargetMin", "weeklyTargetMax", "targetPerLotSet", "defaultLotSets", "maxLossPerTrade", "maxWeeklyLoss", "maxDeployPct", "maxConcurrent", "maxPairCorrelation", "maxPerSector", "riskSigma"];
  function fillAcct(a) {
    acct = a; const f = $("wAcct");
    for (const k of fields) f.elements[k].value = a[k];
    f.elements.targetMode.value = a.targetMode; f.elements.tickerTargets.value = Object.entries(a.tickerTargets || {}).map(([k, v]) => k + "=" + v).join(", ");
    $("wPerLot").textContent = a.targetPerLotSet.toLocaleString("en-US"); honest();
  }
  function readAcct() {
    const f = $("wAcct"), o = {}; for (const k of fields) o[k] = f.elements[k].value; o.targetMode = f.elements.targetMode.value; o.tickerTargets = {};
    for (const p of f.elements.tickerTargets.value.split(/[,;\s]+/).filter(Boolean)) { const [k, v] = p.split("="); if (!k || !v) throw Error("Per-ticker targets look like NVDA=500"); o.tickerTargets[k.toUpperCase()] = Number(v); }
    return o;
  }
  $("wSave").onclick = async (e) => { e.preventDefault(); try { fillAcct(await api("/strategy/account", readAcct(), "PUT")); $("wAcctMsg").textContent = "Saved."; } catch (x) { $("wAcctMsg").textContent = x.message; } };
  $("wReset").onclick = async () => { try { fillAcct(await api("/strategy/account", acct.defaults, "PUT")); $("wAcctMsg").textContent = "Defaults restored."; } catch (x) { $("wAcctMsg").textContent = x.message; } };
  function honest() {
    if (!acct) return; const wk = acct.weeklyTargetMin / acct.capital, wk2 = acct.weeklyTargetMax / acct.capital;
    const p = plan && tab != null ? plan.plans.find((x) => x.multiplier === tab) : null, c = p && p.combined;
    const lossWeek = c ? c.probLossOverLimit : null, n13 = lossWeek != null ? 1 - (1 - lossWeek) ** 13 : null;
    $("wHonestBody").innerHTML = `<p><b>${(wk * 100).toFixed(1)}–${(wk2 * 100).toFixed(1)}% a week</b> is ≈ ${Math.round(wk * 5200)}–${Math.round(wk2 * 5200)}% a year simple, ${Math.round(((1 + wk) ** 52 - 1) * 100).toLocaleString("en-US")}%+ compounded — far beyond what professional funds sustain. Treat it as a stretch goal, never as an expected or guaranteed result.</p>` +
      (c ? `<div class="b-metrics">${[["P(week ≥ " + usd(acct.weeklyTargetMin) + ")", pct(c.probHitMin, 1), "Share of simulated weeks where the plan's combined expiry P&L reaches the weekly minimum."], ["P(week ≥ " + usd(acct.weeklyTargetMax) + ")", pct(c.probHitMax, 1), "Same for the upper end of the range."], ["P(profitable week)", pct(c.probProfit), "Combined P&L > 0 at expiry."], ["Expected value", usd(c.expectedValue), "Mean combined P&L across the simulations (risk-neutral, before your edge)."], ["Bad week (5th pct)", usd(c.p5), "1 week in 20 is this bad or worse."], ["P(loss ≥ weekly cap)", pct(lossWeek, 1), "Chance one week loses the full weekly cap."], ["…over 13 weeks", pct(n13, 0), "Chance of at least one such week in a quarter (independent weeks)."]].map(([k, v, t]) => `<div class="m"><span data-tip="${esc(t)}" tabindex="0">${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div><p class="market-note">${esc(c.model)}. Hold-to-expiry; exiting early at the CE/PE strikes usually pays less than the expiry projection.</p>`
        : `<p class="market-note">Build a plan to see the probability of reaching the weekly target, the expected value and the drawdown risk.</p>`);
  }
  // universe chips
  // liquidity cell: worst leg grade + the market-fill slippage vs the structure target (flags in the tooltip)
  function liqCell(s) {
    const q = s.liquidity; if (!q) return s.liquidityFlags.length ? `<span class="neg" data-tip="${esc(s.liquidityFlags.join(" · "))}" tabindex="0">liquidity ⚠</span>` : "—";
    const tip = [q.verdict === "OK" ? "Liquid enough" : q.verdict === "CAUTION" ? "Thin market" : "Too illiquid for this target", "legs: " + q.counts.Good + " good / " + q.counts.Thin + " thin / " + q.counts.Illiquid + " illiquid", ...s.liquidityFlags].join(" · ");
    return `<span class="liq-chip liq-${esc(q.worstGrade.toLowerCase())}" data-tip="${esc(tip)}" tabindex="0">${esc(q.worstGrade)}</span> ${usd(q.marketSlippage)}${q.shareOfTarget != null ? " (" + Math.round(q.shareOfTarget * 100) + "%)" : ""}`;
  }
  function drawUni() { $("wUniverse").innerHTML = universe.map((u) => `<span class="w-chip">${esc(u.ticker)}<small>${esc(u.sector)}</small><button aria-label="Remove ${esc(u.ticker)}" data-t="${esc(u.ticker)}">×</button></span>`).join("") || '<div class="empty-state">No tickers — add some.</div>'; for (const b of $("wUniverse").querySelectorAll("button")) b.onclick = () => { universe = universe.filter((u) => u.ticker !== b.dataset.t); drawUni(); }; }
  $("wAddBtn").onclick = () => { const t = $("wAdd").value.trim().toUpperCase(); if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(t)) { $("wStatus").textContent = "Enter a valid ticker."; return; } if (!universe.some((u) => u.ticker === t)) universe.push({ ticker: t, sector: "Other" }); $("wAdd").value = ""; drawUni(); };
  $("wAdd").addEventListener("keydown", (e) => { if (e.key === "Enter") $("wAddBtn").click(); });
  $("wRun").onclick = async () => {
    const mult = $("wMult").value.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 20);
    if (!mult.length) { $("wStatus").textContent = "Size multipliers are whole numbers, e.g. 1,2,3"; return; }
    $("wRun").disabled = true; $("wStatus").textContent = "";
    $("wResult").hidden = true; $("wProg").hidden = false; $("wProgFill").style.width = "0%"; $("wProgList").innerHTML = "";
    $("wProgText").textContent = "Starting the plan for " + universe.length + " tickers…";
    const LABEL = { queued: "waiting", starting: "starting", fetching: "fetching quotes", optimizing: "optimising + what-if", done: "done", error: "failed", timeout: "timed out", skipped: "skipped" };
    const showProg = (j) => {
      const pctDone = j.total ? Math.round(j.done / j.total * 100) : 0, secs = Math.round(j.elapsedMs / 1000), busy = j.tickers.filter((t) => ["starting", "fetching", "optimizing"].includes(t.status)).map((t) => t.ticker);
      const bad = j.tickers.filter((t) => ["error", "timeout", "skipped"].includes(t.status)).length;
      $("wProgFill").style.width = pctDone + "%"; $("wProg").querySelector(".w-prog-bar").setAttribute("aria-valuenow", String(pctDone));
      $("wProgText").textContent = (j.phase === "combining" ? "All tickers analysed — combining the plan…" : j.done + " of " + j.total + " tickers analysed" + (busy.length ? " · now: " + busy.join(", ") : "")) + " · " + secs + " s" + (bad ? " · " + bad + " skipped / failed (see per-ticker progress)" : "");
      $("wProgList").innerHTML = j.tickers.map((t) => `<span class="w-prog-t st-${esc(t.status)}" title="${esc(t.detail || "")}"><b>${esc(t.ticker)}</b> ${esc(LABEL[t.status] || t.status)}${t.detail && t.status !== "queued" && t.status !== "fetching" ? " · " + esc(String(t.detail).slice(0, 80)) : ""}</span>`).join("");
    };
    try {
      let j = await api("/strategy/weekly-plan/jobs", { tickers: universe.map((u) => ({ ticker: u.ticker, sector: u.sector })), lotSets: mult });
      const t0 = Date.now(); let misses = 0;
      while (j.state === "running") {
        showProg(j);
        if (Date.now() - t0 > 12 * 60e3) throw new Error("The plan is taking longer than 12 minutes — the server may be overloaded. Try again with fewer tickers.");
        await new Promise((r) => setTimeout(r, 1500));
        try { j = await api("/strategy/weekly-plan/jobs/" + encodeURIComponent(j.jobId)); misses = 0; }
        catch (e) { if (/no longer on the server/.test(e.message) || ++misses >= 8) throw e; } // brief network blips are retried
      }
      showProg(j);
      if (j.state === "error") throw new Error(j.error || "The plan failed on the server.");
      plan = j.result; tab = plan.recommendedLotSets ?? plan.plans[0].multiplier; $("wResult").hidden = false; drawPlan();
      const failed = plan.tickers.filter((t) => t.status === "ERROR").length;
      $("wStatus").textContent = "Plan #" + plan.planId + " saved · " + Object.keys(plan.runIds || {}).length + " ticker runs saved · built in " + Math.round((plan.elapsedMs || j.elapsedMs) / 1000) + " s" + (plan.cached ? " (cached result, < 10 min old)" : "") + (failed ? " · " + failed + " ticker" + (failed > 1 ? "s" : "") + " skipped (see Tickers)" : "");
      $("wProg").hidden = true;
    }
    catch (e) { $("wResult").hidden = false; $("wStructs").innerHTML = `<tbody><tr><td><div class="error-state">${esc(e.message)}</div></td></tr></tbody>`; $("wProgText").textContent = "Stopped: " + e.message; }
    finally { $("wRun").disabled = false; }
  };
  function drawPlan() {
    const p = plan.plans.find((x) => x.multiplier === tab) || plan.plans[0];
    $("wTabs").innerHTML = plan.plans.map((x) => `<button role="tab" aria-selected="${x.multiplier === p.multiplier}" class="${x.multiplier === p.multiplier ? "active" : ""}" data-m="${x.multiplier}">Size ×${x.multiplier}${x.multiplier === plan.recommendedLotSets ? " ★" : ""}<small>${x.fits} structures · ${usd(x.targetSum)}</small></button>`).join("");
    for (const b of $("wTabs").querySelectorAll("button")) b.onclick = () => { tab = Number(b.dataset.m); drawPlan(); };
    $("wSummary").innerHTML = (p.multiplier === plan.recommendedLotSets ? "<b>★ Recommended size.</b> " : "") + esc(p.summary);
    const A = plan.account, L = plan.limits, c = p.combined;
    $("wTotals").innerHTML = [["Capital used", usd(p.capitalUsed) + " / " + usd(A.capital), p.capitalUsed > A.capital, "Margin + options capital of all selected structures vs your account."], ["Combined max loss", usd(-p.combinedMaxLoss) + " / cap " + usd(-L.weeklyLossRemaining), p.combinedMaxLoss > L.weeklyLossRemaining, "Sum of each structure's worst P&L inside ±" + A.riskSigma + "σ vs the remaining weekly loss budget."], ["Targets sum", usd(p.targetSum) + " vs " + usd(A.weeklyTargetMin) + "–" + usd(A.weeklyTargetMax), p.targetSum < A.weeklyTargetMin, "Sum of each structure's exit target."], ["P(week ≥ min)", c ? pct(c.probHitMin, 1) : "—", false, "Simulated, correlated, hold to expiry."], ["Expected value", c ? usd(c.expectedValue) : "—", false, ""], ["5th percentile week", c ? usd(c.p5) : "—", false, "Drawdown risk: 1 week in 20 is this bad or worse."]]
      .map(([k, v, bad, t]) => `<div class="m ${bad ? "bad" : ""}"><span data-tip="${esc(t)}" tabindex="0">${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
    $("wStructs").innerHTML = "<thead><tr><th>Ticker</th><th>Sector</th><th>Expiry</th><th>Side · ratio</th><th>Legs</th><th>Hedge qty</th><th>Lot sets</th><th>Target</th><th>CE / PE exit</th><th>Capital</th><th>Max loss (vs " + usd(A.maxLossPerTrade) + ")</th><th>Reward : risk</th><th>P(profit)</th><th>Liquidity · market-fill cost</th><th></th></tr></thead><tbody>" +
      (p.structures.map((s) => `<tr><td><b>${esc(s.ticker)}</b></td><td>${esc(s.sector)}</td><td>${esc(s.expiry)}</td><td>${esc(s.side)} · ${esc(s.variant)}</td><td class="mono">${s.legs.map((l) => (l.side === "buy" ? "+" : "−") + l.qty + " " + l.strike + (l.type === "call" ? "C" : "P")).join(" ")}</td><td class="num">${s.perpQty > 0 ? "+" : ""}${s.perpQty} ${esc(s.hedge === "stock" ? "sh" : "perp")}</td><td class="num">${s.lotSets}${s.targetAdjusted ? ' <span data-tip="Per-lot-set target was not reachable on this expiry; lots were sized to reach the total instead." tabindex="0">⚠</span>' : ""}</td><td class="num">${usd(s.target)}</td><td class="num"><span class="${cls(s.exits.up)}">${usd(s.exits.up)}</span> / <span class="${cls(s.exits.down)}">${usd(s.exits.down)}</span></td><td class="num">${usd(s.capital)}</td><td class="num ${s.riskLoss > A.maxLossPerTrade ? "neg" : ""}">${usd(-s.riskLoss)}</td><td class="num">${s.rewardToRisk != null ? s.rewardToRisk.toFixed(2) : "—"}</td><td class="num">${pct(s.probProfit)}</td><td>${liqCell(s)}</td><td><a href="/builder?ticker=${encodeURIComponent(s.ticker)}&expiry=${encodeURIComponent(s.expiry)}&lots=${s.lotSets}${s.runId ? "&run=" + s.runId : ""}">Open</a></td></tr>`).join("") || `<tr><td colspan="15"><div class="empty-state">No structure fits the limits at this size.</div></td></tr>`) + "</tbody>";
    $("wGrid").innerHTML = c ? "<thead><tr><th>Move</th>" + c.commonMoveGrid.map((g) => `<th>${g.move > 0 ? "+" : ""}${g.move}%</th>`).join("") + "</tr></thead><tbody><tr><th>Combined</th>" + c.commonMoveGrid.map((g) => `<td class="${cls(g.pnl)}">${usd(g.pnl)}</td>`).join("") + "</tr></tbody>" : "";
    $("wPairs").innerHTML = p.pairs.length ? p.pairs.map((x) => `${esc(x.a)}/${esc(x.b)} <b class="${Math.abs(x.rho) > plan.account.maxPairCorrelation ? "neg" : ""}">${x.rho.toFixed(2)}</b> <small>(${esc(x.source)})</small>`).join(" · ") : "—";
    $("wSkipped").innerHTML = "<thead><tr><th>Ticker</th><th>Sector</th><th>Why not selected</th></tr></thead><tbody>" + (p.skipped.map((s) => `<tr><td>${esc(s.ticker)}</td><td>${esc(s.sector)}</td><td>${esc(s.why.join("; "))}</td></tr>`).join("") || '<tr><td colspan="3">—</td></tr>') + "</tbody>";
    const rankOf = (t) => (plan.liquidityRank || []).find((r) => r.ticker === t);
    $("wTickers").innerHTML = "<thead><tr><th>Ticker</th><th>Sector</th><th>Expiry</th><th>Hedge</th><th>Status</th><th>Option liquidity (rank)</th><th>Reason</th></tr></thead><tbody>" + plan.tickers.map((t) => { const r = rankOf(t.ticker), cl = t.liquidity && t.liquidity.chain;
      return `<tr><td>${esc(t.ticker)}</td><td>${esc(t.sector)}</td><td>${esc(t.expiry || "—")}${t.liquidity && t.liquidity.expiryNote ? ` <span data-tip="${esc(t.liquidity.expiryNote)}" tabindex="0">ⓘ</span>` : ""}</td><td>${esc(t.hedge || "—")}</td><td class="${t.status === "OK" ? "pos" : "neg"}">${esc(t.status)}</td><td>${cl ? `<span class="liq-chip liq-${esc(cl.grade.toLowerCase())}">${esc(cl.grade)}</span> ${cl.medianSpreadPct != null ? "median spread " + cl.medianSpreadPct.toFixed(1) + "%" : ""}${r ? " · #" + r.rank : ""}` : "—"}</td><td>${esc(t.reason || (t.liquidity && t.liquidity.verdict && t.liquidity.verdict.verdict !== "OK" ? t.liquidity.verdict.text : ""))}</td></tr>`; }).join("") + "</tbody>";
    honest();
  }
  async function weeks() {
    try {
      const w = await api("/strategy/weekly-pnl");
      $("wWeeks").innerHTML = "<thead><tr><th>Week of (Mon, NY)</th><th>Realised</th><th>Target</th><th>Closed trades</th><th>Result</th></tr></thead><tbody>" + w.weeks.map((g) => `<tr><td>${esc(g.week)}${g.week === w.currentWeek ? " (this week)" : ""}</td><td class="num ${cls(g.realised)}">${usd(g.realised)}</td><td class="num">${usd(g.targetMin)}–${usd(g.targetMax)}</td><td class="num">${g.runs.length}</td><td>${g.runs.length ? (g.hit ? '<span class="pos">target hit</span>' : g.breachedLossLimit ? '<span class="neg">weekly loss cap breached</span>' : "below target") : "—"}</td></tr>`).join("") + "</tbody>";
      $("wWeeksNote").textContent = w.summary.weeksWithResults ? `${w.summary.weeksHitTarget}/${w.summary.weeksWithResults} past weeks hit the target · total realised ${usd(w.summary.totalRealised)}.` : "No closed trades yet. Mark runs as Taken and close them with fills in History to track weekly results.";
    } catch (e) { $("wWeeks").innerHTML = `<tbody><tr><td><div class="error-state">${esc(e.message)}</div></td></tr></tbody>`; }
  }
  $("wImport").onchange = async () => { const f = $("wImport").files[0]; if (!f) return; try { const j = JSON.parse(await f.text()); const r = await api("/strategy/import", j); $("wImportMsg").textContent = `Imported ${r.runs} runs (${r.skipped} already present), ${r.weights} model versions${r.account ? ", settings" : ""}.`; load(); } catch (e) { $("wImportMsg").textContent = "Import failed: " + e.message; } $("wImport").value = ""; };
  async function load() {
    try { fillAcct(await api("/strategy/account")); } catch (e) { $("wAcctMsg").textContent = e.message; }
    try { if (!universe.length) { universe = (await api("/strategy/universe")).universe; drawUni(); } } catch (e) { $("wUniverse").innerHTML = `<div class="error-state">${esc(e.message)}</div>`; }
    weeks();
    api("/strategy/storage").then((s) => ($("wStorage").innerHTML = `<b>${s.durable ? "Durable (Postgres)" : s.backend === "postgres" ? "Postgres — degraded" : "Not durable (local SQLite)"}</b> · ${esc(s.note)} · ${s.runs} runs stored${s.lastSaved ? " · last synced " + new Date(s.lastSaved).toLocaleTimeString() : ""}${s.lastError ? ' · <span class="neg">' + esc(s.lastError) + "</span>" : ""}`)).catch(() => {});
  }
  load();
})();
