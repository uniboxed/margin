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

Retired 2026-11-01, as above.

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

## A tab shown for the first time (2026-10-29)

- [ ] ⌘T, an address of a busy site (youtube.com, a Google search), Enter: as the new tab comes up there's no dark frame at all; record the screen and step through it frame by frame around the switch.
- [ ] While the new tab loads behind, nothing flickers: not the page you're on, its cover or highlight, nor Safari's tab bar or address bar if they're showing.
- [ ] ⌘-click a few links (they open behind), wait a few seconds, then click their rows in the sidebar: no dark frame either.
- [ ] With a video playing in the page you're on, ⌘T and an address: the video doesn't pause and resume as the new tab is introduced.
- [ ] After the new tab is shown: the sidebar highlights it and stays in its space; ⌃⌘↓ goes on to the next tab, ⌃⌘↑ back.
- [ ] If anything above goes wrong, say so: Safari's log (Console, process Safari, `hideContentUntilPendingUpdate`) and Margin's switch log (`introduced` on those switches) show what happened.

## Tabs of the space kept ready (2026-10-29)

- [ ] Use a few tabs of a space, leave one for a minute or more, then switch back to it with Safari's own tab bar or ⌃Tab: no dark flash. The same from Margin's sidebar.
- [ ] Settings › "Keep the tabs of the space you're in ready…" shows 30; set 0 and the flashes from Safari's own switching come back after a minute; set it back.
- [ ] After 30 minutes without using Safari, Activity Monitor's Energy tab shows Safari's web content processes going quiet again.
- [ ] A tab Safari unloaded (shown as reloading when you click it) still loads only when clicked.

## A new tab from ⌘T shows once it has loaded (2026-10-28)

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

## Speed, flicker and memory: the quick check (2026-11-02)

Start here. It covers what the sections below check in detail. Run `npm run safari` first, then quit and reopen Safari with 15 or more tabs in a few spaces, so most come back unloaded. Record the screen (⇧⌘5) while you switch, and step through it frame by frame if anything looks off.

- [ ] **Unloaded tabs:** click rows of tabs you haven't opened since the relaunch. Each comes up in under a second on most sites, about as fast as Safari's own tab bar shows such a tab. The page you're on keeps a spinner until then. No dark window at any point.
- [ ] **New tabs:** ⌘T, type a site (youtube.com), Enter. It comes to the front as soon as something is drawn, not when it has finished loading. Then a Google search, the same.
- [ ] **The tab that was in front at the relaunch:** click a link in it first, then switch away with the sidebar and back. No dark flash on the way back.
- [ ] **App pages:** Gmail, YouTube and Outlook (or another web app that builds itself with scripts), each from an unloaded state. Each comes up with its own content drawn, not an empty page with only Margin's sidebar. A slow one may show its own loading screen. Click such a row twice quickly: it still comes up as fast.
- [ ] **A slow server or a redirect:** a link from Gmail (it goes through google.com/url), a t.co link, or a site that sends you to a login page. ⌘-click it, then pick its row. It comes up drawn, with no dark frame.
- [ ] **Loaded tabs:** go back and forth among the six tabs you used last, with the sidebar and with Safari's tab bar. Instant, no flash.
- [ ] **Memory and CPU:** after 10 minutes of normal use, open Activity Monitor. In the CPU tab, Safari Web Content processes for tabs you're not looking at sit near 0%. In the Memory tab, the Safari Web Content total isn't far above what the same tabs use with Margin turned off (Safari → Settings → Extensions; turn it back on after). Follow 20 links on one site in one tab: that tab's memory goes up and down, but doesn't keep climbing.
- [ ] **Chrome:** the same clicks on loaded tabs and ⌘T. Chrome shows a new tab once it has loaded, as before. Chrome's Task Manager (⋮ → More tools) shows no Margin process using CPU while you read a page.
- [ ] **If something is off:** Start page → Settings → Switch log (development) → Copy, and note the time. The fields are described in the next section.

## Switching at first paint, fewer dark frames (2026-11-02)

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
