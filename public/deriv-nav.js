// Shared derivatives chrome: the shared ticker/expiry chip, the data-source badge ("Cboe delayed, as of …" vs "Alpaca live")
// and the footer build stamp from /version. Pages report their latest quote time with Deriv.quoteTime(iso).
(function () {
  const el = document.getElementById("derivShared");
  const top = document.querySelector(".deriv-top");
  const fmtET = (iso) => { try { return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) + " ET"; } catch { return iso; } };
  const paint = () => { if (!el || !globalThis.Deriv) return; const s = Deriv.get(); el.textContent = s.ticker ? s.ticker + (s.expiry ? " · " + s.expiry : "") : ""; };
  paint();
  window.addEventListener("derivchange", paint);
  window.addEventListener("storage", paint);
  let badge = null, srcLabel = "Checking data source…", quote = null;
  if (top) { badge = document.createElement("span"); badge.className = "deriv-source"; badge.setAttribute("role", "status"); badge.title = "Where option quotes come from and how fresh they are"; top.appendChild(badge); }
  const draw = () => { if (badge) badge.innerHTML = '<i class="dot"></i>' + srcLabel + (quote ? " · as of " + fmtET(quote) : ""); };
  draw();
  if (globalThis.Deriv) {
    Deriv.quoteTime = (iso) => { quote = iso; draw(); };
    Deriv.status().then((s) => {
      const live = s.alpaca && s.alpaca.configured;
      srcLabel = live ? "Alpaca " + String((s.alpaca.optionsFeed || "live")).toUpperCase() : s.fallback ? "Cboe delayed (~15 min)" : "No options data source";
      if (badge) badge.classList.add(live ? "live" : s.fallback ? "delayed" : "down");
      draw();
    });
  }
  const foot = document.createElement("footer"); foot.className = "deriv-foot";
  foot.innerHTML = '<span>QuantSignal derivatives · analysis only, no order is sent · estimates, not guarantees</span><span id="derivVersion"></span>';
  document.body.appendChild(foot);
  fetch("/version", { cache: "no-store" }).then((r) => r.json()).then((v) => { document.getElementById("derivVersion").textContent = "Build " + String(v.commit || "dev").slice(0, 7) + (v.builtAt ? " · " + fmtET(v.builtAt) : ""); }).catch(() => {});
})();
