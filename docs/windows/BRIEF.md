# Margin for Windows: the brief

The Windows plan, what's done and what's next. Written 2026-11-09 when the Windows work was split off from the macOS
work, and kept since as its brief. Read this first, then `CLAUDE.md`, `SPEC.md`'s Working rules, `docs/PROTOCOL.md`,
`docs/BROWSER-WINDOWS.md` and `docs/DATA.md`; what only Windows can confirm is in `docs/windows/UNVERIFIED.md`, how to
build and run it in `app/windows/README.md`.

## Where it stands (2026-11-09)

- **Built, compile-checked for Windows (x64 and Arm64), the OS-neutral half tested on the Mac; nothing run on Windows
  yet.** margin-core (`app/shared/core/`) holds every rule of Margin.app that isn't the OS's, each module naming the
  Swift it ports; margin-windows (`app/windows/`, `margin.exe`) is the Windows layer and the shell's driver
  (`host.rs`); Margin's connector (`app/shared/connector/`, `margin-connector.exe`) is the browsers' native-messaging
  host on every OS.
- **One link, as on the Mac** (below): the copy's WebSocket to 127.0.0.1, found through the connector. Chrome's and
  Edge's copies link on Windows as on the Mac (`engines/chromium/extension/profile.ts` `linksApp`).
- **Next:** Tirth's first run on Windows (`app/windows/README.md`, then `docs/windows/UNVERIFIED.md` line by line);
  the keys' defaults with Tirth (DECISIONS.md "Margin for Windows planned"); the overlay page's `platform.os` (it
  says `mac` whatever the app's hello says: `extension/ui/host-app.ts`, a reviewed change to the shared overlay page);
  Chromium's profile names from `Local State`; opening a profile with no window (`--profile-directory`).

## One link for every OS (Tirth's restructure, 2026-11-09)

Every copy links over its own WebSocket to `127.0.0.1`, on Windows as on the Mac: the welcome with the key, the hello,
every message the same (docs/PROTOCOL.md, Transport). margin-core has the WebSocket server, sans IO
(`websocket.rs`: RFC 6455 by hand, as LinkSocket.swift; `socket.rs`: ExtensionLink.swift's `SocketLink`, the upgrade's
checks with their 403s, the token and key, their rotation, `wantLink` answered with the `link`), and margin.exe holds
only the TCP sockets (`tcp.rs`: 127.0.0.1 only, Nagle off, each connection on its own threads, the listener made again
on a new port when the Mac's would be).

**The pipe is for finding the app only.** `margin-connector.exe` (beside `margin.exe`), started by Chrome or Edge, is
the only native-messaging host on every OS. It connects to the app's named pipe (`\\.\pipe\Margin-<SID>`, this user
only; the app lets in only the connector beside it, the connector only the `margin.exe` beside it), says
`{ k: 'relay', v: 1, version, pid, browser, waited }`, gets `{ k: 'relayWelcome', v: 1, version }`, then sends the
browser's messages as `{ msg }` JSON lines and passes each line the app sends straight to the browser
(margin-core `relay.rs`, RelayLink.swift's port). A `wantLink` is answered as Safari's handler answers it, and the
`link` (`{ v: 2, nonce, port, token, key, app, at }`) is dispatched into every relay of that browser process, where the
copy's lasting port takes it as it takes Safari's `dispatchMessage`. Why:

- **One link, one set of rules.** The welcome's key, the token, the Origin check, the ticks, the 40 s silence, the
  1 MB cap: the same code and the same tests on every OS, and the extension's link (`background/link.ts`) has one
  transport, not a socket on the Mac and a port on Windows.
- **Native messaging is a poor link.** A host per port, started and stopped by the browser; 1 MB at most to the
  browser; every message through two extra processes and two extra framings. The connector stays small (it only
  answers and hands out the link) and never carries the copy's state or the overlays' traffic.
- **The same connector everywhere.** Its install (`margin-connector --install`, run by the app at each launch) writes
  the browsers' host files (on Windows, one file and each browser's registry key): margin.exe registers nothing itself.

The copy's hello says its browser and pid as its relay told it (and its user agent says Edge), and the shell trusts
them, as the Mac does: the token is what proves the copy is Margin's (a relay's word isn't checked against the hello on
the Mac either). Replaced: margin.exe's own relay mode (`relay.rs`, the pipe's 4-byte framing `frames.rs`, its
`relayHello`/`relayWelcome`/`relayDown`/`relayUp` `handshake.rs`, its host registration `install.rs`) and the shell's
"the relay's facts win" (the hello rewritten with the relay's browser and pid).

## What Tirth asked

> "let's do it in rust then. i would like you to create the architecture ready for all OS and write app for windows
> for now. i will do the testing later. we will still focus on macos after that but i want to get started and get
> windows upto the speed where macos is right now please … without causing any issues or errors or without losing any
> features or anything please"

Then: do it in its own worktree and session, so macOS work goes on in the main checkout.

## Decisions so far (Tirth, 2026-11-09)

- **Rust** for the Windows shell, chosen over C#/.NET and C++. It's small, starts fast, uses little memory, gets all of
  Win32 through Microsoft's `windows` crate, and the same code can carry a Linux shell later.
- **Architecture: a thin native shell per OS, everything else shared.** Shared already: the extension, the UI runtime
  (`extension/ui/`), the themes (HTML/CSS, sanitized), and the overlay page Margin.app shows (`app/shared/host/overlay.ts`).
  The shell finds and follows the browser's windows, draws the overlay page over them, holds Margin's keys, talks to
  the extension and keeps the lasting data.
- **macOS stays Swift** (`app/macos/shell/`), untouched by this work. **No Flutter or React Native:** they draw their own
  UI, and the themes are HTML/CSS.
- **No Chrome side panel:** it has Chrome's own header and width limits. Margin draws its own overlay, as on the Mac.
- **No in-page sidebar as the product:** no product build draws the sidebar in pages (DECISIONS.md, "Margin 2 ships
  for macOS only", 2026-11-04). `createInPageHost` (`extension/ui/host.ts`) remains a development/test host only.
- **Linux: later, undecided.** Under Wayland an app can't follow or cover another app's windows. The options to put
  to Tirth when it comes up: the in-page host as Linux's product, X11 only, or Margin as its own Chromium browser.
- **Testing:** Tirth tests on Windows later. Nothing here can run on Windows from this Mac: compile-check the
  Windows code, unit-test the OS-neutral code on the Mac, and keep a list of what's unverified (`docs/windows/UNVERIFIED.md`).
- When work starts for real, record a DECISIONS.md entry: Windows planned, which supersedes "macOS only" for Windows.

## What was found (an inventory of Margin.app, 2026-11-09)

As found before the Chromium link was built. **Since then (2026-11-09):** Chrome and Edge link to Margin.app on the Mac
through Margin's connector, and on Windows the same way (above); what follows of the Chromium link is history.

**Chrome and Edge didn't link to Margin.app then, even on the Mac** (PLAN.md "Phase 5", not built then):
- `extension/shared/platform.ts`: the chrome profile's `nativeApp: false`. `background/link.ts` `createLink`'s
  `enabled` needs `platform.nativeApp`, and `onboarding.ts` has the same gate.
- `link.ts` `canSocket` allows a WebSocket only in a document; Chrome's background is a service worker.
- `hello.browser` is only ever `chrome` or `safari`; nothing sends `edge`.
- The app's socket allows only `safari-web-extension://` origins. The link details reach the extension only through
  `SFSafariApplication.dispatchMessage`, which is Safari's.
- Only `engines/webkit/browsers/safari/extension/manifest.json` has `nativeMessaging`. No native-messaging host exists, except the e2e test
  harness's (`tests/e2e/harness/native-host.mts`: stdio, 4-byte little-endian length framing; `relay.ts`), which
  shows the shape.
- Already prepared: `LinkMessage.Hello` takes `browser` safari, chrome or edge and a `pid` ("Chrome's relay helper
  knows it"); PROTOCOL.md says Chrome and Edge carry the same messages over native messaging, with only Transport
  steps 1–4 different; the app's 1 MB cap per message exists because Chrome closes a native port on anything bigger.

So Windows needs (1) the Chromium link in the extension, switched on only on Windows (`runtime.getPlatformInfo().os
=== 'win'`) so the Mac's Chrome build doesn't change, and (2) the Windows shell.

**Margin.app's parts** (`app/macos/shell/`). Kinds: (a) OS-neutral logic, portable as is; (b) macOS-general, needs a
Windows counterpart; (c) Safari-only; (d) private macOS APIs.

- **Link** (a): `LinkSocket.swift` (a hand-made RFC 6455 WebSocket on 127.0.0.1; server frames unmasked; client
  frames must be masked; text, ping, pong, close; continuations; at most 64 MB in), `ExtensionLink.swift` (`SocketLink`:
  token and key are 32 random bytes in hex, constant-time token check, path `/`, Origin check, first frame
  `welcome {v:2, key}`, hello within 5 s, `owner: false` closed 1008, a newer hello replaces the older one for the same
  `browser:profile`, `tick` every 5 s answered by `tock`, 40 s silent closes 1001, secrets rotate 30 s after the last
  link closes, a listener `waiting` 5 s is made again on a new port; `LinkConnection.request` times out after 15 s),
  `LinkMessage.swift` (every message both ways), `Chunks.swift` (UTF-8 JSON in pieces of ≤ 512 KB as base64, SHA-256
  `transfer`, ≤ 64 parts, ≤ 8 MB), `StateMirror.swift` (a mirror of each copy's storage, seq and gap detection).
  Safari-only: `SafariDispatch`, the distributed notification, `appUp`.
- **Data** (a): `DataSet.swift` (items, tombstones, last-writer-wins merge; the same JSON test vectors as
  `extension/shared/data-merge.ts`), `DataStore.swift` (per-profile files written atomically: tmp, fsync, `.bak` hard
  link, rename), `DataSync.swift` (the `data.*` messages), `BrowserProfiles.swift` (`browser.json`: the space order
  across profiles, profile names, emoji, colour, `switching.closeWindows`), `ThemeStore.swift` (imported themes),
  `ShellThemes.swift` (import/save/remove; its file picker is (b)).
- **Overlay** (b): `Overlay.swift` (borderless transparent non-activating panels kept just above the browser window;
  keyboard taken and handed back), `OverlayWebView.swift` (WKWebView, the `margin-app://` scheme, CSP
  `connect-src 'none'`, network blocked, the bridge), `PassThrough.swift` (`Slot`, `CatchRegion`, `PointerWant`,
  `EdgeGuard` are (a); `PointerWatch` is (b): it turns `ignoresMouseEvents` on and off by where the pointer is),
  `OverlayPlanner.swift` / `OverlayPlacer.swift` ((a), but they model macOS Spaces), `QuitPrompt.swift`.
- **Windows** (b/a): `WindowServer.swift` (`CGWindowListCopyWindowInfo`, displays, front app), `WindowMap.swift`,
  `WindowMatcher.swift` (`WindowBinder`: binds the extension's window ids to the system's windows only on evidence:
  a window the app made, created together, focus moved, the only free window with those bounds, the page-visibility
  rule, settled focus; bindings survive blips and drop when contradicted), `WindowTrace.swift`.
- **Keys**: `Shortcuts.swift`. Parsing and the "active" rule are (a); Carbon hot keys are (b). Defaults: next/prev tab
  ⌥⌘↓/↑, next/prev space ⌥⌘→/←, palette ⌘T (always), toggle sidebar ⌥S, new window ⌘N; the copy's `keys` message
  overrides them. Keys are held only while a linked browser is in front and its front window has a shown overlay (or
  mid-switch). Tab and space keys repeat. `Shell.run`: palette and sidebar go to the front overlay as `command`; the
  overlay highlights next/prev tab at once, then asks `navigate`; spaces `navigate` or switch profiles; new window
  sends `newWindow`. On Windows, ⌘ is Ctrl (Ctrl+T for the palette); pick the defaults with Tirth.
- **Glue**: `Shell.swift` (polling 0.25 s while a browser is in front, 1 s idle, 30 Hz bursts; `LayoutOutbox`,
  `DrawnOutbox`, `HeldPushes`, `overlayFrame`, `hello(for:)`, `perform`), `ShellProfiles.swift` (`across`, space keys
  across profiles, `newMarginWindow`), `ProfileSwitch.swift` ((a): the close-based switch to another profile's space,
  through link requests only: `openSpaceWindow`, `focusWindow`, `closeWindow`, `windowDrafts`), `Diagnostics.swift`,
  `BundleWatch.swift`, `app/macos/startup/AppDelegate.swift` (login item, single instance).
- **Not on Windows** (c/d): `Handoff.swift`, `Parking.swift`, `BridgeParker.swift`, `Freezer.swift`, `SpaceReads.swift`,
  `PrivateCalls.swift` (the freeze and park handoff with SkyLight), `SafariAX.swift`, `SafariFiles.swift`,
  `SafariProfiles.swift`, `CloudTabs.swift`, `ShellCloudTabs.swift`, `ShellCovers.swift`, `EdgeStop.swift`,
  `ShellSafariSidebar.swift`, `DevHooks.swift`. For Chromium instead: profile names from `Local State`
  (`profile.info_cache`); the copy's own profile id (`p-…`, `dataMeta:link`) keys a profile; iCloud Tabs' counterpart
  could be `sessions.getDevices()` (later).

**The overlay page and its host** (`OverlayWebView.swift` ↔ `app/shared/host/overlay.ts`):
- Page → app: `window.webkit.messageHandlers.margin.postMessage({op, …})`, which returns a promise of the reply. Ops:
  `hello` (its reply is the JSON from `Shell.hello(for:)`: `{windowId, profile, browser, mode, platform: {browser, os,
  app: true}, state, windows, across, cloudTabs, held, themes, theme}`), `send {type, payload}` (a link `req` for this
  window), `ready`, `layout {geometry}` (→ `setLayout`), `hits {rects, all}`, `focus {on}`, `pointerWant`,
  `perform {name, arg}`, `framed {mode}`, `shownSpace`, `log {level, text}`.
- App → page: `marginApp.receive(m)` with `state`, `changes`, `windows`, `across`, `cloudTabs`, `themes`, `theme`,
  `link`, `rekey`, `command {name, repeat}`, `pointer`, `pointerLeft`, `pressOutside`, `blur`, `shown`, `push`,
  `themeFile`, `themeSaved`.
- WebView2 has `window.chrome.webview.postMessage` (no reply) and `PostWebMessageAsJson` / `ExecuteScriptAsync`: the
  page needs a small bridge (request ids for replies) that picks WebKit's or WebView2's. That's a change to shared
  code: Margin.app's overlay bundle must stay byte-identical, or differ only by that bridge, reviewed.

## The plan, and what's done

1. **Architecture** (done; the folders as they are since the repo's new layout, DECISIONS.md "The repo's layout"). One
   Cargo workspace at the root (`Cargo.toml`), first planned in `native/`:
   - `margin-core`, OS-neutral and unit-tested on the Mac: the WebSocket link, the protocol's messages (serde),
     chunks, key parsing and the active rule, the state mirror, the window binder, overlay planning without Spaces,
     the data set and store, browser profiles, the profile switch.
   - `margin-windows` (`app/windows/`), the binary `margin.exe`:
     - finding and following Chrome's and Edge's windows (`SetWinEventHook`, `DwmGetWindowAttribute`
       `DWMWA_EXTENDED_FRAME_BOUNDS`, `EnumWindows`, process names `chrome.exe` / `msedge.exe`);
     - overlay windows (layered, tool, no-activate, owned by the browser window so they stay just above it; pointer
       pass-through by turning `WS_EX_TRANSPARENT` on and off from the pointer's place, like `PointerWatch`);
     - WebView2 (transparent background, the overlay files served from a virtual host, network blocked as on the Mac);
     - hot keys (`RegisterHotKey`);
     - the link's listener on 127.0.0.1 (`tcp.rs`) and the connector's named pipe for this user only (`pipe.rs`);
       the native-messaging host is Margin's connector (`margin-connector.exe`, `app/shared/connector/`), whose
       `--install` the app runs at each launch (registered under
       `HKCU\Software\Google\Chrome\NativeMessagingHosts\io.tirth.margin`, Edge's, Brave's and Chromium's keys);
     - a single instance, starting at login, data under `%LOCALAPPDATA%\Margin`.
   - `margin-linux`: later.
2. **The Chromium link** in the extension (done, built on macOS first: Chrome and Edge link to Margin.app through
   Margin's connector over the copy's WebSocket). On Windows the same (2026-11-09: "One link for every OS", above):
   the Chromium profile's `linksApp` is the Mac and Windows (`Windows NT` in the user agent).
3. **Windows shell** (done, unverified on Windows): link, windows, overlay, keys; the data, themes, profiles and the
   profile switch; windowed windows too.
4. Every feature that doesn't carry over gets a line in `docs/windows/UNVERIFIED.md` or DECISIONS.md: what it was on the
   Mac, and why not (or what replaces it).

## Rules for this work

- `CLAUDE.md` and SPEC.md's Working rules apply: Conventional Commits, subject line only, no attribution of any kind;
  no assistant or tool names in branches, commits or PRs; commit as
  `git -c user.name="Tirth Patel" -c user.email="github@tirth.io"`.
- Work on `feat/windows-shell`, in this worktree (`/Users/tirth/Projects/margin-windows`). Never touch `app/macos/shell/`,
  `app/macos/startup/`, `xcode/` or the Safari build; never run `npm run safari` from here.
- A change to shared code (`extension/`, `app/shared/host/`) must keep the macOS bundles identical, or differ only by
  the reviewed change: build, then compare every `dist/` bundle with main's byte for byte. Run `npm run test:quick`
  before each commit, and the full gate (`npm run gate`) once before any merge to main.
- TypeScript is under full `strict` (DECISIONS.md "Strict types"): no `any` to get past the checker, and `!` only
  with an invariant comment. Real bugs get their own commit, with a failing test first.
- Never test on Tirth's screen without asking: no windows of tests shown. Tirth wants speed: parallel work where it
  helps, the gate once, reviews only for big pieces.
- Rust: rustup 1.99.1 at `~/.cargo/bin` (not on PATH: `export PATH="$HOME/.cargo/bin:$PATH"`), targets
  `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc`, clippy and rustfmt installed. Check the Windows code with
  `cargo check --target x86_64-pc-windows-msvc` (no linking needed), test `margin-core` with `cargo test` on the Mac.
  Building a real `.exe` needs MSVC's linker: Tirth builds on Windows when he tests (put the steps in
  `app/windows/README.md`).
- Node is at `/opt/homebrew/bin` (add it to PATH).
