// The page in each of Margin.app's overlays (app/shell/Overlay.swift): the
// UI runtime (extension/ui/runtime.ts) drawing the theme around the page
// slot over one browser window, with the app's host
// (extension/ui/host-app.ts). Built into dist/app/overlay.js (scripts/
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
// tells it about the window's pages (ui/app-feedback.ts): Margin's notices,
// in the theme's guarded notice part, their buttons going back to the copy;
// the trackpad gestures' feedback; which tabs are loading (through the host).
// While a switch to another profile runs (app/HANDOFF.md §7): that the
// "switching" cover is drawn (`switch.coverShown`, ui/switch-cover.ts), and,
// after each `shown`, that the page has drawn and in which mode (`framed`).
import { createRuntime } from '../../extension/ui/runtime.ts';
import { createGestureMotion } from '../../extension/ui/gesture-motion.ts';
import { loadTheme, encodeStoredTheme } from '../../extension/ui/theme-loader.ts';
import { readThemeFile } from '../../extension/ui/theme-import.ts';
import { createPreviewBar } from '../../extension/ui/theme-preview.ts';
import { createAppHost, hitRects } from '../../extension/ui/host-app.ts';
import { createAppNotices, createGestureFeedback } from '../../extension/ui/app-feedback.ts';
import { backgroundSwitches, describeSwitchRun, OVERLAY_SWITCH_PREFIX, pickNavTab } from '../../extension/shared/switching.ts';
import { cycleTab } from '../../extension/shared/view.ts';
import { answerFramed, createCoverWatch } from '../../extension/ui/switch-cover.ts';

const bridge = (globalThis as any).webkit?.messageHandlers?.margin;
const post = (op: string, body: Record<string, any> = {}) => (bridge ? bridge.postMessage({ op, ...body }) : Promise.reject(new Error('no app')));
const log = (level: 'note' | 'warn' | 'error', ...args: any[]) => { void post('log', { level, text: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') }).catch(() => {}); };

let host: ReturnType<typeof createAppHost> | null = null;
let runtime: ReturnType<typeof createRuntime> | null = null;
let theme: any = null;
let saidReady = false;
let mounting: Promise<unknown> = Promise.resolve();
// Margin's notices and the gestures' feedback, kept here: a runtime made
// again (another theme) shows them as they are.
const notices = createAppNotices({
  show: (notice) => runtime?.setUi({ notice }),
  send: (type, payload) => host?.send(type, payload),
  frontTab: () => host?.frontTabId ?? null,
  // The overlay's own notice (a theme it couldn't draw): Settings opens Margin's Settings in this window.
  local: (kind, action) => { if (kind === 'theme-failed' && action === 'settings') void host?.send('openLauncher', { settings: true }); },
});
// How far a gesture has gone: eased every frame into --gesture-live (ui/gesture-motion.ts), the UI not drawn again.
const gestureMotion = createGestureMotion({ apply: (value) => document.documentElement.style.setProperty('--gesture-live', value.toFixed(3)) });
const gestures = createGestureFeedback({
  set: (gesture) => runtime?.setUi({ gesture }),
  // A gesture just shown comes in from nothing (its badge out of sight), then follows the fingers.
  progress: (value, fresh) => { if (fresh) gestureMotion.to(0, true); gestureMotion.to(value); },
});
// The copy's own switches in this window ('switching', then 'switch-done' or 'switch-failed').
const copySwitches = backgroundSwitches();

// ---- next/previous tab by the app's keys: highlighted here at once ---------------------------------------------
// The app hands this page ⌘⌥↓/↑ (whatever Settings has) instead of the copy (app/shell/Shell.swift run): the target
// is worked out here with the copy's rule (shared/view.ts cycleTab: the order the sidebar shows, wrapping), each
// press going on from the one before for a moment (NAV_CHAIN_MS), else from the tab in front; highlighted now, then
// asked of the copy with its switch id, which takes it as that press's (background/navigation.ts navigate `given`).
// So the highlight never waits for the copy's background (busy saving the switch before, or waking: Tirth,
// 2026-11-07, "the tab switches are not instantaneous sometimes"), and the copy's `switching` for these presses
// changes nothing here (it may come after a newer press's highlight).
// A held key repeats faster than a highlight is drawn (Tirth, 2026-11-08: "when i stop holding it, it still keeps
// moving"): the presses that come are added up and taken once a frame, one highlight and one ask for where they end,
// so none wait in line and it stops as the key is let go.
let localNav = (null as { tabId: number, at: number } | null);
let localSeq = 0;
let navSteps = 0;
let navFrame = 0;
let navTimer = (0 as any);
function navTab(action: 'next-tab' | 'prev-tab') {
  navSteps += action === 'next-tab' ? 1 : -1;
  if (navFrame) return;
  navFrame = requestAnimationFrame(flushNav);
  navTimer = setTimeout(flushNav, 50); // (no frames off screen)
}
function flushNav() {
  cancelAnimationFrame(navFrame);
  clearTimeout(navTimer);
  navFrame = 0;
  const steps = navSteps;
  navSteps = 0;
  if (!steps) return;
  const dir = steps > 0 ? 1 : -1;
  const action = dir > 0 ? 'next-tab' : 'prev-tab';
  const state = (host?.getState() as any);
  const windowId = host?.windowId;
  const ask = (extra: Record<string, any>) => { void Promise.resolve(host?.send('navigate', { action, ...extra })).catch(() => {}); };
  if (!runtime || !Number.isInteger(windowId)) return ask({});
  let target = pickNavTab(state, (windowId as number), localNav, dir, cycleTab);
  // Nothing in front known yet: the copy works it out (and highlights it, as before).
  if (target === undefined) return ask({});
  for (let i = 1; i < Math.abs(steps) && target != null; i++) target = cycleTab(state, (windowId as number), target, dir);
  if (target == null) return;
  const switchId = `${OVERLAY_SWITCH_PREFIX}${++localSeq}`;
  localNav = { tabId: target, at: Date.now() };
  runtime.switchTo(target, copySwitches.begin(target, switchId));
  ask({ target, switchId });
}

// ---- what took long here (Margin.app's log: npm run log:app) --------------------------
// Lasting and quiet: a piece of work over SLOW_MS (the app's word handled, a
// measure of the slot or of what's over it), a key or a press not drawn
// within SLOW_MS, and WebKit's own long tasks where it reports them, each
// with what caused it; the same kind at most once every SAY_EVERY_MS (with
// how many more there were). Each palette opening is one line: how long its
// drawing took. `marginApp.stats()` has the counts (the app's tests read it).
const SLOW_MS = 50;
const SAY_EVERY_MS = 10_000;
const stats = { slow: 0, hits: 0, hitsMs: 0, hitsMaxMs: 0, measures: 0, measureMs: 0, received: 0, receivedMs: 0, receivedMaxMs: 0, pointers: 0, inputMaxMs: 0, palette: ([] as any[]) };
const saidAt = new Map();
const unsaid = new Map();
function slow(what: string, ms: number, cause: string) {
  stats.slow++;
  const now = Date.now();
  if (now - (saidAt.get(what) ?? -Infinity) < SAY_EVERY_MS) return void unsaid.set(what, (unsaid.get(what) ?? 0) + 1);
  const more = unsaid.get(what) ?? 0;
  unsaid.delete(what);
  saidAt.set(what, now);
  log('note', `slow: ${what} took ${Math.round(ms)} ms (${cause})${more ? `; ${more} more since the last line` : ''}`);
}
function timed<T>(what: string, cause: () => string, fn: () => T): T {
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

const decode = (text: string) => { const bin = atob(text); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const nextFrame = () => new Promise<any>((resolve) => { const t = setTimeout(resolve, 100); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); resolve(undefined); })); });

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
// animation frame (ui/render.ts scheduleLayout): a window off screen, or
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
// The widest reveal zone (shared/view.ts revealZone: 24 px in full screen); peek checks the exact one.
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
// What takes the pointer, measured again once a theme's animation ends (the sidebar sliding out over the page:
// measured at the slide's start, it was still off screen, and the pointer went through it to the page, Tirth's
// recording 2026-11-07 2:11), and a moment after any change (an animation that ends unheard).
let hitsLater = 0;
function hitsAfter(ms: number) { clearTimeout(hitsLater); hitsLater = setTimeout(hitsSoon, ms); }
for (const type of ['transitionend', 'transitioncancel', 'animationend']) addEventListener(type, () => hitsSoon(), true);
// The space the sidebar shows, told to the app when it changes (its window's, by the view model: theme-blind), for the
// app's log beside the copy's own word (Tirth, 2026-11-07: after a switch the sidebar showed another space's tabs).
let spaceTold = '';
function reportSpace() {
  const vm = runtime?.vm;
  if (!vm?.space) return;
  const told = JSON.stringify([host?.windowId ?? null, vm.space.id ?? null, !!vm.space.foreign]);
  if (told === spaceTold) return;
  spaceTold = told;
  void post('shownSpace', { windowId: host?.windowId ?? null, space: vm.space.id ?? null, foreign: !!vm.space.foreign }).catch(() => {});
}
const watcher = new MutationObserver(() => { hitsSoon(); hitsAfter(400); queueMicrotask(measureNow); queueMicrotask(reportWant); queueMicrotask(reportSpace); coverWatch.check(); });
addEventListener('resize', () => { measureNow(); hitsSoon(); });

// ---- the theme --------------------------------------------------------------------------

// ---- falling back to Arcadia --------------------------------------------------------------
// A theme refused (loadTheme), missing or broken, or one whose page slot
// isn't usable (under 200 × 150 pt, or outside the window) is replaced by
// Arcadia, bundled with the app (dist/app/arcadia.js: scripts/build.ts
// fallbackPackage), and the overlay says so (the `theme-failed` notice).
// The profile's settings.theme stays: the theme is tried again the next time
// it comes. The log says the theme's id and the kinds of what was wrong,
// nothing from its files.
const MIN_PAGE = { width: 200, height: 150 };
let themeFailure: { id: string, why: string } | null = null;
/** What kinds of things were wrong, from the checks' errors (never their text). */
function reasonKinds(errors: string[]) {
  const kinds = new Set<any>();
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
let fallbackLoad = (null as Promise<any> | null);
function fallbackFromScript() {
  if (!Object.hasOwn(globalThis, 'marginFallbackTheme')) return null;
  const p = (globalThis as any).marginFallbackTheme;
  const plain = p && typeof p === 'object' && Object.getPrototypeOf(p) === Object.prototype;
  return plain && p.id === 'arcadia' && ['manifest', 'html', 'css'].every((k) => typeof p[k] === 'string') && p.files && typeof p.files === 'object' ? p : null;
}
function fallbackPackage() {
  fallbackLoad ??= new Promise<any>((resolve) => {
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
async function fallBack(id: string, why: string) {
  themeFailure = { id, why };
  log('warn', `theme ${JSON.stringify(id.slice(0, 64))} couldn't be drawn (${why}): Arcadia instead`);
  const arcadia = await fallbackPackage();
  if (!arcadia) return log('error', 'Arcadia, the fallback theme, is missing beside the overlay');
  await mount(arcadia, { fallback: true });
  notices.say('theme-failed');
  return false;
}

/**
 * @param pkg the theme package (background/theme-package.ts ThemeMessage)
 * @param options `fallback`: it's Arcadia standing in (never falls back again)
 */
async function mount(pkg: any, { fallback = false, preview: previewing = false }: { fallback?: boolean, preview?: boolean } = {}) {
  if (!host) return false;
  const id = typeof pkg?.id === 'string' ? pkg.id : '(no id)';
  let loaded: Awaited<ReturnType<typeof loadTheme>> | null = null;
  let why: string | null = null;
  if (!pkg || typeof pkg !== 'object' || typeof pkg.id !== 'string') why = 'no package';
  else {
    let files: { [k: string]: Uint8Array<ArrayBuffer>; } | null = null;
    try { files = Object.fromEntries(Object.entries(pkg.files ?? {}).map(([p, b64]) => [p, decode(String(b64))])); } catch { why = 'its files aren\'t readable'; }
    if (files) {
      loaded = await loadTheme({ manifest: pkg.manifest, html: pkg.html, css: pkg.css, files }, { document, settings: host.getState()?.settings?.themes?.[pkg.id] ?? null });
      if (!loaded.ok) why = `refused: ${(loaded as any).report.errors.length} problem(s) in ${reasonKinds((loaded as any).report.errors)}`;
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
function openPaletteTimed(options: { newTab: boolean }, by: string) {
  if (!runtime) return;
  const from = performance.now();
  runtime.openPalette(options);
  // Its style and layout worked out now (what the next frame would do first).
  document.querySelector('.palette-layer, [m-input="palette"]')?.getBoundingClientRect();
  const workMs = performance.now() - from;
  let frames = 0;
  let said = false;
  const say = (drawnMs: number | null) => {
    if (said) return;
    said = true;
    const round = (n: number) => Math.round(n * 10) / 10;
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
// checked here (ui/theme-import.ts: the same checks as every load), and drawn over the live
// window under Margin's own bar (ui/theme-preview.ts). Use Theme hands the checked package to the
// app (`perform theme.save`), which keeps it and sets the profile's theme; Cancel, Escape, or 30 s
// with no answer put the theme from before back. After Use Theme the previewed theme stays drawn,
// and the theme from before is kept, until the app's package for it comes (`theme`): a refusal
// (`themeSaved` not ok), a package that can't be stored, or no package within SAVE_WAIT_MS put
// the theme from before back.
/**
 * What's drawn now (not a preview): the profile's package, or Arcadia standing in for it (`fallback`).
 * */
let drawn: { pkg: any, fallback: boolean } | null = null;
const SAVE_WAIT_MS = 10_000;
/** Use Theme pressed, the app's word not in yet: the theme's id, and what to put back. */
let saving: { id: string, before: { pkg: any, fallback: boolean } | null, timer: any } | null = null;
/** The theme from before, drawn again (Arcadia again, as the fallback, if it was standing in). */
function putBack(before: { pkg: any, fallback: boolean } | null) {
  if (!before) return mounting;
  return (mounting = mounting.then(() => mount(before.pkg, { fallback: before.fallback })));
}
const preview = {
   pkg: null as any,
   before: null as any,
  bar: createPreviewBar({
    onUse: () => usePreview(),
    onCancel: (why) => { void endPreview(why === 'timeout' ? 'The preview ended by itself after 30 seconds; nothing changed.' : null); },
  }),
};
function importStatus(text: string | null, error: boolean = false) {
  runtime?.setUi({ settingsStatus: { ...(runtime.ui.settingsStatus ?? {}), themeImport: text == null ? undefined : { text, error } } });
}
function previewFailed(text: string) {
  preview.bar.hide();
  setKeys(editable(document.activeElement));
  const before = preview.before;
  preview.pkg = null;
  preview.before = null;
  if (before) putBack(before).then(() => importStatus(text, true));
  else importStatus(text, true);
  return false;
}
const toBase64 = (bytes: Uint8Array) => { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };
/** What the app read from the picker's choice. */
async function themeFile(msg: any) {
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
/** No package for the theme came in time: the theme from before back, and why. */
function saveUnanswered(id: string) {
  if (saving?.id !== id) return;
  const { before } = saving;
  saving = null;
  const kept = (host?.userThemes ?? []).some((e) => e?.id === id);
  log('note', `import: no package for the saved theme within ${SAVE_WAIT_MS / 1000} s (${kept ? 'kept' : 'not kept'}): the theme from before back`);
  void putBack(before).then(() => importStatus(kept ? 'Margin kept the theme, but this profile didn’t switch to it. Choose it under Theme.' : 'Margin couldn’t keep that theme: Margin.app didn’t answer.', true));
}
async function endPreview(text: string | null) {
  const before = preview.before;
  preview.pkg = null;
  preview.before = null;
  setKeys(editable(document.activeElement));
  hitsSoon();
  if (before) await putBack(before);
  importStatus(text);
}

// ---- what the app sends -------------------------------------------------------------------

function onMessage(msg: any) {
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
      else if (msg.name === 'next-tab' || msg.name === 'prev-tab') navTab(msg.name);
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
       (document.activeElement as any)?.blur?.();
      return;
    case 'blur':
      // The app put the overlay away, or showed it without the keyboard (not over the front window,
      // or a field focused too long before): nothing of Margin's keeps the focus, and the app hears so
      // (`focus` off), so no field shows focused while the keys go to the browser.
      // (The palette's close gives the focus back to what had it before: that lets go too.)
      runtime?.closePalette();
       (document.activeElement as any)?.blur?.();
      setKeys(false);
      return;
    case 'shown':
      // The app showed this overlay (it wasn't): `palette`, over a new window in front (⌘N, New
      // Window): the palette opens over its new tab, as ⌘T's does (Tirth, 2026-11-09), never as the
      // page first draws. (`focus`: the launcher's field instead, for a host that asks for that.)
      if (msg.palette === true) openPaletteTimed({ newTab: !host?.launcher }, 'a new window');
      else if (msg.focus === true) runtime?.focusLauncher();
      // Drawn, and in which mode, on the next frame (R4).
      answerFramed({ requestFrame: (fn) => requestAnimationFrame(fn), mode: () => host?.mode ?? 'fullscreen', post: (op, body) => post(op, body).catch(() => {}) });
      return;
    case 'push':
      switch (msg.msg?.type) {
        // A switch the copy makes in this window (a next/previous key), and its end: the
        // highlight moves at once and stays until the state has that tab in front (ui/runtime.ts
        // switchTo), so it never goes back to the tab left while the state catches up. A key's
        // switch has its `switchId`: only that one's word settles it (a press it replaced, or
        // one before it in the chain, says it's done too).
        case 'switching':
          // (Not one this page highlighted itself, navTab: it's on it, or on a newer one already.)
          if (String(msg.msg.switchId ?? '').startsWith(OVERLAY_SWITCH_PREFIX)) return;
          if (Number.isInteger(msg.msg.tabId)) runtime?.switchTo(msg.msg.tabId, copySwitches.begin(msg.msg.tabId, msg.msg.switchId ?? null));
          return;
        case 'switch-done': copySwitches.settle(msg.msg); return;
        // Didn't happen: the highlight goes, and why is said (when the copy says why).
        case 'switch-failed': copySwitches.settle(msg.msg); notices.push(msg.msg); return;
        // Margin's notice about this window's page (background/notices.ts): its kind's words.
        case 'notice': notices.push(msg.msg); return;
        // A trackpad gesture in the page in front (content/trackpad.ts), as it goes.
        case 'gesture': gestures.push(msg.msg); return;
        // Safari's own New Tab made a tab the copy closed again (background/handlers.ts
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

const editable = (el: any) => !!el && (el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select' || el.isContentEditable);
let hasKeys = false;
const setKeys = (on: boolean) => {
  if (on === hasKeys) return;
  hasKeys = on;
  void post('focus', { on }).catch(() => {});
};
document.addEventListener('focusin', (e) => { if (editable(e.target)) setKeys(true); });
document.addEventListener('focusout', (e) => { if (!editable(e.relatedTarget)) setTimeout(() => setKeys(editable(document.activeElement) || preview.bar.shown), 0); });

// ---- start ----------------------------------------------------------------------------------

/** The app's way in (OverlayController.pushJSON): one message as JSON text. */
 (globalThis as any).marginApp = {
  receive(json: string) {
    const from = performance.now();
    let msg;
    try { msg = JSON.parse(json); } catch { return; }
    if (!host) return;
    if (msg?.type === 'pointer') stats.pointers++;
    const cause = () => (msg?.type === 'changes' ? `changes to ${Object.keys(msg.changes ?? {}).join(', ') || 'site icons'}` : msg?.type === 'push' ? `the copy's ${msg.msg?.type}` : String(msg?.type));
    timed('taking the app\'s word', cause, () => {
      const before = !!host?.getState();
      host?.receive(msg);
      // Handed to another window by a switch (host-app.ts `rekey`): what its copy pushed before, and its theme if
      // that profile's isn't the one drawn (settings are shared across profiles, so usually it is).
      if (msg?.type === 'rekey' && msg.hello && host) {
        for (const held of Array.isArray(msg.hello.held) ? msg.hello.held : []) host.receive({ type: 'push', msg: held });
        const theme = msg.hello.theme ?? null;
        if (theme && JSON.stringify(theme) !== JSON.stringify(pendingTheme)) {
          pendingTheme = theme;
          if (host.getState() && !preview.pkg) mounting = mounting.then(() => mount(theme));
        }
      }
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
  // The window this page draws for (a switch's hand-over changes it: host-app.ts `rekey`). The app's tests read it.
  windowId: () => host?.windowId ?? null,
  // The theme the overlay couldn't draw, if it fell back to Arcadia (the app's tests read it).
  themeFailure: () => (themeFailure ? { ...themeFailure } : null),
  // The preview's bar, for the app's tests: what it says, and a press of one of its buttons.
  preview: () => ({ shown: preview.bar.shown, text: preview.bar.text(), rect: preview.bar.rect() }),
  previewPress: (which: 'use' | 'cancel') => preview.bar.press(which),
  // What Settings says about the last import (the app's tests read it).
  importStatus: () => runtime?.ui.settingsStatus?.themeImport ?? null,
  // Use Theme pressed and the app's word not in yet (the app's tests read it).
  saving: () => (saving ? saving.id : null),
};
let pendingTheme: any = null;

// ---- the link dropped ----------------------------------------------------------------------
// (Still clickable and hovered: a link back in a moment is the usual case; the dim and the note come only after
// 1.5 s, overlay.html. A press meanwhile that needs the copy is lost, as one in a dropped link always was.)
// Dimmed with a note (not the theme's: Margin's own, over everything) while
// the app waits for the copy to come back (app/shell/Shell.swift).
let reconnectNote: HTMLElement | null = null;
function setReconnecting(on: boolean) {
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
let settingsFor: number | null = null;
let launcherFor: number | null = null;
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
