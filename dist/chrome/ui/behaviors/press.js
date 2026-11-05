// A press (Arc): a tab, a pin whose tab is open, or a space's chip switches
// as the mouse button goes down, not once it's back up, so the row (or the
// space) is highlighted at once; the click that follows does nothing more.
// Only the main button of a mouse or trackpad, without ⌃ (the Mac's
// right-click: the menu); not a nested control (a row's close button); not
// a touch or a pen (a press there can start a scroll). A pin not open yet
// opens on click (pressing it to drag it elsewhere doesn't open it).
// While the button is down the row has the class `m-pressed` (a theme can
// shrink it a little, as Arcadia does), kept through redraws.
// (themes/arcadia/sidebar.js, "A press switches".)

// The actions a press runs, and the rows that show `m-pressed`.
const SWITCHES = new Set(['tab.activate', 'pin.open', 'space.switch']);
const PRESSED_ROWS = new Set(['tab.activate', 'pin.open', 'folder.toggle', 'tab.new']);

/** @param {any} rt */
export function installPress(rt) {
  const { view, doc } = rt;
  /** @type {{ name: string, arg: any } | null} */
  let pressed = null; // a press switched: its click is the same switch
  let away = false; // and this page is on its way out (in pages: a drag can't start)
  /** @type {Element | null} */
  let pressedEl = null;

  const release = () => {
    pressedEl?.classList.remove('m-pressed');
    pressedEl = null;
  };

  rt.listen(rt.container, 'pointerdown', (/** @type {PointerEvent} */ e) => {
    release();
    pressed = null;
    away = false;
    if (e.button !== 0 || e.ctrlKey || !e.isPrimary || !view.owns(e.target)) return;
    if (rt.behaviors.rename?.editingContains(e.target) || rt.behaviors.drag?.active()) return;
    const hit = view.actionAt(e.target);
    if (!hit) return;
    if (PRESSED_ROWS.has(hit.name)) {
      pressedEl = hit.el;
      hit.el.classList.add('m-pressed');
    }
    if (e.pointerType !== 'mouse' || !SWITCHES.has(hit.name)) return;
    const vm = rt.vm;
    let tabId = null;
    if (hit.name === 'tab.activate') tabId = hit.arg;
    if (hit.name === 'pin.open') {
      const pin = vm?.space?.pinned.flatMap((p) => (p.isFolder ? p.pins : [p])).find((p) => p.id === hit.arg);
      if (!pin?.open) return; // a pin not open: on click
      tabId = pin.tabId;
    }
    // A second press on a tab on its way already: nothing more.
    if (tabId != null && rt.ui.switchingTo === tabId) { pressed = { name: hit.name, arg: hit.arg }; return; }
    pressed = { name: hit.name, arg: hit.arg };
    const own = rt.ownTab();
    away = own != null && ((tabId != null && tabId !== own) || (rt.ui.switchingTo != null && rt.ui.switchingTo !== own));
    rt.dispatch(hit.name, hit.arg, 'theme', { element: hit.el, event: e });
  });
  for (const type of ['pointerup', 'pointercancel']) rt.listen(doc, type, release, true);
  rt.listen(rt.win, 'blur', release);

  return {
    /** Whether a click is the one after a press that switched already. */
    consumes(name, arg, event) {
      if (!pressed || pressed.name !== name || pressed.arg !== arg || !(event?.detail > 0)) return false;
      pressed = null;
      return true;
    },
    /** This page is on its way out after a press (a drag can't start). */
    away: () => away,
  };
}
