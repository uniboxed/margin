// Margin.app's host adapter (PLAN.md §1, §2, §6): the same interface as the
// in-page host (ui/host.ts), for the UI runtime drawn in one of the app's
// overlays (app/shared/host/overlay.ts, in a WKWebView over one browser window).
// The page talks only to the app (webkit.messageHandlers.margin: `post`
// here), and the app to the extension copy over the link (docs/PROTOCOL.md):
//
// - the state is the app's copy of the copy's stored values (its mirror):
//   whole in the page's `hello`, then as the app passes changes on
//   (`receive`: state, changes, windows), kept here as the stored keys and
//   turned into the pages' shape with shared/stored.ts fromStorage;
// - requests (`send`) go to the app as { op: 'send' } and on to the copy as
//   a `req` for this window; the reply's { ok, result } comes back;
// - layout reports (`reportLayout`: where `<m-page>` sits) go to the app as
//   { op: 'layout' }: it sends them to the copy as `setLayout` for this
//   window, and lets the pointer through to the page over that slot, except
//   over what the theme draws there that takes the pointer (`hitRects`,
//   reported as { op: 'hits' });
// - Margin's new-tab page in front of the window (it draws nothing of its
//   own while the app is linked: newtab/newtab.ts): the theme's launcher is
//   drawn here, in the page slot, with its Settings (`launcher`, `inNewTab`
//   and `tabId` follow the window's tab in front), and an address chosen there
//   opens in that tab (`openHere`);
// - what only the app can do (`perform`): the window's own buttons. History
//   (nav.*) isn't the app's: the runtime falls back to the copy's goBack,
//   goForward and reload. A notice's button goes to the overlay's notices
//   (`onNotice`: ui/app-feedback.ts), which tell the copy (`noticeAction`);
// - which of the window's tabs are loading (the copy's `push` `loading`:
//   background/page-loads.ts): the tab's status, a page being left, a site's
//   own same-page navigation; drawn as each tab's `loading` (the view model);
// - why the last request failed (`takeFailure`), for the notice of a switch
//   that didn't happen;
// - installed apps: the app's list, in the hello (`apps`) and as
//   `{ type: 'apps' }` when it changes (app/platforms/macos/shell/ShellApps.swift), checked (shared/apps.ts appsOf)
//   and kept as the state's `apps` (the palette finds them: shared/search.ts); one picked is the app's to open
//   in the page area (`app.open`, its bundle id only);
// - Margin's own window (docs/MARGIN-APP.md phase 2, app/platforms/macos/shell/MarginWindowController.swift):
//   the hello's `host` is 'app-window' (`appWindow`): the UI is drawn in Margin's window, not over a
//   browser's, its mode the window's own (windowed or full screen, from `windows`); where the theme
//   draws the window's buttons and its drag regions go to the app (`chromeRects`, { op: 'chrome' }).
//   While the window hosts another app's window beside it (app/platforms/macos/shell/HostedSession.swift: Margin's
//   window is then only its sidebar's tile in its full-screen Space, the page area a window of its own), the hello's
//   `pageOutside` is true, and `{ type: 'pageOutside', on }` says when that changes: the UI is laid out with no page
//   area of its own (`pageOutside`: the sidebar always shown, docked, never hidden or out over a page that isn't here,
//   its width not dragged: Margin's tile can't change size while it's a tile). Each layout says whether it was
//   measured that way (`pageOutside`), and a layout of another mode is reported even when its insets didn't change
//   (the app waits for the full-screen one). With nothing hosted in it (no `pageOutside`), Margin's window draws its
//   page area itself: the theme's launcher, opaque (`launcher`), as Margin's new-tab page draws it over a browser.
//   A hosted app's window in Margin's page area (Margin's window its whole width, in front of it since 2026-11-17:
//   the hosted window shows through the page's place): the hello's `pageHosted` and `{ type: 'pageHosted', on }`:
//   laid out as usual (its own layout), its sidebar as the person keeps it (Keep open, or hidden and out over the
//   app's window from the left edge: Margin's window is in front of it, 2026-11-17; docked whatever it is until
//   2026-11-20, from when the hosted window sat above Margin's), and no launcher in the page area. The sidebar's width is dragged there as anywhere (only a tile's is fixed: `sidebarFixed`):
//   the app hears when a change of it begins and ends (`perform('sidebar.resizing', { on })`, behaviors/resize.ts)
//   and places the hosted window once, when it's over. The hosted window's own minimum width (the hello's
//   `pageMinWidth`, `{ type: 'pageMin', width }`; null: none) is where a drag's edge stops: the page area never
//   narrower than the window can be (`pageMinWidth`, behaviors/resize.ts), as Split View's divider stops. The page card's state comes with it: the hello's `pageState`
//   and `pageOpening`, and `{ type: 'pageState', state, label, bundleId }` (`pageState`: `shown`, the hosted window is
//   in place and the page's place draws nothing; `loading`, an item is being opened or placed again, `label` its name:
//   the card opaque with the loader, `bundleId` (the hello's `pageOpeningBundleId`) the app whose icon it shows, looked
//   up in `apps`; `empty`, nothing to show). The runtime puts it on the theme's root
//   (`m-page-state`, ui/runtime.ts).
//
// No browser API here: only the DOM and `post`.
import type { Geometry, Host } from './host.ts';
import { fromStorage } from '../shared/stored.ts';
import { isLauncherPage } from '../shared/view.ts';
import { appsOf, isBundleId } from '../shared/apps.ts';
import { capabilities } from '../shared/capabilities.ts';

/**
 * The stored values with a change applied, as storage.onChanged reports it
 * (`{ key: { newValue } }`, no newValue for a key removed), and site icons
 * as a diff (`favicons: { set, del }`). A new object; the old is untouched.
 */
export function applyChanges(raw: Record<string, any>, changes: Record<string, { newValue?: any }>, favicons: { set?: Record<string, any>, del?: string[] } | null = null) {
  const next = { ...raw };
  for (const [key, change] of Object.entries(changes ?? {})) {
    if (key === 'favicons') continue; // only as a diff
    if (change && typeof change === 'object' && 'newValue' in change) next[key] = change.newValue;
    else delete next[key];
  }
  if (favicons && (Object.keys(favicons.set ?? {}).length || (favicons.del ?? []).length)) {
    const icons = { ...(raw.favicons ?? {}), ...(favicons.set ?? {}) };
    for (const site of favicons.del ?? []) delete icons[site];
    next.favicons = icons;
  }
  return next;
}

/**
 * Whether the sidebar's width is fixed (the theme's root marked `m-sidebar-fixed`, its handle hidden: ui/render.ts):
 * only while Margin's window is a tile beside a hosted one (`pageOutside`: a tile can't change size). Under a hosted
 * window in its page area (`pageHosted`) it's dragged as anywhere.
 */
export const sidebarFixed = (host: { pageOutside?: boolean } | null | undefined) => !!host?.pageOutside;

/** The mode a window's UI is drawn in, from its state (windows.get). */
export const modeOf = (w: any) => (w?.state === 'fullscreen' ? 'fullscreen' : 'windowed');
// A page's picture for the card (`pagePicture`) at most this long: the copy's is ~0.2–0.6 MB (1600 px wide, JPEG).
const PICTURE_MAX = 8 * 1024 * 1024;

/** The computed style `hitRects` reads (only the first two are needed: a missing one is its initial value). */
export type HitStyle = {
  pointerEvents: string, visibility: string, position?: string, overflowX?: string, overflowY?: string, contain?: string,
  transform?: string, translate?: string, rotate?: string, scale?: string, perspective?: string, filter?: string,
  backdropFilter?: string, containerType?: string, willChange?: string,
};

/**
 * What the theme draws over the page slot that takes the pointer: the boxes
 * of its elements (not the root, not `<m-page>`) that overlap the slot and
 * whose `pointer-events` isn't `none`, with the root passing the pointer
 * through as the in-page host's does (`m-passthrough`: its children keep
 * theirs). Each box only as far as its ancestors show it (an ancestor whose
 * `overflow` or paint containment clips, each axis apart, as CSS has it: a
 * box positioned `absolute` or `fixed` escapes the ancestors inside its
 * containing block, so a menu spilling out of the sidebar still counts): a space's list slid sideways by a
 * swipe under the page area, clipped by the sidebar, is nothing there
 * (2026-11-20: its rows counted, over 64 of them, and Margin.app covered the
 * hosted page with its own card and the sidebar's shadow for the whole
 * swipe). Boxes inside another are left out. `all`: more than `limit`
 * (the app then takes the whole window, never letting the page miss one).
 * `keepEqual`: of nested boxes with the same bounds (Arcadia's palette layer and its backdrop, over the whole
 * window) the first is kept, and what's inside it goes (Margin's own window: its palette takes the pointer).
 * Without it each counts as inside the other and all of them go, the palette with them: over a browser's
 * window a press on the page then still reaches the page, and closes the palette (the overlay's behaviour).
 * @param root the theme's root
 * @param slot in the container's pixels
 * [x, y, width, height] each
 */
export function hitRects(root: Element, slot: { left: number, top: number, right: number, bottom: number }, { limit = 64, keepEqual = false, getStyle = (el) => (el.ownerDocument.defaultView as any).getComputedStyle(el) }: { limit?: number, keepEqual?: boolean, getStyle?: (el: Element) => HitStyle } = {}): { rects: number[][], all: boolean } {
  type Box = { left: number, top: number, right: number, bottom: number, width: number, height: number };
  type Clip = Box | null; // null: nothing clips
  // The clips that apply to an element's children: in flow, positioned `absolute` (its containing block's), `fixed`.
  type Clips = { flow: () => Clip, abs: () => Clip, fixed: () => Clip };
  const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) });
  const meet = (a: Clip, b: Clip): Clip => !a ? b : !b ? a : box(Math.max(a.left, b.left), Math.max(a.top, b.top), Math.min(a.right, b.right), Math.min(a.bottom, b.bottom));
  const once = <T,>(f: () => T): (() => T) => { let done = false, v: T; return () => (done ? v : (done = true, v = f())); };
  const clipsAxis = (v?: string) => v === 'hidden' || v === 'clip' || v === 'scroll' || v === 'auto';
  const set = (v?: string) => !!v && v !== 'none' && v !== 'normal' && v !== 'auto';
  // A containing block for fixed (and absolute) descendants: a transform, filter, perspective, layout or paint containment.
  const holdsFixed = (st: HitStyle) => set(st.transform) || set(st.translate) || set(st.rotate) || set(st.scale) || set(st.perspective)
    || set(st.filter) || set(st.backdropFilter) || /layout|paint|strict|content/.test(st.contain || '')
    || set(st.containerType) || /transform|perspective|filter|translate|rotate|scale/.test(st.willChange || '');
  const ownClip = (el: Element, st: HitStyle): Clip => {
    const paint = /paint|strict|content/.test(st.contain || '');
    const x = paint || clipsAxis(st.overflowX), y = paint || clipsAxis(st.overflowY);
    if (!x && !y) return null;
    const r = el.getBoundingClientRect();
    return box(x ? r.left : -Infinity, y ? r.top : -Infinity, x ? r.right : Infinity, y ? r.bottom : Infinity);
  };
  const none: Clips = { flow: () => null, abs: () => null, fixed: () => null };
  // Everything worked out only when a box overlaps the slot, each element's style read once.
  const clipsOf = (el: Element, st: () => HitStyle, up: Clips): { mine: () => Clip, inner: Clips } => {
    const mine = once(() => { const p = st().position; return p === 'absolute' ? up.abs() : p === 'fixed' ? up.fixed() : up.flow(); });
    const flow = once(() => meet(mine(), ownClip(el, st())));
    const fixedHere = once(() => holdsFixed(st()));
    return {
      mine,
      inner: {
        flow,
        abs: once(() => (fixedHere() || (!!st().position && st().position !== 'static') ? flow() : up.abs())),
        fixed: once(() => (fixedHere() ? flow() : up.fixed())),
      },
    };
  };
  const found: Box[] = [];
  const walk = (el: Element, up: Clips) => {
    for (const child of (el.children as any) as Element[]) {
      if (child.localName === 'm-page' || child.localName === 'template') continue;
      const st = once(() => getStyle(child));
      const c = clipsOf(child, st, up);
      const b = child.getBoundingClientRect();
      if (b.width > 0 && b.height > 0 && b.left < slot.right && b.right > slot.left && b.top < slot.bottom && b.bottom > slot.top) {
        const cut = c.mine();
        const r = cut ? meet(b, cut)! : b;
        if (r.width > 0 && r.height > 0 && r.left < slot.right && r.right > slot.left && r.top < slot.bottom && r.bottom > slot.top) {
          const style = st();
          if (style.pointerEvents !== 'none' && style.visibility !== 'hidden') found.push(r);
        }
      }
      walk(child, c.inner);
    }
  };
  walk(root, none);
  const inside = (a: Box, b: Box) => a !== b && a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
  const same = (a: Box, b: Box) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
  const kept = keepEqual
    ? found.filter((r, i) => !found.some((o, j) => j !== i && (same(r, o) ? j < i : inside(r, o))))
    : found.filter((r, i) => !found.some((o, j) => inside(r, o) || (j < i && same(o, r))));
  if (kept.length > limit) return { rects: [], all: true };
  return { rects: kept.map((r) => [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2) / 2)), all: false };
}

// A computed colour that draws something (not transparent, nor alpha 0).
const drawn = (c: unknown): c is string => typeof c === 'string' && c.trim() !== '' && c.trim() !== 'transparent'
  && !/^rgba\([^)]*,\s*0(\.0+)?\s*\)$/.test(c.trim()) && !/\/\s*0(\.0+)?\s*\)$/.test(c.trim());

/** One computed box-shadow list split at its top-level commas (a colour's own commas kept). */
export function splitShadows(value: string): string[] {
  const out: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) { out.push(value.slice(from, i).trim()); from = i + 1; }
  }
  const last = value.slice(from).trim();
  if (last) out.push(last);
  return out;
}

/**
 * What the theme draws around `<m-page>`'s rounded corners, for Margin's own window: the ground Margin.app puts under
 * the page area (around a hosted window, in any gap it leaves, under the loader) is the colour most corners have
 * (app/platforms/macos/shell/MarginWindowController.swift `pageGround`). `fills`, each corner's colour outside the card
 * (top left, clockwise), and `edge`, the card's border (width and colour) when it has one. A corner's fill is the colour at the
 * page area's corner point (outside the card's own rounded edge; inside it, its border or what's behind it): of the
 * card's sharp box shadows (no blur, not inset) the first that covers it, as they're painted (a frame drawn as a spread: Arcadia's, Pixel's; Neubrutalism's offset ink shadow at its bottom right), else
 * the nearest background an ancestor draws. A blurred shadow is left out (Arcadia's soft card shadow: a few levels
 * darker there on screen). Null: nothing found (the app's window colour is used). Computed styles only: no pixel read.
 * */
export function cornerFill(el: Element | null | undefined, { getStyle = (e: Element) => (e.ownerDocument.defaultView as any).getComputedStyle(e), getBox = (e: Element) => e.getBoundingClientRect() }: { getStyle?: (e: Element) => any, getBox?: (e: Element) => { width: number, height: number } } = {}): { fills: (string | null)[], edge: { width: number, color: string } | null } | null {
  if (!el) return null;
  const cs = getStyle(el);
  const px = (v: unknown) => parseFloat(String(v ?? '')) || 0;
  const width = px(cs.borderTopWidth);
  const edge = width > 0 && cs.borderTopStyle !== 'none' && cs.borderTopStyle !== 'hidden' && drawn(cs.borderTopColor) ? { width: Math.round(width * 100) / 100, color: String(cs.borderTopColor).trim() } : null;
  const { width: w, height: h } = getBox(el);
  const radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => px(String(v ?? '0').split(' ')[0]));
  const inL = px(cs.borderLeftWidth) + px(cs.paddingLeft), inT = px(cs.borderTopWidth) + px(cs.paddingTop);
  const inR = px(cs.borderRightWidth) + px(cs.paddingRight), inB = px(cs.borderBottomWidth) + px(cs.paddingBottom);
  // Each corner's point of the page area, half a pixel in (the border box's own coordinates).
  const points = [[inL + 0.5, inT + 0.5], [w - inR - 0.5, inT + 0.5], [w - inR - 0.5, h - inB - 0.5], [inL + 0.5, h - inB - 0.5]];
  // The sharp shadows, first painted on top.
  const shadows: { x: number, y: number, spread: number, color: string }[] = [];
  for (const shadow of splitShadows(String(cs.boxShadow ?? ''))) {
    if (shadow === 'none' || /\binset\b/.test(shadow)) continue;
    const color = /(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8}\b)/i.exec(shadow)?.[1];
    const lengths = shadow.replace(/(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8}\b)/ig, ' ').trim().split(/\s+/).filter(Boolean).map((v) => parseFloat(v));
    if (!color || !drawn(color) || lengths.length < 2 || lengths.some((v) => !Number.isFinite(v))) continue;
    const [x, y, blur = 0, spread = 0] = lengths;
    if (blur === 0) shadows.push({ x, y, spread, color });
  }
  // Whether a shadow (the border box moved and grown by its spread, its corners rounded the same, grown too) covers p.
  const covers = (s: { x: number, y: number, spread: number }, [px0, py0]: number[]) => {
    const left = s.x - s.spread, top = s.y - s.spread, right = w + s.x + s.spread, bottom = h + s.y + s.spread;
    if (px0 < left || px0 > right || py0 < top || py0 > bottom) return false;
    const corner = [[left, top, 1, 1], [right, top, -1, 1], [right, bottom, -1, -1], [left, bottom, 1, -1]];
    for (const [i, [cx, cy, dx, dy]] of corner.entries()) {
      const r = radii[i] > 0 ? radii[i] + s.spread : 0;
      if (r <= 0) continue;
      const ox = cx + dx * r, oy = cy + dy * r; // the curve's centre
      if ((px0 - ox) * dx < 0 && (py0 - oy) * dy < 0 && Math.hypot(px0 - ox, py0 - oy) > r) return false;
    }
    return true;
  };
  let background: string | null = null;
  for (let up = el.parentElement; !background && up; up = up.parentElement) {
    const bg = getStyle(up).backgroundColor;
    if (drawn(bg)) background = String(bg).trim();
  }
  // (A point inside the card itself: no shadow is painted under a box; its border there, else what's behind it.)
  const fills = points.map((p) => covers({ x: 0, y: 0, spread: 0 }, p) ? edge?.color ?? background : shadows.find((s) => covers(s, p))?.color.trim() ?? background);
  return fills.some(Boolean) || edge ? { fills, edge } : null;
}

/**
 * Where the theme draws the window's buttons (`<m-window-controls>`, the first one with a box) and
 * where a drag moves the window (`<m-drag-region>`), in the container's pixels: for Margin's own
 * window, whose traffic lights go there and which moves by those regions. null / []: none drawn.
 * [x, y, width, height] each, to the half pixel.
 * */
export function chromeRects(root: Element | null): { controls: number[] | null, drags: number[][] } {
  const box = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2) / 2) : null; };
  if (!root) return { controls: null, drags: [] };
  const controls = [...root.querySelectorAll('m-window-controls')].map(box).find((r) => r) ?? null;
  const drags = [...root.querySelectorAll('m-drag-region')].map(box).filter((r): r is number[] => !!r).slice(0, 32);
  return { controls, drags };
}

/**
 * The app's host for one window's overlay.
 *
 * `hello`: what the app answered the page's { op: 'hello' }: the window
 * (`windowId`), the copy (`profile`, `browser`), `mode`, `platform`, the
 * stored values (`state`, null before the first snapshot), the copy's
 * window list (`windows`) and the theme package (`theme`). `post(op, body)`:
 * a message to the app, resolving with its reply (webkit.messageHandlers
 * .margin.postMessage). `onMessage(msg)`: what the app sends that isn't the
 * state (theme, command, pointer, pressOutside, blur, shown, push), for the page.
 * `onNotice({ id, action })`: a button of a notice the overlay put up.
 * */
export function createAppHost({ hello, post, onMessage = () => {}, onNotice = () => {}, warn = (...args) => console.warn('[margin]', ...args) }: {
  hello: any,
  post: (op: string, body?: Record<string, any>) => Promise<any>,
  onMessage?: (msg: any) => void,
  onNotice?: (arg: { id?: string, action?: string }) => void,
  warn?: (...args: any[]) => void,
}): Host & { readonly platform: Host['platform'] & { app: boolean, features: Record<string, any> }, readonly appWindow: boolean, readonly pageOutside: boolean, readonly pageHosted: boolean, readonly marginPage: 'settings' | null, readonly pageMinWidth: number, readonly pageStuck: string | null, readonly sidebarDocked: boolean, perform(name: string, arg?: any): boolean | undefined, staysOnScreen: boolean, receive(msg: any): void, readonly windows: any[], readonly layout: Geometry | null, readonly settingsAsked: boolean, readonly pageTabId: number | null, readonly frontTabId: number | null, readonly loading: number[], readonly userThemes: any[], takeFailure(): { type: string, error: string } | null, destroy(): void } {
  const windowId = Number.isInteger(hello?.windowId) ? hello.windowId : null;
  let raw: Record<string, any> | null = hello?.state && typeof hello.state === 'object' ? hello.state : null;
  let state: any = null;
  let windows = Array.isArray(hello?.windows) ? hello.windows : [];
  let mode = hello?.mode === 'windowed' ? 'windowed' : 'fullscreen';
  // Drawn in Margin's own window (its hello's `host`), not over a browser's: never changes for a page.
  const appWindow = hello?.host === 'app-window';
  // Margin's window hosting another app's window beside it: no page area of its own (only in Margin's own window).
  let pageOutside = appWindow && hello?.pageOutside === true;
  // A hosted app's window in the page area: no launcher there.
  let pageHosted = appWindow && hello?.pageHosted === true;
  // One of Margin's own pages in the page area while nothing's hosted there (Settings: its tab, margin://settings,
  // HostedSession.swift ItemTarget.margin), null: the launcher.
  const marginPageOf = (v: unknown) => (appWindow && v === 'settings' ? v : null);
  let marginPage: 'settings' | null = marginPageOf(hello?.marginPage);
  // The hosted window's own minimum width (Margin's points; 0: none): a drag of the sidebar's edge stops there.
  const minOf = (v: unknown) => (appWindow && typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.ceil(v) : 0);
  let pageMinWidth = minOf(hello?.pageMinWidth);
  // The page card's state (Margin's own window only), and the name of what's opening while it's `loading`.
  const pageStateOf = (v: unknown) => (v === 'shown' || v === 'loading' || v === 'elsewhere' ? v : 'empty');
  // (Its item's name and app said while it opens, and while it's in another Margin window: its card.)
  const named = (s: string) => s === 'loading' || s === 'elsewhere';
  const nameOf = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 120) : null);
  let pageState: 'empty' | 'loading' | 'shown' | 'elsewhere' = pageStateOf(hello?.pageState);
  let pageOpening: string | null = named(pageState) ? nameOf(hello?.pageOpening) : null;
  let pageOpeningBundleId: string | null = named(pageState) && isBundleId(hello?.pageOpeningBundleId) ? hello.pageOpeningBundleId : null;
  // Margin's start (its default browser starting first): the loader's own words, "Getting you started…".
  let pageStarting = pageState === 'loading' && hello?.pageStarting === true;
  // ...held up (the browser not ready within the app's limit, or its extension didn't connect): what's wrong, in the
  // app's words; the start screen's Try again and Continue without Safari meanwhile (ui/runtime.ts followStartup).
  const stuckOf = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 300) : null);
  let pageStuck: string | null = pageStarting ? stuckOf(hello?.pageStuck) : null;
  // Its item's page as Safari last showed it (a web item in another Margin window): only a picture's data URL, kept
  // while the card shows (the app sends null as it goes), never stored.
  const pictureOf = (v: unknown) => (typeof v === 'string' && v.length <= PICTURE_MAX && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : null);
  let pagePicture: string | null = pageState === 'elsewhere' ? pictureOf(hello?.pagePicture) : null;
  // Installed apps, as the app read them (null: none read yet).
  let apps = appsOf(hello?.apps);
  let layout: Geometry | null = null;
  let destroyed = false;
  const listeners = new Set<any>();
  // What Settings offers for this browser (ui/settings-form.ts): the build's
  // capabilities (scripts/build.ts builds the overlay with Safari's), as the new-tab
  // page gave them when Settings were drawn there.
  const platform = {
    browser: String(hello?.platform?.browser ?? hello?.browser ?? 'safari'),
    // The app's OS as its hello says it (Margin.app: mac; Margin for Windows: win), the Mac's when it says none.
    os: hello?.platform?.os === 'win' ? 'win' : 'mac', app: true,
    features: { sleepTabs: capabilities?.sleepTabs ?? false, blockGestures: !!capabilities?.blockGestures, marginFullscreen: false, newTabHint: !!capabilities?.newTabHint, search: capabilities?.search },
  };
  // Themes: Margin.app imports them (its file picker), and keeps the index (`themes`: docs/PROTOCOL.md "User themes").
   (platform.features as any).importThemes = true;
   (platform.features as any).userThemes = Array.isArray(hello?.themes) ? hello.themes : [];
  // A theme per space (2026-11-20): Margin.app's own window draws each space's (its app picks the package by the space
  // the window shows); a browser's overlay draws its profile's, so it doesn't offer them (ui/space-theme.ts).
  (platform.features as any).spaceThemes = appWindow;
  // The window's tabs loading, as the copy last said (`push` `loading`).
  let loading: Set<number> = new Set();
  let failure: { type: string, error: string, at: number } | null = null;

  const rebuild = () => {
    const next = raw ? fromStorage(raw) : null;
    let built = next?.spaces?.length ? next : null;
    if (built && apps) built = { ...built, apps };
    if (built && loading.size && built.tabs) {
      const tabs = { ...built.tabs };
      for (const id of loading) if (tabs[id]) tabs[id] = { ...tabs[id], loading: true };
      built = { ...built, tabs };
    }
    state = built;
  };
  const emit = () => { if (state && !destroyed) for (const cb of [...listeners]) cb(state); };
  rebuild();
  // The window's tab in front, if it's Margin's new-tab page (its launcher is drawn here then).
  const frontPage = () => {
    const own = windows.find((w: { windowId?: number, id?: number } | null) => (w?.windowId ?? w?.id) === windowId);
    const id = own?.activeTabId ?? Object.values((state?.tabs ?? {}) as Record<string, { id: number, windowId: number, active?: boolean } | null>).find((t) => t?.windowId === windowId && t?.active)?.id;
    const tab = id != null ? state?.tabs?.[id] : null;
    return tab && isLauncherPage(tab.url) ? { id: tab.id, url: String(tab.url) } : null;
  };
  const pageKey = () => JSON.stringify(frontPage());

  async function send(type: string, payload: Record<string, any> = {}): Promise<any> {
    if (destroyed) return undefined;
    // An archived tab restored from the launcher takes the new-tab page's place (as there).
    const page = type === 'restoreArchive' ? frontPage() : null;
    if (page && payload.replaceTabId == null) payload = { ...payload, replaceTabId: page.id };
    // A request naming a tab carries its address and place (as the in-page
    // host's does): the copy trusts the id only if it's its own.
    if (Number.isInteger(payload.tabId) && !payload.hint) {
      const tab = state?.tabs?.[payload.tabId];
      if (tab) payload = { ...payload, hint: { url: tab.url, index: tab.index, title: tab.title, from: state?.openTabsBy ?? null } };
    }
    try {
      const text = await post('send', { type, payload });
      const res = typeof text === 'string' ? JSON.parse(text) : text;
      if (res?.ok) return res.result;
      if (res && !res.stale) warn(type, res.error);
      failure = res && !res.stale ? { type, error: String(res.error ?? ''), at: Date.now() } : null;
      return undefined;
    } catch (err) {
      const error = String((err as any)?.message ?? err);
      warn(type, error);
      failure = { type, error, at: Date.now() };
      return undefined;
    }
  }

  return {
    platform,
    get windowId() { return windowId; },
    get appWindow() { return appWindow; },
    /** The page area is another window's, beside Margin's (Margin's own window hosting): the sidebar alone here. */
    get pageOutside() { return pageOutside; },
    /** The page area is a hosted app's window, under Margin's: no launcher there. */
    get pageHosted() { return pageHosted; },
    /** Margin's own page in the page area (Settings), null: the launcher. Hosting covers it, as it covers the launcher. */
    get marginPage() { return marginPage; },
    /** The hosted window's own minimum width (0: none): the page area is never dragged narrower (behaviors/resize.ts). */
    get pageMinWidth() { return pageMinWidth; },
    /** The page card's state (Margin's own window; undefined over a browser: its page is always there). */
    get pageState() { return appWindow ? pageState : undefined; },
    get pageOpening() { return pageOpening; },
    get pageOpeningBundleId() { return pageOpeningBundleId; },
    get pageStarting() { return pageStarting; },
    get pageStuck() { return pageStarting ? pageStuck : null; },
    get pagePicture() { return pageState === 'elsewhere' ? pagePicture : null; },
    /**
     * The sidebar kept docked whatever its setting: only beside another app's window (`pageOutside`: Margin's window is
     * the sidebar alone then). An app's window in the page area (`pageHosted`) leaves it as the person keeps it: hidden,
     * it comes out over that window from the left edge (Margin's window is in front of it), and its page area is the
     * frame's (Tirth, 2026-11-20).
     */
    get sidebarDocked() { return pageOutside; },
    // The overlay stays on screen through a switch (ui/runtime.ts: the highlight waits for the state).
    staysOnScreen: true,
    // Not on screen as it first draws: its launcher takes the focus only when the app says (the `shown` push's `focus`).
    focusLauncherAtMount: false,
    get tabId() { return frontPage()?.id ?? null; },
    get mode() { return (mode as 'fullscreen' | 'windowed'); },
    // Margin's start page (#launcher, #settings) chooses a new tab; a new-tab page opens it there.
    get inNewTab() { const p = frontPage(); return !!p && !/#(launcher|settings)\b/.test(p.url); },
    // Margin's own window with nothing hosted beside it: its page area is the launcher (never a see-through hole).
    get launcher() { return appWindow ? !pageOutside && !pageHosted : !!frontPage(); },
    // Its Settings asked for: Margin's window's Settings tab (margin://settings) in its page area; over a browser, the
    // new-tab page's #settings (a Settings button elsewhere).
    get settingsAsked() { return appWindow ? marginPage === 'settings' && !pageOutside && !pageHosted : !!frontPage()?.url.includes('#settings'); },
    get pageTabId() { return frontPage()?.id ?? null; },
    // The window's tab in front, Margin's new-tab page or not.
    get frontTabId() {
      const own = windows.find((w: { windowId?: number, id?: number } | null) => (w?.windowId ?? w?.id) === windowId);
      const id = own?.activeTabId ?? Object.values((state?.tabs ?? {}) as Record<string, { id: number, windowId: number, active?: boolean } | null>).find((t) => t?.windowId === windowId && t?.active)?.id;
      return Number.isInteger(id) ? id : null;
    },
    get loading() { return [...loading]; },
    // Why the last request failed, if it failed in the last 2 s (taken once).
    takeFailure() {
      const f = failure;
      failure = null;
      return f && Date.now() - f.at < 2000 ? { type: f.type, error: f.error } : null;
    },
    getState: () => state,
    onState(cb: (state: any) => void) { listeners.add(cb); return () => listeners.delete(cb); },
    send,
    reportLayout(geometry: Geometry) {
      // Twice for one change (the runtime's own frame, and the page's measure after it): once. Its mode and whether it
      // was measured with the sidebar alone count too (seen 2026-11-15: the window's full-screen layout, at the size
      // the windowed one was already measured at, never reached the app).
      // What the theme draws around the page's corners (`fills`: the page's own measure adds them,
      // app/shared/host/overlay.ts measureNow) stays as last said when a report doesn't say it (the runtime's own
      // frame measures the box only: a width being dragged reports from there, and the ground under the page area
      // would lose its colour until the next measure).
      const kept = appWindow && geometry.fills === undefined && layout?.fills ? { fills: layout.fills } : {};
      // (Whether it was measured hosting, too: the app places a hosted window only by a layout its page drew for hosting,
      // never the launcher's from before, whose sidebar is always docked: 2026-11-20, a hidden sidebar's page area.)
      const next = { ...geometry, ...kept, mode: geometry.mode ?? mode, pageOutside, pageHosted };
      const key = (g: any) => JSON.stringify([g.insets, g.radius, g.radii ?? null, g.container, g.mode ?? null, !!g.pageOutside, !!g.pageHosted, g.fills ?? null]);
      if (layout && key(layout) === key(next)) return;
      layout = next;
      void post('layout', { geometry: next }).catch(() => {});
    },
    get layout() { return layout; },
    get windows() { return windows; },
    /** Margin.app's index of imported themes. */
    get userThemes() { return (platform.features as any).userThemes; },
    perform(name: string, arg: any) {
      switch (name) {
        case 'navigate': {
          // An address chosen in the launcher or palette over Margin's new-tab page: opened in that tab.
          const page = frontPage();
          if (!page || typeof arg?.url !== 'string') return false;
          void send('openHere', { tabId: page.id, url: arg.url });
          return true;
        }
        case 'window.fullscreen':
          void post('perform', { name, arg: arg ?? null }).catch(() => {});
          return true;
        case 'copyUrl':
          if (typeof arg?.url !== 'string' || !arg.url) return false;
          void post('perform', { name, arg: { url: arg.url } }).catch(() => {});
          return true;
        // Peek's card and Little Arc (ui/behaviors/card.ts; app/platforms/macos/shell/HostedPeek.swift): only Margin's
        // own window has one. Close, back and forward say nothing more; Expand its space; Little Arc's field its
        // address or search (`peek.go`), and that it's open (`peek.littleArc`: ⌘W and Esc are the card's then).
        case 'peek.close':
        case 'peek.back':
        case 'peek.forward':
          if (!appWindow) return false;
          void post('perform', { name, arg: {} }).catch(() => {});
          return true;
        case 'peek.expand':
        case 'peek.littleArc':
          if (!appWindow) return false;
          void post('perform', { name, arg: { spaceId: typeof arg?.spaceId === 'string' ? arg.spaceId : null } }).catch(() => {});
          return true;
        case 'peek.go': {
          if (!appWindow) return false;
          const url = typeof arg?.url === 'string' && /^https?:\/\//i.test(arg.url) && arg.url.length <= 2048 ? arg.url : null;
          const query = typeof arg?.query === 'string' && arg.query.trim() ? arg.query.trim().slice(0, 1000) : null;
          if (!url && !query) return false;
          void post('perform', { name, arg: { ...(url ? { url } : { query }), spaceId: typeof arg?.spaceId === 'string' ? arg.spaceId : null } }).catch(() => {});
          return true;
        }
        // Themes (app/platforms/macos/shell/ShellThemes.swift): the file picker; a checked theme kept; one removed.
        case 'theme.import':
          void post('perform', { name, arg: null }).catch(() => {});
          return true;
        case 'theme.save':
          if (!arg?.value || typeof arg.value !== 'object') return false;
          void post('perform', { name, arg: { value: arg.value } }).catch(() => {});
          return true;
        // The start screen's choices while Margin's start is held up (HostedSession.swift startupRetry, startupSkip).
        case 'startup.retry':
        case 'startup.skip':
          if (!appWindow || !pageStarting) return false;
          void post('perform', { name }).catch(() => {});
          return true;
        // An installed app picked in the palette (app/platforms/macos/shell/ShellApps.swift): opened in the page area.
        case 'app.open':
          if (!isBundleId(arg?.bundleId)) return false;
          void post('perform', { name, arg: { bundleId: arg.bundleId } }).catch(() => {});
          return true;
        case 'notice':
          // The runtime closed it; the overlay's notices tell the copy what was chosen.
          onNotice(arg ?? {});
          return true;
        // The sidebar's width being dragged, or let go (behaviors/resize.ts): Margin's own window holds a hosted
        // window's placing until it's over (app/platforms/macos/shell/HostedSession.swift sidebarResizing).
        case 'sidebar.resizing':
          if (!appWindow || typeof arg?.on !== 'boolean') return false;
          void post('perform', { name, arg: { on: arg.on } }).catch(() => {});
          return true;
        // A space swipe's detent (behaviors/swipe.ts, Arc's feel): the trackpad's alignment tick, as Arc gives it.
        case 'haptic.alignment':
          if (!appWindow) return false;
          void post('perform', { name }).catch(() => {});
          return true;
        case 'prompt': {
          // The runtime closes it. Settings' Remove asked first (ui/settings-form.ts removePrompt): removed only on Remove.
          const m = /^remove-theme:([a-z0-9][a-z0-9-]{0,40})$/.exec(String(arg?.id ?? ''));
          if (m && arg?.action === 'remove') void post('perform', { name: 'theme.remove', arg: { id: m[1] } }).catch(() => {});
          return true;
        }
        default:
          return false; // history goes to the copy (goBack, goForward, reload); the window's other buttons are Phase 4's
      }
    },
    /** What the app passes on (app/platforms/macos/shell/MarginWindowController.swift push). */
    receive(msg: any) {
      if (destroyed || !msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'state':
          raw = msg.state && typeof msg.state === 'object' ? msg.state : null;
          if (Array.isArray(msg.windows)) windows = msg.windows;
          rebuild();
          return emit();
        case 'changes':
          if (!raw) return;
          raw = applyChanges(raw, msg.changes, msg.favicons);
          rebuild();
          return emit();
        case 'apps':
          apps = appsOf(msg.apps);
          rebuild();
          return emit();
        case 'pageOutside': {
          const next = appWindow && msg.on === true;
          if (next === pageOutside) return;
          pageOutside = next;
          return emit();
        }
        case 'pageHosted': {
          const next = appWindow && msg.on === true;
          if (next === pageHosted) return;
          pageHosted = next;
          return emit();
        }
        case 'marginPage': {
          const next = marginPageOf(msg.page);
          if (next === marginPage) return;
          marginPage = next;
          return emit();
        }
        case 'pageMin':
          // (Read by the drag itself, at each move: nothing to draw.)
          pageMinWidth = minOf(msg.width);
          return;
        case 'pageState': {
          if (!appWindow) return;
          const next = pageStateOf(msg.state);
          const name = named(next) ? nameOf(msg.label) : null;
          const bundleId = named(next) && isBundleId(msg.bundleId) ? msg.bundleId : null;
          const starting = next === 'loading' && msg.starting === true;
          const stuck = starting ? stuckOf(msg.stuck) : null;
          if (next === pageState && name === pageOpening && bundleId === pageOpeningBundleId && starting === pageStarting && stuck === pageStuck) return;
          pageStuck = stuck;
          pageState = next;
          pageOpening = name;
          pageOpeningBundleId = bundleId;
          pageStarting = starting;
          return emit();
        }
        case 'pagePicture': {
          if (!appWindow) return;
          const next = pictureOf(msg.data);
          if (next === pagePicture) return;
          pagePicture = next;
          return pageState === 'elsewhere' ? emit() : undefined;
        }
        case 'themes':
          // Margin.app's index of imported themes changed (Settings lists them).
          if (!Array.isArray(msg.list)) return;
           (platform.features as any).userThemes = msg.list;
          rebuild();
          return emit();
        case 'windows': {
          if (!Array.isArray(msg.list)) return;
          const page = pageKey();
          windows = msg.list;
          const own = windows.find((w: { windowId?: number, id?: number } | null) => (w?.windowId ?? w?.id) === windowId);
          const before = mode;
          if (own) mode = modeOf(own);
          if (mode !== before || pageKey() !== page) emit();
          return;
        }
        case 'push':
          // The window's tabs loading (background/page-loads.ts): each one's row and the tab in front.
          if (msg.msg?.type === 'loading') {
            const next = new Set<number>((Array.isArray(msg.msg.tabIds) ? msg.msg.tabIds : []).filter((id: unknown): id is number => Number.isInteger(id)));
            if (next.size === loading.size && [...next].every((id) => loading.has(id))) return;
            loading = next;
            rebuild();
            return emit();
          }
          return onMessage(msg);
        default:
          return onMessage(msg);
      }
    },
    destroy() {
      destroyed = true;
      listeners.clear();
    },
  };
}
