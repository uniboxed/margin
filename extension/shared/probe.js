// Injection probe: the go/no-go test for the "transplant shell"
// (research/viewport/synthesis.md, "Must verify on real Safari" step 1).
// The shell has to take over the page before the parser adds anything to
// <html>, so it only works if Safari runs document_start content scripts
// while <html> is still empty. Two copies record what <html> held when they
// ran: the manifest content script (content/sidebar.js) and a registered one
// (content/probe-registered.js), since the shell would be registered and
// Safari loads registered scripts after the manifest's. The background keeps
// the records for diag/probe.html. Classic script; everything but snapshot()
// is pure and importable from node for tests.
(() => {
  const Margin = (globalThis.Margin ??= {});

  const MAX = 500; // records kept (storage.session, cleared when Safari quits)
  const SOURCES = ['manifest', 'registered'];

  // Nodes only the HTML parser puts directly in <html>: if any is there, the
  // page has started parsing. Anything else (a <style>, <script> or custom
  // element, Margin's own hosts included) was added by a content script.
  const PARSED = new Set(['HEAD', 'BODY', '#COMMENT', '#TEXT']); // compared uppercased

  //   pass      <html> was empty: a takeover could happen before any page node
  //   foreign   only nodes content scripts added; still before the parser
  //   late      the parser had already added nodes: too late for a takeover
  //   existing  the page had finished parsing: Safari injects into pages that
  //             are already open when Margin loads or gets site access
  //   n/a       not text/html (PDF, image, video, text, XML)
  //   bfcache   restored from the back-forward cache: no injection happens
  function verdict(record) {
    if (record.restored) return 'bfcache';
    if (!record.html || (record.contentType && record.contentType !== 'text/html')) return 'n/a';
    if (record.ready && record.ready !== 'loading') return 'existing';
    const kids = record.kids ?? [];
    if (!kids.length) return 'pass';
    return kids.some((k) => PARSED.has(String(k).toUpperCase())) ? 'late' : 'foreign';
  }

  // What <html> holds right now, plus the navigation it belongs to. Query
  // and hash are left out of the URL.
  function snapshot(source) {
    const root = document.documentElement;
    const nav = performance.getEntriesByType?.('navigation')?.[0];
    return {
      source,
      injected: performance.now(),
      html: root instanceof HTMLHtmlElement,
      kids: root ? [...root.childNodes].map((n) => n.nodeName) : [],
      elements: document.getElementsByTagName('*').length,
      ready: document.readyState,
      contentType: document.contentType,
      nav: nav?.type,
      responseStart: nav?.responseStart,
      url: location.origin + location.pathname,
    };
  }

  // A stored record: the snapshot plus the verdict and how long after the
  // first response byte the script ran.
  function entry(record, { tabId = null, at = 0 } = {}) {
    const afterFirstByte = Number.isFinite(record.injected) && record.responseStart > 0 ? Math.round(record.injected - record.responseStart) : null;
    return { source: 'manifest', ...record, verdict: verdict(record), afterFirstByte, tabId, at };
  }

  const ms = (n) => (Number.isFinite(n) ? `${Math.round(n)}` : '–');

  function line(e) {
    const head = `${e.source.padEnd(10)} ${e.verdict.padEnd(8)}`;
    if (e.verdict === 'bfcache') return `${head} restored from back-forward cache  ${e.url}`;
    const kids = e.kids?.length ? e.kids.join(',') : '';
    return (
      `${head} kids=[${kids}] ready=${e.ready} injected=${ms(e.injected)}ms` +
      ` firstByte=${ms(e.responseStart)}ms (+${ms(e.afterFirstByte)}) nav=${e.nav ?? '–'} type=${e.contentType ?? '–'} ${e.url}`
    );
  }

  // Counts per verdict for one source. Only pass, foreign and late are real
  // document_start injections into HTML; "early" is the pass + foreign share.
  function summary(entries, source = 'manifest') {
    const counts = { pass: 0, foreign: 0, late: 0, existing: 0, 'n/a': 0, bfcache: 0 };
    for (const e of entries) if ((e.source ?? 'manifest') === source) counts[e.verdict] = (counts[e.verdict] ?? 0) + 1;
    const injections = counts.pass + counts.foreign + counts.late;
    return { counts, injections, early: counts.pass + counts.foreign };
  }

  function summaryLine(entries, source) {
    const { counts, injections, early } = summary(entries, source);
    return (
      `${source}: ${early}/${injections} before the parser (pass ${counts.pass}, foreign ${counts.foreign}, late ${counts.late})` +
      ` · existing ${counts.existing} · n/a ${counts['n/a']} · bfcache ${counts.bfcache}`
    );
  }

  function report(entries, { userAgent = '' } = {}) {
    return [`Margin injection probe — ${userAgent}`, ...SOURCES.map((s) => summaryLine(entries, s)), '', ...entries.map(line)].join('\n');
  }

  Margin.probe = { MAX, SOURCES, verdict, snapshot, entry, line, summary, summaryLine, report };
})();
