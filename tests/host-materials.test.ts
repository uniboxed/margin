// The system's materials for Margin.app's page (app/shared/host/materials.ts): on while the theme drawn or Edit Theme
// Color's panel wants them (M2.9 step 5), each answered before its sheet is read; a theme never read with them on for
// the panel; nothing on without the app's answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMaterials } from '../app/shared/host/materials.ts';

// The app: each ask logged; answered (true when turned on) after `ms`, or refused (no app).
function app({ ms = 0, refuse = false } = {}) {
  const asks: boolean[] = [];
  let on = false;
  const ask = (want: boolean) => {
    asks.push(want);
    if (refuse) return Promise.reject(new Error('no app'));
    return new Promise((done) => setTimeout(() => { on = want; done(want); }, ms));
  };
  return { asks, ask, known: () => on, get on() { return on; } };
}

test('materials: the panel alone: asked for as it opens, given back as it closes; the same way twice: once', async () => {
  const a = app();
  const m = createMaterials(a.ask, a.known);
  await m.panel(true);
  assert.equal(a.on, true, 'on by the time it resolves');
  await m.panel(true);
  await m.panel(false);
  await m.panel(false);
  assert.deepEqual(a.asks, [true, false]);
  assert.equal(a.on, false);
});

test('materials: a theme that asks for them keeps them on, whatever the panel does', async () => {
  const a = app();
  const m = createMaterials(a.ask, a.known);
  await m.readTheme(true, async () => assert.equal(a.on, true, 'on as its sheet is read'));
  await m.panel(true);
  await m.panel(false);
  assert.deepEqual(a.asks, [true]);
  assert.equal(a.on, true);
});

test('materials: an ask the same way as one still on its way waits for its answer', async () => {
  const a = app({ ms: 40 });
  const m = createMaterials(a.ask, a.known);
  const theme = m.readTheme(true, async () => 'read');
  // (The panel opened while the theme's ask is on its way: it resolves only once they're on.)
  await m.panel(true);
  assert.equal(a.on, true);
  assert.equal(await theme, 'read');
  assert.deepEqual(a.asks, [true]);
});

test('materials: a theme is never read with them on for the panel: its want dropped first, and held off while reading', async () => {
  const a = app({ ms: 5 });
  const m = createMaterials(a.ask, a.known);
  await m.panel(true);
  assert.equal(a.on, true);
  // A theme that doesn't ask, read while the panel is open (it goes with the runtime that theme replaces).
  let during: boolean | null = null;
  await m.readTheme(false, async () => {
    // The panel of the runtime still drawn opened again meanwhile: not turned on until the reading's over.
    await m.panel(true);
    during = a.on;
  });
  assert.equal(during, false, 'off while its sheet was read');
  assert.equal(a.on, false, 'and after: that panel is drawn solid');
  assert.deepEqual(a.asks, [true, false]);
  await m.panel(false);
  await m.panel(true);
  assert.equal(a.on, true, 'a panel opened after the reading gets them');
});

test('materials: no app (Windows, the extension): nothing turns on, and every ask still resolves', async () => {
  const a = app({ refuse: true });
  const m = createMaterials(a.ask, a.known);
  await m.panel(true);
  assert.equal(await m.readTheme(true, async () => 7), 7);
  assert.equal(a.on, false);
});

test('materials: on, but the page doesn\'t know the property yet: waited for, 160 ms at most', async () => {
  let knows = false;
  const m = createMaterials(async () => true, () => knows);
  setTimeout(() => { knows = true; }, 40);
  const t0 = Date.now();
  await m.panel(true);
  assert.ok(knows && Date.now() - t0 >= 30, 'waited until the page knew it');
  const never = createMaterials(async () => true, () => false);
  const t1 = Date.now();
  await never.panel(true);
  const waited = Date.now() - t1;
  assert.ok(waited >= 150 && waited < 1000, `gave up after about 160 ms (${waited})`);
});
