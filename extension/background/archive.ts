import * as M from '../state/model.ts';
import { mutate, newId, now } from './store.ts';
import { closeTabs } from './closing.ts';

// Close stale tabs and add them to the archive. Runs on wake, on a
// browser.alarms schedule when available, else (throttled) on tab activation.
// Open or not (PLAN.md §6): a Margin tab that isn't open goes to the archive
// by the same rule, with nothing to close.
export async function archiveStale() {
  let stale = [];
  let kept = [];
  await mutate((s) => {
    stale = M.staleTabs(s, now());
    kept = M.staleKept(s, now());
    const next = kept.reduce((st, k) => M.archiveKept(st, k.id, { id: newId(), closedAt: now() }), s);
    return stale.reduce((st, tab) => M.archiveTab(st, M.archiveEntryForTab(st, tab, { id: newId(), closedAt: now() })), next);
  });
  if (stale.length || kept.length) console.log('[margin] archived', stale.length + kept.length, 'tab(s)', kept.length ? `(${kept.length} not open)` : '');
  // Archived above: their closes, heard, do nothing more.
  if (stale.length) await closeTabs(stale.map((t) => t.id), 'done').catch((err) => console.warn('[margin] archive', err));
  return stale.length + kept.length;
}

let lastCheck = 0;
export function archiveStaleThrottled() {
  if (now() - lastCheck < 5 * 60_000) return;
  lastCheck = now();
  archiveStale();
}

export const ARCHIVE_ALARM = 'margin-archive';
