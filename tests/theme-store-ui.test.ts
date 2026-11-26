// Settings' Themes, the theme store in Margin.app (docs/THEME-STORE.md §4; ui/settings-form.ts storeFields, storePrompt,
// storeWords; ui/view-model.ts its category; ui/host-app.ts what goes to the app and what comes back): each store theme
// with what it is to this install, Try / Update / Report; Share on the person's own themes; only an id ever sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsFields, fieldsIn, storePrompt, storeRows, storeWords, storeKey, categoryOf, type SettingsField } from '../app/shared/ui/settings-form.ts';
import { buildViewModel, type UiState } from '../app/shared/ui/view-model.ts';
import { createAppHost } from '../app/shared/ui/host-app.ts';
import { smallState, W } from './ui/fixtures.ts';

const byId = (fields: SettingsField[]) => Object.fromEntries(fields.map((f) => [f.id, f]));
const ROWS = [
  { id: 'dusk', name: 'Dusk', description: 'Warm‮ and dark', version: '1.2.0', author: 'Ana', authorKey: '0123abcd', state: 'install' },
  { id: 'paper', name: 'Paper', description: '', version: '2.0.0', author: 'Bo', authorKey: 'ffffffff', state: 'update', installedVersion: '1.9.0' },
  { id: 'kept', name: 'Kept', description: '', version: '1.0.0', author: 'Cy', authorKey: '00000000', state: 'installed', installedVersion: '1.0.0' },
  { id: 'mine', name: 'Mine', description: '', version: '3.0.0', author: 'Me', authorKey: '11111111', state: 'yours' },
  { id: 'arcadia', name: 'Fake', version: '1.0.0', author: 'X', authorKey: '22222222', state: 'install' },
  { id: '../x', name: 'Bad', version: '1.0.0', author: 'X', authorKey: '22222222', state: 'install' },
  { id: 'odd', name: 'Odd', version: '1.0.0', author: 'X', authorKey: 'nothex!!', state: 'stolen' },
];
const FEATURES = { importThemes: true, themeStore: { state: 'ready', rows: ROWS }, userThemes: [
  { id: 'mine', name: 'Mine', version: '3.0.0', author: 'Me' },
  { id: 'linked', name: 'Linked', version: '1.0.0', author: 'Me', linked: true },
  { id: 'paper', name: 'Paper', version: '1.9.0', author: 'Bo', store: { version: '1.9.0', sha256: 'a'.repeat(64) } },
] };

test('Themes: none without the store (a browser\'s overlay); its words while loading, closed, refused', () => {
  assert.equal(settingsFields({}, { importThemes: true }).some((f) => f.id.startsWith('store')), false);
  const words = (themeStore: unknown) => byId(settingsFields({}, { themeStore })).storeRefresh;
  assert.match(words({}).status, /Loading the store’s themes/);
  assert.equal(words({ state: 'closed' }).status, 'The theme store isn’t open yet.');
  assert.deepEqual([words({ state: 'error', message: 'Margin can’t use the store’s list.' }).status, words({ state: 'error' }).error], ['Margin can’t use the store’s list.', true]);
  assert.equal(words({ state: 'ready', rows: [] }).status, 'No themes yet.');
  assert.equal(words({ state: 'ready', rows: ROWS.slice(0, 1) }).status, '1 theme.');
  assert.equal(byId(settingsFields({}, { themeStore: {} }, { status: { storeRefresh: { text: 'Loading…' } } })).storeRefresh.status, 'Loading…', 'a line of its own wins');
});

test('Themes: each store theme with what it is here: Try, Update to its version, installed, the person\'s own; bad rows left out', () => {
  const all = settingsFields({}, FEATURES);
  const f = byId(all);
  assert.deepEqual(storeRows(FEATURES.themeStore).map((r) => r.id), ['dusk', 'paper', 'kept', 'mine'], 'a built-in\'s id, a bad id, a state no store gives: left out');
  assert.equal(f['storeTheme:dusk'].label, '“Dusk” 1.2.0 · by Ana (0123abcd)');
  assert.equal(f['storeText:dusk'].label, 'Warm and dark', 'the store\'s words cleaned (no bidi marks)');
  assert.equal(f['storeTry:dusk'].label, 'Try “Dusk”');
  assert.equal(f['storeTry:dusk'].isButton, true);
  assert.equal(f['storeTheme:paper'].label, '“Paper” 2.0.0 · by Bo (ffffffff) · 1.9.0 installed');
  assert.equal(f['storeTry:paper'].label, 'Update “Paper” to 2.0.0');
  assert.match(f['storeTheme:kept'].label, / · installed$/);
  assert.equal(f['storeTry:kept'], undefined, 'installed: nothing to try');
  assert.match(f['storeTheme:mine'].label, /you have a theme of your own with this id/);
  assert.equal(f['storeTry:mine'], undefined, 'the person\'s own is never replaced from the store');
  assert.equal(f['storeReport:mine'], undefined);
  assert.equal(f['storeReport:dusk'].label, 'Report “Dusk”…');
  assert.equal(f['storeTheme:arcadia'], undefined);
  // All in Settings' Themes; the person's own themes stay in Appearance.
  for (const x of all.filter((x) => x.id.startsWith('store'))) assert.equal(categoryOf(x.id), 'themes', x.id);
  assert.deepEqual(fieldsIn(all, 'themes').map((x) => x.id).slice(0, 3), ['storeGroup', 'storeAbout', 'storeRefresh']);
  // A row's own line: its Try's status (what happened to it).
  const tried = byId(settingsFields({}, FEATURES, { status: { 'storeTry:dusk': { text: 'Downloading it…' } } }));
  assert.equal(tried['storeTry:dusk'].status, 'Downloading it…');
});

test('Appearance: Share on the person\'s own (a copy, linked), never on one from the store; a store one says so, and an update in Themes', () => {
  const f = byId(fieldsIn(settingsFields({}, FEATURES), 'appearance'));
  assert.equal(f['themeShare:mine'].label, 'Share “Mine”…');
  assert.equal(f['themeShare:linked'].label, 'Share “Linked”…');
  assert.equal(f['themeShare:paper'], undefined);
  assert.equal(f['userTheme:paper'].label, '“Paper” 1.9.0 · by Bo · from the theme store, 2.0.0 is in Themes');
  assert.equal(byId(settingsFields({}, { ...FEATURES, themeStore: false }))['themeShare:mine'], undefined, 'no store: no Share');
});

test('Report and Share ask first: a report\'s reasons as the store takes them; Share says what goes with it', () => {
  const report = storePrompt('storeReport:dusk', FEATURES)!;
  assert.equal(report.id, 'report-theme:dusk');
  assert.deepEqual(report.actions.map((a) => a.id), ['broken', 'offensive', 'impersonation', 'copied', 'cancel']);
  assert.equal(storePrompt('storeReport:nope', FEATURES), null);
  const share = storePrompt('themeShare:mine', FEATURES)!;
  assert.equal(share.id, 'share-theme:mine');
  assert.match(share.text, /its author, “Me”, from its theme\.json and an anonymous key of this Mac’s\. It’s reviewed before others can find it\./);
  assert.equal(storePrompt('themeShare:paper', FEATURES), null, 'one from the store: not the person\'s to share');
  assert.equal(storePrompt('removeTheme:mine', FEATURES), null);
});

test('what a store request came to, in Margin\'s words', () => {
  assert.deepEqual(storeWords({ key: 'themeShare:mine', ok: true, data: { status: 'review', version: '1.0.0' } }), { text: 'Shared 1.0.0: it’s waiting for review before others can find it.', error: false });
  assert.match(storeWords({ key: 'themeShare:mine', ok: true, data: { status: 'published', version: '1.0.0' } }).text, /others can find it in Themes now/);
  assert.equal(storeWords({ key: 'themeShare:mine', ok: true, data: { status: 'rejected' } }).error, true);
  assert.equal(storeWords({ key: 'themeShare:mine', ok: true, data: { status: 'review', version: '<b>' } }).text, 'Shared: it’s waiting for review before others can find it.', 'a version not of its shape: left out');
  assert.equal(storeWords({ key: 'storeReport:dusk', ok: true, data: { reported: true, again: true } }).text, 'You reported it already.');
  assert.deepEqual(storeWords({ key: 'storeTry:dusk', ok: false, message: 'The theme store doesn’t have that.' }), { text: 'The theme store doesn’t have that.', error: true });
  assert.equal(storeWords({ key: 'storeTry:dusk', ok: false }).text, 'The theme store didn’t answer: try again later.');
  assert.ok(storeKey('storeTry:dusk') && storeKey('themeShare:mine') && !storeKey('themeImport') && !storeKey('storeTry:../x') && !storeKey('theme:dusk'));
});

test('the Settings page: Themes is a category only where the store is offered; asked for elsewhere, Appearance', () => {
  const state = { ...smallState(), settings: { ...smallState().settings, theme: 'arcadia' } };
  const vm = (ui: UiState, features: Record<string, unknown>) => buildViewModel({ state, ui: { windowId: W, launcherPage: true, settingsPage: true, settingsNav: true, ...ui }, platform: { browser: 'safari', os: 'mac', features } });
  const app = vm({ settingsCategory: 'themes' }, FEATURES);
  assert.deepEqual(app.settingsTab!.categories.map((c) => c.id), ['appearance', 'themes', 'tabs', 'browsing', 'keyboard']);
  assert.equal(app.settingsTab!.current.id, 'themes');
  assert.ok(app.settingsTab!.categories.find((c) => c.id === 'themes')!.isThemes);
  assert.ok(app.settingsForm!.fields.some((f) => f.id === 'storeTry:dusk') && !app.settingsForm!.fields.some((f) => f.id === 'theme'));
  const safari = vm({ settingsCategory: 'themes' }, { importThemes: false });
  assert.deepEqual(safari.settingsTab!.categories.map((c) => c.id), ['appearance', 'tabs', 'browsing', 'keyboard']);
  assert.equal(safari.settingsTab!.current.id, 'appearance');
});

test('the app host: the store\'s requests carry a theme\'s id only, in Margin\'s own window; its answers kept and passed on', async () => {
  const posts: Record<string, any>[] = [];
  const got: any[] = [];
  const hello = { windowId: W, profile: 'P1', browser: 'safari', mode: 'fullscreen', host: 'app-window', platform: { browser: 'safari', os: 'mac', app: true }, state: null, windows: [], theme: null, themes: [] };
  const host = createAppHost({ hello, post: async (op: string, body: Record<string, any> = {}) => { posts.push({ op, ...body }); return null; }, onMessage: (m) => got.push(m) });
  const told = (): any => host.themeStore;
  assert.deepEqual(told(), {}, 'offered, nothing told yet');
  assert.equal(host.perform('theme.store.open'), true);
  assert.equal(host.perform('theme.store.try', { id: 'dusk', url: 'https://evil.example/x', sha256: 'f'.repeat(64) }), true);
  assert.equal(host.perform('theme.store.try', { id: '../x' }), false);
  assert.equal(host.perform('theme.share', { id: 'mine' }), true);
  assert.equal(host.perform('theme.save', { value: { format: 2, id: 'dusk' }, store: true }), true);
  host.perform('prompt', { id: 'report-theme:dusk', action: 'cancel' });
  host.perform('prompt', { id: 'report-theme:dusk', action: 'boring' });
  host.perform('prompt', { id: 'report-theme:dusk', action: 'broken' });
  host.perform('prompt', { id: 'share-theme:mine', action: 'cancel' });
  host.perform('prompt', { id: 'share-theme:mine', action: 'share' });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(posts.filter((p) => p.op === 'perform').map((p) => [p.name, p.arg]), [
    ['theme.store.open', null], ['theme.store.try', { id: 'dusk' }], ['theme.share', { id: 'mine' }],
    ['theme.save', { value: { format: 2, id: 'dusk' }, store: true }],
    ['theme.store.report', { id: 'dusk', reason: 'broken' }], ['theme.share', { id: 'mine' }],
  ]);
  assert.deepEqual(got.map((m) => [m.type, m.key]), [['themeStoreBusy', 'storeReport:dusk'], ['themeStoreBusy', 'themeShare:mine']]);
  host.receive({ type: 'themeStore', state: 'ready', rows: ROWS });
  assert.equal(told().state, 'ready');
  assert.equal(told().rows.length, ROWS.length);
  assert.equal(got.at(-1).type, 'themeStore', 'the overlay hears it too');
  host.receive({ type: 'themeStore', state: 'hacked' });
  assert.equal(told().state, 'ready', 'a state no app sends: ignored');
  host.destroy();
  // Over a browser (a copy's overlay): no store.
  const over = createAppHost({ hello: { ...hello, host: undefined }, post: async () => null });
  assert.equal(over.themeStore, false);
  assert.equal(over.perform('theme.store.open'), false);
  over.destroy();
});
