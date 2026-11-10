// The active theme's package for pages (extension/background/theme-package.ts):
// read from the extension's files, the files theme.json names and no others,
// kept in storage.local for pages (`uiTheme`) and rewritten only when it
// changed; pages read it once, not with every read of the state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fakeBrowser } from './fake-browser.ts';

const store: Record<string, any> = {}; // stored JSON
const sets: string[][] = [];
globalThis.browser = fakeBrowser({
  runtime: { getURL: (p) => `file://${new URL(`../extension/${p}`, import.meta.url).pathname}`, getManifest: () => ({ version: '9.9' }) },
  storage: { local: {
    // Asked by a key or keys here (never everything).
    get: async (keys) => Object.fromEntries(([] as string[]).concat(keys as string | string[]).filter((k) => k in store).map((k) => [k, store[k]])),
    set: async (items) => { sets.push(Object.keys(items)); Object.assign(store, items); },
  } },
});
const fileFetch = async (url: string) => {
  try {
    const bytes = await readFile(new URL(url));
    return { ok: true, status: 200, text: async () => bytes.toString('utf8'), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  } catch {
    return { ok: false, status: 404 };
  }
};
globalThis.fetch = (fileFetch as unknown as typeof fetch); // a file's text or bytes: what theme-package.ts reads of a Response
const { readThemePackage, storeActiveTheme, activeThemeId, STORED_THEME } = await import('../extension/background/theme-package.ts');
const { pageKeys } = await import('../extension/shared/stored.ts');

test('a built-in theme\'s package: its three texts and the files theme.json names, as base64', async () => {
  const neo = await readThemePackage('neubrutalism');
  assert.equal(neo.id, 'neubrutalism');
  assert.ok(neo.html.includes('<m-page'));
  assert.deepEqual(Object.keys(neo.files).sort(), ['fonts/archivo-black-latin-ext.woff2', 'fonts/archivo-black-latin.woff2', 'fonts/space-grotesk-latin-ext.woff2', 'fonts/space-grotesk-latin.woff2']);
  assert.ok(Object.values(neo.files).every((b) => /^[A-Za-z0-9+/]+=*$/.test(b)));
  const arcadia = await readThemePackage('arcadia');
  assert.deepEqual(arcadia.files, {}, 'Arcadia bundles nothing (and its first-paint files aren\'t the package\'s)');
  await assert.rejects(readThemePackage('../../evil'), /no built-in theme/);
  assert.equal(activeThemeId({ theme: 'neubrutalism' }), 'neubrutalism');
  assert.equal(activeThemeId({ theme: 'gone' }), 'arcadia');
});

test('the active theme is kept in storage for pages, written again only when it changed', async () => {
  store.settings = { theme: 'arcadia' };
  await storeActiveTheme();
  assert.equal(store[STORED_THEME].id, 'arcadia');
  assert.equal(store[STORED_THEME].version, '9.9');
  assert.equal(store[STORED_THEME].pkg.id, 'arcadia');
  const writes = sets.length;
  await storeActiveTheme();
  assert.equal(sets.length, writes, 'the same package: not written again');
  store[STORED_THEME] = { ...store[STORED_THEME], pkg: { ...store[STORED_THEME].pkg, css: 'old' } };
  await storeActiveTheme();
  assert.equal(sets.length, writes + 1, 'another build\'s files (the same version): written again');
  store.settings = { theme: 'neubrutalism' };
  await storeActiveTheme();
  assert.equal(store[STORED_THEME].id, 'neubrutalism');
  assert.ok(!pageKeys([STORED_THEME]).includes(STORED_THEME), 'pages read it once (their first, full read), not with every read');
});
