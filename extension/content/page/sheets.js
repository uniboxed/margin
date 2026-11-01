// The page's style sheets, for the box: media queries about the window's size
// and viewport units are rewritten (shared/page-css.js). Only sheets that
// changed are looked at: one observer on the document, at most one pass a
// frame, and none on a tab out of sight until it's shown.
import { asksSize, hasUnits, shiftQuery, shiftUnits } from '../../shared/page-css.js';

export function startSheets(box) {
  const ours = new Set(box.ours);
  const sheetProto = CSSStyleSheet.prototype;
  const { insertRule, deleteRule, replace, replaceSync } = sheetProto;
  const { addRule, removeRule } = sheetProto;
  const seen = new WeakSet();
  let fresh = false; // a sheet of the document's not seen before

  // ---- media queries --------------------------------------------------------
  // Holders (a sheet or a @media rule) whose query has a size in it, with what
  // it's been moved by. Moves go by the difference: a query can't take a
  // variable, and moving one twice would double it.
  /** @type {Map<any, { dw: number, dh: number }>} */
  const moved = new Map();
  function moveHolder(holder, dw, dh) {
    const applied = moved.get(holder) ?? { dw: 0, dh: 0 };
    const list = holder.media;
    if (!list) return;
    const text = list.mediaText;
    if (!asksSize(text)) return;
    const next = shiftQuery(text, dw - applied.dw, dh - applied.dh);
    if (next !== text) list.mediaText = next;
    moved.set(holder, { dw, dh });
  }
  function moveAll(dw, dh) {
    for (const holder of moved.keys()) {
      const sheet = holder instanceof CSSStyleSheet ? holder : holder.parentStyleSheet;
      // A sheet that left the page goes from the list.
      if (!sheet || (sheet.ownerNode && !sheet.ownerNode.isConnected)) moved.delete(holder);
      else {
        try {
          moveHolder(holder, dw, dh);
        } catch {}
      }
    }
  }
  const moveToBox = () => moveAll(box.seenW(), box.seenH());
  box.onRest.push(moveToBox);
  // Paper has no box.
  addEventListener('beforeprint', () => moveAll(0, 0));
  addEventListener('afterprint', moveToBox);

  // ---- walking a sheet ------------------------------------------------------
  // `units`: false where the sheet's text has none, which saves serializing
  // every rule of it just to look.
  function walkRules(rules, units) {
    for (const rule of Array.from(rules)) {
      try {
        if (rule instanceof CSSMediaRule) moveHolder(rule, box.seenW(), box.seenH());
        const { style } = /** @type {any} */ (rule);
        // Over a copy of the names: a property set moves to the end of the live list.
        if (units && style && hasUnits(style.cssText)) {
          for (const name of Array.from(style)) {
            const value = style.getPropertyValue(name);
            const next = shiftUnits(value);
            if (next !== value) style.setProperty(name, next, style.getPropertyPriority(name));
          }
        }
        if (/** @type {any} */ (rule).cssRules?.length) walkRules(/** @type {any} */ (rule).cssRules, units);
        if (/** @type {any} */ (rule).styleSheet) visit(/** @type {any} */ (rule).styleSheet);
      } catch {}
    }
  }
  function visit(sheet) {
    if (!sheet || seen.has(sheet) || ours.has(sheet)) return;
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      return; // another origin's, no CORS: content/page-link.js fetches those
    }
    seen.add(sheet);
    fresh ||= !!sheet.ownerNode; // adopted ones say so as they're set (box.js)
    try {
      moveHolder(sheet, box.seenW(), box.seenH());
    } catch {}
    // A <style>'s text says what's in it, without a walk. Rules added later go
    // through insertRule. A sheet with neither units nor queries has nothing to do.
    const text = sheet.ownerNode?.localName === 'style' ? sheet.ownerNode.textContent : '';
    const units = !text || hasUnits(text);
    if (units || /@(media|import)/i.test(text)) walkRules(rules, units);
  }
  const visitRoot = (root) => {
    for (const sheet of Array.from(root.styleSheets)) visit(sheet);
    for (const sheet of root.adoptedStyleSheets ?? []) visit(sheet);
  };

  // Sheets a script writes: the units in its text, the queries once parsed
  // (they go through the same list as any, to follow the box).
  function trackQueries(rules) {
    for (const rule of Array.from(rules)) {
      try {
        if (rule instanceof CSSMediaRule) moveHolder(rule, box.seenW(), box.seenH());
        if (/** @type {any} */ (rule).cssRules?.length) trackQueries(/** @type {any} */ (rule).cssRules);
      } catch {}
    }
  }
  sheetProto.insertRule = function (rule, index = 0) {
    if (ours.has(this)) return insertRule.call(this, rule, index);
    visit(this);
    const at = insertRule.call(this, typeof rule === 'string' ? shiftUnits(rule) : rule, index);
    trackQueries([this.cssRules[at]]);
    box.bodyMayHaveChanged();
    return at;
  };
  sheetProto.deleteRule = function (index) {
    deleteRule.call(this, index);
    if (!ours.has(this)) box.bodyMayHaveChanged();
  };
  sheetProto.addRule = function (...args) {
    visit(this);
    const at = addRule.apply(this, args);
    box.bodyMayHaveChanged();
    return at;
  };
  sheetProto.removeRule = function (...args) {
    removeRule.apply(this, args);
    box.bodyMayHaveChanged();
  };
  sheetProto.replaceSync = function (text) {
    if (ours.has(this)) return replaceSync.call(this, text);
    seen.add(this);
    replaceSync.call(this, shiftUnits(String(text)));
    trackQueries(this.cssRules);
    box.bodyMayHaveChanged();
  };
  sheetProto.replace = function (text) {
    if (ours.has(this)) return replace.call(this, text);
    seen.add(this);
    return replace.call(this, shiftUnits(String(text))).then((sheet) => {
      trackQueries(this.cssRules);
      box.bodyMayHaveChanged();
      return sheet;
    });
  };

  // ---- style attributes ------------------------------------------------------
  const INLINE = '[style*="vw"], [style*="vh"], [style*="vmin"], [style*="vmax"]';
  function shiftInline(node) {
    const { style } = node;
    if (!style || !hasUnits(style.cssText)) return;
    for (const name of Array.from(style)) {
      const value = style.getPropertyValue(name);
      const next = shiftUnits(value);
      if (next !== value) style.setProperty(name, next, style.getPropertyPriority(name));
    }
  }
  const inlineIn = (root) => {
    if (root.matches?.(INLINE)) shiftInline(root);
    for (const node of root.querySelectorAll?.(INLINE) ?? []) shiftInline(node);
  };

  // ---- what changed -----------------------------------------------------------
  let sheetCount = 0;
  let frame = 0;
  let waiting = false; // for the tab to come into sight
  /** @type {Set<Element | Document | DocumentFragment>} */
  const addedRoots = new Set();
  const dirtyRoots = new Set();
  // Out of sight, what's added isn't kept, however long a chat tab runs: only
  // which root to look through once, when the tab is shown.
  const rescan = new Set();
  const connected = (node) => node === document || node.isConnected;
  function pass() {
    frame = 0;
    waiting = false;
    if (!box.on) return;
    fresh = false;
    visitRoot(document);
    if (fresh || document.styleSheets.length !== sheetCount) box.bodyMayHaveChanged();
    sheetCount = document.styleSheets.length;
    for (const root of dirtyRoots) if (connected(root)) visitRoot(root);
    dirtyRoots.clear();
    for (const root of addedRoots) if (connected(root)) inlineIn(root);
    addedRoots.clear();
    for (const root of rescan) {
      if (!connected(root)) continue;
      inlineIn(root);
      if (root !== document) visitRoot(root);
    }
    rescan.clear();
  }
  function soon() {
    if (frame || waiting) return;
    if (document.hidden) waiting = true;
    else frame = requestAnimationFrame(pass);
  }
  const isStyle = (node) => node.nodeName === 'STYLE' || node.nodeName === 'style' || node.nodeName === 'LINK';
  const watch = new MutationObserver((records) => {
    if (!box.on) return;
    const hidden = document.hidden;
    let changed = false;
    for (const record of records) {
      if (record.type === 'attributes') {
        // A style attribute a script wrote: done here, before it's painted. A
        // record of our own write finds nothing left to rewrite, and animated
        // styles cost one test.
        const target = /** @type {any} */ (record.target);
        if (record.attributeName === 'style') {
          if (hasUnits(target.getAttribute('style') ?? '')) shiftInline(target);
        } else if (isStyle(target)) box.bodyMayHaveChanged();
        continue;
      }
      if (isStyle(record.target)) changed = true;
      let added = false;
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        added = true;
        const element = /** @type {Element} */ (node);
        // Looked through once, from the topmost added.
        if (!hidden && (element.firstElementChild || element.hasAttribute('style')) && !addedRoots.has(/** @type {Element} */ (element.parentNode))) addedRoots.add(element);
        if (isStyle(element)) changed = true;
        // A declarative shadow root the parser has just attached.
        if (element.shadowRoot) watchRoot(element.shadowRoot);
      }
      if (!added) continue;
      const root = record.target.getRootNode();
      if (hidden) rescan.add(root);
      else if (root !== document && root instanceof ShadowRoot) dirtyRoots.add(root);
    }
    if (changed || addedRoots.size || dirtyRoots.size || rescan.size || document.styleSheets.length !== sheetCount) soon();
  });
  const WATCH = { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'media', 'disabled'] };
  const roots = new WeakSet();
  function watchRoot(root) {
    if (roots.has(root)) return;
    roots.add(root);
    watch.observe(root, WATCH);
    dirtyRoots.add(root);
  }
  watch.observe(document, WATCH);
  const { attachShadow } = Element.prototype;
  Element.prototype.attachShadow = function (...args) {
    const root = attachShadow.apply(this, args);
    watchRoot(root);
    return root;
  };

  // A sheet that has just loaded: rewritten before it's painted.
  document.addEventListener('load', (event) => {
    if (/** @type {Element} */ (event.target).nodeName !== 'LINK') return;
    pass();
    box.bodyMayHaveChanged(); // another origin's sheet can't be read, but it applies
  }, true);
  // Always, hidden or not: a tab prepared behind the page is ready when it's shown.
  document.addEventListener('DOMContentLoaded', pass);
  addEventListener('load', pass);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && waiting) pass(); });
  box.onMove.push(() => { if (box.on) soon(); });
  addedRoots.add(document.documentElement); // injected late: what's there already
  document.addEventListener('margin:sheets', pass); // content/page-link.js
  pass();
}
