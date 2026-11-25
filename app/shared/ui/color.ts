// Colour arithmetic for what Margin draws itself (a space's background: ui/background-look.ts): sRGB and OKLCH
// (Björn Ottosson's OKLab, in polar form), a colour brought into sRGB by lowering its chroma, WCAG 2's relative
// luminance and contrast ratio, and mixing as browsers mix (in gamma-encoded sRGB). Pure: the Node tests run it.

/** A colour in sRGB, each channel gamma-encoded, 0–1. */
export type Rgb = { r: number, g: number, b: number };

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

const HEX6 = /^#[0-9a-f]{6}$/i;

/** `#rrggbb` (either case); null for anything else. */
export function hexToRgb(hex: string): Rgb | null {
  if (typeof hex !== 'string' || !HEX6.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

const byte = (v: number) => Math.round(clamp01(v) * 255);

/** `#rrggbb`, lowercase, each channel rounded to the nearest of 256. */
export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((v) => byte(v).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The colour as CSS `rgb(r, g, b)` (or `rgba(r, g, b, a)` below full opacity), whole bytes: what browsers compute and
 * what Margin.app reads a colour from (app/shared/core/src/page/fill.rs `color`).
 */
export function rgbCss({ r, g, b }: Rgb, alpha = 1): string {
  const a = clamp01(alpha);
  return a >= 1 ? `rgb(${byte(r)}, ${byte(g)}, ${byte(b)})` : `rgba(${byte(r)}, ${byte(g)}, ${byte(b)}, ${Math.round(a * 1000) / 1000})`;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** [L, C, h]: OKLCH of an sRGB colour; h in degrees, 0–360 (0 for a grey). */
export function oklchOf({ r, g, b }: Rgb): [number, number, number] {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const C = Math.hypot(A, B);
  let h = C < 1e-7 ? 0 : (Math.atan2(B, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, C, h];
}

/** Linear sRGB of an OKLCH colour, possibly outside 0–1 (out of gamut). */
function linearOf(L: number, C: number, h: number): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

const inGamut = (c: [number, number, number]) => c.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

/**
 * An OKLCH colour in sRGB. L is clamped to 0–1 and C to 0 or more; a colour sRGB can't show keeps its lightness and
 * hue, its chroma lowered (by halving) to the most sRGB has.
 */
export function oklch(L: number, C: number, h: number): Rgb {
  const l = clamp01(L);
  let c = Math.max(0, C);
  let lin = linearOf(l, c, h);
  if (!inGamut(lin)) {
    let lo = 0, hi = c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(linearOf(l, mid, h))) lo = mid; else hi = mid;
    }
    c = lo;
    lin = linearOf(l, c, h);
  }
  return { r: clamp01(toGamma(clamp01(lin[0]))), g: clamp01(toGamma(clamp01(lin[1]))), b: clamp01(toGamma(clamp01(lin[2]))) };
}

/** WCAG 2's relative luminance. */
export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2's contrast ratio, 1–21. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `top` at `alpha` over the opaque `under`, as browsers composite (in gamma-encoded sRGB). */
export function over(top: Rgb, alpha: number, under: Rgb): Rgb {
  const a = clamp01(alpha);
  return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a) };
}

/** From `a` to `b` at `t` (0–1), in gamma-encoded sRGB: how a gradient between opaque colours goes. */
export function lerp(a: Rgb, b: Rgb, t: number): Rgb {
  const u = clamp01(t);
  return { r: a.r + (b.r - a.r) * u, g: a.g + (b.g - a.g) * u, b: a.b + (b.b - a.b) * u };
}
