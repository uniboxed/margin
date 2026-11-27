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
import type { SpaceBackground, State } from '../../../types/margin';
import * as V from '../../../extension/shared/view.ts';
import { NEW_TAB } from '../../../extension/shared/switching.ts';
import { hostOf } from '../../../extension/shared/dom.ts';
import { rankPalette } from '../../../extension/shared/search.ts';
import { checkIconUrl } from './sanitize.ts';
import { appIcon, appOfItem, isBundleId } from '../../../extension/shared/apps.ts';
import { spaceKeyCaps } from '../../../extension/shared/app-keys.ts';
import type { InstalledApp } from '../../../extension/shared/apps.ts';
import { CONFIRM_LABEL, SPACE_COLORS, menuItems } from './behaviors/menu-items.ts';
import type { MenuTarget } from './behaviors/menu-items.ts';
import { SETTINGS_CATEGORIES, categoryNamed, fieldsIn, settingsFields } from './settings-form.ts';
import { selectBackgroundMedia, type MediaSource } from '../../../extension/shared/media.ts';
import { pickerView } from './picker/view.ts';
import type { PickerUi, PickerVm } from './picker/view.ts';

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
  /** The background mini player's sources (Margin.app's `media` push: overlay.ts), or one. */
  media?: MediaSource[] | MediaSource | null,
  // The preview card and Quick Tab (docs/PEEK-SPLIT.md §2, §3; Margin.app's `peek` push, ui/behaviors/card.ts; the
  // runtime's own names, `peek` and `littleArc`, kept): `loading` until its window is in place, `closing` as it goes,
  // `query` Quick Tab's field. Themes see it as `preview` (PreviewView).
  peek?: { url: string, title?: string, spaceId?: string | null, littleArc?: boolean, loading?: boolean, closing?: boolean, canGoBack?: boolean | null, canGoForward?: boolean | null, query?: string } | null,
  menu?: { kind: MenuTarget['kind'], id?: string | number | null, x?: number, y?: number, above?: boolean, confirming?: string | null, look?: string | null } | null,
  // Edit Theme Color drawn by the theme (its `background-picker` part, M2.9 step 5b: ui/picker/part.ts); null with
  // Margin's own panel or none open. Themes see it as `picker` (ui/picker/view.ts PickerVm).
  picker?: PickerUi | null,
  editing?: { kind: 'space' | 'folder' | 'tab' | 'pin' | 'favorite', id: string | number } | null,
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
  /**
   * Arc's Library (docs/ARC-SIDEBAR.md "The ends of the spaces"): a swipe past the first space or the sidebar's box
   * button opens it; `section` the rail's one shown (LIBRARY_SECTIONS), `query` its search field's text.
   * */
  library?: { open?: boolean, section?: string, query?: string, peek?: boolean } | null,
  /**
   * Arc's Create a Space (a pull past the last space): what's typed so far; the space is made only by its Create
   * Space (or Choose a Theme). `color` the colour it'll get (its page drawn in it), `profile` the browser profile's id.
   * */
  newSpace?: { name: string, emoji: string, color: string, profile: string | null } | null,
};
export type ViewModelInput = {
  // As read from storage (usable() takes what's there): its settings may be only some of them.
  state: Omit<Partial<State>, 'settings'> & { settings?: Partial<State['settings']> } & Record<string, any> | null,
  now?: number,
  ui?: UiState,
  platform?: { browser?: string, os?: string, app?: boolean, marginFullscreen?: boolean, features?: Record<string, any> },
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
export type FavoriteRow = Face & {
  kind: 'favorite', id: string, scope: string,
  tabId: number | null, open: boolean, active: boolean, behind: boolean, away: boolean,
  drifted: boolean, rootUrl: string, hasCustomTitle: boolean,
  audible: boolean, muted: boolean, asleep: boolean, loading: boolean,
};
export type FavoritesView = { items: FavoriteRow[], hasItems: boolean, columns: number };
export type FolderRow = {
  kind: 'folder', isFolder: true, id: string, name: string, open: boolean,
  parentFolderId: string | null, depth: number,
  count: number, pins: PinRow[], shown: PinRow[], shownFlat: (FolderRow | PinRow)[], hasShown: boolean,
};
export type SplitPaneView = Face & {
  id: string, tabId: number | string, index: number, active: boolean, ratio: number, percent: number,
};
export type SplitRow = {
  kind: 'split', isSplit: true, id: string, axis: 'horizontal' | 'vertical',
  active: boolean, panes: SplitPaneView[], ratios: number[], count: number, title: string,
};
export type ActiveSplitView = {
  id: string, axis: 'horizontal' | 'vertical', isHorizontal: boolean, isVertical: boolean,
  panes: SplitPaneView[], dividers: { index: number, percent: number }[], canAddPane: boolean,
  labels: { swap: string, breakOut: string, closePane: string, toggleAxis: string },
};
export type SpaceChip = {
  id: string, name: string, emoji: string, color: string, abbr: string,
  index: number, number: number, active: boolean, tabCount: number,
  label: string,
  /** No icon (its emoji removed, M2.10): Arc draws such a space as a dot. */
  iconless: boolean,
  /** Its key (Margin.app's ⌃1–9: its first nine spaces), a cap each (`⌃`, `2`), for Arc's tooltip; none elsewhere. */
  keys: { id: string, label: string }[],
  hasKeys: boolean,
  /** Its profile's name, for Arc's tooltip (Margin.app: the profiles' names it tells, M2.10); '' unknown. */
  profile: string,
  hasProfile: boolean,
};
export type SpaceView = SpaceChip & {
  pinned: (FolderRow | PinRow)[], pinnedFlat: (FolderRow | PinRow)[], folders: FolderRow[], pins: PinRow[],
  splits: SplitRow[], hasSplits: boolean,
  today: TabRow[], hasToday: boolean, hasPinned: boolean,
  newTab: { active: boolean },
  /** Its background as stored (extension/state/model.ts backgroundOf), null for none: Margin draws it under the theme (ui/background.ts). */
  background: SpaceBackground | null,
};
export type ActiveTab = Face & {
  id: number, loading: boolean, audible: boolean, muted: boolean, asleep: boolean, pinned: boolean, newTab: boolean,
};
export type ArchiveRow = Face & { id: string, spaceId: string, closedAt: number, ago: string };
/** An archived tab as the Library lists it: its address as Arc writes it (no scheme, no www). */
export type LibraryRow = ArchiveRow & { address: string };
/** The Library's rail (Arc's, in its order) and the shown section (LibraryView). */
// (Arc's Easels left out: Margin won't have them, Tirth 2026-11-27.)
export const LIBRARY_SECTIONS = Object.freeze(['media', 'downloads', 'spaces', 'boosts', 'archive'] as const);
export type LibraryView = {
  open: boolean,
  /** Drawn: open, or a swipe toward it shows it (its rows only then). */
  shown: boolean,
  section: string,
  sections: { id: string, label: string, active: boolean }[],
  /** Its search field (none for Spaces, as Arc's): the placeholder ("Search Archive…") and the text. */
  search: boolean, searchLabel: string, query: string,
  /** Arc's Filter beside the search (Downloads, Archived Tabs): drawn, not in Margin yet. */
  filter: boolean,
  /** Archived Tabs: the rows found, by day as Arc heads them ("Today", "Yesterday", "3 days ago"…). */
  archive: boolean, groups: { label: string, rows: LibraryRow[] }[], hasGroups: boolean,
  /**
   * Nothing to list: the section's words, Arc's own (its title, if it has one, and its line; `x`: Arc's archive button
   * drawn between `text` and `after`, as its "press the ✕ to archive it").
   * */
  empty: { title: string, text: string, x: boolean, after: string } | null,
  /** Spaces: Arc's space manager across the window (`wide`), a card per space (`spaces`) as its sidebar shows it. */
  wide: boolean,
  spaces: LibrarySpaceCard[],
};
/** A space as the Library's Spaces cards draw it: its name, icon, colour, profile, and its sidebar's rows. */
export type LibrarySpaceCard = {
  id: string, name: string, emoji: string, iconless: boolean, color: string, active: boolean,
  profile: string, hasProfile: boolean,
  /** Its ground: a gradient of its background's colours (a space with one), else none (the theme's of its colour). */
  ground: string,
  pinned: (FolderRow | PinRow)[], today: TabRow[], hasPinned: boolean, hasToday: boolean,
};
/** Arc's Create a Space while it's open (NewSpaceView). */
export type NewSpaceView = {
  name: string, emoji: string, color: string,
  /** Margin.app's profiles of the space's browser (their names), the one chosen; none outside it. */
  hasProfiles: boolean, profile: string, profileId: string, /** "Profile: Work", its chip's label. */ profileLabel: string,
  /** A name typed: Create Space can make it (`cannotCreate`, its opposite, for aria-disabled). */
  canCreate: boolean, cannotCreate: boolean,
};
export type PaletteRow = {
  id: string, kind: string, title: string, subtitle: string, badge: string, spaceColor: string,
  emoji: string, isSearch: boolean, isOpen: boolean, icon: string | null, letter: string, color: string,
  selected: boolean, goes: boolean, section: string, sectionStart: boolean,
  /** an installed app (Margin.app, hosting on): its icon is the app's own shape, drawn without a tile */
  isApp: boolean,
};
export type MenuRow = { id: string, label: string, separator: boolean, danger: boolean, confirming: boolean,
  /** Drawn, doing nothing (Arc's Boost), `hint` saying so; its key (`⌘T`); its glyph's name. */
  inert: boolean, hint: string, keys: string, hasKeys: boolean, icon: string };
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
export type MediaView = {
  id: string, source: 'tab' | 'app', tabId: number | string | null,
  title: string, subtitle: string, artwork: string | null, icon: string | null,
  letter: string, color: string, playing: boolean, paused: boolean, muted: boolean,
  canPrev: boolean, canNext: boolean,
};
export type PreviewView = {
  url: string, host: string, title: string, spaceId: string, spaceName: string, spaceEmoji: string,
  /** Quick Tab: its address field first, no page yet (`isQuickTab`: the same, the name themes read). */
  quickTab: boolean, isQuickTab: boolean,
  /** Its window not in place yet (its page area covered, a loader there); `ready`: in place, its page showing through. */
  loading: boolean, ready: boolean,
  /** Going away (the reverse of its open, then gone). */
  closing: boolean,
  canGoBack: boolean, canGoForward: boolean,
  query: string,
  labels: { expand: string, copyUrl: string, close: string, back: string, forward: string, search: string },
};
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
export type SettingsCategoryView = { id: string, label: string, help: string, selected: boolean, isAppearance: boolean, isThemes: boolean, isTabs: boolean, isBrowsing: boolean, isKeyboard: boolean };
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
  favorites: FavoritesView,
  tab: ActiveTab | null,
  archive: ArchiveRow[],
  hasArchive: boolean,
  palette: { open: boolean, query: string, newTab: boolean, rows: PaletteRow[], hasRows: boolean, selected: string | null },
  menu: { kind: string, id: string | number | null, x: number, y: number, label: string, items: MenuRow[], hasItems: boolean, /** Arc's "+" (the theme's `--m-add-menu: arc`). */ arc: boolean } | null,
  picker: PickerVm | null,
  editing: { kind: 'space' | 'folder' | 'tab' | 'pin' | 'favorite', id: string | number } | null,
  editor: EditorView | null,
  notice: NoticeView | null,
  prompt: PromptView | null,
  toast: ToastView | null,
  media: MediaView | null,
  preview: PreviewView | null,
  split: ActiveSplitView | null,
  gesture: GestureView | null,
  launcher: LauncherView | null,
  /** The page card's loader (the `page-loader` part), while an item opens in the page area: Margin's words for it. */
  pageLoader: { name: string, label: string, icon: string | null } | null,
  settingsForm: SettingsFormView | null,
  settingsTab: SettingsTabView | null,
  settings: Record<string, string | number | boolean>,
  platform: { browser: string, os: string },
  library: LibraryView,
  newSpace: NewSpaceView | null,
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

function favoriteRow(state: State, f: any): FavoriteRow {
  const live = ((f.tabId != null ? state.tabs[f.tabId] : null) as any);
  const custom = typeof f.customTitle === 'string' && f.customTitle.trim() ? f.customTitle.trim() : '';
  return {
    kind: 'favorite',
    id: f.id,
    scope: f.scope ?? 'global',
    ...face(state, live ?? f, custom || f.title || live?.title || f.rootUrl || f.url),
    tabId: f.tabId ?? null,
    open: f.tabId != null,
    active: !!f.active,
    behind: !!f.behind,
    away: !!f.away,
    drifted: !!f.drifted,
    rootUrl: f.rootUrl ?? f.url ?? '',
    hasCustomTitle: !!custom,
    audible: !!live?.audible,
    muted: !!live?.muted,
    asleep: !!live?.sleeping,
    loading: isLoading(live),
  };
}

function favoriteColumns(count: number): number {
  if (count <= 0) return 3;
  if (count <= 3) return count;
  if (count === 4) return 4;
  if (count <= 6) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// The model, fresh (every object new), then shared with the last one.

function fresh(input: ViewModelInput): ViewModel {
  const ui = input.ui ?? {};
  const state = usable(input.state);
  const platform = { browser: input.platform?.browser ?? 'unknown', os: input.platform?.os ?? 'unknown' };
  const settings = input.settings ?? {};
  const pinnedOpen = !!state?.settings?.sidebarPinnedOpen;
  // Every page leaves the sidebar as the person keeps it (Keep open), Margin's own (the launcher, Settings) too
  // (Tirth, 2026-11-25: every tab has the sidebar's button and can hide it; until then the launcher always showed it
  // beside it). With no page area of its own (Margin.app's window hosting another app's window beside it:
  // `pageOutside`), the sidebar is all there is: always docked (`sidebarDocked`, the host's). An app's window in the
  // page area leaves it as the person keeps it: Margin's window is in front of that window, so a hidden sidebar comes
  // out over it (2026-11-20; docked until then: 2026-11-15, the hosted window above Margin's, FaceTime covered where
  // the sidebar was).
  // (Before the first data, Keep open isn't known yet: the launcher keeps the sidebar beside it, its skeleton the start's
  // look, as it always has.)
  const sidebar = ui.pageOutside || ui.sidebarDocked ? 'open' : ui.sidebar === 'open' || ui.sidebar === 'hidden' || ui.sidebar === 'peek' ? ui.sidebar : pinnedOpen || (ui.launcherPage && !state) ? 'open' : 'hidden';
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
      space: { id: '', name: '', emoji: '', color: '', abbr: '', index: 0, number: 1, active: true, tabCount: 0, label: '', iconless: true, keys: [], hasKeys: false, profile: '', hasProfile: false, pinned: [], pinnedFlat: [], folders: [], pins: [], splits: [], hasSplits: false, today: [], hasToday: false, hasPinned: false, newTab: { active: false }, background: null },
      spaces: [], favorites: { items: [], hasItems: false, columns: 3 }, tab: null, archive: [], hasArchive: false,
      palette: { open: !!paletteUi.open, query: paletteUi.query ?? '', newTab: !!paletteUi.newTab, rows: [], hasRows: false, selected: null },
      menu: null, picker: null, editing, editor: null, notice, prompt, toast, media: null, preview: null, split: null, gesture, launcher: null, pageLoader, settingsForm: null, settingsTab: null, settings, platform,
      library: libraryView(ui.library, [], Date.now()), newSpace: null,
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
  const folderById = new Map<string, FolderRow>();
  const pinById = new Map<string, PinRow>();
  const toFlatRow = (entry: any): FolderRow | PinRow => {
    if (entry.kind !== 'folder') return pinById.get(entry.id) ?? pinRow(state, entry, (entry.depth ?? 0) > 0, entry.depth ?? 0);
    const existing = folderById.get(entry.id);
    if (existing) return existing;
    const inside = (entry.pins ?? []).map((p: any) => pinById.get(p.id) ?? pinRow(state, p, true, (entry.depth ?? 0) + 1));
    const shown = entry.open ? inside : (entry.peek ?? []).map((p: any) => pinById.get(p.id)!).filter(Boolean);
    const folder: FolderRow = {
      kind: 'folder', isFolder: true, id: entry.id, name: entry.name, open: entry.open,
      parentFolderId: entry.parentFolderId ?? null, depth: entry.depth ?? 0,
      count: inside.length, pins: inside, shown, shownFlat: [], hasShown: shown.length > 0,
    };
    folderById.set(folder.id, folder);
    folders.push(folder);
    return folder;
  };
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
    const shownFlat = (item.shownFlat ?? shown).map((entry: any) => (entry.kind === 'folder' || entry.kind === 'pin' ? toFlatRow(entry) : entry));
    const folder: FolderRow = {
      kind: 'folder', isFolder: true, id: item.id, name: item.name, open: item.open,
      parentFolderId: item.parentFolderId ?? null, depth: item.depth ?? 0,
      count: inside.length, pins: inside, shown, shownFlat, hasShown: shownFlat.length > 0,
    };
    folderById.set(folder.id, folder);
    folders.push(folder);
    return folder;
  });
  const pinnedFlat: (FolderRow | PinRow)[] = (view.pinnedFlat ?? []).map(toFlatRow);
  const rawToday = view.tabs.map((t) => tabRow(state, t));
  // Combined Split View rows (Arc's single capsule row in the sidebar for 2–4 panes):
  const splitMemberIds = new Set<string>();
  const splits: SplitRow[] = [];
  // Open tabs by their Margin tab's id (a pane named so), indexed once a split asks (the first with an id, as find).
  let byMid: Map<string, any> | null = null;
  const liveByMid = (mid: string) => {
    if (!byMid) { byMid = new Map(); for (const t of Object.values(state.tabs) as any[]) if (t?.mid && !byMid.has(t.mid)) byMid.set(t.mid, t); }
    return byMid.get(mid);
  };
  for (const g of (state.splits ?? [])) {
    if (g.spaceId !== view.spaceId || !Array.isArray(g.panes) || g.panes.length < 2) continue;
    const panes: SplitPaneView[] = [];
    const rawRatios = Array.isArray(g.ratios) && g.ratios.length === g.panes.length ? g.ratios : g.panes.map(() => 1 / g.panes.length);
    const ratioSum = rawRatios.reduce((acc, v) => acc + (Number.isFinite(v) && v > 0 ? v : 1), 0) || g.panes.length;
    g.panes.forEach((pid, index) => {
      const asNum = /^\d+$/.test(pid) ? Number(pid) : null;
      const live: any = asNum != null ? state.tabs[asNum] : liveByMid(pid);
      const kept: any = !live ? state.keptTabs?.[pid] : null;
      const item = live ?? kept;
      if (!item) return;
      const tabId: number | string = live ? live.id : item.id;
      const ratio = (Number.isFinite(rawRatios[index]) && rawRatios[index] > 0 ? rawRatios[index] : 1) / ratioSum;
      const title = (item.customTitle || item.title || item.url || 'Pane').trim();
      panes.push({
        id: pid,
        tabId,
        index,
        ...face(state, item, title),
        active: !!(live && (live.id === currentTabId || (currentTabId == null && live.windowId === windowId && live.active)))
          || !!(kept && kept.id === ui.switchingTo),
        ratio,
        percent: Math.round(ratio * 1000) / 10,
      });
    });
    if (panes.length < 2) continue;
    for (const p of panes) { splitMemberIds.add(String(p.id)); splitMemberIds.add(String(p.tabId)); }
    splits.push({
      kind: 'split',
      isSplit: true,
      id: g.id,
      axis: g.axis === 'vertical' ? 'vertical' : 'horizontal',
      active: panes.some((p) => p.active),
      panes,
      ratios: panes.map((p) => p.ratio),
      count: panes.length,
      title: panes.map((p) => p.title).join(' · '),
    });
  }
  const today = rawToday.filter((t) => !splitMemberIds.has(String(t.id)));
  const favItems = (view.favorites ?? []).map((f: any) => favoriteRow(state, f));
  const favorites: FavoritesView = { items: favItems, hasItems: favItems.length > 0, columns: favoriteColumns(favItems.length) };

  // A space's tab count: its tabs open in any window of the profile (pinned or not: a space's list is the
  // space's, docs/BROWSER-WINDOWS.md §9), and its tabs that aren't open (shown in every window).
  const counts = new Map();
  for (const t of Object.values(state.tabs)) {
    const s = state.tabSpace[t.id];
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  for (const k of Object.values(state.keptTabs ?? {})) counts.set(k.spaceId, (counts.get(k.spaceId) ?? 0) + 1);
  // (Margin.app's keys for the first nine spaces, as Settings has them: Arc's tooltip shows each space's.)
  const keyCaps = input.platform?.app ? spaceKeyCaps(state.settings) : null;
  const keysOf = (index: number) => (keyCaps && index < 9 ? [...keyCaps, String(index + 1)].map((label, i) => ({ id: `k${i}`, label })) : []);
  // (Its profile's name, as Margin.app names its profiles: the one a space with none of its own opens in for null.)
  const known = input.platform?.features?.profileNames as { names?: Record<string, Record<string, unknown>>, fallback?: Record<string, unknown> } | undefined;
  const profileOf = (sp: { browser?: string, profile?: string | null }) => {
    const browser = typeof sp.browser === 'string' && sp.browser ? sp.browser : 'safari';
    const id = typeof sp.profile === 'string' && sp.profile ? sp.profile : known?.fallback?.[browser];
    const name = typeof id === 'string' ? known?.names?.[browser]?.[id] : null;
    return typeof name === 'string' ? name.slice(0, 40) : '';
  };
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
    iconless: !(s.emoji ?? '').trim(),
    keys: keysOf(index),
    hasKeys: !!keyCaps && index < 9,
    profile: profileOf(s),
    hasProfile: !!profileOf(s),
  }));
  const chip = spaces.find((s) => s.active) ?? spaces[0];
  const space: SpaceView = {
    ...chip,
    pinned,
    pinnedFlat,
    folders,
    pins,
    splits,
    hasSplits: splits.length > 0,
    today,
    hasToday: today.length > 0,
    hasPinned: pinned.length > 0,
    newTab: { active: !!view.newTab.active },
    background: (chip ? state.spaces[chip.index]?.background : null) ?? null,
  };

  // Arc's Create a Space while it's open: its page drawn in the colour the new space will get (the sidebar's ground is
  // the space's colour), and the switcher's chips none of them in front (the theme draws the one being made after them,
  // in front, as Arc's dock does). Its profiles: Margin.app's for the browser the new space opens in (the window's
  // space's, as the core's createSpace takes it), the one chosen else the space's own else the browser's default.
  let newSpace: NewSpaceView | null = null;
  const ns = ui.newSpace;
  if (ns && typeof ns === 'object' && typeof ns.color === 'string' && HEX_COLOR.test(ns.color)) {
    const browser = typeof state.spaces[chip?.index ?? -1]?.browser === 'string' && state.spaces[chip!.index].browser ? state.spaces[chip!.index].browser as string : 'safari';
    const names = known?.names?.[browser];
    const ids = names && typeof names === 'object' ? Object.keys(names).filter((id) => typeof names[id] === 'string') : [];
    const own = state.spaces[chip?.index ?? -1]?.profile;
    const fallback = known?.fallback?.[browser];
    const profileId = [ns.profile, own, fallback].find((id) => typeof id === 'string' && ids.includes(id)) as string | undefined ?? ids[0] ?? '';
    const name = String(ns.name ?? '').slice(0, 40);
    newSpace = {
      name, emoji: String(ns.emoji ?? '').slice(0, 8), color: ns.color,
      hasProfiles: ids.length > 0, profile: profileId ? String(names![profileId]).slice(0, 40) : '', profileId,
      profileLabel: profileId ? `Profile: ${String(names![profileId]).slice(0, 40)}` : 'Profile',
      canCreate: name.trim() !== '', cannotCreate: name.trim() === '',
    };
    space.color = ns.color;
    for (const sp of spaces) sp.active = false;
  }

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
        isSearch: (item.kind === 'go' || item.kind === 'suggestion') && item.search === true,
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
    const items = menuItems((ui.menu as any), { state, space, favorites, features: input.platform?.features ?? null });
    if (items.length) {
      menu = {
        kind: String(ui.menu.kind), id: ui.menu.id ?? null, x: Number(ui.menu.x) || 0, y: Number(ui.menu.y) || 0,
        label: MENU_LABELS[ui.menu.kind] ?? 'Menu',
        items: items.map((i) => {
          const confirming = !!i.confirm && ui.menu?.confirming === i.id;
          return { id: i.id, label: confirming ? CONFIRM_LABEL : i.label, separator: i.separator, danger: i.danger, confirming, inert: !!i.inert, hint: i.hint ?? '', keys: i.keys ?? '', hasKeys: !!i.keys, icon: i.icon ?? '' };
        }),
        hasItems: true,
        arc: ui.menu.look === 'arc',
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
  // (Themes, the theme store, only where Margin.app offers it: `features.themeStore`.)
  const offered = SETTINGS_CATEGORIES.filter((c) => c.id !== 'themes' || !!input.platform?.features?.themeStore);
  const named = categoryNamed(ui.settingsCategory);
  const category = offered.some((c) => c.id === named) ? named : offered[0].id;
  if (launcher && ui.settingsPage) {
    const categories = offered.map((c) => ({
      id: c.id, label: c.label, help: c.help, selected: c.id === category,
      isAppearance: c.id === 'appearance', isThemes: c.id === 'themes', isTabs: c.id === 'tabs', isBrowsing: c.id === 'browsing', isKeyboard: c.id === 'keyboard',
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
    const all = settingsFields(state.settings, input.platform?.features ?? {}, { recording: ui.recording ?? null, status: ui.settingsStatus ?? {}, theme: ui.theme ?? null, spaceTheme, airTraffic: { rules: state.airTraffic ?? [], spaces: state.spaces } });
    const fields = ui.settingsPage && ui.settingsNav ? fieldsIn(all, category) : all;
    settingsForm = { fields, hasFields: fields.length > 0 };
  }

  // The background mini player (M2.4, shared/media.ts): only what plays in the background (or paused, within its
  // 30 s grace), never the tab or app in front of this window. Its sources: Margin.app's `media` push (ui.media),
  // and a tab the state says is audible that none of them is.
  const activeBundleId = current ? appOfItem(current) : null;
  const mediaSources: MediaSource[] = (Array.isArray(ui.media) ? ui.media : ui.media ? [ui.media] : []).filter((m) => !!m && typeof m === 'object');
  const reported = new Set(mediaSources.filter((m) => m.source === 'tab').map((m) => m.tabId));
  for (const t of Object.values(state.tabs)) {
    if (!t.audible) continue;
    if (reported.has(t.id)) continue;
    mediaSources.push({
      id: `tab:${t.id}`,
      source: 'tab',
      tabId: t.id,
      title: t.customTitle || t.title || hostOf(t.url) || 'Playing audio',
      subtitle: hostOf(t.url) || '',
      url: t.url,
      playing: true,
      muted: !!t.muted,
      canPrev: false,
      canNext: false,
      updatedAt: Number(t.lastActive) || now,
      pausedAt: null,
    });
  }
  const pickedMedia = selectBackgroundMedia(mediaSources, { activeTabId: current?.id ?? null, activeBundleId, now });
  let media: MediaView | null = null;
  if (pickedMedia) {
    const liveTab = pickedMedia.source === 'tab' && Number.isInteger(pickedMedia.tabId) ? state.tabs[pickedMedia.tabId as number] : null;
    const rawIcon = pickedMedia.icon ?? (liveTab ? V.iconFor(state, liveTab) : pickedMedia.bundleId ? appIcon((state as any).apps, pickedMedia.bundleId) : null);
    const validArt = checkIconUrl(pickedMedia.artwork) ? pickedMedia.artwork : null;
    const validIcon = checkIconUrl(rawIcon) ? rawIcon : null;
    const { letter, color } = V.letterAvatar(pickedMedia.subtitle || pickedMedia.title || 'M');
    media = {
      id: pickedMedia.id,
      source: pickedMedia.source,
      tabId: pickedMedia.tabId ?? null,
      title: String(pickedMedia.title || 'Media').slice(0, 140),
      subtitle: String(pickedMedia.subtitle || '').slice(0, 100),
      artwork: validArt,
      icon: validIcon,
      letter,
      color,
      playing: !!pickedMedia.playing,
      paused: !pickedMedia.playing,
      muted: !!pickedMedia.muted,
      canPrev: !!pickedMedia.canPrev,
      canNext: !!pickedMedia.canNext,
    };
  }

  let preview: PreviewView | null = null;
  if (ui.peek && typeof ui.peek.url === 'string' && (ui.peek.url || ui.peek.littleArc || ui.peek.loading)) {
    const targetSpace = spaces.find((s) => s.id === ui.peek?.spaceId) ?? chip;
    const url = ui.peek.url.slice(0, 2048);
    const quickTab = !!ui.peek.littleArc;
    const loading = !quickTab && ui.peek.loading !== false;
    preview = {
      url,
      host: url ? hostOf(url) || url : '',
      title: String(ui.peek.title || (url ? hostOf(url) || url : '')).slice(0, 140),
      spaceId: targetSpace?.id ?? '',
      spaceName: targetSpace?.name ?? '',
      spaceEmoji: targetSpace?.emoji ?? '',
      quickTab,
      isQuickTab: quickTab,
      loading,
      ready: !quickTab && !loading && !ui.peek.closing,
      closing: !!ui.peek.closing,
      canGoBack: ui.peek.canGoBack !== false,
      canGoForward: ui.peek.canGoForward !== false,
      query: String(ui.peek.query ?? '').slice(0, 2048),
      labels: { expand: 'Open in Space', copyUrl: 'Copy URL', close: 'Close', back: 'Back', forward: 'Forward', search: 'Search or enter address' },
    };
  }

  const activeSplitRow = splits.find((sp) => sp.active) ?? null;
  let split: ActiveSplitView | null = null;
  if (activeSplitRow) {
    let acc = 0;
    const dividers: { index: number, percent: number }[] = [];
    for (let i = 0; i < activeSplitRow.panes.length - 1; i++) {
      acc += activeSplitRow.panes[i].percent;
      dividers.push({ index: i, percent: Math.round(acc * 10) / 10 });
    }
    split = {
      id: activeSplitRow.id,
      axis: activeSplitRow.axis,
      isHorizontal: activeSplitRow.axis === 'horizontal',
      isVertical: activeSplitRow.axis === 'vertical',
      panes: activeSplitRow.panes,
      dividers,
      canAddPane: activeSplitRow.panes.length < 4,
      labels: { swap: 'Swap Panes', breakOut: 'Break Out', closePane: 'Close Pane', toggleAxis: activeSplitRow.axis === 'horizontal' ? 'Stack Vertically' : 'Place Side by Side' },
    };
  }

  return {
    version: VM_VERSION,
    ready: true,
    window: win,
    space,
    spaces,
    favorites,
    tab,
    archive,
    hasArchive: !ui.settingsPage && archive.length > 0,
    palette: { open: !!paletteUi.open, query: paletteUi.query ?? '', newTab: !!paletteUi.newTab, rows, hasRows: rows.length > 0, selected },
    menu,
    picker: ui.picker ? pickerView(ui.picker) : null,
    editing,
    editor,
    notice,
    prompt,
    toast,
    media,
    preview,
    split,
    gesture,
    launcher,
    pageLoader,
    settingsForm,
    settingsTab,
    settings,
    platform,
    library: libraryView(ui.library, archive, now, ui.library?.section === 'spaces' && (ui.library?.open || ui.library?.peek) ? libraryCards(state, windowId, currentTabId, spaces) : []),
    newSpace,
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

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// The Library (Arc's, docs/ARC-SIDEBAR.md "The ends of the spaces"): its rail's words, each section's search
// placeholder (as Arc's), and the words of a section Margin has nothing for yet.
const LIBRARY_LABELS: Record<string, string> = { media: 'Media', downloads: 'Downloads', spaces: 'Spaces', boosts: 'Boosts', archive: 'Archived Tabs' };
const LIBRARY_SEARCH: Record<string, string> = { media: 'Search Media…', downloads: 'Search Downloads…', boosts: 'Search Boosts…', archive: 'Search Archive…' };
// (Arc's own words, read from its app: docs/ARC-SIDEBAR.md "The Library's sections". Media's names no app.)
const LIBRARY_EMPTY: Record<string, { title: string, text: string, x?: boolean, after?: string }> = {
  media: { title: '', text: 'Save media to your Documents, Desktop, and Download Folders to see them here, alongside your Captures.' },
  downloads: { title: 'Nothing here yet!', text: 'Come back after you\u2019ve found some cool stuff to save.' },
  boosts: { title: 'Nothing Boosted Yet!', text: 'Type \u201cNew Boost\u201d in URL bar to make your own, or grab one from the Boost Gallery.' },
  archive: { title: 'Nothing here yet!', text: 'Hover your mouse over a tab and press the ', x: true, after: ' to archive it.' },
};

/** The Library as the theme draws it (LibraryView): its rail, the section shown, its archived tabs by day. */
export function libraryView(ui: UiState['library'], archive: ArchiveRow[], now: number, cards: LibrarySpaceCard[] = []): LibraryView {
  const section = typeof ui?.section === 'string' && (LIBRARY_SECTIONS as readonly string[]).includes(ui.section) ? ui.section : 'archive';
  const query = typeof ui?.query === 'string' ? ui.query.slice(0, 200) : '';
  const isArchive = section === 'archive';
  let groups: { label: string, rows: LibraryRow[] }[] = [];
  if (isArchive && (ui?.open || ui?.peek)) {
    const q = query.trim().toLowerCase();
    const found = archive.filter((a) => !q || a.title.toLowerCase().includes(q) || a.url.toLowerCase().includes(q))
      .slice().sort((a, b) => b.closedAt - a.closedAt);
    for (const a of found) {
      const label = dayLabel(a.closedAt, now);
      const row = { ...a, address: addressOf(a.url) };
      if (groups.at(-1)?.label === label) groups.at(-1)!.rows.push(row);
      else groups.push({ label, rows: [row] });
    }
  }
  const words = (w: { title: string, text: string, x?: boolean, after?: string }) => ({ title: w.title, text: w.text, x: !!w.x, after: w.after ?? '' });
  const empty = section === 'spaces' ? null
    : isArchive && groups.length ? null
    : isArchive && query.trim() ? words({ title: '', text: `No results found for \u201c${query.trim().slice(0, 60)}\u201d` })
    : words(LIBRARY_EMPTY[section]);
  return {
    open: !!ui?.open,
    shown: !!ui?.open || !!ui?.peek,
    section,
    sections: LIBRARY_SECTIONS.map((id) => ({ id, label: LIBRARY_LABELS[id], active: id === section })),
    search: section !== 'spaces', searchLabel: LIBRARY_SEARCH[section] ?? '', query,
    filter: section === 'downloads' || isArchive,
    archive: isArchive, groups, hasGroups: groups.length > 0,
    empty,
    wide: section === 'spaces',
    spaces: cards,
  };
}

// The Library's Spaces cards (Arc's space manager): each space's sidebar as it'd show in this window (its folders and
// pins, its today's tabs), from the sidebar's own rules (shared/view.ts sidebar), only while the section is shown.
function libraryCards(state: State, windowId: number | null, tabId: number | null, chips: { id: string, name: string, emoji: string, iconless: boolean, color: string, active: boolean, profile: string, hasProfile: boolean }[]): LibrarySpaceCard[] {
  return chips.map((chip) => {
    const shown = { ...state, activeSpaceByWindow: { ...state.activeSpaceByWindow, [windowId as number]: chip.id } } as State;
    const v = V.sidebar(shown, windowId, tabId, {});
    const pinned: (FolderRow | PinRow)[] = [];
    const walk = (item: any, depth: number) => {
      if (item.kind !== 'folder') { pinned.push(pinRow(state, item, depth > 0, depth)); return; }
      const inside = (item.pins ?? []).map((p: any) => pinRow(state, p, true, depth + 1));
      pinned.push({ kind: 'folder', isFolder: true, id: item.id, name: item.name, open: item.open, parentFolderId: item.parentFolderId ?? null, depth, count: inside.length, pins: inside, shown: [], shownFlat: [], hasShown: false });
      if (item.open) for (const p of inside) pinned.push(p);
    };
    for (const item of v.pinned ?? []) walk(item, 0);
    const today = (v.tabs ?? []).map((t: any) => tabRow(state, t));
    const bg = state.spaces.find((s) => s.id === chip.id)?.background as { colors?: unknown } | null | undefined;
    const colors = Array.isArray(bg?.colors) ? (bg!.colors as unknown[]).filter((c): c is string => typeof c === 'string' && HEX_COLOR.test(c)).slice(0, 4) : [];
    return {
      id: chip.id, name: chip.name, emoji: chip.emoji, iconless: chip.iconless, color: HEX_COLOR.test(chip.color) ? chip.color : '#888888', active: chip.active,
      profile: chip.profile, hasProfile: chip.hasProfile,
      ground: colors.length > 1 ? `linear-gradient(180deg, ${colors.join(', ')})` : colors.length ? colors[0] : '',
      pinned, today, hasPinned: pinned.length > 0, hasToday: today.length > 0,
    };
  });
}

// An address as Arc's Library writes it: no http(s):// and no www. (other schemes, file: and the like, kept).
function addressOf(url: string) {
  return String(url ?? '').replace(/^https?:\/\//i, '').replace(/^www\./i, '');
}

// The day an archived tab is filed under, as Arc's Library heads them: today, yesterday (the calendar's), then the
// whole days since ("1 day ago" for one two calendar days back but under 48 hours old, as Arc), weeks, months, years.
export function dayLabel(ts: number, now: number) {
  if (!Number.isFinite(ts) || ts <= 0) return 'Earlier';
  const startOf = (t: number) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const calendar = Math.round((startOf(now) - startOf(ts)) / 86_400_000);
  if (calendar <= 0) return 'Today';
  if (calendar === 1) return 'Yesterday';
  const days = Math.max(1, Math.floor((now - ts) / 86_400_000));
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (days < 7) return plural(days, 'day');
  if (days < 30) return plural(Math.floor(days / 7), 'week');
  if (days < 365) return plural(Math.floor(days / 30), 'month');
  return plural(Math.floor(days / 365), 'year');
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
const MENU_LABELS = Object.freeze({ tab: 'Tab', pin: 'Pin', favorite: 'Favorite', folder: 'Folder', space: 'Space', add: 'New', profile: 'Profile' });
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
