// Arcadium's command palette: Arc's dark command bar in its own closed
// shadow root. Used on web pages (content.js; content/palette.js wires it to
// the page) and on the new-tab page (newtab.js).
import { el, createHost, adoptStyles, siteModalOpen } from '../../shared/dom.js';
import { containScroll } from '../../shared/gestures.js';
import { rankPalette } from '../../shared/search.js';
import * as V from '../../shared/view.js';
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
const searchIcon = () => icon(['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z', 'M15.5 15.5 20 20'], 'search-icon');
const arrowIcon = () => icon(['M5 12h13', 'M13 6l6 6-6 6'], 'arrow-icon');
// Rows that go somewhere get Arc's arrow button; plain actions don't.
const GOES = new Set(['tab', 'pin', 'archive', 'go']);

function createPalette({ send, getState, getContext, onLocal, colorScheme }) {
  let host = null;
  let panel, input, list;
  let items = [];
  let selected = 0;
  let open = false;
  let restoreFocus = null;

  function build() {
    host = createHost(document, 'margin-palette-host');
    const shadow = host.attachShadow({ mode: 'closed' });
    adoptStyles(shadow, paletteCss);
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
    const backdrop = el(document, 'div', { class: 'backdrop' });
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
      else if (e.key === 'Escape') close();
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
    close();
    if (item.action.local) return onLocal?.(item.action);
    const { type, ...payload } = item.action;
    send(type, payload);
  }

  function show() {
    if (!host) build();
    if (!host.isConnected) document.documentElement.appendChild(host);
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
    host.dataset.open = 'true';
    open = true;
    input.value = '';
    selected = 0;
    refresh();
    input.focus();
  }

  function close() {
    if (!open) return;
    open = false;
    host.dataset.open = 'false';
    try {
      if (host.matches?.(':popover-open')) host.hidePopover();
    } catch {}
    input.blur();
    // Back to the page; in the fitted layout that's the card, not the shell.
    const shell = globalThis.Margin?.shell;
    if (shell?.card && (!restoreFocus?.isConnected || restoreFocus === document.body)) shell.focusCard();
    else if (restoreFocus?.isConnected) restoreFocus.focus?.({ preventScroll: true });
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
