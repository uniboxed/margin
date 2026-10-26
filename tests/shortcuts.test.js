import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as shortcuts from '../extension/shared/shortcuts.js';

const { parse, matches, fromEvent, format } = shortcuts;
const ev = (code, mods = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test('parse', () => {
  assert.deepEqual(parse('Alt+KeyK'), { ctrl: false, alt: true, shift: false, meta: false, code: 'KeyK' });
  assert.equal(parse('Alt'), null);
  assert.equal(parse('Hyper+KeyK'), null);
  assert.equal(parse(''), null);
  assert.equal(parse('KeyK'), null, 'needs a modifier');
  assert.equal(parse('Alt+Escape'), null, 'unsupported key');
});

test('matches uses code and exact modifiers', () => {
  assert.equal(matches(ev('KeyK', { altKey: true }), 'Alt+KeyK'), true);
  assert.equal(matches(ev('KeyK', { altKey: true, shiftKey: true }), 'Alt+KeyK'), false);
  assert.equal(matches(ev('KeyK'), 'Alt+KeyK'), false);
  assert.equal(matches(ev('KeyJ', { altKey: true }), 'Alt+KeyK'), false);
});

test('fromEvent needs a modifier and a real key', () => {
  assert.equal(fromEvent(ev('KeyP', { metaKey: true, shiftKey: true })), 'Shift+Meta+KeyP');
  assert.equal(fromEvent(ev('KeyP')), null);
  assert.equal(fromEvent(ev('AltLeft', { altKey: true })), null);
});

test('format for display', () => {
  assert.equal(format('Alt+KeyK'), '⌥K');
  assert.equal(format('Ctrl+Shift+Digit1'), '⌃⇧1');
  assert.equal(format('nope+'), '');
});

test('navigation defaults (Chrome profile, outside a browser): ⌃⌘ + arrows; stored ones override', () => {
  const { NAVIGATION, navigationFor } = shortcuts;
  assert.equal(format(NAVIGATION.nextTab), '⌃⌘↓');
  assert.equal(format(NAVIGATION.prevTab), '⌃⌘↑');
  assert.equal(format(NAVIGATION.nextSpace), '⌃⌘→');
  assert.equal(format(NAVIGATION.prevSpace), '⌃⌘←');
  assert.equal(matches(ev('ArrowDown', { ctrlKey: true, metaKey: true }), NAVIGATION.nextTab), true);
  assert.equal(matches(ev('ArrowDown', { altKey: true, metaKey: true }), NAVIGATION.nextTab), false);
  assert.equal(matches(ev('ArrowRight', { ctrlKey: true, metaKey: true }), NAVIGATION.nextSpace), true);
  assert.equal(matches(ev('ArrowRight', { altKey: true, metaKey: true }), NAVIGATION.nextSpace), false);
  for (const s of Object.values(NAVIGATION)) assert.ok(parse(s), s);
  assert.deepEqual(navigationFor(undefined), NAVIGATION);
  assert.equal(navigationFor({ shortcuts: { nextSpace: 'Alt+Shift+KeyL' } }).nextSpace, 'Alt+Shift+KeyL');
  assert.equal(navigationFor({ shortcuts: { nextSpace: 'Alt+Shift+KeyL' } }).nextTab, NAVIGATION.nextTab);
  // A shortcut recorded from a real key press round-trips.
  assert.equal(fromEvent(ev('ArrowRight', { ctrlKey: true, metaKey: true })), NAVIGATION.nextSpace);
});
