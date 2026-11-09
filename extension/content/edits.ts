// What the user has typed or chosen in this page and not sent or cleared yet
// (background/sleep.ts asks before it puts the tab to sleep: a sleeping tab
// goes back to its page's address, and a draft would be lost). Only what the
// user did (trusted input and change events), in the page itself, and only
// while it's still there: a field the user typed into that still holds text
// other than what it held when the user first came to it (focus, or the first
// `beforeinput`), a choice changed from what it was then, an editor typed into
// still holding text (a chat's box sent and emptied counts no more). Not the
// field's `defaultValue`: React keeps a controlled field's value attribute in
// step with its value, so a typed draft would equal it. Frames of the same
// site, where no event reaches here, are judged generously: any text in a
// field or an editor (other
// sites' frames are asked on their own: background/sleep.ts sleepInPage).
// A watch started once the page had loaded (Margin installed or updated, its
// scripts added to pages already open) missed what was typed before: it also
// judges the whole page that generous way (`late`), except for text the page
// put there itself (a field's value as its own HTML has it: a results page's
// query in its search box, as on Google's, which kept every such tab awake
// until it was next loaded, in Tirth's Safari, 2026-11-04) in a field the
// cursor isn't in. (A React app's draft typed before Margin came equals its
// value attribute too: kept awake while its field has the focus, where a
// half-written message stays, even with its tab hidden.)
const FIELDS = 'textarea, select, input:not([type=hidden], [type=button], [type=submit], [type=reset], [type=image], [type=file])';
const TEXT_FIELDS = 'textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=number], input[type=password]';
const EDITORS = '[contenteditable]:not([contenteditable=false])';
const KEPT = 20;

/** whether anything is still edited */
export function watchEdits(win: Window = window, doc: Document = document): (() => boolean) & { late: boolean } {
  let touched: Element[] = [];
  // What each field held when the user first came to it.
  const before: WeakMap<Element, string> = new WeakMap();
  const late = doc.readyState !== 'loading';
  const fieldOf = (event: Event) => {
    if (!event.isTrusted) return null;
    const from = ((event.composedPath?.()[0] ?? event.target) as any);
    if (!from || typeof from.matches !== 'function') return null;
    return from.matches(FIELDS) ? from : from.closest?.(EDITORS) ?? (from.isContentEditable ? from : null);
  };
  const first = (event: Event) => {
    const field = fieldOf(event);
    if (field && !isEditor(field) && !before.has(field)) {
      try {
        before.set(field, snapshot(field));
      } catch {}
    }
  };
  const note = (event: Event) => {
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

const isEditor = (el: any) => !!(el.isContentEditable || el.hasAttribute?.('contenteditable'));
function snapshot(el: any) {
  if (el.matches('select')) return [...el.options].map((o: any) => (o.selected ? '1' : '0')).join('');
  if (el.matches('input[type=checkbox], input[type=radio]')) return String(!!el.checked);
  return String(el.value ?? '');
}

function stillEdited(el: any, before: WeakMap<Element, string>) {
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

// Any text in a field other than the page's own (or in the field with the
// focus) or in an editor, or a choice not the page's own.
function fieldsInUse(doc: Document) {
  try {
    for (const el of ([...doc.querySelectorAll(TEXT_FIELDS)] as any[])) {
      const value = String(el.value ?? '');
      if (value.trim() && (value !== String(el.defaultValue ?? '') || el === doc.activeElement)) return true;
    }
    for (const el of ([...doc.querySelectorAll(EDITORS)] as any[])) if (el.isContentEditable && String(el.textContent ?? '').trim()) return true;
    for (const el of ([...doc.querySelectorAll('select')] as any[])) if ([...el.options].some((o) => o.selected !== o.defaultSelected)) return true;
    for (const el of ([...doc.querySelectorAll('input[type=checkbox], input[type=radio]')] as any[])) if (el.checked !== el.defaultChecked) return true;
    return false;
  } catch {
    return true; // can't tell: kept awake
  }
}

function framesInUse(doc: Document, depth = 0) {
  if (depth > 4) return false;
  for (const frame of ([...doc.querySelectorAll('iframe, frame')] as any[])) {
    let inner = null;
    try {
      inner = frame.contentDocument;
    } catch {
      continue; // another site's: asked on its own (background/sleep.ts)
    }
    if (!inner) continue;
    for (const el of ([...inner.querySelectorAll(TEXT_FIELDS)] as any[])) if (String(el.value ?? '').trim()) return true;
    for (const el of ([...inner.querySelectorAll(EDITORS)] as any[])) if (el.isContentEditable && String(el.textContent ?? '').trim()) return true;
    if (framesInUse(inner, depth + 1)) return true;
  }
  return false;
}
