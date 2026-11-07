// reel.test: Reel, a video site. The watch page plays the local clip
// (files/reel/clip.webm, made by make-video.mjs) in a <video>, with the
// channel, description, comments and an Up next list. Nothing plays until
// asked: a click on the player, or play() from a test. PNG icon.
import { art, avatar, doc, esc, icon } from './common.js';

const ICON = '<link rel="icon" type="image/png" href="/icon-32.png">';

const NEXT = [
  ['Harbour lights, one night in 4K', 'Harbour Films', '1.2M', '12:48', 'city', { seed: 9, p: 'night' }],
  ['How a lighthouse lens works', 'Signal & Noise', '842K', '9:12', 'coast', { seed: 8, p: 'evening' }],
  ['Ten minutes of fog over the hills', 'Slow TV', '3.4M', '10:00', 'landscape', { seed: 12, p: 'dusk' }],
  ['We sailed the coast in a 6 metre boat', 'Tidewater', '520K', '24:31', 'coast', { seed: 3 }],
  ['Desert light, a timelapse', 'Field & Frame', '96K', '4:05', 'landscape', { seed: 4, p: 'desert' }],
  ['Drawing cities from memory', 'Inkwell', '211K', '15:20', 'city', { seed: 14, p: 'dawn' }],
  ['The quietest place in Norway', 'North Notes', '1.9M', '18:02', 'landscape', { seed: 21, p: 'alpine' }],
  ['Making a map by hand', 'Wayfinder', '74K', '7:44', 'map', { seed: 5, pins: 2 }],
  ['Night train to the coast, full journey', 'Slow TV', '4.1M', '2:11:09', 'landscape', { seed: 7, p: 'night' }],
  ['Forest sounds for working', 'Green Room', '12M', '3:00:00', 'landscape', { seed: 11, p: 'forest' }],
];

const COMMENTS = [
  ['Ana Duarte', '2 days ago', 'Six seconds and somehow I feel calmer. The way the boat drifts into frame at the end is perfect.', '1.2K'],
  ['Jonas Vik', '2 days ago', 'Is this drawn or filmed? I genuinely can’t tell at first glance.', '318'],
  ['Mei Tanaka', '1 day ago', 'Watched it on loop for ten minutes. Please make a longer version.', '204'],
  ['Leo Marchetti', '1 day ago', 'The colour of the water as the sun goes down 👌', '96'],
  ['Priya N', '20 hours ago', 'Came here from the lighthouse video. This channel never misses.', '41'],
  ['Tom K', '3 hours ago', 'Low tide, high quality.', '12'],
];

function watch() {
  const body = `
<header class="top">
  <button class="ib" aria-label="Menu">${icon('menu')}</button>
  <a class="logo" href="/watch"><svg width="34" height="24" viewBox="0 0 34 24"><rect width="34" height="24" rx="7" fill="#ff2e4d"/><path d="M14 7v10l9-5z" fill="#fff"/></svg>Reel</a>
  <form class="search" onsubmit="event.preventDefault()"><input placeholder="Search" aria-label="Search"><button aria-label="Search">${icon('search', { size: 18 })}</button></form>
  <div class="right"><button class="up">${icon('plus', { size: 18 })} Create</button><button class="ib" aria-label="Notifications">${icon('bell')}<b>9+</b></button><img src="${avatar('Sam Ortiz')}" alt="" width="32" height="32"></div>
</header>
<main class="page">
  <section class="primary">
    <div class="player" id="player-box">
      <video id="player" src="/files/clip.webm" poster="${art('coast', { seed: 8, p: 'evening', w: 1280, h: 720 })}" loop muted playsinline preload="metadata" controls></video>
      <button class="big-play" id="big-play" aria-label="Play">${icon('play', { size: 34, stroke: 0 })}</button>
    </div>
    <h1>Low Tide — a six-second film</h1>
    <div class="row">
      <div class="channel"><img src="${avatar('Harbour Films')}" alt="" width="42" height="42"><div><b>Harbour Films ${icon('check', { size: 14 })}</b><span>128K subscribers</span></div><button class="sub" id="sub">Subscribe</button></div>
      <div class="acts"><div class="pill"><button id="like">${icon('heart', { size: 18 })}<span>12K</span></button><i></i><button aria-label="Dislike">${icon('down', { size: 18 })}</button></div><button class="pill">${icon('share', { size: 18 })} Share</button><button class="pill">${icon('bookmark', { size: 18 })} Save</button><button class="pill round" aria-label="More">${icon('dots', { size: 18 })}</button></div>
    </div>
    <div class="desc" id="desc"><b>48,201 views · 2 days ago</b> <span class="tags">#slowtv #sea #animation</span><p>Six seconds of the tide going out at the end of a long day. Drawn frame by frame, then left to loop.</p><p class="more">Made for a test site. No sea was harmed. Music: none, just the quiet.</p><button class="toggle" id="desc-toggle">Show more</button></div>
    <section class="comments"><div class="c-head"><h2>${COMMENTS.length * 71} Comments</h2><button>${icon('filter', { size: 16 })} Sort by</button></div>
      <form class="c-new" onsubmit="event.preventDefault()"><img src="${avatar('Sam Ortiz')}" alt="" width="40" height="40"><input placeholder="Add a comment…" aria-label="Add a comment"></form>
      ${COMMENTS.map(([n, t, x, l]) => `<article class="c"><img src="${avatar(n)}" alt="" width="40" height="40"><div><div class="c-meta"><b>@${esc(n.toLowerCase().replace(/\s+/g, ''))}</b><span>${t}</span></div><p>${esc(x)}</p><div class="c-acts"><span>${icon('heart', { size: 15 })} ${l}</span><span>${icon('down', { size: 15 })}</span><span>Reply</span></div></div></article>`).join('')}
    </section>
  </section>
  <aside class="next">
    <div class="chips">${['All', 'From Harbour Films', 'Related', 'Slow TV', 'Live'].map((c, i) => `<button class="${i ? '' : 'on'}">${c}</button>`).join('')}</div>
    ${NEXT.map(([t, ch, v, d, k, q], i) => `<a class="v" href="/watch"><div class="th"><img src="${art(k, { ...q, w: 640, h: 360 })}" alt="" loading="lazy"><span>${d}</span></div><div class="vi"><b>${esc(t)}</b><span>${esc(ch)}</span><span>${v} views · ${i + 1} ${i ? 'weeks' : 'week'} ago</span></div></a>`).join('')}
  </aside>
</main>
<script src="/assets/reel.js" defer></script>`;
  return doc({ title: 'Low Tide — a six-second film - Reel', icon: ICON, themeColor: '#0f0f12', htmlClass: 'dark', body });
}

const CSS = `
:root { color-scheme: dark; --bg: #0f0f12; --panel: #1b1b20; --line: #2a2a31; --ink: #f1f1f3; --dim: #a1a1ab; --red: #ff2e4d; --sans: -apple-system, system-ui, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 var(--sans); -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
button { font: inherit; color: inherit; cursor: pointer; }
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 16px; height: 58px; padding: 0 20px; background: rgba(15, 15, 18, .95); backdrop-filter: blur(12px); }
.ib { position: relative; width: 40px; height: 40px; border-radius: 50%; border: 0; background: none; display: grid; place-items: center; }
.ib:hover { background: var(--panel); }
.ib b { position: absolute; top: 4px; right: 0; background: var(--red); font-size: 10px; padding: 0 4px; border-radius: 8px; }
.logo { display: flex; align-items: center; gap: 8px; font: 700 20px var(--sans); letter-spacing: -.03em; }
.search { flex: 1; max-width: 600px; margin: 0 auto; display: flex; }
.search input { flex: 1; height: 40px; border-radius: 20px 0 0 20px; border: 1px solid var(--line); background: #121216; color: var(--ink); padding: 0 16px; font: 15px var(--sans); outline: none; }
.search button { width: 64px; border-radius: 0 20px 20px 0; border: 1px solid var(--line); border-left: 0; background: var(--panel); }
.right { display: flex; align-items: center; gap: 8px; }
.right img { border-radius: 50%; margin-left: 6px; }
.up { display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px; border-radius: 18px; border: 0; background: var(--panel); font-weight: 600; }
.page { display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 24px; max-width: 1720px; margin: 0 auto; padding: 18px 24px 40px; }
.player { position: relative; aspect-ratio: 16 / 9; background: #000; border-radius: 14px; overflow: hidden; }
.player video { width: 100%; height: 100%; display: block; object-fit: cover; }
.big-play { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 84px; height: 60px; border-radius: 18px; border: 0; background: rgba(255, 46, 77, .92); color: #fff; display: grid; place-items: center; box-shadow: 0 10px 30px rgba(0, 0, 0, .4); transition: opacity .2s; }
.big-play svg { fill: #fff; }
.player.playing .big-play { opacity: 0; pointer-events: none; }
h1 { font-size: 20px; line-height: 1.3; margin: 14px 0 10px; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.channel { display: flex; align-items: center; gap: 12px; }
.channel img { border-radius: 50%; }
.channel b { display: flex; align-items: center; gap: 4px; font-size: 16px; }
.channel b svg { background: var(--dim); color: var(--bg); border-radius: 50%; padding: 2px; }
.channel span { color: var(--dim); font-size: 12px; }
.sub { margin-left: 12px; height: 36px; padding: 0 16px; border-radius: 18px; border: 0; background: var(--ink); color: var(--bg); font-weight: 600; }
.sub.on { background: var(--panel); color: var(--ink); }
.acts { display: flex; gap: 8px; }
.pill { display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px; border-radius: 18px; border: 0; background: var(--panel); font-weight: 600; }
.pill.round { width: 36px; padding: 0; justify-content: center; }
div.pill { padding: 0; gap: 0; }
div.pill button { display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px; border: 0; background: none; font-weight: 600; }
div.pill i { width: 1px; height: 22px; background: var(--line); }
#like.on { color: var(--red); }
#like.on svg { fill: currentColor; }
.desc { background: var(--panel); border-radius: 12px; padding: 12px 14px; margin: 14px 0; }
.desc p { margin: 6px 0 0; }
.desc .more { display: none; color: var(--dim); }
.desc.open .more { display: block; }
.tags { color: #7aa7ff; }
.toggle { border: 0; background: none; padding: 0; margin-top: 6px; font-weight: 600; }
.comments { margin-top: 22px; }
.c-head { display: flex; align-items: center; gap: 24px; }
.c-head h2 { font-size: 18px; margin: 0; }
.c-head button { display: flex; gap: 6px; align-items: center; border: 0; background: none; font-weight: 600; }
.c-new { display: flex; gap: 14px; align-items: center; margin: 20px 0 26px; }
.c-new img, .c img { border-radius: 50%; flex-shrink: 0; }
.c-new input { flex: 1; border: 0; border-bottom: 1px solid var(--line); background: none; color: var(--ink); padding: 8px 0; font: 14px var(--sans); outline: none; }
.c-new input:focus { border-bottom-color: var(--ink); }
.c { display: flex; gap: 14px; margin-bottom: 20px; }
.c-meta { display: flex; gap: 8px; align-items: baseline; }
.c-meta b { font-size: 13px; }
.c-meta span { color: var(--dim); font-size: 12px; }
.c p { margin: 4px 0 6px; }
.c-acts { display: flex; gap: 18px; color: var(--dim); font-size: 12px; font-weight: 600; }
.c-acts span { display: flex; gap: 6px; align-items: center; }
.chips { display: flex; gap: 8px; margin-bottom: 14px; overflow-x: auto; scrollbar-width: none; }
.chips button { white-space: nowrap; border: 0; border-radius: 8px; padding: 6px 12px; background: var(--panel); font-weight: 600; font-size: 13px; }
.chips button.on { background: var(--ink); color: var(--bg); }
.v { display: grid; grid-template-columns: 168px 1fr; gap: 10px; margin-bottom: 10px; }
.th { position: relative; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; background: var(--panel); }
.th img { width: 100%; height: 100%; object-fit: cover; }
.th span { position: absolute; right: 5px; bottom: 5px; background: rgba(0, 0, 0, .8); font-size: 12px; font-weight: 600; padding: 1px 5px; border-radius: 4px; }
.vi { display: flex; flex-direction: column; }
.vi b { font-size: 14px; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 4px; }
.vi span { color: var(--dim); font-size: 12px; }
@media (max-width: 1000px) { .page { grid-template-columns: 1fr; } .up { display: none; } }
`;

const JS = `
const video = document.getElementById('player');
const box = document.getElementById('player-box');
document.getElementById('big-play').addEventListener('click', () => video.play());
video.addEventListener('play', () => box.classList.add('playing'));
video.addEventListener('pause', () => box.classList.remove('playing'));
document.getElementById('sub').addEventListener('click', (e) => { const b = e.currentTarget; b.classList.toggle('on'); b.textContent = b.classList.contains('on') ? 'Subscribed' : 'Subscribe'; });
document.getElementById('like').addEventListener('click', (e) => e.currentTarget.classList.toggle('on'));
document.getElementById('desc-toggle').addEventListener('click', (e) => { const d = document.getElementById('desc'); d.classList.toggle('open'); e.currentTarget.textContent = d.classList.contains('open') ? 'Show less' : 'Show more'; });
`;

export default {
  host: 'reel.test',
  name: 'Reel',
  blurb: 'Watch, share and make short films.',
  look: { bg: '#0f0f12', ink: '#f1f1f3', accent: '#ff2e4d', dark: true },
  iconLink: ICON,
  pages: [{ path: '/watch', title: 'Low Tide — a six-second film - Reel', what: 'A video page: the local clip in a player, Up next, comments; playing keeps a tab awake', art: art('coast', { seed: 8, p: 'evening', w: 1200, h: 700 }) }],
  assets: {
    '/assets/site.css': { type: 'text/css; charset=utf-8', body: CSS },
    '/assets/reel.js': { type: 'text/javascript; charset=utf-8', body: JS },
  },
  routes: [
    ['GET', '/', () => ({ status: 302, location: '/watch' })],
    ['GET', '/watch', () => watch()],
  ],
};
