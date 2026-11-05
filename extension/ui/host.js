// The host adapter (PLAN.md §1, §2): everything the UI runtime (ui/runtime.js)
// needs from where it runs, and nothing else. The runtime never talks to the
// browser: it reads the state, hears when it changes, sends requests, and
// says where the theme put the page, all through its host.
//
// Two hosts here: a mock for tests, and the in-page host (a closed shadow
// root in each page, Chrome and Edge outside the Mac), which reads the state
// as content/core.js does today (shared/stored.js readForPage, then
// storage.onChanged) and sends with runtime.sendMessage. Margin.app's host
// (Phase 2) implements the same interface over its link.
//
// In pages, content/core.js keeps the state (its reads are tied to switching
// and the page's own start) and hands it to the host (`source`), with its
// own `send` (deadlines, hints, retries) and `perform` (notices, prompts).
// Margin's new-tab page uses the host's own reads.
/** @import { State } from '../../types/margin' */
import * as V from '../shared/view.js';
import { fromStorage, onlyMark, readForPage, takesChanges, withChanges } from '../shared/stored.js';

/**
 * Where the theme put the page (ui/render.js View.measure): `<m-page>`'s
 * content box as insets from the container's edges, its inner corner radius
 * (and each corner's), its border box (`outer`), and the container's size.
 * @typedef {{
 *   insets: { left: number, top: number, right: number, bottom: number },
 *   radius: number,
 *   radii: number[],
 *   outer: { left: number, top: number, right: number, bottom: number, radius: number },
 *   container: { width: number, height: number },
 *   windowId?: number | null,
 *   mode?: string,
 * }} Geometry
 */

/**
 * The host adapter interface.
 *
 * - `getState()`: Margin's state as pages read it (shared/stored.js
 *   fromStorage), or null before the first read;
 * - `onState(cb)`: `cb(state)` on every change worth drawing; returns the
 *   way to stop listening;
 * - `send(type, payload)`: a request to the background's handler `type`
 *   (background/handlers.js); resolves with its result, or undefined when it
 *   failed or went unanswered;
 * - `reportLayout(geometry)`: the page's place, after every layout change;
 * - `platform`: { browser, os, marginFullscreen? };
 * - `windowId`, `tabId`: the browser window the UI is drawn for, and the tab
 *   it's drawn in (in pages; null in the app);
 * - `mode`: 'fullscreen' | 'windowed' | 'inpage';
 * - `inNewTab`: drawn in Margin's new-tab page (the palette navigates it);
 * - `launcher`: drawn in Margin's new-tab page or its start page
 *   (#launcher): the launcher shows;
 * - `perform(name, arg)`: what only the host can do (the page's history in
 *   pages, the window's buttons in the app); false when it can't.
 *
 * @typedef {{
 *   getState(): (Partial<State> & Record<string, any>) | null,
 *   onState(cb: (state: any) => void): () => void,
 *   send(type: string, payload?: Record<string, any>): Promise<any>,
 *   reportLayout(geometry: Geometry): void,
 *   readonly platform: { browser: string, os: string, marginFullscreen?: boolean },
 *   readonly windowId: number | null,
 *   readonly tabId?: number | null,
 *   readonly mode?: 'fullscreen' | 'windowed' | 'inpage',
 *   readonly inNewTab?: boolean,
 *   readonly launcher?: boolean,
 *   perform?(name: string, arg?: any): boolean,
 * }} Host
 */

// ---------------------------------------------------------------------------
// (a) A mock host, for tests: a state set by hand, every request, layout and
// host action recorded.

/**
 * @param {{
 *   state?: any, windowId?: number | null, tabId?: number | null,
 *   platform?: { browser: string, os: string, marginFullscreen?: boolean },
 *   mode?: 'fullscreen' | 'windowed' | 'inpage', inNewTab?: boolean,
 *   replies?: Record<string, (payload: any) => any>,
 * }} [options] `replies`: what a request of each type answers
 */
export function createMockHost({ state = null, windowId = 1, tabId = null, platform = { browser: 'chrome', os: 'linux' }, mode = 'inpage', inNewTab = false, replies = {} } = {}) {
  let current = state;
  const listeners = new Set();
  const host = {
    /** @type {{ type: string, payload: any }[]} */
    sent: [],
    /** @type {Geometry[]} */
    layouts: [],
    /** @type {{ name: string, arg: any }[]} */
    performed: [],
    platform,
    windowId,
    tabId,
    mode,
    inNewTab,
    getState: () => current,
    /** @param {(state: any) => void} cb */
    onState(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    /** @param {string} type @param {any} [payload] */
    async send(type, payload = {}) {
      host.sent.push({ type, payload });
      return replies[type]?.(payload);
    },
    /** @param {Geometry} geometry */
    reportLayout(geometry) { host.layouts.push(geometry); },
    /** @param {string} name @param {any} [arg] */
    perform(name, arg) { host.performed.push({ name, arg }); return true; },
    // Test controls.
    /** @param {any} next */
    setState(next) { current = next; for (const cb of [...listeners]) cb(current); },
    /** @param {(state: any) => any} fn */
    update(fn) { host.setState(fn(current)); },
  };
  return host;
}

// ---------------------------------------------------------------------------
// (b) The in-page host.

const NO_ANSWER = 'no answer';

/**
 * The host in a page: the state from storage.local as content/core.js reads
 * it (readForPage the first time and whenever the page is shown; then each
 * storage.onChanged event taken into the state with withChanges, or a read
 * when one can't be: takesChanges), requests with runtime.sendMessage.
 *
 * `tabId`/`windowId`: the page's tab and window once known (content/core.js
 * learns them from `hello`; `identify` sets them later). Until then the
 * window is the stored record's of that tab, else a guess from the address
 * (shared/view.js guessWindow), as the sidebar guesses today.
 *
 * `source`: a state kept elsewhere (content/core.js): `getState()` and
 * `onState(cb)`; the host then reads nothing itself. `send`: requests go
 * through it instead (same contract: the result, or undefined). `perform`:
 * the host's own actions first (a notice's button, navigating the new-tab
 * page), then the page's history.
 *
 * @param {{
 *   api?: any, window?: any, platform?: any,
 *   tabId?: number | null, windowId?: number | null,
 *   mode?: 'fullscreen' | 'windowed' | 'inpage', inNewTab?: boolean, launcher?: boolean,
 *   timeoutMs?: number, onLayout?: (geometry: Geometry) => void,
 *   warn?: (...args: any[]) => void,
 *   source?: { getState(): any, onState(cb: (state: any) => void): () => void },
 *   send?: (type: string, payload?: Record<string, any>) => Promise<any> | undefined,
 *   perform?: (name: string, arg?: any) => boolean | undefined,
 * }} [options]
 */
export function createInPageHost({
  api = /** @type {any} */ (globalThis).browser ?? /** @type {any} */ (globalThis).chrome,
  window: win = /** @type {any} */ (globalThis).window,
  platform = { browser: 'unknown', os: 'unknown' },
  tabId = null,
  windowId = null,
  mode = 'inpage',
  inNewTab = false,
  launcher = inNewTab,
  timeoutMs = 10000,
  onLayout = undefined,
  warn = (...args) => console.warn('[margin]', ...args),
  source = undefined,
  send: sendVia = undefined,
  perform: performFirst = undefined,
} = {}) {
  const doc = win?.document;
  /** @type {any} */
  let state = null;
  let version = 0; // a read's result is drawn only if nothing newer came meanwhile
  let reading = 0; // reads under way
  let dirty = false; // changed while hidden: drawn when shown
  let dormant = false; // a copy of Margin that doesn't own the state said `stale`
  let destroyed = false;
  const seenKeys = new Set();
  const listeners = new Set();
  /** @type {Geometry | null} */
  let layout = null;
  let ids = { tabId, windowId };

  const hidden = () => doc?.visibilityState === 'hidden';
  const emit = () => { if (state && !destroyed) for (const cb of [...listeners]) cb(state); };

  async function read() {
    const mine = ++version;
    reading++;
    let raw;
    try {
      raw = await readForPage((keys) => api.storage.local.get(keys), () => state, seenKeys);
    } catch (err) {
      warn('reading the state', err);
      return false;
    } finally {
      reading--;
    }
    for (const key of Object.keys(raw)) seenKeys.add(key);
    const next = fromStorage(raw);
    if (destroyed || mine !== version || !next.spaces?.length) return false; // stale, or no state yet
    state = next;
    dirty = false;
    if (!hidden()) emit();
    else dirty = true;
    return true;
  }

  /** @param {Record<string, { newValue?: any }>} changes @param {string} area */
  const onChanged = (changes, area) => {
    if (area !== 'local' || destroyed || dormant) return;
    for (const key of Object.keys(changes)) seenKeys.add(key);
    if (!state) return void read();
    // The background's note of a tab being shown is for that page's own start.
    if (Object.keys(changes).every((key) => key === 'showing')) return;
    if (!takesChanges(changes, { reading, openTabsBy: state.openTabsBy })) return void read();
    const next = withChanges(state, changes);
    if (!next.spaces?.length) return void read();
    version++; // newer than any read started before it
    state = next;
    if (onlyMark(changes)) return;
    if (hidden()) dirty = true;
    else emit();
  };
  const onVisible = () => {
    if (hidden() || destroyed) return;
    // Shown: what storage has now (a hidden page can miss events: Safari
    // suspends hidden tabs), drawn at once from what's here meanwhile.
    if (dirty && state) { dirty = false; emit(); }
    void read();
  };

  let offSource = null;
  /** @type {Promise<boolean>} */
  let ready;
  if (source) {
    offSource = source.onState((next) => { if (next?.spaces?.length && !destroyed) { state = next; emit(); } });
    state = source.getState()?.spaces?.length ? source.getState() : null;
    ready = Promise.resolve(!!state);
  } else {
    api.storage.onChanged.addListener(onChanged);
    doc?.addEventListener('visibilitychange', onVisible);
    ready = read();
  }

  /**
   * @param {string} type @param {Record<string, any>} [payload]
   * @returns {Promise<any>}
   */
  async function send(type, payload = {}) {
    if (sendVia) return destroyed ? undefined : sendVia(type, payload);
    if (!api.runtime?.id || dormant || destroyed) return undefined;
    // A request naming a tab carries its address and place (as content/core.js
    // send does): the background trusts the id only if it's its own copy's,
    // and finds the tab by them otherwise. Not this page's own tab.
    if (Number.isInteger(payload.tabId) && !payload.hint && payload.tabId !== ids.tabId) {
      const tab = state?.tabs?.[payload.tabId];
      if (tab) payload = { ...payload, hint: { url: tab.url, index: tab.index, title: tab.title, from: state?.openTabsBy ?? null } };
    }
    let timer;
    try {
      const res = await Promise.race([
        api.runtime.sendMessage({ type, ...payload }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(NO_ANSWER)), timeoutMs); }),
      ]);
      if (res?.ok) return res.result;
      if (res?.stale) { dormant = true; return undefined; }
      if (res) warn(type, res.error);
      return undefined;
    } catch (err) {
      warn(type, err?.message ?? err);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ready,
    platform,
    mode,
    inNewTab,
    launcher,
    get tabId() { return ids.tabId; },
    get windowId() {
      if (ids.windowId != null) return ids.windowId;
      if (!state) return null;
      const own = ids.tabId != null ? state.tabs?.[ids.tabId] : null;
      return own?.windowId ?? V.guessWindow(state, win?.location?.href) ?? null;
    },
    getState: () => state,
    /** @param {(state: any) => void} cb */
    onState(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    send,
    /** @param {Geometry} geometry */
    reportLayout(geometry) { layout = geometry; onLayout?.(geometry); },
    /** The last layout reported. */
    get layout() { return layout; },
    /** @param {string} name @param {any} [arg] */
    perform(name, arg) {
      const mine = performFirst?.(name, arg);
      if (mine != null) return mine;
      switch (name) {
        case 'nav.back': win.history.back(); return true;
        case 'nav.forward': win.history.forward(); return true;
        case 'nav.reload': win.location.reload(); return true;
        default: return false; // the window's own buttons are the browser's here
      }
    },
    /** The page's tab and window, once known (content/core.js hello). @param {{ tabId?: number | null, windowId?: number | null }} next */
    identify(next) {
      ids = { tabId: next.tabId ?? ids.tabId, windowId: next.windowId ?? ids.windowId };
      emit();
    },
    /** Reads the state again (a page shown, a resync). */
    refresh: () => (source ? Promise.resolve(!!state) : read()),
    get dormant() { return dormant; },
    destroy() {
      destroyed = true;
      listeners.clear();
      offSource?.();
      api.storage.onChanged.removeListener(onChanged);
      doc?.removeEventListener('visibilitychange', onVisible);
    },
  };
}
