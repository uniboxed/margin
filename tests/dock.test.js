import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../extension/shared/dock.js';

const { dockLayout, followLayout, undockLayout, describe, WIDTH } = globalThis.Margin.dock;

test('dockLayout: dock takes the left 260px, the window keeps the rest', () => {
  assert.deepEqual(dockLayout({ left: 0, top: 25, width: 1440, height: 875 }), {
    dock: { left: 0, top: 25, width: WIDTH, height: 875 },
    target: { left: 260, top: 25, width: 1180, height: 875 },
  });
  assert.equal(dockLayout({ left: 0, top: 0, width: 700, height: 800 }), null, 'too narrow');
  assert.equal(dockLayout({ left: 0, top: 0 }), null, 'no bounds (browser does not report them)');
});

test('followLayout: moves the dock by however much the window moved, from where the dock really is', () => {
  const prev = { left: 300, top: 40, width: 1000, height: 700 };
  const dock = { left: 40, top: 40, width: 260, height: 700 };
  assert.equal(followLayout(prev, prev, dock), null, 'window did not move');
  assert.equal(followLayout(prev, { ...prev, left: 301 }, dock), null, 'within slack');
  assert.deepEqual(followLayout(prev, { ...prev, left: 500, height: 600 }, dock), { left: 240, top: 40, width: 260, height: 600 });
});

test('followLayout: no fighting when the browser reports offset coordinates', () => {
  // Safari: window drawn flush at 0, but positions come back offset by 34px.
  // The old absolute rule asked for left = target.left - 260 = -34 every tick;
  // macOS put it back at 0, and it jumped twice a second.
  const target = { left: 226, top: 25, width: 1200, height: 875 };
  const dock = { left: 0, top: 25, width: 260, height: 875 };
  assert.equal(followLayout(target, target, dock), null, 'nothing moved, so the dock stays put');
});

test('followLayout: never moves the dock off-screen', () => {
  const prev = { left: 260, top: 25, width: 1000, height: 800 };
  const dock = { left: 0, top: 25, width: 260, height: 800 };
  assert.deepEqual(followLayout(prev, { ...prev, left: 100 }, dock, { minLeft: 0, minTop: 25 }), null, 'already at the edge');
  assert.deepEqual(followLayout(prev, { ...prev, left: 100, top: 0 }, { ...dock, left: 50 }, { minLeft: 0, minTop: 25 }), {
    left: 0, top: 25, width: 260, height: 800,
  });
});

test('undockLayout restores the width; describe reports whether the browser obeyed', () => {
  assert.deepEqual(undockLayout({ left: 260, top: 25, width: 1180, height: 875 }), { left: 0, top: 25, width: 1440, height: 875 });
  const r = { left: 0, top: 25, width: 260, height: 875 };
  assert.equal(describe(r, r), '✓ asked 0,25 260×875 → got 0,25 260×875');
  assert.match(describe(r, { ...r, width: 400 }), /^✗/);
});
