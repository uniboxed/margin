import * as M from '../state/model.ts';
import * as V from '../shared/view.ts';
import { api, load } from './store.ts';
import { openTab } from './tabs.ts';
import { setScroll } from './scroll.ts';

// One reopen path for clicks, keyboard selection and restoring a space. The saved Margin id
// becomes the new browser tab's mid; its order and scroll record survive the handoff.
async function reopenKept(keptId: string, { windowId = null, deadline, sidebarTop }: { windowId?: number | null, deadline?: number, sidebarTop?: number } = {}) {
  const s = await load();
  const kept = s.keptTabs?.[keptId];
  if (!kept) throw new Error('That tab is no longer there');
  const win = windowId ?? (await api.windows?.getLastFocused?.().catch(() => null))?.id ?? undefined;
  if (Number.isFinite(sidebarTop) && win != null) void setScroll(win, sidebarTop as number); // (finite: checked)
  const spaceId = s.spaces.some((sp) => sp.id === kept.spaceId) ? kept.spaceId : V.activeSpaceId(s, win);
  // The window's tabs as Safari has them now (Margin's indexes lag after closes).
  const live = win != null ? await api.tabs.query({ windowId: win }).catch(() => null) : null;
  const index = win != null ? M.stripIndexFor(s, win, kept.order, live) : undefined;
  const tab = await openTab({ windowId: win, url: kept.url, spaceId, deadline, index, keptId });
  return tab;
}


// One creation per saved tab at a time, whoever asks (a key, a click, the palette, a space's
// tabs reopened behind its new window): a second ask while Safari makes it shares that tab, so a
// saved tab never comes back as two browser tabs. By its id alone: two asks with different
// windows (or one with none: the focused window) are still the same saved tab.
const reopening = new Map<string, { tab: Promise<BrowserTab | null>, behind: boolean }>();
export async function restoreKept(keptId: string, options: Parameters<typeof reopenKept>[1] = {}) {
  const pending = reopening.get(keptId);
  if (pending) {
    const tab = await pending.tab;
    if (!tab) throw new Error('That tab is no longer there');
    // Made behind its window (openKeptBehind): this ask wants it shown.
    if (pending.behind) await api.tabs.update(tab.id, { active: true }).catch(() => {});
    return tab;
  }
  const opening = reopenKept(keptId, options);
  reopening.set(keptId, { tab: opening, behind: false });
  try { return await opening; } finally { if (reopening.get(keptId)?.tab === opening) reopening.delete(keptId); }
}
/** A saved tab made by `make` behind its window (handlers.ts openKeptBehind), shared as restoreKept's are.
 *  Null, not made: it's being made already (that maker links it). */
export async function makeKeptBehind(keptId: string, make: () => Promise<BrowserTab | null>): Promise<BrowserTab | null> {
  if (reopening.has(keptId)) return null;
  const opening = make();
  reopening.set(keptId, { tab: opening, behind: true });
  try { return await opening; } finally { if (reopening.get(keptId)?.tab === opening) reopening.delete(keptId); }
}
export async function openKept(keptId: string, options: Parameters<typeof reopenKept>[1] = {}) {
  const tab = await restoreKept(keptId, options);
  return { shown: tab.id };
}
