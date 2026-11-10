// slow.test: Almanac, a research report sent in parts over about three
// seconds, as a slow server streams a long page: the shell and a loading
// bar at once, then each section, then pictures that arrive last, so the
// page's load comes at about 3 s. ?ms=<total> changes the pace. PNG icon.
import type { ServerResponse } from 'node:http';
import { FIRST_FRAMES, art, doc, esc, type Site } from './common.ts';
import { landscape } from '../art.ts';

const ICON = '<link rel="icon" type="image/png" href="/icon.png">';

const SECTIONS = [
  ['Summary', `<div class="kpis">${[['Field sites', '42', '+6 since Q2'], ['Samples', '18,240', '+12%'], ['Rain, mm', '312', '−18% on average'], ['Species seen', '1,027', '+41 new']].map(([n, v, d]) => `<div><span>${n}</span><b>${v}</b><em>${d}</em></div>`).join('')}</div><p>The third quarter was drier than any since records began on the coast. Most sites saw fewer samples in August, then a sharp recovery in September after the first storms. Below, the numbers site by site, and what we think they mean.</p>`],
  ['Rainfall by month', `<div class="bars">${([['Jul', 64], ['Aug', 22], ['Sep', 88]] as const).map(([m, v]) => `<div class="bar"><b>${v * 1.2 | 0} mm</b><i style="height:${v * 0.72}%"></i><span>${m}</span></div>`).join('')}</div><p>August was the driest month on record at 31 of the 42 sites. September’s storms brought almost half of the quarter’s rain in nine days.</p>`],
  ['Sites', `<table><thead><tr><th>Site</th><th>Region</th><th>Samples</th><th>Change</th></tr></thead><tbody>${([['Sennen Point', 'West coast', 1204, 8], ['Kettle Marsh', 'Estuary', 988, -4], ['High Moor', 'Uplands', 742, 15], ['Saltings', 'Estuary', 1530, 21], ['Lantern Wood', 'Valley', 611, -9], ['Gull Rock', 'West coast', 902, 3]] as const).map(([s, r, n, c]) => `<tr><td>${s}</td><td>${r}</td><td>${n.toLocaleString('en-US')}</td><td class="${c < 0 ? 'neg' : 'pos'}">${c > 0 ? '+' : ''}${c}%</td></tr>`).join('')}</tbody></table>`],
  ['From the field', `<div class="photos"><figure><img src="/img/marsh.svg" alt="" width="600" height="400"><figcaption>Kettle Marsh, 14 August: the lowest water in twenty years.</figcaption></figure><figure><img src="/img/moor.svg" alt="" width="600" height="400"><figcaption>High Moor after the first September storm.</figcaption></figure></div>`],
];

export function report(res: ServerResponse, total = 3000, fp = false) {
  const step = total / (SECTIONS.length + 1);
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  let head = doc({ title: 'Q3 2026 Field Report · Almanac', icon: ICON, themeColor: '#fdf8ef', body: '@@' }).split('@@')[0];
  if (fp) head = head.replace('<head>', `<head>\n${FIRST_FRAMES}`);
  res.write(`${head}
<div class="loading" id="loading"><i></i></div>
<header class="top"><a class="logo" href="/report"><img src="/icon.png" alt="" width="28" height="28">Almanac</a><nav><a href="/report" class="on">Reports</a><a href="/report">Data</a><a href="/report">Methods</a><a href="/report">About</a></nav></header>
<main class="doc">
<p class="kick">Quarterly field report · Published 5 November 2026</p>
<h1>Q3 2026: a dry summer, and a sudden autumn</h1>
<p class="dek">Rainfall, samples and sightings from 42 field sites along the coast and in the uplands, July to September.</p>
${'<!-- streaming -->'.padEnd(2048, ' ')}
`);
  let i = 0;
  const next = () => {
    if (res.destroyed) return;
    if (i < SECTIONS.length) {
      const [name, html] = SECTIONS[i];
      res.write(`<section class="sec" style="--d:${i}"><h2><span>${String(i + 1).padStart(2, '0')}</span>${esc(name)}</h2>${html}</section>\n`);
      i++;
      setTimeout(next, step);
      return;
    }
    res.end(`<p class="end">Almanac is a made-up research group on a test site.</p></main>
<script>document.getElementById('loading').classList.add('done'); addEventListener('load', () => document.getElementById('loading').remove());</script>
</body>
</html>
`);
  };
  setTimeout(next, step);
}

const CSS = `
:root { --ink: #1f1a14; --text: #4b4339; --dim: #8b8173; --line: #ebe3d4; --paper: #fdf8ef; --amber: #d9771f; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--text); font: 17px/1.6 -apple-system, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
.loading { position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 10; }
.loading i { display: block; height: 100%; width: 90%; background: linear-gradient(90deg, #f2b33d, var(--amber)); animation: grow 3s cubic-bezier(.1, .7, .3, 1) forwards; transform-origin: left; }
.loading.done i { width: 100%; animation: none; transition: opacity .4s; opacity: 0; }
@keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
.top { display: flex; align-items: center; gap: 36px; max-width: 1080px; margin: 0 auto; padding: 20px 32px; border-bottom: 1px solid var(--line); }
.logo { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 19px; color: var(--ink); letter-spacing: -.02em; }
.logo img { border-radius: 7px; }
.top nav { display: flex; gap: 22px; font-size: 14px; font-weight: 600; color: var(--dim); }
.top nav a.on { color: var(--ink); }
.doc { max-width: 820px; margin: 0 auto; padding: 48px 32px 60px; }
.kick { color: var(--amber); font-weight: 700; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; margin: 0; }
h1 { font: 800 44px/1.1 -apple-system, system-ui, sans-serif; color: var(--ink); letter-spacing: -.03em; margin: 10px 0 14px; }
.dek { font-size: 20px; color: var(--dim); margin: 0 0 30px; }
.sec { padding: 26px 0; border-top: 1px solid var(--line); animation: in .5s ease both; }
@keyframes in { from { opacity: 0; transform: translateY(10px); } }
h2 { display: flex; align-items: baseline; gap: 12px; font-size: 22px; color: var(--ink); margin: 0 0 16px; letter-spacing: -.01em; }
h2 span { font: 700 13px ui-monospace, Menlo, monospace; color: var(--amber); }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
.kpis div { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 14px; }
.kpis span { font-size: 13px; color: var(--dim); }
.kpis b { display: block; font-size: 26px; color: var(--ink); letter-spacing: -.02em; }
.kpis em { font-style: normal; font-size: 12px; color: var(--amber); font-weight: 600; }
.bars { display: flex; gap: 40px; align-items: end; height: 200px; padding: 10px 20px 0; background: #fff; border: 1px solid var(--line); border-radius: 14px; margin-bottom: 14px; }
.bar { flex: 1; height: 100%; display: flex; flex-direction: column; justify-content: end; align-items: center; gap: 6px; }
.bar i { width: 70%; background: linear-gradient(#5aa9e6, #2f6fb3); border-radius: 8px 8px 0 0; }
.bar span { font-weight: 700; color: var(--ink); padding-bottom: 8px; }
.bar b { font-size: 13px; color: var(--dim); }
table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 14px; overflow: hidden; box-shadow: 0 0 0 1px var(--line); }
th, td { text-align: left; padding: 10px 16px; border-bottom: 1px solid var(--line); font-size: 15px; }
th { background: #faf3e6; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); }
td.pos { color: #2f7d4f; font-weight: 600; } td.neg { color: #b4441d; font-weight: 600; }
.photos { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.photos figure { margin: 0; }
.photos img { width: 100%; height: auto; aspect-ratio: 3 / 2; object-fit: cover; border-radius: 14px; background: linear-gradient(110deg, #efe6d6 30%, #f8f1e4 50%, #efe6d6 70%) 0 0 / 300% 100%; animation: shimmer 1.4s infinite linear; display: block; }
@keyframes shimmer { to { background-position: -300% 0; } }
figcaption { font-size: 13px; color: var(--dim); margin-top: 6px; }
.end { color: var(--dim); font-size: 13px; text-align: center; margin-top: 40px; }
`;

export default {
  host: 'slow.test',
  name: 'Almanac',
  blurb: 'Field reports from the coast and the uplands.',
  look: { bg: '#fdf8ef', ink: '#1f1a14', accent: '#d9771f' },
  iconLink: ICON,
  pages: [{ path: '/report', title: 'Q3 2026 Field Report · Almanac', what: 'A report sent in parts over 3 s, pictures last: loading in the sidebar, first paint of a slow page', art: art('landscape', { seed: 4, p: 'desert', w: 1200, h: 700 }) }],
  assets: { '/assets/site.css': { type: 'text/css; charset=utf-8', body: CSS } },
  routes: [
    ['GET', '/', () => ({ status: 302, location: '/report' })],
    ['GET', '/report', ({ res, query }) => report(res, Math.min(20000, Number(query.get('ms')) || 3000), query.has('fp'))],
    // The pictures arrive last: whatever's left of the 3 s, and a little more.
    ['GET', /^\/img\/(marsh|moor)\.svg$/, ({ params }) => ({
      type: 'image/svg+xml',
      body: params[1] === 'marsh' ? landscape({ seed: 31, palette: 'mint', w: 600, h: 400 }) : landscape({ seed: 12, palette: 'dusk', w: 600, h: 400 }),
      delay: 600,
    })],
  ],
} satisfies Site;
