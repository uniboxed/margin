import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../extension/state/model.ts';
import * as search from '../extension/shared/search.ts';

const { DEFAULT_SETTINGS, normalizeState } = model;

const { resolveInput, detectSafariSearch, searchUrl, safariEngine, engineLabel, SAFARI_DEFAULT } = search;

test('URLs pass through or get a scheme', () => {
  assert.deepEqual(resolveInput('https://a.com/x'), { kind: 'url', url: 'https://a.com/x' });
  assert.deepEqual(resolveInput('  example.com  '), { kind: 'url', url: 'https://example.com' });
  assert.deepEqual(resolveInput('news.ycombinator.com/item?id=1'), { kind: 'url', url: 'https://news.ycombinator.com/item?id=1' });
  assert.deepEqual(resolveInput('localhost:3000/app'), { kind: 'url', url: 'http://localhost:3000/app' });
  assert.deepEqual(resolveInput('192.168.1.1'), { kind: 'url', url: 'http://192.168.1.1' });
  assert.deepEqual(resolveInput('about:blank'), { kind: 'url', url: 'about:blank' });
});

test('everything else is a search, left to the browser\'s engine', () => {
  assert.deepEqual(resolveInput('  hello world '), { kind: 'search', query: 'hello world' });
  assert.equal(resolveInput('node.js tutorial')!.kind, 'search');
  assert.equal(resolveInput('   '), null);
});

test('no search engine of Margin\'s own: the old setting is gone, also from saved settings', () => {
  assert.equal('searchEngine' in DEFAULT_SETTINGS, false);
  assert.equal(DEFAULT_SETTINGS.safariSearch, null);
  const s = normalizeState({ settings: { searchEngine: 'https://duckduckgo.com/?q=%s', archiveAfterHours: 3 } });
  assert.equal('searchEngine' in s.settings, false);
  assert.equal(s.settings.archiveAfterHours, 3);
});

// Real Safari address-bar searches (macOS, and iOS where they differ), as in
// SafariKeywordSearch's tests (github.com/arnemart/SafariKeywordSearch).
test('Safari\'s own address-bar searches are recognized, with the engine and a matching template', () => {
  const cases = [
    ['https://www.google.com/search?client=safari&rls=en&q=monkey&ie=UTF-8&oe=UTF-8', 'Google', 'https://www.google.com/search?client=safari&rls=en&q=%s&ie=UTF-8&oe=UTF-8'],
    ['https://www.google.co.uk/search?q=monkey&ie=UTF-8&oe=UTF-8&hl=en&client=safari&iga=1', 'Google', 'https://www.google.co.uk/search?client=safari&rls=en&q=%s&ie=UTF-8&oe=UTF-8'],
    ['https://duckduckgo.com/?q=monkey&t=osx&ia=web', 'DuckDuckGo', 'https://duckduckgo.com/?q=%s&t=osx&ia=web'],
    ['https://duckduckgo.com/?q=monkey&t=iphone&ia=web', 'DuckDuckGo', 'https://duckduckgo.com/?q=%s&t=osx&ia=web'],
    ['https://www.bing.com/search?q=monkey&form=APMCS1&PC=APMC', 'Bing', 'https://www.bing.com/search?q=%s&form=APMCS1&PC=APMC'],
    ['https://search.yahoo.com/search?ei=utf-8&fr=aaplw&p=monkey', 'Yahoo', 'https://search.yahoo.com/search?ei=utf-8&fr=aaplw&p=%s'],
    ['https://no.search.yahoo.com/search?p=monkey&fr=iphone&.tsrc=apple', 'Yahoo', 'https://no.search.yahoo.com/search?ei=utf-8&fr=aaplw&p=%s'],
    ['https://www.ecosia.org/search?q=monkey&tts=st_asaf_macos', 'Ecosia', 'https://www.ecosia.org/search?q=%s&tts=st_asaf_macos'],
    // Yahoo's results pages put ;_ylt=…;_ylc=… into the path.
    ['https://search.yahoo.com/search;_ylt=AwrFOX;_ylc=X1MDMjc?p=monkey&fr=aaplw&ei=UTF-8', 'Yahoo', 'https://search.yahoo.com/search?ei=utf-8&fr=aaplw&p=%s'],
  ];
  for (const [url, name, template] of cases) {
    const found = detectSafariSearch(url);
    assert.ok(found, url);
    assert.equal(found.name, name, url);
    assert.equal(found.template, template, url);
  }
});

test('other searches and look-alikes are not Safari\'s engine', () => {
  for (const url of [
    'https://www.google.com/search?q=monkey', // searched on google.com itself
    'https://duckduckgo.com/?q=monkey', // on duckduckgo.com itself
    'https://www.bing.com/search?q=monkey&form=QBLH',
    'https://maps.google.com/?q=monkey&client=safari',
    'https://docs.google.com/search?client=safari&q=x',
    'https://notgoogle.com/search?client=safari&q=monkey',
    'https://www.google.com.evil.com/search?client=safari&q=x',
    'http://www.google.com/search?client=safari&q=x', // not https
    'https://example.com/?q=monkey&t=osx',
    'not a url',
    undefined,
  ]) assert.equal(detectSafariSearch(url as string), null, String(url)); // undefined too: its new URL() throws
});

test('which engine\'s site a URL is on, Safari\'s parameters or not (for diagnostics)', () => {
  const { searchEngineOf } = search;
  assert.equal(searchEngineOf('https://search.yahoo.com/search;_ylt=x?p=monkey'), 'Yahoo');
  assert.equal(searchEngineOf('https://www.google.com/search?q=x'), 'Google');
  assert.equal(searchEngineOf('https://example.com/search?q=x'), null);
  assert.equal(searchEngineOf('nope'), null);
});

test('searches in Safari use the learned engine, else Safari\'s default (Google)', () => {
  assert.equal(searchUrl('hello world', {}), 'https://www.google.com/search?client=safari&rls=en&q=hello%20world&ie=UTF-8&oe=UTF-8');
  assert.equal(safariEngine(null), SAFARI_DEFAULT);
  const settings = { safariSearch: detectSafariSearch('https://duckduckgo.com/?q=x&t=osx&ia=web') };
  assert.equal(searchUrl('c++ & more', settings), 'https://duckduckgo.com/?q=c%2B%2B%20%26%20more&t=osx&ia=web');
  assert.equal(searchUrl('x', { safariSearch: { name: 'Broken', template: 'https://nope' } }), searchUrl('x', {}), 'a template without %s is ignored');
  assert.equal(engineLabel(settings, { search: 'learn' }), 'DuckDuckGo');
  assert.equal(engineLabel(settings, { search: 'browser' }), 'Chrome’s search engine');
});

// ---- fuzzy + palette --------------------------------------------------------


const { fuzzyScore, rankPalette } = search;
const M = model;

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
  const add = (id: number, title: string, url: string, spaceId: string, extra: Partial<BrowserTab> & { lastActive?: number } = {}) => {
    // `active` only when the test says (a tab not in front otherwise).
    s = M.upsertTab(s, { id, windowId: 1, index: id, url, title, ...extra } as BrowserTab, extra.lastActive ?? id);
    s = M.moveTab(s, id, spaceId);
  };
  add(1, 'GitHub Pull Requests', 'https://github.com/pulls', 'work');
  add(2, 'Gmail Inbox', 'https://mail.google.com', 'personal');
  add(3, 'Current page', 'https://current.example', 'personal', { active: true });
  s = M.addPin(s, { id: 'p1', spaceId: 'personal', url: 'https://calendar.example', title: 'Calendar' });
  s = M.archiveTab(s, { id: 'a1', url: 'https://old.example', title: 'Old GitHub issue', spaceId: 'personal', closedAt: 5 });
  return s;
}
// The palette's context: what a test leaves out is off (the view model gives every field).
type Ctx = Parameters<typeof rankPalette>[2];
const ctx = { windowId: 1, tabId: 3, canToggleSidebar: true } as Ctx;

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

test('palette: Settings is directly available; Archive is offered on web pages', () => {
  const s = paletteState();
  assert.deepEqual(rankPalette(s, 'settings', ctx)[0].action, { type: 'openLauncher', windowId: 1, settings: true });
  assert.ok(!rankPalette(s, '', { ...ctx, inNewTab: true }).some((i) => i.id === 'action:launcher'));
});

test('palette: "New window" is always offered, from the window it\'s in (a Margin window of its own on its space: docs/BROWSER-WINDOWS.md §5)', () => {
  const s = paletteState();
  assert.deepEqual(rankPalette(s, 'new window', ctx)[0].action, { type: 'newWindow', fromWindowId: ctx.windowId });
  assert.deepEqual(rankPalette(s, 'new window', { ...ctx, windowId: undefined } as Partial<Ctx> as Ctx)[0].action, { type: 'newWindow' });
  assert.ok(rankPalette(s, '', { ...ctx, inNewTab: true }).some((i) => i.id === 'action:new-window'));
});

test('palette: "Margin full screen" only where the browser has it (Chrome)', () => {
  const state = M.normalizeState({ tabs: { 1: { id: 1, windowId: 1, url: 'https://a.com/', title: 'A' } }, tabSpace: { 1: 'personal' } });
  const has = (ctx: Partial<Ctx>) => rankPalette(state, 'full screen', ctx as Ctx).some((i) => i.id === 'action:fullscreen');
  assert.equal(has({ windowId: 1, tabId: 1, canFullscreen: true }), true);
  assert.equal(has({ windowId: 1, tabId: 1 }), false);
  const item = rankPalette(state, 'full screen', { windowId: 1, tabId: 1, canFullscreen: true } as Ctx).find((i) => i.id === 'action:fullscreen');
  assert.deepEqual(item!.action, { type: 'toggleFullscreen', windowId: 1 });
});

test('Settings has a direct palette action and an internal address alias', () => {
  const s = model.defaultState();
  const context = { windowId: 1, tabId: null, inNewTab: false, canToggleSidebar: false, canFullscreen: false };
  for (const query of ['settings', 'margin://settings', 'MARGIN://SETTINGS/']) {
    const first = search.rankPalette(s, query, context)[0];
    assert.equal(first.title, 'Settings');
    assert.deepEqual(first.action, { type: 'openLauncher', windowId: 1, settings: true });
  }
});
