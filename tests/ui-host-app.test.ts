// Margin.app's host adapter (app/shared/ui/host-app.ts) against a stand-in
// for the app's bridge, and the app's overlay page build (dist/app, from
// app/shared/host/). The app's own end is tested in Swift: npm run test:app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyChanges, chromeRects, cornerFill, createAppHost, hitRects, modeOf, sidebarFixed, splitShadows, type HitStyle } from '../app/shared/ui/host-app.ts';
import { toStorage } from '../extension/shared/stored.ts';
import { buildViewModel } from '../app/shared/ui/view-model.ts';
import { APP_FILES, BUILTIN_THEMES, buildApp, builtinThemeFile } from '../scripts/build.ts';
import { PACKAGE_THEMES } from '../app/shared/ui/themes/packages.ts';
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
  assert.deepEqual(Object.keys(features).sort(), ['blockGestures', 'haptics', 'importThemes', 'marginFullscreen', 'newTabHint', 'search', 'sleepTabs', 'spaceThemes', 'userThemes']);
  assert.equal(features.haptics, false, 'a browser\'s overlay plays no haptics (Edit Theme Color\'s ticks)');
  assert.equal((createAppHost({ hello: hello({ host: 'app-window' }), post: b.post }).platform.features as any).haptics, true, 'Margin.app\'s own window on the Mac does');
  assert.equal(features.spaceThemes, false, 'a browser\'s overlay draws its profile\'s theme');
  assert.equal((createAppHost({ hello: hello({ host: 'app-window' }), post: b.post }).platform.features as any).spaceThemes, true, 'Margin.app\'s own window draws each space\'s');
  assert.equal(features.importThemes, true, 'Margin.app imports themes');
  assert.deepEqual(features.userThemes, [], 'none imported in this hello');
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

test("the app host in Margin.app's window: a layout report sent as its JSON text when the app asks for that (`layoutText`), the same report", () => {
  const g = { insets: { left: 260, top: 8, right: 8, bottom: 8 }, radius: 6, radii: [6, 6, 6, 6], outer: { left: 260, top: 8, right: 8, bottom: 8, radius: 6 }, container: { width: 1512, height: 982 }, mode: 'fullscreen', fills: Array(4).fill('rgb(17, 17, 17)') };
  const asObject = bridge(), asText = bridge(), overBrowser = bridge();
  createAppHost({ hello: hello({ host: 'app-window' }), post: asObject.post }).reportLayout(g);
  createAppHost({ hello: hello({ host: 'app-window', layoutText: true }), post: asText.post }).reportLayout(g);
  createAppHost({ hello: hello({ layoutText: true }), post: overBrowser.post }).reportLayout(g);
  const sent = (b: ReturnType<typeof bridge>) => b.posts.filter((p) => p.op === 'layout');
  assert.equal(sent(asText).length, 1);
  assert.equal(sent(asText)[0].geometry, undefined);
  assert.deepEqual(JSON.parse(sent(asText)[0].json), sent(asObject)[0].geometry, 'the same report, as its JSON');
  assert.ok(sent(overBrowser)[0].geometry && sent(overBrowser)[0].json === undefined, 'over a browser: as it was');
});

test("the app host: a layout of another mode, or measured with the sidebar alone, reaches the app even at the same insets", () => {
  const b = bridge();
  const host = createAppHost({ hello: hello({ host: 'app-window', mode: 'windowed' }), post: b.post });
  const g = { insets: { left: 260, top: 8, right: 8, bottom: 8 }, radius: 6, radii: [6, 6, 6, 6], outer: { left: 260, top: 8, right: 8, bottom: 8, radius: 6 }, container: { width: 1512, height: 982 } };
  host.reportLayout({ ...g, mode: 'windowed' });
  // (Seen 2026-11-15: resized to the display before its mode was heard, the full-screen layout was dropped as the same.)
  host.reportLayout({ ...g, mode: 'fullscreen' });
  host.reportLayout({ ...g, mode: 'fullscreen' });
  host.receive({ type: 'pageOutside', on: true });
  host.reportLayout({ ...g, mode: 'fullscreen' });
  const sent = b.posts.filter((p) => p.op === 'layout').map((p) => [p.geometry.mode, p.geometry.pageOutside]);
  assert.deepEqual(sent, [['windowed', false], ['fullscreen', false], ['fullscreen', true]]);
});

test("the app host: Margin's own window's layout carries the colour around the page's corners, and a new colour or radii reach the app", () => {
  const b = bridge();
  const host = createAppHost({ hello: hello({ host: 'app-window', mode: 'fullscreen' }), post: b.post });
  const g = { insets: { left: 260, top: 8, right: 8, bottom: 8 }, radius: 6, radii: [6, 6, 6, 6], outer: { left: 260, top: 8, right: 8, bottom: 8, radius: 6 }, container: { width: 1512, height: 982 }, mode: 'fullscreen' };
  const grey = Array(4).fill('rgb(156, 157, 161)'), ink = Array(4).fill('rgb(17, 17, 17)');
  host.reportLayout({ ...g, fills: grey });
  host.reportLayout({ ...g, fills: [...grey] });
  host.reportLayout({ ...g, fills: ink }); // (another theme, its page area where it was)
  host.reportLayout({ ...g, radii: [15, 15, 15, 15], fills: ink });
  // (A report from the runtime's own frame, the box only: the colours as last said.)
  host.reportLayout({ ...g, radii: [15, 15, 15, 15], insets: { ...g.insets, left: 300 } });
  assert.deepEqual(b.posts.filter((p) => p.op === 'layout').map((p) => [p.geometry.fills[0], p.geometry.radii[0], p.geometry.insets.left, 'edge' in p.geometry]),
    [['rgb(156, 157, 161)', 6, 260, false], ['rgb(17, 17, 17)', 6, 260, false], ['rgb(17, 17, 17)', 15, 260, false], ['rgb(17, 17, 17)', 15, 300, false]]);
});

test("the app host in Margin's own window: the page card's state from the app (hello and `pageState`), the name of what's opening only while loading; none over a browser", () => {
  const b = bridge();
  const host = createAppHost({ hello: hello({ host: 'app-window', mode: 'fullscreen' }), post: b.post });
  let emits = 0;
  host.onState(() => { emits++; });
  assert.deepEqual([host.pageState, host.pageOpening, host.launcher], ['empty', null, true], 'nothing hosted: empty, the launcher');
  host.receive({ type: 'pageHosted', on: true });
  host.receive({ type: 'pageState', state: 'loading', label: 'Safari' });
  assert.deepEqual([host.pageState, host.pageOpening, host.launcher], ['loading', 'Safari', false]);
  const vm = buildViewModel({ state: host.getState() as any, ui: { windowId: W, mode: host.mode, pageOpening: { name: host.pageOpening ?? '' } }, platform: host.platform });
  assert.deepEqual(vm.pageLoader, { name: 'Safari', label: 'Opening Safari…', icon: null }, "Margin's own words around the name (no apps listed: no icon)");
  assert.equal(buildViewModel({ state: host.getState() as any, ui: { windowId: W, mode: host.mode, pageOpening: { name: '' } }, platform: host.platform }).pageLoader?.label, 'Opening…');
  assert.equal(buildViewModel({ state: host.getState() as any, ui: { windowId: W, mode: host.mode }, platform: host.platform }).pageLoader, null);
  const before = emits;
  host.receive({ type: 'pageState', state: 'loading', label: 'Safari' });
  assert.equal(emits, before, 'said again as it is: nothing drawn again');
  host.receive({ type: 'pageState', state: 'shown', label: 'Safari' });
  assert.deepEqual([host.pageState, host.pageOpening], ['shown', null], 'shown: no name kept');
  host.receive({ type: 'pageState', state: 'nonsense' });
  assert.equal(host.pageState, 'empty', 'anything else: empty');
  assert.equal(emits, before + 2);
  const started = createAppHost({ hello: hello({ host: 'app-window', mode: 'fullscreen', pageHosted: true, pageState: 'loading', pageOpening: 'Notes' }), post: b.post });
  assert.deepEqual([started.pageState, started.pageOpening], ['loading', 'Notes'], 'a page loaded again mid-open: its hello has it');
  const over = createAppHost({ hello: hello(), post: b.post });
  over.receive({ type: 'pageState', state: 'shown' });
  over.receive({ type: 'pageState', state: 'loading', label: 'Notes', bundleId: 'com.apple.Notes' });
  assert.equal(over.pageOpeningBundleId, null, '… nor an app to show the icon of');
  assert.equal(over.pageState, undefined, 'over a browser (the Windows shell): no page state');
});

test("the app host in Margin's own window: a split pane's loader (`paneLoading`): its item and name, checked; none over a browser", () => {
  const b = bridge();
  const host = createAppHost({ hello: hello({ host: 'app-window', mode: 'fullscreen' }), post: b.post });
  let emits = 0;
  host.onState(() => { emits++; });
  assert.equal(host.paneLoading, null);
  host.receive({ type: 'paneLoading', pane: { item: 't-notes1', label: 'Notes', bundleId: 'com.apple.Notes' } });
  assert.deepEqual(host.paneLoading, { item: 't-notes1', name: 'Notes', bundleId: 'com.apple.Notes' });
  assert.equal(emits, 1);
  host.receive({ type: 'paneLoading', pane: { item: 't-notes1', label: 'Notes', bundleId: 'com.apple.Notes' } });
  assert.equal(emits, 1, 'said again as it is: nothing drawn again');
  host.receive({ type: 'paneLoading', pane: { item: '<b>', label: 'x', bundleId: 'com.apple.Notes' } });
  assert.equal(host.paneLoading, null, 'an item id that isn\'t one: none');
  host.receive({ type: 'paneLoading', pane: { item: 't-a', label: 'x'.repeat(500), bundleId: '../evil' } });
  const cut = host.paneLoading as { name: string, bundleId: string | null } | null;
  assert.deepEqual([cut?.name.length, cut?.bundleId], [120, null], 'its name cut, a bundle id checked');
  host.receive({ type: 'paneLoading', pane: null });
  assert.equal(host.paneLoading, null);
  const again = createAppHost({ hello: hello({ host: 'app-window', mode: 'fullscreen', paneLoading: { item: 't-b', label: 'Safari', bundleId: 'com.apple.Safari' } }), post: b.post });
  assert.deepEqual(again.paneLoading, { item: 't-b', name: 'Safari', bundleId: 'com.apple.Safari' }, 'a page loaded again mid-open: its hello has it');
  const over = createAppHost({ hello: hello(), post: b.post });
  over.receive({ type: 'paneLoading', pane: { item: 't-a', label: 'Notes' } });
  assert.equal(over.paneLoading, null, 'over a browser: none');
});
test("the app host in Margin's own window: a split's cut panes (`paneCut`): each side a slide, checked; an arrow sent only for a side the pane has", () => {
  const b = bridge();
  const host = createAppHost({ hello: hello({ host: 'app-window', mode: 'fullscreen' }), post: b.post });
  host.receive({ type: 'paneCut', panes: { 't-notes1': { window: 20, right: 'slide', left: 'reveal', revealed: true }, '<b>': { window: 3, left: 'slide' } } });
  assert.deepEqual(host.paneCuts, { 't-notes1': { window: 20, right: 'slide' } }, 'only slides, no other word kept; an item id that isn\'t one: none');
  assert.equal(host.perform('split.slide', { item: 't-notes1', side: 'right' }), true);
  assert.equal(host.perform('split.slide', { item: 't-notes1', side: 'left' }), false, 'a side it doesn\'t have');
  assert.equal(host.perform('split.slide', { item: 't-notes1', side: 'back' }), false, 'no reveal to put back');
  assert.equal(host.perform('split.slide', { item: 't-other', side: 'right' }), false, 'not a cut pane');
  assert.deepEqual(b.posts.filter((p) => p.op === 'perform').map((p) => [p.name, p.arg]), [['split.slide', { item: 't-notes1', side: 'right' }]]);
  host.receive({ type: 'paneHover', window: 20 });
  assert.equal(host.paneHover, 20);
  host.receive({ type: 'paneCut', panes: {} });
  assert.deepEqual([host.paneCuts, host.paneHover], [{}, null], 'none cut: none hovered');
  const over = createAppHost({ hello: hello(), post: b.post });
  over.receive({ type: 'paneCut', panes: { 't-a': { window: 2, right: 'slide' } } });
  assert.deepEqual(over.paneCuts, {}, 'over a browser: none');
});

test("the app host in Margin's own window: every app's known minimum (`appMin`, `web` for Safari's pages), checked; in its hello; none over a browser", () => {
  const b = bridge();
  const host = createAppHost({ hello: hello({ host: 'app-window', mode: 'fullscreen' }), post: b.post });
  let emits = 0;
  host.onState(() => { emits++; });
  assert.deepEqual(host.appMinimums, {});
  host.receive({ type: 'appMin', apps: { web: [574, 220], 'com.apple.Notes': [700.2, 400] } });
  assert.deepEqual(host.appMinimums, { web: [574, 220], 'com.apple.Notes': [701, 400] });
  assert.equal(emits, 1);
  host.receive({ type: 'appMin', apps: { web: [574, 220], 'com.apple.Notes': [701, 400] } });
  assert.equal(emits, 1, 'said again as it is: nothing drawn again');
  host.receive({ type: 'appMin', apps: { '<b>': [1, 1], web: [-5, 1e9], x: 'no' } });
  assert.deepEqual(host.appMinimums, { web: [0, 0] }, 'a key that isn\'t one, a size that isn\'t sane: dropped or nothing');
  const again = createAppHost({ hello: hello({ host: 'app-window', mode: 'fullscreen', appMin: { web: [574, 220] } }), post: b.post });
  assert.deepEqual(again.appMinimums, { web: [574, 220] }, 'a page loaded again: its hello has them');
  const over = createAppHost({ hello: hello(), post: b.post });
  over.receive({ type: 'appMin', apps: { web: [574, 220] } });
  assert.deepEqual(over.appMinimums, {}, 'over a browser: none');
});

test("the app host in Margin's own window: a web item's picture for its card (`pagePicture`), only a picture's data URL, only while `elsewhere`; none over a browser", () => {
  const b = bridge();
  const host = createAppHost({ hello: hello({ host: 'app-window', mode: 'fullscreen' }), post: b.post });
  let emits = 0;
  host.onState(() => { emits++; });
  const shot = 'data:image/jpeg;base64,QUJD';
  host.receive({ type: 'pagePicture', data: shot });
  assert.equal(host.pagePicture, null, 'not elsewhere yet: none drawn');
  assert.equal(emits, 0, '… and nothing drawn again for it');
  host.receive({ type: 'pageState', state: 'elsewhere', label: 'Example' });
  assert.equal(host.pagePicture, shot, 'elsewhere: the picture the app sent');
  host.receive({ type: 'pagePicture', data: shot });
  const before = emits;
  for (const odd of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGI+', 'data:image/jpeg;base64,QU"onload=x', 42]) {
    host.receive({ type: 'pagePicture', data: odd });
    assert.equal(host.pagePicture, null, `not a JPEG or PNG data URL: none (${String(odd).slice(0, 30)})`);
  }
  host.receive({ type: 'pagePicture', data: 'data:image/png;base64,' + 'A'.repeat(9 * 1024 * 1024) });
  assert.equal(host.pagePicture, null, 'too large: none');
  host.receive({ type: 'pagePicture', data: shot });
  assert.equal(host.pagePicture, shot);
  assert.ok(emits > before);
  host.receive({ type: 'pageState', state: 'shown' });
  assert.equal(host.pagePicture, null, 'shown: none');
  const again = createAppHost({ hello: hello({ host: 'app-window', mode: 'fullscreen', pageHosted: false, pageState: 'elsewhere', pageOpening: 'Example', pagePicture: shot }), post: b.post });
  assert.equal(again.pagePicture, shot, 'a page loaded again while elsewhere: its hello has it');
  const over = createAppHost({ hello: hello(), post: b.post });
  over.receive({ type: 'pageState', state: 'elsewhere', label: 'Example' });
  over.receive({ type: 'pagePicture', data: shot });
  assert.equal(over.pagePicture ?? null, null, 'over a browser: none');
});

test("the app host in Margin's own window: the app's `loading` for its items draws each one's row and the bar of the one in front", () => {
  const b = bridge();
  const host = createAppHost({ hello: hello({ host: 'app-window', mode: 'fullscreen' }), post: b.post });
  const front = Object.values((host.getState() as any).tabs as Record<string, any>).find((t) => t.active)!;
  host.receive({ type: 'push', msg: { type: 'loading', tabIds: [front.id] } });
  assert.equal((host.getState() as any).tabs[front.id].loading, true);
  const vm = buildViewModel({ state: host.getState() as any, ui: { windowId: W, mode: host.mode }, platform: host.platform });
  assert.equal(vm.tab?.loading, true, 'the tab in front: the theme\'s bar');
  host.receive({ type: 'push', msg: { type: 'loading', tabIds: [] } });
  assert.notEqual((host.getState() as any).tabs[front.id].loading, true);
});

test('cornerFill: what the theme draws around the page\'s rounded corners, from computed styles: each corner\'s colour (its sharp shadows as painted, else a background) and the border', () => {
  const el = (style: Record<string, string>, parent: any = null) => ({ style, parentElement: parent });
  const base = { borderTopWidth: '0px', borderLeftWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderTopStyle: 'none', borderTopColor: 'rgb(0, 0, 0)', paddingTop: '0px', paddingLeft: '0px', paddingRight: '0px', paddingBottom: '0px', boxShadow: 'none', backgroundColor: 'rgba(0, 0, 0, 0)', borderTopLeftRadius: '0px', borderTopRightRadius: '0px', borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px' };
  const getStyle = (e: any) => ({ ...base, ...e.style });
  const getBox = () => ({ width: 1000, height: 800 });
  const radius = (r: string) => ({ borderTopLeftRadius: r, borderTopRightRadius: r, borderBottomRightRadius: r, borderBottomLeftRadius: r });
  // Neubrutalism: a 3 px ink border (its inner edge is the rounded page area), an ink shadow 6 px down and right over
  // the space's colour as a spread: ink at the bottom right only.
  const nb = { borderTopWidth: '3px', borderLeftWidth: '3px', borderRightWidth: '3px', borderBottomWidth: '3px', borderTopStyle: 'solid', borderTopColor: 'rgb(17, 17, 17)', ...radius('18px'), boxShadow: 'rgb(17, 17, 17) 6px 6px 0px 0px, rgb(255, 222, 0) 0px 0px 0px 1512px' };
  assert.deepEqual(cornerFill(el(nb) as any, { getStyle, getBox }), { fills: ['rgb(255, 222, 0)', 'rgb(255, 222, 0)', 'rgb(17, 17, 17)', 'rgb(255, 222, 0)'], edge: { width: 3, color: 'rgb(17, 17, 17)' } });
  // Arcadia: its frame, a spread shadow in the space's tint (a mixed colour, as computed); its soft card shadow (blurred) left out; no border.
  assert.deepEqual(cornerFill(el({ ...radius('10px'), boxShadow: 'color(srgb 0.801961 0.768627 0.939216) 0px 0px 0px 1512px' }) as any, { getStyle, getBox }), { fills: Array(4).fill('color(srgb 0.801961 0.768627 0.939216)'), edge: null });
  assert.deepEqual(cornerFill(el({ ...radius('6.25px'), boxShadow: 'rgb(156, 157, 161) 0px 0px 0px 1512px' }) as any, { getStyle, getBox }), { fills: Array(4).fill('rgb(156, 157, 161)'), edge: null });
  // Offset ink edges cover a rounded corner's point where they're painted (up: the top ones; right: the right ones), a
  // blurred and an inset one never, the ground as a spread elsewhere.
  assert.deepEqual(cornerFill(el({ ...radius('12px'), boxShadow: 'rgb(0, 0, 0) 0px -12px 0px 0px, rgb(0, 0, 0) 12px 0px 0px 0px, rgba(0, 0, 0, 0.2) 0px 0px 4px 2px, rgb(1, 2, 3) 0px 0px 0px 20px inset, rgb(40, 50, 60) 0px 0px 0px 1512px' }) as any, { getStyle, getBox })?.fills,
    ['rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgb(40, 50, 60)']);
  // Pixel: a square card: its corner points are inside it (no shadow painted there): what's behind it.
  assert.deepEqual(cornerFill(el({ boxShadow: 'rgb(0, 0, 0) 0px -3px 0px 0px, rgb(40, 50, 60) 0px 0px 0px 1512px' }, el({ backgroundColor: 'rgb(1, 1, 1)' })) as any, { getStyle, getBox })?.fills, Array(4).fill('rgb(1, 1, 1)'));
  // None: the nearest background drawn above it; nothing at all: null.
  assert.deepEqual(cornerFill(el({}, el({ backgroundColor: 'rgba(0, 0, 0, 0)' }, el({ backgroundColor: 'rgb(9, 9, 9)' }))) as any, { getStyle, getBox })?.fills, Array(4).fill('rgb(9, 9, 9)'));
  assert.equal(cornerFill(el({ boxShadow: 'rgba(0, 0, 0, 0) 0px 0px 0px 100px' }) as any, { getStyle, getBox }), null);
  assert.equal(cornerFill(null), null);
  assert.deepEqual(splitShadows('rgb(1, 2, 3) 0px 0px 0px 4px, color(srgb 1 0 0 / 0.5) 1px 1px 0px 0px'), ['rgb(1, 2, 3) 0px 0px 0px 4px', 'color(srgb 1 0 0 / 0.5) 1px 1px 0px 0px']);
});

test('the sidebar\'s width: fixed only beside a tile; under a hosted window it\'s dragged, the host told when a change begins and ends', async () => {
  const { installResize } = await import('../app/shared/ui/behaviors/resize.ts');
  const listeners: Record<string, (e: any) => void> = {};
  const handle = { classList: { add() {}, remove() {} }, setPointerCapture() {}, releasePointerCapture() {} };
  const saved: any[] = [];
  // What happened, in order: the host's performs, each layout flushed, each save.
  const log: string[] = [];
  let pageOutside = false;
  let fixed = false; // the theme's root marked by the host (overlay.ts followOutside, host-app.ts sidebarFixed)
  let width = 260;
  const rt: any = {
    view: { behaviorAt: () => ({ el: handle }), rootElement: () => ({ classList: { add() {}, remove() {} }, hasAttribute: (n: string) => fixed && n === 'm-sidebar-fixed' }), scheduleLayout() {}, flushLayout() { log.push('layout') } },
    theme: { id: 'arcadia', manifest: { settings: { sidebarWidth: { type: 'number', default: 260, min: 160, max: 500 } }, layout: {} } },
    get vm() { return { window: { pageOutside }, settings: { sidebarWidth: width } }; },
    container: {}, warn() {}, scale: () => 1,
    listen: (_el: unknown, type: string, fn: (e: any) => void) => { listeners[type] = fn; },
    setThemeSettings: (v: any, o?: { live?: boolean }) => { saved.push(v); if (!o?.live) { width = v.sidebarWidth; log.push(`save ${v.sidebarWidth}`); } },
    host: { send: async () => undefined, perform: (name: string, arg: any) => { log.push(`${name} ${arg.on}`); return true; } },
  };
  installResize(rt);
  const ev = (x: number) => ({ button: 0, pointerId: 1, clientX: x, target: handle, preventDefault() {}, stopPropagation() {} });
  pageOutside = true;
  listeners.pointerdown(ev(260));
  listeners.pointermove(ev(300));
  listeners.dblclick(ev(260));
  assert.deepEqual([saved, log], [[], []], 'beside a tile: no drag, no reset, nothing told');
  pageOutside = false;
  fixed = true;
  listeners.pointerdown(ev(260));
  listeners.pointermove(ev(320));
  assert.deepEqual([saved, log], [[], []], 'the root marked m-sidebar-fixed: no drag');
  fixed = false;
  // Which hosts mark it: a tile only; a hosted window above the page area doesn't.
  const tile = createAppHost({ hello: hello({ host: 'app-window', pageOutside: true }), post: bridge().post });
  const above = createAppHost({ hello: hello({ host: 'app-window', pageHosted: true }), post: bridge().post });
  assert.deepEqual([sidebarFixed(tile), sidebarFixed(above), above.sidebarDocked, sidebarFixed(null)], [true, false, false, false], 'fixed beside a tile; with a hosted window in the page area neither fixed nor kept docked');
  // A drag: told once as the width first changes, and once when it's over, after the last layout was flushed.
  listeners.pointerdown(ev(260));
  assert.deepEqual(log, [], 'a press alone: nothing told');
  listeners.pointermove(ev(260));
  assert.deepEqual(log, [], 'no change of the width yet: nothing told');
  listeners.pointermove(ev(300));
  listeners.pointermove(ev(310));
  assert.deepEqual(saved.at(-1), { sidebarWidth: 310 }, 'dragged, live');
  assert.deepEqual(log, ['sidebar.resizing true'], 'told once, at the first change');
  listeners.pointerup(ev(310));
  assert.deepEqual(log, ['sidebar.resizing true', 'save 310', 'layout', 'sidebar.resizing false'], 'let go: saved, the last layout reported, then told it\'s over');
  listeners.pointerup(ev(310));
  assert.equal(log.length, 4, 'over once');
  // A press let go without a move: saved as before, nothing told.
  log.length = 0;
  listeners.pointerdown(ev(310));
  listeners.pointerup(ev(310));
  assert.deepEqual(log, ['save 310'], 'no change: nothing told');
  // Double-click: the default, as one change (begun and over).
  log.length = 0;
  listeners.dblclick(ev(310));
  assert.deepEqual(log, ['sidebar.resizing true', 'save 260', 'layout', 'sidebar.resizing false'], 'the reset: one change');
  log.length = 0;
  listeners.dblclick(ev(260));
  assert.deepEqual(log, ['save 260'], 'at the default already: nothing told');
});

test('the sidebar\'s edge stops where the page area would be narrower than the hosted window\'s own minimum (Split View\'s divider), slow or fast, a reset too', async () => {
  const { installResize } = await import('../app/shared/ui/behaviors/resize.ts');
  const listeners: Record<string, (e: any) => void> = {};
  const handle = { classList: { add() {}, remove() {} }, setPointerCapture() {}, releasePointerCapture() {} };
  const live: number[] = [];
  const saves: number[] = [];
  let width = 260;
  // The page area 1244 wide beside a 260 sidebar (1512 wide, the page 8 from the right): the app's own window's layout.
  const host: any = { pageMinWidth: 1100, layout: { insets: { left: 260, top: 8, right: 8, bottom: 8 }, container: { width: 1512, height: 949 } }, send: async () => undefined, perform: () => true };
  const rt: any = {
    view: { behaviorAt: () => ({ el: handle }), rootElement: () => ({ classList: { add() {}, remove() {} }, hasAttribute: () => false }), scheduleLayout() {}, flushLayout() {} },
    theme: { id: 'arcadia', manifest: { settings: { sidebarWidth: { type: 'number', default: 260, min: 160, max: 500 } }, layout: {} } },
    get vm() { return { window: { pageOutside: false }, settings: { sidebarWidth: width } }; },
    container: {}, warn() {}, scale: () => 1,
    listen: (_el: unknown, type: string, fn: (e: any) => void) => { listeners[type] = fn; },
    setThemeSettings: (v: any, o?: { live?: boolean }) => { if (o?.live) live.push(v.sidebarWidth); else { width = v.sidebarWidth; saves.push(width); } },
    host,
  };
  installResize(rt);
  const ev = (x: number) => ({ button: 0, pointerId: 1, clientX: x, target: handle, preventDefault() {}, stopPropagation() {} });
  // Slow: one point a move, past the floor (the page area 1100 at a 404 sidebar).
  listeners.pointerdown(ev(260));
  for (let x = 261; x <= 500; x += 1) listeners.pointermove(ev(x));
  assert.equal(Math.max(...live), 404, 'never wider than the page area\'s floor allows');
  listeners.pointerup(ev(500));
  assert.equal(saves.at(-1), 404, 'let go there');
  // Fast: one move far past it, and back.
  host.layout = { ...host.layout, insets: { ...host.layout.insets, left: 404 } };
  live.length = 0;
  listeners.pointerdown(ev(404));
  listeners.pointermove(ev(300));
  listeners.pointermove(ev(800));
  assert.deepEqual(live, [300, 404], 'a fast move past it stops at it; narrower is free');
  listeners.pointerup(ev(800));
  assert.equal(saves.at(-1), 404);
  // Under the floor already (the shown window wider than the page area): no wider at all, narrower as usual.
  host.pageMinWidth = 1200;
  live.length = 0;
  listeners.pointerdown(ev(404));
  listeners.pointermove(ev(450));
  assert.deepEqual(live, [], 'no wider when the page area is under its floor');
  listeners.pointermove(ev(350));
  assert.deepEqual(live, [350], 'narrower as usual');
  listeners.pointerup(ev(350));
  // A floor said mid-drag holds from the next move; none: no limit but the theme's.
  host.pageMinWidth = 0;
  host.layout = { ...host.layout, insets: { ...host.layout.insets, left: 350 } };
  live.length = 0;
  listeners.pointerdown(ev(350));
  listeners.pointermove(ev(420));
  host.pageMinWidth = 1100;
  listeners.pointermove(ev(480));
  assert.deepEqual(live, [420, 404], 'the floor said mid-drag: the next move stops at it (the page area 1154 at the press, 54 above it)');
  listeners.pointerup(ev(480));
  host.pageMinWidth = 0;
  listeners.pointerdown(ev(404));
  host.layout = { ...host.layout, insets: { ...host.layout.insets, left: 404 } };
  listeners.pointermove(ev(500));
  assert.equal(live.at(-1), 500, 'no floor: the theme\'s max only');
  listeners.pointerup(ev(500));
  // Arcadia's own step (10): the edge stops at the floor exactly while dragged, and lets go at the step under it, never
  // past it (the real screen, 2026-11-18 10:31: live 404, the page area 1100; let go 400, 1104).
  rt.theme.manifest.settings.sidebarWidth.step = 10;
  host.pageMinWidth = 1100;
  host.layout = { ...host.layout, insets: { ...host.layout.insets, left: 240 } };
  width = 240;
  live.length = 0;
  listeners.pointerdown(ev(240));
  for (let x = 250; x <= 500; x += 10) listeners.pointermove(ev(x));
  assert.equal(Math.max(...live), 404, 'stopped at the floor exactly');
  listeners.pointerup(ev(500));
  assert.equal(saves.at(-1), 400, 'let go at the step under the floor, not 410');
  rt.theme.manifest.settings.sidebarWidth.step = undefined;
  // The reset to the default (260) widens the page: free; a default past the floor stops at it.
  host.pageMinWidth = 1300;
  host.layout = { ...host.layout, insets: { ...host.layout.insets, left: 160 } };
  width = 160;
  listeners.dblclick(ev(160));
  assert.equal(saves.at(-1), 204, 'the reset stops where the page area is at its floor (1344 − 1300 + 160)');
});

test('the app host: the hosted window\'s own minimum width, from the hello and as it changes (its own window only)', () => {
  const host = createAppHost({ hello: hello({ host: 'app-window', pageHosted: true, pageMinWidth: 1047.5 }), post: bridge().post });
  assert.equal(host.pageMinWidth, 1048, 'from the hello, whole points up');
  host.receive({ type: 'pageMin', width: 1100 });
  assert.equal(host.pageMinWidth, 1100);
  host.receive({ type: 'pageMin', width: null });
  assert.equal(host.pageMinWidth, 0, 'none');
  host.receive({ type: 'pageMin', width: 'wide' });
  assert.equal(host.pageMinWidth, 0, 'not a number: none');
  const over = createAppHost({ hello: hello({ pageMinWidth: 1100 }), post: bridge().post });
  over.receive({ type: 'pageMin', width: 1100 });
  assert.equal(over.pageMinWidth, 0, 'over a browser window: never');
});

test('the app host: a space swipe\'s detent tick goes to the app (its own window only)', () => {
  const b = bridge();
  const host = createAppHost({ hello: hello({ host: 'app-window' }), post: b.post });
  assert.equal(host.perform('haptic.alignment'), true);
  assert.deepEqual(b.posts.at(-1), { op: 'perform', name: 'haptic.alignment' });
  const over = bridge();
  assert.equal(createAppHost({ hello: hello(), post: over.post }).perform('haptic.alignment'), false, 'over a browser window: not the app\'s');
  assert.deepEqual(over.posts, []);
});

test('the app host: the sidebar\'s width being dragged goes to the app (its own window only); a layout that leaves the corners out keeps them', () => {
  const b = bridge();
  const host = createAppHost({ hello: hello({ host: 'app-window', pageHosted: true }), post: b.post });
  assert.equal(host.perform('sidebar.resizing', { on: true }), true);
  assert.deepEqual(b.posts.at(-1), { op: 'perform', name: 'sidebar.resizing', arg: { on: true } });
  assert.equal(host.perform('sidebar.resizing', { on: false }), true);
  assert.deepEqual(b.posts.at(-1), { op: 'perform', name: 'sidebar.resizing', arg: { on: false } });
  assert.equal(host.perform('sidebar.resizing', {}), false, 'not a word about on or off: refused');
  const over = bridge();
  assert.equal(createAppHost({ hello: hello(), post: over.post }).perform('sidebar.resizing', { on: true }), false, 'over a browser window: not the app\'s');
  assert.deepEqual(over.posts, []);
  // The page's own measure says what the theme draws around the corners; the runtime's frame (a width being dragged)
  // measures the box only: the colours stay as last said, so the ground the app puts under the page area keeps its colour.
  const g = (left: number) => ({ insets: { left, top: 8, right: 8, bottom: 8 }, radius: 6, radii: [6, 6, 6, 6], container: { width: 1512, height: 949 }, windowId: W });
  const fills = Array(4).fill('rgb(156, 157, 161)');
  host.reportLayout({ ...g(260), fills } as any);
  host.reportLayout(g(300) as any);
  const last = () => b.posts.filter((p) => p.op === 'layout').at(-1)?.geometry;
  assert.deepEqual([last().insets.left, last().fills], [300, fills], 'dragged: the colours as last said');
  const layouts = b.posts.filter((p) => p.op === 'layout').length;
  host.reportLayout({ ...g(300), fills } as any);
  assert.equal(b.posts.filter((p) => p.op === 'layout').length, layouts, 'the page\'s measure of the same place: not posted twice');
  host.reportLayout({ ...g(300), fills: null } as any);
  assert.equal(last().fills, null, 'said as none (a theme that draws nothing there): none');
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

test("the app host in Margin's own window: said by the hello's host, its mode the window's; not otherwise", () => {
  const over = createAppHost({ hello: hello(), post: bridge().post });
  assert.equal(over.appWindow, false, 'over a browser window by default');
  const b = bridge();
  const host = createAppHost({ hello: hello({ host: 'app-window', mode: 'windowed', windows: [{ windowId: W, id: W, state: 'normal', focused: true }] }), post: b.post });
  assert.equal(host.appWindow, true);
  assert.equal(host.mode, 'windowed');
  const drawn: (string | undefined)[] = [];
  host.onState(() => drawn.push(host.mode));
  host.receive({ type: 'windows', list: [{ windowId: W, id: W, state: 'fullscreen', focused: true }] });
  assert.deepEqual(drawn, ['fullscreen'], 'Margin\'s window into full screen: drawn so');
  assert.equal(host.launcher, true, 'nothing hosted beside it: its page area is the launcher, never a see-through hole');
  assert.equal(host.inNewTab, false, 'not a browser tab: what the launcher opens is a new item (newTab)');
  host.receive({ type: 'pageOutside', on: true });
  assert.equal(host.launcher, false, 'hosting beside it: no page area of its own, no launcher');
  host.receive({ type: 'pageOutside', on: false });
  assert.equal(host.launcher, true, 'nothing hosted again: the launcher again');
  host.receive({ type: 'pageHosted', on: true });
  assert.equal(host.pageHosted, true);
  assert.equal(host.launcher, false, 'a hosted app\'s window above the page area (window mode): no launcher (its field would take the keys)');
  assert.equal(host.pageOutside, false, 'window mode: laid out with a page area of its own');
  assert.equal(host.sidebarDocked, false, 'an app\'s window in the page area: the sidebar as the person keeps it (Margin\'s window is in front of that window)');
  // The view model: Keep open off, hidden; out over the app's window from the edge (Tirth, 2026-11-20; docked whatever
  // its setting until then); Keep open on, docked.
  const state = host.getState() as PageState;
  const closed = { ...state, settings: { ...state.settings, sidebarPinnedOpen: false } };
  const kept = { ...state, settings: { ...state.settings, sidebarPinnedOpen: true } };
  for (const [s, sidebar, want] of [[closed, undefined, 'hidden'], [closed, 'peek', 'peek'], [kept, undefined, 'open']] as const) {
    const vm = buildViewModel({ state: s, ui: { windowId: W, mode: 'fullscreen', sidebarDocked: host.sidebarDocked, ...(sidebar ? { sidebar } : {}) }, platform: host.platform });
    assert.equal(vm.window.sidebar, want, `hosting, ${sidebar ?? (s === kept ? 'Keep open on' : 'Keep open off')}: ${want}`);
    assert.equal(vm.window.pageOutside, false, 'its own page area, not the sidebar alone');
  }
  host.receive({ type: 'pageHosted', on: false });
  assert.equal(host.sidebarDocked, false, 'that window gone: the sidebar follows its setting again');
  assert.equal(host.launcher, true, 'that window gone: the launcher again');
  assert.equal(createAppHost({ hello: hello({ pageHosted: true }), post: bridge().post }).pageHosted, false, 'only in Margin\'s own window');
  assert.equal(createAppHost({ hello: hello({ host: 'app-window', pageHosted: true }), post: bridge().post }).launcher, false, 'from the hello');
  assert.equal(host.perform('navigate', { url: 'https://example.com/' }), false, 'an address opens as a new tab (the runtime sends newTab)');
  assert.equal(host.perform('window.fullscreen'), true);
  assert.deepEqual(b.posts.at(-1), { op: 'perform', name: 'window.fullscreen', arg: null });
});

test("the app host: Margin's own window hosting another app's window beside it (pageOutside): the sidebar alone, always docked", () => {
  const over = createAppHost({ hello: hello({ pageOutside: true }), post: bridge().post });
  assert.equal(over.pageOutside, false, 'only in Margin\'s own window');
  const host = createAppHost({ hello: hello({ host: 'app-window', pageOutside: true }), post: bridge().post });
  assert.equal(host.pageOutside, true, 'from the hello');
  assert.equal(host.sidebarDocked, true, 'beside a tile: docked');
  const drawn: boolean[] = [];
  host.onState(() => drawn.push(host.pageOutside));
  host.receive({ type: 'pageOutside', on: false });
  host.receive({ type: 'pageOutside', on: false });
  host.receive({ type: 'pageOutside', on: true });
  assert.deepEqual(drawn, [false, true], 'drawn again each time it changes, only then');
  // The view model: the sidebar docked even with Keep open off, or put away by its key (peek, hidden).
  const state = host.getState() as PageState;
  const closed = { ...state, settings: { ...state.settings, sidebarPinnedOpen: false } };
  for (const sidebar of [undefined, 'hidden', 'peek'] as const) {
    const vm = buildViewModel({ state: closed, ui: { windowId: W, mode: 'fullscreen', pageOutside: true, ...(sidebar ? { sidebar } : {}) }, platform: host.platform });
    assert.equal(vm.window.sidebar, 'open', `${sidebar ?? 'Keep open off'}: docked`);
    assert.equal(vm.window.pageOutside, true);
  }
  const plain = buildViewModel({ state: closed, ui: { windowId: W, mode: 'fullscreen' }, platform: host.platform });
  assert.equal(plain.window.sidebar, 'hidden', 'not hosting: Keep open off hides it, as before');
  assert.equal(plain.window.pageOutside, false);
});

test('chromeRects: the first window-controls with a box, every drag region with one', () => {
  type FakeEl = { getBoundingClientRect: () => { left: number, top: number, width: number, height: number } };
  const el = (r: number[]): FakeEl => ({ getBoundingClientRect: () => ({ left: r[0], top: r[1], width: r[2], height: r[3] }) });
  const root = (controls: FakeEl[], drags: FakeEl[]) => ({ querySelectorAll: (sel: string) => (sel === 'm-window-controls' ? controls : sel === 'm-drag-region' ? drags : []) }) as unknown as Element;
  assert.deepEqual(chromeRects(root([el([0, 0, 0, 0]), el([6.2, 7, 60, 14])], [el([80, 0, 180, 28]), el([0, 0, 0, 10])])), { controls: [6, 7, 60, 14], drags: [[80, 0, 180, 28]] });
  assert.deepEqual(chromeRects(root([el([0, 0, 0, 0])], [])), { controls: null, drags: [] }, 'hidden (full screen): none');
  assert.deepEqual(chromeRects(null), { controls: null, drags: [] });
});

test('applyChanges leaves the old values alone', () => {
  const raw = { a: 1, favicons: { x: 1 } };
  const next = applyChanges(raw, { a: { newValue: 2 }, b: { newValue: null }, favicons: { newValue: {} } }, { set: { y: 2 } });
  assert.deepEqual(raw, { a: 1, favicons: { x: 1 } });
  assert.deepEqual(next, { a: 2, b: null, favicons: { x: 1, y: 2 } });
});

test('hitRects: what takes the pointer over the slot, boxes inside others left out', () => {
  // A stand-in for the overlay's elements: what hitRects reads of them.
  type FakeEl = { localName: string, children: FakeEl[], getBoundingClientRect: () => { left: number, top: number, right: number, bottom: number, width: number, height: number }, style: HitStyle };
  const el = (name: string, r: number[], style: Partial<HitStyle> = {}, children: FakeEl[] = []): FakeEl => ({
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
  // A layer over the whole window with a backdrop of the same size (Arcadia's palette): in Margin's own window the
  // layer, once; over a browser's window none of it (a press on the page reaches it, and closes the palette).
  const layer = el('div', [0, 0, 1280, 800], {}, [el('button', [0, 0, 1280, 800]), el('div', [380, 100, 520, 60])]);
  const withLayer = el('div', [0, 0, 1280, 800], {}, [el('m-page', [260, 8, 1012, 784]), el('m-if', [0, 0, 0, 0], {}, [layer])]);
  assert.deepEqual(hitRects((withLayer as unknown as Element), slot, { getStyle, keepEqual: true }), { rects: [[0, 0, 1280, 800]], all: false });
  assert.deepEqual(hitRects((withLayer as unknown as Element), slot, { getStyle }), { rects: [], all: false });
  const many = el('div', [0, 0, 1280, 800], {}, Array.from({ length: 70 }, (_, i) => el('b', [300 + i * 10, 100, 5, 5])));
  assert.deepEqual(hitRects((many as unknown as Element), slot, { getStyle }), { rects: [], all: true });
});

test('hitRects: a split\'s dividers take the pointer, none while the preview card is up over the split (its page the card\'s)', () => {
  type FakeEl = { localName: string, children: FakeEl[], attrs: Set<string>, hasAttribute: (n: string) => boolean, getBoundingClientRect: () => { left: number, top: number, right: number, bottom: number, width: number, height: number }, style: HitStyle };
  const el = (name: string, r: number[], children: FakeEl[] = [], attrs: string[] = []): FakeEl => {
    const set = new Set(attrs);
    return {
      localName: name, children, attrs: set, hasAttribute: (n) => set.has(n),
      getBoundingClientRect: () => ({ left: r[0], top: r[1], right: r[0] + r[2], bottom: r[1] + r[3], width: r[2], height: r[3] }),
      style: { pointerEvents: 'auto', visibility: 'visible' },
    };
  };
  const getStyle = (e: Element) => (e as unknown as FakeEl).style;
  const slot = { left: 260, top: 8, right: 1272, bottom: 792 };
  const stacked = (attrs: string[]) => el('div', [0, 0, 1280, 800], [el('m-page', [260, 8, 1012, 784], [el('m-pane', [260, 8, 1012, 340]), el('m-divider', [260, 348, 1012, 52]), el('m-pane', [260, 400, 1012, 392])], attrs)]);
  assert.deepEqual(hitRects((stacked([]) as unknown as Element), slot, { getStyle }), { rects: [[260, 348, 1012, 52]], all: false }, 'the band is Margin\'s');
  assert.deepEqual(hitRects((stacked(['m-card-clip']) as unknown as Element), slot, { getStyle }), { rects: [], all: false }, 'a card up: the band under its page never Margin\'s');
});

test('hitRects: a box counts only as far as the ancestors that clip it show it, as CSS clips', () => {
  type FakeEl = { localName: string, children: FakeEl[], getBoundingClientRect: () => { left: number, top: number, right: number, bottom: number, width: number, height: number }, style: HitStyle };
  const el = (name: string, r: number[], style: Partial<HitStyle> = {}, children: FakeEl[] = []): FakeEl => ({
    localName: name, children,
    getBoundingClientRect: () => ({ left: r[0], top: r[1], right: r[0] + r[2], bottom: r[1] + r[3], width: r[2], height: r[3] }),
    style: { pointerEvents: 'auto', visibility: 'visible', ...style },
  });
  const getStyle = (e: Element) => (e as unknown as FakeEl).style;
  const slot = { left: 260, top: 8, right: 1272, bottom: 792 };
  const hits = (children: FakeEl[]) => hitRects((el('div', [0, 0, 1280, 800], {}, [el('m-page', [260, 8, 1012, 784]), ...children]) as unknown as Element), slot, { getStyle });
  // A space swipe: the sidebar clips, its list slid 200 px to the right, under the page (2026-11-20: its 80 rows
  // made `all`, and Margin.app covered the page for the whole swipe).
  const rows = Array.from({ length: 80 }, (_, i) => el('div', [208, 40 + i * 9, 252, 8]));
  const slid = (overflow: Partial<HitStyle>) => [el('aside', [0, 0, 260, 800], overflow, [el('div', [200, 0, 260, 800], { transform: 'matrix(1, 0, 0, 1, 200, 0)', pointerEvents: 'none' }, rows)])];
  assert.deepEqual(hits(slid({ overflowX: 'clip', overflowY: 'clip' })), { rects: [], all: false });
  assert.deepEqual(hits(slid({ overflowX: 'hidden', overflowY: 'auto' })), { rects: [], all: false });
  assert.deepEqual(hits(slid({ contain: 'paint' })), { rects: [], all: false });
  assert.deepEqual(hits(slid({})), { rects: [], all: true }, 'nothing clips: every row over the page counts');
  // Boxes are reported as far as they're shown (not cut to the slot); a clipping box over the slot that passes the
  // pointer through, as the sidebars around the page do not, so only what's inside it shows here.
  const through: Partial<HitStyle> = { pointerEvents: 'none' };
  // Only along the axis that clips: overflow-x clipped, y visible, a box spilling right and down is cut at the sidebar's right edge only.
  assert.deepEqual(hits([el('aside', [0, 0, 300, 400], { overflowX: 'clip', ...through }, [el('div', [100, 300, 400, 200])])]), { rects: [[100, 300, 200, 200]], all: false });
  // Part of it shown: only that part.
  assert.deepEqual(hits([el('aside', [0, 0, 300, 800], { overflowX: 'hidden', overflowY: 'hidden', ...through }, [el('div', [200, 100, 200, 50])])]), { rects: [[200, 100, 100, 50]], all: false });
  // Through two clipping ancestors: both cut it.
  assert.deepEqual(hits([el('div', [0, 0, 320, 800], { overflowX: 'clip', overflowY: 'clip', ...through }, [el('div', [0, 0, 1000, 200], { overflowX: 'clip', overflowY: 'clip', ...through }, [el('b', [100, 100, 600, 400])])])]), { rects: [[100, 100, 220, 100]], all: false });
  // A menu positioned `absolute` whose containing block is above the clipping sidebar escapes its clip, whole.
  const menu = el('div', [200, 100, 300, 200], { position: 'absolute' });
  assert.deepEqual(hits([el('aside', [0, 0, 260, 800], { overflowX: 'clip', overflowY: 'clip' }, [el('div', [0, 0, 260, 800], {}, [menu])])]), { rects: [[200, 100, 300, 200]], all: false });
  // ...but not when the sidebar (or a box between) is its containing block.
  assert.deepEqual(hits([el('aside', [0, 0, 300, 800], { overflowX: 'clip', overflowY: 'clip', position: 'relative', ...through }, [menu])]), { rects: [[200, 100, 100, 200]], all: false });
  assert.deepEqual(hits([el('aside', [0, 0, 300, 800], { overflowX: 'clip', overflowY: 'clip', ...through }, [el('div', [0, 0, 300, 800], { position: 'relative', ...through }, [menu])])]), { rects: [[200, 100, 100, 200]], all: false });
  // A clip below the containing block: still escaped (the menu's containing block, the sidebar, doesn't clip).
  assert.deepEqual(hits([el('aside', [0, 0, 260, 800], { position: 'relative' }, [el('div', [0, 0, 260, 800], { overflowX: 'hidden', overflowY: 'hidden' }, [menu])])]), { rects: [[200, 100, 300, 200]], all: false });
  // `fixed`: escapes every clip, a positioned one too, unless a transform (or filter, containment...) holds it.
  const pop = el('div', [200, 100, 300, 200], { position: 'fixed' });
  assert.deepEqual(hits([el('aside', [0, 0, 300, 800], { overflowX: 'clip', overflowY: 'clip', position: 'relative', ...through }, [pop])]), { rects: [[200, 100, 300, 200]], all: false });
  assert.deepEqual(hits([el('aside', [0, 0, 300, 800], { overflowX: 'clip', overflowY: 'clip', transform: 'matrix(1, 0, 0, 1, 0, 0)', ...through }, [pop])]), { rects: [[200, 100, 100, 200]], all: false });
  assert.deepEqual(hits([el('aside', [0, 0, 300, 800], { overflowX: 'clip', overflowY: 'clip', willChange: 'transform', ...through }, [pop])]), { rects: [[200, 100, 100, 200]], all: false });
  // An in-flow child of an escaped menu: clipped as the menu is (not at all), and inside it, so left out.
  assert.deepEqual(hits([el('aside', [0, 0, 260, 800], { overflowX: 'clip', overflowY: 'clip' }, [el('div', [200, 100, 300, 200], { position: 'absolute' }, [el('a', [210, 110, 280, 30])])])]), { rects: [[200, 100, 300, 200]], all: false });
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
    // Every built-in theme's package beside the page, for Margin.app to hand its window when one is chosen.
    assert.deepEqual([...BUILTIN_THEMES], [...PACKAGE_THEMES], 'the same built-ins as the extension');
    for (const id of BUILTIN_THEMES) {
      const pkg = JSON.parse(readFileSync(join(tmp, builtinThemeFile(id)), 'utf8'));
      assert.equal(pkg.id, id);
      assert.equal(JSON.parse(pkg.manifest).id, id);
      assert.ok(typeof pkg.html === 'string' && typeof pkg.css === 'string' && typeof pkg.files === 'object');
    }
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
  assert.equal(pkg.manifest, readFileSync(join(root, 'app/shared/ui/themes/arcadia/theme.json'), 'utf8'));
  const { sanitizeTheme, checkPackage } = await import('../app/shared/ui/theme-loader.ts');
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


test("the app host in Margin's own window: the opening item's app (its bundle id, for the loader's icon) from the hello and `pageState`, only while loading; the icon looked up in the apps the app listed", () => {
  const b = bridge();
  const notes = 'data:image/png;base64,iVBORw0KGgo=';
  const apps = [{ bundleId: 'com.apple.Notes', name: 'Notes', icon: notes }, { bundleId: 'com.apple.Safari', name: 'Safari', icon: null }];
  const host = createAppHost({ hello: hello({ host: 'app-window', mode: 'fullscreen', apps }), post: b.post });
  let emits = 0;
  host.onState(() => { emits++; });
  assert.equal(host.pageOpeningBundleId, null, 'nothing opening: none');
  host.receive({ type: 'pageHosted', on: true });
  host.receive({ type: 'pageState', state: 'loading', label: 'Notes', bundleId: 'com.apple.Notes' });
  assert.deepEqual([host.pageOpening, host.pageOpeningBundleId], ['Notes', 'com.apple.Notes']);
  const ui = () => ({ windowId: W, mode: host.mode, pageOpening: host.pageState === 'loading' ? { name: host.pageOpening ?? '', bundleId: host.pageOpeningBundleId } : null });
  assert.equal(buildViewModel({ state: host.getState() as any, ui: ui(), platform: host.platform }).pageLoader?.icon, notes, "the view model's loader: the app's icon from the list the hello had");
  const said = emits;
  host.receive({ type: 'pageState', state: 'loading', label: 'Notes', bundleId: 'com.apple.Notes' });
  assert.equal(emits, said, 'said again as it is: nothing drawn again');
  host.receive({ type: 'pageState', state: 'loading', label: 'Notes', bundleId: 'com.apple.Safari' });
  assert.deepEqual([host.pageOpeningBundleId, emits], ['com.apple.Safari', said + 1], 'another app, the same name: drawn again');
  host.receive({ type: 'pageState', state: 'loading', label: 'Notes', bundleId: '../../etc' });
  assert.equal(host.pageOpeningBundleId, null, 'not a bundle id: none');
  host.receive({ type: 'pageState', state: 'loading', label: 'Notes', bundleId: 'com.apple.Notes' });
  host.receive({ type: 'pageState', state: 'shown', label: null, bundleId: 'com.apple.Notes' });
  assert.deepEqual([host.pageState, host.pageOpeningBundleId], ['shown', null], 'shown: none kept');
  const started = createAppHost({ hello: hello({ host: 'app-window', mode: 'fullscreen', pageHosted: true, pageState: 'loading', pageOpening: 'Notes', pageOpeningBundleId: 'com.apple.Notes' }), post: b.post });
  assert.equal(started.pageOpeningBundleId, 'com.apple.Notes', 'a page loaded again mid-open: its hello has it');
  const idle = createAppHost({ hello: hello({ host: 'app-window', mode: 'fullscreen', pageState: 'shown', pageOpeningBundleId: 'com.apple.Notes' }), post: b.post });
  assert.equal(idle.pageOpeningBundleId, null, '… only while loading');
});

test("the app host in Margin's own window: the start screen held up (`stuck` with `starting`), its two choices the app's to run; nothing held up otherwise", async () => {
  const b = bridge();
  const host = createAppHost({ hello: hello({ host: 'app-window', pageState: 'loading', pageOpening: 'Getting you started', pageStarting: true, pageStuck: 'Safari is taking longer than usual to start.' }), post: b.post });
  assert.equal(host.pageStarting, true);
  assert.equal(host.pageStuck, 'Safari is taking longer than usual to start.', 'from the hello (a page loaded while held up)');
  let changes = 0;
  host.onState(() => { changes += 1; });
  host.receive({ type: 'pageState', state: 'loading', label: 'Getting you started', starting: true });
  assert.equal(host.pageStuck, null, 'no longer held up');
  assert.equal(changes, 1, 'drawn again');
  host.receive({ type: 'pageState', state: 'loading', label: 'Getting you started', starting: true, stuck: 'x'.repeat(500) });
  assert.equal((host.pageStuck as string | null)?.length, 300, 'what the app says, cut at 300 characters');
  assert.equal(host.perform('startup.retry'), true);
  assert.equal(host.perform('startup.skip'), true);
  await Promise.resolve();
  assert.deepEqual(b.posts.filter((p) => p.op === 'perform').map((p) => p.name), ['startup.retry', 'startup.skip'], 'each asked of the app');
  host.receive({ type: 'pageState', state: 'loading', label: 'Notes', stuck: 'held' });
  assert.equal(host.pageStuck, null, 'not starting: never held up, whatever is said');
  assert.equal(host.perform('startup.retry'), false, 'not starting: its choices refused');
  const browserPage = createAppHost({ hello: hello({ pageState: 'loading', pageStarting: true, pageStuck: 'held' }), post: bridge().post });
  assert.equal(browserPage.perform('startup.skip'), false, 'over a browser (not Margin\'s own window): never');
});
