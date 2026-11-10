// scripts/signing-check.sh, the part of npm run safari that compares the
// installed Margin.app's signing with the build's, run against a temporary
// folder with a stand-in for codesign (a script printing the TeamIdentifier
// line codesign -dv prints). Never the real ~/Applications/Margin.app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'signing-check.sh');

// A folder with a Margin.app whose extension codesign says is signed `team` (null: no Margin.app).
function folder(team: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'margin-signing-'));
  if (team !== null) mkdirSync(join(dir, 'Margin.app', 'Contents', 'PlugIns', 'Margin Extension.appex'), { recursive: true });
  const codesign = join(dir, 'codesign');
  writeFileSync(codesign, `#!/bin/sh\n[ "$1" = -dv ] || exit 2\ncase "$2" in *"Margin Extension.appex") ;; *) exit 1 ;; esac\necho "Executable=$2/Contents/MacOS/x" >&2\n${team ? `echo "TeamIdentifier=${team}" >&2` : 'exit 1'}\n`);
  chmodSync(codesign, 0o755);
  return { dir, codesign };
}

function confirm(dir: string, codesign: string, next: string, { yes = false, input = '' } = {}) {
  const r = spawnSync('/bin/sh', ['-c', `set -eu; . "${SCRIPT}"; confirm_signing "$1/Margin.app" "$2" "$3"`, 'check', dir, next, String(yes)], {
    env: { ...process.env, CODESIGN: codesign }, input, encoding: 'utf8',
  });
  return { code: r.status, err: r.stderr };
}

test('signing check: the same team goes on, saying nothing', () => {
  const { dir, codesign } = folder('VSNN5UW99X');
  const adhoc = folder('not set');
  try {
    assert.deepEqual(confirm(dir, codesign, 'VSNN5UW99X'), { code: 0, err: '' });
    assert.deepEqual(confirm(adhoc.dir, adhoc.codesign, 'not set'), { code: 0, err: '' }, 'unsigned over unsigned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(adhoc.dir, { recursive: true, force: true });
  }
});

test('signing check: unsigned over a signed copy warns and asks; no answer stops', () => {
  const { dir, codesign } = folder('VSNN5UW99X');
  try {
    const { code, err } = confirm(dir, codesign, 'not set');
    assert.equal(code, 1);
    assert.match(err, /signed with team VSNN5UW99X, and this build would be signed unsigned \(ad hoc\)/);
    assert.match(err, /spaces start fresh/);
    assert.match(err, /\[y\/N\]/);
    assert.match(err, /Stopped: nothing was built or installed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('signing check: another team: y goes on, n stops, --yes goes on without asking', () => {
  const { dir, codesign } = folder('VSNN5UW99X');
  try {
    assert.equal(confirm(dir, codesign, 'ABCDE12345', { input: 'y\n' }).code, 0);
    assert.equal(confirm(dir, codesign, 'ABCDE12345', { input: 'n\n' }).code, 1);
    const yes = confirm(dir, codesign, 'ABCDE12345', { yes: true });
    assert.equal(yes.code, 0);
    assert.match(yes.err, /Going on \(--yes\)/);
    assert.doesNotMatch(yes.err, /\[y\/N\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('signing check: a signed build over an unsigned copy warns too', () => {
  const { dir, codesign } = folder('not set');
  try {
    const { code, err } = confirm(dir, codesign, 'VSNN5UW99X');
    assert.equal(code, 1);
    assert.match(err, /signed unsigned \(ad hoc\), and this build would be signed with team VSNN5UW99X/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('signing check: nothing installed, or codesign says nothing: goes on', () => {
  const none = folder(null);
  const unreadable = folder('');
  try {
    assert.deepEqual(confirm(none.dir, none.codesign, 'not set'), { code: 0, err: '' });
    mkdirSync(join(unreadable.dir, 'Margin.app'), { recursive: true });
    assert.deepEqual(confirm(unreadable.dir, unreadable.codesign, 'VSNN5UW99X'), { code: 0, err: '' });
  } finally {
    rmSync(none.dir, { recursive: true, force: true });
    rmSync(unreadable.dir, { recursive: true, force: true });
  }
});
