// The bar over a theme being previewed (docs/phase6-themes.md §3): Margin's
// own, never the theme's. "Previewing “Name” 1.0.0 by Author. Use this
// theme?" with Use Theme and Cancel (and "Replaces version 0.9.0" when that
// id is installed). Escape cancels; with no answer in 30 s it cancels by
// itself, so a theme that hides everything can't trap anyone.
//
// The theme's stylesheet is adopted by the overlay's document, so it reaches
// every element there; the bar keeps out of its way:
// - its content is in a closed shadow root, where no outside rule reaches;
// - its host is in the top layer (`popover="manual"`, shown with
//   showPopover()), above anything a z-index can stack;
// - the host's own style is reset with `all: initial !important` twice: in
//   its style attribute, and from inside its shadow root (`:host`), where an
//   !important declaration beats the outside's !important; its ::before and
//   ::after are switched off the same way;
// - it hangs off <html>, not <body>, which a theme can hide.
// The name, version and author are text nodes, capped, with the characters
// that reorder or hide text taken out. Pure DOM: the overlay and the tests.
import { themeText } from './settings-form.ts';

export const PREVIEW_MS = 30_000;
const TAG = 'margin-preview-bar';
const HOST_STYLE = 'all:initial!important;inset:auto!important;position:fixed!important;left:50%!important;top:12px!important;transform:translateX(-50%)!important;display:block!important;'
  + 'margin:0!important;padding:0!important;border:0!important;background:transparent!important;width:auto!important;height:auto!important;'
  + 'visibility:visible!important;opacity:1!important;pointer-events:auto!important;z-index:2147483647!important;overflow:visible!important;';
const SHADOW_CSS = `:host{${HOST_STYLE}}:host::before,:host::after,:host::backdrop{display:none!important;content:none!important}
.bar{all:initial;box-sizing:border-box;display:flex;align-items:center;gap:12px;max-width:min(720px,calc(100vw - 24px));padding:10px 12px 10px 16px;border-radius:12px;
background:rgba(28,28,30,.96);color:#fff;font:13px/1.35 -apple-system,system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.12);pointer-events:auto}
.text{all:initial;font:inherit;color:inherit;flex:1;min-width:0;overflow-wrap:anywhere}
.text b{font-weight:600}.note{opacity:.7;display:block}
button{all:initial;font:600 13px/1 -apple-system,system-ui,sans-serif;padding:8px 12px;border-radius:8px;cursor:default;color:#fff;background:rgba(255,255,255,.14);white-space:nowrap}
button.use{background:#0a84ff}button:focus-visible{outline:2px solid #fff;outline-offset:1px}`;

export function createPreviewBar({ doc = globalThis.document, onUse, onCancel, ms = PREVIEW_MS, setTimer = setTimeout, clearTimer = clearTimeout }: { doc?: Document, onUse: () => void, onCancel: (why: 'button' | 'escape' | 'timeout') => void, ms?: number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }) {
  let host: HTMLElement | null = null;
  let shadow: ShadowRoot | null = null;
  let timer: Timer | null = null;
  const keydown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !host) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    finish('escape');
  };
  function finish(how: 'use' | 'button' | 'escape' | 'timeout') {
    if (!host) return;
    hide();
    if (how === 'use') onUse(); else onCancel(how);
  }
  function hide() {
    clearTimer(timer);
    timer = null;
    doc.removeEventListener('keydown', keydown, true);
    if (host) { try { host.hidePopover?.(); } catch {} host.remove(); }
    host = null;
    shadow = null;
  }
  return {
    show(what: { name: string, version: string, author?: string, replaces?: string | null }) {
      hide();
      host = doc.createElement(TAG);
      host.setAttribute('style', HOST_STYLE);
      host.setAttribute('popover', 'manual');
      host.setAttribute('role', 'dialog');
      host.setAttribute('aria-label', 'Theme preview');
      shadow = host.attachShadow({ mode: 'closed' });
      const style = doc.createElement('style');
      style.textContent = SHADOW_CSS;
      const bar = doc.createElement('div');
      bar.className = 'bar';
      const text = doc.createElement('div');
      text.className = 'text';
      const name = doc.createElement('b');
      name.textContent = `“${themeText(what.name, 60) || 'Untitled'}”`;
      text.append('Previewing ', name, ` ${themeText(what.version, 16)}`);
      const author = themeText(what.author, 60);
      if (author) text.append(` by ${author}`);
      text.append('. Use this theme?');
      if (what.replaces) {
        const note = doc.createElement('span');
        note.className = 'note';
        note.textContent = `Replaces version ${themeText(what.replaces, 16)}.`;
        text.append(note);
      }
      const use = doc.createElement('button');
      use.className = 'use';
      use.textContent = 'Use Theme';
      use.addEventListener('click', () => finish('use'));
      const cancel = doc.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => finish('button'));
      bar.append(text, cancel, use);
      shadow.append(style, bar);
      doc.documentElement.append(host);
      try { host.showPopover?.(); } catch {}
      doc.addEventListener('keydown', keydown, true);
      timer = setTimer(() => finish('timeout'), ms);
      try { use.focus({ preventScroll: true }); } catch {}
    },
    hide,
    get shown() { return !!host; },
    /** Where it is, for the app's pointer (the overlay's `hits`). */
    rect(): [number, number, number, number] | null {
      const r = shadow?.querySelector('.bar')?.getBoundingClientRect();
      const half = (v: number) => Math.round(v * 2) / 2;
      return r ? [half(r.left), half(r.top), half(r.width), half(r.height)] : null;
    },
    /** A test's: press one of its buttons. */
    press(which: 'use' | 'cancel') { (shadow?.querySelector(which === 'use' ? 'button.use' : 'button:not(.use)') as HTMLElement | null | undefined)?.click(); },
    /** A test's: what it says. */
    text() { return shadow?.querySelector('.text')?.textContent ?? null; },
  };
}
