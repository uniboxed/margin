// A page's preview click (content/peek.ts) asked of Margin.app (docs/PEEK-SPLIT.md §2): the copy pushes
// `peekOpen { id, url, source, tabId, notAfter }` for the page's window, and Margin.app answers with the request
// `peekAnswer { id, ok }` (accepted: it shows the card; refused: not a window it hosts, nothing hosted there, ...).
// The page's click waits for this answer only until `notAfter` (its own time, a little under the page's own wait):
// no answer by then is a no, and the app is told `peekCancel { id }` (a card it opened late for it is closed again),
// so a link never opens twice, in the card and where the page would have opened it.
//
// Memory only, a few at a time: each one settles by its time.

export type PeekAnswers = ReturnType<typeof createPeekAnswers>;

export function createPeekAnswers({ now = () => Date.now(), later = (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown, cancel = (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>) } = {}) {
  const waiting = new Map<string, { settle: (ok: boolean | null) => void }>();
  let n = 0;
  return {
    /** A new id for a click. */
    id: () => `peek-${now().toString(36)}-${(n++).toString(36)}`,
    /** The app's answer for `id`, or null once `notAfter` passed without one. */
    wait(id: string, notAfter: number): Promise<boolean | null> {
      return new Promise((resolve) => {
        const left = Math.max(0, notAfter - now());
        const timer = later(() => { if (waiting.get(id)) { waiting.delete(id); resolve(null); } }, left);
        waiting.set(id, { settle: (ok) => { cancel(timer); waiting.delete(id); resolve(ok); } });
      });
    },
    /** The app's `peekAnswer`: false when no click waits for it any more (too late: the page opened the link). */
    answer(id: unknown, ok: unknown): boolean {
      const w = typeof id === 'string' ? waiting.get(id) : undefined;
      if (!w) return false;
      w.settle(ok === true);
      return true;
    },
    /** For the tests: clicks waiting now. */
    pending: () => waiting.size,
  };
}
