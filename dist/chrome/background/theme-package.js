// The active theme's package for pages (Margin 2, PLAN.md §3): its three
// texts and the files its theme.json names (fonts, images), read from the
// extension's own files and handed over in a message, so a web page's
// content script never loads an extension URL (nothing needs
// web_accessible_resources, and a page can't tell Margin is there by
// probing one). The page checks it as any package (ui/theme-loader.js
// loadTheme: sanitized, size-capped) before it draws a thing. Read once per
// background run and kept.
import { PACKAGE_THEMES } from '../themes/packages.js';
import { DEFAULT_THEME } from '../themes/index.js';
import { api } from './store.js';

const FILE_PATH = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const MAX_FILES = 64; // ui/theme-loader.js PACKAGE_LIMITS.files

/** @type {Map<string, Promise<ThemeMessage>>} */
const cache = new Map();

/**
 * A package as a message carries it: the files' bytes as base64.
 * @typedef {{ id: string, manifest: string, html: string, css: string, files: Record<string, string> }} ThemeMessage
 */

/** The built-in theme for these settings (an unknown one: the default). @param {any} settings */
export const activeThemeId = (settings) => (PACKAGE_THEMES.includes(settings?.theme) ? settings.theme : DEFAULT_THEME);

function base64(/** @type {Uint8Array} */ bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Reads a built-in theme's package. `fetchFile(path)`: a file of
 * extension/themes/<id>/ as a Response (default: the extension's own URL).
 * @param {string} id
 * @param {{ fetchFile?: (path: string) => Promise<Response> }} [options]
 * @returns {Promise<ThemeMessage>}
 */
export async function readThemePackage(id, { fetchFile = (path) => fetch(api.runtime.getURL(`themes/${id}/${path}`)) } = {}) {
  if (!PACKAGE_THEMES.includes(id)) throw new Error(`no built-in theme ${JSON.stringify(id)}`);
  const get = async (path) => {
    const res = await fetchFile(path);
    if (!res.ok) throw new Error(`themes/${id}/${path}: ${res.status}`);
    return res;
  };
  const [manifest, html, css] = await Promise.all(['theme.json', 'theme.html', 'theme.css'].map(async (f) => (await get(f)).text()));
  let raw = null;
  try { raw = JSON.parse(manifest); } catch {}
  const named = [...(Array.isArray(raw?.fonts) ? raw.fonts.map((f) => f?.file) : []), ...(Array.isArray(raw?.images) ? raw.images : [])];
  const paths = [...new Set(named.filter((p) => typeof p === 'string' && FILE_PATH.test(p) && !p.split('/').some((seg) => /^\.+$/.test(seg))))].slice(0, MAX_FILES);
  const files = {};
  await Promise.all(paths.map(async (path) => { files[path] = base64(new Uint8Array(await (await get(path)).arrayBuffer())); }));
  return { id, manifest, html, css, files };
}

/** The package for `id`, read once. @param {string} id */
export function themePackage(id) {
  if (!cache.has(id)) {
    const read = readThemePackage(id);
    cache.set(id, read);
    read.catch(() => cache.delete(id)); // tried again next time
  }
  return /** @type {Promise<ThemeMessage>} */ (cache.get(id));
}
