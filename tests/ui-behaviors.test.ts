// The behaviors' pure parts (extension/ui/behaviors/): where a dragged row
// goes (today's rules, themes/arcadia/sidebar.js dropTarget), the action a
// drop runs, where a moved tab lands in the window's order, and what each
// context menu holds; and how the view model shows menus and the space
// editor. The behaviors themselves run in real engines:
// tests/theme/behaviors.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropAction, dropTarget, levelIds, moveIndex, stays } from '../extension/ui/behaviors/drop-rules.ts';
import { CONFIRM_LABEL, SPACE_COLORS, menuItems } from '../extension/ui/behaviors/menu-items.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { checkAction, contextFromState } from '../extension/ui/actions.ts';
import { smallState, W } from './ui/fixtures.ts';

const state = smallState();
const vm = (ui = {}) => buildViewModel({ state, ui: { windowId: W, ...ui } });
const space = vm().space;
const tab = (id) => ({ kind: 'tab', id });
const pin = (id) => ({ kind: 'pin', id });
const folder = (id) => ({ kind: 'folder', id });
const today = space.today.map((t) => t.id);
const pinsOver = (row, y) => ({ zone: 'pins', row, y });
const pinRow = (id, folderId = null) => ({ kind: 'pin', id, folder: folderId });
const folderRow = (id) => ({ kind: 'folder', id, folder: null });

test('the fixture: Home\'s pinned area and its tabs, as the sidebar shows them', () => {
  assert.deepEqual(levelIds(space, null), ['f1', 'pd', 'f2'], 'folders and the loose pin, in order');
  assert.deepEqual(levelIds(space, 'f1'), ['pa', 'pb']);
  assert.deepEqual(levelIds(space, 'f2'), ['pc']);
  assert.deepEqual(levelIds(space, 'gone'), []);
  assert.deepEqual(today, [15, 14, 12, 16], 'the tabs no pin shows, newest first (16: the other window\'s, the list is the space\'s)');
});

test('drop rules: a tab on another space\'s chip moves there; nothing else drops on a chip', () => {
  assert.deepEqual(dropTarget(tab(14), { zone: 'space', spaceId: 'work' }, space), { space: 'work' });
  assert.equal(dropTarget(tab(14), { zone: 'space', spaceId: 'home' }, space), null, 'its own space');
  assert.equal(dropTarget(pin('pa'), { zone: 'space', spaceId: 'work' }, space), null);
  assert.equal(dropTarget(folder('f1'), { zone: 'space', spaceId: 'work' }, space), null);
});

test('drop rules: in the tabs, before or after the tab there, never where it is already; a pin there is unpinned', () => {
  const over = (t, y) => ({ zone: 'tabs', rows: today, tab: t, y });
  assert.deepEqual(dropTarget(tab(15), over(12, 0.7), space), { tab: 12, side: 'after' });
  assert.deepEqual(dropTarget(tab(15), over(12, 0.2), space), { tab: 12, side: 'before' });
  assert.deepEqual(dropTarget(tab(12), over(15, 0.2), space), { tab: 15, side: 'before' });
  assert.equal(dropTarget(tab(15), over(14, 0.2), space), null, 'just below itself: where it is');
  assert.equal(dropTarget(tab(12), over(14, 0.8), space), null, 'just above itself');
  assert.equal(dropTarget(tab(14), over(14, 0.5), space), null, 'on itself');
  assert.equal(dropTarget(tab(14), over(null, 0), space), null, 'no row at all');
  assert.deepEqual(dropTarget(pin('pa'), over(12, 0.5), space), { unpin: true });
  assert.equal(dropTarget(folder('f1'), over(12, 0.5), space), null, 'a folder never goes among the tabs');
});

test('drop rules: on a folder\'s row, its top quarter is before it and the rest into it', () => {
  assert.deepEqual(dropTarget(tab(14), pinsOver(folderRow('f1'), 0.1), space), { folderId: null, beforeId: 'f1', row: folder('f1'), side: 'before' });
  assert.deepEqual(dropTarget(tab(14), pinsOver(folderRow('f1'), 0.6), space), { into: 'f1' });
  assert.deepEqual(dropTarget(pin('pa'), pinsOver(folderRow('f2'), 0.6), space), { into: 'f2' });
  assert.equal(dropTarget(pin('pa'), pinsOver(folderRow('f1'), 0.6), space), null, 'already in it');
  assert.equal(dropTarget(pin('pd'), pinsOver(folderRow('f2'), 0.1), space), null, 'just before the folder after it: where it is');
  // In a folder's own drop area, between its rows: into it.
  assert.deepEqual(dropTarget(pin('pd'), { zone: 'folder', folder: 'f1' }, space), { into: 'f1' });
  assert.equal(dropTarget(folder('f2'), { zone: 'folder', folder: 'f1' }, space), null, 'folders stay at the top level');
});

test('drop rules: a folder dragged goes before (top half) or after (bottom half) a row at the top level', () => {
  assert.deepEqual(dropTarget(folder('f2'), pinsOver(folderRow('f1'), 0.3), space), { folderId: null, beforeId: 'f1', row: folder('f1'), side: 'before' });
  assert.equal(dropTarget(folder('f2'), pinsOver(folderRow('f2'), 0.3), space), null, 'on itself');
  assert.deepEqual(dropTarget(folder('f2'), pinsOver(folderRow('f1'), 0.7), space), { folderId: null, beforeId: 'pd', row: folder('f1'), side: 'after' }, 'after f1 and its pins');
  assert.equal(dropTarget(folder('f1'), pinsOver(pinRow('pd'), 0.3), space), null, 'before the row after it: where it is');
  assert.deepEqual(dropTarget(folder('f1'), pinsOver(pinRow('pd'), 0.7), space), { folderId: null, beforeId: 'f2', row: pin('pd'), side: 'after' });
  assert.equal(dropTarget(folder('f1'), pinsOver(pinRow('pa', 'f1'), 0.3), space), null, 'not inside a folder');
});

test('drop rules: on a pin\'s row, before or after it at its level; below the last row, the end', () => {
  assert.deepEqual(dropTarget(pin('pb'), pinsOver(pinRow('pa', 'f1'), 0.3), space), { folderId: 'f1', beforeId: 'pa', row: pin('pa'), side: 'before' });
  assert.equal(dropTarget(pin('pb'), pinsOver(pinRow('pa', 'f1'), 0.7), space), null, 'after pa is where pb is');
  assert.equal(dropTarget(pin('pb'), pinsOver(pinRow('pb', 'f1'), 0.3), space), null, 'on itself');
  assert.deepEqual(dropTarget(pin('pa'), pinsOver(pinRow('pd'), 0.7), space), { folderId: null, beforeId: 'f2', row: pin('pd'), side: 'after' }, 'out of its folder');
  assert.deepEqual(dropTarget(tab(14), pinsOver(pinRow('pb', 'f1'), 0.7), space), { folderId: 'f1', beforeId: null, row: pin('pb'), side: 'after' }, 'a tab pinned at the end of a folder');
  assert.deepEqual(dropTarget(tab(14), pinsOver(null, 0), space), { folderId: null, beforeId: null }, 'below the last row: the end of the top level');
  assert.equal(dropTarget({ kind: 'space', id: 'work' }, pinsOver(null, 0), space), null, 'spaces don\'t move');
  assert.equal(dropTarget(tab(14), null, space), null, 'nothing under the pointer');
  assert.equal(stays(space, pin('pd'), null, 'f2'), true);
  assert.equal(stays(space, tab(14), null, null), false, 'a tab never "stays" in the pinned area');
});

test('a drop\'s action: the background\'s message today\'s sidebar sends', () => {
  assert.deepEqual(dropAction(tab(14), { space: 'work' }), { name: 'tab.moveToSpace', arg: { tab: 14, space: 'work' } });
  assert.deepEqual(dropAction(pin('pa'), { unpin: true }), { name: 'tab.unpin', arg: 'pa' });
  assert.deepEqual(dropAction(tab(12), { tab: 15, side: 'after' }), { name: 'tab.move', arg: { tab: 12, nextTo: 15, side: 'after' } });
  assert.deepEqual(dropAction(tab(14), { into: 'f1' }), { name: 'tab.pinAt', arg: { tab: 14, folder: 'f1', before: null } });
  assert.deepEqual(dropAction(tab(14), { folderId: null, beforeId: 'f1', row: folder('f1'), side: 'before' }), { name: 'tab.pinAt', arg: { tab: 14, folder: null, before: 'f1' } });
  assert.deepEqual(dropAction(pin('pd'), { into: 'f2' }), { name: 'pin.move', arg: { pin: 'pd', folder: 'f2', before: null } });
  assert.deepEqual(dropAction(pin('pb'), { folderId: 'f1', beforeId: 'pa' }), { name: 'pin.move', arg: { pin: 'pb', folder: 'f1', before: 'pa' } });
  assert.deepEqual(dropAction(folder('f2'), { folderId: null, beforeId: 'f1' }), { name: 'folder.move', arg: { folder: 'f2', before: 'f1' } });
  // Each one passes the action checks against the state.
  const ctx = contextFromState(state);
  for (const [drag, where] of [[tab(14), { space: 'work' }], [pin('pa'), { unpin: true }], [tab(12), { tab: 15, side: 'after' }], [tab(14), { into: 'f1' }], [pin('pd'), { into: 'f2' }], [folder('f2'), { folderId: null, beforeId: 'f1' }]]) {
    const { name, arg } = dropAction(drag, where);
    assert.equal(checkAction(name, arg, ctx).ok, true, name);
  }
});

test('reorder maths: where a tab moved next to another lands in the window (background moveTab)', () => {
  // Above the other in the list: just after it in the window; below it: just before.
  assert.equal(moveIndex(2, 5, 'before'), 5);
  assert.equal(moveIndex(5, 2, 'before'), 3);
  assert.equal(moveIndex(2, 5, 'after'), 4);
  assert.equal(moveIndex(5, 2, 'after'), 2);
  assert.equal(moveIndex(3, 4, 'after'), 3, 'next to its neighbour on that side: no move');
  assert.equal(moveIndex(4, 3, 'before'), 4);
});

const labels = (items) => items.map((i) => (i.separator ? '—' : i.label));
const run = (items) => items.filter((i) => !i.separator).map((i) => [i.action, i.arg]);

test('menus: a folder\'s, a pin\'s, a tab\'s, as today\'s right-click menu', () => {
  assert.deepEqual(labels(menuItems({ kind: 'folder', id: 'f1' }, { state, space })), ['Rename Folder', 'Close Folder', '—', 'Delete Folder (pins stay)']);
  assert.deepEqual(run(menuItems({ kind: 'folder', id: 'f2' }, { state, space })), [['folder.rename', 'f2'], ['folder.toggle', 'f2'], ['folder.delete', 'f2']]);
  assert.equal(menuItems({ kind: 'folder', id: 'f2' }, { state, space })[1].label, 'Open Folder', 'a closed one opens');
  // A pin in a folder, its tab open; a loose pin not open.
  const pa = menuItems({ kind: 'pin', id: 'pa' }, { state, space });
  assert.deepEqual(labels(pa), ['Unpin', '—', 'Move to 📁 Projects', 'Remove from Folder', 'New Folder with Pin', '—', 'Close Tab']);
  assert.deepEqual(run(pa), [['tab.unpin', 'pa'], ['pin.move', { pin: 'pa', folder: 'f2', before: null }], ['pin.move', { pin: 'pa', folder: null, before: null }], ['folder.newWithPin', 'pa'], ['tab.close', 11]]);
  assert.deepEqual(labels(menuItems({ kind: 'pin', id: 'pd' }, { state, space })), ['Unpin', '—', 'Move to 📁 Reading', 'Move to 📁 Projects', 'New Folder with Pin']);
  const t = menuItems({ kind: 'tab', id: 14 }, { state, space });
  assert.deepEqual(labels(t), ['Pin Tab', 'Pin to 📁 Reading', 'Pin to 📁 Projects', 'New Folder with Tab', '—', 'Move to 💼 Deep Work', 'Move to 🎨 Side', '—', 'Close Tab']);
  assert.deepEqual(run(t), [['tab.pin', 14], ['tab.pinAt', { tab: 14, folder: 'f1', before: null }], ['tab.pinAt', { tab: 14, folder: 'f2', before: null }], ['folder.newWithTab', 14],
    ['tab.moveToSpace', { tab: 14, space: 'work' }], ['tab.moveToSpace', { tab: 14, space: 'side' }], ['tab.close', 14]]);
  // Every item's action passes the checks.
  const ctx = contextFromState(state);
  for (const item of [...pa, ...t, ...menuItems({ kind: 'folder', id: 'f1' }, { state, space })]) if (!item.separator) assert.equal(checkAction(item.action, item.arg, ctx).ok, true, item.label);
});

test('menus: a space\'s, the "+" menu, and nothing for what isn\'t there', () => {
  const s = menuItems({ kind: 'space', id: 'work' }, { state, space });
  assert.deepEqual(labels(s), ['Edit Space…', 'Rename Space', '—', 'New Space', '—', 'Delete Space']);
  assert.deepEqual(s.at(-1), { id: 'i3', label: 'Delete Space', separator: false, danger: true, confirm: true, action: 'space.delete', arg: 'work' }, 'deleting asks first');
  const one = { ...state, spaces: state.spaces.slice(0, 1) };
  assert.deepEqual(labels(menuItems({ kind: 'space', id: 'home' }, { state: one, space })), ['Edit Space…', 'Rename Space', '—', 'New Space'], 'the last space can\'t be deleted');
  assert.deepEqual(run(menuItems({ kind: 'add' }, { state, space })), [['folder.new', undefined], ['space.new', undefined]]);
  for (const target of [{ kind: 'tab', id: 99 }, { kind: 'tab', id: '14' }, { kind: 'pin', id: 'zz' }, { kind: 'folder', id: 'f9' }, { kind: 'space', id: 'nope' }, { kind: 'eval', id: 1 }, null]) {
    assert.deepEqual(menuItems((target as any), { state, space }), [], JSON.stringify(target));
  }
  // Item ids are unique; separators never lead, trail or double.
  for (const items of [s, menuItems({ kind: 'tab', id: 14 }, { state, space })]) {
    assert.equal(new Set(items.map((i) => i.id)).size, items.length);
    assert.equal(items[0].separator || items.at(-1).separator, false);
    assert.equal(items.some((i, k) => i.separator && items[k + 1]?.separator), false);
  }
});

test('view model: a menu shows its labels, not what they run; a confirming item asks', () => {
  const m = vm({ menu: { kind: 'space', id: 'work', x: 30, y: 40 } }).menu;
  assert.deepEqual(m.items.map((i) => i.label), ['Edit Space…', 'Rename Space', '', 'New Space', '', 'Delete Space']);
  assert.deepEqual(Object.keys(m.items[0]).sort(), ['confirming', 'danger', 'id', 'label', 'separator'], 'no action, no argument');
  assert.deepEqual([m.kind, m.id, m.x, m.y, m.hasItems], ['space', 'work', 30, 40, true]);
  const asked = vm({ menu: { kind: 'space', id: 'work', x: 30, y: 40, confirming: 'i3' } }).menu;
  assert.deepEqual(asked.items.at(-1), { id: 'i3', label: CONFIRM_LABEL, separator: false, danger: true, confirming: true });
  assert.equal(vm({ menu: { kind: 'tab', id: 99 } }).menu, null, 'its tab is gone: no menu');
});

test('view model: the space editor, its swatches and its delete rule', () => {
  const e = vm({ editor: { spaceId: 'work', name: 'Deep W', emoji: '💼', color: SPACE_COLORS[2], confirmDelete: false } }).editor;
  assert.deepEqual([e.id, e.name, e.emoji, e.color, e.canDelete, e.cannotDelete, e.deleteLabel], ['work', 'Deep W', '💼', '#00b894', true, false, 'Delete']);
  assert.deepEqual(e.colors.map((c) => c.id), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
  assert.deepEqual(e.colors.filter((c) => c.selected).map((c) => c.color), ['#00b894']);
  assert.equal(vm({ editor: { spaceId: 'work', name: '', emoji: '', color: '', confirmDelete: true } }).editor.deleteLabel, CONFIRM_LABEL);
  assert.equal(vm({ editor: { spaceId: 'gone', name: '', emoji: '', color: '' } }).editor, null);
  const only = buildViewModel({ state: { ...state, spaces: state.spaces.slice(0, 1) }, ui: { windowId: W, editor: { spaceId: 'home', name: 'Home', emoji: '', color: '' } } }).editor;
  assert.deepEqual([only.canDelete, only.cannotDelete, only.deleteTitle], [false, true, 'The last space can’t be deleted']);
});
