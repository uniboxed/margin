// Pure helpers for the fitted layout (content/shell.js): the page is moved
// into a frame beside the sidebar so it gets a truly narrower viewport.
// Classic script, no browser APIs: also importable from node for tests.
(() => {
  const Margin = (globalThis.Margin ??= {});

  // Nodes only the HTML parser puts directly in <html> (compared uppercased).
  // Anything else there (a <style>, Margin's own hosts) came from content
  // scripts, which run before the parser adds anything.
  const PARSED = new Set(['HEAD', 'BODY', 'FRAMESET', '#COMMENT', '#TEXT']);

  // Why this load can't be fitted, or null if it can. Checked synchronously
  // at document_start, before the parser has added anything to <html>.
  function skipReason(p) {
    if (!p.enabled) return 'not this browser';
    if (!p.isTop) return 'not the top frame';
    if (!p.isHtml || p.contentType !== 'text/html') return `not an HTML page (${p.contentType || 'unknown type'})`;
    // A frame Margin writes is always UTF-8: links and forms on a page in
    // another encoding would send the wrong bytes.
    if (String(p.charset).toUpperCase() !== 'UTF-8') return `encoding ${p.charset}`;
    if (p.ready !== 'loading') return 'injected after the page loaded';
    if ((p.kids ?? []).some((k) => PARSED.has(String(k).toUpperCase()))) return 'injected after parsing started';
    if (!p.navigationApi) return 'no Navigation API (Safari 26.2+)';
    if (p.hasOpener) return 'a popup (opened by another page)';
    if (p.origin === 'null') return 'sandboxed page';
    if (p.crossOriginIsolated) return 'cross-origin isolated page';
    // A srcdoc frame is always in standards mode (WebKit
    // HTMLConstructionSite), whatever doctype is written into it.
    if (p.compatMode === 'BackCompat' || limitedQuirks(p.doctype)) return 'quirks-mode page';
    if (p.optedOut) return 'turned off for this page (loop breaker or a failed fit)';
    return null;
  }

  // Doctypes that put a page in limited-quirks mode (HTML spec; compatMode
  // still says CSS1Compat), which a srcdoc frame also ignores.
  function limitedQuirks(doctype) {
    const pub = String(doctype?.publicId ?? '').toLowerCase();
    const sys = String(doctype?.systemId ?? '');
    if (pub.startsWith('-//w3c//dtd xhtml 1.0 transitional//') || pub.startsWith('-//w3c//dtd xhtml 1.0 frameset//')) return true;
    return !!sys && (pub.startsWith('-//w3c//dtd html 4.01 transitional//') || pub.startsWith('-//w3c//dtd html 4.01 frameset//'));
  }

  // Loop breaker: building the shell this often for one URL, without the page
  // ever settling in the card in between (content/shell.js clears the count
  // once it has), means something keeps reloading it (e.g. a frame-busting
  // script Margin can't stop).
  const LOOP = { count: 3, windowMs: 5000 };
  // `times`: earlier build times for this URL. Returns the list to store
  // (including now) and whether to stop fitting it.
  function loopCheck(times, now) {
    const recent = (Array.isArray(times) ? times : []).filter((t) => Number.isFinite(t) && now - t < LOOP.windowMs);
    recent.push(now);
    return { times: recent, tooMany: recent.length >= LOOP.count };
  }

  function doctypeString(dt) {
    if (!dt?.name) return '';
    let s = `<!DOCTYPE ${dt.name}`;
    if (dt.publicId) s += ` PUBLIC "${dt.publicId}"`;
    if (dt.systemId) s += dt.publicId ? ` "${dt.systemId}"` : ` SYSTEM "${dt.systemId}"`;
    return `${s}>`;
  }

  const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  // The page as the browser parsed it, ready for document.write: its own
  // doctype, <html>'s attributes and its contents. (Quirks-mode pages are
  // skipped: a srcdoc frame ignores the doctype's mode.)
  function serialize({ doctype = '', attrs = [], inner = '' }) {
    const a = attrs.map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join('');
    return `${doctype}<html${a}>${inner}</html>`;
  }

  // Input types WebKit treats as text fields (what password managers read
  // from a submitted form); everything else is rebuilt as hidden.
  const TEXT_TYPES = new Set(['text', 'password', 'email', 'search', 'tel', 'url', 'number']);

  // A POST from the frame, redone as a top-level form: [{ name, value, type }],
  // and { name, file, type: 'file' } for file entries (content/shell.js puts
  // the File back with a DataTransfer).
  function postFields(entries, typeOf = () => 'hidden') {
    const fields = [];
    for (const [name, value] of entries) {
      if (typeof value !== 'string') {
        fields.push({ name, file: value, type: 'file' });
        continue;
      }
      const t = String(typeOf(name) || '').toLowerCase();
      fields.push({ name, value, type: TEXT_TYPES.has(t) ? t : 'hidden' });
    }
    return fields;
  }

  // Frame busting ("top.location = self.location"): a script navigation of
  // the top window to the page it's already on.
  function isBust({ destination, current, type }) {
    if (type !== 'push' && type !== 'replace') return false;
    const strip = (u) => String(u).split('#')[0];
    return strip(destination) === strip(current);
  }

  // Which links and forms Margin redoes at the top: web pages only (mailto:,
  // app links and the like are left to the browser).
  const routable = (url) => /^https?:/i.test(String(url));
  // Also sent to the top, where WebKit's top-level rules decide them as
  // without the shell (a data: page must not show under the site's address).
  const topOnly = (url) => /^(data|blob):/i.test(String(url));

  // A click the browser would turn into a navigation of the card itself (not
  // a new tab, window or download), so Margin must redo it at the top before
  // the page's frame-src CSP refuses it. `target` is the link's (or the
  // page's <base target>).
  function cardNavigatingClick({ button, metaKey, ctrlKey, shiftKey, altKey, download, target }) {
    if (button !== 0 || metaKey || ctrlKey || shiftKey || altKey || download) return false;
    const t = String(target ?? '').toLowerCase();
    return t === '' || t === '_self';
  }

  // How WebKit reports a URL a frame-src rule refused (ContentSecurityPolicy::
  // createURLForReporting): another origin's as just that origin, one of the
  // page's own without its fragment (and credentials), data: or blob: as the
  // bare scheme. `origin` is the page's.
  function reportKey(url, origin) {
    try {
      const u = new URL(url);
      if (u.protocol === 'data:' || u.protocol === 'blob:') return u.protocol.slice(0, -1);
      if (u.origin !== origin) return u.origin;
      u.hash = '';
      u.username = '';
      u.password = '';
      return u.href;
    } catch {
      return '';
    }
  }

  // A GET form submission's URL: the action with its query replaced by the
  // form data (files by name), as the browser builds it.
  function getSubmissionUrl(action, entries) {
    const url = new URL(action);
    const params = new URLSearchParams();
    // Line breaks as a form sends them (CRLF).
    const crlf = (text) => String(text).replace(/\r\n|\r|\n/g, '\r\n');
    for (const [name, value] of entries) params.append(crlf(name), crlf(typeof value === 'string' ? value : value?.name ?? ''));
    url.search = params.toString();
    return url.href;
  }

  // The URL patterns that turn the fitted layout off for these origins
  // (registerContentScripts excludeMatches).
  function excludePatterns(origins) {
    const out = [];
    for (const origin of origins ?? []) {
      try {
        const u = new URL(origin);
        if (/^https?:$/.test(u.protocol)) out.push(`${u.protocol}//${u.hostname}/*`);
      } catch {}
    }
    return [...new Set(out)];
  }

  Margin.shellLogic = { PARSED, LOOP, skipReason, loopCheck, doctypeString, serialize, postFields, isBust, routable, topOnly, cardNavigatingClick, reportKey, getSubmissionUrl, excludePatterns, TEXT_TYPES };
})();
