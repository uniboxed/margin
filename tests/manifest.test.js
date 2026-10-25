import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../extension/shared/platform.js';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildStyles, buildDocked, DOCKED_WIDTHS } from '../scripts/build-styles.js';
import { readdirSync } from 'node:fs';
import '../extension/shared/view.js';

const root = new URL('../extension/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
const exists = (path) => existsSync(new URL(path, root));

test('manifest follows the SPEC constraints', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, undefined, 'Safari does not support module background workers');
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  for (const p of ['tabs', 'storage']) assert.ok(manifest.permissions.includes(p), p);
  for (const p of ['sidePanel', 'bookmarks', 'history', 'tabGroups']) assert.ok(!manifest.permissions.includes(p), p);
  const [cs] = manifest.content_scripts;
  assert.equal(cs.run_at, 'document_start');
  assert.equal(cs.all_frames, false);
  assert.equal(manifest.chrome_url_overrides.newtab, 'newtab/newtab.html');
  assert.ok(manifest.commands['toggle-sidebar']);
  assert.ok(manifest.commands['open-palette']);
  // Max 4 commands with shortcuts (Chrome and Safari/WebKit): the ⌃⌘ arrows.
  // Never ⌘⌥ ("Command+Alt"/"Ctrl+Alt"): Chrome then refuses the whole extension.
  const withKeys = Object.entries(manifest.commands).filter(([, c]) => c.suggested_key);
  assert.deepEqual(withKeys.map(([k]) => k).sort(), ['next-space', 'next-tab', 'prev-space', 'prev-tab']);
  for (const [, c] of withKeys) {
    assert.match(c.suggested_key.mac, /^MacCtrl\+Command\+(Up|Down|Left|Right)$/);
    assert.doesNotMatch(JSON.stringify(c.suggested_key), /(Command|Ctrl)\+Alt/);
  }
});

test('every file the manifest and new tab reference exists', () => {
  const files = [
    manifest.background.service_worker,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((c) => c.js),
    ...(manifest.web_accessible_resources ?? []).flatMap((w) => w.resources),
    manifest.chrome_url_overrides.newtab,
    ...DOCKED_WIDTHS.map((w) => `content/docked/w-${w}.css`), // registered at runtime by background.js
  ];
  const html = readFileSync(new URL('newtab/newtab.html', root), 'utf8');
  for (const [, ref] of html.matchAll(/(?:src|href)="([^"]+)"/g)) files.push(new URL(ref, new URL('newtab/', root)).pathname.split('/extension/')[1]);
  for (const f of files) assert.ok(exists(f), f);
});

test('all extension scripts parse', () => {
  const scripts = [
    'background.js', 'state/model.js', 'newtab/newtab.js', 'shared/icons.js',
    ...manifest.content_scripts.flatMap((c) => c.js),
  ];
  for (const s of scripts) execFileSync(process.execPath, ['--check', new URL(s, root).pathname]);
});

test('no third-party URLs in extension code (search engine templates excepted)', () => {
  const allowed = /duckduckgo\.com|google\.com|bing\.com|ecosia\.org|startpage\.com|www\.w3\.org/;
  for (const f of ['background.js', 'state/model.js', 'shared/view.js', 'shared/ui.js', 'shared/search.js', 'shared/shortcuts.js', 'shared/icons.js',
    'content/sidebar.js', 'content/palette.js', 'content/sidebar.css', 'content/palette.css', 'content/docked.template.css', 'newtab/newtab.html', 'newtab/newtab.js', 'newtab/newtab.css']) {
    const text = readFileSync(new URL(f, root), 'utf8');
    for (const [url] of text.matchAll(/https?:\/\/[^\s'"`)$]+/g)) if (!url.endsWith("://")) assert.match(url, allowed, `${f}: ${url}`);
  }
});

test('content/styles.js is up to date with the CSS files (run `npm run styles`)', () => {
  assert.equal(readFileSync(new URL('content/styles.js', root), 'utf8'), buildStyles());
});

test('content scripts load styles before the UI, without fetching anything', () => {
  const js = manifest.content_scripts[0].js;
  assert.ok(js.indexOf('content/styles.js') < js.indexOf('content/sidebar.js'));
  assert.equal(manifest.web_accessible_resources, undefined, 'nothing exposed to web pages');
  for (const f of ['content/sidebar.js', 'content/palette.js', 'shared/ui.js']) {
    assert.ok(!readFileSync(new URL(f, root), 'utf8').includes('fetch('), `${f} must not fetch`);
  }
});

test('first-paint placeholders: one up-to-date file per sidebar width, nothing else', () => {
  const { WIDTH } = globalThis.Margin.view;
  const expected = [];
  for (let w = WIDTH.min; w <= WIDTH.max; w += WIDTH.step) expected.push(w);
  assert.deepEqual(DOCKED_WIDTHS, expected, 'build script widths match shared/view.js');
  assert.deepEqual(readdirSync(new URL('content/docked/', root)).sort(), expected.map((w) => `w-${w}.css`).sort());
  for (const w of expected) {
    const css = readFileSync(new URL(`content/docked/w-${w}.css`, root), 'utf8');
    assert.equal(css, buildDocked(w), `w-${w}.css is stale: run npm run styles`);
    assert.equal(css.replace(/\/\*[\s\S]*?\*\//g, '').match(new RegExp(`${w}px`, 'g')).length, 4, 'margin-left, the frame edge, and the loader pill (twice)');
    assert.ok(!css.includes('{{WIDTH}}'));
  }
});

test('manifest command keys are the default navigation shortcuts', async () => {
  await import('../extension/shared/shortcuts.js');
  const { NAVIGATION, ACTIONS } = globalThis.Margin.shortcuts;
  const toManifest = (s) => s.replace('Ctrl+Meta+', 'MacCtrl+Command+').replace('Arrow', '');
  for (const [name, action] of Object.entries(ACTIONS)) {
    assert.equal(manifest.commands[action].suggested_key.mac, toManifest(NAVIGATION[name]), name);
  }
});

test('page card corners/shadow are current wherever the card is drawn (run `npm run styles`)', async () => {
  const { PAGE_CARD_FILES, withPageCard } = await import('../scripts/build-styles.js');
  const { pageCardImage, squirclePath, CARD } = await import('../scripts/page-card.js');
  for (const f of PAGE_CARD_FILES) {
    const css = readFileSync(new URL(f, root), 'utf8');
    assert.match(css, /\/\* page-card!?: generated/, `${f} has a page-card block`);
    assert.equal(css, withPageCard(css), `${f}: page-card block is stale`);
  }
  // The live frame and the first-paint placeholder use the same image.
  const url = (f) => readFileSync(new URL(f, root), 'utf8').match(/border-image: (url\("[^"]+"\))/)[1];
  assert.equal(url('content/sidebar.css'), url('content/docked.template.css'));
  assert.equal(url('content/sidebar.css'), url('newtab/newtab.css'));
  const { size, slice, outset, inset } = pageCardImage();
  assert.equal(size, 2 * slice + 2);
  assert.ok(inset >= (1 + CARD.smoothing) * CARD.radius, 'corner fits inside the corner slice');
  assert.ok(outset >= Math.max(...CARD.shadows.map((s) => s.dy + 3 * s.sigma)), 'shadow fits inside the outset');
  assert.throws(() => squirclePath(0, 0, 10, 10, CARD), /too large/);
});
