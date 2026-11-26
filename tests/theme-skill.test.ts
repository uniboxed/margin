// The margin-theme skill (scripts/build-skill.ts, docs/THEME-STORE.md §6) as it's handed to someone's own Claude: its
// SKILL.md with a name and a description, the theme guide as the repo has it, a template theme under its own id that
// Margin's check passes, and the checker bundled to run with Node alone (its built-ins only; the packer's command not
// in it), refusing a broken theme with why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkill, TEMPLATE_ID } from '../scripts/build-skill.ts';

const README = new URL('../app/shared/ui/themes/README.md', import.meta.url).pathname;

test('the margin-theme skill: SKILL.md, the guide, a template Margin takes, the checker for Node alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'margin-skill-'));
  try {
    const out = buildSkill(join(root, 'margin-theme'));
    const skill = readFileSync(join(out, 'SKILL.md'), 'utf8');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
    assert.match(front, /^name: margin-theme$/m);
    assert.match(front, /^description: .{40,}$/m, 'a description to decide when to use it');
    assert.equal(readFileSync(join(out, 'reference/README.md'), 'utf8'), readFileSync(README, 'utf8'), 'the guide as the repo has it');
    const manifest = JSON.parse(readFileSync(join(out, 'template/theme.json'), 'utf8'));
    assert.deepEqual([manifest.id, manifest.version], [TEMPLATE_ID, '0.1.0']);

    const checker = join(out, 'scripts/check-theme.mjs');
    const code = readFileSync(checker, 'utf8');
    const imports = [...code.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    assert.ok(imports.length > 0 && imports.every((m) => m.startsWith('node:')), `Node's built-ins only: ${imports}`);
    assert.doesNotMatch(code, /not packed/, 'the packer\'s command isn\'t in it');
    // Run as someone would, from another folder.
    const ok = spawnSync(process.execPath, [checker, join(out, 'template')], { cwd: root, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^ok: “My Theme” my-theme 0\.1\.0/);

    const broken = join(root, 'broken');
    cpSync(join(out, 'template'), broken, { recursive: true });
    writeFileSync(join(broken, 'theme.html'), readFileSync(join(broken, 'theme.html'), 'utf8').replace(/<m-settings[^>]*><\/m-settings>/g, ''));
    const no = spawnSync(process.execPath, [checker, broken], { cwd: root, encoding: 'utf8' });
    assert.equal(no.status, 1);
    assert.match(no.stderr, /Margin wouldn’t use it:[\s\S]*m-settings/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
