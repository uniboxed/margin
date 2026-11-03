// Keep-ready's hold, in the page (background/keep-ready.js, tabs.js holdTab):
// a message answered only once the hold is over. WebKit keeps a page's
// process running while a message to it waits for its answer, so Safari
// doesn't suspend it and its drawn layers stay (no dark flash when it's shown
// again). It does so at background priority (RunningBoard's Background role:
// efficiency cores, background QoS, throttled I/O), where the script the hold
// was until 2026-11-03 (tabs.js keepAwake) kept the process at foreground
// priority, the site's own work running on as if it were in front (about 22%
// of a core per held tab in Tirth's Safari). The answer comes when the hold's
// time is up, when the page is shown (awake then anyway), when it goes away
// (pagehide, pageswap: it can't answer after), or when a release names its
// key. Always: WebKit puts no limit of its own on the wait.
// A release also ends a hold placed the old way in the page's own world
// (keepAwake with a key: a page whose Margin was from before this listener,
// tabs.js holdTab), by the same event keepAwake listens for.
export const HOLD = 'margin-hold';
export const RELEASE = 'margin-release';
// The longest a hold may ask for (keep-ready.js MAX_MINUTES, and some).
const MAX_HOLD_MS = 11 * 60_000;

/** @param {any} api the extension's `browser` @returns {() => number} how many holds are running (the WebKit host counts them) */
export function listenForHolds(api) {
  /** @type {Map<string, () => void>} key → its end */
  const holds = new Map();
  const endAll = () => { for (const end of [...holds.values()]) end(); };
  const shown = () => { if (document.visibilityState === 'visible') endAll(); };
  /** @param {any} message @param {any} _ @param {(answer: unknown) => void} sendResponse */
  const onMessage = (message, _, sendResponse) => {
    if (message?.type === HOLD && typeof message.key === 'string' && Number.isFinite(message.ms)) {
      const { key } = message;
      holds.get(key)?.(); // (the same key twice: the first answered)
      const end = () => {
        if (holds.get(key) !== end) return;
        holds.delete(key);
        clearTimeout(timer);
        sendResponse({ held: true });
      };
      const timer = setTimeout(end, Math.max(0, Math.min(message.ms, MAX_HOLD_MS)));
      holds.set(key, end);
      return true; // answered later
    }
    if (message?.type === RELEASE && Array.isArray(message.keys)) {
      for (const key of message.keys) {
        if (typeof key !== 'string') continue;
        holds.get(key)?.();
        try { dispatchEvent(new Event(`margin-release:${key}`)); } catch {}
      }
      sendResponse(true);
    }
    return undefined;
  };
  api.runtime.onMessage.addListener(onMessage);
  document.addEventListener('visibilitychange', shown);
  // Off as the page is left (every hold answered first), back on if it comes
  // back from the back/forward cache (as content/core.js's listener: WebKit
  // holds a page whose listener on a browser.* event stays, cached or not).
  let listening = true;
  const gone = () => {
    endAll();
    if (!listening) return;
    listening = false;
    api.runtime.onMessage.removeListener(onMessage);
  };
  addEventListener('pagehide', gone);
  addEventListener('pageswap', endAll);
  addEventListener('pageshow', (event) => {
    if (!event.persisted || listening) return;
    listening = true;
    api.runtime.onMessage.addListener(onMessage);
  });
  return () => holds.size;
}
