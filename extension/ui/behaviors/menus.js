// Context menus (themes/arcadia/sidebar.js, "right-click menu"): a right-
// click (or ⌃-click) on a tab, a pin, a folder or a space's chip opens its
// menu at the pointer; `menu.open` opens one at a button ("add": New Folder,
// New Space, above it). The theme draws it: its `<template m-part="menu">`
// goes in `<m-menu>` while `menu` is set, reading `menu.items` (each with
// `id`, `label`, `separator`, `danger`, `confirming`), and each item's button
// runs `menu.run` with its id; what the item does stays in Margin
// (ui/behaviors/menu-items.js), checked like any action, two-value ones
// included. Margin places `<m-menu>` at the pointer, kept inside the
// window (`--m-menu-x`, `--m-menu-y`), and gives it the keys: ↓/↑ move
// between items (the pointer too), Enter runs one, Escape closes. A press
// anywhere else, the window losing focus, or the row going away closes it.
// An item that asks first (Delete Space) says "Really delete?" on its
// first press.
import { menuItems } from './menu-items.js';

// What a row's action says it is (for rows with no m-drag).
const ROW_OF_ACTION = { 'tab.activate': 'tab', 'pin.open': 'pin', 'folder.toggle': 'folder', 'space.switch': 'space', 'space.edit': 'space' };

/** @param {any} rt */
export function installMenus(rt) {
  const { view, container, doc } = rt;
  let placed = ''; // the menu placed last (kind, id, point, size)

  const slot = () => /** @type {HTMLElement | null} */ (view.rootElement()?.querySelector('m-menu') ?? null);
  const open = () => !!rt.ui.menu;

  // What a right-click is on: a row with m-drag, else an action's row, else
  // the space's own name (m-rename="space").
  function subjectAt(target) {
    const drag = view.behaviorAt(target, 'm-drag');
    if (drag) {
      const item = view.subjectOf(drag.el);
      if (item?.id != null) return { kind: drag.value, id: item.id };
    }
    for (let n = target; n; n = n.parentNode) {
      const hit = view.actionAt(n);
      if (!hit) break;
      if (ROW_OF_ACTION[hit.name] && hit.arg != null) return { kind: ROW_OF_ACTION[hit.name], id: hit.arg };
      n = hit.el;
    }
    const rename = view.behaviorAt(target, 'm-rename', 'space');
    if (rename) return { kind: 'space', id: view.subjectOf(rename.el)?.id ?? rt.vm?.space?.id };
    return null;
  }

  function show(target, point, { above = false } = {}) {
    rt.setUi({ menu: { kind: target.kind, id: target.id ?? null, x: point.x, y: point.y, above, confirming: null } });
    if (!rt.vm?.menu) { rt.setUi({ menu: null }); return false; }
    return true;
  }
  function close() {
    if (!open()) return;
    rt.setUi({ menu: null });
    placed = '';
  }

  rt.listen(container, 'contextmenu', (/** @type {MouseEvent} */ e) => {
    if (!view.owns(e.target) || rt.behaviors.rename?.editingContains(e.target)) return;
    const s = slot();
    if (s?.contains(/** @type {Node} */ (e.target))) { e.preventDefault(); return; }
    const target = subjectAt(e.target);
    if (!target) { close(); return; }
    e.preventDefault();
    e.stopPropagation();
    show(target, { x: e.clientX, y: e.clientY });
  });

  // Keys: ↓/↑ between items, Escape closes (Enter is the button's own click).
  const items = () => { const s = slot(); return s ? view.actionElements('menu.run', s) : []; };
  rt.listen(container, 'keydown', (/** @type {KeyboardEvent} */ e) => {
    if (!open()) return;
    const s = slot();
    if (!s || !s.contains(/** @type {Node} */ (e.target))) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = items();
    if (!list.length) return;
    const at = list.indexOf(/** @type {any} */ (container).activeElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length;
    /** @type {HTMLElement} */ (list[next]).focus({ preventScroll: true });
  });
  // The pointer moves the one highlight (the focused item), like macOS menus.
  rt.listen(container, 'pointerover', (/** @type {PointerEvent} */ e) => {
    if (!open()) return;
    const hit = view.actionAt(e.target);
    if (hit?.name === 'menu.run' && slot()?.contains(hit.el)) /** @type {HTMLElement} */ (hit.el).focus({ preventScroll: true });
  });
  // Any press outside the menu closes it. Presses in the UI are judged here
  // (in a closed shadow root a document listener sees only the host).
  rt.listen(container, 'pointerdown', (/** @type {PointerEvent} */ e) => {
    if (open() && !slot()?.contains(/** @type {Node} */ (e.target))) close();
  }, true);
  rt.listen(doc, 'pointerdown', (/** @type {PointerEvent} */ e) => {
    const inside = container.nodeType === 9 ? !!slot()?.contains(/** @type {Node} */ (e.target)) : e.target === /** @type {ShadowRoot} */ (container).host;
    if (open() && !inside) close();
  }, true);
  rt.listen(rt.win, 'blur', () => close());

  return {
    /** @param {{ kind: string, id?: any }} target @param {{ x: number, y: number }} point @param {{ above?: boolean }} [options] */
    open: (target, point, options) => show(target, point, options),
    close,
    /** An item chosen: its action, checked; one that asks first, asked. */
    run(itemId) {
      const menu = rt.ui.menu;
      if (!menu) return false;
      const item = menuItems(menu, { state: rt.viewState(), space: rt.vm?.space }).find((i) => i.id === itemId && !i.separator);
      if (!item) return false;
      if (item.confirm && menu.confirming !== item.id) {
        rt.setUi({ menu: { ...menu, confirming: item.id } });
        return true;
      }
      close();
      return rt.dispatch(item.action, item.arg, 'menu');
    },
    afterRender(vm) {
      if (rt.ui.menu && !vm.menu) { rt.setUi({ menu: null }); return; } // its row is gone
      const s = slot();
      if (!vm.menu || !s || !s.firstElementChild) return;
      // At the pointer, kept inside the window (`above`: its bottom there).
      const w = s.offsetWidth;
      const h = s.offsetHeight;
      const key = `${vm.menu.kind}:${vm.menu.id}:${vm.menu.x}:${vm.menu.y}:${w}:${h}`;
      if (key === placed) return;
      const first = !placed;
      placed = key;
      const win = rt.win;
      const y0 = rt.ui.menu?.above ? vm.menu.y - h - 6 : vm.menu.y;
      const x = Math.max(4, Math.min(vm.menu.x, win.innerWidth - w - 4));
      const y = Math.max(4, Math.min(y0, win.innerHeight - h - 4));
      s.style.setProperty('--m-menu-x', `${Math.round(x)}px`);
      s.style.setProperty('--m-menu-y', `${Math.round(y)}px`);
      if (first) {
        s.tabIndex = -1;
        s.focus({ preventScroll: true }); // keys work; nothing highlighted until hover or ↓/↑
      }
    },
    busy: () => open(),
  };
}
