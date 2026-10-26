// Margin's new-tab page (the browser's new-tab override). What's on it is the
// active theme's: this module loads that theme's new-tab bundle
// (themes/<id>/newtab.bundle.js) and calls its mount(). Only that theme's
// code loads.
import { themeFor } from '../themes/index.js';
/** @import { MessageType, Request, Result } from '../../types/margin' */

const api = globalThis.browser ?? globalThis.chrome;

/**
 * @template {MessageType} K
 * @param {K} type a handler in background.js
 * @param {Request<K>} [payload]
 * @returns {Promise<Result<K>>}
 */
async function send(type, payload = {}) {
  const res = await api.runtime.sendMessage({ type, ...payload });
  if (res && !res.ok) console.warn('[margin]', type, res.error);
  return res?.result;
}

// The theme loads right away, alongside the ⌘T check below.
const theme = api.storage.local.get('settings').then(({ settings }) => import(api.runtime.getURL(themeFor(settings).newtab)));
const self = await api.tabs.getCurrent();

// ---- ⌘T / ⌘N ----------------------------------------------------------------
// Safari never lets extensions intercept ⌘T/⌘N; it opens this page instead.
// On a fresh new tab (not Back, not a reload), ask the background: for ⌘T it
// returns to the previous tab and opens the palette there, closing this tab;
// otherwise (⌘N's first tab) the palette opens over this page.
const nav = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType?.('navigation')?.[0]);
// `newtab.html#launcher` opens the launcher on purpose and never redirects.
const fresh = history.length <= 1 && (!nav || nav.type === 'navigate') && location.hash !== '#launcher';
const handoff = fresh ? send('newTabPage').catch(() => null) : Promise.resolve(null);

// Draw the page unless this tab is being closed for the hand-off: wait a
// moment for the answer (the background may be waking up), never longer, so
// the page can't stay blank. A tab that was to close but didn't gets drawn too.
const HANDOFF_WAIT_MS = 300;
const early = await Promise.race([handoff, new Promise((resolve) => setTimeout(() => resolve('late'), HANDOFF_WAIT_MS))]);
if (typeof early === 'object' && early?.handled) await new Promise((resolve) => setTimeout(resolve, 1000));
const page = (await theme).mount({ api, self, send });
handoff.then((res) => res?.openPalette && page.openPalette());
