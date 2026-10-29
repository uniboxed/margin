import * as M from '../state/model.js';
import * as V from '../shared/view.js';
import { api, load, mutate, now } from './store.js';
import { activating, focusTab, openTab, tellPage, userSwitched, wakeTab } from './tabs.js';
import { recordSwitch } from './diagnostics.js';

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
        const wake = await Promise.race([wakeTab(next), new Promise((resolve) => setTimeout(() => resolve(null), PASS_THROUGH_MS))]);
        userSwitched(null, windowId); // a switch still waiting for its wake doesn't land after this one
        activating(next);
        await api.tabs.update(next, { active: true });
        recordSwitch({ source: action, tabId: next, asked, wake, shownAfter: Date.now() - asked });
      } else {
        // The last key in a run is the frame the user keeps. Give it the same
        // hidden render acknowledgement as a click; intermediate held-key
        // tabs stay on the short pass-through path above.
        const focused = await focusTab(next, { source: action });
        if (!focused?.tab) {
          told('switch-failed');
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
    // next press doesn't wait for it (background/tabs.js wakeTab).
    const after = V.cycleTab(await load(), windowId, next, action === 'next-tab' ? 1 : -1);
    if (after != null && after !== current) void wakeTab(after);
  } else if (action === 'next-space' || action === 'prev-space') {
    const spaceId = V.cycleSpace(s, windowId, action === 'next-space' ? 1 : -1);
    if (spaceId == null) return;
    await showSpace(windowId, spaceId, { bringTab: queued === 0 });
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
/** @param {number} windowId @param {string} spaceId @param {{ bringTab?: boolean, carry?: 'hover' | 'toggle' | null, scroll?: number | null, deadline?: number }} [options] */
export async function showSpace(windowId, spaceId, { bringTab = true, carry = null, scroll = null, deadline } = {}) {
  if (windowId == null) return;
  let before = null;
  const s = await mutate((st) => {
    before = V.activeSpaceId(st, windowId);
    return M.setActiveSpace(st, windowId, spaceId);
  });
  if (V.activeSpaceId(s, windowId) !== spaceId || !bringTab) return; // no such space, or only the sidebar
  const [shown] = await api.tabs.query({ active: true, windowId });
  if (shown && s.tabSpace[shown.id] === spaceId) return;
  const candidates = Object.values(s.tabs)
    .filter((t) => t.windowId === windowId && s.tabSpace[t.id] === spaceId && t.id !== shown?.id)
    .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
  for (const tab of candidates) {
    try {
      return await focusTab(tab.id, { source: 'space', carry, scroll, deadline });
    } catch (err) {
      // Closed meanwhile: the next one. Anything else (Safari didn't switch,
      // too late) is this switch failing, not a reason to open a start page:
      // the window goes back to the space it showed (its tab in front is still
      // of that one), unless something else changed it meanwhile.
      if (!/No tab with id/i.test(String(err?.message ?? err))) {
        if (before && before !== spaceId) {
          await mutate((st) => (V.activeSpaceId(st, windowId) === spaceId ? M.setActiveSpace(st, windowId, before) : st)).catch(() => {});
        }
        throw err;
      }
    }
  }
  const startPage = api.runtime.getURL('newtab/newtab.html#launcher');
  const untouched = shown && (shown.url === startPage || V.isNewTabPage(shown.url || shown.pendingUrl));
  if (untouched) await mutate((st) => M.moveTab(st, shown.id, spaceId));
  else await openTab({ windowId, url: startPage, spaceId });
}
