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
import { mark } from '../shared/dom.js';
import * as shortcuts from '../shared/shortcuts.js';
import { platform } from '../shared/platform.js';
import { watchEdits } from './edits.js';
import { startTrackpad } from './trackpad.js';
import { startPageLink } from './page-link.js';
import { startPinch } from './pinch.js';
import { SWITCH_GRACE_MS } from '../shared/switching.js';
import { startLayout } from './layout.js';
import { startLoads } from './loads.js';
import { fromStorage, onlyMark, openTabsCurrent, readForPage, takesChanges, withChanges } from '../shared/stored.js';
import { APP_LINK_KEY, appDraws, boxFromLayout, drawsWindow, layoutFor, unpinchedSize } from '../shared/app-link.js';
import { probeFrames, watchVisible } from '../shared/frame-probe.js';
import { startScrollRecord } from './scroll-record.js';
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
  // What the user typed here and hasn't sent: a tab with a draft isn't put to
  // sleep (background/sleep.js asks: content/edits.js).
  if (platform?.sleepTabs) Margin.content.edits = watchEdits();
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
    // copy replaced.
    if (!api.runtime?.id || dormant) return;
    // A request naming a tab also says the tab's address and place, so the
    // background finds it even if its id is from before (background/tabs.js
    // resolveTab), and trusts the id only if they're its own. Not for this
    // page's own tab as its background named it (hello).
    const ownTab = helloAnswered && (/** @type {any} */ (payload)).tabId === tabId;
    if (Number.isInteger((/** @type {any} */ (payload)).tabId) && !(/** @type {any} */ (payload)).hint && !ownTab) {
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
    // A trackpad gesture's feedback as it goes (content/trackpad.js), for
    // Margin.app's overlay to draw while it draws Margin around this window.
    tellGesture: (/** @type {any} */ g) => { if (appUi() && active()) void send('gesture', g, false); },
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
  const trackpad = startTrackpad(page);
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

  // The box from Margin.app's layout for this window (shared/app-link.js):
  // its insets from the window's edges, less where this viewport sits in the
  // window, in this page's zoomed pixels. No layout for the window yet
  // (null): the box stays as it is (the first-paint one, registered while
  // the app is linked: background/registered.js). A window the app said it
  // draws nothing over: a layout of zeros, no box.
  function appGeometry() {
    const l = layoutFor(appLink, windowId ?? helloWindowId);
    if (!l) return null;
    const at = viewportNow();
    // (The page's area as before any pinch: a pinch magnifies the page, it doesn't move its box. shared/app-link.js.)
    const inner = unpinchedSize({ innerWidth, innerHeight, visualViewport });
    const insets = boxFromLayout(l, { outerWidth, outerHeight, innerWidth: inner.width, innerHeight: inner.height, zoom: pageZoom, x: at?.x, y: at?.y }) ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const radius = Number(l.radius) || 0;
    /** @type {import('./layout.js').Geometry} */
    const g = { insets, radius, radii: Array.isArray(l.radii) ? l.radii : [radius, radius, radius, radius] };
    return g;
  }
  // ---- where this page's area sits in its window (Phase 2 step 8) ---------------
  // Safari can take part of a full-screen window: the Web Inspector docked at
  // the bottom, left or right (Safari's sidebar on the left). The page's area
  // is then smaller than the window, and Margin.app draws only over it
  // (app/shell/Shell.swift overlayFrame), beside the inspector. Its size is
  // the viewport's; where it starts is known exactly from any pointer event
  // (the event's screen point less the window's corner and its own point in
  // the page), else taken as: the width missing on the left (Safari's
  // sidebar, an inspector on the left), the height missing at the bottom in
  // full screen (the inspector: the toolbar is a window of its own there),
  // at the top otherwise (the toolbar). Told to the copy when it changes, by
  // the page in front only (the inspector is a tab's): `viewport`, in the
  // window's points, null for the whole window.
  /** @type {{ x: number, y: number, w: number, h: number } | null} */
  let pointerOrigin = null; // as found for the viewport size w × h
  const viewportNow = () => {
    const z = pageZoom || 1;
    // (Before any pinch: WebKit divides innerWidth and innerHeight by a pinch's scale, which read as Safari taking
    // most of the window, Tirth's log 2026-11-07: Margin drew in a third of it.)
    const inner = unpinchedSize({ innerWidth, innerHeight, visualViewport });
    const w = inner.width * z;
    const h = inner.height * z;
    const offX = Math.max(0, outerWidth - w);
    const offY = Math.max(0, outerHeight - h);
    if (offX < 1 && offY < 1) return null;
    const known = pointerOrigin && Math.abs(pointerOrigin.w - w) < 1 && Math.abs(pointerOrigin.h - h) < 1 ? pointerOrigin : null;
    const full = outerWidth >= screen.width - 1 && outerHeight >= screen.height - 60;
    const x = known ? known.x : offX;
    const y = known ? known.y : full ? 0 : offY;
    const half = (v) => Math.round(v * 2) / 2;
    // `measured`: where the area starts came from a pointer event, not the guess (for Margin.app's log).
    return { x: half(x), y: half(y), width: half(w), height: half(h), ...(known ? { measured: true } : {}) };
  };
  const learnOrigin = (/** @type {MouseEvent} */ e) => {
    // (Not while pinched: an event's client point is then in the magnified page, not the window's points.)
    if ((visualViewport?.scale ?? 1) > 1.001) return;
    const z = pageZoom || 1;
    const w = innerWidth * z;
    const h = innerHeight * z;
    if (pointerOrigin && Math.abs(pointerOrigin.w - w) < 1 && Math.abs(pointerOrigin.h - h) < 1) return;
    if (outerWidth - w < 1 && outerHeight - h < 1) return;
    const x = e.screenX - screenX - e.clientX * z;
    const y = e.screenY - screenY - e.clientY * z;
    if (!(x >= -1 && x <= outerWidth - w + 1 && y >= -1 && y <= outerHeight - h + 1)) return;
    pointerOrigin = { x: Math.max(0, x), y: Math.max(0, y), w, h };
    tellViewport();
    layout.settle();
  };
  for (const type of ['pointermove', 'pointerdown']) addEventListener(type, learnOrigin, { capture: true, passive: true });
  // (Nothing said while the page's area is the whole window: the copy keeps only the tab in front's word.)
  let toldViewport = 'null';
  function tellViewport() {
    if (document.hidden || !appUi() || retired()) return;
    const v = viewportNow();
    const key = JSON.stringify(v);
    if (key === toldViewport) return;
    toldViewport = key;
    void send('viewport', { viewport: v, resizedAt, at: Date.now() }, false);
  }
  // At once (the next frame: Safari's resize as the inspector docks), and again once a drag of its
  // edge settles; the copy and the app pass it on without waiting (Margin's area follows quickly).
  let viewportSettle = 0;
  let resizedAt = 0; // (for Margin.app's log: how long the word took)
  addEventListener('resize', () => {
    resizedAt = Date.now();
    requestAnimationFrame(tellViewport);
    clearTimeout(viewportSettle);
    viewportSettle = setTimeout(tellViewport, 120);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) return; if (toldViewport !== 'null') toldViewport = 'unset'; tellViewport(); });
  const applyApp = () => { layout.settle(); tellViewport(); };
  // What the background says of the link: the page's box from the app's
  // layout from now on, or none.
  const appKey = (l) => JSON.stringify([l?.state ?? null, l?.layouts ?? null, l?.drawn ?? null]);
  // What the log last said of the app here, said again as it changes (the window known later too).
  // Linked, the box is the app's layout for the window: none where it said it draws nothing.
  let saidOfApp = null;
  function sayApp() {
    if (appLink === undefined) return;
    // (Its window not known yet, from Margin's state or the background's hello: not said either way.)
    const known = state?.tabs?.[tabId]?.windowId ?? helloWindowId;
    const said = !appUi() ? 'Margin.app isn\'t linked: the page as it is, no box' : known == null ? 'Margin.app is linked (this page\'s window not known yet)' : drawsWindow(appLink, known) ? 'Margin.app draws Margin around this window' : 'Margin.app is linked but draws nothing over this window: the page as it is, no box';
    if (said !== saidOfApp) console.debug(`[margin] ${said}`);
    saidOfApp = said;
  }
  function setAppLink(next) {
    const value = next && typeof next === 'object' ? next : { state: 'off', layouts: {} };
    if (appLink !== undefined && appKey(value) === appKey(appLink)) return;
    appLink = value;
    const now = appUi();
    mark(marks, 'app', String(appLink.state ?? 'off')); // test/debug hook
    layout.setSource(now ? appGeometry : null);
    sayApp();
    applyApp();
  }
  Margin.content.appDraws = () => appUi();
  // The page's area as it would be told to the app now (null: the whole window): tests read it.
  Margin.content.viewportNow = () => viewportNow();
  addEventListener('resize', applyApp);
  // ⌘T reaching the page (Safari's File › New Tab given another shortcut).
  // Linked, in a window the app draws over, it's the app's (its hot key,
  // PLAN.md §6): nothing visible here, and the app is told. Not linked, or in
  // a window the app said it draws nothing over (`drawn`: not in full screen,
  // not found yet; its hot key isn't on there), a new tab: Margin's new-tab
  // page, which has an address field (background/handlers.js newTabKey;
  // Safari's own `new-tab` command for the same press counts once).
  addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.code !== 'KeyT' || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || retired() || appLink === undefined) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (drawsWindow(appLink, windowId ?? helloWindowId)) void send('appKeyHeard', { command: 'palette' }, false);
    else void send('newTabKey', {}, false);
  }, true);

  // The page being left, or a site's own same-page navigation under way:
  // told for Margin.app's sidebar to show it loading (content/loads.js).
  startLoads({ on: () => appUi() && active(), send: (type, payload) => send(type, payload, false) });

  // ---- data ---------------------------------------------------------------

  let tabId = null;
  let helloWindowId = null;
  let windowId = null;

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
  function shown() {
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

  // Whether this page is shown, said to the background at each change, once at the start and when
  // it asks (Safari: Margin.app tells same-bounds full-screen windows of different profiles apart by
  // which one's page in front is shown: background/link.js visibility). Its time is when it was seen.
  function tellVisibility() {
    if (!platform?.nativeApp || retired()) return;
    void send('visibility', { visible: document.visibilityState === 'visible', at: Date.now(), from: 'page' }, false);
  }
  document.addEventListener('visibilitychange', tellVisibility);
  addEventListener('pageshow', (event) => event.persisted && tellVisibility());
  tellVisibility();
  // When it last turned visible, for Margin.app's frame probe (shared/frame-probe.js).
  const visibleAt = watchVisible();

  // Where the page is scrolled, kept with its Margin tab and taken once when it's opened again
  // (content/scroll-record.js).
  const scrollRecord = startScrollRecord({ send, retired, boxed: () => !!box });

  // The state taken: this page's tab and window (its box is its window's
  // layout), the gestures' settings.
  let firstRender = true; // until the page first takes the state
  function render() {
    if (!state) return;
    if (fullscreenOnly() && fullscreen === null) return; // until the background says (above)
    // Known tab → its window. Until the background answers `hello`, guess.
    windowId = state.tabs?.[tabId]?.windowId ?? helloWindowId ?? V.guessWindow(state, location.href);
    if (tabId != null) scrollRecord.take(!!state.tabs?.[tabId]?.restoreScroll);
    layout.settle();
    trackpad.update();
    if (firstRender) {
      firstRender = false;
      timing.rendered = Math.round(performance.now());
    }
  }

  // Storage reads can resolve out of order; only the latest one renders.
  let version = 0;
  let reading = 0; // reads of storage under way
  // A change taken (hidden) while a read was under way: that read may be
  // older than it and put the old value back, so the page reads again before
  // it takes changes from events once more.
  let staleRead = false;
  let changedDuringRead = 0; // hidden changes taken while a read was under way
  // Storage keys this page has seen, in reads and change events: read again
  // with the rest (shared/stored.js pageKeys).
  const seenKeys = new Set();
  async function refresh() {
    const mine = ++version;
    reading++;
    const missedBefore = changedDuringRead;
    let raw;
    try {
      // All of storage the first time; then all but the site icons, unless
      // they changed (shared/stored.js readForPage).
      raw = await readForPage((keys) => api.storage.local.get(keys), () => state, seenKeys);
    } finally {
      reading--;
    }
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
    state = next;
    if (!zoomAnswered) applyZoom(Number((next.pageZoom?.[location.origin] ?? next.pageZoom?.['*'])?.[0] ?? 1)); // its size from the start
    render();
    return true;
  }
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
    const read = () => void refresh();
    if (firstRender || !state) return read();
    if (!document.hidden) {
      if (tabId == null || staleRead || !takesChanges(changes, { reading, openTabsBy: /** @type {any} */ (state).openTabsBy })) return read();
      const next = withChanges(state, changes);
      if (!next.spaces?.length) return read();
      version++; // newer than any read started before it
      state = next;
      if ('owner' in changes || 'openTabs' in changes) ownerSeen(next.owner, next.openTabsBy);
      if (onlyMark(changes)) return;
      if (!zoomAnswered && 'pageZoom' in changes) applyZoom(Number((next.pageZoom?.[location.origin] ?? next.pageZoom?.['*'])?.[0] ?? 1));
      render();
      return;
    }
    if (reading) changedDuringRead++;
    const next = withChanges(state, changes);
    state = next;
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
  send('hello').then((ctx) => {
    if (dormant) return;
    if (!ctx) return setFullscreen(false); // no background: as if in a window, until a resize asks again
    helloAnswered = true;
    tabId = ctx.tabId;
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
      const drawn = { ...(appLink?.drawn ?? {}) };
      if (typeof ctx.app?.drawn === 'boolean' && ctx.windowId != null) drawn[ctx.windowId] = ctx.app.drawn;
      setAppLink(ctx.app ? { ...(appLink ?? {}), state: ctx.app.state, layouts, drawn } : { state: 'off', layouts, drawn: {} });
    }
    sayApp();
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

  const onMessage = (message, _, sendResponse) => {
    // Whether this page was opened from nothing (no referrer, its first
    // history entry), for the note on Safari's "New tabs open with"
    // (background/newtab-hint.js: Margin.app's overlay says it).
    if (message?.type === 'newtab-hint') return sendResponse({ fromNothing: !document.referrer && history.length === 1 });
    if (message?.type === 'windowState') return setFullscreen(!!message.fullscreen);
    if (message?.type === 'reportVisibility') return tellVisibility();
    // Margin.app's profile handoff asking whether this page draws frames at the full-screen size
    // (shared/frame-probe.js): answered when it's done, or null by its timeout.
    if (message?.type === 'frameProbe') {
      if (retired()) return;
      void probeFrames(message, { visibleAt }).then((answer) => sendResponse(answer), () => sendResponse(null));
      return true;
    }
    // Margin.app's layout for this window, and whether it draws over it, as they change (background/link.js).
    if (message?.type === 'appLayout' && Number.isInteger(message.windowId)) {
      if (!appLink) return;
      const layouts = message.layout ? { ...(appLink.layouts ?? {}), [message.windowId]: message.layout } : appLink.layouts;
      const drawn = typeof message.drawn === 'boolean' ? { ...(appLink.drawn ?? {}), [message.windowId]: message.drawn } : appLink.drawn;
      setAppLink({ ...appLink, layouts, drawn });
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
