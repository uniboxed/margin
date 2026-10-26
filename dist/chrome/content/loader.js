// The page-load pill's timing (the theme draws it: view.setLoading). Called
// by content/core.js.

// `page`: see content/core.js. `pullRefreshing()`: the pull-to-refresh
// spinner is showing (content/trackpad.js), which shows the reload instead.
export function startLoader(page, { pullRefreshing }) {
  const { host, onCard } = page;
  // ---- page-load indicator --------------------------------------------------
  // Margin's script starts ~0.2s into a load in Safari (it can't draw
  // earlier). If the page is still loading by Margin's first render, show the
  // pill until the load event: at least LOADER_MIN_MS so it never flickers,
  // at most LOADER_MAX_MS in case a page never finishes.
  const LOADER_MIN_MS = 500;
  const LOADER_MAX_MS = 15000;
  let loaderShownAt = null;
  let loaderMaxTimer = null;
  let loaderHideTimer = null;
  let placeholderTookOver = false; // the placeholder's pill was showing until Margin ran
  const showPill = (instant = false) => {
    clearTimeout(loaderHideTimer);
    page.view()?.setLoading(true, { instant });
    host.dataset.loading = 'true'; // test/debug hook
  };
  const hidePill = (delay = 0) => {
    clearTimeout(loaderHideTimer);
    loaderHideTimer = setTimeout(() => {
      page.view()?.setLoading(false);
      host.dataset.loading = 'false';
    }, delay);
  };
  // Taking over from the placeholder's pill (content/docked/w-*.css), the
  // pill shows at once (no fade-in dip) and fades out normally, even if the
  // page has already finished loading.
  // In the fitted layout the page loads in the card: the top document is
  // complete long before (card hook below).
  const pageComplete = () => (globalThis.Margin?.shell ? globalThis.Margin?.shell.card?.document.readyState === 'complete' : document.readyState === 'complete');
  function startLoader() {
    const complete = pageComplete();
    if (loaderShownAt != null || (complete && !placeholderTookOver)) return;
    loaderShownAt = performance.now();
    showPill(placeholderTookOver);
    if (complete) return stopLoader();
    if (!globalThis.Margin?.shell) addEventListener('load', stopLoader, { once: true });
    loaderMaxTimer = setTimeout(stopLoader, LOADER_MAX_MS);
  }
  onCard((win) => win.addEventListener('load', () => stopLoader(), { once: true }));
  function stopLoader() {
    clearTimeout(loaderMaxTimer);
    if (loaderShownAt == null || leaving) return;
    hidePill(Math.max(0, LOADER_MIN_MS - (performance.now() - loaderShownAt)));
  }

  // Leaving the page (⌘R, a link, a form, a script navigation): show the pill
  // on this page at once. Otherwise it would only appear once the next page
  // has arrived and Margin runs there, which in Safari is the server's
  // response time plus ~0.2s. `beforeunload` doesn't keep pages out of the
  // back/forward cache in WebKit or Chrome. If the page stays after all, hide
  // it again: a "Leave page?" prompt (checked once the event is done; while
  // the prompt is up, timers wait), a download, a link that opens another
  // app, or anything the user does on the page meanwhile; at the latest after
  // LEAVING_MAX_MS. Returning from the back/forward cache hides it too.
  const LEAVING_MAX_MS = 10000;
  let leaving = false;
  let leavingTimer = null;
  function stayed() {
    if (!leaving) return;
    leaving = false;
    clearTimeout(leavingTimer);
    hidePill();
  }
  addEventListener('beforeunload', (event) => {
    if (page.firstRender() || pullRefreshing()) return; // nothing drawn yet / the pull spinner shows it
    leaving = true;
    showPill();
    clearTimeout(leavingTimer);
    leavingTimer = setTimeout(stayed, LEAVING_MAX_MS);
    setTimeout(() => {
      const prompted = event.defaultPrevented || (typeof event.returnValue === 'string' && event.returnValue !== '');
      if (prompted) stayed();
    });
  });
  addEventListener('pageshow', (event) => { if (event.persisted) stayed(); });
  for (const type of ['pointerdown', 'keydown']) addEventListener(type, stayed, true);
  onCard((win) => {
    for (const type of ['pointerdown', 'keydown']) win.addEventListener(type, stayed, true);
  });

  // Same-page navigations a site runs through the Navigation API
  // (navigation.intercept, e.g. some single-page apps): show the pill while
  // one takes longer than TRANSITION_PILL_MS, until it finishes. Without the
  // API (or for sites that don't use it) nothing changes.
  const TRANSITION_PILL_MS = 150;
  const watchTransitions = (navigation) => navigation?.addEventListener?.('navigate', () => {
    setTimeout(() => { // the page decides during the event whether it intercepts
      const transition = navigation.transition;
      if (!transition?.finished || page.firstRender()) return;
      let done = false;
      let shownAt = null;
      const timer = setTimeout(() => {
        if (done || leaving) return;
        shownAt = performance.now();
        showPill();
      }, TRANSITION_PILL_MS);
      const finish = () => {
        done = true;
        clearTimeout(timer);
        if (shownAt != null && !leaving) hidePill(Math.max(0, LOADER_MIN_MS - (performance.now() - shownAt)));
      };
      transition.finished.then(finish, finish);
    });
  });
  watchTransitions(globalThis.navigation);
  onCard((win) => watchTransitions(win.navigation));

  return {
    start: startLoader, // at the first render, once its position is known
    // The first-paint placeholder's pill was showing until Margin ran.
    tookOverPlaceholder: () => { placeholderTookOver = true; },
  };
}
