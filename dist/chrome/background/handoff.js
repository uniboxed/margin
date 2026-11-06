// This copy's part in Margin.app's profile handoff (app/HANDOFF.md §1.9, §2.5, §3.3, §6.1): the
// windows calls the app makes during a switch, one at a time per window and never past their
// `notAfter`, and what this copy tells the app about its parked windows (`parkedActivity`).
//
// A windows call stuck behind a hung tab is carried out when Safari gets to it, and can't be taken
// back once made. So the app gives each one a `notAfter` (checked as it arrives: past it, nothing is
// called), and a second call for a window while one is still pending is answered `busy` without
// calling Safari (link.js windowCallRefusal). Both are ordinary answers: the app tells "nothing done"
// from a failure. Today's close-based switch (app/shell/ProfileSwitch.swift) sends its focusWindow
// and closeWindow with no `notAfter`: those run as they always did, never late and never busy (its
// undo's close mustn't be dropped behind its own focus), but they count as pending, so a handoff's
// call for that window meanwhile is busy.
//
// A parked window is out of sight but alive: Safari can still put a tab there (a link from another
// app) or give it focus (its Window menu, ⌘`, the Dock's window list), and Margin's own UI can ask
// for a tab that's only there. None of these shows it. The copy tells the app, which hands off to
// that window: `tab` (a tab Margin didn't open), `focus` (not within TIMING.focusOwnMs of Margin's
// own windows call for it) and `raise` (background/tabs.js focusTab, which asks the app itself). Ids
// only in the log.
import { appLink } from './app-link.js';
import { windowCallRefusal } from './link.js';
import { api } from './store.js';
import { openedByMargin } from './tabs.js';

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

// Windows with a windows call under way (setWindowState, focusWindow, closeWindow), and how many:
// the handoff's are one at a time; today's switch's (no notAfter) may overlap.
/** @type {Map<number, number>} */
const pending = new Map();
const NONE = { has: () => false };
// When this copy last called Safari about each window for the app (start or end of the call).
/** @type {Map<number, number>} */
const ownCallAt = new Map();
const touched = (/** @type {number} */ windowId) => ownCallAt.set(windowId, Date.now());

// A windows call for the app: refused (late, or busy with another for that window) or run, with the
// window marked pending until Safari has answered. `what`: the request, for the log.
/**
 * @template T
 * @param {string} what
 * @param {{ windowId: number, notAfter?: number }} message
 * @param {() => Promise<T>} call
 * @returns {Promise<T | { refused?: string, pastMs?: number, busy?: boolean }>}
 */
export async function windowCall(what, message, call) {
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

// setWindowState: the window to full screen or back to normal, focused only if asked (A leaves full
// screen without taking focus: not focusWindow, which always focuses). Then Safari's word on it every
// TIMING.pollMs until the state lands (a full-screen change animates), TIMING.landMs at most, and the
// window list sent at once so the app hears it without the list's 1 s wait.
/** @param {{ windowId: number, state: string, focused?: boolean, notAfter?: number }} message */
export async function setWindowState(message) {
  const { windowId, state, focused = false } = message;
  if (state !== 'fullscreen' && state !== 'normal') throw new Error('no such window state');
  return windowCall('setWindowState', message, async () => {
    const started = Date.now();
    await api.windows.update(windowId, { state, ...(focused ? { focused: true } : {}) });
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
/** @param {number} windowId @param {string} state */
async function stateLanded(windowId, state) {
  const until = Date.now() + TIMING.landMs;
  for (;;) {
    const win = await api.windows.get(windowId).catch(() => null);
    if (!win) return null;
    if (win.state === state) return Date.now();
    if (Date.now() >= until) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(TIMING.pollMs, Math.max(0, until - Date.now()))));
  }
}

// ---- frameProbe ----------------------------------------------------------------------
// The window's tab in front asked to nudge and count its frames (shared/frame-probe.js: content
// scripts and Margin's new-tab page answer it): its answer with its tab, or `{ none: 'no page' }`
// when nothing answers within the probe's own timeoutMs (and a moment for the answer to come).
const PROBE_GRACE_MS = 50;
/** @param {number} windowId @param {{ width: number, height: number, frames: number, nudgeMs: number, timeoutMs: number }} request */
export async function probeWindow(windowId, request) {
  const started = Date.now();
  const timeoutMs = clamp(request.timeoutMs, 50, 3000, 400);
  const probe = {
    type: 'frameProbe', width: Number(request.width) || 0, height: Number(request.height) || 0,
    frames: clamp(request.frames, 1, 60, 6), nudgeMs: clamp(request.nudgeMs, 0, 1000, 80), timeoutMs,
  };
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs + PROBE_GRACE_MS); });
  const asked = (async () => {
    const [front] = await api.tabs.query({ active: true, windowId }).catch(() => []);
    if (!Number.isInteger(front?.id)) return { tabId: null, answer: null };
    const answer = await Promise.resolve(api.tabs.sendMessage(front.id, probe)).catch(() => null);
    return { tabId: front.id, answer };
  })();
  const got = /** @type {{ tabId: number | null, answer: any } | null} */ (await Promise.race([asked, late]).finally(() => clearTimeout(timer)));
  const answer = got?.answer;
  if (!got || !Number.isInteger(got.tabId) || !answer || typeof answer !== 'object' || !Number.isInteger(answer.frames)) {
    appLink.note(`frameProbe window ${windowId}: no page answered${Number.isInteger(got?.tabId) ? ` (tab ${got.tabId})` : ''} in ${Date.now() - started} ms`);
    return { none: 'no page' };
  }
  const { frames, firstAt, lastAt, width, height, hasFocus, visible, visibleAt } = answer;
  appLink.note(`frameProbe tab ${got.tabId}: ${frames} frames in ${Math.round(lastAt - firstAt)} ms at ${Math.round(width)}×${Math.round(height)}${hasFocus ? ', focused' : ''}${visible ? '' : ', hidden'}`);
  return { tabId: got.tabId, frames, firstAt, lastAt, width, height, hasFocus: hasFocus === true, visible: visible === true, ...(Number.isFinite(visibleAt) ? { visibleAt } : {}) };
}
/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback */
const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(/** @type {number} */ (value)))) : fallback);

// ---- parkedActivity ----------------------------------------------------------------
// Whether the app has parked the window (background/link.js, this epoch's word).
export const isParked = (/** @type {number | null | undefined} */ windowId) => windowId != null && appLink.parked?.(windowId) === true;

// A tab made in a parked window that Margin didn't open (a link from another app): the app hands off
// to that window. True when told.
/** @param {{ id?: number, windowId?: number } | null | undefined} tab */
export function tabCreated(tab) {
  if (!Number.isInteger(tab?.id) || !isParked(tab.windowId) || openedByMargin()) return false;
  return appLink.parkedActivity(/** @type {number} */ (tab.windowId), 'tab', tab.id);
}

// Focus landing on a parked window (windows.onFocusChanged), not Margin's own doing: the person
// chose it. True when told.
/** @param {number} windowId */
export function focusChanged(windowId) {
  if (!Number.isInteger(windowId) || windowId < 0 || !isParked(windowId)) return false;
  if (pending.has(windowId) || Date.now() - (ownCallAt.get(windowId) ?? -Infinity) < TIMING.focusOwnMs) {
    appLink.note(`focus heard on parked window ${windowId}: Margin's own windows call, not told`);
    return false;
  }
  return appLink.parkedActivity(windowId, 'focus');
}

// A window closed: nothing kept for it.
export function windowClosed(/** @type {number} */ windowId) {
  ownCallAt.delete(windowId);
}

// For tests.
/** @param {Partial<typeof TIMING>} given */
export function setHandoffTiming(given) {
  Object.assign(TIMING, given);
}
