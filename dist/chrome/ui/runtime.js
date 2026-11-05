// The UI runtime (PLAN.md §2): Margin's own code around a theme. It mounts a
// loaded theme (ui/theme-loader.js) into a shadow root or a document, keeps
// the UI's own state (the sidebar, the palette, menus, the editor, a name
// being edited), rebuilds the view model (ui/view-model.js) from its host's
// state and that, renders it (ui/render.js), reports where `<m-page>` sits
// to the host after every layout change, turns the theme's clicks into
// checked requests (ui/actions.js) sent through the host (ui/host.js), and
// runs the behaviors a theme opts into with attributes (ui/behaviors/: the
// palette's keys, peek, resize, menus, renaming, drag and drop, scroll
// memory, the space swipe, presses). Nothing here touches a browser API but
// the DOM it draws in: the host does the rest.
//
// What's shown before the state says so (as today's sidebar does): a folder
// or space renamed, Keep open turned on or off, a space switched to, a
// sidebar width being dragged. Each lasts until the state agrees, or a few
// seconds (the request failed: back to what the state says).
/** @import { Host } from './host.js' */
/** @import { LoadedTheme } from './theme-loader.js' */
/** @import { UiState, ViewModel } from './view-model.js' */
import { View } from './render.js';
import { buildViewModel, paletteItems } from './view-model.js';
import { BEHAVIOR_ONLY, checkAction, contextFromState, requestFor } from './actions.js';
import { resolveSettings } from './theme-loader.js';
import { menuItems } from './behaviors/menu-items.js';
import * as V from '../shared/view.js';
import { createSwitching, NEW_TAB, opensNewTab } from '../shared/switching.js';
import { installPalette } from './behaviors/palette.js';
import { installPeek } from './behaviors/peek.js';
import { installResize } from './behaviors/resize.js';
import { installMenus } from './behaviors/menus.js';
import { installRename } from './behaviors/rename.js';
import { installEditor } from './behaviors/editor.js';
import { installDrag } from './behaviors/drag.js';
import { installScroll } from './behaviors/scroll.js';
import { installSwipe } from './behaviors/swipe.js';
import { installPress } from './behaviors/press.js';
import { installSettings } from './behaviors/settings.js';

const CLOSED_PALETTE = Object.freeze({ open: false, query: '', selected: 0, newTab: false });
// What's shown ahead of the state lasts this long at most (sidebar.js SHOWN_SPACE_MS).
const PENDING_MS = 3000;
// The page was shown this recently: its own tab's space until the state
// records it's in front (content/core.js JUST_SHOWN_MS, shared/view.js sidebar).
const JUST_SHOWN_MS = 2000;
// The palette opened for a new tab: "+ New Tab" stays highlighted this long
// after a choice that shows another tab, or until the page is hidden
// (content/palette.js newTabCloser).
const NEW_TAB_HOLD_MS = 1500;
const SHOWS_ANOTHER_TAB = new Set(['activateTab', 'newTab', 'openPin', 'restoreArchive', 'search', 'openLauncher']);
const SWITCH_REQUESTS = new Set(['activateTab', 'openPin', 'setSpace']);
// Rows a ⌃-click opens the menu on rather than runs (the Mac's right-click).
const ROW_ACTIONS = new Set(['tab.activate', 'pin.open', 'folder.toggle']);

/**
 * @param {{
 *   host: Host,
 *   theme: LoadedTheme,
 *   container: ShadowRoot | Document,
 *   ui?: Partial<UiState>,
 *   onWarn?: (message: string) => void,
 *   log?: (entry: { name: string, arg: any, reason: string }) => void,
 *   onSwitchSlow?: (slow: boolean) => void,
 *   onSwitchFailed?: () => void,
 *   onPalette?: (what: 'run' | 'close', request?: any) => void,
 *   onSwitching?: (tabId: number | null) => void,
 * }} options `ui`: the UI state to start from; `log`: every action refused;
 * `onSwitching`: the tab a switch from the UI is highlighting (null: none);
 * `onPalette`: the palette closed, a row chosen (`run`, with what it sends
 * or does: ui/actions.js requestFor) or not (`close`), for the new-tab
 * page's hand-off (newtab/newtab.js);
 * `onSwitchSlow`, `onSwitchFailed`: a switch asked for from the UI takes a
 * while, or didn't happen (shared/switching.js; the in-page host's loading
 * pill and notice)
 */
export function createRuntime({ host, theme, container, ui: start = {}, onWarn, log, onSwitchSlow, onSwitchFailed, onPalette, onSwitching }) {
  /** @type {UiState & Record<string, any>} */
  let ui = { sidebar: null, palette: CLOSED_PALETTE, menu: null, editing: null, editor: null, notice: null, focused: true, switchingTo: null, newTabPending: false, ...start };
  /** @type {ViewModel | null} */
  let vm = null;
  /** @type {ViewModel | null} */
  let drawn = null;
  let savedKey = null; // the theme's saved settings last applied (as JSON)
  let settings = resolveSettings(theme.manifest, null);
  let destroyed = false;
  /** @type {{ name: string, arg: any, reason: string }[]} */
  const refused = [];
  const warn = onWarn ?? ((message) => console.warn('[margin]', message));
  const doc = /** @type {Document} */ (container.nodeType === 9 ? container : container.ownerDocument);
  const win = /** @type {Window & typeof globalThis} */ (doc.defaultView);
  const offs = [];
  const timers = new Set();

  // ---- what's shown ahead of the state ------------------------------------------
  const pending = {
    /** @type {{ patch: Record<string, any>, until: number } | null} */ settings: null,
    /** @type {Map<string, { name: string, until: number }>} */ folders: new Map(),
    /** @type {Map<string, { patch: Record<string, any>, until: number }>} */ spaces: new Map(),
    /** @type {{ spaceId: string, since: number, withTab: number | null } | null} */ space: null,
    /** @type {{ values: Record<string, any>, live: boolean, until: number } | null} */ themeSettings: null,
  };
  // Re-drawn when the soonest of them runs out.
  let expiryTimer = null;
  function expireLater() {
    const ends = [pending.settings?.until, ...[...pending.folders.values()].map((p) => p.until), ...[...pending.spaces.values()].map((p) => p.until),
      pending.space ? pending.space.since + PENDING_MS + 50 : undefined, pending.themeSettings && !pending.themeSettings.live ? pending.themeSettings.until : undefined].filter((t) => t != null);
    clearTimeout(expiryTimer);
    if (!ends.length) return;
    expiryTimer = setTimeout(() => render(), Math.max(0, Math.min(...ends) - Date.now()) + 5);
  }

  // The window and tab the UI is for, and the tab in front of that window.
  const windowId = () => host.windowId ?? null;
  const ownTab = () => host.tabId ?? null;
  const frontTab = () => {
    const state = host.getState();
    if (!state?.tabs) return null;
    const own = ownTab();
    if (own != null && state.tabs[own]) return own;
    const w = windowId();
    return /** @type {any} */ (Object.values(state.tabs).find((t) => /** @type {any} */ (t).windowId === w && /** @type {any} */ (t).active))?.id ?? null;
  };

  // The state as the UI shows it: the stored one, with what's shown ahead of it.
  function viewState(raw) {
    if (!raw?.spaces) return raw;
    const now = Date.now();
    let state = raw;
    const p = pending;
    if (p.settings) {
      const agrees = Object.entries(p.settings.patch).every(([k, v]) => raw.settings?.[k] === v);
      if (agrees || now > p.settings.until) p.settings = null;
      else state = { ...state, settings: { ...state.settings, ...p.settings.patch } };
    }
    for (const [id, entry] of p.folders) {
      const folder = raw.folders?.find((f) => f.id === id);
      if (!folder || folder.name === entry.name || now > entry.until) p.folders.delete(id);
    }
    if (p.folders.size) state = { ...state, folders: state.folders.map((f) => (p.folders.has(f.id) ? { ...f, name: p.folders.get(f.id).name } : f)) };
    for (const [id, entry] of p.spaces) {
      const space = raw.spaces.find((s) => s.id === id);
      if (!space || Object.entries(entry.patch).every(([k, v]) => space[k] === v) || now > entry.until) p.spaces.delete(id);
    }
    if (p.spaces.size) state = { ...state, spaces: state.spaces.map((s) => (p.spaces.has(s.id) ? { ...s, ...p.spaces.get(s.id).patch } : s)) };
    // A space asked for: shown until the state says so, the switch that
    // brings its tab is over, or PENDING_MS (sidebar.js showSpaceNow).
    if (p.space) {
      const w = windowId();
      const over = V.activeSpaceId(raw, w) === p.space.spaceId || now - p.space.since > PENDING_MS
        || (p.space.withTab != null && ui.switchingTo == null && !behaviors.swipe?.active());
      if (over) p.space = null;
      else state = { ...state, activeSpaceByWindow: { ...state.activeSpaceByWindow, [w]: p.space.spaceId } };
    }
    return state;
  }

  // ---- the switch highlight (shared/switching.js) ---------------------------------
  let switchAskedAt = 0;
  let lastShownAt = doc.hidden ? 0 : Date.now();
  let firstRender = true;
  const onVisibility = () => { if (!doc.hidden) lastShownAt = Date.now(); };
  doc.addEventListener('visibilitychange', onVisibility);
  offs.push(() => doc.removeEventListener('visibilitychange', onVisibility));
  // A host whose UI stays on screen through a switch (Margin.app's overlay:
  // `staysOnScreen`) keeps the highlight until the state has the tab in front
  // (shared/switching.js `landed`); a page's ends as it's hidden.
  const stays = !!(/** @type {any} */ (host).staysOnScreen);
  const switching = createSwitching({
    onChange: (id) => { if (destroyed) return; onSwitching?.(id); setUi({ switchingTo: id }); },
    onSlow: (slow) => { if (!destroyed) onSwitchSlow?.(slow); },
    failed: (result) => result === undefined,
    onFailed: () => { if (!destroyed) onSwitchFailed?.(); },
    doc,
    front: stays ? frontTab : null,
    landed: stays ? (id, from) => { const f = frontTab(); return f === id ? true : f === from ? null : false; } : null,
  });

  // The UI state with what the host knows (its window, tab and mode).
  const fullUi = () => ({
    ...ui,
    windowId: windowId(),
    tabId: ownTab(),
    mode: host.mode ?? 'inpage',
    inNewTab: !!host.inNewTab,
    launcherPage: !!host.launcher,
    justShown: (firstRender || Date.now() - lastShownAt < JUST_SHOWN_MS) && switchAskedAt <= lastShownAt,
  });

  const view = new View(container, theme.template, {
    sheets: [theme.sheet, theme.settingsSheet].filter(Boolean),
    onAction: (name, arg, info) => { themeClick(name, arg, info); },
    onInput: (name, value) => { for (const b of list) b.onInput?.(name, value); },
    onLayout: (geometry) => host.reportLayout({ ...geometry, windowId: windowId(), mode: host.mode ?? 'inpage' }),
    onWarn: (message) => warn(message),
  });

  // The theme's settings: what's saved, with a width being dragged (resize).
  function themeSettings(state) {
    const own = state?.settings?.themes?.[theme.id];
    const p = pending.themeSettings;
    if (p && !p.live) {
      const agrees = Object.entries(p.values).every(([k, v]) => own?.[k] === v);
      if (agrees || Date.now() > p.until) pending.themeSettings = null;
    }
    return pending.themeSettings ? { ...(own ?? {}), ...pending.themeSettings.values } : own;
  }

  function render() {
    if (destroyed) return vm;
    const raw = host.getState();
    const own = themeSettings(raw);
    const key = JSON.stringify(own ?? null);
    if (key !== savedKey) {
      savedKey = key;
      settings = resolveSettings(theme.manifest, own);
      theme.setSettings?.(own);
    }
    const state = viewState(raw);
    const prev = vm;
    vm = buildViewModel({ state, ui: fullUi(), platform: host.platform, settings }, vm);
    // Nothing changed (the same model): nothing to draw.
    if (vm !== drawn) {
      drawn = vm;
      view.update(vm);
    }
    if (vm.ready) firstRender = false;
    for (const b of list) b.afterRender?.(vm, prev);
    expireLater();
    return vm;
  }

  /** @param {Partial<UiState> & Record<string, any>} patch */
  function setUi(patch) {
    ui = { ...ui, ...patch };
    return render();
  }

  /** @param {string} name @param {any} arg @param {string} reason */
  function refuse(name, arg, reason) {
    const entry = { name: String(name), arg, reason };
    refused.push(entry);
    if (refused.length > 100) refused.shift();
    log?.(entry);
    return false;
  }

  // ---- requests ------------------------------------------------------------------

  /**
   * A request to the background, and what Margin does around it: a switch
   * highlights its tab at once (shared/switching.js), the list's scroll is
   * saved first (the next page asks for it at once).
   * @param {string} type @param {Record<string, any>} payload
   */
  function send(type, payload) {
    if (SWITCH_REQUESTS.has(type) || opensNewTab(type, payload)) behaviors.scroll?.flush();
    if (SWITCH_REQUESTS.has(type)) switchAskedAt = Date.now();
    const request = host.send(type, payload);
    const state = /** @type {any} */ (host.getState());
    const target = type === 'activateTab' ? payload.tabId
      : type === 'openPin' && state ? V.pinTabId(state, payload.pinId, payload.windowId ?? windowId())
      : opensNewTab(type, payload) ? NEW_TAB : null;
    if (Number.isInteger(target)) {
      // Back to the tab in front: a switch away still under way ends.
      if (target === frontTab()) switching.end();
      else if (target !== ui.switchingTo) switching.start(target, request);
    }
    return request;
  }

  // The most recent tab of a space in this window: the one its switch shows.
  const recentTabOf = (spaceId) => {
    const state = host.getState();
    const w = windowId();
    return /** @type {any} */ (Object.values(state?.tabs ?? {}).filter((t) => /** @type {any} */ (t).windowId === w && state.tabSpace?.[/** @type {any} */ (t).id] === spaceId)
      .sort((a, b) => (/** @type {any} */ (b).lastActive ?? 0) - (/** @type {any} */ (a).lastActive ?? 0))[0]) ?? null;
  };

  // A space asked for (its chip pressed or clicked, a swipe): the window
  // switches to it, and the UI shows it at once, from the top of its list
  // (sidebar.js askSpace, switchSpace). Its own space with no switch away
  // under way: only the window's space, as before.
  function switchSpace(spaceId, payload) {
    const state = host.getState();
    if (!state) return null;
    // Another profile's space: Margin.app's switch (its window opens, this one closes): nothing shown here meanwhile.
    if (String(spaceId).startsWith('x:')) return host.send('setSpace', payload);
    const own = ownTab() ?? frontTab();
    const shownSpace = vm?.space?.id;
    if (state.tabSpace?.[own] === spaceId && ui.switchingTo == null && shownSpace === spaceId) return host.send('setSpace', payload);
    behaviors.scroll?.reset();
    switchAskedAt = Date.now();
    const request = host.send('setSpace', payload);
    if (state.tabSpace?.[own] === spaceId) {
      // Back to this page's own space: a switch away still pending stops.
      if (ui.switchingTo != null && own != null) void host.send('activateTab', { tabId: own });
      switching.end();
    } else {
      const tab = recentTabOf(spaceId);
      if (tab && tab.id !== frontTab()) switching.start(tab.id, request);
    }
    pending.space = { spaceId, since: Date.now(), withTab: ui.switchingTo ?? null };
    render();
    return request;
  }

  /**
   * Runs one action: checked against the host's state (the tab must be open,
   * the space must exist, the palette row must be on screen), then sent,
   * done here, or handed to the host. False if refused. `origin`: who asked
   * ('theme': a click on the theme; 'behavior', 'menu': Margin's own, which
   * alone may run BEHAVIOR_ONLY actions).
   * @param {string} name @param {any} [arg] @param {'theme' | 'behavior' | 'menu'} [origin] @param {any} [info]
   */
  function dispatch(name, arg, origin = 'theme', info = null) {
    if (destroyed) return false;
    if (origin === 'theme' && BEHAVIOR_ONLY.has(name)) return refuse(name, arg, `${name}: only Margin's behaviors and menus run it`);
    const state = host.getState();
    const now = fullUi();
    const items = ui.palette.open ? paletteItems(state, now, host.platform) : [];
    const menu = ui.menu && vm ? menuItems(/** @type {any} */ (ui.menu), { state: viewState(state), space: vm.space }) : [];
    const colors = vm?.editor ? vm.editor.colors.map((c) => c.id) : [];
    const noticeIds = vm?.notice?.actions.map((a) => a.id) ?? [];
    const promptIds = vm?.prompt?.actions.map((a) => a.id) ?? [];
    const settingIds = vm?.settingsForm?.fields.filter((f) => f.isButton && !f.disabled).map((f) => f.id) ?? [];
    const verdict = checkAction(name, arg, contextFromState(state, items.map((i) => i.id), { menuIds: menu.filter((i) => !i.separator).map((i) => i.id), colorIds: colors, noticeIds, promptIds, settingIds }));
    if (!verdict.ok) return refuse(name, arg, /** @type {any} */ (verdict).reason);
    // Margin's own pages (the launcher) open their Settings in place.
    if (name === 'settings.open' && host.launcher) return local('settings.toggle', undefined, info);
    const request = requestFor(name, arg, { state, ui: { windowId: now.windowId, sidebar: vm?.window.sidebar ?? null }, platform: host.platform, row: name === 'palette.run' ? items.find((i) => i.id === arg) : null });
    // Choosing a row closes the palette first (Arcadia's palette); one opened
    // for a new tab keeps "+ New Tab" lit while another tab comes to the front.
    if (name === 'palette.run') {
      const wasNewTab = ui.palette.newTab;
      const shows = request.kind === 'send' && SHOWS_ANOTHER_TAB.has(request.type);
      setUi({ palette: CLOSED_PALETTE, newTabPending: wasNewTab && shows });
      if (wasNewTab && shows) holdNewTab();
      behaviors.palette?.closed(request.kind === 'send' && opensNewTab(request.type, request.payload));
      onPalette?.('run', request);
    }
    switch (request.kind) {
      case 'send': return sent(name, arg, request.type, request.payload);
      case 'local': return local(request.name, request.arg, info);
      case 'host': {
        if (host.perform?.(request.name, request.arg)) return true;
        if (request.fallback) { void host.send(request.fallback.type, request.fallback.payload); return true; }
        return refuse(name, arg, `${request.name}: this host can't`);
      }
      default: return refuse(name, arg, /** @type {any} */ (request).reason);
    }
  }

  // A sent action, and what follows it.
  function sent(name, arg, type, payload) {
    switch (name) {
      case 'space.switch':
        switchSpace(arg, payload);
        return true;
      case 'space.new': {
        // A new space opens in the editor once it's there (Arcadia); shown
        // once the editor closes (not if it was deleted).
        void Promise.resolve(host.send(type, payload)).then((res) => { if (typeof res?.spaceId === 'string') behaviors.editor.openWhenThere(res.spaceId, { fresh: true }); });
        return true;
      }
      case 'folder.new': case 'folder.newWithTab': case 'folder.newWithPin':
        // Its name, edited in place once it's drawn (sidebar.js folderCreated).
        void Promise.resolve(host.send(type, payload)).then((id) => { if (typeof id === 'string') behaviors.rename.startWhenThere('folder', id); });
        return true;
      case 'folder.setName':
        pending.folders.set(arg.folder, { name: arg.name, until: Date.now() + PENDING_MS });
        break;
      case 'space.setName': case 'space.update': {
        const patch = name === 'space.setName' ? { name: arg.name } : Object.fromEntries(Object.entries({ name: arg.name, emoji: arg.emoji, color: arg.color }).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.trim()]));
        if (Object.keys(patch).length) pending.spaces.set(arg.space, { patch, until: Date.now() + PENDING_MS });
        break;
      }
      case 'sidebar.toggle':
        // Shown at once, not when storage comes back; a sidebar out over the
        // page docks (Keep open on) or goes (off).
        pending.settings = { patch: { sidebarPinnedOpen: payload.patch.sidebarPinnedOpen }, until: Date.now() + PENDING_MS };
        behaviors.peek?.reset();
        ui = { ...ui, sidebar: null };
        break;
      case 'folder.toggle':
        lastToggle = { folderId: arg, wasOpen: !payload.open, at: Date.now() };
        break;
      default: break;
    }
    const request = send(type, payload);
    if (name === 'tab.move') return request;
    render();
    return true;
  }

  /** @type {{ folderId: string, wasOpen: boolean, at: number } | null} */
  let lastToggle = null;

  let newTabTimer = null;
  function holdNewTab() {
    clearTimeout(newTabTimer);
    const done = () => { clearTimeout(newTabTimer); doc.removeEventListener('visibilitychange', onHidden); if (ui.newTabPending) setUi({ newTabPending: false }); };
    const onHidden = () => { if (doc.hidden) done(); };
    doc.addEventListener('visibilitychange', onHidden);
    newTabTimer = setTimeout(done, NEW_TAB_HOLD_MS);
  }

  /** @param {string} name @param {any} arg @param {any} info */
  function local(name, arg, info) {
    switch (name) {
      case 'palette.open':
        setUi({ palette: { open: true, query: '', selected: 0, newTab: !!arg?.newTab }, menu: null, newTabPending: false });
        return true;
      case 'palette.close':
        if (!ui.palette.open) return true;
        setUi({ palette: CLOSED_PALETTE });
        behaviors.palette?.closed(false);
        onPalette?.('close');
        return true;
      case 'space.edit': return behaviors.editor.open(arg);
      case 'profile.edit': return behaviors.editor.openProfile(arg);
      case 'space.rename': return behaviors.rename.start('space', arg);
      case 'folder.rename': return behaviors.rename.start('folder', arg);
      case 'menu.open': {
        const box = info?.element?.getBoundingClientRect?.();
        return behaviors.menus.open({ kind: arg, id: null }, box ? { x: box.left, y: box.top } : { x: 0, y: 0 }, { above: true });
      }
      case 'menu.run': return behaviors.menus.run(arg);
      case 'menu.close': behaviors.menus.close(); return true;
      case 'editor.save': return behaviors.editor.save();
      case 'editor.cancel': return behaviors.editor.cancel();
      case 'editor.delete': return behaviors.editor.remove();
      case 'editor.color': return behaviors.editor.color(arg);
      // Margin's notices and prompts: a button is the host's to run (what
      // it does stays in Margin, as a menu item's), then it goes.
      case 'notice.run': case 'prompt.run': {
        const which = name === 'notice.run' ? 'notice' : 'prompt';
        const id = ui[which]?.id;
        setUi({ [which]: null });
        host.perform?.(which, { id, action: arg });
        return true;
      }
      case 'notice.close': setUi({ notice: null }); return true;
      case 'prompt.close': setUi({ prompt: null }); return true;
      case 'launcher.more': setUi({ launcher: { ...ui.launcher, allArchived: !ui.launcher?.allArchived } }); return true;
      case 'settings.toggle': setUi({ settingsOpen: !ui.settingsOpen, recording: null }); return true;
      case 'settings.run': return behaviors.settings.run(arg);
      // The palette's own rows (shared/search.js `local` actions). "Toggle
      // sidebar" is the theme's sidebar.toggle: Keep open on or off.
      case 'palette.toggleSidebar': return dispatch('sidebar.toggle', undefined, 'behavior');
      case 'palette.navigate':
        if (host.perform?.('navigate', { url: arg.url })) return true;
        void send('newTab', { windowId: windowId() ?? undefined, url: arg.url });
        return true;
      case 'palette.search':
        void send('search', { query: arg.query, ...(ownTab() != null ? { tabId: ownTab() } : { windowId: windowId() ?? undefined }) });
        return true;
      default:
        return refuse(name, arg, `${name}: not something the UI does`);
    }
  }

  /**
   * What's typed in the new-tab launcher's field, run as the palette would
   * run its first row for it (an address goes there, words are searched),
   * without showing the palette.
   * @param {string} query
   */
  function runQuery(query) {
    const text = String(query ?? '').trim();
    if (!text) return false;
    const state = host.getState();
    const items = paletteItems(state, { ...fullUi(), palette: { open: true, query: text, selected: 0 } }, host.platform);
    const row = items.find((i) => i.kind === 'go');
    if (!row) return false;
    const request = requestFor('palette.run', row.id, { state, ui: { windowId: windowId(), sidebar: vm?.window.sidebar ?? null }, platform: host.platform, row });
    if (request.kind === 'send') { void send(request.type, request.payload); return true; }
    if (request.kind === 'local') return local(request.name, request.arg, null);
    return false;
  }

  // A click on the theme: some are Margin's to swallow (a name being edited,
  // ⌃-click on a row, a press that switched already, a double-click's second
  // click on a folder), the rest run.
  function themeClick(name, arg, info) {
    const event = info?.event;
    if (behaviors.rename?.editingContains(event?.target)) return;
    if (event?.ctrlKey && ROW_ACTIONS.has(name)) return;
    if (behaviors.drag?.justDropped()) return;
    if (behaviors.press?.consumes(name, arg, event)) return;
    if (name === 'folder.toggle' && event?.detail > 1) return;
    dispatch(name, arg, 'theme', info);
  }

  // ---- the behaviors ------------------------------------------------------------

  // Margin's own pixels per pixel of the page: the page's zoom (⌘+ / ⌘−)
  // scales the page, and the in-page host scales Margin back
  // (shared/dom.js setPageZoom), so pointer positions and element boxes come
  // in the page's (zoomed) pixels while lengths written in CSS are Margin's.
  // 1 where nothing is zoomed (the app, tests).
  const scale = () => {
    const root = /** @type {HTMLElement | null} */ (view.rootElement());
    const width = root?.getBoundingClientRect().width;
    return width && root.offsetWidth ? root.offsetWidth / width : 1;
  };

  const rt = {
    host, theme, view, doc, win, container, scale,
    get vm() { return vm; },
    get ui() { return ui; },
    get state() { return host.getState(); },
    viewState: () => viewState(host.getState()),
    setUi, render, dispatch, send, refuse, warn, runQuery,
    windowId, ownTab, frontTab, recentTabOf, switchSpace,
    switching,
    get lastToggle() { return lastToggle; },
    /** Shown ahead of the state: the theme's settings (a width being dragged, `live`, or just saved). */
    setThemeSettings(values, { live = false } = {}) {
      pending.themeSettings = values ? { values, live, until: Date.now() + PENDING_MS } : null;
      render();
    },
    /** Anything under way that a sidebar out over the page waits for (sidebar.js isBusy). */
    busy: (except = null) => list.some((b) => b !== except && b.busy?.()),
    /** A listener, removed with the runtime. */
    listen(target, type, fn, options) {
      target.addEventListener(type, fn, options);
      offs.push(() => target.removeEventListener(type, fn, options));
    },
    later(fn, ms) {
      const id = setTimeout(() => { timers.delete(id); if (!destroyed) fn(); }, ms);
      timers.add(id);
      return id;
    },
    cancel(id) { clearTimeout(id); timers.delete(id); },
    get destroyed() { return destroyed; },
  };
  /** @type {Record<string, any>} */
  const behaviors = {};
  rt.behaviors = behaviors;
  Object.assign(behaviors, {
    press: installPress(rt),
    palette: installPalette(rt),
    peek: installPeek(rt),
    resize: installResize(rt),
    menus: installMenus(rt),
    rename: installRename(rt),
    editor: installEditor(rt),
    drag: installDrag(rt),
    scroll: installScroll(rt),
    swipe: installSwipe(rt),
    settings: installSettings(rt),
  });
  const list = Object.values(behaviors);

  // Keystrokes in Margin's UI stay away from the page's own shortcuts.
  const stopKeys = (e) => { if (view.owns(e.target)) e.stopPropagation(); };
  for (const type of ['keydown', 'keyup', 'keypress']) rt.listen(container, type, stopKeys);

  // (A switch the new state says is over ends first: its highlight goes with it, once.)
  const off = host.onState(() => {
    switching.settle();
    render();
  });
  render();

  return {
    /** The view model last drawn. */
    get vm() { return vm; },
    /** The UI's own state. */
    get ui() { return ui; },
    setUi,
    dispatch,
    render,
    /** Actions refused lately, newest last. */
    refused,
    view,
    /** Where `<m-page>` is now (ui/render.js View.measure). */
    measure: () => view.measure(),
    /**
     * The pointer over the page, from a host whose page gets its events (the
     * in-page host: the document's mousemove; the app: its window's), in the
     * container's coordinates: a hidden sidebar's reveal edge (m-peek).
     * @param {{ x: number, y: number }} point
     */
    pointer: (point) => behaviors.peek.pagePointer(point),
    /** The pointer left the window (`x`, `y`: where it was last). */
    pointerLeft: (point) => behaviors.peek.pageLeft(point),
    /**
     * The sidebar out over the page by the host's word: `hover` (as the
     * pointer at the edge does), `toggle` (the show/hide key: it stays until
     * toggled again, Escape or a click on the page), `flash` (a moment, after
     * a space switch by key); `hide()` takes it back, `toggle()` is the key.
     */
    sidebar: {
      show: (/** @type {'hover' | 'toggle' | 'flash'} */ why) => behaviors.peek.showFor(why),
      hide: () => behaviors.peek.hide(),
      toggle: () => behaviors.peek.toggle(),
      flash: (ms) => behaviors.peek.flash(ms),
      /** How it's out now: 'hover' | 'toggle' | 'flash' | null. */
      reason: () => behaviors.peek.reason(),
      /** Out over the page (not docked). */
      out: () => vm?.window.sidebar === 'peek',
    },
    /**
     * A switch the copy makes in this window (a next/previous key: its
     * 'switching' push), highlighted as one asked for here is; `request`
     * settles with its 'switch-done' or 'switch-failed' (shared/switching.js
     * backgroundSwitches). A switch to the tab in front ends any under way.
     * @param {number} tabId @param {Promise<any>} request
     */
    switchTo(tabId, request) {
      if (!Number.isInteger(tabId)) return;
      if (tabId === frontTab()) switching.end();
      else switching.start(tabId, request);
    },
    /** The palette, opened by the host (its key, ⌘T's hand-off): `newTab`, to choose a new tab. */
    openPalette: ({ newTab = false } = {}) => local('palette.open', { newTab }, null),
    closePalette: () => { if (ui.palette.open) local('palette.close', undefined, null); },
    get paletteOpen() { return !!ui.palette.open; },
    /** The tab list's scroll: saved now (before a switch), or set (a page prepared for a show). */
    flushScroll: () => behaviors.scroll?.flush(),
    restoreScroll: () => behaviors.scroll?.restore(),
    setScroll: (px) => behaviors.scroll?.set(px),
    /** Something is under way in the UI (a drag, a menu, a name being edited). */
    busy: () => rt.busy(),
    /** Margin's pixels per page pixel (the page's zoom). */
    scale,
    destroy() {
      if (destroyed) return;
      off();
      for (const b of list) b.destroy?.();
      destroyed = true;
      switching.end();
      clearTimeout(expiryTimer);
      clearTimeout(newTabTimer);
      for (const id of timers) clearTimeout(id);
      for (const fn of offs.splice(0)) fn();
      view.destroy();
    },
  };
}
