// Margin's state as kept in storage.local. Most of it under its own name;
// what holds tab and window ids under names of its own: copies of Margin from
// before copies stood back for the newest (shared/owner.ts) keep writing
// their own tab ids under the old names while they run (Safari keeps an old
// copy running after an update or a rebuild, until it quits), and the copies
// don't hear each other's writes (checked in WebKit), so sharing those names
// let an old copy overwrite the tab list pages draw. Spaces, pins, folders,
// the archive and settings hold no ids and stay where they were.
//
// The open tabs, their spaces and each window's space go in one value,
// `openTabs`: { origin, since, synced, tabs, tabSpace, activeSpaceByWindow,
// keptTabs }. One key is one write (Safari writes a set() key by key and stops
// at the first failure), so pages never see the tabs without their spaces,
// nor a tab that closed or opened in both lists or in neither (keptTabs:
// Margin's tabs with no browser tab, state/model.ts); and it says whose ids
// they are (`origin` and `since`, the copy that wrote it: Chrome keeps its
// address across browser restarts) and whether that copy has matched them to
// the open tabs (`synced`), in the same write. `lostTabs` (an earlier build's,
// moved into keptTabs as it's read, then null) has a name of its own.
//
// The background (background/store.ts) and pages (content/core.ts, the
// new-tab page) read through here. Pure.
import { isSheetWalkKey } from './sheet-walk.ts';

/** The state keys kept in `openTabs`. */
export const OPEN_TABS_KEYS = Object.freeze(['tabs', 'tabSpace', 'activeSpaceByWindow', 'awayByWindow', 'keptTabs']);
export const OPEN_TABS = 'openTabs';
/** Other state keys stored under another name. */
const RENAMED = Object.freeze({ lostTabs: 'lostTabs2' });
// Site icons, nearly all of what's stored (some 300 KB of 305 with 120 sites),
// and a short mark of them, written once they're stored (background/store.ts
// flush): a page reads the icons once, then again only when the mark has
// changed (readForPage).
export const FAVICONS = 'favicons';
export const FAVICONS_MARK = 'faviconsMark';
export function faviconsMark(favicons: Record<string, { at?: number }> | null | undefined) {
  const icons = Object.values(favicons ?? {});
  // Every icon learned or fetched again has a new time, and one dropped
  // (the cap) goes with a newer one learned.
  return `${icons.length}:${icons.reduce((sum, icon) => sum + (Number(icon?.at) || 0), 0)}`;
}

/** @param key a state key the storage key it's kept under */
export const storedName = (key: string): string => (OPEN_TABS_KEYS.includes(key) ? OPEN_TABS : (RENAMED as Record<string, string>)[key] ?? key);

/**
 * What storage.local returned, as state: the open tabs from `openTabs`, and
 * whose they are (`openTabsBy`: { origin, synced }, or null). Before Margin
 * first wrote those (just updated from a build that didn't), from the old
 * names, once.
 * the state's keys (filled in by state/model.ts normalizeState in the background)
 */
export function fromStorage(raw: Record<string, any>): any {
  const state = { ...raw };
  delete state[OPEN_TABS];
  const open = raw[OPEN_TABS];
  for (const key of OPEN_TABS_KEYS) state[key] = open ? open[key] : raw[key];
  state.openTabsBy = open ? { origin: open.origin, since: open.since, synced: !!open.synced } : null;
  for (const [key, name] of Object.entries(RENAMED)) state[key] = name in raw ? raw[name] : raw[key];
  return state;
}

/**
 * The storage keys and values to write for `keys` of `state`, as the copy
 * `origin`/`since` (`synced`: whether it has matched the open tabs yet).
 * */
export function toStorage(state: Record<string, any>, keys: string[], { origin, since, synced }: { origin: string, since?: number, synced: boolean }) {
  const out: Record<string, any> = {};
  for (const key of keys) {
    if (OPEN_TABS_KEYS.includes(key)) continue;
    out[storedName(key)] = state[key];
  }
  if (keys.some((key) => OPEN_TABS_KEYS.includes(key))) {
    out[OPEN_TABS] = { origin, since, synced, ...Object.fromEntries(OPEN_TABS_KEYS.filter((key) => state[key] !== undefined).map((key) => [key, state[key]])) };
  }
  // Written in a set() of its own after the rest (background/store.ts flush):
  // never a new mark over old icons.
  if (keys.includes(FAVICONS)) out[FAVICONS_MARK] = faviconsMark(state[FAVICONS]);
  return out;
}
/**
 * Only the icons' mark changed (the icons came before it), or the data set's
 * times for Margin.app (`dataMeta:<collection>`, written on their own:
 * background/store.ts): nothing to draw.
 * */
export const onlyMark = (changes: Record<string, unknown>) => Object.keys(changes).every((key) => key === FAVICONS_MARK || key.startsWith('dataMeta:') || isSheetWalkKey(key));

// What a page reads besides the icons, whatever it has seen so far: the open
// tabs and what the sidebar, the palette and the page's own start use. Keys
// seen in a read or a change event are read too. Never the old names of the
// open tabs (read in full when `openTabs` isn't there), lostTabs (only the
// background's), or the envelope an old development build kept.
const PAGE_KEYS = Object.freeze([OPEN_TABS, 'spaces', 'pins', 'folders', 'archive', 'settings', 'owner', 'showing', 'pageZoom', FAVICONS_MARK]);
// The active theme's package (`uiTheme`, background/theme-package.ts) is
// Margin.app's (the link reads it): never read by a page (Margin 2 Phase 2
// step 7; before, its first read of everything took it, some 100 KB to 3 MB).
const NOT_FOR_PAGES = new Set([FAVICONS, ...OPEN_TABS_KEYS, 'lostTabs', ...Object.values(RENAMED), 'workspace', 'workspaceBackup', 'uiTheme']);
/** @param seen storage keys a page has seen */
// Nor the lasting data set's queue (`dataMeta:<collection>`: shared/data-set.ts), nor the page box's kept sheet
// walks (`sheetWalk:<origin>`, read by content/sheet-walk-link.ts on its own: shared/sheet-walk.ts).
export const pageKeys = (seen: Iterable<string> = []): string[] => [...new Set([...PAGE_KEYS, ...seen])].filter((key) => !NOT_FOR_PAGES.has(key) && !key.startsWith('dataMeta:') && !isSheetWalkKey(key));
// A page's first read: what it reads every time, with the site icons and
// Margin.app's link (`appLink`: shared/app-link.ts). Not all of storage
// (until Margin 2 Phase 2 step 7 it was: get(null), the theme's package with it).
export const firstReadKeys = (seen: Iterable<string> = []): string[] => [...new Set([...pageKeys(seen), FAVICONS, 'appLink'])];
// The open tabs under the names of a build before `openTabs` (just updated
// from one): read when `openTabs` isn't there, with the rest (fromStorage).
const OLD_NAMES = Object.freeze([...OPEN_TABS_KEYS, ...Object.values(RENAMED)]);

/**
 * What a page reads of storage.local (content/core.ts refresh), as storage
 * would return it for fromStorage: firstReadKeys the first time (`page()`,
 * the state the page has, is null), then pageKeys, and the icons only when their
 * mark isn't the one the page had as the read started. Not read, they're the
 * page's own, as it has them once the read is back: it keeps them current
 * from the change events, with their mark, and a page that missed one (Safari
 * suspends hidden tabs) finds the mark changed.
 * @param get storage.local.get
 * @param seen storage keys the page has seen
 * */
export async function readForPage(get: (keys: string[] | null) => Promise<Record<string, any>>, page: () => Record<string, any> | null, seen: Iterable<string> = []): Promise<Record<string, any>> {
  const before = page();
  const first = !before;
  const raw = await get(first ? firstReadKeys(seen) : pageKeys(seen));
  // The open tabs only under their old names (just updated from a build
  // before them): read with them, and the icons (fromStorage).
  if (!(OPEN_TABS in raw)) return { ...raw, ...(await get([...OLD_NAMES, FAVICONS])) };
  if (first) return raw;
  // Against the icons the page has, not the mark it was last told: a page can
  // take the mark's event after a read that came before the icons were
  // stored (between the background's two writes), and would keep old icons
  // under the new mark for good. A store with no mark (icons a build before
  // it wrote, until the background writes it): as the page had it.
  const mine = FAVICONS_MARK in raw ? faviconsMark(before[FAVICONS]) : before[FAVICONS_MARK];
  if (raw[FAVICONS_MARK] !== mine) {
    // Newer than the mark read, if anything: the mark kept is then older
    // than the icons, and they're read again next time, never the other way.
    return { ...raw, ...(await get([FAVICONS])) };
  }
  const now = page() ?? before;
  const { [FAVICONS_MARK]: _, ...rest } = raw;
  const kept = FAVICONS_MARK in raw ? faviconsMark(now[FAVICONS]) : now[FAVICONS_MARK];
  return { ...rest, ...(FAVICONS in now ? { [FAVICONS]: now[FAVICONS] } : {}), ...(kept !== undefined ? { [FAVICONS_MARK]: kept } : {}) };
}

/**
 * The state with what storage.onChanged reported (`changes`: key → { newValue }),
 * as fromStorage would read it. The old names of the open tabs (another
 * copy's writes) change nothing.
 * */
export function withChanges(state: Record<string, any>, changes: Record<string, { newValue?: any }>): any {
  const next = { ...state };
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key === OPEN_TABS) {
      const read = fromStorage({ [OPEN_TABS]: newValue });
      for (const name of [...OPEN_TABS_KEYS, 'openTabsBy']) next[name] = read[name];
    } else if (OPEN_TABS_KEYS.includes(key) || key in RENAMED) {
      continue;
    } else {
      const renamed = Object.entries(RENAMED).find(([, name]) => name === key)?.[0];
      next[renamed ?? key] = newValue;
    }
  }
  return next;
}

/**
 * Whether the stored open tabs are the copy at `origin`'s (and `since`, once
 * known: a page learns it with hello), matched to the open tabs.
 */
export function openTabsCurrent(by: { origin?: string, since?: number, synced?: boolean } | null | undefined, origin: string, since: number | null = null) {
  return !!by && by.origin === origin && by.synced === true && (since == null || by.since == null || by.since === since);
}

/**
 * Whether two values of a state key would be stored the same: as Safari tells
 * a change (storage.onChanged fires only when a value's JSON differs), so a
 * value rebuilt with nothing new isn't written again.
 * */
export const sameStored = (a: any, b: any) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether a page already drawn can take what storage.onChanged reported
 * straight into its state (withChanges), rather than reading storage again
 * (readForPage). Not while a read is under
 * way (the event may be older or newer than what it brings), for a removal
 * (no newValue: storage was cleared), or while the open tabs are still under
 * their old names (only a full read knows them then).
 * */
export const takesChanges = (changes: Record<string, { newValue?: any }>, { reading, openTabsBy }: { reading: number, openTabsBy: any }) => reading === 0 && openTabsBy != null && Object.values(changes).every((change) => change && 'newValue' in change);
