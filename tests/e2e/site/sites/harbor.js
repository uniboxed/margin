// harbor.test: Harbor, a travel site. A fixed top nav that turns solid on
// scroll, a sticky sub-nav, a fixed cookie bar, a fixed chat bubble and
// panel, and a dates modal that locks the page's scroll (body overflow
// hidden). ICO icon and an apple-touch-icon.
import { art, avatar, doc, esc, icon } from './common.js';

const ICON = '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32">\n<link rel="apple-touch-icon" href="/icon-180.png">';

const PLACES = [
  ['Sennen Cove', 'Cornwall', 'coast', { seed: 5 }, 4.92, 148],
  ['Ilha da Berlenga', 'Portugal', 'coast', { seed: 12, p: 'evening' }, 4.88, 212],
  ['Lofoten', 'Norway', 'landscape', { seed: 21, p: 'alpine' }, 4.97, 265],
  ['Cíes Islands', 'Galicia', 'coast', { seed: 3 }, 4.85, 131],
  ['Skye', 'Scotland', 'landscape', { seed: 11, p: 'forest' }, 4.9, 176],
  ['Hydra', 'Greece', 'landscape', { seed: 4, p: 'desert' }, 4.83, 189],
];

function home() {
  const body = `
<header class="nav" id="nav"><div class="in">
  <a class="logo" href="/"><svg width="30" height="30" viewBox="0 0 30 30"><rect width="30" height="30" rx="9" fill="#11808a"/><circle cx="15" cy="13" r="6" fill="#ffcf6e"/><path d="M5 19c3-2 6-2 10 0s7 2 10 0" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>Harbor</a>
  <nav><a href="/" class="on">Stays</a><a href="/">Experiences</a><a href="/">Ferries</a><a href="/">Guides</a></nav>
  <div class="right"><a href="/">List your place</a><button class="lang">EN · €</button><button class="me">${icon('menu', { size: 18 })}<img src="${avatar('Sam Ortiz')}" alt="" width="28" height="28"></button></div>
</div></header>
<section class="hero">
  <img class="hero-img" src="${art('coast', { seed: 5, w: 1800, h: 1000 })}" alt="">
  <div class="hero-in">
    <h1>Find a quiet place<br>by the sea.</h1>
    <p>Cottages, cabins and lighthouses on 1,200 coastlines. Booked by people who’ve stayed there.</p>
    <form class="finder" onsubmit="event.preventDefault()">
      <label><span>Where</span><input value="Sennen Cove, Cornwall" aria-label="Where"></label>
      <button type="button" id="open-dates"><span>Dates</span><b>Fri 13 – Sun 15 Nov</b></button>
      <label><span>Guests</span><input value="2 adults" aria-label="Guests"></label>
      <button class="go">${icon('search', { size: 18 })} Search</button>
    </form>
  </div>
</section>
<nav class="subnav" id="subnav"><div class="in">${['Cottages', 'Cabins', 'Lighthouses', 'Boathouses', 'Beach huts', 'Islands', 'Pet friendly', 'With a sauna'].map((c, i) => `<a href="/" class="${i ? '' : 'on'}">${icon(['home', 'sun', 'star', 'wave', 'compass', 'pin', 'heart', 'clock'][i], { size: 18 })}${c}</a>`).join('')}<button class="filters">${icon('filter', { size: 16 })} Filters</button></div></nav>
<main class="main">
  <div class="row-h"><h2>Popular this winter</h2><a href="/">See all ${icon('chevron', { size: 14 })}</a></div>
  <div class="places">${PLACES.map(([n, r, k, q, score, price], i) => `<a class="place" href="/"><div class="ph"><img src="${art(k, { ...q, w: 800, h: 640 })}" alt="" loading="lazy">${i % 3 === 0 ? '<span class="tag">Guest favourite</span>' : ''}<button class="heart" aria-label="Save" onclick="event.preventDefault(); this.classList.toggle('on')">${icon('heart', { size: 20 })}</button></div><div class="pi"><b>${esc(n)}, ${esc(r)}</b><span>${icon('star', { size: 14 })}${score}</span></div><p>${['Sea views, wood stove', 'Lighthouse keeper’s cottage', 'Cabin on stilts', 'Whitewashed house by the bay', 'Croft with a hot tub', 'Stone house, no cars'][i]}</p><p class="price"><b>€${price}</b> night</p></a>`).join('')}</div>
  <section class="feature"><img src="${art('coast', { seed: 8, p: 'evening', w: 1600, h: 800 })}" alt=""><div><span class="kick">Harbor guides</span><h3>The slow way round the Atlantic coast</h3><p>Ferries, cliff walks and harbour towns, in fourteen days and no flights. A route by our editors, with the places they stayed.</p><a href="/" class="btn">Read the guide</a></div></section>
  <div class="row-h"><h2>Deals for the next few weeks</h2></div>
  <div class="deals">${['Two nights for the price of one in Lofoten', '20% off cabins on Skye in December', 'Free ferry with any stay on the Cíes Islands', 'Early check-in on lighthouse stays'].map((d, i) => `<div class="deal"><i>${['−50%', '−20%', 'Free', '+3h'][i]}</i><div><b>${esc(d)}</b><span>Until ${15 + i} December</span></div>${icon('chevron')}</div>`).join('')}</div>
  <section class="quotes">${[['Leila', 'Woke up to seals in the cove. The host had left bread and eggs from the farm next door.'], ['Tom', 'Exactly as pictured, and quieter than we dared hope. We’re already planning to go back.'], ['Aiko', 'The lighthouse stay was the best night of our trip. Bring a jumper for the stairs.']].map(([n, q]) => `<blockquote><p>“${esc(q)}”</p><footer><img src="${avatar(n + ' K')}" alt="" width="32" height="32">${n}</footer></blockquote>`).join('')}</section>
</main>
<footer class="foot"><div class="in"><div><b>Harbor</b><p>Quiet places by the sea, since 2014. A made-up company on a test site.</p></div><div><h4>Support</h4><a href="/">Help centre</a><a href="/">Cancellation options</a><a href="/">Safety</a></div><div><h4>Hosting</h4><a href="/">List your place</a><a href="/">Host resources</a><a href="/">Community</a></div><div><h4>Harbor</h4><a href="/">About</a><a href="/">Careers</a><a href="/">Press</a></div></div></footer>
<div class="cookie" id="cookie" role="dialog" aria-label="Cookies"><div>${icon('settings', { size: 18 })}<p>We use a few cookies to keep you signed in and to remember your searches. No ads, no tracking.</p></div><div class="cb"><button id="cookie-settings">Settings</button><button id="cookie-ok" class="ok">Accept</button></div></div>
<button class="chat" id="chat" aria-label="Chat with us">${icon('chat', { size: 24 })}<span class="ping">1</span></button>
<div class="chat-panel" id="chat-panel" hidden><header><img src="${avatar('Maya Harbor')}" alt="" width="36" height="36"><div><b>Maya from Harbor</b><span>Usually replies in a few minutes</span></div><button id="chat-x" aria-label="Close">${icon('x', { size: 18 })}</button></header><div class="msgs"><p class="them">Hi! Looking for somewhere in particular? I can help with dates, dogs and ferries.</p></div><form onsubmit="event.preventDefault()"><input placeholder="Write a message" aria-label="Message"><button>${icon('send', { size: 18 })}</button></form></div>
<div class="modal" id="modal" hidden><div class="sheet" role="dialog" aria-modal="true" aria-label="Choose dates"><header><h3>When are you going?</h3><button id="modal-x" aria-label="Close">${icon('x', { size: 20 })}</button></header><div class="months">${month('November 2026', 30, 6, [13, 14, 15])}${month('December 2026', 31, 1, [])}</div><footer><div class="flex">${['Exact dates', '± 1 day', '± 3 days', '± 7 days'].map((f, i) => `<button class="${i ? '' : 'on'}">${f}</button>`).join('')}</div><button class="apply" id="modal-ok">Apply</button></footer></div></div>
<script src="/assets/harbor.js" defer></script>`;
  return doc({ title: 'Harbor — Quiet places by the sea', icon: ICON, themeColor: '#0b4d57', body });
}

function month(name, days, start, picked) {
  const cells = Array.from({ length: start }, () => '<span></span>').concat(Array.from({ length: days }, (_, i) => `<button class="${picked.includes(i + 1) ? (i + 1 === picked[0] || i + 1 === picked.at(-1) ? 'pick end' : 'pick') : ''}${i + 1 < 6 && name.startsWith('Nov') ? ' past' : ''}">${i + 1}</button>`));
  return `<div class="month"><h4>${name}</h4><div class="dow">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => `<span>${d}</span>`).join('')}</div><div class="days">${cells.join('')}</div></div>`;
}

const CSS = `
:root { --ink: #10292c; --text: #3e5457; --muted: #6f8487; --line: #e3eaea; --teal: #11808a; --deep: #0b4d57; --sun: #ffcf6e; --sans: ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 var(--sans); color: var(--text); background: #fff; -webkit-font-smoothing: antialiased; }
body.locked { overflow: hidden; }
a { color: inherit; text-decoration: none; }
button { font: inherit; cursor: pointer; }
.in { max-width: 1280px; margin: 0 auto; padding: 0 32px; }
.nav { position: fixed; top: 0; left: 0; right: 0; z-index: 40; height: 72px; color: #fff; transition: background .25s, color .25s, box-shadow .25s; }
.nav.solid { background: rgba(255, 255, 255, .96); color: var(--ink); box-shadow: 0 1px 0 var(--line), 0 6px 20px -12px rgba(0, 0, 0, .2); backdrop-filter: blur(10px); }
.nav .in { display: flex; align-items: center; gap: 40px; height: 100%; }
.logo { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 22px; letter-spacing: -.02em; }
.nav nav { display: flex; align-self: stretch; gap: 26px; font-weight: 600; font-size: 15px; }
.nav nav a { display: flex; align-items: center; }
.nav nav a { opacity: .8; }
.nav nav a.on { opacity: 1; box-shadow: inset 0 -2px currentColor; }
.right { margin-left: auto; display: flex; align-items: center; gap: 18px; font-weight: 600; font-size: 14px; }
.lang { background: none; border: 0; color: inherit; font-weight: 600; }
.me { display: flex; align-items: center; gap: 8px; border: 1px solid currentColor; border-radius: 999px; padding: 4px 4px 4px 12px; background: rgba(255, 255, 255, .12); color: inherit; }
.me img { border-radius: 50%; }
.hero { position: relative; height: 640px; color: #fff; display: flex; align-items: end; }
.hero-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.hero::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(8, 40, 46, .45), rgba(8, 40, 46, 0) 30%, rgba(8, 40, 46, .2) 60%, rgba(8, 40, 46, .7)); }
.hero-in { position: relative; z-index: 1; max-width: 1280px; width: 100%; margin: 0 auto; padding: 0 32px 64px; }
.hero h1 { font: 800 clamp(44px, 5.6vw, 76px)/1 var(--sans); letter-spacing: -.035em; margin: 0 0 16px; text-shadow: 0 2px 30px rgba(0, 0, 0, .2); }
.hero p { font-size: 19px; max-width: 520px; margin: 0 0 30px; opacity: .95; }
.finder { display: grid; grid-template-columns: 1.3fr 1fr 0.8fr auto; background: #fff; border-radius: 22px; padding: 8px; box-shadow: 0 20px 50px -20px rgba(0, 0, 0, .45); max-width: 900px; }
.finder label, .finder > button:not(.go) { display: flex; flex-direction: column; padding: 10px 18px; border: 0; background: none; text-align: left; border-right: 1px solid var(--line); border-radius: 14px; color: var(--ink); }
.finder > button:not(.go):hover, .finder label:hover { background: #f3f7f7; }
.finder span { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.finder input { border: 0; outline: none; font: 600 16px var(--sans); color: var(--ink); padding: 2px 0 0; background: none; }
.finder b { font-size: 16px; padding-top: 2px; }
.go { display: flex; align-items: center; gap: 8px; border: 0; border-radius: 16px; background: var(--teal); color: #fff; font-weight: 700; padding: 0 26px; }
.subnav { position: sticky; top: 72px; z-index: 30; background: #fff; border-bottom: 1px solid var(--line); }
.subnav .in { display: flex; gap: 30px; align-items: center; height: 76px; overflow-x: auto; scrollbar-width: none; }
.subnav a { display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 13px; font-weight: 600; color: var(--muted); white-space: nowrap; padding: 10px 0; border-bottom: 2px solid transparent; }
.subnav a.on { color: var(--ink); border-color: var(--ink); }
.subnav .filters { margin-left: auto; display: flex; gap: 8px; align-items: center; border: 1px solid var(--line); background: #fff; border-radius: 12px; padding: 10px 14px; font-weight: 600; font-size: 14px; color: var(--ink); }
.main { max-width: 1280px; margin: 0 auto; padding: 36px 32px 60px; }
.row-h { display: flex; justify-content: space-between; align-items: baseline; margin: 10px 0 18px; }
.row-h h2 { font: 800 28px var(--sans); color: var(--ink); letter-spacing: -.02em; margin: 0; }
.row-h a { display: flex; align-items: center; gap: 2px; font-weight: 600; color: var(--teal); }
.places { display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px 24px; }
.place .ph { position: relative; border-radius: 18px; overflow: hidden; aspect-ratio: 5 / 4; }
.place img { width: 100%; height: 100%; object-fit: cover; transition: transform .5s; }
.place:hover img { transform: scale(1.04); }
.tag { position: absolute; top: 14px; left: 14px; background: #fff; color: var(--ink); font-size: 13px; font-weight: 700; padding: 5px 12px; border-radius: 999px; box-shadow: 0 2px 10px rgba(0, 0, 0, .15); }
.heart { position: absolute; top: 12px; right: 12px; border: 0; background: none; color: #fff; filter: drop-shadow(0 1px 3px rgba(0, 0, 0, .5)); }
.heart.on svg { fill: #ff5a5f; stroke: #ff5a5f; }
.pi { display: flex; justify-content: space-between; margin-top: 12px; color: var(--ink); }
.pi span { display: flex; align-items: center; gap: 4px; font-weight: 600; }
.place p { margin: 0; color: var(--muted); font-size: 15px; }
.place .price { color: var(--ink); margin-top: 4px; }
.feature { display: grid; grid-template-columns: 1.2fr 1fr; background: #0b4d57; color: #e3f2f1; border-radius: 26px; overflow: hidden; margin: 64px 0; }
.feature img { width: 100%; height: 100%; object-fit: cover; min-height: 340px; }
.feature > div { padding: 48px; display: flex; flex-direction: column; justify-content: center; }
.kick { text-transform: uppercase; letter-spacing: .12em; font-size: 12px; font-weight: 800; color: var(--sun); }
.feature h3 { font: 800 34px/1.1 var(--sans); color: #fff; letter-spacing: -.02em; margin: 10px 0 14px; }
.btn { align-self: start; background: var(--sun); color: var(--ink); font-weight: 800; padding: 12px 22px; border-radius: 14px; margin-top: 10px; }
.deals { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.deal { display: flex; align-items: center; gap: 16px; border: 1px solid var(--line); border-radius: 18px; padding: 16px 18px; }
.deal i { font-style: normal; font-weight: 800; color: var(--teal); background: #e5f4f4; border-radius: 12px; width: 64px; height: 52px; display: grid; place-items: center; }
.deal b { display: block; color: var(--ink); }
.deal span { font-size: 14px; color: var(--muted); }
.deal svg { margin-left: auto; color: var(--muted); }
.quotes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin: 64px 0 20px; }
.quotes blockquote { margin: 0; background: #f4f8f8; border-radius: 20px; padding: 22px; }
.quotes p { color: var(--ink); margin: 0 0 14px; font-size: 17px; }
.quotes footer { display: flex; align-items: center; gap: 10px; font-weight: 700; color: var(--ink); }
.quotes img { border-radius: 50%; }
.foot { background: #f4f8f8; padding: 44px 0 120px; border-top: 1px solid var(--line); }
.foot .in { display: grid; grid-template-columns: 1.5fr 1fr 1fr 1fr; gap: 32px; }
.foot b { font-size: 20px; color: var(--ink); }
.foot h4 { margin: 0 0 10px; color: var(--ink); }
.foot a { display: block; padding: 3px 0; color: var(--muted); }
.cookie { position: fixed; left: 24px; right: 104px; bottom: 24px; z-index: 50; display: flex; align-items: center; justify-content: space-between; gap: 20px; background: var(--ink); color: #dbe9e9; padding: 14px 16px 14px 20px; border-radius: 18px; box-shadow: 0 16px 40px -12px rgba(0, 0, 0, .5); max-width: 860px; }
.cookie > div:first-child { display: flex; gap: 12px; align-items: center; }
.cookie p { margin: 0; font-size: 14px; }
.cb { display: flex; gap: 8px; flex-shrink: 0; }
.cb button { border: 1px solid #3c5558; background: none; color: #fff; border-radius: 12px; padding: 9px 16px; font-weight: 700; font-size: 14px; }
.cb .ok { background: var(--sun); color: var(--ink); border-color: var(--sun); }
.cookie.gone { display: none; }
.chat { position: fixed; right: 24px; bottom: 24px; z-index: 60; width: 60px; height: 60px; border-radius: 50%; border: 0; background: var(--teal); color: #fff; display: grid; place-items: center; box-shadow: 0 12px 28px -8px rgba(17, 128, 138, .7); }
.ping { position: absolute; top: 2px; right: 2px; width: 20px; height: 20px; border-radius: 50%; background: #ff5a5f; color: #fff; font-size: 12px; font-weight: 800; display: grid; place-items: center; border: 2px solid #fff; }
.chat-panel { position: fixed; right: 24px; bottom: 96px; z-index: 60; width: 340px; background: #fff; border-radius: 22px; box-shadow: 0 24px 60px -16px rgba(0, 0, 0, .4); overflow: hidden; }
.chat-panel header { display: flex; gap: 10px; align-items: center; padding: 14px 16px; background: var(--deep); color: #fff; }
.chat-panel header img { border-radius: 50%; }
.chat-panel header b { display: block; }
.chat-panel header span { font-size: 12px; opacity: .8; }
.chat-panel header button { margin-left: auto; background: none; border: 0; color: #fff; }
.msgs { padding: 16px; min-height: 160px; background: #f4f8f8; }
.them { background: #fff; border-radius: 16px 16px 16px 4px; padding: 10px 14px; margin: 0; color: var(--ink); font-size: 15px; box-shadow: 0 1px 2px rgba(0, 0, 0, .06); }
.chat-panel form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--line); }
.chat-panel input { flex: 1; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; font: 15px var(--sans); outline: none; }
.chat-panel form button { border: 0; background: var(--teal); color: #fff; border-radius: 12px; width: 42px; display: grid; place-items: center; }
.modal { position: fixed; inset: 0; z-index: 100; background: rgba(8, 30, 34, .55); display: grid; place-items: center; animation: fade .2s; }
.modal[hidden] { display: none; }
@keyframes fade { from { opacity: 0; } }
.sheet { width: min(760px, calc(100vw - 48px)); background: #fff; border-radius: 26px; padding: 26px 28px; box-shadow: 0 40px 80px -20px rgba(0, 0, 0, .5); animation: up .25s cubic-bezier(.2, .9, .3, 1.1); }
@keyframes up { from { transform: translateY(24px); opacity: 0; } }
.sheet header { display: flex; justify-content: space-between; align-items: center; }
.sheet h3 { font: 800 24px var(--sans); color: var(--ink); margin: 0; letter-spacing: -.02em; }
.sheet header button { border: 0; background: #f1f5f5; border-radius: 50%; width: 38px; height: 38px; display: grid; place-items: center; color: var(--ink); }
.months { display: grid; grid-template-columns: 1fr 1fr; gap: 36px; margin: 20px 0; }
.month h4 { text-align: center; margin: 0 0 10px; color: var(--ink); }
.dow, .days { display: grid; grid-template-columns: repeat(7, 1fr); text-align: center; gap: 2px 0; }
.dow span { font-size: 12px; font-weight: 700; color: var(--muted); padding: 4px 0; }
.days button { border: 0; background: none; height: 42px; border-radius: 50%; font-weight: 600; color: var(--ink); }
.days button:hover { box-shadow: inset 0 0 0 1.5px var(--ink); }
.days .past { color: #c4cfd0; }
.days .pick { background: #e5f4f4; border-radius: 0; }
.days .pick.end { background: var(--ink); color: #fff; border-radius: 50%; }
.sheet footer { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--line); padding-top: 18px; }
.flex { display: flex; gap: 8px; }
.flex button { border: 1px solid var(--line); background: #fff; border-radius: 999px; padding: 8px 14px; font-weight: 600; font-size: 14px; color: var(--ink); }
.flex button.on { border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink); }
.apply { border: 0; background: var(--ink); color: #fff; border-radius: 14px; padding: 12px 26px; font-weight: 800; }
@media (max-width: 1000px) { .places { grid-template-columns: repeat(2, 1fr); } .nav nav { display: none; } .feature { grid-template-columns: 1fr; } .finder { grid-template-columns: 1fr 1fr; } .quotes { grid-template-columns: 1fr; } }
@media (max-width: 700px) { .places, .deals { grid-template-columns: 1fr; } .months { grid-template-columns: 1fr; } .cookie { right: 24px; bottom: 96px; flex-direction: column; align-items: stretch; } }
`;

const JS = `
const nav = document.getElementById('nav');
const solid = () => nav.classList.toggle('solid', scrollY > 420);
addEventListener('scroll', solid, { passive: true });
solid();
const modal = document.getElementById('modal');
const open = () => { modal.hidden = false; document.body.classList.add('locked'); };
const close = () => { modal.hidden = true; document.body.classList.remove('locked'); };
document.getElementById('open-dates').addEventListener('click', open);
document.getElementById('modal-x').addEventListener('click', close);
document.getElementById('modal-ok').addEventListener('click', close);
modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });
document.getElementById('cookie-ok').addEventListener('click', () => document.getElementById('cookie').classList.add('gone'));
const panel = document.getElementById('chat-panel');
document.getElementById('chat').addEventListener('click', () => { panel.hidden = !panel.hidden; document.querySelector('.ping')?.remove(); });
document.getElementById('chat-x').addEventListener('click', () => (panel.hidden = true));
`;

export default {
  host: 'harbor.test',
  name: 'Harbor',
  blurb: 'Quiet places by the sea.',
  look: { bg: '#ffffff', ink: '#10292c', accent: '#11808a', font: 'ui-rounded, -apple-system, system-ui, sans-serif' },
  iconLink: ICON,
  pages: [{ path: '/', title: 'Harbor — Quiet places by the sea', what: 'A travel site: fixed nav, sticky sub-nav, cookie bar, chat bubble, a modal that locks scroll', art: art('coast', { seed: 5, w: 1200, h: 700 }) }],
  assets: {
    '/assets/site.css': { type: 'text/css; charset=utf-8', body: CSS },
    '/assets/harbor.js': { type: 'text/javascript; charset=utf-8', body: JS },
  },
  routes: [['GET', '/', () => home()]],
};
