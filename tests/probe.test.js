import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../extension/shared/probe.js';

const { verdict, entry, summary, summaryLine, report, line } = globalThis.Margin.probe;
const html = (kids, extra = {}) => ({ html: true, kids, ready: 'loading', contentType: 'text/html', ...extra });

test('an empty <html> passes; parser-made children are late', () => {
  assert.equal(verdict(html([])), 'pass');
  for (const kids of [['HEAD'], ['HEAD', 'BODY'], ['#comment'], ['#text'], ['head']]) assert.equal(verdict(html(kids)), 'late', kids.join());
});

test('nodes only content scripts add are foreign, not late', () => {
  assert.equal(verdict(html(['STYLE'])), 'foreign');
  assert.equal(verdict(html(['MARGIN-SIDEBAR-HOST', 'DARK-READER'])), 'foreign');
  assert.equal(verdict(html(['STYLE', 'HEAD'])), 'late');
});

test('injections into pages that already loaded are kept apart', () => {
  assert.equal(verdict(html(['HEAD', '#text', 'BODY'], { ready: 'complete' })), 'existing');
  assert.equal(verdict(html(['HEAD', 'BODY'], { ready: 'interactive' })), 'existing');
});

test('only text/html counts: PDFs, images, video and text are n/a', () => {
  assert.equal(verdict(html(['HEAD'], { contentType: 'application/pdf' })), 'n/a', 'PDF viewer appends <head> before injecting');
  assert.equal(verdict(html([], { contentType: 'image/png' })), 'n/a');
  assert.equal(verdict(html([], { contentType: 'text/plain' })), 'n/a');
  assert.equal(verdict({ html: false, kids: [], ready: 'loading' }), 'n/a');
  assert.equal(verdict({ restored: true }), 'bfcache');
});

test('entries measure injection from the first response byte', () => {
  const e = entry(html([], { injected: 212.4, responseStart: 205.1, nav: 'navigate', url: 'https://a.com/' }), { tabId: 3, at: 9 });
  assert.equal(e.verdict, 'pass');
  assert.equal(e.source, 'manifest');
  assert.equal(e.afterFirstByte, 7);
  assert.equal(e.tabId, 3);
  assert.equal(entry(html([], { injected: 5, responseStart: 0 })).afterFirstByte, null);
  assert.match(line(e), /^manifest +pass +kids=\[\] ready=loading injected=212ms firstByte=205ms \(\+7\) nav=navigate type=text\/html https:\/\/a\.com\/$/);
});

test('summaries count real injections per source', () => {
  const entries = [
    html([]),
    html(['STYLE']),
    html(['HEAD']),
    html(['HEAD', 'BODY'], { ready: 'complete' }),
    html(['HEAD'], { contentType: 'application/pdf' }),
    { restored: true },
    html(['MARGIN-SIDEBAR-HOST'], { source: 'registered' }),
  ].map((r) => entry(r));
  const s = summary(entries);
  assert.deepEqual(s.counts, { pass: 1, foreign: 1, late: 1, existing: 1, 'n/a': 1, bfcache: 1 });
  assert.equal(s.injections, 3);
  assert.equal(s.early, 2);
  assert.deepEqual(summary(entries, 'registered').counts.foreign, 1);
  assert.equal(summaryLine(entries, 'registered'), 'registered: 1/1 before the parser (pass 0, foreign 1, late 0) · existing 0 · n/a 0 · bfcache 0');
  assert.match(report(entries, { userAgent: 'UA' }), /^Margin injection probe — UA\nmanifest: 2\/3 before the parser .*existing 1.*\nregistered: 1\/1/);
});
