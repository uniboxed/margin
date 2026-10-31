// Fitted layout, Chrome only (platform.js shellPageWrite; bundled into the
// manifest's page-world script there by scripts/build.js, which runs before
// the registered shell; a registered one would run after it): writes the
// page into the card for content/shell.js. A content script's document.write runs under the
// extension's CSP in Chrome, so the page's inline scripts wouldn't run;
// written from the page's own world they do, under the page's CSP. Chrome
// doesn't run document_start scripts again in the card after the write, so
// the card is set up from here first (content/shell-card.js).
// Asked first whether it can write here (before the shell takes the page
// over), then to write; each once: it stops listening first. On pages the
// shell doesn't take over, a page script could ask instead, for nothing it
// couldn't do itself: the policy is one any page may create where its CSP
// allows it, and it writes only into Margin's card.
import { setUpCard } from './shell-card.js';

(() => {
  if (window !== top) return;
  const write = Document.prototype.write;
  const close = Document.prototype.close;
  /** @type {any} */
  let policy = null;
  // Its own Trusted Types policy, only on a page about to be fitted: on sites
  // that list their policies, creating one logs a violation (and sends a
  // report). Where that's refused, a plain string still works unless the
  // page also requires Trusted Types: then it can't be written at all.
  const onProbe = () => {
    removeEventListener('margin-shell-probe', onProbe, true);
    let writable = 'yes';
    try {
      policy = /** @type {any} */ (window).trustedTypes?.createPolicy('margin-shell', { createHTML: (html) => html }) ?? null;
    } catch {
      try {
        document.createElement('template').innerHTML = '';
      } catch {
        writable = 'no';
      }
    }
    // Read (and removed) by content/shell.js.
    document.documentElement.setAttribute('data-margin-writable', writable);
  };
  addEventListener('margin-shell-probe', onProbe, true);
  const onWrite = (/** @type {CustomEvent} */ event) => {
    removeEventListener('margin-shell-write', onWrite, true);
    event.stopImmediatePropagation();
    const root = document.documentElement;
    let result = 'error: no card';
    try {
      const frame = root.hasAttribute('data-margin-shell') ? root.querySelector(':scope > body > [data-margin-clip] > iframe[name^="margin-"]') : null;
      const card = /** @type {HTMLIFrameElement | null} */ (frame)?.contentWindow;
      if (card && typeof event.detail === 'string') {
        setUpCard(card, window);
        // Scrolling to the URL's fragment once the page is in (below) is a
        // fragment navigation, which fires popstate in Chrome; the page
        // without the shell gets none. Listening before the page can.
        let quiet = false;
        card.addEventListener('popstate', (/** @type {Event} */ e) => quiet && e.stopImmediatePropagation(), true);
        write.call(card.document, policy ? policy.createHTML(event.detail) : event.detail);
        close.call(card.document);
        if (card.location.hash) {
          quiet = true;
          try {
            card.location.replace(card.location.href);
          } finally {
            quiet = false;
          }
        }
        result = 'ok';
      }
    } catch (err) {
      result = `error: ${String(err).slice(0, 200)}`;
    }
    // Read (and removed) by content/shell.js.
    root.setAttribute('data-margin-written', result);
  };
  addEventListener('margin-shell-write', onWrite, true);
})();
