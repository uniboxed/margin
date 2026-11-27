import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../extension/state/model.ts';
import * as search from '../extension/shared/search.ts';

const { DEFAULT_SETTINGS, normalizeState } = model;

const { resolveInput, searchUrl, engineLabel } = search;

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

test('no search engine of Margin\'s own, none guessed: the old settings are gone, also from saved settings', () => {
  assert.equal('searchEngine' in DEFAULT_SETTINGS, false);
  assert.equal('safariSearch' in DEFAULT_SETTINGS, false);
  const s = normalizeState({ settings: { searchEngine: 'https://duckduckgo.com/?q=%s', safariSearch: { id: 'duckduckgo', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s&t=osx&ia=web', at: 1 }, archiveAfterHours: 3 } });
  assert.equal('searchEngine' in s.settings, false);
  assert.equal('safariSearch' in s.settings, false, 'the engine an older Margin guessed: dropped');
  assert.equal(s.settings.archiveAfterHours, 3);
});

test('which engine\'s site a URL is on, Safari\'s parameters or not (for diagnostics)', () => {
  const { searchEngineOf } = search;
  assert.equal(searchEngineOf('https://search.yahoo.com/search;_ylt=x?p=monkey'), 'Yahoo');
  assert.equal(searchEngineOf('https://www.google.com/search?q=x'), 'Google');
  assert.equal(searchEngineOf('https://example.com/search?q=x'), null);
  assert.equal(searchEngineOf('nope'), null);
});

test('a search the extension makes itself in Safari: Safari\'s default (Google); in Chrome, Chrome\'s engine', () => {
  assert.equal(searchUrl('hello world'), 'https://www.google.com/search?client=safari&rls=en&q=hello%20world&ie=UTF-8&oe=UTF-8');
  assert.equal(searchUrl('c++ & more'), 'https://www.google.com/search?client=safari&rls=en&q=c%2B%2B%20%26%20more&ie=UTF-8&oe=UTF-8');
  assert.equal(engineLabel({ search: 'learn' }), 'Google');
  assert.equal(engineLabel({ search: 'browser' }), 'Chrome’s search engine');
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
  assert.deepEqual(gh.slice(0, 2), ['tab:1', 'go'], 'a tab whose title starts with it: the top hit, above "Search for"');
  assert.equal(gh.at(-1), 'archive:a1', 'archived tabs come last');
  assert.equal(rankPalette(s, 'calendar', ctx)[0].id, 'pin:p1');
});

test('palette: multi-token queries need every token', () => {
  const ids = rankPalette(paletteState(), 'git pull', ctx).map((i) => i.id);
  assert.deepEqual(ids.slice(0, 2), ['tab:1', 'go'], 'each word the start of one of its title\'s: the top hit');
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

// The palette's search (DECISIONS.md "The palette's search: the engine from macOS, its suggestions").
test('palette: past searches never crowd the top; "Search for" first, then the engine\'s suggestions', () => {
  let s = paletteState();
  for (const [i, q] of ['hello', 'hello world', 'hello kitty'].entries()) {
    s = M.archiveTab(s, { id: `g${i}`, url: `https://www.google.com/search?client=safari&rls=en&q=${encodeURIComponent(q)}&ie=UTF-8&oe=UTF-8`, title: `${q} - Google Search`, spaceId: 'personal', closedAt: 10 + i });
  }
  s = M.upsertTab(s, { id: 9, windowId: 1, index: 9, url: 'https://www.google.com/search?q=hello+there', title: 'hello there - Google Search' } as BrowserTab, 9);
  const withSearch = { ...s, search: { query: 'hello', items: ['hello neighbor', 'Hello', 'hello song'], engine: { id: 'duckduckgo', name: 'DuckDuckGo' } } };
  const rows = rankPalette(withSearch as typeof s, 'hello', ctx);
  assert.deepEqual(rows.map((r) => r.id), ['go', 'suggest:0', 'suggest:1', 'tab:9'], 'the old search pages archived aren\'t offered; an open one comes after');
  assert.equal(rows[0].subtitle, 'DuckDuckGo', 'the engine Margin.app named');
  assert.deepEqual(rows.slice(1, 3).map((r) => [r.kind, r.title, r.search]), [['suggestion', 'hello neighbor', true], ['suggestion', 'hello song', true]], 'never the typed text itself');
  assert.deepEqual(rows[1].action, { type: 'search', query: 'hello neighbor', windowId: 1 });
  assert.deepEqual(rankPalette(withSearch as typeof s, 'hello', { ...ctx, inNewTab: true })[1].action, { local: 'search', query: 'hello neighbor' });
});

test('palette: suggestions for what was typed a moment ago, while still the start of them; none for an address', () => {
  const s = { ...paletteState(), search: { query: 'wea', items: ['weather', 'weather nyc', 'wealth'], engine: null } };
  const ids = (q: string) => rankPalette(s as ReturnType<typeof paletteState>, q, ctx).filter((r) => r.kind === 'suggestion').map((r) => r.title);
  assert.deepEqual(ids('wea'), ['weather', 'weather nyc', 'wealth']);
  assert.deepEqual(ids('weat'), ['weather', 'weather nyc'], 'typed on: the ones it still starts');
  assert.deepEqual(ids('we'), [], 'typed back: not this query\'s');
  assert.deepEqual(ids('weather.com'), [], 'an address: none');
  const many = { ...s, search: { query: 'a', items: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], engine: null } };
  assert.equal(rankPalette(many as ReturnType<typeof paletteState>, 'a', ctx).filter((r) => r.kind === 'suggestion').length, 4, 'at most four');
});

test('palette: a top hit: a title or site typed from its start, an app, a command; never a search page', () => {
  const s = paletteState();
  assert.equal(rankPalette(s, 'gmail', ctx)[0].id, 'tab:2', 'its title');
  assert.equal(rankPalette(s, 'mail.goo', ctx)[0].id, 'go', 'an address typed: "Open" first');
  assert.equal(rankPalette(s, 'calen', ctx)[0].id, 'pin:p1', 'a pin');
  assert.equal(rankPalette(s, 'switch work', ctx)[0].id, 'action:space:work', 'a command, by its words');
  assert.equal(rankPalette(s, 'g', ctx)[0].id, 'go', 'one letter: no top hit');
  assert.equal(rankPalette(s, 'pull', ctx)[0].id, 'go', 'one word, inside a title: "Search for" first');
  assert.equal(rankPalette(s, 'pull inbox', ctx)[0].id, 'go', 'words of two titles: no top hit');
  assert.equal(rankPalette(s, 'gmail inb', ctx)[0].id, 'tab:2', 'each word a word\'s start of its title');
  const searched = M.upsertTab(s, { id: 8, windowId: 1, index: 8, url: 'https://duckduckgo.com/?q=docs&t=osx', title: 'docs at DuckDuckGo' } as BrowserTab, 8);
  assert.equal(rankPalette(searched, 'docs', ctx)[0].id, 'go');
  // At most six of the person's own rows, three archived.
  let full = s;
  for (let i = 0; i < 12; i++) full = M.upsertTab(full, { id: 100 + i, windowId: 1, index: 100 + i, url: `https://n${i}.example`, title: `Note ${i}` } as BrowserTab, 100 + i);
  for (let i = 0; i < 6; i++) full = M.archiveTab(full, { id: `n${i}`, url: `https://old${i}.example`, title: `Note old ${i}`, spaceId: 'personal', closedAt: i });
  const rows = rankPalette(full, 'note', ctx);
  assert.equal(rows.filter((r) => r.kind === 'tab').length, 6);
  assert.equal(rows.filter((r) => r.kind === 'archive').length, 3);
});

test('Safari\'s engines: the same search addresses as Margin.app\'s core (tests/fixtures/search-engines.json)', async () => {
  const { readFileSync } = await import('node:fs');
  const v = JSON.parse(readFileSync(new URL('./fixtures/search-engines.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.entries(search.SAFARI_ENGINES).map(([id, e]) => [id, e.template(v.engines.find((x: { id: string }) => x.id === id).host)]), v.engines.map((e: { id: string, search: string }) => [e.id, e.search]));
});
