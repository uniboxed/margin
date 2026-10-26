import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeholderPlan } from '../extension/background/registered.js';
import { FRAME_AWARE_PATTERNS } from '../extension/shared/shell-logic.js';

const keepOpen = { sidebarPinnedOpen: true, themes: { arcadium: { sidebarWidth: 300 } } };
const full = 'themes/arcadium/docked/w-300.css';
const rail = 'themes/arcadium/docked/rail.css';

test('placeholders: none without Keep open', () => {
  assert.deepEqual(placeholderPlan({ sidebarPinnedOpen: false }, { fits: true }), []);
});

test('placeholders: the full sidebar everywhere when the rail is off', () => {
  assert.deepEqual(placeholderPlan({ ...keepOpen, compactWhenPushed: false }, { fits: true }), [
    { id: 'margin-docked', css: [full], matches: ['<all_urls>'], excludeMatches: [] },
  ]);
});

test('placeholders: pages known to be pushed get the rail\'s, the rest the full sidebar\'s', () => {
  const plan = placeholderPlan({ ...keepOpen, fitPagesExcept: ['https://example.com'] }, { fits: true });
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
  assert.deepEqual(placeholderPlan({ ...keepOpen, fitPages: false }, { fits: true }), only);
  assert.deepEqual(placeholderPlan(keepOpen, { fits: false }), only);
});
