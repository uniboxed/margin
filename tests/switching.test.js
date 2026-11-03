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
    // An event that runs after the page was hidden and shown again (WebKit queues them).
    late() {
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
    onBlink: (times) => events.push(['blink', times.shownAt - times.hiddenAt]),
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

test('switching: hidden for an instant, then shown again: a blink (when, said), with a switch under way or not (a kick goes out before a switch from a key to a space has told this page anything: the background takes only a blink during one of its flips); not a page shown again later', async () => {
  const { doc, events, switching } = setup();
  const blinks = () => events.filter(([kind]) => kind === 'blink');
  switching.start(7, new Promise(() => {}));
  doc.hide();
  doc.show();
  assert.equal(blinks().length, 1);
  assert.ok(blinks()[0][1] >= 0 && blinks()[0][1] < 100);
  doc.hide();
  doc.show();
  assert.equal(blinks().length, 2, 'no switch this page knows of: one all the same');
  switching.start(8, new Promise(() => {}));
  doc.hide();
  await sleep(150);
  doc.show();
  assert.equal(blinks().length, 2, 'away for a while: a switch and back');
  switching.start(9, new Promise(() => {}));
  doc.late(); // its event finds it visible: hidden and shown before it ran
  assert.equal(blinks().length, 3);
  assert.equal(switching.target(), 9, 'still switching (the page never looked hidden)');
  switching.end();
  doc.late();
  assert.equal(blinks().length, 4, 'nor with no switch under way');
});
