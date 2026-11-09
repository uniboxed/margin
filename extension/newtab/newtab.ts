// Margin's new-tab page (the browser's new-tab override) and its start page
// (#launcher; #settings: with its Settings open). While Margin.app is linked
// and draws over this page's window, the app's overlay draws the theme's
// launcher and Settings over this page's place (ui/host-app.ts), and the page
// draws nothing of its own. Not linked (Margin 2: nothing of Margin's UI is
// drawn in pages, this one included), it says Margin.app isn't running, with
// a button that starts it and an address field, so a new tab still works; or,
// when the app is running but sent no link (appLink.why 'no-link',
// background/link.ts), that it isn't answering, with no button (it's
// running: starting it does nothing); or, when Margin turned its link off
// itself (appLink.why 'sockets-off': a socket a background began never
// opened), when and until when, with Try again (retryLink). Linked, but the app draws nothing over
// this window (appLink.drawn false: not in full screen, or not found yet), it
// says so, with the address field and no button. It's loaded again when what
// it shows should change: told by storage events, and read again right after
// it starts listening (a write between its first read and its listener would
// be missed), whenever it's shown or focused, and back from the back/forward
// cache (a suspended page misses storage events). (Phase 7 makes the prompt
// to install the app.)
import { platform } from '../shared/platform.ts';
import { resolveInput } from '../shared/search.ts';
import * as shortcuts from '../shared/shortcuts.ts';
import { APP_LINK_KEY, appDraws, undrawn } from '../shared/app-link.ts';
import { probeFrames, watchVisible } from '../shared/frame-probe.ts';
import type { MessageType, Request, Result } from '../../types/margin';

const api = globalThis.browser ?? globalThis.chrome;

// Never waited on forever: a request with no answer in SEND_TIMEOUT_MS
// resolves to nothing, as a failed one does.
const SEND_TIMEOUT_MS = 8000;
/**
 * @param type a handler in background.ts
 * */
async function send<K extends MessageType>(type: K, payload: Request<K> = ({} as any)): Promise<Result<K> | undefined> {
  let timer;
  const res = await Promise.race([
    Promise.resolve(api.runtime.sendMessage({ type, ...payload })).catch(() => null),
    new Promise<any>((resolve) => { timer = setTimeout(() => resolve(null), SEND_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
  if (res && !res.ok) console.warn('[margin]', type, res.error);
  return res?.ok ? res.result : undefined;
}

// ---- ⌘T / ⌘N ----------------------------------------------------------------
// A fresh new tab (not Back, not a reload, not the start page) asks the
// background at once: linked, ⌘T over a web page goes back to the tab the
// user was on, with the app's palette over it, and this tab closes; else the
// app's palette opens over this page (background/handlers.ts newTabPage).
// `?again`: a page from a copy of Margin that's gone, loaded again at this
// copy's address (background/cut-off.ts oldOwnPageAddress), not a new tab.
const nav = (performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined);
const isLauncher = location.hash === '#launcher' || location.hash === '#settings';
const fresh = history.length <= 1 && (!nav || nav.type === 'navigate') && !isLauncher && !/[?&]again\b/.test(location.search);
if (fresh) void send('newTabPage');

const self = await Promise.resolve(api.tabs.getCurrent()).catch(() => null);
const windowId = self?.windowId ?? null;
// What this page shows: 'app' (nothing: the app's overlay draws over it), 'undrawn' (linked, but
// the app draws nothing over this window), 'off' (not linked).
const modeOf = (link: any) => (!appDraws(link) ? 'off' : undrawn(link, windowId) ? 'undrawn' : 'app');
let mode: 'app' | 'undrawn' | 'off' | null = null; // decided by the first read
let appLinkNow = (null as any);
// What the link is now: loaded again if this page should show something else; else its words.
const take = (link: any) => {
  if (mode == null) return;
  if (modeOf(link) !== mode) return void location.reload();
  appLinkNow = link;
  if (mode !== 'app') describe(link);
};
const readLink = async () => (await Promise.resolve(api.storage.local.get(APP_LINK_KEY)).catch(() => null))?.[APP_LINK_KEY];
const checkLink = () => void readLink().then(take, () => {});
// Listening first, then the first read, then a second read (Safari may hand the listener over
// after a write the first read missed).
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && APP_LINK_KEY in changes) take(changes[APP_LINK_KEY].newValue);
});
appLinkNow = await readLink();
mode = modeOf(appLinkNow);
checkLink();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkLink(); });
addEventListener('pageshow', (event) => { if (event.persisted) checkLink(); });
addEventListener('focus', checkLink);
// Next/previous tab and space from Settings' shortcuts, as on web pages.
let settingsNow = (await api.storage.local.get('settings')).settings ?? null;
api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) settingsNow = changes.settings.newValue ?? null; });
shortcuts.installNavigation({ send, getSettings: () => settingsNow });
// Whether this page is shown, as web pages say it (content/core.ts tellVisibility): at each change,
// at the start and when the background asks.
const tellVisibility = () => { if (platform?.nativeApp) void send('visibility', { visible: document.visibilityState === 'visible', at: Date.now(), from: 'newtab' }); };
document.addEventListener('visibilitychange', tellVisibility);
addEventListener('pageshow', (event) => event.persisted && tellVisibility());
tellVisibility();
// When it last turned visible, for Margin.app's frame probe, which this page answers as web pages do.
const visibleAt = watchVisible();
// The background switching from this tab (next/previous tab): never covered here.
api.runtime.onMessage.addListener((message, _, sendResponse) => {
  if (message?.type === 'switching' && message.from === self?.id) sendResponse(false);
  if (message?.type === 'reportVisibility') tellVisibility();
  // Margin.app's profile handoff asking whether this page draws frames at the full-screen size.
  if (message?.type === 'frameProbe') {
    void probeFrames(message, { visibleAt }).then((answer) => sendResponse(answer), () => sendResponse(null));
    return true;
  }
  // ⌘T or the palette's key with this page in front, not the app's: its address field.
  if (message?.type === 'command' && message.tabId === self?.id && mode !== 'app') address()?.focus();
});
const address = () => (document.getElementById('address') as HTMLInputElement | null);

if (mode !== 'app') showNotice();

// Not running, running and not answering (it sent no link), or linked with
// nothing drawn over this window: said in the notice; the start button only
// for the first.
function describe(appLink) {
  const title = document.getElementById('title');
  const why = document.getElementById('why');
  const start = (document.getElementById('start') as HTMLButtonElement | null);
  const retry = (document.getElementById('retry') as HTMLButtonElement | null);
  if (!title || !why || !start) return;
  if (retry) retry.hidden = true;
  if (mode === 'undrawn') {
    title.textContent = 'Margin.app hasn’t placed this window yet';
    why.textContent = 'Margin.app draws Margin’s sidebar and palette around full-screen windows. Put this window in full screen, or wait a moment while Margin.app finds it; this page changes once it has.';
    start.hidden = true;
    return;
  }
  if (!platform?.nativeApp) return;
  if (appLink?.why === 'sockets-off') {
    title.textContent = 'Margin turned its link off';
    why.textContent = `Margin turned its link off at ${when(appLink.offAt)} after a socket never opened. `
      + (Number.isFinite(appLink.offUntil) ? `It tries again at ${when(appLink.offUntil)}.` : 'It tries again when Safari next starts.');
    start.hidden = true;
    if (retry) retry.hidden = false;
    return;
  }
  const noLink = appLink?.why === 'no-link';
  title.textContent = noLink ? 'Margin.app isn’t answering' : 'Margin.app isn’t running';
  why.textContent = noLink
    ? 'Margin.app is running but didn’t link to Margin. Margin keeps asking; this page changes once it’s linked.'
    : 'Margin’s sidebar, palette and Settings are drawn by Margin.app.';
  start.hidden = noLink;
}

// A time as the person reads it: the time of day, and the day too if it isn't today.
function when(at: unknown) {
  const d = new Date(Number.isFinite(at) ? (at as number) : Date.now());
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${time} on ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

function showNotice() {
  const notice = document.getElementById('notice');
  const start = (document.getElementById('start') as HTMLButtonElement);
  const status = (document.getElementById('status') as HTMLElement);
  if (!notice) return;
  notice.hidden = false;
  // Only where Margin.app can be linked (Safari for now: Chrome and Edge are
  // Phase 5): the button asks for the link, which has Margin's extension
  // handler start the app if it isn't running (background/link.ts); the page
  // is loaded again once it's linked.
  if (platform?.nativeApp) {
    start.hidden = false;
    describe(appLinkNow);
    let timer = null;
    // Try again (Margin turned its link off): sockets on again; the page changes once it's linked.
    document.getElementById('retry')?.addEventListener('click', async () => {
      const retry = (document.getElementById('retry') as HTMLButtonElement);
      retry.disabled = true;
      status.textContent = 'Trying again…';
      const asked = await send('retryLink');
      retry.disabled = false;
      status.textContent = asked === false ? 'Margin can’t reach Margin.app from here.' : '';
    });
    start.addEventListener('click', async () => {
      // Linked meanwhile (a word this page missed): loaded again, not started again.
      if (appDraws(await readLink())) return void location.reload();
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
     (document.getElementById('why') as HTMLElement).textContent = 'Margin’s sidebar, palette and Settings are drawn by Margin.app, which works with Safari for now.';
  }
  // The address field: an address opens here, anything else is searched
  // with the search engine Settings name (background/handlers.ts search).
  document.getElementById('go')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const target = resolveInput(address()?.value ?? '');
    if (!target || self?.id == null) return;
    if (target.kind === 'url') void api.tabs.update(self.id, { url: target.url });
    else void send('search', { query: target.query, tabId: self.id });
  });
  address()?.focus();
}
