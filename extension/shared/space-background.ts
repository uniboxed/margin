// A space's background (M2.9, Edit Theme Color: docs/SPACE-BACKGROUNDS.md), read from anything: colours `#rrggbb`
// (lowercased, the first three), the rest each its default when it isn't one of its values, numbers clamped to 0–1 and
// rounded (intensity to 0.01, amount to 0.05, a picture's focus to 0.001), a picture only with a SHA-256 id; null when
// it has neither a colour nor a picture (none: the theme's own). Keys in this order. margin-core's twin:
// library/state.rs background_of, which the shared vectors hold to this.
// Here so the UI (the picker, its action) reads it without loading the model: tests/layering.test.ts. Pure, no browser
// APIs. state/model.ts takes it from here (one copy).
import type { SpaceBackground } from '../../types/margin';

export const BG_WHEELS = ['complementary', 'analogous'] as const;
export const BG_TEXTURES = ['grain', 'sand', 'denim', 'tweed', 'dots', 'grid'] as const;
export const BG_APPEARANCES = ['auto', 'light', 'dark'] as const;
export const BG_FITS = ['cover', 'contain', 'tile'] as const;
const BG_HEX = /^#[0-9a-f]{6}$/i;
const BG_IMAGE_ID = /^[0-9a-f]{64}$/;
const bgObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown, or: T): T => ((list as readonly unknown[]).includes(v) ? v as T : or);
// 0–1 in steps of 1/steps (`v > 0 ? …` so -0 reads as 0), `or` for what isn't a finite number.
const unit = (v: unknown, or: number, steps: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round((v > 0 ? (v > 1 ? 1 : v) : 0) * steps) / steps : or);

export function backgroundOf(v: unknown): SpaceBackground | null {
  if (!bgObject(v)) return null;
  const colors = Array.isArray(v.colors) ? v.colors.filter((c: unknown): c is string => typeof c === 'string' && BG_HEX.test(c)).slice(0, 3).map((c: string) => c.toLowerCase()) : [];
  const i = v.image;
  const image = bgObject(i) && typeof i.id === 'string' && BG_IMAGE_ID.test(i.id)
    ? { id: i.id, fit: oneOf(BG_FITS, i.fit, 'cover'), focus: (Array.isArray(i.focus) && i.focus.length === 2 ? [unit(i.focus[0], 0.5, 1000), unit(i.focus[1], 0.5, 1000)] : [0.5, 0.5]) as [number, number] }
    : null;
  if (!colors.length && !image) return null;
  return {
    colors,
    wheel: oneOf(BG_WHEELS, v.wheel, 'analogous'),
    intensity: unit(v.intensity, 0.5, 100),
    texture: oneOf(BG_TEXTURES, v.texture, 'grain'),
    amount: unit(v.amount, 0, 20),
    appearance: oneOf(BG_APPEARANCES, v.appearance, 'auto'),
    ...(image ? { image } : {}),
  };
}
