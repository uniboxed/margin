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
// A tab's row pressed and dragged onto the page (docs/FLEX-SPLIT.md step 2) goes beside or into what was shown before
// the press: the drag asks for that back (`switchBack`) as it first reaches the page.
import type { Rt } from '../runtime.ts';

// The actions a press runs, and the rows that show `m-pressed`.
const SWITCHES = new Set(['tab.activate', 'pin.open', 'space.switch']);
const PRESSED_ROWS = new Set(['tab.activate', 'pin.open', 'folder.toggle', 'tab.new']);

export function installPress(rt: Rt) {
  const { view, doc } = rt;
  let pressed: { name: string, arg: any } | null = null; // a press switched: its click is the same switch
  let away = false; // and this page is on its way out (in pages: a drag can't start)
  let pressedEl: Element | null = null;
  // The tab shown before a press switched to another (null: the press switched nothing).
  let before: number | string | null = null;

  const release = () => {
    pressedEl?.classList.remove('m-pressed');
    pressedEl = null;
  };

  rt.listen(rt.container, 'pointerdown', (e: PointerEvent) => {
    release();
    pressed = null;
    away = false;
    before = null;
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
    let tabId: number | null = null;
    if (hit.name === 'tab.activate') tabId = hit.arg as number; // (its tab's id: ui/actions.ts)
    if (hit.name === 'pin.open') {
      const pin = vm?.space?.pinned.flatMap((p) => (p.isFolder ? p.pins : [p])).find((p) => p.id === hit.arg);
      if (!pin?.open) return; // a pin not open: on click
      tabId = pin.tabId;
    }
    // A second press on a tab on its way already: nothing more.
    if (tabId != null && rt.ui.switchingTo === tabId) { pressed = { name: hit.name, arg: hit.arg }; return; }
    pressed = { name: hit.name, arg: hit.arg };
    const shown = vm?.tab?.id ?? null;
    before = tabId != null && shown != null && shown !== tabId ? shown : null;
    const own = rt.ownTab();
    away = own != null && ((tabId != null && tabId !== own) || (rt.ui.switchingTo != null && rt.ui.switchingTo !== own));
    rt.dispatch(hit.name, hit.arg, 'theme', { element: hit.el, event: e });
  });
  for (const type of ['pointerup', 'pointercancel']) rt.listen(doc, type, release, true);
  rt.listen(rt.win, 'blur', release);

  return {
    /** Whether a click is the one after a press that switched already. */
    consumes(name: string, arg: unknown, event: Event | undefined) {
      if (!pressed || pressed.name !== name || pressed.arg !== arg || !((event as UIEvent)?.detail > 0)) return false;
      pressed = null;
      return true;
    },
    /** This page is on its way out after a press (a drag can't start). */
    away: () => away,
    /**
     * The tab shown before this press switched shown again (a tab's row dragged onto the page: it goes beside or into
     * what was there); once a press. Whether it asked.
     */
    switchBack() {
      const tab = before;
      before = null;
      if (tab == null || !pressed) return false;
      return !!rt.dispatch('tab.activate', tab, 'behavior');
    },
  };
}
