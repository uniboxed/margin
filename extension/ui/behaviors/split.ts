// Split View's panes in Margin's own window (docs/PEEK-SPLIT.md §4): while the item in front is a pane of a split and
// a hosted window is in the page area (Margin.app's `pageHosted`), Margin puts the split's boxes in the page's place:
// `<m-page m-split="row|column" m-split-id>` holds one `<m-pane m-pane-id m-index [m-focused]>` per pane, flexed by the
// split's ratios, with an `<m-divider m-index>` between each two. They're Margin's own elements (a theme can't write
// them: ui/sanitize.ts), never drawn by the renderer's template; a theme styles them (the gap, the divider and its
// hover and drag, the focused pane's ring) by its CSS. The view measures each pane with the page (ui/render.ts
// View.measure: `split`, `panes`), and Margin.app places each pane's window at its box (HostedSession.swift).
//
// - A pane is never laid out below Arc's least, PANE_FLOOR (220 pt, `minimumPaneWidth` in Arc 1.174.0's split view, also
//   its least height stacked): its box's `min-width` (side by side) or `min-height` (stacked). Its window may need more:
//   Margin.app shows it cut, its window at its own minimum, the rest hidden (docs/PEEK-SPLIT.md §4b, arrows to see it).
// - A divider dragged: the two panes beside it change size with the pointer, at most once a frame, each stopping at
//   220; within SNAP (14 pt) of an even split of the two, they're even (Arc's), with Margin's alignment haptic as it
//   snaps when the drag is slow (Arc's: 120 pt/s at most); the page measured and reported that frame (the app's windows follow it live: `split.resizing`, as a
//   drag of the sidebar's edge); let go, `split.resize` saves the ratios. Double-click: equal sizes. Focused (Tab),
//   ←/→ (↑/↓ stacked) move it 2% (⇧: 10%), Home/End to its ends, Enter makes them equal; each saved.
// - Nothing per frame but a drag's own frames; nothing at all while no split is shown (no listener does any work).
// - Stacked, the gap above a pane hosted in a Safari window (a web item's) is a band at least SAFARI_TOOLBAR tall
//   (`<m-divider m-band>`, the pane's name in its `<m-band-title>`): Safari's full-screen toolbar window rests just
//   above its window, and is drawn whenever its window was raised after the pane above (the focused pane is raised
//   last); in the band it rests under Margin's opaque ground, never in the hole of the pane above. That toolbar window
//   is never moved or parked (it broke Safari's full screen: DECISIONS.md). Side by side, the toolbars rest under
//   Margin's top frame, as one window's does: no band.
// - A pane whose window is opening beside the panes shown (Margin.app's `paneLoading`: its item): `<m-pane m-loading>`
//   with Margin's loader in it (`<m-pane-loader>`: a spinner, "Opening …"), over that pane's box only; the other panes
//   stay shown and usable (never the page card's loader over the whole page area).
// - Adding a pane that can't fit (each pane's minimum and the gaps, bands counted, more than the page area): refused
//   with a toast before anything is opened (`refusesAdd`, runtime.ts dispatch); so is stacking (or unstacking) panes
//   that wouldn't fit along the other axis (`refusesAxis`). The sidebar's edge stops where the panes would no longer fit
//   (`floor`, behaviors/resize.ts).
import { frontItemOf } from '../../shared/front-item.ts';
import type { Rt } from '../runtime.ts';
import type { ViewModel } from '../view-model.ts';

/** The smallest a pane is laid out (Margin's points): Arc's split view's `minimumPaneWidth`, 220, its least height
 *  stacked too (read from Arc 1.174.0's binary, 2026-11-21). */
export const PANE_FLOOR = Object.freeze({ width: 220, height: 220 });
/** A divider dragged within this of an even split of its two panes: even (Arc's, pt). */
export const SNAP = 14;
/** The fastest a drag snaps with the haptic (Arc's, pt/s). */
export const SNAP_HAPTIC_SPEED = 120;
/** The gap between panes when the theme doesn't set `--m-split-gap`. */
export const SPLIT_GAP = 8;
/** Safari's full-screen toolbar window's height (pt; measured on the real screen 2026-11-21: 1264×52 resting just above
 *  its window, its toolbar hidden). Margin.app's engine doesn't say it to the page (it never touches that window). */
export const SAFARI_TOOLBAR = 52;
const STEP = 0.02;
const BIG_STEP = 0.1;

type Split = NonNullable<ViewModel['split']>;

/** The app a pane's window is of, as Margin.app names its known minimums (`appMin`): an app's bundle id, `web` for a
 *  web page (Safari's, the one browser hosted beside others). */
export function appKeyOf(url: unknown): string {
  const m = /^app:\/\/([^/?#]+)/i.exec(String(url ?? ''));
  return m ? m[1] : 'web';
}

/** Each pane's floor along the axis: Arc's least, PANE_FLOOR, whatever its window needs (that's shown cut). */
export function paneFloors(split: { axis: string, panes: readonly unknown[] }): number[] {
  const least = split.axis !== 'vertical' ? PANE_FLOOR.width : PANE_FLOOR.height;
  return split.panes.map(() => least);
}

/**
 * The ratios after divider `index` moved `delta` px: the two panes beside it, each kept at its floor at least, the
 * others as they are. `sizes`: every pane's size now (px), `floors` each one's least.
 */
export function dragRatios(sizes: number[], floors: number[], index: number, delta: number, snap = 0): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (!(total > 0) || index < 0 || index >= sizes.length - 1) return sizes.map((s) => s / (total || 1));
  const pair = sizes[index] + sizes[index + 1];
  const lo = Math.min(floors[index] ?? 0, pair / 2);
  const hi = Math.max(pair - (floors[index + 1] ?? 0), pair / 2);
  let a = Math.min(hi, Math.max(lo, sizes[index] + delta));
  // (Within `snap` of an even split of the two: even, Arc's.)
  if (snap > 0 && Math.abs(a - pair / 2) <= snap) a = pair / 2;
  const next = [...sizes];
  next[index] = a;
  next[index + 1] = pair - a;
  return next.map((s) => s / total);
}

/** Equal ratios for `n` panes. */
export const equalRatios = (n: number) => Array.from({ length: n }, () => 1 / n);

/** A pane hosted in a Safari window: a web item's (not a Mac app's, nor one of Margin's own pages). */
export const inSafari = (pane: { url?: string | null }) => { const u = String(pane?.url ?? ''); return u !== '' && !/^(app|margin):/i.test(u); };
/** Each divider's size along the axis (px): stacked, the band above a pane in Safari (its toolbar's height, or the gap
 *  if that's more), else the gap. */
export function dividerSizes(split: { axis: string, panes: { url?: string | null }[] }, gap = SPLIT_GAP, band = SAFARI_TOOLBAR): number[] {
  const column = split.axis === 'vertical';
  return split.panes.slice(1).map((p) => (column && inSafari(p) ? Math.max(gap, band) : gap));
}

/** Whether `count` panes with these floors fit along `room` px with the gaps between them (`gap`: one for every
 *  divider, or each divider's own: `dividerSizes`). */
export function panesFit(floors: number[], room: number, gap: number | number[] = SPLIT_GAP) {
  const gaps = Array.isArray(gap) ? gap.reduce((a, b) => a + b, 0) : gap * Math.max(0, floors.length - 1);
  return floors.reduce((a, b) => a + b, 0) + gaps <= room + 0.5;
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
  let drag: { el: Element, pointerId: number, index: number, start: number, sizes: number[], floors: number[], ratios: number[], told: boolean, split: string, snapped: boolean, at: number, pos: number, speed: number } | null = null;
  // The ratios drawn ahead of the state: a drag's, then the ones just saved until the state has them (or 2 s).
  let held: { split: string, ratios: number[], until: number } | null = null;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let laidOut = '';

  const host = () => rt.host as typeof rt.host & { appWindow?: boolean, pageHosted?: boolean, paneMinimums?: Record<string, [number, number]>, appMinimums?: Record<string, [number, number]>, paneLoading?: { item: string, name: string } | null, note?: (text: string) => void };
  const floorsOf = (split: { axis: string, panes: readonly unknown[] }) => paneFloors(split);
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
  // The theme's gap: a plain divider's size (a band is the toolbar's), else its `--m-split-gap`.
  const gapOf = (el: HTMLElement) => {
    const d = dividersOf(el).find((x) => !x.hasAttribute('m-band'));
    if (!d) {
      const v = parseFloat(rt.win.getComputedStyle(el).getPropertyValue('--m-split-gap'));
      return Number.isFinite(v) && v > 0 ? v : SPLIT_GAP;
    }
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

  // A pane's own loader while its window opens (`name`: what's opening; null: none): Margin's elements, its words.
  function loader(p: HTMLElement, name: string | null) {
    let el = [...p.children].find((c) => c.localName === 'm-pane-loader') as HTMLElement | undefined;
    if (name == null) {
      if (p.hasAttribute('m-loading')) p.removeAttribute('m-loading');
      el?.remove();
      return;
    }
    if (!p.hasAttribute('m-loading')) p.setAttribute('m-loading', '');
    if (!el) {
      el = doc.createElement('m-pane-loader');
      el.setAttribute('role', 'status');
      el.appendChild(doc.createElement('m-pane-spinner'));
      el.appendChild(doc.createElement('m-pane-label'));
      p.appendChild(el);
    }
    const label = el.querySelector('m-pane-label')!;
    const text = name ? `Opening ${name}…` : 'Opening…';
    if (label.textContent !== text) label.textContent = text;
  }

  // A divider as the band above a Safari pane (stacked): `m-band`, at least the toolbar's height, the pane's name in it
  // (Margin's own text, never markup); `pane` null: a plain divider again.
  function band(d: HTMLElement, pane: Split['panes'][number] | null) {
    let title = [...d.children].find((c) => c.localName === 'm-band-title') as HTMLElement | undefined;
    if (!pane) {
      if (d.hasAttribute('m-band')) d.removeAttribute('m-band');
      if (d.style.getPropertyValue('flex-basis')) d.style.removeProperty('flex-basis');
      title?.remove();
      return;
    }
    if (!d.hasAttribute('m-band')) d.setAttribute('m-band', '');
    const basis = `max(var(--m-split-gap, ${SPLIT_GAP}px), ${SAFARI_TOOLBAR}px)`;
    if (d.style.getPropertyValue('flex-basis') !== basis) d.style.setProperty('flex-basis', basis);
    if (!title) { title = doc.createElement('m-band-title'); title.setAttribute('aria-hidden', 'true'); d.appendChild(title); }
    const text = pane.host && pane.title && pane.title !== pane.host ? `${pane.title} — ${pane.host}` : pane.title || pane.host || '';
    if (title.textContent !== text) title.textContent = text;
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
    const floors = floorsOf(split);
    const opening = host().paneLoading ?? null;
    const key = JSON.stringify([split.id, split.axis, split.panes.map((p) => [p.id, p.active, p.url, p.title, p.host]), ratios, floors, opening]);
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
      loader(p, opening && opening.item === id ? opening.name : null);
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
        band(d, axis === 'column' && inSafari(split.panes[i + 1]) ? split.panes[i + 1] : null);
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
    drag = { el: d, pointerId: e.pointerId, index, start: row(split) ? e.clientX : e.clientY, sizes: now, floors: floorsOf(split), ratios: now.map((s) => s / total), told: false, split: split.id, snapped: false, at: e.timeStamp, pos: row(split) ? e.clientX : e.clientY, speed: 0 };
    d.setAttribute('m-dragging', '');
    view.rootElement()?.classList.add('m-split-resizing');
  }, true);
  rt.listen(rt.container, 'pointermove', (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const split = shown();
    if (!split || split.id !== drag.split) return;
    const k = rt.scale?.() || 1;
    const pos = row(split) ? e.clientX : e.clientY;
    const delta = (pos - drag.start) * k;
    // (Its speed (pt/s) from the move before: the snap's haptic only for a slow drag, Arc's.)
    const dt = (e.timeStamp - drag.at) / 1000;
    if (dt > 0) { drag.speed = Math.abs(pos - drag.pos) * k / dt; drag.at = e.timeStamp; drag.pos = pos; }
    const next = dragRatios(drag.sizes, drag.floors, drag.index, delta, SNAP);
    const total = drag.sizes.reduce((a, b) => a + b, 0);
    const pairNow = (next[drag.index] + next[drag.index + 1]) * total;
    const snapped = Math.abs(next[drag.index] * total - pairNow / 2) < 0.5 && Math.abs(drag.sizes[drag.index] + delta - pairNow / 2) > 0.5;
    if (snapped && !drag.snapped && drag.speed <= SNAP_HAPTIC_SPEED) rt.host.perform?.('haptic.alignment');
    drag.snapped = snapped;
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
    const floors = floorsOf(split);
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
      const floors = floorsOf(split);
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
      const st: any = rt.state;
      // (Every library item of the state as the library has them: the closed ones (`keptTabs`), and the ones open in
      // Margin's window, which the app puts there as rows of a number instead (HostedSession `liveTab`: `mid` the item,
      // its `lastActive` the item's). The real screen's add, 2026-11-21: the Safari tab and Notes both open, so neither
      // was found among the kept ones and the pair was guessed.)
      const items: Record<string, { id: string, url: string, spaceId: unknown, lastActive: unknown, wasActive: boolean }> = {};
      for (const k of Object.values(st?.keptTabs ?? {}) as any[]) if (k && typeof k.id === 'string') items[k.id] = { id: k.id, url: String(k.url ?? ''), spaceId: k.spaceId, lastActive: k.lastActive, wasActive: !!k.wasActive };
      for (const t of Object.values(st?.tabs ?? {}) as any[]) {
        if (t && typeof t.mid === 'string' && !items[t.mid]) items[t.mid] = { id: t.mid, url: String(t.url ?? ''), spaceId: st?.tabSpace?.[t.id], lastActive: t.lastActive, wasActive: !!t.active };
      }
      // (Its item: by its id, or, open in Margin's window, by its row's number (the menu names it so): that row's `mid`.)
      const mid = typeof tabId === 'string' ? tabId : typeof tabId === 'number' ? st?.tabs?.[tabId]?.mid : null;
      const item = typeof mid === 'string' ? items[mid] ?? null : null;
      let axis = 'horizontal';
      let panes: { id: string, url: string }[];
      if (item) {
        // (A library item, Margin.app's: what the library makes of it, `addToSplit`: added to the split of the item used
        // last in its space (not itself), or a new split of that one and it, in that order. Each pane's address names its
        // app for its known minimum (`appMin`, known before its window exists) and its band, stacked.)
        const partner = frontItemOf(Object.values(items), item.spaceId, item.id);
        if (!partner) return null; // (the library's to refuse: no second item)
        const group = ((st?.splits ?? []) as { panes: string[], axis?: string }[]).find((g) => g.panes.includes(partner.id)) ?? null;
        if (group?.panes.includes(item.id)) return null;
        if (group && group.panes.length >= 4) return 'A split view has 4 panes at most';
        axis = group?.axis === 'vertical' ? 'vertical' : 'horizontal';
        panes = [...(group ? group.panes : [partner.id]).map((id) => ({ id: String(id), url: items[id]?.url ?? '' })), { id: item.id, url: item.url }];
      } else {
        // (A browser's tab: the split shown, or the tab in front, and it.)
        const split = vm.split;
        axis = split?.axis ?? 'horizontal';
        if (split && split.panes.some((p) => p.tabId === tabId || String(p.id) === String(tabId))) return null;
        if (split && split.panes.length >= 4) return 'A split view has 4 panes at most';
        const url = typeof tabId === 'number' ? st?.tabs?.[tabId]?.url ?? '' : '';
        panes = [
          ...(split ? split.panes.map((p) => ({ id: String(p.id), url: p.url ?? '' })) : [{ id: String(vm.tab?.id ?? 'front'), url: vm.tab?.url ?? '' }]),
          { id: String(tabId), url },
        ];
      }
      const ok = fits(axis, panes, true);
      return ok ? null : 'Not enough room for another pane';
    },
    /**
     * Why the split shown can't be stacked (or put side by side) now, null: it can: its panes along the other axis,
     * each at its minimum, wouldn't fit the page area. Said as a toast.
     */
    refusesAxis(splitId: unknown): string | null {
      const h = host();
      const split = rt.vm?.split;
      if (!h.appWindow || !split || !h.layout || (splitId != null && String(splitId) !== split.id)) return null;
      const axis = split.axis === 'vertical' ? 'horizontal' : 'vertical';
      return fits(axis, split.panes.map((p) => ({ id: String(p.id), url: p.url ?? '' }))) ? null
        : axis === 'vertical' ? 'Not enough room to stack these panes' : 'Not enough room for these panes side by side';
    },
    destroy() { if (frame) { rt.win.cancelAnimationFrame(frame); rt.cancel(timer); } },
  };

  // Whether these panes (in order), each at its floor, fit the page area along `axis` with the gaps between them (bands
  // above Safari panes counted, stacked).
  // `said`: the check told to Margin.app's log (an add: each pane's app and floor, the room, the answer), to read the
  // real screen's inputs back (2026-11-21 19:32: Notes let in beside a Safari tab where they couldn't fit).
  function fits(axis: string, panes: { id: string, url: string }[], said = false) {
    const g = host().layout;
    if (!g) { if (said) host().note?.(`split add: no layout from Margin.app yet: let through (${panes.length} panes)`); return true; }
    const floors = floorsOf({ axis, panes });
    const room = axis === 'vertical' ? g.container.height - g.insets.top - g.insets.bottom : g.container.width - g.insets.left - g.insets.right;
    const el = page();
    const gaps = dividerSizes({ axis, panes }, el ? gapOf(el) : SPLIT_GAP);
    const ok = panesFit(floors, room, gaps);
    if (said) host().note?.(`split add: ${panes.map((p, i) => `${appKeyOf(p.url)}${p.url ? '' : ' (no address)'} ${floors[i]}`).join(' + ')} + gaps ${(Array.isArray(gaps) ? gaps : [gaps]).join('/')} in ${Math.round(room)} (${axis}): ${ok ? 'fits' : 'refused'}; apps known: ${Object.keys(host().appMinimums ?? {}).join(', ') || 'none'}`);
    return ok;
  }
}
