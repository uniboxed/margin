// The box itself (shared/page-box.js): its sheets, moving it, and what a real
// window's root does that a box has to do by hand: the scroll handed to <body>
// and back, the page's scroll locks, and things put directly under <html>.
import { bodyFitCss, boxCss, NO_BOX_CSS } from '../../shared/page-box.js';

const DEFAULT_LEFT = 260;
const FRAME = 8;
// After the last move of a drag, the page's own layout follows (sheets.js, a
// resize event): a site's layout at every step of a drag would be too much.
const REST_MS = 150;
// Reading what a page says about <body>: at most this often, at most
// 1/MEASURE_SHARE of the time, and never put off for longer than MEASURE_WAIT_MS.
const MEASURE_GAP_MS = 200;
const MEASURE_SHARE = 20;
const MEASURE_WAIT_MS = 1000;

export function startBox(left = DEFAULT_LEFT) {
  const html = document.documentElement;
  // Sheets of the page's own world: `<style>` and style attributes are blocked by strict CSPs.
  const { replaceSync } = CSSStyleSheet.prototype;
  const sheet = () => new CSSStyleSheet();
  const boxSheet = sheet();
  const scrollSheet = sheet(); // how <body> scrolls (checkLocks)
  const fitSheet = sheet(); // <body>'s size in the box (measureBody)
  const paddingSheet = sheet(); // <body>'s margin as padding (measureBody)
  const zoomSheet = sheet(); // a pinch (setZoom)
  const stillSheet = sheet(); // no transitions while <body> is read (measureBody)
  const ours = [boxSheet, fitSheet, scrollSheet, paddingSheet, zoomSheet, stillSheet];
  const zoom = { scale: 1, x: 0, y: 0 };
  // The browser's own, from before viewport.js speaks for the box.
  const { computedStyleMap, append, remove } = Element.prototype;
  const { createElement } = Document.prototype;
  const computed = window.getComputedStyle;
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
    body: () => document.body ?? html,
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
    /** The page's styles changed: what it says about <body> is read again. */
    bodyMayHaveChanged: measureSoon,
    set,
  };

  // Never dropped by a page that assigns its own list.
  const adopted = Object.getOwnPropertyDescriptor(Document.prototype, 'adoptedStyleSheets');
  const adopt = () => adopted.set.call(document, [...adopted.get.call(document).filter((s) => !ours.includes(s)), ...ours]);
  Object.defineProperty(document, 'adoptedStyleSheets', {
    configurable: true,
    enumerable: true,
    get() { return adopted.get.call(this); },
    set(list) {
      adopted.set.call(this, [...[...list].filter((s) => !ours.includes(s)), ...ours]);
      box.bodyMayHaveChanged();
    },
  });
  const write = () => replaceSync.call(boxSheet, box.on ? boxCss(box) : NO_BOX_CSS);
  write();
  replaceSync.call(fitSheet, bodyFitCss());
  replaceSync.call(stillSheet, 'html > body:where(:first-of-type) { transition: none !important; }');
  stillSheet.disabled = true;
  adopt();

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
  // margins comes back as a height rule and as padding. Two ways to read it.
  // measureBody takes Margin's rules off <body> to look, which sees everything
  // but lays the page out at its own height, which on a page in use loses
  // scroll positions and starts transitions: for when a page loads. After that,
  // remeasure reads a stand-in, an empty <body> after the real one, in and out
  // within this task: the page's rules reach it and Margin's don't
  // (`:first-of-type`), and the real one doesn't move. An empty second <body>
  // can't match `body:has(...)` and the like, so it's only believed if it
  // agreed at load (`trusted`); if not, it only says when to look properly.
  // Computed values (computedStyleMap) need no layout. Only a body whose
  // margins depend on the width needs one, to read them in pixels, and only
  // such a body is measured again when the box or the window changes (`sized`).
  // With no margins at all, what the page sets for its padding stays the page's.
  let padded = false;
  let sized = false;
  let fit = '';
  let paddingCss = '';
  let trusted = false;
  let lastSaid = '';
  const isPixels = (value) => /** @type {any} */ (value)?.unit === 'px';
  const isKeyword = (value, word) => String(value) === word;
  function readBody(element) {
    const said = computedStyleMap.call(element);
    const wide = !isPixels(said.get('margin-left')) || !isPixels(said.get('margin-right')) || !isKeyword(said.get('width'), 'auto') || !isKeyword(said.get('max-width'), 'none');
    const grows = isKeyword(said.get('height'), 'auto');
    const style = computed(element);
    const column = /flex/.test(style.display) && style.flexDirection.startsWith('column');
    const edges = ['Top', 'Right', 'Bottom', 'Left'];
    const margins = edges.map((edge) => parseFloat(style[`margin${edge}`]) || 0);
    const paddings = edges.map((edge) => parseFloat(style[`padding${edge}`]) || 0);
    if (wide) {
      // What the page's width leaves over, with margins that don't take it up.
      const borders = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
      const inner = style.boxSizing === 'border-box' ? 0 : paddings[1] + paddings[3] + borders;
      const spare = parseFloat(computed(html).width) - margins[1] - margins[3] - (parseFloat(style.width) || 0) - inner;
      if (spare > 0.5 && style.direction !== 'rtl') margins[1] += spare;
    }
    // A margin can't collapse with the first child's as padding does: only what
    // it adds to the child's own stays.
    const first = document.body.firstElementChild;
    if (margins[0] && !paddings[0] && first) margins[0] = Math.max(0, margins[0] - (parseFloat(computed(first).marginTop) || 0));
    return { sized: wide, grows, column, margins, paddings };
  }
  function standIn(body) {
    const twin = createElement.call(document, 'body');
    // `on*` on a <body> are the window's handlers. A style attribute is refused
    // by a strict CSP, the same text through the CSSOM isn't.
    for (const { name, value } of Array.from(body.attributes)) {
      if (/^(on|background$|style$)/i.test(name)) continue;
      try {
        twin.setAttribute(name, value);
      } catch {} // the parser keeps names that setAttribute refuses
    }
    twin.style.cssText = body.style.cssText;
    const plain = { position: 'static', float: 'none', visibility: 'hidden', transition: 'none', animation: 'none' };
    for (const [name, value] of Object.entries(plain)) twin.style.setProperty(name, value, 'important');
    return twin;
  }
  // What the stand-in shows, and whether it can stand for <body> at all: in a
  // flex or grid <html> it would be a second item, and with its width from its
  // content it has none.
  function readStandIn(body) {
    const twin = standIn(body);
    try {
      append.call(html, twin);
      const reading = readBody(twin);
      const width = computedStyleMap.call(twin).get('width');
      return { reading, said: JSON.stringify(reading), plain: computed(html).display === 'block' && !/content/.test(String(width)) };
    } finally {
      remove.call(twin);
    }
  }
  function applyBody({ sized: wide, grows, column, margins, paddings }) {
    sized = wide;
    const next = bodyFitCss({ grows, column });
    if (next !== fit) replaceSync.call(fitSheet, next);
    fit = next;
    padded = margins.some(Boolean);
    const padding = !padded ? '' : `@media screen { html > body:where(:first-of-type) { margin: 0 !important; padding: ${margins.map((n, i) => `${n + paddings[i]}px`).join(' ')} !important; } }`;
    if (padding !== paddingCss) replaceSync.call(paddingSheet, padding);
    paddingCss = padding;
  }
  function measureBody() {
    const { body } = document;
    if (!box.on || !body || body.localName !== 'body') return;
    const kept = scrollOf(body); // laid out at its own height, it may not scroll
    stillSheet.disabled = false; // or a read shows a transition's first step
    fitSheet.disabled = paddingSheet.disabled = true;
    const reading = readBody(body);
    fitSheet.disabled = paddingSheet.disabled = false;
    scrollInstantly(body, kept);
    void computed(body).marginLeft; // styled again before transitions are back
    stillSheet.disabled = true;
    applyBody(reading);
    const twin = readStandIn(body);
    lastSaid = twin.said;
    trusted = twin.plain && twin.said === JSON.stringify(reading);
  }
  function remeasure() {
    const { body } = document;
    if (!box.on || !body || body.localName !== 'body') return;
    const twin = readStandIn(body);
    const changed = twin.said !== lastSaid;
    lastSaid = twin.said;
    if (trusted && twin.plain) applyBody(twin.reading);
    else if (changed) measureBody();
  }

  const measureNewWidth = () => (trusted ? remeasure() : measureBody());

  // Apps bring their styles after `load`, by a script, so what was read may no
  // longer be what the page says: read again when its styles change, before
  // the next paint. Out of sight it waits to be shown.
  let measureDue = false;
  let measureTimer = 0;
  let measureAt = 0;
  let measureCost = 0;
  function measureSoon() {
    if (!box.on || measureTimer) return;
    measureDue = true;
    if (document.hidden) return;
    const wait = Math.max(0, measureAt + Math.min(MEASURE_WAIT_MS, Math.max(MEASURE_GAP_MS, measureCost * MEASURE_SHARE)) - performance.now());
    measureTimer = setTimeout(() => requestAnimationFrame(() => {
      measureTimer = 0;
      measureDue = false;
      const started = performance.now();
      remeasure();
      checkLocks();
      measureAt = performance.now();
      measureCost = measureAt - started;
    }), wait);
  }

  // What <html>'s and <body>'s class and style say can lock the page. At most
  // once a frame, and not if neither changed.
  let lockKey = '';
  let lockFrame = 0;
  const attributesOf = (node) => (node ? Array.from(node.attributes, ({ name, value }) => `${name}=${value}`).join(' ') : '');
  const lockChanged = () => {
    const key = `${attributesOf(html)} ${attributesOf(document.body)}`;
    if (key === lockKey) return;
    lockKey = key;
    measureSoon(); // any attribute can select what <body>'s size and margins are
    if (lockFrame) return;
    lockFrame = requestAnimationFrame(() => {
      lockFrame = 0;
      checkLocks();
    });
  };
  const locks = new MutationObserver(lockChanged);
  const LOCK_OPTIONS = { attributes: true };
  locks.observe(html, LOCK_OPTIONS);

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
    locks.observe(body, LOCK_OPTIONS);
    replaceSync.call(scrollSheet, ''); // what's said about the old one mustn't read as the new one's
    scrollCss = '';
    for (const mine of [rule.x, rule.y]) Object.assign(mine, { value: '', said: '', forced: false, force: false });
    measureBody();
    checkLocks();
    for (const fn of box.onBody) fn();
  }
  new MutationObserver((records) => {
    bodyArrived();
    if (!bodyNow) return;
    for (const record of records) for (const node of record.addedNodes) queueMicrotask(() => adoptChild(node));
  }).observe(html, { childList: true });
  document.addEventListener('DOMContentLoaded', () => {
    bodyArrived();
    measureBody();
    checkLocks();
  });
  addEventListener('load', () => {
    measureBody(); // a site's own reset, late
    checkLocks();
  });
  // A body sized in percent, or centred, follows the window. At most once a frame.
  let resizeFrame = 0;
  addEventListener('resize', (event) => {
    if (!sized || !event.isTrusted || resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      measureNewWidth();
    });
  });

  // ---- moving it ---------------------------------------------------------------
  // The page's own layout follows when the box rests, and once it's in sight:
  // a hidden tab catches up as it's shown.
  let restTimer = 0;
  let restFrom = null;
  function rest() {
    clearTimeout(restTimer);
    restTimer = 0;
    if (!restFrom) return;
    const before = restFrom;
    restFrom = null;
    for (const fn of box.onRest) fn(before);
    if (sized) measureNewWidth(); // a body with auto margins is centred in the new width
    dispatchEvent(new Event('resize'));
  }
  function restSoon(before, live) {
    restFrom ??= before;
    clearTimeout(restTimer);
    if (document.hidden) return;
    if (live) restTimer = setTimeout(rest, REST_MS);
    else rest();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    rest();
    if (measureDue) measureSoon();
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
    if (wasOn && next.left === box.left && next.top === box.top && next.right === box.right && next.bottom === box.bottom) return;
    const before = { dw: box.dw, dh: box.dh };
    const scrolled = wasOn ? null : scrollOf(html);
    Object.assign(box, next, { on: true, dw: next.left + next.right, dh: next.top + next.bottom });
    place();
    write();
    if (!wasOn) {
      measureBody();
      checkLocks();
      scrollTo(box.body(), scrolled);
      for (const fn of box.onToggle) fn();
    }
    for (const fn of box.onMove) fn(before);
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
    for (const emptied of [fitSheet, scrollSheet, paddingSheet]) replaceSync.call(emptied, '');
    scrollCss = '';
    fit = '';
    paddingCss = '';
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
