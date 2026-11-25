// A double-click on an empty part of the sidebar opens the command palette, as Arc's does (docs/SIDEBAR-PRESS.md):
// the same palette Margin's palette key opens (`rt.openPaletteAsKey`: in Margin's own window, the new-tab palette),
// never closing it. Both of the double-click's clicks on empty points (ui/empty.ts: no row, button, field, handle,
// drag region, menu or bar under them, nothing the theme marked `m-empty="never"`), with the main button and no
// modifier, and nothing of Margin's open or under way at its first press (the palette, a menu, the space editor, a
// name being edited, a prompt, the preview card; a drag, a resize, a swipe). Every theme, every host: a theme has
// nothing to opt into. In Margin.app the press comes through the press tap as the window server's own record, so this
// is the page's own dblclick (app/platforms/macos/shell/PaneClickTap.swift).
import type { Rt } from '../runtime.ts';
import { isEmpty } from '../empty.ts';

const MODIFIERS = (e: MouseEvent) => e.metaKey || e.ctrlKey || e.altKey || e.shiftKey;

export function installEmpty(rt: Rt) {
  const { view, container } = rt;
  // The double-click's first press: on an empty point with nothing of Margin's open (null: not one that can open it).
  let first: { target: EventTarget | null } | null = null;
  const nothingOpen = () => {
    const ui = rt.ui;
    return !ui.palette.open && !ui.menu && !ui.editor && !ui.editing && !ui.prompt && !(ui.peek && !ui.peek.closing) && !rt.busy();
  };
  // (A real press only, as the theme's actions take: ui/render.ts View.listen.)
  const trusted = (e: Event) => view.options.trustedOnly === false || e.isTrusted;

  rt.listen(container, 'mousedown', (e: MouseEvent) => {
    if (e.detail <= 1) first = null;
    if (e.button !== 0 || MODIFIERS(e) || e.detail !== 1 || !trusted(e) || !view.owns(e.target)) return;
    first = nothingOpen() && isEmpty(view, e.target) ? { target: e.target } : null;
  });

  rt.listen(container, 'dblclick', (e: MouseEvent) => {
    const was = first;
    first = null;
    if (!was || e.button !== 0 || MODIFIERS(e) || !trusted(e) || !view.owns(e.target)) return;
    // (Both clicks empty: the first one's point still drawn and still empty, the second's too; nothing opened since.)
    if (!(was.target instanceof Element) || !was.target.isConnected || !isEmpty(view, was.target) || !isEmpty(view, e.target)) return;
    if (!nothingOpen() || rt.behaviors.drag?.justDropped?.()) return;
    rt.openPaletteAsKey('a double-click on the sidebar');
  });

  return {
    busy: () => false,
  };
}
