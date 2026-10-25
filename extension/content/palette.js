// Command palette overlay in its own closed shadow root. Used by the content
// script and by the new-tab page (which wires it up itself).
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const Margin = globalThis.Margin;
  const { el, avatar } = Margin.ui;

  // `getState()` → storage state; `getContext()` → { windowId, tabId, inNewTab,
  // canToggleSidebar }; `onLocal(action)` handles actions that aren't messages.
  function createPalette({ send, getState, getContext, onLocal, theme }) {
    let host = null;
    let panel, input, list;
    let items = [];
    let selected = 0;
    let open = false;
    let restoreFocus = null;

    function build() {
      host = Margin.ui.createHost(document, 'margin-palette-host');
      const shadow = host.attachShadow({ mode: 'closed' });
      Margin.ui.adoptStyles(shadow, Margin.styles.palette);
      input = el(document, 'input', {
        type: 'text',
        class: 'query',
        placeholder: 'Search tabs, pins, archive, or enter a URL…',
        'aria-label': 'Command palette',
        spellcheck: 'false',
        autocomplete: 'off',
        role: 'combobox',
        'aria-expanded': 'true',
        'aria-controls': 'margin-results',
      });
      list = el(document, 'ul', { class: 'results', id: 'margin-results', role: 'listbox' });
      panel = el(document, 'div', { class: 'palette', role: 'dialog', 'aria-label': 'Margin command palette' }, input, list);
      const backdrop = el(document, 'div', { class: 'backdrop' });
      shadow.append(backdrop, panel);

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
      items = Margin.search.rankPalette(state, input.value, getContext());
      selected = Math.min(selected, Math.max(items.length - 1, 0));
      list.replaceChildren(
        ...items.map((item, index) =>
          el(document, 'li', { role: 'option', 'data-index': String(index), 'data-id': item.id, class: item.kind },
            item.emoji ? el(document, 'span', { class: 'avatar emoji', text: item.emoji }) : avatar(document, item),
            el(document, 'span', { class: 'text' },
              el(document, 'span', { class: 'title', text: item.title }),
              item.subtitle ? el(document, 'span', { class: 'subtitle', text: item.subtitle }) : null),
            item.badge ? el(document, 'span', { class: 'badge', text: item.badge }) : null),
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
      restoreFocus = document.activeElement;
      panel.dataset.theme = theme?.() ?? 'light';
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
      input.blur();
      if (restoreFocus?.isConnected) restoreFocus.focus?.({ preventScroll: true });
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

  // Capture-phase listener so the page can't swallow the shortcut first.
  function installShortcut(palette, getShortcut) {
    addEventListener('keydown', (e) => {
      if (!Margin.shortcuts.matches(e, getShortcut())) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      palette.toggle();
    }, true);
  }

  Margin.createPalette = createPalette;
  Margin.installPaletteShortcut = installShortcut;

  // ---- content-script wiring ----------------------------------------------

  const c = Margin.content;
  if (!c) return; // new-tab page wires its own
  const palette = createPalette({
    send: c.send,
    getState: () => c.getState().state,
    getContext: () => ({ ...c.getState(), canToggleSidebar: true }),
    onLocal: (action) => action.local === 'toggleSidebar' && c.sidebar.toggle(),
    theme: c.theme,
  });
  installShortcut(palette, () => c.getState().state?.settings?.paletteShortcut ?? 'Alt+KeyK');
  c.onCommand = (command) => command === 'open-palette' && palette.toggle();
  const prev = c.onState;
  c.onState = (...args) => {
    prev?.(...args);
    palette.refresh();
  };
})();
