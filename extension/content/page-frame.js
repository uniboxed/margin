// Keeps a pinned page inside a real, narrower browsing viewport. The parent
// document is only the tab shell; the iframe owns the page layout.
// Classic script: attaches to globalThis.Margin.
(() => {
  const Margin = (globalThis.Margin ??= {});

  const shellCss = `@media screen {
    html { overflow: hidden !important; }
    body { display: none !important; }
  }`;

  function sameOrigin(url) {
    try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
  }

  function create({ document: doc, element, getState, onFailure, onReady }) {
    let enabled = false;
    let loaded = false;
    let shellSheet = null;
    let shellStyle = null;
    let savedScroll = null;
    let outerPopstate = null;
    let frameWindow = null;

    const sourceUrl = () => location.href;
    const frameHref = () => {
      try { return element.contentWindow?.location?.href ?? null; } catch { return null; }
    };

    function applyShell() {
      if ('adoptedStyleSheets' in doc && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
        shellSheet ??= new CSSStyleSheet();
        shellSheet.replaceSync(shellCss);
        const others = doc.adoptedStyleSheets.filter((sheet) => sheet !== shellSheet);
        doc.adoptedStyleSheets = [...others, shellSheet];
      } else {
        shellStyle ??= doc.createElement('style');
        shellStyle.textContent = shellCss;
        if (!shellStyle.isConnected) doc.documentElement?.append(shellStyle);
      }
    }

    function removeShell() {
      if (shellSheet) doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((sheet) => sheet !== shellSheet);
      shellStyle?.remove();
      shellStyle = null;
    }

    function stopOuterHistoryBridge() {
      if (outerPopstate) globalThis.removeEventListener('popstate', outerPopstate);
      outerPopstate = null;
      frameWindow = null;
    }

    function installFrameBridge(frameDoc, win) {
      const current = frameHref();
      if (!current || !sameOrigin(current) || frameDoc.documentElement.dataset.marginFrameReady === 'true') return;
      frameDoc.documentElement.dataset.marginFrameReady = 'true';

      // A normal page interaction should navigate the tab, not create a
      // second history stack hidden inside the card.
      const base = frameDoc.createElement('base');
      base.target = '_top';
      frameDoc.head?.prepend(base);
      frameDoc.addEventListener('click', (event) => {
        const link = event.target.closest?.('a[href]');
        if (link && (!link.target || link.target === '_self')) link.target = '_top';
      }, true);
      frameDoc.addEventListener('submit', (event) => {
        const form = event.target;
        if (form instanceof frameDoc.defaultView.HTMLFormElement && (!form.target || form.target === '_self')) form.target = '_top';
      }, true);
      // A full-viewport iframe does not bubble pointer events to its parent.
      // Mirror mouse movement so the auto-hide reveal zone still works after
      // Keep open is turned off without throwing away the live page document.
      frameDoc.addEventListener('mousemove', (event) => {
        doc.dispatchEvent(new globalThis.MouseEvent('mousemove', {
          clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
          bubbles: true, composed: true,
        }));
      }, true);

      let syncing = false;
      const syncOuter = (replace) => {
        if (syncing || !enabled) return;
        const href = frameHref();
        if (!href || !sameOrigin(href) || href === location.href) return;
        syncing = true;
        try {
          const method = replace ? 'replaceState' : 'pushState';
          history[method](history.state, '', href);
        } finally {
          syncing = false;
        }
      };
      const originalPush = win.history.pushState.bind(win.history);
      const originalReplace = win.history.replaceState.bind(win.history);
      win.history.pushState = (...args) => {
        const result = originalPush(...args);
        syncOuter(false);
        return result;
      };
      win.history.replaceState = (...args) => {
        const result = originalReplace(...args);
        syncOuter(true);
        return result;
      };
      win.addEventListener('popstate', () => syncOuter(true));
      win.addEventListener('hashchange', () => syncOuter(true));

      frameWindow = win;
      outerPopstate = () => {
        if (!enabled || !frameWindow || !sameOrigin(location.href)) return;
        const href = frameHref();
        if (href && href !== location.href) frameWindow.location.href = location.href;
      };
      globalThis.addEventListener('popstate', outerPopstate);

      // The parent content script owns Margin's shortcuts. Forward keyboard
      // events from the framed page and mirror preventDefault back into it.
      frameDoc.addEventListener('keydown', (event) => {
        const init = {
          key: event.key, code: event.code, location: event.location,
          ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey,
          metaKey: event.metaKey, repeat: event.repeat, isComposing: event.isComposing,
          bubbles: true, cancelable: true, composed: true,
        };
        const forwarded = new globalThis.KeyboardEvent('keydown', init);
        doc.dispatchEvent(forwarded);
        if (forwarded.defaultPrevented) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);

      const state = getState?.();
      if (current !== location.href && sameOrigin(current)) history.replaceState(history.state, '', current);
      if (state?.scrollY != null) win.scrollTo(state.scrollX ?? 0, state.scrollY);
    }

    function fail(reason) {
      if (!enabled) return;
      enabled = false;
      loaded = false;
      stopOuterHistoryBridge();
      element.classList.remove('on');
      removeShell();
      onFailure?.(reason);
    }

    function handleLoad() {
      if (!enabled) return;
      const href = frameHref();
      // A same-origin page exposes its document to the shell. A blocked
      // X-Frame-Options/CSP response and a cross-origin redirect do not. We
      // cannot distinguish those two cases safely, so leave the setting on
      // and use the visible shell fallback rather than hiding a blank card.
      if (!element.contentDocument) return setTimeout(() => enabled && !loaded && fail('unavailable'), 250);
      if (href === 'about:blank' && sourceUrl() !== 'about:blank') return fail('blocked');
      loaded = true;
      element.dataset.loaded = 'true';
      if (href && sameOrigin(href)) installFrameBridge(element.contentDocument, element.contentWindow);
      onReady?.();
    }

    element.addEventListener('load', handleLoad);
    element.addEventListener('error', () => fail('error'));

    return {
      setWidth(width) { element.style.setProperty('--width', `${width}px`); },
      setMode(next) {
        if (next === 'off') {
          if (!enabled) return;
          enabled = false;
          loaded = false;
          stopOuterHistoryBridge();
          element.classList.remove('on', 'full');
          element.removeAttribute('src');
          delete element.dataset.loaded;
          removeShell();
          if (savedScroll) {
            globalThis.scrollTo(savedScroll.x, savedScroll.y);
            savedScroll = null;
          }
          return;
        }
        element.classList.toggle('full', next === 'overlay');
        if (enabled) return;
        enabled = true;
        savedScroll = { x: globalThis.scrollX, y: globalThis.scrollY };
        applyShell();
        element.dataset.loaded = 'false';
        element.classList.add('on');
        element.src = sourceUrl();
      },
      hasFrame: () => enabled,
      isLoaded: () => loaded,
    };
  }

  Margin.pageFrame = { create };
})();
