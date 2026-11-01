// IntersectionObserver for the box: what a page asks with no root of its own.
//
// <body> clips before the window does, so a margin around the viewport needs
// <body> as the root (images that load ahead, lists that fetch more). But what's
// fixed isn't inside <body>'s containing block chain, and a body-rooted observer
// never fires for it: for that the window has to be the root. So a page's
// observer is a stand-in holding two of the browser's, one for each, and each
// target's answer is taken from the one that can give it. With no box there's
// only the window's. A root the page chose itself is left alone.

const find = (object, name) => {
  for (let at = object; at; at = Object.getPrototypeOf(at)) {
    const descriptor = Object.getOwnPropertyDescriptor(at, name);
    if (descriptor) return descriptor;
  }
  return undefined;
};
const OWN_GETTERS = ['rootMargin', 'scrollMargin', 'thresholds', 'delay', 'trackVisibility'];

export function startInView(box) {
  const Native = window.IntersectionObserver;
  const Entry = window.IntersectionObserverEntry;
  if (!Native || !Entry) return;

  // ---- entries: in the page's coordinates, as coords.js ----------------------
  /** Entries from a window-rooted observer: their root is the window, not the box. */
  const windowRooted = new WeakSet();
  const entry = Entry.prototype;
  for (const name of ['boundingClientRect', 'intersectionRect']) {
    const { get } = find(entry, name);
    Object.defineProperty(entry, name, { configurable: true, enumerable: true, get() { return box.toPage(get.call(this)); } });
  }
  const rootBounds = find(entry, 'rootBounds').get;
  Object.defineProperty(entry, 'rootBounds', {
    configurable: true,
    enumerable: true,
    get() {
      const rect = rootBounds.call(this);
      if (!rect || !box.boxed()) return rect;
      // The window with the page's margin around it: the same, for the box.
      return windowRooted.has(this) ? new DOMRect(rect.x, rect.y, rect.width - box.dw, rect.height - box.dh) : box.toPage(rect);
    },
  });

  // Is this target outside <body>'s containing block chain? Asked only when the
  // two answers differ, so rarely.
  function outsideBody(target) {
    const body = document.body;
    if (target === body) return true;
    for (let node = target; node; node = node.parentElement ?? /** @type {any} */ (node.getRootNode()).host) {
      if (node === body) return false;
      if (getComputedStyle(node).position === 'fixed') return true;
    }
    return true;
  }

  /** Every stand-in, to be told when the box or <body> changes. @type {Set<WeakRef<any>>} */
  const standIns = new Set();
  const reroots = new WeakMap();

  function Boxed(callback, options) {
    if (!new.target) throw new TypeError("Constructor IntersectionObserver requires 'new'");
    if (options?.root != null && options.root !== document) {
      const native = new Native(callback, options);
      if (new.target !== Boxed) Object.setPrototypeOf(native, new.target.prototype);
      return native;
    }
    const self = this;
    /** One per target: the latest entry from each root, and what the page last heard. */
    const targets = new Map();
    const inWindow = new Native((list) => hear(list, false), options);
    let inBody = null;

    const bucket = (ratio) => inWindow.thresholds.filter((at) => ratio >= at).length;
    function chosen(state) {
      if (!inBody) return state.window;
      if (!state.body || !state.window) return null; // the first answers go out together
      if (state.body.isIntersecting || !state.window.isIntersecting) return state.body;
      return outsideBody(state.window.target) ? state.window : state.body;
    }
    // What the page should hear of these targets: only what changed for it.
    function news(list) {
      const out = [];
      for (const state of list) {
        const answer = chosen(state);
        if (!answer) continue;
        const said = `${answer.isIntersecting} ${bucket(answer.intersectionRatio)}`;
        if (said === state.said) continue;
        state.said = said;
        out.push(answer);
      }
      return out;
    }
    function sort(list, fromBody) {
      const touched = new Set();
      for (const item of list) {
        const state = targets.get(item.target);
        if (!state) continue;
        if (!fromBody) windowRooted.add(item);
        state[fromBody ? 'body' : 'window'] = item;
        touched.add(state);
      }
      return news(touched);
    }
    function tell(list) {
      if (list.length) callback.call(self, list, self);
    }
    function hear(list, fromBody) {
      tell(sort(list, fromBody));
    }

    // The body-rooted one is made again when <body> changes, and exists only
    // while there's a box: with none, <body>'s whole height would count as in view.
    function reroot() {
      inBody?.disconnect();
      inBody = null;
      for (const state of targets.values()) state.body = null;
      if (box.on && targets.size && document.body?.localName === 'body') {
        inBody = new Native((list) => hear(list, true), { ...options, root: document.body });
        for (const target of targets.keys()) inBody.observe(target);
      } else {
        tell(news(targets.values()));
      }
    }

    Object.defineProperty(self, 'root', { get: () => options?.root ?? null });
    for (const name of OWN_GETTERS) if (name in inWindow) Object.defineProperty(self, name, { get: () => inWindow[name] });
    Object.defineProperties(self, {
      observe: {
        value(target) {
          inWindow.observe(target);
          if (targets.has(target)) return;
          targets.set(target, { window: null, body: null, said: null });
          if (inBody) inBody.observe(target);
          else if (box.on) reroot();
        },
      },
      unobserve: {
        value(target) {
          inWindow.unobserve(target);
          inBody?.unobserve(target);
          targets.delete(target);
        },
      },
      disconnect: {
        value() {
          inWindow.disconnect();
          inBody?.disconnect();
          inBody = null;
          targets.clear();
        },
      },
      takeRecords: {
        value: () => [...sort(inBody?.takeRecords() ?? [], true), ...sort(inWindow.takeRecords(), false)],
      },
    });
    reroots.set(self, reroot);
    standIns.add(new WeakRef(self));
  }
  Boxed.prototype = Native.prototype;
  Native.prototype.constructor = Boxed;
  Object.defineProperty(Boxed, 'name', { value: 'IntersectionObserver' });
  window.IntersectionObserver = /** @type {any} */ (Boxed);

  const rerootAll = () => {
    for (const ref of standIns) {
      const standIn = ref.deref();
      if (standIn) reroots.get(standIn)();
      else standIns.delete(ref);
    }
  };
  box.onToggle.push(rerootAll);
  box.onBody.push(rerootAll);
}
