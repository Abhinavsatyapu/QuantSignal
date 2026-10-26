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

  const shared = Deriv.get();
  if (shared.ticker) $("bTicker").value = shared.ticker;

  async function loadExpiries() {
    const t = $("bTicker").value.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(t)) { $("bStatus").textContent = "Enter a valid US ticker, e.g. NVDA."; return; }
    $("bTicker").value = t; $("bLoad").disabled = true; $("bStatus").textContent = "Loading " + t + " option chain…";
    $("bExpiry").disabled = true; $("bBuild").disabled = true;
    try {
      const d = (expiriesData = await api("/strategy/expiries?ticker=" + encodeURIComponent(t)));
      const sel = $("bExpiry"), pref = Deriv.get().expiry;
      sel.innerHTML = d.expiries.map((e) => `<option value="${e.date}">${e.date} · ${nf(e.dte, 1)} d · ${e.quoted != null ? e.quoted + "/" : ""}${e.contracts} quoted contracts</option>`).join("");
      const weekly = d.expiries.find((e) => e.dte >= 2 && e.dte <= 9); // reference sheets used 2–8 day expiries
      sel.value = d.expiries.some((e) => e.date === pref) ? pref : weekly ? weekly.date : d.expiries[0].date;
      sel.disabled = false;
      $("bPerp").innerHTML = d.perp.available ? `Perp leg: <b>${esc(d.perp.symbol)}</b> on Hyperliquid · bid ${nf(d.perp.bid)} / ask ${nf(d.perp.ask)} · book ${ist(d.perp.time)} · max leverage ${d.perp.maxLeverage}×`
        : `<span class="neg">No perp leg: ${esc(d.perp.reason)}</span> The four-leg + perp methodology cannot be applied to ${esc(t)}.`;
      $("bExpiryNote").textContent = `${d.expiries.length} expiries from ${d.label}${d.snapshotTime ? " · chain snapshot " + ist(d.snapshotTime) : ""}${d.stock ? " · stock " + nf(d.stock.price) + " (" + d.stock.source + ")" : ""}. Reference sheets used 2–8 calendar-day expiries.`;
      const c = d.calibration;
      $("bCalNote").textContent = `Calibration: ${c.source} → debit long ${c.debitLongSigma}σ OTM, debit short ${c.debitShortSigma}σ, credit short ${c.creditShortSigma}σ, credit wing ${c.wingSigma}σ, perp factor ${c.futuresFactor}` + (c.history.closedRuns ? ` · ${c.history.closedRuns} recorded outcomes, median realised/expected ${nf(c.history.medianRealisedToExpected, 2)}` : " · no recorded outcomes yet");
      $("bBuild").disabled = !d.perp.available && $("bMethod").value === "reference";
      Deriv.set({ ticker: t, expiry: sel.value });
      $("bStatus").textContent = "";
      loadHistory();
    } catch (e) { $("bStatus").textContent = e.message; $("bPerp").textContent = ""; $("bExpiry").innerHTML = '<option value="">—</option>'; }
    finally { $("bLoad").disabled = false; }
  }
  $("bLoad").onclick = loadExpiries;
  $("bTicker").addEventListener("keydown", (e) => { if (e.key === "Enter") loadExpiries(); });
  $("bExpiry").onchange = () => Deriv.set({ expiry: $("bExpiry").value });
  $("bMethod").onchange = () => { if (expiriesData) $("bBuild").disabled = !expiriesData.perp.available; };

  function cfg() {
    const v = (id) => $(id).value;
    return { signal: v("bSignal"), callLotUnits: Number(v("bCallUnits")), putLotUnits: Number(v("bPutUnits")), marginDivisor: Number(v("bMarginDiv")), futuresRound: Number(v("bRound")), direction: v("bDir"), targetPnl: Number(v("bTarget")), capital: Number(v("bCapital")), maxLossPct: Number(v("bMaxLoss")), mmLoss: Number(v("bMm")), maxSpreadPct: Number(v("bSpread")), maxLots: Number(v("bLots")), leverage: Number(v("bLev")), commission: Number(v("bComm")), futureFeePct: Number(v("bFee")), debitShortSigma: v("bDebitSigma"), creditShortSigma: v("bCreditSigma"), wingSigma: v("bWingSigma"), useCalibration: $("bCal").checked };
  }
  function validate(c) {
    const e = [];
    if (!(c.targetPnl > 0)) e.push("Target P&L must be positive.");
    if (!(c.capital > 0)) e.push("Capital must be positive.");
    if (!(c.maxLossPct > 0 && c.maxLossPct <= 100)) e.push("Max loss must be 1–100%.");
    if (!(c.maxSpreadPct > 0 && c.maxSpreadPct <= 100)) e.push("Max spread must be 1–100%.");
    if (!(Number.isInteger(c.maxLots) && c.maxLots >= 1)) e.push("Max lots must be a whole number ≥ 1.");
    return e;
  }
  $("bBuild").onclick = async () => {
    const c = cfg(), bad = validate(c);
    if (bad.length) { $("bStatus").textContent = bad.join(" "); return; }
    $("bBuild").disabled = true; $("bStatus").textContent = "Fetching the " + $("bExpiry").value + " chain and Hyperliquid book, searching strike sets…";
    try { last = await api("/strategy/build", { ticker: $("bTicker").value, expiry: $("bExpiry").value, method: $("bMethod").value, cfg: c }); render(last); $("bStatus").textContent = last.id ? "Saved as run #" + last.id + "." : ""; loadHistory(); }
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
    $("bBody").hidden = !b;
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
    $("bTheta").textContent = b.theta ? `Lots calls ${b.callLots} : puts ${b.putLots} (rule ${b.lotRule}). Net options theta ${usd(b.theta.theta, 2)}/day of ${usd(b.theta.gross, 2)} gross → ${b.theta.status}. ${b.theta.note}` : "";
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
  // history
  async function loadHistory() {
    const t = $("hOnlyTicker").checked && $("bTicker").value ? "&ticker=" + encodeURIComponent($("bTicker").value) : "";
    try {
      const { runs } = await api("/strategy/history?limit=50" + t);
      $("hTable").innerHTML = "<thead><tr><th>#</th><th>Saved</th><th>Ticker</th><th>Expiry</th><th>Method</th><th>Status</th><th>Legs</th><th>Perp</th><th>Target</th><th>Exp. up</th><th>Exp. down</th><th>Capital</th><th>Realised P&amp;L</th><th></th></tr></thead><tbody>" +
        (runs.length ? runs.map((r) => `<tr><td>${r.id}</td><td>${ist(new Date(r.ts).toISOString())}</td><td>${esc(r.ticker)}</td><td>${esc(r.expiry)}</td><td>${esc(r.method)}</td><td>${esc(r.status)}</td><td>${r.legs && r.legs.legs ? r.legs.legs.map((l) => (l.side === "buy" ? "+" : "−") + l.qty + " " + l.strike + l.type[0].toUpperCase()).join(" ") : "—"}</td><td>${r.futures_qty != null ? nf(r.futures_qty, 2) + " " + esc(r.perp_symbol || "") : "—"}</td><td>${usd(r.target_pnl)}</td><td>${usd(r.expected_up)}</td><td>${usd(r.expected_down)}</td><td>${usd(r.required_capital)}</td><td>${r.status === "OK" ? `<input class="h-input" type="number" step="1" data-id="${r.id}" value="${r.realised_pnl ?? ""}" placeholder="enter $">` : ""}</td><td>${r.status === "OK" ? `<button class="ghost" data-save="${r.id}">Save</button>` : ""}</td></tr>`).join("") : '<tr><td colspan="14">No saved runs yet.</td></tr>') + "</tbody>";
    } catch (e) { $("hTable").innerHTML = `<tr><td>${esc(e.message)}</td></tr>`; }
  }
  $("hTable").addEventListener("click", async (e) => {
    const id = e.target.dataset.save; if (!id) return;
    const v = document.querySelector(`input[data-id="${id}"]`).value;
    try { await api(`/strategy/history/${id}/outcome`, { realisedPnl: Number(v) }); e.target.textContent = "Saved"; } catch (err) { e.target.textContent = err.message; }
  });
  $("hRefresh").onclick = loadHistory; $("hOnlyTicker").onchange = loadHistory;
  loadHistory();
  if ($("bTicker").value) loadExpiries();
})();
