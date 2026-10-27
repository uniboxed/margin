import * as M from '../state/model.js';
import * as V from '../shared/view.js';
import { api, load, mutate, now } from './store.js';
import { wakeTab } from './tabs.js';
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
    const asked = Date.now();
    // A tab only passed through (more presses waiting: a held key) isn't
    // waited for long, so the switching stops when the key does.
    const wake = queued > 0 ? await Promise.race([wakeTab(next), new Promise((resolve) => setTimeout(() => resolve(null), PASS_THROUGH_MS))]) : await wakeTab(next);
    await api.tabs.update(next, { active: true });
    recordSwitch({ source: action, tabId: next, asked, wake, shownAfter: Date.now() - asked });
    await mutate((st) => M.activateTab(st, next, windowId, now()));
    // Presses come in runs: the tab after this one is woken now, so the
    // next press doesn't wait for it (background/tabs.js wakeTab).
    const after = V.cycleTab(await load(), windowId, next, action === 'next-tab' ? 1 : -1);
    if (after != null && after !== current) void wakeTab(after);
  } else if (action === 'next-space' || action === 'prev-space') {
    const spaceId = V.cycleSpace(s, windowId, action === 'next-space' ? 1 : -1);
    if (spaceId == null) return;
    await mutate((st) => M.setActiveSpace(st, windowId, spaceId));
    // Show where you landed (auto-hide mode); Margin's own pages ignore it.
    const [tab] = await api.tabs.query({ active: true, windowId });
    if (tab) api.tabs.sendMessage(tab.id, { type: 'command', command: 'peek' }).catch(() => {});
  }
}

export const NAV_ACTIONS = new Set(['next-tab', 'prev-tab', 'next-space', 'prev-space']);
