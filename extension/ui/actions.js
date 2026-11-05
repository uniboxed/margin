// The whole list of actions a theme can trigger (PLAN.md §3, "Actions"), and
// the checks every one goes through before Margin runs it. A theme names an
// action with `m-action` on a button or link; its argument comes from
// `m-arg` (a `{{path}}` into the view model or a literal). Nothing here runs
// an action: the host does, once `dispatch` has checked it against the state.
// An unknown action or a bad argument is ignored and logged.

// What each action's argument must be:
//   none   — no argument (anything given is refused);
//   tab    — the id of an open tab;     space — the id of an existing space;
//   folder — an existing folder's id;   pin — an existing pin's id;
//   archive — an archived entry's id;   row — a row of the open palette;
//   optional-space — nothing, or an existing space;
//   tab-space — { tab, space }: only behaviors (a drop, a menu) make one,
//     never `m-arg`, which carries one value.
// `tab.unpin` takes the pin's id: a pinned tab is drawn as its pin's row
// (shared/view.js sidebar), whose id is the pin's, and a pin not open has
// no tab at all (the background's `unpin` takes a pin id too).
export const ACTIONS = Object.freeze({
  'tab.activate': 'tab',
  'tab.close': 'tab',
  'tab.new': 'optional-space',
  'tab.pin': 'tab',
  'tab.unpin': 'pin',
  'tab.moveToSpace': 'tab-space',
  'pin.open': 'pin',
  'folder.toggle': 'folder',
  'folder.new': 'none',
  'space.switch': 'space',
  'space.new': 'none',
  'space.edit': 'space',
  'today.clear': 'none',
  'nav.back': 'none',
  'nav.forward': 'none',
  'nav.reload': 'none',
  'palette.open': 'none',
  'palette.close': 'none',
  'palette.run': 'row',
  'sidebar.toggle': 'none',
  'archive.open': 'none',
  'archive.restore': 'archive',
  'window.close': 'none',
  'window.minimise': 'none',
  'window.fullscreen': 'none',
  'settings.open': 'none',
});

export const ACTION_NAMES = Object.freeze(Object.keys(ACTIONS));

export const isAction = (name) => typeof name === 'string' && Object.hasOwn(ACTIONS, name);

// An id as the state holds it: a tab id is a safe integer (the browser's),
// other ids are short strings of letters, digits, '-', '_' and ':'.
const ID_TEXT = /^[A-Za-z0-9_:-]{1,64}$/;
const isId = (value) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  || (typeof value === 'string' && ID_TEXT.test(value));

/**
 * What `checkAction` asks of the state. Every function answers for an id the
 * state holds right now.
 * @typedef {{
 *   hasTab(id: any): boolean, hasSpace(id: any): boolean, hasFolder(id: any): boolean,
 *   hasPin(id: any): boolean, hasArchived(id: any): boolean, hasPaletteRow(id: any): boolean,
 * }} ActionContext
 */

/**
 * Checks one action and its argument against the state.
 * @param {string} name
 * @param {any} arg
 * @param {ActionContext} ctx
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkAction(name, arg, ctx) {
  if (!isAction(name)) return { ok: false, reason: `unknown action ${JSON.stringify(String(name)).slice(0, 80)}` };
  const kind = ACTIONS[name];
  const has = {
    tab: ctx.hasTab, space: ctx.hasSpace, folder: ctx.hasFolder, pin: ctx.hasPin, archive: ctx.hasArchived, row: ctx.hasPaletteRow,
  };
  const none = arg === undefined || arg === null || arg === '';
  switch (kind) {
    case 'none':
      return none ? { ok: true } : { ok: false, reason: `${name} takes no argument` };
    case 'optional-space':
      if (none) return { ok: true };
      return isId(arg) && ctx.hasSpace(arg) ? { ok: true } : { ok: false, reason: `${name}: not a space` };
    case 'tab-space':
      if (!arg || typeof arg !== 'object' || Array.isArray(arg) || Object.getPrototypeOf(arg) !== Object.prototype) return { ok: false, reason: `${name}: needs { tab, space }` };
      if (Object.keys(arg).sort().join() !== 'space,tab') return { ok: false, reason: `${name}: needs { tab, space }` };
      return isId(arg.tab) && ctx.hasTab(arg.tab) && isId(arg.space) && ctx.hasSpace(arg.space) ? { ok: true } : { ok: false, reason: `${name}: no such tab or space` };
    default:
      if (!isId(arg)) return { ok: false, reason: `${name}: bad ${kind} id` };
      return has[kind](arg) ? { ok: true } : { ok: false, reason: `${name}: no ${kind} ${JSON.stringify(arg)}` };
  }
}

/**
 * Margin's side of a theme's clicks: checks each one, then hands the good
 * ones to `run`. `log` hears about every refused one.
 * @param {{ context: () => ActionContext, run: (name: string, arg: any) => void, log?: (entry: { name: string, arg: any, reason: string }) => void }} options
 */
export function createDispatcher({ context, run, log = () => {} }) {
  return function dispatch(name, arg) {
    const verdict = checkAction(name, arg, context());
    if (!verdict.ok) {
      log({ name: String(name), arg, reason: /** @type {any} */ (verdict).reason });
      return false;
    }
    run(name, arg);
    return true;
  };
}

/**
 * The checks' view of Margin's state (the host's, as pages read it): every
 * open tab in any window, every space, folder, pin and archived entry, and
 * the rows of the palette while it's open (`paletteIds`, from
 * ui/view-model.js paletteItems).
 * @param {any} state @param {Iterable<string>} [paletteIds]
 * @returns {ActionContext}
 */
export function contextFromState(state, paletteIds = []) {
  const tabs = state?.tabs && typeof state.tabs === 'object' ? state.tabs : {};
  const ids = (list) => new Set((Array.isArray(list) ? list : []).map((x) => x?.id));
  const spaces = ids(state?.spaces);
  const folders = ids(state?.folders);
  const pins = ids(state?.pins);
  const archived = ids(state?.archive);
  const rows = new Set(paletteIds);
  return {
    hasTab: (id) => Number.isInteger(id) && Object.prototype.hasOwnProperty.call(tabs, id) && tabs[id]?.id === id,
    hasSpace: (id) => spaces.has(id),
    hasFolder: (id) => folders.has(id),
    hasPin: (id) => pins.has(id),
    hasArchived: (id) => archived.has(id),
    hasPaletteRow: (id) => rows.has(id),
  };
}

// ---------------------------------------------------------------------------
// From a theme's action to what Margin does (PLAN.md §3 "Actions"): a
// request to the background's handler of that name (background/handlers.js,
// as Arcadia's sidebar and palette send them today), something the UI does
// itself (`local`: the palette, the space editor), something only the host
// can do (`host`: the page's own history in pages, the window's buttons in
// the app), or nothing yet (`none`: no handler exists).
//
// | Action             | Argument     | Goes to                       | Payload                                 |
// |--------------------|--------------|-------------------------------|-----------------------------------------|
// | tab.activate       | tab id       | activateTab                   | { tabId, show? }                        |
// | tab.close          | tab id       | closeTab (archives it)        | { tabId, show? }                        |
// | tab.new            | none         | local: the palette, new tab   | (Arcadia's "+ New Tab")                 |
// | tab.new            | space id     | newTab                        | { windowId, spaceId }                   |
// | tab.pin            | tab id       | pinTab                        | { tabId }                               |
// | tab.unpin          | pin id       | unpin                         | { pinId }                               |
// | tab.moveToSpace    | {tab, space} | moveTabToSpace                | { tabId, spaceId }                      |
// | pin.open           | pin id       | openPin                       | { pinId, windowId, show? }              |
// | folder.toggle      | folder id    | setFolderOpen                 | { folderId, open: !folder.open }        |
// | folder.new         | none         | createFolder                  | { windowId }                            |
// | space.switch       | space id     | setSpace                      | { windowId, spaceId, show? }            |
// | space.new          | none         | createSpace, then local edit  | { windowId }                            |
// | space.edit         | space id     | local: the space editor       | (it sends renameSpace, deleteSpace)     |
// | today.clear        | none         | none: no handler yet          |                                         |
// | nav.back, .forward, .reload | none| host                          | (in pages: the page's own history)      |
// | palette.open, .close | none       | local                         |                                         |
// | palette.run        | row id       | the row's own request         | shared/search.js rankPalette's action:  |
// |                    |              |                               | activateTab, openPin, restoreArchive,   |
// |                    |              |                               | setSpace, newTab, search, pinTab,       |
// |                    |              |                               | newWindow, openLauncher,                |
// |                    |              |                               | toggleFullscreen; or local:             |
// |                    |              |                               | toggleSidebar, navigate, search         |
// | sidebar.toggle     | none         | updateSettings                | { patch: { sidebarPinnedOpen: !now } }  |
// | archive.open       | none         | openLauncher                  | { windowId }                            |
// | archive.restore    | archive id   | restoreArchive                | { archiveId, windowId }                 |
// | window.close       | none         | host (the app's window)       |                                         |
// | window.minimise    | none         | host (the app's window)       |                                         |
// | window.fullscreen  | none         | toggleFullscreen where the    | { windowId }; else host                 |
// |                    |              | browser has Margin full screen|                                         |
// | settings.open      | none         | openLauncher                  | { windowId }                            |
//
// `show`: while the sidebar is open over the page (peek), a switch keeps it
// open on the page that comes to the front (Arcadia's openOverPage, the
// background's carryOpen).

/** @typedef {{ kind: 'send', type: string, payload: Record<string, any> } | { kind: 'local', name: string, arg?: any } | { kind: 'host', name: string } | { kind: 'none', reason: string }} ActionRequest */

/** Each action's way out, as the table above says. */
export const ACTION_MAP = Object.freeze({
  'tab.activate': 'activateTab',
  'tab.close': 'closeTab',
  'tab.new': 'newTab | local',
  'tab.pin': 'pinTab',
  'tab.unpin': 'unpin',
  'tab.moveToSpace': 'moveTabToSpace',
  'pin.open': 'openPin',
  'folder.toggle': 'setFolderOpen',
  'folder.new': 'createFolder',
  'space.switch': 'setSpace',
  'space.new': 'createSpace',
  'space.edit': 'local',
  'today.clear': 'none',
  'nav.back': 'host',
  'nav.forward': 'host',
  'nav.reload': 'host',
  'palette.open': 'local',
  'palette.close': 'local',
  'palette.run': 'row',
  'sidebar.toggle': 'updateSettings',
  'archive.open': 'openLauncher',
  'archive.restore': 'restoreArchive',
  'window.close': 'host',
  'window.minimise': 'host',
  'window.fullscreen': 'toggleFullscreen | host',
  'settings.open': 'openLauncher',
});

/**
 * What a checked action becomes (`checkAction` first: this trusts its
 * argument). `state`: the host's state; `ui`: the UI's own (its window, the
 * sidebar); `platform`: the host's (whether the browser has Margin full
 * screen); `row`: for palette.run, the palette item its row id names
 * (ui/view-model.js paletteItems), with its `action`.
 * @param {string} name @param {any} arg
 * @param {{ state: any, ui: { windowId?: number | null, sidebar?: string | null }, platform?: { marginFullscreen?: boolean }, row?: any }} ctx
 * @returns {ActionRequest}
 */
export function requestFor(name, arg, { state, ui, platform, row }) {
  const windowId = ui.windowId ?? undefined;
  const show = ui.sidebar === 'peek' ? { show: true } : {};
  /** @returns {ActionRequest} */
  const send = (type, payload) => ({ kind: 'send', type, payload });
  switch (name) {
    case 'tab.activate': return send('activateTab', { tabId: arg, ...show });
    case 'tab.close': return send('closeTab', { tabId: arg, ...show });
    case 'tab.new':
      return arg == null || arg === '' ? { kind: 'local', name: 'palette.open', arg: { newTab: true } } : send('newTab', { windowId, spaceId: arg });
    case 'tab.pin': return send('pinTab', { tabId: arg });
    case 'tab.unpin': return send('unpin', { pinId: arg });
    case 'tab.moveToSpace': return send('moveTabToSpace', { tabId: arg.tab, spaceId: arg.space });
    case 'pin.open': return send('openPin', { pinId: arg, windowId, ...show });
    case 'folder.toggle': {
      const folder = (state?.folders ?? []).find((f) => f.id === arg);
      return send('setFolderOpen', { folderId: arg, open: folder?.open === false });
    }
    case 'folder.new': return send('createFolder', { windowId });
    case 'space.switch': return send('setSpace', { windowId, spaceId: arg, ...show });
    case 'space.new': return send('createSpace', { windowId });
    case 'space.edit': return { kind: 'local', name, arg };
    case 'today.clear': return { kind: 'none', reason: 'today.clear: no handler yet (background/handlers.js has none that clears a space\'s tabs)' };
    case 'nav.back': case 'nav.forward': case 'nav.reload':
    case 'window.close': case 'window.minimise':
      return { kind: 'host', name };
    case 'window.fullscreen':
      return platform?.marginFullscreen ? send('toggleFullscreen', { windowId }) : { kind: 'host', name };
    case 'palette.open': case 'palette.close': return { kind: 'local', name };
    case 'palette.run': {
      const action = row?.action;
      if (!action) return { kind: 'none', reason: 'palette.run: no such row' };
      if (action.local) return { kind: 'local', name: `palette.${action.local}`, arg: action };
      const { type, ...payload } = action;
      return send(type, type === 'activateTab' || type === 'openPin' || type === 'setSpace' ? { ...payload, ...show } : payload);
    }
    case 'sidebar.toggle': return send('updateSettings', { patch: { sidebarPinnedOpen: !state?.settings?.sidebarPinnedOpen } });
    case 'archive.open': case 'settings.open': return send('openLauncher', { windowId });
    case 'archive.restore': return send('restoreArchive', { archiveId: arg, windowId });
    default: return { kind: 'none', reason: `${name}: no mapping` };
  }
}
