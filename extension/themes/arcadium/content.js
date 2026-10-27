// Arcadium on web pages (bundled into themes/arcadium/content.bundle.js, which
// the background registers while Arcadium is the active theme). It runs right
// after Margin's own content script and hands content/core.js what it draws.
import { adoptStyles } from '../../shared/dom.js';
import { registerTheme } from '../register.js';
import { createSidebar } from './sidebar.js';
import { createChrome } from './chrome.js';
import { createPalette } from './palette.js';
import { sidebarCss } from './assets.js';
import theme, { RAIL } from './theme.js';

registerTheme({
  id: theme.id,
  // The frame around the page card (px) and the card's corner radius: core
  // pushes the page and places the fitted layout's card to match. `rail`:
  // the narrow icon sidebar's width, for pages that are pushed.
  geometry: { inset: 8, radius: '6.25px', rail: RAIL },
  createPalette,
  mount({ shadow, document, send, onNewTab, onWidth, onScroll, onSwitch }) {
    const sidebar = createSidebar({ document, send, mode: 'overlay', onNewTab, onWidth, onScroll, onSwitch });
    const chrome = createChrome(document);
    // The switch cover below the sidebar (a hovered sidebar stays on top of it).
    shadow.append(chrome.frame, chrome.cover, sidebar.el, chrome.cardEdge, chrome.loader, chrome.pull, chrome.swipe, chrome.zoomHud, chrome.notice);
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
      // The next change shows at once (a sidebar carried open from the
      // previous page doesn't slide in again).
      instantOnce() {
        for (const node of instant) node.classList.add('instant');
        this.ready();
      },
      setColorScheme(scheme) {
        sidebar.setColorScheme(scheme);
        chrome.setColorScheme(scheme);
      },
      // Hover: a floating card over the page. Keep open: docked, with the
      // frame around the page. `rail` ({ width, expanded }): docked as the
      // narrow icon rail on a pushed page, or expanded from it over the page
      // (the frame stays at the rail).
      setLayout({ open, docked, width, rail = null }) {
        sidebar.el.classList.toggle('open', open);
        sidebar.el.classList.toggle('docked', docked);
        sidebar.el.classList.toggle('rail', !!rail && !rail.expanded);
        sidebar.el.classList.toggle('rail-expanded', !!rail?.expanded);
        if (rail) sidebar.el.style.setProperty('--rail', `${rail.width}px`);
        chrome.setLayout({ docked, width: rail ? rail.width : width });
      },
      setWidth: chrome.setWidth,
      setLoading: chrome.setLoading,
      setCover: chrome.setCover,
      setPull: chrome.setPull,
      setSwipe: chrome.setSwipe,
      setZoom: chrome.setZoom,
      showNotice: chrome.showNotice,
    };
  },
});
