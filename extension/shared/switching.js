// A switch to another tab, from this page: a click in the sidebar or the
// palette, a next/previous key (the background says which tab). The switch
// itself can take a moment (the background first wakes a hidden tab:
// background/tabs.js wakeTab), so the sidebar highlights the tab at once,
// this page's own tab softly (shared/view.js sidebar `switchingTo`), and if it
// takes longer than SLOW_MS the loading pill shows (a theme may cover the
// page instead: content/core.js). It ends when this page is hidden (the
// switch landed); GRACE_MS after the request says it's done if this page is
// still showing (Chrome's split view keeps it on screen); at once if the
// request failed (`failed(result)`: the tab is gone, the browser didn't show
// it, no answer), and then `onFailed` says so, rather than the highlight just
// going back; and at the latest after MAX_MS, longer than a switch request
// waits for its answer (content/core.js), or UNASKED_MAX_MS for one that
// came without a request. Used by content/core.js and the new-tab page.
// A switch to a new tab the background is opening (an address or a search
// chosen in the palette: background/tabs.js openBehind): the page is covered
// at once, before the tab exists; its id comes with the background's
// 'switching', which takes over.
export const NEW_TAB = -1;
// Whether a palette request opens such a tab: an address in a new tab, or a
// search not in this tab.
export const opensNewTab = (/** @type {string} */ type, /** @type {any} */ payload) =>
  (type === 'newTab' && !!payload?.url) || (type === 'search' && payload?.tabId == null);
const SLOW_MS = 150;
const GRACE_MS = 300;
const MAX_MS = 8000;
const UNASKED_MAX_MS = 2500;

/**
 * @param {{ onChange: (tabId: number | null) => void, onSlow: (slow: boolean) => void, failed?: (result: unknown) => boolean, onFailed?: (tabId: number) => void, doc?: Document }} options
 * `onChange`: redraw the sidebar with this target (null: none); `onSlow`: the pill on or off;
 * `failed`: whether a request's result means it didn't switch (default: never).
 */
export function createSwitching({ onChange, onSlow, failed = () => false, onFailed = () => {}, doc = document }) {
  /** @type {number | null} */
  let target = null;
  let current = null; // this start's token: an older start's request can't end a newer one
  let slow = false;
  /** @type {ReturnType<typeof setTimeout>[]} */
  let timers = [];
  const clearTimers = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };
  const stopPill = () => {
    if (!slow) return;
    slow = false;
    onSlow(false);
  };
  function end() {
    if (target == null) return;
    target = null;
    current = null;
    clearTimers();
    stopPill();
    onChange(null);
  }
  /** @param {number} tabId @param {Promise<unknown> | null} [request] the switch request, if this page made it */
  function start(tabId, request = null) {
    if (!Number.isInteger(tabId) || doc.hidden) return;
    clearTimers();
    const token = {};
    current = token;
    target = tabId;
    onChange(tabId);
    const mine = () => current === token;
    timers.push(setTimeout(() => {
      if (!mine() || slow) return;
      slow = true;
      onSlow(true);
    }, SLOW_MS));
    timers.push(setTimeout(() => mine() && end(), request ? MAX_MS : UNASKED_MAX_MS));
    const didFail = () => {
      if (!mine()) return;
      end();
      onFailed(tabId);
    };
    request?.then(
      (result) => {
        if (!mine()) return;
        if (failed(result)) return didFail();
        clearTimers();
        stopPill();
        timers.push(setTimeout(() => mine() && end(), GRACE_MS));
      },
      didFail,
    );
  }
  doc.addEventListener('visibilitychange', () => doc.hidden && end());
  doc.defaultView?.addEventListener('pagehide', end);
  return { start, end, target: () => target };
}

// A switch the background makes from this page (next/previous key): it says
// when it's done or failed (background/navigation.js 'switch-done',
// 'switch-failed'), which stands in for the request of a switch this page
// makes itself: failed ends it at once, done shortly after if this page is
// still showing (Chrome's split view keeps it on screen).
export function backgroundSwitches() {
  /** @type {{ tabId: number, resolve: () => void, reject: () => void } | null} */
  let pending = null;
  return {
    /** @param {number} tabId @returns {Promise<any>} the request to pass to start() */
    begin(tabId) {
      pending?.resolve(); // a newer one takes over (start() ignores the old)
      /** @type {(value?: any) => void} */ let resolve = () => {};
      /** @type {(reason: Error) => void} */ let reject = () => {};
      /** @type {Promise<any>} */
      const request = new Promise((res, rej) => { resolve = res; reject = rej; });
      request.catch(() => {}); // a switch that never started
      // Done resolves as a page's own switch request does ({ shown }), so it isn't taken for a failure.
      pending = { tabId, resolve: () => resolve(/** @type {any} */ ({ shown: tabId })), reject: () => reject(new Error('switch failed')) };
      return request;
    },
    /** @param {{ type: string, tabId?: number }} message 'switch-done' or 'switch-failed' */
    settle({ type, tabId }) {
      if (!pending || pending.tabId !== tabId) return;
      (type === 'switch-done' ? pending.resolve : pending.reject)();
      pending = null;
    },
  };
}
