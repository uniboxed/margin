// What Margin.app's overlay says about the window's pages, besides the state
// (app/shared/host/overlay.ts; Margin 2 Phase 2 step 7): its notices and the
// trackpad gestures' feedback, both told by the copy (docs/PROTOCOL.md `push`)
// or found by the overlay itself (a switch it asked for that didn't happen).
// Pure: no DOM, no browser API; the overlay gives it the runtime's setUi.

import { NOTICES, isNotice, switchFailure } from '../shared/notices.ts';

/**
 * One notice at a time, in the theme's guarded `notice` part with Margin's
 * words (shared/notices.ts): the newest takes the place of the one before.
 * It goes when one of its buttons is pressed (`run`: the copy is told, as
 * `noticeAction`), after its time, or, for a notice about one tab's page,
 * once that tab has been the window's tab in front and no longer is
 * (`front`).
 *
 * `show(view)`: the runtime's notice (null: none). `send(type, payload)`: a
 * request to the copy (the host's send). `frontTab()`: the window's tab in
 * front now, if known. `local(kind, action)`: a button of one of the
 * overlay's own notices (shared/notices.ts `local`), which never goes to the copy.
 * */
export function createAppNotices({ show, send, frontTab = () => null, local = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }: {
  show: (notice: { id: string, text: string, actions: { id: string, label: string, primary?: boolean }[] } | null) => void,
  send: (type: string, payload: Record<string, any>) => unknown,
  frontTab?: () => number | null,
  local?: (kind: string, action: string) => void,
  setTimer?: (fn: () => void, ms: number) => any,
  clearTimer?: (timer: any) => void,
}) {
  let current: { id: string, kind: string, tabId: number | null, front: boolean } | null = null;
  let timer: unknown = null; // (setTimer's)
  let count = 0;
  const viewOf = (c: { id: string, kind: string }) => ({ id: c.id, text: NOTICES[c.kind].text, actions: NOTICES[c.kind].actions.map((a) => ({ ...a })) });
  function clear(redraw = true) {
    clearTimer(timer);
    timer = null;
    const had = current;
    current = null;
    if (had && redraw) show(null);
  }
  function put(kind: unknown, tabId: unknown = null) {
    if (!isNotice(kind)) return false;
    const words = NOTICES[(kind as string)];
    clear(false);
    const id = `${kind}#${++count}`;
    const tab = words.tab && Number.isInteger(tabId) ? (tabId as number) : null;
    current = { id, kind: (kind as string), tabId: tab, front: tab != null && frontTab() === tab };
    show(viewOf(current));
    timer = setTimer(() => { if (current?.id === id) clear(); }, words.ms);
    return true;
  }
  return {
    /**
     * What the copy pushed for this window: `notice { kind, tabId }`, or a
     * switch it made here that didn't happen (`switch-failed`, with why).
     * Whether a notice went up.
     * */
    push(msg: any) {
      // The overlay's own notices are never the copy's to say.
      if (msg?.type === 'notice') return NOTICES[msg.kind]?.local ? false : put(msg.kind, msg.tabId);
      if (msg?.type === 'switch-failed') {
        const kind = switchFailure(msg.reason);
        return kind ? put(kind) : false;
      }
      return false;
    },
    /** A switch this overlay asked for didn't happen; `reason`: its request's error. */
    switchFailed(reason: unknown) {
      const kind = switchFailure(reason);
      return kind ? put(kind) : false;
    },
    /** The window's tab in front, as the copy's windows or state say it now. */
    front(tabId: number | null | undefined) {
      if (!current || current.tabId == null || tabId == null) return;
      if (tabId === current.tabId) current.front = true;
      else if (current.front) clear();
    },
    /**
     * One of its buttons, pressed (the runtime's notice.run, through the
     * host's perform): closed, and the copy told what was chosen.
     * */
    run(arg: { id?: string, action?: string }) {
      if (!current || arg?.id !== current.id) return false;
      const { kind, tabId } = current;
      clear(false);
      // The overlay's own: its buttons are the overlay's (`local`); the copy hears nothing.
      if (NOTICES[kind].local) local(kind, String(arg.action ?? ''));
      else void send('noticeAction', { notice: kind, action: String(arg.action ?? ''), ...(tabId != null ? { tabId } : {}) });
      return true;
    },
    /** One of the overlay's own notices (`local` in shared/notices.ts), put up. */
    say(kind: string) { return NOTICES[kind]?.local ? put(kind) : false; },
    /** The notice up now, as the runtime draws it (for a runtime made again: a new theme). */
    view: () => (current ? viewOf(current) : null),
    /** Which notice is up, and about which tab. */
    get current() { return current ? { kind: current.kind, tabId: current.tabId } : null; },
    destroy: () => clear(false),
  };
}

// The trackpad gestures Margin runs in pages (content/trackpad.ts): their
// feedback, told by the page through the copy (`push` `gesture`) and drawn by
// the theme (the view model's `gesture`). A gesture's last word goes after
// a moment (a lifted pull reloads, a swipe goes back or forward: the loading
// indicator takes over); one let go of before it would do anything goes back
// out (`leaving`, GESTURE_LEAVE_MS); one whose updates stop (a word lost on
// the way, the page gone) goes after STALE_MS.
// Only a change of what it is (its kind, state, way) is `set` (the UI drawn
// again); how far it's gone goes to `progress` with every word, eased there
// every frame without drawing anything again (ui/gesture-motion.ts; seen
// 2026-11-08: it looked jumpy).
export const GESTURE_DONE_MS = 450;
export const GESTURE_LEAVE_MS = 220;
export const GESTURE_STALE_MS = 1000;

/**
 * `set(gesture)`: the runtime's `gesture` (null: none). `progress(value, fresh)`: how far it's gone (0 to 1), `fresh`
 * for a gesture just shown (it starts from there).
 * */
export function createGestureFeedback({ set, progress: moved = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }: { set: (gesture: { kind: 'pull' | 'swipe', state: 'pulling' | 'armed' | 'done' | 'leaving', progress: number, direction: number } | null) => void, progress?: (value: number, fresh: boolean) => void, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (timer: any) => void }) {
  let shown: { kind: 'pull' | 'swipe', state: 'pulling' | 'armed' | 'done' | 'leaving', progress: number, direction: number } | null = null;
  let timer: any = null; // (setTimer's: the caller's own timers in tests)
  const off = () => {
    clearTimer(timer);
    timer = null;
    if (shown) set((shown = null));
    moved(0, true);
  };
  return {
    /** A page's gesture as it goes: { kind, state: 'idle' | 'pulling' | 'armed' | 'trigger', progress, direction }. */
    push(msg: any) {
      const kind = msg?.kind === 'pull' || msg?.kind === 'swipe' ? msg.kind : null;
      if (!kind || msg.state === 'idle' || !['pulling', 'armed', 'trigger'].includes(msg.state)) {
        // Let go of before it would do anything: back out, not gone at once.
        if (!shown || shown.state === 'done' || shown.state === 'leaving') return shown?.state === 'leaving' ? undefined : off();
        clearTimer(timer);
        set((shown = { ...shown, state: 'leaving' }));
        moved(0, false);
        timer = setTimer(off, GESTURE_LEAVE_MS);
        return;
      }
      clearTimer(timer);
      const done = msg.state === 'trigger';
      const progress = done ? 1 : Math.max(0, Math.min(1, Number(msg.progress) || 0));
      const next = { kind, state: done ? 'done' : msg.state, progress, direction: kind === 'swipe' ? (Number(msg.direction) > 0 ? 1 : -1) : 0 };
      const fresh = !shown || shown.kind !== next.kind || shown.state === 'leaving';
      const changed = fresh || shown!.state !== next.state || shown!.direction !== next.direction; // (not fresh: one shown)
      moved(progress, fresh);
      shown = next;
      if (changed) set(shown);
      timer = setTimer(off, done ? GESTURE_DONE_MS : GESTURE_STALE_MS);
    },
    clear: off,
    get shown() { return shown; },
  };
}
