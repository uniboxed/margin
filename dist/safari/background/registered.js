// Content scripts registered at runtime, following the settings.
import { platform } from '../shared/platform.js';
import * as V from '../shared/view.js';
import { excludePatterns } from '../shared/shell-logic.js';
import { api } from './store.js';

// ---- docked placeholder ---------------------------------------------------

// While "Keep open" is on, register content/docked.css: the browser applies it
// before first paint, ahead of content scripts. Feature-detected; without the
// scripting API the sidebar simply appears when the content script runs.
const DOCKED_ID = 'margin-docked';
// One placeholder file per sidebar width (content/docked/w-<width>.css), so
// the first paint already matches the user's width.
async function syncDockedCss() {
  if (!api.scripting?.registerContentScripts) return;
  const { settings } = await api.storage.local.get('settings');
  const want = settings?.sidebarPinnedOpen
    ? `content/docked/w-${V.sidebarWidth({ settings })}.css`
    : null;
  const [current] = await api.scripting.getRegisteredContentScripts({ ids: [DOCKED_ID] });
  const have = current?.css?.[0] ?? null;
  if (want === have) return;
  if (current) await api.scripting.unregisterContentScripts({ ids: [DOCKED_ID] });
  if (want) {
    await api.scripting.registerContentScripts([
      { id: DOCKED_ID, css: [want], matches: ['<all_urls>'], runAt: 'document_start', allFrames: false },
    ]);
  }
}
let dockedSync = Promise.resolve();
export const queueDockedSync = () => {
  dockedSync = dockedSync
    .then(syncDockedCss)
    .catch((err) => console.warn('[margin] docked css', err))
    .then(() => syncShell())
    .catch((err) => console.warn('[margin] fitted layout', err))
    .then(() => dropProbe());
  return dockedSync;
};
// Settles once the registrations match the settings (reloadForUpdate).
export const whenDockedSynced = () => dockedSync;

// ---- fitted layout ----------------------------------------------------------

// The fitted layout (content/shell.js; Safari builds): registered while "Keep
// open" and the fitPages setting are on, except on the sites listed in
// fitPagesExcept. Registered scripts run right after the manifest's, in the
// same world, still before the parser adds anything to <html>.
const SHELL_ID = 'margin-shell';
const SHELL_JS = ['content/shell.bundle.js']; // built by scripts/build.js
async function syncShell() {
  if (!api.scripting?.registerContentScripts) return;
  const { settings } = await api.storage.local.get('settings');
  const on = !!platform?.shell && !!settings?.sidebarPinnedOpen && settings?.fitPages !== false;
  const want = on
    ? { js: SHELL_JS, excludeMatches: excludePatterns(settings.fitPagesExcept) }
    : null;
  const [current] = await api.scripting.getRegisteredContentScripts({ ids: [SHELL_ID] });
  const have = current ? { js: current.js ?? [], excludeMatches: current.excludeMatches ?? [] } : null;
  if (JSON.stringify(want) === JSON.stringify(have)) return;
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
