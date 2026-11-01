// Builds ready-to-load extensions for each browser from the one shared source:
//   extension/ (shared) + platform/<target>/manifest.json (overrides)
//   → dist/<target>/, with shared/platform.js stamped for that browser.
// Also regenerates the themes' generated files first (scripts/build-styles.js).
// dist/ is committed (no Node needed on the Mac to use it); a unit test fails
// if it's out of date. Usage: node scripts/build.js
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { THEMES } from '../extension/themes/index.js';
import { PROFILES } from '../extension/shared/platform.js';
import { DOCKED_WIDTHS } from './build-styles.js';

const root = new URL('../', import.meta.url);
const SOURCE = new URL('extension/', root);
export const TARGETS = ['chrome', 'safari'];

// Overrides replace top-level keys, except `add_permissions`, which is
// appended to the shared `permissions` (so the list lives in one place).
export function manifestFor(target) {
  const base = JSON.parse(readFileSync(new URL('manifest.json', SOURCE), 'utf8'));
  const { add_permissions: addPermissions = [], ...overrides } = JSON.parse(readFileSync(new URL(`platform/${target}/manifest.json`, root), 'utf8'));
  const manifest = { ...base, ...overrides };
  if (addPermissions.length) manifest.permissions = [...new Set([...(manifest.permissions ?? []), ...addPermissions])];
  return manifest;
}

export function platformFileFor(target) {
  const source = readFileSync(new URL('shared/platform.js', SOURCE), 'utf8');
  const marker = 'const BUILD_TARGET = null; // set by scripts/build.js';
  if (!source.includes(marker)) throw new Error('shared/platform.js: BUILD_TARGET marker not found');
  return source.replace(marker, `const BUILD_TARGET = '${target}'; // set by scripts/build.js`);
}

// One build: `profile` decides behavior (shared/platform.js), `manifest`
// which manifest overrides to use. They're the same for dist/; tests also
// build the Safari profile with Chrome's manifest so Chromium can load it.
export function buildTo(outDir, { profile, manifest = profile }) {
  const out = outDir instanceof URL ? fileURLToPath(outDir) : outDir;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // Skip Finder's .DS_Store files (git-ignored) so a Mac build matches CI.
  cpSync(fileURLToPath(SOURCE), out, { recursive: true, filter: (src) => !src.endsWith('/.DS_Store') });
  writeFileSync(`${out}/shared/platform.js`, platformFileFor(profile));
  const built = manifestFor(manifest);
  bundle(out, built, PROFILES[profile]);
  writeFileSync(`${out}/manifest.json`, `${JSON.stringify(built, null, 2)}\n`);
  return out;
}

// Each context's entry module bundled into one plain script, so a page
// injects Margin's core and the active theme as one file each (and the
// background and the new-tab page load one each, plus the theme's).
// Minified, but with names kept so errors stay readable. extension/ holds
// ES modules, which content scripts and Safari's service worker can't load:
// dist/ is what browsers run. The sources stay in dist/ too: Safari keeps
// script registrations across launches and drops all of them if a file one
// lists is missing (DECISIONS.md, 2026-10-25), and earlier versions
// registered these two for the fitted layout (and content/docked/w-*.css,
// scripts/build-styles.js).
const BUNDLES = {
  content: 'content/content.bundle.js',
  background: 'background.bundle.js',
  shell: 'content/shell.bundle.js',
  shellMain: 'content/shell-main.bundle.js',
  newtab: 'newtab/newtab.bundle.js',
};
export const LEGACY_SHELL_FILES = ['shared/shell-logic.js', 'content/shell.js'];
// Where earlier versions registered Arcadia, under its earlier name: empty, so
// Safari's stored registrations stay valid until the background replaces them.
// A page that loads one then asks for the theme (handlers.js injectTheme).
export const LEGACY_THEME_FILES = [
  'themes/arcadium/content.bundle.js',
  'themes/arcadium/docked/closed.css',
  'themes/arcadium/docked/rail.css',
  ...DOCKED_WIDTHS.map((width) => `themes/arcadium/docked/w-${width}.css`),
];

function bundle(out, manifest, profile) {
  const write = (file, entries, { format = 'iife' } = {}) => buildSync({
    // A module keeps its entry's exports (a theme's new-tab mount()).
    stdin: { contents: entries.map((f) => (format === 'esm' ? `export * from './${f}';` : `import './${f}';`)).join('\n'), resolveDir: out, sourcefile: 'margin-bundle-entry.js' },
    bundle: true,
    format,
    target: 'esnext',
    minifyWhitespace: true,
    minifySyntax: true,
    legalComments: 'none',
    charset: 'utf8',
    outfile: `${out}/${file}`,
    logLevel: 'warning',
  });

  mkdirSync(`${out}/content/frameless`, { recursive: true });
  for (const width of DOCKED_WIDTHS) writeFileSync(`${out}/content/frameless/w-${width}.js`, `globalThis.__marginWidth = ${width};\n`);
  for (const file of LEGACY_THEME_FILES) {
    mkdirSync(dirname(`${out}/${file}`), { recursive: true });
    writeFileSync(`${out}/${file}`, '');
  }

  // Margin's content script (its core on web pages; the theme is separate).
  const [sidebar] = manifest.content_scripts;
  write(BUNDLES.content, sidebar.js);
  sidebar.js = [BUNDLES.content];

  write(BUNDLES.background, [manifest.background.service_worker]);
  manifest.background.service_worker = BUNDLES.background;

  // The fitted layout (registered by background.js), and its page-world
  // part from the manifest: the card's setup in Safari, plus the writer
  // where the profile needs one (Chrome; content/shell-writer.js).
  write(BUNDLES.shell, ['content/shell.js']);
  const main = manifest.content_scripts.find((c) => c.world === 'MAIN');
  write(BUNDLES.shellMain, [...main.js, ...(profile.shellPageWrite ? ['content/shell-writer.js'] : [])]);
  main.js = [BUNDLES.shellMain];

  // The new-tab page (a module: it awaits at the top level).
  const html = readFileSync(`${out}/newtab/newtab.html`, 'utf8');
  const tag = /<script src="([^"]+)" type="module"><\/script>/.exec(html);
  if (!tag) throw new Error('newtab.html: module script not found');
  write(BUNDLES.newtab, [`newtab/${tag[1]}`], { format: 'esm' });
  writeFileSync(`${out}/newtab/newtab.html`, html.replace(tag[0], `<script src="${BUNDLES.newtab.split('/').pop()}" type="module"></script>`));

  // Each theme: its part on web pages (registered by the background while
  // it's the active theme) and its new-tab page (imported by newtab.js).
  for (const theme of Object.values(THEMES)) {
    write(theme.content, [`themes/${theme.id}/content.js`]);
    write(theme.newtab, [`themes/${theme.id}/newtab.js`], { format: 'esm' });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  execFileSync(process.execPath, [fileURLToPath(new URL('scripts/build-styles.js', root))], { stdio: 'inherit' });
  for (const target of TARGETS) {
    buildTo(new URL(`dist/${target}/`, root), { profile: target });
    console.log(`dist/${target}/`);
  }
}
