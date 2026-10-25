// Shared logger for extension pages (ntp.html, pal.html).
globalThis.LOG = (src, ev, extra = {}) => fetch('http://127.0.0.1:8794/log', {
  method: 'POST',
  body: JSON.stringify({ src, ev, href: location.href, hl: history.length, hasFocus: document.hasFocus(),
    active: document.activeElement ? document.activeElement.tagName + (document.activeElement.id ? '#' + document.activeElement.id : '') : null,
    vis: document.visibilityState, ...extra }),
}).catch(() => {});
globalThis.watchFocus = (src) => {
  let last = '';
  const snap = () => {
    const s = `${document.hasFocus()}|${document.activeElement?.tagName}#${document.activeElement?.id}|${document.visibilityState}`;
    if (s !== last) { last = s; LOG(src, 'state'); }
  };
  setInterval(snap, 50);
  snap();
  addEventListener('keydown', (e) => LOG(src, 'keydown', { key: e.key, target: e.target?.tagName + '#' + (e.target?.id || '') }), true);
  addEventListener('focus', (e) => e.target === window && LOG(src, 'window-focus'));
  addEventListener('blur', (e) => e.target === window && LOG(src, 'window-blur'));
};
