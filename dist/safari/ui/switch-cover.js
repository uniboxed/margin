// What Margin.app's overlay page tells the app while a switch to another
// profile runs (app/HANDOFF.md §7, §3.2 R4; app/PROTOCOL.md "The overlay
// page and the app, during a switch"): that the "switching" cover is drawn,
// so the screen may freeze on it, and that the page has drawn after the app
// showed it, in which mode. Pure: the overlay (app/overlay/overlay.js) gives
// it its animation frames and what's in its DOM, so the tests can run it.

/** Frames the cover is drawn for, with no swipe settling, before it counts as shown. */
export const COVER_FRAMES = 2;

/**
 * Says `switch.coverShown` once per cover: after it has been in the DOM for
 * COVER_FRAMES animation frames in a row with no swipe moving or settling
 * (the freeze is screen-wide: it must not start mid-slide, behaviors/
 * swipe.js `m-swiping`, `m-settling`). A frame with a swipe starts the count
 * again. A cover for another target (a new `id`) counts again from nothing.
 * No frames (the overlay off screen): nothing said, and the app's own limit
 * (250 ms) starts the freeze instead.
 *
 * `cover()`: the cover's id while it's in the DOM, else null. `settling()`:
 * a swipe moving or settling. `say()`: tell the app. `check()` after each
 * change to the DOM.
 * @param {{ requestFrame: (fn: () => void) => unknown, cover: () => string | null, settling: () => boolean, say: () => void }} options
 */
export function createCoverWatch({ requestFrame, cover, settling, say }) {
  let frames = 0;
  let waiting = false;
  /** @type {string | null} */
  let saidFor = null;
  /** @type {string | null} */
  let counting = null;
  const frame = () => {
    waiting = false;
    const id = cover();
    if (id == null) { frames = 0; counting = null; saidFor = null; return; }
    if (id === saidFor) return;
    if (id !== counting) { counting = id; frames = 0; }
    if (settling()) frames = 0;
    else frames++;
    if (frames >= COVER_FRAMES) { saidFor = id; counting = null; frames = 0; say(); return; }
    waiting = true;
    requestFrame(frame);
  };
  return {
    check() {
      const id = cover();
      if (id == null) { frames = 0; counting = null; saidFor = null; return; }
      if (id === saidFor || waiting) return;
      waiting = true;
      requestFrame(frame);
    },
    get said() { return saidFor; },
  };
}

/**
 * The page's answer to the app's `shown`: on its next animation frame, that
 * it has drawn, and as `fullscreen` or `windowed` (`framed { mode }`, R4:
 * the switch waits for the target's overlay to say `fullscreen`). The mode is
 * read at that frame, so a window list that came meanwhile counts.
 * @param {{ requestFrame: (fn: () => void) => unknown, mode: () => string, post: (op: string, body: Record<string, any>) => unknown }} options
 */
export function answerFramed({ requestFrame, mode, post }) {
  requestFrame(() => { post('framed', { mode: mode() === 'windowed' ? 'windowed' : 'fullscreen' }); });
}
