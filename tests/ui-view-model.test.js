// The theme view model (extension/ui/view-model.js): today's sidebar's
// sections and order (shared/view.js sidebar), the fields PLAN.md §3 and §14
// list, and structural sharing: what didn't change is the same object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../extension/shared/view.js';
import { buildViewModel, paletteItems, abbreviate, VM_VERSION } from '../extension/ui/view-model.js';
import { smallState, icon, W } from './ui/fixtures.js';
import { bigState, WINDOW } from './theme/view-model.js';

const PLATFORM = { browser: 'safari', os: 'mac' };
const build = (state, ui = {}, prev = null) => buildViewModel({ state, ui: { windowId: W, ...ui }, platform: PLATFORM }, prev);
const ids = (rows) => rows.map((r) => r.id);

test('sections and order: the pinned area (folders and loose pins by position), then the tabs newest first', () => {
  const vm = build(smallState());
  assert.equal(vm.version, VM_VERSION);
  assert.equal(vm.ready, true);
  assert.equal(vm.space.id, 'home');
  assert.deepEqual(vm.space.pinned.map((p) => `${p.kind}:${p.id}`), ['folder:f1', 'pin:pd', 'folder:f2']);
  assert.deepEqual(ids(vm.space.folders), ['f1', 'f2']);
  assert.deepEqual(ids(vm.space.pins), ['pd'], 'pins: the ones in no folder');
  const [reading, , projects] = vm.space.pinned;
  assert.deepEqual(ids(reading.pins), ['pa', 'pb']);
  assert.deepEqual(ids(reading.shown), ['pa', 'pb'], 'an open folder shows its pins');
  assert.equal(projects.open, false);
  assert.deepEqual(ids(projects.pins), ['pc']);
  assert.deepEqual(ids(projects.shown), ['pc'], 'a closed folder still shows the pin of the tab in front');
  assert.equal(projects.hasShown, true);
  assert.deepEqual(ids(vm.space.today), [15, 14, 12], 'pinned tabs are their pins\' rows; the rest newest first');
  assert.equal(vm.space.hasToday, true);
  assert.equal(vm.space.hasPinned, true);
  assert.equal(vm.space.newTab.active, false);
});

test('the same sections as shared/view.js sidebar, on the 200-tab state too', () => {
  for (const [state, windowId] of [[smallState(), W], [bigState(), WINDOW]]) {
    for (const tabId of [null, Object.values(state.tabs).find((t) => t.windowId === windowId && !t.active)?.id]) {
      const view = V.sidebar(state, windowId, tabId);
      const vm = build(state, { windowId, tabId });
      assert.equal(vm.space.id, view.spaceId);
      assert.deepEqual(vm.space.pinned.map((p) => p.id), view.pinned.map((p) => p.id));
      assert.deepEqual(vm.space.today.map((t) => [t.id, t.active]), view.tabs.map((t) => [t.id, !!t.active]));
      assert.deepEqual(vm.space.folders.flatMap((f) => f.pins.map((p) => [p.id, p.tabId, p.active])), view.pinned.filter((p) => p.kind === 'folder').flatMap((f) => f.pins.map((p) => [p.id, p.tabId, p.active])));
    }
  }
});

test('rows: icons from the stored favicons, a letter and color without one, sleeping and playing, titles', () => {
  const state = smallState();
  const vm = build(state);
  const row = (id) => vm.space.today.find((t) => t.id === id);
  const pin = (id) => [...vm.space.pins, ...vm.space.folders.flatMap((f) => f.pins)].find((p) => p.id === id);
  assert.equal(row(12).icon, state.favicons['https://mail.example'].data);
  assert.equal(row(12).audible, true);
  assert.equal(row(12).host, 'mail.example');
  assert.equal(row(14).icon, null, 'a site with no stored icon');
  assert.deepEqual([row(14).letter, row(14).color], [V.letterAvatar('nofav.example').letter, V.letterAvatar('nofav.example').color]);
  assert.equal(row(14).letter, 'N');
  assert.match(row(14).color, /^hsl\(\d+ 55% 48%\)$/);
  assert.equal(row(15).title, 'https://shop.example/', 'no title: its address (as Arcadia)');
  assert.deepEqual(Object.keys(row(12)).sort(), ['active', 'asleep', 'audible', 'behind', 'color', 'host', 'icon', 'id', 'kind', 'letter', 'loading', 'pinned', 'title', 'url']);
  assert.deepEqual([pin('pa').open, pin('pa').tabId, pin('pa').asleep, pin('pa').nested], [true, 11, true, true], 'a pin open in a sleeping tab');
  assert.deepEqual([pin('pb').open, pin('pb').tabId, pin('pb').active], [false, null, false], 'a pin not open');
  assert.deepEqual([pin('pc').active, pin('pc').folderId], [true, 'f2']);
  assert.equal(pin('pd').nested, false);
  assert.equal(pin('pd').title, 'Calendar');
  // A browser's icon given as data (Chrome can) counts; an address doesn't reach a theme.
  const withUrls = smallState();
  withUrls.tabs[14] = { ...withUrls.tabs[14], favIconUrl: 'https://nofav.example/icon.png' };
  withUrls.tabs[12] = { ...withUrls.tabs[12], favIconUrl: icon([1, 2, 3]).data };
  const vm2 = build(withUrls);
  assert.equal(vm2.space.today.find((t) => t.id === 14).icon, null, 'never a URL: only data: images reach m-icon');
  assert.equal(vm2.space.today.find((t) => t.id === 12).icon, withUrls.tabs[12].favIconUrl);
});

test('spaces, the active tab, the window, the archive', () => {
  const vm = build(smallState());
  assert.deepEqual(vm.spaces.map((s) => [s.id, s.abbr, s.active, s.tabCount, s.index]), [['home', 'HO', true, 5, 0], ['work', 'DW', false, 1, 1], ['side', 'SI', false, 0, 2]]);
  assert.deepEqual([vm.space.name, vm.space.emoji, vm.space.color, vm.space.abbr, vm.space.tabCount], ['Home', '🏠', '#6c5ce7', 'HO', 5]);
  assert.deepEqual([vm.tab.id, vm.tab.host, vm.tab.pinned, vm.tab.asleep, vm.tab.newTab], [13, 'docs.example', true, false, false], 'the window\'s active tab');
  assert.deepEqual(vm.window, { id: W, mode: 'inpage', focused: true, sidebar: 'hidden', sidebarOpen: false, peek: false, pinnedOpen: false });
  assert.deepEqual(ids(vm.archive), ['ar1', 'ar2'], 'newest first, as stored');
  assert.equal(vm.archive[1].title, 'https://news.example/b');
  assert.equal(vm.archive[0].icon, smallState().favicons['https://gone.example'].data);
  assert.equal(vm.hasArchive, true);
  assert.deepEqual(vm.platform, PLATFORM);
  assert.equal(vm.palette.open, false);
  assert.deepEqual(vm.palette.rows, []);
  // In a page: its own tab is the one in front, whatever the records say yet.
  const inPage = build(smallState(), { tabId: 14 });
  assert.equal(inPage.tab.id, 14);
  assert.deepEqual(inPage.space.today.filter((t) => t.active).map((t) => t.id), [14]);
  assert.equal(inPage.space.folders[1].hasShown, false, 'the closed folder\'s tab isn\'t in front now: it shows nothing');
  // The sidebar: the setting, unless the UI says (peek).
  assert.equal(build({ ...smallState(), settings: { sidebarPinnedOpen: true } }).window.sidebar, 'open');
  assert.deepEqual(build(smallState(), { sidebar: 'peek', mode: 'fullscreen' }).window, { id: W, mode: 'fullscreen', focused: true, sidebar: 'peek', sidebarOpen: false, peek: true, pinnedOpen: false });
});

test('the palette: shared/search.js ranks its rows; ids, the selection, no actions in the model', () => {
  const state = smallState();
  const ui = { windowId: W, palette: { open: true, query: 'docs', selected: 0 } };
  const vm = build(state, ui);
  const items = paletteItems(state, ui, PLATFORM);
  assert.deepEqual(ids(vm.palette.rows), ids(items));
  assert.ok(vm.palette.rows.length > 1);
  assert.equal(vm.palette.rows[0].selected, true);
  assert.equal(vm.palette.selected, items[0].id);
  assert.equal(vm.palette.rows.filter((r) => r.selected).length, 1);
  assert.ok(vm.palette.rows.every((r) => !('action' in r)), 'what a row does stays in Margin');
  assert.equal(vm.palette.rows.find((r) => r.id === 'go').title, 'Search for “docs”');
  const last = build(state, { ...ui, palette: { ...ui.palette, selected: 99 } });
  assert.equal(last.palette.rows.at(-1).selected, true, 'the selection stays on a row');
  // Opened for a new tab: "+ New Tab" is the row highlighted.
  const fresh = build(state, { windowId: W, palette: { open: true, query: '', newTab: true } });
  assert.equal(fresh.space.newTab.active, true);
  assert.equal(fresh.space.folders[1].pins[0].active, false);
});

test('no state yet (a background that hasn\'t written it): an empty model, not ready', () => {
  for (const state of [null, {}, { spaces: [] }]) {
    const vm = build(state);
    assert.equal(vm.ready, false);
    assert.deepEqual(vm.spaces, []);
    assert.deepEqual(vm.space.today, []);
    assert.equal(vm.tab, null);
  }
  // Keys missing from what was read: filled in.
  const vm = build({ spaces: [{ id: 's', name: 'Solo', emoji: '', color: '#000' }] });
  assert.equal(vm.ready, true);
  assert.equal(vm.space.name, 'Solo');
});

test('space abbreviations', () => {
  assert.equal(abbreviate('Personal'), 'PE');
  assert.equal(abbreviate('Deep Work'), 'DW');
  assert.equal(abbreviate('  side   project  x '), 'SP');
  assert.equal(abbreviate('é'), 'É');
  assert.equal(abbreviate('🎨 Art'), '🎨A');
  assert.equal(abbreviate(''), '');
});

// --- Structural sharing --------------------------------------------------------

const allObjects = (value, out = []) => {
  if (value && typeof value === 'object') { out.push(value); for (const v of Object.values(value)) allObjects(v, out); }
  return out;
};

test('immutable: every object and list in the model is frozen', () => {
  const vm = build(smallState(), { palette: { open: true, query: '' } });
  for (const o of allObjects(vm)) assert.ok(Object.isFrozen(o));
});

test('sharing: the same state builds the same model, and a pin is one object wherever it\'s listed', () => {
  const state = smallState();
  const a = build(state);
  assert.equal(build(state, {}, a), a, 'nothing changed: the very same model');
  assert.equal(build(smallState(), {}, a), a, 'an equal state read again: the same model');
  assert.equal(a.space.pinned[1], a.space.pins[0]);
  assert.equal(a.space.pinned[0], a.space.folders[0]);
  assert.equal(a.space.folders[0].shown, a.space.folders[0].pins, 'open: shown is its list');
});

test('sharing: one tab retitled changes its row and what holds it, nothing else', () => {
  const state = smallState();
  const a = build(state);
  const b = build({ ...state, tabs: { ...state.tabs, 14: { ...state.tabs[14], title: 'Renamed' } } }, {}, a);
  assert.notEqual(b, a);
  assert.notEqual(b.space, a.space);
  assert.notEqual(b.space.today, a.space.today);
  const [r15, r14, r12] = b.space.today;
  assert.equal(r14.title, 'Renamed');
  assert.notEqual(r14, a.space.today[1]);
  assert.equal(r15, a.space.today[0]);
  assert.equal(r12, a.space.today[2]);
  for (const key of ['window', 'spaces', 'tab', 'archive', 'palette', 'settings', 'platform']) assert.equal(b[key], a[key], key);
  for (const key of ['pinned', 'folders', 'pins', 'newTab']) assert.equal(b.space[key], a.space[key], `space.${key}`);
});

test('sharing: a new tab, a folder opened, an icon learned, a space switched, the palette opened', () => {
  const state = smallState();
  const a = build(state);
  // A new tab: its row at the top, every other row the same object.
  const added = build({ ...state, tabs: { ...state.tabs, 30: { id: 30, windowId: W, index: 9, url: 'https://new.example/', title: 'New', favIconUrl: '', active: false, lastActive: 9 } }, tabSpace: { ...state.tabSpace, 30: 'home' } }, {}, a);
  assert.deepEqual(ids(added.space.today), [30, 15, 14, 12]);
  added.space.today.slice(1).forEach((row, i) => assert.equal(row, a.space.today[i]));
  assert.equal(added.space.pinned, a.space.pinned);
  assert.notEqual(added.spaces, a.spaces, 'the space\'s tab count');
  assert.equal(added.spaces[1], a.spaces[1]);
  // A folder opened: that folder, its list; the other folder, the loose pin and the tabs stay.
  const opened = build({ ...state, folders: state.folders.map((f) => (f.id === 'f2' ? { ...f, open: true } : f)) }, {}, a);
  assert.notEqual(opened.space.folders[1], a.space.folders[1]);
  assert.equal(opened.space.folders[1].pins, a.space.folders[1].pins, 'its pins are the same rows');
  assert.equal(opened.space.folders[0], a.space.folders[0]);
  assert.equal(opened.space.pinned[1], a.space.pinned[1]);
  assert.equal(opened.space.today, a.space.today);
  // An icon learned for one site: that row only.
  const learned = build({ ...state, favicons: { ...state.favicons, 'https://nofav.example': icon([5, 5, 5]) } }, {}, a);
  assert.notEqual(learned.space.today[1], a.space.today[1]);
  assert.ok(learned.space.today[1].icon);
  assert.equal(learned.space.today[0], a.space.today[0]);
  assert.equal(learned.space.today[2], a.space.today[2]);
  assert.equal(learned.space.pinned, a.space.pinned);
  // Another space: the two chips that changed, the third the same.
  const switched = build({ ...state, activeSpaceByWindow: { ...state.activeSpaceByWindow, [W]: 'work' } }, {}, a);
  assert.equal(switched.space.id, 'work');
  assert.notEqual(switched.spaces[0], a.spaces[0]);
  assert.notEqual(switched.spaces[1], a.spaces[1]);
  assert.equal(switched.spaces[2], a.spaces[2]);
  assert.equal(switched.archive, a.archive);
  // Back again: equal to the first model, row for row (rows from a model two steps back aren't kept, but match).
  const back = build(state, {}, switched);
  assert.deepEqual(back, a);
  // The palette: only it changes (not opened for a new tab).
  const palette = build(state, { palette: { open: true, query: 'mail' } }, a);
  assert.notEqual(palette.palette, a.palette);
  assert.equal(palette.space, a.space);
  assert.equal(palette.spaces, a.spaces);
  // Typing more: rows that stay are the same objects.
  const more = build(state, { palette: { open: true, query: 'mail' } }, palette);
  assert.equal(more, palette);
  const p2 = build(state, { palette: { open: true, query: 'mail', selected: 1 } }, palette);
  assert.notEqual(p2.palette.rows[0], palette.palette.rows[0], 'selection left it');
  assert.equal(p2.palette.rows.slice(2).every((r, i) => r === palette.palette.rows[i + 2]), true, 'rows the selection didn\'t touch');
});

test('sharing at 200 tabs: one title changes one row of 200', () => {
  const state = bigState();
  const a = buildViewModel({ state, ui: { windowId: WINDOW } });
  const id = a.space.today[50].id;
  const b = buildViewModel({ state: { ...state, tabs: { ...state.tabs, [id]: { ...state.tabs[id], title: 'x' } } }, ui: { windowId: WINDOW } }, a);
  const changed = b.space.today.filter((row, i) => row !== a.space.today[i]);
  assert.deepEqual(changed.map((r) => r.id), [id]);
  assert.equal(b.space.pinned, a.space.pinned);
  assert.equal(b.spaces, a.spaces);
});
