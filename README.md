# Margin

An Arc-style sidebar for Safari, built as a Safari Web Extension (prototype). It recreates the feel of Arc inside real Safari:

- **Hover-reveal sidebar** on every website. Move the cursor to the left edge and the sidebar slides in as a floating card over the page. With **Keep open**, it docks: the page shifts right to start where the sidebar ends, inside an Arc-style frame.
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
- **Safari's own sidebar can also open at the left edge.** If you rest the cursor at the very edge, Safari opens its sidebar, and extensions can't disable that. Margin's opens instantly within 10px of the edge, so you don't need to rest there.
- **No sidebar while the address bar has focus.** Hover reveal needs the page to receive mouse events, and page shortcuts need the page to have keyboard focus.
- **⌘T, ⌘W, ⌘L, Ctrl+Tab and friends can't be intercepted.** Margin takes over new tabs by replacing the new-tab page instead. Safari focuses its address bar on a new tab, so the launcher field usually doesn't get focus. That's expected.
- **"Keep open" can break some layouts.** Safari can't shrink the page area, so Margin shifts the page right by hand. Headers and toolbars pinned to the screen (`position: fixed`) don't move and stay partly under the sidebar. Full-window-width elements get clipped on the right, and centered popups sit a bit off-center. Hover mode never moves the page. If a site misbehaves, switch to auto-hide (⌥S).
- **Pins are URL-based.** Navigating a pinned tab to another URL makes it a regular tab again.
- **Tabs closed with ⌘W aren't archived.** Only auto-archived tabs and tabs closed with Margin's × are.
- **Unverified in Safari.** Everything was automated-tested in headless Chromium only. See [TESTING.md](TESTING.md) for what needs a manual check.

## Install for development (temporary extension, no Xcode)

The fastest loop: Safari loads `extension/` straight from the repo. There's no Xcode build and no "Allow unsigned extensions" toggle.

1. Safari → Settings → Advanced → enable **Show features for web developers**.
2. **Develop → Add Temporary Extension…** → choose this repo's `extension/` folder.
3. Safari → Settings → Extensions → Margin → website access **Always Allow on Every Website**.
4. Safari → Settings → General → **New tabs open with** → **Margin**.

**After `git pull` or any edit:** reload Margin from Safari → Settings → Extensions (or remove it and add the folder again), then reload open pages. A temporary extension doesn't survive quitting Safari, so add it again after a relaunch.

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
xcrun safari-web-extension-converter extension --project-location xcode --app-name Margin --bundle-identifier io.tirth.margin --macos-only --swift --no-open
```

It then fixes the bundle IDs. The converter names the app `io.tirth.Margin` (capitalized from the app name) but the extension `io.tirth.margin.Extension`, and Xcode refuses to build with "Embedded binary's bundle identifier is not prefixed with the parent app's bundle identifier." The script sets the app to `io.tirth.margin`, the extension to `io.tirth.margin.Extension`, and `extensionBundleIdentifier` in the app's Swift code to match, then prints all three.

In Xcode, choose the **Margin (macOS)** scheme and Run (⌘R). Safari picks up the extension from the app. If signing complains, set the same Team (your Personal Team, or "Sign to Run Locally") on both targets under Signing & Capabilities.

**After pulling new changes,** re-run `scripts/make-xcode.sh` and Run again. That's always safe, and needed whenever files under `extension/` are added or removed. For edits to existing files, just Run again in Xcode and reload pages in Safari. If Safari still shows old behavior, regenerate.

## Architecture

```
extension/
  manifest.json         MV3: tabs, storage, alarms, scripting; <all_urls>; newtab override; commands
  background.js         State owner (classic service worker; loads state/model.js via importScripts). Tab events → pure model → storage.local.
                        Message router for the UI. Auto-archive scheduler.
  state/model.js        Pure state functions (no browser APIs), unit tested. Classic script.
  shared/view.js        Pure "what does the sidebar show for window W" derivation.
  shared/search.js      URL-vs-search, fuzzy scoring, palette ranking.
  shared/shortcuts.js   Shortcut strings ("Alt+KeyK") ↔ key events.
  shared/ui.js          Sidebar renderer used by both the overlay and the new tab.
  content/sidebar.js    Content script: closed-shadow-DOM overlay, hover reveal, theme.
  content/palette.js    Command palette (own closed shadow root), used by content + new tab.
  content/docked.css    Registered only while "Keep open" is on; applied before first paint.
  content/*.css         Styles (source of truth). Bundled into content/styles.js by `npm run styles`
                        so content scripts apply them synchronously, with no fetch.
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
npm run styles      # after editing content/*.css: regenerate content/styles.js (a test checks it)
npm run icons       # regenerate extension/icons
```

To try it in Chrome: chrome://extensions → Developer mode → Load unpacked → `extension/`, and use the reload icon after changes. This is handy for fast iteration; check Safari-specific behavior (favicons, shortcuts, new tab) in Safari.
