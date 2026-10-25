import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../extension/shared/platform.js';
import '../extension/shared/search.js';
import '../extension/state/model.js';

const { DEFAULT_SETTINGS } = globalThis.Margin.model;

const { resolveInput, DEFAULT_ENGINE } = globalThis.Margin.search;

test('default engine matches the model default setting', () => {
  assert.equal(DEFAULT_ENGINE, DEFAULT_SETTINGS.searchEngine);
});

test('URLs pass through or get a scheme', () => {
  assert.deepEqual(resolveInput('https://a.com/x'), { kind: 'url', url: 'https://a.com/x' });
  assert.deepEqual(resolveInput('  example.com  '), { kind: 'url', url: 'https://example.com' });
  assert.deepEqual(resolveInput('news.ycombinator.com/item?id=1'), { kind: 'url', url: 'https://news.ycombinator.com/item?id=1' });
  assert.deepEqual(resolveInput('localhost:3000/app'), { kind: 'url', url: 'http://localhost:3000/app' });
  assert.deepEqual(resolveInput('192.168.1.1'), { kind: 'url', url: 'http://192.168.1.1' });
  assert.deepEqual(resolveInput('about:blank'), { kind: 'url', url: 'about:blank' });
});

test('everything else is a search on the configured engine', () => {
  assert.equal(resolveInput('hello world').url, 'https://duckduckgo.com/?q=hello%20world');
  assert.equal(resolveInput('c++').url, 'https://duckduckgo.com/?q=c%2B%2B');
  assert.equal(resolveInput('node.js tutorial').kind, 'search');
  assert.equal(resolveInput('margin', 'https://www.google.com/search?q=%s').url, 'https://www.google.com/search?q=margin');
  assert.equal(resolveInput('x', 'garbage').url, 'https://duckduckgo.com/?q=x');
  assert.equal(resolveInput('   '), null);
});

// ---- fuzzy + palette --------------------------------------------------------

import '../extension/shared/view.js';

const { fuzzyScore, rankPalette } = globalThis.Margin.search;
const M = globalThis.Margin.model;

test('fuzzyScore: substring > word-start subsequence > scattered; misses are -Infinity', () => {
  const sub = fuzzyScore('hub', 'GitHub');
  const prefix = fuzzyScore('git', 'GitHub');
  const scattered = fuzzyScore('gthb', 'GitHub');
  assert.ok(prefix > sub, 'prefix beats inner substring');
  assert.ok(sub > scattered, 'substring beats subsequence');
  assert.ok(scattered > -Infinity);
  assert.equal(fuzzyScore('xyz', 'GitHub'), -Infinity);
  assert.equal(fuzzyScore('', 'anything'), 0);
});

function paletteState() {
  let s = M.defaultState();
  s = M.createSpace(s, { id: 'work', name: 'Work', emoji: '💼' });
  const add = (id, title, url, spaceId, extra = {}) => {
    s = M.upsertTab(s, { id, windowId: 1, index: id, url, title, ...extra }, extra.lastActive ?? id);
    s = M.moveTab(s, id, spaceId);
  };
  add(1, 'GitHub Pull Requests', 'https://github.com/pulls', 'work');
  add(2, 'Gmail Inbox', 'https://mail.google.com', 'personal');
  add(3, 'Current page', 'https://current.example', 'personal', { active: true });
  s = M.addPin(s, { id: 'p1', spaceId: 'personal', url: 'https://calendar.example', title: 'Calendar' });
  s = M.archiveTab(s, { id: 'a1', url: 'https://old.example', title: 'Old GitHub issue', spaceId: 'personal', closedAt: 5 });
  return s;
}
const ctx = { windowId: 1, tabId: 3, canToggleSidebar: true };

test('palette: searches tabs in all spaces, pins, archive; current space ranks first', () => {
  const s = paletteState();
  const ids = rankPalette(s, 'g', ctx).map((i) => i.id);
  assert.ok(ids.indexOf('tab:2') < ids.indexOf('tab:1'), 'Gmail (current space) above GitHub (other space)');
  const gh = rankPalette(s, 'github', ctx).map((i) => i.id);
  assert.deepEqual(gh.slice(0, 2), ['tab:1', 'archive:a1']);
  assert.equal(gh.at(-1), 'go', 'search entry comes last');
  assert.equal(rankPalette(s, 'calendar', ctx)[0].id, 'pin:p1');
});

test('palette: multi-token queries need every token', () => {
  const ids = rankPalette(paletteState(), 'git pull', ctx).map((i) => i.id);
  assert.equal(ids[0], 'tab:1');
  assert.ok(!ids.includes('archive:a1'));
});

test('palette: actions are offered and searchable', () => {
  const s = paletteState();
  const empty = rankPalette(s, '', ctx).map((i) => i.id);
  for (const id of ['action:pin-current', 'action:toggle-sidebar', 'action:space:work']) assert.ok(empty.includes(id), id);
  assert.ok(!empty.includes('action:new-tab'), 'the palette is the new tab, no "New tab" row');
  assert.ok(!empty.includes('tab:3'), 'the current tab is not suggested');
  assert.ok(!empty.includes('action:space:personal'), 'no switch to the current space');
  assert.equal(rankPalette(s, 'switch work', ctx)[0].id, 'action:space:work');
  const pinned = M.addPin(s, { id: 'p2', spaceId: 'personal', url: 'https://current.example/', title: 'C' });
  assert.ok(!rankPalette(pinned, '', ctx).some((i) => i.id === 'action:pin-current'));
  assert.ok(!rankPalette(s, '', { ...ctx, canToggleSidebar: false }).some((i) => i.id === 'action:toggle-sidebar'));
});

test('palette: URLs open first; in the new tab they navigate in place', () => {
  const s = paletteState();
  const [first] = rankPalette(s, 'example.com', ctx);
  assert.deepEqual(first.action, { type: 'newTab', windowId: 1, url: 'https://example.com' });
  const [inNewTab] = rankPalette(s, 'example.com', { ...ctx, inNewTab: true });
  assert.deepEqual(inNewTab.action, { local: 'navigate', url: 'https://example.com' });
});

test('palette: "Margin start page & settings" on web pages, not on the start page itself', () => {
  const s = paletteState();
  assert.deepEqual(rankPalette(s, 'settings', ctx)[0].action, { type: 'openLauncher', windowId: 1 });
  assert.ok(!rankPalette(s, '', { ...ctx, inNewTab: true }).some((i) => i.id === 'action:launcher'));
});

test('palette: "New window" is always offered', () => {
  const s = paletteState();
  assert.deepEqual(rankPalette(s, 'new window', ctx)[0].action, { type: 'newWindow' });
  assert.ok(rankPalette(s, '', { ...ctx, inNewTab: true }).some((i) => i.id === 'action:new-window'));
});
