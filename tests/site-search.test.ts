// Site search in the command bar, as Arc's (docs/ARC-COMMAND-BAR.md step 4): what's typed naming a site offers
// "Search <site>" (Tab); with a site chosen, the bar has one row, what's typed searched on that site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../extension/state/model.ts';
import { SITES, siteById, siteFor, siteInk, siteUrl, siteVerb } from '../extension/shared/site-search.ts';
import { rankPalette } from '../extension/shared/search.ts';
import { buildViewModel, type UiState } from '../app/shared/ui/view-model.ts';
import type { State } from '../types/margin.d.ts';

test('the sites: unique ids, each address with one %s, https, a #RRGGBB colour', () => {
  assert.equal(new Set(SITES.map((s) => s.id)).size, SITES.length);
  for (const s of SITES) {
    assert.equal(s.url.split('%s').length, 2, s.id);
    assert.match(s.url, /^https:\/\//, s.id);
    assert.match(s.color, /^#[0-9A-F]{6}$/i, s.id);
    assert.match(siteInk(s), /^#[0-9A-F]{6}$/i, s.id);
    assert.ok(['Search', 'Ask'].includes(siteVerb(s)), s.id);
  }
  assert.ok(Object.isFrozen(SITES));
});

test('siteFor: the start of a site\'s domain or name, two characters or more, one word; www. left off; none else', () => {
  assert.equal(siteFor('youtu')?.id, 'youtube');
  assert.equal(siteFor('YouTube.com')?.id, 'youtube');
  assert.equal(siteFor('www.git')?.id, 'github');
  assert.equal(siteFor('wiki')?.id, 'wikipedia');
  assert.equal(siteFor('googlem')?.id, 'maps', 'its name, spaces left out');
  assert.equal(siteFor('  spot ')?.id, 'spotify', 'trimmed');
  assert.equal(siteFor('go')?.id, 'google', 'the first in the table');
  // The engines and AI answers Arc offers besides its own table.
  assert.deepEqual(['bin', 'duck', 'yah', 'eco', 'perp', 'chat', 'ChatGPT'].map((t) => siteFor(t)?.id), ['bing', 'duckduckgo', 'yahoo', 'ecosia', 'perplexity', 'chatgpt', 'chatgpt']);
  for (const none of ['', 'y', 'you tube', 'example', 'youtube.com/watch', null as unknown as string]) assert.equal(siteFor(none), null, String(none));
});

test('siteUrl: the query encoded into the site\'s address; nothing for an empty one', () => {
  const yt = siteById('youtube')!;
  assert.equal(siteUrl(yt, ' lofi & beats '), 'https://www.youtube.com/results?search_query=lofi%20%26%20beats');
  assert.equal(siteUrl(yt, '   '), null);
  assert.equal(siteUrl(siteById('chatgpt')!, 'what is 2+2?'), 'https://chatgpt.com/?q=what%20is%202%2B2%3F');
  assert.equal(siteUrl(siteById('yahoo')!, 'news'), 'https://search.yahoo.com/search?p=news');
  assert.equal(siteUrl(siteById('duckduckgo')!, 'a b'), 'https://duckduckgo.com/?q=a%20b');
  assert.deepEqual(['youtube', 'chatgpt', 'ecosia'].map((id) => [siteVerb(siteById(id)!), siteInk(siteById(id)!)]), [['Search', '#FFFFFF'], ['Ask', '#FFFFFF'], ['Search', '#39401C']], 'ChatGPT asked; Ecosia\'s dark green on its lime');
  assert.equal(siteById('nope'), null);
  assert.equal(siteById(undefined), null);
});

function state() {
  let s = M.defaultState();
  s = M.upsertTab(s, { id: 1, windowId: 1, index: 0, url: 'https://www.youtube.com/', title: 'YouTube', active: true } as BrowserTab, 1);
  return s;
}
const ctx = { windowId: 1, tabId: 1, inNewTab: false, canToggleSidebar: true, canFullscreen: false };

test('rankPalette on a site: one row, what\'s typed searched there (a new tab, or this one from a new tab); nothing for nothing typed', () => {
  const s = state();
  const rows = rankPalette(s, 'lofi', { ...ctx, site: 'youtube' });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].id, rows[0].kind, rows[0].title, rows[0].search], ['site-go', 'go', 'lofi', true]);
  assert.deepEqual(rows[0].action, { type: 'newTab', windowId: 1, url: 'https://www.youtube.com/results?search_query=lofi' });
  assert.deepEqual(rankPalette(s, 'lofi', { ...ctx, inNewTab: true, site: 'youtube' })[0].action, { local: 'navigate', url: 'https://www.youtube.com/results?search_query=lofi' });
  assert.deepEqual(rankPalette(s, '  ', { ...ctx, site: 'youtube' }), []);
  assert.deepEqual(rankPalette(s, 'you', { ...ctx, site: 'nope' }).map((r) => r.id), rankPalette(s, 'you', ctx).map((r) => r.id), 'an unknown site: the bar as ever');
});

const vm = (palette: NonNullable<UiState['palette']>) =>
  buildViewModel({ state: state() as State, now: 0, ui: { windowId: 1, tabId: 1, mode: 'fullscreen', palette } as UiState, platform: { browser: 'safari', os: 'mac' } }, null).palette;

test('the view: the hint while what\'s typed names a site; the pill (name, colour) once chosen, no hint; neither closed', () => {
  const hint = vm({ open: true, query: 'youtu', selected: 0 });
  assert.deepEqual([hint.site, hint.siteHint], [null, { name: 'YouTube', verb: 'Search' }]);
  assert.deepEqual(vm({ open: true, query: 'chat', selected: 0 }).siteHint, { name: 'ChatGPT', verb: 'Ask' });
  assert.deepEqual(vm({ open: true, query: '', selected: 0, site: 'chatgpt' }).site, { name: 'ChatGPT', color: '#10A37F', ink: '#FFFFFF', verb: 'Ask' });
  const on = vm({ open: true, query: 'lofi', selected: 0, site: 'youtube' });
  assert.deepEqual([on.site, on.siteHint], [{ name: 'YouTube', color: '#FF0000', ink: '#FFFFFF', verb: 'Search' }, null]);
  assert.deepEqual(on.rows.map((r) => [r.id, r.title]), [['site-go', 'lofi']]);
  assert.deepEqual([on.completion, on.fieldIcon], ['', null], 'no completion on a site search');
  const waiting = vm({ open: true, query: '', selected: 0, site: 'youtube' });
  assert.deepEqual([waiting.rows.length, waiting.noMatches], [0, false], 'nothing typed on a site: no rows, no "No matches"');
  assert.equal(vm({ open: true, query: 'zzqqxx', selected: 0 }).noMatches, false, 'the search row is always there typed');
  const closed = vm({ open: false, query: 'youtu', selected: 0 });
  assert.deepEqual([closed.site, closed.siteHint], [null, null]);
  assert.deepEqual(vm({ open: true, query: 'lofi beats', selected: 0 }).siteHint, null);
});
