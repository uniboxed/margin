// What pages ask the background for: runtime messages { type, ...payload },
// answered { ok, result } or { ok: false, error } (background.js routes
// them). types/margin.d.ts derives the protocol's types from this object.
import { platform } from '../shared/platform.js';
import * as M from '../state/model.js';
import * as V from '../shared/view.js';
import * as S from '../shared/search.js';
import { api, load, mutate, newId, now, thisCopy } from './store.js';
import * as onboarding from './onboarding.js';
import { focusTab, forgetShowing, handingOff, inPage, instanceId, isFocusing, isNeverShown, keepHandedOff, markMarginOpening, openBehind, openTab, openedByMargin, pageBlinked, pageInView, pageStarted, provenWith, resolveTab, tellProven, shownAt, wakeTab } from './tabs.js';
import { clearLog, readLog } from './diagnostics.js';
import { sleepIdle, wakeAll } from './sleep.js';
import { newTabPageSeen } from './newtab-hint.js';
import { ownSearchTabs, ownSearchUrls, OWN_SEARCH_MS } from './search-engine.js';
import * as keepReady from './keep-ready.js';
import * as warmUp from './warm-up.js';
import { iconInflight, iconUrlAllowed, learnIcon, styleUrlAllowed } from './site-icons.js';
import { queueRegistrations, whenRegistered } from './registered.js';
import { navigate, NAV_ACTIONS, showSpace } from './navigation.js';
import { THEMES, themeFor } from '../themes/index.js';
import { activeThemeId, themePackage } from './theme-package.js';
import { isFullscreen, toggleMarginFullscreen } from './fullscreen.js';
import { getScroll, setScroll } from './scroll.js';
import { moveIndex } from '../ui/behaviors/drop-rules.js';
import { MAX_SETTINGS, PACKAGE_THEMES, SETTING_NAME, USER_THEMES_KEY, plainSetting } from '../themes/packages.js';

// After a switch from the sidebar while it was open over the page (hovered,
// toggled, or the rail expanded): the page shown next opens it the same way
// (`why`), so the sidebar doesn't vanish and come back on every switch
// (content/layout.js). A page that isn't listening yet (loading, or Safari
// reloading a tab it had unloaded) gets it with `hello` for a few seconds.
const carried = new Map(); // tab id → { why, until }
function rememberCarry(tabId, why) {
  const reason = why === 'toggle' ? 'toggle' : 'hover';
  carried.set(tabId, { why: reason, until: now() + 10000 });
  return reason;
}
function deliverCarry(tabId, reason) {
  api.tabs.sendMessage(tabId, { type: 'command', command: 'carry-open', why: reason }).then(() => carried.delete(tabId), () => {});
}
function carryOpen(tabId, why) {
  deliverCarry(tabId, rememberCarry(tabId, why));
}
function takeCarried(tabId) {
  const entry = carried.get(tabId);
  carried.delete(tabId);
  return entry && entry.until > now() ? entry.why : null;
}
// The tab a nav request is for: the one named, the page's own, or the one
// in front of the window.
async function frontTab(tabId, windowId, sender) {
  if (Number.isInteger(tabId)) return tabId;
  const win = windowId ?? sender?.tab?.windowId;
  if (win == null) return sender?.tab?.id ?? null;
  const [front] = await api.tabs.query({ active: true, windowId: win }).catch(() => []);
  return front?.id ?? null;
}

// A package theme's settings (themes/packages.js: a built-in one, or one the
// user imported), merged into what's saved: names as theme.json's, plain
// values, at most MAX_SETTINGS. The theme's spec checks each value again
// where it's applied (ui/theme-loader.js resolveSettings).
async function updatePackageThemeSettings(themeId, patch) {
  if (typeof themeId !== 'string' || !patch || typeof patch !== 'object' || Array.isArray(patch)) return;
  if (!PACKAGE_THEMES.includes(themeId)) {
    const index = (await api.storage.local.get(USER_THEMES_KEY).catch(() => ({})))?.[USER_THEMES_KEY];
    if (!Array.isArray(index) || !index.some((e) => e?.id === themeId)) return; // not a theme Margin has
  }
  const clean = Object.fromEntries(Object.entries(patch).filter(([k, v]) => SETTING_NAME.test(k) && plainSetting(v)));
  if (!Object.keys(clean).length) return;
  await mutate((s) => {
    const themes = s.settings.themes ?? {};
    const own = { ...(themes[themeId] && typeof themes[themeId] === 'object' ? themes[themeId] : {}), ...clean };
    if (Object.keys(own).length > MAX_SETTINGS) return s;
    return { ...s, settings: { ...s.settings, themes: { ...themes, [themeId]: own } } };
  });
}

// ⌘T: the browser opened a new tab (extensions can't stop it) with Margin's
// new-tab page. Arc keeps the page and opens its palette over it: so the
// palette opens on the tab the user was on (its sidebar highlights "+ New
// Tab" until it closes; content/palette.js), that tab is shown again, and
// the new one closes. Started as soon as the tab is created when the browser
// says what it shows (background.js onCreated; Chrome does), else when the
// page asks (newTabPage): every moment the new tab is in front shows. In the
// order that shows least of it: out of the sidebar first, the palette ready
// before its page is back, no wake (it was shown a moment ago). False when
// it can't (a new window, a previous tab that isn't a web page or has no
// Margin): the palette then opens on the new-tab page.
const handOffs = new Map(); // tab id → Promise<boolean>, once per tab

// The zoom each site was last seen at, so its pages draw Margin at its size
// before they've asked (content/core.js, shared/dom.js setPageZoom); Safari
// and Chrome keep a site's zoom across its pages. Storage `pageZoom`:
// origin → [zoom, when], only sites zoomed away from the browser's default
// zoom (Chrome's setting; 100% where unknown), which is kept once as '*';
// the ZOOM_CAP most recently changed. Written only when it changes (every
// write redraws Margin's pages); one at a time.
const ZOOM_CAP = 150;
let zoomWrites = Promise.resolve();
// Pages ask for their zoom as they start, on every resize and every time
// they're shown, and it seldom changes: what's stored and each tab's default
// zoom are kept here between asks, so an unchanged zoom costs only the
// browser's answer. Forgotten when the browser says a zoom changed
// (zoomChanged), when `pageZoom` is written (zoomStored), and after
// ZOOM_KEEP_MS (on a clock that only runs forward): copies of Margin don't
// hear each other's writes. Only to tell that nothing changed: a write reads
// storage first.
const ZOOM_KEEP_MS = 60000;
const zoomClock = () => performance.now();
let storedZoom = null; // { pageZoom, at }
let zoomReads = 0; // a read that started before a write is not kept
const tabZoomBase = new Map(); // tab id → { base, at }
async function zoomBase(tabId) {
  const known = tabZoomBase.get(tabId);
  if (known && zoomClock() - known.at < ZOOM_KEEP_MS) return known.base;
  const settings = await api.tabs.getZoomSettings?.(tabId).catch(() => null);
  const base = Number.isFinite(settings?.defaultZoomFactor) && settings.defaultZoomFactor > 0 ? settings.defaultZoomFactor : 1;
  if (tabZoomBase.size > 2 * ZOOM_CAP) tabZoomBase.clear();
  tabZoomBase.set(tabId, { base, at: zoomClock() });
  return base;
}
async function readStoredZoom() {
  if (storedZoom && zoomClock() - storedZoom.at < ZOOM_KEEP_MS) return storedZoom.pageZoom;
  const reads = zoomReads;
  const { pageZoom = {} } = await api.storage.local.get('pageZoom');
  if (reads === zoomReads) storedZoom = { pageZoom, at: zoomClock() };
  return pageZoom;
}
// background.js: tabs.onZoomChange (a tab's zoom changed, or the browser's
// default, which every tab's answer gives) and storage.onChanged with
// `pageZoom` (written here, or cleared).
export const zoomChanged = () => tabZoomBase.clear();
export function zoomStored() {
  zoomReads++;
  storedZoom = null;
}
function rememberZoom(tab, url, zoom) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  if (!Number.isFinite(zoom) || zoom <= 0 || origin === 'null') return;
  zoomWrites = zoomWrites.then(async () => {
    const base = await zoomBase(tab.id);
    const unchanged = (stored) => ((stored[origin] ?? stored['*'])?.[0] ?? 1) === zoom && (stored['*']?.[0] ?? 1) === base;
    if (unchanged(await readStoredZoom())) return;
    // A write is built from what's stored now, not what's kept: another
    // copy's writes reach storage, never this copy's events, and would be lost.
    zoomStored();
    const pageZoom = await readStoredZoom();
    if (unchanged(pageZoom)) return;
    const next = { ...pageZoom };
    if (base === 1) delete next['*'];
    else next['*'] = [base, Date.now()];
    if (zoom === base) delete next[origin];
    else next[origin] = [zoom, Date.now()];
    const sites = Object.keys(next).filter((key) => key !== '*');
    if (sites.length > ZOOM_CAP) {
      sites.sort((a, b) => next[a][1] - next[b][1]);
      for (const old of sites.slice(0, sites.length - ZOOM_CAP)) delete next[old];
    }
    zoomStored(); // whatever its storage event does, the next ask reads it again
    await api.storage.local.set({ pageZoom: next });
  }).catch(() => {});
}
const SHOW_PALETTE_MS = 1000;
// The sidebar coming out over the page wakes the tab used before (prewake's
// 'reveal'), each tab at most once in this long: brought out every few
// seconds to glance at it, it kept that tab's process running at foreground
// priority most of the time (a 2 s hold each), what keep-ready set to 0 is
// meant to spare. One woken that long ago may be suspended again, and its
// switch then waits for it (tabs.js mayWait). Per background run: one
// started again wakes it once more.
const REVEAL_WAKE_EVERY_MS = 10_000;
const revealWokenAt = new Map(); // tab id → when
/** @param {number} tabId */
function revealWakeDue(tabId, now = Date.now()) {
  const last = revealWokenAt.get(tabId);
  if (last != null && now - last < REVEAL_WAKE_EVERY_MS) return false;
  for (const [id, at] of revealWokenAt) if (now - at >= REVEAL_WAKE_EVERY_MS) revealWokenAt.delete(id);
  revealWokenAt.set(tabId, now);
  return true;
}
// When each tab was last loaded again after an update (reloadForUpdate).
const RELOAD_COOLDOWN_MS = 30000;
const reloadedAt = new Map();
// The tab the user was on: the window's active one (Chrome reports the new
// tab before activating it), else the one most recently left. Not by
// lastActive alone: a switch gives both its tabs the same one.
function previousTab(s, tab) {
  return Object.values(s.tabs)
    .filter((t) => t.windowId === tab.windowId && t.id !== tab.id)
    .sort((a, b) => Number(!!b.active) - Number(!!a.active) || (b.lastActive ?? 0) - (a.lastActive ?? 0))[0];
}
export function newTabHandOff(tab) {
  if (!handOffs.has(tab.id)) handOffs.set(tab.id, handOff(tab).finally(() => setTimeout(() => handOffs.delete(tab.id), 30000)));
  return handOffs.get(tab.id);
}
async function handOff(tab) {
  // One line per new tab, so what Safari did (⌘T vs ⌘N, a new window or a
  // tab — macOS can turn ⌘N into a tab) is visible in the background console.
  const log = (decision, why) => console.info(`[margin] new tab ${tab.id} in window ${tab.windowId}: ${decision} (${why})`);
  const prev = previousTab(await load(), tab);
  if (!prev) return log('palette on the new-tab page', 'no other tab in this window: a new window'), false;
  // The Mac app's set-up window: Safari's own New Tab made a tab (its ⌘T, its
  // + button, its File menu). Not a tab Margin opened itself (newTabKey below).
  if (!openedByMargin()) onboarding.reportEvent('safariNewTab');
  if (!/^https?:/.test(prev.url)) return log('palette on the new-tab page', `tab ${prev.id} isn't a web page`), false;
  handingOff.add(tab.id);
  // One message: the page opens its palette if it can, and says so. Not
  // waited on for long: a page Safari stopped delivering to (tabs.js) would
  // otherwise leave this tab untracked and the new-tab page without one.
  const opened = await Promise.race([
    api.tabs.sendMessage(prev.id, { type: 'show-palette' }).then((r) => r === true, () => false),
    new Promise((resolve) => setTimeout(() => resolve(false), SHOW_PALETTE_MS)),
  ]);
  if (!opened) {
    keepHandedOff(tab.id);
    // In case it answers after all, later.
    api.tabs.sendMessage(prev.id, { type: 'hide-palette' }).catch(() => {});
    return log('palette on the new-tab page', `previous tab ${prev.id} has no Margin palette (yet)`), false;
  }
  // Still the untouched new tab in front? The user may have typed an address
  // meanwhile, switched away, or another extension opened it to navigate it
  // (background.js onUpdated then lets it go): it stays, and the palette closes.
  const cur = handingOff.has(tab.id) ? await api.tabs.get(tab.id).catch(() => null) : null;
  if (!cur?.active || !V.isNewTabPage(cur.pendingUrl || cur.url)) {
    keepHandedOff(tab.id);
    api.tabs.sendMessage(prev.id, { type: 'hide-palette' }).catch(() => {});
    return log('kept', 'the new tab was used or left meanwhile'), false;
  }
  log(`palette over tab ${prev.id}, new tab closed`, 'web page in this window: ⌘T (or ⌘N made into a tab by macOS)');
  try {
    await focusTab(prev.id, { wake: false, source: 'new tab hand-off' });
  } catch (err) {
    // The page the user was on couldn't come back: the new tab stays, with
    // its own palette, and is tracked from here.
    keepHandedOff(tab.id);
    api.tabs.sendMessage(prev.id, { type: 'hide-palette' }).catch(() => {});
    return log('kept', `tab ${prev.id} didn't come back: ${err?.message ?? err}`), false;
  }
  await mutate((st) => M.removeTab(st, tab.id)).catch(() => {});
  await api.tabs.remove(tab.id).catch(() => {});
  return true;
}

// Only within the window the switch was made from (another window's page
// stays visible, so its own sidebar stays open there).
async function carryIfSameWindow(tabId, why, windowId) {
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (tab && windowId != null && tab.windowId === windowId) carryOpen(tabId, why);
}

// For a sidebar-driven switch, preserve its open state as part of the hidden
// destination preparation. The remembered copy is also the cold-tab path:
// if Safari has discarded the page, its fresh content script receives it in
// `hello`. An already-running page that could not prepare gets the ordinary
// command after activation.
/**
 * @param {number} tabId
 * @param {{ source?: string, show?: boolean | 'hover' | 'toggle', sourceWindowId?: number, sidebarTop?: number, deadline?: number, waitsUntil?: number, arrival?: import('./tabs.js').Arrival | null, tab?: any }} [options] `tab`: as found already (its window)
 */
async function focusWithSidebar(tabId, { source = 'other', show, sourceWindowId, sidebarTop, deadline, waitsUntil, arrival = null, tab = null } = {}) {
  const target = tab ?? (await load()).tabs[tabId] ?? (await api.tabs.get(tabId).catch(() => null));
  const reason = show && sourceWindowId != null && target?.windowId === sourceWindowId ? rememberCarry(tabId, show) : null;
  // Preparation receives the value directly; persistence can finish beside
  // the switch instead of adding a storage.session round trip in front of it.
  if (Number.isFinite(sidebarTop) && sourceWindowId != null) void setScroll(sourceWindowId, sidebarTop);
  try {
    // A page's own switch: it's covered meanwhile (content/core.js), so a tab
    // never shown before arrives covered too.
    const result = await focusTab(tabId, { source, carry: reason, scroll: Number.isFinite(sidebarTop) ? sidebarTop : null, deadline, waitsUntil, covered: isNeverShown(tabId), arrival });
    if (!reason) return result;
    if (!result?.tab) carried.delete(tabId);
    else if (result.preparation?.outcome === 'ready') carried.delete(tabId);
    else deliverCarry(tabId, reason);
    return result;
  } catch (error) {
    if (reason) carried.delete(tabId);
    throw error;
  }
}

// ⌘T as Margin's own shortcut (Safari's manifest `new-tab`, with Safari's
// File › New Tab moved to another shortcut, DECISIONS.md): Safari matches it
// in the app, wherever the focus is. The page in front opens its palette to
// choose a new tab (no tab created: no flicker); Margin's new-tab page does
// what its "+ New Tab" does; anything else (Safari's own pages, PDFs, sites
// Margin can't reach) gets a new tab with Margin's new-tab page, as Safari's
// ⌘T did (its palette opens there).
export async function newTabKey(tabArg) {
  onboarding.reportEvent('cmdTKey');
  const windowId = tabArg?.windowId ?? (await api.windows?.getLastFocused())?.id;
  const [tab] = await api.tabs.query({ active: true, ...(windowId != null ? { windowId } : { currentWindow: true }) });
  if (!tab) return;
  if (V.isNewTabPage(tab.url || tab.pendingUrl)) {
    return api.runtime.sendMessage({ type: 'command', command: 'new-tab', tabId: tab.id }).catch(() => {});
  }
  const opened = await Promise.race([
    api.tabs.sendMessage(tab.id, { type: 'show-palette' }).then((r) => r === true, () => false),
    new Promise((resolve) => setTimeout(() => resolve(false), SHOW_PALETTE_MS)),
  ]);
  if (!opened) {
    markMarginOpening();
    await api.tabs.create({ windowId: tab.windowId, url: api.runtime.getURL('newtab/newtab.html') });
  }
}

// What a space's switch waits, at most, to carry the sidebar open to the tab
// it brought, before it answers (setSpace).
const CARRY_WAIT_MS = 250;
// ...and never past this long before the page's deadline: focusTab answers
// by 0.8 s before it at the latest (background/tabs.js ANSWER_BY_MS), and
// background.js answers that the switch didn't happen 0.5 s before it, so a
// carry wait after a late answer would leave a background running late (its
// timers fire late on a loaded Mac) no time to send the real one first.
const CARRY_ENDS_MS = 800;

// Style sheets fetched for pages (fetchStyle), the latest few.
const styleCache = new Map();
const STYLE_CACHE_SIZE = 50;
const STYLE_CACHE_CHARS = 8_000_000; // and no more than this in all
const STYLE_CACHED_MAX_CHARS = 1_000_000; // a larger one is fetched each time
const STYLE_MAX_CHARS = 8_000_000;


// A promise's value if it has settled by the end of this turn's own tasks (a
// timer of 0: its storage read from memory has answered), else false, and
// `later` gets it once it settles.
/** @param {Promise<boolean>} promise @param {() => boolean | null} now @param {(value: boolean) => void} later */
async function known(promise, now, later) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const value = now();
  if (value != null) return value;
  void promise.then(later, () => {});
  return false;
}

export const handlers = {
  /** @param {{ unseen?: boolean, heard?: number, doc?: string, fresh?: boolean, made?: boolean }} message `unseen`: the page started visible in a tab whose page may have just been made; `doc`: the page's own id; `fresh`: its copy started with it; `made`: it was made from the tab's saved history, or is a tab's first page (background/tabs.js pageStarted); `heard`: its place among the activations as it came (background.js) */
  async hello({ unseen = false, heard = null, doc = null, fresh = false, made = false } = {}, sender) {
    onboarding.pageLoaded();
    const started = pageStarted(sender.tab?.id, { unseen, heard, doc: typeof doc === 'string' ? doc : null, fresh: fresh === true, made: made === true, active: typeof sender.tab?.active === 'boolean' ? sender.tab.active : null });
    // `proven`: its tab is proven to have WebKit's mark with this page in it
    // (a link in a tab Margin had proven): the page keeps that in its world,
    // where a later copy of Margin reads it (background/tabs.js pageThere).
    // Not waited for (review of 2026-11-04: it held every hello up to 200 ms
    // on a background just started, its storage slow): said in the answer if
    // known by then, else written into the page's world once it is (tellProven).
    const pageDoc = typeof doc === 'string' ? doc : null;
    const proven = started.then(() => provenWith(sender.tab?.id, pageDoc), () => false);
    /** @type {boolean | null} */
    let provenNow = null;
    void proven.then((p) => { provenNow = p; });
    const windowId = sender.tab?.windowId ?? null;
    const fullscreen = windowId != null && platform?.marginFullscreen ? await isFullscreen(windowId) : false;
    // Only to a page in front: one loading behind (background/tabs.js
    // restoreTab) gets it with its preparation, if its switch goes ahead.
    const carry = sender.tab?.id != null && sender.tab.active !== false ? takeCarried(sender.tab.id) : null;
    if (sender.tab?.id != null) forgetShowing(sender.tab.id, { later: true });
    // `since`: with the page's own address, which copy's tab ids it may trust (shared/stored.js).
    // `warmUp`: the warm-up after a relaunch under way, for its note in the sidebar (background/warm-up.js).
    return { tabId: sender.tab?.id ?? null, windowId, instanceId, fullscreen, carry, since: thisCopy().since, warmUp: warmUp.noteFor(sender.tab), proven: await known(proven, () => provenNow, (p) => p && sender.tab?.id != null && pageDoc && tellProven(sender.tab.id, pageDoc)) };
  },
  // Whether this copy owns the state: only an owner answers this (the others
  // say `stale`, background.js), after checking the stored owner again.
  async owner() {
    return true;
  },
  // Answers which tab came to the front ({ shown }), or fails: the tab is
  // gone, or the browser didn't show it (the page then says so).
  /** @param {{ tabId: number, hint?: { url?: string, index?: number, title?: string }, show?: boolean | 'hover' | 'toggle', sidebarTop?: number, deadline?: number, waitsUntil?: number, resolved?: any, arrival?: import('./tabs.js').Arrival | null }} message `show`: keep the sidebar open there; `hint`: the row's tab address and place (background/tabs.js resolveTab); `deadline`: when the page stops waiting (no switch after it), `waitsUntil` past it for the answer (a switch asked too late for its steps is shown at once); `resolved`: the tab background.js found by that address already (not asked for again); `arrival`: how the request came (the switch log: background.js) */
  async activateTab({ tabId, hint, show, sidebarTop, deadline, waitsUntil, resolved = null, arrival = null }, sender) {
    const target = resolved ?? (await resolveTab(tabId, hint, sender.tab?.windowId, { deadline }));
    if (!target) throw new Error('That tab is no longer open');
    const result = await focusWithSidebar(target.id, { source: 'activateTab', show, sourceWindowId: sender.tab?.windowId, sidebarTop, deadline, waitsUntil, arrival, tab: target });
    return { shown: result?.superseded ? null : target.id };
  },
  // About to be shown, probably (a press on a sidebar row or a space's icon,
  // the pointer or the palette resting on a row, the sidebar coming out, a
  // swipe toward a space): its process is woken now, once, so the switch that
  // follows doesn't wait for it (background/tabs.js wakeTab). A pin wakes its
  // open tab. Not a tab keep-ready holds (its process runs). An earlier copy's
  // sidebar renews a row's hold every 1.5 s while the pointer rests on it
  // (`holdOnly`): nothing is renewed in a loop any more, so that does nothing.
  /** @param {{ tabId?: number, pinId?: string, windowId?: number, hover?: boolean, holdOnly?: boolean, why?: string }} message `hover`: the sidebar's longer hold (a pointer resting, the sidebar coming out, a space); `why`: what asked (the switch log: 'hover', 'press', 'reveal', 'space'; a press by default) */
  async prewake({ tabId, pinId, windowId, hover = false, holdOnly = false, why }) {
    if (holdOnly || !platform?.wakeTabs) return; // (pages don't ask where tabs aren't woken: platform.js asksBackground)
    const id = tabId ?? (pinId ? V.pinTabId(await load(), pinId, windowId) : null);
    if (!Number.isInteger(id) || keepReady.isHeld(id)) return;
    const by = why === 'hover' || why === 'reveal' || why === 'space' ? why : hover ? 'hover' : 'press';
    if (by === 'reveal' && !revealWakeDue(id)) return;
    void wakeTab(id, { hover, by });
  },
  // Settings' "Wake all sleeping tabs" (background/sleep.js): how many it woke.
  async wakeSleeping() {
    return wakeAll();
  },
  // A pass of sleeping tabs now (background/sleep.js), for tabs unused for
  // `afterMs` (the setting's hours if left out): for checks by hand and the
  // WebKit host. What it did.
  /** @param {{ afterMs?: number, max?: number }} message */
  async sleepNow({ afterMs, max } = {}) {
    return sleepIdle({ ...(Number.isFinite(afterMs) && afterMs >= 0 ? { afterMs } : {}), ...(Number.isInteger(max) && max > 0 ? { max } : {}) });
  },
  // DEVELOPMENT DIAGNOSTICS (background/diagnostics.js): the log itself, for the
  // start page's "Switch log" button.
  /** @param {{ clear?: boolean }} message */
  async switchLog({ clear } = {}) {
    if (clear) return void (await clearLog());
    return readLog();
  },
  // The sidebar's scroll position in this page's window (background/scroll.js).
  /** @param {{ windowId?: number }} message */
  async sidebarScroll({ windowId }, sender) {
    const id = windowId ?? sender.tab?.windowId;
    return id == null ? 0 : getScroll(id);
  },
  /** @param {{ top: number, windowId?: number }} message */
  async setSidebarScroll({ top, windowId }, sender) {
    const id = windowId ?? sender.tab?.windowId;
    if (id != null && Number.isFinite(top)) await setScroll(id, top);
  },
  // A page that still had the previous copy of Margin (content/core.js
  // reloadWhenSafe): its URL loaded again once the content scripts a page
  // load needs are registered. A GET (a reload would send a form again), from
  // the browser's side (an old copy's fitted layout would cancel a page's own
  // navigation to its URL); a URL with a #fragment, where loading it
  // again would only scroll: the browser's reload. Answers { reloaded }, and
  // when it didn't, whether the page may ask again later (`retry`: it was
  // being shown or switched to, or its address changed) or never will.
  /** @returns {Promise<{ reloaded: boolean, retry?: boolean }>} */
  async reloadForUpdate(_, sender) {
    const { id, url } = sender.tab ?? {};
    if (id == null || !/^https?:/i.test(url ?? '')) return { reloaded: false, retry: false };
    // At most once in RELOAD_COOLDOWN_MS per tab, whatever the page asks
    // (counted from now: a second request meanwhile waits too).
    if (Date.now() - (reloadedAt.get(id) ?? 0) < RELOAD_COOLDOWN_MS) return { reloaded: false, retry: true };
    reloadedAt.set(id, Date.now());
    const notNow = () => {
      reloadedAt.delete(id);
      return { reloaded: false, retry: true };
    };
    await whenRegistered();
    // Let an activation message already in WebKit's queue claim the tab
    // before cleanup commits its navigation.
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The page asked while it was hidden, but registrations (and a cold
    // background) can take long enough that the user selects it meanwhile.
    // Never turn that first switch after an update into a visible reload. The
    // tab in front of a window that isn't (minimized, or Safari hidden) can't
    // be seen: that one may.
    const current = await api.tabs.get(id).catch(() => null);
    if (!current) return { reloaded: false, retry: false };
    if (current.url !== url || isFocusing(id)) return notNow();
    if (current.active) {
      // In front: only of a window that isn't focused, and only if the page
      // says it's hidden right now (the window could be on screen).
      if ((await api.windows?.get(current.windowId).catch(() => null))?.focused !== false) return notNow();
      const visibility = await inPage(id, url, () => document.visibilityState, [], 300);
      if (typeof visibility === 'string' || visibility.result !== 'hidden') return notNow();
    }
    try {
      if (url.includes('#')) await api.tabs.reload(id);
      else await api.tabs.update(id, { url });
    } catch {
      return notNow();
    }
    return { reloaded: true };
  },
  // Closing from Margin archives the tab, like Arc.
  /** @param {{ tabId: number }} message */
  /** @param {{ tabId: number, show?: boolean | 'hover' | 'toggle', sidebarTop?: number }} message `show`: closing the shown tab from an open sidebar keeps it open on the next one */
  async closeTab({ tabId, show, sidebarTop }) {
    await mutate((s) => {
      const tab = s.tabs[tabId];
      return tab && /^https?:/i.test(tab.url) ? M.archiveTab(s, M.archiveEntryForTab(s, tab, { id: newId(), closedAt: now() })) : s;
    });
    const closing = await api.tabs.get(tabId).catch(() => null);
    // The tab in front: the space's most recent other tab comes to the front
    // first (Arc stays in the space; the browser would pick a neighbour,
    // maybe of another space).
    let selected = null;
    if (closing?.active) {
      const s = await load();
      const stay = M.recentTabOfSpace(s, closing.windowId, s.tabSpace[tabId], tabId);
      if (stay) {
        const result = await focusWithSidebar(stay.id, { source: 'closeTab', show, sourceWindowId: closing.windowId, sidebarTop }).catch(() => null);
        if (result?.tab) selected = stay.id;
      }
    }
    await api.tabs.remove(tabId);
    if (show && closing?.active) {
      const [next] = await api.tabs.query({ active: true, windowId: closing.windowId }).catch(() => []);
      // If Margin could not select the space's own next tab above, Safari
      // selected one while removing the old tab. That browser-chosen path
      // cannot be prepared, so retain the established post-switch fallback.
      if (next?.id != null && next.id !== selected) carryOpen(next.id, show);
    }
  },
  /** @param {{ archiveId: string, windowId?: number, replaceTabId?: number }} message */
  async restoreArchive({ archiveId, windowId, replaceTabId }) {
    const s = await load();
    const entry = s.archive.find((a) => a.id === archiveId);
    if (!entry) return;
    const spaceId = s.spaces.some((sp) => sp.id === entry.spaceId) ? entry.spaceId : s.spaces[0].id;
    if (replaceTabId != null) {
      const tab = await api.tabs.update(replaceTabId, { url: entry.url });
      await mutate((st) => M.setActiveSpace(M.moveTab(M.removeArchived(st, archiveId), replaceTabId, spaceId), tab.windowId, spaceId));
    } else {
      const tab = await openTab({ windowId, url: entry.url, spaceId });
      await mutate((st) => M.setActiveSpace(M.removeArchived(st, archiveId), tab.windowId, spaceId));
    }
  },
  // Page zoom (the browser's own, like ⌘+): for Margin's pinch, and so
  // Margin's UI keeps its size on a zoomed page; remembered per site.
  // ⌘T reached Margin on a page (content/palette.js installNewTabKey).
  // The page in front lost focus while in sight (Safari left for another
  // app; `at`: when), and got it back: the tabs kept ready are let go a
  // moment later, unless Safari is back first (shared/away.js,
  // background/keep-ready.js noteAway: not if Safari was seen in use since).
  /** @param {{ at?: number }} request @param {any} sender */
  async away({ at } = {}, sender) {
    keepReady.noteAway({ at: Number.isFinite(at) ? at : null, tabId: sender?.tab?.id ?? null, windowId: sender?.tab?.windowId ?? null });
  },
  async back(_request, sender) {
    keepReady.noteFocused(sender?.tab?.windowId ?? null);
  },
  // The page has come into view from hidden (content/core.js): with what's
  // known of its tab, proof WebKit has seen it come into a window with its
  // page running (background/tabs.js pageInView). Answered true once its tab
  // is proven with this page in it (the page then stops saying so).
  /** @param {{ doc?: string, heard?: number } | undefined} request @param {any} sender */
  async inView({ doc = null, heard = null } = {}, sender) {
    return pageInView(sender?.tab?.id, { doc: typeof doc === 'string' ? doc : null, heard: Number.isFinite(heard) ? heard : null });
  },
  // The page in front, asked whether the user is idle for the warm-up after
  // a relaunch, says they did something since (content/idle.js): the warm-up
  // gives way (background/warm-up.js).
  /** @param {{ at?: number }} [request] */
  async warmUpInput({ at } = {}) {
    warmUp.userActed(Number.isFinite(at) ? at : Date.now());
  },
  // The warm-up's note in the sidebar: its × (themes/arcadia/sidebar.js),
  // answered once the stop is kept.
  async warmUpStop() {
    await warmUp.stopByUser();
  },
  // The page in front was hidden for an instant (shared/switching.js
  // onBlink): tabs.js pageBlinked takes it only from the page in front of a
  // flip in its window, during the flip.
  async pageBlinked({ hiddenAt, shownAt }, sender) {
    pageBlinked(sender.tab?.windowId, { hiddenAt, shownAt }, sender.tab?.id ?? null);
  },
  async newTabKeyUsed() {
    onboarding.reportEvent('cmdTKey');
  },
  async getZoom(_, sender) {
    if (!sender.tab) return null;
    const zoom = await api.tabs.getZoom(sender.tab.id);
    rememberZoom(sender.tab, sender.url ?? sender.tab.url, zoom);
    return zoom;
  },
  // Search with the browser's engine: in `tabId`, else in a new tab (from a
  // page: behind it until the results have loaded, tabs.js openBehind).
  /** @param {{ query: string, windowId?: number, tabId?: number, deadline?: number }} message */
  async search({ query, windowId, tabId, deadline }, sender) {
    const text = String(query ?? '').trim();
    if (!text) return;
    const from = sender?.tab?.id != null ? sender.tab : null;
    if (platform?.search === 'browser' && api.search?.query) {
      if (tabId != null) return void (await api.search.query({ text, tabId }));
      if (from) return openBehind({ windowId, from, deadline, label: text, then: (tab) => api.search.query({ text, tabId: tab.id }) });
      return void (await api.search.query({ text, disposition: 'NEW_TAB' }));
    }
    const { settings } = await load();
    const url = S.searchUrl(text, settings);
    const own = { at: now(), template: S.safariEngine(settings).template };
    for (const map of [ownSearchTabs, ownSearchUrls]) for (const [key, entry] of map) if (now() - entry.at > OWN_SEARCH_MS) map.delete(key);
    if (tabId != null) {
      ownSearchTabs.set(tabId, own);
      return void (await api.tabs.update(tabId, { url }));
    }
    // From a page: opened at the search's address (its row says so from the
    // start), known as Margin's own by that address until it has an id.
    if (from) {
      ownSearchUrls.set(url, own);
      return openBehind({ windowId, url, from, deadline, created: (tab) => ownSearchTabs.set(tab.id, own) });
    }
    // Else marked before it navigates: created blank, then the search loads.
    const tab = await openTab({ windowId, url: 'about:blank', deadline });
    ownSearchTabs.set(tab.id, own);
    await api.tabs.update(tab.id, { url });
  },
  // An address from a page (the palette): behind it until loaded (tabs.js
  // openBehind). Margin's new-tab page, or a space's start page, at once.
  /** @param {{ windowId?: number, url?: string, spaceId?: string, deadline?: number }} message */
  async newTab({ windowId, url, spaceId, deadline }, sender) {
    if (url && !spaceId && sender?.tab?.id != null) return openBehind({ windowId, url, from: sender.tab, deadline });
    const tab = await openTab({ windowId, url, spaceId, deadline });
    return { tabId: tab.id };
  },
  // `folderId`/`beforeId`: where the pin goes (a folder of the tab's space,
  // before a pin or folder there; dragged in the sidebar); the end of the
  // pinned area by default. Returns the new pin's id.
  /** @param {{ tabId: number, folderId?: string | null, beforeId?: string | null }} message */
  async pinTab({ tabId, folderId = null, beforeId = null }) {
    const s = await load();
    const tab = s.tabs[tabId] ?? (await api.tabs.get(tabId).catch(() => null));
    if (!tab?.url) return console.warn('[margin] pin: unknown tab', tabId);
    let result = 'pinned';
    const id = newId();
    await mutate((st) => {
      // A tab Margin hasn't placed in a space yet goes to its window's space.
      const spaceId = st.tabSpace[tabId] ?? V.activeSpaceId(st, tab.windowId);
      const next = M.addPin(st, { id, spaceId, url: tab.url, title: tab.title, folderId, beforeId });
      if (next === st) result = 'not pinned (already pinned in that space, or no space)';
      return next;
    });
    console.info(`[margin] pin tab ${tabId}: ${result}`);
    return result === 'pinned' ? id : null;
  },
  // ---- folders of pins (state/model.js) ----
  // A folder in this window's space (or `spaceId`), holding the pins
  // `pinIds`, or the tab `tabId` pinned into it; at the top level before
  // `beforeId` (else in the place of the first pin it takes, else the end).
  // Returns its id.
  /** @param {{ windowId?: number, spaceId?: string, name?: string, pinIds?: string[], tabId?: number, beforeId?: string | null }} message */
  async createFolder({ windowId, spaceId, name, pinIds = [], tabId, beforeId = null }, sender) {
    const id = newId();
    const pinFromTab = Number.isInteger(tabId) ? newId() : null;
    const tab = pinFromTab ? ((await load()).tabs[tabId] ?? (await api.tabs.get(tabId).catch(() => null))) : null;
    await mutate((st) => {
      const space = spaceId ?? (tab ? st.tabSpace[tab.id] : null) ?? V.activeSpaceId(st, windowId ?? sender?.tab?.windowId);
      const firstPin = st.pins.find((p) => p.id === pinIds[0] && p.spaceId === space);
      // In the place of the first pin it takes, if that's at the top level.
      const before = beforeId ?? (firstPin && !firstPin.folderId ? firstPin.id : null);
      let next = M.createFolder(st, { id, spaceId: space, name, pinIds, beforeId: before });
      if (tab?.url) next = M.addPin(next, { id: pinFromTab, spaceId: space, url: tab.url, title: tab.title, folderId: id });
      return next;
    });
    return id;
  },
  /** @param {{ folderId: string, name: string }} message */
  async renameFolder({ folderId, name }) {
    await mutate((s) => M.renameFolder(s, folderId, name));
  },
  /** @param {{ folderId: string, open: boolean }} message */
  async setFolderOpen({ folderId, open }) {
    await mutate((s) => M.setFolderOpen(s, folderId, open));
  },
  /** @param {{ folderId: string }} message the folder goes; its pins stay */
  async deleteFolder({ folderId }) {
    await mutate((s) => M.deleteFolder(s, folderId));
  },
  /** @param {{ pinId: string, folderId?: string | null, beforeId?: string | null }} message */
  async movePin({ pinId, folderId = null, beforeId = null }) {
    await mutate((s) => M.movePin(s, pinId, { folderId, beforeId }));
  },
  /** @param {{ folderId: string, beforeId?: string | null }} message */
  async moveFolder({ folderId, beforeId = null }) {
    await mutate((s) => M.moveFolder(s, folderId, { beforeId }));
  },
  // A tab dragged in the sidebar's list, next to another (`side`: above it,
  // 'before', or below, 'after', as the list shows them: newest at the top,
  // the reverse of the window's order). Safari's own tab order follows, and
  // the sidebar with it (background.js tabs.onMoved).
  // Whether it moved (not: the browser can't, a tab is gone, or one is the
  // browser's own pinned tab, kept apart from the others).
  /** @param {{ tabId: number, hint?: any, nextTo: number, nextToHint?: any, side: 'before' | 'after' }} message */
  async moveTab({ tabId, hint, nextTo, nextToHint, side }, sender) {
    if (!api.tabs.move) return false;
    const [tab, other] = await Promise.all([resolveTab(tabId, hint, sender?.tab?.windowId), resolveTab(nextTo, nextToHint, sender?.tab?.windowId)]);
    if (!tab || !other || tab.windowId !== other.windowId || tab.id === other.id || !!tab.pinned !== !!other.pinned) return false;
    // Above it in the list: just after it in the window; below it: just before.
    const index = moveIndex(tab.index, other.index, side);
    if (index === tab.index) return false;
    return api.tabs.move(tab.id, { index }).then(() => true, () => false);
  },
  // "Clear" (the canvas designs' Today): the window's space's tabs that
  // aren't pinned close, as the sidebar lists them (shared/view.js sidebar),
  // archived as closing one does. The tab in front among them: the space's
  // most recent tab left (an open pin) comes to the front first, else its
  // start page opens, so the window stays in the space and isn't left empty.
  // Returns the tabs closed.
  /** @param {{ windowId?: number }} message */
  async clearToday({ windowId }, sender) {
    const win = windowId ?? sender?.tab?.windowId;
    if (win == null) return [];
    const s = await load();
    const spaceId = V.activeSpaceId(s, win);
    const ids = V.sidebar(s, win).tabs.map((t) => t.id);
    if (!ids.length) return [];
    const closing = new Set(ids);
    await mutate((st) => {
      let next = st;
      for (const id of ids) {
        const tab = next.tabs[id];
        if (tab && /^https?:/i.test(tab.url)) next = M.archiveTab(next, M.archiveEntryForTab(next, tab, { id: newId(), closedAt: now() }));
      }
      return next;
    });
    const [front] = await api.tabs.query({ active: true, windowId: win }).catch(() => []);
    if (front && closing.has(front.id)) {
      const stay = Object.values(s.tabs).filter((t) => t.windowId === win && !closing.has(t.id) && s.tabSpace[t.id] === spaceId)
        .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))[0];
      if (stay) await focusTab(stay.id, { source: 'clearToday' }).catch(() => null);
      else await openTab({ windowId: win, url: api.runtime.getURL('newtab/newtab.html#launcher'), spaceId }).catch(() => null);
    }
    await api.tabs.remove(ids).catch(() => Promise.all(ids.map((id) => api.tabs.remove(id).catch(() => {}))));
    return ids;
  },
  // Back, forward and reload for the tab in front of a window (or `tabId`):
  // the runtime's nav.* actions when its host can't do them itself (Margin.app).
  /** @param {{ windowId?: number, tabId?: number }} message */
  async goBack({ windowId, tabId }, sender) {
    const id = await frontTab(tabId, windowId, sender);
    if (id == null || !api.tabs.goBack) return false;
    return api.tabs.goBack(id).then(() => true, () => false);
  },
  /** @param {{ windowId?: number, tabId?: number }} message */
  async goForward({ windowId, tabId }, sender) {
    const id = await frontTab(tabId, windowId, sender);
    if (id == null || !api.tabs.goForward) return false;
    return api.tabs.goForward(id).then(() => true, () => false);
  },
  /** @param {{ windowId?: number, tabId?: number }} message */
  async reload({ windowId, tabId }, sender) {
    const id = await frontTab(tabId, windowId, sender);
    if (id == null) return false;
    return api.tabs.reload(id).then(() => true, () => false);
  },
  /** @param {{ pinId: string }} message */
  async unpin({ pinId }) {
    await mutate((s) => M.removePin(s, pinId));
  },
  /** @param {{ pinId: string, windowId?: number, show?: boolean | 'hover' | 'toggle', sidebarTop?: number, deadline?: number, waitsUntil?: number }} message `show`: keep the sidebar open there; `deadline`: as activateTab's */
  async openPin({ pinId, windowId, show, sidebarTop, deadline, waitsUntil }) {
    const s = await load();
    const pin = s.pins.find((p) => p.id === pinId);
    if (!pin) return;
    // Only a tab of the pin's space (as the sidebar shows it): one elsewhere
    // would switch the window to that space.
    const key = M.normalizeUrl(pin.url);
    const matches = Object.values(s.tabs).filter((t) => M.normalizeUrl(t.url) === key && s.tabSpace[t.id] === pin.spaceId);
    const existing = matches.find((t) => t.windowId === windowId) ?? matches[0];
    if (existing) {
      const result = await focusWithSidebar(existing.id, { source: 'openPin', show, sourceWindowId: windowId, sidebarTop, deadline, waitsUntil });
      return { shown: result?.superseded ? null : existing.id };
    }
    const tab = await openTab({ windowId, url: pin.url, spaceId: pin.spaceId, deadline });
    return { shown: tab.id };
  },
  /** @param {{ windowId: number, spaceId: string }} message */
  // `bringTab: false`: only the sidebar's space, the page in front stays.
  /** @param {{ windowId?: number, spaceId: string, bringTab?: boolean }} message */
  /** @param {{ windowId?: number, spaceId: string, bringTab?: boolean, show?: boolean | 'hover' | 'toggle', sidebarTop?: number, deadline?: number, waitsUntil?: number }} message `show`: keep the sidebar open on the tab that comes to the front */
  async setSpace({ windowId, spaceId, bringTab = true, show, sidebarTop, deadline, waitsUntil }, sender) {
    const win = windowId ?? sender?.tab?.windowId;
    if (Number.isFinite(sidebarTop) && win != null) void setScroll(win, sidebarTop);
    const reason = show && win != null && win === sender?.tab?.windowId ? (show === 'toggle' ? 'toggle' : 'hover') : null;
    const result = await showSpace(win, spaceId, { bringTab, carry: reason, scroll: sidebarTop, deadline, waitsUntil });
    // Which tab is in front now (the page that swiped shows it switching).
    const done = { shown: result?.tab?.id ?? null };
    if (!show || win == null) return done;
    if (result?.preparation?.outcome === 'ready') return done;
    // Before the answer, as a rule (the page shown says hello soon after),
    // but not past CARRY_WAIT_MS: Safari slow to answer doesn't hold the
    // page's answer (it waits for it until its deadline).
    const carrying = api.tabs.query({ active: true, windowId: win }).then(([front]) => {
      if (front && front.id !== sender?.tab?.id) return carryIfSameWindow(front.id, show, sender?.tab?.windowId);
    }).catch(() => {});
    let timer;
    const carryMs = Math.max(0, Math.min(CARRY_WAIT_MS, (Number.isFinite(deadline) ? /** @type {number} */ (deadline) - CARRY_ENDS_MS : Infinity) - Date.now()));
    await Promise.race([carrying, new Promise((resolve) => { timer = setTimeout(resolve, carryMs); })]);
    clearTimeout(timer);
    return done;
  },
  /** @param {{ windowId?: number, name?: string, emoji?: string, color?: string }} message */
  async createSpace({ windowId, name, emoji, color }) {
    const id = newId();
    await mutate((s) => {
      const next = M.createSpace(s, { id, name, emoji, color });
      return windowId == null ? next : M.setActiveSpace(next, windowId, id);
    });
    return { spaceId: id };
  },
  /** @param {{ spaceId: string, name?: string, emoji?: string, color?: string }} message */
  async renameSpace({ spaceId, name, emoji, color }) {
    await mutate((s) => M.updateSpace(s, spaceId, { name, emoji, color }));
  },
  /** @param {{ spaceId: string }} message */
  async deleteSpace({ spaceId }) {
    await mutate((s) => M.deleteSpace(s, spaceId));
  },
  /** @param {{ tabId: number, spaceId: string }} message */
  async moveTabToSpace({ tabId, spaceId }) {
    await mutate((s) => M.moveTab(s, tabId, spaceId));
  },
  /** @param {{ href: string }} message */
  async pageIcon({ href }, sender) {
    if (!platform?.fetchFavicons) return; // the browser provides icons
    const pageUrl = sender.tab?.url ?? sender.url;
    let origin;
    try {
      origin = new URL(pageUrl).origin;
    } catch {
      return;
    }
    if (!/^https?:/.test(origin) || typeof href !== 'string' || !iconUrlAllowed(href, pageUrl)) return;
    if (!iconInflight.has(origin)) {
      iconInflight.set(origin, learnIcon(origin, href).finally(() => iconInflight.delete(origin)));
    }
    await iconInflight.get(origin);
  },
  // A fresh new-tab page (⌘T, ⌘N, or Safari opening one) asks what to do.
  // ⌘T in a window with a web page: go back to the tab the user was on,
  // close the new tab and open the command palette there (Arc-style, no
  // empty page). Otherwise (⌘N's first tab, or a previous tab without
  // Margin's content script) the new-tab page opens its own palette.
  // The launcher on purpose (#launcher: it doesn't hand off to the palette).
  /** @param {{ windowId?: number }} message */
  async openLauncher({ windowId }) {
    await openTab({ windowId, url: api.runtime.getURL('newtab/newtab.html#launcher') });
  },
  // A real new window (the palette's "New window"): its new-tab page opens
  // the palette, and the window inherits the space (model.inheritSpace).
  async newWindow() {
    markMarginOpening();
    await api.windows?.create({ focused: true });
  },
  // ⌘T: Margin's new-tab page asks (newTabHandOff below), unless the
  // background already handed the tab off as it was created.
  async newTabPage(_, sender) {
    void newTabPageSeen(sender.tab);
    if (!sender.tab) return { openPalette: true };
    return (await newTabHandOff(sender.tab)) ? { handled: true } : { openPalette: true };
  },
  // Escape in the palette of a fresh new tab (⌘T; themes/arcadia/newtab.js):
  // back to the tab the user was on, and this one closes, as if no tab had
  // been opened. The window's only tab (⌘N) stays, with the start page.
  async cancelNewTab(_, sender) {
    const tab = sender.tab;
    if (!tab) return;
    const prev = previousTab(await load(), tab);
    if (!prev) return;
    await focusTab(prev.id, { source: 'cancelNewTab' });
    await api.tabs.remove(tab.id).catch(() => {});
  },
  // Answered as soon as the press is queued, not once its switch is over: a
  // page's listener that hears nothing back (a page cut off from Margin, its
  // messages going nowhere) stands aside for the keys, and must not take a
  // long switch for that (shared/shortcuts.js). True: taken.
  /** @param {{ action: string }} message */
  async navigate({ action }, sender) {
    if (!NAV_ACTIONS.has(action)) return false;
    const windowId = sender.tab?.windowId ?? (await api.windows?.getLastFocused())?.id;
    void navigate(action, 'page', windowId);
    return true;
  },
  /** @param {{ patch: Record<string, any> }} message */
  async updateSettings({ patch }) {
    if ('theme' in patch && !THEMES[patch.theme]) return; // not a theme Margin has
    await mutate((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
  },
  // "Margin full screen" on or off for this window (Chrome; background/fullscreen.js).
  /** @param {{ windowId?: number }} message */
  async toggleFullscreen({ windowId }, sender) {
    const id = windowId ?? sender.tab?.windowId;
    if (id == null || !platform?.marginFullscreen) return null;
    return toggleMarginFullscreen(id);
  },
  // Whether this page's window is in full screen (Chrome, "only in full screen").
  async windowState(_, sender) {
    const id = sender.tab?.windowId;
    return { fullscreen: id != null && platform?.marginFullscreen ? await isFullscreen(id) : false };
  },
  // A theme's own settings (settings.themes[themeId]), merged into what's
  // there (updateSettings replaces whole top-level keys).
  /** @param {{ themeId: string, patch: object }} message */
  async updateThemeSettings({ themeId, patch }) {
    const theme = THEMES[themeId];
    if (!theme) return updatePackageThemeSettings(themeId, patch);
    await mutate((s) => {
      const themes = s.settings.themes ?? {};
      const own = theme.settingsOf({ themes: { [themeId]: { ...themes[themeId], ...patch } } });
      return { ...s, settings: { ...s.settings, themes: { ...themes, [themeId]: own } } };
    });
  },
  // The active theme's package (background/theme-package.js) for a page's
  // UI: Margin's content script draws it (ui/runtime.js) once it has it.
  // `id`: one of the built-in themes instead (Settings' preview).
  /** @param {{ id?: string }} [message] */
  async themePackage({ id } = {}) {
    if (typeof id === 'string' && PACKAGE_THEMES.includes(id)) return themePackage(id);
    const { settings } = await load();
    return themePackage(activeThemeId(settings));
  },
  // A page the active theme's registered script missed (background/
  // registered.js; Safari loads stored registrations a moment after it
  // starts): inject the theme there (top frame, Margin's content-script
  // world, like the registered script).
  async injectTheme(_, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null || !api.scripting?.executeScript) return false;
    const { settings } = await load();
    // At once, not when the page is idle: core already runs there and waits.
    await api.scripting.executeScript({ target: { tabId }, files: [themeFor(settings).content], injectImmediately: true });
    return true;
  },
  // The page's script in the page's world, for a page that didn't get it from
  // its registration (content/page-link.js): `left`, then the script, as
  // content/page/at-<L>.js and the registration do it.
  /** @param {{ left?: number }} message */
  async injectPage({ left }, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null || !api.scripting?.executeScript) return false;
    const target = { tabId };
    await api.scripting.executeScript({
      target, world: 'MAIN', injectImmediately: true, args: [left ?? null],
      func: (at) => { /** @type {any} */ (window)[Symbol.for('margin.page.start')] = { left: at ?? undefined }; },
    });
    await api.scripting.executeScript({ target, world: 'MAIN', injectImmediately: true, files: ['content/page.bundle.js'] });
    return true;
  },
  // A style sheet the page can't read (another origin's, no CORS:
  // content/page-link.js). No cookies, as a <link> of another origin needs none.
  // The page gets the text, so this is only for real style sheets that it could
  // load anyway: not a local network's unless it's on one, after any redirect.
  // Null if it can't be had (Safari's per-site grants can refuse it): the
  // sheet then stays as it is.
  /** @param {{ url: string }} message */
  async fetchStyle({ url }, sender) {
    const pageUrl = sender?.tab?.url ?? sender?.url ?? '';
    if (!styleUrlAllowed(url, pageUrl)) return null;
    if (styleCache.has(url)) return styleCache.get(url);
    const text = await fetch(url, { credentials: 'omit' }).then((res) => {
      const css = /^text\/css\b/i.test(res.headers.get('content-type') ?? '');
      return res.ok && css && styleUrlAllowed(res.url, pageUrl) ? res.text() : null;
    }).catch(() => null);
    if (text == null) return null;
    if (text.length > STYLE_MAX_CHARS) {
      console.warn('[margin] a style sheet too large to rewrite', url, text.length);
      return null;
    }
    if (text.length > STYLE_CACHED_MAX_CHARS) return text;
    styleCache.set(url, text);
    let chars = 0;
    for (const kept of styleCache.values()) chars += kept.length;
    for (const oldest of styleCache.keys()) {
      if (styleCache.size <= STYLE_CACHE_SIZE && chars <= STYLE_CACHE_CHARS) break;
      chars -= styleCache.get(oldest).length;
      styleCache.delete(oldest);
    }
    return text;
  },
};
