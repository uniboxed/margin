// embed.test: Field Notes, a blog post made of embeds: a same-site frame
// (a weather card), another site's frame (maps.test, with a search field),
// a srcdoc frame (a poll) and a sandboxed frame (comments, with a text
// box). No icon link and no /favicon.ico: Margin draws a letter.
//
// maps.test: Wayfinder, a map site, full page at / and framed at /embed.
// Its icon link points at a file that isn't an image (a server that
// answers with an HTML page): a bad icon, to be refused.
import { art, avatar, doc, esc, icon } from './common.js';

function post({ link }) {
  const maps = link('maps.test', '/embed?place=harbour');
  const poll = `<!doctype html><style>body{margin:0;font:15px/1.4 -apple-system,system-ui,sans-serif;color:#2b2118;background:#fffaf1}.p{padding:18px 20px}h3{margin:0 0 12px;font-size:17px}label{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1.5px solid #ecdcc4;border-radius:10px;margin-bottom:8px;cursor:pointer;background:#fff}label:has(input:checked){border-color:#c2410c;background:#fff4ea}input{accent-color:#c2410c}button{margin-top:6px;border:0;background:#c2410c;color:#fff;font:600 14px -apple-system,system-ui;padding:9px 18px;border-radius:9px}small{color:#8a7a68;margin-left:10px}</style><div class="p"><h3>Which route should we take on Thursday?</h3><label><input type="radio" name="r" checked> The cliff path to the lighthouse</label><label><input type="radio" name="r"> Through the woods to the bay</label><label><input type="radio" name="r"> Along the river to the old mill</label><button>Vote</button><small>214 votes · closes Wednesday</small></div>`;
  const body = `
<header class="mast"><a href="/" class="logo">Field Notes</a><nav><a href="/">Essays</a><a href="/">Walks</a><a href="/">Maps</a><a href="/">About</a></nav></header>
<main class="post">
  <p class="kicker">Walks · 6 November 2026</p>
  <h1>Planning a coast walk, with a little help from the internet</h1>
  <div class="by"><img src="${avatar('Ruth Calloway')}" alt="" width="40" height="40"><span>Ruth Calloway · 6 min read</span></div>
  <p class="lead">Every walk I plan now starts the same way: a forecast, a map, an argument about the route and a long thread of comments from people who know better. This week’s, embedded below, as it happened.</p>
  <h2>First, the weather</h2>
  <p>The forecast is our own little widget, served from this site. It updates every hour.</p>
  <figure class="embed"><iframe id="f-weather" src="/widget/weather" title="Weather" height="230"></iframe><figcaption>Forecast for Sennen, from this site.</figcaption></figure>
  <h2>Then, the map</h2>
  <p>The route is on Wayfinder, a mapping site. You can search it from here: try “lighthouse”.</p>
  <figure class="embed"><iframe id="f-map" src="${maps}" title="Map" height="380"></iframe><figcaption>Map from maps.test, embedded.</figcaption></figure>
  <h2>The vote</h2>
  <p>We never agree on the route, so this year there’s a poll. It lives entirely inside the page.</p>
  <figure class="embed"><iframe id="f-poll" title="Poll" height="268" srcdoc="${esc(poll)}"></iframe><figcaption>A srcdoc frame: no address of its own.</figcaption></figure>
  <h2>What everyone said</h2>
  <p>Comments come from a sandboxed widget. Leave one if you’re coming.</p>
  <figure class="embed"><iframe id="f-comments" src="/widget/comments" title="Comments" height="420" sandbox="allow-scripts allow-forms"></iframe><figcaption>Sandboxed: scripts and forms only.</figcaption></figure>
  <p>See you at the harbour steps at eight. Bring a flask.</p>
</main>
<footer class="foot">Field Notes is a made-up blog on a test site.</footer>`;
  return doc({ title: 'Planning a coast walk — Field Notes', themeColor: '#fbf6ee', body });
}

function weather() {
  const hours = [['Now', 'sun', 14], ['10', 'sun', 15], ['11', 'sun', 16], ['12', 'cloud', 16], ['13', 'cloud', 17], ['14', 'rain', 15], ['15', 'cloud', 14]];
  const glyph = { sun: '☀️', cloud: '⛅', rain: '🌦️' };
  return doc({
    title: 'Weather',
    css: '',
    head: `<style>body{margin:0;font:14px/1.4 -apple-system,system-ui,sans-serif;color:#fff;background:linear-gradient(160deg,#4f8fe6,#2b5cb8 60%,#1f3f86);height:100vh;overflow:hidden}.w{padding:18px 22px}.t{display:flex;justify-content:space-between;align-items:start}.place{font-weight:600;font-size:16px}.deg{font-size:58px;font-weight:300;line-height:1;margin:6px 0}.desc{opacity:.85}.hi{opacity:.85;text-align:right}.h{display:grid;grid-template-columns:repeat(7,1fr);margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.25);text-align:center}.h span{display:block;opacity:.8;font-size:12px}.h i{font-style:normal;font-size:20px;display:block;margin:4px 0}.h b{font-weight:600}</style>`,
    body: `<div class="w"><div class="t"><div><div class="place">Sennen Cove</div><div class="deg">14°</div><div class="desc">Mostly sunny · light wind</div></div><div class="hi"><div style="font-size:34px">☀️</div>H 17° · L 9°</div></div><div class="h">${hours.map(([h, k, d]) => `<div><span>${h}</span><i>${glyph[k]}</i><b>${d}°</b></div>`).join('')}</div></div>`,
  });
}

function comments() {
  const list = [['Hanna Ruus', 'I’ll be there! Bringing my nephew, he’s eleven and walks faster than all of us.', '2h'], ['Owen Hartley', 'Cliff path every time. The woods are lovely but you can’t see the sea.', '1h'], ['Dalia Kader', 'If it rains, the Anchor does a very good soup. Just saying.', '35m']];
  return doc({
    title: 'Comments',
    css: '',
    head: `<style>body{margin:0;font:14px/1.45 -apple-system,system-ui,sans-serif;color:#2b2118;background:#fff}.c{padding:16px 18px}h3{margin:0 0 12px;font-size:15px}.n{display:flex;gap:10px;margin-bottom:14px}.n img{border-radius:50%}textarea{flex:1;border:1.5px solid #ecdcc4;border-radius:10px;padding:10px;font:14px -apple-system,system-ui;resize:none;height:62px;outline:none}textarea:focus{border-color:#c2410c}.row{display:flex;justify-content:flex-end;margin:-6px 0 14px}button{border:0;background:#2b2118;color:#fff;font-weight:600;padding:7px 14px;border-radius:8px}.m{display:flex;gap:10px;padding:10px 0;border-top:1px solid #f1e6d6}.m img{border-radius:50%}.m b{font-size:13px}.m span{color:#8a7a68;font-size:12px;margin-left:6px}.m p{margin:2px 0 0}</style>`,
    body: `<div class="c"><h3>${list.length + 14} comments</h3><form class="n" id="new" onsubmit="event.preventDefault()"><img src="${avatar('Sam Ortiz')}" alt="" width="34" height="34"><textarea id="comment" placeholder="Add a comment…" aria-label="Add a comment"></textarea></form><div class="row"><button form="new">Post comment</button></div>${list.map(([n, t, a]) => `<div class="m"><img src="${avatar(n)}" alt="" width="34" height="34"><div><b>${esc(n)}</b><span>${a}</span><p>${esc(t)}</p></div></div>`).join('')}</div>`,
  });
}

const CSS = `
:root { --ink: #2b2118; --text: #4a3f35; --dim: #8a7a68; --paper: #fbf6ee; --rust: #c2410c; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--text); font: 18px/1.65 ui-serif, "Iowan Old Style", Georgia, serif; -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
.mast { display: flex; align-items: center; justify-content: space-between; max-width: 1080px; margin: 0 auto; padding: 24px 32px; border-bottom: 1px solid #eadfcd; font-family: -apple-system, system-ui, sans-serif; }
.logo { font: italic 700 26px ui-serif, Georgia, serif; color: var(--ink); }
.mast nav { display: flex; gap: 24px; font-size: 14px; font-weight: 500; color: var(--dim); }
.post { max-width: 720px; margin: 0 auto; padding: 44px 32px 40px; }
.kicker { font: 600 13px -apple-system, system-ui, sans-serif; letter-spacing: .1em; text-transform: uppercase; color: var(--rust); margin: 0; }
h1 { font-size: 44px; line-height: 1.1; color: var(--ink); margin: 10px 0 18px; letter-spacing: -.01em; }
.by { display: flex; align-items: center; gap: 10px; font: 14px -apple-system, system-ui, sans-serif; color: var(--dim); margin-bottom: 28px; }
.by img { border-radius: 50%; }
.lead { font-size: 21px; color: var(--ink); }
h2 { font-size: 26px; color: var(--ink); margin: 40px 0 6px; }
.embed { margin: 20px 0 28px; }
.embed iframe { width: 100%; border: 0; border-radius: 16px; background: #fff; box-shadow: 0 0 0 1px #eadfcd, 0 14px 30px -18px rgba(60, 40, 20, .35); display: block; }
.embed figcaption { font: 13px -apple-system, system-ui, sans-serif; color: var(--dim); margin-top: 8px; }
.foot { text-align: center; font: 13px -apple-system, system-ui, sans-serif; color: var(--dim); padding: 30px; border-top: 1px solid #eadfcd; }
`;

const PLACES = [['Sennen Lighthouse', 'Lighthouse · 2.1 km', '#e5484d'], ['Harbour steps', 'Meeting point · 0.2 km', '#3e63dd'], ['Lifeboat station café', 'Café · 1.4 km', '#f5a524'], ['The Anchor', 'Pub · 3.0 km', '#12a594']];

function mapPage({ query }, embedded) {
  const q = query.get('q') ?? '';
  const results = PLACES.filter(([n]) => !q || n.toLowerCase().includes(q.toLowerCase()));
  const body = `
<div class="maps${embedded ? ' embedded' : ''}">
  <img class="map" src="${art('map', { seed: 5, w: 1600, h: 1000, pins: 4 })}" alt="">
  <aside class="panel">
    ${embedded ? '' : '<div class="brand"><svg width="28" height="28" viewBox="0 0 28 28"><rect width="28" height="28" rx="8" fill="#12a594"/><path d="M14 6c-4 0-7 3-7 7 0 5 7 10 7 10s7-5 7-10c0-4-3-7-7-7z" fill="#fff"/><circle cx="14" cy="13" r="2.6" fill="#12a594"/></svg>Wayfinder</div>'}
    <form class="find" action="${embedded ? '/embed' : '/'}"><span>${icon('search', { size: 18 })}</span><input id="find" name="q" value="${esc(q)}" placeholder="Search places" aria-label="Search places"></form>
    <ul>${results.map(([n, d, c]) => `<li><i style="background:${c}">${icon('pin', { size: 14 })}</i><div><b>${esc(n)}</b><span>${esc(d)}</span></div></li>`).join('') || '<li class="none">No places match.</li>'}</ul>
  </aside>
  <div class="zoom"><button aria-label="Zoom in">${icon('plus', { size: 18 })}</button><button aria-label="Zoom out"><svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path d="M5 12h14"/></svg></button></div>
  <div class="attrib">Wayfinder · map drawn for a test site</div>
</div>`;
  return doc({ title: embedded ? 'Map · Wayfinder' : 'Wayfinder — Maps', icon: '<link rel="icon" type="image/png" href="/pin.png">', body, css: '/assets/maps.css' });
}

const MAPS_CSS = `
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.4 -apple-system, system-ui, sans-serif; color: #1c2024; height: 100vh; overflow: hidden; }
.maps { position: relative; height: 100vh; background: #f6f3ec; }
.map { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.panel { position: absolute; top: 16px; left: 16px; width: 320px; background: #fff; border-radius: 16px; box-shadow: 0 10px 30px -10px rgba(0, 0, 0, .3); padding: 14px; }
.embedded .panel { width: 280px; top: 12px; left: 12px; padding: 10px; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 17px; margin-bottom: 12px; }
.find { display: flex; align-items: center; gap: 8px; background: #f3f3f5; border-radius: 10px; padding: 0 10px; height: 40px; color: #80838d; }
.find input { border: 0; background: none; outline: none; font: 15px -apple-system, system-ui; flex: 1; color: #1c2024; }
.panel ul { list-style: none; margin: 8px 0 0; padding: 0; }
.panel li { display: flex; align-items: center; gap: 10px; padding: 8px 4px; border-top: 1px solid #f0f0f3; }
.panel li i { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; color: #fff; }
.panel li b { display: block; }
.panel li span { color: #80838d; font-size: 12px; }
.panel li.none { color: #80838d; }
.zoom { position: absolute; right: 16px; bottom: 40px; display: flex; flex-direction: column; background: #fff; border-radius: 12px; box-shadow: 0 6px 18px -6px rgba(0, 0, 0, .3); overflow: hidden; }
.zoom button { width: 40px; height: 40px; border: 0; background: #fff; display: grid; place-items: center; cursor: pointer; }
.zoom button + button { border-top: 1px solid #eee; }
.attrib { position: absolute; right: 0; bottom: 0; background: rgba(255, 255, 255, .8); font-size: 11px; padding: 2px 8px; color: #555; }
`;

export const maps = {
  host: 'maps.test',
  name: 'Wayfinder',
  blurb: 'Maps of places worth walking to.',
  look: { bg: '#f6f3ec', ink: '#1c2024', accent: '#12a594' },
  iconLink: '<link rel="icon" type="image/png" href="/pin.png">',
  pages: [{ path: '/', title: 'Wayfinder — Maps', what: 'A map site; its icon link points at an HTML page, a bad icon to refuse', art: art('map', { seed: 5, w: 1200, h: 700, pins: 4 }) }],
  assets: {
    '/assets/maps.css': { type: 'text/css; charset=utf-8', body: MAPS_CSS },
    // A misconfigured server: an HTML error page sent as the icon.
    '/pin.png': { type: 'image/png', body: '<!doctype html><title>Error</title><h1>Service unavailable</h1>' },
  },
  routes: [
    ['GET', '/', (ctx) => mapPage(ctx, false)],
    ['GET', '/embed', (ctx) => mapPage(ctx, true)],
  ],
};

export default {
  host: 'embed.test',
  name: 'Field Notes',
  blurb: 'Essays about walking, maps and the coast.',
  look: { bg: '#fbf6ee', ink: '#2b2118', accent: '#c2410c', font: 'ui-serif, Georgia, serif' },
  iconLink: '',
  pages: [{ path: '/', title: 'Planning a coast walk — Field Notes', what: 'A page of frames: same site, another site with a text field, srcdoc, sandboxed', art: art('landscape', { seed: 12, p: 'dusk', w: 1200, h: 700 }) }],
  assets: { '/assets/site.css': { type: 'text/css; charset=utf-8', body: CSS } },
  routes: [
    ['GET', '/', (ctx) => post(ctx)],
    ['GET', '/widget/weather', () => weather()],
    ['GET', '/widget/comments', () => comments()],
  ],
};
