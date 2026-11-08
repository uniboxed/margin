// A copy of a style sheet the page's world can't read (another origin's, no
// CORS), made from its text (content/page-link.js fetches it through the
// background): pure text, so it's tested in node (tests/sheet-copy.test.js).
// The copy goes in the page after its link, so what it points to has to be
// absolute, and what it imports goes in with it: an import of another origin's
// in the copy would be unreadable again, its media queries the window's.

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const resolve = (path, base) => {
  try {
    return new URL(path, base).href;
  } catch {
    return null;
  }
};

/**
 * `css` with its relative addresses made absolute against `base` (the sheet's
 * own address): every `url()`, and `@import "…"` written with a space after it
 * or not (minified: `@import"../grid.css"`, anu.edu.au's).
 * @param {string} css @param {string} base
 */
export function absolute(css, base) {
  return css.replace(/url\(\s*(['"]?)(?!data:|#|[a-z][a-z0-9+.-]*:|\/\/)([^'")]+)\1\s*\)/gi, (whole, quote, path) => {
    const href = resolve(path, base);
    return href ? `url(${quote}${href}${quote})` : whole;
  }).replace(/@import\s*(['"])(?![a-z][a-z0-9+.-]*:|\/\/)([^'"]+)\1/gi, (whole, quote, path) => {
    const href = resolve(path, base);
    return href ? `@import ${quote}${href}${quote}` : whole;
  });
}

// An @import: its address (quoted, or in url()), then what it's conditional on (a media list, or layer/supports).
const IMPORT = /@import\s*(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/gi;
const CHARSET = /^\s*@charset\s+(['"])[^'"]*\1\s*;/i;

/**
 * `css` (already absolute, its own address `base`) with what it imports in it, so
 * that all of it is in one sheet the page's world can read and rewrite. Each import
 * is fetched with `fetchText(url)` (a string, or null if it can't be had) and put
 * where it was, inside `@media …` if it had a media list, its own imports in it too
 * (`depth` levels at most, `max` imports in all). If any import can't go in (it
 * couldn't be fetched, or it's in a layer or under `supports()`), none of them does:
 * the sheet keeps its imports as they are (absolute), since an import after a rule
 * would be dropped.
 * @param {string} css @param {string} base @param {(url: string) => Promise<string | null>} fetchText
 * @param {{ depth?: number, max?: number }} [limits]
 * @returns {Promise<string>}
 */
export async function inlineImports(css, base, fetchText, { depth = 3, max = 20 } = {}) {
  const budget = { left: max };
  const inlined = await inline(css, base, fetchText, depth, budget);
  return inlined ?? css;
}

// `css` with its imports in it, or null if one of them can't go in.
async function inline(css, base, fetchText, depth, budget) {
  const found = [...css.matchAll(IMPORT)];
  if (!found.length) return css;
  if (depth <= 0 || found.length > budget.left) return null;
  budget.left -= found.length;
  const wanted = [];
  for (const m of found) {
    const path = m[2] ?? m[4];
    const conditions = m[5].trim();
    if (/\b(layer|supports)\b/i.test(conditions)) return null;
    const url = ABSOLUTE.test(path) ? path : resolve(path, base);
    if (!url) return null;
    wanted.push({ m, url, conditions });
  }
  // Fetched all at once, not one after another: the copy waits for the slowest, not their sum.
  const texts = await Promise.all(wanted.map(({ url }) => fetchText(url)));
  if (texts.some((text) => typeof text !== 'string')) return null;
  const owns = await Promise.all(wanted.map(({ url }, i) => inline(absolute(texts[i], url).replace(CHARSET, ''), url, fetchText, depth - 1, budget)));
  if (owns.some((own) => own == null)) return null;
  const parts = wanted.map(({ m, conditions }, i) => ({ at: m.index, end: m.index + m[0].length, text: conditions ? `@media ${conditions} {\n${owns[i]}\n}` : owns[i] }));
  let out = '';
  let from = 0;
  for (const part of parts) {
    out += css.slice(from, part.at) + part.text;
    from = part.end;
  }
  return out + css.slice(from);
}
