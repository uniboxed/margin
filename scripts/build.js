// Builds ready-to-load extensions for each browser from the one shared source:
//   extension/ (shared) + platform/<target>/manifest.json (overrides)
//   → dist/<target>/, with shared/platform.js stamped for that browser.
// Also regenerates content/styles.js and content/docked/ first.
// dist/ is committed (no Node needed on the Mac to use it); a unit test fails
// if it's out of date. Usage: node scripts/build.js
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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

// Each context's scripts as one file, in the order they load today, so a
// page injects one script instead of ten (and the background and the new-tab
// page load one each). Plain scripts, minified but with their names kept, so
// errors stay readable. The individual files stay in dist/ too: Safari keeps
// script registrations across launches and drops all of them if a file one
// lists is missing (DECISIONS.md, 2026-10-25).
const BUNDLES = { content: 'content/content.bundle.js', background: 'background.bundle.js', shell: 'content/shell.bundle.js', newtab: 'newtab/newtab.bundle.js' };
export const SHELL_FILES = ['shared/shell-logic.js', 'content/shell.js'];

function bundle(out, manifest) {
  const write = (file, files, { format = 'iife', banner } = {}) => buildSync({
    stdin: { contents: files.map((f) => `import './${f}';`).join('\n'), resolveDir: out, sourcefile: 'margin-bundle-entry.js' },
    bundle: true,
    format,
    target: 'esnext',
    minifyWhitespace: true,
    minifySyntax: true,
    legalComments: 'none',
    charset: 'utf8',
    banner: banner ? { js: banner } : undefined,
    outfile: `${out}/${file}`,
    logLevel: 'warning',
  });

  // Content scripts (the sidebar and palette): the manifest's list.
  const [sidebar] = manifest.content_scripts;
  write(BUNDLES.content, sidebar.js);
  sidebar.js = [BUNDLES.content];

  // The background: what it imports with importScripts, then its own code.
  const background = readFileSync(`${out}/background.js`, 'utf8');
  const imports = /^importScripts\(([^)]*)\);\n/m.exec(background);
  if (!imports) throw new Error('background.js: importScripts(...) line not found');
  const tmp = `${out}/.bundle`;
  mkdirSync(tmp, { recursive: true });
  writeFileSync(`${tmp}/background.js`, background.replace(imports[0], ''));
  // MARGIN_BUNDLED: background.js registers the bundled fitted-layout script.
  write(BUNDLES.background, [...[...imports[1].matchAll(/'([^']+)'/g)].map((m) => m[1]), '.bundle/background.js'], { banner: 'globalThis.MARGIN_BUNDLED = true;' });
  rmSync(tmp, { recursive: true, force: true });
  manifest.background.service_worker = BUNDLES.background;

  // The fitted layout (registered by background.js).
  write(BUNDLES.shell, SHELL_FILES);

  // The new-tab page: its scripts in page order (the last one is a module).
  const html = readFileSync(`${out}/newtab/newtab.html`, 'utf8');
  const tags = [...html.matchAll(/^\s*<script src="([^"]+)"( type="module")?><\/script>\n/gm)];
  if (!tags.length) throw new Error('newtab.html: no scripts found');
  write(BUNDLES.newtab, tags.map((t) => `newtab/${t[1]}`.replace('newtab/../', '')), { format: 'esm' });
  let page = html.replace(tags[0][0], `  <script src="${BUNDLES.newtab.split('/').pop()}" type="module"></script>\n`);
  for (const t of tags.slice(1)) page = page.replace(t[0], '');
  writeFileSync(`${out}/newtab/newtab.html`, page);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  execFileSync(process.execPath, [fileURLToPath(new URL('scripts/build-styles.js', root))], { stdio: 'inherit' });
  for (const target of TARGETS) {
    buildTo(new URL(`dist/${target}/`, root), { profile: target });
    console.log(`dist/${target}/`);
  }
}
