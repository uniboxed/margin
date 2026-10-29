// Margin's new-tab page (the browser's new-tab override). What's on it is the
// active theme's: this module loads that theme's new-tab bundle
// (themes/<id>/newtab.bundle.js) and calls its mount(). Only that theme's
// code loads.
import { themeFor } from '../themes/index.js';
import { platform } from '../shared/platform.js';
/** @import { MessageType, Request, Result } from '../../types/margin' */

const api = globalThis.browser ?? globalThis.chrome;

/**
 * @template {MessageType} K
 * @param {K} type a handler in background.js
 * @param {Request<K>} [payload]
 * @returns {Promise<Result<K>>}
 */
// Never waited on forever (as on web pages, content/core.js send): a request
// with no answer in SEND_TIMEOUT_MS resolves to nothing, as a failed one does.
// A new tab from the palette answers once it's in front, after its page has
// loaded (background/tabs.js openBehind): longer.
const SEND_TIMEOUT_MS = 8000;
const LOADING_TIMEOUT_MS = 12000;
async function send(type, payload = {}) {
  let timer;
  const loading = type === 'newTab' || type === 'search';
  const waitMs = loading ? LOADING_TIMEOUT_MS : SEND_TIMEOUT_MS;
  // When this page stops waiting: the background doesn't switch after it.
  const res = await Promise.race([
    api.runtime.sendMessage({ type, ...(loading && !payload?.deadline ? { deadline: Date.now() + waitMs } : {}), ...payload }),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); }),
  ]).finally(() => clearTimeout(timer));
  if (res && !res.ok) console.warn('[margin]', type, res.error);
  return res?.result;
}

// ---- ⌘T / ⌘N ----------------------------------------------------------------
// Safari and Chrome never let extensions intercept ⌘T/⌘N; they open this
// page instead. On a fresh new tab (not Back, not a reload), ask the
// background at once, before anything else here (every moment this tab is in
// front shows): for ⌘T it opens the palette over the tab the user was on and
// shows that again, closing this one (Arc keeps the page; the keyboard is
// also in the address bar on a new tab, not here); otherwise (⌘N's first
// tab) the palette opens over this page.
const nav = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType?.('navigation')?.[0]);
// `newtab.html#launcher` opens the launcher on purpose and never redirects.
const fresh = history.length <= 1 && (!nav || nav.type === 'navigate') && location.hash !== '#launcher';
const handoff = fresh ? send('newTabPage').catch(() => null) : Promise.resolve(null);

// The theme loads right away, alongside the ⌘T answer.
const { settings } = await api.storage.local.get('settings');
const theme = import(api.runtime.getURL(themeFor(settings).newtab));
const self = await api.tabs.getCurrent();
// Chrome, "only in full screen" (content/core.js): outside full screen the
// theme shows just a note offering it; the page redraws when that changes.
// The background says which (background/fullscreen.js isFullscreen).
const outOfTheWay = async () =>
  !!platform?.marginFullscreen && settings?.fullscreenOnly !== false && !(await send('windowState').catch(() => null))?.fullscreen;
const windowed = await outOfTheWay();
if (platform?.marginFullscreen) {
  let recheck = null;
  const check = () => {
    clearTimeout(recheck);
    recheck = setTimeout(async () => { if ((await outOfTheWay()) !== windowed) location.reload(); }, 300);
  };
  addEventListener('resize', check);
  api.windows.onBoundsChanged?.addListener((win) => win.id === self?.windowId && check());
}

// Draw the page unless this tab is being closed for the hand-off: wait a
// moment for the answer (the background may be waking up), never longer, so
// the page can't stay blank. A tab that was to close but didn't gets drawn too.
const HANDOFF_WAIT_MS = 300;
const early = await Promise.race([handoff, new Promise((resolve) => setTimeout(() => resolve('late'), HANDOFF_WAIT_MS))]);
if (typeof early === 'object' && early?.handled) await new Promise((resolve) => setTimeout(resolve, 1000));
const page = (await theme).mount({ api, self, send, windowed });
handoff.then((res) => res?.openPalette && page.openPalette({ fresh: true }));
