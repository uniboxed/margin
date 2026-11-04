// Whether the user is idle on this page, for the warm-up after a Safari
// relaunch (background/warm-up.js): it loads a tab behind the page only
// then, by bringing it to the front and this page straight back in one run
// loop turn (out of sight, but it moves Safari's selection: not while the
// user types, in the page or in Safari's address bar, or reaches for a tab).
// Nothing is watched until the background asks: the first ask puts the
// listeners on (passive, on the window) and can't know what came before, so
// it says to ask again in a moment. From an ask on, the first input (a key,
// a press, the pointer moving, a wheel or scroll, typing by an input method,
// this page's focus going, it going hidden, an element going full screen)
// is said to the background once (`acted`), so a tab it's about to load, or
// loading, gives way. The listeners come off WATCH_MS after the last ask, or
// at once when the run is over (`end`).
// Input in a frame never reaches this page's listeners (Margin runs in the
// top frame only), and this document has focus while a frame in it does:
// with focus in a frame (an editor, a card field, a comment box) the user is
// never taken as idle. In a text field here, a pause in typing is taken to
// be three times as long (an address being looked up, a word thought of).
const WATCH_MS = 20_000;
// Asked again this soon when Safari isn't in use or the page is hidden.
const AWAY_RETRY_MS = 5000;
const FRAMES = new Set(['IFRAME', 'FRAME', 'OBJECT', 'EMBED']);
const NOT_TEXT = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);
// Where focus is: in a frame, in a text field, or elsewhere (null).
/** @returns {'frame' | 'field' | null} */
function focusIn() {
  let at = document.activeElement;
  for (let i = 0; at?.shadowRoot?.activeElement && i < 20; i++) at = at.shadowRoot.activeElement;
  if (!at) return null;
  if (FRAMES.has(at.tagName)) return 'frame';
  const input = /** @type {HTMLInputElement} */ (at);
  if (/** @type {HTMLElement} */ (at).isContentEditable || at.tagName === 'TEXTAREA' || (at.tagName === 'INPUT' && !NOT_TEXT.has(input.type))) return 'field';
  return null;
}
const INPUTS = ['pointerdown', 'pointermove', 'wheel', 'scroll', 'input', 'compositionstart', 'compositionend', 'touchstart'];

/** @param {{ busy: () => string | null, acted: (at: number) => void }} options `busy()`: why Margin itself isn't idle here (its palette open, the sidebar out or in use, a switch under way), or null */
export function createIdleWatch({ busy, acted }) {
  let watching = false;
  let since = 0; // when the listeners went on
  let lastInput = 0;
  let lastKey = 0;
  let composing = false;
  let armed = false; // an ask came and no input since: the next is said
  /** @type {ReturnType<typeof setTimeout> | null} */
  let offTimer = null;
  const tell = () => {
    if (!armed) return;
    armed = false;
    acted(Date.now());
  };
  const onInput = (/** @type {Event} */ event) => {
    lastInput = Date.now();
    if (event.type === 'compositionstart') composing = true;
    else if (event.type === 'compositionend') composing = false;
    tell();
  };
  const onKey = () => {
    lastKey = lastInput = Date.now();
    tell();
  };
  const onLeft = () => tell();
  const on = () => {
    if (watching) return;
    watching = true;
    since = Date.now();
    for (const type of INPUTS) addEventListener(type, onInput, { capture: true, passive: true });
    addEventListener('keydown', onKey, { capture: true, passive: true });
    addEventListener('blur', onLeft, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onLeft, { passive: true });
    document.addEventListener('fullscreenchange', onLeft, { passive: true });
    document.addEventListener('webkitfullscreenchange', onLeft, { passive: true });
  };
  const off = () => {
    if (offTimer) clearTimeout(offTimer);
    offTimer = null;
    armed = false;
    if (!watching) return;
    watching = false;
    composing = false;
    for (const type of INPUTS) removeEventListener(type, onInput, { capture: true });
    removeEventListener('keydown', onKey, { capture: true });
    removeEventListener('blur', onLeft, { capture: true });
    document.removeEventListener('visibilitychange', onLeft);
    document.removeEventListener('fullscreenchange', onLeft);
    document.removeEventListener('webkitfullscreenchange', onLeft);
  };
  // Media this page plays (a flip doesn't stop it, but nothing is done while it plays).
  const playing = () => [...document.querySelectorAll('video, audio')].some((m) => {
    const media = /** @type {HTMLMediaElement} */ (m);
    return !media.paused && !media.ended && media.readyState > 2;
  });
  /** @param {{ idleMs?: number, keysMs?: number }} [ask] @returns {{ idle: boolean, retryMs?: number, why?: string }} */
  function ask({ idleMs = 2000, keysMs = 5000 } = {}) {
    on();
    if (offTimer) clearTimeout(offTimer);
    offTimer = setTimeout(off, WATCH_MS);
    const now = Date.now();
    /** @type {(why: string, retryMs: number) => { idle: false, retryMs: number, why: string }} */
    const not = (why, retryMs) => ({ idle: false, retryMs: Math.max(250, Math.round(retryMs)), why });
    if (document.visibilityState !== 'visible') return not('hidden', AWAY_RETRY_MS);
    if (!document.hasFocus()) return not('not focused', AWAY_RETRY_MS);
    if (document.fullscreenElement || /** @type {any} */ (document).webkitFullscreenElement) return not('full screen', AWAY_RETRY_MS);
    const focus = focusIn();
    if (focus === 'frame') return not('in a frame', AWAY_RETRY_MS);
    const own = busy();
    if (own) return not(own, idleMs);
    if (composing) return not('typing', keysMs);
    if (playing()) return not('playing', AWAY_RETRY_MS);
    // (Watched only from the first ask: what came before isn't known.)
    const quietFrom = Math.max(since, lastInput);
    if (now - quietFrom < idleMs) return not(lastInput > since ? 'input' : 'watching', idleMs - (now - quietFrom));
    // (A pause in typing is longer: keys from the first ask, and before it unknown.)
    const keysFrom = Math.max(since, lastKey);
    const pauseMs = focus === 'field' ? 3 * keysMs : keysMs;
    if (now - keysFrom < pauseMs) return not(lastKey > since ? 'typing' : 'watching', pauseMs - (now - keysFrom));
    armed = true;
    return { idle: true };
  }
  return { ask, end: off };
}
