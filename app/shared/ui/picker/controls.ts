// Edit Theme Color's controls (M2.9 steps 4 and 5b, docs/SPACE-BACKGROUNDS.md Part B §4): the field, the slider and
// the dial, each built into an element it's given and worked by the pointer and the keys, and the session they share
// (the picker's state, what a gesture does with it). Margin's default panel (ui/picker/panel.ts) puts them in its
// closed shadow root; a theme's `background-picker` part has Margin's elements for them (`<m-picker-field>`,
// `<m-picker-slider>`, `<m-picker-dial>`: ui/picker/part.ts), drawn by the theme's CSS. What each builds is the same
// either way, named by attributes a theme's CSS selects (themes README, "Edit Theme Color"):
// - the field: `[m-knob]` (the key `[m-knob="key"]` first; its colour `--m-knob-color`, an `<i>` inside), the hint
//   `[m-picker-empty]` while there's no colour, and by its variant (`m-variant`): `dots` nothing more (the theme draws
//   the ground), `wheel` the hidden wheel shown (`--m-field-wheel`, the field's own colours), `cells` a grid of
//   `[m-cell]`s in them, the knobs on the cells' centres;
// - the slider (`m-value`: `intensity` or `amount`): `wave` a wave (`[m-wave]`, its `[m-lit]` and `[m-dim]` paths) or
//   `bar` a track (`[m-track]`, `[m-fill]`); then its `[m-thumb]`; the value as `--m-value` (0–1);
// - the dial: its detents (`[m-dot]`, lit `[m-on]`), the face (`[m-face]`, the texture in `--m-face`), a shade
//   (`[m-shade]`), the pointer (`[m-pointer]`) and its words (`[m-dial-label]`).
// The session: a change while a gesture runs is drawn and previewed once a frame (`live`), its end commits once
// (`commit`), a burst of the same kind (scrolling, held keys) commits once it rests (`burst`), and every control's
// `tick` at a detent goes to the events (step 6's haptics or sound).
import { AMOUNT_STEPS, MAX_COLORS, TEXTURE_NAMES, colorAt, cycleTexture, knobs, moveKnob, setAmount, setIntensity } from './model.ts';
import type { PickerState, Point, Texture } from './model.ts';
import { TILE_SIZE, tileUrl } from '../textures.ts';
import type { TileTexture } from '../textures.ts';
import type { FieldVariant, SliderValue, SliderVariant } from './elements.ts';
import { WORDS } from './words.ts';
import type { PanelEvents, TickKind } from './words.ts';

export { WORDS } from './words.ts';
export type { PanelEvents, TickKind } from './words.ts';
/** The cells variant's grid. */
export const CELLS = Object.freeze({ cols: 16, rows: 10 });
const START = -135, SWEEP = 270; // the dial's ring: from bottom left, round to bottom right
const SVG = 'http://www.w3.org/2000/svg';

export type Session = ReturnType<typeof createSession>;

/** The state a picker edits and what a gesture does with it; `draw` hears each change (`live` while one runs). */
export function createSession({ win, state: start, events }: { win: Window, state: PickerState, events: PanelEvents }) {
  let state = start;
  let frame = 0;
  let restTimer: ReturnType<typeof setTimeout> | null = null;
  // A change drawn (a gesture's, a burst's) and not committed yet.
  let unsaved = false;
  const drawers = new Set<(live: boolean) => void>();
  const draw = (live: boolean) => { for (const d of drawers) d(live); };

  const s = {
    get state() { return state; },
    /** Drawn at each change (`live`: during a gesture, once a frame). */
    onDraw(fn: (live: boolean) => void) { drawers.add(fn); return () => drawers.delete(fn); },
    /** A change while a gesture runs: drawn, and previewed once a frame. */
    live(next: PickerState) {
      state = next;
      unsaved = true;
      if (frame) return;
      frame = win.requestAnimationFrame(() => { frame = 0; draw(true); events.preview(state); });
    },
    /** A change that ends a gesture (or is one: a click): drawn and committed. */
    commit(next: PickerState) {
      if (frame) { win.cancelAnimationFrame(frame); frame = 0; }
      state = next;
      unsaved = false;
      draw(false);
      events.commit(state);
    },
    /** A burst of the same kind (scrolling, held keys) is one gesture: committed once it rests. */
    burst(next: PickerState) {
      s.live(next);
      if (restTimer) clearTimeout(restTimer);
      restTimer = setTimeout(() => { restTimer = null; s.commit(state); }, 350);
    },
    /** A burst still running committed now (another gesture starts). */
    settle() { if (restTimer) { clearTimeout(restTimer); restTimer = null; s.commit(state); } },
    /** A burst still running dropped (Escape puts back what was there). */
    drop() { if (restTimer) { clearTimeout(restTimer); restTimer = null; } unsaved = false; },
    /** Closing: a change drawn and not committed yet (a burst at rest's wait, a drag cut off) committed now. */
    finish() {
      if (restTimer) { clearTimeout(restTimer); restTimer = null; }
      if (unsaved) s.commit(state);
    },
    /** Shown as it is (an undo, the state's own value come back), nothing committed. */
    set(next: PickerState) { state = next; draw(false); },
    redraw() { draw(false); },
    tick(kind: TickKind) { events.tick?.(kind); },
    destroy() {
      if (frame) win.cancelAnimationFrame(frame);
      if (restTimer) clearTimeout(restTimer);
      drawers.clear();
    },
  };
  return s;
}

type Off = () => void;
function listener(offs: Off[]) {
  return (target: EventTarget, type: string, fn: (e: any) => void, options?: AddEventListenerOptions | boolean) => {
    target.addEventListener(type, fn, options);
    offs.push(() => target.removeEventListener(type, fn, options));
  };
}
const make = (doc: Document, tag: string, attrs: Record<string, string> = {}) => {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
/** Releases what a gesture holds once it ends, however it ends. */
function drag(el: HTMLElement, e: PointerEvent, move: (ev: PointerEvent) => void, end: () => void) {
  try { el.setPointerCapture(e.pointerId); } catch { /* a pointer the page didn't get (a test's): moves still come */ }
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    end();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

// ---- the field ---------------------------------------------------------------------------------------------------

/**
 * The field in `el`: its knobs (the key first), the hint, and its variant's ground. A press on a button (or anything
 * marked `data-no-field`) inside it isn't the field's.
 */
export function fieldControl(s: Session, el: HTMLElement, { variant = 'dots' }: { variant?: FieldVariant } = {}) {
  const doc = el.ownerDocument;
  const offs: Off[] = [];
  const listen = listener(offs);
  const added: Element[] = [];
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', WORDS.field);
  el.setAttribute('m-variant', variant);
  const cells = variant === 'cells' ? Array.from({ length: CELLS.cols * CELLS.rows }, () => make(doc, 'i', { 'm-cell': '' })) : [];
  const empty = make(doc, 'div', { 'm-picker-empty': '' });
  empty.textContent = WORDS.empty;
  const knobEls = Array.from({ length: MAX_COLORS }, (_, i) => {
    const k = make(doc, 'div', i ? { 'm-knob': '' } : { 'm-knob': 'key', role: 'slider', tabindex: '0', 'aria-label': WORDS.key });
    k.append(make(doc, 'i'));
    return k;
  });
  el.prepend(...cells);
  el.append(empty, ...knobEls);
  added.push(...cells, empty, ...knobEls);

  const geometry = () => {
    const w = el.clientWidth || 280, h = el.clientHeight || 200;
    // (The key's size as its CSS says, hidden or not: the radius is the same before the first colour and after.)
    const key = parseFloat(doc.defaultView?.getComputedStyle(knobEls[0]).width ?? '') || 32;
    return { w, h, cx: w / 2, cy: h / 2, r: Math.max(8, Math.min(w, h) / 2 - key / 2 - 2) };
  };
  // (Cells: a point on its cell's centre.)
  const cellOf = (x: number, y: number, w: number, h: number) => {
    const cw = w / CELLS.cols, ch = h / CELLS.rows;
    return { x: (Math.min(CELLS.cols - 1, Math.max(0, Math.floor(x / cw))) + 0.5) * cw, y: (Math.min(CELLS.rows - 1, Math.max(0, Math.floor(y / ch))) + 0.5) * ch };
  };
  const pointOfXY = (x: number, y: number): Point => {
    const { cx, cy, r } = geometry();
    let angle = (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
    if (angle < 0) angle += 360;
    return { angle, d: Math.min(1, Math.hypot(x - cx, y - cy) / r) };
  };
  const at = (p: Point) => {
    const { w, h, cx, cy, r } = geometry();
    const a = (p.angle * Math.PI) / 180;
    const x = cx + Math.cos(a) * p.d * r, y = cy + Math.sin(a) * p.d * r;
    return variant === 'cells' ? cellOf(x, y, w, h) : { x, y };
  };
  let drawnFor = '';
  function drawGround() {
    const { w, h, r } = geometry();
    const size = `${w}x${h}`;
    if (size === drawnFor) return;
    drawnFor = size;
    if (variant === 'wheel') {
      // The hidden wheel shown: the rim's hues round, the centre's pale colour fading out over the radius.
      const rim = Array.from({ length: 13 }, (_, i) => colorAt({ angle: i * 30, d: 1 })).join(', ');
      el.style.setProperty('--m-field-wheel', `radial-gradient(circle ${Math.round(r)}px at 50% 50%, ${colorAt({ angle: 0, d: 0 })}, transparent), conic-gradient(from 90deg, ${rim})`);
    } else if (variant === 'cells') {
      cells.forEach((c, i) => {
        const col = i % CELLS.cols, row = Math.floor(i / CELLS.cols);
        const p = pointOfXY((col + 0.5) * (w / CELLS.cols), (row + 0.5) * (h / CELLS.rows));
        (c as HTMLElement).style.background = colorAt(p);
      });
    }
  }
  function draw() {
    drawGround();
    const state = s.state;
    const points = knobs(state);
    knobEls.forEach((k, i) => {
      const p = points[i];
      k.style.display = p ? '' : 'none';
      if (!p) return;
      const { x, y } = at(p);
      k.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
      k.style.setProperty('--m-knob-color', state.colors[i] ?? colorAt(p));
    });
    const key = points[0];
    if (key) knobEls[0].setAttribute('aria-valuetext', `hue ${Math.round(key.angle)}°, ${Math.round(key.d * 100)}% from the center`);
    empty.style.display = state.colors.length ? 'none' : '';
  }
  const offDraw = s.onDraw(draw);

  listen(el, 'pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('button, a, input, select, textarea, [data-no-field]')) return;
    e.preventDefault();
    s.settle();
    const knob = (e.target as Element).closest('[m-knob]') as HTMLElement | null;
    const index = knob ? Math.max(0, knobEls.indexOf(knob)) : 0;
    // (Grabbed off its centre: it keeps that offset, so it doesn't jump under the pointer.)
    let off = { x: 0, y: 0 };
    if (knob) { const b = knob.getBoundingClientRect(); off = { x: b.left + b.width / 2 - e.clientX, y: b.top + b.height / 2 - e.clientY }; }
    el.setAttribute('m-dragging', '');
    const move = (ev: PointerEvent) => {
      const box = el.getBoundingClientRect();
      s.live(moveKnob(s.state, index, pointOfXY(ev.clientX + off.x - box.left, ev.clientY + off.y - box.top)));
    };
    if (!knob) move(e);
    drag(el, e, move, () => { el.removeAttribute('m-dragging'); s.commit(s.state); });
  });
  // The key from the keyboard: ←/→ its hue, ↑/↓ its lightness (Shift: three times as far).
  listen(knobEls[0], 'keydown', (e: KeyboardEvent) => {
    const k = knobs(s.state)[0];
    if (!k) return;
    const m = e.shiftKey ? 3 : 1;
    const step: Record<string, Point> = { ArrowLeft: { angle: k.angle - 5 * m, d: k.d }, ArrowRight: { angle: k.angle + 5 * m, d: k.d }, ArrowUp: { angle: k.angle, d: k.d - 0.05 * m }, ArrowDown: { angle: k.angle, d: k.d + 0.05 * m } };
    if (!step[e.key]) return;
    e.preventDefault();
    e.stopPropagation();
    s.burst(moveKnob(s.state, 0, step[e.key]));
  });
  draw();

  return {
    el, knobs: knobEls, empty,
    /** Where the keys start: the key, or nothing while there's no colour. */
    focusable: () => (knobEls[0].style.display !== 'none' ? knobEls[0] : null),
    destroy() {
      offDraw();
      for (const off of offs.splice(0)) off();
      for (const a of added) a.remove();
      el.removeAttribute('m-dragging');
      el.style.removeProperty('--m-field-wheel');
    },
  };
}

// ---- the slider --------------------------------------------------------------------------------------------------

let clipIds = 0;

/** A slider in `el` for the intensity or the texture's amount, drawn as a wave or a bar. */
export function sliderControl(s: Session, el: HTMLElement, { value = 'intensity', variant = 'wave' }: { value?: SliderValue, variant?: SliderVariant } = {}) {
  const doc = el.ownerDocument;
  const offs: Off[] = [];
  const listen = listener(offs);
  const added: Element[] = [];
  const label = value === 'amount' ? WORDS.amount : WORDS.intensity;
  for (const [k, v] of Object.entries({ role: 'slider', tabindex: '0', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', title: label, 'm-value': value, 'm-variant': variant })) el.setAttribute(k, v);
  const get = (st: PickerState) => (value === 'amount' ? st.amount : st.intensity);
  const put = (st: PickerState, v: number) => (value === 'amount' ? setAmount(st, v) : setIntensity(st, v));
  // (Intensity ticks at each tenth; the amount at each of its steps.)
  const detent = (a: number, b: number) => (value === 'amount' ? a !== b : Math.floor(a * 10 + 1e-9) !== Math.floor(b * 10 + 1e-9));

  let wave: SVGSVGElement | null = null;
  let clips: SVGRectElement[] = [];
  let paths: SVGPathElement[] = [];
  let fill: HTMLElement | null = null;
  if (variant === 'wave') {
    wave = doc.createElementNS(SVG, 'svg') as SVGSVGElement;
    wave.setAttribute('m-wave', '');
    wave.setAttribute('aria-hidden', 'true');
    const id = `m-picker-wave-${++clipIds}`;
    const defs = doc.createElementNS(SVG, 'defs');
    clips = ['lit', 'dim'].map((k) => {
      const clip = doc.createElementNS(SVG, 'clipPath');
      clip.setAttribute('id', `${id}-${k}`);
      const rect = doc.createElementNS(SVG, 'rect') as SVGRectElement;
      rect.setAttribute('y', '-20');
      rect.setAttribute('height', '100');
      clip.append(rect);
      defs.append(clip);
      return rect;
    });
    paths = ['lit', 'dim'].map((k) => {
      const p = doc.createElementNS(SVG, 'path') as SVGPathElement;
      p.setAttribute(`m-${k}`, '');
      p.setAttribute('clip-path', `url(#${id}-${k})`);
      return p;
    });
    wave.append(defs, ...paths);
    el.append(wave);
    added.push(wave);
  } else {
    const track = make(doc, 'div', { 'm-track': '' });
    fill = make(doc, 'div', { 'm-fill': '' });
    track.append(fill);
    el.append(track);
    added.push(track);
  }
  const thumb = make(doc, 'div', { 'm-thumb': '' });
  el.append(thumb);
  added.push(thumb);

  const pad = () => (variant === 'wave' ? 16 : Math.max(2, (thumb.offsetWidth || 4) / 2));
  function draw() {
    const v = get(s.state), w = el.clientWidth || 180, h = el.clientHeight || 40, p = pad();
    const x = p + v * (w - 2 * p);
    if (wave) {
      const amp = h * 0.24 * v, phase = v * Math.PI * 5;
      let d = '';
      for (let px = p - 2; px <= w - p + 2; px += 2) d += `${d ? 'L' : 'M'}${px} ${(h / 2 + amp * Math.sin((px / 22) * 2 * Math.PI - phase)).toFixed(2)}`;
      wave.setAttribute('viewBox', `0 0 ${w} ${h}`);
      for (const path of paths) path.setAttribute('d', d);
      clips[0].setAttribute('width', String(Math.max(0, x)));
      clips[1].setAttribute('x', String(x));
      clips[1].setAttribute('width', String(Math.max(0, w - x)));
    }
    if (fill) fill.style.width = `${x.toFixed(2)}px`;
    thumb.style.transform = `translateX(${x.toFixed(2)}px)`;
    el.style.setProperty('--m-value', v.toFixed(3));
    el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    if (value === 'amount') el.setAttribute('aria-valuetext', `${TEXTURE_NAMES[s.state.texture]}, ${Math.round(v * 100)}%`);
  }
  const offDraw = s.onDraw(draw);
  function slide(v: number, how: (st: PickerState) => void) {
    const next = put(s.state, v);
    if (detent(get(s.state), get(next))) s.tick('detent');
    how(next);
  }
  const valueAt = (clientX: number) => { const b = el.getBoundingClientRect(), p = pad(); return (clientX - b.left - p) / (b.width - 2 * p); };
  listen(el, 'pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    s.settle();
    el.focus({ preventScroll: true });
    const move = (ev: PointerEvent) => slide(valueAt(ev.clientX), s.live);
    move(e);
    drag(el, e, move, () => s.commit(s.state));
  });
  listen(el, 'keydown', (e: KeyboardEvent) => {
    const now = get(s.state), step = value === 'amount' ? 1 / AMOUNT_STEPS : e.shiftKey ? 0.1 : 0.05;
    const to: Record<string, number> = { ArrowRight: now + step, ArrowUp: now + step, ArrowLeft: now - step, ArrowDown: now - step, Home: 0, End: 1 };
    if (!(e.key in to)) return;
    e.preventDefault();
    e.stopPropagation();
    slide(to[e.key], s.burst);
  });
  draw();

  return {
    el,
    destroy() {
      offDraw();
      for (const off of offs.splice(0)) off();
      for (const a of added) a.remove();
      el.style.removeProperty('--m-value');
    },
  };
}

// ---- the dial ----------------------------------------------------------------------------------------------------

/** What the dial's face shows for a texture (a tile of it). */
export function faceOf(doc: Document, t: Texture) {
  if (t === 'dots') return 'radial-gradient(circle, rgba(255,255,255,.6) 1px, transparent 1.4px) 0 0 / 7px 7px';
  if (t === 'grid') return 'linear-gradient(rgba(255,255,255,.4) 1px, transparent 1px) 0 0 / 8px 8px, linear-gradient(90deg, rgba(255,255,255,.4) 1px, transparent 1px) 0 0 / 8px 8px';
  const url = tileUrl(doc, t as TileTexture);
  const size = Math.round(TILE_SIZE[t as TileTexture] * 0.55);
  return url ? `url("${url}") 0 0 / ${size}px ${size}px repeat` : 'none';
}

/**
 * The dial in `el`: turn its ring to where the pointer is, drag its centre up or down, or scroll over it for the
 * amount; click it, press Return or Space on it, or swipe sideways over it for the next texture.
 */
export function dialControl(s: Session, el: HTMLElement) {
  const doc = el.ownerDocument;
  const offs: Off[] = [];
  const listen = listener(offs);
  for (const [k, v] of Object.entries({ role: 'slider', tabindex: '0', 'aria-label': WORDS.texture, 'aria-valuemin': '0', 'aria-valuemax': '100', title: WORDS.textureHint })) el.setAttribute(k, v);
  const dots = Array.from({ length: AMOUNT_STEPS + 1 }, () => make(doc, 'i', { 'm-dot': '' }));
  const pointer = make(doc, 'i', { 'm-pointer': '' });
  const face = make(doc, 'div', { 'm-face': '' });
  face.append(pointer);
  const shade = make(doc, 'div', { 'm-shade': '' });
  const label = make(doc, 'div', { 'm-dial-label': '' });
  el.append(...dots, face, shade, label);
  const added = [...dots, face, shade, label];

  const size = () => el.clientWidth || 88;
  let placedFor = 0;
  function placeDots() {
    const d = size();
    if (d === placedFor) return;
    placedFor = d;
    const ring = d / 2 - 4;
    dots.forEach((dot, i) => {
      const th = ((START + (i / AMOUNT_STEPS) * SWEEP) * Math.PI) / 180;
      dot.style.left = `${(d / 2 + Math.sin(th) * ring).toFixed(2)}px`;
      dot.style.top = `${(d / 2 - Math.cos(th) * ring).toFixed(2)}px`;
    });
  }
  let faceFor = '';
  function draw() {
    placeDots();
    const { amount: a, texture } = s.state;
    face.style.transform = `rotate(${START + a * SWEEP}deg)`;
    dots.forEach((d, i) => d.toggleAttribute('m-on', a > 0 && i / AMOUNT_STEPS <= a + 1e-9));
    if (faceFor !== texture) {
      faceFor = texture;
      face.setAttribute('m-texture', texture);
      el.style.setProperty('--m-face', faceOf(doc, texture));
    }
    const words = `${TEXTURE_NAMES[texture]}, ${Math.round(a * 100)}%`;
    label.textContent = words;
    el.setAttribute('aria-valuenow', String(Math.round(a * 100)));
    el.setAttribute('aria-valuetext', words);
  }
  const offDraw = s.onDraw(draw);
  function turnTo(v: number, how: (st: PickerState) => void) {
    const next = setAmount(s.state, v);
    if (next.amount === s.state.amount) return;
    s.tick('detent');
    how(next);
  }
  function nextTexture(dir: 1 | -1) { s.settle(); s.tick('texture'); s.commit(cycleTexture(s.state, dir)); }
  listen(el, 'pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    s.settle();
    el.focus({ preventScroll: true });
    const b = el.getBoundingClientRect();
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    // The ring: turned to where the pointer is; the centre: dragged up or down (a click: the next texture).
    const ring = Math.hypot(e.clientX - cx, e.clientY - cy) > (face.offsetWidth || size() * 0.64) / 2 + 2;
    const fromY = e.clientY, from = s.state.amount;
    let moved = false;
    el.setAttribute('m-turning', '');
    const move = (ev: PointerEvent) => {
      if (ring) {
        moved = true;
        const th = (Math.atan2(ev.clientX - cx, -(ev.clientY - cy)) * 180) / Math.PI;
        // (In the ring's gap at the bottom: the nearer end.)
        turnTo(th > -START || th < START ? (s.state.amount > 0.5 ? 1 : 0) : (th - START) / SWEEP, s.live);
      } else {
        const dy = fromY - ev.clientY;
        if (!moved && Math.abs(dy) < 4) return;
        moved = true;
        turnTo(from + dy / 150, s.live);
      }
    };
    if (ring) move(e);
    drag(el, e, move, () => {
      el.removeAttribute('m-turning');
      if (!ring && !moved) nextTexture(1); else s.commit(s.state);
    });
  });
  // Scrolling over it: up and down the amount, a step each 22 px; sideways (a swipe) the next texture.
  let ySum = 0, xSum = 0;
  listen(el, 'wheel', (e: WheelEvent) => {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : 1;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      xSum += e.deltaX * k;
      if (Math.abs(xSum) > 70) { const dir = xSum > 0 ? 1 : -1; xSum = 0; nextTexture(dir); }
      return;
    }
    ySum += e.deltaY * k;
    while (Math.abs(ySum) >= 22) {
      const step = ySum > 0 ? 1 : -1;
      ySum -= 22 * step;
      turnTo(s.state.amount + step / AMOUNT_STEPS, s.burst);
    }
  }, { passive: false });
  listen(el, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); nextTexture(1); return; }
    const to: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
    if (!(e.key in to)) return;
    e.preventDefault();
    e.stopPropagation();
    turnTo(s.state.amount + to[e.key] / AMOUNT_STEPS, s.burst);
  });
  draw();

  return {
    el, label,
    destroy() {
      offDraw();
      for (const off of offs.splice(0)) off();
      for (const a of added) a.remove();
      el.removeAttribute('m-turning');
      el.style.removeProperty('--m-face');
    },
  };
}
