// shared/away.js: the page in front tells the background when Safari is left
// for another app, against a small fake of the window.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const listeners = new Map();
const page = { focus: true, visibility: 'visible' };
globalThis.window = globalThis;
globalThis.addEventListener = (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
const docListeners = new Map();
globalThis.document = /** @type {any} */ ({ hasFocus: () => page.focus, get visibilityState() { return page.visibility; }, addEventListener: (type, fn) => docListeners.set(type, [...(docListeners.get(type) ?? []), fn]) });
const visibility = (state) => { page.visibility = state; for (const fn of docListeners.get('visibilitychange') ?? []) fn({ type: 'visibilitychange' }); };
const fire = (type, { target = window, isTrusted = true } = {}) => { for (const fn of listeners.get(type) ?? []) fn({ type, target, isTrusted }); };

const { watchAway } = await import('../extension/shared/away.js');
const sent = [];
let on = true;
watchAway({ isOn: () => on, send: (type, payload) => sent.push(payload ? [type, payload] : [type]) });
const types = () => sent.map(([type]) => type);
// Every test starts with the page focused and nothing being watched.
function reset() {
  page.focus = true;
  page.visibility = 'visible';
  on = true;
  fire('focus');
  sent.length = 0;
}

test('away: Safari left with the page in front and in sight says so once, with when it lost focus; its focus back says so once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000 });
  reset();
  page.focus = false;
  fire('blur');
  t.mock.timers.tick(5);
  fire('blur'); // (again before the focus)
  t.mock.timers.tick(5);
  assert.deepEqual(sent, [['away', { at: 1_000 }]], 'when it lost focus: the background doesn\'t count it if Safari was in use since');
  page.focus = true;
  fire('focus');
  fire('focus');
  assert.deepEqual(types(), ['away', 'back']);
  t.mock.timers.tick(10_000);
  assert.deepEqual(types(), ['away', 'back'], 'nothing watched once back');
});

test('away: not for a page hidden as it loses focus (a switch to another tab), an element\'s blur, a page\'s own event, or with keep-ready off', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 2_000 });
  reset();
  page.focus = false;
  page.visibility = 'hidden';
  fire('blur');
  t.mock.timers.tick(5);
  page.visibility = 'visible';
  fire('blur', { target: {} });
  fire('blur', { isTrusted: false });
  on = false;
  fire('blur');
  t.mock.timers.tick(5_000);
  on = true;
  fire('focus');
  assert.deepEqual(sent, []);
});

test('away: focus in a frame of the page (its window\'s blur isn\'t this one\'s): asked every second, Safari left from there says so, and its focus back in the frame too', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 3_000 });
  reset();
  fire('blur'); // into a frame: still this document's
  t.mock.timers.tick(5);
  assert.deepEqual(sent, []);
  t.mock.timers.tick(5_000);
  assert.deepEqual(sent, [], 'still in the frame');
  page.focus = false; // Safari left: only the frame's window blurs
  t.mock.timers.tick(1_000);
  assert.deepEqual(types(), ['away']);
  page.focus = true; // back into the frame: no focus event here
  t.mock.timers.tick(1_000);
  assert.deepEqual(types(), ['away', 'back']);
  t.mock.timers.tick(10_000);
  assert.deepEqual(types(), ['away', 'back'], 'nothing more asked: back in the frame, it\'s watched again from its next blur');
});

test('away: the frame watch stops as the page is hidden or the window focused; the wait for its focus back ends after 5 s', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 4_000 });
  reset();
  fire('blur');
  t.mock.timers.tick(5);
  page.visibility = 'hidden'; // a switch to another tab
  t.mock.timers.tick(1_000);
  page.visibility = 'visible';
  page.focus = false;
  t.mock.timers.tick(5_000);
  assert.deepEqual(sent, [], 'stopped once hidden');
  page.focus = true;
  fire('blur');
  t.mock.timers.tick(5);
  fire('focus'); // the page itself focused
  page.focus = false;
  t.mock.timers.tick(5_000);
  assert.deepEqual(sent, [], 'stopped once the window had focus');
  // Left from the page itself, and not back within 5 s: no longer asked.
  fire('blur');
  t.mock.timers.tick(5);
  assert.deepEqual(types(), ['away']);
  t.mock.timers.tick(5_000);
  page.focus = true;
  t.mock.timers.tick(5_000);
  assert.deepEqual(types(), ['away'], 'its focus back said by the focus event, or the next switch');
  fire('focus');
  assert.deepEqual(types(), ['away', 'back']);
});

test('away: not said once no hold can still run (the page shown longer ago than keep-ready\'s minutes, and a few seconds), and its focus back not said past 20 s after its word: each can start a background Safari stopped, for nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 10_000 });
  reset();
  const said = [];
  watchAway({ isOn: () => true, holdMs: () => 60_000, send: (type) => said.push(type) });
  t.mock.timers.tick(10_000); // shown 10 s ago: the hold of the switch to it may run
  page.focus = false;
  fire('blur');
  t.mock.timers.tick(5);
  assert.deepEqual(said, ['away']);
  t.mock.timers.tick(30_000);
  page.focus = true;
  fire('focus');
  assert.deepEqual(said, ['away'], 'back 30 s later: the background let go by then (or stopped)');
  t.mock.timers.tick(30_000); // shown 70 s ago
  page.focus = false;
  fire('blur');
  t.mock.timers.tick(5);
  assert.deepEqual(said, ['away'], 'no hold of the switch to it left');
  page.focus = true;
  fire('focus');
  visibility('hidden'); // a switch away and back: a new hold
  visibility('visible');
  page.focus = false;
  fire('blur');
  t.mock.timers.tick(5);
  t.mock.timers.tick(3_000);
  page.focus = true;
  fire('focus');
  assert.deepEqual(said, ['away', 'away', 'back']);
});
