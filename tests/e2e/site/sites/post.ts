// post.test: Post, a mail app. Folders and labels, a message list, a
// reading pane, and a compose window whose draft guards the page
// (beforeunload). The unread count is in the title, "Inbox (4) — Post", and
// in the icon, a data: URL drawn on a canvas; opening an unread message
// lowers both.
import { art, avatar, doc, esc, icon, type Site } from './common.ts';

const MAIL: [from: string, subject: string, preview: string, time: string, unread: boolean, label?: keyof typeof LABELS, selected?: boolean][] = [
  ['Nora Field', 'Thursday’s walk — route and timings', 'Here’s the plan for Thursday: we meet at the harbour steps at 8, take the cliff path to the lighthouse and', '9:41', true, 'Travel', true],
  ['Common Goods', 'Your order has shipped', 'Good news: your Canvas Tote is on its way. Track it with the link below. It should arrive by', '8:15', true, 'Receipts'],
  ['Hanna Ruus', 'Re: photos from the depot', 'These came out so well! Could we use the one of the tram on the bridge for the newsletter?', '7:02', true, 'Work'],
  ['Lattice', 'Lattice 4.2 is out', 'Derived values are now lazy, the devtools have a new timeline, and we fixed the batching bug', 'Yesterday', true],
  ['Teodor Lind', 'Bread order for Saturday', 'Two rye, one seeded, and a dozen of the cardamom buns if you still have them. I’ll pick up at', 'Yesterday', false, 'Family'],
  ['Fieldpass', 'New sign-in on a Mac', 'We noticed a new sign-in to your account from Safari on a Mac in Lisbon. If this was you,', 'Tue', false],
  ['Dalia Kader', 'Café quiz night 🎉', 'We’re doing a quiz night on the 20th! Teams of four, prizes are pastries. Are you in?', 'Tue', false, 'Family'],
  ['Harbor', 'Your stay in Sennen Cove', 'Your booking is confirmed: Fri 13 – Sun 15 Nov, 2 guests. The host will send directions', 'Mon', false, 'Travel'],
  ['Owen Hartley', 'Draft: the river piece', 'Attached is the latest draft. I cut the Ironbridge section in half; let me know if it still works', 'Mon', false, 'Work'],
  ['Reel', '3 new videos from Harbour Films', 'Low Tide, Harbour lights and How a lighthouse lens works are new on your subscriptions page', 'Sun', false],
  ['Priya Natarajan', 'Salt pans photos', 'I’ve uploaded the full set to the shared folder. The sunrise ones are in the second batch.', 'Sat', false, 'Work'],
  ['Metrics', 'Your weekly report', 'Visitors were up 5.1% this week. Your top page was /pricing with 18,420 views.', 'Fri', false],
  ['Jonas Vik', 'Night train tickets', 'Booked! Berth 41 and 43, coach 6. Train leaves at 21:12, so let’s meet at the station café', 'Oct 31', false, 'Travel'],
  ['Mei Tanaka', 'Lunch next week?', 'It’s been ages. Wednesday or Thursday? There’s a new place by the market I want to try.', 'Oct 30', false],
];
// The icon before the page's script redraws it with the count.
const FIRST_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#e5484d"/><path d="M12 18h40v28H12z" fill="#fff"/><path d="m12 18 20 16 20-16" stroke="#e5484d" stroke-width="4" fill="none"/></svg>')}`;
const LABELS = { Work: '#3e63dd', Family: '#30a46c', Travel: '#f76b15', Receipts: '#8b8d98' };

function inbox() {
  const unread = MAIL.filter((m) => m[4]).length;
  const [from, subject] = MAIL[0];
  const body = `
<div class="app">
  <aside class="side">
    <div class="brand"><svg width="30" height="30" viewBox="0 0 30 30"><rect width="30" height="30" rx="9" fill="#e5484d"/><path d="M7 10h16v11H7z" fill="#fff"/><path d="m7 10 8 6 8-6" stroke="#e5484d" stroke-width="2" fill="none"/></svg>Post</div>
    <button class="compose-btn" id="compose">${icon('plus', { size: 18 })} New message</button>
    <nav>${([['inbox', 'Inbox', unread, 1], ['star', 'Starred'], ['clock', 'Snoozed'], ['send', 'Sent'], ['file', 'Drafts', 1], ['archive', 'Archive'], ['trash', 'Trash']] as [icon: string, name: string, count?: number, on?: number][]).map(([i, n, c, on]) => `<a href="/inbox" class="${on ? 'on' : ''}">${icon(i, { size: 18 })}<span>${n}</span>${c ? `<b${n === 'Inbox' ? ' id="count"' : ''}>${c}</b>` : ''}</a>`).join('')}</nav>
    <h5>Labels</h5>
    <nav class="labels">${Object.entries(LABELS).map(([n, c]) => `<a href="/inbox"><i style="background:${c}"></i>${n}</a>`).join('')}</nav>
    <div class="storage"><span>4.2 GB of 15 GB used</span><div><i></i></div></div>
  </aside>
  <section class="list">
    <header><label class="search">${icon('search', { size: 16 })}<input placeholder="Search mail" aria-label="Search mail"></label><div class="lt"><button class="on">Primary</button><button>Updates</button><button>Social</button></div></header>
    <div id="messages">${MAIL.map(([f, s, p, t, u, l, sel], i) => `<a class="m${u ? ' unread' : ''}${sel ? ' sel' : ''}" href="/inbox" data-i="${i}"><img src="${avatar(f)}" alt="" width="36" height="36"><div class="mb"><div class="mh"><b>${esc(f)}</b><time>${t}</time></div><div class="ms">${esc(s)}</div><div class="mp">${esc(p)}…</div>${l ? `<span class="lab" style="--c:${LABELS[l]}">${l}</span>` : ''}</div></a>`).join('')}</div>
  </section>
  <main class="read">
    <header class="rt"><div class="rtools">${['archive', 'trash', 'clock', 'folder'].map((i) => `<button aria-label="${i}">${icon(i, { size: 18 })}</button>`).join('')}</div><span>1 of ${MAIL.length}</span></header>
    <article>
      <h1 id="r-subject">${esc(subject)}</h1>
      <div class="from"><img src="${avatar(from)}" alt="" width="44" height="44"><div><b id="r-from">${esc(from)}</b> <span>&lt;nora@field.test&gt;</span><p>to me · Today, 9:41</p></div><div class="ra"><button aria-label="Star">${icon('star', { size: 18 })}</button><button aria-label="Reply">${icon('back', { size: 18 })}</button><button aria-label="More">${icon('dots', { size: 18 })}</button></div></div>
      <div class="mail-body" id="r-body">
        <img class="banner" src="${art('map', { seed: 5, w: 1200, h: 420, pins: 3 })}" alt="">
        <p>Hi all,</p>
        <p>Here’s the plan for Thursday: we meet at the <b>harbour steps at 8</b>, take the cliff path to the lighthouse and stop for coffee at the café by the old lifeboat station. It’s about 9 km and mostly flat, apart from one steep bit after the bay.</p>
        <p>Bring water, a warm layer and something to sit on. If it rains we’ll do the shorter loop through the woods and meet the others at the pub at one.</p>
        <table class="plan"><tr><th>Time</th><th>Where</th></tr><tr><td>08:00</td><td>Harbour steps</td></tr><tr><td>10:15</td><td>Lighthouse</td></tr><tr><td>11:00</td><td>Coffee at the lifeboat station</td></tr><tr><td>13:00</td><td>Lunch at the Anchor</td></tr></table>
        <p>See you there,<br>Nora</p>
      </div>
      <div class="att"><div class="file"><span class="pdf">PDF</span><div><b>route-map.pdf</b><span>1.2 MB</span></div></div><div class="file"><span class="img">${icon('pin', { size: 16 })}</span><div><b>meeting-point.png</b><span>640 KB</span></div></div></div>
      <div class="reply"><button>${icon('back', { size: 16 })} Reply</button><button>${icon('repeat', { size: 16 })} Reply all</button><button>${icon('send', { size: 16 })} Forward</button></div>
    </article>
  </main>
</div>
<section class="composer" id="composer" hidden aria-label="New message">
  <header><b>New message</b><span id="saved"></span><button id="c-close" aria-label="Close">${icon('x', { size: 16 })}</button></header>
  <input id="c-to" placeholder="To" aria-label="To">
  <input id="c-subject" placeholder="Subject" aria-label="Subject">
  <textarea id="c-body" placeholder="Write your message" aria-label="Message"></textarea>
  <footer><button class="send" id="c-send">Send ${icon('send', { size: 16 })}</button><span>${icon('file', { size: 18 })}${icon('link', { size: 18 })}${icon('sun', { size: 18 })}</span><button id="c-discard" aria-label="Discard">${icon('trash', { size: 18 })}</button></footer>
</section>
<div class="toast" id="toast">${icon('check', { size: 16 })} <span>Message sent</span></div>
<script>window.MAIL = ${JSON.stringify(MAIL.map(([f, s, p, , u]) => ({ f, s, p, u })))};</script>
<script src="/assets/post.js" defer></script>`;
  return doc({ title: `Inbox (${unread}) — Post`, icon: `<link rel="icon" id="icon" href="${FIRST_ICON}">`, themeColor: '#ffffff', body });
}

const CSS = `
:root { --ink: #1c2024; --text: #3a3f45; --dim: #80838d; --line: #e8e8ec; --soft: #f7f7f9; --red: #e5484d; --blue: #3e63dd; --sans: -apple-system, system-ui, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; color: var(--text); background: #fff; font: 14px/1.45 var(--sans); -webkit-font-smoothing: antialiased; overflow: hidden; }
a { color: inherit; text-decoration: none; }
button { font: inherit; color: inherit; cursor: pointer; }
.app { display: grid; grid-template-columns: 220px 380px 1fr; height: 100vh; }
.side { background: var(--soft); border-right: 1px solid var(--line); padding: 16px 12px; display: flex; flex-direction: column; overflow-y: auto; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; color: var(--ink); padding: 2px 8px 16px; }
.compose-btn { display: flex; align-items: center; justify-content: center; gap: 8px; height: 42px; border: 0; border-radius: 12px; background: var(--ink); color: #fff; font-weight: 600; margin-bottom: 14px; }
.side nav a { display: flex; align-items: center; gap: 12px; padding: 7px 10px; border-radius: 9px; color: var(--text); font-weight: 500; }
.side nav a:hover { background: #ececf0; }
.side nav a.on { background: #fde8e8; color: #b42318; }
.side nav a b { margin-left: auto; font-size: 12px; }
.side h5 { margin: 18px 10px 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); }
.labels i { width: 10px; height: 10px; border-radius: 3px; }
.storage { margin-top: auto; padding: 10px; font-size: 12px; color: var(--dim); }
.storage div { height: 4px; background: var(--line); border-radius: 2px; margin-top: 6px; }
.storage i { display: block; width: 28%; height: 100%; background: var(--red); border-radius: 2px; }
.list { border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
.list header { padding: 12px 14px 0; border-bottom: 1px solid var(--line); }
.search { display: flex; align-items: center; gap: 8px; background: var(--soft); border: 1px solid var(--line); border-radius: 10px; padding: 0 10px; height: 36px; color: var(--dim); }
.search input { border: 0; background: none; outline: none; font: 14px var(--sans); flex: 1; }
.lt { display: flex; gap: 18px; margin-top: 8px; }
.lt button { border: 0; background: none; padding: 8px 0; color: var(--dim); font-weight: 600; border-bottom: 2px solid transparent; }
.lt button.on { color: var(--ink); border-color: var(--red); }
#messages { overflow-y: auto; flex: 1; }
.m { display: flex; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--line); position: relative; }
.m:hover { background: var(--soft); }
.m.sel { background: #fff4f4; box-shadow: inset 3px 0 var(--red); }
.m img { border-radius: 50%; flex-shrink: 0; }
.mb { min-width: 0; flex: 1; }
.mh { display: flex; justify-content: space-between; gap: 8px; }
.mh b { font-weight: 500; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mh time { color: var(--dim); font-size: 12px; white-space: nowrap; }
.ms { color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mp { color: var(--dim); font-size: 13px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.m.unread .mh b, .m.unread .ms { font-weight: 700; }
.m.unread::before { content: ""; position: absolute; left: 4px; top: 26px; width: 6px; height: 6px; border-radius: 50%; background: var(--blue); }
.lab { display: inline-block; margin-top: 6px; font-size: 11px; font-weight: 600; color: var(--c); background: color-mix(in srgb, var(--c) 12%, white); padding: 1px 8px; border-radius: 999px; }
.read { overflow-y: auto; min-width: 0; }
.rt { position: sticky; top: 0; display: flex; justify-content: space-between; align-items: center; padding: 10px 28px; background: rgba(255, 255, 255, .92); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); color: var(--dim); }
.rtools { display: flex; gap: 4px; }
.rtools button, .ra button { width: 34px; height: 34px; border: 0; border-radius: 8px; background: none; color: var(--text); display: grid; place-items: center; }
.rtools button:hover, .ra button:hover { background: var(--soft); }
article { max-width: 760px; padding: 24px 28px 60px; }
article h1 { font-size: 24px; color: var(--ink); margin: 0 0 18px; letter-spacing: -.01em; }
.from { display: flex; gap: 12px; align-items: center; }
.from img { border-radius: 50%; }
.from b { color: var(--ink); }
.from span { color: var(--dim); }
.from p { margin: 2px 0 0; color: var(--dim); font-size: 13px; }
.ra { margin-left: auto; display: flex; }
.mail-body { margin: 22px 0; font-size: 15px; line-height: 1.6; color: var(--text); }
.banner { width: 100%; height: 200px; object-fit: cover; border-radius: 14px; display: block; margin-bottom: 18px; }
.plan { border-collapse: collapse; margin: 12px 0 16px; min-width: 360px; }
.plan th, .plan td { text-align: left; padding: 7px 14px; border-bottom: 1px solid var(--line); }
.plan th { background: var(--soft); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--dim); }
.att { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 22px; }
.file { display: flex; align-items: center; gap: 10px; border: 1px solid var(--line); border-radius: 12px; padding: 8px 14px 8px 8px; }
.file > span { width: 36px; height: 36px; border-radius: 8px; display: grid; place-items: center; font-size: 11px; font-weight: 800; color: #fff; }
.pdf { background: var(--red); } .img { background: var(--blue); }
.file b { display: block; font-size: 13px; color: var(--ink); }
.file div span { font-size: 12px; color: var(--dim); }
.reply { display: flex; gap: 10px; }
.reply button { display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); background: #fff; border-radius: 10px; padding: 8px 16px; font-weight: 600; }
.composer { position: fixed; right: 24px; bottom: 0; width: 520px; background: #fff; border-radius: 14px 14px 0 0; box-shadow: 0 -4px 40px rgba(0, 0, 0, .18), 0 0 0 1px var(--line); display: flex; flex-direction: column; z-index: 20; }
.composer[hidden] { display: none; }
.composer header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: var(--ink); color: #fff; border-radius: 14px 14px 0 0; }
.composer header span { font-size: 12px; opacity: .7; margin-left: auto; }
.composer header button { border: 0; background: none; color: #fff; }
.composer input { border: 0; border-bottom: 1px solid var(--line); padding: 10px 14px; font: 14px var(--sans); outline: none; }
.composer textarea { border: 0; padding: 12px 14px; height: 220px; resize: none; font: 15px/1.5 var(--sans); outline: none; }
.composer footer { display: flex; align-items: center; gap: 14px; padding: 10px 14px; border-top: 1px solid var(--line); color: var(--dim); }
.composer footer span { display: flex; gap: 12px; }
.send { display: flex; align-items: center; gap: 8px; border: 0; background: var(--red); color: #fff; font-weight: 600; border-radius: 10px; padding: 9px 16px; }
#c-discard { margin-left: auto; border: 0; background: none; color: var(--dim); }
.toast { position: fixed; left: 24px; bottom: 24px; background: var(--ink); color: #fff; padding: 12px 18px; border-radius: 12px; display: flex; gap: 8px; align-items: center; transform: translateY(100px); transition: transform .3s; z-index: 30; }
.toast.on { transform: none; }
@media (max-width: 1100px) { .app { grid-template-columns: 72px 340px 1fr; } .side nav a span, .side h5, .labels, .storage, .brand { display: none; } .compose-btn { font-size: 0; gap: 0; } }
`;

const JS = `
const icon = document.getElementById('icon');
const count = document.getElementById('count');
const drawIcon = (n) => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#e5484d'; g.beginPath(); g.roundRect(0, 0, 64, 64, 16); g.fill();
  g.fillStyle = '#fff'; g.fillRect(12, 18, 40, 28);
  g.strokeStyle = '#e5484d'; g.lineWidth = 4; g.beginPath(); g.moveTo(12, 18); g.lineTo(32, 34); g.lineTo(52, 18); g.stroke();
  if (n) {
    g.fillStyle = '#1c2024'; g.beginPath(); g.arc(48, 16, 15, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.font = 'bold 20px -apple-system, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(n > 9 ? '9+' : String(n), 48, 17);
  }
  icon.href = c.toDataURL('image/png');
};
let unread = MAIL.filter((m) => m.u).length;
const show = () => { document.title = unread ? 'Inbox (' + unread + ') — Post' : 'Inbox — Post'; count.textContent = unread || ''; drawIcon(unread); };
show();
document.getElementById('messages').addEventListener('click', (e) => {
  const m = e.target.closest('.m'); if (!m) return;
  e.preventDefault();
  document.querySelectorAll('.m.sel').forEach((x) => x.classList.remove('sel'));
  m.classList.add('sel');
  if (m.classList.contains('unread')) { m.classList.remove('unread'); unread--; show(); }
  const d = MAIL[m.dataset.i];
  document.getElementById('r-subject').textContent = d.s;
  document.getElementById('r-from').textContent = d.f;
  if (m.dataset.i !== '0') document.getElementById('r-body').innerHTML = '<p>' + d.p + ' and I’ll fill in the rest when we talk.</p><p>Best,<br>' + d.f.split(' ')[0] + '</p>';
});
const composer = document.getElementById('composer');
const fields = ['c-to', 'c-subject', 'c-body'].map((id) => document.getElementById(id));
let dirty = false;
const guard = (e) => { e.preventDefault(); e.returnValue = ''; };
const setDirty = (on) => { if (on === dirty) return; dirty = on; if (on) addEventListener('beforeunload', guard); else removeEventListener('beforeunload', guard); document.getElementById('saved').textContent = on ? 'Draft saved' : ''; };
fields.forEach((f) => f.addEventListener('input', () => setDirty(fields.some((x) => x.value.trim()))));
document.getElementById('compose').addEventListener('click', () => { composer.hidden = false; fields[0].focus(); });
const close = () => { composer.hidden = true; fields.forEach((f) => (f.value = '')); setDirty(false); };
document.getElementById('c-discard').addEventListener('click', close);
document.getElementById('c-close').addEventListener('click', () => (composer.hidden = true));
document.getElementById('c-send').addEventListener('click', () => { close(); const t = document.getElementById('toast'); t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 2400); });
`;

export default {
  host: 'post.test',
  name: 'Post',
  blurb: 'Mail, without the noise.',
  look: { bg: '#ffffff', ink: '#1c2024', accent: '#e5484d' },
  iconLink: '',
  pages: [{ path: '/inbox', title: 'Inbox (4) — Post', what: 'A mail app: unread count in title and icon (data: URL), a compose draft that guards the page', art: art('map', { seed: 5, w: 1200, h: 700, pins: 3 }) }],
  assets: {
    '/assets/site.css': { type: 'text/css; charset=utf-8', body: CSS },
    '/assets/post.js': { type: 'text/javascript; charset=utf-8', body: JS },
  },
  routes: [
    ['GET', '/', () => ({ status: 302, location: '/inbox' })],
    ['GET', '/inbox', () => inbox()],
  ],
} satisfies Site;
