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
import { createReadiness } from './ready.js';
import { fromStorage, openTabsCurrent, withChanges } from '../shared/stored.js';
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
  const takeover = takeOver(api);
  // An earlier copy's sidebar is (or, once this copy owns the state, turns
  // out to be) in the page: its gestures stay its own, and the page is
  // cleaned up by a reload when that's safe (content/takeover.js).
  let replacing = takeover.replacing;
  // Another copy's sidebar this one hid on taking over (`ownerSeen`): a copy
  // from this protocol on, which stands back itself (its gestures too, so
  // this copy keeps its own), but its fitted layout stays until a reload.
  let takenOver = false;
  // This copy's address: the stored tabs say whether they're this copy's
  // (shared/stored.js). A copy a newer one replaced stays out of the way
  // (`dormant`, below), and so does one whose sidebar another copy hid
  // (`retired`: this one was replaced, or its Margin unloaded).
  const origin = api.runtime.getURL('');
  let dormant = false;

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
  const retired = () => dormant || host.style.getPropertyValue('display') === 'none';

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
  // A switch usually lands at once (the background answers in well under a
  // second, waking a tab at most 0.4s), but a background just starting first
  // matches the open tabs (background.js firstSync): a switch waits that
  // long, covered (shared/switching.js), before it's given up and said so;
  // anything else gets a cold start's time.
  const NO_ANSWER = 'no answer';
  /** @type {Record<string, number>} */
  const SEND_TIMEOUT_MS = { activateTab: 7000, openPin: 7000, setSpace: 7000, default: 8000 };
  // Why the last switch request failed, if it did (a switch says so: below).
  const SWITCH_REQUESTS = new Set(['activateTab', 'openPin', 'setSpace']);
  let switchError = null;
  let helloAnswered = false; // this page's background has said which tab it is
  let switchAskedAt = 0; // when this page last asked for a switch (render: justShown)
  const failedSwitch = (type, why) => { if (SWITCH_REQUESTS.has(type)) switchError = why; };
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
    // A switch to a tab also says the tab's address and place, so the
    // background finds it even if its id is from before (background/tabs.js
    // resolveTab).
    // So does any request naming a tab (closing, moving, pinning it), with
    // whose ids this page drew: the background then trusts the id only if
    // they're its own, and refuses rather than act on another tab.
    // Not for this page's own tab as its background named it (hello): that
    // id is this copy's already, whoever's ids the stored tabs are.
    const ownTab = helloAnswered && (/** @type {any} */ (payload)).tabId === tabId;
    if (Number.isInteger((/** @type {any} */ (payload)).tabId) && !(/** @type {any} */ (payload)).hint && type !== 'prewake' && !ownTab) {
      const tab = state?.tabs?.[/** @type {any} */ (payload).tabId];
      if (tab) payload = /** @type {any} */ ({ ...payload, hint: { url: tab.url, index: tab.index, title: tab.title, from: /** @type {any} */ (state)?.openTabsBy ?? null } });
    }
    // And when this page stops waiting for it: the background doesn't switch
    // after that (a switch that lands after its page said it didn't). Asked
    // again (retry), it keeps its first deadline, and waits only till then.
    if (SWITCH_REQUESTS.has(type)) switchAskedAt = Date.now();
    const deadline = (/** @type {any} */ (payload)).deadline;
    if (SWITCH_REQUESTS.has(type) && !Number.isFinite(deadline)) payload = /** @type {any} */ ({ ...payload, deadline: Date.now() + SEND_TIMEOUT_MS[type] });
    const waitMs = Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : (SEND_TIMEOUT_MS[type] ?? SEND_TIMEOUT_MS.default);
    failedSwitch(type, null);
    let timer;
    let reply;
    try {
      // Never waited on forever: in WebKit a copy left from before Margin
      // was updated sends into nothing, and the message neither arrives nor
      // fails (a switch then hung, highlighted, until it gave up).
      reply = api.runtime.sendMessage({ type, ...payload });
      const res = await Promise.race([
        reply,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(NO_ANSWER)), waitMs); }),
      ]);
      if (res?.ok) return res.result;
      if (res?.stale) return void standDown();
      if (res) {
        failedSwitch(type, String(res.error ?? ''));
        return void console.warn('[margin]', type, res.error);
      }
    } catch (err) {
      if (err?.message === NO_ANSWER) {
        failedSwitch(type, NO_ANSWER);
        return void noAnswer(type, reply);
      }
      if (!retry) {
        failedSwitch(type, String(err?.message ?? err));
        return void console.warn('[margin]', type, err);
      }
    } finally {
      clearTimeout(timer);
    }
    if (retry) {
      await new Promise((r) => setTimeout(r, 250));
      const until = (/** @type {any} */ (payload)).deadline;
      // No time left for a switch: it didn't happen.
      if (Number.isFinite(until) && until - Date.now() < 500) return void failedSwitch(type, 'Too late');
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
  // Up until it's answered, or it goes by itself (`duration`).
  let noticeTimer = null;
  const RELOAD_NOTICE_MS = 20000;
  function offerReload(text) {
    toldNoAnswer = true;
    noticeUp = true;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { noticeUp = false; }, RELOAD_NOTICE_MS);
    view?.showNotice?.({
      text,
      // Loaded again with a GET (a reload could send a form again).
      // (A URL with a #fragment would only scroll: reloaded then.)
      actions: [{ label: 'Reload', run: () => (location.href.includes('#') ? location.reload() : location.replace(location.href)) }, { label: 'Not now', run: () => { noticeUp = false; } }],
      duration: RELOAD_NOTICE_MS,
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
    if (readiness.shown()) view.setStartup?.(true); // getting ready before it was there
    offerFittedReload();
  }
  // Taking over from a copy left from before Margin was updated, on a page
  // that copy fitted beside the sidebar: its layout (and the page's keys and
  // gestures in it) stay with the old copy until the page loads again
  // (content/takeover.js does that once it's hidden; offered when it's on
  // screen too, a few times at most).
  let fittedOffers = 0;
  function offerFittedReload() {
    if (!(replacing || takenOver) || !view || document.hidden || fittedOffers >= 3 || !document.documentElement.hasAttribute('data-margin-shell')) return;
    fittedOffers++;
    offerReload('Margin was updated. Reload this page to fit it beside the sidebar again.');
    // Not taken for "Margin isn't responding" told already (noAnswer).
    toldNoAnswer = false;
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
  const active = () => !retired() && (!fullscreenOnly() || fullscreen === true);
  let lastOffer = 0;
  function offerFullscreen() {
    if (retired() || !fullscreenOnly() || fullscreen === null || Date.now() - lastOffer < 1500) return;
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
    dormant: retired,
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
  const loader = startLoader(page, { pullRefreshing: trackpad.pullRefreshing });
  // ⌘⌥↓/↑ next/previous tab, ⌘⌥→/← next/previous space. Before the layout's
  // show/hide key: on a key both match, navigating wins (as it always has).
  const navSettings = () => (active() ? state?.settings : null); // none while Margin is out of the way
  // The sidebar's scroll position goes first (the next page is prepared with it).
  const navSend = /** @type {typeof send} */ ((type, payload, ...rest) => {
    if (type === 'navigate') {
      flushScroll();
      switchAskedAt = Date.now();
    }
    return send(type, payload, ...rest);
  });
  shortcuts.installNavigation({ send: navSend, getSettings: navSettings });
  Margin.content.onCard((win) => shortcuts.installNavigation({ send: navSend, getSettings: navSettings, target: win }));
  // Going in or out of full screen: Margin shows up, or gets out of the way.
  // The background tells the window's pages; a resize, or coming back to a
  // tab (moved to another window meanwhile), asks again.
  let wasActive = null;
  function setFullscreen(value) {
    fullscreen = value;
    if (active() === wasActive) return;
    if (active()) {
      view?.showNotice?.(null);
      noticeUp = false;
    }
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
  // A switch that didn't happen says why (the highlight goes back at once):
  // the tab is gone (the sidebar is drawn again from the state), or Margin
  // didn't answer (that notice comes later, if it still doesn't: noAnswer).
  // Switch requests answer what they showed ({ shown }); `undefined` is a
  // failed request (send).
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
    failed: (result) => result === undefined,
    onFailed: () => {
      const why = switchError;
      void refresh();
      if (!why || dormant || noticeUp) return;
      const text = /no longer open|No tab with id/i.test(why) ? 'That tab is no longer open.'
        : why === NO_ANSWER ? 'Margin didn’t answer, so the tab didn’t switch. Try again.'
        : 'Margin couldn’t show that tab. Try again.';
      view?.showNotice?.({ text, duration: 4000 });
    },
  });
  const fromBackground = backgroundSwitches();

  // ---- getting ready, and standing back -----------------------------------------
  // Until this copy owns the state and has matched the open tabs (after Safari
  // starts, or Margin is updated), the stored tabs are another copy's: the
  // theme's startup cover, if that takes a moment (content/ready.js). Its
  // background says whether a newer copy runs (`hello`, and `owner` when
  // another copy has claimed the state since): this one then stands back.
  // Over a page just loaded or shown, or where Margin just started; not over
  // one in use when Margin is updated (its sidebar still works meanwhile).
  let lastShownAt = document.hidden ? 0 : Date.now();
  const JUST_SHOWN_MS = 2000;
  // Before the readiness's own listener (below), so it sees the page as just shown.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) lastShownAt = Date.now(); });
  const coverable = () => performance.now() < 5000 || Date.now() - lastShownAt < 2000 || (!takeover.others && Date.now() - Margin.content.startedAt < 3000);
  const readiness = createReadiness({
    allowed: coverable,
    show: (on) => {
      if (on) switching.end();
      if (view?.setStartup) view.setStartup(on);
      else view?.setCover?.(on, { instant: !on && document.hidden });
      host.dataset.startup = String(on); // test/debug hook
      console.debug(`[margin] getting ready: cover ${on ? 'shown' : 'gone'}`);
    },
  });
  let storedOwner = null;
  let waitedSince = 0;
  let mySince = null; // this copy's start, from hello
  const READY_GIVE_UP_MS = 20000;
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
    // Not on a copy that started long ago (it would have matched them by now:
    // its sync failed, say): Margin then works with what it has, and a page
    // shown isn't covered each time.
    const startedLongAgo = Number.isFinite(mySince) && Date.now() - mySince > READY_GIVE_UP_MS;
    readiness.wait(!dormant && !isCurrent && !startedLongAgo);
    // Another copy claimed the state since this page started: is this copy
    // the older one (then it stands back), or will it claim it again?
    if (helloAnswered && storedOwner && storedOwner.origin !== origin && before?.origin !== storedOwner.origin) void send('owner');
    // In charge here: copies a newer one replaced, or unloaded, show nothing
    // (they stand back themselves, if they still run). This copy's own (the
    // sidebar, the palette) are marked in its world (shared/dom.js createHost).
    // Hidden by another copy before this one took over: shown again.
    if (isCurrent && !dormant) {
      let others = false;
      for (const node of /** @type {HTMLElement[]} */ ([...(document.documentElement?.children ?? [])])) {
        if (!/^margin-.*-host$/.test(node.localName)) continue;
        if ((/** @type {any} */ (node)).__marginCopy) node.style.removeProperty('display');
        else {
          node.style.setProperty('display', 'none', 'important');
          others = true;
        }
      }
      if (others && !takenOver) {
        takenOver = true;
        takeover.arm();
        offerFittedReload();
      }
    }
  }
  // Out of the way: no sidebar, keys or gestures. A page on screen says why
  // first (Safari runs both copies until it quits; this page can only reach
  // the older one), then its Margin goes.
  function standDown() {
    if (dormant) return;
    dormant = true;
    console.info('[margin] a newer copy of Margin runs here: this one stays out of the way');
    readiness.wait(false);
    switching.end();
    render();
    const hide = () => host.style.setProperty('display', 'none', 'important');
    if (document.hidden || !view?.showNotice) return hide();
    view.showNotice({ text: 'Margin was updated while Safari was open. Quit and reopen Safari to finish updating it.', actions: [{ label: 'OK', run: hide }], duration: 15000 });
    setTimeout(hide, 15500);
  }
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
  // A hidden destination prepared by the background before Safari activates
  // it. Its sidebar is already current, scrolled and open the same way as the
  // source; the first visibilitychange must not replace that prepared frame
  // with another asynchronous storage/scroll round trip.
  /** @type {{ token: string, at: number, carry: 'hover' | 'toggle' | null } | null} */
  let preparedShow = null;
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
    lastShownAt = Date.now();
    offerFittedReload();
    const prepared = preparedShow;
    preparedShow = null;
    // Prepared for this switch (it can land up to its deadline later; an
    // older preparation is one that never landed).
    const fresh = prepared && Date.now() - prepared.at < 7500;
    if (fresh) {
      // onActivated writes the authoritative active tab/space just after the
      // browser switch. storage.onChanged normally brings it in; this is only
      // a fallback when that event is late or absent.
      const atVersion = version;
      setTimeout(() => document.visibilityState === 'visible' && version === atVersion && refresh(), 250);
      // A key switch right after scrolling: the page left saves its position
      // as it's hidden, after this one was prepared with the one before.
      // Asked once more (not if the user scrolls here).
      setTimeout(() => restoreScroll(Promise.resolve()), 400);
    } else {
      if (prepared?.carry) layout.hide(); // a prepared switch that never landed
      // Drawn at once from what changed while hidden (below), before storage
      // is read again: a page Safari brings to the front itself (its tab bar,
      // closing the tab in front) shows the right rows from its first frame.
      if (changedWhileHidden && state) render();
      changedWhileHidden = false;
      restoreScroll(refresh());
      // Switched by keyboard or Safari's tab bar right after scrolling: the
      // page left saves its position as it is hidden, which can land just
      // after this one asked. Asked once more (not if the user scrolls here).
      setTimeout(() => restoreScroll(Promise.resolve()), 400);
    }
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
    const sidebarTop = scrollTimer == null ? null : scrollTop;
    flushScroll();
    const how = layout.reason() === 'toggle' ? 'toggle' : 'hover';
    const message = {
      .../** @type {any} */ (payload),
      ...((/** @type {any} */ (payload))?.show ? { show: how } : {}),
      ...(Number.isFinite(sidebarTop) ? { sidebarTop } : {}),
    };
    return send(type, message, ...rest);
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
    // Just shown (or started): its own tab's space while the state catches up
    // (shared/view.js). Not once a switch was asked for from here (a swipe to
    // another space: the window's space is then the one it went to).
    const justShown = (firstRender || Date.now() - lastShownAt < JUST_SHOWN_MS) && switchAskedAt <= lastShownAt;
    view.update(state, { windowId, tabId, fit: fitState(), newTabPending, switchingTo, justShown, ...(pendingScroll != null ? { scroll: pendingScroll } : {}) });
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
  // Before a programmatic switch, the destination's storage still names the
  // source tab/space as active. Its own tab id is authoritative for the row
  // highlight (shared/view.js); this small local override also makes the
  // destination's space visible before tabs.onActivated catches storage up.
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
  async function refresh(show = null) {
    const mine = ++version;
    const next = fromStorage(await api.storage.local.get(null));
    if (mine === version) ownerSeen(next.owner, next.openTabsBy);
    timing.storage ??= Math.round(performance.now());
    if (mine !== version || !next.spaces?.length) return false; // stale, or background not initialized yet
    // Brought to the front without preparation (a tab Safari restores as it's
    // shown): until `hello` says which tab this is, the background's note does
    // (background/tabs.js noteShowing), with how the page before had the
    // sidebar, so the first frame is already right.
    const noted = tabId == null && !dormant ? notedShowing(next.showing) : null;
    if (noted) {
      adoptedNote = noted;
      tabId = noted.tabId;
      helloWindowId = noted.windowId;
      if (firstRender && Number.isFinite(noted.scroll)) pendingScroll = noted.scroll;
      console.debug(`[margin] drawn as tab ${noted.tabId}, the one being shown (before hello)`);
    }
    state = stateForShow(next, show ?? (noted ? { tabId: noted.tabId, windowId: noted.windowId } : null));
    if (!zoomAnswered) applyZoom(Number((next.pageZoom?.[location.origin] ?? next.pageZoom?.['*'])?.[0] ?? 1)); // drawn at its size from the start
    render();
    if (noted?.carry && !carriedNoted) {
      carriedNoted = true;
      carryOpen(noted.carry);
    }
    if (noted && !coveredWhileLoading) coverWhileLoading();
    requestTheme(); // only if it isn't here by now
    return true;
  }
  let carriedNoted = false;
  let adoptedNote = null; // until hello confirms it (or not)
  /** @type {(() => void) | null} */
  let uncoverLoading = null;
  // A tab Safari loads as it's shown, brought to the front by Margin: the
  // switch's cover stays over the page (its spinner already turning, as on
  // the page before) until the page has loaded, at most COVER_LOADING_MS
  // (then it shows as far as it got), so the switch reads as one wait rather
  // than a page building up.
  const COVER_LOADING_MS = 2500;
  let coveredWhileLoading = false;
  function coverWhileLoading() {
    coveredWhileLoading = true;
    const complete = () => (Margin.shell ? Margin.shell.card?.document.readyState === 'complete' : document.readyState === 'complete');
    if (!view?.setCover || document.hidden || complete()) return;
    view.setCover(true, { instant: true, spinnerNow: true });
    host.dataset.loadingCover = 'true'; // test/debug hook
    let done = false;
    const off = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Not if a switch from here has taken the cover over meanwhile.
      if (switchingTo == null) view?.setCover?.(false, { instant: document.hidden });
      host.dataset.loadingCover = 'false';
    };
    const timer = setTimeout(off, COVER_LOADING_MS);
    uncoverLoading = off;
    // The fitted layout's top document is complete long before its card.
    if (!Margin.shell) addEventListener('load', off, { once: true });
    Margin.content.onCard((win) => (win.document.readyState === 'complete' ? off() : win.addEventListener('load', off, { once: true })));
    document.addEventListener('visibilitychange', () => document.hidden && off(), { once: true });
  }
  const SHOWING_MS = 10000;
  const sameDocument = (a, b) => String(a ?? '').split('#')[0] === String(b ?? '').split('#')[0];
  // Only for a page that started as the note was written: the tab Safari
  // loads as Margin brings it to the front (whatever kind of load that is:
  // a restore, or a reload of a page whose process Safari discarded), not a
  // page reloaded by hand a few seconds later.
  const startedWith = (at) => performance.timeOrigin - at > -1000 && performance.timeOrigin - at < 3000;
  function notedShowing(showing) {
    if (!showing || !startedWith(showing.at) || !Number.isInteger(showing.tabId) || Date.now() - showing.at > SHOWING_MS || document.hidden) return null;
    return sameDocument(showing.url, location.href) ? showing : null;
  }

  // Called through scripting.executeScript in the current isolated extension
  // world (background/tabs.js), not tabs.sendMessage: Safari can leave an old
  // content-script listener behind after an update. Everything necessary for
  // the destination's first frame is committed before this promise answers.
  /** @param {{ token?: string, tabId?: number, windowId?: number, scroll?: number, carry?: 'hover' | 'toggle' | null }} [context] */
  Margin.content.prepareForShow = async ({ token, tabId: targetId, windowId: targetWindow, scroll, carry } = {}) => {
    if (!token || !Number.isInteger(targetId) || targetWindow == null) return { ready: false, reason: 'bad context' };
    // A newer preparation owns this hidden page. Undo only the transient open
    // state from the older one; ordinary Keep open is restored by hide().
    if (preparedShow?.carry) layout.hide();
    preparedShow = { token, at: Date.now(), carry: null };
    tabId = targetId;
    helloWindowId = targetWindow;
    switching.end();
    newTabPending = false;
    if (Number.isFinite(scroll)) pendingScroll = Math.max(0, scroll);
    const rendered = await refresh({ tabId: targetId, windowId: targetWindow });
    if (preparedShow?.token !== token) return { ready: false, reason: 'superseded' };
    if (!rendered || !state || !view || windowId !== targetWindow) {
      preparedShow = null;
      return { ready: false, reason: !view ? 'theme not ready' : 'state not ready' };
    }
    if (carry === 'hover' || carry === 'toggle') {
      view.instantOnce?.();
      layout.show(carry);
      preparedShow.carry = carry;
    }
    // Force style/layout in this WebProcess before the executeScript result
    // crosses back to Safari's UI process. Hidden pages do not reliably run
    // requestAnimationFrame, so an animation-frame acknowledgement would hang.
    host.getBoundingClientRect();
    return { ready: true, token };
  };
  Margin.content.cancelPreparedShow = (token) => {
    if (!preparedShow || preparedShow.token !== token) return false;
    const { carry } = preparedShow;
    preparedShow = null;
    if (carry && document.visibilityState !== 'visible') layout.hide();
    void refresh();
    return true;
  };

  Margin.content.getState = () => ({ state, tabId, windowId });
  // Not while hidden: every open tab redrew its sidebar for every change
  // (a tab switch makes two), which costs CPU and battery for nothing
  // anyone sees. A hidden page catches up when it's shown (shown() above).
  // Until its first drawing, a page takes every change (one loaded in the
  // background before the background had any state waits for it).
  // The background's note of a tab being shown is for that tab's page only.
  const onlyShowing = (changes) => Object.keys(changes).every((key) => key === 'showing');
  // Hidden, a page keeps its state current from the change events (they
  // carry the values) without drawing it: shown() draws it at once.
  let changedWhileHidden = false;
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || dormant || (!firstRender && onlyShowing(changes))) return;
    if (!document.hidden || firstRender || !state) return void refresh();
    const next = withChanges(state, changes);
    state = next;
    changedWhileHidden = true;
    if ('owner' in changes || 'openTabs' in changes) ownerSeen(next.owner, next.openTabsBy);
  });

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
    if (dormant) return;
    if (!ctx) return setFullscreen(false); // no background: as if in a window, until a resize asks again
    helloAnswered = true;
    // The background's note named another tab with this address: undone,
    // and drawn again from storage as this tab (its space, not the noted one's).
    const wrongNote = adoptedNote && adoptedNote.tabId !== ctx.tabId;
    if (wrongNote) {
      if (carriedNoted && !ctx.carry) layout.hide();
      uncoverLoading?.();
    }
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
      if (forThisPage) {
        switchError = null; // not an earlier click's
        Margin.content.startSwitching(message.tabId, fromBackground.begin(message.tabId), { cover: message.passing ? 'none' : 'slow' });
      }
      return;
    }
    // That switch is done, or failed (the tab closed meanwhile).
    if (message?.type === 'switch-done' || message?.type === 'switch-failed') {
      if (forThisPage) {
        if (message.type === 'switch-failed') switchError = message.reason ?? null;
        fromBackground.settle(message);
      }
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
