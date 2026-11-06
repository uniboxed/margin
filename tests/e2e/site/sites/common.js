// What every site's pages share: escaping, the page shell, picture
// addresses and the designed 404 page.

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ?fp on any page: where <html> sits in each of the first 40 frames
// (window.__fp), with Margin's word to the box held back until &late=N ms.
export const FIRST_FRAMES = `<script>(() => {
  const late = Number(new URLSearchParams(location.search).get('late') || 0);
  const fp = window.__fp = { frames: [], held: 0, heard: 0 };
  addEventListener('margin:box', (e) => { if (performance.now() < late) { e.stopImmediatePropagation(); e.preventDefault(); fp.held++; } else fp.heard++; }, true);
  const look = () => {
    const html = document.documentElement;
    const s = getComputedStyle(html);
    const m = new DOMMatrix(s.transform);
    fp.frames.push({ t: Math.round(performance.now()), x: m.e, y: m.f, w: Math.round(parseFloat(s.width)), mark: html.getAttribute('data-margin-at'), said: s.getPropertyValue('--margin-fp').trim(), left: s.getPropertyValue('--margin-at-left').trim(), frame: getComputedStyle(html, '::after').boxShadow });
    if (fp.frames.length < 40) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
})();</script>`;

// A picture's address on this site (art.js draws it).
export const art = (kind, params = {}) => `/media/art/${kind}.svg?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;
export const avatar = (name) => art('avatar', { name });

// A whole page. `icon` is the <link rel=icon> markup (or '' for none).
export function doc({ title, body, head = '', icon = '', css = '/assets/site.css', themeColor, lang = 'en', bodyClass = '', htmlClass = '', description }) {
  return `<!doctype html>
<html lang="${lang}"${htmlClass ? ` class="${htmlClass}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">\n` : ''}${themeColor ? `<meta name="theme-color" content="${themeColor}">\n` : ''}${icon ? `${icon}\n` : ''}${css ? `<link rel="stylesheet" href="${css}">\n` : ''}${head}
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
${body}
</body>
</html>
`;
}

// A drawn icon in a page (stroke icons, 24 × 24).
const PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  bag: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  share: '<path d="M4 12v7h16v-7"/><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  bookmark: '<path d="M6 4h12v16l-6-4-6 4z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  home: '<path d="m3 11 9-7 9 7"/><path d="M5 10v10h14V10"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  pause: '<path d="M7 4h3v16H7zM14 4h3v16h-3z"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="m7 15 4-5 3 3 5-7"/>',
  inbox: '<path d="M3 13h5l1 3h6l1-3h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
  send: '<path d="m4 12 16-8-6 16-3-7z"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9"/><path d="M10 13h4"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pin: '<path d="M12 21s-6-5.3-6-11a6 6 0 0 1 12 0c0 5.7-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  dots: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
  wave: '<path d="M2 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  skip: '<path d="M5 5v14l10-7z"/><path d="M18 5v14"/>',
  back: '<path d="M19 5v14L9 12z"/><path d="M6 5v14"/>',
  volume: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6a8 8 0 0 1 0 12"/>',
};
export const icon = (name, { size = 20, stroke = 1.8, cls = '' } = {}) =>
  `<svg class="i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ''}</svg>`;

// The designed 404, in the site's own colours and type.
export function notFound(site, path) {
  const look = { bg: '#f7f6f3', ink: '#1d1d1f', accent: '#3e63dd', font: '-apple-system, system-ui, sans-serif', ...site.look };
  const css = `
  :root { color-scheme: ${look.dark ? 'dark' : 'light'}; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: ${look.bg}; color: ${look.ink}; font: 17px/1.5 ${look.font}; }
  main { width: min(560px, 90vw); text-align: center; padding: 48px 0; }
  .art { width: 260px; height: 200px; margin: 0 auto 8px; display: block; }
  .code { font-size: 14px; letter-spacing: .18em; text-transform: uppercase; color: ${look.accent}; font-weight: 700; }
  h1 { font-size: 40px; line-height: 1.1; margin: 10px 0 12px; letter-spacing: -.02em; }
  p { opacity: .72; margin: 0 0 28px; }
  code { font: 14px ui-monospace, Menlo, monospace; background: color-mix(in srgb, ${look.ink} 8%, transparent); padding: 2px 6px; border-radius: 6px; }
  .actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
  a.btn { display: inline-flex; align-items: center; gap: 8px; padding: 12px 20px; border-radius: 999px; text-decoration: none; font-weight: 600; font-size: 15px; }
  a.primary { background: ${look.accent}; color: #fff; }
  a.ghost { color: ${look.ink}; box-shadow: inset 0 0 0 1.5px color-mix(in srgb, ${look.ink} 25%, transparent); }
  footer { margin-top: 48px; font-size: 13px; opacity: .5; }`;
  const balloon = `<svg class="art" viewBox="0 0 260 200" aria-hidden="true"><defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${look.accent}" stop-opacity=".55"/><stop offset="1" stop-color="${look.accent}"/></linearGradient></defs><ellipse cx="130" cy="186" rx="80" ry="7" fill="${look.ink}" opacity=".08"/><path d="M40 160 q40 -30 80 0 t80 0" fill="none" stroke="${look.ink}" stroke-opacity=".15" stroke-width="3"/><circle cx="62" cy="52" r="3" fill="${look.ink}" opacity=".2"/><circle cx="214" cy="34" r="4" fill="${look.ink}" opacity=".2"/><circle cx="200" cy="96" r="2.5" fill="${look.ink}" opacity=".2"/><path d="M150 26 c-30 0 -46 22 -46 46 c0 30 30 52 46 58 c16 -6 46 -28 46 -58 c0 -24 -16 -46 -46 -46z" fill="url(#b)"/><path d="M150 130 l-6 8 h12z" fill="${look.accent}"/><path d="M150 138 c-6 14 6 22 -2 40" fill="none" stroke="${look.ink}" stroke-opacity=".4" stroke-width="1.5"/><ellipse cx="136" cy="56" rx="8" ry="14" fill="#fff" opacity=".35" transform="rotate(-20 136 56)"/></svg>`;
  return doc({
    title: `Page not found · ${site.name}`,
    css: '',
    head: `<style>${css}</style>`,
    icon: site.iconLink ?? '',
    body: `<main>${balloon}<div class="code">Error 404</div><h1>This page drifted away</h1><p>Nothing lives at <code>${esc(path)}</code> on ${esc(site.name)}. It may have moved, or the link may be wrong.</p><div class="actions"><a class="btn primary" href="/">Back to ${esc(site.name)}</a><a class="btn ghost" href="javascript:history.back()">Go back</a></div><footer>${esc(site.host)}</footer></main>`,
  });
}
