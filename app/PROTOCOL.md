# The link between Margin's extension and Margin.app, version 2

What each end says, in order. The app's end is `app/shell/` (`ExtensionLink.swift`, `LinkMessage.swift`, `Chunks.swift`, `StateMirror.swift`, `Shell.swift`); the extension's end is Phase 2 step 3's. `tools/app-tests/fake-extension.mjs` is a working stand-in for the extension's end and the quickest way to see every message in use.

Version 1 was `feat/native-panel`'s (one link, a `cover` lease for the sidebar panel). Version 2 has one link per browser profile, no lease, `setLayout`, and chunked themes.

## Words

- **Copy:** one running instance of Margin's extension. Safari runs one copy per profile, each with its own background and its own link.
- **Link:** one copy's WebSocket to the app, after `hello`. It's known by its browser and profile (`"safari:<profile>"`).
- **Epoch:** a random id the copy makes for each link (each socket). Everything numbered or answered belongs to one epoch.

## Transport (Safari)

1. **Ask.** The copy sends a native message `{ type: 'wantLink', nonce }` (`runtime.sendNativeMessage`, or on its lasting `connectNative` port: Phase 0 found the port must be used at least every 20–60 s to keep Safari's background alive). `nonce`: 1–128 characters, new each time. The extension handler (`app/safari/SafariWebExtensionHandler.swift`) passes on only `{ type, nonce }`, as the distributed notification `io.tirth.margin.setup` (any process may hear it, so nothing secret goes in it).
2. **Answer.** The app answers into the extension with `SFSafariApplication.dispatchMessage(withName: 'link', userInfo: { e: <JSON string> })`, the JSON being `{ v: 2, nonce, port, token, key, app: { version }, at }`. A copy takes only the answer carrying its own nonce (with several profiles, every copy may receive it).
3. **Connect.** The copy opens `ws://127.0.0.1:<port>/?t=<token>`. The app refuses (HTTP 403, before any WebSocket opens) a wrong token, a path other than `/`, and an `Origin` that isn't `safari-web-extension://…`. It listens on 127.0.0.1 only.
4. **Welcome.** The app's first message is `{ k: 'welcome', v: 2, key }`. The copy closes the socket unless `key` is the one from step 2 (the app proving it's the app).
5. **Hello.** The copy's first message is `hello` (below), then its `snapshot`. A socket that says nothing within 5 s of opening is closed.
6. **App up.** When the app starts while Safari has been running for 2 s, it dispatches `appUp { v: 2, at }`: every copy should ask again (step 1). The app never dispatches while Safari isn't running (that would open Safari).

After the last link closes, the app keeps its token and key for 30 s (a copy that restarts tries the link it had first), then makes new ones; a copy whose connection is refused asks again.

Chrome and Edge (Phase 5) carry the same messages over native messaging through a relay helper; only steps 1–4 differ.

## Messages

One JSON object per WebSocket text frame. `k` names the kind. Unknown kinds are ignored by both ends. Numbers are JSON numbers; ids are integers.

### Copy → app

| `k` | Fields | Meaning |
|---|---|---|
| `hello` | `v: 2`, `epoch`, `profile`, `browser`, `owner`, `ext`?, `instanceId`?, `origin`?, `since`?, `pid`? | Who this copy is. `profile`: a stable id of the browser profile, 1–64 of `A-Z a-z 0-9 _ . : -` (made once and stored by the copy). `browser`: `safari`, `chrome` or `edge`. `owner`: true only for the copy in charge of its profile's state; a hello with `owner` false is closed (1008). `pid`: the browser's process, if known (Chrome's helper knows it). A second link for the same profile replaces the first (the first is closed, "replaced"). |
| `snapshot` | `epoch`, `seq`, `state`, `windows` | The whole state: `state` is the stored values as pages read them before `shared/stored.js fromStorage` (`openTabs`, `spaces`, `pins`, `folders`, `archive`, `settings`, `favicons`, …), left out: `uiTheme` (sent as `theme`). `windows`: as in `windows`. Sent after `hello` and after every `resync`. |
| `delta` | `epoch`, `seq`, `changes`, `favicons`? | Changed stored values, as `storage.onChanged` gives them: `{ key: { newValue } }`, and `{ key: {} }` for a key removed. Site icons go as a diff instead of in `changes`: `favicons: { set: { site: entry }, del: [site] }`. |
| `windows` | `epoch`, `seq`, `list` | Every window of this copy: `{ windowId, left, top, width, height, state, focused, activeTabId }`, from `windows.getAll()`. Bounds in points from the top left of the main display (as `windows.get` reports them). `state`: `normal`, `fullscreen`, `maximized`, `minimized`. Sent whenever any of it changes (created, removed, moved, resized, focus, state). |
| `theme` | `epoch`, `id`, `transfer`, `part`, `parts`, `size`, `data` | One piece of the active theme package (see Chunks). Sent after the first snapshot and whenever the active theme or its files change. |
| `push` | `epoch`, `windowId`?, `msg` | Something for one window's UI (no `windowId`: every window's), e.g. `{ type: 'switching', tabId }`. |
| `reply` | `id`, `ok`, `result`? / `error`?, `stale`? | The answer to the app's `req` with that `id`: what the background's handler returned, as a page's `runtime.sendMessage` gets it. |
| `tock` | `at` | The answer to `tick`. |
| `bye` | `why` | The copy is going (turned off, updating). |

`seq` counts `snapshot`, `delta` and `windows` together, from 1 in each epoch, one up each time. A `snapshot` may come with any `seq`; the app takes it and counts on from it.

### App → copy

| `k` | Fields | Meaning |
|---|---|---|
| `welcome` | `v: 2`, `key` | First, see Transport. |
| `tick` | `at` | Every 5 s. Answer with `tock`. |
| `req` | `id`, `epoch`, `windowId`, `type`, `payload`, `at` | An action from the UI drawn for `windowId` (null: no window): run the background's handler `type` (`background/handlers.js`: `activateTab`, `setSpace`, `navigate`, `closeTab`, …) with `payload`, and answer with `reply { id }`. Handlers that use `sender.tab.windowId` should use `windowId` here. A `req` of another epoch is answered `ok: false`. The app gives up after 15 s. |
| `setLayout` | `epoch`, `windowId`, `seq`, `insets`, `radius`, `radii`, `container`, `mode`, `at` | Where the theme put the page in that window (its `<m-page>` content box): `insets: { left, top, right, bottom }` from the **window's** edges, in points (the overlay is exactly over the window), rounded to half a point; `radius`/`radii` the slot's inner corners (top-left, top-right, bottom-right, bottom-left); `container: { width, height }`, the window's size it was measured at (only a layout measured at the window's current size is sent); `mode`: `fullscreen` or `windowed`. `seq` counts up per window per epoch; only a change is sent. The copy keeps the latest per window and gives it to that window's pages as their box. The page box's insets are from the page's viewport, so the copy subtracts where the viewport sits in the window (a toolbar shown above the page in full screen, for instance). No reply. |
| `resync` | `epoch` | A `seq` was missed: send a `snapshot`. Sent again every 2 s until one comes. |
| `theme` | as above | The app may send a theme the same way (once it holds user themes, step 3). |
| `bye` | `why` | The app is quitting. |

### Liveness

The app ticks every 5 s and closes a link it hasn't heard anything from for 12 s (1001). A copy should do the same: if no `tick` comes for 12 s, close and ask again (step 1).

### Sizes

- Nothing the app sends is over **1 MB** of UTF-8 JSON (Chrome closes a native port on a bigger message from the host; the same cap is kept for Safari). The app refuses to send a bigger one rather than send it.
- The app takes messages up to 64 MB (a first snapshot holds every site icon).

### Chunks

A theme package is sent as the UTF-8 JSON of `{ id, manifest, html, css, files: { path: base64 } }` (`background/theme-package.js` ThemeMessage), cut into pieces of at most 512 KB of bytes, each sent as `theme { id, transfer, part, parts, size, data }`: `transfer` the SHA-256 (64 lower-case hex) of the whole, `part` from 0, `parts` 1–64, `size` the whole's bytes, `data` the piece as base64. Pieces may come in any order. A piece with another `transfer` starts over (the older one is dropped). The whole is used only if its size and SHA-256 match, and it's at most 8 MB. The receiver checks the package again as any theme (`ui/theme-loader.js loadTheme`).

## What the app does with it

- One mirror per link (`StateMirror.swift`); deltas apply in order; a gap asks for a resync, and until the snapshot comes, deltas are ignored.
- Windows: matched to the window server's by bounds, with focus and being on screen to break ties (`WindowMatcher.swift`). A full-screen window of a linked copy gets an overlay drawing the theme once the copy's state and theme are here.
- Each overlay's page gets the stored values and passes changes on as they come (`extension/ui/host-app.js`); its actions come back as `req` for its window; its layout goes out as `setLayout`.
