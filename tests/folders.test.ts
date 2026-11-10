// Folders of pins (state/model.ts) and how the sidebar shows them
// (shared/view.ts): order, moving in and out, deleting, old saved data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../extension/state/model.ts';
import * as view from '../extension/shared/view.ts';
import type { State } from '../types/margin.d.ts';

const tab = (id: number, windowId: number, url: string, extra: Partial<BrowserTab> = {}) => ({ id, windowId, url, title: `t${id}`, index: id, active: false, ...extra });

// Personal (window 1) with pins a, b, c in that order.
function withPins(...ids: string[]) {
  let s = M.defaultState();
  for (const id of ids) s = M.addPin(s, { id, spaceId: 'personal', url: `https://${id}.com/`, title: id });
  return s;
}
const top = (s: State, spaceId = 'personal') => M.pinOrder(s, spaceId).map((x) => x.id);
const inside = (s: State, folderId: string, spaceId = 'personal') => M.pinOrder(s, spaceId, folderId).map((x) => x.id);
const shown = (s: State) => view.sidebar(s, 1).pinned.map((item) => (item.kind === 'folder' ? `${item.name}[${item.pins.map((p) => p.id).join(',')}]${item.open ? '' : '(closed)'}` : item.id));

test('folders: a new folder goes at the end, or where asked, holding the pins it takes', () => {
  let s = withPins('a', 'b', 'c');
  s = M.createFolder(s, { id: 'f', spaceId: 'personal', name: 'AI' });
  assert.deepEqual(top(s), ['a', 'b', 'c', 'f']);
  s = M.createFolder(s, { id: 'g', spaceId: 'personal', name: '  Work stuff  ', pinIds: ['b', 'c'], beforeId: 'b' });
  assert.deepEqual(top(s), ['a', 'g', 'f']);
  assert.deepEqual(inside(s, 'g'), ['b', 'c']);
  assert.equal(s.folders.find((f) => f.id === 'g')!.name, 'Work stuff', 'trimmed');
  assert.equal(s.folders.find((f) => f.id === 'g')!.open, true);
  assert.equal(M.createFolder(s, { id: 'g', spaceId: 'personal' }), s, 'ids are unique');
  assert.equal(M.createFolder(s, { id: 'x', spaceId: 'nope' }), s, 'only in a space that exists');
  assert.equal(M.createFolder(s, { id: 'y', spaceId: 'personal', name: '   ' }).folders.at(-1)!.name, 'New Folder');
});

test('folders: pins move in, out and around; folders move among the top level', () => {
  let s = withPins('a', 'b', 'c', 'd');
  s = M.createFolder(s, { id: 'f', spaceId: 'personal', name: 'F' });
  s = M.movePin(s, 'c', { folderId: 'f' });
  s = M.movePin(s, 'a', { folderId: 'f', beforeId: 'c' });
  assert.deepEqual(inside(s, 'f'), ['a', 'c']);
  assert.deepEqual(top(s), ['b', 'd', 'f']);
  s = M.movePin(s, 'c', { folderId: null, beforeId: 'b' });
  assert.deepEqual(top(s), ['c', 'b', 'd', 'f']);
  assert.deepEqual(inside(s, 'f'), ['a']);
  assert.equal(s.pins.find((p) => p.id === 'c')!.folderId, undefined, 'out of the folder');
  s = M.moveFolder(s, 'f', { beforeId: 'c' });
  assert.deepEqual(top(s), ['f', 'c', 'b', 'd']);
  s = M.movePin(s, 'b', {}); // to the end of the top level
  assert.deepEqual(top(s), ['f', 'c', 'd', 'b']);
  assert.equal(M.movePin(s, 'b', { folderId: 'missing' }), s, 'not into a folder that isn\'t there');
  s = M.createSpace(s, { id: 'work', name: 'Work', emoji: '💼', color: '#0984e3' });
  s = M.createFolder(s, { id: 'w', spaceId: 'work', name: 'W' });
  assert.equal(M.movePin(s, 'b', { folderId: 'w' }), s, 'not into another space\'s folder');
});

test('folders: rename, open and close, delete (its pins stay, in its place)', () => {
  let s = withPins('a', 'b', 'c');
  s = M.createFolder(s, { id: 'f', spaceId: 'personal', name: 'F', pinIds: ['b', 'c'], beforeId: 'b' });
  s = M.renameFolder(s, 'f', 'Azure');
  assert.equal(s.folders[0].name, 'Azure');
  assert.equal(M.renameFolder(s, 'f', '   '), s, 'never an empty name');
  assert.equal(M.renameFolder(s, 'f', 'x'.repeat(80)).folders[0].name.length, M.FOLDER_NAME_MAX);
  s = M.setFolderOpen(s, 'f', false);
  assert.equal(s.folders[0].open, false);
  s = M.deleteFolder(s, 'f');
  assert.deepEqual(s.folders, []);
  assert.deepEqual(top(s), ['a', 'b', 'c'], 'its pins where it was, in their order');
  assert.ok(s.pins.every((p) => p.folderId === undefined));
});

test('folders: pinning a tab straight into a folder, before a pin there', () => {
  let s = withPins('a');
  s = M.createFolder(s, { id: 'f', spaceId: 'personal', name: 'F', pinIds: ['a'] });
  s = M.addPin(s, { id: 'n', spaceId: 'personal', url: 'https://n.com/', title: 'n', folderId: 'f', beforeId: 'a' });
  assert.deepEqual(inside(s, 'f'), ['n', 'a']);
  s = M.addPin(s, { id: 'm', spaceId: 'personal', url: 'https://m.com/', title: 'm', folderId: 'gone' });
  assert.deepEqual(top(s), ['f', 'm'], 'a folder that isn\'t there: the top level');
});

test('folders: deleting a space moves its folders and their pins to the first space', () => {
  let s = withPins('a');
  s = M.createSpace(s, { id: 'work', name: 'Work', emoji: '💼', color: '#0984e3' });
  s = M.addPin(s, { id: 'w1', spaceId: 'work', url: 'https://w1.com/', title: 'w1' });
  s = M.addPin(s, { id: 'dup', spaceId: 'work', url: 'https://a.com/', title: 'dup' });
  s = M.createFolder(s, { id: 'wf', spaceId: 'work', name: 'Work folder', pinIds: ['w1', 'dup'] });
  s = M.deleteSpace(s, 'work');
  assert.equal(s.folders[0].spaceId, 'personal');
  assert.deepEqual(top(s), ['a', 'wf']);
  assert.deepEqual(inside(s, 'wf'), ['w1'], 'a pin whose URL the first space already has goes');
});

test('folders: saved data from before folders (no pos) and unknown folders still show, in order', () => {
  const raw = {
    spaces: [{ id: 'personal', name: 'Personal', emoji: '🏠', color: '#6c5ce7' }],
    pins: [
      { id: 'a', spaceId: 'personal', url: 'https://a.com/', title: 'a' },
      { id: 'b', spaceId: 'personal', url: 'https://b.com/', title: 'b', folderId: 'deleted' },
      { id: 'c', spaceId: 'personal', url: 'https://c.com/', title: 'c' },
    ],
    folders: [{ id: 'ok', spaceId: 'personal', name: 'OK', open: true, pos: 9 }, { bogus: true }],
  };
  const s = M.normalizeState(raw);
  assert.equal(s.folders.length, 1, 'malformed folders dropped');
  assert.deepEqual(top(s), ['a', 'b', 'c', 'ok']);
  // Pages read raw storage: the view must cope with it as it is.
  // As read, not as Margin writes it (a malformed folder, no settings): no State.
  const v = view.sidebar({ ...raw, activeSpaceByWindow: {}, tabSpace: {}, tabs: {} } as unknown as State, 1);
  assert.deepEqual(v.pinned.map((item) => item.id), ['a', 'b', 'c', 'ok']);
  assert.equal(v.pins.find((p) => p.id === 'b')!.folderId, null, 'its folder gone: loose');
  assert.deepEqual(M.normalizeState({}).folders, []);
  assert.ok(M.STATE_KEYS.includes('folders'), 'saved by the background');
});

test('view: folders with their pins in order; a closed folder still shows the tab shown; next/previous follow', () => {
  let s = withPins('a', 'b', 'c', 'd');
  s = M.createFolder(s, { id: 'f', spaceId: 'personal', name: 'MSU', pinIds: ['c', 'b'], beforeId: 'b' });
  s = M.upsertTab(s, tab(1, 1, 'https://b.com/', { active: true }), 0);
  s = M.upsertTab(s, tab(2, 1, 'https://d.com/'), 0);
  s = M.upsertTab(s, tab(3, 1, 'https://x.com/'), 0);
  assert.deepEqual(shown(s), ['a', 'MSU[c,b]', 'd']);
  const v = view.sidebar(s, 1, 1);
  assert.deepEqual(v.pins.map((p) => p.id), ['a', 'c', 'b', 'd'], 'flat, in the order shown');
  assert.equal(v.pins.find((p) => p.id === 'b')!.active, true);
  s = M.setFolderOpen(s, 'f', false);
  const closed = view.sidebar(s, 1, 1).pinned.find((item) => item.kind === 'folder')!;
  assert.equal(closed.open, false);
  assert.deepEqual(closed.peek.map((p) => p.id), ['b'], 'the shown tab\'s pin stays visible');
  assert.deepEqual(view.sidebar(s, 1, 2).pinned.find((item) => item.kind === 'folder')!.peek, [], 'none when it isn\'t shown');
  assert.equal(view.cycleTab(s, 1, 1, 1), 2, 'open pins in the order shown (b, then d), then tabs');
  assert.equal(view.cycleTab(s, 1, 2, 1), 3);
});

test('folders: dropping something before itself leaves it where it is; changes that change nothing save nothing', () => {
  let s = withPins('a', 'b', 'c');
  s = M.movePin(s, 'b', { beforeId: 'b' });
  assert.deepEqual(top(s), ['a', 'b', 'c']);
  s = M.createFolder(s, { id: 'f', spaceId: 'personal', name: 'F' });
  s = M.moveFolder(s, 'f', { beforeId: 'f' });
  assert.deepEqual(top(s), ['a', 'b', 'c', 'f']);
  assert.equal(M.movePin(s, 'c', { beforeId: 'f' }), s, 'already there');
  assert.equal(M.setFolderOpen(s, 'f', true), s, 'already open');
  assert.equal(M.setFolderOpen(s, 'missing', false), s);
  assert.equal(M.renameFolder(s, 'f', 'F'), s, 'same name');
  assert.equal(M.renameFolder(s, 'missing', 'x'), s);
});

test('folders: new folders in a space get distinct names (menus name them)', () => {
  let s = withPins();
  s = M.createFolder(s, { id: 'f1', spaceId: 'personal' });
  s = M.createFolder(s, { id: 'f2', spaceId: 'personal' });
  s = M.createFolder(s, { id: 'f3', spaceId: 'personal', name: 'New Folder' });
  assert.deepEqual(s.folders.map((f) => f.name), ['New Folder', 'New Folder 2', 'New Folder 3']);
});

test('view: next/previous skips the tabs of a closed folder unless one is shown; equal positions sort as the model does', () => {
  let s = withPins('x', 'a', 'y');
  s = M.createFolder(s, { id: 'f', spaceId: 'personal', name: 'F', pinIds: ['a'], beforeId: 'a' });
  s = M.setFolderOpen(s, 'f', false);
  s = M.upsertTab(s, tab(10, 1, 'https://x.com/', { active: true }), 0);
  s = M.upsertTab(s, tab(11, 1, 'https://a.com/'), 0);
  s = M.upsertTab(s, tab(12, 1, 'https://y.com/'), 0);
  assert.equal(view.cycleTab(s, 1, 10, 1), 12, 'a (in the closed folder) skipped');
  assert.equal(view.cycleTab(s, 1, 11, 1), 12, 'from a, shown under its closed folder: on to y');
  const tie = { ...s, folders: [{ ...s.folders[0], pos: 1 }], pins: s.pins.map((p) => (p.id === 'y' ? { ...p, pos: 1 } : p)) };
  assert.deepEqual(M.pinOrder(tie, 'personal').map((x) => x.id), view.sidebar(tie, 1).pinned.map((item) => item.id));
});

test('spaces: a tab of another space brought to the front switches the window to that space (Arc)', () => {
  let s = M.defaultState();
  s = M.createSpace(s, { id: 'work', name: 'Work', emoji: '💼', color: '#0984e3' });
  s = M.upsertTab(s, tab(1, 1, 'https://a.com/', { active: true }), 0);
  s = M.upsertTab(s, tab(2, 1, 'https://b.com/'), 0);
  s = M.moveTab(s, 2, 'work');
  assert.equal(M.activeSpaceId(s, 1), 'personal');
  s = M.followTab(M.activateTab(s, 2, 1, 1), 2, 1);
  assert.equal(M.activeSpaceId(s, 1), 'work');
  assert.equal(M.followTab(s, 2, 1), s, 'already there: nothing changes');
  assert.equal(M.followTab(s, 99, 1), s, 'a tab Margin hasn\'t placed yet: nothing changes');
  assert.equal(M.activeSpaceId(M.followTab(s, 1, 2), 2), 'personal', 'per window');
});
