// The page's style sheets, for the box: media queries about the window's size
// and viewport units are rewritten (shared/page-css.js). Only sheets that
// changed are looked at: one observer on the document, at most one pass a
// frame, and none on a tab out of sight until it's shown.
import { asksSize, hasUnits, shiftQuery, shiftStyle, shiftUnits } from '../../shared/page-css.js';

const SWEEP_FLOOR = 64;
// Reading a sheet's selectors for :has(): slices of about this many ms, this
// many ms apart.
const HAS_SLICE = 4;
const HAS_WAIT = 16;

export function startSheets(box) {
  const ours = new Set(box.ours);
  const sheetProto = CSSStyleSheet.prototype;
  const { insertRule, deleteRule, replace, replaceSync } = sheetProto;
  const { addRule, removeRule } = sheetProto;
  const { matches } = Element.prototype;
  const mediaText = Object.getOwnPropertyDescriptor(MediaList.prototype, 'mediaText');
  const ruleStyle = Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, 'style');
  const selectorText = Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, 'selectorText');
  const seen = new WeakSet();
  let fresh = false; // a sheet of the document's not seen before

  // ---- media queries --------------------------------------------------------
  // Holders (a sheet or a @media rule) whose query has a size in it, with what
  // it's been moved by. Moves go by the difference: a query can't take a
  // variable, and moving one twice would double it.
  /** @type {Map<any, { dw: number, dh: number }>} */
  const moved = new Map();
  // A sheet that left the page, or a rule that left its sheet, goes from the
  // list: when the box rests, and whenever the list has twice as many as after
  // the last sweep (a page that swaps its <style>s and never moves the box).
  const gone = (holder) => {
    const sheet = holder instanceof CSSStyleSheet ? holder : holder.parentStyleSheet;
    return !sheet || (sheet.ownerNode && !sheet.ownerNode.isConnected);
  };
  let sweepAt = SWEEP_FLOOR;
  function moveHolder(holder, dw, dh) {
    const applied = moved.get(holder) ?? { dw: 0, dh: 0 };
    const list = holder.media;
    if (!list) return;
    const text = list.mediaText;
    if (!asksSize(text)) return;
    const next = shiftQuery(text, dw - applied.dw, dh - applied.dh);
    if (next !== text) mediaText.set.call(list, next);
    moved.set(holder, { dw, dh });
    if (moved.size < sweepAt) return;
    for (const held of moved.keys()) if (gone(held)) moved.delete(held);
    sweepAt = Math.max(SWEEP_FLOOR, 2 * moved.size);
  }
  function moveAll(dw, dh) {
    for (const holder of moved.keys()) {
      if (gone(holder)) moved.delete(holder);
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
  // Where a shorthand is taken apart into its longhands (shared/page-css.js), made when first wanted: a rule
  // of a sheet that's never in the page. Not an element's style: on a page with sheets of its own, WebKit does a
  // document's worth of work for each edit of one, in the page or not (GitHub: 620 ms for its 450 rules with
  // units, against 12 here).
  /** @type {CSSStyleDeclaration | undefined} */
  let scratchStyle;
  const scratch = () => {
    if (scratchStyle) return scratchStyle;
    const sheet = new CSSStyleSheet();
    replaceSync.call(sheet, 'margin-scratch {}');
    return (scratchStyle = ruleStyle.get.call(sheet.cssRules[0]));
  };
  // `units`: false where the sheet's text has none, which saves serializing
  // every rule of it just to look. A rule's declarations are serialized, not
  // the rules nested in it (walked on their own), nor its selector (looked
  // through for :has() apart: hasLater).
  function walkRules(rules, units, dw, dh) {
    for (const rule of Array.from(rules)) {
      try {
        if (rule instanceof CSSStyleRule) {
          if (units) {
            const style = ruleStyle.get.call(rule);
            const said = style.cssText;
            if (hasUnits(said)) shiftStyle(style, scratch(), said);
          }
        } else {
          if (rule instanceof CSSMediaRule) moveHolder(rule, dw, dh);
          // @font-face, @page, a keyframe, nested declarations.
          const style = /** @type {any} */ (rule).style;
          const said = units && style ? style.cssText : '';
          if (said && hasUnits(said)) shiftStyle(style, scratch(), said);
          if (/** @type {any} */ (rule).styleSheet) visit(/** @type {any} */ (rule).styleSheet);
        }
        if (/** @type {any} */ (rule).cssRules?.length) walkRules(/** @type {any} */ (rule).cssRules, units, dw, dh);
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
    // Only a <style>'s own text is watched: edits of text elsewhere cost nothing.
    const owner = sheet.ownerNode;
    const inline = owner?.localName === 'style';
    if (inline) watch.observe(owner, STYLE_TEXT);
    const dw = box.seenW();
    const dh = box.seenH();
    try {
      moveHolder(sheet, dw, dh);
    } catch {}
    // A <style>'s text says what's in it, without a walk. Rules added later go
    // through insertRule. A sheet with neither units nor queries has nothing to do.
    const text = inline ? owner.textContent : '';
    const units = !text || hasUnits(text);
    if (units || /@(media|import)/i.test(text)) walkRules(rules, units, dw, dh);
    if (!text) hasLater(rules);
    else if (text.includes(HAS)) collectHas(rules);
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
  // What a rule can do to <body>'s reading: only what applies to <body>, to
  // <html> above it or to the first children, whose margins collapse with it. A
  // rule that matches none of them can't, and is the end of it: a class that
  // makes it match later changes something that's watched. Rules are looked at
  // together once the script's turn is over, when what it did to the page goes
  // with them, in one selector: thousands of them cost one match, and anything
  // that isn't a plain rule, or that a browser won't take, is simply read for.
  const edited = new Set();
  let judging = 0;
  function judge() {
    judging = 0;
    const rules = [...edited];
    edited.clear();
    try {
      if (rules.some((rule) => !(rule instanceof CSSStyleRule) || rule.cssRules?.length)) return box.bodyMayHaveChanged();
      const selector = rules.map((rule) => selectorText.get.call(rule)).join();
      if (box.reachable().some((node) => node && matches.call(node, selector))) box.bodyMayHaveChanged();
    } catch {
      box.bodyMayHaveChanged();
    }
  }
  function ruleChanged(rule) {
    box.rulesEdited();
    edited.add(rule);
    judging ||= setTimeout(judge);
  }
  sheetProto.insertRule = function (rule, index = 0) {
    if (ours.has(this)) return insertRule.call(this, rule, index);
    visit(this);
    const at = insertRule.call(this, typeof rule === 'string' ? shiftUnits(rule) : rule, index);
    trackQueries([this.cssRules[at]]);
    ruleChanged(this.cssRules[at]);
    if (String(rule).includes(HAS)) collectHas([this.cssRules[at]]);
    return at;
  };
  sheetProto.deleteRule = function (index) {
    if (!ours.has(this)) ruleChanged(this.cssRules[index]);
    deleteRule.call(this, index);
  };
  sheetProto.addRule = function (...args) {
    visit(this);
    const at = addRule.apply(this, args);
    noteHas(String(args[0]));
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
    if (String(text).includes(HAS)) collectHas(this.cssRules);
    box.bodyMayHaveChanged();
  };
  sheetProto.replace = function (text) {
    if (ours.has(this)) return replace.call(this, text);
    seen.add(this);
    return replace.call(this, shiftUnits(String(text))).then((sheet) => {
      trackQueries(this.cssRules);
      if (String(text).includes(HAS)) collectHas(this.cssRules);
      box.bodyMayHaveChanged();
      return sheet;
    });
  };
  // Inside a @media or the like.
  const groupProto = CSSGroupingRule.prototype;
  const { insertRule: insertInGroup, deleteRule: deleteFromGroup } = groupProto;
  groupProto.insertRule = function (rule, index = 0) {
    const at = insertInGroup.call(this, rule, index);
    ruleChanged(this.cssRules[at]);
    if (String(rule).includes(HAS)) collectHas([this.cssRules[at]]);
    return at;
  };
  groupProto.deleteRule = function (index) {
    ruleChanged(this.cssRules[index]);
    deleteFromGroup.call(this, index);
  };
  const reread = (proto, name) => {
    const own = Object.getOwnPropertyDescriptor(proto, name);
    Object.defineProperty(proto, name, {
      ...own,
      set(value) {
        own.set.call(this, value);
        if (!ours.has(this)) box.bodyMayHaveChanged();
      },
    });
  };
  for (const proto of [StyleSheet.prototype, HTMLStyleElement.prototype, HTMLLinkElement.prototype]) reread(proto, 'disabled');
  reread(MediaList.prototype, 'mediaText');
  for (const name of ['appendMedium', 'deleteMedium']) {
    const own = MediaList.prototype[name];
    MediaList.prototype[name] = { [name](medium) {
      own.apply(this, arguments);
      box.bodyMayHaveChanged();
    } }[name];
  }
  // A script reaching for a rule's `style` is about to edit it, and an inline
  // style never comes this way, so `element.style` costs nothing. The read comes
  // after the script's turn. A `style` kept and written to much later isn't seen.
  Object.defineProperty(CSSStyleRule.prototype, 'style', {
    ...ruleStyle,
    get() {
      ruleChanged(this);
      return ruleStyle.get.call(this);
    },
    set(value) {
      ruleStyle.set.call(this, value);
      box.bodyMayHaveChanged();
    },
  });
  const styleMap = Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, 'styleMap');
  if (styleMap) {
    Object.defineProperty(CSSStyleRule.prototype, 'styleMap', {
      ...styleMap,
      get() {
        ruleChanged(this);
        return styleMap.get.call(this);
      },
    });
  }
  Object.defineProperty(CSSStyleRule.prototype, 'selectorText', {
    ...selectorText,
    set(value) {
      selectorText.set.call(this, value);
      noteHas(String(value));
      box.bodyMayHaveChanged();
    },
  });

  // ---- :has() ----------------------------------------------------------------
  // A rule on <html> or <body> that says `:has()` turns on with no change to
  // either, or to any sheet. Only such a rule's own selector is asked, once a
  // frame and only on a page that has one: no read unless its answer changed.
  const HAS = ':has(';
  const hasRules = new Set();
  /** @type {string[]} */
  let aboutBody = [];
  let answers = '';
  let hasFrame = 0;
  let watchingHas = false;
  // The selector without its `:has(...)`: does it name <html> or <body> at all?
  function withoutHas(selector) {
    let out = selector;
    for (let at = out.indexOf(HAS); at >= 0; at = out.indexOf(HAS)) {
      let depth = 0;
      let end = at + HAS.length - 1;
      do {
        if (out[end] === '(') depth++;
        else if (out[end] === ')') depth--;
        end++;
      } while (depth && end < out.length);
      out = `${out.slice(0, at)}${/[\w)\]-]$/.test(out.slice(0, at)) ? '' : '*'}${out.slice(end)}`;
    }
    return out;
  }
  // A 1 for each of <html> and <body> that it matches.
  function ask(selector) {
    try {
      return box.reachable().slice(0, 2).map((node) => (node && matches.call(node, selector) ? 1 : 0)).join('');
    } catch {
      return '';
    }
  }
  const answersNow = () => aboutBody.map(ask).join();
  function hasCheck() {
    hasFrame = 0;
    if (answersNow() !== answers) box.bodyMayHaveChanged();
  }
  const hasWatch = new MutationObserver(() => {
    hasFrame ||= requestAnimationFrame(hasCheck);
  });
  function noteHas(selector) {
    if (!selector.includes(HAS) || hasRules.has(selector)) return;
    hasRules.add(selector);
    box.bodyMayHaveChanged();
  }
  // The selectors of a sheet whose text isn't known (a <link>'s, an
  // @import's, an adopted one), looked through after the page's turn, in
  // slices: a selector costs as much to read as a rule's declarations, and
  // load is when a page has least time. A rule already in the sheet applied
  // at the read its sheet brought, so only what it changes later hangs on
  // it; one about <html> or <body> found now is read for, to be sure.
  /** @type {[ArrayLike<CSSRule>, number][]} */
  const unread = [];
  let unreadTask = 0;
  function hasLater(rules) {
    unread.push([Array.from(rules), 0]);
    unreadTask ||= setTimeout(readSelectors, HAS_WAIT);
  }
  function readSelectors() {
    unreadTask = 0;
    const until = performance.now() + HAS_SLICE;
    let about = false;
    while (unread.length) {
      const item = unread[unread.length - 1];
      const [rules] = item;
      if (item[1] >= rules.length) {
        unread.pop();
        continue;
      }
      if (performance.now() > until) {
        unreadTask = setTimeout(readSelectors, HAS_WAIT);
        break;
      }
      // A run of rules between looks at the clock.
      for (const end = Math.min(rules.length, item[1] + 64); item[1] < end; item[1]++) {
        const rule = rules[item[1]];
        try {
          if (rule instanceof CSSStyleRule) {
            const selector = selectorText.get.call(rule);
            if (selector.includes(HAS) && !hasRules.has(selector)) {
              hasRules.add(selector);
              about ||= ask(withoutHas(selector)).includes('1');
            }
          }
          const inner = /** @type {any} */ (rule).cssRules;
          if (inner?.length) unread.push([Array.from(inner), 0]);
        } catch {}
      }
    }
    if (about) box.bodyMayHaveChanged();
  }
  function collectHas(rules) {
    for (const rule of Array.from(rules)) {
      try {
        if (rule instanceof CSSStyleRule) noteHas(selectorText.get.call(rule));
        if (/** @type {any} */ (rule).cssRules?.length) collectHas(/** @type {any} */ (rule).cssRules);
      } catch {}
    }
  }
  box.onRead.push(() => {
    if (!hasRules.size) return;
    aboutBody = [...hasRules].filter((selector) => ask(withoutHas(selector)).includes('1'));
    answers = answersNow();
    const wanted = aboutBody.length > 0;
    if (wanted === watchingHas) return;
    watchingHas = wanted;
    if (wanted) hasWatch.observe(document, { childList: true, subtree: true, attributes: true });
    else hasWatch.disconnect();
  });

  // ---- style attributes ------------------------------------------------------
  const INLINE = '[style*="vw"], [style*="vh"], [style*="vmin"], [style*="vmax"]';
  function shiftInline(node) {
    const { style } = node;
    const said = style?.cssText;
    if (said && hasUnits(said)) shiftStyle(style, scratch(), said);
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
  // Before a read of <body> (box-body.js), the sheets it hasn't seen yet are walked, as a pass would: the read
  // sees their queries and units already the box's, and their edits are styled with it, not after it. WebKit
  // styles the whole page again after any sheet is edited (20,000 rules: about 85 ms), so a walk after the read
  // was a second time. What the read finds needs no read of its own: the count is the read's.
  box.onBeforeRead.push(() => {
    if (!box.on) return;
    visitRoot(document);
    sheetCount = document.styleSheets.length;
  });
  function soon() {
    if (frame || waiting) return;
    if (document.hidden) waiting = true;
    else frame = requestAnimationFrame(pass);
  }
  const isStyle = (node) => node.nodeName === 'STYLE' || node.nodeName === 'style' || node.nodeName === 'LINK';
  function observed(records) {
    if (!box.on) return;
    const hidden = document.hidden;
    let changed = false;
    box.childrenChanged();
    for (const record of records) {
      if (record.type === 'characterData') { // a <style>'s text: a new sheet
        changed = true;
        continue;
      }
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
        if (node.nodeType !== 1 || box.ownFlag(node)) continue;
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
  }
  const watch = new MutationObserver(observed);
  const STYLE_TEXT = { characterData: true, subtree: true };
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
    if (!isStyle(event.target)) return; // a <style> says so too, once its @imports are in
    pass();
    box.bodyMayHaveChanged(); // another origin's sheet can't be read, but it applies
  }, true);
  // Always, hidden or not: a tab loaded behind the page is ready when it's shown.
  document.addEventListener('DOMContentLoaded', () => {
    pass();
    box.loaded();
  });
  addEventListener('load', () => {
    pass();
    box.loaded(); // a site's own reset, late
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && waiting) pass(); });
  box.onMove.push(() => { if (box.on) soon(); });
  addedRoots.add(document.documentElement); // injected late: what's there already
  document.addEventListener('margin:sheets', pass); // content/page-link.js
  pass();
}
