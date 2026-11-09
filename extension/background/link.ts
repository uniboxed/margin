// The extension's end of the link to Margin.app (app/PROTOCOL.md; the app's
// end is app/shell/ExtensionLink.swift). While it's up, the app draws all of
// Margin's UI around this copy's windows (pages never draw any): pages have
// their box, which comes from the app's layout per window (setLayout), in
// the windows the app draws over (`drawn`: a window it doesn't gets none).
// Safari's copies, and Chrome's and Edge's on the Mac (shared/platform.ts linksApp), in the copy that owns its profile's state.
//
// Getting linked (the app can't open anything into the extension, and the
// extension can reach only the app's extension handler):
//  1. a lasting native port (runtime.connectNative), used at least every
//     PING_MS: Phase 0 found it keeps Safari's background page alive, which a
//     WebSocket alone doesn't (unloaded after about 30 s). What the app
//     dispatches into the extension (SFSafariApplication.dispatchMessage)
//     comes on it: { name, userInfo: { e: <JSON> } }.
//  2. wantLink { nonce } (sendNativeMessage: the handler says whether the app
//     is open and passes the nonce on). Safari may never answer it when
//     several profiles' copies ask at once (REPLY_WAIT_MS), so nothing waits
//     on that answer for long;
//  3. the app's `link` with that nonce: port, token, key (others' nonces, and
//     ones Safari replays, are left). Every copy hears every dispatch;
//  4. ws://127.0.0.1:<port>/?t=<token>; the app's first message is
//     welcome { key }: anything else closes the socket. Then hello, the
//     snapshot, the theme in pieces, the keys and data.hello.
// The link (port, token, key) is kept in storage.session: a background
// starting again tries it first. `appUp` (the app started) asks again at once.
//
// While linked: storage changes go as deltas (site icons as a diff), the
// window list when it changes (looked at every WINDOWS_MS, and on events),
// requests from the app run the background's handlers (`route`, with
// `windowId` standing in for the page's sender.tab.windowId) and are
// answered, ticks are answered, and nothing heard for DEAD_MS drops the link.
// A drop is tried again with the kept link (RECONNECT_MS), then asked for
// again, less and less often (ASK_MS), and on every page starting (poke).
// Asked for while a try is under way (appUp, a page, the person), it's asked
// again once that try ends unlinked; a try under way STUCK_MS is left; and
// each ping checks an unlinked copy has a try under way or one to come.
//
// What pages see (storage.local appLink, shared/app-link.ts): 'linked', then
// on a drop 'reconnecting' for GONE_MS (the app keeps the last picture,
// dimmed, saying it's reconnecting), and only then 'off' (pages lose their
// box: no Margin then), with `why: 'no-link'` while Margin.app is running but
// sends no link (NO_LINK_ASK_MS). The app saying goodbye (it quit) is 'off' at once. Each
// window's layout is kept there too (pages new and old read it), and the
// window's page in front is told at once (`appLayout`).
//
// The background must be a page here: in a worker WebKit's `new WebSocket`
// never returns and hangs the background until Safari restarts
// (feat/native-panel, DECISIONS.md 2026-10-30). So no socket is made unless
// the background is a document (canSocket); and as there, a socket being
// opened is noted first (storage.local appLinkOpening) and the note removed
// once its handlers are on: a background that finds the note left (it never
// got past a constructor, or Safari quit just then) makes no socket for the
// rest of that Safari session; found again in a later session, for OFF_MS
// (24 h). Never longer, and the new-tab page's Try again ends it at once
// (every build is version 0.1.0, so the old "until another version" was
// never). Each time it turns sockets off it says so in Margin.app's log, and
// in the next hello.
//
// Margin.app's log gets the link's notes (note): the background starting
// (with the kept link and how the one before ended), each try of the kept
// link and how it went, the native port going and coming back, a check
// that ran late (the background paused), and why each drop or close. Notes
// made while the native port is down are kept (HELD_NOTES) and sent once
// it's back, each with the time it was made.
//
// Data (DATA.md "Messages"): data.hello with the queue of changes made while
// unlinked; data.need → data.snapshot from the converter; the app's
// data.snapshot becomes the cache; data.changes both ways; data.ack keeps
// how far the app has stored (`acked`, with the copy's profile id, in
// storage.local `dataMeta:link`, which pages ignore).
import { browserName, linksApp, platform } from '../shared/platform.ts';
import { APP_LINK_KEY } from '../shared/app-link.ts';
import { navigationFor } from '../shared/shortcuts.ts';
import { DATA_FORMAT } from '../shared/data-merge.ts';
import { switchLog } from './switch-log.ts';

const APP = 'io.tirth.margin';
const VERSION = 2;
export const PING_MS = 20_000; // the native port, used at least this often (Spike 3)
export const DEAD_MS = 40_000; // no tick for this long: the link is gone (app/PROTOCOL.md Liveness; 40 s, not 12, since 2026-11-07: Safari slows a background page while it isn't in front)
const CHECK_MS = 2000;
const LINK_WAIT_MS = 2000; // the app's `link` after wantLink
const OPEN_WAIT_MS = 2000; // a socket opening, and the app's welcome
const KEPT_WAIT_MS = 400; // the kept link, at a start
export const RECONNECT_MS = [250, 500, 1000, 2000, 4000];
export const ASK_MS = [5000, 60_000]; // asked again after this long, doubling up to the second
export const GONE_MS = 6000; // a drop not mended in this long: 'off', pages lose their box
export const LAUNCH_ASK_MS = 500; // the app being started on demand: asked again this often…
export const LAUNCH_ASKS = 20; // …this many times (10 s), then as any other time
// Margin.app running but sending no link (the handler said appOpen, nothing came): asked
// again after NO_LINK_ASK_MS, at most NO_LINK_ASKS times in a row, then less and less often
// as any other time. An app replaced under itself by an update quits once it notices
// (app/shell/BundleWatch.swift), and the handler starts the new one at the next ask.
export const NO_LINK_ASK_MS = 5000;
export const NO_LINK_ASKS = 3;
// The extension handler's answer to wantLink, waited for this long at most. Safari 27.2 answers
// only one of several native messages its profiles' copies send at once (2026-11-06: five copies
// starting together, one answered, the other four promises never settled), so the link is taken
// whenever it comes, answered or not: the app's dispatch reaches every copy.
export const REPLY_WAIT_MS = 3000;
// A try of the link under way this long is taken to be stuck (a promise Safari never settles):
// left, and the link asked for again. Checked at each ping and whenever something asks.
export const STUCK_MS = 45_000;
const DELTA_MS = 16;
export const WINDOWS_MS = 1000;
const LAYOUT_WRITE_MS = 120;
export const CHUNK_BYTES = 512 * 1024;
export const SESSION_KEY = 'appLinkKept';
export const LINK_META = 'dataMeta:link'; // { profile, acked, rev? }
const OPENING_KEY = 'appLinkOpening';
// A lasting off: { at, until, count, why }, only until `until` (an old { v } is removed).
const OFF_KEY = 'appLinkOff';
// Sockets off for this Safari session: { at, why } (storage.session).
const SESSION_OFF_KEY = 'appLinkSessionOff';
// How many Safari sessions found the opening note left, and when last: { count, at } (storage.local;
// cleared once a link opens, or by Try again).
const HUNG_KEY = 'appLinkHung';
export const OFF_MS = 24 * 3600_000;
// How the last link here ended, for the next background's start note: { what: 'linked' | 'dropped' |
// 'stopped', why, at } (storage.session).
const LAST_KEY = 'appLinkLast';
export const HELD_NOTES = 20; // notes kept while the native port is down
const PORT_NOTE_MS = 60_000; // the native port going and coming back: noted at most this often
const FAST_CLOSE_MS = 100; // a kept link closed this soon: refused (nothing listens there now)
// The stored values the app's UI draws from (as pages read them, before
// shared/stored.ts fromStorage). Not the theme package (sent as `theme`), the
// data set's times, this link's own key, page zoom or user themes.
export const STATE_KEYS = ['openTabs', 'spaces', 'pins', 'folders', 'archive', 'settings', 'favicons', 'owner'];
// What the app's UI may ask (ui/actions.ts, shared/search.ts rows,
// app/shell/Shell.swift's keys), and nothing else.
export const APP_REQUESTS = new Set([
  'activateTab', 'closeTab', 'newTab', 'pinTab', 'unpin', 'moveTabToSpace', 'moveTab', 'openPin', 'movePin',
  'setFolderOpen', 'createFolder', 'renameFolder', 'deleteFolder', 'moveFolder', 'setSpace', 'createSpace',
  'renameSpace', 'deleteSpace', 'clearToday', 'goBack', 'goForward', 'reload', 'restoreArchive', 'openLauncher',
  'newWindow', 'search', 'toggleFullscreen', 'updateSettings', 'updateThemeSettings', 'navigate', 'sidebarScroll',
  'setSidebarScroll', 'wakeSleeping', 'windowState', 'openHere', 'cancelNewTab',
  // A button of one of Margin's notices the overlay put up (background/notices.ts).
  'noticeAction',
  // Margin.app's switch to another profile's space (app/shell/ProfileSwitch.swift) and its order across profiles.
  'openSpaceWindow', 'closeWindow', 'focusWindow', 'orderSpaces',
  // A palette the app couldn't show over a window (no overlay shown there): ⌘T's hand-off undone.
  'paletteDropped',
  // DEV-HOOK: the app's dev hook's tab-move probe (app/shell/DevHooks.swift `probe`; Test A only).
  'devTabMoveProbe',
  // The profile handoff (app/HANDOFF.md §3.3): a window's state without taking focus, the frames of
  // its tab in front, and its drafts before a close.
  'setWindowState', 'frameProbe', 'windowDrafts',
  // Margin.app's index of the person's imported themes (app/shell/ShellThemes.swift).
  'userThemes',
]);
// The requests that call windows.update or windows.remove for one window: each carries `notAfter`
// from the handoff, and only one runs per window at a time (app/HANDOFF.md §1.9).
export const WINDOW_CALLS = new Set(['setWindowState', 'focusWindow', 'closeWindow']);
// What a parked window's `parkedActivity` says happened there (app/PROTOCOL.md "The handoff").
export const PARKED_WHY = new Set(['tab', 'focus', 'raise']);

// A windows call that mustn't run, and its answer: past its `notAfter` (milliseconds since 1970, the
// app's clock and this copy's being the same), `{ refused: 'late', pastMs }`; another windows call for
// that window still pending, `{ busy: true }`; else null (run it). A request with no `notAfter`
// (today's switch) is never late. Only the arrival is checked: a call made can't be taken back.
export function windowCallRefusal(message: { windowId?: number, notAfter?: number }, pending: { has(id: number): boolean }, at: number = Date.now()) {
  const { windowId, notAfter } = message ?? {};
  if (typeof notAfter === 'number' && Number.isFinite(notAfter) && at > notAfter) return { refused: 'late', pastMs: Math.round(at - notAfter) };
  if (Number.isInteger(windowId) && pending.has((windowId as number))) return { busy: true };
  return null;
}

// A time as Margin.app's log shows its own (local, to the millisecond), for lines sent there.
const clock = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};
const random = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${String(Math.random()).slice(2)}`;
// What `promise` gives within `ms`, else null (it's left: Safari may never settle it).
const within = <T>(promise: Promise<T>, ms: number): Promise<T | null> => new Promise<any>((resolve) => {
  const timer = setTimeout(() => resolve(null), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
});
const PROFILE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The app's keys from the settings (`keys`: app/PROTOCOL.md): each command's combinations. */
export function keyBindings(settings: any, commandKeys = {}) {
  const nav = navigationFor(settings);
  const out: Record<string, string[]> = {};
  const add = (command: string, combo: string | undefined) => { if (combo && !(out[command] ??= []).includes(combo)) out[command].push(combo); };
  const names: Record<string, string> = { nextTab: 'next-tab', prevTab: 'prev-tab', nextSpace: 'next-space', prevSpace: 'prev-space' };
  for (const [name, command] of Object.entries(names)) {
    add(command, nav[name]);
    add(command, (commandKeys as Record<string, string | undefined>)[name]); // Safari's manifest commands' keys (⌃⌘ + arrows) too, as pages take them
  }
  add('palette', 'Meta+KeyT');
  add('toggle-sidebar', settings?.sidebarShortcut ?? 'Alt+KeyS');
  return out;
}

/** UTF-8 bytes of a theme package, cut into `theme` pieces (app/PROTOCOL.md Chunks). */
export async function themePieces(pkg: any, sha256: (bytes: Uint8Array) => Promise<string>, chunkBytes = CHUNK_BYTES) {
  const whole = new TextEncoder().encode(JSON.stringify(pkg));
  const transfer = await sha256(whole);
  const parts = Math.max(1, Math.ceil(whole.length / chunkBytes));
  const out: { k: string; id: any; transfer: string; part: number; parts: number; size: number; data: string; }[] = [];
  for (let part = 0; part < parts; part++) {
    const piece = whole.subarray(part * chunkBytes, (part + 1) * chunkBytes);
    let bin = '';
    for (let i = 0; i < piece.length; i += 0x8000) bin += String.fromCharCode.apply(null, (piece.subarray(i, i + 0x8000) as any));
    out.push({ k: 'theme', id: pkg.id, transfer, part, parts, size: whole.length, data: btoa(bin) });
  }
  return out;
}
const webSha256 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', (bytes as any)))].map((b) => b.toString(16).padStart(2, '0')).join('');

// A message as it came (JSON from Margin.app, or a page's): an object whose fields each use checks.
type Said = Record<string, any>;
// Where Margin.app listens, as it said (its port), and the link's secret and key.
type KeptLink = { port: number, token: string, key: string, pid?: number };

export function createLink({
  api,
  isOwner,
  copy,
  instanceId = null,
  WebSocket: Socket = globalThis.WebSocket,
  enabled = () => linksApp() && typeof api.runtime?.connectNative === 'function' && typeof Socket === 'function',
  // (A worker's WebSocket hangs WebKit's background, Transport step 9; Chrome's service worker has none of that.)
  canSocket = () => platform?.name === 'chrome' || (typeof globalThis.document === 'object' && typeof ((globalThis as any)).WorkerGlobalScope === 'undefined'),
  // The socket guard (Transport step 9): Safari's alone.
  socketGuard = platform?.name !== 'chrome',
  data = null,
  theme = async () => null,
  commandKeys = () => ({}),
  // Whether a window is one the app had parked before Safari quit (background/parked-restore.ts): told on its entry.
  wasParked = (_windowId: number) => false,
  log = (...args) => console.info('[margin] link:', ...args),
  sha256 = webSha256,
  // A monotonic clock (ms) for how long the app's been quiet and whether a check ran late.
  now = () => performance.now(),
  timing = {},
}: {
  api: MarginBrowserApi,
  isOwner: () => boolean,
  copy: () => { origin: string, since: number },
  instanceId?: string | null,
  WebSocket?: any,
  enabled?: () => boolean,
  canSocket?: () => boolean,
  socketGuard?: boolean,
  data?: { pendingQueue: (since: number) => Promise<any[]>, snapshot: () => Promise<any>, adopt: (set: any, options?: { changes?: any[], omitted?: any[] }) => Promise<unknown>, take: (changes: any[]) => Promise<unknown>, onChanges: (cb: (changes: any[]) => void) => unknown } | null,
  theme?: () => Promise<any>,
  commandKeys?: () => Record<string, string>,
  wasParked?: (windowId: number) => boolean,
  log?: (...args: any[]) => void,
  sha256?: (bytes: Uint8Array) => Promise<string>,
  now?: () => number,
  timing?: Partial<{ ping: number, dead: number, check: number, linkWait: number, openWait: number, keptWait: number, reconnect: number[], ask: number[], gone: number, windows: number, layoutWrite: number, launchAsk: number, launchAsks: number, noLinkAsk: number, noLinkAsks: number, offFor: number, replyWait: number, stuck: number }>,
}) {
  const T = {
    ping: PING_MS, dead: DEAD_MS, check: CHECK_MS, linkWait: LINK_WAIT_MS, openWait: OPEN_WAIT_MS, keptWait: KEPT_WAIT_MS,
    reconnect: RECONNECT_MS, ask: ASK_MS, gone: GONE_MS, windows: WINDOWS_MS, layoutWrite: LAYOUT_WRITE_MS, launchAsk: LAUNCH_ASK_MS, launchAsks: LAUNCH_ASKS,
    noLinkAsk: NO_LINK_ASK_MS, noLinkAsks: NO_LINK_ASKS, offFor: OFF_MS, replyWait: REPLY_WAIT_MS, stuck: STUCK_MS, ...timing,
  };
  // What the link does, in the background's console and, through the lasting
  // native port, in Margin.app's own log (the extension handler writes it to
  // the system log: subsystem io.tirth.margin, category extension), so a link
  // that fails can be read in one place. The same line again within a minute
  // of being sent isn't sent again. With no port (not yet, or it went), the
  // newest HELD_NOTES are kept and sent once it's back, each with its time.
  // Never a page's address or title.
  const sentLines: Map<string, number> = new Map();
  let held: { line: string, at: number }[] = [];
  let heldLost = 0;
  const post = (line: string) => {
    const p = port;
    if (!p) return false;
    try {
      p.postMessage({ type: 'log', line: line.slice(0, 300) });
      return true;
    } catch {
      if (port === p) port = null; // gone: the next ping makes another
      return false;
    }
  };
  const sent = (line: string) => {
    sentLines.set(line, Date.now());
    if (sentLines.size > 50) sentLines.delete(sentLines.keys().next().value!); // (it has some)
  };
  function flushHeld() {
    if (heldLost && post(`(${heldLost} earlier notes lost while the native port was down)`)) heldLost = 0;
    while (held.length && !heldLost) {
      const { line, at } = held[0];
      if (!post(`(at ${clock(at)}) ${line}`)) return;
      held.shift();
      sent(line);
    }
  }
  const note = (...args: any[]) => {
    log(...args);
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 300);
    if ((sentLines.get(line) ?? -Infinity) > Date.now() - 60_000) return;
    if (held.length && port) flushHeld();
    if (!held.length && post(line)) return sent(line);
    if (held.some((h) => h.line === line)) return;
    held.push({ line, at: Date.now() });
    if (held.length > HELD_NOTES) {
      held.shift();
      heldLost++;
    }
  };
  let route: (message: any, sender: any) => Promise<any> = async () => ({ ok: false, error: 'not started' });
  let on = false;
  // (The browser's native port and the socket: Margin has no types for the extension APIs.)
  type NativePort = { postMessage(message: any): void, disconnect(): void, onMessage?: any, onDisconnect?: any };
  let port: NativePort | null = null;
  let ws: WebSocket | null = null;
  let epoch: string | null = null;
  let seq = 0;
  let nonce: string | null = null;
  let linkWaiter: ((info: { port: number, token: string, key: string } | null) => void) | null = null;
  let busy: Promise<any> | null = null;
  // When the try under way (busy) started, and whether something asked for the link while it was
  // under way (the app saying it's up, a page starting, the person): asked again once it ends.
  let busySince = 0;
  let askAgain = false;
  let askMs = 0;
  let askTimer: number | null = null;
  let lastHeard = 0;
  // When a late check (a pause) last probed the app: its quiet is counted from then at the earliest.
  let resumedAt = -Infinity;
  // How the last link here ended (LAST_KEY), written in order.
  let lastWrite = Promise.resolve();
  const setLast = (what: string, why: string) => {
    const value = { what, why: String(why).slice(0, 120), at: Date.now() };
    lastWrite = lastWrite.then(() => session()?.set({ [LAST_KEY]: value })).catch(() => {});
  };
  let timers: number[] = [];
  let pingTimer: number | null = null;
  let pending: Record<string, { newValue?: any }> | null = null;
  let pendingTimer: number | null = null;
  let sentIcons: Map<string, string> | null = null;
  let lastWindows = '';
  let lastKeys = '';
  let lastTheme = '';
  let snapshotting: Promise<void> | null = null;
  let appUp = false;
  // The socket guard, once read: { off: false } or { off: true, at, why, until (null: this Safari session) }.
  let guard: { off: boolean, at?: number, why?: string, until?: number | null } | null = null;
  // The guard's sightings (HUNG_KEY), said in the next hello and cleared once a link opens.
  let hung: { count: number, at: number } | null = null;
  let toldWorker = false;
  // What pages see (storage.local appLink).
  // (`why`, `offAt`, `offUntil`: while off, why; `lastLayouts`: the layouts of an older epoch, kept for the first paint.)
  let pageState: { state: string, epoch: any, at: number, layouts: Record<number, any>, drawn: Record<number, boolean>, lastLayouts?: Record<number, any>, why?: string, offAt?: number, offUntil?: number } = { state: 'off', epoch: null, at: 0, layouts: {}, drawn: {} };
  let goneTimer: number | null = null;
  let layoutTimer: number | null = null;
  let stateWrite = Promise.resolve();
  let profile: string | null = null;
  // Whether `profile` is Safari's own id for this profile (`s-…`: from the handler's answer, now or
  // kept from one before), so hello needn't wait for an answer to say it.
  let profileSure = false;
  // The browser's process, as Chrome's and Edge's relay says (none from Safari's handler).
  let browserPid: number | null = null;
  let acked = 0;
  // The app's set's revision this copy's cache matches (DATA.md "Revisions"): a
  // string, compared only for being the same; null when it has none.
  let rev: string | null = null;
  let dataQueue: Promise<unknown> = Promise.resolve();
  const inOrder = (fn: () => Promise<unknown> | undefined) => { dataQueue = dataQueue.then(fn).catch((err) => note('the app\'s data not taken:', err?.message ?? err)); };
  const local = () => api.storage.local;
  const session = () => api.storage?.session;
  const listeners = new Set<any>();

  const send = (message: any) => {
    if (ws?.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };

  // ---- what pages see -------------------------------------------------------
  // A new state is written at once; layouts a moment later (several at once in one write).
  // A new epoch's hello, or off: what the app said of each window is another epoch's (its
  // layouts and whether it draws them), and goes; a new link says it again. The layouts are kept
  // as `lastLayouts`, only for the first paint's registration to start from (registered.ts
  // chooseLayout): no page takes its box from them.
  function setPageState(state: string) {
    if (state === pageState.state && pageState.epoch === epoch) return;
    const changed = state !== pageState.state;
    const fresh = state === 'off' || (state === 'linked' && epoch !== pageState.epoch);
    const last = Object.keys(pageState.layouts ?? {}).length ? pageState.layouts : pageState.lastLayouts ?? {};
    pageState = { ...pageState, state, epoch, at: Date.now(), ...(fresh ? { layouts: ofEpoch(pageState.layouts, epoch), drawn: {}, lastLayouts: last } : {}) };
    if (state !== 'off') {
      delete pageState.why;
      delete pageState.offAt;
      delete pageState.offUntil;
    }
    if (changed) for (const cb of [...listeners]) cb(state);
    writePageState(0);
  }
  const ofEpoch = (layouts: Record<number, any>, at: string | null) => Object.fromEntries(Object.entries(layouts ?? {}).filter(([, l]) => at != null && l?.epoch === at));
  function writePageState(ms: number) {
    if (!isOwner()) return;
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => {
      layoutTimer = null;
      const value = { ...pageState };
      stateWrite = stateWrite.then(() => local().set({ [APP_LINK_KEY]: value })).catch((err) => note('writing appLink failed', err?.message ?? err));
    }, ms);
  }
  // A drop: 'reconnecting', then 'off' unless it's mended within GONE_MS.
  function dropping() {
    if (pageState.state === 'off') return;
    setPageState('reconnecting');
    clearTimeout(goneTimer);
    goneTimer = setTimeout(() => { if (!ws) gone(); }, T.gone);
  }
  function gone() {
    clearTimeout(goneTimer);
    goneTimer = null;
    setPageState('off');
    forgetParked('off');
  }
  // Why there's no link, for the new-tab page: 'no-link' (Margin.app is
  // running but sent none), 'sockets-off' (the socket guard turned the link
  // off: `offAt`, and `offUntil` unless it's for this Safari session), or
  // nothing said (it isn't running, or not known).
  function setWhy(why: string | null | undefined, { offAt = undefined, offUntil = undefined }: { offAt?: number, offUntil?: number } = {}) {
    if (pageState.why === why && pageState.offAt === offAt && pageState.offUntil === offUntil) return;
    pageState = { ...pageState };
    delete pageState.why;
    delete pageState.offAt;
    delete pageState.offUntil;
    if (why) pageState.why = why;
    if (offAt != null) pageState.offAt = offAt;
    if (offUntil != null) pageState.offUntil = offUntil;
    writePageState(0);
  }

  // ---- the native port --------------------------------------------------------
  function ensurePort() {
    if (port) return port;
    try {
      port = api.runtime.connectNative(APP) as NativePort;
    } catch {
      return (port = null);
    }
    const mine = port;
    port.onMessage?.addListener((m: Said) => onNative(m));
    port.onDisconnect?.addListener(() => { if (port === mine) { port = null; portLost(); } });
    portBack();
    flushHeld();
    return port;
  }
  // The native port going and coming back, at most once a PORT_NOTE_MS each (counted between).
  let portDownAt: number | null = null;
  let portDrops = 0;
  let portLostNoted = -Infinity;
  let portBackNoted = -Infinity;
  function portLost() {
    portDownAt ??= Date.now();
    portDrops++;
    if (Date.now() - portLostNoted < PORT_NOTE_MS) return;
    portLostNoted = Date.now();
    let error = '';
    try { error = String(api.runtime.lastError?.message ?? ''); } catch {}
    note(`the native port disconnected${error ? ` (${error.slice(0, 80)})` : ''}; it's made again at the next ping`);
  }
  function portBack() {
    if (portDownAt == null) return;
    const down = Date.now() - portDownAt;
    portDownAt = null;
    if (Date.now() - portBackNoted < PORT_NOTE_MS) return;
    portBackNoted = Date.now();
    note(`the native port is back after ${(down / 1000).toFixed(1)} s (${portDrops} disconnect${portDrops === 1 ? '' : 's'} since the last such note)`);
    portDrops = 0;
  }
  function ping() {
    const p = ensurePort();
    try {
      p?.postMessage({ type: 'ping', at: Date.now() });
    } catch {
      if (port === p) {
        port = null;
        portLost();
      }
    }
  }
  function onNative(message: Said) {
    if (!on || !message?.name) return; // (the handler's replies to pings have no name)
    let info = message.userInfo ?? {};
    if (typeof info.e === 'string') {
      try {
        info = JSON.parse(info.e);
      } catch {
        return;
      }
    }
    if (message.name === 'link') {
      if (info?.v !== VERSION || !info.nonce || info.nonce !== nonce || !validLink(info)) return;
      linkWaiter?.({ port: info.port, token: info.token, key: info.key });
    } else if (message.name === 'appUp' && !ws) {
      appUp = true; // the kept link is the app's before
      askMs = 0;
      void link({ kept: false }); // (a try under way: asked again once it ends)
    }
  }

  // ---- getting linked ---------------------------------------------------------
  const validLink = (l: Said | null | undefined): l is KeptLink => Number.isInteger(l?.port) && l!.port > 0 && l!.port < 65536 && typeof l!.token === 'string' && !!l!.token && typeof l!.key === 'string' && !!l!.key;
  async function keptLink() {
    const got = await Promise.resolve(session()?.get(SESSION_KEY)).catch(() => null);
    const kept = got?.[SESSION_KEY];
    if (!validLink(kept)) return null;
    if (typeof kept.pid === 'number' && Number.isInteger(kept.pid) && kept.pid > 0) browserPid ??= kept.pid; // (kept with the link: a worker started again)
    return kept;
  }
  // One try at a time. Asked for while one is under way, the link is asked for again as soon as
  // that one ends unlinked (what it waits on may be an app that's gone, or an answer Safari lost);
  // one under way STUCK_MS is left, and a new one made.
  function link({ kept = true } = {}) {
    if (!on || ws) return Promise.resolve(!!ws);
    if (busy && !stuck()) {
      askAgain = true;
      return busy;
    }
    clearTimeout(askTimer);
    askTimer = null;
    return attempt(async () => {
      if (kept && !appUp) {
        const k = await keptLink();
        if (k) {
          const tried = await open(k, T.keptWait);
          note(`kept link at the background's start (port ${k.port}): ${tried.how}`);
          if (tried.ok) return true;
        }
      }
      return await ask();
    });
  }
  // A try (link, reconnect) as `busy`. Only the newest one clears it: one left as stuck that ends
  // later changes nothing. Ended unlinked with something having asked meanwhile: asked again now.
  function attempt(run: () => Promise<boolean>) {
    askAgain = false;
    busySince = now();
    // (Declared first: the finally can't come before it's set, even if `run` threw at once.)
    let mine: Promise<boolean> | null = null;
    mine = (async () => {
      try {
        return await run();
      } finally {
        if (busy === mine) busy = null;
      }
    })();
    busy = mine;
    void mine.then((ok) => {
      if (busy || !on || ws || ok || !askAgain) return;
      askAgain = false;
      askMs = 0;
      void link({ kept: false });
    }, () => {});
    return mine;
  }
  // A try under way longer than STUCK_MS: noted, and left (busy cleared, so a new one can start).
  function stuck() {
    if (!busy || now() - busySince < T.stuck) return false;
    note(`the link's try has been under way ${Math.round((now() - busySince) / 1000)} s (something it waits on never ended): left, and the link asked for again`);
    busy = null;
    return true;
  }
  // At each ping: an unlinked copy always has a try under way or one to come. A try stuck, or
  // none of either (it never should be): the link asked for now.
  function watch() {
    if (!on || ws) return;
    if (busy) {
      if (!stuck()) return;
    } else if (askTimer) {
      return;
    } else {
      note('unlinked with no try under way or to come: the link asked for now');
    }
    askMs = 0;
    void link({ kept: false });
  }
  // wantLink, and the app's `link` with its nonce taken as soon as it comes: before the handler's
  // answer, which Safari may never give (REPLY_WAIT_MS). Only a copy whose profile id Safari
  // hasn't given yet (none kept from an answer before) waits for the answer to say hello with it.
  async function ask() {
    if (!on) return false;
    if (noSocketHere()) return failed();
    if (socketGuard && await noSockets()) return failed({ socketsOff: true });
    appUp = false;
    const mine = (nonce = random());
    const given: Promise<{ port: number, token: string, key: string } | null> = new Promise((resolve) => { linkWaiter = resolve; });
    const taken = () => { if (nonce === mine) linkWaiter = null; };
    ensurePort(); // the link comes on it
    const asked = now();
    const answered = within(
      Promise.resolve()
        .then(() => api.runtime.sendNativeMessage(APP, { type: 'wantLink', nonce: mine }))
        .then((reply) => ({ reply }), (err) => ({ error: String(err?.message ?? err) })),
      T.replyWait,
    );
    const first = await Promise.race([given.then((value) => ({ link: value })), answered]);
    let got = first && 'link' in first ? first.link : null;
    const answer = got ? null : first;
    if (got && !profileSure) {
      // The link came first, but hello must carry Safari's id for this profile (takeProfile).
      const late = await answered;
      if (late && 'reply' in late) await heardFrom(late.reply);
      if (!late) {
        taken();
        note(`wantLink: the link came but the extension handler's answer didn't within ${T.replyWait} ms, and this profile's id isn't known yet: asked again`);
        return failed({ lost: true });
      }
    }
    if (!got) {
      if (!answer) {
        taken();
        if (!on) return false;
        note(`wantLink: no answer from the extension handler within ${T.replyWait} ms (${Math.round(now() - asked)} ms), and no link`);
        return failed({ lost: true });
      }
      const reply = 'reply' in answer ? answer.reply : null;
      if ('error' in answer) note('wantLink: the extension handler didn\'t answer:', answer.error);
      await heardFrom(reply);
      if (reply?.appOpen !== true || !on) {
        taken();
        // The handler started the app (it wasn't running): asked again soon,
        // and again when it says it's up. Not running and not started: it's
        // gone, no waiting for it.
        if (reply?.launching === true) {
          note('wantLink: Margin.app wasn\'t running; the handler is starting it');
          return failed({ launching: true });
        }
        if (reply) note('wantLink: Margin.app isn\'t running and wasn\'t started');
        return failed({ appGone: reply?.appOpen === false });
      }
      got = await within(given, T.linkWait);
    }
    taken();
    if (!got || !on) {
      if (on) note(`wantLink: Margin.app is running but sent no link within ${T.linkWait} ms`);
      return failed({ noLink: true });
    }
    const tried = await open(got, T.openWait);
    if (tried.ok) return true;
    note(`the link on port ${got.port} didn't open: ${tried.how}`);
    return failed(tried.how === 'sockets off' ? { socketsOff: true } : {});
  }
  // No app to link to: asked again later (and when a page starts, or the app
  // says it's up). Pages lose their box once it's clear.
  let launches = 0;
  let noLinks = 0;
  // `lost`: the handler's answer never came (and no link): asked again like `noLink`, a little
  // apart from the other copies that asked with it, and pages told nothing new.
  function failed({ appGone = false, launching = false, noLink = false, socketsOff = false, lost = false } = {}) {
    if (appGone || socketsOff) gone();
    else if (pageState.state !== 'off' && !goneTimer) dropping();
    if (socketsOff) setWhy('sockets-off', { offAt: guard?.at ?? Date.now(), offUntil: guard?.until ?? undefined });
    else if (noLink || appGone || launching) setWhy(noLink ? 'no-link' : undefined);
    if (!noLink && !lost) noLinks = 0;
    // Starting: every LAUNCH_ASK_MS for a while (its appUp may come first).
    if (launching && launches++ < T.launchAsks) askMs = T.launchAsk;
    // Running, no link: NO_LINK_ASK_MS a few times (it may be quitting for a new build), then as below.
    else if ((noLink || lost) && noLinks++ < T.noLinkAsks) askMs = lost ? Math.round(T.noLinkAsk * (1 + Math.random() / 2)) : T.noLinkAsk;
    else askMs = Math.min(Math.max(askMs * 2, T.ask[0]), T.ask[1]);
    clearTimeout(askTimer);
    askTimer = on ? setTimeout(() => { askTimer = null; void link({ kept: false }); }, askMs) : null;
    return false;
  }
  function noSocketHere() {
    if (canSocket()) return false;
    if (!toldWorker) note('the background is a worker here; a WebSocket would hang it, so no link');
    toldWorker = true;
    return true;
  }
  const version = () => api.runtime.getManifest?.().version ?? null;
  // Whether sockets are off here (the socket guard): a background before this
  // one never got past opening one (the note was left). The first Safari
  // session to find it: off for the rest of that session. Found again in a
  // later session (the count kept in storage.local): off for OFF_MS. Then
  // tried again; Try again (retrySockets) ends it at once.
  async function noSockets() {
    if (guard && !(guard.off && guard.until != null && Date.now() >= guard.until)) return guard.off;
    const [kept, got] = await Promise.all([
      Promise.resolve(local().get([OPENING_KEY, OFF_KEY, HUNG_KEY])).catch(() => null),
      Promise.resolve(session()?.get(SESSION_OFF_KEY)).catch(() => null),
    ]);
    const h = kept?.[HUNG_KEY];
    hung = Number.isInteger(h?.count) && h.count > 0 && Number.isFinite(h.at) ? { count: h.count, at: h.at } : null;
    const off = kept?.[OFF_KEY];
    if (off && typeof off === 'object') {
      if (Number.isFinite(off.until) && Date.now() < off.until) {
        guard = { off: true, at: Number.isFinite(off.at) ? off.at : null, why: String(off.why ?? ''), until: off.until };
        note(`sockets off since ${clock(guard.at ?? Date.now())} until ${new Date(off.until).toISOString()}: ${guard.why}`);
        return true;
      }
      // Ended, or the old shape ({ v }: until another version of Margin, which never came).
      await Promise.resolve(local().remove(OFF_KEY)).catch(() => {});
      note(Number.isFinite(off.until) ? `the link's lasting off ended at ${new Date(off.until).toISOString()}: sockets on again` : 'an old lasting off (until another version) was left: removed, sockets on again');
    }
    const sessionOff = got?.[SESSION_OFF_KEY];
    if (sessionOff) {
      guard = { off: true, at: Number.isFinite(sessionOff.at) ? sessionOff.at : null, why: String(sessionOff.why ?? 'a socket being opened was never finished'), until: null };
      note(`sockets off for this Safari session${guard.at ? ` since ${clock(guard.at)}` : ''}: ${guard.why}`);
      return true;
    }
    if (kept?.[OPENING_KEY]) {
      const at = Date.now();
      const count = (hung?.count ?? 0) + 1;
      const why = 'a socket being opened was never finished (its constructor hung, or Safari quit just then)';
      hung = { count, at };
      await Promise.resolve(local().remove(OPENING_KEY)).catch(() => {});
      if (count >= 2) {
        const until = at + T.offFor;
        await Promise.resolve(local().set({ [HUNG_KEY]: hung, [OFF_KEY]: { at, until, count, why } })).catch(() => {});
        guard = { off: true, at, why, until };
        note(`the socket guard turned the link off: ${why}, in ${count} Safari sessions; no link until ${new Date(until).toISOString()} (Try again on the new-tab page ends it)`);
      } else {
        await Promise.resolve(local().set({ [HUNG_KEY]: hung })).catch(() => {});
        await Promise.resolve(session()?.set({ [SESSION_OFF_KEY]: { at, why } })).catch(() => {});
        guard = { off: true, at, why, until: null };
        note(`the socket guard turned the link off: ${why}; no link for the rest of this Safari session (Try again on the new-tab page ends it)`);
      }
      return true;
    }
    guard = { off: false };
    return false;
  }
  // A kept or given link opened: { ok, how } (`how` for the log: 'open in 12 ms', 'refused or closed
  // at once (3 ms)', 'no welcome within 400 ms (slow)', …).
  async function open(kept: KeptLink, waitMs: number) {
    if (noSocketHere() || (socketGuard && await noSockets())) return { ok: false, how: 'sockets off' };
    if (socketGuard) await Promise.resolve(local().set({ [OPENING_KEY]: { at: Date.now() } })).catch(() => {});
    let socket = null;
    try {
      socket = new Socket(`ws://127.0.0.1:${kept.port}/?t=${encodeURIComponent(kept.token)}`);
    } catch {
      socket = null;
    }
    // Its handlers on before anything is awaited (a welcome that came meanwhile would be lost), then the note goes.
    const followed = socket ? follow(socket, kept, waitMs) : null;
    if (socketGuard) await Promise.resolve(local().remove(OPENING_KEY)).catch(() => {});
    return followed ? await followed : { ok: false, how: 'the WebSocket constructor threw' };
  }
  // A socket closed with a code and why (a page's WebSocket may send only 1000 or 3000–4999, and up to 123 bytes).
  const closeSocket = (socket: WebSocket | null | undefined, why: string) => { try { socket?.close(1000, String(why).slice(0, 100)); } catch {} };
  // Until it's open and the app has said who it is (or not, in `waitMs`).
  function follow(socket: WebSocket, kept: KeptLink, waitMs: number) {
    const t0 = now();
    const ms = () => Math.round(now() - t0);
    return new Promise<any>((resolve) => {
      let welcomed = false;
      let settled = false;
      const done = (ok: boolean, how: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok, how });
      };
      const giveUp = (why: string, how = why) => {
        closeSocket(socket, why);
        done(false, how);
      };
      const timer = setTimeout(() => { if (!welcomed) giveUp(`no welcome within ${waitMs} ms`, `no welcome within ${waitMs} ms (slow)`); }, waitMs);
      socket.onopen = () => { if (!on || ws) giveUp('not needed: linked already, or stopped'); };
      socket.onerror = () => {};
      socket.onclose = (event) => {
        const code = `${event?.code ?? '?'}${event?.reason ? ` ${String(event.reason).slice(0, 80)}` : ''}`;
        if (!welcomed) return done(false, ms() < FAST_CLOSE_MS ? `refused or closed at once (${ms()} ms, ${code})` : `closed after ${ms()} ms before the welcome (${code})`);
        if (ws === socket) dropped(`closed by the app (${code})`);
      };
      socket.onmessage = (event) => {
        if (welcomed) {
          if (ws === socket) onApp(event.data);
          return;
        }
        if (!on || ws) return giveUp('not needed: linked already, or stopped');
        let m: { k?: string, v?: number, key?: string } | null = null;
        try { m = JSON.parse(String(event.data)); } catch {}
        if (m?.k !== 'welcome' || m.v !== VERSION || m.key !== kept.key) {
          note('what answered on', kept.port, 'isn\'t Margin.app; that link is forgotten');
          void forget(kept);
          return giveUp('not Margin.app\'s welcome', 'not Margin.app (wrong welcome)');
        }
        welcomed = true;
        linked(socket, kept);
        done(true, `open in ${ms()} ms`);
      };
    });
  }
  async function forget(kept: KeptLink) {
    const got = await Promise.resolve(session()?.get(SESSION_KEY)).catch(() => null);
    if (got?.[SESSION_KEY]?.token === kept.token) await Promise.resolve(session()?.remove(SESSION_KEY)).catch(() => {});
  }

  // ---- linked ------------------------------------------------------------------
  function linked(socket: WebSocket, { port: at, token, key }: KeptLink) {
    ws = socket;
    epoch = random();
    seq = 0;
    lastHeard = now();
    resumedAt = -Infinity;
    askMs = 0;
    launches = 0;
    noLinks = 0;
    lastWindows = '';
    lastList = null;
    lastKeys = '';
    lastTheme = '';
    clearTimeout(goneTimer);
    goneTimer = null;
    forgetParked('a new link');
    void Promise.resolve(session()?.set({ [SESSION_KEY]: { port: at, token, key, ...(browserPid ? { pid: browserPid } : {}) } })).catch(() => {});
    setLast('linked', `on port ${at}`);
    const { origin, since } = copy();
    // The socket guard's sightings, said once to the app and then forgotten: sockets work here.
    const offBefore = hung ? `the socket guard found an unfinished socket in ${hung.count} Safari session${hung.count === 1 ? '' : 's'}, last at ${new Date(hung.at).toISOString()}` : null;
    send({ k: 'hello', v: VERSION, epoch, profile, browser: browserName(), ...(browserPid ? { pid: browserPid } : {}), owner: isOwner(), ext: version(), instanceId, origin, since, ...(offBefore ? { socketsOff: offBefore } : {}) });
    if (hung) {
      hung = null;
      void Promise.resolve(local().remove(HUNG_KEY)).catch(() => {});
    }
    setPageState('linked');
    void (async () => {
      const at0 = epoch;
      await snapshot();
      if (epoch !== at0) return;
      await sendTheme();
      sendKeys();
      await dataHello();
    })();
    // Every CHECK_MS: nothing heard from the app for DEAD_MS drops the link. A check that ran
    // late (over 3 checks: the background was paused, or the Mac slept) judges nothing itself: it
    // notes the pause, sends the app a tock (it hears this copy is back), and the link is judged
    // after what came in meanwhile (a setTimeout of 0, after the socket's queued messages), the
    // app's quiet counted from that probe, never from before the pause.
    let lastCheck = now();
    const judge = () => {
      if (ws === socket && now() - Math.max(lastHeard, resumedAt) > T.dead) drop(`no word from the app for ${Math.round(DEAD_MS / 1000)} s`);
    };
    timers = [
      setInterval(() => {
        if (!isOwner()) return stop('a newer copy of Margin is running');
        const t = now();
        const gap = t - lastCheck;
        lastCheck = t;
        if (gap > 3 * T.check) {
          resumedAt = t;
          note(`paused ${(gap / 1000).toFixed(1)} s (a link check ran late); probing the app, judged from now`);
          send({ k: 'tock', at: Date.now() });
          setTimeout(judge, 0);
          return;
        }
        judge();
      }, T.check),
      setInterval(() => void windowsNow(), T.windows),
    ];
    note('linked on', at);
  }
  function drop(why: string) {
    const socket = ws;
    if (!socket) return;
    dropped(why);
    closeSocket(socket, why);
  }
  // `bye`: the app said goodbye (it quit): pages lose their box at once, and
  // the app is asked for later. Else a drop: tried again.
  function dropped(why: string, { bye = false } = {}) {
    if (!ws) return;
    ws = null;
    epoch = null;
    for (const t of timers) clearInterval(t);
    timers = [];
    clearTimeout(pendingTimer);
    pending = null;
    pendingTimer = null;
    sentIcons = null;
    note('dropped:', why);
    setLast('dropped', why);
    if (bye || !on) {
      gone();
      void Promise.resolve(session()?.remove(SESSION_KEY)).catch(() => {});
      if (on) failed();
      return;
    }
    dropping();
    void reconnect();
  }
  async function reconnect() {
    if (busy && !stuck()) return busy;
    return attempt(async () => {
      let n = 0;
      for (const ms of T.reconnect) {
        await new Promise<any>((resolve) => setTimeout(resolve, ms));
        if (!on || ws) return !!ws;
        const kept = appUp ? null : await keptLink();
        if (!kept) {
          note(appUp ? 'the kept link not tried: the app said it started again' : 'no kept link to try: asking');
          break;
        }
        const tried = await open(kept, T.openWait);
        note(`kept link try ${++n} of ${T.reconnect.length} (port ${kept.port}): ${tried.how}`);
        if (tried.ok) return true;
        if (tried.how === 'sockets off') break;
      }
      return on && !ws ? await ask() : !!ws;
    });
  }

  // ---- what the app says -----------------------------------------------------------
  function onApp(text: string) {
    let message;
    try {
      message = JSON.parse(String(text));
    } catch {
      return;
    }
    lastHeard = now();
    switch (message?.k) {
      case 'tick':
        return void send({ k: 'tock', at: Date.now() });
      case 'req':
        return void request(message);
      case 'setLayout':
        return setLayout(message);
      case 'drawn':
        return drawn(message);
      case 'parked':
        return parkedSaid(message);
      case 'resync':
        if (message.epoch === epoch) void snapshot();
        return;
      case 'bye': {
        const socket = ws;
        note('the app said goodbye:', message.why);
        dropped(`bye (${message.why})`, { bye: true });
        closeSocket(socket, 'the app said goodbye');
        return;
      }
      case 'data.need':
        if (ours(message) && message.all === true) void dataSnapshot();
        return;
      // In the order they came: an ack's `rev` holds only once what came before it is applied.
      case 'data.snapshot':
        if (ours(message)) inOrder(() => takeSnapshot(message));
        return;
      case 'data.changes':
        if (ours(message) && Array.isArray(message.changes) && message.changes.length) inOrder(() => data?.take(message.changes));
        return;
      case 'data.ack':
        if (ours(message)) inOrder(() => takeAck(message));
        return;
      default:
        return; // unknown kinds are left (app/PROTOCOL.md)
    }
  }
  async function request({ id, epoch: theirs, windowId, type, payload }: Said) {
    if (!Number.isInteger(id)) return;
    if (theirs !== epoch) return send({ k: 'reply', id, ok: false, error: 'stale epoch' });
    if (!APP_REQUESTS.has(type)) return send({ k: 'reply', id, ok: false, error: `not a request Margin's UI makes: ${type}` });
    if (windowId != null && !Number.isInteger(windowId)) return send({ k: 'reply', id, ok: false, error: 'no window' });
    const message = { ...(payload && typeof payload === 'object' ? payload : {}), type };
    if (message.windowId == null && windowId != null) message.windowId = windowId;
    // The page's sender, as the app's window: handlers that use the page's
    // sender.tab.windowId get the window the UI was drawn for; nothing has a
    // tab id (the app's UI isn't a page).
    const sender = { app: true, tab: windowId != null ? { windowId } : undefined };
    const at = epoch;
    const answer = await route(message, sender).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
    if (epoch !== at) return;
    send({ k: 'reply', id, ...(answer && typeof answer === 'object' ? answer : { ok: true, result: answer ?? null }) });
  }
  // Each window's layout, newest per window (a new epoch starts its count again).
  function setLayout(m: Said) {
    if (m.epoch !== epoch || !Number.isInteger(m.windowId) || !m.insets || !Number.isInteger(m.seq)) return;
    const had = pageState.layouts[m.windowId];
    if (had && had.epoch === m.epoch && had.seq >= m.seq) return;
    const layout = { insets: m.insets, radius: m.radius ?? 0, radii: m.radii ?? null, container: m.container ?? null, mode: m.mode ?? 'fullscreen', seq: m.seq, epoch: m.epoch };
    pageState = { ...pageState, layouts: { ...pageState.layouts, [m.windowId]: layout } };
    writePageState(T.layoutWrite);
    for (const cb of [...layoutListeners]) cb(m.windowId, layout);
  }
  const layoutListeners = new Set<any>();
  // Whether the app draws over a window (its binding, not whether its overlay is on screen now):
  // false, its pages get no box (shared/app-link.ts layoutFor). Only a change is sent; this
  // epoch's only.
  function drawn(m: Said) {
    if (m.epoch !== epoch || !Number.isInteger(m.windowId) || typeof m.on !== 'boolean') return;
    if (pageState.drawn?.[m.windowId] === m.on) return;
    pageState = { ...pageState, drawn: { ...pageState.drawn, [m.windowId]: m.on } };
    note(`the app ${m.on ? 'draws' : 'draws nothing'} over window ${m.windowId}`);
    writePageState(T.layoutWrite);
    for (const cb of [...drawnListeners]) cb(m.windowId, m.on);
  }
  const drawnListeners = new Set<any>();
  // Which of this copy's windows the app has parked (app/HANDOFF.md §2.5): out of sight in a private
  // Space of their own, alive and normal. Kept per window as the app says it, this epoch's only: a
  // new link, the link going off and the window closing forget it (a new link says it again). Not
  // stored: no page reads it. windowId → when the app parked it.
  const parked: Map<number, number> = new Map();
  function parkedSaid(m: Said) {
    if (m.epoch !== epoch || !Number.isInteger(m.windowId) || typeof m.on !== 'boolean') return;
    if (parked.has(m.windowId) === m.on) return;
    if (m.on) parked.set(m.windowId, Number.isFinite(m.at) ? m.at : Date.now());
    else parked.delete(m.windowId);
    note(`the app ${m.on ? 'parked' : 'no longer parks'} window ${m.windowId}`);
    for (const cb of [...parkedListeners]) cb(m.windowId, m.on);
  }
  function forgetParked(why: string) {
    if (!parked.size) return;
    note(`parked windows forgotten (${why}): ${[...parked.keys()].join(', ')}`);
    const ids = [...parked.keys()];
    parked.clear();
    for (const id of ids) for (const cb of [...parkedListeners]) cb(id, false, true); // (forgotten: not the app's word)
  }
  const parkedListeners = new Set<any>();
  // A window gone: what the app said of it goes too.
  function forgetWindows(ids: string[]) {
    const layouts = { ...pageState.layouts };
    const drawnNow = { ...pageState.drawn };
    let changed = false;
    for (const id of ids) {
      if (id in layouts) { delete (layouts as Record<string, unknown>)[id]; changed = true; }
      if (id in drawnNow) { delete (drawnNow as Record<string, unknown>)[id]; changed = true; }
    }
    if (!changed) return;
    pageState = { ...pageState, layouts, drawn: drawnNow };
    writePageState(T.layoutWrite);
  }

  // ---- the state, to the app ---------------------------------------------------------
  async function snapshot() {
    if (!ws) return;
    const at = epoch;
    const run = (async () => {
      const raw = await Promise.resolve(local().get(STATE_KEYS)).catch(() => null);
      const windows = await windowList();
      if (!raw || epoch !== at) return;
      sentIcons = iconsOf(raw.favicons);
      lastWindows = JSON.stringify(windows);
      lastList = windows;
      send({ k: 'snapshot', epoch, seq: ++seq, state: raw, windows });
      noteFlags(windows);
    })();
    snapshotting = run;
    await run.catch(() => {});
    if (snapshotting === run) snapshotting = null;
    if (pending && !pendingTimer) flushSoon();
  }
  const iconsOf = (favicons: Record<string, unknown> | null | undefined) => new Map(Object.entries(favicons ?? {}).map(([origin, entry]) => [origin, JSON.stringify(entry)] as [string, string]));
  function flushSoon() {
    pendingTimer ??= setTimeout(() => {
      pendingTimer = null;
      if (snapshotting) return; // after it
      flush();
    }, DELTA_MS);
  }
  function flush() {
    if (!ws || !pending) return;
    const changes = pending;
    pending = null;
    const message: any = { k: 'delta', epoch, seq: 0, changes: {} };
    for (const [key, change] of Object.entries(changes)) {
      if (key !== 'favicons') message.changes[key] = 'newValue' in change ? { newValue: change.newValue } : {};
    }
    if ('favicons' in changes) {
      const now = iconsOf(changes.favicons.newValue);
      const set: Record<string, any> = {};
      const del: string[] = [];
      for (const [origin, json] of now) if (sentIcons?.get(origin) !== json) set[origin] = changes.favicons.newValue[origin];
      for (const origin of sentIcons?.keys() ?? []) if (!now.has(origin)) del.push(origin);
      sentIcons = now;
      if (Object.keys(set).length || del.length) message.favicons = { set, del };
    }
    if (!Object.keys(message.changes).length && !message.favicons) return;
    message.seq = ++seq;
    const sent = send(message);
    if ('openTabs' in message.changes) switchLog.delta(sent);
  }
  async function windowList() {
    const [wins, fronts] = await Promise.all([
      Promise.resolve(api.windows?.getAll?.()).catch((): BrowserWindow[] | null => null),
      Promise.resolve(api.tabs.query({ active: true })).catch((): BrowserTab[] => []),
    ]);
    return (wins ?? ([] as BrowserWindow[])).filter((w) => w?.id != null).map((w) => known({
      windowId: w.id, left: w.left ?? 0, top: w.top ?? 0, width: w.width ?? 0, height: w.height ?? 0,
      state: w.state ?? 'normal', focused: !!w.focused, activeTabId: (fronts ?? []).find((t) => t.windowId === w.id)?.id ?? null,
      ...(focusedAt.has(w.id) ? { focusedAt: focusedAt.get(w.id) } : {}),
      ...(createdAt.has(w.id) ? { createdAt: createdAt.get(w.id) } : {}),
    }));
  }
  // What only this copy knows, on a window's entry: its tab in front's word (the inspector, whether
  // it's shown, are a tab's: app/PROTOCOL.md `viewport`, `visible`), and the last blur it heard.
  function known(entry: { windowId: number, [field: string]: any }) {
    const { viewport: _vp, visible: _v, visibleAt: _va, blurredAt: _b, ...rest } = entry;
    const vp = viewports.get(rest.windowId);
    const seen = rest.activeTabId != null ? visibility.get(rest.activeTabId) : null;
    return {
      ...rest,
      ...(vp && vp.tabId === rest.activeTabId ? { viewport: vp.rect, ...(vp.times ? { viewportTimes: vp.times } : {}) } : {}),
      ...(seen && seen.windowId === rest.windowId ? { visible: seen.visible, visibleAt: seen.at } : {}),
      ...(blurredAt != null ? { blurredAt } : {}),
      ...(wasParked(rest.windowId) ? { wasParked: true } : {}),
      ...(rest.activeTabId != null && fullscreens.get(rest.windowId) === rest.activeTabId ? { pageFullscreen: true } : {}),
    };
  }
  // Where each window's tab in front says its page area sits in the window, when that's less than
  // all of it (content/core.ts viewportNow: the docked Web Inspector): windowId → { tabId, rect }.
  // (`times`: when the page was resized, said it, and this copy heard it, for Margin.app's log.)
  const viewports: Map<number, { tabId: number, rect: { x: number, y: number, width: number, height: number, measured?: boolean }, times?: { resized?: number, said?: number, heard: number } }> = new Map();
  // Windows whose tab in front is in full screen (a page's own, or Safari's video full screen: content/core.ts): windowId → tabId.
  const fullscreens = new Map();
  // When this copy heard each of its windows focused and created (Date.now(), the app's clock too): the
  // app tells same-bounds windows apart by them (app/shell/WindowMatcher.swift). Not kept past the background.
  const focusedAt: Map<number, number> = new Map();
  const createdAt: Map<number, number> = new Map();
  // When this copy last heard windows.onFocusChanged with WINDOW_ID_NONE (none of its windows
  // focused: Safari left the front, or another profile's window took it). Null: not heard.
  let blurredAt: number | null = null;
  // Whether each tab's page says it's shown (content/core.ts, newtab.ts: document.visibilityState),
  // and when it last said so: tabId → { windowId, visible, at }. A window's is its tab in front's,
  // and only that tab's. Missing is unknown (never hidden): a page Margin's script can't run in, one
  // not loaded yet, one whose window just showed another tab (cleared, the new tab asked again).
  // Margin.app tells same-bounds full-screen windows of different profiles apart by it
  // (app/shell/WindowMatcher.swift, the visible rule). Not kept past the background.
  // (`source`, `heard`: what said it and when the background heard it, for the log.)
  const visibility: Map<number, { windowId: number, visible: boolean, at: number, source?: string, heard?: number }> = new Map();
  // Each page in front asked to say again whether it's shown (the background starting, a tab shown).
  const askVisibility = (tabId: number) => { void Promise.resolve(api.tabs.sendMessage?.(tabId, { type: 'reportVisibility' })).catch(() => {}); };
  // Each window shown or hidden, as its tab in front says (a tab behind isn't the window's word): one
  // line in Margin.app's log per change, with when the page saw it, what said it and how late the
  // background heard it (ids and times only). Whether a full-screen window on a Space that isn't
  // showing says hidden, and how fast, is read from these. Looked at VISIBLE_NOTE_MS after a word,
  // so the tab left behind as another is shown (it says hidden first) isn't taken for the window.
  const VISIBLE_NOTE_MS = 150;
  const visibleSaid: Map<number, boolean> = new Map();
  const visibleNoting: Map<number, any> = new Map();
  /** @param tabId the tab that spoke (the window's, if its tab in front isn't known) */
  function noteVisibility(windowId: number, tabId: number) {
    if (visibleNoting.has(windowId)) return;
    visibleNoting.set(windowId, setTimeout(() => {
      visibleNoting.delete(windowId);
      const front = lastList?.find((w) => w.windowId === windowId)?.activeTabId ?? tabId;
      const word = visibility.get(front);
      if (!word || word.windowId !== windowId || visibleSaid.get(windowId) === word.visible) return;
      visibleSaid.set(windowId, word.visible);
      note(`window ${windowId} ${word.visible ? 'shown' : 'hidden'} at ${clock(word.at)} (${word.source ?? 'unknown'}, tab ${front}, heard ${Math.max(0, (word.heard ?? word.at) - word.at)} ms later)`);
    }, VISIBLE_NOTE_MS));
  }
  // The focus flags and visibility of each windows report, in Margin.app's log when they change
  // (ids and times only), so the log says what Safari's flags were when the app bound a window.
  // A line when the flags change (the times in it aren't a change: each focus and each window's shown
  // or hidden has its own line), at most one each FLAGS_NOTE_MS: a change within it is said once it's
  // over, as it is then (a run of tab switches changes the shown word twice a switch).
  const FLAGS_NOTE_MS = 1000;
  let lastFlags = '';
  let flagsAt = -Infinity;
  let flagsTimer: any = null;
  let flagsList: any[] = [];
  function noteFlags(list: { windowId: number, [field: string]: any }[]) {
    flagsList = list;
    if (flagsTimer) return;
    const flags = (times: boolean) => {
      const at = (t: number) => (times ? ` ${clock(t)}` : '');
      const line = flagsList.map((w) => `${w.windowId}${w.focused ? ' focused' : ''}${w.focusedAt ? ` (focus heard${at(w.focusedAt)})` : ''}${'visible' in w ? ` ${w.visible ? 'shown' : 'hidden'}${at(w.visibleAt)}` : ''}`).join('; ');
      return `${line}${blurredAt != null ? `; blur heard${at(blurredAt)}` : ''}`;
    };
    if (flags(false) === lastFlags) return;
    const wait = flagsAt + FLAGS_NOTE_MS - Date.now();
    if (wait > 0) { flagsTimer = setTimeout(() => { flagsTimer = null; noteFlags(flagsList); }, wait); return; }
    lastFlags = flags(false);
    flagsAt = Date.now();
    note(`windows report at ${clock(Date.now())}: ${flags(true) || 'no windows'}`);
  }
  // Sent when any of it changed; a closed window's layout goes too.
  async function windowsNow() {
    if (!ws || snapshotting) return;
    const at = epoch;
    const list = await windowList();
    if (!ws || epoch !== at) return;
    const ids = new Set(list.map((w) => w.windowId));
    forgetWindows([...Object.keys(pageState.layouts), ...Object.keys(pageState.drawn ?? {})].filter((id) => !ids.has(Number(id))));
    const json = JSON.stringify(list);
    if (json === lastWindows) return;
    lastWindows = json;
    lastList = list;
    send({ k: 'windows', epoch, seq: ++seq, list });
    noteFlags(list);
  }
  // The last list sent, for a change only this copy knows (a page's area: the docked inspector),
  // sent at once without asking Safari again; windowsNow follows with Safari's own.
  let lastList: any[] | null = null;
  function windowsFromKnown() {
    if (!ws || snapshotting || !lastList) return false;
    const list = lastList.map(known);
    const json = JSON.stringify(list);
    if (json === lastWindows) return true;
    lastWindows = json;
    lastList = list;
    send({ k: 'windows', epoch, seq: ++seq, list });
    noteFlags(list);
    return true;
  }
  async function sendTheme() {
    if (!ws) return;
    const at = epoch;
    const pkg = await theme().catch(() => null);
    if (!pkg || typeof pkg.id !== 'string' || !ws || epoch !== at) return;
    const key = JSON.stringify([pkg.id, pkg.html.length, pkg.css.length, pkg.manifest]);
    if (key === lastTheme) return;
    const pieces = await themePieces(pkg, sha256);
    if (!ws || epoch !== at) return;
    lastTheme = key;
    for (const piece of pieces) send({ ...piece, epoch });
  }
  let settingsNow: Record<string, any> | null = null; // (the stored settings, as they came)
  function sendKeys(settings = settingsNow) {
    const bindings = keyBindings(settings, commandKeys());
    const json = JSON.stringify(bindings);
    if (!ws || json === lastKeys) return;
    lastKeys = json;
    send({ k: 'keys', epoch, bindings });
  }

  // ---- the data ------------------------------------------------------------------------
  async function readMeta() {
    const got = await Promise.resolve(local().get(LINK_META)).catch(() => null);
    const meta: { profile?: unknown, acked?: unknown, rev?: unknown } | undefined = got?.[LINK_META];
    if (meta && typeof meta.profile === 'string' && PROFILE.test(meta.profile)) {
      profile = meta.profile;
      profileSure = profile.startsWith('s-');
      acked = Number.isFinite(meta.acked) ? (meta.acked as number) : 0; // (finite: a number)
      rev = typeof meta.rev === 'string' && meta.rev ? meta.rev : null;
      // The cache started from defaults since (Safari wiped the rest, or it was
      // never written): no longer the app's set, so the next hello gets it.
      if (rev && !('spaces' in ((await Promise.resolve(local().get('spaces')).catch(() => null)) ?? {}))) {
        rev = null;
        await writeMeta();
      }
      return;
    }
    // Made once per profile's storage, and kept (a profile Safari wiped gets a new one).
    profile = `p-${random().replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}`;
    acked = 0;
    rev = null;
    await writeMeta();
  }
  // Safari's own id for this copy's profile (the handler's reply), when it
  // gives one: kept over the copy's own, so a profile whose storage Safari
  // wiped finds its data in the app again. A different id than before is a
  // profile the app knows apart: no acked, no rev (the app's data.need or
  // snapshot follows).
  async function takeProfile(id: string) {
    if (typeof id !== 'string' || !PROFILE.test(id)) return;
    profileSure = true;
    if (id === profile) return;
    profile = id;
    acked = 0;
    rev = null;
    await writeMeta();
  }
  // The handler's answer: Safari's id for the profile kept; an answer with none (a handler that
  // gives none) means none will come, so nothing waits for one.
  async function heardFrom(reply: Said) {
    // Chrome's and Edge's relay: the browser's process, for hello.
    if (Number.isInteger(reply?.pid) && reply.pid > 0) browserPid = reply.pid;
    if (reply && typeof reply === 'object' && !('profile' in reply)) profileSure = true;
    await takeProfile(reply?.profile);
  }
  const writeMeta = () => Promise.resolve(isOwner() ? local().set({ [LINK_META]: { profile, acked, ...(rev ? { rev } : {}) } }) : null).catch(() => {});
  // `upTo` kept as acked (never lower); a `rev`, when the ack has one.
  async function takeAck(m: Said) {
    let changed = false;
    if (Number.isFinite(m.upTo) && m.upTo > acked) [acked, changed] = [m.upTo, true];
    if (typeof m.rev === 'string' && m.rev && m.rev !== rev) [rev, changed] = [m.rev, true];
    if (changed) await writeMeta();
  }
  // This copy's changes since its last data.hello: merged on top of a
  // snapshot from the app that crosses them (DATA.md "For the extension's end").
  let sinceHello: any[] = []; // (data changes: shared/data-merge.ts)
  async function dataHello() {
    if (!ws || !data) return;
    const at = epoch;
    const queue = await data.pendingQueue(acked).catch(() => []);
    if (!ws || epoch !== at) return;
    sinceHello = [];
    parts = null;
    send({ k: 'data.hello', epoch, profile, format: DATA_FORMAT, acked, ...(rev ? { rev } : {}), queue });
  }
  // The converter's set (data.need: the app has none, or one older than this
  // copy's `acked`), whole: the app takes up to 64 MB.
  async function dataSnapshot() {
    if (!ws || !data) return;
    const at = epoch;
    const set = await data.snapshot().catch(() => null);
    if (!set || !ws || epoch !== at) return;
    send({ k: 'data.snapshot', epoch, profile, format: DATA_FORMAT, transfer: random(), part: 0, parts: 1, set });
  }
  // The app's data set, in parts (each a data set of its own, sharing a
  // `transfer`; part 0 names every collection and lists the items left out),
  // taken once every part is here.
  let parts: { transfer: string, count: number, got: Map<number, any>, omitted: [string, string][], rev: string | null } | null = null;
  async function takeSnapshot(m: Said) {
    if (!data || m.format !== DATA_FORMAT || !m.set || typeof m.set !== 'object') return;
    const count = Number.isInteger(m.parts) && m.parts >= 1 ? m.parts : 1;
    const part = Number.isInteger(m.part) ? m.part : 0;
    if (part < 0 || part >= count) return;
    const transfer = String(m.transfer ?? '');
    if (!parts || parts.transfer !== transfer || parts.count !== count) parts = { transfer, count, got: new Map(), omitted: [], rev: null };
    parts.got.set(part, m.set);
    if (part === 0 && Array.isArray(m.omitted)) parts.omitted = m.omitted.filter((o) => Array.isArray(o) && o.length === 2);
    if (part === 0 && typeof m.rev === 'string' && m.rev) parts.rev = m.rev;
    if (parts.got.size < parts.count) return;
    const items = {};
    for (const piece of parts.got.values()) for (const [c, list] of Object.entries(piece?.items ?? {})) (items as Record<string, any>)[c] = { ...((items as Record<string, any>)[c] ?? {}), ...(list && typeof list === 'object' ? list : {}) };
    const { omitted, rev: setRev } = parts;
    parts = null;
    // A set not taken leaves no `rev`: the next hello gets it again.
    const took = await Promise.resolve(data.adopt({ format: DATA_FORMAT, items }, { changes: sinceHello, omitted })).then(() => true, (err) => (note('the app\'s data set not taken:', err?.message ?? err), false));
    const next = took ? setRev : null;
    if (next !== rev) {
      rev = next;
      await writeMeta();
    }
  }
  // This copy's changes as they're written, while linked (unlinked, they're queued).
  function dataChanged(changes: any[]) {
    if (!ws || !changes.length) return;
    sinceHello.push(...changes);
    if (sinceHello.length > 5000) sinceHello = sinceHello.slice(-5000);
    send({ k: 'data.changes', epoch, profile, changes });
  }
  // The app's data messages carry this link's epoch and profile (another's are left).
  const ours = (m: Said) => (m.epoch == null || m.epoch === epoch) && (m.profile == null || m.profile === profile);

  // ---- starting and stopping --------------------------------------------------------------
  // The page state left by the background before this one: kept while this
  // one tries the link it kept (the app may still be there), else off once
  // the first try fails.
  // Only the windows windows.getAll() lists keep what the app said of them (Safari's ids change
  // across a relaunch); none are kept while off.
  async function readPageState() {
    const got = await Promise.resolve(local().get(APP_LINK_KEY)).catch(() => null);
    const before = got?.[APP_LINK_KEY];
    const was = before && typeof before === 'object' ? String(before.state ?? '?') + (before.why ? ` (${before.why})` : '') : 'none';
    if (before && typeof before === 'object') {
      const wins = await Promise.resolve(api.windows?.getAll?.()).catch(() => null);
      const ids = Array.isArray(wins) ? new Set(wins.map((w) => String(w?.id))) : null;
      const listed = (o: unknown) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([id]) => !ids || ids.has(id)));
      const off = before.state === 'off';
      const last = before.layouts && typeof before.layouts === 'object' && Object.keys(before.layouts).length ? before.layouts : before.lastLayouts ?? {};
      pageState = { state: off ? 'off' : 'reconnecting', epoch: null, at: Date.now(), layouts: off ? {} : listed(before.layouts), drawn: off ? {} : listed(before.drawn), lastLayouts: last };
    }
    if (pageState.state !== 'off') writePageState(0);
    return was;
  }
  // The last link's end, for the start note.
  function lastStop(last: Said | null | undefined) {
    if (!last || typeof last !== 'object' || !Number.isFinite(last.at)) return 'none noted this Safari session';
    if (last.what === 'linked') return `none since linked at ${clock(last.at)} (the background before was torn down while linked)`;
    return `${last.what} at ${clock(last.at)}: ${String(last.why ?? '').slice(0, 120)}`;
  }
  async function start(options: { route: typeof route, settings?: any }) {
    route = options.route;
    settingsNow = options.settings ?? null;
    if (on || !enabled() || !isOwner()) return;
    on = true;
    await readMeta();
    const before = await readPageState();
    data?.onChanges(dataChanged);
    ensurePort();
    const [kept, last] = await Promise.all([keptLink(), Promise.resolve(session()?.get(LAST_KEY)).then((g) => g?.[LAST_KEY], () => null)]);
    note(`background started (kept link: ${kept ? 'yes' : 'no'}, page state before: ${before}, last stop: ${lastStop(last)})`);
    // The pages in front say again whether they're shown (what they said before this background
    // started is gone with the one before).
    void Promise.resolve(api.tabs.query({ active: true })).then((tabs) => { for (const t of tabs ?? []) if (Number.isInteger(t?.id)) askVisibility(t.id); }, () => {});
    pingTimer = setInterval(() => { ping(); watch(); }, T.ping);
    ping();
    await link();
  }
  function stop(why = 'turned off') {
    if (!on) return;
    on = false;
    if (ws) {
      send({ k: 'bye', why });
      drop(why);
    }
    setLast('stopped', why);
    gone();
    clearInterval(pingTimer);
    clearTimeout(askTimer);
    for (const timer of visibleNoting.values()) clearTimeout(timer);
    visibleNoting.clear();
    clearTimeout(flagsTimer);
    flagsTimer = null;
    try { port?.disconnect(); } catch {}
    port = null;
  }

  return {
    start,
    stop,
    // A page started: if the app wasn't there when last asked, asked again now.
    // A try under way: asked again once it ends (it may be waiting on an answer Safari lost).
    poke() {
      if (on && !ws && (busy || askTimer)) void link({ kept: false });
    },
    // Asked for by the person (the new-tab page's "Start Margin.app"): the
    // link asked for now, from the start of the waits (the handler starts the
    // app if it isn't running). False where there's no link to ask for.
    askNow() {
      if (!on) return false;
      if (ws) return true;
      askMs = 0;
      launches = 0;
      noLinks = 0;
      void link({ kept: false });
      return true;
    },
    // The new-tab page's Try again with the socket guard's off (a person's choice): its notes
    // cleared, sockets on, and the link asked for now.
    async retrySockets() {
      if (!on) return false;
      await Promise.all([
        Promise.resolve(local().remove([OFF_KEY, HUNG_KEY, OPENING_KEY])).catch(() => {}),
        Promise.resolve(session()?.remove(SESSION_OFF_KEY)).catch(() => {}),
      ]);
      const was = guard;
      guard = null;
      hung = null;
      note(`sockets on again: Try again chosen${was?.off ? ` (they were off since ${clock(was.at ?? Date.now())})` : ''}`);
      if (pageState.why === 'sockets-off') setWhy(undefined);
      if (ws) return true;
      askMs = 0;
      launches = 0;
      noLinks = 0;
      void link({ kept: false });
      return true;
    },
    // storage.onChanged (background.ts), for the app's copy of the state.
    onStorage(changes: Record<string, { newValue?: any, oldValue?: any }>) {
      if ('settings' in changes) {
        settingsNow = changes.settings.newValue ?? null;
        sendKeys();
      }
      if ('uiTheme' in changes) void sendTheme();
      if (!ws) {
        if ('openTabs' in changes) switchLog.delta(false); // (a switch's line ends at its stored state)
        return;
      }
      for (const key of STATE_KEYS) {
        if (!(key in changes)) continue;
        pending ??= {};
        pending[key] = 'newValue' in changes[key] ? { newValue: changes[key].newValue } : {};
      }
      if (pending) flushSoon();
    },
    // Something for one window's UI (no windowId: every window's).
    push(windowId: number | null | undefined, msg: Record<string, any>) {
      return !!ws && send({ k: 'push', epoch, windowId: windowId ?? null, msg });
    },
    // One of this copy's parked windows used while out of sight (app/HANDOFF.md §6.1): told to the
    // app, which hands off to it. `why`: 'tab' (a tab Margin didn't open made there), 'focus' (focus
    // landed there, not Margin's doing) or 'raise' (Margin's UI asked for a tab that's only there);
    // 'tab' and 'raise' name their tab. Ids only in the log.
    parkedActivity(windowId: number, why: 'tab' | 'focus' | 'raise', tabId: number | null = null) {
      if (!Number.isInteger(windowId) || windowId < 0 || !PARKED_WHY.has(why)) return false;
      if (why !== 'focus' && !Number.isInteger(tabId)) return false;
      if (!ws) return false;
      note(`parkedActivity window ${windowId}${Number.isInteger(tabId) ? ` (tab ${tabId})` : ''}: ${why}`);
      return send({ k: 'push', epoch, windowId, msg: { type: 'parkedActivity', windowId, ...(Number.isInteger(tabId) ? { tabId } : {}), why } });
    },
    // Windows opened, closed, focused, moved, a tab shown: looked at now.
    windowsChanged: () => void windowsNow(),
    // windows.onFocusChanged and onCreated, with their time. WINDOW_ID_NONE (none of this copy's
    // windows focused) is kept as the copy's `blurredAt`. Each focus is a line in Margin.app's log.
    windowFocused(windowId: number, at = Date.now()) {
      if (!Number.isInteger(windowId)) return;
      if (windowId >= 0) focusedAt.set(windowId, at);
      else blurredAt = at;
      note(`focus heard: ${windowId >= 0 ? `window ${windowId}` : 'none (WINDOW_ID_NONE)'} at ${clock(at)}`);
      void windowsNow();
    },
    windowCreated(windowId: number, at = Date.now()) {
      if (Number.isInteger(windowId) && windowId >= 0) createdAt.set(windowId, at);
      void windowsNow();
    },
    // A page in front saying where its area sits in its window (handlers.ts viewport; null: all of it).
    viewport(windowId: number, tabId: number, rect: { x: number, y: number, width: number, height: number, measured?: boolean } | null, times: { resized?: number, said?: number, heard: number } | null = null) {
      if (!Number.isInteger(windowId) || !Number.isInteger(tabId)) return;
      const had = JSON.stringify(viewports.get(windowId) ?? null);
      if (rect) viewports.set(windowId, { tabId, rect, ...(times ? { times } : {}) });
      else if (viewports.get(windowId)?.tabId === tabId || rect === null) viewports.delete(windowId);
      if (JSON.stringify(viewports.get(windowId) ?? null) === had) return;
      windowsFromKnown();
      void windowsNow();
    },
    // A page in front gone into full screen or back (handlers.ts pageFullscreen): its window's `pageFullscreen` while it's
    // that window's tab in front; Margin.app's layout leaves that window meanwhile (app/shell/Shell.swift).
    pageFullscreen(windowId: number, tabId: number, on: boolean) {
      if (!Number.isInteger(windowId) || !Number.isInteger(tabId) || typeof on !== 'boolean') return;
      const had = fullscreens.get(windowId);
      if (on) fullscreens.set(windowId, tabId);
      else if (had === tabId) fullscreens.delete(windowId);
      if (fullscreens.get(windowId) === had) return;
      windowsFromKnown();
      void windowsNow();
    },
    // A page saying whether it's shown (handlers.ts visibility), at `at` (its Date.now()): its
    // window's `visible` and `visibleAt` while it's that window's tab in front. `source`: what said
    // it ('content script', 'new-tab page' or 'unknown'), for the log.
    visibility(windowId: number, tabId: number, visible: boolean, at: number, source: string = 'unknown') {
      if (!Number.isInteger(windowId) || !Number.isInteger(tabId) || typeof visible !== 'boolean' || !Number.isFinite(at)) return;
      const had = visibility.get(tabId);
      if (had && had.windowId === windowId && had.at > at) return; // an older word than the one kept
      // The same word again (the page's visibilitychange, then its answer to reportVisibility): it has
      // said so since the first; nothing new to send.
      if (had && had.windowId === windowId && had.visible === visible) return;
      visibility.set(tabId, { windowId, visible, at: Math.min(at, Date.now()), source, heard: Date.now() });
      noteVisibility(windowId, tabId);
      if (!windowsFromKnown()) void windowsNow();
    },
    // A tab shown in its window (tabs.onActivated): what its window's tabs said is forgotten (the
    // window's is the new tab's now, and it's asked again).
    tabActivated(tabId: number, windowId: number) {
      for (const [id, v] of visibility) if (v.windowId === windowId || id === tabId) visibility.delete(id);
      // The window's tab in front is this one now, before Safari's list says so: the tab left behind
      // saying it's hidden isn't taken for the window (nor sent as its word).
      if (lastList && Number.isInteger(tabId)) lastList = lastList.map((w) => (w.windowId === windowId ? { ...w, activeTabId: tabId } : w));
      if (Number.isInteger(tabId)) askVisibility(tabId);
      void windowsNow();
    },
    // A tab's page replaced (a navigation committed, webNavigation's `timeStamp`), the tab gone,
    // replaced or moved to another window: what it said is forgotten (a new page says again).
    /** @param before only a word said before this */
    tabGone(tabId: number, before: number = Infinity) {
      const had = visibility.get(tabId);
      if (!had || had.at > before) return;
      visibility.delete(tabId);
      void windowsNow();
    },
    // A switch's timeline (background/switch-log.ts) and other lines for Margin.app's log.
    note: (...args: any[]) => note(...args),
    windowClosed(windowId: number) {
      focusedAt.delete(windowId);
      createdAt.delete(windowId);
      viewports.delete(windowId);
      fullscreens.delete(windowId);
      for (const [id, v] of visibility) if (v.windowId === windowId) visibility.delete(id);
      visibleSaid.delete(windowId);
      clearTimeout(visibleNoting.get(windowId));
      visibleNoting.delete(windowId);
      forgetWindows([String(windowId)]);
      parked.delete(windowId);
      void windowsNow();
    },
    // The window list looked at and sent now if it changed (a handoff's windows call landed: the app
    // and its overlays hear the new state without WINDOWS_MS's wait).
    windowsNow: () => windowsNow(),
    // Whether the app said it parked the window (this epoch).
    parked: (windowId: number | null | undefined) => windowId != null && parked.has(windowId),
    parkedWindows: () => [...parked.keys()],
    /** `forgot`: forgotten as a link went or came, not the app's word. */
    onParked(cb: (windowId: number, on: boolean, forgot?: boolean) => void) { parkedListeners.add(cb); return () => parkedListeners.delete(cb); },
    linked: () => !!ws,
    // 'linked', 'reconnecting' or 'off', as pages see it.
    pageState: () => pageState.state,
    layout: (windowId: number) => pageState.layouts[windowId] ?? null,
    layouts: () => ({ ...pageState.layouts }),
    // What the app said of each window, for the first paint (background/registered.ts): this
    // epoch's layouts and whether it draws each window.
    view: () => ({ epoch: pageState.epoch, layouts: { ...pageState.layouts }, drawn: { ...pageState.drawn }, lastLayouts: { ...pageState.lastLayouts } }),
    // Whether the app said it draws over the window (true, false), or hasn't said (undefined).
    drawn: (windowId: number | null | undefined) => (windowId == null ? undefined : pageState.drawn?.[windowId]),
    // Whether the app draws Margin around the window: linked or reconnecting, and not said
    // otherwise for it (shared/app-link.ts drawsWindow).
    drawsWindow: (windowId: number | null | undefined) => pageState.state !== 'off' && (windowId == null || pageState.drawn?.[windowId] !== false),
    onPageState(cb: (state: string) => void) { listeners.add(cb); return () => listeners.delete(cb); },
    onLayout(cb: (windowId: number, layout: any) => void) { layoutListeners.add(cb); return () => layoutListeners.delete(cb); },
    onDrawn(cb: (windowId: number, on: boolean) => void) { drawnListeners.add(cb); return () => drawnListeners.delete(cb); },
    profile: () => profile,
    acked: () => acked,
    rev: () => rev,
  };
}
