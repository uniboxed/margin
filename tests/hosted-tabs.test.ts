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

// (A new tab at the address, not the new-tab page sent there: Safari keeps the keys in the empty window's address
// field, and its toolbar down over the page in full screen while they are; 2026-11-20.)
test('hostShow: a window Margin made: a new tab at the item\'s address, in front and tagged, its lone new-tab page closed after it', async () => {
  for (const blank of [NEW_TAB, 'about:blank', '']) {
    const f = fakeTabs([{ id: 1, windowId: 9, url: blank, active: true }]);
    const h = createHostedTabs(() => f.api);
    assert.deepEqual(await h.show({ windowId: 9, itemId: 't-aaaa', url: 'https://a.example/' }), { tabId: 100, created: true }, blank);
    assert.deepEqual(f.calls, ['create 9 https://a.example/', 'remove 1'], 'made first: the window never without a tab');
    assert.deepEqual([...f.tabs.values()], [{ id: 100, windowId: 9, url: 'https://a.example/', active: true }]);
    assert.equal(h.tags().get('t-aaaa'), 100);
  }
});

test('hostShow: a window Margin made: a blank item keeps its new-tab page (blank either way); a tab Safari won\'t make: the page sent there', async () => {
  const f = fakeTabs([{ id: 1, windowId: 9, url: NEW_TAB, active: true }]);
  const h = createHostedTabs(() => f.api);
  assert.deepEqual(await h.show({ windowId: 9, itemId: 't-aaaa', url: 'about:blank' }), { tabId: 1, created: true });
  assert.deepEqual(f.calls, ['update 1 about:blank active']);
  const g = fakeTabs([{ id: 1, windowId: 9, url: NEW_TAB, active: true }]);
  g.api.create = async () => { throw new Error('refused'); };
  const k = createHostedTabs(() => g.api);
  assert.deepEqual(await k.show({ windowId: 9, itemId: 't-aaaa', url: 'https://a.example/' }), { tabId: 1, created: true });
  assert.deepEqual(g.calls, ['update 1 https://a.example/ active']);
  // Its new-tab page not closed (Safari's refusal): the item still shown, in the tab made.
  const r = fakeTabs([{ id: 1, windowId: 9, url: NEW_TAB, active: true }]);
  r.api.remove = async () => { throw new Error('refused'); };
  assert.deepEqual(await createHostedTabs(() => r.api).show({ windowId: 9, itemId: 't-aaaa', url: 'https://a.example/' }), { tabId: 100, created: true });
});

test('hostShow: a second item: a new tab; the first again: its own tab brought to the front, nothing made', async () => {
  const f = fakeTabs([{ id: 1, windowId: 9, url: NEW_TAB, active: true }]);
  const h = createHostedTabs(() => f.api);
  await h.show({ windowId: 9, itemId: 't-aaaa', url: 'https://a.example/' }); // (tab 100, the new-tab page closed)
  assert.deepEqual(await h.show({ windowId: 9, itemId: 't-bbbb', url: 'https://b.example/' }), { tabId: 101, created: true });
  assert.equal(f.tabs.get(101)!.active, true);
  f.calls.length = 0;
  assert.deepEqual(await h.show({ windowId: 9, itemId: 't-aaaa', url: 'https://a.example/' }), { tabId: 100, created: false });
  assert.deepEqual(f.calls, ['update 100 active'], 'a tab switch only');
  assert.equal(f.tabs.get(100)!.active, true);
  assert.equal(f.tabs.get(101)!.active, false);
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

// Several hosted windows per profile (docs/PEEK-SPLIT.md §1: a split's panes, the preview card): an item's tab in another of
// the app's windows is moved where it's shown (its page kept), never made again.
function withMove(f: ReturnType<typeof fakeTabs>) {
  return {
    ...f.api,
    async move(id: number, { windowId, index }: { windowId: number, index: number }) {
      const t = f.tabs.get(id);
      if (!t) throw new Error(`No tab with id: ${id}`);
      t.windowId = windowId;
      t.active = false;
      f.calls.push(`move ${id} ${windowId} ${index}`);
      return { ...t };
    },
  };
}

test('hostShow: an item\'s tab in another of the app\'s windows is moved there (its page kept), then brought to the front', async () => {
  const f = fakeTabs([{ id: 1, windowId: 9, url: NEW_TAB, active: true }, { id: 2, windowId: 7, url: NEW_TAB, active: true }]);
  const h = createHostedTabs(() => withMove(f));
  await h.show({ windowId: 9, itemId: 't-aaaa', url: 'https://a.example/' }); // (tab 100 in window 9)
  await h.show({ windowId: 9, itemId: 't-bbbb', url: 'https://b.example/' }); // (tab 101, window 9 has two)
  await h.show({ windowId: 7, itemId: 't-cccc', url: 'https://c.example/' }); // (window 7 is the app's too now)
  f.calls.length = 0;
  assert.deepEqual(await h.show({ windowId: 7, itemId: 't-aaaa', url: 'https://a.example/' }), { tabId: 100, created: false, moved: true });
  assert.deepEqual(f.calls, ['move 100 7 -1', 'update 100 active'], 'moved, not made again or navigated');
  assert.equal(f.tabs.get(100)!.windowId, 7);
  assert.equal(f.tabs.get(100)!.active, true);
  assert.equal(f.tabs.get(100)!.url, 'https://a.example/', 'its page kept');
  assert.equal(h.tags().get('t-aaaa'), 100);
  // Shown where it is now: a tab switch only.
  f.calls.length = 0;
  assert.deepEqual(await h.show({ windowId: 7, itemId: 't-aaaa', url: 'https://a.example/' }), { tabId: 100, created: false });
  assert.deepEqual(f.calls, ['update 100 active']);
});

test('hostShow: a tab alone in its window gets a blank one left behind before it moves (the window stays); one in a window the app never showed in stays', async () => {
  const f = fakeTabs([{ id: 1, windowId: 9, url: NEW_TAB, active: true }, { id: 2, windowId: 7, url: NEW_TAB, active: true }]);
  const h = createHostedTabs(() => withMove(f));
  await h.show({ windowId: 9, itemId: 't-aaaa', url: 'https://a.example/' }); // (tab 100, alone in window 9)
  await h.show({ windowId: 7, itemId: 't-cccc', url: 'https://c.example/' });
  f.calls.length = 0;
  assert.deepEqual(await h.show({ windowId: 7, itemId: 't-aaaa', url: 'https://a.example/' }), { tabId: 100, created: false, moved: true });
  assert.deepEqual(f.calls, ['create 9 about:blank', 'move 100 7 -1', 'update 100 active']);
  assert.equal([...f.tabs.values()].filter((t) => t.windowId === 9).length, 1, 'window 9 keeps a tab');
  // Its tab dragged by the person into a window of their own (one the app never showed an item in): never taken back
  // from it; a new tab for it where it's shown.
  const g = fakeTabs([{ id: 5, windowId: 3, url: 'https://keep.example/', active: true }, { id: 6, windowId: 4, url: NEW_TAB, active: true }]);
  const k = createHostedTabs(() => withMove(g));
  await k.show({ windowId: 4, itemId: 't-dddd', url: 'https://d.example/' }); // (tab 100 in window 4)
  g.tabs.get(100)!.windowId = 3;
  g.calls.length = 0;
  assert.deepEqual(await k.show({ windowId: 4, itemId: 't-dddd', url: 'https://d.example/' }), { tabId: 101, created: true });
  assert.equal(g.calls.some((c) => c.startsWith('move')), false, 'the person\'s window keeps its tab');
  assert.equal(g.tabs.get(100)!.windowId, 3);
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

test('hostPicture: the item\'s page while its tab is in front, made smaller; nothing for a tab behind, another window, or no capture', async () => {
  const f = fakeTabs([{ id: 1, windowId: 9, url: NEW_TAB, active: true }]);
  const shots: number[] = [];
  const shrunk: [number, number][] = [];
  const api = { ...f.api, async captureVisibleTab(windowId: number) { shots.push(windowId); return 'data:image/jpeg;base64,QUJD'; } };
  const h = createHostedTabs(() => api, async (d, width, quality) => { shrunk.push([width, quality]); return `${d}small`; });
  await h.show({ windowId: 9, itemId: 't-aaaa', url: 'https://a.example/' });
  assert.deepEqual(await h.picture({ windowId: 9, itemId: 't-aaaa' }), { data: 'data:image/jpeg;base64,QUJDsmall' });
  assert.deepEqual(shots, [9]);
  assert.deepEqual(shrunk, [[1600, 0.6]]);
  // Another item in front: the first one's picture would be of it.
  await h.show({ windowId: 9, itemId: 't-bbbb', url: 'https://b.example/' });
  assert.deepEqual(await h.picture({ windowId: 9, itemId: 't-aaaa' }), { data: null });
  assert.deepEqual(await h.picture({ windowId: 8, itemId: 't-bbbb' }), { data: null }, 'not in that window');
  assert.deepEqual(await h.picture({ windowId: 9, itemId: 't-none' }), { data: null }, 'an item with no tab');
  assert.equal(shots.length, 1);
  await assert.rejects(h.picture({ windowId: 'x', itemId: 't-bbbb' }));
  await assert.rejects(h.picture({ windowId: 9, itemId: 'no spaces' }));
  // No capture in this browser, a refused one, or not a picture: none. A shrink that fails: the capture as it was.
  assert.deepEqual(await createHostedTabs(() => f.api).picture({ windowId: 9, itemId: 't-bbbb' }), { data: null });
  const refusing = createHostedTabs(() => ({ ...f.api, async captureVisibleTab() { throw new Error('no permission'); } }));
  await refusing.show({ windowId: 9, itemId: 't-bbbb', url: 'https://b.example/' });
  assert.deepEqual(await refusing.picture({ windowId: 9, itemId: 't-bbbb' }), { data: null });
  const odd = createHostedTabs(() => ({ ...f.api, async captureVisibleTab() { return 'javascript:alert(1)'; } }));
  await odd.show({ windowId: 9, itemId: 't-bbbb', url: 'https://b.example/' });
  assert.deepEqual(await odd.picture({ windowId: 9, itemId: 't-bbbb' }), { data: null });
  const failing = createHostedTabs(() => api, async () => { throw new Error('no canvas'); });
  await failing.show({ windowId: 9, itemId: 't-bbbb', url: 'https://b.example/' });
  assert.deepEqual(await failing.picture({ windowId: 9, itemId: 't-bbbb' }), { data: 'data:image/jpeg;base64,QUJD' });
});
