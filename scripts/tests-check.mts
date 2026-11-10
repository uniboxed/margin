// The type check of what tsconfig.tests.json doesn't hold yet, folder by folder (GitHub issue #4; as
// scripts/strict-check.mts did for the extension's code, DECISIONS.md "Strict types"): `tsconfig.rest.json` checks the
// theme browser tests and the box benchmarks with what they import, and this fails only on errors in the folders and files
// already brought up to it (DONE), so those can't slip back while the rest catches up. A config listing only the done
// files would still check every file they import (a helper not done yet): hence the whole program, filtered. Once DONE
// covers everything, those join tsconfig.tests.json and this goes. `--all`: every error, wherever it is (to see what's
// left).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// The compiler of the typescript package Node finds from here (its package.json: the bin isn't exported).
const TSC = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin/tsc');
// The files and folders (paths from the repo's root; a folder ends in /) whose type errors fail the check. A folder
// once all of it is done, so a file added there is held at once; a folder all done moves to tsconfig.tests.json
// (scripts/, tools/ and tests/e2e/, 2026-11-10). (What the unit tests import, the theme harness, the e2e harness and site, the box patterns'
// rules and server, is held there already.)
export const DONE: string[] = [
];

const all = process.argv.includes('--all');
const run = spawnSync(process.execPath, [TSC, '-p', `${ROOT}tsconfig.rest.json`, '--pretty', 'false'], { cwd: ROOT, encoding: 'utf8' });
const errors = `${run.stdout}${run.stderr}`.split('\n').filter((l) => /^\S.*\(\d+,\d+\): error TS\d+/.test(l));
if (run.status !== 0 && !errors.length) {
  console.error(`${run.stdout}${run.stderr}`);
  process.exit(1);
}
const done = (line: string) => DONE.some((d) => (d.endsWith('/') ? line.startsWith(d) : line.startsWith(`${d}(`)));
const inDone = errors.filter(done);
for (const line of all ? errors : inDone) console.log(line);
console.log(`the rest's type check: ${inDone.length} errors in the ${DONE.length} done (${errors.length - inDone.length} left elsewhere)`);
process.exit(inDone.length ? 1 : 0);
