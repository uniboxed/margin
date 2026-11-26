// The review page (docs/THEME-STORE.md §3): uploads waiting for review, hidden and reported themes, blocked keys,
// and what to do about each. Behind HTTP Basic with ADMIN_TOKEN as the password; each change is a POST from the page
// itself (its Origin, and a token only the page carries), so another site can't make the browser post one.

import { hex, hmac, sameText } from './crypto.ts';
import { bytesResponse, readBody } from './http.ts';
import { BUMP, packageFile, TRUSTED_AFTER } from './store.ts';
import type { D1PreparedStatement, Env } from './types.ts';

type AdminEnv = Env & { ADMIN_TOKEN: string };

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': 'default-src \'none\'; style-src \'unsafe-inline\'; form-action \'self\'; frame-ancestors \'none\'; base-uri \'none\'',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex',
};

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Whether the request carries the admin password (any user name). */
export async function authorized(request: Request, env: AdminEnv): Promise<boolean> {
  const header = request.headers.get('Authorization') ?? '';
  const m = /^Basic ([A-Za-z0-9+/=]{1,1024})$/.exec(header);
  if (!m) return false;
  let decoded;
  try { decoded = new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))); } catch { return false; }
  const colon = decoded.indexOf(':');
  return colon >= 0 && sameText(decoded.slice(colon + 1), env.ADMIN_TOKEN);
}

const csrfToken = async (env: AdminEnv) => hex(await hmac(env.ADMIN_TOKEN, 'margin-themes-admin-csrf-v1'));

export function challengeAuth(): Response {
  return bytesResponse('Sign in to review themes.', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Basic realm="Margin themes", charset="UTF-8"' }, 401);
}

/** /admin and below, once authorized. */
export async function admin(request: Request, env: AdminEnv, path: string, now: number): Promise<Response> {
  if (path === '/admin' && request.method === 'GET') return page(env, await csrfToken(env), new URL(request.url).searchParams.get('done'));
  if (path === '/admin' && request.method === 'POST') return act(request, env, now);
  const pkg = /^\/admin\/packages\/([0-9a-f]{64})$/.exec(path);
  if (pkg && request.method === 'GET') return packageFile(env, pkg[1], { review: true });
  return bytesResponse('Not found.', { 'Content-Type': 'text/plain; charset=utf-8' }, 404);
}

type Pending = { theme_id: string, version: string, name: string, description: string, author: string, tags: string, sha256: string, size: number, created_at: number, owner: string, approved: number };
type Hidden = { id: string, owner: string, reports: number };
type Report = { theme_id: string, reason: string, note: string, created_at: number, key_id: string, cleared: number };

async function page(env: AdminEnv, csrf: string, done: string | null): Promise<Response> {
  const [pending, hidden, reports, blocked] = await env.DB.batch([
    env.DB.prepare(`SELECT v.theme_id, v.version, v.name, v.description, v.author, v.tags, v.sha256, v.size, v.created_at, t.owner, k.approved
      FROM versions v JOIN themes t ON t.id = v.theme_id JOIN keys k ON k.id = t.owner
      WHERE v.status = 'review' AND k.blocked = 0 ORDER BY v.created_at LIMIT 100`),
    env.DB.prepare(`SELECT t.id, t.owner, (SELECT COUNT(*) FROM reports r WHERE r.theme_id = t.id AND r.cleared = 0) AS reports
      FROM themes t WHERE t.hidden = 1 ORDER BY t.id LIMIT 100`),
    env.DB.prepare('SELECT theme_id, reason, note, created_at, key_id, cleared FROM reports WHERE cleared = 0 ORDER BY theme_id, created_at LIMIT 300'),
    env.DB.prepare('SELECT id, created_at FROM keys WHERE blocked = 1 ORDER BY created_at DESC LIMIT 100'),
  ]);
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  const form = (action: string, fields: Record<string, string>, label: string, extra = '') => `<form method="post" action="/admin">`
    + `<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="${esc(action)}">`
    + Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')
    + `${extra}<button>${esc(label)}</button></form>`;
  const byTheme = new Map<string, Report[]>();
  for (const r of reports.results as Report[]) byTheme.set(r.theme_id, [...(byTheme.get(r.theme_id) ?? []), r]);
  const reportList = (id: string) => (byTheme.get(id) ?? []).map((r) => `<li>${esc(r.reason)}${r.note ? `: ${esc(r.note)}` : ''} <small>(${esc(r.key_id.slice(0, 8))}, ${esc(date(r.created_at))})</small></li>`).join('');
  const pendingRows = (pending.results as Pending[]).map((p) => `<tr>
    <td><b>${esc(p.name)}</b><br><code>${esc(p.theme_id)}</code> ${esc(p.version)}<br><small>${esc(p.description)}</small></td>
    <td>${esc(p.author)}<br><code>${esc(p.owner.slice(0, 8))}</code> <small>${esc(p.approved)}/${TRUSTED_AFTER} approved</small></td>
    <td><small>${esc(JSON.parse(p.tags).join(', '))}</small></td>
    <td><small>${esc(Math.round(p.size / 1024))} KB<br>${esc(date(p.created_at))}</small><br><a href="/admin/packages/${esc(p.sha256)}">package</a></td>
    <td>${form('approve', { theme: p.theme_id, version: p.version }, 'Approve')}
      ${form('reject', { theme: p.theme_id, version: p.version }, 'Reject', '<input name="note" maxlength="280" placeholder="why (kept)">')}
      ${form('block', { key: p.owner }, 'Block author')}</td></tr>`).join('');
  const hiddenRows = (hidden.results as Hidden[]).map((h) => `<tr><td><code>${esc(h.id)}</code><br><small>${esc(h.owner.slice(0, 8))}</small></td>
    <td><ul>${reportList(h.id)}</ul></td><td>${form('unhide', { theme: h.id }, 'Show again (clears its reports)')} ${form('block', { key: h.owner }, 'Block author')}</td></tr>`).join('');
  const reportedIds = [...byTheme.keys()].filter((id) => !(hidden.results as Hidden[]).some((h) => h.id === id));
  const reportedRows = reportedIds.map((id) => `<tr><td><code>${esc(id)}</code></td><td><ul>${reportList(id)}</ul></td>
    <td>${form('hide', { theme: id }, 'Hide')} ${form('clear', { theme: id }, 'Clear reports')}</td></tr>`).join('');
  const blockedRows = (blocked.results as { id: string, created_at: number }[]).map((k) => `<tr><td><code>${esc(k.id)}</code></td><td><small>${esc(date(k.created_at))}</small></td>
    <td>${form('unblock', { key: k.id }, 'Unblock')}</td></tr>`).join('');
  const section = (title: string, head: string, rows: string) => `<h2>${esc(title)}</h2>${rows ? `<table><tr>${head}</tr>${rows}</table>` : '<p>None.</p>'}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Margin themes: review</title><style>
body{font:14px -apple-system,system-ui,sans-serif;margin:24px;color:#222;background:#fff}
table{border-collapse:collapse;width:100%}td,th{border-top:1px solid #ddd;padding:8px;vertical-align:top;text-align:left}
form{display:inline-block;margin:0 4px 4px 0}button{font:inherit}code{font-size:12px}ul{margin:0;padding-left:16px}
.done{background:#eef7ee;padding:8px}
@media (prefers-color-scheme:dark){body{color:#ddd;background:#1a1a1a}td,th{border-color:#333}.done{background:#1f3320}a{color:#8ab4f8}}
</style></head><body><h1>Margin themes: review</h1>
${done ? `<p class="done">${esc(done)}</p>` : ''}
${section('Waiting for review', '<th>Theme</th><th>Author</th><th>Tags</th><th>File</th><th></th>', pendingRows)}
${section('Hidden', '<th>Theme</th><th>Reports</th><th></th>', hiddenRows)}
${section('Reported, still shown', '<th>Theme</th><th>Reports</th><th></th>', reportedRows)}
${section('Blocked keys', '<th>Key</th><th>Registered</th><th></th>', blockedRows)}
<h2>Block a key</h2>${form('block', {}, 'Block', '<input name="key" required pattern="[0-9a-f]{32}" placeholder="key id (32 hex)" size="36">')}
</body></html>`;
  return bytesResponse(html, PAGE_HEADERS);
}

/** Whether a POST came from the review page itself: its own origin (and the browser's word for it, when it gives one). */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  return origin === new URL(request.url).origin && (site === null || site === 'same-origin');
}

async function act(request: Request, env: AdminEnv, now: number): Promise<Response> {
  if (!sameOrigin(request)) return bytesResponse('Changes are made from the review page only.', { 'Content-Type': 'text/plain; charset=utf-8' }, 403);
  const body = await readBody(request, 8192);
  if (!body) return bytesResponse('Too long.', { 'Content-Type': 'text/plain; charset=utf-8' }, 413);
  const form = new URLSearchParams(new TextDecoder().decode(body));
  if (!(await sameText(form.get('csrf') ?? '', await csrfToken(env)))) return bytesResponse('Changes are made from the review page only.', { 'Content-Type': 'text/plain; charset=utf-8' }, 403);
  const action = form.get('action') ?? '';
  const theme = form.get('theme') ?? '';
  const version = form.get('version') ?? '';
  const key = form.get('key') ?? '';
  const note = (form.get('note') ?? '').slice(0, 280);
  const db = env.DB;
  const bad = (why: string) => bytesResponse(why, { 'Content-Type': 'text/plain; charset=utf-8' }, 400);
  let statements: D1PreparedStatement[];
  let done: string;
  switch (action) {
    case 'approve':
    case 'reject': {
      const row = await db.prepare(`SELECT v.status, t.owner FROM versions v JOIN themes t ON t.id = v.theme_id WHERE v.theme_id = ? AND v.version = ?`).bind(theme, version).first<{ status: string, owner: string }>();
      if (!row) return bad('No such version.');
      if (row.status !== 'review') return redirect(`${theme} ${version} was already ${row.status === 'published' ? 'approved' : 'rejected'}.`);
      const status = action === 'approve' ? 'published' : 'rejected';
      statements = [db.prepare('UPDATE versions SET status = ?, reviewed_at = ?, note = ? WHERE theme_id = ? AND version = ? AND status = \'review\'').bind(status, now, note, theme, version)];
      // A key's approvals, counted from what review approved (not added to), so two approvals at once count once each.
      if (action === 'approve') {
        statements.push(db.prepare(`UPDATE keys SET approved = (SELECT COUNT(*) FROM versions v JOIN themes t ON t.id = v.theme_id
          WHERE t.owner = keys.id AND v.status = 'published' AND v.reviewed_at IS NOT NULL) WHERE id = ?`).bind(row.owner), db.prepare(BUMP));
      }
      done = `${theme} ${version} ${action === 'approve' ? 'approved' : 'rejected'}.`;
      break;
    }
    case 'hide':
      statements = [db.prepare('UPDATE themes SET hidden = 1 WHERE id = ?').bind(theme), db.prepare(BUMP)];
      done = `${theme} hidden.`;
      break;
    case 'unhide':
      statements = [db.prepare('UPDATE themes SET hidden = 0 WHERE id = ?').bind(theme), db.prepare('UPDATE reports SET cleared = 1 WHERE theme_id = ?').bind(theme), db.prepare(BUMP)];
      done = `${theme} shown again, its reports cleared.`;
      break;
    case 'clear':
      statements = [db.prepare('UPDATE reports SET cleared = 1 WHERE theme_id = ?').bind(theme)];
      done = `${theme}'s reports cleared.`;
      break;
    case 'block':
    case 'unblock':
      if (!/^[0-9a-f]{32}$/.test(key)) return bad('A key id is 32 hex digits.');
      statements = [db.prepare('UPDATE keys SET blocked = ? WHERE id = ?').bind(action === 'block' ? 1 : 0, key), db.prepare(BUMP)];
      done = `${key.slice(0, 8)} ${action === 'block' ? 'blocked: its themes are hidden and its requests refused' : 'unblocked'}.`;
      break;
    default:
      return bad('No such action.');
  }
  const [first] = await db.batch(statements);
  if (!first.meta.changes) return redirect(`Nothing changed (${action} ${theme || key}).`);
  return redirect(done);
}

/** Back to the page after a change (POST, then GET), with what was done. */
function redirect(done: string): Response {
  return new Response(null, { status: 303, headers: { Location: `/admin?done=${encodeURIComponent(done)}`, 'Cache-Control': 'no-store' } });
}
