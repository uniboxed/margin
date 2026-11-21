// What ⌘D and ⌘1–9 act on (ui/shortcut-targets.ts, the overlay's keys: app/shared/host/overlay.ts): the pin bound to
// the row in front anywhere in the pinned area (folders too), never a second pin of the same page, the toast once the
// request has come back; the numbered rows in the sidebar's order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../extension/state/model.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { numberedAction, numberedRows, pinToggle, togglePin } from '../extension/ui/shortcut-targets.ts';
import type { State } from '../types/margin';

function state() {
  let s: State = M.defaultState();
  s = M.setActiveSpace(s, 1, 'personal');
  const tab = (id: number, url: string, active = false) => {
    s = M.upsertTab(s, { id, windowId: 1, index: id, active, url, title: url } as any, id);
    s = M.moveTab(s, id, 'personal');
  };
  tab(1, 'https://loose.example/');
  tab(2, 'https://in-folder.example/', true);
  tab(3, 'https://today.example/');
  tab(4, 'https://sub.example/');
  s = M.addPin(s, { id: 'p-loose', spaceId: 'personal', url: 'https://loose.example/', title: 'Loose' });
  s = M.createFolder(s, { id: 'f', spaceId: 'personal', name: 'Folder' });
  s = M.addPin(s, { id: 'p-in', spaceId: 'personal', url: 'https://in-folder.example/', title: 'In folder', folderId: 'f' });
  s = M.createFolder(s, { id: 'f-sub', spaceId: 'personal', name: 'Sub', parentId: 'f' });
  s = M.addPin(s, { id: 'p-sub', spaceId: 'personal', url: 'https://sub.example/', title: 'Sub pin', folderId: 'f-sub' });
  s = M.bindTabToPin(s, 1, 'p-loose');
  s = M.bindTabToPin(s, 2, 'p-in');
  s = M.bindTabToPin(s, 4, 'p-sub');
  s = M.addFavorite(s, { id: 'fav', scope: 'global', url: 'https://fav.example/', title: 'Fav' });
  return s;
}

test('⌘D: a tab bound to a pin in a folder is unpinned (not pinned again: vm.space.pins holds only the loose pins)', () => {
  const s = state();
  const vm = buildViewModel({ state: s, ui: { windowId: 1, tabId: 2 } });
  assert.equal(vm.space.pins.some((p) => p.id === 'p-in'), false, 'the folder\'s pin is not among the loose pins');
  assert.deepEqual(pinToggle(vm), { kind: 'unpin', pinId: 'p-in' });
  // In a closed folder, a level down.
  const closed = M.setFolderOpen(M.setFolderOpen(s, 'f', false), 'f-sub', false);
  const vm4 = buildViewModel({ state: { ...closed, tabs: { ...closed.tabs, 2: { ...closed.tabs[2], active: false }, 4: { ...closed.tabs[4], active: true } } }, ui: { windowId: 1, tabId: 4 } });
  assert.deepEqual(pinToggle(vm4), { kind: 'unpin', pinId: 'p-sub' });
});

test('⌘D: a tab no pin has is pinned; one whose page is pinned already (to another tab) is not pinned twice', () => {
  const s = state();
  assert.deepEqual(pinToggle(buildViewModel({ state: s, ui: { windowId: 1, tabId: 3 } })), { kind: 'pin', tabId: 3 });
  // Tab 5: the loose pin's page, the pin bound to tab 1.
  let t = M.upsertTab(s, { id: 5, windowId: 1, index: 5, active: false, url: 'https://loose.example/', title: 'Again' } as any, 5);
  t = M.moveTab(t, 5, 'personal');
  assert.deepEqual(pinToggle(buildViewModel({ state: t, ui: { windowId: 1, tabId: 5 } })), { kind: 'pinned-already' });
});

test('⌘D: the toast comes after the request, and says what came back', async () => {
  const s = state();
  const toasts: string[] = [];
  const order: string[] = [];
  let resolve!: (v: unknown) => void;
  const runner = {
    dispatch: (name: string, arg: unknown) => { order.push(`${name}:${arg}`); return new Promise((r) => { resolve = r; }); },
    showToast: (text: string) => { order.push(`toast:${text}`); toasts.push(text); },
  };
  const pinning = togglePin(buildViewModel({ state: s, ui: { windowId: 1, tabId: 3 } }), runner);
  await Promise.resolve();
  assert.equal(toasts.length, 0, 'no toast before the answer');
  resolve('new-pin');
  assert.equal(await pinning, 'pin');
  assert.deepEqual(order, ['tab.pin:3', 'toast:Pinned Tab']);
  // Refused by the host (already pinned): said so.
  const again = togglePin(buildViewModel({ state: s, ui: { windowId: 1, tabId: 3 } }), runner);
  await Promise.resolve();
  resolve(null);
  await again;
  assert.equal(toasts.at(-1), 'Already Pinned');
  // Unpinned; a failed request: no toast.
  const un = togglePin(buildViewModel({ state: s, ui: { windowId: 1, tabId: 2 } }), runner, () => true);
  await Promise.resolve();
  resolve(undefined);
  await un;
  assert.equal(toasts.length, 2);
  const un2 = togglePin(buildViewModel({ state: s, ui: { windowId: 1, tabId: 2 } }), runner);
  await Promise.resolve();
  resolve(undefined);
  await un2;
  assert.equal(toasts.at(-1), 'Unpinned Tab');
  // An action the runtime refused: nothing.
  const refused = { dispatch: () => false, showToast: (t: string) => toasts.push(t) };
  assert.equal(await togglePin(buildViewModel({ state: s, ui: { windowId: 1, tabId: 3 } }), refused), 'none');
  assert.equal(toasts.length, 3);
});

test('⌘1–9: favorites, then the pins as the sidebar shows them (folders included), then today', () => {
  const s = state();
  const vm = buildViewModel({ state: s, ui: { windowId: 1, tabId: 2 } });
  assert.deepEqual(numberedRows(vm).map((r) => `${r.kind}:${r.id}`), ['favorite:fav', 'pin:p-loose', 'pin:p-in', 'pin:p-sub', 'tab:3']);
  assert.deepEqual(numberedAction(vm, 1), { name: 'favorite.open', arg: 'fav' });
  assert.deepEqual(numberedAction(vm, 3), { name: 'pin.open', arg: 'p-in' });
  assert.deepEqual(numberedAction(vm, 5), { name: 'tab.activate', arg: 3 });
  assert.equal(numberedAction(vm, 6), null, 'nothing there');
  // A closed folder: only the pin shown in it (the one in front) counts.
  const closed = M.setFolderOpen(s, 'f', false);
  const vmClosed = buildViewModel({ state: closed, ui: { windowId: 1, tabId: 2 } });
  assert.deepEqual(numberedRows(vmClosed).map((r) => `${r.kind}:${r.id}`), ['favorite:fav', 'pin:p-loose', 'pin:p-in', 'tab:3']);
});
