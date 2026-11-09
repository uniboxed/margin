// ScrollTimeline for the box: a page's scroll-linked animation on the document's
// scroll. In a window the document scrolls on <html>; in the box <body> does
// (box.ts), so a timeline on <html> is inactive (its currentTime null), and a
// page that reads that as its end puts things there (cxense.com: Framer's motion
// put its fixed hero 1000px up, a blank page). A timeline the page asks for on
// <html>, or with no source (the browser's own default, the document's scroller:
// <html>), is made on the box's scroller instead, as the browser's own timeline,
// so it's still a ScrollTimeline to the page. Any other source is left alone.
// One made while there's a box keeps its source if the box goes.
// Pattern: tests/box/patterns/scroll-timeline.html.
import type { Box } from './box.ts';

export function startTimelines(box: Box) {
  const Native = window.ScrollTimeline;
  if (!Native) return;
  function Boxed(...args: any[]) {
    if (!new.target) throw new TypeError("Failed to construct 'ScrollTimeline': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    const options = args[0] ?? {};
    const html = document.documentElement;
    const asked = !('source' in options) || options.source === undefined ? html : options.source;
    const source = box.boxed() && asked === html ? box.body() : asked;
    return Reflect.construct(Native, [source === options.source ? options : { ...options, source }, ...args.slice(1)], new.target === Boxed ? Native : new.target);
  }
  Boxed.prototype = Native.prototype;
  Native.prototype.constructor = Boxed;
  Object.defineProperty(Boxed, 'name', { value: 'ScrollTimeline' });
  Object.defineProperty(Boxed, 'length', { value: Native.length });
  window.ScrollTimeline = (Boxed as any);
}
