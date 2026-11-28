// A split's tree (docs/FLEX-SPLIT.md step 3): panes split in any direction, rows inside columns inside rows. One copy
// for the state's rules (state/model.ts, Margin.app's library.ts over it, margin-core's port in
// app/shared/core/src/library/model/split_tree.rs) and the page (ui/view-model.ts, ui/behaviors/split.ts).
//
// A split stores its tree (`tree`) only when it's nested. A flat one is stored as it always was (`axis`, its `panes`,
// a ratio each), and its tree is read from that: one node of its panes. A nested split keeps `panes` (its leaves, in
// order: left to right, top to bottom within each node) and `axis` (its root's), and `ratios` holds each pane's share of
// the whole area (what a flat split's ratios are too), so whatever reads a split's panes and ratios reads them as before.
//
// A tree in its canonical form: every node has two kids or more; a node's kid that is a node runs across it (another
// axis); each node's ratios are one a kid, normalized as a flat split's are (4 decimals); every leaf once.

export type SplitAxis = 'horizontal' | 'vertical';
export type SplitNode = { axis: SplitAxis, kids: SplitKid[], ratios: number[] };
export type SplitKid = string | SplitNode;
export type SplitSide = 'left' | 'right' | 'top' | 'bottom';

/** The most panes a split has. The room is the real limit: each pane at its least size must fit the page area. */
export const MAX_SPLIT_PANES = 16;

const isNode = (k: unknown): k is SplitNode => !!k && typeof k === 'object' && !Array.isArray(k);

/** `count` ratios from `ratios` (one a kid, each a positive number, else 1), summing to about 1 at 4 decimals. */
export function normalizeRatios(ratios: unknown, count: number): number[] {
  if (count <= 0) return [];
  const raw = Array.isArray(ratios) && ratios.length === count
    ? ratios.map((r) => (typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : 1))
    : Array.from({ length: count }, () => 1);
  const sum = raw.reduce((acc, v) => acc + v, 0) || count;
  return raw.map((v) => Math.round((v / sum) * 10000) / 10000);
}

/** Its leaves, in order. */
export function leavesOf(k: SplitKid): string[] {
  return isNode(k) ? k.kids.flatMap(leavesOf) : [k];
}

/** Each leaf's share of the whole (the ratios along its path multiplied), in order, normalized. */
export function areaShares(node: SplitNode): number[] {
  const out: number[] = [];
  const walk = (k: SplitKid, share: number) => {
    if (!isNode(k)) { out.push(share); return; }
    const r = normalizeRatios(k.ratios, k.kids.length);
    k.kids.forEach((kid, i) => walk(kid, share * r[i]));
  };
  walk(node, 1);
  return normalizeRatios(out, out.length);
}

/**
 * The canonical form of `k`: a node of one kid is that kid (in its place, with its ratio), a node kid running the same
 * way as its parent is merged into it (its kids taking its ratio between them), every node's ratios normalized. Null:
 * nothing left.
 */
export function canonical(k: SplitKid | null): SplitKid | null {
  if (k == null) return null;
  if (!isNode(k)) return k;
  const ratios = normalizeRatios(k.ratios, k.kids.length);
  const kids: SplitKid[] = [];
  const weights: number[] = [];
  k.kids.forEach((raw, i) => {
    const kid = canonical(raw);
    if (kid == null) return;
    if (isNode(kid) && kid.axis === k.axis) {
      const inner = normalizeRatios(kid.ratios, kid.kids.length);
      kid.kids.forEach((g, j) => { kids.push(g); weights.push(ratios[i] * inner[j]); });
    } else {
      kids.push(kid);
      weights.push(ratios[i]);
    }
  });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0];
  return { axis: k.axis, kids, ratios: normalizeRatios(weights, kids.length) };
}

/** The tree a split stored, checked (`panes` its leaves in order, every node canonical already); null: none or not one. */
export function storedTree(tree: unknown, panes: readonly string[]): SplitNode | null {
  const ok = (k: unknown, parent: SplitAxis | null): boolean => {
    if (typeof k === 'string') return k.length > 0;
    if (!isNode(k)) return false;
    const n = k as { axis?: unknown, kids?: unknown, ratios?: unknown };
    if ((n.axis !== 'horizontal' && n.axis !== 'vertical') || n.axis === parent) return false;
    if (!Array.isArray(n.kids) || n.kids.length < 2 || !Array.isArray(n.ratios) || n.ratios.length !== n.kids.length) return false;
    if (!n.ratios.every((r) => typeof r === 'number' && Number.isFinite(r) && r > 0)) return false;
    return n.kids.every((kid) => ok(kid, n.axis as SplitAxis));
  };
  if (!isNode(tree) || !ok(tree, null)) return null;
  const leaves = leavesOf(tree);
  if (leaves.length !== panes.length || leaves.some((l, i) => l !== panes[i])) return null;
  // (Nested: at least one kid a node; a flat one is never stored as a tree.)
  if (!tree.kids.some(isNode)) return null;
  return tree;
}

/** A stored tree as kept (`storedTree` passed it): its axes, kids and ratios only, nothing else it held. */
export function copyTree(k: SplitKid): SplitKid {
  return isNode(k) ? { axis: k.axis, kids: k.kids.map(copyTree), ratios: [...k.ratios] } : k;
}

/** A split's tree: its own when it's nested, else one node of its panes. */
export function treeOf(g: { axis?: unknown, panes: readonly string[], ratios?: unknown, tree?: unknown }): SplitNode {
  return storedTree(g.tree, g.panes) ?? { axis: g.axis === 'vertical' ? 'vertical' : 'horizontal', kids: [...g.panes], ratios: normalizeRatios(g.ratios, g.panes.length) };
}

/**
 * What a split stores for tree `k` (canonical first): flat, `{ axis, panes, ratios }` (no tree); nested, also `tree`
 * with `ratios` each pane's share of the area. Null: fewer than 2 panes.
 */
export function storedOf(k: SplitKid | null): { axis: SplitAxis, panes: string[], ratios: number[], tree?: SplitNode } | null {
  const c = canonical(k);
  if (!isNode(c)) return null;
  const panes = leavesOf(c);
  if (!c.kids.some(isNode)) return { axis: c.axis, panes, ratios: c.ratios };
  return { axis: c.axis, panes, ratios: areaShares(c), tree: c };
}

/** `k` with each leaf as `f` makes it (null: gone). */
export function mapLeaves(k: SplitKid, f: (leaf: string) => SplitKid | null): SplitKid | null {
  if (!isNode(k)) return f(k);
  const kids: SplitKid[] = [];
  const ratios: number[] = [];
  k.kids.forEach((kid, i) => {
    const m = mapLeaves(kid, f);
    if (m != null) { kids.push(m); ratios.push(k.ratios[i] ?? 1); }
  });
  return kids.length ? { axis: k.axis, kids, ratios } : null;
}

/**
 * `leaf` beside `target` on `side` (docs/FLEX-SPLIT.md step 3): in the target's node when it runs that way (the two
 * sharing the target's ratio, half each), else the target split into a node of the two across it (half each). Null:
 * `target` isn't a leaf of `k`.
 */
export function besideLeaf(k: SplitNode, target: string, side: SplitSide, leaf: string): SplitNode | null {
  const axis: SplitAxis = side === 'left' || side === 'right' ? 'horizontal' : 'vertical';
  const first = side === 'left' || side === 'top';
  let found = false;
  const walk = (n: SplitNode): SplitNode => {
    const kids: SplitKid[] = [];
    const ratios: number[] = [];
    const own = normalizeRatios(n.ratios, n.kids.length);
    n.kids.forEach((kid, i) => {
      if (kid === target && !found) {
        found = true;
        if (n.axis === axis) {
          const pair = first ? [leaf, kid] : [kid, leaf];
          for (const p of pair) { kids.push(p); ratios.push(own[i] / 2); }
        } else {
          kids.push({ axis, kids: first ? [leaf, kid] : [kid, leaf], ratios: [0.5, 0.5] });
          ratios.push(own[i]);
        }
        return;
      }
      kids.push(isNode(kid) ? walk(kid) : kid);
      ratios.push(own[i]);
    });
    return { axis: n.axis, kids, ratios };
  };
  const out = walk(k);
  return found ? out : null;
}

/** The node at `path` (each a kid's index from the root); null: not a node there. */
export function nodeAt(k: SplitNode, path: readonly number[]): SplitNode | null {
  let n: SplitKid = k;
  for (const i of path) {
    if (!isNode(n) || !Number.isInteger(i) || i < 0 || i >= n.kids.length) return null;
    n = n.kids[i];
  }
  return isNode(n) ? n : null;
}

/** `k` with the node at `path` as `f` makes it; null: no node there. */
export function withNodeAt(k: SplitNode, path: readonly number[], f: (n: SplitNode) => SplitNode): SplitNode | null {
  if (!nodeAt(k, path)) return null;
  const go = (n: SplitNode, depth: number): SplitNode => {
    if (depth === path.length) return f(n);
    const i = path[depth];
    return { ...n, kids: n.kids.map((kid, j) => (j === i ? go(kid as SplitNode, depth + 1) : kid)) };
  };
  return go(k, 0);
}

/** `k` turned (every node's axis the other way): a node's turn, with all that's in it. */
export function turned(k: SplitKid): SplitKid {
  if (!isNode(k)) return k;
  return { axis: k.axis === 'vertical' ? 'horizontal' : 'vertical', kids: k.kids.map(turned), ratios: k.ratios };
}

/** A node path as a payload gives it: an array of whole numbers 0 or more; null: not one. */
export function pathOf(v: unknown): number[] | null {
  return Array.isArray(v) && v.length <= MAX_SPLIT_PANES && v.every((i) => typeof i === 'number' && Number.isInteger(i) && i >= 0) ? v as number[] : null;
}
