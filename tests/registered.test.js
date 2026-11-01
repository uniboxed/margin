// What the background registers for the first paint and the page's box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pagePlan, placeholderPlan } from '../extension/background/registered.js';

const keepOpen = { sidebarPinnedOpen: true };
const closed = 'themes/arcadia/docked/closed.css';

test('placeholders: the frame while hidden, the sidebar\'s box with Keep open, none where nothing shows', () => {
  assert.deepEqual(placeholderPlan({ sidebarPinnedOpen: false }, { showing: true }), [{ id: 'margin-docked', css: [closed], matches: ['<all_urls>'] }]);
  assert.deepEqual(placeholderPlan({ sidebarPinnedOpen: false }, { showing: false }), [], 'not where Margin works only in full screen: CSS can\'t tell windows apart');
  assert.deepEqual(placeholderPlan({ sidebarPinnedOpen: false, frameWhenHidden: false }, { showing: true }), [], 'the setting off: no frame');
  assert.deepEqual(placeholderPlan(keepOpen, { showing: true })[0].css, ['themes/arcadia/docked/w-260.css']);
  assert.deepEqual(placeholderPlan({ ...keepOpen, themes: { arcadia: { sidebarWidth: 330 } } }, { showing: true })[0].css, ['themes/arcadia/docked/w-330.css']);
  assert.deepEqual(placeholderPlan(keepOpen, { showing: false }), []);
});

test('the page\'s script: one bundle after where the box starts, only while pages have a box', () => {
  assert.equal(pagePlan({ sidebarPinnedOpen: false }, { showing: true })[0], 'content/page/at-8.js', 'hidden: the frame\'s box');
  assert.equal(pagePlan({ ...keepOpen, frameWhenHidden: false }, { showing: true })[0], 'content/page/at-260.js', 'Keep open has its box whatever the frame does');
  assert.equal(pagePlan({ sidebarPinnedOpen: false, frameWhenHidden: false }, { showing: true }), null, 'no frame, no Keep open: the page as it is, nothing loaded');
  assert.equal(pagePlan(keepOpen, { showing: false }), null, 'Chrome with no window in full screen');
  assert.equal(pagePlan(keepOpen, { showing: true }).at(-1), 'content/page.bundle.js');
});
