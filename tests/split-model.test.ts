import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../extension/state/model.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { menuItems } from '../extension/ui/behaviors/menu-items.ts';
import { checkAction, contextFromState, requestFor } from '../extension/ui/actions.ts';
import * as L from '../app/shared/library/library.ts';

function applyChanges(values: L.Values, changes: L.Change[]): L.Values {
  const next: L.Values = structuredClone(values);
  for (const c of changes) {
    next[c.collection] ??= {};
    if ('deleted' in c && c.deleted) delete next[c.collection][c.id];
    else next[c.collection][c.id] = (c as { value: any }).value;
  }
  return next;
}

test('M2.7 Split View: 2–4 pane lifecycle, swap, resize, toggleAxis, and automatic dissolve below 2 panes', () => {
  let s = M.defaultState();
  s = M.setActiveSpace(s, 1, 'personal');
  for (const [id, url, title, active] of [
    [1, 'https://docs.example/', 'Docs', true],
    [2, 'https://github.com/', 'GitHub', false],
    [3, 'https://linear.app/', 'Linear', false],
    [4, 'https://figma.com/', 'Figma', false],
    [5, 'https://extra.example/', 'Extra', false],
  ] as const) {
    s = M.upsertTab(s, { id, windowId: 1, index: id - 1, active, url, title } as BrowserTab, 100 + id);
    s = M.moveTab(s, id, 'personal');
  }

  s = M.createSplit(s, { id: 'sp-1', spaceId: 'personal', panes: [1, 2], axis: 'horizontal' });
  assert.equal(s.splits?.length, 1);
  assert.deepEqual(s.splits![0].panes, ['1', '2']);
  assert.deepEqual(s.splits![0].ratios, [0.5, 0.5]);

  // Add panes 3 & 4; 5th pane is refused (MAX_SPLIT_PANES = 4).
  s = M.addToSplit(s, 'sp-1', 3);
  s = M.addToSplit(s, 'sp-1', 4);
  s = M.addToSplit(s, 'sp-1', 5);
  assert.deepEqual(s.splits![0].panes, ['1', '2', '3', '4']);
  assert.equal(s.splits![0].ratios.length, 4);

  // Swap pane 0 and pane 1; toggle axis; resize ratios.
  s = M.swapSplitPanes(s, 'sp-1', 0, 1);
  assert.deepEqual(s.splits![0].panes, ['2', '1', '3', '4']);
  s = M.toggleSplitAxis(s, 'sp-1');
  assert.equal(s.splits![0].axis, 'vertical');
  s = M.resizeSplit(s, 'sp-1', [0.4, 0.2, 0.2, 0.2]);
  assert.deepEqual(s.splits![0].ratios, [0.4, 0.2, 0.2, 0.2]);

  // View model groups the 4 split tabs into ONE combined capsule row and deduplicates them from today!
  const vm = buildViewModel({ state: s, ui: { windowId: 1, tabId: 1 } });
  assert.equal(vm.space.hasSplits, true);
  assert.equal(vm.space.splits.length, 1);
  assert.equal(vm.space.splits[0].panes.length, 4);
  assert.equal(vm.space.splits[0].active, true);
  assert.deepEqual(vm.space.today.map((t) => t.id), [5], 'member tabs deduplicated out of standalone Today list');
  assert.ok(vm.split, 'active split metadata exposed');
  assert.equal(vm.split.isVertical, true);
  assert.equal(vm.split.dividers.length, 3);
  assert.equal(vm.split.canAddPane, false);

  // Breaking out panes until only 1 remains automatically dissolves the split group.
  s = M.removeFromSplit(s, 'sp-1', 4);
  s = M.removeFromSplit(s, 'sp-1', 3);
  assert.equal(s.splits?.length, 1);
  s = M.removeFromSplit(s, 'sp-1', 2);
  assert.equal(s.splits?.length, 0, 'split dissolved cleanly when < 2 panes remain');
});

test('M2.7 Split View: library supports Web+App and Web+Web splits, showSplit requests, and closeTab dissolve', () => {
  let values: L.Values = { spaces: { a: { name: 'A', order: 0 } }, pins: {}, favorites: {}, airTraffic: {}, splits: {}, folders: {}, tabs: {}, archive: {}, windows: { '1': { spaceId: 'a' } }, imports: {} };
  const act = (action: string, payload: any, ids: string[] = ['1111', '2222']) => {
    const out = L.perform(values, action, payload, { now: 1000, ids });
    assert.equal(out.ok, true, `${action}: ${out.error}`);
    values = applyChanges(values, out.changes);
    return out;
  };

  const web1 = act('newTab', { windowId: 1, url: 'https://docs.example/', title: 'Docs' }, ['t001']).result.tabId;
  const app1 = act('addItem', { spaceId: 'a', target: { kind: 'app', bundleId: 'com.apple.Notes', name: 'Notes' } }, ['t002']).result.tabId;
  const web2 = act('newTab', { windowId: 1, url: 'https://github.com/', title: 'GitHub' }, ['t003']).result.tabId;

  const created = act('createSplit', { windowId: 1, panes: [web1, app1] }, ['s001']);
  const splitId = created.result.splitId;
  assert.equal(created.requests[0].type, 'showSplit');
  assert.equal(created.requests[0].panes.length, 2);
  assert.equal(created.requests[0].panes[0].target.kind, 'web');
  assert.equal(created.requests[0].panes[1].target.kind, 'app');

  // Add a 3rd web pane -> Web+App+Web 3-pane split!
  const added = act('addToSplit', { windowId: 1, tabId: web2, splitId });
  assert.equal(added.requests[0].type, 'showSplit');
  assert.equal(values.splits[splitId].panes.length, 3);

  // Closing a pane removes it from the split; closing another dissolves the split.
  act('closeSplitPane', { tabId: web2 });
  assert.equal(values.splits[splitId].panes.length, 2);
  act('closeSplitPane', { tabId: app1 });
  assert.equal(values.splits[splitId], undefined);

  // Context menu & action validation on split tabs.
  const s = L.stateOf(values);
  const s2 = M.createSplit(s, { id: 'sp-test', spaceId: 'a', panes: [web1, 't-ghost'] });
  const ctx = contextFromState(s2);
  assert.equal(checkAction('split.open', 'sp-test', ctx).ok, true);
  assert.equal(checkAction('split.swap', 'sp-test', ctx).ok, true);
  assert.equal(checkAction('split.toggleAxis', 'sp-test', ctx).ok, true);
  assert.equal(checkAction('split.breakOut', web1, ctx).ok, true);
  assert.deepEqual(requestFor('split.swap', 'sp-test', { state: s2, ui: { windowId: 1 } }), { kind: 'send', type: 'swapSplit', payload: { splitId: 'sp-test', windowId: 1 } });
  const vm = buildViewModel({ state: s2, ui: { windowId: 1 } });
  const menu = menuItems({ kind: 'tab', id: web1 }, { state: s2, space: vm.space });
  assert.equal(menu.some((i) => i.action === 'split.breakOut'), true);
});
