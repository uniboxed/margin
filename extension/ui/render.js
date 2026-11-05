// The theme renderer (PLAN.md §3): Margin's own code, the only code a theme
// gets. It takes a sanitized template (DOM, built here from the sanitizer's
// tree with DOM APIs) and a view model, and renders into a shadow root or a
// document. Updates are keyed and minimal: a list row is keyed by its item's
// id, a row whose item is the same object is skipped, and only text and
// attributes whose value changed are written. No eval, no Function, no
// innerHTML: theme strings only ever reach the DOM as text, attribute values
// the sanitizer allowed, and CSS through a constructed style sheet.
//
// The template language:
//   {{a.b}}                 text, and allowed attributes (aria-*, data-*, title, alt, ...)
//   <m-for each as [key]>   a keyed list (key: the item field, `id` by default)
//   <m-if test> … <m-else>  test is a path, `!path` negates
//   m-attr:name, m-class:name, m-style:--var
//   m-action + m-arg        a click runs one of Margin's actions (actions.js)
//   m-icon                  an <img>'s src from a data: image in the view model
//   <m-page>                the page's place, reported as insets and a radius
// Theme packages are loaded (sanitized, fonts made, sheets built) by
// ui/theme-loader.js, and driven by ui/runtime.js.
import { checkCssValue, checkIconUrl, parseInterpolation } from './sanitize.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Margin's own rules, under the theme's. The page slot never paints and
// never takes clicks: the browser's page is there.
const BASE_CSS = `
m-page{display:block;box-sizing:border-box;background:none!important;pointer-events:none!important}
m-window-controls,m-drag-region,m-palette,m-notice,m-menu{display:block}
template{display:none!important}
`;

// ---------------------------------------------------------------------------
// From the sanitizer's tree to DOM.

/**
 * Builds the sanitized tree as DOM, in an inert document (nothing in it
 * loads or runs). The renderer compiles it; it is never shown itself.
 * @param {any} tree the `tree` from sanitizeTemplate or sanitizeTheme
 * @param {Document} [doc]
 * @returns {DocumentFragment}
 */
export function buildTemplate(tree, doc) {
  const inert = doc ?? document.implementation.createHTMLDocument('');
  const frag = inert.createDocumentFragment();
  const add = (parent, node) => {
    if (node.type === 'text') { parent.appendChild(inert.createTextNode(node.value)); return; }
    const el = node.ns === 'svg' ? inert.createElementNS(SVG_NS, node.name) : inert.createElement(node.name);
    for (const [name, value] of node.attrs) el.setAttribute(name, value);
    for (const child of node.children) add(el, child);
    parent.appendChild(el);
  };
  for (const node of tree.children) add(frag, node);
  return frag;
}

// ---------------------------------------------------------------------------
// Paths and scopes.

const HOLE = /^\s*\{\{([^{}]*)\}\}\s*$/;
const splitPath = (text) => text.trim().split('.');

// Text with holes, as parts: strings and paths (arrays), or null when it
// has none (the sanitizer's own parser, so both agree on what a hole is).
function interpolation(text) {
  const r = parseInterpolation(text);
  return r.bound ? r.parts.map((p) => (typeof p === 'string' ? p : p.path)) : null;
}

const own = Object.prototype.hasOwnProperty;

// A scope is { name, value, parent }; the root's parent is null and its
// value is the view model.
function lookup(scope, path) {
  const head = path[0];
  let s = scope;
  let v;
  while (s.parent && s.name !== head) s = s.parent;
  if (s.parent) v = s.value;
  else { const vm = s.value; v = vm != null && own.call(vm, head) ? vm[head] : undefined; }
  for (let i = 1; i < path.length; i++) {
    if (v == null || typeof v !== 'object') return undefined;
    const seg = path[i];
    v = own.call(v, seg) ? v[seg] : undefined;
  }
  return v;
}

const asText = (v) => (v == null || v === false ? '' : typeof v === 'object' ? '' : String(v));
const joinParts = (parts, scope) => {
  if (parts.length === 1 && typeof parts[0] !== 'string') return asText(lookup(scope, parts[0]));
  let out = '';
  for (const p of parts) out += typeof p === 'string' ? p : asText(lookup(scope, p));
  return out;
};

// ---------------------------------------------------------------------------
// Compiling: a block is a static skeleton plus a list of bindings, each
// found by its child-index path in the skeleton.

/**
 * @typedef {{ frag: DocumentFragment, bindings: any[], heads: Set<string>, single: boolean }} Plan
 */

function compileBlock(nodes, ctx, locals) {
  const frag = ctx.doc.createDocumentFragment();
  const bindings = [];
  const heads = new Set();
  const usePath = (path) => { heads.add(path[0]); };
  const visit = (parent, list, at) => {
    const kept = significant(list);
    for (const node of kept) {
      const path = [...at, parent.childNodes.length];
      if (node.nodeType === 3) {
        const parts = interpolation(node.data);
        if (parts) {
          parent.appendChild(ctx.doc.createTextNode(''));
          for (const p of parts) if (typeof p !== 'string') usePath(p);
          bindings.push({ kind: 'text', path, parts });
        } else parent.appendChild(ctx.doc.createTextNode(node.data));
        continue;
      }
      if (node.nodeType !== 1) continue;
      const el = /** @type {Element} */ (node);
      const name = el.localName;
      if (el.namespaceURI !== SVG_NS && name === 'm-for') {
        const each = splitPath(el.getAttribute('each').replace(HOLE, '$1'));
        const as = el.getAttribute('as');
        const key = el.getAttribute('key') || 'id';
        usePath(each);
        const body = compileBlock([...el.childNodes], ctx, new Set([...locals, as]));
        for (const h of body.heads) if (h !== as) heads.add(h);
        // A row is pure when it reads nothing but its own item (and what's
        // inside it): then the same item object means nothing to do.
        const pure = [...body.heads].every((h) => h === as);
        parent.appendChild(ctx.doc.createComment(''));
        bindings.push({ kind: 'for', path, each, as, key, body, pure });
        continue;
      }
      if (el.namespaceURI !== SVG_NS && name === 'm-if') {
        let test = el.getAttribute('test');
        const neg = test.startsWith('!');
        test = splitPath(test.replace(/^!/, ''));
        usePath(test);
        const children = [...el.childNodes];
        const elseAt = children.findIndex((c) => c.nodeType === 1 && /** @type {Element} */ (c).localName === 'm-else');
        const yes = compileBlock(elseAt < 0 ? children : children.slice(0, elseAt), ctx, locals);
        const no = elseAt < 0 ? null : compileBlock([...children[elseAt].childNodes], ctx, locals);
        for (const h of yes.heads) heads.add(h);
        if (no) for (const h of no.heads) heads.add(h);
        parent.appendChild(ctx.doc.createComment(''));
        bindings.push({ kind: 'if', path, test, neg, yes, no });
        continue;
      }
      if (name === 'template') continue; // theme parts: not rendered (yet)
      const copy = el.namespaceURI === SVG_NS ? ctx.doc.createElementNS(SVG_NS, el.localName) : ctx.doc.createElement(name);
      const own = [];
      for (const attr of [...el.attributes]) {
        const a = attr.name;
        const value = attr.value;
        if (a.startsWith('m-attr:')) { const p = splitPath(value.replace(HOLE, '$1')); usePath(p); own.push({ kind: 'attr', name: a.slice(7), p }); continue; }
        if (a.startsWith('m-class:')) { const p = splitPath(value.replace(HOLE, '$1')); usePath(p); own.push({ kind: 'class', name: a.slice(8), p }); continue; }
        if (a.startsWith('m-style:')) { const p = splitPath(value.replace(HOLE, '$1')); usePath(p); own.push({ kind: 'style', name: a.slice(8), p }); continue; }
        if (a === 'm-icon') { const p = splitPath(value.replace(HOLE, '$1')); usePath(p); own.push({ kind: 'icon', p }); continue; }
        if (a === 'm-action') {
          const arg = el.getAttribute('m-arg');
          const p = arg != null && HOLE.test(arg) ? splitPath(arg.replace(HOLE, '$1')) : null;
          if (p) usePath(p);
          own.push({ kind: 'action', name: value, p, literal: p ? null : arg });
          continue;
        }
        if (a === 'm-arg') continue;
        if (a === 'm-input') { own.push({ kind: 'input', name: value }); continue; }
        if (a.startsWith('m-')) { ctx.behaviors.push({ name: a, value }); continue; }
        const parts = interpolation(value);
        if (parts) { for (const p of parts) if (typeof p !== 'string') usePath(p); own.push({ kind: 'interp', name: a, parts }); continue; }
        copy.setAttribute(a, value);
      }
      if (name === 'm-page') own.push({ kind: 'page' });
      if (own.length) bindings.push({ kind: 'element', path, own });
      parent.appendChild(copy);
      if (name !== 'm-page') visit(copy, [...el.childNodes], path);
    }
  };
  visit(frag, nodes, []);
  // A row's first node must stay put while content comes and goes before a
  // list's or a condition's anchor: start such a block with an empty marker.
  if (!frag.firstChild || (frag.firstChild.nodeType === 8)) {
    frag.insertBefore(ctx.doc.createComment(''), frag.firstChild);
    for (const b of bindings) b.path[0]++;
  }
  return { frag, bindings, heads, single: frag.childNodes.length === 1 };
}

// Whitespace between elements, as authors indent: dropped when it holds a
// newline, else kept as one space (it can matter between inline elements).
function significant(list) {
  const out = [];
  for (const n of list) {
    if (n.nodeType === 3) {
      const t = /** @type {Text} */ (n).data;
      if (!/\S/.test(t)) { if (!t.includes('\n') && t.length) out.push(n.ownerDocument.createTextNode(' ')); continue; }
      out.push(n);
    } else if (n.nodeType === 1) out.push(n);
  }
  return out;
}

const nodeAt = (root, path) => {
  let n = root;
  for (const i of path) n = n.childNodes[i];
  return n;
};

// ---------------------------------------------------------------------------
// Instances: a block made real, its bindings live.

class Block {
  /** @param {Plan} plan @param {View} view @param {any} scope */
  constructor(plan, view, scope) {
    const frag = /** @type {DocumentFragment} */ (plan.frag.cloneNode(true));
    this.doc = view.doc;
    this.scope = scope;
    this.first = frag.firstChild;
    this.last = frag.lastChild;
    this.single = plan.single;
    const targets = plan.bindings.map((b) => nodeAt(frag, b.path));
    this.parts = plan.bindings.map((b, i) => makeBinding(b, targets[i], view, scope));
    this.frag = frag; // holds the nodes until the block is inserted
  }
  update() { for (const p of this.parts) p.update(this.scope); }
  insertBefore(parent, ref) {
    if (this.frag) { parent.insertBefore(this.frag, ref); this.frag = null; return; }
    if (this.single) { parent.insertBefore(this.first, ref); return; }
    let n = this.first;
    const end = this.last;
    for (;;) { const next = n.nextSibling; parent.insertBefore(n, ref); if (n === end) break; n = next; }
  }
  // Out of the DOM. A row of several nodes keeps them, in order, in a
  // fragment until it goes back in.
  remove() {
    if (this.frag) return;
    if (this.single) { /** @type {ChildNode} */ (this.first).remove(); return; }
    const frag = this.doc.createDocumentFragment();
    let n = this.first;
    const end = this.last;
    for (;;) { const next = n.nextSibling; frag.appendChild(n); if (n === end) break; n = next; }
    this.frag = frag;
  }
}

function makeBinding(b, node, view, scope) {
  switch (b.kind) {
    case 'text': return new TextBinding(node, b.parts);
    case 'element': return new ElementBinding(node, b.own, view, scope);
    case 'for': return new ForBinding(node, b, view);
    case 'if': return new IfBinding(node, b, view);
  }
  throw new Error(`renderer: unknown binding ${b.kind}`);
}

class TextBinding {
  constructor(node, parts) { this.node = node; this.parts = parts; this.last = ''; }
  update(scope) {
    const v = joinParts(this.parts, scope);
    if (v !== this.last) { this.last = v; this.node.data = v; }
  }
}

const isAria = (name) => name.startsWith('aria-');
const BOOLEAN = new Set(['hidden', 'disabled']);

class ElementBinding {
  constructor(el, own, view, scope) {
    this.el = el;
    this.view = view;
    this.own = own;
    this.last = own.map(() => undefined);
    for (const o of own) {
      if (o.kind === 'action') view.actions.set(el, { name: o.name, p: o.p, literal: o.literal, scope });
      if (o.kind === 'input') view.inputs.set(el, o.name);
      if (o.kind === 'page') view.pageEl = el;
    }
  }
  update(scope) {
    const el = this.el;
    const own = this.own;
    for (let i = 0; i < own.length; i++) {
      const o = own[i];
      switch (o.kind) {
        case 'interp': {
          const v = joinParts(o.parts, scope);
          if (v !== this.last[i]) { this.last[i] = v; el.setAttribute(o.name, v); }
          break;
        }
        case 'attr': {
          let v = lookup(scope, o.p);
          if (BOOLEAN.has(o.name)) v = v ? '' : null;
          else if (isAria(o.name)) v = v == null || typeof v === 'object' ? null : String(v);
          else v = v == null || v === false || typeof v === 'object' ? null : v === true ? '' : String(v);
          if (v !== this.last[i]) { this.last[i] = v; if (v === null) el.removeAttribute(o.name); else el.setAttribute(o.name, v); }
          break;
        }
        case 'class': {
          const v = Boolean(lookup(scope, o.p));
          if (v !== this.last[i]) { this.last[i] = v; el.classList.toggle(o.name, v); }
          break;
        }
        case 'style': {
          let v = lookup(scope, o.p);
          if (v != null && v !== '' && !checkCssValue(v)) { this.view?.warn?.(`m-style:${o.name}: value refused`); v = null; }
          v = v == null || v === '' ? null : String(v);
          if (v !== this.last[i]) { this.last[i] = v; if (v === null) el.style.removeProperty(o.name); else el.style.setProperty(o.name, v); }
          break;
        }
        case 'icon': {
          let v = lookup(scope, o.p);
          v = checkIconUrl(v) ? v : null;
          if (v !== this.last[i]) { this.last[i] = v; if (v === null) el.removeAttribute('src'); else el.setAttribute('src', v); }
          break;
        }
        default: break;
      }
    }
  }
}

class IfBinding {
  constructor(anchor, b, view) {
    this.anchor = anchor;
    this.b = b;
    this.view = view;
    this.state = null; // true, false, or null before the first update
    this.blocks = [null, null]; // [yes, no], kept once made
  }
  update(scope) {
    const v = Boolean(lookup(scope, this.b.test)) !== this.b.neg;
    const idx = v ? 0 : 1;
    if (v === this.state) { const blk = this.blocks[idx]; if (blk) blk.update(); return; }
    if (this.state !== null) { const old = this.blocks[this.state ? 0 : 1]; if (old) old.remove(); }
    this.state = v;
    const plan = v ? this.b.yes : this.b.no;
    if (!plan) return;
    let blk = this.blocks[idx];
    if (!blk) { blk = new Block(plan, this.view, scope); this.blocks[idx] = blk; }
    else blk.scope = scope;
    blk.update();
    blk.insertBefore(this.anchor.parentNode, this.anchor);
  }
}

// Longest increasing subsequence of `seq` (entries < 0 are skipped); returns
// the indexes into seq that are in it.
function lis(seq) {
  const tails = [];
  const prev = new Array(seq.length);
  for (let i = 0; i < seq.length; i++) {
    const v = seq[i];
    if (v < 0) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]] < v) lo = mid + 1; else hi = mid; }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const out = new Set();
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) { out.add(k); k = prev[k]; }
  return out;
}

class ForBinding {
  constructor(anchor, b, view) {
    this.anchor = anchor;
    this.b = b;
    this.view = view;
    this.rows = []; // in DOM order
    this.byKey = new Map();
    this.pool = new Map(); // rows that left, kept for when their key comes back
    this.items = null;
  }
  key(item, i) {
    const k = item != null && typeof item === 'object' && own.call(item, this.b.key) ? item[this.b.key] : undefined;
    return typeof k === 'string' || typeof k === 'number' ? k : `\u0000${i}`;
  }
  update(scope) {
    const list = lookup(scope, this.b.each);
    const items = Array.isArray(list) ? list : [];
    const { pure, as } = this.b;
    if (pure && items === this.items) return;
    this.items = items;
    const view = this.view;
    const old = this.rows;
    const next = new Array(items.length);
    const seen = new Map();
    let fresh = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let k = this.key(item, i);
      if (seen.has(k)) { k = `${k}\u0000${i}`; view.warn?.(`m-for ${this.b.each.join('.')}: repeated key`); }
      seen.set(k, i);
      let row = this.byKey.get(k);
      if (!row) {
        row = this.pool.get(k);
        if (row) { this.pool.delete(k); row.at = -1; } else {
          const rowScope = { name: as, value: item, parent: scope };
          row = new Block(this.b.body, view, rowScope);
          row.key = k;
          row.item = undefined;
          row.at = -1;
        }
        fresh++;
      }
      row.scope.parent = scope;
      if (!pure || row.item !== item) { row.item = item; row.scope.value = item; row.update(); }
      next[i] = row;
    }
    // Rows that left: out of the DOM, into the pool.
    if (old.length + fresh !== items.length || fresh) {
      for (const row of old) {
        if (seen.has(row.key) && next[seen.get(row.key)] === row) continue;
        row.remove();
        this.byKey.delete(row.key);
        this.pool.set(row.key, row);
      }
      const cap = view.options.rowPool ?? Math.max(256, items.length);
      while (this.pool.size > cap) { const first = this.pool.keys().next().value; this.pool.delete(first); }
    }
    // Order: rows on the longest increasing run of old positions stay;
    // the rest (and new rows) go in front of their successor.
    let same = next.length === old.length;
    if (same) for (let i = 0; i < next.length; i++) if (next[i] !== old[i]) { same = false; break; }
    if (!same) {
      for (let i = 0; i < old.length; i++) old[i].at = i;
      const seq = next.map((r) => (this.byKey.get(r.key) === r ? r.at : -1));
      const stay = lis(seq);
      const parent = this.anchor.parentNode;
      let ref = this.anchor;
      for (let i = next.length - 1; i >= 0; i--) {
        const row = next[i];
        if (!stay.has(i)) row.insertBefore(parent, ref);
        ref = row.first;
      }
      this.byKey.clear();
      for (const row of next) this.byKey.set(row.key, row);
    }
    this.rows = next;
  }
}

// ---------------------------------------------------------------------------
// The view.

/**
 * @typedef {{
 *   onAction?: (name: string, arg: any, info: { element: Element }) => void,
 *   onInput?: (name: string, value: string) => void,
 *   onLayout?: (layout: any) => void,
 *   onWarn?: (message: string) => void,
 *   sheets?: CSSStyleSheet[],
 *   trustedOnly?: boolean,
 *   rowPool?: number,
 * }} ViewOptions
 */

export class View {
  /**
   * @param {ShadowRoot | Document} container
   * @param {DocumentFragment} template
   * @param {ViewOptions} [options]
   */
  constructor(container, template, options = {}) {
    this.container = container;
    this.doc = container.nodeType === 9 ? /** @type {Document} */ (container) : container.ownerDocument;
    this.options = options;
    this.actions = new WeakMap();
    this.inputs = new WeakMap();
    this.pageEl = null;
    this.behaviors = [];
    this.warn = options.onWarn ?? null;
    const ctx = { doc: this.doc, behaviors: this.behaviors };
    this.plan = compileBlock([...template.childNodes], ctx, new Set());
    this.rootScope = { name: null, value: {}, parent: null };
    this.block = null;
    this.layout = null;
    this.frame = 0;
    this.listeners = [];
    const sheets = [baseSheet(this.doc), ...(options.sheets ?? [])];
    const target = /** @type {any} */ (container);
    target.adoptedStyleSheets = [...target.adoptedStyleSheets.filter((s) => !sheets.includes(s)), ...sheets];
    this.sheets = sheets;
  }

  /** Renders the view model: the first call builds, later ones update. */
  update(vm) {
    this.rootScope.value = vm ?? {};
    if (!this.block) {
      this.block = new Block(this.plan, this, this.rootScope);
      this.block.update();
      const parent = this.container.nodeType === 9 ? /** @type {Document} */ (this.container).body : this.container;
      this.block.insertBefore(parent, null);
      this.listen(parent);
    } else this.block.update();
    if (this.options.onLayout) this.scheduleLayout();
  }

  listen(parent) {
    const click = (e) => {
      let n = /** @type {any} */ (e.target);
      const stop = this.container;
      let anchor = null;
      while (n && n !== stop && n !== this.doc) {
        if (!anchor && n.localName === 'a') anchor = n;
        const action = this.actions.get(n);
        if (action) {
          e.preventDefault();
          if (this.options.trustedOnly !== false && !e.isTrusted) return;
          const arg = action.p ? lookup(action.scope, action.p) : (action.literal ?? undefined);
          this.options.onAction?.(action.name, arg, { element: n });
          return;
        }
        n = n.parentNode;
      }
      if (anchor) e.preventDefault(); // links in a theme never navigate
    };
    const input = (e) => {
      const name = this.inputs.get(e.target);
      if (name) this.options.onInput?.(name, e.target.value);
    };
    parent.addEventListener('click', click);
    parent.addEventListener('input', input);
    this.listeners.push(() => { parent.removeEventListener('click', click); parent.removeEventListener('input', input); });
    if (typeof ResizeObserver === 'function' && this.options.onLayout) {
      const ro = new ResizeObserver(() => this.scheduleLayout());
      const host = this.container.nodeType === 9 ? this.doc.documentElement : /** @type {ShadowRoot} */ (this.container).host;
      ro.observe(host);
      if (this.pageEl) ro.observe(this.pageEl);
      this.listeners.push(() => ro.disconnect());
    }
  }

  scheduleLayout() {
    if (this.frame) return;
    const win = this.doc.defaultView;
    this.frame = win.requestAnimationFrame(() => {
      this.frame = 0;
      const layout = this.measure();
      if (layout && !sameLayout(layout, this.layout)) { this.layout = layout; this.options.onLayout?.(layout); }
    });
  }

  /**
   * Where the page goes: `<m-page>`'s content box (inside its border and
   * padding) as insets from the container's edges, and its inner corner
   * radius. `outer` is its border box, for themes that draw over the page.
   */
  measure() {
    const el = this.pageEl;
    if (!el || !el.isConnected) return null;
    const win = this.doc.defaultView;
    const c = this.container.nodeType === 9
      ? { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight, width: win.innerWidth, height: win.innerHeight }
      : /** @type {ShadowRoot} */ (this.container).host.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const cs = win.getComputedStyle(el);
    const px = (v) => parseFloat(v) || 0;
    const bw = { left: px(cs.borderLeftWidth) + px(cs.paddingLeft), top: px(cs.borderTopWidth) + px(cs.paddingTop), right: px(cs.borderRightWidth) + px(cs.paddingRight), bottom: px(cs.borderBottomWidth) + px(cs.paddingBottom) };
    const outer = { left: r.left - c.left, top: r.top - c.top, right: c.right - r.right, bottom: c.bottom - r.bottom };
    const round = (v) => Math.round(v * 100) / 100;
    const corner = (v) => px(String(v).split(' ')[0]);
    const radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(corner);
    const border = Math.max(px(cs.borderTopWidth), px(cs.borderLeftWidth));
    return {
      insets: { left: round(outer.left + bw.left), top: round(outer.top + bw.top), right: round(outer.right + bw.right), bottom: round(outer.bottom + bw.bottom) },
      radius: round(Math.max(0, radii[0] - border)),
      radii: radii.map((v) => round(Math.max(0, v - border))),
      outer: { left: round(outer.left), top: round(outer.top), right: round(outer.right), bottom: round(outer.bottom), radius: round(radii[0]) },
      container: { width: round(c.width), height: round(c.height) },
    };
  }

  destroy() {
    for (const off of this.listeners) off();
    this.listeners = [];
    if (this.block) this.block.remove();
    this.block = null;
    const target = /** @type {any} */ (this.container);
    target.adoptedStyleSheets = target.adoptedStyleSheets.filter((s) => !this.sheets.includes(s));
  }
}

// A layout is new when the page's insets or radius changed, or the
// container's size did (the window resized: the page's box with it).
const sameLayout = (a, b) => b && ['left', 'top', 'right', 'bottom'].every((k) => a.insets[k] === b.insets[k]) && a.radius === b.radius
  && a.container.width === b.container.width && a.container.height === b.container.height;

const bases = new WeakMap();
function baseSheet(doc) {
  let sheet = bases.get(doc);
  if (!sheet) {
    sheet = new doc.defaultView.CSSStyleSheet();
    sheet.replaceSync(BASE_CSS);
    bases.set(doc, sheet);
  }
  return sheet;
}

/**
 * Renders a template with a view model into a container, and returns the
 * view for later updates.
 * @param {ShadowRoot | Document} container
 * @param {DocumentFragment} template
 * @param {any} vm
 * @param {ViewOptions} [options]
 */
export function render(container, template, vm, options) {
  const view = new View(container, template, options);
  view.update(vm);
  return view;
}
