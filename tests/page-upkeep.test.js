// What the page-world box code (content/page/) and the layout
// (content/layout.js) keep, against a small fake of the browser's DOM: style
// reads it doesn't repeat, and entries for what the page let go that don't
// pile up. The fakes are only what these modules touch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- a clock, and WeakRefs whose targets a test lets go ----------------------
let clock = 1000;
Object.defineProperty(globalThis, 'performance', { value: { now: () => clock }, configurable: true, writable: true });
const NativeWeakRef = globalThis.WeakRef;
const refs = { made: [], derefs: 0 };
class FakeRef {
  constructor(target) { this.target = target; this.dead = false; refs.made.push(this); }
  deref() { refs.derefs++; return this.dead ? undefined : this.target; }
}
// Runs `fn` with WeakRef faked: every ref made in it can be let go.
const withRefs = (fn) => {
  globalThis.WeakRef = /** @type {any} */ (FakeRef);
  try {
    return fn();
  } finally {
    globalThis.WeakRef = NativeWeakRef;
  }
};
const letGo = () => { for (const ref of refs.made) ref.dead = true; };
// Timers on that clock: they run when a test moves it on (`wait`).
const timers = new Map();
let timerIds = 0;
globalThis.setTimeout = /** @type {any} */ ((fn, ms = 0) => {
  timers.set(++timerIds, { fn, at: clock + ms });
  return timerIds;
});
globalThis.clearTimeout = /** @type {any} */ ((id) => timers.delete(id));
function wait(ms) {
  const until = clock + ms;
  for (;;) {
    const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    timers.delete(due[0]);
    clock = Math.max(clock, due[1].at);
    due[1].fn();
  }
  clock = until;
}

// ---- the DOM, as far as these modules go ------------------------------------
const styleReads = { count: 0, pseudo: 0 };
const styleOf = new Map(); // node → position
globalThis.getComputedStyle = (node, pseudo) => {
  if (pseudo) {
    styleReads.pseudo++;
    return { content: node.placeholder ? '""' : 'none' };
  }
  styleReads.count++;
  return { position: styleOf.get(node) ?? 'static' };
};
const listeners = () => ({ addEventListener() {}, removeEventListener() {} });
const node = (localName, parentElement = null) => ({ localName, nodeName: localName.toUpperCase(), parentElement, isConnected: true, getRootNode() { return {}; }, dataset: {}, matches: () => false, querySelectorAll: () => [] });
const html = node('html');
const body = node('body', html);
globalThis.window = globalThis;
globalThis.document = /** @type {any} */ ({ ...listeners(), documentElement: html, body, hidden: false, styleSheets: [], adoptedStyleSheets: [] });
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.DOMRect = class { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } };
globalThis.Element = class {};
Element.prototype.matches = () => false;
Element.prototype.attachShadow = () => ({});
// IntersectionObserver: each made one kept, to be fed entries.
const natives = [];
globalThis.IntersectionObserver = class {
  constructor(callback, options) { this.callback = callback; this.options = options; this.thresholds = [0]; natives.push(this); }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
};
globalThis.IntersectionObserverEntry = class {};
for (const name of ['boundingClientRect', 'intersectionRect', 'rootBounds']) {
  Object.defineProperty(IntersectionObserverEntry.prototype, name, { configurable: true, get() { return null; } });
}
// matchMedia: lists that never change.
globalThis.matchMedia = () => ({ matches: false, ...listeners() });
globalThis.MediaQueryList = class {};
globalThis.MediaQueryListEvent = class {};
// Style sheets: a constructed sheet's replaceSync makes one @media rule per
// `@media` in its text, and takes the old ones out (their parentStyleSheet null).
const sheetReads = { parents: 0 };
globalThis.MediaList = class { constructor(text) { this.text = text; } };
Object.defineProperty(MediaList.prototype, 'mediaText', { configurable: true, get() { return this.text; }, set(value) { this.text = value; } });
MediaList.prototype.appendMedium = function appendMedium(medium) {};
MediaList.prototype.deleteMedium = function deleteMedium(medium) {};
globalThis.StyleSheet = class {};
Object.defineProperty(StyleSheet.prototype, 'disabled', { configurable: true, get() { return false; }, set() {} });
globalThis.CSSStyleSheet = class extends StyleSheet {
  constructor() { super(); this.cssRules = []; this.ownerNode = null; this.media = new MediaList(''); }
};
Object.assign(CSSStyleSheet.prototype, {
  insertRule() { return 0; }, deleteRule() {}, addRule() { return 0; }, removeRule() {}, replace: async function () { return this; },
  replaceSync(text) {
    for (const rule of this.cssRules) rule.sheet = null;
    this.cssRules = String(text).split('@media').slice(1).map(() => new CSSMediaRule(this));
  },
});
globalThis.CSSRule = class {};
globalThis.CSSGroupingRule = class extends CSSRule {};
Object.assign(CSSGroupingRule.prototype, { insertRule() { return 0; }, deleteRule() {} });
globalThis.CSSMediaRule = class extends CSSGroupingRule {
  constructor(sheet) { super(); this.sheet = sheet; this.media = new MediaList('(min-width: 600px)'); this.cssRules = []; }
  get parentStyleSheet() { sheetReads.parents++; return this.sheet; }
};
globalThis.CSSStyleRule = class extends CSSRule {};
for (const name of ['style', 'selectorText']) Object.defineProperty(CSSStyleRule.prototype, name, { configurable: true, get() { return ''; }, set() {} });
for (const name of ['HTMLStyleElement', 'HTMLLinkElement']) {
  globalThis[name] = class {};
  Object.defineProperty(globalThis[name].prototype, 'disabled', { configurable: true, get() { return false; }, set() {} });
}

// The box, with its hooks.
const box = {
  on: true, dw: 268, dh: 16, ours: [],
  boxed: () => true, seenW: () => 268, seenH: () => 16, toPage: (rect) => rect,
  onMove: [], onRest: [], onToggle: [], onBody: [], onCatchUp: [], onRead: [],
  bodyMayHaveChanged() {}, rulesEdited() {}, childrenChanged() {}, loaded() {},
  reachable: () => [html, body], ownFlag: () => false,
};
const run = (hooks) => { for (const fn of hooks) fn({ dw: 0, dh: 0 }); };

const { startInView } = await import('../extension/content/page/in-view.js');
const { startMedia } = await import('../extension/content/page/media.js');
const { startSheets } = await import('../extension/content/page/sheets.js');
startInView(box);
startMedia(box);
startSheets(box);

// ---- in-view.js ---------------------------------------------------------------
// A fixed bar of three levels, and an observer of it: <body>'s observer never
// sees it, the window's sees it come and go.
const bar = node('div', body);
const item = node('div', node('div', bar));
styleOf.set(bar, 'fixed');
function watching() {
  const seen = [];
  natives.length = 0;
  const observer = new window.IntersectionObserver((list) => seen.push(...list.map((e) => e.isIntersecting)));
  observer.observe(item);
  const [inWindow] = natives;
  // <body>'s (made again when <body> or the box changes) never sees it.
  const bodyAnswers = () => natives.filter((n) => n.options?.root === body).at(-1).callback([{ target: item, isIntersecting: false, intersectionRatio: 0 }]);
  bodyAnswers();
  let visible = false;
  const toggle = () => {
    visible = !visible;
    inWindow.callback([{ target: item, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }]);
  };
  return { seen, toggle, bodyAnswers };
}

test('in view: whether a target is outside <body> is read once a second, and again once <body> or the box changes', () => {
  const { seen, toggle, bodyAnswers } = watching();
  styleReads.count = 0;
  for (let n = 0; n < 20; n++) toggle(); // ten times in view
  assert.deepEqual(seen.slice(-4), [true, false, true, false], 'the window\'s answers, for what\'s fixed');
  const walk = styleReads.count;
  assert.ok(walk > 0 && walk <= 3, `one walk up the tree (${walk} reads)`);
  clock += 999;
  for (let n = 0; n < 4; n++) toggle();
  assert.equal(styleReads.count, walk, 'none within the second');
  clock += 2;
  toggle();
  assert.equal(styleReads.count, 2 * walk, 'read again after it');
  for (const hooks of [box.onMove, box.onBody, box.onToggle]) {
    const before = styleReads.count;
    toggle();
    toggle();
    assert.equal(styleReads.count, before, 'kept');
    run(hooks);
    bodyAnswers();
    toggle();
    toggle();
    assert.equal(styleReads.count, before + walk, 'read again once the box moved, <body> changed, or the box came on or off');
  }
});

// A video player in the page's flow scrolls up past the box's top edge and
// out of the window, and the site floats it (position: fixed) in a corner,
// all within the second a walk is kept.
test('in view: what turns fixed within the second a walk is kept is heard in view once it runs out', () => {
  const player = node('div', body);
  const seen = [];
  natives.length = 0;
  const observer = new window.IntersectionObserver((list) => seen.push(...list.map((e) => e.isIntersecting)));
  observer.observe(player);
  const [inWindow] = natives;
  const inBody = natives.find((n) => n.options?.root === body);
  inBody.callback([{ target: player, isIntersecting: true, intersectionRatio: 0.5 }]);
  inWindow.callback([{ target: player, isIntersecting: true, intersectionRatio: 0.5 }]);
  // its last pixels in the strip above the box: <body> clips them, the window doesn't
  inBody.callback([{ target: player, isIntersecting: false, intersectionRatio: 0 }]);
  wait(200);
  inWindow.callback([{ target: player, isIntersecting: false, intersectionRatio: 0 }]);
  wait(300);
  styleOf.set(player, 'fixed');
  inWindow.callback([{ target: player, isIntersecting: true, intersectionRatio: 1 }]);
  assert.deepEqual(seen, [true, false], 'the kept walk: still in the flow');
  wait(5000); // nothing crosses a threshold again while it floats
  assert.deepEqual(seen, [true, false, true], 'heard in view once the walk ran out');
  observer.disconnect();
});

test('in view: stand-ins a page dropped are swept as they pile up, not only when the box or <body> changes', () => {
  withRefs(() => {
    refs.made.length = 0;
    for (let n = 0; n < 1000; n++) {
      new window.IntersectionObserver(() => {});
      letGo();
    }
  });
  refs.derefs = 0;
  run(box.onToggle);
  assert.ok(refs.derefs < 130, `the box toggled: only what's left is looked at (${refs.derefs} of 1000)`);
});

// ---- media.js -------------------------------------------------------------------
test('media: lists a page asked for and dropped are swept as they pile up, not only when the box rests', () => {
  withRefs(() => {
    refs.made.length = 0;
    for (let n = 0; n < 1000; n++) {
      window.matchMedia('(min-width: 600px)');
      letGo();
    }
  });
  refs.derefs = 0;
  run(box.onRest);
  assert.ok(refs.derefs < 130, `the box rested: only what's left is looked at (${refs.derefs} of 1000)`);
});

// ---- sheets.js ------------------------------------------------------------------
test('sheets: @media rules a page took out are swept as they pile up, not only when the box rests', () => {
  const sheet = new CSSStyleSheet();
  for (let n = 0; n < 500; n++) sheet.replaceSync('@media (min-width: 600px) {} @media (max-width: 900px) {}');
  assert.equal(sheet.cssRules[0].media.mediaText, '(min-width: 868px)', 'moved for the box');
  sheetReads.parents = 0;
  run(box.onRest);
  assert.ok(sheetReads.parents < 130, `the box rested: only what's left is looked at (${sheetReads.parents} of 1000)`);
  box.seenW = () => 300;
  run(box.onRest);
  box.seenW = () => 268;
  assert.deepEqual(sheet.cssRules.map((rule) => rule.media.mediaText), ['(min-width: 900px)', '(min-width: 900px)'], 'the rules still there still follow the box');
});

// ---- layout.js ----------------------------------------------------------------
test('layout: whether the first-paint placeholder is there is asked once, not on every render; a change of its settings switches it off unasked', async () => {
  const { startLayout } = await import('../extension/content/layout.js');
  let state = { settings: { sidebarPinnedOpen: true } };
  const page = { marks: { dataset: {} }, link: { can: true }, state: () => state, active: () => true, dormant: () => false, setBox() {} };
  const layout = startLayout(/** @type {any} */ (page));
  styleReads.pseudo = 0;
  for (let n = 0; n < 10; n++) layout.settle();
  assert.equal(styleReads.pseudo, 1, 'none here: asked once in ten renders');
  assert.equal(html.dataset.marginDocked, undefined, '<html> untouched');
  clock += 5001;
  layout.settle();
  assert.equal(styleReads.pseudo, 2, 'asked again a while later (registrations that came back late)');
  // Keep open turned off: the frame's placeholder will be registered.
  state = { settings: { sidebarPinnedOpen: false } };
  layout.settle();
  assert.equal(html.dataset.marginDocked, 'off', 'switched off before it arrives');
  assert.equal(styleReads.pseudo, 2, 'without asking');
  // A new <html> (document.open): asked about it, and switched off as it's there.
  const fresh = node('html');
  fresh.placeholder = true;
  document.documentElement = fresh;
  layout.settle();
  layout.settle();
  assert.equal(styleReads.pseudo, 3);
  assert.equal(fresh.dataset.marginDocked, 'off');
});

test('layout: a placeholder registered after the page started is caught when it\'s shown, or once the wait is over on a page in sight', async () => {
  const { startLayout } = await import('../extension/content/layout.js');
  timers.clear();
  const state = { settings: { sidebarPinnedOpen: true } };
  const page = { marks: { dataset: {} }, link: { can: true }, state: () => state, active: () => true, dormant: () => false, setBox() {} };
  const shownOrHidden = [];
  const add = document.addEventListener;
  document.addEventListener = (type, fn) => type === 'visibilitychange' && shownOrHidden.push(fn);
  const layout = startLayout(/** @type {any} */ (page));
  document.addEventListener = add;
  const visibility = (hidden) => {
    document.hidden = hidden;
    for (const fn of shownOrHidden) fn();
  };
  try {
    // A tab restored behind: drawn, then Safari's registrations come back.
    const restored = node('html');
    document.documentElement = restored;
    document.hidden = true;
    styleReads.pseudo = 0;
    layout.settle();
    restored.placeholder = true;
    wait(1000);
    layout.settle();
    assert.equal(styleReads.pseudo, 1, 'hidden: asked once');
    assert.equal(timers.size, 0, 'and not again once the wait is over: the show asks');
    visibility(false); // switched to within the wait
    assert.equal(restored.dataset.marginDocked, 'off', 'shown: asked at once, and switched off');
    // Hidden, then drawn for a switch: asked at that render.
    const prepared = node('html');
    document.documentElement = prepared;
    layout.settle();
    visibility(true);
    prepared.placeholder = true;
    styleReads.pseudo = 0;
    layout.settle();
    layout.settle();
    assert.equal(styleReads.pseudo, 1, 'the first render after it was hidden asks');
    assert.equal(prepared.dataset.marginDocked, 'off');
    // In sight (Margin updated with the tab in front): a render within the
    // wait asks once it's over.
    const inSight = node('html');
    document.documentElement = inSight;
    visibility(false);
    layout.settle();
    inSight.placeholder = true;
    wait(1000);
    styleReads.pseudo = 0;
    layout.settle();
    layout.settle();
    assert.equal(styleReads.pseudo, 0, 'not within the wait');
    wait(4000);
    assert.equal(styleReads.pseudo, 1, 'once it\'s over');
    assert.equal(inSight.dataset.marginDocked, 'off');
  } finally {
    document.hidden = false;
    timers.clear();
  }
});

test('layout: linked, the page\'s box is the app\'s layout for its window (none with nothing at any edge, or out of the way), and left as it is until there is one; not linked, no box', async () => {
  const { startLayout } = await import('../extension/content/layout.js');
  let active = true;
  const boxes = [];
  const page = { marks: { dataset: {} }, link: { can: false }, state: () => null, active: () => active, dormant: () => false, setBox: (box) => boxes.push(box) };
  const layout = startLayout(/** @type {any} */ (page));
  /** @type {any} */
  let geometry = null;
  const at = (left, top, right, bottom) => { geometry = { insets: { left, top, right, bottom }, radius: 6 }; layout.settle(); };
  layout.settle();
  assert.deepEqual(boxes, [null], 'not linked: no box');
  layout.setSource(() => geometry);
  layout.settle();
  assert.equal(boxes.length, 1, 'linked with no layout for the window yet: the box left as it is (the first-paint one)');
  at(260, 8, 8, 8);
  assert.deepEqual(boxes.at(-1), { left: 260, top: 8, right: 8, bottom: 8 });
  assert.equal(page.marks.dataset.box, undefined, 'marks only under a test harness');
  at(0, 0, 0, 0);
  assert.equal(boxes.at(-1), null, 'the whole window: no box');
  at(8, 8, 8, 8);
  active = false;
  layout.settle();
  assert.equal(boxes.at(-1), null, 'out of the way: no box');
  active = true;
  layout.rezoom();
  assert.deepEqual(boxes.at(-1), { left: 8, top: 8, right: 8, bottom: 8 });
  layout.setSource(null);
  layout.settle();
  assert.equal(boxes.at(-1), null, 'the link gone: no box');
});
