// Showing, opening and reaching into tabs.
import * as M from '../state/model.js';
import { api, mutate, now } from './store.js';
import { recordSwitch } from './diagnostics.js';
import { platform } from '../shared/platform.js';

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
// suspends it again as soon as nothing needs it), and a second one answers
// as soon as it has run: the process is running again and its layers are
// back, so the switch goes ahead then (at most WAKE_MAX_MS later: a process
// busy releasing memory took up to a second to come back in Safari's log, and
// the old page stays on screen meanwhile). Waiting a fixed 70ms instead left
// 23 of 100 such switches black (Safari's log, 2026-10-26). A tab Safari
// unloaded has no page: the scripts fail at once and the switch doesn't wait
// (Safari loads the page as it's shown). The wake can start early (a press on
// a sidebar row, the palette resting on a row: handlers.js prewake); the
// switch then picks up the same wake, already under way or done.
const WAKE_MAX_MS = 400;
const WAKE_REUSE_MS = 400; // a wake started this recently still counts
// Long enough for a reused wake, the wait and tabs.update (~110ms in Safari)
// to land while the process is still kept awake.
const KEEP_AWAKE_MS = WAKE_REUSE_MS + WAKE_MAX_MS + 200;

// New tabs being handed back (⌘T, handlers.js newTabPage): gone again in a
// moment, so the tab events leave them out of the state (no "New Tab" row
// flashing in the sidebar).
export const handingOff = new Set();

/** @typedef {{ outcome: 'awake' | 'no page' | 'timeout' | 'shown' | 'gone' | 'no access', ms: number, startedAt: number }} Wake */
/** @type {Map<number, { at: number, done: Promise<Wake> }>} */
const wakes = new Map();
/** @returns {Promise<Wake>} */
export function wakeTab(tabId) {
  const recent = wakes.get(tabId);
  if (recent && Date.now() - recent.at < WAKE_REUSE_MS) return recent.done;
  const at = Date.now();
  const done = startWake(tabId, at);
  wakes.set(tabId, { at, done });
  setTimeout(() => wakes.get(tabId)?.at === at && wakes.delete(tabId), WAKE_REUSE_MS + WAKE_MAX_MS);
  return done;
}
/** @returns {Promise<Wake>} */
async function startWake(tabId, at) {
  const result = (/** @type {Wake['outcome']} */ outcome) => ({ outcome, ms: Date.now() - at, startedAt: at });
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab) return result('gone');
  if (tab.active) return result('shown');
  // Only Safari blanks a suspended tab (Chrome keeps its last frame).
  if (!platform?.wakeTabs || !api.scripting?.executeScript || !(await mayAccess(tab.url))) return result('no access');
  // Right away, not once the page has loaded (Chrome's default; WebKit
  // ignores the key and runs it right away anyway).
  const target = { tabId };
  api.scripting.executeScript({ target, injectImmediately: true, func: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), args: [KEEP_AWAKE_MS] }).catch(() => {});
  const ran = api.scripting.executeScript({ target, injectImmediately: true, func: () => true }).then(() => 'awake', () => 'no page');
  let timer;
  const outcome = await Promise.race([ran, new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), WAKE_MAX_MS); })]);
  clearTimeout(timer);
  return result(/** @type {Wake['outcome']} */ (outcome));
}

// Activate a tab, and focus its window only if it isn't already: re-focusing
// the current window can move keyboard focus out of the page in Safari.
// `wake: false` for a tab that was shown a moment ago (nothing to wake).
// `source`: what asked, for the switch log (background/diagnostics.js).
export async function focusTab(tabId, { wake = true, source = 'other' } = {}) {
  const asked = Date.now();
  const woke = wake ? await wakeTab(tabId) : null;
  const tab = await api.tabs.update(tabId, { active: true }).catch((err) => {
    recordSwitch({ source, tabId, asked, wake: woke, error: String(err) });
    throw err;
  });
  recordSwitch({ source, tabId, asked, wake: woke, shownAfter: Date.now() - asked });
  if (!tab || !api.windows) return;
  const win = await api.windows.get(tab.windowId).catch(() => null);
  if (!win?.focused) await api.windows.update(tab.windowId, { focused: true });
}

// When Margin last opened a tab or window itself (background/newtab-hint.js
// leaves those out).
export let marginOpenedAt = 0;
export function markMarginOpening() {
  marginOpenedAt = Date.now();
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
  markMarginOpening();
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
