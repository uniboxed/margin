// Injected overlay. Renders from storage.local, never pushes the page.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  if (location.href.startsWith(api.runtime.getURL(''))) return;
  if (document.querySelector('margin-sidebar-host')) return;

  const Margin = globalThis.Margin;
  Margin.content = { api };

  const EDGE_PX = 6;
  const HIDE_DELAY_MS = 300;
  const WIDTH_PX = 260;

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

  Margin.ui.adoptStyles(shadow, api.runtime.getURL('content/sidebar.css')).catch((err) => console.warn('[margin] css', err));

  const sidebar = Margin.ui.createSidebar({ document, send, mode: 'overlay' });
  shadow.append(sidebar.el);

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
  const applyTheme = () => sidebar.setTheme(pageTheme());
  applyTheme();
  document.addEventListener('DOMContentLoaded', applyTheme);
  addEventListener('load', applyTheme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

  // ---- visibility ---------------------------------------------------------

  let state = null;
  let reason = null; // 'hover' | 'toggle' | null
  let hideTimer = null;

  const pinnedOpen = () => !!state?.settings?.sidebarPinnedOpen;
  function setOpen(open) {
    sidebar.el.classList.toggle('open', open);
    host.dataset.open = String(open); // test/debug hook; reveals nothing private
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
  Margin.content.sidebar = { show, hide, toggle: () => (reason || pinnedOpen() ? hide() : show('toggle')) };

  document.addEventListener(
    'mousemove',
    (e) => {
      if (e.clientX <= EDGE_PX) show('hover');
      else if (e.clientX > WIDTH_PX) scheduleHide();
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
  let windowId = null;

  function render() {
    if (!state) return;
    windowId = state.tabs?.[tabId]?.windowId ?? windowId;
    sidebar.update(state, { windowId });
    Margin.content.onState?.(state, { tabId, windowId });
    if (!reason) setOpen(pinnedOpen());
  }

  // Storage reads can resolve out of order; only the latest one renders.
  let version = 0;
  async function refresh() {
    const mine = ++version;
    const next = await api.storage.local.get(null);
    if (mine !== version || !next.spaces?.length) return; // stale, or background not initialized yet
    state = next;
    render();
  }

  Margin.content.getState = () => ({ state, tabId, windowId });
  api.storage.onChanged.addListener((_, area) => area === 'local' && refresh());
  refresh();
  send('hello').then((ctx) => {
    if (!ctx) return;
    ({ tabId, windowId } = ctx);
    render();
  });

  api.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'command') return;
    if (message.command === 'toggle-sidebar') Margin.content.sidebar.toggle();
    else Margin.content.onCommand?.(message.command);
  });
})();
