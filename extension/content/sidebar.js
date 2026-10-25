// Injected overlay. Renders from storage.local, never pushes the page.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  // Load timing, in ms since navigation start (see logTiming below).
  const timing = { injected: Math.round(performance.now()) };
  if (location.href.startsWith(api.runtime.getURL(''))) return;
  if (document.querySelector('margin-sidebar-host')) return;

  const Margin = globalThis.Margin;
  Margin.content = { api };

  // Reveal zone: 10px, or 24px in a full-screen window, where Safari's own
  // sidebar opens if the cursor rests at the very edge (see view.revealZone).
  const edgePx = () =>
    Margin.view.revealZone({ outerWidth, outerHeight, screenWidth: screen.width, screenHeight: screen.height });
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

  const sidebar = Margin.ui.createSidebar({
    document,
    send,
    mode: 'overlay',
    // "+ New tab" opens the command palette here (palette.js sets openPalette).
    onNewTab: () => (Margin.content.openPalette ? Margin.content.openPalette() : send('newTab', { windowId })),
  });
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

  // One fixed sidebar color: follows only the Mac's Light/Dark appearance,
  // never the page (so it doesn't change from tab to tab).
  const systemDark = matchMedia('(prefers-color-scheme: dark)');
  const pageTheme = () => (systemDark.matches ? 'dark' : 'light');
  Margin.content.theme = pageTheme;
  const applyTheme = () => {
    const theme = pageTheme();
    sidebar.setTheme(theme);
    frame.dataset.theme = theme;
  };
  applyTheme();
  systemDark.addEventListener?.('change', applyTheme);

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
    if (!reason || reason === 'peek' || why === 'toggle') reason = why;
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

  // Briefly show the sidebar (after ⌘⌥←/→) so the new space is visible even
  // in auto-hide mode. Hovering or toggling during the peek keeps it open.
  let peekTimer = null;
  function peek() {
    if (pinnedOpen() || (reason && reason !== 'peek')) return;
    show('peek');
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => reason === 'peek' && hide(), 1200);
  }

  // ⌘⌥↓/↑ next/previous tab, ⌘⌥→/← next/previous space.
  Margin.shortcuts.installNavigation({
    getContext: () => ({ state, windowId, tabId }),
    send,
    onSpace: peek,
  });

  document.addEventListener(
    'mousemove',
    (e) => {
      if (e.clientX <= edgePx()) show('hover');
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
    if (!e.relatedTarget && e.clientX > edgePx()) scheduleHide();
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
    sidebar.update(state, { windowId, tabId });
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

  // One debug-level line per page (hidden unless the console shows Debug
  // messages), once it has loaded: where the time before the sidebar
  // went. All numbers are ms since navigation start. If "injected" is late,
  // Safari ran the content script late; if "storage" is late, the
  // storage.local read was slow; "rendered" is when the sidebar appeared.
  function logTiming() {
    const nav = performance.getEntriesByType?.('navigation')?.[0];
    const fmt = (n) => (n == null ? '–' : `${Math.round(n)}`);
    console.debug(
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

  // Safari gives extensions no favicons: tell the background which icon this
  // page uses (it fetches and stores it once per site). Again on load, for
  // pages that add their icon from script.
  let reportedIcon = null;
  function reportIcon() {
    const links = [...document.querySelectorAll('link[rel]')].map((l) => ({
      rel: l.rel,
      href: l.href,
      sizes: l.getAttribute('sizes') ?? '',
      type: l.type,
    }));
    const href = Margin.view.pickIconHref(links, location.href);
    if (!href || href === reportedIcon) return;
    reportedIcon = href;
    send('pageIcon', { href });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reportIcon, { once: true });
  else reportIcon();
  addEventListener('load', reportIcon, { once: true });

  api.runtime.onMessage.addListener((message, _, sendResponse) => {
    if (message?.type === 'ping') return sendResponse('pong'); // background: is Margin running here?
    if (message?.type !== 'command') return;
    if (message.command === 'toggle-sidebar') Margin.content.sidebar.toggle();
    else Margin.content.onCommand?.(message.command);
  });
})();
