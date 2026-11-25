// Whether a bar's items fit (M2.10, docs/ARC-SIDEBAR.md "The space switcher"): `m-fit="items"` marks the bar, and
// Margin sets `m-crowded` on it while its items, laid out without it (the theme's roomy rules: Arcadia gives each space
// at least 24 pt, as Arc does), would overflow its width. The theme draws the crowded bar its own way (Arcadia, as
// Arc: the space in front's icon, the others as dots).
// - Read with `m-crowded` taken off for the measurement and put back at once, in the same task: nothing is painted in
//   between, so the bar never shows its roomy layout while it's crowded.
// - Read after every render (spaces came or went, a theme was drawn) and whenever the bar's size changes (the sidebar
//   resized, the window).
// - A bar that's not laid out (hidden: no width) is never crowded.
import type { Rt } from '../runtime.ts';

/** The bar's items overflow it laid out roomy (the caller took `m-crowded` off). */
export function overflows(el: { scrollWidth: number, clientWidth: number }): boolean {
  return el.clientWidth > 0 && el.scrollWidth > el.clientWidth;
}

export function installFit(rt: Rt) {
  const watched = new WeakSet<Element>();
  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => { for (const e of entries) check(e.target as HTMLElement); })
    : null;

  function check(el: HTMLElement) {
    if (!el.isConnected) return;
    const was = el.hasAttribute('m-crowded');
    if (was) el.removeAttribute('m-crowded');
    if (overflows(el)) el.setAttribute('m-crowded', '');
  }

  return {
    afterRender() {
      for (const el of rt.view.marked('m-fit', 'items') as HTMLElement[]) {
        if (ro && !watched.has(el)) { watched.add(el); ro.observe(el); }
        check(el);
      }
    },
    /** Checked again now (a test's resize, without waiting for the observer). */
    check() { for (const el of rt.view.marked('m-fit', 'items') as HTMLElement[]) check(el); },
    busy: () => false,
    destroy() { ro?.disconnect(); },
  };
}
