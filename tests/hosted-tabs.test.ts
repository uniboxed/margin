// Margin.app hosting Safari in its page area (background/hosted.ts): hostShow and hostClose, the copy's side of the
// app's library items, against a stand-in for the tabs API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostedTabs } from '../extension/background/hosted.ts';

const NEW_TAB = 'safari-web-extension://abc/newtab/newtab.html';
type T = { id: number, windowId: number, url: string, active: boolean };
function fakeTabs(list: T[]) {
  const tabs = new Map(list.map((t) => [t.id, { ...t }]));
  let next = 100;
  const calls: string[] = [];
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
      const t = tabs.get(id);
      if (!t) throw new Error(`No tab with id: ${id}`);
      if (url) t.url = url;
      if (active) front(id);
      calls.push(`update ${id}${url ? ` ${url}` : ''}${active ? ' active' : ''}`);
      return { ...t };
    },
    async remove(id: number) { tabs.delete(id); calls.push(`remove ${id}`); },
  };
  return { api, tabs, calls };
}

test('hostShow: a window Margin made: its lone new-tab page goes to the item\'s address, tagged, in front', async () => {
  const f = fakeTabs([{ id: 1, windowId: 9, url: NEW_TAB, active: true }]);
  const h = createHostedTabs(() => f.api);
  assert.deepEqual(await h.show({ windowId: 9, itemId: 't-aaaa', url: 'https://a.example/' }), { tabId: 1, created: true });
  assert.equal(f.tabs.get(1)!.url, 'https://a.example/');
  assert.deepEqual(f.calls, ['update 1 https://a.example/ active']);
  assert.equal(h.tags().get('t-aaaa'), 1);
});

test('hostShow: a second item: a new tab; the first again: its own tab brought to the front, nothing made', async () => {
  const f = fakeTabs([{ id: 1, windowId: 9, url: NEW_TAB, active: true }]);
  const h = createHostedTabs(() => f.api);
  await h.show({ windowId: 9, itemId: 't-aaaa', url: 'https://a.example/' });
  assert.deepEqual(await h.show({ windowId: 9, itemId: 't-bbbb', url: 'https://b.example/' }), { tabId: 100, created: true });
  assert.equal(f.tabs.get(100)!.active, true);
  f.calls.length = 0;
  assert.deepEqual(await h.show({ windowId: 9, itemId: 't-aaaa', url: 'https://a.example/' }), { tabId: 1, created: false });
  assert.deepEqual(f.calls, ['update 1 active'], 'a tab switch only');
  assert.equal(f.tabs.get(1)!.active, true);
  assert.equal(f.tabs.get(100)!.active, false);
});

test('hostShow: an item\'s tab gone or in another window: found by its address, else made again', async () => {
  const f = fakeTabs([{ id: 1, windowId: 9, url: 'https://keep.example/', active: true }, { id: 2, windowId: 9, url: 'https://a.example/', active: false }]);
  const h = createHostedTabs(() => f.api);
  // A copy that restarted: no tag, its tab found by its address (not the other one's).
  assert.deepEqual(await h.show({ windowId: 9, itemId: 't-aaaa', url: 'https://a.example' }), { tabId: 2, created: false });
  await f.api.remove(2);
  assert.deepEqual(await h.show({ windowId: 9, itemId: 't-aaaa', url: 'https://a.example/' }), { tabId: 100, created: true }, 'closed in Safari meanwhile: made again');
  // Shown for another window (another profile's): never the other window's tab.
  assert.deepEqual((await h.show({ windowId: 7, itemId: 't-aaaa', url: 'https://a.example/' })).created, true);
});

test('hostShow: refuses what isn\'t a window, an item or a page address', async () => {
  const f = fakeTabs([]);
  const h = createHostedTabs(() => f.api);
  await assert.rejects(h.show({ itemId: 't-a', url: 'https://a.example/' }), /no window/);
  await assert.rejects(h.show({ windowId: 1, itemId: 'bad id!', url: 'https://a.example/' }), /no item/);
  await assert.rejects(h.show({ windowId: 1, itemId: 't-a', url: 'javascript:alert(1)' }), /not an address/);
  await assert.rejects(h.show({ windowId: 1, itemId: 't-a', url: 'file:///etc/passwd' }), /not an address/);
  assert.deepEqual(f.calls, []);
});

test('hostClose: the item\'s tab closed and forgotten; one with no tab: nothing', async () => {
  const f = fakeTabs([{ id: 1, windowId: 9, url: NEW_TAB, active: true }]);
  const h = createHostedTabs(() => f.api);
  await h.show({ windowId: 9, itemId: 't-aaaa', url: 'https://a.example/' });
  assert.deepEqual(await h.close({ itemId: 't-aaaa' }), { closed: true });
  assert.equal(f.tabs.has(1), false);
  assert.equal(h.tags().has('t-aaaa'), false);
  assert.deepEqual(await h.close({ itemId: 't-aaaa' }), { closed: false });
  await assert.rejects(h.close({}), /no item/);
});

test('hostShow and hostClose are requests the app may make', async () => {
  const { APP_REQUESTS } = await import('../extension/background/link.ts');
  for (const type of ['hostShow', 'hostClose']) assert.ok(APP_REQUESTS.has(type), type);
});
