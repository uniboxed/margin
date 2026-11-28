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
// - A cut pane (Margin.app's `paneCut`: its window wider or taller than its box, at its own minimum, the rest past the
//   display's edge, under the sidebar or under the pane beside it, docs/PEEK-SPLIT.md §4b) opens to fit its app
//   (docs/FLEX-SPLIT.md step 1): after the pointer rests on it EXPAND_DWELL (Margin.app's `paneHover`, said as the
//   pointer enters and leaves a cut pane), or at once when it's pressed (it becomes the focused pane); Settings'
//   `splitExpand` 'click': on a press only. It gets its app's minimum along the axis (`expandSizes`), the others fold
//   (`m-pane[m-folded]`, each with Margin's `<m-pane-card>`: `<m-pane-icon>` and `<m-pane-name>`, over the app's window
//   blurred behind it by Margin.app), moving there over EXPAND_TIME through the drag's own path (`split.resizing`). A
//   folded card takes the pointer (`hitRects`): resting on one opens it, pressing one opens and focuses it. The pointer
//   resting on Margin's own UI outside the page EXPAND_LEAVE puts the split back (hover only); a press on a pane that
//   fits puts it back (click only); a divider dragged keeps the sizes shown. The ratios are never saved for it.
// - Adding a pane that can't fit (each pane's minimum and the gaps, bands counted, more than the page area): refused
//   with a toast before anything is opened (`refusesAdd`, runtime.ts dispatch); so is stacking (or unstacking) panes
//   that wouldn't fit along the other axis (`refusesAxis`). The sidebar's edge stops where the panes would no longer fit
//   (`floor`, behaviors/resize.ts).
import { frontItemOf } from '../../../../extension/shared/front-item.ts';
import type { Rt } from '../runtime.ts';
import type { ViewModel } from '../view-model.ts';
import { checkIconUrl } from '../sanitize.ts';

/** The smallest a pane is laid out (Margin's points): Arc's split view's `minimumPaneWidth`, 220, its least height
 *  stacked too (read from Arc 1.174.0's binary, 2026-11-21). */
export const PANE_FLOOR = Object.freeze({ width: 220, height: 220 });
/** A folded pane's least size along the split's axis while another pane is opened to fit its app (pt): room for its
 *  card's icon and a short name (docs/FLEX-SPLIT.md step 1). */
export const PANE_FOLD = 64;
/** How long the pointer rests on a cut pane (or a folded one) before it opens (ms; the prototype's, Arc's kind of
 *  pause: the person's intent, no state waited on). */
export const EXPAND_DWELL = 300;
/** How long the pointer rests on Margin's own UI outside the page before an opened pane folds back (ms). */
export const EXPAND_LEAVE = 450;
/** A pane's opening or the split's going back, eased out (ms). */
export const EXPAND_TIME = 200;
/** A divider dragged within this of an even split of its two panes: even (Arc's, pt). */
export const SNAP = 14;
/** The fastest a drag snaps with the haptic (Arc's, pt/s). */
export const SNAP_HAPTIC_SPEED = 120;
/** The gap between panes when the theme doesn't set `--m-split-gap`. */
export const SPLIT_GAP = 8;
/** Safari's full-screen toolbar window's height (pt; measured on the real screen 2026-11-21: 1264×52 resting just above
 *  its window, its toolbar hidden). Margin.app's engine doesn't say it to the page (it never touches that window).
 *  A copy of margin-core's `TOOLBAR_ROOM` (app/shared/core/src/host/layout.rs): keep the two equal until the build
 *  writes the core's constants out for the UI. */
export const SAFARI_TOOLBAR = 52;
const STEP = 0.02;
type PaneCut = { window: number };
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

/**
 * Each pane's size with pane `index` opened to fit its app (docs/FLEX-SPLIT.md step 1): it gets its app's minimum along
 * the axis (`needs`, null: not known), at most the room less PANE_FOLD for each other pane; the others share what's
 * left by their sizes now, none below PANE_FOLD. `sizes`: each pane's size now (px, the gaps not counted). Nothing
 * changes when it fits already, its need isn't known, or there's nothing to share.
 */
export function expandSizes(sizes: number[], needs: (number | null | undefined)[], index: number, fold = PANE_FOLD): number[] {
  const n = sizes.length;
  const total = sizes.reduce((a, b) => a + b, 0);
  const need = needs[index];
  if (n < 2 || index < 0 || index >= n || !(total > 0) || need == null || !(need > 0)) return [...sizes];
  const want = Math.min(need, total - fold * (n - 1));
  if (sizes[index] >= want - 0.5) return [...sizes];
  const out = [...sizes];
  out[index] = want;
  // (What's left shared by the others' sizes, any whose share falls below the fold held there and the rest shared again.)
  let free = sizes.map((_, i) => i).filter((i) => i !== index);
  let rest = total - want;
  for (;;) {
    const weight = free.reduce((a, i) => a + Math.max(0, sizes[i]), 0);
    const share = (i: number) => (weight > 0 ? rest * Math.max(0, sizes[i]) / weight : rest / free.length);
    const low = free.filter((i) => share(i) < fold);
    if (!low.length) { for (const i of free) out[i] = share(i); return out; }
    for (const i of low) out[i] = fold;
    rest -= fold * low.length;
    free = free.filter((i) => !low.includes(i));
    if (!free.length) return out;
  }
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
  // A pane opened to fit its app (docs/FLEX-SPLIT.md step 1): the split's id and the pane's item; null: none.
  let opened: { split: string, item: string } | null = null;
  // The move to or from it under way: each pane's size along the axis from and to (px), the panes folded at its end,
  // when it began (the page's clock, ms).
  let motion: { split: string, from: number[], to: number[], folded: boolean[], t0: number, frame: number, timer: ReturnType<typeof setTimeout> | null } | null = null;
  // The pane the pointer rests on, waiting EXPAND_DWELL to open; the wait to fold back once it's on Margin's own UI.
  let dwell: { item: string, timer: ReturnType<typeof setTimeout> } | null = null;
  let leave: ReturnType<typeof setTimeout> | null = null;
  // The split's focused pane as last seen (a change: a press, ⌘-click, a key: it opens when it's cut).
  let focusedSeen: { split: string, item: string | null } | null = null;
  // The element WebKit last dispatched a real pointer move over (the panel key: WebKit's own hover), null: none.
  let realOver: Element | null = null;
  let realAt: { x: number, y: number } | null = null;
  let hoverSeen: number | null = null;

  const host = () => rt.host as typeof rt.host & { appWindow?: boolean, pageHosted?: boolean, paneMinimums?: Record<string, [number, number]>, appMinimums?: Record<string, [number, number]>, paneLoading?: { item: string, name: string } | null, paneCuts?: Record<string, PaneCut>, paneHover?: number | null, note?: (text: string) => void };
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

  // ---- a pane opened to fit its app (docs/FLEX-SPLIT.md step 1) ----

  // How a pane opens: on the pointer's rest (the default) or on a press only (Settings' `splitExpand`).
  const mode = () => ((rt.state as any)?.settings?.splitExpand === 'click' ? 'click' : 'hover');
  const clock = () => rt.win.performance?.now?.() ?? Date.now();
  // Each pane's app minimum along the axis (Margin.app's `paneMin`, by its item), null: not known.
  const needsOf = (split: Split) => split.panes.map((p) => { const m = host().paneMinimums?.[String(p.id)]; return m ? (row(split) ? m[0] : m[1]) : null; });
  // Each pane's size at the split's own ratios in the room the panes have now (px).
  const restOf = (split: Split, el: HTMLElement) => {
    const room = sizes(el, split).reduce((a, b) => a + b, 0);
    const r = ratiosFor(split);
    const sum = r.reduce((a, b) => a + b, 0) || 1;
    return split.panes.map((_, i) => room * (r[i] ?? 0) / sum);
  };
  // The sizes with `item` opened, and the panes folded (smaller than their app needs, beside it); null: it can't be
  // opened (not a pane, its need not known, or it fits already).
  function openedSizes(split: Split, el: HTMLElement, item: string): { sizes: number[], folded: boolean[] } | null {
    const index = split.panes.findIndex((p) => String(p.id) === item);
    if (index < 0) return null;
    const rest = restOf(split, el);
    const needs = needsOf(split);
    const to = expandSizes(rest, needs, index);
    if (to.every((v, i) => Math.abs(v - rest[i]) < 0.5)) return null;
    return { sizes: to, folded: to.map((v, i) => i !== index && needs[i] != null && v < (needs[i] as number) - 1) };
  }
  // What's drawn now instead of the ratios: the move's frame, else the opened pane's sizes; null: the ratios.
  function openView(split: Split, el: HTMLElement): { sizes: number[], folded: boolean[] } | null {
    if (motion && motion.split === split.id && motion.from.length === split.panes.length && motion.to.length === split.panes.length) {
      const k = Math.min(1, Math.max(0, (clock() - motion.t0) / EXPAND_TIME));
      const e = 1 - Math.pow(1 - k, 3);
      return { sizes: motion.from.map((f, i) => f + (motion!.to[i] - f) * e), folded: motion.folded };
    }
    if (!opened || opened.split !== split.id || drag) return null;
    const o = openedSizes(split, el, opened.item);
    if (!o) opened = null;
    return o;
  }
  // Opens `item` (null: the split back at its ratios), moving there over EXPAND_TIME, the windows following each frame.
  function openPane(item: string | null) {
    cancelDwell();
    const split = shown();
    const el = page();
    if (!split || !el || drag) return;
    const was = opened && opened.split === split.id ? opened.item : null;
    if (item === was) return;
    const target = item ? openedSizes(split, el, item) : null;
    if (item && !target) return;
    const from = sizes(el, split);
    opened = item ? { split: split.id, item } : null;
    const to = target ? target.sizes : restOf(split, el);
    const folded = target ? target.folded : split.panes.map(() => false);
    if (motion) { rt.win.cancelAnimationFrame(motion.frame); rt.cancel(motion.timer); }
    const told = !!motion;
    motion = { split: split.id, from, to, folded, t0: clock(), frame: 0, timer: null };
    if (!told) tell(true);
    host().note?.(`split: ${item ? `${item} opened to fit its app` : 'back at its sizes'} (${from.map(Math.round).join('/')} → ${to.map(Math.round).join('/')})`);
    step();
  }
  // One frame of the move: drawn and measured (the windows follow it); its last puts the windows in place.
  function step() {
    const m = motion;
    if (!m) return;
    m.frame = 0;
    rt.cancel(m.timer);
    m.timer = null;
    sync(rt.vm);
    view.flushLayout?.();
    if (clock() - m.t0 >= EXPAND_TIME) {
      motion = null;
      sync(rt.vm);
      tell(false);
      return;
    }
    // (Each frame, and a timer for a window that gets no frames now, whichever comes first.)
    m.frame = rt.win.requestAnimationFrame(step);
    m.timer = rt.later(step, 50);
  }
  const cancelDwell = () => { if (dwell) { rt.cancel(dwell.timer); dwell = null; } };
  const cancelLeave = () => { if (leave) { rt.cancel(leave); leave = null; } };
  // Whether the pointer is over `e`: Margin's hover marks (the panel not key: host/overlay.ts), or WebKit's own real
  // moves (never WebKit's :hover alone: it stays where it last was once the pointer goes through into a hole).
  const lit = (e: Element) => e.hasAttribute('m-hover') || (!!realOver && e.contains(realOver));
  // Where the pointer is as the page sees it: a folded pane's card (its item), the page's place, Margin's own UI
  // elsewhere ('ui'), else null (through a hole into an app, or out of the window).
  function pointerPlace(split: Split, el: HTMLElement): string | null {
    for (const p of panesOf(el)) if (p.hasAttribute('m-folded') && lit(p)) return p.getAttribute('m-pane-id');
    if (lit(el)) return 'page';
    // (Over the page's place, whatever is under it there: its panes and the page take no pointer, so the element a real
    // move names is the theme's under them. Chromium names one under a still pointer as a pane opens beneath it.)
    if (realOver && realAt) { const b = el.getBoundingClientRect(); if (realAt.x >= b.left && realAt.x < b.right && realAt.y >= b.top && realAt.y < b.bottom) return 'page'; }
    const over = realOver ?? rt.container.querySelector('[m-hover]');
    return over && rt.container.contains(over) ? 'ui' : null;
  }
  // The pointer's place considered (hover only): resting on a cut or folded pane opens it after EXPAND_DWELL; resting
  // on Margin's own UI outside the page folds the opened one back after EXPAND_LEAVE.
  function consider() {
    const split = shown();
    const el = page();
    if (!split || !el || drag || mode() !== 'hover') { cancelDwell(); cancelLeave(); return; }
    const isOpen = !!opened && opened.split === split.id;
    // (The cut pane Margin.app says the pointer is over, a folded one too: the window server's word, over the page's.)
    const hover = host().paneHover ?? null;
    const cutItem = hover == null ? null : Object.entries(host().paneCuts ?? {}).find(([, c]) => c.window === hover)?.[0] ?? null;
    const place = cutItem != null ? null : pointerPlace(split, el);
    const want = cutItem ?? (place && place !== 'page' && place !== 'ui' ? place : null);
    // (What resting there does: opens it; a folded pane that fits at the split's own sizes, the split back to them.)
    const to = want && want !== (isOpen ? opened!.item : null) ? goesTo(split, el, want) : undefined;
    if (to !== undefined) {
      const key = to ?? '';
      if (dwell?.item !== key) { cancelDwell(); dwell = { item: key, timer: rt.later(() => { dwell = null; openPane(to); }, EXPAND_DWELL) }; }
    } else cancelDwell();
    if (isOpen && place === 'ui' && cutItem == null) { if (!leave) leave = rt.later(() => { leave = null; openPane(null); }, EXPAND_LEAVE); } else cancelLeave();
  }
  // A folded pane's card: Margin's own elements (the item's icon, else its letter; its name), never markup of the
  // item's; `on` false: none.
  function card(p: HTMLElement, pane: Split['panes'][number], on: boolean) {
    let c = [...p.children].find((x) => x.localName === 'm-pane-card') as HTMLElement | undefined;
    if (on !== p.hasAttribute('m-folded')) { if (on) p.setAttribute('m-folded', ''); else p.removeAttribute('m-folded'); }
    if (!on) { c?.remove(); return; }
    const name = pane.title || pane.host || '';
    if (!c) {
      c = doc.createElement('m-pane-card');
      c.setAttribute('role', 'button');
      c.appendChild(doc.createElement('m-pane-icon'));
      c.appendChild(doc.createElement('m-pane-name'));
      p.appendChild(c);
    }
    const label = name ? `Open ${name}` : 'Open this pane';
    if (c.getAttribute('aria-label') !== label) { c.setAttribute('aria-label', label); c.setAttribute('title', label); }
    const icon = c.querySelector('m-pane-icon') as HTMLElement;
    const src = checkIconUrl(pane.icon) ? pane.icon : null;
    const img = icon.querySelector('img');
    if (src) {
      if (!img || img.getAttribute('src') !== src) { icon.textContent = ''; const i = doc.createElement('img'); i.setAttribute('alt', ''); i.setAttribute('src', src); icon.appendChild(i); }
      if (icon.hasAttribute('m-letter')) icon.removeAttribute('m-letter');
    } else {
      if (img || icon.textContent !== (pane.letter || '?')) icon.textContent = pane.letter || '?';
      if (!icon.hasAttribute('m-letter')) icon.setAttribute('m-letter', '');
      const bg = /^#[0-9a-f]{3,8}$/i.test(pane.color ?? '') ? pane.color : '';
      if (icon.style.getPropertyValue('--m-letter-color') !== bg) { if (bg) icon.style.setProperty('--m-letter-color', bg); else icon.style.removeProperty('--m-letter-color'); }
    }
    const n = c.querySelector('m-pane-name')!;
    if (n.textContent !== name) n.textContent = name;
  }
  // The split's focused pane changed (a press on a pane, a key): it opens when it can; in click mode, one that fits
  // puts the split back.
  function focusChanged(split: Split) {
    const item = split.panes.find((p) => p.active)?.id;
    const id = item == null ? null : String(item);
    if (!focusedSeen || focusedSeen.split !== split.id) { focusedSeen = { split: split.id, item: id }; return; }
    if (focusedSeen.item === id) return;
    focusedSeen.item = id;
    const el = page();
    if (!id || !el || drag) return;
    const to = goesTo(split, el, id);
    // (After this render: the move draws through sync.)
    if (to !== undefined) queueMicrotask(() => openPane(to));
    else if (mode() === 'click' && opened?.split === split.id) queueMicrotask(() => openPane(null));
  }
  // What a pane the pointer rests on or a press focuses does: opens (its item), or, folded now and fitting at the split's
  // own sizes, puts the split back to them (null); undefined: nothing (it fits, and isn't folded).
  function goesTo(split: Split, el: HTMLElement, item: string): string | null | undefined {
    if (openedSizes(split, el, item)) return item;
    const p = panesOf(el).find((x) => x.getAttribute('m-pane-id') === item);
    return opened?.split === split.id && p?.hasAttribute('m-folded') ? null : undefined;
  }

  // The page's place drawn as the split now: its panes, their order, ratios and minimums, the focused one; nothing new
  // written when nothing changed.
  function sync(vm: ViewModel | null) {
    const el = page();
    if (!el) return;
    const split = shown(vm);
    if (!split) {
      if (opened || motion) { if (motion) { rt.win.cancelAnimationFrame(motion.frame); rt.cancel(motion.timer); motion = null; tell(false); } opened = null; }
      cancelDwell();
      cancelLeave();
      if (el.hasAttribute('m-split')) {
        el.removeAttribute('m-split');
        el.removeAttribute('m-split-id');
        for (const c of [...el.children]) if (c.localName === 'm-pane' || c.localName === 'm-divider') c.remove();
        laidOut = '';
        view.scheduleLayout();
      }
      return;
    }
    if (opened && opened.split !== split.id) opened = null;
    focusChanged(split);
    const hover = host().paneHover ?? null;
    if (hover !== hoverSeen) { hoverSeen = hover; queueMicrotask(consider); }
    const ratios = ratiosFor(split);
    const floors = floorsOf(split);
    const opening = host().paneLoading ?? null;
    const open = panesOf(el).length === split.panes.length ? openView(split, el) : null;
    const key = JSON.stringify([split.id, split.axis, split.panes.map((p) => [p.id, p.active, p.url, p.title, p.host, p.icon, p.letter]), ratios, floors, opening, open]);
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
      card(p, pane, !!open?.folded[i]);
      const s = p.style;
      // (Opened, or moving: each pane's size as a weight of the room, none held at its floor; else the ratios.)
      const grow = String(open ? Math.round(Math.max(0, open.sizes[i] ?? 0) * 100) / 100 : round4(ratios[i] ?? 1 / n));
      if (s.flexGrow !== grow) s.flexGrow = grow;
      const min = open ? '0px' : `${floors[i]}px`;
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

  // A folded pane's card pressed: it opens now and its pane is focused (`split.focus`, its tab).
  rt.listen(rt.container, 'pointerdown', (e: PointerEvent) => {
    const c = (e.target as Element | null)?.closest?.('m-pane-card');
    const p = c?.parentElement;
    const split = shown();
    if (e.button !== 0 || !c || !p || p.localName !== 'm-pane' || p.parentElement !== page() || !p.hasAttribute('m-folded') || !split) return;
    e.preventDefault();
    e.stopPropagation();
    const item = p.getAttribute('m-pane-id') ?? '';
    const pane = split.panes.find((x) => String(x.id) === item);
    if (!pane) return;
    const to = goesTo(split, page()!, item);
    if (to !== undefined) openPane(to);
    rt.dispatch('split.focus', pane.tabId, 'behavior');
  }, true);
  // The pointer's place, as WebKit's own moves say it (the panel key) and as Margin's hover marks change (it isn't).
  rt.listen(rt.container, 'pointerover', (e: PointerEvent) => { if (e.isTrusted) { realOver = e.target as Element; realAt = { x: e.clientX, y: e.clientY }; consider(); } });
  rt.listen(rt.container, 'pointermove', (e: PointerEvent) => { if (e.isTrusted && realOver) realAt = { x: e.clientX, y: e.clientY }; }, { passive: true });
  rt.listen(rt.container, 'pointerout', (e: PointerEvent) => { if (e.isTrusted && !e.relatedTarget) { realOver = null; realAt = null; consider(); } });
  const marks = typeof MutationObserver === 'function' ? new MutationObserver(() => { if (opened || shown()) consider(); }) : null;
  marks?.observe(rt.container, { subtree: true, attributes: true, attributeFilter: ['m-hover'] });
  rt.listen(rt.container, 'pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 || drag) return;
    const d = dividerAt(e.target);
    const split = shown();
    const el = page();
    if (!d || !split || !el) return;
    e.preventDefault();
    e.stopPropagation();
    try { d.setPointerCapture(e.pointerId); } catch {}
    // (A pane opened: the drag starts from the sizes shown, and those are what it saves.)
    if (motion) { rt.win.cancelAnimationFrame(motion.frame); rt.cancel(motion.timer); motion = null; }
    opened = null;
    cancelDwell();
    cancelLeave();
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
    destroy() {
      if (frame) { rt.win.cancelAnimationFrame(frame); rt.cancel(timer); }
      if (motion) { rt.win.cancelAnimationFrame(motion.frame); rt.cancel(motion.timer); motion = null; }
      cancelDwell();
      cancelLeave();
      marks?.disconnect();
    },
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
