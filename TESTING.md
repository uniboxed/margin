# Testing Margin

## Automated (cloud / any machine with Node 22)

```sh
npm test            # unit tests: node --test tests/*.test.js
npm run test:e2e    # Playwright, headless Chromium, loads extension/ unpacked
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

## One-time setup

1. Build the app: see README → "Building for Safari (local, macOS)".
2. Safari → Settings → Advanced → enable **Show features for web developers** (older Safari: "Show Develop menu in menu bar").
3. Safari → Settings → Developer (older Safari: the Develop menu) → enable **Allow unsigned extensions**. You'll be asked for your password. **This resets every time Safari quits**, so redo it after each Safari launch.
4. In Xcode, open `xcode/Margin/Margin.xcodeproj`, select the **Margin (macOS)** scheme, and Run (⌘R). The container app opens. You can close it.
5. Safari → Settings → Extensions → check **Margin**.
6. In the same pane, under Margin's permissions, set website access to **Always Allow on Every Website**. (Or click the Margin toolbar icon on any site → "Always Allow on Every Website.")
7. Safari → Settings → General → **New tabs open with** → **Margin**. Set **New windows open with** to Margin too if you like.

## M1 smoke check

- [ ] Open any website (e.g. https://example.com). In Web Inspector → Elements, there's a `<margin-sidebar-host>` element at the end of `<html>` with a `#shadow-root (closed)`.
- [ ] Press ⌘T. The page is Margin's new tab (title "New Tab"), not Safari's Start Page.

## M2 sidebar overlay

- [ ] On a normal site, the sidebar is hidden. Move the cursor to the very left edge: it slides in over the page (the page does not shift).
- [ ] Move the cursor right, past the sidebar: it hides after about 300ms. Moving back in before that keeps it open.
- [ ] Sites with fixed headers or sticky elements (e.g. github.com, nytimes.com) look unchanged while the sidebar is open.
- [ ] Tab rows show favicon (or letter), title, and close button on hover. Clicking a row switches to that tab, clicking × closes it.
- [ ] 📌 on a row pins it; the pin appears above the divider. Clicking the pin focuses its tab; after closing the tab, clicking the pin reopens it.
- [ ] Space chips at the top switch which tabs are listed (this window only).
- [ ] "+ New tab" opens Margin's new tab page.
- [ ] On a dark site and a light site, the sidebar matches.
- [ ] Option+S (toggle command) opens the sidebar; Esc or a click on the page closes it. If the shortcut does nothing, check Safari → Settings → Extensions → Margin for shortcut settings and note what works.
- [ ] "Keep open" in the sidebar footer keeps it visible on every page until clicked again ("Auto-hide").
- [ ] No sidebar appears on Margin's own new tab page except the built-in one.

## M3 new-tab page

- [ ] ⌘T shows the sidebar on the left (always open) and a centered search field. Safari puts focus in the address bar first: **this is expected**. Click the field to type.
- [ ] Typing `example.com` + Return opens https://example.com in the same tab.
- [ ] Typing `hello world` + Return searches DuckDuckGo.
- [ ] Settings → Search engine → Google, then search again: Google is used.
- [ ] Pin a page (📌 in the sidebar). New tab shows it as a tile. Clicking the tile focuses the open tab, or opens the page in this tab if it's closed.

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
