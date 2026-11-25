// The generated vectors (docs/CORE-REFACTOR.md step 4, part 8 (3)): seeded random libraries and random action
// sequences over them, every action with payloads of right and wrong types, ids that exist and don't, titles and
// names cut through an emoji, equal places and times, addresses that differ only by a slash or a fragment. And the
// throw survey's payloads: each action's every field as each wrong JSON type. Pure (a seed in, plain JSON out):
// record.ts gives library.ts the steps and keeps what it answers.

/** mulberry32: the same sequence for a seed in any engine. */
export function random(seed: number) {
  let s = seed | 0;
  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)];
  const chance = (p: number) => next() < p;
  return { next, int, pick, chance };
}
export type Rand = ReturnType<typeof random>;

const EMOJI = '😀';
// Texts at each cut the rules make (2000 a title, 200 a space's or folder's name in stateOf, 40 a folder's name, 80
// a given title, 16 an emoji, 32 a color, 256 a profile), the emoji across the cut; JS's spaces at the ends.
const cutAt = (n: number, ch = 'a') => `${ch.repeat(n - 1)}${EMOJI}tail`;
const TEXTS = ['Work', '  Spaced  ', '﻿BOM﻿', '\u0085Next\u0085', '　Ideo　', '', 'é', 'é', 'Ünïcödé 中文', EMOJI, `${EMOJI}${EMOJI}`, 'a\tb\nc', 'x'.repeat(41), cutAt(40), cutAt(80), cutAt(200), cutAt(16, 'b'), cutAt(32, 'c')];
const LONG_TITLES = [cutAt(2000), 'T'.repeat(2001), `${'t'.repeat(1998)}${EMOJI}`];
const URLS = ['https://a.com', 'https://a.com/', 'https://a.com/#top', 'https://A.COM/', 'https://a.com/x?q=1', 'https://b.a.com/path/sub', 'http://c.com/path', 'https://d.org:443/', 'file:///Users/x/a.html', 'ftp://e.com/', 'data:text/plain,a', 'about:blank', 'app://com.apple.Notes', 'margin://settings', 'https://xn--bcher-kva.example/', 'https://e.com/%7euser', 'https://e.com/a/../b', '', ' https://a.com', 'HTTPS://f.com'];
const ICONS = ['', 'data:image/png;base64,iVBORw0KGgo=', 'https://a.com/favicon.ico', `data:image/png;base64,${'A'.repeat(300)}`, 'javascript:alert(1)'];
const PATTERNS = ['a.com', '*.a.com', 'b.a.com/path', 'c.com/path/*', 'https://d.org', 'not a pattern', '', '*.', 'x', 'E.COM/Path'];
const THEMES = ['pixel', 'liquid-glass', 'material', 'arcadia', 'Nope!', 'a'.repeat(42), ''];
const PROFILES = ['s-default', 's-1234', 'Work Profile', '', `p${'r'.repeat(300)}`];
const BROWSERS = ['safari', 'chrome', 'edge', 'firefox'];
const BUNDLES = ['com.apple.Notes', 'com.apple.TV', 'com.tinyspeck.slackmacgap', '-bad', 'com.apple.Notes'];
/** Wrong JSON types for a field (and the survey's list). */
export const WRONG: readonly unknown[] = [5, -1.5, true, false, null, [], [1, 2], ['t-x'], {}, { a: 1 }, 'x', ''];

const ALNUM = [...'abcdefghijklmnopqrstuvwxyz0123456789'];
const letters = (r: Rand, n: number) => Array.from({ length: n }, () => r.pick(ALNUM)).join('');

function target(r: Rand, browserish = true): any {
  const k = r.int(10);
  if (k < 5 && browserish) return { kind: 'web', browser: r.pick(BROWSERS), profile: r.chance(0.5) ? null : r.pick(PROFILES) };
  if (k < 7) return { kind: 'app', bundleId: r.pick(BUNDLES), ...(r.chance(0.7) ? { name: r.pick(['Notes', 'TV', '', cutAt(100)]) } : {}) };
  if (k < 8) return { kind: 'margin', page: r.pick(['settings', 'nope']) };
  return r.pick([null, 'web', { kind: 'other' }, {}]);
}

// A space's background (M2.9) is drawn from a stream of its own (`bg`, not the sequence's `r`), so `r`'s draws are
// the ones they were. The recorded cases still changed when it came (2026-11-24): a rename that now sets a background
// is a change, merged into the library, which can move its keys, and `spaceIds`' shuffle draws by their order; the
// rest of that run of `r` differs from there. Right and wrong shapes: colours of each kind, every field's values and
// others, numbers to round, clamp and -0, pictures with good and bad ids, values that aren't objects.
const bg = random(0xb6c0de);
const BG_HEXES = ['#f7c7d3', '#CFE8F7', '#000000', '#ffffff', '#abc', 'f7c7d3', '#12345g', '', 5, null];
const BG_ID = 'ab'.repeat(32);
export function background(b: Rand = bg): unknown {
  if (b.chance(0.1)) return b.pick([null, 5, 'x', [], [{ colors: ['#111111'] }], true, {}]);
  const o: Record<string, unknown> = {};
  if (b.chance(0.9)) o.colors = b.chance(0.1) ? b.pick(['#ffffff', 5, null, {}]) : Array.from({ length: b.int(5) }, () => b.pick(BG_HEXES));
  if (b.chance(0.8)) o.wheel = b.pick(['complementary', 'analogous', 'triadic', 5, null]);
  if (b.chance(0.8)) o.intensity = b.pick([0, 1, 0.5, 0.373, 0.375, 0.005, 0.015, 0.1 + 0.2, 0.555, 1.5, -0.2, -0, 'x', null]);
  if (b.chance(0.8)) o.texture = b.pick(['grain', 'sand', 'denim', 'tweed', 'dots', 'grid', 'none', 'GRAIN', 5]);
  if (b.chance(0.8)) o.amount = b.pick([0, 0.45, 0.47, 0.475, 0.025, 0.125, 1, 2, -1, 'x', null]);
  if (b.chance(0.8)) o.appearance = b.pick(['auto', 'light', 'dark', 'Dark', null, 5]);
  if (b.chance(0.3)) {
    o.image = b.pick([
      { id: BG_ID, fit: 'cover', focus: [0.5, 0.5] }, { id: BG_ID.toUpperCase() }, { id: BG_ID.slice(1) },
      { id: '0'.repeat(64), fit: 'stretch', focus: [2, -1] }, { id: 'f'.repeat(64), fit: 'tile', focus: [0.12345, 'x'] },
      { id: BG_ID, fit: 'contain', focus: [1, 2, 3] }, null, 'x', {},
    ]);
  }
  if (b.chance(0.1)) o.extra = 1;
  return o;
}

/** A random library: collection → id → value, the shapes the app stores (and some it would refuse). */
export function library(r: Rand) {
  const spaceIds = Array.from({ length: 1 + r.int(4) }, (_, i) => r.pick(['personal', 'work', `sp-${letters(r, 6)}`, `safari:Personal:${i}`, `chrome:Default:s${i}`]));
  const spaces: Record<string, any> = {};
  for (const id of spaceIds) {
    spaces[id] = {
      name: r.chance(0.8) ? r.pick(TEXTS) : r.pick(WRONG), emoji: r.pick(['🏠', '💼', '', cutAt(16)]), color: r.pick(['#6c5ce7', '', cutAt(32)]),
      order: r.chance(0.3) ? 0 : r.pick([0, 1, 2, 1.5, -1, 'x', null]),
      ...(r.chance(0.8) ? { browser: r.pick(BROWSERS) } : {}),
      ...(r.chance(0.7) ? { profile: r.chance(0.3) ? null : r.pick(PROFILES) } : {}),
      ...(r.chance(0.3) ? { theme: r.pick(THEMES) } : {}),
      ...(bg.chance(0.35) ? { background: background() } : {}),
    };
  }
  const ids = Object.keys(spaces);
  const space = () => (r.chance(0.9) ? r.pick(ids) : r.pick(['gone', 5, null]));
  const tabs: Record<string, any> = {};
  const n = r.int(13);
  const sameTime = 1000 + r.int(3);
  for (let i = 0; i < n; i++) {
    const id = r.chance(0.95) ? `t-${letters(r, 1 + r.int(10))}` : r.pick(['x-1', 't-', `t-${'a'.repeat(31)}`]);
    tabs[id] = {
      url: r.chance(0.9) ? r.pick(URLS) : r.pick(WRONG), title: r.chance(0.04) ? r.pick(LONG_TITLES) : r.pick(TEXTS), icon: r.pick(ICONS), spaceId: space(),
      order: r.chance(0.3) ? 1 : r.pick([0, 1, 2, 2.5, 1.0000001, 1 + 1e-7, -3, 'x', null]), lastUsed: r.chance(0.4) ? sameTime : 1000 + r.int(50), selected: r.chance(0.3) ? true : r.pick([false, 1, 'true']),
      ...(r.chance(0.8) ? { target: target(r) } : {}),
      ...(r.chance(0.15) ? { customTitle: r.pick(TEXTS) } : {}),
      ...(r.chance(0.1) ? { imported: { browser: 'safari', profile: 'Personal', id: `t-${letters(r, 4)}` } } : {}),
    };
  }
  const tabIds = Object.keys(tabs);
  const pins: Record<string, any> = {};
  const folders: Record<string, any> = {};
  for (let i = 0; i < r.int(4); i++) {
    folders[`f-${letters(r, 5)}`] = { spaceId: space(), name: r.pick(TEXTS), open: r.pick([true, false, 0]), pos: r.pick([0, 1, 1, 2.5]), ...(r.chance(0.3) ? { parentId: 'f-loop' } : {}) };
  }
  if (r.chance(0.2)) folders['f-loop'] = { spaceId: ids[0], name: 'Loop', parentId: 'f-loop', pos: 0 };
  const folderIds = Object.keys(folders);
  for (let i = 0; i < r.int(6); i++) {
    const from = tabIds.length && r.chance(0.6) ? tabs[r.pick(tabIds)] : null;
    const id = `p-${letters(r, 5)}`;
    pins[id] = {
      spaceId: from && typeof from.spaceId === 'string' ? from.spaceId : space(), url: from && typeof from.url === 'string' ? (r.chance(0.7) ? from.url : `${from.url}/`) : r.pick(URLS),
      title: r.pick(TEXTS), folderId: folderIds.length && r.chance(0.4) ? r.pick(folderIds) : null, pos: r.pick([0, 1, 1, 2, 0.5]),
      ...(r.chance(0.7) ? { target: target(r) } : {}), ...(r.chance(0.2) ? { customTitle: r.pick(TEXTS) } : {}),
    };
    if (from && r.chance(0.5)) from.pinnedBy = id;
  }
  const favorites: Record<string, any> = {};
  for (let i = 0; i < r.int(5); i++) {
    const id = `fav-${letters(r, 5)}`;
    favorites[id] = { scope: r.pick(['global', 'global', 's-default', 'safari:Personal']), url: r.pick(URLS), title: r.pick(TEXTS), pos: r.pick([0, 1, 1, 3]), ...(r.chance(0.7) ? { target: target(r) } : {}) };
    if (tabIds.length && r.chance(0.4)) tabs[r.pick(tabIds)].favoriteId = id;
  }
  const airTraffic: Record<string, any> = {};
  for (let i = 0; i < r.int(4); i++) airTraffic[`atc-${letters(r, 5)}`] = { pattern: r.pick(PATTERNS), spaceId: space(), enabled: r.pick([true, false, undefined]), order: r.pick([0, 0, 1, 'x']) };
  const splits: Record<string, any> = {};
  for (let i = 0; i < r.int(3); i++) {
    const panes = Array.from({ length: 1 + r.int(5) }, () => (tabIds.length && r.chance(0.85) ? r.pick(tabIds) : r.pick(['t-gone', 5, ''])));
    splits[`spv-${letters(r, 5)}`] = {
      spaceId: space(), panes, axis: r.pick(['horizontal', 'vertical', 'x']),
      ...(r.chance(0.6) ? { ratios: panes.map(() => r.pick([1, 2, 0.5, 0, -1, 'x'])) } : {}),
      ...(r.chance(0.2) ? { pinned: true } : {}), ...(r.chance(0.2) && folderIds.length ? { folderId: r.pick(folderIds) } : {}), ...(r.chance(0.3) ? { pos: r.pick([0, 1.5, 'x']) } : {}),
    };
  }
  const archive: Record<string, any> = {};
  const sameClosed = 900 + r.int(2);
  for (let i = 0; i < r.int(6); i++) archive[`a-${letters(r, 5)}`] = { url: r.pick(URLS), title: r.pick(TEXTS), spaceId: space(), icon: r.pick(ICONS), closedAt: r.chance(0.4) ? sameClosed : 800 + r.int(100), ...(r.chance(0.7) ? { target: target(r) } : {}) };
  const windows: Record<string, any> = {};
  for (const w of ['1', '7', '12']) if (r.chance(0.5)) windows[w] = { spaceId: space() };
  const imports = r.chance(0.2) ? { done: { at: 5, sets: ['safari:Personal'], spaces: 1, pins: 0, folders: 0, tabs: 0, archive: 0 } } : {};
  return { spaces, tabs, pins, folders, favorites, airTraffic, splits, archive, windows, imports };
}

// Each action's payload fields (library.ts ACTIONS: what each reads).
export const FIELDS: Record<string, string[]> = {
  setSpace: ['windowId', 'spaceId'],
  createSpace: ['windowId', 'name', 'emoji', 'color', 'theme', 'browser', 'profile'],
  renameSpace: ['spaceId', 'name', 'emoji', 'color', 'theme', 'profile', 'browser'],
  setSpaceTheme: ['spaceId', 'theme'],
  setSpaceProfile: ['spaceId', 'profile', 'browser'],
  deleteSpace: ['spaceId'],
  orderSpaces: ['spaceIds'],
  newTab: ['windowId', 'spaceId', 'url', 'title', 'target'],
  addItem: ['windowId', 'spaceId', 'url', 'title', 'target', 'pinnedBy', 'favoriteId', 'icon', 'front'],
  updateItem: ['tabId', 'url', 'title', 'icon'],
  openMarginPage: ['page', 'windowId'],
  activateTab: ['tabId', 'windowId'],
  closeTab: ['tabId'],
  unloadTab: ['tabId', 'windowId'],
  duplicateTab: ['tabId', 'windowId'],
  muteTab: ['tabId', 'windowId'],
  mediaControl: ['tabId', 'command', 'windowId'],
  itemClosed: ['tabId'],
  removeItem: ['tabId'],
  moveTabToSpace: ['tabId', 'spaceId'],
  moveTab: ['tabId', 'nextTo', 'side'],
  clearToday: ['windowId'],
  restoreArchive: ['archiveId', 'windowId'],
  restoreLastArchive: ['windowId'],
  pinTab: ['tabId', 'folderId', 'beforeId'],
  unpin: ['pinId'],
  openPin: ['pinId', 'windowId'],
  resetPin: ['pinId', 'windowId'],
  renamePin: ['pinId', 'title'],
  renameTab: ['tabId', 'title'],
  movePin: ['pinId', 'folderId', 'beforeId'],
  addFavorite: ['tabId', 'pinId', 'windowId', 'favoritesScope', 'target', 'url', 'title', 'beforeId'],
  removeFavorite: ['favoriteId'],
  openFavorite: ['favoriteId', 'windowId'],
  resetFavorite: ['favoriteId', 'windowId'],
  renameFavorite: ['favoriteId', 'title'],
  moveFavorite: ['favoriteId', 'beforeId'],
  addAirTrafficRule: ['spaceId', 'windowId', 'pattern', 'enabled'],
  removeAirTrafficRule: ['ruleId'],
  toggleAirTrafficRule: ['ruleId', 'enabled'],
  routeUrl: ['url'],
  createSplit: ['panes', 'spaceId', 'axis', 'ratios', 'focus', 'windowId'],
  addToSplit: ['tabId', 'nextTo', 'splitId', 'windowId'],
  openSplit: ['splitId', 'focus', 'windowId'],
  breakOutSplit: ['tabId', 'windowId'],
  removeFromSplit: ['tabId', 'focus', 'windowId'],
  closeSplitPane: ['tabId'],
  swapSplit: ['splitId', 'a', 'b'],
  resizeSplit: ['splitId', 'ratios'],
  toggleSplitAxis: ['splitId'],
  createFolder: ['tabId', 'parentId', 'spaceId', 'pinIds', 'beforeId', 'name', 'windowId'],
  renameFolder: ['folderId', 'name'],
  setFolderOpen: ['folderId', 'open'],
  deleteFolder: ['folderId'],
  moveFolder: ['folderId', 'parentId', 'beforeId'],
  nestFolder: ['folderId', 'parentId', 'beforeId'],
  forgetWindow: ['windowId'],
};

const keysOf = (values: any, c: string) => Object.keys(values?.[c] ?? {});

/** A right-typed value for a payload field, from what the library has (mostly ids that exist). */
export function field(r: Rand, values: any, name: string): unknown {
  const some = (c: string, prefix: string) => {
    const have = keysOf(values, c);
    return have.length && r.chance(0.85) ? r.pick(have) : `${prefix}-${letters(r, 4)}`;
  };
  switch (name) {
    case 'windowId': return r.chance(0.8) ? r.pick([1, 7, 12, '7']) : r.pick([3, 2.5, '', 'w']);
    case 'spaceId': return some('spaces', 'sp');
    case 'tabId': case 'nextTo': case 'focus': return some('tabs', 't');
    case 'pinId': case 'pinnedBy': return some('pins', 'p');
    case 'favoriteId': return some('favorites', 'fav');
    case 'folderId': case 'parentId': return r.chance(0.2) ? null : some('folders', 'f');
    case 'beforeId': return r.chance(0.4) ? null : r.pick([some('pins', 'p'), some('folders', 'f'), some('favorites', 'fav')]);
    case 'splitId': return some('splits', 'spv');
    case 'archiveId': return some('archive', 'a');
    case 'ruleId': return some('airTraffic', 'atc');
    case 'name': case 'emoji': case 'color': return r.pick(TEXTS);
    case 'title': return r.chance(0.1) ? r.pick(LONG_TITLES) : r.pick(TEXTS);
    case 'url': return r.pick(URLS);
    case 'icon': return r.pick(ICONS);
    case 'target': return target(r);
    case 'theme': return r.pick([...THEMES, null]);
    case 'profile': return r.pick([...PROFILES, null]);
    case 'browser': return r.pick(BROWSERS);
    case 'spaceIds': { const l: unknown[] = keysOf(values, 'spaces'); return [...l].sort(() => r.next() - 0.5).slice(0, r.int(l.length + 1)).concat(r.chance(0.2) ? ['gone', 5] : []); }
    case 'pinIds': { const l = keysOf(values, 'pins'); return l.filter(() => r.chance(0.5)).concat(r.chance(0.2) ? ['p-gone'] : []); }
    case 'panes': { const l = keysOf(values, 'tabs'); return Array.from({ length: r.int(6) }, () => (l.length && r.chance(0.9) ? r.pick(l) : 't-gone')); }
    case 'ratios': return r.pick([[1, 1], [2, 1, 1], [0.5, 0.25, 0.25], [1, 0], [-1, 2], ['a', 1], [1, 1, 1, 1, 1], 5]);
    case 'axis': return r.pick(['vertical', 'horizontal', 'diagonal']);
    case 'side': return r.pick(['before', 'after', 'above']);
    case 'command': return r.pick(['toggle', 'prev', 'next', 'focus', 'mute', 'stop']);
    case 'page': return r.pick(['settings', 'settings', 'nope', 'constructor']);
    case 'favoritesScope': return r.pick(['global', 'profile', 'x']);
    case 'pattern': return r.pick(PATTERNS);
    case 'enabled': case 'open': case 'front': return r.pick([true, false, true, 1, 0]);
    case 'a': case 'b': return r.pick([0, 1, 2, 3, 1.5, -1, '1']);
    default: return null;
  }
}

/** A payload for an action: each field right-typed, left out, or (now and then) a wrong type. */
export function payload(r: Rand, values: any, action: string): unknown {
  if (r.chance(0.02)) return r.pick([null, 5, 'x', [], [1]]);
  const out: Record<string, unknown> = {};
  for (const f of Object.hasOwn(FIELDS, action) ? FIELDS[action] : []) {
    if (r.chance(0.15)) continue;
    out[f] = r.chance(0.1) ? r.pick(WRONG) : field(r, values, f);
  }
  // A rename's background (not in FIELDS: drawn from `bg`, see background()). The throw survey has none to find: no
  // value of it throws in either copy.
  if (action === 'renameSpace' && bg.chance(0.6)) out.background = bg.chance(0.85) ? background() : bg.pick(WRONG);
  return out;
}

/** The next action of a sequence: any of the 57, now and then one the library doesn't take. */
export function action(r: Rand, names: readonly string[]) {
  return r.chance(0.02) ? r.pick(['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '']) : r.pick(names);
}
