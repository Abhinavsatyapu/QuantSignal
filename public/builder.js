// Strategy Builder UI. All market data and calculations come from /api/strategy/* (server-side keys; nothing fabricated).
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const nf = (n, d = 2) => (n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const usd = (n, d = 0) => (n == null || !Number.isFinite(n) ? "—" : (n < 0 ? "−$" : "$") + nf(Math.abs(n), d));
  const cls = (n) => (n > 0 ? "pos" : n < 0 ? "neg" : "");
  const ist = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) + " IST" : "—");
  let expiriesData = null, last = null;

  async function api(path, body) {
    const r = await fetch("/api" + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    let d = null; try { d = await r.json(); } catch {}
    if (!r.ok) throw Error((d && d.error) || "HTTP " + r.status);
    return d;
  }
  // ---- provider line
  api("/strategy/provider").then((p) => {
    $("providerLine").innerHTML = p.provider === "alpaca" ? `Options data: <span class="live">Alpaca ${esc(p.optionsFeed.toUpperCase())}</span> (server-side keys) · stock feed ${esc(p.stockFeed.toUpperCase())}`
      : p.provider === "cboe" ? `Options data: <span class="stale">Cboe public DELAYED quotes</span> · Alpaca keys are not configured on the server yet. Quotes are ~15 min delayed in market hours and show the last close when the market is shut.`
      : `Options data unavailable: ${esc(p.note)}`;
  }).catch((e) => ($("providerLine").textContent = "Options data status unavailable: " + e.message));
  // ---- ticker suggestions: Hyperliquid US-stock perps first (any US ticker can be typed)
  api("/stocks").then((d) => { $("bTickers").innerHTML = d.rows.filter((r) => r.kind === "us-stock").map((r) => `<option value="${esc(r.symbol.split(":")[1])}">${esc(r.name || r.symbol)} · perp ${esc(r.symbol)}</option>`).join(""); }).catch(() => {});

  const shared = Deriv.get(), qs = new URLSearchParams(location.search);
  if (qs.get("ticker")) Deriv.set({ ticker: qs.get("ticker").toUpperCase(), ...(qs.get("expiry") ? { expiry: qs.get("expiry") } : {}) });
  if (qs.get("ticker") || shared.ticker) $("bTicker").value = (qs.get("ticker") || shared.ticker).toUpperCase();
  let account = null;
  const totalTarget = () => { const per = Number($("bTargetPer").value), L = Number($("bLotSets").value), fixed = $("bTargetMode").value === "fixed";
    $("bTotalTarget").textContent = fixed ? usd(Number($("bTarget").value)) : usd(per * L); $("bTotalNote").textContent = fixed ? "fixed total (lots sized by the optimizer)" : "= " + usd(per) + " × " + L + " lot set" + (L === 1 ? "" : "s"); };
  for (const id of ["bTargetPer", "bLotSets", "bTargetMode", "bTarget"]) $(id).addEventListener("input", totalTarget);
  const applyTickerTarget = () => { if (!account) return; const t = $("bTicker").value.trim().toUpperCase(); $("bTargetPer").value = (account.tickerTargets || {})[t] || account.targetPerLotSet; totalTarget(); };
  api("/strategy/account").then((a) => { account = a; $("bTargetMode").value = a.targetMode || "perLotSet"; $("bLotSets").value = qs.get("lots") || a.defaultLotSets || 1; applyTickerTarget(); }).catch(() => totalTarget());

  async function loadExpiries() {
    const t = $("bTicker").value.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(t)) { $("bStatus").textContent = "Enter a valid US ticker, e.g. NVDA."; return; }
    $("bTicker").value = t; applyTickerTarget(); $("bLoad").disabled = true; $("bStatus").textContent = "Loading " + t + " option chain…";
    $("bExpiry").disabled = true; $("bBuild").disabled = true;
    try {
      const d = (expiriesData = await api("/strategy/expiries?ticker=" + encodeURIComponent(t)));
      const sel = $("bExpiry"), pref = Deriv.get().expiry;
      sel.innerHTML = d.expiries.map((e) => `<option value="${e.date}">${e.date} · ${nf(e.dte, 1)} d · ${e.quoted != null ? e.quoted + "/" : ""}${e.contracts} quoted contracts</option>`).join("");
      const weekly = d.expiries.find((e) => e.dte >= 1 && e.dte <= 9); // nearest weekly (≥ 1 day so it is not a same-day expiry)
      sel.value = d.expiries.some((e) => e.date === pref) ? pref : weekly ? weekly.date : d.expiries[0].date;
      sel.disabled = false;
      $("bPerp").innerHTML = d.perp.available ? `Perp leg: <b>${esc(d.perp.symbol)}</b> on Hyperliquid · bid ${nf(d.perp.bid)} / ask ${nf(d.perp.ask)} · book ${ist(d.perp.time)} · max leverage ${d.perp.maxLeverage}×`
        : `<span class="neg">No perp leg: ${esc(d.perp.reason)}</span> The four-leg + perp methodology cannot be applied to ${esc(t)}.`;
      $("bExpiryNote").textContent = `${d.expiries.length} expiries from ${d.label}${d.snapshotTime ? " · chain snapshot " + ist(d.snapshotTime) : ""}${d.stock ? " · stock " + nf(d.stock.price) + " (" + d.stock.source + ")" : ""}. Reference sheets used 2–8 calendar-day expiries.`;
      const c = d.calibration;
      $("bCalNote").textContent = `Calibration: ${c.source} → debit long ${c.debitLongSigma}σ OTM, debit short ${c.debitShortSigma}σ, credit short ${c.creditShortSigma}σ, credit wing ${c.wingSigma}σ, perp factor ${c.futuresFactor}` + (c.history.closedRuns ? ` · ${c.history.closedRuns} recorded outcomes, median realised/expected ${nf(c.history.medianRealisedToExpected, 2)}` : " · no recorded outcomes yet");
      $("bBuild").disabled = !d.perp.available && !isOpt($("bMethod").value);
      if (!d.perp.available) $("bPerp").innerHTML += " The optimizer will hedge with the stock instead (warned in the result).";
      api("/strategy/weights").then((w) => ($("bWeights").textContent = "Scoring weights (stored, #" + w.current.id + ", " + w.current.source + "): " + Object.entries(w.current.weights).map(([k, x]) => k + " " + x).join(", ") + ". Tuning starts after " + w.minClosedForTuning + " closed runs with realised P&L.")).catch(() => {});
      Deriv.set({ ticker: t, expiry: sel.value });
      $("bStatus").textContent = "";
      loadHistory();
    } catch (e) { $("bStatus").textContent = e.message; $("bPerp").textContent = ""; $("bExpiry").innerHTML = '<option value="">—</option>'; }
    finally { $("bLoad").disabled = false; }
  }
  $("bLoad").onclick = loadExpiries;
  $("bTicker").addEventListener("keydown", (e) => { if (e.key === "Enter") loadExpiries(); });
  $("bExpiry").onchange = () => Deriv.set({ expiry: $("bExpiry").value });
  const isOpt = (m) => m === "optimizer" || m === "weekly_atr"; // weekly ATR runs on the optimizer's machinery (stock hedge fallback, what-if, scaling)
  const methodLabel = { optimizer: "Optimizer", reference: "Reference σ", delta: "Delta (1:2)", weekly_atr: "Weekly ATR" };
  const syncMethod = () => { $("bAtrFields").hidden = $("bMethod").value !== "weekly_atr"; if (expiriesData) $("bBuild").disabled = !expiriesData.perp.available && !isOpt($("bMethod").value); };
  $("bMethod").onchange = syncMethod; syncMethod();

  function cfg() {
    const v = (id) => $(id).value, n = (id) => (v(id) === "" ? null : Number(v(id)));
    const sig = v("bSignal");
    return { targetMode: v("bTargetMode"), targetPerLotSet: n("bTargetPer"), lotSets: n("bLotSets"), direction: sig === "AUTO" ? "AUTO" : sig, signal: sig === "BOTH" ? "AUTO" : sig, callLotUnits: n("bCallUnits"), putLotUnits: n("bPutUnits"), slippage: n("bSlip"), minOpenInterest: n("bMinOI"),
      marginDivisor: n("bMarginDiv"), futuresRound: n("bRound"), targetPnl: Number(v("bTarget")), capital: n("bCapital"), maxLossPct: n("bMaxLoss"), mmLoss: n("bMm"), maxSpreadPct: n("bSpread"), maxLots: n("bLots"),
      leverage: n("bLev"), commission: n("bComm"), futureFeePct: n("bFee"), debitShortSigma: v("bDebitSigma"), creditShortSigma: v("bCreditSigma"), wingSigma: v("bWingSigma"), useCalibration: $("bCal").checked,
      deltaDirection: v("bDir"), upperMult: n("bAtrUp"), lowerMult: n("bAtrDn"), atrPeriod: n("bAtrN"), atrSource: v("bAtrSrc"), scaleToExpiry: $("bAtrScale").checked };
  }
  function validate(c) {
    const e = [], m = $("bMethod").value;
    if (c.targetMode === "fixed" ? !(c.targetPnl > 0) : !(c.targetPerLotSet > 0)) e.push("Target P&L must be positive.");
    if (c.targetMode !== "fixed" && !(Number.isInteger(c.lotSets) && c.lotSets >= 1)) e.push("Lot sets must be a whole number ≥ 1.");
    if ((c.callLotUnits == null) !== (c.putLotUnits == null)) e.push("Enter both lot-ratio numbers or neither.");
    if (m === "weekly_atr") { if (!(c.upperMult > 0 && c.upperMult <= 5) || !(c.lowerMult > 0 && c.lowerMult <= 5)) e.push("Upper and lower distances must be > 0 and ≤ 5 × weekly ATR."); if (!(Number.isInteger(c.atrPeriod) && c.atrPeriod >= 2 && c.atrPeriod <= 52)) e.push("ATR period N must be a whole number 2–52."); }
    if (!isOpt(m) && !(c.capital > 0)) e.push("The reference / delta methods need a capital amount (Advanced).");
    if (c.slippage != null && !(c.slippage >= 0 && c.slippage <= 1)) e.push("Haircut must be 0–1.");
    return e;
  }
  $("bBuild").onclick = async () => {
    const c = cfg(), bad = validate(c);
    if (bad.length) { $("bStatus").textContent = bad.join(" "); return; }
    $("bBuild").disabled = true; $("bStatus").textContent = "Fetching the " + $("bExpiry").value + " chain, Hyperliquid book, indicators and events; searching strike sets and running the what-if analysis…";
    const m = $("bMethod").value; if (m === "delta") c.direction = c.deltaDirection; if (!isOpt(m)) { c.maxLossPct = c.maxLossPct ?? 50; }
    try { last = await api("/strategy/build", { ticker: $("bTicker").value, expiry: $("bExpiry").value, method: m, cfg: c }); render(last); $("bStatus").textContent = last.id ? "Saved as run #" + last.id + " (inputs, structure, alternatives, what-if summary and chain summary)." : ""; loadHistory(); }
    catch (e) { $("bStatus").textContent = e.message; }
    finally { $("bBuild").disabled = false; }
  };

  function render(d) {
    $("bResult").hidden = false;
    const b = d.best, okk = d.status === "OK";
    $("bTitle").textContent = `${d.ticker || $("bTicker").value} · ${d.expiry || $("bExpiry").value}` + (b ? (b.futuresSide ? ` · perp ${b.futuresSide}` : "") : "");
    $("bBadge").textContent = d.status.replace(/_/g, " "); $("bBadge").className = "label " + (okk ? (d.data.delayed ? "warn" : "ok") : "bad");
    const dl = d.data;
    $("bDataLine").innerHTML = `Source: ${esc(dl.label)} · quotes as of ${ist(dl.quoteTime)}${dl.ageMinutes != null ? ` (<span class="${dl.ageMinutes > 20 ? "stale" : "live"}">${dl.ageMinutes > 20 ? "STALE " : ""}${dl.ageMinutes} min old</span>)` : ""} · spot ${nf(d.spot)} (${esc(d.spotSource || dl.stockSource || "")})` + (d.perp ? ` · perp ${esc(d.perp.symbol)} mid ${nf(d.perp.mid)} · basis ${nf(d.basis)}` : "") + (d.atmIV ? ` · ATM IV ${nf(d.atmIV * 100, 1)}% · 1σ to expiry ${usd(d.expectedMove, 2)}` : "") + (d.liquidity ? ` · ${d.liquidity.usable}/${d.liquidity.listed} strikes usable` : "");
    const errs = d.errors || [];
    const exl = d.liquidity && Object.keys(d.liquidity.excluded || {}).length ? "Excluded strikes: " + Object.entries(d.liquidity.excluded).map(([k, v]) => v + " " + k).join(", ") + "." : "";
    $("bErrors").hidden = !errs.length; $("bErrors").innerHTML = errs.map(esc).join("<br>") + (errs.length && exl ? "<br>" + esc(exl) : "");
    const warns = [...(d.warnings || []), ...(d.marketNote ? [d.marketNote] : [])];
    $("bWarnings").hidden = !warns.length; $("bWarnings").innerHTML = warns.map((w) => "⚠ " + esc(w)).join("<br>");
    $("bDirection").hidden = !d.direction; if (d.direction) $("bDirection").innerHTML = "<b>Direction:</b> " + esc(d.direction.reason);
    if (!b && d.rejected && d.rejected.length) $("bErrors").innerHTML += "<br><br>Candidates rejected by the what-if gates:<br>" + d.rejected.map((r) => esc(r.futuresSide + " " + r.variant + " " + r.legs.map((l) => (l.side === "buy" ? "+" : "−") + l.qty + " " + l.strike + l.type[0].toUpperCase()).join(" ") + " → " + r.whatIf.gates.join("; "))).join("<br>");
    renderVariants(d);
    renderAtr(d);
    if (d.data && d.data.quoteTime && Deriv.quoteTime) Deriv.quoteTime(d.data.quoteTime);
    $("bBody").hidden = !b;
    $("bScale").hidden = !b || !isOpt(d.method);
    if (!b) return;
    const f = b.futures;
    $("bMetrics").innerHTML = [
      ["Net option " + (b.netCreditDebit >= 0 ? "credit" : "debit"), usd(Math.abs(b.netCreditDebit))],
      ["Perp " + (f ? f.side : "—"), f ? nf(f.qty, 3) + " × " + nf(f.entry) : "none"],
      ["Expected at up strike", usd(b.expected ? b.expected.upExpiry : b.target.pnlAtTargetPrice)],
      ["Expected at down strike", usd(b.expected ? b.expected.downExpiry : null)],
      ["Max profit (expiry)", b.unlimitedProfit ? "Unlimited" : usd(b.maxProfit)],
      ["Max loss (expiry)", b.unlimitedLoss ? "Unlimited" : usd(b.maxLoss)],
      ["Worst loss within ±2σ", usd(-b.worstLossInRiskWindow)],
      ["Total capital", usd(b.requiredCapital)],
      ["Net options theta", b.theta ? usd(b.theta.theta, 2) + "/day · " + b.theta.status : usd(b.greeks.theta, 2) + "/day"],
      ["Breakevens (expiry, before MM)", b.breakevens.map((x) => nf(x)).join(" · ") || "none"],
      ["Fees (entry)", usd(b.fees.options + b.fees.futuresEntry, 2)],
    ].map(([k, v]) => `<div class="m"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
    $("bLegs").innerHTML = "<thead><tr><th>Side</th><th>Qty</th><th>Type</th><th>Strike</th><th>Contract</th><th>Fill (bid/ask)</th><th>Bid</th><th>Ask</th><th>Spread</th><th>IV</th><th>Delta</th><th>Pos. Δ</th><th>Cash flow</th><th>OI</th></tr></thead><tbody>" +
      b.legs.map((l) => `<tr><td class="${l.side}">${l.side.toUpperCase()}</td><td>${l.qty}</td><td>${l.type.toUpperCase()}</td><td>${nf(l.strike)}</td><td>${esc(l.contract)}</td><td>${nf(l.premium)}</td><td>${nf(l.bid)}</td><td>${nf(l.ask)}</td><td>${nf(l.spreadPct, 1)}%</td><td title="${esc(l.ivSource)}">${nf(l.iv * 100, 1)}%</td><td title="${esc(l.greeksSource)}">${nf(l.greeks.delta, 3)}</td><td>${nf(l.positionDelta, 1)}</td><td class="${cls(l.cashFlow)}">${usd(l.cashFlow)}</td><td>${l.openInterest ?? "—"}</td></tr>`).join("") +
      (f ? `<tr class="fut"><td class="${f.side === "LONG" ? "buy" : "sell"}">${f.side === "LONG" ? "BUY" : "SELL"}</td><td>${nf(f.qty, 3)}</td><td>PERP</td><td>—</td><td>${esc(f.symbol)}</td><td>${nf(f.entry)}</td><td colspan="4">equalising qty ${nf(f.equalisingQty, 2)} · delta-neutral ${nf(f.deltaNeutralQty, 2)}</td><td>1.000</td><td>${nf(f.signedQty, 1)}</td><td>notional ${usd(f.notional)}</td><td>${f.minNotionalOk ? "" : "below $10 min"}</td></tr>` : "") + "</tbody>";
    const cap = b.capital;
    $("bCapitalBox").innerHTML = cap ? [["Futures notional (FQ × entry)", usd(cap.futuresNotional)], ["Futures margin (÷" + cap.marginDivisor + ")", usd(cap.futuresMargin)], ["Leverage", cap.leverage + "×"], ["Venue initial margin @" + cap.leverage + "×", usd(cap.venueInitialMargin)], ["Options capital (spread max loss)", usd(cap.optionsCapital)], ["Entry fees", usd(cap.fees, 2)], ["Total capital", usd(cap.total)]].map(([k, v]) => `<div class="m"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("") : "";
    $("bCapitalNote").textContent = cap ? cap.formula + " The reference sheets' INVESTMENT figure is not reproduced exactly by this rule (see the methodology doc)." : "";
    $("bExits").innerHTML = b.exits ? "<thead><tr><th>Exit level</th><th>Stock</th><th>Perp</th><th>P&amp;L if hit today</th><th>P&amp;L at expiry</th></tr></thead><tbody>" + b.exits.map((x) => `<tr><td>${esc(x.label)}</td><td>${nf(x.price)}</td><td>${nf(x.perp)}</td><td class="${cls(x.pnlToday)}">${usd(x.pnlToday)}</td><td class="${cls(x.pnlExpiry)}">${usd(x.pnlExpiry)}</td></tr>`).join("") + "</tbody>" : "";
    $("bTheta").className = "market-note" + (b.theta && !b.theta.ok ? " negative" : "");
    $("bTheta").textContent = b.theta ? `Lots calls ${b.callLots} : puts ${b.putLots} (${esc(b.lotRule)}, ${esc(b.lotSource)}). Net options theta ${usd(b.theta.theta, 2)}/day of ${usd(b.theta.gross, 2)} gross → ${b.theta.status}. ${b.theta.note}` : "";
    $("bThin").textContent = b.thinSize && b.thinSize.length ? "Displayed size is smaller than the order on: " + b.thinSize.join(", ") + " — expect partial fills or a worse price." : "";
    const t = b.target, reg = t.regions.map(([a, z]) => (z == null ? "above " + nf(a) : nf(a) + "–" + nf(z))).join(", ");
    $("bTargetBox").innerHTML = b.expected
      ? `The perp is sized so the book makes about the same at either short strike. If ${esc(d.ticker)} finishes at <b>${nf(b.scenarioPrices.up)}</b> (${nf((b.scenarioPrices.up / d.spot - 1) * 100, 1)}%) the expiry P&amp;L is <b class="${cls(b.expected.upExpiry)}">${usd(b.expected.upExpiry)}</b>; at <b>${nf(b.scenarioPrices.down)}</b> (${nf((b.scenarioPrices.down / d.spot - 1) * 100, 1)}%) it is <b class="${cls(b.expected.downExpiry)}">${usd(b.expected.downExpiry)}</b> (after the ${usd(b.mmLoss)} MM allowance). Unchanged at ${nf(d.spot)}: <b class="${cls(b.expected.unchangedExpiry)}">${usd(b.expected.unchangedExpiry)}</b>.<br>Target ${usd(t.pnl)} or better at expiry when the stock ends in: <b>${reg || "—"}</b> · model probability ${nf(t.probability * 100, 1)}% (risk-neutral lognormal at ATM IV; not a forecast). The reference trades were mostly closed 1–3 days after entry, before expiry; see the 1-day rows below.`
      : `Target ${usd(t.pnl)} reached at <b>${nf(t.price)}</b> (${nf(t.movePct, 1)}%, ${nf(t.sigmas, 2)}σ). Zones: ${reg}. Model probability ${nf(t.probability * 100, 1)}%.`;
    const sc = b.scenarios || [];
    $("bScen").innerHTML = "<thead><tr><th>Scenario</th><th>Stock</th><th>Perp</th><th>Net P&amp;L</th></tr></thead><tbody>" + sc.map((s) => `<tr><td>${esc(s.name)}</td><td>${nf(s.stock)}</td><td>${nf(s.perp)}</td><td class="${cls(s.pnl)}">${usd(s.pnl)}</td></tr>`).join("") + "</tbody>";
    $("bWhy").innerHTML = (b.why || []).map((w) => `<li>${esc(w)}</li>`).join("");
    const g = b.greeks;
    $("bGreeks").innerHTML = [["Net delta (shares)", nf(g.delta, 1)], ["Options delta", nf(g.optionDelta, 1)], ["Perp delta", nf(g.futuresDelta, 1)], ["Gamma (Δ per $1)", nf(g.gamma, 2)], ["Theta ($/day)", usd(g.theta, 2)], ["Vega ($ per IV pt)", usd(g.vega, 2)]].map(([k, v]) => `<div class="m"><span>${k}</span><b>${v}</b></div>`).join("");
    $("bAlts").innerHTML = "<thead><tr><th>Perp</th><th>Legs</th><th>Lots</th><th>Perp qty</th><th>Up</th><th>Down</th><th>Capital</th><th>Prob.</th></tr></thead><tbody>" +
      [b, ...(d.alternatives || [])].map((a, i) => `<tr><td>${a.futuresSide || "—"}${i ? "" : " (chosen)"}</td><td>${a.legs.map((l) => (l.side === "buy" ? "+" : "−") + l.qty + " " + nf(l.strike, 1) + l.type[0].toUpperCase()).join(" ")}</td><td>${a.callLots ?? "—"}C/${a.putLots ?? "—"}P</td><td>${a.futures ? nf(a.futures.signedQty, 2) : "—"}</td><td>${usd(a.expected ? a.expected.upExpiry : null)}</td><td>${usd(a.expected ? a.expected.downExpiry : null)}</td><td>${usd(a.requiredCapital)}</td><td>${nf(a.target.probability * 100, 1)}%</td></tr>`).join("") + "</tbody>";
    $("bOrder").textContent = d.execution ? d.execution.reason + "\n\n" + JSON.stringify({ alpaca_options_order: d.execution.alpacaOrderPreview, hyperliquid_perp: f ? { coin: f.symbol, side: f.side === "LONG" ? "buy" : "sell", size: f.qty, limit_px: f.entry } : null }, null, 2) : "";
    $("bExecute").title = d.execution ? d.execution.reason : "";
    $("bAssumptions").textContent = "Assumptions: perp − stock basis held constant to expiry; perp funding, early assignment, liquidation and the stock/perp session gap are not modelled; long legs pay the ask, short legs receive the bid; capital = spread max losses + perp margin + entry fees.";
    draw(d, b);
    renderWhatIf(d, b);
    if (isOpt(d.method)) { $("bScaleLots").value = b.lotSets; renderScale(b.lotSets); }
  }
  // ---- instant lot scaling (client-side: same quotes, Strategy.rescale = legs × k, perp re-equalised then floored to 5, full what-if)
  function renderScale(L) {
    const d = last, b = d && d.best; if (!b || !Number.isInteger(L) || L < 1) return;
    let r; try { r = Strategy.rescale(d, b, L); } catch (e) { $("bScaleOut").innerHTML = `<div class="error-state">${esc(e.message)}</div>`; return; }
    const w = r.whatIf, a = w.account, A = account || {};
    $("bScaleOut").innerHTML = `<div class="b-metrics">${[["Lot sets", r.lotSets + (r.lotSets === b.lotSets ? " (built)" : " (" + nf(r.factor, 2) + "× built)")], ["Calls : puts", r.legs.find((l) => l.type === "call").qty + " : " + r.legs.find((l) => l.type === "put").qty], ["Perp qty (floor " + (d.cfg.futuresRound || 5) + ")", (r.perpQty > 0 ? "+" : "") + r.perpQty],
        ["Target", usd(r.target) + " = " + usd(r.perLotTarget) + " × " + r.lotSets], ["CE / PE exit (total)", usd(r.exits.up) + " / " + usd(r.exits.down)], ["Per lot set", usd(r.perLotSet.up) + " / " + usd(r.perLotSet.down)], ["Capital", usd(r.capital) + (A.capital ? " · " + nf(r.capital / A.capital * 100, 0) + "% of account" : "")],
        ["Max loss (±" + a.riskSigma + "σ)", usd(-a.riskLoss) + (A.maxLossPerTrade ? " vs cap " + usd(-A.maxLossPerTrade) : "")], ["Reward : risk", a.rewardToRisk != null ? nf(a.rewardToRisk, 2) : "—"], ["P(profit)", nf(w.probs.profit * 100, 0) + "%"], ["Expected value", usd(w.probs.expectedValue)]]
      .map(([k, v]) => `<div class="m"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div>` +
      (r.flags.length ? `<div class="b-warn"><b>Not supported at this size:</b><br>${r.flags.map((f) => "⛔ " + esc(f)).join("<br>")}</div>` : `<p class="pos">Within your risk caps, capital and open interest at these strikes.</p>`) +
      (r.warnings && r.warnings.length ? `<p class="market-note">Liquidity notes: ${r.warnings.map(esc).join(" · ")}</p>` : "") +
      `<p class="market-note mono">${r.legs.map((l) => (l.side === "buy" ? "+" : "−") + l.qty + " " + l.strike + (l.type === "call" ? "C" : "P")).join("  ")}  ·  perp ${r.perpQty > 0 ? "+" : ""}${r.perpQty}</p>`;
    $("bScaleLots").value = L;
  }
  for (const btn of document.querySelectorAll("#bScale [data-mult]")) btn.onclick = () => { const b = last && last.best; if (b) renderScale(Math.max(1, Math.round(b.lotSets * Number(btn.dataset.mult)))); };
  $("bScaleLots").addEventListener("input", () => renderScale(Number($("bScaleLots").value)));
  $("bScaleSave").onclick = () => { $("bLotSets").value = $("bScaleLots").value; $("bTargetMode").value = "perLotSet"; totalTarget(); $("bBuild").click(); };
  function renderWhatIf(d, b) {
    const w = b.whatIf; $("bWhatIf").hidden = !w; if (!w) return;
    const pct = (x) => (x == null ? "—" : nf(x * 100, 0) + "%");
    $("bWiSummary").innerHTML = [["P(profit at expiry)", pct(w.probs.profit)], ["Expected value (expiry)", usd(w.probs.expectedValue)], ["P(finish ≥ CE short)", pct(w.probs.finishAboveCE)], ["P(finish ≤ PE short)", pct(w.probs.finishBelowPE)], ["P(touch CE / PE) ≈", pct(w.probs.touchCE) + " / " + pct(w.probs.touchPE)], ["P(target or better)", pct(w.probs.target)],
      ["Options theta", usd(w.theta.optionsPerDay, 2) + "/day"], ["Max loss (expiry)", w.tail.unlimitedLoss ? "Unlimited (" + w.tail.unlimitedSide + ", hedge)" : usd(-w.tail.maxLossExpiry) + " at " + nf(w.tail.maxLossAt)], ["Worst on a 2σ move", usd(w.tail.worst2Sigma)],
      ["Return on account", w.account && w.account.returnOnAccount != null ? nf(w.account.returnOnAccount * 100, 2) + "%" : "—"], ["Return on margin", w.account && w.account.returnOnMargin != null ? nf(w.account.returnOnMargin * 100, 1) + "%" : "—"],
      ["Max loss (±" + (w.account ? w.account.riskSigma : 2) + "σ)", w.account ? usd(-w.account.riskLoss) + (w.account.maxLossPctAccount != null ? " · " + nf(w.account.maxLossPctAccount, 1) + "% of account" : "") : "—"], ["Reward : risk", w.account && w.account.rewardToRisk != null ? nf(w.account.rewardToRisk, 2) : "—"],
      ["Robustness", w.robustness.positive + "/" + w.robustness.cells + " cells profitable"], ["Gates", w.acceptable ? "all passed" : w.gates.join("; ")]].map(([k, v]) => `<div class="m"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
    $("bWiGrid").innerHTML = "<thead><tr><th>Scenario</th><th>Move</th><th>Stock</th><th>Perp</th>" + w.dates.map((x) => `<th>${esc(x.label)}</th>`).join("") + "</tr></thead><tbody>" +
      w.priceGrid.map((p) => `<tr class="k-${p.kind}"><td>${esc(p.label)}</td><td>${nf(p.pct, 1)}%</td><td>${nf(p.stock)}</td><td>${nf(p.perp)}</td>${p.pnl.map((v) => `<td class="${cls(v)}">${usd(v)}</td>`).join("")}</tr>`).join("") + "</tbody>";
    const heat = () => {
      const key = $("bWiHeatDate").value === "midLife" && w.ivGrid.midLife ? "midLife" : "today", g = w.ivGrid[key], mx = Math.max(1, ...g.flat().map(Math.abs));
      $("bWiHeatTitle").textContent = "IV shock × price heatmap · " + (key === "midLife" ? w.ivGrid.midLifeLabel : "today");
      $("bWiHeat").innerHTML = "<thead><tr><th>Move ↓ · IV →</th>" + w.ivGrid.shockLabels.map((x) => `<th>${esc(x)}</th>`).join("") + "</tr></thead><tbody>" +
        w.ivGrid.moves.map((m, i) => `<tr><th>${m > 0 ? "+" : ""}${m}%</th>${g[i].map((v) => { const a = Math.min(1, Math.abs(v) / mx); return `<td style="background:${v >= 0 ? `rgba(31,199,126,${0.12 + 0.6 * a})` : `rgba(255,92,92,${0.12 + 0.6 * a})`}">${usd(v)}</td>`; }).join("")}</tr>`).join("") + "</tbody>";
    };
    $("bWiHeatDate").onchange = heat; heat();
    const c = $("bWiFlat"), x = c.getContext("2d"), W = c.width, H = c.height, P = 50, fp = w.theta.flatPath, ys = fp.map((p) => p.pnl).concat([0]), lo = Math.min(...ys), hi = Math.max(...ys), dmax = fp.at(-1).day || 1;
    const X = (v) => P + (v / dmax) * (W - 2 * P), Y = (v) => H - P / 2 - (v - lo) / Math.max(1, hi - lo) * (H - P);
    x.clearRect(0, 0, W, H); x.font = "13px Inter, sans-serif"; x.fillStyle = "#7a8597"; x.strokeStyle = "#525c6d"; x.beginPath(); x.moveTo(P, Y(0)); x.lineTo(W - P, Y(0)); x.stroke();
    x.fillText(usd(hi), 4, Y(hi) + 4); x.fillText(usd(lo), 4, Y(lo) + 4); x.fillText("day 0", P, H - 4); x.fillText("expiry (" + nf(dmax, 1) + "d)", W - P - 70, H - 4);
    x.strokeStyle = "#f2b33d"; x.lineWidth = 3; x.beginPath(); fp.forEach((p, i) => (i ? x.lineTo(X(p.day), Y(p.pnl)) : x.moveTo(X(p.day), Y(p.pnl)))); x.stroke(); x.lineWidth = 1;
    const t2 = w.tail;
    $("bWiTail").innerHTML = `<p>1σ expected move ±${usd(t2.sigma1, 2)}.</p><table class="b-table"><thead><tr><th>Move</th><th>Stock</th><th>Today</th><th>Expiry</th></tr></thead><tbody>` +
      [["+2σ", t2.sigma2.up], ["−2σ", t2.sigma2.down], ["+3σ", t2.sigma3.up], ["−3σ", t2.sigma3.down]].map(([k, v]) => `<tr><td>${k}</td><td>${nf(v.stock)}</td><td class="${cls(v.today)}">${usd(v.today)}</td><td class="${cls(v.expiry)}">${usd(v.expiry)}</td></tr>`).join("") + `</tbody></table><p class="market-note">${esc(w.probs.model)}</p>`;
    const e = w.execution;
    $("bWiExec").innerHTML = `<table class="b-table"><thead><tr><th>Fills</th><th>CE exit</th><th>PE exit</th></tr></thead><tbody><tr><td>All at mid</td><td>${usd(e.exitsAtMid.up)}</td><td>${usd(e.exitsAtMid.down)}</td></tr><tr><td>${esc(e.fillModel)} (used)</td><td>${usd(e.exitsAtHaircut.up)}</td><td>${usd(e.exitsAtHaircut.down)}</td></tr><tr><td>Full bid/ask</td><td>${usd(e.exitsAtFullSpread.up)}</td><td>${usd(e.exitsAtFullSpread.down)}</td></tr></tbody></table>` +
      `<p>Fees: options ${usd(e.fees.options, 2)}, hedge entry ${usd(e.fees.hedgeEntry, 2)}, hedge exit ≈ ${usd(e.fees.hedgeExitEst, 2)} · capital ${usd(e.capital)} (margin ${usd(e.futuresMargin)} + options ${usd(e.optionsCapital)}).</p><p>Funding: ${e.funding.estCost != null ? usd(e.funding.estCost, 2) + " to expiry at " + nf(e.funding.hourlyRate * 100, 4) + "%/h. " : ""}${esc(e.funding.note)}</p>`;
    const ev = w.events;
    $("bWiEvents").innerHTML = ev.note && !ev.source ? `<p>${esc(ev.note)}</p>` : `<p>Earnings: <b class="${ev.earningsBeforeExpiry ? "neg" : ""}">${esc(ev.earningsDate || "unknown")}</b>${ev.earningsBeforeExpiry ? " — BEFORE expiry: expect an IV crush (see the −40% column) and a gap; consider an expiry before the report." : ""}</p><p>Last/next ex-dividend: <b class="${ev.exDividendBeforeExpiry ? "neg" : ""}">${esc(ev.exDividendDate || "unknown")}</b>${ev.exDividendBeforeExpiry ? " — before expiry: early assignment risk on short calls." : ""}</p><p class="market-note">${esc(ev.source || "")}${(ev.notes || []).length ? " · " + esc(ev.notes.join("; ")) : ""}</p>`;
    $("bWiRobust").textContent = w.robustness.note + " Worst cell: " + (w.robustness.worstCell ? w.robustness.worstCell.exit + " exit, " + w.robustness.worstCell.date + ", IV " + w.robustness.worstCell.shock + "% → " + usd(w.robustness.worstCell.pnl) : "—") + ".";
  }
  function renderAtr(d) {
    const w = d.weeklyAtr; $("bAtrBox").hidden = !w; if (!w) return;
    const sg = (v) => (v >= 0 ? "+" : "−"), dist = (x) => sg(x.dollars) + usd(Math.abs(x.dollars), 2) + " · " + sg(x.pct) + nf(Math.abs(x.pct), 2) + "%" + (x.sigmas != null ? " · " + sg(x.sigmas) + nf(Math.abs(x.sigmas), 2) + "σ" : "");
    $("bAtrMetrics").innerHTML = [["Weekly ATR (N=" + w.n + ", Wilder)", usd(w.atr, 2)], ["ATR used" + (w.scaleToExpiry ? " (× √(" + w.tradingDays + "/5) = " + nf(w.scale, 3) + ")" : " (unscaled)"), usd(w.effectiveAtr, 2)], ["Spot", nf(w.spot)],
      ["CE short (spot + " + nf(w.upperMult, 2) + "×ATR → " + nf(w.ceTarget) + ")", nf(w.ceShort)], ["CE distance", dist(w.ceDistance)], ["PE short (spot − " + nf(w.lowerMult, 2) + "×ATR → " + nf(w.peTarget) + ")", nf(w.peShort)], ["PE distance", dist(w.peDistance)], ["Trading days to expiry", String(w.tradingDays)]]
      .map(([k, v]) => `<div class="m"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
    $("bAtrNote").textContent = "Source: " + (w.source || "—") + (w.firstWeek ? " · weeks " + w.firstWeek + " → " + w.lastWeek + " (" + w.barsUsed + " completed bars; the forming week is excluded)" : "") + (w.ceMoved || w.peMoved ? " · a snapped strike failed the liquidity filters and was moved (see warnings)" : "") + ". Holidays are not removed from the trading-day count.";
    const bars = w.recentBars || [];
    $("bAtrBars").innerHTML = "<thead><tr><th>Week of</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Days</th></tr></thead><tbody>" + bars.slice().reverse().map((x) => `<tr><td>${esc(x.week)}</td><td class="num">${nf(x.o)}</td><td class="num">${nf(x.h)}</td><td class="num">${nf(x.l)}</td><td class="num">${nf(x.c)}</td><td class="num">${x.days}</td></tr>`).join("") + "</tbody>";
  }
  function renderVariants(d) {
    const vs = d.variants || [];
    $("bVariantsWrap").hidden = !vs.length; if (!vs.length) return;
    const shown = d.selectedId || (d.recommendation && d.recommendation.id);
    $("bRecReason").innerHTML = d.recommendation ? "<b>" + (d.recommendation.id ? "Recommended: " + esc(d.recommendation.id) : "No recommendation") + "</b> — " + esc(d.recommendation.reason) : "";
    const ex = (v, i) => (v.exits ? `${nf(v.exits[i].price)}: ${usd(v.exits[i].pnlToday)} today · <b class="${cls(v.exits[i].pnlExpiry)}">${usd(v.exits[i].pnlExpiry)}</b> expiry` : "—");
    $("bVariants").innerHTML = vs.map((v) => `<article class="b-var${v.id === shown ? " on" : ""}${v.recommended ? " rec" : ""}">
      <header><b>${esc(v.side)} perp · ${esc(v.key)}</b>${v.recommended ? '<span class="label ok">Recommended</span>' : ""}${v.id === d.selectedId && !v.recommended ? '<span class="label watch">Selected</span>' : ""}</header>
      ${v.reachable ? `<p class="b-var-legs">${v.legs.map((l) => (l.side === "buy" ? "+" : "−") + l.qty + " " + nf(l.strike, 1) + l.type[0].toUpperCase()).join(" ")}</p>
      <dl><dt>Lots</dt><dd>${v.callLots} calls : ${v.putLots} puts</dd><dt>Perp qty (↓5)</dt><dd>${nf(v.perpQty, 0)}</dd><dt>Futures margin</dt><dd>${usd(v.futuresMargin)}</dd><dt>Options capital</dt><dd>${usd(v.optionsCapital)}</dd><dt>Total capital</dt><dd><b>${usd(v.totalCapital)}</b></dd>
      <dt>CE-short exit</dt><dd>${ex(v, 0)}</dd><dt>PE-short exit</dt><dd>${ex(v, 1)}</dd><dt>Net theta</dt><dd>${usd(v.theta.theta, 2)}/day · ${esc(v.theta.status)}</dd><dt>Max loss (expiry)</dt><dd>${v.unlimitedLoss ? "Unlimited (perp)" : usd(v.maxLoss)} · worst ±2σ ${usd(-v.worstLossInRiskWindow)}</dd><dt>Target</dt><dd class="pos">reachable</dd><dt>What-if</dt><dd>${v.best && v.best.whatIf ? "P(profit) " + nf(v.best.whatIf.probs.profit * 100, 0) + "% · EV " + usd(v.best.whatIf.probs.expectedValue) + " · 2σ worst " + usd(v.best.whatIf.tail.worst2Sigma) + " · " + v.best.whatIf.robustness.positive + "/" + v.best.whatIf.robustness.cells + " cells profitable" : "—"}</dd><dt>Score</dt><dd>${v.score != null ? nf(v.score, 2) : "—"} (lower is better)</dd></dl>
      <button class="ghost" data-variant="${esc(v.id)}" ${v.id === shown ? "disabled" : ""}>${v.id === shown ? "Shown below" : "Select this variant"}</button>`
      : `<p class="negative">Target not reachable${v.bestAchievable != null ? " (best ≈ " + usd(v.bestAchievable) + ")" : ""}.</p><p class="market-note">${esc((v.errors || []).join(" "))}</p>`}</article>`).join("");
    const m = d.market;
    $("bMarket").textContent = m ? (m.error ? m.error : `Market conditions (Hyperliquid ${m.interval} indicators): signal ${m.direction} ${m.score}/${m.maxScore}, trend ${m.trend} (EMA20 ${nf(m.ema20)} vs EMA50 ${nf(m.ema50)}), momentum ${m.momentum}, RSI ${nf(m.rsi, 1)}, ADX ${nf(m.adx, 1)}`) + (d.ivSkew && d.ivSkew.diffPts != null ? ` · IV skew put−call ${nf(d.ivSkew.diffPts, 1)} pts` : "") : "Market indicators unavailable.";
    $("bVariants").querySelectorAll("[data-variant]").forEach((btn) => (btn.onclick = async () => {
      const v = vs.find((x) => x.id === btn.dataset.variant); if (!v || !v.best) return;
      last.best = v.best; last.alternatives = v.alternatives; last.selectedId = v.id; last.status = "OK"; render(last);
      try { if (last.id) { await api(`/strategy/history/${last.id}/variant`, { variant: v.id }); $("bStatus").textContent = "Run #" + last.id + ": " + v.id + " recorded as your chosen variant."; loadHistory(); } } catch (e) { $("bStatus").textContent = e.message; }
    }));
  }
  function draw(d, b) {
    const c = $("bChart"), x = c.getContext("2d"), W = c.width, H = c.height, P = 56, pts = b.curve;
    x.clearRect(0, 0, W, H);
    const xs = pts.map((p) => p.stock), ys = pts.flatMap((p) => [p.expiry, p.today]).concat([0, b.target.pnl]);
    const lo = Math.min(...xs), hi = Math.max(...xs), yl = Math.min(...ys), yh = Math.max(...ys);
    const X = (v) => P + (v - lo) / (hi - lo) * (W - 2 * P), Y = (v) => H - P - (v - yl) / Math.max(1, yh - yl) * (H - 2 * P);
    x.font = "13px Inter, sans-serif"; x.fillStyle = "#7a8597"; x.strokeStyle = "#1d2431"; x.lineWidth = 1;
    for (let i = 0; i <= 5; i++) { const v = yl + (yh - yl) * i / 5; x.beginPath(); x.moveTo(P, Y(v)); x.lineTo(W - P, Y(v)); x.stroke(); x.fillText(usd(v), 4, Y(v) + 4); }
    for (let i = 0; i <= 6; i++) { const v = lo + (hi - lo) * i / 6; x.fillText(nf(v), X(v) - 18, H - P + 20); }
    const line = (key, color, w, dash = []) => { x.strokeStyle = color; x.lineWidth = w; x.setLineDash(dash); x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(X(p.stock), Y(p[key])) : x.moveTo(X(p.stock), Y(p[key])))); x.stroke(); x.setLineDash([]); };
    x.strokeStyle = "#525c6d"; x.beginPath(); x.moveTo(P, Y(0)); x.lineTo(W - P, Y(0)); x.stroke();
    x.strokeStyle = "#1fc77e"; x.setLineDash([6, 5]); x.beginPath(); x.moveTo(P, Y(b.target.pnl)); x.lineTo(W - P, Y(b.target.pnl)); x.stroke(); x.setLineDash([]);
    x.strokeStyle = "#7a8597"; x.setLineDash([2, 4]); x.beginPath(); x.moveTo(X(d.spot), P / 2); x.lineTo(X(d.spot), H - P); x.stroke(); x.setLineDash([]);
    line("today", "#f2b33d", 2, [8, 5]); line("expiry", "#4c8dff", 3);
    if (b.scenarioPrices) for (const s of [b.scenarioPrices.up, b.scenarioPrices.down]) { x.fillStyle = "#e6eaf2"; const v = pts.reduce((m, p) => (Math.abs(p.stock - s) < Math.abs(m.stock - s) ? p : m)); x.beginPath(); x.arc(X(s), Y(v.expiry), 5, 0, 7); x.fill(); x.fillText(nf(s), X(s) + 7, Y(v.expiry) - 8); }
  }
  // hand-offs
  $("bToManual").onclick = () => {
    if (!last?.best) return; const b = last.best, order = (t) => b.legs.filter((l) => l.type === t);
    Deriv.set({ ticker: last.ticker, expiry: last.expiry, manualFrom: "Strategy Builder run #" + last.id, manualLegs: [...order("call"), ...order("put")].map((l) => ({ type: l.type, side: l.side, strike: l.strike, qty: l.qty, premium: l.premium, delta: +l.greeks.delta.toFixed(4), iv: +(l.iv * 100).toFixed(2), contract: l.contract })), manualFuture: b.futures ? { symbol: b.futures.symbol, signedQty: b.futures.signedQty, entry: b.futures.entry } : null });
    location.href = "/manual";
  };
  $("bToSheet").onclick = () => {
    if (!last?.best) return; const b = last.best;
    Deriv.set({ ticker: last.ticker, expiry: last.expiry, position: { from: "Strategy Builder run #" + last.id, symbol: b.futures?.symbol, entry: b.futures?.entry, signedQty: b.futures?.signedQty, optionDelta: b.greeks.optionDelta, legs: b.legs.map((l) => ({ side: l.side, type: l.type, qty: l.qty, premium: l.premium, strike: l.strike, contract: l.contract })) } });
    location.href = "/sheet-lab#current-position";
  };
  // history: lifecycle (Taken / Not taken → entry fills → close), auto outcomes, model version, performance by lot size
  let histRuns = [];
  async function loadHistory() {
    const t = $("hOnlyTicker").checked && $("bTicker").value ? "&ticker=" + encodeURIComponent($("bTicker").value) : "";
    try {
      const { runs } = await api("/strategy/history?limit=100" + t); histRuns = runs;
      const legStr = (r) => (r.legs && r.legs.legs ? r.legs.legs.map((l) => (l.side === "buy" ? "+" : "−") + l.qty + " " + l.strike + l.type[0].toUpperCase()).join(" ") : "—");
      const methodTag = (r) => { const w = r.weekly_atr, lab = methodLabel[r.method] || r.method || "—";
        return w ? `<span class="method-tag atr" data-tip="${esc("ATR " + usd(w.atr, 2) + " (N=" + w.n + (w.scaleToExpiry ? ", scaled ×" + nf(w.scale, 2) : "") + ") · upper " + w.upperMult + "× → CE " + w.ceShort + " · lower " + w.lowerMult + "× → PE " + w.peShort + " · " + (w.sourceKind || ""))}" tabindex="0">${esc(lab)} ${nf(w.upperMult, 2)}×/${nf(w.lowerMult, 2)}×</span>` : `<span class="method-tag">${esc(lab)}</span>`; };
      const state = (r) => (r.realised_pnl != null ? `<span class="${cls(r.realised_pnl)}">closed ${usd(r.realised_pnl)}</span>` : r.taken === 1 ? "taken · open" : r.taken === 0 ? "not taken" : "—");
      const auto = (r) => (r.auto_outcome && Number.isFinite(r.auto_outcome.pnl) ? `<span class="${cls(r.auto_outcome.pnl)}" data-tip="${esc((r.auto_outcome.exit ? r.auto_outcome.exit + " exit touched " : "no exit touched; expiry close ") + "at " + nf(r.auto_outcome.price) + " · projected " + usd(r.auto_outcome.projected) + " · " + r.auto_outcome.source)}" tabindex="0">${usd(r.auto_outcome.pnl)}</span>` : r.auto_outcome && r.auto_outcome.error ? "n/a" : "after expiry");
      $("hTable").innerHTML = "<thead><tr><th>#</th><th>Saved</th><th>Source</th><th>Ticker</th><th>Expiry</th><th>Method</th><th>Status</th><th>Legs</th><th>Perp</th><th>Lot sets</th><th>Variant</th><th>Target</th><th>Exp. up / down</th><th>Capital</th><th>Model</th><th>Trade</th><th>Auto outcome</th><th></th></tr></thead><tbody>" +
        (runs.length ? runs.map((r) => `<tr><td>${r.id}</td><td>${ist(new Date(r.ts).toISOString())}</td><td>${esc(r.source || "builder")}${r.plan_id ? " #" + r.plan_id : ""}</td><td>${esc(r.ticker)}</td><td>${esc(r.expiry)}</td><td>${methodTag(r)}</td><td>${esc(r.status)}</td><td class="mono">${legStr(r)}</td><td class="num">${r.futures_qty != null ? nf(r.futures_qty, 0) : "—"}</td><td class="num">${r.lot_sets ?? "—"}</td><td>${esc(r.chosen_variant || r.recommended_variant || "—")}</td><td class="num">${usd(r.target_pnl)}</td><td class="num">${usd(r.expected_up)} / ${usd(r.expected_down)}</td><td class="num">${usd(r.required_capital)}</td><td>${r.model_version ? "v" + r.model_version : "—"}</td><td>${state(r)}</td><td>${auto(r)}</td><td class="h-actions">${r.status === "OK" && r.realised_pnl == null ? `<button class="ghost" data-act="trade" data-id="${r.id}">Taken / fills…</button><button class="ghost" data-act="skip" data-id="${r.id}">Not taken</button>` : ""}</td></tr>`).join("") : `<tr><td colspan="18"><div class="empty-state">No runs yet — every analysis you run is saved here.</div></td></tr>`) + "</tbody>";
    } catch (e) { $("hTable").innerHTML = `<tr><td><div class="error-state">${esc(e.message)}</div></td></tr>`; }
    api("/strategy/model").then((m) => { const c = m.calibration, v = m.version;
      $("hModel").innerHTML = `<b>Model v${v.id}</b> · ${esc(new Date(v.at).toLocaleString())} · ${esc(v.source)} · ${m.history.length} version(s) kept · outcomes: ${m.counts.actual || 0} actual, ${m.counts.auto || 0} auto; ${m.counts.taken || 0} taken of ${m.counts.runs} runs` +
        (c.outcomes ? ` · projection error mean ${usd(c.projectionError.mean)} (MAE ${usd(c.projectionError.meanAbs)})` + (c.exitHitRate ? ` · exits hit CE ${nf(c.exitHitRate.ce * 100, 0)}% / PE ${nf(c.exitHitRate.pe * 100, 0)}% / neither ${nf(c.exitHitRate.neither * 100, 0)}%` : "") + (Object.keys(c.slippageByBucket).length ? " · slippage " + Object.entries(c.slippageByBucket).map(([k, x]) => k + " " + nf(x.meanHalfSpreads, 2) + "×½spread (n" + x.n + ")").join(", ") : "") : ` · tuning starts after ${m.minOutcomesForTuning} outcomes`) + `. <small>${esc(m.loop)}</small>`; }).catch(() => {});
    api("/strategy/performance-by-lots").then((p) => {
      $("hByLots").innerHTML = "<thead><tr><th>Lot sets</th><th>Runs</th><th>Closed</th><th>Total realised</th><th>Avg realised</th><th>Win rate</th><th>Target hit</th><th>Realised ÷ target</th><th>Worst</th><th>Avg capital</th></tr></thead><tbody>" + p.bySize.map((g) => `<tr><td>${g.lotSets ?? "—"}</td><td>${g.runs}</td><td>${g.closed}</td><td class="${cls(g.totalRealised)}">${usd(g.totalRealised)}</td><td>${usd(g.avgRealised)}</td><td>${g.winRate != null ? nf(g.winRate * 100, 0) + "%" : "—"}</td><td>${g.targetHitRate != null ? nf(g.targetHitRate * 100, 0) + "%" : "—"}</td><td>${g.avgRealisedVsTarget != null ? nf(g.avgRealisedVsTarget * 100, 0) + "%" : "—"}</td><td>${usd(g.worst)}</td><td>${usd(g.avgCapital)}</td></tr>`).join("") + "</tbody>";
      $("hByLotsNote").textContent = p.note; }).catch(() => {});
  }
  let tradeRun = null;
  $("hTable").addEventListener("click", async (e) => {
    const id = Number(e.target.dataset.id), act = e.target.dataset.act; if (!id || !act) return;
    if (act === "skip") { try { await api(`/strategy/history/${id}/trade`, { taken: false }); loadHistory(); } catch (err) { e.target.textContent = err.message; } return; }
    tradeRun = histRuns.find((r) => r.id === id); if (!tradeRun) return;
    $("hTradeTitle").textContent = "Run #" + id + " · " + tradeRun.ticker + " " + tradeRun.expiry;
    const legs = (tradeRun.legs && tradeRun.legs.legs) || [], ef = tradeRun.entry_fills || {};
    $("hTradeLegs").innerHTML = legs.map((l) => `<label>${esc((l.side === "buy" ? "+" : "−") + l.qty + " " + l.strike + l.type[0].toUpperCase())} · planned ${nf(l.premium)}<input data-c="${esc(l.contract)}" data-k="entry" type="number" step="0.01" min="0" placeholder="entry fill" value="${ef.legs && ef.legs[l.contract] != null ? ef.legs[l.contract] : ""}"><input data-c="${esc(l.contract)}" data-k="exit" type="number" step="0.01" min="0" placeholder="exit fill"></label>`).join("") +
      `<label>Perp / stock (${nf(tradeRun.futures_qty, 0)})<input data-c="perp" data-k="entry" type="number" step="0.01" min="0" placeholder="entry fill" value="${ef.perp ?? ""}"><input data-c="perp" data-k="exit" type="number" step="0.01" min="0" placeholder="exit fill"></label>`;
    $("hTrade").showModal();
  });
  $("hTrade").addEventListener("close", async () => {
    const act = $("hTrade").returnValue; if (!tradeRun || (act !== "entry" && act !== "close")) return;
    const pick = (k) => { const o = { legs: {}, perp: null }; for (const i of $("hTradeLegs").querySelectorAll(`input[data-k="${k}"]`)) { if (i.value === "") continue; if (i.dataset.c === "perp") o.perp = Number(i.value); else o.legs[i.dataset.c] = Number(i.value); } return o; };
    const f = $("hTradeForm").elements, body = { taken: true, entryFills: pick("entry"), notes: f.notes.value };
    if (act === "close") { if (f.pnl.value === "") { $("hLearnMsg").textContent = "Enter the realised P&L to close the trade."; return; } body.exitFills = pick("exit"); body.realisedPnl = Number(f.pnl.value); }
    try { const r = await api(`/strategy/history/${tradeRun.id}/trade`, body); $("hLearnMsg").textContent = "Run #" + tradeRun.id + (act === "close" ? " closed." + (r.learning ? " " + (r.learning.tuned ? "Model re-tuned → v" + r.learning.version + "." : r.learning.note) : "") : " marked Taken with entry fills."); loadHistory(); } catch (err) { $("hLearnMsg").textContent = err.message; }
  });
  $("hLearn").onclick = async () => { $("hLearnMsg").textContent = "Replaying expired runs against market data…"; try { const r = await api("/strategy/learn", {}); $("hLearnMsg").textContent = r.autoOutcomes + " new auto outcome(s). " + (r.learning.tuned ? "Model re-tuned → v" + r.learning.version + "." : r.learning.note); loadHistory(); } catch (e) { $("hLearnMsg").textContent = e.message; } };
  // chain viewer (loads when opened or when the expiry changes while open)
  async function loadChain() {
    if (!$("bChainBox").open || !$("bExpiry").value || !$("bTicker").value) return;
    $("bChain").innerHTML = '<tbody><tr><td><div class="skel h120"></div></td></tr></tbody>';
    try {
      const c = await api(`/strategy/chain?ticker=${encodeURIComponent($("bTicker").value)}&expiry=${encodeURIComponent($("bExpiry").value)}`);
      const side = (o) => (o ? `<td class="num">${nf(o.bid)}</td><td class="num">${nf(o.ask)}</td><td class="num">${o.iv != null ? nf(o.iv * 100, 1) + "%" : "—"}</td><td class="num">${nf(o.delta, 2)}</td><td class="num">${o.oi ?? "—"}</td>` : '<td colspan="5">—</td>');
      $("bChainNote").textContent = `${c.source}${c.delayed ? " (delayed)" : ""} · spot ${nf(c.spot)} · quotes as of ${ist(c.quoteTime)} · net GEX ${usd(c.totalGex)} per 1% move. ${c.note}`;
      $("bChain").innerHTML = '<thead><tr><th colspan="5">Calls · bid / ask / IV / Δ / OI</th><th>Strike</th><th colspan="5">Puts · bid / ask / IV / Δ / OI</th><th>GEX ($/1%)</th></tr></thead><tbody>' +
        c.rows.map((r) => `<tr class="${c.spot && Math.abs(r.strike - c.spot) < (c.rows[1] ? Math.abs(c.rows[1].strike - c.rows[0].strike) / 2 : 1) ? "atm" : ""}">${side(r.call)}<td class="num"><b>${nf(r.strike)}</b></td>${side(r.put)}<td class="num ${cls(r.gex)}">${usd(r.gex)}</td></tr>`).join("") + "</tbody>";
    } catch (e) { $("bChain").innerHTML = `<tbody><tr><td><div class="error-state">${esc(e.message)}</div></td></tr></tbody>`; }
  }
  $("bChainBox").addEventListener("toggle", loadChain); $("bExpiry").addEventListener("change", loadChain);
  $("hRefresh").onclick = loadHistory; $("hOnlyTicker").onchange = loadHistory;
  loadHistory();
  if ($("bTicker").value) loadExpiries();
})();
