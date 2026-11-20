// Claude addition: deep links into the terminal. /signals, /options, /gamma … (or #signals) open that view.
(function () {
  const v = (location.pathname.replace(/^\/+|\/+$/g, '') || location.hash.slice(1)).toLowerCase();
  if (!v || v === 'terminal' || v === 'dashboard' || v === 'paper') return;     // /paper is handled by ChatGPT's own code
  const go = () => { const b = document.querySelector(`.nav[data-view="${CSS.escape(v)}"]`); if (b) b.click(); };
  if (document.readyState === 'complete') go(); else window.addEventListener('load', go);
})();
