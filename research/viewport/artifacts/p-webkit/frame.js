// Margin iframe shell prototype -- FRAME-SIDE part.
// Injected at document_start into ALL frames (like a content script with all_frames:true), same world as shell.js.
// Only acts inside the shell's own frame (window.name === 'margin-shell-frame', parent === top).
(() => {
  const CFG = (typeof __MCFG !== 'undefined') ? __MCFG : {};
  if (window === window.top) return;
  if (window.name !== 'margin-shell-frame' || window.parent !== window.top) return;
  let M = null;
  try { M = window.top.__margin || null; } catch (e) { M = null; }
  const now = () => +performance.now().toFixed(1);
  if (!M) {
    // Cross-origin with the shell (e.g. a same-origin URL 302-redirected to another site), or the shell
    // lives in another world. Hand the final URL to the top and stop this document.
    try { window.top.postMessage({ margin: 'escape', url: location.href }, '*'); } catch (e) {}
    if (CFG.frameStopOnEscape !== false) { try { window.stop(); } catch (e) {} }
    return;
  }
  M.frameSide++;
  const L = (ev, d = {}) => { M.log.push(Object.assign({ t: 'f' + now(), ev }, d)); };
  L('frame-side', { href: location.href, navapi: !!window.navigation });
  if (window.navigation && CFG.frameNavapi !== false) {
    navigation.addEventListener('navigate', (e) => {
      const dest = new URL(e.destination.url);
      const rec = { type: e.navigationType, dest: dest.href, cancelable: e.cancelable, canIntercept: e.canIntercept, userInitiated: e.userInitiated, hashChange: e.hashChange, formData: !!e.formData };
      L('frame-navigate', rec);
      if (e.navigationType === 'traverse' || e.downloadRequest) return;
      if (dest.origin !== location.origin) {
        if (e.cancelable) {
          e.preventDefault();
          M.escapes.push({ how: 'frame-navigate-event', url: dest.href });
          if (M.beacon) M.beacon('escape-frame-navigate-event', dest.href);
          window.top.location.href = dest.href;
        } else L('frame-navigate-not-cancelable', rec);
      } else {
        M.pending = dest.href;    // remember: if it ends cross-origin (redirect), the shell falls back to this
        if (CFG.histMode === 'top' && e.navigationType === 'push' && !e.destination.sameDocument && !e.formData && e.cancelable) {
          e.preventDefault();
          M.topPush(dest.href);
        }
      }
    });
  } else {
    // Fallback without the Navigation API: capture link clicks only (misses location.assign / forms).
    addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const t = (a.target || '').toLowerCase();
      if (t && t !== '_self') return;
      const dest = new URL(a.href, location.href);
      if (dest.origin !== location.origin) { e.preventDefault(); M.escapes.push({ how: 'click-capture', url: dest.href }); window.top.location.href = dest.href; }
      else M.pending = dest.href;
    }, true);
  }
})();
