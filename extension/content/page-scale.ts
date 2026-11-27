// Whether Safari draws this page shrunk to fit its window (a diagnostic for Margin.app's log, 2026-11-26): its layout
// wider than the window, the whole page scaled down (`visualViewport.scale` below 1, `devicePixelRatio` with it). A
// tab on the real Mac stayed so after a drag of the sidebar's edge (laid out 1392 wide in a 1212 pt tile, scale 0.87,
// through a reload, ⌘0 and a pinch; a new tab at the same width was whole). Told when it starts and when it ends, with
// the sizes and whether the page is shown, so the step that left it is found beside Margin.app's own lines. A pinch
// only magnifies on the Mac (scale above 1): never told. Called by content/core.ts while Margin.app draws Margin
// around the window (`on`); nothing is said otherwise.

// Below this the page counts as shrunk (a rounding of 1 isn't).
export const SHRUNK_BELOW = 0.995;

// `n`: its count in this page (Margin.app's log keeps one of the same line a minute: each one told is its own).
export type PageScaleReport = { n: number, scale: number, inner: number, outer: number, dpr: number, shown: boolean };

export function startPageScale({ on, send, win = globalThis }: { on: () => boolean, send: (type: 'pageScale', payload: PageScaleReport) => unknown, win?: any }) {
  // (What was last told: none yet, a page that starts shrunk is told at once.)
  let told = false;
  let n = 0;
  const check = () => {
    const vv = win.visualViewport;
    if (!vv || !Number.isFinite(vv.scale)) return;
    const shrunk = vv.scale < SHRUNK_BELOW;
    if (shrunk === told || !on()) return;
    told = shrunk;
    send('pageScale', { n: ++n, scale: round(vv.scale), inner: round(win.innerWidth), outer: round(win.outerWidth), dpr: round(win.devicePixelRatio), shown: win.document?.visibilityState === 'visible' });
  };
  win.visualViewport?.addEventListener('resize', check);
  win.addEventListener('resize', check);
  win.document?.addEventListener('visibilitychange', check);
  check();

  // Margin.app laying a narrowed Safari tile out again after a drag (HostEngine `relayNarrowed`, background handlers
  // `hostPageLayout`): the page's own word on its layout, so the screen is held still exactly until the page is drawn
  // at its width, never for a guessed time. Asked with nothing to wait for: answered now. `whole`: once Safari draws it
  // whole (scale at least SHRUNK_BELOW); `below`: once it's whole and laid out narrower than that (its next layout, a
  // tile set narrower in one step). Answered after the frame that draws it (two animation frames: the first's paint
  // done), with `met`; at `deadline` (ms since 1970, Margin.app's cap) answered as it is, `met: false`.
  const layout = ({ whole = false, below = null, deadline = 0 }: { whole?: boolean, below?: number | null, deadline?: number }): Promise<PageLayout> => {
    const now = (): PageLayout => {
      const scale = win.visualViewport?.scale;
      return { scale: Number.isFinite(scale) ? round(scale) : -1, inner: round(win.innerWidth), met: false };
    };
    const ok = (l: PageLayout) => l.scale >= SHRUNK_BELOW && (below == null || l.inner < below);
    if (!whole && below == null) return Promise.resolve({ ...now(), met: true });
    return new Promise((resolve) => {
      let done = false;
      let drawing = false;
      const finish = (l: PageLayout) => {
        if (done) return;
        done = true;
        win.visualViewport?.removeEventListener('resize', look);
        win.removeEventListener('resize', look);
        win.clearTimeout?.(timer);
        resolve(l);
      };
      // (Met: answered once the frame that draws it is done; looked at again then, as a later resize may undo it.)
      function look() {
        if (done || drawing || !ok(now())) return;
        drawing = true;
        win.requestAnimationFrame(() => win.requestAnimationFrame(() => {
          drawing = false;
          const l = now();
          if (ok(l)) finish({ ...l, met: true });
        }));
      }
      const timer = win.setTimeout(() => finish(now()), Math.max(0, deadline - Date.now()));
      win.visualViewport?.addEventListener('resize', look);
      win.addEventListener('resize', look);
      look();
    });
  };
  return { check, layout };
}

// The page's layout as told to Margin.app's relay (`layout`): its scale, its layout width (CSS px), and whether what was
// asked for was met.
export type PageLayout = { scale: number, inner: number, met: boolean };

const round = (v: number) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : -1);
