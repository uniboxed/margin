// shared/switching.ts: the tab being switched to, from a page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSwitching, backgroundSwitches, describeSwitchRun, type SwitchRun } from '../extension/shared/switching.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeDocument() {
  const listeners: Record<string, (() => void)[]> = { visibilitychange: [], pagehide: [] };
  const doc = {
    hidden: false,
    addEventListener: (type: string, fn: () => void) => listeners[type]?.push(fn),
    defaultView: { addEventListener: (type: string, fn: () => void) => listeners[type]?.push(fn) },
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
  const events: unknown[][] = [];
  const switching = createSwitching({
    doc: doc as unknown as Document, // a fake: `hidden` and its listeners
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
  let done!: (value?: unknown) => void; // set by the promise, at once
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
  let done!: (value?: unknown) => void; // set by the promise, at once
  switching.start(7, new Promise((resolve) => { done = resolve; }));
  await sleep(200);
  done();
  await sleep(10);
  assert.deepEqual(events, [['change', 7], ['slow', true], ['slow', false]]);
});

test('switching: an older switch\'s request doesn\'t end a newer one to the same tab', async () => {
  const { switching } = setup();
  let first!: (value?: unknown) => void; // set by the promise, at once
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
  const runs: SwitchRun[] = [];
  let front = 1;
  let target: number | string | null = null;
  const drawn: (number | string)[] = [];
  const highlight = () => target ?? front;
  const draw = () => { if (drawn.at(-1) !== highlight()) drawn.push(highlight()); };
  draw();
  const switching = createSwitching({
    doc: doc as unknown as Document, // a fake: `hidden` and its listeners
    onChange: (id) => { target = id; draw(); },
    onSlow: () => {},
    failed: (result) => result === undefined,
    front: () => front,
    onRun: (run) => runs.push(run),
  });
  const state = (id: number) => { front = id; switching.settle(); draw(); };
  // The copy's key switches as the overlay takes them (app/shared/host/overlay.ts 'switching',
  // ui/runtime.ts switchTo): each with its switchId, settled only by its own word.
  const copy = backgroundSwitches();
  const key = (id: number, switchId: string) => {
    const request = copy.begin(id, switchId);
    if (id === front) switching.toFront(id, request);
    else switching.start(id, request);
  };
  const done = (id: number, switchId: string) => copy.settle({ type: 'switch-done', tabId: id, switchId });
  // A click on a row (ui/runtime.ts send): the tab in front goes on with the chain.
  const click = (id: number, request: Promise<unknown>) => {
    if (id === front) switching.toFront(id, request);
    else switching.start(id, request);
  };
  return { switching, state, drawn, key, done, click, front: () => front, runs };
}

test('switching, on screen: each chain as it ends, for Margin.app\'s log: its targets, where it ended, whether the highlight went back', async () => {
  const { PASSED_MS } = await import('../extension/shared/switching.ts');
  const only = (runs: SwitchRun[]) => runs.map(({ targets, landed, back, elsewhere, failed }) => ({ targets, landed, back, elsewhere, failed }));
  // Landed on its last target.
  let s = onScreen();
  s.key(2, 'nav-1'); s.key(3, 'nav-2'); s.done(3, 'nav-2');
  await sleep(0);
  s.state(3);
  assert.deepEqual(only(s.runs), [{ targets: 2, landed: true, back: 0, elsewhere: 0, failed: false }]);
  assert.ok(s.runs[0].ms >= 0 && s.runs[0].ms < 100);
  // A passed tab in front past PASSED_MS: the highlight went back to it.
  s = onScreen();
  s.key(2, 'nav-1'); s.key(3, 'nav-2'); s.done(3, 'nav-2');
  await sleep(0);
  s.state(2);
  await sleep(PASSED_MS + 50);
  assert.deepEqual(only(s.runs), [{ targets: 2, landed: false, back: 1, elsewhere: 0, failed: false }]);
  // Another tab, outside the chain: elsewhere, not back.
  s = onScreen();
  s.key(2, 'nav-1'); s.key(3, 'nav-2');
  s.state(5);
  assert.deepEqual(only(s.runs), [{ targets: 2, landed: false, back: 0, elsewhere: 1, failed: false }]);
  // Failed: neither.
  s = onScreen();
  s.key(2, 'nav-1');
  s.switching.start(4, Promise.resolve(undefined));
  await sleep(0);
  assert.deepEqual(only(s.runs), [{ targets: 2, landed: false, back: 0, elsewhere: 0, failed: true }]);
});

test('switching, on screen: answered before the state has the tab, the highlight stays on it; it moves once (1 → 2), never back', async () => {
  const { switching, state, drawn } = onScreen();
  let answer!: (value?: unknown) => void; // set by the promise, at once
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
  let fail!: (value?: unknown) => void; // set by the promise, at once
  s.switching.start(2, new Promise((resolve) => { fail = resolve; }));
  fail(undefined);
  await sleep(0);
  assert.deepEqual(s.drawn, [1, 2, 1], 'the switch really failed: back to the tab in front');
});

test('switching, on screen: answered but the state never says so: over after SETTLE_MS', async () => {
  const { switching, drawn } = onScreen();
  const { SETTLE_MS } = await import('../extension/shared/switching.ts');
  assert.equal(SETTLE_MS, 2000);
  switching.start(2, Promise.resolve({ shown: 2 }));
  await sleep(50);
  assert.equal(switching.target(), 2);
  assert.deepEqual(drawn, [1, 2]);
});

// A chain of key switches (Margin 2: Safari reliability): the copy's 'switching' for
// the next press goes out at the press, the state's change for the one before only
// after Safari's storage event (100 ms and more later), so the overlay can hear them
// in either order. The highlight never goes back to a tab the chain passed.
test('switching, on screen: a chain of key switches never draws an earlier tab (its late state is the chain\'s echo)', async () => {
  const s = onScreen();
  s.key(2, 'nav-1');
  s.done(2, 'nav-1');
  await sleep(0);
  s.key(3, 'nav-2'); // before the state has 2 in front
  s.state(2); // 2's change, late: before, the highlight went back to 2 here
  s.done(3, 'nav-2');
  await sleep(0);
  s.state(3);
  assert.deepEqual(s.drawn, [1, 2, 3]);
  assert.equal(s.switching.target(), null, 'landed: over');
});

test('switching, on screen: next then back (the chain back at its start): the stale front isn\'t taken for landing, and the passed tab\'s late change doesn\'t show it', async () => {
  const s = onScreen();
  s.key(2, 'nav-1');
  s.key(1, 'nav-2'); // back to the tab the state still has in front
  s.done(1, 'nav-2'); // the copy's word for 1 before the state has even had 2
  await sleep(0);
  s.state(1); // a change that isn't the front's (favicons): the state still says 1
  assert.equal(s.switching.target(), 1, 'not over on the stale front');
  s.state(2); // 2's change, late
  s.state(1);
  assert.deepEqual(s.drawn, [1, 2, 1]);
  assert.equal(s.switching.target(), null);
});

test('switching, on screen: a click on the tab in front during a key chain goes on with the chain (no end, so the passed tab\'s change can\'t show it)', async () => {
  const s = onScreen();
  s.key(2, 'nav-1');
  s.click(1, Promise.resolve({ shown: 1 })); // the row of the tab the state still has in front
  await sleep(0);
  s.state(2);
  s.state(1);
  assert.deepEqual(s.drawn, [1, 2, 1]);
  assert.equal(s.switching.target(), null);
});

test('switching, on screen: the chain\'s target closes and Safari shows a passed tab: the highlight follows it within PASSED_MS', async () => {
  const { PASSED_MS } = await import('../extension/shared/switching.ts');
  assert.equal(PASSED_MS, 1000);
  const s = onScreen();
  s.key(2, 'nav-1');
  s.key(3, 'nav-2');
  s.done(3, 'nav-2');
  await sleep(0);
  s.state(2); // 2 in front: the chain's echo for a moment, then a real switch (3 closed)
  await sleep(100);
  assert.deepEqual(s.drawn, [1, 2, 3], 'held on the target for a moment');
  await sleep(PASSED_MS);
  assert.deepEqual(s.drawn, [1, 2, 3, 2], 'then the tab in front');
  assert.equal(s.switching.target(), null);
});

test('switching, on screen: Safari slower than PASSED_MS with the newest target: a passed tab in front holds as the chain\'s echo until the answer, then PASSED_MS', async () => {
  const { PASSED_MS, SETTLE_MS } = await import('../extension/shared/switching.ts');
  const s = onScreen();
  s.key(2, 'nav-1');
  s.key(3, 'nav-2'); // Safari still carrying out 2
  s.state(2); // 2 lands and stays in front while Safari takes its time with 3 (a 450 ms switch)
  await sleep(PASSED_MS + 150);
  assert.deepEqual(s.drawn, [1, 2, 3], 'held on the newest target: its request isn\'t answered yet');
  assert.equal(s.switching.target(), 3);
  s.done(3, 'nav-2'); // answered, but the state still says 2 (its change late)
  await sleep(0);
  await sleep(PASSED_MS - 100);
  assert.deepEqual(s.drawn, [1, 2, 3], 'still held for PASSED_MS after the answer');
  s.state(3);
  assert.deepEqual(s.drawn, [1, 2, 3]);
  assert.equal(s.switching.target(), null, 'landed');
  // A passed tab in front past PASSED_MS after the answer: a real switch (the target closed), followed.
  const t = onScreen();
  t.key(2, 'nav-1');
  t.key(3, 'nav-2');
  t.state(2);
  await sleep(50);
  t.done(3, 'nav-2');
  await sleep(PASSED_MS + 50);
  assert.deepEqual(t.drawn, [1, 2, 3, 2], 'followed PASSED_MS after the answer');
  // No answer ever: not held past SETTLE_MS.
  const u = onScreen();
  u.key(2, 'nav-1');
  u.key(3, 'nav-2');
  u.state(2);
  await sleep(SETTLE_MS + 50);
  assert.deepEqual(u.drawn, [1, 2, 3, 2], 'a request with no answer holds it SETTLE_MS at most');
});

test('switching, on screen: the newest target answered while the state lags half a second on a passed tab (seen 2026-11-08): the highlight never goes back and forth', async () => {
  const s = onScreen();
  s.key(2, 'nav-1'); s.key(3, 'nav-2'); s.key(4, 'nav-3');
  s.state(2); // Safari carried out an earlier press first; its change arrives
  await sleep(50);
  s.done(4, 'nav-3'); // Safari has 4 in front now, but the state with it is half a second behind
  await sleep(600);
  s.state(3); // another earlier one's late change
  await sleep(100);
  assert.deepEqual(s.drawn, [1, 2, 3, 4], 'held on the newest target throughout');
  s.state(4);
  assert.deepEqual(s.drawn, [1, 2, 3, 4], 'landed, never having gone back');
  assert.equal(s.switching.target(), null);
  assert.deepEqual(s.runs.map((r) => [r.landed, r.back]), [[true, 0]]);
});

test('switching, on screen: a tab outside the chain coming to the front ends it at once', () => {
  const s = onScreen();
  s.key(2, 'nav-1');
  s.key(3, 'nav-2');
  s.state(5); // the user went elsewhere (Safari's tab bar)
  assert.deepEqual(s.drawn, [1, 2, 3, 5]);
  assert.equal(s.switching.target(), null);
});

test('switching, on screen: a new chain after one is over starts from the tab in front then', () => {
  const s = onScreen();
  s.key(2, 'nav-1');
  s.state(2);
  s.key(3, 'nav-2');
  s.state(1); // not 3's chain's start (2), nor passed: someone else's switch
  assert.deepEqual(s.drawn, [1, 2, 3, 1]);
});

test('switching: a chain as a line for Margin.app\'s log (the overlay\'s); a lone switch that landed says nothing', () => {
  assert.equal(describeSwitchRun({ targets: 1, landed: true, back: 0, elsewhere: 0, failed: false, ms: 20 }), null);
  assert.equal(describeSwitchRun({ targets: 12, landed: true, back: 0, elsewhere: 0, failed: false, ms: 180 }),
    'switch chain: 12 targets highlighted, ended on its last target 180 ms after the last; the highlight went back 0 times');
  assert.equal(describeSwitchRun({ targets: 2, landed: false, back: 1, elsewhere: 0, failed: false, ms: 340 }),
    'switch chain: 2 targets highlighted, ended back on a tab it had passed 340 ms after the last; the highlight went back 1 time');
  assert.equal(describeSwitchRun({ targets: 1, landed: false, back: 0, elsewhere: 1, failed: false, ms: 5 }),
    'switch chain: 1 target highlighted, ended on another tab (a switch it didn\'t make) 5 ms after the last; the highlight went back 0 times');
  assert.equal(describeSwitchRun({ targets: 3, landed: false, back: 0, elsewhere: 0, failed: true, ms: 9 }),
    'switch chain: 3 targets highlighted, ended failed 9 ms after the last; the highlight went back 0 times');
});

test('a saved row stays highlighted through the browser creation event and identity handoff', async () => {
  let front: number | string = 1;
  let finish!: (result: { shown: number }) => void;
  const request = new Promise<{ shown: number }>((resolve) => { finish = resolve; });
  const doc = fakeDocument();
  const changes: (number | string | null)[] = [];
  const switching = createSwitching({ doc: doc as unknown as Document, front: () => front, onChange: (id) => changes.push(id), onSlow() {} });
  switching.start('t-saved', request);
  front = 20; // created/activated before linkKept is delivered
  switching.settle();
  assert.equal(switching.target(), 't-saved');
  finish({ shown: 20 });
  await Promise.resolve();
  assert.equal(switching.target(), 't-saved');
  front = 't-saved'; // runtime maps the browser tab's stable mid to the saved target
  switching.settle();
  assert.deepEqual(changes, ['t-saved', null]);
});
