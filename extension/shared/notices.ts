// Margin's notices drawn by Margin.app's overlay (Margin 2 Phase 2 step 7):
// what pages used to say in their own UI, now said by the window's overlay
// through the theme's guarded `notice` part (themes/README.md: only Margin's
// own words). The copy decides a notice and pushes its kind for a window
// (background/notices.ts, docs/PROTOCOL.md `push` `notice`); the overlay turns
// the kind into these words and buttons (ui/app-notices.js), and a button
// goes back to the copy as `req noticeAction` (background/handlers.ts). The
// words live here, in Margin's code, never in a message: a link carries only
// a kind and the tab it's about. Pure: the background, the overlay and the
// tests use it.

export type NoticeButton = { id: string, label: string, primary?: boolean };
// `expires`: an overlay's own notice whose question must be answered: the action it gives when it goes unanswered (its
// time out, closed, another notice in its place, the overlay gone), so whoever asked never waits on it.
export type NoticeWords = { text: string, actions: NoticeButton[], ms: number, tab: boolean, local?: boolean, expires?: string };

export const NOTICES: Readonly<Record<string, NoticeWords>> = Object.freeze({
  // A page in front whose content-script world is still bound to a copy of
  // Margin that's gone (background/cut-off.ts): its keys and gestures
  // can't work until it's loaded again. (Before step 5 the page said it
  // itself when its own requests went unanswered: content/core.ts noAnswer.)
  'not-responding': {
    text: 'Margin isn’t responding on this page (it was probably updated). Reload the page to fix it.',
    actions: [{ id: 'reload', label: 'Reload', primary: true }, { id: 'later', label: 'Not now' }],
    ms: 20000,
    tab: true,
  },
  // A page in front bound to an older copy of Margin Safari keeps running
  // beside this one until it quits (shared/owner.ts): reloading it binds it to
  // that copy again, so only quitting Safari helps.
  'updated-while-open': {
    text: 'Margin was updated while Safari was open. Quit and reopen Safari to finish updating it.',
    actions: [{ id: 'ok', label: 'OK' }],
    ms: 15000,
    tab: true,
  },
  // A new tab from nothing opened the same web page twice (background/
  // newtab-hint.ts): Safari's "New tabs open with" isn't Margin (Safari sets
  // it back when it turns Margin off). The set-up window checks the same
  // setting (app/platforms/macos/startup/ViewController.swift), in the same words.
  'new-tab-setting': {
    text: 'If a new tab opened this page instead of Margin’s: in Safari Settings › General, set “New tabs open with” to Margin. Safari sets it back when it turns Margin off.',
    actions: [{ id: 'ok', label: 'OK' }, { id: 'never', label: 'Don’t show again' }],
    ms: 20000,
    tab: true,
  },
  // A switch that didn't happen (shared/switching.ts; the copy's own switches
  // say why: background/tabs.ts tellPage 'switch-failed').
  'tab-gone': { text: 'That tab is no longer open.', actions: [], ms: 4000, tab: false },
  'no-answer': { text: 'Margin didn’t answer, so the tab didn’t switch. Try again.', actions: [], ms: 4000, tab: false },
  'not-shown': { text: 'Margin couldn’t show that tab. Try again.', actions: [], ms: 4000, tab: false },
  // The overlay's own (app/shared/host/overlay.ts fallBack): the theme it was
  // handed was refused, missing, or left no usable page, so it draws Arcadia,
  // bundled with the app. The theme's name isn't said: it may be what's broken.
  'theme-failed': {
    text: 'Margin couldn’t draw the theme you chose, so it’s using Arcadia for now. Settings › Theme says why.',
    actions: [{ id: 'settings', label: 'Settings', primary: true }, { id: 'ok', label: 'OK' }],
    ms: 20000,
    tab: false,
    local: true,
  },
  // Margin.app's own (HostEngine stepDown, docs/ARCHITECTURE-PLAN.md "On failure"): a hosted app kept fighting the
  // way Margin showed it (the loop guard stopped it, its full screen failed), so it's shown a safer way now, for that
  // version of it. `{app}`: its name as Margin's app list has it (fillNotice), never a page's words.
  'route-simpler': {
    text: '{app} didn’t settle in Margin, so it’s shown a simpler way now. It may take a moment to resize. Margin tries again when {app} updates.',
    actions: [{ id: 'ok', label: 'OK' }],
    ms: 12000,
    tab: false,
    local: true,
  },
  // Margin.app (app/platforms/macos/shell/HostEngine.swift `onAsking`): an app whose row was closed while it was asking
  // something (its own sheet or alert) didn't quit: its prompt holds it. Kept in Margin, never put on the Desktop.
  // Margin.app (HostedSession.swift `profileFallback`): a space's Safari profile couldn't be opened (Margin doesn't know
  // its name: Safari's profiles not readable), so its page opened in the default profile. `{space}`: the space's name
  // as the person typed it. Allow opens the picker on Safari's folder (SafariFolderGrant.swift).
  'safari-profile': {
    text: 'Margin couldn’t open the Safari profile of “{space}”, so this page opened in your default profile. Allow Margin to see your Safari profiles to fix this.',
    actions: [{ id: 'allow', label: 'Allow…' }, { id: 'ok', label: 'Not now' }],
    ms: 20000,
    tab: false,
    local: true,
  },
  'app-asking': {
    text: '{app} is waiting for an answer, so it didn’t close. Open it, answer it, then close it.',
    actions: [{ id: 'ok', label: 'OK' }],
    ms: 12000,
    tab: false,
    local: true,
  },
  // Margin.app's question (margin-core session/restart.rs, Tirth 2026-11-26): a Safari the person opened has its own
  // menu bar in Margin's Space; restarted by Margin it's Margin's Safari (no Dock icon, the windows it restores closed,
  // quit with Margin), so its own windows close, said plainly. Unanswered (its time out, closed, another notice in its
  // place): Not now (`expires`). The show waits behind its loader meanwhile.
  'safari-restart': {
    text: 'Safari was opened outside Margin, so Safari’s own menu bar shows here. Restart it to use Margin’s? Safari’s own windows close: what’s open only there, typed text and downloads are lost. Your tabs in Margin stay.',
    actions: [{ id: 'restart', label: 'Restart Safari', primary: true }, { id: 'later', label: 'Not now' }],
    ms: 30000,
    tab: false,
    local: true,
    expires: 'later',
  },
});

// A notice's words with its values filled in (`{app}`: an installed app's name, at most 60 characters, plain text;
// anything else left out). Words without a value are as they are.
export function fillNotice(text: string, values: Record<string, unknown> = {}): string {
  const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : '');
  // (`{space}`: a space's name as the person typed it.)
  return text.replace(/\{app\}/g, clean(values.app) || 'An app').replace(/\{space\}/g, clean(values.space) || 'this space');
}

/** Whether `kind` is one of Margin's notices. */
export const isNotice = (kind: unknown) => typeof kind === 'string' && Object.prototype.hasOwnProperty.call(NOTICES, kind);

/** Whether `action` is one of the buttons of notice `kind` the copy runs (the overlay's own notices: never). */
export const isNoticeAction = (kind: unknown, action: unknown) => isNotice(kind) && !NOTICES[(kind as string)].local && NOTICES[(kind as string)].actions.some((a) => a.id === action);

/**
 * Which notice a switch that didn't happen gets, from why (a request's error,
 * or the reason the copy gave with 'switch-failed'): null for none (no reason
 * given, as pages had it; the link down: the overlay says it's reconnecting;
 * a copy that stood back for a newer one: that one links instead).
 * */
export function switchFailure(reason: unknown): 'tab-gone' | 'no-answer' | 'not-shown' | null {
  if (typeof reason !== 'string' || !reason) return null;
  if (/no longer open|No tab with id/i.test(reason)) return 'tab-gone';
  if (/:\s*down\b|newer copy of Margin/i.test(reason)) return null;
  if (/^no answer|timedOut|timed out/i.test(reason)) return 'no-answer';
  return 'not-shown';
}
