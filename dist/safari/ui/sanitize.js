// The theme sanitizer (PLAN.md §4): a theme's HTML and CSS come from
// strangers, so nothing in them may run code or reach the network.
//
// HTML: Margin parses the template itself (a small, strict tokenizer and tree
// builder below) into a plain tree, keeps only listed elements and
// attributes, and the renderer builds DOM from that tree with DOM APIs. The
// browser's HTML parser never sees a theme string, so there is no
// parse-serialize-reparse step for a mutation (mXSS) to hide in, and what this
// file checks is exactly what the DOM gets.
//
// CSS: tokenized as CSS Syntax 3 says, parsed into rules and declarations,
// checked, and written out again from the tokens. No @import; url() only to
// the theme's own files or data: images and fonts; no escapes outside strings;
// size and rule-count limits.
//
// Everything removed is reported. No DOM here: it runs in Node (the unit
// tests) as well as in pages. theme.json is checked by ui/theme-schema.js,
// and the whole package (all three, with its files) by ui/theme-loader.js.
import { isAction } from './actions.js';

export const LIMITS = Object.freeze({
  htmlBytes: 256 * 1024,
  htmlNodes: 6000,
  htmlDepth: 48,
  attrsPerElement: 48,
  attrValue: 4096,
  forDepth: 3,
  cssBytes: 256 * 1024,
  cssRules: 4000,
  cssDeclarations: 20000,
  cssDepth: 8,
  selectorLength: 1024,
  dataUrl: 128 * 1024,
  boundCssValue: 256,
  manifestBytes: 32 * 1024,
});

// ---------------------------------------------------------------------------
// Small helpers shared by both halves.

const SVG = 'svg';
const HTML = 'html';

const report = (list, kind, name, reason, at) => { list.push(at == null ? { kind, name, reason } : { kind, name, reason, at }); };

// A path inside the theme's package: plain segments, no '..', no leading '/',
// no scheme, no query. Only files the package actually has.
const PATH = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
export function isBundledPath(value, files) {
  if (typeof value !== 'string' || !PATH.test(value) || value.length > 200) return false;
  if (value.split('/').some((seg) => seg === '.' || seg === '..' || /^\.+$/.test(seg))) return false;
  return Array.isArray(files) ? files.includes(value) : files instanceof Set ? files.has(value) : false;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const FONT_EXT = /\.(woff2?|ttf|otf)$/i;

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon|svg\+xml)(;base64)?,(.*)$/s;
const DATA_FONT = /^data:(font\/(woff2|woff|ttf|otf|sfnt)|application\/(font-woff2?|x-font-ttf|x-font-woff));base64,(.*)$/s;

// A data: URL Margin accepts: images (any of the listed types) and, in CSS,
// fonts. Base64 must be clean base64; svg+xml may be percent-encoded text but
// with nothing that could end a CSS string or attribute.
export function isDataUrl(value, { fonts = false } = {}) {
  if (typeof value !== 'string' || value.length > LIMITS.dataUrl) return false;
  const image = DATA_IMAGE.exec(value);
  if (image) {
    if (image[2]) return B64.test(image[3]);
    return image[1] === 'svg+xml' && /^[^\s"'<>\\`(){}]*$/.test(image[3]);
  }
  if (!fonts) return false;
  const font = DATA_FONT.exec(value);
  return Boolean(font && B64.test(font[5]));
}

// A tab icon from the view model (`m-icon`): only a base64 data: image, the
// form Margin stores icons in. Checked when the value arrives, not when the
// theme loads, since the value isn't the theme's.
export const checkIconUrl = (value) => typeof value === 'string' && /^data:image\//.test(value) && /;base64,/.test(value) && isDataUrl(value);

// ---------------------------------------------------------------------------
// Bindings: `{{dotted.path}}`, dotted paths only, never expressions.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

/** @returns {string[] | null} the path's segments, or null when it isn't one */
export function parsePath(text) {
  if (typeof text !== 'string') return null;
  const segs = text.trim().split('.');
  if (!segs.length || segs.length > 8) return null;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (RESERVED.has(s)) return null;
    if (!(IDENT.test(s) || (i > 0 && /^\d{1,4}$/.test(s)))) return null;
  }
  return segs;
}

/**
 * Splits text with `{{holes}}` into parts.
 * @returns {{ parts: (string | { path: string[] })[], bound: boolean, bad: string | null }}
 */
export function parseInterpolation(text) {
  const parts = [];
  let bound = false;
  let bad = null;
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{{', i);
    if (open < 0) { parts.push(text.slice(i)); break; }
    const close = text.indexOf('}}', open + 2);
    if (close < 0) { parts.push(text.slice(i)); break; }
    if (open > i) parts.push(text.slice(i, open));
    const inner = text.slice(open + 2, close);
    const path = parsePath(inner);
    if (path) { parts.push({ path }); bound = true; } else { bad = inner.trim().slice(0, 60); parts.push(text.slice(open, close + 2)); }
    i = close + 2;
  }
  return { parts: parts.filter((p) => p !== ''), bound, bad };
}

// A binding-only value (`m-arg`, `m-class:x`, ...): exactly one `{{path}}`.
const singleBinding = (value) => {
  const m = /^\s*\{\{([^{}]*)\}\}\s*$/.exec(value);
  return m ? parsePath(m[1]) : null;
};

// ---------------------------------------------------------------------------
// HTML: tokenizer and tree builder.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'param', 'keygen']);
// Elements whose content is raw text to the HTML parser: Margin drops them
// with everything up to their end tag, whatever is inside.
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·',
  bull: '•', times: '×', divide: '÷', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', crarr: '↵', deg: '°',
  plusmn: '±', para: '¶', sect: '§', euro: '€', pound: '£', yen: '¥', cent: '¢', colon: ':', Tab: '\t', NewLine: '\n',
  lpar: '(', rpar: ')', sol: '/', bsol: '\\', excl: '!', num: '#', dollar: '$', percnt: '%', ast: '*', plus: '+',
  comma: ',', period: '.', semi: ';', equals: '=', quest: '?', commat: '@', lsqb: '[', rsqb: ']', lowbar: '_',
  grave: '`', lcub: '{', rcub: '}', verbar: '|', check: '✓', cross: '✗', star: '☆', starf: '★', thinsp: ' ',
  ensp: ' ', emsp: ' ', zwj: '‍', zwnj: '‌', lrm: '‎', rlm: '‏', cmd: '⌘',
};
const LEGACY = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg']);

export function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX][0-9A-Fa-f]{1,8};?|#[0-9]{1,10};?|[A-Za-z][A-Za-z0-9]{1,31};?)/g, (all, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const cp = parseInt(body.slice(hex ? 2 : 1).replace(';', ''), hex ? 16 : 10);
      if (!(cp > 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
      return String.fromCodePoint(cp);
    }
    const semi = body.endsWith(';');
    const name = semi ? body.slice(0, -1) : body;
    if (Object.hasOwn(ENTITIES, name) && (semi || LEGACY.has(name))) return ENTITIES[name];
    return all;
  });
}

const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

/**
 * Parses a template into a plain tree. Not HTML5's algorithm, on purpose:
 * Margin's template language is a strict subset, and since the browser never
 * re-parses the result, this tree is the truth.
 * @returns {{ root: any, removed: any[], errors: string[] }}
 */
export function parseHtml(html) {
  const removed = [];
  const errors = [];
  const root = { type: 'root', children: [] };
  const stack = [root];
  let nodes = 0;
  const top = () => stack[stack.length - 1];
  const line = (pos) => html.slice(0, pos).split('\n').length;
  let i = 0;
  const n = html.length;
  const text = (value) => {
    if (!value) return;
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    const decoded = decodeEntities(value);
    if (last && last.type === 'text') last.value += decoded; else { parent.children.push({ type: 'text', value: decoded }); nodes++; }
  };
  while (i < n && !errors.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { text(html.slice(i)); break; }
    if (lt > i) text(html.slice(i, lt));
    i = lt;
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    const next = html[i + 1];
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', i);
      report(removed, 'markup', html.slice(i, Math.min(i + 12, n)), 'declarations, CDATA and processing instructions', line(i));
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (next === '/') {
      const m = /^<\/([^\s/>]+)[^>]*>?/.exec(html.slice(i, i + 300));
      if (!m || !/^[A-Za-z]/.test(m[1])) { text('<'); i++; continue; }
      const end = html.indexOf('>', i);
      i = end < 0 ? n : end + 1;
      const name = m[1].toLowerCase();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].lname === name) { stack.length = s; break; }
      }
      continue;
    }
    if (!/[A-Za-z]/.test(next ?? '')) { text('<'); i++; continue; }
    // A start tag.
    const start = i;
    i++;
    let name = '';
    while (i < n && !isSpace(html[i]) && html[i] !== '/' && html[i] !== '>') name += html[i++];
    const attrs = [];
    let selfClosing = false;
    let closed = false;
    while (i < n) {
      while (i < n && (isSpace(html[i]) || (html[i] === '/' && html[i + 1] !== '>'))) i++;
      if (html[i] === '>') { i++; closed = true; break; }
      if (html[i] === '/' && html[i + 1] === '>') { i += 2; selfClosing = true; closed = true; break; }
      let an = '';
      if (html[i] === '=') an += html[i++];
      while (i < n && !isSpace(html[i]) && html[i] !== '/' && html[i] !== '>' && html[i] !== '=') an += html[i++];
      while (i < n && isSpace(html[i])) i++;
      let value = '';
      if (html[i] === '=') {
        i++;
        while (i < n && isSpace(html[i])) i++;
        const q = html[i];
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, i + 1);
          if (end < 0) { i = n; break; }
          value = html.slice(i + 1, end);
          i = end + 1;
        } else {
          while (i < n && !isSpace(html[i]) && html[i] !== '>') value += html[i++];
        }
      }
      if (an) attrs.push([an, decodeEntities(value)]);
    }
    if (!closed) { report(removed, 'element', name, 'unterminated tag', line(start)); break; }
    const lname = name.toLowerCase();
    if (RAW.has(lname)) {
      // Margin's Settings list (a <textarea m-input="setting-list">): kept,
      // empty (its text is Margin's), the rest up to its end tag skipped.
      const kept = lname === 'textarea' && attrs.some(([n, v]) => n.toLowerCase() === 'm-input' && v === 'setting-list');
      if (!kept) report(removed, 'element', lname, 'not allowed (dropped with its content)', line(start));
      if (lname === 'plaintext') { i = n; break; }
      const re = new RegExp(`</${lname}[\\s/>]`, 'ig');
      re.lastIndex = i;
      const m = re.exec(html);
      if (kept) top().children.push({ type: 'el', name, lname, ns: HTML, attrs, children: [], at: line(start) });
      if (!m) { i = n; break; }
      const end = html.indexOf('>', m.index);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const parent = top();
    const ns = parent.ns === SVG || lname === 'svg' ? SVG : HTML;
    const el = { type: 'el', name, lname, ns, attrs, children: [], at: line(start) };
    parent.children.push(el);
    if (++nodes > LIMITS.htmlNodes) { errors.push(`template: more than ${LIMITS.htmlNodes} nodes`); break; }
    if (!selfClosing && !(ns === HTML && VOID.has(lname))) {
      stack.push(el);
      if (stack.length > LIMITS.htmlDepth) { errors.push(`template: nested deeper than ${LIMITS.htmlDepth}`); break; }
    }
  }
  return { root, removed, errors };
}

// ---------------------------------------------------------------------------
// HTML: what's allowed.

const HTML_ELEMENTS = new Set([
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'nav', 'main', 'aside',
  'header', 'footer', 'section', 'article', 'figure', 'figcaption', 'small', 'strong', 'b', 'i', 'em', 'u', 's',
  'code', 'kbd', 'mark', 'br', 'hr', 'button', 'a', 'img', 'label', 'input', 'textarea', 'select', 'template', 'abbr', 'time', 'sup', 'sub',
  'blockquote', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'progress', 'meter', 'wbr', 'bdi',
]);
// Margin's own elements: control flow and slots.
const MARGIN_ELEMENTS = new Set([
  'm-for', 'm-if', 'm-else', 'm-page', 'm-window-controls', 'm-drag-region', 'm-palette', 'm-notice', 'm-menu', 'm-editor',
  'm-launcher', 'm-prompt', 'm-settings', 'm-cloud-tabs', 'm-switch-cover',
]);
// Dropped with everything inside them. (Raw-text elements never get this far.)
const DROP = new Set([
  'math', 'head', 'object', 'embed', 'applet', 'frame', 'frameset', 'link', 'meta', 'base', 'option',
  'optgroup', 'video', 'audio', 'source', 'track', 'picture', 'canvas', 'portal', 'fencedframe', 'dialog', 'svg:script',
  'param', 'map', 'area', 'slot', 'datalist', 'output', 'keygen', 'menu', 'search', 'selectedcontent',
]);
// Removed, children kept (sanitized). Anything else unknown is unwrapped too.
const UNWRAP = new Set(['html', 'body', 'form', 'fieldset', 'legend', 'center', 'font', 'details', 'summary']);

const SVG_ELEMENTS = new Map([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'linearGradient',
  'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'symbol', 'use', 'title', 'desc', 'text', 'tspan', 'marker',
  'filter', 'feGaussianBlur', 'feOffset', 'feColorMatrix', 'feBlend', 'feFlood', 'feComposite', 'feMerge',
  'feMergeNode', 'feDropShadow', 'feMorphology',
].map((name) => [name.toLowerCase(), name]));
const SVG_DROP = new Set([
  'script', 'foreignobject', 'style', 'iframe', 'image', 'feimage', 'animate', 'animatemotion', 'animatetransform', 'set',
  'discard', 'handler', 'listener', 'cursor', 'font', 'font-face', 'view', 'mpath', 'a', 'switch', 'video', 'audio',
]);

const SVG_ATTRS = new Map([
  'viewBox', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'fill', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'opacity',
  'fill-opacity', 'stroke-opacity', 'fill-rule', 'clip-rule', 'transform', 'points', 'r', 'rx', 'ry', 'cx', 'cy', 'fx',
  'fy', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'patternUnits',
  'patternTransform', 'preserveAspectRatio', 'clip-path', 'mask', 'filter', 'id', 'class', 'style', 'aria-hidden',
  'aria-label', 'focusable', 'role', 'shape-rendering', 'vector-effect', 'pathLength', 'href', 'stdDeviation', 'dx',
  'dy', 'in', 'in2', 'result', 'mode', 'operator', 'values', 'type', 'flood-color', 'flood-opacity', 'k1', 'k2', 'k3',
  'k4', 'radius', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'markerUnits', 'clipPathUnits',
  'maskUnits', 'maskContentUnits', 'text-anchor', 'dominant-baseline', 'font-size', 'font-weight', 'font-family',
  'letter-spacing', 'visibility', 'display',
].map((name) => [name.toLowerCase(), name]));

const GLOBAL_ATTRS = new Set(['class', 'id', 'role', 'title', 'lang', 'dir', 'hidden', 'tabindex', 'style']);
const ELEMENT_ATTRS = {
  a: ['href'],
  img: ['src', 'alt', 'width', 'height', 'decoding'],
  button: ['type', 'disabled'],
  label: ['for'],
  input: ['type', 'placeholder', 'autocomplete', 'spellcheck', 'autocapitalize', 'maxlength', 'inputmode', 'enterkeyhint', 'disabled'],
  textarea: ['rows', 'placeholder', 'autocomplete', 'spellcheck', 'disabled'],
  select: ['disabled'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  ol: ['start', 'reversed'],
  li: ['value'],
  time: ['datetime'],
  progress: ['value', 'max'],
  meter: ['value', 'min', 'max', 'low', 'high', 'optimum'],
  template: ['m-part'],
};

// Attributes a binding may set (`{{}}` in the value, or `m-attr:`).
const BINDABLE = (name, element) => /^aria-[a-z]+$/.test(name) || /^data-[a-z][a-z0-9-]*$/.test(name)
  || ['title', 'alt', 'hidden', 'disabled', 'lang', 'dir'].includes(name) || (name === 'placeholder' && element === 'input');

// Margin's behaviors (PLAN.md §3), by attribute: the values each takes
// (ui/behaviors/ implements them; they stay on the element, so a theme's CSS
// can select them).
const BEHAVIORS = {
  'm-drag': ['tab', 'pin', 'folder', 'space'],
  'm-drop': ['folder', 'space', 'tabs', 'pins'],
  'm-resize': ['sidebar'],
  'm-peek': ['left', 'right', 'top', 'bottom'],
  'm-rename': ['space', 'folder', 'tab'],
  'm-scroll': ['tabs', 'palette', 'archive'],
  'm-swipe': ['spaces'],
  'm-input': ['palette', 'space-name', 'space-emoji', 'launcher', ...['number', 'toggle', 'choice', 'list', 'shortcut', 'color'].map((k) => `setting-${k}`)],
};
// Which element each of Margin's inputs is: a Settings list is a <textarea>,
// a choice a <select> (Margin draws its options), the rest <input>s (Margin
// sets a number's and a toggle's type).
const INPUT_ELEMENT = (value) => (value === 'setting-list' ? 'textarea' : value === 'setting-choice' ? 'select' : 'input');
// Named parts a theme supplies (`<template m-part>`), which the runtime puts
// in its slots: `menu` in <m-menu>, `space-editor` in <m-editor>, `palette`
// in <m-palette>, `notice` in <m-notice>, `launcher` in <m-launcher>,
// `prompt` in <m-prompt>, `cloud-tabs` (iCloud Tabs' live folder) in <m-cloud-tabs>,
// `switch-cover` (the "switching" cover over the page) in <m-switch-cover>.
const PARTS = new Set(['palette-row', 'notice', 'menu-item', 'window-controls', 'menu', 'space-editor', 'palette', 'launcher', 'prompt', 'settings', 'cloud-tabs', 'switch-cover']);

// Margin's own words (PLAN.md §4: "a theme can still draw misleading text"):
// the parts that show Margin's menus, notices, prompts and confirmations
// (a delete that asks again, "install Margin.app"), and the slots they go
// in, whose content is the part when the theme has none; and iCloud Tabs'
// folder, whose one button asks for a permission; and the "switching"
// cover, which says where Margin is taking the person. Inside them every
// visible text is one of Margin's labels, bound from the view model: a text
// the theme wrote there is removed and reported, and so is a static value of
// an attribute that shows or speaks text. Icons (svg shapes), images and
// decoration stay. ui/render.js applies the same rule again as it compiles.
export const GUARDED_PARTS = Object.freeze(['menu', 'menu-item', 'notice', 'space-editor', 'prompt', 'settings', 'cloud-tabs', 'switch-cover']);
// The elements a part is put in.
const SLOT_ELEMENTS = new Set(['m-palette', 'm-notice', 'm-menu', 'm-editor', 'm-launcher', 'm-prompt', 'm-settings', 'm-cloud-tabs', 'm-switch-cover']);
export const GUARDED_SLOTS = Object.freeze(['m-menu', 'm-notice', 'm-editor', 'm-prompt', 'm-settings', 'm-cloud-tabs', 'm-switch-cover']);
// Attributes whose value is shown (a tooltip, a placeholder, an image's
// stand-in) or spoken (a screen reader's label).
export const TEXT_ATTRS = Object.freeze(['title', 'alt', 'placeholder', 'aria-label', 'aria-description', 'aria-roledescription',
  'aria-valuetext', 'aria-placeholder', 'aria-braillelabel', 'aria-brailleroledescription']);
const GUARDED_PART_SET = new Set(GUARDED_PARTS);
const GUARDED_SLOT_SET = new Set(GUARDED_SLOTS);
const TEXT_ATTR_SET = new Set(TEXT_ATTRS);

/**
 * A text (a text node's, or a text attribute's value) as a guarded part may
 * have it: its `{{bindings}}` and the whitespace between them, nothing the
 * theme wrote. `removed`: the words taken out ('' when there were none);
 * `text`: what's left ('' when nothing is).
 * @param {string} value @returns {{ text: string, removed: string }}
 */
export function guardText(value) {
  const { parts } = parseInterpolation(String(value));
  let text = '';
  let removed = '';
  for (const p of parts) {
    if (typeof p !== 'string') { text += `{{${p.path.join('.')}}}`; continue; }
    if (/\S/.test(p)) { removed += p; if (/\s/.test(p) && text && !/\s$/.test(text)) text += ' '; } else text += p;
  }
  return { text: /\{\{/.test(text) ? text : '', removed: removed.trim() };
}
const guardedWhy = (guard) => `static text in Margin's ${guard} (only Margin's bound labels show there)`;

const ID_VALUE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// Ids a theme may not give: an element with an id is also a property of the
// window (named access) wherever the window has none of its own, and these
// are names Margin's code, the app's bridge or the extension's APIs are read
// by. (The overlay's container is its document, so its ids are the window's.)
// Every global of Margin's own is `margin` and a capital (`marginApp`,
// `marginFallbackTheme`: RESERVED_PREFIX), so a later one is covered too;
// `margin-results` and the like stay.
export const RESERVED_IDS = Object.freeze(['browser', 'chrome', 'safari', 'webkit', 'marginApp', 'marginFallbackTheme', 'Margin', 'T', 'margin', 'opener', 'parent', 'top', 'self', 'frames', 'window', 'document', 'globalThis', 'module', 'exports', 'define', 'require']);
const RESERVED_ID_SET = new Set(RESERVED_IDS.map((id) => id.toLowerCase()));
export const RESERVED_PREFIX = /^margin[A-Z0-9_]/i;
const idOk = (value) => ID_VALUE.test(value) && !RESERVED_ID_SET.has(value.toLowerCase()) && !RESERVED_PREFIX.test(value);
const FRAGMENT_URL = /^url\(\s*#[A-Za-z][A-Za-z0-9_-]*\s*\)$/;

function staticValueOk(element, name, value, ctx) {
  switch (name) {
    case 'href':
      if (element === 'use') return /^#[A-Za-z][A-Za-z0-9_-]*$/.test(value) ? value : null;
      return /^#([A-Za-z][A-Za-z0-9_-]*)?$/.test(value) ? value : null;
    case 'src': {
      if (isDataUrl(value)) return value;
      if (isBundledPath(value, ctx.files) && IMAGE_EXT.test(value)) return ctx.assetUrl(value);
      return null;
    }
    case 'id': return idOk(value) ? value : null;
    case 'for': return ID_VALUE.test(value) ? value : null;
    case 'tabindex': return /^(-1|0)$/.test(value) ? value : null;
    case 'type':
      if (element === 'button') return value.toLowerCase() === 'button' ? 'button' : null;
      if (element === 'input') return /^(text|search)$/i.test(value) ? value.toLowerCase() : null;
      return ctx.ns === SVG ? value : null;
    case 'role': return /^[a-z]+( [a-z]+)*$/.test(value) ? value : null;
    case 'width': case 'height': case 'colspan': case 'rowspan': case 'start': case 'maxlength': case 'rows':
      return ctx.ns === SVG ? value : (/^\d{1,5}$/.test(value) ? value : null);
    case 'autocomplete': return /^(on|off)$/.test(value) ? value : null;
    case 'spellcheck': return /^(true|false)$/.test(value) ? value : null;
    default: return value;
  }
}

/**
 * Sanitizes a template.
 * @param {string} html
 * @param {{ files?: string[], assetUrl?: (path: string) => string }} [options]
 * @returns {{ tree: any, removed: any[], errors: string[], stats: { pages: number, nodes: number }, structure?: { parts: string[], slots: string[] } }}
 */
export function sanitizeTemplate(html, { files = [], assetUrl = (p) => p } = {}) {
  if (typeof html !== 'string') return { tree: null, removed: [], errors: ['template: not text'], stats: { pages: 0, nodes: 0 } };
  if (html.length > LIMITS.htmlBytes) return { tree: null, removed: [], errors: [`template: larger than ${LIMITS.htmlBytes} bytes`], stats: { pages: 0, nodes: 0 } };
  if (/[\u0000]/.test(html)) return { tree: null, removed: [], errors: ['template: NUL character'], stats: { pages: 0, nodes: 0 } };
  const parsed = parseHtml(html);
  const removed = parsed.removed;
  const errors = parsed.errors;
  const stats = { pages: 0, nodes: 0 };
  const ctx = { files, assetUrl, removed, errors, stats, parts: new Set(), slots: new Set() };
  const children = cleanChildren(parsed.root.children, { ...ctx, ns: HTML, forDepth: 0, inTemplate: false, inIf: false, guard: null });
  const tree = { type: 'root', children };
  if (!errors.length) {
    const roots = children.filter((c) => c.type === 'el');
    if (roots.length !== 1) errors.push(`template: needs exactly one root element (found ${roots.length})`);
    if (stats.pages !== 1) errors.push(`template: needs exactly one <m-page> (found ${stats.pages})`);
  }
  // Which parts it has, and where its slots are ("launcher>m-settings": in the
  // launcher part; ">m-notice": in the window's own tree). ui/theme-import.js
  // checks an import has what the person needs to get back out of it.
  const structure = { parts: [...ctx.parts], slots: [...ctx.slots] };
  return { tree, removed, errors, stats, structure };
}

function cleanChildren(list, ctx) {
  const out = [];
  for (const node of list) {
    const cleaned = cleanNode(node, ctx);
    if (Array.isArray(cleaned)) out.push(...cleaned); else if (cleaned) out.push(cleaned);
  }
  return out;
}

function cleanNode(node, ctx) {
  if (node.type === 'text') {
    const { bad } = parseInterpolation(node.value);
    if (ctx.guard) {
      const g = guardText(node.value);
      if (g.removed) report(ctx.removed, 'text', JSON.stringify(g.removed.slice(0, 60)), guardedWhy(ctx.guard));
      if (g.removed) return g.text ? { type: 'text', value: g.text } : null;
    }
    if (bad) report(ctx.removed, 'binding', `{{${bad}}}`, 'not a dotted path: left as plain text');
    return { type: 'text', value: node.value };
  }
  const { lname, at } = node;
  if (ctx.ns === SVG || lname === 'svg') return cleanSvg(node, ctx);
  if (lname.includes(':')) { report(ctx.removed, 'element', node.name, 'namespaced element', at); return null; }
  if (DROP.has(lname)) { report(ctx.removed, 'element', lname, 'not allowed (dropped with its content)', at); return null; }
  if (lname.startsWith('m-') && !MARGIN_ELEMENTS.has(lname)) { report(ctx.removed, 'element', lname, 'not one of Margin\'s elements', at); return null; }
  if (!HTML_ELEMENTS.has(lname) && !MARGIN_ELEMENTS.has(lname)) {
    report(ctx.removed, 'element', lname, UNWRAP.has(lname) ? 'not allowed (children kept)' : 'unknown element (children kept)', at);
    return cleanChildren(node.children, ctx);
  }
  const sub = { ...ctx };
  if (lname === 'template') {
    sub.inTemplate = true;
    const part = node.attrs.find(([n]) => n.toLowerCase() === 'm-part')?.[1];
    // One template per part: the renderer uses the first, so a second is dead weight (or a decoy).
    if (part && PARTS.has(part)) {
      if (ctx.parts.has(part)) { report(ctx.removed, 'element', `template m-part="${part}"`, 'a second template for this part (the first is the one used)', at); return null; }
      ctx.parts.add(part);
      sub.part = part;
    }
    if (GUARDED_PART_SET.has(part)) sub.guard = `"${part}" part`;
  }
  if (GUARDED_SLOT_SET.has(lname)) sub.guard ??= `<${lname}>`;
  if (SLOT_ELEMENTS.has(lname)) ctx.slots?.add(`${ctx.part ?? ''}>${lname}`);
  if (lname === 'm-for') {
    sub.forDepth = ctx.forDepth + 1;
    if (sub.forDepth > LIMITS.forDepth) { ctx.errors.push(`template: <m-for> nested deeper than ${LIMITS.forDepth}`); return null; }
  }
  if (lname === 'm-else' && !ctx.inIf) { report(ctx.removed, 'element', 'm-else', 'outside <m-if>', at); return null; }
  sub.inIf = lname === 'm-if';
  if (lname === 'm-page') {
    if (ctx.forDepth > 0 || ctx.inTemplate) { ctx.errors.push('template: <m-page> inside <m-for> or <template>'); return null; }
    ctx.stats.pages++;
    if (node.children.some((c) => c.type === 'el' || (c.type === 'text' && c.value.trim()))) report(ctx.removed, 'element', 'm-page', 'its content (the page goes there)', at);
  }
  if ((lname === 'input' || lname === 'textarea' || lname === 'select') && !node.attrs.some(([n, v]) => n.toLowerCase() === 'm-input' && INPUT_ELEMENT(v) === lname)) {
    report(ctx.removed, 'element', lname, 'only Margin\'s inputs (m-input) are allowed', at);
    return null;
  }
  // A guarded slot's own attributes are guarded too (its title shows over the menu).
  const attrs = cleanAttrs(node, lname, HTML, GUARDED_SLOT_SET.has(lname) ? sub : ctx);
  if (attrs === null) return null;
  if (lname === 'button' && !attrs.some(([n]) => n === 'type')) attrs.push(['type', 'button']);
  ctx.stats.nodes++;
  // (A <select>'s options and a <textarea>'s text are Margin's.)
  const children = lname === 'm-page' || lname === 'select' || lname === 'textarea' ? [] : cleanChildren(node.children, sub);
  return { type: 'el', ns: HTML, name: lname, attrs, children };
}

function cleanSvg(node, ctx) {
  const { lname, at } = node;
  if (SVG_DROP.has(lname) || lname.includes(':')) {
    report(ctx.removed, 'element', `svg ${node.name}`, lname === 'a' ? 'svg links (children kept)' : 'not allowed in svg (dropped with its content)', at);
    return lname === 'a' ? cleanChildren(node.children, { ...ctx, ns: SVG }) : null;
  }
  const name = SVG_ELEMENTS.get(lname);
  if (!name) {
    report(ctx.removed, 'element', `svg ${node.name}`, 'not allowed in svg (dropped with its content)', at);
    return null;
  }
  // A <use> draws what it points at, wherever that is: inside a guarded part
  // it could show text the theme wrote outside it (svg <text> in a <symbol>).
  if (name === 'use' && ctx.guard) {
    report(ctx.removed, 'element', 'svg use', `inside Margin's ${ctx.guard} (it can show the theme's text from outside it)`, at);
    return null;
  }
  const attrs = cleanAttrs(node, name, SVG, ctx);
  if (attrs === null) return null;
  ctx.stats.nodes++;
  return { type: 'el', ns: SVG, name, attrs, children: cleanChildren(node.children, { ...ctx, ns: SVG }) };
}

// Returns the kept attributes, or null when the element itself must go.
function cleanAttrs(node, element, ns, ctx) {
  const out = [];
  const seen = new Set();
  const where = `<${element}>`;
  const drop = (name, reason) => report(ctx.removed, 'attribute', `${where} ${name}`, reason, node.at);
  if (node.attrs.length > LIMITS.attrsPerElement) { report(ctx.removed, 'element', element, `more than ${LIMITS.attrsPerElement} attributes`, node.at); return null; }
  let hasAction = false;
  for (const [rawName, value] of node.attrs) {
    const lower = rawName.toLowerCase();
    if (seen.has(lower)) { drop(rawName, 'repeated'); continue; }
    seen.add(lower);
    if (lower.startsWith('on')) { drop(rawName, 'event handlers are never allowed'); continue; }
    if (lower === 'xmlns' || lower.startsWith('xmlns:')) continue;
    if (value.length > LIMITS.attrValue) { drop(rawName, 'value too long'); continue; }
    if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(value)) { drop(rawName, 'control characters'); continue; }
    if ((element === 'm-for' && (lower === 'each' || lower === 'as' || lower === 'key')) || (element === 'm-if' && lower === 'test')) {
      const kept = controlAttr(lower, value);
      if (kept === null) drop(rawName, lower === 'as' || lower === 'key' ? 'not a name' : 'not a dotted path'); else out.push([lower, kept]);
      continue;
    }
    if (lower.startsWith('m-')) {
      const kept = marginAttr(element, ns, lower, value, ctx, drop);
      if (kept) { out.push(kept); if (lower === 'm-action') hasAction = true; }
      continue;
    }
    let name;
    if (ns === SVG) {
      name = lower === 'xlink:href' ? 'href' : SVG_ATTRS.get(lower);
      if (!name) { drop(rawName, 'not allowed in svg'); continue; }
      if (name === 'href' && element !== 'use') { drop(rawName, 'links in svg'); continue; }
    } else {
      const allowed = GLOBAL_ATTRS.has(lower) || /^aria-[a-z]+$/.test(lower) || /^data-[a-z][a-z0-9-]*$/.test(lower)
        || (ELEMENT_ATTRS[element] ?? []).includes(lower);
      if (!allowed) { drop(rawName, 'not allowed'); continue; }
      name = lower;
    }
    if (ctx.guard && TEXT_ATTR_SET.has(name)) {
      const g = guardText(value);
      if (g.removed) {
        drop(rawName, `${guardedWhy(ctx.guard)}: ${JSON.stringify(g.removed.slice(0, 60))}`);
        if (g.text) out.push([name, g.text]);
        continue;
      }
    }
    const interp = parseInterpolation(value);
    if (interp.bound) {
      if (!BINDABLE(name, element)) { drop(rawName, `bindings can't set ${name}`); continue; }
      out.push([name, value]);
      continue;
    }
    if (name === 'style') {
      const css = sanitizeDeclarations(value, ctx);
      for (const r of css.removed) ctx.removed.push({ ...r, name: `${where} style: ${r.name}`, at: node.at });
      if (css.css) out.push(['style', css.css]);
      continue;
    }
    if (ns === SVG && /url\s*\(/i.test(value) && !FRAGMENT_URL.test(value.trim())) { drop(rawName, 'url() other than #fragment'); continue; }
    if (ns === SVG && name === 'id' && !idOk(value)) { drop(rawName, ID_VALUE.test(value) ? 'named like a global Margin reads' : 'bad id'); continue; }
    if (ns === SVG && name !== 'href' && name !== 'style') { out.push([name, value]); continue; }
    const ok = staticValueOk(element, name, value, { ...ctx, ns });
    if (ok === null) { drop(rawName, `value ${JSON.stringify(value.slice(0, 80))} not allowed`); continue; }
    out.push([name, ok]);
  }
  if (out.some(([n]) => n === 'm-arg') && !hasAction) {
    report(ctx.removed, 'attribute', `${where} m-arg`, 'without m-action', node.at);
    return out.filter(([n]) => n !== 'm-arg');
  }
  if (element === 'm-for' && (!out.some(([n]) => n === 'each') || !out.some(([n]) => n === 'as'))) {
    report(ctx.removed, 'element', 'm-for', 'needs each and as', node.at);
    return null;
  }
  if (element === 'm-if' && !out.some(([n]) => n === 'test')) { report(ctx.removed, 'element', 'm-if', 'needs test', node.at); return null; }
  return out;
}

// A Margin attribute: bindings, actions, behaviors, and m-for/m-if's own.
function marginAttr(element, ns, name, value, ctx, drop) {
  if (name.startsWith('m-attr:')) {
    const target = name.slice(7);
    if (!BINDABLE(target, element)) { drop(name, `bindings can't set ${target}`); return null; }
    return singleBinding(value) ? [name, value] : (drop(name, 'needs one {{path}}'), null);
  }
  if (name.startsWith('m-class:')) {
    if (!/^[A-Za-z_-][A-Za-z0-9_-]{0,63}$/.test(name.slice(8))) { drop(name, 'bad class name'); return null; }
    return singleBinding(value) ? [name, value] : (drop(name, 'needs one {{path}}'), null);
  }
  if (name.startsWith('m-style:')) {
    if (!/^--[A-Za-z0-9_-]{1,64}$/.test(name.slice(8))) { drop(name, 'only CSS variables (--name) can be bound'); return null; }
    return singleBinding(value) ? [name, value] : (drop(name, 'needs one {{path}}'), null);
  }
  switch (name) {
    case 'm-action':
      if (!(element === 'button' || element === 'a') || ns !== HTML) { drop(name, 'only on <button> or <a>'); return null; }
      if (!isAction(value)) { drop(name, `unknown action ${JSON.stringify(value.slice(0, 60))}`); return null; }
      return [name, value];
    case 'm-arg':
      if (parseInterpolation(value).bound) return singleBinding(value) ? [name, value] : (drop(name, 'needs one {{path}} or a literal'), null);
      return value.length <= 256 ? [name, value] : (drop(name, 'too long'), null);
    case 'm-icon':
      if (element !== 'img') { drop(name, 'only on <img>'); return null; }
      return singleBinding(value) ? [name, value] : (drop(name, 'needs one {{path}}'), null);
    case 'm-part':
      if (element !== 'template' || !PARTS.has(value)) { drop(name, 'unknown part'); return null; }
      return [name, value];
    default:
      if (Object.hasOwn(BEHAVIORS, name)) {
        if (name === 'm-input' && element !== INPUT_ELEMENT(value)) { drop(name, `only on <${INPUT_ELEMENT(value)}>`); return null; }
        return BEHAVIORS[name].includes(value) ? [name, value] : (drop(name, `unknown ${name} value`), null);
      }
      drop(name, 'not one of Margin\'s attributes');
      return null;
  }
}

// m-for's each, as and key, and m-if's test. `each` and `test` are paths,
// with or without braces (`test` may start with '!'); `as` and `key` names.
function controlAttr(name, value) {
  if (name === 'as' || name === 'key') return IDENT.test(value) && !RESERVED.has(value) ? value : null;
  const neg = name === 'test' && /^\s*!/.test(value);
  const inner = value.replace(/^\s*!/, '').replace(/^\s*\{\{([^{}]*)\}\}\s*$/, '$1');
  const path = parsePath(inner);
  return path ? `${neg ? '!' : ''}${path.join('.')}` : null;
}

// ---------------------------------------------------------------------------
// CSS: tokenizer (CSS Syntax Level 3, §4).

const isHex = (c) => /[0-9A-Fa-f]/.test(c ?? '');
const isNameStart = (c) => c !== undefined && (/[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80);
const isName = (c) => c !== undefined && (isNameStart(c) || /[0-9-]/.test(c));
const isDigit = (c) => c !== undefined && c >= '0' && c <= '9';
const isWs = (c) => c === ' ' || c === '\n' || c === '\t';

/**
 * @typedef {{ t: string, v?: any, s: number, e: number, esc?: boolean, unit?: string, type?: string }} Token
 */

/**
 * Tokenizes CSS. Newlines are normalized first (CR, CRLF and FF become LF).
 * Comments become nothing: two tokens with a gap between them had one.
 * @returns {Token[]}
 */
export function tokenizeCss(input) {
  const s = input.replace(/\r\n?|\f/g, '\n');
  const out = [];
  let i = 0;
  const n = s.length;
  const validEscape = (a, b) => a === '\\' && b !== '\n' && b !== undefined;
  const startsIdent = (a, b, c) => {
    if (a === '-') return isNameStart(b) || b === '-' || validEscape(b, c);
    if (isNameStart(a)) return true;
    return validEscape(a, b);
  };
  const startsNumber = (a, b, c) => {
    if (a === '+' || a === '-') return isDigit(b) || (b === '.' && isDigit(c));
    if (a === '.') return isDigit(b);
    return isDigit(a);
  };
  const consumeEscape = () => {
    // s[i] is the char after the backslash.
    if (isHex(s[i])) {
      let hex = '';
      while (hex.length < 6 && isHex(s[i])) hex += s[i++];
      if (isWs(s[i])) i++;
      const cp = parseInt(hex, 16);
      return cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff ? '�' : String.fromCodePoint(cp);
    }
    if (i >= n) return '�';
    const cp = s.codePointAt(i);
    i += cp > 0xffff ? 2 : 1;
    return String.fromCodePoint(cp);
  };
  const consumeName = (tok) => {
    let name = '';
    for (;;) {
      const c = s[i];
      if (isName(c)) { name += c; i++; } else if (validEscape(c, s[i + 1])) { i++; tok.esc = true; name += consumeEscape(); } else return name;
    }
  };
  const consumeNumber = () => {
    const start = i;
    if (s[i] === '+' || s[i] === '-') i++;
    while (isDigit(s[i])) i++;
    if (s[i] === '.' && isDigit(s[i + 1])) { i += 2; while (isDigit(s[i])) i++; }
    if ((s[i] === 'e' || s[i] === 'E') && (isDigit(s[i + 1]) || ((s[i + 1] === '+' || s[i + 1] === '-') && isDigit(s[i + 2])))) {
      i += 2;
      while (isDigit(s[i])) i++;
    }
    return Number(s.slice(start, i));
  };
  const consumeString = (q, tok) => {
    let v = '';
    for (;;) {
      const c = s[i];
      if (i >= n) { return v; }
      if (c === q) { i++; return v; }
      if (c === '\n') { tok.t = 'badstr'; return v; }
      if (c === '\\') {
        if (i + 1 >= n) { i++; continue; }
        if (s[i + 1] === '\n') { i += 2; continue; }
        i++;
        tok.esc = true;
        v += consumeEscape();
        continue;
      }
      v += c;
      i++;
    }
  };
  const consumeBadUrl = () => {
    while (i < n) {
      if (s[i] === ')') { i++; return; }
      if (validEscape(s[i], s[i + 1])) { i++; consumeEscape(); } else i++;
    }
  };
  const consumeUrl = (tok) => {
    while (isWs(s[i])) i++;
    let v = '';
    for (;;) {
      const c = s[i];
      if (i >= n) { tok.v = v; return; }
      if (c === ')') { i++; tok.v = v; return; }
      if (isWs(c)) {
        while (isWs(s[i])) i++;
        if (s[i] === ')' || i >= n) { if (i < n) i++; tok.v = v; return; }
        tok.t = 'badurl'; consumeBadUrl(); return;
      }
      if (c === '"' || c === "'" || c === '(' || /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(c)) { tok.t = 'badurl'; consumeBadUrl(); return; }
      if (c === '\\') {
        if (validEscape(c, s[i + 1])) { i++; tok.esc = true; v += consumeEscape(); continue; }
        tok.t = 'badurl'; consumeBadUrl(); return;
      }
      v += c;
      i++;
    }
  };
  while (i < n) {
    const start = i;
    const c = s[i];
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    /** @type {Token} */
    const tok = { t: '', s: start, e: start };
    if (isWs(c)) {
      while (isWs(s[i])) i++;
      tok.t = 'ws';
    } else if (c === '"' || c === "'") {
      i++;
      tok.t = 'str';
      tok.v = consumeString(c, tok);
    } else if (c === '#') {
      if (isName(s[i + 1]) || validEscape(s[i + 1], s[i + 2])) {
        i++;
        tok.t = 'hash';
        tok.type = startsIdent(s[i], s[i + 1], s[i + 2]) ? 'id' : 'unrestricted';
        tok.v = consumeName(tok);
      } else { i++; tok.t = 'delim'; tok.v = '#'; }
    } else if (c === '(' || c === ')' || c === '[' || c === ']' || c === '{' || c === '}' || c === ',' || c === ':' || c === ';') {
      i++;
      tok.t = c;
    } else if (c === '+' || c === '.') {
      if (startsNumber(c, s[i + 1], s[i + 2])) numeric(tok); else { i++; tok.t = 'delim'; tok.v = c; }
    } else if (c === '-') {
      if (startsNumber(c, s[i + 1], s[i + 2])) numeric(tok);
      else if (s[i + 1] === '-' && s[i + 2] === '>') { i += 3; tok.t = 'cdc'; }
      else if (startsIdent(c, s[i + 1], s[i + 2])) identLike(tok);
      else { i++; tok.t = 'delim'; tok.v = c; }
    } else if (c === '<') {
      if (s.startsWith('<!--', i)) { i += 4; tok.t = 'cdo'; } else { i++; tok.t = 'delim'; tok.v = c; }
    } else if (c === '@') {
      if (startsIdent(s[i + 1], s[i + 2], s[i + 3])) { i++; tok.t = 'at'; tok.v = consumeName(tok); } else { i++; tok.t = 'delim'; tok.v = c; }
    } else if (c === '\\') {
      if (validEscape(c, s[i + 1])) identLike(tok); else { i++; tok.t = 'delim'; tok.v = c; tok.esc = true; }
    } else if (isDigit(c)) {
      numeric(tok);
    } else if (isNameStart(c)) {
      identLike(tok);
    } else {
      const cp = s.codePointAt(i);
      i += cp > 0xffff ? 2 : 1;
      tok.t = 'delim';
      tok.v = String.fromCodePoint(cp);
    }
    tok.e = i;
    out.push(tok);
  }
  return out;

  function numeric(tok) {
    tok.v = consumeNumber();
    if (startsIdent(s[i], s[i + 1], s[i + 2])) { tok.t = 'dim'; tok.unit = consumeName(tok); } else if (s[i] === '%') { i++; tok.t = 'pct'; } else tok.t = 'num';
  }
  function identLike(tok) {
    const name = consumeName(tok);
    if (name.toLowerCase() === 'url' && s[i] === '(') {
      i++;
      let j = i;
      while (isWs(s[j]) && isWs(s[j + 1])) j++;
      const q = isWs(s[j]) ? s[j + 1] : s[j];
      if (q === '"' || q === "'") { tok.t = 'func'; tok.v = name; return; }
      tok.t = 'url';
      consumeUrl(tok);
      return;
    }
    if (s[i] === '(') { i++; tok.t = 'func'; tok.v = name; return; }
    tok.t = 'ident';
    tok.v = name;
  }
}

// ---------------------------------------------------------------------------
// CSS: component values, rules, declarations (CSS Syntax 3 §5, with nesting).

const CLOSE = { '(': ')', '[': ']', '{': '}', func: ')' };

// Groups tokens into component values: a token, a function { fn, args }, or
// a simple block { open, items }. Unclosed ones close at the end (as in CSS).
function components(tokens) {
  let i = 0;
  const list = (close) => {
    const items = [];
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.t === close) { i++; return { items, end: t }; }
      items.push(one());
    }
    return { items, end: null };
  };
  const one = () => {
    const t = tokens[i++];
    if (t.t === 'func') { const { items, end } = list(')'); return { fn: t.v.toLowerCase(), tok: t, args: items, end }; }
    if (t.t === '(' || t.t === '[' || t.t === '{') { const { items, end } = list(CLOSE[t.t]); return { open: t.t, tok: t, items, end }; }
    return t;
  };
  const all = [];
  while (i < tokens.length) all.push(one());
  return all;
}

const isTok = (cv, type) => cv && cv.t === type;
const isWsCv = (cv) => cv && cv.t === 'ws';
const isBlock = (cv, open = '{') => cv && cv.open === open;

// The at-rules a theme may use, and what their blocks hold.
const AT_RULES = {
  media: 'rules', supports: 'rules', container: 'rules', layer: 'rules', 'starting-style': 'rules', scope: 'rules',
  keyframes: 'keyframes', '-webkit-keyframes': 'keyframes', 'font-face': 'declarations', property: 'declarations',
};
const BLOCKED_PROPERTIES = new Set(['behavior', '-ms-behavior', '-moz-binding', '-webkit-binding']);
// Functions that take a URL as a plain string, so a string inside is a URL.
const URL_STRING_FUNCTIONS = new Set(['image-set', '-webkit-image-set', 'image', 'cross-fade', '-webkit-cross-fade', 'src']);
// Functions a theme may use, in values, selectors and at-rule preludes. A
// function not listed is refused, so a CSS feature Margin doesn't know (one
// that might load a URL) never gets through. Not listed on purpose: attr()
// (page data into values), image(), cross-fade(), src(), element(), paint(),
// expression().
const FUNCTIONS = new Set([
  // colors
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark',
  // math and variables
  'calc', 'min', 'max', 'clamp', 'round', 'mod', 'rem', 'abs', 'sign', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'atan2', 'pow', 'sqrt', 'hypot', 'log', 'exp', 'var', 'env',
  // images (URLs inside checked)
  'url', 'image-set', '-webkit-image-set', 'linear-gradient', 'radial-gradient', 'conic-gradient',
  'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient', '-webkit-linear-gradient',
  '-webkit-radial-gradient', 'type',
  // transforms and filters
  'translate', 'translatex', 'translatey', 'translatez', 'translate3d', 'scale', 'scalex', 'scaley', 'scalez', 'scale3d',
  'rotate', 'rotatex', 'rotatey', 'rotatez', 'rotate3d', 'skew', 'skewx', 'skewy', 'matrix', 'matrix3d', 'perspective',
  'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia',
  // timing, grid, shapes, fonts, counters, timelines, anchors
  'cubic-bezier', 'steps', 'linear', 'repeat', 'minmax', 'fit-content', 'inset', 'circle', 'ellipse', 'polygon', 'path',
  'rect', 'xywh', 'format', 'local', 'tech', 'counter', 'counters', 'view', 'scroll', 'anchor', 'anchor-size',
  // selectors and at-rule preludes
  'is', 'not', 'has', 'where', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'host', 'host-context',
  'slotted', 'part', 'lang', 'dir', 'state', 'selector', 'style', 'font-format', 'font-tech', 'supports', 'layer',
]);
// Properties that write text on the page: a theme's stylesheet writes none
// (only `""`, an empty box to decorate), so the words in Margin's menus,
// notices and prompts can only be Margin's labels (GUARDED_PARTS): CSS
// can't know which elements its rules reach. No strings but empty ones, no
// var() or env() (a variable could hold a string), and counters and list
// markers only as numbers or symbols, never letters (upper-alpha spells
// words from a counter's values).
const TEXT_PROPERTIES = new Set(['content', 'quotes', 'list-style', 'list-style-type', 'hyphenate-character', '-webkit-hyphenate-character',
  'text-emphasis', 'text-emphasis-style', '-webkit-text-emphasis', '-webkit-text-emphasis-style', 'text-overflow']);
const NUMBER_STYLES = new Set(['none', 'disc', 'circle', 'square', 'decimal', 'decimal-leading-zero', 'disclosure-open', 'disclosure-closed']);
const LIST_WORDS = new Set([...NUMBER_STYLES, 'inside', 'outside', 'inherit', 'initial', 'unset', 'revert', 'revert-layer']);
function writesText(prop, items) {
  for (const cv of items) {
    if (cv.fn !== undefined) {
      if (cv.fn === 'var' || cv.fn === 'env' || cv.fn === 'attr') return `${cv.fn}() in a property that writes text`;
      if (cv.fn === 'counter' || cv.fn === 'counters') {
        const args = cv.args.filter((a) => !isWsCv(a) && !isTok(a, ','));
        const style = args.slice(cv.fn === 'counter' ? 1 : 2).find((a) => a.t === 'ident');
        if (style && !NUMBER_STYLES.has(String(style.v).toLowerCase())) return `counter style ${style.v} writes letters`;
      }
      const r = writesText(prop, cv.args);
      if (r) return r;
      continue;
    }
    if (cv.open !== undefined) { const r = writesText(prop, cv.items); if (r) return r; continue; }
    if (cv.t === 'str' && cv.v !== '') return `writes text (${JSON.stringify(cv.v.slice(0, 40))}): only "" here`;
    if (cv.t === 'ident' && (prop === 'list-style' || prop === 'list-style-type') && !LIST_WORDS.has(String(cv.v).toLowerCase())) return `list style ${cv.v} writes letters`;
  }
  return null;
}

// A string that looks like an address, anywhere in a style sheet: refused, so
// nothing can hand one to a function that loads it.
const URLISH = /:\/\/|^\s*\/\/|^\s*(javascript|vbscript|data):/i;

class CssBuilder {
  constructor(source, options) {
    this.src = source;
    this.files = options.files ?? [];
    this.assetUrl = options.assetUrl ?? ((p) => p);
    this.removed = [];
    this.errors = [];
    this.rules = 0;
    this.declarations = 0;
  }

  line(cv) {
    const at = cv?.tok?.s ?? cv?.s;
    return at == null ? undefined : this.src.slice(0, at).split('\n').length;
  }

  // The URL check, for url() and the URL strings in image-set() and friends.
  // Returns the URL to write, or null.
  url(value, { font = false } = {}) {
    const v = value.trim();
    if (/^#[A-Za-z][A-Za-z0-9_-]*$/.test(v)) return v; // a reference to an element (svg filter, mask)
    if (isDataUrl(v, { fonts: true })) return v;
    if (isBundledPath(v, this.files) && (IMAGE_EXT.test(v) || (font && FONT_EXT.test(v)) || FONT_EXT.test(v))) return this.assetUrl(v);
    return null;
  }

  // Checks a value (a list of component values) in place. Returns a reason
  // when the whole declaration (or prelude) must go, else null. URLs it keeps
  // are rewritten on the tokens (tok.out).
  value(items, inUrlFn = false) {
    for (const cv of items) {
      if (cv.fn !== undefined) {
        if (cv.tok.esc) return 'escaped function name';
        if (!FUNCTIONS.has(cv.fn)) return `${cv.fn}() not allowed`;
        if (cv.fn === 'url' || cv.fn === 'src') {
          const args = cv.args.filter((a) => !isWsCv(a));
          if (args.length !== 1 || args[0].t !== 'str') return `${cv.fn}() must hold one quoted URL`;
          const ok = this.url(args[0].v);
          if (ok === null) return `${cv.fn}(${JSON.stringify(args[0].v.slice(0, 80))}) is not a bundled file or data: image/font`;
          cv.out = `url(${quote(ok)})`;
          continue;
        }
        if (inUrlFn && (cv.fn === 'var' || cv.fn === 'env')) return `${cv.fn}() inside a function that loads URLs`;
        const nested = URL_STRING_FUNCTIONS.has(cv.fn) || inUrlFn;
        const r = this.value(cv.args, nested);
        if (r) return r;
        continue;
      }
      if (cv.open !== undefined) { const r = this.value(cv.items, inUrlFn); if (r) return r; continue; }
      switch (cv.t) {
        case 'url': {
          if (cv.esc) return 'escaped url()';
          const ok = this.url(cv.v);
          if (ok === null) return `url(${cv.v.slice(0, 80)}) is not a bundled file or data: image/font`;
          cv.out = `url(${quote(ok)})`;
          break;
        }
        case 'badurl': return 'malformed url()';
        case 'badstr': return 'unterminated string';
        case 'str':
          if (inUrlFn) {
            const ok = this.url(cv.v);
            if (ok === null) return `${JSON.stringify(cv.v.slice(0, 80))} (a URL here) is not a bundled file or data: image`;
            cv.out = quote(ok);
          } else if (URLISH.test(cv.v)) return `${JSON.stringify(cv.v.slice(0, 80))} looks like an address`;
          break;
        case 'at': return 'at-keyword in a value';
        case 'cdo': case 'cdc': return 'HTML comment markers';
        default:
          if (cv.esc) return 'escapes outside strings';
          if (cv.t === 'ident' && inUrlFn && /^(var|env)$/i.test(cv.v)) return 'variables inside a function that loads URLs';
      }
    }
    return null;
  }

  // A style block's contents: declarations and nested rules.
  block(items, depth, kind) {
    if (depth > LIMITS.cssDepth) { this.errors.push(`css: nested deeper than ${LIMITS.cssDepth}`); return ''; }
    let out = '';
    let i = 0;
    while (i < items.length && !this.errors.length) {
      const cv = items[i];
      if (isWsCv(cv) || isTok(cv, ';')) { i++; continue; }
      if (isTok(cv, 'at')) {
        let j = i + 1;
        if (kind === 'declarations' || kind === 'keyframes') {
          while (j < items.length && !isTok(items[j], ';') && !isBlock(items[j])) j++;
          this.drop('css-at-rule', `@${cv.v}`, 'not allowed here', cv);
          i = j + 1;
          continue;
        }
        while (j < items.length && !isTok(items[j], ';') && !isBlock(items[j])) j++;
        const end = items[j];
        out += this.atRule(cv, items.slice(i + 1, j), isBlock(end) ? end : null, depth, kind === 'rules' ? 'rules' : 'nested');
        i = j + 1;
        continue;
      }
      // Up to the next ';' or a {} block, whichever comes first.
      let j = i;
      while (j < items.length && !isTok(items[j], ';') && !isBlock(items[j])) j++;
      if (isBlock(items[j]) && kind !== 'declarations') {
        out += this.styleRule(items.slice(i, j), items[j], depth, kind === 'keyframes');
        i = j + 1;
        continue;
      }
      if (isBlock(items[j])) { this.drop('css-rule', 'block', 'a rule where declarations go', items[i]); i = j + 1; continue; }
      if (kind === 'rules' || kind === 'keyframes') {
        this.drop('css-rule', this.text(items.slice(i, j)).slice(0, 60), 'a declaration outside any rule', items[i]);
        i = j + 1;
        continue;
      }
      out += this.declaration(items.slice(i, j));
      i = j + 1;
    }
    return out;
  }

  declaration(items) {
    let a = 0;
    while (isWsCv(items[a])) a++;
    const name = items[a];
    if (!isTok(name, 'ident')) { this.drop('css-declaration', this.text(items).trim().slice(0, 60), 'not a declaration', items[a]); return ''; }
    if (name.esc) { this.drop('css-declaration', this.text(items).trim().slice(0, 60), 'escaped property name', name); return ''; }
    let b = a + 1;
    while (isWsCv(items[b])) b++;
    if (!isTok(items[b], ':')) { this.drop('css-declaration', name.v, 'no colon', name); return ''; }
    const prop = name.v.startsWith('--') ? name.v : name.v.toLowerCase();
    if (BLOCKED_PROPERTIES.has(prop)) { this.drop('css-declaration', prop, 'not allowed', name); return ''; }
    const value = items.slice(b + 1);
    const reason = this.value(value) ?? (TEXT_PROPERTIES.has(prop) ? writesText(prop, value) : null);
    if (reason) { this.drop('css-declaration', `${prop}: ${this.text(value).trim().slice(0, 80)}`, reason, name); return ''; }
    if (++this.declarations > LIMITS.cssDeclarations) { this.errors.push(`css: more than ${LIMITS.cssDeclarations} declarations`); return ''; }
    const text = this.text(value).trim();
    return `${prop}:${text};`;
  }

  styleRule(prelude, block, depth, keyframe) {
    const selector = this.text(prelude).trim();
    if (++this.rules > LIMITS.cssRules) { this.errors.push(`css: more than ${LIMITS.cssRules} rules`); return ''; }
    if (!selector) { this.drop('css-rule', '{}', 'no selector', block); return ''; }
    if (selector.length > LIMITS.selectorLength) { this.drop('css-rule', selector.slice(0, 60), 'selector too long', block); return ''; }
    const reason = this.value(prelude);
    if (reason) { this.drop('css-rule', selector.slice(0, 80), reason, prelude[0]); return ''; }
    if (keyframe && !/^(from|to|\d+(\.\d+)?%)(\s*,\s*(from|to|\d+(\.\d+)?%))*$/i.test(selector)) { this.drop('css-rule', selector.slice(0, 60), 'not a keyframe selector', block); return ''; }
    const body = this.block(block.items, depth + 1, keyframe ? 'declarations' : 'style');
    return `${selector}{${body}}`;
  }

  atRule(at, prelude, block, depth, where) {
    const name = at.v.toLowerCase();
    const label = `@${at.v}`;
    if (at.esc) { this.drop('css-at-rule', label, 'escaped at-rule name', at); return ''; }
    if (++this.rules > LIMITS.cssRules) { this.errors.push(`css: more than ${LIMITS.cssRules} rules`); return ''; }
    if (name === 'charset') return '';
    const kind = AT_RULES[name];
    if (!kind) { this.drop('css-at-rule', `${label} ${this.text(prelude).trim().slice(0, 60)}`.trim(), name === 'import' ? 'no @import, ever' : 'not allowed', at); return ''; }
    const reason = this.value(prelude);
    if (reason) { this.drop('css-at-rule', label, reason, at); return ''; }
    const preludeText = this.text(prelude).trim();
    const head = `@${name}${preludeText ? ` ${preludeText}` : ''}`;
    if (!block) {
      if (name === 'layer') return `${head};`;
      this.drop('css-at-rule', label, 'needs a block', at);
      return '';
    }
    if (kind === 'declarations') {
      const body = this.block(block.items, depth + 1, 'declarations');
      if (name === 'font-face' && !/(^|;)src:/.test(body)) { this.drop('css-at-rule', label, 'no usable src left', at); return ''; }
      return `${head}{${body}}`;
    }
    if (kind === 'keyframes') return `${head}{${this.block(block.items, depth + 1, 'keyframes')}}`;
    return `${head}{${this.block(block.items, depth + 1, where === 'nested' ? 'style' : 'rules')}}`;
  }

  drop(kind, name, reason, cv) { report(this.removed, kind, name, reason, this.line(cv)); }

  // Writes component values back out. Tokens keep their source text (they
  // hold no escapes: anything escaped outside a string was refused), strings
  // are re-quoted, kept URLs rewritten, and where a comment separated two
  // tokens an empty comment keeps them apart.
  text(items) {
    let out = '';
    let prevEnd = -1;
    const emit = (cv) => {
      const start = cv.tok ? cv.tok.s : cv.s;
      if (prevEnd >= 0 && start !== prevEnd && cv.t !== 'ws' && !out.endsWith(' ') && !out.endsWith('\n')) out += '/**/';
      if (cv.fn !== undefined) {
        if (cv.out) { out += cv.out; prevEnd = cv.end ? cv.end.e : -1; return; }
        out += `${cv.fn}(`;
        prevEnd = cv.tok.e;
        for (const a of cv.args) emit(a);
        out += ')';
        prevEnd = cv.end ? cv.end.e : -1;
        return;
      }
      if (cv.open !== undefined) {
        out += cv.open;
        prevEnd = cv.tok.e;
        for (const a of cv.items) emit(a);
        out += CLOSE[cv.open];
        prevEnd = cv.end ? cv.end.e : -1;
        return;
      }
      if (cv.out) out += cv.out;
      else if (cv.t === 'str') out += quote(cv.v);
      else if (cv.t === 'ws') out += ' ';
      else out += this.src.slice(cv.s, cv.e);
      prevEnd = cv.e;
    };
    for (const cv of items) emit(cv);
    return out;
  }
}

const quote = (v) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, '\\a ')}"`;

/**
 * Sanitizes a style sheet.
 * @param {string} css
 * @param {{ files?: string[], assetUrl?: (path: string) => string }} [options]
 * @returns {{ css: string, removed: any[], errors: string[], stats: { rules: number, declarations: number } }}
 */
export function sanitizeCss(css, options = {}) {
  const fail = (msg) => ({ css: '', removed: [], errors: [msg], stats: { rules: 0, declarations: 0 } });
  if (typeof css !== 'string') return fail('css: not text');
  if (css.length > LIMITS.cssBytes) return fail(`css: larger than ${LIMITS.cssBytes} bytes`);
  if (css.includes('\u0000')) return fail('css: NUL character');
  const source = css.replace(/\r\n?|\f/g, '\n');
  const b = new CssBuilder(source, options);
  const out = b.block(components(tokenizeCss(source)), 0, 'rules');
  return { css: b.errors.length ? '' : out, removed: b.removed, errors: b.errors, stats: { rules: b.rules, declarations: b.declarations } };
}

// A `style` attribute: a list of declarations, same rules.
export function sanitizeDeclarations(text, options = {}) {
  const source = String(text).replace(/\r\n?|\f/g, '\n');
  if (source.length > LIMITS.attrValue || source.includes('\u0000')) return { css: '', removed: [{ kind: 'css-declaration', name: 'style', reason: 'too long or NUL' }] };
  const b = new CssBuilder(source, options);
  const out = b.block(components(tokenizeCss(source)), 0, 'declarations');
  return { css: b.errors.length ? '' : out, removed: b.removed };
}

// A value Margin's runtime puts in a CSS variable for `m-style:--x`. It
// comes from the view model (tab titles, colors, theme settings), so it may
// hold nothing that loads or escapes: no url(), no strings, no escapes, no
// functions but colors and math, no blocks or semicolons, no !important.
const VALUE_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'calc', 'min', 'max', 'clamp', 'var']);
export function checkCssValue(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string' || value.length > LIMITS.boundCssValue) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return false;
  for (const t of tokenizeCss(value)) {
    if (t.esc) return false;
    switch (t.t) {
      case 'ident': case 'num': case 'pct': case 'dim': case 'hash': case 'ws': case ',': case ')': case '(': break;
      case 'func': if (!VALUE_FUNCTIONS.has(String(t.v).toLowerCase())) return false; break;
      case 'delim': if (!['+', '-', '*', '/', '.', '%'].includes(t.v)) return false; break;
      default: return false;
    }
  }
  return true;
}
