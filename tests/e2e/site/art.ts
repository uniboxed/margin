// The test site's pictures, drawn as SVG from a seed: landscapes, a city, a
// coast, abstract work, products, avatars and a map. Served on every site at
// /media/art/<kind>.svg?seed=…&w=…&h=…&… (server.ts), so each site loads its
// pictures from itself, as real sites do from their own servers.

// A seeded random source (mulberry32): the same picture every time.
export function rng(seed: string | number) {
  let a = typeof seed === 'number' ? seed : [...String(seed)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0, 7);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f1 = (n: number) => Math.round(n * 10) / 10;
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]);

export function shade(hex: string, amount: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(amount < 0 ? v * (1 + amount) : v + (255 - v) * amount));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const svg = (w: number, h: number, body: string, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice">${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>`;
const linear = (id: string, stops: string[], x2 = 0, y2 = 1) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stops.map((c, i) => `<stop offset="${f1((i / (stops.length - 1)) * 100)}%" stop-color="${c}"/>`).join('')}</linearGradient>`;
const radial = (id: string, inner: string, outer: string, opacity = 1) =>
  `<radialGradient id="${id}"><stop offset="0%" stop-color="${inner}" stop-opacity="${opacity}"/><stop offset="100%" stop-color="${outer}" stop-opacity="0"/></radialGradient>`;

// A ridge line across the picture: a sum of slow waves.
function ridge(r: () => number, w: number, h: number, base: number, height: number, roughness = 1) {
  const waves = Array.from({ length: 4 }, (_, k) => ({ a: (height / (k + 1.2)) * (0.6 + r() * 0.8), f: ((k + 1) * (1.2 + r() * 1.6) * Math.PI * roughness) / w, p: r() * 10 }));
  const pts = [];
  for (let x = 0; x <= w; x += w / 60) {
    const y = base - waves.reduce((s, v) => s + v.a * Math.sin(v.f * x + v.p), 0) - height * 0.2;
    pts.push(`${f1(x)},${f1(y)}`);
  }
  return `M0,${h} L${pts.join(' L')} L${w},${h} Z`;
}

const PALETTES: Record<string, { sky: string[], sun: string, near: string, far: string }> = {
  dawn: { sky: ['#fbe3c9', '#f5b494', '#d98b8f'], sun: '#fff4dd', near: '#3d2c4e', far: '#c49aa6' },
  dusk: { sky: ['#2b1e3f', '#83405f', '#f39270'], sun: '#ffd9a0', near: '#170f24', far: '#6c3d63' },
  alpine: { sky: ['#e6f3fb', '#a9d2ec'], sun: '#ffffff', near: '#1f3d55', far: '#8fb6cf' },
  desert: { sky: ['#fff0d6', '#f8c79c'], sun: '#fff8ec', near: '#7d3f22', far: '#e7aa79' },
  night: { sky: ['#070b1f', '#1a2654', '#30407a'], sun: '#f4f1e1', near: '#05081a', far: '#28366a' },
  forest: { sky: ['#eef5e8', '#c7dfc6'], sun: '#fffbe9', near: '#1d3b2c', far: '#97bea2' },
  mint: { sky: ['#e8f7f1', '#bde8db'], sun: '#ffffff', near: '#0f4c46', far: '#7cc7b5' },
};

export function landscape({ w = 1200, h = 700, seed = 1, palette = 'dawn' }) {
  const r = rng(`land${seed}`);
  const p = PALETTES[palette] || PALETTES.dawn;
  const sx = w * (0.25 + r() * 0.5);
  const sy = h * (0.3 + r() * 0.15);
  let stars = '';
  if (palette === 'night') for (let i = 0; i < 120; i++) stars += `<circle cx="${f1(r() * w)}" cy="${f1(r() * h * 0.6)}" r="${f1(0.4 + r() * 1.3)}" fill="#fff" opacity="${f1(0.3 + r() * 0.7)}"/>`;
  const layers = 5;
  let hills = '';
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1);
    const color = mixHex(p.far, p.near, t);
    hills += `<path d="${ridge(r, w, h, h * (0.5 + t * 0.32), h * (0.16 - t * 0.06), 1 + t)}" fill="${color}"/>`;
    if (i === 1) hills += `<rect x="0" y="${f1(h * 0.45)}" width="${w}" height="${f1(h * 0.25)}" fill="url(#mist)" />`;
  }
  const defs = linear('sky', p.sky) + radial('glow', p.sun, p.sun, 0.75) + `<linearGradient id="mist" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.sky[p.sky.length - 1]}" stop-opacity="0"/><stop offset=".5" stop-color="${p.sky[p.sky.length - 1]}" stop-opacity=".65"/><stop offset="1" stop-color="${p.sky[p.sky.length - 1]}" stop-opacity="0"/></linearGradient>`;
  return svg(w, h, `<rect width="${w}" height="${h}" fill="url(#sky)"/>${stars}<circle cx="${f1(sx)}" cy="${f1(sy)}" r="${f1(h * 0.32)}" fill="url(#glow)"/><circle cx="${f1(sx)}" cy="${f1(sy)}" r="${f1(h * 0.07)}" fill="${p.sun}"/>${hills}`, defs);
}

function mixHex(a: string, b: string, t: number) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const c = [16, 8, 0].map((s) => Math.round(((pa >> s) & 255) + ((((pb >> s) & 255) - ((pa >> s) & 255)) * t)));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// A city at first light: two rows of buildings, a few lit windows, a river.
export function city({ w = 1600, h = 900, seed = 3, palette = 'dawn' }) {
  const r = rng(`city${seed}`);
  const night = palette === 'night';
  const sky = night ? ['#0a1030', '#24306a', '#5a4a7a'] : ['#c9d6e8', '#f2d2c2', '#f7b89a'];
  const far = night ? '#2a3363' : '#a7a9c4';
  const near = night ? '#0d1230' : '#4a4a6a';
  const water = h * 0.78;
  const row = (y0: number, minH: number, maxH: number, color: string, lit: number, step: number) => {
    let x = -10;
    let out = '';
    while (x < w) {
      const bw = step * (0.6 + r() * 0.9);
      const bh = minH + r() * (maxH - minH);
      const top = y0 - bh;
      out += `<rect x="${f1(x)}" y="${f1(top)}" width="${f1(bw)}" height="${f1(bh)}" fill="${color}"/>`;
      if (r() < 0.25) out += `<rect x="${f1(x + bw * 0.4)}" y="${f1(top - bh * 0.12)}" width="${f1(bw * 0.12)}" height="${f1(bh * 0.12)}" fill="${color}"/>`;
      if (r() < 0.15) out += `<polygon points="${f1(x)},${f1(top)} ${f1(x + bw / 2)},${f1(top - bw * 0.5)} ${f1(x + bw)},${f1(top)}" fill="${color}"/>`;
      if (lit) {
        for (let wy = top + 10; wy < y0 - 12; wy += 16) {
          for (let wx = x + 7; wx < x + bw - 10; wx += 13) {
            const on = r() < lit;
            out += `<rect x="${f1(wx)}" y="${f1(wy)}" width="6" height="8" fill="${on ? '#ffd27a' : shade(color, 0.12)}" opacity="${on ? f1(0.7 + r() * 0.3) : 0.6}"/>`;
          }
        }
      }
      x += bw + r() * 4;
    }
    return out;
  };
  const back = row(water, h * 0.2, h * 0.5, far, 0, 70);
  const front = row(water, h * 0.12, h * 0.38, near, night ? 0.35 : 0.06, 90);
  const sun = night ? `<circle cx="${f1(w * 0.78)}" cy="${f1(h * 0.18)}" r="${f1(h * 0.05)}" fill="#f4efd8"/>` : `<circle cx="${f1(w * 0.7)}" cy="${f1(h * 0.42)}" r="${f1(h * 0.3)}" fill="url(#glow)"/><circle cx="${f1(w * 0.7)}" cy="${f1(h * 0.42)}" r="${f1(h * 0.06)}" fill="#fff3df"/>`;
  let ripples = '';
  for (let i = 0; i < 40; i++) {
    const y = water + 6 + r() * (h - water - 6);
    const x = r() * w;
    ripples += `<rect x="${f1(x)}" y="${f1(y)}" width="${f1(30 + r() * 120)}" height="1.5" fill="#ffffff" opacity="${f1(0.15 + r() * 0.25)}"/>`;
  }
  const bridge = `<path d="M${f1(w * 0.05)},${f1(water - 30)} Q${f1(w * 0.3)},${f1(water - 110)} ${f1(w * 0.55)},${f1(water - 30)}" fill="none" stroke="${near}" stroke-width="5"/><rect x="0" y="${f1(water - 34)}" width="${f1(w * 0.6)}" height="8" fill="${near}"/>`;
  const defs = linear('sky', sky) + `<linearGradient id="haze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[1]}" stop-opacity="0"/><stop offset="1" stop-color="${sky[1]}" stop-opacity="0.55"/></linearGradient>` + radial('glow', '#fff1d0', '#fff1d0', 0.8) + linear('water', [night ? '#1b2350' : '#8f97b8', night ? '#070a1c' : '#3f4565']) + '<filter id="blur"><feGaussianBlur stdDeviation="2"/></filter>';
  return svg(
    w,
    h,
    `<rect width="${w}" height="${h}" fill="url(#sky)"/>${sun}${back}<rect x="0" y="${f1(water - h * 0.45)}" width="${w}" height="${f1(h * 0.45)}" fill="url(#haze)"/>${front}${bridge}<rect x="0" y="${f1(water)}" width="${w}" height="${f1(h - water)}" fill="url(#water)"/><g transform="translate(0 ${f1(water * 2)}) scale(1 -1)" opacity="0.25" filter="url(#blur)">${front}</g>${ripples}`,
    defs,
  );
}

// A coast: sea to the horizon, a headland, a sail, gulls.
export function coast({ w = 1600, h = 900, seed = 5, palette = 'day' }) {
  const r = rng(`coast${seed}`);
  const evening = palette === 'evening';
  const sky = evening ? ['#ffcf9e', '#ff9c7a', '#c4607a'] : ['#bfe6f5', '#e8f6f7', '#fff4e0'];
  const sea = evening ? ['#c86d6f', '#4b3a63'] : ['#5cc4cf', '#127a8a'];
  const horizon = h * (0.5 + r() * 0.08);
  const sx = w * (0.3 + r() * 0.3);
  let lines = '';
  for (let i = 0; i < 60; i++) {
    const y = horizon + 4 + (r() ** 1.6) * (h - horizon);
    lines += `<rect x="${f1(r() * w)}" y="${f1(y)}" width="${f1(20 + r() * 140)}" height="${f1(1 + (y - horizon) / 160)}" rx="1" fill="#fff" opacity="${f1(0.2 + r() * 0.35)}"/>`;
  }
  let gulls = '';
  for (let i = 0; i < 4; i++) {
    const gx = w * (0.15 + r() * 0.5);
    const gy = h * (0.12 + r() * 0.25);
    const s = 8 + r() * 10;
    gulls += `<path d="M${f1(gx - s)},${f1(gy)} q${f1(s / 2)},${f1(-s / 2)} ${f1(s)},0 q${f1(s / 2)},${f1(-s / 2)} ${f1(s)},0" fill="none" stroke="#33415c" stroke-width="2" stroke-linecap="round"/>`;
  }
  let clouds = '';
  for (let i = 0; i < 5; i++) {
    const cx = r() * w;
    const cy = h * (0.08 + r() * 0.25);
    clouds += `<ellipse cx="${f1(cx)}" cy="${f1(cy)}" rx="${f1(80 + r() * 140)}" ry="${f1(14 + r() * 16)}" fill="#fff" opacity="${f1(evening ? 0.25 : 0.7)}"/>`;
  }
  const boatX = w * (0.2 + r() * 0.3);
  const boat = `<g transform="translate(${f1(boatX)} ${f1(horizon + 24)})"><path d="M-34,0 L34,0 L24,12 L-24,12 Z" fill="#1f2a44"/><path d="M0,-4 L0,-78 L30,-6 Z" fill="#fffaf0"/><path d="M-3,-6 L-3,-60 L-26,-6 Z" fill="#f2d6b3"/></g>`;
  const head = `<path d="M${f1(w * 0.62)},${f1(horizon + 2)} C${f1(w * 0.7)},${f1(horizon - h * 0.16)} ${f1(w * 0.82)},${f1(horizon - h * 0.22)} ${w},${f1(horizon - h * 0.24)} L${w},${h} L${f1(w * 0.72)},${h} C${f1(w * 0.7)},${f1(horizon + h * 0.2)} ${f1(w * 0.66)},${f1(horizon + 10)} ${f1(w * 0.62)},${f1(horizon + 2)} Z" fill="${evening ? '#3b2a45' : '#3e6b4f'}"/><path d="M${f1(w * 0.8)},${f1(horizon - h * 0.205)} l0,-36 l16,0 l0,36 Z" fill="#f5efe6"/><path d="M${f1(w * 0.8 - 4)},${f1(horizon - h * 0.205 - 36)} l24,0 l-12,-14 Z" fill="#d9534f"/>`;
  const defs = linear('sky', sky) + linear('sea', sea) + radial('glow', '#fff6dc', '#fff6dc', 0.9) + '<linearGradient id="shine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff6dc" stop-opacity="0"/><stop offset=".5" stop-color="#fff6dc" stop-opacity=".35"/><stop offset="1" stop-color="#fff6dc" stop-opacity="0"/></linearGradient>';
  return svg(
    w,
    h,
    `<rect width="${w}" height="${h}" fill="url(#sky)"/><circle cx="${f1(sx)}" cy="${f1(horizon - h * 0.12)}" r="${f1(h * 0.28)}" fill="url(#glow)"/><circle cx="${f1(sx)}" cy="${f1(horizon - h * 0.12)}" r="${f1(h * 0.06)}" fill="#fffaf0"/>${clouds}<rect y="${f1(horizon)}" width="${w}" height="${f1(h - horizon)}" fill="url(#sea)"/><rect x="${f1(sx - 34)}" y="${f1(horizon)}" width="68" height="${f1(h - horizon)}" fill="url(#shine)"/>${lines}${boat}${head}${gulls}`,
    defs,
  );
}

// Abstract work for the portfolio: one of six compositions.
const INK = ['#ece7df', '#ff5a36', '#d9a441', '#3aa6a0', '#6b5cff', '#f2c9b8'];
export function abstract({ w = 900, h = 1100, seed = 1, bg = '#151517' }) {
  const r = rng(`abs${seed}`);
  const pick = () => INK[Math.floor(r() * INK.length)];
  const kind = ['orbits', 'bauhaus', 'waves', 'grid', 'monolith', 'bloom'][seed % 6];
  let body = '';
  const cx = w / 2;
  const cy = h / 2;
  if (kind === 'orbits') {
    for (let i = 0; i < 9; i++) body += `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(40 + i * 42)}" fill="none" stroke="${i % 3 ? '#ece7df' : pick()}" stroke-width="${f1(1 + r() * 3)}" stroke-dasharray="${f1(4 + r() * 60)} ${f1(4 + r() * 30)}" opacity="${f1(0.4 + r() * 0.6)}"/>`;
    body += `<circle cx="${f1(cx + 120)}" cy="${f1(cy - 160)}" r="46" fill="${INK[1]}"/>`;
  } else if (kind === 'bauhaus') {
    body += `<rect x="${f1(w * 0.12)}" y="${f1(h * 0.14)}" width="${f1(w * 0.5)}" height="${f1(h * 0.42)}" fill="${INK[2]}"/><circle cx="${f1(w * 0.62)}" cy="${f1(h * 0.56)}" r="${f1(w * 0.26)}" fill="${INK[1]}" style="mix-blend-mode:screen"/><path d="M${f1(w * 0.1)},${f1(h * 0.9)} L${f1(w * 0.5)},${f1(h * 0.5)} L${f1(w * 0.5)},${f1(h * 0.9)} Z" fill="${INK[3]}"/><rect x="${f1(w * 0.7)}" y="${f1(h * 0.1)}" width="16" height="${f1(h * 0.8)}" fill="#ece7df"/>`;
  } else if (kind === 'waves') {
    for (let i = 0; i < 22; i++) {
      const y = h * 0.15 + i * (h * 0.7) / 22;
      const a = 20 + r() * 40;
      body += `<path d="M0,${f1(y)} C${f1(w * 0.25)},${f1(y - a)} ${f1(w * 0.5)},${f1(y + a)} ${f1(w * 0.75)},${f1(y - a / 2)} S${w},${f1(y)} ${w},${f1(y)}" fill="none" stroke="${i % 5 === 0 ? INK[3] : '#ece7df'}" stroke-width="${i % 5 === 0 ? 4 : 1.5}" opacity="${f1(0.35 + (i / 22) * 0.6)}"/>`;
    }
  } else if (kind === 'grid') {
    const n = 7;
    const s = (w * 0.8) / n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < Math.round(n * 1.2); j++) {
        const x = w * 0.1 + i * s + s / 2;
        const y = h * 0.1 + j * s + s / 2;
        const v = r();
        body += v < 0.6 ? `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(s * (0.08 + r() * 0.3))}" fill="${v < 0.12 ? INK[1] : '#ece7df'}"/>` : `<rect x="${f1(x - s * 0.3)}" y="${f1(y - s * 0.3)}" width="${f1(s * 0.6)}" height="${f1(s * 0.6)}" fill="none" stroke="${pick()}" stroke-width="2" transform="rotate(${f1(r() * 45)} ${f1(x)} ${f1(y)})"/>`;
      }
  } else if (kind === 'monolith') {
    body += `<rect x="0" y="${f1(h * 0.7)}" width="${w}" height="${f1(h * 0.3)}" fill="#202024"/><rect x="${f1(w * 0.42)}" y="${f1(h * 0.18)}" width="${f1(w * 0.16)}" height="${f1(h * 0.56)}" fill="url(#mono)"/><circle cx="${f1(w * 0.5)}" cy="${f1(h * 0.16)}" r="${f1(w * 0.33)}" fill="url(#halo)"/>`;
  } else {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * 360;
      body += `<ellipse cx="${f1(cx)}" cy="${f1(cy - 150)}" rx="60" ry="150" fill="${i % 2 ? INK[5] : INK[1]}" opacity="0.55" transform="rotate(${a} ${f1(cx)} ${f1(cy)})" style="mix-blend-mode:screen"/>`;
    }
    body += `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="44" fill="${INK[2]}"/>`;
  }
  let grain = '';
  for (let i = 0; i < 260; i++) grain += `<rect x="${f1(r() * w)}" y="${f1(r() * h)}" width="1.4" height="1.4" fill="#fff" opacity="${f1(r() * 0.12)}"/>`;
  const defs = linear('mono', ['#ece7df', '#8d877f']) + radial('halo', '#ff5a36', '#ff5a36', 0.55);
  return svg(w, h, `<rect width="${w}" height="${h}" fill="${bg}"/>${body}${grain}`, defs);
}

// Products for the shop: each drawn in its colour on a soft ground.
const PRODUCTS: Record<string, (color: string) => string> = {
  tote: (c) => `<path d="M150,140 C150,70 250,70 250,140" fill="none" stroke="${shade(c, -0.25)}" stroke-width="12" stroke-linecap="round"/><path d="M170,140 C170,95 230,95 230,140" fill="none" stroke="${shade(c, -0.15)}" stroke-width="10" stroke-linecap="round"/><path d="M110,140 L290,140 L300,330 L100,330 Z" fill="url(#body)"/><path d="M110,140 L290,140 L291,160 L109,160 Z" fill="${shade(c, -0.12)}"/><rect x="150" y="215" width="100" height="70" rx="4" fill="${shade(c, 0.12)}" stroke="${shade(c, -0.2)}" stroke-dasharray="5 4" stroke-width="2"/><rect x="186" y="300" width="28" height="14" rx="2" fill="#2b2b2b" opacity="0.7"/>`,
  mug: (c) => `<path d="M270,175 C330,175 330,265 262,262" fill="none" stroke="${shade(c, -0.15)}" stroke-width="18"/><path d="M120,150 L280,150 L272,300 Q270,325 245,325 L155,325 Q130,325 128,300 Z" fill="url(#body)"/><ellipse cx="200" cy="150" rx="80" ry="18" fill="${shade(c, -0.3)}"/><ellipse cx="200" cy="152" rx="70" ry="13" fill="#4a2d1e"/><path d="M175,120 c-12,-20 12,-30 0,-55 M205,118 c-12,-20 12,-30 0,-55 M235,120 c-12,-20 12,-30 0,-55" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" opacity="0.7"/>`,
  lamp: (c) => `<ellipse cx="200" cy="215" rx="120" ry="90" fill="url(#glow)"/><path d="M140,100 L260,100 L295,195 L105,195 Z" fill="url(#body)"/><rect x="194" y="195" width="12" height="120" fill="#3a3a3a"/><ellipse cx="200" cy="322" rx="62" ry="14" fill="#2f2f2f"/><ellipse cx="200" cy="196" rx="95" ry="7" fill="${shade(c, -0.3)}"/>`,
  sneaker: (c) => `<path d="M80,280 L320,280 Q340,280 338,298 L336,306 Q334,316 320,316 L84,316 Q70,316 70,300 Z" fill="#f7f4ee" stroke="#d8d2c6" stroke-width="3"/><path d="M90,280 C88,230 100,190 140,175 L175,165 C190,200 230,215 270,222 C310,230 330,250 325,280 Z" fill="url(#body)"/><path d="M150,180 l20,40 M165,173 l20,40 M180,168 l20,40" stroke="#fff" stroke-width="5" stroke-linecap="round"/><path d="M110,262 C170,250 230,236 300,258" fill="none" stroke="${shade(c, 0.45)}" stroke-width="10" stroke-linecap="round"/><rect x="92" y="175" width="34" height="80" rx="12" fill="${shade(c, -0.2)}"/>`,
  backpack: (c) => `<path d="M165,110 C165,70 235,70 235,110" fill="none" stroke="${shade(c, -0.3)}" stroke-width="12"/><rect x="120" y="105" width="160" height="225" rx="46" fill="url(#body)"/><rect x="145" y="215" width="110" height="90" rx="22" fill="${shade(c, -0.12)}"/><path d="M150,232 L250,232" stroke="${shade(c, -0.35)}" stroke-width="4"/><circle cx="245" cy="232" r="6" fill="#d9c08a"/><path d="M135,150 Q200,130 265,150" fill="none" stroke="${shade(c, -0.2)}" stroke-width="5"/>`,
  plant: (c) => `<g fill="#3f7d4f"><ellipse cx="170" cy="150" rx="26" ry="70" transform="rotate(-30 170 150)"/><ellipse cx="230" cy="140" rx="26" ry="75" transform="rotate(28 230 140)"/><ellipse cx="200" cy="120" rx="22" ry="80" fill="#4f9a62"/><ellipse cx="140" cy="200" rx="22" ry="55" transform="rotate(-60 140 200)" fill="#5aa86c"/><ellipse cx="262" cy="196" rx="22" ry="55" transform="rotate(60 262 196)" fill="#5aa86c"/></g><path d="M130,215 L270,215 L252,330 L148,330 Z" fill="url(#body)"/><rect x="122" y="205" width="156" height="26" rx="6" fill="${shade(c, -0.15)}"/>`,
  chair: (c) => `<path d="M140,330 L155,230 M260,330 L245,230 M170,320 L178,240 M232,320 L222,240" stroke="#8a6a4a" stroke-width="9" stroke-linecap="round"/><path d="M130,215 Q200,190 270,215 L262,245 Q200,228 138,245 Z" fill="${shade(c, -0.12)}"/><path d="M140,90 Q200,70 260,90 L262,205 Q200,185 138,205 Z" fill="url(#body)"/>`,
  bottle: (c) => `<rect x="176" y="70" width="48" height="34" rx="8" fill="#2f2f2f"/><rect x="186" y="58" width="28" height="16" rx="5" fill="#444"/><path d="M160,110 Q160,100 176,100 L224,100 Q240,100 240,110 L245,140 L245,320 Q245,335 230,335 L170,335 Q155,335 155,320 L155,140 Z" fill="url(#body)"/><rect x="155" y="190" width="90" height="70" fill="${shade(c, 0.5)}" opacity="0.8"/><rect x="172" y="120" width="10" height="190" rx="5" fill="#fff" opacity="0.25"/>`,
  cap: (c) => `<path d="M100,240 C100,140 300,140 300,240 Z" fill="url(#body)"/><path d="M200,152 L200,240 M150,165 Q175,200 170,240 M250,165 Q225,200 230,240" stroke="${shade(c, -0.25)}" stroke-width="3" fill="none"/><circle cx="200" cy="150" r="9" fill="${shade(c, -0.25)}"/><path d="M95,238 Q200,226 305,238 Q350,246 360,262 Q300,272 200,262 Q120,256 95,250 Z" fill="${shade(c, -0.18)}"/>`,
  notebook: (c) => `<g transform="rotate(-6 200 200)"><rect x="128" y="88" width="160" height="230" rx="10" fill="#f3efe7"/><rect x="118" y="80" width="160" height="230" rx="10" fill="url(#body)"/><rect x="250" y="80" width="10" height="230" fill="#2b2b2b" opacity="0.75"/><rect x="140" y="120" width="80" height="34" rx="4" fill="#fff" opacity="0.85"/><rect x="150" y="130" width="60" height="5" rx="2" fill="#999"/><rect x="150" y="141" width="40" height="5" rx="2" fill="#bbb"/></g>`,
  candle: (c) => `<ellipse cx="200" cy="120" rx="70" ry="70" fill="url(#glow)"/><path d="M200,95 C188,115 190,132 200,138 C210,132 212,115 200,95 Z" fill="#ffb347"/><path d="M200,110 C195,122 196,131 200,134 C204,131 205,122 200,110 Z" fill="#fff2c4"/><rect x="198" y="136" width="4" height="22" fill="#333"/><rect x="135" y="150" width="130" height="175" rx="18" fill="#ffffff" opacity="0.45" stroke="#ffffff" stroke-width="3"/><rect x="141" y="158" width="118" height="161" rx="14" fill="url(#body)"/><rect x="160" y="215" width="80" height="44" rx="4" fill="#fffaf2"/><rect x="172" y="230" width="56" height="4" fill="#a99" /><rect x="180" y="240" width="40" height="4" fill="#cbb"/>`,
  headphones: (c) => `<path d="M115,250 L115,190 C115,95 285,95 285,190 L285,250" fill="none" stroke="${shade(c, -0.25)}" stroke-width="16" stroke-linecap="round"/><path d="M125,190 C125,115 275,115 275,190" fill="none" stroke="${shade(c, 0.35)}" stroke-width="5" opacity="0.7"/><rect x="88" y="215" width="58" height="100" rx="26" fill="url(#body)"/><rect x="254" y="215" width="58" height="100" rx="26" fill="url(#body)"/><rect x="132" y="232" width="18" height="66" rx="8" fill="#2c2c2c"/><rect x="250" y="232" width="18" height="66" rx="8" fill="#2c2c2c"/>`,
};
export const PRODUCT_KINDS = Object.keys(PRODUCTS);

export function product({ kind = 'tote', color = '#d9c6a5', bg = '#efe9df', w = 400, h = 400, angle = 0 }) {
  const draw = PRODUCTS[kind] || PRODUCTS.tote;
  const defs = linear('body', [shade(color, 0.12), shade(color, -0.12)], 1, 1) + radial('glow', '#fff3c4', '#fff3c4', 0.85) + radial('floor', '#000000', '#000000', 0.22) + linear('bg', [shade(bg, 0.25), bg]);
  const turn = angle ? ` transform="rotate(${angle} 200 210) translate(${angle > 0 ? 10 : -10} 0)"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 400 400" preserveAspectRatio="xMidYMid slice"><defs>${defs}</defs><rect width="400" height="400" fill="url(#bg)"/><ellipse cx="200" cy="334" rx="130" ry="18" fill="url(#floor)"/><g${turn}>${draw(color)}</g></svg>`;
}

// A round avatar with initials.
export function avatar({ name = 'A B', size = 96, seed }: { name?: string, size?: number, seed?: string | number }) {
  const r = rng(`av${seed ?? name}`);
  const hue = Math.floor(r() * 360);
  const initials = String(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');
  const defs = `<linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 65% 42%)"/></linearGradient>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 96 96"><defs>${defs}</defs><circle cx="48" cy="48" r="48" fill="url(#a)"/><text x="48" y="49" text-anchor="middle" dominant-baseline="central" font-family="-apple-system, system-ui, Helvetica, Arial, sans-serif" font-weight="600" font-size="36" fill="#fff">${esc(initials)}</text></svg>`;
}

// A town map: a street grid at a slant, blocks and parks, a river, two
// avenues, labels and pins.
export function map({ w = 1200, h = 800, seed = 2, pins = 3 }) {
  const r = rng(`map${seed}`);
  const sp = 86 + r() * 30;
  const angle = f1((r() - 0.5) * 24);
  const big = Math.hypot(w, h);
  const cx = w / 2;
  const cy = h / 2;
  let blocks = '';
  let grid = '';
  const n = Math.ceil(big / sp) + 2;
  for (let i = -n / 2; i < n / 2; i++) {
    for (let j = -n / 2; j < n / 2; j++) {
      const x = cx + i * sp + 9;
      const y = cy + j * sp + 9;
      const v = r();
      blocks += `<rect x="${f1(x)}" y="${f1(y)}" width="${f1(sp - 18)}" height="${f1(sp - 18)}" rx="4" fill="${v < 0.08 ? '#cfe6c3' : v < 0.12 ? '#e9dcc3' : '#ebe7dd'}"/>`;
      if (v >= 0.12 && r() < 0.5) blocks += `<rect x="${f1(x + 8)}" y="${f1(y + 8)}" width="${f1((sp - 34) / 2)}" height="${f1((sp - 34) / 2)}" rx="2" fill="#e2ddd1"/>`;
    }
    grid += `<path d="M${f1(cx + i * sp)},${f1(cy - big)} V${f1(cy + big)} M${f1(cx - big)},${f1(cy + i * sp)} H${f1(cx + big)}"/>`;
  }
  const avenue = (y0: number, y1: number) => `M${f1(-40)},${f1(y0)} C${f1(w * 0.35)},${f1(y0 + (r() - 0.5) * 120)} ${f1(w * 0.65)},${f1(y1 + (r() - 0.5) * 120)} ${f1(w + 40)},${f1(y1)}`;
  const av = [avenue(h * (0.1 + r() * 0.3), h * (0.3 + r() * 0.3)), `M${f1(w * (0.2 + r() * 0.3))},-40 C${f1(w * 0.4)},${f1(h * 0.4)} ${f1(w * 0.6)},${f1(h * 0.6)} ${f1(w * (0.6 + r() * 0.3))},${h + 40}`];
  const river = `<path d="M-40,${f1(h * 0.72)} C${f1(w * 0.25)},${f1(h * 0.58)} ${f1(w * 0.45)},${f1(h * 0.98)} ${f1(w * 0.7)},${f1(h * 0.8)} S${w + 40},${f1(h * 0.66)} ${w + 40},${f1(h * 0.66)}" fill="none" stroke="#a7d3ec" stroke-width="${f1(h * 0.09)}" stroke-linecap="round"/>`;
  const names = ['Mill Lane', 'Harbour Rd', 'Elm St', 'Station Ave', 'Kettle Way', 'Rope Walk'];
  let labels = '';
  for (let i = 0; i < 4; i++) labels += `<text x="${f1(w * (0.1 + r() * 0.7))}" y="${f1(h * (0.1 + r() * 0.8))}" font-family="-apple-system, system-ui, sans-serif" font-size="13" fill="#8a8476" transform="rotate(${angle} ${f1(cx)} ${f1(cy)})">${names[(i + seed) % names.length]}</text>`;
  let marks = '';
  for (let i = 0; i < pins; i++) {
    const x = w * (0.2 + r() * 0.6);
    const y = h * (0.2 + r() * 0.5);
    const c = ['#e5484d', '#3e63dd', '#f5a524', '#12a594'][i % 4];
    marks += `<g transform="translate(${f1(x)} ${f1(y)})"><ellipse cx="0" cy="2" rx="9" ry="4" fill="#000" opacity="0.2"/><path d="M0,0 C-6,-12 -16,-20 -16,-32 A16,16 0 1 1 16,-32 C16,-20 6,-12 0,0 Z" fill="${c}" stroke="#fff" stroke-width="3"/><circle cx="0" cy="-32" r="6" fill="#fff"/></g>`;
  }
  return svg(
    w,
    h,
    `<rect width="${w}" height="${h}" fill="#f6f3ec"/><g transform="rotate(${angle} ${f1(cx)} ${f1(cy)})">${blocks}<g fill="none" stroke="#ffffff" stroke-width="9">${grid}</g></g>${river}<g fill="none" stroke-linecap="round">${av.map((d) => `<path d="${d}" stroke="#e3c98a" stroke-width="18"/><path d="${d}" stroke="#fbe7b0" stroke-width="13"/>`).join('')}</g>${labels}${marks}`,
  );
}

// One kind from a query: what /media/art/<kind>.svg serves.
export function artFor(kind: string, q: URLSearchParams) {
  const n = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
  const s = (k: string, d: string) => q.get(k) ?? d;
  switch (kind) {
    case 'landscape':
      return landscape({ w: n('w', 1200), h: n('h', 700), seed: n('seed', 1), palette: s('p', 'dawn') });
    case 'city':
      return city({ w: n('w', 1600), h: n('h', 900), seed: n('seed', 3), palette: s('p', 'dawn') });
    case 'coast':
      return coast({ w: n('w', 1600), h: n('h', 900), seed: n('seed', 5), palette: s('p', 'day') });
    case 'abstract':
      return abstract({ w: n('w', 900), h: n('h', 1100), seed: n('seed', 1), bg: s('bg', '#151517') });
    case 'product':
      return product({ kind: s('kind', 'tote'), color: s('c', '#d9c6a5'), bg: s('bg', '#efe9df'), angle: n('a', 0) });
    case 'avatar':
      return avatar({ name: s('name', 'A B'), size: n('size', 96) });
    case 'map':
      return map({ w: n('w', 1200), h: n('h', 800), seed: n('seed', 2), pins: n('pins', 3) });
    default:
      return null;
  }
}
