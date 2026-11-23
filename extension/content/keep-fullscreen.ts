// Esc in a page Margin.app hosts never takes Safari's window out of full screen (2026-11-21, on the real screen).
//
// Safari's own action for an Escape keydown that no page took (its default not prevented) is to leave its window's
// full screen; Margin.app's engine then has to put the window back into its place (about a second, the page area
// empty meanwhile). In a window Margin.app draws (`isDrawn`: the copy's `appDrawn` for this tab's window, which holds
// for main's, a card's and a split pane's alike) an Escape the page left alone has its default prevented here, so
// Safari keeps the window in full screen. What keeps the page's own Esc working:
// - Decided last: a listener added on the window as the key's capture phase passes it runs in its bubble phase after
//   every listener the page had on its way (the DOM clones each target's listeners as the event reaches it), so a
//   page's handler (a menu, a modal of its own, an editor) sees the key as before, and one that handled it
//   (`defaultPrevented`) is left alone. Nothing here stops the event.
// - Never with ⌘, ⌃, ⌥ or ⇧ held (those are other keys), a key being composed (an input method's Esc cancels it), or an
//   element in full screen (a video's Esc leaves its full screen: Safari's, as before).
// - Never where the engine's own Esc does something: a search field (clears it), a modal dialog or an open popover
//   (closes it): their default is the page's.
// - The preview card: its Esc (content/peek.ts startCardKeys, a window listener of the card's pages) runs before this one
//   and prevents the default as it closes the card; an Esc it leaves (in a field) is kept from Safari here.
// Not covered: a key pressed in a frame (this script runs in the top frame only: all_frames is false).

type Listening = {
  addEventListener(type: string, fn: (e: any) => void, capture?: boolean): void,
  removeEventListener(type: string, fn: (e: any) => void, capture?: boolean): void,
};
type Doc = { fullscreenElement?: unknown, webkitFullscreenElement?: unknown, webkitCurrentFullScreenElement?: unknown, querySelector?(s: string): unknown };

// An element whose own Esc the engine does (its default): never taken from it.
function ownsEscape(el: any) {
  if (!el || typeof el !== 'object') return false;
  return el.localName === 'input' && String(el.type ?? el.getAttribute?.('type') ?? '').toLowerCase() === 'search';
}
// A modal dialog or an open popover in the page: the engine's Esc closes it.
function dismissable(doc: Doc | null | undefined) {
  if (!doc || typeof doc.querySelector !== 'function') return false;
  for (const s of ['dialog:modal', ':popover-open']) {
    try { if (doc.querySelector(s)) return true; } catch { /* (a selector the engine doesn't know: none of those) */ }
  }
  return false;
}

export function startKeepFullscreen({
  win = globalThis as unknown as Listening,
  doc = () => (globalThis as any).document as Doc | undefined,
  isDrawn,
}: {
  win?: Listening,
  doc?: () => Doc | null | undefined,
  /** Margin.app draws this tab's window and this copy is the one in charge. */
  isDrawn: () => boolean,
}) {
  let pending: ((e: any) => void) | null = null;
  const drop = () => { if (pending) { win.removeEventListener('keydown', pending, false); pending = null; } };
  const onCapture = (e: any) => {
    // (One left by a key the page stopped on its way: never for another key.)
    drop();
    if (!e || e.key !== 'Escape' || e.isTrusted !== true || e.isComposing) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (!isDrawn()) return;
    const last = (ev: any) => {
      if (pending === last) drop();
      if (ev !== e || ev.defaultPrevented) return;
      const d = doc();
      if (d && (d.fullscreenElement || d.webkitFullscreenElement || d.webkitCurrentFullScreenElement)) return;
      const path: any[] = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target];
      if (path.some(ownsEscape) || dismissable(d)) return;
      ev.preventDefault();
    };
    pending = last;
    win.addEventListener('keydown', last, false);
  };
  win.addEventListener('keydown', onCapture, true);
  return {
    destroy() {
      drop();
      win.removeEventListener('keydown', onCapture, true);
    },
  };
}
