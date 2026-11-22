# Chrome, Edge and Windows on the hosted design (plan, 2026-11-22)

Asked by Tirth on 2026-11-22: Chrome and Edge hosted exactly as Safari is on the Mac, on the Mac and on Windows, and the
Windows shell on the hosted design, "properly, without mistakes", with no rise in CPU or memory and no loss of speed.
The Mac's hosted design is docs/MARGIN-APP.md, its core docs/HOSTING-CORE.md and docs/ARCHITECTURE-PLAN.md (the core
decides **what**, each OS's adapter decides **how**), split view and the preview card docs/PEEK-SPLIT.md.

Words as in those files: the **library** (the spaces and items Margin owns), an **item** (`{ kind: 'web', browser,
profile }`, `{ kind: 'app', … }` or Margin's own page), a **copy** (one profile's running extension), a **host** (the
real window behind an item), **park** (a host out of sight, kept), **give back** (a host returned as it was found).

## 1. Where it stands (read from the code, 2026-11-22)

| Piece | State |
|---|---|
| Mac, Safari | Hosted only since 2026-11-16. Margin.app owns the library; one Safari window per profile and role (main, card, pane 1–3) hosted in Margin's page area; the copy drives that window's tabs (`extension/background/hosted.ts`: `hostShow`, `hostClose`, `hostPicture`, `hostMute`, `hostNavigate`, `hostMedia`, `hostPromotePeek`, `hostCardClose`; `newWindow`, `setWindowState`, `closeWindow`, `hostFocusWindow` in handlers.ts). |
| Mac, Chrome and Edge | Linked through `margin-connector` (DECISIONS.md "Chrome and Edge link to Margin.app on the Mac"), but **not hosted**: `HostedSession.openApp` says "Chrome and Edge aren't hosted yet", web items of `browser: 'chrome' \| 'edge'` are never shown, and since the page box went (2026-11-16) a Chrome window under Margin shows nothing of Margin. |
| Library targets | Already browser-generic: `app/shared/library/library.ts` takes `browser` `safari`, `chrome`, `edge` on spaces and web targets, and `importValues` imports Chrome's and Edge's sets with their own targets. On the Mac the import runs **once** (`imports.done`): a Chrome profile first synced after it is never imported. |
| The copy's helper | `hosted.ts` is written against a tabs API stand-in and uses only `tabs.get/query/create/update/move/remove/sendMessage/captureVisibleTab`, all of which Chromium has. It is wired for every engine (handlers.ts, `APP_REQUESTS` in link.ts): a linked Chrome copy already answers `hostShow`. |
| Windows shell | The **old design**: margin-core's `shell` (overlay era) draws one overlay per Chrome/Edge window (`overlay.rs`, `planner.rs`, `binder.rs`, `passthrough.rs`), each profile's copy owning its own spaces. `hosting.rs` (2026-11-18) is margin-core's driver with window-mode calls, compile- and unit-checked, not wired. |
| margin-core `host` | Layout, kinds, choice, reconciler, guard, causes, routes, schedule, front, driver (`HostAdapter`), the JSON API. OS-neutral, tested. The Mac's session (`HostedSession.swift`: library item ↔ hosted windows, layouts and splits, the card, page states, holes, pass-through) is still Swift; it is being moved into margin-core now (the parent work, its steps 2–3). |

**Found broken (not fixed here, listed for whoever picks it up):**
- The Windows shell speaks protocol the extension and page dropped on 2026-11-17 (DECISIONS.md "Hosted only: the
  cleanup": `across`, `setLayout`, `parked`, `framed`, `rekey`, the windows list's `viewport`/`visible`…). Overlays over
  Chrome on Windows still draw, but anything that rode on those (the across-profile switch, the page box's layout) is
  dead there. The hosted design below replaces all of it; nothing is repaired in the old path.
- `extension/engines/chromium/fullscreen.ts followFullscreen` turns any window that goes full screen into "Margin full
  screen" by leaving full screen and entering it again. For a window Margin.app hosts and puts in full screen itself
  (`setWindowState`), that is an exit and an entry Margin didn't ask for: it would fight the host on both OSes.
  Fixed in step 2 (§3.2).
- `setWindowState` (handoff.ts) and `fullscreen.ts waitForState` poll `windows.get` every 100 ms until a state lands.
  Chromium has `windows.onBoundsChanged`; Safari has nothing better. Left for Safari; the Windows route below never
  waits on it (the adapter reads the window itself).

## 2. The shape

```
                 ┌──────────── margin-core (Rust, every OS) ────────────┐
 Margin's window │ library (spaces, items: web {browser, profile} | app) │
 (extension/ui,  │ session: item ↔ hosts, layouts, card, page states     │  ◀── the parent work, steps 2–3
  host:          │ host: kinds, choice, reconciler, guard, routes, front │
  'app-window')  │ hosted_browser: the copy's window contract (new)      │  ◀── this branch
      ▲ ops      └───────────────▲──────────────────────────▲───────────┘
      │ receive                  │ events in, actions out   │ requests/answers over the link
 ┌────┴───────────────┐  ┌───────┴─────────────┐   ┌────────┴────────────────────────────┐
 │ macOS adapter      │  │ Windows adapter     │   │ each profile's copy (Safari, Chrome, │
 │ (Swift: Spaces,    │  │ (Rust: SetWindowPos,│   │ Edge): hosted.ts drives the tabs of  │
 │ tiles, AX, freeze) │  │ z-order, regions,   │   │ the windows Margin hosts             │
 │                    │  │ DWM, WinEvents)     │   └─────────────────────────────────────┘
 └────────────────────┘  └─────────────────────┘
```

One rule carries over unchanged: **one hosted browser window per profile and role** (main, card, pane 1–3); tab
switches inside it are the browser's own (instant); a switch between profiles or to an app is a switch of hosts.

## 3. Part A: Chrome and Edge hosted like Safari (both OSes)

### 3.1 Items and targets

- A web item's target is `{ kind: 'web', browser: 'chrome' | 'edge' | 'safari', profile }`. `profile` is the copy's
  link profile (`p-…` for Chromium, `s-…` for Safari): what `hello.profile` says and the data store keys by.
- A space keeps its `browser` and `profile` for its new web items (library.ts `spaceTarget`), so a space can be a
  Chrome space, an Edge space or a Safari one, and items of several can mix in one space (each shown by its own host).
- Host ids: `safari:<profile>` stays Safari's (markers, routes and logs unchanged). Chrome's and Edge's are
  `chrome:<profile>` and `edge:<profile>`, with the same `#card`, `#pane1`…`#pane3` suffixes (docs/PEEK-SPLIT.md §1).
  Routes stay keyed by the app's identity (Chrome's bundle id on the Mac, its executable's path on Windows).

### 3.2 The copy's side (extension/, extension/engines/chromium/)

What a Chromium copy needs beyond what it already does:

1. **The windows the app hosts, known to the copy** (`hostedTabs.isHosted(windowId)`): every window made for the
   app (`newWindow` asked by the app) and every window it showed an item in (`hostShow`), until the window closes.
   Safari's code paths don't read it.
2. **No "Margin full screen" of its own in a hosted window.** `followFullscreen` (chromium only) leaves a hosted window
   alone: its state is the app's. The person's own F11 in a window Margin doesn't host works as before.
3. **A window found by its mark** (Windows: the `HWND` of the window a copy made has to be found from evidence). The
   app's `newWindow { mark }` (8–40 letters and digits) opens the window at Margin's new-tab page with `?mark=<mark>`,
   whose title becomes `Margin <mark>`; Chrome's and Edge's window title is their front tab's title ("… - Google
   Chrome", "… - Personal - Microsoft Edge"), so the window carries the mark until `hostShow` sends its tab to the
   item's page (hosted.ts already treats a lone new-tab page as Margin's own to replace). A marked new-tab page never
   hands ⌘T/Ctrl+T to the app (it isn't a fresh new tab). Safari never gets a `mark`. The binding on
   Windows (§4.4) takes the window whose title has the mark among the browser process's new top-level windows; the
   bounds the copy answered are the fallback when no title matches.
4. **Pictures:** `hostPicture` is `tabs.captureVisibleTab` (the build has `<all_urls>`), made smaller in the service
   worker (`OffscreenCanvas`, `createImageBitmap`, `FileReader`: all in Chromium's workers). On Windows a faded card
   uses a DWM thumbnail instead (§4.3.9), live and free; `hostPicture` stays for the Mac.
5. **The card and split panes:** `hostShow` with `role: 'card'`, `fresh`, `hostPromotePeek`, `hostCardClose`,
   `windowAround` (a pane's window made around its tab: `windows.create({ tabId, state })`, which Chromium has):
   unchanged code, the same on Chromium. A pane's window in full screen from the start (`state: 'fullscreen'`) is
   Chromium's extension full screen: no toolbar at all (`capabilities.marginFullscreen`'s reason).
6. **Media:** `background/media.ts` and `content/media.ts` are engine-neutral; `hostMedia` and `hostMute` work as on
   Safari.
7. **Keys:** in a window the app hosts, the copy's ⌘T/Ctrl+T hand-off (the new-tab page → the app's palette) works as
   in Safari's (`drawn` true for that window). On Windows Margin's hot keys are registered while Margin or a window it
   hosts is in front (§4.3.6), so Ctrl+T, Ctrl+W, Ctrl+L, Ctrl+Tab reach Margin before Chrome; the copy's hand-off is
   the fallback.
8. **What the copy no longer owns, once the app owns the library:** nothing is removed from the copy. It keeps
   tracking its tabs into its own state as Safari's copy does (the app reads none of it; the person's own windows of
   that profile keep the copy's behaviour). The app stops reading the copy's spaces once that profile's set is
   imported (§3.4). The copy's own spaces remain the source only where no hosted app runs (the old Windows shell,
   until it's switched; Linux).
9. **Tabs the browser opens itself** in a hosted window (a link with `target=_blank`, `window.open`): Chromium puts
   them in that window. The copy tells the app (`push hostTabOpened { windowId, tabId, url, openerItemId }`, a new
   push, the session's to turn into an item: `addItem` after its opener, shown). Popups (`window.open` with features)
   come as windows of type `popup`: left as the browser's (an owned-looking window over the page area: §4.3.4).
   *(Planned, not done here: it needs the session's answer.)*

Kept exactly as it is for Safari: every hosted.ts behaviour and its tests (`tests/hosted-tabs.test.ts`,
`tests/peek-card.test.ts`, `tests/split-view.test.ts`, the WebKit host's scenarios). A change to shared code is
checked by building and comparing `dist/webkit/` with the base branch's: only the reviewed lines differ.

### 3.3 The app's side on the Mac (Swift today; the session moving to the core)

The Mac hosts Chrome's and Edge's windows with the same engine as Safari's, by what each window does, never by name:

- **The window:** asked of the profile's copy (`newWindow`), found by the window server as Safari's are (a layer-0
  window of the browser's process at least 200×200, not there before the ask, at the bounds the copy answered).
- **Full screen with no toolbar:** `setWindowState { fullscreen }` through the copy. An extension's full screen in
  Chromium has no toolbar at all (`marginFullscreen`'s reason, fullscreen.ts) and Chromium uses AppKit's full screen:
  its window gets its own Space, then the tiles/members route as for Safari. No "Always Show Toolbar in Full Screen"
  setting is needed (the 2026-11-14 note predates the extension full screen).
- **Not started with no Dock icon:** Chrome and Edge are never relaunched (the Safari rule: a browser open the normal way
  gets a window of Margin's own in it). Started by Margin when not running: `open -g -a <app> --args
  --profile-directory=<dir> --no-startup-window`, so its copy links before any window opens (no restored windows to
  sweep); its Dock icon shows (UIElement launch is AppKit's, Chromium ignores it: to check on the Mac, §9).
- **Profile directories:** a copy's `p-…` id ↔ Chrome's profile folder is learned by evidence, never guessed: Margin
  opens `--profile-directory=<dir>` with a mark page (§3.2 item 3, opened from the command line) and the copy that
  reports that mark is that folder's. Kept in the app's `browser.json` beside the profile's name (Chromium's `Local
  State`, `profile.info_cache.<dir>.name`, read-only).
- **Everything else** (park, show, split panes, the card, live resize, the minimum width, cut panes, all panes active)
  is the engine's and the core's, unchanged: they work on windows, not browsers.

### 3.4 Migration of a person's Chrome and Edge spaces

- Once per profile set, not once per library: the library's import marker becomes per set
  (`imports.sets["chrome:p-…"]`), and `importValues` imports only sets not imported yet (same namespaced ids, so a
  rerun after a crash gives the same values). The Mac's `Library.importOnce` and Windows' library start call it at each
  launch with the sets the data store has. Needs a small change to library.ts (§10, item 9).
- Chrome's and Edge's sets reach the app the way they do today: the copy's data sync (`data.hello` → the app's data
  store), on both OSes. Nothing is read from Chrome's own files except `Local State`'s profile names.
- The copy's data are never deleted. After its set is imported the app stops showing them; the copy keeps its state
  for the windows the person opens outside Margin.

## 4. Part B: the Windows shell on the hosted design

margin.exe becomes the app, like Margin.app: its own window, the library, the page area, hosted windows. The old
overlay path stays until the hosted path is used daily, then goes (step 9).

### 4.1 Margin's window

- **What it is:** a top-level window of margin.exe (`WS_OVERLAPPEDWINDOW`, taskbar button, Alt+Tab entry, the app's
  icon), its client area the whole window: `WM_NCCALCSIZE` returns the window rect so the theme draws its own frame
  (the Mac's full-size content view). DWM keeps the shadow and snap (`DwmExtendFrameIntoClientArea` with a 1 px
  margin). Windows 11's backdrop (`DWMWA_SYSTEMBACKDROP_TYPE`, Mica) only for a theme that asks for system materials
  (`wantsSystemMaterials`), else none.
- **Its content:** one WebView2 (the existing environment, `webview.rs`), visual hosting with DirectComposition and a
  transparent background (`WS_EX_NOREDIRECTIONBITMAP`, as the overlays), loading `dist/app/overlay.html` with the
  hello's `host: 'app-window'`. The page is the Mac's page: the same `extension/ui` and `app/shared/host/overlay.ts`;
  the bridge is WebView2's (`ui/overlay-bridge.ts`).
- **The theme's buttons and drag regions** (`chrome` op, `chromeRects`): `WM_NCHITTEST` answers `HTCAPTION` over a drag
  region, `HTMINBUTTON`/`HTMAXBUTTON`/`HTCLOSE` over the theme's buttons (Windows 11's snap layouts show on
  `HTMAXBUTTON`), the resize edges' `HT*` within 8 px (scaled) of an edge, `HTCLIENT` elsewhere. Pure function of the
  rects and the point (`chrome_hit`, unit-tested).
- **Windowed, maximized, full screen:** windowed and maximized are Windows' own (the maximized client area within the
  monitor's work area: `WM_GETMINMAXINFO`'s, and the 8 px overhang removed in `WM_NCCALCSIZE`); full screen is a
  borderless window over the whole monitor (`MonitorFromWindow`'s rect), entered and left by Margin's own key. The page's
  mode comes from the window's (`windows` in the hello, as on the Mac).
- **DPI:** margin.exe is per-monitor v2 (as today). The page's CSS pixels × the WebView2's rasterization scale (its
  monitor's) = physical pixels; `WM_DPICHANGED` applies Windows' suggested rect and the scale, the page lays out again
  and reports its layout.
- **Keyboard:** a click in Margin's window never takes the keyboard from a hosted window (`WM_MOUSEACTIVATE` →
  `MA_NOACTIVATE`) while one is shown, as the Mac's panel; a field of the page (the palette) takes it
  (`SetForegroundWindow`, allowed: Margin had the last input or the hot key), and gives it back to the shown host when
  it's done. With nothing hosted (the launcher, Settings) Margin's window activates as any window.

### 4.2 The page area and its holes

- The page reports where `<m-page>` (and each `<m-pane>`, the card's `<m-preview-page>`) sits (`layout` op), in CSS px
  of Margin's window; the app turns them into screen pixels (window origin + rect × scale).
- **Drawing:** Margin's window is in front of what it hosts (the Mac's rule since 2026-11-17). The page draws nothing in
  a hole (transparent pixels), so DWM shows the hosted window under it; the theme's rounded corners and frame are drawn
  by the page with their anti-aliasing intact (the overlays already rely on transparent DirectComposition content).
- **Clicks:** transparent pixels still hit Margin's window, so the hole is cut from its **window region**
  (`SetWindowRgn`): the window less each hole, less the hole's corners (a square of the corner's radius at each
  corner stays Margin's, so the theme's anti-aliased corner is never clipped). A click in the hole goes to the hosted
  window under it, natively (no forwarding, no pointer poll). The region is a pure function of the window's size, the
  holes and the radius (`hole::region`, unit-tested), set only when one of them changes.
- **The card** (preview, Quick Tab): its rect is a hole; the dimmed page around it is Margin's (a click there closes
  the card), as on the Mac.
- **Cut panes** (docs/PEEK-SPLIT.md §4b): a pane's window at its own minimum, the rest past its pane, under Margin's
  window (the sidebar, the frame) or under the pane beside it: the hole stays the pane. Windows has no tiles; a window
  past the monitor's edge is drawn clipped by the monitor, as on the Mac (to check on a PC: a window partly on a second
  monitor shows there; the hole's region still clips nothing of the other monitor, so a cut pane on a monitor's edge
  next to another monitor is held within the monitor: `layout::within`).

### 4.3 Hosting another app's window (the Windows adapter)

The adapter implements margin-core's `HostAdapter` (host/driver.rs) and the session's host operations, over a small
trait of Win32 calls (`WinOs`) so its logic is tested on any OS against a simulated Windows (`hosting.rs`).

1. **Placed:** `SetWindowPos(host, insertAfter = Margin's window, x, y, w, h, SWP_NOACTIVATE | SWP_NOOWNERZORDER)`
   after `ShowWindow(SW_SHOWNOACTIVATE)`: at the page area, directly under Margin's window, never activated by Margin.
   The frame is the page area in physical pixels, outset by the window's own invisible borders
   (`DWMWA_EXTENDED_FRAME_BOUNDS` vs `GetWindowRect`: Windows 10/11 add ~7 px each side but the top) and, for a browser
   on the covered route, by its own toolbar (§4.4). A maximized window is restored first (`ShowWindow(SW_SHOWNOACTIVATE)`
   un-maximizes; `SetWindowPos` alone keeps it maximized).
2. **Checked by reading back,** never assumed: `DWMWA_EXTENDED_FRAME_BOUNDS` at the page area within a pixel, the window
   visible and not minimized, and Margin's window directly above it in `GetWindow(GW_HWNDPREV)` order. That's the
   situation the reconciler compares (`at_page`, `place`, `on_screen`).
3. **Parked:** `ShowWindow(SW_HIDE)`: no taskbar button, not in Alt+Tab, Chromium's occlusion tracker treats its pages as
   hidden (their timers slow down, as Safari's parked pages). DWM's cloak is refused for another process's windows.
   Shown again: `SW_SHOWNOACTIVATE` and placed. A hidden window stays alive and its process running.
4. **Its other windows** (dialogs, menus, Chrome's bubbles and permission prompts, the downloads bubble): windows
   **owned** by the hosted window, or popups of its process over the page area, are classified by margin-core's
   kinds (their styles mapped to the kinds' facts: owned + `WS_POPUP` → dialog or transient, `WS_EX_TOOLWINDOW` →
   auxiliary, `WS_EX_TOPMOST` → layer > 0, a full-width short band at the top → strip) and let in front of Margin's
   window by `host::front`'s rules (over the page area, never over the sidebar by more than 8 px). Owned windows stay
   above their owner by Windows' own rule; when the hosted window is moved under Margin's, they are restacked above
   Margin's window if the rules let them in front (`SetWindowPos(owned, HWND_TOP, … SWP_NOACTIVATE)`), else left.
5. **In front of Margin's by accident:** a click in the hole activates the hosted window and Windows raises it above
   Margin's. `EVENT_SYSTEM_FOREGROUND` (and `EVENT_OBJECT_REORDER` for the hosted process) say so; the adapter moves the
   hosted window back under Margin's (`SetWindowPos(host, insertAfter = Margin's)`), keeping its keyboard. Its rect is
   the page area, so what could show for that moment is only what Margin draws over the page area (the theme's
   corners, a sidebar out over the page): one frame at most, measured on a PC (§9). Counted by the loop guard
   (`restack` reactions: three in 5 s stops it and says so).
6. **Focus and keys:** the shown host has the keyboard (the person's click in it, or Margin's hand-back:
   `SetForegroundWindow(host)` while Margin is in front, which Windows allows). Margin's keys are `RegisterHotKey`s,
   held while Margin's window or a window it hosts is the foreground window, let go otherwise (the Mac's rule), with
   the Windows combinations (keys.rs). The hosted app's own keys work as normal otherwise.
7. **Alt+Tab, the taskbar:** Margin's window has the taskbar button and the Alt+Tab entry. A shown host's taskbar
   button is removed while it's hosted (`ITaskbarList::DeleteTab`, given back with `AddTab`); parked ones are hidden
   (no button). Alt+Tab still lists the shown host (Windows lists any visible, unowned, non-tool window): picking it
   activates it, and §4.3.5 puts Margin's window back over it, so the person lands in Margin with that app's keys.
   Removing it from Alt+Tab would need `WS_EX_TOOLWINDOW` on another app's window (an app may reset its styles):
   Tirth's call (§9).
8. **Minimize and restore:** Margin's window minimized (its button, the taskbar, Win+↓) parks every shown host;
   restored, they're shown and placed again under it. A shown host minimized by itself (Win+↓ while it has the keys)
   is taken as Margin's minimize (Margin's window minimized, the host parked, not restored on its own:
   `EVENT_SYSTEM_MINIMIZESTART`). Win+D (show the desktop) hides both; the next activation of Margin's restores them.
   A host maximized by itself (Win+↑) is taken as Margin's maximize (Margin's window maximized, the host placed at the
   new page area).
9. **Pictures:** a host shown faded in another Margin window, Margin's window being moved, and the card's animation use
   a **DWM thumbnail** of the host (`DwmRegisterThumbnail` into Margin's window at the hole's rect, its opacity for the
   fade): composed by DWM from the window's own surface, live, no capture, no copy, no permission. During a move of
   Margin's window (`WM_ENTERSIZEMOVE` … `WM_EXITSIZEMOVE`) the thumbnail stands in and the host moves once at the end,
   so the two never trail each other. (A hidden window has no surface: a parked host's picture is the copy's
   `hostPicture`, as on the Mac, or the themed card.)
10. **Multiple monitors:** the page area is on Margin's monitor; a host follows Margin's window to another monitor in the
    same `SetWindowPos`. A host that is per-monitor aware gets `WM_DPICHANGED` there and may apply Windows' suggested rect
    instead of Margin's: the read-back sees it off the page area and the reconciler frames it once more (same monitor,
    no DPI change: it holds). Budgeted by `FrameWindow`'s 2 tries a show; a second display is a real-PC check.
11. **Virtual desktops:** a host is on the desktop it was made on. Margin's window moved to another desktop
    (Win+Ctrl+→ switches, Task View moves) leaves its hosts behind (`IVirtualDesktopManager::MoveWindowToDesktop` works
    only on the caller's own windows). Seen by `IsWindowOnCurrentVirtualDesktop` when Margin's window is activated: a
    host on another desktop is parked, and shown again by asking for a new window there (a browser: its copy makes a
    new window on the current desktop and `tabs.move`s the item's tab into it, the old window closed; an app: its
    item's card says it's on another desktop, with a button that switches there). To check on a PC (§9).
12. **Elevated apps (UIPI):** a normal margin.exe can't move or show a higher-integrity window (SetWindowPos fails with
    access denied, ShowWindow does nothing). The adapter reads the process's integrity level first
    (`GetTokenInformation(TokenIntegrityLevel)`); above Margin's: never hosted, the item opens the app as it is and the
    sidebar says why ("runs as administrator"). Margin is never run elevated.
13. **Windows that don't take the page area's size:** a window with no `WS_THICKFRAME` (fixed size) or one that comes
    back larger than asked (its minimum: `WM_GETMINMAXINFO` can't be read from another process) is learned from the
    read-back (the smallest size it was seen holding, as the Mac's minimum), then placed by `layout::fit` (its minimum,
    right edge and top the page area's, the rest under the sidebar) or, smaller than the page area and fixed, centred
    in it (`layout::inside`, §10 item 3). The page's own minimum width (`pageMinWidth`) stops the sidebar's edge there,
    as on the Mac.
14. **Gone:** `EVENT_OBJECT_DESTROY` for the host's window (or `IsWindow` false) → `window_gone`; the reconciler's
    `closeItem` after `goneGrace` with no other main window of its app (the Mac's rule). A process that exits: all its
    hosts go.
15. **Given back** (Margin's quit, an item's close): windows Margin made are closed (a browser's through its copy:
    `closeWindow`; an app Margin started: `WM_CLOSE`, left running with its window restored where it was if it doesn't
    close); windows the person had open are restored to what was recorded before Margin first touched them
    (`GetWindowPlacement`, its show state, its taskbar button: `AddTab`).

### 4.4 Chrome and Edge on Windows

- **Started by Margin when not running:** `chrome.exe` / `msedge.exe` from `App Paths`
  (`HKCU`, then `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\<exe>`), with `--profile-directory=<dir>
  --no-startup-window`: the browser runs, its copy links, no window opens until Margin asks (no restored session to
  sweep: to check, §9). Already running (the person's): never restarted; its copy is asked for a window of Margin's own.
- **The window:** `newWindow { mark, fullscreen: false }` through the profile's copy; the window is bound to its `HWND`
  by the mark in its title (EnumWindows of the browser's process tree, `Chrome_WidgetWin_1`, top-level, unowned,
  `GetWindowTextW` containing `Margin <mark>`), waited for on `EVENT_OBJECT_NAMECHANGE`/`EVENT_OBJECT_SHOW` of that
  process with a deadline (5 s), never polled. No title match by then: the one new window of that process at the
  answered bounds (DIPs → pixels); still none or several: the step fails, the window is closed by its copy.
- **The routes,** best first (each declares what it gives, the guard steps down on a loop or a failure):
  - **framed:** the copy's `setWindowState { fullscreen, land: false }` (Chromium's extension full screen: no tab strip,
    no toolbar, no title bar), then the adapter holds it at the page area with `SetWindowPos`. Whether Chromium keeps a
    full-screen window at a rect that isn't its monitor's, and whether its "press Esc/F11 to exit" bubble shows, is the
    first real-PC check (§9).
  - **covered:** a normal window whose page is the page area: its frame is the page area outset by its own toolbar
    (the tab strip and the toolbar: read as the distance from the window's top to its `Chrome_RenderWidgetHostHWND`
    child's top, or from the copy's page `window.outerHeight - innerHeight`), that toolbar lying under Margin's window.
    Its tab strip is never reachable (under Margin's window); its own window buttons are under it too.
  - **window:** as any app (§4.3), the toolbar visible: the last rung.
- **Tabs, back/forward, the address:** Margin's, through the copy (`hostShow`, `goBack`, `goForward`, `reload`,
  `hostNavigate`), as on the Mac.
- **The card and panes:** their own windows (`#card`, `#paneN`), made and bound the same way, placed at their rects.
- **Profiles:** as on the Mac (§3.3): a `p-…` copy ↔ its profile folder by the mark; names from `Local State`
  (`%LOCALAPPDATA%\Google\Chrome\User Data\Local State`, Edge's `Microsoft\Edge\User Data`).

### 4.5 The library and data on Windows

- The app's flat data set (`data\app\`, the Mac's layout) in margin-core's data store, the profiles' sets beside it as
  today (`data\chrome\…`, `data\edge\…`), synced from the copies as today.
- The library's rules are library.ts (the one copy of them, DECISIONS.md "Margin.app owns the spaces"). Windows needs a
  JavaScript runner for `dist/app/library.js`: Tirth's call (§9). Recommended: QuickJS embedded in margin-core
  (`rquickjs`, ~1 MB, a call is a JSON round trip of a few ms), so the same runner serves Windows, Linux later and the
  Rust tests on the Mac, independent of the UI's web view.
- Windows apps as items: `{ kind: 'app', bundleId }` takes a bundle id. Windows' identity is the app's
  AppUserModelID when it has one, else its executable's path: a target field of its own (§10 item 10).
- The palette's apps on Windows: the Start menu's shortcuts (`FOLDERID_Programs`, common and per user) and the
  installed packaged apps (`IShellItem` of `FOLDERID_AppsFolder`), each with its icon (64 px PNG), the Mac's `apps`
  message unchanged.

### 4.6 Start, quit, crash recovery

- **Start:** margin.exe makes its window at once with the start screen ("Getting you started", `pageState loading,
  starting: true`), loads the library, restores the window's space, starts only the item it showed (a browser item:
  its browser started if needed, its copy linked, its window made and bound, framed, placed, the tab shown) behind the
  loader; everything else on first pick. Each wait is on evidence (a hello, an answer, a window event) with a deadline,
  then the start screen's "stuck" words and its two choices (`startup.retry`, `startup.skip`), as on the Mac.
- **Quit:** Margin's window closed = Margin quits (Windows' convention; the Mac's ⌘Q prompt has no counterpart: §9).
  Every host given back (§4.3.15) before the window goes, then the links say `bye`.
- **Crash recovery:** a marker, `%LOCALAPPDATA%\Margin\hosted.json`, written atomically before every change that would
  need undoing (a window first hosted, parked, its taskbar button removed; not on every placement): each host's
  `HWND`, process id and start time, its recorded placement, show state and whether its taskbar button was removed,
  and whether Margin made it (a browser window: its link and window id). At the next start, before anything else, each
  record whose process still runs with the same start time and whose window still belongs to it is given back. A
  record that doesn't match is dropped (never touch a window of another process that got the same number).
  Hidden windows of the person's apps after a crash are the serious case: recommended, a watchdog (`margin.exe
  --watch`, the same exe in a minimal mode, waiting on margin.exe's process handle with `WaitForSingleObject`: no CPU,
  ~2 MB) that gives the marker's windows back the moment margin.exe dies (§9).

### 4.7 Events, not polls

- `SetWinEventHook` out of context, per hosted process (`idProcess`): `EVENT_OBJECT_LOCATIONCHANGE` (its
  `OBJID_WINDOW` only), `SHOW`, `HIDE`, `DESTROY`, `NAMECHANGE` (the mark), `REORDER`, `CLOAKED`/`UNCLOAKED`,
  `MINIMIZESTART`/`END`; and one global `EVENT_SYSTEM_FOREGROUND`. Each event is coalesced (one read per 16 ms at most,
  `READ_GAP`) into one look of the reconciler. Nothing is polled at rest: margin-core's scheduler is told the events
  are complete on Windows (§10 item 6), so with nothing changing nothing wakes.
- Waits are evidence with deadlines (a timer only while something waits, killed when it's answered).

## 5. Efficiency: the budgets and how each is measured

| Budget | Windows measure | Mac (Chrome hosted) measure |
|---|---|---|
| Idle < 0.5% CPU, no timers firing | `typeperf "\Process(margin*)\% Processor Time" "\Process(msedgewebview2*)\% Processor Time" -si 1 -sc 60` with three hosts at rest; margin.log's wake counter (one line a minute: timers fired, events taken) reads 0 timers | the screen suite's idle part, as for Safari |
| < 150 MB | Private bytes of margin.exe and its WebView2 processes (Task Manager's details, or `Get-Process`), after 20 switches | as for Safari |
| A switch < 16 ms of Margin's work | margin.log's `switch: N ms` (QueryPerformanceCounter around the calls Margin makes: region, `SetWindowPos`, `ShowWindow`, the link's write); the browser's own tab switch isn't Margin's | as for Safari |
| Region and hit-test cost | unit-timed in Rust (`hole::region` for 4 holes: microseconds), set only on change | — |

The WebView2 baseline is the risk to 150 MB (a browser, a GPU and a renderer process): one environment for every web
view of the app (as today), `--renderer-process-limit=1` for Margin's own pages, measured first on a PC (step 4).

## 6. Testing

- **Rust, any OS (seconds):** the hosted-browser contract (`hosted_browser`, vectors shared with the TypeScript tests),
  the Windows adapter against a simulated Windows (`hosting.rs`: placed, under Margin's window, parked, minimized,
  maximized, restacked, refused when elevated, a fixed-size window centred, gone and closed, given back as recorded,
  the loop guard stopping a restack loop), the hole region, the frame's hit test, the marker and its recovery, the mark
  binding, the browser's command line. `npm run test:rust`: format, clippy and tests, and clippy for
  `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc` (scripts/rust-test.sh).
- **The extension (unit):** hosted.ts's windows, the mark, `followFullscreen` leaving hosted windows alone (stand-ins),
  every Safari test unchanged.
- **The extension (e2e, headless Chromium):** the real Chrome build linked to a stand-in app (the real connector on the
  Mac, `tests/e2e/chromium-relay.test.ts`'s way): the app's `newWindow { mark }` makes a window whose tab title carries the
  mark, `hostShow` moves it to the item's page and back, `hostClose`, `hostPicture` returns a JPEG, `setWindowState` full
  screen stays full screen (no "Margin full screen" flip).
- **On a real PC:** every check in docs/windows/UNVERIFIED.md "Hosting", with steps; `margin.exe --host-check` (step 5)
  hosts Notepad and a Chrome window in Margin's window for those checks without the session.
- **On the Mac with real Chrome:** only with Tirth's OK (his Chrome, his profiles): TESTING.md gets the steps.

## 7. Risks

| Risk | What it would do | Answer |
|---|---|---|
| Chromium refits a full-screen window to its monitor when moved | the framed route fails | the covered route (its toolbar under Margin's window); the guard steps down by behaviour, remembered per version |
| The exit-full-screen bubble shows over the page | a band over the page for a few seconds | the covered route if it can't be avoided |
| `SetWindowRgn` on a DirectComposition window | clicks or drawing wrong in the hole | the region only for hit testing is what's needed; fallback: `WS_EX_TRANSPARENT` toggled from the pointer's place (today's overlay path, its cost: a pointer timer while over Margin's window) |
| The host flashes over Margin's window on each click into the hole | one frame of the page area's border covered | measured; the theme's corners are the only overlap |
| Hidden windows left after a crash | the person's app invisible | the marker, the watchdog, the recovery at start |
| Another app resets its window's styles or position | a fight | the loop guard; never a style change by default |
| WebView2's memory | over 150 MB | one environment, a renderer limit, measured before step 6 |
| A per-monitor-aware app answering `WM_DPICHANGED` | one more placement on a monitor change | budgeted; checked on two monitors |
| Virtual desktops | a host left on another desktop | detected, re-made for browsers, said for apps |

## 8. What only a real PC can say

docs/windows/UNVERIFIED.md, section "Hosting (the hosted design)", has each with its steps: framed full screen at a
rect; the exit bubble; the region over DirectComposition; the restack's frame; `DeleteTab` on another process's window;
Alt+Tab; minimize, maximize, Win+D; DPI and a second monitor; virtual desktops; an elevated app refused; a fixed-size
app centred; `--no-startup-window` and no restored session; the mark in Chrome's and Edge's titles; the marker's
recovery after `taskkill /f`; the budgets.

## 9. Decisions for Tirth (with my recommendation)

1. **Alt+Tab entries of hosted windows.** Leave them (picking one lands in Margin with that app's keys) — or hide them
   with `WS_EX_TOOLWINDOW` on the other app's window (cleaner list, but changes another app's window style, which the app
   may undo). *Recommend: leave them for now; the taskbar button is removed either way.*
2. **The library's rules on Windows.** QuickJS embedded in margin-core (one runner for Windows, Linux and the Rust tests),
   or a hidden WebView2 page (no new dependency, tied to a web view's life), or a Rust port (a second copy of the rules:
   against the 2026-11-15 decision). *Recommend: QuickJS (`rquickjs`).*
3. **Crash watchdog.** A second tiny margin.exe process (~2 MB, no CPU) that gives hidden windows back the moment Margin
   dies, or recovery at the next start only. *Recommend: the watchdog: an invisible app is the worst failure Margin
   could cause on Windows.*
4. **Closing Margin's window.** Quits Margin (Windows' convention, every host given back), or keeps Margin in the
   notification area. *Recommend: quits.*
5. **Chrome started by Margin on the Mac** keeps its Dock icon (Chromium can't start without one the way AppKit apps
   can). *Recommend: accept; Safari stays the Dock-less default browser.*
6. **Old Windows overlay path:** removed once the hosted path is daily use (step 9), as on the Mac. *Recommend: yes.*

**Tirth's answers (2026-11-22):** 1. leave them for now. 2. **neither QuickJS nor a web view: the library's rules move
into margin-core (Rust) right after the current core work** (docs/CORE-REFACTOR.md), so Windows never gets a stopgap;
until then the Windows hosted session waits for them. 3. the watchdog (~2 MB is fine). 4. quits. 5. accept for now.
6. yes.

## 10. Needs from the core (the parent work; nothing of it re-implemented for Windows)

Each is the API Windows would consume. Until it lands, Windows' side is written against these shapes with a narrow
adapter of its own and no copy of the logic.

1. **The session, OS-neutral** (`host::session`, from HostedSession.swift): `Session::handle(now, Input) ->
   Vec<Command>`, browser-generic. Inputs: the library's requests (show item in Margin window, close, open pin…), the
   page's layouts per Margin window (page area, pane rects, card rect: CSS px plus scale, or screen points), host events
   (a window gone, closed by the person, minimized, its app quit), the copies' answers and pushes (`newWindow`'s window,
   `hostShow`'s tab, `hostTabOpened`, `cardPage`, `peekOpen`). Commands: `EnsureBrowserWindow { browser, profile, role,
   url?, item? }` (the adapter makes and binds it: §4.4), `Ask { link, type, payload }` (a copy request, built by
   `hosted_browser`), `Show { window, visible: [{ host, rect, role, z }], focused }`, `Park { host }`, `GiveBack { host }`,
   `PageState { window, state, label, app? }`, `Holes { window, rects, radius }`, `PageMin { window, width }`,
   `PaneCut { … }`. Host ids `<browser>:<profile>[#role]` and `app:<id>`.
2. **Routes for Windows:** `Route` gains `Framed` (a browser's own full screen held at the page area) between `Members` and
   `Window`, or routes become OS-declared rungs with `gives` text. Until then the Windows adapter reports `Members` for
   framed and `Window` for covered/window (documented in hosting.rs).
3. **Layout:** `layout::inside(page, size) -> Rect` (a fixed-size window centred in the page area: the Mac's window-mode
   centring, now in Swift), and the frame for a browser on the covered route as `Edges::outset(page)` with its toolbar's
   edges (exists).
4. **Kinds' facts, OS-neutral:** `kinds::Window` takes AX names (`role`, `subrole`, `layer`). Windows maps its styles to
   them (hosting.rs `kinds_facts`: owned + popup → `AXDialog`, tool window → `AXFloatingWindow`, topmost → layer 3, plain →
   `AXStandardWindow`); an OS-neutral field set (`owner`, `dialog`, `floating`, `resizable`) would remove the mapping.
5. **Front:** `front::Look` assumes Spaces; on Windows `margin_only` is always true and `unsteady` is false at rest.
6. **Schedule:** `PollFacts` gains `events_complete: bool` (an OS whose events cover every change: Windows' WinEvents), so
   `next_poll` returns none at rest with hosts.
7. **The link for the session:** `Shell` (or the session's own link layer) gets `request(link_key, type, payload) ->
   RequestId` and an input `Answered { id, result }`, and `drawn` per hosted window, so the session talks to any copy
   without an overlay; the hello for an `app-window` page (`host`, `pageHosted`, `pageState`, `pageMinWidth`, `apps`,
   `paneCut`, `themes`, `marginPage`) built by the core.
8. **The app's data set on Windows:** `DataStore` with the Mac's flat layout (`data/app/set.json`,
   `items/<collection>.json`): `DataStore::flat(root)` or a `DataProfile::app()`.
9. **The import per set:** library.ts `importValues` with a marker per set (`imports.sets`), so a Chrome or Edge profile
   first seen after the first import is imported once (the Mac's `Library.importOnce` calls it at each launch).
10. **Windows apps as items:** library.ts `AppTarget` with a Windows identity (`{ kind: 'app', appId, path?, name }`,
    `appId` an AppUserModelID or `exe:<path>`), the address `app://<id>` kept for matching.

## 11. Steps (each leaves Margin.app and margin.exe usable)

1. **The plan** (this file). *Done 2026-11-22.*
2. **The copy, Chromium:** the hosted windows known, no "Margin full screen" flip in them, the mark; unit and headless
   Chromium e2e tests; Safari's bundle differing only by the reviewed lines. *Done 2026-11-22.*
3. **margin-core `hosted_browser`:** the copy's window contract as typed requests and answers (one place for both apps),
   with vectors shared with the TypeScript tests. *Done 2026-11-22.*
4. **Windows mechanism, OS-neutral half:** the adapter over `WinOs` with the simulated Windows, the hole region, the
   frame's hit test, the marker and recovery, the mark binding, the browser's command line. Compiles and passes clippy
   for both Windows targets. *Done 2026-11-22.*
5. **Windows mechanism, Win32 half:** `WinOs` over Win32, Margin's own window (frame, hit test, region, WebView2 in
   `app-window` mode, DPI), and `margin.exe --host-check <exe>` (a dev mode hosting one app's window in Margin's page area
   with the reconcile loop, the restack and the marker) for the real-PC checks. The default launch unchanged (the
   overlay shell). *Done 2026-11-22, compile- and clippy-checked only; the web view is attached to Margin's window by
   `appwindow::attach` and its `layout`/`chrome` ops read by `hole::page_layout`/`Chrome::from_op`, but the page's
   `app-window` hello is the session's (§10 item 7), so `--host-check` paints the window plainly.*
6. **The session plugged in** (after the parent's steps 2–3): margin.exe's hosted mode driven by `host::session`, the
   library on Windows (its runner, decision 2), Chrome and Edge started and bound (§4.4), keys, start and quit; behind
   `--hosted` until a real-PC run passes UNVERIFIED's hosting list.
7. **Chrome and Edge on the Mac:** the Swift engine (or the core session) takes web items of `chrome`/`edge` as Safari's,
   the copies' windows found by the window server; Tirth's real-Chrome check.
8. **The import per set** on both OSes (§3.4); the old Windows profile switch and `across` retired.
9. **Hosted by default on Windows;** the overlay path (`shell`'s overlays, `planner.rs`, `binder.rs`, `passthrough.rs`,
   `overlay.rs`, `pointer.rs`) removed, as the Mac's was on 2026-11-16.

## 12. Progress

- 2026-11-22: this plan (branch `feat/hosted-windows-chromium`).
- 2026-11-22: steps 2–5. The copy (extension/background/hosted.ts `madeForApp`/`isHosted`, handlers.ts `newWindow {
  hosted, mark }`, newtab.ts's marked title, background.ts's full-screen guard): `tests/hosted-chromium.test.ts`,
  `tests/e2e/chromium-hosted.test.ts` (the real Chrome build in headless Chromium, the real connector: it failed
  without the guard, the copy's own `windows.update` to normal and back). margin-core `hosted_browser` with
  `tests/fixtures/hosted-browser.json`. The Windows adapter (`hosting.rs`, `hosting/win32.rs`), `hole.rs`, `marker.rs`,
  `chromium.rs`, `appwindow.rs`, `hostcheck.rs`, `browsers::candidates`, `process::integrity`. Every real-PC check:
  docs/windows/UNVERIFIED.md "Hosting (the hosted design)".
