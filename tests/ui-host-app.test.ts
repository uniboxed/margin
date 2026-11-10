// Margin.app's host adapter (extension/ui/host-app.ts) against a stand-in
// for the app's bridge, and the app's overlay page build (dist/app, from
// app/shared/host/). The app's own end is tested in Swift: npm run test:app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyChanges, createAppHost, hitRects, modeOf } from '../extension/ui/host-app.ts';
import { toStorage } from '../extension/shared/stored.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { APP_FILES, buildApp } from '../scripts/build.ts';
import { smallState, W } from './ui/fixtures.ts';
import type { State } from '../types/margin.d.ts';

// The state as pages read it (shared/stored.ts fromStorage): the stored state, and whose its tabs are.
type PageState = State & { openTabsBy: { origin: string, since: number, synced: boolean } | null };

const root = fileURLToPath(new URL('../', import.meta.url));

// The stored values as a copy sends them in its snapshot.
function stored(state: Parameters<typeof toStorage>[0] = smallState()) {
  const keys = ['spaces', 'pins', 'folders', 'archive', 'settings', 'tabs', 'tabSpace', 'activeSpaceByWindow', 'favicons'];
  return toStorage(state, keys, { origin: 'safari-web-extension://margin', since: 1, synced: true });
}

// The app's side of the bridge: every post recorded, `send` answered.
// (The posts: Margin's own messages, any as the link's are.)
function bridge(answer = (body: Record<string, any>) => JSON.stringify({ ok: true, result: { echoed: body.type } })) {
  const posts: Record<string, any>[] = [];
  return {
    posts,
    post: async (op: string, body: Record<string, any> = {}) => {
      posts.push({ op, ...body });
      return op === 'send' ? answer(body) : null;
    },
  };
}

const hello = (extra = {}) => ({ windowId: W, profile: 'P1', browser: 'safari', mode: 'fullscreen', platform: { browser: 'safari', os: 'mac', app: true }, state: stored(), windows: [{ windowId: W, state: 'fullscreen', focused: true }], theme: null, ...extra });

test('the app host: the state from the hello, in the pages\' shape, drawable', () => {
  const b = bridge();
  const host = createAppHost({ hello: hello(), post: b.post });
  const state = host.getState() as PageState; // the hello's whole state, as pages read it
  assert.equal(host.windowId, W);
  assert.equal(host.tabId, null);
  assert.equal(host.mode, 'fullscreen');
  const { features, ...platform } = host.platform;
  assert.deepEqual(platform, { browser: 'safari', os: 'mac', app: true });
  // What Settings offers: the build's profile (Safari's in dist/app), as the new-tab page gave it.
  assert.deepEqual(Object.keys(features).sort(), ['blockGestures', 'cloudTabs', 'importThemes', 'marginFullscreen', 'newTabHint', 'search', 'sleepTabs', 'switchSettings', 'userThemes']);
  assert.equal(features.importThemes, true, 'Margin.app imports themes');
  assert.deepEqual(features.userThemes, [], 'none imported in this hello');
  assert.equal(features.cloudTabs, true, 'Safari: Settings offer "Show iCloud Tabs"');
  assert.equal(features.switchSettings, null, 'one profile: no "Close windows to save memory" (tests/handoff-ui.test.ts)');
  assert.equal(state.tabs[13].title, 'Docs');
  assert.equal(state.activeSpaceByWindow[W], 'home');
  assert.deepEqual(state.openTabsBy, { origin: 'safari-web-extension://margin', since: 1, synced: true });
  const vm = buildViewModel({ state, ui: { windowId: W, mode: host.mode }, platform: host.platform });
  assert.equal(vm.space.name, 'Home');
});

test("the app host: the app's OS from its hello, the Mac's when it says none or something else", () => {
  const os = (platform: Record<string, unknown>) => createAppHost({ hello: hello({ platform }), post: bridge().post }).platform.os;
  assert.equal(os({ browser: 'edge', os: 'win', app: true }), 'win', 'Margin for Windows');
  assert.equal(os({ browser: 'safari', os: 'mac', app: true }), 'mac');
  assert.equal(os({ browser: 'safari', app: true }), 'mac', 'an older Margin.app');
  assert.equal(os({ browser: 'chrome', os: '<b>', app: true }), 'mac', 'only a known word');
});

test('the app host: no state yet, then a snapshot; changes and icons as diffs; each drawn', () => {
  const host = createAppHost({ hello: hello({ state: null }), post: bridge().post });
  assert.equal(host.getState(), null);
  const drawn = [];
  host.onState((s) => drawn.push(s));
  host.receive({ type: 'state', state: stored(), windows: [{ windowId: W, state: 'fullscreen' }] });
  assert.equal(drawn.length, 1);
  const open = structuredClone(stored().openTabs);
  open.tabs[12].title = 'Inbox (3)';
  host.receive({ type: 'changes', changes: { openTabs: { newValue: open }, archive: {} }, favicons: { set: { 'https://new.example': { data: 'data:image/png;base64,AA==' } }, del: ['https://mail.example'] } });
  const state = host.getState() as PageState; // the snapshot's, as pages read it
  assert.equal(drawn.length, 2);
  assert.equal(state.tabs[12].title, 'Inbox (3)');
  assert.equal(state.archive, undefined, 'a key removed');
  assert.ok(state.favicons['https://new.example']);
  assert.equal(state.favicons['https://mail.example'], undefined);
  assert.ok(state.favicons['https://docs.example'], 'the other icons kept');
});

test('the app host: a window list changes the mode, and only then draws', () => {
  const host = createAppHost({ hello: hello(), post: bridge().post });
  const drawn: (typeof host.mode)[] = [];
  host.onState(() => drawn.push(host.mode));
  host.receive({ type: 'windows', list: [{ windowId: W, state: 'fullscreen', focused: false }] });
  assert.deepEqual(drawn, []);
  host.receive({ type: 'windows', list: [{ windowId: W, state: 'normal' }] });
  assert.deepEqual(drawn, ['windowed']);
  assert.equal(modeOf({ state: 'fullscreen' }), 'fullscreen');
  assert.equal(modeOf({ state: 'maximized' }), 'windowed');
});

test('the app host: requests go to the app for this window, with a tab\'s hint; answers and failures', async () => {
  const b = bridge((body) => (body.type === 'fails' ? JSON.stringify({ ok: false, error: 'nope' }) : body.type === 'stale' ? JSON.stringify({ ok: false, stale: true }) : JSON.stringify({ ok: true, result: { echoed: body.type } })));
  const warned = [];
  const host = createAppHost({ hello: hello(), post: b.post, warn: (...a) => warned.push(a) });
  assert.deepEqual(await host.send('activateTab', { tabId: 12 }), { echoed: 'activateTab' });
  assert.deepEqual(b.posts[0], { op: 'send', type: 'activateTab', payload: { tabId: 12, hint: { url: 'https://mail.example/', index: 1, title: 'Mail', from: { origin: 'safari-web-extension://margin', since: 1, synced: true } } } });
  assert.equal(await host.send('fails'), undefined);
  assert.equal(await host.send('stale'), undefined);
  assert.equal(warned.length, 1, 'a refusal is noted, a stale copy is not');
  const broken = createAppHost({ hello: hello(), post: async () => { throw new Error('no app'); }, warn: () => {} });
  assert.equal(await broken.send('x'), undefined);
});

test('the app host: layout reports go to the app once per change; what only the app does', async () => {
  const b = bridge();
  const host = createAppHost({ hello: hello(), post: b.post });
  const g = { insets: { left: 260, top: 8, right: 8, bottom: 8 }, radius: 6, radii: [6, 6, 6, 6], outer: { left: 260, top: 8, right: 8, bottom: 8, radius: 6 }, container: { width: 1280, height: 800 } };
  host.reportLayout(g);
  host.reportLayout({ ...g });
  host.reportLayout({ ...g, insets: { ...g.insets, left: 300 } });
  assert.deepEqual(b.posts.filter((p) => p.op === 'layout').map((p) => p.geometry.insets.left), [260, 300]);
  assert.equal(host.layout!.insets.left, 300); // reported just above
  assert.equal(host.perform('window.fullscreen'), true);
  assert.equal(b.posts.at(-1)!.op, 'perform'); // one just posted
  assert.equal(host.perform('nav.back'), false, 'history goes to the copy');
  assert.equal(host.perform('window.close'), false);
  assert.equal(host.perform('notice', { id: 'n', action: 'ok' }), true);
});

test('the app host: other messages are the page\'s; nothing after destroy', () => {
  const got: string[] = [];
  const host = createAppHost({ hello: hello(), post: bridge().post, onMessage: (m) => got.push(m.type) });
  host.receive({ type: 'command', name: 'palette' });
  host.receive({ type: 'pointer', x: 1, y: 2 });
  host.receive(null);
  assert.deepEqual(got, ['command', 'pointer']);
  host.destroy();
  host.receive({ type: 'command' });
  assert.deepEqual(got, ['command', 'pointer']);
});

test('applyChanges leaves the old values alone', () => {
  const raw = { a: 1, favicons: { x: 1 } };
  const next = applyChanges(raw, { a: { newValue: 2 }, b: { newValue: null }, favicons: { newValue: {} } }, { set: { y: 2 } });
  assert.deepEqual(raw, { a: 1, favicons: { x: 1 } });
  assert.deepEqual(next, { a: 2, b: null, favicons: { x: 1, y: 2 } });
});

test('hitRects: what takes the pointer over the slot, boxes inside others left out', () => {
  // A stand-in for the overlay's elements: what hitRects reads of them.
  type FakeEl = { localName: string, children: FakeEl[], getBoundingClientRect: () => { left: number, top: number, right: number, bottom: number, width: number, height: number }, style: { pointerEvents: string, visibility: string } };
  const el = (name: string, r: number[], style: Partial<FakeEl['style']> = {}, children: FakeEl[] = []): FakeEl => ({
    localName: name, children,
    getBoundingClientRect: () => ({ left: r[0], top: r[1], right: r[0] + r[2], bottom: r[1] + r[3], width: r[2], height: r[3] }),
    style: { pointerEvents: 'auto', visibility: 'visible', ...style },
  });
  const slot = { left: 260, top: 8, right: 1272, bottom: 792 };
  const row = el('a', [400, 120, 300, 30]);
  const palette = el('div', [380, 100, 520, 400], {}, [row]);
  const tree = el('div', [0, 0, 1280, 800], {}, [
    el('m-page', [260, 8, 1012, 784]),
    el('aside', [0, 0, 260, 800]), // beside the slot
    el('div', [250, 0, 30, 800], { pointerEvents: 'none' }), // a shadow
    el('div', [300, 300, 50, 50], { visibility: 'hidden' }),
    palette,
    el('template', [0, 0, 1280, 800]),
  ]);
  const getStyle = (e: Element) => (e as unknown as FakeEl).style;
  assert.deepEqual(hitRects((tree as unknown as Element), slot, { getStyle }), { rects: [[380, 100, 520, 400]], all: false });
  const many = el('div', [0, 0, 1280, 800], {}, Array.from({ length: 70 }, (_, i) => el('b', [300 + i * 10, 100, 5, 5])));
  assert.deepEqual(hitRects((many as unknown as Element), slot, { getStyle }), { rects: [], all: true });
});

test('dist/app is up to date with app/shared/host and extension/ (run `npm run build`)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'margin-app-test-'));
  try {
    buildApp(tmp);
    assert.deepEqual(readdirSync(join(root, 'dist/app')).sort(), [...APP_FILES].sort());
    for (const f of APP_FILES) assert.ok(readFileSync(join(tmp, f)).equals(readFileSync(join(root, 'dist/app', f))), `dist/app/${f} is stale`);
    const js = readFileSync(join(tmp, 'overlay.js'), 'utf8');
    assert.ok(js.includes('name:"safari"') && !js.includes('name:"chrome"'), 'Safari\'s profile, only');
    assert.doesNotMatch(js, /\bimport\s*\(|importScripts|fetch\(/, 'one script, nothing loaded');
    assert.match(readFileSync(join(tmp, 'overlay.html'), 'utf8'), /<script src="overlay.js" defer><\/script>/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('dist/app/arcadia.js: Arcadia\'s package for the overlay to fall back on, as a theme message, passing every check', async () => {
  const text = readFileSync(join(root, 'dist/app/arcadia.js'), 'utf8');
  const m = /^\/\/[^\n]*\nglobalThis\.marginFallbackTheme = (\{[\s\S]*\});\n$/.exec(text);
  assert.ok(m, 'one assignment, nothing else');
  const pkg = JSON.parse(m[1]);
  assert.equal(pkg.id, 'arcadia');
  assert.deepEqual(Object.keys(pkg).sort(), ['css', 'files', 'html', 'id', 'manifest']);
  assert.equal(pkg.manifest, readFileSync(join(root, 'extension/themes/arcadia/theme.json'), 'utf8'));
  const { sanitizeTheme, checkPackage } = await import('../extension/ui/theme-loader.ts');
  assert.deepEqual(checkPackage({ ...pkg, files: Object.fromEntries(Object.entries(pkg.files).map(([k, v]) => [k, new Uint8Array(Buffer.from(String(v), 'base64'))])) }), []);
  const r = sanitizeTheme({ ...pkg, files: Object.keys(pkg.files) });
  assert.deepEqual([r.errors, r.removed], [[], []]);
});

test('the app host and themes: the index from the hello and `themes`; Import, a kept theme and Remove (only once its prompt says Remove) go to the app', async () => {
  const b = bridge();
  const got: string[] = [];
  const host = createAppHost({ hello: hello({ themes: [{ id: 'mine', name: 'Mine', version: '1.0.0' }] }), post: b.post, onMessage: (m) => got.push(m.type) });
  assert.deepEqual(host.userThemes.map((e) => e.id), ['mine']);
  assert.deepEqual(host.platform.features.userThemes, host.userThemes);
  host.receive({ type: 'themes', list: [] });
  assert.deepEqual(host.userThemes, []);
  host.receive({ type: 'themes', list: 'evil' });
  assert.deepEqual(host.userThemes, [], 'not a list: ignored');
  host.receive({ type: 'themeFile', kind: 'zip', zip: '' });
  assert.deepEqual(got, ['themeFile'], 'what the picker read goes to the overlay');
  const performed = () => b.posts.filter((p) => p.op === 'perform').map((p) => [p.name, p.arg]);
  assert.equal(host.perform('theme.import'), true);
  assert.equal(host.perform('theme.save', {}), false, 'no value');
  assert.equal(host.perform('theme.save', { value: { format: 2, id: 'mine' } }), true);
  host.perform('prompt', { id: 'remove-theme:mine', action: 'cancel' });
  host.perform('prompt', { id: 'remove-theme:../x', action: 'remove' });
  host.perform('prompt', { id: 'remove-theme:mine', action: 'remove' });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(performed(), [['theme.import', null], ['theme.save', { value: { format: 2, id: 'mine' } }], ['theme.remove', { id: 'mine' }]]);
  host.destroy();
});

// A profile switch hands the sidebar the person is looking at to the window the switch goes to (app/platforms/macos/shell
// Shell.handOverOverlay): the same page, given that window's hello in place (`rekey`), so nothing reloads.
test('the app host: handed to another window and profile (rekey): its window, state, mode and windows from the new hello', () => {
  const b = bridge();
  const host = createAppHost({ hello: hello(), post: b.post });
  let emitted = 0;
  host.onState(() => emitted++);
  const other = smallState();
  other.spaces = other.spaces.map((s) => (s.id === 'home' ? { ...s, name: 'Elsewhere' } : s));
  host.receive({ type: 'rekey', hello: hello({ windowId: 77, profile: 'P2', mode: 'fullscreen', state: stored({ ...other, activeSpaceByWindow: { 77: 'home' } }),
    windows: [{ windowId: 77, state: 'fullscreen', focused: true }], across: null }) });
  assert.equal(host.windowId, 77, 'its window now');
  assert.equal(host.mode, 'fullscreen');
  assert.equal(emitted, 1, 'drawn again once');
  const vm = buildViewModel({ state: host.getState(), ui: { windowId: host.windowId, mode: host.mode }, platform: host.platform });
  assert.equal(vm.space.name, 'Elsewhere', 'the new window\'s space and its profile\'s state');
  // A windows list naming the new window sets its mode; one naming only the old window doesn't.
  host.receive({ type: 'windows', list: [{ windowId: W, state: 'normal' }, { windowId: 77, state: 'fullscreen' }] });
  assert.equal(host.mode, 'fullscreen');
  // A rekey without a hello changes nothing.
  host.receive({ type: 'rekey' });
  assert.equal(host.windowId, 77);
});
