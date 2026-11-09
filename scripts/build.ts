// Builds ready-to-load extensions for each browser from the one shared source:
//   extension/ (shared) + platform/<target>/manifest.json (overrides)
//   → dist/<target>/, with shared/platform.ts stamped for that browser.
// dist/ is committed (no Node needed on the Mac to use it); a unit test fails
// if it's out of date. Usage: node scripts/build.ts
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSync, transformSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { allLayoutFiles, firstPaintCss, firstPaintFile } from '../extension/shared/page-box.ts';
import { PACKAGE_THEMES } from '../extension/themes/packages.ts';
import { WIDTH } from '../extension/themes/arcadia/theme.ts';

const root = new URL('../', import.meta.url);
const SOURCE = new URL('extension/', root);
export const TARGETS = ['chrome', 'safari'];
// How esbuild reads Margin's TypeScript (the bundles are built from copies outside the repo's tsconfig.json too):
// every import kept as written (a module's side effects stay, as in JavaScript), class fields as JavaScript's.
const TSCONFIG = { compilerOptions: { verbatimModuleSyntax: true, useDefineForClassFields: true } };
// The sources, once bundled: not shipped (no page loads them; the bundles have them all).
const isSource = (name: string) => /\.m?ts$/.test(name) && !name.endsWith('.d.ts');
function dropSources(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      dropSources(path);
      if (!readdirSync(path).length) rmSync(path, { recursive: true });
    } else if (isSource(entry.name)) rmSync(path);
  }
}

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
  const source = readFileSync(new URL('shared/platform.ts', SOURCE), 'utf8');
  const marker = 'const BUILD_TARGET = null; // set by scripts/build.ts';
  if (!source.includes(marker)) throw new Error('shared/platform.ts: BUILD_TARGET marker not found');
  return source.replace(marker, `const BUILD_TARGET = '${target}'; // set by scripts/build.ts`);
}

// One build: `profile` decides behavior (shared/platform.ts), `manifest`
// which manifest overrides to use. They're the same for dist/; tests also
// build the Safari profile with Chrome's manifest so Chromium can load it.
export function buildTo(outDir, { profile, manifest = profile }) {
  const out = outDir instanceof URL ? fileURLToPath(outDir) : outDir;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // Skip Finder's .DS_Store files (git-ignored) so a Mac build matches CI.
  cpSync(fileURLToPath(SOURCE), out, { recursive: true, filter: (src) => !src.endsWith('/.DS_Store') });
  writeFileSync(`${out}/shared/platform.ts`, platformFileFor(profile));
  const built = manifestFor(manifest);
  bundle(out, built);
  // The one plain script registered as a file, not bundled (background/registered.ts FULLSCREEN_ONLY_JS).
  const plain = `${out}/content/page/fullscreen-only`;
  writeFileSync(`${plain}.js`, transformSync(readFileSync(`${plain}.ts`, 'utf8'), { loader: 'ts', tsconfigRaw: TSCONFIG }).code);
  dropSources(out);
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
  away: 'away/away.bundle.js',
};
// The first paint (shared/page-box.ts, background/registered.ts): the
// layout's digit files and at.css, and each built-in theme's
// first-paint file, the box with the theme's look (themes/<id>/first-paint.css).
export const FIRST_PAINT_THEMES = PACKAGE_THEMES.filter((id) => existsSync(new URL(`themes/${id}/first-paint.css`, SOURCE)));
function firstPaintFiles(out) {
  mkdirSync(`${out}/content/layout`, { recursive: true });
  for (const [file, css] of allLayoutFiles()) writeFileSync(`${out}/${file}`, css);
  for (const id of FIRST_PAINT_THEMES) writeFileSync(`${out}/${firstPaintFile(id)}`, firstPaintCss(id, readFileSync(new URL(`themes/${id}/first-paint.css`, SOURCE), 'utf8')));
}
// Safari keeps registrations across launches and loads none of them if a file
// one lists is missing (DECISIONS.md, 2026-10-25: WebKit validates them all
// together at load, and `getRegisteredContentScripts` then lists none, so the
// background can't drop them). The build before Margin 2 Phase 3 registered
// a first-paint placeholder per sidebar width and a file per left edge for the
// page's script: they stay as empty files until no Safari has that
// registration, so an update from that build loads its registrations, and
// the background replaces them (background/registered.ts). Remove after a
// release or two of Phase 3.
const WIDTHS = Array.from({ length: (WIDTH.max - WIDTH.min) / WIDTH.step + 1 }, (_, i) => WIDTH.min + i * WIDTH.step);
export const LEGACY_FILES = [
  ...WIDTHS.map((w) => `themes/arcadia/docked/w-${w}.css`),
  'themes/arcadia/docked/closed.css',
  ...[8, ...WIDTHS].map((left) => `content/page/at-${left}.js`),
];

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
    tsconfigRaw: TSCONFIG,
  });

  firstPaintFiles(out);
  for (const file of LEGACY_FILES) {
    mkdirSync(dirname(`${out}/${file}`), { recursive: true });
    writeFileSync(`${out}/${file}`, '');
  }

  // Margin's content script (its core on web pages, with the UI runtime).
  const [sidebar] = manifest.content_scripts;
  write(BUNDLES.content, sidebar.js);
  sidebar.js = [BUNDLES.content];

  // Chrome's background is a service worker; Safari's a page (`scripts`,
  // non-persistent, Manifest V3's default, so no `persistent` key: the converter
  // warns on it; platform/safari/manifest.json), since WebKit hangs a
  // service worker that opens a WebSocket, and the link to Margin.app is one
  // (background/link.ts, PLAN.md §14 Spike 3). One bundle either way.
  const bg = manifest.background;
  write(BUNDLES.background, bg.service_worker ? [bg.service_worker] : bg.scripts);
  if (bg.service_worker) bg.service_worker = BUNDLES.background;
  else bg.scripts = [BUNDLES.background];

  // The page's box, in the page's world (registered by the background).
  write(BUNDLES.page, ['content/page/main.ts']);

  // The new-tab page and the stand-in for a tab shown in another window (modules: they await at the top level).
  for (const [page, file] of [['newtab', BUNDLES.newtab], ['away', BUNDLES.away]]) {
    const html = readFileSync(`${out}/${page}/${page}.html`, 'utf8');
    const tag = /<script src="([^"]+)" type="module"><\/script>/.exec(html);
    if (!tag) throw new Error(`${page}.html: module script not found`);
    write(file, [`${page}/${tag[1]}`], { format: 'esm' });
    writeFileSync(`${out}/${page}/${page}.html`, html.replace(tag[0], `<script src="${file.split('/').pop()}" type="module"></script>`));
  }
}

// Margin.app's overlay page (app/overlay/: the UI runtime with the app's
// host, extension/ui/host-app.ts) as one script and its page, for the app's
// Resources/app/ (scripts/xcode-add-sources.py). Safari's profile for now
// (Margin 2 Phase 2 is Safari's; Chrome and Edge are Phase 5).
export const APP_FILES = ['overlay.html', 'overlay.js', 'arcadia.js'];
export function buildApp(outDir, { profile = 'safari' } = {}) {
  const out = outDir instanceof URL ? fileURLToPath(outDir) : outDir;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // The extension's modules with shared/platform.ts stamped for the profile,
  // and the page's entry pointed at them.
  const tmp = mkdtempSync(join(tmpdir(), 'margin-app-'));
  try {
    cpSync(fileURLToPath(SOURCE), tmp, { recursive: true, filter: (src) => !src.endsWith('/.DS_Store') });
    writeFileSync(`${tmp}/shared/platform.ts`, platformFileFor(profile));
    const entry = readFileSync(new URL('app/overlay/overlay.ts', root), 'utf8').replaceAll("'../../extension/", "'./");
    buildSync({
      stdin: { contents: entry, resolveDir: tmp, sourcefile: 'app/overlay/overlay.ts', loader: 'ts' },
      tsconfigRaw: TSCONFIG,
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
  writeFileSync(`${out}/${FALLBACK_FILE}`, fallbackScript());
  return out;
}

// Arcadia, bundled with the overlay (docs/phase6-themes.md §3): what it draws
// when the theme it's handed is refused, missing, or leaves no usable page.
// A script, not JSON: the overlay's policy allows no connections (fetch),
// only Margin's own scripts from its folder. The package in the `theme`
// message's shape (background/theme-package.ts ThemeMessage), loaded only
// when it's needed (app/overlay/overlay.ts fallBack).
export const FALLBACK_FILE = 'arcadia.js';
export function fallbackPackage() {
  const dir = new URL('themes/arcadia/', SOURCE);
  const manifest = readFileSync(new URL('theme.json', dir), 'utf8');
  const raw = JSON.parse(manifest);
  const named = [...(raw.fonts ?? []).map((f) => f.file), ...(raw.images ?? [])];
  const files = Object.fromEntries(named.map((p) => [p, readFileSync(new URL(p, dir)).toString('base64')]));
  return { id: 'arcadia', manifest, html: readFileSync(new URL('theme.html', dir), 'utf8'), css: readFileSync(new URL('theme.css', dir), 'utf8'), files };
}
function fallbackScript() {
  return `// Arcadia for Margin.app's overlay to fall back on (scripts/build.ts fallbackPackage).\nglobalThis.marginFallbackTheme = ${JSON.stringify(fallbackPackage())};\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const target of TARGETS) {
    buildTo(new URL(`dist/${target}/`, root), { profile: target });
    console.log(`dist/${target}/`);
  }
  buildApp(new URL('dist/app/', root));
  console.log('dist/app/');
}
