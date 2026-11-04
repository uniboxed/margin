// Arcadia's sidebar: space chips, pins, tabs, the space editor and the
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
  const swap = () => {
    img.closest('li')?.setAttribute('data-icon-broken', ''); // drawn again next time (sidebar draw: keyed)
    img.replaceWith(letterAvatar(doc, img.dataset.label || '?'));
  };
  if (img.complete && img.src && !img.naturalWidth) swap();
  else img.addEventListener('error', swap, { once: true });
}

const SPACE_COLORS = ['#6c5ce7', '#0984e3', '#00b894', '#fdcb6e', '#e17055', '#d63031', '#e84393', '#636e72'];

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
  const top = el(doc, 'header', { class: 'top' }, mode === 'overlay' ? keepOpen : null, el(doc, 'span', { class: 'spacer' }));
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
  const warmUp = createWarmUpNote(doc, () => send('warmUpStop'));
  const root = el(doc, 'aside', { class: `margin-sidebar ${mode}`, 'aria-label': 'Margin' },
    top,
    pane,
    warmUp.el,
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
  // The width is one of Arcadia's own settings.
  const saveWidth = (sidebarWidth) => send('updateThemeSettings', { themeId: 'arcadia', patch: { sidebarWidth } });
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
  let newTabPending = false; // a new tab being chosen in the palette: "+ New Tab" highlighted
  let switchingTo = null; // a tab being switched to: highlighted already
  // A folder's name being edited in place ({ folderId, draft }), and a just-
  // created folder to edit once it arrives (as pendingEdit).
  let renaming = null;
  let pendingRename = null;
  let rendering = false; // the rename field leaves the DOM while redrawing: not a blur
  // A space this sidebar shows before the state says so (just swiped to;
  // the background is switching), when that started, and the tab its switch
  // brings (null: none, this page's own space or an empty one).
  let shownSpace = null;
  let shownSince = 0;
  let shownWith = null;
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
      'aria-label': p.title, // no tooltip (Arc)
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
    if (!folder) return;
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
      // Through a redraw: the row pressed, rows a dropped copy is gliding into.
      if (pressedKey) rowFor(pressedKey)?.classList.add('pressed');
      for (const key of gliding) rowFor(key)?.classList.add('landing');
    } finally {
      rendering = false;
    }
    if (dragging) moveDrag(dragging.x, dragging.y); // its drop line on the rows drawn now
    land();
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
  // ---- rows drawn again only when what they show changed --------------------
  // Each row (tab, pin, folder, "+ New Tab") is kept by its key with what it
  // was drawn from; a draw reuses the ones whose inputs are the same, builds
  // the others as before, and moves only what's out of place. An unchanged
  // row keeps its picture (no icon loaded again), its hover and its press.
  // Not for the still pictures of a swipe's neighbours (drawn into the same
  // lists, then copied): those are built afresh and kept nowhere.
  // The rows of the last SPACES_KEPT spaces drawn are kept, not only the
  // space's on screen: a page draws the space it asks for at once (a swipe,
  // a space's icon) as it goes, and its own space's rows are there again
  // when it's shown again (or a space is switched back to), rather than all
  // built anew.
  const SPACES_KEPT = 3;
  /** @type {Map<string, { el: HTMLElement, from: any[] }>} */
  const rowCache = new Map();
  const usedKeys = new Set();
  /** @type {Map<string, Set<string>>} */
  const keysBySpace = new Map(); // space → the keys its last draw used, the space drawn last at the end
  /** @type {Map<string, any[]>} */
  const drawnFrom = new Map(); // the space title's and the chips'
  const sameFrom = (a, b) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);
  function changed(part, from) {
    if (sameFrom(drawnFrom.get(part), from)) return false;
    drawnFrom.set(part, from);
    return true;
  }
  /** @param {string} key @param {any[]} from @param {() => HTMLElement} build */
  function keyed(key, from, build) {
    if (drawingGhosts) return build();
    if (usedKeys.has(key)) return build(); // twice in one draw (never expected): its own row
    usedKeys.add(key);
    const kept = rowCache.get(key);
    // Not one whose icon didn't load: the next draw tries it again, as before.
    if (kept && sameFrom(kept.from, from) && !kept.el.hasAttribute('data-icon-broken')) {
      // Out of the lists since it was drawn (another space's): nothing of a
      // press, a drop or a landing it had then (render marks what's current).
      if (!kept.el.isConnected) kept.el.classList.remove('pressed', 'instant', 'landing', ...MARKS);
      return kept.el;
    }
    const row = build();
    rowCache.set(key, { el: row, from });
    return row;
  }
  // `list`'s children are `rows`, in order, moving only what's out of place.
  function place(list, rows) {
    let at = list.firstChild;
    for (const row of rows) {
      if (row === at) {
        at = at.nextSibling;
        continue;
      }
      list.insertBefore(row, at);
    }
    while (at) {
      const next = at.nextSibling;
      at.remove();
      at = next;
    }
  }
  /** @param {string} spaceId */
  function forgetUnused(spaceId) {
    if (drawingGhosts) return;
    keysBySpace.delete(spaceId);
    keysBySpace.set(spaceId, new Set(usedKeys));
    for (const space of keysBySpace.keys()) {
      if (keysBySpace.size <= SPACES_KEPT) break;
      keysBySpace.delete(space);
    }
    const kept = [...keysBySpace.values()];
    for (const key of rowCache.keys()) if (!kept.some((keys) => keys.has(key))) rowCache.delete(key);
    usedKeys.clear();
  }
  const pinFrom = (p, nested) => [nested, p.active, p.behind, p.tabId, p.folderId, p.title, p.url, V.iconFor(state, p)];
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
    if (changed('title', [space?.emoji ?? '', space?.name ?? ''])) spaceTitle.replaceChildren(
      el(doc, 'span', { class: 'emoji', 'aria-hidden': 'true', text: space?.emoji ?? '' }),
      el(doc, 'span', { class: 'title', text: space?.name ?? '' }),
    );

    if (changed('chips', [view.spaceId, ...view.spaces.flatMap((s) => [s.id, s.name, s.emoji, s.color])])) chips.replaceChildren(
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
    // Each row from everything its builder reads.
    const pinRows = [];
    for (const item of view.pinned) {
      if (item.kind !== 'folder') {
        pinRows.push(keyed(`pin:${item.id}`, pinFrom(item, false), () => pinRow(item, false)));
        continue;
      }
      pinRows.push(keyed(`folder:${item.id}`, [item.name, item.open, renaming?.folderId === item.id], () => folderRow(item)));
      for (const p of item.open ? item.pins : item.peek) pinRows.push(keyed(`pin:${p.id}`, pinFrom(p, true), () => pinRow(p, true)));
    }
    place(pins, pinRows);
    listDivider.hidden = !view.pinned.length;

    // Arc: "+ New Tab" above the tabs, highlighted like a tab while the
    // new-tab page is shown (⌘T); it opens the palette.
    const newTabRow = keyed('new-tab', [view.newTab.active, view.newTab.behind], () => el(doc, 'li', {
      class: `new-tab-row${view.newTab.active ? ' active' : ''}${view.newTab.behind ? ' behind' : ''}`,
      'data-action': 'new-tab',
      role: 'button',
      'aria-label': 'New Tab',
      'aria-current': view.newTab.active ? 'page' : null,
    }, el(doc, 'span', { class: 'plus', 'aria-hidden': 'true' }, ICONS.plus(doc)), el(doc, 'span', { class: 'title', text: 'New Tab' })));
    place(tabs, [
      newTabRow,
      ...view.tabs.map((t) => keyed(`tab:${t.id}`, [t.active, t.behind, t.title, t.url, V.iconFor(state, t)], () =>
        el(doc, 'li', {
          class: `tab${t.active ? ' active' : ''}${t.behind ? ' behind' : ''}`,
          'data-action': 'activate',
          'data-tab-id': String(t.id),
          'aria-label': t.title || t.url || 'New Tab',
        },
        avatar(doc, { ...t, favIconUrl: V.iconFor(state, t) }),
        el(doc, 'span', { class: 'title', text: t.title || t.url || 'New Tab' }),
        closeButton(t.id, 'Close tab')))),
    ]);
    forgetUnused(view.spaceId);

    const pinned = !!state.settings?.sidebarPinnedOpen;
    keepOpen.title = pinned ? 'Auto-hide the sidebar' : 'Keep the sidebar open';
    keepOpen.setAttribute('aria-label', keepOpen.title);
    keepOpen.setAttribute('aria-pressed', String(pinned));

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

  // Open over the page (hovered or toggled): a switch
  // made from it keeps it open on the next page (content/core.js fills in
  // how it was opened; background handlers.js carryOpen).
  const openOverPage = () => mode === 'overlay' && root.classList.contains('open') && !root.classList.contains('docked');

  // The tab a row brings to the front: its own, or an open pin's (in this
  // window first); null for a pin not open.
  const rowTab = (/** @type {HTMLElement} */ row) => (row.dataset.tabId ? Number(row.dataset.tabId)
    : row.classList.contains('open') && state ? V.pinTabId(state, row.dataset.pinId, windowId) : null);
  // A press (Arc): the row shrinks a little while the button is down and
  // springs back as it comes up (sidebar.css .pressed), kept through a redraw
  // (the switch a press starts draws the list again at once). Not on a row's
  // buttons; not with ⌃ (the menu).
  /** @type {string | null} */
  let pressedKey = null;
  root.addEventListener('pointerdown', (event) => {
    releasePress();
    if (event.button !== 0 || event.ctrlKey || !event.isPrimary) return;
    const target = /** @type {Element} */ (event.target);
    if (target.closest?.('.icon, input')) return;
    const row = target.closest?.('.tab, .pin, .folder, .new-tab-row');
    if (!row || !root.contains(row)) return;
    pressedKey = keyOf(row);
    row.classList.add('pressed');
  });
  for (const type of ['pointerup', 'pointercancel']) doc.addEventListener(type, () => releasePress(), true);
  doc.defaultView?.addEventListener('blur', () => releasePress());
  function releasePress({ instant = false } = {}) {
    if (!pressedKey) return;
    const row = rowFor(pressedKey);
    pressedKey = null;
    if (!row) return;
    if (instant) row.classList.add('instant');
    row.classList.remove('pressed');
    if (instant) requestAnimationFrame(() => row.classList.remove('instant'));
  }

  // A tab's row, or a pin's: its tab to the front.
  /** @param {HTMLElement} target */
  function switchRow(target) {
    const show = openOverPage();
    if (target.dataset.action === 'activate') {
      const tabId = Number(target.dataset.tabId);
      if (switchingTo === tabId) return null; // on its way already (a second press)
      const request = send('activateTab', { tabId, ...(show ? { show } : {}) });
      if (!target.classList.contains('active')) onSwitch?.(tabId, request);
      return request;
    }
    const pinTab = rowTab(target);
    if (pinTab != null && switchingTo === pinTab) return null;
    const request = send('openPin', { pinId: target.dataset.pinId, windowId, ...(show ? { show } : {}) });
    if (pinTab != null && !target.classList.contains('active')) onSwitch?.(pinTab, request);
    return request;
  }
  // A press switches (Arc): a tab, or a pin whose tab is open, comes to the
  // front as the mouse button goes down, not once it's back up, and the
  // click that follows does nothing more. Only the main button of a mouse or
  // trackpad, without ⌃ (the Mac's right-click: the menu); not its close
  // button; not a touch or a pen (a press there can be the start of a
  // scroll). A pin not open yet opens on click (pressing it to drag it
  // elsewhere doesn't open it). Each page draws its own sidebar, so a drag
  // that starts on another tab's row ends as that tab comes to the front: a
  // tab drags once it's the one in front (DECISIONS.md): a press that takes
  // this page away (to another tab, or during a switch to one) starts no drag,
  // whatever row the redraw has put under it (the drag would go on in a page
  // no longer shown, with nowhere to drop).
  // A space's icon the same: its space is shown as the button goes down
  // (switchSpace, below).
  let pressed = false; // a press switched: its click is the same switch
  let pressedAway = false; // and this page is on its way out
  root.addEventListener('pointerdown', (event) => {
    pressed = false;
    pressedAway = false;
    if (event.button !== 0 || event.pointerType !== 'mouse' || !event.isPrimary || event.ctrlKey || dragging) return;
    const target = /** @type {HTMLElement | null} */ (event.target.closest?.('[data-action]'));
    if (!target || !root.contains(target)) return;
    const action = target.dataset.action;
    if (action === 'set-space' && target.dataset.spaceId) {
      pressed = true;
      stopHoverWake();
      void switchSpace(target.dataset.spaceId);
      return;
    }
    if (action !== 'activate' && !(action === 'open-pin' && target.classList.contains('open'))) return;
    pressed = true;
    const tab = rowTab(target);
    pressedAway = (tab != null && tab !== currentTabId) || (switchingTo != null && switchingTo !== currentTabId);
    stopHoverWake();
    void switchRow(target);
  });

  root.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target || !root.contains(target)) return;
    event.stopPropagation();
    if (event.ctrlKey && target.closest('.tab, .pin, .folder')) return; // ⌃-click is the Mac's right-click: the menu
    const tabId = Number(target.dataset.tabId);
    const { spaceId, folderId } = target.dataset;
    const show = openOverPage();
    // Switched as it was pressed (above); a click with no press (the
    // keyboard, a script) still switches.
    if ((target.dataset.action === 'activate' || target.dataset.action === 'open-pin' || target.dataset.action === 'set-space') && pressed && event.detail > 0) {
      pressed = false;
      return;
    }
    switch (target.dataset.action) {
      case 'activate':
      case 'open-pin':
        return switchRow(target);
      case 'close': return send('closeTab', { tabId, ...(show ? { show } : {}) });
      case 'toggle-folder': {
        if (event.detail > 1) return; // the second click of a double-click (renames)
        const folder = state?.folders?.find((f) => f.id === folderId);
        if (!folder) return;
        lastToggle = { folderId, wasOpen: folder.open !== false, at: Date.now() };
        return send('setFolderOpen', { folderId, open: folder.open === false });
      }
      case 'set-space': return switchSpace(spaceId);
      case 'new-tab': return onNewTab ? onNewTab() : send('newTab', { windowId });
      case 'archive': return onArchive ? onArchive() : send('openLauncher', { windowId });
      case 'add-menu': {
        const box = target.getBoundingClientRect();
        return openAddMenu(box.left, box.top);
      }
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
  // On a page, only while the sidebar is out.
  const swipeUsable = () => mode !== 'overlay' || root.classList.contains('open');
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
    swiping = { neighbours, ghosts, width: box.width * k, offset: 0, frame: 0, settling: false, committed: false, woken: {} };
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
    // Heading for a space: the tab its switch shows is woken, once (prewakeSpace, below).
    const toward = offset > 0 ? -1 : offset < 0 ? 1 : 0;
    if (toward && swiping.neighbours[toward] && !swiping.woken[toward]) {
      swiping.woken[toward] = true;
      prewakeSpace(swiping.neighbours[toward], { hover: true, why: 'space' });
    }
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
      s.committed = true;
      askSpace(s.neighbours[dir]);
    }
    setTimeout(() => {
      if (swiping === s) endSwipe();
    }, SETTLE_MS);
  }
  // A space asked for (swiped to, its icon pressed or clicked): the window
  // switches to it, and this sidebar shows it at once.
  function askSpace(spaceId) {
    onScroll?.(0); // the window's list position: the new space from its top (saved with the switch)
    // Asked from the sidebar out over the page: it stays out on the page
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
    showSpaceNow(spaceId, switchingTo);
    return request;
  }
  // A space's icon, pressed with the mouse (above) or clicked otherwise (the
  // keyboard): as a swipe to it, drawn now, from its top (a swipe's is drawn
  // as it settles: endSwipe). Its own space, with no switch away under way:
  // only the window's space, as before (a held key may have left the
  // sidebar on another).
  function switchSpace(spaceId) {
    if (!state || windowId == null || !state.spaces.some((x) => x.id === spaceId)) return null;
    if (state.tabSpace[currentTabId] === spaceId && switchingTo == null && V.activeSpaceId(viewState(), windowId) === spaceId) {
      return send('setSpace', { windowId, spaceId });
    }
    const request = askSpace(spaceId);
    render();
    if (tabsSection.scrollTop !== 0) {
      settingScroll = true; // not a scroll of the user's
      tabsSection.scrollTop = 0;
    }
    return request;
  }
  // This sidebar shows the space until the state does; if it never does
  // (the switch failed), back to the state's after SHOWN_SPACE_MS, or once
  // the switch bringing `tabId` is over (update).
  function showSpaceNow(spaceId, tabId = null) {
    shownSpace = spaceId;
    shownSince = Date.now();
    shownWith = tabId;
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
  // (background/tabs.js wakeTab), so a click switches with nothing left to
  // wait for. Resting HOVER_WAKE_MS on a row starts it (a pointer only
  // passing over rows wakes nothing: each wake can resume a process Safari
  // suspended), once: its hold runs 2 s (background/tabs.js
  // HOVER_KEEP_AWAKE_MS) and nothing renews it. The same for a space's icon
  // (its most recent tab, the one its switch shows), a swipe toward a space,
  // and the sidebar coming out over the page (the tab used before this one:
  // `revealed`). `why`, for the switch log: what asked.
  const HOVER_WAKE_MS = 150;
  let hoverWake = null; // { key, timer }
  // `how`: { hover, why } for the pointer resting on it; a press otherwise.
  const prewakeRow = (row, how = { why: 'press' }) => {
    if (!row?.isConnected || row.classList.contains('active')) return;
    if (row.dataset.tabId) send('prewake', { tabId: Number(row.dataset.tabId), ...how });
    else if (row.dataset.pinId && row.classList.contains('open')) send('prewake', { pinId: row.dataset.pinId, windowId, ...how });
  };
  // The tab a space's switch would show (navigation.js showSpace: its most
  // recent tab in this window), none for the space shown.
  const prewakeSpace = (spaceId, how) => {
    if (!state || !spaceId || spaceId === V.activeSpaceId(viewState(), windowId)) return;
    const tab = recentTabOf(spaceId);
    if (tab && tab.id !== currentTabId) send('prewake', { tabId: tab.id, ...how });
  };
  const stopHoverWake = () => {
    if (hoverWake) clearTimeout(hoverWake.timer);
    hoverWake = null;
  };
  root.addEventListener('pointerover', (event) => {
    const row = event.target.closest?.('.tab, .pin, .chip[data-space-id]');
    const key = !row || !root.contains(row) ? null
      : row.dataset.tabId ? `tab:${row.dataset.tabId}` : row.dataset.pinId ? `pin:${row.dataset.pinId}` : row.dataset.spaceId ? `space:${row.dataset.spaceId}` : null;
    if (key && hoverWake?.key === key) return;
    stopHoverWake();
    if (!key || dragging) return;
    // Found again by its id: a redraw (another tab's title changing) replaces the row.
    const selector = row.dataset.tabId ? `.tab[data-tab-id="${row.dataset.tabId}"]` : row.dataset.pinId ? `.pin[data-pin-id="${CSS.escape(row.dataset.pinId)}"]` : null;
    const spaceId = row.dataset.spaceId ?? null;
    const wake = { key, timer: null };
    hoverWake = wake;
    wake.timer = setTimeout(() => {
      if (hoverWake !== wake || doc.hidden) return;
      if (selector) prewakeRow(root.querySelector(selector), { hover: true, why: 'hover' });
      else prewakeSpace(spaceId, { hover: true, why: 'space' });
    }, HOVER_WAKE_MS);
  });
  root.addEventListener('pointermove', () => freshHover(), { passive: true });
  root.addEventListener('pointerleave', stopHoverWake);
  root.addEventListener('click', stopHoverWake, true); // a switch: the page goes
  root.addEventListener('pointerdown', (event) => {
    if (pressed || event.button !== 0 || event.ctrlKey || event.target.closest('.icon')) return; // pressed: switching already
    const row = event.target.closest('.tab, .pin, .chip[data-space-id]');
    if (!row || !root.contains(row)) return;
    if (row.dataset.spaceId) prewakeSpace(row.dataset.spaceId, { why: 'press' });
    else prewakeRow(row);
  });
  // The sidebar out over the page (hovered at the window's edge, or toggled):
  // the tab most likely chosen next, the one used before this one in the
  // space shown, is woken. Not as a page is shown with it already out.
  function revealed() {
    if (doc.hidden || !state || windowId == null) return;
    const spaceId = V.activeSpaceId(viewState(), windowId);
    const tab = Object.values(state.tabs ?? {})
      .filter((t) => t.windowId === windowId && state.tabSpace[t.id] === spaceId && t.id !== currentTabId)
      .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))[0];
    if (tab) send('prewake', { tabId: tab.id, hover: true, why: 'reveal' });
  }
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
      if (!spaceId) return;
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
      return closeMenu();
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

  // ---- drag and drop (Arc) ----------------------------------------------------
  // Tabs, pins and folders drag. A tab dropped on a space in the bottom bar
  // moves there; between tabs, it goes there (Safari's tab order follows). In
  // the pinned area: a pin or tab dropped on a folder goes into it (a tab
  // gets pinned there); between rows, before or after that row (a tab gets
  // pinned in that place; folders stay at the top level); a pin dropped on the
  // tabs is unpinned (its tab stays open, as a tab).
  // As Arc does it: the row stays where it is and a copy of it follows the
  // pointer (`ghost`); a line in the space's color, a ring at its start, shows
  // where it goes. Let go, the copy waits there for the list's new order and
  // glides into the row's new place while the rows around it slide to theirs;
  // nowhere to go (or Escape), it glides back. The pointer's own events, not
  // the browser's drag and drop: that can't animate the drop, and its picture
  // of the row vanishes as it's dropped.
  const DRAG_START_PX = 4; // the pointer moved this far with the button down: a drag
  const GLIDE_MS = 300; // the copy into its place (Arc: ~0.3 s)
  const SLIDE_MS = 180; // the rows around it to theirs
  const LAND_WAIT_MS = 1200; // the new order not here by then: back where it was
  const EDGE_PX = 36; // the list scrolls with the pointer this close to its edge
  /** @type {{ kind: 'tab' | 'pin' | 'folder', id: number | string, key: string, pointerId: number, x: number, y: number, row: HTMLElement } | null} */
  let pendingDrag = null; // pressed, not moved far enough yet
  /** @type {{ kind: 'tab' | 'pin' | 'folder', id: number | string, key: string, pointerId: number, ghost: HTMLElement, grabX: number, grabY: number, x: number, y: number, where: any } | null} */
  let dragging = null;
  /** @type {{ ghost: HTMLElement, key: string | null, newPin: Set<string> | null, before: Map<string, DOMRect>, from: string, timer: ReturnType<typeof setTimeout> } | null} */
  let landing = null; // dropped: the copy waiting for the new order
  const gliding = new Set(); // rows a copy is gliding into (hidden until it's there)
  const MARKS = ['drop-before', 'drop-after', 'drop-into', 'drop-target', 'drop-end', 'drop-unpin'];
  const clearDrop = () => {
    for (const node of root.querySelectorAll(MARKS.map((m) => `.${m}`).join(', '))) node.classList.remove(...MARKS);
  };
  function keyOf(/** @type {Element} */ row) {
    return row.classList.contains('tab') ? `tab:${/** @type {HTMLElement} */ (row).dataset.tabId}`
      : row.classList.contains('pin') ? `pin:${/** @type {HTMLElement} */ (row).dataset.pinId}`
      : row.classList.contains('folder') ? `folder:${/** @type {HTMLElement} */ (row).dataset.folderId}`
      : row.classList.contains('new-tab-row') ? 'new-tab' : null;
  }
  function rowFor(/** @type {string} */ key) {
    if (key === 'new-tab') return /** @type {HTMLElement | null} */ (tabs.querySelector('.new-tab-row'));
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const attr = kind === 'tab' ? 'tab-id' : kind === 'pin' ? 'pin-id' : 'folder-id';
    return /** @type {HTMLElement | null} */ (root.querySelector(`.${kind}[data-${attr}="${CSS.escape(id)}"]:not(.drag-ghost)`));
  }
  const allRows = () => /** @type {HTMLElement[]} */ ([...root.querySelectorAll('.pins > .pin, .pins > .folder, .tabs > .tab')]);
  // A point of the page in the sidebar's own px (its box: relative to it).
  const local = (/** @type {number} */ x, /** @type {number} */ y) => {
    const box = root.getBoundingClientRect();
    const k = hostScale();
    return { x: (x - box.left) * k - root.clientLeft, y: (y - box.top) * k - root.clientTop };
  };

  root.addEventListener('pointerdown', (event) => {
    pendingDrag = null;
    if (event.button !== 0 || event.ctrlKey || !event.isPrimary || dragging || landing || renaming) return;
    if (pressedAway) return; // this page is on its way out (a press switches, above)
    const target = /** @type {Element} */ (event.target);
    if (target.closest?.('.icon, input, .folder-name')) return;
    const row = /** @type {HTMLElement | null} */ (target.closest?.('.tab, .pin, .folder'));
    if (!row || !root.contains(row)) return;
    const key = keyOf(row);
    if (!key) return;
    const kind = /** @type {'tab' | 'pin' | 'folder'} */ (key.slice(0, key.indexOf(':')));
    const id = kind === 'tab' ? Number(row.dataset.tabId) : kind === 'pin' ? row.dataset.pinId : row.dataset.folderId;
    pendingDrag = { kind, id, key, pointerId: event.pointerId, x: event.clientX, y: event.clientY, row };
  });
  root.addEventListener('pointermove', (event) => {
    // No button down any more: its release went elsewhere (another page, another app).
    if (dragging && event.pointerId === dragging.pointerId) return event.buttons & 1 ? moveDrag(event.clientX, event.clientY) : cancelDrag();
    if (!pendingDrag || event.pointerId !== pendingDrag.pointerId) return;
    if (!(event.buttons & 1)) return void (pendingDrag = null);
    const k = hostScale();
    if (Math.hypot(event.clientX - pendingDrag.x, event.clientY - pendingDrag.y) * k < DRAG_START_PX) return;
    startDrag(event);
  });
  root.addEventListener('pointerup', (event) => {
    if (dragging && event.pointerId === dragging.pointerId) drop(event.clientX, event.clientY);
    pendingDrag = null;
  });
  root.addEventListener('pointercancel', () => {
    pendingDrag = null;
    if (dragging) cancelDrag();
  });
  root.addEventListener('lostpointercapture', () => { if (dragging) cancelDrag(); });
  // The page hidden or left mid-drag (a key switching tabs, ⌘Tab): over.
  const dropEverything = () => {
    pendingDrag = null;
    if (dragging) cancelDrag();
  };
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) dropEverything(); });
  doc.defaultView?.addEventListener('blur', dropEverything);
  doc.defaultView?.addEventListener('pagehide', dropEverything);
  doc.addEventListener('keydown', (event) => {
    if (dragging && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelDrag();
    }
  }, true);

  /** @param {PointerEvent} event */
  function startDrag(event) {
    const from = pendingDrag;
    pendingDrag = null;
    if (!from) return;
    const row = from.row.isConnected ? from.row : rowFor(from.key); // redrawn meanwhile
    if (!row) return;
    stopHoverWake();
    releasePress({ instant: true });
    const box = row.getBoundingClientRect();
    const k = hostScale();
    const at = local(box.left, box.top);
    const ghost = /** @type {HTMLElement} */ (row.cloneNode(true));
    ghost.classList.remove('pressed', 'nested', ...MARKS);
    ghost.classList.add('drag-ghost');
    ghost.removeAttribute('data-action');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.left = `${at.x}px`;
    ghost.style.top = `${at.y}px`;
    ghost.style.width = `${box.width * k}px`;
    root.append(ghost);
    dragging = { kind: from.kind, id: from.id, key: from.key, pointerId: from.pointerId, ghost, grabX: (from.x - box.left) * k, grabY: (from.y - box.top) * k, x: event.clientX, y: event.clientY, where: null };
    root.dataset.dragging = from.kind; // an empty pinned area shows where a tab can go
    // Its moves and its release come here wherever the pointer goes (and the
    // click after it lands on the sidebar itself: no row's action).
    try { root.setPointerCapture(from.pointerId); } catch {}
    moveDrag(event.clientX, event.clientY);
  }

  function moveDrag(/** @type {number} */ x, /** @type {number} */ y) {
    if (!dragging) return;
    dragging.x = x;
    dragging.y = y;
    const at = local(x, y);
    dragging.ghost.style.transform = `translate(${at.x - dragging.grabX - parseFloat(dragging.ghost.style.left)}px, ${at.y - dragging.grabY - parseFloat(dragging.ghost.style.top)}px)`;
    const under = /** @type {Element | null} */ (/** @type {Document | ShadowRoot} */ (root.getRootNode()).elementFromPoint(x, y));
    const where = under && root.contains(under) ? dropTarget({ target: under, clientY: y }) : null;
    dragging.where = where;
    clearDrop();
    if (where?.chip) where.chip.classList.add('drop-target');
    else if (where?.unpin) tabs.classList.add('drop-unpin');
    else if (where?.into) where.row.classList.add('drop-into');
    else if (where?.row) where.row.classList.add(where.side === 'before' ? 'drop-before' : 'drop-after');
    else if (where) pins.classList.add('drop-end');
    autoScroll();
  }

  // Near the top or bottom of the list, it scrolls (faster nearer the edge).
  let scrolling = 0;
  function autoScroll() {
    if (scrolling || !dragging) return;
    const step = () => {
      scrolling = 0;
      if (!dragging) return;
      const box = tabsSection.getBoundingClientRect();
      const k = hostScale();
      const top = (dragging.y - box.top) * k, bottom = (box.bottom - dragging.y) * k;
      if (top < 0 || bottom < 0 || dragging.x < box.left || dragging.x > box.right) return; // not over the list
      const speed = top < EDGE_PX ? -(EDGE_PX - top) / 2 : bottom < EDGE_PX ? (EDGE_PX - bottom) / 2 : 0;
      if (!speed) return;
      const before = tabsSection.scrollTop;
      tabsSection.scrollTop += Math.max(-16, Math.min(16, speed));
      if (tabsSection.scrollTop === before) return;
      moveDrag(dragging.x, dragging.y);
      scrolling = requestAnimationFrame(step);
    };
    scrolling = requestAnimationFrame(step);
  }

  function endDrag() {
    const ended = dragging;
    dragging = null;
    delete root.dataset.dragging;
    clearDrop();
    if (scrolling) cancelAnimationFrame(scrolling);
    scrolling = 0;
    try { if (ended) root.releasePointerCapture(ended.pointerId); } catch {}
    return ended;
  }
  function cancelDrag() {
    const ended = endDrag();
    if (ended) glideBack(ended.ghost, ended.key);
  }

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
  // the end of the top level) | { tab: id, row, side } (between tabs), or null.
  /** @param {{ target: Element, clientY: number }} point */
  function dropTarget(point) {
    if (!dragging || !state) return null;
    const target = /** @type {HTMLElement} */ (point.target);
    const chip = /** @type {HTMLElement | null} */ (target.closest?.('.chip[data-space-id]'));
    if (chip) return dragging.kind === 'tab' && chip.dataset.spaceId !== lastView?.spaceId ? { chip } : null;
    if (target.closest?.('.tabs') || target === listDivider) {
      if (dragging.kind === 'pin') return { unpin: true };
      if (dragging.kind !== 'tab') return null;
      // Between tabs: before or after the tab under the pointer (the gap
      // between rows, or below the last one: the nearest).
      const rows = /** @type {HTMLElement[]} */ ([...tabs.querySelectorAll(':scope > .tab')]);
      const row = /** @type {HTMLElement | null} */ (target.closest('.tab')) ?? rows.find((r) => point.clientY <= r.getBoundingClientRect().bottom + 2.5) ?? rows.at(-1) ?? null;
      if (!row) return null;
      const box = row.getBoundingClientRect();
      const side = (point.clientY - box.top) / box.height < 0.5 ? 'before' : 'after';
      const id = Number(row.dataset.tabId);
      // Where it is already: nowhere to go.
      const at = rows.indexOf(row), own = rows.findIndex((r) => Number(r.dataset.tabId) === dragging?.id);
      if (id === dragging.id || (side === 'before' && at === own + 1) || (side === 'after' && at === own - 1)) return null;
      return { tab: id, row, side };
    }
    if (!target.closest?.('.pins-section')) return null;
    let row = /** @type {HTMLElement | null} */ (target.closest('.pin, .folder'));
    // The gap between rows, or a nested row's indent: the row below (so
    // before it); below the last row, the end of the top level.
    if (!row) row = /** @type {HTMLElement | null} */ ([...pins.children].find((r) => point.clientY <= r.getBoundingClientRect().bottom + 2.5) ?? null);
    if (!row) return { folderId: null, beforeId: null, row: null };
    const box = row.getBoundingClientRect();
    const y = (point.clientY - box.top) / box.height;
    if (row.classList.contains('folder')) {
      const folderId = row.dataset.folderId;
      if (dragging.kind === 'folder') {
        if (folderId === dragging.id) return null;
        if (y < 0.5) return stays(null, folderId) ? null : { folderId: null, beforeId: folderId, row, side: 'before' };
        // After an open folder: after its pins (the line under its last one).
        const last = /** @type {HTMLElement | undefined} */ ([...pins.querySelectorAll(`.pin.nested[data-folder-id="${folderId}"]`)].at(-1));
        const beforeId = after(null, folderId);
        return stays(null, beforeId) ? null : { folderId: null, beforeId, row: last ?? row, side: 'after' };
      }
      // Its top edge: before it; the rest: into it (Arc).
      if (y < 0.25) return stays(null, folderId) ? null : { folderId: null, beforeId: folderId, row, side: 'before' };
      return dragging.kind === 'pin' && levelIds(folderId).includes(String(dragging.id)) ? null : { into: folderId, row };
    }
    const pinId = row.dataset.pinId;
    const level = row.dataset.folderId || null;
    if (dragging.kind === 'folder' && level) return null; // folders stay at the top level
    if (dragging.kind === 'pin' && pinId === dragging.id) return null;
    const place = y < 0.5 ? { folderId: level, beforeId: pinId, row, side: 'before' } : { folderId: level, beforeId: after(level, pinId), row, side: 'after' };
    return stays(level, place.beforeId) ? null : place;
  }
  // Whether a pin or folder put at this level before `beforeId` stays where it is.
  function stays(/** @type {string | null} */ level, /** @type {string | null} */ beforeId) {
    if (!dragging || dragging.kind === 'tab') return false;
    const ids = levelIds(level);
    const at = ids.indexOf(String(dragging.id));
    return at >= 0 && (ids[at + 1] ?? null) === (beforeId ?? null);
  }

  function drop(/** @type {number} */ x, /** @type {number} */ y) {
    moveDrag(x, y);
    // Where everything was, as it's shown now (the empty pinned area's box
    // too: it stays until the pin is in it): the rows slide from there.
    const before = new Map(allRows().map((row) => [keyOf(row), row.getBoundingClientRect()]));
    if (dragging?.kind === 'tab' && dragging.where && !dragging.where.chip && !dragging.where.unpin && dragging.where.tab == null) root.dataset.landing = 'tab';
    const what = endDrag();
    if (!what) return;
    const where = what.where;
    if (!where) return glideBack(what.ghost, what.key);
    /** @type {string | null} */ let key = what.key;
    let newPin = null;
    if (where.chip) {
      send('moveTabToSpace', { tabId: Number(what.id), spaceId: where.chip.dataset.spaceId });
      return fadeOut(what.ghost); // into another space: not in this list any more
    }
    if (where.unpin) {
      const tabId = lastView?.pinned.flatMap((item) => (item.kind === 'folder' ? item.pins : [item])).find((p) => p.id === what.id)?.tabId;
      send('unpin', { pinId: String(what.id) });
      if (tabId == null) return fadeOut(what.ghost); // not open: gone
      key = `tab:${tabId}`;
    } else if (where.tab != null) {
      const near = state?.tabs?.[where.tab];
      const moving = send('moveTab', { tabId: Number(what.id), nextTo: where.tab, side: where.side, ...(near ? { nextToHint: { url: near.url, index: near.index, title: near.title, from: /** @type {any} */ (state)?.openTabsBy ?? null } } : {}) });
      // Not moved (the browser can't, or keeps that tab apart): back at once.
      void moving.then((moved) => { if (moved !== true && landing?.ghost === what.ghost) giveUpLanding(); });
    } else {
      const folderId = where.into ?? where.folderId ?? null;
      const beforeId = where.into ? null : where.beforeId ?? null;
      if (what.kind === 'tab') {
        send('pinTab', { tabId: Number(what.id), folderId, beforeId });
        key = null; // the new pin's: the one that wasn't there before
        newPin = new Set(allRows().filter((row) => row.classList.contains('pin')).map((row) => row.dataset.pinId));
      } else if (what.kind === 'pin') {
        send('movePin', { pinId: String(what.id), folderId, beforeId });
        // Into a closed folder it isn't shown in (not the tab in front): in, out of sight.
        const shut = where.into && lastView?.pinned.find((item) => item.id === where.into && item.kind === 'folder' && !item.open);
        if (shut && !rowFor(what.key)?.classList.contains('active')) return fadeOut(what.ghost);
      }
      else send('moveFolder', { folderId: String(what.id), beforeId });
    }
    landing = { ghost: what.ghost, key, newPin, before, from: what.key, timer: setTimeout(() => giveUpLanding(), LAND_WAIT_MS) };
  }

  // Each redraw (sidebar draw()): a dropped row's new place, once the list has it.
  function land() {
    if (!landing) return;
    let row = landing.key ? rowFor(landing.key) : null;
    if (!landing.key && landing.newPin) {
      row = /** @type {HTMLElement | null} */ ([...pins.querySelectorAll('.pin')].find((r) => !landing?.newPin?.has(/** @type {HTMLElement} */ (r).dataset.pinId)) ?? null);
    }
    if (!row) return; // not in the list yet (or not any more: given up on later)
    const was = landing.before.get(landing.key ?? '');
    const now = row.getBoundingClientRect();
    if (was && landing.key === landing.from && Math.abs(was.top - now.top) < 0.5) {
      // Still where it was: wait for the order to change (an unrelated redraw).
      const rows = allRows();
      const order = (/** @type {string[]} */ keys) => keys.join(' ');
      if (order(rows.map((r) => keyOf(r) ?? '')) === order([...landing.before.keys()])) return;
    }
    const { ghost, before } = landing;
    clearTimeout(landing.timer);
    landing = null;
    delete root.dataset.landing;
    // The rows around it, from where they were to where they are now.
    const k = hostScale();
    for (const other of allRows()) {
      if (other === row) continue;
      const from = before.get(keyOf(other) ?? '');
      if (!from) continue;
      const dy = (from.top - other.getBoundingClientRect().top) * k;
      if (Math.abs(dy) > 0.5) other.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: SLIDE_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    }
    glideTo(ghost, row);
  }
  function giveUpLanding() {
    if (!landing) return;
    const { ghost, from } = landing;
    clearTimeout(landing.timer);
    landing = null;
    delete root.dataset.landing;
    glideBack(ghost, from);
  }
  // The copy into a row's place, the row shown once it's there.
  function glideTo(/** @type {HTMLElement} */ ghost, /** @type {HTMLElement} */ row) {
    const k = hostScale();
    const g = ghost.getBoundingClientRect(), r = row.getBoundingClientRect();
    // Scrolled out of the list's view: it fades where it is (no flight over the bars).
    const list = tabsSection.getBoundingClientRect();
    if (tabsSection.contains(row) && (r.bottom < list.top || r.top > list.bottom)) return fadeOut(ghost);
    const dx = (r.left - g.left) * k, dy = (r.top - g.top) * k;
    const start = ghost.style.transform || 'none';
    const key = keyOf(row);
    if (key) gliding.add(key);
    row.classList.add('landing');
    const done = () => {
      ghost.remove();
      if (key) gliding.delete(key);
      // The row may have been drawn again meanwhile: the one there now.
      (key ? rowFor(key) : row)?.classList.remove('landing');
      row.classList.remove('landing');
    };
    const end = `${start === 'none' ? '' : start} translate(${dx}px, ${dy}px)`.trim();
    const glide = ghost.animate([{ transform: start, opacity: 0.9 }, { transform: end, opacity: 1 }], { duration: GLIDE_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' });
    glide.onfinish = glide.oncancel = done;
  }
  function glideBack(/** @type {HTMLElement} */ ghost, /** @type {string} */ key) {
    const row = rowFor(key);
    if (row) glideTo(ghost, row);
    else fadeOut(ghost);
  }
  function fadeOut(/** @type {HTMLElement} */ ghost) {
    const start = ghost.style.transform || 'none';
    delete root.dataset.landing;
    const fade = ghost.animate([{ transform: start, opacity: 0.9 }, { transform: `${start === 'none' ? '' : start} scale(0.9)`.trim(), opacity: 0 }], { duration: 180, easing: 'ease-out', fill: 'forwards' });
    fade.onfinish = fade.oncancel = () => ghost.remove();
  }

  return {
    el: root,
    // While editing, renaming or dragging, the overlay shouldn't auto-hide.
    closeMenu: () => closeMenu(),
    isBusy: () => editing != null || renaming != null || pendingRename != null || dragging != null || resizing != null || swiping != null || !menu.hidden,
    width: () => (resizing ? resizing.width : sidebarWidth(state?.settings)),
    update(nextState, context) {
      if (context && 'newTabPending' in context) newTabPending = !!context.newTabPending;
      if (context && 'switchingTo' in context) switchingTo = context.switchingTo ?? null;
      if (context && 'justShown' in context) justShown = !!context.justShown;
      state = nextState;
      // The space asked for has arrived (or never will: the switch failed).
      // Or the switch that brings it is over: this page was left (a page
      // shown again soon after shows its own space, not the one it asked
      // for before it went), or the switch failed. Until the state says so,
      // a page left draws the space before, out of sight. Not while a swipe
      // to it settles: it ends on that space, as its picture slid in.
      if (shownSpace && (V.activeSpaceId(state, windowId) === shownSpace || Date.now() - shownSince > SHOWN_SPACE_MS || (shownWith != null && switchingTo == null && !swiping))) {
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
    // Out over the page just now (themes/arcadia/content.js setLayout).
    revealed,
    // The Mac's Light/Dark appearance ('light' | 'dark').
    setColorScheme(scheme) {
      root.dataset.theme = scheme;
    },
    // The warm-up after a relaunch (background/warm-up.js): its note, or null.
    setWarmUp: warmUp.set,
  };
}

// "Getting your tabs ready", 3 of 6, over the bottom bar while Margin loads
// the tabs likely clicked next after a Safari relaunch (background/warm-up.js).
// Nothing to do with it: it blocks nothing and takes no focus; its × stops
// the warm-up (in the tab order, as the sidebar's other buttons). Drawn
// once, changed in place (never the sidebar drawn again for it). Its words
// are said once by a screen reader as it comes and as it ends (a polite live
// region: the label only, its words put in just after it's shown, which
// WebKit announces); the count is a progress bar. Done: "Tabs ready" for a
// moment, then it fades; stopped, it fades at once (styles/sidebar.css; no
// fade with reduced motion). A last word for a page that wasn't showing it
// (it came to the front since, or its note went for want of news) shows nothing.
const WARM_DONE_MS = 2000;
const WARM_FADE_MS = 200;
/** @param {Document} doc @param {() => void} stop */
function createWarmUpNote(doc, stop) {
  const label = el(doc, 'span', { class: 'warm-label', role: 'status', 'aria-live': 'polite', text: '' });
  const count = el(doc, 'span', { class: 'warm-count', 'aria-hidden': 'true' });
  const fill = el(doc, 'div', { class: 'warm-fill' });
  const bar = el(doc, 'div', { class: 'warm-bar', role: 'progressbar', 'aria-label': 'Getting tabs ready', 'aria-valuemin': '0' }, fill);
  const close = el(doc, 'button', { type: 'button', class: 'warm-stop', title: 'Stop getting tabs ready', 'aria-label': 'Stop getting tabs ready' }, ICONS.close(doc));
  const note = el(doc, 'div', { class: 'warm-note', hidden: true }, el(doc, 'div', { class: 'warm-row' }, label, count, close), bar);
  let timer = null;
  let words = null;
  let drawn = '';
  const hide = (after = 0) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      note.classList.add('leaving');
      timer = setTimeout(() => {
        note.hidden = true;
        note.classList.remove('leaving');
        clearTimeout(words);
        label.textContent = '';
        drawn = '';
      }, WARM_FADE_MS);
    }, after);
  };
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    stop();
    hide();
  });
  return {
    el: note,
    /** @param {{ done: number, total: number, state: string } | null} progress */
    set(progress) {
      if (!progress || !(progress.total > 0)) {
        if (!note.hidden) hide();
        return;
      }
      const done = Math.max(0, Math.min(progress.done, progress.total));
      const key = `${progress.state}:${done}:${progress.total}`;
      if (key === drawn) return;
      const coming = note.hidden || note.classList.contains('leaving');
      drawn = key;
      clearTimeout(timer);
      note.classList.remove('leaving');
      if (progress.state !== 'running' && coming) {
        if (!note.hidden) hide();
        return;
      }
      if (progress.state === 'stopped') return hide();
      const over = progress.state === 'done';
      const text = over ? 'Tabs ready' : 'Getting your tabs ready';
      clearTimeout(words);
      if (coming) {
        label.textContent = '';
        words = setTimeout(() => { label.textContent = text; }, 50);
      } else if (label.textContent !== text) label.textContent = text;
      count.textContent = over ? '' : `${done} of ${progress.total}`;
      bar.setAttribute('aria-valuemax', String(progress.total));
      bar.setAttribute('aria-valuenow', String(over ? progress.total : done));
      fill.style.transform = `scaleX(${over ? 1 : done / progress.total})`;
      note.classList.toggle('over', over);
      note.hidden = false;
      if (over) hide(WARM_DONE_MS);
    },
  };
}

export { avatar, createSidebar };
