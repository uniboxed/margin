// The theme view model (PLAN.md §3 "What a theme can read", with §14's
// additions): the one object a theme's bindings read, built from Margin's
// stored state (shared/stored.js fromStorage, as pages read it) and the UI's
// own state (which window, the sidebar, the palette, menus). The same in
// every host.
//
// The sections and their order are today's sidebar's: shared/view.js
// `sidebar` decides them (the window's space, its pinned area of folders and
// pins, "+ New Tab", its other tabs newest first, which row is active), and
// this only reshapes its answer for themes. Icons are `data:` images Margin
// stored (state.favicons, or one the browser gave as data), else a letter on
// a color (shared/view.js letterAvatar, as Arcadia draws them).
//
// Immutable, with structural sharing: `buildViewModel(input, prev)` returns
// frozen objects, and every part that's the same as in `prev` (a row, a
// list, the space, the whole model) IS `prev`'s object. The renderer skips a
// row whose item is the same object (ui/render.js), so this is what keeps an
// update down to the rows that changed. Pure: no browser APIs, runs in Node.
/** @import { State } from '../../types/margin' */
import * as V from '../shared/view.js';
import { hostOf } from '../shared/dom.js';
import { rankPalette } from '../shared/search.js';
import { checkIconUrl } from './sanitize.js';
import { CONFIRM_LABEL, SPACE_COLORS, menuItems } from './behaviors/menu-items.js';

/** The view model's version: a theme reads what this version documents. */
export const VM_VERSION = 1;

/**
 * @typedef {'fullscreen' | 'windowed' | 'inpage'} WindowMode
 * @typedef {'open' | 'hidden' | 'peek'} SidebarState
 *
 * The UI's own state, kept by the runtime (ui/runtime.js), never stored.
 * @typedef {{
 *   windowId?: number | null,
 *   tabId?: number | null,
 *   mode?: WindowMode,
 *   focused?: boolean,
 *   sidebar?: SidebarState | null,
 *   palette?: { open?: boolean, query?: string, selected?: number, newTab?: boolean },
 *   menu?: { kind: string, id?: string | number | null, x?: number, y?: number, confirming?: string | null } | null,
 *   editing?: { kind: 'space' | 'folder', id: string } | null,
 *   editor?: { spaceId: string, name: string, emoji: string, color: string, confirmDelete?: boolean } | null,
 *   newTabPending?: boolean,
 *   notice?: { id: string, text: string, actions?: { id: string, label: string, primary?: boolean }[] } | null,
 *   prompt?: { id: string, title?: string, text: string, actions?: { id: string, label: string, primary?: boolean, danger?: boolean }[] } | null,
 *   launcher?: { allArchived?: boolean } | null,
 *   switchingTo?: number | null,
 *   justShown?: boolean,
 *   inNewTab?: boolean,
 *   pageLoading?: boolean,
 * }} UiState
 *
 * @typedef {{
 *   state: Partial<State> & Record<string, any> | null,
 *   now?: number,
 *   ui?: UiState,
 *   platform?: { browser?: string, os?: string, marginFullscreen?: boolean },
 *   settings?: Record<string, string | number | boolean>,
 * }} ViewModelInput
 *
 * What every row with a page has. `icon`: a base64 `data:` image or null
 * (then `letter` on `color`).
 * @typedef {{ title: string, url: string, host: string, icon: string | null, letter: string, color: string }} Face
 *
 * @typedef {Face & {
 *   kind: 'tab', id: number, active: boolean, behind: boolean,
 *   audible: boolean, asleep: boolean, loading: boolean, pinned: false,
 * }} TabRow
 * @typedef {Face & {
 *   kind: 'pin', isFolder: false, id: string, folderId: string | null, nested: boolean,
 *   tabId: number | null, open: boolean, active: boolean, behind: boolean,
 *   audible: boolean, asleep: boolean, loading: boolean, pinned: true,
 * }} PinRow
 * @typedef {{
 *   kind: 'folder', isFolder: true, id: string, name: string, open: boolean,
 *   count: number, pins: PinRow[], shown: PinRow[], hasShown: boolean,
 * }} FolderRow
 * @typedef {{
 *   id: string, name: string, emoji: string, color: string, abbr: string,
 *   index: number, active: boolean, tabCount: number,
 * }} SpaceChip
 * @typedef {SpaceChip & {
 *   pinned: (FolderRow | PinRow)[], folders: FolderRow[], pins: PinRow[],
 *   today: TabRow[], hasToday: boolean, hasPinned: boolean,
 *   newTab: { active: boolean },
 * }} SpaceView
 * @typedef {Face & {
 *   id: number, loading: boolean, audible: boolean, asleep: boolean, pinned: boolean, newTab: boolean,
 * }} ActiveTab
 * @typedef {Face & { id: string, spaceId: string, closedAt: number, ago: string }} ArchiveRow
 * @typedef {{
 *   id: string, kind: string, title: string, subtitle: string, badge: string,
 *   emoji: string, icon: string | null, letter: string, color: string,
 *   selected: boolean, goes: boolean,
 * }} PaletteRow
 *
 * A context menu's row: an item (its label; what it runs stays in Margin)
 * or a separator. `confirming`: pressed once, it asks again ("Really delete?").
 * @typedef {{ id: string, label: string, separator: boolean, danger: boolean, confirming: boolean }} MenuRow
 *
 * The space editor (`<m-editor>`, the theme's `space-editor` part).
 * @typedef {{
 *   id: string, name: string, emoji: string, color: string,
 *   colors: { id: string, color: string, selected: boolean }[],
 *   canDelete: boolean, cannotDelete: boolean, confirmDelete: boolean, deleteLabel: string, deleteTitle: string,
 *   labels: { title: string, name: string, emoji: string, colors: string, save: string, cancel: string },
 * }} EditorView
 *
 * A notice or a prompt: Margin's words, and its buttons' (each runs
 * notice.run / prompt.run with its id). The theme's `notice` and `prompt`
 * parts show nothing else (ui/sanitize.js GUARDED_PARTS).
 * @typedef {{ id: string, label: string, primary: boolean, danger: boolean }} NoticeAction
 * @typedef {{ id: string, text: string, actions: NoticeAction[], hasActions: boolean }} NoticeView
 * @typedef {NoticeView & { title: string }} PromptView
 *
 * The new-tab page's launcher (the `launcher` part, in <m-launcher>), while
 * the UI is drawn in Margin's new-tab page: the space's pins as tiles, the
 * archive's latest (all of it after "Show all").
 * @typedef {{
 *   pins: PinRow[], hasPins: boolean, archive: ArchiveRow[], hasArchive: boolean, emptyArchive: boolean,
 *   more: boolean, moreLabel: string,
 * }} LauncherView
 *
 * @typedef {{
 *   version: number,
 *   ready: boolean,
 *   window: {
 *     id: number | null, mode: WindowMode, focused: boolean, sidebar: SidebarState,
 *     sidebarOpen: boolean, peek: boolean, pinnedOpen: boolean, frameWhenHidden: boolean,
 *   },
 *   space: SpaceView,
 *   spaces: SpaceChip[],
 *   tab: ActiveTab | null,
 *   archive: ArchiveRow[],
 *   hasArchive: boolean,
 *   palette: { open: boolean, query: string, newTab: boolean, rows: PaletteRow[], hasRows: boolean, selected: string | null },
 *   menu: { kind: string, id: string | number | null, x: number, y: number, label: string, items: MenuRow[], hasItems: boolean } | null,
 *   editing: { kind: 'space' | 'folder', id: string } | null,
 *   editor: EditorView | null,
 *   notice: NoticeView | null,
 *   prompt: PromptView | null,
 *   launcher: LauncherView | null,
 *   settings: Record<string, string | number | boolean>,
 *   platform: { browser: string, os: string },
 * }} ViewModel
 */

// ---------------------------------------------------------------------------
// The state as pages read it can miss keys (a background that hasn't written
// them yet): what the view needs, filled in.

/** @param {any} raw @returns {State | null} */
function usable(raw) {
  if (!raw || !Array.isArray(raw.spaces) || !raw.spaces.length) return null;
  return /** @type {State} */ ({
    ...raw,
    pins: Array.isArray(raw.pins) ? raw.pins : [],
    folders: Array.isArray(raw.folders) ? raw.folders : [],
    archive: Array.isArray(raw.archive) ? raw.archive : [],
    tabs: raw.tabs && typeof raw.tabs === 'object' ? raw.tabs : {},
    tabSpace: raw.tabSpace && typeof raw.tabSpace === 'object' ? raw.tabSpace : {},
    activeSpaceByWindow: raw.activeSpaceByWindow && typeof raw.activeSpaceByWindow === 'object' ? raw.activeSpaceByWindow : {},
    favicons: raw.favicons && typeof raw.favicons === 'object' ? raw.favicons : {},
    settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : {},
  });
}

// ---------------------------------------------------------------------------
// Rows.

/** A space's short name for a chip: two letters, from its first two words or its first word. @param {string} name */
export function abbreviate(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const letters = words.length > 1 ? [...words[0]].slice(0, 1).concat([...words[1]].slice(0, 1)) : [...words[0]].slice(0, 2);
  return letters.join('').toUpperCase();
}

/** @param {State} state @param {{ url?: string, title?: string, favIconUrl?: string }} item @param {string} title @returns {Face} */
function face(state, item, title) {
  const url = item.url ?? '';
  const host = hostOf(url);
  const icon = V.iconFor(state, item);
  const { letter, color } = V.letterAvatar(host || title || '?');
  return { title, url, host, icon: checkIconUrl(icon) ? icon : null, letter, color };
}

const isLoading = (t) => t?.status === 'loading' || t?.loading === true;

/** @param {State} state @param {any} t @returns {TabRow} */
function tabRow(state, t) {
  return {
    kind: 'tab',
    id: t.id,
    ...face(state, t, t.title || t.url || 'New Tab'),
    active: !!t.active,
    behind: !!t.behind,
    audible: !!t.audible,
    asleep: !!t.sleeping,
    loading: isLoading(t),
    pinned: false,
  };
}

/** @param {State} state @param {any} p a pin as shared/view.js sidebar shows it @param {boolean} nested @returns {PinRow} */
function pinRow(state, p, nested) {
  const tab = /** @type {any} */ (p.tabId != null ? state.tabs[p.tabId] : null);
  return {
    kind: 'pin',
    isFolder: false,
    id: p.id,
    ...face(state, p, p.title || p.url || ''),
    folderId: p.folderId ?? null,
    nested,
    tabId: p.tabId ?? null,
    open: p.tabId != null,
    active: !!p.active,
    behind: !!p.behind,
    audible: !!tab?.audible,
    asleep: !!tab?.sleeping,
    loading: isLoading(tab),
    pinned: true,
  };
}

// ---------------------------------------------------------------------------
// The model, fresh (every object new), then shared with the last one.

/** @param {ViewModelInput} input @returns {ViewModel} */
function fresh(input) {
  const ui = input.ui ?? {};
  const state = usable(input.state);
  const platform = { browser: input.platform?.browser ?? 'unknown', os: input.platform?.os ?? 'unknown' };
  const settings = input.settings ?? {};
  const pinnedOpen = !!state?.settings?.sidebarPinnedOpen;
  const sidebar = ui.sidebar === 'open' || ui.sidebar === 'hidden' || ui.sidebar === 'peek' ? ui.sidebar : pinnedOpen ? 'open' : 'hidden';
  const windowId = ui.windowId ?? null;
  const win = {
    id: windowId,
    mode: ui.mode ?? 'inpage',
    focused: ui.focused !== false,
    sidebar,
    sidebarOpen: sidebar === 'open',
    peek: sidebar === 'peek',
    pinnedOpen,
    // The sidebar hidden: Margin's frame stays around the page (a setting).
    frameWhenHidden: state?.settings?.frameWhenHidden !== false,
  };
  const paletteUi = ui.palette ?? {};
  const editing = ui.editing ? { kind: ui.editing.kind, id: ui.editing.id } : null;
  const notice = ui.notice ? noticeView(ui.notice) : null;
  const prompt = ui.prompt ? { ...noticeView(ui.prompt), title: String(ui.prompt.title ?? '') } : null;
  if (!state) {
    return {
      version: VM_VERSION, ready: false, window: win,
      space: { id: '', name: '', emoji: '', color: '', abbr: '', index: 0, active: true, tabCount: 0, pinned: [], folders: [], pins: [], today: [], hasToday: false, hasPinned: false, newTab: { active: false } },
      spaces: [], tab: null, archive: [], hasArchive: false,
      palette: { open: !!paletteUi.open, query: paletteUi.query ?? '', newTab: !!paletteUi.newTab, rows: [], hasRows: false, selected: null },
      menu: null, editing, editor: null, notice, prompt, launcher: null, settings, platform,
    };
  }

  const currentTabId = ui.tabId ?? null;
  const view = V.sidebar(state, windowId, currentTabId, {
    newTabPending: !!(paletteUi.open && paletteUi.newTab) || !!ui.newTabPending,
    switchingTo: ui.switchingTo ?? null,
    justShown: !!ui.justShown,
  });

  // The pinned area, in the order shown: folders (with their pins) and the
  // pins in none. A closed folder shows only the pin of the tab in front
  // (`shown`: view.peek), so the highlight stays in sight.
  const pins = [];
  const folders = [];
  const pinned = view.pinned.map((item) => {
    if (item.kind !== 'folder') {
      const row = pinRow(state, item, false);
      pins.push(row);
      return row;
    }
    const inside = item.pins.map((p) => pinRow(state, p, true));
    const byId = new Map(inside.map((p) => [p.id, p]));
    const shown = item.open ? inside : item.peek.map((p) => byId.get(p.id));
    /** @type {FolderRow} */
    const folder = { kind: 'folder', isFolder: true, id: item.id, name: item.name, open: item.open, count: inside.length, pins: inside, shown, hasShown: shown.length > 0 };
    folders.push(folder);
    return folder;
  });
  const today = view.tabs.map((t) => tabRow(state, t));

  // A space's tab count: its tabs open in this window (pinned or not).
  const counts = new Map();
  for (const t of Object.values(state.tabs)) {
    if (t.windowId !== windowId) continue;
    const s = state.tabSpace[t.id];
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const spaces = state.spaces.map((s, index) => ({
    id: s.id,
    name: s.name ?? '',
    emoji: s.emoji ?? '',
    color: s.color ?? '',
    abbr: abbreviate(s.name),
    index,
    active: s.id === view.spaceId,
    tabCount: counts.get(s.id) ?? 0,
  }));
  const chip = spaces.find((s) => s.active) ?? spaces[0];
  /** @type {SpaceView} */
  const space = {
    ...chip,
    pinned,
    folders,
    pins,
    today,
    hasToday: today.length > 0,
    hasPinned: pinned.length > 0,
    newTab: { active: !!view.newTab.active },
  };

  // The tab in front: this page's own (in pages), else the window's active one.
  /** @type {any} */
  const current = (currentTabId != null ? state.tabs[currentTabId] : null)
    ?? Object.values(state.tabs).find((t) => t.windowId === windowId && t.active) ?? null;
  const pinnedUrls = new Set(state.pins.filter((p) => p.spaceId === state.tabSpace[current?.id]).map((p) => V.normalizeUrl(p.url)));
  const tab = current ? {
    id: current.id,
    ...face(state, current, current.title || current.url || 'New Tab'),
    // Loading: as the background records it, or this page's own load (the
    // in-page host: content/loader.js, the pill's timing).
    loading: isLoading(current) || (!!ui.pageLoading && current.id === currentTabId),
    audible: !!current.audible,
    asleep: !!current.sleeping,
    pinned: pinnedUrls.has(V.normalizeUrl(current.url)),
    newTab: V.isNewTabPage(current.url),
  } : null;

  const now = Number.isFinite(input.now) ? /** @type {number} */ (input.now) : Date.now();
  const archive = state.archive.map((a) => ({
    id: a.id,
    ...face(state, a, a.title || a.url || ''),
    spaceId: a.spaceId ?? '',
    closedAt: Number(a.closedAt) || 0,
    ago: ago(Number(a.closedAt) || 0, now),
  }));

  // The palette's rows: shared/search.js ranks them, as Arcadia's palette.
  let rows = [];
  let selected = null;
  if (paletteUi.open) {
    const items = rankPalette(state, paletteUi.query ?? '', paletteContext(ui, input.platform));
    const at = items.length ? Math.min(Math.max(0, paletteUi.selected ?? 0), items.length - 1) : -1;
    rows = items.map((item, i) => {
      const { letter, color } = V.letterAvatar(hostOf(item.url) || item.title || '?');
      const icon = item.favIconUrl;
      return {
        id: item.id,
        kind: item.kind,
        title: item.title ?? '',
        subtitle: item.subtitle ?? '',
        badge: item.badge ?? '',
        emoji: item.emoji ?? '',
        icon: checkIconUrl(icon) ? icon : null,
        letter,
        color,
        selected: i === at,
        goes: GOES.has(item.kind),
      };
    });
    selected = at >= 0 ? items[at].id : null;
  }

  // A context menu (ui/behaviors/menus.js): its rows, from what it's for.
  let menu = null;
  if (ui.menu) {
    const items = menuItems(/** @type {any} */ (ui.menu), { state, space });
    if (items.length) {
      menu = {
        kind: String(ui.menu.kind), id: ui.menu.id ?? null, x: Number(ui.menu.x) || 0, y: Number(ui.menu.y) || 0,
        label: MENU_LABELS[ui.menu.kind] ?? 'Menu',
        items: items.map((i) => {
          const confirming = !!i.confirm && ui.menu?.confirming === i.id;
          return { id: i.id, label: confirming ? CONFIRM_LABEL : i.label, separator: i.separator, danger: i.danger, confirming };
        }),
        hasItems: true,
      };
    }
  }

  // The space editor (ui/behaviors/editor.js), while a space is edited.
  let editor = null;
  const edited = ui.editor ? state.spaces.find((s) => s.id === ui.editor?.spaceId) : null;
  if (ui.editor && edited) {
    const only = state.spaces.length < 2;
    editor = {
      id: edited.id,
      name: String(ui.editor.name ?? ''),
      emoji: String(ui.editor.emoji ?? ''),
      color: String(ui.editor.color ?? ''),
      colors: SPACE_COLORS.map((color, i) => ({ id: `c${i}`, color, selected: color === ui.editor?.color })),
      canDelete: !only,
      cannotDelete: only,
      confirmDelete: !!ui.editor.confirmDelete,
      deleteLabel: ui.editor.confirmDelete ? CONFIRM_LABEL : 'Delete',
      deleteTitle: only ? 'The last space can’t be deleted' : 'Tabs and pins move to the first space',
      labels: EDITOR_LABELS,
    };
  }

  // The new-tab page's launcher (Arcadia's newtab.js renderLauncher): the
  // space's pins, folders' too, and the latest archived tabs.
  let launcher = null;
  if (ui.inNewTab) {
    const tiles = pinned.flatMap((p) => (p.isFolder ? p.pins : [p]));
    const all = ui.launcher?.allArchived;
    const shown = all ? archive : archive.slice(0, LAUNCHER_ARCHIVE);
    launcher = {
      pins: tiles,
      hasPins: tiles.length > 0,
      archive: shown,
      hasArchive: archive.length > 0,
      emptyArchive: archive.length === 0,
      more: archive.length > LAUNCHER_ARCHIVE,
      moreLabel: all ? 'Show fewer' : `Show all ${archive.length}`,
    };
  }

  return {
    version: VM_VERSION,
    ready: true,
    window: win,
    space,
    spaces,
    tab,
    archive,
    hasArchive: archive.length > 0,
    palette: { open: !!paletteUi.open, query: paletteUi.query ?? '', newTab: !!paletteUi.newTab, rows, hasRows: rows.length > 0, selected },
    menu,
    editing,
    editor,
    notice,
    prompt,
    launcher,
    settings,
    platform,
  };
}

/** A notice or prompt's view: its words and buttons, as text. @param {any} n @returns {NoticeView} */
function noticeView(n) {
  const actions = (Array.isArray(n.actions) ? n.actions : []).slice(0, 4).map((a, i) => ({
    id: String(a?.id ?? `a${i}`), label: String(a?.label ?? ''), primary: !!a?.primary, danger: !!a?.danger,
  }));
  return { id: String(n.id), text: String(n.text ?? ''), actions, hasActions: actions.length > 0 };
}

// How long ago, as the launcher's archive says it (Arcadia's newtab.js ago).
function ago(ts, now) {
  const minutes = Math.round((now - ts) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const LAUNCHER_ARCHIVE = 12;
// The words of Margin's own parts (the menu's and the editor's), which a
// theme binds rather than writes (ui/sanitize.js GUARDED_PARTS).
const MENU_LABELS = Object.freeze({ tab: 'Tab', pin: 'Pin', folder: 'Folder', space: 'Space', add: 'New' });
const EDITOR_LABELS = Object.freeze({ title: 'Edit space', name: 'Space name', emoji: 'Space emoji', colors: 'Space color', save: 'Save', cancel: 'Cancel' });

// Rows that go somewhere (Arcadia's arrow button).
const GOES = new Set(['tab', 'pin', 'archive', 'go']);

/**
 * What shared/search.js ranks the palette for: this window and tab.
 * @param {UiState} ui @param {ViewModelInput['platform']} platform
 */
export function paletteContext(ui, platform) {
  return { windowId: ui.windowId ?? null, tabId: ui.tabId ?? null, inNewTab: !!ui.inNewTab, canToggleSidebar: true, canFullscreen: !!platform?.marginFullscreen };
}

/**
 * The palette's items as ranked for the UI state (their actions included),
 * the same list the view model's rows come from.
 * @param {any} rawState @param {UiState} ui @param {ViewModelInput['platform']} [platform]
 */
export function paletteItems(rawState, ui, platform) {
  const state = usable(rawState);
  if (!state || !ui.palette?.open) return [];
  return rankPalette(state, ui.palette.query ?? '', paletteContext(ui, platform));
}

// ---------------------------------------------------------------------------
// Structural sharing.

const EMPTY = Object.freeze([]);
// A list item's key: rows by kind and id (a folder and a pin never collide),
// else by id; anything else by place.
const keyOf = (item) => (item && typeof item === 'object' && 'id' in item ? (typeof item.kind === 'string' ? `${item.kind}:${item.id}` : item.id) : undefined);

/**
 * `next` with every part that equals `prev`'s replaced by `prev`'s object,
 * frozen. Lists match their items by key (so a row moved, or one inserted
 * before it, is still the same object), objects by field. `memo`: an object
 * of `next` that appears twice (a pin in `space.pinned` and `space.pins`)
 * comes out as one object.
 * @template T
 * @param {T} next @param {any} prev @param {Map<any, any>} memo
 * @returns {T}
 */
function share(next, prev, memo) {
  if (next === prev || next === null || typeof next !== 'object') return next;
  const done = memo.get(next);
  if (done) return done;
  let out;
  if (Array.isArray(next)) {
    const old = Array.isArray(prev) ? prev : EMPTY;
    let byKey = null;
    let same = old.length === next.length;
    const items = new Array(next.length);
    for (let i = 0; i < next.length; i++) {
      const item = next[i];
      const key = keyOf(item);
      let match = old[i];
      if (key !== undefined && keyOf(match) !== key) {
        if (!byKey) { byKey = new Map(); for (const o of old) { const k = keyOf(o); if (k !== undefined && !byKey.has(k)) byKey.set(k, o); } }
        match = byKey.get(key);
      }
      items[i] = share(item, match, memo);
      if (items[i] !== old[i]) same = false;
    }
    out = same ? old : Object.freeze(items);
  } else {
    const old = prev !== null && typeof prev === 'object' && !Array.isArray(prev) ? prev : null;
    const keys = Object.keys(next);
    let same = old !== null && Object.keys(old).length === keys.length;
    const obj = {};
    for (const k of keys) {
      const had = old !== null && Object.prototype.hasOwnProperty.call(old, k);
      const v = share(next[k], had ? old[k] : undefined, memo);
      obj[k] = v;
      if (!had || old[k] !== v) same = false;
    }
    out = same ? old : Object.freeze(obj);
  }
  memo.set(next, out);
  return out;
}

/**
 * The theme view model for the state and the UI's own state. Pass the model
 * this returned last time as `prev`: whatever hasn't changed comes back as
 * the same object (and the whole model, if nothing has).
 * @param {ViewModelInput} input
 * @param {ViewModel | null} [prev]
 * @returns {ViewModel}
 */
export function buildViewModel(input, prev = null) {
  return share(fresh(input), prev, new Map());
}
