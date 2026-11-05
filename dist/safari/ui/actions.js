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
export const ACTIONS = Object.freeze({
  'tab.activate': 'tab',
  'tab.close': 'tab',
  'tab.new': 'optional-space',
  'tab.pin': 'tab',
  'tab.unpin': 'tab',
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
 * The checks' view of a theme view model (PLAN.md §3): ids that are in it are
 * the ones that exist. The real runtime asks the state mirror instead, which
 * also knows the tabs of the spaces not on screen.
 * @param {any} vm
 * @returns {ActionContext}
 */
export function contextFromViewModel(vm) {
  const tabs = new Set();
  const folders = new Set();
  const pins = new Set();
  const addTabs = (list) => { for (const t of list ?? []) tabs.add(t.id); };
  for (const s of vm.allSpaces ?? [vm.space]) {
    if (!s) continue;
    for (const f of s.folders ?? []) { folders.add(f.id); addTabs(f.tabs); }
    for (const p of s.pins ?? []) { pins.add(p.id); if (p.tabId != null) tabs.add(p.tabId); }
    addTabs(s.today);
  }
  const spaces = new Set((vm.spaces ?? []).map((s) => s.id));
  const archived = new Set((vm.archive ?? []).map((a) => a.id));
  const rows = new Set(vm.palette?.open ? (vm.palette.rows ?? []).map((r) => r.id) : []);
  return {
    hasTab: (id) => tabs.has(id),
    hasSpace: (id) => spaces.has(id),
    hasFolder: (id) => folders.has(id),
    hasPin: (id) => pins.has(id),
    hasArchived: (id) => archived.has(id),
    hasPaletteRow: (id) => rows.has(id),
  };
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
