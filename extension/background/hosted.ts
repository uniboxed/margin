// Margin.app hosting Safari in its own page area (docs/MARGIN-APP.md, behind the app's `MarginHosted`): the app owns
// the spaces and their items (its library) and keeps one Safari window per profile in use as the page area's; this
// copy only drives the tabs of that window. Two requests (link.ts APP_REQUESTS, docs/PROTOCOL.md "Hosted windows"):
//
// - `hostShow { windowId, itemId, url }`: the item's page shown in that window. The tab tagged with the item before
//   (still open, in that window) is used again; else a tab of that window at the same address no other item has;
//   else, in a window Margin made (its lone new-tab page), a new tab at the address, the new-tab page closed after it;
//   else a new tab. It comes to the front. Answers `{ tabId, created }` (`created`: a tab made or navigated for it).
//   Its tagged tab in another window the app showed items in (this profile's main window, its card, a split's panes:
//   docs/PEEK-SPLIT.md §1) is moved into this one first (`tabs.move`: its page kept), answered with `moved: true`.
//   (Not the new-tab page sent there: Safari opens an empty window with the keys in its address field, and a page
//   loaded into that tab leaves them there; in full screen Safari keeps its toolbar down while they are, so it showed
//   half covered over the page until a click in it (Tirth, 2026-11-20 17:34, 17:35, 18:33: each a profile's new
//   window, its toolbar out from its first read; Margin's toolbar trace). A tab opened at an address has the keys in
//   its page, as a link opened in a new tab does. A blank item (about:blank) keeps the new-tab page: blank either way.)
// - `hostClose { itemId }`: the item's tab closed (closed from Margin's sidebar). Answers `{ closed }`.
// - `hostPicture { windowId, itemId }`: a picture of the item's page, as that window shows it, for its card in another
//   Margin window (the app's `elsewhere`), asked just before the window leaves. Only while the item's tab is the one in
//   front there (else it'd be of something else). JPEG, at most PICTURE.width px wide. Answers `{ data }` (a data
//   URL, or null). Never kept here, never logged, never stored: the app keeps it in memory while the card shows.
//
// The tags (item → tab) are this copy's memory only: a copy restarted finds an item's tab again by its address.
// Nothing here touches the copy's own spaces: its usual tab tracking goes on as for any tab.
import { isNewTabPage } from '../shared/view.ts';

type Tab = { id?: number, windowId?: number, url?: string, pendingUrl?: string, active?: boolean, mutedInfo?: { muted: boolean } };
/** The mini player's buttons on a hosted item's page (`hostMedia`; content/media.ts). */
const MEDIA_COMMANDS = new Set(['toggle', 'prev', 'next', 'mute']);
/** What of the browser's tabs API this uses (the extension's `api.tabs`, a test's stand-in). */
export type HostedTabsApi = {
  get(id: number): Promise<Tab>,
  query(info: { windowId?: number }): Promise<Tab[]>,
  create(props: { windowId: number, url: string, active: boolean }): Promise<Tab>,
  update(id: number, props: { url?: string, active?: boolean, muted?: boolean }): Promise<Tab>,
  move?(id: number, props: { windowId: number, index: number }): Promise<Tab>,
  remove(id: number): Promise<void>,
  sendMessage?(id: number, message: unknown): Promise<any>,
  captureVisibleTab?(windowId: number, options: { format: 'jpeg', quality: number }): Promise<string>,
};
/** A picture made smaller (background/picture.ts; a test's stand-in), or as it was when it can't be. */
export type Shrink = (data: string, width: number, quality: number) => Promise<string>;

export const PICTURE = { width: 1600, quality: 60 } as const;
const PICTURE_URL = /^data:image\/(jpeg|png);base64,/;

const ITEM = /^[A-Za-z0-9_.:-]{1,256}$/;
// The addresses an item can show: web pages, and a blank page (a new web item with nothing typed yet).
const SHOWN = /^(https?:\/\/|about:blank$)/i;

const plain = (url: unknown) => String(url ?? '').replace(/#.*$/, '').replace(/\/$/, '');

// Peek's card (docs/PEEK-SPLIT.md §2): its page is the tab tagged CARD_ITEM in the profile's card window (`hostShow`
// with `role: 'card'`, which marks that window the card's). Never one of the app's library items: not in Margin's
// sidebar, not archived, not counted by its keys, until Expand (`promotePeek`, which tags it with the new item). A new
// tab in the card window (a link the page opens in one) becomes the card's page (`tabCreated`), the one before closed.
// The page's address and title as they change go to the app (`cardPage`), and a page there is told it's in the card's
// window (`cardWindow`: its Esc and ⌘↩ are the card's, content/peek.ts).
export const CARD_ITEM = 'peek-card';

export function createHostedTabs(tabs: () => HostedTabsApi, shrink: Shrink = async (d) => d, push: (windowId: number, msg: Record<string, unknown>) => unknown = () => false) {
  const byItem = new Map<string, number>();
  const cards = new Set<number>(); // the card windows (one per copy: its profile's)
  // Tabs of items that are a pin's or a favorite's in Margin.app's library (`hostShow`'s `pinned`): their pages'
  // links to other sites open in Peek's card (Auto-Peek). The copy's own state doesn't have the library's pins.
  const pinnedTabs = new Set<number>();
  const tellPinned = (tabId: number, on: boolean) => { void tabs().sendMessage?.(tabId, { type: 'peekPinned', on })?.catch?.(() => {}); };
  const tellPage = (tabId: number, on: boolean) => { void tabs().sendMessage?.(tabId, { type: 'cardWindow', on })?.catch?.(() => {}); };
  const sayCard = (tab: Tab & { title?: string }) => {
    if (tab.windowId == null) return;
    push(tab.windowId, { type: 'cardPage', url: tab.url || tab.pendingUrl || '', title: String(tab.title ?? '').slice(0, 300) });
  };
  // A tab left in a window that would have none (a window with no tab closes, and it's Margin's): a blank one.
  // (Its creation heard by `tabCreated` is Margin's own: never taken for the card's page.)
  const blanking = new Map<number, number>();
  async function leaveBlank(windowId: number) {
    const left = await tabs().query({ windowId }).catch(() => [] as Tab[]);
    if (left.length > 1) return;
    blanking.set(windowId, (blanking.get(windowId) ?? 0) + 1);
    await tabs().create({ windowId, url: 'about:blank', active: false }).catch(() => null);
    setTimeout(() => { const n = (blanking.get(windowId) ?? 1) - 1; if (n > 0) blanking.set(windowId, n); else blanking.delete(windowId); }, 1000);
  }
  const tagged = (tabId: number) => [...byItem.values()].includes(tabId);
  // The windows the app has shown items in (its hosted windows of this profile: main, a card, a split's panes; docs/
  // PEEK-SPLIT.md §1): a tab of an item in one of them, asked for in another, is moved there, never made again.
  const shownIn = new Set<number>();
  // The item's tagged tab in another of those windows, moved into `win` (keeps its page: logins, scroll, history). A
  // tab alone in its window gets a blank one left behind first (a window with no tab closes, and it's Margin's).
  async function moveHere(itemId: string, win: number): Promise<Tab | null> {
    const move = tabs().move;
    if (!move) return null;
    const tab = await own(itemId, null);
    if (tab?.id == null || tab.windowId == null || tab.windowId === win || !shownIn.has(tab.windowId)) return null;
    const left = await tabs().query({ windowId: tab.windowId }).catch(() => [] as Tab[]);
    if (left.length <= 1) await tabs().create({ windowId: tab.windowId, url: 'about:blank', active: false }).catch(() => null);
    const moved = await move.call(tabs(), tab.id, { windowId: win, index: -1 }).catch(() => null);
    if (moved?.id == null) return null;
    return { ...moved, windowId: moved.windowId ?? win };
  }
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
    /** The item a tab is tagged with (the mini player's sources name it: background/media.ts), null: none. */
    itemOf(tabId: number): string | null {
      for (const [item, id] of byItem) if (id === tabId) return item;
      return null;
    },
    /** Whether `windowId` is the card's window (Peek's, Margin.app's `hostShow` with `role: 'card'`). */
    isCard: (windowId: number) => cards.has(windowId),
    /** Whether a tab shows a pin's or favorite's item in Margin.app (Auto-Peek). */
    isPinned: (tabId: number) => pinnedTabs.has(tabId),
    // `fresh` (the card's only): a new Peek's page: the card's tab sent there if it shows another one.
    async show({ windowId, itemId, url, role, fresh, pinned }: { windowId?: unknown, itemId?: unknown, url?: unknown, role?: unknown, fresh?: unknown, pinned?: unknown }) {
      if (!Number.isInteger(windowId)) throw new Error('no window');
      if (typeof itemId !== 'string' || !ITEM.test(itemId)) throw new Error('no item');
      if (typeof url !== 'string' || !SHOWN.test(url)) throw new Error('not an address');
      const win = windowId as number;
      // (The card's page: in its own window only, which is the card's from now on.)
      if ((itemId === CARD_ITEM) !== (role === 'card')) throw new Error('the card\'s page is shown in its window only');
      if (role === 'card') {
        cards.add(win);
        const out = await this.showIn(win, itemId, url);
        if (fresh === true && !out.created) {
          const t = await tabs().get(out.tabId).catch(() => null);
          if (t && plain(t.url || t.pendingUrl) !== plain(url)) await tabs().update(out.tabId, { url, active: true });
        }
        tellPage(out.tabId, true);
        return out;
      }
      if (cards.has(win)) throw new Error('the card\'s window shows the card only');
      const out = await this.showIn(win, itemId, url);
      // (Said to its page when it changes: its clicks decide Auto-Peek at once, with no question asked.)
      if (typeof pinned === 'boolean' && pinned !== pinnedTabs.has(out.tabId)) {
        if (pinned) pinnedTabs.add(out.tabId); else pinnedTabs.delete(out.tabId);
        tellPinned(out.tabId, pinned);
      }
      return out;
    },
    async showIn(win: number, itemId: string, url: string) {
      // (Moved first: its tag found in another window is forgotten by `own`.)
      let tab: Tab | null = await moveHere(itemId, win);
      const moved = tab != null;
      tab ??= await own(itemId, win);
      let created = false;
      shownIn.add(win);
      if (!tab) {
        const list = await tabs().query({ windowId: win });
        tab = list.find((t) => t.id != null && !tagged(t.id) && plain(t.url || t.pendingUrl) === plain(url)) ?? null;
        const lone = list.length === 1 && list[0].id != null && !tagged(list[0].id) && (isNewTabPage(list[0].url || list[0].pendingUrl) || !(list[0].url || list[0].pendingUrl) || list[0].url === 'about:blank') ? list[0] : null;
        if (!tab && lone) {
          if (/^about:blank$/i.test(url)) tab = await tabs().update(lone.id!, { url, active: true });
          else {
            // (Made first, so the window never has no tab; one Safari refuses: the new-tab page sent there, as before.)
            tab = await tabs().create({ windowId: win, url, active: true }).catch(() => null);
            if (tab?.id != null) await tabs().remove(lone.id!).catch(() => {});
            else tab = await tabs().update(lone.id!, { url, active: true });
          }
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
      return moved ? { tabId: tab.id, created, moved } : { tabId: tab.id, created };
    },
    async picture({ windowId, itemId }: { windowId?: unknown, itemId?: unknown }) {
      if (!Number.isInteger(windowId)) throw new Error('no window');
      if (typeof itemId !== 'string' || !ITEM.test(itemId)) throw new Error('no item');
      const capture = tabs().captureVisibleTab;
      if (!capture) return { data: null };
      const tab = await own(itemId, windowId as number);
      if (!tab?.active) return { data: null };
      const shot = await capture.call(tabs(), windowId as number, { format: 'jpeg', quality: PICTURE.quality }).catch(() => null);
      if (typeof shot !== 'string' || !PICTURE_URL.test(shot)) return { data: null };
      const small = await shrink(shot, PICTURE.width, PICTURE.quality / 100).catch(() => shot);
      return { data: typeof small === 'string' && PICTURE_URL.test(small) ? small : shot };
    },
    async close({ itemId }: { itemId?: unknown }) {
      if (typeof itemId !== 'string' || !ITEM.test(itemId)) throw new Error('no item');
      const tab = await own(itemId, null);
      byItem.delete(itemId);
      if (tab?.id == null) return { closed: false };
      await tabs().remove(tab.id);
      return { closed: true };
    },
    async mute({ itemId, muted }: { itemId?: unknown, muted?: unknown }) {
      if (typeof itemId !== 'string' || !ITEM.test(itemId)) throw new Error('no item');
      const tab = await own(itemId, null);
      if (tab?.id == null) return { muted: false, ok: false };
      const next = typeof muted === 'boolean' ? muted : !tab.mutedInfo?.muted;
      const updated = await tabs().update(tab.id, { muted: next });
      return { muted: updated?.mutedInfo?.muted ?? next, ok: true };
    },
    // The mini player's button for an item's page (Margin.app's `hostMedia`): play or pause, the previous or next
    // track, done by its page (content/media.ts `mediaCommand`); mute as `hostMute`. `tabId`: the tab the copy's
    // `media` push named for it, used when the item's tag is gone (this copy started again since it was shown) and
    // that tab is no other item's.
    async media({ itemId, command, tabId }: { itemId?: unknown, command?: unknown, tabId?: unknown }) {
      if (typeof itemId !== 'string' || !ITEM.test(itemId)) throw new Error('no item');
      if (typeof command !== 'string' || !MEDIA_COMMANDS.has(command)) throw new Error('not a media command');
      let tab = await own(itemId, null);
      if (!tab && Number.isInteger(tabId) && !tagged(tabId as number)) {
        tab = await tabs().get(tabId as number).catch(() => null);
        if (tab && tab.id === tabId) byItem.set(itemId, tabId as number); else tab = null;
      }
      if (tab?.id == null) return { ok: false };
      if (command === 'mute') {
        const updated = await tabs().update(tab.id, { muted: !tab.mutedInfo?.muted });
        return { ok: true, muted: updated?.mutedInfo?.muted ?? !tab.mutedInfo?.muted };
      }
      const answer = await tabs().sendMessage?.(tab.id, { type: 'mediaCommand', command }).catch(() => null);
      return { ok: answer?.ok === true };
    },
    async navigate({ itemId, url }: { itemId?: unknown, url?: unknown }) {
      if (typeof itemId !== 'string' || !ITEM.test(itemId)) throw new Error('no item');
      if (typeof url !== 'string' || !SHOWN.test(url)) throw new Error('not an address');
      const tab = await own(itemId, null);
      if (tab?.id == null) return { ok: false };
      await tabs().update(tab.id, { url, active: true });
      return { ok: true, tabId: tab.id };
    },
    /** Promote a Peek / Little Arc Safari tab into the main hosted Space window (preserving logins, cookies, scroll). */
    async promotePeek({ fromItemId, toWindowId, toItemId }: { fromItemId?: unknown, toWindowId?: unknown, toItemId?: unknown }) {
      if (typeof fromItemId !== 'string' || !ITEM.test(fromItemId)) throw new Error('no source item');
      if (typeof toItemId !== 'string' || !ITEM.test(toItemId)) throw new Error('no target item');
      if (!Number.isInteger(toWindowId)) throw new Error('no target window');
      const tab = await own(fromItemId, null);
      if (tab?.id == null) return { ok: false };
      const move = tabs().move;
      if (move) {
        // (Its window keeps a tab: the card's window is Margin's, parked for the next Peek.)
        if (tab.windowId != null && tab.windowId !== toWindowId) await leaveBlank(tab.windowId);
        const moved = await move.call(tabs(), tab.id, { windowId: toWindowId as number, index: -1 }).catch(() => null);
        if (moved?.id != null) {
          byItem.delete(fromItemId);
          byItem.set(toItemId, moved.id);
          shownIn.add(toWindowId as number);
          await tabs().update(moved.id, { active: true }).catch(() => null);
          if (fromItemId === CARD_ITEM) tellPage(moved.id, false);
          return { ok: true, tabId: moved.id, moved: true };
        }
      }
      return { ok: false, url: tab.url ?? '' };
    },
    /** Peek's card closed (Margin.app's `hostCardClose`): its tab closed, a blank one left so its window stays (parked). */
    async closeCard() {
      const tab = await own(CARD_ITEM, null);
      byItem.delete(CARD_ITEM);
      if (tab?.id == null) return { closed: false };
      if (tab.windowId != null) await leaveBlank(tab.windowId);
      await tabs().remove(tab.id).catch(() => {});
      return { closed: true };
    },
    /** A tab made in the card's window (a link its page opened in a new tab): the card's page from now, the one before closed. */
    async tabCreated(tab: Tab & { title?: string }) {
      if (tab?.id == null || tab.windowId == null || !cards.has(tab.windowId)) return false;
      const before = byItem.get(CARD_ITEM);
      if (before === tab.id) return false;
      // (Margin's own blank one, left as the card closed or expanded: not a page.)
      if (blanking.has(tab.windowId) && /^(about:blank)?$/i.test(tab.url || tab.pendingUrl || '')) return false;
      byItem.set(CARD_ITEM, tab.id);
      tellPage(tab.id, true);
      sayCard(tab);
      if (before != null) {
        const old = await tabs().get(before).catch(() => null);
        if (old?.windowId === tab.windowId) await tabs().remove(before).catch(() => {});
      }
      return true;
    },
    /** The card's page changed its address or title: told to Margin.app for the card's bar. */
    tabUpdated(tabId: number, change: { url?: string, title?: string }, tab: Tab & { title?: string }) {
      if (byItem.get(CARD_ITEM) !== tabId || !(change?.url || change?.title !== undefined)) return false;
      sayCard(tab);
      return true;
    },
    /** A window closed: not the card's any more. */
    windowRemoved(windowId: number) { cards.delete(windowId); shownIn.delete(windowId); },
  };
}
