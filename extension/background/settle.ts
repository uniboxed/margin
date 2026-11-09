// A change followed at once when it comes alone, and a burst of them (a
// sidebar dragged) followed once it's over: background/registered.ts
// layoutsChanged. `change()` says whether this change is a lone one (none
// in the `ms` before it: follow it now) and, whatever it says, (re)starts
// the wait: `settled` runs `ms` after the last change, so a burst always
// ends with its last value followed, the first followed at once at most.

export type Clock = { now: () => number, set: (fn: () => void, ms: number) => any, clear: (timer: any) => void };
export const realClock: Clock = { now: () => Date.now(), set: (fn, ms) => setTimeout(fn, ms), clear: (timer) => clearTimeout(timer) };

/**
 * @param ms how long with no change makes a change lone, and a burst over
 * @param settled run once a burst (or a lone change) is `ms` old
 * @param clock (tests: a fake one)
 */
export function settler(ms: number, settled: () => void, clock: () => Clock = () => realClock) {
  let last = -Infinity;
  let timer: any = null;
  let timerClock = (null as Clock | null);
  return {
    /** A change: whether it's a lone one (none in the `ms` before it). */
    change() {
      const c = clock();
      const at = c.now();
      const lone = at - last >= ms;
      last = at;
      if (timer != null) timerClock?.clear(timer);
      timerClock = c;
      timer = c.set(() => { timer = null; settled(); }, ms);
      return lone;
    },
    /** Whether a burst's last change is still to be followed. */
    pending: () => timer != null,
  };
}
