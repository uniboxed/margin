// The background picker's model (M2.9 step 4, docs/SPACE-BACKGROUNDS.md Part B §4): what Edit Theme Color edits,
// and each edit as a pure step from one picker state to the next. Pure: the Node tests run it, ui/picker/panel.ts
// draws it, ui/behaviors/background-picker.ts saves it.
//
// - The field is a hidden wheel: a point's angle round the centre is the hue, its distance from the centre the
//   lightness (the centre near white, the rim a full colour), in OKLCH. The key colour is the first knob.
// - The other colours (up to two) follow the key by the wheel's rule: complementary (180°; with three, 120° and 240°)
//   or analogous (38°; with three, 38° each way). Margin's angles: Arc's own weren't read.
// - A background read from storage keeps its colours as they are (`free`) until the key moves or the rule or count
//   changes; then the others follow again. A preset sets the key to its exact colour.
// - What's saved (`backgroundFrom`) goes through the model's own reading (extension/state/model.ts backgroundOf), so
//   the picker never sends what the library would read otherwise; none (no colour, no picture): null, the theme's own.
import { backgroundOf, BG_TEXTURES } from '../../../../extension/shared/space-background.ts';
import { hexToRgb, oklch, oklchOf, rgbToHex } from '../color.ts';
import { SPACE_COLORS } from '../behaviors/menu-items.ts';
import type { SpaceBackground } from '../../../../types/margin';

export type Wheel = SpaceBackground['wheel'];
export type Texture = SpaceBackground['texture'];
export type Appearance = SpaceBackground['appearance'];
export type Fit = NonNullable<SpaceBackground['image']>['fit'];
/** A point of the field: its angle (degrees, 0 at the right, clockwise on screen) and distance from the centre (0–1). */
export type Point = { angle: number, d: number };

export type PickerState = {
  /** The key colour's point; null with no colours. */
  key: Point | null,
  /** The colours as they are now, the key's first (0–3, `#rrggbb`). */
  colors: string[],
  /** The colours other than the key kept as read (from storage), not worked out from the key. */
  free: boolean,
  wheel: Wheel,
  intensity: number,
  texture: Texture,
  amount: number,
  appearance: Appearance,
  /** The background's picture (M2.9 step 7): its id in Margin.app's store, how it fits, where it's held. */
  image: SpaceBackground['image'] | null,
};

// The hidden wheel: lightness and chroma from the centre (Lc, Cc) to the rim (Le, Ce).
export const FIELD = Object.freeze({ Lc: 0.965, Le: 0.6, Cc: 0.025, Ce: 0.17 });
export const MAX_COLORS = 3;
/** The others' angles from the key, by rule and count (Margin's). */
export const OFFSETS: Readonly<Record<Wheel, Readonly<Record<number, readonly number[]>>>> = Object.freeze({
  complementary: Object.freeze({ 2: Object.freeze([180]), 3: Object.freeze([120, 240]) }),
  analogous: Object.freeze({ 2: Object.freeze([38]), 3: Object.freeze([38, -38]) }),
});
/** The dial's textures, in the order a click goes through them. */
export const TEXTURES: readonly Texture[] = Object.freeze([...BG_TEXTURES]);
/** The dial's steps (a twentieth: the stored amount's rounding). */
export const AMOUNT_STEPS = 20;
/** Where a texture chosen at amount 0 starts (so the change shows). */
export const FIRST_AMOUNT = 0.25;

const wrap = (a: number) => ((a % 360) + 360) % 360;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** The colour at a point of the field. */
export function colorAt(p: Point): string {
  const d = clamp01(p.d);
  return rgbToHex(oklch(FIELD.Lc - (FIELD.Lc - FIELD.Le) * d, FIELD.Cc + (FIELD.Ce - FIELD.Cc) * d, wrap(p.angle)));
}

/** Where a colour sits on the field: its hue's angle, its lightness's distance (a colour outside the field's range at the rim or centre). */
export function pointOf(hex: string): Point {
  const rgb = hexToRgb(hex);
  if (!rgb) return { angle: 0, d: 0.5 };
  const [L, , h] = oklchOf(rgb);
  return { angle: wrap(h), d: clamp01((FIELD.Lc - L) / (FIELD.Lc - FIELD.Le)) };
}

/** The others' points, following the key by the rule, for `count` colours in all. */
export function followers(key: Point, wheel: Wheel, count: number): Point[] {
  const offsets = OFFSETS[wheel][Math.min(MAX_COLORS, Math.max(1, count))] ?? [];
  return offsets.map((o) => ({ angle: wrap(key.angle + o), d: key.d }));
}

/** Each knob's point: the key's, then the others' (as read, where they're free; else by the rule). */
export function knobs(s: PickerState): Point[] {
  if (!s.key) return [];
  if (s.free) return s.colors.map((c, i) => (i === 0 ? s.key! : pointOf(c)));
  return [s.key, ...followers(s.key, s.wheel, s.colors.length)];
}

/** The colours worked out again from the key (the others by the rule). */
function follow(s: PickerState, key: Point, count: number, keyColor = colorAt(key)): PickerState {
  const others = followers(key, s.wheel, count).map(colorAt);
  return { ...s, key, colors: count > 0 ? [keyColor, ...others] : [], free: false };
}

/** The picker's state for a stored background (null: none yet: no colours). */
export function stateOf(bg: SpaceBackground | null | undefined): PickerState {
  const read = bg ? backgroundOf(bg) : null;
  if (!read) return { key: null, colors: [], free: false, wheel: 'analogous', intensity: 0.5, texture: 'grain', amount: 0, appearance: 'auto', image: null };
  return {
    key: read.colors.length ? pointOf(read.colors[0]) : null,
    colors: [...read.colors],
    free: read.colors.length > 1,
    wheel: read.wheel, intensity: read.intensity, texture: read.texture, amount: read.amount, appearance: read.appearance,
    image: read.image ?? null,
  };
}

/** What's saved for the state: the model's reading of it; null for none (no colour and no picture). */
export function backgroundFrom(s: PickerState): SpaceBackground | null {
  return backgroundOf({
    colors: s.colors, wheel: s.wheel, intensity: s.intensity, texture: s.texture, amount: s.amount, appearance: s.appearance,
    ...(s.image ? { image: s.image } : {}),
  });
}

// ---- the edits ---------------------------------------------------------------------------------------------------

/** The key moved to a point (a drag, a click on the field: the first colour when there was none). */
export function moveKey(s: PickerState, p: Point): PickerState {
  const key = { angle: wrap(p.angle), d: clamp01(p.d) };
  return follow(s, key, Math.max(1, s.colors.length));
}

/** Another knob dragged to a point: the key moves so that one is there (by the rule). */
export function moveKnob(s: PickerState, index: number, p: Point): PickerState {
  if (index <= 0 || !s.key) return moveKey(s, p);
  const offset = OFFSETS[s.wheel][s.colors.length]?.[index - 1] ?? 0;
  return moveKey(s, { angle: p.angle - offset, d: p.d });
}

/** One more colour (at most three), following the key; the first at the last key's point, or a soft one. */
export function addColor(s: PickerState): PickerState {
  if (s.colors.length >= MAX_COLORS) return s;
  if (!s.key || !s.colors.length) return follow(s, s.key ?? { angle: 30, d: 0.45 }, 1);
  return follow(s, s.key, s.colors.length + 1, s.colors[0]);
}

/** One colour fewer (the last); none left: no colours (with no picture, the theme's own). */
export function removeColor(s: PickerState): PickerState {
  if (!s.colors.length) return s;
  if (s.colors.length === 1) return { ...s, colors: [], free: false };
  return follow(s, s.key!, s.colors.length - 1, s.colors[0]);
}

/** The rule the others follow: complementary ⇄ analogous (they follow it at once). */
export function toggleWheel(s: PickerState): PickerState {
  const wheel: Wheel = s.wheel === 'analogous' ? 'complementary' : 'analogous';
  const next = { ...s, wheel };
  return s.key && s.colors.length ? follow(next, s.key, s.colors.length, s.colors[0]) : next;
}

/** A preset: the key that exact colour (the others following it). */
export function pickPreset(s: PickerState, hex: string): PickerState {
  const rgb = hexToRgb(hex);
  if (!rgb) return s;
  const exact = rgbToHex(rgb);
  return follow(s, pointOf(exact), Math.max(1, s.colors.length), exact);
}

export const setIntensity = (s: PickerState, v: number): PickerState => ({ ...s, intensity: Math.round(clamp01(v) * 100) / 100 });
/** The dial turned to a step (0–AMOUNT_STEPS). */
export const setAmount = (s: PickerState, v: number): PickerState => ({ ...s, amount: Math.round(clamp01(v) * AMOUNT_STEPS) / AMOUNT_STEPS });
export const setAppearance = (s: PickerState, appearance: Appearance): PickerState => ({ ...s, appearance });

// ---- the picture (M2.9 step 7) -------------------------------------------------------------------------------

/** How a picture fits the window, in the order the picker offers them. */
export const FITS: readonly Fit[] = Object.freeze(['cover', 'contain', 'tile']);
export const FIT_NAMES: Readonly<Record<Fit, string>> = Object.freeze({ cover: 'Fill', contain: 'Fit', tile: 'Tile' });
/** What Margin takes as a picture at most, before it's made smaller (margin-core's data::backgrounds MAX_INPUT_BYTES). */
export const PICTURE_MAX_BYTES = 40 * 1024 * 1024;

/** A picture kept by Margin.app (its id): the background's, fitting as the last one did, held at its centre. */
export function setPicture(s: PickerState, id: string): PickerState {
  if (!/^[0-9a-f]{64}$/.test(id)) return s;
  return { ...s, image: { id, fit: s.image?.fit ?? 'cover', focus: [0.5, 0.5] } };
}
/** How the picture fits (fill the window, fit in it, or tiled at its own size). */
export const setFit = (s: PickerState, fit: Fit): PickerState => (s.image && FITS.includes(fit) ? { ...s, image: { ...s.image, fit } } : s);
/** No picture (with no colours either: none, the theme's own). */
export const removePicture = (s: PickerState): PickerState => (s.image ? { ...s, image: null } : s);

/** A texture chosen; at amount 0 it starts showing (FIRST_AMOUNT). */
export function setTexture(s: PickerState, texture: Texture): PickerState {
  return TEXTURES.includes(texture) ? { ...s, texture, amount: s.amount > 0 ? s.amount : FIRST_AMOUNT } : s;
}

/** The next texture (or the one before); at amount 0 it starts showing (FIRST_AMOUNT). */
export function cycleTexture(s: PickerState, dir: 1 | -1 = 1): PickerState {
  const i = TEXTURES.indexOf(s.texture);
  const texture = TEXTURES[(i + dir + TEXTURES.length) % TEXTURES.length];
  return { ...s, texture, amount: s.amount > 0 ? s.amount : FIRST_AMOUNT };
}

// ---- presets -----------------------------------------------------------------------------------------------------

const HUES = [10, 45, 75, 105, 150, 200, 245, 290];
/** Pages of nine: Margin's own colours (the space editor's eight first), then bright, pale, deep, and greys. */
export const PRESET_PAGES: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(['#f3efe8', ...SPACE_COLORS]),
  Object.freeze(['#f1ede6', ...HUES.map((h) => rgbToHex(oklch(0.74, 0.14, h)))]),
  Object.freeze(['#ffffff', ...HUES.map((h) => rgbToHex(oklch(0.93, 0.045, h)))]),
  Object.freeze(['#3b3a38', ...HUES.map((h) => rgbToHex(oklch(0.5, 0.1, h)))]),
  Object.freeze(['#ffffff', '#e6e6e6', '#cccccc', '#b3b3b3', '#808080', '#666666', '#404040', '#262626', '#0d0d0d']),
]);

export const TEXTURE_NAMES: Readonly<Record<Texture, string>> = Object.freeze({ grain: 'Grain', sand: 'Sand', denim: 'Denim', tweed: 'Tweed', dots: 'Dots', grid: 'Grid' });
