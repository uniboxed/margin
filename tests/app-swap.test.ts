// scripts/app-swap.sh, the part of npm run safari that puts a new Margin.app in
// place of the installed one, run against a temporary folder with stand-ins:
// a copy of /bin/sleep (signed ad hoc) named Margin, started from the folder's
// Margin.app, plays the running app. Never the real ~/Applications/Margin.app:
// the processes looked at are only those whose executable is in the folder,
// and the steps that would reach the system (registering, starting the app)
// are the test's own. macOS only (pgrep, ps, codesign).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'app-swap.sh');
const mac = process.platform === 'darwin';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A Margin.app whose executable is a stand-in; `mark` names the build.
function bundle(path, mark) {
  mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true });
  const exe = join(path, 'Contents', 'MacOS', 'Margin');
  copyFileSync('/bin/sleep', exe);
  execFileSync('codesign', ['-f', '-s', '-', exe], { stdio: 'ignore' });
  writeFileSync(join(path, 'build'), mark);
  return exe;
}

// The stand-in running from `exe` (`ignoreTerm`: as an app that doesn't quit on a SIGTERM).
async function run(exe, { ignoreTerm = false } = {}) {
  const child = ignoreTerm
    ? spawn('/bin/sh', ['-c', `trap '' TERM; exec "${exe}" 60`], { stdio: 'ignore' })
    : spawn(exe, ['60'], { stdio: 'ignore' });
  const ended = new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal ?? code)));
  // Running as Margin (after the exec), from that executable.
  for (let i = 0; i < 100; i++) {
    let comm = '';
    try { comm = execFileSync('ps', ['-o', 'comm=', '-p', String(child.pid)], { encoding: 'utf8' }).trim(); } catch {}
    if (comm === exe) break;
    await wait(20);
  }
  return { pid: child.pid, ended };
}

// swap_app NEW DEST with the test's steps; `register` is the register_app step's body.
function swap(dir, { register = ':', safari = true, quitWait = 5, startWait = 1 } = {}) {
  const sh = `
    set -eu
    . "${SCRIPT}"
    register_app() { ${register}; }
    safari_running() { ${safari ? 'true' : 'false'}; }
    open_app() { echo "open_app $1"; }
    swap_app "$1/Margin.app.new" "$1/Margin.app"
  `;
  const child = spawn('/bin/sh', ['-c', sh, 'swap', dir], { env: { ...process.env, MARGIN_QUIT_WAIT: String(quitWait), MARGIN_START_WAIT: String(startWait) } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => child.on('exit', (code) => resolve({ code, out })));
  return { done };
}

function folder() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'margin-swap-')));
  const old = bundle(join(dir, 'Margin.app'), 'old');
  bundle(join(dir, 'Margin.app.new'), 'new');
  return { dir, old, dest: join(dir, 'Margin.app') };
}

test('app swap: the running Margin.app is quit only after the new one is in place, and the old copy deleted only once it has gone', { skip: !mac }, async () => {
  const { dir, old, dest } = folder();
  const elsewhere = bundle(join(dir, 'build', 'Margin.app'), 'build folder');
  const running = await run(old);
  const other = await run(elsewhere);
  try {
    // At register_app: the new build in place, the old one moved aside, the app still running from it.
    const register = `echo "registering: build $(cat "$1/build"), old kept $( [ -d "$1.old" ] && echo yes || echo no ), running $(kill -0 ${running.pid} 2>/dev/null && echo yes || echo no)"`;
    const { code, out } = await swap(dir, { register }).done;
    assert.equal(code, 0, out);
    assert.match(out, /registering: build new, old kept yes, running yes/, 'not quit before the swap and its registration');
    assert.match(out, new RegExp(`quit the running Margin.app \\(pid ${running.pid}\\)`));
    assert.equal(await running.ended, 'SIGTERM', 'a SIGTERM: the app quits as when it is quit');
    assert.ok(!existsSync(`${dest}.old`), 'the old copy deleted');
    assert.equal(execFileSync('cat', [join(dest, 'build')], { encoding: 'utf8' }), 'new');
    assert.match(out, /open_app .*Margin\.app\nstarted the new Margin.app in the background/, 'Safari running, nothing started it: started in the background');
    assert.ok(alive(other.pid), 'a Margin from elsewhere (a build folder) left alone');
  } finally {
    for (const p of [running.pid, other.pid]) try { process.kill(p, 'SIGKILL'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('app swap: one that ignores the SIGTERM is killed after the wait, its copy kept until then', { skip: !mac }, async () => {
  const { dir, old, dest } = folder();
  const running = await run(old, { ignoreTerm: true });
  try {
    const swapping = swap(dir, { quitWait: 1, safari: false });
    const seen = [];
    let finished = false;
    void swapping.done.then(() => { finished = true; });
    while (!finished) {
      // The copy looked at first: gone means the script saw the process gone before.
      // (One read, not a look then a read: the swap may move the folder between the two.)
      let swapped = false;
      try { swapped = readFileSync(join(dest, 'build'), 'utf8') === 'new'; } catch {}
      const kept = existsSync(`${dest}.old`);
      seen.push({ old: kept, swapped, alive: alive(running.pid) });
      await wait(20);
    }
    const { code, out } = await swapping.done;
    assert.equal(code, 0, out);
    assert.ok(seen.some((s) => s.alive && s.old && s.swapped), 'swapped while it ran, its old copy kept');
    assert.ok(!seen.some((s) => s.swapped && !s.old && s.alive), 'its copy never deleted while it ran');
    assert.match(out, /didn't quit in 1 s: killed/);
    assert.equal(await running.ended, 'SIGKILL');
    assert.ok(!existsSync(`${dest}.old`));
    assert.doesNotMatch(out, /open_app/, 'Safari not running: not started');
  } finally {
    try { process.kill(running.pid, 'SIGKILL'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('app swap: one started during the swap (the extension handler, for a link) is the new build, kept running, and not started twice', { skip: !mac }, async () => {
  const { dir, old, dest } = folder();
  const running = await run(old);
  let started = null;
  try {
    // The handler starting Margin.app as the registration settles: from DEST, so the new build.
    const register = `"$1/Contents/MacOS/Margin" 60 >/dev/null 2>&1 & echo "started $!"`;
    const { code, out } = await swap(dir, { register }).done;
    started = Number(/started (\d+)/.exec(out)?.[1]);
    assert.equal(code, 0, out);
    assert.equal(await running.ended, 'SIGTERM', 'the old one quit');
    assert.ok(started && alive(started), 'the new one left running');
    assert.match(out, /the new Margin.app was started for Safari/);
    assert.doesNotMatch(out, /open_app/, 'not opened a second time');
    assert.doesNotMatch(out, new RegExp(`pid ${started}\\)`), 'never told to quit');
  } finally {
    for (const p of [running.pid, started]) if (p) try { process.kill(p, 'SIGKILL'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('app swap: nothing running: nothing quit, nothing started; a first install', { skip: !mac }, async () => {
  const { dir, dest } = folder();
  try {
    const { code, out } = await swap(dir).done;
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /quit|open_app/);
    assert.ok(!existsSync(`${dest}.old`) && existsSync(join(dest, 'build')));
    rmSync(dest, { recursive: true, force: true });
    bundle(join(dir, 'Margin.app.new'), 'new');
    const first = await swap(dir).done;
    assert.equal(first.code, 0, first.out);
    assert.equal(execFileSync('cat', [join(dest, 'build')], { encoding: 'utf8' }), 'new', 'no copy before: put in place');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
