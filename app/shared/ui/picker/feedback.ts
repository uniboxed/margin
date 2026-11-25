// Edit Theme Color's ticks (M2.9 step 6, docs/SPACE-BACKGROUNDS.md Part B §6): at each detent of its controls (the
// dial's steps, the slider's tenths, a texture, an appearance, a colour more or fewer: ui/picker/controls.ts, view.ts),
// a haptic where the person's finger is on a trackpad that plays them, else a short click, generated (no file).
// - What plays is `tickPlays`, pure (the tests' table): the setting (`pickerFeedback`: auto, haptics, sound, off), the
//   device the host says the gesture comes from (Margin.app on the Mac: app/platforms/macos/shell/PointerKind.swift;
//   none elsewhere: a browser's extension, Windows), whether a trackpad that plays haptics is there, and whether the
//   system plays its interface sounds. Auto: a haptic on a trackpad that plays them, else a click. Haptics: a haptic
//   where one can play, never a click. Sound: a click. Off, or the system's interface sounds off: no click.
// - A haptic is Margin.app's (`haptic.alignment` for a detent or a step, `haptic.level` for a texture: its
//   `.levelChange`); a click is WebAudio's, a few milliseconds of a sine dropping away, lower for a texture.
// - At most one every TICK_GAP_MS (20 ms): a fast drag over many detents is a buzz, not a pile.
// - The audio starts only with the person's gesture (WebKit's rule): made ready as the picker opens (it opens from a
//   click) and at each press in it (`prime`).
import type { TickKind } from './words.ts';

export type FeedbackSetting = 'auto' | 'haptics' | 'sound' | 'off';
export const FEEDBACK_SETTINGS: readonly FeedbackSetting[] = Object.freeze(['auto', 'haptics', 'sound', 'off']);
export const FEEDBACK_NAMES: Readonly<Record<FeedbackSetting, string>> = Object.freeze({
  auto: 'Automatic: haptics on a trackpad, a click with a mouse', haptics: 'Haptics only', sound: 'A click', off: 'Off',
});
/** The setting as stored, read (anything else: auto). */
export const feedbackSetting = (v: unknown): FeedbackSetting => (FEEDBACK_SETTINGS.includes(v as FeedbackSetting) ? v as FeedbackSetting : 'auto');

export type PointerKind = 'trackpad' | 'mouse';
/** What the host knows of the device (Margin.app on the Mac): the gesture's (null: not told yet), whether a trackpad
 *  that plays haptics is there, whether the system plays its interface sounds. */
export type FeedbackDevice = { pointer: PointerKind | null, haptics: boolean, uiSounds: boolean };
/** The device as Margin.app says it (`pointerKind`), read; null for what isn't one. */
export function deviceOf(msg: unknown): FeedbackDevice | null {
  const m = msg as { kind?: unknown, haptics?: unknown, uiSounds?: unknown } | null;
  if (!m || typeof m !== 'object') return null;
  return { pointer: m.kind === 'trackpad' || m.kind === 'mouse' ? m.kind : null, haptics: m.haptics === true, uiSounds: m.uiSounds !== false };
}

export const TICK_GAP_MS = 20;

export type Play = { kind: 'haptic', pattern: 'alignment' | 'level' } | { kind: 'sound', low: boolean } | null;

/** What a tick plays, for the setting and the device (none: a host that knows none, which plays no haptics). */
export function tickPlays(tick: TickKind, setting: FeedbackSetting, device: FeedbackDevice | null): Play {
  if (setting === 'off') return null;
  const haptic: Play = device?.haptics ? { kind: 'haptic', pattern: tick === 'texture' ? 'level' : 'alignment' } : null;
  const sound: Play = !device || device.uiSounds ? { kind: 'sound', low: tick === 'texture' } : null;
  if (setting === 'haptics') return haptic;
  if (setting === 'sound') return sound;
  return haptic && device?.pointer === 'trackpad' ? haptic : sound;
}

type Audio = { state: string, currentTime: number, destination: AudioNode, resume(): Promise<void>, close(): Promise<void>, createOscillator(): OscillatorNode, createGain(): GainNode };

export function createTickFeedback({ win, setting, device, haptic, now = () => win.performance.now() }: {
  win: Window,
  setting: () => FeedbackSetting,
  device: () => FeedbackDevice | null,
  /** Margin.app's haptic (false: the host plays none). */
  haptic: (pattern: 'alignment' | 'level') => unknown,
  now?: () => number,
}) {
  let last = -Infinity;
  let ctx: Audio | null = null;
  const played = { haptic: 0, sound: 0 };
  function audio(): Audio | null {
    if (ctx) return ctx;
    const A = (win as unknown as { AudioContext?: new () => Audio, webkitAudioContext?: new () => Audio }).AudioContext
      ?? (win as unknown as { webkitAudioContext?: new () => Audio }).webkitAudioContext;
    if (!A) return null;
    try { ctx = new A(); } catch { return null; }
    return ctx;
  }
  const wake = (c: Audio) => { if (c.state === 'suspended') void c.resume().catch(() => {}); };
  function click(low: boolean) {
    const c = audio();
    if (!c) return;
    wake(c);
    const t = c.currentTime;
    const osc = c.createOscillator(), gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(low ? 1100 : 1700, t);
    osc.frequency.exponentialRampToValueAtTime(low ? 700 : 1100, t + 0.025);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.09, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.035);
  }
  return {
    /** A detent: what it played (null: nothing, or too soon after the last). */
    tick(kind: TickKind): Play {
      const play = tickPlays(kind, setting(), device());
      if (!play) return null;
      const t = now();
      if (t - last < TICK_GAP_MS) return null;
      last = t;
      if (play.kind === 'haptic') { played.haptic++; haptic(play.pattern); } else { played.sound++; click(play.low); }
      return play;
    },
    /** The person's gesture (the picker opened, a press in it): the audio made ready, where a click may play. */
    prime() {
      if (tickPlays('detent', setting(), device())?.kind !== 'sound') return;
      const c = audio();
      if (c) wake(c);
    },
    /** How many of each played (for the tests). */
    get played() { return { ...played }; },
    destroy() { void ctx?.close().catch(() => {}); ctx = null; },
  };
}
export type TickFeedback = ReturnType<typeof createTickFeedback>;
