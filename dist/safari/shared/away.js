// Safari left for another app while its window stays in sight: the page in
// front loses focus and is still visible. The background then lets go of the
// tabs it keeps ready (background/keep-ready.js noteAway): nobody switches
// tabs from another app. It may hear the same from windows.onFocusChanged
// with WINDOW_ID_NONE, but whether Safari sends that when it's deactivated
// isn't known. A page that loses focus as it's hidden says nothing: that's a
// switch to another tab (its activation says so), or the window going out of
// sight, which the holds' end (a minute) or the focus change covers. It says
// when it lost focus (`at`): the background doesn't count it if Safari was
// seen in use since (its word comes through more hops).
// Focus gone into a frame of the page (an editor, a payment form) is still
// this document's (document.hasFocus), and Safari left from there blurs only
// that frame's window, which Margin's scripts aren't in (top frame only): so
// whether this document still has focus is asked every POLL_MS while it's in
// a frame. Its focus back says so, once, after it said it was left: the
// window's focus, or, for focus back in a frame (no focus event here), asked
// the same way for BACK_MS (the background lets go PAGE_AWAY_MS after; past
// that, the next switch says Safari is in use itself).
// Each word can start a background Safari stopped (idle 30 s), so neither is
// said when it can't matter: Safari left once no hold can still run (the
// holds of a switch end `holdMs()` after it: background/keep-ready.js holdNow;
// the switch to this page is when it was last shown, give or take
// HOLD_SLACK_MS), and its focus back past BACK_WITHIN_MS after its word (the
// background has let go by then, or stopped and forgotten it, and the next
// switch says Safari is in use).
const POLL_MS = 1000;
const BACK_MS = 5000;
const HOLD_SLACK_MS = 5000;
export const BACK_WITHIN_MS = 20_000; // keep-ready.js PAGE_AWAY_MS, and some
/** @param {{ isOn: () => boolean, holdMs?: () => number, send: (type: 'away' | 'back', payload?: { at: number }) => unknown }} options */
export function watchAway({ isOn, holdMs = () => Infinity, send }) {
  let said = false;
  let saidAt = 0;
  let shownAt = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') shownAt = Date.now();
  });
  // A hold the switch to this page placed may still run.
  const holding = () => Date.now() - shownAt <= holdMs() + HOLD_SLACK_MS;
  /** @type {ReturnType<typeof setInterval> | null} */
  let poll = null;
  const stop = () => {
    if (poll) clearInterval(poll);
    poll = null;
  };
  const away = (/** @type {number} */ at) => {
    said = true;
    saidAt = Date.now();
    void send('away', { at });
  };
  const back = () => {
    stop();
    said = false;
    if (Date.now() - saidAt <= BACK_WITHIN_MS) void send('back');
  };
  const check = () => {
    if (document.visibilityState !== 'visible' || !isOn()) return stop();
    if (!said) {
      if (!document.hasFocus() && holding()) away(Date.now()); // (watched on for its focus back)
    } else if (document.hasFocus()) back();
    else if (Date.now() - saidAt >= BACK_MS) stop();
  };
  const watch = () => { poll ??= setInterval(check, POLL_MS); };
  addEventListener('blur', (event) => {
    if (!event.isTrusted || event.target !== window || said || !isOn() || !holding()) return;
    const at = Date.now();
    // (document.hasFocus() can still say yes within the blur.)
    setTimeout(() => {
      if (said || document.visibilityState !== 'visible') return;
      if (document.hasFocus()) return watch(); // into a frame
      away(at);
      watch();
    }, 0);
  });
  addEventListener('focus', (event) => {
    if (!event.isTrusted || event.target !== window) return;
    if (said) back();
    else stop();
  });
}
