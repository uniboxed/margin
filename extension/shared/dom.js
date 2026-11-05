// DOM helpers for Margin's content script and the UI's view model. Pages
// hold no element of Margin's own (Margin 2: Margin.app draws its UI); what's
// left here is for sidebars an earlier build left in a page, test marks, and
// addresses.

// Every Margin host in `doc`, an earlier build's sidebar: in its <margin-app>,
// or an older copy's under <html> (content/core.js puts them out of sight).
const APP_ROOT = ':root > margin-app'; // Margin's, not a page's own of that name
/** @param {Document} doc @returns {HTMLElement[]} */
function marginHosts(doc) {
  const nodes = [...(doc.documentElement?.children ?? []), ...(doc.querySelector(APP_ROOT)?.children ?? [])];
  return /** @type {HTMLElement[]} */ (nodes.filter((node) => /^margin-.*-host$/.test(node.localName)));
}
// Out of sight (an older copy's host has only its inline display to go by).
/** @param {HTMLElement} node */
function hideHost(node) {
  node.style.setProperty('display', 'none', 'important');
  node.setAttribute('data-margin-off', '');
}
// State kept for tests and nothing else: only under a test harness, which
// sets this in Margin's world. `target`: anything with a `dataset`
// (content/core.js keeps one of its own, `Margin.content.marks()`).
/** @param {{ dataset: Record<string, string | undefined> }} target @param {string} key @param {string} [value] (none: taken off) */
function mark(target, key, value) {
  if (!(/** @type {any} */ (globalThis).__marginMarks)) return;
  if (value === undefined) delete target.dataset[key];
  else target.dataset[key] = value;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export { marginHosts, hideHost, mark, hostOf };
