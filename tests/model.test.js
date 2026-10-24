import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultState, normalizeState, DEFAULT_SETTINGS } from '../extension/state/model.js';

test('default state has one Personal space and default settings', () => {
  const s = defaultState();
  assert.equal(s.spaces.length, 1);
  assert.equal(s.spaces[0].name, 'Personal');
  assert.deepEqual(s.settings, DEFAULT_SETTINGS);
});

test('normalizeState fills missing keys and keeps stored ones', () => {
  const s = normalizeState({ settings: { archiveAfterHours: 3 }, pins: [{ id: 'p' }] });
  assert.equal(s.settings.archiveAfterHours, 3);
  assert.equal(s.settings.paletteShortcut, 'Alt+KeyK');
  assert.equal(s.pins.length, 1);
  assert.equal(s.spaces.length, 1);
  assert.deepEqual(s.tabSpace, {});
});
