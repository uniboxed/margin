const api = globalThis.browser ?? globalThis.chrome;
const { Margin } = globalThis;
const { el, avatar } = Margin.ui;
const $ = (id) => document.getElementById(id);

async function send(type, payload = {}) {
  const res = await api.runtime.sendMessage({ type, ...payload });
  if (res && !res.ok) console.warn('[margin]', type, res.error);
  return res?.result;
}

const dark = matchMedia('(prefers-color-scheme: dark)');
const sidebar = Margin.ui.createSidebar({ document, send, mode: 'newtab', onNewTab: () => palette.open() });
const applyTheme = () => sidebar.setTheme(dark.matches ? 'dark' : 'light');
applyTheme();
dark.addEventListener('change', applyTheme);
$('sidebar').append(sidebar.el);

const self = await api.tabs.getCurrent();
let state = null;
const windowId = () => state?.tabs?.[self?.id]?.windowId ?? self?.windowId;

// Navigate this tab rather than opening another one.
const go = (url) => api.tabs.update(self.id, { url });

// ---- launcher ---------------------------------------------------------------

$('search').addEventListener('submit', (event) => {
  event.preventDefault();
  const target = Margin.search.resolveInput($('query').value, state?.settings?.searchEngine);
  if (target) go(target.url);
});
// Safari focuses the address bar on a new tab; this only helps elsewhere.
$('query').focus();

$('pin-tiles').addEventListener('click', (event) => {
  const tile = event.target.closest('[data-pin-id]');
  const pin = state?.pins.find((p) => p.id === tile?.dataset.pinId);
  if (!pin) return;
  const key = Margin.view.normalizeUrl(pin.url);
  const open = Object.values(state.tabs).find((t) => t.id !== self.id && Margin.view.normalizeUrl(t.url) === key);
  if (open) send('activateTab', { tabId: open.id });
  else go(pin.url);
});

$('archive-list').addEventListener('click', (event) => {
  const row = event.target.closest('[data-archive-id]');
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

const engine = $('engine');
for (const { name, url } of Margin.search.SEARCH_ENGINES) engine.append(el(document, 'option', { value: url, text: name }));
engine.addEventListener('change', () => send('updateSettings', { patch: { searchEngine: engine.value } }));

// Safari's trackpad swipe/pinch (Safari builds only).
const blockGestures = $('block-gestures');
if (Margin.platform?.blockGestures) {
  $('gestures-setting').hidden = false;
  Margin.gestures.installGestureGuard({ getSettings: () => state?.settings });
  blockGestures.addEventListener('change', () => send('updateSettings', { patch: { blockGestures: blockGestures.checked } }));
}

// Navigation shortcuts from Settings (next/previous tab and space; the
// sidebar is always visible here, so no peek).
Margin.shortcuts.installNavigation({ send, getSettings: () => (recording ? null : state?.settings) });

// ---- palette ----------------------------------------------------------------

const palette = Margin.createPalette({
  send,
  getState: () => state,
  getContext: () => ({ windowId: windowId(), tabId: self?.id, inNewTab: true, canToggleSidebar: false }),
  onLocal: (action) => action.local === 'navigate' && go(action.url),
  theme: () => (dark.matches ? 'dark' : 'light'),
});
Margin.installPaletteShortcut(palette, () => (recording ? null : state?.settings?.paletteShortcut ?? 'Alt+KeyK'));
api.runtime.onMessage.addListener((message) => {
  if (message?.type === 'command' && message.tabId === self?.id && message.command === 'open-palette') palette.toggle();
});

// ---- keyboard shortcut settings -----------------------------------------------
// Click a field, press a combination: it's saved. While recording, Margin's own
// shortcuts are paused. A combination Safari/macOS keeps never arrives here,
// which doubles as a test of what's usable.
const shortcutInputs = [...document.querySelectorAll('.shortcut-input')];
const shortcutHelp = $('shortcut-help');
const defaultHelp = shortcutHelp.textContent;
const SHORTCUT_NAMES = { paletteShortcut: 'Command palette', nextTab: 'Next tab', prevTab: 'Previous tab', nextSpace: 'Next space', prevSpace: 'Previous space' };
let recording = false;

function currentShortcuts() {
  return { paletteShortcut: state?.settings?.paletteShortcut ?? 'Alt+KeyK', ...Margin.shortcuts.navigationFor(state?.settings) };
}
function saveShortcut(name, combo) {
  if (name === 'paletteShortcut') return send('updateSettings', { patch: { paletteShortcut: combo } });
  return send('updateSettings', { patch: { shortcuts: { ...Margin.shortcuts.navigationFor(state?.settings), [name]: combo } } });
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
  const combo = Margin.shortcuts.fromEvent(event);
  if (!combo || !Margin.shortcuts.parse(combo)) return;
  const name = input.dataset.shortcut;
  const taken = Object.entries(currentShortcuts()).find(([other, value]) => other !== name && value === combo);
  if (taken) return showHelp(`${Margin.shortcuts.format(combo)} is already used for “${SHORTCUT_NAMES[taken[0]]}”.`, true);
  showHelp(defaultHelp);
  saveShortcut(name, combo);
  input.blur();
}, true);
$('shortcuts-reset').addEventListener('click', () => {
  showHelp(defaultHelp);
  send('updateSettings', { patch: { paletteShortcut: 'Alt+KeyK', shortcuts: { ...Margin.shortcuts.NAVIGATION } } });
});

function ago(ts) {
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function renderLauncher() {
  const view = Margin.view.sidebar(state, windowId());
  $('pins-section').hidden = view.pins.length === 0;
  $('pin-tiles').replaceChildren(
    ...view.pins.map((p) =>
      el(document, 'li', { class: 'tile', 'data-pin-id': p.id, title: p.url }, avatar(document, { ...p, favIconUrl: Margin.view.iconFor(state, p) }), el(document, 'span', { class: 'title', text: p.title })),
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
        avatar(document, { ...a, favIconUrl: Margin.view.iconFor(state, a) }),
        el(document, 'span', { class: 'title', text: a.title || a.url }),
        el(document, 'span', { class: 'when', text: ago(a.closedAt) })),
    ),
  );

  const known = Margin.search.SEARCH_ENGINES.some((e) => e.url === state.settings.searchEngine);
  if (!known && state.settings.searchEngine) {
    engine.append(el(document, 'option', { value: state.settings.searchEngine, text: 'Custom' }));
  }
  engine.value = state.settings.searchEngine;
  blockGestures.checked = state.settings.blockGestures !== false;
  if (document.activeElement !== hours) hours.value = String(state.settings.archiveAfterHours);
  if (!recording) {
    const values = currentShortcuts();
    for (const input of shortcutInputs) input.value = Margin.shortcuts.format(values[input.dataset.shortcut]);
  }
}

// ---- data -------------------------------------------------------------------

let version = 0;
async function refresh() {
  const mine = ++version;
  const next = await api.storage.local.get(null);
  if (mine !== version || !next.spaces?.length) return;
  state = next;
  sidebar.update(state, { windowId: windowId(), tabId: self?.id });
  renderLauncher();
  palette.refresh();
}

api.storage.onChanged.addListener((_, area) => area === 'local' && refresh());
refresh();

// ---- ⌘T / ⌘N ----------------------------------------------------------------
// Safari never lets extensions intercept ⌘T/⌘N; it opens this page instead.
// On a fresh new tab (not Back, not a reload), ask the background: for ⌘T it
// returns to the previous tab and opens the palette there, closing this tab;
// otherwise (⌘N's first tab) the palette opens over this page.
const nav = performance.getEntriesByType?.('navigation')?.[0];
// `newtab.html#launcher` opens the launcher on purpose and never redirects.
const fresh = history.length <= 1 && (!nav || nav.type === 'navigate') && location.hash !== '#launcher';
if (fresh) {
  send('newTabPage').then((res) => res?.openPalette && palette.open());
}
