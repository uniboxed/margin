// Split View's panes in Margin's own window (docs/PEEK-SPLIT.md §4): while the item in front is a pane of a split and
// a hosted window is in the page area (Margin.app's `pageHosted`), Margin puts the split's boxes in the page's place:
// `<m-page m-split="row|column" m-split-id>` holds one `<m-pane m-pane-id m-index [m-focused]>` per pane, flexed by the
// split's ratios, with an `<m-divider m-index>` between each two. They're Margin's own elements (a theme can't write
// them: ui/sanitize.ts), never drawn by the renderer's template; a theme styles them (the gap, the divider and its
// hover and drag, the focused pane's ring) by its CSS. The view measures each pane with the page (ui/render.ts
// View.measure: `split`, `panes`), and Margin.app places each pane's window at its box (HostedSession.swift).
//
// - A pane is never laid out below its window's own minimum (the app's `paneMin`: host-app.ts `paneMinimums`, the
//   engine's as learnt), nor below PANE_FLOOR: its box's `min-width` (side by side) or `min-height` (stacked).
// - A divider dragged: the two panes beside it change size with the pointer, at most once a frame, each stopping at
//   its minimum; the page measured and reported that frame (the app's windows follow it live: `split.resizing`, as a
//   drag of the sidebar's edge); let go, `split.resize` saves the ratios. Double-click: equal sizes. Focused (Tab),
//   ←/→ (↑/↓ stacked) move it 2% (⇧: 10%), Home/End to its ends, Enter makes them equal; each saved.
// - Nothing per frame but a drag's own frames; nothing at all while no split is shown (no listener does any work).
// - Adding a pane that can't fit (each pane's minimum and the gaps more than the page area): refused with a toast
//   (`refusesAdd`, runtime.ts dispatch). The sidebar's edge stops where the panes would no longer fit (`floor`,
//   behaviors/resize.ts).
import type { Rt } from '../runtime.ts';
import type { ViewModel } from '../view-model.ts';

/** The smallest a pane is laid out (Margin's points) when its window's own minimum isn't known yet. */
export const PANE_FLOOR = Object.freeze({ width: 200, height: 140 });
/** The gap between panes when the theme doesn't set `--m-split-gap`. */
export const SPLIT_GAP = 8;
const STEP = 0.02;
const BIG_STEP = 0.1;

type Split = NonNullable<ViewModel['split']>;

/** Each pane's floor along the axis (`row`: widths), from the app's minimums (by item id) and PANE_FLOOR. */
export function paneFloors(split: Pick<Split, 'axis' | 'panes'>, minimums: Record<string, [number, number]> = {}): number[] {
  const row = split.axis !== 'vertical';
  return split.panes.map((p) => {
    const m = minimums[String(p.id)];
    return Math.max(row ? PANE_FLOOR.width : PANE_FLOOR.height, m ? (row ? m[0] : m[1]) : 0);
  });
}

/**
 * The ratios after divider `index` moved `delta` px: the two panes beside it, each kept at its floor at least, the
 * others as they are. `sizes`: every pane's size now (px), `floors` each one's least.
 */
export function dragRatios(sizes: number[], floors: number[], index: number, delta: number): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (!(total > 0) || index < 0 || index >= sizes.length - 1) return sizes.map((s) => s / (total || 1));
  const pair = sizes[index] + sizes[index + 1];
  const lo = Math.min(floors[index] ?? 0, pair / 2);
  const hi = Math.max(pair - (floors[index + 1] ?? 0), pair / 2);
  const a = Math.min(hi, Math.max(lo, sizes[index] + delta));
  const next = [...sizes];
  next[index] = a;
  next[index + 1] = pair - a;
  return next.map((s) => s / total);
}

/** Equal ratios for `n` panes. */
export const equalRatios = (n: number) => Array.from({ length: n }, () => 1 / n);

/** Whether `count` panes with these floors fit along `room` px with the gaps between them. */
export function panesFit(floors: number[], room: number, gap = SPLIT_GAP) {
  return floors.reduce((a, b) => a + b, 0) + gap * Math.max(0, floors.length - 1) <= room + 0.5;
}

/**
 * What ⌃⇧= adds as a pane (Add Split View, decided 2026-11-21): the space's item used most recently, not the one in
 * front and not a pane of a split already (Arc pairs the tab you were on before), its row's id; null: none (the
 * palette opens to pick one: app/shared/host/overlay.ts).
 */
export function nextSplitPane(state: any, vm: ViewModel | null): number | string | null {
  if (!vm?.space) return null;
  const front = vm.tab?.id ?? null;
  const panes = new Set((vm.split?.panes ?? []).flatMap((p) => [String(p.id), String(p.tabId)]));
  const last = (id: number | string) => Number((typeof id === 'string' ? state?.keptTabs?.[id] : state?.tabs?.[id])?.lastActive) || 0;
  const rows = vm.space.today.filter((t) => t.id !== front && !t.active && !panes.has(String(t.id)) && !/^margin:/i.test(t.url ?? ''));
  return rows.sort((a, b) => last(b.id) - last(a.id))[0]?.id ?? null;
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;
const sameRatios = (a: number[] | null | undefined, b: number[] | null | undefined) => !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.002);

export function installSplit(rt: Rt) {
  const { view, doc } = rt;
  let drag: { el: Element, pointerId: number, index: number, start: number, sizes: number[], floors: number[], ratios: number[], told: boolean, split: string } | null = null;
  // The ratios drawn ahead of the state: a drag's, then the ones just saved until the state has them (or 2 s).
  let held: { split: string, ratios: number[], until: number } | null = null;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let laidOut = '';

  const host = () => rt.host as typeof rt.host & { appWindow?: boolean, pageHosted?: boolean, paneMinimums?: Record<string, [number, number]> };
  const page = () => view.pageEl as HTMLElement | null;
  /** The split shown here now: the item in front a pane of it, a window hosted in the page area. */
  const shown = (vm: ViewModel | null = rt.vm): Split | null => {
    const h = host();
    if (!h.appWindow || !h.pageHosted || !vm?.split || vm.window?.pageOutside) return null;
    return vm.split.panes.length >= 2 ? vm.split : null;
  };
  const panesOf = (el: HTMLElement) => [...el.children].filter((c) => c.localName === 'm-pane') as HTMLElement[];
  const dividersOf = (el: HTMLElement) => [...el.children].filter((c) => c.localName === 'm-divider') as HTMLElement[];
  const row = (split: Split) => split.axis !== 'vertical';
  const gapOf = (el: HTMLElement) => {
    const d = dividersOf(el)[0];
    if (!d) return SPLIT_GAP;
    const b = d.getBoundingClientRect();
    return el.getAttribute('m-split') === 'column' ? b.height : b.width;
  };

  function ratiosFor(split: Split): number[] {
    if (drag && drag.split === split.id) return drag.ratios;
    if (held && held.split === split.id) {
      if (Date.now() < held.until && !sameRatios(held.ratios, split.panes.map((p) => p.ratio))) return held.ratios;
      held = null;
    }
    return split.panes.map((p) => p.ratio);
  }

  // The page's place drawn as the split now: its panes, their order, ratios and minimums, the focused one; nothing new
  // written when nothing changed.
  function sync(vm: ViewModel | null) {
    const el = page();
    if (!el) return;
    const split = shown(vm);
    if (!split) {
      if (el.hasAttribute('m-split')) {
        el.removeAttribute('m-split');
        el.removeAttribute('m-split-id');
        for (const c of [...el.children]) if (c.localName === 'm-pane' || c.localName === 'm-divider') c.remove();
        laidOut = '';
        view.scheduleLayout();
      }
      return;
    }
    const ratios = ratiosFor(split);
    const floors = paneFloors(split, host().paneMinimums);
    const key = JSON.stringify([split.id, split.axis, split.panes.map((p) => [p.id, p.active]), ratios, floors]);
    if (key === laidOut) return;
    laidOut = key;
    const axis = row(split) ? 'row' : 'column';
    if (el.getAttribute('m-split') !== axis) el.setAttribute('m-split', axis);
    if (el.getAttribute('m-split-id') !== split.id) el.setAttribute('m-split-id', split.id);
    let panes = panesOf(el);
    let dividers = dividersOf(el);
    const n = split.panes.length;
    if (panes.length !== n || dividers.length !== n - 1) {
      for (const c of [...panes, ...dividers]) c.remove();
      panes = [];
      dividers = [];
      for (let i = 0; i < n; i++) {
        if (i > 0) {
          const d = doc.createElement('m-divider');
          d.setAttribute('m-index', String(i - 1));
          d.setAttribute('role', 'separator');
          d.setAttribute('tabindex', '0');
          d.setAttribute('aria-label', 'Resize panes');
          dividers.push(d);
          el.appendChild(d);
        }
        const p = doc.createElement('m-pane');
        p.setAttribute('m-index', String(i));
        panes.push(p);
        el.appendChild(p);
      }
    }
    let acc = 0;
    split.panes.forEach((pane, i) => {
      const p = panes[i];
      const id = String(pane.id);
      if (p.getAttribute('m-pane-id') !== id) p.setAttribute('m-pane-id', id);
      if (pane.active) { if (!p.hasAttribute('m-focused')) p.setAttribute('m-focused', ''); } else if (p.hasAttribute('m-focused')) p.removeAttribute('m-focused');
      const s = p.style;
      const grow = String(round4(ratios[i] ?? 1 / n));
      if (s.flexGrow !== grow) s.flexGrow = grow;
      const min = `${floors[i]}px`;
      const [on, off] = axis === 'row' ? ['min-width', 'min-height'] : ['min-height', 'min-width'];
      if (s.getPropertyValue(on) !== min) s.setProperty(on, min);
      if (s.getPropertyValue(off)) s.removeProperty(off);
      if (i < n - 1) {
        acc += ratios[i] ?? 1 / n;
        const d = dividers[i];
        const orient = axis === 'row' ? 'vertical' : 'horizontal';
        if (d.getAttribute('aria-orientation') !== orient) d.setAttribute('aria-orientation', orient);
        const now = String(Math.round(acc * 100));
        if (d.getAttribute('aria-valuenow') !== now) { d.setAttribute('aria-valuenow', now); d.setAttribute('aria-valuemin', '0'); d.setAttribute('aria-valuemax', '100'); }
      }
    });
    view.scheduleLayout();
  }

  // Each pane's size along the axis now (px), in order.
  const sizes = (el: HTMLElement, split: Split) => panesOf(el).map((p) => { const b = p.getBoundingClientRect(); return row(split) ? b.width : b.height; });
  const tell = (on: boolean) => { if (!on) view.flushLayout?.(); rt.host.perform?.('split.resizing', { on }); };
  const save = (split: Split, ratios: number[]) => {
    const norm = ratios.map(round4);
    held = { split: split.id, ratios: norm, until: Date.now() + 2000 };
    rt.dispatch('split.resize', { split: split.id, ratios: norm }, 'behavior');
  };
  // New ratios drawn now (a key, a double-click: no drag), measured and saved.
  const set = (split: Split, ratios: number[]) => {
    held = { split: split.id, ratios: ratios.map(round4), until: Date.now() + 2000 };
    sync(rt.vm);
    view.flushLayout?.();
    save(split, ratios);
  };

  const dividerAt = (target: EventTarget | null) => {
    const el = page();
    const d = (target as Element | null)?.closest?.('m-divider');
    return el && d && d.parentElement === el ? d : null;
  };

  rt.listen(rt.container, 'pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 || drag) return;
    const d = dividerAt(e.target);
    const split = shown();
    const el = page();
    if (!d || !split || !el) return;
    e.preventDefault();
    e.stopPropagation();
    try { d.setPointerCapture(e.pointerId); } catch {}
    const index = Number(d.getAttribute('m-index'));
    const now = sizes(el, split);
    const total = now.reduce((a, b) => a + b, 0) || 1;
    drag = { el: d, pointerId: e.pointerId, index, start: row(split) ? e.clientX : e.clientY, sizes: now, floors: paneFloors(split, host().paneMinimums), ratios: now.map((s) => s / total), told: false, split: split.id };
    d.setAttribute('m-dragging', '');
    view.rootElement()?.classList.add('m-split-resizing');
  }, true);
  rt.listen(rt.container, 'pointermove', (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const split = shown();
    if (!split || split.id !== drag.split) return;
    const k = rt.scale?.() || 1;
    const delta = ((row(split) ? e.clientX : e.clientY) - drag.start) * k;
    const next = dragRatios(drag.sizes, drag.floors, drag.index, delta);
    if (sameRatios(next, drag.ratios) && next.every((v, i) => v === drag!.ratios[i])) return;
    drag.ratios = next;
    if (!drag.told) { drag.told = true; tell(true); }
    // (At most once a frame: the newest wins, drawn and measured in that frame; a timer too, for a window that gets no
    // frames now, whichever comes first.)
    if (frame) return;
    const apply = () => {
      if (!frame) return;
      rt.win.cancelAnimationFrame(frame);
      rt.cancel(timer);
      frame = 0;
      if (!drag) return;
      sync(rt.vm);
      view.flushLayout?.();
    };
    frame = rt.win.requestAnimationFrame(apply);
    timer = rt.later(apply, 50);
  });
  const end = (e: PointerEvent) => {
    if (!drag || (e?.pointerId != null && e.pointerId !== drag.pointerId)) return;
    const { el, told, ratios, split: id } = drag;
    try { el.releasePointerCapture(e.pointerId); } catch {}
    el.removeAttribute('m-dragging');
    view.rootElement()?.classList.remove('m-split-resizing');
    if (frame) { rt.win.cancelAnimationFrame(frame); rt.cancel(timer); frame = 0; }
    drag = null;
    if (!told) return;
    held = { split: id, ratios: ratios.map(round4), until: Date.now() + 2000 };
    sync(rt.vm);
    tell(false);
    const split = shown();
    if (split && split.id === id) save(split, ratios);
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) rt.listen(rt.container, type, end);
  rt.listen(rt.container, 'dblclick', (e: MouseEvent) => {
    const split = shown();
    if (!dividerAt(e.target) || !split) return;
    e.preventDefault();
    e.stopPropagation();
    set(split, equalRatios(split.panes.length));
  });
  rt.listen(rt.container, 'keydown', (e: KeyboardEvent) => {
    const d = dividerAt(e.target);
    const split = shown();
    const el = page();
    if (!d || !split || !el || drag) return;
    const index = Number(d.getAttribute('m-index'));
    const now = sizes(el, split);
    const total = now.reduce((a, b) => a + b, 0) || 1;
    const floors = paneFloors(split, host().paneMinimums);
    const back = row(split) ? 'ArrowLeft' : 'ArrowUp';
    const on = row(split) ? 'ArrowRight' : 'ArrowDown';
    let delta: number | null = null;
    if (e.key === back) delta = -(e.shiftKey ? BIG_STEP : STEP) * total;
    else if (e.key === on) delta = (e.shiftKey ? BIG_STEP : STEP) * total;
    else if (e.key === 'Home') delta = -total;
    else if (e.key === 'End') delta = total;
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); return set(split, equalRatios(split.panes.length)); }
    if (delta == null) return;
    e.preventDefault();
    e.stopPropagation();
    set(split, dragRatios(now, floors, index, delta));
  });

  return {
    afterRender(vm: ViewModel) { if (!drag) sync(vm); },
    busy: () => drag != null,
    /** The page area's least width while a split is shown side by side (each pane's floor and the gaps): the sidebar's
     *  edge stops there (behaviors/resize.ts). 0: none. */
    floor() {
      const split = shown();
      const el = page();
      if (!split || !el) return 0;
      const floors = paneFloors(split, host().paneMinimums);
      return row(split) ? floors.reduce((a, b) => a + b, 0) + gapOf(el) * (floors.length - 1) : Math.max(...floors);
    },
    /**
     * Why `tabId` can't be added to the split shown (or split with the item in front), null: it can. Said as a toast.
     * Only in Margin's own window, where the panes are laid out; the library refuses the rest (4 panes, one space, an
     * app once).
     */
    refusesAdd(tabId: unknown): string | null {
      const h = host();
      const vm = rt.vm;
      const g = h.layout;
      if (!h.appWindow || !vm || !g) return null;
      const split = vm.split;
      const axis = split?.axis ?? 'horizontal';
      const ids = split ? split.panes.map((p) => String(p.id)) : [];
      if (split && split.panes.some((p) => p.tabId === tabId || String(p.id) === String(tabId))) return null;
      if (split && split.panes.length >= 4) return 'A split view has 4 panes at most';
      const panes = [...ids, String(tabId)];
      if (!split) panes.unshift('front');
      const floors = paneFloors({ axis, panes: panes.map((id) => ({ id })) as any }, h.paneMinimums);
      const room = axis === 'vertical' ? g.container.height - g.insets.top - g.insets.bottom : g.container.width - g.insets.left - g.insets.right;
      const el = page();
      return panesFit(floors, room, el ? gapOf(el) : SPLIT_GAP) ? null : 'Not enough room for another pane';
    },
    destroy() { if (frame) { rt.win.cancelAnimationFrame(frame); rt.cancel(timer); } },
  };
}
