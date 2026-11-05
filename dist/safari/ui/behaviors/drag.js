// Drag and drop (themes/arcadia/sidebar.js, "drag and drop (Arc)"), with the
// pointer's own events (not the browser's drag and drop, which can't animate
// the drop): `m-drag="tab|pin|folder"` marks a row that drags (its item is
// the innermost <m-for>'s), `m-drop="tabs|pins|folder|space"` where rows go
// (the tabs, the pinned area, a folder, a space's chip). Pressed and moved
// DRAG_START_PX, the row stays where it is (class `m-dragging`, the theme's
// root `m-dragging` and `m-drag-<kind>`) and a copy of it (`m-drag-ghost`)
// follows the pointer; where it would go is marked with `m-drop-before`,
// `m-drop-after` (a row), `m-drop-into` (a folder, a chip, the tabs for a pin
// to unpin) or `m-drop-end` (the pinned area's end). The rules are today's
// (ui/behaviors/drop-rules.js); a drop runs the checked action for it, which
// sends moveTab, movePin, moveFolder, moveTabToSpace, pinTab or unpin. Let
// go, the copy waits for the list's new order and glides into the row's new
// place (`m-landing` on it until it's there); nowhere to go, Escape, or the
// page left, it glides back. Near the list's top or bottom edge, the list
// (`m-scroll="tabs"`) scrolls. A tab drags here once it's the one in front
// (a press on another switches to it in a page: that page is on its way out).
import { dropAction, dropTarget } from './drop-rules.js';

export const DRAG_START_PX = 4;
const GLIDE_MS = 300;
const FADE_MS = 180;
const LAND_WAIT_MS = 1200; // the new order not here by then: back where it was
const EDGE_PX = 36; // the list scrolls with the pointer this close to its edge
const MARKS = ['m-drop-before', 'm-drop-after', 'm-drop-into', 'm-drop-end'];

/** @param {any} rt */
export function installDrag(rt) {
  const { view, doc, container, win } = rt;
  /** @type {{ kind: string, id: any, el: Element, pointerId: number, x: number, y: number } | null} */
  let pending = null; // pressed, not moved far enough yet
  /** @type {any} */
  let dragging = null;
  /** @type {any} */
  let landing = null;
  let droppedAt = -Infinity;
  let scrolling = 0;
  /** @type {Set<Element>} */
  const marked = new Set();

  const reduced = () => !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const kindOf = (el) => view.behaviorOf(el)?.attrs['m-drag'];
  const rowOf = (el) => {
    const kind = kindOf(el);
    const id = view.subjectOf(el)?.id;
    return kind && id != null ? { kind, id } : null;
  };
  // A row's element by what it shows.
  const rowEl = (kind, id) => view.marked('m-drag', kind).find((el) => view.subjectOf(el)?.id === id && !el.classList.contains('m-drag-ghost')) ?? null;
  const folderEl = (id) => rowEl('folder', id) ?? view.marked('m-drop', 'folder').find((el) => view.subjectOf(el)?.id === id) ?? null;
  const lastPinOf = (folderId) => view.marked('m-drag', 'pin').filter((el) => view.subjectOf(el)?.folderId === folderId).at(-1) ?? null;
  const order = () => view.marked('m-drag').map((el) => `${kindOf(el)}:${view.subjectOf(el)?.id}`).join(' ');
  const clearMarks = () => { for (const el of marked) el.classList.remove(...MARKS); marked.clear(); };
  const mark = (el, cls) => { if (!el) return; el.classList.add(cls); marked.add(el); };

  rt.listen(container, 'pointerdown', (/** @type {PointerEvent} */ e) => {
    pending = null;
    if (e.button !== 0 || e.ctrlKey || !e.isPrimary || dragging || landing) return;
    if (rt.behaviors.rename?.active() || rt.behaviors.press?.away()) return;
    const target = /** @type {Element} */ (e.target);
    if (!view.owns(target) || target.closest?.('input, [contenteditable]')) return;
    const hit = view.behaviorAt(target, 'm-drag');
    if (!hit) return;
    const row = rowOf(hit.el);
    if (!row || row.kind === 'space') return; // spaces don't move (no handler for it)
    // A control in the row (its close button): not a drag.
    const action = view.actionAt(target);
    if (action && action.el !== hit.el && hit.el.contains(action.el)) return;
    pending = { ...row, el: hit.el, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
  });
  rt.listen(container, 'pointermove', (/** @type {PointerEvent} */ e) => {
    // No button down any more: its release went elsewhere.
    if (dragging && e.pointerId === dragging.pointerId) { if (e.buttons & 1) move(e.clientX, e.clientY); else cancel(); return; }
    if (!pending || e.pointerId !== pending.pointerId) return;
    if (!(e.buttons & 1)) { pending = null; return; }
    if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < DRAG_START_PX) return;
    start(e);
  });
  rt.listen(container, 'pointerup', (/** @type {PointerEvent} */ e) => {
    if (dragging && e.pointerId === dragging.pointerId) drop(e.clientX, e.clientY);
    pending = null;
  });
  rt.listen(container, 'pointercancel', () => { pending = null; if (dragging) cancel(); });
  rt.listen(container, 'lostpointercapture', () => { if (dragging) cancel(); });
  // The page hidden or left mid-drag (a key switching tabs, ⌘Tab): over.
  const dropEverything = () => { pending = null; if (dragging) cancel(); };
  rt.listen(doc, 'visibilitychange', () => { if (doc.hidden) dropEverything(); });
  rt.listen(win, 'blur', dropEverything);
  rt.listen(win, 'pagehide', dropEverything);
  rt.listen(doc, 'keydown', (/** @type {KeyboardEvent} */ e) => {
    if (dragging && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
  }, true);

  function start(/** @type {PointerEvent} */ e) {
    const from = pending;
    pending = null;
    if (!from) return;
    const el = from.el.isConnected ? from.el : rowEl(from.kind, from.id); // drawn again meanwhile
    if (!el?.parentNode) return;
    const box = el.getBoundingClientRect();
    const ghost = /** @type {HTMLElement} */ (el.cloneNode(true));
    ghost.classList.remove('m-pressed', 'm-dragging', 'm-landing', ...MARKS);
    ghost.classList.add('m-drag-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    for (const n of [ghost, ...ghost.querySelectorAll('[id]')]) n.removeAttribute('id');
    Object.assign(ghost.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    el.parentNode.appendChild(ghost);
    el.classList.remove('m-pressed');
    el.classList.add('m-dragging');
    const root = view.rootElement();
    root?.classList.add('m-dragging', `m-drag-${from.kind}`);
    dragging = { kind: from.kind, id: from.id, el, pointerId: from.pointerId, ghost, x0: from.x, y0: from.y, x: e.clientX, y: e.clientY, where: null, over: null };
    // Its moves and its release come here wherever the pointer goes (and
    // the click after it lands on the theme's root: no row's action).
    try { root?.setPointerCapture(from.pointerId); } catch {}
    move(e.clientX, e.clientY);
  }

  // What's under the pointer, for the rules (drop-rules.js Over), with the
  // elements to mark.
  function overAt(x, y) {
    const under = /** @type {Element | null} */ (/** @type {any} */ (container).elementFromPoint(x, y));
    if (!under || !view.owns(under)) return null;
    const chip = view.behaviorAt(under, 'm-drop', 'space');
    if (chip) {
      const s = view.subjectOf(chip.el);
      return s?.id != null ? { zone: 'space', spaceId: s.id, el: chip.el } : null;
    }
    const tabs = view.behaviorAt(under, 'm-drop', 'tabs');
    if (tabs) {
      const rows = view.marked('m-drag', 'tab').filter((r) => tabs.el.contains(r));
      const own = view.behaviorAt(under, 'm-drag', 'tab')?.el;
      // The gap between rows, or below the last one: the nearest.
      const row = own && rows.includes(own) ? own : rows.find((r) => y <= r.getBoundingClientRect().bottom + 2.5) ?? rows.at(-1) ?? null;
      const box = row?.getBoundingClientRect();
      return { zone: 'tabs', rows: rows.map((r) => view.subjectOf(r)?.id), tab: row ? view.subjectOf(row)?.id ?? null : null, y: box ? (y - box.top) / (box.height || 1) : 0, el: tabs.el, rowEl: row };
    }
    const pins = view.behaviorAt(under, 'm-drop', 'pins');
    const folderZone = view.behaviorAt(under, 'm-drop', 'folder');
    if (pins) {
      const rows = view.marked('m-drag').filter((r) => (kindOf(r) === 'pin' || kindOf(r) === 'folder') && pins.el.contains(r));
      const own = view.behaviorAt(under, 'm-drag')?.el;
      let row = own && rows.includes(own) ? own : null;
      // In a folder, but on none of its rows: into it.
      if (!row && folderZone && pins.el.contains(folderZone.el)) {
        const f = view.subjectOf(folderZone.el);
        if (f?.id != null) return { zone: 'folder', folder: f.id, el: folderZone.el };
      }
      // The gap between rows: the row below (so before it); below the last: the end.
      row ??= rows.find((r) => y <= r.getBoundingClientRect().bottom + 2.5) ?? null;
      if (!row) return { zone: 'pins', row: null, y: 0, el: pins.el };
      const item = view.subjectOf(row);
      const kind = kindOf(row);
      const box = row.getBoundingClientRect();
      return { zone: 'pins', row: { kind, id: item.id, folder: kind === 'pin' ? item.folderId ?? null : null }, y: (y - box.top) / (box.height || 1), el: pins.el, rowEl: row };
    }
    if (folderZone) {
      const f = view.subjectOf(folderZone.el);
      if (f?.id != null) return { zone: 'folder', folder: f.id, el: folderZone.el };
    }
    return null;
  }

  function move(x, y) {
    const d = dragging;
    if (!d) return;
    d.x = x;
    d.y = y;
    d.ghost.style.transform = `translate(${x - d.x0}px, ${y - d.y0}px)`;
    const over = overAt(x, y);
    const where = dropTarget({ kind: d.kind, id: d.id }, /** @type {any} */ (over), rt.vm?.space);
    d.over = over;
    d.where = where;
    clearMarks();
    const w = /** @type {any} */ (where);
    if (w?.space || w?.unpin) mark(over.el, 'm-drop-into');
    else if (w?.into) mark(folderEl(w.into) ?? over.el, 'm-drop-into');
    else if (w?.tab != null) mark(over.rowEl, w.side === 'before' ? 'm-drop-before' : 'm-drop-after');
    else if (w?.row) {
      // After an open folder: the line under its last pin.
      const el = w.row.kind === 'folder' ? (w.side === 'after' ? lastPinOf(w.row.id) ?? folderEl(w.row.id) : folderEl(w.row.id)) : rowEl('pin', w.row.id);
      mark(el, w.side === 'before' ? 'm-drop-before' : 'm-drop-after');
    } else if (w) mark(over.el, 'm-drop-end');
    autoScroll();
  }

  // Near the top or bottom of the list, it scrolls (faster nearer the edge).
  function autoScroll() {
    if (scrolling || !dragging) return;
    const step = () => {
      scrolling = 0;
      const d = dragging;
      const list = rt.behaviors.scroll?.element();
      if (!d || !list) return;
      const box = list.getBoundingClientRect();
      const top = d.y - box.top;
      const bottom = box.bottom - d.y;
      if (top < 0 || bottom < 0 || d.x < box.left || d.x > box.right) return; // not over the list
      const speed = top < EDGE_PX ? -(EDGE_PX - top) / 2 : bottom < EDGE_PX ? (EDGE_PX - bottom) / 2 : 0;
      if (!speed) return;
      const before = list.scrollTop;
      list.scrollTop += Math.max(-16, Math.min(16, speed));
      if (list.scrollTop === before) return;
      move(d.x, d.y);
      scrolling = requestAnimationFrame(step);
    };
    scrolling = requestAnimationFrame(step);
  }

  function endDrag() {
    const d = dragging;
    dragging = null;
    if (!d) return null;
    clearMarks();
    if (scrolling) cancelAnimationFrame(scrolling);
    scrolling = 0;
    d.el.classList.remove('m-dragging');
    const root = view.rootElement();
    root?.classList.remove('m-dragging', `m-drag-${d.kind}`);
    try { root?.releasePointerCapture(d.pointerId); } catch {}
    return d;
  }
  function cancel() {
    const d = endDrag();
    if (d) glideBack(d.ghost, d.kind, d.id);
  }

  function drop(x, y) {
    move(x, y);
    const d = endDrag();
    if (!d) return;
    droppedAt = Date.now();
    const where = /** @type {any} */ (d.where);
    if (!where) return glideBack(d.ghost, d.kind, d.id);
    const { name, arg } = dropAction({ kind: d.kind, id: d.id }, where);
    const from = d.el.getBoundingClientRect();
    const space = rt.vm?.space;
    const pins = (space?.pinned ?? []).flatMap((p) => (p.isFolder ? p.pins : [p]));
    /** @type {() => Element | null} */
    let find = () => rowEl(d.kind, d.id);
    let same = true; // the row it lands in is the dragged one (else a new one)
    if (where.space) {
      if (!rt.dispatch(name, arg, 'behavior')) return glideBack(d.ghost, d.kind, d.id);
      return fadeOut(d.ghost); // into another space: not in this list any more
    }
    if (where.unpin) {
      const tabId = pins.find((p) => p.id === d.id)?.tabId ?? null;
      if (!rt.dispatch(name, arg, 'behavior')) return glideBack(d.ghost, d.kind, d.id);
      if (tabId == null) return fadeOut(d.ghost); // not open: gone
      find = () => rowEl('tab', tabId);
      same = false;
    } else if (where.tab != null) {
      const request = rt.dispatch(name, arg, 'behavior');
      if (!request) return glideBack(d.ghost, d.kind, d.id);
      // Not moved (the browser can't, or keeps that tab apart): back at once.
      void Promise.resolve(request).then((moved) => { if (moved !== true && landing?.ghost === d.ghost) giveUp(); });
    } else if (d.kind === 'tab') {
      // The new pin's row: the one that wasn't there before.
      const known = new Set(view.marked('m-drag', 'pin').map((el) => view.subjectOf(el)?.id));
      if (!rt.dispatch(name, arg, 'behavior')) return glideBack(d.ghost, d.kind, d.id);
      find = () => view.marked('m-drag', 'pin').find((el) => !known.has(view.subjectOf(el)?.id)) ?? null;
      same = false;
    } else {
      if (!rt.dispatch(name, arg, 'behavior')) return glideBack(d.ghost, d.kind, d.id);
      // Into a closed folder it isn't shown in (not the tab in front): in, out of sight.
      const shut = where.into && space?.pinned.find((p) => p.isFolder && p.id === where.into && !p.open);
      if (shut && d.kind === 'pin' && !pins.find((p) => p.id === d.id)?.active) return fadeOut(d.ghost);
    }
    landing = { ghost: d.ghost, find, same, from, order: order(), kind: d.kind, id: d.id, timer: rt.later(() => giveUp(), LAND_WAIT_MS) };
    land();
  }

  // Each redraw: a dropped row's new place, once the list has it.
  function land() {
    const l = landing;
    if (!l) return;
    const el = l.find();
    if (!el) return; // not in the list yet
    if (l.same && Math.abs(el.getBoundingClientRect().top - l.from.top) < 0.5 && order() === l.order) return; // not moved yet
    rt.cancel(l.timer);
    landing = null;
    glideTo(l.ghost, el);
  }
  function giveUp() {
    const l = landing;
    if (!l) return;
    rt.cancel(l.timer);
    landing = null;
    glideBack(l.ghost, l.kind, l.id);
  }
  // The copy into a row's place, the row shown once it's there.
  function glideTo(ghost, el) {
    const g = ghost.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    // Scrolled out of the list's view: it fades where it is.
    const list = rt.behaviors.scroll?.element();
    const lb = list?.getBoundingClientRect();
    if (list?.contains(el) && (r.bottom < lb.top || r.top > lb.bottom)) return fadeOut(ghost);
    if (reduced() || typeof ghost.animate !== 'function') { ghost.remove(); return; }
    const startTransform = ghost.style.transform || 'none';
    const end = `${startTransform === 'none' ? '' : startTransform} translate(${r.left - g.left}px, ${r.top - g.top}px)`.trim();
    el.classList.add('m-landing');
    const done = () => { ghost.remove(); el.classList.remove('m-landing'); };
    const glide = ghost.animate([{ transform: startTransform, opacity: 0.9 }, { transform: end, opacity: 1 }], { duration: GLIDE_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' });
    glide.onfinish = done;
    glide.oncancel = done;
  }
  function glideBack(ghost, kind, id) {
    const el = rowEl(kind, id);
    if (el) glideTo(ghost, el);
    else fadeOut(ghost);
  }
  function fadeOut(ghost) {
    if (reduced() || typeof ghost.animate !== 'function') { ghost.remove(); return; }
    const t = ghost.style.transform || 'none';
    const fade = ghost.animate([{ transform: t, opacity: 0.9 }, { transform: `${t === 'none' ? '' : t} scale(0.9)`.trim(), opacity: 0 }], { duration: FADE_MS, easing: 'ease-out', fill: 'forwards' });
    fade.onfinish = () => ghost.remove();
    fade.oncancel = () => ghost.remove();
  }

  return {
    afterRender() {
      if (dragging) move(dragging.x, dragging.y); // its marks on the rows drawn now
      land();
    },
    busy: () => dragging != null,
    active: () => dragging != null,
    /** A click right after a drop is no row's. */
    justDropped: () => Date.now() - droppedAt < 400,
    /** Where the drag would drop now (tests, the theme's own checks). */
    where: () => dragging?.where ?? null,
    destroy() { const d = endDrag(); d?.ghost.remove(); if (landing) { landing.ghost.remove(); landing = null; } },
  };
}
