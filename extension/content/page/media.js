// matchMedia for the box: a page's query about the window's width asks about
// the box's. A list with no size in it (colors, motion, print) stays the
// browser's own. A list with one is a stand-in that holds the browser's list
// for the box as it is now, and follows when the box moves: a media query
// can't take a variable, so the query itself is what changes.
import { asksSize, shiftQuery } from '../../shared/page-css.js';

const SWEEP_FLOOR = 64;

export function startMedia(box) {
  const matchMediaNative = window.matchMedia;
  const native = (query) => matchMediaNative.call(window, shiftQuery(query, box.seenW(), box.seenH()));
  /** @type {Set<WeakRef<object>>} */
  const lists = new Set();
  // Pages ask for lists all the time and drop them: those gone are swept when
  // the box rests, and whenever there are twice as many as after the last sweep.
  let sweepAt = SWEEP_FLOOR;
  function addList(list) {
    lists.add(new WeakRef(list));
    if (lists.size < sweepAt) return;
    for (const ref of lists) if (!ref.deref()) lists.delete(ref);
    sweepAt = Math.max(SWEEP_FLOOR, 2 * lists.size);
  }

  function standIn(text) {
    const listeners = new Set(); // [callback, once]
    let current = native(text);
    /** @type {any} */
    const list = Object.create(MediaQueryList.prototype);
    let handler = null;
    const notify = (matches) => {
      const event = new MediaQueryListEvent('change', { media: text, matches });
      for (const name of ['target', 'currentTarget']) Object.defineProperty(event, name, { value: list });
      if (typeof handler === 'function') handler.call(list, event);
      for (const entry of [...listeners]) {
        if (entry.once) listeners.delete(entry);
        if (typeof entry.callback === 'function') entry.callback.call(list, event);
        else entry.callback?.handleEvent?.(event);
      }
    };
    const onNative = (event) => notify(event.matches);
    // Heard only once someone listens: a list listened to stays alive, and
    // pages ask for lists all the time.
    let hearing = false;
    const hear = () => {
      if (!hearing) current.addEventListener('change', onNative);
      hearing = true;
    };
    const add = (callback, once = false) => {
      if (callback && ![...listeners].some((entry) => entry.callback === callback)) listeners.add({ callback, once });
      hear();
    };
    const remove = (callback) => {
      for (const entry of listeners) if (entry.callback === callback) listeners.delete(entry);
    };
    Object.defineProperties(list, {
      media: { get: () => text },
      matches: { get: () => current.matches },
      onchange: { get: () => handler, set(fn) { handler = fn; hear(); } },
      addEventListener: { value: (type, callback, options) => { if (type === 'change') add(callback, !!options?.once); } },
      removeEventListener: { value: (type, callback) => { if (type === 'change') remove(callback); } },
      addListener: { value: (callback) => add(callback) },
      removeListener: { value: remove },
      dispatchEvent: { value: (event) => { for (const entry of listeners) entry.callback?.call?.(list, event); return true; } },
    });
    // Called for the box's new size: a list that now reads otherwise says so.
    list[FOLLOW] = () => {
      const was = current.matches;
      if (hearing) current.removeEventListener('change', onNative);
      current = native(text);
      if (hearing) current.addEventListener('change', onNative);
      if (current.matches !== was) notify(current.matches);
    };
    return list;
  }
  const FOLLOW = Symbol('follow');

  window.matchMedia = function matchMedia(query) {
    const text = String(query);
    if (!asksSize(text)) return matchMediaNative.call(window, text);
    const list = standIn(text);
    addList(list);
    return list;
  };

  box.onRest.push(() => {
    for (const ref of lists) {
      const list = ref.deref();
      if (list) list[FOLLOW]();
      else lists.delete(ref);
    }
  });
}
