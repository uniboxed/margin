// npm run theme:check (scripts/check-theme.ts, docs/THEME-STORE.md §1): a theme folder checked with the app's own
// import check (ui/theme-import.ts checkImport): a usable one passes with its words; a built-in's id, a template without
// the ways out, a link in the folder and a broken theme.json are refused with why; what isn't a package's is left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTheme } from '../scripts/check-theme.ts';

const PIXEL = new URL('../app/shared/ui/themes/pixel/', import.meta.url).pathname;

function copy(change?: (dir: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'margin-theme-check-'));
  const dir = join(root, 'mine');
  cpSync(PIXEL, dir, { recursive: true });
  const manifest = join(dir, 'theme.json');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('"id": "pixel"', '"id": "my-pixel"'));
  change?.(dir);
  return { dir, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('theme:check: a usable folder passes with its words; what isn\'t a package\'s is left out', () => {
  const { dir, done } = copy((d) => writeFileSync(join(d, 'notes.psd'), 'x'));
  try {
    const r = checkTheme(dir);
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.deepEqual([r.manifest?.id, r.manifest?.name], ['my-pixel', 'Pixel']);
    assert.ok(r.left.includes('notes.psd'), `left out: ${r.left}`);
  } finally { done(); }
});

test('theme:check: refused with why: a built-in\'s id, no ways out, a link, a broken theme.json', () => {
  const builtin = checkTheme(PIXEL);
  assert.equal(builtin.ok, false);
  assert.match(builtin.errors.join(' '), /built-in/);
  const cases: [string, (d: string) => void, RegExp][] = [
    ['no Settings part', (d) => writeFileSync(join(d, 'theme.html'), readFileSync(join(d, 'theme.html'), 'utf8').replace(/<m-settings[^>]*><\/m-settings>/g, '')), /m-settings/],
    ['a link', (d) => symlinkSync('/etc/hosts', join(d, 'hosts.txt')), /link/],
    ['a broken theme.json', (d) => writeFileSync(join(d, 'theme.json'), '{ "id": '), /theme\.json/],
  ];
  for (const [what, change, why] of cases) {
    const { dir, done } = copy(change);
    try {
      const r = checkTheme(dir);
      assert.equal(r.ok, false, what);
      assert.match(r.errors.join(' '), why, `${what}: ${r.errors.join('; ')}`);
    } finally { done(); }
  }
});
