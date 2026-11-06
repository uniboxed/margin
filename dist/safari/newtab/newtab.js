// Margin's new-tab page (the browser's new-tab override) and its start page
// (#launcher; #settings: with its Settings open). While Margin.app is linked,
// the app's overlay draws the theme's launcher and Settings over this page's
// place (ui/host-app.js), and the page draws nothing of its own. Not linked
// (Margin 2: nothing of Margin's UI is drawn in pages, this one included), it
// says Margin.app isn't running, with a button that starts it and an address
// field, so a new tab still works; or, when the app is running but sent no
// link (appLink.why 'no-link', background/link.js), that it isn't answering,
// with no button (it's running: starting it does nothing). It's loaded again
// when the link comes or goes. (Phase 7 makes the prompt to install the app.)
import { platform } from '../shared/platform.js';
import { resolveInput } from '../shared/search.js';
import * as shortcuts from '../shared/shortcuts.js';
import { APP_LINK_KEY, appDraws } from '../shared/app-link.js';
/** @import { MessageType, Request, Result } from '../../types/margin' */

const api = globalThis.browser ?? globalThis.chrome;

// Never waited on forever: a request with no answer in SEND_TIMEOUT_MS
// resolves to nothing, as a failed one does.
const SEND_TIMEOUT_MS = 8000;
/**
 * @template {MessageType} K
 * @param {K} type a handler in background.js
 * @param {Request<K>} [payload]
 * @returns {Promise<Result<K> | undefined>}
 */
async function send(type, payload = /** @type {any} */ ({})) {
  let timer;
  const res = await Promise.race([
    Promise.resolve(api.runtime.sendMessage({ type, ...payload })).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), SEND_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
  if (res && !res.ok) console.warn('[margin]', type, res.error);
  return res?.ok ? res.result : undefined;
}

// ---- ⌘T / ⌘N ----------------------------------------------------------------
// A fresh new tab (not Back, not a reload, not the start page) asks the
// background at once: linked, ⌘T over a web page goes back to the tab the
// user was on, with the app's palette over it, and this tab closes; else the
// app's palette opens over this page (background/handlers.js newTabPage).
// `?again`: a page from a copy of Margin that's gone, loaded again at this
// copy's address (background/cut-off.js oldOwnPageAddress), not a new tab.
const nav = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType?.('navigation')?.[0]);
const isLauncher = location.hash === '#launcher' || location.hash === '#settings';
const fresh = history.length <= 1 && (!nav || nav.type === 'navigate') && !isLauncher && !/[?&]again\b/.test(location.search);
if (fresh) void send('newTabPage');

const { [APP_LINK_KEY]: appLinkNow } = await api.storage.local.get(APP_LINK_KEY);
const drawnByApp = appDraws(appLinkNow);
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(APP_LINK_KEY in changes)) return;
  const now = changes[APP_LINK_KEY].newValue;
  if (appDraws(now) !== drawnByApp) location.reload();
  else if (!drawnByApp) describe(now);
});
const self = await api.tabs.getCurrent();
// Next/previous tab and space from Settings' shortcuts, as on web pages.
let settingsNow = (await api.storage.local.get('settings')).settings ?? null;
api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) settingsNow = changes.settings.newValue ?? null; });
shortcuts.installNavigation({ send, getSettings: () => settingsNow });
// Whether this page is shown, as web pages say it (content/core.js tellVisibility): at each change,
// at the start and when the background asks.
const tellVisibility = () => { if (platform?.nativeApp) void send('visibility', { visible: document.visibilityState === 'visible', at: Date.now() }); };
document.addEventListener('visibilitychange', tellVisibility);
addEventListener('pageshow', (event) => event.persisted && tellVisibility());
tellVisibility();
// The background switching from this tab (next/previous tab): never covered here.
api.runtime.onMessage.addListener((message, _, sendResponse) => {
  if (message?.type === 'switching' && message.from === self?.id) sendResponse(false);
  if (message?.type === 'reportVisibility') tellVisibility();
  // ⌘T or the palette's key with this page in front, not linked: its address field.
  if (message?.type === 'command' && message.tabId === self?.id && !drawnByApp) address()?.focus();
});
const address = () => /** @type {HTMLInputElement | null} */ (document.getElementById('address'));

if (!drawnByApp) showNotice();

// Not running, or running and not answering (it sent no link): said in the
// notice; the start button only for the first.
function describe(appLink) {
  const title = document.getElementById('title');
  const why = document.getElementById('why');
  const start = /** @type {HTMLButtonElement | null} */ (document.getElementById('start'));
  if (!title || !why || !start || !platform?.nativeApp) return;
  const noLink = appLink?.why === 'no-link';
  title.textContent = noLink ? 'Margin.app isn’t answering' : 'Margin.app isn’t running';
  why.textContent = noLink
    ? 'Margin.app is running but didn’t link to Margin. Margin keeps asking; this page changes once it’s linked.'
    : 'Margin’s sidebar, palette and Settings are drawn by Margin.app.';
  start.hidden = noLink;
}

function showNotice() {
  const notice = document.getElementById('notice');
  const start = /** @type {HTMLButtonElement} */ (document.getElementById('start'));
  const status = /** @type {HTMLElement} */ (document.getElementById('status'));
  if (!notice) return;
  notice.hidden = false;
  // Only where Margin.app can be linked (Safari for now: Chrome and Edge are
  // Phase 5): the button asks for the link, which has Margin's extension
  // handler start the app if it isn't running (background/link.js); the page
  // is loaded again once it's linked.
  if (platform?.nativeApp) {
    start.hidden = false;
    describe(appLinkNow);
    let timer = null;
    start.addEventListener('click', async () => {
      start.disabled = true;
      status.textContent = 'Starting Margin.app…';
      clearTimeout(timer);
      const asked = await send('startApp');
      if (asked === false) status.textContent = 'Margin can’t reach Margin.app from here.';
      timer = setTimeout(() => {
        start.disabled = false;
        status.textContent = 'Margin.app didn’t answer. Try again, or open it from your Applications folder.';
      }, asked === false ? 0 : 15000);
    });
  } else {
    /** @type {HTMLElement} */ (document.getElementById('why')).textContent = 'Margin’s sidebar, palette and Settings are drawn by Margin.app, which works with Safari for now.';
  }
  // The address field: an address opens here, anything else is searched
  // with the search engine Settings name (background/handlers.js search).
  document.getElementById('go')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const target = resolveInput(address()?.value ?? '');
    if (!target || self?.id == null) return;
    if (target.kind === 'url') void api.tabs.update(self.id, { url: target.url });
    else void send('search', { query: target.query, tabId: self.id });
  });
  address()?.focus();
}
