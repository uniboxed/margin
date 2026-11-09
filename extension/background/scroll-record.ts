// The scroll record (DATA.md "The scroll record"): where each open tab's page is scrolled, kept on
// its record (state/model.ts noteScroll) so a tab Margin closes and keeps (a window closed by
// Margin.app's switch, a tab put to sleep) opens again where it was, once (takeScroll). Pages say it
// as they're hidden or left (content/core.ts); the drafts check before a close and the sleep check
// say it from their answer (background/sleep.ts). Nothing here is logged: no address, no place.
import * as M from '../state/model.ts';
import { mutate } from './store.ts';

// A scroll alone isn't worth a write of its own: it goes with the next one, or this long after.
export const SCROLL_WRITE_MS = 5000;

export function keepScroll(tabId: number, url: string, y: number) {
  if (!Number.isInteger(tabId) || typeof url !== 'string' || !Number.isFinite(y)) return Promise.resolve(null);
  return mutate((s) => M.noteScroll(s, tabId, { y, url }), { within: () => SCROLL_WRITE_MS });
}

// Several at once (a window's tabs, asked before its close): one change.
export function keepScrolls(list: { tabId: number, url: string, y: number }[]) {
  const good = list.filter((x) => Number.isInteger(x.tabId) && typeof x.url === 'string' && Number.isFinite(x.y));
  if (!good.length) return Promise.resolve(null);
  return mutate((s) => good.reduce((st, x) => M.noteScroll(st, x.tabId, { y: x.y, url: x.url }), s), { within: () => SCROLL_WRITE_MS });
}

// A reopened Margin tab's page taking its scroll: the place (null: none), then it's gone.
export async function takeScroll(tabId: number, url: string): Promise<number | null> {
  if (!Number.isInteger(tabId) || typeof url !== 'string') return null;
  let y = null;
  await mutate((s) => {
    const taken = M.takeScroll(s, tabId, url);
    y = taken.y;
    return taken.state;
  }, { within: () => SCROLL_WRITE_MS });
  return y;
}
