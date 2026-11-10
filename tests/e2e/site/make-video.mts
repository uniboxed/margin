// Makes files/reel/clip.webm, the video on reel.test: "Low Tide", six
// seconds of a sunset sea drawn on a canvas, frame by frame, in headless
// Chromium, then encoded to VP8 WebM by ffmpeg. Run it by hand after
// changing the drawing; the clip is committed.
//
//   node tests/e2e/site/make-video.mts
//
// ffmpeg: $FFMPEG, else the one Playwright installs with its browsers
// (it has the MJPEG decoder and libvpx encoder this needs), else `ffmpeg`.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const OUT = fileURLToPath(new URL('./files/reel/clip.webm', import.meta.url));
const W = 640;
const H = 360;
const FPS = 24;
const SECONDS = 6;

function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright'), '/opt/pw-browsers'].filter((r): r is string => !!r);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root).filter((d) => d.startsWith('ffmpeg')).sort().reverse()) {
      for (const name of ['ffmpeg-mac', 'ffmpeg-linux', 'ffmpeg']) {
        const p = join(root, dir, name);
        if (existsSync(p)) return p;
      }
    }
  }
  return 'ffmpeg';
}

// The drawing, run in the page: draw(t) for t in seconds.
const SCENE = `
const c = document.querySelector('canvas');
const g = c.getContext('2d');
const W = c.width, H = c.height;
let s = 7; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
const sparkles = Array.from({ length: 70 }, () => ({ x: r() * W, y: r(), w: 6 + r() * 30, p: r() * 6.28 }));
const clouds = Array.from({ length: 5 }, () => ({ x: r() * W, y: 30 + r() * 90, w: 80 + r() * 140, v: 4 + r() * 6 }));
window.draw = (t) => {
  const k = t / ${SECONDS};
  const horizon = H * 0.56;
  const sky = g.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, \`hsl(\${262 - k * 12} 45% \${30 - k * 8}%)\`);
  sky.addColorStop(0.55, \`hsl(\${338 - k * 10} 60% \${58 - k * 10}%)\`);
  sky.addColorStop(1, \`hsl(\${22 - k * 6} 95% \${70 - k * 8}%)\`);
  g.fillStyle = sky; g.fillRect(0, 0, W, horizon);
  const sunY = horizon - 70 + k * 78, sunX = W * 0.62;
  const glow = g.createRadialGradient(sunX, sunY, 4, sunX, sunY, 170);
  glow.addColorStop(0, 'rgba(255,236,190,0.95)'); glow.addColorStop(0.25, 'rgba(255,190,140,0.45)'); glow.addColorStop(1, 'rgba(255,160,120,0)');
  g.fillStyle = glow; g.fillRect(0, 0, W, horizon);
  g.save(); g.beginPath(); g.rect(0, 0, W, horizon); g.clip();
  g.fillStyle = '#fff4dc'; g.beginPath(); g.arc(sunX, sunY, 26, 0, Math.PI * 2); g.fill(); g.restore();
  for (const cl of clouds) {
    const x = ((cl.x + t * cl.v) % (W + 300)) - 150;
    g.fillStyle = 'rgba(255,220,210,0.22)';
    g.beginPath(); g.ellipse(x, cl.y, cl.w, 9, 0, 0, Math.PI * 2); g.fill();
  }
  const sea = g.createLinearGradient(0, horizon, 0, H);
  sea.addColorStop(0, \`hsl(\${340 - k * 10} 35% \${48 - k * 8}%)\`);
  sea.addColorStop(1, \`hsl(255 40% \${20 - k * 4}%)\`);
  g.fillStyle = sea; g.fillRect(0, horizon, W, H - horizon);
  g.fillStyle = 'rgba(255,230,190,0.18)'; g.fillRect(sunX - 30, horizon, 60, H - horizon);
  for (const sp of sparkles) {
    const y = horizon + 4 + Math.pow(sp.y, 1.7) * (H - horizon);
    const a = 0.15 + 0.35 * (0.5 + 0.5 * Math.sin(t * 3 + sp.p));
    const x = (sp.x + Math.sin(t * 0.8 + sp.p) * 12 + W) % W;
    g.fillStyle = \`rgba(255,240,220,\${a})\`;
    g.fillRect(x, y, sp.w * (0.6 + (y - horizon) / (H - horizon)), 1.5 + (y - horizon) / 90);
  }
  for (let i = 0; i < 3; i++) {
    g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) g.lineTo(x, H - 26 + i * 12 + Math.sin(x / (60 + i * 20) + t * (1.2 + i * 0.4)) * (5 + i * 2));
    g.lineTo(W, H); g.closePath();
    g.fillStyle = \`rgba(30,20,60,\${0.25 + i * 0.2})\`; g.fill();
  }
  g.fillStyle = '#2a1d3a';
  g.beginPath(); g.moveTo(0, horizon + 2); g.bezierCurveTo(60, horizon - 46, 130, horizon - 58, 210, horizon - 20); g.lineTo(240, horizon + 2); g.closePath(); g.fill();
  const bx = 120 + t * 28, by = horizon + 24 + Math.sin(t * 2.2) * 2.5, tilt = Math.sin(t * 2.2 + 1) * 0.05;
  g.save(); g.translate(bx, by); g.rotate(tilt);
  g.fillStyle = '#1b1430'; g.beginPath(); g.moveTo(-26, 0); g.lineTo(26, 0); g.lineTo(18, 9); g.lineTo(-18, 9); g.closePath(); g.fill();
  g.fillStyle = '#fff1e0'; g.beginPath(); g.moveTo(0, -3); g.lineTo(0, -58); g.lineTo(22, -5); g.closePath(); g.fill();
  g.fillStyle = '#f2c8a8'; g.beginPath(); g.moveTo(-3, -5); g.lineTo(-3, -44); g.lineTo(-20, -5); g.closePath(); g.fill();
  g.restore();
  g.strokeStyle = 'rgba(40,25,60,0.8)'; g.lineWidth = 2; g.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const x = 380 - t * 22 + i * 26, y = 70 + i * 14 + Math.sin(t * 2 + i) * 4, f = Math.sin(t * 9 + i * 2) * 5;
    g.beginPath(); g.moveTo(x - 8, y - f); g.quadraticCurveTo(x - 4, y - 4, x, y); g.quadraticCurveTo(x + 4, y - 4, x + 8, y - f); g.stroke();
  }
  const a = t < 0.6 ? 0 : t < 1.4 ? (t - 0.6) / 0.8 : t < 4.6 ? 1 : Math.max(0, 1 - (t - 4.6) / 0.8);
  g.fillStyle = \`rgba(255,248,235,\${a})\`;
  g.font = '700 30px -apple-system, system-ui, sans-serif';
  g.textAlign = 'center'; g.fillText('L O W   T I D E', W / 2, 52);
  g.font = '500 13px -apple-system, system-ui, sans-serif';
  g.fillStyle = \`rgba(255,248,235,\${a * 0.75})\`; g.fillText('a six-second film', W / 2, 74);
  const v = g.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.7);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = v; g.fillRect(0, 0, W, H);
  return c.toDataURL('image/jpeg', 0.92);
};`;

const browser = await chromium.launch({ headless: true, args: ['--headless=new'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.setContent(`<body style="margin:0;background:#000"><canvas width="${W}" height="${H}"></canvas><script>${SCENE}</script></body>`);
mkdirSync(join(OUT, '..'), { recursive: true });
const ffmpeg = spawn(findFfmpeg(), ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', 'pipe:0', '-c:v', 'libvpx', '-b:v', '420k', '-auto-alt-ref', '0', '-deadline', 'good', '-cpu-used', '1', '-pix_fmt', 'yuv420p', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise<void>((resolve, reject) => ffmpeg.on('close', (code) => (code ? reject(new Error(`ffmpeg exited ${code}`)) : resolve())));
for (let i = 0; i < FPS * SECONDS; i++) {
  const url = await page.evaluate((t: number) => (window as unknown as { draw: (t: number) => string }).draw(t), i / FPS);
  if (!ffmpeg.stdin.write(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))) await new Promise((r) => ffmpeg.stdin.once('drain', r));
}
ffmpeg.stdin.end();
await done;
await browser.close();
console.log(`${OUT} ${statSync(OUT).size} bytes`);
