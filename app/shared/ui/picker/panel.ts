// Edit Theme Color: the panel (M2.9 step 4, docs/SPACE-BACKGROUNDS.md Part B §4), Margin's own, never the theme's.
// Arc's panel, in Margin's words and drawing: the appearance (automatic, light, dark) over a dotted field with the
// colours' knobs (−, + and the rule the others follow under it), pages of presets, the wavy slider (intensity) and the
// dial (the texture: turn its ring, drag its centre up or down, or scroll over it for the amount; click it, press
// Return or Space on it, or swipe sideways over it for the next texture), then Use for All Spaces and Done.
//
// What it is, as ui/theme-preview.ts's bar: content in a closed shadow root (no theme rule reaches it), its host in the
// top layer (`popover="manual"`), the host's own style pinned (`all: initial !important`) and its place set from
// inside (a shadow tree's !important beats the host's attribute: ui/background.ts found it). In the page's light or
// dark (`light-dark()`; Margin.app's window takes the space's: M2.9 step 3). Glass where the page has the system's
// materials as its sheet is read (M2.9 step 5: Margin.app turns them on for it, ui/behaviors/background-picker.ts):
// the real glass behind it, no fill and no outer shadow (one would grow the glass past the box: DECISIONS.md "Liquid
// Glass"), solid still with more contrast asked for. Opaque everywhere else.
//
// It edits a picker state (ui/picker/model.ts) and says what happens: `preview` while a gesture runs (a drag, a burst
// of scrolling, held keys), `commit` when it ends (or at once for a click), `undo` (⌘Z), `escape`, `done`, `all`,
// `tick` at each detent (the dial's steps, the slider's tenths, a texture, an appearance: step 6's haptics or sound).
// Saving, undoing and closing are ui/behaviors/background-picker.ts's.
import { AMOUNT_STEPS, MAX_COLORS, PRESET_PAGES, TEXTURE_NAMES, addColor, colorAt, cycleTexture, knobs, moveKnob, pickPreset, removeColor, setAmount, setAppearance, setIntensity, toggleWheel } from './model.ts';
import type { Appearance, PickerState, Point, Texture } from './model.ts';
import { TILE_SIZE, tileUrl } from '../textures.ts';
import type { TileTexture } from '../textures.ts';

export type TickKind = 'detent' | 'step' | 'texture' | 'appearance';
export type PanelEvents = {
  preview: (s: PickerState) => void,
  commit: (s: PickerState) => void,
  undo: () => void,
  escape: () => void,
  done: () => void,
  all: (s: PickerState) => void,
  tick?: (kind: TickKind) => void,
};

/** Its words (Margin's, as Arc names the panel). */
export const WORDS = Object.freeze({
  title: 'Edit Theme Color',
  auto: 'Automatic appearance', light: 'Light appearance', dark: 'Dark appearance',
  appearanceNote: 'Margin’s window only: pages keep their own',
  field: 'Color', key: 'Hue and lightness', empty: 'Click to pick a color',
  add: 'Add a color', remove: 'Remove a color',
  complementary: 'Complementary', analogous: 'Analogous', wheel: 'How the other colors follow the first',
  presets: 'Presets', prev: 'Previous presets', next: 'Next presets', preset: 'Set space color to',
  intensity: 'Intensity', texture: 'Texture', textureHint: 'Click for the next texture; turn, drag or scroll for its amount',
  all: 'Use for All Spaces', allDone: 'Used for all spaces', done: 'Done',
});

const TAG = 'margin-background-picker';
const PINNED = 'all:initial!important;position:fixed!important;inset:auto!important;margin:0!important;padding:0!important;border:0!important;'
  + 'background:transparent!important;display:block!important;z-index:2147483646!important;overflow:visible!important;'
  + 'opacity:1!important;visibility:visible!important;pointer-events:auto!important;transform:none!important;filter:none!important;';
const SVG = 'http://www.w3.org/2000/svg';
const W = 300; // the panel's width
const FIELD_H = 250;
const KEY = 52, OTHER = 34; // the knobs' sizes
const DIAL = 88, KNOB = 56, RING = 40; // the dial: its box, its knob, its ring's radius
const START = -135, SWEEP = 270; // the dial's ring: from bottom left, round to bottom right
const PAD = 16; // the slider's ends

const CSS = `:host{${PINNED}}:host::before,:host::after,:host::backdrop{display:none!important;content:none!important}
*{box-sizing:border-box}
.panel{all:initial;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;width:${W}px;padding:8px;border-radius:18px;color-scheme:light dark;
--fg:light-dark(#1d1d1f,#f5f5f7);--fg2:light-dark(rgba(29,29,31,.58),rgba(245,245,247,.6));--surface:light-dark(#f6f6f8,#29292d);--well:light-dark(rgba(0,0,0,.035),rgba(255,255,255,.045));
--dot:light-dark(rgba(0,0,0,.16),rgba(255,255,255,.15));--ctl:light-dark(rgba(0,0,0,.06),rgba(255,255,255,.09));--ctl-hover:light-dark(rgba(0,0,0,.1),rgba(255,255,255,.15));
--line:light-dark(rgba(0,0,0,.1),rgba(255,255,255,.12));--face:light-dark(#d9d9de,#3c3c41);--ring:light-dark(#0a6cff,#4c95ff);
background:var(--surface);color:var(--fg);font:13px/1.3 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;
box-shadow:0 18px 50px rgba(0,0,0,.28),0 0 0 .5px light-dark(rgba(0,0,0,.2),rgba(0,0,0,.65)),inset 0 .5px 0 light-dark(rgba(255,255,255,.9),rgba(255,255,255,.18));
user-select:none;-webkit-user-select:none;cursor:default}
button{all:unset;box-sizing:border-box;cursor:default;font:inherit;color:inherit;display:grid;place-items:center}
button:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
button:disabled{opacity:.3}
.field{position:relative;height:${FIELD_H}px;border-radius:14px;overflow:hidden;touch-action:none;
background:radial-gradient(circle,var(--dot) 1px,transparent 1.35px) 0 0/9px 9px,var(--well)}
.appearance{position:absolute;top:8px;left:50%;transform:translateX(-50%);display:flex;gap:6px;z-index:3}
.appearance button{width:36px;height:36px;border-radius:10px;color:var(--fg2)}
.appearance button:hover{background:var(--ctl);color:var(--fg)}
.appearance button[aria-checked="true"]{color:var(--fg);background:var(--ctl);box-shadow:inset 0 0 0 2px var(--ring)}
.empty{position:absolute;inset:0;display:grid;place-items:center;color:var(--fg2);pointer-events:none}
.knob{position:absolute;left:0;top:0;width:${OTHER}px;height:${OTHER}px;margin:-${OTHER / 2}px 0 0 -${OTHER / 2}px;border-radius:50%;padding:3px;background:#fff;
box-shadow:0 2px 8px rgba(0,0,0,.3),0 0 0 .5px rgba(0,0,0,.2);transition:transform .45s cubic-bezier(.25,1.35,.45,1);z-index:1}
.knob.key{width:${KEY}px;height:${KEY}px;margin:-${KEY / 2}px 0 0 -${KEY / 2}px;padding:5px;z-index:2}
.knob>i{display:block;width:100%;height:100%;border-radius:50%;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.14)}
.field.dragging .knob,.field.still .knob{transition:none}
.bar{position:absolute;left:8px;right:8px;bottom:8px;height:34px;z-index:3;pointer-events:none}
.bar>*{pointer-events:auto}
.wheel{position:absolute;left:0;top:6px;padding:4px 10px;border-radius:999px;background:var(--ctl);color:var(--fg2);font-size:11.5px}
.wheel:hover{color:var(--fg)}
.pm{position:absolute;left:50%;top:0;transform:translateX(-50%);display:flex;gap:6px}
.pm button{width:34px;height:34px;border-radius:10px;color:var(--fg2)}
.pm button:hover:not(:disabled){background:var(--ctl);color:var(--fg)}
.presets{display:flex;align-items:center;gap:2px}
.presets .nav{width:24px;height:34px;border-radius:8px;color:var(--fg2);flex:none}
.presets .nav:hover{background:var(--ctl);color:var(--fg)}
.swatches{flex:1;display:grid;grid-template-columns:repeat(9,1fr);gap:4px;justify-items:center}
.swatches button{width:24px;height:24px;border-radius:50%;background:var(--c);box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.3),0 1px 2px rgba(0,0,0,.28)}
.swatches button[aria-checked="true"]{box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.3),0 0 0 2px var(--surface),0 0 0 3.5px var(--fg)}
.controls{display:flex;align-items:center;gap:12px;padding:2px 2px 10px 4px}
.slider{flex:1;min-width:0;position:relative;height:40px;border-radius:999px;background:var(--ctl);touch-action:none}
.slider svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.slider path{fill:none;stroke:var(--fg);stroke-width:3.5;stroke-linecap:round;stroke-linejoin:round}
.slider .lit{opacity:.8}.slider .dim{opacity:.22}
.thumb{position:absolute;left:0;top:50%;width:14px;height:42px;margin:-21px 0 0 -7px;border-radius:7px;background:#fff;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.35),0 0 0 .5px rgba(0,0,0,.2)}
.dial{position:relative;width:${DIAL}px;height:${DIAL}px;flex:none;border-radius:50%;touch-action:none}
.dial .dot{position:absolute;width:4px;height:4px;margin:-2px;border-radius:50%;background:var(--fg);opacity:.2;pointer-events:none}
.dial .dot.on{opacity:.85}
.face,.shade{position:absolute;left:50%;top:50%;width:${KNOB}px;height:${KNOB}px;margin:-${KNOB / 2}px;border-radius:50%;pointer-events:none}
.face{background-color:var(--face);background-repeat:repeat;box-shadow:0 3px 10px rgba(0,0,0,.32),inset 0 0 0 .5px rgba(255,255,255,.14);transition:transform .35s cubic-bezier(.25,1.3,.45,1)}
.dial.turning .face{transition:none}
.shade{background:radial-gradient(circle at 34% 28%,rgba(255,255,255,.18),transparent 58%),radial-gradient(circle at 70% 80%,rgba(0,0,0,.16),transparent 60%)}
.pointer{position:absolute;left:50%;top:-6px;width:6px;height:14px;margin-left:-3px;border-radius:3px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.45)}
.label{position:absolute;left:50%;bottom:-14px;transform:translateX(-50%);font-size:11px;color:var(--fg2);white-space:nowrap}
.foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 2px 0;border-top:.5px solid var(--line)}
.foot button{padding:6px 10px;border-radius:8px;font-size:12.5px}
.foot button:hover{background:var(--ctl)}
.foot .done{font-weight:600;background:var(--ctl)}
.foot .done:hover{background:var(--ctl-hover)}
@media (prefers-reduced-motion:reduce){.knob,.face{transition:none}}
@supports (-apple-visual-effect: -apple-system-glass-material){@media not (prefers-contrast:more){.panel{background:none;box-shadow:none;overflow:hidden;-apple-visual-effect:-apple-system-glass-material}}}
@media (prefers-contrast:more){.panel{--fg2:light-dark(rgba(29,29,31,.85),rgba(245,245,247,.88));--dot:light-dark(rgba(0,0,0,.3),rgba(255,255,255,.3))}}`;

// The icons (Margin's own drawings).
const ICONS: Record<string, { fill?: boolean, d: string[] }> = {
  auto: { fill: true, d: ['M8.6 2.6l1.5 4.1 4.1 1.5-4.1 1.5-1.5 4.1-1.5-4.1L3 8.2l4.1-1.5z', 'M14.6 11.6l.75 2 2 .75-2 .75-.75 2-.75-2-2-.75 2-.75z', 'M14.4 2.4l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z'] },
  light: { d: ['M10 6.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 1 0 0-7.2z', 'M10 2.2v1.9M10 15.9v1.9M2.2 10h1.9M15.9 10h1.9M4.5 4.5l1.35 1.35M14.15 14.15l1.35 1.35M4.5 15.5l1.35-1.35M14.15 5.85l1.35-1.35'] },
  dark: { fill: true, d: ['M15.8 12.9A6.6 6.6 0 0 1 7.1 4.2a6.6 6.6 0 1 0 8.7 8.7z', 'M14.6 3.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z'] },
  minus: { d: ['M4 10h12'] },
  plus: { d: ['M4 10h12M10 4v12'] },
  prev: { d: ['M12 4l-6 6 6 6'] },
  next: { d: ['M8 4l6 6-6 6'] },
};

export type PickerPanel = ReturnType<typeof createPickerPanel>;

export function createPickerPanel({ doc, container, state: start, point, events }: {
  doc: Document, container: ShadowRoot | Document, state: PickerState, point: { x: number, y: number }, events: PanelEvents,
}) {
  const win = doc.defaultView!; // (a page that draws has a window)
  let state = start;
  let page = Math.max(0, PRESET_PAGES.findIndex((p) => state.colors[0] && p.includes(state.colors[0])));
  const offs: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, fn: (e: any) => void, options?: AddEventListenerOptions | boolean) => {
    target.addEventListener(type, fn, options);
    offs.push(() => target.removeEventListener(type, fn, options));
  };

  // ---- building ------------------------------------------------------------------------------------------------
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', attrs: Record<string, string> = {}, ...kids: (Node | string)[]) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    e.append(...kids);
    return e;
  };
  const icon = (name: string, size = 20) => {
    const spec = ICONS[name];
    const svg = doc.createElementNS(SVG, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of spec.d) {
      const path = doc.createElementNS(SVG, 'path');
      path.setAttribute('d', d);
      if (spec.fill) path.setAttribute('fill', 'currentColor');
      else { path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.7'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); }
      svg.append(path);
    }
    return svg;
  };
  const button = (cls: string, label: string, ...kids: (Node | string)[]) => el('button', cls, { type: 'button', 'aria-label': label, title: label }, ...kids);

  const host = doc.createElement(TAG);
  host.setAttribute('style', PINNED);
  host.setAttribute('popover', 'manual');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = el('style');
  style.textContent = CSS;
  const place = el('style'); // (where it is: from inside, after the pin)
  const panel = el('div', 'panel', { role: 'dialog', 'aria-label': WORDS.title, tabindex: '-1' });

  const appearanceButtons = (['auto', 'light', 'dark'] as const).map((a) => {
    const b = button('', `${WORDS[a]} (${WORDS.appearanceNote})`, icon(a));
    b.setAttribute('role', 'radio');
    b.dataset.appearance = a;
    return b;
  });
  const appearance = el('div', 'appearance', { role: 'radiogroup', 'aria-label': 'Appearance' }, ...appearanceButtons);
  const empty = el('div', 'empty', {}, WORDS.empty);
  const knobEls = Array.from({ length: MAX_COLORS }, (_, i) => {
    const k = el('div', i ? 'knob' : 'knob key', i ? {} : { role: 'slider', tabindex: '0', 'aria-label': WORDS.key }, el('i'));
    k.dataset.index = String(i);
    return k;
  });
  const wheel = button('wheel', WORDS.wheel);
  const minus = button('', WORDS.remove, icon('minus', 18));
  const plus = button('', WORDS.add, icon('plus', 18));
  const field = el('div', 'field still', { role: 'group', 'aria-label': WORDS.field }, appearance, empty, ...knobEls,
    el('div', 'bar', {}, wheel, el('div', 'pm', {}, minus, plus)));
  const prev = button('nav', WORDS.prev, icon('prev', 14));
  const next = button('nav', WORDS.next, icon('next', 14));
  const swatches = el('div', 'swatches', { role: 'radiogroup', 'aria-label': WORDS.presets });
  const presets = el('div', 'presets', {}, prev, swatches, next);
  const wave = doc.createElementNS(SVG, 'svg');
  const clipId = (k: string) => `m-bg-picker-${k}`;
  const defs = doc.createElementNS(SVG, 'defs');
  const clips = ['lit', 'dim'].map((k) => {
    const clip = doc.createElementNS(SVG, 'clipPath');
    clip.setAttribute('id', clipId(k));
    const rect = doc.createElementNS(SVG, 'rect');
    rect.setAttribute('y', '-20');
    rect.setAttribute('height', '100');
    clip.append(rect);
    defs.append(clip);
    return rect;
  });
  const paths = ['lit', 'dim'].map((k) => {
    const p = doc.createElementNS(SVG, 'path');
    p.setAttribute('class', k);
    p.setAttribute('clip-path', `url(#${clipId(k)})`);
    return p;
  });
  wave.setAttribute('aria-hidden', 'true');
  wave.append(defs, ...paths);
  const thumb = el('div', 'thumb');
  const slider = el('div', 'slider', { role: 'slider', tabindex: '0', 'aria-label': WORDS.intensity, 'aria-valuemin': '0', 'aria-valuemax': '100', title: WORDS.intensity }, wave, thumb);
  const face = el('div', 'face', {}, el('i', 'pointer'));
  const label = el('div', 'label');
  const dots = Array.from({ length: AMOUNT_STEPS + 1 }, (_, i) => {
    const th = ((START + (i / AMOUNT_STEPS) * SWEEP) * Math.PI) / 180;
    const d = el('i', 'dot');
    d.style.left = `${(DIAL / 2 + Math.sin(th) * RING).toFixed(2)}px`;
    d.style.top = `${(DIAL / 2 - Math.cos(th) * RING).toFixed(2)}px`;
    return d;
  });
  const dial = el('div', 'dial', { role: 'slider', tabindex: '0', 'aria-label': WORDS.texture, 'aria-valuemin': '0', 'aria-valuemax': '100', title: WORDS.textureHint }, ...dots, face, el('div', 'shade'), label);
  const all = button('all', WORDS.all, WORDS.all);
  const done = button('done', WORDS.done, WORDS.done);
  panel.append(field, presets, el('div', 'controls', {}, slider, dial), el('div', 'foot', {}, all, done));
  shadow.append(style, place, panel);
  // (In the page as Margin's own: after the theme's root, as ui/background.ts's layer; shown in the top layer.)
  if (container.nodeType === 9) doc.documentElement.append(host);
  else (container as ShadowRoot).append(host);
  try { host.showPopover?.(); } catch { /* not in a document's top layer: it's fixed and lifted anyway */ }

  // ---- drawing -------------------------------------------------------------------------------------------------
  const geometry = () => { const w = field.clientWidth || W - 16, h = field.clientHeight || FIELD_H; return { cx: w / 2, cy: h / 2, r: Math.min(w, h) / 2 - KEY / 2 - 2 }; };
  const at = (p: Point) => { const { cx, cy, r } = geometry(); const a = (p.angle * Math.PI) / 180; return { x: cx + Math.cos(a) * p.d * r, y: cy + Math.sin(a) * p.d * r }; };

  function drawSwatches() {
    swatches.replaceChildren(...PRESET_PAGES[page].map((c) => {
      const b = button('', `${WORDS.preset} ${c}`);
      b.setAttribute('role', 'radio');
      b.style.setProperty('--c', c);
      b.dataset.color = c;
      return b;
    }));
  }

  function draw() {
    for (const b of appearanceButtons) b.setAttribute('aria-checked', String(b.dataset.appearance === state.appearance));
    const points = knobs(state);
    knobEls.forEach((k, i) => {
      const p = points[i];
      k.style.display = p ? '' : 'none';
      if (!p) return;
      const { x, y } = at(p);
      k.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
      (k.firstChild as HTMLElement).style.background = state.colors[i] ?? colorAt(p);
    });
    const key = points[0];
    if (key) knobEls[0].setAttribute('aria-valuetext', `hue ${Math.round(key.angle)}°, ${Math.round(key.d * 100)}% from the center`);
    empty.style.display = state.colors.length ? 'none' : '';
    minus.disabled = state.colors.length === 0;
    plus.disabled = state.colors.length >= MAX_COLORS;
    wheel.style.display = state.colors.length > 1 ? '' : 'none';
    wheel.textContent = state.wheel === 'complementary' ? WORDS.complementary : WORDS.analogous;
    for (const b of swatches.children as HTMLCollectionOf<HTMLElement>) b.setAttribute('aria-checked', String(!!state.colors.length && b.dataset.color === state.colors[0]));
    drawSlider();
    drawDial();
  }

  function drawSlider() {
    const v = state.intensity, w = slider.clientWidth || 180, h = slider.clientHeight || 40;
    const x = PAD + v * (w - 2 * PAD), amp = h * 0.24 * v, phase = v * Math.PI * 5;
    let d = '';
    for (let px = PAD - 2; px <= w - PAD + 2; px += 2) d += `${d ? 'L' : 'M'}${px} ${(h / 2 + amp * Math.sin((px / 22) * 2 * Math.PI - phase)).toFixed(2)}`;
    wave.setAttribute('viewBox', `0 0 ${w} ${h}`);
    for (const p of paths) p.setAttribute('d', d);
    clips[0].setAttribute('width', String(Math.max(0, x)));
    clips[1].setAttribute('x', String(x));
    clips[1].setAttribute('width', String(Math.max(0, w - x)));
    thumb.style.transform = `translateX(${x.toFixed(2)}px)`;
    slider.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  }

  function faceOf(t: Texture) {
    if (t === 'dots') return 'radial-gradient(circle, rgba(255,255,255,.6) 1px, transparent 1.4px) 0 0 / 7px 7px';
    if (t === 'grid') return 'linear-gradient(rgba(255,255,255,.4) 1px, transparent 1px) 0 0 / 8px 8px, linear-gradient(90deg, rgba(255,255,255,.4) 1px, transparent 1px) 0 0 / 8px 8px';
    const url = tileUrl(doc, t as TileTexture);
    const size = Math.round(TILE_SIZE[t as TileTexture] * 0.55);
    return url ? `url("${url}") 0 0 / ${size}px ${size}px repeat` : 'none';
  }

  function drawDial() {
    const a = state.amount;
    face.style.transform = `rotate(${START + a * SWEEP}deg)`;
    dots.forEach((d, i) => d.classList.toggle('on', a > 0 && i / AMOUNT_STEPS <= a + 1e-9));
    if (face.dataset.texture !== state.texture) {
      face.dataset.texture = state.texture;
      face.style.background = faceOf(state.texture);
      face.style.backgroundColor = 'var(--face)';
    }
    const words = `${TEXTURE_NAMES[state.texture]}, ${Math.round(a * 100)}%`;
    label.textContent = words;
    dial.setAttribute('aria-valuenow', String(Math.round(a * 100)));
    dial.setAttribute('aria-valuetext', words);
  }

  // Where it is: by the point it opened at (a menu's, a button's), kept in the window.
  function position() {
    const r = panel.getBoundingClientRect();
    const vw = win.innerWidth, vh = win.innerHeight;
    // (Whole pixels, rounded down from the far edge: a fractional size never takes it past the margin.)
    const x = Math.max(8, Math.floor(Math.min(point.x, vw - r.width - 8)));
    const y = Math.max(8, Math.floor(Math.min(point.y, vh - r.height - 8)));
    place.textContent = `:host{left:${x}px!important;top:${y}px!important}`;
  }

  // ---- changes ---------------------------------------------------------------------------------------------------
  let frame = 0;
  /** A change while a gesture runs: drawn, and previewed once a frame. */
  function live(next: PickerState) {
    state = next;
    if (frame) return;
    frame = win.requestAnimationFrame(() => { frame = 0; draw(); events.preview(state); });
  }
  /** A change that ends a gesture (or is one: a click): drawn and committed. */
  function commit(next: PickerState) {
    if (frame) { win.cancelAnimationFrame(frame); frame = 0; }
    state = next;
    draw();
    events.commit(state);
  }
  const tick = (kind: TickKind) => events.tick?.(kind);

  // A burst of the same kind (scrolling, held keys) is one gesture: committed once it rests.
  let restTimer: ReturnType<typeof setTimeout> | null = null;
  function burst(next: PickerState) {
    live(next);
    if (restTimer) clearTimeout(restTimer);
    restTimer = setTimeout(() => { restTimer = null; commit(state); }, 350);
  }
  function settle() { if (restTimer) { clearTimeout(restTimer); restTimer = null; commit(state); } }

  // ---- the field ---------------------------------------------------------------------------------------------------
  function pointAt(clientX: number, clientY: number): Point {
    const box = field.getBoundingClientRect();
    const { cx, cy, r } = geometry();
    const dx = clientX - box.left - cx, dy = clientY - box.top - cy;
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (angle < 0) angle += 360;
    return { angle, d: Math.min(1, Math.hypot(dx, dy) / r) };
  }
  listen(field, 'pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('button, .appearance, .bar')) return;
    e.preventDefault();
    settle();
    const knob = (e.target as Element).closest('.knob') as HTMLElement | null;
    const index = knob ? Number(knob.dataset.index) : 0;
    // (Grabbed off its centre: it keeps that offset, so it doesn't jump under the pointer.)
    let off = { x: 0, y: 0 };
    if (knob) { const b = knob.getBoundingClientRect(); off = { x: b.left + b.width / 2 - e.clientX, y: b.top + b.height / 2 - e.clientY }; }
    field.setPointerCapture(e.pointerId);
    field.classList.add('dragging');
    const move = (ev: PointerEvent) => live(moveKnob(state, index, pointAt(ev.clientX + off.x, ev.clientY + off.y)));
    if (!knob) move(e);
    const up = () => {
      field.removeEventListener('pointermove', move);
      field.removeEventListener('pointerup', up);
      field.removeEventListener('pointercancel', up);
      field.classList.remove('dragging');
      commit(state);
    };
    field.addEventListener('pointermove', move);
    field.addEventListener('pointerup', up);
    field.addEventListener('pointercancel', up);
  });
  // The key from the keyboard: ←/→ its hue, ↑/↓ its lightness (Shift: three times as far).
  listen(knobEls[0], 'keydown', (e: KeyboardEvent) => {
    const k = knobs(state)[0];
    if (!k) return;
    const m = e.shiftKey ? 3 : 1;
    const step: Record<string, Point> = { ArrowLeft: { angle: k.angle - 5 * m, d: k.d }, ArrowRight: { angle: k.angle + 5 * m, d: k.d }, ArrowUp: { angle: k.angle, d: k.d - 0.05 * m }, ArrowDown: { angle: k.angle, d: k.d + 0.05 * m } };
    if (!step[e.key]) return;
    e.preventDefault();
    e.stopPropagation();
    burst(moveKnob(state, 0, step[e.key]));
  });
  for (const b of appearanceButtons) listen(b, 'click', () => { settle(); tick('appearance'); commit(setAppearance(state, b.dataset.appearance as Appearance)); });
  listen(plus, 'click', () => { settle(); tick('step'); commit(addColor(state)); });
  listen(minus, 'click', () => { settle(); tick('step'); commit(removeColor(state)); });
  listen(wheel, 'click', () => { settle(); tick('step'); commit(toggleWheel(state)); });

  // ---- presets -----------------------------------------------------------------------------------------------------
  const turnPage = (dir: number) => { page = (page + dir + PRESET_PAGES.length) % PRESET_PAGES.length; drawSwatches(); draw(); };
  listen(prev, 'click', () => turnPage(-1));
  listen(next, 'click', () => turnPage(1));
  listen(swatches, 'click', (e: MouseEvent) => {
    const b = (e.target as Element).closest('button') as HTMLElement | null;
    if (!b?.dataset.color) return;
    settle();
    tick('step');
    commit(pickPreset(state, b.dataset.color));
  });

  // ---- the slider ----------------------------------------------------------------------------------------------------
  const intensityAt = (clientX: number) => { const b = slider.getBoundingClientRect(); return (clientX - b.left - PAD) / (b.width - 2 * PAD); };
  const tenths = (a: number, b: number) => Math.floor(a * 10 + 1e-9) !== Math.floor(b * 10 + 1e-9);
  function slide(v: number, how: (s: PickerState) => void) {
    const next = setIntensity(state, v);
    if (tenths(state.intensity, next.intensity)) tick('detent');
    how(next);
  }
  listen(slider, 'pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    settle();
    slider.focus({ preventScroll: true });
    slider.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => slide(intensityAt(ev.clientX), live);
    move(e);
    const up = () => {
      slider.removeEventListener('pointermove', move);
      slider.removeEventListener('pointerup', up);
      slider.removeEventListener('pointercancel', up);
      commit(state);
    };
    slider.addEventListener('pointermove', move);
    slider.addEventListener('pointerup', up);
    slider.addEventListener('pointercancel', up);
  });
  listen(slider, 'keydown', (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.05;
    const to: Record<string, number> = { ArrowRight: state.intensity + step, ArrowUp: state.intensity + step, ArrowLeft: state.intensity - step, ArrowDown: state.intensity - step, Home: 0, End: 1 };
    if (!(e.key in to)) return;
    e.preventDefault();
    e.stopPropagation();
    slide(to[e.key], burst);
  });

  // ---- the dial ------------------------------------------------------------------------------------------------------
  function turnTo(v: number, how: (s: PickerState) => void) {
    const next = setAmount(state, v);
    if (next.amount === state.amount) return;
    tick('detent');
    how(next);
  }
  function nextTexture(dir: 1 | -1) { settle(); tick('texture'); commit(cycleTexture(state, dir)); }
  listen(dial, 'pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    settle();
    dial.focus({ preventScroll: true });
    const b = dial.getBoundingClientRect();
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    // The ring: turned to where the pointer is; the centre: dragged up or down (a click: the next texture).
    const ring = Math.hypot(e.clientX - cx, e.clientY - cy) > KNOB / 2 + 2;
    const fromY = e.clientY, from = state.amount;
    let moved = false;
    dial.setPointerCapture(e.pointerId);
    dial.classList.add('turning');
    const move = (ev: PointerEvent) => {
      if (ring) {
        moved = true;
        const th = (Math.atan2(ev.clientX - cx, -(ev.clientY - cy)) * 180) / Math.PI;
        // (In the ring's gap at the bottom: the nearer end.)
        turnTo(th > -START || th < START ? (state.amount > 0.5 ? 1 : 0) : (th - START) / SWEEP, live);
      } else {
        const dy = fromY - ev.clientY;
        if (!moved && Math.abs(dy) < 4) return;
        moved = true;
        turnTo(from + dy / 150, live);
      }
    };
    if (ring) move(e);
    const up = () => {
      dial.removeEventListener('pointermove', move);
      dial.removeEventListener('pointerup', up);
      dial.removeEventListener('pointercancel', up);
      dial.classList.remove('turning');
      if (!ring && !moved) nextTexture(1); else commit(state);
    };
    dial.addEventListener('pointermove', move);
    dial.addEventListener('pointerup', up);
    dial.addEventListener('pointercancel', up);
  });
  // Scrolling over it: up and down the amount, a step each 22 px; sideways (a swipe) the next texture.
  let ySum = 0, xSum = 0;
  listen(dial, 'wheel', (e: WheelEvent) => {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : 1;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      xSum += e.deltaX * k;
      if (Math.abs(xSum) > 70) { const dir = xSum > 0 ? 1 : -1; xSum = 0; nextTexture(dir); }
      return;
    }
    ySum += e.deltaY * k;
    while (Math.abs(ySum) >= 22) {
      const s = ySum > 0 ? 1 : -1;
      ySum -= 22 * s;
      turnTo(state.amount + s / AMOUNT_STEPS, burst);
    }
  }, { passive: false });
  listen(dial, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); nextTexture(1); return; }
    const to: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
    if (!(e.key in to)) return;
    e.preventDefault();
    e.stopPropagation();
    turnTo(state.amount + to[e.key] / AMOUNT_STEPS, burst);
  });

  // ---- the foot, the keys --------------------------------------------------------------------------------------------
  listen(all, 'click', () => {
    settle();
    events.all(state);
    all.textContent = WORDS.allDone;
    const t = setTimeout(() => { all.textContent = WORDS.all; }, 1500);
    offs.push(() => clearTimeout(t));
  });
  listen(done, 'click', () => { settle(); events.done(); });
  listen(panel, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (restTimer) { clearTimeout(restTimer); restTimer = null; } events.escape(); return; }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); settle(); events.undo(); return; }
    if (e.key === 'Tab') {
      // (The keys stay in the panel.)
      const order = [...shadow.querySelectorAll('button:not([disabled]), [tabindex="0"]')].filter((x) => (x as HTMLElement).offsetParent !== null || x === knobEls[0]) as HTMLElement[];
      const now = order.indexOf(shadow.activeElement as HTMLElement);
      const to = order[(now + (e.shiftKey ? -1 : 1) + order.length) % order.length];
      if (to) { e.preventDefault(); to.focus(); }
    }
  });
  listen(win, 'resize', () => { draw(); position(); });

  drawSwatches();
  draw();
  position();
  win.requestAnimationFrame(() => field.classList.remove('still'));
  (knobEls[0].style.display !== 'none' ? knobEls[0] : appearanceButtons[0]).focus({ preventScroll: true });

  return {
    /** Shows a state (an undo, the state's own value come back). */
    set(next: PickerState) { state = next; draw(); },
    get state() { return state; },
    /** Its box in the window's pixels, [x, y, width, height] (what Margin.app is told takes the pointer). */
    rect(): number[] | null {
      if (!host.isConnected) return null;
      const r = panel.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2) / 2);
    },
    /** Whether an event's target is this panel (seen from its container: the host). */
    owns: (target: EventTarget | null) => target === host,
    /** Each part's box and state, for the tests (the panel's content is closed to them). */
    parts() {
      const box = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
      return {
        panel: box(panel), field: box(field), slider: box(slider), dial: box(dial),
        knobs: knobEls.filter((k) => k.style.display !== 'none').map(box),
        appearance: appearanceButtons.map((b) => ({ ...box(b), value: b.dataset.appearance, checked: b.getAttribute('aria-checked') === 'true' })),
        minus: { ...box(minus), disabled: minus.disabled }, plus: { ...box(plus), disabled: plus.disabled },
        wheel: { ...box(wheel), shown: wheel.style.display !== 'none', text: wheel.textContent },
        swatches: [...swatches.children].map((b) => ({ ...box(b), color: (b as HTMLElement).dataset.color, checked: b.getAttribute('aria-checked') === 'true' })),
        prev: box(prev), next: box(next), all: { ...box(all), text: all.textContent }, done: box(done),
        empty: empty.style.display !== 'none', label: label.textContent, focused: (shadow.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? null,
        dialValue: dial.getAttribute('aria-valuetext'), sliderValue: slider.getAttribute('aria-valuenow'),
      };
    },
    destroy() {
      if (frame) win.cancelAnimationFrame(frame);
      if (restTimer) clearTimeout(restTimer);
      for (const off of offs.splice(0)) off();
      try { host.hidePopover?.(); } catch { /* not shown as one */ }
      host.remove();
    },
  };
}
