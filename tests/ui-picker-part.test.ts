// A theme's own Edit Theme Color (M2.9 step 5b, docs/SPACE-BACKGROUNDS.md decision 10): what its part reads
// (ui/picker/view.ts pickerView), the items its buttons may run and what each does (pickerItemIds, runItem), the
// attributes of Margin's elements in it as the sanitizer keeps them and as Margin reads them (ui/picker/elements.ts),
// and the action that runs an item (`picker.run`). The part in the browsers: tests/theme/picker-part.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AMOUNTS, INTENSITY_STEPS, pageOf, pickerItemIds, pickerView, runItem } from '../app/shared/ui/picker/view.ts';
import type { PickerUi } from '../app/shared/ui/picker/view.ts';
import { PRESET_PAGES, TEXTURES, stateOf } from '../app/shared/ui/picker/model.ts';
import { FIELD_VARIANTS, PICKER_ATTRS, SLIDER_VALUES, SLIDER_VARIANTS, pickerAttr } from '../app/shared/ui/picker/elements.ts';
import { sanitizeTemplate } from '../app/shared/ui/sanitize.ts';
import { ACTIONS, BEHAVIOR_ONLY, checkAction, contextFromState, requestFor } from '../app/shared/ui/actions.ts';
import { SPACE_COLORS } from '../app/shared/ui/behaviors/menu-items.ts';
import { backgroundOf } from '../extension/shared/space-background.ts';

const some = (bg: Record<string, unknown>) => stateOf(backgroundOf(bg));
const ui = (state = some({ colors: ['#6c5ce7', '#00b894'], intensity: 0.55, texture: 'sand', amount: 0.3, appearance: 'dark' }), page = 0, all = false): PickerUi => ({ spaceId: 'a', state, page, all });

test('picker view: everything a theme draws, in Margin\'s words, as the state is', () => {
  const v = pickerView(ui());
  assert.equal(v.title, 'Edit Theme Color');
  assert.deepEqual(v.appearances.map((a) => [a.id, a.short, a.selected]), [['appearance:auto', 'Auto', false], ['appearance:light', 'Light', false], ['appearance:dark', 'Dark', true]]);
  assert.deepEqual([v.empty, v.colors.count, v.colors.countLabel, v.colors.add.disabled, v.colors.remove.disabled, v.colors.hasRule, v.colors.rule.text], [false, 2, '2 colors', false, false, true, 'Analogous']);
  assert.deepEqual(v.presets.map((p) => p.color), [...PRESET_PAGES[0]]);
  assert.ok(v.presets.every((p) => /^preset:\d$/.test(p.id) && p.label.startsWith('Set space color to #')));
  assert.equal(v.presets.find((p) => p.selected)?.color, '#6c5ce7', 'the key colour, where it\'s a preset');
  assert.deepEqual([v.intensity.value, v.intensity.text, v.intensity.steps.filter((s) => s.on).length, v.intensity.steps.find((s) => s.selected)], [55, '55%', 5, undefined]);
  assert.deepEqual([v.texture.value, v.texture.name, v.texture.amount, v.texture.text, v.texture.showing], ['sand', 'Sand', 30, 'Sand, 30%', true]);
  assert.deepEqual(v.textures.map((t) => [t.id, t.selected]), TEXTURES.map((t) => [`texture:${t}`, t === 'sand']));
  assert.deepEqual(v.amounts.map((a) => [a.id, a.label]), [['amount:0', 'Off'], ['amount:25', '25%'], ['amount:50', '50%'], ['amount:75', '75%'], ['amount:100', '100%']]);
  assert.deepEqual([v.all.label, pickerView(ui(undefined, 0, true)).all.label, v.done.label], ['Use for All Spaces', 'Used for all spaces', 'Done']);
  const none = pickerView(ui(stateOf(null)));
  assert.deepEqual([none.empty, none.colors.countLabel, none.colors.remove.disabled, none.colors.hasRule, none.textures.some((t) => t.selected)], [true, '0 colors', true, false, false], 'nothing yet');
  assert.deepEqual(pickerView(ui(undefined, 7)).presets.map((p) => p.color), [...PRESET_PAGES[2]], 'a page past the last: round again');
});

test('picker items: what a theme\'s buttons may run, each only while it makes sense', () => {
  const ids = pickerItemIds(pickerView(ui()));
  for (const id of ['appearance:auto', 'colors:add', 'colors:remove', 'colors:rule', 'preset:0', 'preset:8', 'presets:prev', 'presets:next', 'intensity:10', 'intensity:100', 'texture:grid', 'texture:next', 'texture:prev', 'amount:0', 'amount:100', 'all', 'done']) assert.ok(ids.includes(id), id);
  const three = pickerItemIds(pickerView(ui(some({ colors: ['#111111', '#222222', '#333333'] }))));
  assert.ok(!three.includes('colors:add'), 'not past three');
  const none = pickerItemIds(pickerView(ui(stateOf(null))));
  assert.ok(!none.includes('colors:remove') && !none.includes('colors:rule'), 'nothing to take away, no rule');
  assert.equal(new Set(ids).size, ids.length, 'one each');
  assert.ok(ids.every((id) => /^[A-Za-z0-9_:-]{1,64}$/.test(id)), 'every id an id the actions read');
});

test('picker items: each does its edit; nothing for what isn\'t one', () => {
  const u = ui();
  const commit = (id: string) => { const r = runItem(u, id); assert.equal(r?.kind, 'commit', id); return r as Extract<typeof r, { kind: 'commit' }>; };
  assert.equal(commit('appearance:light').state.appearance, 'light');
  assert.equal(commit('appearance:light').tick, 'appearance');
  assert.equal(commit('colors:add').state.colors.length, 3);
  assert.equal(commit('colors:remove').state.colors.length, 1);
  assert.equal(commit('colors:rule').state.wheel, 'complementary');
  assert.equal(commit('preset:2').state.colors[0], SPACE_COLORS[1]);
  assert.equal(runItem(ui(undefined, 1), 'preset:2')?.kind === 'commit' && (runItem(ui(undefined, 1), 'preset:2') as any).state.colors[0], PRESET_PAGES[1][2], 'the page shown');
  assert.deepEqual(runItem(u, 'presets:next'), { kind: 'page', page: 1 });
  assert.deepEqual(runItem(u, 'presets:prev'), { kind: 'page', page: PRESET_PAGES.length - 1 });
  assert.deepEqual([commit('texture:grid').state.texture, commit('texture:grid').state.amount], ['grid', 0.3], 'the amount kept');
  assert.equal((runItem(ui(some({ colors: ['#111111'], amount: 0 })), 'texture:grid') as any).state.amount, 0.25, 'at 0 it starts showing');
  assert.equal(commit('texture:next').state.texture, 'denim');
  assert.equal(commit('texture:prev').state.texture, 'grain');
  assert.equal(commit('amount:75').state.amount, 0.75);
  assert.equal(commit('intensity:20').state.intensity, 0.2);
  assert.deepEqual([runItem(u, 'all'), runItem(u, 'done')], [{ kind: 'all' }, { kind: 'done' }]);
  for (const bad of ['appearance:purple', 'colors:many', 'preset:9', 'preset:x', 'presets:up', 'texture:velvet', 'amount:30', 'amount:', 'intensity:5', 'intensity:1000', 'all:now', 'done:x', 'nope', '', 'toString', '__proto__:x']) assert.equal(runItem(u, bad), null, bad);
  assert.equal(runItem(ui(some({ colors: ['#111111', '#222222', '#333333'] })), 'colors:add'), null, 'not past three');
  assert.equal(runItem(ui(stateOf(null)), 'colors:remove'), null);
  assert.deepEqual(AMOUNTS, [0, 25, 50, 75, 100]);
  assert.equal(INTENSITY_STEPS.length, 10);
});

test('picker items: a picture\'s, only where the host serves pictures (Margin.app); its fit and removal only with one', () => {
  const ID = 'a'.repeat(64);
  assert.equal(pickerView(ui()).picture, null, 'no pictures: none');
  assert.ok(!pickerItemIds(pickerView(ui())).some((id) => id.startsWith('picture:')));
  assert.equal(runItem(ui(), 'picture:choose'), null);
  const without: PickerUi = { ...ui(), pictures: true };
  let v = pickerView(without);
  assert.deepEqual([v.picture?.has, v.picture?.choose.label, v.picture?.fit, v.picture?.hasNote], [false, 'Add Picture…', null, false]);
  assert.deepEqual(pickerItemIds(v).filter((id) => id.startsWith('picture:')), ['picture:choose']);
  assert.deepEqual(runItem(without, 'picture:choose'), { kind: 'choose' });
  assert.equal(runItem(without, 'picture:remove'), null, 'nothing to remove');
  assert.equal(runItem(without, 'picture:fit:tile'), null, 'nothing to fit');
  const withOne: PickerUi = { ...without, state: { ...without.state, image: { id: ID, fit: 'cover', focus: [0.5, 0.5] } }, note: 'That isn’t a picture.' };
  v = pickerView(withOne);
  assert.deepEqual([v.picture?.has, v.picture?.choose.label, v.picture?.fit, v.picture?.note, v.picture?.hasNote], [true, 'Change Picture…', 'cover', 'That isn’t a picture.', true]);
  assert.deepEqual(v.picture?.fits.map((f) => [f.id, f.label, f.selected]), [['picture:fit:cover', 'Fill', true], ['picture:fit:contain', 'Fit', false], ['picture:fit:tile', 'Tile', false]]);
  assert.deepEqual(pickerItemIds(v).filter((id) => id.startsWith('picture:')), ['picture:choose', 'picture:remove', 'picture:fit:cover', 'picture:fit:contain', 'picture:fit:tile']);
  const tile = runItem(withOne, 'picture:fit:tile');
  assert.equal(tile?.kind, 'commit');
  assert.equal(tile?.kind === 'commit' && tile.state.image?.fit, 'tile');
  const gone = runItem(withOne, 'picture:remove');
  assert.equal(gone?.kind === 'commit' && gone.state.image, null);
  for (const bad of ['picture:fit:stretch', 'picture:fit', 'picture:', 'picture:choose:x', 'picture']) assert.equal(runItem(withOne, bad), null, bad);
});

test('picker page: the one the key colour is on, else the first', () => {
  assert.equal(pageOf(some({ colors: [PRESET_PAGES[3][4]] })), 3);
  assert.equal(pageOf(some({ colors: ['#010203'] })), 0);
  assert.equal(pageOf(stateOf(null)), 0);
});

test('Margin\'s picker elements: their attributes as the sanitizer keeps them and as Margin reads them', () => {
  assert.deepEqual([FIELD_VARIANTS, SLIDER_VALUES, SLIDER_VARIANTS], [['dots', 'wheel', 'cells'], ['intensity', 'amount'], ['wave', 'bar']]);
  assert.deepEqual(Object.keys(PICKER_ATTRS).sort(), ['m-picker-dial', 'm-picker-field', 'm-picker-slider']);
  assert.equal(pickerAttr('m-picker-field', 'm-variant', 'cells'), 'cells');
  assert.equal(pickerAttr('m-picker-field', 'm-variant', 'zigzag'), 'dots', 'unknown: the default');
  assert.equal(pickerAttr('m-picker-field', 'm-variant', null), 'dots');
  assert.equal(pickerAttr('m-picker-slider', 'm-value', null), 'intensity');
  assert.equal(pickerAttr('m-picker-dial', 'm-variant', 'wave'), '', 'nothing it takes');
  const keep = (html: string) => { const r = sanitizeTemplate(`<div class="t">${html}<m-page></m-page></div>`); return { html: JSON.stringify(r.tree), removed: r.removed.map((x) => `${x.name}: ${x.reason}`) }; };
  const good = keep('<m-picker-field m-variant="wheel"></m-picker-field><m-picker-slider m-value="amount" m-variant="wave"></m-picker-slider><m-picker-dial class="d"></m-picker-dial>');
  assert.deepEqual(good.removed, []);
  for (const kept of ['m-picker-field', '"wheel"', 'm-picker-slider', '"amount"', '"wave"', 'm-picker-dial']) assert.ok(good.html.includes(kept), kept);
  const bad = keep('<m-picker-field m-variant="zigzag" m-value="amount"></m-picker-field><m-picker-slider m-value="hue" m-variant="cells"></m-picker-slider><m-picker-dial m-variant="wave"></m-picker-dial><div m-variant="wheel"></div>');
  assert.equal(bad.removed.length, 6, bad.removed.join(' | '));
  assert.ok(!bad.html.includes('zigzag') && !bad.html.includes('"hue"') && !bad.html.includes('"cells"'), 'none of them kept');
});

test('picker.run: one of the open picker\'s items, from a theme\'s button; local; refused otherwise', () => {
  assert.equal(ACTIONS['picker.run'], 'picker-item');
  assert.equal(BEHAVIOR_ONLY.has('picker.run'), false, 'a theme\'s button runs it');
  const state = { spaces: [{ id: 'a' }], tabs: {}, activeSpaceByWindow: { 1: 'a' } };
  const ids = pickerItemIds(pickerView(ui()));
  assert.deepEqual(checkAction('picker.run', 'texture:grid', contextFromState(state, [], { pickerIds: ids })), { ok: true });
  assert.equal(checkAction('picker.run', 'texture:velvet', contextFromState(state, [], { pickerIds: ids })).ok, false, 'not one of its items');
  assert.equal(checkAction('picker.run', 'texture:grid', contextFromState(state, [])).ok, false, 'no picker open');
  assert.equal(checkAction('picker.run', { id: 'texture:grid' }, contextFromState(state, [], { pickerIds: ids })).ok, false);
  assert.equal(requestFor('picker.run', 'done', { state, ui: { windowId: 1 } } as any).kind, 'local');
});
