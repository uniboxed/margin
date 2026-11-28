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
import { fromStorage } from '../../../extension/shared/stored.ts';
import { isLauncherPage } from '../../../extension/shared/view.ts';
import { appsOf, isBundleId } from '../../../extension/shared/apps.ts';
import type { SearchSuggestions } from '../../../extension/shared/search.ts';
import { capabilities } from '../../../extension/shared/capabilities.ts';
import { deviceOf } from './picker/feedback.ts';
import { USER_THEME_ID } from './themes/packages.ts';
import { REPORT_REASONS } from './settings-form.ts';
import type { FeedbackDevice } from './picker/feedback.ts';

// The engine as the app names it: `{ id, name }` (short words), else null.
function engineOf(v: any): { id: string, name: string } | null {
  return v && typeof v.id === 'string' && /^[a-z]{1,20}$/.test(v.id) && typeof v.name === 'string' && v.name.length > 0 && v.name.length <= 40 ? { id: v.id, name: v.name } : null;
}

/** The engine's suggestions as the app gives them (its `suggestions` push, a `search.suggest` answer), checked: null if not that. */
export function suggestionsOf(v: any): SearchSuggestions | null {
  if (!v || typeof v.query !== 'string' || v.query.length > 400 || !Array.isArray(v.items)) return null;
  const items = v.items.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200 && !/[\u0000-\u001f\u007f]/.test(s)).slice(0, 8);
  return { query: v.query, items, engine: engineOf(v.engine) };
}

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
      if (child.localName === 'template') continue;
      if (child.localName === 'm-page') {
        // (Nothing of the page's place takes the pointer but a split's dividers and a folded pane's card, Margin's own:
        // docs/PEEK-SPLIT.md §4, docs/FLEX-SPLIT.md step 1; none while the preview card is up over it, `m-card-clip`: its
        // page is the card's, the dim around it Margin's.)
        if (child.hasAttribute?.('m-card-clip')) continue;
        const add = (b: DOMRect) => { if (b.width > 0 && b.height > 0 && b.left < slot.right && b.right > slot.left && b.top < slot.bottom && b.bottom > slot.top) found.push(box(b.left, b.top, b.right, b.bottom)); };
        // (Through a split's groups too: its tree, docs/FLEX-SPLIT.md step 3.)
        const inSplit = (g: Element) => {
          for (const d of (g.children as any) as Element[]) {
            if (d.localName === 'm-divider') { add(d.getBoundingClientRect()); continue; }
            if (d.localName === 'm-split-group') { inSplit(d); continue; }
            if (d.localName !== 'm-pane') continue;
            for (const a of (d.children as any) as Element[]) {
              if (a.localName !== 'm-pane-card' || !d.hasAttribute('m-folded')) continue;
              const st = getStyle(a);
              if (st.pointerEvents !== 'none' && st.visibility !== 'hidden') add(a.getBoundingClientRect());
            }
          }
        };
        inSplit(child);
        continue;
      }
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
 * `ground`: the colour Margin draws under the theme at a point of the window (a space's background: ui/runtime.ts
 * backgroundAt; null where none shows), which is what's outside the card where no sharp shadow of the theme's covers it
 * (a theme's shadow is painted over Margin's ground), before an ancestor's background.
 * */
export function cornerFill(el: Element | null | undefined, { getStyle = (e: Element) => (e.ownerDocument.defaultView as any).getComputedStyle(e), getBox = (e: Element) => e.getBoundingClientRect(), ground }: { getStyle?: (e: Element) => any, getBox?: (e: Element) => { width: number, height: number, left?: number, top?: number }, ground?: ((x: number, y: number) => string | null) | null } = {}): { fills: (string | null)[], edge: { width: number, color: string } | null } | null {
  if (!el) return null;
  const cs = getStyle(el);
  const px = (v: unknown) => parseFloat(String(v ?? '')) || 0;
  const width = px(cs.borderTopWidth);
  const edge = width > 0 && cs.borderTopStyle !== 'none' && cs.borderTopStyle !== 'hidden' && drawn(cs.borderTopColor) ? { width: Math.round(width * 100) / 100, color: String(cs.borderTopColor).trim() } : null;
  const { width: w, height: h, left: boxLeft = 0, top: boxTop = 0 } = getBox(el);
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
  const outside = (p: number[]) => shadows.find((s) => covers(s, p))?.color.trim() ?? ground?.(boxLeft + p[0], boxTop + p[1]) ?? background;
  const fills = points.map((p) => covers({ x: 0, y: 0, spread: 0 }, p) ? edge?.color ?? background : outside(p));
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
/** A split's cut pane (docs/PEEK-SPLIT.md §4b): its window, and its hidden sides its arrows slide into its pane. */
export type PaneCut = { window: number };

export function createAppHost({ hello, post, onMessage = () => {}, onNotice = () => {}, warn = (...args) => console.warn('[margin]', ...args), note = (...args) => console.info('[margin]', ...args) }: {
  hello: any,
  post: (op: string, body?: Record<string, any>) => Promise<any>,
  onMessage?: (msg: any) => void,
  onNotice?: (arg: { id?: string, action?: string }) => void,
  warn?: (...args: any[]) => void,
  /** A line for Margin.app's log (a decision worth reading back from the real screen, never per frame). */
  note?: (...args: any[]) => void,
}): Host & { readonly platform: Host['platform'] & { app: boolean, features: Record<string, any> }, readonly appWindow: boolean, readonly pageOutside: boolean, readonly pageHosted: boolean, readonly pageSlides: boolean, readonly marginPage: 'settings' | null, readonly pageMinWidth: number, readonly paneMinimums: Record<string, [number, number]>, readonly appMinimums: Record<string, [number, number]>, note(text: string): void, readonly paneLoading: { item: string, name: string, bundleId: string | null } | null, readonly paneCuts: Record<string, PaneCut>, readonly paneHover: number | null, readonly pageStuck: string | null, readonly sidebarDocked: boolean, perform(name: string, arg?: any): boolean | undefined, staysOnScreen: boolean, receive(msg: any): void, readonly windows: any[], readonly layout: Geometry | null, readonly settingsAsked: boolean, readonly pageTabId: number | null, readonly frontTabId: number | null, readonly loading: number[], readonly userThemes: any[], readonly feedbackDevice: FeedbackDevice | null, takeFailure(): { type: string, error: string } | null, destroy(): void } {
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
  // Whether the page area may pass the window's edge (the app's `pageSlides`, margin-core's `page_slides`): Margin's own
  // page, or a hosted window in a tile of Margin's Space; not one its own Space places. A theme's Library slides the
  // page past the edge then, its width kept, or makes room (the root's `m-page-slides`, overlay.ts). Never over a
  // browser's page.
  let pageSlides = appWindow && hello?.pageSlides !== false;
  // The app reads each layout report as the JSON it is (its hello's `layoutText`: Margin.app's window, whose core parses
  // the report as it comes, every frame of a drag, with no object made of it first): sent as its text then.
  const layoutText = appWindow && hello?.layoutText === true;
  // One of Margin's own pages in the page area while nothing's hosted there (Settings: its tab, margin://settings,
  // HostedSession.swift ItemTarget.margin), null: the launcher.
  const marginPageOf = (v: unknown) => (appWindow && v === 'settings' ? v : null);
  let marginPage: 'settings' | null = marginPageOf(hello?.marginPage);
  // The hosted window's own minimum width (Margin's points; 0: none): a drag of the sidebar's edge stops there.
  const minOf = (v: unknown) => (appWindow && typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.ceil(v) : 0);
  let pageMinWidth = minOf(hello?.pageMinWidth);
  // A split's panes' windows' own minimums (item id: [width, height], Margin's points): its page never lays a pane below
  // its own and its divider stops there (behaviors/split.ts). At most 4, each a sane size.
  const paneMinOf = (v: unknown, most = 8): Record<string, [number, number]> => {
    if (!appWindow || !v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, [number, number]> = {};
    for (const [k, m] of Object.entries(v as Record<string, unknown>).slice(0, most)) {
      if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(k) || !Array.isArray(m) || m.length !== 2) continue;
      const [w, h] = m.map((x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x < 20000 ? Math.ceil(x) : 0));
      out[k] = [w, h];
    }
    return out;
  };
  let paneMinimums = paneMinOf(hello?.paneMin);
  // Every app's windows' known minimum (its bundle id; `web`: the web pages Safari hosts), whether a window of it is open
  // or not (docs/PEEK-SPLIT.md §4): no pane laid out below its app's, a pane that can't fit refused before anything is
  // opened (behaviors/split.ts `paneFloors`). At most 64, each a sane size.
  let appMinimums = paneMinOf(hello?.appMin, 64);
  // A split's pane whose window is opening beside the panes shown (its item, its name, its app): its loader over that
  // pane's box only (behaviors/split.ts), never the page card's over all of them. Margin's own window only.
  const paneLoadingOf = (v: any): { item: string, name: string, bundleId: string | null } | null => {
    if (!appWindow || !v || typeof v !== 'object' || typeof v.item !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(v.item)) return null;
    return { item: v.item, name: typeof v.label === 'string' ? v.label.slice(0, 120) : '', bundleId: isBundleId(v.bundleId) ? v.bundleId : null };
  };
  let paneLoading = paneLoadingOf(hello?.paneLoading);
  // A split's cut panes (docs/PEEK-SPLIT.md §4b): each one's window (the one the pointer rests on opens to fit its app:
  // behaviors/split.ts, docs/FLEX-SPLIT.md step 1); at most 4 (a split's panes). The sides Margin.app says are left.
  const paneCutsOf = (v: unknown): Record<string, PaneCut> => {
    const out: Record<string, PaneCut> = {};
    if (!appWindow || !v || typeof v !== 'object' || Array.isArray(v)) return out;
    for (const [item, c] of Object.entries(v as Record<string, any>).slice(0, 4)) {
      if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(item) || !c || typeof c !== 'object' || !Number.isInteger(c.window)) continue;
      out[item] = { window: c.window };
    }
    return out;
  };
  let paneCuts = paneCutsOf(hello?.paneCut);
  // The cut pane's window the pointer is over (Margin.app says it as the pointer enters and leaves one), null: none.
  let paneHover: number | null = null;
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
  // The browser's copy asked to show the item is slow (Margin.app's, docs/LINK-RESILIENCE.md §1 rule 8): only while
  // it's `loading` and not Margin's start; "Safari is slow…" under the loader (ui/runtime.ts followSlow).
  let pageSlow = pageState === 'loading' && !pageStarting && hello?.pageSlow === true;
  // Its item's page as Safari last showed it (a web item in another Margin window): only a picture's data URL, kept
  // while the card shows (the app sends null as it goes), never stored.
  const pictureOf = (v: unknown) => (typeof v === 'string' && v.length <= PICTURE_MAX && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : null);
  let pagePicture: string | null = pageState === 'elsewhere' ? pictureOf(hello?.pagePicture) : null;
  // Installed apps, as the app read them (null: none read yet).
  let apps = appsOf(hello?.apps);
  // The palette's search (core/session/suggest.rs): the engine macOS names and its suggestions for what was typed
  // (`search.suggest`'s answer, or the app's `suggestions` push once the engine answered), kept as the state's
  // `search` (shared/search.ts rankPalette). `typed`: what was typed last (a push for another query is old).
  let search: SearchSuggestions | null = null;
  let typed = '';
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
  // The theme store (docs/THEME-STORE.md §4): Settings' Themes, in Margin.app's own window (its app asks the store):
  // what it was last told (`themeStore`), `{}` until then (Settings asks for it when Themes is drawn).
  (platform.features as any).themeStore = appWindow ? {} : false;
  // A theme per space (2026-11-20): Margin.app's own window draws each space's (its app picks the package by the space
  // the window shows); a browser's overlay draws its profile's, so it doesn't offer them (ui/space-theme.ts).
  (platform.features as any).spaceThemes = appWindow;
  // Haptics (Edit Theme Color's ticks, M2.9 step 6): Margin.app's own window on the Mac plays them (`haptic.*`).
  (platform.features as any).haptics = appWindow && platform.os === 'mac';
  // A new Split View from a menu (Arc's "+" New Split, M2.10): the overlay makes it as ⌃⇧= does (`split.new`).
  (platform.features as any).newSplit = true;
  // The palette's search in Margin.app's own window (core/session/suggest.rs): the engine macOS names, its suggestions.
  (platform.features as any).appSearch = appWindow;
  // Apps opened in Margin.app's window on the Mac hidden from the Dock (Settings › Apps; host/docked.rs).
  (platform.features as any).appDock = appWindow && platform.os === 'mac';
  // A split's panes laid out in Margin.app's own window (behaviors/split.ts): Settings › Apps offers how a pane opens to
  // fit its app (docs/FLEX-SPLIT.md step 1).
  (platform.features as any).splitPanes = appWindow;
  // The window's tabs loading, as the copy last said (`push` `loading`).
  let loading: Set<number> = new Set();
  let failure: { type: string, error: string, at: number } | null = null;
  // The device the person's gestures come from, as Margin.app says it (`pointerKind`, M2.9 step 6): Edit Theme
  // Color's ticks (ui/picker/feedback.ts). None until it's said.
  let device: FeedbackDevice | null = null;

  const rebuild = () => {
    const next = raw ? fromStorage(raw) : null;
    let built = next?.spaces?.length ? next : null;
    if (built && apps) built = { ...built, apps };
    if (built && search) built = { ...built, search } as typeof built;
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
    // A space's picture: served by Margin.app's scheme by its id alone (OverlayWebView.swift `/background/<id>`).
    pictureUrl: (id: string) => (/^[0-9a-f]{64}$/.test(id) ? `margin-app://app/background/${id}` : null),
    /** The page area is another window's, beside Margin's (Margin's own window hosting): the sidebar alone here. */
    get pageOutside() { return pageOutside; },
    /** The page area is a hosted app's window, under Margin's: no launcher there. */
    get pageHosted() { return pageHosted; },
    get pageSlides() { return pageSlides; },
    /** Margin's own page in the page area (Settings), null: the launcher. Hosting covers it, as it covers the launcher. */
    get marginPage() { return marginPage; },
    /** The hosted window's own minimum width (0: none): the page area is never dragged narrower (behaviors/resize.ts). */
    get pageMinWidth() { return pageMinWidth; },
    get paneMinimums() { return paneMinimums; },
    get appMinimums() { return appMinimums; },
    /** A line in Margin.app's log. */
    note(text: string) { note(text); },
    /**
     * What's typed in the palette, at each change: the engine's suggestions for it (core/session/suggest.rs), in the
     * answer when the app knows them, else pushed (`suggestions`) once the engine answered.
     */
    suggest(query: string) {
      if (destroyed || !appWindow) return;
      typed = String(query ?? '').slice(0, 400);
      void post('send', { type: 'search.suggest', payload: { query: typed, windowId } }).then((text) => {
        const res = typeof text === 'string' ? JSON.parse(text) : text;
        const r = res?.ok ? res.result : null;
        if (!r || typed !== String(query ?? '').slice(0, 400)) return;
        const engine = engineOf(r.engine);
        // (Known, or nothing to show: in the answer. Asked of the engine: the push brings them; the engine kept meanwhile.)
        const next = Array.isArray(r.items) ? suggestionsOf({ query: typeof r.query === 'string' ? r.query : typed.trim(), items: r.items, engine }) : (search ? { ...search, engine } : { query: '', items: [], engine });
        if (!next || JSON.stringify(next) === JSON.stringify(search)) return;
        search = next;
        if (state) state = { ...state, search } as typeof state;
        emit();
      }).catch(() => {});
    },
    get paneLoading() { return paneLoading; },
    get paneCuts() { return paneCuts; },
    get paneHover() { return paneHover; },
    /** The page card's state (Margin's own window; undefined over a browser: its page is always there). */
    get pageState() { return appWindow ? pageState : undefined; },
    get pageOpening() { return pageOpening; },
    get pageOpeningBundleId() { return pageOpeningBundleId; },
    get pageStarting() { return pageStarting; },
    get pageStuck() { return pageStarting ? pageStuck : null; },
    get pageSlow() { return pageSlow; },
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
    get feedbackDevice() { return device; },
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
      const key = (g: any) => JSON.stringify([g.insets, g.radius, g.radii ?? null, g.container, g.mode ?? null, !!g.pageOutside, !!g.pageHosted, g.fills ?? null, g.split ?? null, g.panes ?? null]);
      if (layout && key(layout) === key(next)) return;
      layout = next;
      void post('layout', layoutText ? { json: JSON.stringify(next) } : { geometry: next }).catch(() => {});
    },
    get layout() { return layout; },
    get windows() { return windows; },
    /** Margin.app's index of imported themes. */
    get userThemes() { return (platform.features as any).userThemes; },
    get themeStore() { return (platform.features as any).themeStore; },
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
        // The preview card and Quick Tab (ui/behaviors/card.ts; app/platforms/macos/shell/HostedPeek.swift): only
        // Margin's own window has one. Close, back and forward say nothing more; Expand its space; Quick Tab's field its
        // address or search (`peek.go`), and that it's open (`peek.littleArc`: ⌘W and Esc are the card's then). These
        // `peek.*` names are the app's (Margin.app's perform), not the theme's `preview.*` actions: kept.
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
        // Load Unpacked (docs/THEME-STORE.md §1): the folder picker; a linked theme's folder followed no more. A save
        // says whether it links the folder just picked (`linked`) or stores a linked folder's theme again (`link`).
        case 'theme.import':
        case 'theme.link':
          void post('perform', { name, arg: null }).catch(() => {});
          return true;
        case 'theme.unlink':
          if (typeof arg?.id !== 'string' || !USER_THEME_ID.test(arg.id)) return false;
          void post('perform', { name, arg: { id: arg.id } }).catch(() => {});
          return true;
        case 'theme.save': {
          if (!arg?.value || typeof arg.value !== 'object') return false;
          const link = typeof arg.link === 'string' && USER_THEME_ID.test(arg.link) ? arg.link : null;
          // (`store`: a theme from the theme store, installed as the version and package the app downloaded.)
          void post('perform', { name, arg: { value: arg.value, ...(link ? { link } : arg.linked === true ? { linked: true } : arg.store === true ? { store: true } : {}) } }).catch(() => {});
          return true;
        }
        // The theme store (ShellThemes.swift, ShellThemeStore.swift): its list; a theme tried (downloaded and previewed),
        // reported, or one of the person's shared. Only a theme's id ever goes: where its package is and its SHA-256 are
        // the store's list's, which the app checked.
        case 'theme.store.open':
          if (!appWindow) return false;
          void post('perform', { name, arg: null }).catch(() => {});
          return true;
        case 'theme.store.try':
        case 'theme.share':
          if (!appWindow || typeof arg?.id !== 'string' || !USER_THEME_ID.test(arg.id)) return false;
          void post('perform', { name, arg: { id: arg.id } }).catch(() => {});
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
        // A split's divider dragged, or let go (behaviors/split.ts): the same, every pane's window following its rect.
        case 'split.resizing':
          if (!appWindow || typeof arg?.on !== 'boolean') return false;
          void post('perform', { name, arg: { on: arg.on } }).catch(() => {});
          return true;
        // A space swipe's detent (behaviors/swipe.ts, Arc's feel): the trackpad's alignment tick, as Arc gives it; Edit
        // Theme Color's detents too, and its texture a level's change (ui/picker/feedback.ts).
        case 'haptic.alignment':
        case 'haptic.level':
          if (!appWindow) return false;
          void post('perform', { name }).catch(() => {});
          return true;
        case 'prompt': {
          // The runtime closes it. Settings' Remove asked first (ui/settings-form.ts removePrompt): removed only on Remove.
          const m = /^remove-theme:([a-z0-9][a-z0-9-]{0,40})$/.exec(String(arg?.id ?? ''));
          if (m && arg?.action === 'remove') void post('perform', { name: 'theme.remove', arg: { id: m[1] } }).catch(() => {});
          // Report “Name”… (its reason) and Share “Name”… (ui/settings-form.ts storePrompt): sent only on a reason, or Share.
          const report = /^report-theme:([a-z0-9][a-z0-9-]{0,40})$/.exec(String(arg?.id ?? ''));
          if (report && appWindow && REPORT_REASONS.some((r) => r.id === arg?.action)) {
            onMessage({ type: 'themeStoreBusy', key: `storeReport:${report[1]}`, text: 'Reporting it…' });
            void post('perform', { name: 'theme.store.report', arg: { id: report[1], reason: arg.action } }).catch(() => {});
          }
          const share = /^share-theme:([a-z0-9][a-z0-9-]{0,40})$/.exec(String(arg?.id ?? ''));
          if (share && appWindow && arg?.action === 'share') {
            onMessage({ type: 'themeStoreBusy', key: `themeShare:${share[1]}`, text: 'Sharing it…' });
            void post('perform', { name: 'theme.share', arg: { id: share[1] } }).catch(() => {});
          }
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
        case 'pointerKind':
          device = deviceOf(msg);
          return;
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
        case 'suggestions': {
          const next = suggestionsOf(msg);
          if (!next || next.query.toLowerCase() !== typed.trim().toLowerCase()) return;
          search = next;
          if (state) state = { ...state, search } as typeof state;
          return emit();
        }
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
        case 'pageSlides': {
          const next = appWindow && msg.on === true;
          if (next === pageSlides) return;
          pageSlides = next;
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
        case 'paneMin': {
          // A split's panes' windows' minimums (docs/PEEK-SPLIT.md §4): no pane laid out below its own.
          const next = paneMinOf(msg.items);
          if (JSON.stringify(next) === JSON.stringify(paneMinimums)) return;
          paneMinimums = next;
          return emit();
        }
        case 'appMin': {
          const next = paneMinOf(msg.apps, 64);
          if (JSON.stringify(next) === JSON.stringify(appMinimums)) return;
          appMinimums = next;
          return emit();
        }
        case 'paneCut': {
          const next = paneCutsOf(msg.panes);
          if (JSON.stringify(next) === JSON.stringify(paneCuts)) return;
          paneCuts = next;
          if (paneHover != null && !Object.values(paneCuts).some((c) => c.window === paneHover)) paneHover = null;
          return emit();
        }
        case 'paneHover': {
          const next = Number.isInteger(msg.window) && Object.values(paneCuts).some((c) => c.window === msg.window) ? msg.window as number : null;
          if (next === paneHover) return;
          paneHover = next;
          return emit();
        }
        case 'paneLoading': {
          const next = paneLoadingOf(msg.pane);
          if (JSON.stringify(next) === JSON.stringify(paneLoading)) return;
          paneLoading = next;
          return emit();
        }
        case 'pageState': {
          if (!appWindow) return;
          const next = pageStateOf(msg.state);
          const name = named(next) ? nameOf(msg.label) : null;
          const bundleId = named(next) && isBundleId(msg.bundleId) ? msg.bundleId : null;
          const starting = next === 'loading' && msg.starting === true;
          const stuck = starting ? stuckOf(msg.stuck) : null;
          const slow = next === 'loading' && !starting && msg.slow === true;
          if (next === pageState && name === pageOpening && bundleId === pageOpeningBundleId && starting === pageStarting && stuck === pageStuck && slow === pageSlow) return;
          pageStuck = stuck;
          pageSlow = slow;
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
        case 'profiles': {
          // The profiles' names (MarginWindowController.tellProfiles, M2.10): a space's tooltip shows its profile's, as
          // Arc's does (ui/view-model.ts). `{ names: { browser: { id: name } }, fallback: { browser: id } }`.
          const p = msg.profiles;
          if (!p || typeof p !== 'object' || !p.names || typeof p.names !== 'object') return;
          (platform.features as any).profileNames = { names: p.names, fallback: p.fallback && typeof p.fallback === 'object' ? p.fallback : {} };
          rebuild();
          return emit();
        }
        case 'themes':
          // Margin.app's index of imported themes changed (Settings lists them).
          if (!Array.isArray(msg.list)) return;
           (platform.features as any).userThemes = msg.list;
          rebuild();
          return emit();
        case 'themeStore': {
          // The theme store as Settings' Themes shows it (ShellThemes.swift `theme.store.open`): its themes, each with
          // what it is to this install; or why there are none. The overlay hears it too (Refresh's line).
          if (!appWindow || !['ready', 'closed', 'error'].includes(msg.state)) return;
          (platform.features as any).themeStore = {
            state: msg.state,
            rows: Array.isArray(msg.rows) ? msg.rows.slice(0, 500) : [],
            message: typeof msg.message === 'string' ? msg.message.slice(0, 300) : '',
          };
          rebuild();
          emit();
          return onMessage(msg);
        }
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
