// The test files' type check, folder by folder (GitHub issue #4; as scripts/strict-check.mts did for the extension's
// code, DECISIONS.md "Strict types"): `tsconfig.test-files.json` checks every unit test file and what it imports, and
// this fails only on errors in the files already brought up to it (DONE), so those can't slip back while the rest
// catches up. A config listing only the done files would still check every file they import (a script under test, a
// helper not done yet): hence the whole program, filtered. Once DONE covers everything, the test files move into
// tsconfig.tests.json and this goes. `--all`: every error, wherever it is (to see what's left).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// The compiler of the typescript package Node finds from here (its package.json: the bin isn't exported).
const TSC = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin/tsc');
// The files and folders (paths from the repo's root; a folder ends in /) whose type errors fail the check.
export const DONE: string[] = [
  'extension/engines/webkit/safari/tests/onboarding.test.ts',
  'tests/app-feedback.test.ts',
  'tests/app-swap.test.ts',
  'tests/box-patterns.test.ts',
  'tests/box/readme.mts',
  'tests/box/rules.ts',
  'tests/ci-plan.test.ts',
  'tests/data-set.test.ts',
  'tests/handoff-copy.test.ts',
  'tests/handoff-ui.test.ts',
  'tests/icons.test.ts',
  'tests/layout-settle.test.ts',
  'tests/link-chromium.test.ts',
  'tests/link-relink.test.ts',
  'tests/link.test.ts',
  'tests/own-search.test.ts',
  'tests/owner.test.ts',
  'tests/parked-restore.test.ts',
  'tests/security/',
  'tests/sheet-copy.test.ts',
  'tests/signing-check.test.ts',
  'tests/switching-pick.test.ts',
  'tests/themes.test.ts',
];

const all = process.argv.includes('--all');
const run = spawnSync(process.execPath, [TSC, '-p', `${ROOT}tsconfig.test-files.json`, '--pretty', 'false'], { cwd: ROOT, encoding: 'utf8' });
const errors = `${run.stdout}${run.stderr}`.split('\n').filter((l) => /^\S.*\(\d+,\d+\): error TS\d+/.test(l));
if (run.status !== 0 && !errors.length) {
  console.error(`${run.stdout}${run.stderr}`);
  process.exit(1);
}
const done = (line: string) => DONE.some((d) => (d.endsWith('/') ? line.startsWith(d) : line.startsWith(`${d}(`)));
const inDone = errors.filter(done);
for (const line of all ? errors : inDone) console.log(line);
console.log(`test files' type check: ${inDone.length} errors in the ${DONE.length} done (${errors.length - inDone.length} left elsewhere)`);
process.exit(inDone.length ? 1 : 0);
