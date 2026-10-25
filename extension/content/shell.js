// Fitted layout: the page beside the sidebar, laid out exactly as in a
// narrower window. Registered by the background (scripting.
// registerContentScripts, id margin-shell) only while "Keep open" and the
// "Fit pages beside the sidebar" setting are on; Safari builds only.
//
// How (research/viewport on branch docs/viewport-research; DECISIONS.md):
//  1. Safari runs this at document_start, right after the parser creates
//     <html> and before it adds anything (measured on Tirth's Safari 27).
//     The parser's <html> is swapped for Margin's shell: a frame for the
//     page, the "card". The parser keeps filling the detached <html>, where
//     no script runs and nothing loads.
//  2. When parsing ends, that same HTML is written into the card (same
//     origin, the page's own URL and CSP). The card's viewport is the card's
//     size, so fixed headers, 100vw and media queries all fit. No URL is ever
//     fetched as a frame, so pages that forbid framing still work, and
//     nothing is fetched twice.
//  3. Every link, form or script navigation in the card is cancelled
//     (Navigation API) and redone as a normal top-level navigation, so the
//     address bar, Back/Forward and Safari's loading bar stay native.
//     content/shell-main.js (page world) keeps the page's own history
//     entries (pushState) on the top window.
// Skipped loads (popups, non-HTML, other encodings, late injection, …) keep
// the push layout (content/sidebar.js).
(() => {
  const Margin = globalThis.Margin;
  const L = Margin?.shellLogic;
  if (!L || window !== top || Margin.shell !== undefined) return;
  Margin.shell = null; // ran once; WebKit may run document_start scripts again

  const log = (...args) => console.debug('[margin] fitted layout:', ...args);
  const old = document.documentElement;
  const href = location.href.split('#')[0];

  // sessionStorage (this tab, this site): loads Margin shouldn't fit again.
  const NO_FIT = 'margin:nofit';
  const LOOP_KEY = 'margin:fitloop';
  const readJson = (key) => {
    try {
      return JSON.parse(sessionStorage.getItem(key) ?? 'null');
    } catch {
      return null;
    }
  };
  const writeJson = (key, value) => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {}
  };
  const optOut = () => {
    const urls = readJson(NO_FIT) ?? [];
    if (!urls.includes(href)) writeJson(NO_FIT, [...urls, href].slice(-50));
  };

  // A page that reloads itself out of the frame never stays in the card for
  // SETTLED_MS; one that does clears its count.
  const SETTLED_MS = 1000;
  const loops = readJson(LOOP_KEY);
  const loop = L.loopCheck(loops?.url === href ? loops.times : [], Date.now());
  const skip = L.skipReason({
    enabled: !!Margin.platform?.shell,
    isTop: true,
    isHtml: old instanceof HTMLHtmlElement,
    contentType: document.contentType,
    charset: document.characterSet,
    ready: document.readyState,
    kids: old ? [...old.childNodes].map((n) => n.nodeName) : [],
    navigationApi: typeof window.navigation?.addEventListener === 'function',
    hasOpener: window.opener != null,
    origin: self.origin,
    crossOriginIsolated: !!self.crossOriginIsolated,
    compatMode: document.compatMode,
    doctype: document.doctype && { publicId: document.doctype.publicId, systemId: document.doctype.systemId },
    optedOut: (readJson(NO_FIT) ?? []).includes(href) || loop.tooMany,
  });
  if (loop.tooMany) optOut(); // for the rest of this tab's session
  if (skip) {
    log('skipped:', skip);
    return;
  }
  writeJson(LOOP_KEY, { url: href, times: loop.times });

  // ---- the shell ------------------------------------------------------------

  const FRAME_PX = 8; // the frame around the card (sidebar.css .frame .hole)
  const shell = document.createElement('html');
  shell.setAttribute('data-margin-shell', '');
  const head = shell.appendChild(document.createElement('head'));
  const body = shell.appendChild(document.createElement('body'));
  const frame = document.createElement('iframe');
  // Isolated-world expando: page scripts can't see or forge it.
  frame.__marginShellFrame = true;
  // A unique name: without one, WebKit restores the frame's own history item
  // on Back (without the page cache) and fetches the page as a frame.
  frame.name = `margin-${Math.random().toString(36).slice(2)}`;
  frame.srcdoc = '<!doctype html><title></title>';
  frame.allowFullscreen = true;
  frame.setAttribute('allow', [
    'fullscreen', 'payment', 'publickey-credentials-get', 'publickey-credentials-create', 'clipboard-read', 'clipboard-write',
    'geolocation', 'camera', 'microphone', 'display-capture', 'web-share', 'autoplay', 'encrypted-media', 'picture-in-picture',
    'screen-wake-lock',
  ].join('; '));
  body.append(frame);
  // Margin's own hosts (its content scripts ran before this one) move along.
  for (const node of [...old.childNodes]) if (node.nodeType === 1 && node.localName.startsWith('margin-')) shell.append(node);

  // Styles through adopted sheets and the CSSOM: a page's style-src blocks
  // <style> elements and style attributes from content scripts in WebKit.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    html[data-margin-shell], html[data-margin-shell] > body {
      margin: 0 !important; padding: 0 !important; height: 100% !important; overflow: hidden !important;
      background: #9c9da1 !important; /* sidebar.css --frame */
    }
    html[data-margin-shell] > body > iframe {
      position: fixed !important; display: block !important; margin: 0 !important; padding: 0 !important;
      border: 0 !important; background: Canvas; color-scheme: normal;
    }`);
  // Paint hold: until the card has its HTML and stylesheets, the shell stays
  // invisible, so Safari keeps showing the previous page instead of an empty
  // card (WebKit stops holding the old page once the new one has content).
  const hold = new CSSStyleSheet();
  hold.replaceSync('html[data-margin-shell] { visibility: hidden !important; }');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet, hold];
  document.replaceChild(shell, old);

  let held = true;
  function release(why) {
    if (!held) return;
    held = false;
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== hold);
    log(`showing (${why}) after ${Math.round(performance.now())}ms`);
  }
  const HOLD_MAX_MS = 2500;
  setTimeout(() => release('hold timeout'), HOLD_MAX_MS);

  // Card geometry: inset in the frame while docked, the whole window
  // otherwise (Keep open turned off on this page: the sidebar floats over it).
  let layout = { docked: true, width: 260 };
  function applyLayout() {
    const { docked, width } = layout;
    const set = (prop, value) => frame.style.setProperty(prop, value, 'important');
    set('top', docked ? `${FRAME_PX}px` : '0');
    set('left', docked ? `${width}px` : '0');
    set('width', docked ? `calc(100% - ${width + FRAME_PX}px)` : '100%');
    set('height', docked ? `calc(100% - ${2 * FRAME_PX}px)` : '100%');
    set('border-radius', docked ? '6.25px' : '0'); // sidebar.css .card-edge
  }
  applyLayout();

  // ---- title, icons and tab color --------------------------------------------
  // Safari reads them from the top document only: copy them from the page.
  // It loads the favicon once, when the top document finishes parsing, so
  // they're copied while the page streams in, then kept in sync.
  const LINK_RELS = ['icon', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon', 'manifest', 'search'];
  // A referrer policy also covers the navigations Margin redoes from here.
  const META_NAMES = ['theme-color', 'color-scheme', 'apple-mobile-web-app-title', 'application-name', 'referrer'];
  let mirrored = [];
  let mirroredKey = '';
  function mirror(root) {
    const pageHead = root?.querySelector('head');
    const title = root?.querySelector('title');
    const text = title ? title.textContent.replace(/\s+/g, ' ').trim() : '';
    if (title && document.title !== text) document.title = text;
    if (!pageHead) return;
    const picked = [...pageHead.querySelectorAll('link[rel], meta[name]')].filter((node) =>
      node.localName === 'link'
        ? node.rel.split(/\s+/).some((r) => LINK_RELS.includes(r.toLowerCase()))
        : META_NAMES.includes(node.name.toLowerCase()));
    const copies = picked.map((node) => {
      const copy = document.createElement(node.localName);
      for (const { name, value } of node.attributes) if (name !== 'href' && !name.startsWith('on')) copy.setAttribute(name, value);
      if (node.localName === 'link') copy.setAttribute('href', node.href); // absolute: the page may have <base>
      return copy;
    });
    const key = copies.map((c) => c.outerHTML).join('');
    if (key !== mirroredKey) {
      mirroredKey = key;
      for (const node of mirrored) node.remove();
      mirrored = copies;
      head.append(...copies);
    }
    // A page's <meta> CSP also binds the forms Margin rebuilds here (a
    // form-action rule is checked again on redirects). Only ever added: a
    // policy stays in force once applied. Not before the card's document
    // exists: it would inherit the policy from its start, ahead of the page's
    // <meta>, and block what comes before it.
    if (!card) return;
    for (const meta of pageHead.querySelectorAll('meta[http-equiv]')) {
      if (meta.httpEquiv.toLowerCase() !== 'content-security-policy' || cspCopied.has(meta.content)) continue;
      cspCopied.add(meta.content);
      const copy = document.createElement('meta');
      copy.httpEquiv = 'Content-Security-Policy';
      copy.content = meta.content;
      head.append(copy);
    }
  }
  const cspCopied = new Set();
  let mirrorQueued = false;
  const queueMirror = (root) => {
    if (mirrorQueued) return;
    mirrorQueued = true;
    queueMicrotask(() => {
      mirrorQueued = false;
      mirror(root);
    });
  };
  // Audio and video in the detached tree would start loading (and media
  // loads skip the memory cache, so the card would fetch them again): their
  // sources are parked until the page is serialized.
  const parked = new Map(); // element → src
  const park = (node) => {
    if (node.nodeType !== 1) return;
    const media = node.matches('audio, video, source, track') ? [node] : [];
    for (const el of [...media, ...node.querySelectorAll('audio, video, source, track')]) {
      if (parked.has(el) || !el.hasAttribute('src')) continue;
      parked.set(el, el.getAttribute('src'));
      el.removeAttribute('src');
    }
  };
  const parseObserver = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) park(node);
    queueMirror(old);
  });
  parseObserver.observe(old, { childList: true, subtree: true, characterData: true });

  // ---- navigations ----------------------------------------------------------

  let ownNavigation = false;
  let card = null; // the card's window, once the page is in it

  // Scroll position, kept in the top history entry (the card has none of its
  // own): restored after a reload or a Back that isn't from the page cache.
  function saveScroll() {
    if (!card) return;
    try {
      history.replaceState({ ...(history.state ?? {}), __marginScroll: [card.scrollX, card.scrollY] }, '');
    } catch {}
  }
  addEventListener('pagehide', saveScroll);

  // Top-level redo of a navigation the card started.
  function goTop({ url, type, fields, enctype, link }) {
    saveScroll();
    ownNavigation = true;
    if (type === 'reload') return location.reload();
    // A link that limits its referrer (rel=noreferrer, referrerpolicy) is
    // followed with the same limits.
    if (link && type !== 'replace') {
      const a = document.createElement('a');
      a.href = url;
      a.rel = link.rel;
      a.referrerPolicy = link.referrerPolicy;
      a.hidden = true;
      body.append(a);
      a.click();
      return a.remove();
    }
    if (fields) {
      const form = document.createElement('form');
      form.method = 'post';
      form.action = url;
      form.acceptCharset = 'UTF-8';
      if (enctype) form.enctype = enctype;
      form.hidden = true;
      for (const field of fields) {
        const input = document.createElement('input');
        input.type = field.type; // text-like types kept, so password saving sees the fields
        input.name = field.name;
        if (field.file) {
          // A chosen file goes along; an empty file input sends the same empty part.
          if (field.file.name || field.file.size) {
            const transfer = new DataTransfer();
            transfer.items.add(field.file);
            input.files = transfer.files;
          }
        } else {
          input.value = field.value;
        }
        form.append(input);
      }
      body.append(form);
      return form.submit();
    }
    if (type === 'replace') location.replace(url);
    else location.assign(url);
  }

  function routeCard(win) {
    win.navigation.addEventListener('navigate', (event) => {
      const url = event.destination.url;
      if (event.destination.sameDocument) {
        // A fragment link: give it its own entry on the top window (address
        // bar, Back), then scroll the card to it.
        if (event.hashChange && event.navigationType === 'push' && event.cancelable) {
          event.preventDefault();
          saveScroll();
          history.pushState(null, '', url);
          win.location.replace(url);
        }
        return;
      }
      // data: and blob: go to the top too, where WebKit's top-level rules
      // decide them as without the shell (a data: page must not show under
      // the site's address).
      if (!event.cancelable || event.downloadRequest != null || !(L.routable(url) || /^(data|blob):/i.test(url))) return;
      let fields = null;
      let enctype = null;
      const source = event.sourceElement;
      if (event.formData) {
        const form = source?.form ?? (source?.localName === 'form' ? source : null);
        fields = L.postFields(event.formData.entries(), (name) => form?.elements.namedItem(name)?.type);
        enctype = source?.formEnctype || form?.enctype || null;
      }
      const link = !fields && (source?.localName === 'a' || source?.localName === 'area')
        && (/\bnoreferrer\b/i.test(source.rel) || source.hasAttribute('referrerpolicy'))
        ? { rel: source.rel, referrerPolicy: source.referrerPolicy }
        : null;
      event.preventDefault();
      goTop({ url, type: event.navigationType, fields, enctype, link });
    });
  }

  // ⌘P prints the page, not Margin's shell (File > Print still prints the
  // shell's view). Bubble phase, so a page with its own ⌘P (e.g. a web
  // editor) keeps it.
  const printKey = (event) => event.code === 'KeyP' && event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey;
  function watchPrintKey(target) {
    target.addEventListener('keydown', (event) => {
      if (!event.isTrusted || !printKey(event) || event.defaultPrevented || !card) return;
      event.preventDefault();
      card.print();
    });
  }
  watchPrintKey(window);

  // A click in the sidebar focuses this document, which can't scroll: hand
  // the keys back to the page, unless the click focused a field or menu of
  // Margin's (its host is then the active element).
  addEventListener('pointerup', (event) => {
    if (event.button !== 0) return;
    setTimeout(() => {
      const active = document.activeElement;
      // Not while the palette, a space editor or the tab menu is open: a
      // click on a button there leaves focus nowhere, but they want the keys.
      if (card && (!active || active === document.body) && !Margin.content?.uiBusy?.()) card.focus();
    });
  }, true);

  // Frame busting ("if (top !== self) top.location = self.location") would
  // reload the page forever: cancel script navigations of the top window to
  // the page it's already on, unless Margin started them.
  navigation.addEventListener('navigate', (event) => {
    if (ownNavigation || event.destination.sameDocument || !event.cancelable) return;
    if (L.isBust({ destination: event.destination.url, current: location.href, type: event.navigationType })) {
      event.preventDefault();
      log('stopped the page from reloading itself out of the frame');
    }
  });

  // ---- the page goes into the card ---------------------------------------------

  const api = globalThis.browser ?? globalThis.chrome;
  const closedRoot = (el) => {
    try {
      return api?.dom?.openOrClosedShadowRoot?.(el) ?? null;
    } catch {
      return null;
    }
  };
  function reportViolation(event, where = 'the page') {
    log(`the page's CSP blocked ${event.blockedURI || 'an inline script'} (${event.effectiveDirective}) in ${where},`,
      `from ${event.sourceFile || 'the page'}:${event.lineNumber}`, event.sample ? `"${event.sample}"` : '');
  }
  document.addEventListener('securitypolicyviolation', (event) => reportViolation(event, "Margin's shell"), true);

  const frameLoaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
  let transplanted = false;

  function fail(why) {
    log('could not fit this page, reloading it without:', why);
    release('failed');
    optOut();
    ownNavigation = true;
    location.reload();
  }

  function waitForStyles(doc, maxMs) {
    const links = [...doc.querySelectorAll('link[rel~="stylesheet"]')].filter((l) => !l.sheet && !l.disabled);
    const loaded = links.map((l) => new Promise((resolve) => {
      l.addEventListener('load', resolve, { once: true });
      l.addEventListener('error', resolve, { once: true });
    }));
    return Promise.race([Promise.all(loaded), new Promise((resolve) => setTimeout(resolve, maxMs))]);
  }

  // <table><form><tr><td><input>…: the parser puts the form in the table
  // empty and ties the later controls to it, a tie the markup doesn't carry.
  // Written out as form="…", or those forms wouldn't submit in the card.
  // Where the parser's tie ended (</form>) leaves no trace either, so only
  // the certain scope is tied: the form's own row, or its table section.
  const FORM_CONTROLS = 'button:not([type="button" i]):not([type="reset" i]), fieldset, input, object, output, select, textarea';
  function tieTableForms(root) {
    let n = 0;
    for (const form of root.querySelectorAll('table form, tbody form, thead form, tfoot form, tr form')) {
      const scope = form.parentElement;
      if (!/^(table|tbody|thead|tfoot|tr)$/.test(scope?.localName ?? '') || scope.closest('form')) continue;
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
      walker.currentNode = form;
      for (let el = walker.nextNode(); el; el = walker.nextNode()) {
        if (el.localName === 'form') break;
        if (!el.matches(FORM_CONTROLS) || el.closest('form') || el.hasAttribute('form')) continue;
        if (!form.id) form.id = `margin-form-${++n}`;
        el.setAttribute('form', form.id);
      }
    }
  }

  async function transplant() {
    if (transplanted) return;
    transplanted = true;
    parseObserver.disconnect();
    mirror(old);
    await frameLoaded;
    // One task later: written straight from the frame's load handler, the
    // card would never fire its own load event (window.onload).
    await new Promise((resolve) => setTimeout(resolve));
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    if (!win || !doc) return fail('no card document');
    let html;
    const roots = [];
    try {
      for (const [el, src] of parked) el.setAttribute('src', src);
      tieTableForms(old);
      // Every declarative shadow root (server-rendered components), not just
      // serializable ones: open ones directly, closed ones through the
      // extension API (Safari 26+). A root left out would leave its host's
      // content unstyled in the card.
      const walk = (node) => {
        for (const el of node.querySelectorAll('*')) {
          const root = el.shadowRoot ?? closedRoot(el);
          if (root) {
            roots.push(root);
            walk(root);
          }
        }
      };
      walk(old);
      const inner = typeof old.getHTML === 'function' ? old.getHTML({ serializableShadowRoots: true, shadowRoots: roots }) : old.innerHTML;
      html = L.serialize({ doctype: L.doctypeString(document.doctype), attrs: [...old.attributes].map((a) => [a.name, a.value]), inner });
    } catch (err) {
      return fail(err);
    }
    for (const el of parked.keys()) el.removeAttribute('src');
    try {
      doc.open();
      // document.open() drops the fragment; put it back before the page's
      // scripts read location.hash (silently: no hashchange).
      if (location.hash) win.history.replaceState(null, '', location.href);
      // After open() (which drops the card window's listeners), before
      // write() (whose inline scripts may already navigate or listen).
      card = win;
      routeCard(win);
      // What the page's CSP blocks in the card, with where it came from, so a
      // console error can be told apart from Margin's own doing.
      doc.addEventListener('securitypolicyviolation', (event) => reportViolation(event), true);
      watchPrintKey(win);
      Margin.content?.cardReady?.(win, frame);
      doc.write(html);
      doc.close();
    } catch (err) {
      return fail(err);
    }
    // Lets the detached tree go.
    old.replaceChildren();

    // Scroll to the fragment the normal way (same URL: no hashchange).
    if (location.hash) win.location.replace(location.href);
    // Keys go to the page (Space, arrows), as they would without the shell,
    // unless the user is typing in Margin's palette or sidebar meanwhile.
    // This only picks the frame that gets keys inside the page; it doesn't
    // take focus from Safari's address bar.
    if (!document.activeElement || document.activeElement === document.body) win.focus();

    // Title, icons and theme color as the page changes them.
    const cardObserver = new MutationObserver(() => queueMirror(doc.documentElement));
    const watchHead = () => {
      if (doc.head) cardObserver.observe(doc.head, { childList: true, subtree: true, characterData: true, attributes: true });
    };
    watchHead();
    if (!doc.head) doc.addEventListener('DOMContentLoaded', watchHead, { once: true });
    queueMirror(doc.documentElement);

    await waitForStyles(doc, 1500);
    // The page's canvas (white, or dark for a dark color-scheme) behind it,
    // not Margin's gray, for pages without a background of their own.
    frame.style.setProperty('color-scheme', win.getComputedStyle(doc.documentElement).colorScheme || 'normal');
    // Not in a frame callback: WebKit doesn't render a hidden document until
    // its load event, so one would wait for every image.
    setTimeout(() => release('page ready'));
    // Stayed in the card: not a reload loop (see loopCheck).
    setTimeout(() => {
      if (readJson(LOOP_KEY)?.url === href) writeJson(LOOP_KEY, null);
    }, SETTLED_MS);

    // Scroll back to where the page was, after a reload or a Back without
    // the page cache.
    const type = performance.getEntriesByType?.('navigation')?.[0]?.type;
    const saved = history.state?.__marginScroll;
    if ((type === 'reload' || type === 'back_forward') && Array.isArray(saved) && !location.hash) {
      const restore = () => win.scrollTo(saved[0], saved[1]);
      if (doc.readyState === 'complete') restore();
      else win.addEventListener('load', () => setTimeout(restore), { once: true });
    }
    const closed = roots.filter((r) => r.mode === 'closed').length;
    log(`page in the card after ${Math.round(performance.now())}ms (${html.length} characters, ${roots.length} shadow roots, ${closed} closed)`);
  }

  document.addEventListener('DOMContentLoaded', transplant, { once: true });
  // If the parser stops early (the user pressed Stop), use what arrived.
  addEventListener('load', transplant, { once: true });

  Margin.shell = {
    frame,
    get card() {
      return card;
    },
    // Called by content/sidebar.js on every layout change.
    setLayout(next) {
      layout = { ...layout, ...next };
      applyLayout();
    },
    cardLeft: () => (layout.docked ? layout.width : 0),
    cardTop: () => (layout.docked ? FRAME_PX : 0),
    focusCard: () => card?.focus(),
  };
  log('taking over');
})();
