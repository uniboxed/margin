// What must never be in a sanitized template, checked on the sanitizer's tree
// (Node) and on the DOM the renderer made (browsers).
import type { CleanNode } from '../../extension/ui/sanitize.ts';

// The sanitizer's tree (ui/sanitize.ts sanitizeTemplate's `tree`).
type Tree = { type: 'root', children: CleanNode[] };

const FORBIDDEN = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'link', 'meta', 'base', 'style', 'foreignobject',
  'image', 'feimage', 'animate', 'animatemotion', 'animatetransform', 'set', 'math', 'noscript',
  'video', 'audio', 'source', 'picture', 'canvas', 'dialog', 'portal', 'applet', 'svg:script', 'x:script',
]);
const FORBIDDEN_ATTRS = new Set(['srcdoc', 'formaction', 'action', 'srcset', 'ping', 'target', 'xlink:href', 'contenteditable', 'popover', 'popovertarget', 'autofocus', 'name', 'accesskey', 'draggable']);
const URL_ATTRS = new Set(['href', 'src', 'style', 'fill', 'stroke', 'filter', 'mask', 'clip-path', 'poster', 'data', 'background']);
const BAD_VALUE = /evil\.test|javascript:|vbscript:|expression\(|data:text\//i;

function checkAttr(element: string, name: string, value: string, out: string[]) {
  const n = name.toLowerCase();
  if (n.startsWith('on')) out.push(`<${element}> has ${name}`);
  if (FORBIDDEN_ATTRS.has(n)) out.push(`<${element}> has ${name}`);
  if (n === 'href' && !/^#[A-Za-z0-9_-]*$/.test(value)) out.push(`<${element}> href=${value}`);
  if (n === 'src' && !/^data:image\//.test(value)) out.push(`<${element}> src=${value.slice(0, 60)}`);
  if (URL_ATTRS.has(n) && BAD_VALUE.test(value)) out.push(`<${element}> ${name}=${value.slice(0, 80)}`);
  if (n === 'style' && /url\(\s*["']?(?!data:image\/|#)/i.test(value)) out.push(`<${element}> style with url(): ${value.slice(0, 80)}`);
  if (n === 'type' && element === 'button' && value !== 'button') out.push(`<button type=${value}>`);
}

export function auditTree(tree: Tree | null) {
  const out: string[] = [];
  const walk = (node: Tree | CleanNode) => {
    if (node.type === 'el') {
      const name = node.name.toLowerCase();
      if (FORBIDDEN.has(name) || name.includes(':')) out.push(`element <${node.name}>`);
      if (name === 'input' && !node.attrs.some(([a]) => a === 'm-input')) out.push('<input> without m-input');
      // Margin's Settings list and choice only, empty (their text and options are Margin's).
      if (name === 'textarea' && (!node.attrs.some(([a, v]) => a === 'm-input' && v === 'setting-list') || node.children?.length)) out.push('<textarea> not Margin\'s, or with content');
      if (name === 'select' && (!node.attrs.some(([a, v]) => a === 'm-input' && v === 'setting-choice') || node.children?.length)) out.push('<select> not Margin\'s, or with content');
      for (const [a, v] of node.attrs) checkAttr(name, a, v, out);
    }
    for (const c of 'children' in node ? node.children : []) walk(c);
  };
  if (tree) walk(tree);
  return out;
}

// In a page: every element under `root` (a shadow root or an element).
export function auditDom(root: ParentNode) {
  const out: string[] = [];
  const all = root.querySelectorAll<HTMLElement | SVGElement>('*'); // (a theme's elements: HTML and SVG, each with its style)
  for (const el of all) {
    const name = el.localName.toLowerCase();
    if (FORBIDDEN.has(name) || name.includes(':')) out.push(`element <${el.localName}>`);
    for (const attr of el.attributes) checkAttr(name, attr.name, attr.value, out);
    if (el.style && el.style.length) {
      for (let i = 0; i < el.style.length; i++) {
        const prop = el.style[i];
        const value = el.style.getPropertyValue(prop);
        if (/url\(\s*["']?(?!data:image\/|#)/i.test(value) || BAD_VALUE.test(value)) out.push(`<${el.localName}> style ${prop}: ${value.slice(0, 80)}`);
      }
    }
  }
  return out;
}
