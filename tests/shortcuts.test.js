import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../extension/shared/shortcuts.js';

const { parse, matches, fromEvent, format } = globalThis.Margin.shortcuts;
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
