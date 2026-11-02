// The box itself (shared/page-box.js): its sheets, moving it, and what a real
// window's root does that a box has to do by hand: the scroll handed to <body>
// and back, the page's scroll locks, and things put directly under <html>.
import { BODY_COVER_CSS, BODY_GUARD_CSS, bodyFitCss, bodyHoldCss, boxCss, fittedBody, NO_BOX_CSS, SAID_CSS } from '../../shared/page-box.js';

const DEFAULT_LEFT = 260;
const FRAME = 8;
// After the last move of a drag, the page's own layout follows (sheets.js, a
// resize event): a site's layout at every step of a drag would be too much.
const REST_MS = 150;
// Reading what a page says about <body>: at most this often, twice as far apart
// after each read that found nothing new and back at once after one that did,
// at most 1/MEASURE_SHARE of the time, and never put off for longer than MEASURE_WAIT_MS.
const MEASURE_GAP_MS = 200;
const MEASURE_SHARE = 20;
const MEASURE_WAIT_MS = 1000;
// Readings kept by the attributes of <html> and <body>, for a class that comes
// and goes, and how many first children are followed down for their margins,
// out of how many looked at.
const KNOWN_READINGS = 16;
const CHAIN_DEPTH = 8;
const CHAIN_LOOK = 32;
// What a read looks at, in the names of transitions and of keyframes: on <html>
// and <body>, and on the first children. `font` and `--`: lengths in `em` or
// through a variable move with them.
const READ_PROPERTY = /^(margin|padding|border|box-?sizing|width|min-?width|max-?width|height|font|zoom|--)/i;
const CHAIN_PROPERTY = /^(margin|font|zoom|--)/i;
const INHERITED_INTO = /^(margin|padding|width|min-?width|max-?width|height|min-?height|max-?height)/i;

export function startBox(left = DEFAULT_LEFT, { privateReads: startPrivateReads = false } = {}) {
  let html = document.documentElement; // a page can replace it (rootArrived)
  // Identity-sensitive shims must follow a replacement synchronously, in the
  // same task which installed it. Observer rebinding can wait for rootArrived.
  const liveRoot = () => document.documentElement ?? html;
  let styleRevision = 0;
  // Sheets of the page's own world: `<style>` and style attributes are blocked by strict CSPs.
  const { replaceSync } = CSSStyleSheet.prototype;
  const sheet = () => new CSSStyleSheet();
  const boxSheet = sheet();
  const scrollSheet = sheet(); // how <body> scrolls (checkLocks)
  const guardSheet = sheet(); // min/max height kept through a body read
  const fitSheet = sheet(); // <body>'s size and translated margins (measureBody)
  // WebKit selects this through its transient head attribute. Chromium and a
  // WebKit fallback keep the same sheet disabled and enable it only for a read.
  const holdSheet = sheet();
  const zoomSheet = sheet(); // a pinch (setZoom)
  const readSheet = sheet(); // the permanent, boxless ::backdrop cascade reader
  const coverSheet = sheet(); // hides a never-shown page under Margin's arrival cover
  const ours = [boxSheet, guardSheet, fitSheet, holdSheet, scrollSheet, zoomSheet, readSheet, coverSheet];
  const zoom = { scale: 1, x: 0, y: 0 };
  // The browser's own, from before viewport.js speaks for the box.
  const { matches, getAnimations, getAttribute, setAttribute, removeAttribute } = Element.prototype;
  const { compareDocumentPosition } = Node.prototype;
  const getPriority = CSSStyleDeclaration.prototype.getPropertyPriority;
  const nativeDisabled = Object.getOwnPropertyDescriptor(StyleSheet.prototype, 'disabled');
  const setDisabled = (target, value) => {
    if (nativeDisabled?.set) nativeDisabled.set.call(target, value);
    else target.disabled = value;
  };
  const token = (() => {
    let value = '';
    try { value = crypto.randomUUID(); } catch { value = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`; }
    return String(value).replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'document';
  })();
  // A transient, per-document switch on <head> for WebKit. It preserves the
  // document tree and every structural selector while avoiding WebKit's broad
  // invalidation when a constructed sheet is disabled. Blink takes the fully
  // private sheet path, selected by the generated build bootstrap.
  const readAttribute = `data-margin-read-${token}`;
  let privateReads = startPrivateReads;
  let readMutationRecent = false;
  let readMutationGeneration = 0;
  let lastReactionGeneration = 0;
  let reactionStrikes = 0;
  let readAttributes = '';
  const attributesOf = (node, except = '') => (node ? Array.from(node.attributes, ({ name, value }) => name === except ? '' : `${name}=${value}`).filter(Boolean).join(' ') : '');
  // A selector on <head> can style its following <body>. Keep authored head
  // state in the reading key, but never Margin's one-task transaction token.
  const attributesNow = () => `${attributesOf(html)} ${attributesOf(document.head, readAttribute)} ${attributesOf(document.body)}`;
  function markReadMutation() {
    readAttributes = attributesNow();
    readMutationRecent = true;
    readMutationGeneration++;
  }
  function finishReadMutation() {
    const generation = readMutationGeneration;
    // The first checkpoint delivers the head record; a page observer can
    // create a second MutationObserver delivery. Clear after both, without a
    // timer that a hidden WebKit process may throttle through activation.
    queueMicrotask(() => queueMicrotask(() => {
      if (generation === readMutationGeneration) readMutationRecent = false;
    }));
  }
  function preferPrivateRead(kind = 'attribute') {
    // Mutation records queued before the read can arrive after it. Only a
    // value that differs from the snapshot can be a site's reaction to the
    // transient <head> state; that page switches permanently to private CSSOM
    // reads so it cannot form an observer feedback loop.
    if (!readMutationRecent) return;
    if (attributesNow() !== readAttributes) return setPrivateReads();
    // A head observer can react by adding a child or a body-relevant sheet,
    // without changing head/html/body attributes. One such mutation may be
    // unrelated application work queued before the read, so require it after
    // two consecutive post-load reads. A real observer feedback loop is then
    // bounded to its first two callbacks instead of running at the 1 s cap.
    if (kind !== 'mutation' || document.readyState === 'loading' || lastReactionGeneration === readMutationGeneration) return;
    reactionStrikes = lastReactionGeneration === readMutationGeneration - 1 ? reactionStrikes + 1 : 1;
    lastReactionGeneration = readMutationGeneration;
    if (reactionStrikes >= 2) setPrivateReads();
  }
  const computed = window.getComputedStyle;
  const parseLength = window.CSSNumericValue?.parse; // absent: NaN, and a layout tells (pixels)
  const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  const scrollLeft = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft');
  const scrollOf = (node) => ({ x: scrollLeft.get.call(node), y: scrollTop.get.call(node) });
  function scrollTo(node, { x, y }) {
    if (scrollLeft.get.call(node) !== x) scrollLeft.set.call(node, x);
    if (scrollTop.get.call(node) !== y) scrollTop.set.call(node, y);
  }
  // A page's `scroll-behavior: smooth` would show as a climb from the top.
  const { scrollTo: scrollElement } = Element.prototype;
  function scrollInstantly(node, { x, y }) {
    if (scrollLeft.get.call(node) !== x || scrollTop.get.call(node) !== y) scrollElement.call(node, { left: x, top: y, behavior: 'instant' });
  }
  let refused = false; // a frameset: nothing to scroll, no box

  // `sizes`: the box at rest, as the page's layout knows it. `offset`: where
  // its origin is in the window, and its scale: what coordinates go through.
  const box = {
    on: true,
    left, top: FRAME, right: FRAME, bottom: FRAME,
    dw: left + FRAME, dh: 2 * FRAME,
    scale: 1, x: left, y: FRAME,
    ours,
    readAttribute,
    preferPrivateRead,
    /** The live document root. A page can replace <html> after startup. */
    root: liveRoot,
    body: () => document.body ?? liveRoot(),
    // Full screen is the whole window again, read live: the resize that goes
    // with it can reach a page before `fullscreenchange` does. dw and dh stay
    // what they are, for the box it comes back to.
    boxed: () => box.on && !document.fullscreenElement,
    /** How much smaller than the window the page's world is told it is. */
    seenW: () => (box.boxed() ? box.dw : 0),
    seenH: () => (box.boxed() ? box.dh : 0),
    /** A rectangle in the window, in the page's coordinates (set by coords.js). @type {(rect: any) => any} */
    toPage: (rect) => rect,
    /** Runs at once on every move. @type {((before: { dw: number, dh: number }) => void)[]} */
    onMove: [],
    /** Runs once a move has rested, for the page's own layout. @type {((before: { dw: number, dh: number }) => void)[]} */
    onRest: [],
    /** Runs when the box comes on or goes off. @type {(() => void)[]} */
    onToggle: [],
    /** Runs when a <body> arrives, the first or one the page swapped in. @type {(() => void)[]} */
    onBody: [],
    /** Runs when the document's <html> is replaced. @type {(() => void)[]} */
    onRoot: [],
    /** Runs when the document's adopted sheets are assigned or edited. @type {((root: Document) => void)[]} */
    onAdopted: [],
    /** The page's styles changed: what it says about <body> is read again. */
    bodyMayHaveChanged,
    /** A rule was edited, whether or not it reaches <body> now: it might once a class changes. */
    rulesEdited: () => {
      styleRevision++;
      known.clear();
    },
    /** What a rule has to match to matter to a read: see sheets.js. */
    reachable: () => [liveRoot(), document.body, ...chain.nodes],
    /** Runs after each read of the page. @type {(() => void)[]} */
    onRead: [],
    childrenChanged,
    loaded,
    prepare: prepareBox,
    setCovered,
    set,
  };

  // Never dropped by a page that assigns its own list, or edits the one it has,
  // which goes through a proxy of it, one that lets the page's edits be seen.
  const adopted = Object.getOwnPropertyDescriptor(Document.prototype, 'adoptedStyleSheets');
  const adopt = () => adopted.set.call(document, [...adopted.get.call(document).filter((s) => !ours.includes(s)), ...ours]);
  let adoptDue = false;
  function adoptedChanged() {
    styleRevision++;
    for (const fn of box.onAdopted) fn(document);
    box.bodyMayHaveChanged();
  }
  function adoptedEdited() {
    if (adoptDue) return;
    adoptDue = true;
    queueMicrotask(() => {
      adoptDue = false;
      adopt();
      adoptedChanged();
    });
  }
  const edit = (act) => (...args) => {
    const done = act(...args);
    adoptedEdited();
    return done;
  };
  const adoptedView = new Proxy(adopted.get.call(document), { set: edit(Reflect.set), deleteProperty: edit(Reflect.deleteProperty) });
  Object.defineProperty(document, 'adoptedStyleSheets', {
    configurable: true,
    enumerable: true,
    get() { return adoptedView; },
    set(list) {
      adopted.set.call(this, [...[...list].filter((s) => !ours.includes(s)), ...ours]);
      adoptedChanged();
    },
  });
  let rootZoom = 1; // the page's `zoom` on <html> (readSaid)
  const write = () => replaceSync.call(boxSheet, box.on ? boxCss(box, rootZoom) : NO_BOX_CSS);
  function setRootZoom(next) {
    if (next === rootZoom) return;
    rootZoom = next;
    write();
  }
  write();
  const initialFitCss = bodyFitCss({}, privateReads ? '' : readAttribute);
  const initialHoldCss = bodyHoldCss({}, privateReads ? '' : readAttribute);
  replaceSync.call(guardSheet, BODY_GUARD_CSS);
  replaceSync.call(fitSheet, initialFitCss);
  replaceSync.call(holdSheet, initialHoldCss);
  setDisabled(holdSheet, privateReads);
  replaceSync.call(readSheet, SAID_CSS);
  replaceSync.call(coverSheet, '');
  adopt();

  let pageCovered = false;
  function setCovered(covered) {
    if (covered === pageCovered) return;
    pageCovered = covered;
    replaceSync.call(coverSheet, covered ? BODY_COVER_CSS : '');
  }

  // ---- <body>'s scrolling and the page's locks --------------------------------
  // What the page says about overflow reads back as computed style: html's
  // rule here has no weight (:where), and body's is only added once it says
  // nothing. Read, rather than a sheet taken away to look, which makes a large
  // page lay out again (69 ms on Reddit).
  let scrollCss = '';
  let wasPinned = false;
  // Our rule on each side: what it sets, and whether it has to win.
  const rule = { x: { value: '', said: '', forced: false, force: false }, y: { value: '', said: '', forced: false, force: false } };
  function checkLocks() {
    const { body } = document;
    if (!box.on || !body || body.localName !== 'body') return;
    if (zoom.scale !== 1) return; // a pinch clips <html>: looked at when it ends (setZoom)
    const root = getComputedStyle(html);
    // A lock that pins <body> (fixed, top: -Ypx) can't be read in computed style
    // (the box's rule holds it relative) and doesn't stop <body> scrolling: its
    // style attribute says so, and <body> is locked where it is.
    const pinned = body.style.position === 'fixed' || parseFloat(body.style.top) < 0;
    if (wasPinned && !pinned) { // our lock mustn't read as the page's
      replaceSync.call(scrollSheet, '');
      scrollCss = '';
    }
    wasPinned = pinned;
    const own = getComputedStyle(body);
    // One side's rule. What the page says shows, unless it's our own rule's
    // value, which stands for the page saying nothing. Forced, its value hides
    // what the page says: what it said then stands.
    const side = (mine, shown, rootSays) => {
      const said = mine.forced ? mine.said : mine.value && shown === mine.value ? 'visible' : shown;
      // Nothing said: as <html> says. It locks the window: locked with it.
      if (said === 'visible') Object.assign(mine, { value: rootSays === 'hidden' ? 'hidden' : 'auto', said, forced: mine.force });
      // <html> scrolls and body only clips: in the box, body is what scrolls.
      else if (said === 'hidden' && /auto|scroll/.test(rootSays)) Object.assign(mine, { value: 'auto', said, forced: true });
      else Object.assign(mine, { value: '', said, forced: false, force: false });
      return mine.value && `${mine.value}${mine.forced ? ' !important' : ''}`;
    };
    const y = pinned ? 'hidden !important' : side(rule.y, own.overflowY, root.overflowY);
    const x = side(rule.x, own.overflowX, root.overflowX);
    const parts = [y && `overflow-y: ${y}`, x && `overflow-x: ${x}`].filter(Boolean);
    // No weight, so the page's own rule can be seen; forced, it has to beat
    // even a page's `body { overflow: visible !important }`.
    const forced = pinned || rule.x.forced || rule.y.forced;
    const css = parts.length ? `@media screen { ${forced ? 'html > body:where(:first-of-type)' : ':where(html > body:where(:first-of-type))'} { ${parts.join('; ')} } }` : '';
    if (css !== scrollCss) replaceSync.call(scrollSheet, css);
    scrollCss = css;
    // A page's own `overflow: visible` beats a rule with no weight: said again, to win.
    const after = getComputedStyle(body);
    if (pinned) return;
    const lost = (mine, shown) => !!mine.value && !mine.forced && shown === 'visible';
    if (!lost(rule.y, after.overflowY) && !lost(rule.x, after.overflowX)) return;
    rule.y.force ||= lost(rule.y, after.overflowY);
    rule.x.force ||= lost(rule.x, after.overflowX);
    checkLocks();
  }

  // <body> fills the box and scrolls, so what the page says about its size and
  // margins comes back as a height rule and as padding. To read that, Margin's
  // rules come off <body> for a moment (readWithout). Lengths come from readSaid:
  // style only, so nothing is laid out, nothing scrolls, and it's <body> itself,
  // so `body:has(...)` counts. Numbers come from arithmetic on the box's width.
  // Asking for computed margins or sizes isn't enough for this, in either API:
  // WebKit lays the whole page out for them, at its own height with Margin's
  // rules off. Only what arithmetic can't settle (`fit-content`, a flex or grid
  // <html>) needs that layout (readLaidOut), and only when what's said or the
  // width changed.
  // With no margins at all, what the page sets for its padding stays the page's.
  let padded = false;
  let sized = false;
  let held = false; // a read started transitions in <body>'s descendants once
  let fit = initialFitCss;
  let fitted = { grows: false, column: false };
  let paddingCss = '';
  let bodyCss = initialFitCss;
  let holdCss = initialHoldCss;
  let lastSaid = '';
  let plainPage = true;
  const EDGES = ['Top', 'Right', 'Bottom', 'Left'];
  const SIZES = ['width', 'minWidth', 'maxWidth', 'height'];
  const INLINE_FIT_PROPERTY = /^(?:(?:margin|padding)(?:-|$)|box-sizing$|(?:min-|max-)?(?:width|height|inline-size|block-size)$)/;
  const NOT_IN_FLOW = 'dialog, [popover], :fullscreen';
  // Transitions a browser started for this read, on what inherits from <body>:
  // Chromium styles the whole page for one read, WebKit only what's asked for.
  const pendingOnes = () => document.getAnimations().filter((a) => a.pending && /** @type {any} */ (a).transitionProperty);
  function noticeStarted(before) {
    if (held) return;
    const { body } = document;
    const already = new Set(before);
    held = pendingOnes().some((a) => !already.has(a) && /** @type {any} */ (a.effect).target !== body && INHERITED_INTO.test(/** @type {any} */ (a).transitionProperty));
    if (held) writeBodySheets();
  }
  function controlHead() {
    const head = document.head;
    const body = document.body;
    const precedesBody = head && body && head.parentNode === html && body.parentNode === html
      && !!(compareDocumentPosition.call(head, body) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!privateReads && !precedesBody) setPrivateReads();
    return head;
  }
  // Margin's rules off <body> for one read, and back, then `apply` while it's
  // still held: a change of padding mustn't start a page's transition on it.
  // Styled again in the same step: leaving that to the next paint makes WebKit's
  // next layout ten times as long (8 ms against 72 on 20,000 rows).
  function readWithout(read, keepScroll, apply) {
    const { body } = document;
    const kept = keepScroll ? scrollOf(body) : null; // laid out narrower, it may not scroll as far
    const before = held ? null : pendingOnes();
    const head = controlHead();
    const usePrivate = privateReads;
    const beforeState = usePrivate ? null : getAttribute.call(head, readAttribute);
    let holdEnabled = false;
    let fitDisabled = false;
    let attributeSet = false;
    let mutationMarked = false;
    try {
      if (usePrivate) {
        setDisabled(holdSheet, false);
        holdEnabled = true;
        setDisabled(fitSheet, true);
        fitDisabled = true;
      } else {
        markReadMutation();
        mutationMarked = true;
        attributeSet = true;
        setAttribute.call(head, readAttribute, 'read'); // hold on; fit off
      }
      try {
        read(body);
        if (before) noticeStarted(before);
      } finally {
        if (usePrivate) {
          setDisabled(fitSheet, false);
          fitDisabled = false;
        } else {
          setAttribute.call(head, readAttribute, 'hold'); // fit on; hold stays on
        }
        try {
          if (kept) scrollInstantly(body, kept);
          void computed(body).color;
          // What's new is laid out before <body> is let go, in the one layout it
          // needs anyway: let go first, WebKit keeps its children's old width.
          if (apply()) void scrollLeft.get.call(body);
        } finally {
          if (usePrivate) {
            setDisabled(holdSheet, true);
            holdEnabled = false;
          } else {
            if (beforeState == null) removeAttribute.call(head, readAttribute);
            else setAttribute.call(head, readAttribute, beforeState);
            attributeSet = false;
            finishReadMutation();
            mutationMarked = false;
          }
        }
      }
    } finally {
      // Native CSSOM/layout operations should not throw, but a hostile page or
      // a detached body must never leave Margin's fit off or transitions held.
      if (fitDisabled) try { setDisabled(fitSheet, false); } catch {}
      if (holdEnabled) try { setDisabled(holdSheet, true); } catch {}
      if (attributeSet) try {
        if (beforeState == null) removeAttribute.call(head, readAttribute);
        else setAttribute.call(head, readAttribute, beforeState);
      } catch {}
      if (mutationMarked) finishReadMutation();
    }
  }
  // A length as the page wrote it, in pixels of `whole`: NaN if it takes a
  // layout to know, as `auto` and `fit-content` do.
  function pixels(value, whole) {
    if (value.endsWith('px')) return parseFloat(value);
    if (!value.includes('(')) return value.endsWith('%') ? (parseFloat(value) * whole) / 100 : NaN;
    try { // calc(), min(), clamp(): the browser's own arithmetic, once percents are lengths
      return parseLength(value.replace(/[-+]?[\d.]+(?:e[-+]?\d+)?%/g, (n) => `${(parseFloat(n) * whole) / 100}px`)).to('px').value;
    } catch {
      return NaN;
    }
  }
  const settled = (value) => value === 'auto' || value === 'none' || !Number.isNaN(pixels(value, 0));
  // What <body>'s top margin collapses with, in a window: the first in-flow
  // child's, and that one's first child's while nothing stands between them.
  // Followed (watchChain) so that a class or a new first child is read. `path`:
  // each element the walk left, by going down or to the next one past it. `end`:
  // where it stopped, null if for want of an element.
  /** @type {{ nodes: Element[], tops: string[], path: { node: Element, down: boolean }[], end: Element | null, text: boolean, texts: Text[] }} */
  let chain = { nodes: [], tops: [], path: [], end: null, text: false, texts: [] };
  const textBefore = (parent, node, collected = null) => {
    for (let text = parent.firstChild; text && text !== node; text = text.nextSibling) if (text.nodeType === 3) {
      collected?.add(/** @type {Text} */ (text));
      if (text.data.trim()) return true;
    }
    return false;
  };
  function readChain(body) {
    const nodes = [];
    const tops = [];
    const path = [];
    const texts = new Set();
    let parent = body;
    let node = body.firstElementChild;
    let text = false;
    while (node && nodes.length < CHAIN_DEPTH && path.length < CHAIN_LOOK) {
      if (textBefore(parent, node, texts)) {
        text = true;
        break;
      }
      const style = computed(node);
      if (style.display === 'none' || style.cssFloat !== 'none' || /absolute|fixed/.test(style.position) || matches.call(node, NOT_IN_FLOW)) {
        path.push({ node, down: false });
        node = node.nextElementSibling;
        continue;
      }
      // Layout containment: its margins stay its own, whatever they are.
      if (style.display.startsWith('inline') || /layout|paint|strict|content/.test(style.contain)) break;
      nodes.push(node);
      tops.push(computed(node, '::backdrop').marginTop);
      if (!/^(block|list-item)$/.test(style.display) || !/visible|clip/.test(style.overflowY) || parseFloat(style.paddingTop) || parseFloat(style.borderTopWidth)) break;
      path.push({ node, down: true });
      parent = node;
      node = node.firstElementChild;
    }
    return { nodes, tops, path, end: node, text, texts: [...texts] };
  }
  // A margin collapsed with others, as CSS 2 §8.3.1 adds them up.
  const collapsed = (list) => Math.max(0, ...list) + Math.min(0, ...list);
  function readSaid(body) {
    const style = computed(body);
    const seen = computed(body, '::backdrop');
    const lengths = [...EDGES.map((edge) => seen[`margin${edge}`]), ...EDGES.map((edge) => seen[`padding${edge}`]), ...SIZES.map((size) => seen[size])];
    follow(readChain(body));
    const collapses = chain.tops;
    const zoomed = parseFloat(computed(html).zoom) || 1;
    setRootZoom(zoomed);
    const whole = pixels(computed(html, '::backdrop').width, 0); // the box's width, by its own rule
    // Inline !important is above every author-sheet rule regardless of selector
    // specificity. If it owns body geometry, leave the authored margin/padding
    // in place instead of also translating the same space into Margin padding.
    const inlineLocked = Array.from(body.style).some((name) => INLINE_FIT_PROPERTY.test(name) && getPriority.call(body.style, name) === 'important');
    // A box that doesn't simply fill the width it's given takes a layout to know.
    const block = /^(block|flow-root|flex|grid|list-item)$/.test(style.display) && style.cssFloat === 'none' && style.writingMode === 'horizontal-tb';
    return {
      lengths, collapses, whole, rootZoom: zoomed, inlineLocked,
      // <body>'s margin meets its child's only in a plain block with nothing between them.
      meets: /^(block|list-item)$/.test(style.display) && !parseFloat(style.borderTopWidth),
      zoom: parseFloat(style.zoom) || 1,
      borders: parseFloat(seen.borderLeftWidth) + parseFloat(seen.borderRightWidth),
      boxSizing: seen.boxSizing,
      direction: style.direction,
      column: /flex/.test(style.display) && style.flexDirection.startsWith('column'),
      plain: whole > 0 && computed(html).display === 'block' && block && [...lengths, ...collapses].every(settled),
    };
  }
  // `sized`: its margins or size depend on the box's width.
  function isSized({ lengths }) {
    const [, right, , left, , , , , width, , maxWidth] = lengths;
    return !left.endsWith('px') || !right.endsWith('px') || width !== 'auto' || maxWidth !== 'none' || lengths.slice(0, -1).some((length) => length.includes('%'));
  }
  const growsIn = ({ lengths }) => lengths.at(-1) === 'auto';
  // A margin can't collapse with the first child's as padding does: only what
  // it adds to theirs stays, which can be less than nothing.
  function topMargin(top, { meets, collapses }, padding, width) {
    if (!meets || padding) return top;
    const tops = collapses.map((length) => pixels(length, width) || 0);
    return collapsed([top, ...tops]) - collapsed(tops);
  }
  // The width equation of CSS 2 §10.3.3, for a block in <html>. In <body>'s own
  // pixels: `zoom` scales what it says and the padding that comes back alike.
  function resolve(said) {
    const { lengths, borders, boxSizing, direction, column, zoom } = said;
    const whole = said.whole / zoom;
    const [top, right, bottom, left, ...rest] = lengths.map((length) => pixels(length, whole));
    const paddings = rest.slice(0, 4).map((n) => n || 0);
    const [width, minWidth, maxWidth] = rest.slice(4);
    const extra = paddings[1] + paddings[3] + borders;
    const inner = boxSizing === 'border-box' ? 0 : extra;
    const asked = Number.isNaN(width) ? whole - (left || 0) - (right || 0) : width + inner;
    const used = Math.max(Number.isNaN(maxWidth) ? asked : Math.min(asked, maxWidth + inner), (minWidth || 0) + inner);
    const free = whole - used;
    const margins = [top || 0, right, bottom || 0, left];
    if (Number.isNaN(left) && Number.isNaN(right)) {
      // CSS 2 §10.3.3: auto margins share positive room. If the box is wider
      // than its containing block, the end margin becomes negative instead;
      // clamping it would silently shrink fixed/min-width pages to Margin's box.
      if (free >= 0) margins[1] = margins[3] = free / 2;
      else if (direction === 'rtl') [margins[1], margins[3]] = [0, free];
      else [margins[1], margins[3]] = [free, 0];
    } else if (Number.isNaN(left)) margins[3] = free - right;
    else if (Number.isNaN(right)) margins[1] = free - left;
    else if (direction === 'rtl') margins[3] = free - right;
    else margins[1] = free - left;
    margins[0] = topMargin(margins[0], said, paddings[0], used - extra);
    return { sized: isSized(said), grows: growsIn(said), column, margins, paddings, inlineLocked: said.inlineLocked };
  }
  function readLaidOut(body, said) {
    const style = computed(body);
    const wide = isSized(said);
    const margins = EDGES.map((edge) => parseFloat(style[`margin${edge}`]) || 0);
    const paddings = EDGES.map((edge) => parseFloat(style[`padding${edge}`]) || 0);
    if (wide) {
      // What the page's width leaves over, with margins that don't take it up.
      const borders = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
      const inner = style.boxSizing === 'border-box' ? 0 : paddings[1] + paddings[3] + borders;
      const spare = parseFloat(computed(html).width) / said.zoom - margins[1] - margins[3] - (parseFloat(style.width) || 0) - inner;
      if (spare > 0.5 && style.direction !== 'rtl') margins[1] += spare;
    }
    margins[0] = topMargin(margins[0], said, paddings[0], parseFloat(style.width) || 0);
    return { sized: wide, grows: growsIn(said), column: said.column, margins, paddings, inlineLocked: said.inlineLocked };
  }
  function writeBodySheets() {
    const nextBody = `${fit} ${paddingCss}`;
    if (nextBody !== bodyCss) replaceSync.call(fitSheet, nextBody);
    bodyCss = nextBody;
    const nextHold = bodyHoldCss({ ...fitted, held }, privateReads ? '' : readAttribute);
    if (nextHold !== holdCss) replaceSync.call(holdSheet, nextHold);
    holdCss = nextHold;
  }
  function setPrivateReads() {
    if (privateReads) return;
    privateReads = true;
    // This is a one-way safety switch. Rebuild the normal fit without the
    // <head> gate before future transactions use StyleSheet.disabled.
    setDisabled(holdSheet, true);
    const nextHold = bodyHoldCss({ ...fitted, held });
    if (nextHold !== holdCss) replaceSync.call(holdSheet, nextHold);
    holdCss = nextHold;
    if (!fit) return; // the box is currently off; its next measurement rebuilds it
    fit = bodyFitCss(fitted);
    if (paddingCss) paddingCss = paddingCss.replace(fittedBody(readAttribute), fittedBody());
    writeBodySheets();
  }
  function applyBody({ sized: wide, grows, column, margins, paddings, inlineLocked = false }) {
    sized = wide;
    fitted = { grows, column };
    const control = privateReads ? '' : readAttribute;
    const nextFit = bodyFitCss(fitted, control);
    const refit = nextFit !== fit;
    fit = nextFit;
    padded = !inlineLocked && margins.some(Boolean);
    // Padding can't be negative: what's less than nothing stays a margin.
    const edges = margins.map((n, i) => n + paddings[i]);
    const side = (pick) => edges.map((n) => `${pick(n, 0)}px`).join(' ');
    const padding = !padded ? '' : `@media screen { ${fittedBody(control)} { margin: ${side(Math.min)} !important; padding: ${side(Math.max)} !important; } }`;
    const repadded = padding !== paddingCss;
    paddingCss = padding;
    if (refit || repadded) writeBodySheets();
    return refit || repadded;
  }
  // A length on its way somewhere isn't what the page says: a read during a
  // transition or an animation of one is thrown away and made again as it ends.
  // In the meantime it runs on <body> as it would in a window, unless Margin's
  // rule hides it. With no end to it, what shows now is all there'll ever be.
  let endAwaited = false;
  function movesRead(animation, property) {
    if (animation.playState !== 'running' || !animation.effect || animation.effect.getComputedTiming().endTime === Infinity) return false;
    const named = /** @type {any} */ (animation).transitionProperty;
    return (named ? [named] : /** @type {any} */ (animation.effect).getKeyframes().flatMap(Object.keys)).some((name) => property.test(name));
  }
  function runningOn(body) {
    const on = (node, property) => getAnimations.call(node).filter((a) => movesRead(a, property));
    return [...on(html, READ_PROPERTY), ...on(body, READ_PROPERTY), ...chain.nodes.flatMap((node) => on(node, CHAIN_PROPERTY))];
  }
  function readAfter(animations) {
    if (endAwaited) return;
    endAwaited = true;
    Promise.allSettled(animations.map((a) => a.finished)).then(() => {
      endAwaited = false;
      bodyMayHaveChanged();
    });
  }
  // `again`: what a layout showed before no longer holds, as when the content
  // has grown. A page known to need the layout has it in the same step, so
  // that's one trip with Margin's rules off. Returns whether anything was new.
  function measureBody(again = true) {
    const { body } = document;
    if (!box.on || !body || body.localName !== 'body') return false;
    if (document.fullscreenElement === body) return false; // read as it comes back (fullscreenchange)
    const inOneGo = again && !plainPage;
    let said = null;
    let changed = false;
    let next = null;
    const settle = () => !!next && applyBody(next);
    readWithout((element) => {
      const running = runningOn(element);
      if (running.length) return readAfter(running);
      said = readSaid(element);
      const key = JSON.stringify(said);
      changed = key !== lastSaid;
      lastSaid = key;
      plainPage = said.plain;
      if (said.plain) {
        if (changed) next = resolve(said);
      } else if (inOneGo) {
        next = readLaidOut(element, said);
      }
    }, inOneGo, settle);
    if (!said) return false;
    if (!said.plain && !inOneGo && (changed || again)) readWithout((element) => { next = readLaidOut(element, said); }, true, settle);
    remember(said);
    return changed;
  }

  // What a page has said for these attributes, as long as nothing but the
  // attributes changed: a class that comes and goes costs two reads, and then
  // none. Sheets, rules, the first child, `:has()` or the box's width changing
  // forgets all of it (stale).
  const known = new Map();
  let readAt = { attributes: '', styles: -1, first: /** @type {Element | null} */ (null), stale: true };
  function remember(said) {
    const attributes = attributesNow();
    readAt = { attributes, styles: styleRevision, first: document.body.firstElementChild, stale: false };
    measureSatisfied();
    if (said.plain) {
      if (known.size >= KNOWN_READINGS) known.clear();
      known.set(attributes, { said, key: lastSaid });
    }
    for (const fn of box.onRead) fn();
  }
  function stale() {
    known.clear();
    readAt.stale = true;
    measureGap = MEASURE_GAP_MS;
  }
  function useKnown({ said, key }) {
    const body = document.body;
    if (!body || body.localName !== 'body') {
      bodyArrived();
      return measureBody();
    }
    lastSaid = key;
    readAt.attributes = attributesNow();
    measureSatisfied();
    setRootZoom(said.rootZoom);
    const head = controlHead();
    const usePrivate = privateReads;
    const beforeState = usePrivate ? null : getAttribute.call(head, readAttribute);
    let holdEnabled = false;
    let attributeSet = false;
    let mutationMarked = false;
    try {
      if (usePrivate) {
        setDisabled(holdSheet, false);
        holdEnabled = true;
      } else {
        markReadMutation();
        mutationMarked = true;
        attributeSet = true;
        setAttribute.call(head, readAttribute, 'hold');
      }
      try {
        void computed(body).color;
        if (applyBody(resolve(said))) void scrollLeft.get.call(body);
      } finally {
        if (usePrivate) {
          setDisabled(holdSheet, true);
          holdEnabled = false;
        } else {
          if (beforeState == null) removeAttribute.call(head, readAttribute);
          else setAttribute.call(head, readAttribute, beforeState);
          attributeSet = false;
          finishReadMutation();
          mutationMarked = false;
        }
      }
    } finally {
      if (holdEnabled) try { setDisabled(holdSheet, true); } catch {}
      if (attributeSet) try {
        if (beforeState == null) removeAttribute.call(head, readAttribute);
        else setAttribute.call(head, readAttribute, beforeState);
      } catch {}
      if (mutationMarked) finishReadMutation();
    }
  }
  // At the end of parsing and at `load`: a page that needs a layout always, as
  // its width follows the content, and any other only if something changed.
  const nothingSince = () => !readAt.stale && readAt.attributes === attributesNow() && readAt.first === document.body?.firstElementChild && readAt.styles === styleRevision;
  function loaded() {
    if (!box.on || !document.body) return;
    bodyArrived();
    if (!plainPage || !nothingSince()) measureBody();
    checkLocks();
  }

  // Apps bring their styles after `load`, by a script, so what was read may no
  // longer be what the page says: read again when its styles change, before
  // the next paint. Out of sight it waits to be shown.
  let measureDue = false;
  let measureTimer = 0;
  let measureFrame = 0;
  let measureAt = 0;
  let measureCost = 0;
  let measureGap = MEASURE_GAP_MS;
  function measureSatisfied() {
    measureDue = false;
    clearTimeout(measureTimer);
    measureTimer = 0;
    if (measureFrame) cancelAnimationFrame(measureFrame);
    measureFrame = 0;
  }
  function runMeasure() {
    measureFrame = 0;
    measureDue = false;
    if (nothingSince()) return; // a read came first: the end of parsing, `load`, a moved box
    const reading = known.get(attributesNow());
    if (reading && document.fullscreenElement !== document.body) return useKnown(reading);
    const started = performance.now();
    measureGap = measureBody(false) ? MEASURE_GAP_MS : Math.min(MEASURE_WAIT_MS, measureGap * 2);
    checkLocks();
    measureAt = performance.now();
    measureCost = measureAt - started;
  }
  function measureSoon() {
    if (!box.on || measureFrame) return;
    const reading = known.get(attributesNow());
    if (reading?.key === lastSaid) return; // these attributes say what's already in force
    measureDue = true;
    if (document.hidden) return;
    clearTimeout(measureTimer);
    const wait = reading ? 0 : Math.max(0, measureAt + Math.min(MEASURE_WAIT_MS, Math.max(measureGap, measureCost * MEASURE_SHARE)) - performance.now());
    measureTimer = setTimeout(() => { measureFrame = requestAnimationFrame(runMeasure); }, wait);
  }
  function bodyMayHaveChanged() {
    stale();
    measureSoon();
  }

  // The first children whose margins count: a class on one, or a new one, is
  // looked at once a frame, with no read unless their margins changed. Only
  // attributes are observed on them: what's added and removed already comes
  // to the one observer of the document (sheets.js).
  let chainFrame = 0;
  function readChainChange() {
    chainFrame = 0;
    const { body } = document;
    if (!body || !box.on) return;
    const now = readChain(body);
    const moved = now.tops.join() !== chain.tops.join() || now.nodes.length !== chain.nodes.length || now.nodes.some((node, i) => node !== chain.nodes[i]);
    follow(now);
    const running = runningOn(body); // a margin at the start of its way shows no change yet
    if (running.length) readAfter(running);
    else if (moved) bodyMayHaveChanged();
  }
  function chainTouched() {
    chainFrame ||= requestAnimationFrame(readChainChange);
  }
  const chainWatch = new MutationObserver(chainTouched);
  let chainBody = null;
  const onChain = ({ path, end, texts }) => [...path.map((step) => step.node), ...(end ? [end] : []), ...texts];
  function follow(next) {
    const before = onChain(chain);
    const after = onChain(next);
    const same = after.length === before.length && after.every((node, i) => node === before[i]) && chainBody === document.body;
    chain = next;
    if (same) return;
    chainBody = document.body;
    chainWatch.disconnect();
    for (const node of after) {
      if (node.nodeType === 3) chainWatch.observe(node, { characterData: true });
      else chainWatch.observe(node, { attributes: true });
    }
  }
  // Children came or went somewhere in the page: did they on the chain's walk?
  function childrenChanged() {
    rootArrived();
    const body = document.body;
    if (!body) return;
    /** @type {Element} */
    let parent = body;
    let node = body.firstElementChild;
    for (const { node: step, down } of chain.path) {
      if (textBefore(parent, node)) return chainTouched();
      if (node !== step) return chainTouched();
      if (down) {
        parent = step;
        node = step.firstElementChild;
      } else node = step.nextElementSibling;
    }
    if (node !== chain.end || (!!node && textBefore(parent, node)) !== chain.text) chainTouched();
  }

  // What <html>'s and <body>'s class and style say can lock the page. At most
  // once a frame, and not if neither changed.
  let lockKey = '';
  let lockFrame = 0;
  function readLocks() {
    lockFrame = 0;
    checkLocks();
  }
  const lockChanged = (records = []) => {
    if (records.length && records.every((record) => record.attributeName === readAttribute)) return;
    if (records.length) preferPrivateRead();
    const key = attributesNow();
    if (key === lockKey) return;
    lockKey = key;
    measureSoon(); // any attribute can select what <body>'s size and margins are
    if (lockFrame) return;
    lockFrame = requestAnimationFrame(readLocks);
  };
  const locks = new MutationObserver(lockChanged);
  const LOCK_OPTIONS = { attributes: true };
  function observeLocks() {
    locks.disconnect();
    locks.observe(html, LOCK_OPTIONS);
    const head = document.head;
    if (head) locks.observe(head, LOCK_OPTIONS);
    const { body } = document;
    if (body?.localName === 'body') locks.observe(body, LOCK_OPTIONS);
  }
  observeLocks();

  // An absolute element a page puts directly under <html> is placed against
  // the document, which scrolls: it would stay put here, so it goes in <body>.
  const adoptChild = (node) => {
    if (!box.on || !document.body || node === document.body || node.nodeType !== 1 || node.parentNode !== html) return;
    if (/^(head|body|script|style|link|meta|margin-.*)$/.test(node.localName)) return;
    if (getComputedStyle(node).position === 'absolute') document.body.append(node);
  };
  // The <body> in the page: the first one, or one the page swapped in (Turbo
  // and the like), with a margin and locks of its own.
  let bodyNow = null;
  function bodyArrived() {
    const { body } = document;
    if (!body || body === bodyNow) return;
    if (body.localName !== 'body') { // a frameset
      off();
      refused = true;
      return;
    }
    bodyNow = body;
    observeLocks();
    replaceSync.call(scrollSheet, ''); // what's said about the old one mustn't read as the new one's
    scrollCss = '';
    for (const mine of [rule.x, rule.y]) Object.assign(mine, { value: '', said: '', forced: false, force: false });
    stale();
    measureBody();
    checkLocks();
    for (const fn of box.onBody) fn();
  }
  const children = new MutationObserver((records) => {
    bodyArrived();
    if (!bodyNow) return;
    if (records.length) {
      // The WebKit fit gate requires the live <head> to precede <body>. A
      // removed, reordered or replaced head must switch to the private path
      // before the selector can leave the body unfitted indefinitely.
      controlHead();
      observeLocks();
      // Any direct element can change `head + body`, `body:nth-child(...)`,
      // `:first/last-child`, and similar authored body geometry selectors.
      if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === 1))) bodyMayHaveChanged();
    }
    for (const record of records) for (const node of record.addedNodes) queueMicrotask(() => adoptChild(node));
  });
  const CHILDREN = { childList: true };
  children.observe(html, CHILDREN);
  // A new <html>: `document.write`, `document.open`, a framework that rendered
  // the whole document again. Margin's rules go by selector, so they hold; what
  // was watched on the old one has to be watched on this one.
  function rootArrived() {
    const root = document.documentElement;
    if (!root || root === html) return;
    const sameBody = document.body === bodyNow;
    html = root;
    children.disconnect();
    children.observe(html, CHILDREN);
    controlHead();
    bodyArrived();
    observeLocks();
    if (sameBody) bodyMayHaveChanged();
    for (const fn of box.onRoot) fn();
  }
  // A body sized in percent, or centred, follows the window, at most once a
  // frame. Any other can be crossing a media query or changing with `vw`.
  let resizeFrame = 0;
  function readResize() {
    resizeFrame = 0;
    measureBody();
  }
  addEventListener('resize', (event) => {
    if (!event.isTrusted) return;
    if (!sized) return bodyMayHaveChanged();
    stale();
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(readResize);
  });

  // ---- moving it ---------------------------------------------------------------
  // The page's own layout follows when the box rests, and once it's in sight:
  // a hidden tab catches up as it's shown.
  let restTimer = 0;
  let restFrom = null;
  function rest(afterResize) {
    clearTimeout(restTimer);
    restTimer = 0;
    if (!restFrom) return;
    const before = restFrom;
    restFrom = null;
    for (const fn of box.onRest) fn(before);
    // A page commonly changes classes or installs responsive CSS from its
    // resize listener. Let preparation reconcile those synchronous writes
    // before the one final body measurement and acknowledgement layout.
    dispatchEvent(new Event('resize'));
    afterResize?.();
    stale();
    measureBody(sized); // a media query moved, and a body with auto margins is centred in the new width
    checkLocks();
  }
  function restSoon(before, live) {
    restFrom ??= before;
    clearTimeout(restTimer);
    if (document.hidden) return;
    if (live) restTimer = setTimeout(rest, REST_MS);
    else rest();
  }
  // Flush work which animation frames could not run while this page was
  // hidden. startSheets' capture listener reconciles authored sheets first.
  function prepareBox(afterResize) {
    rootArrived();
    if (!box.on) return true;
    if (resizeFrame) {
      cancelAnimationFrame(resizeFrame);
      // A pending rest below performs the authoritative resize-handler flush
      // and body read. Do not measure the old intermediate geometry first.
      if (restFrom) resizeFrame = 0;
      else readResize();
    }
    if (chainFrame) {
      cancelAnimationFrame(chainFrame);
      readChainChange();
    }
    rest(afterResize);
    if (measureDue) {
      clearTimeout(measureTimer);
      measureTimer = 0;
      if (measureFrame) cancelAnimationFrame(measureFrame);
      measureFrame = 0;
      runMeasure();
    }
    if (lockFrame) {
      cancelAnimationFrame(lockFrame);
      readLocks();
    }
    return !endAwaited && !measureDue;
  }
  document.addEventListener('visibilitychange', () => {
    // A completed hidden read must not make unrelated activation-time author
    // work look like a reaction if this engine delayed its microtasks.
    readMutationRecent = false;
    if (!document.hidden) prepareBox();
  });
  // In and out of full screen, what the page's world is told changes with no
  // move of the box: its media queries and lists follow now, not after a delay.
  document.addEventListener('fullscreenchange', () => {
    if (!box.on) return;
    clearTimeout(restTimer);
    restFrom ??= { dw: box.dw, dh: box.dh };
    rest();
  });

  function on(next, live) {
    const wasOn = box.on;
    rootArrived();
    if (wasOn && next.left === box.left && next.top === box.top && next.right === box.right && next.bottom === box.bottom) return;
    const before = { dw: box.dw, dh: box.dh };
    const scrolled = wasOn ? null : scrollOf(html);
    Object.assign(box, next, { on: true, dw: next.left + next.right, dh: next.top + next.bottom });
    place();
    write();
    if (!wasOn) {
      replaceSync.call(guardSheet, BODY_GUARD_CSS);
      scrollTo(box.body(), scrolled);
      for (const fn of box.onToggle) fn();
    }
    for (const fn of box.onMove) fn(before);
    // A live first move needs a usable body until its final rest. Ordinary
    // enables rest synchronously and therefore take the single final reading.
    if (!wasOn && live) {
      measureBody();
      checkLocks();
    }
    restSoon(before, live);
  }
  function off() {
    if (!box.on) return;
    const before = { dw: box.dw, dh: box.dh };
    const scrolled = scrollOf(box.body());
    setZoom(1, 0, 0);
    Object.assign(box, { on: false, left: 0, top: 0, right: 0, bottom: 0, dw: 0, dh: 0 });
    place();
    write();
    for (const emptied of [guardSheet, fitSheet, scrollSheet]) replaceSync.call(emptied, '');
    if (privateReads) setDisabled(holdSheet, true);
    scrollCss = '';
    fit = '';
    paddingCss = '';
    bodyCss = '';
    lastSaid = '';
    stale();
    for (const mine of [rule.x, rule.y]) Object.assign(mine, { value: '', said: '', forced: false, force: false });
    padded = false;
    scrollTo(html, scrolled);
    for (const fn of box.onToggle) fn();
    for (const fn of box.onMove) fn(before);
    restSoon(before, false);
  }

  // ---- a pinch (content/pinch.js) ---------------------------------------------
  // The page scaled at <html>, so what's fixed scales with it, moved by (x, y)
  // from the box's corner. `will-change` only during a pinch: at rest WebKit
  // draws the page again at the zoom.
  function place() {
    box.x = box.left + zoom.x;
    box.y = box.top + zoom.y;
    box.scale = zoom.scale;
  }
  function setZoom(scale, x, y, moving = false) {
    const ended = zoom.scale !== 1 && scale === 1;
    Object.assign(zoom, { scale, x, y });
    place();
    const transform = `transform: translate(${box.x}px, ${box.y}px) scale(${scale}) !important;`;
    replaceSync.call(zoomSheet, scale === 1 ? '' : `@media screen { html { ${transform} ${moving ? 'will-change: transform !important;' : ''} overflow: clip !important; } }`);
    if (ended) checkLocks();
  }
  place();

  // ---- the bridge ---------------------------------------------------------------
  // Margin's isolated world (content/page-link.js), synchronously: a string in
  // `detail`, or "off". Cancelled to say this world heard it. Kept as it is: an
  // updated Margin talks to a copy of this script still in open pages. A page
  // sending these only moves its own layout.
  function set(message) {
    if (message === 'off') return void off();
    let next;
    try {
      next = JSON.parse(message);
    } catch {
      return;
    }
    if (!(next?.left >= 0) || refused) return;
    on({ left: next.left, top: next.top, right: next.right, bottom: next.bottom }, !!next.live);
    if (next.scale != null) setZoom(next.scale, next.tx ?? 0, next.ty ?? 0, !!next.moving);
  }
  document.addEventListener('margin:box', (event) => {
    event.preventDefault();
    set(/** @type {CustomEvent} */ (event).detail);
  });
  bodyArrived();
  return box;
}
