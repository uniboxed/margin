// The extension APIs Margin uses (`browser` in Safari, `chrome` in Chrome), as Margin uses them: only what it calls,
// with what Safari and Chrome both give. There are no maintained types for Safari's; these are written from the
// WebExtensions API (MDN) and checked against what Margin's code expects. Anything optional here is optional in a
// browser Margin runs in (`alarms`, `commands` and `webNavigation` aren't everywhere; a tab's url without host
// access). `windows`, `permissions` and `storage.session` are there wherever Margin's background runs (Safari 27,
// Chrome); a content script doesn't use them. Messages and their answers are Margin's own protocol: typed at `send` (types/margin.d.ts), `any` here.

interface BrowserEvent<F extends (...args: any[]) => any> {
  addListener(callback: F): void;
  removeListener(callback: F): void;
  hasListener?(callback: F): boolean;
}

interface BrowserTab {
  /** Every tab Margin queries, gets or makes has one (tabs without an id are devtools' and sessions'). */
  id: number;
  windowId: number;
  index: number;
  active: boolean;
  pinned?: boolean;
  highlighted?: boolean;
  /** Without host access (or before it's known): missing. */
  url?: string;
  pendingUrl?: string;
  title?: string;
  favIconUrl?: string;
  status?: 'loading' | 'complete' | string;
  discarded?: boolean;
  audible?: boolean;
  mutedInfo?: { muted: boolean };
  incognito?: boolean;
  openerTabId?: number;
  lastAccessed?: number;
  width?: number;
  height?: number;
}
interface BrowserTabChange {
  status?: string;
  url?: string;
  title?: string;
  favIconUrl?: string;
  audible?: boolean;
  discarded?: boolean;
  pinned?: boolean;
  mutedInfo?: { muted: boolean };
}
interface BrowserWindow {
  id: number;
  focused: boolean;
  state?: 'normal' | 'minimized' | 'maximized' | 'fullscreen' | string;
  type?: 'normal' | 'popup' | 'panel' | 'app' | 'devtools' | string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  incognito?: boolean;
  tabs?: BrowserTab[];
}
interface BrowserMessageSender {
  tab?: BrowserTab;
  frameId?: number;
  id?: string;
  url?: string;
  origin?: string;
  documentId?: string;
}
interface BrowserPort {
  name?: string;
  postMessage(message: any): void;
  disconnect(): void;
  onMessage: BrowserEvent<(message: any, port: BrowserPort) => void>;
  onDisconnect: BrowserEvent<(port: BrowserPort) => void>;
}
interface BrowserStorageArea {
  get(keys?: string | string[] | Record<string, any> | null): Promise<Record<string, any>>;
  set(items: Record<string, any>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear?(): Promise<void>;
}
interface BrowserStorageChange {
  oldValue?: any;
  newValue?: any;
}
interface BrowserInjectionTarget {
  tabId: number;
  frameIds?: number[];
  allFrames?: boolean;
}
interface BrowserInjectionResult<R> {
  frameId: number;
  result?: R;
  documentId?: string;
}
interface BrowserRegisteredContentScript {
  id: string;
  matches?: string[];
  excludeMatches?: string[];
  js?: string[];
  css?: string[];
  allFrames?: boolean;
  matchOriginAsFallback?: boolean;
  runAt?: 'document_start' | 'document_end' | 'document_idle';
  world?: 'ISOLATED' | 'MAIN';
  persistAcrossSessions?: boolean;
}

interface MarginBrowserApi {
  runtime: {
    id: string;
    lastError?: { message?: string };
    getURL(path: string): string;
    getManifest(): any;
    sendMessage(message: any): Promise<any>;
    sendNativeMessage(application: string, message: any): Promise<any>;
    connectNative(application: string): BrowserPort;
    onMessage: BrowserEvent<(message: any, sender: BrowserMessageSender, sendResponse: (response?: any) => void) => boolean | void | Promise<any>>;
    onInstalled: BrowserEvent<(details: { reason: string, previousVersion?: string }) => void>;
    onStartup: BrowserEvent<() => void>;
  };
  tabs: {
    get(tabId: number): Promise<BrowserTab>;
    getCurrent(): Promise<BrowserTab | undefined>;
    query(query: { active?: boolean, currentWindow?: boolean, lastFocusedWindow?: boolean, windowId?: number, url?: string | string[], status?: string, pinned?: boolean, discarded?: boolean, audible?: boolean }): Promise<BrowserTab[]>;
    create(properties: { windowId?: number, url?: string, active?: boolean, index?: number, pinned?: boolean, openerTabId?: number }): Promise<BrowserTab>;
    update(tabId: number, properties: { url?: string, active?: boolean, pinned?: boolean, muted?: boolean, highlighted?: boolean }): Promise<BrowserTab>;
    move(tabIds: number | number[], properties: { windowId?: number, index: number }): Promise<BrowserTab | BrowserTab[]>;
    remove(tabIds: number | number[]): Promise<void>;
    reload(tabId: number, properties?: { bypassCache?: boolean }): Promise<void>;
    goBack(tabId: number): Promise<void>;
    goForward(tabId: number): Promise<void>;
    discard(tabId: number): Promise<BrowserTab | undefined>;
    sendMessage(tabId: number, message: any, options?: { frameId?: number }): Promise<any>;
    captureVisibleTab(windowId?: number, options?: { format?: 'jpeg' | 'png', quality?: number }): Promise<string>;
    getZoom(tabId: number): Promise<number>;
    getZoomSettings(tabId: number): Promise<{ defaultZoomFactor?: number, mode?: string, scope?: string }>;
    onCreated: BrowserEvent<(tab: BrowserTab) => void>;
    onUpdated: BrowserEvent<(tabId: number, change: BrowserTabChange, tab: BrowserTab) => void>;
    onActivated: BrowserEvent<(info: { tabId: number, windowId: number, previousTabId?: number }) => void>;
    onRemoved: BrowserEvent<(tabId: number, info: { windowId: number, isWindowClosing: boolean }) => void>;
    onMoved: BrowserEvent<(tabId: number, info: { windowId: number, fromIndex: number, toIndex: number }) => void>;
    onAttached: BrowserEvent<(tabId: number, info: { newWindowId: number, newPosition: number }) => void>;
    onDetached: BrowserEvent<(tabId: number, info: { oldWindowId: number, oldPosition: number }) => void>;
    onReplaced: BrowserEvent<(addedTabId: number, removedTabId: number) => void>;
    onZoomChange: BrowserEvent<(info: { tabId: number, oldZoomFactor: number, newZoomFactor: number }) => void>;
  };
  windows: {
    get(windowId: number, options?: { populate?: boolean }): Promise<BrowserWindow>;
    getAll(options?: { populate?: boolean, windowTypes?: string[] }): Promise<BrowserWindow[]>;
    getLastFocused(options?: { populate?: boolean }): Promise<BrowserWindow>;
    create(properties: { url?: string | string[], focused?: boolean, state?: string, type?: string, left?: number, top?: number, width?: number, height?: number, tabId?: number }): Promise<BrowserWindow>;
    update(windowId: number, properties: { focused?: boolean, state?: string, left?: number, top?: number, width?: number, height?: number }): Promise<BrowserWindow>;
    remove(windowId: number): Promise<void>;
    WINDOW_ID_NONE?: number;
    onCreated: BrowserEvent<(window: BrowserWindow) => void>;
    onRemoved: BrowserEvent<(windowId: number) => void>;
    onFocusChanged: BrowserEvent<(windowId: number) => void>;
    onBoundsChanged?: BrowserEvent<(window: BrowserWindow) => void>;
  };
  storage: {
    local: BrowserStorageArea;
    session: BrowserStorageArea;
    onChanged: BrowserEvent<(changes: Record<string, BrowserStorageChange>, area: string) => void>;
  };
  scripting: {
    executeScript<A extends any[], R>(injection: { target: BrowserInjectionTarget, func: (...args: A) => R, args?: A, world?: 'ISOLATED' | 'MAIN', injectImmediately?: boolean }): Promise<BrowserInjectionResult<Awaited<R>>[]>;
    executeScript(injection: { target: BrowserInjectionTarget, files: string[], world?: 'ISOLATED' | 'MAIN', injectImmediately?: boolean }): Promise<BrowserInjectionResult<any>[]>;
    insertCSS(injection: { target: BrowserInjectionTarget, css?: string, files?: string[], origin?: 'AUTHOR' | 'USER' }): Promise<void>;
    registerContentScripts(scripts: BrowserRegisteredContentScript[]): Promise<void>;
    updateContentScripts(scripts: Partial<BrowserRegisteredContentScript>[]): Promise<void>;
    unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
    getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<BrowserRegisteredContentScript[]>;
  };
  permissions: {
    contains(permissions: { origins?: string[], permissions?: string[] }): Promise<boolean>;
    onAdded?: BrowserEvent<(permissions: { origins?: string[], permissions?: string[] }) => void>;
    onRemoved?: BrowserEvent<(permissions: { origins?: string[], permissions?: string[] }) => void>;
  };
  alarms?: {
    get(name: string): Promise<{ name: string, scheduledTime: number, periodInMinutes?: number } | undefined>;
    create(name: string, info: { when?: number, delayInMinutes?: number, periodInMinutes?: number }): void | Promise<void>;
    onAlarm: BrowserEvent<(alarm: { name: string, scheduledTime: number }) => void>;
  };
  commands?: {
    onCommand: BrowserEvent<(command: string, tab?: BrowserTab) => void>;
  };
  /** Chrome's: a search with the browser's engine. */
  search?: {
    query(options: { text: string, tabId?: number, disposition?: 'CURRENT_TAB' | 'NEW_TAB' | 'NEW_WINDOW' }): Promise<void>;
  };
  webNavigation?: {
    onCommitted: BrowserEvent<(details: { tabId: number, frameId: number, documentId?: string, url: string, timeStamp: number, transitionType?: string }) => void>;
  };
}
