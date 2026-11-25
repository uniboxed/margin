// The tiles of a space background's textures (M2.9: the dial's grain, sand, denim and tweed): Margin's own, drawn
// here on a canvas, none taken from another browser. Each is a square of black and white specks at low alpha, so it
// darkens and lightens whatever colour is under it; it repeats seamlessly (a speck over an edge is drawn on the other
// side too). The noise is seeded, so every load draws the same tile (and the theme tests see the same pixels). Dots
// and grid aren't tiles: CSS gradients in the text's colour (ui/background.ts).
//
// A tile is a PNG `data:` URL (the overlay's policy allows `img-src data:`), made the first time a texture is shown
// and kept for the document.

export type TileTexture = 'grain' | 'sand' | 'denim' | 'tweed';

/** The tile's side in pixels (drawn) and as shown (CSS pixels: twice as fine on a Retina screen). */
const SIDE = 240;
export const TILE_SIZE: Record<TileTexture, number> = { grain: 120, sand: 120, denim: 120, tweed: 160 };

/** mulberry32: the same numbers for a seed everywhere. */
function seeded(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ctx = CanvasRenderingContext2D;

/** Each pixel a speck: `value(x, y)` in −1…1, negative black, positive white, its size the alpha. */
function specks(ctx: Ctx, value: (x: number, y: number) => number) {
  const img = ctx.createImageData(SIDE, SIDE);
  const d = img.data;
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const v = Math.max(-1, Math.min(1, value(x, y)));
      const i = (y * SIDE + x) * 4;
      const c = v > 0 ? 255 : 0;
      d[i] = c; d[i + 1] = c; d[i + 2] = c; d[i + 3] = Math.round(Math.abs(v) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** A shape drawn at (x, y) and again across each edge it might cross, so the tile repeats without a seam. */
function wrapped(x: number, y: number, draw: (x: number, y: number) => void) {
  for (const dx of [-SIDE, 0, SIDE]) for (const dy of [-SIDE, 0, SIDE]) draw(x + dx, y + dy);
}

const DRAW: Record<TileTexture, (ctx: Ctx, rnd: () => number) => void> = {
  // Fine, even noise.
  grain(ctx, rnd) {
    const g = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
    specks(ctx, () => g() * 0.4);
  },
  // Faint noise with grains of a few sizes over it.
  sand(ctx, rnd) {
    const g = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
    specks(ctx, () => g() * 0.14);
    for (let i = 0; i < 1500; i++) {
      const x = rnd() * SIDE, y = rnd() * SIDE, r = 0.5 + rnd() ** 2 * 1.3, a = 0.1 + rnd() * 0.32;
      ctx.fillStyle = rnd() < 0.55 ? `rgba(0,0,0,${a})` : `rgba(255,255,255,${a})`;
      wrapped(x, y, (px, py) => { ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill(); });
    }
  },
  // A twill: diagonal ribs every 6 px, a weft across them, uneven threads along them.
  denim(ctx, rnd) {
    const g = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
    const raw = Array.from({ length: SIDE }, () => rnd() * 2 - 1);
    const slub = raw.map((_, i) => { let s = 0; for (let k = -5; k <= 5; k++) s += raw[(i + k + SIDE) % SIDE]; return (s / 11) * 1.8; });
    specks(ctx, (x, y) => 0.3 * Math.sin((2 * Math.PI * (x + y)) / 6) + 0.08 * Math.sin((2 * Math.PI * x) / 3) + slub[(((x - y) % SIDE) + SIDE) % SIDE] * 0.22 + g() * 0.15);
  },
  // A basket weave of 4 px blocks, with flecks of light and dark through it.
  tweed(ctx, rnd) {
    const g = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
    specks(ctx, (x, y) => {
      const across = (((x >> 2) + (y >> 2)) & 1) === 0;
      return (across ? ((y & 3) < 2 ? 0.2 : -0.16) : ((x & 3) < 2 ? 0.2 : -0.16)) + g() * 0.28;
    });
    for (let i = 0; i < 170; i++) {
      const x = rnd() * SIDE, y = rnd() * SIDE, rx = 0.8 + rnd() * 1.6, ry = 0.6 + rnd() * 0.9, turn = rnd() * Math.PI;
      ctx.fillStyle = rnd() < 0.5 ? `rgba(255,255,255,${0.35 + rnd() * 0.3})` : `rgba(0,0,0,${0.3 + rnd() * 0.25})`;
      wrapped(x, y, (px, py) => { ctx.beginPath(); ctx.ellipse(px, py, rx, ry, turn, 0, Math.PI * 2); ctx.fill(); });
    }
  },
};

const SEEDS: Record<TileTexture, number> = { grain: 0x6a11, sand: 0x5a4d, denim: 0xde41, tweed: 0x7eed };
const made = new WeakMap<Document, Map<TileTexture, string>>();

/** The tile's `data:` URL, drawn the first time this document asks; null where there's no canvas to draw on. */
export function tileUrl(doc: Document, kind: TileTexture): string | null {
  let mine = made.get(doc);
  if (!mine) { mine = new Map(); made.set(doc, mine); }
  const kept = mine.get(kind);
  if (kept) return kept;
  const canvas = doc.createElement('canvas');
  canvas.width = SIDE;
  canvas.height = SIDE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  DRAW[kind](ctx, seeded(SEEDS[kind]));
  const url = canvas.toDataURL('image/png');
  mine.set(kind, url);
  return url;
}
