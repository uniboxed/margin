// Keep-ready's hold in the page (content/hold.js): a message answered only
// once the hold is over, against a small fake of the page and the extension's
// runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const listeners = new Map();
const docListeners = new Map();
const page = { visibility: 'hidden' };
const add = (map) => (type, fn) => map.set(type, [...(map.get(type) ?? []), fn]);
const remove = (map) => (type, fn) => map.set(type, (map.get(type) ?? []).filter((f) => f !== fn));
globalThis.addEventListener = add(listeners);
globalThis.removeEventListener = remove(listeners);
const dispatched = [];
globalThis.dispatchEvent = (event) => { dispatched.push(event.type); return true; };
globalThis.document = /** @type {any} */ ({ get visibilityState() { return page.visibility; }, addEventListener: add(docListeners) });
const fire = (type, event = {}) => { for (const fn of listeners.get(type) ?? []) fn({ type, ...event }); };
const onMessage = new Set();
const api = { runtime: { onMessage: { addListener: (fn) => onMessage.add(fn), removeListener: (fn) => onMessage.delete(fn) } } };
// A message as WebKit delivers it: the answer, once sendResponse is called.
function send(message) {
  const answers = [];
  let kept = false;
  for (const fn of onMessage) if (fn(message, {}, (answer) => answers.push(answer)) === true) kept = true;
  return { answers, kept };
}

const { HOLD, RELEASE, listenForHolds } = await import('../extension/content/hold.js');
const holding = listenForHolds(api);

test('hold: answered when its time is up, not before; a release naming another key leaves it running', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hold = send({ type: HOLD, key: 'a', ms: 60_000 });
  assert.equal(hold.kept, true, 'answered later');
  assert.equal(holding(), 1);
  t.mock.timers.tick(59_000);
  send({ type: RELEASE, keys: ['other'] });
  assert.deepEqual(hold.answers, []);
  t.mock.timers.tick(1_000);
  assert.deepEqual(hold.answers, [{ held: true }]);
  assert.equal(holding(), 0);
});

test('hold: answered at once when a release names it (once), when the page is shown, or when it goes away; a release also ends a page-world hold of that key', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = send({ type: HOLD, key: 'a', ms: 60_000 });
  const b = send({ type: HOLD, key: 'b', ms: 60_000 });
  dispatched.length = 0;
  const release = send({ type: RELEASE, keys: ['a'] });
  assert.deepEqual(release.answers, [true]);
  assert.deepEqual(a.answers, [{ held: true }]);
  assert.deepEqual(b.answers, []);
  assert.deepEqual(dispatched, ['margin-release:a'], 'tabs.js keepAwake listens for it');
  send({ type: RELEASE, keys: ['a'] });
  assert.deepEqual(a.answers, [{ held: true }], 'once');
  page.visibility = 'visible';
  for (const fn of docListeners.get('visibilitychange') ?? []) fn();
  page.visibility = 'hidden';
  assert.deepEqual(b.answers, [{ held: true }], 'shown: awake anyway');
  const c = send({ type: HOLD, key: 'c', ms: 60_000 });
  fire('pageswap');
  assert.deepEqual(c.answers, [{ held: true }], 'its page going away');
  t.mock.timers.tick(120_000);
  assert.equal([a, b, c].every((x) => x.answers.length === 1), true, 'never twice');
});

test('hold: off as the page is left (every hold answered first), back if it comes back from the back/forward cache; other messages are left to the page\'s other listener', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = send({ type: HOLD, key: 'a', ms: 60_000 });
  fire('pagehide');
  assert.deepEqual(a.answers, [{ held: true }]);
  assert.equal(onMessage.size, 0, 'no listener holds the page in memory');
  fire('pageshow', { persisted: true });
  assert.equal(onMessage.size, 1);
  const other = send({ type: 'switching', tabId: 3 });
  assert.equal(other.kept, false);
  assert.deepEqual(other.answers, []);
  const long = send({ type: HOLD, key: 'long', ms: 60 * 60_000 });
  t.mock.timers.tick(11 * 60_000);
  assert.deepEqual(long.answers, [{ held: true }], 'never past the longest keep-ready asks for');
});
