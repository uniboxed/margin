// Reads a theme package from disk (Node), for the unit tests and for handing
// to a browser page as base64.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

export const NEO = fileURLToPath(new URL('../../extension/themes/neo-brutalism/', import.meta.url));
export const ARCADIA = fileURLToPath(new URL('../../extension/themes/arcadia/', import.meta.url));
export const PIXEL = fileURLToPath(new URL('../../extension/themes/pixel/', import.meta.url));

const PACKAGE_FILES = new Set(['theme.json', 'theme.html', 'theme.css']);
// A package's own files: the three, and what's under fonts/ and images/.
// (Arcadia's folder also holds its first-paint placeholders and their
// descriptor, theme.ts: not the package's.)
const BUNDLED = /^(fonts|images)\//;

export function readTheme(dir = NEO): { manifest: string, html: string, css: string, files: Record<string, Buffer> } {
  const files = {};
  const walk = (sub) => {
    for (const name of readdirSync(join(dir, sub))) {
      const rel = sub ? `${sub}/${name}` : name;
      if (statSync(join(dir, rel)).isDirectory()) { if (BUNDLED.test(`${rel}/`)) walk(rel); }
      else if (!PACKAGE_FILES.has(rel) && BUNDLED.test(rel) && name !== '.DS_Store') files[rel] = readFileSync(join(dir, rel));
    }
  };
  walk('');
  const text = (f) => readFileSync(join(dir, f), 'utf8');
  return { manifest: text('theme.json'), html: text('theme.html'), css: text('theme.css'), files };
}

// The same, with the files as base64 strings (for page.evaluate).
export function themeForPage(dir = NEO) {
  const t = readTheme(dir);
  return { ...t, files: Object.fromEntries(Object.entries(t.files).map(([k, v]) => [k, v.toString('base64')])) };
}

// The browser harness (tests/theme/harness.ts) as one plain script.
export function harnessScript() {
  const out = buildSync({
    entryPoints: [fileURLToPath(new URL('./harness.ts', import.meta.url))],
    bundle: true, format: 'iife', write: false, target: 'es2022', logLevel: 'silent',
  });
  return out.outputFiles[0].text;
}
