// The test site's raster files, made from code: PNG and ICO icons, the
// "favicon" set of every site, and the podcast's tune (WAV). Nothing here is
// downloaded or committed: server.ts calls media() once when it starts, and
// the same bytes come out every time.
//
//   node tests/e2e/site/make-media.mts <dir>   writes them all to <dir>, to look at
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- PNG ----------

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// RGBA bytes (w × h × 4) to a PNG file.
export function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Several PNGs in one ICO file (PNG entries, as every browser reads them).
export function encodeIco(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, bytes }, i) => {
    const e = 6 + 16 * i;
    head[e] = size >= 256 ? 0 : size;
    head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(bytes.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += bytes.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.bytes)]);
}

// ---------- drawing ----------
// Shapes in a 0..1 square, painted in order, 4 × 4 samples a pixel.

const hex = (h) => {
  const v = h.replace('#', '');
  const n = parseInt(v.length === 3 ? [...v].map((c) => c + c).join('') : v.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, v.length === 8 ? parseInt(v.slice(6), 16) / 255 : 1];
};
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
// A fill: a colour, or a gradient from (x0, y0) to (x1, y1).
const paint = (fill) => {
  if (typeof fill === 'string') {
    const c = hex(fill);
    return () => c;
  }
  const [x0, y0, x1, y1] = fill.from.concat(fill.to);
  const a = hex(fill.stops[0]);
  const b = hex(fill.stops[1]);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = dx * dx + dy * dy;
  return (x, y) => mix(a, b, Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / len)));
};

const inside = {
  rect: (s, x, y) => {
    const qx = Math.abs(x - (s.x + s.w / 2)) - (s.w / 2 - s.r);
    const qy = Math.abs(y - (s.y + s.h / 2)) - (s.h / 2 - s.r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - s.r <= 0;
  },
  circle: (s, x, y) => Math.hypot(x - s.cx, y - s.cy) <= s.r,
  ring: (s, x, y) => {
    const d = Math.hypot(x - s.cx, y - s.cy);
    if (Math.abs(d - s.r) > s.width / 2) return false;
    if (s.sweep == null) return true;
    // Clockwise from 12 o'clock, s.sweep of a turn.
    const a = (Math.atan2(x - s.cx, -(y - s.cy)) / (2 * Math.PI) + 1) % 1;
    return a <= s.sweep;
  },
  line: (s, x, y) => {
    const dx = s.x2 - s.x1;
    const dy = s.y2 - s.y1;
    const t = Math.max(0, Math.min(1, ((x - s.x1) * dx + (y - s.y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (s.x1 + t * dx), y - (s.y1 + t * dy)) <= s.width / 2;
  },
  poly: (s, x, y) => {
    let hit = false;
    const p = s.points;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, yi] = p[i];
      const [xj, yj] = p[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  },
};

export function draw(size, shapes) {
  const out = new Uint8Array(size * size * 4);
  const fills = shapes.map((s) => paint(s.fill));
  const N = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const x = (px + (sx + 0.5) / N) / size;
          const y = (py + (sy + 0.5) / N) / size;
          let c = [0, 0, 0, 0];
          for (let i = 0; i < shapes.length; i++) {
            const s = shapes[i];
            if (!inside[s.kind](s, x, y)) continue;
            const f = fills[i](x, y);
            const fa = f[3] * (s.opacity ?? 1);
            if (s.clear) c = [0, 0, 0, 0];
            else {
              const oa = fa + c[3] * (1 - fa);
              c = oa ? [0, 1, 2].map((k) => (f[k] * fa + c[k] * c[3] * (1 - fa)) / oa).concat(oa) : [0, 0, 0, 0];
            }
          }
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const o = (py * size + px) * 4;
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / (N * N)) * 255);
    }
  }
  return out;
}

const tile = (fill, r = 0.22) => ({ kind: 'rect', x: 0, y: 0, w: 1, h: 1, r, fill });
const grad = (a, b, from = [0, 0], to = [1, 1]) => ({ from, to, stops: [a, b] });

// Each site's icon, as shapes.
export const ICONS = {
  // Common Goods: a tote bag on sage.
  shop: [
    tile(grad('#3f6b4f', '#24432f')),
    { kind: 'ring', cx: 0.5, cy: 0.36, r: 0.12, width: 0.05, fill: '#f6efe1' },
    { kind: 'poly', points: [[0.25, 0.36], [0.75, 0.36], [0.8, 0.8], [0.2, 0.8]], fill: '#f6efe1' },
    { kind: 'poly', points: [[0.255, 0.42], [0.745, 0.42], [0.752, 0.48], [0.248, 0.48]], fill: '#d98c5f' },
    { kind: 'circle', cx: 0.38, cy: 0.36, r: 0.025, fill: '#24432f' },
    { kind: 'circle', cx: 0.62, cy: 0.36, r: 0.025, fill: '#24432f' },
  ],
  // Reel: a play mark.
  reel: [
    tile(grad('#ff4d5e', '#c3123a')),
    { kind: 'poly', points: [[0.38, 0.28], [0.38, 0.72], [0.75, 0.5]], fill: '#ffffff' },
  ],
  // Lattice docs: a page with lines, folded corner.
  docs: [
    tile(grad('#2f6df6', '#1b3fb8')),
    { kind: 'poly', points: [[0.28, 0.18], [0.6, 0.18], [0.74, 0.32], [0.74, 0.82], [0.28, 0.82]], fill: '#ffffff' },
    { kind: 'poly', points: [[0.6, 0.18], [0.74, 0.32], [0.6, 0.32]], fill: '#b9cdfd' },
    { kind: 'line', x1: 0.36, y1: 0.46, x2: 0.66, y2: 0.46, width: 0.055, fill: '#2f6df6' },
    { kind: 'line', x1: 0.36, y1: 0.58, x2: 0.66, y2: 0.58, width: 0.055, fill: '#9db7fb' },
    { kind: 'line', x1: 0.36, y1: 0.7, x2: 0.56, y2: 0.7, width: 0.055, fill: '#9db7fb' },
  ],
  // Metrics: bars, served only at /favicon.ico (the page links no icon).
  metrics: [
    tile(grad('#6d5efc', '#4433c9')),
    { kind: 'rect', x: 0.22, y: 0.52, w: 0.14, h: 0.26, r: 0.03, fill: '#c9c3ff' },
    { kind: 'rect', x: 0.43, y: 0.34, w: 0.14, h: 0.44, r: 0.03, fill: '#ffffff' },
    { kind: 'rect', x: 0.64, y: 0.22, w: 0.14, h: 0.56, r: 0.03, fill: '#7ef0c4' },
  ],
  // The Slow Report: an hourglass.
  slow: [
    tile(grad('#f2b33d', '#d9771f')),
    { kind: 'poly', points: [[0.3, 0.22], [0.7, 0.22], [0.52, 0.5], [0.7, 0.78], [0.3, 0.78], [0.48, 0.5]], fill: '#fff8e8' },
    { kind: 'poly', points: [[0.38, 0.7], [0.62, 0.7], [0.68, 0.78], [0.32, 0.78]], fill: '#8a4a12' },
    { kind: 'line', x1: 0.26, y1: 0.2, x2: 0.74, y2: 0.2, width: 0.06, fill: '#8a4a12' },
    { kind: 'line', x1: 0.26, y1: 0.8, x2: 0.74, y2: 0.8, width: 0.06, fill: '#8a4a12' },
  ],
  // Harbor: a wave under a sun.
  harbor: [
    tile(grad('#11808a', '#0b4d57')),
    { kind: 'circle', cx: 0.5, cy: 0.44, r: 0.2, fill: '#ffcf6e' },
    { kind: 'rect', x: 0, y: 0.56, w: 1, h: 0.44, r: 0.22, fill: '#0b4d57' },
    { kind: 'rect', x: 0, y: 0.56, w: 1, h: 0.2, r: 0, fill: '#0b4d57' },
    { kind: 'line', x1: 0.18, y1: 0.62, x2: 0.82, y2: 0.62, width: 0.06, fill: '#7fd6d1' },
    { kind: 'line', x1: 0.28, y1: 0.74, x2: 0.72, y2: 0.74, width: 0.06, fill: '#4fb3b2' },
  ],
  // Radio Field: rings around a dot.
  radio: [
    tile(grad('#2a1b3d', '#120b1c')),
    { kind: 'ring', cx: 0.5, cy: 0.5, r: 0.3, width: 0.06, fill: '#ff8a5b' },
    { kind: 'ring', cx: 0.5, cy: 0.5, r: 0.18, width: 0.06, fill: '#ffc36b' },
    { kind: 'circle', cx: 0.5, cy: 0.5, r: 0.07, fill: '#fff3e0' },
  ],
};

export function iconPng(name, size) {
  return encodePng(size, size, draw(size, ICONS[name]));
}

// ---------- the tune ----------
// About 24 s of a soft pad and a plucked line, 22.05 kHz mono, 16 bit.

export function tune() {
  const rate = 22050;
  const bpm = 92;
  const beat = 60 / bpm;
  const bars = 8;
  const seconds = bars * 4 * beat + 1.5;
  const n = Math.floor(seconds * rate);
  const s = new Float32Array(n);
  const freq = (m) => 440 * 2 ** ((m - 69) / 12);
  // C, A minor, F, G, twice.
  const chords = [[48, 55, 60, 64], [45, 52, 57, 60], [41, 48, 53, 57], [43, 50, 55, 59]];
  const add = (start, dur, f, amp, attack, decay, partials = [1]) => {
    const i0 = Math.floor(start * rate);
    const len = Math.floor((dur + decay) * rate);
    for (let i = 0; i < len && i0 + i < n; i++) {
      const t = i / rate;
      const env = t < attack ? t / attack : t < dur ? 1 : Math.exp(-(t - dur) / (decay / 4));
      let v = 0;
      partials.forEach((p, k) => (v += (p * Math.sin(2 * Math.PI * f * (k + 1) * t)) / (k + 1)));
      s[i0 + i] += v * env * amp;
    }
  };
  for (let bar = 0; bar < bars; bar++) {
    const chord = chords[bar % 4];
    const t0 = bar * 4 * beat;
    chord.forEach((m) => add(t0, 4 * beat - 0.2, freq(m), 0.05, 0.6, 1.2, [1, 0.3]));
    add(t0, beat * 2, freq(chord[0] - 12), 0.12, 0.02, 0.8, [1, 0.5, 0.2]);
    add(t0 + 2 * beat, beat * 2, freq(chord[1] - 12), 0.1, 0.02, 0.8, [1, 0.5, 0.2]);
    // The melody: a pentatonic line, the same each pass but the last note.
    const line = [72, 76, 79, 76, 74, 72, 69, bar % 2 ? 67 : 72];
    line.forEach((m, k) => add(t0 + k * (beat / 2), 0.05, freq(m), 0.09, 0.005, 0.9, [1, 0.4, 0.15, 0.05]));
  }
  const peak = s.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round((s[i] / peak) * 0.8 * 32767), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// ---------- all of it ----------

// Every raster file of the site: `${site}${path}` → { type, body }.
export function media() {
  const png = (name, size) => ({ type: 'image/png', body: iconPng(name, size) });
  const ico = (name, sizes) => ({ type: 'image/x-icon', body: encodeIco(sizes.map((size) => ({ size, bytes: iconPng(name, size) }))) });
  return new Map([
    ['shop/icon-192.png', png('shop', 192)],
    ['shop/apple-touch-icon.png', png('shop', 180)],
    ['reel/icon-32.png', png('reel', 32)],
    ['docs/favicon.ico', ico('docs', [16, 32, 48])],
    ['metrics/favicon.ico', ico('metrics', [16, 32])],
    ['slow/icon.png', png('slow', 64)],
    ['harbor/favicon.ico', ico('harbor', [16, 32])],
    ['harbor/icon-180.png', png('harbor', 180)],
    ['radio/favicon.ico', ico('radio', [16, 32, 64])],
    ['radio/tune.wav', { type: 'audio/wav', body: tune() }],
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: node make-media.mts <dir>');
  for (const [path, { body }] of media()) {
    const out = join(dir, path.replace('/', '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(out, body);
    console.log(`${out} ${body.length} bytes`);
  }
}
