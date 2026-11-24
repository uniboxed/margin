// A space's background, drawn by Margin under any theme (M2.9, docs/SPACE-BACKGROUNDS.md Part B §2). The theme keeps
// its own ground until the space shown has a background; then this layer is the ground, and the theme makes room for
// it (themes README, "A space's background").
//
// The layer: `<margin-background>`, in the container from the first time a background shows (before <body> in a
// document; after the theme's root in a shadow root, which stays its container's first element), fixed over the whole
// window, lowest of everything (z-index −2147483647: under every layer of the theme's, whatever its order), never
// taking the pointer, cut out of the page card's outer box (its rounded corners as drawn:
// `clip-path: path(evenodd, …)`), so the page shows through as it does through the theme's ground. Its content is in
// a closed shadow root and its host's style is pinned (`all: initial !important`, in its style attribute and from
// inside, `:host`), as ui/theme-preview.ts's bar: the theme's style sheet reaches every element of the overlay's
// document, never this. Whether it shows and its cut are set from inside too (a rule after the pin): an !important
// rule of the shadow tree's beats the host's own attribute, so the attribute can't carry them.
//
// What themes read: Margin's own style sheet (`sheet`, adopted with the theme's) sets `--m-bg`, `--m-fg`, `--m-fg-2`,
// `--m-accent`, `--m-hover` and `--m-selected` on the container while a background shows (none otherwise), every value
// a plain colour ui/sanitize.ts checkCssValue passes; ui/runtime.ts puts `m-background` and `m-appearance` on the
// theme's root.
//
// A change of space with a background to another with one cross-fades (0.3 s; at once with reduced motion); the same
// space redrawn (an edit, a drag in the picker) changes in place. To or from none it's at once (the theme's own ground
// is above this layer: nothing to fade under).
import { appearanceOf, groundAt, lookOf } from './background-look.ts';
import type { Appearance, Look } from './background-look.ts';
import { rgbCss, rgbToHex } from './color.ts';
import { checkCssValue } from './sanitize.ts';
import { TILE_SIZE, tileUrl } from './textures.ts';
import type { TileTexture } from './textures.ts';
import type { SpaceBackground } from '../../../types/margin';

const TAG = 'margin-background';
const PINNED = 'all:initial!important;position:fixed!important;inset:0!important;margin:0!important;padding:0!important;border:0!important;'
  + 'z-index:-2147483647!important;pointer-events:none!important;opacity:1!important;visibility:visible!important;overflow:hidden!important;'
  + 'transform:none!important;filter:none!important;contain:strict!important;';
const SHADOW_CSS = `:host{${PINNED}}:host::before,:host::after{display:none!important;content:none!important}
.set{position:absolute;inset:0;opacity:1;transition:opacity .3s ease}
.set.entering{opacity:0}
.set>div{position:absolute;inset:0}
.texture{background-repeat:repeat}
@media (prefers-reduced-motion:reduce){.set{transition:none}}`;
const FADE_MS = 300;

/** The page card's outer box (its border's outer edge) in the window's pixels, and its corners' radii (top left, clockwise). */
export type PageBox = { left: number, top: number, width: number, height: number, radii: number[] };

export type BackgroundInput = {
  /** The space shown (a change of space cross-fades). */
  spaceId: string,
  background: SpaceBackground | null | undefined,
  /** The system's: dark appearance, more contrast, less motion. */
  systemDark: boolean,
  moreContrast: boolean,
  reducedMotion: boolean,
};

/** The page box's outside as an even-odd path over a w × h window: the whole window, and the box (its corners rounded) taken out. */
export function cutOut(w: number, h: number, box: PageBox | null): string {
  const n = (v: number) => String(Math.round(v * 100) / 100);
  const all = `M0 0H${n(w)}V${n(h)}H0Z`;
  if (!box || box.width <= 0 || box.height <= 0) return all;
  const { left: x, top: y, width: bw, height: bh } = box;
  // Each radius at most half the box's shorter side (as CSS draws a border that can't fit its radii).
  const most = Math.min(bw, bh) / 2;
  const [tl, tr, br, bl] = [0, 1, 2, 3].map((i) => Math.max(0, Math.min(most, box.radii?.[i] ?? 0)));
  const arc = (r: number, ex: number, ey: number) => (r > 0 ? `A${n(r)} ${n(r)} 0 0 1 ${n(ex)} ${n(ey)}` : `L${n(ex)} ${n(ey)}`);
  return `${all}M${n(x + tl)} ${n(y)}H${n(x + bw - tr)}${arc(tr, x + bw, y + tr)}V${n(y + bh - br)}${arc(br, x + bw - br, y + bh)}H${n(x + bl)}${arc(bl, x, y + bh - bl)}V${n(y + tl)}${arc(tl, x + tl, y)}Z`;
}

/** The variables' style sheet text: one rule on the container, each value checked again (as theme settings are). */
export function backgroundCss(vars: Record<string, string> | null): string {
  if (!vars) return '';
  const decls = Object.entries(vars).filter(([k, v]) => /^--m-[a-z0-9-]+$/.test(k) && checkCssValue(v)).map(([k, v]) => `${k}:${v}`);
  return decls.length ? `:host,:root{${decls.join(';')}}` : '';
}

export type SpaceBackgroundLayer = ReturnType<typeof createBackground>;

export function createBackground({ doc, container }: { doc: Document, container: ShadowRoot | Document }) {
  const win = doc.defaultView!; // (a page that draws a theme has a window)
  const sheet = new win.CSSStyleSheet();
  const host = doc.createElement(TAG);
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('style', PINNED);
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = SHADOW_CSS;
  // (What changes: shown or not, and the cut; after the pin, so it wins over `all: initial`.)
  const state = doc.createElement('style');
  state.textContent = ':host{display:none!important}';
  shadow.append(style, state);
  let shown = false;
  let cut = '';
  // (Put in its container the first time one shows: the runtime's first render has drawn the theme by then.)
  const attach = () => {
    if (host.isConnected) return;
    if (container.nodeType === 9) doc.documentElement.insertBefore(host, doc.body ?? null);
    else (container as ShadowRoot).append(host);
  };

  let look: Look | null = null;
  let lastKey = '';
  let revision = 0; // what's drawn: one more at each change (shown, changed, gone)
  let shownId: string | null = null;
  let css = '';
  let box: PageBox | null = null;
  let size = { width: 0, height: 0 };
  let current: HTMLElement | null = null;
  const leaving = new Set<HTMLElement>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function makeSet() {
    const set = doc.createElement('div');
    set.className = 'set';
    for (const part of ['underlay', 'colors', 'texture']) {
      const el = doc.createElement('div');
      el.className = part;
      set.append(el);
    }
    return set;
  }

  /** Writes a look into a set, each part only where it changed (a picker's drag redraws it every frame). */
  function paint(set: HTMLElement, l: Look) {
    const [underlay, colors, texture] = [...set.children] as HTMLElement[];
    const put = (el: HTMLElement, key: string, apply: () => void) => { if (el.dataset.k !== key) { el.dataset.k = key; apply(); } };
    put(underlay, rgbToHex(l.underlay), () => { underlay.style.background = rgbToHex(l.underlay); });
    put(colors, `${l.layer}|${l.alpha}`, () => { colors.style.background = l.layer; colors.style.opacity = String(l.alpha); });
    const fg = l.vars['--m-fg'];
    const kind = l.texture.kind;
    put(texture, `${kind}|${l.texture.opacity}|${kind === 'dots' || kind === 'grid' ? fg : ''}`, () => {
      texture.style.opacity = String(l.texture.opacity);
      if (l.texture.opacity <= 0) { texture.style.background = 'none'; return; }
      if (kind === 'dots') texture.style.background = `radial-gradient(circle, ${fg} 1.15px, transparent 1.65px) 0 0 / 16px 16px`;
      else if (kind === 'grid') texture.style.background = `linear-gradient(${fg} 1px, transparent 1px) 0 0 / 22px 22px, linear-gradient(90deg, ${fg} 1px, transparent 1px) 0 0 / 22px 22px`;
      else {
        const url = tileUrl(doc, kind as TileTexture);
        texture.style.background = url ? `url("${url}") 0 0 / ${TILE_SIZE[kind as TileTexture]}px ${TILE_SIZE[kind as TileTexture]}px repeat` : 'none';
      }
    });
  }

  function writeState() {
    const text = shown ? `:host{display:block!important;clip-path:path(evenodd, "${cut}")!important}` : ':host{display:none!important}';
    if (state.textContent !== text) state.textContent = text;
  }

  function clip() {
    size = { width: win.innerWidth, height: win.innerHeight };
    cut = cutOut(size.width, size.height, box);
    writeState();
  }

  function show(on: boolean) {
    if (on) attach();
    shown = on;
    writeState();
  }

  function clearLeaving() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const el of leaving) el.remove();
    leaving.clear();
  }

  return {
    /** Margin's variables (none while no background shows), for the view's sheets. */
    sheet,
    /**
     * The space shown and its background: drawn (or hidden: none, the theme's own). The appearance it's drawn in, or
     * null with none.
     */
    update(input: BackgroundInput): Appearance | null {
      const bg = input.background ?? null;
      if (!bg) {
        if (look) revision++;
        clearLeaving();
        current?.remove();
        current = null;
        look = null;
        shownId = null;
        lastKey = '';
        show(false);
        if (css) { css = ''; sheet.replaceSync(''); }
        return null;
      }
      const appearance = appearanceOf(bg, input.systemDark);
      // (Called after every render: drawn again only when something it's drawn from changed.)
      const key = JSON.stringify([input.spaceId, bg, appearance, input.moreContrast, win.innerWidth, win.innerHeight]);
      if (look && key === lastKey) return appearance;
      lastKey = key;
      size = { width: win.innerWidth, height: win.innerHeight };
      const next = lookOf(bg, appearance, { moreContrast: input.moreContrast, size });
      const fade = !!current && shownId !== null && shownId !== input.spaceId && !input.reducedMotion;
      if (fade) {
        const old = current!;
        leaving.add(old);
        const set = makeSet();
        set.classList.add('entering');
        paint(set, next);
        shadow.append(set);
        current = set;
        set.getBoundingClientRect(); // (its opacity 0 laid out first, so the change is a transition)
        set.classList.remove('entering');
        const t = setTimeout(() => { timers.delete(t); old.remove(); leaving.delete(old); }, FADE_MS + 50);
        timers.add(t);
      } else {
        // (Another space shown at once: what was still fading out goes; the same space redrawn lets a fade finish.)
        if (shownId !== input.spaceId) clearLeaving();
        if (!current) { current = makeSet(); shadow.append(current); }
        paint(current, next);
      }
      look = next;
      revision++;
      shownId = input.spaceId;
      const text = backgroundCss(next.vars);
      if (text !== css) { css = text; sheet.replaceSync(text); }
      clip();
      show(true);
      return appearance;
    },
    /** Where the page card is (null: no page area: nothing cut out). */
    place(page: PageBox | null) {
      box = page;
      if (look) clip();
    },
    /** The ground's colour at a point of the window (`rgb(r, g, b)`: as Margin.app reads it), null while none shows. */
    colorAt(x: number, y: number): string | null {
      if (!look) return null;
      const w = win.innerWidth || size.width, h = win.innerHeight || size.height;
      return rgbCss(groundAt(look, x, y, w, h));
    },
    /** Whether a background shows. */
    active: () => !!look,
    /** One more each time what's drawn changes (shown, changed, gone). */
    revision: () => revision,
    /** What's drawn, read back from the layer itself (for the tests): shown, its cut, each set's parts, the variables. */
    drawn() {
      const sets = [...shadow.querySelectorAll('.set')].map((set) => {
        const [underlay, colors, texture] = [...set.children] as HTMLElement[];
        return {
          entering: set.classList.contains('entering'),
          underlay: underlay.style.background, colors: colors.style.background, opacity: colors.style.opacity,
          texture: texture.style.background, textureOpacity: texture.style.opacity,
        };
      });
      const computed = win.getComputedStyle(host);
      return { shown: host.isConnected && computed.display !== 'none', clip: computed.clipPath, sets, css };
    },
    destroy() {
      clearLeaving();
      host.remove();
      look = null;
      sheet.replaceSync('');
    },
  };
}
