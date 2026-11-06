// app.test: Orbit, a single-page project tracker. One HTML shell for every
// path; its own router draws each view. Links move with pushState; the
// Reports link is a plain link the Navigation API intercepts, with a slow
// route (700 ms, a top loading bar) before the view is drawn
// (.report-ready). Each view sets its title. SVG icon.
import { avatar, doc } from './common.js';

const ICON = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#111827"/><circle cx="32" cy="32" r="9" fill="#a78bfa"/><ellipse cx="32" cy="32" rx="22" ry="9" fill="none" stroke="#e5e7eb" stroke-width="3.5" transform="rotate(-30 32 32)"/><circle cx="50" cy="22" r="4" fill="#34d399"/></svg>`;

const PEOPLE = ['Ana Duarte', 'Jonas Vik', 'Mei Tanaka', 'Leo Marchetti', 'Priya Natarajan', 'Sam Ortiz'];
const DATA = {
  people: Object.fromEntries(PEOPLE.map((p) => [p, `/media/art/avatar.svg?name=${encodeURIComponent(p)}`])),
  projects: [
    { id: 'harbor-app', name: 'Harbor app', color: '#11808a', due: 'Dec 12', progress: 64, lead: 'Ana Duarte' },
    { id: 'quiet-city', name: 'The Quiet City', color: '#b3261e', due: 'Nov 20', progress: 88, lead: 'Mei Tanaka' },
    { id: 'shop-relaunch', name: 'Shop relaunch', color: '#2f5a3e', due: 'Jan 30', progress: 31, lead: 'Leo Marchetti' },
    { id: 'lattice-4-3', name: 'Lattice 4.3', color: '#2f6df6', due: 'Dec 2', progress: 52, lead: 'Jonas Vik' },
  ],
  tasks: [
    ['Design the booking flow', 'harbor-app', 'In progress', 'Ana Duarte', 'High'],
    ['Write the ferry guide copy', 'harbor-app', 'To do', 'Priya Natarajan', 'Medium'],
    ['Fix the date picker on small screens', 'harbor-app', 'In review', 'Sam Ortiz', 'High'],
    ['Edit the bakery section', 'quiet-city', 'Done', 'Mei Tanaka', 'Medium'],
    ['Pick the hero illustration', 'quiet-city', 'In review', 'Mei Tanaka', 'Low'],
    ['Product photos for winter', 'shop-relaunch', 'To do', 'Leo Marchetti', 'Medium'],
    ['New size guide', 'shop-relaunch', 'In progress', 'Sam Ortiz', 'Low'],
    ['Lazy derived values', 'lattice-4-3', 'Done', 'Jonas Vik', 'High'],
    ['Devtools timeline', 'lattice-4-3', 'In progress', 'Jonas Vik', 'Medium'],
    ['Docs for persistence', 'lattice-4-3', 'To do', 'Priya Natarajan', 'Low'],
  ],
};

function shell() {
  const body = `
<div class="app">
  <aside class="nav">
    <a class="brand" href="/" data-link>${FAVICON.replace('<svg ', '<svg width="28" height="28" ')}Orbit</a>
    <button class="new">+ New task <kbd>N</kbd></button>
    <nav id="nav">
      <a href="/" data-link><svg viewBox="0 0 24 24"><path d="m3 11 9-7 9 7M5 10v10h14V10"/></svg>Home</a>
      <a href="/inbox" data-link><svg viewBox="0 0 24 24"><path d="M3 13h5l1 3h6l1-3h5M5 5h14l2 8v6H3v-6z"/></svg>Inbox<b>3</b></a>
      <a href="/projects" data-link><svg viewBox="0 0 24 24"><path d="M3 6h6l2 2h10v11H3z"/></svg>Projects</a>
      <a href="/reports"><svg viewBox="0 0 24 24"><path d="M4 20V4M4 20h16M7 15l4-5 3 3 5-7"/></svg>Reports</a>
      <a href="/settings" data-link><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>Settings</a>
    </nav>
    <h5>Projects</h5>
    <nav class="projects">${DATA.projects.map((p) => `<a href="/projects/${p.id}" data-link><i style="background:${p.color}"></i>${p.name}</a>`).join('')}</nav>
    <div class="me"><img src="${avatar('Sam Ortiz')}" alt="" width="30" height="30"><span>Sam Ortiz</span></div>
  </aside>
  <div class="bar" id="bar"></div>
  <main id="view"></main>
</div>
<script>window.DATA = ${JSON.stringify(DATA)};</script>
<script src="/assets/app.js" defer></script>`;
  return doc({ title: 'Orbit', icon: ICON, themeColor: '#0b0f19', body });
}

const CSS = `
:root { --bg: #0b0f19; --side: #0f1422; --panel: #151b2c; --line: #232a3d; --ink: #e5e7eb; --dim: #8b93a7; --violet: #a78bfa; --green: #34d399; --sans: -apple-system, system-ui, "Inter", sans-serif; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
button { font: inherit; color: inherit; cursor: pointer; }
.app { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
.nav { background: var(--side); border-right: 1px solid var(--line); padding: 16px 12px; display: flex; flex-direction: column; gap: 4px; position: sticky; top: 0; height: 100vh; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 17px; padding: 4px 8px 12px; }
.new { display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--line); background: var(--panel); border-radius: 10px; padding: 8px 12px; color: var(--ink); font-weight: 600; margin-bottom: 10px; }
kbd { font: 11px ui-monospace, Menlo, monospace; color: var(--dim); border: 1px solid var(--line); border-radius: 5px; padding: 0 5px; }
.nav nav a { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; color: var(--dim); font-weight: 500; }
.nav nav a:hover { background: #161d30; color: var(--ink); }
.nav nav a.on { background: #1b2238; color: var(--ink); }
.nav nav svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.nav nav a b { margin-left: auto; font-size: 11px; background: var(--violet); color: #1e1342; border-radius: 9px; padding: 0 6px; }
.nav h5 { margin: 16px 10px 4px; font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .08em; }
.projects i { width: 9px; height: 9px; border-radius: 3px; }
.me { margin-top: auto; display: flex; align-items: center; gap: 10px; padding: 8px; color: var(--dim); }
.me img { border-radius: 50%; }
.bar { position: fixed; top: 0; left: 0; height: 2px; width: 0; background: linear-gradient(90deg, var(--violet), var(--green)); z-index: 10; opacity: 0; }
.bar.go { opacity: 1; width: 80%; transition: width .7s cubic-bezier(.1, .7, .3, 1); }
.bar.done { opacity: 0; width: 100%; transition: width .15s, opacity .3s .15s; }
main { padding: 28px 36px 48px; min-width: 0; animation: fade .25s; }
@keyframes fade { from { opacity: 0; transform: translateY(4px); } }
.head { display: flex; justify-content: space-between; align-items: end; margin-bottom: 22px; }
h1 { font-size: 26px; margin: 0; letter-spacing: -.02em; }
.sub { color: var(--dim); margin: 2px 0 0; }
.btn { border: 0; background: var(--violet); color: #1e1342; font-weight: 700; border-radius: 10px; padding: 9px 14px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px; display: block; transition: border-color .15s, transform .15s; }
a.card:hover { border-color: #3a4462; transform: translateY(-2px); }
.card .top { display: flex; justify-content: space-between; align-items: center; }
.dotc { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; font-weight: 800; color: #fff; }
.card h3 { margin: 14px 0 2px; font-size: 16px; }
.card p { margin: 0; color: var(--dim); font-size: 13px; }
.prog { height: 6px; background: #222a40; border-radius: 3px; margin-top: 14px; overflow: hidden; }
.prog i { display: block; height: 100%; border-radius: 3px; }
.faces { display: flex; }
.faces img { border-radius: 50%; border: 2px solid var(--panel); margin-left: -8px; }
.section { margin-top: 30px; }
.section h2 { font-size: 15px; color: var(--dim); font-weight: 600; margin: 0 0 10px; }
.tasks { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
.task { display: grid; grid-template-columns: 22px 1fr 130px 110px 80px; gap: 12px; align-items: center; padding: 11px 16px; border-top: 1px solid var(--line); }
.task:first-child { border-top: 0; }
.task .ck { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--dim); }
.task.done .ck { background: var(--green); border-color: var(--green); }
.task.done .t { color: var(--dim); text-decoration: line-through; }
.st { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 6px; width: fit-content; }
.st.todo { background: #232a3d; color: var(--dim); } .st.prog2 { background: #2d2350; color: var(--violet); } .st.rev { background: #3a2f12; color: #fbbf24; } .st.done { background: #0f3327; color: var(--green); }
.pri { font-size: 12px; color: var(--dim); }
.who { display: flex; align-items: center; gap: 6px; color: var(--dim); font-size: 12px; }
.who img { border-radius: 50%; }
.board { display: grid; grid-template-columns: repeat(4, minmax(220px, 1fr)); gap: 14px; overflow-x: auto; }
.col { background: var(--side); border: 1px solid var(--line); border-radius: 14px; padding: 12px; min-height: 300px; }
.col h3 { font-size: 13px; color: var(--dim); margin: 0 0 10px; display: flex; justify-content: space-between; }
.tk { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
.tk b { display: block; font-weight: 600; margin-bottom: 8px; }
.tk div { display: flex; justify-content: space-between; align-items: center; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.kpis .card b { display: block; font-size: 28px; letter-spacing: -.02em; }
.chart { height: 220px; display: flex; align-items: end; gap: 10px; padding: 20px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; margin-top: 14px; }
.chart i { flex: 1; border-radius: 6px 6px 0 0; background: linear-gradient(var(--violet), #6d5efc); }
.form { max-width: 560px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 6px 18px; }
.form label { display: flex; justify-content: space-between; align-items: center; padding: 14px 0; border-top: 1px solid var(--line); }
.form label:first-child { border-top: 0; }
.form input[type=text] { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; color: var(--ink); font: 14px var(--sans); width: 220px; }
.form input[type=checkbox] { accent-color: var(--violet); width: 18px; height: 18px; }
.msg { display: flex; gap: 12px; padding: 14px 16px; border-top: 1px solid var(--line); }
.msg:first-child { border-top: 0; }
.msg img { border-radius: 50%; }
.msg b { font-weight: 600; }
.msg p { margin: 2px 0 0; color: var(--dim); }
`;

const JS = `
const view = document.getElementById('view');
const bar = document.getElementById('bar');
const P = DATA.projects;
const face = (n, s = 22) => '<img src="' + DATA.people[n] + '" width="' + s + '" height="' + s + '" alt="">';
const ST = { 'To do': 'todo', 'In progress': 'prog2', 'In review': 'rev', 'Done': 'done' };
const taskRow = ([t, p, s, who, pri]) => '<div class="task' + (s === 'Done' ? ' done' : '') + '"><span class="ck"></span><span class="t">' + t + '</span><span class="st ' + ST[s] + '">' + s + '</span><span class="who">' + face(who, 20) + who.split(' ')[0] + '</span><span class="pri">' + pri + '</span></div>';
const card = (p) => '<a class="card" href="/projects/' + p.id + '" data-link><div class="top"><span class="dotc" style="background:' + p.color + '">' + p.name[0] + '</span><span class="faces">' + PEOPLE(p).map((n) => face(n, 26)).join('') + '</span></div><h3>' + p.name + '</h3><p>Due ' + p.due + ' · ' + p.progress + '% done</p><div class="prog"><i style="width:' + p.progress + '%;background:' + p.color + '"></i></div></a>';
const PEOPLE = (p) => [...new Set(DATA.tasks.filter((t) => t[1] === p.id).map((t) => t[3]))];
const views = {
  '/': () => ['Home', '<div class="head"><div><h1>Good morning, Sam</h1><p class="sub">Friday, 6 November · 4 tasks due this week</p></div><button class="btn">+ New task</button></div><div class="cards">' + P.map(card).join('') + '</div><div class="section"><h2>My tasks</h2><div class="tasks">' + DATA.tasks.filter((t) => t[3] === 'Sam Ortiz' || t[2] === 'In progress').map(taskRow).join('') + '</div></div>'],
  '/inbox': () => ['Inbox', '<div class="head"><div><h1>Inbox</h1><p class="sub">3 unread</p></div></div><div class="tasks">' + [['Ana Duarte', 'assigned you “Fix the date picker on small screens”'], ['Mei Tanaka', 'commented on “Pick the hero illustration”: the dawn one, surely?'], ['Jonas Vik', 'moved “Lazy derived values” to Done']].map(([n, x]) => '<div class="msg">' + face(n, 34) + '<div><b>' + n + '</b><p>' + x + '</p></div></div>').join('') + '</div>'],
  '/projects': () => ['Projects', '<div class="head"><div><h1>Projects</h1><p class="sub">' + P.length + ' active</p></div><button class="btn">+ New project</button></div><div class="cards">' + P.map(card).join('') + '</div>'],
  '/settings': () => ['Settings', '<div class="head"><div><h1>Settings</h1><p class="sub">Your workspace</p></div></div><div class="form"><label>Workspace name <input type="text" value="Tidewater"></label><label>Email me a daily summary <input type="checkbox" checked></label><label>Show completed tasks <input type="checkbox"></label><label>Start the week on Monday <input type="checkbox" checked></label></div>'],
  '/reports': () => ['Reports', '<div class="report-ready"><div class="head"><div><h1>Reports</h1><p class="sub">Last 30 days, all projects</p></div><button class="btn">Export</button></div><div class="kpis">' + [['Done', 38], ['Opened', 52], ['Overdue', 4], ['Cycle time', '3.2d']].map(([n, v]) => '<div class="card"><p>' + n + '</p><b>' + v + '</b></div>').join('') + '</div><div class="chart">' + [40, 55, 38, 70, 64, 82, 58, 90, 74, 66, 88, 95].map((h) => '<i style="height:' + h + '%"></i>').join('') + '</div></div>'],
};
const project = (id) => {
  const p = P.find((x) => x.id === id);
  if (!p) return ['Not found', '<div class="head"><div><h1>No such project</h1><p class="sub">It may have been archived.</p></div></div>'];
  const cols = ['To do', 'In progress', 'In review', 'Done'];
  return [p.name, '<div class="head"><div><h1>' + p.name + '</h1><p class="sub">Led by ' + p.lead + ' · due ' + p.due + '</p></div><button class="btn">+ Add task</button></div><div class="board">' + cols.map((c) => { const ts = DATA.tasks.filter((t) => t[1] === id && t[2] === c); return '<div class="col"><h3>' + c + '<span>' + ts.length + '</span></h3>' + ts.map((t) => '<div class="tk"><b>' + t[0] + '</b><div><span class="pri">' + t[4] + '</span>' + face(t[3], 22) + '</div></div>').join('') + '</div>'; }).join('') + '</div>'];
};
const render = (path) => {
  const m = /^\\/projects\\/([\\w-]+)$/.exec(path);
  const [title, html] = m ? project(m[1]) : (views[path] || (() => ['Not found', '<div class="head"><div><h1>Nothing here</h1><p class="sub">That page doesn’t exist in Orbit.</p></div></div>']))();
  view.innerHTML = html;
  view.style.animation = 'none'; view.offsetHeight; view.style.animation = '';
  document.title = title + ' · Orbit';
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === path || (path.startsWith('/projects/') && a.getAttribute('href') === path)));
};
// Links: pushState.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
  e.preventDefault();
  if (a.pathname === location.pathname) return;
  history.pushState(null, '', a.pathname);
  render(a.pathname);
});
addEventListener('popstate', () => render(location.pathname));
// Reports: a plain link, intercepted by the Navigation API, 700 ms to arrive.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (window.navigation) {
  navigation.addEventListener('navigate', (e) => {
    const url = new URL(e.destination.url);
    if (!e.canIntercept || url.origin !== location.origin || url.pathname !== '/reports' || e.hashChange || e.downloadRequest) return;
    e.intercept({ async handler() {
      bar.className = 'bar'; bar.offsetWidth; bar.className = 'bar go';
      await sleep(700);
      render('/reports');
      bar.className = 'bar done';
    } });
  });
}
render(location.pathname);
`;

export default {
  host: 'app.test',
  name: 'Orbit',
  blurb: 'Projects and tasks for small teams.',
  look: { bg: '#0b0f19', ink: '#e5e7eb', accent: '#a78bfa', dark: true },
  iconLink: ICON,
  pages: [{ path: '/', title: 'Home · Orbit', what: 'A single-page app: pushState routes, a slow route through the Navigation API', art: '/media/art/abstract.svg?seed=0&w=1200&h=700&bg=%230b0f19' }],
  assets: {
    '/assets/site.css': { type: 'text/css; charset=utf-8', body: CSS },
    '/assets/app.js': { type: 'text/javascript; charset=utf-8', body: JS },
    '/favicon.svg': { type: 'image/svg+xml', body: FAVICON },
  },
  // The app's paths all get the shell; its router draws the view.
  routes: [['GET', /^\/(inbox|projects(\/[\w-]+)?|settings|reports)?$/, () => shell()]],
};
