// DOM helpers for Margin's content script and the UI's view model. Pages
// hold no element of Margin's own (Margin 2: Margin.app draws its UI); what's
// left here is test marks and addresses.

// State kept for tests and nothing else: only under a test harness, which
// sets this in Margin's world. `target`: anything with a `dataset`
// (content/core.ts keeps one of its own, `Margin.content.marks()`).
/** @param value (none: taken off) */
function mark(target: { dataset: Record<string, string | undefined> }, key: string, value?: string) {
  if (!((globalThis as any).__marginMarks)) return;
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

export { mark, hostOf };
