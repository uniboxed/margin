// radio.test: Radio Field, a podcast player. An <audio> with the made-up
// tune (make-media.mjs), custom controls, a waveform drawn on a canvas,
// chapters that seek, and Media Session metadata. Nothing plays until the
// play button (#play) or a test's play(). ICO icon.
import { art, doc, esc, icon } from './common.js';

const ICON = '<link rel="icon" href="/favicon.ico">';
const CHAPTERS = [[0, 'Cold open: the harbour at dawn'], [4, 'Why the tide matters'], [9, 'Recording on the mud flats'], [14, 'An interview with the lock keeper'], [19, 'What we heard at low water']];
const EPISODES = [
  [42, 'The sound of low tide', '24 min', 'Nov 4'],
  [41, 'Lighthouse lenses, up close', '38 min', 'Oct 28'],
  [40, 'A night on the sleeper train', '52 min', 'Oct 21'],
  [39, 'Bakers before dawn', '31 min', 'Oct 14'],
  [38, 'Salt, sun and patience', '44 min', 'Oct 7'],
];

function player() {
  const cover = art('abstract', { seed: 0, w: 600, h: 600, bg: '#2a1b3d' });
  const body = `
<header class="top"><a class="logo" href="/"><svg width="30" height="30" viewBox="0 0 30 30"><rect width="30" height="30" rx="9" fill="#2a1b3d"/><circle cx="15" cy="15" r="9" fill="none" stroke="#ff8a5b" stroke-width="2.2"/><circle cx="15" cy="15" r="5" fill="none" stroke="#ffc36b" stroke-width="2.2"/><circle cx="15" cy="15" r="1.8" fill="#fff"/></svg>Radio Field</a><nav><a class="on">Episodes</a><a>About</a><a>Support the show</a></nav><button class="follow">${icon('plus', { size: 16 })} Follow</button></header>
<main>
  <section class="ep">
    <img class="cover" src="${cover}" alt="" width="300" height="300">
    <div class="info">
      <p class="kick">Episode 42 · 4 November 2026</p>
      <h1>The sound of low tide</h1>
      <p class="show">Field Recordings with Isla Brennan</p>
      <p class="about">We spend a morning on the mud flats with a pair of microphones and a lock keeper who has listened to this estuary for forty years. What does the sea sound like when it leaves?</p>
      <div class="player">
        <button class="play" id="play" aria-label="Play">${icon('play', { size: 26, stroke: 0 })}</button>
        <div class="track"><canvas id="wave" height="64"></canvas><div class="times"><span id="cur">0:00</span><span id="dur">0:24</span></div></div>
      </div>
      <div class="tools"><button data-skip="-15">${icon('back', { size: 16 })} 15s</button><button data-skip="15">15s ${icon('skip', { size: 16 })}</button><button id="speed">1×</button><label>${icon('volume', { size: 16 })}<input type="range" id="vol" min="0" max="1" step="0.05" value="0.8" aria-label="Volume"></label></div>
      <audio id="audio" src="/tune.wav" preload="metadata"></audio>
    </div>
  </section>
  <section class="cols">
    <div class="chapters"><h2>Chapters</h2><ol>${CHAPTERS.map(([t, n]) => `<li data-t="${t}"><span>0:${String(t).padStart(2, '0')}</span>${esc(n)}</li>`).join('')}</ol></div>
    <div class="list"><h2>More episodes</h2>${EPISODES.slice(1).map(([n, t, d, w], i) => `<a href="/" class="row"><img src="${art('landscape', { seed: n, p: ['night', 'dusk', 'dawn', 'desert'][i], w: 160, h: 160 })}" alt="" width="56" height="56"><div><b>${n}. ${esc(t)}</b><span>${w} · ${d}</span></div><i>${icon('play', { size: 14, stroke: 0 })}</i></a>`).join('')}</div>
  </section>
</main>
<script>window.CHAPTERS = ${JSON.stringify(CHAPTERS)};</script>
<script src="/assets/radio.js" defer></script>`;
  return doc({ title: 'The sound of low tide · Radio Field', icon: ICON, themeColor: '#160e22', htmlClass: 'dark', body });
}

const CSS = `
:root { color-scheme: dark; --bg: #160e22; --panel: #221735; --line: #34264a; --ink: #f6eefc; --dim: #b3a6c4; --orange: #ff8a5b; --gold: #ffc36b; --serif: ui-serif, "Iowan Old Style", Georgia, serif; --sans: -apple-system, system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: radial-gradient(1000px 500px at 80% -10%, #4a2448, transparent), var(--bg); color: var(--ink); font: 15px/1.5 var(--sans); -webkit-font-smoothing: antialiased; min-height: 100vh; }
a { color: inherit; text-decoration: none; }
button { font: inherit; color: inherit; cursor: pointer; }
.top { display: flex; align-items: center; gap: 36px; max-width: 1100px; margin: 0 auto; padding: 22px 32px; }
.logo { display: flex; align-items: center; gap: 10px; font: 700 20px var(--serif); }
.top nav { display: flex; gap: 22px; color: var(--dim); font-weight: 500; }
.top nav a { cursor: pointer; }
.top nav a.on { color: var(--ink); }
.follow { margin-left: auto; display: flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 8px 16px; font-weight: 600; }
main { max-width: 1100px; margin: 0 auto; padding: 20px 32px 60px; }
.ep { display: grid; grid-template-columns: 300px 1fr; gap: 40px; align-items: start; }
.cover { width: 300px; height: 300px; border-radius: 24px; box-shadow: 0 30px 60px -20px rgba(0, 0, 0, .7); display: block; }
.kick { color: var(--orange); font-weight: 700; font-size: 13px; letter-spacing: .06em; text-transform: uppercase; margin: 6px 0 0; }
h1 { font: 700 46px/1.05 var(--serif); margin: 10px 0 6px; letter-spacing: -.01em; }
.show { color: var(--gold); font-weight: 600; margin: 0 0 12px; }
.about { color: var(--dim); max-width: 600px; margin: 0 0 22px; font-size: 16px; }
.player { display: flex; align-items: center; gap: 18px; background: var(--panel); border: 1px solid var(--line); border-radius: 20px; padding: 14px 18px; }
.play { width: 64px; height: 64px; flex-shrink: 0; border-radius: 50%; border: 0; background: linear-gradient(135deg, var(--gold), var(--orange)); color: #2a1b3d; display: grid; place-items: center; box-shadow: 0 10px 24px -8px rgba(255, 138, 91, .8); }
.play svg { fill: #2a1b3d; }
.track { flex: 1; min-width: 0; }
#wave { width: 100%; height: 64px; display: block; cursor: pointer; }
.times { display: flex; justify-content: space-between; color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
.tools { display: flex; gap: 10px; margin-top: 14px; align-items: center; }
.tools button { display: flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: none; border-radius: 10px; padding: 6px 12px; color: var(--dim); font-weight: 600; font-size: 13px; }
.tools label { display: flex; align-items: center; gap: 8px; color: var(--dim); margin-left: 8px; }
.tools input { accent-color: var(--orange); width: 110px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-top: 44px; }
h2 { font: 700 22px var(--serif); margin: 0 0 14px; }
.chapters ol { list-style: none; margin: 0; padding: 0; }
.chapters li { display: flex; gap: 14px; padding: 12px 14px; border-radius: 12px; cursor: pointer; color: var(--dim); }
.chapters li:hover { background: var(--panel); }
.chapters li.on { background: var(--panel); color: var(--ink); box-shadow: inset 3px 0 var(--orange); }
.chapters li span { font-variant-numeric: tabular-nums; color: var(--gold); font-weight: 600; }
.row { display: flex; align-items: center; gap: 14px; padding: 10px; border-radius: 14px; }
.row:hover { background: var(--panel); }
.row img { border-radius: 10px; }
.row b { display: block; font-weight: 600; }
.row span { color: var(--dim); font-size: 13px; }
.row i { margin-left: auto; width: 34px; height: 34px; border-radius: 50%; border: 1px solid var(--line); display: grid; place-items: center; }
.row i svg { fill: var(--ink); }
@media (max-width: 900px) { .ep, .cols { grid-template-columns: 1fr; } }
`;

const JS = `
const audio = document.getElementById('audio');
const play = document.getElementById('play');
const wave = document.getElementById('wave');
const g = wave.getContext('2d');
let s = 5; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
const bars = Array.from({ length: 120 }, (_, i) => 0.25 + 0.55 * Math.abs(Math.sin(i / 6)) * (0.6 + r() * 0.4) + (i % 16 === 0 ? 0.2 : 0));
const PLAY = play.innerHTML;
const PAUSE = '<svg width="26" height="26" viewBox="0 0 24 24" fill="#2a1b3d"><path d="M7 4h3v16H7zM14 4h3v16h-3z"/></svg>';
const fmt = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
const draw = () => {
  const w = wave.clientWidth, h = 64, dpr = devicePixelRatio || 1;
  if (wave.width !== w * dpr) { wave.width = w * dpr; wave.height = h * dpr; }
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const f = audio.duration ? audio.currentTime / audio.duration : 0;
  const bw = w / bars.length;
  bars.forEach((v, i) => {
    const bh = v * h * 0.9;
    g.fillStyle = i / bars.length < f ? (i % 2 ? '#ff8a5b' : '#ffc36b') : '#4a3a62';
    g.beginPath(); g.roundRect(i * bw + 1, (h - bh) / 2, Math.max(1.5, bw - 2), bh, 2); g.fill();
  });
  document.getElementById('cur').textContent = fmt(audio.currentTime);
  if (audio.duration) document.getElementById('dur').textContent = fmt(audio.duration);
  const t = audio.currentTime;
  document.querySelectorAll('.chapters li').forEach((li, i) => li.classList.toggle('on', t >= CHAPTERS[i][0] && (i === CHAPTERS.length - 1 || t < CHAPTERS[i + 1][0])));
};
const loop = () => { draw(); if (!audio.paused) requestAnimationFrame(loop); };
audio.addEventListener('play', () => { play.innerHTML = PAUSE; play.setAttribute('aria-label', 'Pause'); if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing'; loop(); });
audio.addEventListener('pause', () => { play.innerHTML = PLAY; play.setAttribute('aria-label', 'Play'); if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'; draw(); });
audio.addEventListener('loadedmetadata', draw);
play.addEventListener('click', () => (audio.paused ? audio.play() : audio.pause()));
wave.addEventListener('click', (e) => { if (audio.duration) { audio.currentTime = (e.offsetX / wave.clientWidth) * audio.duration; draw(); } });
document.querySelectorAll('[data-skip]').forEach((b) => b.addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime + Number(b.dataset.skip)); draw(); }));
document.getElementById('speed').addEventListener('click', (e) => { const r = audio.playbackRate === 1 ? 1.5 : audio.playbackRate === 1.5 ? 2 : 1; audio.playbackRate = r; e.currentTarget.textContent = r + '×'; });
document.getElementById('vol').addEventListener('input', (e) => (audio.volume = Number(e.target.value)));
document.querySelectorAll('.chapters li').forEach((li) => li.addEventListener('click', () => { audio.currentTime = Number(li.dataset.t); draw(); }));
if (navigator.mediaSession && window.MediaMetadata) navigator.mediaSession.metadata = new MediaMetadata({ title: 'The sound of low tide', artist: 'Radio Field', album: 'Field Recordings' });
addEventListener('resize', draw);
draw();
`;

export default {
  host: 'radio.test',
  name: 'Radio Field',
  blurb: 'Field Recordings, a podcast about places and their sounds.',
  look: { bg: '#160e22', ink: '#f6eefc', accent: '#ff8a5b', dark: true },
  iconLink: ICON,
  pages: [{ path: '/', title: 'The sound of low tide · Radio Field', what: 'A podcast player: the made-up tune in an <audio>, a waveform on canvas, chapters', art: art('abstract', { seed: 0, w: 1200, h: 700, bg: '#2a1b3d' }) }],
  assets: {
    '/assets/site.css': { type: 'text/css; charset=utf-8', body: CSS },
    '/assets/radio.js': { type: 'text/javascript; charset=utf-8', body: JS },
  },
  routes: [['GET', '/', () => player()]],
};
