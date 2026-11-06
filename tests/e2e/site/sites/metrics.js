// metrics.test: Metrics, an analytics dashboard. KPI tiles with
// sparklines, a line chart and a donut in SVG, a stacked bar chart on a
// canvas, a top pages table and a live "active now" number. The page links
// no icon: the browser (and Margin) find /favicon.ico.
import { avatar, doc, esc, icon } from './common.js';
import { rng } from '../art.js';

const r = rng('metrics');
const DAYS = 30;
const visitors = Array.from({ length: DAYS }, (_, i) => Math.round(1400 + i * 22 + Math.sin(i / 2.2) * 260 + r() * 180 + (i % 7 > 4 ? -260 : 0)));
const previous = visitors.map((v, i) => Math.round(v * (0.78 + Math.sin(i / 3) * 0.05)));

function spark(values, color) {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 120},${36 - ((v - min) / (max - min || 1)) * 32 - 2}`).join(' ');
  return `<svg viewBox="0 0 120 36" width="120" height="36" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function lineChart() {
  const w = 720;
  const h = 260;
  const pad = { l: 44, r: 12, t: 16, b: 28 };
  const max = Math.ceil(Math.max(...visitors) / 400) * 400;
  const x = (i) => pad.l + (i / (DAYS - 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  const path = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const grid = Array.from({ length: 5 }, (_, i) => {
    const v = (max / 4) * i;
    return `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="#eef0f6"/><text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${v >= 1000 ? `${v / 1000}k` : v}</text>`;
  }).join('');
  const day = (i) => (i + 7 > 31 ? `Nov ${i + 7 - 31}` : `Oct ${i + 7}`);
  const labels = [0, 7, 14, 21, 29].map((i) => `<text x="${x(i)}" y="${h - 8}" text-anchor="${i === 0 ? 'start' : i === 29 ? 'end' : 'middle'}">${day(i)}</text>`).join('');
  const hi = 22;
  return `<svg class="line" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6d5efc" stop-opacity=".28"/><stop offset="1" stop-color="#6d5efc" stop-opacity="0"/></linearGradient></defs><g class="axis">${grid}${labels}</g><path d="${path(previous)}" fill="none" stroke="#b9b4f0" stroke-width="2" stroke-dasharray="5 5"/><path d="${path(visitors)} L${x(DAYS - 1)},${y(0)} L${x(0)},${y(0)} Z" fill="url(#area)"/><path d="${path(visitors)}" fill="none" stroke="#6d5efc" stroke-width="2.5" stroke-linejoin="round"/><line x1="${x(hi)}" x2="${x(hi)}" y1="${pad.t}" y2="${y(0)}" stroke="#6d5efc" stroke-dasharray="3 3" opacity=".5"/><circle cx="${x(hi)}" cy="${y(visitors[hi])}" r="5" fill="#fff" stroke="#6d5efc" stroke-width="2.5"/><g transform="translate(${x(hi) + 10} ${y(visitors[hi]) - 46})"><rect width="128" height="40" rx="8" fill="#1d1b3a"/><text x="10" y="16" fill="#b9b4f0" font-size="11">${day(hi)}</text><text x="10" y="32" fill="#fff" font-size="13" font-weight="600">${visitors[hi].toLocaleString('en-US')} visitors</text></g></svg>`;
}

function donut() {
  const parts = [['Desktop', 58, '#6d5efc'], ['Mobile', 34, '#36c5a3'], ['Tablet', 8, '#ffb547']];
  let at = 0;
  const C = 2 * Math.PI * 54;
  const rings = parts.map(([, v, c]) => {
    const s = `<circle cx="70" cy="70" r="54" fill="none" stroke="${c}" stroke-width="18" stroke-dasharray="${(v / 100) * C - 3} ${C}" stroke-dashoffset="${-at * C / 100}" transform="rotate(-90 70 70)"/>`;
    at += v;
    return s;
  }).join('');
  return `<div class="donut"><svg viewBox="0 0 140 140" width="150" height="150">${rings}<text x="70" y="66" text-anchor="middle" font-size="22" font-weight="700" fill="#14142b">48.2k</text><text x="70" y="84" text-anchor="middle" font-size="11" fill="#7a7f99">sessions</text></svg><ul>${parts.map(([n, v, c]) => `<li><i style="background:${c}"></i>${n}<b>${v}%</b></li>`).join('')}</ul></div>`;
}

const PAGES = [['/pricing', 18420, 0.92], ['/blog/the-quiet-city', 14210, 0.71], ['/', 12890, 0.64], ['/docs/getting-started', 9310, 0.47], ['/shop/canvas-tote', 7120, 0.36], ['/about', 3480, 0.18]];

function dashboard() {
  const kpis = [
    ['Revenue', '$284,120', '+12.4%', true, visitors.map((v) => v * 1.3)],
    ['Active users', '48,210', '+5.1%', true, visitors],
    ['Conversion', '3.42%', '−0.3%', false, visitors.map((v, i) => 3000 - v + i * 10)],
    ['Avg. session', '4m 12s', '+8.0%', true, previous],
  ];
  const body = `
<div class="shell">
  <aside class="nav">
    <div class="brand"><svg width="30" height="30" viewBox="0 0 30 30"><rect width="30" height="30" rx="9" fill="#6d5efc"/><rect x="7" y="15" width="4" height="8" rx="1.5" fill="#c9c3ff"/><rect x="13" y="10" width="4" height="13" rx="1.5" fill="#fff"/><rect x="19" y="6" width="4" height="17" rx="1.5" fill="#7ef0c4"/></svg>Metrics</div>
    <nav>${[['grid', 'Overview', 1], ['clock', 'Realtime'], ['user', 'Audience'], ['compass', 'Acquisition'], ['chart', 'Revenue'], ['file', 'Reports'], ['bell', 'Alerts']].map(([i, n, on]) => `<a href="/" class="${on ? 'on' : ''}">${icon(i, { size: 18 })}${n}</a>`).join('')}</nav>
    <div class="usage"><b>Plan usage</b><span>1.42M of 2M events</span><div class="bar"><i style="width:71%"></i></div><a href="/">Upgrade</a></div>
    <a class="set" href="/">${icon('settings', { size: 18 })}Settings</a>
  </aside>
  <main class="main">
    <header class="top"><div><h1>Overview</h1><p>harbor.test · All traffic</p></div><div class="tools"><button class="range">${icon('calendar', { size: 16 })} Last 30 days ${icon('down', { size: 14 })}</button><label class="cmp"><input type="checkbox" checked> Compare</label><button class="exp">${icon('share', { size: 16 })} Export</button><img src="${avatar('Priya Natarajan')}" alt="" width="34" height="34"></div></header>
    <section class="kpis">${kpis.map(([n, v, d, up, s]) => `<div class="kpi"><span>${n}</span><b>${v}</b><div class="kr"><em class="${up ? 'up' : 'down'}">${d}</em>${spark(s, up ? '#36c5a3' : '#ff6b6b')}</div></div>`).join('')}</section>
    <section class="row">
      <div class="card wide"><div class="ch"><div><h2>Visitors</h2><p>Unique visitors per day</p></div><div class="legend"><span><i></i>This period</span><span><i class="dash"></i>Previous</span></div></div>${lineChart()}</div>
      <div class="card live"><div class="ch"><h2><span class="dot"></span>Active now</h2></div><div class="now" id="now">1,284</div><p class="sub">visitors on the site</p><div class="mini">${Array.from({ length: 24 }, (_, i) => `<i style="height:${20 + Math.round(Math.abs(Math.sin(i / 2.5)) * 60 + (i * 7) % 20)}%"></i>`).join('')}</div><p class="sub">Last 30 minutes</p></div>
    </section>
    <section class="row three">
      <div class="card"><div class="ch"><h2>Revenue by channel</h2><p>Weekly</p></div><canvas id="bars" width="520" height="220"></canvas><div class="legend">${[['Search', '#6d5efc'], ['Direct', '#36c5a3'], ['Social', '#ffb547'], ['Email', '#ff6b9a']].map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('')}</div></div>
      <div class="card"><div class="ch"><h2>Devices</h2><p>Share of sessions</p></div>${donut()}</div>
      <div class="card"><div class="ch"><h2>Top pages</h2><p>Views</p></div><table>${PAGES.map(([p, v, f]) => `<tr><td><div class="pbar" style="--f:${f}"></div><span>${esc(p)}</span></td><td>${v.toLocaleString('en-US')}</td></tr>`).join('')}</table></div>
    </section>
  </main>
</div>
<script src="/assets/metrics.js" defer></script>`;
  return doc({ title: 'Overview · Metrics', themeColor: '#f5f6fb', body });
}

const CSS = `
:root { --ink: #14142b; --text: #4a4e69; --dim: #7a7f99; --line: #e8eaf3; --bg: #f5f6fb; --violet: #6d5efc; --green: #36c5a3; --sans: -apple-system, system-ui, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 var(--sans); -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums; }
a { color: inherit; text-decoration: none; }
button { font: inherit; color: inherit; cursor: pointer; }
.shell { display: grid; grid-template-columns: 232px 1fr; min-height: 100vh; }
.nav { background: #14142b; color: #b9bbd3; padding: 20px 14px; display: flex; flex-direction: column; gap: 6px; position: sticky; top: 0; height: 100vh; }
.brand { display: flex; align-items: center; gap: 10px; color: #fff; font-weight: 700; font-size: 18px; padding: 4px 8px 18px; }
.nav nav { display: flex; flex-direction: column; gap: 2px; }
.nav a { display: flex; align-items: center; gap: 12px; padding: 9px 10px; border-radius: 10px; font-weight: 500; }
.nav a:hover { background: #1f1f3d; color: #fff; }
.nav a.on { background: #262650; color: #fff; }
.usage { margin-top: auto; background: #1d1d3b; border-radius: 14px; padding: 14px; font-size: 13px; }
.usage b { color: #fff; display: block; }
.usage .bar { height: 6px; background: #2c2c55; border-radius: 3px; margin: 10px 0; }
.usage .bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--violet), #a69cff); border-radius: 3px; }
.usage a { color: #a69cff; font-weight: 600; }
.set { margin-top: 8px; }
.main { padding: 24px 28px 40px; min-width: 0; }
.top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 22px; }
.top h1 { font-size: 26px; color: var(--ink); margin: 0; letter-spacing: -.02em; }
.top p { margin: 2px 0 0; color: var(--dim); }
.tools { display: flex; align-items: center; gap: 10px; }
.tools button, .cmp { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 14px; border: 1px solid var(--line); background: #fff; border-radius: 10px; font-weight: 600; color: var(--ink); }
.cmp input { accent-color: var(--violet); }
.exp { background: var(--violet) !important; color: #fff !important; border-color: var(--violet) !important; }
.tools img { border-radius: 50%; margin-left: 4px; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 16px; }
.kpi, .card { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 16px 18px; box-shadow: 0 1px 2px rgba(20, 20, 43, .03); }
.kpi span { color: var(--dim); font-weight: 500; }
.kpi b { display: block; font-size: 24px; color: var(--ink); letter-spacing: -.02em; margin: 4px 0 6px; }
.kr { display: flex; justify-content: space-between; align-items: end; }
.kr em { font-style: normal; font-weight: 700; font-size: 13px; padding: 2px 8px; border-radius: 999px; }
.up { color: #148a6c; background: #e2f7f1; }
.down { color: #d13c3c; background: #ffeaea; }
.row { display: grid; grid-template-columns: 1fr 300px; gap: 16px; margin-bottom: 16px; }
.row.three { grid-template-columns: 1.2fr .9fr 1fr; }
.ch { display: flex; justify-content: space-between; align-items: start; margin-bottom: 10px; }
.card h2 { font-size: 15px; color: var(--ink); margin: 0; display: flex; align-items: center; gap: 8px; }
.ch p { margin: 2px 0 0; color: var(--dim); font-size: 13px; }
.legend { display: flex; gap: 14px; color: var(--dim); font-size: 12.5px; font-weight: 500; flex-wrap: wrap; }
.legend span { display: flex; align-items: center; gap: 6px; }
.legend i { width: 10px; height: 10px; border-radius: 3px; background: var(--violet); }
.legend i.dash { background: none; border-top: 2px dashed #b9b4f0; height: 0; width: 14px; border-radius: 0; }
svg.line { width: 100%; height: auto; display: block; }
.axis text { font-size: 11px; fill: var(--dim); }
.live { display: flex; flex-direction: column; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 0 rgba(54, 197, 163, .6); animation: ping 1.6s infinite; }
@keyframes ping { 70% { box-shadow: 0 0 0 8px rgba(54, 197, 163, 0); } }
.now { font-size: 54px; font-weight: 700; color: var(--ink); letter-spacing: -.03em; margin-top: 18px; transition: color .3s; }
.now.tick { color: var(--violet); }
.sub { color: var(--dim); margin: 0; }
.mini { display: flex; align-items: end; gap: 4px; height: 90px; margin: auto 0 8px; }
.mini i { flex: 1; background: linear-gradient(var(--violet), #a69cff); border-radius: 3px 3px 0 0; opacity: .85; }
canvas { width: 100%; height: auto; display: block; margin-bottom: 10px; }
.donut { display: flex; align-items: center; gap: 20px; padding-top: 10px; }
.donut ul { list-style: none; padding: 0; margin: 0; flex: 1; }
.donut li { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--line); color: var(--ink); }
.donut li i { width: 10px; height: 10px; border-radius: 3px; }
.donut li b { margin-left: auto; }
table { width: 100%; border-collapse: collapse; }
td { padding: 7px 0; color: var(--ink); font-weight: 500; }
td:last-child { text-align: right; color: var(--dim); }
td:first-child { position: relative; padding-left: 8px; }
.pbar { position: absolute; left: 0; top: 3px; bottom: 3px; width: calc(var(--f) * 92%); background: #f0eeff; border-radius: 6px; }
td span { position: relative; font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; }
@media (max-width: 1280px) { .row.three { grid-template-columns: 1fr 1fr; } .row.three .card:first-child { grid-column: span 2; } }
@media (max-width: 1000px) { .kpis { grid-template-columns: repeat(2, 1fr); } .row, .row.three { grid-template-columns: 1fr; } .row.three .card:first-child { grid-column: auto; } }
@media (max-width: 860px) { .shell { grid-template-columns: 1fr; } .nav { display: none; } }
`;

const JS = `
const c = document.getElementById('bars');
const g = c.getContext('2d');
const scale = devicePixelRatio || 1;
c.width = c.clientWidth * scale; c.height = c.clientWidth * 0.42 * scale; g.scale(scale, scale);
const W = c.clientWidth, H = c.clientWidth * 0.42;
const colors = ['#6d5efc', '#36c5a3', '#ffb547', '#ff6b9a'];
let s = 11; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
const weeks = Array.from({ length: 10 }, (_, i) => colors.map((_, k) => 8 + r() * 18 + i * (k === 0 ? 2.2 : 1)));
const max = Math.max(...weeks.map((w) => w.reduce((a, b) => a + b, 0)));
const bw = (W - 40) / weeks.length;
g.font = '11px -apple-system, system-ui, sans-serif'; g.fillStyle = '#7a7f99'; g.strokeStyle = '#eef0f6';
for (let i = 0; i <= 4; i++) { const y = 8 + (H - 30) * (i / 4); g.beginPath(); g.moveTo(34, y); g.lineTo(W, y); g.stroke(); g.fillText('$' + Math.round(max * (1 - i / 4)) + 'k', 0, y + 4); }
weeks.forEach((w, i) => {
  let y = H - 22;
  w.forEach((v, k) => {
    const h = (v / max) * (H - 30);
    g.fillStyle = colors[k];
    g.beginPath(); g.roundRect(40 + i * bw + bw * 0.2, y - h, bw * 0.6, h - 1.5, k === w.length - 1 ? [4, 4, 0, 0] : 0); g.fill();
    y -= h;
  });
  g.fillStyle = '#7a7f99'; g.fillText('W' + (35 + i), 40 + i * bw + bw * 0.18, H - 6);
});
const now = document.getElementById('now');
let n = 1284, seed = 3;
setInterval(() => {
  seed = (seed * 16807) % 2147483647;
  n = Math.max(900, n + Math.round(((seed / 2147483647) - 0.45) * 60));
  now.textContent = n.toLocaleString('en-US');
  now.classList.add('tick'); setTimeout(() => now.classList.remove('tick'), 400);
}, 2000);
`;

export default {
  host: 'metrics.test',
  name: 'Metrics',
  blurb: 'Analytics for small sites.',
  look: { bg: '#f5f6fb', ink: '#14142b', accent: '#6d5efc' },
  iconLink: '',
  pages: [{ path: '/', title: 'Overview · Metrics', what: 'A dashboard: KPI tiles, line, bar and donut charts, live numbers; no icon link, /favicon.ico only', art: '/media/art/abstract.svg?seed=3&w=1200&h=700&bg=%2314142b' }],
  assets: {
    '/assets/site.css': { type: 'text/css; charset=utf-8', body: CSS },
    '/assets/metrics.js': { type: 'text/javascript; charset=utf-8', body: JS },
  },
  routes: [['GET', '/', () => dashboard()]],
};
