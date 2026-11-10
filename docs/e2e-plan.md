# The e2e suite, rewritten: plan

2026-11-06, branch `test/e2e-rewrite` (from `feat/margin-app`).

Tirth asked for the e2e suite to be rewritten, and for it to test on pages that look and behave like real sites, not plain text pages.

Today `tests/e2e/` has 48 tests. 45 are skipped since Margin 2 Phase 2 step 5: they drive the in-page UI, which is gone. Three still run (the archive alarm and two smoke checks). The pages they open are one `<h1>` each.

This plan says how the new suite runs, what it opens, what it tests, how fast it is, and the order of the work. The suite only adds tests: no change to `extension/`, `app/` or the themes (Phase 6 works there at the same time).

## 1. The harness

### What's real and what stands in

```text
 Playwright, headless                                    Node (the test process)
 ┌──────────────────────────────┐   native messaging   ┌──────────────────────────┐
 │ Chromium (Chrome for Testing) │ ───────────────────▶ │ native-host.mts (relay)  │
 │  Margin, Safari profile build │   wantLink, pings,   │  stands in for Safari's  │
 │  background, content, newtab  │   logs; `link` back  │  extension handler and   │
 │  the test site's pages        │ ◀─────────────────── │  dispatchMessage         │
 │                               │                      └────────────┬─────────────┘
 │                               │  WebSocket, PROTOCOL v2           │
 │                               │ ─────────────────────▶ ┌──────────▼─────────────┐
 └──────────────────────────────┘                         │ fake Margin.app        │
 ┌──────────────────────────────┐   bridge (exposeBinding)│  link, mirror, theme   │
 │ WebKit: one page per window   │ ◀──────────────────────▶│  pieces, req/reply,    │
 │  dist/app/overlay.html + .js  │  hello, send, layout…   │  drawn, setLayout,     │
 │  (the real overlay, runtime,  │  state, changes, push…  │  keys, ticks, drops    │
 │   host-app.ts and the theme)  │                         └────────────────────────┘
 └──────────────────────────────┘
```

Real, as shipped:

- The extension: `scripts/build.ts buildTo(…, { profile: 'safari', manifest: 'chrome' })`, the Safari profile (`nativeApp`, icon fetching, `sleepTabs: 'close'`, the learned search engine) with Chrome's manifest so Chromium loads it.
- Its link client (`background/link.ts`), all of it: the native port and its pings, `wantLink` and the nonce, the `link` dispatched on the port, the socket with token and key, hello, snapshot, deltas, windows, theme pieces, keys, the data messages, requests, drops and the asks after them.
- Every page script: the page box, the first paint registration, gestures, loads, drafts, keys.
- The overlay page: `dist/app/overlay.html` and `overlay.ts` as built for Margin.app, with `ui/runtime.ts`, `ui/host-app.ts`, the theme loader and the theme package that came over the link. It runs in WebKit, as in the app's `WKWebView`, served with the app's Content Security Policy (`OverlayWebView.swift policy`).

Stand-ins:

- **The extension handler** (`engines/webkit/browsers/safari/app/handler/SafariWebExtensionHandler.swift`) and **`dispatchMessage`**: a Node relay, `tests/e2e/harness/native-host.mts`, run by Chromium as a native messaging host named `io.tirth.margin`. Its manifest goes in `<user-data-dir>/NativeMessagingHosts/`, so nothing is written outside the test's temporary folder. It passes each message to the test over a local TCP socket and writes back what the test says: the reply to `wantLink` (`{ ok, appOpen, launching }`), and `link` or `appUp` into the lasting port.
- **Margin.app's shell**: `tests/e2e/harness/app.js`, in Node, built on `tests/fake-app.ts` (the WebSocket server). It does what `Shell.swift` does for overlays, and nothing of the window server:
  - the mirror: snapshot, deltas in order, the window list;
  - the theme's pieces put together and checked (size and SHA-256), then sent to the overlays;
  - one overlay page per full-screen window of the copy, sized to the window, with the page hello `Shell.hello(for:)` makes (`windowId`, `mode`, `platform`, `state`, `windows`, `across`, `cloudTabs`, `held`, `theme`);
  - the bridge ops of `OverlayWebView.swift` and `Overlay.swift`: `hello`, `send` (a `req` for that window, its `reply` back), `layout` (`drawn on` first, then `setLayout` for a layout measured at the window's size), `hits`, `focus`, `pointerWant`, `perform` and `log` (kept for checks);
  - forwarding as `Shell.forward`: `state`, `changes` (site icons as a diff), `windows` (not a list that differs only in `visible`), `push` (a `palette` held until its overlay is up), `link` (`reconnecting`, then `linked`);
  - the app's keys: a test calls `app.key('palette')` and the overlay gets `{ type: 'command', name: 'palette' }`, as the Carbon hot key sends it; `app.navigate('next-tab')` sends the copy's `navigate` request, as `Shortcuts.swift` does;
  - ticks every 5 s; `drop()` (killed, no close frame), `bye()`, `restart()` (a new port, token and key, then `appUp`), `drawn(windowId, false)`;
  - the data messages: the copy's `data.hello` answered with `data.snapshot` from a fixture when a test seeds one (`shared/data-set.ts dataSetFrom`), else `data.need`; `data.changes` kept for checks. The merge itself is the app's (`tools/app-tests`).

### Evidence (probes, 2026-11-06, in the scratchpad, not committed)

- Chromium is Chrome for Testing 153 (`chromium-1243`). Manifest V2 is gone, so the background can't be a page here: it's the service worker.
- A native messaging host manifest in `<user-data-dir>/NativeMessagingHosts/io.tirth.margin.json` is found by headless Chromium (`--headless=new`). A fixed extension id comes from a `key` added to the test build's manifest (made per run with `crypto.generateKeyPairSync`), so `allowed_origins` is known before launch.
- The test build needs two changes from the Safari-profile build, both in the test's copy only:
  - `nativeMessaging` added to `permissions` (Chrome's manifest has none);
  - the link's socket guard, `canSocket` (`background/link.ts`: no socket in a worker, because WebKit hangs one there), let through. In the minified bundle it's one exact string (`canSocket=()=>typeof globalThis.document=="object"&&typeof globalThis.WorkerGlobalScope>"u"`); the harness replaces it and fails loudly if it isn't found. Chromium's workers open sockets fine. If the string moves, the fallback is a one-line test switch in `link.ts` (a separate, agreed change).
- With those, the real link client linked to `tests/fake-app.ts` 1.0–2.1 s after launch: `hello` (browser `safari`, owner, a profile id), `snapshot` (the eight state keys, one window), `theme` (Arcadia, one piece), `keys`, `data.hello`. The copy's notes came through the port as `{ type: 'log' }`.
- The real overlay in Playwright's WebKit, through the bridge, drew Arcadia with the two tabs. Clicking a row made that browser tab active in 47–65 ms. A switch made in the browser (`chrome.tabs.update`) moved the overlay's highlight in 84–90 ms.
- One switch made in the browser 0.1 s after a click in the overlay took 2.3 s to show in the overlay, and the overlay logged "the highlight went back 1 time". It looks like the runtime's hold on its own switch. A test pins it down (§3, tabs); if it's a bug, it's reported, not hidden.
- Full screen: `chrome.windows.update(id, { state: 'fullscreen' })` works headless, but the window is 800 × 600 unless Chromium gets `--screen-info={1440x900}`. In a normal window the viewport starts 87 px down (the toolbar). The suite runs full screen, as Margin does today.
- The sidebar is hidden (insets 8/8/8/8) until Keep open (`settings.sidebarPinnedOpen`) is on. Seeds turn it on; one test checks the hidden sidebar and peek.
- Local host names work: `--host-resolver-rules="MAP *.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"` let `http://dispatch.test:<port>/` and `http://shop.test:<port>/` load from the test server, `127.0.0.1` still loads, and `http://example.com/` fails with `ERR_NAME_NOT_RESOLVED`. Each site is its own origin, so site icons are stored per site as in real use.
- A whole probe (launch, link, overlay, five switches, two screenshots) took 10 s.

### Why this shape

- It's the closest to Safari that Chromium allows: the extension can't tell the relay from Safari's handler, or the fake shell from Margin.app, except by timing.
- The overlay runs in WebKit, like the app's web view. The pages run in Chromium, because Playwright can't load an extension in WebKit.
- The Swift link (`ExtensionLink.swift`) refuses an Origin that isn't `safari-web-extension://`, and it has no overlays without the whole shell. Its real end is already tested against the real extension by the WebKit host (`app-link`, `link-drop`, `newtab-start`). Here a Node shell is simpler and lets a test reach into every step.

### What stays covered only by `tools/app-tests` and the WebKit host

- **Window matching and Spaces** (`WindowMatcher.swift`, `e2e-windows.swift`): the fake shell binds by window id. There's no window server here.
- **Pointer pass-through over the slot, the overlay panel taking keys without activating, Carbon hot keys** (`PassThrough.swift`, `Shortcuts.swift`, `e2e-keyboard.swift`): native only. Here the test sends the key's result.
- **Profiles across**: the profile switch, window parking and Safari's profile names (`ProfileSwitch.swift`, `e2e-profiles.swift`). One test here checks that `across` from the app is drawn and that a chip of another profile asks the app (`perform profile.switch`).
- **The lasting data on disk** (`DataStore.swift`, `e2e-data.swift`): files, merge, revisions. Here only the copy's side: its queue, adopting the app's set, refilling a wiped cache.
- **iCloud Tabs' reading** of `CloudTabs.db` (`e2e-cloud.swift`). Here the app's `cloudTabs` comes from `tests/fixtures/cloud-tabs.ts`.
- **WebKit's own behaviour** (WebKit host): the background as a page and the socket hang guard, Safari reloading Margin with worlds kept (cut-off notices, `updated-while-open`), tab ids changing on a relaunch, the back/forward cache, pinch, first paint timing in WebKit, Safari's new-tab setting notice.
- **The real Swift link code** (WebKit host `app-link`): tokens, Origin, welcome key, `bye`, kill.

## 2. The test site

`tests/e2e/site/`: a small server (`server.ts`) and a set of pages that look finished. Each site has its own host name under `.test`, served on one port.

### Rules

- Local only. Chromium starts with `--host-resolver-rules="MAP *.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"`: any other host fails to resolve, so nothing leaves the Mac, the extension's own fetches included.
- Search engines (the learned engine, Safari's default Google) are caught with `context.route` and answered with a plain local results page (no engine's name or look). Nothing goes out.
- A guard records every request to a host that isn't `.test` or `127.0.0.1`. A test with one fails.
- Pictures are drawn, not downloaded: SVG scenes and product renders, CSS, canvas. Raster files (PNG, ICO, the audio and the video) are made by `tests/e2e/site/make-media.mts`, from code, the same bytes every time.
- Fonts: system fonts (`-apple-system`, `ui-serif`, `ui-monospace`, `system-ui`). The portfolio uses Space Grotesk and Archivo Black, served from `extension/themes/neo-brutalism/fonts/` (OFL, already in the repo, no copy).
- If a real photo is ever needed: CC0 or public domain only, under 150 KB each, listed in `tests/e2e/site/SOURCES.txt`. The plan doesn't need any.
- Size: the whole site under 2 MB. The video (WebM, VP8, about 6 s, made by recording an animated canvas in headless Chromium with Playwright's `recordVideo`) is the only file over 100 KB. The PNGs, ICOs and the WAV are made in memory when the server starts and aren't committed.
- Pages never log anything. The server logs nothing unless `MARGIN_E2E_VERBOSE` is set.

### Pages

| Host and path | What it is | What it's for |
|---|---|---|
| `margin.test/` | The index: a card per page with its picture and title | A start page; a screenshot of every site at once |
| `dispatch.test/2026/11/the-quiet-city` | A magazine article: hero picture, byline, drop cap, pull quotes, figures, a sticky share bar, related stories | Page box with a sticky bar; long scroll; SVG icon; `theme-color` |
| `dispatch.test/longread` | The same layout with a 180-character title | Long titles in the sidebar and palette |
| `shop.test/` | A shop grid: filters sidebar, 24 product cards with drawn products, a sideways carousel | PNG icon; a sideways scroller for the swipe guard |
| `shop.test/p/canvas-tote` | A product page: gallery, colour swatches, size picker, Add to bag (the title becomes "(1) Bag · …") | Title changes; pins of a product |
| `reel.test/watch` | A video page: player with the local clip, up next list, comments | Media playing keeps a tab awake |
| `docs.test/guide/getting-started` | Docs: sticky sidebar nav, table of contents with scroll spy, code blocks with colours and a copy button, anchors | ICO icon; hash navigation and history; media queries in the box |
| `murmur.test/home` | A social feed: posts with pictures, infinite scroll (more posts load as you near the end), "(3) Murmur" unread title | Scroll in the box; titles that change |
| `metrics.test/` | A dashboard: KPI tiles, line, bar and donut charts (SVG and canvas), live numbers | No icon link: `/favicon.ico` fallback |
| `post.test/inbox` | A mail app: folders, message list, reading pane, compose with a draft (`beforeunload` guard), unread count in title and icon | Drafts keep a tab awake; leaving shows loading |
| `noir.test/` | A dark portfolio: big type, image grid, dark `theme-color` | Dark pages in the box; a bundled font |
| `accounts.test/signin` | A sign-in form: email, password, Remember me, errors; posts to a 302 that lands on a "signed in" page | Redirects; form drafts; a page from a POST |
| `embed.test/` | A page of embeds: same-site frame, another site's frame (`maps.test`), `srcdoc`, sandboxed | Frames and the draft check in frames |
| `slow.test/report` | A report sent in parts over 3 s: shell first, then sections, pictures last | Loading in the sidebar; first paint of a slow page |
| `harbor.test/` | A travel site: fixed top nav, sticky sub-nav, a fixed cookie bar and chat bubble, a modal | Fixed and sticky in the box; scroll locks |
| `focus.test/` | A timer: the title counts down each second, the icon is redrawn (data: URL) | Title and icon updates, throttled for hidden tabs |
| `radio.test/` | A podcast player: `<audio>` with the made-up tune, waveform drawn on canvas, chapters | Audio playing keeps a tab awake |
| `app.test/` | A single-page app: `pushState` routes, the Navigation API with a slow route (700 ms) | Addresses from `pushState`; same-page loading |
| `*.test/missing` | A designed 404 page | Status pages |

Each page shares a small stylesheet per site, not one for all: the sites should look different from each other. Every page has a `<title>`, most have an icon of a different kind (SVG, PNG, ICO, a data: URL, none), several have `theme-color`.

`?fp` on any page adds an inline recorder at the top of `<head>` that notes where `<html>` sits in each of the first frames (as the WebKit host's `/fp/` pages do), for the first-paint tests.

## 3. The tests

Each test saves pictures for a person to look at, under `$MARGIN_E2E_SHOTS/<file>-<test>/` (default `$TMPDIR/margin-e2e-shots`; never in the repo): `page.png` (the browser tab in front), `overlay.png` (the overlay, transparent outside what the theme draws) and `window.png` (the two put together: the overlay, with the page shown in the slot through its rounded corners). For this work it's the scratchpad's `e2e-shots/`.

### The old tests

| File | Test | Decision | Why |
|---|---|---|---|
| smoke | background starts | Keep | Both builds |
| smoke | new tab shows newtab.html | Keep, extend | Linked: the page draws nothing and the overlay draws the launcher over it |
| archive | the alarm is scheduled | Keep | Unchanged |
| archive | stale tabs archived; pinned and active stay | Port | Same steps (`archiveNow`), checked in storage and in the overlay |
| archive | closing from the sidebar archives; the new-tab list restores in place | Rewrite | The × is in the overlay; the archive list is the launcher's, over Margin's new-tab page (`restoreArchive` with `replaceTabId`) |
| archive | archived tabs restorable from the palette into their space | Rewrite | The palette is the overlay's |
| enhancements | Navigation API: a swipe toward no history goes nowhere | Rewrite | Checked as the copy's `push gesture` and the overlay's gesture part |
| enhancements | a slow same-page navigation shows loading | Rewrite | `push loading` and the row's busy mark, on `app.test` |
| favicons | own icon fetched once, 32 × 32, per site | Port | Real icons on `shop.test`; also drawn in the overlay row |
| favicons | no icon link: `/favicon.ico` | Port | `metrics.test` |
| favicons | not an image: rejected, letter stays | Port | The overlay shows the letter |
| favicons | another host's icon over http on a local address refused | Port | Two `.test` hosts |
| favicons | closed pins show the stored icon | Rewrite | The pin row in the overlay |
| loader | leaving a page shows loading at once | Rewrite | `push loading` from `beforeunload`, the row busy |
| loader | the same for a reload | Rewrite | As above |
| loader | a page that stays: loading goes | Rewrite | As above (`post.test` compose asks before leaving) |
| navigation | next/previous tab in order, wrapping | Rewrite | The app's key is `navigate` from the app; the page's ⌥⌘↓ still works in the page |
| navigation | next/previous space and peek; the page doesn't get the keys | Rewrite | Peek is the overlay's |
| navigation | the new-tab page handles the same keys | Rewrite | Linked, the new-tab page draws nothing; its keys still navigate |
| navigation | fast presses all count | Port | Same chain, through `navigate`, with `switching`/`switch-done` pushes |
| navigation | one press through both paths moves once | Rewrite | Linked, the extension's command and the page's key do nothing visible and say `keyHeard`; the app's key moves once |
| navigation | switching by hand restarts the chain | Port | Same |
| palette | "Search for" opens a new tab with Chrome's engine | Rewrite | The Safari profile's learned engine, caught locally; Chrome's engine part dropped (no app for Chrome until Phase 5) |
| newtab | a host:port entry navigates this tab | Rewrite | The launcher in the overlay, `openHere` |
| newtab | other text searches with Chrome's engine | Rewrite | As palette |
| newtab-palette | ⌘N: a new window in the same space, palette open | Rewrite | `newWindow`, a second overlay, the `palette` push |
| newtab-palette | the launcher page opened on purpose stays | Rewrite | `#launcher` over the overlay |
| newtab-palette | palette "New window" | Rewrite | As ⌘N |
| platform | Chrome build: profile, shortcuts, no icon fetching | Rewrite | In `chrome-build.test.ts`, without a launcher |
| platform | upgrading to the Safari build moves ⌃⌘ defaults | Drop | `tests/model.test.ts` covers the rewrite; stopping Chromium's worker tests nothing Safari does |
| platform | Safari: sideways swipes blocked, scrolling not; the setting | Port | In the page; the setting from the overlay's Settings |
| platform | Chrome build: no gesture blocking | Port | `chrome-build.test.ts` |
| search | before Safari searched: Google with Safari's parameters | Rewrite | From the palette, caught locally |
| search | a search on an engine's own site doesn't change it; Safari's own does | Port | Navigations to caught engine addresses |
| search | switching engines right after a Margin search is learned | Port | Same |
| sidebar | lists tabs; a click activates; × closes | Rewrite | The overlay |
| sidebar | pin a tab; the pin focuses or opens it | Rewrite | The overlay's menu |
| sidebar | switching space filters tabs; new tabs join it | Rewrite | The overlay |
| sidebar | exactly one highlighted tab | Rewrite | The overlay, also after a switch made in the browser right after a click (the probe's 2.3 s) |
| scroll | no page bounce while blocking is on; the setting | Port | In the page |
| scroll | pulling at the top shows the indicator and reloads | Rewrite | `push gesture` (pulling, armed, trigger) in the overlay; the reload in the page |
| scroll | the same pull scrolled down, or small, does nothing | Port | No push, no reload |
| scroll | Chrome build: bounce left alone | Port | `chrome-build.test.ts` |
| scroll | two-finger swipe: edge badge, back and forward | Rewrite | `push gesture swipe` in the overlay; history in the page |
| scroll | no swipe over a sideways scroller, small, or off | Port | The shop's carousel |
| spaces | right-click editor; delete needs two clicks, tabs move | Rewrite | The overlay's editor |
| spaces | a tab moved to another space with its menu | Rewrite | The overlay's menu |
| spaces | active space is per window | Rewrite | Two windows, two overlays |

One dropped, three kept, the rest ported (the steps stay, checked through the overlay or storage) or rewritten (new steps through the overlay).

### New tests, by feature

Each file starts its own browser pair and seeds its state (§4). Names are the files.

- **`link.test.ts`**: linking at start (hello, snapshot, theme, keys, data.hello, the overlay drawn, `ready`); the page box at once; linking when the app starts later (`appUp`); Start on Margin's new-tab page (the relay answers `launching`, then links).
- **`tabs.test.ts`**: a click in the overlay shows the tab, and a switch in the browser moves the highlight; one highlight only, also right after a click; × closes and archives; New Tab row opens the palette; drag a row to reorder (`moveTab`); a tab closed meanwhile shows the "no longer open" notice.
- **`spaces.test.ts`**: chips switch spaces; new tabs join the active space; create, rename (inline), colour and delete (two clicks) through the menu and editor; move a tab to another space; per window with two windows; a chip of another profile asks the app (`across`).
- **`pins-folders.test.ts`**: pin from the menu; a pin opens its tab or shows it; unpin; folders: create, rename, open and close, move a pin in and out; closed pins keep their icon.
- **`palette.test.ts`**: the app's key opens it focused; typing ranks real titles ("quiet city" finds the article); arrows and Enter; an address opens; a search goes to the learned engine (caught); archived tabs and pins in results; New window.
- **`newtab.test.ts`**: linked, Margin's new-tab page draws nothing and the overlay draws the launcher in the slot; an address there opens in that tab (`openHere`); an archived tab restored in its place; Settings from the launcher; not linked, the notice and Start; a window the app doesn't draw (`drawn` false): the "hasn't placed this window" notice.
- **`archive.test.ts`**: the alarm; auto-archive (`archiveNow` with a short `archiveAfterHours`) keeps pinned, active and playing tabs; closing archives; restore from the launcher and from the palette into the right space; the overlay's archive list.
- **`icons-titles.test.ts`**: SVG, PNG, ICO, `/favicon.ico` fallback, data: URL, none (letter), a bad icon refused; each drawn in the overlay row; titles that change (the shop bag, the feed's count, the timer) reach the overlay, hidden tabs' changes gathered; long titles cut in the row and the palette.
- **`navigation.test.ts`**: next and previous tab and space through the app's key (`navigate`), in order and wrapping, fast presses chained, by hand restarts the chain; the page's own keys; Back, Forward and Reload from the overlay; `pushState` and hash addresses stored at once; the Navigation API's slow route shows loading.
- **`sleep.test.ts`**: `sleepNow`: an idle tab's browser tab is closed and its Margin tab kept, drawn not open; a click opens it again at its address; the mail draft, the playing radio and the video, and a site on the never-sleep list stay open; a text field in another site's frame keeps a tab awake.
- **`page-box.test.ts`**: on each site, the page sits in the slot (screenshot); `?fp` pages in their box from their first frame; Keep open off and on, and a sidebar resize, move the box live; fixed and sticky headers, the cookie bar, modals and scroll locks stay in the box; the docs' media queries and `vw` units follow the box; frames; the dark portfolio; `drawn` false: no box.
- **`scroll.test.ts`**: wheel scrolling in the box; sticky bars stick at the box's top; the feed loads more as it nears the end; scroll kept across switches; pull to refresh and swipe (above); bounce blocking.
- **`loading.test.ts`**: the slow report while it loads; leaving a page; a page that stays; a reload; all drawn as the row's busy mark.
- **`cloud-tabs.test.ts`**: the app's `cloudTabs` (fixture) drawn as the folder above New Tab; devices open and close; a tab opens as a new tab (`newTab` with its address, a `.test` page); Copy Link asks the app (`copyText`); `noAccess` shows the Full Disk Access row and its button asks `cloud.access`; the setting off hides it; the palette's iCloud section.
- **`data.test.ts`**: the app's set taken as the cache (seed); a wiped profile refilled from the app; changes made while unlinked queued and sent on link (`data.hello` queue); changes while linked sent as `data.changes`.
- **`link-drops.test.ts`**: the app killed: overlay dimmed with "Reconnecting to Safari…", pages keep their box; after 6 s off: no box, the new-tab notice; the app back: relinked, box back, overlay as it was; `bye`: off at once; a new app (new key) after `appUp`; a wrong welcome key refused.
- **`themes.test.ts`**: for each built-in theme (`PACKAGE_THEMES`, so Pixel joins when Phase 6 adds it): switched in Settings, its pieces sent again, the overlay drawn with it, the page box at its gutters; its parts with real content: sidebar, pins and folders, palette with results, launcher with archive, menu, editor, notice, cloud folder, hidden sidebar and peek. Screenshots of each.
- **`chrome-build.test.ts`**: `dist/chromium` alone (no app until Phase 5): background starts, pages get nothing, Chrome's shortcuts, Chrome's icons (no fetching), `chrome.search`, no gesture blocking, bounce left alone.

Rules for every test:

- Wait on a condition, never a fixed time (except the link's 6 s grace, which is the thing tested).
- Each test leaves its tabs as it found them; a file that can't, seeds again.
- A test that finds a product bug stays in, marked `todo` with what it found, and the bug goes to Tirth. It isn't skipped silently.

## 4. Speed

Target: the whole suite in under 4 minutes on Tirth's Mac. Today's suite takes 1 min 49 s for its 3 live tests (a build, then a browser launched in each of 13 files, most of them only to skip).

- One browser pair per file: one Chromium (persistent context, the extension) and one WebKit (the overlays). Tests in a file share them. Launch and link take about 2–3 s per file, so under a minute for 18 files.
- One test build per run: `buildTo` once, then a copy per file only for its manifest key and user data dir (the bundle patch is a string replace, milliseconds).
- The site server: one per file, in the test process (no extra process).
- State: each file seeds through the app's `data.snapshot` at link time (the real path), not by restarting the browser.
- Files run two at a time (`--test-concurrency=2`): they share nothing (own ports, own folders). If the Mac is busy and that flakes, back to one.
- Timing knobs only where the product has them (`sleepNow(ms)`, `archiveNow()`, `archiveAfterHours`); no waiting for real hours.
- Screenshots: PNG, only at the points that matter (about 2–3 per test).
- Measured after each work item; the last item records the time in `TESTING.md`.

## 5. Work items

Each is one commit (`test(e2e): …`), with `npm test`, `npm run test:theme`, `npm run test:app` and `npm run test:e2e` passing first. None touches `extension/` or `tools/webkit-host/`.

1. This plan.
2. The harness: the test build, the native messaging relay, the fake app's shell, overlays in WebKit, screenshots, the network guard; `link.test.ts`; the old helpers' in-page parts removed; `npm run test:e2e` set up (concurrency, `MARGIN_E2E_SHOTS`).
3. The site, part 1: the server and host names, `make-media.mts` (icons, pictures, audio), the index, the article, the shop and product, the docs, the portfolio, sign-in, the fixed and sticky page.
4. The site, part 2: the video (and its script), the feed, the dashboard, mail, embeds, the slow report, the timer, the radio, the single-page app, the 404s, the search stand-in.
5. Tabs and spaces: `tabs.test.ts`, `spaces.test.ts` (the old `sidebar` and `spaces` files go).
6. Pins and folders: `pins-folders.test.ts`.
7. Palette, search and new tab: `palette.test.ts`, `newtab.test.ts` and the search tests (the old `palette`, `search`, `newtab`, `newtab-palette` go).
8. Archive: `archive.test.ts` rewritten.
9. Icons and titles: `icons-titles.test.ts` (the old `favicons` goes).
10. Navigation and history: `navigation.test.ts` rewritten (with the old `enhancements`).
11. Sleeping tabs: `sleep.test.ts`.
12. The page box and scroll: `page-box.test.ts`, `scroll.test.ts` rewritten.
13. Loading: `loading.test.ts` (the old `loader` goes).
14. iCloud Tabs and the data set: `cloud-tabs.test.ts`, `data.test.ts`.
15. Link drops: `link-drops.test.ts`.
16. Themes: `themes.test.ts`.
17. The Chrome build, and the rest: `chrome-build.test.ts` (the old `platform` and `smoke` go), `TESTING.md` and `DECISIONS.md` updated, the timing measured.

## Open questions

- The probe's 2.3 s highlight after a switch made in the browser right after a click in the overlay: a runtime hold, or a bug? Item 5's test says.
- If the `canSocket` string moves with a build change, the harness fails at once. A one-line test switch in `link.ts` would end that; it needs Tirth's OK, as it touches the extension.
- Pixel arrives with Phase 6. `themes.test.ts` picks it up from `PACKAGE_THEMES` without changes here.
