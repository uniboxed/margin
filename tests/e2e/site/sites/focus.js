// focus.test: Focus, a work timer. It starts at once: the title counts down
// each second ("24:59 · Focus") and the icon, a data: URL, is redrawn with
// the time left as a ring. ?paused starts it stopped; ?from=<seconds> sets
// the time left. Browsers slow the clock in hidden tabs, so the title moves
// less often there.
import { doc, icon } from './common.js';

function timer() {
  const body = `
<div class="app">
  <header><a class="logo" href="/">${icon('clock', { size: 22, stroke: 2.2 })} Focus</a><nav><a class="on">Timer</a><a>Stats</a><a>Settings</a></nav><button class="pro">Upgrade</button></header>
  <main>
    <section class="clock">
      <div class="modes" role="tablist">${[['Focus', 25], ['Short break', 5], ['Long break', 15]].map(([n, m], i) => `<button class="${i ? '' : 'on'}" data-min="${m}">${n}</button>`).join('')}</div>
      <div class="ring"><svg viewBox="0 0 220 220"><circle cx="110" cy="110" r="96" class="track"/><circle cx="110" cy="110" r="96" class="prog" id="prog"/></svg><div class="time"><b id="time">25:00</b><span id="state">Focusing</span></div></div>
      <div class="ctrl"><button class="ghost" id="reset" aria-label="Reset">${icon('repeat', { size: 20 })}</button><button class="main" id="toggle">${icon('pause', { size: 22 })}<span>Pause</span></button><button class="ghost" id="skip" aria-label="Skip">${icon('skip', { size: 20 })}</button></div>
      <div class="dots">${[1, 1, 0, 0].map((d) => `<i class="${d ? 'done' : ''}"></i>`).join('')}<span>Session 3 of 4</span></div>
    </section>
    <section class="tasks">
      <h2>Today</h2>
      <div class="stats"><div><b>2</b><span>sessions</span></div><div><b>50m</b><span>focused</span></div><div><b>4</b><span>day streak</span></div></div>
      <ul>${[['Write the river piece intro', true, 2], ['Reply to Nora about Thursday', true, 1], ['Edit the salt pans photos', false, 3], ['Plan next week', false, 1]].map(([t, d, n], i) => `<li class="${d ? 'done' : ''}${i === 2 ? ' cur' : ''}"><label><input type="checkbox" ${d ? 'checked' : ''}><span>${t}</span></label><em>${'●'.repeat(n)}</em></li>`).join('')}</ul>
      <form class="add" onsubmit="event.preventDefault()">${icon('plus', { size: 18 })}<input placeholder="Add a task" aria-label="Add a task"></form>
    </section>
  </main>
</div>
<script src="/assets/focus.js" defer></script>`;
  return doc({ title: '25:00 · Focus', icon: '<link rel="icon" id="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E%3Ccircle cx=%2232%22 cy=%2232%22 r=%2230%22 fill=%22%23ef4f3f%22/%3E%3C/svg%3E">', themeColor: '#ef4f3f', body });
}

const CSS = `
:root { --tomato: #ef4f3f; --deep: #c4362a; --ink: #2a1512; --cream: #fff6f1; --sans: ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: radial-gradient(900px 600px at 20% 0%, #ff7a63, transparent), linear-gradient(160deg, #f25a45, #c4362a); color: #fff; font: 16px/1.45 var(--sans); -webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; cursor: pointer; }
a { color: inherit; text-decoration: none; }
.app { max-width: 1040px; margin: 0 auto; padding: 22px 28px 48px; }
header { display: flex; align-items: center; gap: 32px; }
.logo { display: flex; align-items: center; gap: 8px; font-weight: 800; font-size: 21px; }
header nav { display: flex; gap: 6px; background: rgba(0, 0, 0, .12); border-radius: 12px; padding: 4px; }
header nav a { padding: 6px 14px; border-radius: 9px; font-weight: 600; font-size: 14px; opacity: .85; cursor: pointer; }
header nav a.on { background: rgba(255, 255, 255, .2); opacity: 1; }
.pro { margin-left: auto; border: 0; background: #fff; color: var(--deep); font-weight: 800; padding: 9px 16px; border-radius: 12px; }
main { display: grid; grid-template-columns: 1.15fr 1fr; gap: 28px; margin-top: 36px; align-items: start; }
.clock { background: rgba(255, 255, 255, .12); border: 1px solid rgba(255, 255, 255, .22); border-radius: 28px; padding: 26px; display: flex; flex-direction: column; align-items: center; backdrop-filter: blur(10px); box-shadow: 0 30px 60px -30px rgba(80, 10, 0, .5); }
.modes { display: flex; gap: 6px; background: rgba(0, 0, 0, .14); border-radius: 14px; padding: 5px; }
.modes button { border: 0; background: none; padding: 8px 16px; border-radius: 10px; font-weight: 700; font-size: 14px; opacity: .8; }
.modes button.on { background: #fff; color: var(--deep); opacity: 1; }
.ring { position: relative; width: 300px; height: 300px; margin: 26px 0 18px; }
.ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.track { fill: none; stroke: rgba(255, 255, 255, .2); stroke-width: 12; }
.prog { fill: none; stroke: #fff; stroke-width: 12; stroke-linecap: round; stroke-dasharray: 603.2; stroke-dashoffset: 0; transition: stroke-dashoffset 1s linear; }
.time { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.time b { font: 800 76px/1 var(--sans); letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.time span { font-weight: 600; opacity: .85; margin-top: 6px; }
.ctrl { display: flex; align-items: center; gap: 18px; }
.ghost { width: 52px; height: 52px; border-radius: 50%; border: 0; background: rgba(255, 255, 255, .16); display: grid; place-items: center; }
.main { display: flex; align-items: center; gap: 10px; height: 60px; padding: 0 34px; border-radius: 20px; border: 0; background: #fff; color: var(--deep); font-weight: 800; font-size: 18px; box-shadow: 0 8px 0 #9e2a20; transition: transform .1s, box-shadow .1s; }
.main:active { transform: translateY(6px); box-shadow: 0 2px 0 #9e2a20; }
.dots { display: flex; align-items: center; gap: 8px; margin-top: 22px; font-size: 14px; font-weight: 600; opacity: .9; }
.dots i { width: 10px; height: 10px; border-radius: 50%; background: rgba(255, 255, 255, .3); }
.dots i.done { background: #fff; }
.dots span { margin-left: 6px; }
.tasks { background: var(--cream); color: var(--ink); border-radius: 28px; padding: 24px; box-shadow: 0 30px 60px -30px rgba(80, 10, 0, .5); }
.tasks h2 { margin: 0 0 14px; font-size: 22px; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 18px; }
.stats div { background: #fff; border-radius: 16px; padding: 12px 14px; box-shadow: 0 1px 0 #f3dcd2; }
.stats b { display: block; font-size: 24px; color: var(--deep); }
.stats span { font-size: 13px; color: #8a6a60; }
.tasks ul { list-style: none; margin: 0; padding: 0; }
.tasks li { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-radius: 14px; background: #fff; margin-bottom: 8px; box-shadow: 0 1px 0 #f3dcd2; }
.tasks li.cur { box-shadow: inset 4px 0 var(--tomato), 0 1px 0 #f3dcd2; }
.tasks label { display: flex; align-items: center; gap: 12px; font-weight: 600; cursor: pointer; }
.tasks input { accent-color: var(--tomato); width: 18px; height: 18px; }
.tasks li.done span { text-decoration: line-through; color: #b49a91; }
.tasks em { font-style: normal; color: var(--tomato); font-size: 10px; letter-spacing: 2px; }
.add { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 2px dashed #efc9bc; border-radius: 14px; color: #b07a6b; }
.add input { border: 0; background: none; outline: none; font: 600 15px var(--sans); flex: 1; color: var(--ink); }
@media (max-width: 860px) { main { grid-template-columns: 1fr; } }
`;

const JS = `
const q = new URLSearchParams(location.search);
let total = 25 * 60, left = Number(q.get('from')) || total, running = !q.has('paused'), last = performance.now();
const time = document.getElementById('time'), prog = document.getElementById('prog'), link = document.getElementById('icon');
const btn = document.getElementById('toggle');
const PAUSE = btn.querySelector('svg').outerHTML;
const PLAY = '<svg class="i" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>';
const mmss = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
const draw = () => {
  const f = left / total;
  time.textContent = mmss(left);
  document.title = mmss(left) + (running ? ' · Focus' : ' · Paused');
  document.getElementById('state').textContent = running ? 'Focusing' : 'Paused';
  prog.style.strokeDashoffset = String(603.2 * (1 - f));
  g.clearRect(0, 0, 64, 64);
  g.fillStyle = '#ef4f3f'; g.beginPath(); g.arc(32, 32, 31, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 7; g.beginPath(); g.arc(32, 32, 21, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = '#fff'; g.lineCap = 'round'; g.beginPath(); g.arc(32, 32, 21, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f); g.stroke();
  if (!running) { g.fillStyle = '#fff'; g.fillRect(25, 23, 5, 18); g.fillRect(34, 23, 5, 18); }
  link.href = c.toDataURL('image/png');
};
const setRunning = (on) => { running = on; btn.innerHTML = (on ? PAUSE : PLAY) + '<span>' + (on ? 'Pause' : 'Start') + '</span>'; draw(); };
setInterval(() => { if (running && left > 0) { left--; draw(); } }, 1000);
btn.addEventListener('click', () => setRunning(!running));
document.getElementById('reset').addEventListener('click', () => { left = total; draw(); });
document.getElementById('skip').addEventListener('click', () => { left = 0; draw(); });
document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', () => { document.querySelectorAll('.modes button').forEach((x) => x.classList.toggle('on', x === b)); total = left = Number(b.dataset.min) * 60; draw(); }));
setRunning(running);
`;

export default {
  host: 'focus.test',
  name: 'Focus',
  blurb: 'A calm timer for deep work.',
  look: { bg: '#fff6f1', ink: '#2a1512', accent: '#ef4f3f', font: 'ui-rounded, -apple-system, system-ui, sans-serif' },
  iconLink: '',
  pages: [{ path: '/', ticks: true, title: '25:00 · Focus', what: 'A timer: the title counts down each second, the icon (a data: URL) is redrawn', art: '/media/art/abstract.svg?seed=0&w=1200&h=700&bg=%23c4362a' }],
  assets: {
    '/assets/site.css': { type: 'text/css; charset=utf-8', body: CSS },
    '/assets/focus.js': { type: 'text/javascript; charset=utf-8', body: JS },
  },
  routes: [['GET', '/', () => timer()]],
};
