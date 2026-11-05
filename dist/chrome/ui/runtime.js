// The UI runtime (PLAN.md §2): Margin's own code around a theme. It mounts a
// loaded theme (ui/theme-loader.js) into a shadow root or a document, keeps
// the UI's own state (the sidebar, the palette, menus), rebuilds the view
// model (ui/view-model.js) from its host's state and that, renders it
// (ui/render.js), reports where `<m-page>` sits to the host after every
// layout change, and turns the theme's clicks into checked requests
// (ui/actions.js) sent through the host (ui/host.js). Nothing here touches a
// browser API: the host does.
//
// Not yet: the behaviors (drag and drop, resize, peek, rename, menus, the
// palette's keys and focus: Phase 1 step 2).
/** @import { Host } from './host.js' */
/** @import { LoadedTheme } from './theme-loader.js' */
/** @import { UiState, ViewModel } from './view-model.js' */
import { View } from './render.js';
import { buildViewModel, paletteItems } from './view-model.js';
import { checkAction, contextFromState, requestFor } from './actions.js';
import { resolveSettings } from './theme-loader.js';

const CLOSED_PALETTE = Object.freeze({ open: false, query: '', selected: 0, newTab: false });

/**
 * @param {{
 *   host: Host,
 *   theme: LoadedTheme,
 *   container: ShadowRoot | Document,
 *   ui?: Partial<UiState>,
 *   onWarn?: (message: string) => void,
 *   log?: (entry: { name: string, arg: any, reason: string }) => void,
 * }} options `ui`: the UI state to start from; `log`: every action refused
 */
export function createRuntime({ host, theme, container, ui: start = {}, onWarn, log }) {
  /** @type {UiState} */
  let ui = { sidebar: null, palette: CLOSED_PALETTE, menu: null, editing: null, notice: null, focused: true, switchingTo: null, justShown: false, ...start };
  /** @type {ViewModel | null} */
  let vm = null;
  /** @type {ViewModel | null} */
  let drawn = null;
  let saved; // the theme's saved settings last applied
  let settings = resolveSettings(theme.manifest, null);
  /** @type {{ name: string, arg: any, reason: string }[]} */
  const refused = [];
  const warn = onWarn ?? ((message) => console.warn('[margin]', message));

  // The UI state with what the host knows (its window, tab and mode).
  const fullUi = () => ({ ...ui, windowId: host.windowId ?? null, tabId: host.tabId ?? null, mode: host.mode ?? 'inpage', inNewTab: !!host.inNewTab });

  const view = new View(container, theme.template, {
    sheets: [theme.sheet, theme.settingsSheet].filter(Boolean),
    onAction: (name, arg) => { dispatch(name, arg); },
    onInput: (name, value) => {
      if (name === 'palette' && ui.palette.open) setUi({ palette: { ...ui.palette, query: value, selected: 0 } });
    },
    onLayout: (geometry) => host.reportLayout({ ...geometry, windowId: host.windowId ?? null, mode: host.mode ?? 'inpage' }),
    onWarn: (message) => warn(message),
  });

  function render() {
    const state = host.getState();
    const own = state?.settings?.themes?.[theme.id];
    if (own !== saved) {
      saved = own;
      settings = resolveSettings(theme.manifest, own);
      theme.setSettings?.(own);
    }
    vm = buildViewModel({ state, ui: fullUi(), platform: host.platform, settings }, vm);
    // Nothing changed (the same model): nothing to do.
    if (vm !== drawn) {
      drawn = vm;
      view.update(vm);
    }
    return vm;
  }

  /** @param {Partial<UiState>} patch */
  function setUi(patch) {
    ui = { ...ui, ...patch };
    render();
  }

  /** @param {string} name @param {any} arg @param {string} reason */
  function refuse(name, arg, reason) {
    const entry = { name: String(name), arg, reason };
    refused.push(entry);
    if (refused.length > 100) refused.shift();
    log?.(entry);
    return false;
  }

  /**
   * Runs one action: checked against the host's state (the tab must be open,
   * the space must exist, the palette row must be on screen), then sent,
   * done here, or handed to the host. False if refused.
   * @param {string} name @param {any} [arg]
   */
  function dispatch(name, arg) {
    const state = host.getState();
    const now = fullUi();
    const items = ui.palette.open ? paletteItems(state, now, host.platform) : [];
    const verdict = checkAction(name, arg, contextFromState(state, items.map((i) => i.id)));
    if (!verdict.ok) return refuse(name, arg, /** @type {any} */ (verdict).reason);
    const request = requestFor(name, arg, { state, ui: { windowId: now.windowId, sidebar: vm?.window.sidebar ?? null }, platform: host.platform, row: name === 'palette.run' ? items.find((i) => i.id === arg) : null });
    // Choosing a row closes the palette first (Arcadia's palette).
    if (name === 'palette.run') setUi({ palette: CLOSED_PALETTE });
    switch (request.kind) {
      case 'send': {
        const reply = host.send(request.type, request.payload);
        // A new space opens in the editor once it's there (Arcadia).
        if (name === 'space.new') void Promise.resolve(reply).then((res) => { if (typeof res?.spaceId === 'string') setUi({ editing: { kind: 'space', id: res.spaceId } }); });
        return true;
      }
      case 'local': return local(request.name, request.arg);
      case 'host': return host.perform?.(request.name) ? true : refuse(name, arg, `${request.name}: this host can't`);
      default: return refuse(name, arg, /** @type {any} */ (request).reason);
    }
  }

  /** @param {string} name @param {any} arg */
  function local(name, arg) {
    switch (name) {
      case 'palette.open':
        setUi({ palette: { open: true, query: '', selected: 0, newTab: !!arg?.newTab } });
        return true;
      case 'palette.close':
        setUi({ palette: CLOSED_PALETTE });
        return true;
      case 'space.edit':
        setUi({ editing: { kind: 'space', id: arg } });
        return true;
      // The palette's own rows (shared/search.js `local` actions).
      case 'palette.toggleSidebar': {
        const now = vm?.window.sidebar ?? 'hidden';
        setUi({ sidebar: now === 'hidden' ? 'peek' : 'hidden' });
        return true;
      }
      case 'palette.navigate':
        if (host.perform?.('navigate', { url: arg.url })) return true;
        void host.send('newTab', { windowId: host.windowId ?? undefined, url: arg.url });
        return true;
      case 'palette.search':
        void host.send('search', { query: arg.query, ...(host.tabId != null ? { tabId: host.tabId } : { windowId: host.windowId ?? undefined }) });
        return true;
      default:
        return refuse(name, arg, `${name}: not something the UI does`);
    }
  }

  const off = host.onState(() => render());
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
    destroy() {
      off();
      view.destroy();
    },
  };
}
