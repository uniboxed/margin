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
// key panel without making Margin the active app, once it's shown; the app
// says `shown` as it shows and `blur` when the field must let go). It says what the copy
// tells it about the window's pages (ui/app-feedback.js): Margin's notices,
// in the theme's guarded notice part, their buttons going back to the copy;
// the trackpad gestures' feedback; which tabs are loading (through the host).
// While a switch to another profile runs (app/HANDOFF.md §7): that the
// "switching" cover is drawn (`switch.coverShown`, ui/switch-cover.js), and,
// after each `shown`, that the page has drawn and in which mode (`framed`).
import { createRuntime } from '../../extension/ui/runtime.js';
import { loadTheme, encodeStoredTheme } from '../../extension/ui/theme-loader.js';
import { readThemeFile } from '../../extension/ui/theme-import.js';
import { createPreviewBar } from '../../extension/ui/theme-preview.js';
import { createAppHost, hitRects } from '../../extension/ui/host-app.js';
import { createAppNotices, createGestureFeedback } from '../../extension/ui/app-feedback.js';
import { backgroundSwitches, describeSwitchRun } from '../../extension/shared/switching.js';
import { answerFramed, createCoverWatch } from '../../extension/ui/switch-cover.js';

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
  // The overlay's own notice (a theme it couldn't draw): Settings opens Margin's Settings in this window.
  local: (kind, action) => { if (kind === 'theme-failed' && action === 'settings') void host?.send('openLauncher', { settings: true }); },
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
  // The preview's bar (Margin's own, outside the theme) takes the pointer too.
  const bar = preview.bar.rect();
  if (bar && !all) rects.push(bar);
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
// The "switching" cover drawn, with no swipe sliding: the app may freeze the screen on it.
const coverWatch = createCoverWatch({
  requestFrame: (fn) => requestAnimationFrame(fn),
  cover: () => {
    const c = runtime?.vm?.switchCover;
    return c && (document.querySelector('m-switch-cover')?.childElementCount ?? 0) > 0 ? c.id : null;
  },
  settling: () => !!runtime?.view.rootElement()?.querySelector('.m-swiping, .m-settling'),
  say: () => { host?.perform('switch.coverShown'); },
});
const watcher = new MutationObserver(() => { hitsSoon(); queueMicrotask(measureNow); queueMicrotask(reportWant); coverWatch.check(); });
addEventListener('resize', () => { measureNow(); hitsSoon(); });

// ---- the theme --------------------------------------------------------------------------

// ---- falling back to Arcadia --------------------------------------------------------------
// A theme refused (loadTheme), missing or broken, or one whose page slot
// isn't usable (under 200 × 150 pt, or outside the window) is replaced by
// Arcadia, bundled with the app (dist/app/arcadia.js: scripts/build.js
// fallbackPackage), and the overlay says so (the `theme-failed` notice).
// The profile's settings.theme stays: the theme is tried again the next time
// it comes. The log says the theme's id and the kinds of what was wrong,
// nothing from its files.
const MIN_PAGE = { width: 200, height: 150 };
/** @type {{ id: string, why: string } | null} */
let themeFailure = null;
/** What kinds of things were wrong, from the checks' errors (never their text). @param {string[]} errors */
function reasonKinds(errors) {
  const kinds = new Set();
  for (const e of errors ?? []) {
    const head = String(e).split(':')[0];
    kinds.add(head === 'package' ? 'its size or its files' : head === 'theme.json' ? 'its theme.json' : head === 'template' ? 'its theme.html' : head === 'css' ? 'its theme.css' : 'a bundled file');
  }
  return [...kinds].join(', ') || 'not known';
}
/** Is the theme's page slot one a page can be shown in? */
function usableLayout() {
  const g = runtime?.measure();
  if (!g) return true; // not measurable yet: nothing to judge
  const { insets, container } = g;
  if (container.width < MIN_PAGE.width * 2 || container.height < MIN_PAGE.height * 2) return true; // a window too small to judge
  const w = container.width - insets.left - insets.right;
  const h = container.height - insets.top - insets.bottom;
  const inside = [insets.left, insets.top, insets.right, insets.bottom].every((v) => Number.isFinite(v) && v >= 0);
  return inside && w >= MIN_PAGE.width && h >= MIN_PAGE.height;
}
/**
 * Arcadia's package, from the script beside this page (loaded when first
 * needed). Read only as the script's own property of the window, and only as
 * a package: a theme's element with that id is also `window.marginFallbackTheme`
 * (named access, from the window's prototype chain), and the sanitizer
 * removes such ids too. Nothing wrong is kept: the next fallback tries again.
 */
let fallbackLoad = /** @type {Promise<any> | null} */ (null);
function fallbackFromScript() {
  if (!Object.hasOwn(globalThis, 'marginFallbackTheme')) return null;
  const p = /** @type {any} */ (globalThis).marginFallbackTheme;
  const plain = p && typeof p === 'object' && Object.getPrototypeOf(p) === Object.prototype;
  return plain && p.id === 'arcadia' && ['manifest', 'html', 'css'].every((k) => typeof p[k] === 'string') && p.files && typeof p.files === 'object' ? p : null;
}
function fallbackPackage() {
  fallbackLoad ??= new Promise((resolve) => {
    const have = fallbackFromScript();
    if (have) return resolve(have);
    const el = document.createElement('script');
    el.src = 'arcadia.js';
    el.onload = () => resolve(fallbackFromScript());
    el.onerror = () => resolve(null);
    document.head.append(el);
  }).then((pkg) => { if (!pkg) fallbackLoad = null; return pkg; });
  return fallbackLoad;
}
/** @param {string} id @param {string} why */
async function fallBack(id, why) {
  themeFailure = { id, why };
  log('warn', `theme ${JSON.stringify(id.slice(0, 64))} couldn't be drawn (${why}): Arcadia instead`);
  const arcadia = await fallbackPackage();
  if (!arcadia) return log('error', 'Arcadia, the fallback theme, is missing beside the overlay');
  await mount(arcadia, { fallback: true });
  notices.say('theme-failed');
  return false;
}

/**
 * @param {any} pkg the theme package (background/theme-package.js ThemeMessage)
 * @param {{ fallback?: boolean }} [options] `fallback`: it's Arcadia standing in (never falls back again)
 */
async function mount(pkg, { fallback = false, preview: previewing = false } = {}) {
  if (!host) return false;
  const id = typeof pkg?.id === 'string' ? pkg.id : '(no id)';
  let loaded = null;
  let why = null;
  if (!pkg || typeof pkg !== 'object' || typeof pkg.id !== 'string') why = 'no package';
  else {
    let files = null;
    try { files = Object.fromEntries(Object.entries(pkg.files ?? {}).map(([p, b64]) => [p, decode(String(b64))])); } catch { why = 'its files aren\'t readable'; }
    if (files) {
      loaded = await loadTheme({ manifest: pkg.manifest, html: pkg.html, css: pkg.css, files }, { document, settings: host.getState()?.settings?.themes?.[pkg.id] ?? null });
      if (!loaded.ok) why = `refused: ${/** @type {any} */ (loaded).report.errors.length} problem(s) in ${reasonKinds(/** @type {any} */ (loaded).report.errors)}`;
    }
  }
  if (why) {
    if (previewing) return previewFailed(`Margin couldn’t draw it: ${why}.`);
    if (fallback) return void log('error', `Arcadia, the fallback theme, couldn't be drawn either (${why})`);
    return fallBack(id, why);
  }
  if (!fallback && !previewing) themeFailure = null;
  // What a preview puts back: this, Arcadia standing in included.
  if (!previewing) drawn = { pkg, fallback };
  const keep = { ...(runtime ? { palette: runtime.ui.palette, settingsOpen: runtime.ui.settingsOpen, settingsStatus: runtime.ui.settingsStatus } : {}), notice: notices.view(), gesture: gestures.shown };
  watcher.disconnect();
  runtime?.destroy();
  theme?.unload?.();
  theme = loaded;
  runtime = createRuntime({
    host, theme, container: document, ui: keep, onWarn: (message) => log('warn', message),
    // A switch asked for here that didn't happen: why, as a notice (its request's error).
    onSwitchFailed: () => { notices.switchFailed(host?.takeFailure()?.error); },
    // Each chain of switches (keys pressed fast, a click during them) as it ends, in Margin.app's log:
    // whether the highlight ever went back (it must not). A lone switch that landed says nothing.
    onSwitchRun: (run) => { const line = describeSwitchRun(run); if (line) log('note', line); },
  });
  const root = runtime.view.rootElement();
  // The pointer over the page slot is the page's (the app lets it through); what the theme draws there keeps it.
  root?.setAttribute('m-passthrough', '');
  if (root) watcher.observe(root, { subtree: true, childList: true, attributes: true, characterData: false });
  lastHits = '';
  lastLayout = '';
  lastWant = '';
  measureNow();
  if (previewing && !usableLayout()) { previewFailed('Margin couldn’t use it: its page is too small to show, or outside the window.'); return false; }
  if (!fallback && !usableLayout()) return fallBack(id, 'its page slot is too small or outside the window');
  // Settings says why Margin fell back to Arcadia (the theme field's status), until a theme draws.
  runtime.setUi({ settingsStatus: { ...(runtime.ui.settingsStatus ?? {}), theme: themeFailure ? { text: `Margin couldn’t draw the theme chosen here (${themeFailure.why}), so it’s using Arcadia.`, error: true } : undefined } });
  hitsSoon();
  reportWant();
  if (!saidReady && host.getState()) {
    await nextFrame();
    saidReady = true;
    void post('ready').catch(() => {});
  }
  return true;
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

// ---- previewing an imported theme (docs/phase6-themes.md §3) ----------------------------------
// Settings' Import Theme… asks the app for its file picker (`perform theme.import`); what was
// chosen comes back as `themeFile` (a folder's files or a .margintheme's bytes), is read and
// checked here (ui/theme-import.js: the same checks as every load), and drawn over the live
// window under Margin's own bar (ui/theme-preview.js). Use Theme hands the checked package to the
// app (`perform theme.save`), which keeps it and sets the profile's theme; Cancel, Escape, or 30 s
// with no answer put the theme from before back. After Use Theme the previewed theme stays drawn,
// and the theme from before is kept, until the app's package for it comes (`theme`): a refusal
// (`themeSaved` not ok), a package that can't be stored, or no package within SAVE_WAIT_MS put
// the theme from before back.
/**
 * What's drawn now (not a preview): the profile's package, or Arcadia standing in for it (`fallback`).
 * @type {{ pkg: any, fallback: boolean } | null}
 */
let drawn = null;
const SAVE_WAIT_MS = 10_000;
/** Use Theme pressed, the app's word not in yet: the theme's id, and what to put back. @type {{ id: string, before: { pkg: any, fallback: boolean } | null, timer: any } | null} */
let saving = null;
/** The theme from before, drawn again (Arcadia again, as the fallback, if it was standing in). @param {{ pkg: any, fallback: boolean } | null} before */
function putBack(before) {
  if (!before) return mounting;
  return (mounting = mounting.then(() => mount(before.pkg, { fallback: before.fallback })));
}
const preview = {
  /** @type {any} */ pkg: null,
  /** @type {any} */ before: null,
  bar: createPreviewBar({
    onUse: () => usePreview(),
    onCancel: (why) => { void endPreview(why === 'timeout' ? 'The preview ended by itself after 30 seconds; nothing changed.' : null); },
  }),
};
/** @param {string | null} text @param {boolean} [error] */
function importStatus(text, error = false) {
  runtime?.setUi({ settingsStatus: { ...(runtime.ui.settingsStatus ?? {}), themeImport: text == null ? undefined : { text, error } } });
}
/** @param {string} text */
function previewFailed(text) {
  preview.bar.hide();
  setKeys(editable(document.activeElement));
  const before = preview.before;
  preview.pkg = null;
  preview.before = null;
  if (before) putBack(before).then(() => importStatus(text, true));
  else importStatus(text, true);
  return false;
}
const toBase64 = (/** @type {Uint8Array} */ bytes) => { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };
/** What the app read from the picker's choice. @param {any} msg */
async function themeFile(msg) {
  const read = await readThemeFile(msg);
  if (!read.ok) {
    log('note', `import: refused (${read.errors?.length ?? 0} problem(s))`);
    return importStatus(`Margin can’t use that theme: ${read.errors.slice(0, 2).map((e) => String(e).slice(0, 160)).join('; ')}.`, true);
  }
  const m = read.manifest;
  const message = { id: m.id, manifest: read.pkg.manifest, html: read.pkg.html, css: read.pkg.css, files: Object.fromEntries(Object.entries(read.pkg.files).map(([p, b]) => [p, toBase64(b)])) };
  preview.before ??= drawn;
  preview.pkg = read.pkg;
  log('note', `import: previewing (${Object.keys(read.pkg.files).length} files, ${read.removed.length} kind(s) of thing removed)`);
  const shown = await (mounting = mounting.then(() => mount(message, { preview: true })));
  if (!shown || preview.pkg !== read.pkg) return;
  const installed = (host?.userThemes ?? []).find((e) => e?.id === m.id);
  preview.bar.show({ name: m.name, version: m.version, author: m.author, replaces: installed && installed.version !== m.version ? String(installed.version) : null });
  setKeys(true);
  hitsSoon();
  importStatus(read.removed.length ? `Previewing. Margin removed: ${read.removed.join('; ')}.` : 'Previewing. Use it or cancel from the bar at the top.');
}
function usePreview() {
  const pkg = preview.pkg;
  const before = preview.before;
  preview.pkg = null;
  preview.before = null;
  setKeys(editable(document.activeElement));
  hitsSoon();
  if (!pkg) return;
  let stored;
  try { stored = encodeStoredTheme(pkg).value; } catch (err) {
    void putBack(before);
    return importStatus(`Margin couldn’t keep that theme (${String(err?.message ?? err).slice(0, 160)}).`, true);
  }
  const id = String(stored.id);
  if (saving) clearTimeout(saving.timer);
  saving = { id, before, timer: setTimeout(() => saveUnanswered(id), SAVE_WAIT_MS) };
  host?.perform('theme.save', { value: stored });
  importStatus('Saving…');
}
/** No package for the theme came in time: the theme from before back, and why. @param {string} id */
function saveUnanswered(id) {
  if (saving?.id !== id) return;
  const { before } = saving;
  saving = null;
  const kept = (host?.userThemes ?? []).some((e) => e?.id === id);
  log('note', `import: no package for the saved theme within ${SAVE_WAIT_MS / 1000} s (${kept ? 'kept' : 'not kept'}): the theme from before back`);
  void putBack(before).then(() => importStatus(kept ? 'Margin kept the theme, but this profile didn’t switch to it. Choose it under Theme.' : 'Margin couldn’t keep that theme: Margin.app didn’t answer.', true));
}
/** @param {string | null} text */
async function endPreview(text) {
  const before = preview.before;
  preview.pkg = null;
  preview.before = null;
  setKeys(editable(document.activeElement));
  hitsSoon();
  if (before) await putBack(before);
  importStatus(text);
}

// ---- what the app sends -------------------------------------------------------------------

/** @param {any} msg */
function onMessage(msg) {
  switch (msg.type) {
    case 'themeFile':
      void themeFile(msg);
      return;
    case 'themeSaved':
      if (msg.ok !== false) return;
      // Refused by the app: the theme from before back (the previewed one stays drawn otherwise).
      if (saving) {
        const { before } = saving;
        clearTimeout(saving.timer);
        saving = null;
        void putBack(before).then(() => importStatus(String(msg.error ?? 'Margin couldn’t keep that theme.').slice(0, 300), true));
      } else importStatus(String(msg.error ?? 'Margin couldn’t keep that theme.').slice(0, 300), true);
      return;
    case 'theme':
      // A new package while previewing: drawn once the preview ends.
      if (preview.pkg) { pendingTheme = msg.theme; preview.before = { pkg: msg.theme, fallback: false }; return; }
      // The app's package after Use Theme: the save went through (another theme: drawn, as any).
      if (saving) {
        const ok = msg.theme?.id === saving.id;
        clearTimeout(saving.timer);
        saving = null;
        if (ok) importStatus('Saved. This profile uses it now; choose it in other profiles’ Settings.');
      }
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
    case 'blur':
      // The app put the overlay away, or showed it without the keyboard (not over the front window,
      // or a field focused too long before): nothing of Margin's keeps the focus, and the app hears so
      // (`focus` off), so no field shows focused while the keys go to the browser.
      // (The palette's close gives the focus back to what had it before: that lets go too.)
      runtime?.closePalette();
      /** @type {any} */ (document.activeElement)?.blur?.();
      setKeys(false);
      return;
    case 'shown':
      // The app showed this overlay (it wasn't): `focus`, over a new window in front (⌘N, New
      // Window): the new-tab launcher's field takes the focus (never as the page first draws).
      if (msg.focus === true) runtime?.focusLauncher();
      // Drawn, and in which mode, on the next frame (R4).
      answerFramed({ requestFrame: (fn) => requestAnimationFrame(fn), mode: () => host?.mode ?? 'fullscreen', post: (op, body) => post(op, body).catch(() => {}) });
      return;
    case 'push':
      switch (msg.msg?.type) {
        // A switch the copy makes in this window (a next/previous key), and its end: the
        // highlight moves at once and stays until the state has that tab in front (ui/runtime.js
        // switchTo), so it never goes back to the tab left while the state catches up. A key's
        // switch has its `switchId`: only that one's word settles it (a press it replaced, or
        // one before it in the chain, says it's done too).
        case 'switching':
          if (Number.isInteger(msg.msg.tabId)) runtime?.switchTo(msg.msg.tabId, copySwitches.begin(msg.msg.tabId, msg.msg.switchId ?? null));
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
        // A key the app holds, heard by the copy anyway (its command, or a page): noted. (The shell
        // says whether its hot key was on then, and why not: Shell.swift keyHeard.)
        case 'keyHeard': log('note', `${msg.msg.command} reached the extension (${msg.msg.from})`); return;
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
document.addEventListener('focusout', (e) => { if (!editable(e.relatedTarget)) setTimeout(() => setKeys(editable(document.activeElement) || preview.bar.shown), 0); });

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
  // The theme the overlay couldn't draw, if it fell back to Arcadia (the app's tests read it).
  themeFailure: () => (themeFailure ? { ...themeFailure } : null),
  // The preview's bar, for the app's tests: what it says, and a press of one of its buttons.
  preview: () => ({ shown: preview.bar.shown, text: preview.bar.text(), rect: preview.bar.rect() }),
  previewPress: (/** @type {'use' | 'cancel'} */ which) => preview.bar.press(which),
  // What Settings says about the last import (the app's tests read it).
  importStatus: () => runtime?.ui.settingsStatus?.themeImport ?? null,
  // Use Theme pressed and the app's word not in yet (the app's tests read it).
  saving: () => (saving ? saving.id : null),
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
// Another of Margin's pages in front starts with its Settings closed: the overlay outlives each
// page, and its Settings kept open (a theme chosen there: mount's `keep`) would show open over
// the next new tab, its Settings button closing them.
let settingsFor = null;
let launcherFor = null;
function followPage() {
  const page = host?.pageTabId ?? null;
  const asked = host?.settingsAsked ? page : null;
  if (page != null && page !== launcherFor) {
    launcherFor = page;
    if (asked == null && runtime?.ui.settingsOpen) runtime.setUi({ settingsOpen: false, recording: null });
  }
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
