// What the user has typed or chosen in this page and not sent or cleared yet
// (background/sleep.js asks before it puts the tab to sleep: a sleeping tab
// goes back to its page's address, and a draft would be lost). Only what the
// user did (trusted input and change events), in the page itself, and only
// while it's still there: a field still holding what was typed (not what the
// page put there), a choice still not the page's own, an editor typed into
// still holding text (a chat's box sent and emptied counts no more). Frames
// of the same site, where no event reaches here, are judged generously, as
// content/takeover.js judges a page: any text in a field or an editor.
const FIELDS = 'textarea, select, input:not([type=hidden], [type=button], [type=submit], [type=reset], [type=image], [type=file])';
const KEPT = 20;

/** @param {Window} [win] @param {Document} [doc] @returns {() => boolean} whether anything is still edited */
export function watchEdits(win = window, doc = document) {
  /** @type {Element[]} */
  let touched = [];
  const note = (/** @type {Event} */ event) => {
    if (!event.isTrusted) return;
    const from = /** @type {any} */ (event.composedPath?.()[0] ?? event.target);
    if (!from || typeof from.matches !== 'function') return;
    const target = from.matches(FIELDS) ? from : from.closest?.('[contenteditable]:not([contenteditable=false])') ?? (from.isContentEditable ? from : null);
    if (!target) return;
    touched = [target, ...touched.filter((t) => t !== target && t.isConnected)].slice(0, KEPT);
  };
  win.addEventListener('input', note, true);
  win.addEventListener('change', note, true);
  return () => touched.some(stillEdited) || framesInUse(doc);
}

/** @param {any} el */
function stillEdited(el) {
  try {
    if (!el.isConnected) return false;
    if (el.isContentEditable || el.hasAttribute?.('contenteditable')) return !!String(el.textContent ?? '').trim();
    if (el.matches('select')) return [...el.options].some((o) => o.selected !== o.defaultSelected);
    if (el.matches('input[type=checkbox], input[type=radio]')) return el.checked !== el.defaultChecked;
    const value = String(el.value ?? '');
    return !!value.trim() && value !== String(el.defaultValue ?? '');
  } catch {
    return true; // can't tell: kept awake
  }
}

/** @param {Document} doc */
function framesInUse(doc, depth = 0) {
  if (depth > 4) return false;
  for (const frame of /** @type {any[]} */ ([...doc.querySelectorAll('iframe, frame')])) {
    let inner = null;
    try {
      inner = frame.contentDocument;
    } catch {
      continue; // another site's: its own business
    }
    if (!inner) continue;
    for (const el of /** @type {any[]} */ ([...inner.querySelectorAll('textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=number], input[type=password]')])) if (String(el.value ?? '').trim()) return true;
    for (const el of /** @type {any[]} */ ([...inner.querySelectorAll('[contenteditable]:not([contenteditable=false])')])) if (el.isContentEditable && String(el.textContent ?? '').trim()) return true;
    if (framesInUse(inner, depth + 1)) return true;
  }
  return false;
}
