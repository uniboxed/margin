// The theme view model (PLAN.md §3 "What a theme can read", with §14's
// additions): the one object a theme's bindings read, built from Margin's
// stored state (shared/stored.ts fromStorage, as pages read it) and the UI's
// own state (which window, the sidebar, the palette, menus). The same in
// every host.
//
// The sections and their order are today's sidebar's: shared/view.ts
// `sidebar` decides them (the window's space, its pinned area of folders and
// pins, "+ New Tab", its other tabs newest first, which row is active), and
// this only reshapes its answer for themes. Icons are `data:` images Margin
// stored (state.favicons, or one the browser gave as data), else a letter on
// a color (shared/view.ts letterAvatar, as Arcadia draws them).
//
// Immutable, with structural sharing: `buildViewModel(input, prev)` returns
// frozen objects, and every part that's the same as in `prev` (a row, a
// list, the space, the whole model) IS `prev`'s object. The renderer skips a
// row whose item is the same object (ui/render.ts), so this is what keeps an
// update down to the rows that changed. Pure: no browser APIs, runs in Node.
import { themeChoices, spaceThemeId, spaceThemesOn } from './space-theme.ts';
import type { State } from '../../types/margin';
import * as V from '../shared/view.ts';
import { NEW_TAB } from '../shared/switching.ts';
import { hostOf } from '../shared/dom.ts';
import { rankPalette } from '../shared/search.ts';
import { checkIconUrl } from './sanitize.ts';
import { appIcon, appOfItem, isBundleId } from '../shared/apps.ts';
import type { InstalledApp } from '../shared/apps.ts';
import { CONFIRM_LABEL, SPACE_COLORS, menuItems } from './behaviors/menu-items.ts';
import type { MenuTarget } from './behaviors/menu-items.ts';
import { SETTINGS_CATEGORIES, categoryNamed, fieldsIn, settingsFields } from './settings-form.ts';

/** The view model's version: a theme reads what this version documents. */
export const VM_VERSION = 1;

export type WindowMode = 'fullscreen' | 'windowed' | 'inpage';
export type SidebarState = 'open' | 'hidden' | 'peek';
export type UiState = {
  windowId?: number | null,
  tabId?: number | null,
  mode?: WindowMode,
  focused?: boolean,
  sidebar?: SidebarState | null,
  palette?: { open?: boolean, query?: string, selected?: number, newTab?: boolean, selectAll?: boolean },
  toast?: { id: string, text: string } | null,
  menu?: { kind: MenuTarget['kind'], id?: string | number | null, x?: number, y?: number, above?: boolean, confirming?: string | null } | null,
  editing?: { kind: 'space' | 'folder' | 'tab' | 'pin', id: string | number } | null,
  // (`fresh`: a space just made, switched to as its editor closes.)
  editor?: { spaceId?: string, name: string, emoji: string, color: string, theme?: string, confirmDelete?: boolean, fresh?: boolean } | null,
  newTabPending?: boolean,
  opening?: { title: string, url: string, from: number | null } | null,
  notice?: { id: string, text: string, actions?: { id: string, label: string, primary?: boolean }[] } | null,
  prompt?: { id: string, title?: string, text: string, actions?: { id: string, label: string, primary?: boolean, danger?: boolean }[] } | null,
  launcher?: { allArchived?: boolean } | null,
  settingsOpen?: boolean,
  settingsPage?: boolean,
  /** Margin.app's own window (ui/host-app.ts): its Settings is a tab of its own (margin://settings), not in the launcher. */
  appWindow?: boolean,
  /** The theme draws the Settings page's categories (it reads `settingsTab`): one category's fields at a time. */
  settingsNav?: boolean,
  /** The Settings page's category shown (ui/settings-form.ts SETTINGS_CATEGORIES); none: the first. */
  settingsCategory?: string | null,
  recording?: string | null,
  settingsStatus?: Record<string, { text: string, error?: boolean } | undefined>,
  switchingTo?: number | string | null,
  /**
   * What's in front ahead of the state (ui/intents.ts): a row's tab after a close (`tab`, drawn as a switch's), a pin
   * with no tab being opened (`pin`). A switch under way (`switchingTo`) comes first.
   * */
  front?: { tab: number | string | null, pin: string | null } | null,
  justShown?: boolean,
  inNewTab?: boolean,
  launcherPage?: boolean,
  /**
   * Margin.app's own window: an item is being opened in the page area (its name, as the app says it): the page card's
   * loader; `bundleId`: the app whose icon it shows (the app's own, the browser's for a web item), from the state's `apps`.
   * */
  pageOpening?: { name: string, bundleId?: string | null, starting?: boolean, elsewhere?: boolean } | null,
  /** Margin.app's own window hosting another app's window beside it: no page area here (ui/host-app.ts pageOutside). */
  pageOutside?: boolean,
  /** The host keeps the sidebar docked (Margin.app's window hosting: a tile beside it, or an app's window in its page area). */
  sidebarDocked?: boolean,
  pageLoading?: boolean,
  gesture?: { kind: 'pull' | 'swipe', state: 'pulling' | 'armed' | 'done' | 'leaving', progress?: number, direction?: number } | null,
  theme?: { id: string, name: string, settings: Record<string, any> } | null,
};
export type ViewModelInput = {
  // As read from storage (usable() takes what's there): its settings may be only some of them.
  state: Omit<Partial<State>, 'settings'> & { settings?: Partial<State['settings']> } & Record<string, any> | null,
  now?: number,
  ui?: UiState,
  platform?: { browser?: string, os?: string, marginFullscreen?: boolean, features?: Record<string, any> },
  settings?: Record<string, string | number | boolean>,
};
/**
 * A row's face. `isApp`: an installed app's own icon is shown (an app item with its app's icon): macOS app icons carry
 * transparent room inside their image, so a theme draws them bigger than a site's icon in the same place (`.app`),
 * in their own shape, with no tile or frame.
 * */
export type Face = { title: string, url: string, host: string, icon: string | null, letter: string, color: string, isApp: boolean };
export type TabRow = Face & {
  kind: 'tab', id: number | string, active: boolean, behind: boolean, away: boolean,
  audible: boolean, muted: boolean, asleep: boolean, loading: boolean, pinned: false,
  open: boolean, notOpen: boolean, hasCustomTitle: boolean,
};
export type PinRow = Face & {
  kind: 'pin', isFolder: false, id: string, folderId: string | null, nested: boolean, depth: number,
  tabId: number | null, open: boolean, active: boolean, behind: boolean, away: boolean,
  drifted: boolean, rootUrl: string, hasCustomTitle: boolean,
  audible: boolean, muted: boolean, asleep: boolean, loading: boolean, pinned: true,
};
export type FolderRow = {
  kind: 'folder', isFolder: true, id: string, name: string, open: boolean,
  parentFolderId: string | null, depth: number,
  count: number, pins: PinRow[], shown: PinRow[], hasShown: boolean,
};
export type SpaceChip = {
  id: string, name: string, emoji: string, color: string, abbr: string,
  index: number, number: number, active: boolean, tabCount: number,
  label: string,
};
export type SpaceView = SpaceChip & {
  pinned: (FolderRow | PinRow)[], pinnedFlat: (FolderRow | PinRow)[], folders: FolderRow[], pins: PinRow[],
  today: TabRow[], hasToday: boolean, hasPinned: boolean,
  newTab: { active: boolean },
};
export type ActiveTab = Face & {
  id: number, loading: boolean, audible: boolean, muted: boolean, asleep: boolean, pinned: boolean, newTab: boolean,
};
export type ArchiveRow = Face & { id: string, spaceId: string, closedAt: number, ago: string };
export type PaletteRow = {
  id: string, kind: string, title: string, subtitle: string, badge: string, spaceColor: string,
  emoji: string, isSearch: boolean, isOpen: boolean, icon: string | null, letter: string, color: string,
  selected: boolean, goes: boolean, section: string, sectionStart: boolean,
  /** an installed app (Margin.app, hosting on): its icon is the app's own shape, drawn without a tile */
  isApp: boolean,
};
export type MenuRow = { id: string, label: string, separator: boolean, danger: boolean, confirming: boolean };
export type EditorView = {
  id: string, name: string, emoji: string, color: string,
  colors: { id: string, color: string, selected: boolean }[],
  /** The themes the space can have (ui/space-theme.ts), the chosen one selected (none where each space's theme isn't
   * drawn: `hasThemes` false); `theme`: its id. */
  themes: { id: string, name: string, selected: boolean }[], hasThemes: boolean, theme: string,
  canDelete: boolean, cannotDelete: boolean, confirmDelete: boolean, deleteLabel: string, deleteTitle: string,
  labels: { title: string, name: string, emoji: string, colors: string, theme: string, save: string, cancel: string },
};
export type NoticeAction = { id: string, label: string, primary: boolean, danger: boolean };
export type NoticeView = { id: string, text: string, actions: NoticeAction[], hasActions: boolean };
export type PromptView = NoticeView & { title: string };
export type ToastView = { id: string, text: string };
export type GestureView = { pull: boolean, swipe: boolean, back: boolean, forward: boolean, armed: boolean, done: boolean, leaving: boolean, progress: number, percent: number };
export type LauncherView = {
  pins: PinRow[], hasPins: boolean, archive: ArchiveRow[], hasArchive: boolean, emptyArchive: boolean,
  more: boolean, moreLabel: string, settingsOpen: boolean, settingsPage: boolean, canSearch: boolean,
  /** Settings under the search field (its button): not in Margin.app's window, where Settings is its own tab. */
  hasSettings: boolean,
};
export type SettingsFormView = { fields: import('./settings-form.ts').SettingsField[], hasFields: boolean };
/**
 * Settings as its own page (Margin.app's Settings tab, the new-tab page's #settings), as macOS's System Settings: its
 * categories for a sidebar (`is…`: which one, for a theme's icon), the one shown (`current`) beside them, its fields
 * in `settingsForm`. Every word is Margin's.
 */
export type SettingsCategoryView = { id: string, label: string, help: string, selected: boolean, isAppearance: boolean, isTabs: boolean, isBrowsing: boolean, isKeyboard: boolean };
export type SettingsTabView = { title: string, categories: SettingsCategoryView[], current: SettingsCategoryView };
export type ViewModel = {
  version: number,
  ready: boolean,
  window: {
    id: number | null, mode: WindowMode, focused: boolean, sidebar: SidebarState,
    sidebarOpen: boolean, peek: boolean, pinnedOpen: boolean, pageOutside: boolean, frameWhenHidden: boolean,
  },
  space: SpaceView,
  spaces: SpaceChip[],
  tab: ActiveTab | null,
  archive: ArchiveRow[],
  hasArchive: boolean,
  palette: { open: boolean, query: string, newTab: boolean, rows: PaletteRow[], hasRows: boolean, selected: string | null },
  menu: { kind: string, id: string | number | null, x: number, y: number, label: string, items: MenuRow[], hasItems: boolean } | null,
  editing: { kind: 'space' | 'folder' | 'tab' | 'pin', id: string | number } | null,
  editor: EditorView | null,
  notice: NoticeView | null,
  prompt: PromptView | null,
  toast: ToastView | null,
  gesture: GestureView | null,
  launcher: LauncherView | null,
  /** The page card's loader (the `page-loader` part), while an item opens in the page area: Margin's words for it. */
  pageLoader: { name: string, label: string, icon: string | null } | null,
  settingsForm: SettingsFormView | null,
  settingsTab: SettingsTabView | null,
  settings: Record<string, string | number | boolean>,
  platform: { browser: string, os: string },
};

// ---------------------------------------------------------------------------
// The state as pages read it can miss keys (a background that hasn't written
// them yet): what the view needs, filled in.

function usable(raw: any): State | null {
  if (!raw || !Array.isArray(raw.spaces) || !raw.spaces.length) return null;
  return ({
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
  } as State);
}

// ---------------------------------------------------------------------------
// Rows.

/** A space's short name for a chip: two letters, from its first two words or its first word. */
export function abbreviate(name: string) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const letters = words.length > 1 ? [...words[0]].slice(0, 1).concat([...words[1]].slice(0, 1)) : [...words[0]].slice(0, 2);
  return letters.join('').toUpperCase();
}

function face(state: State, item: { url?: string, title?: string, favIconUrl?: string, target?: unknown }, title: string): Face {
  const url = item.url ?? '';
  const app = appOfItem(item);
  // Margin's own pages (the new-tab page, the start page) have the extension's id for a host: never shown. An app item:
  // its name, as its row says it (its address app://<bundle id> isn't a site: "com.apple.Maps" was drawn, 2026-11-20).
  const host = app ? title : /^[a-z-]*-extension:/i.test(url) ? '' : hostOf(url);
  // (An app item: the installed app's icon, V.iconFor; with none, its name's letter, not its bundle id's.)
  const icon = V.iconFor(state, item);
  const { letter, color } = V.letterAvatar((app ? '' : host) || title || '?');
  const shown = checkIconUrl(icon) ? icon : null;
  return { title, url, host, icon: shown, letter, color, isApp: !!app && shown != null };
}

const isLoading = (t: { status?: string, loading?: boolean } | null | undefined) => t?.status === 'loading' || t?.loading === true;

// A tab's row: an open one by its browser tab's id, a Margin tab that isn't
// open (shared/view.ts `kept`) by its own id (a string), `open` false and
// `notOpen` true: a theme draws it as not open (Arcadia and Neubrutalism dim
// it), and a click opens it (tab.activate) where it was clicked.
function tabRow(state: State, t: any): TabRow {
  const open = !t.kept;
  const custom = typeof t.customTitle === 'string' && t.customTitle.trim() ? t.customTitle.trim() : '';
  return {
    kind: 'tab',
    id: t.id,
    ...face(state, t, custom || t.title || t.url || 'New Tab'),
    active: !!t.active,
    behind: open && !!t.behind,
    // Chosen here, but live in another window of the profile (docs/BROWSER-WINDOWS.md §9): drawn faded.
    away: open && !!t.away,
    audible: open && !!t.audible,
    muted: open && !!t.muted,
    asleep: open && !!t.sleeping,
    loading: open && isLoading(t),
    pinned: false,
    open,
    notOpen: !open,
    hasCustomTitle: !!custom,
  };
}

/** @param p a pin as shared/view.ts sidebar shows it */
function pinRow(state: State, p: any, nested: boolean, depth: number = nested ? 1 : 0): PinRow {
  const tab = ((p.tabId != null ? state.tabs[p.tabId] : null) as any);
  const custom = typeof p.customTitle === 'string' && p.customTitle.trim() ? p.customTitle.trim() : '';
  const liveTitle = tab?.customTitle || tab?.title;
  return {
    kind: 'pin',
    isFolder: false,
    id: p.id,
    ...face(state, tab ?? p, custom || (p.drifted && liveTitle ? liveTitle : p.title) || p.url || ''),
    folderId: p.folderId ?? null,
    nested,
    depth,
    tabId: p.tabId ?? null,
    open: p.tabId != null,
    active: !!p.active,
    behind: !!p.behind,
    away: !!p.away,
    drifted: !!p.drifted,
    rootUrl: p.rootUrl ?? p.url ?? '',
    hasCustomTitle: !!custom,
    audible: !!tab?.audible,
    muted: !!tab?.muted,
    asleep: !!tab?.sleeping,
    loading: isLoading(tab),
    pinned: true,
  };
}

// ---------------------------------------------------------------------------
// The model, fresh (every object new), then shared with the last one.

function fresh(input: ViewModelInput): ViewModel {
  const ui = input.ui ?? {};
  const state = usable(input.state);
  const platform = { browser: input.platform?.browser ?? 'unknown', os: input.platform?.os ?? 'unknown' };
  const settings = input.settings ?? {};
  const pinnedOpen = !!state?.settings?.sidebarPinnedOpen;
  // Margin's own pages (the launcher) always show the sidebar beside it. With no page area of its own (Margin.app's
  // window hosting another app's window beside it: `pageOutside`), the sidebar is all there is: always docked
  // (`sidebarDocked`, the host's). An app's window in the page area leaves it as the person keeps it: Margin's window is
  // in front of that window, so a hidden sidebar comes out over it (2026-11-20; docked until then: 2026-11-15, the
  // hosted window above Margin's, FaceTime covered where the sidebar was).
  const sidebar = ui.pageOutside || ui.sidebarDocked ? 'open' : ui.sidebar === 'open' || ui.sidebar === 'hidden' || ui.sidebar === 'peek' ? ui.sidebar : pinnedOpen || ui.launcherPage ? 'open' : 'hidden';
  const windowId = ui.windowId ?? null;
  const win = {
    id: windowId,
    mode: ui.mode ?? 'inpage',
    focused: ui.focused !== false,
    sidebar,
    sidebarOpen: sidebar === 'open',
    peek: sidebar === 'peek',
    pinnedOpen,
    // The page area is another window's, beside this one (Margin.app hosting): a theme may style the sidebar alone.
    pageOutside: !!ui.pageOutside,
    // The sidebar hidden: Margin's frame stays around the page (a setting).
    frameWhenHidden: state?.settings?.frameWhenHidden !== false,
  };
  const paletteUi = ui.palette ?? {};
  const editing = ui.editing ? { kind: ui.editing.kind, id: ui.editing.id } : null;
  const notice = ui.notice ? noticeView(ui.notice) : null;
  const prompt = ui.prompt ? { ...noticeView(ui.prompt), title: String(ui.prompt.title ?? '') } : null;
  const toast = ui.toast && typeof ui.toast.text === 'string' && ui.toast.text ? { id: String(ui.toast.id ?? 'toast'), text: ui.toast.text.slice(0, 140) } : null;
  const gesture = ui.gesture ? gestureView(ui.gesture) : null;
  // (Margin's own words: the name is the app's or the item's, as Margin.app says it.)
  const loadingName = ui.pageOpening ? String(ui.pageOpening.name ?? '').slice(0, 120) : '';
  // Its icon: the installed app's, by the bundle id the app named (never bytes of the app's message), checked as a row's.
  const loadingApp = ui.pageOpening && isBundleId(ui.pageOpening.bundleId) ? ui.pageOpening.bundleId : null;
  const loadingIcon = loadingApp ? appIcon((state as { apps?: InstalledApp[] | null } | null)?.apps, loadingApp) : null;
  // (Margin's start, its default browser first: its own words, never "Opening Getting you started…".)
  // (Its item in another Margin window: its card, faded, saying where it is; brought in front or clicked, this window
  // takes it back.)
  const loadingLabel = ui.pageOpening?.elsewhere === true ? `${loadingName || 'This tab'} is in another window. Click to show it here.`
    : ui.pageOpening?.starting === true ? 'Getting you started…' : loadingName ? `Opening ${loadingName}…` : 'Opening…';
  const pageLoader = ui.pageOpening ? { name: loadingName, label: loadingLabel, icon: checkIconUrl(loadingIcon) ? loadingIcon : null } : null;
  if (!state) {
    return {
      version: VM_VERSION, ready: false, window: win,
      space: { id: '', name: '', emoji: '', color: '', abbr: '', index: 0, number: 1, active: true, tabCount: 0, label: '', pinned: [], pinnedFlat: [], folders: [], pins: [], today: [], hasToday: false, hasPinned: false, newTab: { active: false } },
      spaces: [], tab: null, archive: [], hasArchive: false,
      palette: { open: !!paletteUi.open, query: paletteUi.query ?? '', newTab: !!paletteUi.newTab, rows: [], hasRows: false, selected: null },
      menu: null, editing, editor: null, notice, prompt, toast, gesture, launcher: null, pageLoader, settingsForm: null, settingsTab: null, settings, platform,
    };
  }

  const currentTabId = ui.tabId ?? null;
  const view = V.sidebar(state, windowId, currentTabId, {
    newTabPending: !!(paletteUi.open && paletteUi.newTab) || !!ui.newTabPending,
    switchingTo: ui.switchingTo ?? ui.front?.tab ?? null,
    pinning: ui.switchingTo == null ? ui.front?.pin ?? null : null,
    justShown: !!ui.justShown,
    opening: ui.switchingTo === NEW_TAB ? ui.opening ?? null : null,
  });

  // The pinned area, in the order shown: folders (with their pins) and the
  // pins in none. A closed folder shows only the pin of the tab in front
  // (`shown`: view.peek), so the highlight stays in sight.
  const pins: PinRow[] = [];
  const folders: FolderRow[] = [];
  const pinById = new Map<string, PinRow>();
  const pinned = view.pinned.map((item: any) => {
    if (item.kind !== 'folder') {
      const row = pinRow(state, item, false, 0);
      pins.push(row);
      pinById.set(row.id, row);
      return row;
    }
    const inside = item.pins.map((p: any) => {
      const r = pinRow(state, p, true, p.depth ?? 1);
      pinById.set(r.id, r);
      return r;
    });
    const byId = new Map(inside.map((p: PinRow) => [p.id, p]));
    const shown = item.open ? inside : item.peek.map((p: any) => byId.get(p.id)!); // (peek: some of its pins)
    const folder: FolderRow = { kind: 'folder', isFolder: true, id: item.id, name: item.name, open: item.open, parentFolderId: item.parentFolderId ?? null, depth: item.depth ?? 0, count: inside.length, pins: inside, shown, hasShown: shown.length > 0 };
    folders.push(folder);
    return folder;
  });
  const pinnedFlat: (FolderRow | PinRow)[] = (view.pinnedFlat ?? []).map((item: any) => {
    if (item.kind !== 'folder') return pinById.get(item.id) ?? pinRow(state, item, (item.depth ?? 0) > 0, item.depth ?? 0);
    const existing = folders.find((f) => f.id === item.id);
    if (existing) return existing;
    const inside = (item.pins ?? []).map((p: any) => pinById.get(p.id) ?? pinRow(state, p, true, (item.depth ?? 0) + 1));
    const shown = item.open ? inside : (item.peek ?? []).map((p: any) => pinById.get(p.id)!).filter(Boolean);
    const folder: FolderRow = { kind: 'folder', isFolder: true, id: item.id, name: item.name, open: item.open, parentFolderId: item.parentFolderId ?? null, depth: item.depth ?? 0, count: inside.length, pins: inside, shown, hasShown: shown.length > 0 };
    folders.push(folder);
    return folder;
  });
  const today = view.tabs.map((t) => tabRow(state, t));

  // A space's tab count: its tabs open in any window of the profile (pinned or not: a space's list is the
  // space's, docs/BROWSER-WINDOWS.md §9), and its tabs that aren't open (shown in every window).
  const counts = new Map();
  for (const t of Object.values(state.tabs)) {
    const s = state.tabSpace[t.id];
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  for (const k of Object.values(state.keptTabs ?? {})) counts.set(k.spaceId, (counts.get(k.spaceId) ?? 0) + 1);
  const spaces = state.spaces.map((s, index) => ({
    id: s.id,
    name: s.name ?? '',
    emoji: s.emoji ?? '',
    color: s.color ?? '',
    abbr: abbreviate(s.name),
    index,
    // Its place counted from 1, for themes that show it (Pixel's "WORLD 2-1").
    number: index + 1,
    active: s.id === view.spaceId,
    tabCount: counts.get(s.id) ?? 0,
    label: s.name ?? '',
  }));
  const chip = spaces.find((s) => s.active) ?? spaces[0];
  const space: SpaceView = {
    ...chip,
    pinned,
    pinnedFlat,
    folders,
    pins,
    today,
    hasToday: today.length > 0,
    hasPinned: pinned.length > 0,
    newTab: { active: !!view.newTab.active },
  };

  // The tab in front: this page's own (in pages), else the window's active one.
  const current: any = (currentTabId != null ? state.tabs[currentTabId] : null)
    ?? Object.values(state.tabs).find((t) => t.windowId === windowId && t.active) ?? null;
  const pinnedUrls = new Set(state.pins.filter((p) => p.spaceId === state.tabSpace[current?.id]).map((p) => V.normalizeUrl(p.url)));
  const tab = current ? {
    id: current.id,
    ...face(state, current, current.customTitle || current.title || current.url || 'New Tab'),
    // Loading: as the background records it, or this page's own load (the
    // in-page host: content/loader.js, the pill's timing).
    loading: isLoading(current) || (!!ui.pageLoading && current.id === currentTabId),
    audible: !!current.audible,
    muted: !!current.muted,
    asleep: !!current.sleeping,
    pinned: !!current.pinnedBy || pinnedUrls.has(V.normalizeUrl(current.url)),
    newTab: V.isNewTabPage(current.url),
  } : null;

  const now = Number.isFinite(input.now) ? (input.now as number) : Date.now();
  const archive = state.archive.map((a) => ({
    id: a.id,
    ...face(state, a, a.title || a.url || ''),
    spaceId: a.spaceId ?? '',
    closedAt: Number(a.closedAt) || 0,
    ago: ago(Number(a.closedAt) || 0, now),
  }));

  // The palette's rows: shared/search.ts ranks them, as Arcadia's palette.
  let rows: PaletteRow[] = [];
  let selected: string | null = null;
  if (paletteUi.open) {
    const items = rankPalette(state, paletteUi.query ?? '', paletteContext(ui, input.platform));
    const at = items.length ? Math.min(Math.max(0, paletteUi.selected ?? 0), items.length - 1) : -1;
    rows = items.map((item, i) => {
      const { letter, color } = V.letterAvatar((appOfItem(item) ? '' : hostOf(item.url)) || item.title || '?');
      const icon = item.favIconUrl;
      return {
        id: item.id,
        kind: item.kind,
        title: item.title ?? '',
        subtitle: item.subtitle ?? '',
        badge: item.badge ?? '',
        // The badge's space's color ('' for Archived, Search…): a tag can match that space's chip.
        spaceColor: item.spaceColor ?? '',
        emoji: item.emoji ?? '',
        // The typed text as a search, or as an address to open (a theme may draw its own icon).
        isSearch: item.kind === 'go' && item.search === true,
        isOpen: item.kind === 'go' && item.search === false,
        // (An app picked from the installed ones, or an item of the space that's an app.)
        isApp: item.kind === 'app' || !!appOfItem(item),
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

  // A context menu (ui/behaviors/menus.ts): its rows, from what it's for.
  let menu: ViewModel['menu'] = null;
  if (ui.menu) {
    const items = menuItems((ui.menu as any), { state, space, features: input.platform?.features ?? null });
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

  // The space editor (ui/behaviors/editor.ts), while a space is edited.
  let editor: ViewModel['editor'] = null;
  const edited = ui.editor?.spaceId != null ? state.spaces.find((s) => s.id === ui.editor?.spaceId) : null;
  if (ui.editor && edited) {
    const only = state.spaces.length < 2;
    // (The one picked in the editor, if it's there; else the theme the space is drawn with.)
    const choices = spaceThemesOn(input.platform?.features) ? themeChoices(input.platform?.features) : [];
    const editorTheme = choices.some((c) => c.id === ui.editor?.theme) ? ui.editor.theme! : spaceThemeId(edited, state.settings, input.platform?.features, choices);
    editor = {
      id: edited.id,
      name: String(ui.editor.name ?? ''),
      emoji: String(ui.editor.emoji ?? ''),
      color: String(ui.editor.color ?? ''),
      colors: SPACE_COLORS.map((color, i) => ({ id: `c${i}`, color, selected: color === ui.editor?.color })),
      themes: choices.map((c) => ({ ...c, selected: c.id === editorTheme })),
      hasThemes: choices.length > 0,
      theme: editorTheme,
      canDelete: !only,
      cannotDelete: only,
      confirmDelete: !!ui.editor.confirmDelete,
      deleteLabel: ui.editor.confirmDelete ? CONFIRM_LABEL : 'Delete',
      deleteTitle: only ? 'The last space can’t be deleted' : 'Tabs and pins move to the first space',
      labels: EDITOR_LABELS,
    };
  }

  // The new-tab page's launcher (Arcadia's newtab.ts renderLauncher): the
  // space's pins, folders' too, and the latest archived tabs.
  let launcher: ViewModel['launcher'] = null;
  if (ui.inNewTab || ui.launcherPage) {
    const tiles = pinned.flatMap((p) => (p.isFolder ? p.pins : [p as PinRow]));
    const all = ui.launcher?.allArchived;
    const shown = all ? archive : archive.slice(0, LAUNCHER_ARCHIVE);
    launcher = {
      pins: tiles,
      hasPins: !ui.settingsPage && tiles.length > 0,
      archive: shown,
      hasArchive: !ui.settingsPage && archive.length > 0,
      emptyArchive: archive.length === 0,
      more: archive.length > LAUNCHER_ARCHIVE,
      moreLabel: all ? 'Show fewer' : `Show all ${archive.length}`,
      settingsOpen: !!ui.settingsOpen || !!ui.settingsPage,
      settingsPage: !!ui.settingsPage, canSearch: !ui.settingsPage,
      hasSettings: !ui.appWindow,
    };
  }
  // Settings as its own page: its categories, the one shown.
  let settingsTab: ViewModel['settingsTab'] = null;
  const category = categoryNamed(ui.settingsCategory);
  if (launcher && ui.settingsPage) {
    const categories = SETTINGS_CATEGORIES.map((c) => ({
      id: c.id, label: c.label, help: c.help, selected: c.id === category,
      isAppearance: c.id === 'appearance', isTabs: c.id === 'tabs', isBrowsing: c.id === 'browsing', isKeyboard: c.id === 'keyboard',
    }));
    settingsTab = { title: 'Settings', categories, current: categories.find((c) => c.selected)! };
  }
  // Its Settings form, open (ui/settings-form.ts): on the Settings page of a theme that draws its categories, the
  // category shown's fields only.
  let settingsForm: ViewModel['settingsForm'] = null;
  if (launcher && (ui.settingsOpen || ui.settingsPage)) {
    // (Its Theme: the space this window shows, its own; ui/space-theme.ts.)
    const shownSpace = state.spaces.find((s) => s.id === space.id) ?? null;
    const spaceTheme = shownSpace && spaceThemesOn(input.platform?.features) ? spaceThemeId(shownSpace, state.settings, input.platform?.features) : null;
    const all = settingsFields(state.settings, input.platform?.features ?? {}, { recording: ui.recording ?? null, status: ui.settingsStatus ?? {}, theme: ui.theme ?? null, spaceTheme });
    const fields = ui.settingsPage && ui.settingsNav ? fieldsIn(all, category) : all;
    settingsForm = { fields, hasFields: fields.length > 0 };
  }

  return {
    version: VM_VERSION,
    ready: true,
    window: win,
    space,
    spaces,
    tab,
    archive,
    hasArchive: !ui.settingsPage && archive.length > 0,
    palette: { open: !!paletteUi.open, query: paletteUi.query ?? '', newTab: !!paletteUi.newTab, rows, hasRows: rows.length > 0, selected },
    menu,
    editing,
    editor,
    notice,
    prompt,
    toast,
    gesture,
    launcher,
    pageLoader,
    settingsForm,
    settingsTab,
    settings,
    platform,
  };
}

/** A notice or prompt's view: its words and buttons, as text. */
function noticeView(n: any): NoticeView {
  const actions = (Array.isArray(n.actions) ? n.actions : []).slice(0, 4).map((a: { id?: unknown, label?: unknown, primary?: unknown, danger?: unknown } | null, i: number) => ({ // (the host's: anything)
    id: String(a?.id ?? `a${i}`), label: String(a?.label ?? ''), primary: !!a?.primary, danger: !!a?.danger,
  }));
  return { id: String(n.id), text: String(n.text ?? ''), actions, hasActions: actions.length > 0 };
}

/** A gesture's view (GestureView). */
function gestureView(g: any): GestureView | null {
  const kind = g?.kind === 'pull' || g?.kind === 'swipe' ? g.kind : null;
  if (!kind) return null;
  const done = g.state === 'done';
  const leaving = g.state === 'leaving';
  const progress = done ? 1 : leaving ? 0 : Math.round(Math.max(0, Math.min(1, Number(g.progress) || 0)) * 20) / 20;
  return {
    pull: kind === 'pull', swipe: kind === 'swipe',
    back: kind === 'swipe' && Number(g.direction) <= 0, forward: kind === 'swipe' && Number(g.direction) > 0,
    armed: done || g.state === 'armed', done, leaving, progress, percent: Math.round(progress * 100),
  };
}

// How long ago, as the launcher's archive says it (Arcadia's newtab.ts ago).
function ago(ts: number, now: number) {
  const minutes = Math.round((now - ts) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const LAUNCHER_ARCHIVE = 12;
// The words of Margin's own parts (the menu's and the editor's), which a
// theme binds rather than writes (ui/sanitize.ts GUARDED_PARTS).
const MENU_LABELS = Object.freeze({ tab: 'Tab', pin: 'Pin', folder: 'Folder', space: 'Space', add: 'New' });
const EDITOR_LABELS = Object.freeze({ title: 'Edit space', name: 'Space name', emoji: 'Space emoji', colors: 'Space color', theme: 'Space theme', save: 'Save', cancel: 'Cancel' });

// Rows that go somewhere (Arcadia's arrow button).
const GOES = new Set(['tab', 'pin', 'archive', 'go', 'app']);

/**
 * What shared/search.ts ranks the palette for: this window and tab.
 * */
export function paletteContext(ui: UiState, platform: ViewModelInput['platform']) {
  return { windowId: ui.windowId ?? null, tabId: ui.tabId ?? null, inNewTab: !!ui.inNewTab, canToggleSidebar: true, canFullscreen: !!platform?.marginFullscreen };
}

/**
 * The palette's items as ranked for the UI state (their actions included),
 * the same list the view model's rows come from.
 */
export function paletteItems(rawState: any, ui: UiState, platform: ViewModelInput['platform']) {
  const state = usable(rawState);
  if (!state || !ui.palette?.open) return [];
  return rankPalette(state, ui.palette.query ?? '', paletteContext(ui, platform));
}

// ---------------------------------------------------------------------------
// Structural sharing.

const EMPTY = Object.freeze([]);
// A list item's key: rows by kind and id (a folder and a pin never collide),
// else by id; anything else by place.
const keyOf = (item: unknown) => (item && typeof item === 'object' && 'id' in item ? (typeof (item as { kind?: unknown }).kind === 'string' ? `${(item as { kind?: unknown }).kind}:${item.id}` : item.id) : undefined);

/**
 * `next` with every part that equals `prev`'s replaced by `prev`'s object,
 * frozen. Lists match their items by key (so a row moved, or one inserted
 * before it, is still the same object), objects by field. `memo`: an object
 * of `next` that appears twice (a pin in `space.pinned` and `space.pins`)
 * comes out as one object.
 * */
function share<T>(next: T, prev: any, memo: Map<any, any>): T {
  if (next === prev || next === null || typeof next !== 'object') return next;
  const done = memo.get(next);
  if (done) return done;
  let out;
  if (Array.isArray(next)) {
    const old = Array.isArray(prev) ? prev : EMPTY;
    let byKey: Map<any, any> | null = null;
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
    const obj: Record<string, unknown> = {};
    for (const k of keys) {
      const had = old !== null && Object.prototype.hasOwnProperty.call(old, k);
      const v = share((next as Record<string, unknown>)[k], had ? old[k] : undefined, memo);
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
 * */
export function buildViewModel(input: ViewModelInput, prev: ViewModel | null = null): ViewModel {
  return share(fresh(input), prev, new Map());
}
