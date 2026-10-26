import * as M from '../state/model.js';
import { api, mutate, newId, now } from './store.js';

// Close stale tabs and add them to the archive. Runs on wake, on a
// browser.alarms schedule when available, else (throttled) on tab activation.
export async function archiveStale() {
  let stale = [];
  await mutate((s) => {
    stale = M.staleTabs(s, now());
    return stale.reduce((st, tab) => M.archiveTab(st, M.archiveEntryForTab(st, tab, { id: newId(), closedAt: now() })), s);
  });
  if (stale.length) {
    console.log('[margin] archived', stale.length, 'tab(s)');
    await api.tabs.remove(stale.map((t) => t.id)).catch((err) => console.warn('[margin] archive', err));
  }
  return stale.length;
}

let lastCheck = 0;
export function archiveStaleThrottled() {
  if (now() - lastCheck < 5 * 60_000) return;
  lastCheck = now();
  archiveStale();
}

export const ARCHIVE_ALARM = 'margin-archive';
