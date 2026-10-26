import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import * as M from '../extension/state/model.js';
import { THEMES, DEFAULT_THEME, themeFor } from '../extension/themes/index.js';
import arcadium, { WIDTH, snapWidth, clampWidth, sidebarWidth } from '../extension/themes/arcadium/theme.js';

const root = new URL('../extension/', import.meta.url);

test('Margin ships Arcadium, the default theme; an unknown theme falls back to it', () => {
  assert.equal(DEFAULT_THEME, 'arcadium');
  assert.deepEqual(Object.keys(THEMES), ['arcadium']);
  assert.equal(themeFor({ theme: 'arcadium' }), arcadium);
  assert.equal(themeFor({ theme: 'gone' }), arcadium);
  assert.equal(themeFor(undefined), arcadium);
});

test('every theme has its folder: content.js, newtab.js, and bundle paths the build makes', () => {
  for (const theme of Object.values(THEMES)) {
    for (const file of ['theme.js', 'content.js', 'newtab.js']) assert.ok(existsSync(new URL(`themes/${theme.id}/${file}`, root)), `${theme.id}/${file}`);
    assert.equal(theme.content, `themes/${theme.id}/content.bundle.js`);
    assert.equal(theme.newtab, `themes/${theme.id}/newtab.bundle.js`);
    assert.equal(typeof theme.settingsOf, 'function');
    assert.ok(Object.isFrozen(theme.defaults));
  }
});

test('theme.js files are UI-free (the background, the model and the build import them)', () => {
  for (const f of ['themes/index.js', ...Object.keys(THEMES).map((id) => `themes/${id}/theme.js`)]) {
    const imports = [...readFileSync(new URL(f, root), 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    for (const path of imports) assert.match(path, /(^|\/)theme\.js$|^\.\/arcadium\/theme\.js$/, `${f} imports ${path}`);
  }
});

test('settings: the active theme and each theme\'s own settings', () => {
  const s = M.defaultState();
  assert.equal(s.settings.theme, 'arcadium');
  assert.deepEqual(s.settings.themes, { arcadium: { sidebarWidth: 260 } });
  assert.notEqual(s.settings.themes.arcadium, M.DEFAULT_SETTINGS.themes.arcadium, 'a copy, not the frozen default');
  assert.equal(M.normalizeState({ settings: { theme: 'gone' } }).settings.theme, 'arcadium');
  // A theme this build doesn't have keeps its saved settings.
  assert.deepEqual(M.normalizeState({ settings: { themes: { other: { x: 1 } } } }).settings.themes.other, { x: 1 });
});

test('a saved top-level sidebarWidth (before themes) becomes Arcadium\'s', () => {
  const s = M.normalizeState({ settings: { sidebarWidth: 333 } });
  assert.equal(s.settings.themes.arcadium.sidebarWidth, 330, 'snapped');
  assert.ok(!('sidebarWidth' in s.settings), 'the old key is dropped');
  // Arcadium's own value wins over a leftover old one.
  assert.equal(M.normalizeState({ settings: { sidebarWidth: 400, themes: { arcadium: { sidebarWidth: 200 } } } }).settings.themes.arcadium.sidebarWidth, 200);
});

test('Arcadium sidebar width: default 260, clamped to 160–500, snapped to 10px', () => {
  assert.deepEqual({ ...WIDTH }, { min: 160, max: 500, default: 260, step: 10 });
  assert.equal(sidebarWidth(M.defaultState().settings), 260);
  assert.equal(sidebarWidth({}), 260);
  assert.equal(sidebarWidth(undefined), 260);
  assert.equal(sidebarWidth({ themes: { arcadium: { sidebarWidth: 'nonsense' } } }), 260);
  assert.equal(sidebarWidth({ sidebarWidth: 420 }), 420, 'pages may read settings saved before themes');
  assert.equal(snapWidth(333), 330);
  assert.equal(snapWidth(336), 340);
  assert.equal(snapWidth(40), 160);
  assert.equal(snapWidth(9000), 500);
  assert.equal(clampWidth(171.5), 171.5, 'live dragging is not snapped');
});

test('Arcadium\'s placeholder follows its width; one file exists for every width', () => {
  assert.equal(arcadium.placeholder({ themes: { arcadium: { sidebarWidth: 330 } } }), 'themes/arcadium/docked/w-330.css');
  const files = readdirSync(new URL('themes/arcadium/docked/', root));
  for (let w = WIDTH.min; w <= WIDTH.max; w += WIDTH.step) assert.ok(files.includes(`w-${w}.css`), `w-${w}.css`);
});
