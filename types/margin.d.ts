// Margin's message protocol, derived from the background's handlers
// (extension/background/handlers.js `handlers`): a page's `send(type, payload)` is
// checked against the handler of that name, and gets its result type.
// Used by `npm run typecheck` only.

type Handlers = typeof import('../extension/background/handlers.js').handlers;

export type MessageType = keyof Handlers;
export type Request<K extends MessageType> = Parameters<Handlers[K]>[0];
export type Result<K extends MessageType> = Awaited<ReturnType<Handlers[K]>>;

// What pages call (content/sidebar.js, newtab/newtab.js, shared/ui.js).
export type Send = <K extends MessageType>(type: K, payload?: Request<K>) => Promise<Result<K>>;

// ---- stored state (storage.local; state/model.js) ---------------------------

export interface Space { id: string; name: string; emoji: string; color: string }
export interface Pin {
  id: string; spaceId: string; url: string; title: string;
  /** a folder of its space (state/model.js); none or unknown: at the top level */
  folderId?: string;
  /** order within its level (folder, or the space's top level); missing: its place in the list */
  pos?: number;
}
export interface Folder { id: string; spaceId: string; name: string; open: boolean; pos?: number }
// Snapshot of an open tab (state/model.js tabRecord).
export interface TabRecord {
  id: number; windowId: number; index: number; title: string; url: string;
  favIconUrl: string; active: boolean; lastActive: number;
  /** its Margin tab's own id, lasting (state/model.js "Margin's tabs") */
  mid?: string;
  /** its place in the list (higher: newer, shown higher), as its Margin tab's */
  order?: number;
  /** view.sidebar only: its page is on screen under the palette while a new tab is chosen */
  behind?: boolean;
  /** view.sidebar only: never on an open tab's record (a kept tab's row has it) */
  kept?: boolean;
  /** its space and record came from before its id changed (state/model.js syncTabs, reclaimWindows) */
  restored?: boolean;
  /** the old window it came back from (restored), as of that renumbering */
  restoredFrom?: string;
  /** put in its space on purpose (the user, or Margin opening it there) */
  placed?: boolean;
  /** Margin put it to sleep (background/sleep.js), at `at`; its url and title are its page's (state/model.js seenTab) */
  sleeping?: { at: number; how: 'page' | 'discarded' };
  /** when it last woke from that sleep */
  wokeAt?: number;
}
/** A tab from before ids changed that no open tab matched yet (an earlier build's lostTabs: moved into keptTabs as read). */
export interface LostTab { url: string; spaceId: string; lastActive: number; windowId: number; index: number }
/** A Margin tab with no browser tab: not open, in its space (state/model.js keepTab). */
export interface KeptTab {
  id: string; url: string; title: string; favIconUrl: string; spaceId: string;
  order: number; lastActive: number; wokeAt?: number;
  /** when it stopped being open, and why ('window', 'sleep', 'not restored', 'gone', 'app') */
  keptAt: number; why: string;
  /** the window it was lost with: a window that comes back within a day takes it back (reclaimTabs) */
  from?: { key: string; at: number; size: number; index: number; windowId?: number | string };
  /** the browser's id it had, this session (a sync found it gone before its close was heard) */
  wasTab?: number;
  /** view.sidebar only: not open */
  kept?: true;
}
export interface ArchiveEntry {
  id: string; url: string; title: string; spaceId: string; favIconUrl: string; closedAt: number;
}
export interface Favicon { data: string; href: string; at: number }
export interface Shortcuts { nextTab: string; prevTab: string; nextSpace: string; prevSpace: string }
export interface Settings {
  sidebarPinnedOpen: boolean;
  frameWhenHidden?: boolean;
  archiveAfterHours: number;
  /** tabs unused this long are put to sleep (background/sleep.js); 0: never */
  sleepAfterHours: number;
  /** hostnames whose tabs never sleep (each with its subdomains: shared/sleep.js) */
  neverSleepSites: string[];
  sidebarShortcut: string;
  newTabHint: boolean;
  safariSearch: { id: string; name: string; template: string; at: number } | null;
  blockGestures: boolean;
  pullToRefresh: boolean;
  swipeNavigation: boolean;
  marginFullscreenAuto: boolean;
  fullscreenOnly: boolean;
  shortcuts: Shortcuts;
  shortcutDefaults: string;
  theme: string; // extension/themes/index.js
  themes: Record<string, Record<string, unknown>>; // each theme's own settings
}
export interface State {
  spaces: Space[];
  activeSpaceByWindow: Record<number, string>;
  tabSpace: Record<number, string>;
  pins: Pin[];
  folders: Folder[];
  archive: ArchiveEntry[];
  settings: Settings;
  tabs: Record<number, TabRecord>;
  keptTabs: Record<string, KeptTab>;
  favicons: Record<string, Favicon>;
  lostTabs: { windows: { key: string; at: number; size: number; tabs: LostTab[] }[] } | null;
}
