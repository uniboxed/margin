# Margin 2: the app draws the UI, themes are HTML and CSS

Draft plan, 2026-11-04. Nothing here is built yet. Once Tirth approves it, the decisions move into `SPEC.md` (which this plan changes, see the last section) and `DECISIONS.md`, and the work starts at Phase 0.

## 1. What we're building, in one picture

```text
            ┌──────────────────────── Margin UI (one web app) ────────────────────────┐
            │  runtime (Margin's JS only): state mirror · renderer · actions · behaviors │
            │  theme (HTML + CSS only, no JS): Arcadia · Neo-brutalism · Pixel · users'  │
            └──────────────▲──────────────────────────────────────▲─────────────────────┘
                           │ host adapter                         │ host adapter
        ┌──────────────────┴───────────────┐        ┌─────────────┴────────────────────┐
        │ Margin.app (Mac): native windows │        │ In-page host: browser tests only  │
        │ around the browser's page area,  │        │ (tests/theme/). Not in the        │
        │ Safari, Chrome, Edge             │        │ extension since Phase 2 step 5.   │
        └──────────────────▲───────────────┘        └─────────────▲────────────────────┘
                           │ link (snapshot, deltas, requests)    │ runtime messages
            ┌──────────────┴──────────────────────────────────────┴─────────────────────┐
            │ Extension: state owner, tabs and windows, page box, sleeping tabs, palette  │
            │ key, search, icons, archive. No UI of its own: none in pages (Phase 2).    │
            └────────────────────────────────────────────────────────────────────────────┘
```

Decided already (2026-11-04):

- Safari's own blink in the page area during a switch is accepted. A switch is a plain `tabs.update({active: true})`. All the machinery that hid the blink goes (section 8).
- Margin.app draws every Margin element: sidebar, borders and frame, palette, prompts, window controls, future UI. The page area itself is left to the browser.
- No Accessibility permission, no private macOS calls. Tested: window tracking with the window server's list, panels over full-screen windows, app-registered shortcuts, typing in a panel without Safari losing focus, and moving the browser's window through the extension (`windows.update`), all without permissions.
- On the Mac the app is used for every browser (Safari, Chrome, Edge). Mac users without the app are asked to install it (Tirth, 2026-11-04); they don't get an in-page UI. Margin 2 ships for macOS only (Tirth, 2026-11-04): Windows and Linux are not planned for now, so no product build runs the UI inside pages.
- Distribution: **Developer ID** (notarized, outside the App Store, with Margin's own updates). No App Store version (Tirth, 2026-11-04).
- In a normal window, Margin covers the browser's toolbar (no browser can hide it), and dragging Margin's frame moves the browser window through the extension. Margin's windows move to wherever the browser reports it landed, and the frame's edges reach a little past the window's edges, more on fast drags. Tirth checked it by hand: it works, a bit laggy, accepted for now.

New in this plan (Tirth, 2026-11-04):

- **A theme decides the layout**, including where the page sits: sidebar left or right, a top bar, a bottom shelf, a framed card. Margin reads the page's place from the theme and tells the extension, which fits every page there.
- **Themes are HTML and CSS only.** Users can add their own. No theme may run JavaScript: Margin's own runtime drives the theme through declarative bindings, and the security rules in section 4 make that hold.
- **Two new built-in themes**, Neo-brutalism and Pixel, from Tirth's "Browser Theme Explorations" canvas.

## 2. The parts and who owns what

| Part | Owns | Doesn't |
|---|---|---|
| Extension | Live tab and window state (tab ids, which tab is in which window and space), a cached copy of the app's data, tab and window actions, the page box in every page (while the app is linked), sleeping tabs, cut-off repair and copies, search, the ⌘T and palette keys where only a page can catch them | Draw any UI in pages, linked or not (gone in Phase 2 step 5); not linked, only its new-tab page's notice that Margin.app isn't running |
| Margin UI runtime | The state mirror, rendering the theme, the action list, the behaviors (drag and drop, resize, peek, palette keys, context menus, inline rename), measuring the theme's page slot | Talk to the browser: everything goes through the host |
| Theme | Structure (HTML), look (CSS), layout (where the page slot is), fonts and images bundled with it, its settings (as CSS variables) | Any script, any network request, any action Margin doesn't list |
| Margin.app host | Native windows per browser window, following the window, the link to each browser's extension, app shortcuts, keyboard focus for the palette, the window drag in windowed mode, and **the lasting data on the Mac** (section 6, "Where data lives") | Live tab state: tab ids exist only inside the running browser |
| In-page host | The runtime and theme in a closed shadow root (`ui/host.js`), for the browser tests only (`tests/theme/`). It drew Margin in pages until Phase 2 step 5, when it left the extension | Ship, or run in the extension: Margin is Mac-only, and without the app pages are left as they are and the new-tab page says the app isn't running (the install prompt: Phase 7) |

## 3. Themes, version 2

### A theme package

```text
my-theme/
  theme.json      manifest: id, name, version, author, modes, settings, fonts, layout hints
  theme.html      the template: one root, Margin's elements and bindings
  theme.css       the styles; may use the settings as CSS variables
  fonts/*.woff2   bundled font files (no font services)
  images/*        bundled images (png, jpg, webp, gif, svg after sanitizing)
```

Built-in themes are packages too (Arcadia first), in `extension/themes/<id>/`, so Margin uses its own format. User themes are imported from a folder or a `.margintheme` zip in Settings and stored in `storage.local` (size-capped).

### The template language

It's close to the Design canvas format Tirth's artifacts use (`{{holes}}`, `sc-for`, `sc-if`), so those designs port almost line for line, but every piece of logic lives in Margin:

- `{{space.name}}`: text from the view model, dotted paths only, never expressions.
- `<m-for each="space.today" as="t"> … </m-for>`, `<m-if test="space.hasToday"> … </m-if>`, `<m-else>`.
- `m-attr:aria-pressed="{{s.active}}"`, `m-class:on="{{t.active}}"`, `m-style:--accent="{{space.color}}"`: bound attributes, classes and CSS variables. Plain `style` and `class` attributes are allowed as written; bound values only go through these.
- `m-action="tab.activate" m-arg="{{t.id}}"` on a `button` or `a`: a click runs one action from Margin's list (below). No `on*` attributes, ever.
- Margin's slots, where the runtime puts its own pieces:
  - `<m-page>` (required, exactly one): where the browser's page goes. Its box (size, position, corner radius from CSS) is the page's place.
  - `<m-window-controls>`: close, minimise, full screen in windowed mode (themes style them; Margin wires them).
  - `<m-palette>`, `<m-notice>`, `<m-menu>`: the palette, prompts and context menus, drawn from theme parts (`<template m-part="palette-row">` and so on) so they match the theme.
  - `<m-drag-region>`: in windowed mode, where a drag moves the window.
- Behaviors, opted into with attributes and implemented by Margin: `m-drag="tab"`, `m-drop="folder|space|tabs"`, `m-resize="sidebar"`, `m-peek="left"` (hover zone that reveals a hidden sidebar), `m-rename="space"`, `m-scroll="tabs"` (scroll remembered per window), `m-input="palette"`.

### What a theme can read (the view model)

One documented, versioned object, the same in both hosts: `window` (mode `fullscreen|windowed|inpage`, focused, sidebar `open|hidden|peek`), `space` (name, color, emoji, index, tab count, `folders[]` with `tabs[]`, `pins[]`, `today[]`, `hasToday`), `spaces[]`, `tab` (the active one: title, host, url, loading, audible, asleep), `archive[]`, `palette` (open, query, rows), `notice`, `settings` (the theme's own), `platform` (browser, os). Each tab row carries id, title, host, icon (a `data:` URL Margin already stores), active, audible, asleep, pinned.

### Actions (the whole list a theme can trigger)

`tab.activate`, `tab.close`, `tab.new`, `tab.pin`, `tab.unpin`, `tab.moveToSpace`, `pin.open`, `folder.toggle`, `folder.new`, `space.switch`, `space.new`, `space.edit`, `today.clear`, `nav.back`, `nav.forward`, `nav.reload`, `palette.open`, `palette.close`, `sidebar.toggle`, `archive.open`, `archive.restore`, `window.close`, `window.minimise`, `window.fullscreen`, `settings.open`. Each argument is checked against the current state: a tab id must be an open tab, a space id an existing space. An unknown action or argument is ignored and logged.

### Layout: from the theme to the page box

1. The runtime renders the theme at the browser window's size and measures `<m-page>`: `left, top, right, bottom` insets and the corner radius.
2. The host sends that layout to the extension for that window (`setLayout {windowId, insets, radius, mode}`).
3. The extension keeps it per window and hands it to the pages: live pages get it over the existing `margin:box` message (it already carries four insets), and new pages get it before their first paint (done in Phase 3: registered CSS variables spelled in digit files, one first-paint file per theme, and the window's own sheet as a page commits; section 14, Spike 4).
4. When the theme's layout changes (sidebar hidden, a theme switch, the window resized, windowed versus full screen), steps 1–3 repeat. Themes can animate the change; the page follows the end state.

The theme's `theme.json` also declares layout hints Margin needs before it can render, such as the reveal edge for a hidden sidebar and the minimum and maximum sidebar width, so first paint and the in-page fallback can work out the box without a render.

### Modes

A theme styles three modes with attribute selectors on its root: `[data-mode="fullscreen"]`, `[data-mode="windowed"]` (covers the toolbar: the theme shows `<m-window-controls>`, an address or palette button, `<m-drag-region>`), `[data-mode="inpage"]` (the fallback, where the window's own toolbar stays). A theme that leaves a mode out gets sensible defaults from the runtime.

## 4. Security: HTML and CSS from strangers

Themes see every tab's title and address (they have to, to draw them). So the rules are about one thing above all: **a theme must not be able to run code or send anything anywhere.** Checked when a theme is imported, again every time it loads, and enforced by the host on top.

**HTML (allowlist sanitizer, `shared/theme-sanitize.js`):**

- Allowed elements: layout and text elements, lists, `button`, `a` (no `href` except `#` or Margin actions), `img` (bundled files and `data:` images only), `svg` drawing elements, `label`, `input` (only inside Margin parts that bind it), Margin's `m-*` elements and `template`.
- Removed: `script`, `iframe`, `frame`, `object`, `embed`, `form`, `link`, `meta`, `base`, `style` inside the template (styles go in `theme.css`), `svg` `script`, `foreignObject`, `animate`/`set` with `href`, `use` pointing outside the template.
- Removed attributes: every `on*`, `srcdoc`, `formaction`, `action`, `href`/`src`/`xlink:href` that isn't a bundled file, `#`, or `data:image/*`; `style` values that contain `url(` to anything not bundled.
- Bindings can only set text, listed attributes (`aria-*`, `title`, `alt`, `class`, data attributes, CSS variables), never `href`, `src`, `style` text or element names.

**CSS (`theme.css`, parsed and rewritten):**

- No `@import`. `url()` only to the theme's bundled files or `data:` images and fonts. No remote fonts (the canvas designs use Google Fonts; their families are SIL-licensed and get bundled as `.woff2`).
- This blocks the classic CSS leak (attribute selectors plus a background URL that tells a server what's on the page).
- Size and complexity limits (bytes, rule count, nesting) so a theme can't freeze the UI.

**At run time (both hosts):**

- Margin.app's web views load the UI from the app's own scheme with a Content Security Policy of `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'none'`. The theme's files are served from a separate path the policy doesn't allow scripts from. WebKit's content rules can also block all network loads from these views.
- In pages, the UI lives in a closed shadow root, as now; the theme's CSS is an adopted sheet and its bindings go through the same renderer.
- Actions are only the list above; arguments are validated.
- The palette and other inputs are Margin's, so a theme can't make a field that sends what's typed anywhere. A theme can still draw misleading text (a fake prompt): imported themes show their name and author in Settings, and Margin's own prompts are drawn in a fixed, theme-proof part.

**Tests:** a sanitizer test suite with known XSS and CSS-leak payloads, and a check that every built-in theme passes the same rules as a user theme.

## 5. The link between the app and the extension

Reuse the protocol from `feat/native-panel` (which worked in Tirth's Safari), generalised to several windows and browsers:

- **Safari:** native message to wake the app, then the app sends a port and token through `SFSafariApplication.dispatchMessage`, then a WebSocket to `127.0.0.1` with the token checked. This needs Safari's background to be a **page** (`background.scripts`), not a service worker: WebKit hangs a service worker that opens a WebSocket (seen again on 2026-11-04 with the test extension).
- **Chrome and Edge:** native messaging (`connectNative`). Margin.app installs the host manifests for each browser; the host is a tiny helper inside Margin.app that relays to the running app, and starts Margin.app in the background if it isn't running (as Safari's extension handler does, Tirth 2026-11-05). An open native port also keeps Chrome's service worker alive.
- Messages: `snapshot` and `delta` (state, with epoch and sequence numbers; a gap asks for a resync), `windows` (each window's id, bounds, state, focus, active tab), `req`/`reply` (actions from the UI), `setLayout` (insets per window), `move` (the windowed-mode drag), `theme` (the active theme's package).
- Data messages (the lasting data set the app owns, section 6): `data.hello` (the extension's queue of changes made while unlinked), `data.need`, `data.snapshot` (a whole data set), `data.changes` (per-item changes, either way), `data.ack`. The data set's format, the merge and these messages are in `DATA.md` (Phase 2 step 1).
- **Matching browser windows to the window server's windows:** lasting bindings learned from evidence, never guessed (Phase 2 step 6, `app/shell/WindowMatcher.swift`). A binding holds while both windows exist and never changes on a focus flag; it's made when the app's own request made the window (the profile switch's `openSpaceWindow`), when a copy heard a window created or focused (`createdAt`, `focusedAt`) just as a new window or a new front window appeared in the window server's list and nothing else did then, when a window is the only free one with its bounds, or when the focus has settled (one window called focused, the same front window for 5 s, and as many browser windows with those bounds as the copies report). A window it can't tell yet gets nothing drawn over it. Two full-screen windows have the same bounds, and the copies' focus flags lag a Space switch, so neither bounds nor flags alone decide.

## 6. Margin.app

- An accessory app (no Dock icon), started on demand by the extension (Tirth, 2026-11-05): a copy asking for its link (`wantLink`) while the app isn't running has the extension handler open it in the background (`NSWorkspace.openApplication`, not activated, no window), and asks again until linked. It does nothing until a browser is in front, and quits by itself a while after the last linked copy has gone (about 10 minutes with no browser running). Starting at login is an optional setting, for a faster first paint (Phase 7).
- **Window tracking:** the window server's window list, read a few times a second when nothing moves and at full speed during a drag. Follows every window of every linked browser.
- **Per browser window:** Margin's windows, kept just above that browser window (stacking verified to work across apps), joining full-screen Spaces.
- **Drawing the theme around the page (decided by Spike 1):** one transparent overlay window per browser window, the whole theme in one web view, the page slot left empty. The overlay ignores the mouse while the pointer is over the slot (mouse monitors, no Accessibility), so clicks, scrolling and text selection reach the page; transparency alone does not let them through. The overlay is re-ordered just above the browser window whenever the browser is clicked or activated. Cost: about 20 MB for the app plus 15 MB for its web process, and no measurable extra window-server work while the page scrolls.
- **Windowed mode:** Margin covers the toolbar. A drag on `<m-drag-region>` asks the extension to move the window (`windows.update`); Margin's windows move to the position the extension reports, and the frame's edges reach past the window's edges by a mouse step on fast drags.
- **Keys:** while linked, the app owns Margin's keys (Tirth, 2026-11-05): the tab and space keys, ⌘T (the palette, opened in the overlay with no round trip through the browser) and the sidebar's key, as app shortcuts (Carbon hot keys, no Accessibility; tested) while a linked browser is in front, following the Settings shortcuts the copy sends (`keys`, `app/PROTOCOL.md`). The extension is involved only when the user acts in the palette (a `req`). The extension's own ⌘T command and the page's ⌘T do nothing visible while the app draws; not linked, they open Margin's new-tab page, which says the app isn't running (Phase 2 step 5).
- **Typing:** the palette and inputs take the keyboard in a panel that doesn't make Margin the active app (tested: Safari stays in front and doesn't dim).
- **Distribution: Developer ID** (Tirth, 2026-11-04). Signed and notarized, outside the App Store, with Margin's own update channel (Sparkle). No App Sandbox requirement, so installing Chrome's and Edge's native-messaging host files (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` and the others) is straightforward. Hardened runtime on.
- **Where data lives (Tirth, 2026-11-04):** on the Mac, Margin.app owns the lasting data, in files under `~/Library/Application Support/Margin/` (one data set per browser and profile, keyed by the profile id the link already carries): spaces, pins (by address), folders, the archive, settings, theme settings, user themes and site icons. Reasons: Safari can wipe an extension's storage (it came back empty after Safari blocked and re-enabled Margin on 2026-11-04), the extension quota (about 10 MB) no longer limits themes and icons, Time Machine backs the files up, and one place decides, so the code that reconciles Margin's copies shrinks.
  - The extension keeps the live state (tab ids, `tabSpace`, open tabs per window), which only exists in the running browser, and a cached copy of the app's data, so it works from Safari's first page before the app has connected (first-paint layout, restoring which tab belongs to which space).
  - The app is the truth; the extension's copy is a cache. A wiped cache is refilled from the app as soon as they link. Changes made while unlinked are queued with their time and sent on link; the app merges them (last write wins per item, with deletions kept as tombstones so they don't come back).
- **Margin's tabs (Tirth, 2026-11-04):** Margin's sidebar is the real list of tabs, kept in the app's data with the rest; a browser tab is just the open form of a Margin tab (Arc's model). Each Margin tab has its own lasting id, address, title, icon, space, place in the list, last use, and, while it's open, the browser window and tab it's open in.
  - **Safari has a tab Margin doesn't know:** it's added to the window's active space, as today.
  - **Margin has a tab Safari doesn't (not open):** it stays in its space in the sidebar, drawn as not open, and opens in the window where it's clicked (`tabs.create` with its address), then is linked to that tab. A space's not-open tabs show in every window showing that space.
  - **What keeps a tab, and what removes it:** a tab closed on its own (its × in Margin, ⌘W, Safari's tab bar: `tabs.onRemoved` with `isWindowClosing` false, not started by Margin) goes to the archive, as today. Tabs lost because a whole window closed, Safari quit or crashed, or Safari didn't restore them stay as not-open tabs in their spaces.
  - **After a relaunch:** restored browser tabs are matched to Margin's tabs by address and order (today's `restore.js` logic); unmatched Margin tabs stay not open.
  - **Auto-archive** still moves tabs unused for `archiveAfterHours` into the archive, open or not.
  - Reopening a not-open tab starts fresh: its Back history and scroll position are gone, as when reopening any closed tab.
  - **Sleeping tabs become closed-but-kept (Tirth, 2026-11-04):** after `sleepAfterHours` unused, Margin closes the browser tab itself and keeps it as a not-open Margin tab, with the same skips as now (the tab in front, playing sound, drafts, the never-sleep list). This frees all of its memory (no sleep page left running) and leaves nothing broken if Margin is removed. Chrome and Edge keep `tabs.discard`, which keeps the tab and its history at no memory cost. The sleep page went in Phase 3 (with its copy moves, Back guards and "Wake all"'s path in Safari); a tab an earlier build left on it is kept as its Margin tab, or loaded at its address if it's in front. The choice of which tabs sleep and the draft check stay.
- Reuse from `feat/native-panel`: ExtensionLink, LinkSocket, LinkMessage, StateMirror, PanelWebView (own scheme), PanelController (minus the private calls), AppDelegate, the Xcode scripts. Not reused: SkyLight (private), AXSafari (Accessibility), Safari-sidebar Eligibility.

## 7. The extension, changed

- **Switching (done in Phase 2 step 8, 2026-11-05):** `focusTab` is `tabs.update(active)`, and `windows.update(focused)` only if the window isn't focused (`background/tabs.js`, from about 1,100 lines). Navigation (next/previous tab and space) keeps its chaining, without wakes and passing checks. Each switch is one line in Margin.app's log (`background/switch-log.js`).
- **Page box (done):** insets come from the theme's layout per window (Phase 2 step 3a for live pages; Phase 3 for the first paint).
  - First paint (Phase 3): the registered CSS carries the insets as variables, spelled in digit files (`shared/page-box.js layoutFiles`), the theme's first-paint file builds the box from them under a mark the page's world sets (`data-margin-at`), and the page's world reads them (`content/page/main.js`). A window whose layout isn't the registered one gets its own sheet as each page commits (`registered.js fixUp`, `webNavigation`). No file per width: the 36 placeholders and the `at-*.js` files are empty stubs for one update's sake (`scripts/build.js LEGACY_FILES`).
  - The registration is never taken away once made in a run of Safari, only updated (to zeros for no box): WebKit kept drawing a dropped registration in between (section 14).
- **No UI in pages (done in Phase 2 step 5):** pages get only the box, while the app is linked (none otherwise: the page as it is), and the small scripts that must run in a page (gestures, pinch, the draft check, the navigation and ⌘T keys). The UI runtime, the theme loader and the in-page host are out of the content script and the new-tab page. With no app linked, Margin's new-tab page says Margin.app isn't running, with a button that starts it and an address field; Phase 7 makes that the prompt to install the app (and adds the toolbar button).
- **Sleeping tabs:** kept; their checks no longer look at keep-ready, warm-up or slow Safari (done in Phase 2 step 8); they still wait for a switch under way.
- **Safari manifest:** background as a page (for the link), `nativeMessaging` kept.
- **Settings:** `keepLeftTabReadyMinutes` and `warmUpTabs` are gone (Phase 2 step 8; saved values are left alone). `sidebarPinnedOpen`, `frameWhenHidden` and `themes.arcadia.sidebarWidth` become theme settings and layout state.

## 8. What gets deleted

Counted on `feat/sleeping-tabs` (wc -l). About 9,000 lines of extension code and about 11,000 lines of tests and scenarios. Phase 2 step 8 deleted the switching rows below (about 6,000 lines of extension code and 8,600 of tests); Phase 3 the rest (2026-11-05: `DECISIONS.md` "Margin 2, Phase 3"). **Done.**

| Where | Goes | Why |
|---|---|---|
| `background/tabs.js` | about 3,200 of 4,018 lines: wakes, holds, sidebar preparation, cover and paint barriers, ping gate, `focusTabNow`, WebKit's mark and introductions, kicks, restore behind, warm tab | Anti-blackout switching |
| `background/keep-ready.js` (577), `warm-up.js` (586), `slow.js` (134) | Whole files | Anti-blackout switching |
| `background/diagnostics.js` (159) and the switch-log button | Whole file (done, Phase 3: sleep passes, the open-tab repair and an empty storage are lines in Margin.app's log) | Development diagnostics |
| `background.js`, `handlers.js`, `navigation.js` | Introduction and warm-up hooks, the deadline guard and `arrival`, `prewake`, `away`, `inView`, `warmUp*`, `pageBlinked`, `switchLog`, carry-open | Anti-blackout and in-page-only |
| `content/core.js` | about 700 of 1,496 lines: first show, prepared show, covers, warm-up note, switching cover | Anti-blackout |
| `content/hold.js` (72), `idle.js` (135), `shared/page-ready.js` (197), `shared/away.js` (80) | Whole files | Anti-blackout |
| `themes/register.js`, theme JS bundles, `assets.js`, 35 `docked/w-*.css` per theme, `at-<width>.js` | Replaced by theme packages (Phase 1 step 4) and the first paint from layout variables (Phase 3; the previous build's paths stay as empty stubs for an update) | Themes v2 |
| `themes/arcadia/sidebar.js` (1,742), `chrome.js`, `content.js`, `palette.js`, `newtab.js` | Their behavior moves into the runtime (about 1,600 lines); their structure and look into Arcadia's HTML and CSS; hover prewake and the warm-up note are deleted | Themes v2 |
| `shared/platform.js` | `wakeTabs`, `keepTabsReady`, `introduceTabs`, `restoreTabs`, `warmUp`, `prepareSidebar`, `hiddenPaints`, `asksBackground()`, `madeAfresh()` (all gone; `prepareSidebar` and its `stateRev` in Phase 3) | Anti-blackout |
| Tests | in-window, wake (except its new-tab-hint and sleeping-switch cases), keep-ready, warm-up, slow-safari, page-ready, hold, idle, away; parts of answer-in-time, startup, slow-start, spaces-switch; in Phase 3 the sleep page's, `stateRev`'s, the placeholders', the takeover's, and the in-page UI's e2e tests (the e2e tests of kept behaviour that drive the in-page UI are kept, skipped) | They test deleted code |
| WebKit host scenarios | unseen, unseennav, prepared, introduce, arrival, behind*, shell*, heavyflip, unloaded*, deferred, loadcover, slowunloaded, restartrepair, recorder; in Phase 3 sleep-copy (now sleep-leftover) and update-old-layout (`twins` stays: it tests copies, kept) | They test deleted code |
| `DECISIONS.md` | Nothing deleted: the "Margin 2, Phase 3" entry marks the anti-blackout sections (2026-10-26 to 2026-11-04) and the theme-JS sections as superseded, by heading (done) | History stays readable |

Kept as they are: state model, stored state and copies, restore, tab updates, cut-off, site icons, search engine, archive, sleep (decoupled), the page box in the page's world, gestures, pinch, edits, and their tests. Also gone in Phase 3, as only the deleted machinery or an update from before Margin 2 used them: the takeover of an earlier build's sidebar in pages and its reload, the guards for pages a pre-Margin 2 layout laid out, the page world's catch-up for a prepared show, the pages' blink watch, `build-styles.js`, and the stubs and old registration ids no build since registers.

## 9. The three built-in themes

Each is a theme package, passes the security rules, and covers all three modes.

- **Arcadia:** today's look, ported from `sidebar.js` and its CSS. The reference for every binding and behavior. Done first, so nothing looks different when the runtime switches over.
- **Neo-brutalism** (the canvas's "Neo-brutalism" board): dotted background in the space's color, 256 px sidebar of 2.5 px-bordered cards with hard offset shadows, Archivo Black and Space Grotesk (bundled), the page as an 18 px-rounded card with a 3 px border and a 6 px shadow, 16 px gutters. Spaces as color chips, folders as bordered cards, a yellow New Tab button, a palette dialog with a 10 px shadow.
- **Pixel** (the canvas's "Sidebar · Pixel / 8-bit" board): a dark dotted ground, Press Start 2P and Pixelify Sans (bundled), 3 px pixel borders made of box-shadows, a `▶` blinking cursor on the active tab, folders as `▼`/`▶` lists, spaces as numbered "worlds", the palette as "SELECT DESTINATION". `svg` with crisp edges for the pixel icons.

Parts of those designs Margin doesn't have yet are left out of the first version and planned as future features (Tirth, 2026-11-04; section 13): the **Ask** panel, the **mini player**, and the **favorites** tiles. The themes keep their place in the layout, and each arrives later as new actions and view-model fields, not theme code.

## 10. Phases

Each phase ends with the unit tests passing, the WebKit host scenarios that apply passing, and a TESTING.md checklist for Tirth's Safari (through Phase 1 also the in-page fallback working in Chromium with Playwright; there's no in-page fallback from Phase 2 step 5, and the e2e suite is to be rewritten). Branches are named `type/short-description`; on-screen tests follow the test rules (one dry run first, create once and verify, stop at the first failure).

### Phase 0: spikes (decide the open questions with evidence)

1. One transparent window over the browser window with an empty page slot: do clicks, scrolling, text selection and drags in the page reach the browser? What does it cost in memory, versus edge windows? Decides section 6's drawing method.
2. Template renderer and sanitizer prototype: render Neo-brutalism from a sanitized package at 60 fps with 200 tabs; run the XSS and CSS-leak payload list.
3. The link in today's Safari with the background as a page, and Chrome native messaging with a relay helper: round trip, wake from idle, reconnects.
4. First paint with insets read from registered CSS variables: no jump on a fresh page, in Safari and Chrome.

### Phase 1: the UI runtime and themes v2, in pages (no app yet)

- In pages so the runtime can be built and tested before the app exists (in Chromium with Playwright, and in Safari as a temporary development host). Afterwards the in-page host stays only as a test host; it isn't shipped (it left the extension in Phase 2 step 5; `ui/host.js` stays for the browser tests).
- The runtime (`extension/ui/`): view model, renderer, actions, behaviors (drag and drop, resize, peek, rename, menus, palette), host adapter interface.
- The theme format, sanitizer, packaging in `scripts/build.js`, `theme.json` schema and checks.
- Arcadia ported; the in-page host uses the runtime. The old theme JS path goes.
- Done when: every current in-page feature works through the new runtime with Arcadia, and the e2e suite (rewritten for the new DOM) passes.

### Phase 2: Margin.app, full screen, Safari

- Margin's tabs (section 6): lasting tab records in the app, not-open tabs in the sidebar, opening on click, the keep and archive rules, matching after a relaunch.
- The app's data store (section 6, "Where data lives"): per-profile files, the extension's cache and its refill, queued changes and the merge, and moving today's extension data into the app the first time they link.
- The app grows out of `app/safari/`: link, mirror, window tracking, per-window windows, the theme drawn around the page, app shortcuts, palette focus.
- The extension's background becomes a page in Safari; the link replaces the in-page UI, which then leaves the extension altogether (step 5: pages never draw Margin's UI, linked or not, so what's tested in Safari is the app's).
- Done when: in full-screen Safari, every feature works from the app's windows, pages fit the theme's slot, and nothing is drawn in pages.

### Phase 3: slim the extension (done, 2026-11-05)

- Delete section 8's code and tests. `focusTab` becomes the plain switch. Page box insets from layouts; the new first-paint path; sleep decoupled.
- **Partly done in Phase 2 step 8 (2026-11-05)**, because the old switching made the overlay's highlight flicker in Tirth's Safari: the plain switch, and the whole background side of the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers and paint barriers, the ping gate, keep-ready, the warm-up, slow Safari), `content/hold.js`, `idle.js`, `shared/page-ready.js`, `away.js`, the pages' preparation and first-show code, the switch log's entries, the two settings, their platform flags and their tests and WebKit scenarios (DECISIONS.md "Margin 2, Phase 2 step 8"). Still Phase 3's: the sleep page (`extension/sleep/`), `diagnostics.js` (now only repairs, sleep and created tabs), the state's write numbers for prepared pages (`platform.prepareSidebar`, `stateRev`), theme JS leftovers, page box insets from layouts and the new first-paint path.
- Done when: the code is gone, the tests pass, and switching in Safari is plain (Safari's own blink, no Margin covers).
- **Done (2026-11-05)** on `feat/margin-app`: the sleep page, `diagnostics.js`, `stateRev`/`prepareSidebar`, the theme JS leftovers and stubs, the first paint at any layout, the obsolete tests, and a cleanup sweep (`DECISIONS.md` "Margin 2, Phase 3"; Tirth's Safari checks: `TESTING.md` "Margin 2 Phase 3").

### Phase 4: windowed mode

- Covering the toolbar, window controls, the drag through `windows.update`, Margin following the reported position, edges reaching past the window on fast drags, several windows.
- Done when: windowed Safari works with one and with several windows, measured with the screen-frame test.

### Phase 5: Chrome and Edge on the Mac

- Native messaging host install, window matching for Chromium windows, both browsers at once.
- iCloud Tabs' folder and palette section for Chrome and Edge windows (built for Safari on 2026-11-05: `DECISIONS.md` "Margin 2: iCloud Tabs"): the extension's `sessions.getDevices()` gives the person's other devices and their open tabs (its own sync, not iCloud), sent to the app for its overlays in the same shape as `cloudTabs` (`app/PROTOCOL.md` "iCloud Tabs").
- Their profiles' own names, as Safari's are shown from Phase 2 step 9 (`app/shell/SafariProfiles.swift`; not built for them yet): each browser's `Local State` file (JSON; Chrome: `~/Library/Application Support/Google/Chrome/Local State`, Edge: `~/Library/Application Support/Microsoft Edge/Local State`), `profile.info_cache`, keyed by the profile's folder (`Default`, `Profile 1`…), with `name` (and `avatar_icon`, `default_avatar_fill_color`). Readable without Full Disk Access, but macOS 27 asks before an app reads another app's data (TCC "app data"): the set-up window will need its own step. The extension sees no profile id at all in Chromium, so the link from a copy to its folder still has to be found (its `Extensions/`/`Local Extension Settings/<extension id>/` folder under the profile is one lead).

### Phase 6: Neo-brutalism and Pixel, and user themes

- The two themes; theme import, preview and removal in Settings; the security suite in CI.

### Phase 7: distribution and onboarding

- Developer ID signing and notarization, Sparkle updates, starting at login as an optional setting (for a faster first paint; the extension starts the app on demand anyway), the set-up window extended to Chrome and Edge, the install-the-app prompt for Mac users without it (in place of the new-tab page's plain notice from Phase 2 step 5), removing the remaining development diagnostics.

## 11. Decisions and open questions

Decided (Tirth, 2026-11-04):

- Distribution: Developer ID, no App Store.
- Mac users without Margin.app are asked to install it; no in-page UI on the Mac.
- Ask, mini player and favorites: future features (section 13).
- macOS only: Windows and Linux are not planned for now.
- Bundling the canvas fonts (Archivo Black, Space Grotesk, Press Start 2P, Pixelify Sans; all SIL Open Font License) in the themes: OK.
- Margin's sidebar is the real list of tabs: tabs lost when a window closes or Safari quits, crashes or doesn't restore them stay in their spaces as not-open tabs and reopen on click; a tab closed on its own goes to the archive. Sleeping tabs are closed and kept the same way (Chrome and Edge keep `tabs.discard`), replacing the sleep page.
- On the Mac, Margin.app owns the lasting data; the extension keeps the live tab state and a cache (section 6).
- User themes: imported from a file for now; a theme gallery comes later (section 13). Importing shows no extra note about what a theme can see.

Still open: nothing. Phase 0 settled the drawing method (section 14).

## 12. Changes to SPEC.md, once approved

- *Hard constraints:* the in-page overlay stops being the only way; the app draws the UI on the Mac, in-page is the fallback. A switch is a plain activation; Safari's blink is accepted.
- *Hard constraints:* the sidebar's place, hover reveal, keep-open docking and the frame become theme layout, not fixed rules. The page box's insets come from the theme.
- *Out of scope:* remove "a native companion app".
- *Tech choices, Themes:* themes are HTML and CSS packages with declarative bindings and no JS; user themes allowed under the security rules; the runtime is Margin's JS.
- *Repo layout:* `extension/ui/` (runtime), `extension/themes/<id>/` (packages), the app under `app/`.
- *Data model:* `settings.themes[id]` holds the theme's declared settings; user theme packages in storage; `layout` per window in session storage.
- *Environment:* now Tirth's Mac with Xcode, Safari and the WebKit host (the Linux note is stale).

## 13. Future features (planned, not in the first version)

- **Ask:** a panel that answers questions about the page in front and the space's tabs. Needs a decision on where answers come from (an on-device model or a service, and what that means for "no third-party network requests").
- **Mini player:** controls for whatever tab is playing (title, play/pause), from the audible tab and the page's media session, shown by themes that have a place for it.
- **Favorites:** a small grid of always-there sites above the space's tabs, across spaces (Arc's favorites), as their own list in the state.
- **Theme gallery:** themes listed inside Margin's Settings and installed with one click, on top of file import. Needs hosting, a listing review, and the same checks as an imported file on every download.
- **iCloud Tabs beside the sidebar's toggle:** iCloud Tabs (a live folder in the sidebar and a palette section since 2026-11-05, `DECISIONS.md` "Margin 2: iCloud Tabs") moved, as the person chooses, out of the sidebar into an icon at the top of the sidebar, right of the sidebar's slide/toggle icon, opening the same `cloud-tabs` part in a popover. The part already draws the whole folder on its own, so it's a new place to show it and a setting, not new theme code.

## 14. Phase 0 results (2026-11-04)

All four spikes ran; the raw notes, numbers and code are on the spike branches. These results update the sections above; where they differ, this section wins until the sections are rewritten in Phase 1.

**Spike 1, drawing around the page:** see section 6. One overlay window per browser window with pointer-based pass-through over the page slot.

**Spike 2, theme renderer and sanitizer** (`spike/theme-renderer`: `extension/ui/sanitize.js`, `render.js`, `actions.js`, `themes/neo-brutalism/`; 847 unit and 16 browser tests):
- Margin parses theme HTML with its own strict tokenizer into a plain tree and builds the DOM with `createElement`/`setAttribute`; the browser never parses theme text (no `DOMParser`, no `innerHTML`). CSS goes through a CSS Syntax 3 tokenizer with an allowlist of functions.
- With 200 tabs: first render about 3 ms; every update under 1 ms of Margin's code and under 4 ms with the browser's layout, except switching back to a 200-tab space in WebKit (5 ms; `content-visibility: auto` on rows helps).
- 82 HTML, 50 CSS and 25 action-abuse payloads in WebKit and Chromium: nothing ran, no request was made.
- Changes to section 3: `m-icon` (only stored `data:` images reach `src`); negation and enum tests in `m-if`; `<m-else>` inside `<m-if>`; `key` on `<m-for>` (default `id`); reusable fragments (`<m-use part>`); `palette.run` added to the actions; `tab.moveToSpace` only through behaviors and menus; the view model adds `space.abbr`, each tab's `letter` and `color`, ids on palette rows, and is immutable (unchanged objects shared, so unchanged rows are skipped); `<m-page>` is forced to `background: none; pointer-events: none`; fonts are declared in `theme.json` and loaded as `FontFace` from their bytes (Chromium ignores `@font-face` inside shadow roots).
- Changes to section 4: `m-style` values and theme setting defaults are checked at run time (no `url()`, strings, escapes or `!important`), so an attribute selector can't learn which sites are open; `id` values follow a safe pattern and `name` is dropped; link clicks are blocked. What no sanitizer can stop: a theme drawing an invisible button over the window, misleading text, heavy selectors (limited only by size caps).

**Spike 3, the link:**
- **Safari:** a WebSocket alone doesn't keep the background alive: Safari unloaded it about 25–31 s after load and didn't wake it until a browser event. One-off native messages every 20 s didn't help either. A lasting `runtime.connectNative` port used every 20 s (the native-panel branch's method; "a port used within 2 min") kept all three profile copies alive for 6 minutes, including 3 minutes with no traffic. Round trip: median about 20 ms (5–36 ms, one 196 ms spike). Each Safari profile runs its own copy and keeps its background alive.
- **Chrome and Edge:** a Swift relay helper started by `connectNative`, linked to the app over a Unix socket. Connects in 5–12 ms; round trip 0.1 ms median; a 200 KB snapshot in 2.5–7 ms; nothing dropped. The open port kept the service worker alive for 10 minutes, 5 of them idle. Changes to section 5:
  - the helper holds Chrome's port and waits for the app (relinks in 36–44 ms), and exits on a version mismatch so Chrome restarts the new one after an update;
  - messages from the app to the extension over 1 MB kill the port, so theme packages are sent in chunks;
  - a heartbeat with a timeout (a stopped helper is invisible to both ends);
  - the socket path stays under 104 bytes (`~/Library/Application Support/Margin/`), mode 0600, and the app checks the peer's code signature;
  - the helper knows which browser started it (its parent process), which matches windows to the window server's list; several profiles send a per-profile id;
  - the app rewrites the host manifests at every launch, for Chrome (and Beta, Dev, Canary), Edge, Brave (and Chrome's folder too) and Arc, with every extension id in `allowed_origins`.

**Spike 4, first paint at any insets** (`spike/first-paint-insets`):
- Insets reach the page before its first paint as registered CSS variables, one small file per decimal digit and place (164 files built, 20 registered per layout), added up by one `at.css`; one first-paint file per theme builds the box from the variables. This replaces the 35 `w-*.css` and `at-*.js` files.
- The page's world has to read the variables again after it starts (when `<head>` and `<body>` arrive and at its first rendering updates): neither engine has applied registered CSS by the time that script runs.
- WebKit keeps applying an updated or unregistered registration's old CSS to new pages. So every registration sets every digit place (zeros included), and re-registrations stay rare.
- Per window: the most common layout is registered; other windows get one `insertCSS` sheet on `webNavigation.onCommitted` (a new `webNavigation` permission). It arrived before the first rendering update in 96 of 96 pages.
- Results: right in the first frame in 64 of 64 WebKit-host pages and in Chromium, including with the content script held back 250 ms the way Safari delays it; without the fix-up, every page jumped at about 255 ms.
- Still to check in Safari itself: where its content scripts and `insertCSS` land against its first paint, and whether the leftover registered CSS survives a relaunch.
- **Built in Phase 3 (2026-11-05),** with what the WebKit host showed then: a registration taken away and made again loses to the one in between (on, then `off.css` alone, then on again: every new page got `off.css`'s word), where an update's newest files win (back to a layout registered two layouts before: right). So the registration is only ever updated once made in a run of Safari, to a layout of zeros when nothing should be drawn, and nothing draws unless the page's world, reading the newest registration's theme and a layout with a box, marks the page. Measured with Margin's content script held back 400 ms: 24 of 24 fresh pages in their box from their first frame (22 from the registration, at five layouts and back to an earlier one, and two from their window's own sheet before the registration followed), and 3 of 3 with no box from their first frame (no box at any edge, and Margin.app gone while WebKit kept the dropped registration). First frames at 12–20 ms.

## 15. Spaces across profiles (tested 2026-11-04)

Tirth wants Arc-style swiping between spaces that belong to different browser profiles. A browser window belongs to one profile, so a space of another profile lives in that profile's own window, and switching to it brings that window forward: the target profile's copy of Margin calls `windows.update(id, {focused: true})` (no permission needed). Tested with two Chrome for Testing profiles (scratchpad `profile-swap/`):

| | Switch | In between | Margin's overlay |
|---|---|---|---|
| macOS full screen, each profile's window in its own Space | about 366 ms (about 0.2 s, then macOS's Space slide) | both pages sliding, 14–20 frames per switch | drops out for about 210 ms per switch and slides in with the new Space |
| Screen-filling windows, one per profile, stacked | 51 ms median (36–78 ms) | nothing (0 bad frames in 21 switches) | drawn in every frame, menu bar included |

An instant Space switch needs private macOS calls, so native full screen can't be seamless. The app can't focus a window in another full-screen Space either (its Accessibility window list omits it); the profile's own copy can.

**Decided (Tirth, 2026-11-04):** Margin builds on **macOS's own full screen** now (Phase 2). Switching to another profile's space focuses that profile's full-screen window, with macOS's slide. **Margin's own screen-filling mode** (one window per profile, stacked; instant, clean profile switches; Margin covering the toolbar and the menu bar, handling the Dock and the green button) comes later, together with windowed mode (Phase 4), since it needs the same toolbar-covering work.

**Instant switches with one private call, and a fallback (Tirth, 2026-11-05).** A demo (scratchpad `instant-space/`) switched between two full-screen Spaces with SkyLight's `SLSManagedDisplaySetCurrentSpace`, called from outside both apps: under 1 ms per call, a clean cut with no slide in the screen capture, no permission, system protection left on. Margin uses it for switching to a space whose window is in another full-screen Space (another profile), as the one exception to the no-private-calls rule:
- The calls are looked up at run time (`dlsym`); if a symbol is missing, the instant switch is off for that launch.
- After each call Margin checks, within about 100 ms, that the target window is on screen (the window server's list) and that the active Space changed. If not, it falls back to the normal switch (the profile's copy calls `windows.update({focused: true})`, with macOS's slide) and turns the instant switch off until the next launch, noting why in the diagnostics.
- Keyboard focus always goes through the target profile's copy (`windows.update({focused: true})`) right after the instant switch, so typing lands in the new window.
- A setting can turn the instant switch off.
- To check when it's built (Phase 2): real browser-profile windows in full screen with Margin's overlay on top; the overlay stays drawn; typing lands in the new page; Mission Control, the three-finger swipe and the Dock still agree with what's on screen afterwards; behavior across a macOS update.

**Verified with real browser-profile windows (2026-11-05, scratchpad `instant-profiles/`):** two Chrome for Testing profiles in native full screen. Every private switch was a one-frame cut (13–47 ms to the new page, no slide or other frames), Margin's overlay was drawn in every frame of all 18 switches, and typing landed in the right page 7 of 7 times. But the design above needs these changes before it's built:
- **macOS's state can disagree with the screen:** after the private call, the active Space and the Dock's "Current Space" can still name the old Space while the new window shows; both windows keep reporting on screen; Mission Control showed the right Space highlighted but the wrong windows, and the Dock brought another app forward while it was open.
- **A stronger check:** the target must be the first normal (layer 0) window in the on-screen list *and* the active Space must equal the target; "on screen" alone is always true after the first private switch.
- **Never mix the two kinds of switch:** once the private call has been used, a focus-only switch (`windows.update(focused)`) no longer changes Spaces; it restacks windows and leaves macOS disagreeing. So every switch between full-screen Spaces goes through the private call (followed by the focus call, needed when the windows belong to different apps).
- **The fallback needs rethinking:** in that mixed state the public switch doesn't slide and hides the problem. It needs a recovery step that brings macOS back in sync before falling back.
- **The covered page keeps rendering:** Chrome still reports it visible, so it costs power; the extension should tell it it's hidden, or Margin should accept the cost.
- **Mission Control disagreeing** is a known cost unless a way to make the Dock catch up turns up.

**Decided for now (Tirth, 2026-11-05): one profile window at a time, with macOS's slide.** Tested (scratchpad `one-window/`): the target profile's copy creates its window with `windows.create({state: 'fullscreen'})`, then the old profile's window is closed. Only one browser window ever exists, so Mission Control and the three-finger swipe show one Space. Each profile switch plays macOS's Space slide: about 0.4–0.65 s in total (about 1 in 20 creates takes 1.3–1.9 s), Margin's overlay is gone for about 180 ms, and the profile's pages reload from Margin's tab records. Nothing tested removes that slide: new full-screen Spaces always animate, overlays are hidden during a Space slide, and a hidden pre-made window isn't possible. Margin needs: the extension's `background` permission (a profile's copy stays linked with no window), its tab records for the closed profile, create then wait for the new full-screen Space to be active then close, a fallback when a create comes back as a normal window (`windows.update` to full screen), and a recovery when macOS drops to the desktop mid-switch. Because only one window exists, the private instant switch above isn't used for now; it stays the route if keeping a few recent profiles' windows (instant between them) is wanted later.

Also tested (scratchpad `bg-create/`): creating the target window unfocused, then the instant switch, then closing the old one. Chrome rejects `state: 'fullscreen'` with `focused: false`; an unfocused normal window is put into full screen by macOS anyway (a new window of an app already in full screen) and Chrome focuses it, so macOS slides to its new Space before Margin can act (10 of 10). The instant switch and the close after it were clean, so the slide comes only from the window's creation.

**Built (Phase 2 step 4, 2026-11-05), what was decided:**
- **Where a space's profile is:** the profile whose data set has it; nothing new in the sets. A profile has any number of spaces. The one order of every profile's spaces, and each profile's name, emoji and color, are the app's, in `data/<browser>/browser.json` beside the sets (`DATA.md` "Spaces across profiles"). Profiles are named once by the person ("Default" and "Profile N" until then). From step 9 (Tirth, 2026-11-05: "option A"), with Full Disk Access, Safari's own names and symbols instead, kept in step with Safari (`app/shell/SafariProfiles.swift`, `DECISIONS.md` "Margin 2, Phase 2 step 9").
- **The sidebar** shows every profile's spaces in that order; another profile's carry its mark (Arcadia: a small badge with its initial on the chip; Neo-brutalism: a tag and a dashed edge) and a divider sits where the profile changes. With one profile nothing changes.
- **A new space** is made in the profile you're in; "+" and a space's menu offer "New Space in …" for the others. Menus also move a space along the order, edit a profile (the space editor's part, `isProfile`), and forget a profile that isn't open. A profile's last space can't be deleted; a profile not seen for a month is never removed by Margin.
- **Switching:** within a profile it's today's switch. To another profile's space the app drives it (`app/shell/ProfileSwitch.swift`): that profile's copy creates its full-screen window showing the space (`openSpaceWindow`), the app waits until the window is full screen and the browser's first window on screen (its Space active), and only then has the old profile's copy close its window (`closeWindow`: its tabs stay as not-open tabs). A create that comes back normal is asked once for full screen; one that fails, times out (8 s) or never comes to the front (6 s) closes nothing (the new window is closed, the old one brought back, the person told; a late window is closed when it comes); after the close, if macOS shows the desktop instead, the new window is focused again (twice). A switch asked mid-switch runs after it (the last asked wins); the person closing either window or Safari quitting ends it safely.
- **A profile whose copy isn't running** (Safari loads a named profile's extensions only once one of its windows opens: below) can't be switched to by Margin itself: the app asks the person to open one of its windows (File › New Window), waits 90 s, and when its copy links with a window, shows the space there and closes the old window.
- **Safari keeps a profile's copy running with no window (found off screen in Safari 27.2's code, to confirm in Safari: `TESTING.md`):** each profile has its own extensions controller; at launch only the default profile's extensions load, a named profile's load when its first window opens (`loadExtensionsInProfileIfNecessary:` from a new browser document), and nothing unloads them until the profile is deleted. Margin's 20 s port pings keep the background page alive. So once a profile has had a window this session, its copy stays linked with none; windows an extension creates go to its own profile.
