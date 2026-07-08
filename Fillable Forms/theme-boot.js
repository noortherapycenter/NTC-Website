/* Applies the saved theme preference before first paint (no flash),
   in BOTH directions — dark stays dark, light stays light — and
   re-applies instantly when a cached page is shown again.
   Loaded synchronously in <head> of every fillable form. */
(function () {
  function apply() {
    var dark = false;
    try { dark = localStorage.getItem('noor-portal-theme') === 'dark'; } catch (e) {}
    if (dark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }
  apply();
  window.addEventListener('pageshow', apply);
})();
