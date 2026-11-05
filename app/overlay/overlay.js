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
// key panel without making Margin the active app).
import { createRuntime } from '../../extension/ui/runtime.js';
import { loadTheme } from '../../extension/ui/theme-loader.js';
import { createAppHost, hitRects } from '../../extension/ui/host-app.js';

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
  const { rects, all } = hitRects(root, slot);
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
  const g = runtime?.measure();
  if (!g || !host) return;
  const key = JSON.stringify([g.insets, g.radius, g.container]);
  if (key === lastLayout) return;
  lastLayout = key;
  host.reportLayout({ ...g, windowId: host.windowId, mode: host.mode });
}
const watcher = new MutationObserver(() => { hitsSoon(); queueMicrotask(measureNow); });
addEventListener('resize', () => { measureNow(); hitsSoon(); });

// ---- the theme --------------------------------------------------------------------------

/** @param {any} pkg the theme package (background/theme-package.js ThemeMessage) */
async function mount(pkg) {
  if (!host || !pkg || typeof pkg !== 'object' || typeof pkg.id !== 'string') return;
  const files = Object.fromEntries(Object.entries(pkg.files ?? {}).map(([p, b64]) => [p, decode(String(b64))]));
  const loaded = await loadTheme({ manifest: pkg.manifest, html: pkg.html, css: pkg.css, files }, { document, settings: host.getState()?.settings?.themes?.[pkg.id] ?? null });
  if (!loaded.ok) return log('error', `theme ${pkg.id} refused:`, /** @type {any} */ (loaded).report.errors);
  const keep = runtime ? { palette: runtime.ui.palette } : {};
  watcher.disconnect();
  runtime?.destroy();
  theme?.unload?.();
  theme = loaded;
  runtime = createRuntime({ host, theme, container: document, ui: keep, onWarn: (message) => log('warn', message) });
  const root = runtime.view.rootElement();
  // The pointer over the page slot is the page's (the app lets it through); what the theme draws there keeps it.
  root?.setAttribute('m-passthrough', '');
  if (root) watcher.observe(root, { subtree: true, childList: true, attributes: true, characterData: false });
  lastHits = '';
  lastLayout = '';
  measureNow();
  hitsSoon();
  if (!saidReady && host.getState()) {
    await nextFrame();
    saidReady = true;
    void post('ready').catch(() => {});
  }
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
      if (msg.name === 'palette') runtime?.openPalette({ newTab: true });
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
      if (msg.msg?.type === 'switching') runtime?.setUi({ switchingTo: Number.isInteger(msg.msg.tabId) ? msg.msg.tabId : null });
      return;
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
    let msg;
    try { msg = JSON.parse(json); } catch { return; }
    if (!host) return;
    const before = !!host.getState();
    host.receive(msg);
    // The first state after a hello without one: the theme can draw now.
    if (!before && host.getState() && !runtime && pendingTheme) mounting = mounting.then(() => mount(pendingTheme));
  },
};
/** @type {any} */
let pendingTheme = null;

async function start() {
  const text = await post('hello');
  const hello = typeof text === 'string' ? JSON.parse(text) : text;
  if (!hello) return log('warn', 'no window for this overlay');
  host = createAppHost({ hello, post, onMessage, warn: (...args) => log('warn', ...args) });
  pendingTheme = hello.theme ?? null;
  if (hello.theme && host.getState()) mounting = mounting.then(() => mount(hello.theme));
}

start().catch((err) => log('error', 'the overlay failed to start:', String(err?.stack ?? err)));
