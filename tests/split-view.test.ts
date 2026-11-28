// Split View (docs/PEEK-SPLIT.md §4), the parts with no window: Margin.app's library (app/shared/library) asking the
// hosting to show a split (`showSplit`, the pane focused), refusing what can't be a pane, closing a pane into its
// split's next one; the UI's actions (split.resize, split.addPane, split.remove) and a pane's menu; the panes' sizes
// as a divider moves (ui/behaviors/split.ts: each pane's floor, its minimum); ⌃⇧='s pick; the copy's side
// (background/hosted.ts): a pane window keeps a tab, a tab moved in replaces its blank first page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../app/shared/library/library.ts';
import { checkAction, contextFromState, requestFor } from '../app/shared/ui/actions.ts';
import { menuItems } from '../app/shared/ui/behaviors/menu-items.ts';
import { buildViewModel } from '../app/shared/ui/view-model.ts';
import { appKeyOf, dividerSizes, dragRatios, dropPlace, DROP_BAR, equalRatios, expandSizes, nextSplitPane, paneFloors, panesFit, PANE_FLOOR, PANE_FOLD, SAFARI_TOOLBAR, SNAP, SNAP_HAPTIC_SPEED } from '../app/shared/ui/behaviors/split.ts';
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

test('split view, library: a row dropped on the page (docs/FLEX-SPLIT.md step 2): at a place, in a pane\'s place, a new split\'s axis and order', () => {
  const lib = library();
  const [a, b, c, d, e] = ['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/', 'https://e.example/'].map(lib.web);
  // A new split from the item shown: `at` 0 puts the dropped one first, the axis as asked.
  const made = lib.act('addToSplit', { tabId: b, nextTo: a, at: 0, axis: 'vertical', windowId: 1 });
  assert.equal(made.ok, true);
  const sp = made.result.splitId;
  assert.deepEqual(shows(made), [{ split: sp, item: b, panes: [b, a] }]);
  assert.equal(lib.values.splits[sp].axis, 'vertical');
  // Between two panes: in that place, the ratios equal (as any add).
  const between = lib.act('addToSplit', { tabId: c, splitId: sp, at: 1, windowId: 1 });
  assert.deepEqual(shows(between), [{ split: sp, item: c, panes: [b, c, a] }]);
  assert.deepEqual(lib.values.splits[sp].ratios, [0.3333, 0.3333, 0.3333]);
  // Not a place in it (out of range, not a whole number, not a number): the end, as before.
  for (const at of [9, -1, 1.5, '0', null]) {
    const values = structuredClone(lib.values);
    const out = L.perform(values, 'addToSplit', { tabId: d, splitId: sp, at, windowId: 1 }, { now: NOW, ids: ['x'] });
    assert.deepEqual(shows(out), [{ split: sp, item: d, panes: [b, c, a, d] }], `at ${JSON.stringify(at)}`);
  }
  // In a pane's place: its ratio kept, the pane it replaces out of the split (still an item).
  lib.act('resizeSplit', { splitId: sp, ratios: [0.5, 0.3, 0.2] });
  const replaced = lib.act('addToSplit', { tabId: d, splitId: sp, replace: c, windowId: 1 });
  assert.equal(replaced.ok, true);
  assert.deepEqual(shows(replaced), [{ split: sp, item: d, panes: [b, d, a] }]);
  assert.deepEqual(lib.values.splits[sp].ratios, [0.5, 0.3, 0.2]);
  assert.ok(lib.values.tabs[c], 'the replaced item is kept');
  // A replace of a pane not in it, or of the dropped one itself: an add at the end.
  const values = structuredClone(lib.values);
  const stray = L.perform(values, 'addToSplit', { tabId: e, splitId: sp, replace: 'nope', windowId: 1 }, { now: NOW, ids: ['x'] });
  assert.deepEqual(shows(stray), [{ split: sp, item: e, panes: [b, d, a, e] }]);
  // A replace keeps the count (so a full split takes it: tests/split-tree.test.ts has the limit).
  lib.act('addToSplit', { tabId: e, splitId: sp, windowId: 1 });
  const four = lib.act('addToSplit', { tabId: c, splitId: sp, replace: e, windowId: 1 });
  assert.deepEqual(shows(four), [{ split: sp, item: c, panes: [b, d, a, c] }]);
  // An item of another split, dropped in: out of that one first (it dissolves with one left).
  const [f, g] = ['https://f.example/', 'https://g.example/'].map(lib.web);
  const other = lib.act('createSplit', { panes: [f, g], windowId: 1 }).result.splitId;
  const moved = lib.act('addToSplit', { tabId: f, splitId: sp, replace: a, windowId: 1 });
  assert.deepEqual(shows(moved), [{ split: sp, item: f, panes: [b, d, f, c] }]);
  assert.equal(lib.values.splits[other], undefined);
});

test('split view, model: addToSplit at a place, replaceInSplit keeps the ratio', () => {
  let s = M.defaultState();
  s = { ...s, keptTabs: { x: { id: 'x' }, y: { id: 'y' }, z: { id: 'z' }, w: { id: 'w' } } as any };
  s = M.createSplit(s, { id: 'sp', spaceId: s.spaces[0].id, panes: ['x', 'y'], ratios: [0.7, 0.3] });
  assert.equal(s.splits!.length, 1);
  assert.deepEqual(M.addToSplit(s, 'sp', 'z', 0).splits![0].panes, ['z', 'x', 'y']);
  assert.deepEqual(M.addToSplit(s, 'sp', 'z', 2).splits![0].panes, ['x', 'y', 'z']);
  assert.deepEqual(M.addToSplit(s, 'sp', 'z', 3).splits![0].panes, ['x', 'y', 'z'], 'past the end: the end');
  const r = M.replaceInSplit(s, 'sp', 'x', 'z');
  assert.deepEqual(r.splits![0].panes, ['z', 'y']);
  assert.deepEqual(r.splits![0].ratios, [0.7, 0.3]);
  assert.equal(M.replaceInSplit(s, 'sp', 'w', 'z'), s, 'not a pane: the state itself');
  assert.equal(M.replaceInSplit(s, 'sp', 'x', 'y'), s, 'a pane already: the state itself');
  assert.equal(M.replaceInSplit(s, 'nope', 'x', 'z'), s, 'no such split');
});

test('split view, library: what can\'t be a pane is refused: an app twice, another space\'s item, Margin\'s own page (the limit: split-tree.test.ts)', () => {
  const lib = library();
  const ids = ['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/', 'https://e.example/'].map(lib.web);
  const sp = lib.act('createSplit', { panes: ids.slice(0, 4), windowId: 1 }).result.splitId;
  assert.equal(lib.values.splits[sp].panes.length, 4);
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

test('split view, UI: a divider moves the two panes beside it, each stopping at Arc\'s 220, snapping even within 14', () => {
  // Arc's least (its split view's `minimumPaneWidth`, 220, its least height stacked too), whatever the pane's window
  // needs: a window wider than its pane is shown cut (docs/PEEK-SPLIT.md §4b).
  assert.deepEqual(PANE_FLOOR, { width: 220, height: 220 });
  const mixed = [{ id: 'a', url: 'https://a.example/' }, { id: 'n', url: 'app://com.apple.Notes' }, { id: 'x', url: 'app://com.example.Other' }];
  assert.deepEqual(paneFloors({ axis: 'horizontal', panes: mixed }), [220, 220, 220]);
  assert.deepEqual(paneFloors({ axis: 'vertical', panes: mixed }), [220, 220, 220]);
  assert.equal(appKeyOf('app://com.apple.Notes'), 'com.apple.Notes');
  assert.equal(appKeyOf('https://a.example/x'), 'web');
  assert.equal(panesFit(paneFloors({ axis: 'horizontal', panes: [mixed[0], mixed[0], mixed[0]] }), 1264, 8), true, '3 Safari panes in 1264: yes now (each 220 at least, cut where its window needs more)');
  assert.equal(panesFit(paneFloors({ axis: 'horizontal', panes: [0, 0, 0, 0, 0, 0] }), 1264, 8), false, 'six of 220 and the gaps: no');
  const r = dragRatios([600, 600], [220, 220], 0, -100);
  assert.deepEqual(r.map((v) => Math.round(v * 1200)), [500, 700]);
  assert.deepEqual(dragRatios([600, 600], [500, 220], 0, -400).map((v) => Math.round(v * 1200)), [500, 700], 'stops at the left one\'s floor');
  assert.deepEqual(dragRatios([600, 600], [220, 450], 0, 400).map((v) => Math.round(v * 1200)), [750, 450], 'stops at the right one\'s');
  assert.deepEqual(dragRatios([400, 400, 400], [220, 220, 220], 1, 100).map((v) => Math.round(v * 1200)), [400, 500, 300], 'only the two beside it');
  // The snap (Arc's 14 pt): within it of an even split of the two beside the divider, even; past it, where the pointer is.
  assert.equal(SNAP, 14);
  assert.equal(SNAP_HAPTIC_SPEED, 120);
  assert.deepEqual(dragRatios([500, 700], [220, 220], 0, 90, SNAP).map((v) => Math.round(v * 1200)), [600, 600], '590 is within 14 of 600: even');
  assert.deepEqual(dragRatios([500, 700], [220, 220], 0, 86, SNAP).map((v) => Math.round(v * 1200)), [600, 600], '586: exactly 14 off, even');
  assert.deepEqual(dragRatios([500, 700], [220, 220], 0, 85, SNAP).map((v) => Math.round(v * 1200)), [585, 615], '585: 15 off, not snapped');
  assert.deepEqual(dragRatios([400, 400, 400], [220, 220, 220], 1, 5, SNAP).map((v) => Math.round(v * 1200)), [400, 400, 400], 'even of the two beside it, the others as they are');
  assert.deepEqual(dragRatios([500, 700], [220, 220], 0, 90).map((v) => Math.round(v * 1200)), [590, 610], 'no snap asked (keys, Home/End): where it moved');
  assert.deepEqual(equalRatios(3).map((v) => Math.round(v * 300)), [100, 100, 100]);
  assert.equal(panesFit([500, 500], 1008, 8), true);
  assert.equal(panesFit([500, 500], 1000, 8), false);
});

test('split view, UI: a pane opened to fit its app (docs/FLEX-SPLIT.md step 1): its minimum, the rest folded to 64 at least', () => {
  assert.equal(PANE_FOLD, 64);
  const round = (v: number[]) => v.map((x) => Math.round(x));
  // Two panes of 500 (1000 of room), the left one's app needing 800: it gets 800, the other the 200 left.
  assert.deepEqual(round(expandSizes([500, 500], [800, 400], 0)), [800, 200]);
  // Its need more than the room less the others' folds: as much as that leaves (1000 - 64).
  assert.deepEqual(round(expandSizes([500, 500], [1200, 400], 0)), [936, 64]);
  // Three panes: the others share what's left by their sizes (300 : 500 of 1100 - 700 = 400 → 150 : 250).
  assert.deepEqual(round(expandSizes([300, 300, 500], [400, 700, 300], 1)), [150, 700, 250]);
  // One of them pushed below the fold: held at 64, the rest from the others (400 - 64 = 336 to the third).
  assert.deepEqual(round(expandSizes([100, 300, 1100], [400, 1100, 300], 1)), [64, 1100, 336]);
  // Four panes, the last opened, the others each held at the fold.
  assert.deepEqual(round(expandSizes([300, 300, 300, 300], [500, 500, 500, 1300], 3)), [64, 64, 64, 1008]);
  // Already as big as its app needs: nothing changes (another pane's cut, but only the opened one is opened).
  assert.deepEqual(expandSizes([600, 400], [500, 700], 0), [600, 400]);
  // Its need not known, an index past the panes, a single pane, no room: nothing changes.
  assert.deepEqual(expandSizes([500, 500], [null, 400], 0), [500, 500]);
  assert.deepEqual(expandSizes([500, 500], [800, 400], 2), [500, 500]);
  assert.deepEqual(expandSizes([500], [800], 0), [500]);
  assert.deepEqual(expandSizes([0, 0], [800, 400], 0), [0, 0]);
  // The room is kept: the sizes add up to what they were.
  for (const [s, n, i] of [[[300, 300, 500], [400, 700, 300], 1], [[100, 300, 1100], [400, 1100, 300], 1], [[250, 250, 250, 250], [900, 0, 0, 0], 0]] as [number[], number[], number][]) {
    const out = expandSizes(s, n, i);
    assert.ok(Math.abs(out.reduce((a, b) => a + b, 0) - s.reduce((a, b) => a + b, 0)) < 1e-6, `${s} keeps its room`);
    assert.ok(out.every((x, j) => j === i || x >= PANE_FOLD - 1e-6), `${s}: none below the fold`);
  }
});

test('split view, UI: where a row dropped on the page goes (docs/FLEX-SPLIT.md step 2): a page\'s nearest edge, a pane\'s ends and middle, between', () => {
  const page = { left: 100, top: 50, width: 800, height: 600 };
  // One page: its nearest edge, a new split's place and axis, the half the new pane takes.
  assert.deepEqual(dropPlace([page], null, 150, 350), { kind: 'side', at: 0, axis: 'horizontal', rect: { left: 100, top: 50, width: 400, height: 600 } });
  assert.deepEqual(dropPlace([page], null, 880, 300), { kind: 'side', at: 1, axis: 'horizontal', rect: { left: 500, top: 50, width: 400, height: 600 } });
  assert.deepEqual(dropPlace([page], null, 500, 60), { kind: 'side', at: 0, axis: 'vertical', rect: { left: 100, top: 50, width: 800, height: 300 } });
  assert.deepEqual(dropPlace([page], null, 500, 640), { kind: 'side', at: 1, axis: 'vertical', rect: { left: 100, top: 350, width: 800, height: 300 } });
  assert.equal(dropPlace([page], null, 99, 300), null, 'outside the page');
  assert.equal(dropPlace([], null, 150, 300), null);
  // Side by side, two panes 8 apart: a pane's ends (a quarter each) beside it, its middle in its place, the gap between.
  const two = [{ left: 100, top: 50, width: 396, height: 600 }, { left: 504, top: 50, width: 396, height: 600 }];
  const bar = (left: number) => ({ left, top: 50, width: DROP_BAR, height: 600 });
  assert.deepEqual(dropPlace(two, 'horizontal', 120, 300), { kind: 'between', at: 0, axis: 'horizontal', rect: bar(100) }, 'the first pane\'s start: the page\'s edge');
  assert.deepEqual(dropPlace(two, 'horizontal', 480, 300), { kind: 'between', at: 1, axis: 'horizontal', rect: bar(500 - DROP_BAR / 2) });
  assert.deepEqual(dropPlace(two, 'horizontal', 500, 300), { kind: 'between', at: 1, axis: 'horizontal', rect: bar(500 - DROP_BAR / 2) }, 'the gap');
  assert.deepEqual(dropPlace(two, 'horizontal', 520, 300), { kind: 'between', at: 1, axis: 'horizontal', rect: bar(500 - DROP_BAR / 2) });
  assert.deepEqual(dropPlace(two, 'horizontal', 890, 300), { kind: 'between', at: 2, axis: 'horizontal', rect: bar(900 - DROP_BAR) }, 'the last pane\'s end');
  assert.deepEqual(dropPlace(two, 'horizontal', 300, 300), { kind: 'replace', at: 0, axis: 'horizontal', rect: two[0] });
  assert.deepEqual(dropPlace(two, 'horizontal', 700, 60), { kind: 'replace', at: 1, axis: 'horizontal', rect: two[1] }, 'its top: still its middle along the axis');
  assert.equal(dropPlace(two, 'horizontal', 300, 660), null, 'below the panes');
  // Full (no pane can be added): every place in a pane is its place, the gap none.
  assert.deepEqual(dropPlace(two, 'horizontal', 120, 300, false), { kind: 'replace', at: 0, axis: 'horizontal', rect: two[0] });
  assert.equal(dropPlace(two, 'horizontal', 500, 300, false), null);
  // Stacked: along y.
  const stacked = [{ left: 100, top: 50, width: 800, height: 296 }, { left: 100, top: 354, width: 800, height: 296 }];
  assert.deepEqual(dropPlace(stacked, 'vertical', 500, 340), { kind: 'between', at: 1, axis: 'vertical', rect: { left: 100, top: 350 - DROP_BAR / 2, width: 800, height: DROP_BAR } });
  assert.deepEqual(dropPlace(stacked, 'vertical', 500, 500), { kind: 'replace', at: 1, axis: 'vertical', rect: stacked[1] });
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
