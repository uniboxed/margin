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
- **The sidebar overlays the page by default.** Overlay with `position: fixed; z-index: 2147483647`, hidden by default, revealed when the mouse touches the left edge of the viewport or via shortcut. When revealed by hover it's a floating card inset from the window edges. With "Keep open" it docks flush left and an Arc-style frame (same color as the sidebar, rounded page corners, small margin top/right/bottom) wraps the pushed page.
- **Exception (Tirth's decision, 2026-10-25): with "Keep open" on, push the page.** Shift it right to start at the sidebar's edge, using a separate adopted stylesheet on `html` (screen only, never page markup or inline styles), removed as soon as "Keep open" is off. Accepted trade-offs: `position: fixed` elements don't move, `100vw` elements are clipped on the right, and viewport-centered modals sit off-center. Hover mode never pushes.
- **Isolate our UI in a closed Shadow DOM** so site CSS can't affect it and ours can't leak.
- **Safari has no `tabs.hide`, no `bookmarks`, no `history` API, no `tabGroups`.** "Spaces" are a Margin concept: the sidebar filters to show the active space's tabs. Safari's own tab bar will still show all tabs — that's accepted.
- **The background script can be unloaded at any time** (non-persistent). Never rely on in-memory state; persist everything to `browser.storage.local` and rehydrate on wake.
- **No third-party network requests.** No favicon services, no analytics, no CDNs. If `tab.favIconUrl` is unavailable (always, in Safari), the background fetches the visited site's own icon once (from the page's `<link rel=icon>` or `/favicon.ico`; no cookies; cross-site icon hosts must be https and non-local), shrinks it and stores it as a `data:` URL so showing it makes no further requests (Tirth's decision, 2026-10-25). If that fails, render a colored letter avatar.
- **Exception (Tirth's decision, 2026-10-25): with "Keep open" on, fit pages beside the sidebar in a frame of their own tab** (the "transplant shell", `content/shell.js`; Safari builds; a setting, on by default, with a per-site off switch). The page's own HTML, as Safari already received it, is written into a same-origin frame, and every navigation in it is redone at the top. No other site is framed, no URL is fetched as a frame, and no headers are changed. Loads it can't handle keep the push layout above.
- **Out of scope:** split view, iframing other sites, header stripping, a native companion app, iOS, syncing, accounts, monetization.

## Tech choices (decided)

- Plain **Manifest V3 web extension** in `extension/`, **vanilla JavaScript + CSS, no framework, no runtime dependencies**. `extension/` still loads directly, unbuilt. The build (`npm run build`) bundles each context's scripts into one file with **esbuild** (a dev dependency; Tirth's decision, 2026-10-25), and `dist/<browser>/` is what browsers load. Type checks, if added, run at development time only (JSDoc + `tsc`), never as a build step the extension needs.
- **Do not generate the Xcode project.** Tirth will run this locally on his Mac:
  `xcrun safari-web-extension-converter dist/safari --project-location xcode --app-name Margin --bundle-identifier io.tirth.margin --macos-only --swift --no-open`
  Put that command, plus how to rebuild after pulling new changes, in `README.md` under "Building for Safari (local, macOS)". Add `xcode/` to `.gitignore` unless Tirth later commits it himself.
- Unit tests for pure state logic with **`node --test`** (no test framework installs). E2E tests with **Playwright** (Chromium only) in `tests/e2e/`. Dev dependencies, declared in a root `package.json`, are Playwright and esbuild (pinned versions). The extension itself stays dependency-free.
- Use `browser.*` APIs (Safari supports them); fall back to `chrome.*` only if needed.

## Repo layout (target)

```
margin/
  extension/
    manifest.json
    background.js          # state owner: spaces, tab→space map, pins, archive, message router
    state/                 # pure functions (no browser APIs) — unit tested
      model.js
    content/
      sidebar.js           # injected overlay (shadow DOM), hover reveal, renders from storage
      sidebar.css
      palette.js           # command palette overlay
    newtab/
      newtab.html
      newtab.js            # renders sidebar + launcher, palette auto-open
    shared/
      ui.js                # sidebar render function shared by content script and new tab
      shortcuts.js
    icons/
  platform/                # per-browser manifest overrides (safari/, chrome/)
  dist/                    # generated by `npm run build`: safari/, chrome/ (committed)
  xcode/                   # generated
  tests/
    model.test.js
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
  settings: { sidebarPinnedOpen: false, archiveAfterHours: 12, paletteShortcut: "Alt+KeyK" }
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
- Opens with the configured shortcut (default **Option+K**) via a content-script `keydown` listener, plus a `commands` API fallback. Before finalizing the default, verify in Safari that it isn't swallowed by Safari or macOS; if it is, choose another and record it.
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
