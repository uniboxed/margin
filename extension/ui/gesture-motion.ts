// How far a trackpad gesture in the page has gone, as the theme draws it
// (Margin.app's overlay: app/shared/host/overlay.ts). The page says it at most
// once a frame, a frame or two late, through the copy (content/trackpad.ts
// gestureTeller, ui/app-feedback.ts createGestureFeedback); drawn as said, the
// badge moved in jumps (Tirth, 2026-11-08). So it's eased toward what was
// last said, every display frame, and written as one CSS custom property
// (`apply`: --gesture-live on the overlay's root, which the themes' gesture
// badges read, falling back to the view model's `gesture.progress`), with
// nothing of the UI drawn again. Each frame closes the same share of what's
// left (TAU_MS: about two thirds in that long), so it never overshoots and
// keeps up with fingers moving fast; settled, the frames stop.

export const TAU_MS = 40;
const SETTLED = 0.002;

export function createGestureMotion({ apply, raf = (fn) => requestAnimationFrame(fn), caf = (id) => cancelAnimationFrame(id), now = () => performance.now(), tau = TAU_MS }: { apply: (value: number) => void, raf?: (fn: (t: number) => void) => any, caf?: (id: any) => void, now?: () => number, tau?: number }) {
  let current = 0;
  let target = 0;
  let frame: unknown = null; // (raf's)
  let last = 0;
  const step = () => {
    frame = null;
    const t = now();
    const dt = Math.max(0, Math.min(64, t - last)); // (a frame late after a stall: no jump past it)
    last = t;
    current += (target - current) * (1 - Math.exp(-dt / tau));
    if (Math.abs(target - current) < SETTLED) current = target;
    apply(current);
    if (current !== target) frame = raf(step);
  };
  return {
    /** Toward `value` (0 to 1); `snap`: there at once (a gesture just shown starts where the page says). */
    to(value: number, snap: boolean = false) {
      target = Math.max(0, Math.min(1, Number(value) || 0));
      if (snap) {
        if (frame != null) caf(frame);
        frame = null;
        current = target;
        apply(current);
        return;
      }
      if (frame == null && current !== target) {
        last = now();
        frame = raf(step);
      }
    },
    get value() { return current; },
    get moving() { return frame != null; },
    stop() {
      if (frame != null) caf(frame);
      frame = null;
    },
  };
}
