import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../extension/state/model.ts';
import * as V from '../extension/shared/view.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { dropAction, dropTarget } from '../extension/ui/behaviors/drop-rules.ts';
import { menuItems } from '../extension/ui/behaviors/menu-items.ts';
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

test('M2.2 nested folders: create up to depth 4, reject depth 5 and cycles, flatten pre-order with depth', () => {
  let s = M.defaultState();
  s = M.setActiveSpace(s, 1, 'personal');
  s = M.createFolder(s, { id: 'f0', spaceId: 'personal', name: 'Depth 0' });
  s = M.createFolder(s, { id: 'f1', spaceId: 'personal', name: 'Depth 1', parentId: 'f0' });
  s = M.createFolder(s, { id: 'f2', spaceId: 'personal', name: 'Depth 2', parentId: 'f1' });
  s = M.createFolder(s, { id: 'f3', spaceId: 'personal', name: 'Depth 3', parentId: 'f2' });
  assert.equal(s.folders.length, 4);

  // Depth 4 (5th level) is refused.
  const tooDeep = M.createFolder(s, { id: 'f4', spaceId: 'personal', name: 'Too Deep', parentId: 'f3' });
  assert.equal(tooDeep.folders.length, 4, 'MAX_FOLDER_DEPTH = 4 enforced');

  // Cycle refused: cannot move f0 into its descendant f2.
  const cycle = M.moveFolder(s, 'f0', { parentId: 'f2' });
  assert.equal(cycle.folders.find((f) => f.id === 'f0')?.parentId, undefined, 'cycle prevented');

  // Add a pin inside f3 and verify pinnedFlat pre-order & depths.
  s = M.addPin(s, { id: 'p-deep', spaceId: 'personal', url: 'https://deep.example/', title: 'Deep Pin', folderId: 'f3' });
  const vm = buildViewModel({ state: s, ui: { windowId: 1 } });
  assert.deepEqual(
    vm.space.pinnedFlat.map((row) => [row.id, row.isFolder ? 'F' : 'P', row.depth]),
    [['f0', 'F', 0], ['f1', 'F', 1], ['f2', 'F', 2], ['f3', 'F', 3], ['p-deep', 'P', 4]],
  );

  // Menu hides "New Subfolder" at max depth (depth 3) and shows "Move Out of Folder" on nested folders.
  const deepMenu = menuItems({ kind: 'folder', id: 'f3' }, { state: s, space: vm.space });
  assert.equal(deepMenu.some((i) => i.action === 'folder.newIn'), false, 'cannot create subfolder at max depth');
  assert.equal(deepMenu.some((i) => i.label === 'Move Out of Folder'), true);
});

test('M2.2 nested folders: collapsing ancestor hides descendants except active peek; deleting promotes children', () => {
  let s = M.defaultState();
  s = M.setActiveSpace(s, 1, 'personal');
  s = M.createFolder(s, { id: 'f0', spaceId: 'personal', name: 'Root' });
  s = M.createFolder(s, { id: 'f1', spaceId: 'personal', name: 'Child', parentId: 'f0' });
  s = M.addPin(s, { id: 'p1', spaceId: 'personal', url: 'https://one.example/', title: 'One', folderId: 'f1' });
  s = M.addPin(s, { id: 'p2', spaceId: 'personal', url: 'https://two.example/', title: 'Two', folderId: 'f1' });
  s = M.upsertTab(s, { id: 10, windowId: 1, index: 0, active: true, url: 'https://one.example/', title: 'One' } as BrowserTab, 100);
  s = M.moveTab(s, 10, 'personal');
  s = M.bindTabToPin(s, 10, 'p1');

  // Collapse Root: Child and p2 hide, but active p1 peeks directly under Root.
  s = M.setFolderOpen(s, 'f0', false);
  const flat = V.sidebar(s, 1).pinnedFlat;
  assert.deepEqual(flat.map((x) => x.id), ['f0', 'p1']);

  // Deleting Child promotes p1 and p2 into Root.
  s = M.setFolderOpen(s, 'f0', true);
  const deleted = M.deleteFolder(s, 'f1');
  assert.equal(deleted.folders.length, 1);
  assert.deepEqual(deleted.pins.map((p) => p.folderId), ['f0', 'f0']);
});

test('M2.2 nested folders: drag-and-drop nesting respects cycles and depth cap and persists in library', () => {
  let values: L.Values = { spaces: { a: { name: 'A', order: 0 } }, pins: {}, folders: {}, tabs: {}, archive: {}, windows: { '1': { spaceId: 'a' } }, imports: {} };
  const act = (action: string, payload: any, ids: string[] = ['aaaa']) => {
    const out = L.perform(values, action, payload, { now: 1000, ids });
    assert.equal(out.ok, true, `${action}: ${out.error}`);
    values = applyChanges(values, out.changes);
    return out;
  };

  const fA = act('createFolder', { windowId: 1, name: 'A' }, ['fa00']).result;
  const fB = act('createFolder', { windowId: 1, name: 'B' }, ['fb00']).result;
  act('nestFolder', { folderId: fB, parentId: fA });
  assert.equal(values.folders[fB].parentId, fA);

  // Build view model from library snapshot and check drop rules.
  const state = L.stateOf(values);
  const vm = buildViewModel({ state, ui: { windowId: 1 } });
  // Cannot nest fA into its own child fB.
  assert.equal(dropTarget({ kind: 'folder', id: fA }, { zone: 'folder', folder: fB }, vm.space), null);
  // Nesting action shape.
  assert.deepEqual(dropAction({ kind: 'folder', id: fB }, { into: fA }), { name: 'folder.nest', arg: { folder: fB, parent: fA, before: null } });
});
