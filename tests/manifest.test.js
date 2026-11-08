import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as shortcuts from '../extension/shared/shortcuts.js';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PACKAGE_THEMES } from '../extension/themes/packages.js';
import { FIRST_PAINT_MARK, firstPaintRoot } from '../extension/shared/page-box.js';

const root = new URL('../extension/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
const exists = (path) => existsSync(new URL(path, root));
// Every source file under extension/ with one of these extensions.
const sources = (exts, dir = '') => readdirSync(new URL(dir || '.', root)).flatMap((name) => {
  const path = `${dir}${name}`;
  return statSync(new URL(path, root)).isDirectory() ? sources(exts, `${path}/`) : exts.some((e) => name.endsWith(e)) ? [path] : [];
});

test('manifest follows the SPEC constraints', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, undefined, 'Safari does not support module background workers');
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  for (const p of ['tabs', 'storage']) assert.ok(manifest.permissions.includes(p), p);
  // A window's own layout reaches its pages as they commit (background/registered.js fixUp).
  assert.ok(manifest.permissions.includes('webNavigation'));
  for (const p of ['sidePanel', 'bookmarks', 'history', 'tabGroups']) assert.ok(!manifest.permissions.includes(p), p);
  const [cs] = manifest.content_scripts;
  assert.equal(cs.run_at, 'document_start');
  assert.equal(cs.all_frames, false);
  assert.equal(manifest.chrome_url_overrides.newtab, 'newtab/newtab.html');
  assert.ok(manifest.commands['toggle-sidebar']);
  assert.ok(manifest.commands['open-palette']);
  // No ⌃⌘ arrows as the browser's own command keys (Tirth, 2026-11-08): the navigation commands have none (Margin.app
  // holds the Settings keys, ⌥⌘ arrows by default; pages take them too). Never ⌘⌥ here: Chrome refuses the extension.
  for (const name of ['next-tab', 'prev-tab', 'next-space', 'prev-space']) assert.equal(manifest.commands[name].suggested_key, undefined, name);
  for (const c of Object.values(manifest.commands)) assert.doesNotMatch(JSON.stringify(c.suggested_key ?? {}), /(Command|Ctrl)\+Alt/);
});

test('every file the manifest and new tab reference exists', () => {
  const files = [
    manifest.background.service_worker,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((c) => c.js),
    ...(manifest.web_accessible_resources ?? []).flatMap((w) => w.resources),
    manifest.chrome_url_overrides.newtab,
    // Each built-in theme's package (read by the background and the new-tab page),
    // and its look at a page's first paint (scripts/build.js makes the registered file).
    ...PACKAGE_THEMES.flatMap((id) => ['theme.json', 'theme.html', 'theme.css', 'first-paint.css'].map((f) => `themes/${id}/${f}`)),
  ];
  const html = readFileSync(new URL('newtab/newtab.html', root), 'utf8');
  for (const [, ref] of html.matchAll(/(?:src|href)="([^"]+)"/g)) files.push(new URL(ref, new URL('newtab/', root)).pathname.split('/extension/')[1]);
  for (const f of files) assert.ok(exists(f), f);
});

test('all extension scripts parse', () => {
  const scripts = sources(['.js']);
  for (const s of scripts) execFileSync(process.execPath, ['--check', new URL(s, root).pathname]);
});

test('no third-party URLs in extension code (search engine templates excepted)', () => {
  const allowed = /duckduckgo\.com|google\.com|bing\.com|ecosia\.org|startpage\.com|www\.w3\.org/;
  for (const f of sources(['.js', '.css', '.html'])) {
    const text = readFileSync(new URL(f, root), 'utf8');
    for (const [url] of text.matchAll(/https?:\/\/[^\s'"`)$]+/g)) if (!url.endsWith("://")) assert.match(url, allowed, `${f}: ${url}`);
  }
});

test('nothing exposed to web pages, and nothing on web pages fetches or draws a theme', () => {
  assert.equal(manifest.web_accessible_resources, undefined, 'nothing exposed to web pages');
  assert.doesNotMatch(readFileSync(new URL('content/core.js', root), 'utf8'), /themePackage|ui\/runtime|ui\/host/, 'pages draw no theme (Margin.app does)');
  for (const f of sources(['.js']).filter((p) => p.startsWith('content/') || p.startsWith('themes/'))) {
    assert.ok(!readFileSync(new URL(f, root), 'utf8').includes('fetch('), `${f} must not fetch`);
  }
});

test('each built-in theme\'s first paint draws only on a page its own mark is on (a registration WebKit keeps applying after it was dropped paints nothing)', () => {
  for (const id of PACKAGE_THEMES) {
    const css = readFileSync(new URL(`themes/${id}/first-paint.css`, root), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/([^{}@]+)\{/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith('media'));
    assert.ok(selectors.length > 0, id);
    for (const selector of selectors) {
      for (const part of selector.split(',')) assert.ok(part.trim().startsWith(firstPaintRoot(id)), `${id}: ${part.trim()} is under ${FIRST_PAINT_MARK}="${id}"`);
    }
    assert.doesNotMatch(css, /url\(|@import/, `${id}: nothing to load`);
  }
});

test('the navigation commands have no keys of their own: the Settings shortcuts are the only ones', async () => {
  await import('../extension/shared/shortcuts.js');
  const { ACTIONS } = shortcuts;
  for (const action of Object.values(ACTIONS)) assert.equal(manifest.commands[action].suggested_key, undefined, action);
});

test('the page card has the same corner radius and shadow wherever it is drawn', () => {
  const read = (f) => readFileSync(new URL(f, root), 'utf8');
  const decl = (css, selector, prop) => {
    const block = css.slice(css.indexOf(selector));
    return block.match(new RegExp(`\\b${prop}: ([^;]+?)( !important)?;`))[1];
  };
  // The first paint and Arcadia's package: the same card shadow, then the frame
  // (its corner is the layout's, which Margin.app measures from the package).
  const pkg = read('themes/arcadia/theme.css');
  const radius = pkg.match(/\n  --card-radius: ([^;]+);/)[1];
  const shadow = decl(pkg, '.card-edge { pointer-events: none;', 'box-shadow');
  const frame = pkg.match(/\n  --frame: ([^;]+);/)[1];
  assert.equal(radius, '6.25px');
  const first = read('themes/arcadia/first-paint.css');
  assert.equal(decl(first, 'html[data-margin-at="arcadia"]::after', 'border-radius'), 'var(--margin-at-radius)');
  assert.equal(decl(first, 'html[data-margin-at="arcadia"]::after', 'box-shadow'), `${shadow}, 0 0 0 100vmax ${frame}`, 'the first paint: same shadow, then the frame');
  // Plain CSS only: nothing for the browser to load (no images, no url()).
  for (const css of [first, pkg]) assert.doesNotMatch(css, /border-image|url\(/);
});

test('no CSS corner-shape (yet): Safari\'s experimental version passes @supports but draws squares', () => {
  // Turning on Safari's "CSS corner-shape property" flag (Testable) made every
  // corner Margin gave a squircle draw square; WebKitGTK 2.52 with the same
  // flag draws them round. @supports can't tell, so Margin doesn't use it until
  // Safari ships it working (DECISIONS.md, Follow-ups).
  for (const f of sources(['.css', '.js'])) assert.doesNotMatch(readFileSync(new URL(f, root), 'utf8'), /corner-shape/, f);
});

test('Settings toggles are switches where supported (checkboxes elsewhere): Margin makes them so', () => {
  const render = readFileSync(new URL('ui/render.js', root), 'utf8');
  assert.match(render, /value === 'setting-toggle'\) \{ copy\.setAttribute\('type', 'checkbox'\); copy\.setAttribute\('switch', ''\);/);
});

test('Safari\'s commands: ⌘T the only one with a key (no ⌃⌘ arrows: Tirth, 2026-11-08); Chrome\'s none', async () => {
  const { manifestFor } = await import('../scripts/build.js');
  const keyed = (m) => Object.entries(m.commands).filter(([, c]) => c.suggested_key).map(([k]) => k).sort();
  const safari = manifestFor('safari');
  assert.deepEqual(keyed(safari), ['new-tab']);
  assert.equal(safari.commands['new-tab'].suggested_key.mac, 'Command+T');
  for (const name of ['next-tab', 'prev-tab', 'next-space', 'prev-space']) assert.ok(safari.commands[name], `${name}: still a command`);
  for (const [, c] of Object.entries(safari.commands)) assert.doesNotMatch(JSON.stringify(c.suggested_key ?? {}), /(Command|Ctrl)\+Alt/);
  assert.deepEqual(keyed(manifestFor('chrome')), []);
});
