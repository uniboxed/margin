// Edit Theme Color drawn by a theme (M2.9 step 5b, themes README "Edit Theme Color"): what its `background-picker`
// part reads (`picker` in the view model) and what each of its items does when a theme's button runs it
// (`picker.run` with the item's id, checked against the open picker's items as `menu.run` is). Every word is Margin's
// (the part is guarded: ui/sanitize.ts GUARDED_PARTS). The field, the sliders and the dial aren't items: they're
// Margin's elements, worked by ui/picker/controls.ts. Pure: the Node tests run it, ui/picker/part.ts shows it.
import { MAX_COLORS, PRESET_PAGES, TEXTURES, TEXTURE_NAMES, addColor, cycleTexture, pickPreset, removeColor, setAmount, setAppearance, setIntensity, setTexture, toggleWheel } from './model.ts';
import type { Appearance, PickerState, Texture } from './model.ts';
import { WORDS } from './words.ts';
import type { TickKind } from './words.ts';

/** What the runtime keeps while a theme's picker is open (ui state `picker`). */
export type PickerUi = { spaceId: string, state: PickerState, page: number, all: boolean };

const APPEARANCES: readonly Appearance[] = Object.freeze(['auto', 'light', 'dark']);
const SHORT: Readonly<Record<Appearance, string>> = Object.freeze({ auto: 'Auto', light: 'Light', dark: 'Dark' });
/** The amounts a theme may offer as buttons (percent), and the intensity's steps (tenths). */
export const AMOUNTS = Object.freeze([0, 25, 50, 75, 100]);
export const INTENSITY_STEPS = Object.freeze([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
const pct = (v: number) => Math.round(v * 100);

/** The page of presets a state's key colour is on (the first, if none). */
export function pageOf(state: PickerState) {
  return Math.max(0, PRESET_PAGES.findIndex((p) => !!state.colors[0] && p.includes(state.colors[0])));
}

/** The view model's `picker` for a theme's part. */
export function pickerView(ui: PickerUi) {
  const s = ui.state;
  const page = ((ui.page % PRESET_PAGES.length) + PRESET_PAGES.length) % PRESET_PAGES.length;
  const count = s.colors.length;
  const textureName = TEXTURE_NAMES[s.texture];
  return {
    title: WORDS.title,
    appearanceLabel: 'Appearance',
    appearanceNote: WORDS.appearanceNote,
    appearances: APPEARANCES.map((a) => ({ id: `appearance:${a}`, value: a, label: WORDS[a], short: SHORT[a], selected: s.appearance === a })),
    empty: count === 0,
    emptyLabel: WORDS.empty,
    fieldLabel: WORDS.field,
    colors: {
      count,
      countLabel: `${count} ${count === 1 ? 'color' : 'colors'}`,
      add: { id: 'colors:add', label: WORDS.add, disabled: count >= MAX_COLORS },
      remove: { id: 'colors:remove', label: WORDS.remove, disabled: count === 0 },
      hasRule: count > 1,
      rule: { id: 'colors:rule', label: WORDS.wheel, text: s.wheel === 'complementary' ? WORDS.complementary : WORDS.analogous, complementary: s.wheel === 'complementary' },
    },
    presetsLabel: WORDS.presets,
    presets: PRESET_PAGES[page].map((c, i) => ({ id: `preset:${i}`, color: c, label: `${WORDS.preset} ${c}`, selected: count > 0 && s.colors[0] === c })),
    prev: { id: 'presets:prev', label: WORDS.prev },
    next: { id: 'presets:next', label: WORDS.next },
    intensity: {
      label: WORDS.intensity, value: pct(s.intensity), text: `${pct(s.intensity)}%`,
      steps: INTENSITY_STEPS.map((v) => ({ id: `intensity:${v}`, value: v, label: `${WORDS.intensity} ${v}%`, on: pct(s.intensity) >= v, selected: pct(s.intensity) === v })),
    },
    texture: {
      label: WORDS.texture, hint: WORDS.textureHint, amountLabel: WORDS.amount,
      value: s.texture, name: textureName, amount: pct(s.amount), amountText: `${pct(s.amount)}%`, text: `${textureName}, ${pct(s.amount)}%`, showing: s.amount > 0,
      prev: { id: 'texture:prev', label: `${WORDS.texture}: the one before` },
      next: { id: 'texture:next', label: `${WORDS.texture}: the next` },
    },
    textures: TEXTURES.map((t) => ({ id: `texture:${t}`, value: t, label: TEXTURE_NAMES[t], current: s.texture === t, selected: s.texture === t && s.amount > 0 })),
    amounts: AMOUNTS.map((v) => ({ id: `amount:${v}`, value: v, label: v === 0 ? 'Off' : `${v}%`, selected: pct(s.amount) === v })),
    all: { id: 'all', label: ui.all ? WORDS.allDone : WORDS.all },
    done: { id: 'done', label: WORDS.done },
  };
}
export type PickerVm = ReturnType<typeof pickerView>;

/** Every item a theme's button may run while the picker is open (`picker.run`'s check). */
export function pickerItemIds(vm: PickerVm): string[] {
  return [
    ...vm.appearances.map((a) => a.id),
    ...(vm.colors.add.disabled ? [] : [vm.colors.add.id]), ...(vm.colors.remove.disabled ? [] : [vm.colors.remove.id]),
    ...(vm.colors.hasRule ? [vm.colors.rule.id] : []),
    ...vm.presets.map((p) => p.id), vm.prev.id, vm.next.id,
    ...vm.intensity.steps.map((v) => v.id),
    ...vm.textures.map((t) => t.id), vm.texture.prev.id, vm.texture.next.id,
    ...vm.amounts.map((a) => a.id),
    vm.all.id, vm.done.id,
  ];
}

/**
 * What an item does: a new state committed (`commit`, with the detent it ticks), another page of presets (`page`),
 * Use for All Spaces (`all`), Done (`done`); null for an id that isn't one.
 */
export function runItem(ui: PickerUi, id: string):
  | { kind: 'commit', state: PickerState, tick: TickKind } | { kind: 'page', page: number } | { kind: 'all' } | { kind: 'done' } | null {
  const s = ui.state;
  const [what, arg] = id.split(':') as [string, string | undefined];
  const num = (text: string | undefined) => (text !== undefined && /^\d{1,3}$/.test(text) ? Number(text) : NaN);
  switch (what) {
    case 'appearance':
      return APPEARANCES.includes(arg as Appearance) ? { kind: 'commit', state: setAppearance(s, arg as Appearance), tick: 'appearance' } : null;
    case 'colors':
      if (arg === 'add') return s.colors.length < MAX_COLORS ? { kind: 'commit', state: addColor(s), tick: 'step' } : null;
      if (arg === 'remove') return s.colors.length ? { kind: 'commit', state: removeColor(s), tick: 'step' } : null;
      if (arg === 'rule') return s.colors.length > 1 ? { kind: 'commit', state: toggleWheel(s), tick: 'step' } : null;
      return null;
    case 'preset': {
      const color = PRESET_PAGES[((ui.page % PRESET_PAGES.length) + PRESET_PAGES.length) % PRESET_PAGES.length][num(arg)];
      return color ? { kind: 'commit', state: pickPreset(s, color), tick: 'step' } : null;
    }
    case 'presets':
      if (arg === 'prev' || arg === 'next') return { kind: 'page', page: (ui.page + (arg === 'next' ? 1 : -1) + PRESET_PAGES.length) % PRESET_PAGES.length };
      return null;
    case 'texture':
      if (arg === 'next' || arg === 'prev') return { kind: 'commit', state: cycleTexture(s, arg === 'next' ? 1 : -1), tick: 'texture' };
      return TEXTURES.includes(arg as Texture) ? { kind: 'commit', state: setTexture(s, arg as Texture), tick: 'texture' } : null;
    case 'amount': {
      const v = num(arg);
      return AMOUNTS.includes(v) ? { kind: 'commit', state: setAmount(s, v / 100), tick: 'detent' } : null;
    }
    case 'intensity': {
      const v = num(arg);
      return INTENSITY_STEPS.includes(v) ? { kind: 'commit', state: setIntensity(s, v / 100), tick: 'detent' } : null;
    }
    case 'all': return arg === undefined ? { kind: 'all' } : null;
    case 'done': return arg === undefined ? { kind: 'done' } : null;
    default: return null;
  }
}
