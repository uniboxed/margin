// Pages cut off from Margin: their content-script world is still bound to a
// copy of Margin that's gone. Safari reloads Margin whenever it's updated
// (`npm run safari`) and whenever the system registers Margin.app again, which
// it does each time the app is opened (seen in Safari's log, 2026-10-30:
// LaunchServices builds the app's record again before it starts; Safari takes
// that as Margin uninstalled and installed, closes its background and starts
// a new one). Safari then keeps Margin's content-script world in the pages
// that were open, `browser` and all, still bound to the copy that's gone:
// every message and storage call from it neither arrives nor fails, so the
// old copy's switches, keys and box wait for ever until the page is
// reloaded. The new copy can't run
// there either: its content script finds the old copy's `Margin.content` in
// the same world and stops (content/core.ts), and it would get the same dead
// `browser` anyway. A script the background runs there
// (scripting.executeScript) still works, and sees the world's `browser` with
// the old copy's address: that's how such a page is told (cutOffInPage), and
// it's reloaded when that loses nothing, else its dead Margin's box is taken
// off (background/tabs.ts repairCutOff). (When the world isn't kept, as in
// WebKit by itself, the new copy starts beside the old one in a world of its
// own.)

// Executed in the tab's page, in Margin's content-script world (self-contained:
// it's sent as source). `own`: this copy's address (runtime.getURL('')).
// `quiet`: take a cut-off page's dead Margin out of the way (its box: the page
// has the window). Answers
// { cutOff: false } for a page whose world is this copy's, and
// { cutOff: false, otherCopy: true } for one bound to another copy that still
// answers: one Safari keeps running beside this one until it quits
// (shared/owner.ts; its pages stay out of the way themselves, and loading one
// again would bind it to that copy again). Else { cutOff: true, busy, hidden };
// `busy`: something typed, chosen or playing (judged generously: any text in
// a field or an editor), so it isn't reloaded.
// A page found cut off is also told so in its world (`Margin.cutOff`): the old
// copy's listener for the navigation keys, whose messages go nowhere, then
// lets them pass to the page and to Safari's own commands (shared/shortcuts.ts).
// `keys`: the manifest commands' keys (shared/shortcuts.ts commandKeys: on
// Safari ⌃⌘↓/↑/→): a listener put in the world here, once, keeps them from
// the page's own listeners, so they go on to Safari's commands, which this
// copy answers. A page that turns any ArrowDown down (Outlook, Instagram) ate
// them before: the only way left out of a cut-off tab by keys, where the old
// copy's own listener (one from before 2026-11-04 doesn't know `cutOff`)
// swallows its Settings keys into messages that go nowhere. Not turned down
// (preventDefault): WebKit gives the menu only a key the page didn't.
export async function cutOffInPage(own: string, quiet: boolean = false, keys: string[] = []) {
  const api = (globalThis as any).browser ?? (globalThis as any).chrome;
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
      new Promise<any>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    if (alive) return { cutOff: false, otherCopy: true };
  }
  const inUse = (doc: Document | null, depth = 0) => {
    if (!doc || depth > 4) return false;
    const active = (doc.activeElement as any);
    if (active && (active.isContentEditable || active.matches?.('textarea, select, input:not([type=hidden], [type=checkbox], [type=radio], [type=button], [type=submit], [type=reset], [type=image])'))) return true;
    for (const el of ([...doc.querySelectorAll('textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=number], input[type=password]')] as any[])) if (String(el.value ?? '').trim()) return true;
    for (const el of ([...doc.querySelectorAll('[contenteditable]:not([contenteditable=false])')] as any[])) if (el.isContentEditable && String(el.textContent ?? '').trim()) return true;
    for (const el of ([...doc.querySelectorAll('select')] as any[])) if ([...el.options].some((o) => o.selected !== o.defaultSelected)) return true;
    for (const el of ([...doc.querySelectorAll('input[type=checkbox], input[type=radio]')] as any[])) if (el.checked !== el.defaultChecked) return true;
    for (const el of ([...doc.querySelectorAll('audio, video')] as any[])) if ((!el.paused && !el.ended) || (typeof MediaStream !== 'undefined' && el.srcObject instanceof MediaStream)) return true;
    for (const frame of ([...doc.querySelectorAll('iframe, frame')] as any[])) {
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
  try {
    const world = (globalThis as any).Margin ??= {};
    world.cutOff = true;
    const wanted = (Array.isArray(keys) ? keys : []).map((k) => String(k).split('+')).map((parts) => ({ code: parts.at(-1), ctrl: parts.includes('Ctrl'), alt: parts.includes('Alt'), shift: parts.includes('Shift'), meta: parts.includes('Meta') }));
    if (wanted.length && !world.cutOffKeys) {
      world.cutOffKeys = true;
      globalThis.addEventListener('keydown', (e: KeyboardEvent) => {
        if (wanted.some((k) => e.code === k.code && e.ctrlKey === k.ctrl && e.altKey === k.alt && e.shiftKey === k.shift && e.metaKey === k.meta)) e.stopImmediatePropagation();
      }, true);
    }
  } catch {}
  let busy = true;
  try {
    busy = (navigator as any).mediaSession?.playbackState === 'playing' || inUse(document);
  } catch {}
  if (quiet) {
    try {
      // Its box goes: the page has the window (content/page/box.ts).
      document.dispatchEvent(new CustomEvent('margin:box', { detail: 'off' }));
    } catch {}
  }
  return { cutOff: true, busy, hidden: document.hidden };
}

// What to do with a page cutOffInPage answered for: nothing (it's this copy's,
// or it didn't answer), reload it (nothing in it would be lost; in front too:
// its Margin can't work until then, and that's what the user would do), or
// put its dead Margin out of sight and leave the page as it is (busy).
export function cutOffAction(probe: any): 'none' | 'reload' | 'quiet' {
  if (!probe?.cutOff) return 'none';
  return probe.busy ? 'quiet' : 'reload';
}

// A tab showing Margin's own new-tab page from a copy that's gone: its address
// is the old copy's (an extension's address changes with each copy), and the
// page, kept open, is bound to it as a cut-off page's world is, so it draws
// what it last had and nothing in it answers (its search, its rows, its
// palette wait for ever). No script can be run there; it's sent to this
// copy's page at the same path, marked `?again` so it isn't taken for a new
// tab (⌘T's hand-off would close it: newtab/newtab.ts). The address for it,
// or null when the tab isn't one. `own`: this copy's address
// (runtime.getURL('')).
const OWN_PAGES = new Set(['newtab/newtab.html']);
export function oldOwnPageAddress(url: string | undefined, own: string): string | null {
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
