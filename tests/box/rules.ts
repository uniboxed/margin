// What the page box promises (extension/content/page/, shared/page-box.ts), as
// rules every page pattern is held to (README.md). A page in its box beside Margin's
// sidebar must be what it would be in a plain window the box's size: the same
// layout, the same answers to what it asks, and the window itself never moved.
//
// Two functions, each self-contained (no imports, nothing from outside its own
// body), so a runner can send their source into a page as it is: the e2e test
// runs them through Playwright, the WebKit host pastes them into a check.
//   measure()                 in a page: what it looks like and was told
//   judge(boxed, plain, setup) the broken rules, as lines (empty: all kept)
// `plain` is the same page measured in a plain window of the box's size: an
// iframe that size (tests/box/serve.ts /ref/), in the same browser.

/** The rules, by id, for the README and for a pattern's `allow:`. */
export const RULES = Object.freeze({
  'box-at-slot': "<html> is drawn at the slot's corner (the box's place beside the sidebar)",
  'box-size': "<html> is the slot's size: whatever the page says about <html>'s size, place or margins",
  'told-size': 'what the page is told its window is (innerWidth, innerHeight) is the box it is drawn in',
  'window-still': "the window itself never scrolls: <body> does (a page focusing something out of sight mustn't slide the box)",
  'same-scroller': 'document.scrollingElement is what it is in a plain window (<html>, its scrolling speaking for <body>, which scrolls in the box), and says the window\'s height',
  'no-overflow': 'nothing runs past the box sideways that wouldn\'t run past a plain window',
  'same-layout': 'every element is where, and the size, it is in a plain window (as the page sees it)',
  'same-scroll': 'the page is scrolled where it would be in a plain window',
  'same-answers': 'what the page wrote down in its <output>s (media queries, sizes, events) is what it writes in a plain window',
});

/** In a page. */
export function measure() {
  const de = document.documentElement;
  const body = document.body;
  const cs = getComputedStyle(de);
  const t = cs.transform;
  const m = t && t !== 'none' ? new DOMMatrix(t) : null;
  const round = (n: number) => Math.round(n);
  // A key for an element that's the same in both loads: its id, or its path of
  // tag and place from <body>.
  const keyOf = (el: Element) => {
    if (el.id) return `#${el.id}`;
    const parts: string[] = [];
    for (let at: Element | null = el; at && at !== body && at !== de; at = at.parentElement) {
      if (at.id) { parts.unshift(`#${at.id}`); break; }
      let n = 1;
      for (let s = at.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === at.localName) n += 1;
      parts.unshift(`${at.localName}:${n}`);
    }
    return parts.join('>');
  };
  const els: Record<string, number[]> = {};
  let count = 0;
  for (const el of body ? body.querySelectorAll('*') : []) {
    if (count >= 400) break;
    const name = el.localName;
    if (name === 'script' || name === 'style' || name === 'template' || name.startsWith('margin-')) continue;
    const b = el.getBoundingClientRect();
    if (!b.width && !b.height) continue;
    els[keyOf(el)] = [round(b.left), round(b.top), round(b.width), round(b.height)];
    count += 1;
  }
  const out: Record<string, string | null> = {};
  for (const o of document.querySelectorAll('output[id]')) out[o.id] = o.textContent;
  const scroller = document.scrollingElement;
  // What a scroller trims sideways (overflow-x hidden or clip) can't be scrolled to, though scrollWidth counts it. In the
  // box <html> clips and <body> scrolls, <html>'s scrolling speaking for it: <body>'s overflow is the one that counts.
  const scrolls = scroller === de && body && getComputedStyle(de).overflowX === 'clip' && getComputedStyle(body).overflowX !== 'visible' ? body : scroller;
  const clipsX = !!scrolls && /hidden|clip/.test(getComputedStyle(scrolls).overflowX);
  const vv = window.visualViewport;
  return {
    told: { w: innerWidth, h: innerHeight, sx: round(scrollX), sy: round(scrollY) },
    // As drawn: the transform's offset in the window, and <html>'s own size.
    root: { x: m ? m.e : 0, y: m ? m.f : 0, w: round(parseFloat(cs.width)), h: round(parseFloat(cs.height)) },
    // The window's own scroll (the layout viewport's), which no shim speaks for.
    window: { left: vv ? round(vv.pageLeft - vv.offsetLeft) : 0, top: vv ? round(vv.pageTop - vv.offsetTop) : 0, scale: vv ? vv.scale : 1 },
    scroller: scroller === body ? 'body' : scroller === de ? 'html' : String(scroller && scroller.localName),
    scrollerHeight: scroller ? round(scroller.clientHeight) : 0,
    overflowX: scroller && !clipsX ? round(scroller.scrollWidth - scroller.clientWidth) : 0,
    els,
    out,
  };
}

/** What measure() gives: a page as drawn. */
export type Shot = ReturnType<typeof measure>;

/**
 * The rules a boxed page broke, compared with the same page plain.
 * */
export function judge(boxed: Shot, plain: Shot, setup: { slot: { left: number, top: number, right: number, bottom: number }, window: { w: number, h: number }, allow?: string[] }): string[] {
  const fails: string[] = [];
  const allow = new Set(setup.allow || []);
  const off = (rule: string, key?: string) => allow.has(rule) || (key != null && allow.has(`${rule} ${key}`));
  const near = (a: number, b: number, by: number) => Math.abs(a - b) <= by;
  const { slot } = setup;
  const w = setup.window.w - slot.left - slot.right;
  const h = setup.window.h - slot.top - slot.bottom;
  const say = (rule: string, text: string) => { if (!off(rule)) fails.push(`${rule}: ${text}`); };
  if (!near(boxed.root.x, slot.left, 0.5) || !near(boxed.root.y, slot.top, 0.5)) say('box-at-slot', `<html> at ${boxed.root.x},${boxed.root.y}, the slot at ${slot.left},${slot.top}`);
  if (!near(boxed.root.w, w, 1) || !near(boxed.root.h, h, 1)) say('box-size', `<html> ${boxed.root.w}×${boxed.root.h}, the slot ${w}×${h}`);
  if (!near(boxed.told.w, boxed.root.w, 1) || !near(boxed.told.h, boxed.root.h, 1)) say('told-size', `told ${boxed.told.w}×${boxed.told.h}, drawn ${boxed.root.w}×${boxed.root.h}`);
  if (boxed.window.left !== 0 || boxed.window.top !== 0) say('window-still', `the window scrolled to ${boxed.window.left},${boxed.window.top}`);
  if (boxed.scroller !== plain.scroller || !near(boxed.scrollerHeight, plain.scrollerHeight, 1)) say('same-scroller', `the scroller is <${boxed.scroller}>, ${boxed.scrollerHeight} high; plain <${plain.scroller}>, ${plain.scrollerHeight}`);
  if (boxed.overflowX > plain.overflowX + 1) say('no-overflow', `${boxed.overflowX}px past the box sideways, ${plain.overflowX}px plain`);
  if (!off('same-layout')) {
    const moved: string[] = [];
    for (const [key, r] of Object.entries(plain.els)) {
      if (off('same-layout', key)) continue;
      const b = boxed.els[key];
      if (!b) { moved.push(`${key} missing`); continue; }
      if (!r.every((v, i) => near(v, b[i], 2))) moved.push(`${key} at ${b.join(',')}, plain ${r.join(',')}`);
    }
    if (moved.length) fails.push(`same-layout: ${moved.length} element(s): ${moved.slice(0, 3).join('; ')}${moved.length > 3 ? '; …' : ''}`);
  }
  if (!near(boxed.told.sx, plain.told.sx, 1) || !near(boxed.told.sy, plain.told.sy, 1)) say('same-scroll', `scrolled ${boxed.told.sx},${boxed.told.sy}, plain ${plain.told.sx},${plain.told.sy}`);
  if (!off('same-answers')) {
    for (const [id, text] of Object.entries(plain.out)) {
      if (off('same-answers', id) || boxed.out[id] === text) continue;
      fails.push(`same-answers: #${id} says "${boxed.out[id]}", plain "${text}"`);
    }
  }
  return fails;
}
