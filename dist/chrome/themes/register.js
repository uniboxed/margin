// How a theme's content bundle hands itself to Margin's core
// (content/core.js). The two are separate scripts in the same world, and
// either may run first: the theme is kept on Margin.theme until core picks
// it up, or handed over at once if core is already waiting.
//
// A content theme is { id, geometry: { inset, radius }, createPalette,
// mount({ shadow, document, send, onNewTab, onWidth, onScroll, onSwitch }) → view }, where view
// is { isBusy(), width(), update(state, ctx: { windowId, tabId, newTabPending, switchingTo, scroll? }), ready(), instantOnce?(), setColorScheme(s),
// setLayout({ open, docked, framed, width, place, why }) (`why`: how it's open: 'hover' | 'toggle' | 'peek' | null),
// setWidth(px), setLoading(on, { instant }), setCover?(on, { instant, spinnerNow }) (the empty screen while switching tabs),
// setStartup?(on) (over everything while Margin gets ready after Safari starts or Margin is updated; else setCover),
// setPull({ phase, progress }), setSwipe({ phase, progress, direction }),
// showNotice({ text, actions: [{ label, run }], duration? } | null),
// setWarmUp?({ done, total, state: 'running' | 'done' | 'stopped' } | null) (the warm-up's note after a relaunch: background/warm-up.js) }
// (themes/arcadia/content.js is the reference).
export function registerTheme(theme) {
  const Margin = (globalThis.Margin ??= {});
  // Already there: WebKit runs content scripts again in open pages when
  // Margin's site permissions change, and a late injection can follow the
  // registered script.
  if (Margin.theme) return;
  Margin.theme = theme;
  Margin.content?.themeArrived?.();
}
