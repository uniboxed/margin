// The active theme's package for pages (extension/background/theme-package.ts):
// read from the extension's files, the files theme.json names and no others,
// kept in storage.local for pages (`uiTheme`) and rewritten only when it
// changed; pages read it once, not with every read of the state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const store = {};
const sets = [];
globalThis.browser = {
  runtime: { getURL: (p) => `file://${new URL(`../extension/${p}`, import.meta.url).pathname}`, getManifest: () => ({ version: '9.9' }) },
  storage: { local: {
    get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]])),
    set: async (items) => { sets.push(Object.keys(items)); Object.assign(store, items); },
  } },
};
const fileFetch = async (url) => {
  try {
    const bytes = await readFile(new URL(url));
    return { ok: true, status: 200, text: async () => bytes.toString('utf8'), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  } catch {
    return { ok: false, status: 404 };
  }
};
globalThis.fetch = (fileFetch as any);
const { readThemePackage, storeActiveTheme, activeThemeId, STORED_THEME } = await import('../extension/background/theme-package.ts');
const { pageKeys } = await import('../extension/shared/stored.ts');

test('a built-in theme\'s package: its three texts and the files theme.json names, as base64', async () => {
  const neo = await readThemePackage('neo-brutalism');
  assert.equal(neo.id, 'neo-brutalism');
  assert.ok(neo.html.includes('<m-page'));
  assert.deepEqual(Object.keys(neo.files).sort(), ['fonts/archivo-black-latin-ext.woff2', 'fonts/archivo-black-latin.woff2', 'fonts/space-grotesk-latin-ext.woff2', 'fonts/space-grotesk-latin.woff2']);
  assert.ok(Object.values(neo.files).every((b) => /^[A-Za-z0-9+/]+=*$/.test(b)));
  const arcadia = await readThemePackage('arcadia');
  assert.deepEqual(arcadia.files, {}, 'Arcadia bundles nothing (and its first-paint files aren\'t the package\'s)');
  await assert.rejects(readThemePackage('../../evil'), /no built-in theme/);
  assert.equal(activeThemeId({ theme: 'neo-brutalism' }), 'neo-brutalism');
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
  store.settings = { theme: 'neo-brutalism' };
  await storeActiveTheme();
  assert.equal(store[STORED_THEME].id, 'neo-brutalism');
  assert.ok(!pageKeys([STORED_THEME]).includes(STORED_THEME), 'pages read it once (their first, full read), not with every read');
});
