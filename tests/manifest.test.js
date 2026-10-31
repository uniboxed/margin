import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as shortcuts from '../extension/shared/shortcuts.js';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildAssets, buildDocked, buildLegacyDocked, dockedWidths, DOCKED_WIDTHS } from '../scripts/build-styles.js';
import { THEMES } from '../extension/themes/index.js';
import { WIDTH, RAIL } from '../extension/themes/arcadium/theme.js';

const root = new URL('../extension/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
const exists = (path) => existsSync(new URL(path, root));
// Every source file under extension/ with one of these extensions.
const sources = (exts, dir = '') => readdirSync(new URL(dir || '.', root)).flatMap((name) => {
  const path = `${dir}${name}`;
  return statSync(new URL(path, root)).isDirectory() ? sources(exts, `${path}/`) : exts.some((e) => name.endsWith(e)) ? [path] : [];
});
const THEME_IDS = Object.keys(THEMES);

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
    // Registered at runtime by background/registered.js (and by earlier versions).
    ...THEME_IDS.flatMap((id) => dockedWidths(id).map((w) => `themes/${id}/docked/w-${w}.css`)),
    ...DOCKED_WIDTHS.map((w) => `content/docked/w-${w}.css`),
    ...THEME_IDS.flatMap((id) => [`themes/${id}/content.js`, `themes/${id}/newtab.js`]), // bundled by scripts/build.js
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

test('each theme\'s assets.js is up to date with its CSS and markup (run `npm run styles`)', () => {
  for (const id of THEME_IDS) assert.equal(readFileSync(new URL(`themes/${id}/assets.js`, root), 'utf8'), buildAssets(id), id);
});

test('themes carry their styles, and nothing on web pages fetches', () => {
  for (const f of ['themes/arcadium/content.js', 'themes/arcadium/palette.js']) {
    assert.match(readFileSync(new URL(f, root), 'utf8'), /^import \{ \w+Css \} from '\.\/assets\.js';$/m, `${f} bundles its CSS`);
  }
  assert.equal(manifest.web_accessible_resources, undefined, 'nothing exposed to web pages');
  for (const f of sources(['.js']).filter((p) => p.startsWith('content/') || p.startsWith('themes/'))) {
    assert.ok(!readFileSync(new URL(f, root), 'utf8').includes('fetch('), `${f} must not fetch`);
  }
});

test('first-paint placeholders: one up-to-date file per sidebar width, nothing else', () => {
  const expected = [];
  for (let w = WIDTH.min; w <= WIDTH.max; w += WIDTH.step) expected.push(w);
  assert.deepEqual(DOCKED_WIDTHS, expected, 'build script widths match Arcadium\'s theme.js');
  const names = expected.map((w) => `w-${w}.css`).sort();
  assert.deepEqual(readdirSync(new URL('themes/arcadium/docked/', root)).sort(), [...names, 'rail.css'].sort());
  // The old path stays for Safari's stored registrations (same content).
  assert.deepEqual(readdirSync(new URL('content/docked/', root)).sort(), names);
  // The narrow rail's (pages pushed with "Keep open", theme.js RAIL).
  assert.equal(readFileSync(new URL('themes/arcadium/docked/rail.css', root), 'utf8'), buildDocked('arcadium', RAIL), 'rail.css is stale: run npm run styles');
  for (const w of expected) {
    const css = readFileSync(new URL(`themes/arcadium/docked/w-${w}.css`, root), 'utf8');
    assert.equal(css, buildDocked('arcadium', w), `w-${w}.css is stale: run npm run styles`);
    assert.equal(readFileSync(new URL(`content/docked/w-${w}.css`, root), 'utf8'), buildLegacyDocked(w), `content/docked/w-${w}.css is stale`);
    assert.equal(css.replace(/\/\*[\s\S]*?\*\//g, '').match(new RegExp(`${w}px`, 'g')).length, 4, 'margin-left, the frame edge, and the loader pill (twice)');
    assert.ok(!css.includes('{{WIDTH}}'));
  }
});

test('manifest command keys are the default navigation shortcuts', async () => {
  await import('../extension/shared/shortcuts.js');
  const { NAVIGATION, ACTIONS } = shortcuts;
  const toManifest = (s) => s.replace('Ctrl+Meta+', 'MacCtrl+Command+').replace('Arrow', '');
  for (const [name, action] of Object.entries(ACTIONS)) {
    assert.equal(manifest.commands[action].suggested_key.mac, toManifest(NAVIGATION[name]), name);
  }
});

test('the page card has the same corner radius and shadow wherever it is drawn', () => {
  const read = (f) => readFileSync(new URL(f, root), 'utf8');
  const decl = (css, selector, prop) => {
    const block = css.slice(css.indexOf(selector));
    return block.match(new RegExp(`\\b${prop}: ([^;]+?)( !important)?;`))[1];
  };
  const sidebar = read('themes/arcadium/styles/sidebar.css');
  const radius = decl(sidebar, '.frame .hole, .card-edge {', 'border-radius');
  const shadow = decl(sidebar, '.card-edge {\n  right: auto', 'box-shadow');
  assert.equal(radius, '6.25px');
  const docked = read('themes/arcadium/docked.template.css');
  assert.equal(decl(docked, 'html:not([data-margin-docked="off"])::after', 'border-radius'), radius);
  assert.ok(decl(docked, 'html:not([data-margin-docked="off"])::after', 'box-shadow').startsWith(`${shadow}, 0 0 0 100vmax`), 'placeholder: same shadow, then the frame');
  const newtab = read('themes/arcadium/styles/newtab.css');
  assert.equal(decl(newtab, '#launcher, #page-card {', 'border-radius'), radius);
  assert.equal(decl(newtab, '#page-card {\n', 'box-shadow'), shadow);
  // The fitted layout's card (content/shell.js) and the theme's geometry
  // (content.js) agree with the CSS.
  assert.match(read('themes/arcadium/content.js'), new RegExp(`geometry: \\{ inset: 8, radius: '${radius}', rail: RAIL \\}`));
  assert.match(read('content/shell.js'), new RegExp(`let layout = \\{ docked: true, width: 260, inset: 8, radius: '${radius}' \\};`));
  // Plain CSS only: nothing for the browser to load (no images, no url()).
  for (const css of [sidebar, docked, newtab]) assert.doesNotMatch(css, /border-image|url\(/);
});

test('no CSS corner-shape (yet): Safari\'s experimental version passes @supports but draws squares', () => {
  // Turning on Safari's "CSS corner-shape property" flag (Testable) made every
  // corner Margin gave a squircle draw square; WebKitGTK 2.52 with the same
  // flag draws them round. @supports can't tell, so Margin doesn't use it until
  // Safari ships it working (DECISIONS.md, Follow-ups).
  for (const f of sources(['.css', '.js'])) assert.doesNotMatch(readFileSync(new URL(f, root), 'utf8'), /corner-shape/, f);
});

test('Settings toggles are switches where supported (checkboxes elsewhere)', () => {
  const html = readFileSync(new URL('themes/arcadium/newtab.html', root), 'utf8');
  for (const id of ['block-gestures', 'pull-to-refresh', 'swipe-navigation']) assert.match(html, new RegExp(`id="${id}" type="checkbox" switch`), id);
});

test('Safari\'s commands: ⌘T takes ⌃⌘←\'s slot (four shortcuts at most); Chrome\'s stay the arrows', async () => {
  const { manifestFor } = await import('../scripts/build.js');
  const keyed = (m) => Object.entries(m.commands).filter(([, c]) => c.suggested_key).map(([k]) => k).sort();
  const safari = manifestFor('safari');
  assert.deepEqual(keyed(safari), ['new-tab', 'next-space', 'next-tab', 'prev-tab']);
  assert.equal(safari.commands['new-tab'].suggested_key.mac, 'Command+T');
  assert.ok(safari.commands['prev-space'], 'still a command (the page\'s ⌃⌘← keeps working)');
  for (const [, c] of Object.entries(safari.commands)) assert.doesNotMatch(JSON.stringify(c.suggested_key ?? {}), /(Command|Ctrl)\+Alt/);
  for (const name of ['toggle-sidebar', 'open-palette', 'next-tab', 'prev-tab', 'next-space']) assert.deepEqual(safari.commands[name], manifest.commands[name], name);
  assert.deepEqual(keyed(manifestFor('chrome')), ['next-space', 'next-tab', 'prev-space', 'prev-tab']);
});
