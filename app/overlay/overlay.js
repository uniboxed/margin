// The page in each of Margin.app's overlays (app/shell/Overlay.swift): the
// UI runtime (extension/ui/runtime.js) drawing the theme around the page
// slot over one browser window, with the app's host
// (extension/ui/host-app.js). Built into dist/app/overlay.js (scripts/
// build.js), served at margin-app://app/ with a policy that allows no
// network (app/shell/OverlayWebView.swift).
//
// It asks the app for its window, the state and the theme (`hello`), draws,
// says it's drawn (`ready`: the app shows the overlay only then), and from
// then on tells the app where the page slot is (`layout`, through the host),
// what the theme draws over it that takes the pointer (`hits`), and when a
// text field of Margin's has the keyboard (`focus`: the overlay becomes a
// key panel without making Margin the active app). It says what the copy
// tells it about the window's pages (ui/app-feedback.js): Margin's notices,
// in the theme's guarded notice part, their buttons going back to the copy;
// the trackpad gestures' feedback; which tabs are loading (through the host).
import { createRuntime } from '../../extension/ui/runtime.js';
import { loadTheme } from '../../extension/ui/theme-loader.js';
import { createAppHost, hitRects } from '../../extension/ui/host-app.js';
import { createAppNotices, createGestureFeedback } from '../../extension/ui/app-feedback.js';
import { backgroundSwitches } from '../../extension/shared/switching.js';

const bridge = /** @type {any} */ (globalThis).webkit?.messageHandlers?.margin;
/** @param {string} op @param {Record<string, any>} [body] */
const post = (op, body = {}) => (bridge ? bridge.postMessage({ op, ...body }) : Promise.reject(new Error('no app')));
/** @param {'note' | 'warn' | 'error'} level @param {...any} args */
const log = (level, ...args) => { void post('log', { level, text: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') }).catch(() => {}); };

/** @type {ReturnType<typeof createAppHost> | null} */
let host = null;
/** @type {ReturnType<typeof createRuntime> | null} */
let runtime = null;
/** @type {any} */
let theme = null;
let saidReady = false;
let mounting = Promise.resolve();
// Margin's notices and the gestures' feedback, kept here: a runtime made
// again (another theme) shows them as they are.
const notices = createAppNotices({
  show: (notice) => runtime?.setUi({ notice }),
  send: (type, payload) => host?.send(type, payload),
  frontTab: () => host?.frontTabId ?? null,
});
const gestures = createGestureFeedback({ set: (gesture) => runtime?.setUi({ gesture }) });
// The copy's own switches in this window ('switching', then 'switch-done' or 'switch-failed').
const copySwitches = backgroundSwitches();

// ---- what took long here (Margin.app's log: npm run log:app) --------------------------
// Lasting and quiet: a piece of work over SLOW_MS (the app's word handled, a
// measure of the slot or of what's over it), a key or a press not drawn
// within SLOW_MS, and WebKit's own long tasks where it reports them, each
// with what caused it; the same kind at most once every SAY_EVERY_MS (with
// how many more there were). Each palette opening is one line: how long its
// drawing took. `marginApp.stats()` has the counts (the app's tests read it).
const SLOW_MS = 50;
const SAY_EVERY_MS = 10_000;
const stats = { slow: 0, hits: 0, hitsMs: 0, hitsMaxMs: 0, measures: 0, measureMs: 0, received: 0, receivedMs: 0, receivedMaxMs: 0, pointers: 0, inputMaxMs: 0, palette: /** @type {any[]} */ ([]) };
const saidAt = new Map();
const unsaid = new Map();
/** @param {string} what @param {number} ms @param {string} cause */
function slow(what, ms, cause) {
  stats.slow++;
  const now = Date.now();
  if (now - (saidAt.get(what) ?? -Infinity) < SAY_EVERY_MS) return void unsaid.set(what, (unsaid.get(what) ?? 0) + 1);
  const more = unsaid.get(what) ?? 0;
  unsaid.delete(what);
  saidAt.set(what, now);
  log('note', `slow: ${what} took ${Math.round(ms)} ms (${cause})${more ? `; ${more} more since the last line` : ''}`);
}
/** @template T @param {string} what @param {() => string} cause @param {() => T} fn @returns {T} */
function timed(what, cause, fn) {
  const from = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - from;
    if (ms > SLOW_MS) slow(what, ms, cause());
  }
}
// A key or a press until the frame after it: what the person feels.
for (const type of ['keydown', 'pointerdown']) {
  document.addEventListener(type, (e) => {
    const start = e.timeStamp;
    requestAnimationFrame(() => {
      const ms = performance.now() - start;
      stats.inputMaxMs = Math.max(stats.inputMaxMs, ms);
      if (ms > SLOW_MS) slow(`a ${type === 'keydown' ? 'key' : 'press'} until drawn`, ms, type === 'keydown' ? (runtime?.paletteOpen ? 'typing in the palette' : 'a key') : 'a press');
    });
  }, { capture: true, passive: true });
}
try {
  if (globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) slow('a task', e.duration, e.name || 'not known'); }).observe({ entryTypes: ['longtask'] });
  }
} catch {}

const decode = (/** @type {string} */ text) => { const bin = atob(text); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const nextFrame = () => new Promise((resolve) => { const t = setTimeout(resolve, 100); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); resolve(undefined); })); });

// ---- what the theme draws over the page slot ------------------------------------------

let hitsQueued = false;
let lastHits = '';
function reportHits() {
  hitsQueued = false;
  const root = runtime?.view.rootElement();
  const geometry = host?.layout;
  if (!root || !geometry) return;
  const { insets, container } = geometry;
  const slot = { left: insets.left, top: insets.top, right: container.width - insets.right, bottom: container.height - insets.bottom };
  const from = performance.now();
  const { rects, all } = timed('measuring what is over the page', () => `${root.getElementsByTagName('*').length} elements`, () => hitRects(root, slot));
  const ms = performance.now() - from;
  stats.hits++;
  stats.hitsMs += ms;
  stats.hitsMaxMs = Math.max(stats.hitsMaxMs, ms);
  const key = JSON.stringify([rects, all]);
  if (key === lastHits) return;
  lastHits = key;
  void post('hits', { rects, all }).catch(() => {});
}
function hitsSoon() {
  if (hitsQueued) return;
  hitsQueued = true;
  requestAnimationFrame(reportHits);
  setTimeout(() => { if (hitsQueued) reportHits(); }, 50); // no frames while the overlay is off screen
}
// The page slot measured after every change, not only at the runtime's own
// animation frame (ui/render.js scheduleLayout): a window off screen, or
// hidden, gets no frames, and the page box must follow the theme at once.
let lastLayout = '';
function measureNow() {
  const from = performance.now();
  const g = timed('measuring the page slot', () => 'after a change', () => runtime?.measure());
  stats.measures++;
  stats.measureMs += performance.now() - from;
  if (!g || !host) return;
  const key = JSON.stringify([g.insets, g.radius, g.container]);
  if (key === lastLayout) return;
  lastLayout = key;
  host.reportLayout({ ...g, windowId: host.windowId, mode: host.mode });
}
// Which pointer positions the app hands in (runtime.pointer: only peek uses
// them): none while the sidebar is docked (nothing to bring out), those in
// the reveal zone of the theme's peek edges while it's hidden, all of them
// while it's out over the page (to put it away once the pointer leaves).
// Told to the app when it changes (app/shell/Shell.swift pointerMoved).
let lastWant = '';
function reportWant() {
  const vm = runtime?.vm;
  if (!vm) return;
  const edges = runtime?.view.marked('m-peek').map((el) => runtime?.view.behaviorOf(el)?.attrs?.['m-peek']).filter((e) => typeof e === 'string') ?? [];
  const mode = vm.window.sidebar === 'peek' ? 'all' : vm.window.sidebar === 'hidden' && edges.length ? 'edges' : 'none';
  const want = { mode, edges: [...new Set(edges)].sort(), zone: REVEAL_ZONE_MAX };
  const key = JSON.stringify(want);
  if (key === lastWant) return;
  lastWant = key;
  void post('pointerWant', want).catch(() => {});
}
// The widest reveal zone (shared/view.js revealZone: 24 px in full screen); peek checks the exact one.
const REVEAL_ZONE_MAX = 24;
const watcher = new MutationObserver(() => { hitsSoon(); queueMicrotask(measureNow); queueMicrotask(reportWant); });
addEventListener('resize', () => { measureNow(); hitsSoon(); });

// ---- the theme --------------------------------------------------------------------------

/** @param {any} pkg the theme package (background/theme-package.js ThemeMessage) */
async function mount(pkg) {
  if (!host || !pkg || typeof pkg !== 'object' || typeof pkg.id !== 'string') return;
  const files = Object.fromEntries(Object.entries(pkg.files ?? {}).map(([p, b64]) => [p, decode(String(b64))]));
  const loaded = await loadTheme({ manifest: pkg.manifest, html: pkg.html, css: pkg.css, files }, { document, settings: host.getState()?.settings?.themes?.[pkg.id] ?? null });
  if (!loaded.ok) return log('error', `theme ${pkg.id} refused:`, /** @type {any} */ (loaded).report.errors);
  const keep = { ...(runtime ? { palette: runtime.ui.palette } : {}), notice: notices.view(), gesture: gestures.shown };
  watcher.disconnect();
  runtime?.destroy();
  theme?.unload?.();
  theme = loaded;
  runtime = createRuntime({
    host, theme, container: document, ui: keep, onWarn: (message) => log('warn', message),
    // A switch asked for here that didn't happen: why, as a notice (its request's error).
    onSwitchFailed: () => { notices.switchFailed(host?.takeFailure()?.error); },
  });
  const root = runtime.view.rootElement();
  // The pointer over the page slot is the page's (the app lets it through); what the theme draws there keeps it.
  root?.setAttribute('m-passthrough', '');
  if (root) watcher.observe(root, { subtree: true, childList: true, attributes: true, characterData: false });
  lastHits = '';
  lastLayout = '';
  lastWant = '';
  measureNow();
  hitsSoon();
  reportWant();
  if (!saidReady && host.getState()) {
    await nextFrame();
    saidReady = true;
    void post('ready').catch(() => {});
  }
}

// The palette opened: drawn how long after the word came (work, then frames until it's on screen), one line each time.
/** @param {{ newTab: boolean }} options @param {string} by */
function openPaletteTimed(options, by) {
  if (!runtime) return;
  const from = performance.now();
  runtime.openPalette(options);
  // Its style and layout worked out now (what the next frame would do first).
  document.querySelector('.palette-layer, [m-input="palette"]')?.getBoundingClientRect();
  const workMs = performance.now() - from;
  let frames = 0;
  let said = false;
  const say = (/** @type {number | null} */ drawnMs) => {
    if (said) return;
    said = true;
    const round = (/** @type {number} */ n) => Math.round(n * 10) / 10;
    const entry = { by, workMs: round(workMs), drawnMs: drawnMs == null ? null : round(drawnMs), field: document.activeElement?.localName === 'input' };
    stats.palette.push(entry);
    if (stats.palette.length > 20) stats.palette.shift();
    const drawn = entry.drawnMs == null ? 'no frame drawn within 500 ms (the overlay off screen?)' : `drawn ${entry.drawnMs} ms after the word`;
    log('note', `palette opened (${by}): ${drawn}, ${entry.workMs} ms of work, its field ${entry.field ? 'focused' : 'not focused'}`);
  };
  const frame = () => {
    if (++frames < 2) return void requestAnimationFrame(frame);
    say(performance.now() - from);
  };
  requestAnimationFrame(frame);
  setTimeout(() => say(null), 500);
}

// ---- what the app sends -------------------------------------------------------------------

/** @param {any} msg */
function onMessage(msg) {
  switch (msg.type) {
    case 'theme':
      pendingTheme = msg.theme;
      if (host?.getState()) mounting = mounting.then(() => mount(msg.theme));
      return;
    case 'command':
      // The app's keys (app/shell/Shortcuts.swift, following the Settings shortcuts).
      if (msg.name === 'palette') {
        if (runtime?.paletteOpen) runtime.closePalette();
        else openPaletteTimed({ newTab: !host?.launcher }, 'the app\'s key');
      } else if (msg.name === 'toggle-sidebar') runtime?.sidebar.toggle();
      return;
    case 'link':
      // The link to the copy dropped (`reconnecting`: the last picture stays,
      // dimmed, saying so, until it's back or the app closes the overlay) or came back.
      setReconnecting(msg.state === 'reconnecting');
      return;
    case 'pointer':
      runtime?.pointer({ x: Number(msg.x), y: Number(msg.y) });
      return;
    case 'pointerLeft':
      runtime?.pointerLeft({ x: Number(msg.x), y: Number(msg.y) });
      return;
    case 'pressOutside':
      // A press on the page or another app: the palette goes, the field lets go of the keyboard.
      runtime?.closePalette();
      /** @type {any} */ (document.activeElement)?.blur?.();
      return;
    case 'push':
      switch (msg.msg?.type) {
        // A switch the copy makes in this window (a next/previous key), and its end: the
        // highlight moves at once and stays until the state has that tab in front (ui/runtime.js
        // switchTo), so it never goes back to the tab left while the state catches up.
        case 'switching':
          if (Number.isInteger(msg.msg.tabId)) runtime?.switchTo(msg.msg.tabId, copySwitches.begin(msg.msg.tabId));
          return;
        case 'switch-done': copySwitches.settle(msg.msg); return;
        // Didn't happen: the highlight goes, and why is said (when the copy says why).
        case 'switch-failed': copySwitches.settle(msg.msg); notices.push(msg.msg); return;
        // Margin's notice about this window's page (background/notices.js): its kind's words.
        case 'notice': notices.push(msg.msg); return;
        // A trackpad gesture in the page in front (content/trackpad.js), as it goes.
        case 'gesture': gestures.push(msg.msg); return;
        // Safari's own New Tab made a tab the copy closed again (background/handlers.js
        // newTabHandOff), or Margin's new-tab page came up: the palette, here.
        case 'palette': openPaletteTimed({ newTab: msg.msg.newTab === true }, 'the copy'); return;
        // A key the app holds, heard by the copy anyway (its command, or a page): noted.
        case 'keyHeard': log('note', `${msg.msg.command} reached the extension (${msg.msg.from}) while the app holds it`); return;
        default: return;
      }
    default:
      return;
  }
}

// ---- the keyboard -------------------------------------------------------------------------

const editable = (/** @type {any} */ el) => !!el && (el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select' || el.isContentEditable);
let hasKeys = false;
const setKeys = (/** @type {boolean} */ on) => {
  if (on === hasKeys) return;
  hasKeys = on;
  void post('focus', { on }).catch(() => {});
};
document.addEventListener('focusin', (e) => { if (editable(e.target)) setKeys(true); });
document.addEventListener('focusout', (e) => { if (!editable(e.relatedTarget)) setTimeout(() => setKeys(editable(document.activeElement)), 0); });

// ---- start ----------------------------------------------------------------------------------

/** The app's way in (OverlayController.pushJSON): one message as JSON text. */
/** @type {any} */ (globalThis).marginApp = {
  /** @param {string} json */
  receive(json) {
    const from = performance.now();
    let msg;
    try { msg = JSON.parse(json); } catch { return; }
    if (!host) return;
    if (msg?.type === 'pointer') stats.pointers++;
    const cause = () => (msg?.type === 'changes' ? `changes to ${Object.keys(msg.changes ?? {}).join(', ') || 'site icons'}` : msg?.type === 'push' ? `the copy's ${msg.msg?.type}` : String(msg?.type));
    timed('taking the app\'s word', cause, () => {
      const before = !!host?.getState();
      host?.receive(msg);
      // A notice about one tab's page goes once another tab is in front.
      if (msg?.type === 'windows' || msg?.type === 'state' || msg?.type === 'changes') notices.front(host?.frontTabId ?? null);
      // The first state after a hello without one: the theme can draw now.
      if (!before && host?.getState() && !runtime && pendingTheme) mounting = mounting.then(() => mount(pendingTheme));
    });
    const ms = performance.now() - from;
    stats.received++;
    stats.receivedMs += ms;
    stats.receivedMaxMs = Math.max(stats.receivedMaxMs, ms);
  },
  // The counts above (the app's tests read them).
  stats: () => JSON.parse(JSON.stringify(stats)),
};
/** @type {any} */
let pendingTheme = null;

// ---- the link dropped ----------------------------------------------------------------------
// Dimmed with a note (not the theme's: Margin's own, over everything) while
// the app waits for the copy to come back (app/shell/Shell.swift).
/** @type {HTMLElement | null} */
let reconnectNote = null;
function setReconnecting(on) {
  document.documentElement.toggleAttribute('data-reconnecting', on);
  if (on && !reconnectNote) {
    reconnectNote = document.createElement('div');
    reconnectNote.id = 'margin-reconnecting';
    reconnectNote.setAttribute('role', 'status');
    reconnectNote.textContent = 'Reconnecting to Safari…';
    document.body.append(reconnectNote);
  } else if (!on && reconnectNote) {
    reconnectNote.remove();
    reconnectNote = null;
  }
}

// Margin's new-tab page asked with its Settings open (#settings): open here too, once per page.
let settingsFor = null;
function followPage() {
  const asked = host?.settingsAsked ? host.pageTabId : null;
  if (asked != null && asked !== settingsFor) runtime?.setUi({ settingsOpen: true });
  settingsFor = asked;
}

async function start() {
  const text = await post('hello');
  const hello = typeof text === 'string' ? JSON.parse(text) : text;
  if (!hello) return log('warn', 'no window for this overlay');
  host = createAppHost({ hello, post, onMessage, onNotice: (arg) => notices.run(arg), warn: (...args) => log('warn', ...args) });
  host.onState(() => followPage());
  // What the copy pushed for this window before this page was there (a
  // notice, the tabs loading: app/shell/Shell.swift HeldPushes), as if it came now.
  for (const msg of Array.isArray(hello.held) ? hello.held : []) host.receive({ type: 'push', msg });
  pendingTheme = hello.theme ?? null;
  if (hello.theme && host.getState()) mounting = mounting.then(() => mount(hello.theme));
}

start().catch((err) => log('error', 'the overlay failed to start:', String(err?.stack ?? err)));
