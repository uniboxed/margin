// Margin's message protocol, derived from the background's handlers
// (extension/background.js `handlers`): a page's `send(type, payload)` is
// checked against the handler of that name, and gets its result type.
// Used by `npm run typecheck` only.

type Handlers = typeof import('../extension/background.js').handlers;

export type MessageType = keyof Handlers;
export type Request<K extends MessageType> = Parameters<Handlers[K]>[0];
export type Result<K extends MessageType> = Awaited<ReturnType<Handlers[K]>>;

// What pages call (content/sidebar.js, newtab/newtab.js, shared/ui.js).
export type Send = <K extends MessageType>(type: K, payload?: Request<K>) => Promise<Result<K>>;

// ---- stored state (storage.local; state/model.js) ---------------------------

export interface Space { id: string; name: string; emoji: string; color: string }
export interface Pin { id: string; spaceId: string; url: string; title: string }
// Snapshot of an open tab (state/model.js tabRecord).
export interface TabRecord {
  id: number; windowId: number; index: number; title: string; url: string;
  favIconUrl: string; active: boolean; lastActive: number;
}
export interface ArchiveEntry {
  id: string; url: string; title: string; spaceId: string; favIconUrl: string; closedAt: number;
}
export interface Favicon { data: string; href: string; at: number }
export interface Shortcuts { nextTab: string; prevTab: string; nextSpace: string; prevSpace: string }
export interface Settings {
  sidebarPinnedOpen: boolean;
  archiveAfterHours: number;
  paletteShortcut: string;
  sidebarShortcut: string;
  safariSearch: { id: string; name: string; template: string; at: number } | null;
  sidebarWidth: number;
  blockGestures: boolean;
  pullToRefresh: boolean;
  swipeNavigation: boolean;
  fitPages: boolean;
  fitPagesExcept: string[];
  shortcuts: Shortcuts;
  shortcutDefaults: string;
}
export interface State {
  spaces: Space[];
  activeSpaceByWindow: Record<number, string>;
  tabSpace: Record<number, string>;
  pins: Pin[];
  archive: ArchiveEntry[];
  settings: Settings;
  tabs: Record<number, TabRecord>;
  favicons: Record<string, Favicon>;
}
