#!/usr/bin/env node
// npm run test:quick: the fast tier, for while you work. It runs only the tests a change can
// reach, usually in well under a minute. The full gate (npm run gate) runs once, before main.
//
// What changed: this branch's commits since it left main (git merge-base), plus whatever is
// staged, unstaged or untracked. Then:
// - always: the build (dist/, 0.6 s) and the type checks (tsc, 1 s each: the code, and the shared test
//   fakes and harnesses, tsconfig.tests.json);
// - JS tests (tests/*.test.ts, tests/security/, tests/theme/): those whose imports reach a
//   changed file, followed through every relative import; tests that name a changed non-JS
//   file (a theme's HTML or CSS, the new-tab page); every theme test when a theme changed;
//   and any changed test file itself (theme tests two at a time: three and four made the drag tests flaky);
// - Swift (app/platforms/macos/, each engine's app side in app/engines/, app/shared/connector/, tools/app-tests): the app's unit checks (compiled on every
//   core; the randomized runs cut to 50 and 80 from 300 and 1000; the gate runs them all);
// - Rust (*.rs, Cargo.toml, Cargo.lock, rustfmt.toml): npm run test:rust, all of it (format, clippy, tests, the Windows check);
// - e2e test files that changed, run on their own (source changes leave e2e to the gate);
// - what the quick tier never runs is listed at the end (WebKit host, the app's e2e, the e2e
//   suite), so you know what the gate still has to say.
//
// Options: --base REF (compare with REF instead of main), --files a b … (these files instead of
// git's), --all (every quick test), --dry (print the plan, run nothing).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const started = Date.now();
const rel = (p) => relative(ROOT, p).split('\\').join('/');
const git = (...a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

// ---- what changed ----------------------------------------------------------------------------
function changedFiles() {
  const listed = option('--files') !== null ? args.slice(args.indexOf('--files') + 1).filter((a) => !a.startsWith('--')) : null;
  if (listed) return listed;
  const baseRef = option('--base') ?? 'main';
  const base = git('merge-base', 'HEAD', baseRef) || git('rev-parse', 'HEAD');
  return [...new Set([
    ...lines(git('diff', '--name-only', base, 'HEAD')),
    ...lines(git('diff', '--name-only', '--cached')),
    ...lines(git('diff', '--name-only')),
    ...lines(git('ls-files', '--others', '--exclude-standard')),
  ])];
}

// ---- the JS import graph ----------------------------------------------------------------------
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'xcode', 'site']);
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(m?[jt]s)$/.test(name)) out.push(p);
  }
  return out;
}
const IMPORT = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
// package.json "imports" (`#engine`, `#engine/capabilities`): as Node resolves them unbuilt, to their `default`,
// which reaches every engine's modules.
const IMPORTS = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).imports ?? {};
function resolveImport(from, spec) {
  if (spec.startsWith('#')) { const to = IMPORTS[spec]; const target = typeof to === 'string' ? to : to?.default; return target ? resolve(ROOT, target) : null; }
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.mts`, `${base}.js`, `${base}.mjs`, join(base, 'index.ts')]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}
const graph = new Map(); // file → files it imports
const texts = new Map();
for (const f of [...walk(join(ROOT, 'extension')), ...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'tests')), ...walk(join(ROOT, 'scripts'))]) {
  const text = readFileSync(f, 'utf8');
  texts.set(f, text);
  const deps = new Set();
  for (const m of text.matchAll(IMPORT)) { const r = resolveImport(f, m[1] ?? m[2] ?? m[3]); if (r) deps.add(r); }
  graph.set(f, deps);
}
const reachCache = new Map();
function reach(file) { // every file `file` imports, directly or not
  if (reachCache.has(file)) return reachCache.get(file);
  const seen = new Set(); const stack = [file];
  while (stack.length) { const f = stack.pop(); for (const d of graph.get(f) ?? []) if (!seen.has(d)) { seen.add(d); stack.push(d); } }
  reachCache.set(file, seen);
  return seen;
}

// ---- the plan -----------------------------------------------------------------------------------
const UNIT = readdirSync(join(ROOT, 'tests')).filter((n) => n.endsWith('.test.ts')).map((n) => join(ROOT, 'tests', n));
// Tests next to what they test: each engine's and browser's own (extension/engines/**/tests/*.test.ts), run with the unit tests.
UNIT.push(...walk(join(ROOT, 'extension/engines')).filter((f) => /\/tests\/[^/]+\.test\.ts$/.test(f)));
const SECURITY = existsSync(join(ROOT, 'tests/security')) ? readdirSync(join(ROOT, 'tests/security')).filter((n) => n.endsWith('.test.ts')).map((n) => join(ROOT, 'tests/security', n)) : [];
const THEME = readdirSync(join(ROOT, 'tests/theme')).filter((n) => n.endsWith('.test.ts')).map((n) => join(ROOT, 'tests/theme', n));
const E2E = readdirSync(join(ROOT, 'tests/e2e')).filter((n) => n.endsWith('.test.ts')).map((n) => join(ROOT, 'tests/e2e', n));

const all = flag('--all');
const changed = all ? [] : changedFiles();
const abs = changed.map((f) => resolve(ROOT, f));
const why = new Map(); // test → the first reason it was picked
const pick = (t, reason) => { if (!why.has(t)) why.set(t, reason); };

const changedJs = abs.filter((f) => /\.m?[jt]s$/.test(f) && !f.includes('/tests/e2e/'));
// Non-JS files the JS side loads: a theme's HTML and CSS, the new-tab page, manifests, fixtures
// (never Swift or docs, which comments mention without testing them).
const changedOther = abs.filter((f) => !/\.m?[jt]s$/.test(f) && /^(extension|app\/shared\/host|tests\/fixtures)\//.test(rel(f)) && !/\.(swift|md)$/.test(f));
for (const t of [...UNIT, ...SECURITY, ...THEME]) {
  if (all) { pick(t, 'all'); continue; }
  if (abs.includes(t)) { pick(t, 'changed'); continue; }
  const r = reach(t);
  const hit = changedJs.find((f) => r.has(f));
  if (hit) { pick(t, `imports ${rel(hit)}`); continue; }
  // A non-JS file a test (or what it imports) names: a theme's HTML/CSS, the new-tab page, a fixture.
  // (Named by the test or its helpers in tests/: source modules naming a page's path don't test it.)
  const names = [t, ...r].filter((f) => rel(f).startsWith('tests/')).map((f) => texts.get(f) ?? '').join('\n');
  const named = changedOther.find((f) => { const r2 = rel(f); const tail = r2.split('/').slice(-2).join('/'); return tail.includes('/') && names.includes(tail); });
  if (named) pick(t, `names ${rel(named)}`);
}
// A theme changed (any of its files): every theme and security test, and the unit tests about themes.
const themeChanged = changed.some((f) => f.startsWith('extension/themes/') || f.startsWith('extension/ui/'));
if (themeChanged) for (const t of [...THEME, ...SECURITY, ...UNIT.filter((u) => /theme/.test(basename(u)))]) pick(t, 'a theme or the UI runtime changed');
// The build's inputs: the build and manifest tests.
if (changed.some((f) => /^(extension|app\/shared\/host)\/|^scripts\/build\.ts$|^package\.json$/.test(f))) {
  for (const n of ['build.test.ts', 'manifest.test.ts']) { const t = join(ROOT, 'tests', n); if (existsSync(t)) pick(t, 'the build\'s inputs changed'); }
}
// (The app's Swift: app/platforms/macos/, each engine's app side (app/engines/), the connector, and the Swift tests.)
const swift = all || changed.some((f) => /^(app\/platforms\/macos|app\/engines|app\/shared\/connector|tools\/app-tests)\//.test(f));
// (The Rust workspace: any crate's source or the workspace's own files.)
const rust = all || changed.some((f) => /\.rs$|(^|\/)Cargo\.(toml|lock)$|^rustfmt\.toml$/.test(f));
const e2eFiles = all ? [] : E2E.filter((t) => abs.includes(t));
const notRun = [];
if (changed.some((f) => /^(extension|app\/shared\/host|tests\/e2e)\//.test(f)) && !e2eFiles.length) notRun.push('the e2e suite (npm run test:e2e)');
if (changed.some((f) => /^(extension|tools\/webkit-host)\//.test(f))) notRun.push('the WebKit host (npm run test:webkit)');
if (swift) notRun.push('the app\'s e2e checks (tools/app-tests/run.sh e2e)');

const sel = (list) => list.filter((t) => why.has(t));
const plan = { unit: sel([...UNIT, ...SECURITY]), theme: sel(THEME), e2e: e2eFiles, swift, rust };

console.log(`quick tests: ${all ? 'everything quick' : `${changed.length} changed file(s)`}${option('--base') ? ` since ${option('--base')}` : ''}`);
for (const [t, reason] of [...why].sort()) console.log(`  ${rel(t)}  (${reason})`);
if (swift) console.log('  Swift unit checks (the app\'s Swift or its tests changed)');
if (rust) console.log('  Rust checks (a crate or the workspace changed)');
for (const t of plan.e2e) console.log(`  ${rel(t)}  (changed)`);
if (!why.size && !swift && !rust && !plan.e2e.length) console.log('  no tests reach these changes: the build and the type check only');
if (flag('--dry')) process.exit(0);

// ---- run -------------------------------------------------------------------------------------------
const results = [];
function step(label, cmd, cmdArgs, env = {}) {
  const t0 = Date.now();
  process.stdout.write(`\n== ${label}\n`);
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  const ok = r.status === 0;
  results.push({ label, ok, s: ((Date.now() - t0) / 1000).toFixed(1) });
  return ok;
}
const node = process.execPath;
const quiet = ['--test-reporter=dot'];
let ok = step('build', node, [join(ROOT, 'scripts/build.ts')]);
ok = step('type check', node, [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', '.']) && ok;
ok = step('type check (test fakes and harnesses)', node, [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.tests.json']) && ok;
if (plan.unit.length) ok = step(`unit (${plan.unit.length} files)`, node, ['--test', ...quiet, ...plan.unit.map(rel)]) && ok;
if (plan.theme.length) ok = step(`theme (${plan.theme.length} files)`, node, ['--test', ...quiet, '--test-concurrency=2', ...plan.theme.map(rel)]) && ok;
if (plan.swift) ok = step('Swift unit checks', join(ROOT, 'tools/app-tests/run.sh'), ['unit'], { WINDOW_RUNS: process.env.WINDOW_RUNS ?? '50', VISIBLE_RUNS: process.env.VISIBLE_RUNS ?? '80' }) && ok;
if (plan.rust) ok = step('Rust checks', join(ROOT, 'scripts/rust-test.sh'), []) && ok;
if (plan.e2e.length) ok = step(`e2e (${plan.e2e.length} changed files)`, node, ['--test', ...quiet, '--test-concurrency=2', ...plan.e2e.map(rel)]) && ok;

console.log('\n== quick tests: ' + (ok ? 'passed' : 'FAILED') + ` in ${((Date.now() - started) / 1000).toFixed(1)} s`);
for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.label} (${r.s} s)`);
if (notRun.length) console.log(`  not run here (npm run gate runs them before main): ${notRun.join('; ')}`);
process.exit(ok ? 0 : 1);
