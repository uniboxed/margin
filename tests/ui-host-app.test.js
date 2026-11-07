// Margin.app's host adapter (extension/ui/host-app.js) against a stand-in
// for the app's bridge, and the app's overlay page build (dist/app, from
// app/overlay/). The app's own end is tested in Swift: npm run test:app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyChanges, createAppHost, hitRects, modeOf } from '../extension/ui/host-app.js';
import { toStorage } from '../extension/shared/stored.js';
import { buildViewModel } from '../extension/ui/view-model.js';
import { APP_FILES, buildApp } from '../scripts/build.js';
import { smallState, W } from './ui/fixtures.js';

const root = fileURLToPath(new URL('../', import.meta.url));

// The stored values as a copy sends them in its snapshot.
function stored(state = smallState()) {
  const keys = ['spaces', 'pins', 'folders', 'archive', 'settings', 'tabs', 'tabSpace', 'activeSpaceByWindow', 'favicons'];
  return toStorage(state, keys, { origin: 'safari-web-extension://margin', since: 1, synced: true });
}

// The app's side of the bridge: every post recorded, `send` answered.
function bridge(answer = (body) => JSON.stringify({ ok: true, result: { echoed: body.type } })) {
  const posts = [];
  return {
    posts,
    post: async (op, body = {}) => {
      posts.push({ op, ...body });
      return op === 'send' ? answer(body) : null;
    },
  };
}

const hello = (extra = {}) => ({ windowId: W, profile: 'P1', browser: 'safari', mode: 'fullscreen', platform: { browser: 'safari', os: 'mac', app: true }, state: stored(), windows: [{ windowId: W, state: 'fullscreen', focused: true }], theme: null, ...extra });

test('the app host: the state from the hello, in the pages\' shape, drawable', () => {
  const b = bridge();
  const host = createAppHost({ hello: hello(), post: b.post });
  const state = host.getState();
  assert.equal(host.windowId, W);
  assert.equal(host.tabId, null);
  assert.equal(host.mode, 'fullscreen');
  const { features, ...platform } = host.platform;
  assert.deepEqual(platform, { browser: 'safari', os: 'mac', app: true });
  // What Settings offers: the build's profile (Safari's in dist/app), as the new-tab page gave it.
  assert.deepEqual(Object.keys(features).sort(), ['blockGestures', 'cloudTabs', 'marginFullscreen', 'newTabHint', 'search', 'sleepTabs']);
  assert.equal(features.cloudTabs, true, 'Safari: Settings offer "Show iCloud Tabs"');
  assert.equal(state.tabs[13].title, 'Docs');
  assert.equal(state.activeSpaceByWindow[W], 'home');
  assert.deepEqual(state.openTabsBy, { origin: 'safari-web-extension://margin', since: 1, synced: true });
  const vm = buildViewModel({ state, ui: { windowId: W, mode: host.mode }, platform: host.platform });
  assert.equal(vm.space.name, 'Home');
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
  const state = host.getState();
  assert.equal(drawn.length, 2);
  assert.equal(state.tabs[12].title, 'Inbox (3)');
  assert.equal(state.archive, undefined, 'a key removed');
  assert.ok(state.favicons['https://new.example']);
  assert.equal(state.favicons['https://mail.example'], undefined);
  assert.ok(state.favicons['https://docs.example'], 'the other icons kept');
});

test('the app host: a window list changes the mode, and only then draws', () => {
  const host = createAppHost({ hello: hello(), post: bridge().post });
  const drawn = [];
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
  assert.equal(host.layout.insets.left, 300);
  assert.equal(host.perform('window.fullscreen'), true);
  assert.equal(b.posts.at(-1).op, 'perform');
  assert.equal(host.perform('nav.back'), false, 'history goes to the copy');
  assert.equal(host.perform('window.close'), false);
  assert.equal(host.perform('notice', { id: 'n', action: 'ok' }), true);
});

test('the app host: other messages are the page\'s; nothing after destroy', () => {
  const got = [];
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
  const el = (name, r, style = {}, children = []) => ({
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
  const getStyle = (e) => e.style;
  assert.deepEqual(hitRects(/** @type {any} */ (tree), slot, { getStyle }), { rects: [[380, 100, 520, 400]], all: false });
  const many = el('div', [0, 0, 1280, 800], {}, Array.from({ length: 70 }, (_, i) => el('b', [300 + i * 10, 100, 5, 5])));
  assert.deepEqual(hitRects(/** @type {any} */ (many), slot, { getStyle }), { rects: [], all: true });
});

test('dist/app is up to date with app/overlay and extension/ (run `npm run build`)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'margin-app-test-'));
  try {
    buildApp(tmp);
    assert.deepEqual(readdirSync(join(root, 'dist/app')).sort(), [...APP_FILES].sort());
    for (const f of APP_FILES) assert.ok(readFileSync(join(tmp, f)).equals(readFileSync(join(root, 'dist/app', f))), `dist/app/${f} is stale`);
    const js = readFileSync(join(tmp, 'overlay.js'), 'utf8');
    assert.match(js, /BUILD_TARGET="safari"/, 'Safari\'s profile');
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
  const { sanitizeTheme, checkPackage } = await import('../extension/ui/theme-loader.js');
  assert.deepEqual(checkPackage({ ...pkg, files: Object.fromEntries(Object.entries(pkg.files).map(([k, v]) => [k, new Uint8Array(Buffer.from(String(v), 'base64'))])) }), []);
  const r = sanitizeTheme({ ...pkg, files: Object.keys(pkg.files) });
  assert.deepEqual([r.errors, r.removed], [[], []]);
});
