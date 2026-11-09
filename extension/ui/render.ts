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
//   m-action + m-arg        a click runs one of Margin's actions (actions.ts)
//   m-icon                  an <img>'s src from a data: image in the view model
//   <m-page>                the page's place, reported as insets and a radius
//   m-drag, m-drop, m-peek, m-resize, m-rename, m-scroll, m-swipe, m-input
//                           behaviors (ui/behaviors/): kept on the element, which
//                           the view knows with its scope (behaviorOf, subjectOf)
//   <template m-part>       a named part, shown in its slot (<m-menu>: `menu`,
//                           <m-editor>: `space-editor`, <m-palette>: `palette`,
//                           <m-notice>: `notice`, <m-launcher>: `launcher`,
//                           <m-prompt>: `prompt`, <m-cloud-tabs>: `cloud-tabs`,
//                           <m-switch-cover>: `switch-cover`, which has
//                           Margin's own default when a theme has none)
//                           while the view model says so;
//                           in Margin's menus, notices and prompts only bound
//                           text shows (ui/sanitize.ts GUARDED_PARTS)
// Theme packages are loaded (sanitized, fonts made, sheets built) by
// ui/theme-loader.ts, and driven by ui/runtime.ts.
import { GUARDED_PARTS, GUARDED_SLOTS, TEXT_ATTRS, checkCssValue, checkIconUrl, guardText, parseInterpolation } from './sanitize.ts';
import type { CleanElement, CleanNode } from './sanitize.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Margin's own rules, under the theme's. The page slot never paints and
// never takes clicks: the browser's page is there.
const BASE_CSS = `
m-page{display:block;box-sizing:border-box;background:none!important;pointer-events:none!important}
m-window-controls,m-drag-region,m-palette,m-notice,m-menu,m-editor,m-launcher,m-prompt,m-settings,m-cloud-tabs,m-switch-cover{display:block}
m-menu{position:fixed;left:var(--m-menu-x,0px);top:var(--m-menu-y,0px);z-index:2147483600;outline:none}
m-menu:empty,m-editor:empty,m-palette:empty,m-notice:empty,m-launcher:empty,m-prompt:empty,m-settings:empty,m-cloud-tabs:empty,m-switch-cover:empty{display:none}
template{display:none!important}
[m-passthrough]{pointer-events:none!important}
:where([m-passthrough])>:where(:not(m-page)){pointer-events:auto}
[m-away]{visibility:hidden!important}
[m-away] :is(m-notice,m-prompt){visibility:visible!important}
.m-drag-ghost{position:fixed!important;margin:0!important;pointer-events:none!important;z-index:2147483601!important;box-sizing:border-box}
[contenteditable].m-renaming{cursor:text;user-select:text;-webkit-user-select:text}
.m-cover{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;border-radius:inherit;background:var(--m-cover-ground,Canvas);color:var(--m-cover-text,CanvasText);pointer-events:auto}
.m-cover-card{display:flex;flex-direction:column;align-items:center;gap:6px;padding:20px 28px;border-radius:12px;background:var(--m-cover-card,transparent);font:500 15px/1.35 -apple-system,system-ui,sans-serif;text-align:center;max-width:80%}
.m-cover-mark{font-size:28px;line-height:1}
.m-cover-space{font-weight:400;font-size:13px;opacity:.7}
`;

// `m-passthrough` and `m-away` are the host's, on the theme's root (a theme
// can't write m- attributes of its own): the pointer over the page's slot
// goes to the page under it, past the root's own background (the in-page
// host sets it while the pointer is there; what the theme draws over the
// page still takes it), and Margin out of the way (Chrome outside full
// screen, a copy that stood back) shows only its notices and prompts.
//
// Margin's slots, and what each shows: a theme's part (`<template m-part>`),
// else what the theme put inside the slot, while `test` holds.
const SLOTS: Record<string, { part: string, test: string[] }> = {
  'm-menu': { part: 'menu', test: ['menu'] },
  'm-editor': { part: 'space-editor', test: ['editor'] },
  'm-palette': { part: 'palette', test: ['palette', 'open'] },
  'm-notice': { part: 'notice', test: ['notice'] },
  'm-launcher': { part: 'launcher', test: ['launcher'] },
  'm-prompt': { part: 'prompt', test: ['prompt'] },
  'm-settings': { part: 'settings', test: ['settingsForm'] },
  // iCloud Tabs' live folder: drawn whole by its part, so a theme can put it
  // anywhere (the sidebar now; later, perhaps, by the sidebar's toggle).
  'm-cloud-tabs': { part: 'cloud-tabs', test: ['cloudTabs'] },
  // The "switching" cover, over the page (docs/HANDOFF.md §7): with Margin's
  // own default (DEFAULT_PARTS) when the theme has no part and nothing in it.
  'm-switch-cover': { part: 'switch-cover', test: ['switchCover'] },
};
// Margin's own parts, for a theme that has none: the switching cover, a
// centred card in the theme's colours (`--m-cover-ground`, `--m-cover-text`
// and `--m-cover-card` if it sets them; else the system's). As the
// sanitizer's tree (buildTemplate), every word bound.
const tag = (name: string, attrs: [string, string][], ...children: CleanNode[]): CleanElement => ({ type: 'el', ns: 'html', name, attrs, children });
const hole = (path: string): CleanNode => ({ type: 'text', value: `{{${path}}}` });
const DEFAULT_PARTS: Record<string, { children: CleanNode[] }> = {
  'switch-cover': { children: [
    tag('div', [['class', 'm-cover'], ['role', 'status'], ['aria-label', '{{switchCover.label}}']],
      tag('div', [['class', 'm-cover-card']],
        tag('m-if', [['test', 'switchCover.profile.emoji']], tag('div', [['class', 'm-cover-mark'], ['aria-hidden', 'true']], hole('switchCover.profile.emoji'))),
        tag('div', [['class', 'm-cover-text']], hole('switchCover.text')),
        tag('m-if', [['test', 'switchCover.hasSpace']], tag('div', [['class', 'm-cover-space']], hole('switchCover.space.emoji'), { type: 'text', value: ' ' }, hole('switchCover.space.name'))))),
  ] },
};
// Margin's own words (ui/sanitize.ts GUARDED_PARTS): inside these parts and
// slots, text the theme wrote is dropped again here, whatever tree the
// template came from, and only bound labels show.
const GUARDED = new Set(GUARDED_PARTS);
const GUARDED_SLOT = new Set(GUARDED_SLOTS);
const TEXT_ATTR = new Set(TEXT_ATTRS);

// ---------------------------------------------------------------------------
// From the sanitizer's tree to DOM.

/**
 * Builds the sanitized tree as DOM, in an inert document (nothing in it
 * loads or runs). The renderer compiles it; it is never shown itself.
 * @param tree the `tree` from sanitizeTemplate or sanitizeTheme
 * */
export function buildTemplate(tree: { children: CleanNode[] }, doc?: Document): DocumentFragment {
  const inert = doc ?? document.implementation.createHTMLDocument('');
  const frag = inert.createDocumentFragment();
  const add = (parent: Node, node: CleanNode) => {
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
const splitPath = (text: string) => text.trim().split('.');

// Text with holes, as parts: strings and paths (arrays), or null when it
// has none (the sanitizer's own parser, so both agree on what a hole is).
function interpolation(text: string) {
  const r = parseInterpolation(text);
  return r.bound ? r.parts.map((p) => (typeof p === 'string' ? p : p.path)) : null;
}

const own = Object.prototype.hasOwnProperty;

// A scope is { name, value, parent }; the root's parent is null and its
// value is the view model. (Its values: plain data from ui/view-model.ts, read
// by path; a row's item is what behaviors know a row by: subjectOf.)
type Scope = { name: string | null, value: any, parent: Scope | null };
type Path = string[];
// Text with holes: its strings and paths.
type Parts = (string | Path)[];

function lookup(scope: Scope, path: Path): unknown {
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

const asText = (v: unknown) => (v == null || v === false ? '' : typeof v === 'object' ? '' : String(v));
const joinParts = (parts: Parts, scope: Scope) => {
  if (parts.length === 1 && typeof parts[0] !== 'string') return asText(lookup(scope, parts[0]));
  let out = '';
  for (const p of parts) out += typeof p === 'string' ? p : asText(lookup(scope, p));
  return out;
};

// ---------------------------------------------------------------------------
// Compiling: a block is a static skeleton plus a list of bindings, each
// found by its child-index path in the skeleton.

// An element's own bindings (ElementBinding).
type Own =
  | { kind: 'attr' | 'class' | 'style', name: string, p: Path }
  | { kind: 'icon', p: Path }
  | { kind: 'action', name: string, p: Path | null, literal: string | null }
  | { kind: 'input', name: string }
  | { kind: 'behavior', name: string, value: string }
  | { kind: 'interp', name: string, parts: Parts }
  | { kind: 'page' };
// A binding, found by its child-index path in the block's skeleton.
type BindingPlan =
  | { kind: 'text', path: number[], parts: Parts }
  | { kind: 'element', path: number[], own: Own[] }
  | { kind: 'for', path: number[], each: Path, as: string, key: string, body: Plan, pure: boolean }
  | { kind: 'if', path: number[], test: Path, neg: boolean, yes: Plan, no: Plan | null }
  | { kind: 'slot', path: number[], slot: string, part: string, test: Path, fallback: Plan | null };
type ForPlan = Extract<BindingPlan, { kind: 'for' }>;
type IfPlan = Extract<BindingPlan, { kind: 'if' }>;
type SlotPlan = Extract<BindingPlan, { kind: 'slot' }>;
export type Plan = { frag: DocumentFragment, bindings: BindingPlan[], heads: Set<string>, single: boolean };
// What compiling carries: `guard` inside Margin's own words (GUARDED).
type CompileCtx = { doc: Document, behaviors: { name: string, value: string }[], guard: boolean, warn: (message: string) => void };

function compileBlock(nodes: ChildNode[], ctx: CompileCtx, locals: Set<string>): Plan {
  const frag = ctx.doc.createDocumentFragment();
  const bindings: Plan['bindings'] = [];
  const heads = new Set<string>();
  const usePath = (path: Path) => { heads.add(path[0]); };
  const visit = (parent: Node, list: ChildNode[], at: number[]) => {
    const kept = significant(list);
    for (const node of kept) {
      const path = [...at, parent.childNodes.length];
      if (node.nodeType === 3) {
        let data = (node as Text).data;
        if (ctx.guard) {
          const g = guardText(data);
          if (g.removed) { ctx.warn?.(`static text in a guarded part, not shown: ${JSON.stringify(g.removed.slice(0, 60))}`); data = g.text; if (!data) continue; }
        }
        const parts = interpolation(data);
        if (parts) {
          parent.appendChild(ctx.doc.createTextNode(''));
          for (const p of parts) if (typeof p !== 'string') usePath(p);
          bindings.push({ kind: 'text', path, parts });
        } else parent.appendChild(ctx.doc.createTextNode(data));
        continue;
      }
      if (node.nodeType !== 1) continue;
      const el = (node as Element);
      const name = el.localName;
      if (el.namespaceURI !== SVG_NS && name === 'm-for') {
        // (`each` and `as`: the sanitizer keeps no <m-for> without them, nor an <m-if> without `test`.)
        const each = splitPath(el.getAttribute('each')!.replace(HOLE, '$1'));
        const as = el.getAttribute('as')!;
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
        const said = el.getAttribute('test')!;
        const neg = said.startsWith('!');
        const test = splitPath(said.replace(/^!/, ''));
        usePath(test);
        const children = [...el.childNodes];
        const elseAt = children.findIndex((c) => c.nodeType === 1 && (c as Element).localName === 'm-else');
        const yes = compileBlock(elseAt < 0 ? children : children.slice(0, elseAt), ctx, locals);
        const no = elseAt < 0 ? null : compileBlock([...children[elseAt].childNodes], ctx, locals);
        for (const h of yes.heads) heads.add(h);
        if (no) for (const h of no.heads) heads.add(h);
        parent.appendChild(ctx.doc.createComment(''));
        bindings.push({ kind: 'if', path, test, neg, yes, no });
        continue;
      }
      if (name === 'template') continue; // a part: compiled once (View), shown in its slot
      const copy = el.namespaceURI === SVG_NS ? ctx.doc.createElementNS(SVG_NS, el.localName) : ctx.doc.createElement(name);
      const own: Own[] = [];
      const guarded = ctx.guard || (el.namespaceURI !== SVG_NS && GUARDED_SLOT.has(name));
      for (const attr of [...el.attributes]) {
        const a = attr.name;
        let value = attr.value;
        if (guarded && TEXT_ATTR.has(a)) {
          const g = guardText(value);
          if (g.removed) { ctx.warn?.(`static ${a} in a guarded part, not shown: ${JSON.stringify(g.removed.slice(0, 60))}`); value = g.text; if (!value) continue; }
        }
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
        if (a === 'm-input') {
          own.push({ kind: 'input', name: value });
          copy.setAttribute(a, value);
          // Margin's Settings inputs: their type is Margin's to set.
          if (value === 'setting-number') copy.setAttribute('type', 'number');
          if (value === 'setting-toggle') { copy.setAttribute('type', 'checkbox'); copy.setAttribute('switch', ''); }
          if (value === 'setting-shortcut') { copy.setAttribute('type', 'text'); copy.setAttribute('readonly', ''); }
          if (value === 'setting-color') copy.setAttribute('type', 'color');
          continue;
        }
        if (a.startsWith('m-')) {
          // A behavior: kept as written (a theme's CSS can select it), and
          // known to the view with the element's scope.
          ctx.behaviors.push({ name: a, value });
          own.push({ kind: 'behavior', name: a, value });
          copy.setAttribute(a, value);
          continue;
        }
        const parts = interpolation(value);
        if (parts) { for (const p of parts) if (typeof p !== 'string') usePath(p); own.push({ kind: 'interp', name: a, parts }); continue; }
        copy.setAttribute(a, value);
      }
      if (name === 'm-page') own.push({ kind: 'page' });
      if (own.length) bindings.push({ kind: 'element', path, own });
      parent.appendChild(copy);
      const slot = el.namespaceURI !== SVG_NS ? SLOTS[name] : null;
      if (slot) {
        // Its part (or what's inside it) goes in while the test holds.
        usePath(slot.test);
        const inside = [...el.childNodes].filter((c) => c.nodeType === 1 || /\S/.test(c.nodeValue ?? ''));
        const fallback = inside.length ? compileBlock(inside, GUARDED_SLOT.has(name) ? { ...ctx, guard: true } : ctx, locals) : null;
        if (fallback) for (const h of fallback.heads) heads.add(h);
        bindings.push({ kind: 'slot', path, slot: name, part: slot.part, test: slot.test, fallback });
      } else if (name !== 'm-page') visit(copy, [...el.childNodes], path);
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
function significant(list: ChildNode[]) {
  const out: Node[] = [];
  for (const n of list) {
    if (n.nodeType === 3) {
      const t = (n as Text).data;
      // (A template's node: in a document.)
      if (!/\S/.test(t)) { if (!t.includes('\n') && t.length) out.push(n.ownerDocument!.createTextNode(' ')); continue; }
      out.push(n);
    } else if (n.nodeType === 1) out.push(n);
  }
  return out;
}

const nodeAt = (root: DocumentFragment, path: number[]) => {
  let n: Node = root;
  for (const i of path) n = n.childNodes[i];
  return n;
};

// ---------------------------------------------------------------------------
// Instances: a block made real, its bindings live.

class Block {
  // Its fields (set in its constructor and methods; declared only: nothing at run time).
  declare doc: Document;
  declare scope: Scope;
  declare first: ChildNode;
  declare last: ChildNode;
  declare single: boolean;
  declare parts: Binding[];
  declare frag: DocumentFragment | null;
  // A list's row (ForBinding): its key, the item it shows, its place in the old order.
  declare key: string | number;
  declare item: unknown;
  declare at: number;
  constructor(plan: Plan, view: View, scope: Scope) {
    const frag = (plan.frag.cloneNode(true) as DocumentFragment);
    this.doc = view.doc;
    this.scope = scope;
    // (A block has a node at least: compileBlock starts an empty one with a marker.)
    this.first = frag.firstChild!;
    this.last = frag.lastChild!;
    this.single = plan.single;
    const targets = plan.bindings.map((b) => nodeAt(frag, b.path));
    this.parts = plan.bindings.map((b, i) => makeBinding(b, targets[i], view, scope));
    this.frag = frag; // holds the nodes until the block is inserted
  }
  update() { for (const p of this.parts) p.update(this.scope); }
  insertBefore(parent: Node, ref: Node | null) {
    if (this.frag) { parent.insertBefore(this.frag, ref); this.frag = null; return; }
    if (this.single) { parent.insertBefore(this.first, ref); return; }
    let n = this.first;
    const end = this.last;
    // (`next`: there is one until `end`.)
    for (;;) { const next = n.nextSibling; parent.insertBefore(n, ref); if (n === end) break; n = next!; }
  }
  // Out of the DOM. A row of several nodes keeps them, in order, in a
  // fragment until it goes back in.
  remove() {
    if (this.frag) return;
    if (this.single) { (this.first as ChildNode).remove(); return; }
    const frag = this.doc.createDocumentFragment();
    let n = this.first;
    const end = this.last;
    for (;;) { const next = n.nextSibling; frag.appendChild(n); if (n === end) break; n = next!; }
    this.frag = frag;
  }
}

// A binding made real.
type Binding = { update(scope: Scope): void };
function makeBinding(b: BindingPlan, node: Node, view: View, scope: Scope): Binding {
  switch (b.kind) {
    case 'text': return new TextBinding(node as Text, b.parts);
    case 'element': return new ElementBinding(node as HTMLElement | SVGElement, b.own, view, scope);
    case 'for': return new ForBinding(node as ChildNode, b, view);
    case 'if': return new IfBinding(node as ChildNode, b, view);
    case 'slot': return new SlotBinding(node as Element, b, view);
  }
  throw new Error(`renderer: unknown binding ${(b as BindingPlan).kind}`);
}

class TextBinding {
  // Its fields (set in its constructor and methods; declared only: nothing at run time).
  declare node: Text;
  declare parts: Parts;
  declare last: string;
  constructor(node: Text, parts: Parts) { this.node = node; this.parts = parts; this.last = ''; }
  update(scope: Scope) {
    const v = joinParts(this.parts, scope);
    if (v !== this.last) { this.last = v; this.node.data = v; }
  }
}

const isAria = (name: string) => name.startsWith('aria-');
const BOOLEAN = new Set(['hidden', 'disabled']);

class ElementBinding {
  // Its fields (set in its constructor and methods; declared only: nothing at run time).
  declare el: HTMLElement | SVGElement;
  declare view: View;
  declare own: Own[];
  declare last: unknown[];
  constructor(el: HTMLElement | SVGElement, own: Own[], view: View, scope: Scope) {
    this.el = el;
    this.view = view;
    this.own = own;
    this.last = own.map(() => undefined);
    for (const o of own) {
      if (o.kind === 'action') view.actions.set(el, { name: o.name, p: o.p, literal: o.literal, scope });
      if (o.kind === 'input') { view.inputs.set(el, o.name); view.scopes.set(el, scope); }
      if (o.kind === 'behavior') {
        let entry = view.behaviorEls.get(el);
        if (!entry) { entry = { attrs: {}, scope }; view.behaviorEls.set(el, entry); }
        entry.attrs[o.name] = o.value;
      }
      if (o.kind === 'page') view.pageEl = el;
    }
  }
  update(scope: Scope) {
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
          // (`v`: a string or null, set just above.)
          if (v !== this.last[i]) { this.last[i] = v; if (v === null) el.removeAttribute(o.name); else el.setAttribute(o.name, v as string); }
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
          // (`v`: a string or null, as above.)
          if (v !== this.last[i]) { this.last[i] = v; if (v === null) el.style.removeProperty(o.name); else el.style.setProperty(o.name, v as string); }
          break;
        }
        case 'icon': {
          let v = lookup(scope, o.p);
          v = checkIconUrl(v) ? v : null;
          // (`v`: an icon's data: URL or null.)
          if (v !== this.last[i]) { this.last[i] = v; if (v === null) el.removeAttribute('src'); else el.setAttribute('src', v as string); }
          break;
        }
        default: break;
      }
    }
  }
}

class IfBinding {
  // Its fields (set in its constructor and methods; declared only: nothing at run time).
  declare anchor: ChildNode;
  declare b: IfPlan;
  declare view: View;
  declare state: boolean | null;
  declare blocks: [Block | null, Block | null];
  constructor(anchor: ChildNode, b: IfPlan, view: View) {
    this.anchor = anchor;
    this.b = b;
    this.view = view;
    this.state = null; // true, false, or null before the first update
    this.blocks = [null, null]; // [yes, no], kept once made
  }
  update(scope: Scope) {
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
    // (An anchor is always in its block, never a block's only node: compileBlock.)
    blk.insertBefore(this.anchor.parentNode!, this.anchor);
  }
}

// A slot (<m-menu>, <m-editor>, ...): the theme's part for it, made once and
// kept, inside it while the view model's test holds.
class SlotBinding {
  // Its fields (set in its constructor and methods; declared only: nothing at run time).
  declare el: Element;
  declare b: SlotPlan;
  declare view: View;
  declare block: Block | null;
  declare shown: boolean;
  constructor(el: Element, b: SlotPlan, view: View) {
    this.el = el;
    this.b = b;
    this.view = view;
    this.block = null;
    this.shown = false;
  }
  update(scope: Scope) {
    const on = Boolean(lookup(scope, this.b.test));
    if (!on) {
      if (this.shown) { this.block!.remove(); this.shown = false; } // (shown: made)
      return;
    }
    const plan = this.view.parts.get(this.b.part) ?? this.b.fallback ?? this.view.defaultPart(this.b.part);
    if (!plan) return;
    if (!this.block) this.block = new Block(plan, this.view, scope);
    else this.block.scope = scope;
    this.block.update();
    if (!this.shown) { this.block.insertBefore(this.el, null); this.shown = true; }
  }
}

// Longest increasing subsequence of `seq` (entries < 0 are skipped); returns
// the indexes into seq that are in it.
function lis(seq: number[]) {
  const tails: number[] = [];
  const prev: number[] = new Array(seq.length);
  for (let i = 0; i < seq.length; i++) {
    const v = seq[i];
    if (v < 0) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]] < v) lo = mid + 1; else hi = mid; }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const out = new Set<number>();
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) { out.add(k); k = prev[k]; }
  return out;
}

class ForBinding {
  // Its fields (set in its constructor and methods; declared only: nothing at run time).
  declare anchor: ChildNode;
  declare b: ForPlan;
  declare view: View;
  declare rows: Block[];
  declare byKey: Map<string | number, Block>;
  declare pool: Map<string | number, Block>;
  declare items: unknown[] | null;
  constructor(anchor: ChildNode, b: ForPlan, view: View) {
    this.anchor = anchor;
    this.b = b;
    this.view = view;
    this.rows = []; // in DOM order
    this.byKey = new Map();
    this.pool = new Map(); // rows that left, kept for when their key comes back
    this.items = null;
  }
  key(item: unknown, i: number) {
    const k = item != null && typeof item === 'object' && own.call(item, this.b.key) ? (item as Record<string, unknown>)[this.b.key] : undefined;
    return typeof k === 'string' || typeof k === 'number' ? k : `\u0000${i}`;
  }
  update(scope: Scope) {
    const list = lookup(scope, this.b.each);
    const items = Array.isArray(list) ? list : [];
    const { pure, as } = this.b;
    if (pure && items === this.items) return;
    this.items = items;
    const view = this.view;
    const old = this.rows;
    const next: Block[] = new Array(items.length);
    const seen = new Map<string | number, number>();
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
        if (seen.has(row.key) && next[seen.get(row.key)!] === row) continue;
        row.remove();
        this.byKey.delete(row.key);
        this.pool.set(row.key, row);
      }
      const cap = view.options.rowPool ?? Math.max(256, items.length);
      // (`first`: the pool has one, it's over its cap.)
      while (this.pool.size > cap) { const first = this.pool.keys().next().value!; this.pool.delete(first); }
    }
    // Order: rows on the longest increasing run of old positions stay;
    // the rest (and new rows) go in front of their successor.
    let same = next.length === old.length;
    if (same) for (let i = 0; i < next.length; i++) if (next[i] !== old[i]) { same = false; break; }
    if (!same) {
      for (let i = 0; i < old.length; i++) old[i].at = i;
      const seq = next.map((r) => (this.byKey.get(r.key) === r ? r.at : -1));
      const stay = lis(seq);
      const parent = this.anchor.parentNode!; // (in its block: IfBinding's anchor)
      let ref: ChildNode = this.anchor;
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

type Edges = { left: number, top: number, right: number, bottom: number };
// Where the page goes (View.measure).
export type Layout = { insets: Edges, radius: number, radii: number[], outer: Edges & { radius: number }, container: { width: number, height: number } };

export type ViewOptions = {
  onAction?: (name: string, arg: any, info: { element: Element, event: Event }) => void,
  onInput?: (name: string, value: string) => void,
  onLayout?: (layout: Layout) => void,
  onWarn?: (message: string) => void,
  sheets?: CSSStyleSheet[],
  trustedOnly?: boolean,
  rowPool?: number,
};

export class View {
  // Its fields (set in its constructor and methods; declared only: nothing at run time).
  declare container: ShadowRoot | Document;
  declare doc: Document;
  declare options: ViewOptions;
  declare actions: WeakMap<Element, { name: string, p: Path | null, literal: string | null, scope: Scope }>;
  declare inputs: WeakMap<Element, string>;
  declare scopes: WeakMap<Element, Scope>;
  declare behaviorEls: WeakMap<Element, { attrs: Record<string, string>, scope: Scope }>;
  declare pageEl: HTMLElement | SVGElement | null;
  declare behaviors: { name: string, value: string }[];
  declare warn: ((message: string) => void) | null;
  declare parts: Map<string, Plan>;
  declare ctx: CompileCtx;
  declare defaults: Map<string, Plan | null>;
  declare plan: Plan;
  declare rootScope: Scope;
  declare block: Block | null;
  declare layout: Layout | null;
  declare frame: number;
  declare listeners: (() => void)[];
  declare sheets: CSSStyleSheet[];
  constructor(container: ShadowRoot | Document, template: DocumentFragment, options: ViewOptions = {}) {
    this.container = container;
    this.doc = container.nodeType === 9 ? (container as Document) : (container as ShadowRoot).ownerDocument as Document; // (a shadow root is in one)
    this.options = options;
    this.actions = new WeakMap();
    this.inputs = new WeakMap();
    this.scopes = new WeakMap(); // an input's scope
    this.behaviorEls = new WeakMap(); // element -> { attrs: { 'm-drag': 'tab', ... }, scope }
    this.pageEl = null;
    this.behaviors = [];
    this.warn = options.onWarn ?? null;
    const ctx: CompileCtx = { doc: this.doc, behaviors: this.behaviors, guard: false, warn: (m) => this.warn?.(m) };
    // The theme's parts, compiled once, before the template that shows them.
    this.parts = new Map();
    const findParts = (nodes: NodeListOf<ChildNode>) => {
      for (const n of nodes) {
        if (n.nodeType !== 1) continue;
        const el = (n as Element);
        if (el.localName === 'template' && el.namespaceURI !== SVG_NS) {
          const name = el.getAttribute('m-part');
          if (name && !this.parts.has(name)) this.parts.set(name, compileBlock([...el.childNodes], GUARDED.has(name) ? { ...ctx, guard: true } : ctx, new Set<string>()));
          continue;
        }
        findParts(el.childNodes);
      }
    };
    findParts(template.childNodes);
    this.ctx = ctx;
    // Margin's own parts, compiled when first wanted.
    this.defaults = new Map();
    this.plan = compileBlock([...template.childNodes], ctx, new Set<string>());
    this.rootScope = { name: null, value: {}, parent: null };
    this.block = null;
    this.layout = null;
    this.frame = 0;
    this.listeners = [];
    const sheets = [baseSheet(this.doc), ...(options.sheets ?? [])];
    const target = container;
    target.adoptedStyleSheets = [...target.adoptedStyleSheets.filter((s) => !sheets.includes(s)), ...sheets];
    this.sheets = sheets;
  }

  /** Margin's own part `name` (DEFAULT_PARTS), compiled once, guarded; null if it has none. */
  defaultPart(name: string) {
    if (!this.defaults.has(name)) {
      const tree = DEFAULT_PARTS[name];
      const frag = tree ? buildTemplate(tree, this.doc.implementation.createHTMLDocument('')) : null;
      this.defaults.set(name, frag ? compileBlock([...frag.childNodes], { ...this.ctx, guard: true }, new Set<string>()) : null);
    }
    return this.defaults.get(name) ?? null;
  }

  /** Renders the view model: the first call builds, later ones update. */
  update(vm: unknown) {
    this.rootScope.value = vm ?? {};
    if (!this.block) {
      this.block = new Block(this.plan, this, this.rootScope);
      this.block.update();
      const parent = this.container.nodeType === 9 ? (this.container as Document).body : this.container;
      this.block.insertBefore(parent, null);
      this.listen(parent);
    } else this.block.update();
    if (this.options.onLayout) this.scheduleLayout();
  }

  listen(parent: Node) {
    const click = (e: Event) => {
      let n = (e.target as any);
      const stop = this.container;
      let anchor = null;
      while (n && n !== stop && n !== this.doc) {
        if (!anchor && n.localName === 'a') anchor = n;
        const action = this.actions.get(n);
        if (action) {
          e.preventDefault();
          if (this.options.trustedOnly !== false && !e.isTrusted) return;
          const arg = action.p ? lookup(action.scope, action.p) : (action.literal ?? undefined);
          this.options.onAction?.(action.name, arg, { element: n, event: e });
          return;
        }
        n = n.parentNode;
      }
      if (anchor) e.preventDefault(); // links in a theme never navigate
    };
    const input = (e: Event) => {
      // (An input event's target: an element, one of Margin's inputs if it's known.)
      const name = this.inputs.get(e.target as Element);
      if (name) this.options.onInput?.(name, (e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value);
    };
    parent.addEventListener('click', click);
    parent.addEventListener('input', input);
    this.listeners.push(() => { parent.removeEventListener('click', click); parent.removeEventListener('input', input); });
    if (typeof ResizeObserver === 'function' && this.options.onLayout) {
      const ro = new ResizeObserver(() => this.scheduleLayout());
      const host = this.container.nodeType === 9 ? this.doc.documentElement : (this.container as ShadowRoot).host;
      ro.observe(host);
      if (this.pageEl) ro.observe(this.pageEl);
      this.listeners.push(() => ro.disconnect());
    }
  }

  // --- What behaviors ask of the view (ui/behaviors/) -------------------------

  /** The theme's root element (the template's one root). */
  rootElement(): Element | null {
    let n = this.block?.first ?? null;
    while (n && n.nodeType !== 1) n = n.nextSibling;
    return (n as Element | null);
  }
  /** Whether a node is in what this view drew (not the container's host, not the page). */
  // (Asked of events' targets in Margin's container and document: nodes.)
  owns(node: EventTarget | null) {
    const root = this.rootElement();
    return !!root && !!node && (node === root || root.contains(node as Node));
  }
  /** The behaviors an element of the theme has, and its scope: { attrs, scope } or null. */
  behaviorOf(el: Element) { return this.behaviorEls.get(el) ?? null; }
  /**
   * The nearest element from `node` up (to the container) with behavior
   * `name` (and `value`, if given): { el, value, scope }.
   */
  behaviorAt(node: EventTarget | null, name: string, value?: string) {
    for (let n = (node as any); n && n !== this.container && n !== this.doc; n = n.parentNode) {
      const b = this.behaviorEls.get(n);
      if (b && Object.hasOwn(b.attrs, name) && (value === undefined || b.attrs[name] === value)) return { el: (n as HTMLElement | SVGElement), value: b.attrs[name], scope: b.scope };
    }
    return null;
  }
  /** The nearest element from `node` up with an action: { el, name, arg }. */
  actionAt(node: EventTarget | null) {
    for (let n = (node as any); n && n !== this.container && n !== this.doc; n = n.parentNode) {
      const a = this.actions.get(n);
      if (a) return { el: (n as HTMLElement | SVGElement), name: a.name, arg: a.p ? lookup(a.scope, a.p) : (a.literal ?? undefined) };
    }
    return null;
  }
  /** An action element's action and argument now. */
  actionOf(el: Element) {
    const a = this.actions.get(el);
    return a ? { name: a.name, arg: a.p ? lookup(a.scope, a.p) : (a.literal ?? undefined) } : null;
  }
  /**
   * What a row is drawn from: the item of the innermost <m-for> around an
   * element with a behavior or an action (a tab row, a pin, a folder, a
   * space's chip), or null outside any list.
   * */
  subjectOf(el: Element) {
    const scope = this.behaviorEls.get(el)?.scope ?? this.actions.get(el)?.scope ?? this.scopes.get(el);
    return scope?.parent ? scope.value : null;
  }
  /** The connected elements with behavior `name` (`value`), in document order. */
  marked(name: string, value?: string): (HTMLElement | SVGElement)[] {
    const root = this.rootElement();
    if (!root) return [];
    const sel = value === undefined ? `[${name}]` : `[${name}="${value}"]`;
    // (A theme's elements: HTML's and SVG's only, ui/sanitize.ts.)
    const all = [...(root.matches(sel) ? [root] : []), ...root.querySelectorAll(sel)] as (HTMLElement | SVGElement)[];
    return all.filter((el) => { const b = this.behaviorEls.get(el); return !!b && Object.hasOwn(b.attrs, name); });
  }
  /** The connected elements with action `name`, in document order. */
  actionElements(name: string, within?: Element) {
    const root = within ?? this.rootElement();
    if (!root) return [];
    return [...root.querySelectorAll('button, a')].filter((el) => this.actions.get(el)?.name === name);
  }
  /** The input bound to `name` (m-input), if one is drawn. */
  input(name: string): HTMLInputElement | null {
    const root = this.rootElement();
    const el = root?.querySelector(`input[m-input="${name}"]`);
    return el && this.inputs.get(el) === name ? (el as HTMLInputElement) : null;
  }

  scheduleLayout() {
    if (this.frame) return;
    const win = this.doc.defaultView!; // (the view's document is shown: it has a window)
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
  measure(): Layout | null {
    const el = this.pageEl;
    if (!el || !el.isConnected) return null;
    const win = this.doc.defaultView!; // (as above)
    const c = this.container.nodeType === 9
      ? { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight, width: win.innerWidth, height: win.innerHeight }
      : (this.container as ShadowRoot).host.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const cs = win.getComputedStyle(el);
    const px = (v: string) => parseFloat(v) || 0;
    const bw = { left: px(cs.borderLeftWidth) + px(cs.paddingLeft), top: px(cs.borderTopWidth) + px(cs.paddingTop), right: px(cs.borderRightWidth) + px(cs.paddingRight), bottom: px(cs.borderBottomWidth) + px(cs.paddingBottom) };
    const outer = { left: r.left - c.left, top: r.top - c.top, right: c.right - r.right, bottom: c.bottom - r.bottom };
    const round = (v: number) => Math.round(v * 100) / 100;
    const corner = (v: string) => px(String(v).split(' ')[0]);
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
    const target = this.container;
    target.adoptedStyleSheets = target.adoptedStyleSheets.filter((s) => !this.sheets.includes(s));
  }
}

// A layout is new when the page's insets or radius changed, or the
// container's size did (the window resized: the page's box with it).
const sameLayout = (a: Layout, b: Layout | null) => b && (['left', 'top', 'right', 'bottom'] as const).every((k) => a.insets[k] === b.insets[k]) && a.radius === b.radius
  && a.container.width === b.container.width && a.container.height === b.container.height;

const bases: WeakMap<Document, CSSStyleSheet> = new WeakMap();
function baseSheet(doc: Document) {
  let sheet = bases.get(doc);
  if (!sheet) {
    sheet = new doc.defaultView!.CSSStyleSheet(); // (a shown document's)
    sheet.replaceSync(BASE_CSS);
    bases.set(doc, sheet);
  }
  return sheet;
}

/**
 * Renders a template with a view model into a container, and returns the
 * view for later updates.
 */
export function render(container: ShadowRoot | Document, template: DocumentFragment, vm: unknown, options: ViewOptions) {
  const view = new View(container, template, options);
  view.update(vm);
  return view;
}
