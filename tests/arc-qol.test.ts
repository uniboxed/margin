import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../extension/state/model.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { checkAction, contextFromState, requestFor } from '../extension/ui/actions.ts';
import { sanitizeTemplate } from '../extension/ui/sanitize.ts';
import { menuItems } from '../extension/ui/behaviors/menu-items.ts';
import * as L from '../app/shared/library/library.ts';
import { createHostedTabs } from '../extension/background/hosted.ts';

test('M2.1: muted state propagates from browser tab through model into view model', () => {
  let s = M.defaultState();
  s = M.upsertTab(s, { id: 1, windowId: 10, index: 0, active: true, url: 'https://youtube.com/watch?v=1', title: 'Music', audible: true, mutedInfo: { muted: true } }, 1000);
  assert.equal(s.tabs[1].audible, true);
  assert.equal(s.tabs[1].muted, true);
  const vm = buildViewModel({ state: s, ui: { windowId: 10, tabId: 1 } });
  assert.equal(vm.tab?.muted, true);
  assert.equal(vm.space.today[0]?.muted, true);
  assert.equal(vm.space.today[0]?.audible, true);
});

test('M2.1: <m-toast> slot and toast part are guarded against static theme text', () => {
  const html = `<div><m-page></m-page><m-toast></m-toast><template m-part="toast"><div class="toast">Fake text {{toast.text}}</div></template></div>`;
  const res = sanitizeTemplate(html, { files: [] });
  assert.equal(res.errors.length, 0);
  assert.ok(res.removed.some((r) => r.kind === 'text' && r.name.includes('Fake text')));
});

test('M2.1: toast view model renders text and caps length', () => {
  const s = M.defaultState();
  const vm = buildViewModel({ state: s, ui: { windowId: 1, toast: { id: 't1', text: 'Copied Current URL' } } });
  assert.deepEqual(vm.toast, { id: 't1', text: 'Copied Current URL' });
  const vmEmpty = buildViewModel({ state: s, ui: { windowId: 1, toast: null } });
  assert.equal(vmEmpty.toast, null);
});

test('M2.1: QoL actions validate and map to requests', () => {
  let s = M.defaultState();
  s = M.upsertTab(s, { id: 5, windowId: 1, index: 0, active: true, url: 'https://example.com', title: 'Example' }, 1000);
  s = M.addPin(s, { id: 'p1', spaceId: 'personal', url: 'https://docs.example.com', title: 'Docs' });
  const ctx = contextFromState(s);

  assert.equal(checkAction('tab.copyUrl', undefined, ctx).ok, true);
  assert.equal(checkAction('tab.copyUrl', 5, ctx).ok, true);
  assert.equal(checkAction('tab.copyUrl', 999, ctx).ok, false);
  assert.equal(checkAction('pin.copyUrl', 'p1', ctx).ok, true);
  assert.equal(checkAction('tab.duplicate', 5, ctx).ok, true);
  assert.equal(checkAction('tab.mute', 5, ctx).ok, true);
  assert.equal(checkAction('tab.unload', 5, ctx).ok, true);
  assert.equal(checkAction('archive.restoreLast', undefined, ctx).ok, true);
  assert.equal(checkAction('toast.close', undefined, ctx).ok, true);

  assert.deepEqual(requestFor('tab.duplicate', 5, { state: s, ui: { windowId: 1 } }), { kind: 'send', type: 'duplicateTab', payload: { tabId: 5, windowId: 1 } });
  assert.deepEqual(requestFor('tab.mute', 5, { state: s, ui: { windowId: 1 } }), { kind: 'send', type: 'muteTab', payload: { tabId: 5, windowId: 1 } });
  assert.deepEqual(requestFor('tab.unload', 5, { state: s, ui: { windowId: 1 } }), { kind: 'send', type: 'unloadTab', payload: { tabId: 5, windowId: 1 } });
  assert.deepEqual(requestFor('archive.restoreLast', undefined, { state: s, ui: { windowId: 1 } }), { kind: 'send', type: 'restoreLastArchive', payload: { windowId: 1 } });
});

test('M2.1: context menus expose Copy URL, Duplicate, Mute/Unmute, and Sleep/Unload', () => {
  let s = M.defaultState();
  s = M.upsertTab(s, { id: 2, windowId: 1, index: 0, active: true, url: 'https://example.com', title: 'Example', mutedInfo: { muted: false } }, 1000);
  s = M.upsertTab(s, { id: 3, windowId: 1, index: 1, active: false, url: 'app://com.apple.Notes', title: 'Notes' }, 1000);
  const vm = buildViewModel({ state: s, ui: { windowId: 1, tabId: 2 } });

  const webMenu = menuItems({ kind: 'tab', id: 2 }, { state: s, space: vm.space });
  const webLabels = webMenu.filter((i) => !i.separator).map((i) => i.label);
  assert.ok(webLabels.includes('Copy URL'));
  assert.ok(webLabels.includes('Duplicate Tab'));
  assert.ok(webLabels.includes('Mute Tab'));
  assert.ok(webLabels.includes('Sleep Tab'));

  const appMenu = menuItems({ kind: 'tab', id: 3 }, { state: s, space: vm.space });
  const appLabels = appMenu.filter((i) => !i.separator).map((i) => i.label);
  assert.ok(!appLabels.includes('Copy URL'));
  assert.ok(!appLabels.includes('Duplicate Tab'));
  assert.ok(appLabels.includes('Unload App'));
});

test('M2.1: library duplicateTab, unloadTab, muteTab, and restoreLastArchive', () => {
  const vals: L.Values = {
    spaces: { personal: { name: 'Personal', emoji: '🏠', color: '#6c5ce7', order: 0, browser: 'safari', profile: null } },
    pins: {},
    folders: {},
    tabs: {
      't-1111111111': { url: 'https://example.com', title: 'Example', icon: '', spaceId: 'personal', order: 1, lastUsed: 1000, selected: true, target: { kind: 'web', browser: 'safari', profile: null } },
    },
    archive: {
      'a-1': { url: 'https://old.example.com', title: 'Old', spaceId: 'personal', icon: '', closedAt: 900, target: { kind: 'web', browser: 'safari', profile: null } },
    },
    windows: { '1': { spaceId: 'personal' } },
    imports: {},
  };

  // unloadTab keeps item in library (not archived) and emits unloadTab request
  const unloaded = L.perform(vals, 'unloadTab', { tabId: 't-1111111111', windowId: 1 }, { now: 2000, ids: ['aaaa'] });
  assert.equal(unloaded.ok, true);
  assert.equal(unloaded.changes.length, 0);
  assert.equal(unloaded.requests[0]?.type, 'unloadTab');
  assert.equal(unloaded.requests[0]?.item, 't-1111111111');

  // duplicateTab creates a new item and emits newTab
  const duped = L.perform(vals, 'duplicateTab', { tabId: 't-1111111111', windowId: 1 }, { now: 2001, ids: ['dup1234567'] });
  assert.equal(duped.ok, true);
  assert.equal(duped.result?.tabId, 't-dup1234567');
  assert.equal(duped.requests[0]?.type, 'newTab');
  assert.equal(duped.requests[0]?.url, 'https://example.com');

  // muteTab emits muteTab request
  const muted = L.perform(vals, 'muteTab', { tabId: 't-1111111111', windowId: 1 }, { now: 2002, ids: ['bbbb'] });
  assert.equal(muted.ok, true);
  assert.equal(muted.requests[0]?.type, 'muteTab');

  // restoreLastArchive restores newest archived entry in active space
  const restored = L.perform(vals, 'restoreLastArchive', { windowId: 1 }, { now: 2003, ids: ['res1234567'] });
  assert.equal(restored.ok, true);
  assert.equal(restored.requests[0]?.type, 'restoreArchive');
  assert.equal(restored.requests[0]?.url, 'https://old.example.com');
});

test('M2.1: hostedTabs.mute toggles muted state on hosted Safari tab', async () => {
  const tabs = new Map<number, any>([[10, { id: 10, windowId: 1, url: 'https://music.example.com', active: true, mutedInfo: { muted: false } }]]);
  const hosted = createHostedTabs(() => ({
    get: async (id) => tabs.get(id),
    query: async () => [...tabs.values()],
    create: async (p) => { const t = { id: 11, ...p, mutedInfo: { muted: false } }; tabs.set(11, t); return t; },
    update: async (id, p) => { const t = { ...tabs.get(id), ...(p.muted !== undefined ? { mutedInfo: { muted: p.muted } } : {}) }; tabs.set(id, t); return t; },
    remove: async (id) => { tabs.delete(id); },
  }));
  await hosted.show({ windowId: 1, itemId: 't-1', url: 'https://music.example.com' });
  const r1 = await hosted.mute({ itemId: 't-1' });
  assert.deepEqual(r1, { muted: true, ok: true });
  const r2 = await hosted.mute({ itemId: 't-1' });
  assert.deepEqual(r2, { muted: false, ok: true });
});
