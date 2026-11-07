// What Margin.app's overlay says about the window's pages, besides the state
// (app/overlay/overlay.js; Margin 2 Phase 2 step 7): its notices and the
// trackpad gestures' feedback, both told by the copy (app/PROTOCOL.md `push`)
// or found by the overlay itself (a switch it asked for that didn't happen).
// Pure: no DOM, no browser API; the overlay gives it the runtime's setUi.

import { NOTICES, isNotice, switchFailure } from '../shared/notices.js';

/**
 * One notice at a time, in the theme's guarded `notice` part with Margin's
 * words (shared/notices.js): the newest takes the place of the one before.
 * It goes when one of its buttons is pressed (`run`: the copy is told, as
 * `noticeAction`), after its time, or, for a notice about one tab's page,
 * once that tab has been the window's tab in front and no longer is
 * (`front`).
 *
 * `show(view)`: the runtime's notice (null: none). `send(type, payload)`: a
 * request to the copy (the host's send). `frontTab()`: the window's tab in
 * front now, if known. `local(kind, action)`: a button of one of the
 * overlay's own notices (shared/notices.js `local`), which never goes to the copy.
 * @param {{
 *   show: (notice: { id: string, text: string, actions: { id: string, label: string, primary?: boolean }[] } | null) => void,
 *   send: (type: string, payload: Record<string, any>) => unknown,
 *   frontTab?: () => number | null,
 *   local?: (kind: string, action: string) => void,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (timer: any) => void,
 * }} options
 */
export function createAppNotices({ show, send, frontTab = () => null, local = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  /** @type {{ id: string, kind: string, tabId: number | null, front: boolean } | null} */
  let current = null;
  let timer = null;
  let count = 0;
  const viewOf = (/** @type {{ id: string, kind: string }} */ c) => ({ id: c.id, text: NOTICES[c.kind].text, actions: NOTICES[c.kind].actions.map((a) => ({ ...a })) });
  function clear(redraw = true) {
    clearTimer(timer);
    timer = null;
    const had = current;
    current = null;
    if (had && redraw) show(null);
  }
  /** @param {unknown} kind @param {unknown} [tabId] */
  function put(kind, tabId = null) {
    if (!isNotice(kind)) return false;
    const words = NOTICES[/** @type {string} */ (kind)];
    clear(false);
    const id = `${kind}#${++count}`;
    const tab = words.tab && Number.isInteger(tabId) ? /** @type {number} */ (tabId) : null;
    current = { id, kind: /** @type {string} */ (kind), tabId: tab, front: tab != null && frontTab() === tab };
    show(viewOf(current));
    timer = setTimer(() => { if (current?.id === id) clear(); }, words.ms);
    return true;
  }
  return {
    /**
     * What the copy pushed for this window: `notice { kind, tabId }`, or a
     * switch it made here that didn't happen (`switch-failed`, with why).
     * Whether a notice went up.
     * @param {any} msg
     */
    push(msg) {
      // The overlay's own notices are never the copy's to say.
      if (msg?.type === 'notice') return NOTICES[msg.kind]?.local ? false : put(msg.kind, msg.tabId);
      if (msg?.type === 'switch-failed') {
        const kind = switchFailure(msg.reason);
        return kind ? put(kind) : false;
      }
      return false;
    },
    /** A switch this overlay asked for didn't happen; `reason`: its request's error. @param {unknown} reason */
    switchFailed(reason) {
      const kind = switchFailure(reason);
      return kind ? put(kind) : false;
    },
    /** The window's tab in front, as the copy's windows or state say it now. @param {number | null | undefined} tabId */
    front(tabId) {
      if (!current || current.tabId == null || tabId == null) return;
      if (tabId === current.tabId) current.front = true;
      else if (current.front) clear();
    },
    /**
     * One of its buttons, pressed (the runtime's notice.run, through the
     * host's perform): closed, and the copy told what was chosen.
     * @param {{ id?: string, action?: string }} arg
     */
    run(arg) {
      if (!current || arg?.id !== current.id) return false;
      const { kind, tabId } = current;
      clear(false);
      // The overlay's own: its buttons are the overlay's (`local`); the copy hears nothing.
      if (NOTICES[kind].local) local(kind, String(arg.action ?? ''));
      else void send('noticeAction', { notice: kind, action: String(arg.action ?? ''), ...(tabId != null ? { tabId } : {}) });
      return true;
    },
    /** One of the overlay's own notices (`local` in shared/notices.js), put up. @param {string} kind */
    say(kind) { return NOTICES[kind]?.local ? put(kind) : false; },
    /** The notice up now, as the runtime draws it (for a runtime made again: a new theme). */
    view: () => (current ? viewOf(current) : null),
    /** Which notice is up, and about which tab. */
    get current() { return current ? { kind: current.kind, tabId: current.tabId } : null; },
    destroy: () => clear(false),
  };
}

// The trackpad gestures Margin runs in pages (content/trackpad.js): their
// feedback, told by the page through the copy (`push` `gesture`) and drawn by
// the theme (the view model's `gesture`). A gesture's last word goes after
// a moment (a lifted pull reloads, a swipe goes back or forward: the loading
// indicator takes over); one whose updates stop (a word lost on the way, the
// page gone) goes after STALE_MS.
export const GESTURE_DONE_MS = 450;
export const GESTURE_STALE_MS = 1000;

/**
 * `set(gesture)`: the runtime's `gesture` (null: none).
 * @param {{ set: (gesture: { kind: 'pull' | 'swipe', state: 'pulling' | 'armed' | 'done', progress: number, direction: number } | null) => void, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (timer: any) => void }} options
 */
export function createGestureFeedback({ set, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let shown = null;
  let timer = null;
  const off = () => {
    clearTimer(timer);
    timer = null;
    if (shown) set((shown = null));
  };
  return {
    /** A page's gesture as it goes: { kind, state: 'idle' | 'pulling' | 'armed' | 'trigger', progress, direction }. @param {any} msg */
    push(msg) {
      const kind = msg?.kind === 'pull' || msg?.kind === 'swipe' ? msg.kind : null;
      if (!kind || msg.state === 'idle' || !['pulling', 'armed', 'trigger'].includes(msg.state)) return off();
      clearTimer(timer);
      const done = msg.state === 'trigger';
      const progress = Math.max(0, Math.min(1, Number(msg.progress) || 0));
      shown = { kind, state: done ? 'done' : msg.state, progress: done ? 1 : progress, direction: kind === 'swipe' ? (Number(msg.direction) > 0 ? 1 : -1) : 0 };
      set(shown);
      timer = setTimer(off, done ? GESTURE_DONE_MS : GESTURE_STALE_MS);
    },
    clear: off,
    get shown() { return shown; },
  };
}
