// Injected overlay. Renders from storage.local, never pushes the page.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  // Load timing, in ms since navigation start (see logTiming below).
  const timing = { injected: Math.round(performance.now()) };
  if (location.href.startsWith(api.runtime.getURL(''))) return;
  if (document.querySelector('margin-sidebar-host')) return;

  const Margin = globalThis.Margin;
  Margin.content = { api };

  // Reveal zone. Margin opens instantly here; Safari's own sidebar only opens
  // after the cursor rests at the very edge, which extensions can't disable.
  const EDGE_PX = 10;
  const HIDE_DELAY_MS = 300;
  const WIDTH_PX = 260; // keep in sync with sidebar.css (--width, .frame .hole left)
  const FRAME_PX = 8; // keep in sync with sidebar.css (.frame .hole inset, floating inset)
  const HOVER_PX = WIDTH_PX + FRAME_PX; // right edge of the floating sidebar

  const host = Margin.ui.createHost(document, 'margin-sidebar-host');
  const shadow = host.attachShadow({ mode: 'closed' });

  // Some pages replace <html>'s children; put the host back if it's removed.
  const attach = () => {
    if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
  };
  attach();
  const observer = new MutationObserver(attach);
  observer.observe(document, { childList: true });
  if (document.documentElement) observer.observe(document.documentElement, { childList: true });
  document.addEventListener('DOMContentLoaded', attach);

  // If the background was unloaded and the first message doesn't wake it in
  // time, retry once.
  async function send(type, payload = {}, retry = true) {
    try {
      const res = await api.runtime.sendMessage({ type, ...payload });
      if (res?.ok) return res.result;
      if (res) return console.warn('[margin]', type, res.error);
    } catch (err) {
      if (!retry) return console.warn('[margin]', type, err);
    }
    if (retry) {
      await new Promise((r) => setTimeout(r, 250));
      return send(type, payload, false);
    }
  }
  Margin.content.send = send;

  const sidebar = Margin.ui.createSidebar({ document, send, mode: 'overlay' });
  // Arc-style frame: sidebar-colored strips around the page with rounded
  // corners, shown while the sidebar is open. Never takes clicks.
  const frame = Margin.ui.el(document, 'div', { class: 'frame', 'aria-hidden': 'true' }, Margin.ui.el(document, 'div', { class: 'hole' }));
  shadow.append(frame, sidebar.el);

  // Styles are bundled in content/styles.js and applied synchronously, so the
  // panel is styled from the first frame (no fetch, no unstyled flash).
  Margin.ui.adoptStyles(shadow, Margin.styles.sidebar);
  // No slide/fade on the first render: a kept-open sidebar should simply be
  // there when the page appears, not animate in on every navigation.
  sidebar.el.classList.add('instant');
  frame.classList.add('instant');
  let firstRender = true;

  // ---- theme: follow the page, then the OS -------------------------------

  function pageTheme() {
    const scheme = getComputedStyle(document.documentElement).colorScheme;
    if (scheme === 'dark') return 'dark';
    for (const node of [document.body, document.documentElement]) {
      if (!node) continue;
      const m = getComputedStyle(node).backgroundColor.match(/[\d.]+/g);
      if (!m || (m.length === 4 && Number(m[3]) === 0)) continue;
      const [r, g, b] = m.map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? 'dark' : 'light';
    }
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  Margin.content.theme = pageTheme;
  const applyTheme = () => {
    const theme = pageTheme();
    sidebar.setTheme(theme);
    frame.dataset.theme = theme;
  };
  applyTheme();
  document.addEventListener('DOMContentLoaded', applyTheme);
  addEventListener('load', applyTheme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

  // ---- visibility ---------------------------------------------------------

  let state = null;
  let reason = null; // 'hover' | 'toggle' | null
  let hideTimer = null;

  const pinnedOpen = () => !!state?.settings?.sidebarPinnedOpen;
  // Hover: a floating card over the page. Keep open: docked, with the frame
  // around the page and the page pushed right.
  function setOpen(open) {
    const docked = open && pinnedOpen();
    sidebar.el.classList.toggle('open', open);
    sidebar.el.classList.toggle('docked', docked);
    frame.classList.toggle('open', docked);
    host.dataset.open = String(open); // test/debug hook; reveals nothing private
    setPushed(docked);
    if (state) syncPlaceholder(docked);
  }

  // ---- push (only while "Keep open" is on) ---------------------------------
  // Shifts the page right so it starts where the sidebar ends. A separate
  // adopted stylesheet (never the page's own markup or inline styles), screen
  // media only, removed as soon as "Keep open" is off. Known trade-offs are in
  // DECISIONS.md: position:fixed elements don't move, 100vw elements are
  // clipped on the right.
  const PUSH_CSS = `@media screen {
    html {
      margin-left: ${WIDTH_PX}px !important;
      margin-right: ${FRAME_PX}px !important;
      width: auto !important;
      overflow-x: hidden !important;
    }
  }`;
  const canPush = document.documentElement instanceof HTMLHtmlElement;
  let pushed = false;
  let pushSheet = null;
  let pushStyle = null;
  function setPushed(on) {
    if (!canPush || on === pushed) return;
    pushed = on;
    if ('adoptedStyleSheets' in document && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
      pushSheet ??= new CSSStyleSheet();
      pushSheet.replaceSync(PUSH_CSS);
      const others = document.adoptedStyleSheets.filter((s) => s !== pushSheet);
      document.adoptedStyleSheets = on ? [...others, pushSheet] : others;
    } else if (on) {
      pushStyle ??= Object.assign(document.createElement('style'), { textContent: PUSH_CSS });
      document.documentElement.appendChild(pushStyle);
    } else {
      pushStyle?.remove();
    }
    host.dataset.pushed = String(on);
  }

  // content/docked.css (registered while "Keep open" is on) pushes and paints
  // from the first frame. Switch it off on this page whenever the page isn't
  // docked: after leaving "Keep open", or if the setting changed while the
  // page was loading. Only touches <html> when the placeholder is present.
  function syncPlaceholder(docked) {
    const html = document.documentElement;
    if (!canPush) return;
    if (docked) {
      if (html.dataset.marginDocked === 'off') delete html.dataset.marginDocked;
    } else if (html.dataset.marginDocked !== 'off' && getComputedStyle(html, '::after').content !== 'none') {
      html.dataset.marginDocked = 'off';
    }
  }
  function show(why) {
    clearTimeout(hideTimer);
    hideTimer = null;
    if (!reason || why === 'toggle') reason = why;
    setOpen(true);
  }
  function hide() {
    clearTimeout(hideTimer);
    hideTimer = null;
    reason = null;
    setOpen(pinnedOpen());
  }
  function scheduleHide() {
    if (reason !== 'hover' || hideTimer || sidebar.isBusy()) return;
    hideTimer = setTimeout(hide, HIDE_DELAY_MS);
  }
  // With "Keep open" on, the shortcut switches back to auto-hide (hide()
  // alone would leave it pinned open).
  function toggle() {
    if (pinnedOpen()) {
      state = { ...state, settings: { ...state.settings, sidebarPinnedOpen: false } };
      send('updateSettings', { patch: { sidebarPinnedOpen: false } });
      return hide();
    }
    return reason ? hide() : show('toggle');
  }
  Margin.content.sidebar = { show, hide, toggle };

  document.addEventListener(
    'mousemove',
    (e) => {
      if (e.clientX <= EDGE_PX) show('hover');
      else if (e.clientX > HOVER_PX) scheduleHide();
      else if (hideTimer && sidebar.el.classList.contains('open')) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    },
    { capture: true, passive: true },
  );
  // Cursor left the window: keep open if it left through the left edge.
  document.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget && e.clientX > EDGE_PX) scheduleHide();
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && reason === 'toggle') hide();
    },
    true,
  );
  // Clicking the page closes a toggled sidebar (clicks inside are retargeted to the host).
  document.addEventListener('mousedown', (e) => {
    if (reason === 'toggle' && e.target !== host) hide();
  }, true);

  // ---- data ---------------------------------------------------------------

  let tabId = null;
  let helloWindowId = null;
  let windowId = null;

  function render() {
    if (!state) return;
    // Known tab → its window. Until the background answers `hello`, guess, so
    // the sidebar draws straight from storage instead of waiting for it.
    windowId = state.tabs?.[tabId]?.windowId ?? helloWindowId ?? Margin.view.guessWindow(state, location.href);
    sidebar.update(state, { windowId });
    frame.style.setProperty('--space-color', sidebar.el.style.getPropertyValue('--space-color'));
    Margin.content.onState?.(state, { tabId, windowId });
    if (!reason) setOpen(pinnedOpen());
    if (firstRender) {
      firstRender = false;
      // performance.now() counts from navigation start: how long the page
      // went without its sidebar (see TESTING.md).
      timing.rendered = Math.round(performance.now());
      requestAnimationFrame(() => requestAnimationFrame(() => {
        sidebar.el.classList.remove('instant');
        frame.classList.remove('instant');
      }));
    }
  }

  // Storage reads can resolve out of order; only the latest one renders.
  let version = 0;
  async function refresh() {
    const mine = ++version;
    const next = await api.storage.local.get(null);
    timing.storage ??= Math.round(performance.now());
    if (mine !== version || !next.spaces?.length) return; // stale, or background not initialized yet
    state = next;
    render();
  }

  Margin.content.getState = () => ({ state, tabId, windowId });
  api.storage.onChanged.addListener((_, area) => area === 'local' && refresh());

  // One line per page, once it has loaded: where the time before the sidebar
  // went. All numbers are ms since navigation start. If "injected" is late,
  // Safari ran the content script late; if "storage" is late, the
  // storage.local read was slow; "rendered" is when the sidebar appeared.
  function logTiming() {
    const nav = performance.getEntriesByType?.('navigation')?.[0];
    const fmt = (n) => (n == null ? '–' : `${Math.round(n)}`);
    console.info(
      `[margin] timing (ms) injected=${fmt(timing.injected)} storage=${fmt(timing.storage)} rendered=${fmt(timing.rendered)}` +
        ` | page DOMContentLoaded=${fmt(nav?.domContentLoadedEventStart)} load=${fmt(nav?.loadEventStart)} keepOpen=${pinnedOpen()}`,
    );
  }
  if (document.readyState === 'complete') setTimeout(logTiming);
  else addEventListener('load', () => setTimeout(logTiming), { once: true });
  refresh();
  send('hello').then((ctx) => {
    if (!ctx) return;
    tabId = ctx.tabId;
    helloWindowId = ctx.windowId;
    render();
  });

  api.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'command') return;
    if (message.command === 'toggle-sidebar') Margin.content.sidebar.toggle();
    else Margin.content.onCommand?.(message.command);
  });
})();
