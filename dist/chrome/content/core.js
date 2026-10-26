// Margin on web pages: everything it does there, whatever the theme. Renders
// from storage.local; when to show, dock, push the page, follow gestures and
// shortcuts is decided here. What it looks like is the active theme's
// (themes/<id>/content.js, a separate script that runs right after this
// one; see themes/register.js for what a theme provides).
import * as V from '../shared/view.js';
import { createHost } from '../shared/dom.js';
import * as shortcuts from '../shared/shortcuts.js';
import { platform } from '../shared/platform.js';
import { frameAware } from '../shared/shell-logic.js';
import { takeOver } from './takeover.js';
import { startTrackpad } from './trackpad.js';
import { startLoader } from './loader.js';
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
  /**
   * @template {MessageType} K
   * @param {K} type a handler in background.js
   * @param {Request<K>} [payload]
   * @param {boolean} [retry]
   * @returns {Promise<Result<K> | undefined>} undefined when it failed
   */
  async function send(type, payload = {}, retry = true) {
    try {
      const res = await api.runtime.sendMessage({ type, ...payload });
      if (res?.ok) return res.result;
      if (res) return void console.warn('[margin]', type, res.error);
    } catch (err) {
      if (!retry) return void console.warn('[margin]', type, err);
    }
    if (retry) {
      await new Promise((r) => setTimeout(r, 250));
      return send(type, payload, false);
    }
  }
  Margin.content.send = send;

  // ---- the theme -------------------------------------------------------------
  // What Margin looks like: the theme's view, mounted into the closed shadow
  // root. Nothing is drawn before it's mounted (usually at once: its script
  // runs right after this one).
  let theme = null;
  let view = null;
  let firstRender = true; // until the first render, nothing has been drawn
  // "+ New tab" opens the command palette here (content/palette.js sets openPalette).
  const onNewTab = () => (Margin.content.openPalette ? Margin.content.openPalette() : send('newTab', { windowId }));
  function mountTheme() {
    if (view || !Margin.theme) return;
    try {
      view = Margin.theme.mount({ shadow, document, send, onNewTab, onWidth: layout.onWidth });
      theme = Margin.theme;
    } catch (err) {
      return console.error('[margin] theme', Margin.theme.id, 'failed to start:', err);
    }
    applyColorScheme();
    onTheme?.(theme);
    if (state) render();
    layout.reopen(); // hovered or toggled before it was there
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
  const page = {
    api, host, send,
    onCard: Margin.content.onCard,
    view: () => view,
    theme: () => theme,
    state: () => state,
    setState: (next) => { state = next; },
    firstRender: () => firstRender,
  };
  const trackpad = startTrackpad(page, { replacing });
  const loader = startLoader(page, { pullRefreshing: trackpad.pullRefreshing });
  // ⌘⌥↓/↑ next/previous tab, ⌘⌥→/← next/previous space. Before the layout's
  // show/hide key: on a key both match, navigating wins (as it always has).
  shortcuts.installNavigation({ send, getSettings: () => state?.settings });
  Margin.content.onCard((win) => shortcuts.installNavigation({ send, getSettings: () => state?.settings, target: win }));
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

  function render() {
    if (!state || !view) return;
    // Known tab → its window. Until the background answers `hello`, guess, so
    // the sidebar draws straight from storage instead of waiting for it.
    windowId = state.tabs?.[tabId]?.windowId ?? helloWindowId ?? V.guessWindow(state, location.href);
    view.update(state, { windowId, tabId, fit: fitState() });
    Margin.content.onState?.(state, { tabId, windowId });
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
    render();
    requestTheme(); // only if it isn't here by now
  }

  Margin.content.getState = () => ({ state, tabId, windowId });
  api.storage.onChanged.addListener((_, area) => area === 'local' && refresh());

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
  refresh();
  send('hello').then((ctx) => {
    if (!ctx) return;
    tabId = ctx.tabId;
    Margin.content.instanceId = ctx.instanceId; // see background.js injectIntoOpenTabs
    helloWindowId = ctx.windowId;
    render();
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
    // Background (⌘T hand-off): can Margin open its palette here? Not until
    // the theme is mounted (then the new-tab page opens its own instead).
    if (message?.type === 'ping') return sendResponse(Margin.content.openPalette ? 'pong' : 'starting');
    if (message?.type !== 'command') return;
    if (message.command === 'toggle-sidebar') Margin.content.sidebar.toggle();
    else if (message.command === 'peek') Margin.content.peek?.();
    else Margin.content.onCommand?.(message.command);
  });
  mountTheme(); // if the theme's script ran first
  return true;
}
