// The extension's end of the link to Margin.app (app/PROTOCOL.md; the app's
// end is app/shell/ExtensionLink.swift). While it's up, the app draws all of
// Margin's UI around this copy's windows (pages never draw any): pages have
// their box, which comes from the app's layout per window (setLayout).
// Safari only (platform.nativeApp), in the copy that owns its profile's state.
//
// Getting linked (the app can't open anything into the extension, and the
// extension can reach only the app's extension handler):
//  1. a lasting native port (runtime.connectNative), used at least every
//     PING_MS: Phase 0 found it keeps Safari's background page alive, which a
//     WebSocket alone doesn't (unloaded after about 30 s). What the app
//     dispatches into the extension (SFSafariApplication.dispatchMessage)
//     comes on it: { name, userInfo: { e: <JSON> } }.
//  2. wantLink { nonce } (sendNativeMessage: the handler says whether the app
//     is open and passes the nonce on);
//  3. the app's `link` with that nonce: port, token, key (others' nonces, and
//     ones Safari replays, are left);
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
//
// What pages see (storage.local appLink, shared/app-link.js): 'linked', then
// on a drop 'reconnecting' for GONE_MS (the app keeps the last picture,
// dimmed, saying it's reconnecting), and only then 'off' (pages lose their
// box: no Margin then). The app saying goodbye (it quit) is 'off' at once. Each
// window's layout is kept there too (pages new and old read it), and the
// window's page in front is told at once (`appLayout`).
//
// The background must be a page here: in a worker WebKit's `new WebSocket`
// never returns and hangs the background until Safari restarts
// (feat/native-panel, DECISIONS.md 2026-10-30). So no socket is made unless
// the background is a document (canSocket); and as there, a socket being
// opened is noted first and the note removed once the constructor returns: a
// background that finds the note left (it never got past a constructor)
// makes no socket again until another version of Margin, or Safari restarts.
//
// Data (DATA.md "Messages"): data.hello with the queue of changes made while
// unlinked; data.need → data.snapshot from the converter; the app's
// data.snapshot becomes the cache; data.changes both ways; data.ack keeps
// how far the app has stored (`acked`, with the copy's profile id, in
// storage.local `dataMeta:link`, which pages ignore).
import { platform } from '../shared/platform.js';
import { APP_LINK_KEY } from '../shared/app-link.js';
import { navigationFor } from '../shared/shortcuts.js';
import { DATA_FORMAT } from '../shared/data-merge.js';

const APP = 'io.tirth.margin';
const VERSION = 2;
export const PING_MS = 20_000; // the native port, used at least this often (Spike 3)
export const DEAD_MS = 12_000; // no tick for this long: the link is gone (app/PROTOCOL.md Liveness)
const CHECK_MS = 2000;
const LINK_WAIT_MS = 2000; // the app's `link` after wantLink
const OPEN_WAIT_MS = 2000; // a socket opening, and the app's welcome
const KEPT_WAIT_MS = 400; // the kept link, at a start
export const RECONNECT_MS = [250, 500, 1000, 2000, 4000];
export const ASK_MS = [5000, 60_000]; // asked again after this long, doubling up to the second
export const GONE_MS = 6000; // a drop not mended in this long: 'off', pages lose their box
export const LAUNCH_ASK_MS = 500; // the app being started on demand: asked again this often…
export const LAUNCH_ASKS = 20; // …this many times (10 s), then as any other time
const DELTA_MS = 16;
export const WINDOWS_MS = 1000;
const LAYOUT_WRITE_MS = 120;
export const CHUNK_BYTES = 512 * 1024;
export const SESSION_KEY = 'appLinkKept';
export const LINK_META = 'dataMeta:link'; // { profile, acked, rev? }
const OPENING_KEY = 'appLinkOpening';
const OFF_KEY = 'appLinkOff';
const SESSION_OFF_KEY = 'appLinkSessionOff';
// The stored values the app's UI draws from (as pages read them, before
// shared/stored.js fromStorage). Not the theme package (sent as `theme`), the
// data set's times, this link's own key, page zoom or user themes.
export const STATE_KEYS = ['openTabs', 'spaces', 'pins', 'folders', 'archive', 'settings', 'favicons', 'owner', 'stateRev'];
// What the app's UI may ask (ui/actions.js, shared/search.js rows,
// app/shell/Shell.swift's keys), and nothing else.
export const APP_REQUESTS = new Set([
  'activateTab', 'closeTab', 'newTab', 'pinTab', 'unpin', 'moveTabToSpace', 'moveTab', 'openPin', 'movePin',
  'setFolderOpen', 'createFolder', 'renameFolder', 'deleteFolder', 'moveFolder', 'setSpace', 'createSpace',
  'renameSpace', 'deleteSpace', 'clearToday', 'goBack', 'goForward', 'reload', 'restoreArchive', 'openLauncher',
  'newWindow', 'search', 'toggleFullscreen', 'updateSettings', 'updateThemeSettings', 'navigate', 'sidebarScroll',
  'setSidebarScroll', 'wakeSleeping', 'windowState', 'openHere', 'cancelNewTab',
  // A button of one of Margin's notices the overlay put up (background/notices.js).
  'noticeAction',
  // Margin.app's switch to another profile's space (app/shell/ProfileSwitch.swift) and its order across profiles.
  'openSpaceWindow', 'closeWindow', 'focusWindow', 'orderSpaces',
]);

const random = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${String(Math.random()).slice(2)}`;
const PROFILE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The app's keys from the settings (`keys`: app/PROTOCOL.md): each command's combinations. @param {any} settings */
export function keyBindings(settings, commandKeys = {}) {
  const nav = navigationFor(settings);
  /** @type {Record<string, string[]>} */
  const out = {};
  const add = (command, combo) => { if (combo && !(out[command] ??= []).includes(combo)) out[command].push(combo); };
  const names = { nextTab: 'next-tab', prevTab: 'prev-tab', nextSpace: 'next-space', prevSpace: 'prev-space' };
  for (const [name, command] of Object.entries(names)) {
    add(command, nav[name]);
    add(command, commandKeys[name]); // Safari's manifest commands' keys (⌃⌘ + arrows) too, as pages take them
  }
  add('palette', 'Meta+KeyT');
  add('toggle-sidebar', settings?.sidebarShortcut ?? 'Alt+KeyS');
  return out;
}

/** UTF-8 bytes of a theme package, cut into `theme` pieces (app/PROTOCOL.md Chunks). @param {any} pkg @param {(bytes: Uint8Array) => Promise<string>} sha256 */
export async function themePieces(pkg, sha256, chunkBytes = CHUNK_BYTES) {
  const whole = new TextEncoder().encode(JSON.stringify(pkg));
  const transfer = await sha256(whole);
  const parts = Math.max(1, Math.ceil(whole.length / chunkBytes));
  const out = [];
  for (let part = 0; part < parts; part++) {
    const piece = whole.subarray(part * chunkBytes, (part + 1) * chunkBytes);
    let bin = '';
    for (let i = 0; i < piece.length; i += 0x8000) bin += String.fromCharCode.apply(null, /** @type {any} */ (piece.subarray(i, i + 0x8000)));
    out.push({ k: 'theme', id: pkg.id, transfer, part, parts, size: whole.length, data: btoa(bin) });
  }
  return out;
}
const webSha256 = async (/** @type {Uint8Array} */ bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', /** @type {any} */ (bytes)))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * @param {{
 *   api: any,
 *   isOwner: () => boolean,
 *   copy: () => { origin: string, since: number },
 *   instanceId?: string,
 *   WebSocket?: any,
 *   enabled?: () => boolean,
 *   canSocket?: () => boolean,
 *   data?: { pendingQueue: (since: number) => Promise<any[]>, snapshot: () => Promise<any>, adopt: (set: any, options?: { changes?: any[], omitted?: any[] }) => Promise<unknown>, take: (changes: any[]) => Promise<unknown>, onChanges: (cb: (changes: any[]) => void) => unknown },
 *   theme?: () => Promise<any>,
 *   commandKeys?: () => Record<string, string>,
 *   log?: (...args: any[]) => void,
 *   sha256?: (bytes: Uint8Array) => Promise<string>,
 *   timing?: Partial<{ ping: number, dead: number, check: number, linkWait: number, openWait: number, keptWait: number, reconnect: number[], ask: number[], gone: number, windows: number, layoutWrite: number, launchAsk: number, launchAsks: number }>,
 * }} deps
 */
export function createLink({
  api,
  isOwner,
  copy,
  instanceId = null,
  WebSocket: Socket = globalThis.WebSocket,
  enabled = () => !!platform?.nativeApp && typeof api.runtime?.connectNative === 'function' && typeof Socket === 'function',
  canSocket = () => typeof globalThis.document === 'object' && typeof (/** @type {any} */ (globalThis)).WorkerGlobalScope === 'undefined',
  data = null,
  theme = async () => null,
  commandKeys = () => ({}),
  log = (...args) => console.info('[margin] link:', ...args),
  sha256 = webSha256,
  timing = {},
}) {
  const T = {
    ping: PING_MS, dead: DEAD_MS, check: CHECK_MS, linkWait: LINK_WAIT_MS, openWait: OPEN_WAIT_MS, keptWait: KEPT_WAIT_MS,
    reconnect: RECONNECT_MS, ask: ASK_MS, gone: GONE_MS, windows: WINDOWS_MS, layoutWrite: LAYOUT_WRITE_MS, launchAsk: LAUNCH_ASK_MS, launchAsks: LAUNCH_ASKS, ...timing,
  };
  // What the link does, in the background's console and, through the lasting
  // native port, in Margin.app's own log (the extension handler writes it to
  // the system log: subsystem io.tirth.margin, category extension), so a link
  // that fails can be read in one place. The same line again within a minute
  // isn't sent again.
  /** @type {Map<string, number>} */
  const sentLines = new Map();
  const note = (/** @type {any[]} */ ...args) => {
    log(...args);
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 300);
    const now = Date.now();
    if ((sentLines.get(line) ?? -Infinity) > now - 60_000) return;
    sentLines.set(line, now);
    if (sentLines.size > 50) sentLines.delete(sentLines.keys().next().value);
    try {
      port?.postMessage({ type: 'log', line });
    } catch {
      // no port (yet): the console has it
    }
  };
  /** @type {(message: any, sender: any) => Promise<any>} */
  let route = async () => ({ ok: false, error: 'not started' });
  let on = false;
  let port = null;
  let ws = null;
  let epoch = null;
  let seq = 0;
  let nonce = null;
  let linkWaiter = null;
  let busy = null;
  let askMs = 0;
  let askTimer = null;
  let lastHeard = 0;
  let timers = [];
  let pingTimer = null;
  let pending = null;
  let pendingTimer = null;
  let sentIcons = null;
  let lastWindows = '';
  let lastKeys = '';
  let lastTheme = '';
  let snapshotting = null;
  let appUp = false;
  let socketsOff = null;
  let toldWorker = false;
  // What pages see (storage.local appLink).
  let pageState = { state: 'off', epoch: null, at: 0, layouts: {} };
  let goneTimer = null;
  let layoutTimer = null;
  let stateWrite = Promise.resolve();
  let profile = null;
  let acked = 0;
  // The app's set's revision this copy's cache matches (DATA.md "Revisions"): a
  // string, compared only for being the same; null when it has none.
  /** @type {string | null} */
  let rev = null;
  let dataQueue = Promise.resolve();
  const inOrder = (fn) => { dataQueue = dataQueue.then(fn).catch((err) => note('the app\'s data not taken:', err?.message ?? err)); };
  const local = () => api.storage.local;
  const session = () => api.storage?.session;
  const listeners = new Set();

  const send = (/** @type {any} */ message) => {
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
  function setPageState(state) {
    if (state === pageState.state && pageState.epoch === epoch) return;
    const changed = state !== pageState.state;
    pageState = { ...pageState, state, epoch, at: Date.now() };
    if (changed) for (const cb of [...listeners]) cb(state);
    writePageState(0);
  }
  function writePageState(ms) {
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
  }

  // ---- the native port --------------------------------------------------------
  function ensurePort() {
    if (port) return port;
    try {
      port = api.runtime.connectNative(APP);
    } catch {
      return (port = null);
    }
    const mine = port;
    port.onMessage?.addListener((m) => onNative(m));
    port.onDisconnect?.addListener(() => { if (port === mine) port = null; });
    return port;
  }
  function ping() {
    try {
      ensurePort()?.postMessage({ type: 'ping', at: Date.now() });
    } catch {
      port = null;
    }
  }
  function onNative(message) {
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
      void link({ kept: false });
    }
  }

  // ---- getting linked ---------------------------------------------------------
  const validLink = (l) => Number.isInteger(l?.port) && l.port > 0 && l.port < 65536 && typeof l.token === 'string' && !!l.token && typeof l.key === 'string' && !!l.key;
  async function keptLink() {
    const got = await Promise.resolve(session()?.get(SESSION_KEY)).catch(() => null);
    return validLink(got?.[SESSION_KEY]) ? got[SESSION_KEY] : null;
  }
  function link({ kept = true } = {}) {
    if (!on || ws) return Promise.resolve(!!ws);
    clearTimeout(askTimer);
    askTimer = null;
    return (busy ??= (async () => {
      try {
        if (kept && !appUp) {
          const k = await keptLink();
          if (k && (await open(k, T.keptWait))) return true;
        }
        return await ask();
      } finally {
        busy = null;
      }
    })());
  }
  async function ask() {
    if (!on) return false;
    if (noSocketHere() || (await noSockets())) return failed();
    appUp = false;
    nonce = random();
    const answer = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), T.linkWait);
      linkWaiter = (value) => { clearTimeout(timer); resolve(value); };
    });
    ensurePort(); // the link comes on it
    let reply = null;
    try {
      reply = await api.runtime.sendNativeMessage(APP, { type: 'wantLink', nonce });
    } catch (err) {
      reply = null;
      note('wantLink: the extension handler didn\'t answer:', String(err?.message ?? err));
    }
    await takeProfile(reply?.profile);
    if (reply?.appOpen !== true || !on) {
      linkWaiter?.(null);
      linkWaiter = null;
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
    const got = await answer;
    linkWaiter = null;
    if (!got || !on) {
      if (on) note(`wantLink: Margin.app is running but sent no link within ${T.linkWait} ms`);
      return failed();
    }
    if (await open(got, T.openWait)) return true;
    note(`the link on port ${got.port} didn't open within ${T.openWait} ms`);
    return failed();
  }
  // No app to link to: asked again later (and when a page starts, or the app
  // says it's up). Pages lose their box once it's clear.
  let launches = 0;
  function failed({ appGone = false, launching = false } = {}) {
    if (appGone) gone();
    else if (pageState.state !== 'off' && !goneTimer) dropping();
    // Starting: every LAUNCH_ASK_MS for a while (its appUp may come first).
    if (launching && launches++ < T.launchAsks) askMs = T.launchAsk;
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
  // Whether sockets were given up on: a background before this one never got
  // past opening one (the note was left): off until another version of
  // Margin, or (the session's note) until Safari restarts.
  async function noSockets() {
    if (socketsOff !== null) return socketsOff;
    const [kept, got] = await Promise.all([
      Promise.resolve(local().get([OPENING_KEY, OFF_KEY])).catch(() => null),
      Promise.resolve(session()?.get(SESSION_OFF_KEY)).catch(() => null),
    ]);
    const off = kept?.[OFF_KEY];
    if (off && off.v === version()) {
      note(`off since ${new Date(off.at).toISOString()}: a socket being opened never finished (${off.why})`);
      return (socketsOff = true);
    }
    if (got?.[SESSION_OFF_KEY]) return (socketsOff = true);
    if (kept?.[OPENING_KEY]) {
      const why = 'a socket being opened was never finished: the constructor hung, or Safari quit just then';
      note(`${why}; no link until another version of Margin`);
      await Promise.resolve(local().set({ [OFF_KEY]: { at: Date.now(), why, v: version() } })).catch(() => {});
      await Promise.resolve(local().remove(OPENING_KEY)).catch(() => {});
      await Promise.resolve(session()?.set({ [SESSION_OFF_KEY]: true })).catch(() => {});
      return (socketsOff = true);
    }
    return (socketsOff = false);
  }
  async function open(kept, waitMs) {
    if (noSocketHere() || (await noSockets())) return false;
    await Promise.resolve(local().set({ [OPENING_KEY]: { at: Date.now(), v: version() } })).catch(() => {});
    let socket = null;
    try {
      socket = new Socket(`ws://127.0.0.1:${kept.port}/?t=${encodeURIComponent(kept.token)}`);
    } catch {
      socket = null;
    }
    void Promise.resolve(local().remove(OPENING_KEY)).catch(() => {});
    return socket ? follow(socket, kept, waitMs) : false;
  }
  // Until it's open and the app has said who it is (or not, in `waitMs`).
  function follow(socket, kept, waitMs) {
    return new Promise((resolve) => {
      let welcomed = false;
      const giveUp = () => {
        clearTimeout(timer);
        try { socket.close(); } catch {}
        resolve(false);
      };
      const timer = setTimeout(() => { if (!welcomed) giveUp(); }, waitMs);
      socket.onopen = () => { if (!on || ws) giveUp(); };
      socket.onerror = () => {};
      socket.onclose = () => {
        clearTimeout(timer);
        if (!welcomed) return resolve(false);
        if (ws === socket) dropped('closed');
      };
      socket.onmessage = (event) => {
        if (welcomed) {
          if (ws === socket) onApp(event.data);
          return;
        }
        if (!on || ws) return giveUp();
        let m = null;
        try { m = JSON.parse(String(event.data)); } catch {}
        if (m?.k !== 'welcome' || m.v !== VERSION || m.key !== kept.key) {
          note('what answered on', kept.port, 'isn\'t Margin.app; that link is forgotten');
          void forget(kept);
          return giveUp();
        }
        welcomed = true;
        clearTimeout(timer);
        linked(socket, kept);
        resolve(true);
      };
    });
  }
  async function forget(kept) {
    const got = await Promise.resolve(session()?.get(SESSION_KEY)).catch(() => null);
    if (got?.[SESSION_KEY]?.token === kept.token) await Promise.resolve(session()?.remove(SESSION_KEY)).catch(() => {});
  }

  // ---- linked ------------------------------------------------------------------
  function linked(socket, { port: at, token, key }) {
    ws = socket;
    epoch = random();
    seq = 0;
    lastHeard = Date.now();
    askMs = 0;
    launches = 0;
    lastWindows = '';
    lastKeys = '';
    lastTheme = '';
    clearTimeout(goneTimer);
    goneTimer = null;
    void Promise.resolve(session()?.set({ [SESSION_KEY]: { port: at, token, key } })).catch(() => {});
    const { origin, since } = copy();
    send({ k: 'hello', v: VERSION, epoch, profile, browser: platform?.name === 'chrome' ? 'chrome' : 'safari', owner: isOwner(), ext: version(), instanceId, origin, since });
    setPageState('linked');
    void (async () => {
      const at0 = epoch;
      await snapshot();
      if (epoch !== at0) return;
      await sendTheme();
      sendKeys();
      await dataHello();
    })();
    timers = [
      setInterval(() => {
        if (!isOwner()) return stop('a newer copy of Margin is running');
        if (Date.now() - lastHeard > T.dead) drop('no word from the app for 12 s');
      }, T.check),
      setInterval(() => void windowsNow(), T.windows),
    ];
    note('linked on', at);
  }
  function drop(why) {
    const socket = ws;
    if (!socket) return;
    dropped(why);
    try { socket.close(1000, why); } catch {}
  }
  // `bye`: the app said goodbye (it quit): pages lose their box at once, and
  // the app is asked for later. Else a drop: tried again.
  function dropped(why, { bye = false } = {}) {
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
    if (busy) return busy;
    busy = (async () => {
      try {
        for (const ms of T.reconnect) {
          await new Promise((resolve) => setTimeout(resolve, ms));
          if (!on || ws) return !!ws;
          const kept = appUp ? null : await keptLink();
          if (!kept) break;
          if (await open(kept, T.openWait)) return true;
        }
        return on && !ws ? await ask() : !!ws;
      } finally {
        busy = null;
      }
    })();
    return busy;
  }

  // ---- what the app says -----------------------------------------------------------
  function onApp(text) {
    let message;
    try {
      message = JSON.parse(String(text));
    } catch {
      return;
    }
    lastHeard = Date.now();
    switch (message?.k) {
      case 'tick':
        return void send({ k: 'tock', at: Date.now() });
      case 'req':
        return void request(message);
      case 'setLayout':
        return setLayout(message);
      case 'resync':
        if (message.epoch === epoch) void snapshot();
        return;
      case 'bye': {
        const socket = ws;
        note('the app said goodbye:', message.why);
        dropped(`bye (${message.why})`, { bye: true });
        try { socket?.close(); } catch {}
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
  async function request({ id, epoch: theirs, windowId, type, payload }) {
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
  function setLayout(m) {
    if (m.epoch !== epoch || !Number.isInteger(m.windowId) || !m.insets || !Number.isInteger(m.seq)) return;
    const had = pageState.layouts[m.windowId];
    if (had && had.epoch === m.epoch && had.seq >= m.seq) return;
    const layout = { insets: m.insets, radius: m.radius ?? 0, radii: m.radii ?? null, container: m.container ?? null, mode: m.mode ?? 'fullscreen', seq: m.seq, epoch: m.epoch };
    pageState = { ...pageState, layouts: { ...pageState.layouts, [m.windowId]: layout } };
    writePageState(T.layoutWrite);
    for (const cb of [...layoutListeners]) cb(m.windowId, layout);
  }
  const layoutListeners = new Set();

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
      send({ k: 'snapshot', epoch, seq: ++seq, state: raw, windows });
    })();
    snapshotting = run;
    await run.catch(() => {});
    if (snapshotting === run) snapshotting = null;
    if (pending && !pendingTimer) flushSoon();
  }
  const iconsOf = (favicons) => new Map(Object.entries(favicons ?? {}).map(([origin, entry]) => [origin, JSON.stringify(entry)]));
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
    /** @type {any} */
    const message = { k: 'delta', epoch, seq: 0, changes: {} };
    for (const [key, change] of Object.entries(changes)) {
      if (key !== 'favicons') message.changes[key] = 'newValue' in change ? { newValue: change.newValue } : {};
    }
    if ('favicons' in changes) {
      const now = iconsOf(changes.favicons.newValue);
      const set = {};
      const del = [];
      for (const [origin, json] of now) if (sentIcons?.get(origin) !== json) set[origin] = changes.favicons.newValue[origin];
      for (const origin of sentIcons?.keys() ?? []) if (!now.has(origin)) del.push(origin);
      sentIcons = now;
      if (Object.keys(set).length || del.length) message.favicons = { set, del };
    }
    if (!Object.keys(message.changes).length && !message.favicons) return;
    message.seq = ++seq;
    send(message);
  }
  async function windowList() {
    const [wins, fronts] = await Promise.all([
      Promise.resolve(api.windows?.getAll?.()).catch(() => null),
      Promise.resolve(api.tabs.query({ active: true })).catch(() => []),
    ]);
    return (wins ?? []).filter((w) => w?.id != null).map((w) => ({
      windowId: w.id, left: w.left ?? 0, top: w.top ?? 0, width: w.width ?? 0, height: w.height ?? 0,
      state: w.state ?? 'normal', focused: !!w.focused, activeTabId: (fronts ?? []).find((t) => t.windowId === w.id)?.id ?? null,
      ...(focusedAt.has(w.id) ? { focusedAt: focusedAt.get(w.id) } : {}),
      ...(createdAt.has(w.id) ? { createdAt: createdAt.get(w.id) } : {}),
    }));
  }
  // When this copy heard each of its windows focused and created (Date.now(), the app's clock too): the
  // app tells same-bounds windows apart by them (app/shell/WindowMatcher.swift). Not kept past the background.
  /** @type {Map<number, number>} */
  const focusedAt = new Map();
  /** @type {Map<number, number>} */
  const createdAt = new Map();
  // Sent when any of it changed; a closed window's layout goes too.
  async function windowsNow() {
    if (!ws || snapshotting) return;
    const at = epoch;
    const list = await windowList();
    if (!ws || epoch !== at) return;
    const ids = new Set(list.map((w) => w.windowId));
    const left = Object.keys(pageState.layouts).filter((id) => !ids.has(Number(id)));
    if (left.length) {
      const layouts = { ...pageState.layouts };
      for (const id of left) delete layouts[id];
      pageState = { ...pageState, layouts };
      writePageState(T.layoutWrite);
    }
    const json = JSON.stringify(list);
    if (json === lastWindows) return;
    lastWindows = json;
    send({ k: 'windows', epoch, seq: ++seq, list });
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
  let settingsNow = null;
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
    const meta = got?.[LINK_META];
    if (meta && typeof meta.profile === 'string' && PROFILE.test(meta.profile)) {
      profile = meta.profile;
      acked = Number.isFinite(meta.acked) ? meta.acked : 0;
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
  async function takeProfile(id) {
    if (typeof id !== 'string' || !PROFILE.test(id) || id === profile) return;
    profile = id;
    acked = 0;
    rev = null;
    await writeMeta();
  }
  const writeMeta = () => Promise.resolve(isOwner() ? local().set({ [LINK_META]: { profile, acked, ...(rev ? { rev } : {}) } }) : null).catch(() => {});
  // `upTo` kept as acked (never lower); a `rev`, when the ack has one.
  async function takeAck(m) {
    let changed = false;
    if (Number.isFinite(m.upTo) && m.upTo > acked) [acked, changed] = [m.upTo, true];
    if (typeof m.rev === 'string' && m.rev && m.rev !== rev) [rev, changed] = [m.rev, true];
    if (changed) await writeMeta();
  }
  // This copy's changes since its last data.hello: merged on top of a
  // snapshot from the app that crosses them (DATA.md "For the extension's end").
  let sinceHello = [];
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
  let parts = null;
  async function takeSnapshot(m) {
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
    for (const piece of parts.got.values()) for (const [c, list] of Object.entries(piece?.items ?? {})) items[c] = { ...(items[c] ?? {}), ...(list && typeof list === 'object' ? list : {}) };
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
  function dataChanged(changes) {
    if (!ws || !changes.length) return;
    sinceHello.push(...changes);
    if (sinceHello.length > 5000) sinceHello = sinceHello.slice(-5000);
    send({ k: 'data.changes', epoch, profile, changes });
  }
  // The app's data messages carry this link's epoch and profile (another's are left).
  const ours = (m) => (m.epoch == null || m.epoch === epoch) && (m.profile == null || m.profile === profile);

  // ---- starting and stopping --------------------------------------------------------------
  // The page state left by the background before this one: kept while this
  // one tries the link it kept (the app may still be there), else off once
  // the first try fails.
  async function readPageState() {
    const got = await Promise.resolve(local().get(APP_LINK_KEY)).catch(() => null);
    const before = got?.[APP_LINK_KEY];
    if (before && typeof before === 'object') pageState = { state: before.state === 'off' ? 'off' : 'reconnecting', epoch: null, at: Date.now(), layouts: before.layouts ?? {} };
    if (pageState.state !== 'off') writePageState(0);
  }
  /** @param {{ route: typeof route, settings?: any }} options */
  async function start(options) {
    route = options.route;
    settingsNow = options.settings ?? null;
    if (on || !enabled() || !isOwner()) return;
    on = true;
    await readMeta();
    await readPageState();
    data?.onChanges(dataChanged);
    ensurePort();
    pingTimer = setInterval(ping, T.ping);
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
    gone();
    clearInterval(pingTimer);
    clearTimeout(askTimer);
    try { port?.disconnect(); } catch {}
    port = null;
  }

  return {
    start,
    stop,
    // A page started: if the app wasn't there when last asked, asked again now.
    poke() {
      if (on && !ws && !busy && askTimer) void link({ kept: false });
    },
    // Asked for by the person (the new-tab page's "Start Margin.app"): the
    // link asked for now, from the start of the waits (the handler starts the
    // app if it isn't running). False where there's no link to ask for.
    askNow() {
      if (!on) return false;
      if (ws) return true;
      askMs = 0;
      launches = 0;
      void link({ kept: false });
      return true;
    },
    // storage.onChanged (background.js), for the app's copy of the state.
    onStorage(changes) {
      if ('settings' in changes) {
        settingsNow = changes.settings.newValue ?? null;
        sendKeys();
      }
      if ('uiTheme' in changes) void sendTheme();
      if (!ws) return;
      for (const key of STATE_KEYS) {
        if (!(key in changes)) continue;
        pending ??= {};
        pending[key] = 'newValue' in changes[key] ? { newValue: changes[key].newValue } : {};
      }
      if (pending) flushSoon();
    },
    // Something for one window's UI (no windowId: every window's).
    push(windowId, msg) {
      return !!ws && send({ k: 'push', epoch, windowId: windowId ?? null, msg });
    },
    // Windows opened, closed, focused, moved, a tab shown: looked at now.
    windowsChanged: () => void windowsNow(),
    // windows.onFocusChanged (WINDOW_ID_NONE: the browser left the front, nothing noted) and onCreated, with their time.
    windowFocused(windowId, at = Date.now()) {
      if (Number.isInteger(windowId) && windowId >= 0) focusedAt.set(windowId, at);
      void windowsNow();
    },
    windowCreated(windowId, at = Date.now()) {
      if (Number.isInteger(windowId) && windowId >= 0) createdAt.set(windowId, at);
      void windowsNow();
    },
    windowClosed(windowId) {
      focusedAt.delete(windowId);
      createdAt.delete(windowId);
      if (pageState.layouts[windowId]) {
        const layouts = { ...pageState.layouts };
        delete layouts[windowId];
        pageState = { ...pageState, layouts };
        writePageState(T.layoutWrite);
      }
      void windowsNow();
    },
    linked: () => !!ws,
    // 'linked', 'reconnecting' or 'off', as pages see it.
    pageState: () => pageState.state,
    layout: (windowId) => pageState.layouts[windowId] ?? null,
    layouts: () => ({ ...pageState.layouts }),
    /** @param {(state: string) => void} cb */
    onPageState(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    /** @param {(windowId: number, layout: any) => void} cb */
    onLayout(cb) { layoutListeners.add(cb); return () => layoutListeners.delete(cb); },
    profile: () => profile,
    acked: () => acked,
    rev: () => rev,
  };
}
