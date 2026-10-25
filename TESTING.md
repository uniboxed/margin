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
- [ ] Typing `hello world` + Return searches DuckDuckGo.
- [ ] Settings → Search engine → Google, then search again: Google is used.
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
