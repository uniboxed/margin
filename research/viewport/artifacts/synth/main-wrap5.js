// MAIN-world history wrapper for the transplanted frame (top-owned history), after r-nav hist4.
(() => {
  if (window === top || location.href === 'about:srcdoc') return;
  let shell = false; try { shell = window.parent === top && top.document.documentElement.hasAttribute('data-margin-shell'); } catch (e) {}
  if (!shell) return;
  const H = History.prototype, push = H.pushState, replace = H.replaceState, P = window.parent;
  const id = Math.random().toString(36).slice(2);
  H.pushState = function (state, title, url) {
    replace.call(this, state, title, url);
    push.call(P.history, { __margin: id, state }, '', location.href);
  };
  H.replaceState = function (state, title, url) {
    replace.call(this, state, title, url);
    replace.call(P.history, { __margin: id, state }, '', location.href);
  };
  P.addEventListener('popstate', (e) => {
    const s = e.state;
    // Every entry of this top document belongs to this frame document (cross-document
    // navigations are top-level), so replay it as a same-document traversal.
    const st = s && s.__margin === id ? s.state : null;
    const a = new URL(P.location.href), b = new URL(location.href);
    if (a.hash !== b.hash && a.href.split('#')[0] === b.href.split('#')[0]) {
      if (a.hash) { location.replace(P.location.href); return; }   // fragment navigation: browser scrolls + fires hashchange
      const old = location.href; replace.call(history, st, '', P.location.href);
      window.dispatchEvent(new PopStateEvent('popstate', { state: st }));
      window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: old, newURL: location.href }));
      scrollTo(0, (s && s.__scroll) || 0); return;
    }
    replace.call(history, st, '', P.location.href);
    window.dispatchEvent(new PopStateEvent('popstate', { state: st }));
  });
})();
