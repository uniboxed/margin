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


// A repeated key/click while Safari creates the same saved tab shares that creation.
const reopening = new Map<string, Promise<BrowserTab>>();
export async function restoreKept(keptId: string, options: Parameters<typeof reopenKept>[1] = {}) {
  const key = `${options.windowId ?? 'focused'}:${keptId}`;
  const pending = reopening.get(key);
  if (pending) return pending;
  const opening = reopenKept(keptId, options);
  reopening.set(key, opening);
  try { return await opening; } finally { if (reopening.get(key) === opening) reopening.delete(key); }
}
export async function openKept(keptId: string, options: Parameters<typeof reopenKept>[1] = {}) {
  const tab = await restoreKept(keptId, options);
  return { shown: tab.id };
}
