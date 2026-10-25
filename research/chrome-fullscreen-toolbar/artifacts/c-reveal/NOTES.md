# c-reveal: Chromium macOS immersive-fullscreen toolbar reveal (main, fetched 2026-10-25)

Sources are in `src/` (raw.githubusercontent.com/chromium/chromium/main). Experiments are in `exp/`.

## Two layers

1. Browser side (views): `ImmersiveModeControllerMac`. Every `GetRevealedLock()` sends
   `ImmersiveFullscreenRevealLock` over mojo, and destroying the lock sends `...RevealUnlock`.
   - src/immersive_mode_controller_mac.mm:286-292 (GetRevealedLock)
   - src/immersive_mode_controller_mac.mm:386-390 (LockDestroyed)
2. AppKit side (remote_cocoa): `ImmersiveModeControllerCocoa` keeps `reveal_lock_count_`.
   - count > 0 -> `RevealLocked()`. This calls `setVisibility:kAlways` (fullScreenMinHeight = height) and, in the tabbed variant, `TitlebarReveal()` (toolbar.visible = YES).
   - count == 0 -> `RevealUnlocked()` -> `ForceToolbarVisibilityUpdate()`, which returns to kAutohide (fullScreenMinHeight = 0, toolbar.visible = NO).
   - src/immersive_mode_controller_cocoa.mm:514-562 and 96-111
   - src/immersive_mode_tabbed_controller_cocoa.mm:225-274
   - "Revealed" = fullScreenMinHeight > 0 || revealAmount > 0. The second term is AppKit's own reveal when the mouse is at the top edge (src/immersive_mode_controller_cocoa.mm:564-571).

## Everything that reveals or holds the toolbar

| Source | Kind | Released when | Cite |
|---|---|---|---|
| Focus inside top chrome: the top_container (omnibox, toolbar) or the tab_overlay_view (tab strip). `OnDidChangeFocus` takes `focus_lock_`. | lock, held indefinitely | Views focus moves to anything outside top chrome (web contents), or to null | immersive_mode_controller_mac.mm:347-358. The listener is on the browser widget's FocusManager (:183). The overlay widgets are `child=true`, so they share that FocusManager (immersive_mode_overlay_views_mac.mm:27-34). |
| Active-tab change: `RevealTopContainerIfNeeded()` | timed lock, 1 s | PostDelayedTask after 1 s. Skipped when vertical tabs are on. | browser_view.cc:2069-2071 (called from OnActiveTabChanged); browser_view.cc:4467-4491 (kDefaultDelay = 1 s) |
| `OmniboxViewViews::SetFocus` / `BrowserView::FocusToolbar` | scoped temporary lock | End of the call. The focus lock then takes over if focus landed. | omnibox_view_views.cc:522-540; browser_view.cc:2428-2439 |
| App menu open | lock | Menu closes | browser_view.cc:3229-3232 |
| Tab drag | lock | Drag ends | browser_tab_strip_controller.cc:473-487 |
| Download bubble | lock | Bubble closes | download_toolbar_ui_controller.cc:638-645 |
| Any child NSWindow of the overlay or tab-overlay window: find bar, bubbles anchored in top chrome, omnibox popup, tab-modal/constrained dialogs (e.g. alert()), glic, tab hover cards. These are reparented by ShouldMoveChild. | lock per child window | Child window removed | immersive_mode_controller_cocoa.mm:481-512; immersive_mode_controller_mac.mm:430-485; immersive_mode_tabbed_controller_cocoa.mm:142 |
| Mouse at the top edge | AppKit revealAmount | Mouse leaves the area (AppKit-internal, not in Chromium) | immersive_mode_controller_cocoa.mm:564-571 |
| Entering fullscreen | initial `OnImmersiveModeToolbarRevealChanged(true)` | Cocoa reports the real state after the transition | immersive_mode_controller_mac.mm:167-170; immersive_mode_controller_cocoa.mm:299-316 |

- Not found: no reveal on tab insert or close as such. `BrowserView::OnTabStripModelChanged` takes no lock (browser_view.cc:3573-3620). The NTP has no special case. The only tab-strip reveal is the 1 s lock on active-tab change.
- Not checked (could not run code search): other `GetRevealedLock` callers outside the files read here, for example extension popups or permission prompts. Any bubble anchored in top chrome is covered by the child-window row above anyway.

## What happens on ⌘T, then Margin's hand-off

1. `chrome::NewTab` activates the NTP. `OnActiveTabChanged(prev -> NTP)`:
   - `prev->StoreFocus()` saves the focused view, which is the web contents if the user was in the page (browser_view.cc:2000-2005; focus_helper.cc:97-123).
   - The 1 s lock is taken (2069-2071).
   - `NTP->RestoreFocus()` finds nothing stored, so it falls back to `SetInitialFocus()`. That calls `FocusLocationBarByDefault()`, which is true because the overridden NTP's virtual URL is chrome://newtab (web_contents_view_mac.mm:306-331; browser_web_contents_delegate.cc:923-960).
   - The omnibox gets focus, so `focus_lock_` is held. **The toolbar is revealed before any extension code runs.** An extension cannot prevent this flash.
2. Margin's `tabs.update(prev, {active:true})` runs `OnActiveTabChanged(NTP -> prev)`:
   - `ClearFocus()` (browser_view.cc:2040-2048) fires OnDidChangeFocus(null), which releases `focus_lock_`.
   - A new 1 s lock is taken.
   - `prev->RestoreFocus()` focuses the web contents (2125-2136). On Mac this happens only if the widget is key (2016-2031; kMacActivateWidgetOnFocusRequest is enabled by default, views_features.cc:67-68). In immersive mode the browser NSWindow is kept key even when the toolbar window would become key (browser_native_widget_window_mac.mm:191-199).
   - Expected result: nothing still holds the toolbar. It hides about 1 s after the switch (plus AppKit animation).
   - Chromium's own test asserts exactly this. It switches from the NTP (revealed) back to a web tab, and IsRevealed() becomes false within 3 s (immersive_mode_controller_mac_interactive_uitest.mm:682-719; vertical tabs, so no 1 s lock).
3. `tabs.remove(NTP)` closes an inactive tab. It causes no reveal.

## The path that does hold it indefinitely

When the hand-off bails, Margin opens the palette on the chrome://newtab tab itself (`{openPalette:true}`, extension/background.js:300-307).

- This happens for **⌘N** every time: a new window has no web tab.
- It happens for ⌘T when the previous tab has no live Margin content script. Example: tabs that were open before the unpacked extension was installed, updated or reloaded. background.js has no executeScript or onInstalled injection, so the ping fails.
- In this state the omnibox keeps views focus, so `focus_lock_` stays held. Page JS `input.focus()` cannot take focus from the omnibox. Typed keys go to the omnibox, not the palette.
- Clicking the palette moves views focus to the web contents, which releases `focus_lock_`, and the toolbar hides.
- **This matches the report exactly: the toolbar stays until he clicks into the palette input.**

### Measured (Linux proxy for the views focus logic)

Setup: headed Chromium 153 on a private Xvfb :117 with no WM, real Ctrl+T via xdotool (IDC_NEW_TAB), Margin build loaded. Keys typed with xdotool. `document.hasFocus()` is useless under Playwright because it emulates focus (it reported true everywhere).

- exp/results-1.txt, hand-off (web page, then Ctrl+T): the palette opens over page1 and typed "ab" reaches page1. Focus left the omnibox.
- exp/results-1.txt, NTP path (no web tab): typed "ab" does not reach the NTP page.
- exp/results-3.txt: pressing Enter afterwards searched google.com?q=ab. **The keys were in the omnibox.**
- exp/results-2.txt, NTP path with each candidate release action:

| Action | Typed keys reach the page? |
|---|---|
| `chrome.windows.update({focused:true})` | no |
| `tabs.update(sameTab, {active:true})` | no |
| Bounce: activate another tab and back (stored focus is the omnibox, so it is restored) | no |
| `tabs.update(ntp, {url: <explicit chrome-extension://…/newtab.html>})` (FROM_API navigation: FocusTabAfterNavigationHelper does not steal omnibox focus) | no |
| `tabs.reload` | no |
| Page `window.focus()` | no |
| **`tabs.create({url: chrome.runtime.getURL('newtab/newtab.html#launcher'), index: ntp.index+1, active:true})` + `tabs.remove(ntp)`** | **yes** (typed "cd" landed in the page's input) |

The working action succeeds because the explicit chrome-extension:// URL is not chrome://newtab, so `ShouldFocusLocationBarByDefault` returns false and the page is focused instead of the omnibox. Margin's existing `openLauncher` (background.js:288-290) already opens this URL.

## Answer

- **After a successful hand-off:** nothing should still hold the toolbar. `focus_lock_` is released when the restored focus goes to the web contents. Only the 1 s `RevealTopContainerIfNeeded` lock remains (twice: once from ⌘T, once from the switch). Mouse hover can still reveal it.
- **On the palette-on-NTP path (all ⌘N, and ⌘T when the ping fails):** `focus_lock_` holds it, because the omnibox keeps views focus.
- **Extension-side release:** move views focus out of top chrome. Replace the chrome://newtab tab with an explicitly-URL'd extension tab (tabs.create + tabs.remove). Clicking into the page also releases it.
  - No API releases it while the tab stays chrome://newtab: windows.update, reactivate, bounce, URL update, reload and window.focus all failed in the measurements above.
- **What cannot be avoided:** the initial flash on ⌘T or ⌘N. The NTP activation and omnibox focus reveal the toolbar before the extension runs.

## Unverified

- **Mac-only differences.** No Mac was available. One possibility is that AppKit keeps the titlebar shown after fullScreenMinHeight returns to 0 until the mouse moves.
- **Which path Tirth's ⌘T took.** His service-worker console line `[margin] new tab … : palette on the new-tab page (…)` would tell.
- **Whether ⌘N opens the new window in immersive fullscreen.**
