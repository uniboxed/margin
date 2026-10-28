# Testing Margin

## Automated (cloud / any machine with Node 22)

```sh
npm test            # unit tests: node --test tests/*.test.js
npm run test:e2e    # builds dist/, then Playwright, headless Chromium, loads dist/chrome/ unpacked
```

Everything below this line is **manual, in Safari on macOS**. The automated tests only prove the extension works in Chromium.

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
- [ ] Note whether pinching out still zooms the page in (it may not: Margin now cancels the start of every pinch at normal zoom). ⌘+ / ⌘− always zoom.
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

- [ ] Pinch out (fingers apart) on a page: it zooms in through Safari's zoom steps (115%, 125%, 150%…), with a small "125%"-style readout at the top. Pinch in: back down, stopping at 100%. Pinching in at 100% never opens the all-tabs overview.
- [ ] After ⌘+ / ⌘−, the next pinch starts from that level.
- [ ] Swipe right with two fingers (back): a dark round badge with ← appears on the page's left edge, darkening as you swipe; let go past the point where it's fully dark and the page goes back. Swipe left: → on the right edge, forward. A short swipe, or one over a carousel/wide table that scrolls sideways, doesn't navigate.
- [ ] Settings → "Swipe sideways with two fingers to go back or forward" off: no badge, no navigation.

## Optional feature flags (Safari → Settings → Feature Flags)

- [ ] "CSS corner-shape property" on or off: corners look the same, rounded (Margin doesn't use it; Safari's experimental version draws squares).
- [ ] "Threaded Time-based Animations" on: sidebar slide/badges stay smooth while a heavy page is loading.
- [ ] A fresh tab with no history: swiping back shows no badge. After clicking a link, swiping back works.
- [ ] Settings toggles look like macOS switches.

## Page card (Keep open)

- [ ] The page's corners are rounded (small, about 6pt, like Arc's), not square. Same on the new-tab page.
- [ ] A soft shadow around the page, a little stronger along the bottom edge. No thin outline.
- [ ] Opening a page: the corners and shadow are there from the first frame and don't change when Margin finishes loading. Resizing the sidebar: they move with the edge.

## Page-load indicator

- [ ] With "Keep open" on, reload a page (⌘R): a small dark pill appears centered in the gray strip above the page, pulses gently while it loads, and fades out when done. Click a link to another page: same.
- [ ] In auto-hide mode the pill shows at the very top of the page, centered on the window.
- [ ] It never blocks clicks, and very fast pages don't leave it behind.
- [ ] Press ⌘R on a slow page (e.g. YouTube): the pill appears right away, on the current page, and stays until the page has reloaded, without blinking off in between (Keep open). In auto-hide mode, a short gap right as the new page appears is expected.
- [ ] Click a download link: the pill may appear; it goes away on your next click or key press (or after 10s).

## Fitted layout with Keep open (Safari 27)

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
- [ ] Settings on the new-tab page save (shortcuts, gestures, archive hours, fit pages).
- [ ] Pull-to-refresh and two-finger swipe back/forward; pinch zoom.
- [ ] Site icons appear for new sites.
- [ ] After changing Margin's website access in Safari's settings, Option+K still opens the palette once (not open-then-close).

## Themes: Arcadium in its own folder (2026-10-25)

Files were added and moved under `dist/safari/`: re-run `scripts/make-xcode.sh`, then Run in Xcode. Nothing should look or behave differently.

- [ ] After installing, pages you open show the sidebar as before (it now comes from `themes/arcadium/`). Also right after relaunching Safari: the first restored tabs still get it (they ask the background for the theme if Safari hasn't loaded its registrations yet).
- [ ] "Keep open": the first paint already shows the frame (placeholder), pages push or fit as before, and resizing still saves the width (it's now Arcadium's own setting; your old width carries over).
- [ ] The new-tab page looks the same; Settings has a new "Theme" row showing Arcadium.
- [ ] ⌘T still hands off to the palette over the previous tab (the new tab now closes without drawing the launcher first); ⌘N's first tab opens the palette over the launcher.
- [ ] Loader pill, pull-to-refresh, swipe badge and pinch-zoom readout look and behave as before.

## Sites that don't want a frame (2026-10-26)

With Keep open on:

- [ ] Outlook (outlook.office.com) and its sign-in page load once and stay; no reloading.
- [ ] docs.new creates one document and opens it; no loop. Docs, Teams, Outlook and claude.ai show in the normal (pushed) layout, Teams with its top bar.
- [ ] GitHub: open a commit through in-page navigation (repo → file → its latest commit), then click files in the commit's file tree: it scrolls to that file's diff and stays on the commit.
- [ ] YouTube: the address bar follows videos you open; ⌘R reloads the video you're on.
- [ ] On a fitted site, the sidebar footer shows ▢; clicking it reloads the site in the normal layout and shows ▣; clicking ▣ fits it again.
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

Reload Margin in chrome://extensions after pulling. Keep open on, in Margin full screen.

- [ ] YouTube, GitHub, Figma, Google Maps, BBC, Stack Overflow: the page fits beside the sidebar, nothing under the sidebar or cut at the right.
- [ ] Links, Back/Forward, the address bar and ⌘R behave as without Margin (GitHub: open a file, then its commit, then Back).
- [ ] Your password manager fills a login on a fitted page (e.g. GitHub sign-in). If not, say which one.
- [ ] Signed in: Gmail, Notion, Figma work normally. Teams, Outlook, Docs stay in the normal (pushed) layout.
- [ ] The sidebar footer's ▢ "Show this site normally" reloads the site unfitted; ▣ fits it again.
- [ ] Leaving full screen: newly loaded pages are normal; with one window in full screen and another not, pages in the other window aren't fitted.

## The narrow rail (2026-10-26)

Keep open on (Safari, and Chrome in Margin full screen), signed in:

- [ ] Teams, Outlook, Google Docs: a narrow icon rail on the left, the page pushed by it only. Are their left app bars and top-right buttons (profile, settings) usable?
- [ ] Clicking a tab icon in the rail switches tabs; resting the pointer on the rail opens the full sidebar over the page; moving away folds it back.
- [ ] Fitted sites (YouTube, GitHub, Figma) keep the full sidebar.
- [ ] Settings → "show a narrow sidebar of icons" off: those sites are pushed by the full sidebar again.

## One sidebar across pages (2026-10-26)

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

- [ ] Switch through the sidebar, the palette and ⌥⌘↓/↑ to tabs you haven't used for a few minutes: fewer black flashes than before; switching never feels slower than about half a second.
- [ ] Start page → Settings → Switch log (development) → Copy, after a session of switching, and send it along with any black flash you saw (and roughly when).
- [ ] Safari Settings → General → "New tabs open with" → Margin, then ⌘T: Margin's palette over the page.
- [ ] With it on Homepage instead: ⌘T twice (each opening the homepage) shows a note on the second about where to set it; "Don't show again" stops it.

## Instant feedback on switching (2026-10-26)

- [ ] Click a tab in the sidebar: it's highlighted at once (your page's tab softly) before the page changes.
- [ ] Switching to a tab you haven't used for a while: if it takes a moment, the small loading pill shows at the top; quick switches never show it.
- [ ] ⌥⌘↓/↑ and the palette: the same.
- [ ] Clicking your own tab again during a slow switch keeps you where you are.

## Narrow rail off (2026-10-27)

- [ ] With Keep open, a page Margin can't fit (Teams, Outlook, Docs, or "Show normally" on a site): the full sidebar beside it, no narrow icon rail; the start page's Settings has no rail switch.

## Arc's sidebar and folders (2026-10-27)

- [ ] The sidebar looks like Arc's: toggle at the top left, the space's name, folders and pins, "+ New Tab" and tabs in one list, the bottom bar (archive, spaces, +).
- [ ] "+" → New Folder: type a name, Enter. Right-click a tab → Pin to 📁 that folder; drag another tab onto the folder; drag a pin out; drag pins to reorder; drag a pin onto the tabs to unpin it.
- [ ] Click a folder to close it; with one of its tabs shown, that pin still shows under it. Double-click renames.
- [ ] An open pinned tab's × closes the tab, the pin stays. Right-click → Unpin.
- [ ] Bottom bar: click a space's emoji to switch; right-click or double-click the space name to edit it; the archive button opens "Recently archived".

## Instant switching; spaces show their last tab (2026-10-27)

- [ ] Switch between two tabs in the sidebar: the highlight jumps in one go (no soft step), no tooltip pops up, and the page follows almost at once.
- [ ] Rest the pointer on a row, switch away with the keyboard, switch back without moving the mouse: no hover or × on that row until you move.
- [ ] Click another space's emoji: that space's last tab comes to the front; an empty space opens the start page; ⌃⌘←/→ the same.
- [ ] Close the tab you're on (× or ⌘W): you stay in the same space, on its last used tab.

## A tab that slept through an update (2026-10-27)

- [ ] Rebuild Margin with a few tabs open, leave one unused (asleep) during the rebuild, then switch to it: its sidebar works (switching from it lands), no stuck highlight or pill.
- [ ] If Margin ever stops responding on a page, a note offers Reload after a few seconds; Reload fixes it.

## An empty screen while switching (2026-10-27)

- [ ] Click another tab in the sidebar: the page you're leaving turns into a plain gray card at once (no flash of its content), a spinner shows in the middle if it takes a moment, then the other tab appears.
- [ ] Switch back and forth quickly: coming back to a tab never shows the gray card or a spinner before its page.
- [ ] Same from Margin's new-tab page, from the palette, with the sidebar on auto-hide (the whole page goes gray), and on a fitted site.
- [ ] ⌘T and "+ New Tab" show no gray card.
- [ ] Hold ⌃⌘↓: the tabs go by with their content (no gray cards); one press to a slow tab shows the gray card after a moment.
- [ ] Tab overview: tabs you left through the sidebar may look gray there (accepted); say if that bothers you.

## Atomic sidebar handoff (2026-10-28)

- [ ] Open the hover sidebar, scroll its list, and switch repeatedly among two warm tabs: the destination appears with the same scroll position, the correct row/space highlighted, and the sidebar already open. There must be no one-frame closed, stale, or wrong-space sidebar.
- [ ] Repeat with Keep open, a pin, a space icon, the active tab's ×, and one ⌥⌘↓/↑ press. The frame/sidebar geometry must not jump when the page changes.
- [ ] Rapidly click three different rows, then click back to the page already on screen: only the last request may land; no earlier destination may open later or retain a carried hover sidebar.
- [ ] Leave a tab unused until Safari suspends it, then switch to it. The old page stays under Margin's cover until the destination is ready; no black frame. Repeat after relaunch with a lazily restored tab: Safari may still show its own empty view while it creates the document, but Margin must recover normally and never leave the cover or sidebar stuck.
- [ ] Start page → Settings → Switch log (development) → Copy. Warm Margin switches should show `preparation.outcome: "ready"` (normally well below 300ms); an unloaded/denied page may show `unavailable`, `not ready`, or `timeout` and must still switch.

## Temporary-extension reinstall recovery (2026-10-28)

- [ ] Keep at least three ordinary web tabs open, quit Safari (so it removes the temporary extension), reopen Safari, allow unsigned extensions, and add `dist/safari/` again. As soon as Margin's sidebar appears, click a different tab. It must switch once and remain there for at least five seconds: no 2–3 second gray cover followed by a snap back to the tab that was active at install time.
- [ ] Without refreshing any page, switch through every restored tab and all spaces. Each page must have one visible, working sidebar; no tab may require repeated refreshes. A lazily restored/discarded tab may take Safari's normal load time on its first visit, but its first working sidebar must use the correct active tab and space.
- [ ] Repeat with text typed into a form before quitting. Reinstalling Margin must not erase the draft; that page may postpone its cleanup reload while it is in use.

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

