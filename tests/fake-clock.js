// A clock for tests (background/settle.js's Clock): time moves only on
// tick(ms), which runs the timers due by then in order, each at its time.
export function fakeClock(start = 1_000_000) {
  let t = start;
  let next = 1;
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const timers = new Map();
  return {
    now: () => t,
    set: (fn, ms) => { const id = next++; timers.set(id, { at: t + ms, fn }); return id; },
    clear: (id) => { timers.delete(id); },
    tick(ms) {
      const until = t + ms;
      for (;;) {
        const due = [...timers].filter(([, x]) => x.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = until;
    },
    pending: () => timers.size,
  };
}
