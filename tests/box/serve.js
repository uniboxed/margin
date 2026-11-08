// The box's cases (cases/*.html, README.md), read and served. One server answers
// both runners: the e2e site's (tests/e2e/site/server.js, host box.test) and the
// WebKit host's (tools/webkit-host/server.mjs, under /box/).
//   /case/<name>             the case's page, as it is
//   /ref/<name>?w=..&h=..    its plain reference: the case in an iframe w×h, a
//                            plain window of the box's size (what tests/box/rules.js
//                            compares the boxed page with)
//
// A case's header is the HTML comment its file starts with, a field a line:
//   case:       what it's about, in a line (required)
//   from:       where it came from: a site, a fit-check round, a report (required)
//   handled-by: the file(s) of the box that handle it
//   settle:     ms after the page's load to wait before measuring (default 500)
//   allow:      what the case is let off, comma-separated: a rule (tests/box/rules.js RULES),
//               or a rule and one element's or output's key (`same-layout #ad`)
//   engines:    chromium, webkit or both (default both)
//   note:       why the case is let off something, or anything else to know
// A field's text can go on over the following lines, indented.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const CASES_DIR = fileURLToPath(new URL('./cases/', import.meta.url));
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const FIELDS = new Set(['case', 'from', 'handled-by', 'settle', 'allow', 'engines', 'note']);

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
  for (const need of ['case', 'from']) if (!fields[need]) throw new Error(`no "${need}:" in its header`);
  const engines = (fields.engines || 'both').trim();
  if (!['both', 'chromium', 'webkit'].includes(engines)) throw new Error(`engines: both, chromium or webkit, not "${engines}"`);
  const settle = fields.settle ? Number(fields.settle) : 500;
  if (!(settle >= 0 && settle <= 10_000)) throw new Error(`settle: ms from 0 to 10000, not "${fields.settle}"`);
  const allow = (fields.allow || '').split(',').map((s) => s.trim().replace(/\s+/, ' ')).filter(Boolean);
  return { title: fields.case, from: fields.from, handledBy: fields['handled-by'] || '', note: fields.note || '', settle, allow, engines };
}

/** Every case, by name (its file's), in name order. */
export function listCases() {
  return readdirSync(CASES_DIR).filter((f) => f.endsWith('.html')).sort().map((f) => {
    const name = f.slice(0, -5);
    if (!NAME.test(name)) throw new Error(`${f}: a case's name is lowercase letters, digits and dashes`);
    const html = readFileSync(join(CASES_DIR, f), 'utf8');
    try { return { name, ...parseHeader(html), html }; } catch (e) { throw new Error(`${f}: ${e.message}`); }
  });
}

/**
 * A response for `path` (and its query), or null if it isn't one of these.
 * @param {string} path @param {URLSearchParams} query
 * @returns {{ type: string, body: string } | null}
 */
export function boxPage(path, query) {
  const c = /^\/case\/([a-z0-9-]+)$/.exec(path);
  if (c && NAME.test(c[1])) {
    try { return { type: 'text/html; charset=utf-8', body: readFileSync(join(CASES_DIR, `${c[1]}.html`), 'utf8') }; } catch { return null; }
  }
  const r = /^\/ref\/([a-z0-9-]+)$/.exec(path);
  if (r && NAME.test(r[1])) {
    const w = Math.round(Number(query.get('w')));
    const h = Math.round(Number(query.get('h')));
    if (!(w > 0 && h > 0)) return null;
    return { type: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><title>plain: ${r[1]}</title><style>html,body{margin:0}iframe{position:absolute;left:0;top:0;width:${w}px;height:${h}px;border:0}</style></head><body><iframe id="plain" src="../case/${r[1]}"></iframe></body></html>` };
  }
  return null;
}
