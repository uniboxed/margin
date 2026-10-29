// Arcadium's new-tab page: the launcher (search, pinned tiles, recently
// archived) and Settings, beside the sidebar. newtab/newtab.html is Margin's
// own page; it loads this module (newtab.bundle.js) when Arcadium is the
// active theme and calls mount().
import * as S from '../../shared/search.js';
import * as V from '../../shared/view.js';
import * as shortcuts from '../../shared/shortcuts.js';
import { installGestureGuard } from '../../shared/gestures.js';
import { platform } from '../../shared/platform.js';
import { fromStorage } from '../../shared/stored.js';
import { el, asBrowserUi, setPageZoom } from '../../shared/dom.js';
import { installNewTabKey, newTabCloser, reportingSwitches } from '../../content/palette.js';
import { createSwitching, backgroundSwitches } from '../../shared/switching.js';
import { THEMES, themeFor } from '../index.js';
import { avatar, createSidebar } from './sidebar.js';
import { createPalette } from './palette.js';
import { createSwitchCover } from './chrome.js';
import { sidebarCss, newtabCss, newtabHtml } from './assets.js';

// Typed loosely as an input: most lookups are form controls.
const $ = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

// `self`: this tab; `send`: a message to the background; `windowed`: Margin
// is out of the way here (Chrome, not in full screen), so just a note
// offering full screen. Returns { openPalette({ fresh }) } (newtab/newtab.js calls it
// for ⌘N's first tab).
/**
 * @param {{ api: any, self: any, send: import('../../../types/margin').Send, windowed?: boolean }} context
 */
export function mount({ api, self, send, windowed = false }) {
  if (windowed) return mountNote({ self, send });
  // Styles first (bundled, applied synchronously: no unstyled flash), then the
  // page.
  const sheet = (css) => {
    const s = new CSSStyleSheet();
    s.replaceSync(css);
    return s;
  };
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet(sidebarCss), sheet(newtabCss)];
  document.body.innerHTML = newtabHtml; // the theme's own markup (newtab.html)

  // Browser UI, not a web page: nothing to select or right-click (but text
  // fields; shared/dom.js asBrowserUi). Zoomed (⌘+ / ⌘−), the launcher grows
  // and the sidebar, the frame and the palette keep their size, as on web
  // pages (content/core.js): read at start and after a resize.
  asBrowserUi(document, { zoomable: (event) => !!/** @type {Element} */ (event.target).closest?.('#launcher, #page-card') });
  let pageZoom = 1;
  const applyZoom = (z) => {
    if (!Number.isFinite(z) || z <= 0 || Math.abs(z - pageZoom) < 0.001) return;
    pageZoom = z;
    document.documentElement.style.setProperty('--page-zoom', String(z));
    $('sidebar').style.setProperty('zoom', String(1 / z));
    setPageZoom(document, z);
  };
  let zoomAnswered = false; // until then, the last zoom seen here (storage pageZoom)
  // From the browser itself (this page has the tabs API; through the
  // background, an extension page may not count as a tab).
  const readZoom = () => (self?.id != null ? api.tabs.getZoom(self.id) : Promise.reject()).then((z) => {
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

  const dark = matchMedia('(prefers-color-scheme: dark)');
  // The tab list's scroll position is the window's (background/scroll.js),
  // shared with the sidebars on its pages.
  let scrollTimer = null;
  let scrollTop = 0;
  let scrollGen = 0; // the user's own scrolling wins over a late reply
  const flushScroll = () => {
    if (scrollTimer == null) return;
    clearTimeout(scrollTimer);
    scrollTimer = null;
    send('setSidebarScroll', { top: scrollTop });
  };
  const onScroll = (top) => {
    scrollGen++;
    scrollTop = top;
    scrollTimer ??= setTimeout(flushScroll, 150);
  };
  // Saved before a switch from the sidebar, so the next page asks for the right one.
  const SWITCHES = new Set(['activateTab', 'openPin', 'closeTab', 'setSpace']);
  /** @type {import('../../../types/margin').Send} */
  const sidebarSend = (type, payload, ...rest) => {
    if (!SWITCHES.has(type)) return send(type, payload, ...rest);
    const sidebarTop = scrollTimer == null ? null : scrollTop;
    flushScroll();
    // A switch also says the tab's address and place (as on web pages,
    // content/core.js send).
    const tab = Number.isInteger(/** @type {any} */ (payload)?.tabId) ? state?.tabs?.[/** @type {any} */ (payload).tabId] : null;
    return send(type, {
      .../** @type {any} */ (payload),
      ...(Number.isFinite(sidebarTop) ? { sidebarTop } : {}),
      ...(tab ? { hint: { url: tab.url, index: tab.index, title: tab.title, from: /** @type {any} */ (state)?.openTabsBy ?? null } } : {}),
      // No switch after this page stops waiting (as on web pages).
      ...(type === 'closeTab' ? {} : { deadline: Date.now() + 7000 }),
    }, ...rest);
  };
  // On Margin's start page (#launcher), "+ New Tab" chooses a new tab as on a
  // web page: highlighted until the palette closes, and what's chosen opens
  // in a new tab. On a new-tab page it's this tab: the palette opens over it.
  const isLauncher = location.hash === '#launcher';
  let newTabPending = false;
  const setNewTabPending = (/** @type {boolean} */ on) => {
    if (newTabPending === on) return;
    newTabPending = on;
    if (state) sidebar.update(state, { windowId: windowId(), tabId: self?.id, newTabPending, switchingTo });
  };
  const closer = newTabCloser(setNewTabPending);
  // A switch to another tab from here (shared/switching.js): highlighted at
  // once, and the empty screen over this page until the other tab is in
  // front (chrome.js createSwitchCover), as over web pages.
  // As on web pages (content/core.js): `when` is 'now' (a click here),
  // 'slow' (a next/previous key) or 'none' (a held key passing through).
  let switchingTo = null;
  let when = 'now';
  const cover = createSwitchCover(document);
  $('page-card').append(cover.el);
  const switching = createSwitching({
    onChange: (id) => {
      switchingTo = id;
      if (id == null || when === 'now') cover.set(id != null, { instant: document.hidden });
      if (state) sidebar.update(state, { windowId: windowId(), tabId: self?.id, newTabPending, switchingTo });
    },
    onSlow: (slow) => slow && when === 'slow' && cover.set(true), // its spinner shows by itself
    // A switch that didn't happen (the tab is gone): over at once, the
    // sidebar drawn again (as on web pages).
    failed: (result) => result === undefined,
    onFailed: () => void refresh(),
  });
  const fromBackground = backgroundSwitches();
  // Back to this tab: over; a tab in another window: nothing to highlight here.
  const onSwitch = (/** @type {number} */ id, /** @type {Promise<unknown> | null} */ request, { cover: mode = 'now' } = {}) => {
    if (id === self?.id) return switching.end();
    if (state?.tabs?.[id]?.windowId !== windowId()) return;
    when = mode;
    switching.start(id, request);
  };
  const onNewTab = () => {
    if (isLauncher) {
      closer.cancel();
      setNewTabPending(true);
    }
    palette.open();
  };
  // The archive button: this page's own "Recently archived".
  // Shown even while empty once asked for ("Nothing archived yet").
  let archiveAsked = false;
  const onArchive = () => {
    archiveAsked = true;
    if (state) renderLauncher();
    $('archive-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const sidebar = createSidebar({ document, send: sidebarSend, mode: 'newtab', onNewTab, onArchive, onScroll, onSwitch });
  const applyColorScheme = () => sidebar.setColorScheme(dark.matches ? 'dark' : 'light');
  applyColorScheme();
  dark.addEventListener('change', applyColorScheme);
  $('sidebar').append(sidebar.el);

  /** @type {import('../../../types/margin').State | null} */
  let state = null;
  const windowId = () => state?.tabs?.[self?.id]?.windowId ?? self?.windowId;

  // Navigate this tab rather than opening another one.
  const go = (url) => api.tabs.update(self.id, { url });

  // Which engine searches use: always the browser's (shared/search.js).
  function renderSearchEngine() {
    const learned = state?.settings?.safariSearch;
    const text = platform?.search === 'browser'
      ? 'Searches use Chrome’s search engine (Chrome Settings → Search engine).'
      : learned
        ? `Searches use Safari’s search engine: ${learned.name} (seen in Safari’s address bar ${new Date(learned.at).toLocaleString()}). Margin follows it: after changing it in Safari → Settings → Search, search once from Safari’s address bar.`
        : `Searches use Safari’s default search engine (${S.SAFARI_DEFAULT.name}) until you search once from Safari’s address bar; from then on, whatever Safari uses (Safari → Settings → Search).`;
    $('engine-info').textContent = text;
  }

  // ---- launcher ---------------------------------------------------------------

  $('search').addEventListener('submit', (event) => {
    event.preventDefault();
    const target = S.resolveInput($('query').value);
    if (target?.kind === 'url') go(target.url);
    else if (target) send('search', { query: target.query, tabId: self.id }); // the browser's engine
  });
  // Safari focuses the address bar on a new tab; this only helps elsewhere.
  $('query').focus();

  $('pin-tiles').addEventListener('click', (event) => {
    const tile = /** @type {HTMLElement} */ (/** @type {Element} */ (event.target).closest('[data-pin-id]'));
    const pin = state?.pins.find((p) => p.id === tile?.dataset.pinId);
    if (!pin) return;
    const key = V.normalizeUrl(pin.url);
    const open = Object.values(state.tabs).find((t) => t.id !== self.id && V.normalizeUrl(t.url) === key);
    if (open) send('activateTab', { tabId: open.id });
    else go(pin.url);
  });

  $('archive-list').addEventListener('click', (event) => {
    const row = /** @type {HTMLElement} */ (/** @type {Element} */ (event.target).closest('[data-archive-id]'));
    if (row) send('restoreArchive', { archiveId: row.dataset.archiveId, replaceTabId: self.id });
  });

  let showAllArchived = false;
  $('archive-more').addEventListener('click', () => {
    showAllArchived = !showAllArchived;
    renderLauncher();
  });

  const hours = $('archive-hours');
  hours.addEventListener('change', () => {
    const value = Number(hours.value);
    if (Number.isFinite(value) && value >= 0) send('updateSettings', { patch: { archiveAfterHours: value } });
  });


  // Safari's trackpad swipe/pinch (Safari builds only).
  const blockGestures = $('block-gestures');
  const pullToRefresh = $('pull-to-refresh');
  const swipeNavigation = $('swipe-navigation');
  let gestureGuard = null;
  if (platform?.blockGestures) {
    $('gestures-setting').hidden = false;
    $('pull-setting').hidden = false;
    $('swipe-setting').hidden = false;
    gestureGuard = installGestureGuard({ getSettings: () => state?.settings });
    blockGestures.addEventListener('change', () => send('updateSettings', { patch: { blockGestures: blockGestures.checked } }));
    pullToRefresh.addEventListener('change', () => send('updateSettings', { patch: { pullToRefresh: pullToRefresh.checked } }));
    swipeNavigation.addEventListener('change', () => send('updateSettings', { patch: { swipeNavigation: swipeNavigation.checked } }));
  }

  // What Margin looks like: the new-tab page and pages loaded from now on use
  // the chosen theme.
  const themeSelect = $('theme');
  themeSelect.replaceChildren(...Object.values(THEMES).map((t) => el(document, 'option', { value: t.id, text: t.name, title: t.description })));
  themeSelect.addEventListener('change', async () => {
    await send('updateSettings', { patch: { theme: themeSelect.value } });
    location.reload();
  });

  // Margin full screen whenever the window goes full screen (Chrome builds only).
  const marginFullscreen = $('margin-fullscreen');
  const fullscreenOnly = $('fullscreen-only');
  if (platform?.marginFullscreen) {
    $('fullscreen-setting').hidden = false;
    marginFullscreen.addEventListener('change', () => send('updateSettings', { patch: { marginFullscreenAuto: marginFullscreen.checked } }));
    $('fullscreen-only-setting').hidden = false;
    fullscreenOnly.addEventListener('change', () => send('updateSettings', { patch: { fullscreenOnly: fullscreenOnly.checked } }));
  }

  // Fitted layout with "Keep open" (content/shell.js; Safari builds only).
  const fitPages = $('fit-pages');
  if (platform?.shell) {
    $('fit-setting').hidden = false;
    fitPages.addEventListener('change', () => send('updateSettings', { patch: { fitPages: fitPages.checked } }));
  }

  // The narrow icon rail on pages that are pushed (content/layout.js).
  // Only while the rail is available (platform.compactRail: off for now).
  const compactPushed = $('compact-pushed');
  compactPushed.closest('label').hidden = !platform?.compactRail;
  compactPushed.addEventListener('change', () => send('updateSettings', { patch: { compactWhenPushed: compactPushed.checked } }));

  // The note when ⌘T seems to open Safari's homepage (background/newtab-hint.js; Safari only).
  const newTabHint = $('newtab-hint');
  if (platform?.newTabHint) {
    $('newtab-hint-setting').hidden = false;
    newTabHint.addEventListener('change', () => send('updateSettings', { patch: { newTabHint: newTabHint.checked } }));
  }

  // Navigation shortcuts from Settings (next/previous tab and space; the
  // sidebar is always visible here, so no peek).
  shortcuts.installNavigation({ send, getSettings: () => (recording ? null : state?.settings) });

  // ---- palette ----------------------------------------------------------------

  // A fresh tab whose palette opened here (a new window, or a previous tab
  // without Margin; newtab/newtab.js): closing it without choosing (Escape,
  // clicking away) closes the tab again, back to the tab the user was on
  // (the window's only tab stays, as the start page); choosing another tab,
  // a pin or an archived tab doesn't leave it behind, empty.
  let fresh = false;
  let cancelOnClose = false;
  const LEAVES = new Set(['activateTab', 'openPin', 'newWindow']);
  /** @type {any} */
  const paletteSend = async (/** @type {any} */ type, /** @type {any} */ payload) => {
    if (!fresh || type === 'prewake') return send(type, payload);
    fresh = false;
    if (type === 'restoreArchive') return send(type, { ...payload, replaceTabId: self?.id });
    const result = await send(type, payload);
    // Only once another tab is in front (a switch that didn't happen leaves
    // this page, so Safari doesn't pick some other tab, maybe another space's).
    const left = type === 'newWindow' || result?.shown != null;
    if (LEAVES.has(type) && left && self?.id != null) api.tabs.remove(self.id).catch(() => {});
    return result;
  };
  addEventListener('pagehide', () => { fresh = false; cancelOnClose = false; });
  const palette = createPalette({
    send: reportingSwitches(paletteSend, () => state, onSwitch),
    onClose: (reason, action) => {
      if (newTabPending) closer.onClose(reason, action);
      if (reason !== 'run' && cancelOnClose) send('cancelNewTab');
      if (reason !== 'run') fresh = false;
      cancelOnClose = false;
    },
    getState: () => state,
    getContext: () => ({ windowId: windowId(), tabId: self?.id, inNewTab: !newTabPending, canToggleSidebar: false, canFullscreen: !!platform?.marginFullscreen }),
    onLocal: (action) => {
      if (action.local === 'navigate') go(action.url);
      if (action.local === 'search') send('search', { query: action.query, tabId: self.id });
    },
    colorScheme: () => (dark.matches ? 'dark' : 'light'),
  });
  // ⌘T (the palette's key) once the browser's New Tab has another shortcut:
  // as "+ New Tab" here.
  installNewTabKey(() => {
    void send('newTabKeyUsed'); // for the Mac app's set-up window (background/onboarding.js)
    onNewTab();
  }, globalThis, () => recording); // recording: Settings says it's taken
  api.runtime.onMessage.addListener((message) => {
    if (message?.type === 'command' && message.tabId === self?.id && message.command === 'open-palette') palette.toggle();
    if (message?.type === 'command' && message.tabId === self?.id && message.command === 'new-tab' && !recording) onNewTab(); // ⌘T (Safari's shortcut)
    // The background switching from this tab (next/previous tab; shared/switching.js).
    if (message?.type === 'switching' && message.from === self?.id && Number.isInteger(message.tabId)) onSwitch(message.tabId, fromBackground.begin(message.tabId), { cover: message.passing ? 'none' : 'slow' });
    if ((message?.type === 'switch-done' || message?.type === 'switch-failed') && message.from === self?.id) fromBackground.settle(message);
  });

  // ---- keyboard shortcut settings -----------------------------------------------
  // Click a field, press a combination: it's saved. While recording, Margin's own
  // shortcuts are paused. A combination Safari/macOS keeps never arrives here,
  // which doubles as a test of what's usable.
  const shortcutInputs = [.../** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('.shortcut-input'))];
  const shortcutHelp = $('shortcut-help');
  const defaultHelp = shortcutHelp.textContent;
  const SHORTCUT_NAMES = { newTab: 'New tab (the command palette)', sidebarShortcut: 'Show or hide the sidebar', nextTab: 'Next tab', prevTab: 'Previous tab', nextSpace: 'Next space', prevSpace: 'Previous space' };
  let recording = false;

  function currentShortcuts() {
    return {
      newTab: 'Meta+KeyT', // fixed: the palette's key (content/palette.js installNewTabKey)
      sidebarShortcut: state?.settings?.sidebarShortcut ?? 'Alt+KeyS',
      ...shortcuts.navigationFor(state?.settings),
    };
  }
  function saveShortcut(name, combo) {
    if (name === 'sidebarShortcut') return send('updateSettings', { patch: { [name]: combo } });
    return send('updateSettings', { patch: { shortcuts: { ...shortcuts.navigationFor(state?.settings), [name]: combo } } });
  }
  function showHelp(text, error = false) {
    shortcutHelp.textContent = text;
    shortcutHelp.classList.toggle('error', error);
  }

  for (const input of shortcutInputs) {
    input.addEventListener('focus', () => {
      recording = true;
      input.value = '';
      input.classList.add('recording');
    });
    input.addEventListener('blur', () => {
      recording = false;
      input.classList.remove('recording');
      renderLauncher();
    });
  }
  // Capture phase, so recording wins over Margin's shortcuts themselves.
  addEventListener('keydown', (event) => {
    const input = shortcutInputs.find((i) => i === event.target);
    if (!recording || !input) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Escape') return input.blur();
    const combo = shortcuts.fromEvent(event);
    if (!combo || !shortcuts.parse(combo)) return;
    const name = input.dataset.shortcut;
    const taken = Object.entries(currentShortcuts()).find(([other, value]) => other !== name && value === combo);
    if (taken) return showHelp(`${shortcuts.format(combo)} is already used for “${SHORTCUT_NAMES[taken[0]]}”.`, true);
    showHelp(defaultHelp);
    saveShortcut(name, combo);
    input.blur();
  }, true);
  $('shortcuts-reset').addEventListener('click', () => {
    showHelp(defaultHelp);
    send('updateSettings', { patch: { sidebarShortcut: 'Alt+KeyS', shortcuts: { ...shortcuts.NAVIGATION } } });
  });

  // DEVELOPMENT DIAGNOSTICS: remove before release (background/diagnostics.js).
  // The switch log as JSON on the clipboard, to send along with a report.
  const logStatus = $('switch-log-status');
  // The write starts within the click, the log following as a promise:
  // Safari refuses a clipboard write that only starts after an await.
  $('switch-log-copy').addEventListener('click', async () => {
    let count = 0;
    const text = send('switchLog', {}).then((entries) => {
      if (!Array.isArray(entries)) throw new Error('no log');
      count = entries.length;
      return new Blob([JSON.stringify({ version: api.runtime.getManifest().version, platform: platform?.name, entries })], { type: 'text/plain' });
    });
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text })]);
      logStatus.textContent = `Copied ${count} entries.`;
    } catch {
      logStatus.textContent = (await text.then(() => true, () => false)) ? 'Couldn’t copy.' : 'Couldn’t read the log.';
    }
  });
  $('switch-log-clear').addEventListener('click', async () => {
    await send('switchLog', { clear: true });
    logStatus.textContent = 'Cleared.';
  });

  function ago(ts) {
    const minutes = Math.round((Date.now() - ts) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
  }

  function renderLauncher() {
    const view = V.sidebar(state, windowId());
    $('pins-section').hidden = view.pins.length === 0;
    $('pin-tiles').replaceChildren(
      ...view.pins.map((p) =>
        el(document, 'li', { class: 'tile', 'data-pin-id': p.id, title: p.url }, avatar(document, { ...p, favIconUrl: V.iconFor(state, p) }), el(document, 'span', { class: 'title', text: p.title })),
      ),
    );

    const all = state.archive ?? [];
    const archive = showAllArchived ? all : all.slice(0, 12);
    $('archive-section').hidden = all.length === 0 && !archiveAsked;
    $('archive-more').hidden = all.length <= 12;
    $('archive-more').textContent = showAllArchived ? 'Show fewer' : `Show all ${all.length}`;
    $('archive-list').replaceChildren(
      ...(all.length ? [] : [el(document, 'li', { class: 'empty', text: 'Nothing archived yet' })]),
      ...archive.map((a) =>
        el(document, 'li', { 'data-archive-id': a.id, title: a.url },
          avatar(document, { ...a, favIconUrl: V.iconFor(state, a) }),
          el(document, 'span', { class: 'title', text: a.title || a.url }),
          el(document, 'span', { class: 'when', text: ago(a.closedAt) })),
      ),
    );

    renderSearchEngine();
    blockGestures.checked = state.settings.blockGestures !== false;
    // Margin's pull-to-refresh replaces Safari's, which only goes away with the bounce.
    pullToRefresh.checked = state.settings.pullToRefresh !== false;
    pullToRefresh.disabled = !blockGestures.checked;
    swipeNavigation.checked = state.settings.swipeNavigation !== false;
    swipeNavigation.disabled = !blockGestures.checked;
    fitPages.checked = state.settings.fitPages !== false;
    compactPushed.checked = state.settings.compactWhenPushed !== false;
    newTabHint.checked = state.settings.newTabHint !== false;
    marginFullscreen.checked = state.settings.marginFullscreenAuto !== false;
    fullscreenOnly.checked = state.settings.fullscreenOnly !== false;
    if (document.activeElement !== themeSelect) themeSelect.value = themeFor(state.settings).id;
    gestureGuard?.update();
    if (document.activeElement !== hours) hours.value = String(state.settings.archiveAfterHours);
    if (!recording) {
      const values = currentShortcuts();
      for (const input of shortcutInputs) input.value = shortcuts.format(values[input.dataset.shortcut]);
    }
  }

  // ---- data -------------------------------------------------------------------

  let version = 0;
  // Settles once the first state is drawn (the palette then has its space's color).
  let firstDrawn;
  const firstState = new Promise((resolve) => { firstDrawn = resolve; });
  let pendingScroll = null; // applied by the next refresh
  async function refresh() {
    const mine = ++version;
    const next = fromStorage(await api.storage.local.get(null));
    if (mine !== version || !next.spaces?.length) return;
    state = next;
    if (!zoomAnswered) applyZoom(Number((next.pageZoom?.[location.origin] ?? next.pageZoom?.['*'])?.[0] ?? 1));
    sidebar.update(state, { windowId: windowId(), tabId: self?.id, newTabPending, switchingTo, ...(pendingScroll != null ? { scroll: pendingScroll } : {}) });
    pendingScroll = null;
    renderLauncher();
    palette.refresh();
    firstDrawn();
  }

  // Not while hidden: it catches up when shown (below). Until its first
  // drawing it takes every change (the background may not have state yet).
  api.storage.onChanged.addListener((_, area) => area === 'local' && (!document.hidden || !state) && refresh());
  // Shown again (or first): the current state, at the window's scroll position.
  const shown = () => {
    const gen = scrollGen;
    send('sidebarScroll').then((top) => {
      if (!Number.isFinite(top) || gen !== scrollGen) return;
      pendingScroll = top;
      refresh(); // drawn with the state read now, then scrolled
    });
    refresh();
  };
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? shown() : flushScroll()));
  addEventListener('pagehide', flushScroll);
  addEventListener('pageshow', (event) => event.persisted && shown());
  shown();

  // A fresh new tab (⌘T, ⌘N): the palette opens over this page once the
  // state is in (the sidebar's "+ New Tab" row is highlighted meanwhile).
  return {
    openPalette: ({ fresh: isFresh = false } = {}) => firstState.then(() => {
      fresh = isFresh;
      cancelOnClose = isFresh;
      palette.open();
    }),
  };
}

// Outside full screen, when Margin is used only there (Chrome): a card
// saying so, with the way in.
function mountNote({ self, send }) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(newtabCss);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const go = el(document, 'button', { type: 'button', class: 'primary', text: 'Go full screen' });
  const always = el(document, 'button', { type: 'button', text: 'Use in windows too' });
  go.addEventListener('click', () => send('toggleFullscreen', { windowId: self?.windowId }));
  always.addEventListener('click', async () => {
    await send('updateSettings', { patch: { fullscreenOnly: false } });
    location.reload();
  });
  document.body.replaceChildren(el(document, 'main', { id: 'fullscreen-note' },
    el(document, 'h1', { text: 'Margin works in full screen' }),
    el(document, 'p', { text: 'There Chrome’s toolbar stays out of the way: Margin’s sidebar and palette take its place.' }),
    el(document, 'div', { class: 'actions' }, go, always)));
  return { openPalette() {} };
}
