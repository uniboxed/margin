// noir.test: NOIR, a dark portfolio. Big type in Archivo Black and Space
// Grotesk (the neubrutalism theme's bundled OFL fonts, served from the
// repo, not copied), a grid of work, a dark theme-color. SVG icon.
import { art, doc, esc, icon, type Site } from './common.ts';

const ICON = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0b0b0c"/><circle cx="44" cy="20" r="7" fill="#ff5a36"/><path d="M16 48V16l22 32V16" stroke="#ece7df" stroke-width="7" fill="none" stroke-linejoin="bevel"/></svg>`;

const WORK = [
  ['Halden Coffee', 'Identity, packaging', 2026, 3],
  ['Orbit Records', 'Album series', 2026, 0],
  ['Tidewater', 'Campaign', 2025, 2],
  ['Field Notes on Light', 'Exhibition', 2025, 4],
  ['Kiln & Co', 'Identity', 2024, 1],
  ['Bloom Festival', 'Posters, motion', 2024, 5],
];

function home() {
  const body = `
<header class="nav"><a class="mark" href="/">NOIR<span>●</span></a><nav><a href="#work">Work</a><a href="#about">Studio</a><a href="#contact">Contact</a></nav><a class="cta" href="#contact">Start a project ${icon('chevron', { size: 16 })}</a></header>
<main>
  <section class="hero">
    <p class="kick">Ines Varga — independent design studio, Lisbon</p>
    <h1>Images for <em>quiet</em> brands &amp; loud ideas.</h1>
    <div class="hero-row"><p>Identity, editorial and motion for people who make things slowly. Twelve years, two hundred projects, no templates.</p><a class="reel" href="#work"><span class="dot"></span>Selected work 2024—2026</a></div>
  </section>
  <section class="marquee" aria-hidden="true"><div>${'Identity ✦ Editorial ✦ Motion ✦ Packaging ✦ Type ✦ Exhibitions ✦ '.repeat(4)}</div></section>
  <section id="work" class="work">
    ${WORK.map(([t, k, y, seed], i) => `<a class="piece p${i}" href="/"><div class="frame"><img src="${art('abstract', { seed, w: 900, h: i % 3 === 0 ? 1100 : 900, bg: ['#151517', '#1a1614', '#121619'][i % 3] })}" alt="" loading="${i < 2 ? 'eager' : 'lazy'}"></div><div class="cap"><span class="n">0${i + 1}</span><b>${esc(t)}</b><span>${esc(k)}</span><span>${y}</span></div></a>`).join('')}
  </section>
  <section id="about" class="about">
    <h2>Studio</h2>
    <div class="cols"><p class="big">We’re a studio of three, working with a small circle of printers, animators and type designers.</p><div><p>Every project starts with a week of looking: at the place, the product and the people. Then we draw, a lot, by hand, before anything goes near a screen.</p><p>Clients range from a two-person coffee roaster to a national museum. What they share is patience, and a taste for the slightly strange.</p></div></div>
    <ul class="clients">${['Halden', 'Orbit Records', 'Museu do Mar', 'Kiln & Co', 'Tidewater', 'Paper Moon', 'Atlas Press', 'Bloom'].map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
    <div class="stats">${[['12', 'years'], ['214', 'projects'], ['9', 'awards'], ['3', 'people']].map(([n, l]) => `<div><b>${n}</b><span>${l}</span></div>`).join('')}</div>
  </section>
  <section id="contact" class="contact"><p class="kick">Have something in mind?</p><a href="mailto:hello@noir.test" class="mail">hello@noir.test</a><div class="social"><a href="/">Instagram</a><a href="/">Are.na</a><a href="/">Read.cv</a></div></section>
</main>
<footer><span>© 2026 NOIR Studio</span><span>Lisbon · 38.72° N</span><span>A made-up studio on a test site</span></footer>`;
  return doc({ title: 'NOIR — Ines Varga, design studio', icon: ICON, themeColor: '#0b0b0c', htmlClass: 'dark', body });
}

const CSS = `
@font-face { font-family: "Archivo Black"; src: url(/fonts/archivo-black-latin.woff2) format("woff2"); font-display: swap; }
@font-face { font-family: "Space Grotesk"; src: url(/fonts/space-grotesk-latin.woff2) format("woff2"); font-weight: 300 700; font-display: swap; }
:root { color-scheme: dark; --bg: #0b0b0c; --ink: #ece7df; --dim: #8d877f; --ember: #ff5a36; --line: #26262a; }
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0; background: var(--bg); color: var(--ink); font: 18px/1.55 "Space Grotesk", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
.nav { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 40px; padding: 22px 48px; background: linear-gradient(var(--bg) 60%, transparent); }
.mark { font: 28px/1 "Archivo Black", sans-serif; letter-spacing: -.02em; }
.mark span { color: var(--ember); font-size: 16px; vertical-align: top; margin-left: 2px; }
.nav nav { display: flex; gap: 28px; font-size: 15px; color: var(--dim); }
.nav nav a:hover { color: var(--ink); }
.cta { margin-left: auto; display: flex; align-items: center; gap: 6px; border: 1.5px solid var(--ink); border-radius: 999px; padding: 10px 18px; font-size: 15px; font-weight: 500; transition: .2s; }
.cta:hover { background: var(--ink); color: var(--bg); }
.hero { padding: 7vh 48px 64px; }
.kick { color: var(--dim); font-size: 15px; letter-spacing: .02em; margin: 0 0 18px; }
.hero h1 { font: clamp(56px, 8.4vw, 132px)/.92 "Archivo Black", sans-serif; letter-spacing: -.04em; margin: 0; max-width: 12ch; }
.hero h1 em { font-style: normal; color: transparent; -webkit-text-stroke: 2px var(--ink); }
.hero-row { display: flex; justify-content: space-between; align-items: end; gap: 40px; margin-top: 42px; }
.hero-row p { max-width: 460px; color: #c4beb5; margin: 0; font-size: 19px; }
.reel { display: flex; align-items: center; gap: 12px; font-size: 15px; color: var(--dim); }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--ember); box-shadow: 0 0 0 6px rgba(255, 90, 54, .18); animation: pulse 2s infinite; }
@keyframes pulse { 50% { box-shadow: 0 0 0 12px rgba(255, 90, 54, 0); } }
.marquee { overflow: hidden; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 18px 0; white-space: nowrap; }
.marquee div { display: inline-block; font: 28px "Archivo Black", sans-serif; color: #3a3836; animation: slide 40s linear infinite; }
@keyframes slide { to { transform: translateX(-50%); } }
.work { display: grid; grid-template-columns: repeat(12, 1fr); gap: 56px 32px; padding: 72px 48px; }
.piece { display: block; }
.p0 { grid-column: 1 / span 7; } .p1 { grid-column: 9 / span 4; margin-top: 160px; } .p2 { grid-column: 2 / span 5; } .p3 { grid-column: 7 / span 6; margin-top: 80px; } .p4 { grid-column: 1 / span 5; } .p5 { grid-column: 7 / span 6; margin-top: -60px; }
.frame { overflow: hidden; border-radius: 4px; background: #151517; }
.frame img { display: block; width: 100%; height: auto; transition: transform .6s cubic-bezier(.2, .7, .2, 1), filter .6s; filter: saturate(.9); }
.piece:hover img { transform: scale(1.03); filter: none; }
.cap { display: grid; grid-template-columns: 40px 1fr auto auto; gap: 16px; align-items: baseline; padding: 14px 0; border-bottom: 1px solid var(--line); font-size: 15px; color: var(--dim); }
.cap b { color: var(--ink); font-weight: 500; font-size: 18px; }
.cap .n { font-family: "Archivo Black", sans-serif; color: var(--ember); font-size: 13px; }
.about { padding: 40px 48px 80px; border-top: 1px solid var(--line); }
.about h2 { font: 15px "Space Grotesk", sans-serif; color: var(--dim); font-weight: 400; margin: 0 0 24px; }
.cols { display: grid; grid-template-columns: 1.2fr 1fr; gap: 64px; }
.big { font: 500 clamp(28px, 3vw, 42px)/1.2 "Space Grotesk", sans-serif; letter-spacing: -.02em; margin: 0; }
.cols div p { color: #b8b2a9; margin: 0 0 16px; }
.clients { list-style: none; padding: 0; margin: 56px 0; display: flex; flex-wrap: wrap; gap: 12px; }
.clients li { border: 1px solid var(--line); border-radius: 999px; padding: 8px 18px; font-size: 15px; color: #c4beb5; }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); border-top: 1px solid var(--line); }
.stats div { padding: 28px 0; border-right: 1px solid var(--line); padding-left: 24px; }
.stats div:first-child { padding-left: 0; }
.stats div:last-child { border-right: 0; }
.stats b { display: block; font: 64px/1 "Archivo Black", sans-serif; letter-spacing: -.03em; }
.stats span { color: var(--dim); font-size: 15px; }
.contact { padding: 100px 48px; text-align: center; background: radial-gradient(600px 300px at 50% 100%, rgba(255, 90, 54, .18), transparent); }
.mail { display: inline-block; font: clamp(44px, 7vw, 104px)/1 "Archivo Black", sans-serif; letter-spacing: -.04em; border-bottom: 4px solid var(--ember); padding-bottom: 8px; }
.social { display: flex; justify-content: center; gap: 28px; margin-top: 36px; color: var(--dim); font-size: 15px; }
footer { display: flex; justify-content: space-between; padding: 24px 48px; border-top: 1px solid var(--line); color: #5e5a55; font-size: 13px; }
@media (max-width: 900px) { .work { grid-template-columns: 1fr; } .work .piece { grid-column: auto !important; margin-top: 0 !important; } .cols { grid-template-columns: 1fr; } .nav nav { display: none; } .hero-row { flex-direction: column; align-items: start; } .stats { grid-template-columns: repeat(2, 1fr); } }
`;

export default {
  host: 'noir.test',
  name: 'NOIR',
  blurb: 'An independent design studio in Lisbon.',
  look: { bg: '#0b0b0c', ink: '#ece7df', accent: '#ff5a36', dark: true, font: '"Space Grotesk", system-ui, sans-serif' },
  iconLink: ICON,
  fonts: true,
  pages: [{ path: '/', title: 'NOIR — Ines Varga, design studio', what: 'A dark portfolio: big type in a bundled font, a grid of work, dark theme-color', art: art('abstract', { seed: 4, w: 900, h: 600 }) }],
  assets: {
    '/assets/site.css': { type: 'text/css; charset=utf-8', body: CSS },
    '/favicon.svg': { type: 'image/svg+xml', body: FAVICON },
  },
  routes: [['GET', '/', () => home()]],
} satisfies Site;
