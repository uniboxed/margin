// Fitted layout, page side (content/shell.js has the overview). Runs in the
// page's own world, in every frame, at document_start; it does nothing except
// in the card: the frame Margin wrote the page into, which Safari runs this in
// again once the page is in it.
//  - History: the page's pushState/replaceState entries go on the top window
//    (Back, Forward and the address bar belong to it); Back/Forward between
//    them are replayed in the card as popstate (and hashchange).
//  - document.referrer: the real one (the card's would be the page itself).
//  - window.close(): closes the tab, as on the page without the shell.
//  - window.name: the tab's, kept across page loads (the card's would be
//    Margin's frame name).
(() => {
  if (window === top || location.href === 'about:srcdoc') return;
  let shelled = false;
  try {
    shelled = parent === top && location.ancestorOrigins?.[0] === location.origin
      && String(frameElement?.name).startsWith('margin-')
      && top.document.documentElement.hasAttribute('data-margin-shell');
  } catch {}
  if (!shelled) return;
  const H = History.prototype;
  if (H.pushState.__margin) return; // already set up in this window

  const push = H.pushState;
  const replace = H.replaceState;
  const topHistory = top.history;
  const wrap = (fn) => Object.defineProperty(fn, '__margin', { value: true });
  // The page's own state inside a top entry. Every entry of the top window
  // belongs to this tab's card, including ones an earlier card (before a
  // reload) made.
  const own = (saved) => (saved && typeof saved === 'object' && '__margin' in saved ? saved.state : null);

  H.pushState = wrap(function pushState(state, title, url) {
    replace.call(this, state, title, url);
    push.call(topHistory, { __margin: true, state }, '', location.href);
  });
  H.replaceState = wrap(function replaceState(state, title, url) {
    replace.call(this, state, title, url);
    replace.call(topHistory, { ...(topHistory.state ?? {}), __margin: true, state }, '', location.href);
  });
  // After a reload or a Back without the page cache, the page gets its
  // state back, as it would without the shell.
  try {
    const restored = own(topHistory.state);
    if (restored != null) replace.call(history, restored, '', location.href);
  } catch {}

  // Every entry of the top window belongs to this card (cross-document
  // navigations happen at the top), so a popstate there is a same-document
  // traversal here.
  top.addEventListener('popstate', (event) => {
    const saved = event.state;
    const state = own(saved);
    const target = top.location.href;
    const here = location.href;
    const [targetPath, targetHash = ''] = target.split('#');
    const [herePath, hereHash = ''] = here.split('#');
    if (targetPath === herePath && targetHash !== hereHash) {
      if (targetHash) return location.replace(target); // the browser scrolls and fires hashchange
      replace.call(history, state, '', target);
      dispatchEvent(new PopStateEvent('popstate', { state }));
      dispatchEvent(new HashChangeEvent('hashchange', { oldURL: here, newURL: target }));
      const scroll = saved?.__marginScroll;
      scrollTo(scroll?.[0] ?? 0, scroll?.[1] ?? 0);
      return;
    }
    replace.call(history, state, '', target);
    dispatchEvent(new PopStateEvent('popstate', { state }));
  });

  const referrer = top.document.referrer;
  const referrerGetter = Object.getOwnPropertyDescriptor(Document.prototype, 'referrer')?.get;
  if (referrerGetter) {
    Object.defineProperty(Document.prototype, 'referrer', {
      configurable: true,
      enumerable: true,
      get() {
        return this === document ? referrer : referrerGetter.call(this);
      },
    });
  }

  try {
    window.name = top.name;
  } catch {}
  addEventListener('pagehide', () => {
    try {
      top.name = window.name;
    } catch {}
  });

  const close = window.close;
  window.close = function () {
    return this === window || this === undefined ? top.close() : close.call(this);
  };
})();
