// The page patterns the box handles (patterns/*.html, README.md), read and served.
// One server answers both runners: the e2e site's (tests/e2e/site/server.js, host
// box.test) and the WebKit host's (tools/webkit-host/server.mjs, under /box/).
//   /pattern/<name>          the pattern's page, as it is
//   /ref/<name>?w=..&h=..    its plain reference: the page in an iframe w×h, a
//                            plain window of the box's size (what tests/box/rules.js
//                            compares the boxed page with)
//   /asset/<file>            a file a pattern's page loads (patterns/assets/: a style
//                            sheet, a script), as a site's own files are
// In a pattern's page, `{{other}}` is another origin serving the same files (a CDN's,
// with no CORS): `{{other}}/asset/<file>`. Each server says what it is (`other`).
//
// A pattern's header is the HTML comment its file starts with, a field a line:
//   pattern:    what pages do, and what the box keeps true for them, in a line (required)
//   from:       where it was first seen: a site, a fit-check round, a report (required)
//   handled-by: the file(s) of the box that handle it
//   settle:     ms after the page's load to wait before measuring (default 500)
//   allow:      what the pattern is let off, comma-separated: a rule (tests/box/rules.js RULES),
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

/** @param {string} html */
export function parseHeader(html) {
  const m = /^\s*<!--([\s\S]*?)-->/.exec(html);
  if (!m) throw new Error('no header comment at the top');
  /** @type {Record<string, string>} */
  const fields = {};
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
 * @param {string} path @param {URLSearchParams} query @param {{ other?: string }} [options]
 * @returns {{ type: string, body: string } | null}
 */
export function boxPage(path, query, { other = '' } = {}) {
  const p = /^\/pattern\/([a-z0-9-]+)$/.exec(path);
  if (p && NAME.test(p[1])) {
    try { return { type: 'text/html; charset=utf-8', body: readFileSync(join(PATTERNS_DIR, `${p[1]}.html`), 'utf8').replaceAll('{{other}}', other) }; } catch { return null; }
  }
  const a = /^\/asset\/([^/]+)$/.exec(path);
  if (a && ASSET.test(a[1])) {
    try { return { type: TYPES[a[1].split('.').pop()], body: readFileSync(join(ASSETS_DIR, a[1]), 'utf8') }; } catch { return null; }
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
