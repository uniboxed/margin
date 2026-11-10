# Margin for Windows: the brief

The starting point for the Windows work, written 2026-11-09 when it was split off from the macOS work. Read this first,
then `CLAUDE.md`, `SPEC.md`'s Working rules, `docs/PROTOCOL.md`, `docs/BROWSER-WINDOWS.md` and `docs/DATA.md`.

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

**Chrome and Edge don't link to Margin.app today, even on the Mac** (PLAN.md "Phase 5", never built):
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

## The plan

1. **Architecture.** A Cargo workspace in `native/`:
   - `margin-core`, OS-neutral and unit-tested on the Mac: the WebSocket link, the protocol's messages (serde),
     chunks, key parsing and the active rule, the state mirror, the window binder, overlay planning without Spaces,
     the data set and store, browser profiles, the profile switch.
   - `margin-windows`, the binary:
     - finding and following Chrome's and Edge's windows (`SetWinEventHook`, `DwmGetWindowAttribute`
       `DWMWA_EXTENDED_FRAME_BOUNDS`, `EnumWindows`, process names `chrome.exe` / `msedge.exe`);
     - overlay windows (layered, tool, no-activate, owned by the browser window so they stay just above it; pointer
       pass-through by turning `WS_EX_TRANSPARENT` on and off from the pointer's place, like `PointerWatch`);
     - WebView2 (transparent background, the overlay files served from a virtual host, network blocked as on the Mac);
     - hot keys (`RegisterHotKey`);
     - the native-messaging host mode (`margin.exe` started by Chrome or Edge, registered under
       `HKCU\Software\Google\Chrome\NativeMessagingHosts\io.tirth.margin` and Edge's key; it gets the link details
       from the running app over a named pipe for this user only);
     - a single instance, starting at login, data under `%LOCALAPPDATA%\Margin`.
   - `margin-linux`: later.
2. **The Chromium link** in the extension. **Update (2026-11-09): being built on macOS first, in the main checkout**
   (Chrome and Edge linking to Margin.app on the Mac: a relay helper started by `connectNative`, the link's messages
   over the native port, PLAN.md "Spike 3"). Don't build a second one here: merge main once that lands, and give
   Windows the same relay in Rust (the host started by Chrome, relaying to the running app over a named pipe for this
   user only, as the Mac's relays over a Unix socket).
3. **Windows shell, part 1:** link, windows, overlay, keys. Then the data, themes, profiles and the profile switch.
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
