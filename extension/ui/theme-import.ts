// Reading a theme someone imports (docs/phase6-themes.md §3): a folder's
// files, or a `.margintheme` file (a zip of the folder), into the package
// every theme load takes ({ manifest, html, css, files }), then checked as
// every load checks one (ui/theme-loader.ts checkPackage, sanitizeTheme)
// and against the built-ins' ids. Margin.app reads the folder or the file's
// bytes (app/shell/ShellThemes.swift) and hands them to the overlay; all the
// checking is here, in JS, so it's the same in the overlay, the tests and
// `npm run theme:pack`.
//
// The zip is read by hand, strictly: one central directory at the end with
// nothing before the first entry and nothing between the entries and it, no
// zip64, no encryption, no links, stored or deflated entries only, no two
// entries with one name (in any case) or one span of bytes, each entry's
// local header agreeing with the directory, inflated with
// DecompressionStream('deflate-raw') while counting (never past what it
// says it holds, nor past the caps), and its CRC-32 checked. Pure: runs in
// Node, WebKit and Chromium.
import { checkPackage, sanitizeTheme, BUILTIN_THEMES, PACKAGE_LIMITS } from './theme-loader.ts';

export const IMPORT_LIMITS = Object.freeze({
  zipBytes: 4 * 1024 * 1024, // a .margintheme file
  entries: 70, // files and folders in one
  depth: 2, // folders below the theme's own
  pathLength: 200,
});

const TEXTS = ['theme.json', 'theme.html', 'theme.css'];
// macOS's leftovers, skipped: resource forks and extended attributes (Finder's
// Compress puts them in __MACOSX/, ditto and others beside each file as ._name)
// and folder settings (.DS_Store).
const JUNK = (path: string) => path.startsWith('__MACOSX/') || path.split('/').some((seg) => seg === '.DS_Store' || seg.startsWith('._'));
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

/**
 * What a reading gives: the package, or why not. `skipped`: what was left
 * out (Finder's leftovers), as counts.
 */
export type ReadResult = { ok: true, pkg: import('./theme-loader.ts').ThemePackage, skipped: number } | { ok: false, errors: string[] };

/** A path as a package may hold it, or why not. */
function pathProblem(path: string): string | null {
  if (typeof path !== 'string' || !path) return 'an empty name';
  if (path.length > IMPORT_LIMITS.pathLength) return 'a name too long';
  if (path.includes('\u0000')) return 'a NUL in a name';
  if (path.includes('\\')) return 'a backslash in a name';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'a name from the disk\'s root';
  const segs = path.split('/');
  if (segs.some((s) => s === '..' || s === '.')) return 'a "." or ".." in a name';
  if (!segs.every((s) => SEGMENT.test(s))) return 'a name with characters other than letters, digits, ".", "_" and "-"';
  return null;
}

/**
 * A folder's files (path relative to the folder → bytes) as a package.
 * If everything sits under one top folder (my-theme/theme.json), that
 * folder is the theme's.
 * */
export function packageFromFiles(input: Record<string, Uint8Array>): ReadResult {
  const errors: string[] = [];
  let skipped = 0;
  const files: Map<string, Uint8Array> = new Map();
  const folded = new Set<any>();
  const entries = Object.entries(input ?? {});
  if (entries.length > IMPORT_LIMITS.entries) return { ok: false, errors: [`more than ${IMPORT_LIMITS.entries} files`] };
  for (const [raw, bytes] of entries) {
    const path = String(raw).replace(/^\.\//, '');
    if (JUNK(path)) { skipped++; continue; }
    const problem = pathProblem(path);
    if (problem) { errors.push(`${JSON.stringify(path.slice(0, 80))}: ${problem}`); continue; }
    if (!(bytes instanceof Uint8Array)) { errors.push(`${path}: not bytes`); continue; }
    if (folded.has(path.toLowerCase())) { errors.push(`${path}: another file has the same name but for case`); continue; }
    folded.add(path.toLowerCase());
    files.set(path, bytes);
  }
  if (errors.length) return { ok: false, errors };
  // The theme's own folder: the top, or the one folder everything is in.
  let root = '';
  if (!files.has('theme.json')) {
    const tops = new Set([...files.keys()].map((p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '')));
    const [top] = tops;
    if (tops.size === 1 && top && files.has(`${top}/theme.json`)) root = `${top}/`;
    else return { ok: false, errors: ['no theme.json at the top (or in the one folder everything is in)'] };
  }
  const pkgFiles = {};
  const texts = {};
  for (const [path, bytes] of files) {
    const rel = path.slice(root.length);
    if (rel.split('/').length - 1 > IMPORT_LIMITS.depth) { errors.push(`${rel}: more than ${IMPORT_LIMITS.depth} folders deep`); continue; }
    if (TEXTS.includes(rel)) texts[rel] = bytes;
    else if (TEXTS.includes(rel.toLowerCase())) errors.push(`${rel}: named like ${rel.toLowerCase()} (names are lower case)`);
    else pkgFiles[rel] = bytes;
  }
  for (const t of TEXTS) if (!texts[t]) errors.push(`${t} missing`);
  if (errors.length) return { ok: false, errors };
  const decoded = {};
  for (const t of TEXTS) {
    try { decoded[t] = new TextDecoder('utf-8', { fatal: true }).decode(texts[t]).replace(/^﻿/, ''); } catch { errors.push(`${t}: not UTF-8 text`); }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, pkg: { manifest: decoded['theme.json'], html: decoded['theme.html'], css: decoded['theme.css'], files: pkgFiles }, skipped };
}

// ---------------------------------------------------------------------------
// The zip.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The largest a file of this name may inflate to. */
function capFor(path: string) {
  if (TEXTS.includes(path.split('/').pop() ?? '')) return 256 * 1024;
  if (/\.woff2$/i.test(path)) return PACKAGE_LIMITS.fontBytes;
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(path)) return PACKAGE_LIMITS.imageBytes;
  if (/\.(txt|md)$/i.test(path)) return PACKAGE_LIMITS.noteBytes;
  return 0; // checkPackage says why
}

/**
 * Inflates raw deflate data, stopping (an Error) once it's past `max` bytes.
 * */
async function inflate(data: Uint8Array, max: number) {
  const stream = new Blob([(data.slice() as Uint8Array<ArrayBuffer>)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let step;
    try { step = await reader.read(); } catch { throw new Error('its compressed data is broken'); }
    if (step.done) break;
    total += step.value.length;
    if (total > max) { void reader.cancel().catch(() => {}); throw new Error(`it inflates past ${max} bytes`); }
    chunks.push(step.value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * A `.margintheme` file's bytes as a package.
 * */
export async function packageFromZip(zip: Uint8Array): Promise<ReadResult> {
  const fail = (why: string) => ({ ok: (false as false), errors: [why] });
  if (!(zip instanceof Uint8Array)) return fail('not bytes');
  if (zip.length > IMPORT_LIMITS.zipBytes) return fail(`the file is larger than ${IMPORT_LIMITS.zipBytes} bytes`);
  if (zip.length < 22) return fail('not a zip file');
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  // The end record: the last one, with its comment running exactly to the end.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === zip.length) { end = i; break; }
  }
  if (end < 0) return fail('not a zip file (no end record)');
  if (end >= 20 && u32(end - 20) === 0x07064b50) return fail('a zip64 file (not taken)');
  const disk = u16(end + 4);
  const cdDisk = u16(end + 6);
  const here = u16(end + 8);
  const count = u16(end + 10);
  const cdSize = u32(end + 12);
  const cdOffset = u32(end + 16);
  if (disk !== 0 || cdDisk !== 0 || here !== count) return fail('a zip split across files (not taken)');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return fail('a zip64 file (not taken)');
  if (count > IMPORT_LIMITS.entries) return fail(`more than ${IMPORT_LIMITS.entries} entries`);
  if (cdOffset + cdSize !== end) return fail('its directory isn\'t where its end record says (a broken or padded zip)');
  const list: { name: string, method: number, crc: number, csize: number, size: number, local: number, dir: boolean }[] = [];
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || u32(at) !== 0x02014b50) return fail('its directory is broken');
    const made = u16(at + 4) >> 8;
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const crc = u32(at + 16);
    const csize = u32(at + 20);
    const size = u32(at + 24);
    const nlen = u16(at + 28);
    const xlen = u16(at + 30);
    const clen = u16(at + 32);
    const external = u32(at + 38);
    const local = u32(at + 42);
    if (at + 46 + nlen + xlen + clen > end) return fail('its directory is broken');
    const nameBytes = zip.subarray(at + 46, at + 46 + nlen);
    let name;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); } catch { return fail('an entry\'s name isn\'t text'); }
    at += 46 + nlen + xlen + clen;
    if (flags & 0x0001 || flags & 0x0040) return fail(`${JSON.stringify(name.slice(0, 80))}: encrypted (not taken)`);
    if (csize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) return fail('a zip64 file (not taken)');
    // Unix modes (made on Unix or macOS): links and devices refused.
    const mode = (external >>> 16) & 0o170000;
    if ((made === 3 || made === 19) && mode !== 0 && mode !== 0o100000 && mode !== 0o040000) return fail(`${JSON.stringify(name.slice(0, 80))}: a link or special file (not taken)`);
    const dir = name.endsWith('/');
    if (!dir && method !== 0 && method !== 8) return fail(`${JSON.stringify(name.slice(0, 80))}: compressed in a way Margin doesn't read (only stored or deflated)`);
    list.push({ name, method, crc, csize, size, local, dir });
  }
  if (at !== end) return fail('its directory isn\'t the size its end record says');
  // Nothing before the first entry, entries one after another, never overlapping.
  // [where its entry starts, where its data ends, the entry, where its data starts]
  const spans: [number, number, (typeof list)[number], number][] = [];
  for (const e of list) {
    const l = e.local;
    if (l + 30 > cdOffset || u32(l) !== 0x04034b50) return fail(`${JSON.stringify(e.name.slice(0, 80))}: its entry isn't where the directory says`);
    const lflags = u16(l + 6);
    const lnlen = u16(l + 26);
    const lxlen = u16(l + 28);
    const lname = zip.subarray(l + 30, l + 30 + lnlen);
    if (new TextDecoder().decode(lname) !== e.name || (lflags & 0x0001)) return fail(`${JSON.stringify(e.name.slice(0, 80))}: its entry disagrees with the directory`);
    if (u16(l + 8) !== e.method && !e.dir) return fail(`${JSON.stringify(e.name.slice(0, 80))}: its entry disagrees with the directory`);
    const data = l + 30 + lnlen + lxlen;
    let stop = data + e.csize;
    if (stop > cdOffset) return fail(`${JSON.stringify(e.name.slice(0, 80))}: its data runs past the directory`);
    // A data descriptor after the data (bit 3): 12 or 16 bytes.
    if (lflags & 0x0008) stop += stop + 4 <= cdOffset && u32(stop) === 0x08074b50 ? 16 : 12;
    spans.push([l, Math.min(stop, cdOffset), e, data]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  if (spans.length && spans[0][0] !== 0) return fail('data before the zip (not taken)');
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) return fail('two entries share bytes (not taken)');
  // Each entry, read.
  const files = {};
  const seen = new Set<any>();
  let total = 0;
  for (const [, , e, data] of spans) {
    const name = e.name.replace(/^\.\//, '');
    if (seen.has(name.toLowerCase())) return fail(`${JSON.stringify(name.slice(0, 80))}: twice in the zip`);
    seen.add(name.toLowerCase());
    if (e.dir) continue;
    if (JUNK(name)) { files[name] = new Uint8Array(0); continue; } // dropped by packageFromFiles, counted as skipped
    const problem = pathProblem(name);
    if (problem) return fail(`${JSON.stringify(name.slice(0, 80))}: ${problem}`);
    // A kind no package holds is refused before anything is inflated (its
    // size is the zip's word only), as checkPackage would refuse it after.
    if (!capFor(name)) return fail(`${name}: not a file a theme may bundle (woff2 fonts, png, jpg, gif, webp, avif, svg images, txt or md notes)`);
    const cap = Math.min(capFor(name), PACKAGE_LIMITS.totalBytes - total);
    if (e.size > cap) return fail(cap < capFor(name) ? `it holds more than ${PACKAGE_LIMITS.totalBytes} bytes` : `${name}: larger than ${cap} bytes`);
    const raw = zip.subarray(data, data + e.csize);
    let bytes;
    if (e.method === 0) {
      if (e.csize !== e.size) return fail(`${name}: its sizes disagree`);
      bytes = raw.slice();
    } else {
      // Never past what it says it holds, which is within its kind's cap and what's left of the package's.
      try { bytes = await inflate(raw, Math.min(Math.max(e.size, 0), cap)); } catch (err) { return fail(`${name}: ${err.message}`); }
      if (bytes.length !== e.size) return fail(`${name}: it inflates to another size than it says`);
    }
    if (crc32(bytes) !== e.crc) return fail(`${name}: its check (CRC-32) doesn't match`);
    total += bytes.length;
    if (total > PACKAGE_LIMITS.totalBytes) return fail(`it holds more than ${PACKAGE_LIMITS.totalBytes} bytes`);
    files[name] = bytes;
  }
  return packageFromFiles(files);
}

// ---------------------------------------------------------------------------
// The checks, with what they say.

/**
 * What the sanitizer removed, by file and reason, in a few lines: "3 rules
 * removed from theme.css: url() to a file outside the package".
 */
export function removedSummary(removed: { file: string, kind: string, reason: string }[], max: number = 5) {
  const groups = new Map();
  for (const r of removed ?? []) {
    // The reason's kind, not the theme's own words in it (an address, a value).
    const reason = String(r.reason ?? '').replace(/url\([^)]*\)/gi, 'url()').replace(/"[^"]*"|'[^']*'/g, '"…"').slice(0, 120);
    const key = `${r.file}\u0000${r.kind}\u0000${reason}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const lines = [...groups].sort((a, b) => b[1] - a[1]).map(([key, n]) => {
    const [file, kind, reason] = key.split('\u0000');
    const what = { element: 'element', attribute: 'attribute', text: 'text', binding: 'binding', 'css-rule': 'rule', 'css-declaration': 'declaration', 'css-at-rule': 'at-rule' }[kind] ?? kind.replace(/^css-/, '');
    return `${n} ${what}${n === 1 ? '' : 's'} removed from ${file}: ${reason}`;
  });
  return lines.length > max ? [...lines.slice(0, max), `and ${lines.length - max} more kinds`] : lines;
}

/**
 * What an imported theme's template lacks of the ways back out of it: the
 * new-tab page (`launcher` part in `<m-launcher>`) with Settings in it (the
 * `settings` part in `<m-settings>`, where the theme is chosen and removed),
 * and the `prompt` and `notice` parts in `<m-prompt>` and `<m-notice>`
 * (Remove's question; why Margin fell back). A built-in theme has them all.
 * */
export function missingWaysOut(structure: { parts?: string[], slots?: string[] } | undefined) {
  const parts = new Set(structure?.parts ?? []);
  const slots = new Set(structure?.slots ?? []);
  const missing: string[] = [];
  for (const part of ['launcher', 'settings', 'prompt', 'notice']) if (!parts.has(part)) missing.push(`<template m-part="${part}">`);
  for (const slot of ['m-launcher', 'm-prompt', 'm-notice']) if (!slots.has(`>${slot}`)) missing.push(`<${slot}> outside the parts`);
  if (!slots.has('launcher>m-settings') && !slots.has('>m-settings')) missing.push('<m-settings> in the launcher part');
  return missing;
}

/**
 * A read package checked as an import: the caps and file kinds, the
 * sanitizer, an id that isn't a built-in's, and the parts the person needs
 * to switch away from it again (missingWaysOut). `ok`: it may be previewed
 * (what was removed is said, not fatal, as for any theme load).
 * */
export function checkImport(pkg: import('./theme-loader.ts').ThemePackage) {
  const caps = checkPackage(pkg);
  if (caps.length) return { ok: false, errors: caps, removed: [], manifest: null };
  const report = sanitizeTheme({ manifest: pkg.manifest, html: pkg.html, css: pkg.css, files: Object.keys(pkg.files) });
  if (!report.ok) return { ok: false, errors: report.errors, removed: removedSummary(report.removed), manifest: null };
  const missing = missingWaysOut(report.structure);
  if (missing.length) return { ok: false, errors: [`theme.html: no ${missing.join(', no ')} (an imported theme must draw Margin's Settings, prompts and notices, so it can be switched away from)`], removed: removedSummary(report.removed), manifest: null };
  const m = report.manifest;
  if (BUILTIN_THEMES.includes(m.id)) return { ok: false, errors: [`its id "${m.id}" is a built-in theme's: give it your own`], removed: [], manifest: null };
  return { ok: true, errors: [], removed: removedSummary(report.removed), manifest: { id: m.id, name: m.name, version: m.version, author: m.author ?? '' } };
}

/**
 * What Margin.app hands the overlay (`themeFile`), read and checked.
 * @param msg base64 bytes
 */
export async function readThemeFile(msg: { kind?: string, files?: Record<string, string>, zip?: string, error?: string }) {
  if (!msg || typeof msg !== 'object') return { ok: false, errors: ['nothing came'] };
  if (typeof msg.error === 'string') return { ok: false, errors: [msg.error.slice(0, 300)] };
  const unb64 = (s: string) => { const bin = atob(String(s)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
  let read;
  try {
    if (msg.kind === 'zip' && typeof msg.zip === 'string') read = await packageFromZip(unb64(msg.zip));
    else if (msg.kind === 'folder' && msg.files && typeof msg.files === 'object') read = packageFromFiles(Object.fromEntries(Object.entries(msg.files).map(([p, b]) => [p, unb64(b)])));
    else return { ok: false, errors: ['not a folder or a .margintheme file'] };
  } catch { return { ok: false, errors: ['its bytes couldn\'t be read'] }; }
  if (!read.ok) return read;
  const checked = checkImport(read.pkg);
  return { ...checked, pkg: checked.ok ? read.pkg : null };
}
