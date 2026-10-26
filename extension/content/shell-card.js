// Fitted layout, page side: what the card window needs to behave like the
// tab's own page (content/shell.js has the overview). Set up from inside the
// card in Safari (content/shell-main.js) and from the top window in Chrome
// (content/shell-writer.js), always on the card's window `w`, in the page's
// world, before the page's scripts run there.
//  - History: the page's pushState/replaceState entries go on the top window
//    (Back, Forward and the address bar belong to it); Back/Forward between
//    them are replayed in the card as popstate (and hashchange).
//  - document.referrer: the real one (the card's would be the page itself).
//  - window.close(): closes the tab, as on the page without the shell.
//  - window.name: the tab's, kept across page loads (the card's would be
//    Margin's frame name).
// window.parent and frameElement are left as they are: the shell and the
// card, as for a page in a frame of its own site. window.top can't be
// redefined, and faking parent alone gave pages a state no browser produces
// (parent === self but not top; Google Docs then hid its collaborators).
// Stylesheets a page puts into window.parent.document (Google's AI Mode) are
// moved into the card by content/shell.js.

/** @param {any} w the card's window @param {any} topWin the tab's top window */
export function setUpCard(w, topWin) {
  const H = w.History.prototype;
  if (H.pushState.__margin) return; // already set up in this window
  // Tells content/shell.js this ran for the card (a debug log there).
  w.dispatchEvent(new w.CustomEvent('margin-page-ready'));

  const push = H.pushState;
  const replace = H.replaceState;
  const topHistory = topWin.history;
  const wrap = (fn) => Object.defineProperty(fn, '__margin', { value: true });
  // The page's own state inside a top entry. Every entry of the top window
  // belongs to this tab's card, including ones an earlier card (before a
  // reload) made.
  const own = (saved) => (saved && typeof saved === 'object' && '__margin' in saved ? saved.state : null);

  H.pushState = wrap(function pushState(state, title, url) {
    replace.call(this, state, title, url);
    push.call(topHistory, { __margin: true, state }, '', w.location.href);
  });
  H.replaceState = wrap(function replaceState(state, title, url) {
    replace.call(this, state, title, url);
    replace.call(topHistory, { ...(topHistory.state ?? {}), __margin: true, state }, '', w.location.href);
  });
  // After a reload or a Back without the page cache, the page gets its
  // state back, as it would without the shell.
  try {
    const restored = own(topHistory.state);
    if (restored != null) replace.call(w.history, restored, '', w.location.href);
  } catch {}

  // Every entry of the top window belongs to this card (cross-document
  // navigations happen at the top), so a popstate there is a same-document
  // traversal here.
  topWin.addEventListener('popstate', (event) => {
    const saved = event.state;
    const state = own(saved);
    const target = topWin.location.href;
    const here = w.location.href;
    const [targetPath, targetHash = ''] = target.split('#');
    const [herePath, hereHash = ''] = here.split('#');
    if (targetPath === herePath && targetHash !== hereHash) {
      if (targetHash) return w.location.replace(target); // the browser scrolls and fires hashchange
      replace.call(w.history, state, '', target);
      w.dispatchEvent(new w.PopStateEvent('popstate', { state }));
      w.dispatchEvent(new w.HashChangeEvent('hashchange', { oldURL: here, newURL: target }));
      const scroll = saved?.__marginScroll;
      w.scrollTo(scroll?.[0] ?? 0, scroll?.[1] ?? 0);
      return;
    }
    replace.call(w.history, state, '', target);
    w.dispatchEvent(new w.PopStateEvent('popstate', { state }));
  });

  const referrer = topWin.document.referrer;
  const referrerGetter = Object.getOwnPropertyDescriptor(w.Document.prototype, 'referrer')?.get;
  if (referrerGetter) {
    Object.defineProperty(w.Document.prototype, 'referrer', {
      configurable: true,
      enumerable: true,
      get() {
        return this === w.document ? referrer : referrerGetter.call(this);
      },
    });
  }

  try {
    w.name = topWin.name;
  } catch {}
  w.addEventListener('pagehide', () => {
    try {
      topWin.name = w.name;
    } catch {}
  });

  const close = w.close;
  w.close = function () {
    return this === w || this === undefined ? topWin.close() : close.call(this);
  };
}
