// Arcadium's sidebar: space chips, pins, tabs, the space editor and the
// right-click menu. Used on web pages (content.js) and on the new-tab page
// (newtab.js).
import * as V from '../../shared/view.js';
import { containScroll, canScrollX } from '../../shared/gestures.js';
import { createSpaceSwipe, settle, rubberBand, DEFAULTS as SWIPE } from '../../shared/space-swipe.js';
import { el, hostOf, siteModalOpen } from '../../shared/dom.js';
import { platform } from '../../shared/platform.js';
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
  if (!favIconUrl || !/^(https?|data):/.test(favIconUrl)) return letterAvatar(doc, label);
  const img = el(doc, 'img', { class: 'avatar', src: favIconUrl, alt: '', referrerpolicy: 'no-referrer', 'data-label': label });
  letterIfBroken(doc, img);
  return img;
}
const letterAvatar = (doc, label) => el(doc, 'span', {
  class: 'avatar letter',
  text: label.charAt(0).toUpperCase(),
  style: `background: hsl(${hue(label)} 55% 48%)`,
  'aria-hidden': 'true',
});
// An icon that doesn't load becomes the letter (also in a copy of a row,
// which doesn't carry the listener).
/** @param {Document} doc @param {HTMLImageElement} img */
function letterIfBroken(doc, img) {
  const swap = () => img.replaceWith(letterAvatar(doc, img.dataset.label || '?'));
  if (img.complete && img.src && !img.naturalWidth) swap();
  else img.addEventListener('error', swap, { once: true });
}

const SPACE_COLORS = ['#6c5ce7', '#0984e3', '#00b894', '#fdcb6e', '#e17055', '#d63031', '#e84393', '#636e72'];
const TAB_MIME = 'application/x-margin-tab';
const PIN_MIME = 'application/x-margin-pin';
const FOLDER_MIME = 'application/x-margin-folder';

// Arc's line icons (stroked, currentColor) and its two-tone folder.
const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(doc, viewBox, children, cls) {
  const node = doc.createElementNS(SVG_NS, 'svg');
  node.setAttribute('viewBox', viewBox);
  node.setAttribute('class', cls);
  node.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of children) {
    const child = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
    node.append(child);
  }
  return node;
}
const ICONS = {
  // The sidebar: a window with a panel at the left (three short lines in it).
  toggle: (doc) => svg(doc, '0 0 19 15', [
    ['rect', { x: '0.75', y: '0.75', width: '17.5', height: '13.5', rx: '3' }],
    ['path', { d: 'M6.25 0.75v13.5M2.75 4h1.5M2.75 6.5h1.5M2.75 9h1.5' }],
  ], 'line-icon toggle-icon'),
  // Arc's archive: a filled box with a slot, its lid and pieces above.
  archive: (doc) => svg(doc, '0 0 14 16.5', [
    ['path', { 'fill-rule': 'evenodd', d: 'M2 7.5H13Q13.5 7.5 13.5 8V13.5Q13.5 16.5 10.5 16.5H4.5Q1.5 16.5 1.5 13.5V8Q1.5 7.5 2 7.5ZM6.5 8.5H8.5A1 1 0 0 1 8.5 10.5H6.5A1 1 0 0 1 6.5 8.5Z' }],
    ['path', { d: 'M.9 6.1Q.4 6 .2 5.3L0 4.7Q0 4 .7 3.9L2.8 3.6L4 1.4Q4.35.85 4.75 1.4L5.95 3.1L8.6 3.2Q9.25 3.25 9.05 3.85L8.4 5.7Q8.25 6.1 7.8 6.1Z' }],
    ['path', { d: 'M11.4 2.9Q11.8 2.3 12.2 2.9L14 5.2Q14.3 5.7 13.8 5.9L11.3 6.4Q10.6 6.5 10.6 5.8Z' }],
    ['circle', { cx: '9.5', cy: '1', r: '1' }],
  ], 'fill-icon archive-icon'),
  plus: (doc) => svg(doc, '0 0 14 14', [['path', { d: 'M7 1v12M1 7h12' }]], 'line-icon plus-icon'),
  close: (doc) => svg(doc, '0 0 11 11', [['path', { d: 'M1 1l9 9M10 1l-9 9' }]], 'line-icon close-icon'),
  // Open: the back panel leaning out to the upper left, the front leaning
  // under it (Arc's shape); closed: both upright.
  folder: (doc, open) => svg(doc, '0 0 22.5 16.5', open ? [
    ['path', { class: 'folder-back', d: 'M5.2 15.9Q4.4 15.9 4.2 15.1L.75 2.2Q.4.6 2 .6H5.6Q6.3.6 6.8 1.1L8.2 2.6Q8.6 3 9.2 3.05L20.6 4.1Q21.6 4.2 21.4 5.2L17.9 15.9Z' }],
    ['path', { class: 'folder-front', d: 'M8.7 5.2H21.1Q22 5.2 21.7 6.1L18.6 15.3Q18.4 15.9 17.7 15.9H5Q4.15 15.9 4.4 15.1L7.4 6.3Q7.75 5.2 8.7 5.2Z' }],
  ] : [
    ['path', { class: 'folder-back', d: 'M1 2.1Q1 .6 2.5 .6H6.6Q7.2.6 7.6 1.1L8.9 2.6H20Q21.5 2.6 21.5 4.1V14.4Q21.5 15.9 20 15.9H2.5Q1 15.9 1 14.4Z' }],
    ['path', { class: 'folder-front', d: 'M1 6.3Q1 4.8 2.5 4.8H20Q21.5 4.8 21.5 6.3V14.4Q21.5 15.9 20 15.9H2.5Q1 15.9 1 14.4Z' }],
  ], `folder-icon${open ? ' open' : ''}`),
};

// `onNewTab`: what "+ New tab" does (the command palette, Arc-style);
// without it, a new tab is opened.
// `onArchive`: what the archive button does (the new-tab page shows its own
// "Recently archived"); without it, Margin's start page opens.
// `onWidth(px, { done })`: called while the sidebar is resized (live) and
// once more with done: true when the drag ends.
// `onScroll(px)`: the list was scrolled by the user (every page's sidebar
// opens at the window's last position; update(…, { scroll }) applies it).
// `onSwitch(tabId, request)`: a click here switches to that tab (the page
// highlights it at once: shared/switching.js, update(…, { switchingTo })).
/**
 * @param {{ document: Document, send: import('../../../types/margin').Send, mode: 'overlay' | 'newtab', onNewTab?: () => void, onArchive?: () => void, onWidth?: (px: number, info: { done: boolean }) => void, onScroll?: (px: number) => void, onSwitch?: (tabId: number, request: Promise<unknown>) => void }} options
 */
function createSidebar({ document: doc, send, mode, onNewTab, onArchive, onWidth, onScroll, onSwitch }) {
  // Arc's layout: the sidebar toggle (Keep open / Auto-hide) at the top, the
  // space's name, then one list (the pinned area with its folders, then
  // "+ New Tab" and the tabs), and at the bottom the archive, the spaces and
  // "+" (a new folder or space).
  const keepOpen = el(doc, 'button', { type: 'button', class: 'keep-open', 'data-action': 'keep-open' }, ICONS.toggle(doc));
  // With Keep open: this site fitted beside the sidebar, or shown normally
  // (the palette has the same switch). Only where it applies.
  const fitSite = el(doc, 'button', { type: 'button', class: 'fit-site', 'data-action': 'fit-site', hidden: true });
  const top = el(doc, 'header', { class: 'top' }, mode === 'overlay' ? keepOpen : null, el(doc, 'span', { class: 'spacer' }), fitSite);
  const spaceTitle = el(doc, 'div', { class: 'space-title' });
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
  const listDivider = el(doc, 'div', { class: 'divider' });
  const tabs = el(doc, 'ul', { class: 'tabs', 'aria-label': 'Tabs' });
  // One scroller for the pinned area and the tabs (Arc): many folders never
  // push the tabs out of reach.
  const tabsSection = el(doc, 'section', { class: 'tabs-section' }, el(doc, 'div', { class: 'pins-section' }, pins), listDivider, tabs);
  const chips = el(doc, 'nav', { class: 'spaces', 'aria-label': 'Spaces' });
  const footer = el(doc, 'footer', { class: 'bar' },
    el(doc, 'button', { type: 'button', class: 'bar-button archive', 'data-action': 'archive', title: 'Archived tabs', 'aria-label': 'Archived tabs' }, ICONS.archive(doc)),
    chips,
    el(doc, 'button', { type: 'button', class: 'bar-button add', 'data-action': 'add-menu', title: 'New folder or space', 'aria-label': 'New folder or space' }, ICONS.plus(doc)));
  // The space's own part (its name, the editor, the list): what a sideways
  // swipe moves (see "swipe between spaces" below).
  const pane = el(doc, 'div', { class: 'space-pane' }, spaceTitle, editor, tabsSection);
  const root = el(doc, 'aside', { class: `margin-sidebar ${mode}`, 'aria-label': 'Margin' },
    top,
    pane,
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
  let resizing = null; // { startX, startWidth, width, scale } (sizes in the sidebar's px)
  // The width is one of Arcadium's own settings.
  const saveWidth = (sidebarWidth) => send('updateThemeSettings', { themeId: 'arcadium', patch: { sidebarWidth } });
  const setWidth = (px) => root.style.setProperty('--width', `${px}px`);
  // The sidebar's own px per px of the page's: Margin keeps its size when
  // the page is zoomed (shared/dom.js setPageZoom), so pointer positions and
  // boxes (in the page's pixels) are scaled by this before they're used as
  // its sizes and positions. 1 when the page isn't zoomed.
  const hostScale = () => {
    const width = root.getBoundingClientRect().width;
    return width && root.offsetWidth ? root.offsetWidth / width : 1;
  };
  // Wheel deltas in the sidebar's px: Chromium's are the page's zoomed px,
  // WebKit's screen points already (platform.zoomedWheel).
  const wheelScale = () => (platform?.zoomedWheel ? hostScale() : 1);
  resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizer.setPointerCapture?.(event.pointerId);
    const startWidth = root.offsetWidth;
    resizing = { startX: event.clientX, startWidth, width: startWidth, scale: hostScale() };
    root.classList.add('resizing');
  });
  resizer.addEventListener('pointermove', (event) => {
    if (!resizing) return;
    resizing.width = clampWidth(resizing.startWidth + (event.clientX - resizing.startX) * resizing.scale);
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
  let switchingTo = null; // a tab being switched to: highlighted already
  // A folder's name being edited in place ({ folderId, draft }), and a just-
  // created folder to edit once it arrives (as pendingEdit).
  let renaming = null;
  let pendingRename = null;
  let rendering = false; // the rename field leaves the DOM while redrawing: not a blur
  // A space this sidebar shows before the state says so (just swiped to;
  // the background is switching), and when that started.
  let shownSpace = null;
  let shownSince = 0;
  // The page was just shown (content/core.js): its own tab's space until the
  // state records it's in front (shared/view.js sidebar).
  let justShown = false;
  // A swipe between spaces under way (see "swipe between spaces"):
  // { neighbours: { -1?: id, 1?: id }, ghosts: { -1?: el, 1?: el }, width, offset, frame, settling, committed }
  let swiping = null;
  let drawingGhosts = false; // drawing its pictures: the spaces bar's scroll stays
  let renderPending = false; // a redraw held back while it settles
  // The state as this sidebar shows it.
  const viewState = () => (shownSpace && state ? { ...state, activeSpaceByWindow: { ...state.activeSpaceByWindow, [windowId]: shownSpace } } : state);

  const closeButton = (tabId, label) => el(doc, 'button', { type: 'button', class: 'icon close', 'data-action': 'close', 'data-tab-id': String(tabId), 'aria-label': label }, ICONS.close(doc));
  function pinRow(p, nested) {
    return el(doc, 'li', {
      class: `pin${nested ? ' nested' : ''}${p.active ? ' active' : ''}${p.behind ? ' behind' : ''}${p.tabId ? ' open' : ''}`,
      'data-action': 'open-pin',
      'data-pin-id': p.id,
      'data-folder-id': p.folderId ?? null,
      'aria-label': p.title, // no tooltip (Arc); the rail hides the title
      draggable: 'true',
    },
    avatar(doc, { ...p, favIconUrl: V.iconFor(state, p) }),
    el(doc, 'span', { class: 'title', text: p.title }),
    // An open pinned tab closes, the pin stays (Arc); Unpin is in its menu.
    p.tabId != null ? closeButton(p.tabId, 'Close tab (stays pinned)') : null);
  }
  // A folder: the row is a list item; its toggle (a button, Enter/Space too)
  // holds the icon and the name, or the field renaming it.
  function folderRow(f) {
    const editingThis = renaming?.folderId === f.id;
    const name = editingThis ? renameField(f) : el(doc, 'span', { class: 'title', text: f.name });
    return el(doc, 'li', {
      class: `folder${f.open ? ' open' : ''}`,
      'data-action': editingThis ? null : 'toggle-folder', // its padding too
      'data-folder-id': f.id,
      draggable: editingThis ? null : 'true',
    }, el(doc, 'div', {
      class: 'folder-toggle',
      'data-action': editingThis ? null : 'toggle-folder',
      'data-folder-id': f.id,
      role: editingThis ? null : 'button',
      tabindex: editingThis ? null : '0',
      'aria-expanded': editingThis ? null : String(f.open),
    }, ICONS.folder(doc, f.open), name));
  }

  // ---- renaming a folder in place -------------------------------------------
  let renameInput = null;
  function renameField(f) {
    if (!renameInput) {
      renameInput = el(doc, 'input', { type: 'text', class: 'folder-name', 'aria-label': 'Folder name', maxlength: '40', spellcheck: 'false' });
      renameInput.addEventListener('input', () => { if (renaming) renaming.draft = renameInput.value; });
      renameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') commitRename();
        else if (event.key === 'Escape') cancelRename();
      });
      renameInput.addEventListener('blur', () => { if (!rendering) commitRename(); });
      renameInput.addEventListener('click', (event) => event.stopPropagation());
      renameInput.addEventListener('dblclick', (event) => event.stopPropagation());
    }
    if (renameInput.dataset.folderId !== f.id) {
      renameInput.dataset.folderId = f.id;
      renameInput.value = renaming.draft;
      renameInput.dataset.fresh = 'true'; // select all once it's in the page
    }
    return renameInput;
  }
  function startRename(folderId) {
    const folder = state?.folders?.find((f) => f.id === folderId);
    if (!folder || root.classList.contains('rail')) return;
    renaming = { folderId, draft: folder.name };
    if (renameInput) delete renameInput.dataset.folderId;
    render();
  }
  function commitRename() {
    if (!renaming) return;
    const { folderId, draft } = renaming;
    renaming = null;
    const name = draft.trim().slice(0, 40);
    const folder = state?.folders?.find((f) => f.id === folderId);
    if (name && folder && name !== folder.name) {
      send('renameFolder', { folderId, name });
      // Shown at once, not the old name until storage comes back.
      state = { ...state, folders: state.folders.map((f) => (f.id === folderId ? { ...f, name } : f)) };
    }
    render();
  }
  function cancelRename() {
    renaming = null;
    render();
  }

  let lastView = null; // the view last drawn (menus and drag and drop read it)
  function render() {
    if (!state || windowId == null) return;
    // Not while a swipe slides into place (it would redraw the space leaving).
    if (swiping?.settling) {
      renderPending = true;
      return;
    }
    renderPending = false;
    rendering = true;
    try {
      draw();
    } finally {
      rendering = false;
    }
    // The field being typed in keeps its focus and caret through a redraw.
    if (renaming && renameInput?.isConnected) {
      if (renameInput.dataset.fresh === 'true') {
        delete renameInput.dataset.fresh;
        renameInput.focus({ preventScroll: true });
        renameInput.select();
      } else if (renameSelection) {
        renameInput.focus({ preventScroll: true });
        renameInput.setSelectionRange(...renameSelection);
      }
    }
  }
  let renameSelection = null;
  let shownSpaceId = null;
  function draw() {
    // Not while this sidebar shows a space of its own choosing (a swipe, a click on a space).
    const view = lastView = V.sidebar(viewState(), windowId, currentTabId, { newTabPending, switchingTo, justShown: justShown && !shownSpace });
    root.style.setProperty('--space-color', view.spaces.find((s) => s.id === view.spaceId)?.color ?? '');
    if (!resizing) setWidth(sidebarWidth(state.settings));
    if (renaming && !view.pinned.some((item) => item.kind === 'folder' && item.id === renaming.folderId)) renaming = null; // gone
    const focused = renaming && renameInput && renameInput.getRootNode().activeElement === renameInput;
    renameSelection = focused ? [renameInput.selectionStart, renameInput.selectionEnd] : null;

    const space = view.spaces.find((s) => s.id === view.spaceId);
    spaceTitle.dataset.spaceId = space?.id ?? '';
    spaceTitle.replaceChildren(
      el(doc, 'span', { class: 'emoji', 'aria-hidden': 'true', text: space?.emoji ?? '' }),
      el(doc, 'span', { class: 'title', text: space?.name ?? '' }),
    );

    chips.replaceChildren(
      ...view.spaces.map((s) =>
        el(doc, 'button', {
          type: 'button',
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

    // The pinned area: folders (their pins beneath, indented, while open;
    // a closed one shows only the pin of the tab being shown) and loose pins.
    pins.replaceChildren(
      ...view.pinned.flatMap((item) => {
        if (item.kind !== 'folder') return [pinRow(item, false)];
        return [folderRow(item), ...(item.open ? item.pins : item.peek).map((p) => pinRow(p, true))];
      }),
    );
    listDivider.hidden = !view.pinned.length;

    // Arc: "+ New Tab" above the tabs, highlighted like a tab while the
    // new-tab page is shown (⌘T); it opens the palette.
    const newTabRow = el(doc, 'li', {
      class: `new-tab-row${view.newTab.active ? ' active' : ''}${view.newTab.behind ? ' behind' : ''}`,
      'data-action': 'new-tab',
      role: 'button',
      'aria-label': 'New Tab',
      'aria-current': view.newTab.active ? 'page' : null,
    }, el(doc, 'span', { class: 'plus', 'aria-hidden': 'true' }, ICONS.plus(doc)), el(doc, 'span', { class: 'title', text: 'New Tab' }));
    tabs.replaceChildren(
      newTabRow,
      ...view.tabs.map((t) =>
        el(doc, 'li', {
          class: `tab${t.active ? ' active' : ''}${t.behind ? ' behind' : ''}`,
          'data-action': 'activate',
          'data-tab-id': String(t.id),
          'aria-label': t.title || t.url || 'New Tab',
          draggable: 'true',
        },
        avatar(doc, { ...t, favIconUrl: V.iconFor(state, t) }),
        el(doc, 'span', { class: 'title', text: t.title || t.url || 'New Tab' }),
        closeButton(t.id, 'Close tab')),
      ),
    );

    const pinned = !!state.settings?.sidebarPinnedOpen;
    keepOpen.title = pinned ? 'Auto-hide the sidebar' : 'Keep the sidebar open';
    keepOpen.setAttribute('aria-label', keepOpen.title);
    keepOpen.setAttribute('aria-pressed', String(pinned));

    const excepted = !!fit?.origin && (state.settings?.fitPagesExcept ?? []).includes(fit.origin);
    fitSite.hidden = !(pinned && fit?.fittable && state.settings?.fitPages !== false && (fit.fitted || excepted));
    fitSite.textContent = fit?.fitted ? '▢' : '▣';
    fitSite.title = fit?.fitted ? 'Show this site normally (not fitted beside the sidebar)' : 'Fit this site beside the sidebar again';
    fitSite.setAttribute('aria-label', fitSite.title);

    // A space switched to: its icon in the bottom bar in view (many spaces in
    // a narrow sidebar scroll sideways). Not scrollIntoView: it can scroll the page.
    if (view.spaceId !== shownSpaceId && !drawingGhosts) {
      shownSpaceId = view.spaceId;
      const chip = chips.querySelector('.chip.active');
      if (chip) {
        const bar = chips.getBoundingClientRect();
        const box = chip.getBoundingClientRect();
        const k = hostScale();
        if (box.left < bar.left) chips.scrollLeft -= (bar.left - box.left) * k;
        else if (box.right > bar.right) chips.scrollLeft += (box.right - bar.right) * k;
      }
    }
  }

  // Open over the page (hovered, toggled, or the rail expanded): a switch
  // made from it keeps it open on the next page (content/core.js fills in
  // how it was opened; background handlers.js carryOpen).
  const openOverPage = () => mode === 'overlay' && root.classList.contains('open') && (!root.classList.contains('docked') || root.classList.contains('rail-expanded'));

  root.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target || !root.contains(target)) return;
    event.stopPropagation();
    if (event.ctrlKey && target.closest('.tab, .pin, .folder')) return; // ⌃-click is the Mac's right-click: the menu
    const tabId = Number(target.dataset.tabId);
    const { pinId, spaceId, folderId } = target.dataset;
    const show = openOverPage();
    switch (target.dataset.action) {
      case 'activate': {
        const request = send('activateTab', { tabId, ...(show ? { show } : {}) });
        if (!target.classList.contains('active')) onSwitch?.(tabId, request);
        return request;
      }
      case 'close': return send('closeTab', { tabId, ...(show ? { show } : {}) });
      case 'open-pin': {
        const request = send('openPin', { pinId, windowId, ...(show ? { show } : {}) });
        // The tab the background will show (in this window first).
        const pinTab = target.classList.contains('open') && !target.classList.contains('active') && state ? V.pinTabId(state, pinId, windowId) : null;
        if (pinTab != null) onSwitch?.(pinTab, request);
        return request;
      }
      case 'toggle-folder': {
        if (event.detail > 1) return; // the second click of a double-click (renames)
        const folder = state?.folders?.find((f) => f.id === folderId);
        if (!folder) return;
        lastToggle = { folderId, wasOpen: folder.open !== false, at: Date.now() };
        return send('setFolderOpen', { folderId, open: folder.open === false });
      }
      case 'set-space': return send('setSpace', { windowId, spaceId, ...(show ? { show } : {}) });
      case 'new-tab': return onNewTab ? onNewTab() : send('newTab', { windowId });
      case 'archive': return onArchive ? onArchive() : send('openLauncher', { windowId });
      case 'add-menu': {
        const box = target.getBoundingClientRect();
        return openAddMenu(box.left, box.top);
      }
      case 'fit-site':
        return fit?.origin && send('setFitSite', { origin: fit.origin, fit: !fit.fitted });
      case 'keep-open':
        return send('updateSettings', { patch: { sidebarPinnedOpen: !state?.settings?.sidebarPinnedOpen } });
    }
  });
  // Double-click renames a folder; its first click toggled it, so that's undone.
  let lastToggle = null;
  pins.addEventListener('dblclick', (event) => {
    const row = event.target.closest('.folder');
    if (!row || event.target.closest('.folder-name')) return;
    event.stopPropagation();
    if (lastToggle?.folderId === row.dataset.folderId && Date.now() - lastToggle.at < 800) {
      send('setFolderOpen', { folderId: lastToggle.folderId, open: lastToggle.wasOpen });
    }
    lastToggle = null;
    startRename(row.dataset.folderId);
  });
  // A folder's toggle with the keyboard.
  pins.addEventListener('keydown', (event) => {
    const toggle = event.target.closest?.('.folder-toggle[data-action]');
    if (!toggle || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    const folder = state?.folders?.find((f) => f.id === toggle.dataset.folderId);
    if (folder) send('setFolderOpen', { folderId: folder.id, open: folder.open === false });
  });
  // Many spaces in a narrow sidebar: a mouse wheel scrolls them sideways.
  chips.addEventListener('wheel', (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || chips.scrollWidth <= chips.clientWidth) return;
    chips.scrollLeft += event.deltaY * wheelScale();
    event.preventDefault();
  }, { passive: false });

  // ---- swipe between spaces (Arc) ----------------------------------------
  // Two fingers sideways over the sidebar drag the space (its name and list)
  // with them, the neighbouring space coming in from that side (a still
  // picture of it, drawn when the swipe starts); let go past a third of the
  // width, or with a flick, and that space is shown, else it slides back.
  // No wrapping: past the first or last space it resists (⌃⌘←/→ wrap).
  // The background then switches the window to it (its most recent tab
  // comes to the front, as clicking its icon); this sidebar shows it at
  // once. The gesture logic is shared/space-swipe.js.
  const SETTLE_MS = 220;
  const SHOWN_SPACE_MS = 3000;
  const spaceSwipe = createSpaceSwipe();
  let swipeEndTimer = null;
  let shownTimer = null;
  // Where the drag shown started in the tracker's gesture (one that began
  // while the last swipe was still sliding into place is shown from here).
  let swipeBase = { offset: 0, events: 0 };
  const fromBase = (result) => ({ ...result, offset: result.offset - swipeBase.offset, events: result.events - swipeBase.events });
  // The most recent tab of a space in this window: the one its switch shows.
  const recentTabOf = (spaceId) => Object.values(state?.tabs ?? {})
    .filter((t) => t.windowId === windowId && state.tabSpace[t.id] === spaceId)
    .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))[0] ?? null;
  // Does anything between the pointer and the sidebar scroll sideways that way
  // (the spaces bar when they don't fit)? Then the wheel is its.
  const scrollsSideways = (event) => {
    for (const node of /** @type {Element[]} */ (event.composedPath())) {
      if (node === root) return false;
      if (node.nodeType === 1 && canScrollX(node, event.deltaX, null)) return true;
    }
    return false;
  };
  // On a page, only while the sidebar is out (not the narrow rail).
  const swipeUsable = () => mode !== 'overlay' || (root.classList.contains('open') && !root.classList.contains('rail'));
  function startSwipe() {
    const shown = V.activeSpaceId(viewState(), windowId);
    const at = state.spaces.findIndex((s) => s.id === shown);
    const neighbours = { [-1]: state.spaces[at - 1]?.id, [1]: state.spaces[at + 1]?.id };
    const box = root.getBoundingClientRect();
    const paneBox = pane.getBoundingClientRect();
    const k = hostScale(); // boxes are in the page's pixels
    // Still pictures of the neighbours, each drawn as it would show (its
    // most recent tab highlighted, as after the switch), then this one again.
    // Drawing them must not move this list's or the spaces bar's scroll.
    const ghosts = {};
    const keep = { shownSpace, switchingTo, top: tabsSection.scrollTop, left: chips.scrollLeft };
    rendering = true;
    drawingGhosts = true;
    try {
      for (const dir of [-1, 1]) {
        if (!neighbours[dir]) continue;
        shownSpace = neighbours[dir];
        switchingTo = recentTabOf(shownSpace)?.id ?? null;
        draw();
        const ghost = /** @type {HTMLElement} */ (pane.cloneNode(true));
        for (const img of ghost.querySelectorAll('img.avatar')) letterIfBroken(doc, /** @type {HTMLImageElement} */ (img));
        ghost.classList.add('ghost');
        ghost.inert = true;
        ghost.setAttribute('aria-hidden', 'true');
        Object.assign(ghost.style, { top: `${(paneBox.top - box.top) * k}px`, left: `${(paneBox.left - box.left) * k}px`, width: `${paneBox.width * k}px`, height: `${paneBox.height * k}px` });
        ghosts[dir] = ghost;
      }
    } finally {
      ({ shownSpace, switchingTo } = keep);
      draw();
      drawingGhosts = false;
      rendering = false;
      chips.scrollLeft = keep.left;
      if (tabsSection.scrollTop !== keep.top) {
        settingScroll = true; // not a scroll of the user's
        tabsSection.scrollTop = keep.top;
      }
    }
    root.append(...Object.values(ghosts));
    root.classList.add('space-swiping');
    swiping = { neighbours, ghosts, width: box.width * k, offset: 0, frame: 0, settling: false, committed: false };
  }
  // Where everything sits for `offset` (px; > 0: dragged right).
  function placeSwipe(offset) {
    const s = swiping;
    const toward = offset > 0 ? -1 : 1;
    const shownOffset = s.neighbours[toward] ? Math.max(-s.width, Math.min(s.width, offset)) : rubberBand(offset, s.width * 0.2);
    pane.style.transform = shownOffset ? `translateX(${shownOffset}px)` : '';
    for (const dir of [-1, 1]) s.ghosts[dir]?.style.setProperty('transform', `translateX(${shownOffset + dir * s.width}px)`);
  }
  function moveSwipe(offset) {
    swiping.offset = offset;
    if (swiping.frame) return;
    swiping.frame = requestAnimationFrame(() => {
      if (!swiping) return;
      swiping.frame = 0;
      placeSwipe(swiping.offset);
    });
  }
  // Done (or the page hidden): the real pane back in place; a space swiped
  // to is drawn from its top, as its picture was, and anything held back
  // while settling is drawn now.
  function endSwipe() {
    if (!swiping) return;
    const { committed } = swiping;
    cancelAnimationFrame(swiping.frame);
    for (const ghost of Object.values(swiping.ghosts)) ghost.remove();
    pane.style.transform = '';
    pane.classList.remove('settling');
    root.classList.remove('space-swiping');
    swiping = null;
    if (committed && tabsSection.scrollTop !== 0) {
      settingScroll = true;
      tabsSection.scrollTop = 0;
    }
    if (committed || renderPending) render();
  }
  // The fingers lifted: on to the neighbour, or back.
  function releaseSwipe({ offset, speed, events }) {
    const s = swiping;
    if (!s || s.settling) return;
    cancelAnimationFrame(s.frame);
    s.frame = 0;
    const dir = settle({ offset, speed, events, width: s.width, has: (d) => !!s.neighbours[d] });
    s.settling = true;
    pane.classList.add('settling');
    for (const ghost of Object.values(s.ghosts)) ghost.classList.add('settling');
    placeSwipe(dir ? -dir * s.width : 0);
    if (dir) {
      const spaceId = s.neighbours[dir];
      s.committed = true;
      onScroll?.(0); // the window's list position: the new space from its top (saved with the switch)
      // Swiped on the sidebar out over the page: it stays out on the page
      // that comes to the front (as a tab clicked there).
      const show = openOverPage();
      const request = send('setSpace', { windowId, spaceId, ...(show ? { show } : {}) });
      if (state.tabSpace[currentTabId] === spaceId) {
        // Back to this page's own space: a switch away still pending stops
        // (as clicking this page's tab does).
        if (switchingTo != null) send('activateTab', { tabId: currentTabId });
        onSwitch?.(currentTabId, request);
      } else {
        // Its tab comes to the front: highlighted and the page covered at
        // once (shared/switching.js).
        const tab = recentTabOf(spaceId);
        if (tab) onSwitch?.(tab.id, request);
      }
      showSpaceNow(spaceId);
    }
    setTimeout(() => {
      if (swiping === s) endSwipe();
    }, SETTLE_MS);
  }
  // This sidebar shows the space until the state does; if it never does
  // (the switch failed), back to the state's after SHOWN_SPACE_MS.
  function showSpaceNow(spaceId) {
    shownSpace = spaceId;
    shownSince = Date.now();
    clearTimeout(shownTimer);
    shownTimer = setTimeout(() => {
      if (shownSpace !== spaceId) return;
      shownSpace = null;
      render();
    }, SHOWN_SPACE_MS + 50);
  }
  // A mouse wheel, not a trackpad: WebKit and Chromium report a wheel's
  // notches as multiples of 120 in the old wheelDelta, a trackpad's as about
  // 3× its pixel delta (rounded). A Mac wheel's 40px notch looks like a
  // trackpad's; settle() still wants several events.
  const mouseWheel = (event) => {
    const legacy = /** @type {any} */ (event).wheelDeltaX ?? 0;
    return legacy !== 0 && legacy % 120 === 0 && Math.abs(Math.abs(legacy) - Math.abs(event.deltaX * wheelScale()) * 3) > 3; // the unzoomed delta
  };
  root.addEventListener('wheel', (event) => {
    const k = wheelScale(); // the swipe is measured in the sidebar's own px
    const busy = editing != null || renaming != null || dragging != null || resizing != null || !menu.hidden;
    const usable = !!state && windowId != null && state.spaces.length > 1 && !busy && swipeUsable() && !scrollsSideways(event);
    const result = spaceSwipe.wheel({ deltaX: event.deltaX * k, deltaY: event.deltaY * k, deltaMode: event.deltaMode, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, mouse: mouseWheel(event), time: event.timeStamp, usable });
    if (spaceSwipe.swiping(event.timeStamp) && event.cancelable) event.preventDefault(); // not the list, not Safari's back/forward
    // While it settles, the momentum after the fingers lifted still counts
    // as that gesture (fed above), so it never starts another swipe.
    if (swiping?.settling) return;
    if (result.phase === 'tracking') {
      clearTimeout(swipeEndTimer);
      if (!swiping) {
        // Before this event (if it counted): 0 for a gesture that starts here.
        swipeBase = result.counted ? { offset: result.offset + event.deltaX * k, events: result.events - 1 } : { offset: result.offset, events: result.events };
        startSwipe();
      }
      moveSwipe(result.offset - swipeBase.offset);
      swipeEndTimer = setTimeout(() => {
        const end = spaceSwipe.end();
        releaseSwipe(end.phase === 'release' ? fromBase(end) : end);
      }, SWIPE.GAP_MS + 20);
    } else if (result.phase === 'release') {
      clearTimeout(swipeEndTimer);
      releaseSwipe(fromBase(result));
    }
  }, { passive: false });
  // The page hidden mid-swipe (another tab came to the front): put it back.
  doc.addEventListener('visibilitychange', () => {
    if (!doc.hidden || !swiping) return;
    clearTimeout(swipeEndTimer);
    spaceSwipe.reset();
    endSwipe();
  });

  // A new space (opened in the editor) or folder (its name being edited).
  function newSpace() {
    // The new space can reach us (via storage) before the reply does,
    // so open it now if it's already here, else when it arrives.
    return send('createSpace', { windowId }).then((res) => {
      if (!res?.spaceId) return;
      freshSpace = res.spaceId;
      if (state?.spaces.some((s) => s.id === res.spaceId)) openEditor(res.spaceId);
      else pendingEdit = res.spaceId;
    });
  }
  // A space just created: once its editor closes, it's shown (its start page
  // opens, as Arc shows a new space); not while being named, which happens
  // in this page's sidebar.
  let freshSpace = null;
  function folderCreated(folderId) {
    if (!folderId) return;
    if (state?.folders?.some((f) => f.id === folderId)) startRename(folderId);
    else pendingRename = folderId;
  }
  const newFolder = (payload = {}) => send('createFolder', { windowId, ...payload }).then(folderCreated);

  // A tab or open pin under the pointer, or pressed: its process is woken
  // and kept awake (background/tabs.js wakeTab), so a click switches with
  // nothing left to wait for. Resting HOVER_WAKE_MS on a row starts it; it's
  // renewed every HOVER_RENEW_MS while the pointer stays (each wake keeps the
  // process awake a little longer than that).
  const HOVER_WAKE_MS = 80;
  const HOVER_RENEW_MS = 500;
  const HOVER_IDLE_MS = 10000; // the pointer resting longer without moving: stop
  let hoverWake = null; // { key, selector, timer, until }
  const prewakeRow = (row, renew = false) => {
    if (!row?.isConnected || row.classList.contains('active')) return;
    if (row.dataset.tabId) send('prewake', { tabId: Number(row.dataset.tabId), renew });
    else if (row.dataset.pinId && row.classList.contains('open')) send('prewake', { pinId: row.dataset.pinId, windowId, renew });
  };
  const stopHoverWake = () => {
    if (hoverWake) clearTimeout(hoverWake.timer);
    hoverWake = null;
  };
  root.addEventListener('pointerover', (event) => {
    const row = event.target.closest?.('.tab, .pin');
    const key = row && root.contains(row) ? (row.dataset.tabId ? `tab:${row.dataset.tabId}` : `pin:${row.dataset.pinId}`) : null;
    if (key && hoverWake?.key === key) return;
    stopHoverWake();
    if (!key || dragging) return;
    // Found again by its id on each renewal: a redraw (another tab's title
    // changing) replaces the row.
    const selector = row.dataset.tabId ? `.tab[data-tab-id="${row.dataset.tabId}"]` : `.pin[data-pin-id="${CSS.escape(row.dataset.pinId)}"]`;
    const wake = { key, selector, timer: null, until: Date.now() + HOVER_IDLE_MS };
    let first = true;
    const tick = () => {
      if (hoverWake !== wake) return;
      if (doc.hidden || Date.now() > wake.until) return stopHoverWake();
      prewakeRow(root.querySelector(selector), !first); // renewals: a fresh wake
      first = false;
      wake.timer = setTimeout(tick, HOVER_RENEW_MS);
    };
    hoverWake = wake;
    wake.timer = setTimeout(tick, HOVER_WAKE_MS);
  });
  root.addEventListener('pointermove', () => {
    freshHover();
    if (hoverWake) hoverWake.until = Date.now() + HOVER_IDLE_MS;
  }, { passive: true });
  root.addEventListener('pointerleave', stopHoverWake);
  root.addEventListener('dragstart', stopHoverWake, true);
  root.addEventListener('click', stopHoverWake, true); // a switch: the page goes
  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.ctrlKey || event.target.closest('.icon')) return;
    const row = event.target.closest('.tab, .pin');
    if (row && root.contains(row)) prewakeRow(row);
  });
  // A page shown again: the browser still applies :hover where the pointer
  // was when it was last in front, which drew a hover and × on the wrong
  // row for a frame. Hover styles wait for the pointer to move.
  function staleHover() {
    stopHoverWake();
    root.classList.add('hover-stale');
  }
  function freshHover() {
    root.classList.remove('hover-stale');
  }
  if (doc.hidden) staleHover();
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) staleHover(); });
  doc.defaultView?.addEventListener('pagehide', staleHover);

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
  // `deleted`: the space is gone (no showing it).
  function closeEditor({ deleted = false } = {}) {
    const spaceId = editing?.spaceId;
    editing = null;
    editor.hidden = true;
    if (spaceId && spaceId === freshSpace) {
      freshSpace = null;
      if (!deleted) send('setSpace', { windowId, spaceId });
    }
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
      closeEditor({ deleted: true });
    }
  });
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeEditor();
  });
  // The space's title row and its icon in the bottom bar: right-click or
  // double-click edits it.
  for (const where of [chips, spaceTitle]) {
    const spaceOf = (event) => event.target.closest('.chip[data-space-id], .space-title')?.dataset.spaceId;
    where.addEventListener('contextmenu', (event) => {
      const spaceId = spaceOf(event);
      if (!spaceId || root.classList.contains('rail')) return;
      event.preventDefault();
      event.stopPropagation();
      openEditor(spaceId);
    });
    where.addEventListener('dblclick', (event) => {
      const spaceId = spaceOf(event);
      if (spaceId) openEditor(spaceId);
    });
  }

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
  let menuFor = null; // { tabId } | { pinId } | { folderId } | { add: true }
  const menuItem = (label, action, data = {}) =>
    el(doc, 'button', { class: 'menu-item', role: 'menuitem', 'data-menu': action, ...data, text: label });
  const separator = () => el(doc, 'div', { class: 'menu-separator', role: 'separator' });
  // The folders of the space shown (to move a pin or tab into).
  const spaceFolders = () => (lastView?.pinned ?? []).filter((item) => item.kind === 'folder');
  function menuItems(row) {
    const tabId = row.dataset.tabId && row.classList.contains('tab') ? Number(row.dataset.tabId) : null;
    const pin = row.dataset.pinId ? state?.pins.find((p) => p.id === row.dataset.pinId) : null;
    const folder = row.classList.contains('folder') ? state?.folders?.find((f) => f.id === row.dataset.folderId) : null;
    if (folder) {
      menuFor = { folderId: folder.id };
      return [menuItem('Rename Folder', 'rename-folder'), menuItem(folder.open === false ? 'Open Folder' : 'Close Folder', 'toggle-folder'), separator(), menuItem('Delete Folder (pins stay)', 'delete-folder')];
    }
    if (pin) {
      menuFor = { pinId: pin.id };
      const items = [menuItem('Unpin', 'unpin'), separator()];
      const shown = lastView?.pins.find((p) => p.id === pin.id);
      for (const f of spaceFolders()) if (f.id !== shown?.folderId) items.push(menuItem(`Move to 📁 ${f.name}`, 'move-pin', { 'data-folder-id': f.id }));
      if (shown?.folderId) items.push(menuItem('Remove from Folder', 'move-pin'));
      items.push(menuItem('New Folder with Pin', 'new-folder-pin'));
      if (shown?.tabId != null) items.push(separator(), menuItem('Close Tab', 'close', { 'data-tab-id': String(shown.tabId) }));
      return items;
    }
    if (tabId == null) return [];
    menuFor = { tabId };
    const items = [menuItem('Pin Tab', 'pin')];
    for (const f of spaceFolders()) items.push(menuItem(`Pin to 📁 ${f.name}`, 'pin', { 'data-folder-id': f.id }));
    items.push(menuItem('New Folder with Tab', 'new-folder-tab'));
    const spaceId = state?.tabSpace?.[tabId];
    const others = (state?.spaces ?? []).filter((sp) => sp.id !== spaceId);
    if (others.length) {
      items.push(separator());
      for (const sp of others) items.push(menuItem(`Move to ${sp.emoji} ${sp.name}`, 'move', { 'data-space-id': sp.id }));
    }
    items.push(separator(), menuItem('Close Tab', 'close', { 'data-tab-id': String(tabId) }));
    return items;
  }
  // `above`: its bottom at `y` (the "+" in the bottom bar).
  function showMenu(items, x, y, { above = false } = {}) {
    if (!items.length) return;
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
    // The pointer is in the page's pixels; the menu is placed in the sidebar's.
    const k = hostScale();
    x *= k;
    y *= k;
    if (above) y -= menu.offsetHeight + 6;
    if (inTopLayer) { // at the pointer, kept inside the window
      const view = doc.defaultView;
      menu.style.left = `${Math.max(4, Math.min(x, view.innerWidth * k - menu.offsetWidth - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y, view.innerHeight * k - menu.offsetHeight - 4))}px`;
    } else { // at the pointer, kept inside the sidebar
      const box = root.getBoundingClientRect();
      menu.style.left = `${Math.max(4, Math.min(x - box.left * k, box.width * k - menu.offsetWidth - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(y - box.top * k, box.height * k - menu.offsetHeight - 4))}px`;
    }
    menu.focus({ preventScroll: true }); // keys work; nothing highlighted until hover or ↓/↑
  }
  const openMenu = (row, x, y) => showMenu(menuItems(row), x, y);
  // "+" in the bottom bar: above it.
  function openAddMenu(x, y) {
    menuFor = { add: true };
    showMenu([menuItem('New Folder', 'new-folder'), menuItem('New Space', 'new-space')], x, y, { above: true });
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
    const row = event.target.closest('.tab, .pin, .folder');
    if (!row || !root.contains(row) || event.target.closest('.folder-name')) return closeMenu();
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
    const { folderId } = item.dataset;
    switch (item.dataset.menu) {
      case 'pin': return send('pinTab', { tabId: target.tabId, folderId: folderId ?? null });
      case 'unpin': return send('unpin', { pinId: target.pinId });
      case 'move': return send('moveTabToSpace', { tabId: target.tabId, spaceId: item.dataset.spaceId });
      case 'move-pin': return send('movePin', { pinId: target.pinId, folderId: folderId ?? null });
      case 'new-folder-pin': return newFolder({ pinIds: [target.pinId] });
      case 'new-folder-tab': return newFolder({ tabId: target.tabId });
      case 'new-folder': return newFolder();
      case 'new-space': return newSpace();
      case 'rename-folder': return startRename(target.folderId);
      case 'toggle-folder': {
        const folder = state?.folders?.find((f) => f.id === target.folderId);
        return folder && send('setFolderOpen', { folderId: folder.id, open: folder.open === false });
      }
      case 'delete-folder': return send('deleteFolder', { folderId: target.folderId });
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

  // ---- drag and drop ----------------------------------------------------------
  // Tabs, pins and folders drag. A tab dropped on a space in the bottom bar
  // moves there. In the list: a pin or tab dropped on a folder goes into it
  // (a tab gets pinned there); between rows, before or after that row (a tab
  // gets pinned in that place; folders stay at the top level); a pin dropped
  // on the tabs is unpinned (its tab stays open, as a tab).

  let dragging = null; // { kind: 'tab' | 'pin' | 'folder', id }
  const MARKS = ['drop-before', 'drop-after', 'drop-into', 'drop-target', 'drop-end', 'drop-unpin'];
  const clearDrop = () => {
    for (const node of root.querySelectorAll(MARKS.map((m) => `.${m}`).join(', '))) node.classList.remove(...MARKS);
  };
  root.addEventListener('dragstart', (event) => {
    const row = event.target.closest?.('.tab, .pin, .folder');
    if (!row || !root.contains(row)) return;
    if (renaming) return event.preventDefault();
    if (row.classList.contains('tab')) dragging = { kind: 'tab', id: Number(row.dataset.tabId) };
    else if (row.classList.contains('pin')) dragging = { kind: 'pin', id: row.dataset.pinId };
    else dragging = { kind: 'folder', id: row.dataset.folderId };
    event.dataTransfer.setData({ tab: TAB_MIME, pin: PIN_MIME, folder: FOLDER_MIME }[dragging.kind], String(dragging.id));
    event.dataTransfer.effectAllowed = 'move';
    root.dataset.dragging = dragging.kind; // an empty pinned area shows where a tab can go
    // A redraw mid-drag (a tab's title changing) replaces the row: its
    // dragend then never reaches the sidebar, so it's listened for here too.
    row.addEventListener('dragend', endDrag, { once: true });
  });
  const endDrag = () => {
    dragging = null;
    delete root.dataset.dragging;
    clearDrop();
  };
  root.addEventListener('dragend', endDrag);

  // The ids at a level of the pinned area, in order (null: the top level).
  function levelIds(folderId) {
    const pinned = lastView?.pinned ?? [];
    if (!folderId) return pinned.map((item) => item.id);
    return pinned.find((item) => item.id === folderId)?.pins.map((p) => p.id) ?? [];
  }
  // The id after `id` at its level, not counting what's being dragged.
  const after = (folderId, id) => {
    const ids = levelIds(folderId).filter((x) => x !== dragging?.id);
    return ids[ids.indexOf(id) + 1] ?? null;
  };
  // Where a drop at this point would go: { chip } | { unpin } |
  // { into: folderId, row } | { folderId, beforeId, row, side } (row null:
  // the end of the top level), or null.
  function dropTarget(event) {
    if (!dragging || !state) return null;
    const target = /** @type {HTMLElement} */ (event.target);
    const chip = /** @type {HTMLElement | null} */ (target.closest?.('.chip[data-space-id]'));
    if (chip) return dragging.kind === 'tab' ? { chip } : null;
    if (target.closest?.('.tabs') || target === listDivider) return dragging.kind === 'pin' ? { unpin: true } : null;
    if (!target.closest?.('.pins-section')) return null;
    let row = /** @type {HTMLElement | null} */ (target.closest('.pin, .folder'));
    // The gap between rows, or a nested row's indent: the row below (so
    // before it); below the last row, the end of the top level.
    if (!row) row = /** @type {HTMLElement | null} */ ([...pins.children].find((r) => event.clientY <= r.getBoundingClientRect().bottom + 2.5) ?? null);
    if (!row) return { folderId: null, beforeId: null, row: null };
    const box = row.getBoundingClientRect();
    const y = (event.clientY - box.top) / box.height;
    if (row.classList.contains('folder')) {
      const folderId = row.dataset.folderId;
      if (dragging.kind === 'folder') {
        if (folderId === dragging.id) return null;
        if (y < 0.5) return { folderId: null, beforeId: folderId, row, side: 'before' };
        // After an open folder: after its pins (the line under its last one).
        const last = /** @type {HTMLElement | undefined} */ ([...pins.querySelectorAll(`.pin.nested[data-folder-id="${folderId}"]`)].at(-1));
        return { folderId: null, beforeId: after(null, folderId), row: last ?? row, side: 'after' };
      }
      // Its top edge: before it; the rest: into it (Arc).
      if (y < 0.25) return { folderId: null, beforeId: folderId, row, side: 'before' };
      return { into: folderId, row };
    }
    const pinId = row.dataset.pinId;
    const level = row.dataset.folderId || null;
    if (dragging.kind === 'folder' && level) return null; // folders stay at the top level
    if (dragging.kind === 'pin' && pinId === dragging.id) return null;
    return y < 0.5 ? { folderId: level, beforeId: pinId, row, side: 'before' } : { folderId: level, beforeId: after(level, pinId), row, side: 'after' };
  }
  root.addEventListener('dragover', (event) => {
    const where = dropTarget(event);
    clearDrop();
    if (!where) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (where.chip) where.chip.classList.add('drop-target');
    else if (where.unpin) tabs.classList.add('drop-unpin');
    else if (where.into) where.row.classList.add('drop-into');
    else if (where.row) where.row.classList.add(where.side === 'before' ? 'drop-before' : 'drop-after');
    else pins.classList.add('drop-end');
  });
  root.addEventListener('dragleave', (event) => {
    if (!root.contains(/** @type {Node | null} */ (event.relatedTarget))) clearDrop();
  });
  root.addEventListener('drop', (event) => {
    const where = dropTarget(event);
    const what = dragging;
    endDrag();
    if (!where || !what) return;
    event.preventDefault();
    if (where.chip) return send('moveTabToSpace', { tabId: what.id, spaceId: where.chip.dataset.spaceId });
    if (where.unpin) return send('unpin', { pinId: what.id });
    const folderId = where.into ?? where.folderId ?? null;
    const beforeId = where.into ? null : where.beforeId ?? null;
    if (what.kind === 'tab') return send('pinTab', { tabId: what.id, folderId, beforeId });
    if (what.kind === 'pin') return send('movePin', { pinId: what.id, folderId, beforeId });
    return send('moveFolder', { folderId: what.id, beforeId });
  });

  return {
    el: root,
    // While editing, renaming or dragging, the overlay shouldn't auto-hide.
    closeMenu: () => closeMenu(),
    isBusy: () => editing != null || renaming != null || pendingRename != null || dragging != null || resizing != null || swiping != null || !menu.hidden,
    width: () => (resizing ? resizing.width : sidebarWidth(state?.settings)),
    update(nextState, context) {
      if (context?.fit) fit = context.fit;
      if (context && 'newTabPending' in context) newTabPending = !!context.newTabPending;
      if (context && 'switchingTo' in context) switchingTo = context.switchingTo ?? null;
      if (context && 'justShown' in context) justShown = !!context.justShown;
      state = nextState;
      // The swiped-to space has arrived (or never will: the switch failed).
      if (shownSpace && (V.activeSpaceId(state, windowId) === shownSpace || Date.now() - shownSince > SHOWN_SPACE_MS)) {
        shownSpace = null;
        clearTimeout(shownTimer);
      }
      if (menuFor?.tabId != null && !state.tabs?.[menuFor.tabId]) closeMenu(); // its tab is gone
      if (menuFor?.pinId && !state.pins?.some((p) => p.id === menuFor.pinId)) closeMenu();
      if (menuFor?.folderId && !state.folders?.some((f) => f.id === menuFor.folderId)) closeMenu();
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
      if (pendingRename && state.folders?.some((f) => f.id === pendingRename)) {
        const folderId = pendingRename;
        pendingRename = null;
        startRename(folderId);
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
