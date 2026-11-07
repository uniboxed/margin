// docs.test: Lattice's documentation. Sticky sidebar nav, a table of
// contents with scroll spy, code blocks in colour with a copy button, heading
// anchors, tabs, callouts, media queries and vw units. ICO icon.
import { doc, esc, icon } from './common.js';

const ICON = '<link rel="icon" href="/favicon.ico" sizes="any">';

const KEYWORDS = /\b(import|from|export|const|let|function|return|await|async|new|if|else|default|true|false|null|undefined)\b/;
// A small highlighter: strings, comments, keywords, numbers, calls.
function highlight(code, lang) {
  if (lang === 'sh') return code.split('\n').map((l) => (l.startsWith('#') ? `<span class="c">${esc(l)}</span>` : `<span class="p">$</span> ${esc(l).replace(/^(\w+)/, '<span class="f">$1</span>')}`)).join('\n');
  const re = /(\/\/[^\n]*)|('[^'\n]*'|"[^"\n]*"|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_]\w*\b)(?=\s*\()|(\b[A-Za-z_]\w*\b)|(<\/?[A-Za-z][\w.]*)/g;
  let out = '';
  let last = 0;
  for (const m of code.matchAll(re)) {
    out += esc(code.slice(last, m.index));
    last = m.index + m[0].length;
    const t = esc(m[0]);
    if (m[1]) out += `<span class="c">${t}</span>`;
    else if (m[2]) out += `<span class="s">${t}</span>`;
    else if (m[3]) out += `<span class="n">${t}</span>`;
    else if (m[4]) out += KEYWORDS.test(m[4]) ? `<span class="k">${t}</span>` : `<span class="f">${t}</span>`;
    else if (m[5]) out += KEYWORDS.test(m[5]) ? `<span class="k">${t}</span>` : /^[A-Z]/.test(m[5]) ? `<span class="t">${t}</span>` : t;
    else out += `<span class="t">${t}</span>`;
  }
  return out + esc(code.slice(last));
}
const code = (src, lang = 'js', file) => `<div class="code">${file ? `<div class="code-h"><span>${icon('file', { size: 14 })}${esc(file)}</span><button class="copy">${icon('copy', { size: 14 })}<span>Copy</span></button></div>` : `<button class="copy solo">${icon('copy', { size: 14 })}<span>Copy</span></button>`}<pre><code class="lang-${lang}">${highlight(src.trim(), lang)}</code></pre></div>`;
const h2 = (id, text) => `<h2 id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${esc(text)}</h2>`;
const h3 = (id, text) => `<h3 id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${esc(text)}</h3>`;

const NAV = [
  ['Introduction', [['getting-started', 'Getting started'], ['installation', 'Installation'], ['core-concepts', 'Core concepts'], ['why-lattice', 'Why Lattice']]],
  ['Guides', [['stores', 'Stores'], ['derived-state', 'Derived state'], ['persistence', 'Persistence'], ['testing', 'Testing'], ['server-rendering', 'Server rendering']]],
  ['API reference', [['create-store', 'createStore'], ['derive', 'derive'], ['use-lattice', 'useLattice'], ['cli', 'Command line']]],
  ['Community', [['changelog', 'Changelog'], ['contributing', 'Contributing']]],
];

function gettingStarted() {
  return `
<p class="eyebrow">Introduction</p>
<h1>Getting started</h1>
<p class="lead">Lattice is a small state library for web apps. Stores are plain objects, changes are plain functions, and your views update on their own. This guide takes about ten minutes.</p>
<div class="callout tip">${icon('sun', { size: 18 })}<div><b>New in 4.2</b> Derived values are now lazy: they’re only worked out when something reads them. See <a href="/guide/derived-state">Derived state</a>.</div></div>
${h2('install', 'Install')}
<p>Lattice works with any bundler, or straight from a <code>&lt;script type="module"&gt;</code>. Add it to your project:</p>
${code('npm install lattice\n# or\npnpm add lattice', 'sh')}
<p>It has no dependencies and adds about <strong>2.1 kB</strong> to your bundle, minified and compressed.</p>
${h2('first-store', 'Create your first store')}
<p>A store holds a piece of your app’s state. Give it a starting value and the actions that change it:</p>
${code(`import { createStore } from 'lattice';

// A list of tasks, and the ways it can change.
export const tasks = createStore({
  items: [],
  filter: 'all',
}, {
  add(state, title) {
    state.items.push({ id: crypto.randomUUID(), title, done: false });
  },
  toggle(state, id) {
    const task = state.items.find((t) => t.id === id);
    if (task) task.done = !task.done;
  },
});`, 'js', 'src/stores/tasks.js')}
<p>Actions get a draft of the state they can change directly. Lattice works out what changed and tells anything that’s listening.</p>
${h2('read-update', 'Read and update state')}
<p>Call actions on the store, and read its state with <code>get()</code> or by subscribing:</p>
${code(`tasks.add('Water the plants');
tasks.add('Book the train');

console.log(tasks.get().items.length); // 2

const stop = tasks.subscribe((state) => {
  document.title = \`\${state.items.filter((t) => !t.done).length} to do\`;
});`, 'js')}
${h3('batching', 'Batching changes')}
<p>Several actions in the same task are batched: subscribers run once, after the last one. To group changes across an <code>await</code>, wrap them in <code>tasks.batch()</code>.</p>
<div class="callout warn">${icon('clock', { size: 18 })}<div><b>Heads up</b> Subscribers run in the order they were added. Don’t rely on that order for anything important; derive the value instead.</div></div>
${h2('frameworks', 'Use it with your framework')}
<div class="tabs" role="tablist"><button class="on" data-tab="react">React</button><button data-tab="vue">Vue</button><button data-tab="svelte">Svelte</button></div>
<div class="tab on" data-tab="react">${code(`import { useLattice } from 'lattice/react';
import { tasks } from './stores/tasks';

export function TaskList() {
  const items = useLattice(tasks, (s) => s.items);
  return <ul>{items.map((t) => <li key={t.id}>{t.title}</li>)}</ul>;
}`, 'js', 'TaskList.jsx')}</div>
<div class="tab" data-tab="vue">${code(`import { useLattice } from 'lattice/vue';
import { tasks } from './stores/tasks';

export default {
  setup() {
    const items = useLattice(tasks, (s) => s.items);
    return { items };
  },
};`, 'js', 'TaskList.vue')}</div>
<div class="tab" data-tab="svelte">${code(`import { tasks } from './stores/tasks';
// Stores are Svelte stores too: use $tasks in your markup.
const done = derive(tasks, (s) => s.items.filter((t) => t.done));`, 'js', 'TaskList.svelte')}</div>
${h2('options', 'Store options')}
<p>The third argument to <code>createStore</code> takes options:</p>
<div class="table"><table><thead><tr><th>Option</th><th>Type</th><th>Default</th><th>What it does</th></tr></thead><tbody>
<tr><td><code>name</code></td><td>string</td><td>—</td><td>Shown in the devtools and in warnings.</td></tr>
<tr><td><code>persist</code></td><td>boolean | object</td><td><code>false</code></td><td>Saves the state and restores it on the next visit.</td></tr>
<tr><td><code>equals</code></td><td>function</td><td><code>Object.is</code></td><td>Decides whether a selected value changed.</td></tr>
<tr><td><code>strict</code></td><td>boolean</td><td><code>true</code> in development</td><td>Throws if state is changed outside an action.</td></tr>
</tbody></table></div>
${h2('next-steps', 'Next steps')}
<div class="next">${[['Core concepts', 'How stores, actions and subscriptions fit together.', 'core-concepts'], ['Derived state', 'Values worked out from other values, kept up to date.', 'derived-state'], ['Testing', 'Test your stores without a browser.', 'testing'], ['API reference', 'Every function, every option.', 'create-store']].map(([t, d, h]) => `<a href="/guide/${h}"><b>${t} ${icon('chevron', { size: 14 })}</b><span>${d}</span></a>`).join('')}</div>
<div class="feedback"><span>Was this page helpful?</span><button>👍 Yes</button><button>👎 No</button><a href="/">${icon('file', { size: 14 })} Edit this page</a></div>
<nav class="pager"><span></span><a href="/guide/installation" class="nx"><small>Next</small>Installation ${icon('chevron', { size: 16 })}</a></nav>`;
}

function otherPage(slug, title, section) {
  return `
<p class="eyebrow">${esc(section)}</p>
<h1>${esc(title)}</h1>
<p class="lead">This page covers ${esc(title.toLowerCase())} in Lattice: what it is, when to use it, and a worked example you can copy.</p>
${h2('overview', 'Overview')}
<p>Most apps never need more than a handful of stores. Keep each one small and focused on a single part of your app, and let derived values join them together where a view needs both.</p>
${code(`import { createStore, derive } from 'lattice';

const cart = createStore({ lines: [] });
const total = derive(cart, (s) => s.lines.reduce((n, l) => n + l.price * l.qty, 0));`, 'js')}
${h2('example', 'Example')}
<p>The example below shows a complete store with two actions and a subscriber. It runs as is in any modern browser.</p>
${code(`const counter = createStore({ n: 0 }, {
  up(s) { s.n += 1; },
  reset(s) { s.n = 0; },
});

counter.subscribe((s) => console.log('now', s.n));
counter.up(); // now 1`, 'js', 'counter.js')}
${h2('see-also', 'See also')}
<ul><li><a href="/guide/getting-started">Getting started</a></li><li><a href="/guide/create-store">createStore</a></li></ul>`;
}

function page(slug) {
  const entry = NAV.flatMap(([s, items]) => items.map(([h, t]) => ({ slug: h, title: t, section: s }))).find((e) => e.slug === slug);
  if (!entry) return null;
  const main = slug === 'getting-started' ? gettingStarted() : otherPage(slug, entry.title, entry.section);
  const toc = [...main.matchAll(/<h([23]) id="([^"]+)"><a[^>]*>#<\/a>([^<]+)<\/h[23]>/g)].map(([, lvl, id, text]) => `<a href="#${id}" class="l${lvl}">${text}</a>`).join('');
  const body = `
<header class="top"><div class="top-in">
  <button class="menu" aria-label="Menu">${icon('menu')}</button>
  <a class="logo" href="/guide/getting-started"><svg width="26" height="26" viewBox="0 0 26 26"><rect width="26" height="26" rx="7" fill="#2f6df6"/><path d="M7 7v12h12" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M12 7v7h7" stroke="#b9cdfd" stroke-width="2.6" fill="none" stroke-linecap="round"/></svg>Lattice <span class="ver">v4.2</span></a>
  <nav><a href="/guide/getting-started" class="on">Docs</a><a href="/guide/create-store">API</a><a href="/guide/changelog">Changelog</a><a href="/">Blog</a></nav>
  <label class="search">${icon('search', { size: 16 })}<input placeholder="Search docs" aria-label="Search docs"><kbd>⌘K</kbd></label>
  <a class="gh" href="/">${icon('star', { size: 16 })} 18.4k</a>
</div></header>
<div class="shell">
  <aside class="side"><nav>${NAV.map(([s, items]) => `<div class="grp"><h5>${s}</h5>${items.map(([h, t]) => `<a href="/guide/${h}" class="${h === slug ? 'on' : ''}">${t}</a>`).join('')}</div>`).join('')}</nav></aside>
  <main class="content"><article>${main}</article></main>
  <aside class="toc"><h5>On this page</h5><nav id="toc">${toc}</nav><div class="toc-foot"><a href="#top">${icon('down', { size: 14 })} Back to top</a></div></aside>
</div>
<script src="/assets/docs.js" defer></script>`;
  return doc({ title: `${entry.title} · Lattice docs`, icon: ICON, themeColor: '#ffffff', body, bodyClass: 'docs' });
}

const CSS = `
:root { --ink: #0f172a; --text: #334155; --muted: #64748b; --line: #e2e8f0; --soft: #f8fafc; --blue: #2f6df6; --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace; --sans: -apple-system, system-ui, "Segoe UI", sans-serif; --top: 60px; }
* { box-sizing: border-box; }
html { scroll-padding-top: calc(var(--top) + 20px); scroll-behavior: smooth; }
body { margin: 0; color: var(--text); background: #fff; font: 16px/1.7 var(--sans); -webkit-font-smoothing: antialiased; }
a { color: var(--blue); text-decoration: none; }
.top { position: sticky; top: 0; z-index: 30; height: var(--top); background: rgba(255, 255, 255, .86); backdrop-filter: saturate(180%) blur(12px); border-bottom: 1px solid var(--line); }
.top-in { display: flex; align-items: center; gap: 28px; height: 100%; padding: 0 24px; max-width: 1440px; margin: 0 auto; }
.menu { display: none; background: none; border: 0; color: var(--ink); }
.logo { display: flex; align-items: center; gap: 10px; font: 700 18px var(--sans); color: var(--ink); }
.ver { font: 500 11px var(--mono); color: var(--muted); background: var(--soft); border: 1px solid var(--line); padding: 1px 6px; border-radius: 6px; }
.top nav { display: flex; gap: 22px; font-size: 14px; font-weight: 500; }
.top nav a { color: var(--muted); }
.top nav a.on { color: var(--ink); }
.search { margin-left: auto; display: flex; align-items: center; gap: 8px; width: 280px; height: 36px; padding: 0 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--soft); color: var(--muted); }
.search input { border: 0; background: none; outline: none; font: 14px var(--sans); flex: 1; }
kbd { font: 11px var(--mono); border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px; padding: 0 5px; background: #fff; }
.gh { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; color: var(--ink); border: 1px solid var(--line); padding: 6px 10px; border-radius: 8px; }
.shell { display: grid; grid-template-columns: 260px minmax(0, 1fr) 230px; max-width: 1440px; margin: 0 auto; }
.side { position: sticky; top: var(--top); height: calc(100vh - var(--top)); overflow-y: auto; padding: 28px 16px 40px 24px; border-right: 1px solid var(--line); }
.grp { margin-bottom: 22px; }
.grp h5, .toc h5 { margin: 0 0 6px; font: 600 12px var(--sans); text-transform: uppercase; letter-spacing: .06em; color: var(--ink); }
.side a { display: block; padding: 5px 10px; margin: 1px 0; border-radius: 7px; color: var(--muted); font-size: 14px; }
.side a:hover { color: var(--ink); background: var(--soft); }
.side a.on { color: var(--blue); background: #eef3ff; font-weight: 600; }
.content { padding: 44px clamp(24px, 4vw, 72px) 80px; min-width: 0; }
article { max-width: 760px; }
.eyebrow { color: var(--blue); font-weight: 600; font-size: 14px; margin: 0; }
h1 { font: 800 clamp(30px, 3.2vw, 44px)/1.15 var(--sans); color: var(--ink); letter-spacing: -.03em; margin: 6px 0 14px; }
.lead { font-size: 19px; color: var(--muted); margin: 0 0 26px; }
h2 { font: 700 26px/1.3 var(--sans); color: var(--ink); letter-spacing: -.02em; margin: 52px 0 12px; padding-top: 18px; border-top: 1px solid var(--line); position: relative; }
h3 { font: 600 19px/1.4 var(--sans); color: var(--ink); margin: 32px 0 8px; position: relative; }
.anchor { position: absolute; left: -24px; opacity: 0; color: var(--muted); font-weight: 400; transition: opacity .15s; }
h2:hover .anchor, h3:hover .anchor { opacity: 1; }
code { font: 0.86em var(--mono); background: #f1f5f9; color: #0f172a; padding: 2px 6px; border-radius: 6px; }
.code { position: relative; margin: 18px 0 22px; border-radius: 12px; overflow: hidden; background: #0d1424; border: 1px solid #1e293b; box-shadow: 0 8px 24px -16px rgba(15, 23, 42, .5); }
.code-h { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px 8px 16px; background: #131c30; border-bottom: 1px solid #1e293b; color: #94a3b8; font: 12.5px var(--mono); }
.code-h span { display: flex; gap: 8px; align-items: center; }
.code pre { margin: 0; padding: 16px 18px; overflow-x: auto; }
.code pre code { background: none; color: #e2e8f0; padding: 0; font-size: 13.5px; line-height: 1.65; }
.copy { display: flex; gap: 6px; align-items: center; font: 12px var(--sans); color: #94a3b8; background: #1e293b; border: 1px solid #334155; border-radius: 7px; padding: 4px 8px; cursor: pointer; }
.copy.solo { position: absolute; top: 10px; right: 10px; opacity: 0; transition: opacity .15s; }
.code:hover .copy.solo { opacity: 1; }
.copy.done { color: #86efac; border-color: #166534; }
.k { color: #c792ea; } .s { color: #a5e3a1; } .c { color: #64748b; font-style: italic; } .n { color: #f9a66c; } .f { color: #82aaff; } .t { color: #ffcb6b; } .p { color: #64748b; user-select: none; }
.callout { display: flex; gap: 12px; padding: 14px 16px; border-radius: 12px; margin: 20px 0; font-size: 15px; line-height: 1.6; }
.callout b { color: var(--ink); margin-right: 4px; }
.callout svg { flex-shrink: 0; margin-top: 3px; }
.tip { background: #eef6ff; border: 1px solid #cfe1ff; color: #1e3a8a; }
.tip svg { color: var(--blue); }
.warn { background: #fff8eb; border: 1px solid #fde4b0; color: #78350f; }
.warn svg { color: #d97706; }
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin-top: 16px; }
.tabs button { font: 600 14px var(--sans); color: var(--muted); background: none; border: 0; padding: 8px 14px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tabs button.on { color: var(--blue); border-bottom-color: var(--blue); }
.tab { display: none; }
.tab.on { display: block; }
.table { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; margin: 16px 0; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th { text-align: left; background: var(--soft); color: var(--ink); font-weight: 600; }
th, td { padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
.next { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.next a { border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; transition: .15s; }
.next a:hover { border-color: var(--blue); box-shadow: 0 6px 18px -10px rgba(47, 109, 246, .4); }
.next b { display: flex; align-items: center; gap: 4px; color: var(--ink); }
.next span { color: var(--muted); font-size: 14px; }
.feedback { display: flex; align-items: center; gap: 10px; margin: 48px 0 20px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 14px; color: var(--muted); }
.feedback button { font: 13px var(--sans); border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 4px 10px; cursor: pointer; }
.feedback a { margin-left: auto; display: flex; gap: 6px; align-items: center; color: var(--muted); }
.pager { display: flex; justify-content: space-between; }
.pager .nx { display: flex; flex-direction: column; align-items: flex-end; border: 1px solid var(--line); border-radius: 12px; padding: 12px 18px; font-weight: 600; min-width: 220px; }
.pager .nx small { color: var(--muted); font-weight: 400; }
.pager .nx svg { display: none; }
.toc { position: sticky; top: var(--top); height: calc(100vh - var(--top)); padding: 44px 24px 0 8px; font-size: 13.5px; }
.toc nav { border-left: 1px solid var(--line); }
.toc a { display: block; color: var(--muted); padding: 4px 0 4px 14px; margin-left: -1px; border-left: 2px solid transparent; line-height: 1.4; }
.toc a.l3 { padding-left: 26px; }
.toc a.on { color: var(--blue); border-left-color: var(--blue); font-weight: 600; }
.toc-foot { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--line); }
.toc-foot a { display: flex; gap: 6px; align-items: center; padding: 0; border: 0; }
.toc-foot svg { transform: rotate(180deg); }
@media (max-width: 1180px) { .shell { grid-template-columns: 240px minmax(0, 1fr); } .toc { display: none; } }
@media (max-width: 860px) { .shell { grid-template-columns: minmax(0, 1fr); } .side { display: none; } .menu { display: block; } .top nav, .gh { display: none; } .search { width: 180px; } .next { grid-template-columns: 1fr; } }
`;

const JS = `
const links = [...document.querySelectorAll('#toc a')];
const heads = links.map((a) => document.getElementById(a.hash.slice(1))).filter(Boolean);
const spy = () => {
  let current = heads[0];
  for (const h of heads) if (h.getBoundingClientRect().top < 120) current = h;
  links.forEach((a) => a.classList.toggle('on', a.hash === '#' + current?.id));
};
addEventListener('scroll', spy, { passive: true });
spy();
document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', () => {
  const text = b.closest('.code').querySelector('pre').innerText;
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.append(ta); ta.select();
  try { document.execCommand('copy'); } catch {}
  ta.remove();
  b.classList.add('done'); b.querySelector('span').textContent = 'Copied';
  setTimeout(() => { b.classList.remove('done'); b.querySelector('span').textContent = 'Copy'; }, 1600);
}));
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === b.dataset.tab));
}));
`;

export default {
  host: 'docs.test',
  name: 'Lattice docs',
  blurb: 'Documentation for Lattice, a small state library.',
  look: { bg: '#ffffff', ink: '#0f172a', accent: '#2f6df6' },
  iconLink: ICON,
  pages: [{ path: '/guide/getting-started', title: 'Getting started · Lattice docs', what: 'Docs: sticky nav, table of contents with scroll spy, code with a copy button, anchors', art: '/media/art/landscape.svg?seed=21&p=alpine&w=1200&h=700' }],
  assets: {
    '/assets/site.css': { type: 'text/css; charset=utf-8', body: CSS },
    '/assets/docs.js': { type: 'text/javascript; charset=utf-8', body: JS },
  },
  routes: [
    ['GET', '/', () => ({ status: 302, location: '/guide/getting-started' })],
    ['GET', /^\/guide\/([\w-]+)$/, ({ params }) => page(params[1])],
  ],
};
