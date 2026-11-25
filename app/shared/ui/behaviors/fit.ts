// Whether a bar's items fit (M2.10, docs/ARC-SIDEBAR.md "The space switcher"): `m-fit="items"` marks the bar, and
// Margin sets `m-crowded` on it while its items, laid out without it (the theme's roomy rules: Arcadia gives each space
// at least 24 pt, as Arc does), would overflow its width. The theme draws the crowded bar its own way (Arcadia, as
// Arc: the space in front's icon, the others as dots).
// - Read with `m-crowded` taken off for the measurement and put back at once, in the same task: nothing is painted in
//   between, so the bar never shows its roomy layout while it's crowded.
// - Read when the bar is first drawn, when its items change (spaces came or went, one renamed or switched to: what's
//   in it changed, a MutationObserver's word, before anything is painted) and when its size changes (the sidebar
//   resized, the window: a ResizeObserver's). Never for a drawing that left the bar as it was (2026-11-25: read after
//   every drawing, a crowded bar's measurement laid the sidebar out twice each time, 3–5× a drawing's cost, and took
//   the theme's hover rules off and on, restarting the dot's tooltip delay under the pointer).
// - A bar that's not laid out (hidden: no width) is never crowded.
import type { Rt } from '../runtime.ts';

/** The bar's items overflow it laid out roomy (the caller took `m-crowded` off). */
export function overflows(el: { scrollWidth: number, clientWidth: number }): boolean {
  return el.clientWidth > 0 && el.scrollWidth > el.clientWidth;
}

const BAR = '[m-fit="items"]';

export function installFit(rt: Rt) {
  const watched = new Set<HTMLElement>();
  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => { for (const e of entries) check(e.target as HTMLElement); })
    : null;
  // (Its own `m-crowded` set or taken away: not a change of its items.)
  const mo = typeof MutationObserver === 'function'
    ? new MutationObserver((records) => {
      const bars = new Set<HTMLElement>();
      for (const r of records) {
        if (r.type === 'attributes' && r.attributeName === 'm-crowded' && watched.has(r.target as HTMLElement)) continue;
        const at = r.target.nodeType === 1 ? r.target as Element : r.target.parentElement;
        const bar = at?.closest(BAR) as HTMLElement | null;
        if (bar && watched.has(bar)) bars.add(bar);
      }
      for (const bar of bars) check(bar);
    })
    : null;

  function check(el: HTMLElement) {
    if (!el.isConnected) return;
    const was = el.hasAttribute('m-crowded');
    if (was) el.removeAttribute('m-crowded');
    if (overflows(el)) el.setAttribute('m-crowded', '');
  }

  return {
    afterRender() {
      // (Bars no longer drawn (another theme): no longer watched.)
      for (const el of watched) if (!el.isConnected) { ro?.unobserve(el); watched.delete(el); }
      for (const el of rt.view.marked('m-fit', 'items') as HTMLElement[]) {
        if (watched.has(el)) { if (!mo) check(el); continue; }
        watched.add(el);
        ro?.observe(el);
        mo?.observe(el, { childList: true, subtree: true, attributes: true, characterData: true });
        check(el);
      }
    },
    /** Checked again now (a test's resize, without waiting for the observer). */
    check() { for (const el of rt.view.marked('m-fit', 'items') as HTMLElement[]) check(el); },
    busy: () => false,
    destroy() { ro?.disconnect(); mo?.disconnect(); watched.clear(); },
  };
}
