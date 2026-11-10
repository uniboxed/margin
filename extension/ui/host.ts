// The host adapter (PLAN.md §1, §2): everything the UI runtime (ui/runtime.ts)
// needs from where it runs, and nothing else. The runtime never talks to the
// browser: it reads the state, hears when it changes, sends requests, and
// says where the theme put the page, all through its host.
//
// Two hosts here: a mock for tests, and the in-page host (a closed shadow
// root in each page, Chrome and Edge outside the Mac), which reads the state
// as content/core.ts does today (shared/stored.ts readForPage, then
// storage.onChanged) and sends with runtime.sendMessage. Margin.app's host
// (Phase 2) implements the same interface over its link.
//
// In pages, content/core.ts keeps the state (its reads are tied to switching
// and the page's own start) and hands it to the host (`source`), with its
// own `send` (deadlines, hints, retries) and `perform` (notices, prompts).
// Margin's new-tab page uses the host's own reads.
import type { State } from '../../types/margin';
import * as V from '../shared/view.ts';
import { fromStorage, onlyMark, readForPage, takesChanges, withChanges } from '../shared/stored.ts';
import { isSheetWalkKey } from '../shared/sheet-walk.ts';

/**
 * Where the theme put the page (ui/render.ts View.measure): `<m-page>`'s
 * content box as insets from the container's edges, its inner corner radius
 * (and each corner's), its border box (`outer`), and the container's size.
 */
export type Geometry = {
  insets: { left: number, top: number, right: number, bottom: number },
  radius: number,
  radii: number[],
  outer: { left: number, top: number, right: number, bottom: number, radius: number },
  container: { width: number, height: number },
  windowId?: number | null,
  mode?: string,
};

/**
 * The host adapter interface.
 *
 * - `getState()`: Margin's state as pages read it (shared/stored.ts
 *   fromStorage), or null before the first read;
 * - `onState(cb)`: `cb(state)` on every change worth drawing; returns the
 *   way to stop listening;
 * - `send(type, payload)`: a request to the background's handler `type`
 *   (background/handlers.ts); resolves with its result, or undefined when it
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
 *   pages, the window's buttons in the app); false when it can't;
 * - `focusLauncherAtMount`: false: the launcher's field isn't focused as the
 *   runtime first draws (Margin.app's overlay isn't on screen then; the app
 *   says when: runtime.focusLauncher); left out, it is.
 */
export type Host = {
  getState(): (Partial<State> & Record<string, any>) | null,
  onState(cb: (state: any) => void): () => void,
  send(type: string, payload?: Record<string, any>): Promise<any>,
  reportLayout(geometry: Geometry): void,
  readonly platform: { browser: string, os: string, marginFullscreen?: boolean },
  readonly windowId: number | null,
  readonly tabId?: number | null,
  readonly mode?: 'fullscreen' | 'windowed' | 'inpage',
  readonly inNewTab?: boolean,
  readonly launcher?: boolean,
  readonly focusLauncherAtMount?: boolean,
  perform?(name: string, arg?: any): boolean,
  // Margin.app's imported themes (ui/host-app.ts), for Settings' Remove prompt.
  readonly userThemes?: any[],
};

// ---------------------------------------------------------------------------
// (a) A mock host, for tests: a state set by hand, every request, layout and
// host action recorded.

/**
 * @param options `replies`: what a request of each type answers
 */
export function createMockHost({ state = null, windowId = 1, tabId = null, platform = { browser: 'chrome', os: 'linux' }, mode = 'inpage', inNewTab = false, focusLauncherAtMount = undefined, replies = {} }: {
  state?: any, windowId?: number | null, tabId?: number | null,
  platform?: { browser: string, os: string, marginFullscreen?: boolean },
  mode?: 'fullscreen' | 'windowed' | 'inpage', inNewTab?: boolean,
  focusLauncherAtMount?: boolean,
  replies?: Record<string, (payload: any) => any>,
} = {}) {
  let current = state;
  const listeners = new Set<any>();
  const host = {
    sent: [] as { type: string, payload: any }[],
    layouts: [] as Geometry[],
    performed: [] as { name: string, arg: any }[],
    platform,
    windowId,
    tabId,
    mode,
    inNewTab,
    focusLauncherAtMount,
    getState: () => current,
    onState(cb: (state: any) => void) { listeners.add(cb); return () => listeners.delete(cb); },
    async send(type: string, payload: any = {}) {
      host.sent.push({ type, payload });
      return replies[type]?.(payload);
    },
    reportLayout(geometry: Geometry) { host.layouts.push(geometry); },
    perform(name: string, arg: any) { host.performed.push({ name, arg }); return true; },
    // Test controls.
    setState(next: any) { current = next; for (const cb of [...listeners]) cb(current); },
    update(fn: (state: any) => any) { host.setState(fn(current)); },
  };
  return host;
}

// ---------------------------------------------------------------------------
// (b) The in-page host.

const NO_ANSWER = 'no answer';

/**
 * The host in a page: the state from storage.local as content/core.ts reads
 * it (readForPage the first time and whenever the page is shown; then each
 * storage.onChanged event taken into the state with withChanges, or a read
 * when one can't be: takesChanges), requests with runtime.sendMessage.
 *
 * `tabId`/`windowId`: the page's tab and window once known (content/core.ts
 * learns them from `hello`; `identify` sets them later). Until then the
 * window is the stored record's of that tab, else a guess from the address
 * (shared/view.ts guessWindow), as the sidebar guesses today.
 *
 * `source`: a state kept elsewhere (content/core.ts): `getState()` and
 * `onState(cb)`; the host then reads nothing itself. `send`: requests go
 * through it instead (same contract: the result, or undefined). `perform`:
 * the host's own actions first (a notice's button, navigating the new-tab
 * page), then the page's history.
 */
export function createInPageHost({
  api = (globalThis as any).browser ?? (globalThis as any).chrome,
  window: win = (globalThis as any).window,
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
}: {
  api?: any, window?: any, platform?: any,
  tabId?: number | null, windowId?: number | null,
  mode?: 'fullscreen' | 'windowed' | 'inpage', inNewTab?: boolean, launcher?: boolean,
  timeoutMs?: number, onLayout?: (geometry: Geometry) => void,
  warn?: (...args: any[]) => void,
  source?: { getState(): any, onState(cb: (state: any) => void): () => void },
  send?: (type: string, payload?: Record<string, any>) => Promise<any> | undefined,
  perform?: (name: string, arg?: any) => boolean | undefined,
} = {}) {
  const doc = win?.document;
  let state: any = null;
  let version = 0; // a read's result is drawn only if nothing newer came meanwhile
  let reading = 0; // reads under way
  let dirty = false; // changed while hidden: drawn when shown
  let dormant = false; // a copy of Margin that doesn't own the state said `stale`
  let destroyed = false;
  const seenKeys = new Set<any>();
  const listeners = new Set<any>();
  let layout: Geometry | null = null;
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

  const onChanged = (changes: Record<string, { newValue?: any }>, area: string) => {
    if (area !== 'local' || destroyed || dormant) return;
    // The page box's kept sheet walks (shared/sheet-walk.ts): not state.
    if (Object.keys(changes).every(isSheetWalkKey)) return;
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

  let offSource: (() => void) | null = null;
  let ready: Promise<boolean>;
  if (source) {
    offSource = source.onState((next) => { if (next?.spaces?.length && !destroyed) { state = next; emit(); } });
    state = source.getState()?.spaces?.length ? source.getState() : null;
    ready = Promise.resolve(!!state);
  } else {
    api.storage.onChanged.addListener(onChanged);
    doc?.addEventListener('visibilitychange', onVisible);
    ready = read();
  }

  async function send(type: string, payload: Record<string, any> = {}): Promise<any> {
    if (sendVia) return destroyed ? undefined : sendVia(type, payload);
    if (!api.runtime?.id || dormant || destroyed) return undefined;
    // A request naming a tab carries its address and place (as content/core.ts
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
        new Promise<any>((_, reject) => { timer = setTimeout(() => reject(new Error(NO_ANSWER)), timeoutMs); }),
      ]);
      if (res?.ok) return res.result;
      if (res?.stale) { dormant = true; return undefined; }
      if (res) warn(type, res.error);
      return undefined;
    } catch (err) {
      warn(type, (err as Error | undefined)?.message ?? err);
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
    onState(cb: (state: any) => void) { listeners.add(cb); return () => listeners.delete(cb); },
    send,
    reportLayout(geometry: Geometry) { layout = geometry; onLayout?.(geometry); },
    /** The last layout reported. */
    get layout() { return layout; },
    perform(name: string, arg: any) {
      const mine = performFirst?.(name, arg);
      if (mine != null) return mine;
      switch (name) {
        case 'nav.back': win.history.back(); return true;
        case 'nav.forward': win.history.forward(); return true;
        case 'nav.reload': win.location.reload(); return true;
        default: return false; // the window's own buttons are the browser's here
      }
    },
    /** The page's tab and window, once known (content/core.ts hello). */
    identify(next: { tabId?: number | null, windowId?: number | null }) {
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
