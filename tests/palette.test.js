// content/palette.js: which palette choices start a switch on the page at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportingSwitches } from '../extension/content/palette.js';
import { NEW_TAB } from '../extension/shared/switching.js';

const run = (type, payload) => {
  const switches = [];
  const send = reportingSwitches(async () => ({ ok: true }), () => null, (tabId, request) => switches.push({ tabId, request }));
  const request = send(type, payload);
  return { switches, request };
};

test('palette: a tab chosen is switched to at once, with its request', () => {
  const { switches, request } = run('activateTab', { tabId: 7 });
  assert.deepEqual(switches.map((s) => s.tabId), [7]);
  assert.equal(switches[0].request, request);
});

test('palette: an address or a search in a new tab covers the page at once (NEW_TAB), before the tab exists', () => {
  assert.deepEqual(run('newTab', { url: 'https://a.test/', windowId: 1 }).switches.map((s) => s.tabId), [NEW_TAB]);
  assert.deepEqual(run('search', { query: 'two words', windowId: 1 }).switches.map((s) => s.tabId), [NEW_TAB]);
});

test('palette: not for a search in this tab, Margin\'s own new-tab page, or other actions', () => {
  assert.deepEqual(run('search', { query: 'x', tabId: 3 }).switches, []);
  assert.deepEqual(run('newTab', { windowId: 1 }).switches, []);
  assert.deepEqual(run('newWindow', {}).switches, []);
  assert.deepEqual(run('pinTab', { tabId: 3 }).switches, []);
});
