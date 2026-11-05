// The browser side of the Arcadia parity check (tests/theme/parity.js):
// today's Arcadia (themes/arcadia: its sidebar, chrome, palette and new-tab
// launcher modules, mounted as content.js and newtab.js mount them) and the
// arcadia-2 package rendered by the UI runtime with a mock host, both fed
// the same fixed state. Bundled into one script and added to a blank page,
// whose white body stands for the web page under Margin.
import { createSidebar, avatar } from '../../extension/themes/arcadia/sidebar.js';
import { createChrome } from '../../extension/themes/arcadia/chrome.js';
import { createPalette } from '../../extension/themes/arcadia/palette.js';
import { sidebarCss, newtabCss, newtabHtml } from '../../extension/themes/arcadia/assets.js';
import { adoptStyles, createHost, mountHost, el } from '../../extension/shared/dom.js';
import * as V from '../../extension/shared/view.js';
import { loadTheme } from '../../extension/ui/theme-loader.js';
import { createRuntime } from '../../extension/ui/runtime.js';
import { createMockHost } from '../../extension/ui/host.js';
import { pngIcon } from './view-model.js';

const w = /** @type {any} */ (window);
const W = 1; // the window
const NOW = Date.now(); // the archive's "3h ago" is worked out from now, in both
const WIDTH = 280; // the sidebar's width (a setting: not the default 260)

// --- The fixed state ---------------------------------------------------------

const ICON = {
  red: pngIcon([200, 60, 50]), blue: pngIcon([40, 100, 200]), green: pngIcon([30, 150, 90]), gold: pngIcon([200, 150, 30]),
};
export function fixture({ pinnedOpen = true, frame = true, loading = false } = {}) {
  const tab = (id, title, url, extra = {}) => ({ id, windowId: W, index: id, title, url, favIconUrl: '', active: false, lastActive: NOW - id * 1000, ...extra });
  const tabs = {
    1: tab(1, 'Inbox (3) – Mail', 'https://mail.example/inbox'),
    2: tab(2, 'Project board · Tracker', 'https://tracker.example/board'),
    3: tab(3, 'Design notes — Docs', 'https://docs.example/design', { audible: true }),
    4: tab(4, 'The quiet return of the analog camera | The Lantern', 'https://thelantern.example/culture/analog', { active: true, status: loading ? 'loading' : 'complete' }),
    5: tab(5, 'Sourdough Hydration Chart – Bread Notes', 'https://breadnotes.example/hydration', { sleeping: true }),
    6: tab(6, 'Lisbon in 3 days · Wayfarer', 'https://wayfarer.example/lisbon', { audible: true }),
    7: tab(7, 'Weather – 7 day forecast', 'https://weather.example/week'),
    8: tab(8, 'Slow software — Margins', 'https://margins.example/slow-software', { sleeping: true }),
    9: tab(9, 'Recipes to try', 'https://cook.example/list'),
    10: tab(10, 'Team standup notes', 'https://notes.example/standup'),
  };
  const tabSpace = { 1: 'personal', 2: 'personal', 3: 'personal', 4: 'personal', 5: 'personal', 6: 'personal', 7: 'personal', 8: 'personal', 9: 'work', 10: 'work' };
  return {
    spaces: [
      { id: 'personal', name: 'Personal', emoji: '🏠', color: '#6c5ce7' },
      { id: 'work', name: 'Work', emoji: '💼', color: '#0984e3' },
      { id: 'travel', name: 'Travel', emoji: '✈️', color: '#00b894' },
    ],
    folders: [
      { id: 'f-reading', spaceId: 'personal', name: 'Reading', open: true, pos: 1 },
      { id: 'f-tools', spaceId: 'personal', name: 'Tools', open: false, pos: 3 },
    ],
    pins: [
      { id: 'p-mail', spaceId: 'personal', url: 'https://mail.example/inbox', title: 'Mail', folderId: null, pos: 0 },
      { id: 'p-lantern', spaceId: 'personal', url: 'https://thelantern.example/culture/analog', title: 'The Lantern', folderId: 'f-reading', pos: 0 },
      { id: 'p-news', spaceId: 'personal', url: 'https://news.example/', title: 'Morning news', folderId: 'f-reading', pos: 1 },
      { id: 'p-tracker', spaceId: 'personal', url: 'https://tracker.example/board', title: 'Tracker', folderId: 'f-tools', pos: 0 },
      { id: 'p-cal', spaceId: 'personal', url: 'https://calendar.example/', title: 'Calendar', folderId: 'f-tools', pos: 1 },
      { id: 'p-music', spaceId: 'personal', url: 'https://music.example/', title: 'Music', folderId: null, pos: 2 },
      { id: 'p-wiki', spaceId: 'work', url: 'https://wiki.example/', title: 'Wiki', folderId: null, pos: 0 },
    ],
    tabs,
    tabSpace,
    activeSpaceByWindow: { [W]: 'personal' },
    favicons: {
      'https://mail.example': { data: ICON.red }, 'https://docs.example': { data: ICON.blue },
      'https://thelantern.example': { data: ICON.green }, 'https://weather.example': { data: ICON.gold },
      'https://music.example': { data: ICON.gold }, 'https://gone.example': { data: ICON.blue },
    },
    archive: [
      { id: 'ar1', spaceId: 'personal', url: 'https://gone.example/a', title: 'An article read last week', closedAt: NOW - 3 * 3600_000 },
      { id: 'ar2', spaceId: 'personal', url: 'https://old.example/b', title: 'Flight check-in', closedAt: NOW - 50 * 3600_000 },
    ],
    settings: {
      sidebarPinnedOpen: pinnedOpen,
      frameWhenHidden: frame,
      archiveAfterHours: 12,
      themes: { arcadia: { sidebarWidth: WIDTH }, 'arcadia-2': { sidebarWidth: WIDTH } },
    },
  };
}
const CURRENT_TAB = 4; // this page's own tab: the one in front

// --- A case's state ------------------------------------------------------------

// What each case shows. `sidebar`: 'open' (docked: Keep open), 'hidden',
// 'peek' (out over the hidden page); `frame`: the frame when hidden.
const CASES = {
  docked: { sidebar: 'open' },
  'docked-dark': { sidebar: 'open' },
  loading: { sidebar: 'open', loading: true },
  'hidden-frame': { sidebar: 'hidden', frame: true },
  'hidden-no-frame': { sidebar: 'hidden', frame: false },
  peek: { sidebar: 'peek', frame: true },
  palette: { sidebar: 'open', palette: true },
  menu: { sidebar: 'open', menu: true },
  editor: { sidebar: 'open', editor: true },
  notice: { sidebar: 'open', notice: true },
  launcher: { sidebar: 'open', launcher: true },
  'launcher-dark': { sidebar: 'open', launcher: true },
};
const NOTICE = { text: 'Margin works in full screen.', actions: [{ label: 'Full screen', primary: true }, { label: 'Not now' }] };

const frames = (n = 2) => new Promise((r) => { const step = (k) => (k ? requestAnimationFrame(() => step(k - 1)) : r()); step(n); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const noop = () => Promise.resolve(undefined);

// The tab row to right-click for the menu: the second of today's tabs.
function menuPoint(root) {
  const rows = [...root.querySelectorAll('.tabs .tab')];
  const r = rows[1].getBoundingClientRect();
  return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
}

// --- Today's Arcadia -----------------------------------------------------------

async function renderOld(name) {
  const c = CASES[name];
  const state = fixture({ pinnedOpen: c.sidebar === 'open', frame: c.frame !== false, loading: !!c.loading });
  if (c.launcher) return renderOldLauncher(state);
  const { host, shadow } = createHost(document, 'margin-sidebar-host');
  const sidebar = createSidebar({ document, send: noop, mode: 'overlay', onNewTab: () => {} });
  const chrome = createChrome(document);
  shadow.append(chrome.frame, chrome.rims, chrome.cover, sidebar.el, chrome.cardEdge, chrome.loader, chrome.pull, chrome.swipe, chrome.notice, chrome.startup);
  adoptStyles(shadow, sidebarCss);
  for (const node of [sidebar.el, chrome.frame, chrome.cardEdge]) node.classList.add('instant');
  mountHost(host);
  sidebar.update(state, { windowId: W, tabId: CURRENT_TAB, scroll: 0 });
  const docked = c.sidebar === 'open';
  const open = c.sidebar !== 'hidden';
  sidebar.el.classList.toggle('open', open);
  sidebar.el.classList.toggle('docked', docked);
  chrome.setLayout({ docked, framed: !docked && c.frame !== false, width: sidebar.width() });
  if (c.loading) chrome.setLoading(true, { instant: true });
  await frames(3);
  for (const node of [sidebar.el, chrome.frame, chrome.cardEdge]) node.classList.remove('instant');
  if (c.notice) chrome.showNotice({ text: NOTICE.text, actions: NOTICE.actions.map((a) => ({ label: a.label, run() {} })), duration: 60_000 });
  if (c.editor) {
    shadow.querySelector('.space-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
  }
  if (c.menu) {
    const p = menuPoint(shadow);
    shadow.elementFromPoint(p.x, p.y).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: p.x, clientY: p.y, button: 2 }));
  }
  if (c.palette) {
    const palette = createPalette({ send: noop, getState: () => state, getContext: () => ({ windowId: W, tabId: CURRENT_TAB, inNewTab: false, canToggleSidebar: true }), onLocal: () => {}, colorScheme: () => 'light' });
    palette.open();
  }
  w.__old = { sidebar, chrome, shadow };
  return true;
}

// The new-tab page as newtab.js draws it: its markup and styles on the
// document, the sidebar beside the launcher, the pins as tiles and the
// archive (renderLauncher), Settings closed.
async function renderOldLauncher(state) {
  const sheet = (css) => { const s = new CSSStyleSheet(); s.replaceSync(css); return s; };
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet(sidebarCss), sheet(newtabCss)];
  document.body.removeAttribute('style'); // newtab.css styles the page itself
  document.body.innerHTML = newtabHtml; // the theme's own markup, as newtab.js does
  const sidebar = createSidebar({ document, send: noop, mode: 'newtab', onNewTab: () => {} });
  document.getElementById('sidebar').append(sidebar.el);
  sidebar.update(state, { windowId: W, tabId: CURRENT_TAB, scroll: 0 });
  const view = V.sidebar(state, W);
  document.getElementById('pins-section').hidden = view.pins.length === 0;
  document.getElementById('pin-tiles').replaceChildren(...view.pins.map((p) =>
    el(document, 'li', { class: 'tile', 'data-pin-id': p.id, title: p.url }, avatar(document, { ...p, favIconUrl: V.iconFor(state, p) }), el(document, 'span', { class: 'title', text: p.title }))));
  const ago = (ts) => { const minutes = Math.round((NOW - ts) / 60000); if (minutes < 1) return 'just now'; if (minutes < 60) return `${minutes}m ago`; const hours = Math.round(minutes / 60); return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`; };
  document.getElementById('archive-section').hidden = state.archive.length === 0;
  document.getElementById('archive-more').hidden = state.archive.length <= 12;
  document.getElementById('archive-list').replaceChildren(...state.archive.map((a) =>
    el(document, 'li', { 'data-archive-id': a.id, title: a.url }, avatar(document, { ...a, favIconUrl: V.iconFor(state, a) }), el(document, 'span', { class: 'title', text: a.title || a.url }), el(document, 'span', { class: 'when', text: ago(a.closedAt) }))));
  document.getElementById('query').focus(); // as newtab.js does
  await frames(3);
  return true;
}

// --- arcadia-2 through the runtime -----------------------------------------------

const decode = (b64) => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

async function renderNew(name, pkg) {
  const c = CASES[name];
  const state = fixture({ pinnedOpen: c.sidebar === 'open', frame: c.frame !== false, loading: !!c.loading });
  const theme = await loadTheme({ ...pkg, files: Object.fromEntries(Object.entries(pkg.files).map(([k, v]) => [k, decode(v)])) });
  if (!theme.ok) throw new Error(`arcadia-2 didn't load: ${JSON.stringify(theme.report.errors)}`);
  const host = createMockHost({ state, windowId: W, tabId: c.launcher ? null : CURRENT_TAB, mode: 'inpage', inNewTab: !!c.launcher, platform: { browser: 'chrome', os: 'mac' } });
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;display:block';
  document.body.appendChild(el);
  const shadow = el.attachShadow({ mode: 'open' });
  const warnings = [];
  const runtime = createRuntime({ host, theme, container: shadow, ui: { sidebar: c.sidebar === 'peek' ? 'peek' : null }, onWarn: (m) => warnings.push(m) });
  w.__new = { runtime, host, shadow, warnings };
  await frames(3);
  if (c.notice) runtime.setUi({ notice: { id: 'n1', text: NOTICE.text, actions: NOTICE.actions.map((a, i) => ({ id: `a${i}`, label: a.label, primary: !!a.primary })) } });
  if (c.editor) runtime.dispatch('space.edit', 'personal');
  if (c.menu) {
    const p = menuPoint(shadow);
    shadow.elementFromPoint(p.x, p.y).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: p.x, clientY: p.y, button: 2 }));
  }
  if (c.palette) runtime.dispatch('palette.open');
  return { warnings, refused: runtime.refused.map((r) => r.reason) };
}

w.P = {
  cases: () => Object.keys(CASES),
  dark: (name) => /dark/.test(name),
  old: (name) => renderOld(name),
  new: (name, pkg) => renderNew(name, pkg),
  settle: async (ms = 450) => { await pause(ms); await frames(2); },
};
