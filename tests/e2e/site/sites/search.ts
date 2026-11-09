// search.test: the stand-in for a search engine's results. The tests catch
// an engine's address (context.route) and answer with searchResults(q):
// this site's own pages that match, with no engine's name or look. Also
// served at search.test/search?q=….
import { doc, esc, icon } from './common.ts';
import { SITES } from './index.ts';

const ICON = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#2b2d42"/><circle cx="28" cy="28" r="12" fill="none" stroke="#fff" stroke-width="6"/><path d="M37 37l11 11" stroke="#8ecae6" stroke-width="7" stroke-linecap="round"/></svg>`;

export function searchResults(q, link) {
  const query = String(q ?? '').trim();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const all = SITES.filter((s) => s.host !== 'margin.test' && s.host !== 'search.test').flatMap((s) => (s.pages ?? []).map((p) => ({ site: s, ...p })));
  const scored = all
    .map((p) => {
      const hay = `${p.title} ${p.snippet ?? ''} ${p.site.blurb ?? ''} ${p.site.name} ${p.site.host}`.toLowerCase();
      return { p, score: words.reduce((n, w) => n + (hay.includes(w) ? (p.title.toLowerCase().includes(w) ? 3 : 1) : 0), 0) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  const results = (scored.length ? scored : all.slice(0, 6).map((p) => ({ p, score: 0 }))).slice(0, 8);
  const items = results
    .map(({ p }) => {
      const href = link(p.site.host, p.path);
      return `<li><a href="${href}" class="r"><span class="where"><i style="background:${p.site.look?.accent ?? '#555'}">${esc(p.site.name[0])}</i><span><b>${esc(p.site.name)}</b><small>${esc(p.site.host)}${esc(p.path === '/' ? '' : p.path)}</small></span></span><h3>${esc(p.title)}</h3></a><p>${esc(p.snippet ?? p.site.blurb ?? '')}</p></li>`;
    })
    .join('');
  const related = ['near me', 'meaning', 'reviews', 'how to', 'open now', 'best'].map((s) => `${query || 'search'} ${s}`);
  return doc({
    title: `${query || 'Search'} - Search results`,
    icon: ICON,
    css: '',
    head: `<style>${CSS}</style>`,
    body: `<header><a class="logo" href="/" aria-label="Home">${FAVICON.replace('<svg ', '<svg width="34" height="34" ')}</a><form action="/search"><input name="q" value="${esc(query)}" aria-label="Search">${icon('search', { size: 18 })}</form><nav><a class="on">All</a><a>Images</a><a>News</a><a>Maps</a><a>Videos</a></nav></header>
<main><p class="count">About ${(results.length * 1234567).toLocaleString('en-US')} results (0.${String(results.length * 7 + 21).padStart(2, '0')} seconds)</p>
${scored.length ? '' : `<p class="none">No exact matches for <b>${esc(query)}</b>. Showing popular pages instead.</p>`}
<ol class="results">${items}</ol>
<section class="related"><h4>Related searches</h4><div>${related.map((r) => `<a href="/search?q=${encodeURIComponent(r)}">${icon('search', { size: 14 })}${esc(r)}</a>`).join('')}</div></section>
<nav class="pages"><b>1</b><a>2</a><a>3</a><a>4</a><a>5</a><a class="next">Next ${icon('chevron', { size: 14 })}</a></nav></main>`,
  });
}

const CSS = `
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.55 -apple-system, system-ui, sans-serif; color: #1f2233; background: #fff; }
header { display: grid; grid-template-columns: auto minmax(0, 640px); grid-template-rows: auto auto; gap: 14px 22px; align-items: center; padding: 22px 28px 0 28px; border-bottom: 1px solid #e7e8ee; }
.logo { display: block; line-height: 0; }
form { position: relative; }
form input { width: 100%; font: 16px -apple-system, system-ui; padding: 12px 44px 12px 20px; border-radius: 26px; border: 1px solid #dfe1e8; box-shadow: 0 1px 6px rgba(32, 33, 36, .12); outline: none; }
form svg { position: absolute; right: 16px; top: 13px; color: #4a5072; }
nav { grid-column: 2; display: flex; gap: 22px; font-size: 14px; color: #5f6377; }
nav a { padding: 8px 0 11px; cursor: pointer; }
nav a.on { color: #2b2d42; font-weight: 600; box-shadow: inset 0 -3px #2b2d42; }
main { padding: 10px 28px 60px calc(28px + 34px + 22px); max-width: 860px; }
.count { color: #70757a; font-size: 13px; }
.none { background: #f6f7fb; padding: 12px 16px; border-radius: 10px; }
.results { list-style: none; padding: 0; margin: 0; }
.results li { margin: 0 0 28px; max-width: 640px; }
.r { text-decoration: none; color: inherit; display: block; }
.where { display: flex; gap: 10px; align-items: center; margin-bottom: 4px; }
.where i { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; color: #fff; font: 700 13px -apple-system, system-ui; font-style: normal; }
.where b { display: block; font-size: 14px; font-weight: 500; line-height: 1.2; }
.where small { display: block; color: #4d5156; font-size: 12px; line-height: 1.3; }
.r h3 { font-size: 20px; font-weight: 400; color: #2742c9; margin: 0; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.r:hover h3 { text-decoration: underline; }
.results p { color: #4d5156; margin: 4px 0 0; font-size: 14px; }
.related { margin-top: 36px; }
.related h4 { font-size: 20px; font-weight: 400; margin: 0 0 14px; }
.related div { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; max-width: 640px; }
.related a { display: flex; align-items: center; gap: 10px; background: #f1f3f8; border-radius: 22px; padding: 10px 16px; text-decoration: none; color: #1f2233; font-weight: 500; }
.pages { display: flex; gap: 20px; margin: 40px 0 0; font-size: 15px; color: #2742c9; align-items: center; }
.pages b { color: #1f2233; }
.next { display: inline-flex; align-items: center; gap: 2px; }
`;

export default {
  host: 'search.test',
  name: 'Search',
  look: { accent: '#2b2d42' },
  iconLink: ICON,
  pages: [{ path: '/search?q=quiet+city', title: 'quiet city - Search results', what: 'The local stand-in for a search engine’s results', art: '/media/art/map.svg?seed=9&w=800&h=450&pins=4' }],
  assets: { '/favicon.svg': { type: 'image/svg+xml', body: FAVICON } },
  routes: [
    ['GET', '/', ({ link }) => searchResults('', (h, p) => link(h, p))],
    ['GET', '/search', ({ query, link }) => searchResults(query.get('q'), (h, p) => link(h, p))],
  ],
};
