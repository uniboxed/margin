// margin.test: the index. A card for every page of the test site, with its
// picture, title, address and what the suite uses it for.
import { doc, esc, type RouteContext, type Site } from './common.ts';

const ICON = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#ff6a88"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><rect x="14" y="16" width="10" height="32" rx="3" fill="#fff" opacity=".9"/><rect x="28" y="16" width="22" height="32" rx="4" fill="#fff" opacity=".55"/></svg>`;

function index({ sites, link }: RouteContext) {
  const cards = sites
    .filter((s) => s.host !== 'margin.test')
    .flatMap((s) => (s.pages ?? []).map((p) => ({ site: s, ...p })))
    .map(
      ({ site, path, title, what, art }) => `<a class="card" href="${link(site.host, path)}" style="--accent:${site.look?.accent ?? '#555'}">
  <div class="shot"><img src="${art ?? ''}" alt="" loading="lazy"></div>
  <div class="info"><div class="host"><i></i>${esc(site.host)}<span>${esc(path)}</span></div><h3>${esc(title.length > 90 ? `${title.slice(0, 88)}…` : title)}</h3><p>${esc(what)}</p></div>
</a>`,
    )
    .join('\n');
  const count = sites.reduce((n, s) => n + (s.pages?.length ?? 0), 0);
  return doc({
    title: 'Margin test site',
    icon: ICON,
    css: '',
    head: `<style>${CSS}</style>`,
    body: `<header><div class="wrap"><div class="logo"><img src="/favicon.svg" alt="" width="36" height="36"> Margin test site</div><p>${count} pages on ${sites.length - 1} made-up sites, served from this Mac. Every picture is drawn, every name is invented, and nothing here reaches the network.</p></div></header>
<main class="wrap"><div class="cards">${cards}</div></main>
<footer class="wrap">Each site has its own <code>.test</code> host. Any path that isn’t there, like <a href="/missing">/missing</a>, shows that site’s 404 page.</footer>`,
  });
}

const CSS = `
* { box-sizing: border-box; }
body { margin: 0; background: #f4f3f8; color: #17151f; font: 15px/1.5 -apple-system, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
.wrap { max-width: 1240px; margin: 0 auto; padding: 0 32px; }
header { background: radial-gradient(1200px 300px at 20% -40%, #d9ceff, transparent), radial-gradient(900px 300px at 90% -60%, #ffd3dc, transparent); padding: 56px 0 36px; }
.logo { display: flex; gap: 14px; align-items: center; font: 700 34px/1 -apple-system, system-ui; letter-spacing: -.02em; }
header p { max-width: 640px; color: #5a5668; font-size: 17px; margin: 14px 0 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 22px; padding: 20px 0 40px; }
.card { background: #fff; border-radius: 16px; overflow: hidden; text-decoration: none; color: inherit; box-shadow: 0 1px 2px rgba(20, 16, 40, .06), 0 8px 24px -12px rgba(20, 16, 40, .18); transition: transform .15s, box-shadow .15s; display: flex; flex-direction: column; }
.card:hover { transform: translateY(-3px); box-shadow: 0 2px 4px rgba(20, 16, 40, .08), 0 18px 34px -14px rgba(20, 16, 40, .3); }
.shot { aspect-ratio: 16 / 9; background: #e9e7f0; overflow: hidden; }
.shot img { width: 100%; height: 100%; object-fit: cover; display: block; }
.info { padding: 14px 16px 18px; }
.host { display: flex; align-items: center; gap: 6px; font: 600 12px ui-monospace, Menlo, monospace; color: #6b6780; }
.host i { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
.host span { color: #a19db2; font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
h3 { font-size: 16px; line-height: 1.3; margin: 8px 0 6px; }
.info p { margin: 0; color: #6b6780; font-size: 13.5px; }
footer { color: #8a869a; padding-bottom: 48px; font-size: 13px; }
code { font: 12px ui-monospace, Menlo, monospace; background: #e8e6f0; padding: 1px 5px; border-radius: 4px; }
footer a { color: inherit; }
`;

export default {
  host: 'margin.test',
  name: 'Margin test site',
  look: { accent: '#7c5cff', bg: '#f4f3f8', ink: '#17151f' },
  iconLink: ICON,
  pages: [],
  assets: { '/favicon.svg': { type: 'image/svg+xml', body: FAVICON } },
  routes: [['GET', '/', index]],
} satisfies Site;
