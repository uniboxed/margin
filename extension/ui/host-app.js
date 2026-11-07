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
//   goForward and reload. A notice's button goes to the overlay's notices
//   (`onNotice`: ui/app-feedback.js), which tell the copy (`noticeAction`);
// - which of the window's tabs are loading (the copy's `push` `loading`:
//   background/page-loads.js): the tab's status, a page being left, a site's
//   own same-page navigation; drawn as each tab's `loading` (the view model);
// - why the last request failed (`takeFailure`), for the notice of a switch
//   that didn't happen;
// - iCloud Tabs (Safari's windows only): the app's own data, never the
//   copy's, in the hello (`cloudTabs`) and as `{ type: 'cloudTabs' }` when it
//   changes (app/shell/ShellCloudTabs.swift), checked (shared/cloud-tabs.js
//   cloudOf) and kept as the state's `cloudTabs`; the folder's Full Disk
//   Access button and its Copy Link are the app's (`cloud.access`, `copyText`);
// - the switch between profiles (app/HANDOFF.md §5, §7): "Close windows to
//   save memory" in Settings, for Safari with more than one profile, from
//   `across.switchSettings` (`switchSettings`, a feature), saved by the app
//   (`switch.closeWindows`); the "switching" cover drawn (`switch.coverShown`,
//   app/overlay/overlay.js); a button of the switch's notice
//   (`switch.notice`: its id is `switch:<kind>`).
//
// No browser API here: only the DOM and `post`.
/** @import { Geometry, Host } from './host.js' */
import { fromStorage } from '../shared/stored.js';
import { isNewTabPage } from '../shared/view.js';
import { acrossOf, foreignSpace } from '../shared/across.js';
import { cloudOf } from '../shared/cloud-tabs.js';
import { platform as profile } from '../shared/platform.js';

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
 * state (theme, command, pointer, pressOutside, blur, shown, push), for the page.
 * `onNotice({ id, action })`: a button of a notice the overlay put up.
 *
 * @param {{
 *   hello: any,
 *   post: (op: string, body?: Record<string, any>) => Promise<any>,
 *   onMessage?: (msg: any) => void,
 *   onNotice?: (arg: { id?: string, action?: string }) => void,
 *   warn?: (...args: any[]) => void,
 * }} options
 * @returns {Host & { staysOnScreen: boolean, receive(msg: any): void, readonly windows: any[], readonly layout: Geometry | null, readonly settingsAsked: boolean, readonly pageTabId: number | null, readonly frontTabId: number | null, readonly loading: number[], readonly userThemes: any[], takeFailure(): { type: string, error: string } | null, destroy(): void }}
 */
export function createAppHost({ hello, post, onMessage = () => {}, onNotice = () => {}, warn = (...args) => console.warn('[margin]', ...args) }) {
  // (Its window can change: a profile switch hands the sidebar to the window it goes to, `rekey`.)
  let windowId = Number.isInteger(hello?.windowId) ? hello.windowId : null;
  /** @type {Record<string, any> | null} */
  let raw = hello?.state && typeof hello.state === 'object' ? hello.state : null;
  /** @type {any} */
  let state = null;
  let windows = Array.isArray(hello?.windows) ? hello.windows : [];
  let mode = hello?.mode === 'windowed' ? 'windowed' : 'fullscreen';
  // Every profile's spaces in the one order, and the profiles (app/shell/ShellProfiles.swift): `state.across`.
  let across = acrossOf(hello?.across);
  // iCloud Tabs, as the app read them (Safari only; null: none).
  let cloud = cloudOf(hello?.cloudTabs);
  /** @type {Geometry | null} */
  let layout = null;
  let destroyed = false;
  const listeners = new Set();
  // What Settings offers for this browser (ui/settings-form.js): the build's
  // profile (scripts/build.js stamps Safari's into the overlay), as the new-tab
  // page gave them when Settings were drawn there.
  const platform = {
    browser: String(hello?.platform?.browser ?? hello?.browser ?? 'safari'), os: 'mac', app: true,
    features: { sleepTabs: profile?.sleepTabs ?? false, blockGestures: !!profile?.blockGestures, marginFullscreen: false, newTabHint: !!profile?.newTabHint, search: profile?.search, cloudTabs: false, switchSettings: /** @type {{ closeWindows: boolean } | null} */ (null) },
  };
  // "Show iCloud Tabs" in Settings: Safari's windows (Chrome and Edge: Phase 5, sessions.getDevices()).
  platform.features.cloudTabs = platform.browser === 'safari';
  // "Close windows to save memory": Safari's windows, with more than one profile, once the app says the value.
  const followSwitchSettings = () => {
    const ss = platform.browser === 'safari' && across && across.profiles.length > 1 ? across.switchSettings : null;
    const next = ss ? { closeWindows: ss.closeWindows } : null;
    if (JSON.stringify(next) !== JSON.stringify(platform.features.switchSettings ?? null)) platform.features = { ...platform.features, switchSettings: next };
  };
  followSwitchSettings();
  // Themes: Margin.app imports them (its file picker), and keeps the index (`themes`: app/PROTOCOL.md "User themes").
  /** @type {any} */ (platform.features).importThemes = true;
  /** @type {any} */ (platform.features).userThemes = Array.isArray(hello?.themes) ? hello.themes : [];
  // The window's tabs loading, as the copy last said (`push` `loading`).
  /** @type {Set<number>} */
  let loading = new Set();
  /** @type {{ type: string, error: string, at: number } | null} */
  let failure = null;

  const rebuild = () => {
    const next = raw ? fromStorage(raw) : null;
    let built = next?.spaces?.length ? (across ? { ...next, across } : next) : null;
    if (built && cloud) built = { ...built, cloudTabs: cloud };
    if (built && loading.size && built.tabs) {
      const tabs = { ...built.tabs };
      for (const id of loading) if (tabs[id]) tabs[id] = { ...tabs[id], loading: true };
      built = { ...built, tabs };
    }
    state = built;
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
      failure = res && !res.stale ? { type, error: String(res.error ?? ''), at: Date.now() } : null;
      return undefined;
    } catch (err) {
      const error = String(/** @type {any} */ (err)?.message ?? err);
      warn(type, error);
      failure = { type, error, at: Date.now() };
      return undefined;
    }
  }

  return {
    platform,
    get windowId() { return windowId; },
    // The overlay stays on screen through a switch (ui/runtime.js: the highlight waits for the state).
    staysOnScreen: true,
    // Not on screen as it first draws: its launcher takes the focus only when the app says (the `shown` push's `focus`).
    focusLauncherAtMount: false,
    get tabId() { return frontPage()?.id ?? null; },
    get mode() { return /** @type {'fullscreen' | 'windowed'} */ (mode); },
    // Margin's start page (#launcher, #settings) chooses a new tab; a new-tab page opens it there.
    get inNewTab() { const p = frontPage(); return !!p && !/#(launcher|settings)\b/.test(p.url); },
    get launcher() { return !!frontPage(); },
    // Its Settings asked for (the new-tab page's #settings: a Settings button elsewhere).
    get settingsAsked() { return !!frontPage()?.url.includes('#settings'); },
    get pageTabId() { return frontPage()?.id ?? null; },
    // The window's tab in front, Margin's new-tab page or not.
    get frontTabId() {
      const own = windows.find((w) => (w?.windowId ?? w?.id) === windowId);
      const id = own?.activeTabId ?? Object.values(state?.tabs ?? {}).find((t) => t?.windowId === windowId && t?.active)?.id;
      return Number.isInteger(id) ? id : null;
    },
    get loading() { return [...loading]; },
    // Why the last request failed, if it failed in the last 2 s (taken once).
    takeFailure() {
      const f = failure;
      failure = null;
      return f && Date.now() - f.at < 2000 ? { type: f.type, error: f.error } : null;
    },
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
    /** Margin.app's index of imported themes. */
    get userThemes() { return /** @type {any} */ (platform.features).userThemes; },
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
        // Themes (app/shell/ShellThemes.swift): the file picker; a checked theme kept; one removed.
        case 'theme.import':
          void post('perform', { name, arg: null }).catch(() => {});
          return true;
        case 'theme.save':
          if (!arg?.value || typeof arg.value !== 'object') return false;
          void post('perform', { name, arg: { value: arg.value } }).catch(() => {});
          return true;
        // iCloud Tabs (app/shell/ShellCloudTabs.swift): System Settings at Full Disk Access, an address copied.
        case 'cloud.access':
          void post('perform', { name, arg: null }).catch(() => {});
          return true;
        case 'copyText':
          if (typeof arg?.text !== 'string') return false;
          void post('perform', { name, arg: { text: arg.text } }).catch(() => {});
          return true;
        case 'notice':
          // The switch's notice (the view model's `switch:<kind>`): the app's to do.
          if (typeof arg?.id === 'string' && arg.id.startsWith('switch:')) {
            void post('perform', { name: 'switch.notice', arg: { kind: arg.id.slice(7), action: String(arg.action ?? '') } }).catch(() => {});
            return true;
          }
          // The runtime closed it; the overlay's notices tell the copy what was chosen.
          onNotice(arg ?? {});
          return true;
        // The switch between profiles (app/shell/ShellProfiles.swift performAcross).
        case 'switch.closeWindows':
          if (typeof arg?.on !== 'boolean') return false;
          void post('perform', { name, arg: { on: arg.on } }).catch(() => {});
          return true;
        case 'switch.coverShown':
          void post('perform', { name, arg: null }).catch(() => {});
          return true;
        case 'prompt': {
          // The runtime closes it. Settings' Remove asked first (ui/settings-form.js removePrompt): removed only on Remove.
          const m = /^remove-theme:([a-z0-9][a-z0-9-]{0,40})$/.exec(String(arg?.id ?? ''));
          if (m && arg?.action === 'remove') void post('perform', { name: 'theme.remove', arg: { id: m[1] } }).catch(() => {});
          return true;
        }
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
          followSwitchSettings();
          rebuild();
          return emit();
        case 'cloudTabs':
          cloud = cloudOf(msg.cloudTabs);
          rebuild();
          return emit();
        case 'themes':
          // Margin.app's index of imported themes changed (Settings lists them).
          if (!Array.isArray(msg.list)) return;
          /** @type {any} */ (platform.features).userThemes = msg.list;
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
        case 'rekey': {
          // Handed to another window and profile by a switch (app/shell Shell.handOverOverlay): that window's hello,
          // taken in place, so the page drawn already draws the new window's state without loading again.
          const next = msg.hello;
          if (!next || typeof next !== 'object' || !Number.isInteger(next.windowId)) return;
          windowId = next.windowId;
          raw = next.state && typeof next.state === 'object' ? next.state : null;
          windows = Array.isArray(next.windows) ? next.windows : [];
          mode = next.mode === 'windowed' ? 'windowed' : 'fullscreen';
          across = acrossOf(next.across);
          cloud = cloudOf(next.cloudTabs);
          if (Array.isArray(next.themes)) /** @type {any} */ (platform.features).userThemes = next.themes;
          followSwitchSettings();
          loading = new Set();
          failure = null;
          rebuild();
          return emit();
        }
        case 'push':
          // The window's tabs loading (background/page-loads.js): each one's row and the tab in front.
          if (msg.msg?.type === 'loading') {
            const next = new Set((Array.isArray(msg.msg.tabIds) ? msg.msg.tabIds : []).filter((id) => Number.isInteger(id)));
            if (next.size === loading.size && [...next].every((id) => loading.has(id))) return;
            loading = next;
            rebuild();
            return emit();
          }
          return onMessage(msg);
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
