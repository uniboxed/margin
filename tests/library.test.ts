// Margin.app's library (app/shared/library/library.ts): the spaces, pins, folders and items the app owns with
// MarginHosted on, edited by state/model.ts's rules; the import of each profile's set; what the UI is given.
// The app's side (its files, JavaScriptCore, the delegate) is app/platforms/macos/shell/tests/library-tests.swift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../app/shared/library/library.ts';
import { mergeData, liveValues } from '../extension/shared/data-merge.ts';
import { fromStorage } from '../extension/shared/stored.ts';
import * as view from '../extension/shared/view.ts';
import * as M from '../extension/state/model.ts';

// A library kept as the app keeps it: a data set, each action's changes merged with the action's time.
function library(values: L.Values = {}) {
  let set: any = { format: 1, items: {} };
  let clock = 1000;
  let n = 0;
  const merge = (changes: L.Change[]) => {
    clock += 1;
    set = mergeData(set, changes.map((c) => ({ ...c, updatedAt: clock })));
  };
  merge(Object.entries(values).flatMap(([collection, list]) => Object.entries(list).map(([id, value]) => ({ collection, id, value }))));
  const values_ = () => Object.fromEntries(L.COLLECTIONS.map((c) => [c, liveValues(set, c)]));
  return {
    get values() { return values_(); },
    act(action: string, payload: any = {}) {
      const out = L.perform(values_(), action, payload, { now: clock + 1, ids: [`id${++n}x`, `id${++n}x`, `id${++n}x`] });
      merge(out.changes);
      return out;
    },
    merge,
  };
}
const spaces = (lib: { values: L.Values }) => Object.entries(lib.values.spaces).sort((a, b) => a[1].order - b[1].order).map(([id]) => id);
const items = (lib: { values: L.Values }, spaceId?: string) => Object.entries(lib.values.tabs).filter(([, t]) => !spaceId || t.spaceId === spaceId).map(([id]) => id).sort();
const web = (profile: string | null = null) => ({ kind: 'web', browser: 'safari', profile });

test('library: spaces are created, renamed, given a profile, ordered, and the last one stays', () => {
  const lib = library({ spaces: { a: { name: 'A', emoji: '🅰️', color: '#111111', order: 0, browser: 'safari', profile: 's-default' } } });
  const made = lib.act('createSpace', { windowId: 7, name: '  Work ', emoji: '💼' });
  assert.equal(made.ok, true);
  const id = made.result.spaceId;
  assert.match(id, /^sp-/);
  assert.equal(lib.values.spaces[id].name, 'Work', 'the model trims the name');
  assert.equal(lib.values.spaces[id].profile, 's-default', 'a new space takes the profile of the space the window showed');
  assert.equal(lib.values.windows['7'].spaceId, id, 'and the window shows it');
  assert.equal(lib.act('createSpace', { name: 'Other', profile: null }).ok, true);
  const other = spaces(lib)[2];
  assert.equal(lib.values.spaces[other].profile, null, 'a profile asked for (none: the default)');
  lib.act('renameSpace', { spaceId: id, name: 'Job', color: '#222222' });
  assert.deepEqual([lib.values.spaces[id].name, lib.values.spaces[id].emoji, lib.values.spaces[id].color], ['Job', '💼', '#222222']);
  lib.act('setSpaceProfile', { spaceId: id, profile: 's-1234' });
  assert.equal(lib.values.spaces[id].profile, 's-1234');
  lib.act('orderSpaces', { spaceIds: [other, 'a'] });
  assert.deepEqual(spaces(lib), [other, 'a', id], 'the named first, the rest after');
  assert.equal(lib.act('deleteSpace', { spaceId: id }).ok, true);
  assert.equal(lib.act('deleteSpace', { spaceId: other }).ok, true);
  const last = lib.act('deleteSpace', { spaceId: 'a' });
  assert.deepEqual([last.ok, last.error, last.changes], [false, 'the last space', []]);
  assert.deepEqual(spaces(lib), ['a']);
});

// A theme per space (2026-11-20, Tirth): asked as it's made, the theme of the space it was made from by default; changed
// in its editor (renameSpace), its menu or Settings (setSpaceTheme); none (spaces from before) is the profile's.
test('library: a space\'s theme: the one it was made from by default, as asked, changed, cleared, kept in the set', () => {
  const lib = library({ spaces: { a: { name: 'A', order: 0, theme: 'pixel' }, b: { name: 'B', order: 1 } } });
  lib.act('setSpace', { windowId: 7, spaceId: 'a' });
  const fromA = lib.act('createSpace', { windowId: 7, name: 'From A' }).result.spaceId;
  assert.equal(lib.values.spaces[fromA].theme, 'pixel', 'the theme of the space the window showed');
  const asked = lib.act('createSpace', { windowId: 7, name: 'Asked', theme: 'material' }).result.spaceId;
  assert.equal(lib.values.spaces[asked].theme, 'material', 'one asked for');
  lib.act('setSpace', { windowId: 7, spaceId: 'b' });
  const fromB = lib.act('createSpace', { windowId: 7, name: 'From B' }).result.spaceId;
  assert.equal('theme' in lib.values.spaces[fromB], false, 'made from one with none: none (the profile\'s, as it)');
  assert.equal('theme' in lib.values.spaces.b, false, 'a space with none keeps none: nothing written for it');
  lib.act('renameSpace', { spaceId: fromB, name: 'Renamed', theme: 'liquid-glass' });
  assert.deepEqual([lib.values.spaces[fromB].name, lib.values.spaces[fromB].theme], ['Renamed', 'liquid-glass'], 'its editor');
  lib.act('renameSpace', { spaceId: fromB, name: 'Again' });
  assert.equal(lib.values.spaces[fromB].theme, 'liquid-glass', 'a rename without a theme leaves it');
  assert.equal(lib.act('setSpaceTheme', { spaceId: fromB, theme: 'neubrutalism' }).ok, true);
  assert.equal(lib.values.spaces[fromB].theme, 'neubrutalism', 'its menu, Settings');
  assert.equal(lib.act('setSpaceTheme', { spaceId: fromB, theme: null }).ok, true);
  assert.equal('theme' in lib.values.spaces[fromB], false, 'null: none again');
  const bad = lib.act('setSpaceTheme', { spaceId: fromB, theme: 'Not An Id!' });
  assert.deepEqual([bad.ok, bad.error, bad.changes], [false, 'not a theme id', []]);
  assert.equal(lib.act('setSpaceTheme', { spaceId: 'nope', theme: 'pixel' }).ok, false);
  assert.equal(lib.act('createSpace', { name: 'Odd', theme: '../x' }).ok, true);
  assert.equal(lib.values.spaces[spaces(lib).at(-1)!].theme, 'pixel', 'not an id: as none asked (no window: the first space\'s, the one such a window shows)');
  // What the UI draws: each space with its theme.
  const shot = L.snapshot(lib.values);
  assert.deepEqual(shot.spaces.map((s: any) => s.theme ?? null), ['pixel', null, 'pixel', 'material', null, 'pixel']);
});

test('library: deleting a space moves its items, pins, folders, archive and windows to the first space left', () => {
  const lib = library({ spaces: { a: { name: 'A', order: 0 }, b: { name: 'B', order: 1 } } });
  lib.act('setSpace', { windowId: 1, spaceId: 'b' });
  const tab = lib.act('newTab', { windowId: 1, url: 'https://b.example/' }).result.tabId;
  const app = lib.act('addItem', { windowId: 1, target: { kind: 'app', bundleId: 'com.apple.Notes', name: 'Notes' } }).result.tabId;
  const pin = lib.act('pinTab', { tabId: lib.act('newTab', { windowId: 1, url: 'https://pin.example/' }).result.tabId }).result;
  const folder = lib.act('createFolder', { windowId: 1, name: 'F', pinIds: [pin] }).result;
  const gone = lib.act('newTab', { windowId: 1, url: 'https://gone.example/' }).result.tabId;
  lib.act('closeTab', { tabId: gone });
  lib.act('deleteSpace', { spaceId: 'b' });
  const v = lib.values;
  assert.deepEqual([v.tabs[tab].spaceId, v.tabs[app].spaceId], ['a', 'a']);
  assert.deepEqual(v.tabs[app].target, { kind: 'app', bundleId: 'com.apple.Notes', name: 'Notes' }, 'an item keeps its own target');
  assert.equal(v.pins[pin].spaceId, 'a');
  assert.deepEqual([v.folders[folder].spaceId, v.pins[pin].folderId], ['a', folder]);
  assert.ok(Object.values(v.archive).every((e) => e.spaceId === 'a'));
  assert.equal(v.windows['1'].spaceId, 'a');
});

test('library: items: web or app, moved, ordered, pinned, and the hosting asked for what needs a browser', () => {
  const lib = library({ spaces: { a: { name: 'A', order: 0, browser: 'safari', profile: 's-work' }, b: { name: 'B', order: 1 } } });
  const opened = lib.act('newTab', { windowId: 3, url: 'https://one.example/' });
  const one = opened.result.tabId;
  assert.match(one, /^t-[a-z0-9]+$/, 'an item id the model and the UI take as a Margin tab id');
  assert.deepEqual(lib.values.tabs[one].target, web('s-work'), 'a web item in its space\'s profile');
  assert.deepEqual(opened.requests, [{ type: 'newTab', windowId: 3, item: one, url: 'https://one.example/', target: web('s-work'), spaceId: 'a' }]);
  assert.equal(lib.act('newTab', { windowId: 3 }).error, 'no address', '⌘T with nothing typed is the palette\'s');
  const two = lib.act('newTab', { windowId: 3, url: 'https://two.example/' }).result.tabId;
  assert.ok(lib.values.tabs[two].order > lib.values.tabs[one].order, 'newest highest');
  assert.deepEqual([lib.values.tabs[two].selected, lib.values.tabs[one].selected], [true, false], 'one selected per space');
  const act = lib.act('activateTab', { tabId: one, windowId: 3 });
  assert.deepEqual(act.requests[0], { type: 'activateTab', windowId: 3, item: one, url: 'https://one.example/', target: web('s-work'), spaceId: 'a' });
  assert.deepEqual([lib.values.tabs[one].selected, lib.values.tabs[two].selected], [true, false]);
  // Dragged above `two` (a later place).
  assert.equal(lib.act('moveTab', { tabId: one, nextTo: two, side: 'before' }).result, true);
  assert.ok(lib.values.tabs[one].order > lib.values.tabs[two].order);
  const notes = lib.act('addItem', { spaceId: 'b', target: { kind: 'app', bundleId: 'com.apple.Notes', name: 'Notes' } }).result.tabId;
  assert.deepEqual([lib.values.tabs[notes].url, lib.values.tabs[notes].title, lib.values.tabs[notes].spaceId], ['app://com.apple.Notes', 'Notes', 'b']);
  assert.equal(lib.act('addItem', { target: { kind: 'app', bundleId: '../x' } }).error, 'no address', 'a bundle id is checked');
  lib.act('moveTabToSpace', { tabId: two, spaceId: 'b' });
  assert.deepEqual(items(lib, 'b'), [notes, two].sort());
  assert.deepEqual(lib.values.tabs[two].target, web('s-work'), 'moved, it stays in its profile');
  lib.act('updateItem', { tabId: two, url: 'https://two.example/next', title: 'Next', icon: 'data:image/png;base64,AA==' });
  assert.deepEqual([lib.values.tabs[two].url, lib.values.tabs[two].title, lib.values.tabs[two].icon], ['https://two.example/next', 'Next', 'data:image/png;base64,AA==']);
  lib.act('updateItem', { tabId: notes, url: 'https://x.example/' });
  assert.equal(lib.values.tabs[notes].url, 'app://com.apple.Notes', 'an app item has no address to change');
  // Pinned: the item is the pin from then on, with its target.
  const pin = lib.act('pinTab', { tabId: notes }).result;
  assert.equal(lib.values.tabs[notes], undefined);
  assert.deepEqual([lib.values.pins[pin].url, lib.values.pins[pin].target.kind], ['app://com.apple.Notes', 'app']);
  const open = lib.act('openPin', { pinId: pin, windowId: 3 });
  assert.deepEqual(open.requests[0], { type: 'openPin', windowId: 3, pin, item: null, url: 'app://com.apple.Notes', target: { kind: 'app', bundleId: 'com.apple.Notes', name: 'Notes' }, spaceId: 'b' });
  assert.equal(lib.values.windows['3'].spaceId, 'b', 'the window shows the pin\'s space');
  assert.equal(lib.act('unpin', { pinId: pin }).requests[0].type, 'unpin');
  assert.equal(lib.values.pins[pin], undefined);
});

test('library: closing: a web item to the archive with its target, an app item forgotten, the next one named', () => {
  const lib = library({ spaces: { a: { name: 'A', order: 0, profile: 's-p' } } });
  const one = lib.act('newTab', { windowId: 1, url: 'https://one.example/' }).result.tabId;
  const two = lib.act('newTab', { windowId: 1, url: 'https://two.example/' }).result.tabId;
  const app = lib.act('addItem', { windowId: 1, target: { kind: 'app', bundleId: 'com.apple.Music' } }).result.tabId;
  const closed = lib.act('closeTab', { tabId: two });
  assert.deepEqual(closed.requests, [{ type: 'closeTab', item: two, url: 'https://two.example/', target: web('s-p'), spaceId: 'a', next: app }]);
  const [entry] = Object.entries(lib.values.archive);
  assert.deepEqual([entry[1].url, entry[1].target], ['https://two.example/', web('s-p')]);
  lib.act('closeTab', { tabId: app });
  assert.equal(Object.keys(lib.values.archive).length, 1, 'an app isn\'t archived');
  const restored = lib.act('restoreArchive', { archiveId: entry[0], windowId: 1 });
  assert.equal(restored.requests[0].type, 'restoreArchive');
  assert.deepEqual(lib.values.tabs[restored.result.tabId].target, web('s-p'));
  assert.equal(Object.keys(lib.values.archive).length, 0);
  const cleared = lib.act('clearToday', { windowId: 1 });
  assert.deepEqual(cleared.result, [one, restored.result.tabId].sort());
  assert.deepEqual(items(lib), []);
  lib.act('newTab', { windowId: 1, url: 'https://three.example/' });
  const t = items(lib)[0];
  assert.equal(lib.act('itemClosed', { tabId: t }).requests.length, 0, 'closed outside Margin: nothing asked');
});

test('library: Margin\'s Settings page as an item of its own (margin://settings): one per space, shown again, never archived or changed by a browser', () => {
  const lib = library({ spaces: { a: { name: 'A', order: 0 }, b: { name: 'B', order: 1 } } });
  const settings = { kind: 'margin', page: 'settings' };
  assert.deepEqual(L.targetOf(settings), settings);
  assert.equal(L.targetOf({ kind: 'margin', page: 'evil' }), null, 'only Margin\'s own pages');
  assert.equal(L.targetOf({ kind: 'margin' }), null);
  const first = lib.act('openMarginPage', { windowId: 1, page: 'settings' });
  const id = first.result.tabId;
  assert.deepEqual(first.requests, [{ type: 'newTab', windowId: 1, item: id, url: 'margin://settings', target: settings, spaceId: 'a' }]);
  assert.deepEqual([lib.values.tabs[id].url, lib.values.tabs[id].title, lib.values.tabs[id].icon, lib.values.tabs[id].target, lib.values.tabs[id].selected], ['margin://settings', 'Settings', '', settings, true]);
  const other = lib.act('newTab', { windowId: 1, url: 'https://one.example/' }).result.tabId;
  assert.equal(lib.values.tabs[id].selected, false);
  const again = lib.act('openMarginPage', { windowId: 1, page: 'settings' });
  assert.deepEqual(again.requests, [{ type: 'activateTab', windowId: 1, item: id, url: 'margin://settings', target: settings, spaceId: 'a' }], 'the space\'s one shown again');
  assert.equal(items(lib, 'a').length, 2, 'no second Settings item');
  assert.equal(lib.values.tabs[id].selected, true);
  assert.equal(lib.act('openMarginPage', { windowId: 1, page: 'nope' }).ok, false);
  // A browser's report never changes it.
  lib.act('updateItem', { tabId: id, url: 'https://elsewhere.example/', title: 'Elsewhere', icon: 'data:image/png;base64,AA' });
  assert.deepEqual([lib.values.tabs[id].url, lib.values.tabs[id].title, lib.values.tabs[id].icon], ['margin://settings', 'Settings', '']);
  // Another space: its own.
  lib.act('setSpace', { windowId: 1, spaceId: 'b' });
  const inB = lib.act('openMarginPage', { windowId: 1, page: 'settings' }).result.tabId;
  assert.notEqual(inB, id);
  assert.equal(lib.values.tabs[inB].spaceId, 'b');
  // Made by the hosting (a pin opened with no item): the same address and title, whatever it said.
  const added = lib.act('addItem', { windowId: 1, target: settings, url: 'https://x.example/', title: 'X', icon: 'data:image/png;base64,AA' }).result.tabId;
  assert.deepEqual([lib.values.tabs[added].url, lib.values.tabs[added].title, lib.values.tabs[added].icon], ['margin://settings', 'Settings', '']);
  // Closed: forgotten, not archived; the next one named.
  lib.act('setSpace', { windowId: 1, spaceId: 'a' });
  const closed = lib.act('closeTab', { tabId: id });
  assert.deepEqual(closed.requests, [{ type: 'closeTab', item: id, url: 'margin://settings', target: settings, spaceId: 'a', next: other }]);
  assert.equal(lib.values.tabs[id], undefined);
  assert.equal(Object.keys(lib.values.archive).length, 0, 'never archived');
  // Pinned: the pin keeps its target, and opening it shows its item again.
  const pin = lib.act('pinTab', { tabId: inB }).result;
  assert.deepEqual(lib.values.pins[pin].target, settings);
  assert.equal(lib.act('openPin', { windowId: 1, pinId: pin }).requests[0].target?.kind, 'margin');
});

test('library: folders and pins follow the model\'s order rules', () => {
  const lib = library({ spaces: { a: { name: 'A', order: 0 } } });
  const pins = ['x', 'y', 'z'].map((n) => lib.act('pinTab', { tabId: lib.act('newTab', { windowId: 1, url: `https://${n}.example/` }).result.tabId }).result);
  const folder = lib.act('createFolder', { windowId: 1, pinIds: [pins[1], pins[2]] }).result;
  const s = L.stateOf(lib.values);
  assert.deepEqual(M.pinOrder(s, 'a').map((x) => x.id), [pins[0], folder]);
  assert.deepEqual(M.pinOrder(s, 'a', folder).map((x) => x.id), [pins[1], pins[2]]);
  lib.act('renameFolder', { folderId: folder, name: 'Reading' });
  lib.act('setFolderOpen', { folderId: folder, open: false });
  assert.deepEqual([lib.values.folders[folder].name, lib.values.folders[folder].open], ['Reading', false]);
  lib.act('movePin', { pinId: pins[2], folderId: null, beforeId: pins[0] });
  lib.act('moveFolder', { folderId: folder, beforeId: pins[2] });
  assert.deepEqual(M.pinOrder(L.stateOf(lib.values), 'a').map((x) => x.id), [folder, pins[2], pins[0]]);
  // An item pinned straight into a new folder.
  const item = lib.act('newTab', { windowId: 1, url: 'https://w.example/' }).result.tabId;
  const f2 = lib.act('createFolder', { windowId: 1, tabId: item }).result;
  assert.equal(lib.values.tabs[item], undefined);
  assert.equal(Object.values(lib.values.pins).filter((p) => p.folderId === f2).length, 1);
  lib.act('deleteFolder', { folderId: folder });
  assert.equal(lib.values.folders[folder], undefined);
  assert.equal(Object.values(lib.values.pins).filter((p) => p.folderId === folder).length, 0, 'its pins stay, loose');
});

test('library: an action changes only what it changes, refuses what it doesn\'t know, and never throws', () => {
  const lib = library({ spaces: { a: { name: 'A', order: 0 }, b: { name: 'B', order: 1 } } });
  const set = lib.act('setSpace', { windowId: 2, spaceId: 'b' });
  assert.deepEqual(set.changes, [{ collection: 'windows', id: '2', value: { spaceId: 'b' } }]);
  assert.deepEqual(set.requests, [{ type: 'setSpace', windowId: 2, spaceId: 'b', item: null }]);
  assert.deepEqual(lib.act('setSpace', { windowId: 2, spaceId: 'b' }).changes, [], 'again: nothing');
  assert.deepEqual(lib.act('updateSettings', { patch: {} }), { ok: false, error: 'unsupported', changes: [], requests: [] });
  assert.equal(lib.act('setSpace', { windowId: 2, spaceId: 'nope' }).ok, false);
  assert.equal(L.perform({ spaces: null as any }, 'createFolder', null).ok, false, 'no space: refused');
  assert.equal(L.perform({}, 'toString').error, 'unsupported');
  lib.act('forgetWindow', { windowId: 2 });
  assert.equal(lib.values.windows['2'], undefined);
  for (const name of L.ACTION_NAMES) assert.doesNotThrow(() => L.perform(lib.values, name, { tabId: 5, spaceId: {}, pinIds: 'x' }), name);
});

test('library: the snapshot is what the UI draws from its stored values', () => {
  const lib = library({ spaces: { a: { name: 'A', order: 0 }, b: { name: 'B', order: 1 } } });
  lib.act('setSpace', { windowId: 4, spaceId: 'b' });
  const one = lib.act('newTab', { windowId: 4, url: 'https://one.example/' }).result.tabId;
  lib.act('pinTab', { tabId: lib.act('newTab', { windowId: 4, url: 'https://pin.example/' }).result.tabId });
  const snap = L.snapshot(lib.values);
  assert.deepEqual(snap.library, { v: 1, imported: false });
  const state = M.normalizeState(fromStorage(JSON.parse(JSON.stringify(snap))));
  assert.deepEqual(state.spaces.map((s) => s.id), ['a', 'b']);
  assert.equal(M.activeSpaceId(state, 4), 'b');
  const side = view.sidebar(state, 4);
  assert.deepEqual(side.tabs.map((t: any) => [t.id, t.kept]), [[one, true]], 'an item is a Margin tab that isn\'t open');
  assert.equal(side.pinned.length, 1);
  assert.deepEqual((state.keptTabs[one] as any).target, web(null), 'with its target');
});

test('library: the import takes every profile\'s set once, ids namespaced, the person\'s order kept', () => {
  const set = (values: Record<string, Record<string, any>>) => values;
  const def = set({
    spaces: { personal: { name: 'Personal', emoji: '🏠', color: '#6c5ce7', order: 0 }, work: { name: 'Work', emoji: '💼', color: '#000', order: 1 } },
    pins: { 'p-1': { spaceId: 'work', url: 'https://mail.example/', title: 'Mail', folderId: 'f-1', pos: 0 } },
    folders: { 'f-1': { spaceId: 'work', name: 'F', open: true, pos: 0 } },
    tabs: { 't-aaaa': { url: 'https://a.example/', title: 'A', icon: '', spaceId: 'personal', order: 3, lastUsed: 50, selected: true }, 't-nope': { url: 'about:blank', spaceId: 'personal', order: 1 } },
    archive: { 'a-1': { url: 'https://old.example/', title: 'Old', spaceId: 'gone', icon: '', closedAt: 9 } },
    settings: { theme: { updatedAt: 1, value: 'x' } },
  });
  const other = set({
    spaces: { personal: { name: 'Home', emoji: '🏡', color: '#fff', order: 0 } },
    tabs: { 't-aaaa': { url: 'https://b.example/', title: 'B', spaceId: 'personal', order: 0, lastUsed: 60 } },
  });
  const sets = [{ browser: 'safari', profile: 's-default', values: def }, { browser: 'safari', profile: 's-OTHER', values: other }];
  const order: [string, string, string][] = [['safari', 's-default', 'work'], ['safari', 's-OTHER', 'personal'], ['safari', 's-default', 'personal']];
  const { changes, counts } = L.importValues({}, sets, order, { now: 77 });
  assert.deepEqual(counts, { spaces: 3, pins: 1, folders: 1, tabs: 2, archive: 1 });
  const lib = library();
  lib.merge(changes);
  assert.deepEqual(spaces(lib), ['safari:s-default:work', 'safari:s-OTHER:personal', 'safari:s-default:personal']);
  assert.deepEqual(lib.values.spaces['safari:s-OTHER:personal'], { name: 'Home', emoji: '🏡', color: '#fff', order: 1, browser: 'safari', profile: 's-OTHER' });
  const a = L.nsTabId('safari', 's-default', 't-aaaa');
  const b = L.nsTabId('safari', 's-OTHER', 't-aaaa');
  assert.notEqual(a, b, 'the same tab id in two profiles: two items');
  assert.ok(M.isTabId(a) && M.isTabId(b));
  assert.deepEqual(lib.values.tabs[a], { url: 'https://a.example/', title: 'A', icon: '', spaceId: 'safari:s-default:personal', order: 3, lastUsed: 50, selected: true, target: web('s-default'), imported: { browser: 'safari', profile: 's-default', id: 't-aaaa' } });
  assert.equal(lib.values.tabs[b].target.profile, 's-OTHER');
  assert.equal(Object.keys(lib.values.tabs).length, 2, 'a page that isn\'t a web page isn\'t an item');
  assert.deepEqual(lib.values.pins['safari:s-default:p-1'], { spaceId: 'safari:s-default:work', url: 'https://mail.example/', title: 'Mail', folderId: 'safari:s-default:f-1', pos: 0, target: web('s-default') });
  assert.equal(lib.values.archive['safari:s-default:a-1'].spaceId, 'safari:s-default:personal', 'an entry of a space gone: the profile\'s first');
  assert.deepEqual(lib.values.imports.done, { at: 77, sets: ['safari:s-default', 'safari:s-OTHER'], spaces: 3, pins: 1, folders: 1, tabs: 2, archive: 1 });
  assert.equal(lib.values.settings, undefined, 'settings aren\'t the library\'s');
  // Run again (a crash before the marker reached the disk): the same ids, nothing new.
  const again = L.importValues(lib.values, sets, order, { now: 77 });
  assert.deepEqual(again.changes, []);
  // And an action right after changes only itself (what was imported is as the model reads it).
  assert.deepEqual(lib.act('setSpace', { windowId: 1, spaceId: 'safari:s-default:work' }).changes.map((c) => c.collection), ['windows']);
  assert.equal(L.snapshot(lib.values).library.imported, true);
});

test('library: the app\'s entry: JSON in and out, errors as values', () => {
  const out = JSON.parse(L.call('perform', JSON.stringify([{ spaces: { a: { name: 'A', order: 0 } } }, 'createSpace', { name: 'B' }, { now: 1, ids: ['abcd'] }])));
  assert.equal(out.value.result.spaceId, 'sp-abcd');
  assert.deepEqual(JSON.parse(L.call('nope', '[]')), { error: 'no function nope' });
  assert.ok(JSON.parse(L.call('perform', '{')).error);
  assert.deepEqual(JSON.parse(L.call('actions', '[]')).value, L.ACTION_NAMES);
});
