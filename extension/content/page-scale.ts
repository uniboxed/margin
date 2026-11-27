// Whether Safari draws this page shrunk to fit its window (a diagnostic for Margin.app's log, 2026-11-26): its layout
// wider than the window, the whole page scaled down (`visualViewport.scale` below 1, `devicePixelRatio` with it). A
// tab on the real Mac stayed so after a drag of the sidebar's edge (laid out 1392 wide in a 1212 pt tile, scale 0.87,
// through a reload, ⌘0 and a pinch; a new tab at the same width was whole). Told when it starts and when it ends, with
// the sizes and whether the page is shown, so the step that left it is found beside Margin.app's own lines. A pinch
// only magnifies on the Mac (scale above 1): never told. Called by content/core.ts while Margin.app draws Margin
// around the window (`on`); nothing is said otherwise.

// Below this the page counts as shrunk (a rounding of 1 isn't).
export const SHRUNK_BELOW = 0.995;

export type PageScaleReport = { scale: number, inner: number, outer: number, dpr: number, shown: boolean };

export function startPageScale({ on, send, win = globalThis }: { on: () => boolean, send: (type: 'pageScale', payload: PageScaleReport) => unknown, win?: any }) {
  // (What was last told: none yet, a page that starts shrunk is told at once.)
  let told = false;
  const check = () => {
    const vv = win.visualViewport;
    if (!vv || !Number.isFinite(vv.scale)) return;
    const shrunk = vv.scale < SHRUNK_BELOW;
    if (shrunk === told || !on()) return;
    told = shrunk;
    const round = (v: number) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : -1);
    send('pageScale', { scale: round(vv.scale), inner: round(win.innerWidth), outer: round(win.outerWidth), dpr: round(win.devicePixelRatio), shown: win.document?.visibilityState === 'visible' });
  };
  win.visualViewport?.addEventListener('resize', check);
  win.addEventListener('resize', check);
  win.document?.addEventListener('visibilitychange', check);
  check();
  return { check };
}
