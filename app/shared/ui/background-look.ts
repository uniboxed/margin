// A space's background as Margin draws it (M2.9, docs/SPACE-BACKGROUNDS.md Part B §2): the stored value
// (`SpaceBackground`, extension/state/model.ts backgroundOf) and the appearance it's drawn in, made into what
// ui/background.ts paints and what themes read. Pure: the Node tests run it, the page draws from it.
//
// - The ground: an opaque underlay (near-white or near-black, a touch of the key colour's hue), the colours over it at
//   the intensity's opacity (`0.14 + 0.86 × intensity`), the texture over both.
// - The colours as drawn: kept pale in light (OKLCH lightness at least 0.62), made dark in dark (0.20–0.40, chroma
//   0.85×), so text over them reads either way.
// - Their layout: one colour flat; two a 135° gradient; three a 160° gradient from the first to the third with a soft
//   radial of each at three corners. One description (`layersOf`) gives both the CSS and the colour at any point
//   (`colorAt`), so what Margin.app is told about the page's corners is what the page drew.
// - The palette themes read (`--m-fg`…): text in the key colour's hue, moved toward black (light) or white (dark)
//   until it has the contrast WCAG asks for against every part of the colours (sampled): `--m-fg` 7:1 where it
//   can, never under 4.5:1; `--m-fg-2` 4.5:1; `--m-accent` 3:1 (non-text). Under "Increase contrast" both texts 7:1.
//   Where no text gets there, the colours' opacity is lowered until it does.
import { clamp01, contrast, hexToRgb, lerp, luminance, oklch, oklchOf, over, rgbCss, rgbToHex } from './color.ts';
import type { Rgb } from './color.ts';
import type { SpaceBackground } from '../../../types/margin';

export type Appearance = 'light' | 'dark';
export type Texture = SpaceBackground['texture'];

/** A linear gradient: its CSS angle (0 up, clockwise) and stops as [colour index, place 0–1]. */
type Linear = { angle: number, stops: [number, number][] };
/** A radial wash: colour `color` at its centre (fractions of the box) fading to nothing at `end` of the ellipse (radii as fractions of the box). */
type Radial = { color: number, rx: number, ry: number, cx: number, cy: number, end: number };
/** How n colours are laid out: a flat colour (`base` null, n = 1), or a gradient with washes over it (CSS order, top first). */
type Layers = { base: Linear | null, radials: Radial[] };

export function layersOf(n: number): Layers {
  if (n <= 1) return { base: null, radials: [] };
  if (n === 2) return { base: { angle: 135, stops: [[0, 0.08], [1, 0.92]] }, radials: [] };
  return {
    base: { angle: 160, stops: [[0, 0], [2, 1]] },
    radials: [
      { color: 0, rx: 1.2, ry: 0.9, cx: 0, cy: 0, end: 0.62 },
      { color: 1, rx: 1.1, ry: 0.9, cx: 1, cy: 0.18, end: 0.6 },
      { color: 2, rx: 1.2, ry: 1, cx: 0.4, cy: 1, end: 0.66 },
    ],
  };
}

const pct = (v: number) => `${Math.round(v * 10000) / 100}%`;

/** The colour layer as CSS `background`: a colour, or gradients (each stop an exact `rgb()`, a wash fading to its own colour at alpha 0). */
export function layerCss(colors: Rgb[]): string {
  if (!colors.length) return 'none';
  const { base, radials } = layersOf(colors.length);
  if (!base) return rgbCss(colors[0]);
  const washes = radials.map((g) => `radial-gradient(${pct(g.rx)} ${pct(g.ry)} at ${pct(g.cx)} ${pct(g.cy)}, ${rgbCss(colors[g.color])} 0%, ${rgbCss(colors[g.color], 0)} ${pct(g.end)})`);
  const line = `linear-gradient(${base.angle}deg, ${base.stops.map(([c, at]) => `${rgbCss(colors[c])} ${pct(at)}`).join(', ')})`;
  return [...washes, line].join(', ');
}

/** CSS's linear gradient at (x, y) of a w × h box: the gradient line through the centre at its angle, as long as the box needs. */
function linearAt(g: Linear, colors: Rgb[], x: number, y: number, w: number, h: number): Rgb {
  const a = (g.angle * Math.PI) / 180;
  const dx = Math.sin(a), dy = -Math.cos(a);
  const length = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a)) || 1;
  const t = ((x - w / 2) * dx + (y - h / 2) * dy) / length + 0.5;
  const stops = g.stops;
  if (t <= stops[0][1]) return colors[stops[0][0]];
  for (let i = 1; i < stops.length; i++) {
    const [c, at] = stops[i];
    if (t <= at) {
      const [pc, pat] = stops[i - 1];
      return lerp(colors[pc], colors[c], at === pat ? 1 : (t - pat) / (at - pat));
    }
  }
  return colors[stops[stops.length - 1][0]];
}

/** The colour layer itself (before its opacity) at (x, y) of a w × h box. */
export function layerAt(colors: Rgb[], x: number, y: number, w: number, h: number): Rgb | null {
  if (!colors.length) return null;
  const { base, radials } = layersOf(colors.length);
  if (!base) return colors[0];
  let out = linearAt(base, colors, x, y, w, h);
  // (Painted bottom to top: the last wash in CSS order first.)
  for (let i = radials.length - 1; i >= 0; i--) {
    const g = radials[i];
    const t = Math.hypot((x - g.cx * w) / (g.rx * w), (y - g.cy * h) / (g.ry * h));
    const alpha = t >= g.end ? 0 : 1 - t / g.end;
    if (alpha > 0) out = over(colors[g.color], alpha, out);
  }
  return out;
}

/** A stored colour as it's drawn in this appearance (see the header). */
export function drawnColor(hex: string, appearance: Appearance): Rgb | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [L, C, h] = oklchOf(rgb);
  return appearance === 'light' ? oklch(Math.max(L, 0.62), C, h) : oklch(0.2 + Math.max(0, L - 0.55) * 0.45, C * 0.85, h);
}

/** The appearance a background is drawn in: its own, or (automatic) the system's. */
export function appearanceOf(bg: SpaceBackground | null | undefined, systemDark: boolean): Appearance {
  return bg?.appearance === 'light' || bg?.appearance === 'dark' ? bg.appearance : systemDark ? 'dark' : 'light';
}

/** How much of each texture the dial's amount gives (the tiles are drawn faint already; dots and grid are lines in `--m-fg`). */
const TEXTURE_K: Record<Texture, number> = { grain: 1, sand: 1, denim: 1, tweed: 1, dots: 0.35, grid: 0.18 };

export type Palette = { fg: Rgb, fg2: Rgb, accent: Rgb, hover: string, selected: string };

export type Look = {
  appearance: Appearance,
  underlay: Rgb,
  /** The colours as drawn (0–3). */
  colors: Rgb[],
  /** The colours' opacity over the underlay (lowered where the text needed it). */
  alpha: number,
  /** The colour layer's CSS `background`. */
  layer: string,
  texture: { kind: Texture, opacity: number },
  /** The background as one colour: the average of its samples. */
  flat: Rgb,
  palette: Palette,
  /** The variables themes read, each a plain CSS value (ui/sanitize.ts checkCssValue passes them). */
  vars: Record<string, string>,
};

/** The ground at (x, y) of a w × h box: the underlay, the colours over it at their opacity (no texture). */
export function groundAt(look: Pick<Look, 'underlay' | 'colors' | 'alpha'>, x: number, y: number, w: number, h: number): Rgb {
  const layer = layerAt(look.colors, x, y, w, h);
  return layer ? over(layer, look.alpha, look.underlay) : look.underlay;
}

/** The ground sampled over a w × h box (a 7 × 5 grid, its edges included): what text over it has to read against. */
function samplesOf(look: Pick<Look, 'underlay' | 'colors' | 'alpha'>, w: number, h: number): Rgb[] {
  const out: Rgb[] = [];
  for (let j = 0; j < 5; j++) for (let i = 0; i < 7; i++) out.push(groundAt(look, (i / 6) * w, (j / 4) * h, w, h));
  return out;
}

const worst = (fg: Rgb, grounds: Rgb[]) => Math.min(...grounds.map((g) => contrast(fg, g)));

/**
 * From [L, C, h], lightness moved toward black (`down`) or white a hundredth at a time until the colour has `target`
 * against every ground; the extreme when none does.
 */
function toward([L, C, h]: [number, number, number], down: boolean, grounds: Rgb[], target: number): Rgb {
  for (let l = L; down ? l >= 0 : l <= 1; l = Math.round((down ? l - 0.01 : l + 0.01) * 100) / 100) {
    const c = oklch(l, C, h);
    if (worst(c, grounds) >= target) return c;
  }
  return oklch(down ? 0 : 1, 0, h);
}

/**
 * Everything a background is drawn from, in an appearance. `size`: the window's (the colours' layout depends on its
 * proportions; the contrast is checked over it). `moreContrast`: the system's "Increase contrast".
 */
export function lookOf(bg: SpaceBackground, appearance: Appearance, { moreContrast = false, size = { width: 1440, height: 900 } }: { moreContrast?: boolean, size?: { width: number, height: number } } = {}): Look {
  const colors = (bg.colors ?? []).map((c) => drawnColor(c, appearance)).filter((c): c is Rgb => !!c).slice(0, 3);
  const keyHex = bg.colors?.[0];
  const key = keyHex ? hexToRgb(keyHex) : null;
  const [, keyC, keyH] = key ? oklchOf(key) : [0, 0, 0];
  const dark = appearance === 'dark';
  const underlay = dark ? oklch(0.17, Math.min(keyC, 0.008), keyH) : oklch(0.975, Math.min(keyC, 0.006), keyH);
  const w = Math.max(1, size.width), h = Math.max(1, size.height);
  const need = moreContrast ? 7 : 4.5;
  // The text and its contrast, the colours' opacity lowered (a twentieth at a time) until the text reads.
  let alpha = colors.length ? clamp01(0.14 + 0.86 * clamp01(bg.intensity)) : 0;
  let grounds: Rgb[];
  let fg: Rgb;
  for (;;) {
    grounds = samplesOf({ underlay, colors, alpha }, w, h);
    fg = toward(dark ? [0.96, Math.min(keyC, 0.02), keyH] : [0.26, Math.min(keyC, 0.05), keyH], !dark, grounds, 7);
    if (worst(fg, grounds) >= need || alpha <= 0) break;
    alpha = Math.max(0, Math.round((alpha - 0.05) * 100) / 100);
  }
  const fg2 = toward(dark ? [0.8, Math.min(keyC, 0.04), keyH] : [0.45, Math.min(keyC, 0.06), keyH], !dark, grounds, need);
  const accent = toward(dark ? [0.78, Math.max(Math.min(keyC, 0.16), 0.08), keyH] : [0.52, Math.max(Math.min(keyC, 0.2), 0.1), keyH], !dark, grounds, 3);
  const fills = dark ? (moreContrast ? [0.14, 0.26] : [0.08, 0.16]) : (moreContrast ? [0.55, 0.95] : [0.3, 0.85]);
  const white = { r: 1, g: 1, b: 1 };
  const palette: Palette = { fg, fg2, accent, hover: rgbCss(white, fills[0]), selected: rgbCss(white, fills[1]) };
  const n = grounds.length;
  const flat = grounds.reduce((s, g) => ({ r: s.r + g.r / n, g: s.g + g.g / n, b: s.b + g.b / n }), { r: 0, g: 0, b: 0 });
  const opacity = clamp01(bg.amount) * TEXTURE_K[bg.texture];
  return {
    appearance, underlay, colors, alpha, layer: layerCss(colors),
    texture: { kind: bg.texture, opacity: Math.round(opacity * 1000) / 1000 },
    flat, palette,
    vars: {
      '--m-bg': rgbToHex(flat),
      '--m-fg': rgbToHex(fg),
      '--m-fg-2': rgbToHex(fg2),
      '--m-accent': rgbToHex(accent),
      '--m-hover': palette.hover,
      '--m-selected': palette.selected,
    },
  };
}

/** Which of the samples' extremes a text colour has to read against (for the tests: the darkest and the lightest). */
export function groundRange(look: Look, size = { width: 1440, height: 900 }) {
  const g = samplesOf(look, Math.max(1, size.width), Math.max(1, size.height));
  const lums = g.map(luminance);
  return { darkest: g[lums.indexOf(Math.min(...lums))], lightest: g[lums.indexOf(Math.max(...lums))] };
}
