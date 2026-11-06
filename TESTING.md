# Testing Margin

## Automated (cloud / any machine with Node 22)

```sh
npm test            # unit tests: node --test tests/*.test.js
npm run test:e2e    # builds dist/, then Playwright, headless Chromium, loads dist/chrome/ unpacked
```

Everything below this line is **manual, in Safari on macOS**. The automated tests only prove the extension works in Chromium. (Not run for now: Tirth's "no E2E for now". Since Margin 2 the e2e suite is mostly skipped tests waiting to be rewritten against Margin.app; `npm run test:webkit` and `npm run test:app` cover the extension and the app off screen.) Sections marked superseded test what Margin 2 removed: they're kept as history.

## Safari behaviors to confirm first

None of these can be tested in the cloud. The code feature-detects each one and degrades as described, and DECISIONS.md records each fallback. Do these right after setup, and write the results into DECISIONS.md.

| # | Check | How to tell | If it fails |
|---|-------|-------------|-------------|
| 1 | `chrome_url_overrides.newtab` works in this Safari | After setup step 7, ⌘T shows Margin's launcher (search field, sidebar on the left) | No launcher. The overlay sidebar, palette, and archive still work on websites, and the palette replaces the launcher |
| 2 | `tab.favIconUrl` is populated | Sidebar rows show site favicons, not just colored letters | Letter avatars are the built-in fallback. Nothing to do |
| 3 | `commands` shortcuts work, and which combos are free | On a normal site, Option+K opens the palette and Option+S toggles the sidebar, including while a text field has focus. Also look for shortcut settings under Safari → Settings → Extensions → Margin | If Option+K does nothing, choose another combo in new tab → Settings → Command palette shortcut, then record the one that works in DECISIONS.md (M5) so the default can change |
| 4 | `browser.alarms` is available to the background | The background console (Develop → Web Extension Background Content → Margin) logs `[margin] auto-archive via browser.alarms` | It logs `via tab events` instead, and auto-archive runs on wake and on tab switches (at most every 5 min). Record which one (M6) |
| 5 | How fast the background unloads, and whether a content script's `sendMessage` wakes it | Note when the background console disconnects while idle. After that, hover the left edge on an already-open page and click a tab row | If clicks do nothing until you open a new tab, `sendMessage` isn't waking it. Record it (M2) |

Additional Safari-only checks:

| # | Check | How to tell | If it fails |
|---|-------|-------------|-------------|
| A | The background service worker starts (classic worker, `importScripts('state/model.js')`) | Develop → Web Extension Background Content → Margin shows no errors, and the console shows `[margin] installed` and `[margin] auto-archive via …` | Record the error in DECISIONS.md. The likely fallback is concatenating `state/model.js` into `background.js` |
| B | Sidebar CSS loads inside the shadow root on a strict-CSP site (github.com) | The sidebar is styled, not raw HTML | A constructable stylesheet with `<style>` fallback is already in place. If both fail, record it |
| C | Restart rebuild | Pin a site into a non-default space, quit Safari with windows restored, relaunch | The pinned site's tab appears under that space, and other tabs under the first space |

### Results on Tirth's Mac (2026-10-24)

| # | Result |
|---|--------|
| 1 | ✅ Works once Safari → Settings → General → "New tabs open with" is set to Margin. Safari still focuses its address bar on the new tab, as expected |
| 2 | ❌ Safari gives extensions no favicon: `tab.favIconUrl` is `""` for every tab. Since 2026-10-25 Margin fetches each site's own icon itself; see "Site icons" below |
| 3 | ✅ Option+K opens the palette and Option+S toggles the sidebar. (Option+S did nothing while "Keep open" was on: fixed, it now switches back to auto-hide) |
| 4 | ✅ `browser.alarms` is available (`[margin] auto-archive via browser.alarms`) |
| 5 | ✅ Background shows "not loaded" when idle and starts on demand. Tab events reach it (`tabs`/`tabSpace` stay populated) |
| A | ✅ The classic background worker loads without errors |
| B | ✅ Sidebar is styled on github.com |
| C | Not yet checked |

Also observed: with "Keep open" on, on github.com the sidebar appears only once the page finishes loading, not at `document_start`. Not yet investigated.

## One-time setup

**Recommended: temporary extension** (no Xcode, no "Allow unsigned extensions").

1. Safari → Settings → Advanced → enable **Show features for web developers** (older Safari: "Show Develop menu in menu bar").
2. **Develop → Add Temporary Extension…** → choose the repo's `dist/safari/` folder (not `extension/`). Redo this after every Safari relaunch. After pulling changes, reload Margin in Safari → Settings → Extensions, then reload pages.
3. Safari → Settings → Extensions → Margin → set website access to **Always Allow on Every Website**.
4. Safari → Settings → General → **New tabs open with** → **Margin**. Set **New windows open with** to Margin too if you like.
5. If an Xcode-built Margin is also installed, turn it off in Safari → Settings → Extensions so only one copy runs.

**Alternative: Xcode-built app** (for testing the real packaged app).

1. Run `scripts/make-xcode.sh`, open `xcode/Margin/Margin.xcodeproj`, choose the **Margin (macOS)** scheme, and Run (⌘R). The container app opens. You can close it.
2. Safari → Settings → Developer (older Safari: the Develop menu) → enable **Allow unsigned extensions**. You'll be asked for your password. **This resets every time Safari quits.**
3. Then steps 3–4 above, after checking **Margin** in Safari → Settings → Extensions.
4. If Margin disappears from the Extensions list: press ⌘R in Xcode again, quit and reopen Safari, and toggle "Allow unsigned extensions" off and on. Re-run `scripts/make-xcode.sh` only when files under `dist/safari/` are added or removed. Regenerating is what most often leaves Safari pointing at a deleted app.

## M1 smoke check

- [ ] Open any website (e.g. https://example.com). In Web Inspector → Elements, there's a `<margin-sidebar-host>` element at the end of `<html>` with a `#shadow-root (closed)`.
- [ ] Press ⌘T. The page is Margin's new tab (title "New Tab"), not Safari's Start Page.

## M2 sidebar overlay

- [ ] On a normal site, the sidebar is hidden. Move the cursor to the very left edge: it slides in over the page (the page does not shift).
- [ ] Move the cursor right, past the sidebar: it hides after about 300ms. Moving back in before that keeps it open.
- [ ] Sites with fixed headers or sticky elements (e.g. github.com, nytimes.com) look unchanged while the sidebar is open.
- [ ] Tab rows show favicon (or letter), title, and close button on hover. Clicking a row switches to that tab, clicking × closes it.
- [ ] Right-click (or ⌃-click) a tab: a menu with Pin Tab, Move to <each other space>, Close Tab. No 📌 on hover. Pin Tab pins it; the pin appears above the divider. Right-click a pin: Unpin (and Close Tab if it's open). Esc, or a click anywhere else, closes the menu; ↓/↑ and Return work in it. Clicking the pin focuses its tab; after closing the tab, clicking the pin reopens it.
- [ ] Space chips at the top switch which tabs are listed (this window only).
- [ ] "+ New tab" opens Margin's new tab page.
- [ ] The sidebar is the same neutral gray (like Arc's) on every site, in every space, and in both Light and Dark Mode. Text is easy to read.
- [ ] Option+S (toggle command) opens the sidebar; Esc or a click on the page closes it. If the shortcut does nothing, check Safari → Settings → Extensions → Margin for shortcut settings and note what works.
- [ ] "Keep open" in the sidebar footer keeps it visible on every page until clicked again ("Auto-hide").
- [ ] No sidebar appears on Margin's own new tab page except the built-in one.

## M3 new-tab page

- [ ] ⌘T shows the sidebar on the left (always open) and a centered search field. Safari puts focus in the address bar first: **this is expected**. Click the field to type.
- [ ] Typing `example.com` + Return opens https://example.com in the same tab.
- [ ] Typing `hello world` + Return searches with Safari's search engine. Before you've searched from Safari's address bar since installing Margin, that's Google (Safari's default); Settings says so.
- [ ] Change Safari → Settings → Search → Search engine (e.g. to DuckDuckGo), search once from Safari's address bar, then search from Margin (launcher or palette ⌥K): it uses the new engine, and Settings names it. There's no engine picker in Margin's Settings.
- [ ] A search typed on an engine's own site (e.g. on duckduckgo.com) doesn't change which engine Margin uses.
- [ ] If Margin doesn't pick up a change: open Develop → Web Extension Background Content → Margin, set the console to show Debug messages, search from Safari's address bar again, and copy the `[margin] … search not from Safari's address bar` line (it shows the URL Safari made).
- [ ] Pin a page (right-click its tab in the sidebar → Pin Tab). New tab shows it as a tile. Clicking the tile focuses the open tab, or opens the page in this tab if it's closed.

## M4 spaces and pins

- [ ] "+" in the chip row creates a space and opens its editor with the name selected. Type a name, set an emoji (Ctrl+⌘+Space), pick a color, Save. The chip updates.
- [ ] Right-click a chip: the editor opens. Rename and recolor work. (If Safari shows its own context menu instead, double-click the chip.)
- [ ] Delete: the first click shows "Really delete?", the second deletes. That space's tabs and pins now show under the first space.
- [ ] With only one space, Delete is disabled.
- [ ] Drag a tab row onto another space's chip: it disappears from the list and appears when that space is selected.
- [ ] Two windows can show different spaces at the same time.
- [ ] Typing in the space editor on github.com doesn't trigger GitHub's keyboard shortcuts.

## M5 command palette

- [ ] Option+K on a website opens the palette, centered, with the cursor in the field. Esc closes it and focus returns to the page.
- [ ] Typing part of a tab title (letters can be scattered, e.g. `gthb` for GitHub) lists it. Tabs from the current space rank above other spaces, and other-space tabs show the space name.
- [ ] ↑/↓ move the highlight, and Enter switches to the tab.
- [ ] Pins and archived tabs show up in results (archive only after typing).
- [ ] "New tab," "Pin current tab," "Toggle sidebar," and "Switch to space …" all work.
- [ ] Typing `example.com` → first row "Open https://example.com" → Enter opens it in a new tab. Typing words → last row "Search for …".
- [ ] On the new tab page, Option+K opens the palette too (click the page first, because the address bar has focus). Entering a URL navigates that tab.
- [ ] New tab → Settings → Command palette shortcut: click, press e.g. ⌃⇧P. It updates there and on already-open websites.

## M6 auto-archive

- [ ] New tab → Settings → "Archive tabs not used for" shows 12.
- [ ] Fast check: set the value to `0.001` (about 4 seconds), open two sites, switch to one, wait 5 seconds, then in the background console run `margin.archiveNow()`. The other tab closes and appears under "Recently archived" on the new tab. Set the value back to 12 afterward.
- [ ] Pinned tabs and the active tab are never archived.
- [ ] × in the sidebar also archives the tab.
- [ ] Clicking an archived entry on the new tab reopens it in that tab, in its original space. In the palette, typing its title shows an "Archived" row, and Enter reopens it in a new tab.
- [ ] More than 12 archived entries shows "Show all N".

## Arc frame and Keep open push

> Superseded (Margin 2, Phase 3, 2026-11-05): the fitted layout, the narrow rail and the per-width first-paint placeholders are gone; the page's box and its first paint come from Margin.app's layout (Phase 3). Kept as history; don't run these checks.


- [ ] Hover the left edge (anywhere within about 10px): the sidebar slides in as a floating rounded card with a shadow, 8px from the window edges. There's no frame and the page doesn't move. Moving right past the card hides it.
- [ ] Full-screen window (⌃⌘F): Margin opens about 24px before the edge, so moving left and stopping there doesn't trigger Safari's own sidebar (that only opens when resting at the very edge, which Margin can't block). Window → Fill: Safari's sidebar never opens from the edge.
- [ ] Turn on "Keep open": the sidebar docks flush left, the Arc frame appears, and the page reflows to start right after the sidebar, nothing is hidden behind it on normal sites, and there's no horizontal scrollbar.
- [ ] With "Keep open" on, load a new site (e.g. github.com): the sidebar and push are there right away, before the page finishes loading, with no slide-in and no unstyled flash. To measure: Web Inspector on the page → Console → enable **Debug** messages, and after the page loads look for `[margin] timing (ms) injected=… storage=… rendered=… | page DOMContentLoaded=… load=…`. `rendered` should be well below `load` (Chromium: about 20–45 vs 1,500 on a slow page).
- [ ] Sticky headers (github.com, conventionalcommits.org) stay inside the frame. Note any site whose fixed header sits under the sidebar or that looks broken.
- [ ] With "Keep open" on, open a fast site (google.com): the page appears already shifted inside the frame from its very first frame (the sidebar's contents may fill in a split second later). There should be no visible jump from full width to pushed.
- [ ] ⌥S or "Auto-hide" removes the push immediately and the page goes back to full width.
- [ ] Print preview (⌘P) shows the page without the shift.
- [ ] The new tab page uses the same frame look.

## Highlighted tab

- [ ] Open five or six pages in a row (e.g. several searches from the new tab), then switch between them from the sidebar and with Safari's own tab bar or ⌃Tab. Every time, exactly one row is highlighted: the page you're on.

## Tab and space shortcuts

- [ ] On a website, ⌘⌥↓ switches to the next tab in the sidebar's order (open pins first), and ⌘⌥↑ to the previous. Both wrap around at the ends.
- [ ] ⌘⌥→ / ⌘⌥← switch to the next/previous space. In auto-hide mode the sidebar peeks open for about a second showing the new space. With "Keep open" it just switches.
- [ ] Both work on Margin's new-tab page (click the page first; Safari focuses the address bar on a new tab).
- [ ] Note any of the four combos that Safari or macOS swallows (nothing happens). Record them in DECISIONS.md.

## Site icons

- [ ] Visit a few sites (github.com, google.com, youtube.com). Within a second or two of each page loading, its sidebar row shows the real site icon instead of a letter. Icons also show in the palette, on pinned tiles on the new tab, and for closed pins and archived tabs.
- [ ] Check what was stored: background console → `browser.storage.local.get('favicons').then(s => Object.entries(s.favicons).map(([o, f]) => [o, f.data.length]))`. Entries are `data:image/png…` of roughly 1–3k characters (larger means Safari couldn't shrink them; note it).
- [ ] A site whose icon can't be fetched still shows a colored letter, with no errors in the page.

## ⌘T / ⌘N

- [ ] On a website, ⌘T: the new tab disappears (it may flash briefly), you're back on the page, and the command palette is open. Note whether you can type straight away or the cursor is in Safari's address bar. Typing a URL or search + Enter opens it in a new tab.
- [ ] ⌘N: a new window opens showing Margin's new-tab page with the palette open, and the sidebar shows the same space as the window you came from.
- [ ] "+ New tab" in the sidebar opens the palette.
- [ ] Palette → "Margin start page & settings" opens the launcher page (with Settings) and it stays open.

## Which ⌘⌥-arrow keys reach Margin

- [ ] On a normal website, open Web Inspector → Console and paste:
  `addEventListener('keydown', e => e.key.startsWith('Arrow') && console.log('[key]', e.key, 'cmd', e.metaKey, 'opt', e.altKey), true)`
  Then click the page and press ⌘⌥↑, ⌘⌥↓, ⌘⌥←, ⌘⌥→. Every combo that prints a `[key]` line reaches Margin; one that prints nothing is taken by Safari or another app first. Also look in Safari's **Window** menu for shortcuts shown next to "Show Previous/Next Tab", and check apps like Rectangle, Magnet, Raycast or BetterTouchTool for ⌘⌥ arrow bindings.

## Resizing the sidebar

- [ ] Hover the sidebar's right edge: the cursor becomes ↔ and a light rounded line appears just inside the sidebar edge, running the height of the page, almost touching it (like Arc). Drag: the sidebar resizes live between about the widths in Tirth's two Arc screenshots (160–500), and stops at both ends.
- [ ] With "Keep open" on, the page and the frame move with the edge while dragging. Release: other tabs use the new width, and newly opened pages appear at the new width from their first frame (no jump from the old width).
- [ ] In hover mode the sidebar stays open while you drag, and the page doesn't move.
- [ ] Double-click the edge: back to the default width.
- [ ] At the narrowest width the footer shows "+ New tab" and just the ⇤/⇥ icon, all on one line.

## Keyboard shortcuts (settings) and ⌘N

- [ ] New tab → Settings → Keyboard shortcuts shows: palette ⌥K, next tab ⌥⌘↓, previous tab ⌥⌘↑, next space ⌃⌘→, previous space ⌃⌘←.
- [ ] On a website: ⌥⌘↓/↑ move through the sidebar's tabs; ⌃⌘→/← switch spaces (the sidebar peeks open).
- [ ] If one doesn't work: click its field in Settings and press it. If the field stays empty, Safari or macOS keeps that combination. Record another, and note the one that was swallowed in DECISIONS.md.
- [ ] ⌘N in a **normal** window opens a new window with the palette. In **full screen**, macOS turns ⌘N into a tab (System Settings → Desktop & Dock → "Prefer tabs when opening documents"). Use ⌥⌘N or palette → "New window" there, or set that option to *Never*.
- [ ] Background console after ⌘T / ⌘N: a `[margin] new tab … in window …: …` line explains what Margin did.

## Command bar look

- [ ] ⌥K or ⌘T: a dark, slightly see-through panel about half the window wide, a third of the way down, with "Search or Enter URL…". Rows show favicon, title, the space name and an arrow button. The selected row is filled with the current space's color.

## Navigation shortcuts (⌃⌘ + arrows everywhere; ⌥⌘↓/↑ on pages)

- [ ] Settings shows ⌥⌘↓ / ⌥⌘↑ for next/previous tab (also after upgrading from a version that showed ⌃⌘; shortcuts you changed yourself stay).
- [ ] ⌃⌘↓ / ⌃⌘↑ switch to the next/previous tab in the sidebar's order, also when pressed quickly several times in a row, and right after a page starts loading.
- [ ] ⌥⌘↓ / ⌥⌘↑ do the same once you've clicked into a page. If they do nothing, run the check in "Which ⌘⌥-arrow keys reach Margin" below.
- [ ] ⌃⌘→ / ⌃⌘← switch spaces (the sidebar peeks open).
- [ ] They also work while the address bar has focus and on pages where Margin has no sidebar (e.g. a PDF). That's the extension-command path: if they don't work there but do on normal pages, Safari isn't delivering the commands, so note it.
- [ ] Holding ⌥⌘↓ repeats (page path) on normal pages.

## Trackpad gestures (Safari)

- [ ] On a normal page, two-finger swipe left/right does **not** go back/forward. Vertical scrolling is unaffected, and so are things that scroll sideways (a carousel, a wide table, a horizontally scrolling page): they scroll.
- [ ] Pinching in (two fingers together) at normal zoom does **not** open the all-tabs overview, on web pages and the new-tab page.
- [ ] If the overview still opens: on that page, open Web Inspector → Console, paste
  `['gesturestart','gesturechange','gestureend'].forEach(t => addEventListener(t, e => console.log(t, e.scale.toFixed(2), 'blocked:', e.defaultPrevented, 'zoom:', visualViewport.scale)))`
  then pinch in once and send the lines. "blocked: true" on all of them while the overview still opens means Safari doesn't let pages stop it.
- [ ] Same on the new-tab page.
- [ ] New tab → Settings → "Block Safari's swipe back/forward and pinch for all tabs" off: both gestures work again on pages you then use.
- [ ] Known gaps: over an embedded frame (e.g. a YouTube video inside another page) the gestures still work; a swipe that starts mostly up/down and turns sideways can still go back.

## Vertical scrolling (Safari)

- [ ] Scroll to the bottom of a long page and keep scrolling: the page stops, with no rubber-band and no dark gap below it. Same at the top.
- [ ] Safari's own pull-to-refresh spinner never appears.
- [ ] At the top of a page, pull down with two fingers (scroll up) and hold: a dark round badge slides down from the top of the page, its ring filling. Past the threshold the arrow flips up; let go and it spins and the page reloads. Let go before that: it slides away, no reload.
- [ ] A quick flick up at the top, or scrolling up from further down the page into the top, never reloads. A mouse wheel never reloads.
- [ ] Scrolling over the sidebar never scrolls the page. With more tabs than fit, the tab list scrolls (and stops at its ends without moving the page).
- [ ] With the palette open, scrolling moves only its results.
- [ ] Settings: "Pull down at the top of a page to reload" off: pulling does nothing. "Block Safari's swipe… and page bounce" off: the bounce and Safari's own pull-to-refresh come back (Margin's is then off).

## Pinch to zoom and swipe back/forward (Safari)

- [ ] Swipe right with two fingers (back): a dark round badge with ← appears on the page's left edge, darkening as you swipe; let go past the point where it's fully dark and the page goes back. Swipe left: → on the right edge, forward. A short swipe, or one over a carousel/wide table that scrolls sideways, doesn't navigate.
- [ ] Settings → "Swipe sideways with two fingers to go back or forward" off: no badge, no navigation.

## Optional feature flags (Safari → Settings → Feature Flags)

- [ ] "CSS corner-shape property" on or off: corners look the same, rounded (Margin doesn't use it; Safari's experimental version draws squares).
- [ ] "Threaded Time-based Animations" on: sidebar slide/badges stay smooth while a heavy page is loading.
- [ ] A fresh tab with no history: swiping back shows no badge. After clicking a link, swiping back works.
- [ ] Settings toggles look like macOS switches.

## Page card (Keep open)

> Superseded (Margin 2, Phase 3, 2026-11-05): the fitted layout, the narrow rail and the per-width first-paint placeholders are gone; the page's box and its first paint come from Margin.app's layout (Phase 3). Kept as history; don't run these checks.


- [ ] The page's corners are rounded (small, about 6pt, like Arc's), not square. Same on the new-tab page.
- [ ] A soft shadow around the page, a little stronger along the bottom edge. No thin outline.
- [ ] Opening a page: the corners and shadow are there from the first frame and don't change when Margin finishes loading. Resizing the sidebar: they move with the edge.

## Page-load indicator

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


- [ ] With "Keep open" on, reload a page (⌘R): a small dark pill appears centered in the gray strip above the page, pulses gently while it loads, and fades out when done. Click a link to another page: same.
- [ ] In auto-hide mode the pill shows at the very top of the page, centered on the window.
- [ ] It never blocks clicks, and very fast pages don't leave it behind.
- [ ] Press ⌘R on a slow page (e.g. YouTube): the pill appears right away, on the current page, and stays until the page has reloaded, without blinking off in between (Keep open). In auto-hide mode, a short gap right as the new page appears is expected.
- [ ] Click a download link: the pill may appear; it goes away on your next click or key press (or after 10s).

## Fitted layout with Keep open (Safari 27)

> Superseded (Margin 2, Phase 3, 2026-11-05): the fitted layout, the narrow rail and the per-width first-paint placeholders are gone; the page's box and its first paint come from Margin.app's layout (Phase 3). Kept as history; don't run these checks.


Retired 2026-11-01: there's no iframe now. Kept for its list of sites to try.

Setup: load `dist/safari/` (Develop → Add Temporary Extension…), allow Margin on every website, turn **Keep open** on, then reload the tabs you test in. Turning Keep open on doesn't refit pages that are already open. To see why a page wasn't fitted, open its Web Inspector console with Debug messages shown: `[margin] fitted layout: …`.

**Layout**
- [ ] github.com, youtube.com, google.com, a news site: the page sits in the card beside the sidebar, and nothing is cut off on the right. Pinned headers span exactly the card, and the site's narrow (tablet) layout kicks in when you widen the sidebar. Dragging the sidebar edge re-lays the page out live.
- [ ] Sites that refuse to be framed load normally: gist.github.com, pypi.org, accounts.google.com.
- [ ] macOS full screen (green button): same layout. A YouTube video's own full-screen button fills the screen, and Picture in Picture works.
- [ ] A page opens without flashing an empty gray card: the previous page stays until the new one is ready.
- [ ] No blank moment between pages: click links on a few sites (a news site, GitHub, YouTube). The previous page stays until the new one appears with its sidebar; nothing goes white or gray in between. The same after ⌘R and Back.

**Navigation and Safari's UI**
- [ ] Click links A → B → C, then Back, Back, Forward: each lands on the right page. Long-press Back: the titles are right. History menu: the visits are there.
- [ ] The address bar, tab title, favicon and Safari's tab color match the page. The loading bar and stop button work while a page loads.
- [ ] ⌘R reloads in place and keeps the scroll position. Back to a logged-in page (Gmail, a bank) also keeps the scroll position.
- [ ] GitHub: open a repo, click files and folders (in-page navigation), then Back and Forward. YouTube: open videos from the home page, then Back.
- [ ] A link to a section (#heading): it scrolls there, the address bar shows the #, and Back scrolls back.
- [ ] GitHub (its CSP limits frames): click files, folders, commits and a link with a #fragment; submit the search; ⌘-click a link (opens a background tab next to the page, in click order for several), ⌘⇧-click (foreground tab), ⌘⌥-click (new window); download a raw file or a release asset. No "Refused to load … frame-src" leaves you stuck.
- [ ] ⌘-click opens a link in a new tab. Option-click downloads. A download link downloads. mailto: opens Mail.
- [ ] Space, arrows, ⌘F and the page's own keyboard shortcuts (YouTube k/f/j/l) work right after a page opens, without clicking it first.

**Margin's own features on a fitted page**
- [ ] ⌥K palette, ⌥S toggle (Keep open off: the page widens to the whole window and the sidebar floats over it on hover; ⌥S again: back beside it), ⌘⌥↓/↑ tabs, ⌃⌘→/← spaces, all with the focus in the page.
- [ ] Pull down at the top to reload, two-finger swipe back/forward, pinch to zoom, the loading pill.
- [ ] Palette → "Show this site without fitting it beside the sidebar": the page reloads with the push layout. Palette → "Fit this site beside the sidebar again": it reloads fitted.
- [ ] Settings → "With Keep open, fit pages beside the sidebar" off: the next page loads with the push layout.

**Logins and forms**
- [ ] Log in on a site with Safari's saved passwords: AutoFill offers the password, and a new login offers to save it.
- [ ] A passkey login (e.g. github.com with a passkey).
- [ ] A search or comment form posts and shows the result. ⌘P prints the page (not the sidebar).

**Known and accepted** (DECISIONS.md, "Fitted layout"): Reader and Hide Distracting Items, other extensions that only act on the top of a page, File → Print, progressive rendering of slow pages, typed form fields on Back without Safari's page cache, text-fragment highlights.

## Option+S and the tab menu (Safari)

- [ ] ⌥S shows and hides the sidebar on any page, including while a text field has focus. Settings → Keyboard shortcuts → "Show or hide the sidebar" can change it.
- [ ] Right-click a tab in the sidebar → Pin Tab: it moves to the pinned section. Right-click → Move to another space, and Close Tab: both work. Same on the new-tab page's sidebar.

## Switching tabs and Margin updates

- [ ] Clicking a tab in the sidebar (or the palette, a pin, ⌃⌘↓/↑) switches without a black frame, including to tabs you left minutes ago: the previous tab stays until the new one is drawn.
- [ ] A tab Safari unloaded (after quitting and reopening Safari, or one unused for a long time): the sidebar and frame appear right away and the page fills in, with at most a brief empty moment while Safari fetches it.
- [ ] After reinstalling or updating Margin, the tab you're on has one working sidebar right away (clicking tabs in it switches at once), and reloads by itself once you leave it; the other open tabs reload by themselves within a few seconds; each comes back fitted (with Keep open) and doesn't reload again. A tab with text typed into a field isn't reloaded.
- [ ] Allowing or denying Margin on a site in Safari's settings doesn't reload any tab.

## After the restructuring (bundles, modules, background split; 2026-10-25)

Files were added under `dist/safari/`, so re-run `scripts/make-xcode.sh`, then Run in Xcode.

- [ ] Sidebar appears on a fresh page; tabs, pins and spaces render; drag-resize works.
- [ ] Option+K opens the palette on a web page and on the new-tab page; ⌘T hands off to the palette over the previous tab.
- [ ] Switching tabs from the sidebar, palette and ⌃⌘↓/↑ (and ⌥⌘↓/↑); spaces with ⌃⌘→/←.
- [ ] "Keep open" with fitted pages: pages load fitted, links and forms work, no blank flash.
- [ ] Pin, close (archives), restore from the archive, create/rename/delete a space, move a tab to a space.
- [ ] Settings on the new-tab page save (shortcuts, gestures, archive hours).
- [ ] Pull-to-refresh and two-finger swipe back/forward; pinch zoom.
- [ ] Site icons appear for new sites.
- [ ] After changing Margin's website access in Safari's settings, Option+K still opens the palette once (not open-then-close).

## Themes: Arcadia in its own folder (2026-10-25)

Files were added and moved under `dist/safari/`: re-run `scripts/make-xcode.sh`, then Run in Xcode. Nothing should look or behave differently.

- [ ] After installing, pages you open show the sidebar as before (it now comes from `themes/arcadia/`). Also right after relaunching Safari: the first restored tabs still get it (they ask the background for the theme if Safari hasn't loaded its registrations yet).
- [ ] "Keep open": the first paint already shows the frame (placeholder), pages push or fit as before, and resizing still saves the width (it's now Arcadia's own setting; your old width carries over).
- [ ] The new-tab page looks the same; Settings has a new "Theme" row showing Arcadia.
- [ ] ⌘T still hands off to the palette over the previous tab (the new tab now closes without drawing the launcher first); ⌘N's first tab opens the palette over the launcher.
- [ ] Loader pill, pull-to-refresh and swipe badge look and behave as before.

## Sites that don't want a frame (2026-10-26)

With Keep open on:

- [ ] Outlook (outlook.office.com) and its sign-in page load once and stay; no reloading.
- [ ] docs.new creates one document and opens it; no loop. Docs, Teams, Outlook and claude.ai show in the normal (pushed) layout, Teams with its top bar.
- [ ] GitHub: open a commit through in-page navigation (repo → file → its latest commit), then click files in the commit's file tree: it scrolls to that file's diff and stays on the commit.
- [ ] YouTube: the address bar follows videos you open; ⌘R reloads the video you're on.
- [ ] (Retired.) On a fitted site, the sidebar footer shows ▢; clicking it reloads the site in the normal layout and shows ▣; clicking ▣ fits it again.
- [ ] Known (WebKit): after switching away from a fitted tab and back, its scrollbar may not draw until the next load; scrolling still works.

## Chrome: Margin full screen (2026-10-26)

Reload Margin in chrome://extensions after pulling.

- [ ] Open the palette, type "full screen", Enter: the window goes full screen with no toolbar.
- [ ] Switching tabs from Margin's sidebar, opening a tab from the palette, ⌘-clicking a link: the toolbar never shows.
- [ ] Moving the pointer to the top of the screen: what happens (expected: nothing)?
- [ ] Esc, and the palette action again: which ones leave Margin full screen, and the window comes back as it was?
- [ ] Starting from Chrome's own full screen (green button): the action leaves it and enters Margin full screen.
- [ ] Going full screen with the green button, Globe-F (Fn-F) or ⌃⌘F: after a short extra animation, the window is in Margin full screen (no toolbar on tab changes).
- [ ] A YouTube video's full-screen button: the video goes full screen as usual (Margin leaves it alone), and Esc brings it back.
- [ ] Settings → "In full screen, hide Chrome's toolbar" off: the green button gives Chrome's own full screen again.

## Chrome: Margin only in full screen (2026-10-26)

Reload Margin in chrome://extensions after pulling.

- [ ] In a normal window: no sidebar. Moving the pointer to the left edge, ⌥K or ⌥S shows "Margin works in full screen." at the top left.
- [ ] Its "Go full screen": the window enters Margin full screen and the sidebar works.
- [ ] Leaving full screen (Esc): the sidebar goes away again.
- [ ] ⌘T in a normal window: the new tab shows the "Margin works in full screen" card; ⌘T in full screen: the palette as before.
- [ ] "Use in windows too" (toast or card): Margin works in normal windows; Settings → "Use Margin only in full screen" turns it back on.

## Chrome: fitted layout (2026-10-26)

> Superseded (Margin 2, Phase 3, 2026-11-05): the fitted layout, the narrow rail and the per-width first-paint placeholders are gone; the page's box and its first paint come from Margin.app's layout (Phase 3). Kept as history; don't run these checks.


Retired 2026-11-01, as above.

Reload Margin in chrome://extensions after pulling. Keep open on, in Margin full screen.

- [ ] YouTube, GitHub, Figma, Google Maps, BBC, Stack Overflow: the page fits beside the sidebar, nothing under the sidebar or cut at the right.
- [ ] Links, Back/Forward, the address bar and ⌘R behave as without Margin (GitHub: open a file, then its commit, then Back).
- [ ] Your password manager fills a login on a fitted page (e.g. GitHub sign-in). If not, say which one.
- [ ] Signed in: Gmail, Notion, Figma work normally. Teams, Outlook, Docs stay in the normal (pushed) layout.
- [ ] The sidebar footer's ▢ "Show this site normally" reloads the site unfitted; ▣ fits it again.
- [ ] Leaving full screen: newly loaded pages are normal; with one window in full screen and another not, pages in the other window aren't fitted.

## The narrow rail (2026-10-26)

> Superseded (Margin 2, Phase 3, 2026-11-05): the fitted layout, the narrow rail and the per-width first-paint placeholders are gone; the page's box and its first paint come from Margin.app's layout (Phase 3). Kept as history; don't run these checks.


Keep open on (Safari, and Chrome in Margin full screen), signed in:

- [ ] Teams, Outlook, Google Docs: a narrow icon rail on the left, the page pushed by it only. Are their left app bars and top-right buttons (profile, settings) usable?
- [ ] Clicking a tab icon in the rail switches tabs; resting the pointer on the rail opens the full sidebar over the page; moving away folds it back.
- [ ] Fitted sites (YouTube, GitHub, Figma) keep the full sidebar.
- [ ] Settings → "show a narrow sidebar of icons" off: those sites are pushed by the full sidebar again.

## One sidebar across pages (2026-10-26)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


- [ ] Leave a tab alone for a while (or for hours), open several tabs elsewhere, go back to it: its sidebar lists them all at once, no reload needed.
- [ ] Scroll the sidebar's tab list on one page, switch tabs: the next page's sidebar is at the same position; a new page too.
- [ ] Hover the left edge, click a tab in the sidebar: the next page shows the sidebar still open (it closes when the pointer moves away); going back, the first page's sidebar isn't left open.

## ⌘T and "+ New Tab", Arc-style (2026-10-26)

- [ ] ⌘T: the palette opens over the page you're on (no new tab left in the tab bar); the sidebar highlights "+ New Tab" fully and your tab softly (lighter than "+ New Tab"). Typing works at once (keyboard not stuck in the address bar).
- [ ] Escape, or clicking outside the palette: your tab is fully highlighted again.
- [ ] Typing a URL and Enter: it opens in a new tab; the highlight goes straight from "+ New Tab" to the new tab (never back to your tab in between).
- [ ] ⌘T on a non-web page (Settings, a PDF, Margin's start page): the palette opens on the new tab instead; clicking outside closes that tab and you're back.
- [ ] Margin's start page: its "+ New Tab" row highlights, and a typed address opens in a new tab (the start page stays).
- [ ] Safari: close a tab, ⌘T then Escape, then ⌘⇧T (Reopen Last Closed Tab): the tab you closed comes back, not an empty new tab.
- [ ] The sidebar's "+ New Tab" row does the same, with no flicker at all.
- [ ] Tabs are newest first, pins on top, "+ New Tab" right below them.
- [ ] How much of a flash do you still see on ⌘T (first one after launching vs later ones)?

## Command palette at Arc's size (2026-10-26)

- [ ] In Safari full screen, ⌥K or ⌘T: the palette matches Arc's command bar in size and place (765 wide, centered on the window, about a third of the way down, five rows).
- [ ] With more than five results, the arrow keys scroll the list and the selected row is never cut off; no scrollbar shows.
- [ ] On a page zoomed in or out in Safari (⌘+ / ⌘−), note whether the palette grows or shrinks with the page (it's drawn inside the page).

## Switching without black; ⌘T and "New tabs open with" (2026-10-26)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


- [ ] Switch through the sidebar, the palette and ⌥⌘↓/↑ to tabs you haven't used for a few minutes: fewer black flashes than before; switching never feels slower than about half a second.
- [ ] Start page → Settings → Switch log (development) → Copy, after a session of switching, and send it along with any black flash you saw (and roughly when).
- [ ] Safari Settings → General → "New tabs open with" → Margin, then ⌘T: Margin's palette over the page.
- [ ] With it on Homepage instead: ⌘T twice (each opening the homepage) shows a note on the second about where to set it; "Don't show again" stops it.

## Instant feedback on switching (2026-10-26)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


- [ ] Click a tab in the sidebar: it's highlighted at once (your page's tab softly) before the page changes.
- [ ] Switching to a tab you haven't used for a while: if it takes a moment, the small loading pill shows at the top; quick switches never show it.
- [ ] ⌥⌘↓/↑ and the palette: the same.
- [ ] Clicking your own tab again during a slow switch keeps you where you are.

## Narrow rail off (2026-10-27)

> Superseded (Margin 2, Phase 3, 2026-11-05): the fitted layout, the narrow rail and the per-width first-paint placeholders are gone; the page's box and its first paint come from Margin.app's layout (Phase 3). Kept as history; don't run these checks.


- [ ] With Keep open, a page Margin can't fit (Teams, Outlook, Docs, or "Show normally" on a site): the full sidebar beside it, no narrow icon rail; the start page's Settings has no rail switch.

## Arc's sidebar and folders (2026-10-27)

- [ ] The sidebar looks like Arc's: toggle at the top left, the space's name, folders and pins, "+ New Tab" and tabs in one list, the bottom bar (archive, spaces, +).
- [ ] "+" → New Folder: type a name, Enter. Right-click a tab → Pin to 📁 that folder; drag another tab onto the folder; drag a pin out; drag pins to reorder; drag a pin onto the tabs to unpin it.
- [ ] Click a folder to close it; with one of its tabs shown, that pin still shows under it. Double-click renames.
- [ ] An open pinned tab's × closes the tab, the pin stays. Right-click → Unpin.
- [ ] Bottom bar: click a space's emoji to switch; right-click or double-click the space name to edit it; the archive button opens "Recently archived".

## Instant switching; spaces show their last tab (2026-10-27)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


- [ ] Switch between two tabs in the sidebar: the highlight jumps in one go (no soft step), no tooltip pops up, and the page follows almost at once.
- [ ] Rest the pointer on a row, switch away with the keyboard, switch back without moving the mouse: no hover or × on that row until you move.
- [ ] Click another space's emoji: that space's last tab comes to the front; an empty space opens the start page; ⌃⌘←/→ the same.
- [ ] Close the tab you're on (× or ⌘W): you stay in the same space, on its last used tab.

## A tab that slept through an update (2026-10-27)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


- [ ] Rebuild Margin with a few tabs open, leave one unused (asleep) during the rebuild, then switch to it: its sidebar works (switching from it lands), no stuck highlight or pill.
- [ ] If Margin ever stops responding on a page, a note offers Reload after a few seconds; Reload fixes it.

## An empty screen while switching (2026-10-27)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


- [ ] Click another tab in the sidebar: the page you're leaving turns into a plain gray card at once (no flash of its content), a spinner shows in the middle if it takes a moment, then the other tab appears.
- [ ] Switch back and forth quickly: coming back to a tab never shows the gray card or a spinner before its page.
- [ ] Same from Margin's new-tab page, from the palette, with the sidebar on auto-hide (the whole page goes gray), and on a fitted site.
- [ ] ⌘T and "+ New Tab" show no gray card.
- [ ] Hold ⌃⌘↓: the tabs go by with their content (no gray cards); one press to a slow tab shows the gray card after a moment.
- [ ] Tab overview: tabs you left through the sidebar may look gray there (accepted); say if that bothers you.

## A tab shown for the first time (2026-10-29)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


- [ ] ⌘T, an address of a busy site (youtube.com, a Google search), Enter: as the new tab comes up there's no dark frame at all; record the screen and step through it frame by frame around the switch.
- [ ] While the new tab loads behind, nothing flickers: not the page you're on, its cover or highlight, nor Safari's tab bar or address bar if they're showing.
- [ ] ⌘-click a few links (they open behind), wait a few seconds, then click their rows in the sidebar: no dark frame either.
- [ ] With a video playing in the page you're on, ⌘T and an address: the video doesn't pause and resume as the new tab is introduced.
- [ ] After the new tab is shown: the sidebar highlights it and stays in its space; ⌃⌘↓ goes on to the next tab, ⌃⌘↑ back.
- [ ] If anything above goes wrong, say so: Safari's log (Console, process Safari, `hideContentUntilPendingUpdate`) and Margin's switch log (`introduced` on those switches) show what happened.

## Tabs of the space kept ready (2026-10-29)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


- [ ] Use a few tabs of a space, leave one for a minute or more, then switch back to it with Safari's own tab bar or ⌃Tab: no dark flash. The same from Margin's sidebar.
- [ ] Settings › "Keep the tabs of the space you're in ready…" shows 30; set 0 and the flashes from Safari's own switching come back after a minute; set it back.
- [ ] After 30 minutes without using Safari, Activity Monitor's Energy tab shows Safari's web content processes going quiet again.
- [ ] A tab Safari unloaded (shown as reloading when you click it) still loads only when clicked.

## A new tab from ⌘T shows once it has loaded (2026-10-28)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


- [ ] On a page, ⌘T, type an address of a slow site (youtube.com), Enter: the page you were on stays, covered by the empty screen with its spinner, and the new tab's row appears in the sidebar at once, highlighted; no dark empty tab. Once the site has loaded it comes to the front, the sidebar open and scrolled as before.
- [ ] The same with a search (words, Enter): the results come to the front once loaded; Margin's search engine (Settings) doesn't change because of it.
- [ ] Meanwhile, click your own tab's row: you stay; the new tab stays in the sidebar, loaded, and shows when clicked. Same if you pick another tab in Safari's tab bar.
- [ ] Meanwhile, close the new row with its ×: nothing comes to the front, no notice.
- [ ] In a text field (a comment box), ⌘T, an address, Enter, then type: nothing goes into the field; Escape: you stay, the new tab stays behind. ⌘T again while it loads: the palette opens and the new tab stays behind.
- [ ] A site that keeps loading and draws nothing (or a very slow one): it comes to the front after about 5 seconds, as far as it got. (2026-11-02: a site that has drawn comes to the front then, loaded or not.)
- [ ] ⌘T, Enter, then switch to another app or window before it loads: Margin doesn't pull the window forward; back in it, the new tab is in front.
- [ ] From Margin's start page (`#launcher`) "+ New Tab": an address there behaves the same.
- [ ] In a fitted site (Keep open + Fit pages beside the sidebar): the same, the cover over the page only.
- [ ] (2026-10-29) As the new tab comes to the front there's no dark flash: the same cover, then the page fading in. Try a busy site (youtube.com, a Google results page) and record the screen if anything flickers.
- [ ] A site that focuses its search or login field (github.com/login, duckduckgo.com): typing goes into the field once it's shown.
- [ ] ⌘-click a link (it opens behind), then click its row in the sidebar: no dark flash either.

## Switching, getting ready, one copy in charge (2026-10-28)

Install the build once, then **quit and reopen Safari** (an earlier copy of Margin can keep running until Safari quits).

- [ ] Quit and reopen Safari, allow unsigned extensions: while Margin starts, a page you're looking at shows "Getting your tabs ready…" over everything for a moment (or nothing, if it's quick), then the sidebar with your spaces. Clicking another tab right away switches to it once and stays there.
- [ ] After that relaunch: are your spaces, pins and folders still there? (Safari may clear an unsigned build's data at each launch: Start page → Settings → Switch log, look for `emptyStorage`.)
- [ ] Switch to a tab Safari hasn't loaded since the launch: Safari shows its empty view briefly, then the page; Margin's sidebar on it shows that tab highlighted, in its own space, open if the sidebar was open, from its first frame.
- [ ] Switch among loaded tabs with the hover sidebar open and its list scrolled: the next page shows the same sidebar (scroll, open, highlight) with no jump. Leave a tab unused for a few minutes and switch to it: the old page stays covered until it's ready, no black frame.
- [ ] Close a tab from another window or Safari's tab bar, then click its row in a sidebar that still lists it: "That tab is no longer open." and the row goes; no highlight sitting on it.
- [ ] Rebuild in Xcode while Safari runs, then click rows in pages that were open: they switch (no 2–3 s highlight going back). A tab that was asleep through the rebuild shows the current sidebar when you switch to it (not the old one first).
- [ ] Spaces stay right: move tabs between spaces, rebuild, relaunch, switch from the palette to a tab in another space: the sidebar shows that tab's space at once and the tab stays in it.
- [ ] After a rebuild, a hidden page whose address has a `#` (Gmail) reloads once in the background; the tab in front of a minimized window too; no page keeps reloading (Safari's log: no repeated loads of the same hidden tab).
- [ ] A notice's Reload button reloads a page whose address has a `#`.
- [ ] Start page → Settings → Switch log (development) → Copy: switches show `preparation.outcome: "ready"` for loaded tabs; errors only for tabs that closed.

## Swipe between spaces (2026-10-27)

- [ ] With two or more spaces, swipe two fingers left over the sidebar: the list follows your fingers, the next space slides in, and on letting go it's shown with its last tab in front.
- [ ] Swipe right: the previous space. A short, slow swipe slides back. A quick flick switches.
- [ ] At the first or last space the list only stretches a little and comes back.
- [ ] Scrolling the tab list up and down still works; a sideways swipe on the page itself still goes back/forward.
- [ ] Same on Margin's new-tab page and with the sidebar on auto-hide: while it's out, swiping keeps it out on the page that comes forward (clicking a space's icon too).
- [ ] Swipe, then right away swipe again or scroll the list: it responds at once (not after a pause).

## Like the browser's own UI (2026-10-27)

- [ ] ⌘+ / ⌘− on a page: the page zooms, the sidebar and the frame stay the same size; the page still starts right after the sidebar; resizing the sidebar, its menus and swiping still line up.
- [ ] Pinch over the page zooms it; pinch over the sidebar does nothing.
- [ ] On Margin's new-tab page, ⌘+ zooms the launcher only.
- [ ] Try to select or drag text/icons in the sidebar, palette or new-tab page: nothing. Typing and selecting in the space name, rename fields, the palette and Settings fields still works.
- [ ] Right-click: on a tab, pin or folder, Margin's menu; anywhere else on the sidebar, the frame strips or the new-tab page, nothing; in a text field, the usual Cut/Copy/Paste.

## Tabs keep their spaces (2026-10-27)

- [ ] Put tabs in two or three spaces, rebuild Margin in Xcode: every tab is still in its space.
- [ ] Quit Safari with tabs in several spaces and reopen it (tabs restored): every tab is back in its space, and clicking a space brings its last-used tab.
- [ ] If Safari opens with a new window: History › Reopen All Windows from Last Session: the reopened tabs go back to their spaces.

## ⌘T with no flicker (2026-10-27)

- [ ] With Safari's "New Tab" moved to another shortcut (System Settings › Keyboard › App Shortcuts): ⌘T on a page opens Margin's palette at once, no tab appears, nothing flickers; Escape leaves you where you were; choosing a page opens one new tab.
- [ ] ⌘T on Margin's new-tab page and in a fitted site: the same.
- [ ] ⌘T with the address bar focused, on Safari's own Start Page or a PDF: a new tab with Margin's palette opens (Margin's ⌘T shortcut, app-wide).
- [ ] ⌃⌘← (previous space) still works on web pages; ⌃⌘→ everywhere.

## The set-up window (2026-10-28)

Run `scripts/make-xcode.sh`, then Run in Xcode (the reports need the packaged app; turn off a temporary copy of Margin).

- [ ] The window opens titled "Set up Margin", fits the screen, can be resized and minimized, and keeps its place after ⌘H and back.
- [ ] Turn Margin off and on in Safari's Extensions: the first step follows within a few seconds; "Open Safari Settings" opens Margin's page there.
- [ ] Load a page in Safari: "every website" turns done or to do to match Edit Websites… (change it, load a page within a minute: it follows).
- [ ] "Test: ⌘N, then +": with both new-window and new-tab settings on Margin it says "It works." and the step is done; with "New tabs open with" on Homepage, it fails naming the new-tab setting; on Start Page, it times out naming it.
- [ ] Quit and reopen Safari: the new windows and tabs step is to do again until a new window and tab open Margin's page.
- [ ] "Test: press ⌘T in Safari": with the App Shortcut set, passes; without it, fails ("Safari opened a new tab…") when new tabs open Margin. Clicking Safari's + afterwards leaves ⌘T done.
- [ ] Quit the app, use Safari a while, reopen it and run a test at once: it still hears Safari.
- [ ] "Copy “New Tab”" and "Copy Karabiner rule" put the text on the clipboard; "Open Keyboard Settings" opens Keyboard settings.
- [ ] Dark mode looks right.

## A tab Safari hasn't loaded (2026-10-29)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


Quit and reopen Safari with several tabs in a few spaces (Safari brings them back unloaded), then:

- [ ] Click rows of tabs you haven't opened since the relaunch: the page you're on stays, covered by the empty screen with its spinner, the row highlighted; then the tab comes up drawn. No dark window at any point; record the screen and step through it frame by frame.
- [ ] The same with ⌃⌘↓ / ⌃⌘↑, a space chip in the sidebar (its last tab unloaded), ⌃⌘→, a tab picked in the palette, and closing the tab you're on with its ×.
- [ ] Hold ⌃⌘↓ over several unloaded tabs: the highlight keeps moving, nothing dark shows for the tabs passed; where you let go, that tab comes up once loaded.
- [ ] While one loads, click another unloaded row: that one comes up, drawn; the first shows at once when clicked later. Double-click a row, or click it again while it loads: the cover stays until it comes up, no dark frame.
- [ ] A heavy site unloaded (a news site, YouTube): no dark frame as it comes up, not even a short one.
- [ ] A space chip whose last tab is unloaded, then Escape while it loads: you stay on the page and space you were on.
- [ ] From a PDF or Safari's Start Page in front, ⌃⌘↓ to an unloaded tab: it comes up at once, as before (dark while it loads: nothing can cover a page Margin doesn't run in).
- [ ] An unloaded tab in another window, picked in the palette: that window comes forward at once, covered, and the tab comes up once loaded.
- [ ] The tab keeps its history: Back goes where it went before the relaunch; it's scrolled where you left it.
- [ ] While it loads, nothing flickers: not the page you're on, its cover, nor Safari's tab bar or address bar if they're showing.
- [ ] A slow site (youtube.com) unloaded: it comes up once it has drawn (2026-11-02; it waited for the load before), or about 1.5 s after it started loading, as far as it got.
- [ ] ⌘-click a link to a slow site, then click its row at once: the page you're on stays covered until it has loaded, then it comes up drawn.
- [ ] If a dark window still shows: Start page → Settings → Switch log (development) → Copy, and look at `restored` and `introduced` on those switches (`not loaded`: Safari didn't load it behind; after two of those Margin stops trying until Safari restarts). Safari's log (Console, process Safari) around them: `restoreFromSessionState`, `Not dispatching`, `hideContentUntilPendingUpdate`.

## A press on a tab switches (2026-10-29)

- [ ] Press (don't release yet) on another tab's row: it highlights and comes to the front while the button is still down; releasing does nothing more. The same for a pin whose tab is open.
- [ ] Click quickly through several tabs: each switches once, nothing flickers or switches back.
- [ ] Double-click a tab's row: one switch.
- [ ] ⌃-click or right-click a row: its menu, no switch. A click on a row's ×: it closes, no switch.
- [ ] Drag the tab in front to a space chip, into the pinned area, into a folder: it works. Pressing another tab and dragging: it comes to the front, nothing drags.
- [ ] Drag a pin that isn't open, and a folder: they move, nothing opens.
- [ ] With the sidebar open over the page (hover): a press switches and the sidebar stays open on the next page.

## Margin installed with `npm run safari` (2026-10-29)

- [ ] Safari → Settings → Extensions: one Margin; turn it on, allow it on every website.
- [ ] Quit and reopen Safari: Margin is still on, with your spaces and pins; no "Allow Unsigned Extensions" needed.
- [ ] Change something (or `git pull`), `npm run safari` again: Margin stays on, and pages show the new build as you switch to them.
- [ ] Run `npm run safari` again: right after it, Safari → Settings → Extensions still lists Margin, turned on (the script adds it again until the system lists it; it warns if it never does).

## Margin 2: Safari reliability (2026-11-05)

`npm run safari` from `fix/safari-reliability`, then `npm run log:app` (or `scripts/margin-log.sh 5`) in a terminal to watch Margin.app's log.

**Bindings through blips** (the overlay that disappeared from the third profile's window).
- [ ] Three profiles, each with one window in full screen on the same display (each in its own Space), Margin's sidebar over each. Swipe between their Spaces quickly, back and forth, for a minute, and use ⌃⌘ arrows (or Mission Control) between them too. Every window keeps its sidebar the whole time; none goes away and stays away.
- [ ] The log may show `…: window N missing from one read (kept for 3 s)` and `safari: a read of the window server without the browser's windows (…)` or `the window server gave no list (…)` during the swipes. It should never show `is no longer window N` for a window that's still open. Send me those lines with the times: they say what the window server did.
- [ ] Leave all three alone for 5 minutes, then come back to each: the sidebar is there over each one.
- [ ] Close one of the three windows (⌘W): its sidebar goes with it, and the log says `is no longer window N: closed in the browser`. Nothing is drawn over the desktop or another window.
- [ ] Quit Safari with the three windows open, then open it again: the sidebars come back as before. The log's drops say `its copy isn't linked` or `closed in the browser`, not 3 s later.
- [ ] Type in the palette (⌥K) while swiping to another Space and back: the keys still go to the palette or to Safari, and nothing is typed into an unseen field.

**An update never leaves a stale Margin.app** (the "Margin isn't connected" after an update).
- [ ] With Margin linked in every profile, run `npm run safari` again (with `npm run log:app -- --stream` open). The script prints `quit the running Margin.app (pid N)`. Within about 10 s the log shows that pid's goodbye (`link down (safari:…): stopped: Margin.app quit` for each profile), a new pid's `listening on 127.0.0.1:…`, and `hello: safari:…` for every profile, with no `SFErrorDomain` line.
- [ ] Right after that, open a window of a profile that had none: it gets its sidebar within a few seconds.
- [ ] `ps -ax | grep MacOS/Margin` shows one Margin.app (plus the grep), never two.
- [ ] Each link now shows as `wantLink: link handed to Safari (port P, #n)` and then `link #n reached the extension`. If you ever see `link #n not passed on: SFErrorDomain 1`, send me those lines with the time, and say whether you had just run `npm run safari`, quit Safari, or neither.
- [ ] Open a new tab while Margin.app is quitting after an update: it says "Margin.app isn't running" (with Start) or, briefly, "Margin.app isn't answering" (no Start), and becomes Margin's within about 10 s without a click.

## Margin 2 Phase 3: the extension slimmed, the first paint at any layout (2026-11-05)

What changed for you: no Margin sleep page any more (Safari's sleeping tabs are closed and kept, as since step 1), a page is in its box from its first frame at whatever layout the theme gives the window (no more one file per sidebar width), and the development log and its leftovers are gone. Nothing else should look or behave differently. Install over the build you have now (`npm run safari`: the Xcode project is made again, files were added and removed) and keep `npm run log:app -- --stream` open.

**The update from the build before.**
- [ ] After `npm run safari`, every open page keeps working: switch tabs and spaces, ⌃⌘↓/↑, ⌘T, peek, a pinch, a swipe back. No page shows a frame or box that doesn't match Margin's sidebar.
- [ ] The log shows `the open-tab repair, pass 0: N tabs, …` once (a line per pass, a few seconds apart at most).
- [ ] If any tab was still on Margin's old grey sleep page (from the build before Phase 2 step 1): the log says `tab … was on the sleep page of an earlier Margin: closed, kept as its Margin tab (asleep)` for those behind, and `… in front: loaded at its address` for one in front. They're in their spaces in the sidebar, faded (not open), and open on a click. If you have none, nothing to check.
- [ ] Safari › Settings › Extensions › Margin asks for nothing new. (The build adds the `webNavigation` permission; Safari shouldn't prompt for it. Tell me if it does, or if Margin was turned off by the update.)
- [ ] Quit Safari and open it again: pages restored at launch come up in their box (or move into it within a moment as Margin.app links), as before.

**The first paint.**
- [ ] With Keep open on, open new pages (⌘T and an address, a link with ⌘-click then switch to it, a reload): the page is beside the sidebar from its first frame, never drawn at the window's edge first and then moving. Try a heavy site (YouTube, a news site) and a light one.
- [ ] Drag the sidebar's edge to another width, let go, and open new pages right away and again after 3 seconds: both are at the new width from their first frame (the first ones get the window's layout as they commit, the later ones from the registration made again once the width has settled).
- [ ] Keep open off (the frame alone), then on again: new pages are right from their first frame each time. The same after switching the theme to Neo-brutalism and back.
- [ ] Two full-screen windows (two profiles, or one profile): new pages in each are right in their own window.
- [ ] Quit Margin.app (or let its link drop): within about 6 s new pages have no box at all from their first frame (the page as it is, no grey frame); `npm run log:app` shows the link dropping. Open Margin.app again (or click the new-tab page's Start button): new pages have their box again from their first frame. Do this twice in a row. If a new page ever shows a box or frame while Margin.app isn't running, or none while it is, tell me the time: WebKit keeps applying registrations it was told to drop, and this build never drops one (it's updated to no box instead), so that would be something new.
- [ ] Tell me if any page jumps at about a quarter of a second after it appears: that's Margin's content script moving a box the first paint got wrong.

**Sleeping tabs (Safari closes and keeps them).**
- [ ] Settings shows the hours and the never-sleep sites, and no "Wake all sleeping tabs" button any more (in Safari a sleeping tab is closed; each opens again as it's clicked, so there's nothing to wake).
- [ ] `margin.sleepNow(60000)` in the background's console (or a long wait): tabs unused for that long close and stay in the sidebar, faded; the log has one `sleep: N due, M put to sleep (tab … closed, kept, unused … min, its page judged by margin); skipped: …` line per pass. A tab with a draft, one playing sound and the one in front aren't put to sleep (`skipped: edited 1`, `playing 1`, `in front 1`).
- [ ] Open a sleeping Google search tab from the sidebar after changing Safari's search engine: Margin's search engine (Settings shows it) doesn't go back to the old one.

**Send me** the log lines of anything that didn't do as described, with the time.

## Margin 2 Phase 2 step 9: Safari's own profile names (2026-11-05)

`npm run safari` from the branch with step 9 (it changes Margin.app; the Xcode project is made again because a shell file was added and one removed). Margin.app has Full Disk Access already (System Settings › Device Control and Data Access › Full Disk Access). Two Safari profiles with Margin on in both, and a window of each opened once this session.

- [ ] The log says how each profile was linked: `scripts/margin-log.sh 5 | grep "safari profiles"` shows one line like `3 profiles: “Work” (DefaultProfile, person.fill) → s-default; “Personal” (A8C3B0E9-…, person.lanyardcard.fill) → s-8d454f81-…; “Test” (CDC954CA-…) → …`. The profile whose copy said `s-8d454f81-4100-489d-ba9f-e788bec2daeb` in the log before should be the one shown with it. A profile where Margin has never run says `no copy yet`. Send me the line if a profile you use says `no copy yet` or names the wrong copy.
- [ ] The sidebar's profile marks, the space menus ("Edit Profile “Work”…", "New Space in …") and the switch's words use Safari's names: your default profile shows as "Work", not "Default".
- [ ] The profile mark on another profile's chips shows Safari's symbol for it (a small white glyph in Arcadia, a black one in Neo-brutalism) instead of the initial. Tell me if it's too small to read; the initial is the fallback.
- [ ] Rename a profile in Safari › Settings › Profiles: within a couple of seconds the sidebar shows the new name, with no click or switch. Change its symbol there: the mark follows.
- [ ] Edit Profile on a Safari-named profile: the name field shows Safari's name, greyed and not editable, with a line saying to rename it in Safari; change the emoji and color and Save: they stick, the name stays Safari's.
- [ ] Set-up window (open Margin.app): the "Show Safari's profile names" step is ticked and says Margin has Full Disk Access.
- [ ] Turn Margin.app off in Full Disk Access: within about 10 s the names go back to the ones typed in Edit Profile ("Default" / "Profile N" if none); the set-up window's step shows it's not given, with the Open Full Disk Access button (it opens System Settings at that list). Turn it on again: the names come back within about 10 s. If they don't until Margin.app is quit and opened again, tell me (macOS may hold the old answer for a running app).
- [ ] Add a third profile in Safari and open a window of it (Margin on there): its spaces appear with its Safari name once its copy links.
- [ ] Delete a test profile in Safari (one with a space in Margin): the log says `profile “…” (…) is gone from the browser`; the profile keeps that name in Margin (now as a typed name you can change), and can be forgotten from its menu as before.
- [ ] Nothing slows Safari: browse and switch tabs for a minute; the log shows at most one `safari profiles` line per change of names, and Activity Monitor shows Margin.app near 0% CPU while you browse (it reads Safari's database at most once a second while Safari writes it, and logs only when the names change).

## Margin 2: the layout at once on window switches, a faster inspector (2026-11-05)

`npm run safari`. Two or more full-screen Safari windows (one profile or two).

- [ ] Switch between them (three-finger swipe, ⌃→/⌃←, Mission Control, ⌘\`): Margin's sidebar is already there as the window slides in, never appearing a moment after. Also after each window has been shown once since Margin.app started (the first showing of a window may still take a moment).
- [ ] Swipe to the desktop and back: nothing of Margin's on the desktop.
- [ ] `npm run log:app`: no line "overlays join every Space again for this launch". If there is one, macOS didn't keep an overlay with its window: tell me the time, and Margin has fallen back to the earlier behaviour for that launch.
- [ ] ⌘⌥I docked at the bottom, then left and right: Margin moves out of its way as it opens, and follows as you drag its edge, with no noticeable wait.

## Margin 2 Phase 2 step 8: what you saw in full-screen Safari, fixed (2026-11-05)

Build and install as usual (`npm run safari`), open Margin.app's log in Terminal first: `npm run log:app -- --stream` (or `scripts/margin-log.sh 10` afterwards for the last 10 minutes). Each check says what the log shows.

- [ ] **Switching: the highlight moves once.** Click rows, use ⌃⌘↓/↑ (single presses, then held), switch spaces. The highlight goes to the new tab and stays; it never goes back to the tab you left and forward again. Safari's own blink in the page area as it draws the tab is expected now (Margin no longer hides it). Each switch is one line: `switch to tab N (activateTab, window W): asked +0, tabs.update +a, updated +b, onActivated +c, stored +d, delta out +e ms`. If the highlight ever flickers, send me the lines from that moment: `N activations heard` means something else switched too; `no onActivated within 3000 ms` means Safari never said the tab came to the front; a big `stored` means Safari's storage was slow (the highlight now waits for it, up to 2 s).
- [ ] **The palette.** ⌘T several times, from a fresh Safari window too (no click in Margin before): the palette is drawn at once, the field has the caret, and what you type appears with no lag. The log has three lines a time: `the palette's key: sent to safari:…'s overlay`, `overlay page (…): palette opened (the app's key): drawn X ms after the word, Y ms of work, its field focused`, and `… took the keyboard Z ms after the palette's key`. If it freezes: is the last line missing (the keyboard never came), is `drawn` large, or are there `slow: …` lines (the overlay page busy, with what caused it)?
- [ ] **Never over the desktop.** Swipe (or ⌃→/←) from full-screen Safari to the desktop and back, slowly and quickly; open Mission Control; switch profiles (a new window goes full screen). Margin's overlay is never left on the desktop. The log: `the active Space changed (…)`, then `overlay put away (…): the active Space changed and its window isn't on screen`, and back: `overlay shown over … : its window is on screen after the Space changed`. A profile switch's new window: `its window doesn't fill its display (going into or out of full screen)` until it's in its Space. If you still see the overlay over the desktop while the slide plays, try the experiment and tell me: `defaults write io.tirth.margin MarginOverlayOwnSpace -bool YES`, quit and reopen Margin.app (the log says `overlays join only their window's Space`): the overlay then belongs to Safari's Space and should slide away with it. Check it still shows over Safari, in every full-screen window, and after switching profiles. `defaults delete io.tirth.margin MarginOverlayOwnSpace` undoes it.
- [ ] **The left edge.** With Margin's sidebar hidden, and again docked (Keep open): move the pointer to the left edge, slowly and quickly (a fast flick from the middle of the page). Safari's own sidebar never opens; Margin's peek still comes out (hidden) and the docked sidebar still works. The top edge isn't guarded (Safari's toolbar should still come down: next check).
- [ ] **Safari's toolbar over Margin.** Pointer to the top in full screen: Safari's toolbar slides down over the page and over Margin's sidebar (all of it, not half covered), and goes back up.
- [ ] **The Web Inspector docked.** ⌘⌥I on a page, docked at the bottom, then left, then right (its dock buttons): Margin is laid out beside it (sidebar and frame in the rest of the window), nothing of Margin's over the inspector, and the inspector takes clicks, scrolling and drags everywhere (its resize handle too). Resize it: Margin follows. Close it: back to normal. The log: `Safari takes part of its window (the Web Inspector docked?): Margin draws in … of …`. Left and right are told apart by where the pointer is in the page: move the pointer over the page once after docking it on the left if Margin sits on the wrong side.
- [ ] **Generally smoother.** With the sidebar docked, the app no longer hands the overlay the pointer's moves at all (none needed); hidden, only at the edge. `slow: following the windows took …` lines (over 8 ms) should be rare.

## Margin 2 Phase 2 step 7: notices, loading and gestures drawn by Margin.app (2026-11-05)

`npm run safari` from the branch with step 7 (it changes Margin.app's shell too, so the app needs the new build). A Safari window in full screen, linked. What pages used to say or draw now comes from the window's overlay, in the theme's own notice style. `npm run log:app` shows the copy's side (`notice …`, `tab … loaded again from the notice`). Write what you see in DECISIONS.md.

**Notices** (each one at most once per page; Not now, OK or a button never brings it back for that page):

- [ ] **Margin isn't responding on this page.** Type something into a field on a page (so Margin won't reload it by itself), leave it in front, and run `npm run safari` again (Safari reloads Margin while the page stays open). Within a few seconds of the new copy linking, the overlay says "Margin isn't responding on this page (it was probably updated). Reload the page to fix it." with Reload and Not now. Reload: the page loads again (your typing is gone: you chose it) and gets its box. Not now: the notice goes and doesn't come back for that page. Switch to another tab while it's up: it goes. *If it never shows:* paste `npm run log:app` (look for `still has Margin from before it was reloaded`).
- [ ] **Margin was updated while Safari was open.** Only when Safari keeps two copies of Margin running (after some updates; the log says `a newer copy of Margin is running`): a page in front bound to the older copy shows "Margin was updated while Safari was open. Quit and reopen Safari to finish updating it." with OK. If you can't make it happen, note that; the WebKit host can't run two copies with the link either.
- [ ] **A switch that didn't happen.** Close a tab from Safari's tab bar and, quickly, click its row before the sidebar drops it (or use a row of a tab another window just closed): "That tab is no longer open." for about 4 s. Hard to hit on purpose; note it if you see any of the three ("didn't answer", "couldn't show") during normal use, with what you did.
- [ ] **Safari's New Tab setting.** Set Safari Settings › General › "New tabs open with" to Homepage (or Favorites). Open a new tab with the tab bar's + twice (not ⌘T: the app holds it). After the second, its window shows "If a new tab opened this page instead of Margin's: in Safari Settings › General, set "New tabs open with" to Margin…" with OK and Don't show again. Don't show again: Settings' "Tell me when a new tab seems to open Safari's homepage…" toggle is off (it's in the app's Settings now). Set the setting back to Margin.
- [ ] Every notice in Arcadia and in Neo-brutalism (Settings › Theme): drawn in the theme's notice, its buttons clickable over the page, the page still taking clicks around it.

**Loading** (no hover needed: check with the sidebar hidden too):

- [ ] Click a link to a slow site (or ⌘R on a heavy page): Arcadia's pill in the frame's top strip shows at once, before the next page arrives, and goes when it has loaded; in Neo-brutalism the striped bar above the page marches and the reload button spins. With the sidebar hidden, the pill (or the bar) still shows.
- [ ] A tab loading behind (⌘-click a link): its row's icon pulses (Arcadia) or its icon box blinks (Neo-brutalism) until it has loaded.
- [ ] A "Leave page?" prompt (a page with unsaved changes, then ⌘R and Cancel): the indicator goes once you cancel.
- [ ] A single-page app navigating within itself (Gmail between folders, GitHub between tabs of a repository): the indicator shows while a slow one runs. Note sites where it shows for too long or never.

**Gestures** (Settings: Margin's trackpad gestures on):

- [ ] Pull down at the top of a page: a round badge (Arcadia; a square one in Neo-brutalism) comes down over the top of the page as you pull, turns the space's color (yellow in Neo-brutalism) once letting go would reload, and the page reloads when you let go. Pull a little and let go: the badge goes, no reload.
- [ ] Two-finger swipe sideways where nothing scrolls sideways: the arrow badge comes in from the left (back) or right (forward), and fills once letting go would go there. *Tell me how far it lags your fingers*: it goes page → Margin → app → overlay, about one round trip of the link.
- [ ] The badges never take a click or a scroll from the page.

**Pages' first read.** Nothing to check by hand: pages no longer read the theme's package (the WebKit host measured the read: DECISIONS.md).

## Margin 2 Phase 2 step 5: only Margin.app draws Margin (2026-11-05)

`npm run safari` from the branch with step 5. Pages never draw any of Margin's UI now, linked to Margin.app or not: what you see of Margin is the app's. The lists below for Phase 1 and step 1 that say "in-page development host" now check the app's UI (there's no in-page one to fall back to). Write what you see in DECISIONS.md.

Not linked (quit Margin.app with `killall -TERM Margin`; it starts again on demand, so check quickly, or before the next page loads):

- [ ] Pages fill the window, plain, with no box, no gray frame and no sidebar: Safari as if Margin weren't there. Develop › Show Web Inspector on a page: no `margin-app` or `margin-*-host` element, and nothing on `<html>` but, at most, `data-margin-docked="off"`.
- [ ] A page loaded now: no box or frame from its first frame. If it shows a box or the frame for a moment and then fills the window, note it: WebKit kept the first-paint registration Margin dropped (seen in the WebKit host for tabs made after it was registered, until a restart; DECISIONS.md, Phase 2 step 5).
- [ ] ⌘T (with Safari's New Tab moved to another shortcut, as the set-up window asks), and Safari's own New Tab: Margin's new-tab page, which says "Margin.app isn't running", with a "Start Margin.app" button and an address field (focused). Type an address and Return: it opens in that tab; type words: Safari's search engine (the one Settings names) searches them there.
- [ ] Press "Start Margin.app": "Starting Margin.app…", the app starts with no window and no Dock icon, and the page turns into the app's launcher (the page itself shows nothing of its own). Pages get their box back as they're shown.
- [ ] ⌃⌘↓/↑ and ⌃⌘→/← still switch tabs and spaces while not linked; ⌥S does nothing (it's typed into the page, as without Margin).
- [ ] Pinch on a page: Safari's own zoom (no box, so nothing to keep in it). Two-finger swipe and pull-to-refresh still work if they're on in Settings (with no badge: the app draws it, step 7, and it isn't linked).

Linked:

- [ ] Every page in its box, nothing of Margin's in the page (Web Inspector), the sidebar, palette, menus, notices and Settings all the app's.
- [ ] Moving between linked and not: quit the app, wait for pages to fill the window, open a page so it starts again: the box comes back on each page without a jump loop or a box stuck at the old place, also on a zoomed page (⌘+) and with Keep open on and off.
- [ ] Tell me anything you reach for that's gone (the list of what pages drew and the app doesn't yet: DECISIONS.md, Phase 2 step 5, "Gaps").

## Margin 2 Phase 2 step 6: which window is which (2026-11-05)

`npm run safari` from `feat/margin-app` with step 6 merged. Two Safari profiles with Margin on in both. After each check, `npm run log:app` (or `scripts/margin-log.sh 10 | grep -E "is window|no longer|isn't bound|kept"`) shows every binding and why; paste it in if anything is off.

- [ ] **The swap, again.** One full-screen window per profile (same display). Swipe between them ten times, slowly and quickly, and with ⌃→/⌃←. Each Space always shows its own profile's sidebar, spaces and tabs, never the other's, not even for a moment. *If wrong:* a flash of the other profile's sidebar; the log has a `(was …)` or `no longer` line at that time.
- [ ] **Two windows of one profile, same space.** Two full-screen windows of one profile showing the same Margin space: each sidebar marks its own window's tab in front (switch tabs in one; the other's highlight doesn't move). *If wrong:* the highlight follows the other window.
- [ ] **Same profile, different spaces.** Put the two windows on different Margin spaces: each shows its own space, also after swiping back and forth. *If wrong:* both show the space of whichever was focused last.
- [ ] **Different profiles.** Covered by the first check; also a profile's not-open tabs show only in its own windows.
- [ ] **Full screen and not.** One window full screen, one windowed on the desktop: the overlay only over the full-screen one; swiping to the desktop puts it away, back brings it.
- [ ] **New window.** In full screen, File › New Window (⌘N): the new window gets its own sidebar within about 2 s (the log: `focus moved` or `created together`); the old one keeps its own. Close it: the log says `closed in the browser`, nothing else changes.
- [ ] **Leaving and entering full screen.** ⌃⌘F out of full screen and back in on one of two full-screen windows: no `no longer` line in the log, and its sidebar comes back on its own window.
- [ ] **Profile switch (step 4).** Click another profile's space: the new window's sidebar shows as the slide ends (the log: `made by Margin's openSpaceWindow`), the old window's binding goes (`closed in the browser`). Both ways.
- [ ] **Mission Control.** With two full-screen windows, open Mission Control and close it (Esc), then open it and click the other Space: no overlay on the wrong window afterwards, and no `no longer` or `(was …)` line in the log.
- [ ] **Two displays.** A full-screen window on each display: each has its own sidebar at once (`the only free window with its bounds`).
- [ ] **Margin.app relaunched with windows open.** Two full-screen windows: `killall -TERM Margin`, then switch tabs to start it again. The front window's sidebar comes within about 6 s, or at the next swipe; the log says `isn't bound: 2 windows have its bounds` until then, then why it bound. *Tell me how long it took* and paste the lines: they show whether Safari's copies call only the key window focused, and whether a copy hears its window focused when it comes forward from another profile's.
- [ ] **Safari quitting** with both windows open, then reopening: the log shows each binding dropped (`gone from the window server` or `its copy isn't linked`), then made again; every window's sidebar is its own.

## Margin 2 Phase 2 step 4: spaces across Safari profiles (2026-11-05)

Needs two Safari profiles (Safari › Settings › Profiles; here "Default" and "Work"), Margin turned on in both, and step 3's checks done. Each switch to the other profile's space creates a full-screen window and closes one, with macOS's slide: tell Tirth before starting, and do one switch first and check it before doing more. Margin.app's log: `/usr/bin/log stream --predicate 'subsystem == "io.tirth.margin"'` (lines `profile switch: …` and `link down (…)`).

**First, the crux: does a profile's copy stay running with no window?** Safari 27.2's own code (read off screen, DECISIONS.md) says: at launch only the default profile's extensions load; a named profile's load when its first window opens, and stay loaded until Safari quits. Margin's port pings keep the background page alive.

- [ ] Open a Work window and a Default window, both full screen; both copies link (`linked: safari:s-…` twice in the log). Close the Work window (⌘⇧W). Wait 2 minutes. **Expected:** no `link down (safari:s-<Work>)`; Develop › Web Extension Background Content still lists Margin for Work. If it does go down: Margin's switch to Work works only while a Work window exists; every other time it asks the person to open one (that's the fallback built in), and a way to keep the copy alive is needed (tell Tirth: a choice).
- [ ] Quit Safari with only a Default window open, then open Safari again. **Expected (from Safari's code):** only the Default copy links (`linked: safari:s-default`), not Work's, until a Work window opens. Then the first switch to a Work space after each Safari launch shows "Work isn't open in Safari. Open one of its windows (File › New Window › New Work Window)…"; opening it (menu or Dock) shows that space there and closes the Default window. If Work's copy does link at launch without a window: the notice never shows; note it.

**The sidebar across profiles** (with both copies linked):

- [ ] Both profiles' spaces are in one row of chips, Default's first; Work's have a small badge with "P" (Profile 2, until named) and a divider before them. Hovering a chip's title says "Office · Profile 2". With one profile (Margin on in only one, or a Safari with no profiles): the chips look as before, no badges.
- [ ] Right-click a Work space: Switch to Space, Move Left/Right, Edit Profile "Profile 2"…, New Space in Profile 2. Edit Profile: name it "Work" with an emoji and a color: every window's badges follow, and `~/Library/Application Support/Margin/data/safari/browser.json` has the name (read it only if Tirth agrees).
- [ ] Move a Default space past a Work one and back: the order sticks after a Safari relaunch; a Default window alone (Margin.app quit) shows its spaces in the same relative order.
- [ ] "+" › New Space in Work: it appears among Work's spaces at once (no switch).
- [ ] Neo-brutalism: Work's chips have a dashed edge and a corner tag; the gap between profiles shows.

**The switch** (the full-screen Default window in front, a Work space not open anywhere):

- [ ] Click a Work space's chip. **Expected:** about 0.4–0.65 s: macOS slides to a new full-screen Space with a Work window showing that space's last used tab (the Work tabs that were open with it open behind a moment later); the sidebar is drawn on it with that space active; then the Default window closes. Mission Control shows one Safari Space. Note the time, any flash of the desktop, and whether the overlay was missing for long.
- [ ] Switch back (click a Default space, or ⌃⌘→/← across the boundary): a Default window comes back full screen with that space's tabs, the last used in front; Back is empty in them (expected); nothing lost from either profile's sidebar.
- [ ] The log says `profile switch: created window … (fullscreen)`. If it says `(normal)` then `asked for full screen`: Safari doesn't create full-screen windows directly; note how it looked (a window appearing, then sliding to full screen).
- [ ] ⌃⌘→/← and the two-finger swipe over the sidebar run through all spaces in the one order: within a profile as before (no window change), across with the switch.
- [ ] Switch, then switch again at once (two clicks quickly): it ends on the last one asked, with one window.
- [ ] While a switch slides, close the new window (⌘⇧W): the Default window stays (the log: `cancelled`).
- [ ] If macOS ever ends on the desktop after a switch, the log shows `not in front after the close: focused again`, and the Work window comes back within about a second.
- [ ] Quit Safari right after clicking a Work space: on reopening, Safari restores its windows (perhaps both, perhaps one); every space's tabs are still in the sidebar (open or not open). Note which windows came back.

## Margin 2 Phase 2 step 3a: the extension linked to Margin.app (2026-11-05)

`npm run safari` from `feat/margin-app` once step 3 is merged (the app's shell and the extension's end together). Margin.app needn't be open: the extension starts it.

- [ ] **Started on demand.** Quit Margin.app (or log in fresh), then open Safari: Margin.app starts by itself within a second or two, with no Dock icon flashing, no set-up window and no change of the app in front (Safari stays in front, its window doesn't dim). Activity Monitor shows one Margin, not two, also with two Safari profiles' windows open.
- [ ] Opening Margin.app yourself (Finder, Launchpad) still shows its set-up window.
- [ ] **Linked, full screen.** A Safari window in full screen: Margin's sidebar and frame are drawn around the page by the app, and nothing of Margin's is in the page (Develop › Show Web Inspector on a page: no `margin-sidebar-host` element). The page sits exactly in the theme's slot: no gap or overlap at the sidebar's edge, top, right or bottom; also with Safari's toolbar shown at the top of the screen (move the pointer up) and with Safari's own sidebar open.
- [ ] **The overlay and the page.** The app's overlay stays drawn above full-screen Safari (it never ends up behind the page). Over the page: clicks, scrolling, text selection, dragging text or an image and right-clicks all reach the page; over the sidebar they reach Margin. Near the slot's rounded corners too.
- [ ] Two Safari windows in full screen (two Spaces): switching Spaces with a three-finger swipe or ⌃→/⌃←, each window has its own sidebar with its own space, and no overlay shows on the wrong Space (a brief flash: note how long).
- [ ] **Your data moved into the app.** After the first link, `~/Library/Application Support/Margin/data/safari/` has one folder per Safari profile you've used, with `set.json` and `items/`. Your spaces, pins, folders and tabs are all still in the sidebar. Close every Safari window and quit Safari, then open it again: still all there.
- [ ] A new page in that window: how close its first paint gets to its place (expected: right with Arcadia, Keep open on, the default width; a jump at the content script otherwise: the new first-paint path is Phase 3's). Note what you see.
- [ ] **Keys.** ⌘T opens the palette in the app's overlay (typing goes there, Safari stays in front), not Safari's new tab and not a palette in the page. ⌃⌘↓/↑, ⌥⌘↓/↑, ⌃⌘→/←, ⌥S work. Change a shortcut in Settings (say the sidebar's to ⌥J): the new one works at once, the old one goes back to Safari. Choose an address in the palette: it opens; a tab: it comes to the front.
- [ ] ⌘T never makes a new tab while the app draws (if one ever appears, note it: the app's hot key lost to Safari's own).
- [ ] **Settings and the new-tab page.** The sidebar's Settings (and a new window's first tab): Margin's new-tab page comes up, its launcher and Settings drawn by the app in the page slot; typing in its field works, an address chosen opens in that tab.
- [ ] **The link dropping.** Quit Margin.app (its menu is hidden: `killall -TERM Margin` in Terminal): within a second the pages lose their box and fill the window, plain, with nothing of Margin's (the app said goodbye; since Phase 2 step 5 there's no in-page UI to come back). Force-quit it instead (`killall -KILL Margin`): the overlay is gone at once (its process is), pages keep their box for about 6 s, then fill the window. Open Safari again, or a page: the app starts again and takes over (see step 5's list below).
- [ ] **Asleep.** Leave Safari idle for 10 minutes with the app linked, then switch tabs: Margin still works at once (the extension's background stayed alive: its lasting port is used every 20 s).
- [ ] **Quitting by itself.** Quit Safari and leave the Mac for 10 minutes: Margin.app is no longer running (Activity Monitor). Opening Safari starts it again.
- [ ] Safari's console for the background (Develop › Web Extension Background Content › Margin): `[margin] link: linked on <port>`, and no errors.

## Margin 2 Phase 2 step 1: Margin's tabs (in-page development host) (2026-11-05)

Margin's sidebar is now the real list of tabs. A tab whose browser tab is gone stays in its space as a dimmed row ("not open"), and opens again when you click it. Run `npm run safari`. Have a space with a few tabs and a second space. To watch what happens, open the background's console (Develop → Web Extension Background Content → Margin). Write what you see in DECISIONS.md.

Closing:

- [ ] Close a tab with its × in the sidebar, with ⌘W, and with Safari's tab bar. Each time the row goes, and the tab is in the archive (Margin's start page, "Archive"). It's not left dimmed in the sidebar.
- [ ] Open a second window (⌘N) with a few tabs in a space, then close the window (the red button or ⌘⇧W). In the first window, show that space: its tabs are there, dimmed. Nothing new in the archive.
- [ ] A space's dimmed tabs show in every window that shows the space. In Neo-brutalism, the space's tab count includes them.

Opening:

- [ ] Click a dimmed tab. It opens in this window, in front, at its address, and its row isn't dimmed any more. In Safari's tab bar it sits among the space's tabs where its row is (not at the far end). It starts fresh: no Back history, the page scrolled to the top.
- [ ] In a second window, click a dimmed tab of the same space: it opens there, not in the first window.
- [ ] Search for a dimmed tab in the palette (⌘T, type part of its title): it's listed; Enter opens it.
- [ ] Right-click a dimmed tab: Pin Tab, Pin to a folder, New Folder with Tab, Move to another space, Close Tab all work. Close Tab sends it to the archive. Pinned, it becomes the pin (the pin opens it).
- [ ] Drag a dimmed tab up or down: it takes its new place. Drag it onto another space's icon: it moves there.
- [ ] In Neo-brutalism, Clear: the space's dimmed tabs go to the archive with the others.

Quitting and relaunching:

- [ ] Quit Safari (⌘Q) with windows set to come back, and open it again. Every tab is in its space, in its order, and no tab went to the archive. **Tell me** if any tab shows twice (once open, once dimmed) or went to the archive: that would mean Safari reports a quit as tabs closing one by one.
- [ ] Close a window, quit Safari, open it again: that window's tabs are still there, dimmed, in their spaces.
- [ ] If Safari doesn't bring a tab back (close it in the tab bar's overview while quitting, or quit with "Close windows when quitting" on): its row is dimmed in its space after the relaunch, not gone.
- [ ] History › Reopen Last Closed Window after closing a window: the reopened tabs are the dimmed rows coming back (no doubles), in their spaces.

Sleeping:

- [ ] Set Settings → "Put tabs to sleep after not using them for" to `0.02`, or run `margin.sleepNow(60000)` in the background's console. A tab you haven't used is closed: it's gone from Safari's tab bar, its row is dimmed, and in Activity Monitor its Web Content process is gone. It's not in the archive.
- [ ] Click it: it opens again and loads, as a closed tab reopened does.
- [ ] The tab in front, a tab playing sound, a tab with a typed draft and a site on "Never put these sites to sleep" are never closed.
- [ ] Set the hours back to 4.

Auto-archive:

- [ ] Set "Archive tabs not used for" to a small number of hours and wait (or leave a dimmed tab a day): dimmed tabs go to the archive by the same rule as open ones.

Before this build:

- [ ] Run `npm run safari` over the previous build: your spaces, tabs and pins are all still there. Tabs the previous build had lost after a relaunch (not shown before) can now appear dimmed in their spaces.

## Margin 2 Phase 1 (in-page development host) (2026-11-05)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


From `feat/ui-runtime`, run `npm run safari`. Margin now draws its sidebar, palette, menus and Settings with its new UI runtime and the Arcadia theme package. It should look like before. Switching tabs may blink: Margin 2 accepts Safari's own blink, and the switch cover is gone. Write what you see in DECISIONS.md.

The sidebar:

- [ ] Open a few pages. Each shows the gray frame around the page, as before. Nothing jumps when a page loads.
- [ ] Move the pointer to the left edge: the sidebar slides out over the page. Move back over the page: it goes after a moment.
- [ ] Press ⌥S: the sidebar comes out and stays. Press ⌥S again, or Escape, or click the page: it goes.
- [ ] Turn on Keep open (the button at the top of the sidebar): the sidebar docks and the page moves right beside it. Switch tabs: it stays docked on every page, with no jump.
- [ ] Drag the sidebar's right edge: the page follows as you drag. Reload a page: it keeps the new width from its first frame.
- [ ] Click tabs, pins and space icons: each switches at once. Close a tab with its ×.
- [ ] Clicks, scrolling and text selection on the page work everywhere inside the frame, also near its edges. The frame itself doesn't scroll the page.
- [ ] ⌘+ to zoom a page: the sidebar and frame keep their size, and the page stays inside the frame.

The palette:

- [ ] ⌘T (or "+ New Tab"): the dark command bar opens over the page. Type: rows filter; ↓/↑ move; Enter opens; Escape closes.
- [ ] A fresh ⌘T tab whose palette you close with Escape goes away again, back to the tab you were on.

Menus and drag:

- [ ] Right-click a tab, a pin, a folder and a space's name: each shows its menu, at the pointer, inside the window. The items work. Try it once with the page zoomed (⌘+).
- [ ] Drag a tab up or down in the list: a copy follows the pointer, a line shows where it lands, and Safari's tab order follows. Drag a tab onto a space's icon, into a folder, and into the pinned area. Try a drag with the page zoomed too.
- [ ] Double-click a folder's name: rename it in place; Enter saves, Escape cancels.
- [ ] "+" at the bottom: New Folder and New Space work; a new space opens in the space editor.

Settings (on Margin's start page: the palette's "Margin start page & settings", then Settings):

- [ ] Every setting is there: theme, archive hours, sleep hours, never-sleep sites, Wake all, the three gesture switches, the frame with the sidebar hidden, the ⌘T hint, and the five keyboard shortcuts with Reset. Keep-ready, the warm-up and the switch log are gone on purpose.
- [ ] Change each one: it sticks after a reload of the start page, and pages follow (for example, the frame setting).
- [ ] Click a shortcut field and press a combination: it's saved. Press one that's taken: a red note says which shortcut has it. Escape cancels.
- [ ] Wake all says how many tabs it woke.

Theme switch:

- [ ] In Settings, choose Neo-brutalism: the start page redraws in it. Pages you switch to or reload draw Neo-brutalism: a dotted colored ground, bordered cards, the page as a rounded card with a black border. The page must be fully visible inside the card. Expect a small jump when a page loads: first paint still uses Arcadia's frame until Phase 3.
- [ ] In Neo-brutalism: the sidebar, the palette, a right-click menu, a drag, and its Settings all work. Switch back to Arcadia from its Settings.

## Sleeping tabs (2026-11-04)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's sleep page is gone: Safari's sleeping tabs are closed and kept (Phase 2 step 1, Phase 3); see the Phase 3 section. Kept as history; don't run these checks.


Margin now puts a tab you haven't used for 4 hours to sleep, to give its memory back, as Arc does. Safari has no way for an extension to unload a tab, so a sleeping tab shows Margin's own sleep page: a grey loading card with the page's title and icon. As soon as you show it (Margin's sidebar, Safari's tab bar, ⌘1–9), it goes back to its page. Margin keeps it in the sidebar as the page it was. Settings has the hours (0 = never), a list of sites that never sleep, and "Wake all sleeping tabs".

Before you start: run `npm run safari`. Have Activity Monitor open (Memory tab, search "Safari Web Content" or the site's name). To see tabs sleep without waiting 4 hours, either set Settings → "Put tabs to sleep after not using them for" to `0.02` (about a minute; the check runs every 15 minutes), or open the background's console (Develop → Web Extension Background Content → Margin) and run `margin.sleepNow(60000)` to sleep tabs unused for a minute right away. Set it back to 4 afterwards.

- [ ] Leave a heavy tab (YouTube, a big Google Doc you haven't typed in) alone for a minute, then run `margin.sleepNow(60000)`. It shows Margin's sleep page if you look at it in Safari's tab bar, with its title and icon. In Activity Monitor its Web Content process is gone, or much smaller, within a few seconds. Note the before and after numbers.
- [ ] Its row in Margin's sidebar still has its title and icon. It's in the same space, and still under its pin if it was pinned. Search and the palette find it.
- [ ] Click it in Margin's sidebar. The page you're on stays (covered) until it has loaded, then it comes up drawn, with no dark frame. In the switch log its switch has `asleep: 'address'` and `restored: 'painted'` or `'loaded'`.
- [ ] Put it to sleep again, then bring it up with Safari's own tab bar (or ⌘1–9). The grey card shows for a moment, then the page loads, as any tab loading in Safari does. Note any dark frame and how long.
- [ ] Run `margin.sleepNow(60000)` and, while it runs (the console says when it's done), click through a few old tabs with Safari's tab bar. None of the tabs you looked at goes to sleep (`used` in the `run` entry).
- [ ] After either wake, press Back. It must not send you forward again to the page you came from. It goes where the tab went before it slept, or nowhere if Safari dropped the tab's history. If Safari kept it, Back may stop on the grey card with an "Open the page" button: that's expected (Margin can't always tell Back from Forward there), and pressing Back again goes on. Then press Forward until you're back on the woken page: it must get there, the grey card on the way at most, never sent back. **Tell me which**: does Back still reach the pages the tab had before it slept? Does Back ever show the grey card, or the same page twice? Try it once on a tab with a long history (Gmail used all day).
  - After an update or a relaunch (a new copy of Margin), Back from a tab woken earlier can land once on Safari's error page for the old copy's sleep page address. That's known and can't be fixed (nothing can change a tab's history). Note it if it happens more than once in a row.
- [ ] Type something into a text field on a page (a draft, a search box) and don't send it. Leave the tab and run `margin.sleepNow(60000)`. That tab doesn't sleep (`skipped: { edited: 1 }` in the switch log's `run` entry), and the draft is still there when you come back. Do it in a React app too (a Gmail or Outlook reply, a Slack or Discord message box, a GitHub comment): the same.
- [ ] Type a comment into another site's box embedded in a page (a Disqus comment on a blog, a Typeform, a YouTube embed's search) and don't send it. The tab doesn't sleep, and the comment is still there.
- [ ] Type a draft, then run `npm run safari` (an update) without sending it. Leave the tab and run `margin.sleepNow(60000)`: it doesn't sleep (its `slept` entries, for other tabs, may say `judged: 'margin-late'`).
- [ ] With a draft kept awake, let two passes go by (30 minutes) without touching the tab: the second `run` entry says `asked lately` for it, not `edited`. Show it once, leave it, and the next pass asks it again.
- [ ] A tab playing music or a video, and the tab in front of each window: they never sleep.
- [ ] Add a site to "Never put these sites to sleep" (for example `youtube.com`). Its tabs stop sleeping, its subdomains too (`m.youtube.com`), but not a site that only ends the same (`notyoutube.com`).
- [ ] Quit Safari with a tab asleep, and open it again. The tab is still asleep, on the sleep page (Margin moves it to its new address in the first seconds), in its space. Showing it wakes it. Before Margin moves it, Safari's tab bar may show an error page for it for a moment: note it if you see one.
- [ ] `npm run safari` again (an update) with a tab asleep: the same.
- [ ] "Wake all sleeping tabs" in Settings: every sleeping tab loads its page again behind the one you're on. Setting the hours to 0 alone wakes nothing.
- [ ] A site that asks "Leave page?" when you close it: if it ever asks while its tab is going to sleep, tell me the site.
- [ ] Copy the switch log. The `kind: 'sleep'` entries: `run` (with `due`, `slept` and `skipped`, why each tab was left awake: `used` is a tab you used while the pass went on, `asked lately` one that said no within the hour, `frame unknown` a frame Margin couldn't read: send me the site for those), `slept` (`idleMin`, and `judged: 'margin'` when Margin's own watch saw the page, `'margin-late'` when that watch started after the page loaded), `woke` (`by: 'switch'`, `'shown'` or `'all'`).
- [ ] Chrome: a tab unused for the setting's hours is discarded (`chrome://discards` shows it), and comes back as it's clicked.

**Send me** the Activity Monitor numbers, what Back did, the switch log, and the times of any dark frame or error page.

## A show only into a free page, and ⌃⌘↓ on every site (2026-11-04)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


Margin now shows a tab only once its page answers one more look just before the show, so a stalled page (Instagram on 2026-11-04) keeps the page before on screen instead of going dark. A press during that wait gives the show up and goes on from that tab. After a flip, a page that says it has drawn is shown about 0.6 s sooner. A tab's proof is kept in its page, so after an update the tabs Safari had already shown aren't flipped again. That starts from the next update, since this build starts cold. On web pages, ⌃⌘↓/↑ are taken by Margin before the page, so Outlook and Instagram no longer eat them. A cut-off tab in front is no longer reloaded in front: it's reloaded once you leave it.

Before you start: run `npm run safari`. Use Dark Mode, and record the screen if you can.

- [ ] On Instagram (reels) and on Outlook's message list, click into the page and press ⌃⌘↓ five times, a second or two apart. Five switches, and the reel or the selected message doesn't move.
- [ ] Do the same from a text field (Gmail's search, a compose box): ⌃⌘↓ switches tabs.
- [ ] ⌥⌘↓ still switches. If you set your own shortcut in Settings, it still works, and one you set to ⌃⌘↓ does what you chose.
- [ ] On Safari's Start Page and in the address bar, ⌃⌘↓ still switches (Safari's command).
- [ ] With a heavy tab in the cycle (Instagram with reels playing, a big Google Doc), press ⌃⌘↓ to it once. The page before stays, with its cover if it's slow, until the tab comes up with no dark frame. Then press ⌃⌘↓ twice quickly through it. The second press goes on to the next tab, and the heavy one isn't shown in between.
- [ ] Hold ⌃⌘↓: the key repeats through tabs on web pages now, as ⌥⌘↓ did.
- [ ] Leave Safari alone for two minutes (its background stops), then click into a page and press ⌥⌘↓ twice quickly. Both presses count.
- [ ] Right after `npm run safari`, with tabs open: switch through Margin to the tab in front and to the 2 tabs you used last. None is reloaded while it's in front. The background's console may say `still has Margin from before it was reloaded, and is in front`. After you leave one, it's reloaded behind; come back and it's there, with no dark frame.
  - Those tabs show the page with no sidebar while you're on them (the old copy's sidebar is put away); that's expected until you leave and come back.
  - On one of them that is Outlook or Instagram, press ⌃⌘↓: it still switches (Safari's own command now gets the key past the page). ⌥⌘↓ goes to the page there; that's expected.
  - In the switch log those switches say `cutOff: 'quiet'`, not `'reloaded'`.
- [ ] After that first round, run `npm run safari` again and switch through Margin to tabs you visited after the first install. In the switch log they show `markReason: 'proven:page'` and `introduced: false`: no flip first.
- [ ] Copy the switch log (start page → Settings → Switch log). For each `kind: 'switch'`:
  - `gate.outcome` is `free` on almost every switch. `answered` is a page that answered three looks slowly (shown then). `limit` is a page that never answered (shown as it is). `slow safari` is Safari slow, not the page (`gate.safari` is its answer). A `hurried: true` entry is a show given up for your next press, and the press after it goes to the tab after that one. `gate.stalled: true` is a tab that answered a wake moments before and then didn't.
  - `gate.pings`: their `ms` show how long the page took. Send me any over 500 ms with the time.
  - On an introduced switch, `layersBack: 'drew'` with `drewVisible` set means the page's own word ended the wait; `barrier` or `timeout` means it didn't say.
  - `showMs` is Safari's answer to the show. Over 250 ms means WebKit waited for the page.

**Send me** the switch log, the recording, and the times of any dark frame or lost press.

## No dark frame on Margin's switches (2026-11-03)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


Margin now introduces (an invisible flip to the tab and back) any tab it has no proof Safari has already shown with its page running, before it first shows it. It also never shows a tab before that tab's page has drawn again after a wake, a flip or a kick. The cost is about 0.3–0.4 s on the first Margin return to each such tab, under the cover. Switches made with Safari's own tab bar or keys can't be prepared and can still blink.

Before you start: run `npm run safari`. Use Dark Mode (the blink is the dark gray of Safari's empty view), and if you can, record the screen while you switch.

- [ ] Quit and reopen Safari. In Safari's own tab bar, click 3 tabs that come back unloaded, about a second each, then go back to the first tab. Wait a minute. Then switch to each of the 3 with Margin's sidebar, and again with ⌃⌘↓/↑. No dark frame on any of them, first return included.
- [ ] Do the same with tabs the warm-up loaded (the note said "Tabs ready"), switching to them with Margin's sidebar and with ⌃⌘↓ pressed once at a time. No dark frame.
- [ ] Hold ⌃⌘↓ so the key runs through several tabs. The highlight moves through them. Tabs Margin hasn't seen yet may be skipped as the key passes (the highlight moves on without the page changing), and the tab the key stops on comes up with no dark frame.
- [ ] Switch back and forth between two tabs you've already visited this session through Margin: they come up as fast as before, with no extra flicker or wait.
- [ ] Leave a tab alone for 2 minutes or more (Safari suspends it), then click it in the sidebar. The page you're on stays (covered) until the tab is ready, then the tab appears with no dark frame. Note it if it takes more than about 2 s.
- [ ] Right after a reboot, the same clicks: every click still switches, and none waits more than about 6 s.
- [ ] Right after `npm run safari` (a new build: Margin knows no tab yet), with Safari still open, switch through Margin to 4 tabs you had already visited before the rebuild, recording the screen. Each is flipped once first (an invisible flip to it and back). Watch for the tab you switch to appearing for a frame, then the page before coming back, then the tab: that's a flicker. Note its time if you see one. (Every flip seen so far was of a tab WebKit hadn't seen yet; these are tabs it has.)
- [ ] Press ⌘R in a tab you opened fresh (one page in its history), go to another tab, then come back through Margin. It comes up at once, with no extra wait.
- [ ] Leave a tab for 2 minutes or more right after Safari reopens (one Safari brought back, or one the warm-up loaded), then press ⌃⌘↓ once to reach it. It comes up within about half a second, with no dark frame. In the switch log, its `markReason` ends in `:kicked`.
- [ ] Copy the switch log (start page → Settings → Switch log). For each `kind: 'switch'`:
  - `introduced` is `true` on a tab's first Margin return after a relaunch or an update, and `false` with `markReason: 'proven:…'` after that. A `markReason` ending in `:kicked` means the kick that woke it was its introduction.
  - `layersBack` is `barrier` or `skipped:running` on almost every switch. A `timeout`, `skipped:capped`, `skipped:forced` or `skipped:plain-…` is a switch that may have blinked. Send me those.
  - A `markReason` ending in `:skipped:…` is a tab that needed an introduction and didn't get one. Send me those too.

**Send me** the switch log, the recording, and the times of any dark frame you see.

## After a relaunch: your likely tabs get ready on their own (2026-11-03)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


After Safari restarts, Margin now loads up to 6 of the tabs you're likely to click next, one at a time, behind the page you're on. It waits until Safari has settled and you're not typing, clicking or scrolling. Those are the tab you used last before the one in front, the tab each other space would show, tabs open on a pin, then other tabs you used recently. The sidebar shows a small note while it does this ("Getting your tabs ready", 3 of 6), then "Tabs ready". Nothing covers the page and nothing waits for it. Anything you do comes first.

Before you start: run `npm run safari`. Then quit Safari with several windows, spaces and pinned tabs open, and open it again.

- [ ] Wait about 5 s without touching anything. With the sidebar kept open (or out over the page), the note appears above the bottom bar, counts up, says "Tabs ready", and fades. Nothing on the page flickers, goes dark or moves, and Safari's tab bar and address bar don't change while it runs.
- [ ] Then click those tabs: the tab you used last, another space's icon, a pinned tab. Each comes up at once, already drawn, with no spinner. A tab further down the list that wasn't warmed still loads behind the page as before.
- [ ] Relaunch again, and this time start typing in a page (a search box) or in Safari's address bar (⌘L) right away, and keep going for a while. Nothing is loaded while you type. Your typing isn't interrupted, the address bar keeps what you typed, and the note doesn't appear or doesn't move on. If it was up, it goes within about 15 s while you keep working, and comes back when the next tab starts.
- [ ] Relaunch with a page in front that types inside a frame (Google Docs, an embedded editor or a card field) and type there, pausing a few seconds now and then: nothing is loaded while focus is in it. With Japanese or Chinese input, a word being composed is never cut off.
- [ ] Relaunch again and click a tab in the sidebar as soon as it shows, while the note is up. The click switches as fast as usual. The warm-up waits and goes on afterwards.
- [ ] Relaunch with a video playing in the tab in front, with the Safari window minimized, or with another app in front. Nothing is loaded until you're back on the page with nothing playing. A Safari window in full screen is warmed like any other window (a video in full screen still waits).
- [ ] Click the note's ×: it fades and nothing more is loaded. Try it again after a relaunch where you leave Safari alone for a minute first (Margin's background stops), then click ×: it still stops.
- [ ] With two windows open at the relaunch, work in the other window: nothing is loaded there, and no note stays stuck in either window.
- [ ] If a site you allow to auto-play (YouTube, a radio site) is among the tabs warmed: no sound starts from a tab you didn't open. Tell me if it does.
- [ ] Settings (start page) → "After Safari restarts, quietly load this many of the tabs…": set 0, relaunch: no note, nothing loaded. Set it back to 6.
- [ ] Update Margin (`npm run safari` again) without quitting Safari: no note, nothing loaded (it's not a relaunch).
- [ ] After the relaunch checks, Activity Monitor: Safari's memory is a few hundred MB higher at most, and settles.
- [ ] Copy the switch log (start page → Settings → Switch log). Look for `kind: 'warmUp'`:
  - `step: 'plan'` lists the tabs picked and why (`recent`, `space`, `pinned`), and `evidence` (`noPage` should be most of your tabs).
  - Each `step: 'tab'` has `outcome` `painted` or `loaded` (`left` or `hurried`: you did something while it loaded; `skipped: shown`: you opened it yourself first). `waitedMs` is how long it waited before that tab.
  - `step: 'end'` has `why` (`done`, `stopped by you`, `out of time`…) and `waits`: what it waited for (`slow`, `typing`, `input`, `not focused`…).
  - If it never ran: a `step: 'not relaunch'` entry, and whether its `evidence` says `update: true`. Send me that.
  - Right after the warm-up, the next `kind: 'switch'` entries shouldn't say Safari was slow unless it really was (the warm-up no longer counts its own late timers).
- [ ] Safari's log for the minute after the relaunch, if anything looked wrong: the flips' tabs should show `restoreFromSessionState` with no `hideContentUntilPendingUpdate` on the page in front.

**Send me** the switch log, and anything that flickered, went dark, or lost what you typed.

## After a reboot: every click switches, within about 2 seconds (2026-11-03, evening)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


Right after a reboot Safari is slow to answer Margin, sometimes 2–3 s for each question, and Margin's own timers run late. Margin now notices this. A switch starts from what Margin already knows about the tab instead of first asking Safari where it is. While Safari is slow, the tab comes up about 1.5–2 s after the click, still loading if it has to, as Safari itself would show it, instead of after 5–7 s. The page you clicked on also waits 3 s longer for Margin's answer, so a slow answer is never taken as "didn't switch".

Before you start: run `npm run safari`. The real test is right after a reboot (restart the Mac, open Safari with your usual windows, and start clicking as soon as the sidebar shows). Do the quick-Safari checks afterwards, once the Mac has settled.

- [ ] Right after the reboot, click 10 tabs you haven't opened since, one after another in the sidebar. Every click switches. "Margin didn't answer, so the tab didn't switch" never appears, and neither does "Margin isn't responding".
- [ ] Each of those tabs comes up within about 2 s of the click. Some come up still loading: an empty or half-drawn page that fills in, as Safari shows it. Note any that take longer than 3 s, and any that show black for more than a moment once they're up.
- [ ] No tab jumps back in front of one you clicked later.
- [ ] A space's icon right after the reboot: the same.
- [ ] From Margin's own new-tab page (⌘T, then a tab in its sidebar) right after the reboot: the same.
- [ ] Right after Safari opens, before the sidebar has redrawn, click a tab: it switches within about 2 s.
- [ ] Copy the switch log (new-tab page → Settings → Switch log). On those switches:
  - `before.resolve` should be under about 200 ms (it was 2.3–3.3 s).
  - `slow` says what showed Safari slow: `what` and `ms` of the last sign, `own: true` if it was the switch's own call to Safari, and `sources` (two or more: Safari as a whole). Most switches in the first minutes should have it.
  - `plain: 'tab'` means Safari was too slow to say where the tab was, so it was shown at once. `plain: 'late'` means the click reached Margin with less than a second left before the sidebar's deadline, and it was still shown.
  - `restored: 'cut'` means a restore behind the page ran out of its 1.1 s and the tab was shown as far as it had got.
  - `stuckAt` with `forced: true` should be rare now. Note its `shownAfter`: it should be about 2000, not 5000–7000.
- [ ] Once the Mac has settled (a few minutes later, load average under about 10), no new switch has `slow` (one tab that's slow to answer shouldn't give it to switches to other tabs). Unloaded tabs are restored behind the page again: they come up drawn, with `restored: 'painted'` or `'loaded'`, and `introduced: true` for tabs never shown.
- [ ] With Safari quick, switches feel as before: the page you're on stays until the tab is ready, with no black and no flicker.
- [ ] Optional: `uptime` in Terminal when you start clicking after the reboot, so I can match the log to the load.

**Send me** the switch log, the times of anything slow or dark, and the load average.

## Startup: clicks that start, restores that wait for the load, one introduction (2026-11-03)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


After a Safari relaunch, Margin's check of the open tabs no longer asks every unloaded tab again and again, and it waits while you switch. A tab loaded behind the page comes up only once it has really loaded. A tab that has already come back into view after you left it, whether Safari or Margin brought it, isn't flipped again on its next switch. A tab that only came back into view because its window was uncovered still is.

Before you start: run `npm run safari`. Do this right after a reboot or a Safari relaunch with many tabs, when the Mac is busy, as on 2026-11-03.

- [ ] Quit Safari with many windows and tabs, open it again, and start clicking tabs in the sidebar as soon as it shows. Every click starts a switch: none comes back as nothing, with the row snapping back. Then copy the switch log (new-tab page → Settings → Switch log): no `activateTab` entry has `error: 'expired'`. Each switch has `before`: `left` (ms of the 7 s left as the click reached the background), `waited`, `sync` and `resolve` say what it waited for before it started. If one did expire, note those numbers.
- [ ] In the same log, the `repair` entries: the first pass (`pass: 0`) asks about as many tabs as are open, most with `noPage`; the later passes ask only a few (tabs that loaded since), and `gaveWayMs` is more than 0 if you were clicking.
- [ ] Unloaded tabs you click right after the relaunch come up drawn, with no empty view, even when they take a while. In the switch log, `restoreStart` says how the load was first seen (`loading`, `ran` or `waiting`). One with `waiting` should show `restored: 'loaded'` or `'painted'`, and you shouldn't have seen an empty view on it. If a click on an unloaded tab sits behind the spinner for about 2.5 s and the tab then still comes up empty, note the time.
- [ ] A tab you had left, brought back with Safari's own tab bar (or ⌘1–9), then left again: switching back to it with the sidebar doesn't flip it first. Look for `introduced: true` on that switch in the log: it shouldn't be there. (A tab whose page loaded in front, and was never left and brought back since, is still flipped once on its first return: WebKit hasn't marked it.)
- [ ] The tab in front at the relaunch still gets its sidebar if it loads slowly (it's checked again once loaded).
- [ ] Safari's log the same day, for the minutes after the relaunch: far fewer failing scripts than the ~450 of 2026-11-03 (two per unloaded tab per pass).
- [ ] After a relaunch, switch to another app whose window covers Safari's (or minimize the Safari window), come back, then leave the tab in front with the sidebar and switch back to it. It's flipped first (`introduced: true`, `unseen: true` in the log), and you see no empty view. Uncovering the window doesn't count as the tab coming back.
- [ ] Right after a relaunch, with the Mac busy, click a few unloaded tabs that Safari loads in front instead of behind. Each comes up within about a second, not after 2.5 s behind the spinner. In the log they say `restored: 'not loaded'`, and after two in a row Margin stops trying to restore tabs behind for that Safari session.
- [ ] Close a tab and at once click its row in another window's sidebar, before the sidebar redraws. The row snaps back, and the log has no switch entry with `No tab with id` for it.

## The kick is back, for speed (2026-11-03)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


A switch to a tab Safari has put to sleep is quicker now. If the tab hasn't answered within about 60 ms (40 ms for one you left 8 s or more ago), Margin brings it to the front and the page you're on straight back, out of sight, so Safari wakes it at full speed. The page you're on stays in front until the tab is awake and drawn, as before. A tab kicked awake waits less for its page to draw before it comes up (0.15 s at most); a tab that woke slowly in the background before you clicked still gets up to 0.4 s, as this morning.

Before you start: run `npm run safari`, and have Terminal ready. Safari's log keeps these lines only for a few hours, so save it the same day.

- [ ] Click heavy tabs you left a few minutes ago (mail, chat, a long document), through the sidebar and with a space's icon. Each comes up with no black, and quicker than this morning (it was about 0.8 s typical, 1.7 s on the slow ones).
- [ ] As you click, the page you're on never flickers, goes blank or shows another tab for an instant. If it does even once, note the time: Margin turns the kick off for the rest of the Safari session when the page notices (the background console says "no more introductions until Safari restarts").
- [ ] Safari never freezes for an instant as you click one of those tabs (scrolling or the sidebar stops answering for a moment). If it does, note the time.
- [ ] Holding ⌃⌘↓ across tabs you left minutes ago: no flicker of the tabs passed. The tab you stop on comes up as a click does.
- [ ] ⌃⌘ and an arrow to a space whose tab you left minutes ago: if it takes a moment, the page you're on is covered within about 0.15 s, as before, never later.
- [ ] Click a heavy tab, then click its row again before it comes up: it comes up once, with no second flicker or freeze.
- [ ] Click a heavy tab, then quickly another one: the second comes up as quickly as if you'd clicked it first.
- [ ] Sites you come back to (a chat, a mail tab) behave as before: no messages marked read and no sound starting just because Margin flipped to them.
- [ ] Tabs you left less than a minute ago (kept ready) come up as fast as before, with no flicker.
- [ ] Right after quitting and reopening Safari, clicking tabs that haven't loaded yet works as before.
- [ ] Chrome: switching behaves as before.

**Send me**

- [ ] The switch log (start page → Settings → Switch log → Copy) after 20–30 minutes of use. On switches with `kicked`: `outcome` should mostly be `resumed`; `awake` means the tab was running after all and the kick wasn't needed (how often that happens says whether 40 ms is too soon). `kickMs` is how long Safari took for the flip: about 110 is normal, and near 250 means Safari held its window for that tab to draw (that's the freeze to watch for). `wakeMs` in `kicked` is how long the tab took to answer after the flip (0: during it). `barrier` entries should run at most about 150–270 ms on kicked switches, and up to 400–520 ms as before on switches with `wakeStartedBy: "hover"` or `"press"` that answered before the click. On kicked switches, `preparation.timings.known` 0 with `readMs` above 0 means the page had to read storage after the flip.
- [ ] Safari's log for the same half hour, saved right after: `/usr/bin/log show --last 35m --info --debug --predicate 'process == "Safari" AND (eventMessage CONTAINS "Selecting tab" OR eventMessage CONTAINS "dispatchActivityStateChange" OR eventMessage CONTAINS "hideContentUntilPendingUpdate" OR eventMessage CONTAINS "Unhiding layer tree" OR eventMessage CONTAINS "ProcessDidResume" OR eventMessage CONTAINS "viewIsBecomingVisible" OR eventMessage CONTAINS "updateActivityState")' > ~/Desktop/safari-kick.log`. It shows whether the page you were on ever left the window during a kick.
- [ ] The times of anything that looked wrong: a flicker, black, a freeze, a slow switch.

## "Margin isn't responding" fix: check this first (2026-11-03)

This build fixes the notice that came up on nearly every switch this morning, and the blanks after it. Run `npm run safari`. Then do the 20-minute check below, with these added. The worst case is right after a reboot or a Safari relaunch, when every tab is unloaded, so do the first part then.

- [ ] Right after quitting and reopening Safari (Margin turned on again if Safari asks), switch through Margin's sidebar to 10 tabs you haven't opened since. Each one either comes up within about 6 seconds, or Margin says "Margin couldn't show that tab. Try again." "Margin isn't responding on this page" should never appear.
- [ ] None of those switches leaves the page covered or blank for 7 seconds, then nothing.
- [ ] A space's icon right after the relaunch: the same.
- [ ] To see the real notice: run `npm run safari` again while a page is open, and click a row in that page's sidebar without switching tabs first. The notice can still appear there, since that page's copy of Margin really is gone. If Margin has already put the new copy in, there's no notice, which is fine.
- [ ] Right after the relaunch, click a tab that's slow to come up, then at once another one. The second one stays in front: the first doesn't jump back in front of it a few seconds later.
- [ ] Open an address from the palette for a slow site: it comes to the front without a dark flash, as before this round.
- [ ] In the Switch log, look for entries with `stuckAt`. `forced: true` means Margin showed the tab as it was because time ran out. `unconfirmed: true` means Safari hadn't answered the show yet when Margin answered the page. Send me those with the rest of the log.

## This round: the 20-minute check (2026-11-03)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


Start here. Run `npm run safari`, then use Safari as you normally do for about 20 minutes, on battery, with your usual tabs and spaces. Don't judge the first 5 minutes after quitting and reopening Safari.

**The setting.** On Margin's new-tab page, Settings: "Keep the tab you just left ready to show…". It now means: the tab you just left, and the one before it, are kept from going to sleep for that many minutes, at low priority (the slow cores), so switching back to them shows no black. Nothing else is kept. The 0 you set earlier was for the old setting (six tabs, at full speed, for 30 minutes after you last used Safari); this build doesn't read it. Settings should show 1. If it shows 0, set it to 1.

**What you should see**

- [ ] Switch to another tab and back within a minute, through Margin's sidebar, Safari's tab bar or ⌃Tab: no black, every time.
- [ ] A → B → C, then back to B or A within a minute: no black.
- [ ] ⌘F on a page, type a search for 10 seconds, Esc, then back to the tab you left: no black.
- [ ] ⌘Tab to another app for about 5 seconds, come back, and go back to the tab you left: no black.
- [ ] A tab you left several minutes ago, through Margin's sidebar or a space's icon: the page you're on stays (covered, a spinner after a moment) until the tab is ready, then it comes up with no black. Note roughly how long it takes on heavy tabs.

**What you shouldn't see**

- [ ] A black screen for half a second or more on a switch through Margin.
- [ ] Another tab flashing up for an instant during a switch.
- [ ] A page going black for about 2 seconds and reloading by itself. If it does, note the time.
- A tab left long ago, chosen through Safari's own tab bar, can still flash dark: Margin can't wake it before Safari shows it. Note how often.

**Activity Monitor** (CPU tab, View → All Processes, search "Safari Web Content")

- [ ] Read one page for a minute without touching anything: the hidden tabs' processes sit near 0%. Right after a switch, the tab you left may show a few % for up to a minute, then drops. None of them should sit at 15–25% for minutes, as six of them did before.
- [ ] The total for "Safari Web Content" while reading, compared with the 60–70% you had before.
- [ ] The battery drop over the 20 minutes (it was 45% to 6% in an hour before).
- [ ] Optional, in Terminal, within a minute of a switch: `ps -axo pid,pri,%cpu,command | grep '[W]ebContent' | sort -k3 -nr | head`. Hidden tabs with CPU should show a `pri` of 4 (low priority), not 31 or 47.

**Then send me**

- [ ] The switch log: on Margin's start page, the "Switch log" button, copy all of it, and paste it to me.
- [ ] The times of any black flash you saw, and whether it was through Margin, Safari's tab bar or a shortcut.

## Keep-ready: the tab just left, for a minute (2026-11-03)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


Keep-ready now keeps only the tab you just left (and the one before it) ready, for a minute, and lets go of them when you leave Safari. It used to keep up to six tabs running all the time. Settings on Margin's new-tab page: "Keep the tab you just left ready to show…". Your 0 for the old setting doesn't carry over: the new one starts at 1.

- [ ] Settings shows 1, though you had set the old one to 0. The field takes 0 to 10.
- [ ] A → B → C quickly (a click every quarter second or so), then straight back to B: no flash.
- [ ] Switch from a heavy tab (mail, chat, a long document) to another, then back within a minute: no black flash. Same through Safari's own tab bar, and with ⌃⌘→/← to another space and back.
- [ ] A → B → C, then back to A within a minute: no flash. A tab you left more than a minute ago may flash as with keep-ready off. Note how often that bothers you.
- [ ] Use Safari normally for 30 minutes, on battery. Activity Monitor → Energy, and CPU with View → All Processes: the `Safari Web Content` processes of tabs you aren't looking at sit near 0% once you've stopped switching for a minute. Compare the battery drop with yesterday's hour (45% to 6%).
- [ ] Switch to another app (⌘Tab) for a few seconds, come back, and switch to the tab you left just before: note whether it flashes. Then stay away 10 seconds or more: the hidden tabs' CPU should drop to near 0 in Activity Monitor while you're away.
- [ ] Whether Margin hears that Safari was left: switch tabs, then ⌘Tab to another app. In Activity Monitor, the tab you just left should drop to near 0% within about 5 s (if Safari tells extensions it was left) or about 15 s (if only the page says so), not after a minute.
- [ ] Click into Safari's address bar for more than 15 seconds, press Esc, then go back to the tab you left: note whether it flashes (expected now and then). Under 15 seconds: no flash.
- [ ] Type in a Google Docs document, switch tabs and back once, then ⌘Tab to another app: the tab you left drops to near 0% CPU within about 15 s, as on other pages.
- [ ] Two Safari windows side by side: switch tabs in one, click into the other, wait 5 s, click back and return to the tab you left: no flash.
- [ ] Other Safari profiles: with Safari left alone for 10 minutes, `/usr/bin/log show --last 10m --predicate 'process == "Safari" AND eventMessage CONTAINS "Starting foreground activity" AND eventMessage CONTAINS "Web Extension background content"' | wc -l` is a handful, not about 10 per profile (one a minute each before).
- [ ] Chrome: switching behaves as before.

## Switching to a sleeping tab: the page you're on stays until it's ready (2026-11-03)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


A tab Safari has put to sleep used to be flicked to the front and straight back first (the other tab flashed for an instant), then shown after 0.15 s whether it was ready or not, which was the big black flash on heavy tabs. Now Margin wakes it and keeps the page you're on in front, under its empty screen (a spinner after a moment), until the tab is awake and has drawn, for up to about 1.6 s. Margin also starts waking a tab earlier: when the pointer rests on its row or on a space's icon, when you press, when you bring the sidebar out, and when you swipe toward a space. Test with keep-ready at 0 in Settings, or wait a minute or more after leaving the tab.

- [ ] Click a heavy tab (mail, chat, a long document) you left a few minutes ago: no black flash. The page you were on stays, covered, until the tab comes up. Note roughly how long that takes.
- [ ] The same with ⌃⌘→/← to another space, and by clicking a space's icon: the page you're on covers itself after a moment, and the space's tab comes up with no black.
- [ ] While you wait, the tab you're on doesn't flicker, and no other tab shows for an instant.
- [ ] Rest the pointer on a row for a moment, then click it: it comes up quickly.
- [ ] Bring the sidebar out (hover at the left edge, or the toggle) and click the tab you used just before: quick.
- [ ] Rest the pointer on another space's icon, then click it; and swipe to another space: quick, no black.
- [ ] A very heavy tab you left long ago, on a busy Mac: the page you're on may stay up to about 1.6 s, then the tab can still show dark. Note how often.
- [ ] Click a tab, then click another before the first comes up: the second one wins at once.
- [ ] Hold the next-tab key across tabs you left minutes ago: the highlight moves along the sidebar, the page you're on stays instead of a black screen for each sleeping tab passed, and the tab you stop on comes up with no black. Tabs that are awake still show as you pass them.
- [ ] ⌘-click a link to open it behind, read on for a minute or more, then click its row: no black, and no flicker of black just before it comes up.
- [ ] A space's icon or ⌃⌘ and an arrow onto a sleeping tab while the page you're on is busy: the tab comes up as soon as it's ready, not a moment later.
- [ ] Bring the sidebar out every few seconds for a minute without clicking anything: in Activity Monitor, the tab you used before the current one doesn't stay busy (at most a 2 s blip every 10 s).
- [ ] Rest the pointer on a row for 10 seconds without clicking: in Activity Monitor, that tab's Safari Web Content process goes back to near 0% after about 2 s (it used to stay up while the pointer stayed).
- [ ] Switch log (the start page's "Switch log" button), after 30 minutes of use: for switches with `wakeOutcome`, count `awake`, `resumed` and `capped`, and look at `waitedOnOldPage` and `wakeStartedBy` (`hover`, `press`, `reveal`, `space`, `keys`, `switch`). Send it.
- [ ] Chrome: switching behaves as before.

## Space icons switch on press (2026-11-03)

A space's icon at the bottom of the sidebar now switches as the mouse button goes down, like tab rows: the sidebar shows that space at once and its tab starts coming to the front, instead of nothing happening until the button comes up and Margin has saved the space. Margin also no longer waits for that save before bringing the tab.

- [ ] Press another space's icon and hold the button: the sidebar shows that space at once (its name, its tabs, its icon highlighted), and its tab comes to the front before you let go. Letting go does nothing more.
- [ ] Click back and forth between two spaces' icons quickly (about one a second): each click lands on the right space's tab, the sidebar never shows the space you just left on the page you come back to, and nothing blinks.
- [ ] Click a space's icon, then straight away (within 3 s) click a tab in the sidebar of the page that came, then come back to the first page: its sidebar shows its own space.
- [ ] Click the icon of the space you're in: nothing changes.
- [ ] In a space, click a tab other than the last one you used, switch to another space, and press the first space's icon at once: the tab you clicked comes back, not the one before it.
- [ ] Drag the tab in front onto another space's icon and press that icon straight away: the tab stays in front.
- [ ] Double-click the icon of the space you're in: its editor opens, as before.
- [ ] Tab to a space's icon with the keyboard (Full Keyboard Access) and press Space: it switches, as before.
- [ ] A space with no tabs: pressing its icon opens Margin's start page in it, as before.
- [ ] Swiping between spaces and ⌃⌘→/← behave as before.
- [ ] With a sleeping tab as the space's last tab: no black flash (the page you're on stays covered until it's ready, as in the entry above).
- [ ] After switching spaces, reload the page you land on (⌘R) within 2 s: its sidebar shows the space you switched to.
- [ ] Chrome: clicking a space's icon switches on press too, and the space is right after a reload.

## No crash from asking for animations (2026-11-03)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


The page in front went black for about 2 seconds and reloaded when WebKit crashed sorting a page's animations, which Margin asked for on every read of the page's layout. Margin no longer asks.

- [ ] After a day of normal use, look for new crash reports: `ls -t ~/Library/Logs/DiagnosticReports/ | grep WebContent | head`. For each one since the update, `grep -l compareAnimationsByCompositeOrder ~/Library/Logs/DiagnosticReports/com.apple.WebKit.WebContent-*.ips` should not list it. A `TypeLocationCache` crash is a different one (it was there before 2026-11-01); note it if it keeps coming.
- [ ] A tab in front that goes black and reloads by itself: note the time, and send the crash report from that minute.
- [ ] Outlook (or another mail web app): after the mail has loaded, no gap at the left, top, right or bottom. The same after toggling its folder pane or reading pane, and after changing the sidebar's width.
- [ ] Sites whose page slides or fades in as it opens (a menu that pushes the page over, a site that animates in): once it has stopped moving, the page sits right against the sidebar and the frame, with no gap or overlap.
- [ ] Sites with a footer at the bottom of a short page (a login page, a settings page): the footer is at the bottom of the box, not squeezed up, and the page scrolls all the way.
- [ ] Sites that put a bar at the very top after they open (a cookie or notice bar that slides in and pushes the page down): once it has stopped, the gap above the page is the same as before it came. Close the bar: the page goes back up.
- [ ] A few idle tabs left open for a minute, Margin's sidebar showing: in Activity Monitor (CPU tab, View → All Processes), their Safari Web Content processes sit near 0% while you don't touch them.
- [ ] Chrome (full screen): the same sites look as before.

## Round 3: the 30-minute check (2026-11-02)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


The check for round 3 (this round's is "This round: the 20-minute check" above). It checks the whole of round 3 (faster switching, no dark frames, less CPU and memory) in about 30 minutes of normal use. The sections below go into each part. Run `npm run safari` first. Use Safari as you normally do, with 15 or more tabs in a few spaces. Don't judge anything in the first 5 minutes after quitting and reopening Safari: tabs are still coming back then, and everything is slower. Close other heavy apps if you can, and note what else was running.

**Before you start**

- [ ] Activity Monitor → CPU, search "Safari Web Content". Note the total %CPU while you read a page without touching anything for a minute.

**Normal use (25 minutes)**

- [ ] Switch with the sidebar as you normally would: rows, ⌃⌘↓/↑, the command bar. Tabs you used in the last minute come up at once, as fast as Safari's own tab bar, with no flash.
- [ ] At least five times, go back to a tab you haven't touched for 10 minutes or more. Click its row. It should come up within a moment, with no black or empty window and no flash of another tab. It may take a little longer than a recent tab. It shouldn't take a second.
- [ ] Do the same once right after leaving Safari alone for 2 minutes or more (another app in front, or just reading). That's when Safari has stopped Margin's background, and the first click starts it again. It should look the same as above.
- [ ] Rest the pointer on a row for a second or two before clicking it, for a tab you haven't used in a while. No flash or black when it comes up.
- [ ] The tab you click from never blinks or goes blank for an instant as you click.
- [ ] Hold ⌃⌘↓ through a space and stop. The tab you stop on comes up cleanly. The ones passed may flash briefly, as before.
- [ ] Open links in new tabs (⌘-click), ⌘T and type a site. New tabs come up as soon as something is drawn.
- [ ] A chat or mail tab behind whose title counts messages: its row follows within about 2 seconds.
- [ ] Each tab you land on has the right tab highlighted, the right space, and the sidebar scrolled as before, from the first frame.

**After a burst (2 minutes)**

- [ ] Click quickly through ten or more tabs, then stop and read a page. In Activity Monitor, the Safari Web Content total falls back within a few seconds to about what it was before you started, not after a minute or more.
- [ ] Then leave Safari alone for 5 minutes. The total falls further: at most about six hidden tabs keep running.

**What you shouldn't see**

- A dark or empty window when switching with the sidebar, except right after a relaunch, or when going back to Safari from another app (plain Safari does that too).
- A switch that takes a second or more to a tab that's already loaded.
- The page you click from flickering.
- Safari freezing for an instant as you click a row.

**Send me**

- [ ] Start page → Settings → Switch log (development) → Copy, at the end. Paste it into a file. Note the times of anything that looked wrong (a flash, black, a slow switch), and roughly what you clicked.
- [ ] If you can, Safari's log for the same window: `/usr/bin/log show --last 35m --predicate 'process == "Safari"' > ~/Desktop/safari-round3.log` (it's large).
- [ ] The two Activity Monitor numbers (idle before, a few seconds after the burst) and the one after 5 minutes.

What the switch log shows, per switch: `shownAfter` is the ms from the click to the show. `hiddenForMs` is how long the tab had been behind. `heldAtAsk` says whether keep-ready was holding it. `kicked` means Margin woke it with a flip out of sight first: `outcome: "resumed"` is good, and `behind: true` means an earlier wake had already brought it back slowly. `stuck: true` means it was shown without waiting.

**Chrome**

- [ ] The same clicks on loaded tabs and ⌘T. Chrome shows a new tab once it has loaded, as before. Chrome's Task Manager (⋮ → More tools) shows no Margin process using CPU while you read a page.

## Round 3's last fixes (2026-11-02)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


- [ ] Leave Safari alone for 2 minutes or more, then come back and click a sidebar row for a tab you left 10 minutes ago or more. It comes up within a moment, with no black. In the switch log that switch has `hiddenForMs` (a number, not null) and `kicked`.
- [ ] Rest the pointer on such a row for a second, then click it. No black. Its switch log line has `kicked` with `behind: true`, or no kick if the tab was still running.
- [ ] Right after coming back to Safari from a long break (30 minutes or more), click a tab you haven't used in a long while, and switch away within a few seconds. Then use seven or more other tabs of the space, one after another. Activity Monitor: once those seven are used, that first tab's process (its address in the process name) goes quiet within a few seconds, not up to 75 s later.
- [ ] Chrome: switching behaves as before.

## Switching at first paint, fewer dark frames (2026-11-02)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


Quit and reopen Safari with tabs in a few spaces, so most come back unloaded. Record the screen while you try these, and step through it frame by frame if anything flickers.

- [ ] Click rows of tabs you haven't opened since the relaunch, busy sites too (YouTube, a news site, Gmail): the page you're on is covered with the spinner, and the tab comes up about as fast as Safari shows such a tab by itself, under a second on most sites, drawn, maybe with images still coming in. No dark window.
- [ ] A site that shows nothing while its scripts start (some web apps), Keep open on and off: it comes up once its own content is drawn (not an empty page with only Margin's sidebar), or at most about 1.5 s after it starts loading, as far as it got.
- [ ] The tab that was in front when Safari opened: switch away from it with the sidebar, then back with the sidebar. No dark flash on the way back.
- [ ] Click a link in a tab, switch to another tab with the sidebar, then back: as quick as any loaded tab (its switch log line has no `unseen`).
- [ ] A local dev site with an error overlay (webpack, Vite, Next), or a site you know reports errors: switching to it from an unloaded or never-shown state shows no "ResizeObserver loop" error.
- [ ] A tab you opened by clicking it in Safari's own tab bar (it loaded as it was shown), then left: back to it from the sidebar, no dark flash.
- [ ] ⌘T, a slow site (youtube.com), Enter: it comes to the front as soon as something is drawn, not once it has finished loading. A Google search the same. No dark frame as it comes up; typing goes into its field.
- [ ] From a PDF in front, ⌃⌘↓ to an unloaded tab: it loads in front under Margin's cover, which lifts as soon as the page is drawn, not when it has finished loading.
- [ ] Switching to busy pages from the sidebar (a video playing, a big web app): no slower than before, no dark flash.
- [ ] After a long while, a tab Safari unloaded to save memory (it reloads when clicked): the same as after a relaunch.
- [ ] Chrome: ⌘T, a slow site, Enter: it comes to the front once loaded, as before.
- [ ] If a dark flash or a slow switch shows: Start page → Settings → Switch log (development) → Copy. On those switches, `restored` or `loadWait` says `painted` when Margin waited for the first paint, `unseen: true` when it introduced a tab whose page had never been on screen, a new tab's wait says what it ended on in `ready`, and `barrier` says whether the page drew before the show (`drawn`) or Margin gave up waiting (`timeout`, and how long). Safari's log around them: `DidFirstVisuallyNonEmptyLayoutForFrame`, `hideContentUntilPendingUpdate`, `Selecting tab`.

## Keep-ready: six tabs (2026-11-02)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


Keep-ready now holds the six tabs you used last in the space shown, not every tab of it, and doesn't keep trying tabs Safari unloaded.

- [ ] Use five or six tabs of a space, leaving each for a minute or more, then go back and forth among them with Safari's own tab bar or ⌃Tab, and with the sidebar: no dark flash.
- [ ] With ten or more tabs in the space, all used, wait two minutes, then switch with Safari's tab bar to the one you used longest ago: it may show dark for a moment, as in plain Safari (it was suspended). The six used last still show with no flash.
- [ ] Hidden tabs beyond six are suspended: after using Safari for a few minutes with many tabs loaded, `/usr/bin/log show --last 3m --predicate 'process == "Safari" AND eventMessage CONTAINS "didChangeThrottleState: type="'` shows web content processes going to `type=0` (suspended) or `type=1`; at most about six hidden ones stay at `type=2` (foreground) for minutes.
- [ ] Few failed scripts: after a relaunch (most tabs unloaded), switch a few times, then read one page for five minutes without switching tabs. `/usr/bin/log show --last 5m --predicate 'process == "Safari" AND eventMessage CONTAINS "Could not execute script"' | wc -l` shows a few at most: about one for each unloaded tab of the spaces shown every 10 minutes (it was 16–46 a minute). Switching to unloaded tabs still makes some (Margin asks whether the page has painted while it loads).
- [ ] If they stay high: whether they come in bursts about a minute apart (Margin's background started again by its alarm each minute: an extension's background start shows as `WebPageProxy::loadServiceWorker` in `/usr/bin/log show --last 5m --predicate 'process == "Safari" AND eventMessage CONTAINS "loadServiceWorker"'`), or right after tab updates for tabs Safari hasn't loaded. Either way, note it: keep-ready should still leave those tabs alone.
- [ ] A tab Safari unloaded still loads only when you click it, and once you've been to it and left, switching back has no flash.

## Lighter page work (2026-11-02)

Pages read less of Margin's storage, a hidden tab finishes its page's work before it's shown, and Chrome doesn't draw the sidebar where it can't be seen.

- [ ] **Icons:** visit a site you haven't been to with Margin, then go to a tab you'd left a while ago (behind, maybe suspended) and back: the new site's icon is in both sidebars, not its letter. The same after a Safari relaunch, and after updating Margin with `npm run safari`.
- [ ] Icons, tabs, spaces, pins and settings look right in every tab after switching around for a while, with Keep open on and off; and on Margin's new-tab page (⌘T).
- [ ] **Switching to tabs left behind:** with Keep open on, change the sidebar's width in one tab, then switch with the sidebar to tabs that were behind: each comes up at the new width with its page laid out for it in its first frame, with no shift, jump or flash after it. The same on sites with a layout that changes with the window's width (a news site, a docs site), and on a tab loaded behind (⌘-click a link) shown for the first time.
- [ ] Switching feels no slower on heavy sites (a big web app, a long page) than before, and the sidebar you switched from (hovered open) is still open on them as they come up. If one is slow or closes it: Start page → Settings → Switch log (development) → Copy; the switch's `preparation` says how long it took (`timeout` past 0.9 s).
- [ ] **Chrome, Margin only in full screen** (the default): in an ordinary window nothing of Margin shows, as before. Make it full screen: the sidebar is there at once with every tab, the right space and width, Keep open as it was; hover the left edge in auto-hide: it slides in with its rows, no empty sidebar first. Leave full screen and come back: the same. With Keep open on, the docked sidebar has its site icons as it comes in, not empty slots or letters filling in. With "Use in windows too" from the notice, the sidebar works in the window at once.

## Pages left don't stay in memory (2026-11-02)

Margin's listeners come off as a page is left and go back on if you come back to it with Back or Forward.

- [ ] Memory: in one tab, follow 20 or so links on one site (Wikipedia, a docs site). Activity Monitor → Memory, the tab's process (`Safari Web Content` with its address, or `ps` with the pid from `/usr/bin/log`): it goes up and down with each page, but doesn't keep climbing by about a page's size each time. If it climbs: turn Margin off, do the same, and note both.
- [ ] Back and Forward: follow a link, change something in another tab's sidebar (rename a space, pin a tab, turn Keep open on or off), come back to the first tab and press Back: the page comes back at once and its sidebar shows the change. Switching from it with the sidebar, ⌘T and ⌃⌘↓ work as before.
- [ ] Chrome: the same Back test.

## Keep-ready holds end when they're no longer wanted (2026-11-02)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


Keep-ready still keeps the six tabs used last running, but no more than six at any time, and a tab that drops out of the six is let go at once instead of after 75 s.

- [ ] Switch through ten or more tabs quickly (the sidebar, Safari's tab bar, ⌃⌘↓ held down), then stop and read for a minute. Activity Monitor → CPU, the `Safari Web Content` processes: their total falls back within a few seconds of stopping, not after a minute or more.
- [ ] Safari's log after ten minutes of normal use: `/usr/bin/log show --last 10m --predicate 'process == "Safari" AND eventMessage CONTAINS "didChangeThrottleState: type="'`. At most about six hidden processes stay at `type=2` (foreground) for long; others go to `type=0` or `type=1`.
- [ ] Going back and forth among the five or six tabs used last, with the sidebar and with Safari's tab bar: no dark flash, as before.
- [ ] A tab you go back to after switching through many others may show dark for a moment (it was let go and suspended). Note how often. The next change targets it.
- [ ] Holding ⌃⌘↓ through a space and stopping: the tab you stop on, and the one you started from, come back with no flash, also after passing more than six tabs. The ones passed through may not.
- [ ] Change space, wait 10–60 s, change back: the tab you left there shows with no flash. Wait more than 75 s and it may flash.
- [ ] Leave Margin's start page and a Safari settings page for a tab, a few times: the tabs you used just before still come back with no flash.
- [ ] Switch log (Start page → Settings → Switch log (development) → Copy): each switch has `heldAtAsk`, `hiddenForMs`, and under `preparation` a `timings` object (`lagMs`, `readMs`, `renderMs`, `catchUpMs`, `layoutMs`). Send it along with what felt slow.

## A tab Safari suspended is kicked awake (2026-11-02)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


A switch with the sidebar to a tab you haven't been to for a while brings it to the front and straight back first, out of sight, so Safari wakes it at full speed. If it doesn't wake in time, the tab is shown at once instead of after almost a second.

- [ ] Leave a few tabs alone for 10 minutes or more (more than six tabs in the space, so keep-ready doesn't hold them all), then click them in the sidebar one at a time. No flash of another tab, no black, and no slower than clicking them in Safari's tab bar.
- [ ] The tab you click from never flickers or goes blank for an instant as you click. If it does even once, note it: Margin turns the kick off for the rest of the Safari session when it notices (the background console then says "no more introductions until Safari restarts").
- [ ] Switch log (Start page → Settings → Switch log (development) → Copy): switches to tabs left a while have `kicked` with `outcome: "resumed"` and a small `wakeMs` (under about 60). `kickMs` is how long Safari took to answer the kick: about 110 is normal; near 250 means Safari held its window waiting for that tab's page to draw. `"stuck"`, or `stuck: true` with no `kicked`, means the tab was shown without waiting. Send the log along with how those switches looked.
- [ ] While clicking tabs left alone a while: Safari never freezes for an instant (scrolling the page you're on, or the sidebar, stops responding for a moment as you click). If it does, note it with the switch log (`kickMs` near 250 on those switches): the kick would then cost more than it saves.
- [ ] Right after relaunching Safari, click tabs that haven't loaded yet: the page you're on stays, covered by the empty screen with its spinner, then the tab comes up drawn: never Safari's dark empty view, and no flip to the tab and back before the cover.
- [ ] Safari's log, right after such a switch: `/usr/bin/log show --last 2m --predicate 'process == "Safari" AND (eventMessage CONTAINS "sending ProcessDidResume" OR eventMessage CONTAINS "processDidResume")'`. For a kicked tab, the resume's reason should be a visibility or foreground one, not `WebFrame_GetFrameInfo`, and it should come before the tab's final selection.
- [ ] Sites in tabs you come back to (a chat, a mail tab) behave as before: no messages marked read, no sound starting, for being kicked.
- [ ] Hold ⌃⌘↓ through tabs you haven't used for a while: the tabs passed through aren't flipped to and back (no flicker), as before. The tab you stop on comes up as a click does.
- [ ] Chrome: switching behaves as before.

## A loaded tab is prepared without reading storage (2026-11-02)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


Switching to a tab that's loaded no longer waits for that tab's page to read Margin's storage: it draws from what it already has. A page busy with its own work is shown after about a quarter second instead of up to almost a second.

- [ ] Go back and forth among five or six tabs you've used in the last minute, with the sidebar (click rows, ⌃⌘↓/↑). Each comes up about as fast as Safari's own tab bar shows it, with no flash.
- [ ] On each tab as it comes up: the sidebar has that tab highlighted, the right space, and the list scrolled where the tab before had it, from the first frame. No row jumping or highlight moving a moment later.
- [ ] Change something in one tab's sidebar (rename a space, pin a tab, turn Keep open on or off, change the sidebar's width), then switch with the sidebar to tabs that were behind: each shows the change from its first frame.
- [ ] Hover the sidebar open, click a row: the next tab comes up with its sidebar open the same way, as before.
- [ ] A busy page (a big web app, a video page while it loads): switching to it isn't slower than before. Its sidebar may catch up a moment after it shows. Note it if that's often.
- [ ] Two windows: switch in one, then in the other. Each window's sidebar shows its own tabs and highlight.
- [ ] Change something in the sidebar and switch at once, within a second (pin a tab, then click another tab's row right away; open a link in a new tab behind, then switch): the tab you land on shows the change from its first frame.
- [ ] Click quickly through several rows, one after another, before each tab has come up, then stop on one. Go back to a tab you passed with Safari's tab bar or ⌃Tab: its sidebar isn't left open, and its rows are current from the first frame.
- [ ] Switch log (Start page → Settings → Switch log (development) → Copy): switches to loaded tabs have `preparation.timings.known: 1` and `readMs: 0` most of the time, and a small `preparation.ms` (under about 60). `known: 0` now and then is expected (right after Margin starts or is updated, a change that failed to save, or a switch right after a change, while it's still being saved: then `revSent: 0`); on most switches it should be 1. `reason: "awake budget"` means the page took over 250 ms. Send the log along with what felt slow.
- [ ] Chrome: switching behaves as before.

## Restores: never shown with no document (2026-11-02)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


A tab Safari unloaded (after a relaunch, or one left a long time) is loaded behind the page and shown once it has drawn. It's now never shown before its page has arrived, and it comes up sooner after it has drawn.

- [ ] Relaunch Safari with many tabs, then click tabs that haven't loaded yet in the sidebar. The page you're on stays, covered, with its spinner, then the tab comes up drawn. Never Safari's dark empty view, and no flip to the tab and back.
- [ ] Do the same a while after the relaunch (not in the first five minutes), with tabs Safari unloaded on its own. Each comes up about as soon as it has drawn, sooner than before.
- [ ] A slow site (a server that takes a few seconds to answer): the spinner stays up to about 5 seconds, then the tab comes up as far as it got. Once the site does answer, it gets up to a second more to draw, so it comes up drawn, not white. Press Escape during the wait: you stay on your page at once. Click another row during the wait: that one wins at once.
- [ ] Right after a relaunch, a heavy site (Gmail, YouTube, a big news site) that's slow to get going: it comes up within about 2.5 seconds, not 5. In the switch log its `committed` is a number, not `null`.
- [ ] A site that draws most of its page and then waits on a script (a news site, a long article): it comes up once a good part of its top is drawn, not once it's done parsing, and not with only its header (a menu bar, a logo) over an empty page.
- [ ] Heavy pages restored behind (big images, an app): once a tab is shown, its spinner lifts within a moment (about a tenth of a second) and the page is there under it. A spinner that hangs on a shown tab, or a page that's still drawing after the spinner lifts, is worth a note.
- [ ] An app that builds itself after it loads (Gmail, Slack, Linear, after a relaunch): it doesn't come up as an empty shell.
- [ ] A PDF in a tab Safari unloaded: it comes up within about 5 seconds. Note how it looks.
- [ ] Switch log (Start page → Settings → Switch log (development) → Copy): restores (`restored`) have `committed`, the ms from the click to its page arriving. None should be `null` unless the site was down. `barrier` should mostly have one entry. Send the log with any restore that showed dark.
- [ ] Chrome: switching to tabs Chrome unloaded behaves as before.

## No wasted wakes (2026-11-02)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


Margin wakes fewer tabs it doesn't then show: a pointer passing over sidebar rows wakes none, a pointer resting on a row sends one small script every 1.5 s instead of two every half second, and a switch reuses a wake for longer.

- [ ] Rest the pointer on a row a moment, then click it: it comes up as fast as before, with no flash. Also after resting there 5–10 s.
- [ ] Move the pointer quickly down the sidebar and click a row you only just reached: it comes up with no flash, as before.
- [ ] ⌘-click a link so it opens in a tab behind, rest the pointer on that tab's row about a second, then click it: it comes up with no flash. Same for a tab that was hidden a while when Margin was just updated (its page still has the old copy).
- [ ] Hold ⌃⌘↓ through a space and stop, then press it again a few times, one press at a time: each tab comes up as before, including on a space of busy pages (mail, chat).
- [ ] Move the pointer up and down over a long sidebar for a few seconds without clicking. Activity Monitor → CPU: the `Safari Web Content` processes stay quiet (before, hidden tabs under the pointer woke up).
- [ ] Safari's log after ten minutes of normal use: `/usr/bin/log show --last 10m --predicate 'process == "Safari" AND eventMessage CONTAINS "sending ProcessDidResume"'`. Fewer resumes with the reason `WebFrame_GetFrameInfo` than before, for the same use.
- [ ] Chrome: hovering and switching behave as before.

## A hidden tab's changes are written together (2026-11-02)

Margin saves a hidden tab's new title, icon and load a moment later, together, instead of on every change. A new address is still saved at once. Fewer saves means less work in every open tab.

- [ ] A chat or mail tab behind whose title counts messages, or a page with a timer in its title: its row follows within about 2 seconds. The tab you're on shows its own title changes at once.
- [ ] ⌘-click a few links so they open in tabs behind: each row appears at once, and gets its title and icon within about a second of the page loading.
- [ ] Click a row whose title just changed: the tab comes up as fast as before, and every tab's row then shows its current title.
- [ ] Close a tab behind right after it changed its title (a chat getting a message): it doesn't come back in the sidebar.
- [ ] A tab in another space that goes to a new page while it's behind (a page that redirects after a moment, or a single-page app changing its address): quit Safari (⌘Q) right after and reopen it. The tab is back in its own space, not in the one shown.
- [ ] Switch log (Start page → Settings → Switch log (development) → Copy): `preparation.timings.known: 1` on most switches to loaded tabs, as before, also while a tab behind is ticking its title.
- [ ] Activity Monitor → CPU, with a ticking tab behind and 20 or more tabs open: the `Safari Web Content` processes are quieter than before when you're not doing anything.
- [ ] Chrome: rows follow titles and addresses as above.

## Cheap page fixes (2026-11-02)

Margin repeats less work in the tab in front: it no longer checks for its first-paint frame on every redraw, remembers for a second whether something fixed is outside the page's body, keeps each site's zoom in the background, and clears out what pages throw away.

- [ ] Sidebar hidden, frame on: load, reload and switch pages. The frame is there from the first frame, as before, and never doubled (a second, darker frame or shadow).
- [ ] Turn Keep open on and off, change the sidebar's width, and turn "With the sidebar hidden, keep the frame around pages" off and on, with several tabs open. Then go through those tabs: none shows a second frame, a frame at the old width, or a page box that jumps once Margin draws.
- [ ] After an update (`npm run safari` with pages open): the pages behind show one frame, at the right width.
- [ ] Keep open on, one tab zoomed to 150%: quit Safari, open it again, and go through the tabs within the first few seconds. None shows a second frame, a gray frame over the page, or a page box at the wrong size.
- [ ] A news article with a video that floats into a corner as you scroll past it: the floating player keeps playing, and stops or goes back when you scroll back up, as with Margin off.
- [ ] Sites with sticky or fixed headers that load more as you scroll (a news feed, X, YouTube, a long shop list): images and more items still load as you scroll, with Keep open and with the sidebar hidden. Resize the sidebar or toggle Keep open on such a page, then scroll: still loading.
- [ ] Zoom a site (⌘+), switch to another tab and back, open a new page on the same site: Margin's sidebar keeps its size everywhere, from the page's first frame. ⌘0 back to 100%: the same.
- [ ] Leave an app tab (Gmail, a chat, Figma) in front for an hour or more: its `Safari Web Content` memory in Activity Monitor doesn't keep growing more than with Margin off.
- [ ] Chrome (full screen, the default): the frame, the sidebar and zoom behave as before.

## The page's box, on every page (2026-11-01)

No iframe anymore, Keep open or hidden. Reload pages once after updating. Off-screen tests can't sign in or feel a trackpad, so these are yours. Note the site for anything wrong.

- [ ] Reddit: the header's right side is all there.
- [ ] Teams, signed in, sidebar hidden and Keep open: top bar and edges in place, nothing under the frame. Then Outlook, Gmail, Google Docs: compose and typing work, and the caret lands where you click.
- [ ] First paint: the frame and the page's place from the first frame on loads and reloads. Nothing jumps as the sidebar arrives.
- [ ] Keep open on and off, with the button, Option+S and the palette, on an open page: no reload needed, the place in the page kept, the slide animations as before.
- [ ] Settings → frame off, Keep open off: pages are untouched, Safari's own pinch works. Web Inspector: `html` has no transform.
- [ ] Two-finger scroll and momentum, with no double scroll bar. Space, arrows, Page Up/Down, Home and End scroll when nothing is focused, and don't when typing.
- [ ] Swipe back and pull to refresh, only at the top of the page. Back returns to where you were; reload keeps the place.
- [ ] Right-click and dropdown menus open at the pointer. Dialogs are centred on the page, side drawers open beside the sidebar rather than under it, and the page doesn't scroll behind them.
- [ ] A site with a centred column (a blog, docs, sive.rs): the column keeps its width, before and after dragging the sidebar's edge and resizing the window.
- [ ] A site that navigates without reloading (GitHub, Reddit): after a few clicks, images still load as you scroll, and Back returns to your place in the list.
- [ ] In a clicked inner pane (Gmail's list, Slack's messages): Page Down and arrows move that pane. ⌘↓ and ⌥↓ with nothing clicked scroll the page.
- [ ] Infinite scroll (Reddit, X): it loads as you near the end, not by itself at the top.
- [ ] Find, print (no frame, full width), full-screen video and back, sign-in flows. A web game or player in element full screen fills the screen.
- [ ] Known, small: a footer placed `position: absolute; bottom: 0` against a body that grows lands at the end of the first screen. A body wider than the window wraps to the box rather than scrolling sideways. A fetched sheet's rules arrive a moment after the page on a cold start. Say which sites show any of these.
- [ ] ⌘+ and ⌘−: the sidebar keeps its size, the page reflows beside it.
- [ ] Palette, switch covers, the startup cover after a relaunch, a tab Safari unloaded, a new tab from the palette: as before.
- [ ] Drag the sidebar's edge: the page follows, its layout switches about 150 ms after you stop, and a site's scripts that listen to a media query hear it this time.
- [ ] Chrome: outside full screen pages are untouched; in Margin full screen they have the box; leaving it puts them back.
- [ ] How it feels against the fitted layout: first paint, tab switches, scrolling.

Pinch, on a page with a box:

- [ ] Pinch in and out several times at different spots: smooth, under your fingers, the sidebar and frame don't scale, on a heavy site too.
- [ ] At rest at 2×, is text sharp? Compare with Safari's own zoom on a page with no box. If it stays soft, say so before anything else is done about it.
- [ ] Zoomed: click a link, a menu, a field: it lands where you pressed. Two fingers move the page, then scroll it at the edges. Fixed bars scale with the page.
- [ ] Past 3× and below 1×: it gives a little and springs back.
- [ ] Double-tap with two fingers: Safari's smart zoom, which scales the sidebar too. Say if that's a problem.

## Pinch zoom (2026-10-31)

- [ ] A page with Keep open off: pinch out and in. It follows your fingers smoothly, as in Safari, with no percentage, and the page doesn't re-lay out. ⌘+ / ⌘− stay a separate zoom.
- [ ] Pinch in at normal size: nothing happens, and the all-tabs overview never opens, right after zooming back to normal and on quick repeated pinches too.
- [ ] Pinch out several times: how often does one do nothing? A pinch whose very first movement is slightly inward is treated as pinching in, and it can't be recovered mid-pinch.
- [ ] While zoomed in on such a page: hover the left edge and press Option+S. The sidebar is part of the page there, so it's magnified with it and may be out of view. Say if that's a problem.
- [ ] Pinch in over an embedded video at normal size: the overview may open (as before: Margin isn't in that frame).

## The theme renamed to Arcadia (2026-10-31)

- [ ] The first `npm run safari` after the rename, with pages open and Keep open on: the sidebar shows on pages after reopening Safari, at the width you had. Your settings show Arcadia. New pages have their sidebar and frame from the first frame.

## One bare tag in the page (2026-10-31)

- [ ] Web Inspector on any page: the last child of `<html>` is `<margin-app>`, with `<margin-sidebar-host>` inside it, and `<margin-palette-host>` too once the palette has opened. No `style` or `data-` attributes on them (`popover` on the palette's), on Margin's new-tab page too.
- [ ] Everything works as before: the sidebar, the palette (⌘T, Option+K, Escape, a short window), page zoom with ⌘+ keeps the sidebar's size, the fitted layout, full screen.
- [ ] An update while pages are open (`npm run safari` with Safari running), including from a build before this one: one sidebar on each page, none stuck.

## The frame with the sidebar hidden (2026-10-31)

> Superseded (Margin 2, Phase 3, 2026-11-05): the fitted layout, the narrow rail and the per-width first-paint placeholders are gone; the page's box and its first paint come from Margin.app's layout (Phase 3). Kept as history; don't run these checks.


- [ ] Sidebar hidden: every page has the frame on all sides, with rounded corners, from its first frame: no pop-in on loads, reloads or tab switches. Hover the left edge: the sidebar floats over and the page doesn't move.
- [ ] With Keep open on, turn it off with the button, with Option+S and from the palette: the sidebar slides off to the left while the frame's edge travels with it to 8px from the window's edge, smoothly each time, with no jump in the sidebar's shape. The page takes its full size at the start, under the sliding sidebar: say if that jump looks wrong. Turn it off and back on quickly, too.
- [ ] The floating sidebar's corners match the page card's.
- [ ] Hover the left edge, press the sidebar's Keep open button: the floating sidebar goes off to the left, then the docked one comes in from the left with the frame's edge. The page moves as it comes in, or at the end on a page that was fitted. Do it again with the pointer moving away during it.
- [ ] Turn Keep open off in one tab, then go to another: no animation plays on arrival.
- [ ] Sites: a wide table or diagram still scrolls sideways; sticky headers stick; a dialog that locks the page still locks it; a full-height app (Gmail, Figma, a chat) shows no extra scroll. Look at what's under the frame: fixed headers and bars at the window's edge lose up to 8px, and so does the top and the bottom of the page.
- [ ] A site with full-width sections: does it now scroll a few pixels sideways?
- [ ] The scroll bar at the right edge shows and can be dragged. Clicks in the outer 8px reach the page.
- [ ] Print a page: no frame on paper.
- [ ] New-tab page → Settings → "With the sidebar hidden, keep the frame around pages" off: pages are as before, with no frame and no inset (new pages from the first frame).

## Sidebar efficiency: scrolling, redraws, wheel (2026-10-31)

> Superseded (Margin 2, Phase 3, 2026-11-05): Margin's UI is no longer drawn in pages, and the anti-blackout switching (wakes, holds, introductions, kicks, restores behind, covers, keep-ready, the warm-up) is gone (Phase 2 steps 5 and 8). Kept as history; don't run these checks.


- [ ] **Looks the same.** With Keep open: the sidebar, the frame around the page, the card's rounded corners and shadow are where they were, at 100%, after ⌘+ and ⌘−, and after resizing the window. Hover mode: the sidebar slides in from the left edge as before. A long tab list still scrolls; a row's menu opens beside it.
- [ ] With System Settings → Appearance → "Show scroll bars: Always" (try it, then set it back): the frame's right edge meets the page's scroll bar as before. The loading pill, the pull-to-refresh badge and the zoom readout are centred over the page card.
- [ ] Badges and covers: reload a page (the pill at the top), pull down at the top of a page (the badge comes down, spins on reload), swipe back and forward (the round badge at the edge), switch tabs from the sidebar (the switch cover): each shows, fades out, and leaves nothing behind.
- [ ] **Smooth-scrolling sites** (a page whose own script scrolls, e.g. one with a smooth-scroll library) with Keep open: scrolling isn't heavier than with Margin off (Activity Monitor: Safari's "Graphics and Media" process stays low while scrolling).
- [ ] **Redraws:** with many tabs, the sidebar updates when a tab's title or icon changes, a tab opens, closes or moves, a pin or folder changes, or a space is renamed (also from another window), and the row under the pointer keeps its hover. A tab whose icon failed to load shows its letter, and the icon once it loads.
- [ ] Rename a folder while another tab loads (its title changes): the field keeps its text and caret.
- [ ] Swipe between spaces on the sidebar: the neighbour shows during the swipe, and the space you land on is right.
- [ ] **Wheel:** on Margin's new-tab page → Settings, turn off "Use Margin's trackpad gestures instead of Safari's": Safari's own swipe back and pinch work again, on pages already open too; turn it on: they're Margin's again, and Margin's pull-to-refresh and swipe work.

## Pages open while Safari reloads Margin (2026-10-31)

- [ ] **An update reloads Margin in Safari**, and so does opening Margin.app (the system registers the app again each time it's opened). With some pages open (one with something typed in a field), run `npm run safari`, then look at those pages: the one in front and the ones behind are loaded again within a second or two (the background's console says `tab … still had Margin from before it was reloaded: loaded again`); the one with something typed keeps it and shows no sidebar until you reload it.
- [ ] Then switch tabs from the sidebar (to a tab Safari unloaded too), open a new tab from the palette, and wait a minute: no spinner that stays, no rows missing, and no ⌘R needed.
- [ ] With Margin's new-tab page open in a tab during the update: switch to it, it's loaded again (its address ends in `?again`), stays open, and its sidebar has every tab.

## Rows press and drag as in Arc (2026-10-29)

- [ ] Press and hold a tab, a pin, a folder, "+ New Tab": the row shrinks a little; let go: it springs back.
- [ ] Drag the tab in front up and down the tab list: the row stays, a copy follows the pointer, a line in the space's color with a ring shows where it goes; let go: the copy glides into its place and the rows around it slide. Safari's own tab bar (if shown) has the same order.
- [ ] Drag pins and folders to new places, a pin into a folder (open and closed), a pin out to the tabs, the tab in front into the pinned area and onto another space's icon: each lands where the line was.
- [ ] Drop it nowhere (outside the list), or press Escape mid-drag: the copy glides back.
- [ ] With a long list, drag toward the top or bottom edge: the list scrolls.
- [ ] Zoomed page (⌘+), the overlay sidebar, Keep open, Margin's new-tab page: the copy stays under the pointer and lands in place.
