// Content scripts registered at runtime: the page's first paint, while
// Margin.app draws Margin (shared/app-link.ts appDraws: linked or
// reconnecting). Not linked, no page has a box (Margin 2 Phase 2 step 5): a
// page loads none of Margin's page scripts. Then the theme's package for
// Margin.app (background/theme-package.ts), not a registration.
//
// The first paint (Margin 2 Phase 3; PLAN.md §14, Spike 4): one registration,
// `margin-page`, in the top frame at document_start: the page's script in its
// own world (content/page/main.ts) and CSS that spells a layout (the insets
// and corner from Margin.app's layout for its windows: shared/page-box.ts
// layoutFiles) and says the theme with its look around the box
// (firstPaintFile). Registrations are the same for every window, so the
// layout most windows have is registered, and a window with another gets its
// own as each of its pages commits (fixUp: scripting.insertCSS, on
// webNavigation.onCommitted). A window Margin.app said it draws nothing over
// (`drawn` false: not in full screen, or not found among the window server's)
// counts for none, and its pages get `--margin-box-fp: off` as they commit: no
// box beside a sidebar that isn't there. Registered again only when that layout or the
// theme changes, and a layout at once when it changes alone, but in a burst
// (a resize of the sidebar sends many layouts) only once it's been the same
// for LAYOUT_SETTLE_MS: WebKit keeps every registration it was given
// applying to new pages (until it restarts), so each one piles up there;
// meanwhile the fix-up has new pages right, when it's in time. It often
// isn't: the sheet has to be in within the 17 to 21 ms between a page's
// commit and its first frame, and WebKit runs the background at background
// priority (it shows no page), so on a busy Mac it gets there 30 to 70 ms
// late, after the first frames (the host, 2026-11-06). So whether the app
// draws a window is followed at once (windowDrawnChanged), not after a
// settle: the app already says it only as it changes, and off only after its
// grace (app/platforms/macos/shell/Shell.swift DrawnOutbox); and so is a layout that leaves
// no box anywhere, and a lone one (layoutsChanged).
// Once registered in a run of Safari it's only ever updated, never taken
// away: no longer linked (or no box anywhere), it's updated to a layout of
// zeros, which a page's world reads as no box and leaves the page alone.
// Taken away and registered again, WebKit kept drawing the one in between
// (the host, 2026-11-05: on, then off.css alone, then on again gave every
// new page off.css's word), where an update's newest files win (back to a
// layout registered before, after two others: right). A Safari started
// since has none left over, and gets nothing until it's linked.
//
// Safari keeps registrations across launches and loads none of them if a
// file one lists is missing, so a path registered once stays in the build
// (scripts/build.ts LEGACY_FILES: the build before Phase 3's placeholders).
import { capabilities } from '../shared/capabilities.ts';
import { APP_LINK_KEY, appDraws } from '../shared/app-link.ts';
import { firstPaintFile, layoutFiles, layoutOfFiles, layoutOwnCss, spelled } from '../shared/page-box.ts';
import { themeFor } from '../themes/index.ts';
import { PACKAGE_THEMES } from '../themes/packages.ts';
import { api, cached, isOwner } from './store.ts';
import { storeActiveTheme } from './theme-package.ts';
import { realClock, settler } from './settle.ts';

const PAGE_ID = 'margin-page';
// The build before Phase 3's first-paint placeholder (its file now an empty
// stub: scripts/build.ts LEGACY_FILES): dropped where it's still registered.
const PREVIOUS_IDS = ['margin-docked'];
const PAGE_JS = 'content/page.bundle.js';
const FULLSCREEN_ONLY_JS = 'content/page/fullscreen-only.js';
const LAYOUT_SETTLE_MS = 2000;

// Chrome, where Margin works only in full screen: the page's script stays
// out of windows with a toolbar itself (content/page/fullscreen-only.ts),
// and the CSS draws only where it marks the page.
// (`settings`: the stored settings, as they came: state.settings.)
const worksInWindows = (settings: any) => !capabilities?.marginFullscreen || settings?.fullscreenOnly === false;
const anyFullscreen = async () => (await api.windows.getAll().catch((): BrowserWindow[] => [])).some((win) => win.state === 'fullscreen');

export type Layout = { left: number, top: number, right: number, bottom: number, radius: number };
// A window's layout as Margin.app measured it (shared/app-link.ts layouts:
// insets from the window's edges, and the card's corner), spelled.
export const layoutOf = (l: any): Layout | null => (l?.insets ? spelled({ ...l.insets, radius: l.radius }) : null);
const hasBox = (layout: Layout | null) => !!layout && (['left', 'top', 'right', 'bottom'] as const).some((side) => layout[side] >= 0.5);
const keyOf = (layout: Layout | null) => (layout ? JSON.stringify(spelled(layout)) : 'none');

// Before Margin.app has measured any window: Arcadia's geometry from the
// settings (beside the sidebar with Keep open, else in the frame, else none).
const FRAME = 8;
const RADIUS = 6.25; // Arcadia's card
export function layoutFromSettings(settings: any, theme = themeFor(settings)): Layout | null {
  if (settings?.sidebarPinnedOpen) return { left: theme.sidebarWidth?.(settings) ?? 260, top: FRAME, right: FRAME, bottom: FRAME, radius: RADIUS };
  return settings?.frameWhenHidden !== false ? { left: FRAME, top: FRAME, right: FRAME, bottom: FRAME, radius: RADIUS } : null;
}

/**
 * The layout to register: the one most windows the app draws have, of this
 * link's epoch (a tie: the one registered now, if it's among them, so a tie
 * never re-registers); else, before the app has said anything of a window
 * this epoch, the one most windows had in the epoch before (`last`: a relink
 * or a relaunch starts where it was), or the settings'; else (it said it
 * draws one but hasn't measured it yet) the one registered now, or the
 * settings'; else (it draws none) none.
 * @param layouts the link's @param registered keyOf the registered one
 * @param link the epoch the layouts must be of (absent: any), what the app said it draws, and the epoch before's layouts
 * */
export function chooseLayout(settings: any, layouts: Record<string, any>, registered: string | null = null, { epoch, drawn = {}, last = {} }: { epoch?: string | null, drawn?: Record<string, boolean>, last?: Record<string, any> } = {}): Layout | null {
  const most = (from: Record<string, any>, counts: (id: string, l: any) => boolean) => {
    const count = new Map();
    for (const [id, l] of Object.entries(from ?? {})) {
      if (!counts(id, l)) continue;
      const layout = layoutOf(l);
      if (!layout) continue;
      const key = keyOf(layout);
      count.set(key, { layout, n: (count.get(key)?.n ?? 0) + 1 });
    }
    if (!count.size) return undefined;
    const best = [...count.entries()].sort(([ka, a], [kb, b]) => b.n - a.n || Number(kb === registered) - Number(ka === registered))[0][1].layout;
    return hasBox(best) ? best : null;
  };
  const now = most(layouts, (id, l) => drawn?.[id] !== false && (epoch === undefined || l?.epoch === epoch));
  if (now !== undefined) return now;
  const said = Object.values(drawn ?? {});
  if (!said.length) {
    const before = most(last, () => true);
    return before !== undefined ? before : layoutFromSettings(settings);
  }
  if (!said.includes(true)) return null;
  return (registered && registered !== 'none' ? JSON.parse(registered) : null) ?? layoutFromSettings(settings);
}

/** The theme whose first paint pages get: the active one's, else Arcadia's. */
const firstPaintTheme = (settings: any) => (PACKAGE_THEMES.includes(settings?.theme) ? settings.theme : PACKAGE_THEMES[0]);

const NO_BOX = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0, radius: 0 });
/**
 * What to register: the first paint at the layout (`on`), the same at a
 * layout of zeros (no box: after a first paint in this run of Safari), or
 * null (nothing).
 * */
export function pagePlan(settings: any, { linked, showing = worksInWindows(settings), layout, wasOn = false }: { linked: boolean, showing?: boolean, layout: Layout | null, wasOn?: boolean }): { js: string[], css: string[], on: boolean } | null {
  const on = linked && showing && hasBox(layout);
  if (!on && !wasOn) return null;
  return { js: [...(worksInWindows(settings) ? [] : [FULLSCREEN_ONLY_JS]), PAGE_JS], css: [...layoutFiles(on ? (layout as Layout) : NO_BOX), firstPaintFile(firstPaintTheme(settings))], on };
}

// ---- the registration ------------------------------------------------------------

// Whether a first paint was registered in this run of Safari (storage.session:
// a background started again keeps it): from then on it's only updated.
const ON_KEY = 'firstPaintOn';
let onHere = false;
const markOn = async () => {
  if (onHere) return;
  onHere = true;
  await api.storage.session?.set({ [ON_KEY]: true }).catch(() => {});
};
const wasOnHere = async () => onHere || !!(await api.storage.session?.get(ON_KEY).catch(() => null))?.[ON_KEY];
/** The registered layout, as keyOf (null: none, or off): what fixUp compares a window's with. */
let registeredKey = (null as string | null);
// Whether the layout of zeros registered is there only because the layout had no box (linked,
// shown): a box back in it is followed at once (layoutsChanged).
let noBoxForLayout = false;
// What the app said of the windows as last read (fixUp, between syncs: setLayoutSource gives the
// live ones): this epoch's layouts, and whether it draws each window.
export type LinkView = { epoch?: string | null, layouts: Record<string, any>, drawn?: Record<string, boolean>, lastLayouts?: Record<string, any> };
let lastView: LinkView = { layouts: {} };
let liveView: (() => LinkView) | null = null;
const layoutSource = () => liveView?.() ?? lastView;
/** Where the windows' layouts come from (background.ts: the link's own, in memory). */
export const setLayoutSource = (fn: () => LinkView) => { liveView = fn; };
const chooseFor = (settings: any, view: LinkView, registered: string | null) => chooseLayout(settings, view?.layouts ?? {}, registered, { epoch: view?.epoch ?? undefined, drawn: view?.drawn ?? {}, last: view?.lastLayouts ?? {} });

const sameScript = (a: { js: string[]; css: string[]; on: boolean; }, b: BrowserRegisteredContentScript) => JSON.stringify(a ? { js: a.js ?? [], css: a.css ?? [] } : null) === JSON.stringify(b ? { js: b.js ?? [], css: b.css ?? [] } : null);
async function syncPage() {
  if (!api.scripting?.registerContentScripts) return;
  const got = await api.storage.local.get(['settings', APP_LINK_KEY]);
  const settings = got.settings;
  const linked = appDraws(got[APP_LINK_KEY]);
  // The link's own word while this copy is linked (storage has it a moment later: link.ts
  // writePageState), so a drawn change followed at once is registered as it is now.
  const live = isOwner() ? liveView?.() : null;
  const link = live?.epoch ? live : got[APP_LINK_KEY];
  lastView = { epoch: link?.epoch ?? null, layouts: link?.layouts ?? {}, drawn: link?.drawn ?? {}, lastLayouts: link?.lastLayouts ?? {} };
  for (const id of PREVIOUS_IDS) {
    if ((await api.scripting.getRegisteredContentScripts({ ids: [id] }).catch(() => [])).length) await api.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
  }
  const [current] = await api.scripting.getRegisteredContentScripts({ ids: [PAGE_ID] });
  // One from an earlier start of this background in this run of Safari (a
  // relaunch's stored one loads with Safari: kept while the link is looked
  // for, as `reconnecting`, else updated to no box).
  if (current?.js?.length) await markOn();
  const nowKey = current?.js?.length ? keyOf(layoutOfFiles(current.css)) : null;
  const layout = chooseFor(settings, lastView, nowKey);
  const showing = worksInWindows(settings) || await anyFullscreen();
  const want = pagePlan(settings, { linked, showing, layout, wasOn: await wasOnHere() });
  if (want && !sameScript(want, current)) {
    const script: BrowserRegisteredContentScript = { id: PAGE_ID, js: want.js, css: want.css, matches: ['<all_urls>'], runAt: 'document_start', allFrames: false, world: 'MAIN' };
    // Changed in place (above: the newest files win, and there's no moment
    // with none for a page starting then); made where there's none yet. Only
    // a browser with no update takes it away and makes it again.
    if (current && api.scripting.updateContentScripts) await api.scripting.updateContentScripts([script]);
    else {
      if (current) await api.scripting.unregisterContentScripts({ ids: [PAGE_ID] });
      await api.scripting.registerContentScripts([script]);
    }
  } else if (!want && current) {
    // From before this run of Safari, with nothing drawn since: none left over to outweigh.
    await api.scripting.unregisterContentScripts({ ids: [PAGE_ID] });
  }
  if (want) await markOn();
  registeredKey = want?.on ? keyOf(layout) : null;
  noBoxForLayout = !!want && !want.on && linked && showing;
}

let registrations = Promise.resolve();
let underWay = 0; // syncs queued and not done (layoutsChanged)
export const queueRegistrations = () => {
  underWay++;
  registrations = registrations
    .then(syncPage)
    .catch((err) => console.warn('[margin] first paint', err))
    .then(storeActiveTheme) // not a registration: the theme Margin.app is sent
    .catch((err) => console.warn('[margin] theme', err))
    .then(() => { underWay--; });
  return registrations;
};
// Settles once the registrations match the settings and the link (tests).
export const whenRegistered = () => registrations;

// Whether the one to register now is another than the one registered.
const another = () => keyOf(chooseFor(cached()?.settings, layoutSource(), registeredKey)) !== registeredKey;

// A window's layout changed (background.ts: the link's onLayout): the
// registration follows at once if it comes alone (no layout change in the
// LAYOUT_SETTLE_MS before it), and in any case once layouts have settled, if
// the one to register is another then: a sidebar dragged sends many, and
// registers its first at once at most, then only the one it settles at
// (each registration restyles every open page, and WebKit keeps them all).
// Waiting the 2 s for a lone change too left the pages opened meanwhile to
// fixUp's sheet, which a background slow to run puts in after their first
// frames (the host's first-paint, W0: the old box, then their own, about 1
// run in 5). One with no box anywhere follows at once even in a burst, as a
// change in what the app draws does (windowDrawnChanged): the box left
// registered meanwhile would be drawn in new pages until their commit's
// sheet takes it away (the frame turned off, say; a drag never comes to
// that). And so does a box back after a layout with none: while zeros are
// registered there's no fix-up (fixUp only puts in a window's own layout
// beside a registered box), so new pages would start with no box beside a
// sidebar kept open again, for the 2 s (Keep open turned off and on again
// with the frame off). The settled one is chosen once any registration
// under way is done (registeredKey is then what it left), from the layouts
// as they are then, so a burst never ends at a value it passed through.
// Which one is registered with windows at different layouts is
// chooseLayout's (most windows', a tie keeping the one registered): a lone
// change in a window that doesn't tip that registers nothing, and its pages
// get its own as they commit (fixUp), as before.
let layoutClock = realClock;
/** Tests: the settle's clock. */
export const useLayoutClock = (clock: import('./settle.ts').Clock) => { layoutClock = clock; };
const layoutSettle = settler(LAYOUT_SETTLE_MS, () => {
  void registrations.then(() => {
    if (!isOwner() || registeredKey == null || another()) void queueRegistrations();
  });
}, () => layoutClock);
export function layoutsChanged() {
  const lone = layoutSettle.change();
  if (!isOwner()) return;
  // (Lone: a sync whatever registeredKey says now, as one under way may change it; it updates
  // nothing when the one to register is the one registered.)
  if (lone) return void queueRegistrations();
  // In a burst, at once only for no box anywhere or a box back after none, judged against what
  // the registration under way leaves (registeredKey, noBoxForLayout): judged before it's done, a
  // box back while the lone change's zeros were being written left them for the 2 s. A sync
  // queued meanwhile reads the layouts as they are then, so it decides instead.
  const atOnce = () => {
    const chosen = chooseFor(cached()?.settings, layoutSource(), registeredKey);
    return registeredKey != null ? chosen === null : noBoxForLayout && chosen !== null;
  };
  if (!underWay) return void (atOnce() && queueRegistrations());
  const at = registrations;
  void at.then(() => { if (registrations === at && isOwner() && atOnce()) void queueRegistrations(); });
}

// Whether the app draws a window changed (background.ts: the link's onDrawn): the registration
// follows at once, if the one to register is another now. Waiting LAYOUT_SETTLE_MS as well
// left every page starting there meanwhile to fixUp's sheet, which a background slow to run
// puts in after the page's first frames (the copy's background heard the app's word 2 s late
// on a busy Mac, and its commit's sheet came 30 to 70 ms after: the host's `undrawn`, U0); the
// app sends `drawn` only as it changes, and off only after its grace (1.5 to 3 s), so a
// binding coming and going doesn't re-register any faster than a layout settling does.
export function windowDrawnChanged() {
  if (!isOwner() || registeredKey == null || another()) void queueRegistrations();
}

// ---- a window with a layout of its own --------------------------------------------
// Its page gets its window's layout as it commits, before its first
// rendering update (Spike 4: 96 of 96 pages in WebKit and Chromium; the
// page's world reads the variables again then: content/page/main.ts). One
// with no box there, or one Margin.app draws nothing over, gets
// `--margin-box-fp: off`, so the registered one isn't drawn.
export const OFF_CSS = 'html:root { --margin-box-fp: off; }';
/** What fixUp did, the last few (tests). */
export const fixUps: { tabId: number, css: string, ok: boolean | string }[] = [];
// Each tab's window as Safari last said it (tabs.onCreated, onAttached,
// onActivated; the tabs open as this background started: watchCommits), so
// fixUp knows a committing page's window with nothing to wait for. Between
// the commit and the page's first rendering update there are 17 to 21 ms
// (the host, 2026-11-06), and asking Safari (tabs.get) took 8 to 48 ms
// there: a page whose tab Margin's state didn't have yet got its own sheet
// only after its first frames, drawn at the registered layout.
const windowOfTab: Map<number, number> = new Map();
const windowOf = (tabId: number) => windowOfTab.get(tabId) ?? cached()?.tabs?.[tabId]?.windowId;
async function fixUp(tabId: number, documentId: string | undefined) {
  if (registeredKey == null || !isOwner() || !api.scripting?.insertCSS) return;
  const known = windowOf(tabId);
  // (Not known: a tab from before this background's listeners, not in Margin's state.)
  const windowId = known ?? (await api.tabs.get(tabId).catch(() => null))?.windowId;
  const view = layoutSource();
  const off = windowId != null && view?.drawn?.[windowId] === false;
  const own = off ? null : windowId != null ? layoutOf(view?.layouts?.[windowId]) : null;
  if (!off && (!own || keyOf(own) === registeredKey)) return;
  const css = own && hasBox(own) ? layoutOwnCss(own) : OFF_CSS;
  const insert = (target: { tabId: number; documentIds: string[]; } | { tabId: number; frameIds: number[]; }) => Promise.resolve(api.scripting.insertCSS({ target, css }));
  const ok = await (documentId ? insert({ tabId, documentIds: [documentId] }).catch(() => insert({ tabId, frameIds: [0] })) : insert({ tabId, frameIds: [0] })).then(() => true, (err) => String(err?.message ?? err));
  fixUps.push({ tabId, css, ok });
  if (fixUps.length > 20) fixUps.shift();
}
export function watchCommits() {
  api.tabs.onCreated.addListener((tab) => { if (Number.isInteger(tab?.id) && Number.isInteger(tab.windowId)) windowOfTab.set(tab.id, tab.windowId); });
  api.tabs.onAttached.addListener((tabId, info) => { if (Number.isInteger(info?.newWindowId)) windowOfTab.set(tabId, info.newWindowId); });
  api.tabs.onActivated.addListener((info) => { if (Number.isInteger(info?.tabId) && Number.isInteger(info.windowId)) windowOfTab.set(info.tabId, info.windowId); });
  api.tabs.onRemoved.addListener((tabId) => windowOfTab.delete(tabId));
  // A move seen another way (a tab's own update carries its window), and a tab out of its window: no stale window kept.
  api.tabs.onUpdated?.addListener((tabId, _change, tab) => { if (Number.isInteger(tab?.windowId) && tab.windowId >= 0) windowOfTab.set(tabId, tab.windowId); });
  api.tabs.onDetached?.addListener((tabId) => windowOfTab.delete(tabId));
  api.tabs.onReplaced?.addListener((_added, removed) => windowOfTab.delete(removed));
  // The tabs open now; what an event said since stands (it's newer).
  void Promise.resolve(api.tabs.query({})).then((tabs) => {
    for (const tab of tabs ?? []) if (Number.isInteger(tab?.id) && Number.isInteger(tab.windowId) && !windowOfTab.has(tab.id)) windowOfTab.set(tab.id, tab.windowId);
  }, () => {});
  api.webNavigation?.onCommitted?.addListener(({ tabId, frameId, documentId, url }) => {
    if (frameId === 0 && /^(https?|file):/i.test(url ?? '')) void fixUp(tabId, documentId).catch(() => {});
  });
}
