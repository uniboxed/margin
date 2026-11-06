// Builds ready-to-load extensions for each browser from the one shared source:
//   extension/ (shared) + platform/<target>/manifest.json (overrides)
//   → dist/<target>/, with shared/platform.js stamped for that browser.
// Also regenerates the themes' generated files first (scripts/build-styles.js).
// dist/ is committed (no Node needed on the Mac to use it); a unit test fails
// if it's out of date. Usage: node scripts/build.js
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
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
  bundle(out, built);
  writeFileSync(`${out}/manifest.json`, `${JSON.stringify(built, null, 2)}\n`);
  return out;
}

// Each context's entry module bundled into one plain script, so a page
// injects Margin's core (with the UI runtime) as one file, and the
// background and the new-tab page load one each.
// Minified, but with names kept so errors stay readable. extension/ holds
// ES modules, which content scripts and Safari's service worker can't load:
// dist/ is what browsers run.
const BUNDLES = {
  content: 'content/content.bundle.js',
  background: 'background.bundle.js',
  page: 'content/page.bundle.js',
  newtab: 'newtab/newtab.bundle.js',
};
// Where the page's box starts in the first-paint registration (background/
// registered.js pagePlan): one file per left edge.
const PAGE_LEFTS = [8, ...DOCKED_WIDTHS];

function bundle(out, manifest) {
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

  // Where the page's box starts (background/registered.js pagePlan): read by
  // the page's script, and gone again.
  for (const left of PAGE_LEFTS) writeFileSync(`${out}/content/page/at-${left}.js`, `window[Symbol.for('margin.page.start')] = { left: ${left} };\n`);

  // Margin's content script (its core on web pages, with the UI runtime).
  const [sidebar] = manifest.content_scripts;
  write(BUNDLES.content, sidebar.js);
  sidebar.js = [BUNDLES.content];

  // Chrome's background is a service worker; Safari's a page (`scripts`,
  // non-persistent, Manifest V3's default, so no `persistent` key: the converter
  // warns on it; platform/safari/manifest.json), since WebKit hangs a
  // service worker that opens a WebSocket, and the link to Margin.app is one
  // (background/link.js, PLAN.md §14 Spike 3). One bundle either way.
  const bg = manifest.background;
  write(BUNDLES.background, bg.service_worker ? [bg.service_worker] : bg.scripts);
  if (bg.service_worker) bg.service_worker = BUNDLES.background;
  else bg.scripts = [BUNDLES.background];

  // The page's box, in the page's world (registered by the background).
  write(BUNDLES.page, ['content/page/main.js']);

  // The new-tab page (a module: it awaits at the top level).
  const html = readFileSync(`${out}/newtab/newtab.html`, 'utf8');
  const tag = /<script src="([^"]+)" type="module"><\/script>/.exec(html);
  if (!tag) throw new Error('newtab.html: module script not found');
  write(BUNDLES.newtab, [`newtab/${tag[1]}`], { format: 'esm' });
  writeFileSync(`${out}/newtab/newtab.html`, html.replace(tag[0], `<script src="${BUNDLES.newtab.split('/').pop()}" type="module"></script>`));
}

// Margin.app's overlay page (app/overlay/: the UI runtime with the app's
// host, extension/ui/host-app.js) as one script and its page, for the app's
// Resources/app/ (scripts/xcode-add-sources.py). Safari's profile for now
// (Margin 2 Phase 2 is Safari's; Chrome and Edge are Phase 5).
export const APP_FILES = ['overlay.html', 'overlay.js'];
export function buildApp(outDir, { profile = 'safari' } = {}) {
  const out = outDir instanceof URL ? fileURLToPath(outDir) : outDir;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // The extension's modules with shared/platform.js stamped for the profile,
  // and the page's entry pointed at them.
  const tmp = mkdtempSync(join(tmpdir(), 'margin-app-'));
  try {
    cpSync(fileURLToPath(SOURCE), tmp, { recursive: true, filter: (src) => !src.endsWith('/.DS_Store') });
    writeFileSync(`${tmp}/shared/platform.js`, platformFileFor(profile));
    const entry = readFileSync(new URL('app/overlay/overlay.js', root), 'utf8').replaceAll("'../../extension/", "'./");
    buildSync({
      stdin: { contents: entry, resolveDir: tmp, sourcefile: 'app/overlay/overlay.js' },
      bundle: true,
      format: 'iife',
      target: 'esnext',
      minifyWhitespace: true,
      minifySyntax: true,
      legalComments: 'none',
      charset: 'utf8',
      outfile: `${out}/overlay.js`,
      logLevel: 'warning',
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  cpSync(fileURLToPath(new URL('app/overlay/overlay.html', root)), `${out}/overlay.html`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  execFileSync(process.execPath, [fileURLToPath(new URL('scripts/build-styles.js', root))], { stdio: 'inherit' });
  for (const target of TARGETS) {
    buildTo(new URL(`dist/${target}/`, root), { profile: target });
    console.log(`dist/${target}/`);
  }
  buildApp(new URL('dist/app/', root));
  console.log('dist/app/');
}
