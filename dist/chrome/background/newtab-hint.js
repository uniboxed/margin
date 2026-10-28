// Safari gives ⌘T to Margin (its new-tab page, which hands off to the
// palette) only while Safari Settings → General → "New tabs open with" is
// Margin. Safari sets it back to its own choice (Homepage, say) whenever it
// turns Margin off, which happens at every Safari launch while the build is
// unsigned, and no extension API can read or set it. So Margin watches for
// the sign of it: tabs that open in front, from nothing (no opener, not
// opened by Margin, not a new window's first tab), on the same web page
// twice within a run of Safari, while Margin's new-tab page doesn't show.
// That page then gets a note on how to set it (content/core.js, which also
// checks the page was opened from nothing: no referrer, its first history
// entry), at most once a run, unless turned off (settings.newTabHint).
// Bookmarks opened twice in new tabs look the same, hence "twice" and the
// way to turn it off.
import { platform } from '../shared/platform.js';
import * as M from '../state/model.js';
import * as V from '../shared/view.js';
import { api, load } from './store.js';
import { marginOpenedAt } from './tabs.js';
import { reportEvent } from './onboarding.js';

const KEY = 'newTabHint'; // storage.session: { seen: { [url]: count }, shown: boolean }
const CANDIDATE_MS = 3000; // its first web address must come this soon
const OWN_TAB_MS = 2000; // a tab created this soon after Margin opened one is Margin's

const candidates = new Map(); // tabId → when it was created
const pendingNote = new Set(); // tabIds to tell once their page has loaded

const enabled = () => !!platform?.newTabHint && !!api.storage?.session;
async function read() {
  return (await api.storage.session.get(KEY).catch(() => null))?.[KEY] ?? { seen: {}, shown: false };
}
const write = (value) => api.storage.session.set({ [KEY]: value }).catch(() => {});

/** tabs.onCreated */
export function tabCreated(tab) {
  if (!enabled() || !tab.active || tab.openerTabId != null || tab.index === 0 || Date.now() - marginOpenedAt < OWN_TAB_MS) return;
  const url = tab.pendingUrl || tab.url || '';
  if (V.isNewTabPage(url) || /^[a-z-]+-extension:/i.test(url)) return;
  candidates.set(tab.id, Date.now());
  if (/^https?:/i.test(url)) void tabAddress(tab.id, url);
}

/** tabs.onUpdated: its address, or its load finishing. */
export async function tabAddress(tabId, url) {
  const at = candidates.get(tabId);
  if (at == null) return;
  if (Date.now() - at > CANDIDATE_MS) return void candidates.delete(tabId);
  if (!/^https?:/i.test(url)) return; // about:blank first, say: wait for the web address
  candidates.delete(tabId);
  reportEvent('otherNewTabPage'); // a new tab from nothing opened a web page, not Margin's (Mac app's set-up window)
  const hint = await read();
  if (hint.shown) return;
  const key = M.normalizeUrl(url);
  const count = (hint.seen[key] ?? 0) + 1;
  // Only the addresses that came this way: a handful at most.
  const seen = Object.fromEntries([...Object.entries(hint.seen).slice(-9), [key, count]]);
  await write({ ...hint, seen });
  if (count < 2 || (await load()).settings?.newTabHint === false) return;
  pendingNote.add(tabId);
  // Already loaded meanwhile: no 'complete' left to wait for.
  if ((await api.tabs.get(tabId).catch(() => null))?.status === 'complete') tabLoaded(tabId);
}

/** tabs.onUpdated with status complete: the page can show the note now. */
export function tabLoaded(tabId) {
  if (!pendingNote.delete(tabId)) return;
  // Shown once a run, counted only once the page showed it (no Margin
  // there, or not a page opened from nothing: the next one may).
  api.tabs.sendMessage(tabId, { type: 'newtab-hint' }).then(async (shown) => {
    if (shown === true) await write({ ...(await read()), shown: true });
  }, () => {});
}

export function tabGone(tabId) {
  candidates.delete(tabId);
  pendingNote.delete(tabId);
}

/** Margin's new-tab page showed up for a new tab: the setting is Margin. */
export async function newTabPageSeen() {
  reportEvent('marginNewTabPage'); // Mac app's set-up window: new tabs and windows open Margin
  if (!enabled()) return;
  candidates.clear();
  pendingNote.clear();
  const hint = await read();
  if (hint.shown || Object.keys(hint.seen).length) await write({ seen: {}, shown: false });
}
