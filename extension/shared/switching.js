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
// How long past its deadline a page waits for a switch's answer (content/core.js
// send, themes/arcadia/newtab.js: `waitsUntil`), for a background whose
// timers fire late on a Mac that busy, or a Safari slow to carry out the show.
export const SWITCH_GRACE_MS = 3000;
const MAX_MS = 7000 + SWITCH_GRACE_MS + 500; // a switch request's 7 s, and its grace for a late answer
const UNASKED_MAX_MS = 2500;

// A UI that stays on screen through the switch (Margin.app's overlay) can't
// end on being hidden: with `landed`, a switch that went through ends once
// the state it draws from says the tab is in front (`settle()`, called as the
// state changes), or the state says another tab came to the front since,
// or SETTLE_MS after its answer at the latest. Ending on the answer alone
// (GRACE_MS later, or at once for the background's word) let the highlight
// go back to the tab left until the state caught up, then forward again: a
// flicker (Tirth, 2026-11-05; Phase 2 step 8).
export const SETTLE_MS = 2000;

/**
 * @param {{ onChange: (tabId: number | null) => void, onSlow: (slow: boolean) => void, failed?: (result: unknown) => boolean, onFailed?: (tabId: number) => void, doc?: Document, landed?: ((tabId: number, from: number | null) => boolean | null) | null, front?: (() => number | null) | null }} options
 * `onChange`: redraw the sidebar with this target (null: none); `onSlow`: the pill on or off;
 * `failed`: whether a request's result means it didn't switch (default: never);
 * `front`: the tab in front as
 * the state has it, and `landed(tabId, from)`: true once the state has the
 * tab in front, null while it still has `from` (the tab in front at the
 * start), false once another tab came to the front (the switch is over
 * either way).
 */
export function createSwitching({ onChange, onSlow, failed = () => false, onFailed = () => {}, doc = document, landed = null, front = null }) {
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
  let from = null; // the tab in front as the switch started (`landed`)
  // The state changed: a switch it says is over ends (`landed`).
  function settle() {
    if (target == null || !landed) return;
    if (landed(target, from) != null) end();
  }
  /** @param {number} tabId @param {Promise<unknown> | null} [request] the switch request, if this page made it */
  function start(tabId, request = null) {
    if (!Number.isInteger(tabId) || doc.hidden) return;
    clearTimers();
    const token = {};
    current = token;
    target = tabId;
    from = front?.() ?? null;
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
        if (landed) {
          if (landed(tabId, from) != null) return end();
          timers.push(setTimeout(() => mine() && end(), SETTLE_MS));
          return;
        }
        timers.push(setTimeout(() => mine() && end(), GRACE_MS));
      },
      didFail,
    );
  }
  // Hidden (another tab came to the front): over.
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) end(); });
  doc.defaultView?.addEventListener('pagehide', end);
  return { start, end, settle, target: () => target };
}

// A switch the background makes from this page (next/previous key): it says
// when it's done or failed (background/navigation.js 'switch-done',
// 'switch-failed'), which stands in for the request of a switch this page
// makes itself: failed ends it at once, done shortly after if this page is
// still showing (Chrome's split view keeps it on screen). `switchId`, when the
// background gives one (background/tabs.js coverFront): only that switch's
// word settles it (an older switch to the same tab, called off, says it's done).
export function backgroundSwitches() {
  /** @type {{ tabId: number, switchId: string | null, resolve: () => void, reject: () => void } | null} */
  let pending = null;
  return {
    /** @param {number} tabId @param {string | null} [switchId] @returns {Promise<any>} the request to pass to start() */
    begin(tabId, switchId = null) {
      pending?.resolve(); // a newer one takes over (start() ignores the old)
      /** @type {(value?: any) => void} */ let resolve = () => {};
      /** @type {(reason: Error) => void} */ let reject = () => {};
      /** @type {Promise<any>} */
      const request = new Promise((res, rej) => { resolve = res; reject = rej; });
      request.catch(() => {}); // a switch that never started
      // Done resolves as a page's own switch request does ({ shown }), so it isn't taken for a failure.
      pending = { tabId, switchId: switchId ?? null, resolve: () => resolve(/** @type {any} */ ({ shown: tabId })), reject: () => reject(new Error('switch failed')) };
      return request;
    },
    /** @param {{ type: string, tabId?: number, switchId?: string | null }} message 'switch-done' or 'switch-failed' */
    settle({ type, tabId, switchId = null }) {
      if (!pending || pending.tabId !== tabId || pending.switchId !== (switchId ?? null)) return;
      (type === 'switch-done' ? pending.resolve : pending.reject)();
      pending = null;
    },
  };
}
