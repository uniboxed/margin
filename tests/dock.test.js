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

test('followLayout: re-docks only when the window moved or resized', () => {
  const target = { left: 300, top: 40, width: 1000, height: 700 };
  assert.equal(followLayout(target, { left: 40, top: 40, width: 260, height: 700 }), null);
  assert.equal(followLayout(target, { left: 41, top: 39, width: 260, height: 701 }), null, 'within slack');
  assert.deepEqual(followLayout({ ...target, left: 500, height: 600 }, { left: 40, top: 40, width: 260, height: 700 }), {
    left: 240, top: 40, width: 260, height: 600,
  });
});

test('undockLayout restores the width; describe reports whether the browser obeyed', () => {
  assert.deepEqual(undockLayout({ left: 260, top: 25, width: 1180, height: 875 }), { left: 0, top: 25, width: 1440, height: 875 });
  const r = { left: 0, top: 25, width: 260, height: 875 };
  assert.equal(describe(r, r), '✓ asked 0,25 260×875 → got 0,25 260×875');
  assert.match(describe(r, { ...r, width: 400 }), /^✗/);
});
