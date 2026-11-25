// The preview card in the copy (background/hosted.ts, docs/PEEK-SPLIT.md §2): the card's page is a tab of the profile's card
// window, tagged as the card's (never one of the app's items) until Expand moves it into main's window as the new
// item's; a new tab in the card window becomes the card's page; closing it leaves the window (a blank tab) for the
// next preview; the page there is told it's the card's (its Esc and ⌘↩).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_ITEM, createHostedTabs } from '../extension/background/hosted.ts';

type T = { id: number, windowId: number, url: string, active: boolean, title?: string };
function fake(list: T[]) {
  const tabs = new Map(list.map((t) => [t.id, { ...t }]));
  let next = 100;
  const calls: string[] = [];
  const told: [number, unknown][] = [];
  const front = (id: number) => { const t = tabs.get(id)!; for (const o of tabs.values()) if (o.windowId === t.windowId) o.active = o.id === id; };
  const api = {
    async get(id: number) { const t = tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}`); return { ...t }; },
    async query({ windowId }: { windowId?: number }) { return [...tabs.values()].filter((t) => windowId == null || t.windowId === windowId).map((t) => ({ ...t })); },
    async create({ windowId, url, active }: { windowId: number, url: string, active: boolean }) {
      const t = { id: next++, windowId, url, active: false };
      tabs.set(t.id, t);
      if (active) front(t.id);
      calls.push(`create ${windowId} ${url}`);
      return { ...t };
    },
    async update(id: number, { url, active }: { url?: string, active?: boolean }) {
      const t = tabs.get(id)!;
      if (url) t.url = url;
      if (active) front(id);
      calls.push(`update ${id}${url ? ` ${url}` : ''}${active ? ' active' : ''}`);
      return { ...t };
    },
    async move(id: number, { windowId }: { windowId: number, index: number }) { const t = tabs.get(id)!; t.windowId = windowId; calls.push(`move ${id} ${windowId}`); return { ...t }; },
    async remove(id: number) { tabs.delete(id); calls.push(`remove ${id}`); },
    async sendMessage(id: number, msg: unknown) { told.push([id, msg]); return null; },
  };
  return { api, tabs, calls, told };
}

test('Preview card: shown in its own window only (role card), which is the card\'s from then; never an item\'s page there', async () => {
  // (The card window as Margin asked it of the copy: opened at the card's address, never Safari's empty new-tab page.)
  const f = fake([{ id: 1, windowId: 9, url: 'https://a.example/', active: true }, { id: 2, windowId: 12, url: 'https://peek.example/doc', active: true }]);
  const pushed: [number, any][] = [];
  const h = createHostedTabs(() => f.api, undefined, (w, m) => pushed.push([w, m]));
  await h.show({ windowId: 9, itemId: 't-aaaa', url: 'https://a.example/' });
  assert.equal(h.isCard(12), false);
  await assert.rejects(h.show({ windowId: 12, itemId: CARD_ITEM, url: 'https://peek.example/doc' }), /its window only/);
  await assert.rejects(h.show({ windowId: 12, itemId: 't-bbbb', url: 'https://b.example/', role: 'card' }), /its window only/);
  f.calls.length = 0;
  assert.deepEqual(await h.show({ windowId: 12, itemId: CARD_ITEM, url: 'https://peek.example/doc', role: 'card' }), { tabId: 2, created: false });
  assert.deepEqual(f.calls, ['update 2 active'], 'the tab the window opened at that address used, not made again');
  assert.equal(h.isCard(12), true);
  assert.deepEqual(f.told, [[2, { type: 'cardWindow', on: true }]], 'its page told it\'s the card\'s (Esc, ⌘↩)');
  await assert.rejects(h.show({ windowId: 12, itemId: 't-aaaa', url: 'https://a.example/' }), /card only/, 'an item never goes into the card window');
});

test('Preview card: a new tab in the card window becomes the card\'s page (the one before closed); its address and title go to the app', async () => {
  const f = fake([{ id: 2, windowId: 12, url: 'https://peek.example/doc', active: true }]);
  const pushed: [number, any][] = [];
  const h = createHostedTabs(() => f.api, undefined, (w, m) => pushed.push([w, m]));
  await h.show({ windowId: 12, itemId: CARD_ITEM, url: 'https://peek.example/doc', role: 'card' });
  f.tabs.set(50, { id: 50, windowId: 12, url: 'https://next.example/', active: true, title: 'Next' });
  assert.equal(await h.tabCreated({ id: 50, windowId: 12, url: 'https://next.example/', title: 'Next' } as any), true);
  assert.equal(h.tags().get(CARD_ITEM), 50);
  assert.equal(f.tabs.has(2), false, 'the page before closed');
  assert.deepEqual(pushed.at(-1), [12, { type: 'cardPage', url: 'https://next.example/', title: 'Next' }]);
  assert.equal(await h.tabCreated({ id: 60, windowId: 9, url: 'https://elsewhere.example/' } as any), false, 'another window\'s new tab: not the card\'s');
  assert.equal(h.tabUpdated(50, { title: 'Next — done' }, { id: 50, windowId: 12, url: 'https://next.example/', title: 'Next — done' } as any), true);
  assert.equal(pushed.at(-1)![1].title, 'Next — done');
  assert.equal(h.tabUpdated(60, { url: 'https://x.example/' }, { id: 60, windowId: 9, url: 'https://x.example/' } as any), false);
});

test('Preview card: close leaves the window with a blank tab (parked for the next preview); that blank is never taken for a page', async () => {
  const f = fake([{ id: 2, windowId: 12, url: 'https://peek.example/doc', active: true }]);
  const h = createHostedTabs(() => f.api);
  await h.show({ windowId: 12, itemId: CARD_ITEM, url: 'https://peek.example/doc', role: 'card' });
  f.calls.length = 0;
  assert.deepEqual(await h.closeCard(), { closed: true });
  assert.deepEqual(f.calls, ['create 12 about:blank', 'remove 2']);
  const blank = [...f.tabs.values()].find((t) => t.windowId === 12)!;
  assert.equal(await h.tabCreated({ ...blank } as any), false, 'Margin\'s own blank: not the card\'s page');
  assert.equal(h.tags().has(CARD_ITEM), false);
  // The next preview: a new tab at its address in the window, the blank one closed after it.
  f.calls.length = 0;
  await h.show({ windowId: 12, itemId: CARD_ITEM, url: 'https://second.example/', role: 'card' });
  assert.deepEqual(f.calls, ['create 12 https://second.example/', `remove ${blank.id}`]);
  assert.deepEqual(await createHostedTabs(() => f.api).closeCard(), { closed: false }, 'nothing tagged: nothing closed');
});

test('Preview card: Expand moves its tab into main\'s window as the new item\'s (its page kept), a blank left behind; the page told it\'s not the card\'s', async () => {
  const f = fake([{ id: 1, windowId: 9, url: 'https://a.example/', active: true }, { id: 2, windowId: 12, url: 'https://peek.example/doc', active: true }]);
  const h = createHostedTabs(() => f.api);
  await h.show({ windowId: 9, itemId: 't-aaaa', url: 'https://a.example/' });
  await h.show({ windowId: 12, itemId: CARD_ITEM, url: 'https://peek.example/doc', role: 'card' });
  f.calls.length = 0;
  f.told.length = 0;
  assert.deepEqual(await h.promotePeek({ fromItemId: CARD_ITEM, toWindowId: 9, toItemId: 't-new1' }), { ok: true, tabId: 2, moved: true });
  assert.deepEqual(f.calls, ['create 12 about:blank', 'move 2 9', 'update 2 active']);
  assert.equal(h.tags().get('t-new1'), 2);
  assert.equal(h.tags().has(CARD_ITEM), false);
  assert.deepEqual(f.told, [[2, { type: 'cardWindow', on: false }]]);
  // Shown as the item it is now: a tab switch in main's window, never a new tab.
  f.calls.length = 0;
  assert.deepEqual(await h.show({ windowId: 9, itemId: 't-new1', url: 'https://peek.example/doc' }), { tabId: 2, created: false });
  assert.deepEqual(f.calls, ['update 2 active']);
  h.windowRemoved(12);
  assert.equal(h.isCard(12), false);
});

test('Auto-preview in Margin.app: a pin\'s or favorite\'s item is said so by the app with each hostShow, and its page told (the copy\'s own state has no library pins)', async () => {
  const f = fake([{ id: 1, windowId: 9, url: 'https://mail.example/', active: true }]);
  const h = createHostedTabs(() => f.api);
  const shown = await h.show({ windowId: 9, itemId: 't-pin1', url: 'https://mail.example/', pinned: true });
  assert.equal(h.isPinned(shown.tabId), true);
  assert.deepEqual(f.told, [[shown.tabId, { type: 'peekPinned', on: true }]]);
  await h.show({ windowId: 9, itemId: 't-pin1', url: 'https://mail.example/', pinned: true });
  assert.equal(f.told.length, 1, 'said once, as it changes');
  await h.show({ windowId: 9, itemId: 't-pin1', url: 'https://mail.example/', pinned: false });
  assert.equal(h.isPinned(shown.tabId), false);
  assert.deepEqual(f.told.at(-1), [shown.tabId, { type: 'peekPinned', on: false }]);
  await h.show({ windowId: 9, itemId: 't-other', url: 'https://other.example/' });
  assert.equal(f.told.length, 2, 'not said: nothing changes');
});
