// shared/switching.js: the tab being switched to, from a page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSwitching, backgroundSwitches } from '../extension/shared/switching.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeDocument() {
  const listeners = { visibilitychange: [], pagehide: [] };
  const doc = {
    hidden: false,
    addEventListener: (type, fn) => listeners[type]?.push(fn),
    defaultView: { addEventListener: (type, fn) => listeners[type]?.push(fn) },
    hide() {
      doc.hidden = true;
      listeners.visibilitychange.forEach((fn) => fn());
    },
    show() {
      doc.hidden = false;
      listeners.visibilitychange.forEach((fn) => fn());
    },
  };
  return doc;
}

function setup() {
  const doc = fakeDocument();
  const events = [];
  const switching = createSwitching({
    doc: /** @type {any} */ (doc),
    onChange: (id) => events.push(['change', id]),
    onSlow: (slow) => events.push(['slow', slow]),
    failed: (result) => result === 'failed',
    onFailed: (id) => events.push(['failed', id]),
  });
  return { doc, events, switching };
}

test('switching: highlighted at once; ends when the page is hidden (the switch landed)', async () => {
  const { doc, events, switching } = setup();
  switching.start(7, new Promise(() => {}));
  assert.deepEqual(events, [['change', 7]]);
  assert.equal(switching.target(), 7);
  await sleep(50);
  doc.hide();
  assert.deepEqual(events, [['change', 7], ['change', null]], 'no pill for a quick switch');
});

test('switching: the pill only once it takes longer than 150ms', async () => {
  const { doc, events, switching } = setup();
  switching.start(7, new Promise(() => {}));
  await sleep(200);
  assert.deepEqual(events, [['change', 7], ['slow', true]]);
  doc.hide();
  assert.deepEqual(events.slice(2), [['slow', false], ['change', null]]);
});

test('switching: still showing after the request says it switched (split view): ends shortly after, no pill', async () => {
  const { events, switching } = setup();
  let done;
  switching.start(7, new Promise((resolve) => { done = resolve; }));
  done();
  await sleep(100);
  assert.equal(switching.target(), 7, 'a moment for the page to be hidden');
  await sleep(400);
  assert.equal(switching.target(), null);
  assert.deepEqual(events, [['change', 7], ['change', null]]);
});

test('switching: the pill goes as soon as the request is done', async () => {
  const { events, switching } = setup();
  let done;
  switching.start(7, new Promise((resolve) => { done = resolve; }));
  await sleep(200);
  done();
  await sleep(10);
  assert.deepEqual(events, [['change', 7], ['slow', true], ['slow', false]]);
});

test('switching: an older switch\'s request doesn\'t end a newer one to the same tab', async () => {
  const { switching } = setup();
  let first;
  switching.start(7, new Promise((resolve) => { first = resolve; }));
  switching.start(8);
  switching.start(7, new Promise(() => {}));
  first();
  await sleep(400);
  assert.equal(switching.target(), 7);
});

test('switching: a send that fails ends it at once', async () => {
  const { switching } = setup();
  switching.start(7, Promise.reject(new Error('no tab')));
  await sleep(5);
  assert.equal(switching.target(), null);
});

test('switching: a request that says it didn\'t switch ends it at once, and says so', async () => {
  const { events, switching } = setup();
  switching.start(7, Promise.resolve('failed'));
  await sleep(5);
  assert.equal(switching.target(), null);
  assert.deepEqual(events, [['change', 7], ['change', null], ['failed', 7]]);
});

test('switching: a request still waiting for its answer keeps it on (no going back after 2.5s)', async () => {
  const { switching } = setup();
  switching.start(7, new Promise(() => {}));
  await sleep(2700);
  assert.equal(switching.target(), 7, 'covered while Margin answers');
});

test('switching: without a request (the background\'s next/previous), it ends by itself at the latest', async () => {
  const { switching } = setup();
  switching.start(7);
  await sleep(2600);
  assert.equal(switching.target(), null);
});

test('switching: a newer switch takes over (held keys), and a hidden page starts none', async () => {
  const { doc, events, switching } = setup();
  switching.start(7);
  switching.start(8);
  assert.equal(switching.target(), 8);
  assert.deepEqual(events, [['change', 7], ['change', 8]]);
  doc.hide();
  switching.start(9);
  assert.equal(switching.target(), null);
});

test('switching from the background: failed ends it at once; done ends it shortly after if this page still shows; others\' answers are ignored', async () => {
  const { switching } = setup();
  const background = backgroundSwitches();
  switching.start(7, background.begin(7));
  background.settle({ type: 'switch-failed', tabId: 8 });
  await sleep(5);
  assert.equal(switching.target(), 7, 'not its tab');
  background.settle({ type: 'switch-failed', tabId: 7 });
  await sleep(5);
  assert.equal(switching.target(), null);
  switching.start(9, background.begin(9));
  background.settle({ type: 'switch-done', tabId: 9 });
  await sleep(100);
  assert.equal(switching.target(), 9, 'a moment for the page to be hidden');
  await sleep(300);
  assert.equal(switching.target(), null, 'still showing (split view): over');
});

test('switching from the background: an older switch to the same tab, called off, doesn\'t settle a newer one (each says which it is); one with no id still settles by its tab', async () => {
  const { switching } = setup();
  const background = backgroundSwitches();
  switching.start(7, background.begin(7, 'a'));
  switching.start(7, background.begin(7, 'b'));
  background.settle({ type: 'switch-done', tabId: 7, switchId: 'a' });
  await sleep(400);
  assert.equal(switching.target(), 7, 'the older switch\'s word: still covered');
  background.settle({ type: 'switch-done', tabId: 7 });
  await sleep(400);
  assert.equal(switching.target(), 7, 'nor a word with no id');
  background.settle({ type: 'switch-failed', tabId: 7, switchId: 'b' });
  await sleep(5);
  assert.equal(switching.target(), null, 'its own');
  switching.start(9, background.begin(9));
  background.settle({ type: 'switch-failed', tabId: 9, switchId: 'c' });
  await sleep(5);
  assert.equal(switching.target(), 9, 'one with an id doesn\'t settle one without');
  background.settle({ type: 'switch-failed', tabId: 9 });
  await sleep(5);
  assert.equal(switching.target(), null);
});

test('switching from the background: done before the pill\'s delay: no pill (it landed)', async () => {
  const { events, switching } = setup();
  const background = backgroundSwitches();
  switching.start(7, background.begin(7));
  background.settle({ type: 'switch-done', tabId: 7 });
  await sleep(200);
  assert.deepEqual(events, [['change', 7]]);
});

test('switching from the background: done isn\'t taken for a failure (it resolves as a switch request does)', async () => {
  const { events, switching } = setup();
  const background = backgroundSwitches();
  const request = background.begin(7);
  switching.start(7, request);
  background.settle({ type: 'switch-done', tabId: 7 });
  await sleep(10);
  assert.equal(events.some(([kind]) => kind === 'failed'), false);
  assert.deepEqual(await request, { shown: 7 });
});

// Margin.app's overlay stays on screen through a switch (Phase 2 step 8): the
// highlight is the switch's until the state has its tab in front, so the row
// it moved to never goes back to the tab left while the state catches up.
// `highlight()`: the row the sidebar draws (the switch's target, else the
// state's tab in front).
function onScreen() {
  const doc = fakeDocument();
  let front = 1;
  let target = null;
  const drawn = [];
  const highlight = () => target ?? front;
  const draw = () => { if (drawn.at(-1) !== highlight()) drawn.push(highlight()); };
  draw();
  const switching = createSwitching({
    doc: /** @type {any} */ (doc),
    onChange: (id) => { target = id; draw(); },
    onSlow: () => {},
    failed: (result) => result === undefined,
    front: () => front,
    landed: (id, from) => (front === id ? true : front === from ? null : false),
  });
  const state = (id) => { front = id; switching.settle(); draw(); };
  return { switching, state, drawn };
}

test('switching, on screen: answered before the state has the tab, the highlight stays on it; it moves once (1 → 2), never back', async () => {
  const { switching, state, drawn } = onScreen();
  let answer;
  switching.start(2, new Promise((resolve) => { answer = resolve; }));
  answer({ shown: 2 });
  await sleep(400); // past the old 300 ms grace: before, the highlight went back to tab 1 here
  assert.deepEqual(drawn, [1, 2]);
  state(2); // the state's delta, late
  assert.deepEqual(drawn, [1, 2], 'one change, to the new tab');
  assert.equal(switching.target(), null, 'the switch is over');
});

test('switching, on screen: the copy\'s own switch (a key) and its word that it\'s done before the state: no flicker either', async () => {
  const { switching, state, drawn } = onScreen();
  const copy = backgroundSwitches();
  switching.start(3, copy.begin(3));
  copy.settle({ type: 'switch-done', tabId: 3 }); // before 2026-11-05 the overlay dropped the highlight here, at once
  await sleep(20);
  assert.deepEqual(drawn, [1, 3]);
  state(3);
  assert.deepEqual(drawn, [1, 3]);
});

test('switching, on screen: the state with the tab in front before the answer ends it then; another tab coming to the front ends it too; a failure goes back', async () => {
  let s = onScreen();
  s.switching.start(2, new Promise(() => {}));
  s.state(2);
  assert.deepEqual(s.drawn, [1, 2]);
  assert.equal(s.switching.target(), null);
  s = onScreen();
  s.switching.start(2, new Promise(() => {}));
  s.state(4); // the user went elsewhere (Safari's tab bar)
  assert.deepEqual(s.drawn, [1, 2, 4]);
  s = onScreen();
  let fail;
  s.switching.start(2, new Promise((resolve) => { fail = resolve; }));
  fail(undefined);
  await sleep(0);
  assert.deepEqual(s.drawn, [1, 2, 1], 'the switch really failed: back to the tab in front');
});

test('switching, on screen: answered but the state never says so: over after SETTLE_MS', async () => {
  const { switching, drawn } = onScreen();
  const { SETTLE_MS } = await import('../extension/shared/switching.js');
  assert.equal(SETTLE_MS, 2000);
  switching.start(2, Promise.resolve({ shown: 2 }));
  await sleep(50);
  assert.equal(switching.target(), 2);
  assert.deepEqual(drawn, [1, 2]);
});
