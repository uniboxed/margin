// Split View's panes in Margin's own window (docs/PEEK-SPLIT.md §4; a tree since docs/FLEX-SPLIT.md step 3): while the
// item in front is a pane of a split and a hosted window is in the page area (Margin.app's `pageHosted`), Margin puts
// the split's boxes in the page's place. `<m-page m-split="row|column" m-split-id>` is the split's root; each node of
// its tree inside it is an `<m-split-group m-split="row|column" m-path>` (rows inside columns inside rows: `m-path` its
// kids' indexes from the root, dotted); each pane is an `<m-pane m-pane-id m-index [m-focused]>` (its index among all
// the panes, in order), each flexed by its node's ratios, with an `<m-divider m-index m-path m-axis>` between each two
// kids of a node. They're Margin's own elements (a theme can't write them: ui/sanitize.ts), never drawn by the
// renderer's template; a theme styles them (the gap, the divider and its hover and drag, the focused pane's ring) by
// its CSS. The view measures each pane with the page (ui/render.ts View.measure: `split`, `panes`), and Margin.app
// places each pane's window at its box (HostedSession.swift).
//
// - A pane is never laid out below Arc's least, PANE_FLOOR (220 pt, `minimumPaneWidth` in Arc 1.174.0's split view, also
//   its least height stacked); a node no smaller than what's in it needs (`treeMin`): its box's `min-width` (in a row)
//   or `min-height` (in a column). Its window may need more: Margin.app shows it cut, its window at its own minimum,
//   the rest hidden (docs/PEEK-SPLIT.md §4b).
// - A divider dragged: the two kids of its node beside it change size with the pointer, at most once a frame, each
//   stopping at its least; within SNAP (14 pt) of an even split of the two, they're even (Arc's), with Margin's
//   alignment haptic as it snaps when the drag is slow (Arc's: 120 pt/s at most); the page measured and reported that
//   frame (the app's windows follow it live: `split.resizing`, as a drag of the sidebar's edge); let go, `split.resize`
//   saves that node's ratios (its `path`). Double-click: equal sizes. Focused (Tab), ←/→ (↑/↓ in a column) move it 2%
//   (⇧: 10%), Home/End to its ends, Enter makes them equal; each saved.
// - Nothing per frame but a drag's own frames; nothing at all while no split is shown (no listener does any work).
// - In a column, the gap above a pane hosted in a Safari window (a web item's) at the top of the kid below it is a band
//   at least SAFARI_TOOLBAR tall (`<m-divider m-band>`, the pane's name in its `<m-band-title>`): Safari's full-screen
//   toolbar window rests just above its window, and is drawn whenever its window was raised after the pane above (the
//   focused pane is raised last); in the band it rests under Margin's opaque ground, never in the hole of the pane
//   above. That toolbar window is never moved or parked (it broke Safari's full screen: DECISIONS.md). At the page's
//   top, the toolbars rest under Margin's top frame, as one window's does: no band.
// - Each pane a card of its own: its corners where it meets another pane masked in the theme's ground, the page card's
//   own corners left to it (`--m-pane-clip`, `maskClip`).
// - A pane whose window is opening beside the panes shown (Margin.app's `paneLoading`: its item): `<m-pane m-loading>`
//   with Margin's loader in it (`<m-pane-loader>`: a spinner, "Opening …"), over that pane's box only; the other panes
//   stay shown and usable (never the page card's loader over the whole page area).
// - A cut pane (Margin.app's `paneCut`: its window wider or taller than its box, at its own minimum, the rest past the
//   display's edge, under the sidebar or under the pane beside it, docs/PEEK-SPLIT.md §4b) opens to fit its app
//   (docs/FLEX-SPLIT.md step 1): after the pointer rests on it EXPAND_DWELL (Margin.app's `paneHover`, said as the
//   pointer enters and leaves a cut pane), or at once when it's pressed (it becomes the focused pane); Settings'
//   `splitExpand` 'click': on a press only. In each node on its way from the root, its kid gets its app's minimum along
//   that node's axis (`expandSizes`), the others fold (`m-pane[m-folded]`, each with Margin's `<m-pane-card>`:
//   `<m-pane-icon>` and `<m-pane-name>`, over the app's window blurred behind it by Margin.app), moving there over
//   EXPAND_TIME through the drag's own path (`split.resizing`). A folded card takes the pointer (`hitRects`): resting on
//   one opens it, pressing one opens and focuses it. The pointer resting on Margin's own UI outside the page
//   EXPAND_LEAVE puts the split back (hover only); a press on a pane that fits puts it back (click only); a divider
//   dragged keeps the sizes shown. The ratios are never saved for it.
// - Adding a pane that can't fit (every pane's least size and the gaps, bands counted, more than the page area, either
//   way): refused with a toast before anything is opened (`refusesAdd`, `refusesDrop`, runtime.ts dispatch); so is
//   turning the split (`refusesAxis`). The sidebar's edge stops where the panes would no longer fit (`floor`,
//   behaviors/resize.ts).
import { frontItemOf } from '../../../../extension/shared/front-item.ts';
import { besideLeaf, mapLeaves, MAX_SPLIT_PANES, treeOf, turned, type SplitKid, type SplitNode, type SplitSide } from '../../../../extension/shared/split-tree.ts';
import type { Rt } from '../runtime.ts';
import type { ViewModel } from '../view-model.ts';
import { checkIconUrl } from '../sanitize.ts';

/** The smallest a pane is laid out (Margin's points): Arc's split view's `minimumPaneWidth`, 220, its least height
 *  stacked too (read from Arc 1.174.0's binary, 2026-11-21). */
export const PANE_FLOOR = Object.freeze({ width: 220, height: 220 });
/** A folded pane's least size along its node's axis while another pane is opened to fit its app (pt): room for its
 *  card's icon and a short name (docs/FLEX-SPLIT.md step 1). */
export const PANE_FOLD = 64;
/** How long the pointer rests on a cut pane (or a folded one) before it opens (ms; the prototype's, Arc's kind of
 *  pause: the person's intent, no state waited on). */
export const EXPAND_DWELL = 300;
/** How long the pointer rests on Margin's own UI outside the page before an opened pane folds back (ms). */
export const EXPAND_LEAVE = 450;
/** A pane's opening or the split's going back, eased out (ms). */
export const EXPAND_TIME = 200;
/** A divider dragged within this of an even split of its two kids: even (Arc's, pt). */
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
type Axis = 'horizontal' | 'vertical';

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
 * The ratios after divider `index` moved `delta` px: the two kids beside it, each kept at its floor at least, the
 * others as they are. `sizes`: every kid's size now (px), `floors` each one's least.
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
 * Each kid's size with kid `index` opened to fit its app (docs/FLEX-SPLIT.md step 1): it gets its app's minimum along
 * the axis (`needs`, null: not known), at most the room less PANE_FOLD for each other kid; the others share what's
 * left by their sizes now, none below PANE_FOLD. `sizes`: each kid's size now (px, the gaps not counted). Nothing
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

/** A pane's part at each edge where a row dropped goes beside it (the rest: in its place). */
export const DROP_EDGE = 0.25;
export type DropBox = { left: number, top: number, width: number, height: number };
export type DropSide = SplitSide | 'middle';
/**
 * Where a row dropped at `x`, `y` goes (docs/FLEX-SPLIT.md steps 2, 3), from the panes' boxes (page pixels, in order):
 * one page alone (`alone`): beside it on its nearest edge (`side`: a new split, the half it takes); a split's panes: a
 * pane's edges (DROP_EDGE each, the nearest) are `beside` it on that side (`rect` the half of it the dropped one
 * takes), its middle is `replace` (`side` 'middle'; `rect` its box); in a gap between panes, beside the nearest pane on
 * the side facing the point. `canAdd` false (a split that can't take one more): every place in a pane its `replace`,
 * the gaps none. Null: not over the boxes.
 */
export function dropPlace(boxes: DropBox[], alone: boolean, x: number, y: number, canAdd = true): { kind: 'side' | 'beside' | 'replace', pane: number, side: DropSide, rect: DropBox } | null {
  if (!boxes.length) return null;
  const inside = (b: DropBox) => x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height;
  const half = (b: DropBox, side: SplitSide): DropBox => side === 'left' ? { ...b, width: b.width / 2 }
    : side === 'right' ? { ...b, left: b.left + b.width / 2, width: b.width / 2 }
      : side === 'top' ? { ...b, height: b.height / 2 } : { ...b, top: b.top + b.height / 2, height: b.height / 2 };
  const nearest = (b: DropBox): { side: SplitSide, d: number } => {
    const fx = b.width > 0 ? (x - b.left) / b.width : 0.5;
    const fy = b.height > 0 ? (y - b.top) / b.height : 0.5;
    const all: [SplitSide, number][] = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]];
    const [side, d] = all.reduce((m, e) => (e[1] < m[1] ? e : m));
    return { side, d };
  };
  if (alone) {
    const b = boxes[0];
    if (!inside(b) || !(b.width > 0) || !(b.height > 0)) return null;
    const { side } = nearest(b);
    return { kind: 'side', pane: 0, side, rect: half(b, side) };
  }
  const i = boxes.findIndex(inside);
  if (i >= 0) {
    const b = boxes[i];
    const { side, d } = nearest(b);
    if (canAdd && d < DROP_EDGE) return { kind: 'beside', pane: i, side, rect: half(b, side) };
    return { kind: 'replace', pane: i, side: 'middle', rect: { ...b } };
  }
  // (In a gap: within the panes' bounds, beside the nearest one on the side facing the point.)
  if (!canAdd) return null;
  const left = Math.min(...boxes.map((b) => b.left));
  const top = Math.min(...boxes.map((b) => b.top));
  const right = Math.max(...boxes.map((b) => b.left + b.width));
  const bottom = Math.max(...boxes.map((b) => b.top + b.height));
  if (x < left || x > right || y < top || y > bottom) return null;
  const away = (b: DropBox) => Math.hypot(Math.max(b.left - x, 0, x - (b.left + b.width)), Math.max(b.top - y, 0, y - (b.top + b.height)));
  let j = 0;
  boxes.forEach((b, k) => { if (away(b) < away(boxes[j])) j = k; });
  const b = boxes[j];
  const side: SplitSide = x < b.left ? 'left' : x > b.left + b.width ? 'right' : y < b.top ? 'top' : 'bottom';
  return { kind: 'beside', pane: j, side, rect: half(b, side) };
}

/** Equal ratios for `n` kids. */
export const equalRatios = (n: number) => Array.from({ length: n }, () => 1 / n);

/** A pane hosted in a Safari window: a web item's (not a Mac app's, nor one of Margin's own pages). */
export const inSafari = (pane: { url?: string | null }) => { const u = String(pane?.url ?? ''); return u !== '' && !/^(app|margin):/i.test(u); };
/** Each divider's size along the axis (px) of a flat split: stacked, the band above a pane in Safari (its toolbar's
 *  height, or the gap if that's more), else the gap. */
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

/** The panes along a kid's top edge (a leaf itself; a row's every kid's; a column's first kid's). */
export function topPanes(k: SplitKid): string[] {
  if (typeof k === 'string') return [k];
  return k.axis === 'horizontal' ? k.kids.flatMap(topPanes) : topPanes(k.kids[0]);
}

/** Each divider's size in node `n` (px): in a column, a band above a kid with a Safari pane at its top, else the gap. */
export function nodeDividers(n: SplitNode, safari: (id: string) => boolean, gap = SPLIT_GAP, band = SAFARI_TOOLBAR): number[] {
  return n.kids.slice(1).map((k) => (n.axis === 'vertical' && topPanes(k).some(safari) ? Math.max(gap, band) : gap));
}

/**
 * The least size of `k` along `axis` (px): a pane's PANE_FLOOR; a node running that way its kids' and its dividers'
 * together, one across it its largest kid's.
 */
export function treeMin(k: SplitKid, axis: Axis, safari: (id: string) => boolean = () => false, gap = SPLIT_GAP): number {
  if (typeof k === 'string') return axis === 'horizontal' ? PANE_FLOOR.width : PANE_FLOOR.height;
  const kids = k.kids.map((c) => treeMin(c, axis, safari, gap));
  if (k.axis !== axis) return Math.max(...kids);
  return kids.reduce((a, b) => a + b, 0) + nodeDividers(k, safari, gap).reduce((a, b) => a + b, 0);
}

/** Which of the page's edges each pane touches, by its id. */
export function paneEdges(tree: SplitNode): Map<string, { top: boolean, right: boolean, bottom: boolean, left: boolean }> {
  const out = new Map<string, { top: boolean, right: boolean, bottom: boolean, left: boolean }>();
  const walk = (k: SplitKid, e: { top: boolean, right: boolean, bottom: boolean, left: boolean }) => {
    if (typeof k === 'string') { out.set(k, e); return; }
    const last = k.kids.length - 1;
    k.kids.forEach((kid, i) => walk(kid, k.axis === 'horizontal'
      ? { ...e, left: e.left && i === 0, right: e.right && i === last }
      : { ...e, top: e.top && i === 0, bottom: e.bottom && i === last }));
  };
  walk(tree, { top: true, right: true, bottom: true, left: true });
  return out;
}

/**
 * A pane's mask's clip (its `::before`, the theme's ground painted outside its rounded corners): the corners where it
 * meets another pane, never the page card's own (a corner on two of the page's edges). Each part on a whole CSS pixel
 * (round()): on a fraction of a device pixel WebKit drew one column of the ground down the whole pane (2026-11-28,
 * tests/theme/pane-mask-seam).
 */
export function maskClip(e: { top: boolean, right: boolean, bottom: boolean, left: boolean }): string {
  const H = 'round(up,50%,1px)';
  const masked = { tl: !(e.top && e.left), tr: !(e.top && e.right), br: !(e.bottom && e.right), bl: !(e.bottom && e.left) };
  const n = Object.values(masked).filter(Boolean).length;
  if (n === 4) return 'inset(0)';
  if (n === 2) {
    if (masked.tr && masked.br) return `inset(0 0 0 ${H})`;
    if (masked.tl && masked.bl) return `inset(0 ${H} 0 0)`;
    if (masked.bl && masked.br) return `inset(${H} 0 0 0)`;
    if (masked.tl && masked.tr) return `inset(0 0 ${H} 0)`;
  }
  // (Three corners: all but the one on the page card's corner.)
  const keep = !masked.tl ? 'tl' : !masked.tr ? 'tr' : !masked.br ? 'br' : 'bl';
  const corners: Record<string, string> = {
    tl: `polygon(${H} 0,100% 0,100% 100%,0 100%,0 ${H},${H} ${H})`,
    tr: `polygon(0 0,${H} 0,${H} ${H},100% ${H},100% 100%,0 100%)`,
    br: `polygon(0 0,100% 0,100% ${H},${H} ${H},${H} 100%,0 100%)`,
    bl: `polygon(0 0,100% 0,100% 100%,${H} 100%,${H} ${H},0 ${H})`,
  };
  return corners[keep];
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
const keyOf = (path: readonly number[]) => path.join('.');

export function installSplit(rt: Rt) {
  const { view, doc } = rt;
  // A divider dragged: its node (`key`, its path dotted), the index of the kid before it, the kids' sizes and floors.
  let drag: { el: Element, pointerId: number, key: string, path: number[], axis: 'row' | 'column', index: number, start: number, sizes: number[], floors: number[], ratios: number[], told: boolean, split: string, snapped: boolean, at: number, pos: number, speed: number } | null = null;
  // The ratios drawn ahead of the state: a drag's, then the ones just saved until the state has them (or 2 s).
  let held: { split: string, key: string, ratios: number[], until: number } | null = null;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let laidOut = '';
  let shape = '';
  // A pane opened to fit its app (docs/FLEX-SPLIT.md step 1): the split's id and the pane's item; null: none.
  let opened: { split: string, item: string } | null = null;
  // The move to or from it under way: each node's kids' sizes from and to (px, by the node's key), the panes folded at
  // its end, when it began (the page's clock, ms).
  let motion: { split: string, from: Map<string, number[]>, to: Map<string, number[]>, folded: Set<string>, t0: number, frame: number, timer: ReturnType<typeof setTimeout> | null } | null = null;
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
  const page = () => view.pageEl as HTMLElement | null;
  /** The split shown here now: the item in front a pane of it, a window hosted in the page area. */
  const shown = (vm: ViewModel | null = rt.vm): Split | null => {
    const h = host();
    if (!h.appWindow || !h.pageHosted || !vm?.split || vm.window?.pageOutside) return null;
    return vm.split.panes.length >= 2 ? vm.split : null;
  };
  // Its tree (a flat split's: one node of its panes).
  const treeOfSplit = (split: Split): SplitNode => split.tree ?? { axis: split.axis, kids: split.panes.map((p) => String(p.id)), ratios: split.panes.map((p) => p.ratio) };
  const paneById = (split: Split, id: string) => split.panes.find((p) => String(p.id) === id) ?? null;
  const safariOf = (split: Split) => (id: string) => { const p = paneById(split, id); return !!p && inSafari(p); };

  // ---- the drawn tree: a node's element, its kids', its dividers' ----

  const groupEl = (key: string): HTMLElement | null => {
    const el = page();
    if (!el || key === '') return el;
    return el.querySelector(`m-split-group[m-path="${key}"]`) as HTMLElement | null;
  };
  const kidsOf = (g: Element) => [...g.children].filter((c) => c.localName === 'm-pane' || c.localName === 'm-split-group') as HTMLElement[];
  const dividersOf = (g: Element) => [...g.children].filter((c) => c.localName === 'm-divider') as HTMLElement[];
  const allPanes = (el: Element) => [...el.querySelectorAll('m-pane')] as HTMLElement[];
  const paneEl = (id: string) => { const el = page(); return el ? allPanes(el).find((p) => p.getAttribute('m-pane-id') === id) ?? null : null; };
  // The nodes in order (root first), each with its path.
  function nodesOf(tree: SplitNode): { path: number[], key: string, node: SplitNode }[] {
    const out: { path: number[], key: string, node: SplitNode }[] = [];
    const walk = (n: SplitNode, path: number[]) => {
      out.push({ path, key: keyOf(path), node: n });
      n.kids.forEach((k, i) => { if (typeof k !== 'string') walk(k, [...path, i]); });
    };
    walk(tree, []);
    return out;
  }
  // The nodes from the root down to pane `id`, each with the index of its kid on the way; null: not a pane of it.
  function chainTo(tree: SplitNode, id: string): { key: string, node: SplitNode, index: number }[] | null {
    const walk = (n: SplitNode, path: number[]): { key: string, node: SplitNode, index: number }[] | null => {
      for (let i = 0; i < n.kids.length; i++) {
        const k = n.kids[i];
        if (k === id) return [{ key: keyOf(path), node: n, index: i }];
        if (typeof k !== 'string') { const rest = walk(k, [...path, i]); if (rest) return [{ key: keyOf(path), node: n, index: i }, ...rest]; }
      }
      return null;
    };
    return walk(tree, []);
  }
  const leavesIn = (k: SplitKid): string[] => (typeof k === 'string' ? [k] : k.kids.flatMap(leavesIn));
  const along = (axis: Axis) => (axis === 'horizontal' ? 'row' : 'column');
  // The theme's gap: a plain divider's size (a band is the toolbar's), else its `--m-split-gap`.
  const gapOf = (el: HTMLElement) => {
    const d = [...el.querySelectorAll('m-divider')].find((x) => !x.hasAttribute('m-band')) as HTMLElement | undefined;
    if (!d) {
      const v = parseFloat(rt.win.getComputedStyle(el).getPropertyValue('--m-split-gap'));
      return Number.isFinite(v) && v > 0 ? v : SPLIT_GAP;
    }
    const b = d.getBoundingClientRect();
    return d.getAttribute('m-axis') === 'column' ? b.height : b.width;
  };
  // A kid's least size along its node's axis (px).
  const floorOf = (split: Split, kid: SplitKid, axis: Axis, gap: number) => treeMin(kid, axis, safariOf(split), gap);
  // Each kid's size along a node's axis now (px), in order.
  const sizesOf = (key: string, axis: Axis) => { const g = groupEl(key); return g ? kidsOf(g).map((k) => { const b = k.getBoundingClientRect(); return axis === 'horizontal' ? b.width : b.height; }) : []; };

  function ratiosFor(split: Split, key: string, node: SplitNode): number[] {
    if (drag && drag.split === split.id && drag.key === key) return drag.ratios;
    if (held && held.split === split.id && held.key === key) {
      if (Date.now() < held.until && !sameRatios(held.ratios, node.ratios)) return held.ratios;
      held = null;
    }
    return node.ratios;
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

  // A divider as the band above a Safari pane (in a column): `m-band`, at least the toolbar's height, the pane's name in
  // it (Margin's own text, never markup); `pane` null: a plain divider again.
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
  // A pane's app minimum along `axis` (Margin.app's `paneMin`, by its item), null: not known.
  const needOf = (id: string, axis: Axis) => { const m = host().paneMinimums?.[id]; return m ? (axis === 'horizontal' ? m[0] : m[1]) : null; };
  // A node's kids' sizes at its own ratios in the room they have now (px).
  const restOf = (split: Split, key: string, node: SplitNode) => {
    const room = sizesOf(key, node.axis).reduce((a, b) => a + b, 0);
    const r = ratiosFor(split, key, node);
    const sum = r.reduce((a, b) => a + b, 0) || 1;
    return node.kids.map((_, i) => room * (r[i] ?? 0) / sum);
  };
  // The sizes with `item` opened, by node (those that change), and the panes folded (smaller than their app needs along
  // a node's axis, beside it); null: it can't be opened (not a pane, its need not known, or it fits already).
  function openedSizes(split: Split, item: string): { sizes: Map<string, number[]>, folded: Set<string> } | null {
    const tree = treeOfSplit(split);
    const chain = chainTo(tree, item);
    if (!chain) return null;
    const sizes = new Map<string, number[]>();
    const folded = new Set<string>();
    for (const { key, node, index } of chain) {
      const rest = restOf(split, key, node);
      const to = expandSizes(rest, node.kids.map((_, i) => (i === index ? needOf(item, node.axis) : null)), index);
      if (to.every((v, i) => Math.abs(v - rest[i]) < 0.5)) continue;
      sizes.set(key, to);
      node.kids.forEach((k, i) => {
        if (i === index) return;
        for (const q of leavesIn(k)) { const n = needOf(q, node.axis); if (n != null && to[i] < n - 1) folded.add(q); }
      });
    }
    return sizes.size ? { sizes, folded } : null;
  }
  // What's drawn now instead of the ratios: the move's frame, else the opened pane's sizes; null: the ratios.
  function openView(split: Split): { sizes: Map<string, number[]>, folded: Set<string> } | null {
    if (motion && motion.split === split.id) {
      const k = Math.min(1, Math.max(0, (clock() - motion.t0) / EXPAND_TIME));
      const e = 1 - Math.pow(1 - k, 3);
      const sizes = new Map<string, number[]>();
      for (const [key, to] of motion.to) { const from = motion.from.get(key) ?? to; sizes.set(key, from.map((f, i) => f + ((to[i] ?? f) - f) * e)); }
      return { sizes, folded: motion.folded };
    }
    if (!opened || opened.split !== split.id || drag) return null;
    const o = openedSizes(split, opened.item);
    if (!o) opened = null;
    return o;
  }
  // Opens `item` (null: the split back at its ratios), moving there over EXPAND_TIME, the windows following each frame.
  function openPane(item: string | null) {
    cancelDwell();
    const split = shown();
    if (!split || !page() || drag) return;
    const was = opened && opened.split === split.id ? opened.item : null;
    if (item === was) return;
    const target = item ? openedSizes(split, item) : null;
    if (item && !target) return;
    const tree = treeOfSplit(split);
    // (Every node that moves: those the target changes, and those the one open now had changed.)
    const nodes = nodesOf(tree);
    const before = motion?.to ?? (was ? openedSizes(split, was)?.sizes : null) ?? new Map<string, number[]>();
    const keys = new Set([...(target?.sizes.keys() ?? []), ...before.keys()]);
    const from = new Map<string, number[]>();
    const to = new Map<string, number[]>();
    for (const { key, node } of nodes) {
      if (!keys.has(key)) continue;
      from.set(key, sizesOf(key, node.axis));
      to.set(key, target?.sizes.get(key) ?? restOf(split, key, node));
    }
    opened = item ? { split: split.id, item } : null;
    const folded = target ? target.folded : new Set<string>();
    if (motion) { rt.win.cancelAnimationFrame(motion.frame); rt.cancel(motion.timer); }
    const told = !!motion;
    motion = { split: split.id, from, to, folded, t0: clock(), frame: 0, timer: null };
    if (!told) tell(true);
    const said = [...to.entries()].map(([key, t]) => `${key || 'root'} ${(from.get(key) ?? []).map(Math.round).join('/')} → ${t.map(Math.round).join('/')}`).join('; ');
    host().note?.(`split: ${item ? `${item} opened to fit its app` : 'back at its sizes'} (${said})`);
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
  function pointerPlace(el: HTMLElement): string | null {
    for (const p of allPanes(el)) if (p.hasAttribute('m-folded') && lit(p)) return p.getAttribute('m-pane-id');
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
    // (Nor while a sidebar row is dragged over the page: its drop's place is read from the panes as they are.)
    if (!split || !el || drag || mode() !== 'hover' || rt.behaviors.drag?.active?.()) { cancelDwell(); cancelLeave(); return; }
    const isOpen = !!opened && opened.split === split.id;
    // (The cut pane Margin.app says the pointer is over, a folded one too: the window server's word, over the page's.)
    const hover = host().paneHover ?? null;
    const cutItem = hover == null ? null : Object.entries(host().paneCuts ?? {}).find(([, c]) => c.window === hover)?.[0] ?? null;
    const place = cutItem != null ? null : pointerPlace(el);
    const want = cutItem ?? (place && place !== 'page' && place !== 'ui' ? place : null);
    // (What resting there does: opens it; a folded pane that fits at the split's own sizes, the split back to them.)
    const to = want && want !== (isOpen ? opened!.item : null) ? goesTo(split, want) : undefined;
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
    if (!id || !page() || drag) return;
    const to = goesTo(split, id);
    // (After this render: the move draws through sync.)
    if (to !== undefined) queueMicrotask(() => openPane(to));
    else if (mode() === 'click' && opened?.split === split.id) queueMicrotask(() => openPane(null));
  }
  // What a pane the pointer rests on or a press focuses does: opens (its item), or, folded now and fitting at the split's
  // own sizes, puts the split back to them (null); undefined: nothing (it fits, and isn't folded).
  function goesTo(split: Split, item: string): string | null | undefined {
    if (openedSizes(split, item)) return item;
    return opened?.split === split.id && paneEl(item)?.hasAttribute('m-folded') ? null : undefined;
  }

  // ---- drawn ----

  // The tree's shape (its axes and its panes, in order): its elements made again when it changes.
  const shapeOf = (k: SplitKid): unknown => (typeof k === 'string' ? k : [k.axis, k.kids.map(shapeOf)]);
  // A node's elements made in `into`: its kids (each pane, each node's group) with a divider between each two.
  function build(into: HTMLElement, node: SplitNode, path: number[], panes: { n: number }) {
    const key = keyOf(path);
    node.kids.forEach((k, i) => {
      if (i > 0) {
        const d = doc.createElement('m-divider');
        d.setAttribute('m-index', String(i - 1));
        d.setAttribute('m-path', key);
        d.setAttribute('m-axis', along(node.axis));
        d.setAttribute('role', 'separator');
        d.setAttribute('tabindex', '0');
        d.setAttribute('aria-label', 'Resize panes');
        into.appendChild(d);
      }
      if (typeof k === 'string') {
        const p = doc.createElement('m-pane');
        p.setAttribute('m-index', String(panes.n++));
        into.appendChild(p);
      } else {
        const g = doc.createElement('m-split-group');
        g.setAttribute('m-path', keyOf([...path, i]));
        g.setAttribute('m-split', along(k.axis));
        into.appendChild(g);
        build(g, k, [...path, i], panes);
      }
    });
  }
  const clear = (el: HTMLElement) => { for (const c of [...el.children]) if (c.localName === 'm-pane' || c.localName === 'm-divider' || c.localName === 'm-split-group') c.remove(); };

  // The page's place drawn as the split now: its tree, its panes, their order, ratios and least sizes, the focused one;
  // nothing new written when nothing changed.
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
        clear(el);
        laidOut = '';
        shape = '';
        view.scheduleLayout();
      }
      return;
    }
    if (opened && opened.split !== split.id) opened = null;
    focusChanged(split);
    const hover = host().paneHover ?? null;
    if (hover !== hoverSeen) { hoverSeen = hover; queueMicrotask(consider); }
    const tree = treeOfSplit(split);
    const nodes = nodesOf(tree);
    const opening = host().paneLoading ?? null;
    const treeShape = JSON.stringify(shapeOf(tree));
    const sameShape = treeShape === shape && !!el.querySelector('m-pane');
    const open = sameShape ? openView(split) : null;
    const ratios = new Map(nodes.map(({ key, node }) => [key, ratiosFor(split, key, node)]));
    const key = JSON.stringify([split.id, treeShape, split.panes.map((p) => [p.id, p.active, p.url, p.title, p.host, p.icon, p.letter]), [...ratios], opening,
      open ? [[...open.sizes], [...open.folded]] : null]);
    if (key === laidOut && sameShape) return;
    laidOut = key;
    const axis = along(tree.axis);
    if (el.getAttribute('m-split') !== axis) el.setAttribute('m-split', axis);
    if (el.getAttribute('m-split-id') !== split.id) el.setAttribute('m-split-id', split.id);
    if (!sameShape) {
      clear(el);
      build(el, tree, [], { n: 0 });
      shape = treeShape;
    }
    const gap = gapOf(el);
    const edges = paneEdges(tree);
    for (const { key: k, node } of nodes) {
      const g = groupEl(k);
      if (!g) continue;
      const kids = kidsOf(g);
      const dividers = dividersOf(g);
      const r = ratios.get(k) ?? node.ratios;
      const sizes = open?.sizes.get(k) ?? null;
      const [on, off] = node.axis === 'horizontal' ? ['min-width', 'min-height'] : ['min-height', 'min-width'];
      let acc = 0;
      node.kids.forEach((kid, i) => {
        const e = kids[i];
        if (!e) return;
        const s = e.style;
        // (Opened, or moving: each kid's size as a weight of the room, none held at its floor; else the ratios.)
        const grow = String(sizes ? Math.round(Math.max(0, sizes[i] ?? 0) * 100) / 100 : round4(r[i] ?? 1 / node.kids.length));
        if (s.flexGrow !== grow) s.flexGrow = grow;
        const min = open ? '0px' : `${floorOf(split, kid, node.axis, gap)}px`;
        if (s.getPropertyValue(on) !== min) s.setProperty(on, min);
        if (s.getPropertyValue(off)) s.removeProperty(off);
        if (i < node.kids.length - 1) {
          acc += r[i] ?? 1 / node.kids.length;
          const d = dividers[i];
          if (!d) return;
          // (In a column: a band above a Safari pane at the top of the kid below.)
          const below = node.axis === 'vertical' ? topPanes(node.kids[i + 1]).map((id) => paneById(split, id)).find((p) => !!p && inSafari(p)) ?? null : null;
          band(d, below);
          const orient = node.axis === 'horizontal' ? 'vertical' : 'horizontal';
          if (d.getAttribute('aria-orientation') !== orient) d.setAttribute('aria-orientation', orient);
          const now = String(Math.round(acc * 100));
          if (d.getAttribute('aria-valuenow') !== now) { d.setAttribute('aria-valuenow', now); d.setAttribute('aria-valuemin', '0'); d.setAttribute('aria-valuemax', '100'); }
        }
      });
    }
    const leaves = leavesIn(tree);
    for (const p of allPanes(el)) {
      // (Its pane by its place among them: the tree's leaves in order.)
      const id = leaves[Number(p.getAttribute('m-index'))];
      const pane = id == null ? null : paneById(split, id);
      if (!pane || id == null) continue;
      if (p.getAttribute('m-pane-id') !== id) p.setAttribute('m-pane-id', id);
      if (pane.active) { if (!p.hasAttribute('m-focused')) p.setAttribute('m-focused', ''); } else if (p.hasAttribute('m-focused')) p.removeAttribute('m-focused');
      loader(p, opening && opening.item === id ? opening.name : null);
      card(p, pane, !!open?.folded.has(id));
      const clip = maskClip(edges.get(id) ?? { top: true, right: true, bottom: true, left: true });
      if (p.style.getPropertyValue('--m-pane-clip') !== clip) p.style.setProperty('--m-pane-clip', clip);
    }
    view.scheduleLayout();
  }

  const tell = (on: boolean) => { if (!on) view.flushLayout?.(); rt.host.perform?.('split.resizing', { on }); };
  const save = (split: Split, path: number[], ratios: number[]) => {
    const norm = ratios.map(round4);
    held = { split: split.id, key: keyOf(path), ratios: norm, until: Date.now() + 2000 };
    rt.dispatch('split.resize', { split: split.id, ratios: norm, path }, 'behavior');
  };
  // New ratios for a node drawn now (a key, a double-click: no drag), measured and saved.
  const set = (split: Split, path: number[], ratios: number[]) => {
    held = { split: split.id, key: keyOf(path), ratios: ratios.map(round4), until: Date.now() + 2000 };
    sync(rt.vm);
    view.flushLayout?.();
    save(split, path, ratios);
  };

  // A divider of the split shown (the page's or a group's in it), with its node.
  const dividerAt = (target: EventTarget | null) => {
    const el = page();
    const d = (target as Element | null)?.closest?.('m-divider') as HTMLElement | null;
    if (!el || !d || !el.contains(d)) return null;
    const g = d.parentElement;
    if (!g || (g !== el && g.localName !== 'm-split-group')) return null;
    const key = d.getAttribute('m-path') ?? '';
    const path = key === '' ? [] : key.split('.').map(Number);
    return { d, key, path };
  };
  const nodeOf = (split: Split, path: number[]) => nodesOf(treeOfSplit(split)).find((n) => n.key === keyOf(path))?.node ?? null;

  // A folded pane's card pressed: it opens now and its pane is focused (`split.focus`, its tab).
  rt.listen(rt.container, 'pointerdown', (e: PointerEvent) => {
    const c = (e.target as Element | null)?.closest?.('m-pane-card');
    const p = c?.parentElement;
    const split = shown();
    if (e.button !== 0 || !c || !p || p.localName !== 'm-pane' || !page()?.contains(p) || !p.hasAttribute('m-folded') || !split) return;
    e.preventDefault();
    e.stopPropagation();
    const item = p.getAttribute('m-pane-id') ?? '';
    const pane = paneById(split, item);
    if (!pane) return;
    const to = goesTo(split, item);
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
    const at = dividerAt(e.target);
    const split = shown();
    const el = page();
    if (!at || !split || !el) return;
    const node = nodeOf(split, at.path);
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    try { at.d.setPointerCapture(e.pointerId); } catch {}
    // (A pane opened: the drag starts from the sizes shown, and those are what it saves.)
    if (motion) { rt.win.cancelAnimationFrame(motion.frame); rt.cancel(motion.timer); motion = null; }
    opened = null;
    cancelDwell();
    cancelLeave();
    const index = Number(at.d.getAttribute('m-index'));
    const now = sizesOf(at.key, node.axis);
    const total = now.reduce((a, b) => a + b, 0) || 1;
    const gap = gapOf(el);
    const axis = along(node.axis);
    drag = { el: at.d, pointerId: e.pointerId, key: at.key, path: at.path, axis, index, start: axis === 'row' ? e.clientX : e.clientY, sizes: now, floors: node.kids.map((k) => floorOf(split, k, node.axis, gap)), ratios: now.map((s) => s / total), told: false, split: split.id, snapped: false, at: e.timeStamp, pos: axis === 'row' ? e.clientX : e.clientY, speed: 0 };
    at.d.setAttribute('m-dragging', '');
    view.rootElement()?.classList.add('m-split-resizing');
  }, true);
  rt.listen(rt.container, 'pointermove', (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const split = shown();
    if (!split || split.id !== drag.split) return;
    const k = rt.scale?.() || 1;
    const pos = drag.axis === 'row' ? e.clientX : e.clientY;
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
    const { el, told, ratios, split: id, key, path } = drag;
    try { el.releasePointerCapture(e.pointerId); } catch {}
    el.removeAttribute('m-dragging');
    view.rootElement()?.classList.remove('m-split-resizing');
    if (frame) { rt.win.cancelAnimationFrame(frame); rt.cancel(timer); frame = 0; }
    drag = null;
    if (!told) return;
    held = { split: id, key, ratios: ratios.map(round4), until: Date.now() + 2000 };
    sync(rt.vm);
    tell(false);
    const split = shown();
    if (split && split.id === id) save(split, path, ratios);
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) rt.listen(rt.container, type, end);
  rt.listen(rt.container, 'dblclick', (e: MouseEvent) => {
    const split = shown();
    const at = dividerAt(e.target);
    const node = at && split ? nodeOf(split, at.path) : null;
    if (!at || !split || !node) return;
    e.preventDefault();
    e.stopPropagation();
    set(split, at.path, equalRatios(node.kids.length));
  });
  rt.listen(rt.container, 'keydown', (e: KeyboardEvent) => {
    const at = dividerAt(e.target);
    const split = shown();
    const el = page();
    const node = at && split ? nodeOf(split, at.path) : null;
    if (!at || !split || !el || !node || drag) return;
    const index = Number(at.d.getAttribute('m-index'));
    const now = sizesOf(at.key, node.axis);
    const total = now.reduce((a, b) => a + b, 0) || 1;
    const gap = gapOf(el);
    const floors = node.kids.map((k) => floorOf(split, k, node.axis, gap));
    const back = node.axis === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    const on = node.axis === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    let delta: number | null = null;
    if (e.key === back) delta = -(e.shiftKey ? BIG_STEP : STEP) * total;
    else if (e.key === on) delta = (e.shiftKey ? BIG_STEP : STEP) * total;
    else if (e.key === 'Home') delta = -total;
    else if (e.key === 'End') delta = total;
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); return set(split, at.path, equalRatios(node.kids.length)); }
    if (delta == null) return;
    e.preventDefault();
    e.stopPropagation();
    set(split, at.path, dragRatios(now, floors, index, delta));
  });

  // ---- a sidebar row dropped on the page (docs/FLEX-SPLIT.md steps 2, 3) ----

  // The mark of where it goes: Margin's own element over the page (`m-kind`: side, beside, replace), drawn by the
  // theme's CSS (themes/README.md `m-drop-zone`); none: null.
  let dropMark: HTMLElement | null = null;
  // The dragged row's item: its id (an open one's UI number, else a kept item's id), its item's id, its address.
  function rowItem(id: unknown) {
    const st: any = rt.state;
    const live = typeof id === 'number' ? st?.tabs?.[id] : null;
    const kept = typeof id === 'string' ? st?.keptTabs?.[id] : null;
    if (!live && !kept) return null;
    return { id: id as number | string, item: String(live?.mid ?? kept?.id ?? id), url: String(live?.url ?? kept?.url ?? '') };
  }
  // A box as dropPlace takes it.
  const boxOf = (e: Element): DropBox => { const b = e.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height }; };
  /**
   * Where a dragged row dropped at `x`, `y` (page pixels) goes: the `split.drop` it runs, with the mark's kind and box;
   * null: not on the page, or not one a drop takes. Only a tab's row (an open item or a kept one, the rows Add to Split
   * View is on), only in Margin's own window with a window hosted in the page area, never one of Margin's own pages,
   * the item shown, or a pane of the split shown.
   */
  function dropAt(x: number, y: number, row: { kind: string, id: unknown }) {
    const h = host();
    const vm = rt.vm;
    const el = page();
    if (row.kind !== 'tab' || !h.appWindow || !h.pageHosted || !vm || !el || vm.window?.pageOutside || drag) return null;
    const it = rowItem(row.id);
    if (!it || /^margin:/i.test(it.url)) return null;
    const split = shown();
    if (split) {
      if (split.panes.some((p) => p.tabId === it.id || String(p.id) === it.item)) return null;
      // (Every pane's box, in the tree's order, and its pane's place in the split's: what the drop names.)
      const leaves = leavesIn(treeOfSplit(split));
      const panes = allPanes(el).sort((a, b) => Number(a.getAttribute('m-index')) - Number(b.getAttribute('m-index')));
      const place = dropPlace(panes.map(boxOf), false, x, y, split.panes.length < MAX_SPLIT_PANES);
      if (!place) return null;
      const pane = split.panes.findIndex((p) => String(p.id) === leaves[place.pane]);
      if (pane < 0) return null;
      return { kind: place.kind, rect: place.rect, drop: { tab: it.id, split: split.id, nextTo: null, pane, side: place.side } };
    }
    const front = vm.tab;
    if (front?.id == null || front.id === it.id || (rt.state as any)?.tabs?.[front.id]?.mid === it.item || /^margin:/i.test(front.url ?? '')) return null;
    const place = dropPlace([boxOf(el)], true, x, y);
    if (!place) return null;
    return { kind: place.kind, rect: place.rect, drop: { tab: it.id, split: null, nextTo: front.id, pane: null, side: place.side } };
  }
  // Whether `x`, `y` is over the page area where a row may drop (Margin's own window, a window hosted there).
  function onPage(x: number, y: number) {
    const h = host();
    const el = page();
    if (!h.appWindow || !h.pageHosted || !el || rt.vm?.window?.pageOutside) return false;
    const b = el.getBoundingClientRect();
    return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
  }
  // The mark drawn where `place` goes (null: taken away). Its box in Margin's pixels (the page's zoom: rt.scale).
  function markDrop(place: { kind: string, rect: DropBox } | null) {
    if (!place) { dropMark?.remove(); dropMark = null; return; }
    const root = view.rootElement();
    if (!root) return;
    if (!dropMark || !dropMark.isConnected) {
      dropMark = doc.createElement('m-drop-zone');
      dropMark.setAttribute('aria-hidden', 'true');
      root.appendChild(dropMark);
    }
    const k = rt.scale?.() || 1;
    const r = place.rect;
    dropMark.setAttribute('m-kind', place.kind);
    Object.assign(dropMark.style, { left: `${r.left * k}px`, top: `${r.top * k}px`, width: `${r.width * k}px`, height: `${r.height * k}px` });
  }
  // Why a drop's panes (`split.drop`'s argument) can't be laid out, null: they can: the tree it would make, each pane at
  // its least size, as an add's (refusesAdd).
  function refusesDrop(arg: any): string | null {
    const h = host();
    const vm = rt.vm;
    if (!h.appWindow || !vm || !h.layout || !arg) return null;
    const it = rowItem(arg.tab);
    if (!it) return null;
    const urls: Record<string, string> = { [it.item]: it.url };
    let tree: SplitKid | null;
    if (arg.split != null) {
      const split = vm.split;
      if (!split || split.id !== arg.split) return null;
      for (const p of split.panes) urls[String(p.id)] = p.url ?? '';
      const target = String(split.panes[arg.pane]?.id ?? '');
      const t = treeOfSplit(split);
      tree = arg.side === 'middle' ? mapLeaves(t, (l) => (l === target ? it.item : l)) : besideLeaf(t, target, arg.side, it.item);
    } else {
      const front = vm.tab;
      if (!front) return null;
      const shownOne = String((rt.state as any)?.tabs?.[front.id as number]?.mid ?? front.id);
      urls[shownOne] = front.url ?? '';
      tree = besideLeaf({ axis: 'horizontal', kids: [shownOne], ratios: [1] }, shownOne, arg.side, it.item);
    }
    if (!tree || typeof tree === 'string') return null;
    return fits(tree, urls, true) ? null : arg.side === 'middle' ? 'Not enough room for this pane' : 'Not enough room for another pane';
  }

  return {
    afterRender(vm: ViewModel) { if (!drag) sync(vm); },
    dropAt,
    onPage,
    markDrop,
    refusesDrop,
    busy: () => drag != null,
    /** The page area's least width while a split is shown (each pane's floor and the gaps): the sidebar's edge stops
     *  there (behaviors/resize.ts). 0: none. */
    floor() {
      const split = shown();
      const el = page();
      if (!split || !el) return 0;
      return treeMin(treeOfSplit(split), 'horizontal', safariOf(split), gapOf(el));
    },
    /**
     * Why `tabId` can't be added to the split shown (or split with the item in front), null: it can. Said as a toast.
     * Only in Margin's own window, where the panes are laid out; the library refuses the rest (MAX_SPLIT_PANES, one
     * space, an app once).
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
      const full = `A split view has ${MAX_SPLIT_PANES} panes at most`;
      // (Added last among its root's kids, as the library adds it.)
      const added = (t: SplitNode, id: string): SplitNode => ({ ...t, kids: [...t.kids, id], ratios: [...t.kids, id].map(() => 1) });
      let tree: SplitNode;
      const urls: Record<string, string> = {};
      if (item) {
        // (A library item, Margin.app's: what the library makes of it, `addToSplit`: added to the split of the item used
        // last in its space (not itself), or a new split of that one and it, in that order. Each pane's address names its
        // app for its known minimum (`appMin`, known before its window exists) and its band, stacked.)
        const partner = frontItemOf(Object.values(items), item.spaceId, item.id);
        if (!partner) return null; // (the library's to refuse: no second item)
        const group = ((st?.splits ?? []) as { panes: string[], axis?: string, ratios?: number[], tree?: unknown }[]).find((x) => x.panes.includes(partner.id)) ?? null;
        if (group?.panes.includes(item.id)) return null;
        if (group && group.panes.length >= MAX_SPLIT_PANES) return full;
        for (const id of group ? group.panes : [partner.id]) urls[String(id)] = items[id]?.url ?? '';
        urls[item.id] = item.url;
        tree = added(group ? treeOf(group) : { axis: 'horizontal', kids: [partner.id], ratios: [1] }, item.id);
      } else {
        // (A browser's tab: the split shown, or the tab in front, and it.)
        const split = vm.split;
        if (split && split.panes.some((p) => p.tabId === tabId || String(p.id) === String(tabId))) return null;
        if (split && split.panes.length >= MAX_SPLIT_PANES) return full;
        urls[String(tabId)] = typeof tabId === 'number' ? st?.tabs?.[tabId]?.url ?? '' : '';
        if (split) for (const p of split.panes) urls[String(p.id)] = p.url ?? '';
        else urls[String(vm.tab?.id ?? 'front')] = vm.tab?.url ?? '';
        tree = added(split ? treeOfSplit(split) : { axis: 'horizontal', kids: [String(vm.tab?.id ?? 'front')], ratios: [1] }, String(tabId));
      }
      return fits(tree, urls, true) ? null : 'Not enough room for another pane';
    },
    /**
     * Why the split shown can't be turned now (stacked, or put side by side), null: it can: its panes turned, each at
     * its least size, wouldn't fit the page area. Said as a toast.
     */
    refusesAxis(splitId: unknown): string | null {
      const h = host();
      const split = rt.vm?.split;
      if (!h.appWindow || !split || !h.layout || (splitId != null && String(splitId) !== split.id)) return null;
      const urls = Object.fromEntries(split.panes.map((p) => [String(p.id), p.url ?? '']));
      const tree = turned(treeOfSplit(split)) as SplitNode;
      return fits(tree, urls) ? null
        : tree.axis === 'vertical' ? 'Not enough room to stack these panes' : 'Not enough room for these panes side by side';
    },
    destroy() {
      if (frame) { rt.win.cancelAnimationFrame(frame); rt.cancel(timer); }
      if (motion) { rt.win.cancelAnimationFrame(motion.frame); rt.cancel(motion.timer); motion = null; }
      cancelDwell();
      cancelLeave();
      marks?.disconnect();
      markDrop(null);
    },
  };

  // Whether a tree of these panes (`urls`: each pane's address, by its id), each at its least size, fits the page area
  // both ways with the gaps between them (bands above Safari panes counted, in columns).
  // `said`: the check told to Margin.app's log (an add: each pane's app, the room, the answer), to read the real
  // screen's inputs back (2026-11-21 19:32: Notes let in beside a Safari tab where they couldn't fit).
  function fits(tree: SplitNode, urls: Record<string, string>, said = false) {
    const g = host().layout;
    const panes = leavesIn(tree);
    if (!g) { if (said) host().note?.(`split add: no layout from Margin.app yet: let through (${panes.length} panes)`); return true; }
    const width = g.container.width - g.insets.left - g.insets.right;
    const height = g.container.height - g.insets.top - g.insets.bottom;
    const el = page();
    const gap = el ? gapOf(el) : SPLIT_GAP;
    const safari = (id: string) => inSafari({ url: urls[id] ?? '' });
    const needW = treeMin(tree, 'horizontal', safari, gap);
    const needH = treeMin(tree, 'vertical', safari, gap);
    const ok = needW <= width + 0.5 && needH <= height + 0.5;
    if (said) host().note?.(`split add: ${panes.map((id) => `${appKeyOf(urls[id])}${urls[id] ? '' : ' (no address)'}`).join(' + ')} need ${Math.round(needW)}×${Math.round(needH)} in ${Math.round(width)}×${Math.round(height)} (${tree.axis}): ${ok ? 'fits' : 'refused'}; apps known: ${Object.keys(host().appMinimums ?? {}).join(', ') || 'none'}`);
    return ok;
  }
}
