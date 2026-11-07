// Pictures for a person to look at, never compared: under
// $MARGIN_E2E_SHOTS/<file>-<test>/ (default $TMPDIR/margin-e2e-shots; never
// in the repo), for each point a test chose:
//   <label>-page.png     the browser tab in front of the window
//   <label>-overlay.png  the overlay, transparent where the theme draws nothing
//   <label>-window.png   the two together: what the window shows
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SHOTS = process.env.MARGIN_E2E_SHOTS || join(tmpdir(), 'margin-e2e-shots');

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

let composer = null;

/**
 * @param {any} m the file's world (margin.js)
 * @param {any} t the test (node:test's context: its name), or a string
 * @param {string} label
 * @param {{ windowId?: number, page?: any }} [options]
 */
export async function shoot(m, t, label, { windowId = m.shell.frontWindowId(), page = null } = {}) {
  const dir = join(SHOTS, `${slug(m.name)}-${slug(typeof t === 'string' ? t : t?.name ?? 'test')}`);
  mkdirSync(dir, { recursive: true });
  const base = join(dir, slug(label));
  const tab = await m.front(windowId);
  const front = page ?? (tab ? await m.pageOf(tab.id) : null);
  const overlay = m.shell.overlays.get(windowId)?.page ?? null;
  const pagePng = front ? await front.screenshot({ timeout: 5000 }).catch(() => null) : null;
  const overlayPng = overlay ? await overlay.screenshot({ omitBackground: true, timeout: 5000 }).catch(() => null) : null;
  if (pagePng) writeFileSync(`${base}-page.png`, pagePng);
  if (overlayPng) writeFileSync(`${base}-overlay.png`, overlayPng);
  if (pagePng && overlayPng) {
    composer ??= await m.webkit.newContext({ viewport: { width: 1440, height: 900 } }).then((c) => c.newPage());
    const png = await composer.evaluate(async ([a, b]) => {
      const load = (b64) => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = `data:image/png;base64,${b64}`; });
      const [under, over] = await Promise.all([load(a), load(b)]);
      const c = document.createElement('canvas');
      c.width = over.width;
      c.height = over.height;
      const g = c.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(under, 0, 0, c.width, c.height);
      g.drawImage(over, 0, 0);
      return c.toDataURL('image/png').split(',')[1];
    }, [pagePng.toString('base64'), overlayPng.toString('base64')]);
    writeFileSync(`${base}-window.png`, Buffer.from(png, 'base64'));
  }
  return { dir, page: !!pagePng, overlay: !!overlayPng };
}

/** The composer's page goes with its browser (margin.js closes WebKit). */
export function forgetComposer() { composer = null; }

/**
 * The colours of a few points of a screenshot ([r, g, b] each), read in the
 * composer's page (WebKit, outside Margin's browser).
 * @param {any} m @param {Buffer} png @param {Array<[number, number]>} points
 */
export async function pixels(m, png, points) {
  composer ??= await m.webkit.newContext({ viewport: { width: 1440, height: 900 } }).then((c) => c.newPage());
  return composer.evaluate(async ([b64, at]) => {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = `data:image/png;base64,${b64}`; });
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return at.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)]);
  }, [png.toString('base64'), points]);
}
