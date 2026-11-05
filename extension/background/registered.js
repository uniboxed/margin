// Content scripts registered at runtime, following the settings: the active
// theme, its first-paint placeholder and the page's box. Safari keeps
// registrations across launches and loads none of them if a file one lists
// is missing, so a path registered once must stay in the build (see
// scripts/build.js LEGACY_LAYOUT_FILES).
import { platform } from '../shared/platform.js';
import { themeFor } from '../themes/index.js';
import { api } from './store.js';
import { layoutFiles, layoutOwnCss, spelled } from '../shared/page-box.js';

// ---- the theme -------------------------------------------------------------

// The active theme's part on web pages (themes/<id>/content.bundle.js): it
// runs right after Margin's own content script, so only that theme's code
// loads. Pages that miss it (Safari loads stored registrations a moment
// after it starts) ask for it instead (handlers.js injectTheme).
const THEME_ID = 'margin-theme';
async function syncTheme() {
  if (!api.scripting?.registerContentScripts) return;
  const { settings } = await api.storage.local.get('settings');
  const want = themeFor(settings).content;
  const [current] = await api.scripting.getRegisteredContentScripts({ ids: [THEME_ID] });
  if (current?.js?.length === 1 && current.js[0] === want) return;
  if (current) await api.scripting.unregisterContentScripts({ ids: [THEME_ID] });
  await api.scripting.registerContentScripts([
    { id: THEME_ID, js: [want], matches: ['<all_urls>'], runAt: 'document_start', allFrames: false },
  ]);
}

// ---- first-paint placeholder ------------------------------------------------

// Wherever pages have a box, register the theme's placeholder CSS (Arcadia:
// themes/arcadia/docked/w-<width>.css, one per sidebar width, or closed.css for
// the frame alone): the browser applies it before the page's first paint, ahead
// of content scripts, so the box and the frame are there from the first frame.
// Feature-detected; without the scripting API the sidebar simply appears
// when the content script runs.
const DOCKED_ID = 'margin-docked';

// Chrome, where Margin works only in full screen.
const worksInWindows = (settings) => !platform?.marginFullscreen || settings?.fullscreenOnly === false;
const anyFullscreen = async () => (await api.windows.getAll().catch(() => [])).some((win) => win.state === 'fullscreen');

// What to register: [{ id, css, matches }], from the settings. Only where Margin
// works in every window: CSS can't tell one window from another, so in Chrome's
// full-screen-only mode the box and frame come with the page's script, which can.
// The file is the theme's one for any layout (docked/layout.css, or
// layout-closed.css for the frame alone): its insets are the variables
// registered with the page's script (pagePlan), so a new layout changes that
// one registration, not this.
export function placeholderPlan(settings, { theme = themeFor(settings), showing = worksInWindows(settings), explicit = false } = {}) {
  if (!showing) return [];
  const css = settings?.sidebarPinnedOpen ? theme.layoutPlaceholder : settings?.frameWhenHidden !== false || explicit ? theme.layoutClosedPlaceholder : null;
  return css ? [{ id: DOCKED_ID, css: [css], matches: ['<all_urls>'] }] : [];
}

// A registration changed in place where the browser can (no moment with
// none, for a page starting then), else taken away and made again.
async function replaceRegistration(current, want) {
  if (current && want && api.scripting.updateContentScripts && layoutsCache?.register !== 'again') return api.scripting.updateContentScripts([want]);
  if (current) await api.scripting.unregisterContentScripts({ ids: [current.id] });
  if (want) await api.scripting.registerContentScripts([want]);
}

async function syncDockedCss() {
  if (!api.scripting?.registerContentScripts) return;
  const { settings } = await api.storage.local.get('settings');
  const want = placeholderPlan(settings, { explicit: !!(await defaultLayout(settings)).explicit });
  const [current] = await api.scripting.getRegisteredContentScripts({ ids: [DOCKED_ID] });
  if (JSON.stringify(want[0]?.css ?? null) === JSON.stringify(current?.css ?? null)) return;
  await replaceRegistration(current, want[0] && { ...want[0], runAt: 'document_start', allFrames: false });
}

// ---- the windows' layouts (Margin 2) -------------------------------------------

// Where the page sits in each window: its insets and the card's corner, from
// the theme's layout (PLAN.md §3 setLayout), in Margin's pixels. A window with
// none set has today's: beside the sidebar with Keep open, else in the frame.
// Registrations are the same for every window, so the layout most windows
// share is registered (pagePlan), and a page of a window with another one
// gets its own as it commits (fixUp): scripting.insertCSS, the earliest a
// page of that tab can be reached.
/** @typedef {{ left: number, top: number, right: number, bottom: number, radius: number }} Layout */
const FRAME = 8;
const RADIUS = 6.25; // Arcadia's card (theme geometry.radius)
/** @returns {Layout | null} */
export function layoutFromSettings(settings, theme = themeFor(settings)) {
  if (settings?.sidebarPinnedOpen) return { left: theme.sidebarWidth?.(settings) ?? 260, top: FRAME, right: FRAME, bottom: FRAME, radius: RADIUS };
  return settings?.frameWhenHidden !== false ? { left: FRAME, top: FRAME, right: FRAME, bottom: FRAME, radius: RADIUS } : null;
}
// storage.session: { windows: { [windowId]: { layout, at } }, pinned: Layout | null,
// fixup: 'committed' (webNavigation.onCommitted) | 'updated' (tabs.onUpdated,
// loading) | 'off' }. `pinned` and `fixup` are for measuring (tests/spike).
const LAYOUTS_KEY = 'marginLayouts';
let layoutsCache = null;
async function layouts() {
  layoutsCache ??= (await api.storage.session?.get(LAYOUTS_KEY).catch(() => ({})))?.[LAYOUTS_KEY] ?? { windows: {}, pinned: null, fixup: 'committed' };
  return layoutsCache;
}
const keyOf = (layout) => JSON.stringify(spelled(layout));
/** The one to register: pinned, else the most windows', ties to the latest set. @returns {{ layout: Layout | null, explicit: boolean }} */
export function chooseDefault(settings, { windows = {}, pinned = null } = {}) {
  if (pinned) return { layout: pinned, explicit: true };
  const count = new Map();
  for (const { layout, at } of Object.values(windows)) {
    const key = keyOf(layout);
    const seen = count.get(key) ?? { layout, n: 0, at: -Infinity };
    count.set(key, { layout, n: seen.n + 1, at: Math.max(seen.at, at) });
  }
  const best = [...count.values()].sort((a, b) => b.n - a.n || b.at - a.at)[0];
  return best ? { layout: best.layout, explicit: true } : { layout: layoutFromSettings(settings), explicit: false };
}
const defaultLayout = async (settings) => chooseDefault(settings, await layouts());
let registeredKey = null; // the layout pages get from the registration, as spelled
/** A window's layout: its own, else the one registered if set, else null (today's, from the settings). */
export async function layoutOf(windowId) {
  const all = await layouts();
  const own = all.windows[windowId]?.layout;
  if (own) return own;
  const { settings } = await api.storage.local.get('settings');
  const chosen = chooseDefault(settings, all);
  return chosen.explicit ? chosen.layout : null;
}
/** @param {{ windowId?: number | null, layout?: Layout | null, pin?: boolean, fixup?: string, register?: string }} message */
export async function setLayout({ windowId = null, layout = null, pin = false, fixup, register }) {
  const all = await layouts();
  const next = { ...all, windows: { ...all.windows } };
  if (fixup) next.fixup = fixup;
  if (register) next.register = register; // 'again': unregister and register, not update (measuring)
  if (pin) next.pinned = layout ? spelled(layout) : null;
  else if (windowId != null) {
    if (layout) next.windows[windowId] = { layout: spelled(layout), at: Date.now() };
    else delete next.windows[windowId];
  }
  layoutsCache = next;
  await api.storage.session?.set({ [LAYOUTS_KEY]: next }).catch(() => {});
  return queueRegistrations();
}
export const forgetWindowLayout = async (windowId) => {
  if ((await layouts()).windows[windowId]) await setLayout({ windowId, layout: null });
};

// The tab's window, known without asking (webNavigation's details have none).
const tabWindow = new Map();
export function noteTab(tab) {
  if (tab?.id != null && tab.windowId != null) tabWindow.set(tab.id, tab.windowId);
}
/** What fixUp did, for measuring: [{ tabId, how, at, took, ok }]. */
export const fixLog = [];
async function fixUp(tabId, how, documentId) {
  const all = await layouts();
  if (all.fixup !== how) return;
  const windowId = tabWindow.get(tabId) ?? (await api.tabs.get(tabId).catch(() => null))?.windowId;
  const own = all.windows[windowId]?.layout;
  if (!own || keyOf(own) === registeredKey) return;
  const at = performance.now();
  const target = documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] };
  const ok = await api.scripting.insertCSS({ target, css: layoutOwnCss(own) }).then(() => true, (err) => String(err?.message ?? err));
  fixLog.push({ tabId, how, at: Math.round(at), took: Math.round(performance.now() - at), ok });
  if (fixLog.length > 200) fixLog.shift();
}
// (Tabs open before this are asked for once, when they commit: fixUp.)
export function watchCommits() {
  api.tabs.onCreated.addListener(noteTab);
  api.tabs.onAttached.addListener((tabId, { newWindowId }) => tabWindow.set(tabId, newWindowId));
  api.tabs.onRemoved.addListener((tabId) => tabWindow.delete(tabId));
  api.webNavigation?.onCommitted.addListener(({ tabId, frameId, documentId, url }) => {
    if (frameId === 0 && /^(https?|file):/.test(url ?? '')) void fixUp(tabId, 'committed', documentId).catch(() => {});
  });
  api.tabs.onUpdated.addListener((tabId, change, tab) => {
    noteTab(tab);
    if (change.status === 'loading') void fixUp(tabId, 'updated').catch(() => {});
  });
  api.windows?.onRemoved.addListener((windowId) => void forgetWindowLayout(windowId));
}

// ---- the page's box ----------------------------------------------------------

// Its script in the page's world (content/page/main.js), in the top frame.
// Registered only while pages have a box, so a page Margin leaves alone loads
// nothing there: Keep open (at the sidebar's edge), or hidden with the frame (at
// the frame's), or wherever a window's layout is set. Where the box starts
// comes with it as CSS: the default layout's variables, a digit to a file
// (shared/page-box.js layoutFiles), which the script and the theme's
// placeholder read, since a script registered here can't be given a value.
// Where Margin works only in full screen (Chrome): only while a window is,
// and the script itself stays out of windows with a toolbar
// (content/page/fullscreen-only.js); the variables alone change nothing. A
// page that misses it asks for it (content/page-link.js, handlers.js injectPage).
const PAGE_ID = 'margin-page';
const PAGE_JS = 'content/page.bundle.js';
const FULLSCREEN_ONLY_JS = 'content/page/fullscreen-only.js';
/** @returns {{ js: string[], css: string[] } | null} what to register, or null: no box */
export function pagePlan(settings, { showing = worksInWindows(settings), layout = layoutFromSettings(settings) } = {}) {
  if (!showing || !layout) return null;
  return { js: [...(worksInWindows(settings) ? [] : [FULLSCREEN_ONLY_JS]), PAGE_JS], css: layoutFiles(layout) };
}
async function syncPage() {
  if (!api.scripting?.registerContentScripts) return;
  const { settings } = await api.storage.local.get('settings');
  const { layout } = await defaultLayout(settings);
  const want = pagePlan(settings, { showing: worksInWindows(settings) || await anyFullscreen(), layout });
  const [current] = await api.scripting.getRegisteredContentScripts({ ids: [PAGE_ID] });
  if (JSON.stringify(want) !== JSON.stringify(current ? { js: current.js ?? [], css: current.css ?? [] } : null)) {
    await replaceRegistration(current, want && { id: PAGE_ID, ...want, matches: ['<all_urls>'], runAt: 'document_start', allFrames: false, world: 'MAIN' });
  }
  registeredKey = want ? keyOf(layout) : null;
}

let registrations = Promise.resolve();
export const queueRegistrations = () => {
  registrations = registrations
    .then(syncTheme)
    .catch((err) => console.warn('[margin] theme', err))
    .then(syncDockedCss)
    .catch((err) => console.warn('[margin] docked css', err))
    .then(syncPage)
    .catch((err) => console.warn('[margin] page box', err))
    .then(dropOld);
  return registrations;
};
// Settles once the registrations match the settings (reloadForUpdate).
export const whenRegistered = () => registrations;

// Left registered by earlier versions: the injection probe, the fitted layout,
// the frameless test build and the narrow rail. Their files stay as empty
// stubs (scripts/build.js). Tried on every sync, because Safari loads stored
// registrations asynchronously after the background starts; it fails
// harmlessly once they're gone.
const OLD_IDS = ['margin-probe', 'margin-shell', 'margin-frameless', 'margin-docked-rail'];
async function dropOld() {
  for (const id of OLD_IDS) await api.scripting?.unregisterContentScripts?.({ ids: [id] }).catch(() => {});
}
