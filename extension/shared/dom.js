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

// What a host is, in its own shadow root rather than on the tag. `!important`
// there beats everything the page's styles can say, !important and style
// attributes too (the cascade lets the inner context win), so the page can't
// touch it, and the tag stays bare in the inspector. `data-margin-off`: put
// out of sight (hideHost; `display` from outside would lose to `all`).
const HOST_CSS = `:host {
  all: initial !important;
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 0 !important;
  height: 0 !important;
  z-index: 2147483647 !important;
  /* Margin's UI isn't page text (asBrowserUi): inherited by what's inside,
     text fields excepted by their own styles. */
  -webkit-user-select: none !important;
  user-select: none !important;
}
:host([data-margin-off]) { display: none !important; pointer-events: none !important; }`;

// Zero-size, top-most host with a closed shadow root that site CSS can't
// touch; { host, shadow }. Hosts are named margin-*-host and live in the page's
// one <margin-app> (mountHost). The fitted layout (content/shell.js) moves that
// into its shell, and a later copy of Margin hides them (content/core.js).
function createHost(doc, tag) {
  const host = doc.createElement(tag);
  // This copy's, seen only from its own script world (page scripts and other
  // copies can't see it).
  /** @type {any} */ (host).__marginCopy = true;
  const shadow = host.attachShadow({ mode: 'closed' });
  adoptStyles(shadow, HOST_CSS);
  // Its zoom (unzoom), a sheet of its own for the same reason: nothing on the
  // tag, and a page's own --page-zoom can't reach what's inside.
  if ('adoptedStyleSheets' in shadow) {
    const zoomSheet = new CSSStyleSheet();
    shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, zoomSheet];
    /** @type {any} */ (host).__marginZoom = zoomSheet;
  }
  unzoom(host, /** @type {any} */ (globalThis).marginPageZoom ?? 1);
  return { host, shadow };
}

// The one tag Margin adds to a page, shared by its hosts: no box of its own,
// and what's in it shows through a slot.
const APP_TAG = 'margin-app';
const APP_ROOT = ':root > margin-app'; // Margin's, not a page's own of that name
function appRoot(doc) {
  const found = doc.querySelector(APP_ROOT);
  if (found) return found;
  const root = doc.createElement(APP_TAG);
  const shadow = root.attachShadow({ mode: 'closed' });
  adoptStyles(shadow, ':host { all: initial !important; display: contents !important; }');
  shadow.append(doc.createElement('slot'));
  return root;
}
// `host` into the page (again, if the page replaced what's under <html>).
/** @param {HTMLElement} host */
function mountHost(host) {
  const doc = host.ownerDocument;
  if (!doc.documentElement) return;
  const root = appRoot(doc);
  if (host.parentNode !== root) root.append(host);
  if (!root.isConnected) doc.documentElement.append(root);
}
// Every Margin host in `doc`: in <margin-app>, or an older copy's under <html>.
/** @param {Document} doc @returns {HTMLElement[]} */
function marginHosts(doc) {
  const nodes = [...(doc.documentElement?.children ?? []), ...(doc.querySelector(APP_ROOT)?.children ?? [])];
  return /** @type {HTMLElement[]} */ (nodes.filter((node) => /^margin-.*-host$/.test(node.localName)));
}
// Out of sight (an older copy's host has only its inline display to go by),
// and back.
/** @param {HTMLElement} node */
function hideHost(node) {
  node.style.setProperty('display', 'none', 'important');
  node.setAttribute('data-margin-off', '');
}
/** @param {HTMLElement} node */
function showHost(node) {
  node.style.removeProperty('display');
  node.removeAttribute('data-margin-off');
  if (!node.getAttribute('style')) node.removeAttribute('style');
}
// State shown on a host for tests and nothing else (the page's inspector
// stays clean): only under a test harness, which sets this in Margin's world.
/** @param {HTMLElement} host @param {string} key @param {string} [value] (none: taken off) */
function mark(host, key, value) {
  if (!(/** @type {any} */ (globalThis).__marginMarks)) return;
  if (value === undefined) delete host.dataset[key];
  else host.dataset[key] = value;
}

// ---- Margin's UI as the browser's own ----------------------------------------
// The browser's page zoom (⌘+ / ⌘−) scales everything in the
// page, Margin's UI with it; a browser's own UI keeps its size. So Margin's
// hosts are scaled back by 1/zoom (CSS zoom: what they show, and how they're
// hit, at their normal size), and `--page-zoom` lets their styles undo it
// where it doesn't apply (viewport units are scaled by it too: 100vh is
// written calc(100vh * var(--page-zoom, 1))). Pointer positions and
// getBoundingClientRect() inside stay in the page's (zoomed) pixels; sizes
// set in CSS are the host's. content/core.js follows the zoom.
/** @param {HTMLElement} el @param {number} zoom */
function unzoom(el, zoom) {
  const sheet = /** @type {any} */ (el).__marginZoom; // this copy's host (createHost)
  if (sheet) return sheet.replaceSync(`:host { --page-zoom: ${zoom} !important; zoom: ${1 / zoom} !important; }`);
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
  for (const node of marginHosts(doc)) unzoom(node, zoom);
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
    // (Margin's rows drag by the pointer's own events: themes/arcadia/sidebar.js.)
    if (source instanceof Element && /^(IMG|A)$/.test(source.tagName) && !source.closest('[draggable="true"]')) event.preventDefault();
  });
  root.addEventListener('webkitmouseforcewillbegin', (event) => event.preventDefault());
  root.addEventListener('wheel', (event) => {
    if (/** @type {WheelEvent} */ (event).ctrlKey && event.cancelable && !fromHost(event) && !zoomable(event)) event.preventDefault();
  }, { passive: false });
  // Safari's pinch, whenever Margin's gesture guard leaves it to Safari: not
  // over Margin's UI.
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

export { el, adoptStyles, createHost, mountHost, marginHosts, hideHost, showHost, mark, setPageZoom, unzoom, asBrowserUi, siteModalOpen, hostOf };
