// Fitted layout: the page beside the sidebar, laid out exactly as in a
// narrower window. Registered by the background (scripting.
// registerContentScripts, id margin-shell) only while "Keep open" and the
// "Fit pages beside the sidebar" setting are on (in Chrome, while a window
// is in full screen, where Margin works there).
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
//     content/shell-card.js (page world) keeps the page's own history
//     entries (pushState) on the top window.
// Chrome: the same, except that the write in step 2 is done by a page-world
// script (content/shell-writer.js), and the card is switched to about:blank
// with location.replace (see below).
// Skipped loads (popups, non-HTML, other encodings, late injection, …) keep
// the push layout (content/core.js).
import * as L from '../shared/shell-logic.js';
import { platform } from '../shared/platform.js';

(() => {
  const Margin = (globalThis.Margin ??= {});
  if (window !== top || Margin.shell !== undefined) return;
  Margin.shell = null; // ran once; WebKit may run document_start scripts again

  const log = (...args) => console.debug('[margin] fitted layout:', ...args);
  const old = document.documentElement;
  // This page (origin and path: a page busting out of the frame may change its
  // query each time; shell-logic.js pageKey).
  const page = L.pageKey(location.href);

  // sessionStorage (this tab, this site): pages Margin shouldn't fit again.
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
  // `key`: this page (pageKey: busting and loops, whose query may change
  // every time) or just this URL (a failed fit).
  const optOut = (key = page) => {
    const urls = readJson(NO_FIT) ?? [];
    if (!urls.includes(key)) writeJson(NO_FIT, [...urls, key].slice(-50));
  };
  const href = location.href.split('#')[0];

  // A page that keeps reloading itself in the card (out of the frame, or
  // after an error it hits there) never settles; one the user works with,
  // or that stays SETTLED_MS, clears its count. Short enough that pages
  // refreshing themselves every few seconds, or quick searches one after
  // another, aren't taken for a loop.
  const SETTLED_MS = 3000;
  const loops = readJson(LOOP_KEY);
  const loop = L.loopCheck(loops?.url === page ? loops.times : [], Date.now());
  const skip = L.skipReason({
    enabled: !!platform?.shell,
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
    frameAware: L.frameAware(location.href),
    optedOut: (readJson(NO_FIT) ?? []).some((key) => key === page || key === href || key === `origin:${self.origin}`) || loop.tooMany,
  });
  if (loop.tooMany) optOut(); // for the rest of this tab's session
  if (skip) {
    log('skipped:', skip);
    return;
  }
  // Chrome, where Margin works only in full screen (background/registered.js
  // sets the flag): not in a window that shows Chrome's toolbar (Margin full
  // screen has none). innerHeight is in the page's zoomed pixels.
  if (Margin.shellFullscreenOnly && outerHeight - innerHeight * (outerWidth / innerWidth || 1) > 40) {
    log('skipped: a window with the toolbar (Margin works only in full screen)');
    return;
  }
  // Chrome: only with the page-world writer there and able to write here.
  // Asked now, before the page is taken over, so a page it can't write needs
  // no reload: one that requires Trusted Types and lists its policies
  // refuses Margin's (then the whole site, for this tab).
  if (platform?.shellPageWrite) {
    dispatchEvent(new CustomEvent('margin-shell-probe'));
    const writable = old.getAttribute('data-margin-writable');
    old.removeAttribute('data-margin-writable');
    if (writable !== 'yes') {
      if (writable === 'no') optOut(`origin:${self.origin}`);
      log('skipped:', writable === 'no' ? "the page's Trusted Types policy refuses Margin's" : 'no page-world writer');
      return;
    }
  }
  writeJson(LOOP_KEY, { url: page, times: loop.times });

  // ---- the shell ------------------------------------------------------------

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
  // The card's empty document: first a srcdoc, then about:blank, and the page
  // is written into that. WebKit gives a srcdoc document a fixed base URL (the
  // tab's first URL, even after document.open and pushState), so once a site
  // moved on in the page its relative URLs pointed back at the first page
  // (links, requests; GitHub's commit file tree took the tab to the
  // repository). An about:blank document takes the page's URL as its base
  // and follows it, but a frame's first about:blank document has the
  // Navigation API switched off, which the card's router needs; a later one
  // has it (checked in WebKit). Both loads happen while the top is still
  // loading, so the frame gets no history entry of its own in WebKit; Chrome
  // gives the second one an entry unless it replaces the first.
  frame.srcdoc = '<!doctype html><title></title>';
  let frameReady = false; // the card's empty about:blank document has loaded
  const frameLoaded = new Promise((/** @type {(value?: void) => void} */ resolve) => frame.addEventListener('load', () => {
    frame.addEventListener('load', () => {
      frameReady = true;
      resolve();
    }, { once: true });
    if (platform?.shellPageWrite) frame.contentWindow.location.replace('about:blank');
    else {
      frame.removeAttribute('srcdoc');
      frame.src = 'about:blank';
    }
  }, { once: true }));
  frame.allowFullscreen = true;
  frame.setAttribute('allow', [
    'fullscreen', 'payment', 'publickey-credentials-get', 'publickey-credentials-create', 'clipboard-read', 'clipboard-write',
    'geolocation', 'camera', 'microphone', 'display-capture', 'web-share', 'autoplay', 'encrypted-media', 'picture-in-picture',
    'screen-wake-lock',
  ].join('; '));
  body.append(frame);
  // Margin's own hosts (its content scripts ran before this one) move along.
  for (const node of [...old.childNodes]) if (node.nodeType === 1 && /** @type {Element} */ (node).localName.startsWith('margin-')) shell.append(node);

  // Styles through adopted sheets and the CSSOM: a page's style-src blocks
  // <style> elements and style attributes from content scripts in WebKit.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    html[data-margin-shell], html[data-margin-shell] > body {
      margin: 0 !important; padding: 0 !important; height: 100% !important; overflow: hidden !important;
      /* The page's own canvas, not the frame's gray (the sidebar and the
         docked style draw the frame around the card): when Safari shows a tab
         it has never drawn (one Margin woke in the background), the card
         paints a moment after the shell, and gray there read as one more
         flash. */
      background: Canvas !important;
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
  let restoring = false; // Safari is loading, as it's shown, a tab it had unloaded (below)
  function release(why) {
    if (!held) return;
    held = false;
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== hold);
    for (const link of loadHolds.values()) link.remove();
    log(`showing (${why}) after ${Math.round(performance.now())}ms`);
    // DEVELOPMENT DIAGNOSTICS (background/diagnostics.js): the switch log
    // keeps how a page that was just shown came on screen.
    if (!document.hidden) {
      (globalThis.browser ?? globalThis.chrome)?.runtime?.sendMessage({ type: 'shellShown', why, ms: performance.now(), restoring })
        .catch(() => {});
    }
  }
  const HOLD_MAX_MS = 2500;
  setTimeout(() => release('hold timeout'), HOLD_MAX_MS);
  // Unless Safari is loading, as it's shown, a tab it had unloaded (after a
  // relaunch, or one unused for a while): then there's no previous page on
  // screen to keep, only Safari's empty view, so the shell shows at once (the
  // sidebar and the frame, the card filling in as the page arrives).
  (globalThis.browser ?? globalThis.chrome)?.runtime?.sendMessage({ type: 'restoringTab', url: location.href })
    .then((res) => {
      if (!res?.ok || !res.result) return;
      restoring = true;
      release('tab being restored');
    }, () => {});
  // Sooner, without waiting for a background that may be starting: Margin
  // noted that it's bringing this tab to the front unprepared (a tab Safari
  // unloaded; background/tabs.js noteShowing).
  // Only a page that started as the note was written (not one reloaded by
  // hand a few seconds later: content/core.js notedShowing).
  const startedWith = (at) => performance.timeOrigin - at > -1000 && performance.timeOrigin - at < 3000;
  (globalThis.browser ?? globalThis.chrome)?.storage?.local.get('showing').then(({ showing }) => {
    if (!showing || !startedWith(showing.at) || document.hidden || Date.now() - showing.at > 10000 || String(showing.url).split('#')[0] !== href) return;
    restoring = true;
    release('tab being restored');
  }, () => {});

  // Card geometry: inset in the theme's frame while docked, the whole window
  // otherwise (Keep open turned off on this page: the sidebar floats over it).
  // The theme reports its width, inset and corner radius through
  // content/core.js; until then, the default theme's (Arcadium: 260px
  // sidebar, 8px frame, 6.25px corners), which its first-paint placeholder
  // draws around this card.
  let layout = { docked: true, width: 260, inset: 8, radius: '6.25px' };
  function applyLayout() {
    const { docked, width, inset, radius } = layout;
    const set = (prop, value) => frame.style.setProperty(prop, value, 'important');
    set('top', docked ? `${inset}px` : '0');
    set('left', docked ? `${width}px` : '0');
    set('width', docked ? `calc(100% - ${width + inset}px)` : '100%');
    set('height', docked ? `calc(100% - ${2 * inset}px)` : '100%');
    set('border-radius', docked ? radius : '0');
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
      head.append(...copies.map(own));
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
      head.append(own(copy));
    }
  }
  const cspCopied = new Set();

  // Margin's own nodes in the shell; anything else in its <head> or <body>
  // was put there by the page (see stray styles below).
  const ours = new WeakSet();
  const own = (node) => (ours.add(node), node);
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
  /**
   * @param {{ url: string, type: string, fields?: any[] | null, method?: string, enctype?: string | null, link?: { rel?: string, referrerPolicy?: string } | null, anchor?: boolean }} navigation
   */
  function goTop({ url, type, fields, method = 'post', enctype, link, anchor = true }) {
    // The card's window.name, for the next page: the card's own pagehide
    // (content/shell-card.js) comes too late in Chrome.
    try {
      if (card) window.name = card.name;
    } catch {}
    saveScroll();
    ownNavigation = true;
    if (type === 'reload') return location.reload();
    // Followed as a link when the user started it: a link that limits its
    // referrer (rel=noreferrer, referrerpolicy) keeps its limits, and WebKit
    // gives it a history entry of its own even while the shell is still
    // loading, which a redo after the click's user gesture (redoRefused)
    // otherwise doesn't get. A script's navigation keeps WebKit's own rule
    // (no entry of its own before the page's load event).
    if (type === 'push' && !fields && anchor) {
      const a = document.createElement('a');
      a.href = url;
      a.rel = link?.rel ?? '';
      if (link) a.referrerPolicy = link.referrerPolicy;
      a.hidden = true;
      body.append(own(a));
      a.click();
      return a.remove();
    }
    if (fields) {
      // A form, GET too: the shell has the page's CSP, so form-action applies.
      const form = document.createElement('form');
      form.method = method;
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
      body.append(own(form));
      return form.submit();
    }
    if (type === 'replace') location.replace(url);
    else location.assign(url);
  }

  function routeCard(win) {
    // The card's URL changed without content/shell-card.js seeing it (a page
    // calling a pushState it took from another frame of its own: YouTube):
    // keep the address bar, and ⌘R, on the page's real URL.
    // After the page's own call: shell-card.js's wrappers update the top right
    // after the card's entry changes (checking at once rewrote the entry
    // being left, so Back stopped working).
    win.navigation.addEventListener('currententrychange', () => queueMicrotask(() => {
      const url = win.location.href;
      if (url !== location.href && new URL(url).origin === location.origin) history.replaceState(history.state, '', url);
    }));
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
      if (!event.cancelable || event.downloadRequest != null || !(L.routable(url) || L.topOnly(url))) return;
      let fields = null;
      let enctype = null;
      const source = event.sourceElement;
      if (event.formData) {
        const form = source?.form ?? (source?.localName === 'form' ? source : null);
        fields = L.postFields(event.formData.entries(), (name) => form?.elements.namedItem(name)?.type);
        enctype = source?.formEnctype || form?.enctype || null;
      }
      event.preventDefault();
      const user = event.userInitiated || win.navigator.userActivation?.isActive || source?.localName === 'a' || source?.localName === 'area';
      goTop({ url, type: event.navigationType, fields, enctype, link: linkReferrer(source), anchor: Boolean(user) });
    });

    // WebKit checks a frame navigation against the shell's CSP (the page's
    // own frame-src / child-src / default-src) before the navigate event
    // above exists, so on sites that limit frames (GitHub: default-src
    // 'none') links, forms and script navigations in the card are refused.
    // Margin doesn't take them over: the browser still decides what a click
    // or submit does (routers, editors, pings, downloads all keep working).
    // It only records what the user activated, so a refusal (redoRefused,
    // below) can be redone at the top with the full URL and form data.
    const doc = win.document;
    const onActivate = (event) => {
      if (!event.isTrusted) return;
      const a = event.composedPath().find((n) => n.localName === 'a' || n.localName === 'area');
      const href = a && (typeof a.href === 'string' ? a.href : a.getAttribute('href') && new URL(a.getAttribute('href'), doc.baseURI).href);
      if (!href || !(L.routable(href) || L.topOnly(href))) return;
      const target = a.getAttribute('target') ?? doc.querySelector('base[target]')?.getAttribute('target');
      if (!L.cardNavigatingClick({ button: 0, target })) return;
      const { button, metaKey, shiftKey, altKey, ctrlKey } = event;
      if (button > 1 || ctrlKey) return; // ⌃-click is the Mac's context menu
      remember({ kind: 'link', href, referrer: linkReferrer(a), button, metaKey, shiftKey, altKey });
    };
    win.addEventListener('click', onActivate, true);
    win.addEventListener('auxclick', onActivate, true);
    // Download links Margin can save from the shell (same origin, or a blob:
    // or data: URL the page made) are saved right away: the CSP refuses them
    // in the card before the download starts, and a page often revokes its
    // blob: URL straight after the click.
    win.addEventListener('click', (event) => {
      if (!event.isTrusted || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const a = event.composedPath().find((n) => n.localName === 'a' && n.hasAttribute('download'));
      if (!a?.href || !(L.topOnly(a.href) || new URL(a.href).origin === win.location.origin)) return;
      event.preventDefault();
      saveFrom(a.href, a.getAttribute('download'));
    });
    let submitter = null; // { form, element } of the last trusted submit
    win.addEventListener('submit', (event) => {
      if (event.isTrusted) submitter = { form: event.target, element: event.submitter };
    }, true);
    // Fired for every submission the browser builds (form.submit() too),
    // with the exact data it will send.
    win.addEventListener('formdata', (event) => {
      const form = event.target;
      if (!event.isTrusted || form?.localName !== 'form') return;
      const element = submitter?.form === form ? submitter.element : null;
      submitter = null;
      const attr = (name) => (element?.hasAttribute(`form${name}`) ? element.getAttribute(`form${name}`) : form.getAttribute(name));
      const target = attr('target') ?? doc.querySelector('base[target]')?.getAttribute('target');
      const method = (attr('method') || 'get').toLowerCase();
      if (!L.cardNavigatingClick({ button: 0, target }) || (method !== 'get' && method !== 'post')) return;
      const action = element?.hasAttribute('formaction') ? element.formAction : form.action;
      if (!L.routable(action)) return;
      const fields = L.postFields(event.formData.entries(), (name) => form.elements.namedItem(name)?.type);
      // Whether a GET one can be redone as a link to href: the user submitted
      // it and its URL is exactly what the browser would send (UTF-8: the
      // card only holds UTF-8 pages, see skipReason).
      const charset = attr('accept-charset');
      const asLink = (win.navigator.userActivation?.isActive ?? true) && (!charset || /(^|[\s,])utf-8($|[\s,])/i.test(charset));
      remember({ kind: 'form', href: method === 'get' ? L.getSubmissionUrl(action, event.formData.entries()) : action, action, method, fields, enctype: attr('enctype') || null, asLink });
    }, true);
  }

  // Recent user activations in the card (links and forms), for redoRefused.
  const activations = [];
  const remember = (record) => {
    activations.push({ ...record, at: performance.now() });
    while (activations.length > 10) activations.shift();
  };

  // A link that limits its referrer (rel=noreferrer, referrerpolicy) is
  // followed with the same limits.
  function linkReferrer(source) {
    if (source?.localName !== 'a' && source?.localName !== 'area') return null;
    if (!/\bnoreferrer\b/i.test(source.rel) && !source.hasAttribute('referrerpolicy')) return null;
    return { rel: source.rel, referrerPolicy: source.referrerPolicy };
  }

  // A download, from the shell (same origin as the page).
  function saveFrom(url, name) {
    const a = own(document.createElement('a'));
    a.href = url;
    a.download = name ?? '';
    a.hidden = true;
    body.append(a);
    a.click();
    a.remove();
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

  // Frame busting ("if (top !== self) top.location = self.location"): the
  // page wants to be the top document, not in Margin's frame. Never stop it
  // (that blocked pages from working, and a page that changes its URL each
  // time looped: Microsoft's sign-in): let it navigate, and don't fit this
  // page again in this tab, so it loads as the site intends.
  navigation.addEventListener('navigate', (event) => {
    if (ownNavigation || event.destination.sameDocument || event.userInitiated) return;
    // Not right after the user did something in the page (a script
    // paginating or filtering to the same path with another query).
    if (card?.navigator?.userActivation?.isActive) return;
    if (L.isBust({ destination: event.destination.url, current: location.href, type: event.navigationType })) {
      optOut();
      log('the page navigated itself out of the frame: not fitting it again in this tab');
    }
  });

  // Stylesheets the page puts into the shell (code made to also run in a
  // frame puts them into window.parent.document, which here is the shell:
  // Google's AI Mode does): moved into the card's <head>, where they apply.
  const strayObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!card || ours.has(node) || node.nodeType !== 1) continue;
        const el = /** @type {HTMLLinkElement} */ (node);
        if (el.localName === 'style' || (el.localName === 'link' && /\bstylesheet\b/i.test(el.rel))) {
          card.document.head?.append(node);
          log('moved a stylesheet the page put in the shell into the page');
        }
      }
    }
  });
  strayObserver.observe(head, { childList: true });
  strayObserver.observe(body, { childList: true });

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
  document.addEventListener('securitypolicyviolation', (event) => {
    reportViolation(event, "Margin's shell");
    redoRefused(event);
  }, true);

  // A card navigation the shell's CSP refused (see routeCard): the card is
  // the shell's only frame of its own, so a frame-src refusal reported here
  // is the card navigating (or a frame page code put into window.top, which
  // is skipped). WebKit reports a cross-origin URL as its origin only and a
  // same-origin one without its fragment, so the full URL comes from what the
  // user activated; a script navigation to the same origin is redone as
  // reported, and one Margin can't identify is left alone.
  let lastRedo = null;
  function redoRefused(event) {
    const reported = event.blockedURI;
    if (!event.isTrusted || !card || !/^(frame-src|child-src|default-src)$/.test(event.effectiveDirective) || !reported) return;
    const origin = card.location.origin;
    const key = (url) => L.reportKey(url, origin);
    if ([...document.querySelectorAll('iframe, frame, object, embed')].some((el) => el !== frame && key(/** @type {HTMLIFrameElement & HTMLObjectElement} */ (el).src || /** @type {HTMLObjectElement} */ (el).data || '') === reported)) return;
    if (lastRedo && lastRedo.reported === reported && performance.now() - lastRedo.at < 1000) return; // WebKit can report it twice
    lastRedo = { reported, at: performance.now() };
    const now = performance.now();
    const match = activations.filter((r) => now - r.at < 2000 && key(r.href) === reported).pop();
    if (match) activations.splice(activations.indexOf(match), 1);
    if (match?.kind === 'form') {
      log('redoing at the top a form the page\'s CSP refused in the card:', match.action);
      // Until the shell's load event (it waits for the card's images), WebKit
      // gives a form submitted without the click's user gesture (this runs
      // after it) no history entry of its own, so Back would skip this page:
      // a GET one goes as a link then. The card already checked its URL
      // against form-action, but a link's redirects aren't, so not when the
      // page has a form-action rule (as far as the shell can see: the
      // refusing policy and <meta> ones). WebKit sends POST ones through
      // routeCard, in the click.
      const formAction = [event.originalPolicy, ...cspCopied].some((policy) => /(^|;)\s*form-action\b/i.test(policy ?? ''));
      if (match.method === 'get' && match.asLink && !formAction && document.readyState !== 'complete') return goTop({ url: match.href, type: 'push' });
      return goTop({ url: match.action, type: 'push', fields: match.fields, method: match.method, enctype: match.enctype });
    }
    if (match?.kind === 'link') {
      const { href, button, metaKey, shiftKey, altKey } = match;
      if (metaKey || button === 1) {
        log('opening as Safari would a ⌘-clicked link the page\'s CSP refused in the card:', href);
        if (!api?.runtime?.id) return; // Margin was reloaded since this page loaded
        return void api.runtime.sendMessage({ type: 'openLink', url: href, window: metaKey && altKey, active: shiftKey }).catch(() => {});
      }
      if (altKey) return L.topOnly(href) || new URL(href).origin === origin ? saveFrom(href, '') : undefined;
      if (shiftKey) return; // Reading List: extensions can't add to it; at least don't navigate
      log('redoing at the top a link the page\'s CSP refused in the card:', href);
      return goTop({ url: href, type: 'push', link: match.referrer });
    }
    // Not something the user activated: a script navigation, meta refresh or
    // reload. Only a same-origin one is reported in full.
    if (!L.routable(reported) || new URL(reported).origin !== origin || reported === origin) return log('left alone a navigation the page\'s CSP refused in the card:', reported);
    log('redoing at the top a navigation the page\'s CSP refused in the card:', reported);
    goTop({ url: reported, type: reported === card.location.href.split('#')[0] ? 'reload' : 'push', anchor: false });
  }

  let transplanted = false;

  // Chrome: content/shell-writer.js writes it (and sets the card up), in this
  // same task; it says how that went on <html>.
  function writeFromPage(html) {
    dispatchEvent(new CustomEvent('margin-shell-write', { detail: html }));
    const result = shell.getAttribute('data-margin-written');
    shell.removeAttribute('data-margin-written');
    if (result !== 'ok') throw new Error(`page-world write: ${result ?? 'no writer'}`);
  }

  function fail(why) {
    log('could not fit this page, reloading it without:', why);
    release('failed');
    optOut(href);
    // A Trusted Types policy the probe couldn't see (a <meta> CSP): the
    // whole site, so it reloads once, not on every page.
    if (/TrustedHTML/.test(String(why))) optOut(`origin:${self.origin}`);
    ownNavigation = true;
    location.reload();
  }

  // Null when there's nothing to wait for.
  function waitForStyles(doc, maxMs) {
    // Not links without an href (GitHub's lazy ones): they never load or fail.
    const links = [...doc.querySelectorAll('link[rel~="stylesheet"][href]:not([href=""])')].filter((l) => !l.sheet && !l.disabled);
    if (!links.length) return null;
    // A stylesheet the page's CSP blocks fires neither event in WebKit; its
    // violation says it's settled (blockedURI is just the origin for some).
    const blocked = new Map();
    const onViolation = (event) => {
      if (event.disposition === 'report' || !/^(style-src(-elem)?|default-src)$/.test(event.effectiveDirective)) return;
      const uri = event.blockedURI;
      for (const [link, done] of blocked) {
        const href = link.href.split('#')[0];
        if (href === uri || (uri && !/^https?:\/\/[^/]+\//.test(uri) && href.startsWith(`${uri}/`))) done();
      }
    };
    doc.addEventListener('securitypolicyviolation', onViolation, true);
    const loaded = links.map((l) => new Promise((resolve) => {
      l.addEventListener('load', resolve, { once: true });
      l.addEventListener('error', resolve, { once: true });
      blocked.set(l, resolve);
    }));
    return Promise.race([Promise.all(loaded), new Promise((resolve) => setTimeout(resolve, maxMs))])
      .finally(() => doc.removeEventListener('securitypolicyviolation', onViolation, true));
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
      for (let el = /** @type {Element} */ (walker.nextNode()); el; el = /** @type {Element} */ (walker.nextNode())) {
        if (el.localName === 'form') break;
        if (!el.matches(FORM_CONTROLS) || el.closest('form') || el.hasAttribute('form')) continue;
        if (!form.id) form.id = `margin-form-${++n}`;
        el.setAttribute('form', form.id);
      }
    }
  }

  // Load hold. Safari keeps showing the previous page until the new one is
  // visually non-empty (the hidden shell never is) or has finished loading.
  // The shell's own load is done once its parser is (the card's requests
  // aren't counted: the card's frame had finished loading its empty document
  // before the page was written into it), so without this Safari showed the
  // still-hidden shell, blank, while the page's stylesheets loaded. The same
  // stylesheets linked from the shell too, for no media, keep its load going
  // until they're in. They share the page's requests (WebKit reuses its
  // preloads and loads in flight), so nothing is fetched twice.
  const loadHolds = new Map();
  function holdLoad(links, resolve) {
    if (!held) return;
    for (const link of links) {
      if (link.disabled || /(^|\s)alternate(\s|$)/i.test(link.rel) || link.sheet) continue;
      let href;
      try {
        href = resolve(link);
      } catch {
        continue;
      }
      if (!/^https?:/.test(href) || loadHolds.has(href)) continue;
      const hold = document.createElement('link');
      hold.rel = 'stylesheet';
      hold.media = 'not all';
      if (link.crossOrigin != null) hold.crossOrigin = link.crossOrigin;
      if (link.integrity) hold.integrity = link.integrity;
      if (link.referrerPolicy) hold.referrerPolicy = link.referrerPolicy;
      if (link.nonce) hold.nonce = link.nonce;
      hold.href = href;
      own(hold);
      head.append(hold);
      loadHolds.set(href, hold);
    }
  }

  async function transplant() {
    if (transplanted) return;
    transplanted = true;
    parseObserver.disconnect();
    mirror(old);
    // Written in this same task when the card is ready (it usually is), so
    // the shell's load can't finish before the page is in the card.
    // Otherwise through the wait, the links in the parsed tree hold it (it
    // isn't in the document, so its <base> is applied by hand).
    // Not when the page has a <meta> CSP: the shell only gets it once the
    // card exists, and a hold must not fetch what the page's policy blocks.
    if (!frameReady) {
      const base = old.querySelector('base[href]')?.getAttribute('href');
      const baseUrl = base ? new URL(base, location.href).href : location.href;
      const metaCsp = [.../** @type {NodeListOf<HTMLMetaElement>} */ (old.querySelectorAll('meta[http-equiv]'))].some((meta) => meta.httpEquiv.toLowerCase() === 'content-security-policy');
      if (!metaCsp) holdLoad(old.querySelectorAll('link[rel~="stylesheet"][href]'), (link) => new URL(link.getAttribute('href'), baseUrl).href);
      await frameLoaded;
      // One task later: written straight from the frame's load handler, the
      // card would never fire its own load event (window.onload).
      await new Promise((resolve) => setTimeout(resolve));
    }
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
      win.addEventListener('margin-page-ready', () => log('page-side script active in the card'), { once: true });
      watchPrintKey(win);
      Margin.content?.cardReady?.(win, frame);
      if (platform?.shellPageWrite) writeFromPage(html);
      else {
        doc.write(html);
        doc.close();
      }
    } catch (err) {
      return fail(err);
    }
    // Lets the detached tree go.
    old.replaceChildren();

    // Scroll to the fragment the normal way (same URL: no hashchange).
    // (Chrome: the writer did, without the popstate that fires there.)
    if (location.hash && !platform?.shellPageWrite) win.location.replace(location.href);
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

    // The page's <meta> CSP into the shell first (mirror), so the holds obey it.
    mirror(doc.documentElement);
    holdLoad(doc.querySelectorAll('link[rel~="stylesheet"][href]'), (link) => link.href);
    const styles = waitForStyles(doc, 1500);
    if (styles) await styles;
    // The page's canvas (white, or dark for a dark color-scheme) behind it,
    // not Margin's gray, for pages without a background of their own.
    const scheme = win.getComputedStyle(doc.documentElement).colorScheme || 'normal';
    frame.style.setProperty('color-scheme', scheme);
    shell.style.setProperty('color-scheme', scheme); // the shell's canvas behind the card, the same
    // Right away, not in a frame callback: WebKit doesn't render a hidden
    // document until its load event, so one would wait for every image.
    release('page ready');
    // Settled in the card (used, or stayed): not a reload loop (see loopCheck).
    // A ⌘R or a click counts as used, so reloading a page by hand never trips it.
    const settled = () => {
      if (readJson(LOOP_KEY)?.url === page) writeJson(LOOP_KEY, null);
    };
    setTimeout(settled, SETTLED_MS);
    for (const type of ['pointerdown', 'keydown']) win.addEventListener(type, settled, { capture: true, once: true });

    // Scroll back to where the page was, after a reload or a Back without
    // the page cache.
    const type = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType?.('navigation')?.[0])?.type;
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
    // Called by content/core.js on every layout change: { docked, width,
    // inset, radius } (any of them).
    setLayout(next) {
      for (const [key, value] of Object.entries(next)) if (value != null) layout[key] = value;
      applyLayout();
    },
    cardLeft: () => (layout.docked ? layout.width : 0),
    cardTop: () => (layout.docked ? layout.inset : 0),
    focusCard: () => card?.focus(),
  };
  log('taking over');
})();
