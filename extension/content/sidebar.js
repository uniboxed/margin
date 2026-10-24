// Injected overlay. Renders from storage.local, never pushes the page.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  if (location.href.startsWith(api.runtime.getURL(''))) return;
  if (document.querySelector('margin-sidebar-host')) return;

  const EDGE_PX = 6;
  const HIDE_DELAY_MS = 300;
  const WIDTH_PX = 260;

  const host = document.createElement('margin-sidebar-host');
  for (const [prop, value] of Object.entries({
    all: 'initial',
    position: 'fixed',
    top: '0',
    left: '0',
    width: '0',
    height: '0',
    'z-index': '2147483647',
  })) host.style.setProperty(prop, value, 'important');
  const shadow = host.attachShadow({ mode: 'closed' });

  // Some pages replace <html>'s children; put the host back if it's removed.
  const attach = () => {
    if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
  };
  attach();
  new MutationObserver(attach).observe(document, { childList: true, subtree: false });
  document.addEventListener('DOMContentLoaded', attach);

  const Margin = globalThis.Margin;
  Margin.content = { api, shadowHostTag: 'margin-sidebar-host' };

  async function send(type, payload = {}) {
    try {
      const res = await api.runtime.sendMessage({ type, ...payload });
      return res?.result;
    } catch (err) {
      console.warn('[margin]', type, err);
    }
  }
  Margin.content.send = send;

  // Styles live in sidebar.css (web-accessible). Constructable stylesheets
  // aren't subject to the page's CSP; fall back to a <style> element.
  (async () => {
    const css = await (await fetch(api.runtime.getURL('content/sidebar.css'))).text();
    if ('adoptedStyleSheets' in shadow && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
    } else {
      const style = document.createElement('style');
      style.textContent = css;
      shadow.prepend(style);
    }
  })().catch((err) => console.warn('[margin] css', err));

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
