// <body>'s size and margins in the box, worked out from what the page says
// (content/page/box-body.ts reads it): pure arithmetic, so it's tested in node
// (tests/body-fit.test.ts). <body> fills the box and scrolls, so what the page
// says about its width and margins comes back as padding.
//
// `parse`: the browser's CSSNumericValue.parse, for calc(), min() and clamp()
// (absent, or in node: such a length is NaN, as one that takes a layout to know).

/** <body>'s edges and sizes, in the order a read lists their lengths. */
export const EDGES = ['Top', 'Right', 'Bottom', 'Left'];
export const SIZES = ['width', 'minWidth', 'maxWidth', 'height'];

/**
 * A length as the page wrote it, in pixels of `whole`: NaN if it takes a
 * layout to know, as `auto` and `fit-content` do.
 */
export function pixels(value: string, whole: number, parse: any) {
  if (value.endsWith('px')) return parseFloat(value);
  if (!value.includes('(')) return value.endsWith('%') ? (parseFloat(value) * whole) / 100 : NaN;
  try { // calc(), min(), clamp(): the browser's own arithmetic, once percents are lengths
    return parse(value.replace(/[-+]?[\d.]+(?:e[-+]?\d+)?%/g, (n) => `${(parseFloat(n) * whole) / 100}px`)).to('px').value;
  } catch {
    return NaN;
  }
}
export const settled = (value: string, parse: any) => value === 'auto' || value === 'none' || !Number.isNaN(pixels(value, 0, parse));

/** A margin collapsed with others, as CSS 2 §8.3.1 adds them up. */
export const collapsed = (list: number[]) => Math.max(0, ...list) + Math.min(0, ...list);

/** `sized`: its margins or size depend on the box's width. */
export function isSized({ lengths }: { lengths: string[] }) {
  const [, right, , left, , , , , width, , maxWidth] = lengths;
  return !left.endsWith('px') || !right.endsWith('px') || width !== 'auto' || maxWidth !== 'none' || lengths.slice(0, -1).some((length) => length.includes('%'));
}
export const growsIn = ({ lengths }: { lengths: string[] }) => lengths.at(-1) === 'auto';

/**
 * A margin can't collapse with the first child's as padding does: only what
 * it adds to theirs stays, which can be less than nothing.
 */
export function topMargin(top: number, { meets, collapses }: { meets: boolean, collapses: string[] }, padding: number, width: number, parse: any) {
  if (!meets || padding) return top;
  const tops = collapses.map((length) => pixels(length, width, parse) || 0);
  return collapsed([top, ...tops]) - collapsed(tops);
}

/**
 * The width equation of CSS 2 §10.3.3, for a block in <html>. In <body>'s own
 * pixels: `zoom` scales what it says and the padding that comes back alike.
 */
export function resolve(said: any, parse: any) {
  const { lengths, borders, boxSizing, direction, column, zoom } = said;
  const whole = said.whole / zoom;
  const [top, right, bottom, left, ...rest] = lengths.map((length: string) => pixels(length, whole, parse));
  const paddings = rest.slice(0, 4).map((n: number) => n || 0);
  const [width, minWidth, maxWidth] = rest.slice(4);
  const extra = paddings[1] + paddings[3] + borders;
  const inner = boxSizing === 'border-box' ? 0 : extra;
  const asked = Number.isNaN(width) ? whole - (left || 0) - (right || 0) : width + inner;
  const used = Math.max(Number.isNaN(maxWidth) ? asked : Math.min(asked, maxWidth + inner), (minWidth || 0) + inner);
  const free = whole - used;
  const margins = [top || 0, right, bottom || 0, left];
  if (Number.isNaN(left) && Number.isNaN(right)) margins[1] = margins[3] = Math.max(0, free / 2);
  else if (Number.isNaN(left)) margins[3] = Math.max(0, free - right);
  else if (Number.isNaN(right)) margins[1] = Math.max(0, free - left);
  else if (direction === 'rtl') margins[3] = Math.max(left, free - right);
  else margins[1] = Math.max(right, free - left);
  // The page's own offset sideways (`left: 50%` on a positioned <body>, read as used: `offset`) moves <body> as a whole:
  // what it adds on the left comes off the right.
  const shift = said.offset ? pixels(said.offset, whole, parse) || 0 : 0;
  margins[3] += shift;
  margins[1] -= shift;
  margins[0] = topMargin(margins[0], said, paddings[0], used - extra, parse);
  return { sized: isSized(said), grows: growsIn(said), column, margins, paddings };
}
