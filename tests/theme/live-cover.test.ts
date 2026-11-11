// The transient native cover renders the real sanitized module without the
// interactive runtime, browser commands, layout reports or JS animation loops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { chromium, webkit } from 'playwright';
import { fileURLToPath } from 'node:url';
import { ARCADIA, NEO, PIXEL, themeForPage, themesInScope } from './package.ts';
import { smallState, W } from '../ui/fixtures.ts';
import { toStorage } from '../../extension/shared/stored.ts';
import type { mountHandoffCover } from '../../app/shared/host/handoff-cover-view.ts';
import type { MockStored } from './view-model.ts';

type Cover = Awaited<ReturnType<typeof mountHandoffCover>>;
declare const C: { mount: typeof mountHandoffCover, current: Cover | null, posts: unknown[], frames: number };
const script = buildSync({
  stdin: {
    contents: `import { mountHandoffCover } from './app/shared/host/handoff-cover-view.ts';
      const posts = []; const raf = window.requestAnimationFrame.bind(window);
      window.C = { mount: mountHandoffCover, current: null, posts, frames: 0 };
      window.requestAnimationFrame = (f) => { C.frames++; return raf(f); };
      window.webkit = { messageHandlers: { margin: { postMessage: (m) => { posts.push(m); return Promise.resolve(null); } } } };
      window.browser = { runtime: { sendMessage: (m) => { posts.push(m); return Promise.resolve(null); } } };`,
    resolveDir: fileURLToPath(new URL('../../', import.meta.url)), sourcefile: 'live-cover-harness.ts',
  },
  bundle: true, format: 'iife', write: false, target: 'es2022', logLevel: 'silent',
}).outputFiles[0].text;
const ENGINES = [['webkit', webkit], ['chromium', chromium]] as const;
const THEMES = [['arcadia', ARCADIA], ['neubrutalism', NEO], ['pixel', PIXEL]] as const;
const hostile = '<img src="https://hostile.invalid/pixel" onerror="window.__tripped=1">';
function hello(id: string, dir: string) {
  const state: MockStored = smallState();
  state.settings.theme = id;
  state.settings.sidebarPinnedOpen = true;
  return {
    profile: 'source', windowId: W, browser: 'safari', mode: 'fullscreen',
    platform: { browser: 'safari', os: 'mac', app: true },
    state: toStorage(state, Object.keys(state), { origin: 'safari-web-extension://margin', since: 1, synced: true }),
    windows: [{ windowId: W, state: 'fullscreen', focused: true, activeTabId: 13 }],
    theme: { id, ...themeForPage(dir) },
    across: {
      v: 1, profile: 'source',
      profiles: [
        { id: 'source', name: 'Personal', color: '#6c5ce7', spaces: 3 },
        { id: 'target', name: 'Work', emoji: '💼', color: '#00b894', spaces: 1 },
      ],
      spaces: [{ profile: 'source', id: 'home', name: 'Home' }, { profile: 'target', id: 'home', name: 'Target mail', emoji: '✉️', color: '#e17055' }],
      switching: {
        profile: 'target', space: 'home', phase: 'covered', from: { profile: 'source', windowId: W },
        content: {
          space: 'home', folders: [{ id: 'f', name: hostile, open: true, pos: 0 }],
          pins: [{ id: 'pin', title: 'Cached pin', url: 'https://target.invalid/pin', folderId: 'f', pos: 0, icon: 'https://hostile.invalid/icon' }],
          tabs: [{ id: 'tab', title: hostile, url: 'https://target.invalid/tab', active: true, icon: 'https://hostile.invalid/icon' }],
        },
      },
    },
  };
}

for (const [engineName, engine] of ENGINES) for (const [id, dir] of themesInScope(THEMES)) {
  test(`the read-only live cover in ${id}, ${engineName}`, async (t) => {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const seen = { requests: [] as string[], errors: [] as string[] };
    page.on('request', (r) => { if (!/^(data|blob|about):/.test(r.url())) seen.requests.push(r.url()); });
    page.on('pageerror', (e) => seen.errors.push(e.message));
    await context.route('**/*', (route) => route.abort());
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;height:900px"></body></html>');
    await page.addScriptTag({ content: script });
    const mount = (h = hello(id, dir)) => page.evaluate(async (value) => {
      C.current?.destroy(); C.current = null;
      try { C.current = await C.mount(value); return null; } catch (e) { return String((e as Error).message); }
    }, h);
    try {
      await t.test('draws the exact foreign target rows safely; progresses in CSS and recovers without actions', async () => {
        assert.equal(await mount(), null);
        assert.deepEqual(await page.evaluate(() => ({
          name: C.current?.vm.space.name, ids: C.current?.vm.space.today.map((r) => r.id),
          cover: document.querySelector('.switch-cover-text')?.textContent,
          source: document.querySelector('.tab[title="Docs"], .tab[aria-label="Docs"]') !== null,
          tab: [...document.querySelectorAll('.tab')].some((el) => el.textContent?.includes('<img src=')),
          pin: document.querySelector('.pin[title="Cached pin"], .pin[aria-label="Cached pin"]')?.textContent?.includes('Cached pin'),
          injected: document.querySelector('[onerror], img[src^="https:"]') !== null,
        })), { name: 'Target mail', ids: ['x:tab'], cover: 'Switching to Work…', source: false, tab: true, pin: true, injected: false });
        const cover = await page.locator('.switch-cover').boundingBox();
        const slot = await page.locator('m-page').boundingBox();
        assert.ok(cover && slot && cover.width > 0 && cover.height > 0);
        for (const [name, a, b] of [
          ['left', cover.x, slot.x], ['top', cover.y, slot.y],
          ['right', cover.x + cover.width, slot.x + slot.width], ['bottom', cover.y + cover.height, slot.y + slot.height],
        ] as const) assert.ok(Math.abs(a - b) <= 4, `${name}: cover ${a}, page ${b}`);
        assert.notEqual(await page.locator('.switch-cover-progress i').first().evaluate((el) => getComputedStyle(el).animationName), 'none');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        assert.equal(await page.locator('.switch-cover-progress i').first().evaluate((el) => getComputedStyle(el).animationName), 'none');
        await page.evaluate(() => C.current!.recovering());
        assert.equal(await page.locator('.switch-cover-text').textContent(), 'Restoring your window…');
        assert.equal(await page.locator('.switch-cover').getAttribute('aria-label'), 'Restoring your window…');
        assert.deepEqual(await page.evaluate(() => ({ posts: C.posts, frames: C.frames })), { posts: [], frames: 0 });
        // A trusted click reaches View's action listener, whose cover callback
        // is deliberately inert (synthetic clicks would be refused earlier).
        await page.locator('.pin[title="Cached pin"], .pin[aria-label="Cached pin"]').click();
        assert.deepEqual(await page.evaluate(() => C.posts), []);
      });

      await t.test('accepts an empty cached target and the native host\'s theme fallback', async () => {
        const h = hello(id, dir);
        h.across.switching.content = { space: 'home', folders: [], pins: [], tabs: [] };
        h.state.settings.theme = 'missing-user-theme';
        assert.equal(await mount(h), null);
        assert.equal(await page.evaluate(() => C.current?.vm.space.today.length), 0);
        assert.equal(await page.evaluate(() => C.current?.vm.space.name), 'Target mail');
      });

      await t.test('refuses another window, profile, target, phase or theme before drawing', async () => {
        const mutations: [string, (h: ReturnType<typeof hello>) => void][] = [
          ['window', (h) => { h.across.switching.from.windowId++; }],
          ['source', (h) => { h.profile = 'unrelated'; }],
          ['same profile', (h) => { h.across.switching.profile = 'source'; }],
          ['target', (h) => { h.across.switching.profile = 'missing'; }],
          ['space', (h) => { h.across.switching.space = 'wrong'; }],
          ['rows', (h) => { h.across.switching.content.space = 'wrong'; }],
          ['phase', (h) => { h.across.switching.phase = 'landed'; }],
          ['package', (h) => { h.theme.id = 'wrong'; }],
          ['manifest', (h) => { h.theme.manifest = '{}'; }],
        ];
        for (const [name, change] of mutations) {
          const h = hello(id, dir); change(h);
          assert.ok(await mount(h), name);
          assert.equal(await page.locator('m-page, .switch-cover').count(), 0, `${name}: no stale DOM`);
        }
      });
      assert.deepEqual(seen.requests, []);
      assert.deepEqual(seen.errors, []);
      assert.deepEqual(await page.evaluate(() => C.posts), []);
    } finally {
      await page.evaluate(() => C.current?.destroy());
      await browser.close();
    }
  });
}
