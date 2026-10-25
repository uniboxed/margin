import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../extension/shared/gestures.js';

const { installGestureGuard } = globalThis.Margin.gestures;

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

test('pinch at normal zoom: start, pinch-in updates and end are cancelled (Safari: no all-tabs overview)', () => {
  let settings = { blockGestures: true };
  const win = fakeWindow();
  installGestureGuard({ getSettings: () => settings, win });
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    assert.deepEqual(win.listeners[type].options, { capture: true, passive: false }, type);
  }
  assert.deepEqual(win.listeners.wheel.options, { capture: true, passive: false }, 'wheel must be cancelable');

  assert.deepEqual(pinch(win, 0.9, 0.7), { start: true, changes: [true, true], end: true }, 'pinching in: all of it');
  assert.deepEqual(pinch(win, 1.2, 1.5), { start: true, changes: [false, false], end: false }, 'pinching out (zoom in): updates and end go to Safari');
  assert.deepEqual(pinch(win, 1.2, 0.8), { start: true, changes: [false, true], end: false }, 'out, then back in past the start: the pinch-in part is cancelled');

  win.visualViewport.scale = 2;
  assert.deepEqual(pinch(win, 0.8), { start: false, changes: [false], end: false }, 'zoomed in: pinch freely (zoom back out)');
  win.visualViewport.scale = 1;

  settings = { blockGestures: false };
  assert.deepEqual(pinch(win, 0.8), { start: false, changes: [false], end: false }, 'setting off');
  settings = null;
  assert.deepEqual(pinch(win, 0.8), { start: true, changes: [true], end: true }, 'before settings load: on (the default)');
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
