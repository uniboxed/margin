// Installed apps in the palette (Margin.app with `MarginHosted` on: docs/MARGIN-APP.md, phase 4): what the app
// sends checked (shared/apps.ts), their rows ranked among Margin's own (shared/search.ts), drawn (ui/view-model.ts),
// what picking one asks for (ui/actions.ts: `app.open`, the app's), and the app host taking the list and passing
// the ask on. The app's catalog is tested in Swift against fake bundles (app/platforms/macos/shell/tests/apps-tests.swift).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appsOf, MAX_APPS, type InstalledApp } from '../extension/shared/apps.ts';
import { rankPalette } from '../extension/shared/search.ts';
import { buildViewModel, type UiState } from '../extension/ui/view-model.ts';
import { checkAction, contextFromState, requestFor } from '../extension/ui/actions.ts';
import { createAppHost } from '../extension/ui/host-app.ts';
import { toStorage } from '../extension/shared/stored.ts';
import { smallState, W } from './ui/fixtures.ts';
import type { State } from '../types/margin.d.ts';

const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';
const APPS: InstalledApp[] = [
  { bundleId: 'com.apple.mail', name: 'Mail', icon: ICON },
  { bundleId: 'com.apple.Maps', name: 'Maps', icon: ICON },
  { bundleId: 'com.microsoft.VSCode', name: 'Visual Studio Code', icon: ICON },
  { bundleId: 'com.apple.dt.Xcode', name: 'Xcode', icon: ICON },
  { bundleId: 'com.apple.Notes', name: 'Notes', icon: null },
  { bundleId: 'com.apple.TextEdit', name: 'TextEdit', icon: ICON },
];
const ctx = { windowId: W, tabId: 13, inNewTab: false, canToggleSidebar: true, canFullscreen: false };
const withApps = (apps: InstalledApp[] | null = APPS) => ({ ...smallState(), apps }) as unknown as State;
const kinds = (rows: { kind: string }[]) => rows.map((r) => r.kind);

test('appsOf: the app\'s list checked: bad bundle ids, empty names and odd icons left out, one per bundle id, capped', () => {
  assert.equal(appsOf(null), null);
  assert.equal(appsOf({ apps: [] }), null, 'not a list: nothing');
  const got = appsOf([
    { bundleId: 'com.apple.mail', name: ' Mail\u0007 ', icon: ICON },
    { bundleId: 'COM.APPLE.MAIL', name: 'Mail again', icon: ICON },
    { bundleId: '../evil', name: 'Evil' },
    { bundleId: 'com.example.noname', name: '  ' },
    { bundleId: 'com.example.svg', name: 'Svg', icon: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { bundleId: 'com.example.js', name: 'Js', icon: 'javascript:alert(1)' },
    { bundleId: 'com.example.big', name: 'Big', icon: `data:image/png;base64,${'A'.repeat(70_000)}` },
    { bundleId: 'org.old_style.App', name: 'Old' },
    null, 'x',
  ])!;
  assert.deepEqual(got.map((a) => [a.bundleId, a.name, !!a.icon]), [
    ['com.apple.mail', 'Mail', true], ['com.example.svg', 'Svg', false], ['com.example.js', 'Js', false], ['com.example.big', 'Big', false], ['org.old_style.App', 'Old', false],
  ]);
  const many = Array.from({ length: MAX_APPS + 3 }, (_, i) => ({ bundleId: `com.example.a${i}`, name: `A ${i}` }));
  assert.equal(appsOf(many)!.length, MAX_APPS);
});

test('the palette: no apps before typing, for one letter, or with hosting off', () => {
  assert.equal(kinds(rankPalette(withApps(), '', ctx)).includes('app'), false);
  assert.equal(kinds(rankPalette(withApps(), 'm', ctx)).includes('app'), false);
  assert.equal(kinds(rankPalette(withApps(null), 'mail', ctx)).includes('app'), false, 'no list (hosting off): none');
  assert.equal(kinds(rankPalette(smallState() as unknown as State, 'mail', ctx)).includes('app'), false);
});

test('the palette: an app named in full ranks first, above a tab of the same name; its row', () => {
  const rows = rankPalette(withApps(), 'mail', ctx);
  assert.equal(rows[0].id, 'app:com:apple:mail');
  assert.ok(rows.some((r) => r.kind === 'tab' && r.title === 'Mail'), 'the tab is still offered');
  assert.equal(rows.at(-1)!.kind, 'go', '"Search for …" stays last');
  const { boost: _boost, ...row } = rows[0];
  assert.deepEqual(row, {
    id: 'app:com:apple:mail', kind: 'app', title: 'Mail', subtitle: '', favIconUrl: ICON, badge: 'App',
    action: { perform: 'app.open', arg: { bundleId: 'com.apple.mail', name: 'Mail' } },
  });
  // Case and spaces as typed don't matter.
  assert.equal(rankPalette(withApps(), '  VISUAL   studio code ', ctx)[0].id, 'app:com:microsoft:VSCode');
});

test('the palette: typed from a name\'s start, an app comes after a matching tab of this space but before other rows', () => {
  const rows = rankPalette(withApps(), 'ma', ctx);
  const at = (id: string) => rows.findIndex((r) => r.id === id);
  assert.ok(at('tab:12') >= 0 && at('app:com:apple:mail') > at('tab:12'), `the tab "Mail" first: ${rows.map((r) => r.id).join(', ')}`);
  assert.ok(at('app:com:apple:Maps') > 0);
});

test('the palette: only words of a name\'s start match, so ordinary queries aren\'t swamped; several words each one', () => {
  const ids = (q: string) => rankPalette(withApps(), q, ctx).filter((r) => r.kind === 'app').map((r) => r.id);
  assert.deepEqual(ids('code'), ['app:com:microsoft:VSCode'], 'Visual Studio Code by its word, not Xcode by its middle');
  assert.deepEqual(ids('xcode'), ['app:com:apple:dt:Xcode']);
  assert.deepEqual(ids('vis code'), ['app:com:microsoft:VSCode']);
  assert.deepEqual(ids('vis notes'), [], 'every word must match');
  assert.deepEqual(ids('ext'), [], 'not inside a word (TextEdit)');
  assert.deepEqual(ids('docs'), [], 'a tab\'s word: no app');
  assert.deepEqual(ids('nts'), [], 'no scattered letters');
  // At most five, the best first.
  const many = Array.from({ length: 12 }, (_, i) => ({ bundleId: `com.example.s${i}`, name: `Studio ${String.fromCharCode(65 + i)}`, icon: null }));
  const found = rankPalette(withApps(many), 'studio', ctx).filter((r) => r.kind === 'app');
  assert.equal(found.length, 5);
  // An address typed: "Open …" stays first.
  assert.equal(rankPalette(withApps([{ bundleId: 'com.example.ex', name: 'Example', icon: null }]), 'example.com', ctx)[0].kind, 'go');
});

test('the view model: an app\'s row has its icon, isApp and the go arrow; a row with no icon its letter', () => {
  const vm = buildViewModel({ state: withApps(), now: 0, ui: { windowId: W, mode: 'fullscreen', palette: { open: true, query: 'notes', selected: 0 } } as UiState, platform: { browser: 'safari', os: 'mac' } }, null);
  const notes = vm.palette.rows.find((r) => r.id === 'app:com:apple:Notes')!;
  assert.deepEqual([notes.isApp, notes.goes, notes.icon, notes.letter, notes.badge], [true, true, null, 'N', 'App']);
  const mail = buildViewModel({ state: withApps(), now: 0, ui: { windowId: W, mode: 'fullscreen', palette: { open: true, query: 'mail', selected: 0 } } as UiState, platform: { browser: 'safari', os: 'mac' } }, null).palette.rows[0];
  assert.equal(mail.icon, ICON);
  assert.equal(mail.isApp, true);
  assert.ok(vm.palette.rows.filter((r) => r.kind !== 'app').every((r) => r.isApp === false));
});

test('picking an app\'s row asks the app (app.open), checked like any row', () => {
  const state = withApps();
  const row = rankPalette(state, 'xcode', ctx).find((r) => r.kind === 'app')!;
  assert.equal(checkAction('palette.run', row.id, contextFromState(state, [row.id])).ok, true);
  assert.equal(row.id, 'app:com:apple:dt:Xcode', 'an id an action can take (no dots)');
  const long = `com.example.${'x'.repeat(80)}`;
  const longRow = rankPalette(withApps([{ bundleId: long, name: 'Long One', icon: null }]), 'long', ctx).find((r) => r.kind === 'app')!;
  assert.equal(checkAction('palette.run', longRow.id, contextFromState(state, [longRow.id])).ok, true, 'a bundle id too long for an id: hashed');
  assert.equal(longRow.action.arg.bundleId, long);
  assert.deepEqual(requestFor('palette.run', row.id, { state, ui: { windowId: W }, row }), { kind: 'host', name: 'app.open', arg: { bundleId: 'com.apple.dt.Xcode', name: 'Xcode' } });
});

test('the app host: the apps from the hello and as they change, the state\'s apps; app.open goes to the app with the bundle id only', () => {
  const posts: Record<string, any>[] = [];
  const post = async (op: string, body: Record<string, any> = {}) => { posts.push({ op, ...body }); return null; };
  const stored = toStorage(smallState(), ['spaces', 'pins', 'folders', 'archive', 'settings', 'tabs', 'tabSpace', 'activeSpaceByWindow', 'favicons'], { origin: 'safari-web-extension://margin', since: 1, synced: true });
  const hello = { windowId: W, profile: 'P1', browser: 'safari', mode: 'fullscreen', platform: { browser: 'safari', os: 'mac', app: true }, state: stored, windows: [], theme: null };
  assert.equal(createAppHost({ hello, post }).getState()!.apps, undefined, 'none sent (hosting off): none');
  assert.equal(createAppHost({ hello: { ...hello, apps: null }, post }).getState()!.apps, undefined);
  const host = createAppHost({ hello: { ...hello, apps: APPS }, post });
  assert.deepEqual(host.getState()!.apps.map((a: InstalledApp) => a.name), APPS.map((a) => a.name));
  const drawn: { apps?: InstalledApp[] }[] = [];
  host.onState((s) => drawn.push(s));
  host.receive({ type: 'apps', apps: [APPS[0]] });
  assert.equal(drawn.length, 1);
  assert.deepEqual(drawn[0].apps!.map((a) => a.bundleId), ['com.apple.mail']);
  // A switch's hand-over to another window keeps the Mac's list unless its hello says one.
  host.receive({ type: 'rekey', hello: { ...hello, windowId: W + 1 } });
  assert.deepEqual(host.getState()!.apps.map((a: InstalledApp) => a.bundleId), ['com.apple.mail']);
  host.receive({ type: 'apps', apps: null });
  assert.equal(host.getState()!.apps, undefined, 'hosting turned off: gone');
  assert.equal(host.perform('app.open', { bundleId: 'com.apple.mail', name: 'Mail' }), true);
  assert.equal(host.perform('app.open', { bundleId: '../x' }), false);
  assert.equal(host.perform('app.open', null), false);
  assert.deepEqual(posts.filter((p) => p.op === 'perform'), [{ op: 'perform', name: 'app.open', arg: { bundleId: 'com.apple.mail' } }]);
});
