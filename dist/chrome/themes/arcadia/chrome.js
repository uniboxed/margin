// Arcadia's chrome around the page: the Arc frame and the page card's edge
// while docked, the page-load pill, the pull-to-refresh and swipe badges and
// the pinch-zoom readout. content/core.js decides when each shows; this file
// only draws them (styles/sidebar.css).
import { el } from '../../shared/dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Built with DOM calls (no innerHTML: some pages enforce Trusted Types).
const svgIn = (doc) => (tag, attrs) => {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

// While switching to another tab (shared/switching.js): an empty screen over
// the page (the card while docked), as Arc shows a tab not drawn yet, with a
// spinner in the middle once it takes a moment. Also on the new-tab page.
export function createSwitchCover(doc) {
  const svg = svgIn(doc);
  const spinner = svg('svg', { class: 'spinner', viewBox: '0 0 28 28', width: 28, height: 28 });
  spinner.append(svg('circle', { class: 'track', cx: 14, cy: 14, r: 11 }), svg('circle', { class: 'arc', cx: 14, cy: 14, r: 11, pathLength: 100 }));
  const cover = el(doc, 'div', { class: 'switch-cover', 'aria-hidden': 'true' }, spinner);
  return {
    el: cover,
    // On at once; off without a fade on a hidden page (the switch landed),
    // so it never plays when the page is shown again. `spinnerNow`: the
    // spinner without its delay (a page that continues a switch begun on the
    // page before, whose spinner was already turning).
    set(on, { instant = false, spinnerNow = false } = {}) {
      cover.classList.toggle('instant', instant);
      cover.classList.toggle('spinner-now', on && spinnerNow);
      cover.classList.toggle('on', on);
    },
  };
}

// While Margin gets ready on a page after Safari starts or Margin is
// updated (content/ready.js): the whole window, the sidebar too, with a
// spinner and a line saying what's happening. Fades in and out.
export function createStartupCover(doc) {
  const svg = svgIn(doc);
  const spinner = svg('svg', { class: 'spinner', viewBox: '0 0 28 28', width: 28, height: 28 });
  spinner.append(svg('circle', { class: 'track', cx: 14, cy: 14, r: 11 }), svg('circle', { class: 'arc', cx: 14, cy: 14, r: 11, pathLength: 100 }));
  const cover = el(doc, 'div', { class: 'startup-cover', role: 'status' }, spinner, el(doc, 'div', { class: 'caption', text: 'Getting your tabs ready…' }));
  return {
    el: cover,
    set(on) {
      cover.classList.toggle('on', on);
    },
  };
}

const FRAME = 8; // the frame's width (theme geometry.inset; styles/sidebar.css)

export function createChrome(doc) {
  const svg = svgIn(doc);
  // Arc-style frame: sidebar-colored strips around the page card with its
  // corners, shown while the sidebar is open. Like a browser's own frame,
  // its strips take the pointer (invisible .grip strips: no page clicks,
  // context menu or scrolling there); the card stays the page's.
  const frame = el(doc, 'div', { class: 'frame', 'aria-hidden': 'true' }, el(doc, 'div', { class: 'hole' }),
    ...['top', 'right', 'bottom'].map((side) => el(doc, 'div', { class: `grip ${side}` })));
  // The page card's continuous corners and soft shadow, above the sidebar so
  // the shadow also falls on its edge (sidebar.css .card-edge).
  const cardEdge = el(doc, 'div', { class: 'card-edge', 'aria-hidden': 'true' });
  // Arc-style page-load indicator: a small dark pill, centered over the page
  // (in the frame's top strip when docked), shown while the page loads.
  const loader = el(doc, 'div', { class: 'loader', 'aria-hidden': 'true' }, el(doc, 'div', { class: 'bar' }));
  // Pull-to-refresh indicator: a dark round badge that slides down with the
  // pull, its ring filling to the threshold, then spins while the page
  // reloads.
  const pullRing = svg('circle', { class: 'ring', cx: 14, cy: 14, r: 10, pathLength: 100 });
  const pullArrow = svg('path', { class: 'arrow', d: 'M14 8.5v10M9.75 14.5 14 18.75l4.25-4.25' });
  const pullIcon = svg('svg', { viewBox: '0 0 28 28', width: 28, height: 28 });
  pullIcon.append(svg('circle', { class: 'track', cx: 14, cy: 14, r: 10 }), pullRing, pullArrow);
  const pull = el(doc, 'div', { class: 'pull', 'aria-hidden': 'true' }, pullIcon);
  // Swipe back/forward badge (Arc): a dark circle centered on the page's left
  // (back) or right (forward) edge, the arrow in its visible half; it darkens
  // as the swipe goes on.
  const swipeIcon = svg('svg', { viewBox: '0 0 36 36', width: 36, height: 36 });
  swipeIcon.append(svg('path', { d: 'M28 18H8.5M17 9.5 8.5 18l8.5 8.5' }));
  const swipe = el(doc, 'div', { class: 'swipe', 'aria-hidden': 'true' }, swipeIcon);
  // Pinch-to-zoom readout ("125%"), centered over the page while pinching.
  const zoomHud = el(doc, 'div', { class: 'zoom-hud', 'aria-hidden': 'true' });
  const switchCover = createSwitchCover(doc);
  const cover = switchCover.el;
  const startupCover = createStartupCover(doc);
  const startup = startupCover.el;

  // A small notice near the left edge, where the sidebar would be (e.g.
  // "Margin works in full screen" with buttons); hides itself after a while.
  const notice = el(doc, 'div', { class: 'notice', role: 'status', hidden: true });
  let noticeTimer = null;

  // The frame at rest, the sidebar hidden, in every tab: the same picture as
  // .frame and .card-edge, drawn in four thin strips of its own, each its own
  // small surface, instead of one the size of the window (sidebar.css .rims).
  const rims = el(doc, 'div', { class: 'rims', 'aria-hidden': 'true' },
    ...['top', 'right', 'bottom', 'left'].map((side) => el(doc, 'div', { class: `rim ${side}` }, el(doc, 'div', { class: 'edge' }))));
  let settleTimer = null;
  // At rest: the strips; the full frame only while its edge travels.
  const settle = (on) => {
    for (const node of [frame, cardEdge, rims]) node.classList.toggle('settled', on);
  };

  const sized = [frame, cardEdge, loader, pull, swipe, zoomHud, cover];
  const inFrame = [loader, pull, swipe, zoomHud, cover];

  return {
    frame, rims, cardEdge, loader, pull, swipe, zoomHud, notice, cover, startup,
    setCover: switchCover.set,
    setStartup: startupCover.set,
    // { text, actions: [{ label, run }], duration? (ms, 6s by default) }, or null to hide it.
    showNotice(message) {
      clearTimeout(noticeTimer);
      if (!message) {
        notice.hidden = true;
        return;
      }
      const buttons = (message.actions ?? []).map(({ label, run }, i) => {
        const button = el(doc, 'button', { type: 'button', class: i === 0 ? 'primary' : '', text: label });
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          notice.hidden = true;
          run();
        });
        return button;
      });
      notice.replaceChildren(el(doc, 'span', { class: 'text', text: message.text }), ...buttons);
      notice.hidden = false;
      noticeTimer = setTimeout(() => { notice.hidden = true; }, message.duration ?? 6000);
    },
    // While docked, the frame shows and the indicators sit over the card.
    // `framed`: hidden, the frame alone around the whole page (the sidebar's
    // width is then the frame's own), reached by sliding left.
    // `arriving`: Keep open just turned on: the edge travels to the sidebar.
    setLayout({ docked, framed = false, width, arriving = false }) {
      const shown = docked || framed;
      const starts = framed && frame.classList.contains('open') && !frame.classList.contains('around');
      // Drawn again on the way (the setting's write comes back): it travels on.
      if (!framed || starts) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      if (starts) {
        settle(false);
        settleTimer = setTimeout(() => {
          settleTimer = null;
          settle(true);
        }, 260);
      } else if (settleTimer == null) {
        settle(framed);
      }
      frame.classList.toggle('open', shown);
      cardEdge.classList.toggle('open', shown);
      frame.classList.toggle('around', framed);
      cardEdge.classList.toggle('around', framed);
      frame.classList.toggle('arriving', arriving);
      cardEdge.classList.toggle('arriving', arriving);
      for (const node of inFrame) node.classList.toggle('in-frame', shown);
      this.setWidth(width);
    },
    setWidth(width) {
      const left = frame.classList.contains('around') ? FRAME : width;
      for (const node of sized) node.style.setProperty('--width', `${left}px`);
    },
    arrived() {
      frame.classList.remove('arriving');
      cardEdge.classList.remove('arriving');
    },
    setColorScheme(scheme) {
      frame.dataset.theme = scheme;
    },
    setLoading(on, { instant = false } = {}) {
      if (instant) {
        // Taking over from the placeholder's pill: no fade-in dip; or gone
        // from a hidden page without a fade.
        loader.classList.add('instant');
        requestAnimationFrame(() => requestAnimationFrame(() => loader.classList.remove('instant')));
      }
      loader.classList.toggle('on', on);
    },
    // phase: 'idle' | 'tracking' | 'armed' | 'refreshing'; progress 0…1+.
    setPull({ phase, progress = 0 }) {
      if (phase === 'idle') {
        pull.classList.remove('tracking', 'armed', 'refreshing');
        pull.style.removeProperty('--pull');
        return;
      }
      if (phase === 'refreshing') {
        pull.classList.remove('tracking');
        pull.classList.add('armed', 'refreshing');
        pull.style.setProperty('--pull', '1');
        return;
      }
      pull.classList.add('tracking');
      pull.classList.toggle('armed', phase === 'armed');
      pull.style.setProperty('--pull', String(Math.min(progress, 1.2)));
    },
    // phase: 'idle' | 'tracking' | 'armed' | 'going'; direction < 0 back, > 0 forward.
    setSwipe({ phase, progress = 0, direction = 0 }) {
      if (phase === 'idle') {
        swipe.classList.remove('active', 'tracking', 'armed');
        swipe.style.removeProperty('--swipe');
        return;
      }
      swipe.classList.add('active');
      swipe.classList.toggle('tracking', phase !== 'going');
      swipe.classList.toggle('forward', direction > 0);
      swipe.classList.toggle('armed', phase === 'armed' || phase === 'going');
      swipe.style.setProperty('--swipe', phase === 'going' ? '1' : String(Math.min(progress, 1)));
    },
    // The page zoom level (1 = 100%), or null to hide the readout.
    setZoom(level) {
      if (level == null) return zoomHud.classList.remove('show');
      zoomHud.textContent = `${Math.round(level * 100)}%`;
      zoomHud.classList.add('show');
    },
  };
}
