// The page's CSS spoken for its box (content/page/): pure text, so it's tested
// in node. In the box the window is wider and taller than what the page has by
// `dw` and `dh`, but media queries and viewport units ask about the window.
// They're rewritten, in the page's own sheets, to ask about the box.

const fmt = (n) => String(Math.round(n * 1000) / 1000);
const toPx = (n, unit) => (unit.toLowerCase() === 'px' ? Number(n) : Number(n) * 16);

// Does this query say anything about the window's size?
export const asksSize = (query) => /\b(width|height)\b/i.test(String(query).replace(/device-(width|height)/gi, ''));

const SIZE = String.raw`(-?(?:\d+\.?\d*|\.\d+))(px|em|rem)`;
const RANGE_NAMED = new RegExp(String.raw`\(\s*(min|max)-(width|height)\s*:\s*${SIZE}\s*\)`, 'gi');
const RANGE_LEFT = new RegExp(String.raw`${SIZE}(\s*[<>]=?\s*)(width|height)\b`, 'gi');
const RANGE_RIGHT = new RegExp(String.raw`\b(width|height)(\s*[<>]=?\s*)${SIZE}`, 'gi');

// `query` moved by (`dw`, `dh`) px: a query about a box this much smaller is
// the same query about a window this much larger. Sizes in em and rem are
// taken at 16px, as a media query's are. Not idempotent: a caller moves a
// query by the difference from what it was last moved by (content/page/sheets.js).
export function shiftQuery(query, dw, dh) {
  if (!query || (!dw && !dh)) return query;
  const by = (dimension) => (dimension.toLowerCase() === 'width' ? dw : dh);
  return query
    .replace(RANGE_NAMED, (_, limit, dimension, n, unit) => `(${limit}-${dimension}: ${fmt(toPx(n, unit) + by(dimension))}px)`)
    .replace(RANGE_LEFT, (_, n, unit, op, dimension) => `${fmt(toPx(n, unit) + by(dimension))}px${op}${dimension}`)
    .replace(RANGE_RIGHT, (_, dimension, op, n, unit) => `${dimension}${op}${fmt(toPx(n, unit) + by(dimension))}px`);
}

// Viewport units in a value, outside url(…) and strings.
const OPAQUE = /(url\([^)]*\)|"[^"]*"|'[^']*')/g;
const UNIT = /(?<![\w.#-])([-+]?(?:\d+\.?\d*|\.\d+))(s|l|d)?(vw|vh|vmin|vmax)\b/g;
export const hasUnits = (value) => /\dd?[sl]?v(?:w|h|min|max)\b/.test(value);

// `value` with vw, vh, vmin and vmax taken as the box's, through --margin-dw
// and --margin-dh (always defined: content/page/box.js), so a value needs
// rewriting only once, whatever the box does after. Already rewritten: as it is.
export function shiftUnits(value) {
  if (!value || !hasUnits(value) || value.includes('--margin-d')) return value;
  const inUnits = (text) => text.replace(UNIT, (_, n, size = '', unit) => {
    const width = `calc(${n}${size}vw - ${fmt(n / 100)} * var(--margin-dw))`;
    const height = `calc(${n}${size}vh - ${fmt(n / 100)} * var(--margin-dh))`;
    if (unit === 'vw') return width;
    if (unit === 'vh') return height;
    return `${unit === 'vmin' ? 'min' : 'max'}(${width}, ${height})`;
  });
  return value.split(OPAQUE).map((part, i) => (i % 2 ? part : inUnits(part))).join('');
}

// The property names a declaration block's text names, shorthands included
// (`font: … var(--x)` is listed as its longhands, which read empty until the
// var() is substituted, so only its text says `font`).
export function declaredNames(cssText) {
  const names = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  const take = (end) => {
    const part = cssText.slice(start, end);
    const colon = part.indexOf(':');
    if (colon > 0) names.push(part.slice(0, colon).trim().toLowerCase());
    start = end + 1;
  };
  for (let i = 0; i < cssText.length; i++) {
    const c = cssText[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) take(i);
  }
  take(cssText.length);
  return names;
}

// A declaration block's viewport units made the box's (shiftUnits), in place.
// A shorthand with a var() in it (its longhands read empty, pending the var())
// is set again as a whole, and the longhands set apart from it are put back
// as they were. `style`: a CSSStyleDeclaration.
export function shiftStyle(style) {
  const was = new Map();
  let pending = false;
  // Over a copy of the names: a property set moves to the end of the live list.
  for (const name of Array.from(style)) {
    const value = style.getPropertyValue(name);
    const priority = style.getPropertyPriority(name);
    if (!value) pending = true;
    was.set(name, [value, priority]);
    const next = shiftUnits(value);
    if (next !== value) style.setProperty(name, next, priority);
  }
  if (!pending) return;
  for (const name of declaredNames(style.cssText)) {
    if (was.has(name) || name.startsWith('--')) continue;
    const value = style.getPropertyValue(name);
    const next = shiftUnits(value);
    if (!value || next === value) continue;
    style.setProperty(name, next, style.getPropertyPriority(name));
    for (const [longhand, [before, priority]] of was) {
      if (before && style.getPropertyValue(longhand) !== shiftUnits(before)) style.setProperty(longhand, shiftUnits(before), priority);
    }
  }
}
