// Margin's new-tab page (the browser's new-tab override). It never draws anything of Margin's (2026-11-27, Tirth: with
// Margin.app not running, or in a window that isn't Margin's, the browser is as it is without Margin; and Margin needs
// no page of its own for a new tab: Arc's palette over the page).
// - A window Margin.app draws (linked, `drawn` not false): a fresh new tab (Safari's ⌘T, its + button, File › New Tab)
//   is the background's to hand off (handlers.ts newTabHandOff): back to the tab the person was on, Margin's palette
//   over it, this tab closed; else the app's palette over this page. The page draws nothing.
// - Otherwise (Margin.app not linked, or a window it doesn't draw: the person's own): a fresh new tab goes to the
//   browser's own new tab (shared/own-new-tab.ts: Safari's start page, Chrome's new tab; Edge, none: left blank). Once a
//   tab: what it goes to isn't this page, and this page loaded again in that tab isn't `fresh` (its history).
// - Anything else (Back to it, a reload, a tab already on it as the app quits, `#launcher`, `#settings`, a page from a
//   copy that's gone): blank, titled as any new tab. Never sent anywhere then (Back would come straight back here).
// A window Margin.app asked for (`?mark=`, Windows): its title carries the mark until the app shows an item there.
import { capabilities } from '../shared/capabilities.ts';
import { ownNewTabUrl } from '../shared/own-new-tab.ts';
import * as shortcuts from '../shared/shortcuts.ts';
import { APP_LINK_KEY, drawsWindow } from '../shared/app-link.ts';
import type { MessageType, Request, Result } from '../../types/margin';

const api = globalThis.browser ?? globalThis.chrome;

// Never waited on forever: a request with no answer in SEND_TIMEOUT_MS
// resolves to nothing, as a failed one does.
const SEND_TIMEOUT_MS = 8000;
/**
 * @param type a handler in background.ts
 * */
async function send<K extends MessageType>(type: K, payload: Request<K> = ({} as any)): Promise<Result<K> | undefined> {
  let timer: Timer | undefined;
  const res = await Promise.race([
    Promise.resolve(api.runtime.sendMessage({ type, ...payload })).catch(() => null),
    new Promise<any>((resolve) => { timer = setTimeout(() => resolve(null), SEND_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
  if (res && !res.ok) console.warn('[margin]', type, res.error);
  return res?.ok ? res.result : undefined;
}

// ---- ⌘T / ⌘N ----------------------------------------------------------------
// A fresh new tab (not Back, not a reload, not the start page) asks the background at once (newTabHandOff).
// `?again`: a page from a copy of Margin that's gone, loaded again at this copy's address (background/cut-off.ts
// oldOwnPageAddress), not a new tab. `?mark=<mark>`: a window Margin.app asked for (background/handlers.ts newWindow
// `mark`): its title carries the mark, which Windows finds the window by; never a new tab to hand off.
const nav = (performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined);
const mark = /^[A-Za-z0-9]{8,40}$/.exec(new URLSearchParams(location.search).get('mark') ?? '')?.[0] ?? null;
const isLauncher = location.hash === '#launcher' || location.hash === '#settings';
const fresh = history.length <= 1 && (!nav || nav.type === 'navigate') && !isLauncher && !/[?&]again\b/.test(location.search) && !mark;
// (Its title: the mark's; Settings' and Margin's start page's, which a sidebar row shows; else any new tab's.)
const pageTitle = () => { document.title = mark ? `Margin ${mark}` : location.hash === '#settings' ? 'Settings' : location.hash === '#launcher' ? 'Margin' : 'New Tab'; };
pageTitle();
addEventListener('hashchange', pageTitle);
if (fresh) void send('newTabPage');

const self = await Promise.resolve(api.tabs.getCurrent()).catch(() => null);
const appLink = (await Promise.resolve(api.storage.local.get(APP_LINK_KEY)).catch(() => null))?.[APP_LINK_KEY];
// Margin.app takes it: it draws over this window (the background hands the new tab to its palette).
const taken = drawsWindow(appLink, self?.windowId ?? null);
if (fresh && !taken && self?.id != null) {
  const ownNewTab = ownNewTabUrl(capabilities?.name, navigator.userAgent);
  const handed = ownNewTab != null && await Promise.resolve(api.tabs.update(self.id, { url: ownNewTab })).then(() => true, (err) => {
    console.info('[margin] new tab: the browser\'s own new tab refused:', String(err?.message ?? err));
    return false;
  });
  console.info(`[margin] new tab ${self.id}: ${handed ? `handed to the browser's own (${ownNewTab})` : 'left blank'} (${appLink?.state === 'linked' || appLink?.state === 'reconnecting' ? 'not a window of Margin.app\'s' : 'Margin.app not linked'})`);
}

// Next/previous tab and space from Settings' shortcuts, as on web pages.
let settingsNow = (await api.storage.local.get('settings')).settings ?? null;
api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) settingsNow = changes.settings.newValue ?? null; });
shortcuts.installNavigation({ send, getSettings: () => settingsNow });
// The background switching from this tab (next/previous tab): never covered here.
api.runtime.onMessage.addListener((message, _, sendResponse) => {
  if (message?.type === 'switching' && message.from === self?.id) sendResponse(false);
});
