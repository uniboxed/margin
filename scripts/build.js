// Builds ready-to-load extensions for each browser from the one shared source:
//   extension/ (shared) + platform/<target>/manifest.json (overrides)
//   → dist/<target>/, with shared/platform.js stamped for that browser.
// Also regenerates content/styles.js and content/docked/ first.
// dist/ is committed (no Node needed on the Mac to use it); a unit test fails
// if it's out of date. Usage: node scripts/build.js
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  writeFileSync(`${out}/manifest.json`, `${JSON.stringify(manifestFor(manifest), null, 2)}\n`);
  writeFileSync(`${out}/shared/platform.js`, platformFileFor(profile));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  execFileSync(process.execPath, [fileURLToPath(new URL('scripts/build-styles.js', root))], { stdio: 'inherit' });
  for (const target of TARGETS) {
    buildTo(new URL(`dist/${target}/`, root), { profile: target });
    console.log(`dist/${target}/`);
  }
}
