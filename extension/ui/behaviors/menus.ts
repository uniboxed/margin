// Context menus (themes/arcadia/sidebar.js, "right-click menu"): a right-
// click (or ⌃-click) on a tab, a pin, a folder or a space's chip opens its
// menu at the pointer; `menu.open` opens one at a button ("add": New Folder,
// New Space, above it). The theme draws it: its `<template m-part="menu">`
// goes in `<m-menu>` while `menu` is set, reading `menu.items` (each with
// `id`, `label`, `separator`, `danger`, `confirming`), and each item's button
// runs `menu.run` with its id; what the item does stays in Margin
// (ui/behaviors/menu-items.ts), checked like any action, two-value ones
// included. Margin places `<m-menu>` at the pointer, kept inside the
// window (`--m-menu-x`, `--m-menu-y`), and gives it the keys: ↓/↑ move
// between items (the pointer too), Enter runs one, Escape closes. A press
// anywhere else, the window losing focus, or the row going away closes it.
// An item that asks first (Delete Space) says "Really delete?" on its
// first press.
import { menuItems } from './menu-items.ts';

// What a row's action says it is (for rows with no m-drag).
const ROW_OF_ACTION = { 'tab.activate': 'tab', 'pin.open': 'pin', 'folder.toggle': 'folder', 'space.switch': 'space', 'space.edit': 'space', 'cloud.open': 'cloud' };

export function installMenus(rt: any) {
  const { view, container, doc } = rt;
  let placed = ''; // the menu placed last (kind, id, point, size)

  const slot = () => ((view.rootElement()?.querySelector('m-menu') ?? null) as HTMLElement | null);
  const open = () => !!rt.ui.menu;

  // What a right-click is on: a row with m-drag, else an action's row, else
  // the space's own name (m-rename="space").
  function subjectAt(target: EventTarget | null) {
    const drag = view.behaviorAt(target, 'm-drag');
    if (drag) {
      const item = view.subjectOf(drag.el);
      if (item?.id != null) return { kind: drag.value, id: item.id };
    }
    // (Each turn ends on an action's element: there's a node to go up from.)
    for (let n: Node | null = target as Node; n; n = n!.parentNode) {
      const hit = view.actionAt(n);
      if (!hit) break;
      if (ROW_OF_ACTION[hit.name] && hit.arg != null) return { kind: ROW_OF_ACTION[hit.name], id: hit.arg };
      n = hit.el;
    }
    const rename = view.behaviorAt(target, 'm-rename', 'space');
    if (rename) return { kind: 'space', id: view.subjectOf(rename.el)?.id ?? rt.vm?.space?.id };
    return null;
  }

  function show(target: { kind: any; id: any; } | { kind: string; id?: any; }, point: { x: number; y: number; }, { above = false } = {}) {
    rt.setUi({ menu: { kind: target.kind, id: target.id ?? null, x: point.x, y: point.y, above, confirming: null } });
    if (!rt.vm?.menu) { rt.setUi({ menu: null }); return false; }
    return true;
  }
  function close() {
    if (!open()) return;
    rt.setUi({ menu: null });
    placed = '';
  }

  rt.listen(container, 'contextmenu', (e: MouseEvent) => {
    if (!view.owns(e.target) || rt.behaviors.rename?.editingContains(e.target)) return;
    const s = slot();
    if (s?.contains((e.target as Node))) { e.preventDefault(); return; }
    const target = subjectAt(e.target);
    if (!target) { close(); return; }
    e.preventDefault();
    e.stopPropagation();
    show(target, { x: e.clientX, y: e.clientY });
  });

  // Keys: ↓/↑ between items, Escape closes (Enter is the button's own click).
  const items = () => { const s = slot(); return s ? view.actionElements('menu.run', s) : []; };
  rt.listen(container, 'keydown', (e: KeyboardEvent) => {
    if (!open()) return;
    const s = slot();
    if (!s || !s.contains((e.target as Node))) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = items();
    if (!list.length) return;
    const at = list.indexOf((container as any).activeElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length;
     (list[next] as HTMLElement).focus({ preventScroll: true });
  });
  // The pointer moves the one highlight (the focused item), like macOS menus.
  rt.listen(container, 'pointerover', (e: PointerEvent) => {
    if (!open()) return;
    const hit = view.actionAt(e.target);
    if (hit?.name === 'menu.run' && slot()?.contains(hit.el)) (hit.el as HTMLElement).focus({ preventScroll: true });
  });
  // Any press outside the menu closes it. Presses in the UI are judged here
  // (in a closed shadow root a document listener sees only the host).
  rt.listen(container, 'pointerdown', (e: PointerEvent) => {
    if (open() && !slot()?.contains((e.target as Node))) close();
  }, true);
  rt.listen(doc, 'pointerdown', (e: PointerEvent) => {
    const inside = container.nodeType === 9 ? !!slot()?.contains((e.target as Node)) : e.target === (container as ShadowRoot).host;
    if (open() && !inside) close();
  }, true);
  rt.listen(rt.win, 'blur', () => close());

  return {
    open: (target: { kind: string, id?: any }, point: { x: number, y: number }, options: { above?: boolean }) => show(target, point, options),
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
      // The pointer is in the page's pixels, the menu placed in Margin's
      // (the page's zoom: rt.scale).
      const w = s.offsetWidth;
      const h = s.offsetHeight;
      const k = rt.scale?.() || 1;
      const key = `${vm.menu.kind}:${vm.menu.id}:${vm.menu.x}:${vm.menu.y}:${w}:${h}:${k}`;
      if (key === placed) return;
      const first = !placed;
      placed = key;
      const win = rt.win;
      const y0 = rt.ui.menu?.above ? vm.menu.y * k - h - 6 : vm.menu.y * k;
      const x = Math.max(4, Math.min(vm.menu.x * k, win.innerWidth * k - w - 4));
      const y = Math.max(4, Math.min(y0, win.innerHeight * k - h - 4));
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
