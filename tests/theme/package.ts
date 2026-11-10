// Reads a theme package from disk (Node), for the unit tests and for handing
// to a browser page as base64.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { PACKAGE_THEMES } from '../../extension/themes/packages.ts';

export const NEO = fileURLToPath(new URL('../../extension/themes/neubrutalism/', import.meta.url));
export const ARCADIA = fileURLToPath(new URL('../../extension/themes/arcadia/', import.meta.url));
export const PIXEL = fileURLToPath(new URL('../../extension/themes/pixel/', import.meta.url));

// The reference theme: the one the theme-agnostic browser tests run in when CI scopes them to one.
export const REFERENCE_THEME = 'arcadia';

/**
 * Which of a test file's themes it runs in: MARGIN_TEST_THEMES, set by CI from what a change reaches
 * (.github/workflows/ci.yml, scripts/ci-plan.mts). Unset, empty or `all`: every one (local runs and npm run gate).
 * Else built-in ids, comma-separated; `reference` stands for Arcadia, or the file's first theme where it has no
 * Arcadia (behaviors.test.ts: the two themes that share the sidebar's classes). An entry with no id (a package named
 * in MARGIN_THEMES, security.test.ts) is always kept. (Not MARGIN_THEMES: that one adds packages to the security suite.)
 */
export function themesInScope<T>(themes: readonly T[], idOf: (t: T) => string | null = (t) => (t as any)[0], env: string = process.env.MARGIN_TEST_THEMES ?? ''): T[] {
  const want = env.split(',').map((s) => s.trim()).filter(Boolean);
  if (!want.length || want.includes('all')) return [...themes];
  for (const w of want) if (w !== 'reference' && !PACKAGE_THEMES.includes(w)) throw new Error(`MARGIN_TEST_THEMES: ${w} isn't a built-in theme (${PACKAGE_THEMES.join(', ')}, reference or all)`);
  const ids = themes.map(idOf).filter((id): id is string => id != null);
  const keep = new Set(want.filter((w) => w !== 'reference'));
  if (want.includes('reference') && ids.length) keep.add(ids.includes(REFERENCE_THEME) ? REFERENCE_THEME : ids[0]);
  return themes.filter((t) => { const id = idOf(t); return id == null || keep.has(id); });
}

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
