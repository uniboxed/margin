// Edit Theme Color's model and actions (M2.9 step 4, docs/SPACE-BACKGROUNDS.md Part B §4): the field's hidden wheel,
// the others following the key by the rule, each edit as a step from one picker state to the next, what's saved (the
// model's reading of it), the presets, and the actions that open the picker and save its value. The panel itself, in
// the browsers: tests/theme/picker.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIELD, FIRST_AMOUNT, MAX_COLORS, OFFSETS, PRESET_PAGES, TEXTURES, addColor, backgroundFrom, colorAt, cycleTexture, followers, knobs, moveKey, moveKnob, pickPreset, pointOf, removeColor, setAmount, setAppearance, setIntensity, stateOf, toggleWheel } from '../app/shared/ui/picker/model.ts';
import { ACTIONS, BEHAVIOR_ONLY, checkAction, requestFor } from '../app/shared/ui/actions.ts';
import { SPACE_COLORS } from '../app/shared/ui/behaviors/menu-items.ts';
import { backgroundOf } from '../extension/state/model.ts';
import { oklchOf, hexToRgb } from '../app/shared/ui/color.ts';

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;
const angleNear = (a: number, b: number, eps: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b)) <= eps;

test('picker: the field is a hidden wheel: the angle the hue, the distance the lightness (centre pale, rim full)', () => {
  const [Lc] = oklchOf(hexToRgb(colorAt({ angle: 30, d: 0 }))!);
  const [Le, Ce] = oklchOf(hexToRgb(colorAt({ angle: 30, d: 1 }))!);
  assert.ok(near(Lc, FIELD.Lc, 0.01) && near(Le, FIELD.Le, 0.01), `${Lc} ${Le}`);
  assert.ok(Ce > 0.1, 'the rim a full colour');
  for (const p of [{ angle: 10, d: 0.3 }, { angle: 200, d: 0.7 }, { angle: 300, d: 0.95 }]) {
    const back = pointOf(colorAt(p));
    assert.ok(angleNear(back.angle, p.angle, 3) && near(back.d, p.d, 0.02), `${JSON.stringify(p)} → ${JSON.stringify(back)}`);
  }
  assert.deepEqual(pointOf('#ffffff').d, 0, 'whiter than the centre: the centre');
  assert.deepEqual(pointOf('nope'), { angle: 0, d: 0.5 });
});

test('picker: the others follow the key by the rule (complementary 180° / 120° 240°, analogous 38° / ±38°)', () => {
  const key = { angle: 100, d: 0.6 };
  assert.deepEqual(followers(key, 'complementary', 2), [{ angle: 280, d: 0.6 }]);
  assert.deepEqual(followers(key, 'complementary', 3), [{ angle: 220, d: 0.6 }, { angle: 340, d: 0.6 }]);
  assert.deepEqual(followers(key, 'analogous', 3), [{ angle: 138, d: 0.6 }, { angle: 62, d: 0.6 }]);
  assert.deepEqual(followers(key, 'analogous', 1), []);
  assert.deepEqual(OFFSETS.complementary[2], [180]);
});

test('picker: a stored background read in as it is (its colours free) until the key moves; then the others follow', () => {
  const none = stateOf(null);
  assert.deepEqual([none.key, none.colors, none.appearance, none.amount], [null, [], 'auto', 0]);
  const stored = backgroundOf({ colors: ['#f7c7d3', '#123456'], wheel: 'complementary', intensity: 0.4, texture: 'sand', amount: 0.35, appearance: 'dark' })!;
  const s = stateOf(stored);
  assert.deepEqual([s.colors, s.free, s.wheel, s.intensity, s.texture, s.amount, s.appearance], [['#f7c7d3', '#123456'], true, 'complementary', 0.4, 'sand', 0.35, 'dark']);
  assert.deepEqual(backgroundFrom(s), stored, 'opened and closed untouched: the same value');
  assert.deepEqual(knobs(s)[1], pointOf('#123456'), 'a free colour where it is');
  const moved = moveKey(s, { angle: 40, d: 0.5 });
  assert.equal(moved.free, false);
  assert.deepEqual(knobs(moved), [{ angle: 40, d: 0.5 }, { angle: 220, d: 0.5 }]);
  assert.deepEqual(moved.colors, [colorAt({ angle: 40, d: 0.5 }), colorAt({ angle: 220, d: 0.5 })]);
  const viaOther = moveKnob(moved, 1, { angle: 0, d: 0.3 });
  assert.deepEqual(viaOther.key, { angle: 180, d: 0.3 }, 'another knob dragged: the key moves so that one is there');
  assert.deepEqual(moveKey(s, { angle: -30, d: 1.4 }).key, { angle: 330, d: 1 }, 'kept on the wheel');
});

test('picker: colours added and taken away (one to three); none left: no background (or the picture alone)', () => {
  let s = stateOf(null);
  s = addColor(s);
  assert.equal(s.colors.length, 1, 'the first');
  assert.ok(s.key);
  s = addColor(addColor(s));
  assert.equal(s.colors.length, MAX_COLORS);
  assert.equal(addColor(s), s, 'not past three');
  assert.equal(s.colors[0], colorAt(s.key!), 'the key kept');
  s = removeColor(removeColor(s));
  assert.equal(s.colors.length, 1);
  const gone = removeColor(s);
  assert.deepEqual([gone.colors, backgroundFrom(gone)], [[], null], 'none: the theme\'s own');
  assert.ok(gone.key, 'its place kept, for the next one');
  assert.equal(removeColor(gone), gone);
  const picture = stateOf(backgroundOf({ colors: ['#123456'], image: { id: 'a'.repeat(64) } }));
  assert.deepEqual(backgroundFrom(removeColor(picture))?.image?.id, 'a'.repeat(64), 'a picture alone stays a background');
  const clicked = moveKey(stateOf(null), { angle: 90, d: 0.5 });
  assert.equal(clicked.colors.length, 1, 'a click on an empty field: its first colour');
});

test('picker: the rule switched, a preset (its exact colour), the slider, the dial, the appearance', () => {
  let s = addColor(moveKey(stateOf(null), { angle: 0, d: 0.5 }));
  const comp = toggleWheel(s);
  assert.equal(s.wheel, 'analogous');
  assert.deepEqual([comp.wheel, comp.colors.length, knobs(comp)[1]], ['complementary', 2, { angle: 180, d: 0.5 }]);
  s = pickPreset(s, '#0984E3');
  assert.equal(s.colors[0], '#0984e3', 'the exact colour (lowercased)');
  assert.equal(s.colors.length, 2, 'the others following it');
  assert.equal(pickPreset(s, 'nope'), s);
  assert.equal(setIntensity(s, 0.333).intensity, 0.33);
  assert.equal(setIntensity(s, 5).intensity, 1);
  assert.equal(setAmount(s, 0.47).amount, 0.45, 'twentieths');
  assert.deepEqual(TEXTURES, ['grain', 'sand', 'denim', 'tweed', 'dots', 'grid']);
  const t = cycleTexture({ ...s, texture: 'grain', amount: 0 });
  assert.deepEqual([t.texture, t.amount], ['sand', FIRST_AMOUNT], 'at 0 it starts showing');
  assert.equal(cycleTexture({ ...s, texture: 'grid', amount: 0.5 }).texture, 'grain', 'round again');
  assert.equal(cycleTexture({ ...s, texture: 'grain', amount: 0.5 }, -1).texture, 'grid');
  assert.equal(cycleTexture({ ...s, amount: 0.5 }).amount, 0.5, 'the amount kept');
  assert.equal(setAppearance(s, 'dark').appearance, 'dark');
  const saved = backgroundFrom(s)!;
  assert.deepEqual(backgroundOf(saved), saved, 'saved as the model reads it');
});

test('picker: presets: five pages of nine, the space editor\'s colours on the first', () => {
  assert.equal(PRESET_PAGES.length, 5);
  assert.ok(PRESET_PAGES.every((p) => p.length === 9 && p.every((c) => /^#[0-9a-f]{6}$/.test(c))));
  assert.deepEqual(PRESET_PAGES[0].slice(1), [...SPACE_COLORS]);
});

test('actions: Edit Theme Color opened for a space (a theme\'s button may), its value saved by Margin alone, as the model reads it', () => {
  const state = { spaces: [{ id: 'a', name: 'A', emoji: '', color: '#111111' }], tabs: {}, tabSpace: {}, activeSpaceByWindow: { 1: 'a' } } as any;
  const ctx = { hasSpace: (id: string) => id === 'a', hasTab: () => false, hasFolder: () => false, hasPin: () => false } as any;
  assert.equal(ACTIONS['space.editBackground'], 'space');
  assert.deepEqual(checkAction('space.editBackground', 'a', ctx), { ok: true });
  assert.equal(BEHAVIOR_ONLY.has('space.editBackground'), false, 'a theme\'s button may open it');
  assert.equal(BEHAVIOR_ONLY.has('space.setBackground'), true, 'only Margin saves it');
  const bg = { colors: ['#ABCDEF'], extra: 1 };
  assert.deepEqual(checkAction('space.setBackground', { space: 'a', background: bg, color: '#abcdef' }, ctx), { ok: true });
  assert.deepEqual(checkAction('space.setBackground', { space: 'a', background: null, color: null }, ctx), { ok: true });
  assert.equal(checkAction('space.setBackground', { space: 'a', background: { colors: [] }, color: null }, ctx).ok, false, 'one that reads as none: not a background');
  assert.equal(checkAction('space.setBackground', { space: 'a', background: [], color: null }, ctx).ok, false);
  assert.equal(checkAction('space.setBackground', { space: 'b', background: null, color: null }, ctx).ok, false);
  assert.deepEqual(requestFor('space.setBackground', { space: 'a', background: bg, color: '#abcdef' }, { state, ui: { windowId: 1 } } as any),
    { kind: 'send', type: 'renameSpace', payload: { spaceId: 'a', background: backgroundOf(bg), color: '#abcdef' } }, 'sent as the model reads it');
  assert.deepEqual(requestFor('space.setBackground', { space: 'a', background: null, color: null }, { state, ui: { windowId: 1 } } as any),
    { kind: 'send', type: 'renameSpace', payload: { spaceId: 'a', background: null } }, 'none: the colour as it is');
  assert.deepEqual(requestFor('space.editBackground', 'a', { state, ui: { windowId: 1 } } as any).kind, 'local');
});
