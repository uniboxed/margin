# What isn't verified yet

Written against Microsoft's documentation and checked only by compiling for Windows on the Mac. One line each: what,
why it might be wrong, how to check. Logs: `%LOCALAPPDATA%\Margin\logs\margin.log` and `relay.log`.

## margin-windows (the Windows layer)

### The relay and the pipe (relay.rs, pipe.rs, handshake.rs)

- **Chrome starts the host through `cmd.exe /d /c`, so the browser is the relay's grandparent.** If Chrome starts it
  directly or through something else, `browser` is wrong or `other`. Check: relay.log's "started for chrome (pid N)"
  is chrome.exe's main process in Task Manager (Details, the one with no `--type=`); same for Edge (`edge`).
- **`--parent-window` is 0 for a service worker's `connectNative`.** Then `parentWindow` is left out. Check: relay.log
  says "parent window none" for Margin's link.
- **A GUI-subsystem `margin.exe` keeps Chrome's redirected stdin/stdout.** If not, the relay links and nothing
  flows. Check: `connectNative`, `port.postMessage({k:'ping'})`, and a `Frame` reaching the app (the shell logs it).
- **Starting the app from the relay outlives the relay.** Chrome may run hosts in a job that kills its processes when
  the host exits and refuses `CREATE_BREAKAWAY_FROM_JOB`. Check: quit Margin, `connectNative` (the relay starts it),
  `port.disconnect()`; `margin.exe` must still be running in Task Manager.
- **The relay inherits none of Chrome's handles to the app.** Otherwise Chrome's port wouldn't close when the relay
  exits. Check: after `port.disconnect()`, the relay process is gone within a second.
- **Overlapped I/O with cancellation (CancelIoEx, then waiting for the result) never hangs or crashes.** Check:
  restart the app 20 times (`taskkill /im margin.exe` on the app's pid, start it) while a port is open; relay.log
  says "linking again" then links; the relay never stays stuck.
- **The pipe's DACL (`D:P(A;;GA;;;<SID>)`) lets this user's relay in and nobody else.** Check: linking works at all;
  `runas /user:<other> margin.exe chrome-extension://x/` as another user can't open the pipe.
- **`FILE_FLAG_FIRST_PIPE_INSTANCE` refuses a pipe someone else made first.** Check: in PowerShell
  `$s = New-Object IO.Pipes.NamedPipeServerStream('Margin-<your SID>')`, then start Margin: margin.log says "the pipe
  couldn't be made" (`whoami /user` shows the SID).
- **Image paths compare equal for the same `margin.exe`.** `QueryFullProcessImageNameW` and `GetModuleFileNameW` may
  differ by 8.3 short names, a `subst` drive or a symbolic link (only case and `\\?\` are handled). Check: margin.log
  says "a client (pid N) that isn't Margin" for your own relay only if this is wrong; try from a path with spaces.
- **The relay's `relayDown` / `relayUp` frames are harmless to the copy.** Unknown kinds are ignored by both ends
  (app/PROTOCOL.md), but the Chromium link isn't built yet. Check when it lands: align them with the Mac's relay.
- **Chrome's size limits: at most 1 MiB to Chrome, 64 MiB from it.** Larger app frames are dropped with a log line.
  Check: relay.log never says "dropped" in normal use (themes go in chunks).
- **The build check is only `CARGO_PKG_VERSION`.** Two different builds of one version link. Check: bump the version
  for every release; a relay of another version exits (relay.log "the app is another build").

### The host registration, one instance, sign-in (install.rs, instance.rs)

- **Chrome Beta, Dev and Canary read `HKCU\Software\Google\Chrome\NativeMessagingHosts`.** Canary may use its own
  key (`Google\Chrome SxS`). Check: `connectNative` in each; "Specified native messaging host not found" means not.
- **Brave and Chromium's keys.** Check the same way in each.
- **The manifest's `path` with spaces or non-ASCII letters.** JSON-escaped, absolute. Check: install under a folder
  with a space and an accent.
- **`Local\Margin-<SID>` is one per sign-in session.** Fast user switching gives each session its own app (wanted).
  Check: double-click `margin.exe` twice; margin.log says "another Margin is running" once.
- **Opening at sign-in through the Run key.** Settings › Apps › Startup can turn it off apart (`StartupApproved`),
  which `opens_at_login` doesn't read. Check: turn it on, sign out and in; margin.log says "starting at sign-in".

### Windows (browsers.rs, screens.rs)

- **The frame filter finds exactly the browser windows.** `Chrome_WidgetWin_1`, no owner, not a tool window, visible:
  picture-in-picture, undocked DevTools, installed web apps and popup windows are such windows too. Check: with each
  open, `browser_windows()` against `chrome.windows.getAll()`; add a filter (topmost for PiP) where they differ.
- **Bounds: DWM's visible frame vs. `windows.get`'s GetWindowRect.** They may differ by invisible resize borders, and
  by 8 px each side for a maximized window. Check: compare `BrowserWindow::bounds`/`outer` with `windows.get` for a
  normal, a maximized and a snapped window; the binder matches on whichever agrees.
- **DIPs on monitors at different scales.** The layout follows Chromium's shape (screens.rs) but its offset rule may
  differ. Check: a window on a 100% monitor beside a 150% primary; compare `bounds` with `windows.get` (left, top).
- **Elevated browsers.** `OpenProcess` on a Chrome running as administrator fails from a normal Margin: not found.
  Check: start Chrome "as administrator": no overlay (expected), no errors in the log.
- **The window events.** Out-of-context hooks: foreground for every process, the rest per browser pid (the browser
  process owns all its top-level windows). Check: move, resize, minimize, restore, switch virtual desktops
  (EVENT_OBJECT_CLOAKED), open and close windows: each makes the shell read again.
- **EnumWindows' order is the z-order, front to back.** Check: two Chrome windows overlapping; the front one has the
  lower `order`.

### Overlays, pointer, keys (overlay.rs, pointer.rs, hotkeys.rs)

- **`WS_EX_LAYERED` (alpha 255) with `WS_EX_NOREDIRECTIONBITMAP` and a DirectComposition visual.** The web view must
  show, with its transparent pixels showing the browser. Check: an overlay over Chrome with a theme; if it's black or
  invisible, drop `WS_EX_LAYERED` (and find another pass-through) or use `SetLayeredWindowAttributes` differently.
- **`WS_EX_TRANSPARENT` turned on and off takes effect at once.** Check: clicks over the page slot reach the page,
  clicks over the sidebar don't, moving quickly between them.
- **Kept just above the browser window.** `SetWindowPos` after the window above the browser's, from a background
  process; the browser coming forward on a click puts the overlay under it until the shell restacks on the
  foreground event. Check: click the browser, switch apps with Alt+Tab, overlap another app's window: no frame
  without the overlay that a person would notice.
- **Taking the keyboard: `SetForegroundWindow` on the overlay.** Allowed only while Margin got the last input (a hot
  key, a click in it). Check: the palette key, then typing goes to the palette; Escape gives it back to Chrome. Note:
  Chrome's window shows as inactive meanwhile (no non-activating key windows on Windows).
- **A click in the overlay never takes the keyboard from Chrome** (`WS_EX_NOACTIVATE`, `MA_NOACTIVATE`). Check: click
  the sidebar, then Ctrl+L: Chrome's address bar takes it.
- **Touch and pen.** Only mouse messages are forwarded (Windows promotes touch to mouse); `SendPointerInput` isn't used.
  Check on a touch screen: taps work; pinch and pen pressure won't.
- **The pointer poll's rate.** `SetTimer(16 ms)` follows the system timer: ~64 Hz, or ~32 Hz on some machines.
  Check: log the samples' spacing; if 32 Hz, use a multimedia or waitable timer.
- **WM_HOTKEY on a message-only window.** Check: a hot key while Chrome is in front reaches the shell.
- **Held keys repeat, and the repeats are marked.** RegisterHotKey without `MOD_NOREPEAT` repeats at the keyboard's
  rate; `repeat` is true until the key is let go (polled every 30 ms). Check: hold the next-tab key.
- **Printable keys in other layouts.** The key's scan code → the layout of the window in front. Check on AZERTY:
  the palette's Ctrl+T is the key in the T place of a US keyboard, as on the Mac.
- **Win-key combinations.** Windows keeps most for itself: they fail to register (reported). Check the log.

### The web view (webview.rs, serve.rs, bridge.rs)

- **Nothing reaches the network.** `WebResourceRequested` with `*`, all contexts and (where the runtime has
  `ICoreWebView2_22`) all request sources, workers included, answers every request; `--disable-background-networking` and SmartScreen off for the runtime's own.
  WebSockets aren't seen by that event (the CSP's `connect-src 'none'` blocks them). Check: Resource Monitor's Network
  tab or Wireshark, filtered to `msedgewebview2.exe`, while the overlay runs: no connections.
- **The CSP header on the app's own responses is applied.** Check: in the page, `fetch('https://example.com')` fails
  with a CSP error in the console (open DevTools only in a debug build).
- **The transparent background.** `DefaultBackgroundColor` alpha 0 and `WEBVIEW2_DEFAULT_BACKGROUND_COLOR=00000000`
  (its format may want another spelling). Check: no white flash as an overlay first shows.
- **Mouse forwarding.** Wheel deltas (signed, as `mouseData`), horizontal wheel, X buttons, double clicks, leave, the
  capture while dragging, and the page's cursor. Check: scroll the sidebar, drag a tab, hover links (hand cursor).
- **Keyboard focus by `MoveFocus` under visual hosting.** Check: after `take_keyboard` and `focus`, the palette's field
  takes typing.
- **Script dialogs off without a handler.** `alert()` should return at once. Check: `alert(1)` in the page.
- **The page's bridge.** `overlay.ts` speaks WebKit's `messageHandlers` only: the WebView2 side (`postMessage({ id, op
  })`, replies as `message` events) is a reviewed change to shared code still to make (BRIEF.md). Check after it.
- **The rasterization scale follows the overlay's monitor.** Check: drag a browser window to a monitor of another
  scale: the overlay's text stays sharp.

### The app's start (app.rs, log.rs)

- **DPI awareness from `SetProcessDpiAwarenessContext` rather than a manifest.** Some APIs read the manifest only. Check:
  on a 150% monitor, overlays line up with Chrome's windows to the pixel; else embed a manifest (`dpiAwareness`
  PerMonitorV2) with a build script.
- **The log rotating while several relays append.** Rust opens files with FILE_SHARE_DELETE, so a rename while
  another process writes should work. Check: many relays at once (several profiles), relay.log rotates.

## The shell's glue (margin-core `shell`, margin-windows `host.rs`)

Ported from Shell.swift and tested on the Mac with fake inputs; what only Windows can confirm:

- **The relay's facts win.** A hello is rewritten with the relay's `browser` (`chrome`/`edge`) and `pid` before the
  link reads it, so Edge's copy is `edge:<profile>` (its data under `data\edge\…`). Check: Edge and Chrome linked at
  once; margin.log says `hello: edge:p-…` and `hello: chrome:p-…`, and each overlay's `platform.browser` is right.
- **A link's windows are its relay pid's process tree.** Chromium's top-level windows belong to its main process (the
  relay's pid); the driver maps each window's process to its main one (same executable up its parents). Check: Chrome
  and Chrome Beta (or two user-data folders) open at once: each binds only its own windows (margin.log's binder lines).
- **Windows that aren't in full screen get an overlay too** (Tirth, 2026-11-09: `Options::windowed_too` on in
  host.rs; off on the Mac), over the page area only (`planner::windowed_frame`): the viewport's size, centred between
  the frame lines, its bottom on the visible frame's. Check: a normal and a maximized Chrome window: the sidebar sits
  under the tabs and address bar, never over them, flush with the page's left edge and bottom (no gap, no overlap of
  a few pixels); F11 then puts it over the whole window, and leaving F11 back under the toolbar.
- **The page's box in a windowed window lines up with the sidebar.** The layout's insets are measured from a window
  placed where the copy takes its page to be (`windowed_frame`'s second rect: `boxFromLayout` takes all of the
  missing width, 16 points of invisible borders on Windows, to be on the left). Check: the page's content starts
  exactly at the sidebar's edge, at 100 %, 125 % and 150 % display scale; if it's off by the border width, the copy's
  viewport isn't what windowed_frame assumes.
- **A maximized window binds.** `GetWindowRect` reaches 8 px beyond the screen when maximized (`windows.get` reports
  that); the binder's tolerance is 8 points, exactly that at 100 %. Check: a maximized window gets its overlay at
  100 % and 150 %; if not, margin.log's binder lines say why.
- **Dragging or resizing a windowed window:** the overlay follows from the location events' 30 Hz bursts, so it can
  trail the window by a frame or two. Check: drag a window around quickly; resize it from each edge.
- **Other apps' windows over a windowed browser** stay over Margin's overlay too (it's just above its browser
  window). Check: a Notepad window half over Chrome: Notepad covers the sidebar where it overlaps.
- **The front window while an overlay has the keyboard.** Windows makes the overlay the foreground window (the Mac's
  panel never is); the shell then takes the overlay's browser as in front, so the keys stay held. Check: Ctrl+T, type
  in the palette, Ctrl+T again closes it; Escape gives the keyboard back to Chrome.
- **A lost foreground blurs the page** (the Mac's `blur`): clicking the browser while the palette has the keyboard
  closes it. Check: open the palette, click the page: it closes, and Chrome takes the typing.
- **`conceal` is alpha 0 on the layered window** (`Overlay::set_alpha`), the pointer passing through: a window missing
  from one read, or its page (a video) in full screen. Check: a video full screen in a full-screen Chrome: no sidebar
  over it, only the tab and space keys held; back: the sidebar again.
- **Restacking.** Each read checks the overlay is just above its window (`stacked_above` over EnumWindows' order) and
  restacks it if not. Check: click Chrome's page; the overlay is back above it within a read (at most 250 ms).
- **Reads coalesced to 60 a second** (`READ_GAP`): a drag's location events are one read per 16 ms. Check: drag a
  window: CPU stays modest.
- **Reconnecting.** A relay gone (the port closed, the service worker restarted): the overlays stay 6 s with
  `link: reconnecting`, then close; a relay linking again within that takes them back. Check: reload Margin in
  `chrome://extensions`: the overlay dims and comes back.
- **The theme picker** is `IFileOpenDialog` on its own thread, owned by the overlay's window: `.margintheme` files, or a
  theme folder's `theme.json` (its folder imported). Check: Settings › Import theme: the dialog comes up in front of
  full-screen Chrome; a folder through its theme.json imports; Cancel does nothing.
- **`copyText`** writes `CF_UNICODETEXT`. Check: copy a link from the overlay, paste it in Notepad.
- **The quit.** On WM_QUIT the shell says `bye` on each link before the pipe closes; the writes may not reach the
  relays (the pipe is dropped right after). Check: quit Margin; relay.log says the app said goodbye.
- **The profile switch** (close-based, `ProfileSwitch`) with Chromium's words (`BrowserWords::chromium`): a profile
  with no window can't be opened by Margin yet (`--profile-directory` isn't wired). Check: two Chrome profiles' spaces
  in one sidebar; a switch opens the other profile's window full screen and closes the old one (or keeps it with a
  draft); a profile with no window says how to open one.
- **One clock.** The shell runs on the wall clock (`time::now`, as the copies' `focusedAt` are); a clock change while
  it runs shifts its timers once. Check: change the time in Settings while linked: nothing sticks.
