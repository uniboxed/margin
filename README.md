# Margin

An Arc-style sidebar for Safari, built as a Safari Web Extension (prototype). It recreates the feel of Arc inside real Safari:

- **Hover-reveal sidebar** on every website. Move the cursor to the left edge and the sidebar slides in over the page.
- **Spaces** (emoji chips) that filter the sidebar to that space's tabs, separately in each window. Create, rename, recolor, and delete them inline, and drag tabs onto a chip to move them.
- **Pinned items** per space. A pin focuses its open tab, or reopens the page.
- **Command palette** (default ⌥K): fuzzy search across tabs in every space, pins, and the archive, plus actions and "Open URL / Search for …".
- **Custom new-tab page:** search/URL field, the space's pins as tiles, recently archived tabs, and settings.
- **Auto-archive:** tabs left idle for 12 hours (configurable) close into a restorable archive.

No accounts, no sync, no network requests of its own: no analytics, CDNs, or favicon services.

## Known limitations

Safari extensions can't change Safari's own UI, so Margin works around it:

- **Safari's tab bar stays.** Spaces only filter Margin's sidebar; Safari's tab bar still shows every tab in the window.
- **No sidebar where content scripts can't run:** Safari's internal pages (Start Page, Settings, Favorites), PDFs, other extensions' pages, the Web Inspector, and pages Safari blocks extensions on. On Margin's own new tab, the sidebar is built in.
- **No sidebar while the address bar has focus.** Hover reveal needs the page to receive mouse events, and page shortcuts need the page to have keyboard focus.
- **⌘T, ⌘W, ⌘L, Ctrl+Tab and friends can't be intercepted.** Margin takes over new tabs by replacing the new-tab page instead. Safari focuses its address bar on a new tab, so the launcher field usually doesn't get focus. That's expected.
- **Overlay, not a split.** The sidebar floats over the page rather than shrinking it, because resizing the page breaks fixed headers, modals, and sticky elements on many sites.
- **Pins are URL-based.** Navigating a pinned tab to another URL makes it a regular tab again.
- **Tabs closed with ⌘W aren't archived.** Only auto-archived tabs and tabs closed with Margin's × are.
- **Unverified in Safari.** Everything was automated-tested in headless Chromium only. See [TESTING.md](TESTING.md) for what needs a manual check.

## Install (local, unsigned)

1. Build the app (below).
2. Follow the one-time Safari setup in [TESTING.md](TESTING.md#one-time-setup): turn on developer features, **Allow unsigned extensions** (resets every time Safari quits), enable Margin in Safari → Settings → Extensions, grant **Always Allow on Every Website**, and set Safari → Settings → General → **New tabs open with** → **Margin**.

## Building for Safari (local, macOS)

The Xcode project is generated locally and not committed (`xcode/` is git-ignored). From the repo root:

```sh
xcrun safari-web-extension-converter extension --project-location xcode --app-name Margin --bundle-identifier io.tirth.margin --macos-only --swift --no-open
```

Then open `xcode/Margin/Margin.xcodeproj`, choose the **Margin (macOS)** scheme, and Run (⌘R). Safari picks up the extension from the app.

**After pulling new changes:**

- **Edits to existing files under `extension/`:** Run again in Xcode, then reload open pages in Safari. If Safari still shows old behavior, the project copied the files instead of referencing them, so regenerate it (next point).
- **Files added or removed under `extension/`** (check `git diff --stat ORIG_HEAD -- extension`): regenerate the project with `rm -rf xcode`, re-run the converter command above, then Run. Then enable Margin again in Safari → Settings → Extensions if Safari asks.

## Architecture

```
extension/
  manifest.json         MV3: tabs, storage, alarms; <all_urls>; newtab override; commands
  background.js         State owner (classic service worker; loads state/model.js via importScripts). Tab events → pure model → storage.local.
                        Message router for the UI. Auto-archive scheduler.
  state/model.js        Pure state functions (no browser APIs), unit tested. Classic script.
  shared/view.js        Pure "what does the sidebar show for window W" derivation.
  shared/search.js      URL-vs-search, fuzzy scoring, palette ranking.
  shared/shortcuts.js   Shortcut strings ("Alt+KeyK") ↔ key events.
  shared/ui.js          Sidebar renderer used by both the overlay and the new tab.
  content/sidebar.js    Content script: closed-shadow-DOM overlay, hover reveal, theme.
  content/palette.js    Command palette (own closed shadow root), used by content + new tab.
  content/*.css         Styles, loaded into the shadow roots as constructable stylesheets.
  newtab/               Launcher page with the sidebar permanently open.
tests/
  *.test.js             node --test unit tests
  e2e/*.test.js         Playwright (headless Chromium) tests that load extension/ unpacked
```

**Data flow:** the background is the only writer. It mirrors open tabs into `storage.local.tabs` and owns `spaces`, `activeSpaceByWindow`, `tabSpace`, `pins`, `archive`, and `settings`. Content scripts and the new tab render from `storage.local` (instantly, even while the background is asleep), update on `storage.onChanged`, and send typed messages (`activateTab`, `closeTab`, `newTab`, `pinTab`, `unpin`, `openPin`, `setSpace`, `createSpace`, `renameSpace`, `deleteSpace`, `moveTabToSpace`, `restoreArchive`, `updateSettings`) to change anything. The background can be unloaded at any time: it serializes writes through one queue, rehydrates from storage on wake, and rebuilds tab→space assignments from pins after a browser restart.

**Isolation:** injected UI lives in closed shadow roots on zero-size `position: fixed; z-index: 2147483647` hosts, so site CSS can't style it and it never changes the page's layout. Key events typed into Margin's UI don't reach the page's own shortcut handlers (except page listeners in the capture phase).

Design decisions and every Safari fallback are in [DECISIONS.md](DECISIONS.md).

## Development

No build step and no runtime dependencies: `extension/` loads as-is. Node 22+.

```sh
npm test            # unit tests (node --test)
npm run test:e2e    # Playwright + headless Chromium (uses an installed Chromium; run `npx playwright install chromium` locally if needed)
npm run icons       # regenerate extension/icons
```

To try it in Chrome: chrome://extensions → Developer mode → Load unpacked → `extension/`.
