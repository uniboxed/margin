// Margin.app's host adapter (PLAN.md §1, §2, §6): the same interface as the
// in-page host (ui/host.js), for the UI runtime drawn in one of the app's
// overlays (app/overlay/overlay.js, in a WKWebView over one browser window).
// The page talks only to the app (webkit.messageHandlers.margin: `post`
// here), and the app to the extension copy over the link (app/PROTOCOL.md):
//
// - the state is the app's copy of the copy's stored values (its mirror):
//   whole in the page's `hello`, then as the app passes changes on
//   (`receive`: state, changes, windows), kept here as the stored keys and
//   turned into the pages' shape with shared/stored.js fromStorage;
// - requests (`send`) go to the app as { op: 'send' } and on to the copy as
//   a `req` for this window; the reply's { ok, result } comes back;
// - layout reports (`reportLayout`: where `<m-page>` sits) go to the app as
//   { op: 'layout' }: it sends them to the copy as `setLayout` for this
//   window, and lets the pointer through to the page over that slot, except
//   over what the theme draws there that takes the pointer (`hitRects`,
//   reported as { op: 'hits' });
// - Margin's new-tab page in front of the window (it draws nothing of its
//   own while the app is linked: newtab/newtab.js): the theme's launcher is
//   drawn here, in the page slot, with its Settings (`launcher`, `inNewTab`
//   and `tabId` follow the window's tab in front), and an address chosen there
//   opens in that tab (`openHere`);
// - what only the app can do (`perform`): the window's own buttons. History
//   (nav.*) isn't the app's: the runtime falls back to the copy's goBack,
//   goForward and reload.
//
// No browser API here: only the DOM and `post`.
/** @import { Geometry, Host } from './host.js' */
import { fromStorage } from '../shared/stored.js';
import { isNewTabPage } from '../shared/view.js';
import { acrossOf, foreignSpace } from '../shared/across.js';

/**
 * The stored values with a change applied, as storage.onChanged reports it
 * (`{ key: { newValue } }`, no newValue for a key removed), and site icons
 * as a diff (`favicons: { set, del }`). A new object; the old is untouched.
 * @param {Record<string, any>} raw
 * @param {Record<string, { newValue?: any }>} changes
 * @param {{ set?: Record<string, any>, del?: string[] } | null} [favicons]
 */
export function applyChanges(raw, changes, favicons = null) {
  const next = { ...raw };
  for (const [key, change] of Object.entries(changes ?? {})) {
    if (key === 'favicons') continue; // only as a diff
    if (change && typeof change === 'object' && 'newValue' in change) next[key] = change.newValue;
    else delete next[key];
  }
  if (favicons && (Object.keys(favicons.set ?? {}).length || (favicons.del ?? []).length)) {
    const icons = { ...(raw.favicons ?? {}), ...(favicons.set ?? {}) };
    for (const site of favicons.del ?? []) delete icons[site];
    next.favicons = icons;
  }
  return next;
}

/** The mode a window's UI is drawn in, from its state (windows.get). @param {any} w */
export const modeOf = (w) => (w?.state === 'fullscreen' ? 'fullscreen' : 'windowed');

/**
 * What the theme draws over the page slot that takes the pointer: the boxes
 * of its elements (not the root, not `<m-page>`) that overlap the slot and
 * whose `pointer-events` isn't `none`, with the root passing the pointer
 * through as the in-page host's does (`m-passthrough`: its children keep
 * theirs). Boxes inside another are left out. `all`: more than `limit`
 * (the app then takes the whole window, never letting the page miss one).
 * @param {Element} root the theme's root
 * @param {{ left: number, top: number, right: number, bottom: number }} slot in the container's pixels
 * @param {{ limit?: number, getStyle?: (el: Element) => { pointerEvents: string, visibility: string } }} [options]
 * @returns {{ rects: number[][], all: boolean }} [x, y, width, height] each
 */
export function hitRects(root, slot, { limit = 64, getStyle = (el) => /** @type {any} */ (el.ownerDocument.defaultView).getComputedStyle(el) } = {}) {
  /** @type {DOMRect[]} */
  const found = [];
  const walk = (/** @type {Element} */ el) => {
    for (const child of /** @type {any} */ (el.children)) {
      if (child.localName === 'm-page' || child.localName === 'template') continue;
      const r = child.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.left < slot.right && r.right > slot.left && r.top < slot.bottom && r.bottom > slot.top) {
        const style = getStyle(child);
        if (style.pointerEvents !== 'none' && style.visibility !== 'hidden') found.push(r);
      }
      walk(child);
    }
  };
  walk(root);
  const inside = (/** @type {DOMRect} */ a, /** @type {DOMRect} */ b) => a !== b && a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
  const kept = found.filter((r, i) => !found.some((o, j) => inside(r, o) || (j < i && o.left === r.left && o.top === r.top && o.right === r.right && o.bottom === r.bottom)));
  if (kept.length > limit) return { rects: [], all: true };
  return { rects: kept.map((r) => [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2) / 2)), all: false };
}

/**
 * The app's host for one window's overlay.
 *
 * `hello`: what the app answered the page's { op: 'hello' }: the window
 * (`windowId`), the copy (`profile`, `browser`), `mode`, `platform`, the
 * stored values (`state`, null before the first snapshot), the copy's
 * window list (`windows`) and the theme package (`theme`). `post(op, body)`:
 * a message to the app, resolving with its reply (webkit.messageHandlers
 * .margin.postMessage). `onMessage(msg)`: what the app sends that isn't the
 * state (theme, command, pointer, pressOutside, push), for the page.
 *
 * @param {{
 *   hello: any,
 *   post: (op: string, body?: Record<string, any>) => Promise<any>,
 *   onMessage?: (msg: any) => void,
 *   warn?: (...args: any[]) => void,
 * }} options
 * @returns {Host & { receive(msg: any): void, readonly windows: any[], readonly layout: Geometry | null, readonly settingsAsked: boolean, readonly pageTabId: number | null, destroy(): void }}
 */
export function createAppHost({ hello, post, onMessage = () => {}, warn = (...args) => console.warn('[margin]', ...args) }) {
  const windowId = Number.isInteger(hello?.windowId) ? hello.windowId : null;
  /** @type {Record<string, any> | null} */
  let raw = hello?.state && typeof hello.state === 'object' ? hello.state : null;
  /** @type {any} */
  let state = null;
  let windows = Array.isArray(hello?.windows) ? hello.windows : [];
  let mode = hello?.mode === 'windowed' ? 'windowed' : 'fullscreen';
  // Every profile's spaces in the one order, and the profiles (app/shell/ShellProfiles.swift): `state.across`.
  let across = acrossOf(hello?.across);
  /** @type {Geometry | null} */
  let layout = null;
  let destroyed = false;
  const listeners = new Set();
  const platform = { browser: String(hello?.platform?.browser ?? hello?.browser ?? 'safari'), os: 'mac', app: true };

  const rebuild = () => {
    const next = raw ? fromStorage(raw) : null;
    state = next?.spaces?.length ? (across ? { ...next, across } : next) : null;
  };
  const emit = () => { if (state && !destroyed) for (const cb of [...listeners]) cb(state); };
  rebuild();
  // The window's tab in front, if it's Margin's new-tab page (its launcher is drawn here then).
  const frontPage = () => {
    const own = windows.find((w) => (w?.windowId ?? w?.id) === windowId);
    const id = own?.activeTabId ?? Object.values(state?.tabs ?? {}).find((t) => t?.windowId === windowId && t?.active)?.id;
    const tab = id != null ? state?.tabs?.[id] : null;
    return tab && isNewTabPage(tab.url) ? { id: tab.id, url: String(tab.url) } : null;
  };
  const pageKey = () => JSON.stringify(frontPage());

  /**
   * @param {string} type @param {Record<string, any>} [payload]
   * @returns {Promise<any>}
   */
  async function send(type, payload = {}) {
    if (destroyed) return undefined;
    // Another profile's space: the app's to do (its switch, or that profile's copy).
    const foreign = typeof payload.spaceId === 'string' ? foreignSpace(state?.across, payload.spaceId) : null;
    if (foreign) {
      if (type === 'setSpace') return post('perform', { name: 'profile.switch', arg: { profile: foreign.profile, space: foreign.id } }).then(() => ({ shown: null }), () => undefined);
      if (type === 'renameSpace' || type === 'deleteSpace') {
        const { windowId: _w, ...rest } = payload;
        return post('perform', { name: 'profile.space', arg: { profile: foreign.profile, type, payload: { ...rest, spaceId: foreign.id } } }).catch(() => undefined);
      }
      return undefined; // nothing else is done to another profile's space from here
    }
    // An archived tab restored from the launcher takes the new-tab page's place (as there).
    const page = type === 'restoreArchive' ? frontPage() : null;
    if (page && payload.replaceTabId == null) payload = { ...payload, replaceTabId: page.id };
    // A request naming a tab carries its address and place (as the in-page
    // host's does): the copy trusts the id only if it's its own.
    if (Number.isInteger(payload.tabId) && !payload.hint) {
      const tab = state?.tabs?.[payload.tabId];
      if (tab) payload = { ...payload, hint: { url: tab.url, index: tab.index, title: tab.title, from: state?.openTabsBy ?? null } };
    }
    try {
      const text = await post('send', { type, payload });
      const res = typeof text === 'string' ? JSON.parse(text) : text;
      if (res?.ok) return res.result;
      if (res && !res.stale) warn(type, res.error);
      return undefined;
    } catch (err) {
      warn(type, /** @type {any} */ (err)?.message ?? err);
      return undefined;
    }
  }

  return {
    platform,
    windowId,
    get tabId() { return frontPage()?.id ?? null; },
    get mode() { return /** @type {'fullscreen' | 'windowed'} */ (mode); },
    // Margin's start page (#launcher, #settings) chooses a new tab; a new-tab page opens it there.
    get inNewTab() { const p = frontPage(); return !!p && !/#(launcher|settings)\b/.test(p.url); },
    get launcher() { return !!frontPage(); },
    // Its Settings asked for (the new-tab page's #settings: a Settings button elsewhere).
    get settingsAsked() { return !!frontPage()?.url.includes('#settings'); },
    get pageTabId() { return frontPage()?.id ?? null; },
    getState: () => state,
    /** @param {(state: any) => void} cb */
    onState(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    send,
    /** @param {Geometry} geometry */
    reportLayout(geometry) {
      // Twice for one change (the runtime's own frame, and the page's measure after it): once.
      if (layout && JSON.stringify([layout.insets, layout.radius, layout.container]) === JSON.stringify([geometry.insets, geometry.radius, geometry.container])) return;
      layout = geometry;
      void post('layout', { geometry }).catch(() => {});
    },
    get layout() { return layout; },
    get windows() { return windows; },
    /** @param {string} name @param {any} [arg] */
    perform(name, arg) {
      switch (name) {
        case 'navigate': {
          // An address chosen in the launcher or palette over Margin's new-tab page: opened in that tab.
          const page = frontPage();
          if (!page || typeof arg?.url !== 'string') return false;
          void send('openHere', { tabId: page.id, url: arg.url });
          return true;
        }
        case 'window.fullscreen':
          void post('perform', { name, arg: arg ?? null }).catch(() => {});
          return true;
        // Across profiles (app/shell/ShellProfiles.swift performAcross).
        case 'profile.switch':
        case 'profile.rename':
        case 'profile.forget':
        case 'profile.space':
        case 'space.move':
          void post('perform', { name, arg: arg ?? null }).catch(() => {});
          return true;
        case 'notice':
        case 'prompt':
          return true; // the runtime closes it; the app's own notices have no buttons yet
        default:
          return false; // history goes to the copy (goBack, goForward, reload); the window's other buttons are Phase 4's
      }
    },
    /** What the app passes on (app/shell/Shell.swift forward, run, pointer). @param {any} msg */
    receive(msg) {
      if (destroyed || !msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'state':
          raw = msg.state && typeof msg.state === 'object' ? msg.state : null;
          if (Array.isArray(msg.windows)) windows = msg.windows;
          rebuild();
          return emit();
        case 'changes':
          if (!raw) return;
          raw = applyChanges(raw, msg.changes, msg.favicons);
          rebuild();
          return emit();
        case 'across':
          across = acrossOf(msg.across);
          rebuild();
          return emit();
        case 'windows': {
          if (!Array.isArray(msg.list)) return;
          const page = pageKey();
          windows = msg.list;
          const own = windows.find((w) => (w?.windowId ?? w?.id) === windowId);
          const before = mode;
          if (own) mode = modeOf(own);
          if (mode !== before || pageKey() !== page) emit();
          return;
        }
        default:
          return onMessage(msg);
      }
    },
    destroy() {
      destroyed = true;
      listeners.clear();
    },
  };
}
