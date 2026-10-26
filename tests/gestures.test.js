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
const fire = (win, type, scale = 1) => {
  const event = { scale, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  win.listeners[type].fn(event);
  return event.defaultPrevented;
};
// A whole pinch: start, changes at the given scales, end → what was cancelled.
const pinch = (win, ...scales) => ({
  start: fire(win, 'gesturestart'),
  changes: scales.map((s) => fire(win, 'gesturechange', s)),
  end: fire(win, 'gestureend', scales.at(-1)),
});

test('pinch at normal zoom: the whole pinch is Margin\'s (cancelled for Safari, handed to onPinch)', () => {
  let settings = { blockGestures: true };
  const seen = [];
  const win = fakeWindow();
  installGestureGuard({ getSettings: () => settings, onPinch: (p) => seen.push(`${p.phase}:${p.scale}`), win });
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    assert.deepEqual(win.listeners[type].options, { capture: true, passive: false }, type);
  }
  assert.deepEqual(win.listeners.wheel.options, { capture: true, passive: false }, 'wheel must be cancelable');

  const all = { start: true, changes: [true, true], end: true };
  assert.deepEqual(pinch(win, 0.9, 0.7), all, 'pinching in (Safari: all tabs): cancelled');
  assert.deepEqual(pinch(win, 1.2, 1.5), all, 'pinching out: cancelled, Margin zooms');
  assert.deepEqual(seen, ['start:1', 'change:0.9', 'change:0.7', 'end:0.7', 'start:1', 'change:1.2', 'change:1.5', 'end:1.5']);

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
