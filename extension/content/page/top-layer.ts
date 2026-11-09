// Dialogs and popovers for the box. The top layer ignores <html>'s transform, so
// these sit against the window: a page's `left: 0` lands under the sidebar, and
// a page placing a popover from the box's coordinates misses by the box's corner.
//
// Each is moved as it opens, by what makes it sit against the box as it would
// against a window, with `translate` so the page keeps its own placing: left
// and top a script writes later, its own translate (composed, not replaced). What
// it asked for is read as computed values (`auto`, percentages), which
// getComputedStyle doesn't give. Anchor-positioned ones are right as they are.
import type { Box } from './box.ts';

const OPEN = ':modal:not(:fullscreen), :popover-open';

export function startTopLayer(box: Box) {
  /** Open elements moved, with their own style attribute's translate. */
  const placed: Map<HTMLElement, { value: string, priority: string }> = new Map();

  const isAuto = (value: unknown) => String(value) === 'auto';
  const isAnchored = (value: unknown) => /anchor/.test(String(value));
  // How much of a length is a percentage, as a fraction: of the window, here.
  const fraction = (value: unknown) => Number(/(-?[\d.]+)%/.exec(String(value))?.[1] ?? 0) / 100;

  // The move along one side's axis: `near` and `far` are the box's edges from
  // the window's, `lost` how much smaller than the window it is.
  function shift(map: StylePropertyMapReadOnly, startName: string, endName: string, marginName: string, near: number, far: number, lost: number) {
    const start = map.get(startName);
    const end = map.get(endName);
    if (isAnchored(start) || isAnchored(end)) return null;
    if (isAuto(start) && !isAuto(end)) return fraction(end) * lost - far;
    if (!isAuto(start) && !isAuto(end) && isAuto(map.get(marginName))) return (near - far) / 2; // centred
    return near - fraction(start) * lost;
  }

  function unplace(element: HTMLElement) {
    const own = placed.get(element);
    if (!own) return;
    placed.delete(element);
    if (own.value) element.style.setProperty('translate', own.value, own.priority);
    else element.style.removeProperty('translate');
  }

  function place(element: HTMLElement) {
    unplace(element);
    if (!box.boxed() || element.localName.startsWith('margin-') || !element.matches(OPEN)) return;
    const map = element.computedStyleMap();
    const style = getComputedStyle(element);
    if ((style as any).positionAnchor && !/^(auto|none|normal)?$/.test((style as any).positionAnchor)) return;
    const x = shift(map, 'left', 'right', 'margin-left', box.left, box.right, box.dw);
    const y = shift(map, 'top', 'bottom', 'margin-top', box.top, box.bottom, box.dh);
    if (x == null || y == null) return;
    const [ownX = '0px', ownY = '0px', ownZ = ''] = style.translate === 'none' ? [] : style.translate.split(' ');
    placed.set(element, { value: element.style.getPropertyValue('translate'), priority: element.style.getPropertyPriority('translate') });
    element.style.setProperty('translate', `calc(${ownX} + ${x}px) calc(${ownY} + ${y}px) ${ownZ}`.trim(), 'important');
  }

  // The ways in by script are the page's own calls; the rest (popovertarget, an
  // invoker) are seen as they toggle, in the frame before they're painted.
  const wrap = (proto: HTMLDialogElement | HTMLElement, name: string) => {
    const native = (proto as Record<string, any> | undefined)?.[name]; // (by name: the browser's own, wrapped)
    if (!native) return;
    (proto as Record<string, any>)[name] = function (this: HTMLElement, ...args: any[]) {
      const result = native.apply(this, args);
      place(this);
      return result;
    };
  };
  wrap(window.HTMLDialogElement?.prototype, 'showModal');
  wrap(HTMLElement.prototype, 'showPopover');
  wrap(HTMLElement.prototype, 'togglePopover');
  const target = (event: ToggleEvent | Event) => (event.target as HTMLElement); // (a dialog's or popover's)
  addEventListener('beforetoggle', (event) => {
    if ((event as any).newState === 'open') requestAnimationFrame(() => place(target(event)));
  }, true);
  addEventListener('toggle', (event) => {
    if ((event as any).newState === 'open') place(target(event));
    else unplace(target(event));
  }, true);
  addEventListener('close', (event) => unplace(target(event)), true);

  // The box moved under what's open.
  const again = () => { for (const element of [...placed.keys()]) place(element); };
  box.onMove.push(again);
  box.onRest.push(again);
}
