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

  function createSidebar({ document: doc, send, mode }) {
    const chips = el(doc, 'nav', { class: 'spaces', 'aria-label': 'Spaces' });
    const pins = el(doc, 'ul', { class: 'pins', 'aria-label': 'Pinned' });
    const tabs = el(doc, 'ul', { class: 'tabs', 'aria-label': 'Tabs' });
    const keepOpen = el(doc, 'button', { class: 'keep-open', 'data-action': 'keep-open', title: 'Keep the sidebar open' });
    const footer = el(doc, 'footer', {},
      el(doc, 'button', { class: 'new-tab', 'data-action': 'new-tab', text: '+ New tab' }),
      mode === 'overlay' ? keepOpen : null,
    );
    const root = el(doc, 'aside', { class: `margin-sidebar ${mode}`, 'aria-label': 'Margin' },
      chips,
      el(doc, 'section', { class: 'pins-section' }, pins),
      el(doc, 'div', { class: 'divider' }),
      el(doc, 'section', { class: 'tabs-section' }, tabs),
      footer,
    );

    let state = null;
    let windowId = null;

    function render() {
      if (!state || windowId == null) return;
      const view = Margin.view.sidebar(state, windowId);
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
      );

      pins.replaceChildren(
        ...view.pins.map((p) =>
          el(doc, 'li', {
            class: `pin${p.active ? ' active' : ''}${p.tabId ? ' open' : ''}`,
            'data-action': 'open-pin',
            'data-pin-id': p.id,
            title: p.title,
          },
          avatar(doc, p),
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
          },
          avatar(doc, t),
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
        case 'keep-open':
          return send('updateSettings', { patch: { sidebarPinnedOpen: !state?.settings?.sidebarPinnedOpen } });
      }
    });

    return {
      el: root,
      update(nextState, context) {
        state = nextState;
        if (context?.windowId != null) windowId = context.windowId;
        render();
      },
      setTheme(theme) {
        root.dataset.theme = theme;
      },
    };
  }

  Margin.ui = { el, avatar, createSidebar };
})();
