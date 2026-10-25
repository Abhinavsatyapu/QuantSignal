// Shows the shared derivatives context (ticker / expiry) in the standalone page header.
(function () {
  const el = document.getElementById("derivShared");
  if (!el || !globalThis.Deriv) return;
  const paint = () => {
    const s = Deriv.get();
    el.textContent = s.ticker ? "Shared: " + s.ticker + (s.expiry ? " · " + s.expiry : "") : "";
  };
  paint();
  window.addEventListener("derivchange", paint);
  window.addEventListener("storage", paint);
})();
