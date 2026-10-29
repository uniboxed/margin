// content/ready.js: Margin getting ready on a page (the startup cover).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadiness } from '../extension/content/ready.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(options = {}) {
  const listeners = [];
  const doc = { hidden: false, addEventListener: (_, fn) => listeners.push(fn) };
  const events = [];
  const readiness = createReadiness({ doc: /** @type {any} */ (doc), show: (on) => events.push(on), graceMs: 50, minShownMs: 80, maxMs: 400, ...options });
  const setHidden = (hidden) => {
    doc.hidden = hidden;
    listeners.forEach((fn) => fn());
  };
  return { readiness, events, setHidden };
}

test('ready: a quick wait shows nothing (no flash)', async () => {
  const { readiness, events } = setup();
  readiness.wait(true);
  await sleep(20);
  readiness.wait(false);
  await sleep(100);
  assert.deepEqual(events, []);
});

test('ready: a longer wait shows the cover after the grace, at least its minimum', async () => {
  const { readiness, events } = setup();
  readiness.wait(true);
  await sleep(70);
  assert.deepEqual(events, [true]);
  readiness.wait(false);
  await sleep(20);
  assert.deepEqual(events, [true], 'kept up a moment: no flicker');
  await sleep(100);
  assert.deepEqual(events, [true, false]);
});

test('ready: never longer than its limit (Margin then works with what it has)', async () => {
  const { readiness, events } = setup();
  readiness.wait(true);
  await sleep(450);
  assert.deepEqual(events, [true, false]);
  assert.equal(readiness.waiting(), true, 'still waiting, uncovered');
});

test('ready: nothing on a hidden page; shown while still waiting, it covers after the grace from then', async () => {
  const { readiness, events, setHidden } = setup();
  setHidden(true);
  readiness.wait(true);
  await sleep(80);
  assert.deepEqual(events, []);
  setHidden(false);
  assert.deepEqual(events, [], 'not at once: its grace starts as it\'s shown');
  await sleep(70);
  assert.deepEqual(events, [true]);
  setHidden(true);
  assert.deepEqual(events, [true, false], 'gone at once when hidden');
});

test('ready: at the limit, a cover up only a moment still stays its minimum', async () => {
  const { readiness, events } = setup({ graceMs: 380, maxMs: 400, minShownMs: 80 });
  readiness.wait(true);
  await sleep(410);
  assert.deepEqual(events, [true], 'shown at 380ms, kept past the 400ms limit');
  await sleep(80);
  assert.deepEqual(events, [true, false]);
});

test('ready: not over a page in use (allowed() false), until it is', async () => {
  let allowed = false;
  const { readiness, events } = setup({ allowed: () => allowed });
  readiness.wait(true);
  await sleep(120);
  assert.deepEqual(events, []);
  allowed = true;
  await sleep(150);
  assert.deepEqual(events, [true]);
});
