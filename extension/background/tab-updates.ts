// A tab's changes as it loads and runs (tabs.onUpdated: its address, title,
// icon, its page loaded), into the state. Every write of the state reaches
// every open page (storage.onChanged: about 1 ms in each hidden one, more in
// the one in front and in Safari itself), and a page Safari suspended takes
// the ones it missed as it's shown, on the switch's way. So a hidden tab's
// changes are gathered for GATHER_MS into one write, and its title alone (a
// chat counting messages, a page's timer) is written at most every
// TITLE_EVERY_MS: its row shows them that much later. The state has each
// change at once, in order with every other (store.ts mutate `within`), and
// any write before then (a switch, a tab opened or closed, the tab in front
// changing) takes them along. The tab in front, one not known yet, and a
// hidden tab's new address are written at once.
import type { State } from '../../types/margin';
import * as M from '../state/model.ts';
import { mutate, now } from './store.ts';

export const GATHER_MS = 300;
export const TITLE_EVERY_MS = 2000;
const TRACKED = ['title', 'url', 'favIconUrl'];

// Tab id → when the write that takes its last title alone was due.
const titleDue = new Map();

// The change made (null: nothing to make).
export function tabUpdated(tabId: number, change: BrowserTabChange, tab: BrowserTab) {
  if (!TRACKED.some((k) => k in change) && change.status !== 'complete') return null;
  return mutate((s) => M.upsertTab(s, tab, now()), { within: (s) => waitFor(s, tabId, change, tab) });
}

// Gone: forgotten (background.ts tabs.onRemoved).
export function tabGone(tabId: number) {
  titleDue.delete(tabId);
}

// How long the write may wait (null: none), from the state before the change.
function waitFor(s: State, tabId: number, change: BrowserTabChange, tab: BrowserTab) {
  const known = s.tabs[tabId];
  // Safari can say active: true for a tab just left (model.ts upsertTab):
  // either one saying it's in front writes at once.
  if (!known || known.active || tab.active) return null;
  // A new address (in the event, or only in the tab with its load: a
  // redirect) at once: after a restart or an update tabs are matched to their
  // records by it (model.ts matchTabs), and a write lost with the background
  // stopping would leave the tab in the window's active space. Not a new
  // fragment alone (the same page there), nor its going to sleep or waking
  // (its record keeps the page's address: model.ts seenTab).
  const seen = M.seenTab(tab);
  if (M.normalizeUrl(seen.url || seen.pendingUrl || known.url) !== M.normalizeUrl(known.url)) return null;
  const titleOnly = 'title' in change && !('url' in change) && !('favIconUrl' in change) && change.status !== 'complete';
  if (!titleOnly || known.title === change.title) return GATHER_MS;
  // A clock that only runs forward: the Mac's set back would hold it back as long.
  const t = performance.now();
  const due = titleDue.get(tabId) ?? -Infinity;
  // One still to come takes this one too; else the next is TITLE_EVERY_MS after it.
  const at = due > t ? due : Math.max(t + GATHER_MS, due + TITLE_EVERY_MS);
  titleDue.set(tabId, at);
  return at - t;
}
