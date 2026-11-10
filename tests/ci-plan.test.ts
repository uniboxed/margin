// CI's plan (scripts/ci-plan.mts): what a change reaches, and the theme browser tests scoped to it; and how a theme
// test file picks its themes from MARGIN_TEST_THEMES (tests/theme/package.ts themesInScope).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { plan } from '../scripts/ci-plan.mts';
import { themesInScope } from './theme/package.ts';

const THEME_TESTS = readdirSync(new URL('./theme/', import.meta.url)).filter((n) => n.endsWith('.test.ts')).sort().map((n) => `tests/theme/${n}`);
const OWN = ['tests/theme/arcadia.test.ts', 'tests/theme/neubrutalism.test.ts', 'tests/theme/pixel.test.ts'];
const AGNOSTIC = THEME_TESTS.filter((f) => !OWN.includes(f));
const LOOPED = ['tests/theme/behaviors.test.ts', 'tests/theme/cloud.test.ts', 'tests/theme/feedback.test.ts', 'tests/theme/security.test.ts', 'tests/theme/switch-cover.test.ts'];
const kinds = (p) => p.browsers.include.map((j) => `${j.kind} ${j.shard}${j.themes ? ` ${j.themes}` : ''}`);

test('docs only: nothing heavy runs', () => {
  const p = plan(['README.md', 'docs/HANDOFF.md']);
  assert.deepEqual([p.unit, p.e2e, p.rust, p.app, p.browsers_any], [false, false, false, false, false]);
  assert.deepEqual(p.browsers.include, []);
});

test('everything (a nightly, by hand, no base) and the workflow itself: every theme test in every theme, on two Macs', () => {
  for (const p of [plan([], { everything: true }), plan(['.github/workflows/ci.yml']), plan(['package-lock.json'])]) {
    assert.deepEqual([p.unit, p.e2e, p.rust, p.app, p.browsers_any], [true, true, true, true, true]);
    assert.deepEqual(p.themes.files, THEME_TESTS);
    assert.equal(p.themes.scope, '');
    assert.deepEqual(kinds(p), ['theme 1/2', 'theme 2/2', 'e2e 1/2', 'e2e 2/2']);
  }
});

test('the UI runtime, the host page or the harness: the theme-agnostic tests, against the reference theme', () => {
  for (const f of ['extension/ui/render.ts', 'extension/ui/behaviors/drag.ts', 'app/shared/host/overlay.html', 'tests/theme/harness.ts', 'extension/shared/page-box.ts', 'extension/themes/packages.ts']) {
    const p = plan([f]);
    assert.deepEqual(p.themes.files, AGNOSTIC, f);
    assert.equal(p.themes.scope, 'reference', f);
    assert.deepEqual(kinds(p), ['theme 1/1 reference', ...(f.startsWith('tests/') ? [] : ['e2e 1/2', 'e2e 2/2'])], f);
  }
});

test('a theme\'s folder: its own tests, and its entries in the tests that loop over the themes', () => {
  const p = plan(['extension/themes/pixel/theme.css']);
  assert.deepEqual(p.themes.files, [...LOOPED, 'tests/theme/pixel.test.ts'].sort());
  assert.equal(p.themes.scope, 'pixel');
  const both = plan(['extension/themes/pixel/theme.css', 'extension/ui/render.ts']);
  assert.deepEqual(both.themes.files, [...AGNOSTIC, 'tests/theme/pixel.test.ts'].sort());
  assert.equal(both.themes.scope, 'reference,pixel');
});

test('a theme test file itself: that file, in every theme it has (and no end-to-end tests)', () => {
  const own = plan(['tests/theme/neubrutalism.test.ts']);
  assert.deepEqual(own.themes.files, ['tests/theme/neubrutalism.test.ts']);
  assert.deepEqual(kinds(own), ['theme 1/1']);
  const p = plan(['tests/theme/behaviors.test.ts']);
  assert.deepEqual(p.themes.files, ['tests/theme/behaviors.test.ts']);
  assert.equal(p.themes.scope, '');
});

test('what the theme suite never loads (the background, an e2e test, the connector): no theme tests, the end-to-end ones', () => {
  for (const f of ['extension/background/store.ts', 'tests/e2e/scroll.test.ts', 'tests/e2e/harness/margin.ts', 'app/shared/connector/src/lib.rs']) {
    const p = plan([f]);
    assert.deepEqual(p.themes.files, [], f);
    assert.deepEqual(kinds(p), ['e2e 1/2', 'e2e 2/2'], f);
  }
});

test('a unit test alone: the unit tests, no browser', () => {
  const p = plan(['tests/switch-plain.test.ts']);
  assert.equal(p.unit, true);
  assert.deepEqual(p.browsers.include, []);
});

test('Rust and the app only: no browser tests', () => {
  const p = plan(['app/platforms/windows/src/main.rs']);
  assert.equal(p.rust, true);
  assert.equal(p.e2e, false);
  assert.deepEqual(p.browsers.include, []);
  assert.equal(p.browsers_any, false);
});

test('MARGIN_TEST_THEMES: every theme by default; ids; the reference theme, or a file\'s first where it has no Arcadia', () => {
  const three = [['arcadia', 1], ['neubrutalism', 2], ['pixel', 3]];
  const two = [['neubrutalism', 2], ['pixel', 3]];
  assert.deepEqual(themesInScope(three, undefined, ''), three);
  assert.deepEqual(themesInScope(three, undefined, 'all'), three);
  assert.deepEqual(themesInScope(three, undefined, 'pixel'), [['pixel', 3]]);
  assert.deepEqual(themesInScope(three, undefined, 'reference'), [['arcadia', 1]]);
  assert.deepEqual(themesInScope(two, undefined, 'reference'), [['neubrutalism', 2]]);
  assert.deepEqual(themesInScope(three, undefined, 'reference, pixel'), [['arcadia', 1], ['pixel', 3]]);
  assert.deepEqual(themesInScope(two, undefined, 'arcadia'), [], 'a file without the theme runs none');
  const pkgs = [{ id: 'arcadia' }, { id: null }];
  assert.deepEqual(themesInScope(pkgs, (p) => p.id, 'pixel'), [{ id: null }], 'a package with no id (MARGIN_THEMES) is always kept');
  assert.throws(() => themesInScope(three, undefined, 'arcadai'), /isn't a built-in theme/);
});
