// Arcadia's command palette: Arc's dark command bar in its own closed
// shadow root. Used on web pages (content.js; content/palette.js wires it to
// the page) and on the new-tab page (newtab.js).
import { el, createHost, mountHost, mark, adoptStyles, asBrowserUi, unzoom, siteModalOpen } from '../../shared/dom.js';
import { containScroll } from '../../shared/gestures.js';
import { rankPalette } from '../../shared/search.js';
import * as V from '../../shared/view.js';
import { opensNewTab } from '../../shared/switching.js';
import { avatar } from './sidebar.js';
import { paletteCss } from './assets.js';

// `getState()` → storage state; `getContext()` → { windowId, tabId, inNewTab,
// canToggleSidebar }; `onLocal(action)` handles actions that aren't messages.
// Small inline SVG icons (no network, no fonts).
const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(paths, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
const searchIcon = () => icon(['M10.5 3.3a7.2 7.2 0 1 0 0 14.4 7.2 7.2 0 0 0 0-14.4Z', 'M15.6 15.6 19.5 19.5'], 'search-icon');
const arrowIcon = () => icon(['M4.5 12h14.5', 'M12 4.5l7.5 7.5-7.5 7.5'], 'arrow-icon');
const PREWAKE_DWELL_MS = 120;
// Rows that go somewhere get Arc's arrow button; plain actions don't.
const GOES = new Set(['tab', 'pin', 'archive', 'go']);

// `onClose(reason, action)`: after it closes ('escape': Escape pressed;
// 'run': an item was chosen, `action` its action; undefined otherwise).
function createPalette({ send, getState, getContext, onLocal, colorScheme, onClose = undefined }) {
  let host = null;
  let panel, input, list;
  let items = [];
  let selected = 0;
  let open = false;
  let restoreFocus = null;

  let backdrop = null;
  const setShown = (on) => {
    backdrop.classList.toggle('shown', on);
    panel.classList.toggle('shown', on);
    mark(host, 'open', String(on));
  };
  function build() {
    const made = createHost(document, 'margin-palette-host');
    host = made.host;
    const { shadow } = made;
    adoptStyles(shadow, paletteCss);
    asBrowserUi(shadow); // no page context menu or selection (but the field)
    input = el(document, 'input', {
      type: 'text',
      class: 'query',
      placeholder: 'Search or Enter URL…',
      'aria-label': 'Command palette',
      spellcheck: 'false',
      autocomplete: 'off',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': 'margin-results',
    });
    list = el(document, 'ul', { class: 'results', id: 'margin-results', role: 'listbox' });
    panel = el(document, 'div', { class: 'palette', role: 'dialog', 'aria-label': 'Margin command palette' },
      el(document, 'div', { class: 'search' }, searchIcon(), input),
      list);
    backdrop = el(document, 'div', { class: 'backdrop' });
    shadow.append(backdrop, panel);
    // While it's open, scrolling moves only its results, never the page.
    for (const node of [backdrop, panel]) containScroll(node);

    backdrop.addEventListener('mousedown', (e) => {
      e.preventDefault();
      close();
    });
    input.addEventListener('input', () => {
      selected = 0;
      refresh();
    });
    // Keep every keystroke away from the page's own shortcuts.
    for (const type of ['keydown', 'keyup', 'keypress']) panel.addEventListener(type, (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) move(1);
      else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) move(-1);
      else if (e.key === 'Enter') run(items[selected]);
      else if (e.key === 'Escape') close('escape');
      else return;
      e.preventDefault();
    });
    list.addEventListener('mousemove', (e) => {
      const row = e.target.closest('[data-index]');
      if (row && Number(row.dataset.index) !== selected) {
        selected = Number(row.dataset.index);
        paintSelection();
      }
    });
    list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
    list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-index]');
      if (row) run(items[Number(row.dataset.index)]);
    });
  }

  function move(delta) {
    if (!items.length) return;
    selected = (selected + delta + items.length) % items.length;
    paintSelection();
  }

  function paintSelection() {
    for (const row of list.children) {
      const on = Number(row.dataset.index) === selected;
      row.setAttribute('aria-selected', String(on));
      if (on) row.scrollIntoView({ block: 'nearest' });
    }
    prewakeSelected();
  }

  // The selection resting on a tab or a pin: its process starts waking
  // (background/tabs.js wakeTab), so choosing it doesn't wait. Not while the
  // selection is still moving (a held arrow key, the pointer passing over).
  let prewakeTimer = null;
  let prewoken = null; // what was woken since it opened (refreshes repaint the same selection)
  function prewakeSelected() {
    clearTimeout(prewakeTimer);
    const action = items[selected]?.action;
    if (!open || (action?.type !== 'activateTab' && action?.type !== 'openPin')) return;
    prewakeTimer = setTimeout(() => {
      if (!open || items[selected]?.action !== action) return;
      const key = action.type === 'openPin' ? `pin:${action.pinId}` : `tab:${action.tabId}`;
      if (key === prewoken) return;
      prewoken = key;
      if (action.type === 'openPin') send('prewake', { pinId: action.pinId, windowId: action.windowId });
      else if (action.tabId !== getContext().tabId) send('prewake', { tabId: action.tabId });
    }, PREWAKE_DWELL_MS);
  }

  function refresh() {
    const state = getState();
    if (!state) return;
    items = rankPalette(state, input.value, getContext());
    selected = Math.min(selected, Math.max(items.length - 1, 0));
    list.replaceChildren(
      ...items.map((item, index) =>
        el(document, 'li', { role: 'option', 'data-index': String(index), 'data-id': item.id, class: item.kind, title: item.subtitle || item.title },
          item.emoji ? el(document, 'span', { class: 'avatar emoji', text: item.emoji }) : avatar(document, item),
          el(document, 'span', { class: 'title', text: item.title }),
          item.badge ? el(document, 'span', { class: 'badge', text: item.badge }) : null,
          GOES.has(item.kind) ? el(document, 'span', { class: 'go-button' }, arrowIcon()) : null),
      ),
    );
    if (!items.length) list.append(el(document, 'li', { class: 'empty', text: 'No matches' }));
    paintSelection();
  }

  function run(item) {
    if (!item) return;
    close('run', item.action);
    if (item.action.local) return onLocal?.(item.action);
    const { type, ...payload } = item.action;
    send(type, payload);
  }

  function fitWindow() {
    const zoom = /** @type {any} */ (globalThis).marginPageZoom ?? 1;
    unzoom(host, zoom);
    const tall = innerHeight * zoom;
    panel.dataset.short = tall <= 357 ? '3' : tall <= 418 ? '2' : tall <= 507 ? '1' : '';
  }
  // The window resized while it's open (as the media queries this replaces did).
  addEventListener('resize', () => { if (open && host) fitWindow(); });
  function show() {
    if (!host) build();
    // The page's zoom now (it may have changed while the palette was away),
    // and how tall the window is in Margin's px, which its short-window
    // layouts use (a media query would see the page's zoomed px).
    fitWindow();
    if (!host.isConnected) mountHost(host);
    // In the top layer (popover) where supported, so a site's own popovers
    // or full-screen elements can't cover it; otherwise the max z-index, as
    // before. Not while the site has a modal dialog open: everything outside
    // it is inert then, so the palette would show but take no typing.
    if (typeof host.showPopover === 'function' && !siteModalOpen(document)) {
      if (!host.hasAttribute('popover')) host.setAttribute('popover', 'manual');
      try {
        if (!host.matches(':popover-open')) host.showPopover();
      } catch {} // e.g. removed meanwhile: the z-index still applies
    }
    restoreFocus = document.activeElement;
    // Always Arc's dark command bar; the selected row takes the current
    // space's color.
    void colorScheme;
    const state = getState();
    const ctx = getContext();
    const spaceId = state ? V.activeSpaceId(state, ctx.windowId) : null;
    const color = state?.spaces?.find((s) => s.id === spaceId)?.color;
    if (color) panel.style.setProperty('--space-color', color);
    setShown(true);
    open = true;
    prewoken = null;
    input.value = '';
    selected = 0;
    refresh();
    input.focus();
  }

  function close(reason = undefined, action = undefined) {
    if (!open) return;
    open = false;
    clearTimeout(prewakeTimer);
    setShown(false);
    try {
      if (host.matches?.(':popover-open')) host.hidePopover();
    } catch {}
    input.blur();
    // Back to the page. Not for a new tab loading behind the page (background/tabs.js
    // openBehind): what's typed meanwhile would go into the page left.
    if (reason === 'run' && action && opensNewTab(action.type, action)) restoreFocus = null;
    else if (restoreFocus?.isConnected) restoreFocus.focus?.({ preventScroll: true });
    onClose?.(reason, action);
  }

  // The content keydown listener and the `commands` fallback can both fire
  // for one key press; collapse them.
  let lastToggle = 0;
  function toggle() {
    const now = Date.now();
    if (now - lastToggle < 200) return;
    lastToggle = now;
    open ? close() : show();
  }

  return { open: show, close, toggle, isOpen: () => open, refresh: () => open && refresh() };
}

export { createPalette };
