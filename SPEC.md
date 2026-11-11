# Build "Margin" — an Arc-style sidebar for Safari (prototype)

> **Margin 2 (decided 2026-11-04): `PLAN.md` is the plan now.** A Mac app, Margin.app, draws all of Margin's UI in its own windows around the browser's page area (Safari, Chrome, Edge); the extension keeps the state, tabs, windows, the page box and sleeping tabs. Themes are HTML and CSS packages with no JavaScript, and a theme decides the layout, including where the page sits. A tab switch is a plain activation: Safari's own blink in the page area is accepted. On the Mac the app is required (users without it are asked to install it); Margin 2 ships for macOS only; Windows and Linux are not planned for now. Where this file and `PLAN.md` disagree, the rules below marked *Margin 2* and `PLAN.md` win; the milestones further down are the first prototype's history.

**Margin 2 follow-up (2026-11-10):** Tab keys follow the sidebar's saved order, including not-open tabs; choosing one opens only that page. Space selection restores the most recently used real tab (open or saved), with the previously selected tab breaking a recency tie. Browser start-page anchors are hidden from tab lists. Settings is a dedicated, reusable page reached from the palette's Settings action or `margin://settings` in Margin's search/address field. Own-Space native layers participate in Mission Control only after an independent model-geometry read validates their exact browser window. A fresh matching model read preserves an already shown layout during presentation scaling; uncertain geometry uses the transient hiding fallback. Existing views and browser geometry stay prepared. This supersedes the unconditional Mission Control hiding policy; compositor alignment still requires a real visual check.


**Margin 2, issue #15 (2026-11-10):** a requested cross-profile switch may use a temporary live, read-only themed cover in Margin’s own high-level Space. No browser pre-creation and no capture in the mechanism. B must be full screen, active, frontmost and laid out, with its selected space confirmed, and A parked/gone or explicitly kept before reveal. Recovery remains covered and bounded, with an independent emergency watchdog. Missing or failed capability falls back to freeze, then macOS slide with a degraded-mode log. `MarginLiveProfileCover` remains off by default until the real switch, cleanup and performance gates pass; see `docs/HANDOFF.md` for the implementation contract.

**Issue #15 resource candidate (2026-11-11):** retain the themed WebView. Optional checked WebKit related-view SPI may reuse an owned layout renderer for the disposable cover, with isolated allocation as fallback. No global renderer preferences, persistent warm cover or readiness bypass. Shared process crashes and retained cache costs require explicit validation; the live-cover default remains off. Details: `docs/PRIVATE-APIS.md`.

You are building a working prototype of **Margin**, a Safari Web Extension for macOS that recreates the feel of the Arc browser *inside real Safari*: a hover-reveal sidebar with spaces and pinned tabs, a custom new-tab page, and a command palette. Work autonomously through the milestones below. Commit after each milestone. Do not stop to ask me questions unless you hit a genuine blocker; when a decision is ambiguous, pick the simplest reasonable option, note it in `DECISIONS.md`, and keep going.

## Environment (important)

Development happens on a real Mac (macOS 27), with Xcode, Safari, Chrome, Edge, Node at `/opt/homebrew/bin`, Playwright's Chromium and WebKit, and the off-screen WebKit host (`tools/webkit-host`). Tests that act in the real browsers on that Mac follow the on-screen rules: one dry run first, anything that opens windows does it once and checks it, the test stops at the first failure, and it cleans up only what it made. Anything that can only be confirmed by hand goes into `TESTING.md` as a manual check.

## Hard constraints (already researched — do not re-litigate)

- **Margin 2:** on the Mac, Margin.app draws the UI in native windows (NSPanels holding WKWebViews) kept just above each browser window, with no Accessibility permission and no private macOS calls (one exception, decided 2026-11-05: an instant switch between full-screen Spaces through SkyLight, with a fallback to the public switch; `PLAN.md` section 15); the extension and the app talk over a link (native messaging to start, then a local WebSocket for Safari; native messaging for Chrome and Edge). Safari's background is a page, not a service worker, for that link. The in-page overlay described below is no longer shipped (since Phase 2 step 5 no page draws any of Margin's UI); the UI runtime runs in pages only in the browser tests (`tests/theme/`).
- **(First prototype)** **Safari extensions cannot modify Safari's own UI.** No sidebar API (no `sidePanel`, no `sidebarAction`), no tab bar changes, no toolbar changes. The ONLY way to show a sidebar is a **content script that injects an overlay into each web page**, plus the same sidebar rendered on our own new-tab page.
- **Cmd+T, Cmd+W, Cmd+N, Cmd+Q, Cmd+R, Cmd+L, Ctrl+Tab are never delivered to web pages in Safari.** Do not try to intercept them with `keydown`. Instead, take over new tabs with `"chrome_url_overrides": { "newtab": "newtab/newtab.html" }`. The user must select the extension under Safari → Settings → General → "New tabs open with" — put this in onboarding/docs.
- **Margin 2:** the sidebar's place, its reveal and docking, the frame and the page's place are the theme's layout: the theme's `<m-page>` slot gives the page box its four insets and corner radius, per window. A switch is a plain `tabs.update({active: true})`; Margin hides no blink. A page has its box from its first frame, at any layout, from registered CSS variables (the layout spelled in digit files) and its window's own sheet as it commits (Phase 3; `PLAN.md` §14 Spike 4); while Margin.app isn't drawing, no page has a box. Sleeping tabs in Safari are closed and kept as Margin tabs that aren't open (Chrome and Edge: `tabs.discard`); there's no sleep page.
- **(First prototype)** **The sidebar overlays the page by default.** Overlay with `position: fixed; z-index: 2147483647`, hidden by default, revealed when the mouse touches the left edge of the viewport or via shortcut. When revealed by hover it's a floating card inset from the window edges. With "Keep open" it docks flush left and an Arc-style frame (same color as the sidebar, rounded page corners, small margin top/right/bottom) wraps the page's box.
- **Exception (decided 2026-11-01, replacing the push and the fitted layout): every page Margin touches sits in a box beside it, with no iframe.** `<html>` is the box and `<body>` scrolls inside it (`shared/page-box.ts`, `content/page/`, both browsers). With "Keep open" the box starts at the sidebar's edge; hidden, at the frame's. Sheets are adopted, screen only, never page markup or inline styles. A script in the page's own world, registered only while Margin.app draws Margin (Margin 2), answers what a page asks about its window for the box, and rewrites media queries and viewport units. With no box (the frame turned off, Chrome outside full screen) the page is untouched and none of that loads. Hover never moves the page.
- **Exception (decided 2026-10-31): with the sidebar hidden, Margin's frame stays around the page** (a setting, on by default), the page in its box inside it. Hovering the sidebar still moves nothing. Turning "Keep open" off slides the sidebar away with the frame's edge.
- **Isolate our UI in a closed Shadow DOM** so site CSS can't affect it and ours can't leak.
- **Safari has no `tabs.hide`, no `bookmarks`, no `history` API, no `tabGroups`.** "Spaces" are a Margin concept: the sidebar filters to show the active space's tabs. Safari's own tab bar will still show all tabs — that's accepted.
- **The background script can be unloaded at any time** (non-persistent). Never rely on in-memory state; persist everything to `browser.storage.local` and rehydrate on wake.
- **No third-party network requests.** No favicon services, no analytics, no CDNs. If `tab.favIconUrl` is unavailable (always, in Safari), the background fetches the visited site's own icon once (from the page's `<link rel=icon>` or `/favicon.ico`; no cookies; cross-site icon hosts must be https and non-local), shrinks it and stores it as a `data:` URL so showing it makes no further requests (decided 2026-10-25). If that fails, render a colored letter avatar.
- **Out of scope:** split view, iframing other sites, header stripping, iOS, syncing, accounts, monetization. (A native companion app was out of scope until Margin 2.)
- **Distribution (Margin 2):** Margin.app ships with Developer ID, notarized, with its own updates. No App Store version.

## Tech choices (decided)

- **Startup helper (2026-11-10):** keep the login helper small and event-driven. When a supported browser opens and Margin.app is not running, the helper starts the app and a short-lived `--splash` child of its own executable in parallel. Only that child connects to AppKit for a small passive launch card, before profile identification; it uses window metadata only, no WebKit, Accessibility or page contents. It exits on the app's native UI handoff, browser quit, switching away, or a six-second deadline. The resident helper never creates windows or polls. The app's full-window startup cover remains profile-aware. This brief helper card is the exception to Margin.app drawing all UI.
- Plain **Manifest V3 web extension** in `extension/`, **TypeScript + CSS, no framework, no runtime dependencies**. `extension/` is the source, written as ES modules; the build (`npm run build`) bundles each context (content script, background, the page's box, new-tab page; and Margin.app's overlay page) into one plain script with **esbuild** (a dev dependency; decided 2026-10-25), and `dist/<browser>/` is what browsers load. The source is TypeScript (decided 2026-11-09: it was JavaScript with JSDoc types until then), type-checked by `tsc` (TypeScript 7, `npm test` runs it) and turned into JavaScript only by esbuild's bundling: Node runs the tests and scripts from the `.ts` files as they are (its type stripping), so the code uses only TypeScript that erases (`erasableSyntaxOnly`: no enums, namespaces or parameter properties) and spells its imports with `.ts`.
- **Do not generate the Xcode project.** It is generated locally on the Mac with:
  `xcrun safari-web-extension-converter dist/webkit --project-location xcode --app-name Margin --bundle-identifier com.unibox.margin --macos-only --swift --no-open`
  Put that command, plus how to rebuild after pulling new changes, in `README.md` under "Building for Safari (local, macOS)". Add `xcode/` to `.gitignore` unless it is later committed by hand.
- Unit tests for pure state logic with **`node --test`** (no test framework installs). E2E tests with **Playwright** (Chromium only) in `tests/e2e/`. Dev dependencies, declared in a root `package.json`, are Playwright, esbuild and TypeScript (the type checker; pinned versions). The extension itself stays dependency-free.
- Use `browser.*` APIs (Safari supports them); fall back to `chrome.*` only if needed.
- **Themes, Margin 2 (decided 2026-11-04):** a theme is a package of `theme.json`, `theme.html`, `theme.css` and bundled fonts and images. No theme runs JavaScript, built-in or user-made: Margin's UI runtime renders the template (`{{paths}}`, `<m-for>`, `<m-if>`, bound attributes), runs only actions from its fixed list (arguments checked against the state), and provides the behaviors (drag and drop, resize, peek, rename, menus, palette). A theme can't load anything remote: the sanitizer allows only listed elements and attributes, CSS has no `@import` and `url()` only to bundled files or `data:`, and the app's web views add a Content Security Policy with no network. User themes are imported from a file (a gallery later). Built-in: Arcadia (default), Neubrutalism, Pixel.
- **(First prototype; superseded by Margin 2's theme packages: no theme JavaScript, no per-width first-paint placeholders since Phase 3) Themes (decided 2026-10-25):** everything visual (components, structure, CSS, icons, fonts, the new-tab layout, first-paint placeholders) lives in a theme under `extension/themes/<id>/`; behavior stays in core. Arcadia is the default. Each theme has its own settings (`settings.themes[id]`). Only the active theme's code loads (its content bundle is a registered content script; the new-tab page imports only its module). Themes ship inside the extension: MV3 and App Store review forbid downloading code, so a downloadable theme could only be data (CSS, colors, fonts), and a shipped theme can't be deleted from the app.

## Repo layout (target)

Margin 2 adds `extension/ui/` (the UI runtime: view model, renderer, actions, behaviors, host adapters), turns `extension/themes/<id>/` into theme packages, and grows `app/` into Margin.app. The tree below is the first prototype's.

```
margin/
  extension/
    manifest.json
    background.ts          # state owner: registers listeners; parts in background/
    background/            # store, message handlers, tabs, registrations, archive, navigation
    state/                 # pure functions (no browser APIs) — unit tested
      model.ts
    content/
      main.js              # content-script entry: core, then the palette's wiring
      core.ts              # Margin on web pages: behavior only; parts in layout.ts, trackpad.ts,
                           # loader.js, takeover.js
      palette.ts           # palette shortcut and wiring (the palette's look is the theme's)
      page-link.ts         # Margin's side of the page's box
      page/                # the page's box, in the page's world (registered at runtime)
    newtab/
      newtab.html          # Margin's new-tab page: loads the active theme's new-tab module
      newtab.ts
    shared/                # core helpers (view model, search, shortcuts, gestures, dom, …)
    themes/                # what Margin looks like; only the active theme's code loads
      index.js             # the themes Margin ships (UI-free registry)
      register.js          # how a theme's content bundle hands itself to core
      arcadia/            # Arcadia (the default): Arc's look
        theme.ts           # UI-free description, defaults, its own settings
        content.js         # its part on web pages: sidebar, chrome, palette, CSS
        newtab.ts, newtab.html
        sidebar.js, chrome.js, palette.ts
        styles/*.css, docked.template.css
        assets.js, docked/ # generated by `npm run styles`
    icons/                 # the app's icons (not a theme's)
  platform/                # per-browser manifest overrides (safari/, chrome/)
  dist/                    # generated by `npm run build`: safari/, chrome/, app/ (not committed)
  xcode/                   # generated
  tests/
  README.md
  TESTING.md
  DECISIONS.md
```

## Data model (storage.local)

Margin 2: `settings.themes[id]` holds each theme's declared settings, imported theme packages are stored (size-capped), and each window's layout (insets, radius, mode, as Margin.app measured it) is in `appLink.layouts` (storage.local, written by the link; the first paint registers the one most windows have). `keepLeftTabReadyMinutes` and `warmUpTabs` went in Phase 2 step 8 (saved values left alone); `stateRev`, the write numbers for prepared pages, in Phase 3.

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

Margin 2 (Phase 2): Margin's sidebar is the real list of tabs. Each open tab's record carries its Margin tab's own lasting id (`mid`) and place in the list (`order`); Margin tabs with no browser tab are `keptTabs: { [id]: { id, url, title, favIconUrl, spaceId, order, lastActive, keptAt, why } }`, stored with the open tabs. After a restart, open tabs are matched to their Margin tabs by address and order; unmatched ones stay as kept tabs. The lasting data set Margin.app owns, its merge and its messages are in `docs/DATA.md`.

## Milestones

The first prototype's milestones, kept as history. Margin 2's phases are in `PLAN.md`.

### M1 — Skeleton that loads in Safari
- `manifest.json` (MV3): `permissions: ["tabs", "storage"]`, `host_permissions: ["<all_urls>"]`, background script, content script on `<all_urls>` at `document_start`, `all_frames: false`, newtab override, icons, a `commands` entry for toggling the sidebar.
- Background logs install; content script injects an empty shadow-root host.
- Add a Playwright smoke test: load the extension in headless Chromium, confirm the background starts, the content script injects its shadow host on a test page, and opening a new tab shows `newtab.html`. **Do not mark a milestone done unless unit tests and E2E tests pass.**
- Write `TESTING.md` with the exact manual steps for the local Safari check: enable Safari's developer features, allow unsigned extensions (this resets every Safari launch), run the app from Xcode, enable Margin in Safari → Settings → Extensions, grant "Always Allow on Every Website," set "New tabs open with" to Margin.

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
- Entering a URL navigates; anything else becomes a web search with **the browser's own search engine** (decided 2026-10-25; replaces DuckDuckGo and an engine setting). Chrome: `chrome.search.query`. Safari has no search API, so Margin follows the engine Safari searches with, learned from Safari's address-bar searches (Google until it has seen one).
- Note in the README: Safari focuses the address bar first on a new tab, so the launcher field may not get focus — that's expected.

### M4 — Spaces and pins
- Create, rename, recolor, and delete spaces from the sidebar (context menu or inline edit). Deleting a space moves its tabs and pins to the first space.
- Pin and unpin from the tab row. Drag tabs between spaces by dropping on a space chip.
- Switching the space changes only what the sidebar shows, per window.
- Unit-test all of `state/model.ts` (assign new tab, move tab, delete space, rebuild after restart, archive cap).

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
