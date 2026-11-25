// The UI runtime (PLAN.md §2): Margin's own code around a theme. It mounts a
// loaded theme (ui/theme-loader.ts) into a shadow root or a document, keeps
// the UI's own state (the sidebar, the palette, menus, the editor, a name
// being edited), rebuilds the view model (ui/view-model.ts) from its host's
// state and that, renders it (ui/render.ts), reports where `<m-page>` sits
// to the host after every layout change, turns the theme's clicks into
// checked requests (ui/actions.ts) sent through the host (ui/host.ts), and
// runs the behaviors a theme opts into with attributes (ui/behaviors/: the
// palette's keys, peek, resize, menus, renaming, drag and drop, scroll
// memory, the space swipe, presses). Nothing here touches a browser API but
// the DOM it draws in: the host does the rest.
//
// What's shown before the state says so (as today's sidebar does): a folder
// or space renamed, Keep open turned on or off, a space switched to, a
// sidebar width being dragged. Each lasts until the state agrees, or a few
// seconds (the request failed: back to what the state says).
import { themeChoices } from './space-theme.ts';
import type { Host } from './host.ts';
import type { LoadedTheme } from './theme-loader.ts';
import type { UiState, ViewModel } from './view-model.ts';
import type { SpaceBackground, State } from '../../../types/margin';
import { View } from './render.ts';
import { createBackground } from './background.ts';
import { checkIconUrl } from './sanitize.ts';
import { buildViewModel, paletteItems } from './view-model.ts';
import { BEHAVIOR_ONLY, checkAction, contextFromState, requestFor } from './actions.ts';
import { resolveSettings } from './theme-loader.ts';
import { menuItems } from './behaviors/menu-items.ts';
import * as V from '../../../extension/shared/view.ts';
import { createSwitching, NEW_TAB, opensNewTab } from '../../../extension/shared/switching.ts';
import { installPalette } from './behaviors/palette.ts';
import { installPeek } from './behaviors/peek.ts';
import { installCard } from './behaviors/card.ts';
import { installResize } from './behaviors/resize.ts';
import { installMenus } from './behaviors/menus.ts';
import { installSplit } from './behaviors/split.ts';
import { installRename } from './behaviors/rename.ts';
import { installEditor } from './behaviors/editor.ts';
import { installDrag } from './behaviors/drag.ts';
import { installScroll } from './behaviors/scroll.ts';
import { installSwipe } from './behaviors/swipe.ts';
import { installPress } from './behaviors/press.ts';
import { installSettings } from './behaviors/settings.ts';
import { installBackgroundPicker } from './behaviors/background-picker.ts';
import { pickerItemIds } from './picker/view.ts';
import { createIntents } from './intents.ts';
import type { Front } from './intents.ts';
import { createRowMotion } from './row-motion.ts';

const CLOSED_PALETTE = Object.freeze({ open: false, query: '', selected: 0, newTab: false, selectAll: false });
const TOAST_MS = 1800;
// What's shown ahead of the state lasts this long at most (sidebar.js SHOWN_SPACE_MS).
const PENDING_MS = 3000;
// The page was shown this recently: its own tab's space until the state
// records it's in front (content/core.ts JUST_SHOWN_MS, shared/view.ts sidebar).
const JUST_SHOWN_MS = 2000;
// The palette opened for a new tab: "+ New Tab" stays highlighted this long
// after a choice that shows another tab, or until the page is hidden
// (content/palette.js newTabCloser).
const NEW_TAB_HOLD_MS = 1500;
const SHOWS_ANOTHER_TAB = new Set(['activateTab', 'newTab', 'openPin', 'restoreArchive', 'search', 'openLauncher']);
const SWITCH_REQUESTS = new Set(['activateTab', 'openPin', 'openFavorite', 'setSpace']);
// Rows a ⌃-click opens the menu on rather than runs (the Mac's right-click).
const ROW_ACTIONS = new Set(['tab.activate', 'pin.open', 'favorite.open', 'folder.toggle']);

// The UI's own state (always with a palette: closed, or as it's open).
type Ui = UiState & { palette: NonNullable<UiState['palette']> } & Record<string, any>;
// The stored state, as the host has it.
type HostState = ReturnType<Host['getState']>;
// What each behavior is given (ui/behaviors/): the runtime's parts, and what it does for them (createRuntime).
export type Rt = {
  host: Host, theme: LoadedTheme, themeInfo: Readonly<{ id: string, name: string, settings: Record<string, any> }>,
  view: View, doc: Document, win: Window & typeof globalThis, container: ShadowRoot | Document,
  /** Margin's pixels per page pixel. */
  scale: () => number,
  readonly vm: ViewModel | null,
  readonly ui: Ui,
  readonly state: HostState,
  viewState: () => HostState,
  setUi: (patch: Partial<UiState> & Record<string, any>) => ViewModel | null,
  render: () => ViewModel | null,
  dispatch: (name: string, arg: any, origin?: 'theme' | 'behavior' | 'menu', info?: any) => any,
  send: (type: string, payload: Record<string, any>) => Promise<any>,
  refuse: (name: string, arg: any, reason: string) => boolean,
  warn: (message: string) => void,
  runQuery: (query: string) => any,
  windowId: () => number | null,
  ownTab: () => number | null,
  frontTab: () => number | null,
  recentTabOf: (spaceId: string) => any,
  switchSpace: (spaceId: string, payload: Record<string, any>) => Promise<any> | null,
  holdSpace(spaceId: string, ms: number): void,
  switching: ReturnType<typeof createSwitching>,
  readonly lastToggle: { folderId: string, wasOpen: boolean, at: number } | null,
  setThemeSettings(values: Record<string, any> | null, options?: { live?: boolean }): void,
  busy: (except?: unknown) => boolean,
  listen(target: EventTarget, type: string, fn: (e: any) => void, options?: boolean | AddEventListenerOptions): void,
  later(fn: () => void, ms: number): ReturnType<typeof setTimeout>,
  cancel(id: ReturnType<typeof setTimeout> | null | undefined): void,
  readonly destroyed: boolean,
  spaceView(id: string): ViewModel | null,
  /** A short note at the top of the window (the `toast` part, or Margin's own). */
  showToast(text: string, ms?: number): void,
  /**
   * A space's background drawn ahead of the state (the picker: ui/behaviors/background-picker.ts): `held` while a
   * gesture runs (until the next call), else until the state has it (PENDING_MS at most). Nothing else is drawn again.
   */
  previewBackground(spaceId: string, value: SpaceBackground | null, options: { held: boolean }): void,
  /** Margin's own panel (the picker) opened or closed: the host is told (`onPanel`). */
  panelChanged(): void,
  // Each behavior's own (createRuntime: set before any is installed).
  behaviors: Record<string, any>,
};

/**
 * @param options `ui`: the UI state to start from; `log`: every action refused;
 * `onSwitching`: the tab a switch from the UI is highlighting (null: none);
 * `onPalette`: the palette closed, a row chosen (`run`, with what it sends
 * or does: ui/actions.ts requestFor) or not (`close`), for the new-tab
 * page's hand-off (newtab/newtab.ts);
 * `onSwitchSlow`, `onSwitchFailed`: a switch asked for from the UI takes a
 * while, or didn't happen (shared/switching.ts; the in-page host's loading
 * pill and notice); `onSwitchRun`: each chain of switches as it ends, with a
 * host whose UI stays on screen (shared/switching.ts SwitchRun: Margin.app's log)
 */
export function createRuntime({ host, theme, container, ui: start = {}, onWarn, log, onSwitchSlow, onSwitchFailed, onPalette, onSwitching, onSwitchRun, onGround, onPanel, materials }: {
  host: Host,
  theme: LoadedTheme,
  container: ShadowRoot | Document,
  ui?: Partial<UiState>,
  onWarn?: (message: string) => void,
  log?: (entry: { name: string, arg: any, reason: string }) => void,
  onSwitchSlow?: (slow: boolean) => void,
  onSwitchFailed?: () => void,
  onPalette?: (what: 'run' | 'close', request?: any) => void,
  onSwitching?: (tabId: number | string | null) => void,
  onSwitchRun?: (run: import('../../../extension/shared/switching.ts').SwitchRun) => void,
  /** The ground Margin draws under the theme changed (a space's background shown, changed or gone): what's around the page's corners may have (`backgroundAt`). */
  onGround?: () => void,
  /** Margin's own panel (Edit Theme Color) opened or closed: while it's open it takes the keys and the pointer where it is (`panelOpen`, `panelRect`). */
  onPanel?: () => void,
  /**
   * The system's materials for Margin's own panel (Edit Theme Color's glass), asked for as it opens (true) and given
   * back as it closes (false); resolves once the page has the answer. Margin.app's (app/shared/host/overlay.ts); none
   * elsewhere: the panel is drawn solid.
   */
  materials?: (on: boolean) => Promise<unknown>,
}) {
  // (Always with a palette: closed, or as it's open.)
  let ui: Ui = { sidebar: null, palette: CLOSED_PALETTE, menu: null, editing: null, editor: null, notice: null, prompt: null, toast: null, focused: true, switchingTo: null, newTabPending: false, opening: null, ...start };
  let vm: ViewModel | null = null;
  let drawn: ViewModel | null = null;
  let savedKey: string | null = null; // the theme's saved settings last applied (as JSON)
  let settings = resolveSettings(theme.manifest, null);
  let destroyed = false;
  const refused: { name: string, arg: any, reason: string }[] = [];
  const warn = onWarn ?? ((message) => console.warn('[margin]', message));
  const doc = ((container.nodeType === 9 ? container : container.ownerDocument) as Document);
  const win = (doc.defaultView as Window & typeof globalThis);
  const offs: (() => unknown)[] = [];
  const timers = new Set<ReturnType<typeof setTimeout> | null | undefined>();

  // ---- what's shown ahead of the state ------------------------------------------
  const pending = {
     settings: null as { patch: Record<string, any>, until: number } | null,
     folders: new Map() as Map<string, { name: string, until: number }>,
     spaces: new Map() as Map<string, { patch: Record<string, any>, until: number }>,
     space: null as { spaceId: string, since: number, windowId: number | null } | null,
     themeSettings: null as { values: Record<string, any>, live: boolean, until: number } | null,
    // A space kept shown a moment though the state has moved on: a swipe's slide still coming in, its switch asked
    // of the copy as it settled (behaviors/swipe.js holdSpace). The space asked for (`space`) comes after it.
     hold: null as { spaceId: string, until: number } | null,
  };
  // A row closed, a pin opened: drawn at the click, until the state agrees (ui/intents.ts). What's in front ahead of
  // the state (`front`) is the UI state's, as the last viewState worked it out.
  const intents = createIntents({ onChange: () => { if (!destroyed) render(); } });
  let front: Front | null = null;
  // Re-drawn when the soonest of them runs out.
  let expiryTimer: Timer | null = null;
  function expireLater() {
    const ends = [intents.nextDeadline() ?? undefined, pending.settings?.until, ...[...pending.folders.values()].map((p) => p.until), ...[...pending.spaces.values()].map((p) => p.until),
      pending.space ? pending.space.since + PENDING_MS + 50 : undefined, pending.hold ? pending.hold.until + 1 : undefined, pending.themeSettings && !pending.themeSettings.live ? pending.themeSettings.until : undefined,
      backgroundAhead?.until != null ? backgroundAhead.until + 5 : undefined].filter((t) => t != null);
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
    return (Object.values(state.tabs).find((t) => (t as any).windowId === w && (t as any).active) as any)?.id ?? null;
  };

  // The state as the UI shows it: the stored one, with what's shown ahead of it.
  function viewState(raw: HostState): HostState {
    if (!raw?.spaces) return raw;
    const now = Date.now();
    let state = raw as State & Record<string, any>; // (with spaces: a stored state)
    const p = pending;
    if (p.settings) {
      const same = (a: unknown, b: unknown) => a === b || (typeof a === 'object' && a !== null && JSON.stringify(a) === JSON.stringify(b));
      const agrees = Object.entries(p.settings.patch).every(([k, v]) => same(v, (raw.settings as Record<string, unknown> | undefined)?.[k]));
      if (agrees || now > p.settings.until) p.settings = null;
      else state = { ...state, settings: { ...state.settings, ...p.settings.patch } };
    }
    for (const [id, entry] of p.folders) {
      const folder = raw.folders?.find((f) => f.id === id);
      if (!folder || folder.name === entry.name || now > entry.until) p.folders.delete(id);
    }
    if (p.folders.size) state = { ...state, folders: state.folders.map((f) => (p.folders.has(f.id) ? { ...f, name: p.folders.get(f.id)!.name } : f)) }; // (has: there)
    for (const [id, entry] of p.spaces) {
      const space = raw.spaces.find((s) => s.id === id);
      if (!space || Object.entries(entry.patch).every(([k, v]) => (space as unknown as Record<string, unknown>)[k] === v) || now > entry.until) p.spaces.delete(id);
    }
    if (p.spaces.size) state = { ...state, spaces: state.spaces.map((s) => (p.spaces.has(s.id) ? { ...s, ...p.spaces.get(s.id)!.patch } : s)) }; // (has: there)
    if (p.hold) {
      if (now > p.hold.until) p.hold = null;
      else state = { ...state, activeSpaceByWindow: { ...state.activeSpaceByWindow, [windowId() as number]: p.hold.spaceId } };
    }
    // Tab activation and selected-space storage arrive separately. Keep the
    // selected space until its own state agrees, even after its tab lands.
    if (p.space) {
      const w = windowId();
      const over = w !== p.space.windowId || !raw.spaces.some((s) => s.id === p.space!.spaceId)
        || V.activeSpaceId(raw as State, w) === p.space.spaceId || now - p.space.since > PENDING_MS;
      if (over) p.space = null;
      else state = { ...state, activeSpaceByWindow: { ...state.activeSpaceByWindow, [w as number]: p.space.spaceId } };
    }
    const predicted = intents.apply(raw, state);
    front = predicted.front;
    return predicted.state;
  }

  // ---- the switch highlight (shared/switching.ts) ---------------------------------
  let switchAskedAt = 0;
  let lastShownAt = doc.hidden ? 0 : Date.now();
  let firstRender = true;
  const onVisibility = () => { if (!doc.hidden) lastShownAt = Date.now(); };
  doc.addEventListener('visibilitychange', onVisibility);
  offs.push(() => doc.removeEventListener('visibilitychange', onVisibility));
  // A host whose UI stays on screen through a switch (Margin.app's overlay:
  // `staysOnScreen`) keeps the highlight until the state has the tab in front,
  // through a chain of switches (shared/switching.ts `front`); a page's ends
  // as it's hidden.
  const stays = !!((host as any).staysOnScreen);
  const switching = createSwitching({
    // A new tab's row (`opening`) lasts as long as the switch to it (NEW_TAB).
    // (A switch asked for: a pin opened before it is no longer drawn in front, ui/intents.ts.)
    onChange: (id) => { if (destroyed) return; if (id != null) intents.dropOpens(); onSwitching?.(id); setUi({ switchingTo: id, ...(id !== NEW_TAB && ui.opening ? { opening: null } : {}) }); },
    onSlow: (slow) => { if (!destroyed) onSwitchSlow?.(slow); },
    failed: (result) => result === undefined,
    onFailed: () => { if (!destroyed) onSwitchFailed?.(); },
    doc,
    front: stays ? () => { const id = frontTab(); const mid = id != null ? host.getState()?.tabs?.[id]?.mid : null; return mid && mid === ui.switchingTo ? mid : id; } : null,
    onRun: stays && onSwitchRun ? (run) => { if (!destroyed) onSwitchRun(run); } : null,
  });

  const themeInfo = Object.freeze({ id: theme.manifest?.id ?? theme.id, name: theme.manifest?.name ?? '', settings: theme.manifest?.settings ?? {} });
  // Whether the theme draws the Settings page's categories (set once its template is compiled, below).
  let drawsSettingsNav = false;
  // The UI state with what the host knows (its window, tab and mode).
  const fullUi = () => ({
    ...ui,
    windowId: windowId(),
    tabId: ownTab(),
    mode: host.mode ?? 'inpage',
    inNewTab: !!host.inNewTab,
    launcherPage: !!host.launcher,
    // Margin.app's own window, an item opening in the page area: the page card's loader, with its name.
    pageOpening: host.pageState === 'loading' || host.pageState === 'elsewhere'
      ? { name: host.pageOpening ?? '', bundleId: host.pageOpeningBundleId ?? null, starting: host.pageStarting === true, elsewhere: host.pageState === 'elsewhere' } : null,
    // Margin.app's own window hosting another app's window beside it: no page area here (ui/host-app.ts).
    pageOutside: !!(host as { pageOutside?: boolean }).pageOutside,
    // The sidebar kept docked by the host (Margin.app hosting: beside a tile, or under an app's window in window mode).
    sidebarDocked: !!(host as { sidebarDocked?: boolean }).sidebarDocked,
    settingsPage: !!host.settingsAsked || !!ui.settingsPage,
    // Margin.app's own window: Settings is its own tab there (margin://settings), never under the launcher's search.
    appWindow: !!host.appWindow,
    // The theme draws the Settings page's categories (it reads `settingsTab`): one category's fields at a time.
    settingsNav: drawsSettingsNav,
    // The active theme, for Settings' "Settings of …" (ui/settings-form.ts): its id, name and theme.json settings.
    theme: themeInfo,
    justShown: (firstRender || Date.now() - lastShownAt < JUST_SHOWN_MS) && switchAskedAt <= lastShownAt,
    front,
  });

  // The shown space's background (M2.9: ui/background.ts): Margin's layer under the theme, cut out of the page card at
  // every layout, its variables in a sheet of Margin's with the theme's.
  // (A space's picture loaded, or failed: drawn again.)
  const background = createBackground({ doc, container, onChange: () => { if (!destroyed) followBackground(); } });
  const view = new View(container, theme.template, {
    sheets: [theme.sheet, theme.settingsSheet, background.sheet].filter(Boolean),
    onAction: (name, arg, info) => { themeClick(name, arg, info); },
    onInput: (name, value) => { for (const b of list) b.onInput?.(name, value); },
    onLayout: (geometry) => { placeLoader(); behaviors.card?.layout?.(); background.place(view.measurePageOuter()); host.reportLayout({ ...geometry, windowId: windowId(), mode: host.mode ?? 'inpage' }); },
    onWarn: (message) => warn(message),
  });
  drawsSettingsNav = view.reads('settingsTab');
  // Rows that come or go slide the others to their places (ui/row-motion.ts); not while a row is being dragged.
  const motion = createRowMotion(view, win, { skip: () => !!behaviors.drag?.active?.() });

  // The theme's settings: what's saved, with a width being dragged (resize).
  function themeSettings(state: (Partial<State> & Record<string, any>) | null) {
    const own = state?.settings?.themes?.[theme.id];
    const p = pending.themeSettings;
    if (p && !p.live) {
      const agrees = Object.entries(p.values).every(([k, v]) => own?.[k] === v);
      if (agrees || Date.now() > p.until) pending.themeSettings = null;
    }
    return pending.themeSettings ? { ...(own ?? {}), ...pending.themeSettings.values } : own;
  }

  // The shown space's background drawn (or none), as the system asks now (dark, more contrast, less motion), and what
  // it's drawn as on the theme's root: `m-background` while there's one, `m-appearance` its light or dark (themes
  // README, "A space's background"). Placed at once the first time (later layouts place it: the view's onLayout).
  const media = (query: string) => !!win.matchMedia?.(query).matches;
  // A background drawn ahead of the state (rt.previewBackground): `until` null while held.
  let backgroundAhead: { spaceId: string, value: SpaceBackground | null, until: number | null } | null = null;
  function backgroundShown(space: ViewModel['space'] | undefined): SpaceBackground | null {
    const stored = space?.background ?? null;
    const ahead = backgroundAhead;
    if (!ahead || !space || ahead.spaceId !== space.id) return stored;
    if (ahead.until !== null && (JSON.stringify(stored) === JSON.stringify(ahead.value) || Date.now() > ahead.until)) {
      backgroundAhead = null;
      return stored;
    }
    return ahead.value;
  }
  function followBackground() {
    const space = vm?.space;
    const shownBackground = backgroundShown(space);
    const was = background.active();
    const before = background.revision();
    const appearance = background.update({
      spaceId: space?.id ?? '', background: shownBackground,
      systemDark: media('(prefers-color-scheme: dark)'), moreContrast: media('(prefers-contrast: more)'), reducedMotion: media('(prefers-reduced-motion: reduce)'),
      picture: shownBackground?.image ? host.pictureUrl?.(shownBackground.image.id) ?? null : null,
    });
    if (appearance && !was) background.place(view.measurePageOuter());
    if (background.revision() !== before) onGround?.();
    const root = view.rootElement() as HTMLElement | null;
    if (!root) return;
    if (appearance) {
      if (!root.hasAttribute('m-background')) root.setAttribute('m-background', '');
      if (root.getAttribute('m-appearance') !== appearance) root.setAttribute('m-appearance', appearance);
    } else if (root.hasAttribute('m-background') || root.hasAttribute('m-appearance')) {
      root.removeAttribute('m-background');
      root.removeAttribute('m-appearance');
    }
  }
  for (const query of ['(prefers-color-scheme: dark)', '(prefers-contrast: more)']) {
    const mq = win.matchMedia?.(query);
    if (!mq?.addEventListener) continue;
    const changed = () => { if (!destroyed) followBackground(); };
    mq.addEventListener('change', changed);
    offs.push(() => mq.removeEventListener('change', changed));
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
    // Nothing changed (the same model): nothing to draw. Rows that came or went: the others slide to their places.
    if (vm !== drawn) {
      const moving = motion.before(drawn, vm);
      drawn = vm;
      view.update(vm);
      if (moving) motion.after();
    }
    followPage();
    followBackground();
    followToast();
    if (vm.ready) firstRender = false;
    for (const b of list) b.afterRender?.(vm, prev);
    expireLater();
    return vm;
  }

  // ---- the theme's root: the page card's state, and the start ------------------------------
  //
  // `m-page-state` (Margin.app's own window only: host.pageState): `shown`, `loading`, `elsewhere` (its item in another
  // Margin window: its card, faded) or `empty`, for the theme's CSS.
  // While it's `loading` the page card is opaque with a loader: the theme's own (`<template m-part="page-loader">` in
  // its `<m-page-loader>`, drawn by the view), or, when the theme has none, Margin's default, made here: one element
  // on the root, laid over the page's place as the view measures it (a quiet spinner and Margin's words; its look is
  // ui/render.ts BASE_CSS, which a theme's CSS can restyle as `m-page-loader`). It stays in the tree while the state is
  // `shown` for its fade-out, see-through and never taking the pointer.
  // `m-starting`: from the root's first frame until a frame after the state's data was first drawn (a theme's
  // skeleton); never set when the data is there at the first draw.
  let defaultToast: HTMLElement | null = null;
  let toastTimer: Timer | null = null;
  let toastSeq = 0;
  function showToast(text: string, ms: number = TOAST_MS) {
    const clean = String(text ?? '').trim().slice(0, 140);
    if (!clean || destroyed) return;
    clearTimeout(toastTimer);
    const id = `toast-${++toastSeq}`;
    setUi({ toast: { id, text: clean } });
    toastTimer = setTimeout(() => {
      toastTimer = null;
      if (!destroyed && ui.toast?.id === id) setUi({ toast: null });
    }, Math.max(300, ms));
  }
  function followToast() {
    const root = (view.rootElement() as HTMLElement | null);
    if (!root) return;
    const own = view.parts.has('toast') && !!root.querySelector('m-toast:not([m-default])');
    if (own || !vm?.toast) {
      if (defaultToast) { defaultToast.remove(); defaultToast = null; }
      return;
    }
    if (!defaultToast) {
      defaultToast = doc.createElement('m-toast');
      defaultToast.setAttribute('m-default', '');
      defaultToast.setAttribute('role', 'status');
      defaultToast.setAttribute('aria-live', 'polite');
    }
    if (defaultToast.textContent !== vm.toast.text) defaultToast.textContent = vm.toast.text;
    if (defaultToast.parentNode !== root) root.appendChild(defaultToast);
  }
  function copyText(text: string, label: string) {
    if (!text) return false;
    if (host.perform?.('copyUrl', { url: text })) { showToast(label); return true; }
    try {
      void win.navigator?.clipboard?.writeText?.(text).catch(() => {});
    } catch {}
    showToast(label);
    return true;
  }

  let defaultLoader: HTMLElement | null = null;
  // `elsewhere` with a web item's picture (host.pagePicture): `<m-page-picture>` over the page's place, above any
  // loader: the page as Safari last showed it, faded, and the card's words (BASE_CSS; a theme may restyle it). Made
  // when needed, removed (its image with it) once the state or the picture goes. `m-page-picture` on the root meanwhile.
  let picture: HTMLElement | null = null;
  function followPicture(root: HTMLElement, state: string) {
    const data = state === 'elsewhere' ? host.pagePicture ?? null : null;
    if (!data) {
      if (picture) { picture.remove(); picture = null; }
      if (root.hasAttribute('m-page-picture')) root.removeAttribute('m-page-picture');
      return;
    }
    if (!picture) {
      picture = doc.createElement('m-page-picture');
      picture.setAttribute('role', 'status');
      const img = doc.createElement('img');
      img.setAttribute('alt', '');
      img.setAttribute('aria-hidden', 'true');
      img.setAttribute('decoding', 'async');
      const label = doc.createElement('span');
      label.setAttribute('m-picture-label', '');
      picture.append(img, label);
    }
    const img = picture.firstChild as HTMLImageElement;
    if (img.getAttribute('src') !== data) img.setAttribute('src', data);
    const label = picture.lastChild as HTMLElement;
    const text = vm?.pageLoader?.label ?? '';
    if (label.textContent !== text) label.textContent = text;
    if (!root.hasAttribute('m-page-picture')) root.setAttribute('m-page-picture', '');
    if (picture.parentNode !== root) root.appendChild(picture);
  }
  // `m-startup` (Margin.app's own window, host.pageStarting: its default browser getting ready, HostedSession.swift
  // resumeLast): the start screen. `<m-startup>`, Margin's, over the whole window and everything in it, takes the
  // pointer (nothing under it can be pressed); a theme draws its loader's own marks in it, with no app's icon and no
  // words (its CSS: `> m-startup`, `::before` and `::after`, its `[m-startup-spin]` hidden), Margin's quiet spinner
  // otherwise. Held up (host.pageStuck), it says what's wrong, with Try again and Continue without Safari.
  let startup: HTMLElement | null = null;
  function followStartup(root: HTMLElement) {
    const on = host.pageState === 'loading' && host.pageStarting === true;
    if (!on) {
      if (startup) { startup.remove(); startup = null; }
      if (root.hasAttribute('m-startup')) root.removeAttribute('m-startup');
      return;
    }
    if (!root.hasAttribute('m-startup')) root.setAttribute('m-startup', '');
    if (!startup) {
      startup = doc.createElement('m-startup');
      startup.setAttribute('role', 'status');
      startup.setAttribute('aria-label', 'Margin is starting');
      const spin = doc.createElement('span');
      spin.setAttribute('m-startup-spin', '');
      spin.setAttribute('aria-hidden', 'true');
      startup.append(spin);
      startup.addEventListener('click', (e) => {
        const button = (e.target as Element | null)?.closest?.('[m-startup-action]');
        const action = button?.getAttribute('m-startup-action');
        if (action === 'retry' || action === 'skip') host.perform?.(action === 'retry' ? 'startup.retry' : 'startup.skip');
      });
    }
    const stuck = host.pageStuck ?? null;
    let said = startup.querySelector('[m-startup-stuck]');
    if (!stuck) said?.remove();
    else if (said?.querySelector('[m-startup-text]')?.textContent !== stuck) {
      said?.remove();
      said = doc.createElement('div');
      said.setAttribute('m-startup-stuck', '');
      const text = doc.createElement('p');
      text.setAttribute('m-startup-text', '');
      text.textContent = stuck;
      const actions = doc.createElement('div');
      actions.setAttribute('m-startup-actions', '');
      for (const [action, label] of [['retry', 'Try again'], ['skip', 'Continue without Safari']] as const) {
        const b = doc.createElement('button');
        b.setAttribute('type', 'button');
        b.setAttribute('m-startup-action', action);
        b.textContent = label;
        actions.append(b);
      }
      said.append(text, actions);
      startup.append(said);
    }
    if (startup.parentNode !== root || startup !== root.lastElementChild) root.appendChild(startup);
  }
  let started = false;
  let startingOn = false;
  function followPage() {
    const root = (view.rootElement() as HTMLElement | null);
    if (!root) return;
    if (!started) {
      if (vm?.ready) {
        started = true;
        if (startingOn) {
          const done = () => { if (!destroyed) root.removeAttribute('m-starting'); };
          const timer = setTimeout(done, 100); // (no frames while the page is off screen)
          win.requestAnimationFrame?.(() => { clearTimeout(timer); done(); });
        }
      } else if (!startingOn) {
        startingOn = true;
        root.setAttribute('m-starting', '');
      }
    }
    const state = host.pageState;
    if (!state) return;
    if (root.getAttribute('m-page-state') !== state) root.setAttribute('m-page-state', state);
    followPicture(root, state);
    followStartup(root);
    const own = view.parts.has('page-loader') && !!root.querySelector('m-page-loader:not([m-default])');
    if (own) { defaultLoader?.remove(); defaultLoader = null; placeLoader(); return; }
    if (!defaultLoader) {
      if (state !== 'loading' && state !== 'elsewhere') return; // (made the first time it's needed)
      defaultLoader = doc.createElement('m-page-loader');
      defaultLoader.setAttribute('m-default', '');
      defaultLoader.setAttribute('role', 'status');
      // (The opening app's icon, the browser's for a web item: shown only with one, render.ts.)
      const icon = doc.createElement('img');
      icon.setAttribute('m-loader-icon', '');
      icon.setAttribute('alt', '');
      icon.setAttribute('aria-hidden', 'true');
      const spin = doc.createElement('span');
      spin.setAttribute('m-loader-spin', '');
      spin.setAttribute('aria-hidden', 'true');
      const label = doc.createElement('span');
      label.setAttribute('m-loader-label', '');
      defaultLoader.append(icon, spin, label);
    }
    if (defaultLoader.parentNode !== root) root.appendChild(defaultLoader);
    if (state === 'loading' || state === 'elsewhere') {
      const label = (defaultLoader.lastChild as HTMLElement);
      const text = vm?.pageLoader?.label ?? '';
      if (label.textContent !== text) label.textContent = text;
      const icon = (defaultLoader.firstChild as HTMLElement);
      // (The view model's icon is checked already, checkIconUrl: checked again, as a theme's m-icon is.)
      const src = checkIconUrl(vm?.pageLoader?.icon) ? vm!.pageLoader!.icon! : null;
      if (icon.getAttribute('src') !== src) { if (src) icon.setAttribute('src', src); else icon.removeAttribute('src'); }
    }
    placeLoader();
  }
  // Margin's default loader over the page's place: `<m-page>`'s content box and its corners, as the view measures them.
  function placeLoader() {
    const els = [defaultLoader, picture].filter((el): el is HTMLElement => !!el?.isConnected);
    const g = els.length ? view.measure() : null;
    if (g) for (const el of els) place(el, g);
  }
  function place(el: HTMLElement, g: NonNullable<ReturnType<typeof view.measure>>) {
    const s = el.style;
    const set = (name: string, value: string) => { if (s.getPropertyValue(name) !== value) s.setProperty(name, value); };
    set('left', `${g.insets.left}px`);
    set('top', `${g.insets.top}px`);
    set('width', `${Math.max(0, g.container.width - g.insets.left - g.insets.right)}px`);
    set('height', `${Math.max(0, g.container.height - g.insets.top - g.insets.bottom)}px`);
    set('border-radius', g.radii.map((r) => `${r}px`).join(' '));
  }

  function setUi(patch: Partial<UiState> & Record<string, any>) {
    ui = { ...ui, ...patch };
    return render();
  }

  function refuse(name: string, arg: any, reason: string) {
    const entry = { name: String(name), arg, reason };
    refused.push(entry);
    if (refused.length > 100) refused.shift();
    log?.(entry);
    return false;
  }

  // ---- requests ------------------------------------------------------------------

  /**
   * A request to the background, and what Margin does around it: a switch
   * highlights its tab at once (shared/switching.ts), the list's scroll is
   * saved first (the next page asks for it at once).
   * */
  function send(type: string, payload: Record<string, any>) {
    if (SWITCH_REQUESTS.has(type) || opensNewTab(type, payload)) behaviors.scroll?.flush();
    if (SWITCH_REQUESTS.has(type)) switchAskedAt = Date.now();
    const request = host.send(type, payload);
    const state = (host.getState() as any);
    const target = type === 'activateTab' ? payload.tabId
      : type === 'openPin' && state ? V.pinTabId(state, payload.pinId, payload.windowId ?? windowId())
      : type === 'openFavorite' && state ? V.favoriteTabId(state, payload.favoriteId, payload.windowId ?? windowId())
      : opensNewTab(type, payload) ? NEW_TAB : null;
    if (Number.isInteger(target) || typeof target === 'string') {
      // Back to the tab in front: a switch away still under way ends, or, in
      // a chain on screen, goes on to it (shared/switching.ts toFront).
      if (target === frontTab()) switching.toFront(target, request);
      else if (target !== ui.switchingTo) switching.start(target, request);
    } else if (type === 'openPin' && state) {
      // A pin with no tab yet: the switch has nothing to highlight, so the pin is drawn in front (ui/intents.ts).
      const pin = state.pins?.find((p: { id: string }) => p.id === payload.pinId);
      if (pin) {
        switching.end();
        intents.open(pin, payload.windowId ?? windowId(), request);
      }
    }
    return request;
  }

  // The most recent tab of a space in this window: the one its switch shows.
  const recentTabOf = (spaceId: string) => {
    const state = host.getState();
    const w = windowId();
    // (Tabs only when there's a state.)
    return (Object.values(state?.tabs ?? {}).filter((t) => (t as any).windowId === w && state!.tabSpace?.[(t as any).id] === spaceId)
      .sort((a, b) => ((b as any).lastActive ?? 0) - ((a as any).lastActive ?? 0))[0] as any) ?? null;
  };

  // A space asked for (its chip pressed or clicked, a swipe): the window
  // switches to it, and the UI shows it at once, from the top of its list
  // (sidebar.js askSpace, switchSpace). Its own space with no switch away
  // under way: only the window's space, as before.
  function switchSpace(spaceId: string, payload: Record<string, any>) {
    const state = host.getState();
    if (!state) return null;
    const own = ownTab() ?? frontTab();
    const shownSpace = vm?.space?.id;
    if (!pending.space && state.tabSpace?.[own] === spaceId && ui.switchingTo == null && shownSpace === spaceId) return host.send('setSpace', payload);
    behaviors.scroll?.reset();
    pending.hold = null;
    switchAskedAt = Date.now();
    const request = host.send('setSpace', payload);
    const selection = { spaceId, since: Date.now(), windowId: windowId() };
    pending.space = selection;
    // A failed request rolls back only its own selection; an older answer
    // must not undo a newer click, including another click on the same space.
    const failed = () => {
      if (destroyed || pending.space !== selection) return;
      pending.space = null;
      render();
    };
    request.then((result) => { if (result === undefined) failed(); }, failed);
    if (state.tabSpace?.[own] === spaceId) {
      // Back to this page's own space: a switch away still pending stops (on
      // screen, the chain goes on to the tab in front: shared/switching.ts toFront).
      const back = ui.switchingTo != null && own != null ? host.send('activateTab', { tabId: own }) : null;
      if (back && stays) switching.toFront(own, back);
      else switching.end();
    } else {
      const tab = recentTabOf(spaceId);
      if (tab && tab.id !== frontTab()) switching.start(tab.id, request);
    }
    render();
    return request;
  }

  /**
   * Runs one action: checked against the host's state (the tab must be open,
   * the space must exist, the palette row must be on screen), then sent,
   * done here, or handed to the host. False if refused. `origin`: who asked
   * ('theme': a click on the theme; 'behavior', 'menu': Margin's own, which
   * alone may run BEHAVIOR_ONLY actions).
   */
  // True or false (ran, or not), a request's answer to come (tab.move), or a behavior's own.
  function dispatch(name: string, arg: any, origin: 'theme' | 'behavior' | 'menu' = 'theme', info: any = null): unknown {
    if (destroyed) return false;
    if (origin === 'theme' && BEHAVIOR_ONLY.has(name)) return refuse(name, arg, `${name}: only Margin's behaviors and menus run it`);
    const state = host.getState();
    const now = fullUi();
    // (The palette's rows as drawn: from the state as the UI shows it, a row closed a moment ago not among them.)
    const items = ui.palette.open ? paletteItems(viewState(state), now, host.platform) : [];
    const menu = ui.menu && vm ? menuItems((ui.menu as any), { state: viewState(state), space: vm.space, favorites: vm.favorites, features: (host.platform as any)?.features ?? null }) : [];
    const colors = vm?.editor ? vm.editor.colors.map((c) => c.id) : [];
    const noticeIds = vm?.notice?.actions.map((a) => a.id) ?? [];
    const promptIds = vm?.prompt?.actions.map((a) => a.id) ?? [];
    const settingIds = vm?.settingsForm?.fields.filter((f) => f.isButton && !f.disabled).map((f) => f.id) ?? [];
    const themeIds = themeChoices((host.platform as any)?.features).map((c) => c.id);
    // (Edit Theme Color drawn by the theme: its items, as it shows them now.)
    const pickerIds = vm?.picker ? pickerItemIds(vm.picker) : [];
    const verdict = checkAction(name, arg, contextFromState(state, items.map((i) => i.id), { menuIds: menu.filter((i) => !i.separator).map((i) => i.id), colorIds: colors, noticeIds, promptIds, settingIds, themeIds, pickerIds }));
    if (!verdict.ok) return refuse(name, arg, (verdict as any).reason);
    // A pane that can't fit in Margin's window's page area beside the others (each one's minimum): not added, said.
    if (name === 'split.add' || name === 'split.addPane') {
      const why = behaviors.split?.refusesAdd?.(arg);
      if (why) { showToast(why); return refuse(name, arg, why); }
    }
    // ...nor stacked (or put side by side) when they wouldn't fit along the other axis.
    if (name === 'split.toggleAxis') {
      const why = behaviors.split?.refusesAxis?.(arg);
      if (why) { showToast(why); return refuse(name, arg, why); }
    }
    // Margin's own pages over a browser (the launcher) open their Settings in place; Margin's window opens its Settings
    // tab (the host's openLauncher: HostedSession.swift, a margin://settings item).
    if (name === 'settings.open' && host.launcher && !host.appWindow) return local('settings.toggle', undefined, info);
    // Made from what's drawn (a fold or Keep open pressed again before the
    // state agrees asks for the other way, not the same again).
    const request = requestFor(name, arg, { state: viewState(state), ui: { windowId: now.windowId, sidebar: vm?.window.sidebar ?? null }, platform: host.platform, row: name === 'palette.run' ? items.find((i) => i.id === arg) : null });
    // Choosing a row closes the palette first (Arcadia's palette); one opened
    // for a new tab keeps "+ New Tab" lit while another tab comes to the front.
    // A row that opens a new tab (a search, an address) draws that tab's row at
    // once instead, highlighted (shared/view.ts `opening`), until its tab is in front.
    if (name === 'palette.run') {
      const wasNewTab = ui.palette.newTab;
      const opens = request.kind === 'send' && opensNewTab(request.type, request.payload);
      const shows = request.kind === 'send' && SHOWS_ANOTHER_TAB.has(request.type) && !opens;
      setUi({ palette: CLOSED_PALETTE, newTabPending: wasNewTab && shows, ...(opens ? { opening: openingFor(request.payload) } : {}) });
      if (wasNewTab && shows) holdNewTab();
      behaviors.palette?.closed(opens);
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
      default: return refuse(name, arg, (request as any).reason);
    }
  }

  // A sent action, and what follows it.
  // (`arg`: checked by checkAction, ui/actions.ts: the shape its action takes.)
  function sent(name: string, arg: any, type: string, payload: Record<string, any>) {
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
      case 'folder.new': case 'folder.newIn': case 'folder.newWithTab': case 'folder.newWithPin':
        // Its name, edited in place once it's drawn (sidebar.js folderCreated).
        void Promise.resolve(host.send(type, payload)).then((id) => { if (typeof id === 'string') behaviors.rename.startWhenThere('folder', id); });
        return true;
      case 'folder.setName':
        pending.folders.set(arg.folder, { name: arg.name, until: Date.now() + PENDING_MS });
        break;
      case 'space.setBackground':
        // (Its key colour, the space's colour: shown at once, as a rename's.)
        if (typeof arg.color === 'string') pending.spaces.set(arg.space, { patch: { color: arg.color }, until: Date.now() + PENDING_MS });
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
      case 'media.toggle': case 'media.prev': case 'media.next': case 'media.mute': case 'media.focus': {
        const m = vm?.media;
        if (!m) return false;
        if (name === 'media.focus' && m.tabId != null) return send('activateTab', { tabId: m.tabId, windowId: windowId() ?? undefined });
        if (name === 'media.mute' && m.tabId != null) return send('muteTab', { tabId: m.tabId, windowId: windowId() ?? undefined });
        return send(type, { ...payload, tabId: m.tabId, source: m.source });
      }
      case 'folder.toggle':
        lastToggle = { folderId: arg, wasOpen: !payload.open, at: Date.now() };
        break;
      default: break;
    }
    // Rows closed: gone at once (ui/intents.ts), the row in front next worked out from what's drawn before.
    const closing = name === 'tab.close' ? [arg] : name === 'today.clear' ? (vm?.space.today ?? []).map((t) => t.id) : [];
    const before = closing.length ? viewState(host.getState()) : null;
    const request = send(type, payload);
    for (const id of closing) intents.close(id, before, windowId(), request);
    if (name === 'tab.move') return request;
    render();
    // (⌘D's toast waits for the answer: the new pin's id, or null, ui/shortcut-targets.ts togglePin.)
    if (name === 'tab.pin' || name === 'tab.unpin') return request;
    return true;
  }

  let lastToggle: { folderId: string, wasOpen: boolean, at: number } | null = null;

  // What a new tab being opened is drawn as: the search's words, or the address
  // (the tab in front now, `from`: it's drawn until another is).
  function openingFor(payload: any) {
    return { title: typeof payload?.query === 'string' ? payload.query.trim() : '', url: typeof payload?.url === 'string' ? payload.url : '', from: frontTab() };
  }

  let newTabTimer: Timer | null = null;
  function holdNewTab() {
    clearTimeout(newTabTimer);
    const done = () => { clearTimeout(newTabTimer); doc.removeEventListener('visibilitychange', onHidden); if (ui.newTabPending) setUi({ newTabPending: false }); };
    const onHidden = () => { if (doc.hidden) done(); };
    doc.addEventListener('visibilitychange', onHidden);
    newTabTimer = setTimeout(done, NEW_TAB_HOLD_MS);
  }

  function local(name: string, arg: any, info: any): unknown {
    switch (name) {
      case 'palette.open':
        setUi({
          palette: { open: true, query: typeof arg?.query === 'string' ? arg.query : '', selected: 0, newTab: !!arg?.newTab, selectAll: !!arg?.selectAll },
          menu: null, newTabPending: false,
        });
        return true;
      case 'palette.close':
        if (!ui.palette.open) return true;
        setUi({ palette: CLOSED_PALETTE });
        behaviors.palette?.closed(false);
        onPalette?.('close');
        return true;
      case 'tab.copyUrl': {
        const state = host.getState();
        const targetId = arg !== undefined && arg !== null && arg !== '' ? arg : frontTab();
        const item = typeof targetId === 'string' ? state?.keptTabs?.[targetId] : targetId != null ? state?.tabs?.[targetId] : null;
        const url = item?.url ?? '';
        if (!/^https?:\/\//i.test(url)) return false;
        return copyText(url, arg == null || arg === '' ? 'Copied Current URL' : 'Copied URL');
      }
      case 'pin.copyUrl': {
        const pin = host.getState()?.pins?.find((p: { id: string }) => p.id === arg);
        const url = pin?.url ?? '';
        if (!/^https?:\/\//i.test(url)) return false;
        return copyText(url, 'Copied URL');
      }
      case 'favorite.copyUrl': {
        const fav = host.getState()?.favorites?.find((f: { id: string }) => f.id === arg);
        const url = fav?.url ?? '';
        if (!/^https?:\/\//i.test(url)) return false;
        return copyText(url, 'Copied URL');
      }
      // The preview card and Quick Tab (behaviors/card.ts).
      case 'preview.close': return behaviors.card.close();
      case 'preview.expand': return behaviors.card.expand();
      case 'quickTab.open': return behaviors.card.openLittleArc();
      case 'preview.copyUrl': {
        const url = ui.peek?.url ?? '';
        if (!/^https?:\/\//i.test(url)) return false;
        return copyText(url, 'Copied URL');
      }
      case 'preview.setSpace':
        if (!ui.peek) return false;
        setUi({ peek: { ...ui.peek, spaceId: arg } });
        host.perform?.('peek.setSpace', { spaceId: arg });
        return true;
      case 'preview.back':
        return !!ui.peek && !ui.peek.littleArc && !!host.perform?.('peek.back', {});
      case 'preview.forward':
        return !!ui.peek && !ui.peek.littleArc && !!host.perform?.('peek.forward', {});
      case 'space.edit': return behaviors.editor.open(arg);
      case 'space.editBackground': return behaviors.backgroundPicker.open(arg, info);
      case 'picker.run': return behaviors.backgroundPicker.run(arg, info);
      case 'space.rename': return behaviors.rename.start('space', arg);
      case 'folder.rename': return behaviors.rename.start('folder', arg);
      case 'tab.rename': return behaviors.rename.start('tab', arg);
      case 'pin.rename': return behaviors.rename.start('pin', arg);
      case 'favorite.rename': return behaviors.rename.start('favorite', arg);
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
      case 'editor.theme': return behaviors.editor.theme(arg);
      // Margin's notices and prompts: a button is the host's to run (what
      // it does stays in Margin, as a menu item's), then it goes.
      case 'notice.run': case 'prompt.run': {
        const which = name === 'notice.run' ? 'notice' : 'prompt';
        // (A notice the view model made, the app's switch's, isn't the UI's own: its id is the model's.)
        const id = ui[which]?.id ?? vm?.[which]?.id;
        setUi({ [which]: null });
        host.perform?.(which, { id, action: arg });
        return true;
      }
      case 'notice.close': setUi({ notice: null }); return true;
      case 'prompt.close': setUi({ prompt: null }); return true;
      case 'launcher.more': setUi({ launcher: { ...ui.launcher, allArchived: !ui.launcher?.allArchived } }); return true;
      case 'settings.toggle': setUi({ settingsOpen: !ui.settingsOpen, recording: null }); return true;
      case 'settings.run': return behaviors.settings.run(arg);
      case 'settings.category': setUi({ settingsCategory: arg, recording: null }); return true;
      // The palette's own rows (shared/search.ts `local` actions). "Toggle
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
   * */
  function runQuery(query: string) {
    const text = String(query ?? '').trim();
    if (!text) return false;
    const state = host.getState();
    const items = paletteItems(viewState(state), { ...fullUi(), palette: { open: true, query: text, selected: 0 } }, host.platform);
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
  function themeClick(name: string, arg: unknown, info: { element: Element; event: Event; }) {
    const event = info?.event;
    if (behaviors.rename?.editingContains(event?.target)) return;
    if ((event as MouseEvent)?.ctrlKey && ROW_ACTIONS.has(name)) return;
    if (behaviors.drag?.justDropped()) return;
    if (behaviors.press?.consumes(name, arg, event)) return;
    if (name === 'folder.toggle' && (event as MouseEvent)?.detail > 1) return;
    dispatch(name, arg, 'theme', info);
  }

  // ---- the behaviors ------------------------------------------------------------

  // Margin's own pixels per pixel of the page: the page's zoom (⌘+ / ⌘−)
  // scales the page, and the in-page host scales Margin back
  // (shared/dom.ts setPageZoom), so pointer positions and element boxes come
  // in the page's (zoomed) pixels while lengths written in CSS are Margin's.
  // 1 where nothing is zoomed (the app, tests).
  const scale = () => {
    const root = (view.rootElement() as HTMLElement | null);
    const width = root?.getBoundingClientRect().width;
    return width && root.offsetWidth ? root.offsetWidth / width : 1;
  };

  // (`behaviors`: set just below, before the behaviors are installed.)
  const rt = {
    host, theme, themeInfo, view, doc, win, container, scale,
    get vm() { return vm; },
    get ui() { return ui; },
    get state() { return host.getState(); },
    viewState: () => viewState(host.getState()),
    setUi, render, dispatch, send, refuse, warn, runQuery, showToast,
    windowId, ownTab, frontTab, recentTabOf, switchSpace,
    /** Space `spaceId` kept shown for `ms`, whatever the state says meanwhile (a swipe's slide coming in). */
    holdSpace(spaceId: string, ms: number) {
      pending.hold = typeof spaceId === 'string' ? { spaceId, until: Date.now() + Math.max(0, ms) } : null;
      expireLater();
    },
    switching,
    get lastToggle() { return lastToggle; },
    /** Shown ahead of the state: the theme's settings (a width being dragged, `live`, or just saved). */
    setThemeSettings(values, { live = false } = {}) {
      pending.themeSettings = values ? { values, live, until: Date.now() + PENDING_MS } : null;
      render();
    },
    /** Anything under way that a sidebar out over the page waits for (sidebar.js isBusy). */
    busy: (except: unknown = null) => list.some((b) => b !== except && b.busy?.()),
    /** A listener, removed with the runtime. */
    listen(target: EventTarget, type: string, fn: (e: any) => void, options?: boolean | AddEventListenerOptions) {
      target.addEventListener(type, fn, options);
      offs.push(() => target.removeEventListener(type, fn, options));
    },
    later(fn: () => void, ms: number) {
      const id = setTimeout(() => { timers.delete(id); if (!destroyed) fn(); }, ms);
      timers.add(id);
      return id;
    },
    cancel(id: ReturnType<typeof setTimeout> | null | undefined) { clearTimeout(id); timers.delete(id); },
    get destroyed() { return destroyed; },
    previewBackground(spaceId: string, value: SpaceBackground | null, { held }: { held: boolean }) {
      backgroundAhead = { spaceId, value, until: held ? null : Date.now() + PENDING_MS };
      followBackground();
      if (!held) expireLater();
    },
    panelChanged() { onPanel?.(); },
    /** The model with space `id` shown in this window (one of vm.spaces), for a swipe drawing it beside the current
     *  one; null if it isn't one. */
    spaceView(id: string) {
      const entry = vm?.spaces?.find((s) => s.id === id);
      if (!entry) return null;
      let state = viewState(host.getState());
      if (!state) return null;
      const w = fullUi().windowId;
      state = { ...state, activeSpaceByWindow: { ...state.activeSpaceByWindow, [w as number]: id } };
      const out = buildViewModel({ state, ui: { ...fullUi(), palette: {}, editing: null, notice: null, prompt: null, gesture: null }, platform: host.platform, settings });
      return out.space?.id === id ? out : null;
    },
  } satisfies Omit<Rt, 'behaviors'> as Rt;
  const behaviors: Record<string, any> = {};
  rt.behaviors = behaviors;
  Object.assign(behaviors, {
    press: installPress(rt),
    palette: installPalette(rt),
    peek: installPeek(rt),
    card: installCard(rt),
    resize: installResize(rt),
    split: installSplit(rt),
    menus: installMenus(rt),
    rename: installRename(rt),
    editor: installEditor(rt),
    drag: installDrag(rt),
    scroll: installScroll(rt),
    swipe: installSwipe(rt),
    settings: installSettings(rt),
    backgroundPicker: installBackgroundPicker(rt, { materials }),
  });
  const list = Object.values(behaviors);

  // Keystrokes in Margin's UI stay away from the page's own shortcuts.
  const stopKeys = (e: Event) => { if (view.owns(e.target)) e.stopPropagation(); };
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
    /** Where `<m-page>` is now (ui/render.ts View.measure). */
    measure: () => view.measure(),
    /**
     * The pointer over the page, from a host whose page gets its events (the
     * in-page host: the document's mousemove; the app: its window's), in the
     * container's coordinates: a hidden sidebar's reveal edge (m-peek).
     * */
    pointer: (point: { x: number, y: number }) => behaviors.peek.pagePointer(point),
    /** The pointer left the window (`x`, `y`: where it was last). */
    pointerLeft: (point: { x: number; y: number; }) => behaviors.peek.pageLeft(point),
    /**
     * The sidebar out over the page by the host's word: `hover` (as the
     * pointer at the edge does), `toggle` (the show/hide key: it stays until
     * toggled again, Escape or a click on the page), `flash` (a moment, after
     * a space switch by key); `hide()` takes it back, `toggle()` is the key.
     */
    sidebar: {
      show: (why: 'hover' | 'toggle' | 'flash') => behaviors.peek.showFor(why),
      hide: () => behaviors.peek.hide(),
      toggle: () => behaviors.peek.toggle(),
      flash: (ms: number) => behaviors.peek.flash(ms),
      /** How it's out now: 'hover' | 'toggle' | 'flash' | null. */
      reason: () => behaviors.peek.reason(),
      /** Out over the page (not docked). */
      out: () => vm?.window.sidebar === 'peek',
    },
    /**
     * A switch the copy makes in this window (a next/previous key: its
     * 'switching' push), highlighted as one asked for here is; `request`
     * settles with its 'switch-done' or 'switch-failed' (shared/switching.ts
     * backgroundSwitches). A switch to the tab in front ends any under way,
     * or goes on with a chain on screen (shared/switching.ts toFront).
     * */
    switchTo(tabId: number | string, request: Promise<any>) {
      if (!(Number.isInteger(tabId) || typeof tabId === 'string')) return;
      if (tabId === frontTab()) switching.toFront(tabId, request);
      else switching.start(tabId, request);
    },
    /** The palette, opened by the host (its key, ⌘T's hand-off, ⌘L address): `newTab`, to choose a new tab. */
    openPalette: ({ newTab = false, query = '', selectAll = false }: { newTab?: boolean, query?: string, selectAll?: boolean } = {}) => local('palette.open', { newTab, query, selectAll }, null),
    closePalette: () => { if (ui.palette.open) local('palette.close', undefined, null); },
    get paletteOpen() { return !!ui.palette.open; },
    showToast,
    /** The preview card (behaviors/card.ts): the app's word on it (null: gone), Quick Tab opened by the app's key. */
    card: {
      show: (peek: unknown) => behaviors.card.show(peek),
      openLittleArc: () => behaviors.card.openLittleArc(),
      get open() { return !!ui.peek && !ui.peek.closing; },
    },
    /** Where the theme's `<m-preview-page>` is now (ui/render.ts View.measurePeekPage): null when no card is drawn. */
    measurePeekPage: () => view.measurePeekPage(),
    /**
     * The space's background at a point of the window, as `rgb(r, g, b)` (ui/background.ts colorAt): what Margin.app
     * is told is around the page's corners (host-app.ts cornerFill's `ground`). Null while the theme's own ground shows.
     */
    backgroundAt: (x: number, y: number) => background.colorAt(x, y),
    /** What the background layer has drawn (ui/background.ts drawn), for the tests. */
    backgroundDrawn: () => background.drawn(),
    /** Edit Theme Color open (Margin's own panel: it takes the keys while it is), and where: [x, y, width, height] in the window's pixels (null: closed). */
    get panelOpen() { return !!behaviors.backgroundPicker?.openFor; },
    panelRect: (): number[] | null => behaviors.backgroundPicker?.rect() ?? null,
    /** The picker's parts, for the tests (its content is closed to them). */
    pickerParts: () => behaviors.backgroundPicker?.parts() ?? null,
    /** The new-tab launcher's field focused, by the host's word (its overlay shown over a new window: behaviors/palette.js). */
    focusLauncher: () => !!behaviors.palette?.focusLauncher(),
    /** The tab list's scroll: saved now (before a switch), or set (a page prepared for a show). */
    flushScroll: () => behaviors.scroll?.flush(),
    restoreScroll: () => behaviors.scroll?.restore(),
    setScroll: (px: number) => behaviors.scroll?.set(px),
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
      intents.clear();
      motion.destroy();
      clearTimeout(expiryTimer);
      clearTimeout(newTabTimer);
      clearTimeout(toastTimer);
      defaultToast?.remove();
      defaultToast = null;
      for (const id of timers) clearTimeout(id);
      for (const fn of offs.splice(0)) fn();
      view.destroy();
      background.destroy();
    },
  };
}
