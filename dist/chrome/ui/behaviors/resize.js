// The sidebar's width, dragged (Arcadia's resizer, themes/arcadia/
// sidebar.js): `m-resize="sidebar"` marks the handle. The width is the
// theme's own setting `sidebarWidth` (theme.json `settings`, a `number` of
// px or a `length` in px; the theme's CSS reads it as
// `var(--m-sidebar-width)`), kept within theme.json's layout hints
// `sidebarMin`…`sidebarMax` (and the setting's own min and max). While
// dragging, the width is shown at once (the settings' sheet) and the page's
// new place is reported as it moves (ui/render.js onLayout); let go, it
// snaps to the setting's `step` (1 px by default) and is saved through the
// theme's settings (`updateThemeSettings`, as today). Double-click: back to
// the default. The handle has the class `m-resizing` while dragged, and so
// does the theme's root. The sidebar grows toward the page: rightward for a
// theme whose sidebar reveals from the left (theme.json `layout.reveal`),
// leftward from the right.

const SETTING = 'sidebarWidth';

/** @param {any} rt */
export function installResize(rt) {
  const { view, theme } = rt;
  /** @type {{ el: Element, pointerId: number, startX: number, start: number, width: number } | null} */
  let drag = null;
  let warned = false;

  const spec = () => theme.manifest?.settings?.[SETTING] ?? null;
  const px = (v) => (typeof v === 'number' ? v : parseFloat(String(v ?? '')));
  const bounds = () => {
    const s = spec();
    const layout = theme.manifest?.layout ?? {};
    const lo = Math.max(layout.sidebarMin ?? -Infinity, s?.min ?? -Infinity, 0);
    const hi = Math.min(layout.sidebarMax ?? Infinity, s?.max ?? Infinity);
    const fallback = layout.sidebarDefault ?? px(s?.default);
    return { lo, hi: Number.isFinite(hi) ? hi : Math.max(lo, fallback), def: Number.isFinite(fallback) ? fallback : lo, step: s?.step > 0 ? s.step : 1 };
  };
  const clamp = (w) => { const { lo, hi } = bounds(); return Math.min(hi, Math.max(lo, w)); };
  const snap = (w) => { const { step } = bounds(); return clamp(Math.round(w / step) * step); };
  const value = (w) => (spec()?.type === 'length' ? `${w}px` : w);
  // The width now: the setting as the theme gets it (saved, else its default).
  const current = () => { const w = px(rt.vm?.settings?.[SETTING]); return Number.isFinite(w) ? w : bounds().def; };
  const usable = () => {
    if (spec()) return true;
    if (!warned) { warned = true; rt.warn(`m-resize="sidebar": the theme has no ${SETTING} setting`); }
    return false;
  };
  // Which way a drag grows it: toward the page.
  const sign = () => (theme.manifest?.layout?.reveal === 'right' ? -1 : 1);

  const save = (w) => {
    rt.setThemeSettings({ [SETTING]: value(w) });
    void rt.host.send('updateThemeSettings', { themeId: theme.id, patch: { [SETTING]: value(w) } });
  };

  rt.listen(rt.container, 'pointerdown', (/** @type {PointerEvent} */ e) => {
    if (e.button !== 0 || drag) return;
    const hit = view.behaviorAt(e.target, 'm-resize', 'sidebar');
    if (!hit || !usable()) return;
    e.preventDefault();
    e.stopPropagation();
    try { hit.el.setPointerCapture(e.pointerId); } catch {}
    const start = current();
    drag = { el: hit.el, pointerId: e.pointerId, startX: e.clientX, start, width: start };
    hit.el.classList.add('m-resizing');
    view.rootElement()?.classList.add('m-resizing');
  }, true);
  rt.listen(rt.container, 'pointermove', (/** @type {PointerEvent} */ e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const width = clamp(drag.start + (e.clientX - drag.startX) * sign());
    if (width === drag.width) return;
    drag.width = width;
    rt.setThemeSettings({ [SETTING]: value(width) }, { live: true });
    view.scheduleLayout();
  });
  const end = (/** @type {PointerEvent} */ e) => {
    if (!drag || (e?.pointerId != null && e.pointerId !== drag.pointerId)) return;
    const { el, width } = drag;
    drag = null;
    el.classList.remove('m-resizing');
    view.rootElement()?.classList.remove('m-resizing');
    try { el.releasePointerCapture(e.pointerId); } catch {}
    save(snap(width));
    view.scheduleLayout();
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) rt.listen(rt.container, type, end);
  rt.listen(rt.container, 'dblclick', (/** @type {MouseEvent} */ e) => {
    if (!view.behaviorAt(e.target, 'm-resize', 'sidebar') || !usable()) return;
    e.stopPropagation();
    save(snap(bounds().def));
    view.scheduleLayout();
  });

  return {
    busy: () => drag != null,
    /** The width now, in px (live while dragged). */
    width: () => (drag ? drag.width : current()),
  };
}
