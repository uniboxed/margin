// Edit Theme Color in a theme (M2.9 step 5b: a theme's `background-picker` part, themes README "Edit Theme Color"):
// Margin's elements a theme places in it, and the values their attributes take. One list for the sanitizer (what a
// theme may write: ui/sanitize.ts) and the controls (what Margin builds: ui/picker/controls.ts). Pure, no DOM.

/** The slot the part goes in, the part's name. */
export const PICKER_SLOT = 'm-picker';
export const PICKER_PART = 'background-picker';
/** Margin's controls in it: the field, a slider, the dial. */
export const PICKER_FIELD = 'm-picker-field';
export const PICKER_SLIDER = 'm-picker-slider';
export const PICKER_DIAL = 'm-picker-dial';
/** The field's variants (`m-variant`): the hidden wheel's dots left to the theme, the wheel shown, a grid of cells. */
export const FIELD_VARIANTS = Object.freeze(['dots', 'wheel', 'cells'] as const);
/** A slider's value (`m-value`) and its variants (`m-variant`). */
export const SLIDER_VALUES = Object.freeze(['intensity', 'amount'] as const);
export const SLIDER_VARIANTS = Object.freeze(['wave', 'bar'] as const);
export type FieldVariant = typeof FIELD_VARIANTS[number];
export type SliderValue = typeof SLIDER_VALUES[number];
export type SliderVariant = typeof SLIDER_VARIANTS[number];

/** What each of Margin's picker elements takes, and its values (the first: what an unknown or missing one is). */
export const PICKER_ATTRS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  [PICKER_FIELD]: Object.freeze({ 'm-variant': FIELD_VARIANTS }),
  [PICKER_SLIDER]: Object.freeze({ 'm-value': SLIDER_VALUES, 'm-variant': SLIDER_VARIANTS }),
  [PICKER_DIAL]: Object.freeze({}),
});

/** An attribute's value as Margin reads it: one of its values, else the first (the default). */
export function pickerAttr(element: string, name: string, value: string | null): string {
  const values = PICKER_ATTRS[element]?.[name];
  if (!values) return '';
  return value && values.includes(value) ? value : values[0];
}
