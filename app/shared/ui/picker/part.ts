// Edit Theme Color drawn by the theme (M2.9 step 5b, themes README "Edit Theme Color"): its `background-picker` part
// in its `<m-picker>`, in place of Margin's own panel (ui/picker/panel.ts), with what the panel gives the behaviour
// that saves it (ui/behaviors/background-picker.ts: `set`, `state`, `rect`, `owns`, `parts`, `destroy`).
// - The part reads `picker` in the view model (ui/picker/view.ts), kept as the state changes: at each commit, an undo,
//   a page of presets (not each frame of a gesture: the controls draw those themselves).
// - Margin's elements in it are Margin's controls (ui/picker/controls.ts): the `<m-picker-field>`, each
//   `<m-picker-slider>` (its `m-value`), the `<m-picker-dial>`; mounted as they come and gone with them, their
//   attributes read as Margin reads them (ui/picker/elements.ts: an unknown variant is the default).
// - The theme's buttons run `picker.run` with an item's id (runItem: an appearance, a colour more or fewer, the rule,
//   a preset, a page, a texture, an amount, an intensity, Use for All Spaces, Done).
// - The slot is placed where the picker was asked from, kept inside the window (`--m-picker-x`, `--m-picker-y`, as
//   Margin's menus place theirs: ui/behaviors/menus.ts), given the keys as it opens; Escape, ⌘Z and Tab as the panel.
import { createSession, dialControl, fieldControl, sliderControl } from './controls.ts';
import type { PanelEvents } from './controls.ts';
import { PICKER_DIAL, PICKER_FIELD, PICKER_SLIDER, PICKER_SLOT, pickerAttr } from './elements.ts';
import type { FieldVariant, SliderValue, SliderVariant } from './elements.ts';
import { pageOf, runItem } from './view.ts';
import type { PickerUi } from './view.ts';
import type { PickerState } from './model.ts';
import type { Rt } from '../runtime.ts';

type Control = { el: Element, destroy: () => void };

/** Whether the theme drawn has its own picker: the part and the slot it goes in. */
export function themeHasPicker(rt: Pick<Rt, 'view'>): boolean {
  return !!rt.view.parts?.has('background-picker') && !!rt.view.rootElement()?.querySelector(PICKER_SLOT);
}

export function createPickerPart({ rt, spaceId, state: start, point, events }: {
  rt: Rt, spaceId: string, state: PickerState, point: { x: number, y: number }, events: PanelEvents,
}) {
  const win = rt.win;
  const s = createSession({ win, state: start, events });
  let ui: PickerUi = { spaceId, state: start, page: pageOf(start), all: false };
  let allTimer: ReturnType<typeof setTimeout> | null = null;
  let field: Control | null = null;
  const sliders = new Map<Element, Control>();
  const dials = new Map<Element, Control>();
  let keysOn: HTMLElement | null = null;
  let placed = '';
  let focused = false;
  let gone = false;

  const slot = () => (rt.view.rootElement()?.querySelector(PICKER_SLOT) ?? null) as HTMLElement | null;
  /** The view model's `picker` from the state as it is now (drawn by the runtime). */
  function sync() {
    if (gone) return;
    ui = { ...ui, state: s.state };
    rt.setUi({ picker: ui });
    mount();
  }
  const offDraw = s.onDraw((live) => { if (!live) sync(); });

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); s.drop(); events.escape(); return; }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); s.settle(); events.undo(); return; }
    if (e.key === 'Tab' && keysOn) {
      // (The keys stay in the picker.)
      const order = [...keysOn.querySelectorAll('button:not([disabled]), a[href], [tabindex="0"]')].filter((x) => (x as HTMLElement).offsetParent !== null) as HTMLElement[];
      const now = order.indexOf((keysOn.getRootNode() as Document | ShadowRoot).activeElement as HTMLElement);
      const to = order[(now + (e.shiftKey ? -1 : 1) + order.length) % order.length];
      if (to) { e.preventDefault(); to.focus(); }
    }
  }

  /** Margin's controls on Margin's elements in the part, as it's drawn now; the slot placed and given the keys. */
  function mount() {
    const sl = slot();
    if (!sl || gone) return;
    if (keysOn !== sl) {
      keysOn?.removeEventListener('keydown', onKey);
      keysOn = sl;
      sl.addEventListener('keydown', onKey);
    }
    const f = sl.querySelector(PICKER_FIELD) as HTMLElement | null;
    if (f !== field?.el) {
      field?.destroy();
      field = f ? fieldControl(s, f, { variant: pickerAttr(PICKER_FIELD, 'm-variant', f.getAttribute('m-variant')) as FieldVariant }) : null;
    }
    const swap = (map: Map<Element, Control>, selector: string, make: (el: HTMLElement) => Control) => {
      const now = new Set(sl.querySelectorAll(selector));
      for (const [el, c] of map) if (!now.has(el)) { c.destroy(); map.delete(el); }
      for (const el of now) if (!map.has(el)) map.set(el, make(el as HTMLElement));
    };
    swap(sliders, PICKER_SLIDER, (el) => sliderControl(s, el, {
      value: pickerAttr(PICKER_SLIDER, 'm-value', el.getAttribute('m-value')) as SliderValue,
      variant: pickerAttr(PICKER_SLIDER, 'm-variant', el.getAttribute('m-variant')) as SliderVariant,
    }));
    swap(dials, PICKER_DIAL, (el) => dialControl(s, el));
    place(sl);
    if (!focused && sl.firstElementChild) {
      focused = true;
      sl.tabIndex = -1;
      const key = sl.querySelector('[m-knob="key"]') as HTMLElement | null;
      const first = key && key.style.display !== 'none' ? key : sl.querySelector('button:not([disabled]), [tabindex="0"]') as HTMLElement | null;
      (first ?? sl).focus({ preventScroll: true });
    }
  }
  // Where it was asked from, kept inside the window (the point in the page's pixels, placed in Margin's: rt.scale).
  function place(sl: HTMLElement) {
    const box = (sl.firstElementChild as HTMLElement | null) ?? sl;
    // (Its box as drawn, fractions kept (offsetWidth rounds them), in Margin's pixels.)
    const k = rt.scale?.() || 1, r = box.getBoundingClientRect(), w = r.width * k, h = r.height * k;
    const key = `${point.x}:${point.y}:${w}:${h}:${k}:${win.innerWidth}:${win.innerHeight}`;
    if (key === placed) return;
    placed = key;
    const x = Math.max(8, Math.floor(Math.min(point.x * k, win.innerWidth * k - w - 8)));
    const y = Math.max(8, Math.floor(Math.min(point.y * k, win.innerHeight * k - h - 8)));
    sl.style.setProperty('--m-picker-x', `${x}px`);
    sl.style.setProperty('--m-picker-y', `${y}px`);
  }
  const onResize = () => { s.redraw(); };
  win.addEventListener('resize', onResize);

  sync();

  return {
    /** Shows a state (an undo, the state's own value come back). */
    set(next: PickerState) { s.set(next); },
    get state() { return s.state; },
    /** Closing: what's drawn and not saved yet, saved (a burst, a drag cut off). */
    finish() { s.finish(); },
    /** A theme's button: one of the picker's items (`picker.run`, checked against the items before it comes here). */
    run(id: string) {
      const r = runItem({ ...ui, state: s.state }, id);
      if (!r) return false;
      if (r.kind === 'commit') { s.settle(); s.tick(r.tick); s.commit(r.state); return true; }
      if (r.kind === 'page') { ui = { ...ui, page: r.page }; sync(); return true; }
      s.settle();
      if (r.kind === 'done') { events.done(); return true; }
      events.all(s.state);
      ui = { ...ui, all: true };
      sync();
      if (allTimer) clearTimeout(allTimer);
      allTimer = setTimeout(() => { allTimer = null; ui = { ...ui, all: false }; sync(); }, 1500);
      return true;
    },
    /** Drawn again (the runtime's render): its controls on what's there now. */
    afterRender() { mount(); },
    /** Its box in the window's pixels, [x, y, width, height] (what Margin.app is told takes the pointer). */
    rect(): number[] | null {
      const sl = slot();
      const box = (sl?.firstElementChild as HTMLElement | null) ?? null;
      if (!box || !box.isConnected) return null;
      const r = box.getBoundingClientRect();
      if (!r.width && !r.height) return null;
      return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2) / 2);
    },
    /** Whether an event's target is in the picker. */
    owns: (target: EventTarget | null) => !!target && !!slot()?.contains(target as Node),
    /** Each part's box and state, for the tests. */
    parts() {
      const sl = slot();
      const box = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
      const f = field?.el as HTMLElement | undefined;
      return {
        themed: true,
        panel: sl?.firstElementChild ? box(sl.firstElementChild) : null,
        field: f ? box(f) : null,
        variant: f?.getAttribute('m-variant') ?? null,
        knobs: f ? [...f.querySelectorAll('[m-knob]')].filter((k) => (k as HTMLElement).style.display !== 'none').map(box) : [],
        empty: f ? (f.querySelector('[m-picker-empty]') as HTMLElement | null)?.style.display !== 'none' : null,
        sliders: [...sliders.keys()].map((el) => ({ ...box(el), value: el.getAttribute('m-value'), variant: el.getAttribute('m-variant'), now: el.getAttribute('aria-valuenow') })),
        dials: [...dials.keys()].map((el) => ({ ...box(el), value: el.getAttribute('aria-valuetext') })),
        focused: ((sl?.getRootNode() as Document | ShadowRoot | undefined)?.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? null,
        page: ui.page,
      };
    },
    destroy() {
      if (gone) return;
      gone = true;
      offDraw();
      field?.destroy();
      field = null;
      for (const c of [...sliders.values(), ...dials.values()]) c.destroy();
      sliders.clear();
      dials.clear();
      keysOn?.removeEventListener('keydown', onKey);
      keysOn = null;
      win.removeEventListener('resize', onResize);
      if (allTimer) clearTimeout(allTimer);
      s.destroy();
      rt.setUi({ picker: null });
    },
  };
}
