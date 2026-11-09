// The first children whose top margins count with <body>'s, for the box
// (box-body.ts): in a window, <body>'s top margin collapses with its first
// in-flow child's, and that one's first child's while nothing stands between
// them. Followed, so that a class on one, or a new first child, is read.

// How many first children are followed down for their margins, out of how many looked at.
export const CHAIN_DEPTH = 8;
const CHAIN_LOOK = 32;
const NOT_IN_FLOW = 'dialog, [popover], :fullscreen';

/** @param ctx the box's shared parts (box.ts) */
export function startChain(ctx: any) {
  const { box, native } = ctx;
  const { matches, computed } = native;
  // `path`: each element the walk left, by going down or to the next one past it.
  // `end`: where it stopped, null if for want of an element.
  let chain: { nodes: Element[], tops: string[], path: { node: Element, down: boolean }[], end: Element | null } = { nodes: [], tops: [], path: [], end: null };
  const textBefore = (parent: Element, node: Element) => {
    for (let text = parent.firstChild; text && text !== node; text = text.nextSibling) if (text.nodeType === 3 && (text as Text).data.trim()) return true;
    return false;
  };
  function readChain(body: HTMLElement) {
    const nodes: any[] = []; // (the page's elements, as they are)
    const tops: string[] = [];
    const path: { node: any; down: boolean; }[] = [];
    let parent: Element = body;
    let node = body.firstElementChild;
    while (node && nodes.length < CHAIN_DEPTH && path.length < CHAIN_LOOK && !textBefore(parent, node)) {
      const style = computed(node);
      if (style.display === 'none' || style.cssFloat !== 'none' || /absolute|fixed/.test(style.position) || matches.call(node, NOT_IN_FLOW)) {
        path.push({ node, down: false });
        node = node.nextElementSibling;
        continue;
      }
      // Layout containment: its margins stay its own, whatever they are.
      if (style.display.startsWith('inline') || /layout|paint|strict|content/.test(style.contain)) break;
      nodes.push(node);
      tops.push(computed(node, '::backdrop').marginTop);
      if (!/^(block|list-item)$/.test(style.display) || !/visible|clip/.test(style.overflowY) || parseFloat(style.paddingTop) || parseFloat(style.borderTopWidth)) break;
      path.push({ node, down: true });
      parent = node;
      node = node.firstElementChild;
    }
    return { nodes, tops, path, end: node };
  }

  // The first children whose margins count: a class on one, or a new one, is
  // looked at once a frame, with no read unless their margins changed. Only
  // attributes are observed on them: what's added and removed already comes
  // to the one observer of the document (sheets.ts).
  let chainFrame = 0;
  function chainCheck() {
    chainFrame = 0;
    const { body } = document;
    if (!body || !box.on) return;
    const now = readChain(body);
    const moved = now.tops.join() !== chain.tops.join() || now.nodes.length !== chain.nodes.length || now.nodes.some((node, i) => node !== chain.nodes[i]);
    follow(now);
    if (moved && !ctx.moves.moving()) ctx.watch.bodyMayHaveChanged(); // a margin at the start of its way shows no change yet: read as it ends
  }
  function chainTouched() {
    chainFrame ||= requestAnimationFrame(chainCheck);
  }
  const chainWatch = new MutationObserver(chainTouched);
  let chainBody: HTMLElement | null = null;
  const onChain = ({ path, end }: { path: { node: Element }[], end: Element | null }) => [...path.map((step) => step.node), ...(end ? [end] : [])];
  function follow(next: { nodes: any[]; tops: string[]; path: { node: any; down: boolean; }[]; end: any; }) {
    const before = onChain(chain);
    const after = onChain(next);
    const same = after.length === before.length && after.every((node, i) => node === before[i]) && chainBody === document.body;
    chain = next;
    if (same) return;
    chainBody = document.body;
    chainWatch.disconnect();
    for (const node of after) chainWatch.observe(node, { attributes: true });
  }
  // Children came or went somewhere in the page: did they on the chain's walk?
  function childrenChanged() {
    ctx.watch.rootArrived();
    let node = document.body?.firstElementChild;
    if (node === undefined) return;
    for (const { node: step, down } of chain.path) {
      if (node !== step) return chainTouched();
      node = down ? step.firstElementChild : step.nextElementSibling;
    }
    if (node !== chain.end) chainTouched();
  }

  return {
    read: readChain,
    follow,
    childrenChanged,
    nodes: () => chain.nodes,
    tops: () => chain.tops,
  };
}
