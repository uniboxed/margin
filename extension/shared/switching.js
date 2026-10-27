// A switch to another tab, from this page: a click in the sidebar or the
// palette, a next/previous key (the background says which tab). The switch
// itself can take a moment (the background first wakes a hidden tab:
// background/tabs.js wakeTab), so the sidebar highlights the tab at once,
// this page's own tab softly (shared/view.js sidebar `switchingTo`), and if it
// takes longer than SLOW_MS the loading pill shows (a theme may cover the
// page instead: content/core.js). It ends when this page is
// hidden (the switch landed), GRACE_MS after the switch request is done if
// this page is still showing (it failed: Margin's send resolves either way;
// the pill goes as soon as the request is done), at once if the send itself
// fails, and at the latest after MAX_MS. Used by content/core.js and the
// new-tab page.
const SLOW_MS = 150;
const GRACE_MS = 300;
const MAX_MS = 2500;

/**
 * @param {{ onChange: (tabId: number | null) => void, onSlow: (slow: boolean) => void, doc?: Document }} options
 * `onChange`: redraw the sidebar with this target (null: none); `onSlow`: the pill on or off.
 */
export function createSwitching({ onChange, onSlow, doc = document }) {
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
    timers.push(setTimeout(() => mine() && end(), MAX_MS));
    request?.then(
      () => {
        if (!mine()) return;
        clearTimers();
        stopPill();
        timers.push(setTimeout(() => mine() && end(), GRACE_MS));
      },
      () => mine() && end(),
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
    /** @param {number} tabId @returns {Promise<void>} the request to pass to start() */
    begin(tabId) {
      pending?.resolve(); // a newer one takes over (start() ignores the old)
      /** @type {(value?: void) => void} */ let resolve = () => {};
      /** @type {(reason: Error) => void} */ let reject = () => {};
      /** @type {Promise<void>} */
      const request = new Promise((res, rej) => { resolve = res; reject = rej; });
      request.catch(() => {}); // a switch that never started
      pending = { tabId, resolve: () => resolve(), reject: () => reject(new Error('switch failed')) };
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
