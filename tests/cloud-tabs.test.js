// iCloud Tabs in Margin's UI (DECISIONS.md "Margin 2: iCloud Tabs"): what
// the app sends checked (shared/cloud-tabs.js), the folder's view model
// (ui/view-model.js cloudTabs), the palette's section (shared/search.js),
// the actions and the menu, the setting, and the app host taking them.
// The app's reader is tested in Swift against made-up databases
// (tools/app-tests/cloud-tabs-tests.swift); the folder drawn in both themes
// in tests/theme/cloud.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudOf, cloudShown, deviceNames, lastUsed, updatedText, onDevice, MAX_TABS } from '../extension/shared/cloud-tabs.js';
import { buildViewModel } from '../extension/ui/view-model.js';
import { rankPalette } from '../extension/shared/search.js';
import { checkAction, contextFromState, requestFor } from '../extension/ui/actions.js';
import { menuItems } from '../extension/ui/behaviors/menu-items.js';
import { settingsFields, saveField } from '../extension/ui/settings-form.js';
import { createAppHost } from '../extension/ui/host-app.js';
import { toStorage } from '../extension/shared/stored.js';
import { smallState, W, icon } from './ui/fixtures.js';
import { cloudFixture, PHONE, AIR, PAD } from './fixtures/cloud-tabs.js';

// Noon on a fixed day: "updated" words don't depend on when the tests run.
const NOON = new Date(2026, 10, 5, 12, 0, 0).getTime();
const MIN = 60_000;
const withCloud = (cloud = cloudOf(cloudFixture(NOON)), extra = {}) => {
  const s = smallState();
  return { ...s, cloudTabs: cloud, ...extra, settings: { ...s.settings, ...(extra.settings ?? {}) } };
};
const vmOf = (state, ui = {}, prev = null) => buildViewModel({ state, now: NOON, ui: { windowId: W, mode: 'fullscreen', ...ui }, platform: { browser: 'safari', os: 'mac' } }, prev);

// ---- what the app sends ----

test('cloudOf: the app\'s message checked: bad devices and tabs left out, only web pages, capped', () => {
  assert.equal(cloudOf(null), null);
  assert.equal(cloudOf({ status: 'sideways', devices: [] }), null, 'an unknown status: nothing');
  const tabs = Array.from({ length: MAX_TABS + 5 }, (_, i) => ({ id: `T${i}`, title: `Tab ${i}`, url: `https://x.example/${i}`, viewedAt: i }));
  const got = cloudOf({ status: 'ready', devices: [
    { id: 'D1', name: ' Phone\u0007 ', kind: 'phone', tabs: [
      { id: 'a', title: 'A', url: 'https://a.example/', pinned: true, viewedAt: 5 },
      { id: 'b', title: 'B', url: 'javascript:alert(1)' },
      { id: 'c', title: 'C', url: 'file:///etc/passwd' },
      { id: 'a', title: 'A again', url: 'https://a.example/2' },
      { id: '../x', title: 'Bad id', url: 'https://a.example/3' },
      { id: 'd', title: 'D', url: 'http://d.example/', pinned: 'yes', viewedAt: -1 },
    ] },
    { id: 'D1', name: 'Same id', kind: 'phone', tabs: [{ id: 'z', url: 'https://z.example/' }] },
    { id: 'D2', name: 'No tabs', kind: 'pad', tabs: [] },
    { id: 'D3', name: 'Many', kind: 'toaster', tabs },
    { id: 'bad id!', name: 'Bad', kind: 'mac', tabs: [{ id: 'q', url: 'https://q.example/' }] },
  ] });
  assert.deepEqual(got.devices.map((d) => d.id), ['D1', 'D3'], 'one device per id, none without tabs or with a bad id');
  assert.deepEqual(got.devices[0].tabs.map((t) => t.id), ['a', 'd'], 'web pages only, one tab per id');
  assert.equal(got.devices[0].name, 'Phone', 'control characters out, trimmed');
  assert.equal(got.devices[0].tabs[0].pinned, true);
  assert.equal(got.devices[0].tabs[1].pinned, false);
  assert.equal(got.devices[0].tabs[1].viewedAt, 0);
  assert.equal(got.devices[1].kind, 'other', 'an unknown kind: another device');
  assert.equal(got.devices[1].tabs.length, MAX_TABS);
  assert.deepEqual(cloudOf({ status: 'noAccess', devices: [{ id: 'D1', tabs: [{ id: 'a', url: 'https://a.example/' }] }] }), { status: 'noAccess', devices: [] });
});

test('cloudShown: only with the app\'s data, and not once Settings turn it off', () => {
  const cloud = cloudOf(cloudFixture(NOON));
  assert.equal(cloudShown(smallState()), null);
  assert.equal(cloudShown(withCloud(cloud)), cloud);
  assert.equal(cloudShown(withCloud(cloud, { settings: { showCloudTabs: false } })), null);
});

test('device names: Safari\'s, told apart when two read the same; "On …"', () => {
  const d = (id, name, kind, duplicateName = false) => ({ id, name, kind, duplicateName, tabs: [], model: '', modifiedAt: 0, ephemeral: false });
  const names = deviceNames([d('1', 'Tirth’s iPhone', 'phone'), d('2', 'Studio', 'mac'), d('3', 'studio', 'pad'), d('4', 'Studio', 'mac'), d('5', 'Work', 'mac', true), d('6', '', 'vision')]);
  assert.equal(names.get('1'), 'Tirth’s iPhone');
  assert.equal(names.get('2'), 'Studio (Mac)');
  assert.equal(names.get('3'), 'studio (iPad)');
  assert.equal(names.get('4'), 'Studio (Mac 2)');
  assert.equal(names.get('5'), 'Work (Mac)', 'Safari\'s own flag for a duplicate name');
  assert.equal(names.get('6'), 'Apple Vision Pro', 'no name: its kind');
  assert.equal(onDevice('Tirth’s iPhone'), 'On Tirth’s iPhone');
});

test('"updated …": to the minute from a tab viewed, to the day from Safari\'s day-rounded record', () => {
  assert.equal(updatedText(NOON - 20_000, true, NOON), 'updated just now');
  assert.equal(updatedText(NOON - 5 * MIN, true, NOON), 'updated 5 min ago');
  assert.equal(updatedText(NOON - 3 * 60 * MIN, true, NOON), 'updated 3 h ago');
  assert.equal(updatedText(NOON - 26 * 60 * MIN, true, NOON), 'updated yesterday');
  assert.equal(updatedText(NOON - 4 * 1440 * MIN, true, NOON), 'updated 4 days ago');
  const midnight = new Date(2026, 10, 5).getTime();
  assert.equal(updatedText(midnight, false, NOON), 'updated today');
  assert.equal(updatedText(midnight - 86_400_000, false, NOON), 'updated yesterday');
  assert.equal(updatedText(0, true, NOON), '');
  // lastUsed: the newest tab viewed if it's newer than the record, and a record at midnight is a day's.
  const dev = (modifiedAt, viewed) => ({ modifiedAt, tabs: viewed.map((v) => ({ viewedAt: v })) });
  assert.deepEqual(lastUsed(dev(midnight, [NOON - 5 * MIN, 1])), { at: NOON - 5 * MIN, exact: true });
  assert.deepEqual(lastUsed(dev(midnight, [0])), { at: midnight, exact: false });
  assert.deepEqual(lastUsed(dev(midnight + 1234, [0])), { at: midnight + 1234, exact: true }, 'a record not at midnight is taken as exact');
});

// ---- the folder ----

test('the folder: none without the app\'s data or with Settings off; the devices, their tabs, words and icons', () => {
  assert.equal(vmOf(smallState()).cloudTabs, null);
  assert.equal(vmOf(withCloud(undefined, { settings: { showCloudTabs: false } })).cloudTabs, null);
  const state = withCloud(undefined, { favicons: { ...smallState().favicons, 'https://margins.example': icon([1, 2, 3]) } });
  const c = vmOf(state).cloudTabs;
  assert.equal(c.open, true);
  assert.equal(c.ready, true);
  assert.equal(c.hasMessage, false);
  assert.equal(c.count, 6);
  assert.equal(c.labels.title, 'iCloud Tabs');
  assert.deepEqual(c.devices.map((d) => [d.name, d.label, d.isPhone, d.isMac, d.isPad]), [
    ['Tirth’s iPhone', 'On Tirth’s iPhone', true, false, false],
    ['Studio MacBook Air', 'On Studio MacBook Air', false, true, false],
    ['Kitchen iPad', 'On Kitchen iPad', false, false, true],
  ]);
  assert.deepEqual(c.devices.map((d) => d.updated), ['updated 5 min ago', 'updated yesterday', 'updated 10 days ago']);
  assert.deepEqual(c.devices.map((d) => d.stale), [false, false, true], 'not used for a week: dimmed');
  assert.equal(c.devices[0].describe, 'On Tirth’s iPhone, updated 5 min ago');
  const [ferry, essay, board] = c.devices[0].shown;
  assert.deepEqual([ferry.title, ferry.host, ferry.pinned, ferry.label], ['Ferry timetable – Tagus Lines', 'tagus.example', true, 'Ferry timetable – Tagus Lines, tagus.example, pinned on that device']);
  assert.ok(essay.icon?.startsWith('data:image/png'), 'an icon Margin has for the site');
  assert.equal(board.icon, null, 'none: a letter');
  assert.equal(board.letter, 'P');
  assert.ok(board.color.startsWith('hsl('));
});

test('the folder and each device close and stay closed (settings), shown at once', () => {
  const closed = vmOf(withCloud(undefined, { settings: { cloudTabsOpen: false } })).cloudTabs;
  assert.equal(closed.open, false);
  assert.equal(closed.labels.toggle, 'Show iCloud Tabs');
  assert.equal(closed.count, 6, 'the count stays on the closed folder');
  const one = vmOf(withCloud(undefined, { settings: { cloudTabsClosed: [AIR] } })).cloudTabs;
  assert.deepEqual(one.devices.map((d) => [d.open, d.shown.length, d.count]), [[true, 3, 3], [false, 0, 2], [true, 1, 1]]);
});

test('the folder\'s other states: no other devices, no Full Disk Access (its button), iCloud Tabs off, a Safari it can\'t read', () => {
  const of = (status, devices = []) => vmOf(withCloud(cloudOf({ status, devices }))).cloudTabs;
  const empty = of('ready');
  assert.deepEqual([empty.ready, empty.empty, empty.hasMessage, empty.canFix, empty.hasCount], [false, true, true, false, false]);
  assert.match(empty.message, /No tabs are open on your other devices/);
  const access = of('noAccess');
  assert.deepEqual([access.noAccess, access.canFix, access.labels.fix], [true, true, 'Open Full Disk Access']);
  assert.match(access.message, /Full Disk Access/);
  assert.match(of('noData').message, /No iCloud Tabs yet/);
  assert.equal(of('noData').canFix, false);
  assert.match(of('failed').message, /couldn’t read/);
});

test('live updates: a tab retitled on one device makes one new row; every other row and device is the same object', () => {
  const before = vmOf(withCloud());
  const raw = cloudFixture(NOON);
  raw.devices[0].tabs[1].title = 'Slow software, revised — Margins';
  const after = vmOf(withCloud(cloudOf(raw)), {}, before);
  const [b, a] = [before.cloudTabs, after.cloudTabs];
  assert.notEqual(a, b);
  assert.notEqual(a.devices[0], b.devices[0]);
  assert.equal(a.devices[0].shown[0], b.devices[0].shown[0], 'the row before it: the same');
  assert.notEqual(a.devices[0].shown[1], b.devices[0].shown[1]);
  assert.equal(a.devices[0].shown[2], b.devices[0].shown[2]);
  assert.equal(a.devices[1], b.devices[1], 'another device: the same object');
  assert.equal(a.devices[2], b.devices[2]);
  assert.equal(after.space, before.space, 'the sidebar\'s own rows: untouched');
  // Nothing new at all (the app sent the same again): the same model.
  assert.equal(vmOf(withCloud(cloudOf(cloudFixture(NOON))), {}, before).cloudTabs, before.cloudTabs);
});

// ---- the palette ----

test('the palette: before typing, no iCloud tabs; typed, their own section after Margin\'s own rows, per device, before the search', () => {
  const state = withCloud();
  const ctx = { windowId: W, tabId: 13, inNewTab: false, canToggleSidebar: true };
  assert.equal(rankPalette(state, '', ctx).some((i) => i.kind === 'cloud'), false);
  const rows = rankPalette(state, 'ferry', ctx);
  const kinds = rows.map((r) => r.kind);
  assert.deepEqual(rows.filter((r) => r.kind === 'cloud').map((r) => [r.title, r.section, r.sectionStart]), [
    ['Ferry timetable – Tagus Lines', 'On Tirth’s iPhone', true],
    ['Ferry fares – Tagus Lines', 'On Studio MacBook Air', true],
  ], 'the device with the best match first, each its own section');
  assert.equal(kinds.at(-1), 'go', '"Search for …" stays last');
  assert.ok(kinds.indexOf('cloud') > Math.max(-1, ...kinds.map((k, i) => (k === 'tab' || k === 'pin' || k === 'action' || k === 'archive' ? i : -1))), 'after Margin\'s own rows');
  const ferry = rows.find((r) => r.kind === 'cloud');
  assert.deepEqual(ferry.action, { type: 'newTab', windowId: W, url: 'https://tagus.example/ferries' }, 'opened as an address typed in: this window, its space');
  assert.equal(ferry.badge, 'iCloud');
  // Margin's new-tab page: there, in place.
  assert.deepEqual(rankPalette(state, 'ferry', { ...ctx, inNewTab: true }).find((r) => r.kind === 'cloud').action, { local: 'navigate', url: 'https://tagus.example/ferries' });
  // An address typed: "Open …" first, the iCloud tabs still after Margin's own.
  assert.equal(rankPalette(state, 'tagus.example', ctx)[0].kind, 'go');
  // A page open here already isn't offered from another device.
  const open = { ...state, tabs: { ...state.tabs, 30: { id: 30, windowId: W, index: 9, url: 'https://tagus.example/ferries', title: 'Ferries', active: false } }, tabSpace: { ...state.tabSpace, 30: 'home' } };
  assert.deepEqual(rankPalette(open, 'ferry', ctx).filter((r) => r.kind === 'cloud').map((r) => r.title), ['Ferry fares – Tagus Lines']);
  // Settings off, or no Full Disk Access: none.
  assert.equal(rankPalette(withCloud(undefined, { settings: { showCloudTabs: false } }), 'ferry', ctx).some((r) => r.kind === 'cloud'), false);
  assert.equal(rankPalette(withCloud(cloudOf({ status: 'noAccess', devices: [] })), 'ferry', ctx).some((r) => r.kind === 'cloud'), false);
});

test('the palette\'s rows in the view model: a section\'s heading on its first row; Margin\'s own rows have none', () => {
  const vm = vmOf(withCloud(), { palette: { open: true, query: 'ferry', selected: 0 } });
  const cloud = vm.palette.rows.filter((r) => r.kind === 'cloud');
  assert.deepEqual(cloud.map((r) => [r.section, r.sectionStart, r.goes]), [['On Tirth’s iPhone', true, true], ['On Studio MacBook Air', true, true]]);
  assert.ok(vm.palette.rows.filter((r) => r.kind !== 'cloud').every((r) => r.section === '' && r.sectionStart === false));
});

// ---- actions and the menu ----

test('actions: iCloud tabs and devices checked against what\'s shown; what each one asks for', () => {
  const state = withCloud();
  const ctx = contextFromState(state);
  assert.equal(checkAction('cloud.open', 'T-PHONE-1', ctx).ok, true);
  assert.equal(checkAction('cloud.open', 'T-NOPE', ctx).ok, false);
  assert.equal(checkAction('cloud.toggleDevice', PHONE, ctx).ok, true);
  assert.equal(checkAction('cloud.toggleDevice', 'T-PHONE-1', ctx).ok, false, 'a tab isn\'t a device');
  assert.equal(checkAction('cloud.toggle', undefined, ctx).ok, true);
  assert.equal(checkAction('cloud.toggle', 'x', ctx).ok, false);
  assert.equal(checkAction('cloud.open', 'T-PHONE-1', contextFromState(withCloud(undefined, { settings: { showCloudTabs: false } }))).ok, false, 'not shown: nothing to open');
  const ui = { windowId: W, sidebar: 'open' };
  assert.deepEqual(requestFor('cloud.toggle', undefined, { state, ui }), { kind: 'send', type: 'updateSettings', payload: { patch: { cloudTabsOpen: false } } });
  assert.deepEqual(requestFor('cloud.toggle', undefined, { state: withCloud(undefined, { settings: { cloudTabsOpen: false } }), ui }).payload, { patch: { cloudTabsOpen: true } });
  assert.deepEqual(requestFor('cloud.toggleDevice', AIR, { state, ui }).payload, { patch: { cloudTabsClosed: [AIR] } });
  // A device closed before and gone since is dropped; this one opens again.
  const closedBefore = withCloud(undefined, { settings: { cloudTabsClosed: ['GONE', AIR, PAD] } });
  assert.deepEqual(requestFor('cloud.toggleDevice', AIR, { state: closedBefore, ui }).payload, { patch: { cloudTabsClosed: [PAD] } });
  assert.deepEqual(requestFor('cloud.open', 'T-AIR-1', { state, ui }), { kind: 'local', name: 'palette.navigate', arg: { url: 'https://cloudrender.example/queue' } });
  assert.deepEqual(requestFor('cloud.copy', 'T-AIR-1', { state, ui }), { kind: 'host', name: 'copyText', arg: { text: 'https://cloudrender.example/queue' } });
  assert.deepEqual(requestFor('cloud.access', undefined, { state, ui }), { kind: 'host', name: 'cloud.access' });
});

test('an iCloud tab\'s menu: Open and Copy Link, nothing that would change the other device', () => {
  const state = withCloud();
  const items = menuItems({ kind: 'cloud', id: 'T-PAD-1' }, { state, space: null });
  assert.deepEqual(items.map((i) => [i.label, i.action, i.arg]), [['Open', 'cloud.open', 'T-PAD-1'], ['Copy Link', 'cloud.copy', 'T-PAD-1']]);
  assert.deepEqual(menuItems({ kind: 'cloud', id: 'T-NOPE' }, { state, space: null }), []);
  const vm = vmOf(state, { menu: { kind: 'cloud', id: 'T-PAD-1', x: 1, y: 2 } });
  assert.equal(vm.menu.label, 'iCloud Tab');
});

// ---- Settings ----

test('Settings: "Show iCloud Tabs" where Margin.app draws Safari\'s windows, on by default, saved as a toggle', () => {
  assert.equal(settingsFields({}, { cloudTabs: false }).some((f) => f.id === 'showCloudTabs'), false, 'not in Chrome and Edge (Phase 5)');
  const fields = settingsFields({}, { cloudTabs: true });
  const f = fields.find((x) => x.id === 'showCloudTabs');
  assert.equal(f.isToggle, true);
  assert.equal(f.checked, true);
  assert.match(f.label, /^Show iCloud Tabs/);
  assert.equal(fields.indexOf(f), fields.findIndex((x) => x.id === 'frameWhenHidden') + 1, 'with the sidebar\'s settings');
  assert.equal(settingsFields({ showCloudTabs: false }, { cloudTabs: true }).find((x) => x.id === 'showCloudTabs').checked, false);
  assert.deepEqual(saveField(f, false, {}), { type: 'updateSettings', payload: { patch: { showCloudTabs: false } } });
});

// ---- the app host ----

test('the app host: iCloud Tabs from the hello and as they change, the state\'s cloudTabs; its asks go to the app', () => {
  const posts = [];
  const post = async (op, body = {}) => { posts.push({ op, ...body }); return null; };
  const stored = toStorage(smallState(), ['spaces', 'pins', 'folders', 'archive', 'settings', 'tabs', 'tabSpace', 'activeSpaceByWindow', 'favicons'], { origin: 'safari-web-extension://margin', since: 1, synced: true });
  const hello = { windowId: W, profile: 'P1', browser: 'safari', mode: 'fullscreen', platform: { browser: 'safari', os: 'mac', app: true }, state: stored, windows: [], theme: null };
  const none = createAppHost({ hello, post });
  assert.equal(none.getState().cloudTabs, undefined, 'none sent: none');
  const host = createAppHost({ hello: { ...hello, cloudTabs: cloudFixture(NOON) }, post });
  assert.deepEqual(host.getState().cloudTabs.devices.map((d) => d.id), [PHONE, AIR, PAD]);
  const drawn = [];
  host.onState((s) => drawn.push(s));
  host.receive({ type: 'cloudTabs', cloudTabs: { status: 'noAccess', devices: [] } });
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0].cloudTabs.status, 'noAccess');
  host.receive({ type: 'cloudTabs', cloudTabs: null });
  assert.equal(host.getState().cloudTabs, undefined, 'the app stopped reading (Settings off): gone');
  assert.equal(host.perform('cloud.access'), true);
  assert.equal(host.perform('copyText', { text: 'https://tagus.example/ferries' }), true);
  assert.equal(host.perform('copyText', {}), false);
  assert.deepEqual(posts.filter((p) => p.op === 'perform'), [
    { op: 'perform', name: 'cloud.access', arg: null },
    { op: 'perform', name: 'copyText', arg: { text: 'https://tagus.example/ferries' } },
  ]);
});
