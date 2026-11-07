// Minimal stand-in for the Design canvas runtime: {{holes}}, sc-if, sc-for, on* handlers.
(function () {
  class DCLogic { constructor(props) { this.props = props || {}; this.state = {}; } setState(p) { Object.assign(this.state, typeof p === 'function' ? p(this.state) : p); window.__rerender && window.__rerender(); } }
  window.DCLogic = DCLogic;
  const HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
  const resolve = (expr, scope) => {
    expr = expr.trim();
    if (expr === 'true') return true; if (expr === 'false') return false; if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
    let v = scope; for (const k of expr.split('.')) { if (v == null) return undefined; v = v[k]; } return v;
  };
  const sub = (s, scope) => s.replace(HOLE, (_, e) => { const v = resolve(e, scope); return v == null ? '' : String(v); });
  const single = (s) => { const m = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/.exec(s); return m ? m[1] : null; };
  function render(node, scope, out) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { out.appendChild(document.createTextNode(sub(child.data, scope))); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.localName;
      if (tag === 'sc-if') { const v = resolve(single(child.getAttribute('value')) || 'false', scope); if (v) render(child, scope, out); continue; }
      if (tag === 'sc-for') { const list = resolve(single(child.getAttribute('list')) || '', scope) || []; const as = child.getAttribute('as'); list.forEach((item, i) => render(child, { ...scope, [as]: item, $index: i }, out)); continue; }
      const el = child.cloneNode(false);
      for (const a of [...el.attributes]) {
        if (!a.value.includes('{{')) continue;
        const one = single(a.value);
        if (/^on/i.test(a.name)) { el.removeAttribute(a.name); const fn = one && resolve(one, scope); if (typeof fn === 'function') el.addEventListener(a.name.slice(2).toLowerCase(), fn); continue; }
        el.setAttribute(a.name, sub(a.value, scope));
      }
      for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
      render(child.localName === 'template' ? child.content : child, scope, el);
      out.appendChild(el);
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    const xdc = document.querySelector('x-dc');
    const script = document.querySelector('script[data-dc-script]');
    const src = xdc.innerHTML; xdc.remove();
    const tpl = document.createElement('template'); tpl.innerHTML = src;
    const helmet = tpl.content.querySelector('helmet');
    if (helmet) { for (const n of [...helmet.childNodes]) document.head.appendChild(n); helmet.remove(); }
    const props = JSON.parse(script.getAttribute('data-props') || '{}');
    const Component = new Function('DCLogic', script.textContent + '\n;return Component;')(DCLogic);
    const inst = new Component(props);
    window.__dc = inst;
    const root = document.createElement('div'); root.id = 'dc-root'; document.body.appendChild(root);
    window.__rerender = () => { const vals = (inst.renderVals ? inst.renderVals() : {}); const frag = document.createDocumentFragment(); render(tpl.content, { ...props, ...vals }, frag); root.replaceChildren(frag); };
    window.__rerender();
    window.__ready = true;
  });
})();
