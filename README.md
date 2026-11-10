# Margin

An Arc-style sidebar for Safari, built as a Safari Web Extension and a Mac app (prototype). It recreates the feel of Arc inside real Safari.

> **Margin 2 (`PLAN.md`):** Margin.app draws Margin's UI (the sidebar, the palette, menus, notices) in its own windows around each full-screen Safari window, and pages draw none of it. The extension keeps the tabs and their state, puts each page in its box beside the sidebar (from its first frame), puts tabs to sleep and links to the app. The list below and "Known limitations" describe the first prototype's in-page UI; what's built now is in `PLAN.md` §10 and `DECISIONS.md` (the "Margin 2" entries).

- **Hover-reveal sidebar** on every website. Move the cursor to the left edge and the sidebar slides in as a floating card over the page. With **Keep open**, it docks: the page sits beside it in its own box, as in a narrower window, inside an Arc-style frame.
- **Spaces** (emoji chips) that filter the sidebar to that space's tabs, separately in each window. Create, rename, recolor, and delete them inline, and drag tabs onto a chip to move them.
- **Pinned items** per space. A pin focuses its open tab, or reopens the page.
- **Command palette** (default ⌥K): fuzzy search across tabs in every space, pins, and the archive, plus actions and "Open URL / Search for …".
- **Page-load indicator:** an Arc-style dark pill, centered at the top of the page, while a page loads.
- **Resizable:** drag the sidebar's right edge (160–500 px); double-click it to reset.
- **Keyboard navigation:** ⌃⌘↓ / ⌃⌘↑ next/previous tab (sidebar order, wrapping) and ⌃⌘→ / ⌃⌘← next/previous space (the sidebar peeks open so you can see where you landed), in both browsers. These are extension shortcuts, so the browser handles them even when the page doesn't have focus. In Safari, ⌥⌘↓ / ⌥⌘↑ also switch tabs while a page has focus (Settings shortcuts, changeable there). ⌥⌘ can't be an extension shortcut: in Safari it didn't respond, and Chrome refuses it.
- **Custom new-tab page:** search/URL field, the space's pins as tiles, recently archived tabs, and settings.
- **Auto-archive:** tabs left idle for 12 hours (configurable) close into a restorable archive.

No accounts, no sync, no analytics, CDNs, or favicon services. The only requests Margin makes are for the icon of each site you visit, fetched once from that site without cookies, because Safari doesn't give extensions favicons.

## Closest to Arc: optional Safari feature flags

Margin works without these, and checks for each feature before using it. Turned on, they bring it closer to Arc:

| Safari → Settings → Feature Flags | What it changes in Margin |
|---|---|
| **Threaded Time-based Animations** | Smoother sidebar and badge animations on busy pages (animations run off the page's main thread). Nothing changes in Margin's code. |

Leave the others alone, especially Security and Privacy: they're experimental and can break sites. **CSS corner-shape property** in particular: Safari's current (experimental) version draws Arc-style squircle corners as squares, so Margin doesn't use it yet; it has no effect on Margin either way.

Already used where your Safari has them (no flag needed): the Navigation API (swipe only where there's history; a loading pill for in-page navigations of apps that use it), the top layer (the palette and right-click menu stay above a site's own popovers), and switch toggles in Settings.

## Known limitations

Safari extensions can't change Safari's own UI, so Margin works around it:

- **Safari's tab bar stays.** Spaces only filter Margin's sidebar; Safari's tab bar still shows every tab in the window.
- **No sidebar where content scripts can't run:** Safari's internal pages (Start Page, Settings, Favorites), PDFs, other extensions' pages, the Web Inspector, and pages Safari blocks extensions on. On Margin's own new tab, the sidebar is built in.
- **Safari's own sidebar can also open at the left edge, in full-screen windows only.** Resting the cursor at the very edge of a full-screen window reveals Safari's sidebar; extensions can't disable that, and Safari has no setting for it. Avoid it by filling the screen with Window → Fill (or ⌥-click the green button) instead of full screen, or by using Keep open. In full screen, Margin opens from 24px out (10px otherwise), so the cursor rarely reaches the edge.
- **No sidebar while the address bar has focus.** Hover reveal needs the page to receive mouse events, and page shortcuts need the page to have keyboard focus.
- **⌘T, ⌘W, ⌘L, Ctrl+Tab and friends can't be intercepted.** Margin takes over new tabs by replacing the new-tab page instead. Safari focuses its address bar on a new tab, so the launcher field usually doesn't get focus. That's expected.
- **Pages sit in a box beside the sidebar, with no iframe, by means of tricks a page can notice.** Browsers can't shrink the page area, so Margin makes `<html>` the box and scrolls `<body>` inside it, and answers what a page asks about its window for the box: its size, scrolling, pointer positions, media queries and viewport units. There's no per-site off switch: a site that breaks is a bug to report. Keep open and hidden alike, the page stays the tab's own page, so Reader, Find, print and password managers see it as usual.
  - Style sheets from another origin that a page can't read are fetched again by Margin, without cookies, so their queries can be rewritten. Where that fails (a site not granted to Margin in Safari), that sheet's layout goes by the window's width. Under a strict CSP such a sheet moves last in the cascade.
  - A rule on `body` that a site adds later can be masked on the few pages whose own `overflow: visible` Margin has to overrule.
  - Framesets and non-HTML documents have no box: the sidebar floats over them.
  - If Margin is removed while pages are open, they keep the box until they're reloaded.
- **Pinch (Safari).** Safari's own zoom on every page (Margin's own pinch was removed on 2026-11-07: slow next to Safari's). It magnifies the page's whole area, the frame around a page with a box included; Margin's sidebar, drawn by Margin.app, doesn't zoom. Margin's box stays where its layout put it. With Margin's trackpad gestures on (the default), the inward pinch that would open Safari's all-tabs overview is blocked.
- **Pins are URL-based.** Navigating a pinned tab to another URL makes it a regular tab again.
- **Tabs closed with ⌘W aren't archived.** Only auto-archived tabs and tabs closed with Margin's × are.
- **Unverified in Safari.** Everything was automated-tested in headless Chromium only. See [TESTING.md](TESTING.md) for what needs a manual check.

## Install in Safari, signed (stays on, updates in place)

```sh
npm run safari
```

Builds Margin, signs it with your Apple Developer team, installs it as `~/Applications/Margin.app` and registers it with Safari (`scripts/safari.sh`). Signed, Safari keeps it on, with its data, across relaunches; run the same command again after a change or a `git pull` and Safari takes the new build as an update (nothing to remove or turn on again; pages get the new copy as they're shown). The first time, turn Margin on in Safari → Settings → Extensions and allow it on every website.

The team comes from Xcode → Settings → Accounts (add your Apple ID once; a free Personal Team works), or `MARGIN_TEAM`, or `xcode/.team`. It builds from `xcode/` (made by `scripts/make-xcode.sh` if missing; regenerate it when files under `dist/webkit/` are added or removed) and unregisters other Xcode builds of Margin, so Safari has one copy.

## Install for development (temporary extension, no Xcode)

The fastest loop: Safari loads `dist/webkit/` straight from the repo (committed, so no Node needed on the Mac). There's no Xcode build and no "Allow unsigned extensions" toggle.

1. Safari → Settings → Advanced → enable **Show features for web developers**.
2. **Develop → Add Temporary Extension…** → choose this repo's `dist/webkit/` folder.
3. Safari → Settings → Extensions → Margin → website access **Always Allow on Every Website**.
4. Safari → Settings → General → **New tabs open with** → **Margin**.

**After `git pull`:** reload Margin from Safari → Settings → Extensions (or remove it and add the folder again), then reload open pages. After editing files yourself, run `npm run build` first. A temporary extension doesn't survive quitting Safari, so add it again after a relaunch.

A temporary extension can't link to Margin.app (the link needs the packaged extension handler), so it draws no sidebar: use `npm run safari` for Margin 2.

**Don't run both copies.** If the Xcode-built Margin app is also installed, turn that one off in Safari → Settings → Extensions. Two copies keep separate spaces, pins, and archives, and fight over the new-tab page.

## Building for Safari (local, macOS)

`npm run safari` (above) is the way: it makes the Xcode project when it's missing or out of date, builds, signs and installs. What it runs, for doing it by hand: the Xcode project is generated locally and not committed (`xcode/` is git-ignored). From the repo root, after `npm run build`:

```sh
scripts/make-xcode.sh
open xcode/Margin/Margin.xcodeproj
```

The script runs Apple's converter on the Safari build:

```sh
xcrun safari-web-extension-converter dist/webkit --project-location xcode --app-name Margin --bundle-identifier io.tirth.margin --macos-only --swift --no-open
```

It then fixes the bundle IDs (the converter names the app `io.tirth.Margin`, the extension `io.tirth.margin.Extension`, and Xcode refuses an extension whose ID isn't prefixed by the app's: the script sets the app to `io.tirth.margin` and `extensionBundleIdentifier` in the app's Swift to match), turns the app's App Sandbox off (Developer ID: it listens on 127.0.0.1), and adds Margin.app's own code: `app/platforms/macos/startup/` (the set-up window, the app delegate, the extension handler), `app/platforms/macos/shell/` (the link to the extension, window tracking, the overlays drawn around the browser's windows, the data store) and the overlays' page (`dist/app/`, built from `app/shared/host/` and `extension/ui/`). Choose the **Margin (macOS)** scheme and Run (⌘R), with the same Team on both targets under Signing & Capabilities.

**After pulling new changes,** re-run `npm run safari`. By hand: re-run `scripts/make-xcode.sh` whenever files under `dist/webkit/` or `app/` are added or removed, else just Run again in Xcode.

**The set-up window.** Opened by hand, Margin.app shows a window that walks through what Safari needs (Margin on, allowed on every website, new tabs opening Margin, Full Disk Access for Safari's profile names) and checks each step as you go. Started by the extension, it runs in the background with no window and no Dock icon, and quits a while after the last browser has gone.

## Architecture

Margin 2 (`PLAN.md`): Margin.app draws all of Margin's UI around each browser window; the extension owns the live tab state and does what only a page or the browser can.

```
extension/              The extension's shared source, as ES modules (browsers load the bundles in dist/)
  manifest.json         MV3: tabs, storage, alarms, scripting, webNavigation; <all_urls>; newtab override; commands
  shared/capabilities.ts    Per-browser profiles (favicon fetching, sleeping tabs, default shortcuts); stamped by the build
  background.ts         State owner: registers every listener. Tab events → pure model → storage.local;
                        routes pages' and Margin.app's requests.
  background/           Its parts: store, handlers (the message protocol), link and app-link (Margin.app),
                        tabs (the plain switch, opening, the open-tab repair), navigation, sleep, archive,
                        registered (the page's first paint), notices, page-loads, switch-log (lines in
                        Margin.app's log), cut-off, site-icons, search-engine, theme-package.
  state/model.ts        Pure state functions (no browser APIs), unit tested: tabs, kept tabs, spaces, pins, folders.
  shared/               Pure helpers: view (what the sidebar shows), search, shortcuts, stored (storage
                        format), data-set and data-merge (the data Margin.app owns), page-box (the box's CSS
                        and the first paint's), page-css, app-link, sleep, notices, gestures, pull.
  content/core.ts       Margin on web pages, no UI: the box from Margin.app's layout, gestures, the
                        draft check, navigation keys and ⌘T, icons and zoom, copies standing back.
  content/page/         The page's box in the page's own world (one bundle, registered while Margin.app draws).
  newtab/               Margin's new-tab page: drawn by Margin.app while linked; else a notice and an address field.
  ui/                   The UI runtime (view model, renderer, sanitizer, actions, behaviors), run by Margin.app's
                        overlay page (ui/host-app.ts) and by the browser tests (ui/host.ts).
  themes/<id>/          Theme packages (theme.json, theme.html, theme.css, fonts), first-paint.css: see themes/README.md.
  engines/              What differs per browser (engines/README.md): webkit/safari/ and chromium/, each its manifest,
                        capabilities (what the browser can do) and own modules; gecko/ later. Each build takes only its own.
app/                    Margin.app on every OS: shared/ (core/ in Rust, connector/ for Chrome and Edge in Rust,
                        host/ the page drawn over each browser window); platforms/ each OS's own code: macos/ (shell/,
                        private/, startup/: Swift), windows/ (Rust), linux/ later; engines/ its per-browser side (webkit/safari/: Safari's Swift
                        and extension handler; chromium/: the browsers' host files, Rust).
docs/                   PROTOCOL.md (the link's protocol), HANDOFF.md, DATA.md, PRIVATE-APIS.md, windows/.
Cargo.toml              The Rust workspace (app/shared/core, app/shared/connector, app/platforms/windows, app/engines/chromium).
dist/webkit/, dist/chromium/, dist/app/
                        Builds from `npm run build`, one per engine, each with only its own engine's code (generated,
                        not committed): Safari loads dist/webkit/; Chrome and Edge, dist/chromium/
scripts/                build.ts, safari.sh (install), make-xcode.sh, rust-test.sh, margin-log.sh (`npm run log:app`)
tests/                  *.test.js unit tests; theme/ browser tests of the runtime and themes (Playwright);
                        e2e/ the real extension linked to a stand-in Margin.app, the real overlay, a local test site
tools/                  webkit-host/ (Safari's extension engine, off screen), app-tests/ (Margin.app's checks)
```

**Data flow:** the background is the only writer of the extension's storage, which pages read (their tab, window and settings) and Margin.app gets as a snapshot and deltas over the link. On the Mac the lasting data (spaces, pins, folders, Margin's tabs, the archive, settings, icons) is Margin.app's, in `~/Library/Application Support/Margin/`; the extension's copy is a cache (`docs/DATA.md`). The background can be unloaded at any time: it serializes writes through one queue and rehydrates from storage.

Design decisions and every Safari fallback are in [DECISIONS.md](DECISIONS.md).

## Development

`npm run build` copies `extension/` into `dist/<browser>/` with that browser's manifest overrides and profile, writes the first paint's files, bundles each context's scripts into one file with esbuild (`content/content.bundle.js`, `background.bundle.js`, `content/page.bundle.js`, `newtab/newtab.bundle.js`) and builds Margin.app's overlay page into `dist/app/`. Run `npm install` once. Node 22+.

```sh
npm run build       # after any change under extension/, platform/ or app/shared/host/: regenerate dist/ (a test checks it)
npm test            # type check (tsc, TypeScript 7; types/*.d.ts), then unit tests (node --test, from the .ts files)
npm run test:theme  # the UI runtime and the themes in headless WebKit and Chromium
npm run test:app    # Margin.app's shell: unit checks and end to end against a fake extension, off screen
npm run test:webkit # Margin's Safari build on WebKit's own extension engine, off screen (tools/webkit-host/README.md)
npm run test:e2e    # the whole thing in headless Chromium and WebKit, on a local site of realistic pages (TESTING.md)
npm run log:app     # Margin.app's and the extension's lines in the system log
npm run icons       # regenerate extension/icons
```

### Adding a theme

A theme is HTML and CSS, no JavaScript: a package in `extension/themes/<id>/` (`theme.json`, `theme.html`, `theme.css`, bundled fonts), listed in `themes/packages.ts`, with its look at a page's first paint in `first-paint.css`. `extension/themes/README.md` is the guide.
