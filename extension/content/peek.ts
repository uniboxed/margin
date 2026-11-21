// Peek's link clicks on a web page (docs/PEEK-SPLIT.md §2): Shift+click on any http(s) link, and a plain click on a
// link to another site from a pinned tab or a favorite (Auto-Peek, `settings.autoPeekPins`; never an auth flow:
// shared/peek.ts), open in Margin.app's card instead of where the page would have opened them.
//
// What keeps a page working (the click is the page's first):
// - Only in a window Margin.app draws (`isDrawn`: the copy's `appDrawn` for this tab's window, never a copy that stood
//   back for a newer one); anywhere else nothing is looked at.
// - Heard in the bubble phase on the window, after the page's own handlers: a click the page handled itself
//   (`defaultPrevented`: a range select, a router's link, a menu) is left alone, and nothing here ever stops it
//   (no stopPropagation): every listener the page has hears it as before.
// - Only a trusted primary click with no ⌘, ⌃ or ⌥ (those are the browser's: a new tab, a download, Reading List's
//   ⌘⇧), on an `<a href>` (an SVG link's too) to another page, never a `download` link.
// - The click's default is cancelled at once (it can't be later), then the card asked for (`ask`); the app said no, or
//   no answer within `timeoutMs`: the link's own default done here (`fallback`: the same tab, or a new one for
//   `target=_blank` or another named target). Shift+click's own default in Safari (Reading List) isn't one a page can
//   do: it opens as a plain click would.
import { isPeekableUrl, shouldAutoPeek } from '../shared/peek.ts';

export type PeekSource = 'shift-click' | 'auto-peek';
/** The link's default, as the page would have had it: `newTab` for `target=_blank` or a named target. */
export type PeekLink = { url: string, newTab: boolean, source: PeekSource };
/** How long a click waits for the app's word before its link opens as it would have. */
export const PEEK_ANSWER_MS = 400;

type Listening = { addEventListener(type: string, fn: (e: any) => void, capture?: boolean): void, removeEventListener(type: string, fn: (e: any) => void, capture?: boolean): void };

// The link a click landed in: the innermost `<a>` with an address on the event's path (shadow roots included).
function linkOf(e: { composedPath?: () => unknown[], target?: unknown }): { href: string, target: string, download: boolean } | null {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
  for (const n of path as any[]) {
    if (!n || typeof n !== 'object' || n.nodeType !== 1) continue;
    if (String(n.localName).toLowerCase() !== 'a' || !n.hasAttribute?.('href')) continue;
    // (An SVG link's href is an animated string: its value.)
    const href = typeof n.href === 'string' ? n.href : typeof n.href?.baseVal === 'string' ? resolveHref(n.href.baseVal, n) : '';
    const target = String(n.getAttribute?.('target') ?? (typeof n.target === 'string' ? n.target : n.target?.baseVal) ?? '');
    return { href, target, download: !!n.hasAttribute?.('download') };
  }
  return null;
}
function resolveHref(raw: string, n: any) {
  try { return new URL(raw, n.ownerDocument?.baseURI ?? undefined).href; } catch { return ''; }
}
// A named target other than this frame's own (`_self`, `_top`, `_parent`, none) opens elsewhere: a new tab here.
const opensNewTab = (target: string) => { const t = target.trim().toLowerCase(); return t !== '' && t !== '_self' && t !== '_top' && t !== '_parent'; };
const withoutHash = (u: string) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; } };

export function startPeek({
  win = globalThis as unknown as Listening,
  currentUrl = () => String((globalThis as any).location?.href ?? ''),
  isDrawn,
  isPinnedOrFav,
  autoPeekEnabled,
  ask,
  fallback,
  timeoutMs = PEEK_ANSWER_MS,
}: {
  win?: Listening,
  currentUrl?: () => string,
  /** Margin.app draws this tab's window and this copy is the one in charge. */
  isDrawn: () => boolean,
  isPinnedOrFav: () => boolean,
  autoPeekEnabled: () => boolean,
  /** The card asked for: true once the app took it; false, undefined or a failure: it didn't. */
  ask: (url: string, source: PeekSource, newTab: boolean) => Promise<unknown>,
  /** The link's own default, done here (the app refused it, or didn't answer in time). */
  fallback: (link: PeekLink) => void,
  timeoutMs?: number,
}) {
  const onClick = (e: any) => {
    if (!e || e.defaultPrevented || e.isTrusted !== true || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const link = linkOf(e);
    if (!link || link.download || !isPeekableUrl(link.href)) return;
    const here = currentUrl();
    // (A link to this page's own part: the page's to scroll, never a card of itself.)
    if (withoutHash(link.href) === withoutHash(here) && link.href !== withoutHash(link.href)) return;
    if (!isDrawn()) return;
    let source: PeekSource;
    if (e.shiftKey) source = 'shift-click';
    else if (shouldAutoPeek({ href: link.href, currentUrl: here, fromPinnedOrFav: isPinnedOrFav(), autoPeekEnabled: autoPeekEnabled() })) source = 'auto-peek';
    else return;
    e.preventDefault();
    const out: PeekLink = { url: link.href, newTab: opensNewTab(link.target), source };
    let settled = false;
    const giveUp = () => { if (settled) return; settled = true; fallback(out); };
    const timer = setTimeout(giveUp, timeoutMs);
    let asked: Promise<unknown>;
    try { asked = Promise.resolve(ask(out.url, source, out.newTab)); } catch { asked = Promise.resolve(false); }
    asked.then((ok) => {
      if (settled) return;
      clearTimeout(timer);
      if (ok === true) { settled = true; return; }
      giveUp();
    }, () => { clearTimeout(timer); giveUp(); });
  };
  win.addEventListener('click', onClick, false);
  return {
    destroy() {
      win.removeEventListener('click', onClick, false);
    },
  };
}

// ---- the card's own window (docs/PEEK-SPLIT.md §2 "Inside") ----------------------------------------------------
// Only in a page of the card's window (`cardWindow` from the copy): Esc the page didn't handle, not in a field,
// closes the card; ⌘↩ the page didn't handle, not in a field, expands it. Both bubble on the window, after the page.
const editable = (el: any) => !!el && (el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select' || el.isContentEditable === true);
export function startCardKeys({ win = globalThis as unknown as Listening, active = () => (globalThis as any).document?.activeElement, send }: {
  win?: Listening,
  active?: () => unknown,
  send: (key: 'close' | 'expand') => void,
}) {
  let on = false;
  const onKey = (e: any) => {
    if (!on || !e || e.defaultPrevented || e.isTrusted !== true || e.repeat || e.isComposing) return;
    if (editable(e.target) || editable(active())) return;
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) { e.preventDefault(); send('close'); return; }
    if (e.key === 'Enter' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) { e.preventDefault(); send('expand'); }
  };
  return {
    /** In the card's window or not (the copy says so as the page starts and as its tab moves). */
    set(next: boolean) {
      if (next === on) return;
      on = next;
      if (on) win.addEventListener('keydown', onKey, false);
      else win.removeEventListener('keydown', onKey, false);
    },
    get on() { return on; },
  };
}
