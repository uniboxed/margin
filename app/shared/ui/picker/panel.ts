// Edit Theme Color: the panel (M2.9 step 4, docs/SPACE-BACKGROUNDS.md Part B §4), Margin's own, never the theme's.
// Arc's panel, in Margin's words and drawing: the appearance (automatic, light, dark) over a dotted field with the
// colours' knobs (−, + and the rule the others follow under it), pages of presets, the wavy slider (intensity) and the
// dial (the texture: turn its ring, drag its centre up or down, or scroll over it for the amount; click it, press
// Return or Space on it, or swipe sideways over it for the next texture), then Use for All Spaces and Done. The
// field, slider and dial are the shared controls (ui/picker/controls.ts), as a theme's own picker has them (step 5b:
// ui/picker/part.ts); this is the default, for a theme without one.
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
import { MAX_COLORS, PRESET_PAGES, addColor, pickPreset, removeColor, setAppearance, toggleWheel } from './model.ts';
import type { Appearance, PickerState } from './model.ts';
import { WORDS, createSession, dialControl, fieldControl, sliderControl } from './controls.ts';
import type { PanelEvents } from './controls.ts';

export { WORDS };
export type { PanelEvents, TickKind } from './controls.ts';

const TAG = 'margin-background-picker';
const PINNED = 'all:initial!important;position:fixed!important;inset:auto!important;margin:0!important;padding:0!important;border:0!important;'
  + 'background:transparent!important;display:block!important;z-index:2147483646!important;overflow:visible!important;'
  + 'opacity:1!important;visibility:visible!important;pointer-events:auto!important;transform:none!important;filter:none!important;';
const SVG = 'http://www.w3.org/2000/svg';
const W = 300; // the panel's width
const FIELD_H = 250;
const KEY = 52, OTHER = 34; // the knobs' sizes
const DIAL = 88, KNOB = 56; // the dial: its box, its knob

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
[m-picker-empty]{position:absolute;inset:0;display:grid;place-items:center;color:var(--fg2);pointer-events:none}
[m-knob]{position:absolute;left:0;top:0;width:${OTHER}px;height:${OTHER}px;margin:-${OTHER / 2}px 0 0 -${OTHER / 2}px;border-radius:50%;padding:3px;background:#fff;
box-shadow:0 2px 8px rgba(0,0,0,.3),0 0 0 .5px rgba(0,0,0,.2);transition:transform .45s cubic-bezier(.25,1.35,.45,1);z-index:1}
[m-knob=key]{width:${KEY}px;height:${KEY}px;margin:-${KEY / 2}px 0 0 -${KEY / 2}px;padding:5px;z-index:2}
[m-knob]>i{display:block;width:100%;height:100%;border-radius:50%;background:var(--m-knob-color);box-shadow:inset 0 0 0 .5px rgba(0,0,0,.14)}
.field[m-dragging] [m-knob],.field.still [m-knob]{transition:none}
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
.slider [m-lit]{opacity:.8}.slider [m-dim]{opacity:.22}
[m-thumb]{position:absolute;left:0;top:50%;width:14px;height:42px;margin:-21px 0 0 -7px;border-radius:7px;background:#fff;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.35),0 0 0 .5px rgba(0,0,0,.2)}
.dial{position:relative;width:${DIAL}px;height:${DIAL}px;flex:none;border-radius:50%;touch-action:none}
[m-dot]{position:absolute;width:4px;height:4px;margin:-2px;border-radius:50%;background:var(--fg);opacity:.2;pointer-events:none}
[m-dot][m-on]{opacity:.85}
[m-face],[m-shade]{position:absolute;left:50%;top:50%;width:${KNOB}px;height:${KNOB}px;margin:-${KNOB / 2}px;border-radius:50%;pointer-events:none}
[m-face]{background:var(--m-face,none);background-color:var(--face);box-shadow:0 3px 10px rgba(0,0,0,.32),inset 0 0 0 .5px rgba(255,255,255,.14);transition:transform .35s cubic-bezier(.25,1.3,.45,1)}
.dial[m-turning] [m-face]{transition:none}
[m-shade]{background:radial-gradient(circle at 34% 28%,rgba(255,255,255,.18),transparent 58%),radial-gradient(circle at 70% 80%,rgba(0,0,0,.16),transparent 60%)}
[m-pointer]{position:absolute;left:50%;top:-6px;width:6px;height:14px;margin-left:-3px;border-radius:3px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.45)}
[m-dial-label]{position:absolute;left:50%;bottom:-14px;transform:translateX(-50%);font-size:11px;color:var(--fg2);white-space:nowrap}
.foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 2px 0;border-top:.5px solid var(--line)}
.foot button{padding:6px 10px;border-radius:8px;font-size:12.5px}
.foot button:hover{background:var(--ctl)}
.foot .done{font-weight:600;background:var(--ctl)}
.foot .done:hover{background:var(--ctl-hover)}
@media (prefers-reduced-motion:reduce){[m-knob],[m-face]{transition:none}}
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

export function createPickerPanel({ doc, container, state: start, point, events, scale = () => 1 }: {
  doc: Document, container: ShadowRoot | Document, state: PickerState, point: { x: number, y: number }, events: PanelEvents,
  /** Margin's pixels per page pixel (the runtime's `scale`: the page's zoom, which the in-page host scales Margin back from). */
  scale?: () => number,
}) {
  const win = doc.defaultView!; // (a page that draws has a window)
  const s = createSession({ win, state: start, events });
  let page = Math.max(0, PRESET_PAGES.findIndex((p) => start.colors[0] && p.includes(start.colors[0])));
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
  const appearance = el('div', 'appearance', { role: 'radiogroup', 'aria-label': 'Appearance', 'data-no-field': '' }, ...appearanceButtons);
  const wheel = button('wheel', WORDS.wheel);
  const minus = button('', WORDS.remove, icon('minus', 18));
  const plus = button('', WORDS.add, icon('plus', 18));
  const fieldEl = el('div', 'field still', {}, appearance, el('div', 'bar', { 'data-no-field': '' }, wheel, el('div', 'pm', {}, minus, plus)));
  const prev = button('nav', WORDS.prev, icon('prev', 14));
  const next = button('nav', WORDS.next, icon('next', 14));
  const swatches = el('div', 'swatches', { role: 'radiogroup', 'aria-label': WORDS.presets });
  const presets = el('div', 'presets', {}, prev, swatches, next);
  const sliderEl = el('div', 'slider');
  const dialEl = el('div', 'dial');
  const all = button('all', WORDS.all, WORDS.all);
  const done = button('done', WORDS.done, WORDS.done);
  panel.append(fieldEl, presets, el('div', 'controls', {}, sliderEl, dialEl), el('div', 'foot', {}, all, done));
  shadow.append(style, place, panel);
  // (In the page as Margin's own: after the theme's root, as ui/background.ts's layer; shown in the top layer.)
  if (container.nodeType === 9) doc.documentElement.append(host);
  else (container as ShadowRoot).append(host);
  try { host.showPopover?.(); } catch { /* not in a document's top layer: it's fixed and lifted anyway */ }
  // (Laid out first: the controls measure their boxes.)
  const field = fieldControl(s, fieldEl, { variant: 'dots' });
  const slider = sliderControl(s, sliderEl, { value: 'intensity', variant: 'wave' });
  const dial = dialControl(s, dialEl);

  // ---- drawing -------------------------------------------------------------------------------------------------
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
    const state = s.state;
    for (const b of appearanceButtons) b.setAttribute('aria-checked', String(b.dataset.appearance === state.appearance));
    minus.disabled = state.colors.length === 0;
    plus.disabled = state.colors.length >= MAX_COLORS;
    wheel.style.display = state.colors.length > 1 ? '' : 'none';
    wheel.textContent = state.wheel === 'complementary' ? WORDS.complementary : WORDS.analogous;
    for (const b of swatches.children as HTMLCollectionOf<HTMLElement>) b.setAttribute('aria-checked', String(!!state.colors.length && b.dataset.color === state.colors[0]));
  }
  const offDraw = s.onDraw(draw);

  // Where it is: by the point it opened at (a menu's, a button's), kept in the window. The point and the window are in
  // the page's pixels, the panel placed in Margin's (`scale`), as Margin's menus are placed (ui/behaviors/menus.ts).
  function position() {
    const k = scale() || 1;
    // (Its box as drawn, fractions kept (offsetWidth rounds them), in Margin's pixels.)
    const r = panel.getBoundingClientRect();
    const w = r.width * k, h = r.height * k;
    const vw = win.innerWidth * k, vh = win.innerHeight * k;
    // (Whole pixels, rounded down from the far edge: a fractional size never takes it past the margin.)
    const x = Math.max(8, Math.floor(Math.min(point.x * k, vw - w - 8)));
    const y = Math.max(8, Math.floor(Math.min(point.y * k, vh - h - 8)));
    place.textContent = `:host{left:${x}px!important;top:${y}px!important}`;
  }

  // ---- the buttons -------------------------------------------------------------------------------------------------
  const click = (b: HTMLElement, fn: () => void) => listen(b, 'click', () => { s.settle(); fn(); });
  for (const b of appearanceButtons) click(b, () => { s.tick('appearance'); s.commit(setAppearance(s.state, b.dataset.appearance as Appearance)); });
  click(plus, () => { s.tick('step'); s.commit(addColor(s.state)); });
  click(minus, () => { s.tick('step'); s.commit(removeColor(s.state)); });
  click(wheel, () => { s.tick('step'); s.commit(toggleWheel(s.state)); });
  const turnPage = (dir: number) => { page = (page + dir + PRESET_PAGES.length) % PRESET_PAGES.length; drawSwatches(); draw(); };
  listen(prev, 'click', () => turnPage(-1));
  listen(next, 'click', () => turnPage(1));
  listen(swatches, 'click', (e: MouseEvent) => {
    const b = (e.target as Element).closest('button') as HTMLElement | null;
    if (!b?.dataset.color) return;
    s.settle();
    s.tick('step');
    s.commit(pickPreset(s.state, b.dataset.color));
  });
  listen(all, 'click', () => {
    s.settle();
    events.all(s.state);
    all.textContent = WORDS.allDone;
    const t = setTimeout(() => { all.textContent = WORDS.all; }, 1500);
    offs.push(() => clearTimeout(t));
  });
  click(done, () => events.done());
  listen(panel, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); s.drop(); events.escape(); return; }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); s.settle(); events.undo(); return; }
    if (e.key === 'Tab') {
      // (The keys stay in the panel.)
      const order = [...shadow.querySelectorAll('button:not([disabled]), [tabindex="0"]')].filter((x) => (x as HTMLElement).offsetParent !== null || x === field.knobs[0]) as HTMLElement[];
      const now = order.indexOf(shadow.activeElement as HTMLElement);
      const to = order[(now + (e.shiftKey ? -1 : 1) + order.length) % order.length];
      if (to) { e.preventDefault(); to.focus(); }
    }
  });
  listen(win, 'resize', () => { s.redraw(); position(); });

  drawSwatches();
  draw();
  position();
  win.requestAnimationFrame(() => fieldEl.classList.remove('still'));
  (field.focusable() ?? appearanceButtons[0]).focus({ preventScroll: true });

  return {
    /** Shows a state (an undo, the state's own value come back). */
    set(next: PickerState) { s.set(next); },
    get state() { return s.state; },
    /** Closing: what's drawn and not saved yet, saved (a burst, a drag cut off). */
    finish() { s.finish(); },
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
        panel: box(panel), field: box(fieldEl), slider: box(sliderEl), dial: box(dialEl),
        knobs: field.knobs.filter((k) => k.style.display !== 'none').map(box),
        appearance: appearanceButtons.map((b) => ({ ...box(b), value: b.dataset.appearance, checked: b.getAttribute('aria-checked') === 'true' })),
        minus: { ...box(minus), disabled: minus.disabled }, plus: { ...box(plus), disabled: plus.disabled },
        wheel: { ...box(wheel), shown: wheel.style.display !== 'none', text: wheel.textContent },
        swatches: [...swatches.children].map((b) => ({ ...box(b), color: (b as HTMLElement).dataset.color, checked: b.getAttribute('aria-checked') === 'true' })),
        prev: box(prev), next: box(next), all: { ...box(all), text: all.textContent }, done: box(done),
        empty: field.empty.style.display !== 'none', label: dial.label.textContent, focused: (shadow.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? null,
        dialValue: dialEl.getAttribute('aria-valuetext'), sliderValue: sliderEl.getAttribute('aria-valuenow'),
      };
    },
    destroy() {
      offDraw();
      field.destroy();
      slider.destroy();
      dial.destroy();
      s.destroy();
      for (const off of offs.splice(0)) off();
      try { host.hidePopover?.(); } catch { /* not shown as one */ }
      host.remove();
    },
  };
}
