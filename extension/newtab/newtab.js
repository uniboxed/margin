// Margin's new-tab page (the browser's new-tab override) and its start page
// (#launcher): the active theme drawn by Margin's UI runtime (ui/runtime.js)
// in the page itself, with its launcher part (search, the space's pins as
// tiles, recently archived, Settings) beside the sidebar. The theme package
// is read from the extension's own files (this is an extension page).
import { createRuntime } from '../ui/runtime.js';
import { createInPageHost } from '../ui/host.js';
import { loadBuiltinTheme, BUILTIN_THEMES } from '../ui/theme-loader.js';
import { installNewTabKey } from '../content/palette.js';
import { installGestureGuard } from '../shared/gestures.js';
import * as shortcuts from '../shared/shortcuts.js';
import * as V from '../shared/view.js';
import { asBrowserUi } from '../shared/dom.js';
import { asksBackground, platform } from '../shared/platform.js';
import { createSwitching, backgroundSwitches, SWITCH_GRACE_MS } from '../shared/switching.js';
/** @import { MessageType, Request, Result } from '../../types/margin' */

const api = globalThis.browser ?? globalThis.chrome;

/**
 * @template {MessageType} K
 * @param {K} type a handler in background.js
 * @param {Request<K>} [payload]
 * @returns {Promise<Result<K>>}
 */
// Never waited on forever (as on web pages, content/core.js send): a request
// with no answer in SEND_TIMEOUT_MS resolves to nothing, as a failed one does.
// A new tab from the palette answers once it's in front, after its page has
// loaded (background/tabs.js openBehind): longer.
const SEND_TIMEOUT_MS = 8000;
const LOADING_TIMEOUT_MS = 12000;
async function send(type, payload = {}) {
  if (!asksBackground(type)) return undefined;
  let timer;
  const loading = type === 'newTab' || type === 'search';
  // (A switch that says how long it waits past its deadline: that long.)
  const waitMs = Number.isFinite(payload?.waitsUntil) ? Math.max(0, payload.waitsUntil - Date.now()) : loading ? LOADING_TIMEOUT_MS : SEND_TIMEOUT_MS;
  // When this page stops waiting: the background doesn't switch after it.
  const res = await Promise.race([
    api.runtime.sendMessage({ type, ...(loading && !payload?.deadline ? { deadline: Date.now() + waitMs } : {}), ...payload }),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); }),
  ]).finally(() => clearTimeout(timer));
  if (res && !res.ok) console.warn('[margin]', type, res.error);
  return res?.result;
}

// ---- ⌘T / ⌘N ----------------------------------------------------------------
// Safari and Chrome never let extensions intercept ⌘T/⌘N; they open this
// page instead. On a fresh new tab (not Back, not a reload), ask the
// background at once, before anything else here (every moment this tab is in
// front shows): for ⌘T it opens the palette over the tab the user was on and
// shows that again, closing this one (Arc keeps the page; the keyboard is
// also in the address bar on a new tab, not here); otherwise (⌘N's first
// tab) the palette opens over this page.
const nav = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType?.('navigation')?.[0]);
// `newtab.html#launcher` opens the launcher on purpose and never redirects.
// `?again`: a page from a copy of Margin that's gone, loaded again at this
// copy's address (background/cut-off.js oldOwnPageAddress), not a new tab.
const isLauncher = location.hash === '#launcher';
const fresh = history.length <= 1 && (!nav || nav.type === 'navigate') && !isLauncher && !/[?&]again\b/.test(location.search);
const handoff = fresh ? send('newTabPage').catch(() => null) : Promise.resolve(null);

// The theme loads right away, alongside the ⌘T answer.
const { settings } = await api.storage.local.get('settings');
const themeId = BUILTIN_THEMES.includes(settings?.theme) ? settings.theme : BUILTIN_THEMES[0];
const loading = loadBuiltinTheme(themeId, { document, settings: settings?.themes?.[themeId] ?? null });
const self = await api.tabs.getCurrent();
// Chrome, "only in full screen" (content/core.js): outside full screen the
// page shows just a prompt offering it; the page redraws when that changes.
// The background says which (background/fullscreen.js isFullscreen).
const outOfTheWay = async () =>
  !!platform?.marginFullscreen && settings?.fullscreenOnly !== false && !(await send('windowState').catch(() => null))?.fullscreen;
const windowed = await outOfTheWay();
if (platform?.marginFullscreen) {
  let recheck = null;
  const check = () => {
    clearTimeout(recheck);
    recheck = setTimeout(async () => { if ((await outOfTheWay()) !== windowed) location.reload(); }, 300);
  };
  addEventListener('resize', check);
  api.windows.onBoundsChanged?.addListener((win) => win.id === self?.windowId && check());
}

// Draw the page unless this tab is being closed for the hand-off: wait a
// moment for the answer (the background may be waking up), never longer, so
// the page can't stay blank. A tab that was to close but didn't gets drawn too.
const HANDOFF_WAIT_MS = 300;
const early = await Promise.race([handoff, new Promise((resolve) => setTimeout(() => resolve('late'), HANDOFF_WAIT_MS))]);
if (typeof early === 'object' && early?.handled) await new Promise((resolve) => setTimeout(resolve, 1000));
const page = await mount(await loading);
handoff.then((res) => res?.openPalette && page.openPalette({ fresh: true }));

/** @param {any} theme */
async function mount(theme) {
  if (!theme.ok) {
    console.error('[margin] theme', themeId, 'refused:', theme.report?.errors);
    return { openPalette() {} };
  }

  // ---- the fresh new tab's palette ------------------------------------------
  // A fresh tab whose palette opened here (a new window, or a previous tab
  // without Margin; newtab/newtab.js): closing it without choosing (Escape,
  // clicking away) closes the tab again, back to the tab the user was on
  // (the window's only tab stays, as the start page); choosing another tab,
  // a pin or an archived tab doesn't leave it behind, empty.
  let freshPalette = false;
  let cancelOnClose = false;
  let leaving = null; // the request chosen in a fresh palette that takes the user elsewhere
  const LEAVES = new Set(['activateTab', 'openPin', 'newWindow']);
  addEventListener('pagehide', () => { freshPalette = false; cancelOnClose = false; });
  const onPalette = (what, request) => {
    if (what === 'close' && cancelOnClose) void send('cancelNewTab');
    if (what === 'run' && freshPalette && request?.kind === 'send' && LEAVES.has(request.type)) leaving = request.type;
    freshPalette = false;
    cancelOnClose = false;
  };

  // ---- requests --------------------------------------------------------------
  // A switch (from the sidebar, the palette or a pin tile) says when this
  // page stops waiting for it (as on web pages: a switch asked late is
  // still shown); an archived tab restored takes this tab's place; a pin
  // with no tab of its own opens here, on a new-tab page.
  const SWITCHES = new Set(['activateTab', 'openPin', 'setSpace']);
  const go = (url) => api.tabs.update(self.id, { url });
  async function hostSend(type, payload = {}) {
    if (type === 'restoreArchive') payload = { ...payload, replaceTabId: self?.id };
    if (type === 'openPin' && !isLauncher) {
      const state = host.getState();
      const pin = state?.pins?.find((p) => p.id === payload.pinId);
      if (pin && V.pinTabId(state, pin.id, payload.windowId ?? host.windowId) == null) { void go(pin.url); return { shown: self.id }; }
    }
    if (SWITCHES.has(type) && !Number.isFinite(payload.deadline)) {
      const deadline = Date.now() + 7000;
      payload = { ...payload, deadline, waitsUntil: deadline + SWITCH_GRACE_MS };
    }
    const mine = leaving === type;
    if (mine) leaving = null;
    const result = await send(/** @type {any} */ (type), payload);
    // Only once another tab is in front (a switch that didn't happen leaves
    // this page, so Safari doesn't pick some other tab, maybe another space's).
    if (mine && (type === 'newWindow' || result?.shown != null) && self?.id != null) api.tabs.remove(self.id).catch(() => {});
    return result;
  }

  // Margin's prompt: Chrome outside full screen, when Margin is used only there.
  const prompts = {
    fullscreen: {
      id: 'fullscreen', title: 'Margin works in full screen',
      text: 'There Chrome’s toolbar stays out of the way: Margin’s sidebar and palette take its place.',
      actions: [{ id: 'go', label: 'Go full screen', primary: true }, { id: 'always', label: 'Use in windows too' }],
    },
  };
  const host = createInPageHost({
    api,
    window,
    platform: { browser: platform?.name ?? 'unknown', os: 'mac', marginFullscreen: !!platform?.marginFullscreen },
    tabId: self?.id ?? null,
    windowId: self?.windowId ?? null,
    mode: 'inpage',
    inNewTab: !isLauncher,
    launcher: true,
    send: hostSend,
    perform: (name, arg) => {
      if (name === 'navigate') { void go(arg?.url); return true; }
      if (name === 'prompt' && arg?.id === 'fullscreen') {
        if (arg.action === 'go') void send('toggleFullscreen', { windowId: self?.windowId });
        if (arg.action === 'always') void send('updateSettings', { patch: { fullscreenOnly: false } }).then(() => location.reload());
        return true;
      }
      if (name === 'prompt' || name === 'notice') return true;
      return undefined;
    },
  });

  // ---- the page --------------------------------------------------------------
  // Browser UI, not a web page: nothing to select or right-click (but text
  // fields; shared/dom.js asBrowserUi). Zoomed (⌘+ / ⌘−), Margin keeps its
  // size, as on web pages (content/core.js): read at start and after a resize.
  asBrowserUi(document);
  const switching = createSwitching({
    onChange: (id) => runtime?.setUi({ switchingTo: id }),
    onSlow() {},
    // A switch that didn't happen (the tab is gone): over at once, the
    // sidebar drawn again (as on web pages).
    failed: (result) => result === undefined,
    onFailed: () => void host.refresh(),
  });
  const fromBackground = backgroundSwitches();
  /** @type {any} */
  let runtime = null;
  runtime = createRuntime({ host, theme, container: document, onPalette, onSwitchFailed: () => void host.refresh() });
  if (windowed) runtime.setUi({ prompt: prompts.fullscreen });

  let pageZoom = 1;
  const applyZoom = (z) => {
    if (!Number.isFinite(z) || z <= 0 || Math.abs(z - pageZoom) < 0.001) return;
    pageZoom = z;
    const root = /** @type {HTMLElement | null} */ (runtime.view.rootElement());
    root?.style.setProperty('zoom', String(1 / z));
    document.documentElement.style.setProperty('--page-zoom', String(z));
  };
  // From the browser itself (this page has the tabs API).
  const readZoom = () => (self?.id != null ? api.tabs.getZoom(self.id) : Promise.reject()).then((z) => applyZoom(Number(z)), () => {});
  let zoomTimer = null;
  addEventListener('resize', () => {
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(readZoom, 60);
  });
  readZoom();

  // Settings chose another theme: drawn again with it.
  host.onState((state) => {
    if ((state?.settings?.theme ?? themeId) !== themeId && BUILTIN_THEMES.includes(state.settings.theme)) location.reload();
    gestureGuard?.update();
  });

  // Safari's trackpad swipe and pinch (Safari builds only).
  const gestureGuard = platform?.blockGestures ? installGestureGuard({ getSettings: () => host.getState()?.settings }) : null;
  // Navigation shortcuts from Settings (next/previous tab and space; the
  // sidebar is always visible here, so no peek). Not while a shortcut is
  // being recorded in Settings.
  const recording = () => !!runtime?.ui.recording;
  shortcuts.installNavigation({ send, getSettings: () => (recording() ? null : host.getState()?.settings) });

  // "+ New Tab" (and ⌘T): the palette. On Margin's start page (#launcher) it
  // chooses a new tab, as on a web page; on a new-tab page, what's chosen
  // opens here.
  const onNewTab = () => runtime.openPalette({ newTab: isLauncher });
  // ⌘T (the palette's key) once the browser's New Tab has another shortcut.
  installNewTabKey(() => {
    void send('newTabKeyUsed'); // for the Mac app's set-up window (background/onboarding.js)
    onNewTab();
  }, globalThis, recording);
  api.runtime.onMessage.addListener((message, _, sendResponse) => {
    if (message?.type === 'command' && message.tabId === self?.id && message.command === 'open-palette') {
      if (runtime.paletteOpen) runtime.closePalette();
      else runtime.openPalette({ newTab: false });
    }
    if (message?.type === 'command' && message.tabId === self?.id && message.command === 'new-tab' && !recording()) onNewTab(); // ⌘T (Safari's shortcut)
    // The background switching from this tab (next/previous tab;
    // shared/switching.js), answered with whether it's covered (never here).
    if (message?.type === 'switching' && message.from === self?.id && Number.isInteger(message.tabId)) {
      if (message.tabId === self?.id) switching.end();
      else switching.start(message.tabId, fromBackground.begin(message.tabId, message.switchId));
      sendResponse(false);
    }
    if ((message?.type === 'switch-done' || message?.type === 'switch-failed') && message.from === self?.id) fromBackground.settle(message);
  });

  // A fresh new tab (⌘T, ⌘N): the palette opens over this page once the
  // state is in.
  return {
    openPalette: ({ fresh: isFresh = false } = {}) => host.ready.then(async () => {
      if (!host.getState()) await new Promise((resolve) => { const off = host.onState(() => { off(); resolve(undefined); }); });
      freshPalette = isFresh;
      cancelOnClose = isFresh;
      runtime.openPalette({ newTab: false });
    }),
  };
}
