// Arcadium's sidebar: space chips, pins, tabs, the space editor and the
// right-click menu. Used on web pages (content.js) and on the new-tab page
// (newtab.js).
import * as V from '../../shared/view.js';
import { containScroll } from '../../shared/gestures.js';
import { el, hostOf, siteModalOpen } from '../../shared/dom.js';
import { WIDTH, clampWidth, snapWidth, sidebarWidth } from './theme.js';

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

const SPACE_COLORS = ['#6c5ce7', '#0984e3', '#00b894', '#fdcb6e', '#e17055', '#d63031', '#e84393', '#636e72'];
const TAB_MIME = 'application/x-margin-tab';

// `onNewTab`: what "+ New tab" does (the command palette, Arc-style);
// without it, a new tab is opened.
// `onWidth(px, { done })`: called while the sidebar is resized (live) and
// once more with done: true when the drag ends.
// `onScroll(px)`: the tab list was scrolled by the user (every page's sidebar
// opens at the window's last position; update(…, { scroll }) applies it).
/**
 * @param {{ document: Document, send: import('../../../types/margin').Send, mode: 'overlay' | 'newtab', onNewTab?: () => void, onWidth?: (px: number, info: { done: boolean }) => void, onScroll?: (px: number) => void }} options
 */
function createSidebar({ document: doc, send, mode, onNewTab, onWidth, onScroll }) {
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
  const tabsSection = el(doc, 'section', { class: 'tabs-section' }, tabs);
  const keepOpen = el(doc, 'button', { class: 'keep-open', 'data-action': 'keep-open', title: 'Keep the sidebar open' });
  // With Keep open: this site fitted beside the sidebar, or shown normally
  // (the palette has the same switch). Only where it applies.
  const fitSite = el(doc, 'button', { class: 'fit-site', 'data-action': 'fit-site', hidden: true });
  // "+ New Tab" is the first row of the tab list (render).
  const footer = mode === 'overlay' ? el(doc, 'footer', {}, el(doc, 'span', { class: 'spacer' }), fitSite, keepOpen) : null;
  const root = el(doc, 'aside', { class: `margin-sidebar ${mode}`, 'aria-label': 'Margin' },
    chips,
    editor,
    el(doc, 'section', { class: 'pins-section' }, pins),
    el(doc, 'div', { class: 'divider' }),
    tabsSection,
    footer,
  );

  // Scrolling over the sidebar moves only its tab list (when it has more
  // than fits), never the page behind it.
  containScroll(root);
  // The window's shared position (not when Margin set it itself).
  let settingScroll = false;
  tabsSection.addEventListener('scroll', () => {
    if (settingScroll) settingScroll = false;
    else onScroll?.(tabsSection.scrollTop);
  }, { passive: true });

  // ---- resize: drag the right edge (160–500px), double-click to reset ----
  const resizer = el(doc, 'div', { class: 'resizer', title: 'Drag to resize · double-click to reset', 'aria-hidden': 'true' });
  root.append(resizer);
  let resizing = null; // { startX, startWidth, width }
  // The width is one of Arcadium's own settings.
  const saveWidth = (sidebarWidth) => send('updateThemeSettings', { themeId: 'arcadium', patch: { sidebarWidth } });
  const setWidth = (px) => root.style.setProperty('--width', `${px}px`);
  resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizer.setPointerCapture?.(event.pointerId);
    const startWidth = root.getBoundingClientRect().width;
    resizing = { startX: event.clientX, startWidth, width: startWidth };
    root.classList.add('resizing');
  });
  resizer.addEventListener('pointermove', (event) => {
    if (!resizing) return;
    resizing.width = clampWidth(resizing.startWidth + event.clientX - resizing.startX);
    setWidth(resizing.width);
    onWidth?.(resizing.width, { done: false });
  });
  const endResize = () => {
    if (!resizing) return;
    const width = snapWidth(resizing.width);
    resizing = null;
    root.classList.remove('resizing');
    setWidth(width);
    onWidth?.(width, { done: true });
    saveWidth(width);
  };
  resizer.addEventListener('pointerup', endResize);
  resizer.addEventListener('pointercancel', endResize);
  resizer.addEventListener('lostpointercapture', endResize);
  resizer.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    const width = WIDTH.default;
    setWidth(width);
    onWidth?.(width, { done: true });
    saveWidth(width);
  });

  /** @type {import('../../../types/margin').State | null} */
  let state = null;
  let windowId = null;
  let currentTabId = null;
  let pendingEdit = null; // a just-created space opens in the editor once it arrives
  let fit = null; // { origin, fitted, fittable }: the page's fitted layout (content/core.js)
  let newTabPending = false; // a new tab being chosen in the palette: "+ New Tab" highlighted

  function render() {
    if (!state || windowId == null) return;
    const view = V.sidebar(state, windowId, currentTabId, { newTabPending });
    root.style.setProperty('--space-color', view.spaces.find((s) => s.id === view.spaceId)?.color ?? '');
    if (!resizing) setWidth(sidebarWidth(state.settings));

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
          class: `pin${p.active ? ' active' : ''}${p.behind ? ' behind' : ''}${p.tabId ? ' open' : ''}`,
          'data-action': 'open-pin',
          'data-pin-id': p.id,
          title: p.title,
        },
        avatar(doc, { ...p, favIconUrl: V.iconFor(state, p) }),
        el(doc, 'span', { class: 'title', text: p.title }),
        el(doc, 'button', { class: 'icon unpin', 'data-action': 'unpin', 'data-pin-id': p.id, title: 'Unpin', text: '×' })),
      ),
    );

    // Arc: "+ New Tab" above the tabs, highlighted like a tab while the
    // new-tab page is shown (⌘T); it opens the palette.
    const newTabRow = el(doc, 'li', {
      class: `new-tab-row${view.newTab.active ? ' active' : ''}`,
      'data-action': 'new-tab',
      title: 'New Tab',
      role: 'button',
      'aria-label': 'New Tab',
      'aria-current': view.newTab.active ? 'page' : null,
    }, el(doc, 'span', { class: 'plus', 'aria-hidden': 'true', text: '+' }), el(doc, 'span', { class: 'title', text: 'New Tab' }));
    tabs.replaceChildren(
      newTabRow,
      ...view.tabs.map((t) =>
        el(doc, 'li', {
          class: `tab${t.active ? ' active' : ''}${t.behind ? ' behind' : ''}`,
          'data-action': 'activate',
          'data-tab-id': String(t.id),
          title: t.title || t.url,
          draggable: 'true',
        },
        avatar(doc, { ...t, favIconUrl: V.iconFor(state, t) }),
        el(doc, 'span', { class: 'title', text: t.title || t.url || 'New Tab' }),
        el(doc, 'button', { class: 'icon close', 'data-action': 'close', 'data-tab-id': String(t.id), title: 'Close tab', text: '×' })),
      ),
    );

    const pinned = !!state.settings?.sidebarPinnedOpen;
    // Icon + label; narrow sidebars show only the icon (see sidebar.css).
    keepOpen.replaceChildren(
      el(doc, 'span', { class: 'icon-only', text: pinned ? '⇤' : '⇥' }),
      el(doc, 'span', { class: 'label', text: pinned ? ' Auto-hide' : ' Keep open' }),
    );
    keepOpen.title = pinned ? 'Auto-hide the sidebar' : 'Keep the sidebar open';
    keepOpen.setAttribute('aria-label', keepOpen.title); // its label is hidden in the narrow rail
    keepOpen.setAttribute('aria-pressed', String(pinned));

    const excepted = !!fit?.origin && (state.settings?.fitPagesExcept ?? []).includes(fit.origin);
    fitSite.hidden = !(pinned && fit?.fittable && state.settings?.fitPages !== false && (fit.fitted || excepted));
    fitSite.textContent = fit?.fitted ? '▢' : '▣';
    fitSite.title = fit?.fitted ? 'Show this site normally (not fitted beside the sidebar)' : 'Fit this site beside the sidebar again';
    fitSite.setAttribute('aria-label', fitSite.title);
  }

  // Open over the page (hovered, toggled, or the rail expanded): a switch
  // made from it keeps it open on the next page (content/core.js fills in
  // how it was opened; background handlers.js carryOpen).
  const openOverPage = () => mode === 'overlay' && root.classList.contains('open') && (!root.classList.contains('docked') || root.classList.contains('rail-expanded'));

  root.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target || !root.contains(target)) return;
    event.stopPropagation();
    if (event.ctrlKey && target.closest('.tab, .pin')) return; // ⌃-click is the Mac's right-click: the menu
    const tabId = Number(target.dataset.tabId);
    const { pinId, spaceId } = target.dataset;
    const show = openOverPage();
    switch (target.dataset.action) {
      case 'activate': return send('activateTab', { tabId, ...(show ? { show } : {}) });
      case 'close': return send('closeTab', { tabId, ...(show ? { show } : {}) });
      case 'open-pin': return send('openPin', { pinId, windowId, ...(show ? { show } : {}) });
      case 'unpin': return send('unpin', { pinId });
      case 'set-space': return send('setSpace', { windowId, spaceId });
      case 'new-tab': return onNewTab ? onNewTab() : send('newTab', { windowId });
      case 'add-space':
        // The new space can reach us (via storage) before the reply does,
        // so open it now if it's already here, else when it arrives.
        return send('createSpace', { windowId }).then((res) => {
          if (!res?.spaceId) return;
          if (state?.spaces.some((s) => s.id === res.spaceId)) openEditor(res.spaceId);
          else pendingEdit = res.spaceId;
        });
      case 'fit-site':
        return fit?.origin && send('setFitSite', { origin: fit.origin, fit: !fit.fitted });
      case 'keep-open':
        return send('updateSettings', { patch: { sidebarPinnedOpen: !state?.settings?.sidebarPinnedOpen } });
    }
  });

  // A press on a tab or an open pin: its process starts waking now, before
  // the click lands (background/tabs.js wakeTab), so the switch doesn't wait.
  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.ctrlKey || event.target.closest('.icon')) return;
    const row = event.target.closest('.tab, .pin');
    if (!row || !root.contains(row) || row.classList.contains('active')) return;
    if (row.dataset.tabId) send('prewake', { tabId: Number(row.dataset.tabId) });
    else if (row.dataset.pinId && row.classList.contains('open')) send('prewake', { pinId: row.dataset.pinId, windowId });
  });

  // ---- space editor ------------------------------------------------------

  let editing = null; // { spaceId, color, confirmDelete }
  function openEditor(spaceId) {
    // Not in the narrow rail, which can't show it (content.js setLayout).
    if (root.classList.contains('rail')) return;
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
    if (!chip || root.classList.contains('rail')) return;
    event.preventDefault();
    openEditor(chip.dataset.spaceId);
  });
  chips.addEventListener('dblclick', (event) => {
    const chip = event.target.closest('.chip[data-space-id]');
    if (chip) openEditor(chip.dataset.spaceId);
  });

  // ---- right-click menu on tabs and pins -----------------------------------
  // Replaces the hover pin button: Pin/Unpin, move to another space, close.

  const menu = el(doc, 'div', { class: 'tab-menu', role: 'menu', tabindex: '-1', hidden: true });
  root.append(menu);
  // In the top layer (popover) where supported, so nothing on the page can
  // cover it; placed in viewport coordinates then. Otherwise inside the
  // sidebar, as before.
  const menuPopover = typeof menu.showPopover === 'function';
  // (Not while the site has a modal dialog open: see siteModalOpen.)
  if (menuPopover) menu.setAttribute('popover', 'manual');
  let menuFor = null; // { tabId } | { pinId }
  const menuItem = (label, action, data = {}) =>
    el(doc, 'button', { class: 'menu-item', role: 'menuitem', 'data-menu': action, ...data, text: label });
  function openMenu(row, x, y) {
    const tabId = row.dataset.tabId ? Number(row.dataset.tabId) : null;
    const pin = row.dataset.pinId ? state?.pins.find((p) => p.id === row.dataset.pinId) : null;
    if (tabId == null && !pin) return;
    const items = [];
    if (pin) {
      menuFor = { pinId: pin.id };
      items.push(menuItem('Unpin', 'unpin'));
      const openTab = V.sidebar(state, windowId, currentTabId).pins.find((p) => p.id === pin.id)?.tabId;
      if (openTab != null) items.push(el(doc, 'div', { class: 'menu-separator', role: 'separator' }), menuItem('Close Tab', 'close', { 'data-tab-id': String(openTab) }));
    } else {
      menuFor = { tabId };
      items.push(menuItem('Pin Tab', 'pin'));
      const spaceId = state?.tabSpace?.[tabId];
      const others = (state?.spaces ?? []).filter((sp) => sp.id !== spaceId);
      if (others.length) {
        items.push(el(doc, 'div', { class: 'menu-separator', role: 'separator' }));
        for (const sp of others) items.push(menuItem(`Move to ${sp.emoji} ${sp.name}`, 'move', { 'data-space-id': sp.id }));
      }
      items.push(el(doc, 'div', { class: 'menu-separator', role: 'separator' }), menuItem('Close Tab', 'close', { 'data-tab-id': String(tabId) }));
    }
    menu.replaceChildren(...items);
    menu.hidden = false;
    let inTopLayer = false;
    if (menuPopover && !siteModalOpen(doc)) {
      try {
        if (!menu.matches(':popover-open')) menu.showPopover();
        inTopLayer = true;
      } catch {}
    }
    menu.classList.toggle('top-layer', inTopLayer);
    if (inTopLayer) { // at the pointer, kept inside the window
      const view = doc.defaultView;
      menu.style.left = `${Math.max(4, Math.min(x, view.innerWidth - menu.offsetWidth - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y, view.innerHeight - menu.offsetHeight - 4))}px`;
    } else { // at the pointer, kept inside the sidebar
      const box = root.getBoundingClientRect();
      menu.style.left = `${Math.max(4, Math.min(x - box.left, box.width - menu.offsetWidth - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y - box.top, box.height - menu.offsetHeight - 4))}px`;
    }
    menu.focus({ preventScroll: true }); // keys work; nothing highlighted until hover or ↓/↑
  }
  function closeMenu() {
    if (menu.hidden) return;
    try {
      if (menuPopover && menu.matches(':popover-open')) menu.hidePopover();
    } catch {}
    menu.hidden = true;
    menuFor = null;
  }
  root.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('.tab, .pin');
    if (!row || !root.contains(row)) return closeMenu();
    event.preventDefault();
    event.stopPropagation();
    openMenu(row, event.clientX, event.clientY);
  });
  menu.addEventListener('click', (event) => {
    event.stopPropagation();
    const item = event.target.closest('.menu-item');
    if (!item || !menuFor) return;
    const target = menuFor;
    closeMenu();
    switch (item.dataset.menu) {
      case 'pin': return send('pinTab', { tabId: target.tabId });
      case 'unpin': return send('unpin', { pinId: target.pinId });
      case 'move': return send('moveTabToSpace', { tabId: target.tabId, spaceId: item.dataset.spaceId });
      case 'close': return send('closeTab', { tabId: Number(item.dataset.tabId), ...(openOverPage() ? { show: true } : {}) });
    }
  });
  // Hover and ↓/↑ move one highlight (the focused item), like macOS menus.
  menu.addEventListener('pointerover', (event) => event.target.closest('.menu-item')?.focus({ preventScroll: true }));
  menu.addEventListener('pointerleave', () => menu.focus({ preventScroll: true }));
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu();
      return globalThis.Margin?.shell?.focusCard(); // fitted layout: keys back to the page
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...menu.querySelectorAll('.menu-item')];
    const at = items.indexOf(menu.getRootNode().activeElement); // shadow root or document
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  });
  // Any press outside the menu (in the sidebar or on the page) closes it.
  // Presses inside the sidebar are judged here: in a closed shadow root, a
  // document listener only sees the host (composedPath() and target hide
  // everything inside), so it can't tell a press on the menu from one
  // elsewhere in the sidebar, and used to close the menu before its click.
  root.addEventListener('pointerdown', (event) => {
    if (!menu.hidden && !menu.contains(event.target)) closeMenu();
  }, true);
  doc.addEventListener('pointerdown', (event) => {
    const inSidebar = root.contains(event.target) || event.target === root.getRootNode().host;
    if (!menu.hidden && !inSidebar) closeMenu();
  }, true);
  doc.defaultView?.addEventListener('blur', closeMenu);

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
    isBusy: () => editing != null || draggingTabId != null || resizing != null || !menu.hidden,
    width: () => (resizing ? resizing.width : sidebarWidth(state?.settings)),
    update(nextState, context) {
      if (context?.fit) fit = context.fit;
      if (context && 'newTabPending' in context) newTabPending = !!context.newTabPending;
      state = nextState;
      if (menuFor?.tabId != null && !state.tabs?.[menuFor.tabId]) closeMenu(); // its tab is gone
      if (menuFor?.pinId && !state.pins?.some((p) => p.id === menuFor.pinId)) closeMenu();
      if (context?.windowId != null) windowId = context.windowId;
      if (context?.tabId != null) currentTabId = context.tabId;
      render();
      // The window's scroll position, after the list is drawn (a page shown
      // again, or a new one).
      if (Number.isFinite(context?.scroll)) {
        const before = tabsSection.scrollTop;
        settingScroll = true;
        tabsSection.scrollTop = context.scroll;
        if (tabsSection.scrollTop === before) settingScroll = false; // didn't move: no scroll event comes
      }
      if (pendingEdit && state.spaces.some((s) => s.id === pendingEdit)) {
        openEditor(pendingEdit);
        pendingEdit = null;
      }
      if (editing && !state.spaces.some((s) => s.id === editing.spaceId)) closeEditor();
      renderEditor();
    },
    // The Mac's Light/Dark appearance ('light' | 'dark').
    setColorScheme(scheme) {
      root.dataset.theme = scheme;
    },
  };
}

export { avatar, createSidebar };
