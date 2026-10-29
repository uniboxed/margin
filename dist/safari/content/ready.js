// Margin getting ready on a page (content/core.js). After Safari starts, or
// Margin is updated, the stored tabs are another copy's (their ids aren't
// this copy's) until this copy's background has matched the open tabs
// (shared/stored.js openTabsCurrent): a page shown meanwhile shows the
// theme's startup cover ("Getting your tabs ready"), over the page and the
// sidebar, so nothing is clicked that can't work yet. Only if the wait goes
// on past GRACE_MS (the usual case is quicker: no flash), then at least
// MIN_SHOWN_MS (no flicker), and at most MAX_MS from when it began (then
// Margin works with what it has: a switch still finds its tab by address,
// background/tabs.js resolveTab). Only where `allowed()` (content/core.js: a
// page just loaded or shown, not one in use while Margin is updated). Hidden
// pages show nothing; one shown while still waiting shows it then.
const GRACE_MS = 250;
const MIN_SHOWN_MS = 400;
const MAX_MS = 6000;

/**
 * @param {{ show: (on: boolean) => void, allowed?: () => boolean, doc?: Document, graceMs?: number, minShownMs?: number, maxMs?: number }} options
 * `show`: the cover on or off.
 */
export function createReadiness({ show, allowed = () => true, doc = document, graceMs = GRACE_MS, minShownMs = MIN_SHOWN_MS, maxMs = MAX_MS }) {
  let waiting = false;
  let since = 0;
  let shownAt = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  const set = (/** @type {boolean} */ on) => {
    if (!!shownAt === on) return;
    shownAt = on ? Date.now() : 0;
    show(on);
  };
  const later = (/** @type {number} */ ms) => { timer = setTimeout(update, ms); };
  function update() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!waiting) {
      since = 0;
      // Up long enough not to flicker, then off (at once on a hidden page).
      const left = shownAt && !doc.hidden ? minShownMs - (Date.now() - shownAt) : 0;
      return left > 0 ? later(left) : set(false);
    }
    since ||= Date.now();
    const waited = Date.now() - since;
    if (waited >= maxMs || doc.hidden) return set(false);
    if (!shownAt && waited < graceMs) return later(graceMs - waited);
    if (!shownAt && !allowed()) return later(100);
    set(true);
    later(maxMs - waited);
  }
  doc.addEventListener('visibilitychange', update);
  return {
    /** @param {boolean} value whether the page waits for its copy of Margin */
    wait(value) {
      if (waiting === value) return;
      waiting = value;
      update();
    },
    waiting: () => waiting,
    shown: () => !!shownAt,
  };
}
