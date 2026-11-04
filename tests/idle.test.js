// Whether the user is idle on the page in front, for the warm-up after a
// relaunch (content/idle.js): nothing watched until asked, never idle on the
// first ask, not while Safari isn't in use or the page is hidden, in full
// screen, playing, typing or touched, or Margin itself busy; the first input
// after an idle answer said once; the listeners off afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const windowListeners = new Map();
const docListeners = new Map();
const on = (map) => (type, fn) => (map.get(type) ?? map.set(type, new Set()).get(type)).add(fn);
const off = (map) => (type, fn) => map.get(type)?.delete(fn);
const count = (map) => [...map.values()].reduce((n, set) => n + set.size, 0);
const fire = (map, type, event = {}) => { for (const fn of map.get(type) ?? []) fn({ type, ...event }); };
globalThis.addEventListener = on(windowListeners);
globalThis.removeEventListener = off(windowListeners);
const page = { visible: true, focused: true, fullscreen: null, media: [], active: null };
globalThis.document = /** @type {any} */ ({
  get visibilityState() { return page.visible ? 'visible' : 'hidden'; },
  hasFocus: () => page.focused,
  get fullscreenElement() { return page.fullscreen; },
  get activeElement() { return page.active; },
  querySelectorAll: () => page.media,
  addEventListener: on(docListeners),
  removeEventListener: off(docListeners),
});

const { createIdleWatch } = await import('../extension/content/idle.js');
let busy = null;
const acted = [];
const watch = createIdleWatch({ busy: () => busy, acted: (at) => acted.push(at) });
const ASK = { idleMs: 60, keysMs: 120 };

test('nothing is watched until asked; the first ask can\'t know what came before: not idle, ask again', () => {
  assert.equal(count(windowListeners) + count(docListeners), 0);
  const first = watch.ask(ASK);
  assert.equal(first.idle, false);
  assert.equal(first.why, 'watching');
  assert.ok(first.retryMs >= 60 && first.retryMs <= 250, JSON.stringify(first));
  assert.ok(count(windowListeners) > 0);
});

test('idle once nothing came for long enough (keys longer); then the first input is said once', async () => {
  await sleep(130);
  assert.deepEqual(watch.ask(ASK), { idle: true });
  fire(windowListeners, 'pointermove');
  fire(windowListeners, 'keydown');
  assert.equal(acted.length, 1);
  // Touched just now: not idle; a key just now: longer.
  assert.equal(watch.ask(ASK).why, 'input');
  await sleep(70);
  assert.equal(watch.ask(ASK).why, 'typing');
  await sleep(70);
  assert.deepEqual(watch.ask(ASK), { idle: true });
  // Its focus going (the address bar, another app), it going hidden: said too.
  page.focused = false;
  fire(windowListeners, 'blur');
  assert.equal(acted.length, 2);
  assert.equal(watch.ask(ASK).why, 'not focused'); // (no word owed for what comes next)
  fire(docListeners, 'visibilitychange');
  assert.equal(acted.length, 2, 'said only after an idle answer');
  page.focused = true;
});

test('not idle while Safari isn\'t in use, the page hidden or in full screen, media playing, Margin busy, or text being composed', async () => {
  await sleep(130);
  page.focused = false;
  assert.equal(watch.ask(ASK).why, 'not focused');
  page.focused = true;
  page.visible = false;
  assert.equal(watch.ask(ASK).why, 'hidden');
  page.visible = true;
  page.fullscreen = {};
  assert.equal(watch.ask(ASK).why, 'full screen');
  page.fullscreen = null;
  page.media = [{ paused: false, ended: false, readyState: 4 }];
  assert.equal(watch.ask(ASK).why, 'playing');
  page.media = [{ paused: true, ended: false, readyState: 4 }];
  busy = 'palette';
  assert.equal(watch.ask(ASK).why, 'palette');
  busy = null;
  fire(windowListeners, 'compositionstart');
  await sleep(130);
  assert.equal(watch.ask(ASK).why, 'typing');
  fire(windowListeners, 'compositionend');
  await sleep(130);
  assert.deepEqual(watch.ask(ASK), { idle: true });
});

test('focus in a frame (its input never reaches this page): never idle; in a text field here, a pause in typing three times as long', async () => {
  await sleep(130);
  assert.deepEqual(watch.ask(ASK), { idle: true });
  // The top document has focus while a frame in it does (an editor, a card field).
  page.active = { tagName: 'IFRAME' };
  assert.equal(watch.ask(ASK).why, 'in a frame');
  // Inside a shadow root too.
  page.active = { tagName: 'X-EDITOR', shadowRoot: { activeElement: { tagName: 'IFRAME' } } };
  assert.equal(watch.ask(ASK).why, 'in a frame');
  // A text field: a key 130 ms ago is more than keysMs (120), less than three times it.
  page.active = { tagName: 'INPUT', type: 'text' };
  fire(windowListeners, 'keydown');
  await sleep(130);
  assert.equal(watch.ask(ASK).why, 'typing');
  page.active = { tagName: 'INPUT', type: 'checkbox' };
  assert.deepEqual(watch.ask(ASK), { idle: true });
  page.active = { tagName: 'DIV', isContentEditable: true };
  assert.equal(watch.ask(ASK).why, 'typing');
  await sleep(250);
  assert.deepEqual(watch.ask(ASK), { idle: true });
  page.active = null;
});

test('the run over: the listeners come off at once', () => {
  watch.end();
  assert.equal(count(windowListeners) + count(docListeners), 0);
  fire(windowListeners, 'keydown');
  assert.ok(acted.length <= 3);
});

test('told to watch first (after a relaunch, while the run waits to start): the first ask knows what came; with no key since and focus not in a text field, a pointer\'s pause is enough', async () => {
  const fresh = createIdleWatch({ busy: () => null, acted: () => {} });
  const before = count(windowListeners);
  assert.deepEqual(fresh.watch(), { watching: true });
  assert.ok(count(windowListeners) > before, 'listening from the watch on');
  await sleep(70); // past idleMs (60), short of keysMs (120)
  assert.deepEqual(fresh.ask(ASK), { idle: true });
  // A key since: the longer pause for typing again.
  fire(windowListeners, 'keydown');
  await sleep(70);
  assert.equal(fresh.ask(ASK).why, 'typing');
  // A watch an ask began (no prime: it missed the page, or came off after
  // WATCH_MS): keys before it unknown, the longer pause kept.
  const unprimed = createIdleWatch({ busy: () => null, acted: () => {} });
  assert.equal(unprimed.ask(ASK).why, 'watching');
  await sleep(70);
  assert.equal(unprimed.ask(ASK).why, 'watching', 'past idleMs, short of keysMs: still watching');
  unprimed.watch(); // (a prime after the ask began it changes nothing)
  assert.equal(unprimed.ask(ASK).why, 'watching');
  unprimed.end();
  // In a text field: three times keysMs, key or not.
  const field = createIdleWatch({ busy: () => null, acted: () => {} });
  field.watch();
  page.active = { tagName: 'TEXTAREA' };
  await sleep(70);
  assert.equal(field.ask(ASK).why, 'watching');
  page.active = null;
  fresh.end();
  field.end();
});
