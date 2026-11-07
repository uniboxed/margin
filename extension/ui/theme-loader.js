// Loading a theme package (PLAN.md §3, §4, §14): theme.json, theme.html,
// theme.css, and its fonts and images as bytes. The package is size-capped,
// checked as a whole (ui/theme-schema.js, ui/sanitize.js), its template
// built as DOM in an inert document, its stylesheet constructed (adopted by
// the container, never a <style> or a <link>), its fonts made as FontFace
// objects from their bytes (no URL, no request; Chromium ignores @font-face
// in shadow roots), and its settings turned into CSS variables after the
// same run-time value checks the view model's go through.
//
// Built-in themes are read from the extension's own files; a user's from
// their stored package (`storage.local`, one key per theme, the bytes as
// base64). Nothing here reads storage or the network itself: callers pass
// `readFile` and `get`/`set`, so the same code runs in pages, the app's web
// view and the unit tests.
import { checkCssValue, sanitizeCss, sanitizeTemplate } from './sanitize.js';
import { checkManifest, settingValueOk } from './theme-schema.js';
import { buildTemplate } from './render.js';
import { PACKAGE_THEMES, USER_THEMES_KEY } from '../themes/packages.js';

/** The themes Margin ships as packages (extension/themes/<id>/, themes/packages.js). */
export const BUILTIN_THEMES = PACKAGE_THEMES;

// Caps on a package, beyond the sanitizer's own (template and stylesheet
// 256 KB each, theme.json 32 KB: ui/sanitize.js LIMITS).
export const PACKAGE_LIMITS = Object.freeze({
  totalBytes: 3 * 1024 * 1024, // everything, text and bytes
  files: 64, // bundled files besides the three
  fontBytes: 512 * 1024, // each
  imageBytes: 256 * 1024, // each
  noteBytes: 64 * 1024, // licence texts and notes (kept, never loaded)
  storedBytes: 4.5 * 1024 * 1024, // a stored package's value, base64 included
});

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', woff2: 'font/woff2' };
const FONT_FILE = /\.woff2$/i;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const NOTE_FILE = /\.(txt|md)$/i;
const FILE_PATH = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

/**
 * A theme package: the three texts, and its other files' bytes by path.
 * @typedef {{ manifest: string, html: string, css: string, files: Record<string, Uint8Array> }} ThemePackage
 */

// What a file's first bytes must be for its kind: a font that isn't woff2,
// or an "image" that's a script or a page, is refused before anything
// decodes it. An svg image is UTF-8 text whose first element is <svg>
// (images never run script or load anything, but a page isn't an image);
// a note is UTF-8 text with no NUL.
const ascii = (bytes, at, text) => bytes.length >= at + text.length && [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));
const SIGNATURES = {
  woff2: (b) => ascii(b, 0, 'wOF2'),
  png: (b) => b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v),
  jpg: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'),
  webp: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'),
  avif: (b) => ascii(b, 4, 'ftyp') && ['avif', 'avis', 'mif1', 'msf1'].some((brand) => ascii(b, 8, brand)),
};
SIGNATURES.jpeg = SIGNATURES.jpg;
/** @param {Uint8Array} bytes @returns {string | null} the text, if it's UTF-8 with no NUL */
function utf8Text(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\u0000') ? null : text;
  } catch { return null; }
}
const SVG_START = /^\uFEFF?\s*(?:<\?xml[^>]{0,200}\?>\s*)?(?:<!--[\s\S]{0,4000}?-->\s*)*(?:<!DOCTYPE svg[^>]{0,400}>\s*)?<svg[\s>]/i;
/** Does the file's content match its kind (by its extension)? @param {string} path @param {Uint8Array} bytes */
export function contentMatches(path, bytes) {
  const ext = path.split('.').pop().toLowerCase();
  if (ext === 'svg') { const text = utf8Text(bytes); return text !== null && SVG_START.test(text); }
  if (ext === 'txt' || ext === 'md') return utf8Text(bytes) !== null;
  return SIGNATURES[ext]?.(bytes) ?? false;
}

const byteLength = (s) => (typeof s === 'string' ? new TextEncoder().encode(s).length : 0);

/**
 * The size caps and which files a package may hold: fonts (.woff2), images,
 * and notes (licences; kept, never loaded).
 * @param {ThemePackage} pkg @returns {string[]} what's wrong (nothing: fine)
 */
export function checkPackage(pkg) {
  const errors = [];
  if (!pkg || typeof pkg !== 'object') return ['package: not an object'];
  for (const key of ['manifest', 'html', 'css']) if (typeof pkg[key] !== 'string') errors.push(`package: ${key} is not text`);
  const files = pkg.files && typeof pkg.files === 'object' ? pkg.files : {};
  const paths = Object.keys(files);
  if (paths.length > PACKAGE_LIMITS.files) errors.push(`package: more than ${PACKAGE_LIMITS.files} files`);
  let total = byteLength(pkg.manifest) + byteLength(pkg.html) + byteLength(pkg.css);
  // Paths that differ only by case are one file on the Mac's disk.
  const folded = new Set();
  for (const path of paths) {
    const bytes = files[path];
    if (!(bytes instanceof Uint8Array)) { errors.push(`${path}: not bytes`); continue; }
    total += bytes.length;
    const kind = FONT_FILE.test(path) ? 'font' : IMAGE_FILE.test(path) ? 'image' : NOTE_FILE.test(path) ? 'note' : null;
    if (!FILE_PATH.test(path) || path.length > 200 || path.split('/').some((seg) => /^\.+$/.test(seg))) { errors.push(`${path}: bad path`); continue; }
    if (folded.has(path.toLowerCase())) { errors.push(`${path}: another file has the same name but for case`); continue; }
    folded.add(path.toLowerCase());
    if (!kind) { errors.push(`${path}: not a file a theme may bundle (woff2 fonts, png, jpg, gif, webp, avif, svg images, txt or md notes)`); continue; }
    const cap = PACKAGE_LIMITS[`${kind}Bytes`];
    if (bytes.length > cap) errors.push(`${path}: ${kind} larger than ${cap} bytes`);
    else if (!contentMatches(path, bytes)) errors.push(`${path}: its content isn't a ${path.split('.').pop().toLowerCase()} ${kind}`);
  }
  if (total > PACKAGE_LIMITS.totalBytes) errors.push(`package: larger than ${PACKAGE_LIMITS.totalBytes} bytes`);
  return errors;
}

/**
 * The whole package checked, with one report: manifest, template and
 * stylesheet. `files`: the package's file paths; `assetUrl`: what a bundled
 * image becomes in the DOM and the CSS (a data: URL of its bytes).
 * @param {{ manifest: string, html: string, css: string, files: string[] }} pkg
 * @param {{ assetUrl?: (path: string) => string }} [options]
 */
export function sanitizeTheme(pkg, { assetUrl = (p) => p } = {}) {
  const files = pkg.files ?? [];
  const manifest = checkManifest(pkg.manifest, { files });
  // Images only as the manifest declares them (fonts are never named in CSS).
  const images = manifest.manifest ? manifest.manifest.images : files.filter((f) => IMAGE_FILE.test(f));
  const html = sanitizeTemplate(pkg.html, { files: images, assetUrl });
  const css = sanitizeCss(pkg.css ?? '', { files: images, assetUrl });
  const removed = [
    ...manifest.removed.map((r) => ({ file: 'theme.json', ...r })),
    ...html.removed.map((r) => ({ file: 'theme.html', ...r })),
    ...css.removed.map((r) => ({ file: 'theme.css', ...r })),
  ];
  const errors = [...manifest.errors, ...html.errors, ...css.errors];
  return { ok: errors.length === 0, manifest: manifest.manifest, tree: html.tree, css: css.css, removed, errors, stats: { ...html.stats, ...css.stats } };
}

// ---------------------------------------------------------------------------
// Settings as CSS variables.

/** A setting's CSS variable: `--m-` and its name in kebab case (`accentColor` → `--m-accent-color`). @param {string} key */
export const settingVar = (key) => `--m-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/**
 * The theme's settings as the theme sees them: each one the user saved
 * (settings.themes[id]) if it's good for its spec (ui/theme-schema.js
 * settingValueOk: no url(), strings, escapes or !important), else the
 * theme's default. Settings the theme doesn't declare are left out.
 * @param {any} manifest the checked manifest @param {Record<string, any> | null | undefined} saved
 * @returns {Record<string, string | number | boolean>}
 */
export function resolveSettings(manifest, saved) {
  const out = {};
  for (const [key, spec] of Object.entries(manifest?.settings ?? {})) {
    const value = saved && Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] : undefined;
    out[key] = value !== undefined && settingValueOk(spec, value) ? value : spec.default;
  }
  return out;
}

/**
 * The settings' stylesheet text: one rule on the container (`:host` in a
 * shadow root, `:root` in a document) with a variable per setting. A value
 * is written only if it passes the CSS value check again; a toggle is 1 or 0.
 * @param {Record<string, string | number | boolean>} values
 */
export function settingsCss(values) {
  const decls = [];
  for (const [key, value] of Object.entries(values ?? {})) {
    if (!/^[a-z][A-Za-z0-9]{0,31}$/.test(key)) continue;
    const css = typeof value === 'boolean' ? (value ? '1' : '0') : value;
    if (!checkCssValue(css)) continue;
    decls.push(`${settingVar(key)}:${String(css)}`);
  }
  return decls.length ? `:host,:root{${decls.join(';')}}` : '';
}

// ---------------------------------------------------------------------------
// Loading.

function base64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function unbase64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * A theme, loaded and ready for ui/runtime.js.
 * @typedef {{
 *   ok: true, id: string, manifest: any, report: any,
 *   template: DocumentFragment, sheet: CSSStyleSheet, settingsSheet: CSSStyleSheet,
 *   fonts: FontFace[], fontErrors: string[],
 *   setSettings(values: Record<string, any>): void,
 *   unload(): void,
 * }} LoadedTheme
 */

/**
 * Loads a package into `document`: checked, sanitized, its template built,
 * its sheets constructed, its fonts made from bytes and added to the
 * document's fonts. A font that doesn't load is reported, not fatal.
 * @param {ThemePackage} pkg
 * @param {{ document?: Document, settings?: Record<string, any> | null }} [options] `settings`: the user's saved ones (settings.themes[id])
 * @returns {Promise<LoadedTheme | { ok: false, report: { errors: string[], removed: any[] } }>}
 */
export async function loadTheme(pkg, { document: doc = globalThis.document, settings = null } = {}) {
  const sizes = checkPackage(pkg);
  if (sizes.length) return { ok: false, report: { errors: sizes, removed: [] } };
  const files = pkg.files ?? {};
  const assetUrl = (path) => `data:${MIME[path.split('.').pop().toLowerCase()] ?? 'application/octet-stream'};base64,${base64(files[path])}`;
  const report = sanitizeTheme({ manifest: pkg.manifest, html: pkg.html, css: pkg.css, files: Object.keys(files) }, { assetUrl });
  if (!report.ok) return { ok: false, report };
  const win = doc.defaultView;
  const template = buildTemplate(report.tree);
  const sheet = new win.CSSStyleSheet();
  sheet.replaceSync(report.css);
  const settingsSheet = new win.CSSStyleSheet();
  const manifest = report.manifest;
  const setSettings = (saved) => settingsSheet.replaceSync(settingsCss(resolveSettings(manifest, saved)));
  setSettings(settings);
  const faces = manifest.fonts.map((f) => new win.FontFace(f.family, files[f.file].slice().buffer, {
    weight: f.weight, style: f.style, ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}), display: 'block',
  }));
  const loaded = await Promise.allSettled(faces.map((face) => face.load()));
  const fonts = [];
  const fontErrors = [];
  loaded.forEach((r, i) => {
    if (r.status === 'fulfilled') { doc.fonts.add(r.value); fonts.push(r.value); } else fontErrors.push(`${manifest.fonts[i].file}: ${r.reason?.message ?? r.reason}`);
  });
  return {
    ok: true,
    id: manifest.id,
    manifest,
    report,
    template,
    sheet,
    settingsSheet,
    fonts,
    fontErrors,
    setSettings,
    unload() { for (const face of fonts) doc.fonts.delete(face); },
  };
}

/**
 * Reads a built-in theme's package from the extension's files:
 * `readFile(path)` gives a file of `extension/themes/<id>/` as text or
 * bytes. theme.json first: it lists the fonts and images to read.
 * @param {string} id
 * @param {{ readFile?: (path: string) => Promise<string | Uint8Array> }} [options] default: the extension's own URL (runtime.getURL)
 * @returns {Promise<ThemePackage>}
 */
export async function readBuiltinTheme(id, { readFile = extensionFile(id) } = {}) {
  if (!BUILTIN_THEMES.includes(id)) throw new Error(`no built-in theme ${JSON.stringify(id)}`);
  const asText = async (path) => { const v = await readFile(path); return typeof v === 'string' ? v : new TextDecoder().decode(v); };
  const asBytes = async (path) => { const v = await readFile(path); return typeof v === 'string' ? new TextEncoder().encode(v) : v; };
  const manifest = await asText('theme.json');
  const [html, css] = await Promise.all([asText('theme.html'), asText('theme.css')]);
  // The files it names (fonts, images), as plain paths; loadTheme checks
  // the whole package once they're read.
  let raw = null;
  try { raw = JSON.parse(manifest); } catch {}
  const named = [...(Array.isArray(raw?.fonts) ? raw.fonts.map((f) => f?.file) : []), ...(Array.isArray(raw?.images) ? raw.images : [])];
  const paths = [...new Set(named.filter((p) => typeof p === 'string' && FILE_PATH.test(p) && !p.split('/').some((seg) => /^\.+$/.test(seg))))].slice(0, PACKAGE_LIMITS.files);
  const files = {};
  await Promise.all(paths.map(async (path) => { files[path] = await asBytes(path); }));
  return { manifest, html, css, files };
}

function extensionFile(id) {
  return async (path) => {
    const api = /** @type {any} */ (globalThis).browser ?? /** @type {any} */ (globalThis).chrome;
    const res = await fetch(api.runtime.getURL(`themes/${id}/${path}`));
    if (!res.ok) throw new Error(`themes/${id}/${path}: ${res.status}`);
    return /\.(json|html|css)$/.test(path) ? res.text() : new Uint8Array(await res.arrayBuffer());
  };
}

/**
 * Loads a built-in theme (readBuiltinTheme, then loadTheme).
 * @param {string} id @param {{ readFile?: (path: string) => Promise<string | Uint8Array>, document?: Document, settings?: Record<string, any> | null }} [options]
 */
export async function loadBuiltinTheme(id, { readFile, document, settings } = {}) {
  return loadTheme(await readBuiltinTheme(id, readFile ? { readFile } : {}), { document, settings });
}

// ---------------------------------------------------------------------------
// A user's theme, stored in storage.local: one key per theme
// (`userTheme:<id>`) and a short index (`userThemes`: [{ id, name, version,
// author, bytes, savedAt }]) for Settings, so listing them never reads the
// packages. One set() writes a theme and the index together.
//
// The stored value: { format: 2, id, version, savedAt, manifest, html, css,
// files: { [path]: base64 } }. It's checked again every time it loads.

export const USER_THEMES = USER_THEMES_KEY;
export const STORED_FORMAT = 2;
/** @param {string} id */
export const userThemeKey = (id) => `userTheme:${id}`;

/**
 * A package as stored. Refused (an Error) if it fails the caps or the checks.
 * @param {ThemePackage} pkg @param {{ now?: number }} [options]
 */
export function encodeStoredTheme(pkg, { now = Date.now() } = {}) {
  const sizes = checkPackage(pkg);
  if (sizes.length) throw new Error(sizes.join('; '));
  const report = sanitizeTheme({ manifest: pkg.manifest, html: pkg.html, css: pkg.css, files: Object.keys(pkg.files) });
  if (!report.ok) throw new Error(report.errors.join('; '));
  const files = Object.fromEntries(Object.entries(pkg.files).map(([path, bytes]) => [path, base64(bytes)]));
  const value = { format: STORED_FORMAT, id: report.manifest.id, version: report.manifest.version, savedAt: now, manifest: pkg.manifest, html: pkg.html, css: pkg.css, files };
  const bytes = byteLength(JSON.stringify(value));
  if (bytes > PACKAGE_LIMITS.storedBytes) throw new Error(`stored theme larger than ${PACKAGE_LIMITS.storedBytes} bytes`);
  return { value, entry: { id: report.manifest.id, name: report.manifest.name, version: report.manifest.version, author: report.manifest.author ?? '', bytes, savedAt: now } };
}

/**
 * A stored value back as a package (null if it isn't one).
 * @param {any} value @returns {ThemePackage | null}
 */
export function decodeStoredTheme(value) {
  if (!value || typeof value !== 'object' || value.format !== STORED_FORMAT) return null;
  if (typeof value.manifest !== 'string' || typeof value.html !== 'string' || typeof value.css !== 'string' || !value.files || typeof value.files !== 'object') return null;
  const files = {};
  for (const [path, text] of Object.entries(value.files)) {
    if (typeof text !== 'string') return null;
    try { files[path] = unbase64(text); } catch { return null; }
  }
  return { manifest: value.manifest, html: value.html, css: value.css, files };
}

/**
 * Stores a user's theme (replacing one with its id) and updates the index.
 * @param {ThemePackage} pkg
 * @param {{ get: (keys: string[]) => Promise<Record<string, any>>, set: (items: Record<string, any>) => Promise<void>, now?: number }} storage
 * @returns {Promise<string>} its id
 */
export async function saveUserTheme(pkg, { get, set, now }) {
  const { value, entry } = encodeStoredTheme(pkg, { now });
  if (BUILTIN_THEMES.includes(entry.id)) throw new Error(`${entry.id} is a built-in theme's id`);
  const index = (await get([USER_THEMES]))[USER_THEMES];
  const list = (Array.isArray(index) ? index : []).filter((e) => e?.id !== entry.id);
  await set({ [userThemeKey(entry.id)]: value, [USER_THEMES]: [...list, entry] });
  return entry.id;
}

/**
 * Loads a user's stored theme: read, decoded, and checked again as any
 * package is.
 * @param {string} id
 * @param {{ get: (keys: string[]) => Promise<Record<string, any>>, document?: Document, settings?: Record<string, any> | null }} options
 */
export async function loadUserTheme(id, { get, document, settings }) {
  const pkg = decodeStoredTheme((await get([userThemeKey(id)]))[userThemeKey(id)]);
  if (!pkg) return { ok: false, report: { errors: [`no stored theme ${JSON.stringify(id)}`], removed: [] } };
  const theme = await loadTheme(pkg, { document, settings });
  if (theme.ok && /** @type {any} */ (theme).id !== id) return { ok: false, report: { errors: [`stored theme ${JSON.stringify(id)} says it's ${JSON.stringify(/** @type {any} */ (theme).id)}`], removed: [] } };
  return theme;
}
