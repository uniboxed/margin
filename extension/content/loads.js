// What a page says of its own loads, for Margin.app's sidebar to show it
// loading (background/page-loads.js; Margin 2 Phase 2 step 7). Pages draw
// nothing of Margin's: this only tells. Called by content/core.js, which
// says whether Margin.app draws Margin around the window (`on`): nothing is
// said otherwise.
//
// - Leaving the page (⌘R, a link, a form, a script navigation): said at once
//   (`beforeunload`), long before the next page commits and Safari says the
//   tab is loading. Taken back if the page stays after all: a "Leave page?"
//   prompt (checked once the event is done), a download, a link that opens
//   another app, anything the user does on the page meanwhile, back from the
//   back/forward cache; at the latest after LEAVING_MAX_MS (the background
//   also ends it when the tab's next load is done, and after its own time).
//   `beforeunload` doesn't keep pages out of the back/forward cache in WebKit.
// - A site's own same-page navigation through the Navigation API
//   (navigation.intercept, as some single-page apps do) that takes longer
//   than TRANSITION_MS: said until it finishes. Without the API, or for sites
//   that don't use it, nothing.
// (The rules are the page-load pill's from before step 5: content/loader.js.)
export const LEAVING_MAX_MS = 10_000;
export const TRANSITION_MS = 150;

/**
 * @param {{ on: () => boolean, send: (type: 'pageLoading', payload: { on: boolean, why: 'leaving' | 'navigating' }) => unknown, win?: any }} options
 */
export function startLoads({ on, send, win = globalThis }) {
  const say = (/** @type {boolean} */ loading, /** @type {'leaving' | 'navigating'} */ why) => { if (on()) void send('pageLoading', { on: loading, why }); };
  let leaving = false;
  let leavingTimer = null;
  const stayed = () => {
    if (!leaving) return;
    leaving = false;
    clearTimeout(leavingTimer);
    say(false, 'leaving');
  };
  win.addEventListener('beforeunload', (/** @type {BeforeUnloadEvent} */ event) => {
    if (!on()) return;
    leaving = true;
    say(true, 'leaving');
    clearTimeout(leavingTimer);
    leavingTimer = setTimeout(stayed, LEAVING_MAX_MS);
    setTimeout(() => {
      const prompted = event.defaultPrevented || (typeof event.returnValue === 'string' && event.returnValue !== '');
      if (prompted) stayed();
    });
  });
  win.addEventListener('pageshow', (/** @type {PageTransitionEvent} */ event) => { if (event.persisted) stayed(); });
  for (const type of ['pointerdown', 'keydown']) win.addEventListener(type, stayed, true);

  const navigation = win.navigation;
  navigation?.addEventListener?.('navigate', () => {
    // The page decides during the event whether it intercepts.
    setTimeout(() => {
      const finished = navigation.transition?.finished;
      if (!finished) return;
      let done = false;
      let told = false;
      const timer = setTimeout(() => {
        if (done || leaving) return;
        told = true;
        say(true, 'navigating');
      }, TRANSITION_MS);
      const finish = () => {
        done = true;
        clearTimeout(timer);
        if (told) say(false, 'navigating');
      };
      finished.then(finish, finish);
    });
  });
  return { leaving: () => leaving };
}
