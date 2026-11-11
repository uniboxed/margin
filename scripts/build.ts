// Builds ready-to-load extensions, one per engine, from the one shared source:
//   extension/ (shared) + its engine's own code (extension/engines/<engine>/: its capabilities, its modules)
//   and manifest changes (MANIFESTS) → dist/<engine>/ (DIST: dist/webkit/ for Safari, dist/chromium/ for
//   Chrome, Edge and the other Chromium browsers), and dist/app/ (Margin.app's host page).
// Each build takes only its own engine's code: shared code reaches it as `#engine` and `#engine/capabilities`
// (package.json "imports"), which the build resolves by its engine's condition (CONDITIONS); unbuilt (unit
// tests), they pick either engine's by the extension's URL. Usage: node scripts/build.ts
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildSync, transformSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { allLayoutFiles, firstPaintCss, firstPaintFile } from '../extension/shared/page-box.ts';
import { PACKAGE_THEMES } from '../extension/themes/packages.ts';
import { WIDTH } from '../extension/themes/arcadia/theme.ts';

const root = new URL('../', import.meta.url);
const SOURCE = new URL('extension/', root);
// The builds by their name (shared/capabilities.ts Capabilities.name: what saved data and the link call them), each
// one's dist/ folder by its engine, and the package.json "imports" condition that gives `#engine` its engine's code.
export type Target = 'chrome' | 'safari';
export const TARGETS: Target[] = ['chrome', 'safari'];
export const DIST: Record<Target, string> = { safari: 'webkit', chrome: 'chromium' };
export const CONDITIONS: Record<Target, string> = { safari: 'margin-webkit', chrome: 'margin-chromium' };
// How esbuild reads Margin's TypeScript (the bundles are built from copies outside the repo's tsconfig.json too):
// every import kept as written (a module's side effects stay, as in JavaScript), class fields as JavaScript's.
const TSCONFIG = { compilerOptions: { verbatimModuleSyntax: true, useDefineForClassFields: true } };
// extension/engines/ and everything in it: never copied into a build.
const ENGINES_DIR = fileURLToPath(new URL('engines', SOURCE));
const isEngines = (src: string) => src === ENGINES_DIR || src.startsWith(`${ENGINES_DIR}/`);
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

// Each build's manifest changes, in its engine's folder: Safari's in WebKit's (its only browser there), Chrome's
// build Chromium's own (Chrome, Edge and the other Chromium browsers run it).
export const MANIFESTS: Record<Target, string> = {
  safari: 'extension/engines/webkit/safari/manifest.json',
  chrome: 'extension/engines/chromium/manifest.json',
};
// Overrides replace top-level keys, except `add_permissions`, which is
// appended to the shared `permissions` (so the list lives in one place).
export function manifestFor(target: Target) {
  const base = JSON.parse(readFileSync(new URL('manifest.json', SOURCE), 'utf8'));
  const { add_permissions: addPermissions = [], ...overrides } = JSON.parse(readFileSync(new URL(MANIFESTS[target], root), 'utf8'));
  const manifest = { ...base, ...overrides };
  if (addPermissions.length) manifest.permissions = [...new Set([...(manifest.permissions ?? []), ...addPermissions])];
  return manifest;
}

// One build: `profile` decides behavior (its engine's capabilities and modules), `manifest`
// which manifest overrides to use. They're the same for dist/; tests also
// build the Safari profile with Chrome's manifest so Chromium can load it.
export function buildTo(outDir: string | URL, { profile, manifest = profile }: { profile: Target, manifest?: Target }) {
  const out = outDir instanceof URL ? fileURLToPath(outDir) : outDir;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // The files pages load as they are. Skip Finder's .DS_Store files (git-ignored) so a Mac build matches CI, and
  // extension/engines/ (each engine's code is bundled from there; its manifest goes through manifestFor).
  cpSync(fileURLToPath(SOURCE), out, { recursive: true, filter: (src) => !src.endsWith('/.DS_Store') && !isEngines(src) });
  const built = manifestFor(manifest);
  bundle(out, built, profile);
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
function firstPaintFiles(out: string) {
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
  // Neubrutalism's first paint by its name until 2026-11-10 (Neo-brutalism): registered while it was the theme,
  // so kept, empty, as the files above, until no Safari has that registration.
  'content/layout/theme-neo-brutalism.css',
];

// What every bundle is built with: its engine's code for `#engine` (package.json "imports"), on top of
// esbuild's own conditions.
const engineOptions = (profile: Target) => ({ conditions: [CONDITIONS[profile]], tsconfigRaw: TSCONFIG });

function bundle(out: string, manifest: Record<string, any>, profile: Target) {
  // From the sources themselves (the copy in `out` is for the files pages load as they are), so each engine's
  // modules and the shared ones they import are one module each.
  const source = fileURLToPath(SOURCE);
  const write = (file: string, entries: string[], { format = 'iife' }: { format?: 'iife' | 'esm' } = {}) => buildSync({
    // A module keeps its entry's exports (a theme's new-tab mount()).
    stdin: { contents: entries.map((f) => (format === 'esm' ? `export * from './${f}';` : `import './${f}';`)).join('\n'), resolveDir: source, sourcefile: 'margin-bundle-entry.js' },
    ...engineOptions(profile),
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
  // warns on it; extension/engines/webkit/safari/manifest.json), since WebKit hangs a
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

// Margin.app's overlay page (app/shared/host/: the UI runtime with the app's
// host, extension/ui/host-app.ts) as one script and its page, for the app's
// Resources/app/ (scripts/xcode-add-sources.py). Safari's profile for now
// (Margin 2 Phase 2 is Safari's; Chrome and Edge are Phase 5).
export const APP_FILES = ['overlay.html', 'overlay.js', 'arcadia.js', 'handoff-cover.html', 'handoff-cover.js'];
export function buildApp(outDir: string | URL, { profile = 'safari' }: { profile?: Target } = {}) {
  const out = outDir instanceof URL ? fileURLToPath(outDir) : outDir;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // The page's entry and the extension's modules it imports, with the profile's engine's code.
  for (const entry of ['overlay', 'handoff-cover']) buildSync({
    entryPoints: [fileURLToPath(new URL(`app/shared/host/${entry}.ts`, root))],
    ...engineOptions(profile),
    bundle: true,
    format: 'iife',
    target: 'esnext',
    minifyWhitespace: true,
    minifySyntax: true,
    legalComments: 'none',
    charset: 'utf8',
    outfile: `${out}/${entry}.js`,
    logLevel: 'warning',
  });
  cpSync(fileURLToPath(new URL('app/shared/host/overlay.html', root)), `${out}/overlay.html`);
  cpSync(fileURLToPath(new URL('app/shared/host/handoff-cover.html', root)), `${out}/handoff-cover.html`);
  writeFileSync(`${out}/${FALLBACK_FILE}`, fallbackScript());
  return out;
}

// Arcadia, bundled with the overlay (docs/phase6-themes.md §3): what it draws
// when the theme it's handed is refused, missing, or leaves no usable page.
// A script, not JSON: the overlay's policy allows no connections (fetch),
// only Margin's own scripts from its folder. The package in the `theme`
// message's shape (background/theme-package.ts ThemeMessage), loaded only
// when it's needed (app/shared/host/overlay.ts fallBack).
export const FALLBACK_FILE = 'arcadia.js';
export function fallbackPackage() {
  const dir = new URL('themes/arcadia/', SOURCE);
  const manifest = readFileSync(new URL('theme.json', dir), 'utf8');
  const raw = JSON.parse(manifest);
  const named: string[] = [...(raw.fonts ?? []).map((f: { file: string }) => f.file), ...(raw.images ?? [])];
  const files = Object.fromEntries(named.map((p) => [p, readFileSync(new URL(p, dir)).toString('base64')]));
  return { id: 'arcadia', manifest, html: readFileSync(new URL('theme.html', dir), 'utf8'), css: readFileSync(new URL('theme.css', dir), 'utf8'), files };
}
function fallbackScript() {
  return `// Arcadia for Margin.app's overlay to fall back on (scripts/build.ts fallbackPackage).\nglobalThis.marginFallbackTheme = ${JSON.stringify(fallbackPackage())};\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const target of TARGETS) {
    buildTo(new URL(`dist/${DIST[target]}/`, root), { profile: target });
    console.log(`dist/${DIST[target]}/`);
  }
  buildApp(new URL('dist/app/', root));
  console.log('dist/app/');
}
