import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeholderPlan } from '../extension/background/registered.js';
import { FRAME_AWARE_PATTERNS } from '../extension/shared/shell-logic.js';

const keepOpen = { sidebarPinnedOpen: true, themes: { arcadium: { sidebarWidth: 300 } } };
const full = 'themes/arcadium/docked/w-300.css';
const rail = 'themes/arcadium/docked/rail.css';

test('placeholders: without Keep open, only the frame', () => {
  assert.deepEqual(placeholderPlan({ sidebarPinnedOpen: false }, { fits: true, fullscreenOnly: false }), [{ id: 'margin-docked', css: ['themes/arcadium/docked/closed.css'], matches: ['<all_urls>'], excludeMatches: [] }], 'hidden: the frame alone');
  assert.deepEqual(placeholderPlan({ sidebarPinnedOpen: false }, { fits: true, fullscreenOnly: true }), [], 'not where Margin works only in full screen');
  assert.deepEqual(placeholderPlan({ sidebarPinnedOpen: false, frameWhenHidden: false }, { fits: true, fullscreenOnly: false }), [], 'the setting off: nothing, as before');
});

test('placeholders: the rail is off for now (platform.compactRail): the full sidebar everywhere, whatever the setting', () => {
  const full = [{ id: 'margin-docked', css: ['themes/arcadium/docked/w-300.css'], matches: ['<all_urls>'], excludeMatches: [] }];
  assert.deepEqual(placeholderPlan(keepOpen, { fits: true }), full);
  assert.deepEqual(placeholderPlan({ ...keepOpen, fitPages: false }, { fits: true }), full);
  assert.deepEqual(placeholderPlan({ ...keepOpen, compactWhenPushed: true }, { fits: false }), full);
});

test('placeholders: the full sidebar everywhere when the rail is off', () => {
  assert.deepEqual(placeholderPlan({ ...keepOpen, compactWhenPushed: false }, { fits: true }), [
    { id: 'margin-docked', css: [full], matches: ['<all_urls>'], excludeMatches: [] },
  ]);
});

test('placeholders: pages known to be pushed get the rail\'s, the rest the full sidebar\'s', () => {
  const plan = placeholderPlan({ ...keepOpen, fitPagesExcept: ['https://example.com'] }, { fits: true, railAvailable: true });
  assert.equal(plan.length, 2);
  const [fitted, pushed] = plan;
  assert.deepEqual(fitted.css, [full]);
  assert.deepEqual(fitted.matches, ['<all_urls>']);
  assert.deepEqual(pushed.css, [rail]);
  assert.deepEqual(pushed.matches, fitted.excludeMatches, 'one or the other, never both');
  assert.ok(pushed.matches.includes('https://example.com/*'), 'a site turned off by hand');
  for (const pattern of FRAME_AWARE_PATTERNS) assert.ok(pushed.matches.includes(pattern), pattern);
});

test('placeholders: every page pushed (fitting off or unavailable) gets the rail\'s', () => {
  const only = [{ id: 'margin-docked-rail', css: [rail], matches: ['<all_urls>'], excludeMatches: [] }];
  assert.deepEqual(placeholderPlan({ ...keepOpen, fitPages: false }, { fits: true, railAvailable: true }), only);
  assert.deepEqual(placeholderPlan(keepOpen, { fits: false, railAvailable: true }), only);
});
