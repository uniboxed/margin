// The pinch on a page with a box: Margin's own, not Safari's, which would
// magnify the sidebar with the page. The page scales at <html> (the box, so
// what's fixed scales with it: content/page/box.js), its origin kept under the
// fingers, and the sidebar's host gets the opposite, so it stays where it is.
// Two fingers then move the zoomed page, and scroll it at its edges. Called
// by content/trackpad.js, and by content/layout.js when the box moves.
import { setHostPinch } from '../shared/dom.js';

const ZOOM_MAX = 3;
const SPRING_MS = 180;

// `box()`: the box now, in the page's pixels, or null. `link`: content/page-link.js.
export function startPinch(page, { box, link }) {
  const zoom = { scale: 1, x: 0, y: 0, from: 1, atX: 0, atY: 0, startX: 0, startY: 0 };
  let spring = 0;

  function show(moving) {
    const now = box();
    if (!now) return;
    link.setZoom(now, { scale: zoom.scale, x: zoom.x, y: zoom.y, moving });
    setHostPinch(page.host, zoom.scale === 1 ? null : {
      x: now.left - (now.left + zoom.x) / zoom.scale,
      y: now.top - (now.top + zoom.y) / zoom.scale,
      scale: 1 / zoom.scale,
    });
  }
  // In the box's bounds; below its size, in the middle of it.
  function keepInBox() {
    const now = box();
    if (!now) return;
    const width = innerWidth - now.left - now.right;
    const height = innerHeight - now.top - now.bottom;
    const within = (at, size) => (zoom.scale < 1 ? (size - size * zoom.scale) / 2 : Math.min(0, Math.max(size - size * zoom.scale, at)));
    zoom.x = within(zoom.x, width);
    zoom.y = within(zoom.y, height);
  }
  // Back inside the limits, with a short spring, frame by frame, so the page
  // and the sidebar's host stay in step.
  function settle(animate = true) {
    cancelAnimationFrame(spring);
    let scale = Math.min(ZOOM_MAX, Math.max(1, zoom.scale));
    if (animate && scale < 1.03) scale = 1; // a pinch that ended next to its size: no zoom to speak of
    const from = { ...zoom };
    const to = { ...zoom, scale };
    if (scale !== zoom.scale) {
      const k = scale / zoom.scale;
      to.x = zoom.atX - (zoom.atX - zoom.x) * k;
      to.y = zoom.atY - (zoom.atY - zoom.y) * k;
    }
    Object.assign(zoom, to);
    keepInBox();
    if (scale === 1) Object.assign(zoom, { x: 0, y: 0 });
    Object.assign(to, zoom);
    if (!animate || (from.scale === to.scale && from.x === to.x && from.y === to.y)) return show(false);
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / SPRING_MS);
      const eased = 1 - (1 - t) ** 3;
      const between = (a, b) => a + (b - a) * eased;
      Object.assign(zoom, { scale: between(from.scale, to.scale), x: between(from.x, to.x), y: between(from.y, to.y) });
      if (t < 1) {
        show(true);
        spring = requestAnimationFrame(step);
      } else {
        show(false);
      }
    };
    spring = requestAnimationFrame(step);
  }
  function reset() {
    cancelAnimationFrame(spring);
    if (zoom.scale === 1) return;
    Object.assign(zoom, { scale: 1, x: 0, y: 0 });
    show(false);
  }
  addEventListener('resize', () => { if (zoom.scale !== 1) settle(false); });
  document.addEventListener('fullscreenchange', reset); // full screen shows it as it is

  return {
    // At (x, y) in the window. `move`: `scale` of where it started.
    start(x, y) {
      cancelAnimationFrame(spring);
      const now = box();
      if (!now) return;
      Object.assign(zoom, { from: zoom.scale, atX: x - now.left, atY: y - now.top, startX: zoom.x, startY: zoom.y });
    },
    move(scale) {
      const wanted = zoom.from * scale;
      // Past the limits it gives a little, as Safari's does.
      const next = wanted > ZOOM_MAX ? ZOOM_MAX + (wanted - ZOOM_MAX) * 0.25 : wanted < 1 ? 1 - (1 - wanted) * 0.25 : wanted;
      const k = next / zoom.from;
      zoom.scale = next;
      zoom.x = zoom.atX - (zoom.atX - zoom.startX) * k;
      zoom.y = zoom.atY - (zoom.atY - zoom.startY) * k;
      keepInBox();
      show(true);
    },
    end: () => settle(),
    reset,
    zoomed: () => zoom.scale !== 1,
    // The box moved: the zoom goes along.
    follow() {
      if (zoom.scale === 1) return;
      if (box()) settle(false);
      else reset();
    },
    // Two fingers while zoomed: moves it, until its edge. Whether it moved.
    pan(dx, dy) {
      if (zoom.scale === 1) return false;
      const { x, y } = zoom;
      zoom.x -= dx;
      zoom.y -= dy;
      keepInBox();
      show(true);
      clearTimeout(panRest);
      panRest = setTimeout(() => show(false), 150);
      return x !== zoom.x || y !== zoom.y;
    },
  };
}
let panRest = 0;
