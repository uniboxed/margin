import * as M from '../state/model.js';
import * as V from '../shared/view.js';
import { api, cached, isSynced, load, mutate, now, recheckSoon, StaleError } from './store.js';
import { anyFocusing, focusTab, openTab, tellPage } from './tabs.js';

// Next/previous tab and space. Three delivery paths land here: Margin.app's
// keys (`navigate` requests, while it draws Margin), the manifest `commands`
// (⌃⌘ + arrows; they work where Margin has no page listener: Safari's own
// pages, the address bar, a page before its script has loaded) and the
// page's keydown listener (key repeat, custom shortcuts from Settings, and on
// Safari the commands' keys too: Safari runs a command only once the focused
// page has turned the key down, and a page that calls preventDefault on its
// arrows ate it, shared/shortcuts.js).
//  - One key press arriving through two paths counts once.
//  - Presses run one at a time, and each continues from the tab the previous
//    one chose (for a moment), so fast presses all count even before Safari
//    has finished switching.
//  - Each is the plain switch (background/tabs.js focusTab): no wakes ahead,
//    no passing checks (Phase 2 step 8).
//  - The window's page and Margin.app's overlay are told the switch is under
//    way ('switching': the overlay highlights the tab at once, and keeps it
//    until the state has it in front), then done or failed.
const NAV_DEDUPE_MS = 150;
const NAV_CHAIN_MS = 1500;
const lastNav = { action: null, source: null, at: 0 };
export const navTarget = new Map(); // windowId → { tabId, at }
let navQueue = Promise.resolve();

export function navigate(action, source, windowId) {
  const t = now();
  if (action === lastNav.action && source !== lastNav.source && t - lastNav.at < NAV_DEDUPE_MS) return navQueue;
  Object.assign(lastNav, { action, source, at: t });
  navQueue = navQueue.then(() => runNavigation(action, windowId)).catch((err) => console.warn('[margin] navigate', err));
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
    // The page on screen and the overlay highlight it at once; told when it's
    // done or failed (closed meanwhile). `from` says which page it's for
    // (Margin's own pages hear it as a broadcast).
    const shownPage = api.tabs.query({ active: true, windowId }).then(([shown]) => {
      if (!shown || shown.id === next) return null;
      tellPage(shown, { type: 'switching', tabId: next, from: shown.id });
      return shown;
    }, () => null);
    const told = (type, reason = null) => shownPage.then((shown) => shown && tellPage(shown, { type, tabId: next, from: shown.id, ...(reason ? { reason } : {}) }));
    try {
      await focusTab(next, { source: action });
    } catch (err) {
      void told('switch-failed', String(err?.message ?? err));
      throw err;
    }
    void told('switch-done');
    await mutate((st) => M.activateTab(st, next, windowId, now()));
  } else if (action === 'next-space' || action === 'prev-space') {
    const spaceId = V.cycleSpace(s, windowId, action === 'next-space' ? 1 : -1);
    if (spaceId == null) return;
    await showSpace(windowId, spaceId);
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
// (no pile of empty pages). `bringTab: false`: only the sidebar's space.
// A switch to one of its tabs doesn't wait for the space to be written: the
// write waits for the next one, the activation's (which sets the same space:
// background.js followTab), SPACE_WRITE_MS at most, so the switch isn't held
// up behind a storage write. What to bring is still read from the state the
// change is made to, behind every change queued before it (the cache can be
// behind those while a write is under way): the tab used last, a tab just
// moved to the space staying.
const SPACE_WRITE_MS = 2000;
// The tab in front of the window: Safari's answer, or, past FRONT_KNOWN_MS,
// Margin's own (its tabs matched to the open ones): after a reboot Safari
// took seconds to answer (2026-11-03), and a space's switch waited that long
// before it started.
const FRONT_KNOWN_MS = 150;
/** @param {number} windowId */
async function frontOf(windowId) {
  /** @type {Promise<{ tab: any }>} */
  const asking = Promise.resolve().then(() => api.tabs.query({ active: true, windowId })).then(([tab]) => ({ tab: tab ?? null }));
  const known = isSynced() ? Object.values(cached()?.tabs ?? {}).find((t) => t.windowId === windowId && t.active) ?? null : null;
  if (!known) return (await asking).tab;
  let timer;
  const answer = await Promise.race([asking.catch(() => null), new Promise((resolve) => { timer = setTimeout(() => resolve(null), FRONT_KNOWN_MS); })]).finally(() => clearTimeout(timer));
  return /** @type {{ tab: any } | null} */ (answer)?.tab ?? known;
}
/** @param {number} windowId @param {string} spaceId @param {{ bringTab?: boolean, deadline?: number }} [options] @returns {Promise<{ tab: any } | undefined>} */
export async function showSpace(windowId, spaceId, { bringTab = true, deadline } = {}) {
  if (windowId == null) return;
  const shown = bringTab ? await frontOf(windowId) : null;
  /** @param {import('../../types/margin').State} st */
  const candidatesIn = (st) => Object.values(st.tabs)
    .filter((t) => t.windowId === windowId && st.tabSpace[t.id] === spaceId && t.id !== shown?.id)
    .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
  /** @param {import('../../types/margin').State} st */
  const switching = (st) => bringTab && st.spaces.some((x) => x.id === spaceId) && !(shown && st.tabSpace[shown.id] === spaceId) && candidatesIn(st).length > 0;
  // The write that waits doesn't ask whether this copy still owns the state
  // (store.js flush does, as it writes): asked here (at most once a second),
  // so a copy a newer one replaced fails as stale rather than switching tabs
  // from its own state, out of date.
  if ((await recheckSoon()) !== 'owner') throw new StaleError();
  let before = null;
  const s = await mutate((st) => {
    before = V.activeSpaceId(st, windowId);
    return M.setActiveSpace(st, windowId, spaceId);
  }, { within: (st) => (switching(st) ? SPACE_WRITE_MS : null) });
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
      return await focusTab(tab.id, { source: 'space', deadline });
    } catch (err) {
      // Closed meanwhile: the next one. Anything else (Safari didn't switch,
      // too late) is this switch failing, not a reason to open a start page.
      if (!/No tab with id/i.test(String(err?.message ?? err))) {
        if (!anyFocusing()) await goBack();
        throw err;
      }
    }
  }
  const startPage = api.runtime.getURL('newtab/newtab.html#launcher');
  const untouched = shown && (shown.url === startPage || V.isNewTabPage(shown.url || shown.pendingUrl));
  if (untouched) await mutate((st) => M.moveTab(st, shown.id, spaceId));
  else await openTab({ windowId, url: startPage, spaceId, deadline });
}
