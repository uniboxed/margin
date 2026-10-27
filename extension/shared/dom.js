// DOM helpers for core and every theme (no styling of their own).

function el(doc, tag, attrs = {}, ...children) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') node.style.cssText = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
}

// Apply CSS text inside a shadow root, synchronously. Constructable
// stylesheets aren't subject to the page's CSP; fall back to <style>.
function adoptStyles(shadow, css) {
  if ('adoptedStyleSheets' in shadow && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
  } else {
    const style = shadow.ownerDocument.createElement('style');
    style.textContent = css;
    shadow.prepend(style);
  }
}

// Zero-size, top-most host for a closed shadow root that site CSS can't touch.
// Hosts are named margin-*: the fitted layout (content/shell.js) moves those
// into its shell, and a later copy of Margin removes them (content/core.js).
function createHost(doc, tag) {
  const host = doc.createElement(tag);
  for (const [prop, value] of Object.entries({
    all: 'initial',
    position: 'fixed',
    top: '0',
    left: '0',
    width: '0',
    height: '0',
    'z-index': '2147483647',
    // Margin's UI isn't page text (asBrowserUi): inherited by what's inside,
    // text fields excepted by their own styles.
    '-webkit-user-select': 'none',
    'user-select': 'none',
  })) host.style.setProperty(prop, value, 'important');
  unzoom(host, /** @type {any} */ (globalThis).marginPageZoom ?? 1);
  return host;
}

// ---- Margin's UI as the browser's own ----------------------------------------
// The browser's page zoom (⌘+ / ⌘−, Margin's pinch) scales everything in the
// page, Margin's UI with it; a browser's own UI keeps its size. So Margin's
// hosts are scaled back by 1/zoom (CSS zoom: what they show, and how they're
// hit, at their normal size), and `--page-zoom` lets their styles undo it
// where it doesn't apply (viewport units are scaled by it too: 100vh is
// written calc(100vh * var(--page-zoom, 1))). Pointer positions and
// getBoundingClientRect() inside stay in the page's (zoomed) pixels; sizes
// set in CSS are the host's. content/core.js follows the zoom.
/** @param {HTMLElement} el @param {number} zoom */
function unzoom(el, zoom) {
  if (zoom === 1) {
    el.style.removeProperty('zoom');
    el.style.removeProperty('--page-zoom');
    return;
  }
  el.style.setProperty('zoom', String(1 / zoom), 'important');
  el.style.setProperty('--page-zoom', String(zoom));
}
// The page's zoom is now `zoom`: every Margin host in `doc` (and later ones,
// createHost) keeps its size.
/** @param {Document} doc @param {number} zoom */
function setPageZoom(doc, zoom) {
  /** @type {any} */ (globalThis).marginPageZoom = zoom; // for hosts made later (one bundle's module isn't another's)
  for (const node of doc.documentElement?.children ?? []) {
    if (/^margin-.*-host$/.test(node.localName)) unzoom(/** @type {HTMLElement} */ (node), zoom);
  }
}

// Margin's own UI under `root` (a shadow root, or Margin's new-tab page)
// behaves as a browser's: no page context menu (Margin's own menus stay), no
// selecting its text or dragging its pictures and links out, no Look Up
// (force click), and a pinch over it (⌃+wheel in Chrome; Safari's gesture
// events) zooms nothing. Text fields keep all of theirs. In a shadow root
// on a web page, a right-click stops there too: the page's own scripts never
// see it (some open their own menus for any right-click). `zoomable`: a part
// that is page content (the new-tab page's launcher), which zooms.
const TEXT_INPUTS = /^(text|search|url|email|tel|password|number)$/;
/** @param {Document | ShadowRoot} root @param {{ zoomable?: (event: Event) => boolean }} [options] */
function asBrowserUi(root, { zoomable = () => false } = {}) {
  const editable = (/** @type {Event} */ event) => event.composedPath().some((node) => node instanceof Element && (
    node.tagName === 'TEXTAREA'
    || (node instanceof HTMLInputElement && TEXT_INPUTS.test(node.type) && !node.readOnly)
    || /** @type {HTMLElement} */ (node).isContentEditable));
  // Seen from a document, an event from inside a Margin host's (closed)
  // shadow root: that root's own handler has decided.
  const fromHost = (/** @type {Event} */ event) => /^margin-.*-host$/.test(/** @type {Element} */ (event.composedPath()[0])?.localName ?? '');
  const shadow = !(root instanceof Document);
  root.addEventListener('contextmenu', (event) => {
    if (fromHost(event)) return;
    if (!editable(event)) event.preventDefault();
    if (shadow) event.stopPropagation();
  });
  root.addEventListener('selectstart', (event) => { if (!fromHost(event) && !editable(event)) event.preventDefault(); });
  root.addEventListener('dragstart', (event) => {
    const source = event.composedPath()[0];
    // Margin's draggable rows (tabs, pins, folders) keep theirs.
    if (source instanceof Element && /^(IMG|A)$/.test(source.tagName) && !source.closest('[draggable="true"]')) event.preventDefault();
  });
  root.addEventListener('webkitmouseforcewillbegin', (event) => event.preventDefault());
  root.addEventListener('wheel', (event) => {
    if (/** @type {WheelEvent} */ (event).ctrlKey && event.cancelable && !fromHost(event) && !zoomable(event)) event.preventDefault();
  }, { passive: false });
  // Safari's pinch, when Margin's gesture guard leaves it to Safari (its
  // setting off, or the page already magnified): not over Margin's UI.
  if (shadow) for (const type of ['gesturestart', 'gesturechange']) root.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}

// A site's modal <dialog> makes everything outside it inert, even what's in
// the top layer above it: Margin's UI then stays out of the top layer.
function siteModalOpen(doc) {
  try {
    return !!doc.querySelector(':modal');
  } catch {
    return false; // no :modal support
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export { el, adoptStyles, createHost, setPageZoom, unzoom, asBrowserUi, siteModalOpen, hostOf };
