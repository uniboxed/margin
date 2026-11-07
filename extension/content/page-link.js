// Margin's side of the page's box: it says what the box should be, across to
// the page's own world (content/page/box.js), synchronously, so the sidebar
// and the page move in one step. Where that script isn't in the page (it was
// open when Margin started, or the box only now came on) it's brought in; and
// style sheets the page's world can't read are fetched for it.

// `send`: to the background (content/core.js).
export function startPageLink(send) {
  const html = document.documentElement;
  // Pages that aren't HTML have no box.
  const can = html instanceof HTMLHtmlElement;

  // Cancelled by the page's world: it heard. Nothing there means no script yet.
  const say = (detail) => !document.dispatchEvent(new CustomEvent('margin:box', { detail, cancelable: true }));

  let last = null; // the last message, sent again when the script arrives
  let asked = false;
  function tell(message, left) {
    last = message;
    if (say(message) || message === 'off' || asked) return;
    asked = true;
    // If it didn't work, the next change asks again.
    send('injectPage', { left }).then((ok) => { if (!ok) asked = false; });
  }
  document.addEventListener('margin:box-ready', () => { if (last) say(last); });

  let shown = null; // what it was last told: a box, 'off', or nothing yet
  // { left, top, right, bottom } in the page's pixels, and `live` while the
  // sidebar's edge is being dragged; null: no box, the page as it is.
  function setBox(box, { live = false } = {}) {
    if (!can) return;
    const message = box ? JSON.stringify({ ...box, live }) : 'off';
    if (message === shown) return;
    shown = message;
    tell(message, box?.left);
    if (box) fetchUnreadable();
    else restoreLinks();
  }

  // ---- sheets the page can't read ---------------------------------------------
  // Another origin's, with no CORS: unreadable to any script here, so media
  // queries in them stay the window's. The background fetches their text
  // (no cookies, as a <link> of another origin needs none) and it goes in as
  // a plain sheet after the link, which the page's world rewrites like any.
  // Where a strict CSP blocks that <style>, an adopted sheet takes its place:
  // last in the cascade, which is the price. A sheet that can't be fetched
  // stays as it is. The copy follows its link: gone when the link goes or
  // changes, off when the page turns the link off. The link itself is held off
  // by its media, which leaves `disabled` to the page.
  const MUTED = 'not all';
  /** link → its copy; a link with neither is one that couldn't be fetched. @type {Map<any, { href: string, media: string | null, style?: any, adopted?: any }>} */
  const copies = new Map();
  const dropCopy = (copy) => {
    copy.style?.remove();
    if (copy.adopted) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== copy.adopted);
  };
  function unmute(link, copy) {
    if (link.media !== MUTED) return;
    if (copy.media == null) link.removeAttribute('media');
    else link.media = copy.media;
  }
  function restoreLinks() {
    for (const [link, copy] of copies) {
      unmute(link, copy);
      dropCopy(copy);
    }
    copies.clear();
    links.disconnect();
  }
  const links = new MutationObserver(() => {
    let refetch = false;
    for (const [link, copy] of copies) {
      if (!copy.style && !copy.adopted) continue;
      const gone = !link.isConnected || !/stylesheet/i.test(link.rel);
      if (gone || link.href !== copy.href || link.media !== MUTED) {
        // A media of its own is the page's: the link goes by it from now on.
        if (link.media === MUTED) unmute(link, copy);
        dropCopy(copy);
        copies.delete(link);
        refetch ||= !gone;
        continue;
      }
      const sheet = copy.adopted ?? copy.style.sheet;
      if (sheet) sheet.disabled = link.disabled;
    }
    if (refetch && boxed()) fetchUnreadable();
  });
  function follow(link) {
    links.observe(link, { attributes: true, attributeFilter: ['href', 'media', 'disabled', 'rel'] });
    if (link.parentNode) links.observe(link.parentNode, { childList: true });
  }
  const absolute = (css, base) => css.replace(/url\(\s*(['"]?)(?!data:|#|[a-z][a-z0-9+.-]*:|\/\/)([^'")]+)\1\s*\)/gi, (_, quote, path) => {
    try {
      return `url(${quote}${new URL(path, base).href}${quote})`;
    } catch {
      return _;
    }
  }).replace(/@import\s+(['"])(?![a-z][a-z0-9+.-]*:|\/\/)([^'"]+)\1/gi, (_, quote, path) => {
    try {
      return `@import ${quote}${new URL(path, base).href}${quote}`;
    } catch {
      return _;
    }
  });
  async function replaceSheet(sheet) {
    const link = sheet.ownerNode;
    if (!link || link.localName !== 'link' || !sheet.href || sheet.href !== link.href || copies.get(link)?.href === link.href || new URL(sheet.href).origin === location.origin) return;
    try {
      void sheet.cssRules; // readable: nothing to do
      return;
    } catch {}
    const copy = { href: link.href, media: link.getAttribute('media') };
    copies.set(link, copy);
    const text = await send('fetchStyle', { url: sheet.href }, false);
    // Replaced or taken away while it was fetched.
    if (typeof text !== 'string' || !link.isConnected || copies.get(link) !== copy || link.href !== copy.href) return;
    const css = absolute(text, sheet.href);
    const style = document.createElement('style');
    if (link.media) style.media = link.media;
    style.textContent = css;
    link.after(style);
    if (style.sheet) {
      copy.style = style;
    } else {
      style.remove(); // blocked by the page's CSP
      copy.adopted = new CSSStyleSheet({ media: link.media || undefined });
      copy.adopted.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, copy.adopted];
      document.dispatchEvent(new CustomEvent('margin:sheets')); // the page's world looks at it now
    }
    if (link.disabled) (copy.adopted ?? style.sheet).disabled = true;
    link.media = MUTED;
    follow(link);
  }
  const boxed = () => shown != null && shown !== 'off';
  function fetchUnreadable() {
    for (const sheet of Array.from(document.styleSheets)) void replaceSheet(sheet).catch(() => {});
  }
  document.addEventListener('load', (event) => {
    if (/** @type {Element} */ (event.target).localName === 'link' && boxed()) fetchUnreadable();
  }, true);
  document.addEventListener('DOMContentLoaded', () => { if (boxed()) fetchUnreadable(); });

  return { setBox, can };
}
