// The whole list of actions a theme can trigger (PLAN.md §3, "Actions"), and
// the checks every one goes through before Margin runs it. A theme names an
// action with `m-action` on a button or link; its argument comes from
// `m-arg` (a `{{path}}` into the view model or a literal). Margin's own
// behaviors (ui/behaviors/: a drop, a rename, a menu's item) run actions
// too, some of which only they may run (BEHAVIOR_ONLY). Nothing here runs an
// action: the runtime does, once it's checked against the state. An unknown
// action or a bad argument is ignored and logged.

// What each action's argument must be:
//   none   — no argument (anything given is refused);
//   tab    — the id of an open tab, or of a Margin tab that isn't open (a
//            string: state/model.js keptTabs; activating it opens it);
//   space — the id of an existing space;
//   folder — an existing folder's id;   pin — an existing pin's id;
//   archive — an archived entry's id;   row — a row of the open palette;
//   item   — an item of the open menu;  color — a swatch of the space editor;
//   notice-item, prompt-item — a button of the notice or prompt shown;
//   optional-space — nothing, or an existing space;
//   menu   — a menu a button opens (MENUS);
//   { field: kind, … } — an object with exactly those fields. Only behaviors
//     and menus make one, never `m-arg`, which carries one value. A field's
//     kind is one of the above, `kind?` (that or null), `pin-or-folder?` (the
//     pin or folder something goes before, or null: the end), `name` (a name
//     as typed: at most 40 characters, no control characters), `emoji` (at
//     most 8), `hex` (#rgb or #rrggbb), or the list of values it may be.
// `tab.unpin` takes the pin's id: a pinned tab is drawn as its pin's row
// (shared/view.js sidebar), whose id is the pin's, and a pin not open has
// no tab at all (the background's `unpin` takes a pin id too).
export const ACTIONS = Object.freeze({
  'tab.activate': 'tab',
  'tab.close': 'tab',
  'tab.new': 'optional-space',
  'tab.pin': 'tab',
  'tab.unpin': 'pin',
  'tab.moveToSpace': Object.freeze({ tab: 'tab', space: 'space' }),
  'tab.move': Object.freeze({ tab: 'tab', nextTo: 'tab', side: Object.freeze(['before', 'after']) }),
  'tab.pinAt': Object.freeze({ tab: 'tab', folder: 'folder?', before: 'pin-or-folder?' }),
  'pin.open': 'pin',
  'pin.move': Object.freeze({ pin: 'pin', folder: 'folder?', before: 'pin-or-folder?' }),
  'folder.toggle': 'folder',
  'folder.new': 'none',
  'folder.newWithTab': 'tab',
  'folder.newWithPin': 'pin',
  'folder.rename': 'folder',
  'folder.setName': Object.freeze({ folder: 'folder', name: 'name' }),
  'folder.move': Object.freeze({ folder: 'folder', before: 'pin-or-folder?' }),
  'folder.delete': 'folder',
  'space.switch': 'space',
  'space.new': 'none',
  'space.edit': 'space',
  'space.rename': 'space',
  'space.setName': Object.freeze({ space: 'space', name: 'name' }),
  'space.update': Object.freeze({ space: 'space', name: 'name', emoji: 'emoji', color: 'hex?' }),
  'space.delete': 'space',
  'today.clear': 'none',
  'nav.back': 'none',
  'nav.forward': 'none',
  'nav.reload': 'none',
  'palette.open': 'none',
  'palette.close': 'none',
  'palette.run': 'row',
  'menu.open': 'menu',
  'menu.run': 'item',
  'menu.close': 'none',
  'editor.save': 'none',
  'editor.cancel': 'none',
  'editor.delete': 'none',
  'editor.color': 'color',
  'sidebar.toggle': 'none',
  'archive.open': 'none',
  'archive.restore': 'archive',
  'window.close': 'none',
  'window.minimise': 'none',
  'window.fullscreen': 'none',
  'settings.open': 'none',
  // Margin's notices and prompts (the `notice` and `prompt` parts): one of
  // the shown one's buttons, or closing it. The new-tab launcher's "Show all".
  'notice.run': 'notice-item',
  'notice.close': 'none',
  'prompt.run': 'prompt-item',
  'prompt.close': 'none',
  'launcher.more': 'none',
  'settings.run': 'setting-item',
});

export const ACTION_NAMES = Object.freeze(Object.keys(ACTIONS));

export const isAction = (name) => typeof name === 'string' && Object.hasOwn(ACTIONS, name);

// Only Margin's behaviors and menus run these: their argument is an object
// no `m-arg` makes, or they shouldn't come from one click on a theme's
// button (deleting a space takes the editor's two presses, or a menu's
// "Really delete?").
export const BEHAVIOR_ONLY = Object.freeze(new Set([
  ...Object.entries(ACTIONS).filter(([, kind]) => typeof kind === 'object').map(([name]) => name),
  'space.delete',
]));

// The menus a button can open (`menu.open`): "add" is New Folder and New Space.
export const MENUS = Object.freeze(['add']);

// An id as the state holds it: a tab id is a safe integer (the browser's),
// other ids are short strings of letters, digits, '-', '_' and ':'.
const ID_TEXT = /^[A-Za-z0-9_:-]{1,64}$/;
const isId = (value) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  || (typeof value === 'string' && ID_TEXT.test(value));

/**
 * What `checkAction` asks of the state. Every function answers for an id the
 * state holds right now; `hasMenuItem` and `hasColor`, for the open menu's
 * items and the space editor's swatches.
 * @typedef {{
 *   hasTab(id: any): boolean, hasSpace(id: any): boolean, hasFolder(id: any): boolean,
 *   hasPin(id: any): boolean, hasArchived(id: any): boolean, hasPaletteRow(id: any): boolean,
 *   hasMenuItem?(id: any): boolean, hasColor?(id: any): boolean,
 *   hasNoticeItem?(id: any): boolean, hasPromptItem?(id: any): boolean,
 *   hasSettingItem?(id: any): boolean,
 * }} ActionContext
 */

export const NAME_MAX = 40;
const EMOJI_MAX = 8;
// eslint-disable-next-line no-control-regex
const plainText = (value, max) => typeof value === 'string' && [...value].length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** One field's value against its kind. @param {string | readonly string[]} kind @param {any} v @param {ActionContext} ctx */
function valueOk(kind, v, ctx) {
  if (Array.isArray(kind)) return kind.includes(v);
  const text = /** @type {string} */ (kind);
  const optional = text.endsWith('?');
  if (optional && v === null) return true;
  switch (optional ? text.slice(0, -1) : text) {
    case 'tab': return isId(v) && ctx.hasTab(v);
    case 'space': return isId(v) && ctx.hasSpace(v);
    case 'folder': return isId(v) && ctx.hasFolder(v);
    case 'pin': return isId(v) && ctx.hasPin(v);
    case 'pin-or-folder': return isId(v) && (ctx.hasPin(v) || ctx.hasFolder(v));
    case 'name': return plainText(v, NAME_MAX);
    case 'emoji': return plainText(v, EMOJI_MAX);
    case 'hex': return typeof v === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
    default: return false;
  }
}

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
  const none = arg === undefined || arg === null || arg === '';
  if (typeof kind === 'object') {
    const fields = Object.keys(kind);
    if (!isPlainObject(arg) || Object.keys(arg).sort().join() !== [...fields].sort().join()) return { ok: false, reason: `${name}: needs { ${fields.join(', ')} }` };
    for (const field of fields) if (!valueOk(kind[field], arg[field], ctx)) return { ok: false, reason: `${name}: bad ${field}` };
    return { ok: true };
  }
  const has = {
    tab: ctx.hasTab, space: ctx.hasSpace, folder: ctx.hasFolder, pin: ctx.hasPin, archive: ctx.hasArchived, row: ctx.hasPaletteRow,
    item: ctx.hasMenuItem ?? (() => false), color: ctx.hasColor ?? (() => false),
    'notice-item': ctx.hasNoticeItem ?? (() => false), 'prompt-item': ctx.hasPromptItem ?? (() => false),
    'setting-item': ctx.hasSettingItem ?? (() => false),
  };
  switch (kind) {
    case 'none':
      return none ? { ok: true } : { ok: false, reason: `${name} takes no argument` };
    case 'optional-space':
      if (none) return { ok: true };
      return isId(arg) && ctx.hasSpace(arg) ? { ok: true } : { ok: false, reason: `${name}: not a space` };
    case 'menu':
      return MENUS.includes(arg) ? { ok: true } : { ok: false, reason: `${name}: no such menu` };
    default:
      if (!isId(arg)) return { ok: false, reason: `${name}: bad ${kind} id` };
      return has[kind](arg) ? { ok: true } : { ok: false, reason: `${name}: no ${kind} ${JSON.stringify(arg)}` };
  }
}

/**
 * Margin's side of a theme's clicks: checks each one, then hands the good
 * ones to `run`. `log` hears about every refused one. A theme's click never
 * runs an action only behaviors may run.
 * @param {{ context: () => ActionContext, run: (name: string, arg: any) => void, log?: (entry: { name: string, arg: any, reason: string }) => void }} options
 */
export function createDispatcher({ context, run, log = () => {} }) {
  return function dispatch(name, arg) {
    const verdict = BEHAVIOR_ONLY.has(name) ? { ok: false, reason: `${name}: only Margin's behaviors and menus run it` } : checkAction(name, arg, context());
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
 * open tab in any window, every space, folder, pin and archived entry, the
 * rows of the palette while it's open (`paletteIds`, from ui/view-model.js
 * paletteItems), and the open menu's items and the editor's swatches.
 * @param {any} state @param {Iterable<string>} [paletteIds]
 * @param {{ menuIds?: Iterable<string>, colorIds?: Iterable<string>, noticeIds?: Iterable<string>, promptIds?: Iterable<string>, settingIds?: Iterable<string> }} [more]
 * @returns {ActionContext}
 */
export function contextFromState(state, paletteIds = [], { menuIds = [], colorIds = [], noticeIds = [], promptIds = [], settingIds = [] } = {}) {
  const tabs = state?.tabs && typeof state.tabs === 'object' ? state.tabs : {};
  const kept = state?.keptTabs && typeof state.keptTabs === 'object' ? state.keptTabs : {};
  const ids = (list) => new Set((Array.isArray(list) ? list : []).map((x) => x?.id));
  const spaces = ids(state?.spaces);
  const folders = ids(state?.folders);
  const pins = ids(state?.pins);
  const archived = ids(state?.archive);
  const rows = new Set(paletteIds);
  const items = new Set(menuIds);
  const colors = new Set(colorIds);
  const notices = new Set(noticeIds);
  const prompts = new Set(promptIds);
  const settingButtons = new Set(settingIds);
  return {
    // An open tab by its browser tab's id, or a Margin tab that isn't open
    // by its own (state/model.js keptTabs).
    hasTab: (id) => (Number.isInteger(id) && Object.prototype.hasOwnProperty.call(tabs, id) && tabs[id]?.id === id)
      || (typeof id === 'string' && Object.prototype.hasOwnProperty.call(kept, id) && kept[id]?.id === id),
    hasSpace: (id) => spaces.has(id),
    hasFolder: (id) => folders.has(id),
    hasPin: (id) => pins.has(id),
    hasArchived: (id) => archived.has(id),
    hasPaletteRow: (id) => rows.has(id),
    hasMenuItem: (id) => items.has(id),
    hasColor: (id) => colors.has(id),
    hasNoticeItem: (id) => notices.has(id),
    hasPromptItem: (id) => prompts.has(id),
    hasSettingItem: (id) => settingButtons.has(id),
  };
}

// ---------------------------------------------------------------------------
// From an action to what Margin does (PLAN.md §3 "Actions"): a request to
// the background's handler of that name (background/handlers.js, as
// Arcadia's sidebar and palette send them today), something the UI does
// itself (`local`: the palette, menus, the space editor, renaming), or
// something the host does (`host`: the page's own history in pages, the
// window's buttons in the app), with the background's handler as the way
// when the host has none (`fallback`).
//
// | Action             | Argument          | Goes to                       | Payload                                 |
// |--------------------|-------------------|-------------------------------|-----------------------------------------|
// | tab.activate       | tab id            | activateTab (one not open:    | { tabId, show? }                        |
// |                    |                   | opened in this window)        |                                         |
// | tab.close          | tab id            | closeTab (archives it)        | { tabId, show? }                        |
// | tab.new            | none              | local: the palette, new tab   | (Arcadia's "+ New Tab")                 |
// | tab.new            | space id          | newTab                        | { windowId, spaceId }                   |
// | tab.pin            | tab id            | pinTab                        | { tabId }                               |
// | tab.unpin          | pin id            | unpin                         | { pinId }                               |
// | tab.moveToSpace    | {tab, space}      | moveTabToSpace                | { tabId, spaceId }                      |
// | tab.move           | {tab, nextTo, side} | moveTab                     | { tabId, nextTo, side, nextToHint? }    |
// | tab.pinAt          | {tab, folder, before} | pinTab                    | { tabId, folderId, beforeId }           |
// | pin.open           | pin id            | openPin                       | { pinId, windowId, show? }              |
// | pin.move           | {pin, folder, before} | movePin                   | { pinId, folderId, beforeId }           |
// | folder.toggle      | folder id         | setFolderOpen                 | { folderId, open: !folder.open }        |
// | folder.new         | none              | createFolder, then rename     | { windowId }                            |
// | folder.newWithTab  | tab id            | createFolder, then rename     | { windowId, tabId }                     |
// | folder.newWithPin  | pin id            | createFolder, then rename     | { windowId, pinIds: [pin] }             |
// | folder.rename      | folder id         | local: its name edited in place |                                       |
// | folder.setName     | {folder, name}    | renameFolder                  | { folderId, name }                      |
// | folder.move        | {folder, before}  | moveFolder                    | { folderId, beforeId }                  |
// | folder.delete      | folder id         | deleteFolder (its pins stay)  | { folderId }                            |
// | space.switch       | space id          | setSpace                      | { windowId, spaceId, show? }            |
// | space.new          | none              | createSpace, then the editor  | { windowId }                            |
// | space.edit         | space id          | local: the space editor       | (it sends space.update, space.delete)   |
// | space.rename       | space id          | local: its name edited in place |                                       |
// | space.setName      | {space, name}     | renameSpace                   | { spaceId, name }                       |
// | space.update       | {space, name, emoji, color} | renameSpace         | { spaceId, name, emoji, color }         |
// | space.delete       | space id          | deleteSpace                   | { spaceId }                             |
// | today.clear        | none              | clearToday                    | { windowId }                            |
// | nav.back, .forward, .reload | none     | host, else goBack, goForward, reload | { windowId }                     |
// | palette.open, .close | none            | local                         |                                         |
// | palette.run        | row id            | the row's own request         | shared/search.js rankPalette's action:  |
// |                    |                   |                               | activateTab, openPin, restoreArchive,   |
// |                    |                   |                               | setSpace, newTab, search, pinTab,       |
// |                    |                   |                               | newWindow, openLauncher,                |
// |                    |                   |                               | toggleFullscreen; or local:             |
// |                    |                   |                               | toggleSidebar, navigate, search         |
// | menu.open          | 'add'             | local: that menu, at the button |                                       |
// | menu.run           | item id           | the item's own action         | (ui/behaviors/menu-items.js)            |
// | menu.close         | none              | local                         |                                         |
// | editor.save, .cancel, .delete, .color | | local: the space editor     | (save: space.update; delete: twice)     |
// | sidebar.toggle     | none              | updateSettings                | { patch: { sidebarPinnedOpen: !now } }  |
// | archive.open       | none              | openLauncher                  | { windowId }                            |
// | archive.restore    | archive id        | restoreArchive                | { archiveId, windowId }                 |
// | window.close       | none              | host (the app's window)       |                                         |
// | window.minimise    | none              | host (the app's window)       |                                         |
// | window.fullscreen  | none              | toggleFullscreen where the    | { windowId }; else host                 |
// |                    |                   | browser has Margin full screen|                                         |
// | settings.open      | none              | openLauncher                  | { windowId }                            |
// | notice.run         | notice item id    | local: the host's (the notice's button), then it closes |              |
// | notice.close       | none              | local                         |                                         |
// | prompt.run         | prompt item id    | local: the host's (the prompt's button), then it closes |              |
// | prompt.close       | none              | local                         |                                         |
// | launcher.more      | none              | local: all archived tabs, or the first 12 |                             |
//
// `show`: while the sidebar is open over the page (peek), a switch keeps it
// open on the page that comes to the front (Arcadia's openOverPage, the
// background's carryOpen).

/** @typedef {{ kind: 'send', type: string, payload: Record<string, any> } | { kind: 'local', name: string, arg?: any } | { kind: 'host', name: string, fallback?: { type: string, payload: Record<string, any> } } | { kind: 'none', reason: string }} ActionRequest */

/** Each action's way out, as the table above says. */
export const ACTION_MAP = Object.freeze({
  'tab.activate': 'activateTab',
  'tab.close': 'closeTab',
  'tab.new': 'newTab | local',
  'tab.pin': 'pinTab',
  'tab.unpin': 'unpin',
  'tab.moveToSpace': 'moveTabToSpace',
  'tab.move': 'moveTab',
  'tab.pinAt': 'pinTab',
  'pin.open': 'openPin',
  'pin.move': 'movePin',
  'folder.toggle': 'setFolderOpen',
  'folder.new': 'createFolder',
  'folder.newWithTab': 'createFolder',
  'folder.newWithPin': 'createFolder',
  'folder.rename': 'local',
  'folder.setName': 'renameFolder',
  'folder.move': 'moveFolder',
  'folder.delete': 'deleteFolder',
  'space.switch': 'setSpace',
  'space.new': 'createSpace',
  'space.edit': 'local',
  'space.rename': 'local',
  'space.setName': 'renameSpace',
  'space.update': 'renameSpace',
  'space.delete': 'deleteSpace',
  'today.clear': 'clearToday',
  'nav.back': 'host | goBack',
  'nav.forward': 'host | goForward',
  'nav.reload': 'host | reload',
  'palette.open': 'local',
  'palette.close': 'local',
  'palette.run': 'row',
  'menu.open': 'local',
  'menu.run': 'local',
  'menu.close': 'local',
  'editor.save': 'local',
  'editor.cancel': 'local',
  'editor.delete': 'local',
  'editor.color': 'local',
  'sidebar.toggle': 'updateSettings',
  'archive.open': 'openLauncher',
  'archive.restore': 'restoreArchive',
  'window.close': 'host',
  'window.minimise': 'host',
  'window.fullscreen': 'toggleFullscreen | host',
  'settings.open': 'openLauncher',
  'notice.run': 'local',
  'notice.close': 'local',
  'prompt.run': 'local',
  'prompt.close': 'local',
  'launcher.more': 'local',
  'settings.run': 'local',
});

const LOCAL = new Set(['space.edit', 'space.rename', 'folder.rename', 'palette.open', 'palette.close', 'menu.open', 'menu.run', 'menu.close', 'editor.save', 'editor.cancel', 'editor.delete', 'editor.color',
  'notice.run', 'notice.close', 'prompt.run', 'prompt.close', 'launcher.more', 'settings.run']);
const NAV = { 'nav.back': 'goBack', 'nav.forward': 'goForward', 'nav.reload': 'reload' };

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
  if (LOCAL.has(name)) return { kind: 'local', name, ...(arg === undefined ? {} : { arg }) };
  switch (name) {
    // A tab that isn't open opens in this window (the app has no page to say which).
    case 'tab.activate': return send('activateTab', { tabId: arg, ...(typeof arg === 'string' && windowId != null ? { windowId } : {}), ...show });
    case 'tab.close': return send('closeTab', { tabId: arg, ...show });
    case 'tab.new':
      return arg == null || arg === '' ? { kind: 'local', name: 'palette.open', arg: { newTab: true } } : send('newTab', { windowId, spaceId: arg });
    case 'tab.pin': return send('pinTab', { tabId: arg });
    case 'tab.unpin': return send('unpin', { pinId: arg });
    case 'tab.moveToSpace': return send('moveTabToSpace', { tabId: arg.tab, spaceId: arg.space });
    case 'tab.move': {
      // The tab it goes next to, by its address and place too (as the
      // sidebar sends it: the background trusts an id only if it's its own copy's).
      const near = state?.tabs?.[arg.nextTo];
      return send('moveTab', { tabId: arg.tab, nextTo: arg.nextTo, side: arg.side, ...(near ? { nextToHint: { url: near.url, index: near.index, title: near.title, from: state?.openTabsBy ?? null } } : {}) });
    }
    case 'tab.pinAt': return send('pinTab', { tabId: arg.tab, folderId: arg.folder, beforeId: arg.before });
    case 'pin.open': return send('openPin', { pinId: arg, windowId, ...show });
    case 'pin.move': return send('movePin', { pinId: arg.pin, folderId: arg.folder, beforeId: arg.before });
    case 'folder.toggle': {
      const folder = (state?.folders ?? []).find((f) => f.id === arg);
      return send('setFolderOpen', { folderId: arg, open: folder?.open === false });
    }
    case 'folder.new': return send('createFolder', { windowId });
    case 'folder.newWithTab': return send('createFolder', { windowId, tabId: arg });
    case 'folder.newWithPin': return send('createFolder', { windowId, pinIds: [arg] });
    case 'folder.setName': return send('renameFolder', { folderId: arg.folder, name: arg.name });
    case 'folder.move': return send('moveFolder', { folderId: arg.folder, beforeId: arg.before });
    case 'folder.delete': return send('deleteFolder', { folderId: arg });
    case 'space.switch': return send('setSpace', { windowId, spaceId: arg, ...show });
    case 'space.new': return send('createSpace', { windowId });
    case 'space.setName': return send('renameSpace', { spaceId: arg.space, name: arg.name });
    case 'space.update': return send('renameSpace', { spaceId: arg.space, name: arg.name, emoji: arg.emoji, color: arg.color });
    case 'space.delete': return send('deleteSpace', { spaceId: arg });
    case 'today.clear': return send('clearToday', { windowId });
    case 'nav.back': case 'nav.forward': case 'nav.reload':
      return { kind: 'host', name, fallback: { type: NAV[name], payload: { windowId } } };
    case 'window.close': case 'window.minimise':
      return { kind: 'host', name };
    case 'window.fullscreen':
      return platform?.marginFullscreen ? send('toggleFullscreen', { windowId }) : { kind: 'host', name };
    case 'palette.run': {
      const action = row?.action;
      if (!action) return { kind: 'none', reason: 'palette.run: no such row' };
      if (action.local) return { kind: 'local', name: `palette.${action.local}`, arg: action };
      const { type, ...payload } = action;
      return send(type, type === 'activateTab' || type === 'openPin' || type === 'setSpace' ? { ...payload, ...show } : payload);
    }
    case 'sidebar.toggle': return send('updateSettings', { patch: { sidebarPinnedOpen: !state?.settings?.sidebarPinnedOpen } });
    case 'archive.open': return send('openLauncher', { windowId });
    // On a web page: Margin's start page, its Settings open (Margin's own
    // pages toggle the form: ui/runtime.js).
    case 'settings.open': return send('openLauncher', { windowId, settings: true });
    case 'archive.restore': return send('restoreArchive', { archiveId: arg, windowId });
    default: return { kind: 'none', reason: `${name}: no mapping` };
  }
}
