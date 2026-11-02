// What a page asks about its window, answered for the box (box.js): its size,
// scrolling (the window's is <body>'s now), and what the browser does for a
// window's scrolling by itself: paging keys, and the place kept across Back and
// reload. With no box, each asks the page itself.

const find = (object, name) => {
  for (let at = object; at; at = Object.getPrototypeOf(at)) {
    const descriptor = Object.getOwnPropertyDescriptor(at, name);
    if (descriptor) return descriptor;
  }
  return undefined;
};
const define = (object, name, descriptor) => Object.defineProperty(object, name, { configurable: true, enumerable: true, ...descriptor });

export function startViewport(box) {
  const root = () => box.root();
  const element = Element.prototype;
  const native = {};
  for (const name of ['scrollTop', 'scrollLeft', 'scrollHeight', 'scrollWidth', 'clientWidth', 'clientHeight']) native[name] = find(element, name);
  const offsetHeight = find(HTMLElement.prototype, 'offsetHeight');
  const innerWidth = find(window, 'innerWidth');
  const innerHeight = find(window, 'innerHeight');
  // The scroller for `node`: <html> speaks for <body> while there's a box.
  const scroller = (node) => (box.on && node === root() ? box.body() : node);
  const scroll = () => (box.on ? box.body() : root());

  // ---- size --------------------------------------------------------------------
  define(window, 'innerWidth', { get: () => innerWidth.get.call(window) - box.seenW(), set() {} });
  define(window, 'innerHeight', { get: () => innerHeight.get.call(window) - box.seenH(), set() {} });
  const viewport = window.visualViewport;
  if (viewport) {
    const width = find(viewport, 'width');
    const height = find(viewport, 'height');
    define(VisualViewport.prototype, 'width', { get() { return width.get.call(this) - box.seenW() / this.scale; } });
    define(VisualViewport.prototype, 'height', { get() { return height.get.call(this) - box.seenH() / this.scale; } });
  }
  define(element, 'clientWidth', { get() { return box.boxed() && this === root() ? native.clientWidth.get.call(box.body()) : native.clientWidth.get.call(this); } });
  // <html>'s is the viewport's; <body> reports the page's height, as it does
  // when it grows with its content. So `innerHeight + scrollY >= body.offsetHeight`
  // still means the end of the page. Heights only: in a window these elements'
  // widths are the viewport's, whatever overflows sideways, which they are here.
  const pageHeight = () => native.scrollHeight.get.call(box.body());
  define(element, 'clientHeight', {
    get() {
      if (!box.boxed()) return native.clientHeight.get.call(this);
      if (this === root()) return native.clientHeight.get.call(box.body());
      return this === document.body ? pageHeight() : native.clientHeight.get.call(this);
    },
  });
  define(HTMLElement.prototype, 'offsetHeight', {
    get() { return box.boxed() && (this === root() || this === document.body) ? pageHeight() : offsetHeight.get.call(this); },
  });

  // ---- scrolling ---------------------------------------------------------------
  for (const name of ['scrollY', 'pageYOffset']) define(window, name, { get: () => native.scrollTop.get.call(scroll()), set() {} });
  for (const name of ['scrollX', 'pageXOffset']) define(window, name, { get: () => native.scrollLeft.get.call(scroll()), set() {} });
  for (const name of ['scrollTop', 'scrollLeft', 'scrollHeight', 'scrollWidth']) {
    define(element, name, {
      get() { return native[name].get.call(scroller(this)); },
      set(value) { native[name].set?.call(scroller(this), value); },
    });
  }
  const scrollingElement = find(Document.prototype, 'scrollingElement');
  define(Document.prototype, 'scrollingElement', { get() { return box.on && this === document ? box.body() : scrollingElement.get.call(this); } });
  for (const name of ['scrollTo', 'scrollBy', 'scroll']) {
    const method = element[name];
    const own = window[name];
    window[name] = function (...args) { return box.on ? method.apply(box.body(), args) : own.apply(window, args); };
    element[name] = function (...args) { return method.apply(scroller(this), args); };
  }
  // A scroll of <body> doesn't reach what listens on the document or the window.
  for (const type of ['scroll', 'scrollend']) {
    addEventListener(type, (event) => {
      if (box.on && event.target === document.body && event.isTrusted) document.dispatchEvent(new Event(type, { bubbles: true }));
    }, { capture: true, passive: true });
  }

  // ---- paging keys -------------------------------------------------------------
  // Nothing focused, the browser pages the (unscrollable) root. A press decides
  // where keys go: into a pane that was clicked and can still move, they're the
  // browser's own. ⌘↑ ⌘↓ and ⌥↑ ⌥↓ are Safari's too; ⌘⌥ is Margin's.
  const pagingStep = (event, height) => {
    const { key, shiftKey: shift, metaKey: meta, altKey: alt } = event;
    if (meta && alt) return undefined;
    if (meta || alt) {
      const down = key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0;
      return down * (meta ? 1e9 : height * 0.9) || undefined;
    }
    if (key === ' ') return shift ? -height * 0.9 : height * 0.9;
    if (shift) return undefined; // Shift and an arrow extends a selection
    return { PageDown: height * 0.9, PageUp: -height * 0.9, ArrowDown: 40, ArrowUp: -40, Home: -1e9, End: 1e9 }[key];
  };
  const canMove = (node, down) => {
    const top = native.scrollTop.get.call(node);
    return down ? top + native.clientHeight.get.call(node) < native.scrollHeight.get.call(node) - 1 : top > 0;
  };
  /** @type {any} */
  let pressed = null;
  addEventListener('pointerdown', (event) => { pressed = event.composedPath()[0]; }, { capture: true, passive: true });
  // Does a pane around what was pressed, short of <body>, take this key?
  function paneTakes(body, down) {
    if (!pressed?.isConnected) return false;
    for (let node = pressed; node && node !== body && node !== root(); node = node.parentNode ?? node.host) {
      if (node.nodeType === 1 && /auto|scroll/.test(getComputedStyle(node).overflowY) && canMove(node, down)) return true;
    }
    return false;
  }
  addEventListener('keydown', (event) => {
    if (!box.on || event.defaultPrevented || event.ctrlKey) return;
    const focused = document.activeElement;
    if ((focused && focused !== document.body && focused !== root()) || document.body?.isContentEditable || document.designMode === 'on') return;
    const body = box.body();
    const step = pagingStep(event, native.clientHeight.get.call(body));
    if (step == null || getComputedStyle(body).overflowY === 'hidden') return;
    const down = step > 0;
    if (paneTakes(body, down) || !canMove(body, down)) return;
    event.preventDefault();
    body.scrollBy({ top: step, behavior: event.repeat ? 'instant' : 'smooth' });
  });

  // ---- the place across Back, Forward and reload --------------------------------
  // The browser restores only the root's scroll, and <body> holds it now. Places
  // are kept per history entry (navigation.currentEntry.key: nothing is added to
  // the page's own history state), in the tab's session storage, the latest
  // few. A page that keeps its own place (`scrollRestoration = 'manual'`) is left
  // to it.
  const KEY = 'margin:places';
  const MAX_PLACES = 30;
  const navigation = /** @type {any} */ (window).navigation;
  const entryKey = () => navigation?.currentEntry?.key ?? location.pathname + location.search;
  const read = () => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) ?? '{}') ?? {};
    } catch {
      return {};
    }
  };
  function save() {
    if (!box.on || history.scrollRestoration === 'manual') return;
    const body = box.body();
    const here = entryKey();
    const { [here]: _, ...others } = read();
    const place = [native.scrollLeft.get.call(body), native.scrollTop.get.call(body)];
    try {
      sessionStorage.setItem(KEY, JSON.stringify(Object.fromEntries([...Object.entries(others), [here, place]].slice(-MAX_PLACES))));
    } catch {}
  }
  // Puts the place back, again while content arrives. Over as soon as the
  // person scrolls or the page moves the scroller itself.
  let stopPutting = () => {};
  function restore() {
    stopPutting();
    if (!box.on || history.scrollRestoration === 'manual') return;
    const place = read()[entryKey()];
    if (!place) return;
    const [x, y] = place;
    const body = box.body();
    let tries = 0;
    let timer = 0;
    let at = null;
    const stop = () => {
      clearTimeout(timer);
      for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown']) removeEventListener(type, stop, true);
    };
    stopPutting = stop;
    for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown']) addEventListener(type, stop, { capture: true, passive: true });
    const put = () => {
      if (at != null && native.scrollTop.get.call(body) !== at) return stop();
      native.scrollLeft.set.call(body, x);
      native.scrollTop.set.call(body, y);
      at = native.scrollTop.get.call(body);
      if (++tries >= 10 || at >= y - 1) return stop();
      timer = setTimeout(put, 100);
    };
    put();
  }
  addEventListener('pagehide', save);
  const navigationType = () => {
    try {
      return /** @type {any} */ (performance.getEntriesByType('navigation')[0])?.type;
    } catch {
      return undefined;
    }
  };
  addEventListener('load', () => {
    if (/^(back_forward|reload)$/.test(navigationType() ?? '')) restore();
  });
  // Within the page: saved as a navigation starts (by the time it's over the
  // entry has changed), put back after the page's own handlers and the browser's
  // scroll to a fragment. An intercepted navigation that scrolls by hand is the page's.
  const later = () => requestAnimationFrame(restore);
  if (navigation) {
    let manual = false;
    const NavigateEvent = /** @type {any} */ (window).NavigateEvent;
    const intercept = NavigateEvent?.prototype.intercept;
    if (intercept) {
      NavigateEvent.prototype.intercept = function (options) {
        manual = options?.scroll === 'manual';
        return intercept.call(this, options);
      };
    }
    navigation.addEventListener('navigate', () => {
      manual = false;
      save();
    });
    navigation.addEventListener('currententrychange', (event) => {
      if (event.navigationType === 'traverse' && !manual) later();
    });
  } else {
    addEventListener('popstate', later);
  }
}
