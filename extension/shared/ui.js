// Sidebar renderer shared by the injected overlay and the new-tab page.
// Classic script: attaches to globalThis.Margin. Requires shared/view.js.
(() => {
  const Margin = (globalThis.Margin ??= {});

  function el(doc, tag, attrs = {}, ...children) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style') node.style.cssText = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child) node.append(child);
    return node;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function hue(text) {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }

  // Favicon if the browser gave us one, else a colored letter. Never asks a
  // third-party service for icons.
  function avatar(doc, { title, url, favIconUrl }) {
    const label = hostOf(url) || title || '?';
    const letter = el(doc, 'span', {
      class: 'avatar letter',
      text: label.charAt(0).toUpperCase(),
      style: `background: hsl(${hue(label)} 55% 48%)`,
      'aria-hidden': 'true',
    });
    if (!favIconUrl || !/^(https?|data):/.test(favIconUrl)) return letter;
    const img = el(doc, 'img', { class: 'avatar', src: favIconUrl, alt: '', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(letter), { once: true });
    return img;
  }

  // Apply CSS text inside a shadow root, synchronously. Constructable
  // stylesheets aren't subject to the page's CSP; fall back to <style>.
  function adoptStyles(shadow, css) {
    if ('adoptedStyleSheets' in shadow && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
    } else {
      const style = shadow.ownerDocument.createElement('style');
      style.textContent = css;
      shadow.prepend(style);
    }
  }

  // Zero-size, top-most host for a closed shadow root that site CSS can't touch.
  function createHost(doc, tag) {
    const host = doc.createElement(tag);
    for (const [prop, value] of Object.entries({
      all: 'initial',
      position: 'fixed',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      'z-index': '2147483647',
    })) host.style.setProperty(prop, value, 'important');
    return host;
  }

  const SPACE_COLORS = ['#6c5ce7', '#0984e3', '#00b894', '#fdcb6e', '#e17055', '#d63031', '#e84393', '#636e72'];
  const TAB_MIME = 'application/x-margin-tab';

  function createSidebar({ document: doc, send, mode }) {
    const chips = el(doc, 'nav', { class: 'spaces', 'aria-label': 'Spaces' });
    const nameInput = el(doc, 'input', { class: 'name', type: 'text', placeholder: 'Space name', 'aria-label': 'Space name', maxlength: '40' });
    const emojiInput = el(doc, 'input', { class: 'emoji', type: 'text', 'aria-label': 'Space emoji', maxlength: '8' });
    const swatches = el(doc, 'div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Space color' },
      SPACE_COLORS.map((c) => el(doc, 'button', { type: 'button', class: 'swatch', 'data-color': c, title: c, style: `--chip-color: ${c}`, role: 'radio' })));
    const deleteButton = el(doc, 'button', { type: 'button', class: 'delete', 'data-editor': 'delete', text: 'Delete' });
    const editor = el(doc, 'form', { class: 'editor', hidden: true, 'aria-label': 'Edit space' },
      el(doc, 'div', { class: 'row' }, emojiInput, nameInput),
      swatches,
      el(doc, 'div', { class: 'row actions' },
        deleteButton,
        el(doc, 'span', { class: 'spacer' }),
        el(doc, 'button', { type: 'button', 'data-editor': 'cancel', text: 'Cancel' }),
        el(doc, 'button', { type: 'submit', class: 'primary', text: 'Save' })));
    const pins = el(doc, 'ul', { class: 'pins', 'aria-label': 'Pinned' });
    const tabs = el(doc, 'ul', { class: 'tabs', 'aria-label': 'Tabs' });
    const keepOpen = el(doc, 'button', { class: 'keep-open', 'data-action': 'keep-open', title: 'Keep the sidebar open' });
    const footer = el(doc, 'footer', {},
      el(doc, 'button', { class: 'new-tab', 'data-action': 'new-tab', text: '+ New tab' }),
      mode === 'overlay' ? keepOpen : null,
    );
    const root = el(doc, 'aside', { class: `margin-sidebar ${mode}`, 'aria-label': 'Margin' },
      chips,
      editor,
      el(doc, 'section', { class: 'pins-section' }, pins),
      el(doc, 'div', { class: 'divider' }),
      el(doc, 'section', { class: 'tabs-section' }, tabs),
      footer,
    );

    let state = null;
    let windowId = null;
    let currentTabId = null;
    let pendingEdit = null; // a just-created space opens in the editor once it arrives

    function render() {
      if (!state || windowId == null) return;
      const view = Margin.view.sidebar(state, windowId, currentTabId);
      root.style.setProperty('--space-color', view.spaces.find((s) => s.id === view.spaceId)?.color ?? '');

      chips.replaceChildren(
        ...view.spaces.map((s) =>
          el(doc, 'button', {
            class: `chip${s.id === view.spaceId ? ' active' : ''}`,
            'data-action': 'set-space',
            'data-space-id': s.id,
            title: s.name,
            'aria-pressed': String(s.id === view.spaceId),
            style: `--chip-color: ${s.color}`,
            text: s.emoji,
          }),
        ),
        el(doc, 'button', { class: 'chip add', 'data-action': 'add-space', title: 'New space', text: '+' }),
      );

      pins.replaceChildren(
        ...view.pins.map((p) =>
          el(doc, 'li', {
            class: `pin${p.active ? ' active' : ''}${p.tabId ? ' open' : ''}`,
            'data-action': 'open-pin',
            'data-pin-id': p.id,
            title: p.title,
          },
          avatar(doc, { ...p, favIconUrl: Margin.view.iconFor(state, p) }),
          el(doc, 'span', { class: 'title', text: p.title }),
          el(doc, 'button', { class: 'icon unpin', 'data-action': 'unpin', 'data-pin-id': p.id, title: 'Unpin', text: '×' })),
        ),
      );

      tabs.replaceChildren(
        ...view.tabs.map((t) =>
          el(doc, 'li', {
            class: `tab${t.active ? ' active' : ''}`,
            'data-action': 'activate',
            'data-tab-id': String(t.id),
            title: t.title || t.url,
            draggable: 'true',
          },
          avatar(doc, { ...t, favIconUrl: Margin.view.iconFor(state, t) }),
          el(doc, 'span', { class: 'title', text: t.title || t.url || 'New Tab' }),
          el(doc, 'button', { class: 'icon pin-tab', 'data-action': 'pin-tab', 'data-tab-id': String(t.id), title: 'Pin', text: '📌' }),
          el(doc, 'button', { class: 'icon close', 'data-action': 'close', 'data-tab-id': String(t.id), title: 'Close tab', text: '×' })),
        ),
      );

      const pinned = !!state.settings?.sidebarPinnedOpen;
      keepOpen.textContent = pinned ? '⇤ Auto-hide' : '⇥ Keep open';
      keepOpen.setAttribute('aria-pressed', String(pinned));
    }

    root.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target || !root.contains(target)) return;
      event.stopPropagation();
      const tabId = Number(target.dataset.tabId);
      const { pinId, spaceId } = target.dataset;
      switch (target.dataset.action) {
        case 'activate': return send('activateTab', { tabId });
        case 'close': return send('closeTab', { tabId });
        case 'pin-tab': return send('pinTab', { tabId });
        case 'open-pin': return send('openPin', { pinId, windowId });
        case 'unpin': return send('unpin', { pinId });
        case 'set-space': return send('setSpace', { windowId, spaceId });
        case 'new-tab': return send('newTab', { windowId });
        case 'add-space':
          // The new space can reach us (via storage) before the reply does,
          // so open it now if it's already here, else when it arrives.
          return send('createSpace', { windowId }).then((res) => {
            if (!res?.spaceId) return;
            if (state?.spaces.some((s) => s.id === res.spaceId)) openEditor(res.spaceId);
            else pendingEdit = res.spaceId;
          });
        case 'keep-open':
          return send('updateSettings', { patch: { sidebarPinnedOpen: !state?.settings?.sidebarPinnedOpen } });
      }
    });

    // ---- space editor ------------------------------------------------------

    let editing = null; // { spaceId, color, confirmDelete }
    function openEditor(spaceId) {
      const space = state?.spaces.find((s) => s.id === spaceId);
      if (!space) return;
      editing = { spaceId, color: space.color, confirmDelete: false };
      nameInput.value = space.name;
      emojiInput.value = space.emoji;
      editor.hidden = false;
      renderEditor();
      nameInput.focus();
      nameInput.select();
    }
    function closeEditor() {
      editing = null;
      editor.hidden = true;
    }
    function renderEditor() {
      if (!editing) return;
      for (const sw of swatches.children) sw.setAttribute('aria-checked', String(sw.dataset.color === editing.color));
      const only = (state?.spaces.length ?? 0) < 2;
      deleteButton.disabled = only;
      deleteButton.title = only ? 'The last space can’t be deleted' : 'Tabs and pins move to the first space';
      deleteButton.textContent = editing.confirmDelete ? 'Really delete?' : 'Delete';
    }
    editor.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!editing) return;
      send('renameSpace', { spaceId: editing.spaceId, name: nameInput.value, emoji: emojiInput.value, color: editing.color });
      closeEditor();
    });
    editor.addEventListener('click', (event) => {
      event.stopPropagation();
      const swatch = event.target.closest('.swatch');
      if (swatch && editing) {
        editing.color = swatch.dataset.color;
        return renderEditor();
      }
      const action = event.target.closest('[data-editor]')?.dataset.editor;
      if (action === 'cancel') closeEditor();
      if (action === 'delete' && editing) {
        if (!editing.confirmDelete) {
          editing.confirmDelete = true;
          return renderEditor();
        }
        send('deleteSpace', { spaceId: editing.spaceId });
        closeEditor();
      }
    });
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeEditor();
    });
    chips.addEventListener('contextmenu', (event) => {
      const chip = event.target.closest('.chip[data-space-id]');
      if (!chip) return;
      event.preventDefault();
      openEditor(chip.dataset.spaceId);
    });
    chips.addEventListener('dblclick', (event) => {
      const chip = event.target.closest('.chip[data-space-id]');
      if (chip) openEditor(chip.dataset.spaceId);
    });

    // Keep our keystrokes away from the page's own shortcuts.
    for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, (e) => e.stopPropagation());

    // ---- drag a tab onto a space chip ---------------------------------------

    let draggingTabId = null;
    tabs.addEventListener('dragstart', (event) => {
      const row = event.target.closest('.tab');
      if (!row) return;
      draggingTabId = Number(row.dataset.tabId);
      event.dataTransfer.setData(TAB_MIME, row.dataset.tabId);
      event.dataTransfer.effectAllowed = 'move';
    });
    tabs.addEventListener('dragend', () => {
      draggingTabId = null;
      for (const c of chips.querySelectorAll('.drop-target')) c.classList.remove('drop-target');
    });
    const chipFor = (event) => (draggingTabId == null ? null : event.target.closest?.('.chip[data-space-id]'));
    chips.addEventListener('dragover', (event) => {
      const chip = chipFor(event);
      if (!chip) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      chip.classList.add('drop-target');
    });
    chips.addEventListener('dragleave', (event) => chipFor(event)?.classList.remove('drop-target'));
    chips.addEventListener('drop', (event) => {
      const chip = chipFor(event);
      if (!chip) return;
      event.preventDefault();
      chip.classList.remove('drop-target');
      send('moveTabToSpace', { tabId: draggingTabId, spaceId: chip.dataset.spaceId });
      draggingTabId = null;
    });

    return {
      el: root,
      // While editing or dragging, the overlay shouldn't auto-hide.
      isBusy: () => editing != null || draggingTabId != null,
      update(nextState, context) {
        state = nextState;
        if (context?.windowId != null) windowId = context.windowId;
        if (context?.tabId != null) currentTabId = context.tabId;
        render();
        if (pendingEdit && state.spaces.some((s) => s.id === pendingEdit)) {
          openEditor(pendingEdit);
          pendingEdit = null;
        }
        if (editing && !state.spaces.some((s) => s.id === editing.spaceId)) closeEditor();
        renderEditor();
      },
      setTheme(theme) {
        root.dataset.theme = theme;
      },
    };
  }

  Margin.ui = { el, avatar, adoptStyles, createHost, createSidebar };
})();
