// Theme packages (extension/ui/theme-schema.ts, theme-loader.ts): theme.json
// against its schema, the settings' value checks and CSS variables, the size
// caps, reading a built-in theme's files, and the stored format of a user's.
// Loading into a document (fonts, sheets) runs in real engines:
// tests/theme/browser.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { THEME_SCHEMA, checkManifest, settingValueOk, MODES } from '../extension/ui/theme-schema.ts';
import {
  BUILTIN_THEMES, PACKAGE_LIMITS, checkPackage, sanitizeTheme, resolveSettings, settingsCss, settingVar,
  readBuiltinTheme, encodeStoredTheme, decodeStoredTheme, saveUserTheme, userThemeKey, USER_THEMES, type ThemePackage,
} from '../extension/ui/theme-loader.ts';
import { readTheme, NEO } from './theme/package.ts';

const base = { format: 2, id: 'my-theme', name: 'My theme', version: '1.2.3' };
const check = (extra: Record<string, unknown>, files: string[] = []) => checkManifest(JSON.stringify({ ...base, ...extra }), { files });

// --- theme.json ------------------------------------------------------------------

test('theme.json: a full good manifest is kept as written, with defaults filled in', () => {
  const r = check({
    author: 'Someone', description: 'A theme.', licence: 'OFL',
    modes: ['fullscreen', 'inpage'],
    layout: { reveal: 'right', sidebarMin: 200, sidebarMax: 400, sidebarDefault: 300 },
    fonts: [{ family: 'Grotesk', file: 'fonts/g.woff2', weight: 400 }, { family: 'Grotesk', file: 'fonts/g-i.woff2', weight: '300 700', style: 'italic', unicodeRange: 'U+0000-00FF, U+0131' }],
    images: ['images/dots.png'],
    settings: {
      accent: { type: 'color', default: '#ffd23f', label: 'Accent' },
      gutter: { type: 'length', default: '16px', min: 0, max: 48 },
      columns: { type: 'number', default: 2, min: 1, max: 4, step: 1 },
      corners: { type: 'choice', default: 'round', choices: ['round', 'square'] },
      dots: { type: 'toggle', default: true },
    },
  }, ['fonts/g.woff2', 'fonts/g-i.woff2', 'images/dots.png']);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.removed, []);
  const m = r.manifest;
  assert.deepEqual(m.fonts, [
    { family: 'Grotesk', file: 'fonts/g.woff2', weight: '400', style: 'normal' },
    { family: 'Grotesk', file: 'fonts/g-i.woff2', weight: '300 700', style: 'italic', unicodeRange: 'U+0000-00FF, U+0131' },
  ]);
  assert.deepEqual(m.modes, ['fullscreen', 'inpage']);
  assert.deepEqual(m.layout, { reveal: 'right', sidebarMin: 200, sidebarMax: 400, sidebarDefault: 300 });
  assert.deepEqual(m.images, ['images/dots.png']);
  assert.deepEqual(Object.keys(m.settings), ['accent', 'gutter', 'columns', 'corners', 'dots']);
  // The least a manifest can be.
  const least = checkManifest(JSON.stringify({ id: 'x', name: 'X', version: '0.0.1' }));
  assert.deepEqual(least.errors, []);
  assert.deepEqual(least.manifest.modes, [...MODES], 'every mode, by default');
  assert.deepEqual([least.manifest.fonts, least.manifest.images, least.manifest.settings, least.manifest.layout], [[], [], {}, {}]);
});

test('theme.json: the built-in themes pass', async () => {
  for (const id of BUILTIN_THEMES) {
    const t = readTheme(new URL(`../extension/themes/${id}/`, import.meta.url).pathname);
    const r = checkManifest(t.manifest, { files: Object.keys(t.files) });
    assert.deepEqual([r.errors, r.removed], [[], []], id);
    assert.equal(r.manifest.id, id);
  }
});

test('theme.json: what refuses a theme (its identity, the format, not JSON)', () => {
  const bad = (text: string, pattern: RegExp) => {
    const r = checkManifest(text);
    assert.equal(r.manifest, null, text);
    assert.match(r.errors.join('\n'), pattern, text);
  };
  bad('nope', /theme\.json/);
  bad('[]', /not an object/);
  bad('null', /not an object/);
  bad(JSON.stringify({ name: 'X', version: '1.0.0' }), /id missing/);
  bad(JSON.stringify({ ...base, id: 'X Y' }), /bad id/);
  bad(JSON.stringify({ ...base, id: '../x' }), /bad id/);
  bad(JSON.stringify({ ...base, name: '<img src=x onerror=alert(1)>' }), /bad name/);
  bad(JSON.stringify({ ...base, name: '' }), /bad name/);
  bad(JSON.stringify({ ...base, version: '1.0' }), /bad version/);
  bad(JSON.stringify({ ...base, format: 3 }), /bad format/);
  bad(JSON.stringify({ ...base, modes: ['fullscreen', 'tv'] }), /bad modes/);
  bad(JSON.stringify({ ...base, modes: ['inpage', 'inpage'] }), /bad modes/);
  bad(JSON.stringify({ ...base, layout: { sidebarMin: 400, sidebarMax: 200 } }), /bad layout/);
  bad(JSON.stringify({ ...base, layout: { sidebarMin: 100, sidebarMax: 200, sidebarDefault: 300 } }), /bad layout/);
  bad(JSON.stringify({ ...base, layout: { sidebarMax: 1e9 } }), /bad layout/);
  bad(JSON.stringify({ ...base, layout: { reveal: 'diagonal' } }), /bad layout/);
  bad(JSON.stringify({ ...base, author: 'x'.repeat(81) }), /bad author/);
  bad(JSON.stringify({ ...base, settings: [] }), /bad settings/);
  bad(`{"id":"x","name":"X","version":"1.0.0","pad":"${'x'.repeat(40000)}"}`, /larger than/);
  // Every bad field is said, not just the first.
  assert.equal(checkManifest(JSON.stringify({ id: 'X', name: '', version: 'v' })).errors.length, 3);
});

test('theme.json: what\'s removed and reported (unknown fields, bad fonts, images and settings), the rest kept', () => {
  const r = check({
    script: 'alert(1)', onload: 'x',
    fonts: [
      { family: 'Good', file: 'fonts/a.woff2' },
      { family: 'Remote', file: 'https://evil.test/b.woff2' },
      { family: 'Up', file: '../a.woff2' },
      { family: 'Not woff2', file: 'fonts/a.ttf' },
      { family: 'Missing', file: 'fonts/none.woff2' },
      { family: 'C"; src:url(x)', file: 'fonts/a.woff2' },
      { family: 'Weight', file: 'fonts/a.woff2', weight: 'bold' },
      { family: 'Range', file: 'fonts/a.woff2', unicodeRange: 'U+0-FF; } * { color: red' },
      { family: 'Extra', file: 'fonts/a.woff2', src: 'url(https://evil.test/f)' },
      'a string',
    ],
    images: ['images/a.png', 'https://evil.test/i.png', 'images/a.png', 'theme.html', 'images/none.png'],
    settings: {
      accent: { type: 'color', default: 'url(https://evil.test/beacon)' },
      quote: { type: 'color', default: '"red"' },
      escape: { type: 'color', default: '\\72 ed' },
      loud: { type: 'color', default: 'red !important' },
      expr: { type: 'color', default: 'expression(alert(1))' },
      len: { type: 'length', default: '16kg' },
      far: { type: 'length', default: '100px', max: 50 },
      num: { type: 'number', default: 'many' },
      pick: { type: 'choice', default: 'c', choices: ['a', 'b'] },
      nochoices: { type: 'choice', default: 'a' },
      flag: { type: 'toggle', default: 'yes' },
      kind: { type: 'script', default: 'x' },
      'bad-name': { type: 'color', default: 'red' },
      Upper: { type: 'color', default: 'red' },
      gap: { type: 'length', default: '16px' },
      tint: { type: 'color', default: 'oklch(70% 0.1 200)', onchange: 'x' },
    },
  }, ['fonts/a.woff2', 'fonts/a.ttf', 'images/a.png', 'theme.html']);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.manifest.fonts.map((f: { family: string }) => f.family), ['Good', 'Extra']);
  assert.deepEqual(r.manifest.fonts[1], { family: 'Extra', file: 'fonts/a.woff2', weight: '400', style: 'normal' }, 'an unknown field in a font goes, the font stays');
  assert.deepEqual(r.manifest.images, ['images/a.png']);
  assert.deepEqual(Object.keys(r.manifest.settings), ['gap', 'tint']);
  assert.deepEqual(r.manifest.settings.tint, { type: 'color', default: 'oklch(70% 0.1 200)' });
  const names = r.removed.map((x) => x.name);
  for (const name of ['script', 'onload', 'fonts[1]', 'fonts[2]', 'fonts[3]', 'fonts[4]', 'fonts[5]', 'fonts[6]', 'fonts[7]', 'fonts[8].src', 'fonts[9]', 'images[1]', 'images[2]', 'images[3]', 'images[4]',
    'settings.accent', 'settings.quote', 'settings.escape', 'settings.loud', 'settings.expr', 'settings.len', 'settings.far', 'settings.num', 'settings.pick', 'settings.nochoices', 'settings.flag', 'settings.kind', 'settings.bad-name', 'settings.Upper', 'settings.tint.onchange']) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(r.removed.every((x) => typeof x.reason === 'string' && x.reason.length));
  assert.deepEqual([...new Set(r.removed.map((x) => x.kind))].sort(), ['font', 'image', 'manifest', 'setting']);
});

test('theme.json: lists and maps are capped', () => {
  const fonts = Array.from({ length: 20 }, () => ({ family: 'A', file: 'fonts/a.woff2' }));
  const settings = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, { type: 'number', default: i }]));
  const r = check({ fonts, settings }, ['fonts/a.woff2']);
  assert.equal(r.manifest.fonts.length, 16);
  assert.equal(Object.keys(r.manifest.settings).length, 32);
  assert.equal(r.removed.length, 4 + 8);
});

test('the schema is plain data (JSON) with every top-level field described', () => {
  const copy = JSON.parse(JSON.stringify(THEME_SCHEMA));
  assert.deepEqual(copy, THEME_SCHEMA);
  assert.deepEqual(Object.keys(THEME_SCHEMA.properties).sort(), ['author', 'description', 'fonts', 'format', 'id', 'images', 'layout', 'licence', 'modes', 'name', 'settings', 'version']);
  assert.deepEqual(THEME_SCHEMA.required, ['id', 'name', 'version']);
});

// --- Settings ------------------------------------------------------------------

test('setting values: checked at run time like a bound CSS value (no url(), strings, escapes, !important)', () => {
  const color = { type: 'color' };
  for (const good of ['#fff', '#ffd23f80', 'red', 'rgb(1 2 3)', 'hsl(10 50% 50%)', 'color-mix(in srgb, red 50%, blue)']) assert.equal(settingValueOk(color, good), true, good);
  for (const bad of ['url(https://evil.test/x)', 'u\\72l(x)', '"red"', "'red'", 'red !important', 'red;background:url(x)', 'expression(1)', 'var(--x, url(x))', 'image-set("x" 1x)', 'attr(title)', 'red}', '', 5, null, true, 'x'.repeat(300), 'red\nblue']) {
    assert.equal(settingValueOk(color, bad), false, String(bad));
  }
  const length = { type: 'length', min: 0, max: 40 };
  assert.equal(settingValueOk(length, '16px'), true);
  assert.equal(settingValueOk(length, '1.5rem'), true);
  assert.equal(settingValueOk(length, 0), true);
  for (const bad of ['41px', '-1px', '16', 'calc(1px + url(x))', '16px !important', 'url(x)']) assert.equal(settingValueOk(length, bad), false, bad);
  const number = { type: 'number', min: 1, max: 4 };
  assert.equal(settingValueOk(number, 2), true);
  assert.equal(settingValueOk(number, '3'), true);
  for (const bad of [0, 5, NaN, Infinity, '2px', '1e3', null]) assert.equal(settingValueOk(number, bad), false, String(bad));
  const choice = { type: 'choice', choices: ['round', 'square'] };
  assert.equal(settingValueOk(choice, 'round'), true);
  assert.equal(settingValueOk(choice, 'oval'), false);
  assert.equal(settingValueOk({ type: 'toggle' }, false), true);
  assert.equal(settingValueOk({ type: 'toggle' }, 'false'), false);
  assert.equal(settingValueOk({ type: 'nope' }, 'x'), false);
});

test('settings: the user\'s saved values where good, else the theme\'s defaults; as CSS variables', () => {
  const { manifest } = check({ settings: {
    accent: { type: 'color', default: '#ffd23f' },
    gutterSize: { type: 'length', default: '16px', max: 40 },
    dots: { type: 'toggle', default: true },
    corners: { type: 'choice', default: 'round', choices: ['round', 'square'] },
  } });
  assert.deepEqual(resolveSettings(manifest, null), { accent: '#ffd23f', gutterSize: '16px', dots: true, corners: 'round' });
  const saved = { accent: 'url(https://evil.test/beacon)', gutterSize: '24px', dots: false, corners: 'square', extra: 'x', __proto__: { polluted: 1 } };
  const values = resolveSettings(manifest, saved);
  assert.deepEqual(values, { accent: '#ffd23f', gutterSize: '24px', dots: false, corners: 'square' }, 'a bad saved value falls back; unknown ones are left out');
  assert.equal(settingVar('gutterSize'), '--m-gutter-size');
  assert.equal(settingsCss(values), ':host,:root{--m-accent:#ffd23f;--m-gutter-size:24px;--m-dots:0;--m-corners:square}');
  assert.equal(settingsCss({}), '');
  // Checked again on the way out, whatever handed it over.
  assert.equal(settingsCss({ a: 'url(x)', 'b;}*{x': 'red', c: '"s"', ok: 3 }), ':host,:root{--m-ok:3}');
});

// --- The package --------------------------------------------------------------

const neo = () => readTheme(NEO);
const bytes = (n: number) => new Uint8Array(n);

test('package caps and file kinds', () => {
  assert.deepEqual(checkPackage(neo()), [], 'Neubrutalism is within them');
  const ok = { manifest: '{}', html: '', css: '', files: {} };
  assert.deepEqual(checkPackage(ok), []);
  // Files as they may come (checkPackage checks them: a text where bytes go too).
  const errs = (files: Record<string, unknown>, extra = {}) => checkPackage({ ...ok, ...extra, files } as ThemePackage).join('\n');
  assert.match(errs({ 'fonts/big.woff2': bytes(PACKAGE_LIMITS.fontBytes + 1) }), /font larger/);
  assert.match(errs({ 'images/big.png': bytes(PACKAGE_LIMITS.imageBytes + 1) }), /image larger/);
  assert.match(errs({ 'notes.txt': bytes(PACKAGE_LIMITS.noteBytes + 1) }), /note larger/);
  assert.match(errs({ 'run.js': bytes(10) }), /not a file a theme may bundle/);
  assert.match(errs({ 'page.html': bytes(10) }), /not a file a theme may bundle/);
  assert.match(errs({ '../up.png': bytes(10) }), /bad path/);
  assert.match(errs({ '/abs.png': bytes(10) }), /bad path/);
  assert.match(errs({ 'a.png': 'text' }), /not bytes/);
  assert.match(errs(Object.fromEntries(Array.from({ length: PACKAGE_LIMITS.files + 1 }, (_, i) => [`images/${i}.png`, bytes(1)]))), /more than 64 files/);
  assert.match(errs(Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`images/${i}.png`, bytes(PACKAGE_LIMITS.imageBytes)]))), /package: larger/);
  // Not packages: what checkPackage refuses.
  assert.match(checkPackage({ ...ok, html: null } as unknown as ThemePackage).join(), /html is not text/);
  assert.match(checkPackage(null as unknown as ThemePackage).join(), /not an object/);
});

test('the whole package: Neubrutalism sanitizes with nothing removed; images only as declared', () => {
  const t = neo();
  const r = sanitizeTheme({ ...t, files: Object.keys(t.files) });
  assert.deepEqual([r.ok, r.errors, r.removed], [true, [], []]);
  // An image the manifest doesn't declare can't be named.
  const html = '<div><img src="images/a.png" alt=""><m-page></m-page></div>';
  const undeclared = sanitizeTheme({ manifest: JSON.stringify(base), html, css: '.x{background:url(images/a.png)}', files: ['images/a.png'] });
  assert.equal(undeclared.removed.some((x) => x.file === 'theme.html'), true);
  assert.equal(undeclared.removed.some((x) => x.file === 'theme.css'), true);
  const declared = sanitizeTheme({ manifest: JSON.stringify({ ...base, images: ['images/a.png'] }), html, css: '.x{background:url(images/a.png)}', files: ['images/a.png'] }, { assetUrl: () => 'data:image/png;base64,AAAA' });
  assert.deepEqual(declared.removed, []);
  assert.match(declared.css, /url\("?data:image\/png;base64,AAAA"?\)/);
});

test('a built-in theme is read from its files: theme.json first, then only what it names', async () => {
  const read: string[] = [];
  const pkg = await readBuiltinTheme('neubrutalism', { readFile: async (path) => { read.push(path); return readFile(new URL(path, `file://${NEO}`)); } });
  assert.deepEqual(read.slice(0, 3), ['theme.json', 'theme.html', 'theme.css']);
  assert.deepEqual(read.slice(3).sort(), ['fonts/archivo-black-latin-ext.woff2', 'fonts/archivo-black-latin.woff2', 'fonts/space-grotesk-latin-ext.woff2', 'fonts/space-grotesk-latin.woff2']);
  assert.equal(typeof pkg.manifest, 'string');
  assert.ok(pkg.files['fonts/archivo-black-latin.woff2'] instanceof Uint8Array);
  assert.deepEqual(checkPackage(pkg), []);
  assert.equal(sanitizeTheme({ ...pkg, files: Object.keys(pkg.files) }).ok, true);
  await assert.rejects(readBuiltinTheme('gone', { readFile: async () => '' }), /no built-in theme/);
  // A manifest naming a path outside the package: never asked for.
  const asked: string[] = [];
  await readBuiltinTheme('neubrutalism', { readFile: async (p) => { asked.push(p); return p === 'theme.json' ? JSON.stringify({ ...base, fonts: [{ family: 'A', file: '../../../secret.woff2' }, { family: 'B', file: 'https://evil.test/x.woff2' }] }) : ''; } });
  assert.deepEqual(asked, ['theme.json', 'theme.html', 'theme.css']);
});

test('a user\'s theme, stored: one key per theme and an index; checked again as it comes back', async () => {
  const t = neo();
  const { value, entry } = encodeStoredTheme(t, { now: 42 });
  assert.equal(value.format, 2);
  assert.equal(value.id, 'neubrutalism');
  assert.deepEqual(Object.keys(value.files).sort(), Object.keys(t.files).sort());
  assert.ok(Object.values(value.files).every((v) => typeof v === 'string'), 'bytes as base64 (storage holds JSON)');
  assert.deepEqual({ ...entry, bytes: 0 }, { id: 'neubrutalism', name: 'Neubrutalism', version: '0.1.0', author: 'Margin', bytes: 0, savedAt: 42 });
  assert.ok(entry.bytes < PACKAGE_LIMITS.storedBytes);
  const back = decodeStoredTheme(JSON.parse(JSON.stringify(value)))!; // just encoded: it decodes
  assert.equal(back.manifest, t.manifest);
  assert.equal(back.html, t.html);
  for (const [path, b] of Object.entries(t.files)) assert.deepEqual([...back.files[path]], [...b], path);
  for (const bad of [null, 'x', { ...value, format: 1 }, { ...value, html: 3 }, { ...value, files: { 'a.png': 5 } }, { ...value, files: { 'a.png': '%%%' } }]) assert.equal(decodeStoredTheme(bad), null);
  // Refused as it's stored: caps and checks.
  assert.throws(() => encodeStoredTheme({ ...t, html: '<div></div>' }), /m-page/);
  assert.throws(() => encodeStoredTheme({ ...t, files: { ...t.files, 'x.js': bytes(1) } }), /not a file a theme may bundle/);
  // Saving: the theme and the index in one write, a built-in's id refused.
  const store: Record<string, any> = { [USER_THEMES]: [{ id: 'other', name: 'Other' }] }; // stored JSON
  const storage = { get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])), set: async (items: Record<string, any>) => { writes.push(Object.keys(items)); Object.assign(store, items); } };
  const writes: string[][] = [];
  const mine = { ...t, manifest: JSON.stringify({ ...JSON.parse(t.manifest), id: 'mine', name: 'Mine' }) };
  assert.equal(await saveUserTheme(mine, { ...storage, now: 7 }), 'mine');
  assert.deepEqual(writes, [[userThemeKey('mine'), USER_THEMES]]);
  assert.deepEqual(store[USER_THEMES].map((e: { id: string }) => e.id), ['other', 'mine']);
  await saveUserTheme(mine, { ...storage, now: 8 });
  assert.deepEqual(store[USER_THEMES].map((e: { id: string, savedAt?: number }) => [e.id, e.savedAt]), [['other', undefined], ['mine', 8]], 'saved again: replaced, not listed twice');
  await assert.rejects(saveUserTheme(t, storage), /built-in/);
});
