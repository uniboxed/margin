// The sidebar's scroll position, one per window, so every page's sidebar
// opens where the last one was (content/core.ts, the new-tab page): one
// sidebar, not one per page. Kept in storage.session, which outlives the
// background's sleeps but not the browser.
import { api } from './store.ts';

const KEY = 'sidebarScroll';
let positions: Promise<any> | null = null; // Promise<{ [windowId]: px }>, read once (calls in between share it)
let saveTimer: Timer | null = null;

function load() {
  positions ??= (async () => (await api.storage.session?.get(KEY).catch(() => null))?.[KEY] ?? {})();
  return positions;
}

export async function getScroll(windowId: number) {
  return (await load())[windowId] ?? 0;
}

export async function setScroll(windowId: number, top: number) {
  const all = await load();
  all[windowId] = Math.max(0, Math.round(top));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.storage.session?.set({ [KEY]: all }).catch(() => {}), 500);
}
