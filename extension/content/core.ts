// Margin on web pages (Margin 2, PLAN.md §7). Margin.app draws all of
// Margin's UI around the browser's window; a page draws none of it, linked
// or not: no UI runtime, no theme, no element of Margin's in the document,
// and no box (the page box was removed 2026-11-16: DECISIONS.md "Hosted only").
// What a page keeps is what only a page can do: the trackpad's gestures, the
// draft check, the keys a page hears (navigation, ⌘T), its icon, and its part
// in the background's switches.
// It reads the state from storage.local, for its tab and window, its
// settings and its copy of Margin.
import * as V from '../shared/view.ts';
import { mark } from '../shared/dom.ts';
import * as shortcuts from '../shared/shortcuts.ts';
import { capabilities } from '../shared/capabilities.ts';
import { watchEdits } from './edits.ts';
import { startTrackpad } from './trackpad.ts';
import { SWITCH_GRACE_MS } from '../shared/switching.ts';
import { startLoads } from './loads.ts';
import { startMedia } from './media.ts';
import { PEEK_ANSWER_MS, startCardKeys, startPeek } from './peek.ts';
import { startKeepFullscreen } from './keep-fullscreen.ts';
import { fromStorage, onlyMark, openTabsCurrent, readForPage, takesChanges, withChanges } from '../shared/stored.ts';
import { APP_LINK_KEY, appDraws, drawsWindow } from '../shared/app-link.ts';
import { startScrollRecord } from './scroll-record.ts';
import type { MessageType, Request, Result } from '../../types/margin';

// Starts Margin in this page; false when it shouldn't (or already did).
export function startCore() {
  const api = globalThis.browser ?? globalThis.chrome;
  // Load timing, in ms since navigation start (see logTiming below).
  const timing: { injected: number, storage?: number, rendered?: number } = { injected: Math.round(performance.now()) };
  if (location.href.startsWith(api.runtime.getURL(''))) return false;

  const Margin = (globalThis.Margin ??= {});
  // Already running in this page: WebKit runs the content scripts again in
  // open pages, in the same world, when Margin's site permissions change.
  if (Margin.content) return false;
  Margin.content = { api, startedAt: Date.now() }; // see background.ts injectIntoOpenTabs
  // What the user typed here and hasn't sent: a tab with a draft isn't put to
  // sleep (background/sleep.ts asks: content/edits.ts).
  if (capabilities?.sleepTabs) Margin.content.edits = watchEdits();
  // This copy's address: the stored tabs say whether they're this copy's
  // (shared/stored.ts). A copy a newer one replaced stays out of the way
  // (`dormant`, below).
  const origin = api.runtime.getURL('');
  let dormant = false;
  const retired = () => dormant;
  // State shown for tests and nothing else (shared/dom.ts mark: only under a
  // test harness): `Margin.content.marks()`.
  const marks = { dataset: ({} as Record<string, string>) };
  Margin.content.marks = () => ({ ...marks.dataset });

  // ---- Margin.app ---------------------------------------------------------------
  // Linked (or reconnecting: shared/app-link.ts), the app draws Margin around
  // this window. Known from storage (appLink, in the page's first read), then
  // from the background (hello, its `appDrawn` messages, appLink's change events).
  let appLink: any; // undefined until the first read
  const appUi = () => appDraws(appLink);

  // If the background was unloaded and the first message doesn't wake it in
  // time, retry once.
  // A switch usually lands at once (the background answers in well under a
  // second, waking a tab at most 0.4s), but a background just starting first
  // matches the open tabs (background.ts firstSync): a switch waits that
  // long before it's given up; anything else gets a cold start's time.
  const NO_ANSWER = 'no answer';
  const SEND_TIMEOUT_MS: Record<string, number> = { activateTab: 7000, openPin: 7000, setSpace: 7000, newTab: 12000, search: 12000, default: 8000 };
  const SWITCH_REQUESTS = new Set(['activateTab', 'openPin', 'setSpace']);
  // These, and a new tab, say when this page stops waiting.
  const TIMED_REQUESTS = new Set([...SWITCH_REQUESTS, 'newTab', 'search']);
  // A switch waits SWITCH_GRACE_MS past that for the answer (`waitsUntil`):
  // the background plans the switch to the deadline, and answers by it, but
  // on a Mac that busy its timers fire late (background/tabs.ts focusTab).
  let helloAnswered = false; // this page's background has said which tab it is
  /**
   * @param type a handler in background.ts
   * undefined when it failed
   */
  async function send<K extends MessageType>(type: K, payload: Request<K> = {}, retry: boolean = true): Promise<Result<K> | undefined> {
    // Margin was reloaded or removed since this copy started (Chrome takes its
    // id away, and sendMessage throws "Extension context invalidated"): a
    // new copy has the page now, this one stays quiet. So does one a newer
    // copy replaced.
    if (!api.runtime?.id || dormant) return;
    // A request naming a tab also says the tab's address and place, so the
    // background finds it even if its id is from before (background/tabs.ts
    // resolveTab), and trusts the id only if they're its own. Not for this
    // page's own tab as its background named it (hello).
    const ownTab = helloAnswered && ((payload as any)).tabId === tabId;
    if (Number.isInteger(((payload as any)).tabId) && !((payload as any)).hint && !ownTab) {
      const tab = state?.tabs?.[(payload as any).tabId];
      if (tab) payload = ({ ...payload, hint: { url: tab.url, index: tab.index, title: tab.title, from: (state as any)?.openTabsBy ?? null } } as any);
    }
    // And when this page stops waiting for it: the background doesn't switch
    // after that. Asked again (retry), it keeps its first deadline.
    if (TIMED_REQUESTS.has(type) && !Number.isFinite(((payload as any)).deadline)) {
      const deadline = Date.now() + SEND_TIMEOUT_MS[type];
      payload = ({ ...payload, deadline, ...(SWITCH_REQUESTS.has(type) ? { waitsUntil: deadline + SWITCH_GRACE_MS } : {}) } as any);
    }
    const until = ((payload as any)).waitsUntil ?? ((payload as any)).deadline;
    const waitMs = Number.isFinite(until) ? Math.max(0, until - Date.now()) : (SEND_TIMEOUT_MS[type] ?? SEND_TIMEOUT_MS.default);
    let timer;
    try {
      // Never waited on forever: in WebKit a copy left from before Margin
      // was updated sends into nothing, and the message neither arrives nor
      // fails.
      const reply = api.runtime.sendMessage({ type, ...payload });
      const res = await Promise.race([
        reply,
        new Promise<any>((_, reject) => { timer = setTimeout(() => reject(new Error(NO_ANSWER)), waitMs); }),
      ]);
      if (res?.ok) return res.result;
      if (res?.stale) return void standDown();
      if (res) return void console.warn('[margin]', type, res.error);
    } catch (err) {
      if ((err as Error | undefined)?.message === NO_ANSWER) return void console.warn('[margin]', type, 'no answer from the background (yet)');
      if (!retry) return void console.warn('[margin]', type, err);
    } finally {
      clearTimeout(timer);
    }
    if (retry) {
      await new Promise<any>((r) => setTimeout(r, 250));
      // No time left for a switch: it didn't happen.
      if (Number.isFinite(until) && until - Date.now() < 500) return;
      return send(type, payload, false);
    }
  }
  Margin.content.send = send;

  // ---- what Margin does on the page ----------------------------------------
  // Each part reads what it shares through `page`.

  let state: import('../../types/margin').State | null = null;
  // Chrome, "only in full screen" (setting fullscreenOnly, on by default):
  // in a window that isn't full screen Margin stays out of the way (no keys,
  // no gestures). Whether the window is in full screen comes from the background
  // (`hello`, `windowState`), not the page's size; null until it says.
  const fullscreenOnly = () => !!capabilities?.marginFullscreen && state?.settings?.fullscreenOnly !== false;
  let fullscreen: boolean | null = null;
  const active = () => !retired() && (!fullscreenOnly() || fullscreen === true);
  Margin.content.active = active; // (whether this copy acts here: it hasn't stood back; Chrome: in full screen)

  const page = {
    api, marks, send,
    state: () => state,
    active,
    dormant: retired,
    // A trackpad gesture's feedback as it goes (content/trackpad.ts), for
    // Margin.app's overlay to draw while it draws Margin around this window.
    tellGesture: (g: any) => { if (appUi() && active()) void send('gesture', g, false); },
  };

  const trackpad = startTrackpad(page);
  // ⌘⌥↓/↑ next/previous tab, ⌘⌥→/← next/previous space (none while Margin is
  // out of the way). The background does the work; nothing here draws.
  const navSettings = () => (active() ? state?.settings : null);
  shortcuts.installNavigation({ send, getSettings: navSettings });
  // Going in or out of full screen (Chrome): Margin's keys and gestures come, or go.
  // The background tells the window's pages; a resize, or coming back to a
  // tab (moved to another window meanwhile), asks again.
  function setFullscreen(value: boolean) {
    if (fullscreen === value) return;
    fullscreen = value;
    render();
  }
  let recheck: Timer | null = null;
  const checkFullscreen = () => {
    if (!capabilities?.marginFullscreen) return;
    clearTimeout(recheck);
    recheck = setTimeout(() => send('windowState').then((res) => res && setFullscreen(res.fullscreen)), 200);
  };
  addEventListener('resize', checkFullscreen);
  // What the background says of the link, and of what the app draws.
  const appKey = (l: any) => JSON.stringify([l?.state ?? null, l?.drawn ?? null]);
  // What the log last said of the app here, said again as it changes (the window known later too).
  let saidOfApp: string | null = null;
  function sayApp() {
    if (appLink === undefined) return;
    // (Its window not known yet, from Margin's state or the background's hello: not said either way.)
    const known = state?.tabs?.[tabId as number]?.windowId ?? helloWindowId; // (no id yet: no tab, undefined)
    const said = !appUi() ? 'Margin.app isn\'t linked' : known == null ? 'Margin.app is linked (this page\'s window not known yet)' : drawsWindow(appLink, known) ? 'Margin.app draws Margin around this window' : 'Margin.app is linked but draws nothing over this window';
    if (said !== saidOfApp) console.debug(`[margin] ${said}`);
    saidOfApp = said;
  }
  function setAppLink(next: any) { // (storage's appLink: shared/app-link.ts)
    const value = next && typeof next === 'object' ? next : { state: 'off' };
    if (appLink !== undefined && appKey(value) === appKey(appLink)) return;
    appLink = value;
    mark(marks, 'app', String(appLink.state ?? 'off')); // test/debug hook
    sayApp();
  }
  Margin.content.appDraws = () => appUi();
  // ⌘T reaching the page (Safari's File › New Tab given another shortcut).
  // Linked, in a window the app draws over, it's the app's (its hot key,
  // PLAN.md §6): nothing here. Not linked, or in
  // a window the app said it draws nothing over (`drawn`: not in full screen,
  // not found yet; its hot key isn't on there), a new tab: Margin's new-tab
  // page, which has an address field (background/handlers.ts newTabKey;
  // Safari's own `new-tab` command for the same press counts once).
  addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.code !== 'KeyT' || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || retired() || appLink === undefined) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (!drawsWindow(appLink, windowId ?? helloWindowId)) void send('newTabKey', {}, false);
  }, true);

  // The page being left, or a site's own same-page navigation under way:
  // told for Margin.app's sidebar to show it loading (content/loads.ts).
  startLoads({ on: () => appUi() && active(), send: (type, payload) => send(type, payload, false) });

  // ---- data ---------------------------------------------------------------

  let tabId: number | null = null;
  let helloWindowId: number | null = null;
  let windowId: number | null = null;

  // ---- this copy, and standing back ---------------------------------------------
  // Until this copy owns the state and has matched the open tabs (after Safari
  // starts, or Margin is updated), the stored tabs are another copy's. Its
  // background says whether a newer copy runs (`hello`, and `owner` when
  // another copy has claimed the state since): this one then stands back.
  let storedOwner: { origin: string, [more: string]: unknown } | null = null; // (storage's `owner`: shared/owner.ts)
  let waitedSince = 0;
  let mySince: number | null = null; // this copy's start, from hello
  let storedTabsBy: { origin?: string, since?: number, synced?: boolean } | null = null;
  let storageSeen = false;
  function ownerSeen(owner: { origin: string, [more: string]: unknown } | null | undefined, openTabsBy: { origin?: string, since?: number, synced?: boolean } | null | undefined) {
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
  // Out of the way: no keys or gestures from this copy (Safari runs both
  // copies until it quits; this page can only reach the older one).
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
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') shown(); });
  addEventListener('pageshow', (event) => event.persisted && shown());

  // Where the page is scrolled, kept with its Margin tab and taken once when it's opened again
  // (content/scroll-record.ts).
  const scrollRecord = startScrollRecord({ send, retired });

  // The state taken: this page's tab and window, the gestures' settings.
  let firstRender = true; // until the page first takes the state
  function render() {
    if (!state) return;
    if (fullscreenOnly() && fullscreen === null) return; // until the background says (above)
    // Known tab → its window. Until the background answers `hello`, guess.
    windowId = state.tabs?.[tabId as number]?.windowId ?? helloWindowId ?? V.guessWindow(state, location.href);
    if (tabId != null) scrollRecord.take(!!state.tabs?.[tabId]?.restoreScroll);
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
  // with the rest (shared/stored.ts pageKeys).
  const seenKeys = new Set<any>();
  async function refresh() {
    const mine = ++version;
    reading++;
    const missedBefore = changedDuringRead;
    let raw;
    try {
      // All of storage the first time; then all but the site icons, unless
      // they changed (shared/stored.ts readForPage).
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
    render();
    return true;
  }
  Margin.content.getState = () => ({ state, tabId, windowId });
  // Hidden, a page keeps its state current from the change events (they
  // carry the values) without taking them further: shown() does it at once.
  // Shown, it takes them the same way; it reads storage again only when an
  // event can't be taken (shared/stored.ts takesChanges), before it first has
  // the state, and whenever it's shown.
  // The background's note of a tab being shown is for that tab's page only.
  const onlyShowing = (changes: Record<string, BrowserStorageChange>) => Object.keys(changes).every((key) => key === 'showing');
  let changedWhileHidden = false;
  const onStorageChanged = (changes: Record<string, BrowserStorageChange>, area: string) => {
    if (area !== 'local' || dormant) return;
    // The theme's package is for Margin.app (background/theme-package.ts): nothing here.
    if ('uiTheme' in changes) {
      const { uiTheme: _, ...rest } = changes;
      if (!Object.keys(rest).length) return;
      changes = rest;
    }
    // Margin.app's link (background/link.ts): not state.
    if (APP_LINK_KEY in changes) {
      setAppLink(changes[APP_LINK_KEY].newValue);
      const { [APP_LINK_KEY]: _, ...rest } = changes;
      if (!Object.keys(rest).length) return;
      changes = rest;
    }
    // The data set's times for Margin.app, written on their own (background/
    // store.ts): nothing the state has.
    if (Object.keys(changes).every((key) => key.startsWith('dataMeta:'))) return;
    for (const key of Object.keys(changes)) seenKeys.add(key);
    if (!firstRender && onlyShowing(changes)) return;
    const read = () => void refresh();
    if (firstRender || !state) return read();
    if (!document.hidden) {
      if (tabId == null || staleRead || !takesChanges(changes, { reading, openTabsBy: (state as any).openTabsBy })) return read();
      const next = withChanges(state, changes);
      if (!next.spaces?.length) return read();
      version++; // newer than any read started before it
      state = next;
      if ('owner' in changes || 'openTabs' in changes) ownerSeen(next.owner, next.openTabsBy);
      if (onlyMark(changes)) return;
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
    const nav = (performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined);
    const fmt = (n: number | undefined) => (n == null ? '–' : `${Math.round(n)}`);
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
    Margin.content.instanceId = ctx.instanceId; // see background.ts injectIntoOpenTabs
    // Which copy's tab ids this page may trust: the stored ones are checked
    // again against it (Chrome keeps its address across restarts).
    if (Number.isFinite(ctx.since)) {
      mySince = ctx.since;
      if (storageSeen) ownerSeen(storedOwner, storedTabsBy);
    }
    helloWindowId = ctx.windowId;
    fullscreen = ctx.fullscreen;
    cardKeys.set((ctx as { card?: boolean }).card === true);
    appPinned = (ctx as { pinned?: boolean }).pinned === true;
    // The background's word on the link (it may be newer than storage's).
    if (ctx.app !== undefined) {
      const drawn = { ...(appLink?.drawn ?? {}) };
      if (typeof ctx.app?.drawn === 'boolean' && ctx.windowId != null) drawn[ctx.windowId] = ctx.app.drawn;
      setAppLink(ctx.app ? { ...(appLink ?? {}), state: ctx.app.state, drawn } : { state: 'off', drawn: {} });
    }
    sayApp();
    render(); // its window is known now
  });

  // Safari gives extensions no favicons: tell the background which icon this
  // page uses (it fetches and stores it once per site). Again on load, for
  // pages that add their icon from script.
  let reportedIcon: string | null = null;
  function reportIcon() {
    if (!capabilities?.fetchFavicons) return; // the browser provides icons (Chrome)
    const links = [...(document.querySelectorAll('link[rel]') as NodeListOf<HTMLLinkElement>)].map((l) => ({
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

  const mediaWatcher = startMedia({
    send: (report) => {
      if (!dormant) void send('mediaState', report);
    },
  });
  // Peek's link clicks (content/peek.ts): only in a window Margin.app draws, never in a copy that stood back; the
  // card asked of the background (which asks the app: background/peek.ts), the link opening as it would have when
  // the app doesn't take it in time.
  // (This tab's window one Margin.app draws: main's, a card's or a split pane's; never in a copy that stood back.)
  const drawnHere = () => !dormant && appLink !== undefined && drawsWindow(appLink, windowId ?? helloWindowId);
  startPeek({
    isDrawn: drawnHere,
    isPinnedOrFav: () => {
      // (Margin.app's library says so for its items: the copy's own state doesn't have its pins.)
      if (appPinned) return true;
      const s = state;
      if (!s) return false;
      const t = tabId != null ? s.tabs?.[tabId] : null;
      if (t?.pinnedBy || t?.favoriteId) return true;
      const key = V.normalizeUrl(location.href);
      const sp = tabId != null ? s.tabSpace?.[tabId] : null;
      if (sp && (s.pins ?? []).some((p: any) => p.spaceId === sp && V.normalizeUrl(p.url) === key)) return true;
      return (s.favorites ?? []).some((f: any) => V.normalizeUrl(f.url) === key);
    },
    autoPeekEnabled: () => state?.settings?.autoPeekPins !== false,
    ask: async (url, source, newTab) => {
      const res = await send('openPeek', { url, source, newTab, notAfter: Date.now() + PEEK_ANSWER_MS - 50 }, false);
      // (Refused, but the background opened the new tab already: done as the page would have had it.)
      return res?.hosted === true || res?.opened === true;
    },
    fallback: ({ url, newTab }) => {
      if (!newTab) return void location.assign(url);
      // (No background to open it: the page's own way, which Safari may block this long after the click.)
      window.open(url, '_blank', 'noopener');
    },
  });
  // A pin's or favorite's item in Margin.app (the copy says so: hello's `pinned`, then `peekPinned`).
  let appPinned = false;
  // Esc and ⌘↩ in a page of the card's window (the copy says which: hello's `card`, then `cardWindow`).
  const cardKeys = startCardKeys({ send: (key) => { if (!dormant) void send('cardKey', { key }, false); } });
  // An Esc the page left alone never takes Safari's window out of full screen where Margin.app draws it
  // (content/keep-fullscreen.ts): decided after the page's listeners and the card's.
  startKeepFullscreen({ isDrawn: drawnHere });
  const onMessage = (message: any, _: BrowserMessageSender, sendResponse: (response?: any) => void) => {
    // Whether this page was opened from nothing (no referrer, its first
    // history entry), for the note on Safari's "New tabs open with"
    // (extension/engines/webkit/safari/newtab-hint.ts: Margin.app's overlay says it).
    if (message?.type === 'newtab-hint') return sendResponse({ fromNothing: !document.referrer && history.length === 1 });
    if (message?.type === 'windowState') return setFullscreen(!!message.fullscreen);
    // This page's tab in the card's window of Margin.app's Peek, or out of it (background/hosted.ts).
    if (message?.type === 'cardWindow' && typeof message.on === 'boolean') return cardKeys.set(message.on);
    if (message?.type === 'peekPinned' && typeof message.on === 'boolean') { appPinned = message.on; return; }
    if (message?.type === 'mediaCommand' && typeof message.command === 'string') {
      return sendResponse({ ok: mediaWatcher.command(message.command) });
    }
    // Whether Margin.app draws over this window, as it changes (background.ts appLink.onDrawn).
    if (message?.type === 'appDrawn' && Number.isInteger(message.windowId) && typeof message.drawn === 'boolean') {
      if (!appLink) return;
      setAppLink({ ...appLink, drawn: { ...(appLink.drawn ?? {}), [message.windowId]: message.drawn } });
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
