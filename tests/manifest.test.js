import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('../extension/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
const exists = (path) => existsSync(new URL(path, root));

test('manifest follows the SPEC constraints', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  for (const p of ['tabs', 'storage']) assert.ok(manifest.permissions.includes(p), p);
  for (const p of ['sidePanel', 'bookmarks', 'history', 'tabGroups']) assert.ok(!manifest.permissions.includes(p), p);
  const [cs] = manifest.content_scripts;
  assert.equal(cs.run_at, 'document_start');
  assert.equal(cs.all_frames, false);
  assert.equal(manifest.chrome_url_overrides.newtab, 'newtab/newtab.html');
  assert.ok(manifest.commands['toggle-sidebar']);
  assert.ok(manifest.commands['open-palette']);
});

test('every file the manifest and new tab reference exists', () => {
  const files = [
    manifest.background.service_worker,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((c) => c.js),
    ...manifest.web_accessible_resources.flatMap((w) => w.resources),
    manifest.chrome_url_overrides.newtab,
  ];
  const html = readFileSync(new URL('newtab/newtab.html', root), 'utf8');
  for (const [, ref] of html.matchAll(/(?:src|href)="([^"]+)"/g)) files.push(new URL(ref, new URL('newtab/', root)).pathname.split('/extension/')[1]);
  for (const f of files) assert.ok(exists(f), f);
});

test('all extension scripts parse', () => {
  const scripts = [
    'background.js', 'state/model.js', 'newtab/newtab.js',
    ...manifest.content_scripts.flatMap((c) => c.js),
  ];
  for (const s of scripts) execFileSync(process.execPath, ['--check', new URL(s, root).pathname]);
});

test('no third-party URLs in extension code (search engine templates excepted)', () => {
  const allowed = /duckduckgo\.com|google\.com|bing\.com|ecosia\.org|startpage\.com|www\.w3\.org/;
  for (const f of ['background.js', 'state/model.js', 'shared/view.js', 'shared/ui.js', 'shared/search.js', 'shared/shortcuts.js',
    'content/sidebar.js', 'content/palette.js', 'content/sidebar.css', 'content/palette.css', 'newtab/newtab.html', 'newtab/newtab.js', 'newtab/newtab.css']) {
    const text = readFileSync(new URL(f, root), 'utf8');
    for (const [url] of text.matchAll(/https?:\/\/[^\s'"`)$]+/g)) if (!url.endsWith("://")) assert.match(url, allowed, `${f}: ${url}`);
  }
});
