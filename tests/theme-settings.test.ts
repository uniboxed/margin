// Settings for themes (ui/settings-form.ts, docs/phase6-themes.md §3): the
// theme choice with imported themes, Import Theme… and Remove (Margin.app
// only), the active theme's own settings from its theme.json (their words
// capped, with nothing that reorders or hides text), what each saves, and
// the prompt Remove asks first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsFields, saveThemeField, removePrompt, userThemeList, themeText, type SettingsField } from '../extension/ui/settings-form.ts';
import { PREVIEW_MS } from '../extension/ui/theme-preview.ts';

const LIST = [{ id: 'mine', name: 'Mine', version: '1.2.0', author: 'Me', bytes: 9 }, { id: 'arcadia', name: 'Fake Arcadia' }, { id: '../x', name: 'Bad' }, { id: 'rtl', name: 'Safe‮txt.exe', version: '1.0.0', author: 'A​B' }];
const THEME = {
  id: 'mine', name: 'Mine⁦',
  settings: {
    accent: { type: 'color', default: '#ff3366', label: 'Accent colour' },
    width: { type: 'length', default: '252px', min: 200, max: 360, step: 4, label: 'Sidebar width' },
    dense: { type: 'toggle', default: false },
    rows: { type: 'number', default: 8, min: 4, max: 12 },
    shape: { type: 'choice', default: 'square', choices: ['square', 'round'], label: 'x'.repeat(60) },
  },
};
const byId = (fields: SettingsField[]) => Object.fromEntries(fields.map((f) => [f.id, f]));

test('the theme choice lists the built-ins, then the imported themes by name (only valid ids, never a built-in\'s twice)', () => {
  const f = byId(settingsFields({ theme: 'mine' }, { userThemes: LIST }));
  assert.deepEqual(f.theme.options.map((o) => o.id), ['arcadia', 'neubrutalism', 'pixel', 'mine', 'rtl'].filter((id) => id !== 'pixel' || f.theme.options.some((o) => o.id === 'pixel')));
  assert.equal(f.theme.value, 'mine');
  assert.equal(f.theme.options.find((o) => o.id === 'rtl')!.label, 'Safetxt.exe', 'bidi controls out');
  assert.equal(byId(settingsFields({ theme: 'gone' }, { userThemes: LIST })).theme.value, 'arcadia', 'an id no longer listed: Arcadia');
});

test('Import Theme… and each imported theme with Remove: in Margin.app only', () => {
  assert.equal(byId(settingsFields({}, { userThemes: LIST })).themeImport, undefined, 'not in a page');
  const f = byId(settingsFields({}, { importThemes: true, userThemes: LIST }));
  assert.equal(f.themeImport.isButton, true);
  assert.match(f.themeImport.status, /folder, or a \.margintheme file/);
  assert.equal(f['userTheme:mine'].label, '“Mine” 1.2.0 · by Me');
  assert.equal(f['removeTheme:mine'].label, 'Remove “Mine”');
  assert.equal(f['userTheme:rtl'].label, '“Safetxt.exe” 1.0.0 · by AB');
  assert.equal(f['removeTheme:arcadia'], undefined, 'a built-in can\'t be removed');
  const status = byId(settingsFields({}, { importThemes: true }, { status: { themeImport: { text: 'Margin can’t use that theme: …', error: true }, theme: { text: 'Margin couldn’t draw…', error: true } } }));
  assert.equal(status.themeImport.error, true);
  assert.equal(status.theme.status, 'Margin couldn’t draw…', 'why Margin fell back, under the choice');
});

test('the active theme\'s own settings, from its theme.json: Margin\'s inputs, its labels capped and cleaned, marked as the theme\'s', () => {
  const fields = settingsFields({ themes: { mine: { width: '300px', accent: 'url(x)', dense: true } } }, {}, { theme: THEME });
  const f = byId(fields);
  assert.equal(f.themeSettings.isGroup, true);
  assert.equal(f.themeSettings.label, 'Settings of “Mine”');
  assert.equal(f['themeSetting:accent'].isColor, true);
  assert.equal(f['themeSetting:accent'].value, '#ff3366', 'a saved value its spec refuses: the default');
  assert.equal(f['themeSetting:width'].isNumber, true);
  assert.equal(f['themeSetting:width'].value, '300', 'a length shown as its number');
  assert.equal(f['themeSetting:width'].step, '4');
  assert.equal(f['themeSetting:dense'].checked, true);
  assert.equal(f['themeSetting:dense'].label, 'dense', 'no label: its name');
  assert.deepEqual(f['themeSetting:shape'].options.map((o) => o.id), ['square', 'round']);
  assert.equal(f['themeSetting:shape'].label.length, 40);
  assert.ok(fields.filter((x) => x.id.startsWith('themeSetting:')).every((x) => x.fromTheme));
  assert.equal(settingsFields({}, {}, { theme: { id: 'x', name: 'X', settings: {} } }).some((x) => x.id === 'themeSettings'), false, 'none: no heading');
});

test('the theme\'s own settings come after Margin\'s, right before the keyboard shortcuts: Margin\'s rows never sit under "Settings of …"', () => {
  const ids = settingsFields({}, { importThemes: true, userThemes: LIST, cloudTabs: true }, { theme: THEME }).map((x) => x.id);
  const heading = ids.indexOf('themeSettings');
  const shortcuts = ids.indexOf('shortcuts');
  assert.ok(heading > 0 && shortcuts > heading, 'the heading before the shortcuts');
  assert.ok(ids.slice(heading + 1, shortcuts).every((id) => id.startsWith('themeSetting:')), 'only the theme\'s rows between the two headings');
  for (const id of ['theme', 'themeImport', 'removeTheme:mine', 'engine', 'archiveAfterHours', 'frameWhenHidden', 'showCloudTabs']) assert.ok(ids.indexOf(id) < heading, `${id} before the theme's own`);
  assert.equal(ids[ids.indexOf('themeImport') - 1], 'theme', 'Import Theme… right under the theme choice');
});

test('saving a theme\'s own setting: updateThemeSettings for that theme only, checked against its spec', () => {
  const f = byId(settingsFields({}, {}, { theme: THEME }));
  assert.deepEqual(saveThemeField(f['themeSetting:width'], '320', THEME), { type: 'updateThemeSettings', payload: { themeId: 'mine', patch: { width: '320px' } } });
  assert.equal(saveThemeField(f['themeSetting:width'], '999', THEME), null, 'over its max');
  // Each a valid value: saved (null only when refused).
  assert.deepEqual(saveThemeField(f['themeSetting:accent'], '#00ff00', THEME)!.payload.patch, { accent: '#00ff00' });
  assert.equal(saveThemeField(f['themeSetting:accent'], 'url(https://evil.test/)', THEME), null);
  assert.deepEqual(saveThemeField(f['themeSetting:rows'], '10', THEME)!.payload.patch, { rows: 10 });
  assert.deepEqual(saveThemeField(f['themeSetting:dense'], true, THEME)!.payload.patch, { dense: true });
  assert.deepEqual(saveThemeField(f['themeSetting:shape'], 'round', THEME)!.payload.patch, { shape: 'round' });
  assert.equal(saveThemeField(f['themeSetting:shape'], 'triangle', THEME), null);
  // A field of which only its id matters here.
  assert.equal(saveThemeField({ id: 'theme' } as SettingsField, 'x', THEME), null, 'not a theme setting');
  assert.equal(saveThemeField(f['themeSetting:width'], '320', null), null, 'no theme');
});

test('Remove asks first, in Margin\'s words around the theme\'s name', () => {
  const p = removePrompt('removeTheme:mine', LIST)!; // a listed theme: asked
  assert.equal(p.id, 'remove-theme:mine');
  assert.equal(p.text, 'Remove “Mine”? Windows using it go back to Arcadia.');
  assert.deepEqual(p.actions.map((a) => a.id), ['remove', 'cancel']);
  assert.equal(removePrompt('removeTheme:arcadia', LIST), null);
  assert.equal(removePrompt('removeTheme:nope', LIST), null);
  assert.equal(removePrompt('theme', LIST), null);
  assert.deepEqual(userThemeList('x'), []);
  assert.equal(themeText('a‮b', 10), 'ab');
  assert.equal(themeText('x'.repeat(50), 10), `${'x'.repeat(9)}…`);
});

test('a preview ends by itself after 30 s', () => { assert.equal(PREVIEW_MS, 30_000); });
