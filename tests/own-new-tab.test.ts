// The browser's own new tab for a new tab Margin.app doesn't take (shared/own-new-tab.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownNewTabUrl } from '../extension/shared/own-new-tab.ts';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const EDGE = `${CHROME} Edg/156.0.0.0`;

test('Safari\'s start page, Chrome\'s new tab, none for Edge or another browser', () => {
  assert.equal(ownNewTabUrl('safari', 'Safari'), 'favorites://');
  assert.equal(ownNewTabUrl('chrome', CHROME), 'chrome://new-tab-page/');
  assert.equal(ownNewTabUrl('chrome', EDGE), null, 'Edge: its own is Margin\'s page again; left blank');
  assert.equal(ownNewTabUrl(undefined, CHROME), null);
  assert.equal(ownNewTabUrl('firefox', 'x'), null);
});
