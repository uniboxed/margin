// A theme's actions (extension/ui/actions.js): every argument checked against
// the host's state before anything is sent, and each action mapped to the
// background's real handler (background/handlers.js) with the payload
// Arcadia's sidebar and palette send today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, ACTION_MAP, BEHAVIOR_ONLY, checkAction, contextFromState, createDispatcher, requestFor } from '../extension/ui/actions.js';
import { paletteItems } from '../extension/ui/view-model.js';
import { readFileSync } from 'node:fs';
import { smallState, W } from './ui/fixtures.js';

// The background's handler names, from its source (importing it needs a browser).
const HANDLERS = new Set([...readFileSync(new URL('../extension/background/handlers.js', import.meta.url), 'utf8').matchAll(/^  async (\w+)\(/gm)].map((m) => m[1]));
const handlers = Object.fromEntries([...HANDLERS].map((name) => [name, () => {}]));

const state = smallState();
const ctx = contextFromState(state, ['tab:12', 'go'], { menuIds: ['i0', 'i1'], colorIds: ['c0'] });
const ok = (name, arg) => checkAction(name, arg, ctx).ok;

test('arguments are checked against the state: open tabs (any window), spaces, folders, pins, archive, palette rows', () => {
  assert.equal(ok('tab.activate', 14), true);
  assert.equal(ok('tab.activate', 16), true, 'a tab in another window (the palette lists them)');
  assert.equal(ok('tab.activate', 99), false, 'not open');
  assert.equal(ok('tab.activate', '14'), false, 'a tab id is a number');
  assert.equal(ok('tab.close', 11), true);
  assert.equal(ok('tab.pin', 12), true);
  assert.equal(ok('tab.unpin', 'pa'), true, 'a pin\'s id');
  assert.equal(ok('tab.unpin', 11), false, 'not a tab id');
  assert.equal(ok('pin.open', 'pb'), true, 'a pin not open');
  assert.equal(ok('pin.open', 'zz'), false);
  assert.equal(ok('folder.toggle', 'f2'), true);
  assert.equal(ok('folder.toggle', 'f9'), false);
  assert.equal(ok('space.switch', 'work'), true);
  assert.equal(ok('space.switch', 'nope'), false);
  assert.equal(ok('space.switch', 'constructor'), false);
  assert.equal(ok('space.edit', 'side'), true);
  assert.equal(ok('tab.new', undefined), true);
  assert.equal(ok('tab.new', 'side'), true);
  assert.equal(ok('tab.new', 'gone'), false);
  assert.equal(ok('tab.moveToSpace', { tab: 14, space: 'work' }), true);
  assert.equal(ok('tab.moveToSpace', { tab: 99, space: 'work' }), false);
  assert.equal(ok('tab.moveToSpace', { tab: 14, space: 'work', also: 1 }), false);
  assert.equal(ok('archive.restore', 'ar2'), true);
  assert.equal(ok('archive.restore', 'ar9'), false);
  assert.equal(ok('palette.run', 'tab:12'), true);
  assert.equal(ok('palette.run', 'tab:13'), false, 'not a row on screen');
  assert.equal(ok('nav.back', undefined), true);
  assert.equal(ok('nav.back', 'x'), false);
  assert.equal(ok('window.close', {}), false);
  assert.equal(ok('settings.open', null), true);
  assert.equal(ok('eval', 'x'), false);
  // No state: nothing exists.
  const none = contextFromState(null);
  assert.equal(checkAction('tab.activate', 14, none).ok, false);
  assert.equal(checkAction('space.switch', 'home', none).ok, false);
  // Prototype keys are never "open tabs".
  assert.equal(contextFromState({ tabs: Object.create({ 5: { id: 5 } }) }).hasTab(5), false);
});

test('every action has a way out, and the mapping table covers exactly the list', () => {
  assert.deepEqual(Object.keys(ACTION_MAP).sort(), Object.keys(ACTIONS).sort());
  for (const way of Object.values(ACTION_MAP)) {
    for (const part of way.split(' | ')) if (!['local', 'host', 'none', 'row'].includes(part)) assert.equal(typeof handlers[part], 'function', `${part} is a background handler`);
  }
});

const ui = { windowId: W, sidebar: 'open' };
const req = (name, arg, extra = {}) => requestFor(name, arg, { state, ui, platform: { marginFullscreen: false }, ...extra });

test('the mapping: each action becomes the request the background handles', () => {
  const send = (type, payload) => ({ kind: 'send', type, payload });
  assert.deepEqual(req('tab.activate', 14), send('activateTab', { tabId: 14 }));
  assert.deepEqual(req('tab.close', 14), send('closeTab', { tabId: 14 }));
  assert.deepEqual(req('tab.new', undefined), { kind: 'local', name: 'palette.open', arg: { newTab: true } }, 'Arcadia\'s + New Tab: the palette');
  assert.deepEqual(req('tab.new', 'side'), send('newTab', { windowId: W, spaceId: 'side' }));
  assert.deepEqual(req('tab.pin', 12), send('pinTab', { tabId: 12 }));
  assert.deepEqual(req('tab.unpin', 'pa'), send('unpin', { pinId: 'pa' }));
  assert.deepEqual(req('tab.moveToSpace', { tab: 14, space: 'work' }), send('moveTabToSpace', { tabId: 14, spaceId: 'work' }));
  assert.deepEqual(req('pin.open', 'pb'), send('openPin', { pinId: 'pb', windowId: W }));
  assert.deepEqual(req('folder.toggle', 'f1'), send('setFolderOpen', { folderId: 'f1', open: false }));
  assert.deepEqual(req('folder.toggle', 'f2'), send('setFolderOpen', { folderId: 'f2', open: true }));
  assert.deepEqual(req('folder.new', undefined), send('createFolder', { windowId: W }));
  assert.deepEqual(req('space.switch', 'work'), send('setSpace', { windowId: W, spaceId: 'work' }));
  assert.deepEqual(req('space.new', undefined), send('createSpace', { windowId: W }));
  assert.deepEqual(req('space.edit', 'side'), { kind: 'local', name: 'space.edit', arg: 'side' });
  assert.deepEqual(req('today.clear', undefined), send('clearToday', { windowId: W }), 'the canvas designs\' Clear');
  // The host first (the page's own history in pages); the background's handler for a host that has none (the app).
  assert.deepEqual(req('nav.back'), { kind: 'host', name: 'nav.back', fallback: { type: 'goBack', payload: { windowId: W } } });
  assert.deepEqual(req('nav.forward'), { kind: 'host', name: 'nav.forward', fallback: { type: 'goForward', payload: { windowId: W } } });
  assert.deepEqual(req('nav.reload'), { kind: 'host', name: 'nav.reload', fallback: { type: 'reload', payload: { windowId: W } } });
  for (const name of ['window.close', 'window.minimise', 'window.fullscreen']) assert.deepEqual(req(name), { kind: 'host', name });
  assert.deepEqual(req('window.fullscreen', undefined, { platform: { marginFullscreen: true } }), send('toggleFullscreen', { windowId: W }), 'Chrome\'s Margin full screen');
  assert.deepEqual(req('palette.open'), { kind: 'local', name: 'palette.open' });
  assert.deepEqual(req('palette.close'), { kind: 'local', name: 'palette.close' });
  assert.deepEqual(req('sidebar.toggle'), send('updateSettings', { patch: { sidebarPinnedOpen: true } }));
  assert.deepEqual(req('sidebar.toggle', undefined, { state: { ...state, settings: { sidebarPinnedOpen: true } } }), send('updateSettings', { patch: { sidebarPinnedOpen: false } }));
  assert.deepEqual(req('archive.open'), send('openLauncher', { windowId: W }));
  assert.deepEqual(req('settings.open'), send('openLauncher', { windowId: W, settings: true }));
  assert.deepEqual(req('archive.restore', 'ar1'), send('restoreArchive', { archiveId: 'ar1', windowId: W }));
});

test('the mapping: with the sidebar open over the page (peek), a switch keeps it open on the next page', () => {
  const peek = { ui: { windowId: W, sidebar: 'peek' } };
  assert.deepEqual(req('tab.activate', 14, peek).payload, { tabId: 14, show: true });
  assert.deepEqual(req('tab.close', 14, peek).payload, { tabId: 14, show: true });
  assert.deepEqual(req('pin.open', 'pa', peek).payload, { pinId: 'pa', windowId: W, show: true });
  assert.deepEqual(req('space.switch', 'work', peek).payload, { windowId: W, spaceId: 'work', show: true });
  assert.deepEqual(req('tab.pin', 12, peek).payload, { tabId: 12 }, 'not for what shows no other page');
});

test('palette.run: the row\'s own request, as shared/search.js made it', () => {
  const pui = { windowId: W, tabId: null, palette: { open: true, query: '' } };
  const items = paletteItems(state, pui, {});
  const row = (id) => items.find((i) => i.id === id);
  const run = (id, extra = {}) => req('palette.run', id, { row: row(id), ...extra });
  assert.deepEqual(run('tab:12'), { kind: 'send', type: 'activateTab', payload: { tabId: 12 } });
  assert.deepEqual(run('tab:12', { ui: { windowId: W, sidebar: 'peek' } }).payload, { tabId: 12, show: true });
  assert.deepEqual(run('action:new-window'), { kind: 'send', type: 'newWindow', payload: { fromWindowId: W } });
  assert.deepEqual(run('action:space:work'), { kind: 'send', type: 'setSpace', payload: { windowId: W, spaceId: 'work' } });
  assert.deepEqual(run('action:toggle-sidebar'), { kind: 'local', name: 'palette.toggleSidebar', arg: { local: 'toggleSidebar' } });
  const typed = paletteItems(state, { ...pui, palette: { open: true, query: 'example.org' } }, {});
  assert.deepEqual(req('palette.run', 'go', { row: typed.find((i) => i.id === 'go') }), { kind: 'send', type: 'newTab', payload: { windowId: W, url: 'https://example.org' } });
  const inNewTab = paletteItems(state, { ...pui, inNewTab: true, palette: { open: true, query: 'cats and dogs' } }, {});
  assert.deepEqual(req('palette.run', 'go', { row: inNewTab.find((i) => i.id === 'go') }), { kind: 'local', name: 'palette.search', arg: { local: 'search', query: 'cats and dogs' } });
  assert.equal(req('palette.run', 'tab:999', { row: undefined }).kind, 'none');
  // Every request a row can make is a background handler.
  for (const item of [...items, ...typed]) if (!item.action.local) assert.equal(typeof handlers[item.action.type], 'function', item.action.type);
});

test('two-value actions: exactly their fields, each checked against the state', () => {
  assert.equal(ok('tab.move', { tab: 14, nextTo: 12, side: 'before' }), true);
  assert.equal(ok('tab.move', { tab: 14, nextTo: 12, side: 'above' }), false, 'a side is before or after');
  assert.equal(ok('tab.move', { tab: 14, nextTo: 99, side: 'after' }), false, 'next to an open tab');
  assert.equal(ok('tab.pinAt', { tab: 14, folder: 'f1', before: 'pb' }), true);
  assert.equal(ok('tab.pinAt', { tab: 14, folder: null, before: null }), true, 'the end of the top level');
  assert.equal(ok('tab.pinAt', { tab: 14, folder: null, before: 'f2' }), true, 'before a folder');
  assert.equal(ok('tab.pinAt', { tab: 14, folder: 'f9', before: null }), false);
  assert.equal(ok('tab.pinAt', { tab: 14, folder: null }), false, 'every field, even a null one');
  assert.equal(ok('pin.move', { pin: 'pa', folder: 'f2', before: null }), true);
  assert.equal(ok('pin.move', { pin: 'zz', folder: 'f2', before: null }), false);
  assert.equal(ok('folder.move', { folder: 'f2', before: 'pd' }), true);
  assert.equal(ok('folder.setName', { folder: 'f1', name: 'Reading list' }), true);
  assert.equal(ok('folder.setName', { folder: 'f1', name: 'x'.repeat(41) }), false, 'at most 40 characters');
  assert.equal(ok('folder.setName', { folder: 'f1', name: 'a\u0000b' }), false, 'no control characters');
  assert.equal(ok('space.setName', { space: 'work', name: 'Deeper Work' }), true);
  assert.equal(ok('space.update', { space: 'work', name: 'W', emoji: '🧠', color: '#00b894' }), true);
  assert.equal(ok('space.update', { space: 'work', name: 'W', emoji: '🧠', color: null }), true, 'no color: the space keeps its own');
  assert.equal(ok('space.update', { space: 'work', name: 'W', emoji: '🧠', color: 'url(x)' }), false, 'a color is #rgb or #rrggbb');
  assert.equal(ok('space.update', { space: 'work', name: 'W', emoji: '🧠'.repeat(9), color: '#000' }), false);
  assert.equal(ok('tab.moveToSpace', Object.assign(Object.create({ evil: 1 }), { tab: 14, space: 'work' })), false, 'a plain object only');
  assert.equal(ok('tab.move', [14, 12, 'before']), false);
});

test('menu items, swatches and menus a button opens are checked too', () => {
  assert.equal(ok('menu.run', 'i1'), true);
  assert.equal(ok('menu.run', 'i7'), false, 'not an item of the open menu');
  assert.equal(ok('editor.color', 'c0'), true);
  assert.equal(ok('editor.color', 'c9'), false);
  assert.equal(ok('menu.open', 'add'), true);
  assert.equal(ok('menu.open', 'tab'), false);
  assert.equal(ok('folder.rename', 'f1'), true);
  assert.equal(ok('folder.delete', 'f9'), false);
  assert.equal(ok('space.delete', 'side'), true);
  assert.equal(checkAction('menu.run', 'i0', contextFromState(state)).ok, false, 'no menu open: no items');
});

test('only behaviors and menus run two-value actions and space.delete; a theme\'s click never does', () => {
  assert.deepEqual([...BEHAVIOR_ONLY].sort(), ['folder.move', 'folder.setName', 'pin.move', 'profile.forget', 'space.delete', 'space.move', 'space.setName', 'space.update', 'tab.move', 'tab.moveToSpace', 'tab.pinAt']);
  const ran = [];
  const log = [];
  const dispatch = createDispatcher({ context: () => ctx, run: (n, a) => ran.push([n, a]), log: (e) => log.push(e) });
  assert.equal(dispatch('tab.moveToSpace', { tab: 14, space: 'work' }), false);
  assert.equal(dispatch('space.delete', 'side'), false);
  assert.equal(dispatch('folder.delete', 'f1'), true, 'a folder\'s pins stay: a button may delete it');
  assert.deepEqual(ran, [['folder.delete', 'f1']]);
  assert.match(log[0].reason, /only Margin's behaviors/);
});

test('the mapping: the behaviors\' and menus\' actions become the requests today\'s sidebar sends', () => {
  const send = (type, payload) => ({ kind: 'send', type, payload });
  const hint = { url: 'https://mail.example/', index: 1, title: 'Mail', from: state.openTabsBy };
  assert.deepEqual(req('tab.move', { tab: 14, nextTo: 12, side: 'after' }), send('moveTab', { tabId: 14, nextTo: 12, side: 'after', nextToHint: hint }), 'with the address and place of the tab it goes next to');
  assert.deepEqual(req('tab.pinAt', { tab: 14, folder: 'f1', before: 'pb' }), send('pinTab', { tabId: 14, folderId: 'f1', beforeId: 'pb' }));
  assert.deepEqual(req('pin.move', { pin: 'pa', folder: null, before: 'pd' }), send('movePin', { pinId: 'pa', folderId: null, beforeId: 'pd' }));
  assert.deepEqual(req('folder.move', { folder: 'f2', before: null }), send('moveFolder', { folderId: 'f2', beforeId: null }));
  assert.deepEqual(req('folder.newWithTab', 14), send('createFolder', { windowId: W, tabId: 14 }));
  assert.deepEqual(req('folder.newWithPin', 'pa'), send('createFolder', { windowId: W, pinIds: ['pa'] }));
  assert.deepEqual(req('folder.setName', { folder: 'f1', name: 'Later' }), send('renameFolder', { folderId: 'f1', name: 'Later' }));
  assert.deepEqual(req('folder.delete', 'f1'), send('deleteFolder', { folderId: 'f1' }));
  assert.deepEqual(req('space.setName', { space: 'work', name: 'Deeper' }), send('renameSpace', { spaceId: 'work', name: 'Deeper' }));
  assert.deepEqual(req('space.update', { space: 'work', name: 'W', emoji: '🧠', color: '#00b894' }), send('renameSpace', { spaceId: 'work', name: 'W', emoji: '🧠', color: '#00b894' }));
  assert.deepEqual(req('space.delete', 'side'), send('deleteSpace', { spaceId: 'side' }));
  for (const name of ['folder.rename', 'space.rename', 'menu.run', 'editor.color']) assert.equal(req(name, 'x').kind, 'local', name);
  for (const name of ['menu.close', 'editor.save', 'editor.cancel', 'editor.delete']) assert.deepEqual(req(name), { kind: 'local', name });
});

test('notices and prompts: a button of the one shown, checked by its id; closing; the launcher\'s "Show all" (all the UI\'s own)', () => {
  const c = contextFromState(state, [], { noticeIds: ['go', 'no'], promptIds: ['ok'] });
  assert.deepEqual(checkAction('notice.run', 'go', c), { ok: true });
  assert.equal(checkAction('notice.run', 'ok', c).ok, false, 'a prompt\'s button isn\'t the notice\'s');
  assert.equal(checkAction('notice.run', 'gone', contextFromState(state)).ok, false, 'no notice shown: nothing to run');
  assert.deepEqual(checkAction('prompt.run', 'ok', c), { ok: true });
  assert.equal(checkAction('prompt.run', '__proto__', c).ok, false);
  for (const name of ['notice.close', 'prompt.close', 'launcher.more']) {
    assert.deepEqual(checkAction(name, undefined, c), { ok: true });
    assert.equal(checkAction(name, 'x', c).ok, false);
  }
  for (const [name, arg] of [['notice.run', 'go'], ['notice.close', undefined], ['prompt.run', 'ok'], ['prompt.close', undefined], ['launcher.more', undefined]]) {
    assert.deepEqual(requestFor(name, arg, { state, ui: { windowId: W } }), arg === undefined ? { kind: 'local', name } : { kind: 'local', name, arg });
    assert.equal(ACTION_MAP[name], 'local');
    assert.equal(BEHAVIOR_ONLY.has(name), false, 'a theme\'s button runs them');
  }
});
