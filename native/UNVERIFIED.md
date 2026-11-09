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
