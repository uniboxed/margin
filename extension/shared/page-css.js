// The page's CSS spoken for its box (content/page/): pure text, so it's tested
// in node. In the box the window is wider and taller than what the page has by
// `dw` and `dh`, but media queries and viewport units ask about the window.
// They're rewritten, in the page's own sheets, to ask about the box.

const fmt = (n) => String(Math.round(n * 1000) / 1000);
const toPx = (n, unit) => (unit.toLowerCase() === 'px' ? Number(n) : Number(n) * 16);

// Does this query say anything about the window's size?
export const asksSize = (query) => /(?<!device-)\b(?:width|height)\b/i.test(String(query));

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

// `value` with vw, vh, vmin and vmax taken as the box's, through --margin-box-dw
// and --margin-box-dh (always defined: content/page/box.js), so a value needs
// rewriting only once, whatever the box does after. Already rewritten: as it is.
export function shiftUnits(value) {
  if (!value || !hasUnits(value) || value.includes('--margin-box-d')) return value;
  const inUnits = (text) => text.replace(UNIT, (_, n, size = '', unit) => {
    const width = `calc(${n}${size}vw - ${fmt(n / 100)} * var(--margin-box-dw))`;
    const height = `calc(${n}${size}vh - ${fmt(n / 100)} * var(--margin-box-dh))`;
    if (unit === 'vw') return width;
    if (unit === 'vh') return height;
    return `${unit === 'vmin' ? 'min' : 'max'}(${width}, ${height})`;
  });
  return value.split(OPAQUE).map((part, i) => (i % 2 ? part : inUnits(part))).join('');
}

// The declarations a block's text gives, in its order: [name, value, important].
// Split at the `;`s outside brackets and strings.
export function declarations(cssText) {
  const out = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  const take = (end) => {
    const part = cssText.slice(start, end);
    start = end + 1;
    const colon = part.indexOf(':');
    if (colon <= 0) return;
    let value = part.slice(colon + 1).trim();
    const important = /!\s*important$/i.exec(value);
    if (important) value = value.slice(0, important.index).trimEnd();
    out.push([part.slice(0, colon).trim(), value, !!important]);
  };
  for (let i = 0; i < cssText.length; i++) {
    const c = cssText[i];
    if (c === '\\') i++;
    else if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) take(i);
  }
  take(cssText.length);
  return out;
}

// Property names known to be longhands, so not taken apart: what is a
// shorthand doesn't change. A name: a few hundred at most.
const LONGHANDS = new Set();

// A declaration block's viewport units made the box's (shiftUnits), in place.
// Only the declarations whose text has units are touched (a block can hold
// thousands of custom properties, and reading each would be quadratic). A
// shorthand is set as its longhands, taken apart on `scratch` (a detached
// element's style), so they read as they did; one with a var() of its own
// (its longhands read empty, pending the var()) is set again as a whole, and
// what that resets is put back. `style`: a CSSStyleDeclaration. `text`: its
// cssText, when already read.
export function shiftStyle(style, scratch, text = style.cssText) {
  const list = declarations(text);
  // `name: value` as its longhands and their values; null for a shorthand
  // pending a var().
  const apart = (name, value) => {
    if (name.startsWith('--') || LONGHANDS.has(name)) return [[name, value]];
    scratch.cssText = '';
    scratch.setProperty(name, value);
    const longhands = Array.from(scratch, (longhand) => [longhand, scratch.getPropertyValue(longhand)]);
    if (longhands.length === 1 && longhands[0][0] === name) LONGHANDS.add(name);
    return longhands.length && !longhands[0][1] ? null : longhands;
  };
  /** @type {Set<string> | undefined} */
  let named;
  /** @type {Set<string> | undefined} */
  let whole;
  for (const [name, value, important] of list) {
    const next = shiftUnits(value);
    if (next === value) continue;
    const priority = important ? 'important' : '';
    const longhands = apart(name, value);
    if (!longhands) {
      style.setProperty(name, next, priority);
      (whole ??= new Set()).add(name);
    } else if (longhands.length === 1 && longhands[0][0] === name) style.setProperty(name, next, priority);
    else {
      named ??= new Set(list.map(([n]) => n));
      for (const [longhand, before] of longhands) {
        const after = shiftUnits(before);
        // One set apart in the text is as the text says.
        if (after !== before && !named.has(longhand)) style.setProperty(longhand, after, priority);
      }
    }
  }
  if (!whole) return;
  named ??= new Set(list.map(([n]) => n));
  for (const [name, value, important] of list) {
    if (whole.has(name)) continue;
    const priority = important ? 'important' : '';
    for (const [longhand, before] of apart(name, value) ?? [[name, value]]) {
      if (longhand !== name && named.has(longhand)) continue;
      const want = shiftUnits(before);
      if (style.getPropertyValue(longhand) !== want || style.getPropertyPriority(longhand) !== priority) style.setProperty(longhand, want, priority);
    }
  }
}
