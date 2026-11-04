// A page whose request the background didn't answer in time (content/core.js
// send): whether to tell the user Margin isn't responding there, and offer
// to reload the page. Only once this page's copy of Margin is found gone: its
// world's calls neither arrive nor fail (or fail at once), while a live
// copy's storage answers, however busy its background (background/cut-off.js
// cutOffInPage tells the same way). Until 2026-11-03 the notice went up on
// time alone: a background slow to answer switches (just after a reboot and
// a Safari relaunch, every tab unloaded) put it up on nearly every switch,
// and a reload wouldn't have helped.

// Requests nobody waits on (a wake ahead of a switch, Safari left and back,
// a blink, the page's icon, a style sheet, its zoom, the switch log, the
// sidebar's scroll, the warm-up's word that the user did something):
// never the notice, whatever happened to them.
export const QUIET_REQUESTS = new Set(['prewake', 'away', 'back', 'pageBlinked', 'pageIcon', 'fetchStyle', 'getZoom', 'switchLog', 'sidebarScroll', 'setSidebarScroll', 'windowState', 'warmUpInput']);
export const ALIVE_ASK_MS = 2000;

/** Whether a request of this type that went unanswered may say so. @param {string} type */
export const mayNotice = (type) => !QUIET_REQUESTS.has(type);

/**
 * Whether this page's copy of Margin is still there: its storage answers
 * within `ms` (an error, or no answer, is a copy that's gone).
 * @param {any} api the page's `browser` (or `chrome`) @param {number} [ms]
 * @returns {Promise<boolean>}
 */
export function copyAlive(api, ms = ALIVE_ASK_MS) {
  let timer;
  return Promise.race([
    Promise.resolve().then(() => api.storage.local.get('owner')).then(() => true, () => false),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]).finally(() => clearTimeout(timer));
}
