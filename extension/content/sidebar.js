(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  if (location.href.startsWith(api.runtime.getURL(''))) return;
  if (document.querySelector('margin-sidebar-host')) return;

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
  host.attachShadow({ mode: 'closed' });
  document.documentElement.appendChild(host);
})();
