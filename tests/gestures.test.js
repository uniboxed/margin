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
// Dispatch one pinch event to the guard; returns whether it was cancelled.
const fire = (win, type, scale = 1, path = []) => {
  const event = { scale, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, composedPath: () => path };
  win.listeners[type].fn(event);
  return event.defaultPrevented;
};
// A whole pinch: start, changes at the given scales, end → what was cancelled.
const pinch = (win, ...scales) => ({
  start: fire(win, 'gesturestart', 1, win.under ?? []),
  changes: scales.map((s) => fire(win, 'gesturechange', s)),
  end: fire(win, 'gestureend', scales.at(-1)),
});

test('pinch at normal zoom: the whole pinch is Margin\'s (cancelled for Safari, handed to onPinch)', () => {
  let settings = { blockGestures: true };
  const seen = [];
  const win = fakeWindow();
  installGestureGuard({ getSettings: () => settings, onPinch: (p) => seen.push(`${p.phase}:${p.scale}${p.overMargin ? ':over' : ''}`), win });
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    assert.deepEqual(win.listeners[type].options, { capture: true, passive: false }, type);
  }
  assert.deepEqual(win.listeners.wheel.options, { capture: true, passive: false }, 'wheel must be cancelable');

  const all = { start: true, changes: [true, true], end: true };
  assert.deepEqual(pinch(win, 0.9, 0.7), all, 'pinching in (Safari: all tabs): cancelled');
  assert.deepEqual(pinch(win, 1.2, 1.5), all, 'pinching out: cancelled, Margin zooms');
  assert.deepEqual(seen, ['start:1', 'change:0.9', 'change:0.7', 'end:0.7', 'start:1', 'change:1.2', 'change:1.5', 'end:1.5']);
  seen.length = 0;
  win.under = [{ localName: 'div' }, { localName: 'margin-sidebar-host' }, { localName: 'html' }];
  assert.deepEqual(pinch(win, 1.2), { start: true, changes: [true], end: true }, 'over Margin: still taken from Safari');
  assert.deepEqual(seen, ['start:1:over', 'change:1.2', 'end:1.2'], 'and said to be over Margin (zooms nothing)');
  win.under = [];

  seen.length = 0;
  win.visualViewport.scale = 2; // Safari magnified the page (smart zoom): its pinch
  assert.deepEqual(pinch(win, 0.8), { start: false, changes: [false], end: false });
  win.visualViewport.scale = 1;
  settings = { blockGestures: false };
  assert.deepEqual(pinch(win, 0.8), { start: false, changes: [false], end: false }, 'setting off: Safari\'s');
  assert.deepEqual(seen, [], 'not Margin\'s');
  settings = null;
  assert.deepEqual(pinch(win, 0.8), { start: true, changes: [true], end: true }, 'before settings load: on (the default)');
});

test('pinch → Safari\'s zoom levels: nearest to start × scale, 100%–300%', () => {
  const { zoomForPinch } = gestures;
  assert.equal(zoomForPinch(1, 1), 1);
  assert.equal(zoomForPinch(1, 1.2), 1.25);
  assert.equal(zoomForPinch(1, 1.5), 1.5);
  assert.equal(zoomForPinch(1, 2.1), 2);
  assert.equal(zoomForPinch(1, 9), 3, 'at most 300%');
  assert.equal(zoomForPinch(1, 0.4), 1, 'pinching in never goes below 100%');
  assert.equal(zoomForPinch(2, 0.6), 1.25, 'back out from 200%');
  assert.equal(zoomForPinch(2, 0.1), 1);
  assert.equal(zoomForPinch(0.75, 1), 0.75, 'already zoomed out with ⌘−: stays');
  assert.equal(zoomForPinch(0.75, 0.5), 0.75, '…and pinching in doesn\'t go lower');
  assert.equal(zoomForPinch(0.75, 1.4), 1);
});

test('pinch reported as ⌃+wheel: pinching in is cancelled at normal zoom, zooming in is not', () => {
  const win = fakeWindow();
  installGestureGuard({ getSettings: () => ({ blockGestures: true }), win });
  const wheel = (e) => {
    let prevented = false;
    win.listeners.wheel.fn({ deltaX: 0, cancelable: true, ...e, preventDefault: () => { prevented = true; }, composedPath: () => [] });
    return prevented;
  };
  assert.equal(wheel({ ctrlKey: true, deltaY: 10 }), true, 'pinching in');
  assert.equal(wheel({ ctrlKey: true, deltaY: -10 }), false, 'pinching out');
  win.visualViewport.scale = 2;
  assert.equal(wheel({ ctrlKey: true, deltaY: 10 }), false, 'zoomed in');
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
