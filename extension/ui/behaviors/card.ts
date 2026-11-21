// Peek's card and Little Arc in Margin's UI (docs/PEEK-SPLIT.md §2, §3). (Not behaviors/peek.ts: that's the sidebar's
// hover reveal, an older use of the name; native code calls this one the card.)
//
// The theme draws it: its guarded `<template m-part="peek">` in `<m-peek>` while `peek` is set, with an
// `<m-peek-page>` where the card's page goes (Margin.app places the card's Safari window exactly there: the element is
// measured as `<m-page>` is, ui/render.ts View.measurePeekPage, and sent with the page's layout) and a bar for its
// buttons (`peek.back`, `peek.forward`, `peek.copyUrl`, `peek.expand`, `peek.close`). The dimmed page around it and its
// frame are the theme's CSS; the theme sees `peek.loading` (its window not in place yet: `<m-peek-page>` covered),
// `peek.ready` (in place: `<m-peek-page>` clear, the page showing through) and `peek.closing` (going: its open
// reversed, then gone after CARD_MOTION_MS).
//
// What comes from where:
// - Margin.app says what the card is (`show`: its `peek` push; null: it closed it, animated out here).
// - Its buttons go to the app (host.perform `peek.*`); Close and Expand also start the card's going here at once, so
//   the window under `<m-peek-page>` is covered before the app parks or moves it.
// - Little Arc (⌥⌘N, `littleArc.open`): the card with Margin's own field (`m-input="peek"`) and no page yet. Return
//   takes what's typed as the palette does (shared/search.ts resolveInput: an address, else a search) and asks the app
//   for the card at it (`peek.go`); Escape closes it. A host with no card (no Margin.app): a new tab at it.
// - Escape anywhere in Margin's UI while the card is open (no menu, palette or field of another kind in the way)
//   closes it; ⌘↩ expands it.
import type { Rt } from '../runtime.ts';
import { resolveInput } from '../../shared/search.ts';

/** The card's open and close: about 150 ms (Tirth, 2026-11-21), transform and opacity only. */
export const CARD_MOTION_MS = 150;

export function installCard(rt: Rt) {
  const { view, container } = rt;
  let closing: ReturnType<typeof setTimeout> | null = null;
  let focusField = false;
  const isField = (el: EventTarget | null) => !!el && view.inputs.get(el as Element) === 'peek';
  const spaceNow = () => rt.vm?.space?.id ?? null;

  function stopClosing() { if (closing) { rt.cancel(closing); closing = null; } }

  /** The app's word on the card (its `peek` push): shown as it says; null: it's gone (animated out). */
  function show(next: any) {
    if (!next || typeof next !== 'object') return close({ tell: false });
    stopClosing();
    const cur = rt.ui.peek;
    const url = typeof next.url === 'string' ? next.url : '';
    const littleArc = next.littleArc === true;
    if (!url && !littleArc && next.loading === false) return close({ tell: false });
    // (Little Arc's field keeps what's typed while the app's word comes.)
    const query = littleArc && cur?.littleArc ? cur.query ?? '' : '';
    if (littleArc && !cur?.littleArc) focusField = true;
    rt.setUi({
      peek: {
        url, title: typeof next.title === 'string' ? next.title : '', spaceId: typeof next.spaceId === 'string' ? next.spaceId : cur?.spaceId ?? spaceNow(),
        littleArc, loading: next.loading !== false, closing: false, query,
        canGoBack: typeof next.canGoBack === 'boolean' ? next.canGoBack : null, canGoForward: typeof next.canGoForward === 'boolean' ? next.canGoForward : null,
      },
    });
    return true;
  }

  /** The card closed: animated out, then gone; `tell`: the app told (a press here), not when it said so itself. */
  function close({ tell = true }: { tell?: boolean } = {}) {
    const cur = rt.ui.peek;
    if (!cur) return false;
    if (tell) rt.host.perform?.('peek.close', {});
    if (cur.closing) return true;
    rt.setUi({ peek: { ...cur, closing: true } });
    stopClosing();
    closing = rt.later(() => { closing = null; if (rt.ui.peek?.closing) rt.setUi({ peek: null }); }, CARD_MOTION_MS);
    return true;
  }

  function expand() {
    const cur = rt.ui.peek;
    if (!cur || cur.littleArc || !cur.url) return false;
    const spaceId = cur.spaceId ?? spaceNow();
    if (rt.host.perform?.('peek.expand', { url: cur.url, spaceId })) { close({ tell: false }); return true; }
    // (No card host: the page in a new tab of the space, as before.)
    void rt.send('newTab', { windowId: rt.windowId() ?? undefined, url: cur.url, spaceId: spaceId ?? undefined });
    close({ tell: false });
    return true;
  }

  function openLittleArc() {
    rt.behaviors.menus?.close?.();
    if (rt.ui.palette?.open) rt.dispatch('palette.close', undefined, 'behavior');
    stopClosing();
    focusField = true;
    const spaceId = spaceNow();
    rt.setUi({ peek: { url: '', title: '', spaceId, littleArc: true, loading: false, closing: false, query: '' } });
    rt.host.perform?.('peek.littleArc', { spaceId });
    return true;
  }

  /** Little Arc's field taken (Return): the card at that address or search. */
  function go(text: string) {
    const cur = rt.ui.peek;
    const target = resolveInput(text);
    if (!cur?.littleArc || !target) return false;
    const spaceId = cur.spaceId ?? spaceNow();
    const payload = target.kind === 'url' ? { url: target.url, spaceId } : { query: target.query, spaceId };
    if (rt.host.perform?.('peek.go', payload)) {
      // (A search's address is the app's to make, from the engine Safari searches with: shown as its word comes.)
      rt.setUi({ peek: { ...cur, littleArc: false, loading: true, url: target.kind === 'url' ? target.url : '', title: target.kind === 'url' ? '' : target.query } });
      return true;
    }
    rt.setUi({ peek: null });
    if (target.kind === 'url') void rt.send('newTab', { windowId: rt.windowId() ?? undefined, url: target.url, spaceId: spaceId ?? undefined });
    else void rt.send('search', { windowId: rt.windowId() ?? undefined, query: target.query });
    return true;
  }

  rt.listen(container, 'keydown', (e: KeyboardEvent) => {
    const cur = rt.ui.peek;
    if (!cur || e.isComposing || e.defaultPrevented) return;
    if (isField(e.target)) {
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); go((e.target as HTMLInputElement).value); return; }
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      return;
    }
    // (Another of Margin's things open over it has its own Escape: a menu, the palette, a field being edited.)
    if (rt.ui.menu || rt.ui.palette?.open || rt.ui.editor || rt.ui.editing) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) { e.preventDefault(); expand(); }
  });

  // ---- the page area, for the theme's CSS (and Margin's default card) ----
  // While a card is up, the page's place (`<m-page>`'s content box, as the view measures it) is on the theme's root as
  // `--m-page-left`, `--m-page-top`, `--m-page-right`, `--m-page-bottom` (px from the window's edges) and
  // `--m-page-radius`: a theme's `<m-peek>` lays its dim over the page area alone with them.
  let placedKey = '';
  function placePage() {
    const root = view.rootElement() as HTMLElement | null;
    if (!root?.style) return;
    const g = rt.ui.peek ? view.measure() : null;
    const key = g ? JSON.stringify([g.insets, g.radius]) : '';
    if (key === placedKey) return;
    placedKey = key;
    const names = ['left', 'top', 'right', 'bottom'] as const;
    for (const n of names) {
      if (g) root.style.setProperty(`--m-page-${n}`, `${g.insets[n]}px`); else root.style.removeProperty(`--m-page-${n}`);
    }
    if (g) root.style.setProperty('--m-page-radius', `${g.radius}px`); else root.style.removeProperty('--m-page-radius');
  }

  // ---- Margin's default card (a theme with no `peek` part of its own) ----
  // Centred in the page area, 8% of it each side and 7% above and below (at least 420×320), a 52 pt bar over its page
  // (back, forward, the address, Copy URL, Open in Space, Close; Little Arc: the field), the page area around it dimmed
  // (ui/render.ts BASE_CSS `m-peek[m-default]`, which a theme's CSS can restyle). Margin's own elements, its own words.
  let dflt: { el: HTMLElement, host: HTMLElement, field: HTMLInputElement } | null = null;
  function ownPeek(root: Element) {
    const slot = root.querySelector('m-peek:not([m-default])');
    return !!slot && slot.childElementCount > 0;
  }
  function makeDefault() {
    const doc = rt.doc;
    const el = doc.createElement('m-peek');
    el.setAttribute('m-default', '');
    const card = doc.createElement('div');
    card.setAttribute('m-peek-card', '');
    card.setAttribute('role', 'dialog');
    const bar = doc.createElement('div');
    bar.setAttribute('m-peek-bar', '');
    const button = (action: string, label: string, text: string) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.setAttribute('m-peek-button', action);
      b.setAttribute('aria-label', label);
      b.textContent = text;
      b.addEventListener('click', (e) => { e.preventDefault(); if (e.isTrusted) rt.dispatch(action, undefined, 'behavior'); });
      return b;
    };
    const host = doc.createElement('span');
    host.setAttribute('m-peek-host', '');
    const field = doc.createElement('input');
    field.setAttribute('m-peek-field', '');
    field.type = 'text';
    field.spellcheck = false;
    field.autocomplete = 'off';
    field.placeholder = 'Search or enter address';
    field.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); go(field.value); } else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    bar.append(button('peek.back', 'Back', '\u2039'), button('peek.forward', 'Forward', '\u203a'), host, field,
      button('peek.copyUrl', 'Copy URL', 'Copy URL'), button('peek.expand', 'Open in Space', 'Open in Space'), button('peek.close', 'Close', '\u2715'));
    const page = doc.createElement('m-peek-page');
    card.append(bar, page);
    el.append(card);
    // (A press on the dimmed page around it while it takes the pointer, Little Arc's or one loading: closed. Once its
    // window is in place, Margin.app catches that press itself: docs/PEEK-SPLIT.md §2.)
    el.addEventListener('click', (e) => { if (e.isTrusted && e.target === el) close(); });
    return { el, host, field };
  }
  function followDefault() {
    const root = view.rootElement() as HTMLElement | null;
    const cur = rt.vm?.peek ?? null;
    if (!root || !cur || ownPeek(root)) { dflt?.el.remove(); if (!cur) dflt = null; return; }
    dflt ??= makeDefault();
    const { el, host, field } = dflt;
    el.toggleAttribute('m-loading', cur.loading);
    el.toggleAttribute('m-closing', cur.closing);
    el.toggleAttribute('m-little-arc', cur.littleArc);
    if (host.textContent !== cur.host) host.textContent = cur.host;
    el.querySelector('[m-peek-card]')?.setAttribute('aria-label', cur.title);
    if (el.parentNode !== root) root.appendChild(el);
    if (cur.littleArc && focusField) { focusField = false; field.value = cur.query; field.focus(); }
  }

  return {
    show, close, expand, openLittleArc, go,
    onInput(name: string, value: string) {
      if (name !== 'peek' || !rt.ui.peek?.littleArc) return;
      // (Kept without drawing again: the field shows it already.)
      (rt.ui.peek as any).query = String(value).slice(0, 2048);
    },
    afterRender() {
      placePage();
      followDefault();
      if (!focusField || !rt.ui.peek?.littleArc) return;
      const field = view.input('peek');
      if (!field) return;
      focusField = false;
      field.focus();
      field.select?.();
    },
    /** The page's place changed (a resize, the sidebar): the page area's variables follow. */
    layout() { placePage(); },
    destroy() { stopClosing(); dflt?.el.remove(); dflt = null; },
  };
}
