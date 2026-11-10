// Reading and driving the overlay (the theme Margin draws, Arcadia by
// default) and the pages' box, for the e2e tests. Rows carry their ids as
// data-* (extension/themes/arcadia/theme.html).
import type { Page } from 'playwright';

/** The sidebar as drawn: tab rows, pins, folders, chips, the space's name. @param ui the overlay's page */
export function sidebar(ui: Page) {
  return ui.evaluate(() => {
    const q = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
    const has = (el: Element, c: string) => el.classList.contains(c);
    const icon = (el: Element) => {
      const img = el.querySelector<HTMLImageElement>('img.avatar');
      if (img) return { kind: 'image', src: img.getAttribute('src') ?? '', loaded: img.complete && img.naturalWidth > 0 };
      const letter = el.querySelector('.avatar.letter');
      return letter ? { kind: 'letter', letter: letter.textContent.trim() } : null;
    };
    return {
      space: document.querySelector('.space-title .title')?.textContent.trim() ?? null,
      tabs: q('a.tab').map((a) => ({ id: Number(a.dataset.tabId), key: a.dataset.tabId ?? '', title: a.querySelector('.title')?.textContent ?? '', active: has(a, 'active'), busy: has(a, 'busy'), asleep: has(a, 'asleep'), notOpen: has(a, 'not-open'), audible: !!a.querySelector('.audible-icon'), icon: icon(a) })),
      pins: q('a.pin').map((a) => ({ id: a.dataset.pinId, title: a.querySelector('.title')?.textContent ?? '', active: has(a, 'active'), open: has(a, 'open'), nested: has(a, 'nested'), icon: icon(a) })),
      folders: q('a.folder[data-folder-id]').map((a) => ({ id: a.dataset.folderId!, name: a.querySelector('.title')?.textContent ?? '', open: has(a, 'open') })),
      chips: q('.chip').map((c) => ({ id: c.dataset.spaceId, active: has(c, 'active'), label: c.getAttribute('aria-label') ?? '' })),
      newTabActive: !!document.querySelector('.new-tab-row.active'),
      palette: !!document.querySelector('.palette'),
      menu: q('.tab-menu .menu-item').map((b) => b.textContent.trim()),
      notice: document.querySelector('.notice .text')?.textContent ?? null,
      launcher: !!document.querySelector('.launcher'),
      editor: !!document.querySelector('.editor'),
      reconnecting: document.documentElement.hasAttribute('data-reconnecting'),
    };
  });
}

/**
 * Waits for the overlay's transitions and animations that end (a sidebar
 * sliding out, an edge moving) to finish, for a picture of where they land.
 * */
export function settled(ui: Page) {
  return ui.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
    .map((a) => a.finished.catch(() => {}))).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))));
}

/** The palette as drawn: its rows (id, title, section, selected), its field's text and focus. */
export function palette(ui: Page) {
  return ui.evaluate(() => {
    const field = document.querySelector<HTMLInputElement>('.palette .query');
    return {
      open: !!document.querySelector('.palette'),
      query: field?.value ?? null,
      focused: !!field && document.activeElement === field,
      // (`!`: the rows picked have a data-id.)
      rows: [...document.querySelectorAll<HTMLElement>('.palette .result[data-id]')].map((r) => ({ id: r.dataset.id!, title: r.querySelector('.title')?.textContent ?? '', section: r.getAttribute('aria-description') ?? '', selected: r.getAttribute('aria-selected') === 'true', badge: r.querySelector('.badge')?.textContent ?? null })),
    };
  });
}

/** Clicks a menu item by its words (the open menu). */
export async function menuItem(ui: Page, label: string|RegExp) {
  const item = ui.locator('.tab-menu .menu-item', { hasText: label }).first();
  await item.click();
}

/**
 * Where Margin put a page's box, in the window's points (the page's html moved
 * into the slot: content/page/box.ts), or null for no box.
 * @param page a site page
 */
export function pageBox(page: Page) {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const num = (name: string) => { const v = cs.getPropertyValue(name).trim(); return v ? parseFloat(v) : null; };
    const left = num('--margin-box-left');
    const dw = num('--margin-box-dw');
    if (left == null || dw == null) return null;
    const top = num('--margin-box-top') ?? 0;
    const dh = num('--margin-box-dh') ?? 0;
    if (dw === 0 && dh === 0) return null;
    return { left, top, right: Math.round((dw - left) * 2) / 2, bottom: Math.round((dh - top) * 2) / 2, width: innerWidth, height: innerHeight };
  });
}

/** The slot the overlay's theme left for the page (its <m-page>), in the window's points. */
export function slot(ui: Page) {
  return ui.evaluate(() => {
    const r = document.querySelector('m-page')?.getBoundingClientRect();
    return r ? { left: r.left, top: r.top, right: innerWidth - r.right, bottom: innerHeight - r.bottom } : null;
  });
}

/**
 * Drags one element of the overlay onto another with the pointer, in steps
 * (the theme's m-drag: ui/behaviors/drag.ts). `at`: where on the target, as
 * a fraction of its height (0.2: its upper part, 0.8: its lower part).
 * */
export async function drag(ui: Page, from: string, to: string, { at = 0.5, steps = 12 } = {}) {
  // (an element that isn't drawn fails here, on its null box)
  const a = (await ui.locator(from).first().boundingBox())!;
  const b = (await ui.locator(to).first().boundingBox())!;
  const x0 = a.x + Math.min(60, a.width / 2);
  const y0 = a.y + a.height / 2;
  const x1 = b.x + Math.min(60, b.width / 2);
  const y1 = b.y + b.height * at;
  await ui.mouse.move(x0, y0);
  await ui.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await ui.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
    await new Promise((r) => setTimeout(r, 16));
  }
  await new Promise((r) => setTimeout(r, 60));
  await ui.mouse.up();
}

/** The row of a tab (its selector): an open tab's number, or a not-open tab's own id (a string). */
export const tabRow = (id: number|string) => `a.tab[data-tab-id="${id}"]`;
/** A chip (its selector). */
export const chip = (id: string) => `.chip[data-space-id="${id}"]`;
/** A pin (its selector). */
export const pinRow = (id: string) => `a.pin[data-pin-id="${id}"]`;
/** A folder (its selector). */
export const folderRow = (id: string) => `a.folder[data-folder-id="${id}"]`;
