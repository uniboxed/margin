// Split View (docs/PEEK-SPLIT.md §4), the parts with no window: Margin.app's library (app/shared/library) asking the
// hosting to show a split (`showSplit`, the pane focused), refusing what can't be a pane, closing a pane into its
// split's next one; the UI's actions (split.resize, split.addPane, split.remove) and a pane's menu; the panes' sizes
// as a divider moves (ui/behaviors/split.ts: each pane's floor, its minimum); ⌃⇧='s pick; the copy's side
// (background/hosted.ts): a pane window keeps a tab, a tab moved in replaces its blank first page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../app/shared/library/library.ts';
import { checkAction, contextFromState, requestFor } from '../extension/ui/actions.ts';
import { menuItems } from '../extension/ui/behaviors/menu-items.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { appKeyOf, dividerSizes, dragRatios, equalRatios, nextSplitPane, paneFloors, panesFit, PANE_FLOOR, SAFARI_TOOLBAR } from '../extension/ui/behaviors/split.ts';
import { createHostedTabs } from '../extension/background/hosted.ts';
import * as M from '../extension/state/model.ts';

const NOW = 1_000_000;
function applyChanges(values: L.Values, changes: L.Change[]): L.Values {
  const next: L.Values = structuredClone(values);
  for (const c of changes) {
    next[c.collection] ??= {};
    if ('deleted' in c && c.deleted) delete next[c.collection][c.id];
    else next[c.collection][c.id] = (c as { value: any }).value;
  }
  return next;
}
// A library with spaces `a` and `b`, window 1 showing `a`.
function library() {
  let values: L.Values = {
    spaces: { a: { name: 'A', order: 0, browser: 'safari', profile: null }, b: { name: 'B', order: 1, browser: 'safari', profile: 'work' } },
    pins: {}, favorites: {}, airTraffic: {}, splits: {}, folders: {}, tabs: {}, archive: {}, windows: { 1: { spaceId: 'a' } }, imports: {},
  };
  let n = 0;
  const act = (action: string, payload: any = {}) => {
    const out = L.perform(values, action, payload, { now: NOW + n, ids: [`id${String(++n).padStart(4, '0')}`] });
    if (out.ok) values = applyChanges(values, out.changes);
    return out;
  };
  const web = (url: string) => act('newTab', { windowId: 1, url, title: url }).result.tabId as string;
  const app = (bundleId: string, name = bundleId) => act('addItem', { windowId: 1, spaceId: 'a', url: `app://${bundleId}`, title: name, target: { kind: 'app', bundleId, name }, front: true }).result.tabId as string;
  return { act, web, app, get values() { return values; } };
}
const shows = (out: L.Outcome) => out.requests.filter((r) => r.type === 'showSplit').map((r) => ({ split: r.splitId, item: r.item, panes: r.panes.map((p: any) => p.item) }));

test('split view, library: a split made or added to asks the hosting to show it, the pane added focused', () => {
  const lib = library();
  const [a, b, c] = ['https://a.example/', 'https://b.example/', 'https://c.example/'].map(lib.web);
  const made = lib.act('createSplit', { panes: [a, b], windowId: 1 });
  assert.equal(made.ok, true);
  const sp = made.result.splitId;
  assert.deepEqual(shows(made), [{ split: sp, item: b, panes: [a, b] }], 'shown, the last pane focused');
  assert.equal(made.requests[0].windowId, 1);
  // Arc's Add to Split View on another row: into the split of the item in front.
  const added = lib.act('addToSplit', { tabId: c, windowId: 1 });
  assert.equal(added.ok, true);
  assert.deepEqual(shows(added), [{ split: sp, item: c, panes: [a, b, c] }]);
  // A pane already: the split shown with it focused, nothing changed.
  const again = lib.act('addToSplit', { tabId: a, windowId: 1, splitId: sp });
  assert.deepEqual(shows(again), [{ split: sp, item: a, panes: [a, b, c] }]);
  assert.deepEqual(again.changes.filter((ch) => ch.collection === 'splits'), []);
  // Opened (the capsule's row): its first pane, else the one asked.
  assert.deepEqual(shows(lib.act('openSplit', { splitId: sp, windowId: 1 })), [{ split: sp, item: a, panes: [a, b, c] }]);
  assert.deepEqual(shows(lib.act('openSplit', { splitId: sp, windowId: 1, focus: c })), [{ split: sp, item: c, panes: [a, b, c] }]);
  // A resize asks nothing (the page placed the panes as it was dragged); a swap and the axis show it again.
  assert.deepEqual(lib.act('resizeSplit', { splitId: sp, ratios: [0.5, 0.3, 0.2] }).requests, []);
  assert.deepEqual(lib.values.splits[sp].ratios, [0.5, 0.3, 0.2]);
  assert.deepEqual(shows(lib.act('swapSplit', { splitId: sp, windowId: 1 })), [{ split: sp, item: null, panes: [b, a, c] }]);
  const turned = lib.act('toggleSplitAxis', { splitId: sp, windowId: 1 });
  assert.deepEqual(shows(turned), [{ split: sp, item: null, panes: [b, a, c] }]);
  assert.equal(lib.values.splits[sp].axis, 'vertical');
});

test('split view, library: what can\'t be a pane is refused: a fifth, an app twice, another space\'s item, Margin\'s own page', () => {
  const lib = library();
  const ids = ['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/', 'https://e.example/'].map(lib.web);
  const sp = lib.act('createSplit', { panes: ids.slice(0, 4), windowId: 1 }).result.splitId;
  const fifth = lib.act('addToSplit', { tabId: ids[4], splitId: sp, windowId: 1 });
  assert.equal(fifth.ok, false);
  assert.match(fifth.error!, /4 panes at most/);
  assert.equal(lib.act('createSplit', { panes: ids, windowId: 1 }).ok, false, 'five at once');
  const edit1 = lib.app('com.apple.TextEdit', 'TextEdit');
  const two = lib.act('createSplit', { panes: [ids[4], edit1], windowId: 1 });
  assert.equal(two.ok, true);
  // (The library keeps one item per app in a space; a second item of the same app, as an older build may have left.)
  const values = structuredClone(lib.values);
  values.tabs['t-edit2'] = { ...values.tabs[edit1] };
  const twice = L.perform(values, 'addToSplit', { tabId: 't-edit2', splitId: two.result.splitId, windowId: 1 }, { now: NOW, ids: ['x'] });
  assert.equal(twice.ok, false);
  assert.match(twice.error!, /TextEdit is in this split already/);
  const settings = lib.act('openMarginPage', { page: 'settings', windowId: 1 }).result.tabId;
  const page = lib.act('addToSplit', { tabId: settings, nextTo: ids[4], windowId: 1 });
  assert.equal(page.ok, false);
  assert.match(page.error!, /own pages/);
  const other = lib.act('newTab', { windowId: 1, url: 'https://other.example/', spaceId: 'b' }).result.tabId;
  const cross = lib.act('createSplit', { panes: [ids[4], other], windowId: 1, spaceId: 'a' });
  assert.equal(cross.ok, false);
  assert.match(cross.error!, /of one space/);
});

test('split view, library: a pane closed (⌘W) shows the split\'s next pane, the split going on; the last two: the one left, alone', () => {
  const lib = library();
  const [a, b, c] = ['https://a.example/', 'https://b.example/', 'https://c.example/'].map(lib.web);
  const x = lib.web('https://x.example/'); // (used last: the space's front item otherwise)
  const sp = lib.act('createSplit', { panes: [a, b, c], windowId: 1 }).result.splitId;
  lib.act('activateTab', { tabId: x, windowId: 1 });
  const closed = lib.act('closeTab', { tabId: b, windowId: 1 });
  const req = closed.requests.find((r) => r.type === 'closeTab')!;
  assert.equal(req.next, c, 'the pane after it, not the space\'s front item');
  assert.deepEqual(lib.values.splits[sp].panes, [a, c]);
  const last = lib.act('closeTab', { tabId: c, windowId: 1 });
  assert.equal(last.requests.find((r) => r.type === 'closeTab')!.next, a, 'the one before it when it was the last');
  assert.equal(lib.values.splits[sp], undefined, 'one left: no split');
});

test('split view, library: Remove from Split View shows the rest; Break Out shows the pane alone', () => {
  const lib = library();
  const [a, b, c] = ['https://a.example/', 'https://b.example/', 'https://c.example/'].map(lib.web);
  const sp = lib.act('createSplit', { panes: [a, b, c], windowId: 1 }).result.splitId;
  const removed = lib.act('removeFromSplit', { tabId: a, windowId: 1 });
  assert.deepEqual(shows(removed), [{ split: sp, item: b, panes: [b, c] }]);
  assert.equal(lib.values.tabs[a] != null, true, 'the item stays (out of the split)');
  const out = lib.act('breakOutSplit', { tabId: c, windowId: 1 });
  assert.deepEqual(out.requests.map((r) => [r.type, r.item]), [['activateTab', c]]);
  assert.equal(lib.values.splits[sp], undefined, 'one left: no split');
  // Removing from a split of two: the one left, shown alone.
  const sp2 = lib.act('createSplit', { panes: [a, b], windowId: 1 }).result.splitId;
  const left = lib.act('removeFromSplit', { tabId: b, windowId: 1 });
  assert.deepEqual(left.requests.map((r) => [r.type, r.item]), [['activateTab', a]]);
  assert.equal(lib.values.splits[sp2], undefined);
});

test('split view, library: a pane Margin.app takes out (it couldn\'t open) keeps the keys where they were (`focus`)', () => {
  const lib = library();
  const [a, b, c] = ['https://a.example/', 'https://b.example/', 'https://c.example/'].map(lib.web);
  const sp = lib.act('createSplit', { panes: [a, b, c], windowId: 1 }).result.splitId;
  // (c, the one added, failed: a had the keys before it; never c's neighbour b by the next-pane rule.)
  const removed = lib.act('removeFromSplit', { tabId: c, windowId: 1, focus: a });
  assert.deepEqual(shows(removed), [{ split: sp, item: a, panes: [a, b] }]);
  // A focus that isn't one of the rest (the removed one itself, another item): the next-pane rule, as before.
  const sp2 = lib.act('createSplit', { panes: [a, b, c], windowId: 1 }).result.splitId;
  assert.deepEqual(shows(lib.act('removeFromSplit', { tabId: b, windowId: 1, focus: b })), [{ split: sp2, item: c, panes: [a, c] }]);
});

// ---- the UI ----

function splitState() {
  let s = M.defaultState();
  s = M.createSpace(s, { id: 'personal', name: 'P' });
  for (const [id, url] of [[1, 'https://a.example/'], [2, 'https://b.example/'], [3, 'https://c.example/']] as const) {
    s = M.upsertTab(s, { id, windowId: 1, url, title: `t${id}`, index: id, active: id === 1 } as BrowserTab, NOW + id);
    s = M.moveTab(s, id, 'personal');
  }
  s = M.setActiveSpace(s, 1, 'personal');
  return M.createSplit(s, { id: 'sp', spaceId: 'personal', panes: [1, 2] });
}

test('split view, UI: split.resize, split.addPane, split.remove are checked and sent', () => {
  const s = splitState();
  const ctx = contextFromState(s);
  assert.equal(checkAction('split.resize', { split: 'sp', ratios: [0.3, 0.7] }, ctx).ok, true);
  for (const bad of [[0.3], [0, 1], [0.2, 0.2, 0.2, 0.2, 0.2], ['a', 'b'], [2, 1]]) assert.equal(checkAction('split.resize', { split: 'sp', ratios: bad }, ctx).ok, false, JSON.stringify(bad));
  assert.equal(checkAction('split.resize', { split: 'nope', ratios: [0.5, 0.5] }, ctx).ok, false);
  assert.deepEqual(requestFor('split.resize', { split: 'sp', ratios: [0.3, 0.7] }, { state: s, ui: { windowId: 1 } }), { kind: 'send', type: 'resizeSplit', payload: { splitId: 'sp', ratios: [0.3, 0.7], windowId: 1 } });
  assert.deepEqual(requestFor('split.addPane', 3, { state: s, ui: { windowId: 1 } }), { kind: 'send', type: 'addToSplit', payload: { tabId: 3, windowId: 1 } });
  assert.deepEqual(requestFor('split.remove', 2, { state: s, ui: { windowId: 1 } }), { kind: 'send', type: 'removeFromSplit', payload: { tabId: 2, windowId: 1 } });
});

test('split view, UI: a pane\'s menu has Remove, Break Out, Swap, Stacked; another row Add to Split View', () => {
  const s = splitState();
  const vm = buildViewModel({ state: s, ui: { windowId: 1, tabId: 1 } });
  const pane = menuItems({ kind: 'tab', id: 2 }, { state: s, space: vm.space }).map((i) => [i.label, i.action]);
  for (const want of [['Remove from Split View', 'split.remove'], ['Break Out of Split View', 'split.breakOut'], ['Swap Panes', 'split.swap'], ['Stacked', 'split.toggleAxis']]) {
    assert.ok(pane.some(([l, a]) => l === want[0] && a === want[1]), `${want[0]}: ${JSON.stringify(pane)}`);
  }
  assert.equal(pane.some(([, a]) => a === 'split.add'), false);
  const other = menuItems({ kind: 'tab', id: 3 }, { state: s, space: vm.space }).map((i) => [i.label, i.action]);
  assert.ok(other.some(([l, a]) => l === 'Add to Split View' && a === 'split.add'));
  const stacked = M.toggleSplitAxis(s, 'sp');
  assert.ok(menuItems({ kind: 'tab', id: 2 }, { state: stacked, space: vm.space }).some((i) => i.label === 'Side by Side'));
});

test('split view, UI: a divider moves the two panes beside it, each stopping at its floor', () => {
  assert.deepEqual(paneFloors({ axis: 'horizontal', panes: [{ id: 'a' }, { id: 'b' }] as any }, { a: [500, 300] }), [500, PANE_FLOOR.width]);
  assert.deepEqual(paneFloors({ axis: 'vertical', panes: [{ id: 'a' }, { id: 'b' }] as any }, { a: [500, 300] }), [300, PANE_FLOOR.height]);
  // Its app's known minimum (Margin.app's `appMin`: `web` for Safari's pages, an app by its bundle id), whether its
  // window is open or not: a pane not opened yet, main, one being added (2026-11-21: a third Safari pane let in).
  const apps = { web: [574, 220], 'com.apple.Notes': [700, 400] } as Record<string, [number, number]>;
  const mixed = [{ id: 'a', url: 'https://a.example/' }, { id: 'n', url: 'app://com.apple.Notes' }, { id: 'x', url: 'app://com.example.Other' }];
  assert.deepEqual(paneFloors({ axis: 'horizontal', panes: mixed }, {}, apps), [574, 700, PANE_FLOOR.width]);
  assert.deepEqual(paneFloors({ axis: 'vertical', panes: mixed }, {}, apps), [220, 400, PANE_FLOOR.height]);
  assert.deepEqual(paneFloors({ axis: 'horizontal', panes: mixed }, { a: [600, 0], n: [650, 0] }, apps), [600, 700, PANE_FLOOR.width], 'the larger of its own and its app\'s');
  assert.equal(appKeyOf('app://com.apple.Notes'), 'com.apple.Notes');
  assert.equal(appKeyOf('https://a.example/x'), 'web');
  assert.equal(panesFit(paneFloors({ axis: 'horizontal', panes: [mixed[0], mixed[0], mixed[0]] }, {}, apps), 1264, 8), false, '3 Safari panes in 1264: no');
  const r = dragRatios([600, 600], [200, 200], 0, -100);
  assert.deepEqual(r.map((v) => Math.round(v * 1200)), [500, 700]);
  assert.deepEqual(dragRatios([600, 600], [500, 200], 0, -400).map((v) => Math.round(v * 1200)), [500, 700], 'stops at the left one\'s floor');
  assert.deepEqual(dragRatios([600, 600], [200, 450], 0, 400).map((v) => Math.round(v * 1200)), [750, 450], 'stops at the right one\'s');
  assert.deepEqual(dragRatios([400, 400, 400], [200, 200, 200], 1, 100).map((v) => Math.round(v * 1200)), [400, 500, 300], 'only the two beside it');
  assert.deepEqual(equalRatios(3).map((v) => Math.round(v * 300)), [100, 100, 100]);
  assert.equal(panesFit([500, 500], 1008, 8), true);
  assert.equal(panesFit([500, 500], 1000, 8), false);
});

test('split view, UI: stacked, the gap above a Safari pane is a band its full-screen toolbar rests in (never over the pane above)', () => {
  const web = (id: string) => ({ id, url: `https://${id}.example/` });
  const app = (id: string) => ({ id, url: 'app://com.apple.Notes' });
  assert.equal(SAFARI_TOOLBAR, 52, 'Safari\'s full-screen toolbar window: 52 pt, resting just above its window');
  assert.deepEqual(dividerSizes({ axis: 'vertical', panes: [web('a'), web('b'), app('c')] }, 8), [52, 8], 'above a web pane the band, above an app the gap');
  assert.deepEqual(dividerSizes({ axis: 'vertical', panes: [app('a'), web('b')] }, 60), [60], 'a theme\'s gap wider than the band: the gap');
  assert.deepEqual(dividerSizes({ axis: 'horizontal', panes: [web('a'), web('b'), web('c')] }, 10), [10, 10], 'side by side: the toolbars rest under Margin\'s top frame, no band');
  assert.deepEqual(dividerSizes({ axis: 'vertical', panes: [web('a'), { id: 'm', url: 'margin://settings' }] }, 8), [8], 'Margin\'s own page has no toolbar');
  // The room check takes the bands: three stacked web panes need 3 floors and 2 bands.
  const floors = [140, 140, 140];
  assert.equal(panesFit(floors, 436, 8), true, 'with plain gaps it would fit');
  assert.equal(panesFit(floors, 436, dividerSizes({ axis: 'vertical', panes: [web('a'), web('b'), web('c')] }, 8)), false, 'with the bands it doesn\'t');
  assert.equal(panesFit(floors, 524, [52, 52]), true);
});

test('split view, UI: ⌃⇧= adds the item used last that isn\'t in front or a pane; none: null (the palette then)', () => {
  let s = splitState();
  s = M.upsertTab(s, { id: 4, windowId: 1, url: 'https://d.example/', title: 't4', index: 4, active: false, lastActive: NOW + 50 } as BrowserTab, NOW + 50);
  s = M.moveTab(s, 4, 'personal');
  const vm = buildViewModel({ state: s, ui: { windowId: 1, tabId: 1 } });
  const pick = nextSplitPane(s, vm);
  assert.ok(pick === 4 || pick === 3, `a row not in front, not a pane: ${pick}`);
  assert.notEqual(pick, 1);
  assert.notEqual(pick, 2);
  let alone = M.defaultState();
  alone = M.createSpace(alone, { id: 'personal', name: 'P' });
  alone = M.upsertTab(alone, { id: 1, windowId: 1, url: 'https://a.example/', title: 't1', index: 1, active: true } as BrowserTab, NOW);
  alone = M.moveTab(alone, 1, 'personal');
  alone = M.setActiveSpace(alone, 1, 'personal');
  assert.equal(nextSplitPane(alone, buildViewModel({ state: alone, ui: { windowId: 1, tabId: 1 } })), null);
});

// ---- the copy's side ----

function fakeTabs(list: { id: number, windowId: number, url: string, active: boolean }[]) {
  const tabs = new Map(list.map((t) => [t.id, { ...t }]));
  let next = 100;
  const calls: string[] = [];
  const api = {
    async get(id: number) { const t = tabs.get(id); if (!t) throw new Error('none'); return { ...t }; },
    async query({ windowId }: { windowId?: number }) { return [...tabs.values()].filter((t) => windowId == null || t.windowId === windowId).map((t) => ({ ...t })); },
    async create({ windowId, url, active }: { windowId: number, url: string, active: boolean }) { const t = { id: next++, windowId, url, active }; tabs.set(t.id, t); calls.push(`create ${windowId} ${url}`); return { ...t }; },
    async update(id: number, { url, active }: { url?: string, active?: boolean }) { const t = tabs.get(id)!; if (url) t.url = url; if (active) t.active = true; calls.push(`update ${id}${url ? ` ${url}` : ''}${active ? ' active' : ''}`); return { ...t }; },
    async move(id: number, { windowId }: { windowId: number, index: number }) { const t = tabs.get(id)!; t.windowId = windowId; calls.push(`move ${id} ${windowId}`); return { ...t }; },
    async remove(id: number) { tabs.delete(id); calls.push(`remove ${id}`); },
  };
  return { api, tabs, calls };
}

test('split view, copy: a tab moved into a pane window replaces its blank first page; a pane\'s last tab closed leaves the window a blank one', async () => {
  // Window 9: the profile's main window; 7: a pane window Margin made (its first page blank), shown in once.
  const f = fakeTabs([{ id: 1, windowId: 9, url: 'about:blank', active: true }, { id: 2, windowId: 7, url: 'about:blank', active: true }]);
  const h = createHostedTabs(() => f.api);
  await h.show({ windowId: 9, itemId: 't-aaaa', url: 'https://a.example/' }); // (100 in 9, its blank page closed)
  await h.show({ windowId: 9, itemId: 't-bbbb', url: 'https://b.example/' }); // (101 beside it)
  f.calls.length = 0;
  assert.deepEqual(await h.show({ windowId: 7, itemId: 't-aaaa', url: 'https://a.example/' }), { tabId: 100, created: false, moved: true });
  assert.deepEqual(f.calls, ['move 100 7', 'remove 2', 'update 100 active'], 'moved in, the blank first page closed, never left behind');
  assert.deepEqual([...f.tabs.values()].filter((t) => t.windowId === 7).map((t) => t.id), [100]);
  // Its tab closed (⌘W on the pane): the window keeps a blank page (it's Margin's: the app parks or reuses it).
  f.calls.length = 0;
  assert.deepEqual(await h.close({ itemId: 't-aaaa' }), { closed: true });
  assert.deepEqual(f.calls, ['create 7 about:blank', 'remove 100']);
  assert.deepEqual([...f.tabs.values()].filter((t) => t.windowId === 7).map((t) => t.url), ['about:blank']);
  // A tab in a window the app never showed in (dragged into the person's): closed as before, nothing left for it.
  const g = fakeTabs([{ id: 5, windowId: 3, url: 'https://keep.example/', active: true }]);
  const k = createHostedTabs(() => g.api);
  await k.show({ windowId: 4, itemId: 't-dddd', url: 'https://d.example/' }); // (100 made in window 4)
  g.tabs.get(100)!.windowId = 3;
  g.calls.length = 0;
  await k.close({ itemId: 't-dddd' });
  assert.deepEqual(g.calls, ['remove 100']);
});
