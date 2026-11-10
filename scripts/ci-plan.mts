#!/usr/bin/env node
// CI's plan (.github/workflows/ci.yml, the `changes` job): from the files a change touches, which checks it can
// reach, and the browser jobs' matrix, with the theme tests scoped to what the change reaches:
//
// - the workflow, the lockfiles, the build script or this plan changed, a nightly run, by hand, or no base to compare
//   with: everything, every theme, both engines (the theme tests on two Macs);
// - a theme's folder changed (extension/themes/<id>/): that theme's own browser tests (tests/theme/<id>.test.ts) and
//   its entries in the tests that loop over the themes (those calling themesInScope), nobody else's;
// - what the theme suite's code reaches changed (extension/ui/, app/shared/host/, the harness and helpers in
//   tests/theme/, the fixtures, or any module those import): the theme-agnostic browser tests (every
//   tests/theme/*.test.ts but a theme's own) against the reference theme (MARGIN_TEST_THEMES=reference: Arcadia,
//   tests/theme/package.ts themesInScope);
// - a theme test file itself changed: that file, in every theme it has.
// The cheap check of every theme package with no browser (tests/security/packages.test.ts: caps, sanitizer, the
// parts an imported theme needs, the first paint) is in npm test, which every change to the extension reaches.
//
// Usage: git diff --name-only BASE HEAD | node scripts/ci-plan.mts [--everything]
// With GITHUB_OUTPUT set it writes the job's outputs there (and a summary to GITHUB_STEP_SUMMARY); else it prints the
// plan as JSON.
import { existsSync, readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_THEMES } from '../extension/themes/packages.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The workflow itself, the lockfiles, the shared build script and this plan reach everything.
const ALL = /^(\.github\/workflows\/ci\.yml|package(-lock)?\.json|tsconfig\.json|scripts\/build\.ts|scripts\/ci-plan\.mts)$/;
// (Unit tests read some of the app's files too: the Chromium crate's extension id, the host page. The end-to-end tests
// load the built extension and the host page, their site, harness and fixtures, the box patterns' pages, and build the
// connector for the Chromium relay's test.)
const REACH = {
  unit: /^(extension|app|tests|types|scripts)\//,
  e2e: /^(extension|app\/shared\/(host|connector)|types|scripts|tests\/(e2e|fixtures|box))\/|^tests\/fake-app\.ts$/,
  rust: /\.rs$|(^|\/)Cargo\.(toml|lock)$|^rustfmt\.toml$|^scripts\/rust-test\.sh$|^tests\/fixtures\//,
  app: /^(app|tools|extension|tests\/fixtures)\/|\.swift$/,
};
const TEST_FILE = /^[a-z0-9-]+\.test\.ts$/;

const listTests = (root, dir) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter((n) => TEST_FILE.test(n)).sort().map((n) => `${dir}/${n}`) : []);

// Every module the theme suite's code can load: what tests/theme/ imports (the harness is bundled by path, so every
// file there is a start), and all of extension/ui/ (preview.test.ts bundles from it by name), followed through every
// relative import and package.json's own (#engine).
const IMPORT = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.m?[jt]s$/.test(name)) out.push(p);
  }
  return out;
}
// package.json "imports" (`#engine`, `#engine/capabilities`): every engine's target (a bundle picks one).
function resolveImport(from, spec, root) {
  if (spec.startsWith('#')) {
    const to = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).imports?.[spec];
    return to ? (typeof to === 'string' ? [to] : Object.values(to)).map((t) => resolve(root, t)).filter((t) => existsSync(t)) : [];
  }
  if (!spec.startsWith('.')) return [];
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, base.replace(/\.js$/, '.ts'), join(base, 'index.ts')]) if (existsSync(c) && statSync(c).isFile()) return [c];
  return [];
}
export function themeSuiteReach(root = ROOT) {
  const seen = new Set();
  const stack = [...walk(join(root, 'tests/theme')), ...walk(join(root, 'extension/ui'))];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of readFileSync(f, 'utf8').matchAll(IMPORT)) for (const r of resolveImport(f, m[1] ?? m[2] ?? m[3], root)) if (!seen.has(r)) stack.push(r);
  }
  return new Set([...seen].map((f) => relative(root, f).split('\\').join('/')));
}

export type Plan = {
  unit: boolean, e2e: boolean, rust: boolean, app: boolean, browsers_any: boolean,
  themes: { files: string[], scope: string, shards: number, why: string },
  browsers: { include: { suite: string, kind: 'theme' | 'e2e', files: string, themes: string, shard: string }[] },
};

export function plan(files: string[], { everything = false, root = ROOT } = {}): Plan {
  const all = everything || files.some((f) => ALL.test(f));
  const reaches = (re) => all || files.some((f) => re.test(f));
  const unit = reaches(REACH.unit);
  const e2e = reaches(REACH.e2e);
  const rust = reaches(REACH.rust);
  const app = reaches(REACH.app);

  const themeTests = listTests(root, 'tests/theme');
  const own = new Map(PACKAGE_THEMES.map((id) => [id, `tests/theme/${id}.test.ts`]).filter(([, f]) => themeTests.includes(f)));
  const owns = new Set(own.values());
  const looped = themeTests.filter((f) => readFileSync(join(root, f), 'utf8').includes('themesInScope('));
  const agnostic = themeTests.filter((f) => !owns.has(f));

  let themes: Plan['themes'];
  if (all) themes = { files: themeTests, scope: '', shards: 2, why: everything ? 'everything runs' : 'the workflow, a lockfile, the build or the plan changed' };
  else {
    const inTheme = (f) => PACKAGE_THEMES.some((id) => f.startsWith(`extension/themes/${id}/`));
    const changedThemes = PACKAGE_THEMES.filter((id) => files.some((f) => f.startsWith(`extension/themes/${id}/`)));
    const changedTests = files.filter((f) => themeTests.includes(f));
    const reach = themeSuiteReach(root);
    const runtime = files.filter((f) => !inTheme(f) && !themeTests.includes(f) && (reach.has(f)
      || /^(extension\/ui|app\/shared\/host|tests\/fixtures|tests\/theme)\//.test(f)
      || /^extension\/themes\/[^/]+$/.test(f)
      || /\/OverlayWebView\.swift$/.test(f)));
    const picked = new Set<string>();
    if (runtime.length) for (const f of agnostic) picked.add(f);
    for (const id of changedThemes) { if (own.has(id)) picked.add(own.get(id)); for (const f of looped) picked.add(f); }
    for (const f of changedTests) picked.add(f);
    // A looped test changed itself: in every theme. Else the reference theme (if the runtime changed) and the themes changed.
    const scope = changedTests.some((f) => looped.includes(f)) ? '' : [runtime.length ? 'reference' : null, ...changedThemes].filter(Boolean).join(',');
    const why = [
      runtime.length ? `the theme suite's code changed (${runtime.slice(0, 3).join(', ')}${runtime.length > 3 ? ', …' : ''}): the theme-agnostic tests` : null,
      changedThemes.length ? `theme folders changed (${changedThemes.join(', ')}): their own tests` : null,
      changedTests.length ? `theme tests changed (${changedTests.join(', ')})` : null,
    ].filter(Boolean).join('; ') || 'nothing the theme tests load changed';
    const list = themeTests.filter((f) => picked.has(f));
    themes = { files: list, scope, shards: list.length ? (scope === '' && list.length > 4 ? 2 : 1) : 0, why };
  }

  const include: Plan['browsers']['include'] = [];
  for (let k = 1; k <= themes.shards; k++) {
    const label = themes.shards > 1 ? `theme ${k} of ${themes.shards}` : 'theme';
    include.push({ suite: themes.scope ? `${label}, ${themes.scope}` : label, kind: 'theme', files: themes.files.join(' '), themes: themes.scope, shard: `${k}/${themes.shards}` });
  }
  if (e2e) {
    const list = listTests(root, 'tests/e2e');
    for (let k = 1; k <= 2; k++) include.push({ suite: `end to end ${k} of 2`, kind: 'e2e', files: list.join(' '), themes: '', shard: `${k}/2` });
  }
  return { unit, e2e, rust, app, browsers_any: include.length > 0, themes, browsers: { include } };
}

function summary(p: Plan, files: string[], macos: string, everything: boolean) {
  const out = ['| Checks | Run |', '|---|---|',
    `| unit tests (with every theme package's checks) | ${p.unit} |`,
    `| theme browser tests (macOS: ${macos}) | ${p.themes.files.length ? `${p.themes.files.length} files, ${p.themes.scope ? `MARGIN_TEST_THEMES=${p.themes.scope}` : 'every theme'}, ${p.themes.shards} Mac${p.themes.shards > 1 ? 's' : ''}` : 'false'} |`,
    `| end-to-end tests (macOS: ${macos}) | ${p.e2e} |`,
    `| Rust | ${p.rust} |`, `| Margin.app (macOS: ${macos}) | ${p.app} |`,
    '', `Theme tests: ${p.themes.why}.`, ''];
  if (p.themes.files.length) out.push(`<details><summary>theme test files</summary>`, '', '```', ...p.themes.files, '```', '</details>', '');
  if (everything) out.push('Everything runs (a nightly run, by hand, or no base to compare with).');
  else out.push(`<details><summary>${files.length} changed files</summary>`, '', '```', ...files.slice(0, 200), '```', '</details>');
  return out.join('\n') + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const everything = process.argv.includes('--everything');
  const files = everything ? [] : readFileSync(0, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const p = plan(files, { everything });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, ['unit', 'rust', 'app', 'browsers_any'].map((k) => `${k}=${p[k]}\n`).join('') + `browsers=${JSON.stringify(p.browsers)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(p, files, process.env.MACOS ?? '', everything));
  } else console.log(JSON.stringify(p, null, 2));
}
