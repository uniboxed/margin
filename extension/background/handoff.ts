// The windows calls Margin.app makes through this copy for the Safari windows it hosts
// (app/platforms/macos/shell/HostedSession.swift: `setWindowState`, `closeWindow`), one at a time per
// window and never past their `notAfter`.
//
// A windows call stuck behind a hung tab is carried out when Safari gets to it, and can't be taken
// back once made. So the app may give one a `notAfter` (checked as it arrives: past it, nothing is
// called), and a second call for a window while one with a `notAfter` is still pending is answered
// `busy` without calling Safari (link.ts windowCallRefusal). Both are ordinary answers: the app tells
// "nothing done" from a failure. A call with no `notAfter` (the host's closeWindow) runs as it always
// did, never late and never busy, but counts as pending. Ids only in the log.
import { appLink } from './app-link.ts';
import { windowCallRefusal } from './link.ts';
import { api } from './store.ts';

// Times (tests shorten them: setHandoffTiming).
const TIMING = {
  // setWindowState: Safari's word on the window looked at this often…
  pollMs: 100,
  // …until the state lands, at most this long.
  landMs: 3000,
  // A focus heard this soon after Margin's own windows call for the window (its start or its end) is
  // Margin's, not the person's.
  focusOwnMs: 1000,
};

// Windows with a windows call under way (setWindowState, closeWindow), and how many: the ones with a
// `notAfter` are one at a time; one without may overlap.
const pending: Map<number, number> = new Map();
const NONE = { has: () => false };
// When this copy last called Safari about each window for the app (start or end of the call).
const ownCallAt: Map<number, number> = new Map();
const touched = (windowId: number) => ownCallAt.set(windowId, Date.now());

// A windows call for the app: refused (late, or busy with another for that window) or run, with the
// window marked pending until Safari has answered. `what`: the request, for the log.
export async function windowCall<T>(what: string, message: { windowId: number, notAfter?: number }, call: () => Promise<T>): Promise<T | { refused?: string, pastMs?: number, busy?: boolean }> {
  const { windowId } = message;
  if (!Number.isInteger(windowId)) throw new Error('no window');
  const refusal = windowCallRefusal(message, typeof message.notAfter === 'number' ? pending : NONE);
  if (refusal) {
    appLink.note('refused' in refusal ? `${what} window ${windowId}: refused, ${refusal.pastMs} ms past notAfter` : `${what} window ${windowId}: busy (a windows call for it is still pending)`);
    return refusal;
  }
  pending.set(windowId, (pending.get(windowId) ?? 0) + 1);
  touched(windowId);
  try {
    return await call();
  } finally {
    const left = (pending.get(windowId) ?? 1) - 1;
    if (left > 0) pending.set(windowId, left);
    else pending.delete(windowId);
    touched(windowId);
  }
}

// setWindowState: the window to full screen or back to normal, focused only if asked. Then Safari's word on it every
// TIMING.pollMs until the state lands (a full-screen change animates), TIMING.landMs at most, and the
// window list sent at once so the app hears it without the list's 1 s wait. With `land: false` (Margin.app hosting
// the window, since 2026-11-17): answered as soon as Safari took the ask (`asked`), with no wait for the state. The
// app moves a window it hosts out of its new full-screen Space within ~0.2 s, so Safari never says `fullscreen` for it
// (every such ask sat out its 3 s and answered timedOut, the window `busy` for a next call meanwhile), and what the
// app goes by is the window server, never Safari's word on the state.
export async function setWindowState(message: { windowId: number, state: string, focused?: boolean, notAfter?: number, land?: boolean }) {
  const { windowId, state, focused = false } = message;
  if (state !== 'fullscreen' && state !== 'normal') throw new Error('no such window state');
  return windowCall('setWindowState', message, async () => {
    const started = Date.now();
    await api.windows.update(windowId, { state, ...(focused ? { focused: true } : {}) });
    if (message.land === false) {
      void appLink.windowsNow?.();
      appLink.note(`setWindowState window ${windowId}: ${state} asked (${Date.now() - started} ms)`);
      return { windowId, state, asked: true };
    }
    const landedAt = await stateLanded(windowId, state);
    void appLink.windowsNow?.();
    if (landedAt == null) {
      appLink.note(`setWindowState window ${windowId}: ${state} asked, not there in ${TIMING.landMs} ms`);
      return { windowId, state, timedOut: true };
    }
    appLink.note(`setWindowState window ${windowId}: ${state} in ${landedAt - started} ms`);
    return { windowId, state, landedAt };
  });
}
// When Safari first says the window is in `state` (Date.now()), or null: not within TIMING.landMs, or
// the window is gone.
async function stateLanded(windowId: number, state: string) {
  const until = Date.now() + TIMING.landMs;
  for (;;) {
    const win = await api.windows.get(windowId).catch(() => null);
    if (!win) return null;
    if (win.state === state) return Date.now();
    if (Date.now() >= until) return null;
    await new Promise<any>((resolve) => setTimeout(resolve, Math.min(TIMING.pollMs, Math.max(0, until - Date.now()))));
  }
}

// Whether Margin.app is moving the window now (a windows call under way, or one just made): tabs
// don't follow it meanwhile (background/away.ts).
export const handoffMoving = (windowId: number | null | undefined) => windowId != null
  && (pending.has(windowId) || Date.now() - (ownCallAt.get(windowId) ?? -Infinity) < TIMING.focusOwnMs);

// A window closed: nothing kept for it.
export function windowClosed(windowId: number) {
  ownCallAt.delete(windowId);
}

// For tests.
export function setHandoffTiming(given: Partial<typeof TIMING>) {
  Object.assign(TIMING, given);
}
