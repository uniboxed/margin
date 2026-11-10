// <body>'s scrolling in the box (box.ts) and the page's scroll locks, and
// <body>'s background on <body>. In the box, <body> is what scrolls, so what a
// page says to stop or start scrolling, on <html> or <body>, is said for <body>.
import { bodyBackgroundCss } from '../../shared/page-box.ts';

/** @param ctx the box's shared parts (box.ts) */
export function startLocks(ctx: any) {
  const { box, own } = ctx;
  // What the page says about overflow reads back as computed style: html's
  // rule here has no weight (:where), and body's is only added once it says
  // nothing. Read, rather than a sheet taken away to look, which makes a large
  // page lay out again (69 ms on Reddit).
  let scrollCss = '';
  let wasPinned = false;
  // Our rule on each side: what it sets, and whether it has to win.
  const rule = { x: { value: '', said: '', forced: false, force: false }, y: { value: '', said: '', forced: false, force: false } };
  function checkLocks() {
    const { body } = document;
    if (!box.on || !body || body.localName !== 'body') return;
    for (const fn of box.onBeforeRead) fn(); // sheets.ts: what's said about overflow as the box's queries say it
    const root = getComputedStyle(ctx.html);
    // The page's own overflow-x on <html> (hidden, auto, scroll) would make the box's clip up and down hidden, which
    // reads below as the page locking <html>: then the box clips only sideways, and what the page says up and down
    // shows (nothing: auto). Said once a page sets or drops it (a layout of <html> then, not at every check).
    own.setRootClipsY(!/hidden|auto|scroll/.test(root.overflowX));
    // The page's `overflow: scroll` on <html> shows the window's scroll bars. Where scroll bars take space, those
    // are hidden and <body>'s show, always, as a window's would (box-bars.ts): `scroll` for it, below.
    ctx.scrollBars.rootSays(root.overflowX === 'scroll' || root.overflowY === 'scroll');
    const scrolls = (rootSays: string) => (rootSays === 'scroll' && ctx.scrollBars.classic() ? 'scroll' : 'auto');
    // A lock that pins <body> (fixed, top: -Ypx) can't be read in computed style
    // (the box's rule holds it relative) and doesn't stop <body> scrolling: its
    // style attribute says so, and <body> is locked where it is.
    const pinned = body.style.position === 'fixed' || parseFloat(body.style.top) < 0;
    if (wasPinned && !pinned) { // our lock mustn't read as the page's
      own.replace(own.sheets.scroll, '');
      scrollCss = '';
    }
    wasPinned = pinned;
    const mine = getComputedStyle(body);
    checkBackground(mine);
    // One side's rule. What the page says shows, unless it's our own rule's
    // value, which stands for the page saying nothing. Forced, its value hides
    // what the page says: what it said then stands.
    const side = (ours: { value: string; said: string; forced: boolean; force: boolean; }, shown: string, rootSays: string) => {
      const said = ours.forced ? ours.said : ours.value && shown === ours.value ? 'visible' : shown;
      // Nothing said: as <html> says. It locks the window: locked with it.
      if (said === 'visible') Object.assign(ours, { value: rootSays === 'hidden' ? 'hidden' : scrolls(rootSays), said, forced: ours.force });
      // <html> scrolls and body only clips: in the box, body is what scrolls.
      else if (said === 'hidden' && /auto|scroll/.test(rootSays)) Object.assign(ours, { value: scrolls(rootSays), said, forced: true });
      else Object.assign(ours, { value: '', said, forced: false, force: false });
      return ours.value && `${ours.value}${ours.forced ? ' !important' : ''}`;
    };
    const y = pinned ? 'hidden !important' : side(rule.y, mine.overflowY, root.overflowY);
    const x = side(rule.x, mine.overflowX, root.overflowX);
    const parts = [y && `overflow-y: ${y}`, x && `overflow-x: ${x}`].filter(Boolean);
    // No weight, so the page's own rule can be seen; forced, it has to beat
    // even a page's `body { overflow: visible !important }`.
    const forced = pinned || rule.x.forced || rule.y.forced;
    const css = parts.length ? `@media screen { ${forced ? 'html > body:where(:first-of-type)' : ':where(html > body:where(:first-of-type))'} { ${parts.join('; ')} } }` : '';
    if (css !== scrollCss) own.replace(own.sheets.scroll, css);
    scrollCss = css;
    // A page's own `overflow: visible` beats a rule with no weight: said again, to win.
    const after = getComputedStyle(body);
    if (pinned) return;
    const lost = (ours: { value: string; said: string; forced: boolean; force: boolean; }, shown: string) => !!ours.value && !ours.forced && shown === 'visible';
    if (!lost(rule.y, after.overflowY) && !lost(rule.x, after.overflowX)) return;
    rule.y.force ||= lost(rule.y, after.overflowY);
    rule.x.force ||= lost(rule.x, after.overflowX);
    checkLocks();
  }

  // <body>'s background on <body>, not the canvas (shared/page-box.ts bodyBackgroundCss).
  let backCss = '';
  function checkBackground(style: CSSStyleDeclaration) {
    const css = bodyBackgroundCss(style);
    if (css !== backCss) own.replace(own.sheets.back, css);
    backCss = css;
  }

  // A new <body>: what was said about the old one mustn't read as the new one's.
  function forgetBody() {
    own.replace(own.sheets.scroll, '');
    scrollCss = '';
    for (const ours of [rule.x, rule.y]) Object.assign(ours, { value: '', said: '', forced: false, force: false });
  }
  // The box off: nothing of these left.
  function reset() {
    forgetBody();
    own.replace(own.sheets.back, '');
    backCss = '';
  }

  return { checkLocks, forgetBody, reset };
}
