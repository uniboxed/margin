// Margin's Mac app has a set-up window (app/safari/ViewController.swift) that
// walks through what Safari needs: Margin on, allowed on every website, new
// tabs and windows opening Margin's page, ⌘T reaching Margin (Safari's File ›
// New Tab moved to another shortcut). The app sees the first itself; the
// rest only the extension can see, so it tells the app (native messaging:
// the app's extension handler passes it on to the app). What's sent: whether
// Margin may run on every website, and the names of a few events with their
// time. Nothing else, and nowhere else. Safari only (platform.nativeApp);
// without the app (a temporary extension) the messages just fail.
import { platform } from '../shared/platform.js';
import { api } from './store.js';

const APP = 'io.tirth.margin';
const AWAY_MS = 5 * 60_000; // the app isn't open: events wait this long before trying again
const ACCESS_EVERY_MS = 30_000; // a page loading re-checks access at most this often (grants from Safari's own controls send no event)

let lastAllSites = null;
let appAwayUntil = 0;
let accessCheckedAt = 0;

const enabled = () => !!platform?.nativeApp && typeof api.runtime?.sendNativeMessage === 'function';

async function send(message) {
  if (!enabled()) return null;
  try {
    const reply = await api.runtime.sendNativeMessage(APP, { v: 1, ...message, at: Date.now() });
    // The handler says whether the app is open to hear it.
    appAwayUntil = reply?.appOpen === false ? Date.now() + AWAY_MS : 0;
    return reply;
  } catch {
    appAwayUntil = Date.now() + AWAY_MS; // no app (a temporary extension), or it failed
    return null;
  }
}

// Whether Margin may run on every website, when it changed (or first, at start).
export async function reportAccess({ force = false } = {}) {
  if (!enabled()) return;
  accessCheckedAt = Date.now();
  const all = await api.permissions.contains({ origins: ['<all_urls>'] }).catch(() => null);
  if (all == null || (all === lastAllSites && !force)) return;
  lastAllSites = all;
  await send({ type: 'status', allSites: all });
}

// A page loaded: a chance to notice access granted from Safari's own controls.
export function pageLoaded() {
  if (Date.now() - accessCheckedAt >= ACCESS_EVERY_MS) void reportAccess();
}

// 'cmdTKey' (⌘T reached Margin), 'safariNewTab' (Safari's own New Tab made a
// tab: ⌘T not moved yet, or its + button), 'marginNewTabPage' (a new tab or
// window opened Margin's page), 'otherNewTabPage' (it opened another page).
export function reportEvent(name) {
  if (!enabled() || Date.now() < appAwayUntil) return;
  void send({ type: 'event', name });
}
