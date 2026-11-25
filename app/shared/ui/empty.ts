// What's an empty part of the theme (docs/SIDEBAR-PRESS.md "The double-click's rule"): where a double-click opens the
// command palette, as Arc's sidebar does (ui/behaviors/empty.ts). Shared by every theme and every host: nothing here
// is a theme's own choice but `m-empty="never"`, which only ever makes less of a theme empty.
//
// A point is empty when the element under it, and every element up to the theme's root:
// - is none of Margin's slots (the page, its loader, the palette, a menu, the space editor, a notice, a prompt, the
//   toast, the preview card, the launcher, Settings, the window's buttons, a drag region);
// - isn't marked `m-empty="never"` by the theme;
// and, up to the nearest one that holds a control or a row:
// - runs no action and has none of Margin's handles (a row's drag, the sidebar's resize, a rename, a field, the hover
//   zone);
// - is no control (a link, a button, a field, a label, anything editable, focusable, draggable, or with an interactive
//   role);
// - is no row of any of the theme's lists (an <m-for>'s item: a tab, a pin, a folder, a favourite, a space's chip);
// - is no bar: an element two or more of whose children are controls or rows side by side (their boxes on one line),
//   as a space switcher, a header of buttons, a favourites grid or a mini player: its gaps are its own;
// and that nearest one is the sidebar's own: its column (`m-swipe`) or a list (`m-scroll`, `m-drop`), never a widget
// (a mini player's background, the space's title beside its name) nor the frame around the page card.
import type { View } from './render.ts';

// Margin's slots and parts: never empty, whatever's in them.
const SLOTS = new Set(['m-page', 'm-page-loader', 'm-palette', 'm-menu', 'm-editor', 'm-notice', 'm-prompt', 'm-toast', 'm-preview',
  'm-preview-page', 'm-launcher', 'm-settings', 'm-window-controls', 'm-drag-region', 'm-pane', 'm-divider']);
// Margin's handles (behaviours that are something to press), kept on the element as the theme wrote them.
const HANDLES = ['m-drag', 'm-resize', 'm-rename', 'm-input', 'm-peek'];
// The interactive ARIA roles (WAI-ARIA's widget roles a press does something on).
const ROLES = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'checkbox', 'switch', 'tab',
  'slider', 'spinbutton', 'textbox', 'searchbox', 'combobox', 'scrollbar', 'treeitem', 'gridcell']);
const CONTROL_TAGS = new Set(['a', 'button', 'input', 'textarea', 'select', 'label', 'summary', 'details', 'iframe']);

/** Whether an element is a control of its own: a press on it does something. */
export function isControl(view: View, el: Element): boolean {
  if (CONTROL_TAGS.has(el.localName)) return true;
  if (view.actionOf(el)) return true;
  const role = el.getAttribute('role');
  if (role && ROLES.has(role)) return true;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex != null && !/^\s*-/.test(tabindex)) return true;
  if (el.getAttribute('draggable') === 'true') return true;
  const editable = el.getAttribute('contenteditable');
  if (editable != null && editable !== 'false') return true;
  return HANDLES.some((h) => el.hasAttribute(h));
}

// A bar: two or more of its children controls or rows (by themselves, not what they hold), side by side. The edge
// handles a theme stretches the whole height (the resize handle, the hover zone) and the drag regions never count:
// they lie beside everything.
const EDGES = ['m-resize', 'm-peek'];
function isBar(view: View, el: Element, rows: Set<Element>): boolean {
  const boxes: DOMRect[] = [];
  for (const child of el.children) {
    if (child.localName === 'm-drag-region' || EDGES.some((h) => child.hasAttribute(h))) continue;
    if (!rows.has(child) && !isControl(view, child)) continue;
    const r = child.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    for (const b of boxes) if (r.top < b.bottom && b.top < r.bottom && (r.right <= b.left || b.right <= r.left)) return true;
    boxes.push(r);
  }
  return false;
}

// Where the sidebar's own empty space is: its column (the space's part a swipe moves, `m-swipe`) and its lists (a
// scrolling list, `m-scroll`; where rows land, `m-drop`: the room below a list's last row).
const SURFACES = ['m-swipe', 'm-scroll', 'm-drop'];
const CONTROLS = 'a, button, input, textarea, select, label, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex^="-"]), [draggable="true"], '
  + `${HANDLES.map((h) => `[${h}]`).join(', ')}, ${[...ROLES].map((r) => `[role="${r}"]`).join(', ')}`;
// Whether an element holds a control or a row (anything a press does something on).
function holds(el: Element, rows: Set<Element>): boolean {
  if (el.querySelector(CONTROLS)) return true;
  for (const r of rows) if (el.contains(r)) return true;
  return false;
}

/**
 * Whether `target` (an element the theme drew: an event's target, or what's under a point) is an empty part of it.
 * Walking up from it: nothing on the way a slot, a row, a control, a bar or marked `m-empty="never"`; and the nearest
 * element that holds a control or a row is one of the sidebar's own surfaces (its column, `m-swipe`, or a list,
 * `m-scroll` or `m-drop`): a widget's background (a mini player's, the space's title beside its name), the frame
 * around the page card and anything outside the sidebar aren't. Nothing outside the theme's root is empty.
 */
export function isEmpty(view: View, target: EventTarget | null): boolean {
  const root = view.rootElement();
  if (!root || !(target instanceof Element) || !view.owns(target)) return false;
  const rows = view.rowNodes();
  let surface = false; // the nearest holder found, and one of the sidebar's surfaces
  for (let el: Element | null = target; el; el = el === root ? null : el.parentElement) {
    // (A slot or a mark anywhere up to the root: never empty, whatever's below it.)
    if (SLOTS.has(el.localName) || view.behaviorOf(el)?.attrs['m-empty'] === 'never') return false;
    if (surface) continue;
    if (rows.has(el) || isControl(view, el) || isBar(view, el, rows)) return false;
    if (holds(el, rows)) {
      if (!SURFACES.some((s) => el!.hasAttribute(s))) return false;
      surface = true;
    }
  }
  return surface;
}

/**
 * An empty point of the sidebar, scanning from its bottom up at three places across it (the dev hook's `say: spot`,
 * the tests'), in the document's coordinates; null: none. `doc`: where the theme draws (its container's
 * `elementFromPoint`: a shadow root's own).
 */
export function emptySpot(view: View, container: { elementFromPoint(x: number, y: number): Element | null }, height: number): { x: number, y: number } | null {
  const page = view.rootElement()?.querySelector('m-page')?.getBoundingClientRect();
  if (!page || page.left < 40) return null;
  for (const x of [page.left / 2, page.left * 0.3, page.left * 0.7]) {
    for (let y = height - 90; y > 90; y -= 12) {
      const el = container.elementFromPoint(x, y);
      if (el && isEmpty(view, el)) return { x: Math.round(x), y: Math.round(y) };
    }
  }
  return null;
}
