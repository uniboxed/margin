// A theme's actions (extension/ui/actions.js): every argument checked against
// the host's state before anything is sent, and each action mapped to the
// background's real handler (background/handlers.js) with the payload
// Arcadia's sidebar and palette send today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, ACTION_MAP, checkAction, contextFromState, requestFor } from '../extension/ui/actions.js';
import { paletteItems } from '../extension/ui/view-model.js';
import { readFileSync } from 'node:fs';
import { smallState, W } from './ui/fixtures.js';

// The background's handler names, from its source (importing it needs a browser).
const HANDLERS = new Set([...readFileSync(new URL('../extension/background/handlers.js', import.meta.url), 'utf8').matchAll(/^  async (\w+)\(/gm)].map((m) => m[1]));
const handlers = Object.fromEntries([...HANDLERS].map((name) => [name, () => {}]));

const state = smallState();
const ctx = contextFromState(state, ['tab:12', 'go']);
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
  assert.equal(req('today.clear', undefined).kind, 'none');
  for (const name of ['nav.back', 'nav.forward', 'nav.reload', 'window.close', 'window.minimise', 'window.fullscreen']) assert.deepEqual(req(name), { kind: 'host', name });
  assert.deepEqual(req('window.fullscreen', undefined, { platform: { marginFullscreen: true } }), send('toggleFullscreen', { windowId: W }), 'Chrome\'s Margin full screen');
  assert.deepEqual(req('palette.open'), { kind: 'local', name: 'palette.open' });
  assert.deepEqual(req('palette.close'), { kind: 'local', name: 'palette.close' });
  assert.deepEqual(req('sidebar.toggle'), send('updateSettings', { patch: { sidebarPinnedOpen: true } }));
  assert.deepEqual(req('sidebar.toggle', undefined, { state: { ...state, settings: { sidebarPinnedOpen: true } } }), send('updateSettings', { patch: { sidebarPinnedOpen: false } }));
  assert.deepEqual(req('archive.open'), send('openLauncher', { windowId: W }));
  assert.deepEqual(req('settings.open'), send('openLauncher', { windowId: W }));
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
  assert.deepEqual(run('action:new-window'), { kind: 'send', type: 'newWindow', payload: {} });
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
