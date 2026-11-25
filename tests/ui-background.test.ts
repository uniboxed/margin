// A space's background as Margin draws it (M2.9, docs/SPACE-BACKGROUNDS.md Part B §2): the colour arithmetic
// (ui/color.ts), what a background is drawn from (ui/background-look.ts: the colours as drawn, their layout as CSS and
// as a colour at any point, the palette's contrast), the page card cut out of it and the variables' sheet
// (ui/background.ts), and the page's corners told from it (ui/host-app.ts cornerFill's `ground`). The drawing itself
// is tests/theme/background.test.ts's, in the browsers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, hexToRgb, luminance, oklch, oklchOf, over, rgbCss, rgbToHex } from '../app/shared/ui/color.ts';
import { appearanceOf, drawnColor, groundAt, groundRange, layerAt, layerCss, lookOf } from '../app/shared/ui/background-look.ts';
import { backgroundCss, cutOut } from '../app/shared/ui/background.ts';
import { cornerFill } from '../app/shared/ui/host-app.ts';
import { checkCssValue } from '../app/shared/ui/sanitize.ts';
import { backgroundOf } from '../extension/state/model.ts';
import type { SpaceBackground } from '../types/margin.d.ts';

const bg = (v: Record<string, unknown>) => backgroundOf(v) as SpaceBackground;
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

test('color: hex, OKLCH there and back, sRGB\'s gamut kept, WCAG\'s luminance and contrast, mixing as browsers mix', () => {
  assert.deepEqual(hexToRgb('#FF8000'), { r: 1, g: 128 / 255, b: 0 });
  assert.equal(hexToRgb('#fff'), null, '#rrggbb only');
  assert.equal(rgbToHex({ r: 1, g: 0.5, b: 0 }), '#ff8000');
  assert.equal(rgbToHex({ r: 1.2, g: -0.1, b: 0.5 }), '#ff0080', 'clamped');
  assert.equal(rgbCss({ r: 1, g: 0, b: 0.5 }), 'rgb(255, 0, 128)');
  assert.equal(rgbCss({ r: 1, g: 0, b: 0.5 }, 0.25), 'rgba(255, 0, 128, 0.25)');
  for (const hex of ['#f7c7d3', '#0984e3', '#00b894', '#000000', '#ffffff', '#6c5ce7']) {
    const [L, C, h] = oklchOf(hexToRgb(hex)!);
    assert.equal(rgbToHex(oklch(L, C, h)), hex, `${hex} there and back`);
  }
  assert.ok(near(oklchOf({ r: 1, g: 1, b: 1 })[0], 1, 1e-4) && near(oklchOf({ r: 0, g: 0, b: 0 })[0], 0, 1e-9));
  const loud = oklch(0.7, 0.4, 145); // far outside sRGB: its chroma lowered, its lightness and hue kept
  assert.ok([loud.r, loud.g, loud.b].every((v) => v >= 0 && v <= 1));
  assert.ok(near(oklchOf(loud)[0], 0.7, 0.01) && near(oklchOf(loud)[2], 145, 1.5));
  assert.ok(near(luminance({ r: 1, g: 1, b: 1 }), 1) && near(contrast({ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 }), 21));
  assert.deepEqual(over({ r: 1, g: 0, b: 0 }, 0.25, { r: 0, g: 0, b: 1 }), { r: 0.25, g: 0, b: 0.75 });
});

test('background-look: the colours\' layout, as CSS and as the colour at a point (one description for both)', () => {
  const a = hexToRgb('#ff0000')!, b = hexToRgb('#0000ff')!, c = hexToRgb('#00ff00')!;
  assert.equal(layerCss([]), 'none');
  assert.equal(layerCss([a]), 'rgb(255, 0, 0)');
  assert.equal(layerCss([a, b]), 'linear-gradient(135deg, rgb(255, 0, 0) 8%, rgb(0, 0, 255) 92%)');
  const three = layerCss([a, b, c]);
  assert.equal((three.match(/radial-gradient\(/g) ?? []).length, 3, 'three washes');
  assert.match(three, /^radial-gradient\(120% 90% at 0% 0%, rgb\(255, 0, 0\) 0%, rgba\(255, 0, 0, 0\) 62%\), /, 'each wash fades to its own colour, unseen');
  assert.match(three, /linear-gradient\(160deg, rgb\(255, 0, 0\) 0%, rgb\(0, 255, 0\) 100%\)$/, 'over a gradient from the first to the third');
  // 135°: the top left corner is the gradient line's start (before 8%: the first colour), the bottom right its end.
  assert.deepEqual(layerAt([a, b], 0, 0, 1440, 900), a);
  assert.deepEqual(layerAt([a, b], 1440, 900, 1440, 900), b);
  const mid = layerAt([a, b], 720, 450, 1440, 900)!;
  assert.ok(near(mid.r, 0.5) && near(mid.b, 0.5), 'the middle: half way');
  assert.deepEqual(layerAt([a], 3, 4, 10, 10), a);
  assert.equal(layerAt([], 0, 0, 10, 10), null);
  // Three: a corner is mostly its wash; outside every wash's reach, the gradient under them.
  const tl = layerAt([a, b, c], 0, 0, 1440, 900)!;
  assert.ok(tl.r > 0.99 && tl.g < 0.01 && tl.b < 0.01, 'the top left: the first colour, its wash at full');
  const ground = groundAt({ underlay: { r: 1, g: 1, b: 1 }, colors: [a], alpha: 0.5 }, 10, 10, 100, 100);
  assert.deepEqual(ground, { r: 1, g: 0.5, b: 0.5 }, 'the colours over the underlay at their opacity');
});

test('background-look: colours drawn pale in light and dark in dark; the appearance its own or the system\'s', () => {
  for (const hex of ['#ff0000', '#0984e3', '#111111', '#f7c7d3', '#ffffff']) {
    assert.ok(oklchOf(drawnColor(hex, 'light')!)[0] >= 0.62 - 1e-3, `${hex} light`);
    const L = oklchOf(drawnColor(hex, 'dark')!)[0];
    assert.ok(L >= 0.2 - 1e-3 && L <= 0.2 + 0.45 * 0.45 + 1e-3, `${hex} dark: ${L}`);
  }
  assert.equal(drawnColor('nope', 'light'), null);
  assert.equal(appearanceOf(bg({ colors: ['#111111'], appearance: 'dark' }), false), 'dark');
  assert.equal(appearanceOf(bg({ colors: ['#111111'], appearance: 'light' }), true), 'light');
  assert.equal(appearanceOf(bg({ colors: ['#111111'] }), true), 'dark', 'automatic: the system\'s');
  assert.equal(appearanceOf(bg({ colors: ['#111111'] }), false), 'light');
});

test('background-look: the palette reads over every part of the colours (WCAG): text 4.5:1 (7:1 with more contrast), the accent 3:1', () => {
  const hues = Array.from({ length: 12 }, (_, i) => i * 30);
  const pick = (L: number, C: number, h: number) => rgbToHex(oklch(L, C, h));
  let checked = 0, lowered = 0;
  for (const appearance of ['light', 'dark'] as const) {
    for (const more of [false, true]) {
      for (const h of hues) {
        for (const [L, C] of [[0.95, 0.03], [0.75, 0.15], [0.55, 0.2], [0.3, 0.1]]) {
          for (const n of [1, 2, 3]) {
            const colors = Array.from({ length: n }, (_, i) => pick(L - i * 0.1, C, (h + i * 120) % 360));
            const look = lookOf(bg({ colors, intensity: 1, texture: 'grain', amount: 0.5 }), appearance, { moreContrast: more, size: { width: 1280, height: 800 } });
            const { darkest, lightest } = groundRange(look, { width: 1280, height: 800 });
            const need = more ? 7 : 4.5;
            for (const ground of [darkest, lightest]) {
              assert.ok(contrast(look.palette.fg, ground) >= need - 1e-9, `fg ${appearance} ${more} ${colors}`);
              assert.ok(contrast(look.palette.fg2, ground) >= need - 1e-9, `fg2 ${appearance} ${more} ${colors}`);
              assert.ok(contrast(look.palette.accent, ground) >= 3 - 1e-9, `accent ${appearance} ${more} ${colors}`);
            }
            if (look.alpha < 1) lowered++;
            checked++;
            for (const [k, v] of Object.entries(look.vars)) assert.ok(checkCssValue(v), `${k}: ${v} is a plain CSS value`);
          }
        }
      }
    }
  }
  assert.equal(checked, 2 * 2 * 12 * 4 * 3);
  assert.ok(lowered > 0, 'some colours had their opacity lowered for the text');
});

test('background-look: what\'s drawn, for one background (opacity from the intensity, the texture\'s strength, the variables)', () => {
  const look = lookOf(bg({ colors: ['#f7c7d3', '#cfe8f7'], intensity: 0.5, texture: 'dots', amount: 0.5 }), 'light');
  assert.equal(look.appearance, 'light');
  assert.equal(look.colors.length, 2);
  assert.ok(near(look.alpha, 0.14 + 0.86 * 0.5), 'pale colours: the text reads at the opacity asked');
  assert.deepEqual(look.texture, { kind: 'dots', opacity: 0.175 });
  assert.deepEqual(Object.keys(look.vars), ['--m-bg', '--m-fg', '--m-fg-2', '--m-accent', '--m-hover', '--m-selected']);
  assert.match(look.vars['--m-bg'], /^#[0-9a-f]{6}$/);
  assert.equal(look.vars['--m-hover'], 'rgba(255, 255, 255, 0.3)');
  assert.ok(luminance(look.underlay) > 0.9, 'a near-white underlay');
  const dark = lookOf(bg({ colors: ['#f7c7d3'], intensity: 0 }), 'dark');
  assert.ok(luminance(dark.underlay) < 0.02, 'a near-black underlay');
  assert.ok(near(dark.alpha, 0.14), 'intensity 0: the colours faint, not gone');
  assert.deepEqual(lookOf(bg({ colors: ['#f7c7d3'], amount: 0 }), 'light').texture.opacity, 0, 'amount 0: no texture');
  const picture = lookOf(bg({ image: { id: 'a'.repeat(64) } }), 'light');
  assert.deepEqual([picture.colors, picture.alpha, picture.layer], [[], 0, 'none'], 'a picture alone: no colours (the picture is step 7\'s)');
  assert.deepEqual(lookOf(bg({ colors: ['#123456', '#abcdef'] }), 'dark'), lookOf(bg({ colors: ['#123456', '#abcdef'] }), 'dark'), 'the same every time');
});

test('background: the page card cut out of the window (rounded as drawn), the variables\' sheet checked', () => {
  assert.equal(cutOut(1000, 800, null), 'M0 0H1000V800H0Z');
  assert.equal(cutOut(1000, 800, { left: 260, top: 8, width: 732, height: 784, radii: [10, 10, 10, 10] }),
    'M0 0H1000V800H0ZM270 8H982A10 10 0 0 1 992 18V782A10 10 0 0 1 982 792H270A10 10 0 0 1 260 782V18A10 10 0 0 1 270 8Z');
  assert.equal(cutOut(100, 100, { left: 0, top: 0, width: 20, height: 10, radii: [0, 50, 0, 0] }), 'M0 0H100V100H0ZM0 0H15A5 5 0 0 1 20 5V10L20 10H0L0 10V0L0 0Z',
    'a radius no larger than half the shorter side; none: a corner');
  assert.equal(cutOut(100, 100, { left: 0, top: 0, width: 0, height: 10, radii: [] }), 'M0 0H100V100H0Z', 'no box: nothing cut');
  assert.equal(backgroundCss(null), '');
  assert.equal(backgroundCss({ '--m-bg': '#123456', '--m-fg': 'rgba(1, 2, 3, 0.5)' }), ':host,:root{--m-bg:#123456;--m-fg:rgba(1, 2, 3, 0.5)}');
  assert.equal(backgroundCss({ '--m-bg': 'url(x)', 'color': 'red', '--m-x': 'red;}*{color:red' }), '', 'only Margin\'s names, only plain values');
});

test('cornerFill with Margin\'s ground: outside the card its colour, under a sharp shadow the theme still paints the shadow\'s, inside the card as before', () => {
  const el = (style: Record<string, string>, parent: any = null) => ({ style, parentElement: parent });
  const base = { borderTopWidth: '0px', borderLeftWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderTopStyle: 'none', borderTopColor: 'rgb(0, 0, 0)', paddingTop: '0px', paddingLeft: '0px', paddingRight: '0px', paddingBottom: '0px', boxShadow: 'none', backgroundColor: 'rgba(0, 0, 0, 0)', borderTopLeftRadius: '0px', borderTopRightRadius: '0px', borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px' };
  const getStyle = (e: any) => ({ ...base, ...e.style });
  const getBox = () => ({ left: 260, top: 8, width: 1000, height: 800 });
  const radius = (r: string) => ({ borderTopLeftRadius: r, borderTopRightRadius: r, borderBottomRightRadius: r, borderBottomLeftRadius: r });
  const asked: number[][] = [];
  const ground = (x: number, y: number) => { asked.push([x, y]); return `rgb(${Math.round(x / 10)}, ${Math.round(y / 10)}, 0)`; };
  // A rounded card with no shadow left (the theme's ground gave way): each corner Margin's colour at that point of the window.
  assert.deepEqual(cornerFill(el(radius('10px')) as any, { getStyle, getBox, ground })?.fills, ['rgb(26, 1, 0)', 'rgb(126, 1, 0)', 'rgb(126, 81, 0)', 'rgb(26, 81, 0)']);
  assert.deepEqual(asked, [[260.5, 8.5], [1259.5, 8.5], [1259.5, 807.5], [260.5, 807.5]], 'asked in the window\'s pixels');
  // Neubrutalism's ink shadow still painted at the bottom right: the ink there, Margin's ground at the others.
  const nb = { borderTopWidth: '3px', borderLeftWidth: '3px', borderRightWidth: '3px', borderBottomWidth: '3px', borderTopStyle: 'solid', borderTopColor: 'rgb(17, 17, 17)', ...radius('18px'), boxShadow: 'rgb(17, 17, 17) 6px 6px 0px 0px' };
  assert.deepEqual(cornerFill(el(nb) as any, { getStyle, getBox, ground: () => 'rgb(1, 2, 3)' })?.fills, ['rgb(1, 2, 3)', 'rgb(1, 2, 3)', 'rgb(17, 17, 17)', 'rgb(1, 2, 3)']);
  // A square card: the corner points are inside it: what's behind it, as before (Margin's ground isn't under the card).
  assert.deepEqual(cornerFill(el({}, el({ backgroundColor: 'rgb(9, 9, 9)' })) as any, { getStyle, getBox, ground: () => 'rgb(1, 2, 3)' })?.fills, Array(4).fill('rgb(9, 9, 9)'));
  // None shown (null): the theme's own, as before.
  assert.deepEqual(cornerFill(el({ ...radius('10px'), boxShadow: 'rgb(40, 50, 60) 0px 0px 0px 1512px' }) as any, { getStyle, getBox, ground: () => null })?.fills, Array(4).fill('rgb(40, 50, 60)'));
});

// A picture under the colours (M2.9 step 7): its samples what text reads against, a wash of the underlay over it until
// the text reads, the colours a tint over it.
test('a picture: its samples the ground; the wash rises until the text reads; drawn as without until they\'re there', async () => {
  const { pictureAt, SAMPLES, underlayOf } = await import('../app/shared/ui/background-look.ts');
  const { pictureCss } = await import('../app/shared/ui/background.ts');
  const n = SAMPLES.cols * SAMPLES.rows;
  const flat = (c: { r: number, g: number, b: number }) => Array.from({ length: n }, () => c);
  const black = { r: 0, g: 0, b: 0 }, white = { r: 1, g: 1, b: 1 };
  const bg = backgroundOf({ colors: [], image: { id: 'a'.repeat(64) }, intensity: 0.5 })!;
  // None yet: as without a picture (the underlay, no wash).
  const none = lookOf(bg, 'light');
  assert.deepEqual([none.samples, none.wash], [null, 0]);
  assert.equal(rgbToHex(groundAt(none, 10, 10, 1440, 900)), rgbToHex(underlayOf(bg, 'light')));
  // A black picture in light: the text is dark, so the wash rises until it reads (4.5:1; 7:1 with more contrast).
  for (const [more, need] of [[false, 4.5], [true, 7]] as const) {
    const l = lookOf(bg, 'light', { picture: flat(black), moreContrast: more });
    assert.ok(l.wash > 0 && l.wash <= 0.9, `washed: ${l.wash}`);
    const g = groundAt(l, 700, 450, 1440, 900);
    assert.ok(contrast(hexToRgb(l.vars['--m-fg'])!, g) >= need - 0.01, `${more ? 'more' : 'plain'}: ${contrast(hexToRgb(l.vars['--m-fg'])!, g)}`);
  }
  // A white picture in light: dark text reads on it as it is: no wash.
  assert.equal(lookOf(bg, 'light', { picture: flat(white) }).wash, 0);
  // In dark, a white picture: washed with the dark underlay until light text reads.
  const d = lookOf(bg, 'dark', { picture: flat(white) });
  assert.ok(d.wash > 0 && contrast(hexToRgb(d.vars['--m-fg'])!, groundAt(d, 0, 0, 1440, 900)) >= 4.49);
  // Its colour at a point: the samples' grid, in proportion between them.
  const half = Array.from({ length: n }, (_, k) => (k % SAMPLES.cols === 0 ? black : white));
  assert.deepEqual(pictureAt(half, 0, 0, 1200, 800), black);
  const between = pictureAt(half, 100, 0, 1200, 800); // (half way to the second column: 1/12 of the width)
  assert.ok(Math.abs(between.r - 0.5) < 1e-9, `${between.r}`);
  assert.deepEqual(pictureAt(half, 1200, 800, 1200, 800), white);
  // The colours over it: a tint (0.6 × intensity), not the colours' own opacity.
  const tinted = lookOf(backgroundOf({ colors: ['#f7c7d3'], image: { id: 'a'.repeat(64) }, intensity: 0.5 })!, 'light', { picture: flat(white) });
  assert.equal(tinted.alpha, 0.3);
  assert.ok(Math.abs(lookOf(backgroundOf({ colors: ['#f7c7d3'], intensity: 0.5 })!, 'light').alpha - 0.57) < 1e-9, 'without a picture: as before (0.14 + 0.86 × intensity)');
  // A wrong number of samples: as without.
  assert.equal(lookOf(bg, 'light', { picture: flat(black).slice(1) }).samples, null);
  // Drawn as its fit and focus say.
  const url = `margin-app://app/background/${'a'.repeat(64)}`;
  assert.equal(pictureCss(url, { fit: 'cover', focus: [0.5, 0.25] }), `url("${url}") 50% 25% / cover no-repeat`);
  assert.equal(pictureCss(url, { fit: 'contain', focus: [0, 1] }), `url("${url}") 0% 100% / contain no-repeat`);
  assert.equal(pictureCss(url, { fit: 'tile', focus: [0.5, 0.5] }), `url("${url}") 0 0 / auto repeat`);
});
