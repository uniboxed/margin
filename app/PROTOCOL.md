# The link between Margin's extension and Margin.app, version 2

What each end says, in order. The app's end is `app/shell/` (`ExtensionLink.swift`, `LinkMessage.swift`, `Chunks.swift`, `StateMirror.swift`, `Shell.swift`); the extension's end is `extension/background/link.js` (with `background/app-link.js`, and what pages read in `shared/app-link.js`). `tools/app-tests/fake-extension.mjs` is a working stand-in for the extension's end, `tests/fake-app.js` one for the app's.

Version 1 was `feat/native-panel`'s (one link, a `cover` lease for the sidebar panel). Version 2 has one link per browser profile, no lease, `setLayout`, and chunked themes.

## Words

- **Copy:** one running instance of Margin's extension. Safari runs one copy per profile, each with its own background and its own link.
- **Link:** one copy's WebSocket to the app, after `hello`. It's known by its browser and profile (`"safari:<profile>"`).
- **Epoch:** a random id the copy makes for each link (each socket). Everything numbered or answered belongs to one epoch.

## Transport (Safari)

0. **The port.** Safari's background is a page (`background.scripts`, non-persistent). The copy that owns its profile's state opens one lasting `runtime.connectNative` port at its start and posts `{ type: 'ping', at }` on it every 20 s (Phase 0: a port used that often keeps Safari's background page alive; a WebSocket alone doesn't). The handler only answers a ping. What the app dispatches into the extension arrives on this port as `{ name, userInfo: { e: <JSON string> } }`.
1. **Ask.** The copy sends a native message `{ type: 'wantLink', nonce }` (`runtime.sendNativeMessage`). `nonce`: 1–128 characters, new each time. The extension handler (`app/safari/SafariWebExtensionHandler.swift`) passes on only `{ type, nonce }`, as the distributed notification `io.tirth.margin.setup` (any process may hear it, so nothing secret goes in it). Its reply: `{ ok, appOpen, launching }`. If Margin.app isn't running, the handler starts it (`NSWorkspace.openApplication`, not activated; at most once per 10 s per handler process), leaving a note in its own container (`Library/Caches/margin-launch`) that the app reads at launch to show no set-up window (a sandboxed caller's `arguments` never reach the app) and says `launching: true`; the notification is lost while the app starts, so the copy asks again every 0.5 s for 10 s (and at once on `appUp`). `appOpen: false` and not launching: the app is gone.
2. **Answer.** The app answers into the extension with `SFSafariApplication.dispatchMessage(withName: 'link', userInfo: { e: <JSON string> })`, the JSON being `{ v: 2, nonce, port, token, key, app: { version }, at }`. A copy takes only the answer carrying its own nonce (with several profiles, every copy may receive it).
3. **Connect.** The copy opens `ws://127.0.0.1:<port>/?t=<token>`. The app refuses (HTTP 403, before any WebSocket opens) a wrong token, a path other than `/`, and an `Origin` that isn't `safari-web-extension://…`. It listens on 127.0.0.1 only.
4. **Welcome.** The app's first message is `{ k: 'welcome', v: 2, key }`. The copy closes the socket unless `key` is the one from step 2 (the app proving it's the app).
5. **Hello.** The copy's first message is `hello` (below), then its `snapshot`. A socket that says nothing within 5 s of opening is closed.
6. **App up.** When the app starts while Safari has been running for 2 s, it dispatches `appUp { v: 2, at }`: every copy should ask again (step 1). The app never dispatches while Safari isn't running (that would open Safari).
7. **Kept.** The copy keeps `{ port, token, key }` in `storage.session` once welcomed: its background starting again tries that first (0.4 s), then asks.
8. **Again.** A drop (the socket closed, or nothing from the app for 12 s) is tried again with the kept link after 0.25, 0.5, 1, 2 and 4 s, then asked for (step 1), then every 5 s doubling to 60 s, and whenever a page starts. After the app's `bye`, only `appUp` or a page starting asks again soon.
9. **No socket where it would hang.** The copy makes a WebSocket only in a document (a worker's hangs WebKit's background: `feat/native-panel`, 2026-10-30), and notes each socket it opens (storage.local `appLinkOpening`) until the constructor returns: a background that finds the note left turns the link off for that version of Margin (`appLinkOff`).

After the last link closes, the app keeps its token and key for 30 s (a copy that restarts tries the link it had first), then makes new ones; a copy whose connection is refused asks again.

Chrome and Edge (Phase 5) carry the same messages over native messaging through a relay helper; only steps 1–4 differ.

## Messages

One JSON object per WebSocket text frame. `k` names the kind. Unknown kinds are ignored by both ends. Numbers are JSON numbers; ids are integers.

### Copy → app

| `k` | Fields | Meaning |
|---|---|---|
| `hello` | `v: 2`, `epoch`, `profile`, `browser`, `owner`, `ext`?, `instanceId`?, `origin`?, `since`?, `pid`? | Who this copy is. `profile`: a stable id of the browser profile, 1–64 of `A-Z a-z 0-9 _ . : -` (made once, `p-` and 20 letters or digits, and kept in storage.local `dataMeta:link` with `acked`; Safari wiping the profile's storage makes a new one). `browser`: `safari`, `chrome` or `edge`. `owner`: true only for the copy in charge of its profile's state; a hello with `owner` false is closed (1008). `pid`: the browser's process, if known (Chrome's helper knows it). A second link for the same profile replaces the first (the first is closed, "replaced"). |
| `snapshot` | `epoch`, `seq`, `state`, `windows` | The whole state: `state` is the stored values as pages read them before `shared/stored.js fromStorage` (`openTabs`, `spaces`, `pins`, `folders`, `archive`, `settings`, `favicons`, …), left out: `uiTheme` (sent as `theme`). `windows`: as in `windows`. Sent after `hello` and after every `resync`. |
| `delta` | `epoch`, `seq`, `changes`, `favicons`? | Changed stored values, as `storage.onChanged` gives them: `{ key: { newValue } }`, and `{ key: {} }` for a key removed. Site icons go as a diff instead of in `changes`: `favicons: { set: { site: entry }, del: [site] }`. |
| `windows` | `epoch`, `seq`, `list` | Every window of this copy: `{ windowId, left, top, width, height, state, focused, activeTabId }`, from `windows.getAll()`. Bounds in points from the top left of the main display (as `windows.get` reports them). `state`: `normal`, `fullscreen`, `maximized`, `minimized`. Sent whenever any of it changes (created, removed, moved, resized, focus, state). |
| `theme` | `epoch`, `id`, `transfer`, `part`, `parts`, `size`, `data` | One piece of the active theme package (see Chunks). Sent after the first snapshot and whenever the active theme or its files change. |
| `push` | `epoch`, `windowId`?, `msg` | Something for one window's UI (no `windowId`: every window's): `{ type: 'switching', tabId }` and `{ type: 'switch-done' or 'switch-failed', tabId }` (a switch the copy makes there, as pages are told); `{ type: 'palette', newTab }` (open the palette in that window's overlay: Safari's own New Tab made a tab the copy closed again, or Margin's new-tab page came up); `{ type: 'keyHeard', command, from: 'command' or 'page' }` (a key the app holds reached the extension anyway: nothing was done; for the app's diagnostics). |
| `keys` | `epoch`, `bindings` | The combinations for the app's hot keys: `{ 'next-tab', 'prev-tab', 'next-space', 'prev-space', 'palette', 'toggle-sidebar': [combination] }`, written as Settings writes them (`Ctrl+Meta+ArrowDown`: `shared/shortcuts.js`). From the Settings shortcuts and, in Safari, the manifest commands' keys too (pages take both); the palette is always `Meta+KeyT`. Sent after the snapshot and whenever the settings change. The app holds the front window's copy's keys (`Shortcuts.swift`), its defaults until a copy says. |
| `data.hello`, `data.snapshot`, `data.changes` | `epoch`, `profile`, … | The data messages (`DATA.md`): `data.hello { format, acked, rev?, queue }` after the keys (`rev`: the app's set revision the cache matches, left out when it has none), `data.snapshot { format, set, transfer, part: 0, parts: 1 }` (the converter's, whole) when the app asks with `data.need`, `data.changes { changes }` as this copy writes them while linked. |
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
| `data.need`, `data.snapshot`, `data.changes`, `data.ack` | per `DATA.md` | `data.need { all: true }`: answered with the converter's `data.snapshot`. `data.snapshot { format, set, transfer, part, parts, rev?, omitted? }`: once all `parts` of a `transfer` are here, their items put together, with this copy's changes since its `data.hello` merged on top and the items in part 0's `omitted` kept as the copy has them, it's the copy's cache (`stateFromDataSet`, the app's times kept for what agrees with it, so none of it is queued back); part 0's `rev` is kept once it's applied. `data.changes { changes }`: merged into the cache by the same rule as the app's. `data.ack { upTo, rev? }`: `upTo` kept as `acked` (never lower), `rev` when there is one. The app's data messages carry this link's `epoch` and the copy's `profile`; others are left. They're taken in the order they came. The `rev` is dropped when the cache stops being the app's set (storage that started from defaults). |
| `theme` | as above | The app may send a theme the same way (once it holds user themes, step 3). |
| `bye` | `why` | The app is quitting. |

The `req` types the copy runs for the app (`link.js APP_REQUESTS`) are what the UI's actions, palette rows and keys ask (`activateTab`, `closeTab`, `newTab`, `pinTab`, `unpin`, `moveTabToSpace`, `moveTab`, `openPin`, `movePin`, `setFolderOpen`, `createFolder`, `renameFolder`, `deleteFolder`, `moveFolder`, `setSpace`, `createSpace`, `renameSpace`, `deleteSpace`, `clearToday`, `goBack`, `goForward`, `reload`, `restoreArchive`, `openLauncher`, `newWindow`, `search`, `toggleFullscreen`, `updateSettings`, `updateThemeSettings`, `navigate`, `sidebarScroll`, `setSidebarScroll`, `wakeSleeping`, `windowState`, `cancelNewTab`) and `openHere { tabId, url }` (an address chosen over Margin's new-tab page, opened in that tab). Anything else is answered `ok: false`. The handler's sender is `{ app: true, tab: { windowId } }`, with no tab id.

### Liveness

The app ticks every 5 s and closes a link it hasn't heard anything from for 12 s (1001). The copy does the same: nothing from the app for 12 s and it closes the socket and tries again (Transport, step 8).

### A link dropping

- **The app** (`Shell.swift`) keeps a dropped link's overlays where they are for 6 s, dimmed, with "Reconnecting to Safari…": the copy linking again in that time takes them back as they were (theme and keys kept, the state sent again), else they close. A link replaced by a newer one, a `bye`, or the app quitting closes them at once.
- **The copy** tells its pages (`appLink`, below) `reconnecting` on a drop, and `off` once it's clear the app is gone: 6 s with no link, the handler saying the app isn't running, or the app's `bye` (at once). Only then do pages draw their own UI again.

### What pages know

storage.local `appLink`: `{ state: 'linked' | 'reconnecting' | 'off', epoch, at, layouts: { [windowId]: { insets, radius, radii, container, mode, seq, epoch } } }`, written only by the copy that owns the state (a new state at once, layouts within 0.12 s), and read with every page's state (`shared/app-link.js`). Each window's newest `setLayout` goes there (an older `seq` of the same epoch is left; a closed window's goes), and the window's tab in front is sent `{ type: 'appLayout', windowId, layout }` at once. A page's `hello` answer carries `app: { state, layout }` (null when off). While `linked` or `reconnecting`, pages draw no Margin UI; their box is their window's layout less where the viewport sits in the window: the width the window has beyond the viewport is taken to be on the left (Safari's sidebar), the height on top (its toolbar), in the page's zoomed pixels (`boxFromLayout`). A page that doesn't know its window yet takes the layout every window has, if they agree.

### Keys

While linked, the app owns Margin's keys (Tirth, 2026-11-05): ⌘T and the others are its Carbon hot keys, with the combinations from `keys`, held while a linked browser is in front with an overlay on its front window; ⌘T opens the palette in the overlay with no round trip through the browser. The extension's own `new-tab` (⌘T), `open-palette` and `toggle-sidebar` commands, and a page hearing ⌘T, do nothing visible while the app draws (they `push` `keyHeard`); the navigation commands still navigate (that draws nothing). Not linked, the extension's keys work as before (the in-page development host).

### Settings and the new-tab page

While linked, Margin's new-tab page (and its start page and Settings, `#launcher`, `#settings`) draws nothing of its own: the overlay of its window draws the theme's launcher, with its Settings, in the page slot over it, while that page is the window's tab in front (`ui/host-app.js`). An address chosen there opens in that tab (`openHere`); an archived tab restored takes its place. Settings opened from anywhere (`openLauncher { settings: true }`) open that page, so they draw in the overlay too.

### Sizes

- Nothing the app sends is over **1 MB** of UTF-8 JSON (Chrome closes a native port on a bigger message from the host; the same cap is kept for Safari). The app refuses to send a bigger one rather than send it.
- The app takes messages up to 64 MB (a first snapshot holds every site icon).

### Chunks

A theme package is sent as the UTF-8 JSON of `{ id, manifest, html, css, files: { path: base64 } }` (`background/theme-package.js` ThemeMessage), cut into pieces of at most 512 KB of bytes, each sent as `theme { id, transfer, part, parts, size, data }`: `transfer` the SHA-256 (64 lower-case hex) of the whole, `part` from 0, `parts` 1–64, `size` the whole's bytes, `data` the piece as base64. Pieces may come in any order. A piece with another `transfer` starts over (the older one is dropped). The whole is used only if its size and SHA-256 match, and it's at most 8 MB. The receiver checks the package again as any theme (`ui/theme-loader.js loadTheme`).

## What the app does with it

- One mirror per link (`StateMirror.swift`); deltas apply in order; a gap asks for a resync, and until the snapshot comes, deltas are ignored.
- Windows: matched to the window server's by bounds, with focus and being on screen to break ties (`WindowMatcher.swift`). A full-screen window of a linked copy gets an overlay drawing the theme once the copy's state and theme are here.
- Each overlay's page gets the stored values and passes changes on as they come (`extension/ui/host-app.js`); its actions come back as `req` for its window; its layout goes out as `setLayout`.
