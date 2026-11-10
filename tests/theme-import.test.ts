// Reading an imported theme (ui/theme-import.ts): a folder's files or a
// .margintheme zip into a package, with every zip, folder and path payload
// of docs/phase6-themes.md §4 refused; and a round trip of every built-in
// through npm run theme:pack and the reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { packageFromFiles, packageFromZip, checkImport, missingWaysOut, readThemeFile, removedSummary, crc32, type ReadResult } from '../extension/ui/theme-import.ts';
import type { ThemePackage } from '../extension/ui/theme-loader.ts';
import { PACKAGE_THEMES } from '../extension/themes/packages.ts';
import { packTheme, zipFiles, folderFiles } from '../scripts/pack-theme.ts';
import { readTheme } from './theme/package.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const THEMES = new URL('../extension/themes/', import.meta.url).pathname;
const WAYS_OUT = '<div class="r"><m-page></m-page><m-launcher></m-launcher><m-prompt></m-prompt><m-notice></m-notice>'
  + '<template m-part="launcher"><main><m-settings></m-settings></main></template>'
  + '<template m-part="settings"><div></div></template><template m-part="prompt"><div></div></template><template m-part="notice"><div></div></template></div>';
const MINE = {
  'theme.json': enc(JSON.stringify({ format: 2, id: 'mine', name: 'Mine', version: '1.0.0', author: 'Me' })),
  // The ways back out an import must have (missingWaysOut): the new-tab page with Settings, prompts, notices.
  'theme.html': enc(WAYS_OUT),
  'theme.css': enc('.r{display:flex}'),
  'LICENSE.txt': enc('mine'),
};
// A read as the tests look at it once they've checked `ok`: its package when read, its errors when refused.
type Read = { ok: boolean, pkg: ThemePackage, skipped: number, errors: string[] };
const errorsOf = async (r: ReadResult | Promise<ReadResult>) => { const x = (await r) as Read; assert.equal(x.ok, false, 'refused'); return x.errors.join('\n'); };

test('a folder: the three texts at the top, or in the one folder everything is in; Finder\'s leftovers skipped', () => {
  const top = packageFromFiles(MINE);
  assert.equal(top.ok, true);
  assert.deepEqual(Object.keys(top.pkg.files), ['LICENSE.txt']);
  const nested = packageFromFiles({ ...Object.fromEntries(Object.entries(MINE).map(([k, v]) => [`my-theme/${k}`, v])), '__MACOSX/my-theme/._theme.json': enc('x'), 'my-theme/.DS_Store': enc('x'), 'my-theme/._theme.css': enc('x') });
  assert.equal(nested.ok, true);
  assert.equal(nested.skipped, 3);
  assert.equal(nested.pkg.manifest, top.pkg.manifest);
});

test('a folder: missing texts, two top folders, Theme.json beside theme.json, too deep, bad names', async () => {
  assert.match(await errorsOf(packageFromFiles({ 'theme.json': MINE['theme.json'] })), /theme\.html missing/);
  assert.match(await errorsOf(packageFromFiles({ 'a/theme.json': MINE['theme.json'], 'b/theme.html': MINE['theme.html'] })), /no theme\.json at the top/);
  assert.match(await errorsOf(packageFromFiles({ ...MINE, 'Theme.json': enc('{}') })), /same name but for case/);
  assert.match(await errorsOf(packageFromFiles({ ...MINE, 'THEME.CSS2': enc('x'), 'Theme.css': enc('x') })), /same name but for case/);
  assert.match(await errorsOf(packageFromFiles({ ...MINE, 'images/a/b/c.png': enc('x') })), /more than 2 folders deep/);
  for (const [path, why] of [['../evil.png', /"\." or "\.\."/], ['/etc/passwd', /root/], ['C:/evil.png', /root/], ['images\\evil.png', /backslash/], ['images/./x.png', /"\." or "\.\."/], ['x\u0000.png', /NUL/], ['im\u0430ges/x.png', /characters other than/], ['.git/config', /characters other than/]] as [string, RegExp][]) {
    assert.match(await errorsOf(packageFromFiles({ ...MINE, [path]: enc('x') })), why, path);
  }
  assert.match(await errorsOf(packageFromFiles({ ...MINE, 'theme.css': new Uint8Array([0xff, 0xfe, 0x41]) })), /theme\.css: not UTF-8/);
  assert.match(await errorsOf(packageFromFiles(Object.fromEntries(Array.from({ length: 71 }, (_, i) => [`n${i}.txt`, enc('x')])))), /more than 70 files/);
});

test('a folder from disk (as Margin.app reads one): a link to a file outside refused, a hidden .git/ left out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'margin-theme-'));
  try {
    for (const [k, v] of Object.entries(MINE)) writeFileSync(join(dir, k), v);
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git/config'), '[core]');
    const { files, left } = folderFiles(dir);
    assert.deepEqual(left, ['.git/']);
    assert.equal(packageFromFiles(files).ok, true);
    symlinkSync('/etc/hosts', join(dir, 'hosts.txt'));
    assert.throws(() => folderFiles(dir), /a link/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- zips -------------------------------------------------------------------

const zipOf = (files: Record<string, Uint8Array>) => zipFiles(files);
/** Rewrites one field in every central directory entry (or the end record). */
function patch(zip: Uint8Array, fn: (b: Buffer) => void) { const b = Buffer.from(zip); fn(b); return new Uint8Array(b); }
const cdStart = (b: Buffer) => b.readUInt32LE(b.length - 22 + 16);

test('a zip: read back as the folder it came from', async () => {
  const r = (await packageFromZip(zipOf(MINE))) as Read;
  assert.equal(r.ok, true);
  assert.equal(r.pkg.css, '.r{display:flex}');
  assert.equal(checkImport(r.pkg).ok, true);
  const nested = await packageFromZip(zipOf(Object.fromEntries(Object.entries(MINE).map(([k, v]) => [`my-theme/${k}`, v]))));
  assert.equal(nested.ok, true);
});

test('a zip made by macOS\'s own zip (Finder\'s Compress makes the same kind) is read', async (t) => {
  if (!existsSync('/usr/bin/zip')) return t.skip('no /usr/bin/zip');
  const dir = mkdtempSync(join(tmpdir(), 'margin-zip-'));
  try {
    mkdirSync(join(dir, 'my-theme'));
    for (const [k, v] of Object.entries(MINE)) writeFileSync(join(dir, 'my-theme', k), v);
    writeFileSync(join(dir, 'my-theme/.DS_Store'), 'x');
    execFileSync('/usr/bin/zip', ['-qr', 'out.zip', 'my-theme'], { cwd: dir });
    const r = (await packageFromZip(new Uint8Array(readFileSync(join(dir, 'out.zip'))))) as Read;
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.skipped, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('zip payloads: each refused', async () => {
  const good = zipOf(MINE);
  const cases = [
    ['not a zip', enc('hello, this is not a zip file at all'), /not a zip/],
    ['too large', new Uint8Array(4 * 1024 * 1024 + 1), /larger than/],
    ['data before the zip', new Uint8Array([...enc('MZ'.repeat(40)), ...good]), /directory isn't where|data before/],
    ['a symlink entry', patch(good, (b) => { b.writeUInt32LE((0o120777 << 16) >>> 0, cdStart(b) + 38); }), /a link or special file/],
    ['an encrypted entry', patch(good, (b) => { b.writeUInt16LE(0x0801, cdStart(b) + 8); }), /encrypted/],
    ['a method other than stored or deflate (bzip2)', patch(good, (b) => { b.writeUInt16LE(12, cdStart(b) + 10); }), /only stored or deflated/],
    ['zip64 sizes', patch(good, (b) => { b.writeUInt32LE(0xffffffff, cdStart(b) + 24); }), /zip64/],
    ['a lying central directory (its offset)', patch(good, (b) => { b.writeUInt32LE(cdStart(b) - 4, b.length - 22 + 16); }), /directory isn't where/],
    ['a lying entry count', patch(good, (b) => { b.writeUInt16LE(3, b.length - 22 + 8); b.writeUInt16LE(3, b.length - 22 + 10); }), /directory isn't the size|split/],
    ['a local header that disagrees', patch(good, (b) => { b[30] = 'X'.charCodeAt(0); }), /disagrees/],
    ['a CRC that doesn\'t match', patch(good, (b) => { b.writeUInt32LE(1234, cdStart(b) + 16); b.writeUInt32LE(1234, 14); }), /CRC-32/],
  ] as [string, Uint8Array, RegExp][];
  for (const [name, zip, why] of cases) assert.match(await errorsOf(packageFromZip(zip)), why, name);
});

/** A zip built by hand: [name, bytes, { method, size, csize, external, local }] entries, as given. */
type RawEntry = { name: string, body: Uint8Array, crc?: number, method?: number, size?: number, csize?: number, external?: number, local?: number };
function rawZip(entries: RawEntry[], { prefix = new Uint8Array(0) } = {}) {
  const parts: Uint8Array[] = [prefix];
  const cds: Buffer[] = [];
  let offset = prefix.length;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const body = Buffer.from(e.body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(e.method ?? 0, 8); local.writeUInt32LE(e.crc ?? 0, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(e.size ?? body.length, 22); local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE((3 << 8) | 20, 4); cd.writeUInt16LE(e.method ?? 0, 10); cd.writeUInt32LE(e.crc ?? 0, 16);
    cd.writeUInt32LE(e.csize ?? body.length, 20); cd.writeUInt32LE(e.size ?? body.length, 24); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(e.external ?? ((0o100644 << 16) >>> 0), 38); cd.writeUInt32LE(e.local ?? offset, 42);
    if (e.local == null) { parts.push(local, name, body); offset += 30 + name.length + body.length; }
    cds.push(cd, name);
  }
  const cd = Buffer.concat(cds);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts.map((p) => Buffer.from(p)), cd, end]));
}
const stored = (name: string, text: string) => { const body = enc(text); return { name, body, crc: crc32(body) }; };

test('zip payloads built by hand: duplicates, overlaps, a bomb, too many entries', async () => {
  const base = Object.entries(MINE).map(([k, v]) => ({ name: k, body: v, crc: crc32(v) }));
  assert.match(await errorsOf(packageFromZip(rawZip([...base, stored('theme.css', '.x{}')]))), /twice in the zip/);
  assert.match(await errorsOf(packageFromZip(rawZip([...base, stored('THEME.CSS', '.x{}')]))), /twice in the zip/);
  // Two directory entries pointing at the same bytes.
  assert.match(await errorsOf(packageFromZip(rawZip([...base, { ...base[3], name: 'LICENSE.txt', local: 0 }]))), /share bytes|disagrees|twice/);
  // A bomb: 4 MB of zeros, deflated to a few KB, saying it's small.
  const zeros = new Uint8Array(4 * 1024 * 1024);
  const bomb = deflateRawSync(zeros);
  assert.match(await errorsOf(packageFromZip(rawZip([...base, { name: 'images/bomb.png', body: bomb, method: 8, size: 1000, crc: 0 }]))), /inflates past 1000 bytes/);
  assert.match(await errorsOf(packageFromZip(rawZip([...base, { name: 'NOTES.txt', body: bomb, method: 8, size: zeros.length, crc: crc32(zeros) }]))), /larger than/);
  // A kind no package holds, saying it's huge: refused before it's inflated (a 1 GB bomb in under 1 MB).
  const big = { name: 'x.bin', body: bomb, method: 8, size: 1_000_000_000, crc: 0 };
  const before = process.memoryUsage().rss;
  assert.match(await errorsOf(packageFromZip(rawZip([...base, big]))), /x\.bin: not a file a theme may bundle/);
  assert.match(await errorsOf(packageFromZip(rawZip([...base, { ...big, name: 'fonts/LICENSE' }]))), /not a file a theme may bundle/);
  assert.ok(process.memoryUsage().rss - before < 200 * 1024 * 1024, 'nothing near its size inflated');
  // Allowed kinds, each within its cap, past the package's total: refused once the total is reached, not after.
  const fontBytes = new Uint8Array(500 * 1024);
  const fontBody = deflateRawSync(fontBytes);
  const font = (i: number) => ({ name: `fonts/f${i}.woff2`, body: fontBody, method: 8, size: fontBytes.length, crc: crc32(fontBytes) });
  assert.match(await errorsOf(packageFromZip(rawZip([...base, ...[1, 2, 3, 4, 5, 6, 7].map(font)]))), /^it holds more than 3145728 bytes$/);
  assert.match(await errorsOf(packageFromZip(rawZip(Array.from({ length: 71 }, (_, i) => stored(`n${i}.txt`, 'x'))))), /more than 70 entries/);
  // Its paths go through the same rules as a folder's.
  assert.match(await errorsOf(packageFromZip(rawZip([...base, stored('../../evil.txt', 'x')]))), /"\." or "\.\."/);
  assert.match(await errorsOf(packageFromZip(rawZip([...base, stored('/abs.txt', 'x')]))), /root/);
});

// ---- the checks ---------------------------------------------------------------

test('checkImport: a built-in\'s id refused; what was removed said by count and kind', async () => {
  const builtin = packageFromFiles({ ...MINE, 'theme.json': enc(JSON.stringify({ format: 2, id: 'arcadia', name: 'Fake', version: '9.0.0' })) });
  assert.match(checkImport((builtin as Read).pkg).errors.join(), /built-in theme's/);
  const css = packageFromFiles({ ...MINE, 'theme.css': enc('.a{background:url(https://evil.test/a)} .b{background:url(https://evil.test/b)} .c{color:red}') });
  const r = checkImport((css as Read).pkg);
  assert.equal(r.ok, true);
  assert.equal(r.removed.length, 1);
  assert.match(r.removed[0], /^2 declarations removed from theme\.css: /);
  assert.deepEqual(r.manifest, { id: 'mine', name: 'Mine', version: '1.0.0', author: 'Me' });
  assert.deepEqual(removedSummary([]), []);
});

test('checkImport: a theme with no way back out of it refused (no Settings, prompt or notice), with what it lacks', () => {
  const only = packageFromFiles({ ...MINE, 'theme.html': enc('<div class="root"><m-page></m-page></div>') });
  const r = checkImport((only as Read).pkg);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /^theme\.html: no <template m-part="launcher">, no <template m-part="settings">, no <template m-part="prompt">, no <template m-part="notice">, no <m-launcher> outside the parts, no <m-prompt> outside the parts, no <m-notice> outside the parts, no <m-settings> in the launcher part/);
  // Settings anywhere but the new-tab page (here: a menu, which only shows on a right-click) doesn't count.
  const hidden = packageFromFiles({ ...MINE, 'theme.html': enc(WAYS_OUT.replace('<main><m-settings></m-settings></main>', '<main></main>').replace('<template m-part="settings">', '<template m-part="menu"><m-settings></m-settings></template><template m-part="settings">')) });
  assert.deepEqual(checkImport((hidden as Read).pkg).errors, ['theme.html: no <m-settings> in the launcher part (an imported theme must draw Margin\'s Settings, prompts and notices, so it can be switched away from)']);
  assert.equal(missingWaysOut({ parts: ['launcher', 'settings', 'prompt', 'notice'], slots: ['>m-launcher', '>m-prompt', '>m-notice', 'launcher>m-settings'] }).length, 0);
  assert.equal(checkImport((packageFromFiles(MINE) as Read).pkg).ok, true);
});

test('readThemeFile: what Margin.app hands over, folder or zip, as base64; its error words passed on', async () => {
  const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
  const folder = await readThemeFile({ kind: 'folder', files: Object.fromEntries(Object.entries(MINE).map(([k, v]) => [k, b64(v)])) });
  assert.equal(folder.ok, true);
  const zip = await readThemeFile({ kind: 'zip', zip: b64(zipOf(MINE)) });
  assert.equal(zip.ok, true);
  assert.equal(zip.manifest.id, 'mine');
  assert.deepEqual((await readThemeFile({ error: 'That folder is too large.' })).errors, ['That folder is too large.']);
  assert.equal((await readThemeFile({ kind: 'evil' })).ok, false);
});

for (const id of PACKAGE_THEMES) {
  test(`round trip: ${id} through npm run theme:pack and the reader is the same package`, async () => {
    const { bytes, left } = packTheme(join(THEMES, id));
    assert.ok(left.every((f) => /^(first-paint\.css|theme\.ts)$/.test(f)), left.join());
    const r = (await packageFromZip(bytes)) as Read;
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const disk = readTheme(join(THEMES, id));
    assert.equal(r.pkg.manifest, disk.manifest);
    assert.equal(r.pkg.html, disk.html);
    assert.equal(r.pkg.css, disk.css);
    for (const [path, b] of Object.entries(disk.files)) assert.deepEqual(Buffer.from(r.pkg.files[path]), b, path);
    assert.match(checkImport(r.pkg).errors.join(), /built-in theme's/, 'and importing it as is is refused: its id is taken');
    assert.deepEqual(packTheme(join(THEMES, id)).bytes, bytes, 'the same folder makes the same file');
  });
}
