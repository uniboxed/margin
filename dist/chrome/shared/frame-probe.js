// A page's answer to Margin.app's frame probe (app/HANDOFF.md §3.2, R3): during a profile handoff,
// is the target window's page drawing fresh frames at the full-screen size yet? Content scripts
// (content/core.js) and Margin's new-tab page (newtab/newtab.js) answer it, asked through the
// background (background/handoff.js probeWindow).
//
// The page nudges first: a 1×1 element fixed at the top left, out of the layout (nothing moves, no
// scroll, no hit target), its alpha 0.01 and 0.02 on alternate animation frames, so each frame is a
// changed one (in the AppKit lab, changed frames cleared full screen's leftover image). The nudge
// lasts `nudgeMs`, and on until the count is done, so every frame counted is a changed one. Then it
// counts `frames` animation frames with the window at the full-screen size (its outerWidth and
// outerHeight within 2 pt of `width` and `height`; the window's, so the page's zoom and Safari's own
// sidebar don't change it), and answers: how many, when the first and last were (Date.now()), its
// size then, whether it has focus and is shown, and its last visibilitychange to visible (gate G2
// may use that if WebKit runs no frames under the freeze). Nothing by `timeoutMs`: null, and the
// element goes either way.
//
// No page content, address or title in the answer: sizes, times and flags only.

const SIZE_SLACK = 2;
// The nudge's two colours, alternate frames: alpha 0.01 and 0.02 (nothing anyone sees).
const NUDGE = ['rgba(128, 128, 128, 0.01)', 'rgba(128, 128, 128, 0.02)'];

/** @typedef {{ width?: number, height?: number, frames?: number, nudgeMs?: number, timeoutMs?: number }} ProbeRequest */
/** @typedef {{ frames: number, firstAt: number, lastAt: number, width: number, height: number, hasFocus: boolean, visible: boolean, visibleAt?: number }} ProbeAnswer */

// When the page last turned visible (its visibilitychange), from when this was set up.
/** @param {{ doc?: Document, now?: () => number }} [env] */
export function watchVisible({ doc = globalThis.document, now = Date.now } = {}) {
  /** @type {number | undefined} */
  let at;
  doc?.addEventListener?.('visibilitychange', () => { if (doc.visibilityState === 'visible') at = now(); });
  return () => at;
}

/**
 * @param {ProbeRequest} request
 * @param {{ win?: any, doc?: Document, raf?: (cb: () => void) => any, now?: () => number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout, visibleAt?: () => number | undefined }} [env]
 * @returns {Promise<ProbeAnswer | null>}
 */
export function probeFrames(request, env = {}) {
  const win = env.win ?? globalThis;
  const doc = env.doc ?? globalThis.document;
  const raf = env.raf ?? ((/** @type {() => void} */ cb) => win.requestAnimationFrame(cb));
  const now = env.now ?? Date.now;
  const setTimer = env.setTimer ?? setTimeout;
  const clearTimer = env.clearTimer ?? clearTimeout;
  const want = Math.max(1, Math.min(60, Math.round(Number(request.frames) || 6)));
  const nudgeMs = Math.max(0, Number(request.nudgeMs) || 0);
  const timeoutMs = Math.max(1, Number(request.timeoutMs) || 400);
  const width = Number(request.width) || 0;
  const height = Number(request.height) || 0;
  const fits = () => (!(width > 0) || Math.abs(win.outerWidth - width) <= SIZE_SLACK) && (!(height > 0) || Math.abs(win.outerHeight - height) <= SIZE_SLACK);
  const started = now();
  const el = nudgeMs > 0 ? nudgeElement(doc) : null;
  return new Promise((resolve) => {
    let done = false;
    let counted = 0;
    let firstAt = 0;
    let lastAt = 0;
    let odd = false;
    const finish = (/** @type {ProbeAnswer | null} */ answer) => {
      if (done) return;
      done = true;
      clearTimer(timer);
      el?.remove();
      resolve(answer);
    };
    const timer = setTimer(() => finish(null), timeoutMs);
    const frame = () => {
      if (done) return;
      const at = now();
      if (el) {
        odd = !odd;
        el.style.setProperty('background-color', odd ? NUDGE[1] : NUDGE[0], 'important');
      }
      if (at - started >= nudgeMs && fits()) {
        if (!counted) firstAt = at;
        counted++;
        lastAt = at;
        if (counted >= want) {
          const visibleAt = env.visibleAt?.();
          return finish({
            frames: counted, firstAt, lastAt, width: win.outerWidth, height: win.outerHeight,
            hasFocus: !!doc?.hasFocus?.(), visible: doc?.visibilityState === 'visible',
            ...(Number.isFinite(visibleAt) ? { visibleAt } : {}),
          });
        }
      }
      raf(frame);
    };
    raf(frame);
  });
}

// The nudge: fixed, 1×1, out of the layout and out of the way of the page's own styles (every
// property set with !important, `all` reset first), under <html> so no body rule reaches it.
/** @param {Document | undefined} doc */
function nudgeElement(doc) {
  const root = doc?.documentElement;
  if (!root || typeof doc.createElement !== 'function') return null;
  const el = doc.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = [
    'all: initial', 'position: fixed', 'left: 0', 'top: 0', 'width: 1px', 'height: 1px', 'margin: 0', 'padding: 0',
    'border: 0', 'display: block', 'pointer-events: none', 'contain: strict', 'z-index: 2147483647',
    `background-color: ${NUDGE[0]}`,
  ].map((d) => `${d} !important`).join('; ');
  root.appendChild(el);
  return el;
}
