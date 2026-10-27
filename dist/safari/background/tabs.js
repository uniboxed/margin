// Showing, opening and reaching into tabs.
import * as M from '../state/model.js';
import { api, mutate, now } from './store.js';

// When each tab was last shown, and its URL then (restoringTab; a
// diagnostic in tabs.onUpdated).
export const shownAt = new Map(); // tabId → when it was last activated
export const shownUrl = new Map(); // tabId → its URL then

// ---- switching tabs without a black frame -----------------------------------
// When a tab is shown, WebKit keeps the previous frame on screen until the tab
// has painted, but only while the tab's drawn layers are attached. Safari
// suspends a hidden tab's process within seconds, and that detaches them
// (WebProcessProxy::sendPrepareToSuspend → hideContentUntilPendingUpdate),
// so the switch showed black (Safari's empty view) until the tab painted.
// Waking the process reattaches them at once (processDidResume →
// unfreezeAllLayerTrees runs the pending redraw on a 0s timer; seen in
// Safari's log: every black switch went to a suspended process). So before
// Margin shows a tab, a script there keeps its process awake (Safari
// suspends it again as soon as nothing needs it), and after WAKE_MS the
// switch goes ahead. A tab Safari unloaded has no page: the script fails at
// once and the switch doesn't wait (Safari loads the page as it's shown).
const WAKE_MS = 70;

// New tabs being handed back (⌘T, handlers.js newTabPage): gone again in a
// moment, so the tab events leave them out of the state (no "New Tab" row
// flashing in the sidebar).
export const handingOff = new Set();
export async function wakeBeforeShowing(tabId) {
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab || tab.active || !api.scripting?.executeScript || !(await mayAccess(tab.url))) return;
  const noPage = api.scripting.executeScript({ target: { tabId }, func: () => new Promise((resolve) => setTimeout(resolve, 500)) })
    .then(() => new Promise(() => {}), () => true);
  await Promise.race([noPage, new Promise((resolve) => setTimeout(resolve, WAKE_MS))]);
}

// Activate a tab, and focus its window only if it isn't already: re-focusing
// the current window can move keyboard focus out of the page in Safari.
// `wake: false` for a tab that was shown a moment ago (nothing to wake).
export async function focusTab(tabId, { wake = true } = {}) {
  if (wake) await wakeBeforeShowing(tabId);
  const tab = await api.tabs.update(tabId, { active: true });
  if (!tab || !api.windows) return;
  const win = await api.windows.get(tab.windowId).catch(() => null);
  if (!win?.focused) await api.windows.update(tab.windowId, { focused: true });
}

// ---- pages already open when Margin is installed or updated -----------------
// This run of the background: content scripts keep it from their hello, so
// a page running the current copy (it said hello, or started after this run
// did) can be told from one left by an earlier copy (injectIntoOpenTabs).
export const instanceId = globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2);
export const startedAt = Date.now();
// Whether Margin may run scripts on this page (asks, never prompts). Match
// patterns have no port.
export async function mayAccess(url) {
  let pattern;
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    pattern = `${protocol}//${hostname}/*`;
  } catch {
    return false;
  }
  return (await api.permissions?.contains({ origins: [pattern] }).catch(() => false)) ?? false;
}
// Runs `func` in the tab's page (Margin's content-script world). 'asleep'
// when it can't run because there's no page (WebKit: no web view; a tab
// Safari unloaded), 'unknown' when Margin has no access or no answer came
// within `ms` (a busy page), else { result }. Messages to content scripts
// aren't used for this: after Margin is reinstalled or updated, WebKit can
// stop delivering them to pages that were open (their listeners stay with
// the old copy), while executeScript keeps working.
export async function inPage(tabId, url, func, args = [], ms = 300) {
  if (!api.scripting?.executeScript || !(await mayAccess(url))) return 'unknown';
  return Promise.race([
    api.scripting.executeScript({ target: { tabId }, func, args }).then((r) => ({ result: r?.[0]?.result }), () => 'asleep'),
    new Promise((resolve) => setTimeout(() => resolve('unknown'), ms)),
  ]);
}

/** @param {{ windowId?: number, url?: string, spaceId?: string }} options */
export async function openTab({ windowId, url, spaceId }) {
  const tab = await api.tabs.create({ windowId, url, active: true });
  if (spaceId) await mutate((s) => M.moveTab(M.upsertTab(s, tab, now()), tab.id, spaceId));
  return tab;
}

// Tabs opened from a page by openLink, so the next one goes after them.
export const openedFrom = new Map(); // opener tab id → { index, at }

// Pages already open when Margin is installed or updated: WebKit adds the
// content scripts to them itself; where a browser doesn't, this does, once
// it had time to (only where Margin has access: permissions.contains doesn't
// prompt, executeScript could; and only in loaded pages: a sleeping tab gets
// them when it loads). A page that still has the previous copy reloads
// itself (content/core.js).
export async function injectIntoOpenTabs() {
  // The sidebar's entry: the one not in the page's own world (that's
  // content/shell-main.js), whatever the build named its file.
  const files = api.runtime.getManifest().content_scripts?.find((c) => c.world !== 'MAIN')?.js;
  if (!files?.length || !api.scripting?.executeScript) return;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const tabs = await api.tabs.query({}).catch(() => []);
  await Promise.all(tabs.map(async (tab) => {
    if (tab.discarded) return;
    const current = await inPage(tab.id, tab.url, (id, since) => {
      const content = globalThis.Margin?.content;
      return !!content && (content.instanceId === id || content.startedAt >= since);
    }, [instanceId, startedAt], 1000);
    if (typeof current === 'string' || current.result === true) return; // asleep, no access or busy; or already current
    await api.scripting.executeScript({ target: { tabId: tab.id }, files }).catch(() => {});
  }));
}
