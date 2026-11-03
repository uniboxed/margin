// What's on its way on the elements a read of <body> looks at
// (content/page/moves.js), known from the page's transition and animation
// events, and never from asking the document for its animations: WebKit's
// sort of them crashed pages in Safari (2026-11-02).
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let clock = 1000;
Object.defineProperty(globalThis, 'performance', { value: { now: () => clock }, configurable: true, writable: true });
globalThis.CSSKeyframesRule = /** @type {any} */ (class { constructor(name, frames) { this.name = name; this.cssRules = frames.map((style) => ({ style })); } });
globalThis.CSSImportRule = /** @type {any} */ (class { constructor(sheet) { this._sheet = sheet; } get styleSheet() { return this._sheet; } });
// Frames by hand: `frame()` runs what's waiting for the next one.
let frames = new Map();
let frameId = 0;
globalThis.requestAnimationFrame = /** @type {any} */ ((fn) => { frames.set(++frameId, fn); return frameId; });
globalThis.cancelAnimationFrame = /** @type {any} */ ((id) => { frames.delete(id); });
const frame = () => { const due = frames; frames = new Map(); for (const fn of due.values()) fn(); };
const { KEYFRAMES_KEEP_MS, MOVE_CAP_MS, SETTLE_MS, SETTLE_TRIES, keyframesIn, startMoves } = await import('../extension/content/page/moves.js');

const READ = /^(margin|padding|width|font|--)/i;
const CHAIN = /^(margin|font|--)/i;
const node = (name) => ({ name, isConnected: true });
const html = node('html');
const body = node('body');
const first = node('h1');
const other = node('div');

function setUp({ keyframes = () => null, styles = new Map(), looked = new Map(), near } = {}) {
  const handlers = {};
  const on = { addEventListener: (type, fn, capture) => { assert.equal(capture, true, 'before the page\'s own listeners'); handlers[type] = fn; } };
  const calls = { ended: 0, settled: 0, echoed: [] };
  const moves = startMoves({
    names: (n) => (n === html || n === body ? READ : n === first ? CHAIN : looked.get(n) ?? null),
    near,
    ended: () => calls.ended++,
    settle: () => calls.settled++,
    styleOf: (n) => styles.get(n) ?? { animationName: 'none', animationIterationCount: '1', animationPlayState: 'running' },
    keyframes,
    echoed: (event) => calls.echoed.push(`${event.type} ${event.pseudoElement}${event.propertyName}`),
  }, /** @type {any} */ (on));
  const fire = (type, target, more = {}) => handlers[type]({ type, target, isTrusted: true, pseudoElement: '', ...more });
  const transition = (type, target, propertyName, more) => fire(type, target, { propertyName, ...more });
  const animation = (type, target, animationName, more) => fire(type, target, { animationName, ...more });
  return { moves, calls, transition, animation, handlers };
}

test('moves: no code of Margin\'s asks for animations, the document\'s or an element\'s', () => {
  const root = new URL('../extension/', import.meta.url).pathname;
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(js|mjs|html)$/.test(name)) files.push(path);
    }
  };
  walk(root);
  assert.ok(files.length > 20);
  // Code, not the comments that say why.
  const code = (path) => readFileSync(path, 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  const asking = files.filter((path) => /getAnimations/.test(code(path)));
  assert.deepEqual(asking, [], 'WebKit sorts every animation of the document for either (Document::matchingAnimations)');
});

test('moves: a transition of a length on <body> holds reads back until it ends, and a read follows once it has', () => {
  const { moves, calls, transition } = setUp();
  assert.equal(moves.moving(), false);
  transition('transitionrun', body, 'margin-left');
  assert.equal(moves.moving(), true, 'a read now would find it on its way');
  transition('transitionend', body, 'margin-right');
  assert.equal(moves.moving(), true, 'another property\'s end');
  assert.equal(calls.ended, 0);
  transition('transitionend', body, 'margin-left');
  assert.equal(moves.moving(), false);
  assert.equal(calls.ended, 1, 'read again as it ends');
  transition('transitionend', body, 'margin-left');
  assert.equal(calls.ended, 1, 'once');
});

test('moves: one heard after a read is read again as it ends; one let go before a read isn\'t', () => {
  const { moves, calls, transition } = setUp();
  moves.read(); // the read came first, in the frame before its event
  transition('transitionrun', html, 'font-size');
  transition('transitioncancel', html, 'font-size');
  assert.equal(calls.ended, 1, 'the read may have caught it on its way');
  const gone = node('body');
  const handlers = {};
  let ended = 0;
  const kept = startMoves({ names: (n) => (n === gone ? READ : null), ended: () => ended++, styleOf: () => ({}), keyframes: () => null }, /** @type {any} */ ({ addEventListener: (type, fn) => { handlers[type] = fn; } }));
  handlers.transitionrun({ type: 'transitionrun', target: gone, propertyName: 'width', isTrusted: true, pseudoElement: '' });
  gone.isConnected = false;
  assert.equal(kept.moving(), false);
  kept.read(); // made with nothing on its way
  handlers.transitionend({ type: 'transitionend', target: other, propertyName: 'width', isTrusted: true, pseudoElement: '' });
  assert.equal(ended, 0, 'nothing owed: another element\'s end reads nothing');
});

test('moves: what a read doesn\'t look at never holds it back', () => {
  const { moves, calls, transition } = setUp();
  transition('transitionrun', body, 'color');
  transition('transitionrun', other, 'margin-left'); // not <html>, <body> or a first child
  transition('transitionrun', first, 'padding-left'); // a first child's padding: not what collapses
  transition('transitionrun', body, 'margin-left', { pseudoElement: '::before' });
  transition('transitionrun', body, 'margin-left', { isTrusted: false }); // a page's own event
  assert.equal(moves.moving(), false);
  transition('transitionrun', first, 'margin-top');
  assert.equal(moves.moving(), true, 'a first child\'s margin is');
  transition('transitionend', first, 'margin-top', { isTrusted: false });
  assert.equal(moves.moving(), true, 'a page\'s own end event isn\'t believed');
  transition('transitioncancel', first, 'margin-top');
  assert.equal(moves.moving(), false);
  assert.equal(calls.ended, 1);
});

test('moves: an animation counts if it ends, runs and moves a length, by its @keyframes', () => {
  const frames = { slide: ['margin-left', 'opacity'], fade: ['opacity'] };
  const styles = new Map();
  const { moves, animation } = setUp({ keyframes: (name) => frames[name] ?? null, styles });
  styles.set(body, { animationName: 'fade, slide', animationIterationCount: '1', animationPlayState: 'running' });
  animation('animationstart', body, 'fade');
  assert.equal(moves.moving(), false, 'its keyframes move no length');
  animation('animationstart', body, 'slide');
  assert.equal(moves.moving(), true);
  animation('animationend', body, 'slide');
  assert.equal(moves.moving(), false);
  styles.set(body, { animationName: 'slide', animationIterationCount: 'infinite', animationPlayState: 'running' });
  animation('animationstart', body, 'slide');
  assert.equal(moves.moving(), false, 'with no end, what shows now is all there\'ll be');
  styles.set(body, { animationName: 'fade, slide', animationIterationCount: '1, 2', animationPlayState: 'running, paused' });
  animation('animationstart', body, 'slide');
  assert.equal(moves.moving(), false, 'paused');
  styles.set(body, { animationName: 'gone', animationIterationCount: '3', animationPlayState: 'running' });
  animation('animationstart', body, 'gone');
  assert.equal(moves.moving(), true, 'keyframes in no sheet the page can read: taken as moving a length');
  animation('animationcancel', body, 'gone');
  assert.equal(moves.moving(), false);
});

test('moves: what a @keyframes sets is found once for a run of reads (every sheet\'s every rule walked for it), and again once that\'s 2 s old', () => {
  const asked = [];
  const { moves, animation } = setUp({ keyframes: (name) => { asked.push(name); return ['opacity']; }, styles: new Map([[body, { animationName: 'fade', animationIterationCount: '1', animationPlayState: 'running' }]]) });
  animation('animationstart', body, 'fade');
  for (let i = 0; i < 20; i++) {
    assert.equal(moves.moving(), false);
    clock += 16; // a read tried every frame
  }
  assert.deepEqual(asked, ['fade']);
  clock += KEYFRAMES_KEEP_MS;
  assert.equal(moves.moving(), false);
  assert.deepEqual(asked, ['fade', 'fade']);
  animation('animationend', body, 'fade');
});

test('moves: one whose element left the page, or isn\'t looked at any more, or never ended, stops holding reads back', () => {
  const { moves, transition } = setUp();
  const swapped = node('body');
  const looked = new Set([swapped]);
  const handlers = {};
  const kept = startMoves({ names: (n) => (looked.has(n) ? READ : null), ended() {}, styleOf: () => ({}), keyframes: () => null }, /** @type {any} */ ({ addEventListener: (type, fn) => { handlers[type] = fn; } }));
  handlers.transitionrun({ type: 'transitionrun', target: swapped, propertyName: 'width', isTrusted: true, pseudoElement: '' });
  assert.equal(kept.moving(), true);
  swapped.isConnected = false; // a <body> swapped for another (Turbo): no end comes to the window
  assert.equal(kept.moving(), false);
  swapped.isConnected = true;
  handlers.transitionrun({ type: 'transitionrun', target: swapped, propertyName: 'width', isTrusted: true, pseudoElement: '' });
  looked.delete(swapped);
  assert.equal(kept.moving(), false, 'no longer a first child');
  transition('transitionrun', body, 'width');
  clock += MOVE_CAP_MS - 1;
  assert.equal(moves.moving(), true);
  clock += 1;
  assert.equal(moves.moving(), false, 'an end that never came');
});

test('moves: a first child that has just come holds the read back from its first start, though the first children weren\'t looked at since', () => {
  // A banner put first in <body> in a frame's callbacks starts moving in the
  // next frame's events, before the look at the first children that finds it.
  const banner = node('div');
  const looked = new Map();
  const styles = new Map([[banner, { animationName: 'drop', animationIterationCount: '1', animationPlayState: 'running' }]]);
  const { moves, calls, animation, transition } = setUp({ looked, styles, near: (n) => n === banner || n === first || n === body || n === html });
  animation('animationstart', banner, 'drop');
  assert.equal(moves.moving(), false, 'not a first child yet');
  looked.set(banner, CHAIN); // found
  assert.equal(moves.moving(), true, 'its margin is on its way');
  animation('animationend', banner, 'drop');
  assert.equal(calls.ended, 1, 'read again as it ends');
  // Found by a read itself, made before it was a first child.
  const late = node('div');
  const { moves: other, calls: told, transition: fire } = setUp({ looked, near: (n) => n === late });
  fire('transitionrun', late, 'margin-top');
  assert.equal(other.moving(), false);
  other.read();
  looked.set(late, CHAIN);
  fire('transitionend', late, 'margin-top', { elapsedTime: 0.5 });
  assert.equal(told.ended, 1, 'the read found it on its way');
  transition('transitionrun', other, 'margin-top'); // too deep to come to be looked at
  looked.set(other, CHAIN);
  assert.equal(moves.moving(), false);
});

test('moves: a read\'s own transitions, started and over at once in the next frame, are told and read nothing again; a page\'s own started then is read as it ends', () => {
  frame();
  const { moves, calls, transition } = setUp();
  moves.echo();
  // WebKit: a run and an end at 0 s; Chromium: a run and a cancel.
  transition('transitionrun', first, 'margin-left', { elapsedTime: 0 });
  transition('transitionend', first, 'margin-left', { elapsedTime: 0 });
  transition('transitionrun', first, 'margin-right', { elapsedTime: 0 });
  transition('transitioncancel', first, 'margin-right', { elapsedTime: 0 });
  transition('transitionrun', other, 'padding-left', { pseudoElement: '::before', elapsedTime: 0 });
  transition('transitioncancel', other, 'padding-left', { pseudoElement: '::before', elapsedTime: 0 });
  transition('transitioncancel', other, 'width', { elapsedTime: 0 }); // no run of its own
  transition('transitionrun', other, 'width', { isTrusted: false, elapsedTime: 0 });
  transition('transitionend', other, 'width', { isTrusted: false, elapsedTime: 0 });
  assert.equal(calls.ended, 0, 'nothing of the page\'s moved');
  assert.deepEqual(calls.echoed, ['transitionend margin-left', 'transitioncancel margin-right', 'transitioncancel ::beforepadding-left']);
  transition('transitionrun', first, 'margin-top', { elapsedTime: 0 }); // the page's, in the same frame
  frame();
  assert.equal(moves.moving(), true);
  transition('transitionend', first, 'margin-top', { elapsedTime: 0 });
  assert.equal(calls.ended, 1, 'over after the frame: the page\'s own');
  transition('transitionrun', first, 'margin-left', { elapsedTime: 0 });
  transition('transitionend', first, 'margin-left', { elapsedTime: 0 });
  assert.equal(calls.ended, 2, 'with no read to come back from');
  assert.equal(calls.echoed.length, 3);
});

test('moves: what no event tells of (a script\'s animate()): a read the page asked for that found something new is made once more a second later, while that finds something new, a few times at most', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { moves, calls } = setUp();
    moves.found(false);
    mock.timers.tick(SETTLE_MS * 2);
    assert.equal(calls.settled, 0, 'nothing new');
    moves.found(true);
    mock.timers.tick(SETTLE_MS - 1);
    moves.found(true); // another before it: one settling read, after the last
    mock.timers.tick(SETTLE_MS - 1);
    assert.equal(calls.settled, 0);
    mock.timers.tick(1);
    assert.equal(calls.settled, 1);
    for (let i = 1; i < SETTLE_TRIES; i++) {
      moves.found(true); // still something new
      mock.timers.tick(SETTLE_MS);
    }
    assert.equal(calls.settled, SETTLE_TRIES);
    moves.found(true);
    mock.timers.tick(SETTLE_MS * 2);
    assert.equal(calls.settled, SETTLE_TRIES, 'no more than that in a row');
    moves.found(true); // a read of its own
    mock.timers.tick(SETTLE_MS);
    assert.equal(calls.settled, SETTLE_TRIES + 1);
    moves.found(false);
    mock.timers.tick(SETTLE_MS * 2);
    assert.equal(calls.settled, SETTLE_TRIES + 1, 'settled');
  } finally {
    mock.timers.reset();
  }
});

test('moves: @keyframes are found in nested rules and imports, the last of a name wins, and a sheet that can\'t be read is passed over', () => {
  const Keyframes = /** @type {any} */ (globalThis.CSSKeyframesRule);
  const Import = /** @type {any} */ (globalThis.CSSImportRule);
  const locked = { get cssRules() { throw new Error('SecurityError'); } };
  const sheets = [
    { cssRules: [new Keyframes('slide', [['opacity']])] },
    locked,
    { cssRules: [{ cssRules: [{ cssRules: [new Keyframes('slide', [['margin-left'], ['margin-left', '--x']])] }] }] },
    { cssRules: [new Import({ cssRules: [new Keyframes('grow', [['width']])] }), new Import(null)] },
  ];
  assert.deepEqual(keyframesIn(sheets, 'slide'), ['margin-left', 'margin-left', '--x']);
  assert.deepEqual(keyframesIn(sheets, 'grow'), ['width']);
  assert.equal(keyframesIn(sheets, 'none'), null);
});
