// Tabs following the window in front (background/away.ts, docs/BROWSER-WINDOWS.md §9), against a fake browser API: a tab
// chosen in a window while it's in another moves there, the other keeps it chosen, away, with the stand-in page
// in front and the tab's picture kept in memory only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBrowser } from './fake-browser.ts';
import type { State } from '../types/margin.d.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PICTURE = 'data:image/jpeg;base64,AAAA';
// local: stored JSON. captures: the windows whose picture was taken. refuseMove, refuseCreate: the browser refusing.
const fake = { tabs: new Map(), nextId: 100, local: {} as Record<string, any>, captures: [] as (number | undefined)[], moves: [] as { id: number | number[], from: number, to?: number, index: number }[], removed: [] as number[], created: [] as { windowId?: number, url?: string, active: boolean }[], refuseMove: false, refuseCreate: false, focused: 2 };
const asTab = (t: BrowserTab) => ({ ...t });
const reindex = (windowId?: number) => [...fake.tabs.values()].filter((t) => t.windowId === windowId).sort((a, b) => a.index - b.index).forEach((t, i) => { t.index = i; });
globalThis.chrome = fakeBrowser({
  runtime: { getURL: (path) => `safari-web-extension://test/${path}`, getManifest: () => ({ content_scripts: [] }), sendMessage: async () => {} },
  permissions: { contains: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
  tabs: {
    sendMessage: async () => {},
    get: async (id) => {
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      return asTab(tab);
    },
    query: async ({ active, windowId } = {}) => [...fake.tabs.values()].filter((t) => (active == null || t.active === active) && (windowId == null || t.windowId === windowId)).map(asTab),
    update: async (id, { active, url } = {}) => {
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      if (active) for (const t of fake.tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === id;
      if (url) tab.url = url;
      return asTab(tab);
    },
    remove: async (ids) => {
      for (const id of ([] as number[]).concat(ids)) {
        fake.removed.push(id);
        fake.tabs.delete(id);
      }
    },
    create: async ({ windowId, url, active, index }) => {
      if (fake.refuseCreate) throw new Error('no');
      // Made without a window: none here.
      const tab = { id: fake.nextId++, windowId, url, active: !!active, index: index ?? 99, title: '' } as BrowserTab;
      if (active) for (const t of fake.tabs.values()) if (t.windowId === windowId) t.active = false;
      fake.tabs.set(tab.id, tab);
      fake.created.push({ windowId, url, active: !!active });
      reindex(windowId);
      return asTab(tab);
    },
    move: async (id, { windowId, index }) => {
      if (fake.refuseMove) throw new Error('Tabs can only be moved to and from normal windows.');
      const tab = fake.tabs.get(id);
      const from = tab.windowId;
      fake.moves.push({ id, from, to: windowId, index });
      tab.windowId = windowId;
      tab.active = false;
      tab.index = index < 0 ? 999 : index - 0.5;
      reindex(from);
      reindex(windowId);
      return asTab(tab);
    },
    captureVisibleTab: async (windowId) => {
      fake.captures.push(windowId);
      return PICTURE;
    },
  },
  // Its answer unread.
  windows: { get: async (id) => ({ id, focused: id === fake.focused }), update: async (id) => { fake.focused = id; return {}; } },
  storage: {
    local: {
      // Asked by key or keys here.
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys as string]).filter((k) => k in fake.local).map((k) => [k, fake.local[k]])),
      set: async (items) => { Object.assign(fake.local, items); },
    },
  },
});

const M = await import('../extension/state/model.ts');
const V = await import('../extension/shared/view.ts');
const { mutate, load } = await import('../extension/background/store.ts');
const away = await import('../extension/background/away.ts');
const STAND_IN = 'safari-web-extension://test/away/away.html';
away.setAwayTiming({ settleMs: 5 });

// Window 1: tabs 1 (in front) and 2; window 2: tab 3 (in front). All of the space Personal.
async function setup() {
  away.awayInternals.reset();
  Object.assign(fake, { tabs: new Map(), nextId: 100, captures: [], moves: [], removed: [], created: [], refuseMove: false, refuseCreate: false, focused: 2 });
  const tabs = [
    { id: 1, windowId: 1, url: 'https://one.example/', title: 'One', active: true, index: 0 },
    { id: 2, windowId: 1, url: 'https://two.example/', title: 'Two', active: false, index: 1 },
    { id: 3, windowId: 2, url: 'https://three.example/', title: 'Three', active: true, index: 0 },
  ];
  for (const t of tabs) fake.tabs.set(t.id, { ...t });
  await mutate(() => {
    let s = M.defaultState();
    for (const t of tabs) s = M.activateTab(M.upsertTab(s, t, 0), t.active ? t.id : -1, t.active ? t.windowId : null, 0);
    for (const t of tabs) if (t.active) s = M.activateTab(s, t.id, t.windowId, 1);
    return s;
  });
}
// What background.ts does with an activation: the state, and the window's stand-in.
async function activated(tabId: number, windowId: number) {
  const wasAway = (await load()).awayByWindow?.[windowId] != null;
  await mutate((s) => M.activateTab(s, tabId, windowId, 5));
  away.shownIn(windowId, tabId, wasAway);
  await sleep(1);
}
// A sidebar row as these tests read it (shared/view.ts sidebar: `away` only on a window's away tab).
type Row = { active: boolean, away?: boolean };
const standInOf = (windowId: number) => [...fake.tabs.values()].find((t) => t.windowId === windowId && t.url === STAND_IN);

test('chosen in window 2 while in front of window 1: it moves to 2; 1 keeps it chosen, faded, its picture in front', async () => {
  await setup();
  const tab = await chrome.tabs.get(1);
  await away.bringTab(tab, 2, { source: 'test' });
  assert.deepEqual(fake.captures, [1], 'window 1\'s picture, taken before the move');
  assert.equal(fake.tabs.get(1).windowId, 2, 'moved');
  assert.equal(fake.tabs.get(1).active, true, 'in front of window 2');
  const stand = standInOf(1);
  assert.ok(stand?.active, 'the stand-in in front of window 1');
  const s = await load();
  assert.equal(s.awayByWindow![1], 1);
  assert.equal(s.tabs[1].windowId, 2, 'the record follows the move');
  assert.equal(s.tabs[stand.id], undefined, 'the stand-in is never a Margin tab');
  await activated(1, 2);
  const s2 = await load();
  const one: Row = V.sidebar(s2, 1).tabs.find((t) => t.id === 1)!;
  assert.deepEqual([one.active, one.away], [true, true], 'window 1: chosen, away');
  const two: Row = V.sidebar(s2, 2).tabs.find((t) => t.id === 1)!;
  assert.deepEqual([two.active, !!two.away], [true, false], 'window 2: live');
  assert.deepEqual(away.shownAway(1), { tabId: 1, title: 'One', url: 'https://one.example/', picture: PICTURE });
  assert.equal(away.shownAway(2), null, 'window 2 shows nothing away');
  assert.ok(!JSON.stringify(fake.local).includes('data:image'), 'the picture is never stored');
});

test('window 1 to the front again: the tab follows it back; window 2 shows it away; window 1\'s stand-in goes', async () => {
  await setup();
  await away.bringTab(await chrome.tabs.get(1), 2, { source: 'test' });
  await activated(1, 2);
  const firstStandIn = standInOf(1).id;
  fake.captures.length = 0;
  fake.focused = 1;
  away.focusChanged(2);
  away.focusChanged(1);
  await sleep(40);
  assert.equal(fake.tabs.get(1).windowId, 1, 'back in window 1');
  assert.deepEqual(fake.captures, [2], 'window 2\'s picture of it, as it left');
  assert.ok(standInOf(2)?.active, 'window 2\'s stand-in in front');
  await activated(1, 1);
  assert.ok(!fake.tabs.has(firstStandIn), 'window 1\'s stand-in closed once its tab is back');
  const s = await load();
  assert.deepEqual(s.awayByWindow, { 2: 1 });
  assert.equal((V.sidebar(s, 2).tabs.find((t) => t.id === 1) as Row).away, true);
  assert.equal((V.sidebar(s, 1).tabs.find((t) => t.id === 1) as Row).away, undefined);
});

test('another tab chosen in the window showing one away: nothing away there, its stand-in closed', async () => {
  await setup();
  await away.bringTab(await chrome.tabs.get(1), 2, { source: 'test' });
  await activated(1, 2);
  const stand = standInOf(1).id;
  await chrome.tabs.update(2, { active: true });
  await activated(2, 1);
  assert.ok(!fake.tabs.has(stand));
  assert.deepEqual((await load()).awayByWindow, {});
});

test('a tab behind in its window moves without a stand-in or a picture: that window\'s choice is another tab', async () => {
  await setup();
  await away.bringTab(await chrome.tabs.get(2), 2, { source: 'test' });
  assert.deepEqual(fake.captures, []);
  assert.equal(standInOf(1), undefined);
  assert.equal(fake.tabs.get(1).active, true, 'window 1 still shows tab 1');
  assert.deepEqual((await load()).awayByWindow, {});
});

test('a move Safari refuses: the tab shown in its own window, nothing left away', async () => {
  await setup();
  fake.refuseMove = true;
  await away.bringTab(await chrome.tabs.get(1), 2, { source: 'test' });
  assert.equal(fake.tabs.get(1).windowId, 1);
  assert.equal(fake.tabs.get(1).active, true);
  await sleep(1);
  assert.equal(standInOf(1), undefined, 'its stand-in closed again');
  assert.deepEqual((await load()).awayByWindow, {});
});

test('the away tab closed: the window that showed it away shows its next tab of the space; with none, its start page', async () => {
  await setup();
  await away.bringTab(await chrome.tabs.get(1), 2, { source: 'test' });
  await activated(1, 2);
  const stand = standInOf(1).id;
  await chrome.tabs.remove(1);
  await away.tabClosed(1, [1]);
  await mutate((s) => M.removeTab(s, 1));
  assert.equal(fake.tabs.get(2).active, true, 'tab 2 in front of window 1');
  await sleep(1);
  assert.ok(!fake.tabs.has(stand), 'the stand-in closed');
  // Window 2's only tab away in window 1, and closed: its stand-in becomes its start page.
  await setup();
  await away.bringTab(await chrome.tabs.get(3), 1, { source: 'test' });
  await activated(3, 1);
  const alone = standInOf(2).id;
  await chrome.tabs.remove(3);
  await away.tabClosed(3, [2]);
  assert.equal(fake.tabs.get(alone).url, 'safari-web-extension://test/newtab/newtab.html#launcher', 'the window isn\'t closed');
});

test('as the background starts: a stand-in its window still needs stays; one it doesn\'t closes (or, alone, becomes the start page)', async () => {
  await setup();
  await away.bringTab(await chrome.tabs.get(1), 2, { source: 'test' });
  await activated(1, 2);
  const kept = standInOf(1).id;
  const orphan = { id: 500, windowId: 2, url: STAND_IN, active: false, index: 5 };
  const restored = { id: 501, windowId: 9, url: STAND_IN, active: true, index: 0 };
  fake.tabs.set(orphan.id, orphan);
  fake.tabs.set(restored.id, restored);
  away.awayInternals.reset();
  await away.sweep(await chrome.tabs.query({}));
  assert.ok(fake.tabs.has(kept), 'window 1 shows tab 1 away: its stand-in stays');
  assert.ok(!fake.tabs.has(500), 'window 2 shows nothing away');
  assert.equal(fake.tabs.get(501).url, 'safari-web-extension://test/newtab/newtab.html#launcher', 'alone in its window');
  assert.equal(away.isStandIn(kept, 1), true, 'known again');
});

test('isStandIn: by its address, and while one is being made', () => {
  assert.equal(away.isStandIn(7, 1, { url: STAND_IN }), true);
  assert.equal(away.isStandIn(7, 1, { url: '', pendingUrl: `${STAND_IN}?x` }), true);
  assert.equal(away.isStandIn(7, 1, { url: 'https://away/away.html' }), false);
  assert.equal(away.isStandIn(7, 1, { url: 'https://one.example/' }), false);
});

test('the model: a stand-in is never a Margin tab, and what a window shows away is forgotten with its tab or window', () => {
  let s = M.defaultState();
  s = M.upsertTab(s, { id: 1, windowId: 1, url: 'https://one.example/', index: 0, active: true }, 0);
  assert.equal(M.upsertTab(s, { id: 9, windowId: 1, url: STAND_IN, index: 1, active: true }, 0), s);
  // Tabs as the test gives them: without `active` (not in front).
  s = M.setAway(M.upsertTab(s, { id: 2, windowId: 2, url: 'https://two.example/', index: 0 } as BrowserTab, 0), 1, 2);
  assert.deepEqual(s.awayByWindow, { 1: 2 });
  assert.deepEqual(M.removeTab(s, 2).awayByWindow, {});
  assert.deepEqual(M.activateTab(s, 1, 1, 9).awayByWindow, {}, 'a tab of its own in front');
  assert.deepEqual(M.activateTab(s, 2, 1, 9).awayByWindow, { 1: 2 }, 'not for a tab in another window (its record lags)');
  const sleepy = (st: State) => M.sleepyTabs(st, 1e15, { afterMs: 1 }).map((t) => t.id);
  assert.ok(sleepy(M.setAway(s, 1, null)).includes(2), '(asleep after long enough, once nothing shows it away)');
  assert.ok(!sleepy(s).includes(2), 'never put to sleep while a window shows it away');
});

test('the model: a tab dragged next to one in another window takes a place beside it in the space\'s list', () => {
  let s = M.defaultState();
  // Tabs as the test gives them: without `active` (not in front).
  s = M.upsertTab(s, { id: 1, windowId: 1, url: 'https://a.example/', index: 0 } as BrowserTab, 0);
  s = M.upsertTab(s, { id: 2, windowId: 2, url: 'https://b.example/', index: 0 } as BrowserTab, 0);
  s = M.upsertTab(s, { id: 3, windowId: 1, url: 'https://c.example/', index: 1 } as BrowserTab, 0);
  const list = (st: State) => V.sidebar(st, 1).tabs.map((t) => t.id);
  assert.deepEqual(list(s), [3, 2, 1], 'newest first, across both windows');
  const below = M.placeOpen(s, 3, 2, 'after', s.tabSpace[3]);
  assert.deepEqual(list(below), [2, 3, 1], 'below 2 (an earlier place), above 1');
  // (upsertTab gives each its place: `order`.)
  assert.ok(below.tabs[3].order! > below.tabs[1].order!, '…still after 1 in window 1\'s strip: no move needed there');
  assert.equal(M.placeOpen(s, 3, 99, 'after', s.tabSpace[3]), s, 'beside a tab not in the list: nothing');
});

test('no stand-in could be made: the tab isn\'t moved (its window would lose it, maybe its last tab), but shown where it is', async () => {
  await setup();
  fake.refuseCreate = true;
  await away.bringTab(await chrome.tabs.get(1), 2, { source: 'test' });
  assert.deepEqual(fake.moves, []);
  assert.equal(fake.tabs.get(1).windowId, 1);
  assert.deepEqual((await load()).awayByWindow, {});
});
