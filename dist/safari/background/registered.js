// Content scripts registered at runtime: the page's first paint, while
// Margin.app draws Margin (shared/app-link.js appDraws: linked or
// reconnecting). Not linked, no page has a box (Margin 2 Phase 2 step 5): a
// page loads none of Margin's page scripts. Then the theme's package for
// Margin.app (background/theme-package.js), not a registration.
//
// The first paint (Margin 2 Phase 3; PLAN.md §14, Spike 4): one registration,
// `margin-page`, in the top frame at document_start: the page's script in its
// own world (content/page/main.js) and CSS that spells a layout (the insets
// and corner from Margin.app's layout for its windows: shared/page-box.js
// layoutFiles) and says the theme with its look around the box
// (firstPaintFile). Registrations are the same for every window, so the
// layout most windows have is registered, and a window with another gets its
// own as each of its pages commits (fixUp: scripting.insertCSS, on
// webNavigation.onCommitted). A window Margin.app said it draws nothing over
// (`drawn` false: not in full screen, or not found among the window server's)
// counts for none, and its pages get `--margin-fp: off` as they commit: no
// box beside a sidebar that isn't there. Registered again only when that layout or the
// theme changes, and a layout only once it's been the same for
// LAYOUT_SETTLE_MS: WebKit keeps every registration it was given applying to
// new pages (until it restarts), so each one piles up there, and a resize of
// the sidebar sends many layouts; meanwhile the fix-up has new pages right.
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
// (scripts/build.js LEGACY_FILES: the build before Phase 3's placeholders).
import { platform } from '../shared/platform.js';
import { APP_LINK_KEY, appDraws } from '../shared/app-link.js';
import { firstPaintFile, layoutFiles, layoutOfFiles, layoutOwnCss, spelled } from '../shared/page-box.js';
import { themeFor } from '../themes/index.js';
import { PACKAGE_THEMES } from '../themes/packages.js';
import { api, cached, isOwner } from './store.js';
import { storeActiveTheme } from './theme-package.js';

const PAGE_ID = 'margin-page';
// The build before Phase 3's first-paint placeholder (its file now an empty
// stub: scripts/build.js LEGACY_FILES): dropped where it's still registered.
const PREVIOUS_IDS = ['margin-docked'];
const PAGE_JS = 'content/page.bundle.js';
const FULLSCREEN_ONLY_JS = 'content/page/fullscreen-only.js';
const LAYOUT_SETTLE_MS = 2000;

// Chrome, where Margin works only in full screen: the page's script stays
// out of windows with a toolbar itself (content/page/fullscreen-only.js),
// and the CSS draws only where it marks the page.
const worksInWindows = (settings) => !platform?.marginFullscreen || settings?.fullscreenOnly === false;
const anyFullscreen = async () => (await api.windows.getAll().catch(() => [])).some((win) => win.state === 'fullscreen');

/** @typedef {{ left: number, top: number, right: number, bottom: number, radius: number }} Layout */
// A window's layout as Margin.app measured it (shared/app-link.js layouts:
// insets from the window's edges, and the card's corner), spelled.
/** @param {any} l @returns {Layout | null} */
export const layoutOf = (l) => (l?.insets ? spelled({ ...l.insets, radius: l.radius }) : null);
/** @param {Layout | null} layout */
const hasBox = (layout) => !!layout && ['left', 'top', 'right', 'bottom'].some((side) => layout[side] >= 0.5);
/** @param {Layout | null} layout */
const keyOf = (layout) => (layout ? JSON.stringify(spelled(layout)) : 'none');

// Before Margin.app has measured any window: Arcadia's geometry from the
// settings (beside the sidebar with Keep open, else in the frame, else none).
const FRAME = 8;
const RADIUS = 6.25; // Arcadia's card
/** @returns {Layout | null} */
export function layoutFromSettings(settings, theme = themeFor(settings)) {
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
 * @param {any} settings @param {Record<string, any>} layouts the link's @param {string | null} [registered] keyOf the registered one
 * @param {{ epoch?: string | null, drawn?: Record<string, boolean>, last?: Record<string, any> }} [link] the epoch the layouts must be of (absent: any), what the app said it draws, and the epoch before's layouts
 * @returns {Layout | null}
 */
export function chooseLayout(settings, layouts, registered = null, { epoch, drawn = {}, last = {} } = {}) {
  const most = (/** @type {Record<string, any>} */ from, /** @type {(id: string, l: any) => boolean} */ counts) => {
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
const firstPaintTheme = (settings) => (PACKAGE_THEMES.includes(settings?.theme) ? settings.theme : PACKAGE_THEMES[0]);

const NO_BOX = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0, radius: 0 });
/**
 * What to register: the first paint at the layout (`on`), the same at a
 * layout of zeros (no box: after a first paint in this run of Safari), or
 * null (nothing).
 * @param {any} settings @param {{ linked: boolean, showing?: boolean, layout: Layout | null, wasOn?: boolean }} options
 * @returns {{ js: string[], css: string[], on: boolean } | null}
 */
export function pagePlan(settings, { linked, showing = worksInWindows(settings), layout, wasOn = false }) {
  const on = linked && showing && hasBox(layout);
  if (!on && !wasOn) return null;
  return { js: [...(worksInWindows(settings) ? [] : [FULLSCREEN_ONLY_JS]), PAGE_JS], css: [...layoutFiles(on ? /** @type {Layout} */ (layout) : NO_BOX), firstPaintFile(firstPaintTheme(settings))], on };
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
let registeredKey = /** @type {string | null} */ (null);
// What the app said of the windows as last read (fixUp, between syncs: setLayoutSource gives the
// live ones): this epoch's layouts, and whether it draws each window.
/** @typedef {{ epoch?: string | null, layouts: Record<string, any>, drawn?: Record<string, boolean>, lastLayouts?: Record<string, any> }} LinkView */
/** @type {LinkView} */
let lastView = { layouts: {} };
let layoutSource = () => lastView;
/** Where the windows' layouts come from (background.js: the link's own, in memory). @param {() => LinkView} fn */
export const setLayoutSource = (fn) => { layoutSource = fn; };
/** @param {LinkView} view */
const chooseFor = (settings, view, registered) => chooseLayout(settings, view?.layouts ?? {}, registered, { epoch: view?.epoch ?? undefined, drawn: view?.drawn ?? {}, last: view?.lastLayouts ?? {} });

const sameScript = (a, b) => JSON.stringify(a ? { js: a.js ?? [], css: a.css ?? [] } : null) === JSON.stringify(b ? { js: b.js ?? [], css: b.css ?? [] } : null);
async function syncPage() {
  if (!api.scripting?.registerContentScripts) return;
  const got = await api.storage.local.get(['settings', APP_LINK_KEY]);
  const settings = got.settings;
  const linked = appDraws(got[APP_LINK_KEY]);
  const link = got[APP_LINK_KEY];
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
    const script = { id: PAGE_ID, js: want.js, css: want.css, matches: ['<all_urls>'], runAt: 'document_start', allFrames: false, world: 'MAIN' };
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
}

let registrations = Promise.resolve();
export const queueRegistrations = () => {
  registrations = registrations
    .then(syncPage)
    .catch((err) => console.warn('[margin] first paint', err))
    .then(storeActiveTheme) // not a registration: the theme Margin.app is sent
    .catch((err) => console.warn('[margin] theme', err));
  return registrations;
};
// Settles once the registrations match the settings and the link (tests).
export const whenRegistered = () => registrations;

// A window's layout changed, or whether the app draws it (background.js: the
// link's onLayout, onDrawn): the registration follows once they have settled
// (a binding that comes and goes, or a sidebar dragged, re-registers once at
// most), if the one to register is another now.
let settleTimer = null;
export function layoutsChanged() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (!isOwner() || registeredKey == null) return void queueRegistrations();
    const settings = cached()?.settings;
    if (keyOf(chooseFor(settings, layoutSource(), registeredKey)) !== registeredKey) void queueRegistrations();
  }, LAYOUT_SETTLE_MS);
}

// ---- a window with a layout of its own --------------------------------------------
// Its page gets its window's layout as it commits, before its first
// rendering update (Spike 4: 96 of 96 pages in WebKit and Chromium; the
// page's world reads the variables again then: content/page/main.js). One
// with no box there, or one Margin.app draws nothing over, gets
// `--margin-fp: off`, so the registered one isn't drawn.
export const OFF_CSS = 'html:root { --margin-fp: off; }';
/** What fixUp did, the last few (tests). @type {{ tabId: number, css: string, ok: boolean | string }[]} */
export const fixUps = [];
/** @param {number} tabId @param {string | undefined} documentId */
async function fixUp(tabId, documentId) {
  if (registeredKey == null || !isOwner() || !api.scripting?.insertCSS) return;
  const windowId = cached()?.tabs?.[tabId]?.windowId ?? (await api.tabs.get(tabId).catch(() => null))?.windowId;
  const view = layoutSource();
  const off = windowId != null && view?.drawn?.[windowId] === false;
  const own = off ? null : windowId != null ? layoutOf(view?.layouts?.[windowId]) : null;
  if (!off && (!own || keyOf(own) === registeredKey)) return;
  const css = own && hasBox(own) ? layoutOwnCss(own) : OFF_CSS;
  const insert = (target) => Promise.resolve(api.scripting.insertCSS({ target, css }));
  const ok = await (documentId ? insert({ tabId, documentIds: [documentId] }).catch(() => insert({ tabId, frameIds: [0] })) : insert({ tabId, frameIds: [0] })).then(() => true, (err) => String(err?.message ?? err));
  fixUps.push({ tabId, css, ok });
  if (fixUps.length > 20) fixUps.shift();
}
export function watchCommits() {
  api.webNavigation?.onCommitted?.addListener(({ tabId, frameId, documentId, url }) => {
    if (frameId === 0 && /^(https?|file):/i.test(url ?? '')) void fixUp(tabId, documentId).catch(() => {});
  });
}
