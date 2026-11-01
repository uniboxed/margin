// Pages cut off from Margin: their content-script world is still bound to a
// copy of Margin that's gone. Safari reloads Margin whenever it's updated
// (`npm run safari`) and whenever the system registers Margin.app again, which
// it does each time the app is opened (seen in Safari's log, 2026-10-30:
// LaunchServices builds the app's record again before it starts; Safari takes
// that as Margin uninstalled and installed, closes its background and starts
// a new one). Safari then keeps Margin's content-script world in the pages
// that were open, `browser` and all, still bound to the copy that's gone:
// every message and storage call from it neither arrives nor fails, so the
// old copy's switches, covers and sidebar wait for ever (a stuck spinner,
// rows that never update) until the page is reloaded. The new copy can't run
// there either: its content script finds the old copy's `Margin.content` in
// the same world and stops (content/core.js), and it would get the same dead
// `browser` anyway. A script the background runs there
// (scripting.executeScript) still works, and sees the world's `browser` with
// the old copy's address: that's how such a page is told (cutOffInPage), and
// it's reloaded when that loses nothing, else its dead Margin is put out of
// sight (background/tabs.js repairCutOff). (When the world isn't kept, as in
// WebKit by itself, the new copy starts beside the old one and takes over:
// content/takeover.js.)

// Executed in the tab's page, in Margin's content-script world (self-contained:
// it's sent as source). `own`: this copy's address (runtime.getURL('')).
// `quiet`: put a cut-off page's dead Margin out of sight (its sidebar, palette
// and covers, and the page hidden under an arrival cover). Answers
// { cutOff: false } for a page whose world is this copy's, and
// { cutOff: false, otherCopy: true } for one bound to another copy that still
// answers: one Safari keeps running beside this one until it quits
// (shared/owner.js; its pages stay out of the way themselves, and loading one
// again would bind it to that copy again). Else { cutOff: true, busy, hidden };
// `busy`: something typed, chosen or playing (judged as content/takeover.js
// does), so it isn't reloaded.
/** @param {string} own @param {boolean} [quiet] */
export async function cutOffInPage(own, quiet = false) {
  const api = /** @type {any} */ (globalThis).browser ?? /** @type {any} */ (globalThis).chrome;
  let at = null;
  try {
    at = api?.runtime?.id ? api.runtime.getURL('') : null;
  } catch {}
  if (at === own) return { cutOff: false };
  // A copy that's gone: its world's calls neither arrive nor fail (or fail at
  // once). One still running answers within a few milliseconds.
  if (at) {
    const alive = await Promise.race([
      Promise.resolve().then(() => api.storage.local.get('owner')).then(() => true, () => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    if (alive) return { cutOff: false, otherCopy: true };
  }
  const inUse = (/** @type {Document | null} */ doc, depth = 0) => {
    if (!doc || depth > 4) return false;
    const active = /** @type {any} */ (doc.activeElement);
    if (active && (active.isContentEditable || active.matches?.('textarea, select, input:not([type=hidden], [type=checkbox], [type=radio], [type=button], [type=submit], [type=reset], [type=image])'))) return true;
    for (const el of /** @type {any[]} */ ([...doc.querySelectorAll('textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=number], input[type=password]')])) if (String(el.value ?? '').trim()) return true;
    for (const el of /** @type {any[]} */ ([...doc.querySelectorAll('[contenteditable]:not([contenteditable=false])')])) if (el.isContentEditable && String(el.textContent ?? '').trim()) return true;
    for (const el of /** @type {any[]} */ ([...doc.querySelectorAll('select')])) if ([...el.options].some((o) => o.selected !== o.defaultSelected)) return true;
    for (const el of /** @type {any[]} */ ([...doc.querySelectorAll('input[type=checkbox], input[type=radio]')])) if (el.checked !== el.defaultChecked) return true;
    for (const el of /** @type {any[]} */ ([...doc.querySelectorAll('audio, video')])) if ((!el.paused && !el.ended) || (typeof MediaStream !== 'undefined' && el.srcObject instanceof MediaStream)) return true;
    for (const frame of /** @type {any[]} */ ([...doc.querySelectorAll('iframe, frame')])) {
      let inner = null;
      try {
        inner = frame.contentDocument;
      } catch {
        continue; // another origin: its own business
      }
      if (inUse(inner, depth + 1)) return true;
    }
    return false;
  };
  let busy = true;
  try {
    busy = /** @type {any} */ (navigator).mediaSession?.playbackState === 'playing' || inUse(document);
  } catch {}
  if (quiet) {
    try {
      for (const node of /** @type {HTMLElement[]} */ ([...(document.documentElement?.children ?? []), ...(document.querySelector?.(':root > margin-app')?.children ?? [])])) {
        if (!/^margin-.*-host$/.test(node.localName)) continue;
        node.style.setProperty('display', 'none', 'important');
        node.style.setProperty('pointer-events', 'none', 'important');
        node.setAttribute('aria-hidden', 'true');
        node.setAttribute('data-margin-off', ''); // what a host's own styles respect (shared/dom.js)
      }
      // The page out of sight under the old copy's arrival cover (content/core.js
      // arriveCovered): back.
      const page = document.body;
      if (page?.style.getPropertyValue('opacity') === '0' && page.style.getPropertyPriority('opacity') === 'important') page.style.removeProperty('opacity');
      // No sidebar, so no box beside it: the page has the window (content/page/box.js).
      document.dispatchEvent(new CustomEvent('margin:box', { detail: 'off' }));
    } catch {}
  }
  return { cutOff: true, busy, hidden: document.hidden };
}

// What to do with a page cutOffInPage answered for: nothing (it's this copy's,
// or it didn't answer), reload it (nothing in it would be lost; in front too:
// its Margin can't work until then, and that's what the user would do), or
// put its dead Margin out of sight and leave the page as it is (busy).
/** @param {any} probe @returns {'none' | 'reload' | 'quiet'} */
export function cutOffAction(probe) {
  if (!probe?.cutOff) return 'none';
  return probe.busy ? 'quiet' : 'reload';
}

// A tab showing Margin's own new-tab page from a copy that's gone: its address
// is the old copy's (an extension's address changes with each copy), and the
// page, kept open, is bound to it as a cut-off page's world is, so it draws
// what it last had and nothing in it answers (its search, its rows, its
// palette wait for ever). No script can be run there; it's sent to this
// copy's page at the same path, marked `?again` so it isn't taken for a new
// tab (⌘T's hand-off would close it: newtab/newtab.js). The address for it,
// or null when the tab isn't one. `own`: this copy's address
// (runtime.getURL('')).
const OWN_PAGES = new Set(['newtab/newtab.html']);
/** @param {string | undefined} url @param {string} own @returns {string | null} */
export function oldOwnPageAddress(url, own) {
  let at, mine;
  try {
    at = new URL(url ?? '');
    mine = new URL(own);
  } catch {
    return null;
  }
  if (at.protocol !== mine.protocol || at.host === mine.host || !/-extension:$/.test(at.protocol)) return null;
  const path = at.pathname.replace(/^\//, '');
  if (!OWN_PAGES.has(path)) return null;
  const search = new URLSearchParams(at.search);
  search.set('again', '');
  return new URL(`${path}?${search.toString().replace(/=(?=&|$)/g, '')}${at.hash}`, own).href;
}
