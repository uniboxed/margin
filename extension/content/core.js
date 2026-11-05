// Margin on web pages (Margin 2, PLAN.md §7). Margin.app draws all of
// Margin's UI around the browser's window; a page draws none of it, linked
// or not: no UI runtime, no theme, no element of Margin's in the document.
// What a page keeps is what only a page can do: its box (while the app is
// linked, from the app's layout for its window: content/layout.js; not
// linked, none, the page as it is), the trackpad's gestures and Margin's
// pinch, the draft check, the keys a page hears (navigation, ⌘T), its icon
// and zoom, and its part in the background's switches (Phase 3 slims them).
// It reads the state from storage.local, for its tab and window, its
// settings and its copy of Margin.
import * as V from '../shared/view.js';
import { hideHost, mark, marginHosts } from '../shared/dom.js';
import * as shortcuts from '../shared/shortcuts.js';
import { asksBackground, madeAfresh as madeAfreshNavigation, platform } from '../shared/platform.js';
import { watchAway } from '../shared/away.js';
import { listenForHolds } from './hold.js';
import { watchEdits } from './edits.js';
import { takeOver } from './takeover.js';
import { startTrackpad } from './trackpad.js';
import { startPageLink } from './page-link.js';
import { startPinch } from './pinch.js';
import { SWITCH_GRACE_MS } from '../shared/switching.js';
import { startLayout } from './layout.js';
import { createIdleWatch } from './idle.js';
import { STATE_REV, fromStorage, knowsState, onlyMark, openTabsCurrent, readForPage, revAfter, revOf, takesChanges, withChanges } from '../shared/stored.js';
import { APP_LINK_KEY, appDraws, boxFromLayout, layoutFor } from '../shared/app-link.js';
/** @import { MessageType, Request, Result } from '../../types/margin' */

// Starts Margin in this page; false when it shouldn't (or already did).
export function startCore() {
  const api = globalThis.browser ?? globalThis.chrome;
  // Load timing, in ms since navigation start (see logTiming below).
  const timing = { injected: Math.round(performance.now()) };
  if (location.href.startsWith(api.runtime.getURL(''))) return false;

  const Margin = (globalThis.Margin ??= {});
  // Already running in this page: WebKit runs the content scripts again in
  // open pages, in the same world, when Margin's site permissions change.
  if (Margin.content) return false;
  Margin.content = { api, startedAt: Date.now() }; // see background.js injectIntoOpenTabs
  // Keep-ready's holds (content/hold.js), from the start: a tab left is held
  // at once. `holding()`: how many run (the WebKit host counts them).
  if (platform?.keepTabsReady) Margin.content.holding = listenForHolds(api);
  // What the user typed here and hasn't sent: a tab with a draft isn't put to
  // sleep (background/sleep.js asks: content/edits.js).
  if (platform?.sleepTabs) Margin.content.edits = watchEdits();
  // An earlier copy of Margin's sidebar in the page (a build from before
  // Margin 2's app, which drew one): it's taken out of sight, and the page
  // is cleaned up by a reload when that's safe (content/takeover.js).
  const takeover = takeOver(api);
  // An earlier copy's sidebar is (or, once this copy owns the state, turns
  // out to be) in the page: its gestures stay its own.
  const replacing = takeover.replacing;
  let takenOver = false;
  // This copy's address: the stored tabs say whether they're this copy's
  // (shared/stored.js). A copy a newer one replaced stays out of the way
  // (`dormant`, below).
  const origin = api.runtime.getURL('');
  let dormant = false;
  const retired = () => dormant;
  // State shown for tests and nothing else (shared/dom.js mark: only under a
  // test harness): `Margin.content.marks()`.
  const marks = { dataset: /** @type {Record<string, string>} */ ({}) };
  Margin.content.marks = () => ({ ...marks.dataset });

  // ---- Margin.app ---------------------------------------------------------------
  // Linked (or reconnecting: shared/app-link.js), the app draws Margin around
  // this window, and the page's box is the app's layout for its window. Not
  // linked, the page is left as it is. Known from storage (appLink, in the
  // page's first read), then from the background (hello, its `appLayout`
  // messages, appLink's change events).
  /** @type {any} */
  let appLink; // undefined until the first read
  const appUi = () => appDraws(appLink);

  // If the background was unloaded and the first message doesn't wake it in
  // time, retry once.
  // A switch usually lands at once (the background answers in well under a
  // second, waking a tab at most 0.4s), but a background just starting first
  // matches the open tabs (background.js firstSync): a switch waits that
  // long before it's given up; anything else gets a cold start's time.
  const NO_ANSWER = 'no answer';
  /** @type {Record<string, number>} */
  const SEND_TIMEOUT_MS = { activateTab: 7000, openPin: 7000, setSpace: 7000, newTab: 12000, search: 12000, default: 8000 };
  const SWITCH_REQUESTS = new Set(['activateTab', 'openPin', 'setSpace']);
  // These, and a new tab, say when this page stops waiting.
  const TIMED_REQUESTS = new Set([...SWITCH_REQUESTS, 'newTab', 'search']);
  // A switch waits SWITCH_GRACE_MS past that for the answer (`waitsUntil`):
  // the background plans the switch to the deadline, and answers by it, but
  // on a Mac that busy its timers fire late (background/tabs.js focusTab).
  let helloAnswered = false; // this page's background has said which tab it is
  /**
   * @template {MessageType} K
   * @param {K} type a handler in background.js
   * @param {Request<K>} [payload]
   * @param {boolean} [retry]
   * @returns {Promise<Result<K> | undefined>} undefined when it failed
   */
  async function send(type, payload = {}, retry = true) {
    // Margin was reloaded or removed since this copy started (Chrome takes its
    // id away, and sendMessage throws "Extension context invalidated"): a
    // new copy has the page now, this one stays quiet. So does one a newer
    // copy replaced. Nor a request this browser has no use for (platform.js
    // asksBackground).
    if (!api.runtime?.id || dormant || !asksBackground(type)) return;
    // A request naming a tab also says the tab's address and place, so the
    // background finds it even if its id is from before (background/tabs.js
    // resolveTab), and trusts the id only if they're its own. Not for this
    // page's own tab as its background named it (hello).
    const ownTab = helloAnswered && (/** @type {any} */ (payload)).tabId === tabId;
    if (Number.isInteger((/** @type {any} */ (payload)).tabId) && !(/** @type {any} */ (payload)).hint && type !== 'prewake' && !ownTab) {
      const tab = state?.tabs?.[/** @type {any} */ (payload).tabId];
      if (tab) payload = /** @type {any} */ ({ ...payload, hint: { url: tab.url, index: tab.index, title: tab.title, from: /** @type {any} */ (state)?.openTabsBy ?? null } });
    }
    // And when this page stops waiting for it: the background doesn't switch
    // after that. Asked again (retry), it keeps its first deadline.
    if (TIMED_REQUESTS.has(type) && !Number.isFinite((/** @type {any} */ (payload)).deadline)) {
      const deadline = Date.now() + SEND_TIMEOUT_MS[type];
      payload = /** @type {any} */ ({ ...payload, deadline, ...(SWITCH_REQUESTS.has(type) ? { waitsUntil: deadline + SWITCH_GRACE_MS } : {}) });
    }
    const until = (/** @type {any} */ (payload)).waitsUntil ?? (/** @type {any} */ (payload)).deadline;
    const waitMs = Number.isFinite(until) ? Math.max(0, until - Date.now()) : (SEND_TIMEOUT_MS[type] ?? SEND_TIMEOUT_MS.default);
    let timer;
    try {
      // Never waited on forever: in WebKit a copy left from before Margin
      // was updated sends into nothing, and the message neither arrives nor
      // fails.
      const reply = api.runtime.sendMessage({ type, ...payload });
      const res = await Promise.race([
        reply,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(NO_ANSWER)), waitMs); }),
      ]);
      if (res?.ok) return res.result;
      if (res?.stale) return void standDown();
      if (res) return void console.warn('[margin]', type, res.error);
    } catch (err) {
      if (err?.message === NO_ANSWER) return void console.warn('[margin]', type, 'no answer from the background (yet)');
      if (!retry) return void console.warn('[margin]', type, err);
    } finally {
      clearTimeout(timer);
    }
    if (retry) {
      await new Promise((r) => setTimeout(r, 250));
      // No time left for a switch: it didn't happen.
      if (Number.isFinite(until) && until - Date.now() < 500) return;
      return send(type, payload, false);
    }
  }
  Margin.content.send = send;

  // ---- what Margin does on the page ----------------------------------------
  // Each part reads what it shares through `page`.

  /** @type {import('../../types/margin').State | null} */
  let state = null;
  // Chrome, "only in full screen" (setting fullscreenOnly, on by default):
  // in a window that isn't full screen Margin stays out of the way (no box,
  // no keys). Whether the window is in full screen comes from the background
  // (`hello`, `windowState`), not the page's size; null until it says.
  const fullscreenOnly = () => !!platform?.marginFullscreen && state?.settings?.fullscreenOnly !== false;
  /** @type {boolean | null} */
  let fullscreen = null;
  const active = () => !retired() && (!fullscreenOnly() || fullscreen === true);
  Margin.content.active = active; // (whether this copy acts here: it hasn't stood back; Chrome: in full screen)

  // The page's box (content/page-link.js), and the pinch that scales it.
  const link = startPageLink(send);
  /** @type {{ left: number, top: number, right: number, bottom: number } | null} */
  let box = null;
  const pinch = startPinch({ box: () => box, link });
  Margin.content.pinched = () => pinch.zoomed();
  const page = {
    api, marks, send, link, pinch,
    // Where the box is now (content/layout.js).
    boxed: () => !!box,
    setBox: (next) => {
      box = link.can ? next : null;
      link.setBox(box);
      pinch.follow();
    },
    state: () => state,
    active,
    dormant: retired,
    // The page's zoom (1 = 100%).
    zoom: () => pageZoom,
  };
  Margin.content.boxed = () => !!box;

  // ---- page zoom ---------------------------------------------------------------
  // The page's box follows the app's layout in the page's zoomed pixels
  // (appGeometry). Read at start, after a resize (a zoom change resizes the
  // page's viewport; ⌘+ sends nothing else), when shown again (a site's zoom
  // is shared by its tabs).
  let pageZoom = 1;
  let zoomAnswered = false; // until the browser says, the site's last zoom (storage pageZoom)
  function applyZoom(z) {
    if (!Number.isFinite(z) || z <= 0 || Math.abs(z - pageZoom) < 0.001) return;
    pageZoom = z;
    layout.rezoom(); // only from answers and events, after the layout below exists
  }
  // With send's retry: a background asleep when asked answers the second time.
  // Each answer also gives the screen's own scale (devicePixelRatio is that
  // times the page's zoom, in WebKit and Chromium), so the next change is
  // followed at once from the page (the answer, a moment later, confirms).
  let screenScale = null;
  const readZoom = () => send('getZoom').then((z) => {
    if (!Number.isFinite(Number(z)) || Number(z) <= 0) return;
    zoomAnswered = true;
    screenScale = devicePixelRatio / Number(z);
    applyZoom(Number(z));
  }, () => {});
  let zoomTimer = null;
  addEventListener('resize', () => {
    if (screenScale) applyZoom(devicePixelRatio / screenScale);
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(readZoom, 60);
  });
  readZoom();
  const trackpad = startTrackpad(page, { replacing: () => replacing });
  // ⌘⌥↓/↑ next/previous tab, ⌘⌥→/← next/previous space (none while Margin is
  // out of the way). The background does the work; nothing here draws.
  const navSettings = () => (active() ? state?.settings : null);
  shortcuts.installNavigation({ send, getSettings: navSettings });
  // Going in or out of full screen (Chrome): Margin's box comes, or goes.
  // The background tells the window's pages; a resize, or coming back to a
  // tab (moved to another window meanwhile), asks again.
  function setFullscreen(value) {
    if (fullscreen === value) return;
    fullscreen = value;
    render();
  }
  let recheck = null;
  const checkFullscreen = () => {
    if (!platform?.marginFullscreen) return;
    clearTimeout(recheck);
    recheck = setTimeout(() => send('windowState').then((res) => res && setFullscreen(res.fullscreen)), 200);
  };
  addEventListener('resize', checkFullscreen);
  const layout = startLayout(page);
  // A page that puts a new <html> in (replaceChild, document.open): the
  // first-paint placeholder is switched off on that one too (layout.js).
  new MutationObserver(() => { if (state) layout.settle(); }).observe(document, { childList: true });

  // The box from Margin.app's layout for this window (shared/app-link.js):
  // its insets from the window's edges, less where this viewport sits in the
  // window, in this page's zoomed pixels. No layout for the window yet
  // (null): the box stays as it is (the first-paint one, registered while
  // the app is linked: background/registered.js).
  function appGeometry() {
    const l = layoutFor(appLink, windowId ?? helloWindowId);
    if (!l) return null;
    const insets = boxFromLayout(l, { outerWidth, outerHeight, innerWidth, innerHeight, zoom: pageZoom }) ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const radius = Number(l.radius) || 0;
    /** @type {import('./layout.js').Geometry} */
    const g = { insets, radius, radii: Array.isArray(l.radii) ? l.radii : [radius, radius, radius, radius] };
    return g;
  }
  const applyApp = () => layout.settle();
  // What the background says of the link: the page's box from the app's
  // layout from now on, or none.
  const appKey = (l) => JSON.stringify([l?.state ?? null, l?.layouts ?? null]);
  function setAppLink(next) {
    const value = next && typeof next === 'object' ? next : { state: 'off', layouts: {} };
    if (appLink !== undefined && appKey(value) === appKey(appLink)) return;
    const was = appLink === undefined ? null : appUi();
    appLink = value;
    const now = appUi();
    mark(marks, 'app', String(appLink.state ?? 'off')); // test/debug hook
    layout.setSource(now ? appGeometry : null);
    if (now !== was) console.debug(`[margin] ${now ? 'Margin.app draws Margin around this window' : 'Margin.app isn\'t linked: the page as it is, no box'}`);
    applyApp();
  }
  Margin.content.appDraws = () => appUi();
  addEventListener('resize', applyApp);
  // ⌘T reaching the page (Safari's File › New Tab given another shortcut).
  // Linked, it's the app's (its hot key, PLAN.md §6): nothing visible here,
  // and the app is told. Not linked, a new tab: Margin's new-tab page, which
  // says Margin.app isn't running and has an address field
  // (background/handlers.js newTabKey; Safari's own `new-tab` command for
  // the same press counts once).
  addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.code !== 'KeyT' || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || retired() || appLink === undefined) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (appUi()) void send('appKeyHeard', { command: 'palette' }, false);
    else void send('newTabKey', {}, false);
  }, true);

  // ---- data ---------------------------------------------------------------

  let tabId = null;
  let helloWindowId = null;
  let windowId = null;

  // Safari left for another app with this page in front: the background lets
  // go of the tab it keeps ready (background/keep-ready.js). Safari, and on.
  watchAway({ isOn: () => !!platform?.keepTabsReady && V.keepReadyMinutes(state?.settings) > 0, holdMs: () => V.keepReadyMinutes(state?.settings) * 60_000, send: (type, payload) => send(type, payload, false) });

  // ---- this copy, and standing back ---------------------------------------------
  // Until this copy owns the state and has matched the open tabs (after Safari
  // starts, or Margin is updated), the stored tabs are another copy's. Its
  // background says whether a newer copy runs (`hello`, and `owner` when
  // another copy has claimed the state since): this one then stands back.
  let storedOwner = null;
  let waitedSince = 0;
  let mySince = null; // this copy's start, from hello
  let storedTabsBy = null;
  let storageSeen = false;
  function ownerSeen(owner, openTabsBy) {
    storageSeen = true;
    const before = storedOwner;
    storedOwner = owner ?? null;
    storedTabsBy = openTabsBy ?? null;
    const isCurrent = openTabsCurrent(openTabsBy, origin, mySince);
    if (!dormant && !isCurrent && !waitedSince) {
      waitedSince = Date.now();
      console.debug('[margin] getting ready: waiting for this copy of Margin to match the tabs');
    } else if (isCurrent && waitedSince) {
      console.debug(`[margin] getting ready: done after ${Date.now() - waitedSince}ms`);
      waitedSince = 0;
    }
    // Another copy claimed the state since this page started: is this copy
    // the older one (then it stands back), or will it claim it again?
    if (helloAnswered && storedOwner && storedOwner.origin !== origin && before?.origin !== storedOwner.origin) void send('owner');
    // In charge here: a sidebar an earlier copy left in the page (a build that
    // drew one) is put out of sight, and the page loaded again once that's safe.
    if (isCurrent && !dormant) {
      let others = false;
      for (const node of marginHosts(document)) {
        hideHost(node);
        others = true;
      }
      if (others && !takenOver) {
        takenOver = true;
        takeover.arm();
      }
    }
  }
  // Out of the way: no box, keys or gestures from this copy (Safari runs both
  // copies until it quits; this page can only reach the older one). The box
  // is left to the copy in charge.
  function standDown() {
    if (dormant) return;
    dormant = true;
    console.info('[margin] a newer copy of Margin runs here: this one stays out of the way');
    trackpad.update();
  }

  // ---- the state, as the page is shown -----------------------------------------
  // Read again whenever the page is shown (Safari suspends tabs it isn't
  // showing, and they miss storage events meanwhile; a page from the
  // back/forward cache missed them too).
  // A preparation under way for a switch to this page (prepareForShow, below).
  /** @type {{ token: string, at: number } | null} */
  let preparedShow = null;
  // Preparations called off before they took `preparedShow`: they stop there.
  // The last few only; each token is used once.
  const calledOff = new Set();
  function shown() {
    preparedShow = null;
    // Drawn at once from what changed while hidden (below), before storage
    // is read again.
    if (changedWhileHidden && state) render();
    changedWhileHidden = false;
    void refresh();
    checkFullscreen();
    readZoom();
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') shown(); });
  addEventListener('pageshow', (event) => event.persisted && shown());

  // The state taken: this page's tab and window (its box is its window's
  // layout), the gestures' settings.
  let firstRender = true; // until the page first takes the state
  function render() {
    if (!state) return;
    if (fullscreenOnly() && fullscreen === null) return; // until the background says (above)
    // Known tab → its window. Until the background answers `hello`, guess.
    windowId = state.tabs?.[tabId]?.windowId ?? helloWindowId ?? V.guessWindow(state, location.href);
    layout.settle();
    trackpad.update();
    if (firstRender) {
      firstRender = false;
      timing.rendered = Math.round(performance.now());
    }
  }

  // Storage reads can resolve out of order; only the latest one renders.
  let version = 0;
  // Before a programmatic switch, the destination's storage still names the
  // source tab/space as active: its own tab's space is made the window's.
  /** @param {any} next @param {{ tabId: number, windowId: number } | null} show */
  function stateForShow(next, show) {
    const targetId = show?.tabId;
    const targetWindow = show?.windowId;
    const spaceId = targetId != null ? next.tabSpace?.[targetId] : null;
    if (targetWindow == null || !spaceId || !next.spaces?.some((space) => space.id === spaceId)) return next;
    if (next.activeSpaceByWindow?.[targetWindow] === spaceId) return next;
    return { ...next, activeSpaceByWindow: { ...next.activeSpaceByWindow, [targetWindow]: spaceId } };
  }

  /** @param {{ tabId: number, windowId: number } | null} [show] */
  let reading = 0; // reads of storage under way
  // A change taken (hidden) while a read was under way: that read may be
  // older than it and put the old value back, so the page reads again before
  // it takes changes from events once more.
  let staleRead = false;
  let changedDuringRead = 0; // hidden changes taken while a read was under way
  // Storage keys this page has seen, in reads and change events: read again
  // with the rest (shared/stored.js pageKeys).
  const seenKeys = new Set();
  // The last write of the state this page's `state` has (shared/stored.js
  // STATE_REV): from its last read and every change event since. Null when
  // not known: a preparation then reads.
  /** @type {string | null} */
  let knownRev = null;
  // DEVELOPMENT DIAGNOSTICS: the last refresh's read and render, in ms (the
  // switch log's preparation timings: prepareForShow).
  let refreshTimes = { readMs: 0, renderMs: 0 };
  const msSince = (/** @type {number} */ since) => Math.round((performance.now() - since) * 10) / 10;
  async function refresh(show = null) {
    const mine = ++version;
    reading++;
    const missedBefore = changedDuringRead;
    const readFrom = performance.now(); // DEVELOPMENT DIAGNOSTICS
    let raw;
    try {
      // All of storage the first time; then all but the site icons, unless
      // they changed (shared/stored.js readForPage).
      raw = await readForPage((keys) => api.storage.local.get(keys), () => state, seenKeys);
    } finally {
      reading--;
    }
    const readMs = msSince(readFrom), renderFrom = performance.now(); // DEVELOPMENT DIAGNOSTICS
    for (const key of Object.keys(raw)) seenKeys.add(key);
    seenKeys.add(APP_LINK_KEY); // read every time from now on
    if (mine === version || appLink === undefined) setAppLink(raw[APP_LINK_KEY]);
    const missed = changedDuringRead !== missedBefore;
    if (missed) staleRead = true;
    const next = fromStorage(raw);
    if (mine === version) ownerSeen(next.owner, next.openTabsBy);
    timing.storage ??= Math.round(performance.now());
    if (mine !== version || !next.spaces?.length) return false; // stale, or background not initialized yet
    if (!missed) staleRead = false; // what's taken now is storage as read, newer than any change taken before
    knownRev = missed ? null : revOf(raw);
    // Brought to the front without preparation (a tab Safari restores as it's
    // shown): until `hello` says which tab this is, the background's note does
    // (background/tabs.js noteShowing), so its window's layout is known.
    const noted = tabId == null && !dormant ? notedShowing(next.showing) : null;
    if (noted) {
      adoptedNote = noted;
      tabId = noted.tabId;
      helloWindowId = noted.windowId;
      console.debug(`[margin] taken as tab ${noted.tabId}, the one being shown (before hello)`);
    }
    state = stateForShow(next, show ?? (noted ? { tabId: noted.tabId, windowId: noted.windowId } : null));
    if (!zoomAnswered) applyZoom(Number((next.pageZoom?.[location.origin] ?? next.pageZoom?.['*'])?.[0] ?? 1)); // its size from the start
    render();
    refreshTimes = { readMs, renderMs: msSince(renderFrom) }; // DEVELOPMENT DIAGNOSTICS
    return true;
  }
  // The state the page has, taken for a show as a read would take it
  // (prepareForShow: the page knows the last write).
  /** @param {{ tabId: number, windowId: number }} show */
  function drawKnown(show) {
    const renderFrom = performance.now(); // DEVELOPMENT DIAGNOSTICS
    state = stateForShow(state, show);
    const zoom = /** @type {any} */ (state).pageZoom;
    if (!zoomAnswered) applyZoom(Number((zoom?.[location.origin] ?? zoom?.['*'])?.[0] ?? 1));
    render();
    refreshTimes = { readMs: 0, renderMs: msSince(renderFrom) }; // DEVELOPMENT DIAGNOSTICS
    return true;
  }
  let adoptedNote = null; // until hello confirms it (or not)
  const SHOWING_MS = 10000;
  const sameDocument = (a, b) => String(a ?? '').split('#')[0] === String(b ?? '').split('#')[0];
  // Only for a page that started as the note was written: the tab Safari
  // loads as Margin brings it to the front, not a page reloaded by hand a
  // few seconds later.
  const startedWith = (at) => performance.timeOrigin - at > -1000 && performance.timeOrigin - at < 3000;
  function notedShowing(showing) {
    if (!showing || !startedWith(showing.at) || !Number.isInteger(showing.tabId) || Date.now() - showing.at > SHOWING_MS || document.hidden) return null;
    return sameDocument(showing.url, location.href) ? showing : null;
  }

  // ---- a tab shown for the first time ------------------------------------------
  // (Phase 3 deletes this with the background's switching machinery.)
  // WebKit waits for a tab's first paint before showing it only for a view
  // that has been in a window before (WebPageProxy::dispatchActivityStateChange);
  // the background introduces a tab it can't prove has been (background/tabs.js
  // pageThere, mayIntroduce). The page says as it starts (hello) how it was
  // made, whether its copy started with it (`fresh`), and its own id (`doc`),
  // and says each time it comes into view from hidden (`inView`), until the
  // background answers that its tab is proven.
  const docId = (() => {
    try {
      return globalThis.crypto.randomUUID();
    } catch {
      return `${Date.now()}-${String(Math.random()).slice(2)}`;
    }
  })();
  Margin.content.documentId = docId;
  const startedFresh = document.readyState === 'loading';
  // (Not a reload: shared/platform.js madeAfresh.)
  const madeAfresh = (() => {
    try {
      return madeAfreshNavigation(/** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType('navigation')[0])?.type, history.length);
    } catch {
      return false;
    }
  })();
  const startedVisible = !document.hidden && document.readyState === 'loading' && madeAfresh;
  let wasHidden = !startedVisible;
  let windowSeen = !startedVisible;
  let cameIntoView = false;
  let markProven = false;
  // The background's word kept in this page's world too (`Margin.inWindowAt`):
  // the world outlives a copy of Margin, and the copy after reads it
  // (background/tabs.js pageThere 'proven').
  const provenHere = () => {
    markProven = true;
    if (!Number.isFinite(Margin.inWindowAt)) Margin.inWindowAt = Date.now();
  };
  let hiddenNow = document.hidden;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      wasHidden = hiddenNow = true;
      return;
    }
    if (wasHidden) windowSeen = cameIntoView = true;
    if (hiddenNow && !markProven) void Promise.resolve(send('inView', { doc: docId }, false)).then((proven) => { if (proven === true) provenHere(); }, () => {});
    hiddenNow = false;
  });
  Margin.content.windowSeen = () => windowSeen;
  Margin.content.cameIntoView = () => cameIntoView;
  // When this page last handled a change of its visibility, and when it
  // first drew after it last became visible (background/tabs.js pingInPage,
  // drewInPage).
  /** @type {number | null} */
  let visibilityAt = null;
  /** @type {number | null} */
  let drewVisibleAt = null;
  if (platform?.introduceTabs) {
    document.addEventListener('visibilitychange', () => {
      visibilityAt = Date.now();
      if (document.visibilityState !== 'visible') return;
      let done = false;
      /** @type {ResizeObserver | null} */
      let observer = null;
      const drew = () => {
        if (done) return;
        done = true;
        drewVisibleAt = Date.now();
        try { observer?.disconnect(); } catch {}
      };
      try {
        observer = new ResizeObserver(drew);
        observer.observe(document.documentElement);
      } catch {}
      try { requestAnimationFrame(drew); } catch {}
    });
  }
  Margin.content.visibilityChangedAt = () => visibilityAt;
  Margin.content.drewVisibleAt = () => drewVisibleAt;

  // The background's preparation of a hidden tab before it shows it
  // (background/tabs.js prepareTabForShow, through scripting.executeScript in
  // this world). Nothing is drawn here, so there's nothing to get ready: the
  // page takes its tab, window and state for the show (its box is its
  // window's), and answers that it isn't a page that draws (as every page
  // did while the app drew, before Phase 2 step 5; Phase 3 removes the call).
  // `sentAt`, and the answer's `timings`: DEVELOPMENT DIAGNOSTICS.
  /** @param {{ token?: string, tabId?: number, windowId?: number, until?: number, rev?: string | null, sentAt?: number }} [context] */
  Margin.content.prepareForShow = async ({ token, tabId: targetId, windowId: targetWindow, rev = null, sentAt } = {}) => {
    const lagMs = Number.isFinite(sentAt) ? Date.now() - /** @type {number} */ (sentAt) : null; // DEVELOPMENT DIAGNOSTICS
    if (!token || !Number.isInteger(targetId) || targetWindow == null) return { ready: false, reason: 'bad context' };
    // What the page was told before this came runs first (WebKit queues a
    // visibilitychange as a task): a message to itself.
    await new Promise((resolve) => {
      const turn = new MessageChannel();
      turn.port1.onmessage = () => {
        turn.port1.close();
        resolve(undefined);
      };
      turn.port2.postMessage(null);
    });
    // Called off meanwhile (cancelPreparedShow).
    if (calledOff.delete(token)) {
      preparedShow = null;
      return { ready: false, reason: 'superseded' };
    }
    preparedShow = { token, at: Date.now() };
    tabId = targetId;
    helloWindowId = targetWindow;
    const known = !firstRender && !!state?.spaces?.length && knowsState(rev, { known: knownRev, reading, staleRead });
    const taken = known ? drawKnown({ tabId: targetId, windowId: targetWindow }) : await refresh({ tabId: targetId, windowId: targetWindow });
    if (preparedShow?.token !== token) return { ready: false, reason: 'superseded' };
    preparedShow = null;
    const { readMs, renderMs } = refreshTimes; // DEVELOPMENT DIAGNOSTICS
    return { ready: false, reason: taken && state ? 'nothing drawn in pages' : 'state not ready', timings: { lagMs, readMs, renderMs, known: known ? 1 : 0, revSent: typeof rev === 'string' ? 1 : 0 } };
  };
  // A page is never covered for its arrival (nothing is drawn here).
  Margin.content.coverArrival = () => false;
  Margin.content.cancelPreparedShow = (token) => {
    if (!preparedShow || preparedShow.token !== token) {
      // Perhaps a preparation that hasn't taken the page yet (above).
      if (typeof token === 'string') {
        calledOff.add(token);
        if (calledOff.size > 8) calledOff.delete(calledOff.values().next().value);
      }
      return false;
    }
    preparedShow = null;
    void refresh();
    return true;
  };

  Margin.content.getState = () => ({ state, tabId, windowId });
  // Hidden, a page keeps its state current from the change events (they
  // carry the values) without taking them further: shown() does it at once.
  // Shown, it takes them the same way; it reads storage again only when an
  // event can't be taken (shared/stored.js takesChanges), before it first has
  // the state, and whenever it's shown.
  // The background's note of a tab being shown is for that tab's page only.
  const onlyShowing = (changes) => Object.keys(changes).every((key) => key === 'showing');
  let changedWhileHidden = false;
  const onStorageChanged = (changes, area) => {
    if (area !== 'local' || dormant) return;
    // The theme's package is for Margin.app (background/theme-package.js): nothing here.
    if ('uiTheme' in changes) {
      const { uiTheme: _, ...rest } = changes;
      if (!Object.keys(rest).length) return;
      changes = rest;
    }
    // Margin.app's link (background/link.js): not state.
    if (APP_LINK_KEY in changes) {
      setAppLink(changes[APP_LINK_KEY].newValue);
      const { [APP_LINK_KEY]: _, ...rest } = changes;
      if (!Object.keys(rest).length) return;
      changes = rest;
    }
    // The data set's times for Margin.app, written on their own (background/
    // store.js): nothing a page reads.
    if (Object.keys(changes).every((key) => key.startsWith('dataMeta:'))) return;
    for (const key of Object.keys(changes)) seenKeys.add(key);
    if (!firstRender && onlyShowing(changes)) return;
    // The write this brings, if the state takes it (one read instead: the
    // read says).
    const rev = STATE_REV in changes ? revAfter(knownRev, changes[STATE_REV]) : knownRev;
    const read = () => {
      knownRev = null;
      void refresh();
    };
    if (firstRender || !state) return read();
    if (!document.hidden) {
      if (tabId == null || staleRead || !takesChanges(changes, { reading, openTabsBy: /** @type {any} */ (state).openTabsBy })) return read();
      const next = withChanges(state, changes);
      if (!next.spaces?.length) return read();
      version++; // newer than any read started before it
      state = next;
      knownRev = rev;
      if ('owner' in changes || 'openTabs' in changes) ownerSeen(next.owner, next.openTabsBy);
      if (onlyMark(changes)) return;
      if (!zoomAnswered && 'pageZoom' in changes) applyZoom(Number((next.pageZoom?.[location.origin] ?? next.pageZoom?.['*'])?.[0] ?? 1));
      render();
      return;
    }
    if (reading) changedDuringRead++;
    const next = withChanges(state, changes);
    state = next;
    knownRev = rev;
    changedWhileHidden = true;
    if ('owner' in changes || 'openTabs' in changes) ownerSeen(next.owner, next.openTabsBy);
    // The trackpad's listeners follow the settings now: a swipe right after
    // this page is shown is already guarded.
    if ('settings' in changes) trackpad.update();
  };
  api.storage.onChanged.addListener(onStorageChanged);

  // One debug-level line per page (hidden unless the console shows Debug
  // messages), once it has loaded. All numbers are ms since navigation
  // start: if "injected" is late, Safari ran the content script late; if
  // "storage" is late, the storage.local read was slow.
  function logTiming() {
    const nav = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType?.('navigation')?.[0]);
    const fmt = (n) => (n == null ? '–' : `${Math.round(n)}`);
    console.debug(
      `[margin] timing (ms) injected=${fmt(timing.injected)} storage=${fmt(timing.storage)} state=${fmt(timing.rendered)}` +
        ` | page DOMContentLoaded=${fmt(nav?.domContentLoadedEventStart)} load=${fmt(nav?.loadEventStart)} app=${appLink?.state ?? '–'}`,
    );
  }
  if (document.readyState === 'complete') setTimeout(logTiming);
  else addEventListener('load', () => setTimeout(logTiming), { once: true });
  void refresh();
  send('hello', { ...(windowSeen ? {} : { unseen: true }), doc: docId, fresh: startedFresh, made: madeAfresh }).then((ctx) => {
    if (dormant) return;
    if (!ctx) return setFullscreen(false); // no background: as if in a window, until a resize asks again
    helloAnswered = true;
    if (ctx.proven === true) provenHere();
    // The background's note named another tab with this address: taken
    // again from storage as this tab.
    const wrongNote = adoptedNote && adoptedNote.tabId !== ctx.tabId;
    adoptedNote = null;
    tabId = ctx.tabId;
    if (wrongNote) void refresh();
    Margin.content.instanceId = ctx.instanceId; // see background.js injectIntoOpenTabs
    // Which copy's tab ids this page may trust: the stored ones are checked
    // again against it (Chrome keeps its address across restarts).
    if (Number.isFinite(ctx.since)) {
      mySince = ctx.since;
      if (storageSeen) ownerSeen(storedOwner, storedTabsBy);
    }
    helloWindowId = ctx.windowId;
    fullscreen = ctx.fullscreen;
    // The background's word on the link (it may be newer than storage's).
    if (ctx.app !== undefined) {
      const layouts = { ...(appLink?.layouts ?? {}) };
      if (ctx.app?.layout && ctx.windowId != null) layouts[ctx.windowId] = ctx.app.layout;
      setAppLink(ctx.app ? { ...(appLink ?? {}), state: ctx.app.state, layouts } : { state: 'off', layouts });
    }
    if (ctx.warmUp && ctx.warmUp.state !== 'running') idle.end();
    render(); // its window is known now
  });

  // Safari gives extensions no favicons: tell the background which icon this
  // page uses (it fetches and stores it once per site). Again on load, for
  // pages that add their icon from script.
  let reportedIcon = null;
  function reportIcon() {
    if (!platform?.fetchFavicons) return; // the browser provides icons (Chrome)
    const links = [.../** @type {NodeListOf<HTMLLinkElement>} */ (document.querySelectorAll('link[rel]'))].map((l) => ({
      rel: l.rel,
      href: l.href,
      sizes: l.getAttribute('sizes') ?? '',
      type: l.type,
    }));
    const href = V.pickIconHref(links, location.href);
    if (!href || href === reportedIcon) return;
    reportedIcon = href;
    send('pageIcon', { href });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reportIcon, { once: true });
  else reportIcon();
  addEventListener('load', reportIcon, { once: true });

  // ---- the warm-up after a relaunch (background/warm-up.js) ------------------
  // Whether the user is idle here, asked by the background before it loads a
  // tab behind this page, and the first input after that said to it
  // (content/idle.js). (Its note was drawn in the in-page sidebar; Phase 3
  // deletes the warm-up.)
  const idle = createIdleWatch({
    busy: () => (!active() ? 'out of the way' : null),
    acted: (at) => void send('warmUpInput', { at }, false),
  });

  const onMessage = (message, _, sendResponse) => {
    if (message?.type === 'warm-up-idle') return sendResponse(dormant ? { idle: false, why: 'not in charge', retryMs: 5000 } : message.prime ? idle.watch() : idle.ask(message));
    if (message?.type === 'warm-up') {
      if (message.progress && message.progress.state !== 'running') idle.end();
      return;
    }
    // The background switching from this tab to another (next/previous
    // tab): answered that this page isn't covered (nothing is drawn here).
    if (message?.type === 'switching') return sendResponse(false);
    if (message?.type === 'windowState') return setFullscreen(!!message.fullscreen);
    // Margin.app's layout for this window, as it changes (background/link.js).
    if (message?.type === 'appLayout' && Number.isInteger(message.windowId)) {
      if (!appLink) return;
      setAppLink({ ...appLink, layouts: { ...(appLink.layouts ?? {}), [message.windowId]: message.layout } });
    }
  };
  api.runtime.onMessage.addListener(onMessage);
  // Off as the page is left, back on if it comes back from the back/forward
  // cache (pageshow above has shown() read storage again). WebKit holds a
  // listener on a browser.* event, and with it the page's whole document,
  // after that page has gone into the cache and been dropped from it.
  let listening = true;
  addEventListener('pagehide', () => {
    if (!listening) return;
    listening = false;
    knownRev = null; // the changes made meanwhile won't reach it
    api.storage.onChanged.removeListener(onStorageChanged);
    api.runtime.onMessage.removeListener(onMessage);
  });
  addEventListener('pageshow', (event) => {
    if (!event.persisted || listening) return;
    listening = true;
    api.storage.onChanged.addListener(onStorageChanged);
    api.runtime.onMessage.addListener(onMessage);
  });
  return true;
}
