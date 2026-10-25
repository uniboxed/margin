// Dock-window experiment: window geometry for showing the sidebar in its own
// window glued to the left of a Safari window. Pure; classic script attaching
// to globalThis.Margin.dock (used by background.js via importScripts and by
// dock/dock.js).
(() => {
  const Margin = (globalThis.Margin ??= {});

  const WIDTH = 260;
  const MIN_PAGE_WIDTH = 480; // don't dock next to a window narrower than this
  const SLACK = 2; // px of drift tolerated before re-docking

  const box = ({ left, top, width, height }) => ({ left, top, width, height });

  // Dock takes the left `width` px of the target window; the target shrinks
  // to the rest. null if the target is too narrow or has no usable bounds.
  function dockLayout(target, width = WIDTH) {
    if (![target?.left, target?.top, target?.width, target?.height].every(Number.isFinite)) return null;
    if (target.width < width + MIN_PAGE_WIDTH) return null;
    return {
      dock: { left: target.left, top: target.top, width, height: target.height },
      target: { left: target.left + width, top: target.top, width: target.width - width, height: target.height },
    };
  }

  // Follow the target relatively: when the target window moved or resized
  // since `prev`, shift the dock by the same amount from where it actually
  // is. Never chases absolute coordinates: Safari reports window positions
  // slightly offset from where it draws them, and re-requesting the "ideal"
  // spot every tick made the dock jump off-screen and back twice a second.
  // Clamped so the dock never leaves the screen (`minLeft`/`minTop`).
  // null when nothing needs to move.
  function followLayout(prev, target, dock, { minLeft = -Infinity, minTop = -Infinity } = {}) {
    if (!prev || !target || !dock) return null;
    const moved = ['left', 'top', 'width', 'height'].some((k) => Math.abs((target[k] ?? 0) - (prev[k] ?? 0)) > SLACK);
    if (!moved) return null;
    const want = {
      left: Math.max(minLeft, dock.left + (target.left - prev.left)),
      top: Math.max(minTop, dock.top + (target.top - prev.top)),
      width: dock.width,
      height: Math.max(200, dock.height + (target.height - prev.height)),
    };
    const off = ['left', 'top', 'width', 'height'].some((k) => Math.abs(dock[k] - want[k]) > SLACK);
    return off ? want : null;
  }

  // Give the target back the space the dock used.
  function undockLayout(target, width = WIDTH) {
    if (!target) return null;
    return { left: target.left - width, top: target.top, width: target.width + width, height: target.height };
  }

  // "requested → got" summary for the diagnostic line, e.g. to see whether
  // Safari honors positions and sizes for extension windows.
  function describe(requested, actual) {
    const fmt = (b) => (b ? `${b.left},${b.top} ${b.width}×${b.height}` : '?');
    const exact = requested && actual && ['left', 'top', 'width', 'height'].every((k) => Math.abs(requested[k] - actual[k]) <= SLACK);
    return `${exact ? '✓' : '✗'} asked ${fmt(requested)} → got ${fmt(actual)}`;
  }

  Margin.dock = { WIDTH, MIN_PAGE_WIDTH, box, dockLayout, followLayout, undockLayout, describe };
})();
