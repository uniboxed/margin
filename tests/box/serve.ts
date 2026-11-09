// The page patterns the box handles (patterns/*.html, README.md), read and served.
// One server answers both runners: the e2e site's (tests/e2e/site/server.ts, host
// box.test) and the WebKit host's (tools/webkit-host/server.mts, under /box/).
//   /pattern/<name>          the pattern's page, as it is
//   /ref/<name>?w=..&h=..    its plain reference: the page in an iframe w×h, a
//                            plain window of the box's size (what tests/box/rules.ts
//                            compares the boxed page with)
//   /bench/<rules>/<els>     a heavy page for the box's benchmark (bench.mts): that many
//                            rules (vw units, media queries) and elements; …/link: the
//                            rules in a linked sheet (/bench-css/<rules>/<els>)
//   /asset/<file>            a file a pattern's page loads (patterns/assets/: a style
//                            sheet, a script), as a site's own files are; ?wait=N:
//                            its content N ms late, as a slow server's
// In a pattern's page, `{{other}}` is another origin serving the same files (a CDN's,
// with no CORS): `{{other}}/asset/<file>`. Each server says what it is (`other`).
// `<!--pause:N-->` in a pattern's page: the server sends what's before it, then the
// rest N ms later, as a slow site's page arrives in parts (`parts`).
//
// A pattern's header is the HTML comment its file starts with, a field a line:
//   pattern:    what pages do, and what the box keeps true for them, in a line (required)
//   from:       where it was first seen: a site, a fit-check round, a report (required)
//   handled-by: the file(s) of the box that handle it
//   settle:     ms after the page's load to wait before measuring (default 500)
//   allow:      what the pattern is let off, comma-separated: a rule (tests/box/rules.ts RULES),
//               or a rule and one element's or output's key (`same-layout #ad`)
//   engines:    chromium, webkit or both (default both)
//   note:       why it's let off something, or anything else to know
// A field's text can go on over the following lines, indented.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const PATTERNS_DIR = fileURLToPath(new URL('./patterns/', import.meta.url));
const ASSETS_DIR = join(PATTERNS_DIR, 'assets');
const ASSET = /^[a-z0-9][a-z0-9-]*\.(css|js)$/;
const TYPES = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8' };
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const FIELDS = new Set(['pattern', 'from', 'handled-by', 'settle', 'allow', 'engines', 'note']);

export function parseHeader(html: string) {
  const m = /^\s*<!--([\s\S]*?)-->/.exec(html);
  if (!m) throw new Error('no header comment at the top');
  const fields: Record<string, string> = {};
  let last = null;
  for (const line of m[1].split('\n')) {
    const f = /^([a-z-]+):\s*(.*)$/.exec(line.trim());
    if (f && FIELDS.has(f[1])) { fields[f[1]] = f[2].trim(); last = f[1]; continue; }
    if (last && line.trim()) fields[last] += ` ${line.trim()}`;
  }
  for (const need of ['pattern', 'from']) if (!fields[need]) throw new Error(`no "${need}:" in its header`);
  const engines = (fields.engines || 'both').trim();
  if (!['both', 'chromium', 'webkit'].includes(engines)) throw new Error(`engines: both, chromium or webkit, not "${engines}"`);
  const settle = fields.settle ? Number(fields.settle) : 500;
  if (!(settle >= 0 && settle <= 10_000)) throw new Error(`settle: ms from 0 to 10000, not "${fields.settle}"`);
  const allow = (fields.allow || '').split(',').map((s) => s.trim().replace(/\s+/, ' ')).filter(Boolean);
  return { title: fields.pattern, from: fields.from, handledBy: fields['handled-by'] || '', note: fields.note || '', settle, allow, engines };
}

/** The heavy page's style sheet (benchPage). */
export function benchCss(rules: number, elements: number) {
  const css = [];
  for (let i = 0; i < rules; i++) {
    const rule = i % 5 === 0 ? `.c${i % elements} { width: ${(i % 90) + 10}vw; margin-left: calc(${i % 7}vw - 2px); }`
      : `.c${i % elements} > span, .c${i % elements}:hover { color: rgb(${i % 255}, 0, 0); padding: ${i % 9}px; }`;
    css.push(i % 10 === 0 ? `@media (min-width: ${600 + (i % 900)}px) { ${rule} }` : rule);
  }
  return css.join('\n');
}

/**
 * A heavy page: `rules` rules, a fifth with viewport units and a tenth in media queries about the width (what the
 * box rewrites), and `elements` elements they style. It notes, as it loads, how long from `load` to its next two
 * frames (`window.__bench`): what the box's work after load costs a page, plus the page's own. `link`: the
 * rules in a sheet of their own (/bench-css/), whose text the box can't see, as on most large sites.
 */
export function benchPage(rules: number, elements: number, link: boolean = false) {
  const sheet = link ? `<link rel="stylesheet" href="../../../bench-css/${rules}/${elements}">` : `<style>${benchCss(rules, elements)}</style>`;
  const els = Array.from({ length: elements }, (_, i) => `<div class="c${i}"><span>${i}</span></div>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>bench ${rules}/${elements}</title>${sheet}
<script>addEventListener('load', () => { const t = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => { window.__bench = { loadMs: Math.round(t), frameMs: Math.round(performance.now() - t) }; })); });</script></head><body>${els}</body></html>`;
}

/** A page in the parts its pauses make: [{ text, wait }], each sent `wait` ms after the one before. */
export function partsOf(body: string) {
  const parts = [];
  let wait = 0;
  let from = 0;
  for (const m of body.matchAll(/<!--pause:(\d{1,4})-->/g)) {
    parts.push({ text: body.slice(from, m.index), wait });
    wait = Math.min(Number(m[1]), 5000);
    from = m.index + m[0].length;
  }
  parts.push({ text: body.slice(from), wait });
  return parts;
}

/** Every pattern, by name (its file's), in name order. */
export function listPatterns() {
  return readdirSync(PATTERNS_DIR).filter((f) => f.endsWith('.html')).sort().map((f) => {
    const name = f.slice(0, -5);
    if (!NAME.test(name)) throw new Error(`${f}: a pattern's name is lowercase letters, digits and dashes`);
    const html = readFileSync(join(PATTERNS_DIR, f), 'utf8');
    try { return { name, ...parseHeader(html), html }; } catch (e) { throw new Error(`${f}: ${e.message}`); }
  });
}

/**
 * A response for `path` (and its query), or null if it isn't one of these.
 * `other`: another origin's address for the same files, put in for `{{other}}`.
 * */
export function boxPage(path: string, query: URLSearchParams, { other = '' }: { other?: string } = {}): { type: string, body: string } | null {
  const p = /^\/pattern\/([a-z0-9-]+)$/.exec(path);
  if (p && NAME.test(p[1])) {
    let body;
    try { body = readFileSync(join(PATTERNS_DIR, `${p[1]}.html`), 'utf8').replaceAll('{{other}}', other); } catch { return null; }
    return { type: 'text/html; charset=utf-8', body, parts: partsOf(body) };
  }
  const b = /^\/bench(-css)?\/(\d{1,6})\/(\d{1,6})(\/link)?$/.exec(path);
  if (b) {
    const rules = Math.min(Number(b[2]), 200_000);
    const elements = Math.min(Number(b[3]), 50_000);
    if (b[1]) return { type: 'text/css; charset=utf-8', body: benchCss(rules, elements) };
    return { type: 'text/html; charset=utf-8', body: benchPage(rules, elements, !!b[4]) };
  }
  const a = /^\/asset\/([^/]+)$/.exec(path);
  if (a && ASSET.test(a[1])) {
    let body;
    try { body = readFileSync(join(ASSETS_DIR, a[1]), 'utf8'); } catch { return null; }
    // `?wait=N`: its content N ms after its headers, as a slow server's (a sheet still loading as <body> comes).
    const wait = Math.min(Number(query.get('wait')) || 0, 5000);
    return { type: TYPES[a[1].split('.').pop()], body, ...(wait > 0 ? { parts: [{ text: '', wait: 0 }, { text: body, wait }] } : {}) };
  }
  const r = /^\/ref\/([a-z0-9-]+)$/.exec(path);
  if (r && NAME.test(r[1])) {
    const w = Math.round(Number(query.get('w')));
    const h = Math.round(Number(query.get('h')));
    if (!(w > 0 && h > 0)) return null;
    return { type: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><title>plain: ${r[1]}</title><style>html,body{margin:0}iframe{position:absolute;left:0;top:0;width:${w}px;height:${h}px;border:0}</style></head><body><iframe id="plain" src="../pattern/${r[1]}"></iframe></body></html>` };
  }
  return null;
}
