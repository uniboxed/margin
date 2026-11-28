// A split's tree (docs/FLEX-SPLIT.md step 3; extension/shared/split-tree.ts): the rules, the state's (state/model.ts),
// and Margin.app's library (app/shared/library/library.ts) making, reading, changing and settling nested splits; flat
// splits stored and changed exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../app/shared/library/library.ts';
import * as M from '../extension/state/model.ts';
import { areaShares, besideLeaf, canonical, leavesOf, MAX_SPLIT_PANES, pathOf, storedOf, storedTree, treeOf, turned, type SplitNode } from '../extension/shared/split-tree.ts';

const NOW = 1_000_000;

test('split tree: canonical form: a node of one kid is that kid, a node running its parent\'s way merges into it', () => {
  assert.deepEqual(canonical({ axis: 'horizontal', kids: ['a'], ratios: [1] }), 'a');
  assert.deepEqual(canonical({ axis: 'horizontal', kids: ['a', { axis: 'horizontal', kids: ['b', 'c'], ratios: [1, 3] }], ratios: [1, 1] }),
    { axis: 'horizontal', kids: ['a', 'b', 'c'], ratios: [0.5, 0.125, 0.375] });
  assert.deepEqual(canonical({ axis: 'horizontal', kids: ['a', { axis: 'vertical', kids: ['b'], ratios: [1] }], ratios: [3, 1] }),
    { axis: 'horizontal', kids: ['a', 'b'], ratios: [0.75, 0.25] });
  assert.equal(canonical({ axis: 'vertical', kids: [], ratios: [] }), null);
});

test('split tree: stored as before when flat; nested, its tree with each pane\'s share of the area as its ratio', () => {
  assert.deepEqual(storedOf({ axis: 'horizontal', kids: ['a', 'b'], ratios: [0.6, 0.4] }), { axis: 'horizontal', panes: ['a', 'b'], ratios: [0.6, 0.4] });
  const nested: SplitNode = { axis: 'horizontal', kids: ['a', { axis: 'vertical', kids: ['b', 'c'], ratios: [0.5, 0.5] }], ratios: [0.5, 0.5] };
  assert.deepEqual(storedOf(nested), { axis: 'horizontal', panes: ['a', 'b', 'c'], ratios: [0.5, 0.25, 0.25], tree: nested });
  assert.deepEqual(areaShares(nested), [0.5, 0.25, 0.25]);
  assert.deepEqual(leavesOf(nested), ['a', 'b', 'c']);
  assert.equal(storedOf('a'), null, 'one pane: no split');
});

test('split tree: a stored tree read only when it\'s one for the split\'s panes', () => {
  const nested: SplitNode = { axis: 'horizontal', kids: ['a', { axis: 'vertical', kids: ['b', 'c'], ratios: [0.5, 0.5] }], ratios: [0.5, 0.5] };
  assert.equal(storedTree(nested, ['a', 'b', 'c']), nested);
  assert.equal(storedTree(nested, ['a', 'c', 'b']), null, 'another order');
  assert.equal(storedTree(nested, ['a', 'b']), null, 'other panes');
  assert.equal(storedTree({ axis: 'horizontal', kids: ['a', 'b'], ratios: [1, 1] }, ['a', 'b']), null, 'flat: never a tree');
  assert.equal(storedTree({ axis: 'horizontal', kids: ['a', { axis: 'horizontal', kids: ['b', 'c'], ratios: [1, 1] }], ratios: [1, 1] }, ['a', 'b', 'c']), null, 'a kid running its parent\'s way');
  assert.equal(storedTree({ axis: 'diagonal', kids: ['a', { axis: 'vertical', kids: ['b', 'c'], ratios: [1, 1] }], ratios: [1, 1] }, ['a', 'b', 'c']), null);
  assert.equal(storedTree({ axis: 'horizontal', kids: ['a', { axis: 'vertical', kids: ['b', 'c'], ratios: [1, -1] }], ratios: [1, 1] }, ['a', 'b', 'c']), null);
  assert.equal(storedTree('a', ['a']), null);
  assert.deepEqual(treeOf({ axis: 'vertical', panes: ['a', 'b'], ratios: [0.7, 0.3] }), { axis: 'vertical', kids: ['a', 'b'], ratios: [0.7, 0.3] });
});

test('split tree: beside a pane: in its node when that runs the side\'s way (its room halved), else across it', () => {
  const flat: SplitNode = { axis: 'horizontal', kids: ['a', 'b'], ratios: [0.5, 0.5] };
  assert.deepEqual(besideLeaf(flat, 'b', 'right', 'c'), { axis: 'horizontal', kids: ['a', 'b', 'c'], ratios: [0.5, 0.25, 0.25] });
  assert.deepEqual(besideLeaf(flat, 'a', 'left', 'c'), { axis: 'horizontal', kids: ['c', 'a', 'b'], ratios: [0.25, 0.25, 0.5] });
  assert.deepEqual(besideLeaf(flat, 'b', 'bottom', 'c'), { axis: 'horizontal', kids: ['a', { axis: 'vertical', kids: ['b', 'c'], ratios: [0.5, 0.5] }], ratios: [0.5, 0.5] });
  assert.deepEqual(besideLeaf(flat, 'a', 'top', 'c'), { axis: 'horizontal', kids: [{ axis: 'vertical', kids: ['c', 'a'], ratios: [0.5, 0.5] }, 'b'], ratios: [0.5, 0.5] });
  assert.equal(besideLeaf(flat, 'x', 'top', 'c'), null);
  // (In a nested node: its own way there.)
  const nested = besideLeaf(flat, 'b', 'bottom', 'c')!;
  assert.deepEqual(besideLeaf(nested, 'c', 'bottom', 'd'), { axis: 'horizontal', kids: ['a', { axis: 'vertical', kids: ['b', 'c', 'd'], ratios: [0.5, 0.25, 0.25] }], ratios: [0.5, 0.5] });
  assert.deepEqual(besideLeaf(nested, 'c', 'right', 'd'), { axis: 'horizontal', kids: ['a', { axis: 'vertical', kids: ['b', { axis: 'horizontal', kids: ['c', 'd'], ratios: [0.5, 0.5] }], ratios: [0.5, 0.5] }], ratios: [0.5, 0.5] });
});

test('split tree: turned: every node the other way; a path: whole numbers 0 or more', () => {
  assert.deepEqual(turned({ axis: 'horizontal', kids: ['a', { axis: 'vertical', kids: ['b', 'c'], ratios: [1, 1] }], ratios: [1, 1] }),
    { axis: 'vertical', kids: ['a', { axis: 'horizontal', kids: ['b', 'c'], ratios: [1, 1] }], ratios: [1, 1] });
  assert.deepEqual(pathOf([0, 1]), [0, 1]);
  assert.deepEqual(pathOf([]), []);
  for (const bad of [[-1], [0.5], ['1'], 3, null, {}]) assert.equal(pathOf(bad), null, JSON.stringify(bad));
  assert.equal(MAX_SPLIT_PANES, 16);
});

// ---- the library: nested splits made, changed, settled -----------------------------------------------------------

function applyChanges(values: L.Values, changes: L.Change[]): L.Values {
  const next: L.Values = structuredClone(values);
  for (const c of changes) {
    next[c.collection] ??= {};
    if ('deleted' in c && c.deleted) delete next[c.collection][c.id];
    else next[c.collection][c.id] = (c as { value: any }).value;
  }
  return next;
}
function library() {
  let values: L.Values = {
    spaces: { a: { name: 'A', order: 0, browser: 'safari', profile: null } },
    pins: {}, favorites: {}, airTraffic: {}, splits: {}, folders: {}, tabs: {}, archive: {}, windows: { 1: { spaceId: 'a' } }, imports: {},
  };
  let n = 0;
  const act = (action: string, payload: any = {}) => {
    const out = L.perform(values, action, payload, { now: NOW + n, ids: [`id${String(++n).padStart(4, '0')}`] });
    if (out.ok) values = applyChanges(values, out.changes);
    return out;
  };
  const web = (url: string) => act('newTab', { windowId: 1, url, title: url }).result.tabId as string;
  return { act, web, get values() { return values; } };
}

test('split tree, library: a pane split across, stored with its tree; resized, turned, swapped, its panes taken out', () => {
  const lib = library();
  const [a, b, c, d] = ['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/'].map(lib.web);
  const sp = lib.act('createSplit', { panes: [a, b], windowId: 1 }).result.splitId;
  assert.equal(lib.values.splits[sp].tree, undefined, 'flat: no tree');
  // c below b: b's pane split across.
  const below = lib.act('addToSplit', { tabId: c, splitId: sp, beside: b, side: 'bottom', windowId: 1 });
  assert.equal(below.ok, true);
  const tree = { axis: 'horizontal', kids: [a, { axis: 'vertical', kids: [b, c], ratios: [0.5, 0.5] }], ratios: [0.5, 0.5] };
  assert.deepEqual(lib.values.splits[sp], { spaceId: 'a', axis: 'horizontal', panes: [a, b, c], ratios: [0.5, 0.25, 0.25], tree });
  const shown = below.requests.find((r) => r.type === 'showSplit')!;
  assert.deepEqual(shown.panes.map((p: any) => p.item), [a, b, c], 'shown with all its panes, c focused');
  assert.equal(shown.item, c);
  // The inner node resized (its path), then the root.
  lib.act('resizeSplit', { splitId: sp, path: [1], ratios: [0.25, 0.75] });
  assert.deepEqual(lib.values.splits[sp].tree.kids[1].ratios, [0.25, 0.75]);
  assert.deepEqual(lib.values.splits[sp].ratios, [0.5, 0.125, 0.375]);
  lib.act('resizeSplit', { splitId: sp, ratios: [0.4, 0.6] });
  assert.deepEqual(lib.values.splits[sp].tree.ratios, [0.4, 0.6]);
  assert.equal(lib.act('resizeSplit', { splitId: sp, path: [0], ratios: [1, 1] }).changes.length, 0, 'a leaf: nothing');
  // Turned: the inner node alone (it then runs its parent's way: merged), or the whole.
  const whole = structuredClone(lib.values);
  const turnedAll = L.perform(whole, 'toggleSplitAxis', { splitId: sp, windowId: 1 }, { now: NOW, ids: ['x'] });
  const after = applyChanges(whole, turnedAll.changes).splits[sp];
  assert.equal(after.axis, 'vertical');
  assert.equal(after.tree.kids[1].axis, 'horizontal');
  const inner = L.perform(structuredClone(lib.values), 'toggleSplitAxis', { splitId: sp, path: [1], windowId: 1 }, { now: NOW, ids: ['x'] });
  const merged = applyChanges(lib.values, inner.changes).splits[sp];
  assert.equal(merged.tree, undefined, 'merged into its parent: flat again');
  assert.deepEqual(merged.panes, [a, b, c]);
  // Swapped: places traded, each keeping its size.
  lib.act('swapSplit', { splitId: sp, a: 0, b: 2 });
  assert.deepEqual(lib.values.splits[sp].panes, [c, b, a]);
  assert.deepEqual(lib.values.splits[sp].tree.kids[0], c);
  // d beside a on its right: in a's node (it runs that way).
  lib.act('addToSplit', { tabId: d, splitId: sp, beside: a, side: 'right', windowId: 1 });
  assert.deepEqual(lib.values.splits[sp].tree.kids[1], { axis: 'vertical', kids: [b, { axis: 'horizontal', kids: [a, d], ratios: [0.5, 0.5] }], ratios: [0.25, 0.75] });
  // Out: d (a's node of one goes), then b (the split flat again).
  lib.act('removeFromSplit', { tabId: d, windowId: 1 });
  assert.deepEqual(lib.values.splits[sp].tree.kids[1], { axis: 'vertical', kids: [b, a], ratios: [0.25, 0.75] });
  lib.act('removeFromSplit', { tabId: b, windowId: 1 });
  assert.deepEqual(lib.values.splits[sp], { spaceId: 'a', axis: 'horizontal', panes: [c, a], ratios: [0.4, 0.6] });
});

test('split tree, library: an item gone settles its tree; a tree that isn\'t one for the panes stored is read flat', () => {
  const lib = library();
  const [a, b, c] = ['https://a.example/', 'https://b.example/', 'https://c.example/'].map(lib.web);
  const sp = lib.act('createSplit', { panes: [a, b], windowId: 1 }).result.splitId;
  lib.act('addToSplit', { tabId: c, splitId: sp, beside: a, side: 'top', windowId: 1 });
  assert.deepEqual(lib.values.splits[sp].panes, [c, a, b]);
  lib.act('removeItem', { tabId: c });
  assert.deepEqual(lib.values.splits[sp], { spaceId: 'a', axis: 'horizontal', panes: [a, b], ratios: [0.5, 0.5] }, 'c gone: flat again');
  // A stored tree for other panes: the split read flat.
  const values = structuredClone(lib.values);
  values.splits[sp] = { ...values.splits[sp], tree: { axis: 'horizontal', kids: ['t-x', { axis: 'vertical', kids: [a, b], ratios: [1, 1] }], ratios: [1, 1] } };
  const snap = L.snapshot(values) as any;
  assert.equal(snap.splits[0].tree, undefined);
});

test('split tree, library: a split holds up to 16 panes (the room is the real limit)', () => {
  const lib = library();
  const ids = Array.from({ length: 17 }, (_, i) => lib.web(`https://p${i}.example/`));
  const sp = lib.act('createSplit', { panes: ids.slice(0, 2), windowId: 1 }).result.splitId;
  for (const id of ids.slice(2, 16)) assert.equal(lib.act('addToSplit', { tabId: id, splitId: sp, windowId: 1 }).ok, true);
  assert.equal(lib.values.splits[sp].panes.length, 16);
  const more = lib.act('addToSplit', { tabId: ids[16], splitId: sp, windowId: 1 });
  assert.equal(more.ok, false);
  assert.match(more.error!, /16 panes at most/);
  assert.equal(M.MAX_SPLIT_PANES, 16);
});
