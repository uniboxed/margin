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
  })) host.style.setProperty(prop, value, 'important');
  return host;
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

export { el, adoptStyles, createHost, siteModalOpen, hostOf };
