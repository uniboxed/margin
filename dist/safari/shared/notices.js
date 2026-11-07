// Margin's notices drawn by Margin.app's overlay (Margin 2 Phase 2 step 7):
// what pages used to say in their own UI, now said by the window's overlay
// through the theme's guarded `notice` part (themes/README.md: only Margin's
// own words). The copy decides a notice and pushes its kind for a window
// (background/notices.js, app/PROTOCOL.md `push` `notice`); the overlay turns
// the kind into these words and buttons (ui/app-notices.js), and a button
// goes back to the copy as `req noticeAction` (background/handlers.js). The
// words live here, in Margin's code, never in a message: a link carries only
// a kind and the tab it's about. Pure: the background, the overlay and the
// tests use it.

/**
 * @typedef {{ id: string, label: string, primary?: boolean }} NoticeButton
 * @typedef {{ text: string, actions: NoticeButton[], ms: number, tab: boolean, local?: boolean }} NoticeWords
 * `ms`: how long it stays up unless a button closes it first; `tab`: it's
 * about the page of one tab, and goes when that tab is no longer the
 * window's tab in front; `local`: the overlay's own (its buttons stay in the
 * overlay: ui/app-feedback.js), never pushed by the copy.
 */

/** @type {Readonly<Record<string, NoticeWords>>} */
export const NOTICES = Object.freeze({
  // A page in front whose content-script world is still bound to a copy of
  // Margin that's gone (background/cut-off.js): its box, keys and gestures
  // can't work until it's loaded again. (Before step 5 the page said it
  // itself when its own requests went unanswered: content/core.js noAnswer.)
  'not-responding': {
    text: 'Margin isn’t responding on this page (it was probably updated). Reload the page to fix it.',
    actions: [{ id: 'reload', label: 'Reload', primary: true }, { id: 'later', label: 'Not now' }],
    ms: 20000,
    tab: true,
  },
  // A page in front bound to an older copy of Margin Safari keeps running
  // beside this one until it quits (shared/owner.js): reloading it binds it to
  // that copy again, so only quitting Safari helps.
  'updated-while-open': {
    text: 'Margin was updated while Safari was open. Quit and reopen Safari to finish updating it.',
    actions: [{ id: 'ok', label: 'OK' }],
    ms: 15000,
    tab: true,
  },
  // A new tab from nothing opened the same web page twice (background/
  // newtab-hint.js): Safari's "New tabs open with" isn't Margin (Safari sets
  // it back when it turns Margin off). The set-up window checks the same
  // setting (app/safari/ViewController.swift), in the same words.
  'new-tab-setting': {
    text: 'If a new tab opened this page instead of Margin’s: in Safari Settings › General, set “New tabs open with” to Margin. Safari sets it back when it turns Margin off.',
    actions: [{ id: 'ok', label: 'OK' }, { id: 'never', label: 'Don’t show again' }],
    ms: 20000,
    tab: true,
  },
  // A switch that didn't happen (shared/switching.js; the copy's own switches
  // say why: background/tabs.js tellPage 'switch-failed').
  'tab-gone': { text: 'That tab is no longer open.', actions: [], ms: 4000, tab: false },
  'no-answer': { text: 'Margin didn’t answer, so the tab didn’t switch. Try again.', actions: [], ms: 4000, tab: false },
  'not-shown': { text: 'Margin couldn’t show that tab. Try again.', actions: [], ms: 4000, tab: false },
  // The overlay's own (app/overlay/overlay.js fallBack): the theme it was
  // handed was refused, missing, or left no usable page, so it draws Arcadia,
  // bundled with the app. The theme's name isn't said: it may be what's broken.
  'theme-failed': {
    text: 'Margin couldn’t draw the theme you chose, so it’s using Arcadia for now. Settings › Theme says why.',
    actions: [{ id: 'settings', label: 'Settings', primary: true }, { id: 'ok', label: 'OK' }],
    ms: 20000,
    tab: false,
    local: true,
  },
});

/** Whether `kind` is one of Margin's notices. @param {unknown} kind */
export const isNotice = (kind) => typeof kind === 'string' && Object.prototype.hasOwnProperty.call(NOTICES, kind);

/** Whether `action` is one of the buttons of notice `kind` the copy runs (the overlay's own notices: never). @param {unknown} kind @param {unknown} action */
export const isNoticeAction = (kind, action) => isNotice(kind) && !NOTICES[/** @type {string} */ (kind)].local && NOTICES[/** @type {string} */ (kind)].actions.some((a) => a.id === action);

/**
 * Which notice a switch that didn't happen gets, from why (a request's error,
 * or the reason the copy gave with 'switch-failed'): null for none (no reason
 * given, as pages had it; the link down: the overlay says it's reconnecting;
 * a copy that stood back for a newer one: that one links instead).
 * @param {unknown} reason
 * @returns {'tab-gone' | 'no-answer' | 'not-shown' | null}
 */
export function switchFailure(reason) {
  if (typeof reason !== 'string' || !reason) return null;
  if (/no longer open|No tab with id/i.test(reason)) return 'tab-gone';
  if (/:\s*down\b|newer copy of Margin/i.test(reason)) return null;
  if (/^no answer|timedOut|timed out/i.test(reason)) return 'no-answer';
  return 'not-shown';
}
