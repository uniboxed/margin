// Test pages and the probe for the first-paint spike (README.md here), shared
// by the Chromium run (chromium.mjs) and the WebKit host (server.mjs, host.swift).

// The probe, in the page's own world from the document's start: <html>'s place
// (its transform and size, from computed style, which nothing of Margin's
// answers for) at the start and at each of the first 90 rendering updates
// (requestAnimationFrame runs just before each frame is drawn), and the
// browser's paint entries. A frame drawn is the state of the update before it.
export const PROBE = `(() => {
  if (window !== top || window.__fp) return;
  if (!/^\\/fp\\//.test(location.pathname) && !/wikipedia\\.org$/.test(location.hostname)) return;
  const fp = window.__fp = { frames: [], paints: [], origin: performance.timeOrigin };
  // ?late=<ms>: Margin's content script holds its box messages that long (content/page-link.js), as in Safari.
  const late = new URLSearchParams(location.search).get('late');
  // (Chromium runs this before <html> exists: set as it arrives.)
  const markLate = () => document.documentElement?.setAttribute('data-fp-late', late);
  if (late && document.documentElement) markLate();
  else if (late) { const m = new MutationObserver(() => { if (document.documentElement) { markLate(); m.disconnect(); } }); m.observe(document, { childList: true }); }
  const read = (kind, t) => {
    const el = document.documentElement;
    if (!el) return fp.frames.push({ kind, t, none: true });
    const s = getComputedStyle(el);
    const m = s.transform && s.transform !== 'none' ? new DOMMatrixReadOnly(s.transform) : null;
    fp.frames.push({ kind, t: Math.round(t * 10) / 10, x: m ? m.e : 0, y: m ? m.f : 0, w: parseFloat(s.width), h: parseFloat(s.height),
      vars: s.getPropertyValue('--margin-at').trim() === '1' ? ['left', 'top', 'right', 'bottom'].map((k) => { let v = 0; for (const m of s.getPropertyValue('--margin-at-' + k).matchAll(/(-?[\\d.]+)px/g)) v += +m[1]; return v; }) : null,
      off: el.getAttribute('data-margin-docked'), body: !!document.body, own: s.getPropertyValue('--margin-own').trim() === '1' });
  };
  read('start', performance.now());
  // Margin's content script moving the box (content/page-link.js), and taking over from the first-paint CSS.
  fp.boxAt = [];
  document.addEventListener('margin:box', (e) => fp.boxAt.push([Math.round(performance.now() * 10) / 10, String(e.detail).slice(0, 80)]), true);
  fp.selfs = [];
  document.addEventListener('margin:box-self', () => { const t = Math.round(performance.now() * 10) / 10; fp.selfAt ??= t; fp.selfs.push(t); }, true);
  new MutationObserver(() => { if (fp.offAt == null && document.documentElement.getAttribute('data-margin-docked') === 'off') fp.offAt = Math.round(performance.now() * 10) / 10; })
    .observe(document.documentElement ?? document, { attributes: true, attributeFilter: ['data-margin-docked'] });
  let n = 0;
  const tick = (t) => { read('frame', t); if (++n < 90) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) fp.paints.push([e.name, Math.round(e.startTime * 10) / 10]); }).observe({ type: 'paint', buffered: true }); } catch {}
})();`;

// The page's own colors, so a screenshot tells the box from the frame
// (#9c9da1) and from the window's canvas around the box (<html>'s color, red):
// <body> fills the box, green.
const RED = '#e33';
const GREEN = '#3a3';
const words = (n) => 'text '.repeat(n);
// The page's first script, in its <head>: where the box is as the page's own
// scripts first run, after Margin's page-world script started it and before
// Margin's content script can have moved it (that waits for the background).
const HEAD = `<script>{const s=getComputedStyle(document.documentElement);const m=s.transform&&s.transform!=='none'?new DOMMatrixReadOnly(s.transform):null;window.__fpHead={t:performance.now(),x:m?m.e:0,y:m?m.f:0,w:parseFloat(s.width),h:parseFloat(s.height),off:document.documentElement.getAttribute('data-margin-docked'),own:s.getPropertyValue('--margin-own').trim()==='1'}}</script>`;

// light: a small page that's drawn at once. heavy: about 400 KB, its first
// half drawn as it arrives (no stylesheet to wait for), the rest 500 ms
// later, with a script busy for 40 ms in between.
export function fpPage(kind, name) {
  const head = `<!doctype html><html><head><meta charset="utf-8">${HEAD}<title>${kind} ${name}</title><style>html{background:${RED}}body{margin:0;padding:24px;font:16px sans-serif;color:#111;background:${GREEN}}.b{display:inline-block;width:140px;height:50px;margin:3px;background:#fff8;border-radius:8px;box-shadow:0 2px 8px #0006}</style></head><body><h1>${kind} ${name}</h1>`;
  if (kind === 'light') return { parts: [`${head}<p>${words(200)}</p></body></html>`] };
  const boxes = (from, n) => Array.from({ length: n }, (_, i) => `<div class=b>${from + i} ${words(3)}</div>`).join('');
  return {
    parts: [
      `${head}<p>${words(400)}</p>${boxes(0, 2500)}<script>{const u=performance.now()+40;while(performance.now()<u);}</script>`,
      `${boxes(2500, 2500)}<p>${words(400)}</p></body></html>`,
    ],
    gapMs: 500,
  };
}

// Serves /fp/<kind>/<name> on a node http response.
export function serveFp(url, res) {
  const match = /^\/fp\/(light|heavy)\/(\w+)/.exec(url);
  if (!match) return false;
  const { parts, gapMs = 0 } = fpPage(match[1], match[2]);
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.write(parts[0]);
  if (parts.length === 1) res.end();
  else setTimeout(() => res.end(parts.slice(1).join('')), gapMs);
  return true;
}

// Where <html> is in the window, from a probe frame, and whether that's the layout.
export function insetsOf(frame, vw, vh) {
  if (!frame || frame.none) return null;
  return { left: frame.x, top: frame.y, right: +(vw - frame.x - frame.w).toFixed(2), bottom: +(vh - frame.y - frame.h).toFixed(2) };
}
export const sameInsets = (a, b, by = 0.05) => !!a && !!b && ['left', 'top', 'right', 'bottom'].every((k) => Math.abs(a[k] - b[k]) <= by);

// One load's probe, judged against the layout it should have.
export function judge(fp, layout, vw, vh) {
  const frames = (fp?.frames ?? []).filter((f) => f.kind === 'frame');
  const start = (fp?.frames ?? []).find((f) => f.kind === 'start');
  const want = { left: layout.left, top: layout.top, right: layout.right, bottom: layout.bottom };
  // What each update drew. Margin's page world can correct the box in its own
  // requestAnimationFrame callback (content/page/main.js), after the probe's
  // in the same update, so before that update is drawn: that update drew what
  // the probe reads at the next one.
  const read = frames.map((f) => insetsOf(f, vw, vh));
  const selfIn = new Set((fp?.selfs ?? (fp?.selfAt != null ? [fp.selfAt] : [])).map((s) => frames.findIndex((f, i) => f.t <= s && (i === frames.length - 1 || s < frames[i + 1].t))));
  const at = read.map((i, k) => (selfIn.has(k) && read[k + 1] ? read[k + 1] : i));
  const firstOk = at.length > 0 && sameInsets(at[0], want);
  const okFrom = at.findIndex((i) => sameInsets(i, want));
  // A jump: any drawn frame, after the first, somewhere else than the one before it.
  let moves = 0;
  for (let i = 1; i < at.length; i++) if (!sameInsets(at[i], at[i - 1])) moves++;
  const lastOk = at.length > 0 && sameInsets(at.at(-1), want);
  const paint = fp?.paints?.find((p) => p[0] === 'first-paint' || p[0] === 'first-contentful-paint');
  // Whether the first frame had the layout from the first-paint CSS itself
  // (its variables), and not only from Margin's script moving the box there.
  const v = frames[0]?.vars;
  const cssOk = !!v && v[0] === want.left && v[1] === want.top && v[2] === want.right && v[3] === want.bottom;
  // Where Margin's page-world script started the box (the page's first script).
  const head = fp?.head ? insetsOf({ ...fp.head }, vw, vh) : null;
  return {
    firstOk, okFrom, moves, lastOk, frames: at.length, cssOk, firstVars: v ?? null, firstOff: frames[0]?.off ?? null,
    head, headOk: sameInsets(head, want), headTakenOver: fp?.head?.off === 'off',
    // When Margin's content script first set the box, and took over from the first-paint CSS.
    boxAt: fp?.boxAt?.[0]?.[0] ?? null, offAt: fp?.offAt ?? null,
    // Where Margin's page-world script started its own box, and whether it found the variables then.
    pageStart: fp?.started ?? null, pageStartOk: !!fp?.started && fp.started.left === want.left && fp.started.top === want.top && fp.started.right === want.right && fp.started.bottom === want.bottom,
    // When the window's own sheet (scripting.insertCSS on commit) had arrived: by the page's first script, by the first frame.
    ownAtHead: !!fp?.head?.own, ownAtFirst: !!frames[0]?.own, ownAt: frames.find((f) => f.own)?.t ?? null,
    selfAt: fp?.selfAt ?? null,
    first: at[0] ?? null, startVars: start?.vars ?? null,
    firstFrameAt: frames[0]?.t ?? null, okAt: okFrom >= 0 ? frames[okFrom].t : null, paintAt: paint?.[1] ?? null,
  };
}
