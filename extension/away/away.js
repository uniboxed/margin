// Margin's stand-in page (background/away.js, app/WINDOWS.md §9): in front of a window whose chosen tab is shown
// live in another window of the profile. It shows that tab's picture (taken as it left, kept in the background's
// memory only), faded, and its title; a click, Return or Space brings the tab back to this window, as the window
// coming to the front does. Never a Margin tab (state/model.js upsertTab), never kept or synced. It answers
// Margin.app's handoff as the new-tab page does (its visibility, the frame probe).
import { platform } from '../shared/platform.js';
import { probeFrames, watchVisible } from '../shared/frame-probe.js';

const api = globalThis.browser ?? globalThis.chrome;
const SEND_TIMEOUT_MS = 8000;
/** @param {string} type @param {Record<string, unknown>} [payload] */
async function send(type, payload = {}) {
  let timer;
  const res = await Promise.race([
    Promise.resolve(api.runtime.sendMessage({ type, ...payload })).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), SEND_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
  return res?.ok ? res.result : undefined;
}

const picture = /** @type {HTMLImageElement} */ (document.getElementById('picture'));
const title = /** @type {HTMLElement} */ (document.getElementById('title'));
/** @type {number | null} */
let shownTab = null;
// What the window shows away: drawn again only when that's another tab, or its picture came since.
async function draw() {
  const away = /** @type {{ tabId: number, title: string, picture: string | null } | null | undefined} */ (await send('awayShown'));
  if (!away) return;
  if (away.tabId === shownTab && (picture.getAttribute('src') || !away.picture)) return;
  shownTab = away.tabId;
  title.textContent = away.title;
  document.title = away.title || 'Open in another window';
  if (away.picture && away.picture.startsWith('data:image/')) picture.src = away.picture;
  else picture.removeAttribute('src');
}
void draw();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void draw(); });
addEventListener('pageshow', (event) => { if (event.persisted) void draw(); });

let bringing = false;
const bringBack = () => {
  if (bringing) return;
  bringing = true;
  void send('bringAway').finally(() => { bringing = false; });
};
document.addEventListener('click', bringBack);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    bringBack();
  }
});

// Whether this page is shown, as the new-tab page says it (newtab.js tellVisibility).
const tellVisibility = () => { if (platform?.nativeApp) void send('visibility', { visible: document.visibilityState === 'visible', at: Date.now(), from: 'away' }); };
document.addEventListener('visibilitychange', tellVisibility);
addEventListener('pageshow', (event) => event.persisted && tellVisibility());
tellVisibility();
const visibleAt = watchVisible();
const self = await Promise.resolve(api.tabs.getCurrent()).catch(() => null);
api.runtime.onMessage.addListener((/** @type {any} */ message, /** @type {any} */ _, /** @type {(answer: unknown) => void} */ sendResponse) => {
  if (message?.type === 'switching' && message.from === self?.id) sendResponse(false);
  if (message?.type === 'reportVisibility') tellVisibility();
  if (message?.type === 'awayChanged') void draw();
  // Margin.app's profile handoff asking whether this page draws frames at the full-screen size.
  if (message?.type === 'frameProbe') {
    void probeFrames(message, { visibleAt }).then((answer) => sendResponse(answer), () => sendResponse(null));
    return true;
  }
  return undefined;
});
