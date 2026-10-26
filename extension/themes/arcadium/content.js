// Arcadium on web pages (bundled into themes/arcadium/content.bundle.js, which
// the background registers while Arcadium is the active theme). It runs right
// after Margin's own content script and hands content/core.js what it draws.
import { adoptStyles } from '../../shared/dom.js';
import { registerTheme } from '../register.js';
import { createSidebar } from './sidebar.js';
import { createChrome } from './chrome.js';
import { createPalette } from './palette.js';
import { sidebarCss } from './assets.js';
import theme from './theme.js';

registerTheme({
  id: theme.id,
  // The frame around the page card (px) and the card's corner radius: core
  // pushes the page and places the fitted layout's card to match.
  geometry: { inset: 8, radius: '6.25px' },
  createPalette,
  mount({ shadow, document, send, onNewTab, onWidth }) {
    const sidebar = createSidebar({ document, send, mode: 'overlay', onNewTab, onWidth });
    const chrome = createChrome(document);
    shadow.append(chrome.frame, sidebar.el, chrome.cardEdge, chrome.loader, chrome.pull, chrome.swipe, chrome.zoomHud, chrome.notice);
    // Styles are bundled (assets.js) and applied synchronously, so the panel
    // is styled from the first frame (no fetch, no unstyled flash).
    adoptStyles(shadow, sidebarCss);
    // No slide/fade on the first render: a kept-open sidebar should simply be
    // there when the page appears, not animate in on every navigation.
    const instant = [sidebar.el, chrome.frame, chrome.cardEdge];
    for (const node of instant) node.classList.add('instant');
    return {
      isBusy: sidebar.isBusy,
      width: sidebar.width,
      update: sidebar.update,
      ready() {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          for (const node of instant) node.classList.remove('instant');
        }));
      },
      setColorScheme(scheme) {
        sidebar.setColorScheme(scheme);
        chrome.setColorScheme(scheme);
      },
      // Hover: a floating card over the page. Keep open: docked, with the
      // frame around the page.
      setLayout({ open, docked, width }) {
        sidebar.el.classList.toggle('open', open);
        sidebar.el.classList.toggle('docked', docked);
        chrome.setLayout({ docked, width });
      },
      setWidth: chrome.setWidth,
      setLoading: chrome.setLoading,
      setPull: chrome.setPull,
      setSwipe: chrome.setSwipe,
      setZoom: chrome.setZoom,
      showNotice: chrome.showNotice,
    };
  },
});
