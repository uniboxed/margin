// Spaces across browser profiles (Margin 2, Phase 2 step 4): what Margin.app
// sends each overlay (`across`, shared/across.ts), the view model's chips and
// profiles, the actions and menus for another profile's spaces, the app
// host's routing of them to the app, the palette, and the extension's side of
// the switch (state/model.ts spaceWindowTabs, orderSpaces). The app's order
// and the switch itself are tested in Swift (npm run test:app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acrossOf, foreignKey, foreignSpace, isMultiProfile, orderedSpaces } from '../extension/shared/across.ts';
import { buildViewModel, paletteItems } from '../extension/ui/view-model.ts';
import { checkAction, contextFromState, createDispatcher, requestFor } from '../extension/ui/actions.ts';
import { menuItems } from '../extension/ui/behaviors/menu-items.ts';
import { createAppHost } from '../extension/ui/host-app.ts';
import { toStorage } from '../extension/shared/stored.ts';
import * as M from '../extension/state/model.ts';
import { smallState, W } from './ui/fixtures.ts';

const HERE = 's-default';
const WORK = 's-1111';
// As the app sends it: this window's profile has home, work, side; another profile (Work) has two spaces between.
const rawAcross = (extra = {}) => ({
  v: 1,
  profile: HERE,
  profiles: [
    { id: HERE, name: 'Default', emoji: '', color: '#6c5ce7', named: false, here: true, linked: true, stale: false, lastSeen: 1, spaces: 3 },
    { id: WORK, name: 'Job', emoji: '💼', color: '#00b894', named: true, here: false, linked: false, stale: false, lastSeen: 1, spaces: 2 },
  ],
  spaces: [
    { profile: HERE, id: 'home', name: 'Home', emoji: '🏠', color: '#6c5ce7', tabCount: 6 },
    { profile: WORK, id: 'home', name: 'Office', emoji: '🏢', color: '#0984e3', tabCount: 4 },
    { profile: WORK, id: 'mail', name: 'Mail', emoji: '✉️', color: '#e17055', tabCount: 1 },
    { profile: HERE, id: 'work', name: 'Deep Work', emoji: '💼', color: '#0984e3', tabCount: 1 },
    { profile: HERE, id: 'side', name: 'Side', emoji: '🎨', color: '#00b894', tabCount: 0 },
  ],
  ...extra,
});
const withAcross = (raw = rawAcross()) => ({ ...smallState(), across: acrossOf(raw) });
const build = (state, ui = {}) => buildViewModel({ state, ui: { windowId: W, ...ui }, platform: { browser: 'safari', os: 'mac' } });

test('across: checked as it comes; one profile with spaces is not "several"', () => {
  assert.equal(acrossOf(null), null);
  assert.equal(acrossOf({ profile: 3, spaces: [] }), null);
  const a = acrossOf({ ...rawAcross(), profiles: [{ id: HERE, name: 'x'.repeat(99), color: 'red' }, 'nope'], spaces: [...rawAcross().spaces, { id: 'no-profile' }] });
  assert.equal(a.profiles.length, 1);
  assert.equal(a.profiles[0].name.length, 40);
  assert.equal(a.profiles[0].color, '', 'only #hex colors');
  assert.equal(a.spaces.length, 5);
  assert.equal(isMultiProfile(a), true);
  assert.equal(isMultiProfile(acrossOf({ ...rawAcross(), spaces: rawAcross().spaces.filter((s) => s.profile === HERE) })), false);
});

test('across: another profile\'s space has a chip id of its own, stable, apart from same-named ids, and found again', () => {
  const k = foreignKey(WORK, 'home');
  assert.match(k, /^x:[0-9a-z]+:[0-9a-z]+$/);
  assert.ok(k.length <= 64);
  assert.equal(k, foreignKey(WORK, 'home'));
  assert.notEqual(k, foreignKey(HERE, 'home'));
  assert.notEqual(k, foreignKey(WORK, 'mail'));
  const a = acrossOf(rawAcross());
  assert.deepEqual(foreignSpace(a, k), a.spaces[1]);
  assert.equal(foreignSpace(a, foreignKey(HERE, 'home')), null, 'this profile\'s own spaces are never foreign');
  assert.equal(foreignSpace(a, 'home'), null);
});

test('across: this profile\'s live spaces fill its places in the order; a new one goes after them; one profile: as it is', () => {
  const a = acrossOf(rawAcross());
  const own = [{ id: 'side' }, { id: 'home' }, { id: 'work' }, { id: 'fresh' }];
  const out = orderedSpaces(own, a).map((o) => (o.own ? o.space.id : `${o.entry.profile}/${o.entry.id}`));
  assert.deepEqual(out, ['side', `${WORK}/home`, `${WORK}/mail`, 'home', 'work', 'fresh']);
  assert.deepEqual(orderedSpaces([{ id: 'home' }], a).map((o) => (o.own ? o.space.id : o.entry.id)), ['home', 'home', 'mail'], 'a deleted one: its place goes');
  assert.deepEqual(orderedSpaces(own, null).map((o) => o.space.id), ['side', 'home', 'work', 'fresh']);
});

test('view model, one profile: the chips as before, no profile marks, no profiles', () => {
  const vm = build(smallState());
  assert.equal(vm.multiProfile, false);
  assert.deepEqual(vm.profiles, []);
  assert.equal(vm.profile, null);
  assert.deepEqual(vm.spaces.map((s) => [s.id, s.foreign, s.profileMark, s.profileStart, s.profile, s.label]), [
    ['home', false, false, false, null, 'Home'], ['work', false, false, false, null, 'Deep Work'], ['side', false, false, false, null, 'Side'],
  ]);
});

test('view model, several profiles: every space in the one order, another profile\'s marked, a divider where the profile changes', () => {
  const vm = build(withAcross());
  assert.equal(vm.multiProfile, true);
  assert.deepEqual(vm.profiles.map((p) => [p.id, p.name, p.initial, p.here]), [[HERE, 'Default', 'D', true], [WORK, 'Job', 'J', false]]);
  assert.equal(vm.profile.id, HERE);
  assert.deepEqual(vm.spaces.map((s) => [s.name, s.foreign, s.profileMark, s.profileStart, s.profile.id, s.index]), [
    ['Home', false, false, false, HERE, 0],
    ['Office', true, true, true, WORK, 1],
    ['Mail', true, true, false, WORK, 2],
    ['Deep Work', false, false, true, HERE, 3],
    ['Side', false, false, false, HERE, 4],
  ]);
  assert.equal(vm.spaces[1].id, foreignKey(WORK, 'home'));
  assert.equal(vm.spaces[1].label, 'Office · Job');
  assert.equal(vm.spaces[1].tabCount, 4, 'another profile\'s: its Margin tabs, from the app');
  assert.equal(vm.spaces.filter((s) => s.active).length, 1, 'only this window\'s own space is active');
  assert.equal(vm.spaces[0].active, true);
  assert.equal(vm.space.id, 'home');
  // Being switched to: marked; the app's words for a switch that needs the person are a notice.
  const going = build(withAcross(rawAcross({ switching: { profile: WORK, space: 'mail', phase: 'creating', notice: 'Open one of Job\'s windows.' } })));
  assert.deepEqual(going.spaces.map((s) => s.switching), [false, false, true, false, false]);
  assert.equal(going.notice.text, 'Open one of Job\'s windows.');
  assert.equal(build(withAcross(), { notice: { id: 'mine', text: 'Mine' } }).notice.id, 'mine', 'the runtime\'s own notice first');
});

test('view model: the profile editor uses the space editor\'s part; a profile\'s last space can\'t be deleted', () => {
  const vm = build(withAcross(), { editor: { profileId: WORK, name: 'Job', emoji: '💼', color: '#00b894' } });
  assert.equal(vm.editor.isProfile, true);
  assert.equal(vm.editor.labels.title, 'Edit profile');
  assert.equal(vm.editor.canDelete, false);
  const one = { ...withAcross(), spaces: [smallState().spaces[0]] };
  const ed = build(one, { editor: { spaceId: 'home', name: 'Home', emoji: '', color: '' } }).editor;
  assert.equal(ed.isProfile, false);
  assert.equal(ed.canDelete, false);
  assert.match(ed.deleteTitle, /profile’s last space/);
});

test('Safari\'s own names (step 9): marked as Safari\'s, its symbol\'s picture on the mark, and Edit Profile shows the name without changing it', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const raw = rawAcross();
  raw.profiles[1] = { ...raw.profiles[1], name: 'Personal', nameFrom: 'safari', symbol: PNG };
  const a = acrossOf(raw);
  assert.equal(a.profiles[1].nameFrom, 'safari');
  assert.equal(a.profiles[1].symbol, PNG);
  assert.equal(a.profiles[0].nameFrom, '', 'Margin\'s own name');
  const odd = acrossOf({ ...raw, profiles: [{ ...raw.profiles[1], nameFrom: 'chrome?', symbol: 'javascript:alert(1)' }, { ...raw.profiles[1], id: 'x', symbol: 'data:image/svg+xml;base64,PHN2Zz4=' }] });
  assert.equal(odd.profiles[0].nameFrom, '');
  assert.equal(odd.profiles[0].symbol, '', 'only a PNG data URL');
  assert.equal(odd.profiles[1].symbol, '', 'never an SVG');
  const vm = build({ ...smallState(), across: a });
  const work = vm.profiles.find((p) => p.id === WORK);
  assert.equal(work.fromBrowser, true);
  assert.equal(work.symbol, PNG);
  assert.equal(vm.profiles.find((p) => p.id === HERE).symbol, null);
  const chip = vm.spaces.find((s) => s.foreign);
  assert.equal(chip.profile.symbol, PNG, 'the chip\'s profile mark can draw it');
  const ed = build({ ...smallState(), across: a }, { editor: { profileId: WORK, name: 'Personal', emoji: '💼', color: '#00b894' } }).editor;
  assert.equal(ed.nameLocked, true);
  assert.match(ed.labels.note, /Safari’s.*Settings › Profiles/);
  const own = build(withAcross(), { editor: { profileId: WORK, name: 'Job', emoji: '💼', color: '#00b894' } }).editor;
  assert.equal(own.nameLocked, false);
  assert.equal(own.labels.note, '');
});

test('actions: another profile\'s space is a space; profiles are checked; the new actions map to the app or the copy', () => {
  const state = withAcross();
  const ctx = contextFromState(state);
  const k = foreignKey(WORK, 'mail');
  assert.equal(checkAction('space.switch', k, ctx).ok, true);
  assert.equal(checkAction('space.switch', foreignKey(WORK, 'nope'), ctx).ok, false);
  assert.equal(checkAction('profile.edit', WORK, ctx).ok, true);
  assert.equal(checkAction('profile.edit', 's-unknown', ctx).ok, false);
  assert.equal(checkAction('space.move', { space: k, dir: 1 }, ctx).ok, true);
  assert.equal(checkAction('space.move', { space: k, dir: 2 }, ctx).ok, false);
  assert.equal(checkAction('profile.edit', HERE, contextFromState(smallState())).ok, false, 'no profiles without the app');
  const ran = [];
  const dispatch = createDispatcher({ context: () => ctx, run: (n, a) => ran.push(n) });
  assert.equal(dispatch('profile.forget', WORK), false, 'forgetting is the menu\'s, with its confirmation');
  const req = (name, arg, s = state) => requestFor(name, arg, { state: s, ui: { windowId: W } });
  assert.deepEqual(req('space.switch', k), { kind: 'send', type: 'setSpace', payload: { windowId: W, spaceId: k } }, 'sent as any switch: the app host routes it');
  assert.deepEqual(req('space.move', { space: k, dir: -1 }), { kind: 'host', name: 'space.move', arg: { profile: WORK, space: 'mail', dir: -1 } });
  assert.deepEqual(req('space.move', { space: 'work', dir: 1 }), { kind: 'host', name: 'space.move', arg: { profile: HERE, space: 'work', dir: 1 } });
  assert.deepEqual(req('space.move', { space: 'work', dir: 1 }, smallState()), { kind: 'send', type: 'orderSpaces', payload: { spaceIds: ['home', 'side', 'work'] } }, 'one profile: its own order');
  assert.equal(req('space.move', { space: 'side', dir: 1 }, smallState()).kind, 'none');
  assert.deepEqual(req('space.newIn', HERE), { kind: 'send', type: 'createSpace', payload: { windowId: W } });
  assert.deepEqual(req('space.newIn', WORK), { kind: 'host', name: 'profile.space', arg: { profile: WORK, type: 'createSpace', payload: {} } });
  assert.deepEqual(req('profile.forget', WORK), { kind: 'host', name: 'profile.forget', arg: { profile: WORK } });
  assert.deepEqual(req('profile.edit', WORK), { kind: 'local', name: 'profile.edit', arg: WORK });
});

test('menus: another profile\'s space (switch, move, its profile, forget when it isn\'t open); this one\'s gains moves and its profile; "+" offers the others', () => {
  const state = withAcross();
  const labels = (target) => menuItems(target, { state, space: null }).filter((i) => !i.separator).map((i) => i.label);
  assert.deepEqual(labels({ kind: 'space', id: foreignKey(WORK, 'mail') }), ['Switch to Space', 'Move Left', 'Move Right', 'Edit Profile “Job”…', 'New Space in Job', 'Forget Job']);
  const linked = withAcross(rawAcross({ profiles: rawAcross().profiles.map((p) => ({ ...p, linked: true })) }));
  assert.ok(!menuItems({ kind: 'space', id: foreignKey(WORK, 'mail') }, { state: linked, space: null }).some((i) => i.action === 'profile.forget'), 'a profile that\'s open isn\'t forgotten');
  assert.deepEqual(labels({ kind: 'space', id: 'work' }), ['Edit Space…', 'Rename Space', 'Move Left', 'Move Right', 'New Space', 'Edit Profile “Default”…', 'Delete Space']);
  assert.deepEqual(labels({ kind: 'add' }), ['New Folder', 'New Space', 'New Space in Job']);
  assert.deepEqual(menuItems({ kind: 'space', id: 'work' }, { state: smallState(), space: null }).filter((i) => !i.separator).map((i) => i.label), ['Edit Space…', 'Rename Space', 'New Space', 'Delete Space'], 'one profile: as before');
});

test('the palette: another profile\'s spaces, named with their profile', () => {
  const rows = paletteItems(withAcross(), { windowId: W, palette: { open: true, query: 'office' } }, {});
  const row = rows.find((r) => r.id === `action:space:${foreignKey(WORK, "home")}`);
  assert.ok(row, JSON.stringify(rows.map((r) => r.id)));
  assert.equal(row.title, 'Switch to space Office (Job)');
  assert.deepEqual(row.action, { type: 'setSpace', windowId: W, spaceId: foreignKey(WORK, 'home') });
});

test('the app host: `across` from the hello and as it changes; another profile\'s space goes to the app, never the copy', async () => {
  const posts = [];
  const post = async (op, body = {}) => { posts.push({ op, ...body }); return op === 'send' ? JSON.stringify({ ok: true, result: {} }) : null; };
  const keys = ['spaces', 'pins', 'folders', 'archive', 'settings', 'tabs', 'tabSpace', 'activeSpaceByWindow', 'favicons'];
  const state = toStorage(smallState(), keys, { origin: 'o', since: 1, synced: true });
  const host = createAppHost({ hello: { windowId: W, profile: HERE, browser: 'safari', state, windows: [], across: rawAcross() }, post });
  assert.equal(host.getState().across.profiles.length, 2);
  const seen = [];
  host.onState((s) => seen.push(s));
  host.receive({ type: 'across', across: rawAcross({ switching: { profile: WORK, space: 'mail', phase: 'settling' } }) });
  assert.equal(seen.at(-1).across.switching.phase, 'settling');
  await host.send('setSpace', { windowId: W, spaceId: foreignKey(WORK, 'mail') });
  assert.deepEqual(posts.at(-1), { op: 'perform', name: 'profile.switch', arg: { profile: WORK, space: 'mail' } });
  await host.send('renameSpace', { spaceId: foreignKey(WORK, 'mail'), name: 'Post' });
  assert.deepEqual(posts.at(-1), { op: 'perform', name: 'profile.space', arg: { profile: WORK, type: 'renameSpace', payload: { spaceId: 'mail', name: 'Post' } } });
  await host.send('setSpace', { windowId: W, spaceId: 'work' });
  assert.equal(posts.at(-1).op, 'send', 'this profile\'s own: to its copy, as before');
  assert.equal(host.perform('profile.rename', { profile: WORK, name: 'Job' }), true);
  assert.deepEqual(posts.at(-1), { op: 'perform', name: 'profile.rename', arg: { profile: WORK, name: 'Job' } });
  host.receive({ type: 'across', across: null });
  assert.equal(host.getState().across, undefined, 'gone: one profile again');
});

test('the copy\'s side: a space\'s window opens its last used tab, the others that were open with it behind; the order across profiles', () => {
  let s = M.normalizeState({ ...smallState(), keptTabs: {} });
  const kept = (id, url, spaceId, lastActive, extra) => ({ id, url, title: url, spaceId, order: lastActive, lastActive, keptAt: 100, ...extra });
  s = {
    ...s,
    keptTabs: {
      't-aaaaaaaaaa': kept('t-aaaaaaaaaa', 'https://a.example/', 'work', 5, { why: 'window', from: { key: 'g1', at: 100, size: 3, index: 2 } }),
      't-bbbbbbbbbb': kept('t-bbbbbbbbbb', 'https://b.example/', 'work', 9, { why: 'window', from: { key: 'g1', at: 100, size: 3, index: 0 } }),
      't-cccccccccc': kept('t-cccccccccc', 'https://c.example/', 'work', 7, { why: 'window', from: { key: 'g1', at: 100, size: 3, index: 1 } }),
      't-dddddddddd': kept('t-dddddddddd', 'https://d.example/', 'work', 1, { why: 'sleep' }),
      't-eeeeeeeeee': kept('t-eeeeeeeeee', 'https://e.example/', 'side', 99, { why: 'window', from: { key: 'g1', at: 100, size: 3, index: 3 } }),
    },
  };
  const { front, rest } = M.spaceWindowTabs(s, 'work');
  assert.equal(front.id, 't-bbbbbbbbbb');
  assert.deepEqual(rest.map((k) => k.id), ['t-cccccccccc', 't-aaaaaaaaaa'], 'in their old order; not one put to sleep, not another space\'s');
  assert.deepEqual(M.spaceWindowTabs(s, 'home'), { front: null, rest: [] });
  const o = M.orderSpaces(s, ['side', 'home']);
  assert.deepEqual(o.spaces.map((x) => x.id), ['side', 'home', 'work']);
  assert.equal(M.orderSpaces(s, ['home', 'work', 'side']), s, 'nothing to change: the same state');
});
