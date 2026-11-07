import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as gestures from '../extension/shared/gestures.js';

const { installGestureGuard } = gestures;

// A stand-in window: records listeners; pinch events are plain objects.
function fakeWindow({ zoom = 1 } = {}) {
  const listeners = {};
  return {
    document: {},
    visualViewport: { scale: zoom },
    addEventListener: (type, fn, options) => { listeners[type] = { fn, options }; },
    listeners,
  };
}
// Fired at a guard: the first event of a pinch going `scale`. Whether it was cancelled.
const start = (win, scale, path = []) => {
  const event = { scale, clientX: 10, clientY: 20, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, composedPath: () => path };
  win.listeners.gesturestart.fn(event);
  return event.defaultPrevented;
};
const withScale = (scale, fn) => {
  const before = globalThis.visualViewport;
  globalThis.visualViewport = { scale };
  try { return fn(); } finally { globalThis.visualViewport = before; }
};

test('pinch, on a page: only what would open Safari\'s overview is cancelled (the first event, inward, at normal scale)', () => withScale(1, () => {
  const win = fakeWindow();
  let settings = { blockGestures: true };
  installGestureGuard({ getSettings: () => settings, pinch: () => 'native', win });
  assert.deepEqual(win.listeners.gesturestart.options, { capture: true, passive: false });
  assert.equal(start(win, 0.98), true, 'inward at normal scale');
  assert.equal(start(win, 1.02), false, 'outward: Safari\'s');
  assert.equal(start(win, 1), false, 'no movement yet: Safari tests < 0 too');
  visualViewport.scale = 1.4;
  assert.equal(start(win, 0.98), false, 'magnified: Safari\'s, both ways');
  visualViewport.scale = 1.004;
  assert.equal(start(win, 0.98), false, 'any magnification: as Safari tests it');
  visualViewport.scale = 1;
  settings = { blockGestures: false };
  assert.equal(start(win, 0.98), false, 'setting off: all Safari\'s');
  settings = null;
  assert.equal(start(win, 0.98), true, 'before settings load: on (the default)');
  assert.deepEqual(Object.keys(win.listeners).filter((t) => t.startsWith('gesture')), ['gesturestart'], 'only the first event is looked at: Margin has no pinch of its own (removed 2026-11-07)');
}));

test('pinch, elsewhere: none on the new-tab page or in full screen (block); a page with a box is Safari\'s like any (Margin\'s own pinch was removed)', () => withScale(1, () => {
  const blocked = fakeWindow();
  installGestureGuard({ getSettings: () => ({}), win: blocked });
  assert.equal(start(blocked, 1.02), true, 'blocked by default, outward too');
  assert.equal(start(blocked, 0.98), true, 'and inward');
  visualViewport.scale = 2;
  assert.equal(start(blocked, 1.1), false, 'magnified by Safari (smart zoom): its pinch, read from the top window');
}));

test('wheel: a pinch reported as ⌃+wheel is left alone (cancelling it would count as handling the pinch); vertical is the page\'s', () => {
  const win = fakeWindow();
  installGestureGuard({ getSettings: () => ({ blockGestures: true }), win });
  const wheel = (e) => {
    let prevented = false;
    win.listeners.wheel.fn({ deltaX: 0, cancelable: true, ...e, preventDefault: () => { prevented = true; }, stopPropagation() {}, composedPath: () => [] });
    return prevented;
  };
  assert.equal(wheel({ ctrlKey: true, deltaY: 10 }), false);
  assert.equal(wheel({ deltaY: 77 }), false, 'no wheel is taken for a pan of Margin\'s own (none since its pinch went)');
  assert.equal(wheel({ deltaY: 5 }), false);
});

test('wheel: vertical and non-cancelable events are never touched', () => {
  const win = fakeWindow();
  installGestureGuard({ getSettings: () => ({ blockGestures: true }), win });
  for (const e of [{ deltaX: 0, deltaY: 50, cancelable: true }, { deltaX: -50, deltaY: 0, cancelable: false }, { deltaX: 0, deltaY: 50, ctrlKey: true, cancelable: false }]) {
    let prevented = false;
    win.listeners.wheel.fn({ ...e, preventDefault: () => { prevented = true; }, composedPath: () => [] });
    assert.equal(prevented, false, JSON.stringify(e));
  }
});

// A node that throws if its sizes are read: canScroll must not ask them
// of an event that doesn't move that way, or of what doesn't scroll by style.
const untouchable = (overflow = 'visible') => new Proxy({ nodeType: 1, overflow }, {
  get(target, key) {
    if (/^(scroll|client)(Width|Height)$|^scroll(Left|Top)$/.test(String(key))) throw new Error(`read ${String(key)}`);
    return target[key];
  },
});
const withStyles = (fn) => {
  const before = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (node) => ({ overflowX: node.overflow, overflowY: node.overflow, direction: 'ltr' });
  try { return fn(); } finally { globalThis.getComputedStyle = before; }
};

test('wheel: what can scroll is asked cheaply first (no sizes read for no movement, or for what doesn\'t scroll by its style)', () => withStyles(() => {
  const { canScroll, canSwipe } = gestures;
  assert.equal(canScroll(untouchable('auto'), 'x', 0, null), false, 'no movement that way');
  assert.equal(canScroll(untouchable('visible'), 'x', -20, null), false, 'overflow visible');
  assert.equal(canScroll(untouchable('hidden'), 'y', 20, null), false, 'overflow hidden');
  const page = { nodeType: 1, overflow: 'visible', scrollWidth: 2000, clientWidth: 1000, scrollLeft: 500 };
  assert.equal(canScroll(page, 'x', -20, page), true, 'the page scrolls with overflow visible');
  assert.equal(canScroll({ ...page, overflow: 'hidden' }, 'x', -20, page), false);
  const list = { nodeType: 1, overflow: 'auto', scrollWidth: 300, clientWidth: 200, scrollLeft: 0 };
  assert.equal(canScroll(list, 'x', -20, null), false, 'at its start, going back');
  assert.equal(canScroll(list, 'x', 20, null), true);
  const doc = { scrollingElement: untouchable('visible') };
  const vertical = { deltaX: 0, deltaY: 30, composedPath: () => [untouchable('auto'), untouchable('visible')] };
  assert.equal(canSwipe(vertical, doc), true, 'a vertical event walks nothing');
}));

test('wheel: the guard and the swipe check walk an event\'s path once between them', () => withStyles(() => {
  let walks = 0;
  const doc = { scrollingElement: { nodeType: 1, overflow: 'visible', scrollWidth: 1000, clientWidth: 1000 } };
  const win = { ...fakeWindow(), document: doc };
  win.listeners = {};
  win.addEventListener = (type, fn, options) => { win.listeners[type] = { fn, options }; };
  installGestureGuard({ getSettings: () => ({ blockGestures: true }), win });
  const event = { deltaX: -30, deltaY: 2, cancelable: true, preventDefault() { this.prevented = true; }, composedPath: () => { walks++; return []; } };
  win.listeners.wheel.fn(event);
  assert.equal(event.prevented, true, 'nothing scrolls sideways: Safari\'s swipe blocked');
  assert.equal(gestures.canSwipe(event, doc), true);
  assert.equal(walks, 1);
}));

test('wheel: the guard\'s cancelable listener is there only while blocking is on, added and removed with the same options', () => {
  const added = [];
  const removed = [];
  const win = {
    document: {},
    visualViewport: { scale: 1 },
    addEventListener: (type, fn, options) => { if (type === 'wheel') added.push({ fn, options }); },
    removeEventListener: (type, fn, options) => { if (type === 'wheel') removed.push({ fn, options }); },
  };
  let settings = null;
  const guard = installGestureGuard({ getSettings: () => settings, win });
  assert.equal(added.length, 1, 'before the settings are known: on (the default)');
  assert.deepEqual(added[0].options, { capture: true, passive: false });
  guard.update();
  assert.equal(added.length, 1, 'never added twice');
  settings = { blockGestures: false };
  guard.update();
  assert.equal(removed.length, 1, 'off: removed');
  assert.equal(removed[0].fn, added[0].fn);
  assert.deepEqual(removed[0].options, added[0].options);
  guard.update();
  assert.equal(removed.length, 1);
  settings = { blockGestures: true };
  guard.update();
  assert.equal(added.length, 2, 'on again: added again');
  let wanted = false;
  const other = installGestureGuard({ getSettings: () => ({ blockGestures: true }), wanted: () => wanted, win });
  assert.equal(added.length, 2, '`wanted` decides whether it\'s there');
  wanted = true;
  other.update();
  assert.equal(added.length, 3);
});
