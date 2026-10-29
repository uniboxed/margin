// Margin's state as kept in storage.local. Most of it under its own name;
// what holds tab and window ids under names of its own: copies of Margin from
// before copies stood back for the newest (shared/owner.js) keep writing
// their own tab ids under the old names while they run (Safari keeps an old
// copy running after an update or a rebuild, until it quits), and the copies
// don't hear each other's writes (checked in WebKit), so sharing those names
// let an old copy overwrite the tab list pages draw. Spaces, pins, folders,
// the archive and settings hold no ids and stay where they were.
//
// The open tabs, their spaces and each window's space go in one value,
// `openTabs`: { origin, since, synced, tabs, tabSpace, activeSpaceByWindow }. One
// key is one write (Safari writes a set() key by key and stops at the first
// failure), so pages never see the tabs without their spaces; and it says
// whose ids they are (`origin` and `since`, the copy that wrote it: Chrome
// keeps its address across browser restarts) and whether that copy
// has matched them to the open tabs (`synced`), in the same write.
// `lostTabs` (only the background reads it) has a name of its own.
//
// The background (background/store.js) and pages (content/core.js, the
// new-tab page) read through here. Pure.

/** The state keys kept in `openTabs`. */
export const OPEN_TABS_KEYS = Object.freeze(['tabs', 'tabSpace', 'activeSpaceByWindow']);
export const OPEN_TABS = 'openTabs';
/** Other state keys stored under another name. */
const RENAMED = Object.freeze({ lostTabs: 'lostTabs2' });

/** @param {string} key a state key @returns {string} the storage key it's kept under */
export const storedName = (key) => (OPEN_TABS_KEYS.includes(key) ? OPEN_TABS : /** @type {Record<string, string>} */ (RENAMED)[key] ?? key);

/**
 * What storage.local returned, as state: the open tabs from `openTabs`, and
 * whose they are (`openTabsBy`: { origin, synced }, or null). Before Margin
 * first wrote those (just updated from a build that didn't), from the old
 * names, once.
 * @param {Record<string, any>} raw
 * @returns {any} the state's keys (filled in by state/model.js normalizeState in the background)
 */
export function fromStorage(raw) {
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
 * @param {Record<string, any>} state @param {string[]} keys @param {{ origin: string, since?: number, synced: boolean }} by
 */
export function toStorage(state, keys, { origin, since, synced }) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of keys) {
    if (OPEN_TABS_KEYS.includes(key)) continue;
    out[storedName(key)] = state[key];
  }
  if (keys.some((key) => OPEN_TABS_KEYS.includes(key))) {
    out[OPEN_TABS] = { origin, since, synced, ...Object.fromEntries(OPEN_TABS_KEYS.map((key) => [key, state[key]])) };
  }
  return out;
}

/**
 * The state with what storage.onChanged reported (`changes`: key → { newValue }),
 * as fromStorage would read it. The old names of the open tabs (another
 * copy's writes) change nothing.
 * @param {Record<string, any>} state @param {Record<string, { newValue?: any }>} changes
 * @returns {any}
 */
export function withChanges(state, changes) {
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
 * @param {{ origin?: string, since?: number, synced?: boolean } | null | undefined} by @param {string} origin @param {number | null} [since]
 */
export function openTabsCurrent(by, origin, since = null) {
  return !!by && by.origin === origin && by.synced === true && (since == null || by.since == null || by.since === since);
}
