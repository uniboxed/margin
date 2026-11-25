import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as shortcuts from '../extension/shared/shortcuts.ts';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PACKAGE_THEMES } from '../app/shared/ui/themes/packages.ts';

const root = new URL('../extension/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
// What the tests read of a manifest (parsed JSON): a command, a content script's entry, an exposed resource.
type ManifestCommand = { suggested_key?: { default?: string, mac?: string }, description?: string };
type Commands = Record<string, ManifestCommand>;
// Margin's window's UI and its themes (app/shared/ui/, from extension/ until 2026-11-22): the build copies the themes'
// files into each extension build's themes/ (scripts/build.ts buildTo).
const ui = new URL('../app/shared/ui/', import.meta.url);
const exists = (path: string, base = root) => existsSync(new URL(path, base));
// Every source file under extension/ (or `base`) with one of these extensions.
const sources = (exts: string[], dir = '', base = root): string[] => readdirSync(new URL(dir || '.', base)).flatMap((name) => {
  const path = `${dir}${name}`;
  return statSync(new URL(path, base)).isDirectory() ? sources(exts, `${path}/`, base) : exts.some((e) => name.endsWith(e)) ? [path] : [];
});
// Both: the extension's files, then the UI's (as ui/…), read with `read`.
const allSources = (exts: string[]) => [...sources(exts), ...sources(exts, '', ui).map((f) => `ui/${f}`)];
const source = (f: string) => readFileSync(f.startsWith('ui/') ? new URL(f.slice(3), ui) : new URL(f, root), 'utf8');

test('manifest follows the SPEC constraints', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, undefined, 'Safari does not support module background workers');
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  for (const p of ['tabs', 'storage']) assert.ok(manifest.permissions.includes(p), p);
  // A tab's page replaced, told to Margin.app as it commits (background.ts appLink.tabGone).
  assert.ok(manifest.permissions.includes('webNavigation'));
  for (const p of ['sidePanel', 'bookmarks', 'history', 'tabGroups']) assert.ok(!manifest.permissions.includes(p), p);
  const [cs] = manifest.content_scripts;
  assert.equal(cs.run_at, 'document_start');
  assert.equal(cs.all_frames, false);
  assert.equal(manifest.chrome_url_overrides.newtab, 'newtab/newtab.html');
  assert.ok(manifest.commands['toggle-sidebar']);
  assert.ok(manifest.commands['open-palette']);
  // No ⌃⌘ arrows as the browser's own command keys (decided 2026-11-08): the navigation commands have none (Margin.app
  // holds the Settings keys, ⌥⌘ arrows by default; pages take them too). Never ⌘⌥ here: Chrome refuses the extension.
  for (const name of ['next-tab', 'prev-tab', 'next-space', 'prev-space']) assert.equal(manifest.commands[name].suggested_key, undefined, name);
  for (const c of Object.values(manifest.commands as Commands)) assert.doesNotMatch(JSON.stringify(c.suggested_key ?? {}), /(Command|Ctrl)\+Alt/);
});

test('every file the manifest and new tab reference exists', () => {
  const files = [
    manifest.background.service_worker,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((c: { js: string[] }) => c.js),
    ...(manifest.web_accessible_resources ?? []).flatMap((w: { resources: string[] }) => w.resources),
    manifest.chrome_url_overrides.newtab,
  ];
  // Each built-in theme's package (read by the background and the new-tab page).
  for (const f of PACKAGE_THEMES.flatMap((id) => ['theme.json', 'theme.html', 'theme.css'].map((f) => `themes/${id}/${f}`))) assert.ok(exists(f, ui), f);
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
  for (const f of allSources(['.js', '.css', '.html'])) {
    const text = source(f);
    for (const [url] of text.matchAll(/https?:\/\/[^\s'"`)$]+/g)) if (!url.endsWith("://")) assert.match(url, allowed, `${f}: ${url}`);
  }
});

test('nothing exposed to web pages, and nothing on web pages fetches or draws a theme', () => {
  assert.equal(manifest.web_accessible_resources, undefined, 'nothing exposed to web pages');
  assert.doesNotMatch(readFileSync(new URL('content/core.ts', root), 'utf8'), /themePackage|ui\/runtime|ui\/host/, 'pages draw no theme (Margin.app does)');
  for (const f of allSources(['.js']).filter((p) => p.startsWith('content/') || p.startsWith('ui/themes/'))) {
    assert.ok(!source(f).includes('fetch('), `${f} must not fetch`);
  }
});

test('the navigation commands have no keys of their own: the Settings shortcuts are the only ones', async () => {
  await import('../extension/shared/shortcuts.ts');
  const { ACTIONS } = shortcuts;
  for (const action of Object.values(ACTIONS)) assert.equal(manifest.commands[action].suggested_key, undefined, action);
});

test('Arcadia\'s page card: its corner radius, shadow and frame, in plain CSS', () => {
  const read = (f: string) => readFileSync(new URL(f, ui), 'utf8');
  const decl = (css: string, selector: string, prop: string) => {
    const block = css.slice(css.indexOf(selector));
    return block.match(new RegExp(`\\b${prop}: ([^;]+?)( !important)?;`))![1]; // a missing one fails the test here
  };
  // Arcadia's package: its card's corner and shadow, and the frame.
  const pkg = read('themes/arcadia/theme.css');
  const radius = pkg.match(/\n  --card-radius: ([^;]+);/)![1];
  const shadow = decl(pkg, '.card-edge { pointer-events: none;', 'box-shadow');
  const frame = pkg.match(/\n  --frame: ([^;]+);/)![1];
  assert.equal(radius, '6px', 'Arc\'s (docs/ARC-SIDEBAR.md)');
  assert.ok(shadow && frame);
  // Plain CSS only: nothing for the browser to load (no images, no url()).
  assert.doesNotMatch(pkg, /border-image|url\(/);
});

test('no CSS corner-shape (yet): Safari\'s experimental version passes @supports but draws squares', () => {
  // Turning on Safari's "CSS corner-shape property" flag (Testable) made every
  // corner Margin gave a squircle draw square; WebKitGTK 2.52 with the same
  // flag draws them round. @supports can't tell, so Margin doesn't use it until
  // Safari ships it working (DECISIONS.md, Follow-ups).
  for (const f of allSources(['.css', '.js'])) assert.doesNotMatch(source(f), /corner-shape/, f);
});

test('Settings toggles are switches where supported (checkboxes elsewhere): Margin makes them so', () => {
  const render = readFileSync(new URL('render.ts', ui), 'utf8');
  assert.match(render, /value === 'setting-toggle'\) \{ copy\.setAttribute\('type', 'checkbox'\); copy\.setAttribute\('switch', ''\);/);
});

test('Safari\'s commands: ⌘T the only one with a key (no ⌃⌘ arrows since 2026-11-08); Chrome\'s none', async () => {
  const { manifestFor } = await import('../scripts/build.ts');
  const keyed = (m: { commands: Commands }) => Object.entries(m.commands).filter(([, c]) => c.suggested_key).map(([k]) => k).sort();
  const safari = manifestFor('safari');
  assert.deepEqual(keyed(safari), ['new-tab']);
  assert.equal(safari.commands['new-tab'].suggested_key.mac, 'Command+T');
  for (const name of ['next-tab', 'prev-tab', 'next-space', 'prev-space']) assert.ok(safari.commands[name], `${name}: still a command`);
  for (const [, c] of Object.entries(safari.commands as Commands)) assert.doesNotMatch(JSON.stringify(c.suggested_key ?? {}), /(Command|Ctrl)\+Alt/);
  assert.deepEqual(keyed(manifestFor('chrome')), []);
});
