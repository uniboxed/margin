// The stricter type check, folder by folder (DECISIONS.md "Strict types"): `tsconfig.strict.json` checks the whole
// program with the next level on, and this fails only on errors in the files already brought up to it (DONE), so
// those can't slip back while the rest catches up. TypeScript has no per-folder strictness, and a config listing one
// folder still checks every file it imports: hence the whole program, filtered. Once DONE covers everything, the
// level moves into tsconfig.json and the next one starts here. `--all`: every error, wherever it is (to see what's
// left). (strictNullChecks, then noImplicitAny, are in tsconfig.json now; this level: the rest of `strict`.)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// The files and folders (paths from the repo's root; a folder ends in /) brought up to tsconfig.strict.json.
export const DONE: string[] = [];

const all = process.argv.includes('--all');
const run = spawnSync(process.execPath, [`${ROOT}node_modules/typescript/bin/tsc`, '-p', `${ROOT}tsconfig.strict.json`, '--pretty', 'false'], { cwd: ROOT, encoding: 'utf8' });
const errors = `${run.stdout}${run.stderr}`.split('\n').filter((l) => /^\S.*\(\d+,\d+\): error TS\d+/.test(l));
const done = (line: string) => DONE.some((d) => (d.endsWith('/') ? line.startsWith(d) : line.startsWith(`${d}(`)));
const counted = all ? errors : errors.filter(done);
for (const line of counted) console.log(line);
const left = errors.length - errors.filter(done).length;
console.log(`strict check: ${errors.filter(done).length} errors in the ${DONE.length} done (${left} left elsewhere)`);
process.exit(errors.filter(done).length ? 1 : 0);
