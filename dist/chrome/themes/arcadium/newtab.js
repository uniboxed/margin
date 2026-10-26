// Arcadium's new-tab page: the launcher (search, pinned tiles, recently
// archived) and Settings, beside the sidebar. newtab/newtab.html is Margin's
// own page; it loads this module (newtab.bundle.js) when Arcadium is the
// active theme and calls mount().
import * as S from '../../shared/search.js';
import * as V from '../../shared/view.js';
import * as shortcuts from '../../shared/shortcuts.js';
import { installGestureGuard } from '../../shared/gestures.js';
import { platform } from '../../shared/platform.js';
import { el } from '../../shared/dom.js';
import { installPaletteShortcut } from '../../content/palette.js';
import { THEMES, themeFor } from '../index.js';
import { avatar, createSidebar } from './sidebar.js';
import { createPalette } from './palette.js';
import { sidebarCss, newtabCss, newtabHtml } from './assets.js';

// Typed loosely as an input: most lookups are form controls.
const $ = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

// `self`: this tab; `send`: a message to the background. Returns
// { openPalette() } (newtab/newtab.js calls it for ⌘N's first tab).
/**
 * @param {{ api: any, self: any, send: import('../../../types/margin').Send }} context
 */
export function mount({ api, self, send }) {
  // Styles first (bundled, applied synchronously: no unstyled flash), then the
  // page.
  const sheet = (css) => {
    const s = new CSSStyleSheet();
    s.replaceSync(css);
    return s;
  };
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet(sidebarCss), sheet(newtabCss)];
  document.body.innerHTML = newtabHtml; // the theme's own markup (newtab.html)

  const dark = matchMedia('(prefers-color-scheme: dark)');
  const sidebar = createSidebar({ document, send, mode: 'newtab', onNewTab: () => palette.open() });
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

  // Fitted layout with "Keep open" (content/shell.js; Safari builds only).
  const fitPages = $('fit-pages');
  if (platform?.shell) {
    $('fit-setting').hidden = false;
    fitPages.addEventListener('change', () => send('updateSettings', { patch: { fitPages: fitPages.checked } }));
  }

  // Navigation shortcuts from Settings (next/previous tab and space; the
  // sidebar is always visible here, so no peek).
  shortcuts.installNavigation({ send, getSettings: () => (recording ? null : state?.settings) });

  // ---- palette ----------------------------------------------------------------

  const palette = createPalette({
    send,
    getState: () => state,
    getContext: () => ({ windowId: windowId(), tabId: self?.id, inNewTab: true, canToggleSidebar: false, canFullscreen: !!platform?.marginFullscreen }),
    onLocal: (action) => {
      if (action.local === 'navigate') go(action.url);
      if (action.local === 'search') send('search', { query: action.query, tabId: self.id });
    },
    colorScheme: () => (dark.matches ? 'dark' : 'light'),
  });
  installPaletteShortcut(palette, () => (recording ? null : state?.settings?.paletteShortcut ?? 'Alt+KeyK'));
  api.runtime.onMessage.addListener((message) => {
    if (message?.type === 'command' && message.tabId === self?.id && message.command === 'open-palette') palette.toggle();
  });

  // ---- keyboard shortcut settings -----------------------------------------------
  // Click a field, press a combination: it's saved. While recording, Margin's own
  // shortcuts are paused. A combination Safari/macOS keeps never arrives here,
  // which doubles as a test of what's usable.
  const shortcutInputs = [.../** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('.shortcut-input'))];
  const shortcutHelp = $('shortcut-help');
  const defaultHelp = shortcutHelp.textContent;
  const SHORTCUT_NAMES = { paletteShortcut: 'Command palette', sidebarShortcut: 'Show or hide the sidebar', nextTab: 'Next tab', prevTab: 'Previous tab', nextSpace: 'Next space', prevSpace: 'Previous space' };
  let recording = false;

  function currentShortcuts() {
    return {
      paletteShortcut: state?.settings?.paletteShortcut ?? 'Alt+KeyK',
      sidebarShortcut: state?.settings?.sidebarShortcut ?? 'Alt+KeyS',
      ...shortcuts.navigationFor(state?.settings),
    };
  }
  function saveShortcut(name, combo) {
    if (name === 'paletteShortcut' || name === 'sidebarShortcut') return send('updateSettings', { patch: { [name]: combo } });
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
    send('updateSettings', { patch: { paletteShortcut: 'Alt+KeyK', sidebarShortcut: 'Alt+KeyS', shortcuts: { ...shortcuts.NAVIGATION } } });
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
    $('archive-section').hidden = all.length === 0;
    $('archive-more').hidden = all.length <= 12;
    $('archive-more').textContent = showAllArchived ? 'Show fewer' : `Show all ${all.length}`;
    $('archive-list').replaceChildren(
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
  async function refresh() {
    const mine = ++version;
    const next = await api.storage.local.get(null);
    if (mine !== version || !next.spaces?.length) return;
    state = next;
    sidebar.update(state, { windowId: windowId(), tabId: self?.id });
    renderLauncher();
    palette.refresh();
    firstDrawn();
  }

  api.storage.onChanged.addListener((_, area) => area === 'local' && refresh());
  refresh();

  // A fresh new tab the background didn't hand to the previous tab (⌘N's first
  // tab): the palette opens over this page, once the state is in.
  return { openPalette: () => firstState.then(() => palette.open()) };
}
