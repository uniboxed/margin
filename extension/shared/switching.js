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
// end on being hidden: given `front` (the tab in front as the state it draws
// from has it), a switch that went through ends once that state says the tab
// is in front (`settle()`, called as the state changes), or the state says
// another tab came to the front since, or SETTLE_MS after its answer at the
// latest. Ending on the answer alone (GRACE_MS later, or at once for the
// background's word) let the highlight go back to the tab left until the
// state caught up, then forward again: a flicker (Tirth, 2026-11-05; Phase 2
// step 8).
export const SETTLE_MS = 2000;
// A chain of switches (keys pressed fast, a click during them): one switch
// starts while the state still has an earlier one's tab in front, or hasn't
// even had it yet (the copy's 'switching' goes out at the press, the state's
// change only after Safari's storage event, 100 ms and more later). The chain
// keeps the tab in front as it started (`from`) and the tabs it went past
// (`passed`); the state with one of those in front is the chain's own echo,
// not the user going elsewhere, so the highlight stays on the newest target
// and never goes back. A passed tab is taken as an echo for PASSED_MS after
// the state first has it in front: past that, it's a real switch the chain
// didn't make (Safari showing a neighbour after the target closed), and the
// highlight follows it. The PASSED_MS only start once the newest target's
// request is answered: while Safari is still carrying it out (a slow switch
// takes 450 ms and more), a passed tab in front is the chain's own echo for up
// to SETTLE_MS (a request whose answer never comes doesn't hold the highlight
// past that). A target the state had in front as it was asked for
// (back to the chain's start, or to a passed tab already shown) has landed
// only once the state has had another tab in front since: until then the
// state's front is stale, and an earlier target's late change would show it.
export const PASSED_MS = 300;
// Each chain (`front` only), as it ends, to `onRun` for Margin.app's log: how many targets it had,
// whether it ended on its last one, and whether the highlight went back (to the tab it started
// from, or one it passed: that's the flicker, and it must never happen) or elsewhere (another tab
// came to the front, a real switch it didn't make), and how long after its last target it ended.
/** @typedef {{ targets: number, landed: boolean, back: number, elsewhere: number, failed: boolean, ms: number }} SwitchRun */
/** A chain as a line for the log (app/overlay/overlay.js); null for a lone switch that landed. @param {SwitchRun} run */
export function describeSwitchRun(run) {
  if (run.targets < 2 && run.landed) return null;
  const end = run.failed ? 'failed' : run.landed ? 'on its last target' : run.back ? 'back on a tab it had passed' : 'on another tab (a switch it didn\'t make)';
  return `switch chain: ${run.targets} target${run.targets === 1 ? '' : 's'} highlighted, ended ${end} ${run.ms} ms after the last; the highlight went back ${run.back} time${run.back === 1 ? '' : 's'}`;
}

/**
 * @param {{ onChange: (tabId: number | null) => void, onSlow: (slow: boolean) => void, failed?: (result: unknown) => boolean, onFailed?: (tabId: number) => void, doc?: Document, front?: (() => number | null) | null, onRun?: ((run: SwitchRun) => void) | null }} options
 * `onChange`: redraw the sidebar with this target (null: none); `onSlow`: the pill on or off;
 * `failed`: whether a request's result means it didn't switch (default: never);
 * `front`: the tab in front as the state has it, for a UI that stays on
 * screen (above): with it, a switch ends as the state says it landed;
 * `onRun`: each chain as it ends (SwitchRun, above).
 */
export function createSwitching({ onChange, onSlow, failed = () => false, onFailed = () => {}, doc = document, front = null, onRun = null }) {
  /** @type {number | null} */
  let target = null;
  let current = null; // this start's token: an older start's request can't end a newer one
  let slow = false;
  /** @type {ReturnType<typeof setTimeout>[]} */
  let timers = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let passedTimer = null;
  const clearTimers = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };
  const stopPill = () => {
    if (!slow) return;
    slow = false;
    onSlow(false);
  };
  /**
   * The chain under way (`front` only): `from`, the tab in front as it
   * started; `passed`, its earlier targets, each with when the state first
   * had it in front since it was passed (null: not yet); `stale`, the state
   * had this target in front as it was asked for; `other`, it has had
   * another tab in front since.
   * `targets`, `lastAt`: how many it had and when the last was asked, for `onRun`.
   * `answeredAt`: when the newest target's request was answered (null: not yet).
   * @type {{ from: number | null, passed: Map<number, number | null>, stale: boolean, other: boolean, targets: number, lastAt: number, answeredAt: number | null } | null}
   */
  let chain = null;
  function end(didFail = false) {
    if (passedTimer) clearTimeout(passedTimer);
    passedTimer = null;
    if (chain && onRun && front && target != null) {
      const f = front();
      const back = !didFail && f !== target && (f === chain.from || (f != null && chain.passed.has(f))) ? 1 : 0;
      const elsewhere = !didFail && f !== target && !back ? 1 : 0;
      try { onRun({ targets: chain.targets, landed: f === target, back, elsewhere, failed: didFail, ms: Date.now() - chain.lastAt }); } catch {}
    }
    chain = null;
    if (target == null) return;
    target = null;
    current = null;
    clearTimers();
    stopPill();
    onChange(null);
  }
  // What the state says of the switch under way: true, landed; null, not yet
  // (the tab it started from, or the chain's own echo); false, another tab
  // came to the front (over either way).
  function landed() {
    if (!front || !chain || target == null) return null;
    const f = front();
    if (f !== target) chain.other = true;
    if (f === target) return !chain.stale || chain.other ? true : null;
    if (f === chain.from) return null;
    if (f != null && chain.passed.has(f)) {
      const at = chain.passed.get(f) ?? Date.now();
      if (chain.passed.get(f) == null) chain.passed.set(f, at);
      // From when it's in front and the newest target's request is answered; unanswered, up to SETTLE_MS.
      const left = chain.answeredAt == null ? at + SETTLE_MS - Date.now() : Math.max(at, chain.answeredAt) + PASSED_MS - Date.now();
      if (left <= 0) return false;
      if (passedTimer) clearTimeout(passedTimer);
      passedTimer = setTimeout(() => { passedTimer = null; settle(); }, left + 1);
      return null;
    }
    return false;
  }
  // The state changed: a switch it says is over ends.
  function settle() {
    if (target == null || !front) return;
    if (landed() != null) end();
  }
  /** @param {number} tabId @param {Promise<unknown> | null} [request] the switch request, if this page made it */
  function start(tabId, request = null) {
    if (!Number.isInteger(tabId) || doc.hidden) return;
    clearTimers();
    if (front) {
      const f = front();
      // A new chain only with no switch under way; else this one goes on, past its last target.
      if (target == null || !chain) chain = { from: f, passed: new Map(), stale: false, other: false, targets: 0, lastAt: 0, answeredAt: null };
      else if (target !== tabId && target !== chain.from && !chain.passed.has(target)) chain.passed.set(target, null);
      chain.targets++;
      chain.lastAt = Date.now();
      chain.passed.delete(tabId);
      chain.stale = f === tabId;
      chain.other = false;
      chain.answeredAt = request ? null : Date.now();
    }
    const token = {};
    current = token;
    const was = target;
    target = tabId;
    if (front) landed(); // (a passed tab in front now: its time starts)
    if (was !== tabId) onChange(tabId);
    const mine = () => current === token;
    timers.push(setTimeout(() => {
      if (!mine() || slow) return;
      slow = true;
      onSlow(true);
    }, SLOW_MS));
    timers.push(setTimeout(() => mine() && end(), request ? MAX_MS : UNASKED_MAX_MS));
    const didFail = () => {
      if (!mine()) return;
      end(true);
      onFailed(tabId);
    };
    request?.then(
      (result) => {
        if (!mine()) return;
        if (failed(result)) return didFail();
        clearTimers();
        stopPill();
        if (front) {
          if (chain) chain.answeredAt = Date.now();
          if (landed() != null) return end();
          timers.push(setTimeout(() => mine() && end(), SETTLE_MS));
          return;
        }
        timers.push(setTimeout(() => mine() && end(), GRACE_MS));
      },
      didFail,
    );
  }
  // A switch to the tab the state has in front (a click on its row, its
  // space, the copy's key landing back on it): with a chain under way (and
  // `front`), the chain goes on to it, so an earlier target's late change
  // can't show that one; else a switch under way ends.
  /** @param {number} tabId @param {Promise<unknown> | null} [request] */
  function toFront(tabId, request = null) {
    if (front && target != null && Number.isInteger(tabId)) start(tabId, request);
    else end();
  }
  // Hidden (another tab came to the front): over.
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) end(); });
  doc.defaultView?.addEventListener('pagehide', () => end());
  return { start, toFront, end: () => end(), settle, target: () => target };
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

// A chain of next/previous-tab presses: each goes on from the one before for this long, else from the tab in front.
// The copy's (background/navigation.js) and Margin.app's overlay's own (app/overlay/overlay.js navTab), the same.
export const NAV_CHAIN_MS = 1500;
// The switch ids Margin.app's overlay gives the presses it highlights itself (overlay.js navTab): the copy's
// `switching` for them changes nothing there (the overlay is already on them, maybe on a newer one).
export const OVERLAY_SWITCH_PREFIX = 'ov-';

/**
 * The tab a next/previous-tab press goes to, picked where it's pressed (Margin.app's overlay: overlay.js navTab), by the
 * copy's rule (`cycle`: shared/view.js cycleTab, the order the sidebar shows, wrapping): from the last press's target
 * while the chain lasts (NAV_CHAIN_MS, that tab still known), else from the tab in front of the window. Null: nothing
 * to go to; undefined: nothing in front known yet (the copy works it out).
 * @param {{ tabs?: Record<string, any> } | null} state @param {number} windowId @param {{ tabId: number, at: number } | null} last
 * @param {number} dir @param {(state: any, windowId: number, from: number, dir: number) => number | null} cycle @param {number} [now]
 * @returns {number | null | undefined}
 */
export function pickNavTab(state, windowId, last, dir, cycle, now = Date.now()) {
  if (!state?.tabs) return undefined;
  const chained = last && now - last.at < NAV_CHAIN_MS && state.tabs[last.tabId] ? last.tabId : null;
  const front = Object.values(state.tabs).find((t) => t?.windowId === windowId && t?.active)?.id;
  const from = chained ?? front;
  if (!Number.isInteger(from)) return undefined;
  return cycle(state, windowId, from, dir);
}
