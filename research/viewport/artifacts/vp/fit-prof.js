// "Keep open": fit the page's window-bound elements into the page card.
//
// The push (content/sidebar.js) moves the page right with a margin on <html>.
// Two kinds of elements are laid out against the window, not the page, and
// Safari gives extensions no way to shrink the window's page area:
//  - position: fixed elements (headers, chat buttons, dialogs, backdrops)
//    stay where they were, partly under the sidebar;
//  - elements as wide as the window (100vw, full-bleed sections) are clipped
//    on the right.
// This re-anchors them to the card. Each one gets a marker attribute
// (data-margin-fit) and its own rule in one adopted stylesheet (an @layer, so
// its !important beats the site's unlayered !important; never inline styles):
//  - fixed: insets and width re-resolved against the card. left: 12px stays
//    12px from the card's edge, right: 0 ends at the card's right edge, 50%
//    is half the card, a window-wide width is the card's width.
//  - full-bleed: sized to the card, its left edge aligned with the card's.
// Left alone (they're already right, or can't be told apart):
//  - fixed elements placed by script (inline left/right/inset: tooltips and
//    menus placed at page coordinates) or by anchor positioning;
//  - fixed elements inside a transformed/filtered/contained ancestor (their
//    containing block is that ancestor, which moves with the page);
//  - full-bleed elements whose width is set inline (sliders sized by script).
// Kept up to date as the page changes: one pass per animation frame, scoped
// to what changed, spaced out when passes get expensive; a full pass on
// resize and new stylesheets. Measured in Chromium and WebKitGTK; see
// DECISIONS.md. Classic script; attaches to globalThis.Margin.fit.

(() => {
  const Margin = (globalThis.Margin ??= {});

  const ATTR = 'data-margin-fit';
  const NONE = [];
  const SLOW_MS = 8; // a pass slower than this spaces the next one out
  const SLOW_WAIT_MS = 250;
  const SETTLE_MS = 200; // full pass after the card width stops changing
  const MAX_SCOPE = 200; // more changed elements than this: one full pass

  // ---- pure geometry (unit-tested) -----------------------------------------

  // A computed inset or width (CSS Typed OM) as p% + px, `{ auto: true }`, or
  // null when it isn't a plain length (anchor(), unparsed): leave it alone.
  // Typed OM's computed values are already absolute (vw/em → px).
  function linear(value) {
    if (value == null) return null;
    if (typeof value.unit === 'string') {
      if (value.unit === 'percent') return { p: value.value, px: 0 };
      if (value.unit === 'px') return { p: 0, px: value.value };
      if (value.unit === 'number') return { n: value.value };
      return null;
    }
    if (typeof value.value === 'string') return value.value === 'auto' ? { auto: true } : null; // keyword
    const parts = value.operator === 'negate' ? [value.value] : value.values ? [...value.values] : null;
    if (!parts) return null;
    const terms = parts.map(linear);
    if (terms.some((t) => t == null || t.auto)) return null;
    if (value.operator === 'negate') {
      const [t] = terms;
      return t.n != null ? { n: -t.n } : { p: -t.p, px: -t.px };
    }
    if (value.operator === 'sum') {
      if (terms.some((t) => t.n != null)) return null;
      return terms.reduce((a, t) => ({ p: a.p + t.p, px: a.px + t.px }), { p: 0, px: 0 });
    }
    if (value.operator === 'product') {
      // lengths times plain numbers: calc(50% * 2), calc(-1 * 10px)
      const lengths = terms.filter((t) => t.n == null);
      if (lengths.length > 1) return null;
      const k = terms.reduce((a, t) => (t.n != null ? a * t.n : a), 1);
      return lengths.length ? { p: lengths[0].p * k, px: lengths[0].px * k } : { n: k };
    }
    return null; // min(), max(), clamp(), invert
  }

  const px = (n) => `${Math.round(n * 100) / 100}px`;
  // As wide as the window: 100vw, or 100% of a fixed element's window.
  const windowWide = (width, view) => Math.abs(width - view.viewport) < 1 || Math.abs(width - view.window) < 1;

  // The card in window coordinates. view: { left, width, right (gap to the
  // window's right edge), viewport (clientWidth), window (innerWidth) }.
  // spec: { left, right, width } from linear(); used: { left, right } from
  // getComputedStyle; borderBox: the layout width (offsetWidth).
  // Returns [property, value] pairs, or [] to leave the element alone.
  function fixedDeclarations({ left, right, width }, used, borderBox, view) {
    if (!left || !right) return NONE;
    if (left.auto && right.auto) return NONE; // static position: already inside the pushed page
    const along = (inset, fallback) => (inset.p != null ? (inset.p / 100) * view.width + inset.px : fallback);
    const out = [];
    if (!left.auto) out.push(['left', px(view.left + along(left, used.left))]);
    if (!right.auto) out.push(['right', px(view.right + along(right, used.right))]);
    if (width && !width.auto && width.n == null) {
      if (width.p) out.push(['width', px((width.p / 100) * view.width + width.px)]);
      else if (windowWide(borderBox, view)) out.push(['width', px(view.width)], ['box-sizing', 'border-box']);
    }
    return out;
  }

  // An in-flow element as wide as the window, wider than the card.
  const isFullBleed = (borderBox, view) => windowWide(borderBox, view) && borderBox > view.width + 1;
  const bleedDeclarations = (view) => [['width', px(view.width)], ['min-width', '0'], ['box-sizing', 'border-box']];
  // Its left edge onto the card's: only by as much as the push could have
  // moved it (a slide further along in a carousel is left where it is).
  function alignDeclarations(rectLeft, marginLeft, view) {
    const shift = view.left - rectLeft;
    if (Math.abs(shift) < 0.5 || Math.abs(shift) > view.window - view.width + 1) return NONE;
    return [['margin-left', px(marginLeft + shift)]];
  }

  // ---- the page -------------------------------------------------------------

  // Containing a fixed descendant: transforms, filters, perspective,
  // paint/layout containment, and will-change of those.
  const containsFixed = (s) =>
    s.transform !== 'none' ||
    (s.translate && s.translate !== 'none') ||
    (s.scale && s.scale !== 'none') ||
    (s.rotate && s.rotate !== 'none') ||
    s.perspective !== 'none' ||
    s.filter !== 'none' ||
    ((s.backdropFilter ?? s.webkitBackdropFilter) || 'none') !== 'none' ||
    /paint|layout|strict|content/.test(s.contain || '') ||
    /transform|translate|scale|rotate|perspective|filter/.test(s.willChange || '');
  const parentOf = (el) => el.parentElement ?? el.parentNode?.host ?? null;
  // `contains` across shadow boundaries.
  const within = (el, root) => {
    for (let a = el; a; a = parentOf(a)) if (a === root) return true;
    return false;
  };
  // In the top layer (modal dialogs, open popovers) the window is always the
  // containing block, whatever the ancestors.
  const inTopLayer = (el) => {
    try {
      return el.matches(':modal, :popover-open');
    } catch {
      return false;
    }
  };

  function createPageFit({ doc = document, win = window, gap = 8 } = {}) {
    const supported =
      typeof win.CSSStyleSheet === 'function' &&
      'adoptedStyleSheets' in doc &&
      typeof win.CSSStyleSheet.prototype.replaceSync === 'function';
    if (!supported) return { apply() {}, stop() {} };
    const typedOM = typeof win.Element.prototype.computedStyleMap === 'function';

    const sheet = new win.CSSStyleSheet();
    let css = null; // the sheet's text, to skip rewriting it unchanged
    // element → { id, fixed, size, align: declarations by kind; spec: what
    // they were computed from, to redo them for another card width }
    const marked = new Map();
    let nextId = 0;
    const roots = new Set(); // document and open shadow roots the sheet is in
    let left = null; // the card's left edge (sidebar width) while on
    let observer = null;
    let pending = null; // Set of changed elements, or 'all'
    let frame = null;
    let wait = null;
    let settle = null;
    let lastCost = 0;

    const view = () => {
      const viewport = doc.documentElement.clientWidth;
      return { left, width: Math.max(0, viewport - left - gap), right: gap, viewport, window: win.innerWidth };
    };

    function entry(el) {
      let m = marked.get(el);
      if (!m) {
        // The attribute is set by write(): setting it mid-walk would make
        // the next read restyle and lay out again.
        m = { id: String(++nextId), fixed: NONE, size: NONE, align: NONE, spec: null, attached: false };
        marked.set(el, m);
      }
      return m;
    }
    const clear = (m) => {
      const had = m.fixed.length + m.size.length + m.align.length > 0;
      m.fixed = m.size = m.align = NONE;
      m.spec = null;
      return had;
    };
    // Rewriting the sheet restyles the whole page (WebKit: ~30ms at 15k
    // elements), so it's skipped when nothing changed. Elements that need
    // nothing any more lose their attribute only when `prune`, so the page's
    // own observers don't see it come and go while a pass re-measures.
    function write(prune = false) {
      let text = '';
      for (const [el, m] of marked) {
        const decls = [...m.fixed, ...m.size, ...m.align];
        if (!el.isConnected || (prune && !decls.length)) {
          if (el.isConnected && m.attached) el.removeAttribute(ATTR);
          marked.delete(el);
          continue;
        }
        if (decls.length && !m.attached) {
          el.setAttribute(ATTR, m.id);
          m.attached = true;
        }
        if (decls.length) text += `[${ATTR}="${m.id}"] { ${decls.map(([p, v]) => `${p}: ${v} !important`).join('; ')} }\n`;
      }
      if (text === css) return;
      css = text;
      sheet.replaceSync(`@layer margin-fit { @media screen {\n${text}} }`);
    }

    function adopt(root) {
      if (roots.has(root) && root.adoptedStyleSheets.includes(sheet)) return;
      roots.add(root);
      if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      if (root !== doc) observer?.observe(root, OBSERVE);
    }

    // Every element under `scope`, open shadow roots included, skipping
    // Margin's own hosts. `visit(el, inherited)` returns false to skip the
    // element's subtree, or true to pass `inherited = true` to it.
    function each(scope, visit) {
      const stack = scope.map((el) => [el, false]);
      while (stack.length) {
        const [el, inherited] = stack.pop();
        if (el.localName.startsWith('margin-')) continue;
        const result = visit(el, inherited);
        if (result === false) continue;
        const flag = inherited || result === true;
        if (el.shadowRoot) {
          adopt(el.shadowRoot);
          for (let c = el.shadowRoot.lastElementChild; c; c = c.previousElementSibling) stack.push([c, flag]);
        }
        for (let c = el.lastElementChild; c; c = c.previousElementSibling) stack.push([c, flag]);
      }
    }

    // The fixed element's spec, or null to leave it alone.
    function fixedSpec(el, cs) {
      if (!typedOM) return null;
      const s = el.style;
      if (s.left || s.right || s.inset) return null; // placed by script
      if (!inTopLayer(el)) {
        for (let a = parentOf(el); a && a !== doc.documentElement; a = parentOf(a)) {
          if (containsFixed(win.getComputedStyle(a))) return null;
        }
      }
      const map = el.computedStyleMap();
      return {
        kind: 'fixed',
        insets: { left: linear(map.get('left')), right: linear(map.get('right')), width: linear(map.get('width')) },
        used: { left: parseFloat(cs.left), right: parseFloat(cs.right) },
        borderBox: el.offsetWidth,
      };
    }
    const fixedFrom = (spec, v) => fixedDeclarations(spec.insets, spec.used, spec.borderBox, v);

    // A full-bleed element's left edge doesn't depend on its own width when
    // it's an ordinary block (not transformed, offset or flex/grid-aligned):
    // it can be aligned from the same measurement, without another layout.
    function widthIndependent(el, cs) {
      if (cs.position !== 'static' || cs.transform !== 'none' || (cs.translate && cs.translate !== 'none')) return false;
      if (!/^(block|flow-root|list-item|table)$/.test(cs.display)) return false;
      const parent = parentOf(el);
      return !parent || !/flex|grid/.test(win.getComputedStyle(parent).display);
    }
    function alignBleeds(list, v) {
      if (!list.length) return;
      write();
      for (const el of list) entry(el).align = alignDeclarations(el.getBoundingClientRect().left, parseFloat(win.getComputedStyle(el).marginLeft), v);
    }

    // One pass over `scope` (elements), or the whole page (null). Reads
    // everything in one walk, then writes the sheet once (twice when a
    // full-bleed element can only be aligned after it's been resized).
    function refit(scope) {
      const start = performance.now();
      if (!doc.documentElement) return;
      adopt(doc);
      // Natural values: this scope's rules off while measuring.
      let had = false;
      for (const [el, m] of marked) if (!scope || scope.some((r) => within(el, r))) had = clear(m) || had;
      if (had) write();
      globalThis.T={};let t=performance.now();const v = view();
      // Full-bleed elements only exist when something overflows the card.
      const overflow = doc.documentElement.scrollWidth > v.viewport + 1;
      const later = [];T.pre=performance.now()-t;t=performance.now();
      // inherited: inside a fixed or full-bleed element (no full-bleed
      // checks: they're fitted with it); fixed descendants still are.
      each(scope ?? [doc.documentElement], (el, inherited) => {
        const cs = win.getComputedStyle(el);
        if (cs.display === 'none') return false;
        if (cs.position === 'fixed') {
          const spec = fixedSpec(el, cs);
          const decls = spec ? fixedFrom(spec, v) : NONE;
          if (decls.length) Object.assign(entry(el), { fixed: decls, spec });
          return true;
        }
        if (!overflow || inherited || el === doc.body || !(el instanceof win.HTMLElement)) return;
        if (!isFullBleed(el.offsetWidth, v) || el.style.width || el.style.minWidth) return;
        const m = entry(el);
        m.size = bleedDeclarations(v);
        m.spec = { kind: 'bleed' };
        if (widthIndependent(el, cs)) m.align = alignDeclarations(el.getBoundingClientRect().left, parseFloat(cs.marginLeft), v);
        else later.push(el);
        return true;
      });
      T.walk=performance.now()-t;t=performance.now();alignBleeds(later, v);T.align=performance.now()-t;t=performance.now();
      write(true);document.body.offsetWidth;T.write=performance.now()-t;T.later=later.length;
      lastCost = performance.now() - start;
    }

    // The sidebar is being resized: redo the known elements' rules for the
    // new card without re-measuring them (full-bleed ones are re-aligned).
    function resize() {
      const v = view();
      const bleeds = [];
      for (const [el, m] of marked) {
        if (!el.isConnected) continue;
        if (m.spec?.kind === 'fixed') m.fixed = fixedFrom(m.spec, v);
        if (m.spec?.kind === 'bleed') {
          m.size = bleedDeclarations(v);
          m.align = NONE;
          bleeds.push(el);
        }
      }
      alignBleeds(bleeds, v);
      write();
    }

    // ---- staying up to date ---------------------------------------------------

    function run() {
      frame = null;
      const scope = pending;
      pending = null;
      if (left == null || !scope) return;
      if (scope === 'all' || scope.size > MAX_SCOPE) return refit(null);
      // Outermost changed elements only.
      const list = [...scope].filter((el) => el.isConnected);
      const outer = list.filter((el) => !list.some((o) => o !== el && within(el, o)));
      if (outer.length) refit(outer);
    }
    function queue(target) {
      if (left == null) return;
      if (target === 'all' || pending === 'all') pending = 'all';
      else (pending ??= new Set()).add(target);
      if (frame != null || wait != null) return;
      const go = () => {
        wait = null;
        frame = win.requestAnimationFrame(run);
      };
      if (lastCost > SLOW_MS) wait = setTimeout(go, SLOW_WAIT_MS);
      else go();
    }

    const OBSERVE = { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] };
    const isStylesheet = (n) => n.localName === 'style' || (n.localName === 'link' && /\bstylesheet\b/i.test(n.rel));
    function onMutations(records) {
      for (const r of records) {
        if (r.type === 'attributes') {
          queue(r.target);
          continue;
        }
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (isStylesheet(n)) queue('all');
          else if (!n.localName.startsWith('margin-')) queue(n);
        }
      }
    }
    const onResize = () => queue('all');
    const onLoad = (e) => {
      if (e.target?.localName === 'link') queue('all');
    };

    return {
      // Fit to a card starting at `width` (the sidebar's width). Synchronous,
      // so the frame that pushes the page is already fitted.
      apply(width) {
        if (width === left) return;
        const first = left == null;
        left = width;
        if (first) {
          observer = new win.MutationObserver(onMutations);
          observer.observe(doc, OBSERVE);
          for (const root of roots) if (root !== doc) observer.observe(root, OBSERVE);
          win.addEventListener('resize', onResize);
          doc.addEventListener('load', onLoad, true);
          return refit(null);
        }
        // Resizing the sidebar: redo what's known now, then one full pass
        // once the width settles.
        resize();
        clearTimeout(settle);
        settle = setTimeout(() => queue('all'), SETTLE_MS);
      },
      // Back to the page as it was: no rules, no attributes, no observers.
      stop() {
        if (left == null) return;
        left = null;
        observer?.disconnect();
        observer = null;
        win.removeEventListener('resize', onResize);
        doc.removeEventListener('load', onLoad, true);
        if (frame != null) win.cancelAnimationFrame(frame);
        clearTimeout(wait);
        clearTimeout(settle);
        frame = wait = settle = null;
        pending = null;
        for (const [el, m] of marked) if (m.attached) el.removeAttribute(ATTR);
        marked.clear();
        sheet.replaceSync('');
        css = null;
        for (const root of roots) root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
        roots.clear();
      },
    };
  }

  Margin.fit = { createPageFit, linear, fixedDeclarations, isFullBleed, bleedDeclarations, alignDeclarations, ATTR };
})();
