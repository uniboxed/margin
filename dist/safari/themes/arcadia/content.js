// Arcadia on web pages (bundled into themes/arcadia/content.bundle.js, which
// the background registers while Arcadia is the active theme). It runs right
// after Margin's own content script and hands content/core.js what it draws.
import { adoptStyles, asBrowserUi } from '../../shared/dom.js';
import { registerTheme } from '../register.js';
import { createSidebar } from './sidebar.js';
import { createChrome } from './chrome.js';
import { createPalette } from './palette.js';
import { sidebarCss } from './assets.js';
import theme from './theme.js';

// The room the page has in the window, as --vw and --vh for what's drawn in
// `shadow` (styles/sidebar.css: nothing there is position: fixed). Measured
// from an empty, invisible fixed box the size of the window (what `inset: 0`
// covers: no classic scroll bars), in Margin's own pixels (its host is
// scaled back by the page's zoom), whenever that changes; set in a style
// sheet of the shadow root's own, which the page's styles can't reach.
const SIZED = '.margin-sidebar, .frame, .rims, .card-edge, .switch-cover, .startup-cover, .loader, .pull, .swipe, .notice';
function followWindow(shadow) {
  const doc = shadow.ownerDocument;
  const win = doc.defaultView;
  if (!win?.ResizeObserver || typeof win.CSSStyleSheet?.prototype.replaceSync !== 'function') return; // the viewport's size (sidebar.css)
  const probe = doc.createElement('div');
  probe.className = 'window-probe'; // styles/sidebar.css
  probe.setAttribute('aria-hidden', 'true');
  shadow.prepend(probe);
  const sheet = new win.CSSStyleSheet();
  shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
  let drawn = '';
  const measure = () => {
    // A pinch moves and scales the host, which then holds the probe: the
    // window's size hasn't changed (shared/dom.js setHostPinch).
    if (!probe.isConnected || /** @type {any} */ (globalThis).Margin?.content?.pinched?.()) return;
    const { width, height } = win.getComputedStyle(probe);
    if (!/px$/.test(width) || !/px$/.test(height)) return;
    const rule = `${SIZED} { --vw: ${width}; --vh: ${height}; }`;
    if (rule === drawn) return;
    drawn = rule;
    sheet.replaceSync(rule);
  };
  new win.ResizeObserver(measure).observe(probe);
}

registerTheme({
  id: theme.id,
  // The frame around the page card (px) and the card's corner radius: core
  // places the page's box to match.
  geometry: { inset: 8, radius: '6.25px' },
  createPalette,
  mount({ shadow, document, send, onNewTab, onWidth, onScroll, onSwitch }) {
    const sidebar = createSidebar({ document, send, mode: 'overlay', onNewTab, onWidth, onScroll, onSwitch });
    const chrome = createChrome(document);
    // The switch cover below the sidebar (a hovered sidebar stays on top of it).
    // The startup cover over everything, the sidebar too.
    shadow.append(chrome.frame, chrome.rims, chrome.cover, sidebar.el, chrome.cardEdge, chrome.loader, chrome.pull, chrome.swipe, chrome.notice, chrome.startup);
    // Styles are bundled (assets.js) and applied synchronously, so the panel
    // is styled from the first frame (no fetch, no unstyled flash).
    adoptStyles(shadow, sidebarCss);
    followWindow(shadow);
    asBrowserUi(shadow); // no page context menu, selection or zoom here
    // A press on the frame (its strips take the pointer) is outside the sidebar.
    chrome.frame.addEventListener('pointerdown', () => sidebar.closeMenu());
    // No slide/fade on the first render: a kept-open sidebar should simply be
    // there when the page appears, not animate in on every navigation.
    const instant = [sidebar.el, chrome.frame, chrome.cardEdge];
    let leavingTimer = null;
    /** @type {{ place: () => void, width: number, coming: boolean, timer: any } | null} */
    let arrival = null;
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
      // frame around the page.
      // `place`: puts the page where this layout has it. Returns true if it
      // will be called later (Keep open turned on: the floating sidebar goes
      // off to the left, the docked one comes in with the card's edge, and
      // the page moves as that starts); otherwise the caller places it.
      setLayout({ open, docked, framed = false, width, place, why = null }) {
        const classes = sidebar.el.classList;
        if (arrival) {
          if (docked && open) { // drawn again on the way: it goes on, with what's new
            arrival.place = place;
            arrival.width = width;
            if (!arrival.coming) return true;
            chrome.setLayout({ docked: true, width, arriving: true });
            return false;
          }
          clearTimeout(arrival.timer);
          arrival = null;
          classes.remove('arriving');
          chrome.arrived();
        }
        if (open && docked && !classes.contains('docked') && !classes.contains('instant') && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
          arrival = { place, width, coming: false, timer: null };
          const comeIn = () => {
            arrival.coming = true;
            classes.add('docked');
            void sidebar.el.offsetWidth; // from off the left edge, in its docked shape
            classes.add('arriving', 'open');
            chrome.setLayout({ docked: true, width: arrival.width, arriving: true });
            arrival.place();
            arrival.timer = setTimeout(() => {
              arrival = null;
              classes.remove('arriving');
              chrome.arrived();
            }, 240);
          };
          if (classes.contains('open')) {
            classes.remove('open');
            arrival.timer = setTimeout(comeIn, 170);
          } else {
            comeIn();
          }
          return true;
        }
        // Out of Keep open: it slides off as it was, flush to the window.
        // (Drawn again on the way, it slides on.)
        if (open || docked || !sidebar.el.classList.contains('leaving')) {
          const leaving = !open && !docked && sidebar.el.classList.contains('docked');
          clearTimeout(leavingTimer);
          sidebar.el.classList.toggle('leaving', leaving);
          if (leaving) leavingTimer = setTimeout(() => sidebar.el.classList.remove('leaving'), 300);
        }
        // Brought out over the page just now (hovered at the window's edge, or
        // toggled; not a page shown with it out already, drawn at once then,
        // nor its peek after a space switch): the tab likely chosen next is
        // woken (sidebar.js revealed).
        const revealed = open && !docked && (why === 'hover' || why === 'toggle') && !sidebar.el.classList.contains('open') && !sidebar.el.classList.contains('instant');
        sidebar.el.classList.toggle('open', open);
        sidebar.el.classList.toggle('docked', docked);
        chrome.setLayout({ docked, framed, width });
        if (revealed) sidebar.revealed();
      },
      setWidth: chrome.setWidth,
      setLoading: chrome.setLoading,
      setCover: chrome.setCover,
      setStartup: chrome.setStartup,
      setPull: chrome.setPull,
      setSwipe: chrome.setSwipe,
      showNotice: chrome.showNotice,
    };
  },
});
