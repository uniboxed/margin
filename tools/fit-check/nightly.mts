// The fit check, a night at a time: `npm run fit-check` before bed, and it goes on from where the last night
// stopped. It goes through the whole list (a round), then starts the next round, so every site gets a
// history (sites/<domain>.json) and a site that gets worse with a change of Margin's shows.
//
//   npm run fit-check                          start (in the background; the terminal can be closed)
//   npm run fit-check -- --status              how far it is, and whether it's running
//   npm run fit-check -- --stop                stop it (the sites under way finish first)
//   npm run fit-check -- --store               make sites/, all-sites.csv and summary.md again
//   npm run fit-check -- --publish             commit the data to the data/fit-check branch and push it
//
// Options for a start: --until 07:30 (no new site after it, local time; the default), --hours N (instead),
// --workers 3, --code main (Margin's code tested: a branch, a commit, or `here` for this checkout as it is),
// --wait (stay in the foreground). --data DIR (default tools/fit-check/data) for all of the above.
// --import DIR [--import-commit SHA]: an earlier crawl's --out folder taken in as round 1 (results, pictures).
// --no-publish: don't commit and push the data at the end.
//
// Published: at the end of each night the data is committed to the branch data/fit-check (the data alone,
// at tools/fit-check/data, with no code; through a checkout of its own, ~/Library/Caches/margin-fit-check/
// publish, so this checkout and its branch aren't touched) and pushed, for anyone with the repo to see. In it:
// everything but the pictures, and of those only each flagged or margin-failed site's latest. Here, a
// round's pictures are kept until the round after next begins.
//
// The data folder (not in git: pictures and a night's churn):
//   list.csv               the sites, `rank,domain` (Tranco's top 10 000, downloaded the first time)
//   rounds/NNNN/           a round: results.jsonl (a line per site, as it's done), progress.json, log.txt,
//                          shots/, finished.txt once every site is done, summary.md (summarize.mts)
//   sites/<domain>.json    a site: its latest in full, and every round's verdict
//   all-sites.csv          a row per site, its latest
//   summary.md, .json      the latest of every site; worse and better since the round before
//   nightly.log            what each night did; running.json while it runs
//
// Margin's code is a checkout of its own (~/Library/Caches/margin-fit-check/code), set to --code's commit
// at each start and built there, so the night tests one commit whatever this checkout is doing. The crawl
// tool itself comes from this checkout (copied in). Each row says which commit it tested.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { DEFAULT_DATA, readRound, rebuild, roundName, roundsOf, writeAtomic } from './store.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const argv = process.argv.slice(2);
const has = (name: string) => argv.includes(`--${name}`);
const opt = <T extends string | null>(name: string, fallback: T): string | T => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
const expand = (p: string) => resolve(p.replace(/^~(?=\/|$)/, homedir()));
const DATA = expand(opt('data', DEFAULT_DATA));
const CODE = join(homedir(), 'Library/Caches/margin-fit-check/code');
const PUBLISH = expand(opt('publish-dir', join(homedir(), 'Library/Caches/margin-fit-check/publish')));
const REMOTE = opt('remote', 'origin'); // (--remote, --branch, --publish-dir: for trying it out)
const DATA_BRANCH = opt('branch', 'data/fit-check');
const LIST_URL = 'https://tranco-list.eu/top-1m.csv.zip';
const LIST_SIZE = 10_000;
const RUNNING = join(DATA, 'running.json');
const NIGHTLY_LOG = join(DATA, 'nightly.log');
mkdirSync(DATA, { recursive: true });

const now = () => new Date().toISOString();
const say = (line: string) => { const s = `${now()} ${line}`; appendFileSync(NIGHTLY_LOG, `${s}\n`); if (!has('child')) console.log(s); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
// (Its own files, read back: what's in them is checked where it's read.)
const readJson = (file: string): Record<string, any> | null => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const running = () => { const r = readJson(RUNNING); return r && alive(r.pid) ? r : null; };
const git = (...args: string[]) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The round to work on: the last one, unless it's finished (then the next).
function currentRound() {
  const rounds = roundsOf(DATA);
  const last = rounds.at(-1);
  if (last == null) return 1;
  return existsSync(join(DATA, 'rounds', roundName(last), 'finished.txt')) ? last + 1 : last;
}

// ---- publishing: the data on its own branch, committed and pushed -------------------------------
const gitIn = (dir: string, args: string[], env: Record<string, string> = {}) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, timeout: 300_000 }).trim();
const BRANCH_README = `# Margin's fit check

Every night the top 10 000 sites (Tranco's list) are loaded through Margin's page box (the extension's own code, shrinking each page into the space beside the sidebar) and loaded plain, and the two are compared. This branch holds the results only; the tool is \`tools/fit-check/\` on main.

- [summary.md](tools/fit-check/data/summary.md): every site at its latest, and what got worse or better since the round before.
- [all-sites.csv](tools/fit-check/data/all-sites.csv): a row per site.
- \`tools/fit-check/data/sites/<domain>.json\`: one site, every round.
- \`tools/fit-check/data/rounds/NNNN/\`: each round as it was crawled (pictures: only each flagged or failed site's latest).
`;
function publish(pictures: string[]) {
  // The branch's checkout: made the first time (from GitHub's branch if there is one, else a new branch with no history).
  if (!existsSync(join(PUBLISH, '.git'))) {
    mkdirSync(dirname(PUBLISH), { recursive: true });
    rmSync(PUBLISH, { recursive: true, force: true });
    git('worktree', 'prune');
    const local = (() => { try { git('rev-parse', '--verify', `refs/heads/${DATA_BRANCH}`); return true; } catch { return false; } })();
    const remote = !local && (() => { try { return gitIn(ROOT, ['ls-remote', '--heads', REMOTE, DATA_BRANCH]).length > 0; } catch { return false; } })();
    if (local) git('worktree', 'add', PUBLISH, DATA_BRANCH);
    else if (remote) { gitIn(ROOT, ['fetch', REMOTE, `${DATA_BRANCH}:${DATA_BRANCH}`]); git('worktree', 'add', PUBLISH, DATA_BRANCH); }
    else {
      git('worktree', 'add', '--detach', PUBLISH);
      gitIn(PUBLISH, ['checkout', '-q', '--orphan', DATA_BRANCH]);
      gitIn(PUBLISH, ['rm', '-rf', '-q', '--cached', '.']);
      for (const f of readdirSync(PUBLISH)) if (f !== '.git') rmSync(join(PUBLISH, f), { recursive: true, force: true });
    }
  }
  // The data, but for what's only this Mac's (who's running, downloads, the crawl's raw output) and the pictures.
  const target = join(PUBLISH, 'tools/fit-check/data');
  mkdirSync(target, { recursive: true });
  execFileSync('rsync', ['-a', '--delete', '--delete-excluded', '--exclude', 'running.json', '--exclude', 'list-download', '--exclude', '*.tmp', '--exclude', 'run.out', '--exclude', 'shots/', `${DATA}/`, `${target}/`]);
  for (const pic of pictures) {
    mkdirSync(dirname(join(target, pic)), { recursive: true });
    if (existsSync(join(DATA, pic))) copyFileSync(join(DATA, pic), join(target, pic));
  }
  writeFileSync(join(PUBLISH, 'README.md'), BRANCH_README);
  gitIn(PUBLISH, ['add', '-A', '-f', 'README.md', 'tools/fit-check/data']);
  const staged = gitIn(PUBLISH, ['diff', '--cached', '--name-only']).length > 0;
  if (staged) {
    const s = readJson(join(DATA, 'summary.json'));
    const p = s?.roundProgress;
    const what = s ? `round ${s.round}, ${s.roundFinished ? 'finished' : `${p?.done ?? '?'} of ${p?.total ?? '?'} sites`}` : 'results';
    gitIn(PUBLISH, ['-c', 'user.name=Tirth Patel', '-c', 'user.email=github@tirth.io', 'commit', '-q', '-m', `chore(fit-check): fit check ${what} (${now().slice(0, 10)})`]);
  }
  try {
    gitIn(PUBLISH, ['push', '-q', '-u', REMOTE, DATA_BRANCH]);
    return staged ? 'committed and pushed' : 'nothing new; pushed';
  } catch (e) {
    return `committed, not pushed (${String((e as Error).message).split('\n')[0].slice(0, 160)}); the next night pushes it`;
  }
}

// A round's pictures, here, are kept until the round after next begins (the round before stays, to compare).
function pruneShots(round: number) {
  for (const r of roundsOf(DATA)) if (r < round - 1) rmSync(join(DATA, 'rounds', roundName(r), 'shots'), { recursive: true, force: true });
}

// ---- --status, --stop, --store, --publish -------------------------------------------------------
if (has('status')) {
  const r = running();
  const round = currentRound();
  const last = roundsOf(DATA).at(-1);
  const p = last != null ? readJson(join(DATA, 'rounds', roundName(last), 'progress.json')) : null;
  console.log(r ? `Running since ${r.startedAt} (pid ${r.pid}), round ${r.round}, until ${r.until}, Margin ${r.commit}.` : 'Not running.');
  if (last != null) {
    // Counted from the round's results (progress.json only for the rate).
    const rows = [...readRound(DATA, last).values()];
    const total = existsSync(join(DATA, 'list.csv')) ? readFileSync(join(DATA, 'list.csv'), 'utf8').split('\n').filter((l) => /^\d+,[a-z0-9.-]+$/i.test(l.trim()) && Number(l.split(',')[0]) > 0).length : p?.total;
    const by = rows.reduce<Record<string, number>>((acc, row) => { acc[row.verdict] = (acc[row.verdict] ?? 0) + 1; return acc; }, {});
    const parts = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(', ');
    console.log(`Round ${last}: ${rows.length} of ${total} done (${parts})${r && p ? `; ${p.perMinute}/min, about ${p.etaHours} h of crawling left` : ''}.`);
  }
  if (last != null && round !== last) console.log(`Round ${last} is finished; the next start begins round ${round}.`);
  console.log(`Data: ${DATA} (summary.md, all-sites.csv, sites/<domain>.json).`);
  process.exit(0);
}
if (has('stop')) {
  const r = running();
  if (!r) { console.log('Not running.'); process.exit(0); }
  process.kill(r.pid, 'SIGTERM');
  console.log(`Asked it to stop (pid ${r.pid}): the sites under way finish, then the data is stored.`);
  process.exit(0);
}
if (has('publish')) {
  if (running()) { console.log('It is running: it publishes when it ends (or --stop it first).'); process.exit(1); }
  const s = rebuild(DATA);
  console.log(`${s.sites} sites: ${publish(s.pictures)} (${DATA_BRANCH}).`);
  process.exit(0);
}
if (has('store')) {
  const s = rebuild(DATA);
  console.log(`${s.sites} sites; ${JSON.stringify(s.verdicts)}. ${join(DATA, 'summary.md')}`);
  process.exit(0);
}

// ---- --import: an earlier crawl's folder as round 1 ---------------------------------------------
if (has('import')) {
  if (running()) { console.log('It is running: stop it first (--stop).'); process.exit(1); }
  const from = expand(opt('import', ''));
  const commit = opt('import-commit', null);
  if (!existsSync(join(from, 'results.jsonl'))) { console.log(`No results.jsonl in ${from}.`); process.exit(1); }
  const dir = join(DATA, 'rounds', roundName(1));
  mkdirSync(join(dir, 'shots'), { recursive: true });
  const target = join(dir, 'results.jsonl');
  const have = new Set(existsSync(target) ? readFileSync(target, 'utf8').split('\n').filter(Boolean) : []);
  let added = 0;
  for (const line of readFileSync(join(from, 'results.jsonl'), 'utf8').split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (commit && !r.commit) r.commit = commit;
    const text = JSON.stringify(r);
    if (have.has(text) || have.has(line)) continue;
    appendFileSync(target, `${text}\n`);
    have.add(text);
    added += 1;
  }
  if (existsSync(join(from, 'shots'))) for (const f of readdirSync(join(from, 'shots'))) if (!existsSync(join(dir, 'shots', f))) copyFileSync(join(from, 'shots', f), join(dir, 'shots', f));
  // (Not its finished.txt: an earlier crawl wrote one whenever it stopped. The crawl writes it once every site is done.)
  for (const f of ['log.txt', 'progress.json']) if (existsSync(join(from, f)) && !existsSync(join(dir, f))) copyFileSync(join(from, f), join(dir, f));
  const list = opt('list', null);
  if (list && !existsSync(join(DATA, 'list.csv'))) copyFileSync(expand(list), join(DATA, 'list.csv'));
  const s = rebuild(DATA);
  console.log(`Took in ${added} rows from ${from} as round 1. ${s.sites} sites; ${JSON.stringify(s.verdicts)}.`);
  process.exit(0);
}

// ---- a start ----------------------------------------------------------------------------------
const already = running();
if (already) { console.log(`Already running (pid ${already.pid}, since ${already.startedAt}). --status to see it, --stop to stop it.`); process.exit(1); }

// When to stop starting sites: --hours from now, or the next --until (local time).
function untilTime() {
  if (opt('at', null)) return new Date(opt('at', '')); // (worked out once, by the start in the foreground)
  const hours = Number(opt('hours', '0'));
  if (hours > 0) return new Date(Date.now() + hours * 3_600_000);
  const [h, m] = opt('until', '07:30').split(':').map(Number);
  if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) throw new Error(`--until: HH:MM, not ${opt('until', '')}`);
  const t = new Date();
  t.setHours(h, m, 0, 0);
  if (t.getTime() <= Date.now() + 60_000) t.setDate(t.getDate() + 1);
  return t;
}
const UNTIL = untilTime();

// In the background unless --wait: the same command again, detached, its output in nightly.log.
if (!has('wait') && !has('child')) {
  const out = openSync(NIGHTLY_LOG, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv, '--child', '--at', UNTIL.toISOString()], { cwd: ROOT, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  console.log(`The fit check started in the background (pid ${child.pid}), until ${UNTIL.toLocaleString()}.`);
  console.log(`  npm run fit-check -- --status    how far it is`);
  console.log(`  npm run fit-check -- --stop      stop it`);
  console.log(`Data: ${DATA}`);
  process.exit(0);
}

let crawl: ChildProcess | null = null;
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stopping = true; say(`${sig}: stopping`); if (crawl) crawl.kill('SIGTERM'); });
const done = () => { try { if (readJson(RUNNING)?.pid === process.pid) unlinkSync(RUNNING); } catch {} };
process.on('exit', done);

// The sites: Tranco's top 10 000, downloaded once (the list stays the same from round to round, so the
// rounds compare).
function ensureList() {
  const file = join(DATA, 'list.csv');
  if (existsSync(file)) return file;
  say(`downloading the sites list (${LIST_URL})`);
  const tmp = join(DATA, 'list-download');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  execFileSync('curl', ['-sSfL', '--max-time', '300', '-o', join(tmp, 'top-1m.csv.zip'), LIST_URL]);
  const all = execFileSync('unzip', ['-p', join(tmp, 'top-1m.csv.zip')], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' });
  const lines = all.split('\n').filter((l) => /^\d+,[a-z0-9.-]+\s*$/i.test(l)).slice(0, LIST_SIZE);
  if (lines.length < 1000) throw new Error(`the list came back with ${lines.length} sites`);
  writeAtomic(file, `${lines.join('\n')}\n`);
  rmSync(tmp, { recursive: true, force: true });
  return file;
}

// Margin's code at --code, in a checkout of its own, built; or this checkout as it is (`here`).
function prepareCode() {
  const ref = opt('code', 'main');
  if (ref === 'here') {
    const dirty = git('status', '--porcelain').length > 0;
    execFileSync(process.execPath, [join(ROOT, 'scripts/build.ts')], { cwd: ROOT, stdio: 'ignore' });
    return { dir: ROOT, commit: `${git('rev-parse', '--short', 'HEAD')}${dirty ? '+changes' : ''}` };
  }
  const sha = git('rev-parse', '--verify', `${ref}^{commit}`);
  if (!existsSync(join(CODE, '.git'))) {
    mkdirSync(dirname(CODE), { recursive: true });
    rmSync(CODE, { recursive: true, force: true });
    git('worktree', 'prune');
    git('worktree', 'add', '--detach', CODE, sha);
  } else {
    execFileSync('git', ['-C', CODE, 'checkout', '-q', '--detach', '--force', sha]);
    execFileSync('git', ['-C', CODE, 'clean', '-q', '-fd', 'tools/fit-check']);
  }
  if (!existsSync(join(CODE, 'node_modules'))) symlinkSync(join(ROOT, 'node_modules'), join(CODE, 'node_modules'));
  // The crawl tool from this checkout (a fix to the tool needn't wait for main).
  mkdirSync(join(CODE, 'tools/fit-check'), { recursive: true });
  for (const f of readdirSync(HERE)) if (f.endsWith('.mts') || f === 'README.md') cpSync(join(HERE, f), join(CODE, 'tools/fit-check', f));
  execFileSync(process.execPath, [join(CODE, 'scripts/build.ts')], { cwd: CODE, stdio: 'ignore' });
  return { dir: CODE, commit: sha.slice(0, 7) };
}

function runRound(round: number, code: { dir: string, commit: string }, list: string) {
  const out = join(DATA, 'rounds', roundName(round));
  mkdirSync(out, { recursive: true });
  const log = openSync(join(out, 'run.out'), 'a');
  const args = [join(code.dir, 'tools/fit-check/check.mts'), '--list', list, '--out', out, '--workers', opt('workers', '3'), '--until', UNTIL.toISOString(), '--commit', code.commit];
  return new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((done) => {
    crawl = spawn(process.execPath, args, { cwd: code.dir, stdio: ['ignore', log, log] });
    crawl.on('exit', (codeOut, signal) => { crawl = null; done({ code: codeOut, signal }); });
  });
}

try {
  let round = currentRound();
  writeAtomic(RUNNING, JSON.stringify({ pid: process.pid, startedAt: now(), round, until: UNTIL.toISOString(), commit: 'preparing', data: DATA }, null, 2));
  const list = ensureList();
  const code = prepareCode();
  writeAtomic(RUNNING, JSON.stringify({ ...readJson(RUNNING), commit: code.commit }, null, 2));
  say(`start: round ${round}, Margin ${code.commit} (${opt('code', 'main')}), until ${UNTIL.toISOString()}, ${opt('workers', '3')} workers`);
  while (!stopping && Date.now() < UNTIL.getTime()) {
    const before = readRound(DATA, round).size;
    const t0 = Date.now();
    const end = await runRound(round, code, list);
    const after = readRound(DATA, round).size;
    const finished = existsSync(join(DATA, 'rounds', roundName(round), 'finished.txt'));
    say(`round ${round}: ${after - before} more sites this run (${after} in all)${finished ? ', finished' : ''}; the crawl ended (${end.signal ?? `exit ${end.code}`})`);
    rebuild(DATA);
    try { execFileSync(process.execPath, [join(HERE, 'summarize.mts'), '--out', join(DATA, 'rounds', roundName(round))], { stdio: 'ignore' }); } catch {}
    if (!finished) {
      // Not finished and not out of time: it ended by itself. Once more after a pause, unless it got nowhere.
      if (stopping || Date.now() >= UNTIL.getTime() || (after === before && Date.now() - t0 < 10 * 60_000)) break;
      await new Promise((r) => setTimeout(r, 60_000));
      continue;
    }
    round += 1;
    writeAtomic(RUNNING, JSON.stringify({ ...readJson(RUNNING), round }, null, 2));
  }
  pruneShots(round);
  const s = rebuild(DATA);
  if (!has('no-publish')) { try { say(`published: ${publish(s.pictures)} (${DATA_BRANCH})`); } catch (e) { say(`not published: ${String((e as Error | null)?.message ?? e).split('\n')[0].slice(0, 200)}`); } }
  say(`end: ${s.sites} sites; ${JSON.stringify(s.verdicts)}; worse since the round before ${s.worse.length}, better ${s.better.length}. ${join(DATA, 'summary.md')}`);
} catch (e) {
  say(`stopped by an error: ${String((e as Error | null)?.stack ?? e).split('\n').slice(0, 3).join(' | ')}`);
  try { rebuild(DATA); } catch {}
  process.exitCode = 1;
}
