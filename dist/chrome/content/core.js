// Margin on web pages: everything it does there, whatever the theme. Reads
// the state from storage.local and draws it with Margin's UI runtime
// (ui/runtime.js, through the in-page host: ui/host.js) in a closed shadow
// root, with the active theme's package (HTML and CSS only), which the
// background hands over (background/theme-package.js). Where the page goes
// is the theme's page slot (content/layout.js); following gestures and
// shortcuts, and getting ready, are decided here. On the Mac this is a
// development host until Margin.app draws the UI (PLAN.md §1).
import * as V from '../shared/view.js';
import { createRuntime } from '../ui/runtime.js';
import { createInPageHost } from '../ui/host.js';
import { loadTheme } from '../ui/theme-loader.js';
import { asBrowserUi, createHost, hideHost, mark, marginHosts, mountHost, setPageZoom, showHost } from '../shared/dom.js';
import * as shortcuts from '../shared/shortcuts.js';
import { asksBackground, madeAfresh as madeAfreshNavigation, platform } from '../shared/platform.js';
import { watchAway } from '../shared/away.js';
import { copyAlive, mayNotice } from '../shared/no-answer.js';
import { listenForHolds } from './hold.js';
import { watchEdits } from './edits.js';
import { takeOver } from './takeover.js';
import { startTrackpad } from './trackpad.js';
import { startLoader } from './loader.js';
import { startPageLink } from './page-link.js';
import { startPinch } from './pinch.js';
import { createSwitching, backgroundSwitches, NEW_TAB, SWITCH_GRACE_MS } from '../shared/switching.js';
import { startLayout } from './layout.js';
import { createReadiness } from './ready.js';
import { createIdleWatch } from './idle.js';
import { readyInPage } from '../shared/page-ready.js';
import { STATE_REV, fromStorage, knowsState, onlyMark, openTabsCurrent, readForPage, revAfter, revOf, takesChanges, withChanges } from '../shared/stored.js';
import { APP_LINK_KEY, appDraws, boxFromLayout, layoutFor } from '../shared/app-link.js';
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
  // Keep-ready's holds (content/hold.js), from the start: a tab left is held
  // at once. `holding()`: how many run (the WebKit host counts them).
  if (platform?.keepTabsReady) Margin.content.holding = listenForHolds(api);
  // What the user typed here and hasn't sent: a tab with a draft isn't put to
  // sleep (background/sleep.js asks: content/edits.js).
  if (platform?.sleepTabs) Margin.content.edits = watchEdits();
  // An earlier copy of Margin's sidebar in the page: take over from it.
  const takeover = takeOver(api);
  // An earlier copy's sidebar is (or, once this copy owns the state, turns
  // out to be) in the page: its gestures stay its own, and the page is
  // cleaned up by a reload when that's safe (content/takeover.js).
  let replacing = takeover.replacing;
  // Another copy's sidebar this one hid on taking over (`ownerSeen`): a copy
  // from this protocol on, which stands back itself (its gestures too, so
  // this copy keeps its own), but a page it fitted stays so until a reload.
  let takenOver = false;
  // This copy's address: the stored tabs say whether they're this copy's
  // (shared/stored.js). A copy a newer one replaced stays out of the way
  // (`dormant`, below), and so does one whose sidebar another copy hid
  // (`retired`: this one was replaced, or its Margin unloaded).
  const origin = api.runtime.getURL('');
  let dormant = false;

  const { host, shadow } = createHost(document, 'margin-sidebar-host', { fill: true });
  const retired = () => dormant || host.style.getPropertyValue('display') === 'none';

  // ---- Margin.app ---------------------------------------------------------------
  // While Margin.app is linked (or reconnecting: shared/app-link.js), it draws
  // all of Margin's UI around this window: the page draws none (no runtime,
  // no shadow host in the document), and keeps only its box, from the app's
  // layout for its window, its gestures, pinch, the draft check and the keys.
  // Not linked, the in-page development host draws as before. Known from
  // storage (appLink, in the page's first read), then from the background
  // (hello, its `appLayout` messages, appLink's change events).
  /** @type {any} */
  let appLink; // undefined until the first read
  const appUi = () => appDraws(appLink);
  // The host goes into the page only once it's known the page draws Margin.
  const wantHost = () => appLink !== undefined && !appUi();

  // Some pages replace <html>'s children; put the host back if it's removed.
  const attach = () => {
    if (!wantHost()) {
      if (host.isConnected) host.remove();
      return;
    }
    if (!host.isConnected) mountHost(host);
    if (host.parentNode) observer.observe(host.parentNode, { childList: true }); // <margin-app>: the host taken out of it
  };
  const observer = new MutationObserver(attach);
  attach();
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
  // A new tab from the palette answers once it's in front, after its page has
  // loaded (background/tabs.js openBehind).
  const SEND_TIMEOUT_MS = { activateTab: 7000, openPin: 7000, setSpace: 7000, newTab: 12000, search: 12000, default: 8000 };
  // Why the last switch request failed, if it did (a switch says so: below).
  const SWITCH_REQUESTS = new Set(['activateTab', 'openPin', 'setSpace']);
  // These, and a new tab from the palette, say when this page stops waiting.
  const TIMED_REQUESTS = new Set([...SWITCH_REQUESTS, 'newTab', 'search']);
  // A switch waits SWITCH_GRACE_MS past that for the answer (`waitsUntil`):
  // the background plans the switch to the deadline, and answers by it, but
  // on a Mac that busy (after a reboot, 2026-11-03) its timers fired seconds
  // late, and a tab it showed came 0.3 s after this page had said it didn't
  // switch. A click must switch: a switch asked for late is still shown then,
  // at once (background/tabs.js focusTab). Not a new tab: one is opened only
  // before the deadline (background/tabs.js tooLate), so waiting past it
  // gains nothing.
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
    // copy replaced. Nor a request this browser has no use for (platform.js
    // asksBackground: a wake ahead of a switch in Chrome).
    if (!api.runtime?.id || dormant || !asksBackground(type)) return;
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
    if (TIMED_REQUESTS.has(type) && !Number.isFinite((/** @type {any} */ (payload)).deadline)) {
      const deadline = Date.now() + SEND_TIMEOUT_MS[type];
      payload = /** @type {any} */ ({ ...payload, deadline, ...(SWITCH_REQUESTS.has(type) ? { waitsUntil: deadline + SWITCH_GRACE_MS } : {}) });
    }
    const until = (/** @type {any} */ (payload)).waitsUntil ?? (/** @type {any} */ (payload)).deadline;
    const waitMs = Number.isFinite(until) ? Math.max(0, until - Date.now()) : (SEND_TIMEOUT_MS[type] ?? SEND_TIMEOUT_MS.default);
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
      // No time left for a switch: it didn't happen.
      if (Number.isFinite(until) && until - Date.now() < 500) return void failedSwitch(type, 'Too late');
      return send(type, payload, false);
    }
  }
  Margin.content.send = send;
  // The background didn't answer this page in time: the request is given up
  // (a switch stops waiting), and if there's still no answer after
  // STALE_MS (a slow cold start answers well before; a switch is answered
  // before its deadline however slow: background.js), the page is the one
  // in front with Margin on it, and this copy of Margin is found gone (not
  // only slow: shared/no-answer.js), the page says how to fix it (once), and
  // takes that back if the answer comes after all. Not for a request nobody
  // waits on. The background also puts the current copy into a tab brought
  // to the front (background/tabs.js ensureCurrent), so this is the rare
  // case left.
  const STALE_MS = 8000;
  let toldNoAnswer = false;
  let noticeUp = false;
  function noAnswer(type, reply) {
    console.warn('[margin]', type, 'no answer from the background (yet)');
    if (!mayNotice(type)) return; // (shared/no-answer.js)
    let answered = false;
    reply?.then(() => {
      answered = true;
      if (noticeUp) {
        noticeUp = false;
        toldNoAnswer = false;
        view?.showNotice?.(null);
      }
    }, () => {});
    const shown = () => !answered && !toldNoAnswer && !document.hidden && !!view?.showNotice && active();
    setTimeout(async () => {
      if (!shown()) return;
      if (await copyAlive(api)) return void console.warn('[margin]', type, 'still unanswered, but this copy of Margin is alive: its background is slow');
      if (!shown()) return;
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

  // ---- the UI ------------------------------------------------------------------
  // What Margin looks like: the active theme's package, drawn by the UI
  // runtime in the closed shadow root (the host fills the window: shared/
  // dom.js createHost `fill`). The package comes from the background (a
  // message: nothing here loads an extension URL), is checked as any
  // package is (ui/theme-loader.js), and nothing is drawn before it's there.
  // A change of theme (Settings) draws the new one in place.
  /** @type {any} */
  let runtime = null;
  /** @type {any} */
  let view = null; // what the rest of this file draws through (uiView, below)
  let firstRender = true; // until the first render, nothing has been drawn
  let themeId = null; // the theme drawn
  // The state as the UI's host gets it: this page's (refresh, change events,
  // a show's preparation), handed over as it's drawn (render).
  const uiSource = {
    listeners: new Set(),
    getState: () => state,
    onState(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); },
    emit() { for (const cb of [...this.listeners]) cb(state); },
  };
  // A switch asked for from the sidebar while it's out over the page says
  // how it was opened (the next page opens it the same way: carry-open).
  const SWITCHES = new Set(['activateTab', 'openPin', 'closeTab', 'setSpace']);
  const uiSend = (type, payload = {}) => {
    const message = SWITCHES.has(type) && payload?.show ? { ...payload, show: layout.reason() === 'toggle' ? 'toggle' : 'hover' } : payload;
    return Promise.resolve(send(/** @type {any} */ (type), message));
  };
  // Margin's notices (the runtime's `notice` part): what each button runs
  // stays here, the theme shows its words.
  /** @type {Map<string, Record<string, () => void>>} */
  const noticeRuns = new Map();
  let noticeSeq = 0;
  let noticeTimer2 = null;
  function showNotice(notice) {
    clearTimeout(noticeTimer2);
    noticeRuns.clear();
    if (!runtime) return;
    if (!notice) return void runtime.setUi({ notice: null });
    const id = `n${++noticeSeq}`;
    const actions = (notice.actions ?? []).map((a, i) => ({ id: `a${i}`, label: a.label, primary: i === 0 }));
    noticeRuns.set(id, Object.fromEntries((notice.actions ?? []).map((a, i) => [`a${i}`, a.run])));
    runtime.setUi({ notice: { id, text: notice.text, actions } });
    if (notice.duration) noticeTimer2 = setTimeout(() => { if (runtime?.ui.notice?.id === id) runtime.setUi({ notice: null }); }, notice.duration);
  }
  // Made with the first UI (it reads the state, declared below).
  /** @type {any} */
  let uiHost = null;
  const makeUiHost = () => createInPageHost({
    api,
    window,
    platform: { browser: platform?.name ?? 'unknown', os: 'mac', marginFullscreen: !!platform?.marginFullscreen },
    mode: 'inpage',
    source: uiSource,
    send: uiSend,
    perform: (name, arg) => {
      if (name === 'notice') {
        const run = noticeRuns.get(arg?.id)?.[arg?.action];
        noticeRuns.delete(arg?.id);
        clearTimeout(noticeTimer2);
        run?.();
        return true;
      }
      if (name === 'prompt') return true; // no prompts on web pages yet
      if (name === 'navigate') return false; // an address from the palette opens a new tab here
      return undefined;
    },
    onLayout: (geometry) => layout.apply(geometry),
  });
  // What the rest of this file draws through.
  const uiView = {
    update(next, { windowId: w, tabId: t }) {
      if (uiHost && (uiHost.windowId !== w || uiHost.tabId !== t)) uiHost.identify({ tabId: t, windowId: w });
      uiSource.emit();
    },
    showNotice,
    setColorScheme() {}, // the theme follows the system (prefers-color-scheme)
    ready() {},
    instantOnce() {},
    isBusy: () => !!runtime?.busy(),
    setLoading: (on) => runtime?.setUi({ pageLoading: !!on }),
    setPull() {}, // no pull or swipe badges in Margin 2's themes yet
    setSwipe() {},
    // Out of the way (Chrome outside full screen, a copy that stood back):
    // only notices and prompts show (ui/render.js m-away).
    setAway(on) { runtime?.view.rootElement()?.toggleAttribute('m-away', !!on); },
  };
  // The switch the UI asked for is slow, or didn't happen: as for any
  // switch from this page (the pill, the notice).
  const onSwitchSlow = (slow) => loader.switching(slow);
  const decode = (text) => { const bin = atob(text); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
  /** @type {string | null} */
  let loadingTheme = null; // a load under way (one at a time)
  const wantedTheme = () => String(state?.settings?.theme ?? 'arcadia');
  // The package as the background keeps it in storage (`uiTheme`: read with
  // the state, kept from change events), if it's the one wanted; else asked
  // for.
  /** @type {any} */
  let storedTheme = null;
  /** @param {string} want */
  async function loadUi(want) {
    loadingTheme = want;
    try {
      const stored = storedTheme?.id === want && storedTheme?.pkg?.id === want ? storedTheme.pkg : null;
      const pkg = /** @type {any} */ (stored ?? await send('themePackage', { id: want }));
      if (!pkg || typeof pkg !== 'object' || typeof pkg.id !== 'string') return;
      const files = Object.fromEntries(Object.entries(pkg.files ?? {}).map(([p, b64]) => [p, decode(String(b64))]));
      const theme = await loadTheme({ manifest: pkg.manifest, html: pkg.html, css: pkg.css, files }, { document, settings: state?.settings?.themes?.[pkg.id] ?? null });
      if (!theme.ok) return void console.error('[margin] theme', pkg.id, 'refused:', /** @type {any} */ (theme).report.errors);
      if (retired() || appUi()) return;
      // An unknown id gets the default: the one the state names, as far as this page goes.
      themeId = want;
      mountUi(theme);
    } catch (err) {
      console.error('[margin] theme', want, 'failed to load:', err);
    } finally {
      loadingTheme = null;
    }
    // Settings chose another one meanwhile.
    if (runtime && wantedTheme() !== themeId) requestTheme();
  }
  // Once per shadow root: no page context menu, selection or zoom there.
  let browserUi = false;
  let themeTold = false; // onTheme: once (the palette's keys), whatever is mounted again
  // Margin.app took over drawing: the in-page UI goes (drawn again if the link goes).
  function unmountUi() {
    if (!runtime) return;
    const before = runtime;
    runtime = null;
    view = null;
    themeId = null;
    try {
      before.destroy();
      before.theme?.unload?.();
    } catch (err) {
      console.warn('[margin] taking the in-page UI down:', err);
    }
  }
  function mountUi(theme) {
    const before = runtime;
    const keep = before ? { palette: before.ui.palette } : {};
    before?.destroy();
    before?.theme?.unload?.();
    try {
      uiHost ??= makeUiHost();
      uiHost.identify({ tabId, windowId });
      runtime = createRuntime({
        host: uiHost, theme, container: shadow, ui: keep, onSwitchSlow, onSwitchFailed: () => switchFailed(),
        onSwitching: (id) => mark(host, 'switchingTo', id == null ? '' : String(id)), // test/debug hook
      });
      runtime.theme = theme;
    } catch (err) {
      runtime = null;
      view = null;
      return console.error('[margin] theme', theme.id, 'failed to start:', err);
    }
    view = uiView;
    if (!browserUi) asBrowserUi(shadow);
    browserUi = true;
    if (!themeTold) onTheme?.(runtime);
    themeTold = true;
    if (state) render();
    layout.reopen(); // hovered or toggled before it was there
    offerFittedReload();
  }
  // Taking over from a copy from before the page's box, on a page that copy
  // fitted beside the sidebar in an iframe: that layout (and the page's keys and
  // gestures in it) stays with the old copy until the page loads again
  // (content/takeover.js does that once it's hidden; offered when it's on
  // screen too, a few times at most).
  let fittedOffers = 0;
  function offerFittedReload() {
    const html = document.documentElement;
    if (!(replacing || takenOver) || !view || document.hidden || fittedOffers >= 3 || !(html.hasAttribute('data-margin-shell') || html.hasAttribute('data-margin-frameless'))) return;
    fittedOffers++;
    offerReload('Margin was updated. Reload this page to fit it beside the sidebar again.');
    // Not taken for "Margin isn't responding" told already (noAnswer).
    toldNoAnswer = false;
  }
  // The theme for the state: loaded once the state says which, and again
  // when Settings changes it. If it didn't work, the next state change asks again.
  function requestTheme() {
    if (appUi()) return void unmountUi();
    if (!state || loadingTheme != null || (runtime && wantedTheme() === themeId)) return;
    void loadUi(wantedTheme());
  }
  Margin.content.runtime = () => runtime;

  // ---- Light/Dark: follows only the Mac's appearance, never the page ---------

  const systemDark = matchMedia('(prefers-color-scheme: dark)');
  const colorScheme = () => (systemDark.matches ? 'dark' : 'light');
  Margin.content.colorScheme = colorScheme;
  Margin.content.pinched = () => pinch.zoomed();
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

  // The page's box (content/page-link.js), and the pinch that scales it.
  const link = startPageLink(send);
  /** @type {{ left: number, top: number, right: number, bottom: number } | null} */
  let box = null;
  const pinch = startPinch({ host }, { box: () => box, link });
  const page = {
    api, host, send, link, pinch,
    // Margin's UI (ui/runtime.js), once it's there.
    runtime: () => runtime,
    // Where the box is now (content/layout.js).
    boxed: () => !!box,
    setBox: (next, options) => {
      box = link.can ? next : null;
      link.setBox(box, options);
      pinch.follow();
    },
    view: () => view,
    theme: () => runtime?.theme ?? null,
    state: () => state,
    setState: (next) => { state = next; },
    firstRender: () => firstRender,
    justShown: () => Date.now() - lastShownAt < 600,
    active,
    dormant: retired,
    offerFullscreen,
    // The page's zoom (1 = 100%).
    zoom: () => pageZoom,
  };

  // ---- page zoom ---------------------------------------------------------------
  // Margin's UI keeps its size whatever the page's zoom (⌘+ / ⌘−), as a
  // browser's does (shared/dom.js setPageZoom); the page's box follows the
  // sidebar in the page's zoomed pixels (layout.js).
  // Read at start, after a resize (a zoom change resizes the page's
  // viewport; ⌘+ sends nothing else), when shown again (a site's zoom is
  // shared by its tabs).
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

  // The box from Margin.app's layout for this window (shared/app-link.js):
  // its insets from the window's edges, less where this viewport sits in the
  // window, in this page's zoomed pixels. No layout for the window yet: the
  // box stays as it is (the first-paint one, registered from the settings).
  function appGeometry() {
    const l = layoutFor(appLink, windowId ?? helloWindowId);
    if (!l) return null;
    const box = boxFromLayout(l, { outerWidth, outerHeight, innerWidth, innerHeight, zoom: pageZoom });
    const insets = box ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const radius = Number(l.radius) || 0;
    /** @type {import('../ui/host.js').Geometry} */
    const g = { insets, radius, radii: Array.isArray(l.radii) ? l.radii : [radius, radius, radius, radius], outer: { ...insets, radius }, container: { width: innerWidth, height: innerHeight } };
    return g;
  }
  function applyApp() {
    if (!appUi()) return;
    const g = appGeometry();
    if (g) layout.apply(g);
  }
  // What the background says of the link: the page draws, or doesn't, from now on.
  const appKey = (l) => JSON.stringify([l?.state ?? null, l?.layouts ?? null]);
  function setAppLink(next) {
    const value = next && typeof next === 'object' ? next : { state: 'off', layouts: {} };
    if (appLink !== undefined && appKey(value) === appKey(appLink)) return;
    const was = appLink === undefined ? null : appUi();
    appLink = value;
    const now = appUi();
    mark(host, 'app', String(appLink.state ?? 'off')); // test/debug hook
    attach();
    layout.setSource(now ? appGeometry : null);
    if (now) {
      if (was !== true) console.debug('[margin] Margin.app draws the UI: none in this page');
      unmountUi();
      switching.end();
      readiness.wait(false);
      applyApp();
    } else if (was === true) {
      console.debug('[margin] Margin.app is gone: the page draws the UI again');
      render();
    }
  }
  Margin.content.appDraws = () => appUi();
  addEventListener('resize', applyApp);
  // While the app draws: ⌘T is the app's (its hot key, PLAN.md §6); one that
  // reaches the page anyway does nothing visible, and the app is told.
  addEventListener('keydown', (e) => {
    if (!appUi() || !e.isTrusted || e.code !== 'KeyT' || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) void send('appKeyHeard', { command: 'palette' }, false);
  }, true);
  Margin.content.peek = layout.peek;

  // ---- data ---------------------------------------------------------------

  let tabId = null;
  let helloWindowId = null;
  let windowId = null;

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
  function switchFailed() {
    const why = switchError;
    void refresh();
    if (!why || dormant || noticeUp) return;
    const text = /no longer open|No tab with id/i.test(why) ? 'That tab is no longer open.'
      : why === NO_ANSWER ? 'Margin didn’t answer, so the tab didn’t switch. Try again.'
      : 'Margin couldn’t show that tab. Try again.';
    view?.showNotice?.({ text, duration: 4000 });
  }
  const switching = createSwitching({
    onChange: (id) => {
      switchingTo = id;
      if (id == null || cover === 'now') {
        view?.setCover?.(id != null, { instant: document.hidden });
        setCovered(id != null && !!view?.setCover);
      }
      mark(host, 'switchingTo', id == null ? '' : String(id)); // test/debug hook
      // The background's switch from this page (a next/previous key): the
      // UI highlights its tab (its own clicks it highlights itself).
      runtime?.setUi({ switchingTo: id });
      render();
    },
    onSlow: (slow) => {
      if (!view?.setCover) loader.switching(slow);
      else if (slow && cover === 'slow') {
        view.setCover(true);
        setCovered(true);
      }
    },
    failed: (result) => result === undefined,
    onBlink: (times) => void send('pageBlinked', times, false),
    onFailed: switchFailed,
  });
  const fromBackground = backgroundSwitches();
  // While the switch's cover is up, keys don't reach the page under it: it's
  // on its way out (a new tab can take seconds to load behind it:
  // background/tabs.js openBehind), and what's typed would land in it.
  // Shortcuts with ⌘, ⌃ or ⌥ still work; Escape calls the switch off.
  let covered = false;
  function setCovered(on) {
    covered = on;
    mark(host, 'switchCover', String(on)); // test/debug hook
  }
  const holdKeys = (/** @type {KeyboardEvent} */ event) => {
    if (!covered || !event.isTrusted || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.type === 'keydown' && event.key === 'Escape') Margin.content.cancelSwitch();
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const KEY_EVENTS = ['keydown', 'keypress', 'keyup'];
  for (const type of KEY_EVENTS) addEventListener(type, holdKeys, true);
  // Safari left for another app with this page in front: the background lets
  // go of the tab it keeps ready (background/keep-ready.js). Safari, and on.
  watchAway({ isOn: () => !!platform?.keepTabsReady && V.keepReadyMinutes(state?.settings) > 0, holdMs: () => V.keepReadyMinutes(state?.settings) * 60_000, send: (type, payload) => send(type, payload, false) });
  // A switch from this page called off (Escape, the palette opened again):
  // the page stays, as clicking its own tab does; a new tab loading behind it
  // stays there (background/tabs.js openBehind).
  Margin.content.cancelSwitch = () => {
    if (switching.target() == null) return;
    switching.end();
    if (tabId != null) void send('activateTab', { tabId });
  };

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
      mark(host, 'startup', String(on)); // test/debug hook
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
      for (const node of marginHosts(document)) {
        if ((/** @type {any} */ (node)).__marginCopy) showHost(node);
        else {
          hideHost(node);
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
    const hide = () => hideHost(host);
    if (document.hidden || !view?.showNotice) return hide();
    view.showNotice({ text: 'Margin was updated while Safari was open. Quit and reopen Safari to finish updating it.', actions: [{ label: 'OK', run: hide }], duration: 15000 });
    setTimeout(hide, 15500);
  }
  // Back to this page's own tab: over. A tab in another window: nothing to
  // highlight here, and that window comes forward.
  // `inWindow`: the tab's window, for a tab the state may not have yet (a new
  // tab the background just opened: its row comes with the next storage change).
  Margin.content.startSwitching = (id, request = null, { cover: when = 'now', inWindow = null } = {}) => {
    if (!active()) return;
    if (id === tabId) return switching.end();
    if (id !== NEW_TAB && (state?.tabs?.[id]?.windowId ?? inWindow) !== windowId) return;
    cover = when;
    switching.start(id, request);
  };

  // ---- one sidebar for the window ---------------------------------------------
  // Every page draws its own sidebar; these keep them showing the same:
  // the state is read again whenever the page is shown (Safari suspends tabs
  // it isn't showing, and they miss storage events meanwhile; a page from
  // the back/forward cache missed them too), and the tab list's scroll
  // position is the window's (background/scroll.js; the UI's m-scroll
  // keeps it: ui/behaviors/scroll.js), not each page's.
  // A hidden destination prepared by the background before Safari activates
  // it. Its sidebar is already current, scrolled and open the same way as the
  // source; the first visibilitychange must not replace that prepared frame
  // with another asynchronous storage/scroll round trip.
  /** @type {{ token: string, at: number, carry: 'hover' | 'toggle' | null } | null} */
  let preparedShow = null;
  // Preparations called off before they took `preparedShow` (the cancel came
  // during prepareForShow's first turn, or before its script ran): they stop
  // there instead of finishing for a switch the background let go of. The
  // last few only; each token is used once.
  const calledOff = new Set();
  // The UI asks for the window's position as the page is shown, and once
  // more a moment later (restoreScroll: the page left can save its own as
  // it's hidden, just after this one asked); it saves the user's at once
  // before a switch (flushScroll: the next page asks for it at once) and
  // when the page is left.
  const restoreScroll = () => runtime?.restoreScroll();
  const flushScroll = () => runtime?.flushScroll();
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
      setTimeout(() => document.visibilityState === 'visible' && (version === atVersion || staleRead) && refresh(), 250);
      // A key switch right after scrolling: the page left saves its position
      // as it's hidden, after this one was prepared with the one before.
      // Asked once more (not if the user scrolls here).
      setTimeout(restoreScroll, 400);
    } else {
      if (prepared?.carry) layout.hide(); // a prepared switch that never landed
      // Drawn at once from what changed while hidden (below), before storage
      // is read again: a page Safari brings to the front itself (its tab bar,
      // closing the tab in front) shows the right rows from its first frame.
      if (changedWhileHidden && state) render();
      changedWhileHidden = false;
      void refresh();
      // Switched by keyboard or Safari's tab bar right after scrolling: the
      // page left saves its position as it is hidden, which can land just
      // after this one asked (the UI asks as it's shown). Asked once more
      // (not if the user scrolls here).
      setTimeout(restoreScroll, 400);
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

  // Opened here because the previous page's sidebar was open (background
  // carryOpen, or with hello): at once, without sliding in again. Before
  // Chrome's full-screen answer, kept until hello brings it.
  let carriedWhy = null;
  function carryOpen(why) {
    if (platform?.marginFullscreen && fullscreen === null) return void (carriedWhy = why);
    view?.instantOnce?.();
    layout.show(why === 'toggle' ? 'toggle' : 'hover');
  }

  // The UI draws the state for this page's tab and window. Just shown (or
  // started), it shows its own tab's space while the state catches up
  // (shared/view.js; the runtime's justShown).
  function drawRows() {
    if (!state || !view) return;
    view.update(state, { windowId, tabId });
  }
  function render() {
    if (!state) return;
    requestTheme(); // the first, or Settings chose another
    if (!view) return;
    if (fullscreenOnly() && fullscreen === null) return; // until the background says (above)
    // Known tab → its window. Until the background answers `hello`, guess, so
    // the sidebar draws straight from storage instead of waiting for it.
    windowId = state.tabs?.[tabId]?.windowId ?? helloWindowId ?? V.guessWindow(state, location.href);
    drawRows();
    Margin.content.onState?.(state, { tabId, windowId });
    wasActive = active();
    view.setAway(!active());
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
  // STATE_REV): from its last read and every change event since, each
  // following the one before. Null when not known (a write it may have
  // missed, a change sent to a read instead): a preparation then reads.
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
      // they changed (shared/stored.js readForPage): otherwise some 300 KB of
      // icons, 6–18 ms in the page in the WebKit host, at every preparation
      // and every show.
      // The icons not read are the ones the change events kept current.
      raw = await readForPage((keys) => api.storage.local.get(keys), () => state, seenKeys);
    } finally {
      reading--;
    }
    const readMs = msSince(readFrom), renderFrom = performance.now(); // DEVELOPMENT DIAGNOSTICS
    for (const key of Object.keys(raw)) seenKeys.add(key);
    seenKeys.add(APP_LINK_KEY); // read every time from now on
    if (raw.uiTheme) storedTheme = raw.uiTheme;
    if (mine === version || appLink === undefined) setAppLink(raw[APP_LINK_KEY]);
    const missed = changedDuringRead !== missedBefore;
    if (missed) staleRead = true;
    const next = fromStorage(raw);
    if (mine === version) ownerSeen(next.owner, next.openTabsBy);
    timing.storage ??= Math.round(performance.now());
    if (mine !== version || !next.spaces?.length) return false; // stale, or background not initialized yet
    if (!missed) staleRead = false; // what's drawn now is storage as read (the icons as the events kept them), newer than any change taken before
    knownRev = missed ? null : revOf(raw);
    // Brought to the front without preparation (a tab Safari restores as it's
    // shown): until `hello` says which tab this is, the background's note does
    // (background/tabs.js noteShowing), with how the page before had the
    // sidebar, so the first frame is already right.
    const noted = tabId == null && !dormant ? notedShowing(next.showing) : null;
    if (noted) {
      adoptedNote = noted;
      tabId = noted.tabId;
      helloWindowId = noted.windowId;
      console.debug(`[margin] drawn as tab ${noted.tabId}, the one being shown (before hello)`);
    }
    const firstScroll = firstRender;
    state = stateForShow(next, show ?? (noted ? { tabId: noted.tabId, windowId: noted.windowId } : null));
    if (!zoomAnswered) applyZoom(Number((next.pageZoom?.[location.origin] ?? next.pageZoom?.['*'])?.[0] ?? 1)); // drawn at its size from the start
    render();
    if (noted && firstScroll && Number.isFinite(noted.scroll)) runtime?.setScroll(noted.scroll);
    if (noted?.carry && !carriedNoted) {
      carriedNoted = true;
      carryOpen(noted.carry);
    }
    if (noted && !coveredWhileLoading) coverWhileLoading();
    requestTheme(); // only if it isn't here by now
    refreshTimes = { readMs, renderMs: msSince(renderFrom) }; // DEVELOPMENT DIAGNOSTICS
    return true;
  }
  // The state the page has, drawn for a show as a read would draw it
  // (prepareForShow: the page knows the last write).
  /** @param {{ tabId: number, windowId: number }} show */
  function drawKnown(show) {
    const renderFrom = performance.now(); // DEVELOPMENT DIAGNOSTICS
    state = stateForShow(state, show);
    const zoom = /** @type {any} */ (state).pageZoom;
    if (!zoomAnswered) applyZoom(Number((zoom?.[location.origin] ?? zoom?.['*'])?.[0] ?? 1));
    render();
    requestTheme(); // only if it isn't here by now
    refreshTimes = { readMs: 0, renderMs: msSince(renderFrom) }; // DEVELOPMENT DIAGNOSTICS
    return true;
  }
  let carriedNoted = false;
  let adoptedNote = null; // until hello confirms it (or not)
  /** @type {(() => void) | null} */
  let uncoverLoading = null;
  // A tab Safari loads as it's shown, brought to the front by Margin: the
  // switch's cover stays over the page (its spinner already turning, as on
  // the page before) until the page has painted something of its own (its
  // document parsed and its own content drawn: shared/page-ready.js; not the
  // cover's spinner, which is the page's first contentful paint here) or
  // loaded, at most COVER_LOADING_MS (then it shows as far as it got), so the
  // switch reads as one wait rather than a page building up. Until its load
  // event, at first: in Tirth's log a page painted at 130 ms and loaded at
  // 2334 ms, all that time under the cover.
  const COVER_LOADING_MS = 1500;
  let coveredWhileLoading = false;
  function coverWhileLoading() {
    coveredWhileLoading = true;
    if (!view?.setCover || document.hidden || document.readyState === 'complete') return;
    view.setCover(true, { instant: true, spinnerNow: true });
    mark(host, 'loadingCover', 'true'); // test/debug hook
    let done = false;
    const off = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Not if a switch from here has taken the cover over meanwhile.
      if (switchingTo == null) view?.setCover?.(false, { instant: document.hidden });
      mark(host, 'loadingCover', 'false');
    };
    const timer = setTimeout(off, COVER_LOADING_MS);
    uncoverLoading = off;
    addEventListener('load', off, { once: true });
    // In front, a page records its paints in either browser.
    void readyInPage(COVER_LOADING_MS).then((how) => how !== 'timeout' && off());
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

  // ---- a tab shown for the first time ------------------------------------------
  // A tab that has never been on screen (loaded behind the page: a new tab
  // from the palette, a ⌘-clicked link) can't keep the page before on screen
  // while it paints, as a tab shown before does: WebKit waits for the paint
  // only for a view that has been in a window before
  // (WebPageProxy::dispatchActivityStateChange), and otherwise shows Safari's
  // empty view until the tab's first paint lands (hideContentUntilPendingUpdate):
  // 70ms of dark between the cover and the page, for a busy page, in Tirth's
  // Safari. Asked to arrive covered (the background knows the tab was never
  // in front, and the page before is covered: background/tabs.js), such a
  // page makes that first paint as cheap as it gets: the switch's cover,
  // spinner turning, with the page itself out of sight under it; once shown,
  // it brings the page back, lets it paint, and only then lifts the cover.
  // (A document that was visible has been in a window: never covered. Not one
  // visible for an instant: background/tabs.js introduceTab brings a tab to
  // the front and straight back, out of sight, and it then still arrives
  // covered: the two together leave no empty frame.)
  const SEEN_MS = 200;
  let everShown = !document.hidden;
  let seenTimer = null;
  document.addEventListener('visibilitychange', () => {
    clearTimeout(seenTimer);
    if (!document.hidden) seenTimer = setTimeout(() => { everShown = true; }, SEEN_MS);
  });
  // False for a document that started visible in a tab whose page may have
  // just been made, and hasn't come into view from hidden since (for any time
  // at all): the tab in front at a launch, one Safari loaded as it was shown.
  // Its tab's view may have gone into the window before it had a process:
  // WebKit then never marked it as having been in a window, and its first
  // return shows Safari's empty view until it paints. The background
  // introduces such a tab first (background/tabs.js pageThere, mayIntroduce).
  // Safari makes those pages from the tab's saved history (in its log, all four
  // such returns with Safari's empty view in the 00:32 session were tabs it
  // restored with no process yet: restoreFromSessionState, then
  // goToBackForwardItem, "PID=0"), so their document's navigation is
  // 'back_forward'; or the first document of a tab opened in front (a link
  // from another app: Safari also starts loads with no process,
  // "loadRequest … PID=0"). A link, the address bar or a reload in a tab WebKit
  // has seen in the window is neither: WebKit's mark stays with the tab's page
  // for good, and such a page, introduced all the same, took 80 ms to come
  // back in the WebKit host against 10 (the host's `navigated`). A copy that
  // came into the page after its start (Margin installed or updated meanwhile)
  // doesn't know how it started: taken as seen, as a page with an earlier copy
  // is (in the WebKit host, a page open at install was otherwise introduced on
  // its first switch, 70 ms more for nothing). One that started hidden is a
  // tab opened behind, or one loaded behind (the warm-up, a restore).
  // The mark is the tab's web view's, so the page says as it starts (hello)
  // how it was made, whether its copy started with it (`fresh`), and its own
  // id (`doc`): the background takes a page made from the tab's saved history,
  // or a tab's first page, as a new web view maybe, not marked whatever it
  // knew (background/tabs.js pageStarted, WebKit's mark), and the tab as
  // marked only on proof: its own flip or show of it, or this page's word that
  // it came into view after its tab was known out of the window (inView,
  // below).
  const docId = (() => {
    try {
      return globalThis.crypto.randomUUID();
    } catch {
      return `${Date.now()}-${String(Math.random()).slice(2)}`;
    }
  })();
  // (The background's word that its tab is proven, sent once known when its
  // hello's answer couldn't wait for it: background/tabs.js provenInPage.)
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
  // Whether this page has itself come into view (visible after hidden). Its
  // tab came into the window then, whoever showed it, only if it wasn't
  // there before: a page in front also goes hidden and comes back as its
  // window is covered and uncovered, which WebKit doesn't count. So the
  // background takes it as its tab's mark only where it knows it was out of
  // the window (background/tabs.js pageThere 'seen', sawInWindow).
  let cameIntoView = false;
  // Each time it comes into view from hidden, it says so (a quiet word: the
  // background takes it as its tab's mark only where it knew the tab was out
  // of the window, and pages of this tab before it don't count: `doc`), until
  // the background answers that its tab is proven to have the mark with this
  // page in it: nothing this page says can add to that, and it's lost only
  // with the page (a new web view has a new page), so its window covered and
  // uncovered, a Space switch or each return to it don't start the
  // background for nothing.
  let markProven = false;
  // That word kept in this page's world too (`Margin.inWindowAt`, not this
  // copy's own `Margin.content`): the world outlives a copy of Margin (Safari
  // keeps it as Margin is updated, or Margin.app opened: background/cut-off.js),
  // and goes with this document, so the copy after reads it in its wake
  // (background/tabs.js pageThere 'proven') and doesn't introduce the tab
  // again. A new document has a new world, with nothing in it.
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
  // When this page last handled a change of its visibility (a switch's last
  // look before its show: background/tabs.js pingInPage, a page just shown or
  // hidden may still be busy with it), and when it first drew after it last
  // became visible (Date.now: background/tabs.js drewInPage, after a flip): the
  // first ResizeObserver or animation frame callback after that, which in the
  // WebKit host came in the very rendering update whose commit unhid the
  // content WebKit hid as the tab came into the window; an observer's comes
  // in a page hidden again by then too (an animation frame's doesn't). Margin's
  // listener runs before the page's own (added at document_start).
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
  // Never longer than this hidden (a switch that didn't happen, or a page
  // shown without its frames running).
  const ARRIVAL_MAX_MS = 3000;
  // A preparation's catch-up, at most this close to the background's limit.
  const CATCH_UP_MS = 150;
  // Out of sight but still there: unlike visibility or display, opacity keeps
  // the page's focus (a field it focused, or autofocus, as it's shown).
  const HIDE_PROP = 'opacity';
  const HIDE_VALUE = '0';
  /** @type {{ finish: (options?: { fade?: boolean }) => void, renew: () => void } | null} */
  let arrival = null;
  const frames = (/** @type {number} */ n) => new Promise((resolve) => {
    const step = () => (n-- <= 0 ? resolve(undefined) : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  function arriveCovered() {
    // Covered already (asked for as its document first answered, while it
    // loads behind: background/tabs.js waitLoaded): its limit counts from
    // now, the show still to come, so it doesn't run out just before it.
    if (arrival) return arrival.renew();
    // Not a page on screen already (Safari left it in front, or the user
    // brought it there): no show is coming to bring it back.
    if (everShown || !view?.setCover || !document.hidden) return;
    const page = document.body;
    if (!page) return;
    const before = [page.style.getPropertyValue(HIDE_PROP), page.style.getPropertyPriority(HIDE_PROP)];
    // Only Margin's own change is undone (not one the page made meanwhile).
    const showPage = () => {
      if (page.style.getPropertyValue(HIDE_PROP) !== HIDE_VALUE || page.style.getPropertyPriority(HIDE_PROP) !== 'important') return;
      if (before[0]) page.style.setProperty(HIDE_PROP, before[0], before[1]);
      else page.style.removeProperty(HIDE_PROP);
    };
    page.style.setProperty(HIDE_PROP, HIDE_VALUE, 'important');
    view.setCover(true, { instant: true, spinnerNow: true });
    setCovered(true);
    mark(host, 'arrivalCover', 'true'); // test/debug hook
    let done = false;
    let hides = 0;
    const finish = ({ fade = true } = {}) => {
      if (done) return;
      done = true;
      clearTimeout(limit);
      document.removeEventListener('visibilitychange', onVisibility);
      showPage();
      // Not if a switch from here has taken the cover over meanwhile.
      if (switchingTo == null) {
        view?.setCover?.(false, { instant: !fade || document.hidden });
        setCovered(false);
      }
      mark(host, 'arrivalCover', 'false');
      arrival = null;
    };
    const onShown = async () => {
      const at = hides;
      await frames(2); // its first frames: the cover, cheap to paint
      // Hidden again meanwhile: on screen for an instant only (introduced:
      // background/tabs.js); the show to come brings it.
      if (done || hides !== at) return;
      document.removeEventListener('visibilitychange', onVisibility);
      showPage();
      await frames(2); // the page, painted under the cover
      await new Promise((resolve) => setTimeout(resolve, 40));
      finish();
    };
    const onVisibility = () => {
      if (done) return;
      if (document.hidden) hides++;
      else void onShown();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const expire = () => finish({ fade: !document.hidden });
    let limit = setTimeout(expire, ARRIVAL_MAX_MS);
    const renew = () => {
      if (done || !document.hidden) return;
      clearTimeout(limit);
      limit = setTimeout(expire, ARRIVAL_MAX_MS);
    };
    arrival = { finish, renew };
  }
  // Whether the arrival cover is on (shared/page-ready.js looks past it).
  Margin.content.arrivalHides = () => !!arrival;

  // Called through scripting.executeScript in the current isolated extension
  // world (background/tabs.js), not tabs.sendMessage: Safari can leave an old
  // content-script listener behind after an update. Everything necessary for
  // the destination's first frame is committed before this promise answers.
  // `until`: when the background stops waiting for the answer (a late one is
  // cancelled).
  // `sentAt`, and the answer's `timings`: DEVELOPMENT DIAGNOSTICS (the switch
  // log: lagMs from the background's call to this running, then the storage
  // read, the render, the catch-up and the forced layout, in ms).
  // `rev`: the state's last write as the background sent this (shared/stored.js
  // STATE_REV): one this page knows, and it draws from the state it has, at
  // once, rather than reading storage first (in Tirth's Safari that read was
  // most of a median 70 ms, up to 0.7 s, on every switch to a loaded tab,
  // the switch waiting for it). Events reach the page in order, and before
  // this script, so it has seen every write up to that one. The rest is as
  // before (shown()'s refresh 250 ms after the show if no change came
  // included); `timings.known` says which way it went, `timings.revSent`
  // whether the background knew its last write was through.
  /** @param {{ token?: string, tabId?: number, windowId?: number, scroll?: number, carry?: 'hover' | 'toggle' | null, covered?: boolean, until?: number, rev?: string | null, sentAt?: number }} [context] */
  Margin.content.prepareForShow = async ({ token, tabId: targetId, windowId: targetWindow, scroll, carry, covered = false, until, rev = null, sentAt } = {}) => {
    const lagMs = Number.isFinite(sentAt) ? Date.now() - /** @type {number} */ (sentAt) : null; // DEVELOPMENT DIAGNOSTICS
    if (!token || !Number.isInteger(targetId) || targetWindow == null) return { ready: false, reason: 'bad context' };
    // What the page was told before this came runs first: WebKit queues a
    // visibilitychange as a task, so an introduction's (the tab to the front
    // and straight back: background/tabs.js) can still be waiting, and its
    // hide would close the sidebar this opens (layout.leave). The storage
    // read gave it that turn; drawn from the state the page has, it needs one
    // of its own. A message to itself, which WebKit doesn't hold back in a
    // hidden page as it may a timer (seen in the WebKit host: the `unloaded`
    // scenario, the carried sidebar closed in about half the runs without it).
    await new Promise((resolve) => {
      const turn = new MessageChannel();
      turn.port1.onmessage = () => {
        turn.port1.close();
        resolve(undefined);
      };
      turn.port2.postMessage(null);
    });
    // A newer preparation owns this hidden page. Undo only the transient open
    // state from the older one; ordinary Keep open is restored by hide().
    if (preparedShow?.carry) layout.hide();
    // Called off meanwhile (cancelPreparedShow): as if the cancel had come
    // just after this took the page, which it can't now hear of.
    if (calledOff.delete(token)) {
      preparedShow = null;
      return { ready: false, reason: 'superseded' };
    }
    preparedShow = { token, at: Date.now(), carry: null };
    tabId = targetId;
    helloWindowId = targetWindow;
    switching.end();
    runtime?.setUi({ newTabPending: false });
    const known = !firstRender && !!state?.spaces?.length && knowsState(rev, { known: knownRev, reading, staleRead });
    const rendered = known ? drawKnown({ tabId: targetId, windowId: targetWindow }) : await refresh({ tabId: targetId, windowId: targetWindow });
    if (Number.isFinite(scroll)) runtime?.setScroll(Math.max(0, scroll));
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
    if (covered) arriveCovered();
    // What the page's world put off until the tab is in sight (a move of its
    // box, the drawing above's included, and reads its styles asked for):
    // done now, so the first frame shown has it (content/page/box.js catchUp).
    // Not with little time left: done as it's shown then, as before.
    const { readMs, renderMs } = refreshTimes, catchUpFrom = performance.now(); // DEVELOPMENT DIAGNOSTICS
    if (document.hidden && !(Number.isFinite(until) && /** @type {number} */ (until) - Date.now() < CATCH_UP_MS)) link.catchUp();
    const catchUpMs = msSince(catchUpFrom), layoutFrom = performance.now(); // DEVELOPMENT DIAGNOSTICS
    // Force style/layout in this WebProcess before the executeScript result
    // crosses back to Safari's UI process. Hidden pages do not reliably run
    // requestAnimationFrame, so an animation-frame acknowledgement would hang.
    host.getBoundingClientRect();
    return { ready: true, token, timings: { lagMs, readMs, renderMs, catchUpMs, layoutMs: msSince(layoutFrom), known: known ? 1 : 0, revSent: typeof rev === 'string' ? 1 : 0 } };
  };
  // Covered before the background introduces the tab (background/tabs.js
  // coverArrival), its style and layout done now: the paint WebKit asks for in
  // that instant is the cover's, quick. Whether it's covered.
  Margin.content.coverArrival = () => {
    arriveCovered();
    host.getBoundingClientRect();
    return !!arrival;
  };
  // `keepCover`: the show follows at once (a preparation past its time): the
  // arrival cover stays for the show to lift, so the show's first paint is
  // the cover's. Cancelled again without it (the switch failed after all),
  // the cover is lifted then.
  let coverKeptFor = null;
  Margin.content.cancelPreparedShow = (token, { keepCover = false } = {}) => {
    if (!preparedShow || preparedShow.token !== token) {
      if (!keepCover && token != null && token === coverKeptFor) {
        coverKeptFor = null;
        if (document.hidden) arrival?.finish({ fade: false });
      }
      // Perhaps a preparation that hasn't taken the page yet (above).
      if (typeof token === 'string') {
        calledOff.add(token);
        if (calledOff.size > 8) calledOff.delete(calledOff.values().next().value);
      }
      return false;
    }
    const { carry } = preparedShow;
    preparedShow = null;
    coverKeptFor = keepCover ? token : null;
    if (!keepCover) arrival?.finish({ fade: false });
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
  // carry the values) without drawing it: shown() draws it at once. Shown,
  // it takes them the same way and draws them; it reads storage
  // again only when an event can't be taken (shared/stored.js takesChanges),
  // before its first drawing, and whenever it's shown.
  let changedWhileHidden = false;
  const onStorageChanged = (changes, area) => {
    if (area !== 'local' || dormant) return;
    if ('uiTheme' in changes) {
      storedTheme = changes.uiTheme.newValue ?? null;
      if (Object.keys(changes).length === 1) return; // nothing else to draw
    }
    // Margin.app's link (background/link.js): not state.
    if (APP_LINK_KEY in changes) {
      setAppLink(changes[APP_LINK_KEY].newValue);
      const { [APP_LINK_KEY]: _, ...rest } = changes;
      if (!Object.keys(rest).length) return;
      changes = rest;
    }
    // The data set's times for Margin.app, written on their own (background/
    // store.js): nothing a page draws or reads.
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
      requestTheme(); // only if it isn't here by now
      return;
    }
    if (reading) changedDuringRead++;
    const next = withChanges(state, changes);
    state = next;
    knownRev = rev;
    changedWhileHidden = true;
    if ('owner' in changes || 'openTabs' in changes) ownerSeen(next.owner, next.openTabsBy);
    // The trackpad's listeners follow the settings now, not at the next
    // drawing: a swipe right after this page is shown is already guarded.
    if ('settings' in changes) trackpad.update();
  };
  api.storage.onChanged.addListener(onStorageChanged);

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
        ` | page DOMContentLoaded=${fmt(nav?.domContentLoadedEventStart)} load=${fmt(nav?.loadEventStart)} keepOpen=${!!state?.settings?.sidebarPinnedOpen}`,
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
    // The background's word on the link (it may be newer than storage's).
    if (ctx.app !== undefined) {
      const layouts = { ...(appLink?.layouts ?? {}) };
      if (ctx.app?.layout && ctx.windowId != null) layouts[ctx.windowId] = ctx.app.layout;
      setAppLink(ctx.app ? { ...(appLink ?? {}), state: ctx.app.state, layouts } : { state: 'off', layouts });
    }
    applyApp(); // its window is known now
    if (ctx.warmUp) showWarmUp(ctx.warmUp);
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

  // ---- the warm-up after a relaunch (background/warm-up.js) ------------------
  // Whether the user is idle here, asked by the background before it loads a
  // tab behind this page, and the first input after that said to it
  // (content/idle.js). Margin itself isn't idle with its palette open, the
  // sidebar out over the page or in use, or a switch under way.
  const idle = createIdleWatch({
    busy: () => (Margin.content.paletteOpen?.() ? 'palette' : layout.out() ? 'sidebar out' : view?.isBusy?.() ? 'sidebar in use' : switching.target() != null ? 'switching' : !active() ? 'out of the way' : null),
    acted: (at) => void send('warmUpInput', { at }, false),
  });
  // Its note in the sidebar ("Getting your tabs ready", 3 of 6): only while
  // this page is in front; one hidden drops it (the background tells the page
  // that comes to the front). Over, the watch ends.
  // A note with no news for its `forMs` (the background's NOTE_MS: a run
  // waiting on the user, or one whose last word didn't come) goes by itself.
  /** @type {{ done: number, total: number, state: string } | null} */
  let warmUpNote = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let warmUpTimer;
  const showWarmUp = (/** @type {any} */ progress) => {
    clearTimeout(warmUpTimer);
    warmUpNote = progress && progress.state === 'running' ? progress : null;
    if (warmUpNote) warmUpTimer = setTimeout(() => showWarmUp(null), Math.max(1000, Number(progress.forMs) || 15_000));
    if (progress && progress.state !== 'running') idle.end();
    if (!document.hidden || !progress) view?.setWarmUp?.(progress ?? null);
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden || !warmUpNote) return;
    clearTimeout(warmUpTimer);
    warmUpNote = null;
    view?.setWarmUp?.(null);
  });

  const onMessage = (message, _, sendResponse) => {
    if (message?.type === 'warm-up-idle') return sendResponse(dormant ? { idle: false, why: 'not in charge', retryMs: 5000 } : message.prime ? idle.watch() : idle.ask(message));
    if (message?.type === 'warm-up') return showWarmUp(message.progress);
    // Background (⌘T hand-off): open the palette here to choose a new tab, and
    // say whether it could (not before the theme is mounted, or while Margin
    // is out of the way; then the new-tab page opens its own instead).
    if (message?.type === 'show-palette') {
      const can = !!Margin.content.openPalette && active();
      if (can) Margin.content.openPalette({ newTab: true });
      return sendResponse(can);
    }
    // The background is switching from this tab to another (next/previous
    // tab; a new tab from the palette, once it has loaded, with this page
    // covered meanwhile: `cover`): highlight it already (content/palette.js
    // and the sidebar start their own switches themselves).
    // Answers whether it's covered now (the background waits for a tab to
    // load only behind a page that is: background/tabs.js coverFront).
    const forThisPage = message?.from == null || tabId == null || message.from === tabId;
    if (message?.type === 'switching') {
      if (forThisPage) {
        switchError = null; // not an earlier click's
        Margin.content.startSwitching(message.tabId, fromBackground.begin(message.tabId, message.switchId), { cover: message.cover ?? (message.passing ? 'none' : 'slow'), inWindow: message.windowId ?? null });
        return sendResponse(covered && switching.target() === message.tabId);
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
    // Margin.app's layout for this window, as it changes (background/link.js).
    if (message?.type === 'appLayout' && Number.isInteger(message.windowId)) {
      if (!appLink) return;
      setAppLink({ ...appLink, layouts: { ...(appLink.layouts ?? {}), [message.windowId]: message.layout } });
      return;
    }
    if (message?.type !== 'command') return;
    if (message.command === 'toggle-sidebar') Margin.content.sidebar.toggle();
    else if (message.command === 'peek') Margin.content.peek?.();
    // Switched here from the sidebar while it was open over the page: open
    // here too (background handlers.js carryOpen).
    else if (message.command === 'carry-open') carryOpen(message.why);
    else Margin.content.onCommand?.(message.command);
  };
  api.runtime.onMessage.addListener(onMessage);
  // Off as the page is left, back on if it comes back from the back/forward
  // cache (pageshow above has shown() read storage again). WebKit holds a
  // listener on a browser.* event, and with it the page's whole document,
  // after that page has gone into the cache and been dropped from it: in a
  // tab that stays on one site, every page left stayed in memory until the
  // tab's process ended.
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
