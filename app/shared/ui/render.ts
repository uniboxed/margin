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
//   m-drag, m-drop, m-peek, m-resize, m-rename, m-scroll, m-swipe, m-input, m-empty
//                           behaviors (ui/behaviors/): kept on the element, which
//                           the view knows with its scope (behaviorOf, subjectOf)
//   <template m-part>       a named part, shown in its slot (<m-menu>: `menu`,
//                           <m-editor>: `space-editor`, <m-palette>: `palette`,
//                           <m-notice>: `notice`, <m-launcher>: `launcher`,
//                           <m-prompt>: `prompt`, <m-settings>: `settings`,
//                           <m-page-loader>: `page-loader`)
//                           while the view model says so;
//                           in Margin's menus, notices and prompts only bound
//                           text shows (ui/sanitize.ts GUARDED_PARTS)
// Theme packages are loaded (sanitized, fonts made, sheets built) by
// ui/theme-loader.ts, and driven by ui/runtime.ts.
import { GUARDED_PARTS, GUARDED_SLOTS, TEXT_ATTRS, checkCssValue, checkIconUrl, guardText, parseInterpolation } from './sanitize.ts';
import type { CleanNode } from './sanitize.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Margin's own rules, under the theme's. The page slot never paints and
// never takes clicks: the browser's page is there.
const BASE_CSS = `
m-page{display:block;box-sizing:border-box;background:none!important;pointer-events:none!important}
m-page[m-split]{display:flex!important;flex-direction:row;align-items:stretch}
m-page[m-split="column"]{flex-direction:column}
m-pane{display:block;box-sizing:border-box;flex:1 1 0px;min-width:0;min-height:0;background:none!important;pointer-events:none!important}
m-divider{display:block;box-sizing:border-box;flex:0 0 var(--m-split-gap,8px);position:relative;pointer-events:auto!important;cursor:col-resize;touch-action:none;outline:none;-webkit-user-select:none;user-select:none}
m-page[m-split="column"]>m-divider{cursor:row-resize}
m-pane{position:relative}
m-pane>m-pane-loader{position:absolute;inset:0;display:flex;background:Canvas;color:CanvasText;color-scheme:light dark;flex-direction:column;align-items:center;justify-content:center;gap:10px;overflow:hidden;pointer-events:none;font:500 13px/1.3 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-user-select:none;user-select:none}
m-pane-loader>m-pane-spinner{display:block;flex:none;width:20px;height:20px;box-sizing:border-box;border-radius:50%;border:2px solid color-mix(in srgb,currentColor 18%,transparent);border-top-color:color-mix(in srgb,currentColor 70%,transparent);animation:m-pane-spin .9s linear infinite}
m-pane-loader>m-pane-label{display:block;max-width:90%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;opacity:.72}
@keyframes m-pane-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){m-pane-loader>m-pane-spinner{animation-duration:2.4s}}
m-pane>m-pane-arrow{position:absolute;z-index:1;display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:28px;height:48px;border-radius:14px;background:color-mix(in srgb,Canvas 84%,transparent);color:CanvasText;color-scheme:light dark;box-shadow:0 1px 3px rgba(0,0,0,.22),0 0 0 .5px color-mix(in srgb,CanvasText 18%,transparent);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);cursor:pointer;opacity:0;visibility:hidden;pointer-events:none!important;transition:opacity .12s ease,visibility .12s;-webkit-user-select:none;user-select:none}
m-pane[m-cut-hover]>m-pane-arrow{opacity:1;visibility:visible;pointer-events:auto!important}
m-pane>m-pane-arrow:hover,m-pane>m-pane-arrow[m-hover]{background:color-mix(in srgb,Canvas 96%,transparent)}
m-pane>m-pane-arrow[m-side=left]{left:10px;top:50%;transform:translateY(-50%)}
m-pane>m-pane-arrow[m-side=right]{right:10px;top:50%;transform:translateY(-50%)}
m-pane>m-pane-arrow[m-side=up]{top:10px;left:50%;transform:translateX(-50%);width:48px;height:28px}
m-pane>m-pane-arrow[m-side=down]{bottom:10px;left:50%;transform:translateX(-50%);width:48px;height:28px}
m-pane>m-pane-arrow::before{content:"";display:block;width:7px;height:7px;border:solid currentColor;border-width:0 0 2px 2px;opacity:.8}
m-pane>m-pane-arrow[m-side=left]::before{transform:translateX(1.5px) rotate(45deg)}
m-pane>m-pane-arrow[m-side=right]::before{transform:translateX(-1.5px) rotate(-135deg)}
m-pane>m-pane-arrow[m-side=up]::before{transform:translateY(1.5px) rotate(135deg)}
m-pane>m-pane-arrow[m-side=down]::before{transform:translateY(-1.5px) rotate(-45deg)}
@media (prefers-reduced-motion:reduce){m-pane>m-pane-arrow{transition:none}}
m-divider>m-band-title{position:absolute;left:12px;right:calc(50% + 34px);top:50%;transform:translateY(-50%);display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:500 12px/16px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;opacity:.72;pointer-events:none;-webkit-user-select:none;user-select:none}
m-window-controls,m-drag-region,m-palette,m-notice,m-menu,m-editor,m-launcher,m-prompt,m-settings,m-page-loader,m-toast,m-preview{display:block}
m-preview-page{display:block}
m-preview[m-default]{position:fixed;left:var(--m-page-left,0px);top:var(--m-page-top,0px);right:var(--m-page-right,0px);bottom:var(--m-page-bottom,0px);z-index:2147483630;overflow:hidden;border-radius:var(--m-page-radius,0px);pointer-events:none;color-scheme:light dark;font:13px/1.3 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
m-preview[m-default]:is([m-loading],[m-quick-tab]){pointer-events:auto}
m-preview[m-default]>[m-preview-card]{position:absolute;left:clamp(0px,8%,calc(50% - 210px));right:clamp(0px,8%,calc(50% - 210px));top:clamp(0px,7%,calc(50% - 186px));bottom:clamp(0px,7%,calc(50% - 186px));display:flex;flex-direction:column;border-radius:12px;overflow:hidden;background:Canvas;color:CanvasText;box-shadow:0 0 0 100vmax rgba(0,0,0,.32),0 18px 48px rgba(0,0,0,.3);animation:m-preview-in .15s cubic-bezier(.2,.8,.2,1) both}
m-preview[m-default][m-quick-tab]>[m-preview-card]{bottom:auto;height:44px}
m-preview[m-default][m-closing]>[m-preview-card]{animation:m-preview-out .15s cubic-bezier(.4,0,1,1) both}
m-preview[m-default] [m-preview-bar]{flex:none;height:52px;box-sizing:border-box;display:flex;align-items:center;gap:6px;padding:0 10px;pointer-events:auto;border-bottom:1px solid color-mix(in srgb,CanvasText 12%,transparent)}
m-preview[m-default] [m-preview-bar] button{font:inherit;color:inherit;height:28px;min-width:28px;padding:0 9px;border-radius:7px;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);background:transparent;cursor:default}
m-preview[m-default] [m-preview-bar] button:hover{background:color-mix(in srgb,CanvasText 8%,transparent)}
m-preview[m-default] [m-preview-host]{flex:1 1 0;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;opacity:.7}
m-preview[m-default] [m-preview-field]{display:none;flex:1 1 0;min-width:0;height:30px;box-sizing:border-box;padding:0 10px;border-radius:8px;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);background:transparent;color:inherit;font:inherit;outline:none}
m-preview[m-default][m-quick-tab] [m-preview-field]{display:block}
m-preview[m-default][m-quick-tab] :is([m-preview-host],[m-preview-button="preview.back"],[m-preview-button="preview.forward"],[m-preview-button="preview.copyUrl"],[m-preview-button="preview.expand"]){display:none}
m-preview[m-default][m-quick-tab] m-preview-page{display:none}
m-preview[m-default] m-preview-page{flex:1 1 auto;min-height:0;background:transparent}
m-preview[m-default]:is([m-loading],[m-closing]) m-preview-page{background:Canvas}
@keyframes m-preview-in{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:none}}
@keyframes m-preview-out{from{opacity:1;transform:none}to{opacity:0;transform:scale(.96)}}
@keyframes m-preview-fade-in{from{opacity:0}to{opacity:1}}
@keyframes m-preview-fade-out{from{opacity:1}to{opacity:0}}
@media (prefers-reduced-motion:reduce){m-preview[m-default]>[m-preview-card]{animation-name:m-preview-fade-in}m-preview[m-default][m-closing]>[m-preview-card]{animation-name:m-preview-fade-out}}
m-menu{position:fixed;left:var(--m-menu-x,0px);top:var(--m-menu-y,0px);z-index:2147483600;outline:none}
m-menu:empty,m-editor:empty,m-palette:empty,m-notice:empty,m-launcher:empty,m-prompt:empty,m-settings:empty,m-page-loader:empty,m-toast:empty,m-preview:empty{display:none}
m-toast[m-default]{position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483640;padding:7px 14px;border-radius:999px;background:rgba(28,28,32,.9);color:#f5f5f7;font:500 12.5px/1.3 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.28),0 0 0 1px rgba(255,255,255,.12);pointer-events:none;white-space:nowrap;max-width:min(80vw,360px);overflow:hidden;text-overflow:ellipsis;animation:m-toast-in .14s ease-out}
@keyframes m-toast-in{from{opacity:0;transform:translate(-50%,-6px) scale(.97)}to{opacity:1;transform:translate(-50%,0) scale(1)}}
@media (prefers-reduced-motion:reduce){m-toast[m-default]{animation:none}}
m-page-loader[m-default]{position:fixed;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;background:Canvas;color:CanvasText;font:13px/1.3 system-ui,sans-serif;text-align:center;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s linear,visibility 0s linear .12s}
[m-page-state="loading"]>m-page-loader[m-default]{opacity:1;visibility:visible;pointer-events:auto;transition:none}
[m-page-state="elsewhere"]>m-page-loader[m-default]{opacity:.55;visibility:visible;pointer-events:none;transition:none}
[m-page-state="elsewhere"]>m-page-loader[m-default]>[m-loader-spin]{display:none}
m-page-picture{position:fixed;z-index:2147483000;box-sizing:border-box;display:block;overflow:hidden;background:Canvas;color:CanvasText;pointer-events:none;font-size:13px;line-height:1.3}
m-page-picture>img{display:block;width:100%;height:100%;object-fit:cover;object-position:top left;opacity:.45;filter:saturate(.6)}
m-page-picture>[m-picture-label]{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);max-width:min(80%,420px);box-sizing:border-box;padding:7px 14px;border-radius:999px;background:Canvas;color:CanvasText;box-shadow:0 1px 6px color-mix(in srgb,CanvasText 18%,transparent);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
m-page-picture>[m-picture-label]:empty{display:none}
m-page-slow{position:fixed;z-index:2147483001;box-sizing:border-box;display:flex;align-items:flex-end;justify-content:center;padding-bottom:28px;pointer-events:none;background:none}
m-page-slow>[m-slow-label]{display:block;max-width:min(80%,420px);box-sizing:border-box;padding:7px 14px;border-radius:999px;background:Canvas;color:CanvasText;color-scheme:light dark;box-shadow:0 1px 6px color-mix(in srgb,CanvasText 18%,transparent);font:500 13px/1.3 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
m-page-loader[m-default]>[m-loader-icon]{display:block;width:32px;height:32px;margin-bottom:4px;object-fit:contain}
m-page-loader[m-default]>[m-loader-icon]:not([src]){display:none}
m-page-loader[m-default]>[m-loader-spin]{display:block;width:18px;height:18px;box-sizing:border-box;border-radius:50%;border:2px solid color-mix(in srgb,currentColor 18%,transparent);border-top-color:color-mix(in srgb,currentColor 70%,transparent);animation:m-loader-spin .9s linear infinite}
m-page-loader[m-default]>[m-loader-label]{display:block;max-width:min(80%,420px);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;opacity:.7}
@keyframes m-loader-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){m-page-loader[m-default]{transition:none}m-page-loader[m-default]>[m-loader-spin]{animation:none}}
m-startup{position:fixed;inset:0;z-index:2147483647;box-sizing:border-box;display:grid;place-items:center;background:Canvas;color:CanvasText;font:13px/1.35 system-ui,sans-serif;text-align:center;pointer-events:auto!important;cursor:default;-webkit-user-select:none;user-select:none}
m-startup>[m-startup-spin]{grid-area:1/1;display:block;width:18px;height:18px;box-sizing:border-box;border-radius:50%;border:2px solid color-mix(in srgb,currentColor 18%,transparent);border-top-color:color-mix(in srgb,currentColor 70%,transparent);animation:m-loader-spin .9s linear infinite}
m-startup>[m-startup-stuck]{position:absolute;left:50%;top:calc(50% + 60px);transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:14px;width:min(460px,calc(100% - 48px))}
m-startup [m-startup-text]{margin:0}
m-startup [m-startup-actions]{display:flex;flex-wrap:wrap;justify-content:center;gap:10px}
m-startup [m-startup-action]{font:inherit;color:inherit;padding:6px 14px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 30%,transparent);background:color-mix(in srgb,currentColor 8%,transparent);cursor:pointer}
m-startup [m-startup-action]:focus-visible{outline:2px solid currentColor;outline-offset:2px}
@media (prefers-reduced-motion:reduce){m-startup>[m-startup-spin]{animation:none}}
template{display:none!important}
[m-passthrough]{pointer-events:none!important}
:where([m-passthrough])>:where(:not(m-page)){pointer-events:auto}
[m-away]{visibility:hidden!important}
[m-sidebar-fixed] [m-resize]{display:none!important}
[m-away] :is(m-notice,m-prompt){visibility:visible!important}
.m-drag-ghost{position:fixed!important;margin:0!important;pointer-events:none!important;z-index:2147483601!important;box-sizing:border-box}
[contenteditable].m-renaming{cursor:text;user-select:text;-webkit-user-select:text}
`;

// `m-passthrough`, `m-away`, `m-sidebar-fixed`, `m-page-state`, `m-starting` and `m-startup` are the host's and the
// runtime's, on the theme's root (a theme can't write m- attributes of its own; its CSS can select
// them). `m-page-state` (Margin.app's own window: ui/runtime.ts followPage): `shown`, a hosted window
// shows through the page's place, which draws nothing; `loading`, an item is being opened: the page
// card opaque, with the theme's `page-loader` part in its `<m-page-loader>`, or Margin's own loader
// (`m-page-loader[m-default]`, above: a quiet spinner and Margin's words, laid over the page's place by
// the runtime; it fades out over the hosted window as `shown` comes); `empty`, nothing to show: the
// launcher. `m-starting`: from the first frame until the state's data is drawn (a theme's skeleton).
// `m-startup` (Margin.app's own window, its default browser getting ready): the start screen, Margin's
// `<m-startup>` over the whole window, the theme's loader marks in it (`> m-startup::before`, `::after`).
// The others: the pointer over the page's slot
// goes to the page under it, past the root's own background (the in-page
// host sets it while the pointer is there; what the theme draws over the
// page still takes it), and Margin out of the way (Chrome outside full
// screen, a copy that stood back) shows only its notices and prompts, and
// the sidebar's width can't be dragged (Margin.app's own window as a tile
// beside a hosted one: its handle goes; ui/host-app.ts sidebarFixed).
//
// Margin's slots, and what each shows: a theme's part (`<template m-part>`),
// else what the theme put inside the slot, while `test` holds.
const SLOTS: Record<string, { part: string, test: string[] }> = {
  'm-menu': { part: 'menu', test: ['menu'] },
  'm-editor': { part: 'space-editor', test: ['editor'] },
  'm-palette': { part: 'palette', test: ['palette', 'open'] },
  'm-notice': { part: 'notice', test: ['notice'] },
  'm-launcher': { part: 'launcher', test: ['launcher'] },
  'm-page-loader': { part: 'page-loader', test: ['pageLoader'] },
  'm-prompt': { part: 'prompt', test: ['prompt'] },
  'm-settings': { part: 'settings', test: ['settingsForm'] },
  'm-toast': { part: 'toast', test: ['toast'] },
  'm-preview': { part: 'preview', test: ['preview'] },
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
    const plan = this.view.parts.get(this.b.part) ?? this.b.fallback;
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
// The sidebar's rows (View.rowElements): the first element of every row of a list of the view model's tab, pin and
// folder rows (ui/view-model.ts TabRow, PinRow, FolderRow: not the palette's rows, the menus', the chips), in the
// blocks drawn now, nested lists too (a folder's pins).

const ROW_KINDS = new Set(['tab', 'pin', 'folder']);
const isRow = (item: unknown) => !!item && typeof item === 'object' && ROW_KINDS.has((item as { kind?: string }).kind as string)
  && ('pinned' in item || 'isFolder' in item);
function firstElement(block: Block): Element | null {
  for (let n: ChildNode | null = block.first; n; n = n.nextSibling) {
    if (n.nodeType === 1) return n as Element;
    if (n === block.last) break;
  }
  return null;
}
function collectRows(block: Block, out: Element[]) {
  for (const part of block.parts) {
    if (part instanceof ForBinding) {
      const rows = part.rows.length && isRow(part.rows[0].item);
      for (const row of part.rows) {
        if (rows) { const el = firstElement(row); if (el) out.push(el); }
        collectRows(row, out);
      }
    } else if (part instanceof IfBinding) {
      const shown = part.state === null ? null : part.blocks[part.state ? 0 : 1];
      if (shown) collectRows(shown, out);
    } else if (part instanceof SlotBinding) {
      if (part.shown && part.block) collectRows(part.block, out);
    }
  }
}

// Every list's rows (View.rowNodes): each row's top-level elements, whatever its list shows, nested lists too.
function collectListRows(block: Block, out: Set<Element>) {
  for (const part of block.parts) {
    if (part instanceof ForBinding) {
      for (const row of part.rows) {
        for (let n: ChildNode | null = row.first; n; n = n.nextSibling) {
          if (n.nodeType === 1) out.add(n as Element);
          if (n === row.last) break;
        }
        collectListRows(row, out);
      }
    } else if (part instanceof IfBinding) {
      const shown = part.state === null ? null : part.blocks[part.state ? 0 : 1];
      if (shown) collectListRows(shown, out);
    } else if (part instanceof SlotBinding) {
      if (part.shown && part.block) collectListRows(part.block, out);
    }
  }
}

// ---------------------------------------------------------------------------
// The view.

type Edges ={ left: number, top: number, right: number, bottom: number };
// Where the page goes (View.measure).
export type Layout = {
  insets: Edges, radius: number, radii: number[], outer: Edges & { radius: number }, container: { width: number, height: number },
  /** A split's panes laid out in `<m-page>` (ui/behaviors/split.ts): the split's id, each `<m-pane>`'s box by its item. */
  split?: string, panes?: { id: string, rect: number[] }[],
};

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

  /** Whether the theme reads the view model's `head` anywhere (its template or a part): what it draws. */
  reads(head: string) {
    return this.plan.heads.has(head) || [...this.parts.values()].some((part) => part.heads.has(head));
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
  /** The sidebar's rows drawn now (tabs, pins, folders: their first elements), in order (ui/row-motion.ts). */
  rowElements(): Element[] {
    const out: Element[] = [];
    if (this.block) collectRows(this.block, out);
    return out;
  }
  /**
   * Every row of every list drawn now (each `<m-for>` item's own top-level elements, nested lists' too, in what's
   * shown): what's part of a row wherever its parts are drawn (ui/empty.ts).
   * */
  rowNodes(): Set<Element> {
    const out = new Set<Element>();
    if (this.block) collectListRows(this.block, out);
    return out;
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
      this.reportLayout();
    });
  }

  /**
   * The page's place measured and reported now, not at the next frame (a
   * drag of the sidebar's width just ended: the host hears the last place
   * before it's told the drag is over, behaviors/resize.ts).
   */
  flushLayout() {
    if (this.frame) { this.doc.defaultView?.cancelAnimationFrame(this.frame); this.frame = 0; }
    this.reportLayout();
  }

  private reportLayout() {
    const layout = this.measure();
    if (layout && !sameLayout(layout, this.layout)) { this.layout = layout; this.options.onLayout?.(layout); }
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
    // (A split's panes, Margin's own `<m-pane>`s in the page's place: each one's box, by its item, in order.)
    const paneEls = [...el.children].filter((p) => p.localName === 'm-pane' && p.hasAttribute('m-pane-id'));
    const split = paneEls.length >= 2 ? el.getAttribute('m-split-id') : null;
    return {
      insets: { left: round(outer.left + bw.left), top: round(outer.top + bw.top), right: round(outer.right + bw.right), bottom: round(outer.bottom + bw.bottom) },
      radius: round(Math.max(0, radii[0] - border)),
      radii: radii.map((v) => round(Math.max(0, v - border))),
      outer: { left: round(outer.left), top: round(outer.top), right: round(outer.right), bottom: round(outer.bottom), radius: round(radii[0]) },
      container: { width: round(c.width), height: round(c.height) },
      ...(split ? {
        split,
        panes: paneEls.map((p) => {
          const b = p.getBoundingClientRect();
          return { id: p.getAttribute('m-pane-id') ?? '', rect: [round(b.left - c.left), round(b.top - c.top), round(b.width), round(b.height)] };
        }),
      } : {}),
    };
  }

  /**
   * Where the preview card's window goes (docs/PEEK-SPLIT.md §2): the theme's `<m-preview-page>` (in its `preview` part) as the
   * page's own box is measured, its content box in the container's coordinates, and its inner corner radius. Laid out,
   * not as drawn: the card's open (a scale) and close never move it (offsets ignore transforms). Null with no card drawn
   * (none in the theme, Quick Tab's field alone, the element hidden).
   */
  measurePeekPage(): { x: number, y: number, width: number, height: number, radius: number } | null {
    const root = this.rootElement();
    const el = root?.querySelector('m-preview-page') as HTMLElement | null;
    if (!el || !el.isConnected || typeof el.offsetWidth !== 'number') return null;
    const win = this.doc.defaultView!;
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || el.offsetWidth <= 0 || el.offsetHeight <= 0) return null;
    let x = 0, y = 0;
    // (Each offset is from its offset parent's padding edge: that parent's border added.)
    for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) {
      x += n.offsetLeft;
      y += n.offsetTop;
      const p = n.offsetParent as HTMLElement | null;
      if (p) { x += p.clientLeft; y += p.clientTop; }
    }
    const c = this.container.nodeType === 9 ? { left: 0, top: 0 } : (this.container as ShadowRoot).host.getBoundingClientRect();
    const px = (v: string) => parseFloat(v) || 0;
    const left = px(cs.borderLeftWidth) + px(cs.paddingLeft), top = px(cs.borderTopWidth) + px(cs.paddingTop);
    const right = px(cs.borderRightWidth) + px(cs.paddingRight), bottom = px(cs.borderBottomWidth) + px(cs.paddingBottom);
    const round = (v: number) => Math.round(v * 100) / 100;
    return {
      x: round(x - c.left + left), y: round(y - c.top + top),
      width: round(Math.max(0, el.offsetWidth - left - right)), height: round(Math.max(0, el.offsetHeight - top - bottom)),
      radius: round(Math.max(0, px(String(cs.borderBottomLeftRadius).split(' ')[0]) - Math.max(px(cs.borderTopWidth), px(cs.borderLeftWidth)))),
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
  && a.container.width === b.container.width && a.container.height === b.container.height
  && a.split === b.split && JSON.stringify(a.panes ?? null) === JSON.stringify(b.panes ?? null);

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
