# Margin

An Arc-style sidebar for Safari, built as a Safari Web Extension (prototype). It recreates the feel of Arc inside real Safari:

- **Hover-reveal sidebar** on every website. Move the cursor to the left edge and the sidebar slides in as a floating card over the page. With **Keep open**, it docks: the page shifts right to start where the sidebar ends, inside an Arc-style frame.
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
- **"Keep open" fits pages beside the sidebar by putting them in a frame (Safari, experimental).** Safari can't shrink the page area, so Margin moves each page it loads into a frame of its own tab, sized to the space beside the sidebar. The page is laid out exactly as in a narrower window: pinned headers, full-width sections and mobile breakpoints fit. What it costs:
  - A page appears once its HTML has fully arrived, so pages that stream lose progressive rendering. Until then Safari keeps showing the previous page.
  - Reader, Hide Distracting Items, and other extensions that only work on the top of the page see Margin's frame instead of the page.
  - File → Print prints the frame's view; ⌘P prints the page.
  - Text-fragment links don't highlight. Back without Safari's page cache restores the scroll position but not typed form fields.
  - Sites can tell they're in a frame.
  - Popups, non-HTML documents, quirks-mode pages, pages in other text encodings, and loads where Margin starts too late keep the older push layout: the page shifted right by hand, with pinned headers partly under the sidebar and full-width sections clipped.
  - Turning Keep open on doesn't refit pages that are already open; it applies from their next load.
  - If a site misbehaves, use the palette's "Show this site without fitting it beside the sidebar", or turn off Settings → "With Keep open, fit pages beside the sidebar". Hover mode never moves the page. Auto-hide: ⌥S.
- **Pins are URL-based.** Navigating a pinned tab to another URL makes it a regular tab again.
- **Tabs closed with ⌘W aren't archived.** Only auto-archived tabs and tabs closed with Margin's × are.
- **Unverified in Safari.** Everything was automated-tested in headless Chromium only. See [TESTING.md](TESTING.md) for what needs a manual check.

## Install in Safari, signed (stays on, updates in place)

```sh
npm run safari
```

Builds Margin, signs it with your Apple Developer team, installs it as `~/Applications/Margin.app` and registers it with Safari (`scripts/safari.sh`). Signed, Safari keeps it on, with its data, across relaunches; run the same command again after a change or a `git pull` and Safari takes the new build as an update (nothing to remove or turn on again; pages get the new copy as they're shown). The first time, turn Margin on in Safari → Settings → Extensions and allow it on every website.

The team comes from Xcode → Settings → Accounts (add your Apple ID once; a free Personal Team works), or `MARGIN_TEAM`, or `xcode/.team`. It builds from `xcode/` (made by `scripts/make-xcode.sh` if missing; regenerate it when files under `dist/safari/` are added or removed) and unregisters other Xcode builds of Margin, so Safari has one copy.

## Install for development (temporary extension, no Xcode)

The fastest loop: Safari loads `dist/safari/` straight from the repo (committed, so no Node needed on the Mac). There's no Xcode build and no "Allow unsigned extensions" toggle.

1. Safari → Settings → Advanced → enable **Show features for web developers**.
2. **Develop → Add Temporary Extension…** → choose this repo's `dist/safari/` folder.
3. Safari → Settings → Extensions → Margin → website access **Always Allow on Every Website**.
4. Safari → Settings → General → **New tabs open with** → **Margin**.

**After `git pull`:** reload Margin from Safari → Settings → Extensions (or remove it and add the folder again), then reload open pages. After editing files yourself, run `npm run build` first. A temporary extension doesn't survive quitting Safari, so add it again after a relaunch.

**Don't run both copies.** If the Xcode-built Margin app is also installed, turn that one off in Safari → Settings → Extensions. Two copies keep separate spaces, pins, and archives, and fight over the new-tab page.

## Building for Safari (local, macOS)

Only needed for a real installable app (or if your Safari has no "Add Temporary Extension…"). The Xcode build is unsigned, so it also needs Safari → Settings → Developer → **Allow unsigned extensions**, which resets every time Safari quits.

The Xcode project is generated locally and not committed (`xcode/` is git-ignored). From the repo root:

```sh
scripts/make-xcode.sh
open xcode/Margin/Margin.xcodeproj
```

The script runs Apple's converter:

```sh
xcrun safari-web-extension-converter dist/safari --project-location xcode --app-name Margin --bundle-identifier io.tirth.margin --macos-only --swift --no-open
```

It then fixes the bundle IDs. The converter names the app `io.tirth.Margin` (capitalized from the app name) but the extension `io.tirth.margin.Extension`, and Xcode refuses to build with "Embedded binary's bundle identifier is not prefixed with the parent app's bundle identifier." The script sets the app to `io.tirth.margin`, the extension to `io.tirth.margin.Extension`, and `extensionBundleIdentifier` in the app's Swift code to match, then prints all three (and the app's own ID in the extension handler).

In Xcode, choose the **Margin (macOS)** scheme and Run (⌘R). Safari picks up the extension from the app. If signing complains, set the same Team (your Personal Team, or "Sign to Run Locally") on both targets under Signing & Capabilities.

**The set-up window.** Margin's app opens a window that walks through what Safari needs (Margin on, allowed on every website, new windows and tabs opening Margin, ⌘T freed for Margin) and checks each step as you go, with tests to run in Safari; plus recommended steps and the shortcuts. Its code is in `app/safari/` (SwiftUI in the converter's window, and the extension handler), copied into the generated project by the script. The checks come from the extension through native messaging, so they need this packaged app: a temporary extension can't report to it. Chrome and Edge come later.

**After pulling new changes,** re-run `scripts/make-xcode.sh` and Run again. That's always safe, and needed whenever files under `dist/safari/` are added or removed. For edits to existing files, just Run again in Xcode and reload pages in Safari. If Safari still shows old behavior, regenerate.

## Architecture

```
extension/              The one shared source, as ES modules (browsers load the bundles in dist/)
  manifest.json         MV3: tabs, storage, alarms, scripting; <all_urls>; newtab override; commands
  shared/platform.js    Per-browser profiles (favicon fetching, default shortcuts); stamped by the build
  background.js         State owner (bundled into a classic service worker): registers every listener.
                        Tab events → pure model → storage.local; routes the UI's messages.
  background/           Its parts: store (load/mutate), handlers (the message protocol), tabs,
                        search-engine, site-icons, registered (the theme, its placeholder, the fitted
                        layout), archive, navigation (next/previous tab and space).
  state/model.js        Pure state functions (no browser APIs), unit tested.
  shared/view.js        Pure "what does the sidebar show for window W" derivation.
  shared/search.js      URL-vs-search, fuzzy scoring, palette ranking.
  shared/shortcuts.js   Shortcut strings ("Alt+KeyK") ↔ key events.
  shared/dom.js         DOM helpers for core and themes (el, closed-shadow hosts, adoptStyles).
  content/main.js       Content-script entry: core, then the palette's wiring once the theme is there.
  content/core.js       Margin on web pages, behavior only: startup, the theme, state and rendering,
                        icons, messages; drives the active theme's view. Its parts by job:
  content/layout.js     Show/hide/dock, the push, the placeholder hand-over, hover, the toggle key.
  content/trackpad.js   Gesture guard, pull-to-refresh, swipe back/forward, pinch zoom (Safari).
  content/loader.js     The page-load pill's timing.
  content/takeover.js   Taking over from a copy of Margin left in the page by an install/update.
  content/palette.js    The palette's shortcut and wiring (the palette itself is the theme's).
  content/shell.js      The fitted layout (registered by the background while "Keep open" is on).
  content/docked/       Arcadium's placeholders at their old path, kept for Safari's stored
                        registrations (generated).
  newtab/               Margin's new-tab page: the ⌘T hand-off, then the active theme's new-tab module.
  themes/               What Margin looks like. Only the active theme's code loads.
    index.js            The themes Margin ships (UI-free registry).
    register.js         How a theme's content bundle hands itself to core (the theme contract).
    arcadium/           The default theme: theme.js (UI-free: defaults, settings, bundle paths),
                        content.js (on web pages: sidebar.js, chrome.js, palette.js), newtab.js +
                        newtab.html, styles/*.css, docked.template.css. assets.js and docked/ are
                        generated by `npm run styles` (CSS and markup as strings, applied
                        synchronously with no fetch; one first-paint placeholder per width).
platform/<browser>/     Manifest overrides per browser (today: the shortcut `commands`)
dist/safari/, dist/chrome/
                        Ready-to-load builds from `npm run build` (generated, committed; a test checks they're current)
scripts/build.js        extension/ + platform/<browser>/ → dist/<browser>/, one esbuild bundle per context
tests/
  *.test.js             node --test unit tests
  e2e/*.test.js         Playwright (headless Chromium) tests that load dist/chrome/ (and a Safari-profile variant) unpacked
```

**Data flow:** the background is the only writer. It mirrors open tabs into `storage.local.tabs` and owns `spaces`, `activeSpaceByWindow`, `tabSpace`, `pins`, `archive`, and `settings`. Content scripts and the new tab render from `storage.local` (instantly, even while the background is asleep), update on `storage.onChanged`, and send typed messages (`activateTab`, `closeTab`, `newTab`, `pinTab`, `unpin`, `openPin`, `setSpace`, `createSpace`, `renameSpace`, `deleteSpace`, `moveTabToSpace`, `restoreArchive`, `updateSettings`, `updateThemeSettings`) to change anything. The background can be unloaded at any time: it serializes writes through one queue, rehydrates from storage on wake, and rebuilds tab→space assignments from pins after a browser restart.

**Isolation:** injected UI lives in closed shadow roots on zero-size `position: fixed; z-index: 2147483647` hosts, so site CSS can't style it and it never changes the page's layout. Key events typed into Margin's UI don't reach the page's own shortcut handlers (except page listeners in the capture phase).

Design decisions and every Safari fallback are in [DECISIONS.md](DECISIONS.md).

## Development

No runtime dependencies. `npm run build` copies `extension/` into `dist/<browser>/` with that browser's manifest overrides and profile, then bundles each context's scripts into one file with esbuild (`content/content.bundle.js`, `background.bundle.js`, `content/shell.bundle.js`, `newtab/newtab.bundle.js`, and per theme `themes/<id>/content.bundle.js` and `themes/<id>/newtab.bundle.js`) and points the manifest and `newtab.html` at them. `extension/` is ES modules (content scripts and Safari's service worker can't load those), so browsers load `dist/`. Run `npm install` once. Node 22+.

```sh
npm run build       # after any change under extension/ or platform/: regenerate dist/ (a test checks it; also runs `styles`)
npm test            # type check (tsc --checkJs, JSDoc types; types/*.d.ts), then unit tests (node --test)
npm run test:e2e    # builds, then Playwright + headless Chromium (uses an installed Chromium; run `npx playwright install chromium` locally if needed)
npm run test:webkit # macOS: Margin's Safari build on WebKit's own extension engine, off screen (tools/webkit-host/README.md)
npm run styles      # after editing a theme's CSS, newtab.html or placeholder template: regenerate its assets.js and docked/ (a test checks it)
npm run icons       # regenerate extension/icons
```

To try it in Chrome: chrome://extensions → Developer mode → Load unpacked → `dist/chrome/` (run `npm run build` after changes), and use the reload icon. Use `dist/chrome/` there: `dist/safari/` fetches site icons Chrome already provides. This is handy for fast iteration; check Safari-specific behavior (favicons, shortcuts, new tab) in Safari.

### Adding a theme

A theme is a folder in `extension/themes/<id>/`, listed in `themes/index.js`:

- `theme.js`: UI-free description (`id`, `name`, `defaults`, `settingsOf(settings)`, the bundle paths `content`/`newtab`, optional `placeholder(settings)`). The background, the state model and the build import it, so it must not import UI code.
- `content.js`: calls `registerTheme({ id, geometry, createPalette, mount })` (`themes/register.js` documents the contract; `themes/arcadium/content.js` is the reference). Core decides when things show; the theme draws them.
- `newtab.js`: `export function mount({ api, self, send, openPalette })`, which builds the whole new-tab page (Settings included).
- `styles/*.css` and `newtab.html` become `assets.js` (`npm run styles`); a `docked.template.css` gives first-paint placeholders (add its widths in `scripts/build-styles.js`).
- Its own settings live in `settings.themes[id]` and change through `updateThemeSettings`.

Themes ship in the extension (MV3 and App Store review allow no downloaded code), and only the active one's code loads.
