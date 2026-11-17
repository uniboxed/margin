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
//   A hosted app's window above Margin's page area (window mode: an app that can't go full screen, Margin's window
//   its whole width under it): the hello's `pageHosted` and `{ type: 'pageHosted', on }`: laid out as usual (its own
//   layout), the sidebar docked as beside a tile (`sidebarDocked`: never hidden or peeking, so the page area the app's
//   window is placed in is the docked layout's), and no launcher in the page area (its field would take the keys from
//   the app above it).
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

/** The mode a window's UI is drawn in, from its state (windows.get). */
export const modeOf = (w: any) => (w?.state === 'fullscreen' ? 'fullscreen' : 'windowed');

/**
 * What the theme draws over the page slot that takes the pointer: the boxes
 * of its elements (not the root, not `<m-page>`) that overlap the slot and
 * whose `pointer-events` isn't `none`, with the root passing the pointer
 * through as the in-page host's does (`m-passthrough`: its children keep
 * theirs). Boxes inside another are left out. `all`: more than `limit`
 * (the app then takes the whole window, never letting the page miss one).
 * `keepEqual`: of nested boxes with the same bounds (Arcadia's palette layer and its backdrop, over the whole
 * window) the first is kept, and what's inside it goes (Margin's own window: its palette takes the pointer).
 * Without it each counts as inside the other and all of them go, the palette with them: over a browser's
 * window a press on the page then still reaches the page, and closes the palette (the overlay's behaviour).
 * @param root the theme's root
 * @param slot in the container's pixels
 * [x, y, width, height] each
 */
export function hitRects(root: Element, slot: { left: number, top: number, right: number, bottom: number }, { limit = 64, keepEqual = false, getStyle = (el) => (el.ownerDocument.defaultView as any).getComputedStyle(el) }: { limit?: number, keepEqual?: boolean, getStyle?: (el: Element) => { pointerEvents: string, visibility: string } } = {}): { rects: number[][], all: boolean } {
  const found: DOMRect[] = [];
  const walk = (el: Element) => {
    for (const child of (el.children as any)) {
      if (child.localName === 'm-page' || child.localName === 'template') continue;
      const r = child.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.left < slot.right && r.right > slot.left && r.top < slot.bottom && r.bottom > slot.top) {
        const style = getStyle(child);
        if (style.pointerEvents !== 'none' && style.visibility !== 'hidden') found.push(r);
      }
      walk(child);
    }
  };
  walk(root);
  const inside = (a: DOMRect, b: DOMRect) => a !== b && a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
  const same = (a: DOMRect, b: DOMRect) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
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
 * What the theme draws around `<m-page>`'s rounded corners, for Margin's own window, where a hosted app's window sits
 * above the page area with square corners and Margin draws the card's corners over it
 * (app/platforms/macos/shell/MarginWindow.swift HostCorners): `fills`, each corner's colour outside the card (top left,
 * clockwise), and `edge`, the card's border (width and colour) when it has one: the band between the page area's rounded
 * corner (the border's inner edge) and the card's outer edge, which share a centre. A corner's fill is the colour at the
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
}): Host & { readonly platform: Host['platform'] & { app: boolean, features: Record<string, any> }, readonly appWindow: boolean, readonly pageOutside: boolean, readonly pageHosted: boolean, readonly sidebarDocked: boolean, perform(name: string, arg?: any): boolean | undefined, staysOnScreen: boolean, receive(msg: any): void, readonly windows: any[], readonly layout: Geometry | null, readonly settingsAsked: boolean, readonly pageTabId: number | null, readonly frontTabId: number | null, readonly loading: number[], readonly userThemes: any[], takeFailure(): { type: string, error: string } | null, destroy(): void } {
  const windowId = Number.isInteger(hello?.windowId) ? hello.windowId : null;
  let raw: Record<string, any> | null = hello?.state && typeof hello.state === 'object' ? hello.state : null;
  let state: any = null;
  let windows = Array.isArray(hello?.windows) ? hello.windows : [];
  let mode = hello?.mode === 'windowed' ? 'windowed' : 'fullscreen';
  // Drawn in Margin's own window (its hello's `host`), not over a browser's: never changes for a page.
  const appWindow = hello?.host === 'app-window';
  // Margin's window hosting another app's window beside it: no page area of its own (only in Margin's own window).
  let pageOutside = appWindow && hello?.pageOutside === true;
  // A hosted app's window above the page area (window mode): nothing of Margin's drawn there.
  let pageHosted = appWindow && hello?.pageHosted === true;
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
    /** The page area is a hosted app's window above Margin's (window mode): no launcher there. */
    get pageHosted() { return pageHosted; },
    /** The sidebar kept docked while hosting (beside a tile, or under a window-mode app's window), whatever its setting. */
    get sidebarDocked() { return pageOutside || pageHosted; },
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
    // Its Settings asked for (the new-tab page's #settings: a Settings button elsewhere).
    get settingsAsked() { return !!frontPage()?.url.includes('#settings'); },
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
      const next = { ...geometry, mode: geometry.mode ?? mode, pageOutside };
      const key = (g: any) => JSON.stringify([g.insets, g.radius, g.radii ?? null, g.container, g.mode ?? null, !!g.pageOutside, g.fills ?? null, g.edge ?? null]);
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
        // Themes (app/platforms/macos/shell/ShellThemes.swift): the file picker; a checked theme kept; one removed.
        case 'theme.import':
          void post('perform', { name, arg: null }).catch(() => {});
          return true;
        case 'theme.save':
          if (!arg?.value || typeof arg.value !== 'object') return false;
          void post('perform', { name, arg: { value: arg.value } }).catch(() => {});
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
