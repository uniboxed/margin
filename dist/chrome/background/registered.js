// Content scripts registered at runtime, following the settings: the active
// theme's first-paint placeholder and the page's box. Safari keeps
// registrations across launches and loads none of them if a file one lists
// is missing, so a path registered once must stay in the build (see
// scripts/build.js LEGACY_LAYOUT_FILES). The theme itself isn't registered
// any more: Margin's content script asks the background for its package
// (Margin 2: background/theme-package.js).
import { platform } from '../shared/platform.js';
import { themeFor } from '../themes/index.js';
import { api } from './store.js';
import { storeActiveTheme } from './theme-package.js';

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
export function placeholderPlan(settings, { theme = themeFor(settings), showing = worksInWindows(settings) } = {}) {
  if (!showing) return [];
  const css = settings?.sidebarPinnedOpen ? theme.placeholder?.(settings) : settings?.frameWhenHidden !== false ? theme.closedPlaceholder : null;
  return css ? [{ id: DOCKED_ID, css: [css], matches: ['<all_urls>'] }] : [];
}

async function syncDockedCss() {
  if (!api.scripting?.registerContentScripts) return;
  const { settings } = await api.storage.local.get('settings');
  const want = placeholderPlan(settings);
  const current = await api.scripting.getRegisteredContentScripts({ ids: [DOCKED_ID] });
  const key = (list) => JSON.stringify(list.map((s) => [s.id, s.css ?? []]));
  if (key(want) === key(current)) return;
  if (current.length) await api.scripting.unregisterContentScripts({ ids: current.map((s) => s.id) });
  if (want.length) {
    await api.scripting.registerContentScripts(want.map(({ id, css, matches }) => ({ id, css, matches, runAt: 'document_start', allFrames: false })));
  }
}

// ---- the page's box ----------------------------------------------------------

// Its script in the page's world (content/page/main.js), in the top frame.
// Registered only while pages have a box, so a page Margin leaves alone loads
// nothing there: Keep open (at the sidebar's edge), or hidden with the frame (at
// the frame's). The file before it says where the box starts (built by
// scripts/build.js): one file per width, because a script registered here
// can't be given a value. Where Margin works only in full screen (Chrome):
// only while a window is, and the script itself stays out of windows with a
// toolbar (content/page/fullscreen-only.js). A page that misses it asks for it
// (content/page-link.js, handlers.js injectPage).
const PAGE_ID = 'margin-page';
const PAGE_JS = 'content/page.bundle.js';
const FRAME_LEFT = 8;
const FULLSCREEN_ONLY_JS = 'content/page/fullscreen-only.js';
/** @returns {string[] | null} the scripts, or null: no box */
export function pagePlan(settings, { theme = themeFor(settings), showing = worksInWindows(settings) } = {}) {
  if (!showing) return null;
  const left = settings?.sidebarPinnedOpen ? theme.sidebarWidth?.(settings) ?? 260 : settings?.frameWhenHidden !== false ? FRAME_LEFT : null;
  if (left == null) return null;
  return [`content/page/at-${left}.js`, ...(worksInWindows(settings) ? [] : [FULLSCREEN_ONLY_JS]), PAGE_JS];
}
async function syncPage() {
  if (!api.scripting?.registerContentScripts) return;
  const { settings } = await api.storage.local.get('settings');
  const want = pagePlan(settings, { showing: worksInWindows(settings) || await anyFullscreen() });
  const [current] = await api.scripting.getRegisteredContentScripts({ ids: [PAGE_ID] });
  if (JSON.stringify(want) === JSON.stringify(current?.js ?? null)) return;
  if (current) await api.scripting.unregisterContentScripts({ ids: [PAGE_ID] });
  if (want) await api.scripting.registerContentScripts([{ id: PAGE_ID, js: want, matches: ['<all_urls>'], runAt: 'document_start', allFrames: false, world: 'MAIN' }]);
}

let registrations = Promise.resolve();
export const queueRegistrations = () => {
  registrations = registrations
    .then(syncDockedCss)
    .catch((err) => console.warn('[margin] docked css', err))
    .then(syncPage)
    .catch((err) => console.warn('[margin] page box', err))
    .then(storeActiveTheme) // not a registration: the theme pages read with the state
    .catch((err) => console.warn('[margin] theme', err))
    .then(dropOld);
  return registrations;
};
// Settles once the registrations match the settings (reloadForUpdate).
export const whenRegistered = () => registrations;

// Left registered by earlier versions: the injection probe, the fitted layout,
// the frameless test build, the narrow rail and the theme's script (before
// Margin 2). Their files stay as empty stubs (scripts/build.js). Tried on
// every sync, because Safari loads stored registrations asynchronously after
// the background starts; it fails harmlessly once they're gone.
const OLD_IDS = ['margin-probe', 'margin-shell', 'margin-frameless', 'margin-docked-rail', 'margin-theme'];
async function dropOld() {
  for (const id of OLD_IDS) await api.scripting?.unregisterContentScripts?.({ ids: [id] }).catch(() => {});
}
