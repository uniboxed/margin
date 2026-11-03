import * as M from '../state/model.js';
import * as V from '../shared/view.js';
import { api, load, mutate, now, recheckSoon, StaleError } from './store.js';
import { activating, anyFocusing, focusTab, openTab, tellPage, userSwitched, wakeTab } from './tabs.js';
import { recordSwitch } from './diagnostics.js';
import { passing as keepReadyPassing, switchFacts } from './keep-ready.js';
import { platform } from '../shared/platform.js';

// Next/previous tab and space. Two delivery paths land here: the manifest
// `commands` (⌃⌘ + arrows; Safari matches them in the app, so they work
// whatever has focus and before a page's script has loaded) and the page's
// keydown listener (key repeat and custom shortcuts from Settings).
//  - One key press arriving through both paths counts once.
//  - Presses run one at a time, and each continues from the tab the previous
//    one chose (for a moment), so fast presses all count even before Safari
//    has finished switching.
//  - The window isn't re-focused when it already is (that could move keyboard
//    focus out of the page), and the sidebar highlight updates immediately.
const NAV_DEDUPE_MS = 150;
const NAV_CHAIN_MS = 1500;
const PASS_THROUGH_MS = 70;
const lastNav = { action: null, source: null, at: 0 };
export const navTarget = new Map(); // windowId → { tabId, at }
let navQueue = Promise.resolve();
let queued = 0; // presses waiting their turn
// The last tab woken ahead of a press (below): whether its page answered in
// time (null until it has, or ran out of time), and the tab a press since
// would wake ahead once it has.
/** @typedef {{ at: number, answered: boolean | null, next: number | null }} Ahead */
/** @type {Ahead | null} */
let ahead = null;
/** @param {number} tabId */
function wakeAhead(tabId) {
  /** @type {Ahead} */
  const mark = { at: now(), answered: null, next: null };
  ahead = mark;
  void wakeTab(tabId, { by: 'keys' }).then((woke) => woke.outcome !== 'timeout', () => true).then((answered) => {
    mark.answered = answered;
    if (answered && mark.next != null && ahead === mark) wakeAhead(mark.next);
  });
}

export function navigate(action, source, windowId) {
  const t = now();
  if (action === lastNav.action && source !== lastNav.source && t - lastNav.at < NAV_DEDUPE_MS) return navQueue;
  Object.assign(lastNav, { action, source, at: t });
  queued++;
  navQueue = navQueue.then(() => {
    queued--;
    return runNavigation(action, windowId);
  }).catch((err) => console.warn('[margin] navigate', err));
  return navQueue;
}

async function runNavigation(action, windowId) {
  if (windowId == null) return;
  const s = await load();
  if (action === 'next-tab' || action === 'prev-tab') {
    const chained = navTarget.get(windowId);
    const current = chained && now() - chained.at < NAV_CHAIN_MS && s.tabs[chained.tabId]
      ? chained.tabId
      : (await api.tabs.query({ active: true, windowId }))[0]?.id;
    const next = V.cycleTab(s, windowId, current, action === 'next-tab' ? 1 : -1);
    if (next == null) return;
    navTarget.set(windowId, { tabId: next, at: now() });
    // The page on screen highlights it already and covers itself until the
    // switch lands (shared/switching.js); not waited for. Not covered while
    // more presses wait (a held key): that page is only passed through and
    // stays visible. Margin's own new-tab page gets it too (Chrome), or only
    // the broadcast (Safari, where it has no content script); `from` says
    // which page it's for.
    // It's told when the switch is done or failed (closed meanwhile), as a
    // page's own switch learns from its request (shared/switching.js).
    const passing = queued > 0;
    const shownPage = api.tabs.query({ active: true, windowId }).then(([shown]) => {
      if (!shown || shown.id === next) return null;
      tellPage(shown, { type: 'switching', tabId: next, from: shown.id, passing });
      return shown;
    }, () => null);
    const told = (type, reason = null) => shownPage.then((shown) => shown && tellPage(shown, { type, tabId: next, from: shown.id, ...(reason ? { reason } : {}) }));
    try {
      // A tab only passed through (more presses waiting: a held key) isn't
      // waited for long, so the switching stops when the key does.
      if (passing) {
        const asked = Date.now();
        const facts = switchFacts(next, asked); // DEVELOPMENT DIAGNOSTICS
        const wake = await Promise.race([wakeTab(next, { by: 'keys' }), new Promise((resolve) => setTimeout(() => resolve(null), PASS_THROUGH_MS))]);
        userSwitched(null, windowId); // a switch still waiting for its wake doesn't land after this one
        // A tab Safari unloaded isn't shown in passing (its empty view, and its
        // load in front, for an instant): the highlight moves on, and the tab
        // the key stops on is loaded behind the page (background/tabs.js restoreTab).
        // Nor one whose wake hasn't answered by then (Safari suspended it, and
        // resumes it at background priority, or it's too busy to draw anyway):
        // shown, it would be Safari's empty view until the next press. The
        // tab the key stops on waits for its answer (tabs.js mayWait).
        if ((wake?.outcome === 'no page' && platform?.restoreTabs) || (wake == null && platform?.wakeTabs)) {
          recordSwitch({ source: action, tabId: next, asked, ...facts, wake, error: 'passed over' });
          void told('switch-done');
          return;
        }
        activating(next);
        // Keep-ready doesn't hold it for this once it's left, and counts it by
        // its use before (background/keep-ready.js passing).
        keepReadyPassing(next, s.tabs[next]?.lastActive);
        await api.tabs.update(next, { active: true });
        recordSwitch({ source: action, tabId: next, asked, ...facts, wake, shownAfter: Date.now() - asked });
      } else {
        // The last key in a run is the frame the user keeps. Give it the same
        // hidden render acknowledgement as a click; intermediate held-key
        // tabs stay on the short pass-through path above. One that isn't
        // ready to show isn't waited for once another press comes: that one
        // goes on from it (the tab stays behind, loading).
        const focused = await focusTab(next, { source: action, hurry: () => queued > 0 });
        if (!focused?.tab) {
          told(focused?.hurried ? 'switch-done' : 'switch-failed');
          return;
        }
      }
    } catch (err) {
      told('switch-failed', String(err?.message ?? err));
      throw err;
    }
    told('switch-done');
    await mutate((st) => M.activateTab(st, next, windowId, now()));
    // Presses come in runs: the tab after this one is woken now, so the
    // next press doesn't wait for it (background/tabs.js wakeTab). Only once
    // the one woken ahead before answered in time (or in another run of
    // presses): one that didn't was a process Safari suspended, resumed at
    // background priority, and another wake would only queue behind it. One
    // that hasn't answered yet (a held key's presses come faster than a busy
    // page answers): this one goes out as it does, if it does in time.
    const after = V.cycleTab(await load(), windowId, next, action === 'next-tab' ? 1 : -1);
    if (after != null && after !== current) {
      if (!ahead || ahead.answered || now() - ahead.at >= NAV_CHAIN_MS) wakeAhead(after);
      else if (ahead.answered === null) ahead.next = after;
    }
  } else if (action === 'next-space' || action === 'prev-space') {
    const spaceId = V.cycleSpace(s, windowId, action === 'next-space' ? 1 : -1);
    if (spaceId == null) return;
    await showSpace(windowId, spaceId, { bringTab: queued === 0, hurry: () => queued > 0 });
    // Show where you landed (auto-hide mode); Margin's own pages ignore it.
    const [tab] = await api.tabs.query({ active: true, windowId });
    if (tab) api.tabs.sendMessage(tab.id, { type: 'command', command: 'peek' }).catch(() => {});
  }
}

export const NAV_ACTIONS = new Set(['next-tab', 'prev-tab', 'next-space', 'prev-space']);

// A space shown in a window (Arc): the window's sidebar shows it, and its
// most recent tab in that window comes to the front (the tab shown stays if
// it's already one of the space's); with none there, Margin's start page
// opens in it, or the untouched start or new-tab page in front moves to it
// (no pile of empty pages). `bringTab: false`: only the sidebar's space
// (held keys pass spaces; the last press brings the tab).
// `hurry`: as focusTab's.
// A switch to one of its tabs doesn't wait for the space to be written
// where pages are prepared (Safari): the write waits for the next one, the
// activation's (which sets the same space: background.js followTab),
// SPACE_WRITE_MS at most. A write under way as the tab is prepared would make
// the page read storage before drawing (store.js stateRev), and the page
// draws its own tab's space anyway (content/core.js stateForShow). What to
// bring is still read from the state the change is made to, behind every
// change queued before it (the cache can be behind those while a write is
// under way): the tab used last, a tab just moved to the space staying.
const SPACE_WRITE_MS = 2000;
/** @param {number} windowId @param {string} spaceId @param {{ bringTab?: boolean, carry?: 'hover' | 'toggle' | null, scroll?: number | null, deadline?: number, hurry?: (() => boolean) | null }} [options] */
export async function showSpace(windowId, spaceId, { bringTab = true, carry = null, scroll = null, deadline, hurry = null } = {}) {
  if (windowId == null) return;
  const [shown] = bringTab ? await api.tabs.query({ active: true, windowId }) : [];
  /** @param {import('../../types/margin').State} st */
  const candidatesIn = (st) => Object.values(st.tabs)
    .filter((t) => t.windowId === windowId && st.tabSpace[t.id] === spaceId && t.id !== shown?.id)
    .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
  /** @param {import('../../types/margin').State} st */
  const switching = (st) => bringTab && st.spaces.some((x) => x.id === spaceId) && !(shown && st.tabSpace[shown.id] === spaceId) && candidatesIn(st).length > 0;
  // The write that waits doesn't ask whether this copy still owns the state
  // (store.js flush does, as it writes): asked here (at most once a second),
  // so a copy a newer one replaced fails as stale, and its page stands down,
  // rather than switching tabs from its own state, out of date.
  if (platform?.prepareSidebar && (await recheckSoon()) !== 'owner') throw new StaleError();
  let before = null;
  const s = await mutate((st) => {
    before = V.activeSpaceId(st, windowId);
    return M.setActiveSpace(st, windowId, spaceId);
  }, platform?.prepareSidebar ? { within: (st) => (switching(st) ? SPACE_WRITE_MS : null) } : undefined);
  if (V.activeSpaceId(s, windowId) !== spaceId || !bringTab) return; // no such space, or only the sidebar
  if (shown && s.tabSpace[shown.id] === spaceId) return;
  const candidates = candidatesIn(s);
  // The window back to the space it showed (its tab in front is still of that
  // one), unless something else changed it meanwhile.
  const goBack = async () => {
    if (!before || before === spaceId) return;
    const [front] = await api.tabs.query({ active: true, windowId }).catch(() => []);
    await mutate((st) => (V.activeSpaceId(st, windowId) === spaceId && (!front || st.tabSpace[front.id] === before) ? M.setActiveSpace(st, windowId, before) : st)).catch(() => {});
  };
  for (const tab of candidates) {
    try {
      const result = await focusTab(tab.id, { source: 'space', carry, scroll, deadline, hurry, retry: true });
      // Called off while its tab loaded behind the page (Escape on its cover),
      // not by another switch of Margin's (that one sets its own space) nor a
      // key press (the next press goes on from this space).
      if (!result?.tab && !result?.hurried && !anyFocusing()) await goBack();
      return result;
    } catch (err) {
      // Closed meanwhile: the next one. Anything else (Safari didn't switch,
      // too late) is this switch failing, not a reason to open a start page.
      if (!/No tab with id/i.test(String(err?.message ?? err))) {
        await goBack();
        throw err;
      }
    }
  }
  const startPage = api.runtime.getURL('newtab/newtab.html#launcher');
  const untouched = shown && (shown.url === startPage || V.isNewTabPage(shown.url || shown.pendingUrl));
  if (untouched) await mutate((st) => M.moveTab(st, shown.id, spaceId));
  else await openTab({ windowId, url: startPage, spaceId, deadline });
}
