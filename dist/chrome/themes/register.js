// How a theme's content bundle hands itself to Margin's core
// (content/core.js). The two are separate scripts in the same world, and
// either may run first: the theme is kept on Margin.theme until core picks
// it up, or handed over at once if core is already waiting.
//
// A content theme is { id, geometry: { inset, radius, rail? }, createPalette,
// mount({ shadow, document, send, onNewTab, onWidth, onScroll }) → view }, where view
// is { isBusy(), width(), update(state, ctx: { windowId, tabId, fit, newTabPending, scroll? }), ready(), instantOnce?(), setColorScheme(s),
// setLayout({ open, docked, width, rail: { width, expanded } | null }),
// setWidth(px), setLoading(on, { instant }),
// setPull({ phase, progress }), setSwipe({ phase, progress, direction }),
// setZoom(level | null), showNotice({ text, actions: [{ label, run }] } | null) }
// (themes/arcadium/content.js is the reference).
export function registerTheme(theme) {
  const Margin = (globalThis.Margin ??= {});
  // Already there: WebKit runs content scripts again in open pages when
  // Margin's site permissions change, and a late injection can follow the
  // registered script.
  if (Margin.theme) return;
  Margin.theme = theme;
  Margin.content?.themeArrived?.();
}
