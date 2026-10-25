// Emulated Margin content script (isolated world, all frames, document_start).
(function () {
  const ID = (new URLSearchParams(location.search).get('id')) || 'none';
  const isTop = window.top === window;
  const log = (o) => {
    o.world = 'cs'; o.at = location.href; o.isTop = isTop;
    try { fetch('http://localhost:8701/log?id=' + encodeURIComponent(ID), { method: 'POST', body: JSON.stringify(o), keepalive: true, mode: 'no-cors' }); } catch (e) {}
  };
  let ao = null; try { ao = location.ancestorOrigins ? Array.from(location.ancestorOrigins) : null; } catch (e) { ao = 'ERR'; }
  log({ ev: 'cs-start', origin: location.origin, name: window.name, ancestorOrigins: ao, hasNav: typeof navigation !== 'undefined', hasBrowser: typeof browser !== 'undefined' || typeof chrome !== 'undefined' });
  if (isTop) {
    if (typeof navigation !== 'undefined') navigation.addEventListener('navigate', (e) => {
      const allow = window.__marginAllow === e.destination.url;
      if (!e.destination.sameDocument && !allow && e.cancelable && new URL(e.destination.url).origin === location.origin) e.preventDefault();
      log({ ev: 'cs-top-navigate', type: e.navigationType, cancelable: e.cancelable, dest: e.destination.url, prevented: e.defaultPrevented, userInitiated: e.userInitiated });
    });
    document.addEventListener('margin-escape', (e) => log({ ev: 'cs-top-customevent', detail: e.detail, detailType: typeof e.detail }));
    window.addEventListener('message', (e) => {
      if (!e.data || !e.data.marginEscape) return;
      log({ ev: 'cs-top-message', url: e.data.marginEscape, origin: e.origin });
      window.__marginAllow = e.data.marginEscape;
      location.href = e.data.marginEscape;
    });
  } else {
    let topOrigin = null; try { topOrigin = window.top.location.origin; } catch (e) { topOrigin = 'XO'; }
    if (topOrigin === location.origin) {
      try { window.top.document.dispatchEvent(new CustomEvent('margin-escape', { detail: 'hello-from-frame-cs' })); } catch (e) { log({ ev: 'cs-ce-err', err: String(e) }); }
    } else if (window.parent === window.top && ao && ao.length === 1) {
      // A cross-origin document ended up in the shell frame (e.g. after a server redirect): escape to top level.
      log({ ev: 'cs-xo-frame-escape', url: location.href });
      window.top.postMessage({ marginEscape: location.href }, '*');
      try { window.stop(); } catch (e) {}
    }
  }
})();
