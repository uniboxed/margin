// The whole list of actions a theme can trigger (PLAN.md §3, "Actions"), and
// the checks every one goes through before Margin runs it. A theme names an
// action with `m-action` on a button or link; its argument comes from
// `m-arg` (a `{{path}}` into the view model or a literal). Margin's own
// behaviors (ui/behaviors/: a drop, a rename, a menu's item) run actions
// too, some of which only they may run (BEHAVIOR_ONLY). Nothing here runs an
// action: the runtime does, once it's checked against the state. An unknown
// action or a bad argument is ignored and logged.
import type { State } from '../../../types/margin';
import { backgroundOf } from '../../../extension/shared/space-background.ts';

// What each action's argument must be:
//   none   — no argument (anything given is refused);
//   tab    — the id of an open tab, or of a Margin tab that isn't open (a
//            string: state/model.ts keptTabs; activating it opens it);
//   space — the id of an existing space;
//   folder — an existing folder's id;   pin — an existing pin's id;
//   rule — an existing link rule's id (Link Rules, state.airTraffic);
//   archive — an archived entry's id;   row — a row of the open palette;
//   item   — an item of the open menu;  color — a swatch of the space editor;
//   notice-item, prompt-item — a button of the notice or prompt shown;
//   optional-space — nothing, or an existing space;
//   menu   — a menu a button opens (MENUS);
//   library-section — a section of the Library's rail (LIBRARY_SECTION_IDS);
//   { field: kind, … } — an object with exactly those fields. Only behaviors
//     and menus make one, never `m-arg`, which carries one value. A field's
//     kind is one of the above, `kind?` (that or null), `pin-or-folder?` (the
//     pin or folder something goes before, or null: the end), `name` (a name
//     as typed: at most 40 characters, no control characters), `emoji` (at
//     most 8), `hex` (#rgb or #rrggbb), or the list of values it may be.
// `tab.unpin` takes the pin's id: a pinned tab is drawn as its pin's row
// (shared/view.ts sidebar), whose id is the pin's, and a pin not open has
// no tab at all (the background's `unpin` takes a pin id too).
export const ACTIONS = Object.freeze({
  'tab.activate': 'tab',
  'tab.close': 'tab',
  'tab.new': 'optional-space',
  'tab.pin': 'tab',
  'tab.unpin': 'pin',
  'tab.copyUrl': 'optional-tab',
  'tab.duplicate': 'tab',
  'tab.mute': 'tab',
  'tab.unload': 'tab',
  'tab.rename': 'tab',
  'tab.setTitle': Object.freeze({ tab: 'tab', name: 'name' }),
  'tab.moveToSpace': Object.freeze({ tab: 'tab', space: 'space' }),
  'tab.move': Object.freeze({ tab: 'tab', nextTo: 'tab', side: Object.freeze(['before', 'after']) }),
  'tab.pinAt': Object.freeze({ tab: 'tab', folder: 'folder?', before: 'pin-or-folder?' }),
  'pin.open': 'pin',
  'pin.reset': 'pin',
  'pin.rename': 'pin',
  'pin.setTitle': Object.freeze({ pin: 'pin', name: 'name' }),
  'pin.copyUrl': 'pin',
  'pin.move': Object.freeze({ pin: 'pin', folder: 'folder?', before: 'pin-or-folder?' }),
  'favorite.open': 'favorite',
  'favorite.add': 'tab',
  'favorite.addPin': 'pin',
  'favorite.remove': 'favorite',
  'favorite.reset': 'favorite',
  'favorite.rename': 'favorite',
  'favorite.setTitle': Object.freeze({ favorite: 'favorite', name: 'name' }),
  'favorite.move': Object.freeze({ favorite: 'favorite', before: 'favorite?' }),
  'favorite.copyUrl': 'favorite',
  'folder.toggle': 'folder',
  'folder.new': 'none',
  'folder.newIn': 'folder',
  'folder.newWithTab': 'tab',
  'folder.newWithPin': 'pin',
  'folder.rename': 'folder',
  'folder.setName': Object.freeze({ folder: 'folder', name: 'name' }),
  'folder.move': Object.freeze({ folder: 'folder', before: 'pin-or-folder?' }),
  'folder.nest': Object.freeze({ folder: 'folder', parent: 'folder?', before: 'pin-or-folder?' }),
  'folder.delete': 'folder',
  'space.switch': 'space',
  'space.new': 'none',
  'space.edit': 'space',
  'space.rename': 'space',
  'space.setName': Object.freeze({ space: 'space', name: 'name' }),
  // (`emoji: null` removes the space's icon: Arc's space with none, a dot in the switcher; M2.10.)
  'space.update': Object.freeze({ space: 'space', name: 'name', emoji: 'emoji?', color: 'hex?', theme: 'theme?' }),
  // A space's theme (ui/space-theme.ts; null: none, the profile's): its menu's Theme items, Settings' Theme.
  'space.setTheme': Object.freeze({ space: 'space', theme: 'theme?' }),
  // A space's background (M2.9: Edit Theme Color, ui/behaviors/background-picker.ts): the picker opened for it, and
  // what it saves (null: none, the theme's own; `color` its key colour, null: as it is).
  'space.editBackground': 'space',
  // Edit Theme Color drawn by the theme (its `background-picker` part, M2.9 step 5b): one of the open picker's items
  // (ui/picker/view.ts: an appearance, a colour more or fewer, the rule, a preset, a page, a texture, an amount, an
  // intensity, Use for All Spaces, Done), what it does Margin's.
  'picker.run': 'picker-item',
  'space.setBackground': Object.freeze({ space: 'space', background: 'background?', color: 'hex?' }),
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
  // The space editor's theme (one of `editor.themes`' ids).
  'editor.theme': 'theme',
  'sidebar.toggle': 'none',
  'archive.open': 'none',
  'archive.restore': 'archive',
  'archive.restoreLast': 'none',
  // Arc's Library (ui/behaviors/ends.ts): opened (the box button, a swipe past the first space), closed (its back
  // arrow), a section of its rail shown (LIBRARY_SECTIONS).
  'library.open': 'none',
  'library.close': 'none',
  'library.section': 'library-section',
  // Arc's Create a Space (a pull past the last space, Arc's "+"): opened, cancelled, its space made (Create Space),
  // made and its Edit Theme Color opened (Choose a Theme), the profile it opens in (its `profile` menu's items).
  'newSpace.open': 'none',
  'newSpace.cancel': 'none',
  'newSpace.create': 'none',
  'newSpace.theme': 'none',
  'newSpace.profile': Object.freeze({ profile: 'name' }),
  'media.toggle': 'none',
  'media.prev': 'none',
  'media.next': 'none',
  'media.mute': 'none',
  'media.focus': 'none',
  'preview.close': 'none',
  'preview.expand': 'none',
  'preview.copyUrl': 'none',
  'preview.setSpace': 'space',
  'preview.back': 'none',
  'preview.forward': 'none',
  // Quick Tab (⌥⌘N): the preview card with Margin's own address field first (docs/PEEK-SPLIT.md §3).
  'quickTab.open': 'none',
  'linkRules.addHost': 'tab',
  // A link rule (Link Rules, state.airTraffic): removed, or turned off and on again (a tab's menu, Settings).
  'linkRules.remove': 'rule',
  'linkRules.toggle': 'rule',
  'split.add': 'tab',
  // (Its name in themes/README.md: the same action.)
  'split.addPane': 'tab',
  // (A new Split View as the host's ⌃⇧= makes one: Arc's "+" New Split; only a host that gives the runtime `addSplit`.)
  'split.new': 'none',
  'split.open': 'split',
  'split.focus': 'tab',
  'split.breakOut': 'tab',
  // Out of its split, the rest of it shown (split.breakOut: shown alone).
  'split.remove': 'tab',
  'split.closePane': 'tab',
  'split.swap': 'split',
  'split.toggleAxis': 'split',
  // A divider let go (ui/split-panes.ts): the split's panes' ratios, one each, saved.
  'split.resize': Object.freeze({ split: 'split', ratios: 'ratios' }),
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
  // The Settings page's sidebar: one of its categories shown (ui/settings-form.ts SETTINGS_CATEGORIES).
  'settings.category': 'settings-category',
});

export const ACTION_NAMES = Object.freeze(Object.keys(ACTIONS));

export const isAction = (name: string) => typeof name === 'string' && Object.hasOwn(ACTIONS, name);

// Only Margin's behaviors and menus run these: their argument is an object
// no `m-arg` makes, or they shouldn't come from one click on a theme's
// button (deleting a space takes the editor's two presses, or a menu's
// "Really delete?").
export const BEHAVIOR_ONLY = Object.freeze(new Set([
  ...Object.entries(ACTIONS).filter(([, kind]) => typeof kind === 'object').map(([name]) => name),
  'space.delete',
]));

// The menus a button can open (`menu.open`): "add" is New Folder and New Space; "space" is the space in front's own
// menu (the one its name's right-click opens: Arc's `•••` beside the space's name).
// "profile": Create a Space's profiles (Margin.app's, for the browser the new space opens in).
export const MENUS = Object.freeze(['add', 'space', 'profile']);
// The Library's rail (`library.section`), as ui/view-model.ts LIBRARY_SECTIONS lists them.
export const LIBRARY_SECTION_IDS: readonly string[] = Object.freeze(['media', 'downloads', 'spaces', 'boosts', 'archive']);
// The Settings page's categories (`settings.category`), as ui/settings-form.ts SETTINGS_CATEGORIES lists them.
export const SETTINGS_CATEGORY_IDS: readonly string[] = Object.freeze(['appearance', 'themes', 'tabs', 'browsing', 'apps', 'keyboard']);

// An id as the state holds it: a tab id is a safe integer (the browser's),
// other ids are short strings of letters, digits, '-', '_' and ':'.
const ID_TEXT = /^[A-Za-z0-9_:-]{1,64}$/;
const isId = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  || (typeof value === 'string' && ID_TEXT.test(value));

/**
 * What `checkAction` asks of the state. Every function answers for an id the
 * state holds right now; `hasMenuItem` and `hasColor`, for the open menu's
 * items and the space editor's swatches.
 */
export type ActionContext = {
  hasTab(id: any): boolean, hasSpace(id: any): boolean, hasFolder(id: any): boolean,
  hasPin(id: any): boolean, hasFavorite?(id: any): boolean, hasSplit?(id: any): boolean, hasRule?(id: any): boolean, hasArchived(id: any): boolean, hasPaletteRow(id: any): boolean,
  hasMenuItem?(id: any): boolean, hasColor?(id: any): boolean,
  hasNoticeItem?(id: any): boolean, hasPromptItem?(id: any): boolean,
  hasSettingItem?(id: any): boolean,
  /** One of the open picker's items (a theme's own picker: ui/picker/view.ts). */
  hasPickerItem?(id: any): boolean,
  /** A theme Margin has (built in or imported: ui/space-theme.ts themeChoices). */
  hasTheme?(id: any): boolean,
};

export const NAME_MAX = 40;
const EMOJI_MAX = 8;
// eslint-disable-next-line no-control-regex
const plainText = (value: unknown, max: number) => typeof value === 'string' && [...value].length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const isPlainObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** One field's value against its kind. */
function valueOk(kind: string | readonly unknown[], v: any, ctx: ActionContext) {
  if (Array.isArray(kind)) return kind.includes(v);
  const text = (kind as string);
  const optional = text.endsWith('?');
  if (optional && v === null) return true;
  switch (optional ? text.slice(0, -1) : text) {
    case 'tab': return isId(v) && ctx.hasTab(v);
    case 'space': return isId(v) && ctx.hasSpace(v);
    case 'folder': return isId(v) && ctx.hasFolder(v);
    case 'pin': return isId(v) && ctx.hasPin(v);
    case 'favorite': return isId(v) && !!ctx.hasFavorite?.(v);
    case 'split': return isId(v) && !!ctx.hasSplit?.(v);
    case 'rule': return isId(v) && !!ctx.hasRule?.(v);
    case 'pin-or-folder': return isId(v) && (ctx.hasPin(v) || ctx.hasFolder(v));
    case 'name': return plainText(v, NAME_MAX);
    case 'emoji': return plainText(v, EMOJI_MAX);
    case 'hex': return typeof v === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
    // A split's ratios: 2–4 positive numbers (normalized where they're saved).
    case 'ratios': return Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every((r) => typeof r === 'number' && Number.isFinite(r) && r > 0 && r <= 1);
    case 'theme': return isId(v) && !!ctx.hasTheme?.(v);
    // A space's background: one the model reads as one (extension/state/model.ts backgroundOf), as plain data.
    case 'background': return isPlainObject(v) && backgroundOf(v) !== null;
    default: return false;
  }
}

/**
 * Checks one action and its argument against the state.
 * */
export function checkAction(name: string, arg: any, ctx: ActionContext): { ok: true } | { ok: false, reason: string } {
  if (!isAction(name)) return { ok: false, reason: `unknown action ${JSON.stringify(String(name)).slice(0, 80)}` };
  // (Its argument's kind: a name, or the fields of an object and each one's.)
  const kind = (ACTIONS as Readonly<Record<string, string | Readonly<Record<string, string | readonly unknown[]>>>>)[name];
  const none = arg === undefined || arg === null || arg === '';
  if (typeof kind === 'object') {
    const fields = Object.keys(kind);
    if (!isPlainObject(arg) || Object.keys(arg).sort().join() !== [...fields].sort().join()) return { ok: false, reason: `${name}: needs { ${fields.join(', ')} }` };
    for (const field of fields) if (!valueOk(kind[field], arg[field], ctx)) return { ok: false, reason: `${name}: bad ${field}` };
    return { ok: true };
  }
  const has: Record<string, (id: any) => boolean> = {
    tab: ctx.hasTab, space: ctx.hasSpace, folder: ctx.hasFolder, pin: ctx.hasPin, favorite: ctx.hasFavorite ?? (() => false), split: ctx.hasSplit ?? (() => false), rule: ctx.hasRule ?? (() => false), archive: ctx.hasArchived, row: ctx.hasPaletteRow,
    item: ctx.hasMenuItem ?? (() => false), color: ctx.hasColor ?? (() => false),
    'notice-item': ctx.hasNoticeItem ?? (() => false), 'prompt-item': ctx.hasPromptItem ?? (() => false),
    'setting-item': ctx.hasSettingItem ?? (() => false), theme: ctx.hasTheme ?? (() => false),
    'picker-item': ctx.hasPickerItem ?? (() => false),
  };
  switch (kind) {
    case 'none':
      return none ? { ok: true } : { ok: false, reason: `${name} takes no argument` };
    case 'optional-space':
      if (none) return { ok: true };
      return isId(arg) && ctx.hasSpace(arg) ? { ok: true } : { ok: false, reason: `${name}: not a space` };
    case 'optional-tab':
      if (none) return { ok: true };
      return isId(arg) && ctx.hasTab(arg) ? { ok: true } : { ok: false, reason: `${name}: not a tab` };
    case 'menu':
      return MENUS.includes(arg) ? { ok: true } : { ok: false, reason: `${name}: no such menu` };
    case 'settings-category':
      return SETTINGS_CATEGORY_IDS.includes(arg) ? { ok: true } : { ok: false, reason: `${name}: no such category` };
    case 'library-section':
      return LIBRARY_SECTION_IDS.includes(arg) ? { ok: true } : { ok: false, reason: `${name}: no such section` };
    default:
      if (!isId(arg)) return { ok: false, reason: `${name}: bad ${kind} id` };
      return has[kind](arg) ? { ok: true } : { ok: false, reason: `${name}: no ${kind} ${JSON.stringify(arg)}` };
  }
}

/**
 * Margin's side of a theme's clicks: checks each one, then hands the good
 * ones to `run`. `log` hears about every refused one. A theme's click never
 * runs an action only behaviors may run.
 * */
export function createDispatcher({ context, run, log = () => {} }: { context: () => ActionContext, run: (name: string, arg: any) => void, log?: (entry: { name: string, arg: any, reason: string }) => void }) {
  return function dispatch(name: string, arg: unknown) {
    const verdict = BEHAVIOR_ONLY.has(name) ? { ok: false, reason: `${name}: only Margin's behaviors and menus run it` } : checkAction(name, arg, context());
    if (!verdict.ok) {
      log({ name: String(name), arg, reason: (verdict as any).reason });
      return false;
    }
    run(name, arg);
    return true;
  };
}

/**
 * The checks' view of Margin's state (the host's, as pages read it): every
 * open tab in any window, every space, folder, pin and archived entry, the
 * rows of the palette while it's open (`paletteIds`, from ui/view-model.ts
 * paletteItems), and the open menu's items and the editor's swatches.
 * */
export function contextFromState(state: any, paletteIds: Iterable<string> = [], { menuIds = [], colorIds = [], noticeIds = [], promptIds = [], settingIds = [], themeIds = [], pickerIds = [] }: { menuIds?: Iterable<string>, colorIds?: Iterable<string>, noticeIds?: Iterable<string>, promptIds?: Iterable<string>, settingIds?: Iterable<string>, themeIds?: Iterable<string>, pickerIds?: Iterable<string> } = {}): ActionContext {
  const tabs = state?.tabs && typeof state.tabs === 'object' ? state.tabs : {};
  const kept = state?.keptTabs && typeof state.keptTabs === 'object' ? state.keptTabs : {};
  const ids = (list: unknown) => new Set((Array.isArray(list) ? list : []).map((x) => x?.id));
  const spaces = ids(state?.spaces);
  const folders = ids(state?.folders);
  const pins = ids(state?.pins);
  const favorites = ids(state?.favorites);
  const splits = ids(state?.splits);
  const rules = ids(state?.airTraffic);
  const archived = ids(state?.archive);
  const rows = new Set(paletteIds);
  const items = new Set(menuIds);
  const colors = new Set(colorIds);
  const notices = new Set(noticeIds);
  const prompts = new Set(promptIds);
  const settingButtons = new Set(settingIds);
  const themes = new Set(themeIds);
  const pickerItems = new Set(pickerIds);
  return {
    // An open tab by its browser tab's id, or a Margin tab that isn't open
    // by its own (state/model.ts keptTabs).
    hasTab: (id) => (Number.isInteger(id) && Object.prototype.hasOwnProperty.call(tabs, id) && tabs[id]?.id === id)
      || (typeof id === 'string' && Object.prototype.hasOwnProperty.call(kept, id) && kept[id]?.id === id),
    hasSpace: (id) => spaces.has(id),
    hasFolder: (id) => folders.has(id),
    hasPin: (id) => pins.has(id),
    hasFavorite: (id) => favorites.has(id),
    hasSplit: (id) => splits.has(id),
    hasRule: (id) => rules.has(id),
    hasArchived: (id) => archived.has(id),
    hasPaletteRow: (id) => rows.has(id),
    hasMenuItem: (id) => items.has(id),
    hasColor: (id) => colors.has(id),
    hasNoticeItem: (id) => notices.has(id),
    hasPromptItem: (id) => prompts.has(id),
    hasSettingItem: (id) => settingButtons.has(id),
    hasTheme: (id) => themes.has(id),
    hasPickerItem: (id) => pickerItems.has(id),
  };
}

// ---------------------------------------------------------------------------
// From an action to what Margin does (PLAN.md §3 "Actions"): a request to
// the background's handler of that name (background/handlers.ts, as
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
// | space.update       | {space, name, emoji, color, theme?} | renameSpace | { spaceId, name, emoji, color, theme? } |
// | space.setTheme     | {space, theme}    | setSpaceTheme                 | { spaceId, theme } (null: the profile's) |
// | space.editBackground | space id        | local: Edit Theme Color       | (it sends space.setBackground)          |
// | space.setBackground | {space, background, color} | renameSpace          | { spaceId, background (as the model reads it; null: none), color? } |
// | space.delete       | space id          | deleteSpace                   | { spaceId }                             |
// | today.clear        | none              | clearToday                    | { windowId }                            |
// | nav.back, .forward, .reload | none     | host, else goBack, goForward, reload | { windowId }                     |
// | palette.open, .close | none            | local                         |                                         |
// | palette.run        | row id            | the row's own request         | shared/search.ts rankPalette's action:  |
// |                    |                   |                               | activateTab, openPin, restoreArchive,   |
// |                    |                   |                               | setSpace, newTab, search, pinTab,       |
// |                    |                   |                               | newWindow, openLauncher,                |
// |                    |                   |                               | toggleFullscreen; or local:             |
// |                    |                   |                               | toggleSidebar, navigate, search; or     |
// |                    |                   |                               | host: app.open { bundleId, name }       |
// | menu.open          | 'add', 'space',   | local: that menu, at the button (the space's: the one in front; |        |
// |                    | 'profile'         | the profile: Create a Space's profiles)                         |        |
// | menu.run           | item id           | the item's own action         | (ui/behaviors/menu-items.ts)            |
// | menu.close         | none              | local                         |                                         |
// | picker.run         | picker item id    | local: Edit Theme Color's     | (ui/picker/view.ts runItem)             |
// | editor.save, .cancel, .delete, .color, .theme | | local: the space editor | (save: space.update; delete: twice)  |
// | sidebar.toggle     | none              | updateSettings                | { patch: { sidebarPinnedOpen: !now } }  |
// | archive.open       | none              | openLauncher                  | { windowId }                            |
// | archive.restore    | archive id        | restoreArchive                | { archiveId, windowId }                 |
// | library.open, .close | none            | local: Arc's Library open or not (behaviors/ends.ts)                    |
// | library.section    | section id        | local: the rail's section shown                                         |
// | newSpace.open, .cancel | none          | local: Arc's Create a Space shown or not                                |
// | newSpace.create    | none              | createSpace                   | { windowId, name, emoji?, color, profile? } |
// | newSpace.theme     | none              | createSpace, then Edit Theme Color for it                               |
// | newSpace.profile   | { profile } (menu)| local: the profile it'll open in                                        |
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

export type ActionRequest = { kind: 'send', type: string, payload: Record<string, any> } | { kind: 'local', name: string, arg?: any } | { kind: 'host', name: string, arg?: any, fallback?: { type: string, payload: Record<string, any> } } | { kind: 'none', reason: string };

/** Each action's way out, as the table above says. */
export const ACTION_MAP = Object.freeze({
  'tab.activate': 'activateTab',
  'tab.close': 'closeTab',
  'tab.new': 'newTab | local',
  'tab.pin': 'pinTab',
  'tab.unpin': 'unpin',
  'tab.copyUrl': 'local',
  'tab.duplicate': 'duplicateTab',
  'tab.mute': 'muteTab',
  'tab.unload': 'unloadTab',
  'tab.rename': 'local',
  'tab.setTitle': 'renameTab',
  'tab.moveToSpace': 'moveTabToSpace',
  'tab.move': 'moveTab',
  'tab.pinAt': 'pinTab',
  'pin.open': 'openPin',
  'pin.reset': 'resetPin',
  'pin.rename': 'local',
  'pin.setTitle': 'renamePin',
  'pin.copyUrl': 'local',
  'pin.move': 'movePin',
  'favorite.open': 'openFavorite',
  'favorite.add': 'addFavorite',
  'favorite.addPin': 'addFavorite',
  'favorite.remove': 'removeFavorite',
  'favorite.reset': 'resetFavorite',
  'favorite.rename': 'local',
  'favorite.setTitle': 'renameFavorite',
  'favorite.move': 'moveFavorite',
  'favorite.copyUrl': 'local',
  'folder.toggle': 'setFolderOpen',
  'folder.new': 'createFolder',
  'folder.newIn': 'createFolder',
  'folder.newWithTab': 'createFolder',
  'folder.newWithPin': 'createFolder',
  'folder.rename': 'local',
  'folder.setName': 'renameFolder',
  'folder.move': 'moveFolder',
  'folder.nest': 'nestFolder',
  'folder.delete': 'deleteFolder',
  'space.switch': 'setSpace',
  'space.new': 'createSpace',
  'space.edit': 'local',
  'space.rename': 'local',
  'space.setName': 'renameSpace',
  'space.update': 'renameSpace',
  'space.setTheme': 'setSpaceTheme',
  'space.editBackground': 'local',
  'space.setBackground': 'renameSpace',
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
  'picker.run': 'local',
  'menu.close': 'local',
  'editor.save': 'local',
  'editor.cancel': 'local',
  'editor.delete': 'local',
  'editor.color': 'local',
  'editor.theme': 'local',
  'sidebar.toggle': 'updateSettings',
  'archive.open': 'openLauncher',
  'library.open': 'local',
  'library.close': 'local',
  'library.section': 'local',
  'newSpace.open': 'local',
  'newSpace.cancel': 'local',
  'newSpace.create': 'local',
  'newSpace.theme': 'local',
  'newSpace.profile': 'local',
  'archive.restore': 'restoreArchive',
  'archive.restoreLast': 'restoreLastArchive',
  'media.toggle': 'mediaControl',
  'media.prev': 'mediaControl',
  'media.next': 'mediaControl',
  'media.mute': 'mediaControl',
  'media.focus': 'mediaControl',
  'preview.close': 'local',
  'preview.expand': 'local',
  'preview.copyUrl': 'local',
  'preview.setSpace': 'local',
  'preview.back': 'local',
  'preview.forward': 'local',
  'quickTab.open': 'local',
  'linkRules.addHost': 'addAirTrafficRule',
  'linkRules.remove': 'removeAirTrafficRule',
  'linkRules.toggle': 'toggleAirTrafficRule',
  'split.add': 'addToSplit',
  'split.addPane': 'addToSplit',
  'split.new': 'local',
  'split.open': 'openSplit',
  'split.focus': 'activateTab',
  'split.breakOut': 'breakOutSplit',
  'split.remove': 'removeFromSplit',
  'split.closePane': 'closeSplitPane',
  'split.swap': 'swapSplit',
  'split.toggleAxis': 'toggleSplitAxis',
  'split.resize': 'resizeSplit',
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
  'settings.category': 'local',
});

const LOCAL = new Set(['split.new', 'space.edit', 'space.editBackground', 'space.rename', 'folder.rename', 'tab.rename', 'pin.rename', 'favorite.rename', 'palette.open', 'palette.close', 'menu.open', 'menu.run', 'menu.close', 'picker.run', 'editor.save', 'editor.cancel', 'editor.delete', 'editor.color', 'editor.theme',
  'notice.run', 'notice.close', 'prompt.run', 'prompt.close', 'launcher.more', 'settings.run', 'settings.category', 'tab.copyUrl', 'pin.copyUrl', 'favorite.copyUrl', 'preview.close', 'preview.expand', 'preview.copyUrl', 'preview.setSpace', 'preview.back', 'preview.forward', 'quickTab.open',
  'library.open', 'library.close', 'library.section', 'newSpace.open', 'newSpace.cancel', 'newSpace.create', 'newSpace.theme', 'newSpace.profile']);
const NAV = { 'nav.back': 'goBack', 'nav.forward': 'goForward', 'nav.reload': 'reload' };

/**
 * What a checked action becomes (`checkAction` first: this trusts its
 * argument). `state`: the host's state (as read from storage, as the view model takes it: its settings may be only
 * some of them); `ui`: the UI's own (its window, the
 * sidebar); `platform`: the host's (whether the browser has Margin full
 * screen); `row`: for palette.run, the palette item its row id names
 * (ui/view-model.ts paletteItems), with its `action`.
 * */
export function requestFor(name: string, arg: any, { state, ui, platform, row }: { state: (Omit<Partial<State>, 'settings'> & { settings?: Partial<State['settings']> } & Record<string, any>) | null, ui: { windowId?: number | null, sidebar?: string | null }, platform?: { marginFullscreen?: boolean }, row?: any }): ActionRequest {
  const windowId = ui.windowId ?? undefined;
  const show = ui.sidebar === 'peek' ? { show: true } : {};
  const send = (type: string, payload: Record<string, any>): ActionRequest => ({ kind: 'send', type, payload });
  if (LOCAL.has(name)) return { kind: 'local', name, ...(arg === undefined ? {} : { arg }) };
  switch (name) {
    // A tab that isn't open opens in this window (the app has no page to say which).
    case 'tab.activate': return send('activateTab', { tabId: arg, ...(typeof arg === 'string' && windowId != null ? { windowId } : {}), ...show });
    case 'tab.close': return send('closeTab', { tabId: arg, ...show });
    case 'tab.new':
      return arg == null || arg === '' ? { kind: 'local', name: 'palette.open', arg: { newTab: true } } : send('newTab', { windowId, spaceId: arg });
    case 'tab.pin': return send('pinTab', { tabId: arg });
    case 'tab.unpin': return send('unpin', { pinId: arg });
    case 'tab.duplicate': return send('duplicateTab', { tabId: arg, windowId });
    case 'tab.mute': return send('muteTab', { tabId: arg, windowId });
    case 'tab.unload': return send('unloadTab', { tabId: arg, windowId });
    case 'tab.setTitle': return send('renameTab', { tabId: arg.tab, title: arg.name });
    case 'tab.moveToSpace': return send('moveTabToSpace', { tabId: arg.tab, spaceId: arg.space });
    case 'tab.move': {
      // The tab it goes next to, by its address and place too (as the
      // sidebar sends it: the background trusts an id only if it's its own copy's).
      const near = state?.tabs?.[arg.nextTo];
      return send('moveTab', { tabId: arg.tab, nextTo: arg.nextTo, side: arg.side, ...(near ? { nextToHint: { url: near.url, index: near.index, title: near.title, from: state?.openTabsBy ?? null } } : {}) });
    }
    case 'tab.pinAt': return send('pinTab', { tabId: arg.tab, folderId: arg.folder, beforeId: arg.before });
    case 'pin.open': return send('openPin', { pinId: arg, windowId, ...show });
    case 'pin.reset': return send('resetPin', { pinId: arg, windowId, ...show });
    case 'pin.setTitle': return send('renamePin', { pinId: arg.pin, title: arg.name });
    case 'pin.move': return send('movePin', { pinId: arg.pin, folderId: arg.folder, beforeId: arg.before });
    case 'favorite.open': return send('openFavorite', { favoriteId: arg, windowId, ...show });
    case 'favorite.add': return send('addFavorite', { tabId: arg, windowId });
    case 'favorite.addPin': return send('addFavorite', { pinId: arg, windowId });
    case 'favorite.remove': return send('removeFavorite', { favoriteId: arg });
    case 'favorite.reset': return send('resetFavorite', { favoriteId: arg, windowId, ...show });
    case 'favorite.setTitle': return send('renameFavorite', { favoriteId: arg.favorite, title: arg.name });
    case 'favorite.move': return send('moveFavorite', { favoriteId: arg.favorite, beforeId: arg.before });
    case 'folder.toggle': {
      const folder = (state?.folders ?? []).find((f) => f.id === arg);
      return send('setFolderOpen', { folderId: arg, open: folder?.open === false });
    }
    case 'folder.new': return send('createFolder', { windowId });
    case 'folder.newIn': return send('createFolder', { windowId, parentId: arg });
    case 'folder.newWithTab': return send('createFolder', { windowId, tabId: arg });
    case 'folder.newWithPin': return send('createFolder', { windowId, pinIds: [arg] });
    case 'folder.setName': return send('renameFolder', { folderId: arg.folder, name: arg.name });
    case 'folder.move': return send('moveFolder', { folderId: arg.folder, beforeId: arg.before });
    case 'folder.nest': return send('nestFolder', { folderId: arg.folder, parentId: arg.parent, beforeId: arg.before });
    case 'folder.delete': return send('deleteFolder', { folderId: arg });
    case 'space.switch': return send('setSpace', { windowId, spaceId: arg, ...show });
    case 'space.new': return send('createSpace', { windowId });
    case 'space.setName': return send('renameSpace', { spaceId: arg.space, name: arg.name });
    case 'space.update': return send('renameSpace', { spaceId: arg.space, name: arg.name, emoji: arg.emoji, color: arg.color, ...(arg.theme !== undefined ? { theme: arg.theme } : {}) });
    case 'space.setTheme': return send('setSpaceTheme', { spaceId: arg.space, theme: arg.theme ?? null });
    case 'space.setBackground': return send('renameSpace', { spaceId: arg.space, background: arg.background === null ? null : backgroundOf(arg.background), ...(typeof arg.color === 'string' ? { color: arg.color } : {}) });
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
      // What only the app does (an installed app opened in the page area: `app.open`).
      if (typeof action.perform === 'string') return { kind: 'host', name: action.perform, arg: action.arg };
      const { type, ...payload } = action;
      return send(type, type === 'activateTab' || type === 'openPin' || type === 'setSpace' ? { ...payload, ...show } : payload);
    }
    case 'sidebar.toggle': return send('updateSettings', { patch: { sidebarPinnedOpen: !state?.settings?.sidebarPinnedOpen } });
    case 'archive.open': return send('openLauncher', { windowId });
    // On a web page: Margin's start page, its Settings open (Margin's own
    // pages toggle the form: ui/runtime.ts).
    case 'settings.open': return send('openLauncher', { windowId, settings: true });
    case 'archive.restore': return send('restoreArchive', { archiveId: arg, windowId });
    case 'archive.restoreLast': return send('restoreLastArchive', { windowId });
    case 'media.toggle': return send('mediaControl', { command: 'toggle' });
    case 'media.prev': return send('mediaControl', { command: 'prev' });
    case 'media.next': return send('mediaControl', { command: 'next' });
    case 'media.mute': return send('mediaControl', { command: 'mute' });
    case 'media.focus': return send('mediaControl', { command: 'focus' });
    case 'linkRules.addHost': {
      const item = typeof arg === 'string' ? state?.keptTabs?.[arg] : state?.tabs?.[arg];
      let host = '';
      try { host = new URL(item?.url ?? '').hostname.toLowerCase(); } catch {}
      const spaceId = typeof arg === 'string' ? state?.keptTabs?.[arg]?.spaceId : state?.tabSpace?.[arg];
      return send('addAirTrafficRule', { pattern: host, spaceId: spaceId ?? undefined });
    }
    case 'linkRules.remove': return send('removeAirTrafficRule', { ruleId: arg });
    case 'linkRules.toggle': return send('toggleAirTrafficRule', { ruleId: arg });
    case 'split.add':
    case 'split.addPane': return send('addToSplit', { tabId: arg, windowId });
    case 'split.open': return send('openSplit', { splitId: arg, windowId, ...show });
    case 'split.focus': return send('activateTab', { tabId: arg, ...(typeof arg === 'string' && windowId != null ? { windowId } : {}), ...show });
    case 'split.breakOut': return send('breakOutSplit', { tabId: arg, windowId });
    case 'split.remove': return send('removeFromSplit', { tabId: arg, windowId });
    case 'split.closePane': return send('closeSplitPane', { tabId: arg, windowId });
    case 'split.swap': return send('swapSplit', { splitId: arg, windowId });
    case 'split.toggleAxis': return send('toggleSplitAxis', { splitId: arg, windowId });
    case 'split.resize': return send('resizeSplit', { splitId: arg.split, ratios: arg.ratios, windowId });
    default: return { kind: 'none', reason: `${name}: no mapping` };
  }
}
