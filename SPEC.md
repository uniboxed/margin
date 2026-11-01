# Build "Margin" — an Arc-style sidebar for Safari (prototype)

You are building a working prototype of **Margin**, a Safari Web Extension for macOS that recreates the feel of the Arc browser *inside real Safari*: a hover-reveal sidebar with spaces and pinned tabs, a custom new-tab page, and a command palette. Work autonomously through the milestones below. Commit after each milestone. Do not stop to ask me questions unless you hit a genuine blocker; when a decision is ambiguous, pick the simplest reasonable option, note it in `DECISIONS.md`, and keep going.

## Environment (important)

You are running in a **Linux cloud session** with no Xcode, no `xcodebuild`, no macOS, and no Safari. Your job is the extension itself (`extension/`), plus tests and docs. Tirth wraps and builds it for Safari locally on his Mac. So:
- Never try to install or run Xcode, `xcrun`, or Safari tooling.
- Your verification is `node --test` for pure logic, plus **Playwright with headless Chromium** loading `extension/` as an unpacked extension (use `--headless=new`, `--disable-extensions-except`, `--load-extension`). Chromium runs the same MV3 manifest, content scripts, newtab override, and `tabs` API, so it's the closest automated check available.
- Anything Safari-specific that Chromium can't prove goes into `TESTING.md` as a manual check for Tirth, marked clearly.
- Push your work to the GitHub repo branch after each milestone.

## Hard constraints (already researched — do not re-litigate)

- **Safari extensions cannot modify Safari's own UI.** No sidebar API (no `sidePanel`, no `sidebarAction`), no tab bar changes, no toolbar changes. The ONLY way to show a sidebar is a **content script that injects an overlay into each web page**, plus the same sidebar rendered on our own new-tab page.
- **Cmd+T, Cmd+W, Cmd+N, Cmd+Q, Cmd+R, Cmd+L, Ctrl+Tab are never delivered to web pages in Safari.** Do not try to intercept them with `keydown`. Instead, take over new tabs with `"chrome_url_overrides": { "newtab": "newtab/newtab.html" }`. The user must select the extension under Safari → Settings → General → "New tabs open with" — put this in onboarding/docs.
- **The sidebar overlays the page by default.** Overlay with `position: fixed; z-index: 2147483647`, hidden by default, revealed when the mouse touches the left edge of the viewport or via shortcut. When revealed by hover it's a floating card inset from the window edges. With "Keep open" it docks flush left and an Arc-style frame (same color as the sidebar, rounded page corners, small margin top/right/bottom) wraps the page's box.
- **Exception (Tirth's decision, 2026-11-01, replacing the push and the fitted layout): every page Margin touches sits in a box beside it, with no iframe.** `<html>` is the box and `<body>` scrolls inside it (`shared/page-box.js`, `content/page/`, both browsers). With "Keep open" the box starts at the sidebar's edge; hidden, at the frame's. Sheets are adopted, screen only, never page markup or inline styles. A script in the page's own world, registered only while pages have a box, answers what a page asks about its window for the box, and rewrites media queries and viewport units. With no box (the frame turned off, Chrome outside full screen) the page is untouched and none of that loads. Hover never moves the page.
- **Exception (Tirth's decision, 2026-10-31): with the sidebar hidden, Margin's frame stays around the page** (a setting, on by default), the page in its box inside it. Hovering the sidebar still moves nothing. Turning "Keep open" off slides the sidebar away with the frame's edge.
- **Isolate our UI in a closed Shadow DOM** so site CSS can't affect it and ours can't leak.
- **Safari has no `tabs.hide`, no `bookmarks`, no `history` API, no `tabGroups`.** "Spaces" are a Margin concept: the sidebar filters to show the active space's tabs. Safari's own tab bar will still show all tabs — that's accepted.
- **The background script can be unloaded at any time** (non-persistent). Never rely on in-memory state; persist everything to `browser.storage.local` and rehydrate on wake.
- **No third-party network requests.** No favicon services, no analytics, no CDNs. If `tab.favIconUrl` is unavailable (always, in Safari), the background fetches the visited site's own icon once (from the page's `<link rel=icon>` or `/favicon.ico`; no cookies; cross-site icon hosts must be https and non-local), shrinks it and stores it as a `data:` URL so showing it makes no further requests (Tirth's decision, 2026-10-25). If that fails, render a colored letter avatar.
- **Out of scope:** split view, iframing other sites, header stripping, a native companion app, iOS, syncing, accounts, monetization.

## Tech choices (decided)

- Plain **Manifest V3 web extension** in `extension/`, **vanilla JavaScript + CSS, no framework, no runtime dependencies**. `extension/` is the source, written as ES modules; the build (`npm run build`) bundles each context (content scripts, background, fitted layout, new-tab page) into one plain script with **esbuild** (a dev dependency; Tirth's decision, 2026-10-25), and `dist/<browser>/` is what browsers load. Types are JSDoc comments checked by `tsc --checkJs` at development time (`npm test` runs it); there's no TypeScript source and no compile step.
- **Do not generate the Xcode project.** Tirth will run this locally on his Mac:
  `xcrun safari-web-extension-converter dist/safari --project-location xcode --app-name Margin --bundle-identifier io.tirth.margin --macos-only --swift --no-open`
  Put that command, plus how to rebuild after pulling new changes, in `README.md` under "Building for Safari (local, macOS)". Add `xcode/` to `.gitignore` unless Tirth later commits it himself.
- Unit tests for pure state logic with **`node --test`** (no test framework installs). E2E tests with **Playwright** (Chromium only) in `tests/e2e/`. Dev dependencies, declared in a root `package.json`, are Playwright, esbuild and TypeScript (the type checker; pinned versions). The extension itself stays dependency-free.
- Use `browser.*` APIs (Safari supports them); fall back to `chrome.*` only if needed.
- **Themes (Tirth's decision, 2026-10-25):** everything visual (components, structure, CSS, icons, fonts, the new-tab layout, first-paint placeholders) lives in a theme under `extension/themes/<id>/`; behavior stays in core. Arcadia is the default. Each theme has its own settings (`settings.themes[id]`). Only the active theme's code loads (its content bundle is a registered content script; the new-tab page imports only its module). Themes ship inside the extension: MV3 and App Store review forbid downloading code, so a downloadable theme could only be data (CSS, colors, fonts), and a shipped theme can't be deleted from the app.

## Repo layout (target)

```
margin/
  extension/
    manifest.json
    background.js          # state owner: registers listeners; parts in background/
    background/            # store, message handlers, tabs, registrations, archive, navigation
    state/                 # pure functions (no browser APIs) — unit tested
      model.js
    content/
      main.js              # content-script entry: core, then the palette's wiring
      core.js              # Margin on web pages: behavior only; parts in layout.js, trackpad.js,
                           # loader.js, takeover.js
      palette.js           # palette shortcut and wiring (the palette's look is the theme's)
      page-link.js, pinch.js # Margin's side of the page's box, and the pinch
      page/                # the page's box, in the page's world (registered at runtime)
    newtab/
      newtab.html          # Margin's new-tab page: loads the active theme's new-tab module
      newtab.js
    shared/                # core helpers (view model, search, shortcuts, gestures, dom, …)
    themes/                # what Margin looks like; only the active theme's code loads
      index.js             # the themes Margin ships (UI-free registry)
      register.js          # how a theme's content bundle hands itself to core
      arcadia/            # Arcadia (the default): Arc's look
        theme.js           # UI-free description, defaults, its own settings
        content.js         # its part on web pages: sidebar, chrome, palette, CSS
        newtab.js, newtab.html
        sidebar.js, chrome.js, palette.js
        styles/*.css, docked.template.css
        assets.js, docked/ # generated by `npm run styles`
    icons/                 # the app's icons (not a theme's)
  platform/                # per-browser manifest overrides (safari/, chrome/)
  dist/                    # generated by `npm run build`: safari/, chrome/ (committed)
  xcode/                   # generated
  tests/
  README.md
  TESTING.md
  DECISIONS.md
```

## Data model (storage.local)

```js
{
  spaces: [{ id, name, emoji, color }],        // default: one "Personal" space
  activeSpaceByWindow: { [windowId]: spaceId },
  tabSpace: { [tabId]: spaceId },              // new tabs join the window's active space
  pins: [{ id, spaceId, url, title }],         // URL-based (tab ids don't survive restarts)
  archive: [{ url, title, spaceId, closedAt }],// capped at 200 entries
  settings: { sidebarPinnedOpen: false, archiveAfterHours: 12, …,
              theme: "arcadia", themes: { arcadia: { sidebarWidth: 260 } } } // each theme's own settings
}
```

On browser restart, tab ids change: rebuild `tabSpace` by matching open tabs to pins by URL; unmatched tabs go to the active space.

## Milestones

### M1 — Skeleton that loads in Safari
- `manifest.json` (MV3): `permissions: ["tabs", "storage"]`, `host_permissions: ["<all_urls>"]`, background script, content script on `<all_urls>` at `document_start`, `all_frames: false`, newtab override, icons, a `commands` entry for toggling the sidebar.
- Background logs install; content script injects an empty shadow-root host.
- Add a Playwright smoke test: load the extension in headless Chromium, confirm the background starts, the content script injects its shadow host on a test page, and opening a new tab shows `newtab.html`. **Do not mark a milestone done unless unit tests and E2E tests pass.**
- Write `TESTING.md` with the exact manual steps for Tirth's local Safari check: enable Safari's developer features, allow unsigned extensions (this resets every Safari launch), run the app from Xcode, enable Margin in Safari → Settings → Extensions, grant "Always Allow on Every Website," set "New tabs open with" to Margin.

### M2 — Sidebar overlay
- 260px overlay sidebar on the left, hidden by default. Reveals when the cursor is within 6px of the left edge; hides on mouse leave after 300ms, unless "pinned open" is toggled.
- Sections: space switcher at the top (emoji chips), pinned items for the active space, then open tabs for the active space (favicon/letter avatar, title, close button), and a "+ New tab" button.
- Clicking a tab activates it (`tabs.update` + `windows.update({focused:true})`). Clicking a pin focuses an existing tab with that URL, otherwise opens it.
- Renders instantly from `storage.local` and updates live via `storage.onChanged` and `tabs.onCreated/onRemoved/onUpdated/onActivated` (all routed through the background).
- Content script ↔ background via `runtime.sendMessage` with a small typed message set (`activateTab`, `closeTab`, `newTab`, `pinTab`, `unpin`, `setSpace`, `createSpace`, `renameSpace`, `moveTabToSpace`).
- Respect the page's dark/light preference for the sidebar theme.
- Do not inject on our own extension pages; the new tab renders the sidebar itself.

### M3 — New-tab page
- `newtab.html` shows the sidebar permanently open, plus a centered launcher: a search/URL field, the active space's pins as large tiles, and recently archived tabs.
- Entering a URL navigates; anything else becomes a web search with **the browser's own search engine** (Tirth's decision, 2026-10-25; replaces DuckDuckGo and an engine setting). Chrome: `chrome.search.query`. Safari has no search API, so Margin follows the engine Safari searches with, learned from Safari's address-bar searches (Google until it has seen one).
- Note in the README: Safari focuses the address bar first on a new tab, so the launcher field may not get focus — that's expected.

### M4 — Spaces and pins
- Create, rename, recolor, and delete spaces from the sidebar (context menu or inline edit). Deleting a space moves its tabs and pins to the first space.
- Pin and unpin from the tab row. Drag tabs between spaces by dropping on a space chip.
- Switching the space changes only what the sidebar shows, per window.
- Unit-test all of `state/model.js` (assign new tab, move tab, delete space, rebuild after restart, archive cap).

### M5 — Command palette
- Opens with **⌘T** (Arc's: choosing a new tab over the page you're on), via a content-script `keydown` listener once the browser's own File › New Tab has another shortcut (macOS App Shortcuts), Safari's `new-tab` command app-wide, and otherwise by handing the browser's new tab back (DECISIONS.md). Was **Option+K** (a setting); dropped when ⌘T opened the same palette.
- Fuzzy search across open tabs (all spaces, current space ranked first), pins, archive, and the actions "New tab," "Switch to space …," "Pin current tab," "Toggle sidebar," and "Open URL / Search for …".
- Keyboard navigation: up/down, Enter, Esc. Rendered in its own shadow root.

### M6 — Auto-archive
- Tabs that are unpinned and haven't been active for `archiveAfterHours` get closed and added to the archive. Run the check with `browser.alarms` if Safari supports it; otherwise check on tab events and on wake. Record which approach was used.
- The archive is viewable and restorable from the new-tab page and the palette.

### M7 — Polish and docs
- README: what Margin is, its known limitations (stated honestly: no sidebar on Safari's internal pages, PDFs, or other extensions' pages, or while the address bar has focus; Safari's tab bar remains), install steps, and the architecture overview.
- A clean final build, all unit tests passing, and an updated `TESTING.md` with a manual checklist covering every feature above.

## Safari behaviors to design defensively around
You can't test these in the cloud. Write the code so each one degrades gracefully if false (feature-detect, fall back), list each as a manual check at the top of `TESTING.md`, and note your fallback in `DECISIONS.md`:
1. `chrome_url_overrides.newtab` works in the installed Safari version.
2. `tab.favIconUrl` is populated.
3. The `commands` shortcuts work, and which key combos are available.
4. `browser.alarms` is available to the background.
5. How quickly the background unloads, and whether a content script's `sendMessage` wakes it reliably.

## Working rules
- Small commits with clear messages; one milestone per PR-sized chunk.
- Commit messages follow Conventional Commits (conventionalcommits.org): `type(scope): summary`, lowercase imperative, no trailing period, max ~72 chars. Subject line only — no body, unless a breaking change needs a `BREAKING CHANGE:` footer.
- Never add `Co-Authored-By: Claude`, "Generated with Claude Code," or any other attribution to commits or PRs. Attribution is disabled in `.claude/settings.json`.
- Branch names never contain `claude/` or any other tool/assistant signature. Use `type/short-description` (e.g. `feat/safari-sidebar-prototype`, `fix/palette-focus`).
- After each milestone, run the unit tests and the Playwright tests, fix failures, then commit and push.
- Never claim something works in Safari: you can't run Safari. Clearly separate "verified in Chromium tests" from "needs manual check in Safari."
- When done, give me one short summary: what works, what needs my manual verification, and the top three limitations.
