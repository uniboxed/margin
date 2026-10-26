// Content scripts registered at runtime, following the settings: the active
// theme, its first-paint placeholder and the fitted layout. Safari keeps
// registrations across launches and loads none of them if a file one lists
// is missing, so a path registered once must stay in the build (see
// scripts/build.js LEGACY_FILES).
import { platform } from '../shared/platform.js';
import { excludePatterns, FRAME_AWARE_PATTERNS } from '../shared/shell-logic.js';
import { themeFor } from '../themes/index.js';
import { api } from './store.js';

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

// While "Keep open" is on, register the theme's placeholder CSS (Arcadium:
// themes/arcadium/docked/w-<width>.css, one per sidebar width): the browser
// applies it before the page's first paint, ahead of content scripts, so the
// docked layout is there from the first frame. Feature-detected; without the
// scripting API the sidebar simply appears when the content script runs.
// Pages known to be pushed with the narrow rail (content/layout.js) get the
// rail's instead, so they don't start at the full width (placeholderPlan).
const DOCKED_ID = 'margin-docked';
const DOCKED_RAIL_ID = 'margin-docked-rail';

// What to register: [{ id, css, matches, excludeMatches }], from the
// settings. Pushed pages known in advance: the never-fit sites and the ones
// turned off by hand, or every page when fitting is off (or unavailable).
// Pages the shell skips for other reasons start full and narrow to the rail.
export function placeholderPlan(settings, { fits = !!platform?.shell, theme = themeFor(settings) } = {}) {
  if (!settings?.sidebarPinnedOpen) return [];
  const full = theme.placeholder?.(settings);
  const rail = settings.compactWhenPushed !== false ? theme.railPlaceholder : null;
  const plan = (id, css, matches, excludeMatches = []) => ({ id, css: [css], matches, excludeMatches });
  if (!rail) return full ? [plan(DOCKED_ID, full, ['<all_urls>'])] : [];
  if (!fits || settings.fitPages === false) return [plan(DOCKED_RAIL_ID, rail, ['<all_urls>'])];
  const pushed = [...excludePatterns(settings.fitPagesExcept), ...FRAME_AWARE_PATTERNS];
  return [...(full ? [plan(DOCKED_ID, full, ['<all_urls>'], pushed)] : []), plan(DOCKED_RAIL_ID, rail, pushed)];
}

async function syncDockedCss() {
  if (!api.scripting?.registerContentScripts) return;
  const { settings } = await api.storage.local.get('settings');
  const want = placeholderPlan(settings);
  const current = await api.scripting.getRegisteredContentScripts({ ids: [DOCKED_ID, DOCKED_RAIL_ID] });
  // Chrome returns the patterns sorted.
  const sorted = (a) => [...(a ?? [])].sort();
  const key = (list) => JSON.stringify(list.map((s) => [s.id, s.css ?? [], sorted(s.matches), sorted(s.excludeMatches)]).sort());
  if (key(want) === key(current)) return;
  if (current.length) await api.scripting.unregisterContentScripts({ ids: current.map((s) => s.id) });
  if (want.length) {
    await api.scripting.registerContentScripts(want.map(({ id, css, matches, excludeMatches }) => ({
      id, css, matches, ...(excludeMatches.length ? { excludeMatches } : {}), runAt: 'document_start', allFrames: false,
    })));
  }
}

let registrations = Promise.resolve();
export const queueRegistrations = () => {
  registrations = registrations
    .then(syncTheme)
    .catch((err) => console.warn('[margin] theme', err))
    .then(syncDockedCss)
    .catch((err) => console.warn('[margin] docked css', err))
    .then(() => syncShell())
    .catch((err) => console.warn('[margin] fitted layout', err))
    .then(() => dropProbe());
  return registrations;
};
// Settles once the registrations match the settings (reloadForUpdate).
export const whenRegistered = () => registrations;

// ---- fitted layout ----------------------------------------------------------

// The fitted layout (content/shell.js): registered while "Keep open" and the
// fitPages setting are on, except on the sites listed in fitPagesExcept.
// Registered scripts run right after the manifest's, in the same world,
// still before the parser adds anything to <html>. In Chrome also its
// page-world writer (content/shell-writer.js), and only while a window is in
// full screen when Margin works only there (content/core.js): elsewhere it
// would put pages in a card for nothing.
// With full screen only, the shell also gets a flag that makes it skip
// windows still showing the toolbar (content/shell-fullscreen-only.js). Its
// page-world writer in Chrome comes with the manifest (scripts/build.js):
// registered scripts in the page's world run after the shell.
const SHELL_ID = 'margin-shell';
const SHELL_JS = ['content/shell.bundle.js']; // built by scripts/build.js
const FULLSCREEN_ONLY_JS = 'content/shell-fullscreen-only.js';
async function syncShell() {
  if (!api.scripting?.registerContentScripts) return;
  const { settings } = await api.storage.local.get('settings');
  let on = !!platform?.shell && !!settings?.sidebarPinnedOpen && settings?.fitPages !== false;
  const fullscreenOnly = !!platform?.marginFullscreen && settings?.fullscreenOnly !== false;
  if (on && fullscreenOnly) on = (await api.windows.getAll().catch(() => [])).some((win) => win.state === 'fullscreen');
  const excludeMatches = on ? [...excludePatterns(settings.fitPagesExcept), ...FRAME_AWARE_PATTERNS] : [];
  const want = on ? { js: [...(fullscreenOnly ? [FULLSCREEN_ONLY_JS] : []), ...SHELL_JS], excludeMatches } : null;
  const [current] = await api.scripting.getRegisteredContentScripts({ ids: [SHELL_ID] });
  const have = current ? { js: current.js ?? [], excludeMatches: current.excludeMatches ?? [] } : null;
  const key = (r) => r && JSON.stringify({ js: r.js, excludeMatches: [...r.excludeMatches].sort() }); // Chrome returns them sorted
  if (key(want) === key(have)) return;
  if (current) await api.scripting.unregisterContentScripts({ ids: [SHELL_ID] });
  if (want) {
    await api.scripting.registerContentScripts([{
      id: SHELL_ID,
      js: want.js,
      matches: ['<all_urls>'],
      ...(want.excludeMatches.length ? { excludeMatches: want.excludeMatches } : {}),
      runAt: 'document_start',
      allFrames: false,
    }]);
  }
}
// Left registered by the injection probe (removed; its files are now empty
// stubs, see shared/probe.js): drop it. Tried on every sync, because Safari
// loads stored registrations asynchronously after the background starts. It
// fails harmlessly once it's gone.
async function dropProbe() {
  await api.scripting?.unregisterContentScripts?.({ ids: ['margin-probe'] }).catch(() => {});
}
