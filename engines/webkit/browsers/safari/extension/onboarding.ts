// Margin's Mac app has a set-up window (app/macos/startup/ViewController.swift) that
// walks through what Safari needs: Margin on, allowed on every website, new
// tabs and windows opening Margin's page, ⌘T reaching Margin (Safari's File ›
// New Tab moved to another shortcut). The app sees the first itself; the
// rest only the extension can see, so it tells the app (native messaging:
// the app's extension handler passes it on to the app, while the app is open,
// as a distributed notification other apps on the Mac could listen to too).
// What's sent: whether Margin may run on every website, and the names of a
// few events with their time. No addresses, no page content. Safari only
// (platform.nativeApp); without the app (a temporary extension) the messages
// just fail.
//
// The app can't call the extension, so the extension can't know when it
// opens: events always go (they come from the user: ⌘T, a new tab or
// window); access goes when it changes, and again until the app has heard it
// (on page loads, less and less often while the app stays closed, and at once
// when an event finds it open).
import { platform } from '../../../../../extension/shared/platform.ts';
import { api } from '../../../../../extension/background/store.ts';

const APP = 'io.tirth.margin';
const ACCESS_EVERY_MS = 30_000; // a page loading re-checks access at most this often (grants from Safari's own controls send no event)
const RETRY_MS = [15_000, 5 * 60_000]; // access the app didn't hear: tried again after this long, doubling up to the second
const SAME_EVENT_MS = 1000; // one event, reported from two places (the new-tab page's own report and the tab's creation)

let heard: boolean | null = null; // the access the app last heard (null: not heard)
let tried: boolean | null = null; // the access last sent, heard or not
let retryMs = 0;
let retryAt = 0;
let accessCheckedAt = 0;
const lastEvent = new Map();

const enabled = () => !!platform?.nativeApp && typeof api.runtime?.sendNativeMessage === 'function';

// Whether the app was open to hear it (the handler says).
async function send(message: { type: string; allSites: any; } | { type: string; name: any; }) {
  try {
    const reply = await api.runtime.sendNativeMessage(APP, { v: 1, ...message, at: Date.now() });
    return reply?.appOpen === true;
  } catch {
    return false; // no app (a temporary extension), or it failed
  }
}

// Whether Margin may run on every website: when it changed, or the app hasn't
// heard it yet.
export async function reportAccess({ force = false } = {}) {
  if (!enabled()) return;
  accessCheckedAt = Date.now();
  const all = await api.permissions.contains({ origins: ['<all_urls>'] }).catch(() => null);
  if (all == null || (all === heard && !force)) return;
  if (!force && heard === null && all === tried && Date.now() < retryAt) return; // the app was closed: not yet (a change goes at once)
  tried = all;
  if (await send({ type: 'status', allSites: all })) {
    heard = all;
    retryMs = 0;
    retryAt = 0;
  } else {
    heard = null;
    retryMs = Math.min(Math.max(retryMs * 2, RETRY_MS[0]), RETRY_MS[1]);
    retryAt = Date.now() + retryMs;
  }
}

// A page loaded: a chance to notice access granted from Safari's own controls.
export function pageLoaded() {
  if (Date.now() - accessCheckedAt >= ACCESS_EVERY_MS) void reportAccess();
}

// 'cmdTKey' (⌘T reached Margin), 'safariNewTab' (Safari's own New Tab made a
// tab: ⌘T not moved yet, its + button, its File menu), 'marginNewWindowPage' /
// 'marginNewTabPage' (Safari opened Margin's page for a new window / tab),
// 'otherNewTabPage' (a new tab from nothing opened a web page: Safari's
// homepage, or a link from another app), 'homepageNewTab' (the same page
// twice: Safari's homepage, most likely).
export function reportEvent(name: string) {
  if (!enabled()) return;
  const now = Date.now();
  if (now - (lastEvent.get(name) ?? 0) < SAME_EVENT_MS) return;
  lastEvent.set(name, now);
  void send({ type: 'event', name }).then((open) => {
    if (open && heard === null) void reportAccess({ force: true });
  });
}
