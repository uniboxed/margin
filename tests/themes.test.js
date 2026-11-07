import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import * as M from '../extension/state/model.js';
import { fromStorage, storedName } from '../extension/shared/stored.js';
import { dataSetFromStorage } from '../extension/shared/data-set.js';
import { THEMES, DEFAULT_THEME, themeFor } from '../extension/themes/index.js';
import arcadia, { WIDTH, snapWidth, clampWidth, sidebarWidth } from '../extension/themes/arcadia/theme.js';

const root = new URL('../extension/', import.meta.url);

test('Margin ships Arcadia, the default theme; an unknown theme falls back to it', () => {
  assert.equal(DEFAULT_THEME, 'arcadia');
  assert.deepEqual(Object.keys(THEMES), ['arcadia']);
  assert.equal(themeFor({ theme: 'arcadia' }), arcadia);
  assert.equal(themeFor({ theme: 'gone' }), arcadia);
  assert.equal(themeFor(undefined), arcadia);
});

test('every theme has its folder: theme.js (settings) beside its package and its first paint', () => {
  for (const theme of Object.values(THEMES)) {
    for (const file of ['theme.js', 'theme.json', 'theme.html', 'theme.css', 'first-paint.css']) assert.ok(existsSync(new URL(`themes/${theme.id}/${file}`, root)), `${theme.id}/${file}`);
    assert.equal(theme.content, undefined, 'no theme script any more');
    assert.equal(typeof theme.settingsOf, 'function');
    assert.ok(Object.isFrozen(theme.defaults));
  }
});

test('theme.js files are UI-free (the background, the model and the build import them)', () => {
  for (const f of ['themes/index.js', ...Object.keys(THEMES).map((id) => `themes/${id}/theme.js`)]) {
    const imports = [...readFileSync(new URL(f, root), 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    for (const path of imports) assert.match(path, /(^|\/)theme\.js$|^\.\/arcadia\/theme\.js$/, `${f} imports ${path}`);
  }
});

test('settings: the active theme and each theme\'s own settings', () => {
  const s = M.defaultState();
  assert.equal(s.settings.theme, 'arcadia');
  assert.deepEqual(s.settings.themes, { arcadia: { sidebarWidth: 260 } });
  assert.notEqual(s.settings.themes.arcadia, M.DEFAULT_SETTINGS.themes.arcadia, 'a copy, not the frozen default');
  // Not a theme id at all: Arcadia. An id an imported theme may have is kept
  // (the index isn't read here; what draws the theme falls back to Arcadia).
  for (const bad of ['Gone', '../x', '', 42, null, 'x'.repeat(42), 'toString']) assert.equal(M.normalizeState({ settings: { theme: bad } }).settings.theme, 'arcadia', String(bad));
  assert.equal(M.normalizeState({ settings: { theme: 'gone' } }).settings.theme, 'gone');
  // A theme this build doesn't have keeps its saved settings.
  assert.deepEqual(M.normalizeState({ settings: { themes: { other: { x: 1 } } } }).settings.themes.other, { x: 1 });
});

test('a saved top-level sidebarWidth (before themes) becomes Arcadia\'s', () => {
  const s = M.normalizeState({ settings: { sidebarWidth: 333 } });
  assert.equal(s.settings.themes.arcadia.sidebarWidth, 330, 'snapped');
  assert.ok(!('sidebarWidth' in s.settings), 'the old key is dropped');
  // Arcadia's own value wins over a leftover old one.
  assert.equal(M.normalizeState({ settings: { sidebarWidth: 400, themes: { arcadia: { sidebarWidth: 200 } } } }).settings.themes.arcadia.sidebarWidth, 200);
});

test('Arcadia sidebar width: default 260, clamped to 160–500, snapped to 10px', () => {
  assert.deepEqual({ ...WIDTH }, { min: 160, max: 500, default: 260, step: 10 });
  assert.equal(sidebarWidth(M.defaultState().settings), 260);
  assert.equal(sidebarWidth({}), 260);
  assert.equal(sidebarWidth(undefined), 260);
  assert.equal(sidebarWidth({ themes: { arcadia: { sidebarWidth: 'nonsense' } } }), 260);
  assert.equal(sidebarWidth({ sidebarWidth: 420 }), 420, 'pages may read settings saved before themes');
  assert.equal(snapWidth(333), 330);
  assert.equal(snapWidth(336), 340);
  assert.equal(snapWidth(40), 160);
  assert.equal(snapWidth(9000), 500);
  assert.equal(clampWidth(171.5), 171.5, 'live dragging is not snapped');
});

test('the theme\'s earlier name: its id falls back, its own settings carry over, and the old entry goes', () => {
  const { settings } = M.normalizeState({ settings: { theme: 'arcadium', themes: { arcadium: { sidebarWidth: 330 } } } });
  assert.equal(settings.theme, 'arcadia');
  assert.equal(settings.themes.arcadia.sidebarWidth, 330);
  assert.equal('arcadium' in settings.themes, false);
});

test('Arcadia\'s package\'s earlier name (arcadia-2): its settings join Arcadia\'s, snapped and clamped, and the old entry goes', () => {
  const norm = (settings) => M.normalizeState({ settings }).settings;
  // Only the package's: its width, snapped to 10 px and clamped to 160–500.
  let s = norm({ themes: { 'arcadia-2': { sidebarWidth: 333 } } });
  assert.deepEqual(s.themes.arcadia, { sidebarWidth: 330 });
  assert.equal('arcadia-2' in s.themes, false);
  assert.equal(norm({ themes: { 'arcadia-2': { sidebarWidth: 900 } } }).themes.arcadia.sidebarWidth, 500);
  assert.equal(norm({ themes: { 'arcadia-2': { sidebarWidth: 20 } } }).themes.arcadia.sidebarWidth, 160);
  // Arcadia's own width wins over the package's, which wins over a top-level one.
  s = norm({ sidebarWidth: 410, themes: { arcadia: { sidebarWidth: 287 }, 'arcadia-2': { sidebarWidth: 333 } } });
  assert.equal(s.themes.arcadia.sidebarWidth, 290);
  assert.equal(norm({ sidebarWidth: 410, themes: { 'arcadia-2': { sidebarWidth: 333 } } }).themes.arcadia.sidebarWidth, 330);
  assert.equal(norm({ sidebarWidth: 414, themes: { 'arcadia-2': {} } }).themes.arcadia.sidebarWidth, 410);
  assert.ok(!('sidebarWidth' in s), 'the top-level key is dropped');
  // Other themes' settings stay as saved.
  assert.deepEqual(norm({ themes: { 'arcadia-2': { sidebarWidth: 300 }, 'neo-brutalism': { sidebarWidth: '300px' } } }).themes['neo-brutalism'], { sidebarWidth: '300px' });
});

test('an imported theme chosen in Settings survives every fresh read of the state (a background started again, the converter)', () => {
  // What storage.local holds after Use Theme: the app's index and settings.theme naming it.
  const raw = { [storedName('settings')]: { ...M.defaultState().settings, theme: 'my-theme', themes: { 'my-theme': { accent: '#ff3366' } } }, userThemes: [{ id: 'my-theme', name: 'Mine', version: '1.0.0', author: '' }] };
  const once = M.normalizeState(fromStorage(raw));
  assert.equal(once.settings.theme, 'my-theme');
  assert.deepEqual(once.settings.themes['my-theme'], { accent: '#ff3366' });
  // Read again from what that read would write back.
  const again = M.normalizeState(fromStorage({ ...raw, [storedName('settings')]: once.settings }));
  assert.equal(again.settings.theme, 'my-theme', 'still the imported theme after a second start');
  const set = dataSetFromStorage(raw, { now: 1 });
  assert.equal(set.items.settings.theme.value, 'my-theme', 'the data set the app adopts keeps it too');
});
