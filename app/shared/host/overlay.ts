// The page Margin.app draws its UI with (on the Mac, Margin's own window:
// app/platforms/macos/shell/MarginWindowController.swift; the overlay over a
// browser's window was removed 2026-11-16, and is still the Windows shell's): the
// UI runtime (extension/ui/runtime.ts) drawing the theme around the page
// slot, with the app's host
// (extension/ui/host-app.ts). Built into dist/app/overlay.js (scripts/
// build.js), served at margin-app://app/ with a policy that allows no
// network (app/platforms/macos/shell/OverlayWebView.swift).
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
//
// In Margin's own window (the hello's `host` 'app-window': app/platforms/macos/shell/MarginWindowController.swift)
// the same page draws the whole app: its mode is the window's (windowed or full screen), it says where the theme
// draws the window's buttons and its drag regions (`chrome`), a layer over the whole window (the palette's) takes the
// pointer there (hitRects keepEqual), it never says it's reconnecting to a browser, and with
// no theme package from the app it draws Arcadia, bundled beside it, as its own (no notice: nothing failed).
import { createRuntime } from '../../../extension/ui/runtime.ts';
import { createGestureMotion } from '../../../extension/ui/gesture-motion.ts';
import { loadTheme, encodeStoredTheme } from '../../../extension/ui/theme-loader.ts';
import { wantsSystemMaterials } from '../../../extension/ui/theme-schema.ts';
import { readThemeFile } from '../../../extension/ui/theme-import.ts';
import { createPreviewBar } from '../../../extension/ui/theme-preview.ts';
import { chromeRects, cornerFill, createAppHost, hitRects, sidebarFixed } from '../../../extension/ui/host-app.ts';
import { createAppNotices, createGestureFeedback } from '../../../extension/ui/app-feedback.ts';
import { backgroundSwitches, describeSwitchRun, OVERLAY_SWITCH_PREFIX, pickNavTab } from '../../../extension/shared/switching.ts';
import { cycleSpace, cycleTab } from '../../../extension/shared/view.ts';
import { pickBridge } from '../../../extension/ui/overlay-bridge.ts';
import { numberedAction, numberedRows, togglePin } from '../../../extension/ui/shortcut-targets.ts';
import { nextSplitPane } from '../../../extension/ui/behaviors/split.ts';

// WebKit's handler on the Mac, WebView2's on Windows (ui/overlay-bridge.ts).
const bridge = pickBridge(globalThis);
const post = (op: string, body: Record<string, any> = {}): Promise<any> => (bridge ? bridge({ op, ...body }) : Promise.reject(new Error('no app')));
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
  local: (kind, action) => {
    if (kind === 'theme-failed' && action === 'settings') void host?.send('openLauncher', { settings: true });
    // Margin.app's picker on Safari's folder (app/engines/webkit/safari/SafariFolderGrant.swift).
    if (kind === 'safari-profile' && action === 'allow') void host?.send('allowSafariProfiles', {});
  },
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
// The app hands this page ⌘⌥↓/↑ (whatever Settings has) instead of the copy (app/platforms/macos/shell/ShellHostedGlue.swift runHosted): the target
// is worked out here with the copy's rule (shared/view.ts cycleTab: the order the sidebar shows, wrapping), each
// press going on from the one before for a moment (NAV_CHAIN_MS), else from the tab in front; highlighted now, then
// asked of the copy with its switch id, which takes it as that press's (background/navigation.ts navigate `given`).
// So the highlight never waits for the copy's background (busy saving the switch before, or waking: reported
// 2026-11-07, "the tab switches are not instantaneous sometimes"), and the copy's `switching` for these presses
// changes nothing here (it may come after a newer press's highlight).
// A held key repeats faster than a highlight is drawn (reported 2026-11-08: "when i stop holding it, it still keeps
// moving"): the presses that come are added up and taken once a frame, one highlight and one ask for where they end,
// so none wait in line and it stops as the key is let go.
let localNav = (null as { tabId: number | string, at: number } | null);
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
  if (!runtime || !Number.isInteger(windowId)) return host?.appWindow ? undefined : ask({});
  let target = pickNavTab(state, (windowId as number), localNav, dir, cycleTab);
  // Margin's own window (it owns the items: app/platforms/macos/shell/HostedSession.swift): nothing in front yet, the first
  // (or last) of the space's rows; the item picked shown as a sidebar pick is (`tab.activate`: an app or a web item).
  if (host?.appWindow) {
    if (target === undefined && state) target = cycleTab(state, (windowId as number), null, dir);
    for (let i = 1; i < Math.abs(steps) && target != null; i++) target = cycleTab(state, (windowId as number), target, dir);
    if (target == null) return;
    localNav = { tabId: target, at: Date.now() };
    runtime.dispatch('tab.activate', target, 'behavior');
    return;
  }
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
const stats = { slow: 0, hits: 0, hitsMs: 0, hitsMaxMs: 0, measures: 0, measureMs: 0, received: 0, receivedMs: 0, receivedMaxMs: 0, pointers: 0, inputMaxMs: 0, palette: ([] as any[]), themeSwaps: ([] as any[]) };
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

// ---- the page's own hover, while a hosted app has the keys (Tirth, 2026-11-20) --------------------------------
// WebKit hit-tests a pointer's move for :hover only in a page whose window is active (its window key), and Margin's
// panel isn't key while the app it hosts has the keys: its sidebar lit nothing under the pointer. Margin.app says where
// the pointer is over its UI then (`hoverAt`, CSS pixels; none: it left, a button went down, or the panel became key);
// the element there and each of its ancestors carry `m-hover`, and every rule of the theme's (and Margin's own) that
// says :hover also says [m-hover] (`withHoverAttr`, as the theme is drawn). Changed only where the element under the
// pointer changes. With the panel key, WebKit's own :hover does it, and the marks are cleared.
// WebKit's own :hover stays where it last was once the panel isn't key (it follows no move then): the row the pointer
// was over as a hosted app took the keys back stayed lit beside the one under the pointer (Tirth's recording,
// 2026-11-20). So while Margin's marks are in charge, each element WebKit still has as :hover carries `m-hover-off`
// (read again whenever the element under the pointer changes: a press updates WebKit's :hover even then), and the rules
// take WebKit's :hover only where it isn't marked off. A mark on the element itself, never a condition on an ancestor:
// WebKit restyles an element for a change of its own attributes at once, and was seen not to for a flag on the root.
// In charge from Margin's first `hoverAt`, until WebKit itself dispatches a move to the page again (the panel key: its
// :hover is current from that move on), when every mark goes.
const HOVER_ATTR = 'm-hover';
const HOVER_OFF = 'm-hover-off';
let hoverChain: Element[] = [];
let hoverOff: Element[] = [];
let hoverOwn = false;
function stillWebKits() {
  const now = Array.from(document.querySelectorAll(':hover'));
  const keep = new Set(now);
  for (const el of hoverOff) if (!keep.has(el)) el.removeAttribute(HOVER_OFF);
  for (const el of now) if (!el.hasAttribute(HOVER_OFF)) el.setAttribute(HOVER_OFF, '');
  hoverOff = now;
}
document.addEventListener('pointermove', (e) => {
  if (!e.isTrusted || !hoverOwn) return;
  hoverOwn = false;
  hoverAt(null, null);
  for (const el of hoverOff) el.removeAttribute(HOVER_OFF);
  hoverOff = [];
}, { capture: true, passive: true });
function hoverAt(x: unknown, y: unknown) {
  const at = typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? document.elementFromPoint(x, y) : null;
  if (at && !hoverOwn) { hoverOwn = true; stillWebKits(); }
  if (at === (hoverChain[0] ?? null)) return;
  if (hoverOwn) stillWebKits();
  const chain: Element[] = [];
  for (let el: Element | null = at; el; el = el.parentElement) chain.push(el);
  const next = new Set(chain);
  for (const el of hoverChain) if (!next.has(el)) el.removeAttribute(HOVER_ATTR);
  const had = new Set(hoverChain);
  for (const el of chain) if (!had.has(el) || !el.hasAttribute(HOVER_ATTR)) el.setAttribute(HOVER_ATTR, '');
  hoverChain = chain;
}
// Every style rule's :hover becomes "WebKit's :hover where it isn't marked off, or [m-hover]", in place, in
// the sheets the page draws with (nested rules, @media, @supports and @layer blocks included). Once per sheet: a rule
// that already says [m-hover] is left as it is.
const HOVER_PSEUDO = /:hover(?![\w-])/g;
function withHoverAttr(rules: CSSRuleList) {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule && HOVER_PSEUDO.test(rule.selectorText) && !rule.selectorText.includes(`[${HOVER_ATTR}]`)) {
      HOVER_PSEUDO.lastIndex = 0;
      // ((hover or marked) and (not marked off, or marked)): hovered not marked off, or marked. Its specificity is a plain
      // :hover's (:is() counts its weightiest part, one pseudo-class or attribute; :where() counts nothing), so the theme's
      // own order decides as it does with WebKit's :hover: the row shown keeps its fill under the pointer (2026-11-20:
      // ":is(:hover:not([m-hover-off]),[m-hover])" weighed two and outweighed the theme's `.active` rule).
      rule.selectorText = rule.selectorText.replace(HOVER_PSEUDO, `:is(:hover,[${HOVER_ATTR}]):where(:not([${HOVER_OFF}]),[${HOVER_ATTR}])`);
    }
    HOVER_PSEUDO.lastIndex = 0;
    const inner = (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules;
    if (inner) withHoverAttr(inner);
  }
}

// ---- ⌃⇧= Add Split View (docs/PEEK-SPLIT.md §4, decided 2026-11-21) ----------------------------------------------
// The space's item used most recently (not the one in front, nor a pane already: behaviors/split.ts nextSplitPane) is
// added: to the split shown, else split with the item in front. Nothing else in the space: the palette opens for a new
// tab, and the item it opens (a search, an address, a tab, an app) is added once it's in front, as a pane beside the
// item that was. Escape, or nothing new in front within SPLIT_PICK_MS: nothing added.
const SPLIT_PICK_MS = 15_000;
let splitPick: { front: number | string | null, until: number, picked: boolean } | null = null;
function addSplitPane() {
  if (!runtime) return;
  const next = nextSplitPane(host?.getState(), runtime.vm);
  if (next != null) return void runtime.dispatch('split.add', next, 'behavior');
  splitPick = { front: runtime.vm?.tab?.id ?? null, until: Date.now() + SPLIT_PICK_MS, picked: false };
  openPaletteTimed({ newTab: true }, '⌃⇧= Add Split View');
}
function followSplitPick() {
  if (!splitPick || !runtime) return;
  if (Date.now() > splitPick.until) { splitPick = null; return; }
  const front = runtime.vm?.tab?.id ?? null;
  if (!splitPick.picked || front == null || front === splitPick.front) return;
  splitPick = null;
  runtime.dispatch('split.add', front, 'behavior');
}

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
  const { rects, all } = timed('measuring what is over the page', () => `${root.getElementsByTagName('*').length} elements`, () => hitRects(root, slot, { keepEqual: !!host?.appWindow }));
  const ms = performance.now() - from;
  stats.hits++;
  stats.hitsMs += ms;
  stats.hitsMaxMs = Math.max(stats.hitsMaxMs, ms);
  // The preview's bar (Margin's own, outside the theme) takes the pointer too.
  const bar = preview.bar.rect();
  if (bar && !all) rects.push(bar);
  reportChrome(root);
  reportPeekPage();
  const key = JSON.stringify([rects, all]);
  if (key === lastHits) return;
  lastHits = key;
  void post('hits', { rects, all }).catch(() => {});
}
// Where the theme's `<m-preview-page>` is (the preview card: Margin.app places the card's window there, docs/PEEK-SPLIT.md §2):
// said as it changes, null once there's none. Measured as laid out, never mid-animation (ui/render.ts measurePeekPage).
let lastPeekPage = 'null';
function reportPeekPage() {
  if (!host?.appWindow || !runtime) return;
  const r = runtime.measurePeekPage();
  const said = r ? JSON.stringify([[r.x, r.y, r.width, r.height], r.radius]) : 'null';
  if (said === lastPeekPage) return;
  lastPeekPage = said;
  void post('peekRect', r ? { rect: [r.x, r.y, r.width, r.height], radius: r.radius } : { rect: null }).catch(() => {});
}
// Margin's own window: where the theme draws its buttons and where a drag moves it (host-app.ts chromeRects).
let lastChrome = '';
function reportChrome(root: Element) {
  if (!host?.appWindow) return;
  const chrome = chromeRects(root);
  const key = JSON.stringify(chrome);
  if (key === lastChrome) return;
  lastChrome = key;
  void post('chrome', chrome).catch(() => {});
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
  // (The mode too: Margin's own window learns it went full screen after its new size was measured, and the app
  // takes a layout as the window's only with the window's mode in it: MarginWindowController.)
  // (Margin's own window: the colour around the page's rounded corners too, the ground the app puts under the page area.)
  const fills = host.appWindow ? cornerFill(runtime?.view.pageEl)?.fills ?? null : null;
  const key = JSON.stringify([g.insets, g.radius, g.radii, g.container, host.mode, !!host.pageOutside, !!(host as { pageHosted?: boolean }).pageHosted, fills, g.split ?? null, g.panes ?? null]);
  if (key === lastLayout) return;
  lastLayout = key;
  // (Said as none when the theme draws nothing there: a report that leaves them out keeps the last ones, host-app.ts.)
  host.reportLayout({ ...g, windowId: host.windowId, mode: host.mode, ...(host.appWindow ? { fills } : {}) });
  reportPeekPage();
}
// Which pointer positions the app hands in (runtime.pointer: only peek uses
// them): none while the sidebar is docked (nothing to bring out), those in
// the reveal zone of the theme's peek edges while it's hidden, all of them
// while it's out over the page (to put it away once the pointer leaves).
// Told to the app when it changes (app/platforms/macos/shell/MarginWindowController.swift pointerMoved).
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
// What takes the pointer, measured again once a theme's animation ends (the sidebar sliding out over the page:
// measured at the slide's start, it was still off screen, and the pointer went through it to the page, a real
// session's recording 2026-11-07 2:11), and a moment after any change (an animation that ends unheard).
let hitsLater: Timer | 0 = 0;
function hitsAfter(ms: number) { clearTimeout(hitsLater); hitsLater = setTimeout(hitsSoon, ms); }
for (const type of ['transitionend', 'transitioncancel', 'animationend']) addEventListener(type, () => hitsSoon(), true);
// The space the sidebar shows, told to the app when it changes (its window's, by the view model: theme-blind), for the
// app's log beside the copy's own word (seen 2026-11-07: after a switch the sidebar showed another space's tabs).
let spaceTold = '';
function reportSpace() {
  const vm = runtime?.vm;
  if (!vm?.space) return;
  const told = JSON.stringify([host?.windowId ?? null, vm.space.id ?? null]);
  if (told === spaceTold) return;
  spaceTold = told;
  void post('shownSpace', { windowId: host?.windowId ?? null, space: vm.space.id ?? null }).catch(() => {});
}
// How many spaces and numbered rows (⌘1–9: ui/shortcut-targets.ts) the sidebar has, told to the app when it changes: it
// holds only the numbered keys with something behind them, so a press of another reaches the app in front
// (Shortcuts.swift ShortcutSet.held: Carbon's hot keys can't pass one on).
let countsTold = '';
function reportCounts() {
  const vm = runtime?.vm;
  if (!vm?.space) return;
  const counts = { spaces: vm.spaces?.length ?? 0, items: numberedRows(vm).length };
  const told = JSON.stringify(counts);
  if (told === countsTold) return;
  countsTold = told;
  void post('counts', counts).catch(() => {});
}
const SPLIT_ATTRS = new Set(['style', 'aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'm-dragging']);
const watcher = new MutationObserver((records) => {
  // (The page's own hover marks change nothing measured: m-hover alone, nothing to do.)
  if (records.every((r) => r.type === 'attributes' && (r.attributeName === HOVER_ATTR || r.attributeName === HOVER_OFF))) return;
  // (A split's panes sized again, a divider's frame of a drag: measured and reported by the drag itself, ui/behaviors/
  // split.ts; what takes the pointer read once the dividers are still. Nothing else per frame.)
  if (records.every((r) => r.type === 'attributes' && SPLIT_ATTRS.has(r.attributeName ?? '') && ((r.target as Element).localName === 'm-pane' || (r.target as Element).localName === 'm-divider'))) return hitsAfter(150);
  hitsSoon(); hitsAfter(400); queueMicrotask(measureNow); queueMicrotask(reportWant); queueMicrotask(reportSpace); queueMicrotask(reportCounts); queueMicrotask(followPopup);
});
// A menu or prompt of Margin's opened or closed: the keys taken or given back with it (`popupOpen`, as a field's).
function followPopup() { const want = stillHasKeys(); if (want !== hasKeys) setKeys(want); }
addEventListener('resize', () => { measureNow(); hitsSoon(); });

// Margin's own window as a tile beside a hosted one (host-app.ts sidebarFixed: the older pageOutside): the sidebar's
// width isn't dragged, so the theme's handle goes (render.ts `m-sidebar-fixed`). Under a hosted window above its page
// area (pageHosted) it's dragged as anywhere: the app places the hosted window once, when the drag is over.
function followOutside() {
  const root = runtime?.view.rootElement();
  if (root) root.toggleAttribute('m-sidebar-fixed', sidebarFixed(host));
}

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

// The system's materials (macOS's Liquid Glass: `-apple-visual-effect` in a theme's CSS). WebKit knows the property
// only in a web view with its system appearance on, which Margin.app turns on for a theme that asks (theme.json
// `systemMaterials`) and off again for every other (`appearance`: app/platforms/macos/shell/OverlayWebView.swift
// OverlaySystemAppearance; it also changes links' colours and what `color-scheme: light` means in Dark Mode, so no
// other theme gets it). Asked before a theme's style sheet is made: the browser keeps or drops the property as it
// reads the sheet. Without the app's answer (Windows, an older Margin.app) the theme draws its plain fills.
let systemMaterials: boolean | null = null; // as last asked (null: not yet, by this page)
async function askSystemMaterials(on: boolean) {
  if (on === systemMaterials) return;
  systemMaterials = on;
  let answer: unknown = null;
  try { answer = await post('appearance', { system: on }); } catch { return; }
  if (!on || answer !== true) return;
  // On, as the app says: this page knows it by the time the answer comes (seen every time, off screen); if a
  // WebKit ever tells the page later, wait for that, 160 ms at most.
  const known = () => typeof CSS !== 'undefined' && CSS.supports('-apple-visual-effect', '-apple-system-glass-material');
  for (let i = 0; i < 10 && !known(); i++) await new Promise((resolve) => setTimeout(resolve, 16));
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
      await askSystemMaterials(wantsSystemMaterials(pkg.manifest));
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
    // (⌃⇧= with nothing else to split with: the palette's pick is the new pane, `addSplitPane`.)
    onPalette: (what) => { if (splitPick && what === 'close') splitPick = null; else if (splitPick && what === 'run') splitPick.picked = true; },
  });
  // (The page's own hover: the theme's sheets and Margin's own, every :hover also [m-hover]; the marks start again.)
  for (const sheet of runtime.view.sheets ?? []) { try { withHoverAttr(sheet.cssRules); } catch { /* a sheet not readable: its :hover only */ } }
  hoverChain = [];
  const root = runtime.view.rootElement();
  // The pointer over the page slot is the page's (the app lets it through); what the theme draws there keeps it.
  root?.setAttribute('m-passthrough', '');
  followOutside();
  if (root) watcher.observe(root, { subtree: true, childList: true, attributes: true, characterData: false });
  lastHits = '';
  lastLayout = '';
  lastWant = '';
  lastChrome = '';
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

// Another theme from the app while one is drawn (2026-11-20, Tirth: a theme per space; Settings' Theme, a space's menu
// or editor): drawn once a space swipe has landed (the space is asked for at the lift, its settle still sliding in the
// theme it started in), then at once, no animation (Tirth, 2026-11-20: none). A page area bigger than the one before
// (Arcadia's 1264×933 after Neubrutalism's 1190×911): the theme before stays on screen (the document's view transition,
// no animation: overlay.html) until the hosted window has taken the new page area (the app's `hostedFrame`), at most
// HOSTED_WAIT_MS; then the new theme in one frame, the hosted window under it already its size (before: drawn first, the
// window was smaller than its card ~50-100 ms, 2026-11-20 20:18:23). A smaller one: drawn at once, the window bigger than
// it a moment, under the theme's frame. The first theme, the same theme again, or a WebKit without view transitions:
// drawn as before, at once.
const SWIPE_WAIT_MS = 4000;
const HOSTED_WAIT_MS = 300;
function swipeLanded(): Promise<void> {
  const busy = () => { const root = runtime?.view.rootElement(); return !!root && (root.matches('.m-swiping, .m-settling') || !!root.querySelector('.m-swiping, .m-settling')); };
  if (!busy()) return Promise.resolve();
  const from = performance.now();
  return new Promise((resolve) => {
    // (Timers, not frames: an overlay off screen gets none.)
    const check = () => (!busy() || performance.now() - from > SWIPE_WAIT_MS ? resolve() : void setTimeout(check, 30));
    setTimeout(check, 30);
  });
}
type Box = { left: number, top: number, right: number, bottom: number };
/** The hosted window's bounds in this page, as the app last said them (`hostedFrame`); null: none hosted. */
let hostedBox: Box | null = null;
const hostedWaiters = new Set<() => void>();
function hostedFrameSaid(rect: unknown) {
  hostedBox = Array.isArray(rect) && rect.length === 4 && rect.every((v) => Number.isFinite(v)) && rect[2] > 0 && rect[3] > 0
    ? { left: rect[0], top: rect[1], right: rect[0] + rect[2], bottom: rect[1] + rect[3] } : null;
  for (const wake of [...hostedWaiters]) wake();
}
/** Every visible host's window in this page while more than one is (docs/PEEK-SPLIT.md §1: a card, a split's panes),
 *  as the app last said them (`hostedFrames`), back to front; empty: one host (its frame is `hostedBox`). */
type HostedFrame = { role: 'main' | 'pane' | 'card', focused: boolean, box: Box };
let hostedBoxes: HostedFrame[] = [];
function hostedFramesSaid(list: unknown) {
  hostedBoxes = (Array.isArray(list) ? list : []).flatMap((f): HostedFrame[] => {
    const r = f?.rect;
    if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => Number.isFinite(v)) || r[2] <= 0 || r[3] <= 0) return [];
    const role = f.role === 'pane' || f.role === 'card' ? f.role : 'main';
    return [{ role, focused: f.focused === true, box: { left: r[0], top: r[1], right: r[0] + r[2], bottom: r[1] + r[3] } }];
  });
}
/** The page slot as the theme drawn now lays it out (the layout reported to the app). */
function slotBox(): Box | null {
  const g = host?.layout;
  if (!g) return null;
  return { left: g.insets.left, top: g.insets.top, right: g.container.width - g.insets.right, bottom: g.container.height - g.insets.bottom };
}
const covers = (a: Box, b: Box, e = 2) => a.left <= b.left + e && a.top <= b.top + e && a.right >= b.right - e && a.bottom >= b.bottom - e;
/** Once the hosted window covers `slot` (true), or `ms` on (false). */
function hostedCovering(slot: Box, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (ok: boolean) => { hostedWaiters.delete(check); if (timer) clearTimeout(timer); resolve(ok); };
    function check() { if (hostedBox && covers(hostedBox, slot)) finish(true); }
    hostedWaiters.add(check);
    timer = setTimeout(() => finish(false), ms);
    check();
  });
}
async function swapTheme(pkg: any) {
  const other = !!runtime && !!drawn && drawn.pkg?.id !== pkg?.id;
  if (!other) return mount(pkg);
  await swipeLanded();
  const hold = !!host?.appWindow && hostedBox != null && typeof (document as any).startViewTransition === 'function';
  if (!hold) return mount(pkg);
  let result: unknown = false;
  const from = performance.now();
  let waited: string | null = null;
  let waitMs = 0;
  let covered = true;
  const transition = (document as any).startViewTransition(async () => {
    result = await mount(pkg);
    // (The window covers the new slot already, a smaller one: shown at once.)
    const slot = slotBox();
    if (!slot || !hostedBox || covers(hostedBox, slot)) return;
    const t = performance.now();
    covered = await hostedCovering(slot, HOSTED_WAIT_MS);
    waitMs = Math.round(performance.now() - t);
    waited = covered ? `the hosted window took its page area in ${waitMs} ms first` : `the hosted window not at its page area within ${HOSTED_WAIT_MS} ms: shown anyway`;
  });
  await transition.updateCallbackDone.catch(() => {});
  const ms = Math.round(performance.now() - from);
  stats.themeSwaps.push({ id: String(pkg?.id ?? ''), ms, waitedMs: waitMs, covered });
  if (stats.themeSwaps.length > 20) stats.themeSwaps.shift();
  log('note', `theme ${JSON.stringify(String(pkg?.id ?? '').slice(0, 64))} drawn in ${ms} ms${waited ? ` (${waited})` : ''}`);
  return result;
}

// The palette opened: drawn how long after the word came (work, then frames until it's on screen), one line each time.
function openPaletteTimed(options: { newTab: boolean, query?: string, selectAll?: boolean }, by: string) {
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
const toBase64 = (bytes: Uint8Array) => { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]); return btoa(bin); }; // (apply takes an array-like)
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
    return importStatus(`Margin couldn’t keep that theme (${String((err as Error | undefined)?.message ?? err).slice(0, 160)}).`, true);
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
      if (host?.getState()) mounting = mounting.then(() => swapTheme(msg.theme));
      return;
    case 'command':
      // The app's keys (app/platforms/macos/shell/Shortcuts.swift, following the Settings shortcuts). None while the
      // start screen is up (Margin's default browser getting ready: nothing of Margin's usable yet).
      if (host?.pageStarting) return;
      if (msg.name === 'palette') {
        if (runtime?.paletteOpen) runtime.closePalette();
        else openPaletteTimed({ newTab: !!host?.appWindow || !host?.launcher }, 'the app\'s key');
      } else if (msg.name === 'toggle-sidebar') runtime?.sidebar.toggle();
      else if (msg.name === 'next-tab' || msg.name === 'prev-tab') navTab(msg.name);
      // Margin's own window: the next or previous space (the copy picks it over a browser: background/navigation.ts).
      else if ((msg.name === 'next-space' || msg.name === 'prev-space') && host?.appWindow) {
        const state = (host.getState() as any);
        const id = state && Number.isInteger(host.windowId) ? cycleSpace(state, (host.windowId as number), msg.name === 'next-space' ? 1 : -1) : null;
        if (id) runtime?.dispatch('space.switch', id, 'behavior');
      }
      // Margin's own window, its first run (app/platforms/macos/shell/HostedSession.swift): the space it made, in the
      // space editor for the person to name (the UI's own editor, as a new space opens in it).
      else if (msg.name === 'edit-space' && host?.appWindow && typeof msg.spaceId === 'string') runtime?.dispatch('space.edit', msg.spaceId, 'behavior');
      // Margin's own window, the palette's Settings while it hosted (HostedSession.swift openLauncher): its launcher is
      // in the page area again, with its Settings open.
      else if (msg.name === 'settings' && host?.appWindow) runtime?.setUi({ settingsOpen: true, recording: null });
      else if (msg.name === 'copy-url') runtime?.dispatch('tab.copyUrl', undefined, 'behavior');
      else if (msg.name === 'focus-address') {
        const cur = runtime?.vm?.tab;
        const url = cur?.url && /^https?:\/\//i.test(cur.url) ? cur.url : '';
        openPaletteTimed({ newTab: false, query: url, selectAll: true }, '⌘L');
      } else if (msg.name === 'toggle-pin') {
        // The pin bound to the row in front, in a folder or not; the toast once the request has come back.
        host?.takeFailure(); // (an earlier request's failure isn't this one's)
        if (runtime) void togglePin(runtime.vm, runtime, () => host?.takeFailure() != null);
      } else if (msg.name === 'reopen-archived') runtime?.dispatch('archive.restoreLast', undefined, 'behavior');
      // Quick Tab (⌥⌘N): the preview card with Margin's own address field (ui/behaviors/card.ts; `little-arc`, the
      // app's command, keeps its first name).
      else if (msg.name === 'little-arc') runtime?.card.openLittleArc();
      else if (msg.name === 'add-split') addSplitPane();
      else if (msg.name === 'space-index' && Number.isInteger(msg.index)) {
        const sp = runtime?.vm?.spaces?.[msg.index - 1];
        if (sp) runtime?.dispatch('space.switch', sp.id, 'behavior');
      } else if (msg.name === 'item-index' && Number.isInteger(msg.index)) {
        // Favorites, the pins as the sidebar shows them (folders included), today's rows.
        const target = numberedAction(runtime?.vm, msg.index);
        if (target) runtime?.dispatch(target.name, target.arg, 'behavior');
      }
      return;
    case 'toast':
      if (typeof msg.text === 'string' && msg.text) runtime?.showToast(msg.text);
      return;
    // The background mini player's sources for this window (the copy's `media` push, checked and given the UI's
    // numbers for its tabs by the app: app/platforms/macos/shell/UIPush.swift): the view model picks the one shown.
    case 'media':
      // (Each a tab's: Safari's pages are the mini player's only sources so far.)
      runtime?.setUi({ media: Array.isArray(msg.sources) ? msg.sources.filter((m: any) => !!m && typeof m === 'object' && Number.isInteger(m.tabId)).slice(0, 8).map((m: any) => ({ ...m, id: `tab:${m.tabId}`, source: 'tab' })) : null });
      return;
    // The preview card as Margin.app has it (app/platforms/macos/shell/HostedPeek.swift): drawn, or (null) closed, animated
    // out (ui/behaviors/card.ts).
    case 'peek':
      runtime?.card.show(msg.peek ?? null);
      queueMicrotask(reportPeekPage);
      return;
    case 'link':
      // (Margin's own window has no copy's link to lose.)
      if (host?.appWindow) return;
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
      // Window): the palette opens over its new tab, as ⌘T's does (2026-11-09), never as the
      // page first draws. (`focus`: the launcher's field instead, for a host that asks for that.)
      if (host?.pageStarting) return;
      if (msg.palette === true) openPaletteTimed({ newTab: !!host?.appWindow || !host?.launcher }, 'a new window');
      else if (msg.focus === true) runtime?.focusLauncher();
      return;
    // Margin.app's own word about a hosted app (HostEngine stepDown): its notice, its name filled in.
    case 'hostNote':
      if (msg.kind === 'route-simpler' || msg.kind === 'app-asking') notices.say(msg.kind, { app: msg.app });
      if (msg.kind === 'safari-profile') notices.say(msg.kind, { space: msg.space });
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
          if (Number.isInteger(msg.msg.tabId) || typeof msg.msg.tabId === 'string') runtime?.switchTo(msg.msg.tabId, copySwitches.begin(msg.msg.tabId, msg.msg.switchId ?? null));
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
        case 'palette': if (!host?.pageStarting) openPaletteTimed({ newTab: msg.msg.newTab === true }, 'the copy'); return;
        default: return;
      }
    default:
      return;
  }
}

// ---- the keyboard -------------------------------------------------------------------------

const editable = (el: any) => !!el && (el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select' || el.isContentEditable);
let hasKeys = false;
// A field that has the keys and is then taken out of the page (an editor closed, the launcher gone) fires no focusout
// in WebKit, which left the app thinking a field of Margin's still had them (seen 2026-11-15 in the hosted e2e: a
// window-mode app was never put back in front of Margin's window). While a field has them, the page's changes say
// when it's gone (one check per turn, only then).
let keysWatch: MutationObserver | null = null;
let keysCheck = false;
// (A menu or prompt of Margin's open takes the keys too, as a field does (Tirth, 2026-11-20): its ↑/↓, Return and Escape
// are Margin's while it's up, and the app doesn't hand them back to the hosted app at the press that opened it, which
// made the page lose its focus and the menu close as it came. The hosted app stays the front app throughout: Margin's
// panel takes the keys without making Margin active. Closed: the keys back to the app.)
const popupOpen = () => !!(runtime?.vm?.menu || runtime?.vm?.prompt);
const stillHasKeys = () => editable(document.activeElement) || preview.bar.shown || popupOpen();
const setKeys = (on: boolean) => {
  if (on === hasKeys) return;
  hasKeys = on;
  if (on && !keysWatch && typeof MutationObserver === 'function') {
    keysWatch = new MutationObserver(() => {
      if (keysCheck) return;
      keysCheck = true;
      setTimeout(() => { keysCheck = false; if (hasKeys && !stillHasKeys()) setKeys(false); }, 0);
    });
    keysWatch.observe(document.documentElement, { childList: true, subtree: true });
  } else if (!on) {
    keysWatch?.disconnect();
    keysWatch = null;
  }
  void post('focus', { on }).catch(() => {});
};
document.addEventListener('focusin', (e) => { if (editable(e.target)) setKeys(true); });
document.addEventListener('focusout', (e) => { if (!editable(e.relatedTarget)) setTimeout(() => setKeys(stillHasKeys()), 0); });

// ---- start ----------------------------------------------------------------------------------

/** The app's way in (OverlayController.pushJSON): one message as JSON text. */
 (globalThis as any).marginApp = {
  receive(json: string) {
    const from = performance.now();
    let msg;
    try { msg = JSON.parse(json); } catch { return; }
    if (!host) return;
    // Where the pointer is over Margin's UI while a hosted app has the keys (the app's, MarginWindowController.hover):
    // the page's own hover, before anything else (it's many a second, and nothing else needs it).
    if (msg?.type === 'hoverAt') { hoverAt(msg.x, msg.y); return; }
    // The hosted window's bounds in this page, as they change (MarginWindowController.readHosted): a theme with a bigger
    // page area waits for them (swapTheme).
    if (msg?.type === 'hostedFrame') { hostedFrameSaid(msg.rect); return; }
    // Every visible host's window while several are (MarginWindowController.sayHostedFrames): kept for the preview card and
    // split view's panes (docs/PEEK-SPLIT.md §2-§4).
    if (msg?.type === 'hostedFrames') { hostedFramesSaid(msg.frames); return; }
    // The trackpad's phases over Margin's UI (MarginWindowController.wheelPhase): for the space swipe (ui/behaviors/
    // swipe.ts), which web pages' wheel events don't tell.
    if (msg?.type === 'wheelPhase') {
      const phase = ['mayBegin', 'began', 'ended', 'cancelled', 'momentum', 'momentumEnd'].includes(msg.phase) ? msg.phase : null;
      if (phase) document.dispatchEvent(new CustomEvent('m-wheel-phase', { detail: { phase } }));
      return;
    }
    if (msg?.type === 'pointer') stats.pointers++;
    const cause = () => (msg?.type === 'changes' ? `changes to ${Object.keys(msg.changes ?? {}).join(', ') || 'site icons'}` : msg?.type === 'push' ? `the copy's ${msg.msg?.type}` : String(msg?.type));
    timed('taking the app\'s word', cause, () => {
      const before = !!host?.getState();
      host?.receive(msg);
      // A notice about one tab's page goes once another tab is in front.
      if (msg?.type === 'windows' || msg?.type === 'state' || msg?.type === 'changes') notices.front(host?.frontTabId ?? null);
      // The window's mode, or the sidebar alone in Margin's own window: measured again after this drawing (a theme
      // whose drawing doesn't change with it changes nothing the watcher sees, and the app waits for that layout).
      if (msg?.type === 'windows' || msg?.type === 'pageOutside' || msg?.type === 'pageHosted' || msg?.type === 'pageState') { followOutside(); queueMicrotask(measureNow); }
      // The app asks for a measure now: the window took a size its page hasn't drawn yet (no frame since, so no resize
      // event; seen 2026-11-15 after a hosted tile left: 4.8 s), and the web view's size is what a measure reads.
      if (msg?.type === 'measure') measureNow();
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
  // DEV-HOOK: an action run as a theme's behaviour would (DevHooks.swift `host { ui }`, the on-screen checks of the preview card
  // and split view), and what the page shows of them: its tab in front, its card, its split. Never addresses.
  devDispatch: (action: string, arg?: unknown) => (runtime ? !!runtime.dispatch(action, arg, 'behavior') : false), // DEV-HOOK
  devState: () => { // DEV-HOOK
    const vm: any = runtime?.vm;
    if (!vm) return 'no view model';
    const rows = [...(vm.favorites?.items ?? []), ...(vm.space?.pinnedFlat ?? []).filter((p: any) => !p.isFolder), ...(vm.space?.today ?? [])];
    const name = (id: unknown) => { const r = rows.find((x: any) => x.id === id || x.tabId === id); return r ? String(r.title ?? '').slice(0, 24) : String(id); };
    return JSON.stringify({ space: vm.space?.name, tab: vm.tab ? { id: vm.tab.id, title: String(vm.tab.title ?? '').slice(0, 24) } : null,
      today: (vm.space?.today ?? []).map((t: any) => ({ id: t.id, title: String(t.title ?? '').slice(0, 24), active: !!t.active })),
      preview: vm.preview ? { host: vm.preview.host, quickTab: !!vm.preview.isQuickTab, loading: !!vm.preview.loading } : null,
      // (Each pane's `tabId`: its row's number while it's open, what an action on it takes; `id` the split's own name for it.)
      split: vm.split ? { axis: vm.split.axis, panes: (vm.split.panes ?? []).map((p: any) => ({ id: p.id, tabId: p.tabId ?? p.id, title: name(p.tabId ?? p.id), focused: !!(p.focused ?? p.active) })) } : null,
      splits: (vm.space?.splits ?? []).map((sp: any) => ({ id: sp.id, count: sp.count })),
      hostedFrames: hostedBoxes.length });
  },
  // The visible hosts' windows as the app last said them (`hostedFrames`), empty with one host. The app's tests read it.
  hostedFrames: () => hostedBoxes.map((f) => ({ ...f, box: { ...f.box } })),
  // The window this page draws for. The app's tests read it.
  windowId: () => host?.windowId ?? null,
  // Drawn in Margin's own window, in which mode, and whether its palette is open (the app's tests read them).
  appWindow: () => ({ appWindow: !!host?.appWindow, mode: host?.mode ?? null, palette: !!runtime?.paletteOpen }),
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
// the app waits for the copy to come back (an overlay over a browser's window: never Margin's own).
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
  host = createAppHost({ hello, post, onMessage, onNotice: (arg) => notices.run(arg), warn: (...args) => log('warn', ...args), note: (...args) => log('note', ...args) });
  hostedFrameSaid(hello?.hostedFrame);
  // (Several visible as it starts: the preview card, a split's panes. `hostedFrames` pushes keep it as they change.)
  hostedFramesSaid(hello?.hostedFrames);
  host.onState(() => { followPage(); followSplitPick(); });
  // What the copy pushed for this window before this page was there (a
  // notice, the tabs loading: an app that holds them says so in its hello's `held`), as if it came now.
  for (const msg of Array.isArray(hello.held) ? hello.held : []) host.receive({ type: 'push', msg });
  pendingTheme = hello.theme ?? null;
  // Margin's own window with no package from the app (no copy has said its theme): Arcadia, as its own.
  if (!pendingTheme && host.appWindow) {
    const arcadia = await fallbackPackage();
    // (A package the app pushed meanwhile is the one, drawn as it came.)
    if (pendingTheme) return;
    pendingTheme = arcadia;
  }
  if (pendingTheme && host.getState()) { const pkg = pendingTheme; mounting = mounting.then(() => mount(pkg)); }
}

start().catch((err) => log('error', 'the overlay failed to start:', String(err?.stack ?? err)));
