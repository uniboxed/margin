// The tab list's scroll position, one per window (content/core.ts, "one
// sidebar for the window"; background/scroll.ts): `m-scroll="tabs"` marks
// the list that scrolls. It opens where the window's list last was (asked
// of the background once the list is drawn, and again whenever the page is
// shown: every page draws its own sidebar), and a scroll of the user's is
// saved (`setSidebarScroll`), at most every SAVE_MS, and at once before a
// switch (the next page asks for it at once) or as the page is left. A
// position asked for that comes back after the user scrolled is dropped.
// A space switched to starts from its top.

const SAVE_MS = 150;

export function installScroll(rt: any) {
  const { view, doc, container } = rt;
  let settingScroll = false; // the next scroll event is Margin's own
  let gen = 0; // bumped by every scroll of the user's: theirs wins over a late reply
  let top = 0;
  let saveTimer = null;
  let asked = false; // the first position asked for, once the list is drawn
  let pendingTop: number | null = null;

  const list = () => ((view.marked('m-scroll', 'tabs')[0] ?? null) as HTMLElement | null);
  // In a page the background knows the page's window (sender); the app says.
  const where = () => (rt.ownTab() == null && rt.windowId() != null ? { windowId: rt.windowId() } : {});

  function apply(px) {
    const el = list();
    if (!el) { pendingTop = px; return; }
    pendingTop = null;
    if (Math.round(el.scrollTop) === Math.round(px)) return;
    const before = el.scrollTop;
    settingScroll = true;
    el.scrollTop = px;
    if (el.scrollTop === before) settingScroll = false; // didn't move: no scroll event comes
  }
  function restore() {
    const mine = gen;
    void Promise.resolve(rt.host.send('sidebarScroll', where())).then((px) => {
      if (rt.destroyed || !Number.isFinite(px) || mine !== gen) return;
      apply(px);
    });
  }
  function flush() {
    if (saveTimer == null) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    void rt.host.send('setSidebarScroll', { top, ...where() });
  }

  // Scroll events don't bubble: listened for in the capture phase.
  rt.listen(container, 'scroll', (e: Event) => {
    const el = list();
    if (!el || e.target !== el) return;
    if (settingScroll) { settingScroll = false; return; }
    gen++;
    top = Math.max(0, Math.round(el.scrollTop));
    saveTimer ??= setTimeout(flush, SAVE_MS);
  }, { capture: true, passive: true });
  rt.listen(doc, 'visibilitychange', () => {
    if (doc.hidden) flush();
    else restore();
  });
  rt.listen(rt.win, 'pagehide', flush);

  return {
    afterRender(vm) {
      if (!vm.ready) return;
      if (!asked && list()) { asked = true; restore(); }
      if (pendingTop != null) apply(pendingTop);
    },
    /** Saved now (before a switch). */
    flush,
    /** The window's position asked for again (a page just shown: the page left may have saved it late). */
    restore,
    /** At this position (a page prepared for a show with the window's), not saved again. */
    set(px) {
      if (!Number.isFinite(px)) return;
      gen++;
      apply(Math.max(0, px));
    },
    /** From the top (a space switched to), saved as the window's. */
    reset() {
      gen++;
      const el = list();
      if (el && el.scrollTop !== 0) { settingScroll = true; el.scrollTop = 0; }
      top = 0;
      clearTimeout(saveTimer);
      saveTimer = null;
      void rt.host.send('setSidebarScroll', { top: 0, ...where() });
    },
    /** The list's element (drag and drop scrolls it near its edges). */
    element: list,
    busy: () => false,
    destroy() { clearTimeout(saveTimer); },
  };
}
