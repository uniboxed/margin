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
import { settingsFields } from './settings-form.js';
import { isMultiProfile, orderedSpaces } from '../shared/across.js';
import { STALE_MS, cloudShown, deviceNames, lastUsed, onDevice, updatedText } from '../shared/cloud-tabs.js';

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
 *   editor?: { spaceId?: string, profileId?: string, name: string, emoji: string, color: string, confirmDelete?: boolean } | null,
 *   newTabPending?: boolean,
 *   notice?: { id: string, text: string, actions?: { id: string, label: string, primary?: boolean }[] } | null,
 *   prompt?: { id: string, title?: string, text: string, actions?: { id: string, label: string, primary?: boolean, danger?: boolean }[] } | null,
 *   launcher?: { allArchived?: boolean } | null,
 *   settingsOpen?: boolean,
 *   recording?: string | null,
 *   settingsStatus?: Record<string, { text: string, error?: boolean }>,
 *   switchingTo?: number | null,
 *   justShown?: boolean,
 *   inNewTab?: boolean,
 *   launcherPage?: boolean,
 *   pageLoading?: boolean,
 *   gesture?: { kind: 'pull' | 'swipe', state: 'pulling' | 'armed' | 'done', progress?: number, direction?: number } | null,
 * }} UiState
 *
 * @typedef {{
 *   state: Partial<State> & Record<string, any> | null,
 *   now?: number,
 *   ui?: UiState,
 *   platform?: { browser?: string, os?: string, marginFullscreen?: boolean, features?: Record<string, any> },
 *   settings?: Record<string, string | number | boolean>,
 * }} ViewModelInput
 *
 * What every row with a page has. `icon`: a base64 `data:` image or null
 * (then `letter` on `color`).
 * @typedef {{ title: string, url: string, host: string, icon: string | null, letter: string, color: string }} Face
 *
 * A tab of the space: open (its browser tab's id, a number) or not (its
 * Margin tab's own id, a string: `open` false, `notOpen` true).
 * @typedef {Face & {
 *   kind: 'tab', id: number | string, active: boolean, behind: boolean,
 *   audible: boolean, asleep: boolean, loading: boolean, pinned: false,
 *   open: boolean, notOpen: boolean,
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
 * A browser profile (several, with Margin.app: shared/across.js). `initial`:
 * the letter its mark shows when it has no emoji; `here`: this window's.
 * `fromBrowser`: the name is the browser's own (Safari's, read with Full
 * Disk Access); `symbol`: the browser's symbol for it, a small white picture
 * (an `m-icon`), or null.
 * @typedef {{
 *   id: string, name: string, emoji: string, color: string, initial: string,
 *   here: boolean, linked: boolean, stale: boolean, spaces: number,
 *   fromBrowser: boolean, symbol: string | null,
 * }} ProfileChip
 * A space's chip. With spaces in several profiles (`multiProfile`):
 * `profile` is its profile, `foreign` true for another profile's (a click
 * switches to that profile's window), `profileMark` where a theme shows the
 * profile's mark on it (another profile's), `profileStart` on the first chip
 * of a run of one profile after another's (a divider), `switching` while
 * Margin.app is switching to it. One profile: `profile` null, the rest false.
 * @typedef {{
 *   id: string, name: string, emoji: string, color: string, abbr: string,
 *   index: number, active: boolean, tabCount: number,
 *   profile: ProfileChip | null, foreign: boolean, profileMark: boolean, profileStart: boolean, switching: boolean,
 *   label: string,
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
 * A palette row. `section`: the heading of a run of rows from one place
 * ("On Tirth's iPhone": iCloud Tabs), `sectionStart` on its first row ('' and
 * false for Margin's own rows).
 * @typedef {{
 *   id: string, kind: string, title: string, subtitle: string, badge: string,
 *   emoji: string, icon: string | null, letter: string, color: string,
 *   selected: boolean, goes: boolean, section: string, sectionStart: boolean,
 * }} PaletteRow
 *
 * iCloud Tabs (`<m-cloud-tabs>`, the theme's `cloud-tabs` part): the tabs
 * open on the person's other devices, a live folder (Margin.app with Safari,
 * "Show iCloud Tabs" on; else null). Read only: nothing is dragged into it or
 * reordered in it, and a remote tab can't be closed. `open`: the folder
 * expanded; one of `ready` (devices to show), `empty` (none with tabs),
 * `noAccess` (no Full Disk Access: `canFix`, its button runs cloud.access),
 * `noData` (iCloud Tabs off, or not synced), `failed`, with `message` saying
 * so in Margin's words (`hasMessage`). `count`: tabs on all devices.
 * @typedef {Face & { kind: 'cloud', id: string, pinned: boolean, deviceId: string, label: string }} CloudTabRow
 * @typedef {{
 *   kind: 'cloud-device', id: string, name: string, label: string, describe: string, updated: string,
 *   isPhone: boolean, isPad: boolean, isMac: boolean, isVision: boolean, isOther: boolean,
 *   open: boolean, stale: boolean, count: number, tabs: CloudTabRow[], shown: CloudTabRow[],
 * }} CloudDeviceRow
 * @typedef {{
 *   open: boolean, ready: boolean, empty: boolean, noAccess: boolean, noData: boolean, failed: boolean,
 *   message: string, hasMessage: boolean, canFix: boolean,
 *   devices: CloudDeviceRow[], hasDevices: boolean, count: number, hasCount: boolean,
 *   labels: { title: string, toggle: string, fix: string, pinned: string },
 * }} CloudTabsView
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
 *   labels: { title: string, name: string, emoji: string, colors: string, save: string, cancel: string, note: string },
 *   isProfile: boolean,
 *   nameLocked: boolean,
 * }} EditorView
 * `nameLocked`: a profile whose name is Safari's (Margin never writes to
 * Safari): the name field shows it and can't be changed, `labels.note` says
 * where to rename it; the emoji and color are Margin's.
 *
 * A notice or a prompt: Margin's words, and its buttons' (each runs
 * notice.run / prompt.run with its id). The theme's `notice` and `prompt`
 * parts show nothing else (ui/sanitize.js GUARDED_PARTS).
 * @typedef {{ id: string, label: string, primary: boolean, danger: boolean }} NoticeAction
 * @typedef {{ id: string, text: string, actions: NoticeAction[], hasActions: boolean }} NoticeView
 * @typedef {NoticeView & { title: string }} PromptView
 *
 * A trackpad gesture Margin runs in the page in front (Margin.app: the page
 * tells the overlay through its copy): pull to refresh (`pull`) or swipe back
 * and forward (`swipe`, `back` or `forward`), `armed` once letting go would
 * do it, `done` once it did, `progress` how far along (0 to 1, in steps of
 * 0.05; `percent` the same out of 100). Icons only: no words.
 * @typedef {{ pull: boolean, swipe: boolean, back: boolean, forward: boolean, armed: boolean, done: boolean, progress: number, percent: number }} GestureView
 *
 * The new-tab page's launcher (the `launcher` part, in <m-launcher>), while
 * the UI is drawn in Margin's new-tab page: the space's pins as tiles, the
 * archive's latest (all of it after "Show all").
 * @typedef {{
 *   pins: PinRow[], hasPins: boolean, archive: ArchiveRow[], hasArchive: boolean, emptyArchive: boolean,
 *   more: boolean, moreLabel: string, settingsOpen: boolean,
 * }} LauncherView
 *
 * The launcher's Settings form (the `settings` part, in <m-settings>), while
 * it's open: fields from ui/settings-form.js, Margin's words only.
 * @typedef {{ fields: import('./settings-form.js').SettingsField[], hasFields: boolean }} SettingsFormView
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
 *   profiles: ProfileChip[],
 *   profile: ProfileChip | null,
 *   multiProfile: boolean,
 *   tab: ActiveTab | null,
 *   archive: ArchiveRow[],
 *   hasArchive: boolean,
 *   palette: { open: boolean, query: string, newTab: boolean, rows: PaletteRow[], hasRows: boolean, selected: string | null },
 *   menu: { kind: string, id: string | number | null, x: number, y: number, label: string, items: MenuRow[], hasItems: boolean } | null,
 *   editing: { kind: 'space' | 'folder', id: string } | null,
 *   editor: EditorView | null,
 *   notice: NoticeView | null,
 *   prompt: PromptView | null,
 *   gesture: GestureView | null,
 *   launcher: LauncherView | null,
 *   settingsForm: SettingsFormView | null,
 *   cloudTabs: CloudTabsView | null,
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
    keptTabs: raw.keptTabs && typeof raw.keptTabs === 'object' ? raw.keptTabs : {},
    tabSpace: raw.tabSpace && typeof raw.tabSpace === 'object' ? raw.tabSpace : {},
    activeSpaceByWindow: raw.activeSpaceByWindow && typeof raw.activeSpaceByWindow === 'object' ? raw.activeSpaceByWindow : {},
    favicons: raw.favicons && typeof raw.favicons === 'object' ? raw.favicons : {},
    settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : {},
    across: raw.across && typeof raw.across === 'object' ? raw.across : null,
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

// A tab's row: an open one by its browser tab's id, a Margin tab that isn't
// open (shared/view.js `kept`) by its own id (a string), `open` false and
// `notOpen` true: a theme draws it as not open (Arcadia and Neo-brutalism dim
// it), and a click opens it (tab.activate) where it was clicked.
/** @param {State} state @param {any} t @returns {TabRow} */
function tabRow(state, t) {
  const open = !t.kept;
  return {
    kind: 'tab',
    id: t.id,
    ...face(state, t, t.title || t.url || 'New Tab'),
    active: open && !!t.active,
    behind: open && !!t.behind,
    audible: open && !!t.audible,
    asleep: open && !!t.sleeping,
    loading: open && isLoading(t),
    pinned: false,
    open,
    notOpen: !open,
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
  // Margin's own pages (the launcher) always show the sidebar beside it.
  const sidebar = ui.sidebar === 'open' || ui.sidebar === 'hidden' || ui.sidebar === 'peek' ? ui.sidebar : pinnedOpen || ui.launcherPage ? 'open' : 'hidden';
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
  const gesture = ui.gesture ? gestureView(ui.gesture) : null;
  if (!state) {
    return {
      version: VM_VERSION, ready: false, window: win,
      space: { id: '', name: '', emoji: '', color: '', abbr: '', index: 0, active: true, tabCount: 0, profile: null, foreign: false, profileMark: false, profileStart: false, switching: false, label: '', pinned: [], folders: [], pins: [], today: [], hasToday: false, hasPinned: false, newTab: { active: false } },
      spaces: [], profiles: [], profile: null, multiProfile: false, tab: null, archive: [], hasArchive: false,
      palette: { open: !!paletteUi.open, query: paletteUi.query ?? '', newTab: !!paletteUi.newTab, rows: [], hasRows: false, selected: null },
      menu: null, editing, editor: null, notice, prompt, gesture, launcher: null, settingsForm: null, cloudTabs: null, settings, platform,
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

  // A space's tab count: its tabs open in this window (pinned or not), and
  // its tabs that aren't open (shown in every window).
  const counts = new Map();
  for (const t of Object.values(state.tabs)) {
    if (t.windowId !== windowId) continue;
    const s = state.tabSpace[t.id];
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  for (const k of Object.values(state.keptTabs ?? {})) counts.set(k.spaceId, (counts.get(k.spaceId) ?? 0) + 1);
  // Every profile's spaces in the one order, with Margin.app and several
  // profiles (shared/across.js); else this profile's, as always.
  const across = /** @type {import('../shared/across.js').Across | null} */ (/** @type {any} */ (state).across ?? null);
  const multiProfile = isMultiProfile(across);
  const profiles = multiProfile && across ? across.profiles.filter((p) => p.spaces > 0 || p.here).map(profileChip) : [];
  const chipOf = (id) => profiles.find((p) => p.id === id) ?? null;
  const going = across?.switching?.space ? `${across.switching.profile}\u0000${across.switching.space}` : null;
  const spaces = orderedSpaces(state.spaces, across).map((o, index, all) => {
    const s = o.own ? o.space : o.entry;
    const profileId = o.own ? across?.profile ?? '' : o.entry.profile;
    const before = index > 0 ? all[index - 1] : null;
    const beforeProfile = before ? (before.own ? across?.profile : before.entry.profile) : null;
    return {
      id: o.own ? s.id : o.key,
      name: s.name ?? '',
      emoji: s.emoji ?? '',
      color: s.color ?? '',
      abbr: abbreviate(s.name),
      index,
      active: o.own && s.id === view.spaceId,
      tabCount: o.own ? counts.get(s.id) ?? 0 : Number(s.tabCount) || 0,
      profile: multiProfile ? chipOf(profileId) : null,
      foreign: multiProfile && !o.own,
      profileMark: multiProfile && !o.own,
      profileStart: multiProfile && before != null && beforeProfile !== profileId,
      switching: !o.own && going === `${profileId}\u0000${s.id}`,
      // Its name, and with several profiles its profile's: "Work · Profile 2".
      label: multiProfile ? `${s.name ?? ''} · ${chipOf(profileId)?.name ?? ''}` : s.name ?? '',
    };
  });
  const chip = spaces.find((s) => s.active) ?? spaces.find((s) => !s.foreign) ?? spaces[0];
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
        section: item.section ?? '',
        sectionStart: !!item.sectionStart,
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

  // The space editor (ui/behaviors/editor.js), while a space is edited; or a
  // profile's name, emoji and color (the same part, `isProfile`).
  let editor = null;
  const edited = ui.editor?.spaceId != null ? state.spaces.find((s) => s.id === ui.editor?.spaceId) : null;
  const editedProfile = ui.editor?.profileId != null ? profiles.find((p) => p.id === ui.editor?.profileId) : null;
  if (ui.editor && editedProfile) {
    editor = {
      id: editedProfile.id,
      name: String(ui.editor.name ?? ''),
      emoji: String(ui.editor.emoji ?? ''),
      color: String(ui.editor.color ?? ''),
      colors: SPACE_COLORS.map((color, i) => ({ id: `c${i}`, color, selected: color === ui.editor?.color })),
      canDelete: false,
      cannotDelete: false,
      confirmDelete: false,
      deleteLabel: 'Delete',
      deleteTitle: '',
      labels: editedProfile.fromBrowser ? PROFILE_EDITOR_SAFARI_LABELS : PROFILE_EDITOR_LABELS,
      isProfile: true,
      nameLocked: editedProfile.fromBrowser,
    };
  } else if (ui.editor && edited) {
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
      deleteTitle: only ? (multiProfile ? 'A profile’s last space can’t be deleted' : 'The last space can’t be deleted') : 'Tabs and pins move to the first space',
      labels: EDITOR_LABELS,
      isProfile: false,
      nameLocked: false,
    };
  }

  // The new-tab page's launcher (Arcadia's newtab.js renderLauncher): the
  // space's pins, folders' too, and the latest archived tabs.
  let launcher = null;
  if (ui.inNewTab || ui.launcherPage) {
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
      settingsOpen: !!ui.settingsOpen,
    };
  }
  // Its Settings form, open (ui/settings-form.js).
  let settingsForm = null;
  if (launcher && ui.settingsOpen) {
    const fields = settingsFields(state.settings, input.platform?.features ?? {}, { recording: ui.recording ?? null, status: ui.settingsStatus ?? {} });
    settingsForm = { fields, hasFields: fields.length > 0 };
  }

  // A switch to another profile that needs the person, or didn't work: said as a notice.
  const acrossNotice = !notice && across?.switching?.notice ? { id: 'profile-switch', text: across.switching.notice, actions: [], hasActions: false } : null;

  return {
    version: VM_VERSION,
    ready: true,
    window: win,
    space,
    spaces,
    profiles,
    profile: profiles.find((p) => p.here) ?? null,
    multiProfile,
    tab,
    archive,
    hasArchive: archive.length > 0,
    palette: { open: !!paletteUi.open, query: paletteUi.query ?? '', newTab: !!paletteUi.newTab, rows, hasRows: rows.length > 0, selected },
    menu,
    editing,
    editor,
    notice: notice ?? acrossNotice,
    prompt,
    gesture,
    launcher,
    settingsForm,
    cloudTabs: cloudView(state, now),
    settings,
    platform,
  };
}

// ---------------------------------------------------------------------------
// iCloud Tabs (shared/cloud-tabs.js): the folder, its devices and their tabs.

const CLOUD_LABELS = Object.freeze({ title: 'iCloud Tabs', fix: 'Open Full Disk Access', pinned: 'Pinned on that device' });
const CLOUD_MESSAGES = Object.freeze({
  empty: 'No tabs are open on your other devices.',
  noAccess: 'Margin needs Full Disk Access to show the tabs open on your other devices.',
  noData: 'No iCloud Tabs yet. They show here once Safari syncs your tabs with iCloud (System Settings › your name › iCloud › Safari, on each device).',
  failed: 'Margin couldn’t read iCloud Tabs from this version of Safari.',
});

/** @param {State} state @param {number} now @returns {CloudTabsView | null} */
function cloudView(state, now) {
  const cloud = cloudShown(state);
  if (!cloud) return null;
  const open = state.settings?.cloudTabsOpen !== false;
  const closed = new Set(Array.isArray(state.settings?.cloudTabsClosed) ? state.settings.cloudTabsClosed : []);
  const names = deviceNames(cloud.devices);
  const devices = cloud.devices.map((d) => {
    const used = lastUsed(d);
    const name = names.get(d.id) ?? d.name;
    const updated = updatedText(used.at, used.exact, now);
    const tabs = d.tabs.map((t) => {
      const f = face(state, { url: t.url }, t.title || hostOf(t.url) || t.url);
      const label = (f.host && f.host !== f.title ? `${f.title}, ${f.host}` : f.title) + (t.pinned ? `, ${CLOUD_LABELS.pinned.toLowerCase()}` : '');
      return { kind: /** @type {'cloud'} */ ('cloud'), id: t.id, ...f, pinned: t.pinned, deviceId: d.id, label };
    });
    const shown = !closed.has(d.id);
    return {
      kind: /** @type {'cloud-device'} */ ('cloud-device'), id: d.id, name, label: onDevice(name), describe: updated ? `${onDevice(name)}, ${updated}` : onDevice(name), updated,
      isPhone: d.kind === 'phone', isPad: d.kind === 'pad', isMac: d.kind === 'mac', isVision: d.kind === 'vision', isOther: d.kind === 'other',
      open: shown, stale: !!used.at && now - used.at > STALE_MS, count: tabs.length, tabs, shown: shown ? tabs : [],
    };
  });
  const ready = cloud.status === 'ready' && devices.length > 0;
  const empty = cloud.status === 'ready' && !devices.length;
  const message = empty ? CLOUD_MESSAGES.empty : cloud.status === 'ready' ? '' : CLOUD_MESSAGES[cloud.status] ?? '';
  const count = devices.reduce((n, d) => n + d.count, 0);
  return {
    open, ready, empty, noAccess: cloud.status === 'noAccess', noData: cloud.status === 'noData', failed: cloud.status === 'failed',
    message, hasMessage: !!message, canFix: cloud.status === 'noAccess',
    devices, hasDevices: devices.length > 0, count, hasCount: count > 0,
    labels: { ...CLOUD_LABELS, toggle: open ? 'Hide iCloud Tabs' : 'Show iCloud Tabs' },
  };
}

/** A profile's chip. @param {import('../shared/across.js').AcrossProfile} p @returns {ProfileChip} */
function profileChip(p) {
  return {
    id: p.id, name: p.name, emoji: p.emoji, color: p.color, initial: [...String(p.name ?? '').trim()][0]?.toUpperCase() ?? '',
    here: p.here, linked: p.linked, stale: p.stale, spaces: p.spaces,
    fromBrowser: p.nameFrom === 'safari', symbol: p.symbol && checkIconUrl(p.symbol) ? p.symbol : null,
  };
}

/** A notice or prompt's view: its words and buttons, as text. @param {any} n @returns {NoticeView} */
function noticeView(n) {
  const actions = (Array.isArray(n.actions) ? n.actions : []).slice(0, 4).map((a, i) => ({
    id: String(a?.id ?? `a${i}`), label: String(a?.label ?? ''), primary: !!a?.primary, danger: !!a?.danger,
  }));
  return { id: String(n.id), text: String(n.text ?? ''), actions, hasActions: actions.length > 0 };
}

/** A gesture's view (GestureView). @param {any} g @returns {GestureView | null} */
function gestureView(g) {
  const kind = g?.kind === 'pull' || g?.kind === 'swipe' ? g.kind : null;
  if (!kind) return null;
  const done = g.state === 'done';
  const progress = done ? 1 : Math.round(Math.max(0, Math.min(1, Number(g.progress) || 0)) * 20) / 20;
  return {
    pull: kind === 'pull', swipe: kind === 'swipe',
    back: kind === 'swipe' && Number(g.direction) <= 0, forward: kind === 'swipe' && Number(g.direction) > 0,
    armed: done || g.state === 'armed', done, progress, percent: Math.round(progress * 100),
  };
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
const MENU_LABELS = Object.freeze({ tab: 'Tab', pin: 'Pin', folder: 'Folder', space: 'Space', add: 'New', cloud: 'iCloud Tab' });
const EDITOR_LABELS = Object.freeze({ title: 'Edit space', name: 'Space name', emoji: 'Space emoji', colors: 'Space color', save: 'Save', cancel: 'Cancel', note: '' });
const PROFILE_EDITOR_LABELS = Object.freeze({ title: 'Edit profile', name: 'Profile name', emoji: 'Profile emoji', colors: 'Profile color', save: 'Save', cancel: 'Cancel', note: '' });
const PROFILE_EDITOR_SAFARI_LABELS = Object.freeze({
  ...PROFILE_EDITOR_LABELS, name: 'Profile name (Safari’s)',
  note: 'The name is Safari’s: rename the profile in Safari › Settings › Profiles and Margin follows. The emoji and color are Margin’s.',
});

// Rows that go somewhere (Arcadia's arrow button).
const GOES = new Set(['tab', 'pin', 'archive', 'go', 'cloud']);

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
