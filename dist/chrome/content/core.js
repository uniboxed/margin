// Margin on web pages: everything it does there, whatever the theme. Renders
// from storage.local; when to show, dock, push the page, follow gestures and
// shortcuts is decided here. What it looks like is the active theme's
// (themes/<id>/content.js, a separate script that runs right after this
// one; see themes/register.js for what a theme provides).
import * as V from '../shared/view.js';
import { createHost, setPageZoom } from '../shared/dom.js';
import * as shortcuts from '../shared/shortcuts.js';
import { platform } from '../shared/platform.js';
import { frameAware } from '../shared/shell-logic.js';
import { takeOver } from './takeover.js';
import { startTrackpad } from './trackpad.js';
import { startLoader } from './loader.js';
import { createSwitching, backgroundSwitches } from '../shared/switching.js';
import { startLayout } from './layout.js';
/** @import { MessageType, Request, Result } from '../../types/margin' */

// Starts Margin in this page; false when it shouldn't (or already did).
// `onTheme(theme)` runs once the theme is mounted (content/main.js wires the
// palette then).
/** @param {{ onTheme?: (theme: any) => void }} [options] */
export function startCore({ onTheme } = {}) {
  const api = globalThis.browser ?? globalThis.chrome;
  // Load timing, in ms since navigation start (see logTiming below).
  const timing = { injected: Math.round(performance.now()) };
  if (location.href.startsWith(api.runtime.getURL(''))) return false;

  const Margin = (globalThis.Margin ??= {});
  // Already running in this page: WebKit runs the content scripts again in
  // open pages, in the same world, when Margin's site permissions change.
  if (Margin.content) return false;
  Margin.content = { api, startedAt: Date.now() }; // see background.js injectIntoOpenTabs
  // An earlier copy of Margin's sidebar in the page: take over from it.
  const replacing = takeOver(api);

  // Fitted layout (content/shell.js, registered while "Keep open" is on; it
  // runs right after this script): the page moves into a frame, the "card",
  // and this document becomes Margin's shell around it. Whatever must also
  // hear the page (pointer, keys, wheel, pinch) registers with onCard and is
  // attached to the card's window once the page is in it.
  const cardHooks = [];
  Margin.content.onCard = (fn) => {
    cardHooks.push(fn);
    if (Margin.shell?.card) fn(Margin.shell.card);
  };
  Margin.content.cardReady = (win) => {
    for (const fn of cardHooks) fn(win);
  };

  const host = createHost(document, 'margin-sidebar-host');
  const shadow = host.attachShadow({ mode: 'closed' });

  // Some pages replace <html>'s children; put the host back if it's removed.
  const attach = () => {
    if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
  };
  attach();
  const observer = new MutationObserver(attach);
  observer.observe(document, { childList: true });
  if (document.documentElement) observer.observe(document.documentElement, { childList: true });
  document.addEventListener('DOMContentLoaded', attach);

  // If the background was unloaded and the first message doesn't wake it in
  // time, retry once.
  // A switch should land at once (the background answers in well under a
  // second, waking a tab at most 0.4s); anything else gets a cold start's time.
  const NO_ANSWER = 'no answer';
  /** @type {Record<string, number>} */
  const SEND_TIMEOUT_MS = { activateTab: 1500, openPin: 1500, default: 8000 };
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
    // new copy has the page now, this one stays quiet.
    if (!api.runtime?.id) return;
    let timer;
    let reply;
    try {
      // Never waited on forever: in WebKit a copy left from before Margin
      // was updated sends into nothing, and the message neither arrives nor
      // fails (a switch then hung, highlighted, until it gave up).
      reply = api.runtime.sendMessage({ type, ...payload });
      const res = await Promise.race([
        reply,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(NO_ANSWER)), SEND_TIMEOUT_MS[type] ?? SEND_TIMEOUT_MS.default); }),
      ]);
      if (res?.ok) return res.result;
      if (res) return void console.warn('[margin]', type, res.error);
    } catch (err) {
      if (err?.message === NO_ANSWER) return void noAnswer(type, reply);
      if (!retry) return void console.warn('[margin]', type, err);
    } finally {
      clearTimeout(timer);
    }
    if (retry) {
      await new Promise((r) => setTimeout(r, 250));
      return send(type, payload, false);
    }
  }
  Margin.content.send = send;
  // The background didn't answer this page in time: the request is given up
  // (a switch stops waiting), and if there's still no answer after
  // STALE_MS (a slow cold start answers well before), and the page is the
  // one in front with Margin on it, the page says how to fix it (once), and
  // takes that back if the answer comes after all. The background also puts
  // the current copy into a tab brought to the front (background/tabs.js
  // ensureCurrent), so this is the rare case left.
  const STALE_MS = 8000;
  let toldNoAnswer = false;
  let noticeUp = false;
  function noAnswer(type, reply) {
    console.warn('[margin]', type, 'no answer from the background (yet)');
    let answered = false;
    reply?.then(() => {
      answered = true;
      if (noticeUp) {
        noticeUp = false;
        toldNoAnswer = false;
        view?.showNotice?.(null);
      }
    }, () => {});
    setTimeout(() => {
      if (answered || toldNoAnswer || document.hidden || !view?.showNotice || !active()) return;
      offerReload('Margin isn’t responding on this page (it was probably updated). Reload the page to fix it.');
    }, STALE_MS - (SEND_TIMEOUT_MS[type] ?? SEND_TIMEOUT_MS.default));
  }
  function offerReload(text) {
    toldNoAnswer = true;
    noticeUp = true;
    view?.showNotice?.({
      text,
      // Loaded again with a GET (a reload could send a form again).
      actions: [{ label: 'Reload', run: () => location.replace(location.href) }, { label: 'Not now', run: () => { noticeUp = false; } }],
      duration: 20000,
    });
  }

  // ---- the theme -------------------------------------------------------------
  // What Margin looks like: the theme's view, mounted into the closed shadow
  // root. Nothing is drawn before it's mounted (usually at once: its script
  // runs right after this one).
  let theme = null;
  let view = null;
  let firstRender = true; // until the first render, nothing has been drawn
  // "+ New tab" opens the command palette here (content/palette.js sets openPalette).
  const onNewTab = () => (Margin.content.openPalette ? Margin.content.openPalette({ newTab: true }) : send('newTab', { windowId }));
  function mountTheme() {
    if (view || !Margin.theme) return;
    try {
      view = Margin.theme.mount({ shadow, document, send: themeSend, onNewTab, onWidth: layout.onWidth, onScroll: saveScroll, onSwitch: (id, request) => Margin.content.startSwitching(id, request) });
      theme = Margin.theme;
    } catch (err) {
      return console.error('[margin] theme', Margin.theme.id, 'failed to start:', err);
    }
    applyColorScheme();
    onTheme?.(theme);
    if (state) render();
    layout.reopen(); // hovered or toggled before it was there
    // Taking over from a copy left from before Margin was updated, on a page
    // that copy fitted beside the sidebar: its layout (and the page's keys
    // and gestures in it) stay with the old copy until the page loads again
    // (content/takeover.js does that once it's hidden; offered now too).
    if (replacing && document.documentElement.hasAttribute('data-margin-shell') && !document.hidden) {
      offerReload('Margin was updated. Reload this page to fit it beside the sidebar again.');
    }
  }
  Margin.content.themeArrived = mountTheme;
  // The theme's registered script didn't run on this page (Safari loads
  // stored registrations a moment after it starts, and pages open when Margin
  // was installed only get this script): ask the background for it.
  let themeRequested = false;
  function requestTheme() {
    if (view || themeRequested) return;
    themeRequested = true;
    // If it didn't work, the next state change asks again.
    send('injectTheme').then((ok) => { if (!ok) themeRequested = false; });
  }

  // ---- Light/Dark: follows only the Mac's appearance, never the page ---------

  const systemDark = matchMedia('(prefers-color-scheme: dark)');
  const colorScheme = () => (systemDark.matches ? 'dark' : 'light');
  Margin.content.colorScheme = colorScheme;
  const applyColorScheme = () => view?.setColorScheme(colorScheme());
  systemDark.addEventListener?.('change', applyColorScheme);

  // ---- what Margin does on the page ----------------------------------------
  // Each part reads what it shares through `page`.

  /** @type {import('../../types/margin').State | null} */
  let state = null;
  // Chrome, "only in full screen" (setting fullscreenOnly, on by default):
  // in a window that isn't full screen Margin shows nothing, and when it's
  // reached for (the left edge, its shortcuts) it offers full screen, which
  // is where it works without Chrome's toolbar (background/fullscreen.js).
  // Whether the window is in full screen comes from the background (`hello`,
  // `windowState`), not the page's size (background/fullscreen.js
  // isFullscreen); null until it says, and Margin doesn't draw until then.
  const fullscreenOnly = () => !!platform?.marginFullscreen && state?.settings?.fullscreenOnly !== false;
  /** @type {boolean | null} */
  let fullscreen = null;
  const active = () => !fullscreenOnly() || fullscreen === true;
  let lastOffer = 0;
  function offerFullscreen() {
    if (fullscreen === null || Date.now() - lastOffer < 1500) return;
    lastOffer = Date.now();
    view?.showNotice?.({
      text: 'Margin works in full screen.',
      actions: [
        { label: 'Go full screen', run: () => send('toggleFullscreen', {}) },
        { label: 'Use in windows too', run: () => send('updateSettings', { patch: { fullscreenOnly: false } }) },
      ],
    });
  }
  Margin.content.active = active;
  Margin.content.offerFullscreen = offerFullscreen;

  const page = {
    api, host, send,
    onCard: Margin.content.onCard,
    view: () => view,
    theme: () => theme,
    state: () => state,
    setState: (next) => { state = next; },
    firstRender: () => firstRender,
    active,
    offerFullscreen,
    // The page's zoom (1 = 100%), and Margin's pinch having changed it.
    zoom: () => pageZoom,
    zoomed: (z) => applyZoom(z),
  };

  // ---- page zoom ---------------------------------------------------------------
  // Margin's UI keeps its size whatever the page's zoom (⌘+ / ⌘−, Margin's
  // pinch), as a browser's does (shared/dom.js setPageZoom); the push and the
  // fitted card follow the sidebar in the page's zoomed pixels (layout.js).
  // Read at start, after a resize (a zoom change resizes the page's
  // viewport; ⌘+ sends nothing else), when shown again (a site's zoom is
  // shared by its tabs), and from Margin's own pinch.
  let pageZoom = 1;
  let zoomAnswered = false; // until the browser says, the site's last zoom (storage pageZoom)
  function applyZoom(z) {
    if (!Number.isFinite(z) || z <= 0 || Math.abs(z - pageZoom) < 0.001) return;
    pageZoom = z;
    setPageZoom(document, z);
    layout.rezoom(); // only from answers and events, after the layout below exists
  }
  const readZoom = () => send('getZoom', {}, false).then((z) => {
    if (!Number.isFinite(Number(z))) return;
    zoomAnswered = true;
    applyZoom(Number(z));
  }, () => {});
  let zoomTimer = null;
  addEventListener('resize', () => {
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(readZoom, 60);
  });
  readZoom();
  const trackpad = startTrackpad(page, { replacing });
  const loader = startLoader(page, { pullRefreshing: trackpad.pullRefreshing });
  // ⌘⌥↓/↑ next/previous tab, ⌘⌥→/← next/previous space. Before the layout's
  // show/hide key: on a key both match, navigating wins (as it always has).
  const navSettings = () => (active() ? state?.settings : null); // none while Margin is out of the way
  shortcuts.installNavigation({ send, getSettings: navSettings });
  Margin.content.onCard((win) => shortcuts.installNavigation({ send, getSettings: navSettings, target: win }));
  // Going in or out of full screen: Margin shows up, or gets out of the way.
  // The background tells the window's pages; a resize, or coming back to a
  // tab (moved to another window meanwhile), asks again.
  let wasActive = null;
  function setFullscreen(value) {
    fullscreen = value;
    if (active() === wasActive) return;
    if (active()) view?.showNotice?.(null);
    render();
  }
  let recheck = null;
  const checkFullscreen = () => {
    if (!platform?.marginFullscreen) return;
    clearTimeout(recheck);
    recheck = setTimeout(() => send('windowState').then((res) => res && setFullscreen(res.fullscreen)), 200);
  };
  addEventListener('resize', checkFullscreen);
  const layout = startLayout(page, { loader });
  Margin.content.sidebar = { show: layout.show, hide: layout.hide, toggle: layout.toggle };
  Margin.content.peek = layout.peek;
  // Something of Margin's is taking keys (fitted layout: don't hand them to the page).
  Margin.content.uiBusy = () => !!view?.isBusy() || !!Margin.content.paletteOpen?.();

  // ---- data ---------------------------------------------------------------

  let tabId = null;
  let helloWindowId = null;
  let windowId = null;

  // Whether this page is fitted beside the sidebar (content/shell.js) and
  // whether it could be: the theme offers "Show normally" / "Fit this site".
  function fitState() {
    const origin = /^https?:$/.test(location.protocol) ? location.origin : null;
    return { origin, fitted: !!Margin.shell, fittable: !!platform?.shell && !!origin && !frameAware(location.href) };
  }

  // A new tab being chosen in the palette (content/palette.js): the sidebar
  // highlights "+ New Tab", not this page's tab, until the palette closes.
  let newTabPending = false;
  Margin.content.setNewTabPending = (value) => {
    if (newTabPending === !!value) return;
    newTabPending = !!value;
    render();
  };

  // A switch to another tab from here (a click in the sidebar or the palette,
  // a next/previous key; shared/switching.js): the sidebar highlights it at
  // once, and the theme covers this page with an empty screen until the
  // switch lands (its own spinner); a theme without one shows the loading
  // pill if it takes a while. `cover`: 'now' (a click here), 'slow' (only
  // if it takes a while: a next/previous key, so a page a held key passes
  // through stays visible), 'none'.
  let switchingTo = null;
  let cover = 'now';
  const switching = createSwitching({
    onChange: (id) => {
      switchingTo = id;
      if (id == null || cover === 'now') view?.setCover?.(id != null, { instant: document.hidden });
      render();
    },
    onSlow: (slow) => {
      if (!view?.setCover) loader.switching(slow);
      else if (slow && cover === 'slow') view.setCover(true);
    },
  });
  const fromBackground = backgroundSwitches();
  // Back to this page's own tab: over. A tab in another window: nothing to
  // highlight here, and that window comes forward.
  Margin.content.startSwitching = (id, request = null, { cover: when = 'now' } = {}) => {
    if (!active()) return;
    if (id === tabId) return switching.end();
    if (state?.tabs?.[id]?.windowId !== windowId) return;
    cover = when;
    switching.start(id, request);
  };

  // ---- one sidebar for the window ---------------------------------------------
  // Every page draws its own sidebar; these keep them showing the same:
  // the state is read again whenever the page is shown (Safari suspends tabs
  // it isn't showing, and they miss storage events meanwhile; a page from
  // the back/forward cache missed them too), and the tab list's scroll
  // position is the window's (background/scroll.js), not each page's.
  let pendingScroll = null; // applied by the next render
  let scrollGen = 0; // bumped by every scroll of the user's: theirs wins over a late reply
  // Once `drawn` (the state read started with it) has rendered, so the
  // position isn't applied to the old, shorter list and clamped there.
  function restoreScroll(drawn) {
    const gen = scrollGen;
    Promise.all([send('sidebarScroll', {}, false), drawn]).then(([top]) => {
      if (!Number.isFinite(top) || gen !== scrollGen) return;
      pendingScroll = top;
      render();
    });
  }
  let scrollTimer = null;
  let scrollTop = 0;
  function saveScroll(top) {
    scrollGen++;
    scrollTop = top;
    scrollTimer ??= setTimeout(flushScroll, 150);
  }
  // Now: before a switch (the next page asks for it at once) and when the
  // page is left (its timers may not run once hidden).
  function flushScroll() {
    if (scrollTimer == null) return;
    clearTimeout(scrollTimer);
    scrollTimer = null;
    send('setSidebarScroll', { top: scrollTop }, false);
  }
  function shown() {
    restoreScroll(refresh());
    // Switched by keyboard or the browser's tab bar right after scrolling:
    // the page left saves its position as it's hidden, which can land just
    // after this one asked. Asked once more (not if the user scrolls here).
    setTimeout(() => restoreScroll(Promise.resolve()), 400);
    checkFullscreen();
    readZoom();
  }
  function left() {
    flushScroll();
    layout.leave();
  }
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? shown() : left()));
  addEventListener('pageshow', (event) => event.persisted && shown());
  addEventListener('pagehide', flushScroll);

  // What the theme sends. A switch made from the sidebar while it's open
  // over the page says how it was opened (the next page opens it the same
  // way: carry-open below), after saving the tab list's position.
  const SWITCHES = new Set(['activateTab', 'openPin', 'closeTab', 'setSpace']);
  /** @type {import('../../types/margin').Send} */
  const themeSend = (type, payload, ...rest) => {
    if (!SWITCHES.has(type)) return send(type, payload, ...rest);
    flushScroll();
    const how = layout.reason() === 'toggle' ? 'toggle' : 'hover';
    return send(type, /** @type {any} */ (payload)?.show ? { ...payload, show: how } : payload, ...rest);
  };
  // Opened here because the previous page's sidebar was open (background
  // carryOpen, or with hello): at once, without sliding in again. Before
  // Chrome's full-screen answer, kept until hello brings it.
  let carriedWhy = null;
  function carryOpen(why) {
    if (platform?.marginFullscreen && fullscreen === null) return void (carriedWhy = why);
    view?.instantOnce?.();
    layout.show(why === 'toggle' ? 'toggle' : 'hover');
  }

  function render() {
    if (!state || !view) return;
    if (fullscreenOnly() && fullscreen === null) return; // until the background says (above)
    // Known tab → its window. Until the background answers `hello`, guess, so
    // the sidebar draws straight from storage instead of waiting for it.
    windowId = state.tabs?.[tabId]?.windowId ?? helloWindowId ?? V.guessWindow(state, location.href);
    view.update(state, { windowId, tabId, fit: fitState(), newTabPending, switchingTo, ...(pendingScroll != null ? { scroll: pendingScroll } : {}) });
    pendingScroll = null;
    Margin.content.onState?.(state, { tabId, windowId });
    wasActive = active();
    layout.settle();
    trackpad.update();
    if (firstRender) {
      firstRender = false;
      loader.start(); // now its position (docked or not) is known
      // performance.now() counts from navigation start: how long the page
      // went without its sidebar (see TESTING.md).
      timing.rendered = Math.round(performance.now());
      view.ready(); // animations may run from now on
    }
  }

  // Storage reads can resolve out of order; only the latest one renders.
  let version = 0;
  async function refresh() {
    const mine = ++version;
    const next = await api.storage.local.get(null);
    timing.storage ??= Math.round(performance.now());
    if (mine !== version || !next.spaces?.length) return; // stale, or background not initialized yet
    state = next;
    if (!zoomAnswered) applyZoom(Number((next.pageZoom?.[location.origin] ?? next.pageZoom?.['*'])?.[0] ?? 1)); // drawn at its size from the start
    render();
    requestTheme(); // only if it isn't here by now
  }

  Margin.content.getState = () => ({ state, tabId, windowId });
  // Not while hidden: every open tab redrew its sidebar for every change
  // (a tab switch makes two), which costs CPU and battery for nothing
  // anyone sees. A hidden page catches up when it's shown (shown() above).
  // Until its first drawing, a page takes every change (one loaded in the
  // background before the background had any state waits for it).
  api.storage.onChanged.addListener((_, area) => area === 'local' && (!document.hidden || firstRender) && refresh());

  // One debug-level line per page (hidden unless the console shows Debug
  // messages), once it has loaded: where the time before the sidebar
  // went. All numbers are ms since navigation start. If "injected" is late,
  // Safari ran the content script late; if "storage" is late, the
  // storage.local read was slow; "rendered" is when the sidebar appeared.
  function logTiming() {
    const nav = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType?.('navigation')?.[0]);
    const fmt = (n) => (n == null ? '–' : `${Math.round(n)}`);
    console.debug(
      `[margin] timing (ms) injected=${fmt(timing.injected)} storage=${fmt(timing.storage)} rendered=${fmt(timing.rendered)}` +
        ` | page DOMContentLoaded=${fmt(nav?.domContentLoadedEventStart)} load=${fmt(nav?.loadEventStart)} keepOpen=${!!state?.settings?.sidebarPinnedOpen} fitted=${!!Margin.shell}`,
    );
  }
  if (document.readyState === 'complete') setTimeout(logTiming);
  else addEventListener('load', () => setTimeout(logTiming), { once: true });
  restoreScroll(refresh());
  send('hello').then((ctx) => {
    if (!ctx) return setFullscreen(false); // no background: as if in a window, until a resize asks again
    tabId = ctx.tabId;
    Margin.content.instanceId = ctx.instanceId; // see background.js injectIntoOpenTabs
    helloWindowId = ctx.windowId;
    fullscreen = ctx.fullscreen;
    render();
    const carry = ctx.carry ?? carriedWhy;
    carriedWhy = null;
    if (carry) carryOpen(carry);
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
  // Icons a page adds from script, in the fitted layout (the shell copies them).
  Margin.content.onCard((win) => win.addEventListener('load', () => setTimeout(reportIcon), { once: true }));

  api.runtime.onMessage.addListener((message, _, sendResponse) => {
    // Background (⌘T hand-off): open the palette here to choose a new tab, and
    // say whether it could (not before the theme is mounted, or while Margin
    // is out of the way; then the new-tab page opens its own instead).
    if (message?.type === 'show-palette') {
      const can = !!Margin.content.openPalette && active();
      if (can) Margin.content.openPalette({ newTab: true });
      return sendResponse(can);
    }
    // The background is switching from this tab to another (next/previous
    // tab): highlight it already (content/palette.js and the sidebar start
    // their own switches themselves).
    const forThisPage = message?.from == null || tabId == null || message.from === tabId;
    if (message?.type === 'switching') {
      if (forThisPage) Margin.content.startSwitching(message.tabId, fromBackground.begin(message.tabId), { cover: message.passing ? 'none' : 'slow' });
      return;
    }
    // That switch is done, or failed (the tab closed meanwhile).
    if (message?.type === 'switch-done' || message?.type === 'switch-failed') {
      if (forThisPage) fromBackground.settle(message);
      return;
    }
    // The hand-off didn't happen after all (its new tab stays).
    if (message?.type === 'hide-palette') return Margin.content.closePalette?.();
    // ⌘T seems to open Safari's homepage instead of Margin (background/newtab-hint.js):
    // only on a page opened from nothing (a link leaves a referrer), and
    // says whether it showed.
    if (message?.type === 'newtab-hint') {
      const fromNothing = !document.referrer && history.length === 1;
      if (!fromNothing || !view?.showNotice) return sendResponse(false);
      view.showNotice({
        text: 'If ⌘T opened this page: for Margin’s palette, choose Margin in Safari Settings → General → “New tabs open with”. Safari resets it when it turns Margin off.',
        actions: [
          { label: 'OK', run: () => {} },
          { label: 'Don’t show again', run: () => send('updateSettings', { patch: { newTabHint: false } }) },
        ],
        duration: 20000,
      });
      return sendResponse(true);
    }
    if (message?.type === 'windowState') return setFullscreen(!!message.fullscreen);
    if (message?.type !== 'command') return;
    if (message.command === 'toggle-sidebar') Margin.content.sidebar.toggle();
    else if (message.command === 'peek') Margin.content.peek?.();
    // Switched here from the sidebar while it was open over the page: open
    // here too (background handlers.js carryOpen).
    else if (message.command === 'carry-open') carryOpen(message.why);
    else Margin.content.onCommand?.(message.command);
  });
  mountTheme(); // if the theme's script ran first
  return true;
}
