// Margin iframe-shell prototype: FRAME side (document_start, all_frames, isolated world).
//
// Runs in every frame, but only acts in the shell's own card frame (a direct child of the top
// document). Same-origin with the top: report changes to the shell, send cross-origin
// navigations to the top level. Cross-origin (it got here through a redirect): ask the shell
// to hand the URL to the top level.
(() => {
  'use strict';
  if (window.top === window || window.parent !== window.top) return;

  let topSameOrigin = false;
  try { topSameOrigin = typeof window.top.location.href === 'string'; } catch {}

  if (!topSameOrigin) {
    // Possibly Margin's card after a redirect to another origin. The shell verifies that the
    // message comes from its own frame and that the frame really is cross-origin.
    try { window.parent.postMessage({ __margin: 'xo-frame', url: location.href }, '*'); } catch {}
    window.addEventListener('message', (e) => {
      if (e.source === window.parent && e.data?.__margin === 'xo-ack') window.stop();
    });
    return;
  }

  let fe = null;
  try { fe = window.frameElement; } catch {}
  if (!fe || fe.__marginFrame !== true) return; // the page's own same-origin frame, or no shell

  const tell = (why) => {
    try { window.top.dispatchEvent(new CustomEvent('margin:frame', { detail: why })); } catch {}
  };

  const submitTop = (action, formData, source) => {
    const form0 = source?.form || (source?.tagName === 'FORM' ? source : null);
    const td = window.top.document;
    const form = td.createElement('form');
    form.method = 'post';
    form.action = action;
    form.enctype = form0?.enctype || 'application/x-www-form-urlencoded';
    for (const [name, value] of formData) {
      const input = td.createElement('input');
      input.name = name;
      if (typeof value === 'string') {
        input.type = 'hidden';
        input.value = value;
      } else {
        input.type = 'file';
        const dt = new DataTransfer();
        dt.items.add(value);
        input.files = dt.files;
      }
      form.appendChild(input);
    }
    form.hidden = true;
    td.body.appendChild(form);
    form.submit();
  };

  window.navigation?.addEventListener('navigate', (e) => {
    const d = e.destination;
    let u;
    try { u = new URL(d.url); } catch { return; }
    if (u.origin === location.origin) {
      if (!d.sameDocument) tell('navigate ' + u.href);
      return;
    }
    if (!/^https?:$/.test(u.protocol)) return; // mailto:, tel:, custom schemes: browser handles them
    if (!e.cancelable || e.downloadRequest !== null) return;
    e.preventDefault();
    tell('to-top ' + u.href);
    if (e.formData) submitTop(u.href, e.formData, e.sourceElement);
    else window.top.location.assign(u.href);
  });
  window.navigation?.addEventListener('navigatesuccess', () => tell('navigatesuccess'));
  window.navigation?.addEventListener('currententrychange', () => tell('currententrychange'));
  window.addEventListener('pageshow', () => tell('pageshow'));
  window.addEventListener('hashchange', () => tell('hashchange'));
  document.addEventListener('DOMContentLoaded', () => {
    tell('dcl');
    if (document.head) {
      new MutationObserver(() => tell('title')).observe(document.head, { subtree: true, childList: true, characterData: true });
    }
  });
  tell('start');
})();
