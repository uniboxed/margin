// Margin.app hosting Safari in its own page area (docs/MARGIN-APP.md, behind the app's `MarginHosted`): the app owns
// the spaces and their items (its library) and keeps one Safari window per profile in use as the page area's; this
// copy only drives the tabs of that window. Two requests (link.ts APP_REQUESTS, docs/PROTOCOL.md "Hosted windows"):
//
// - `hostShow { windowId, itemId, url }`: the item's page shown in that window. The tab tagged with the item before
//   (still open, in that window) is used again; else a tab of that window at the same address no other item has;
//   else the window's lone new-tab page (Safari's first tab of a window Margin made) is sent there; else a new tab.
//   It comes to the front. Answers `{ tabId, created }` (`created`: a tab made or navigated for it).
// - `hostClose { itemId }`: the item's tab closed (closed from Margin's sidebar). Answers `{ closed }`.
//
// The tags (item → tab) are this copy's memory only: a copy restarted finds an item's tab again by its address.
// Nothing here touches the copy's own spaces: its usual tab tracking goes on as for any tab.
import { isNewTabPage } from '../shared/view.ts';

type Tab = { id?: number, windowId?: number, url?: string, pendingUrl?: string, active?: boolean };
/** What of the browser's tabs API this uses (the extension's `api.tabs`, a test's stand-in). */
export type HostedTabsApi = {
  get(id: number): Promise<Tab>,
  query(info: { windowId?: number }): Promise<Tab[]>,
  create(props: { windowId: number, url: string, active: boolean }): Promise<Tab>,
  update(id: number, props: { url?: string, active?: boolean }): Promise<Tab>,
  remove(id: number): Promise<void>,
};

const ITEM = /^[A-Za-z0-9_.:-]{1,256}$/;
// The addresses an item can show: web pages, and a blank page (a new web item with nothing typed yet).
const SHOWN = /^(https?:\/\/|about:blank$)/i;

const plain = (url: unknown) => String(url ?? '').replace(/#.*$/, '').replace(/\/$/, '');

export function createHostedTabs(tabs: () => HostedTabsApi) {
  const byItem = new Map<string, number>();
  const tagged = (tabId: number) => [...byItem.values()].includes(tabId);
  // The item's tagged tab, if it's still open in `windowId` (any window when null).
  async function own(itemId: string, windowId: number | null) {
    const id = byItem.get(itemId);
    if (id == null) return null;
    const tab = await tabs().get(id).catch(() => null);
    if (tab?.id === id && (windowId == null || tab.windowId === windowId)) return tab;
    byItem.delete(itemId);
    return null;
  }
  return {
    /** For the tests: the item each tab is tagged with. */
    tags: () => new Map(byItem),
    async show({ windowId, itemId, url }: { windowId?: unknown, itemId?: unknown, url?: unknown }) {
      if (!Number.isInteger(windowId)) throw new Error('no window');
      if (typeof itemId !== 'string' || !ITEM.test(itemId)) throw new Error('no item');
      if (typeof url !== 'string' || !SHOWN.test(url)) throw new Error('not an address');
      const win = windowId as number;
      let tab: Tab | null = await own(itemId, win);
      let created = false;
      if (!tab) {
        const list = await tabs().query({ windowId: win });
        tab = list.find((t) => t.id != null && !tagged(t.id) && plain(t.url ?? t.pendingUrl) === plain(url)) ?? null;
        const lone = list.length === 1 && list[0].id != null && !tagged(list[0].id) && (isNewTabPage(list[0].url || list[0].pendingUrl) || !(list[0].url || list[0].pendingUrl) || list[0].url === 'about:blank') ? list[0] : null;
        if (!tab && lone) {
          tab = await tabs().update(lone.id!, { url, active: true });
          created = true;
        }
        if (!tab) {
          tab = await tabs().create({ windowId: win, url, active: true });
          created = true;
        }
      }
      if (tab?.id == null) throw new Error('no tab');
      byItem.set(itemId, tab.id);
      if (!created) await tabs().update(tab.id, { active: true }); // (one made or sent there is in front already)
      return { tabId: tab.id, created };
    },
    async close({ itemId }: { itemId?: unknown }) {
      if (typeof itemId !== 'string' || !ITEM.test(itemId)) throw new Error('no item');
      const tab = await own(itemId, null);
      byItem.delete(itemId);
      if (tab?.id == null) return { closed: false };
      await tabs().remove(tab.id);
      return { closed: true };
    },
  };
}
