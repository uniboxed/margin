// murmur.test: Murmur, a social feed. Posts with pictures, a composer, an
// infinite feed (more posts load from /api/feed as you near the end, five
// pages, then "all caught up"), and an unread count in the title:
// "(3) Murmur". Opening Notifications clears it; ?live=<ms> brings a new
// post that often and counts it. SVG icon.
import { art, avatar, doc, esc, icon } from './common.js';
import { rng } from '../art.js';

const ICON = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#f97316"/><path d="M18 40c0-10 6-18 14-18s14 8 14 18" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round"/><circle cx="32" cy="42" r="5" fill="#fff"/></svg>`;

const PEOPLE = [
  ['Ana Duarte', 'anaduarte'], ['Jonas Vik', 'jonasvik'], ['Mei Tanaka', 'meitanaka'], ['Leo Marchetti', 'leom'], ['Priya Natarajan', 'priyan'],
  ['Ruth Calloway', 'ruthc'], ['Owen Hartley', 'owenwalks'], ['Isla Brennan', 'islab'], ['Tomás Reyes', 'tomasreyes'], ['Hanna Ruus', 'tram4'],
  ['Dalia Kader', 'daliacafe'], ['Sam Ortiz', 'samortiz'],
];
const TEXTS = [
  'The first tram out of Northgate at 4:42 is the quietest place in the whole city. Highly recommend, if you can get up for it.',
  'Finished the river walk today. 220 miles, four seasons, one pair of boots. Writing it all up now.',
  'Tried the new bakery on Weaver Street. The rye is unreal. Get there before 8 or it’s gone.',
  'Hot take: the best light of the day is the twenty minutes after sunset, and nobody is outside for it.',
  'Reminder that the night trains are back and a sleeper berth costs less than a hotel.',
  'Made a little map of every bench by the river. 43 of them. Two have plaques I’d never noticed.',
  'Library is open all night during exam season and it is the most peaceful room in town.',
  'Sea swim at 7. Water was 11°C. I can no longer feel my opinions.',
  'Does anyone know why the cathedral bells ring at 5:55 and not 6? Asking for a very tired friend.',
  'Three things that made today good: a sunny bench, a good book, and a dog who wanted to be friends.',
  'New print in the shop: the harbour at dawn, in four colours. Only 50 of them.',
  'Started learning to sail. So far I have learned that ropes are called lines and that I know nothing.',
  'Lighthouse keepers’ reunion on the headland this weekend. Bringing a flask and a lot of questions.',
  'Salt pans at sunrise. The rakers say it’s been the best summer in ten years.',
  'Some days the city just hums. Today was one of them.',
];
const TRENDS = [['Travel', 'Night trains', '18.2K posts'], ['Cities', '#QuietCity', '6,410 posts'], ['Food', 'Weaver Street', '2,108 posts'], ['Weather', 'First frost', '41.5K posts'], ['Sport', 'Harbour regatta', '3,977 posts']];

// The nth post of the feed, the same every time.
function post(n) {
  const r = rng(`post${n}`);
  const [name, handle] = PEOPLE[n % PEOPLE.length];
  const text = TEXTS[(n * 7) % TEXTS.length];
  const kinds = [['landscape', { seed: n + 1, p: ['dawn', 'forest', 'alpine', 'dusk', 'mint', 'desert'][n % 6] }], ['coast', { seed: n + 2, p: n % 2 ? 'evening' : 'day' }], ['city', { seed: n + 3, p: n % 3 ? 'dawn' : 'night' }]];
  const pics = n % 3 === 0 ? [kinds[n % 3]] : n % 5 === 1 ? [kinds[0], kinds[1]] : [];
  return {
    id: 1000 + n,
    name,
    handle,
    time: n < 3 ? `${(n + 1) * 4}m` : n < 20 ? `${Math.floor(n / 2)}h` : `${Math.floor(n / 10)}d`,
    text,
    pics: pics.map(([k, q]) => art(k, { ...q, w: 1000, h: 640 })),
    replies: Math.floor(r() * 80),
    reposts: Math.floor(r() * 300),
    likes: Math.floor(r() * 2400),
    views: `${(1 + r() * 90).toFixed(1)}K`,
  };
}

const postHtml = (p) => `<article class="post" data-id="${p.id}"><img class="av" src="${avatar(p.name)}" alt="" width="44" height="44"><div class="pb"><div class="ph"><b>${esc(p.name)}</b><span>@${p.handle} · ${p.time}</span><button aria-label="More">${icon('dots', { size: 16 })}</button></div><p>${esc(p.text)}</p>${p.pics.length ? `<div class="pics n${p.pics.length}">${p.pics.map((s) => `<img src="${s}" alt="" loading="lazy">`).join('')}</div>` : ''}<div class="acts"><button>${icon('chat', { size: 17 })}<span>${p.replies}</span></button><button class="rp">${icon('repeat', { size: 17 })}<span>${p.reposts}</span></button><button class="lk">${icon('heart', { size: 17 })}<span>${p.likes}</span></button><button>${icon('chart', { size: 17 })}<span>${p.views}</span></button><button>${icon('share', { size: 17 })}</button></div></div></article>`;

const PER_PAGE = 8;
const PAGES = 5;

function home() {
  const body = `
<div class="app">
  <nav class="left">
    <a class="logo" href="/home">${FAVICON.replace('<svg ', '<svg width="36" height="36" ')}</a>
    <a href="/home" class="on">${icon('home', { size: 24 })}<span>Home</span></a>
    <a href="/home">${icon('search', { size: 24 })}<span>Explore</span></a>
    <a href="/home" id="notif">${icon('bell', { size: 24 })}<span>Notifications</span><b id="badge">3</b></a>
    <a href="/home">${icon('mail', { size: 24 })}<span>Messages</span></a>
    <a href="/home">${icon('bookmark', { size: 24 })}<span>Bookmarks</span></a>
    <a href="/home">${icon('user', { size: 24 })}<span>Profile</span></a>
    <button class="post-btn">Post</button>
    <div class="me"><img src="${avatar('Sam Ortiz')}" alt="" width="40" height="40"><div><b>Sam Ortiz</b><span>@samortiz</span></div>${icon('dots', { size: 16 })}</div>
  </nav>
  <main class="feed">
    <header class="fh"><h1>Home</h1><div class="tabs"><a class="on">For you</a><a>Following</a></div></header>
    <form class="compose" onsubmit="event.preventDefault()"><img src="${avatar('Sam Ortiz')}" alt="" width="44" height="44"><div><textarea placeholder="What’s happening?" rows="2" aria-label="New post"></textarea><div class="ct"><span>${icon('grid', { size: 18 })}${icon('chart', { size: 18 })}${icon('sun', { size: 18 })}${icon('pin', { size: 18 })}</span><button>Post</button></div></div></form>
    <button class="fresh" id="fresh" hidden>${icon('down', { size: 14 })} <span>Show new posts</span></button>
    <div id="posts">${Array.from({ length: PER_PAGE }, (_, i) => postHtml(post(i))).join('')}</div>
    <div class="loader" id="sentinel"><i></i><i></i><i></i></div>
    <p class="end" id="end" hidden>${icon('check', { size: 18 })} You’re all caught up</p>
  </main>
  <aside class="right">
    <label class="search">${icon('search', { size: 18 })}<input placeholder="Search Murmur" aria-label="Search"></label>
    <section class="box"><h2>What’s happening</h2>${TRENDS.map(([c, t, n]) => `<a class="trend" href="/home"><span>${c} · Trending</span><b>${esc(t)}</b><span>${n}</span></a>`).join('')}</section>
    <section class="box"><h2>Who to follow</h2>${PEOPLE.slice(5, 8).map(([n, h]) => `<div class="wtf"><img src="${avatar(n)}" alt="" width="40" height="40"><div><b>${esc(n)}</b><span>@${h}</span></div><button>Follow</button></div>`).join('')}</section>
    <footer>Terms · Privacy · Cookies · Accessibility · © 2026 Murmur, a made-up network</footer>
  </aside>
</div>
<script src="/assets/murmur.js" defer></script>`;
  return doc({ title: '(3) Murmur', icon: ICON, themeColor: '#ffffff', body });
}

const CSS = `
:root { --ink: #0f1419; --dim: #536471; --line: #eff3f4; --orange: #f97316; --hover: #f7f9f9; --sans: -apple-system, system-ui, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--ink); background: #fff; font: 15px/1.4 var(--sans); -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
button { font: inherit; color: inherit; cursor: pointer; }
.app { display: grid; grid-template-columns: 260px 600px 350px; justify-content: center; }
.left { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 4px; padding: 6px 12px; }
.left .logo { padding: 10px; }
.left a { display: flex; align-items: center; gap: 18px; padding: 12px; border-radius: 999px; font-size: 19px; width: fit-content; position: relative; }
.left a:hover { background: var(--hover); }
.left a.on { font-weight: 700; }
.left a b { position: absolute; left: 26px; top: 6px; background: var(--orange); color: #fff; font-size: 11px; min-width: 18px; height: 18px; border-radius: 9px; display: grid; place-items: center; border: 2px solid #fff; padding: 0 3px; }
.left a b[hidden] { display: none; }
.post-btn { margin: 14px 0; height: 50px; border-radius: 25px; border: 0; background: var(--orange); color: #fff; font-weight: 700; font-size: 17px; width: 90%; box-shadow: 0 8px 20px -10px rgba(249, 115, 22, .8); }
.me { margin-top: auto; margin-bottom: 12px; display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 999px; }
.me:hover { background: var(--hover); }
.me img { border-radius: 50%; }
.me div { flex: 1; }
.me b { display: block; font-size: 15px; }
.me span { color: var(--dim); font-size: 14px; }
.feed { border-left: 1px solid var(--line); border-right: 1px solid var(--line); min-height: 100vh; }
.fh { position: sticky; top: 0; z-index: 5; background: rgba(255, 255, 255, .85); backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); }
.fh h1 { font-size: 20px; margin: 0; padding: 14px 16px 4px; }
.tabs { display: grid; grid-template-columns: 1fr 1fr; }
.tabs a { text-align: center; padding: 14px 0; color: var(--dim); font-weight: 500; cursor: pointer; }
.tabs a.on { color: var(--ink); font-weight: 700; box-shadow: inset 0 -4px 0 -0px var(--orange); background: linear-gradient(var(--orange), var(--orange)) bottom / 56px 4px no-repeat; box-shadow: none; }
.compose { display: flex; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.compose img, .av { border-radius: 50%; flex-shrink: 0; }
.compose div { flex: 1; }
.compose textarea { width: 100%; border: 0; resize: none; font: 20px/1.3 var(--sans); outline: none; padding: 8px 0; }
.ct { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--line); padding-top: 10px; color: var(--orange); }
.ct span { display: flex; gap: 14px; }
.ct button { border: 0; background: var(--orange); color: #fff; font-weight: 700; border-radius: 18px; padding: 8px 18px; opacity: .5; }
.fresh { display: flex; align-items: center; gap: 6px; margin: 10px auto; border: 0; background: var(--orange); color: #fff; font-weight: 700; padding: 8px 16px; border-radius: 18px; box-shadow: 0 6px 16px -6px rgba(249, 115, 22, .7); }
.fresh[hidden] { display: none; }
.post { display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); transition: background .15s; }
.post:hover { background: #fafbfb; }
.post.new { animation: flash 1.2s; }
@keyframes flash { from { background: #fff4ec; } }
.pb { flex: 1; min-width: 0; }
.ph { display: flex; gap: 6px; align-items: center; }
.ph span { color: var(--dim); }
.ph button { margin-left: auto; border: 0; background: none; color: var(--dim); }
.pb p { margin: 2px 0 10px; }
.pics { display: grid; gap: 2px; border-radius: 16px; overflow: hidden; border: 1px solid var(--line); margin-bottom: 10px; }
.pics.n2 { grid-template-columns: 1fr 1fr; }
.pics img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; display: block; }
.pics.n2 img { aspect-ratio: 4 / 5; }
.acts { display: flex; justify-content: space-between; max-width: 460px; color: var(--dim); }
.acts button { display: flex; align-items: center; gap: 6px; border: 0; background: none; color: inherit; font-size: 13px; padding: 4px 6px; border-radius: 999px; }
.acts .lk:hover, .acts .lk.on { color: #f91880; }
.acts .lk.on svg { fill: currentColor; }
.acts .rp:hover { color: #00ba7c; }
.loader { display: flex; justify-content: center; gap: 6px; padding: 26px; }
.loader i { width: 8px; height: 8px; border-radius: 50%; background: var(--orange); animation: bounce 1s infinite; }
.loader i:nth-child(2) { animation-delay: .15s; } .loader i:nth-child(3) { animation-delay: .3s; }
@keyframes bounce { 50% { transform: translateY(-6px); opacity: .4; } }
.loader[hidden] { display: none; }
.end { display: flex; justify-content: center; gap: 8px; align-items: center; color: var(--dim); padding: 30px; margin: 0; }
.end[hidden] { display: none; }
.right { padding: 8px 0 0 28px; display: flex; flex-direction: column; gap: 16px; position: sticky; top: 0; height: 100vh; overflow: hidden; }
.search { display: flex; align-items: center; gap: 12px; background: #eff3f4; border-radius: 999px; padding: 0 18px; height: 44px; color: var(--dim); }
.search input { border: 0; background: none; outline: none; font: 15px var(--sans); flex: 1; }
.box { border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
.box h2 { font-size: 20px; margin: 0; padding: 12px 16px; }
.trend { display: block; padding: 10px 16px; }
.trend:hover, .wtf:hover { background: var(--hover); }
.trend span { display: block; color: var(--dim); font-size: 13px; }
.trend b { display: block; }
.wtf { display: flex; align-items: center; gap: 10px; padding: 10px 16px; }
.wtf img { border-radius: 50%; }
.wtf div { flex: 1; }
.wtf b { display: block; }
.wtf span { color: var(--dim); font-size: 14px; }
.wtf button { border: 0; background: var(--ink); color: #fff; font-weight: 700; border-radius: 18px; padding: 7px 16px; }
.right footer { color: var(--dim); font-size: 13px; padding: 0 16px; }
@media (max-width: 1240px) { .app { grid-template-columns: 88px 600px 330px; } .left a span, .me div, .me svg { display: none; } .post-btn { width: 50px; font-size: 0; } .post-btn::before { content: "+"; font-size: 26px; } }
@media (max-width: 1060px) { .app { grid-template-columns: 88px minmax(0, 600px); } .right { display: none; } }
`;

const JS = `
const list = document.getElementById('posts');
const sentinel = document.getElementById('sentinel');
let page = 1, busy = false, unread = 3;
const title = () => { document.title = unread ? '(' + unread + ') Murmur' : 'Murmur'; const b = document.getElementById('badge'); b.hidden = !unread; b.textContent = unread; };
const more = async () => {
  if (busy || page >= ${PAGES}) return;
  busy = true;
  const res = await fetch('/api/feed?page=' + page);
  const { html, last } = await res.json();
  list.insertAdjacentHTML('beforeend', html);
  page++;
  busy = false;
  if (last) { sentinel.hidden = true; document.getElementById('end').hidden = false; io.disconnect(); }
};
const io = new IntersectionObserver((e) => e[0].isIntersecting && more(), { rootMargin: '900px 0px' });
io.observe(sentinel);
document.getElementById('notif').addEventListener('click', (e) => { e.preventDefault(); unread = 0; title(); });
list.addEventListener('click', (e) => { const b = e.target.closest('.lk'); if (!b) return; b.classList.toggle('on'); const n = b.querySelector('span'); n.textContent = Number(n.textContent) + (b.classList.contains('on') ? 1 : -1); });
const live = Number(new URLSearchParams(location.search).get('live'));
if (live > 0) {
  let waiting = [];
  setInterval(async () => {
    const res = await fetch('/api/new?n=' + (unread + waiting.length));
    waiting.push((await res.json()).html);
    unread++; title();
    const f = document.getElementById('fresh');
    f.hidden = false; f.querySelector('span').textContent = 'Show ' + waiting.length + ' new post' + (waiting.length > 1 ? 's' : '');
  }, live);
  document.getElementById('fresh').addEventListener('click', (e) => { list.insertAdjacentHTML('afterbegin', waiting.reverse().join('')); waiting = []; e.currentTarget.hidden = true; scrollTo({ top: 0 }); });
}
`;

export default {
  host: 'murmur.test',
  name: 'Murmur',
  blurb: 'What people are talking about, right now.',
  look: { bg: '#ffffff', ink: '#0f1419', accent: '#f97316' },
  iconLink: ICON,
  pages: [{ path: '/home', title: '(3) Murmur', what: 'A social feed: posts with pictures, infinite scroll, an unread count in the title', art: art('city', { seed: 4, p: 'night', w: 1200, h: 700 }) }],
  assets: {
    '/assets/site.css': { type: 'text/css; charset=utf-8', body: CSS },
    '/assets/murmur.js': { type: 'text/javascript; charset=utf-8', body: JS },
    '/favicon.svg': { type: 'image/svg+xml', body: FAVICON },
  },
  routes: [
    ['GET', '/', () => ({ status: 302, location: '/home' })],
    ['GET', '/home', () => home()],
    ['GET', '/api/feed', ({ query }) => {
      const page = Math.max(1, Number(query.get('page')) || 1);
      const html = Array.from({ length: PER_PAGE }, (_, i) => postHtml(post(page * PER_PAGE + i))).join('');
      return { type: 'application/json', body: JSON.stringify({ html, last: page >= PAGES - 1 }), delay: 250 };
    }],
    ['GET', '/api/new', ({ query }) => {
      const n = Number(query.get('n')) || 0;
      const p = { ...post(90 + n), time: 'now' };
      return { type: 'application/json', body: JSON.stringify({ html: postHtml(p).replace('class="post"', 'class="post new"') }) };
    }],
  ],
};
