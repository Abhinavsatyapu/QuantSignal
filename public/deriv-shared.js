// Shared derivatives state: the selected underlying / perp / expiry and leg hand-offs flow between Options Studio,
// Gamma Book, Live Hedge Compare, 1:2 Options + Futures, the Manual Four-Leg Lab and the Sheet Scenario Lab.
// Stored in localStorage (this browser only). No credentials are ever stored here: Alpaca keys live on the server.
(function (root) {
  const KEY = "quantsignal.deriv.v1";
  const read = () => {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { return {}; }
  };
  let statusPromise = null;
  const Deriv = {
    get: read,
    set(patch) {
      const s = { ...read(), ...patch, updatedAt: Date.now() };
      try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
      try { root.dispatchEvent(new CustomEvent("derivchange", { detail: s })); } catch {}
      return s;
    },
    tickerOf: (sym) => String(sym || "").includes(":") ? String(sym).split(":")[1] : String(sym || "").toUpperCase(),
    perpFor(ticker, symbols = []) {
      const t = String(ticker || "").toUpperCase();
      return symbols.find((s) => s === "xyz:" + t) || symbols.find((s) => s.split(":")[1] === t) || null;
    },
    // Analysis mode: accept last available (closed-market / indicative) quotes, clearly labelled STALE.
    allowStale: () => read().allowStale !== false,
    maxQuoteAgeMs: () => (read().allowStale !== false ? 5 * 86400000 : 120000),
    isStale: (q, now = Date.now()) => !q?.quoteTime || now - Date.parse(q.quoteTime) > 120000,
    status(force = false) {
      if (!statusPromise || force)
        statusPromise = fetch("/api/derivatives/status", { cache: "no-store" })
          .then((r) => r.json())
          .catch(() => ({ alpaca: { configured: false }, message: "Derivatives status unavailable" }));
      return statusPromise;
    },
    async dataReady() {
      const s = await Deriv.status();
      return !!(s.alpaca?.configured || s.fallback);
    },
    // US stock-perp list (Hyperliquid, US-listed only), cached for the page lifetime.
    _symbols: null,
    async perpSymbols() {
      if (!Deriv._symbols)
        Deriv._symbols = fetch("/api/stream/universe?scope=stocks").then((r) => r.json()).then((d) => d.symbols || []).catch(() => []);
      return Deriv._symbols;
    },
  };
  root.Deriv = Deriv;
})(globalThis);
