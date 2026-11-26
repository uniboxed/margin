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
//
// While a space slides in (a swipe, or a click's or key's switch with Arc's feel: ui/behaviors/swipe.ts), its background
// is drawn over the one shown as far as it has come (`blend`: its opacity the slide's progress, frame by frame), as Arc
// changes its colour with the slide (docs/ARC-SIDEBAR.md "The space's colour in a switch"); when it lands that set is
// the one shown (no cross-fade after it). Only between two spaces that both have one (to or from none: at once, as
// above).
//
// A picture (M2.9 step 7): drawn where the host serves it (`picture`: Margin.app's `margin-app://app/background/<id>`;
// none in a browser's extension, which draws the background without it), as its fit and focus say (cover, contain,
// tile; `background-position` at the focus). It's loaded once per address, and a small copy of it laid out over the
// window as it's drawn (on the underlay) gives the samples the look reads its contrast against (`PictureSamples`);
// until then it's drawn as without, and `onChange` says when it's ready, to be drawn again.
//
// The sidebar out over the page (Tirth, 2026-11-25: a hidden sidebar brought out showed a flat colour, not the space's
// background with its grain): the layer is cut out where the page card is, and the panel floats there, over the page.
// The theme marks the panel `m-ground="float"`; while Margin's sidebar is hidden or out (`float`), a second copy of the
// layer is drawn inside it: the same parts, as large as the window and placed so they line up with the window's (its
// place in the window as laid out, its slide's translation taken off), under the panel's content (`z-index: -1`, the
// panel isolated), clipped to its corners, hidden with it. It moves with the panel, so its slide costs nothing more;
// it's placed again at each layout. A space sliding in (`blend`) is drawn over it as over the window's, the same
// progress, so the panel's colour changes with the slide too.
import { SAMPLES, appearanceOf, groundAt, lookOf, underlayOf } from './background-look.ts';
import type { Appearance, Look, PictureSamples } from './background-look.ts';
import { rgbCss, rgbToHex } from './color.ts';
import { checkCssValue } from './sanitize.ts';
import { TILE_SIZE, tileUrl } from './textures.ts';
import type { TileTexture } from './textures.ts';
import type { SpaceBackground } from '../../../types/margin';

const TAG = 'margin-background';
const PINNED = 'all:initial!important;position:fixed!important;inset:0!important;margin:0!important;padding:0!important;border:0!important;'
  + 'z-index:-2147483647!important;pointer-events:none!important;opacity:1!important;visibility:visible!important;overflow:hidden!important;'
  + 'transform:none!important;filter:none!important;contain:strict!important;';
const SETS_CSS = `.set{position:absolute;inset:0;opacity:1;transition:opacity .3s ease}
.set.entering{opacity:0}
.set>div{position:absolute;inset:0}
.texture{background-repeat:repeat}
@media (prefers-reduced-motion:reduce){.set{transition:none}}`;
const SHADOW_CSS = `:host{${PINNED}}:host::before,:host::after{display:none!important;content:none!important}
${SETS_CSS}`;
// The copy in a panel out over the page: over its padding box, under its content, hidden when it is, its corners.
const FLOAT_PINNED = 'all:initial!important;display:block!important;position:absolute!important;inset:0!important;margin:0!important;padding:0!important;'
  + 'border:0!important;z-index:-1!important;pointer-events:none!important;opacity:1!important;visibility:inherit!important;overflow:hidden!important;'
  + 'border-radius:inherit!important;transform:none!important;filter:none!important;contain:strict!important;';
const FLOAT_CSS = `:host{${FLOAT_PINNED}}:host::before,:host::after{display:none!important;content:none!important}
.window{position:absolute}
${SETS_CSS}`;
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
  /** Where the background's picture is served (the host's address for its id), or null: not drawn here. */
  picture?: string | null,
};

// An address Margin made for a picture (its own scheme's, or a test's data: URL): nothing in it that ends a CSS string.
const PICTURE_URL = /^(margin-app:\/\/app\/background\/[0-9a-f]{64}|data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+)$/;

/** A picture's samples (`SAMPLES`), as it lies over a w × h window drawn so (its fit and focus), on the underlay. */
export function pictureSamples(doc: Document, img: HTMLImageElement, image: { fit: 'cover' | 'contain' | 'tile', focus: [number, number] }, w: number, h: number, underlay: string): PictureSamples | null {
  const iw = img.naturalWidth, ih = img.naturalHeight;
  if (!iw || !ih || w <= 0 || h <= 0) return null;
  const cw = 70, ch = Math.max(2, Math.round((70 * h) / w));
  const canvas = doc.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.fillStyle = underlay;
  g.fillRect(0, 0, cw, ch);
  if (image.fit === 'tile') {
    // (At its own size, the copy's pixels per the window's.)
    const tw = (iw * cw) / w, th = (ih * ch) / h;
    let n = 0;
    for (let y = 0; y < ch && n < 10_000; y += th) for (let x = 0; x < cw && n < 10_000; x += tw, n++) g.drawImage(img, x, y, tw, th);
  } else {
    // As CSS draws it: scaled to cover or to fit, and placed at the focus (`background-position` in percent). Against
    // the copy's own sides, not the window's scaled: its height is rounded, and a picture that just covers the window
    // would leave a sliver of underlay along an edge (the edge's samples then lighter than what's drawn).
    const scale = image.fit === 'cover' ? Math.max(cw / iw, ch / ih) : Math.min(cw / iw, ch / ih);
    const dw = iw * scale, dh = ih * scale;
    g.drawImage(img, (cw - dw) * image.focus[0], (ch - dh) * image.focus[1], dw, dh);
  }
  let data: Uint8ClampedArray;
  try { data = g.getImageData(0, 0, cw, ch).data; } catch { return null; } // (a picture from elsewhere: never drawn)
  const out: PictureSamples = [];
  for (let j = 0; j < SAMPLES.rows; j++) {
    for (let i = 0; i < SAMPLES.cols; i++) {
      // (Each sample the average of its 3 × 3 neighbourhood: a single pixel isn't what the eye sees there.)
      const cx = Math.round((i / (SAMPLES.cols - 1)) * (cw - 1)), cy = Math.round((j / (SAMPLES.rows - 1)) * (ch - 1));
      let r = 0, gr = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = Math.min(cw - 1, Math.max(0, cx + dx)), y = Math.min(ch - 1, Math.max(0, cy + dy));
        const o = (y * cw + x) * 4;
        r += data[o]; gr += data[o + 1]; b += data[o + 2]; n++;
      }
      out.push({ r: r / n / 255, g: gr / n / 255, b: b / n / 255 });
    }
  }
  return out;
}

/** The picture's CSS `background` as it's drawn (its fit and focus). */
export function pictureCss(url: string, image: { fit: 'cover' | 'contain' | 'tile', focus: [number, number] }): string {
  const at = `${Math.round(image.focus[0] * 1000) / 10}% ${Math.round(image.focus[1] * 1000) / 10}%`;
  if (image.fit === 'tile') return `url("${url}") 0 0 / auto repeat`;
  return `url("${url}") ${at} / ${image.fit} no-repeat`;
}

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

export function createBackground({ doc, container, onChange }: {
  doc: Document, container: ShadowRoot | Document,
  /** A picture came (loaded, or failed): to be drawn again. */
  onChange?: () => void,
}) {
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
  // Where the layer's sets are drawn: the window's (`main`), and the panel out over the page's copy (`float`).
  type Surface = { holder: ParentNode, current: HTMLElement | null };
  const main: Surface = { holder: shadow, current: null };
  let float: (Surface & { el: HTMLElement, host: HTMLElement, frame: HTMLElement, isolation: string }) | null = null;
  const surfaces = (): Surface[] => (float ? [main, float] : [main]);
  let pictureBgNow = 'none';
  const leaving = new Set<HTMLElement>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  // The pictures loaded (or loading, or failed), by address; the one drawn now.
  const pictures = new Map<string, { img: HTMLImageElement, state: 'loading' | 'ready' | 'failed' }>();
  let pictureUrl: string | null = null;
  // The samples read last, and what they were read from (a drag of the intensity or the colours leaves them as they are);
  // a few kept (the space shown's and the one sliding in).
  const sampled = new Map<string, PictureSamples | null>();
  let gone = false;
  function picture(url: string) {
    let p = pictures.get(url);
    // (The one used last kept last: the first is the one gone longest.)
    if (p) { pictures.delete(url); pictures.set(url, p); return p; }
    const img = new win.Image();
    p = { img, state: 'loading' };
    pictures.set(url, p);
    const entry = p;
    img.decoding = 'async';
    img.onload = () => { entry.state = 'ready'; if (!gone) onChange?.(); };
    img.onerror = () => { entry.state = 'failed'; if (!gone) onChange?.(); };
    img.src = url;
    // (A few kept: the spaces' pictures switched between.)
    if (pictures.size > 8) { const first = pictures.keys().next().value; if (first !== undefined && first !== url) pictures.delete(first); }
    return p;
  }

  /** A space's look as it's drawn now (its picture's samples once it's loaded), its picture's CSS and its appearance. */
  function lookFor(input: BackgroundInput, bg: SpaceBackground) {
    const appearance = appearanceOf(bg, input.systemDark);
    // The picture: where the host serves it, once it's loaded (its samples read as it lies over the window now).
    const url = bg.image && typeof input.picture === 'string' && PICTURE_URL.test(input.picture) ? input.picture : null;
    const pic = url ? picture(url) : null;
    const key = JSON.stringify([input.spaceId, bg, appearance, input.moreContrast, win.innerWidth, win.innerHeight, url, pic?.state ?? null]);
    return {
      appearance, url, pic, key,
      draw() {
        size = { width: win.innerWidth, height: win.innerHeight };
        let samples: PictureSamples | null = null;
        if (pic?.state === 'ready' && bg.image) {
          const underlay = rgbToHex(underlayOf(bg, appearance));
          const at = JSON.stringify([url, bg.image.fit, bg.image.focus, size.width, size.height, underlay]);
          if (!sampled.has(at)) {
            sampled.set(at, pictureSamples(doc, pic.img, bg.image, size.width, size.height, underlay));
            if (sampled.size > 4) sampled.delete(sampled.keys().next().value!);
          }
          samples = sampled.get(at) ?? null;
        }
        return { look: lookOf(bg, appearance, { moreContrast: input.moreContrast, size, picture: samples }), pictureBg: url && bg.image ? pictureCss(url, bg.image) : 'none' };
      },
    };
  }

  // Each space's own background in the theme's elements marked `m-ground="space"` (`cards`), by element.
  const cardGrounds = new Map<HTMLElement, { host: HTMLElement, set: HTMLElement, key: string, isolation: string }>();
  function letGoCard(el: HTMLElement, card: { host: HTMLElement, isolation: string }) {
    card.host.remove();
    el.style.isolation = card.isolation;
    for (const k of ['--m-bg', '--m-fg', '--m-fg-2', '--m-accent', '--m-hover', '--m-selected']) el.style.removeProperty(k);
    el.removeAttribute('m-grounded');
  }

  // The space sliding in, drawn over the one shown (`blend`): its set, and what it was drawn from.
  // (One set on each surface: the window's, and the panel's copy while the sidebar floats.)
  let preview: { spaceId: string, sets: Map<object, HTMLElement>, key: string } | null = null;
  function dropPreview() {
    if (preview) for (const set of preview.sets.values()) set.remove();
    preview = null;
  }

  function makeSet() {
    const set = doc.createElement('div');
    set.className = 'set';
    for (const part of ['underlay', 'picture', 'wash', 'colors', 'texture']) {
      const el = doc.createElement('div');
      el.className = part;
      set.append(el);
    }
    return set;
  }

  /** Writes a look into a set, each part only where it changed (a picker's drag redraws it every frame). */
  function paint(set: HTMLElement, l: Look, pictureBg: string) {
    const [underlay, pic, wash, colors, texture] = [...set.children] as HTMLElement[];
    const put = (el: HTMLElement, key: string, apply: () => void) => { if (el.dataset.k !== key) { el.dataset.k = key; apply(); } };
    put(underlay, rgbToHex(l.underlay), () => { underlay.style.background = rgbToHex(l.underlay); });
    put(pic, l.samples ? pictureBg : 'none', () => { pic.style.background = l.samples ? pictureBg : 'none'; });
    put(wash, `${rgbToHex(l.underlay)}|${l.samples ? l.wash : 0}`, () => { wash.style.background = rgbToHex(l.underlay); wash.style.opacity = String(l.samples ? l.wash : 0); });
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

  /** A look drawn on a surface: cross-faded from what it showed (a change of space), else in place. */
  function drawInto(sf: Surface, next: Look, pictureBg: string, fade: boolean) {
    if (fade && sf.current) {
      const old = sf.current;
      leaving.add(old);
      const set = makeSet();
      set.classList.add('entering');
      paint(set, next, pictureBg);
      sf.holder.append(set);
      sf.current = set;
      set.getBoundingClientRect(); // (its opacity 0 laid out first, so the change is a transition)
      set.classList.remove('entering');
      const t = setTimeout(() => { timers.delete(t); old.remove(); leaving.delete(old); }, FADE_MS + 50);
      timers.add(t);
    } else {
      if (!sf.current) { sf.current = makeSet(); sf.holder.append(sf.current); }
      paint(sf.current, next, pictureBg);
    }
  }

  /** The panel's copy lined up with the window's: the window's size, at the panel's place as laid out (its slide's
   *  translation taken off, its border's width added: the copy lies over its padding box). */
  function placeFloat() {
    if (!float) return;
    const el = float.el;
    const r = el.getBoundingClientRect();
    const m = /^matrix(3d)?\(([^)]+)\)$/.exec(win.getComputedStyle(el).transform);
    const v = m ? m[2].split(',').map(Number) : null;
    const tx = v ? (m![1] ? v[12] : v[4]) : 0, ty = v ? (m![1] ? v[13] : v[5]) : 0;
    const x = r.left - (Number.isFinite(tx) ? tx : 0) + el.clientLeft, y = r.top - (Number.isFinite(ty) ? ty : 0) + el.clientTop;
    const st = float.frame.style;
    st.left = `${Math.round(-x * 100) / 100}px`;
    st.top = `${Math.round(-y * 100) / 100}px`;
    st.width = `${win.innerWidth}px`;
    st.height = `${win.innerHeight}px`;
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
        dropPreview();
        clearLeaving();
        for (const sf of surfaces()) { sf.current?.remove(); sf.current = null; }
        look = null;
        shownId = null;
        lastKey = '';
        show(false);
        if (css) { css = ''; sheet.replaceSync(''); }
        return null;
      }
      const at = lookFor(input, bg);
      const { appearance, url } = at;
      pictureUrl = url;
      // (Called after every render: drawn again only when something it's drawn from changed.)
      if (look && at.key === lastKey) return appearance;
      lastKey = at.key;
      const { look: next, pictureBg } = at.draw();
      // The space that slid in, its sets drawn over this one already (`blend`): those are the ones shown now, at once.
      const landed = !!main.current && !!preview && preview.spaceId === input.spaceId && shownId !== input.spaceId;
      if (preview && !landed) dropPreview();
      const fade = !landed && !!main.current && shownId !== null && shownId !== input.spaceId && !input.reducedMotion;
      if (landed) {
        clearLeaving();
        for (const sf of surfaces()) {
          const set = preview!.sets.get(sf);
          if (!set) { drawInto(sf, next, pictureBg, false); continue; }
          sf.current?.remove();
          sf.current = set;
          set.style.opacity = '';
          set.style.transition = '';
          paint(set, next, pictureBg);
        }
        preview = null;
      } else {
        // (Another space shown at once: what was still fading out goes; the same space redrawn lets a fade finish.)
        if (!fade && shownId !== input.spaceId) clearLeaving();
        for (const sf of surfaces()) drawInto(sf, next, pictureBg, fade);
      }
      pictureBgNow = pictureBg;
      look = next;
      revision++;
      shownId = input.spaceId;
      const text = backgroundCss(next.vars);
      if (text !== css) { css = text; sheet.replaceSync(text); }
      clip();
      show(true);
      return appearance;
    },
    /**
     * The space sliding in (null: none) drawn over the one shown, `progress` (0 to 1) of the way: its background's
     * opacity. Only between two spaces with one (else nothing drawn: false). The space it lands on takes that set
     * (`update`); one that doesn't land goes with `blend(null)`.
     */
    blend(input: BackgroundInput | null, progress: number): boolean {
      const bg = input?.background ?? null;
      if (!input || !bg || !look || !main.current || input.spaceId === shownId) { dropPreview(); return false; }
      const at = lookFor(input, bg);
      if (!preview || preview.spaceId !== input.spaceId) {
        dropPreview();
        preview = { spaceId: input.spaceId, sets: new Map(), key: '' };
      }
      const on = surfaces();
      // (A surface gone since (the sidebar docked mid-slide): its set went with it.)
      for (const [sf, set] of preview.sets) if (!on.includes(sf as Surface)) { set.remove(); preview.sets.delete(sf); }
      let drawn: ReturnType<typeof at.draw> | null = null;
      for (const sf of on) {
        let set = preview.sets.get(sf);
        const fresh = !set;
        if (!set) {
          set = makeSet();
          // (Its opacity is the slide's, frame by frame: never a transition of its own.)
          set.style.transition = 'none';
          sf.holder.append(set);
          preview.sets.set(sf, set);
        }
        if (fresh || preview.key !== at.key) {
          drawn ??= at.draw();
          paint(set, drawn.look, drawn.pictureBg);
        }
      }
      preview.key = at.key;
      const p = Math.round(Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0)) * 1000) / 1000;
      for (const set of preview.sets.values()) if (set.style.opacity !== String(p)) set.style.opacity = String(p);
      return true;
    },
    /** Where the page card is (null: no page area: nothing cut out). */
    place(page: PageBox | null) {
      box = page;
      if (look) clip();
      placeFloat();
    },
    /**
     * The panel out over the page that Margin's sidebar is drawn in while it's hidden or out (the theme's
     * `m-ground="float"`), the background drawn in it too; null: none (the sidebar docked, no background, no such
     * panel). The same panel again: nothing to do (placed again at each layout, `place`).
     */
    float(el: HTMLElement | null) {
      if (float && float.el === el && el.isConnected) return;
      if (float) {
        float.host.remove();
        float.el.style.isolation = float.isolation;
        preview?.sets.delete(float);
        float = null;
      }
      if (!el || !el.isConnected) return;
      const host = doc.createElement(TAG);
      host.setAttribute('aria-hidden', 'true');
      host.setAttribute('style', FLOAT_PINNED);
      const inner = host.attachShadow({ mode: 'closed' });
      const sheetEl = doc.createElement('style');
      sheetEl.textContent = FLOAT_CSS;
      const frame = doc.createElement('div');
      frame.className = 'window';
      inner.append(sheetEl, frame);
      // (Isolated, so its copy under the content stays inside it whatever the theme's stacking.)
      float = { el, host, frame, holder: frame, current: null, isolation: el.style.isolation };
      el.style.isolation = 'isolate';
      el.append(host);
      placeFloat();
      if (look) drawInto(float, look, pictureBgNow, false);
    },
    /**
     * Each space's own background drawn in an element of the theme's (`m-ground="space"`, its `data-space-id`: the
     * Library's Spaces cards, as Arc's draws each its space's colours and grain): the whole look laid out at the
     * element's own size (its gradient across the card, not the window), its texture, its picture once loaded, under
     * the element's content, clipped to its corners, the element isolated. None for a space with no background (the
     * theme's own colour there). Each drawn again only when its space's background, the appearance or its size
     * changed; elements no longer listed let go. `picture`: the host's address of its picture (Margin.app's).
     */
    cards(list: { el: HTMLElement, background: SpaceBackground | null, picture: string | null }[], opts: { systemDark: boolean, moreContrast: boolean }) {
      const seen = new Set<HTMLElement>();
      for (const { el, background: bg, picture: pictureAddress } of list) {
        if (!bg || !el.isConnected) continue;
        seen.add(el);
        let card = cardGrounds.get(el);
        if (!card) {
          const host = doc.createElement(TAG);
          host.setAttribute('aria-hidden', 'true');
          host.setAttribute('style', FLOAT_PINNED);
          const inner = host.attachShadow({ mode: 'closed' });
          const sheetEl = doc.createElement('style');
          sheetEl.textContent = FLOAT_CSS;
          const set = makeSet();
          inner.append(sheetEl, set);
          card = { host, set, key: '', isolation: el.style.isolation };
          el.style.isolation = 'isolate';
          el.append(host);
          cardGrounds.set(el, card);
        }
        const width = el.clientWidth, height = el.clientHeight;
        if (!(width > 0 && height > 0)) continue;
        const appearance = appearanceOf(bg, opts.systemDark);
        const url = bg.image && typeof pictureAddress === 'string' && PICTURE_URL.test(pictureAddress) ? pictureAddress : null;
        const pic = url ? picture(url) : null;
        const key = JSON.stringify([bg, appearance, opts.moreContrast, width, height, url, pic?.state ?? null]);
        if (card.key === key) continue;
        card.key = key;
        let samples: PictureSamples | null = null;
        if (pic?.state === 'ready' && bg.image) samples = pictureSamples(doc, pic.img, bg.image, width, height, rgbToHex(underlayOf(bg, appearance)));
        const l = lookOf(bg, appearance, { moreContrast: opts.moreContrast, size: { width, height }, picture: samples });
        paint(card.set, l, url && bg.image ? pictureCss(url, bg.image) : 'none');
        // (Its space's own text colours on it (light on a dark space), for the theme to read: `m-grounded`.)
        for (const [k, v] of Object.entries(l.vars)) if (checkCssValue(v)) el.style.setProperty(k, v);
        el.setAttribute('m-grounded', '');
      }
      for (const [el, card] of cardGrounds) {
        if (seen.has(el)) continue;
        letGoCard(el, card);
        cardGrounds.delete(el);
      }
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
      const read = (root: ParentNode) => [...root.querySelectorAll('.set')].map((set) => {
        const [underlay, pic, wash, colors, texture] = [...set.children] as HTMLElement[];
        return {
          entering: set.classList.contains('entering'), sliding: !!preview && [...preview.sets.values()].includes(set as HTMLElement), setOpacity: (set as HTMLElement).style.opacity,
          underlay: underlay.style.background, picture: pic.style.background, wash: wash.style.opacity,
          colors: colors.style.background, opacity: colors.style.opacity,
          texture: texture.style.background, textureOpacity: texture.style.opacity,
        };
      });
      const computed = win.getComputedStyle(host);
      // (The panel's copy: what it's in, where its window-sized frame lies, its sets.)
      const floated = float && float.host.isConnected
        ? { in: typeof float.el.className === 'string' ? float.el.className : '', left: float.frame.style.left, top: float.frame.style.top, width: float.frame.style.width, height: float.frame.style.height, sets: read(float.frame) }
        : null;
      return { shown: host.isConnected && computed.display !== 'none', clip: computed.clipPath, sets: read(shadow), css, picture: pictureUrl, pictureState: pictureUrl ? pictures.get(pictureUrl)?.state ?? null : null, float: floated };
    },
    destroy() {
      gone = true;
      pictures.clear();
      sampled.clear();
      dropPreview();
      clearLeaving();
      host.remove();
      if (float) { float.host.remove(); float.el.style.isolation = float.isolation; float = null; }
      for (const [el, card] of cardGrounds) letGoCard(el, card);
      cardGrounds.clear();
      look = null;
      sheet.replaceSync('');
    },
  };
}
