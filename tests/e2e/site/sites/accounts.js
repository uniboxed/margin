// accounts.test: Fieldpass sign-in. Email, password (show/hide), Remember
// me, errors in the page and from the server; the form posts to /signin,
// which answers a wrong password with the form again (a page from a POST)
// and anything else with a 302 to a signed-in page. SVG icon.
import { art, avatar, doc, esc, icon } from './common.js';

const ICON = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14b8a6"/><stop offset="1" stop-color="#0e7490"/></linearGradient></defs><rect width="64" height="64" rx="18" fill="url(#g)"/><circle cx="26" cy="32" r="10" fill="none" stroke="#fff" stroke-width="6"/><path d="M36 32h18M48 32v8" stroke="#fff" stroke-width="6" stroke-linecap="round"/></svg>`;
const LOGO = `<svg width="34" height="34" viewBox="0 0 64 64">${FAVICON.slice(FAVICON.indexOf('<defs>'), -6)}</svg>`;

function signin({ email = '', error = '' } = {}) {
  const body = `
<div class="split">
  <section class="brand">
    <a class="logo" href="/signin">${LOGO}<span>Fieldpass</span></a>
    <div class="art"><img src="${art('landscape', { seed: 31, p: 'mint', w: 1000, h: 1200 })}" alt=""></div>
    <blockquote><p>“One account for every tool the team uses. Setting up a new starter takes two minutes now, not two days.”</p><footer><img src="${avatar('Rosa Lindqvist')}" alt="" width="40" height="40"><div><b>Rosa Lindqvist</b><span>Head of Operations, Tidewater</span></div></footer></blockquote>
  </section>
  <main class="panel">
    <div class="card">
      <h1>Welcome back</h1>
      <p class="sub">Sign in to your Fieldpass account.</p>
      ${error ? `<div class="alert" role="alert">${icon('lock', { size: 18 })}<div><b>That didn’t work.</b> ${esc(error)}</div></div>` : ''}
      <form id="form" method="post" action="/signin" novalidate>
        <label for="email">Email</label>
        <div class="field">${icon('mail', { size: 18 })}<input id="email" name="email" type="email" autocomplete="username" placeholder="you@company.test" value="${esc(email)}" required></div>
        <p class="err" id="email-err" hidden>Enter an email address like name@company.test.</p>
        <div class="row"><label for="password">Password</label><a href="/signin">Forgot password?</a></div>
        <div class="field">${icon('lock', { size: 18 })}<input id="password" name="password" type="password" autocomplete="current-password" placeholder="Your password" required><button type="button" class="show" aria-label="Show password">${icon('eye', { size: 18 })}</button></div>
        <p class="err" id="password-err" hidden>Enter your password.</p>
        <label class="remember"><input type="checkbox" name="remember" checked> Keep me signed in for 30 days</label>
        <button type="submit" class="primary">Sign in</button>
      </form>
      <div class="or"><span>or</span></div>
      <button class="secondary" type="button">${icon('user', { size: 18 })} Sign in with a passkey</button>
      <p class="new">New to Fieldpass? <a href="/signin">Create an account</a></p>
    </div>
    <footer class="legal"><a href="/">Privacy</a><a href="/">Terms</a><a href="/">Help</a><span>© 2026 Fieldpass, a made-up company</span></footer>
  </main>
</div>
<script src="/assets/signin.js" defer></script>`;
  return doc({ title: 'Sign in · Fieldpass', icon: ICON, themeColor: '#0e7490', body });
}

function welcome(name) {
  const display = name.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'there';
  const body = `
<header class="bar"><a class="logo" href="/welcome">${LOGO}<span>Fieldpass</span></a><nav><a class="on">Overview</a><a>Security</a><a>Devices</a><a>Billing</a></nav><img class="me" src="${avatar(display)}" alt="" width="34" height="34"></header>
<main class="home">
  <div class="hello"><img src="${avatar(display)}" alt="" width="72" height="72"><div><p class="ok">${icon('check', { size: 16 })} You’re signed in</p><h1>Good morning, ${esc(display)}</h1><p class="sub">${esc(name)} · Tidewater workspace</p></div></div>
  <div class="tiles">
    <section class="tile"><h2>Account security</h2><div class="score"><svg viewBox="0 0 120 120" width="110" height="110"><circle cx="60" cy="60" r="50" fill="none" stroke="#e2f3f1" stroke-width="12"/><circle cx="60" cy="60" r="50" fill="none" stroke="#14b8a6" stroke-width="12" stroke-dasharray="${Math.round(314 * 0.75)} 314" stroke-linecap="round" transform="rotate(-90 60 60)"/><text x="60" y="66" text-anchor="middle" font-size="26" font-weight="700" fill="#0f2a2e">75%</text></svg><ul><li class="done">${icon('check', { size: 16 })} Strong password</li><li class="done">${icon('check', { size: 16 })} Recovery email</li><li class="done">${icon('check', { size: 16 })} Passkey on this Mac</li><li>${icon('plus', { size: 16 })} Add a second passkey</li></ul></div></section>
    <section class="tile"><h2>Signed-in devices</h2>${[['MacBook Pro', 'Lisbon · this device', 'now'], ['iPhone 17', 'Lisbon', '2 hours ago'], ['iPad Air', 'Porto', '3 days ago']].map(([d, w, t]) => `<div class="dev"><span class="di">${icon('grid', { size: 18 })}</span><div><b>${d}</b><span>${w}</span></div><time>${t}</time></div>`).join('')}</section>
    <section class="tile apps"><h2>Your apps</h2><div class="app-grid">${[['Post', '#e5484d'], ['Lattice', '#2f6df6'], ['Metrics', '#6d5efc'], ['Murmur', '#f97316'], ['Reel', '#c3123a'], ['Harbor', '#11808a']].map(([a, c]) => `<a href="/welcome"><i style="background:${c}">${a[0]}</i>${a}</a>`).join('')}</div></section>
  </div>
</main>`;
  return doc({ title: `Overview · Fieldpass`, icon: ICON, themeColor: '#0e7490', body, bodyClass: 'signed-in' });
}

const CSS = `
:root { --ink: #0f2a2e; --text: #3d5458; --muted: #6b8084; --line: #dfe8e8; --teal: #0e7490; --teal2: #14b8a6; --bg: #f5f8f8; --sans: -apple-system, system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 var(--sans); color: var(--text); background: var(--bg); -webkit-font-smoothing: antialiased; }
a { color: var(--teal); text-decoration: none; }
.split { display: grid; grid-template-columns: minmax(380px, 1fr) minmax(460px, 1.05fr); min-height: 100vh; }
.brand { position: relative; overflow: hidden; background: #0f3f45; color: #e8f6f5; padding: 40px 48px; display: flex; flex-direction: column; justify-content: space-between; }
.brand .art { position: absolute; inset: 0; }
.brand .art img { width: 100%; height: 100%; object-fit: cover; opacity: .9; }
.brand::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(8, 40, 45, .5), rgba(8, 40, 45, 0) 26%, rgba(8, 40, 45, .05) 55%, rgba(8, 40, 45, .8)); }
.logo { position: relative; z-index: 1; display: flex; align-items: center; gap: 10px; font: 700 20px var(--sans); color: inherit; letter-spacing: -.01em; }
.brand blockquote { position: relative; z-index: 1; margin: 0; max-width: 460px; }
.brand blockquote p { font: 500 22px/1.4 var(--sans); letter-spacing: -.01em; margin: 0 0 20px; color: #fff; }
.brand blockquote footer { display: flex; gap: 12px; align-items: center; }
.brand blockquote img { border-radius: 50%; border: 2px solid rgba(255, 255, 255, .6); }
.brand blockquote b { display: block; color: #fff; }
.brand blockquote span { font-size: 13px; opacity: .8; }
.panel { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 24px 24px; }
.card { width: min(420px, 100%); background: #fff; border: 1px solid var(--line); border-radius: 20px; padding: 36px 36px 28px; box-shadow: 0 1px 2px rgba(15, 42, 46, .04), 0 24px 48px -28px rgba(15, 42, 46, .3); }
.card h1 { font: 700 28px/1.2 var(--sans); color: var(--ink); letter-spacing: -.02em; margin: 0; }
.sub { color: var(--muted); margin: 6px 0 24px; }
label { display: block; font-weight: 600; color: var(--ink); font-size: 14px; margin-bottom: 6px; }
.row { display: flex; justify-content: space-between; align-items: baseline; margin-top: 16px; }
.row a { font-size: 13px; font-weight: 500; }
.field { display: flex; align-items: center; gap: 10px; height: 46px; padding: 0 12px; border: 1.5px solid var(--line); border-radius: 12px; background: #fff; color: var(--muted); transition: border-color .15s, box-shadow .15s; }
.field:focus-within { border-color: var(--teal2); box-shadow: 0 0 0 4px rgba(20, 184, 166, .15); }
.field.bad { border-color: #e5484d; box-shadow: 0 0 0 4px rgba(229, 72, 77, .12); }
.field input { flex: 1; border: 0; outline: none; font: 15px var(--sans); color: var(--ink); background: none; }
.show { border: 0; background: none; color: var(--muted); cursor: pointer; padding: 4px; display: grid; }
.err { color: #c62a2f; font-size: 13px; margin: 6px 0 0; }
.remember { display: flex; align-items: center; gap: 8px; font-weight: 500; color: var(--text); margin: 18px 0 22px; }
.remember input { accent-color: var(--teal); width: 16px; height: 16px; }
.primary { width: 100%; height: 48px; border: 0; border-radius: 12px; background: linear-gradient(135deg, var(--teal2), var(--teal)); color: #fff; font: 600 16px var(--sans); cursor: pointer; box-shadow: 0 8px 20px -10px rgba(14, 116, 144, .7); }
.primary:hover { filter: brightness(1.05); }
.or { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 13px; margin: 20px 0; }
.or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.secondary { width: 100%; height: 46px; display: flex; align-items: center; justify-content: center; gap: 8px; border: 1.5px solid var(--line); border-radius: 12px; background: #fff; color: var(--ink); font: 600 15px var(--sans); cursor: pointer; }
.new { text-align: center; color: var(--muted); margin: 22px 0 0; font-size: 14px; }
.alert { display: flex; gap: 10px; background: #fff1f1; border: 1px solid #ffd0d1; color: #8f1d22; padding: 12px 14px; border-radius: 12px; margin-bottom: 18px; font-size: 14px; }
.alert svg { flex-shrink: 0; margin-top: 1px; }
.legal { display: flex; gap: 18px; color: var(--muted); font-size: 12.5px; margin-top: 28px; }
.legal a { color: var(--muted); }
.bar { display: flex; align-items: center; gap: 36px; padding: 0 40px; height: 66px; background: #fff; border-bottom: 1px solid var(--line); color: var(--ink); }
.bar nav { display: flex; align-self: stretch; gap: 24px; font-weight: 500; font-size: 14px; color: var(--muted); }
.bar nav a { color: inherit; cursor: pointer; display: flex; align-items: center; }
.bar nav a.on { color: var(--ink); box-shadow: inset 0 -2px var(--teal2); }
.me { margin-left: auto; border-radius: 50%; }
.home { max-width: 1100px; margin: 0 auto; padding: 40px; }
.hello { display: flex; gap: 20px; align-items: center; margin-bottom: 32px; }
.hello img { border-radius: 50%; }
.ok { display: inline-flex; gap: 6px; align-items: center; background: #dcf7ef; color: #11734f; font-weight: 600; font-size: 13px; padding: 3px 10px; border-radius: 999px; margin: 0 0 6px; }
.hello h1 { font: 700 32px/1.15 var(--sans); color: var(--ink); letter-spacing: -.02em; margin: 0; }
.hello .sub { margin: 4px 0 0; }
.tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.tile { background: #fff; border: 1px solid var(--line); border-radius: 18px; padding: 22px 24px; }
.tile h2 { font-size: 16px; color: var(--ink); margin: 0 0 14px; }
.score { display: flex; gap: 24px; align-items: center; }
.score ul { list-style: none; margin: 0; padding: 0; }
.score li { display: flex; gap: 8px; align-items: center; padding: 4px 0; color: var(--muted); }
.score li.done { color: var(--ink); }
.score li.done svg { color: var(--teal2); }
.dev { display: flex; gap: 12px; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); }
.dev:first-of-type { border-top: 0; }
.di { width: 38px; height: 38px; border-radius: 10px; background: #eef6f6; display: grid; place-items: center; color: var(--teal); }
.dev b { display: block; color: var(--ink); font-weight: 600; }
.dev span { font-size: 13px; color: var(--muted); }
.dev time { margin-left: auto; font-size: 13px; color: var(--muted); }
.apps { grid-column: span 2; }
.app-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; }
.app-grid a { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px 8px; border-radius: 14px; color: var(--ink); font-weight: 500; font-size: 14px; border: 1px solid var(--line); }
.app-grid i { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; color: #fff; font: 700 18px var(--sans); font-style: normal; }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } .brand { display: none; } .tiles { grid-template-columns: 1fr; } .apps { grid-column: auto; } .app-grid { grid-template-columns: repeat(3, 1fr); } }
`;

const JS = `
const form = document.getElementById('form');
const check = (id, ok) => { document.getElementById(id + '-err').hidden = ok; document.getElementById(id).closest('.field').classList.toggle('bad', !ok); return ok; };
form.addEventListener('submit', (e) => {
  const email = check('email', /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(form.email.value));
  const pass = check('password', form.password.value.length > 0);
  if (!email || !pass) { e.preventDefault(); (email ? form.password : form.email).focus(); }
});
document.querySelector('.show').addEventListener('click', (e) => { const p = form.password; p.type = p.type === 'password' ? 'text' : 'password'; e.currentTarget.style.color = p.type === 'text' ? '#0e7490' : ''; });
`;

export default {
  host: 'accounts.test',
  name: 'Fieldpass',
  blurb: 'One account for every tool your team uses.',
  look: { bg: '#f5f8f8', ink: '#0f2a2e', accent: '#0e7490' },
  iconLink: ICON,
  pages: [{ path: '/signin', title: 'Sign in · Fieldpass', what: 'A sign-in form that posts to a 302 and lands signed in; "wrong" as the password shows the server’s error', art: art('landscape', { seed: 31, p: 'mint', w: 1200, h: 700 }) }],
  assets: {
    '/assets/site.css': { type: 'text/css; charset=utf-8', body: CSS },
    '/assets/signin.js': { type: 'text/javascript; charset=utf-8', body: JS },
    '/favicon.svg': { type: 'image/svg+xml', body: FAVICON },
  },
  routes: [
    ['GET', '/', () => ({ status: 302, location: '/signin' })],
    ['GET', '/signin', () => signin()],
    ['POST', '/signin', ({ form }) => {
      const email = form.get('email') ?? '';
      const password = form.get('password') ?? '';
      if (!email.includes('@')) return { status: 200, body: signin({ email, error: 'Enter the email address you signed up with.' }) };
      if (!password || password === 'wrong') return { status: 200, body: signin({ email, error: 'That password isn’t right. Try again, or reset it.' }) };
      return { status: 302, location: '/welcome', headers: { 'set-cookie': `fieldpass=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Lax` } };
    }],
    ['GET', '/welcome', ({ req }) => {
      const m = /(?:^|;\s*)fieldpass=([^;]+)/.exec(req.headers.cookie ?? '');
      return m ? welcome(decodeURIComponent(m[1])) : { status: 302, location: '/signin' };
    }],
    ['GET', '/signout', () => ({ status: 302, location: '/signin', headers: { 'set-cookie': 'fieldpass=; Path=/; Max-Age=0' } })],
  ],
};
