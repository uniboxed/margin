// The page's part in the scroll record (docs/DATA.md "The scroll record", background/scroll-record.ts):
// where the page is scrolled, said to the background as it's hidden (at most every EVERY_MS, the last
// one after that) and as it's left, only when it moved, so a tab Margin closes and keeps (a window
// closed by Margin.app's switch, a tab put to sleep) opens there again. Reopened, the page takes that
// place once: asked when its tab's record says there is one (`restoreScroll`), then set as soon as the
// document is parsed and again while the page grows, until it's there, the person scrolls, types or
// clicks, or RESTORE_MS pass. <html> scrolls the page, or <body> while Margin's page box is on
// (content/page/viewport.ts). Nothing about the page is logged.

const EVERY_MS = 1000;
const RESTORE_MS = 5000;
const AGAIN_MS = 200;
const ACTS = ['wheel', 'keydown', 'pointerdown', 'touchstart'];

export function startScrollRecord({ send, retired, boxed, doc = globalThis.document, win = globalThis, everyMs = EVERY_MS, restoreMs = RESTORE_MS }: { send: (type: any, payload: any, retry?: boolean) => Promise<any>, retired: () => boolean, boxed: () => boolean,
  doc?: any, win?: any, everyMs?: number, restoreMs?: number }) {
  const scrolled = () => Math.round(Math.max(doc.scrollingElement?.scrollTop ?? 0, doc.body?.scrollTop ?? 0));
  let said = 0; // a page never scrolled says nothing
  let saidAt = -Infinity;
  let timer: Timer | null = null;
  function tell(now = false) {
    clearTimeout(timer);
    if (retired()) return;
    const y = scrolled();
    if (y === said) return;
    const wait = saidAt + everyMs - Date.now();
    if (!now && wait > 0) {
      timer = setTimeout(() => tell(), wait);
      return;
    }
    said = y;
    saidAt = Date.now();
    void send('pageScroll', { y, url: win.location.href }, false);
  }
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') tell(); });
  win.addEventListener('pagehide', () => tell(true));

  let asked = false;
  // The tab's record says it has a place to take (state/model.ts linkKept): asked once.
  function take(has: boolean) {
    if (asked || !has || retired()) return;
    asked = true;
    void send('takeScroll', { url: win.location.href }, false).then((y) => { if (Number.isFinite(y) && y > 0) restore(y); }, () => {});
  }
  function restore(y: number) {
    const until = Date.now() + restoreMs;
    let again: Timer | null = null;
    const stop = () => {
      clearTimeout(again);
      for (const type of ACTS) win.removeEventListener(type, stop, true);
      doc.removeEventListener('DOMContentLoaded', go);
    };
    function go() {
      if (retired()) return stop();
      const el = boxed() && doc.body ? doc.body : doc.scrollingElement;
      if (el) el.scrollTop = y;
      if (scrolled() >= y - 2 || Date.now() > until) return stop();
      again = setTimeout(go, AGAIN_MS); // the page not that tall yet
    }
    for (const type of ACTS) win.addEventListener(type, stop, { capture: true, passive: true });
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', go, { once: true });
    else go();
  }
  return { tell, take };
}
