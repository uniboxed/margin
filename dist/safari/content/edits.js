// What the user has typed or chosen in this page and not sent or cleared yet
// (background/sleep.js asks before it puts the tab to sleep: a sleeping tab
// goes back to its page's address, and a draft would be lost). Only what the
// user did (trusted input and change events), in the page itself, and only
// while it's still there: a field the user typed into that still holds text
// other than what it held when the user first came to it (focus, or the first
// `beforeinput`), a choice changed from what it was then, an editor typed into
// still holding text (a chat's box sent and emptied counts no more). Not the
// field's `defaultValue`: React keeps a controlled field's value attribute in
// step with its value, so a typed draft would equal it. Frames of the same
// site, where no event reaches here, are judged generously, as
// content/takeover.js judges a page: any text in a field or an editor (other
// sites' frames are asked on their own: background/sleep.js sleepInPage).
// A watch started once the page had loaded (Margin installed or updated, its
// scripts added to pages already open) missed what was typed before: it also
// judges the whole page that generous way (`late`).
const FIELDS = 'textarea, select, input:not([type=hidden], [type=button], [type=submit], [type=reset], [type=image], [type=file])';
const TEXT_FIELDS = 'textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=number], input[type=password]';
const EDITORS = '[contenteditable]:not([contenteditable=false])';
const KEPT = 20;

/** @param {Window} [win] @param {Document} [doc] @returns {(() => boolean) & { late: boolean }} whether anything is still edited */
export function watchEdits(win = window, doc = document) {
  /** @type {Element[]} */
  let touched = [];
  // What each field held when the user first came to it.
  /** @type {WeakMap<Element, string>} */
  const before = new WeakMap();
  const late = doc.readyState !== 'loading';
  const fieldOf = (/** @type {Event} */ event) => {
    if (!event.isTrusted) return null;
    const from = /** @type {any} */ (event.composedPath?.()[0] ?? event.target);
    if (!from || typeof from.matches !== 'function') return null;
    return from.matches(FIELDS) ? from : from.closest?.(EDITORS) ?? (from.isContentEditable ? from : null);
  };
  const first = (/** @type {Event} */ event) => {
    const field = fieldOf(event);
    if (field && !isEditor(field) && !before.has(field)) {
      try {
        before.set(field, snapshot(field));
      } catch {}
    }
  };
  const note = (/** @type {Event} */ event) => {
    const target = fieldOf(event);
    if (!target) return;
    touched = [target, ...touched.filter((t) => t !== target && t.isConnected)].slice(0, KEPT);
  };
  win.addEventListener('focusin', first, true);
  win.addEventListener('beforeinput', first, true);
  win.addEventListener('input', note, true);
  win.addEventListener('change', note, true);
  const edited = () => touched.some((el) => stillEdited(el, before)) || framesInUse(doc) || (late && fieldsInUse(doc));
  return Object.assign(edited, { late });
}

/** @param {any} el */
const isEditor = (el) => !!(el.isContentEditable || el.hasAttribute?.('contenteditable'));
/** @param {any} el */
function snapshot(el) {
  if (el.matches('select')) return [...el.options].map((/** @type {any} */ o) => (o.selected ? '1' : '0')).join('');
  if (el.matches('input[type=checkbox], input[type=radio]')) return String(!!el.checked);
  return String(el.value ?? '');
}

/** @param {any} el @param {WeakMap<Element, string>} before */
function stillEdited(el, before) {
  try {
    if (!el.isConnected) return false;
    if (isEditor(el)) return !!String(el.textContent ?? '').trim();
    const was = before.get(el);
    if (el.matches('select')) return was != null ? snapshot(el) !== was : [...el.options].some((o) => o.selected !== o.defaultSelected);
    if (el.matches('input[type=checkbox], input[type=radio]')) return was != null ? snapshot(el) !== was : el.checked !== el.defaultChecked;
    const value = String(el.value ?? '');
    // (Not known what it held before: typed into and holding text is enough.)
    return !!value.trim() && value !== was;
  } catch {
    return true; // can't tell: kept awake
  }
}

// Any text in a field or an editor, or a choice not the page's own.
/** @param {Document} doc */
function fieldsInUse(doc) {
  try {
    for (const el of /** @type {any[]} */ ([...doc.querySelectorAll(TEXT_FIELDS)])) if (String(el.value ?? '').trim()) return true;
    for (const el of /** @type {any[]} */ ([...doc.querySelectorAll(EDITORS)])) if (el.isContentEditable && String(el.textContent ?? '').trim()) return true;
    for (const el of /** @type {any[]} */ ([...doc.querySelectorAll('select')])) if ([...el.options].some((o) => o.selected !== o.defaultSelected)) return true;
    for (const el of /** @type {any[]} */ ([...doc.querySelectorAll('input[type=checkbox], input[type=radio]')])) if (el.checked !== el.defaultChecked) return true;
    return false;
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
      continue; // another site's: asked on its own (background/sleep.js)
    }
    if (!inner) continue;
    for (const el of /** @type {any[]} */ ([...inner.querySelectorAll(TEXT_FIELDS)])) if (String(el.value ?? '').trim()) return true;
    for (const el of /** @type {any[]} */ ([...inner.querySelectorAll(EDITORS)])) if (el.isContentEditable && String(el.textContent ?? '').trim()) return true;
    if (framesInUse(inner, depth + 1)) return true;
  }
  return false;
}
