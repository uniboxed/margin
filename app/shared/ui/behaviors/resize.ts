// The sidebar's width, dragged (Arcadia's resizer, themes/arcadia/
// sidebar.js): `m-resize="sidebar"` marks the handle. The width is the
// theme's own setting `sidebarWidth` (theme.json `settings`, a `number` of
// px or a `length` in px; the theme's CSS reads it as
// `var(--m-sidebar-width)`), kept within theme.json's layout hints
// `sidebarMin`…`sidebarMax` (and the setting's own min and max). While
// dragging, the width is shown at once (the settings' sheet) and the page's
// new place is reported as it moves (ui/render.ts onLayout); let go, it
// snaps to the setting's `step` (1 px by default) and is saved through the
// theme's settings (`updateThemeSettings`, as today). Double-click: back to
// the default. The handle has the class `m-resizing` while dragged, and so
// does the theme's root. The sidebar grows toward the page: rightward for a
// theme whose sidebar reveals from the left (theme.json `layout.reveal`),
// leftward from the right.
//
// Never past the page area's floor: the host's `pageMinWidth` (Margin.app: the hosted window's own minimum width,
// ui/host-app.ts; none elsewhere): the page area isn't dragged narrower than that, as Split View's divider stops at a
// window's minimum. The page shrinks by what the sidebar grows (its far edge stays), so the widest the sidebar gets in
// a drag is its width at the press plus what the page area had above the floor then (none left: it doesn't grow at
// all); read at each move (a floor said mid-drag holds from the next), only a comparison per move. A reset to the
// default stops there too.
//
// The host hears when a width change begins and when it's over
// (`perform('sidebar.resizing', { on })`, once each per drag or reset: the
// first change of the width, and the end, after the page's last place was
// measured and reported). Margin.app's window hosting another app's window
// above its page area holds that window's placing until then (a full-screen
// one is placed again only once: app/platforms/macos/shell/HostedSession.swift
// sidebarResizing); other hosts ignore it. Not while Margin's window is a tile
// beside a hosted one (the host marks the theme's root `m-sidebar-fixed`,
// which hides the handle too: ui/host-app.ts sidebarFixed).
import type { Rt } from '../runtime.ts';

const SETTING = 'sidebarWidth';

export function installResize(rt: Rt) {
  const { view, theme } = rt;
  let drag: { el: Element, pointerId: number, startX: number, start: number, width: number, k: number, told: boolean, page: number | null } | null = null;
  let warned = false;

  const spec = () => theme.manifest?.settings?.[SETTING] ?? null;
  const px = (v: unknown) => (typeof v === 'number' ? v : parseFloat(String(v ?? '')));
  const bounds = () => {
    const s = spec();
    const layout = theme.manifest?.layout ?? {};
    const lo = Math.max(layout.sidebarMin ?? -Infinity, s?.min ?? -Infinity, 0);
    const hi = Math.min(layout.sidebarMax ?? Infinity, s?.max ?? Infinity);
    const fallback = layout.sidebarDefault ?? px(s?.default);
    return { lo, hi: Number.isFinite(hi) ? hi : Math.max(lo, fallback), def: Number.isFinite(fallback) ? fallback : lo, step: s?.step > 0 ? s.step : 1 };
  };
  const clamp = (w: number) => { const { lo, hi } = bounds(); return Math.min(hi, Math.max(lo, w)); };
  const snap = (w: number) => { const { step } = bounds(); return clamp(Math.round(w / step) * step); };
  const value = (w: number) => (spec()?.type === 'length' ? `${w}px` : w);
  // The width now: the setting as the theme gets it (saved, else its default).
  const current = () => { const w = px(rt.vm?.settings?.[SETTING]); return Number.isFinite(w) ? w : bounds().def; };
  const usable = () => {
    if (rt.vm?.window.pageOutside || view.rootElement()?.hasAttribute?.('m-sidebar-fixed')) return false;
    if (spec()) return true;
    if (!warned) { warned = true; rt.warn(`m-resize="sidebar": the theme has no ${SETTING} setting`); }
    return false;
  };
  // Which way a drag grows it: toward the page.
  const sign = () => (theme.manifest?.layout?.reveal === 'right' ? -1 : 1);
  // The page area's width now, in Margin's px, from the host's last layout (null: none reported).
  const pageWidth = () => {
    const g = rt.host?.layout;
    if (!g?.container || !g.insets) return null;
    const w = g.container.width - g.insets.left - g.insets.right;
    return Number.isFinite(w) && w > 0 ? w : null;
  };
  // The widest the sidebar may be for a width `from` with the page area `page` wide: Infinity with no floor.
  const widest = (from: number, page: number | null) => {
    // (A split shown side by side: its panes' floors and gaps too, behaviors/split.ts.)
    const floor = Math.max(rt.host?.pageMinWidth ?? 0, rt.behaviors?.split?.floor?.() ?? 0);
    if (!(floor > 0) || page == null) return Infinity;
    return from + Math.max(0, page - floor);
  };

  const save = (w: number) => {
    rt.setThemeSettings({ [SETTING]: value(w) });
    void rt.host.send('updateThemeSettings', { themeId: theme.id, patch: { [SETTING]: value(w) } });
  };
  // The host told a change of the width began, or is over: over only after the page's place at the last width was
  // measured and reported (now, not at the next frame), so what the host does then is done once, for that place.
  const tell = (on: boolean) => {
    if (!on) view.flushLayout?.();
    rt.host.perform?.('sidebar.resizing', { on });
  };

  rt.listen(rt.container, 'pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 || drag) return;
    const hit = view.behaviorAt(e.target, 'm-resize', 'sidebar');
    if (!hit || !usable()) return;
    e.preventDefault();
    e.stopPropagation();
    try { hit.el.setPointerCapture(e.pointerId); } catch {}
    const start = current();
    // The pointer moves in the page's pixels, the width is Margin's (rt.scale).
    drag = { el: hit.el, pointerId: e.pointerId, startX: e.clientX, start, width: start, k: rt.scale?.() || 1, told: false, page: pageWidth() };
    hit.el.classList.add('m-resizing');
    view.rootElement()?.classList.add('m-resizing');
  }, true);
  rt.listen(rt.container, 'pointermove', (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const width = Math.min(clamp(drag.start + (e.clientX - drag.startX) * drag.k * sign()), widest(drag.start, drag.page));
    if (width === drag.width) return;
    drag.width = width;
    if (!drag.told) { drag.told = true; tell(true); }
    rt.setThemeSettings({ [SETTING]: value(width) }, { live: true });
    view.scheduleLayout();
  });
  const end = (e: PointerEvent) => {
    if (!drag || (e?.pointerId != null && e.pointerId !== drag.pointerId)) return;
    const { el, width, told, start, page } = drag;
    drag = null;
    el.classList.remove('m-resizing');
    view.rootElement()?.classList.remove('m-resizing');
    try { el.releasePointerCapture(e.pointerId); } catch {}
    // (Its step never past the floor: a snap up that would cross it stays where the drag stopped.)
    save(Math.min(snap(width), Math.max(width, widest(start, page))));
    view.scheduleLayout();
    if (told) tell(false);
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) rt.listen(rt.container, type, end);
  rt.listen(rt.container, 'dblclick', (e: MouseEvent) => {
    if (!view.behaviorAt(e.target, 'm-resize', 'sidebar') || !usable()) return;
    e.stopPropagation();
    const now = current();
    const def = Math.min(snap(bounds().def), widest(now, pageWidth()));
    // (One change, begun and over at once: nothing to tell when the width is the default's already.)
    const changes = def !== now;
    if (changes) tell(true);
    save(def);
    view.scheduleLayout();
    if (changes) tell(false);
  });

  return {
    busy: () => drag != null,
    /** The width now, in px (live while dragged). */
    width: () => (drag ? drag.width : current()),
  };
}
