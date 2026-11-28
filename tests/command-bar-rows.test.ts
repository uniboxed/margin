// The command bar's rows and field as Arc's (docs/ARC-COMMAND-BAR.md steps 2 and 3): a tab's row its title alone with
// "Switch to Tab" (its space's name in another space) and the arrow; a past page's with its address after it and no
// arrow; the search what's typed alone; the field completing what's typed with the selected row's site or words, its
// icon the row's, nothing after a Backspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../extension/state/model.ts';
import { rankPalette } from '../extension/shared/search.ts';
import { buildViewModel, type UiState } from '../app/shared/ui/view-model.ts';
import type { State } from '../types/margin.d.ts';

const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';
function state() {
  let s = M.defaultState();
  s = M.createSpace(s, { id: 'work', name: 'Work', emoji: '💼' });
  const add = (id: number, title: string, url: string, spaceId: string, extra: Partial<BrowserTab> = {}) => {
    s = M.upsertTab(s, { id, windowId: 1, index: id, url, title, favIconUrl: ICON, ...extra } as BrowserTab, id);
    s = M.moveTab(s, id, spaceId);
  };
  add(1, 'GitHub Pull Requests', 'https://github.com/pulls', 'personal');
  add(2, 'Gmail Inbox', 'https://mail.google.com/mail/u/0/', 'work');
  add(3, 'Current page', 'https://current.example', 'personal', { active: true });
  s = M.archiveTab(s, { id: 'a1', url: 'https://www.youtube.com/watch?v=abc', title: 'Lofi beats', spaceId: 'personal', closedAt: 5 });
  return s;
}
const ctx = { windowId: 1, tabId: 3, inNewTab: false, canToggleSidebar: true, canFullscreen: false };

test('rows as Arc\'s: a tab\'s title alone, "Switch to Tab" in its space, its space\'s name in another; a past page\'s address after it; the search what\'s typed', () => {
  const s = state();
  const gh = rankPalette(s, 'github', ctx).find((r) => r.id === 'tab:1')!;
  assert.deepEqual([gh.detail, gh.badge, gh.completion], ['', 'Switch to Tab', 'github.com']);
  const gm = rankPalette(s, 'gmail', ctx).find((r) => r.id === 'tab:2')!;
  assert.deepEqual([gm.detail, gm.badge, gm.completion], ['', 'Work', 'mail.google.com'], 'in another space: its name');
  const past = rankPalette(s, 'lofi', ctx).find((r) => r.id === 'archive:a1')!;
  assert.deepEqual([past.detail, past.badge, past.completion], ['youtube.com/watch?v=abc', '', 'youtube.com'], 'no scheme, no www.');
  const go = rankPalette(s, 'lofi beats', ctx).find((r) => r.id === 'go')!;
  assert.deepEqual([go.title, go.detail, go.badge], ['lofi beats', '', '']);
  const open = rankPalette(s, 'example.org', ctx)[0];
  assert.deepEqual([open.id, open.title], ['go', 'example.org'], 'an address: as typed');
});

const vm = (query: string, extra: Partial<NonNullable<UiState['palette']>> = {}, s: State = state() as State) =>
  buildViewModel({ state: s, now: 0, ui: { windowId: 1, tabId: 3, mode: 'fullscreen', palette: { open: true, query, selected: 0, ...extra } } as UiState, platform: { browser: 'safari', os: 'mac' } }, null).palette;

test('the field as Arc\'s: what\'s typed completed with the selected row\'s site, its icon the row\'s; none after a Backspace', () => {
  const p = vm('git');
  assert.equal(p.selected, 'tab:1');
  assert.equal(p.completion, 'hub.com', 'github.com after "git"');
  assert.equal(p.fieldIcon, ICON, 'the tab\'s icon in the field');
  assert.equal(vm('git', { noComplete: true }).completion, '', 'just after a Backspace: none');
  assert.equal(vm('GIT').completion, 'hub.com', 'any case');
  // The search selected: what's typed alone, the magnifier.
  const search = vm('git', { selected: 1 });
  assert.equal(search.selected, 'go');
  assert.deepEqual([search.completion, search.fieldIcon], ['', null]);
  // A row whose site doesn't start with what's typed: no completion (Arc's: a tab found by its title).
  const pulls = vm('pull req');
  assert.equal(pulls.rows[0].id === 'tab:1' ? pulls.completion : '', '');
  // A suggestion selected: its words.
  const withSuggestions = { ...state(), search: { query: 'wea', items: ['weather nyc'], engine: null } } as unknown as State;
  const sug = vm('wea', {}, withSuggestions);
  const at = sug.rows.findIndex((r) => r.kind === 'suggestion');
  assert.equal(vm('wea', { selected: at }, withSuggestions).completion, 'ther nyc');
});

test('the arrow box only on rows that switch to something (a tab, a pin, an app): none on a past page or a search', () => {
  const rows = vm('lofi').rows;
  const goes = Object.fromEntries(rows.map((r) => [r.kind, r.goes]));
  assert.equal(goes.archive, false);
  assert.equal(goes.go, false);
  assert.equal(vm('github').rows.find((r) => r.id === 'tab:1')!.goes, true);
});
