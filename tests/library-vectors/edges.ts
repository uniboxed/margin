// The hand-written vectors (cases/edges.json): the edges the TS tests and the generator rarely reach, each a small
// library and the steps that hit it. Ties first (part 4's "first of several equal": the ids' order, Tirth's answer
// 10, and the localeCompare tie-breaks), then cuts, JS's spaces, addresses (as the browsers parse them), numbers. record.ts gives each
// step its env and records the answers as for the others.

const web = (profile: string | null = null) => ({ kind: 'web', browser: 'safari', profile });
const space = (name: string, order: number, extra: Record<string, unknown> = {}) => ({ name, emoji: '', color: '', order, browser: 'safari', profile: null, ...extra });
const item = (spaceId: string, url: string, extra: Record<string, unknown> = {}) => ({ url, title: url, icon: '', spaceId, order: 0, lastUsed: 100, selected: false, target: web(), ...extra });
const settings = { kind: 'margin', page: 'settings' };

export type Edge = { about: string, values: Record<string, Record<string, unknown>>, steps: Record<string, unknown>[] };

export function edges(): Edge[] {
  const two = { a: space('A', 0), b: space('B', 1) };
  return [
    {
      about: 'ties: two Settings items in a space used at the same time: the id first in localeCompare shown',
      values: { spaces: two, tabs: { 't-b': item('a', 'margin://settings', { target: settings }), 't-A': item('a', 'margin://settings', { target: settings }), 't-a': item('a', 'margin://settings', { target: settings }) }, windows: { 1: { spaceId: 'a' } } },
      steps: [{ perform: 'openMarginPage', payload: { windowId: 1, page: 'settings' } }, { snapshot: true }],
    },
    {
      about: 'ties: a favorite with two items used at the same time: the one first in localeCompare (t-a before t-B) opened and reset',
      values: { spaces: two, favorites: { 'fav-1': { scope: 'global', url: 'https://a.com/', title: 'A', pos: 0, target: web() } }, tabs: { 't-B': item('a', 'https://a.com/x', { favoriteId: 'fav-1' }), 't-a': item('b', 'https://a.com/y', { favoriteId: 'fav-1' }) } },
      steps: [{ perform: 'openFavorite', payload: { windowId: 1, favoriteId: 'fav-1' } }, { perform: 'resetFavorite', payload: { windowId: 1, favoriteId: 'fav-1' } }],
    },
    {
      about: 'ties: a favorite with no item, two items at its address: the first in the ids\' order taken',
      values: { spaces: two, favorites: { 'fav-1': { scope: 'global', url: 'https://a.com/', title: 'A', pos: 0, target: web() } }, tabs: { 't-q': item('a', 'https://a.com/'), 't-p': item('b', 'https://a.com/') } },
      steps: [{ perform: 'openFavorite', payload: { windowId: 1, favoriteId: 'fav-1' } }],
    },
    {
      about: 'ties: a pin with two unbound items at its address, used at the same time; then one bound to it: the bound one',
      values: { spaces: two, pins: { 'p-1': { spaceId: 'a', url: 'https://a.com/', title: 'A', folderId: null, pos: 0, target: web() } }, tabs: { 't-m': item('a', 'https://a.com/'), 't-k': item('a', 'https://a.com/'), 't-x': item('a', 'https://a.com/', { pinnedBy: 'p-1', lastUsed: 5 }) } },
      steps: [{ perform: 'openPin', payload: { windowId: 1, pinId: 'p-1' } }, { perform: 'resetPin', payload: { windowId: 1, pinId: 'p-1' } }, { perform: 'unpin', payload: { pinId: 'p-1' } }],
    },
    {
      about: 'ties: a space\'s front item: equal times, the selected one; equal times and none selected, localeCompare\'s first',
      values: { spaces: two, tabs: { 't-B': item('a', 'https://b.com/'), 't-b': item('a', 'https://c.com/'), 't-a': item('a', 'https://a.com/', { selected: true }), 't-C': item('b', 'https://d.com/'), 't-c': item('b', 'https://e.com/') } },
      steps: [{ perform: 'setSpace', payload: { windowId: 1, spaceId: 'a' } }, { perform: 'setSpace', payload: { windowId: 1, spaceId: 'b' } }, { perform: 'closeTab', payload: { tabId: 't-a' } }, { perform: 'unloadTab', payload: { windowId: 1, tabId: 't-B' } }],
    },
    {
      about: 'ties: spaces and link rules at equal orders, in localeCompare\'s order of their ids (a before B before b)',
      values: { spaces: { 'sp-b': space('b', 0), 'sp-B': space('B', 0), 'sp-a': space('a', 0), 'sp-10': space('10', 0), 'sp-9': space('9', 0) }, airTraffic: { 'atc-b': { pattern: 'a.com', spaceId: 'sp-b', order: 0 }, 'atc-a': { pattern: 'a.com', spaceId: 'sp-a', order: 0 } } },
      steps: [{ snapshot: true }, { normal: true }, { perform: 'routeUrl', payload: { url: 'https://a.com/' } }, { perform: 'newTab', payload: { url: 'https://a.com/x' } }, { perform: 'orderSpaces', payload: { spaceIds: ['sp-9'] } }],
    },
    {
      about: 'ties: the archive at equal times, newest first then by id; restoring the last of a space',
      values: { spaces: two, archive: { 'a-b': { url: 'https://b.com/', title: 'B', spaceId: 'a', icon: '', closedAt: 5, target: web() }, 'a-B': { url: 'https://c.com/', title: 'C', spaceId: 'a', icon: '', closedAt: 5, target: web() }, 'a-a': { url: 'https://a.com/', title: 'A', spaceId: 'b', icon: '', closedAt: 5, target: web() } }, windows: { 1: { spaceId: 'a' } } },
      steps: [{ snapshot: true }, { perform: 'restoreLastArchive', payload: { windowId: 1 } }, { perform: 'restoreLastArchive', payload: { windowId: 2 } }],
    },
    {
      about: 'ties: a clear of four or more items (more ids than the app gives) in the ids\' order',
      values: { spaces: two, tabs: { 't-d': item('a', 'https://d.com/'), 't-B': item('a', 'https://b.com/'), 't-a': item('a', 'https://a.com/'), 't-c': item('a', 'https://c.com/'), 't-e': item('a', 'app://com.apple.Notes', { target: { kind: 'app', bundleId: 'com.apple.Notes', name: 'Notes' } }) } },
      steps: [{ perform: 'clearToday', payload: { windowId: 1 } }, { snapshot: true }],
    },
    {
      about: 'ties: items at equal places, one placed beside another (midpoints, the tight renumbering)',
      values: { spaces: two, tabs: { 't-1': item('a', 'https://a.com/', { order: 1 }), 't-2': item('a', 'https://b.com/', { order: 1 }), 't-3': item('a', 'https://c.com/', { order: 1 + 1e-7 }), 't-4': item('a', 'https://d.com/', { order: 2 }) } },
      steps: [{ perform: 'moveTab', payload: { tabId: 't-4', nextTo: 't-2', side: 'before' } }, { perform: 'moveTab', payload: { tabId: 't-1', nextTo: 't-3', side: 'after' } }, { perform: 'duplicateTab', payload: { tabId: 't-2' } }],
    },
    {
      about: 'cuts: names, titles, given titles and emoji cut through an emoji (the broken half dropped)',
      values: { spaces: { a: space(`${'n'.repeat(199)}😀`, 0, { emoji: `${'e'.repeat(15)}😀` }) }, tabs: { 't-1': item('a', 'https://a.com/', { title: `${'t'.repeat(1999)}😀` }) } },
      steps: [
        { snapshot: true }, { normal: true },
        { perform: 'renameTab', payload: { tabId: 't-1', title: `${'g'.repeat(79)}😀x` } },
        { perform: 'createFolder', payload: { name: `${'f'.repeat(39)}😀x` } },
        { perform: 'addItem', payload: { url: 'https://b.com/', title: `${'u'.repeat(1999)}😀x` } },
        { perform: 'updateItem', payload: { tabId: 't-1', title: `${'v'.repeat(1998)}😀x` } },
        { perform: 'createSpace', payload: { name: `${'s'.repeat(199)}😀`, emoji: `${'m'.repeat(15)}😀`, color: `${'c'.repeat(31)}😀` } },
      ],
    },
    {
      about: 'spaces: JS\'s whitespace trimmed (U+FEFF, U+3000), not U+0085 nor U+180E',
      values: { spaces: { a: space('A', 0) } },
      steps: [
        { perform: 'createSpace', payload: { name: '﻿ Work 　' } }, { perform: 'createSpace', payload: { name: '\u0085Next᠎' } },
        { perform: 'renameSpace', payload: { spaceId: 'a', name: '   ' } }, { perform: 'createFolder', payload: { name: ' F ' } },
        { perform: 'renameFolder', payload: { folderId: 'f-none', name: 'x' } },
      ],
    },
    {
      about: 'addresses as the browsers parse them (Tirth\'s answer 11; Margin.app\'s JavaScriptCore had no URL): a trailing slash and a fragment make no other address; a link rule routes',
      values: { spaces: two, pins: { 'p-1': { spaceId: 'a', url: 'https://a.com', title: 'A', folderId: null, pos: 0, target: web() } }, favorites: { 'fav-1': { scope: 'global', url: 'https://b.com/', title: 'B', pos: 0, target: web() } }, tabs: { 't-1': item('a', 'https://a.com/'), 't-2': item('a', 'https://b.com/#top') }, airTraffic: { 'atc-1': { pattern: 'c.com', spaceId: 'b', order: 0 } } },
      steps: [
        { perform: 'openPin', payload: { windowId: 1, pinId: 'p-1' } }, { perform: 'openFavorite', payload: { windowId: 1, favoriteId: 'fav-1' } },
        { perform: 'addFavorite', payload: { windowId: 1, url: 'https://b.com' } }, { perform: 'routeUrl', payload: { url: 'https://c.com/' } },
        { perform: 'newTab', payload: { windowId: 1, url: 'https://c.com/' } }, { perform: 'closeTab', payload: { tabId: 't-1' } }, { perform: 'closeTab', payload: { tabId: 't-2' } },
      ],
    },
    {
      about: 'addresses as the browsers parse them: the host\'s case, the scheme\'s default port, dot segments and an empty query make no other address; the path\'s case and the scheme do; the archive keeps one entry an address; a *. rule routes its hosts only',
      values: { spaces: two, windows: { 1: { spaceId: 'a' } }, pins: { 'p-1': { spaceId: 'a', url: 'HTTPS://A.COM:443/x/../y?', title: 'Y', folderId: null, pos: 0, target: web() } }, tabs: { 't-1': item('a', 'https://a.com/y#top'), 't-2': item('a', 'https://b.com/') }, archive: { 'a-1': { url: 'https://B.COM:443', title: 'B', spaceId: 'a', icon: '', closedAt: 5, target: web() } }, airTraffic: { 'atc-1': { pattern: '*.figma.com', spaceId: 'b', order: 0 } } },
      steps: [
        { perform: 'openPin', payload: { windowId: 1, pinId: 'p-1' } },
        { perform: 'addFavorite', payload: { windowId: 1, url: 'https://a.com/y' } }, { perform: 'addFavorite', payload: { windowId: 1, url: 'HTTPS://a.com:443/y#x' } },
        { perform: 'addFavorite', payload: { windowId: 1, url: 'https://a.com/Y' } }, { perform: 'addFavorite', payload: { windowId: 1, url: 'http://a.com/y' } },
        { perform: 'closeTab', payload: { tabId: 't-2' } },
        { perform: 'routeUrl', payload: { url: 'https://www.figma.com/file/1' } }, { perform: 'routeUrl', payload: { url: 'https://figma.com.evil.example/' } },
        { perform: 'newTab', payload: { windowId: 1, url: 'https://FIGMA.com/' } }, { snapshot: true },
      ],
    },
    {
      about: 'numbers: places and ratios as doubles, window ids as numbers and strings, now with a fraction',
      values: { spaces: two, tabs: { 't-1': item('a', 'https://a.com/', { order: 0.1 + 0.2 }), 't-2': item('a', 'https://b.com/', { order: 9007199254740993 }), 't-3': item('a', 'https://c.com/', { order: -0 }) }, splits: { 'spv-1': { spaceId: 'a', panes: ['t-1', 't-2', 't-3'], axis: 'horizontal', ratios: [1, 1, 1] } } },
      steps: [
        { snapshot: true }, { perform: 'resizeSplit', payload: { splitId: 'spv-1', ratios: [1, 2, 3] } }, { perform: 'activateTab', payload: { windowId: '12', tabId: 't-1' } },
        { perform: 'activateTab', payload: { windowId: 12.5, tabId: 't-2' } }, { perform: 'swapSplit', payload: { splitId: 'spv-1', a: 0, b: 2 } }, { perform: 'forgetWindow', payload: { windowId: 12 } },
      ],
    },
    {
      about: 'payload keys: a number, an array as a tab id (JS\'s property keys), names that are the object prototype\'s',
      values: { spaces: two, tabs: { 't-1': item('a', 'https://a.com/') } },
      steps: [
        { perform: 'activateTab', payload: { tabId: ['t-1'] } }, { perform: 'renameTab', payload: { tabId: 't-1', title: 123 } }, { perform: 'renamePin', payload: { pinId: 'p-none', title: [1, 2] } },
        { perform: 'constructor', payload: {} }, { perform: 'hasOwnProperty', payload: {} }, { perform: '__proto__', payload: {} },
        { perform: 'createSpace', payload: { name: 5 } }, { perform: 'createSpace', payload: { name: { a: 1 } } },
      ],
    },
    {
      about: 'a space\'s background (M2.9): read from each kind of stored value (cut to three colours, lowercased, rounded at the halves, clamped, ids checked); a rename sets, keeps and clears it; a theme keeps it; a new space has none',
      values: { spaces: {
        a: space('A', 0, { background: { colors: ['#F7C7D3', '#cfe8f7', 'x', '#111111', '#222222'], wheel: 'complementary', intensity: 0.555, texture: 'tweed', amount: 0.475, appearance: 'dark', image: { id: 'ab'.repeat(32), fit: 'tile', focus: [0.0005, 1.0005] }, extra: true } }),
        b: space('B', 1, { background: { colors: [], image: { id: 'AB'.repeat(32) } } }),
        c: space('C', 2, { background: { image: { id: '0'.repeat(64), focus: [0.5] } } }),
        d: space('D', 3, { background: [{ colors: ['#111111'] }] }),
      } },
      steps: [
        { snapshot: true }, { normal: true },
        { perform: 'renameSpace', payload: { spaceId: 'b', background: { colors: ['#ABCDEF'], intensity: 0.005, amount: 0.025 } } },
        { perform: 'renameSpace', payload: { spaceId: 'b', background: 'x' } },
        { perform: 'renameSpace', payload: { spaceId: 'b', background: { colors: ['#abcdef'], intensity: -0.2, amount: 0.125, texture: 'none', wheel: 'Analogous', appearance: 'Dark' } } },
        { perform: 'renameSpace', payload: { spaceId: 'a', background: null } },
        { perform: 'renameSpace', payload: { spaceId: 'c', background: {} } },
        { perform: 'setSpaceTheme', payload: { spaceId: 'b', theme: 'pixel' } },
        { perform: 'createSpace', payload: { name: 'N', background: { colors: ['#111111'] } } },
        { snapshot: true }, { normal: true },
      ],
    },
    {
      // The core's one decided difference (DECISIONS.md 2026-11-23 piece 2, vectors.rs KNOWN), here so it has an address
      // no re-recording moves: it was a generated step until the backgrounds' re-recording (2026-11-24) drew others.
      about: 'cuts: a favorite renamed through an emoji to the name it has (library.ts rewrites it, the half dropped; the core sees no change)',
      values: { spaces: two, favorites: { 'fav-1': { scope: 'global', url: 'https://a.com/', title: 'A', customTitle: 'a'.repeat(39), pos: 0, target: web() } } },
      steps: [{ perform: 'renameFavorite', payload: { favoriteId: 'fav-1', title: `${'a'.repeat(39)}😀tail` } }],
    },
  ];
}
