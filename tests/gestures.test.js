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
const pinch = (win, scale) => {
  const event = { scale, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  win.listeners.gesturechange.fn(event);
  return event.defaultPrevented;
};

test('pinch: pinching in at normal zoom (Safari: all tabs) is blocked; zooming in and back out is not', () => {
  let settings = { blockGestures: true };
  const win = fakeWindow();
  installGestureGuard({ getSettings: () => settings, win });
  assert.deepEqual(win.listeners.gesturechange.options, { capture: true, passive: false });
  assert.deepEqual(win.listeners.wheel.options, { capture: true, passive: false }, 'wheel must be cancelable');
  assert.equal(pinch(win, 0.8), true);
  assert.equal(pinch(win, 1.3), false, 'zooming in');
  win.visualViewport.scale = 2;
  assert.equal(pinch(win, 0.8), false, 'zooming back out while zoomed in');
  win.visualViewport.scale = 1;
  settings = { blockGestures: false };
  assert.equal(pinch(win, 0.8), false, 'setting off');
  settings = null;
  assert.equal(pinch(win, 0.8), true, 'before settings load: on (the default)');
});

test('wheel: vertical, pinch-zoom (ctrlKey) and non-cancelable events are never touched', () => {
  const win = fakeWindow();
  installGestureGuard({ getSettings: () => ({ blockGestures: true }), win });
  for (const e of [{ deltaX: 0, deltaY: 50, cancelable: true }, { deltaX: -50, deltaY: 0, ctrlKey: true, cancelable: true }, { deltaX: -50, deltaY: 0, cancelable: false }]) {
    let prevented = false;
    win.listeners.wheel.fn({ ...e, preventDefault: () => { prevented = true; }, composedPath: () => [] });
    assert.equal(prevented, false, JSON.stringify(e));
  }
});
