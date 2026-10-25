# Chrome full screen: toolbar stays after ⌘T/⌘N

Investigation of why Chrome on macOS (full screen, toolbar auto-hidden) keeps showing its tab strip and address bar after ⌘T/⌘N with Margin, until the user clicks into Margin's palette. Measured on Linux Chrome 153 with the real Margin build and real key presses; the Mac part is from Chromium source and must be confirmed on a Mac. Nothing here is built into Margin yet.

## Cause

The toolbar stays because Chrome's address bar (omnibox) still has keyboard focus. The hiding logic itself works.

1. **Chrome holds the toolbar open while it has focus.** In Mac immersive full screen, ImmersiveModeControllerMac::OnDidChangeFocus takes a reveal lock while focus is inside the toolbar or tab strip, and only releases it when focus moves somewhere else. Source: immersive_mode_controller_mac.mm:347-358 on main, and the same code at :338-349 in tag 153.0.8010.12 (I fetched it).

2. **⌘T and ⌘N always start with focus in the omnibox.** The new tab's address is still chrome://newtab even with Margin's override. It has no saved focus, so RestoreFocus falls back to SetInitialFocus, which focuses the location bar for chrome://newtab (web_contents_view_mac.mm:306-331; browser_web_contents_delegate.cc:923-960).

3. **Margin then follows one of two paths. Both can leave focus in the omnibox.**
   - **Palette on the new-tab page** (background.js:300-307 returns openPalette). This happens on every ⌘N, and on ⌘T when the ping to the previous tab fails. A failed ping is typical for tabs that were open before the unpacked extension was reloaded or updated, because Chrome does not re-inject content scripts into them (standard Chrome behavior, not measured here). On this path the page's input.focus() cannot take focus from the omnibox. Measured on Linux Chrome 153 with the real dist/chrome build and real xdotool keys: typed "qzx" landed in the omnibox (c-focus/out/margin-ctrl-n-2-typed.png). I re-ran it in c-verify with the same result.
   - **Hand-off to the previous tab** (focusTab, then tabs.remove, then show-palette). Chrome restores that tab's saved focus (browser_view.cc:2000-2005 and 2125-2136; focus_helper.cc:97-147).
     - If the page had focus, the omnibox lock is released. Measured: margin-ctrl-t, keys reached the palette.
     - If the omnibox had focus before ⌘T (for example after ⌘L), the omnibox gets focus back and the toolbar stays. Measured: margin-ctrl-t-omnibox-first, no page keydowns, toolbar band changed.

4. **Every tab switch also reveals the toolbar for 1 second**, independently of focus (BrowserView::RevealTopContainerIfNeeded: browser_view.cc:2069-2071 and 4467-4491 on main; 2021 and 4400-4423 at tag 153). It is skipped when Chrome's vertical tabs are on. This is the short flash, not the toolbar staying.

Clicking into the palette moves focus into the page, which releases the lock. That matches Tirth's "stays until I click".

## Workaround

Make sure keyboard focus ends up in a Margin page that Chrome does not treat as a new-tab page. Never leave the palette on the chrome://newtab document.

**A. Palette-on-new-tab-page path (⌘N, and ⌘T when the ping fails):**
- The new-tab page navigates itself with location.replace(chrome.runtime.getURL('newtab/newtab.html?palette')).
- The palette opens on that page.
- A navigation the page starts itself, away from the new-tab page, moves focus into the page.
- Measured on the real Margin build: marginfix-ctrl-n (c-focus), and fix2-ctrl-n (my run). The page reported hasFocus=true and "qzx" went into Margin's palette. The toolbar band was unchanged by typing.

**B. Hand-off path:**
- Keep the hand-off, but the content script reports document.hasFocus() about 150 ms after opening the palette.
- If it reports false, Chrome restored focus to the address bar. The background then closes that palette and opens tabs.create({url: newtab.html?palette, index: prev.index+1, active: true}). A tab created with an explicit chrome-extension:// URL is not a new-tab page, so SetInitialFocus focuses the page.
- Measured on the real build:
  - fix2-ctrl-t-omnibox-first: samples at 0/50/150/500 ms were all false, the fallback fired, and "qzx" landed in the new tab's palette.
  - fix2-ctrl-t: samples were all true, there was no fallback, and the keys reached the palette over page A.

**Do not use these.** Each was measured to leave focus in the omnibox:
- tabs.update(ntp, {url}) (an extension-API navigation; tabs_api.cc:1710-1712)
- windows.update({focused: true})
- window.focus() in either page
- re-activating the tab, or switching to another tab and back
- tabs.reload
- a hash-only change, or location.replace to the same URL

**Optional, lower priority:** inject content scripts into open tabs on onInstalled or onStartup, so ⌘T hands off more often. This first needs stale-host cleanup, because sidebar.js:7 returns early when an orphaned margin-sidebar-host is still in the page.

**User-side option:** Chrome's vertical tab strip removes the 1-second tab-switch reveal (browser_view.cc:4477-4481). It is not measured, and it conflicts with Margin's own sidebar.

## Code change (proposed, not applied)

A full scratch copy with this change is at artifacts/c-verify/margin-ext-fix2. It also contains test-only probes (fetches to 127.0.0.1:8794), which must not go into the repo. Run `diff -ru c-verify/margin-ext c-verify/margin-ext-fix2` to see it.

**1. extension/newtab/newtab.js, the ⌘T/⌘N block at the end (currently lines 236-239).**

Replace

```js
if (fresh) { send('newTabPage').then((res) => res?.openPalette && palette.open()); }
```

with

```js
// Chrome focuses the address bar on chrome://newtab, and in macOS full screen it keeps
// the toolbar shown while the address bar has focus. A navigation this page starts
// itself, to a different URL, moves focus into the page.
const paletteHop = new URLSearchParams(location.search).has('palette');
if (paletteHop) palette.open();
else if (fresh) {
  send('newTabPage').then((res) => {
    if (!res?.openPalette) return;
    if (Margin.platform?.name === 'chrome') location.replace(api.runtime.getURL('newtab/newtab.html?palette'));
    else palette.open(); // Safari unchanged
  });
}
```

The paletteHop check must come before `fresh`. The ?palette document also has history.length 1 and navigation type 'navigate', so without that order it would send newTabPage again and loop.

**2. extension/content/sidebar.js, the runtime.onMessage listener (around line 631).**

Add this before the 'toggle-sidebar' line:

```js
if (message.command === 'show-palette') {
  Margin.content.onCommand?.('show-palette');
  setTimeout(() => sendResponse({ focused: document.hasFocus() }), 150);
  return true;
}
```

**3. extension/content/palette.js, c.onCommand (lines 213-216).**

Add:

```js
if (command === 'hide-palette') palette.close();
```

**4. extension/background.js, handlers.newTabPage (lines 309-313).**

Keep the order: `await focusTab(prev.id)`, then `await api.tabs.remove(tab.id)`, then show-palette. Replace the last sendMessage with:

```js
const shown = await api.tabs.sendMessage(prev.id, { type: 'command', command: 'show-palette' }).catch(() => null);
if (shown?.focused === false && globalThis.Margin.platform?.name === 'chrome') {
  log('palette in a new tab', `tab ${prev.id} came back with the address bar focused`);
  await api.tabs.sendMessage(prev.id, { type: 'command', command: 'hide-palette' }).catch(() => {});
  const t = await api.tabs.get(prev.id);
  await api.tabs.create({ windowId: t.windowId, index: t.index + 1, active: true, url: api.runtime.getURL('newtab/newtab.html?palette') });
}
return { handled: true };
```

**5. Build, tests and DECISIONS.md.**
- Run `npm run build`, `npm test` and `npm run test:e2e`.
- The ⌘N E2E test (tests/e2e/newtab-palette.test.js) should still pass, because location.replace keeps the same Playwright page. It may need `nt.waitForURL(/newtab\.html\?palette/)` first.
- Headless Playwright cannot test focus. It turns on focus emulation, so document.hasFocus() is always true (playwright-core coreBundle.js:37638), and the fallback never fires in E2E.
- Record in DECISIONS.md: the cause, the measured Linux results, that the Mac result is unverified, and that Safari is unchanged.

## Cannot be fixed by an extension

- The short toolbar flash on every ⌘T or ⌘N. Activating the new tab takes a 1-second timed reveal lock, and omnibox focus reveals it too, before any extension code runs. Expected on Mac (from source, not measured): about 1 s after a direct palette, about 1.1 s after the hand-off (two tab switches), and about 1.6 s with the address-bar fallback (three switches). Extensions cannot intercept ⌘T or ⌘N.
- Keys typed in the first ~100-250 ms after ⌘T or ⌘N go to the omnibox, before the hop or hand-off completes. Measured timelines: fix2-ctrl-n palette page loaded 223 ms after Ctrl+N; fix2-ctrl-t page refocused 112 ms after Ctrl+T.
- The toolbar still appears when the mouse is at the top edge. macOS controls this through AppKit's revealAmount (immersive_mode_controller_cocoa.mm:564-571).
- When the toolbar is revealed, or outside full screen, the address bar shows chrome-extension://…/newtab/newtab.html?palette instead of being blank. Only the overridden chrome://newtab address is shown blank, and that is exactly the address that gives the omnibox focus.
- No extension API moves focus from the omnibox into a tab that already exists. When Chrome restores the address bar in the previous tab, the only fix is a new tab, which means one extra tab switch and a brief flicker of the palette over the old page.
- ⌘N opens a separate window. If macOS opens it outside full screen (not verified), its toolbar is permanently visible because it is a normal window, and Margin cannot change that.
- The hop (location.replace) depends on undocumented Chrome behavior. The source I read does not fully explain it: FocusTabAfterNavigationHelper's started-at-NTP check should be false for a chrome-extension:// address (search.cc:263-273), yet focus moves, measured twice on Chrome 153. A future Chrome could change it. The tabs.create fallback is fully explained by browser_web_contents_delegate.cc:923-960.

## Checks on the Mac

- Before changing anything, open chrome://extensions → Margin → service worker console. Press ⌘T, then ⌘N, in full screen and copy the `[margin] new tab …: <decision> (<why>)` lines (background.js:300). 'palette on the new-tab page (previous tab … has no Margin script)' means the ⌘T ping failed, for example because tabs were open from before the last extension reload. 'palette over tab …' means the hand-off ran.
- Press ⌘T in full screen and type one letter after about half a second. Does it appear in Margin's palette or in Chrome's address bar? The address bar means focus is the problem, which is what Linux shows.
- Run the ⌘T test twice: once after clicking into the page, and once after pressing ⌘L first. Linux predicts the toolbar hides in about 1 s in the first case and stays in the second.
- Press ⌘N in a full-screen window. Does the new window open in full screen (its own Space) or as a normal window? A normal window always shows its toolbar.
- Confirm View → 'Always Show Toolbar in Full Screen' is off. Note whether Chrome's vertical tabs are on, since that removes the 1-second tab-switch reveal.
- With the fix built and the extension reloaded, test four cases with the mouse away from the top edge: ⌘N; ⌘T after clicking into a page; ⌘T after ⌘L; and ⌘T in a tab that was open before the reload. In each, the toolbar should hide by itself within about 1-2 s, with no click, and typing should go into the palette.
- In the service-worker console, 'palette in a new tab (… address bar focused)' should appear only in the ⌘L case. If it appears on every ⌘T, then document.hasFocus() does not work as a signal on macOS (it was only measured on Linux), and the 150 ms delay or the check needs revisiting.
- After the hop, check that the new tab shows the palette, that Esc leaves the launcher, and that Margin's sidebar lists the tab once. The address bar will show chrome-extension://…/newtab.html?palette when the toolbar is revealed; that is expected.

## Claims refuted during verification

- Focus report, marked uncertain: on Mac, NSToolbarFullScreenWindow could become key, so Chrome would skip RestoreFocus and the omnibox would keep focus. The source contradicts this. browser_native_widget_window_mac.mm:191-199 calls makeKeyAndOrderFront on the browser window whenever its NSToolbarFullScreenWindow becomes key. The overlay widget is created with Activatable::kNo (immersive_mode_overlay_views_mac.mm:27-34), so GetWidget()->IsActive() should stay true (browser_view.cc:2017-2031). This is from source only, not measured on a Mac.
- Reveal report, open question: AppKit might keep the toolbar shown until the mouse moves, even after the locks are released. Largely answered. On Mac, IsRevealed() reflects AppKit's state (immersive_mode_controller_mac.mm:277-278 and 487-492; cocoa IsToolbarRevealed at 564-571). Chromium's Mac interactive test RevealOnTabChangeWithVerticalTabs expects it to become false within 3 s after switching from the new-tab page to a web tab, with no mouse move (immersive_mode_controller_mac_interactive_uitest.mm:682-719). This is a bot test, not Tirth's machine.
- The idea that the existing ⌘T hand-off is always enough. Refuted: when the previous tab had omnibox focus, Chrome restores the omnibox (margin-ctrl-t-omnibox-first, re-run in c-verify: no page keys, toolbar band changed by 6700 px).
- That windows.update({focused:true}), window.focus() in either page, re-activating the tab, switching to another tab and back, tabs.reload, tabs.update(ntp,{url}), a hash change, or location.replace to the same URL can release the omnibox. All were measured to fail in at least one case (c-focus summary.jsonl, c-reveal results-2.txt). tabs.update is marked FROM_API so focus stays (tabs_api.cc:1710-1712).
- The focus report's explanation of why the hop works (FocusTabAfterNavigationHelper treating the extension's new-tab page as the NTP) is not supported by the source. search.cc:140-148 and 263-273 would not match a chrome-extension:// address. The behavior itself is reproducible (re-run), but the mechanism is unexplained.
- Injecting content scripts on install as a simple fix for failed pings. sidebar.js:7 returns early if an orphaned margin-sidebar-host is still in the page, so a re-injected script would not register its ping listener without extra cleanup.
- Adding, closing or switching to a new-tab page reveals the toolbar on its own: not true. Only an active-tab change (the 1 s timed lock) and focus in the top chrome do. Confirmed in browser_view.cc on main and at tag 153.

## Confidence

**High: the cause is omnibox focus holding Chrome's full-screen reveal lock.**
- Source agrees at Chromium main and at tag 153.0.8010.12.
- Two independent Linux setups measured the omnibox keeping focus.
- I re-ran margin-ctrl-t, margin-ctrl-t-omnibox-first, margin-ctrl-n, marginfix-ctrl-n and the two mini omnibox-first variants on my own display with identical results.
- Chromium's own Mac test confirms that a new-tab page reveals the toolbar and that switching to a web tab hides it.

**High for Chrome 153: the proposed change puts keyboard focus in Margin's palette in all three cases** (⌘N; ⌘T with the page focused; ⌘T after ⌘L). Measured on the real Margin Chrome build, Linux, xdotool keys, no Playwright:
- artifacts/c-verify/out/fix2-ctrl-n.jsonl
- artifacts/c-verify/out/fix2-ctrl-t.jsonl
- artifacts/c-verify/out/fix2-ctrl-t-omnibox-first.jsonl
- artifacts/c-verify/out/fix2-ctrl-t-omnibox-first-2-typed.png

**Medium: that the toolbar then hides on Tirth's Mac within about 1-2 s.** This is inferred from Mac source and Chromium's Mac test only. Linux has no immersive mode, so only his Mac can confirm it.

**Unknown: which path his ⌘T took.** His service-worker log line will show it.

The repo is unchanged (git status is clean). The Xvfb I started on :94 has been stopped.

The user's relayed message "why did you stop it" is not answered by this verification step. Nothing in this step shows what was stopped. The c-focus notes mention files from an earlier run at 09:50 UTC, possibly a stopped attempt. The orchestrator must answer the user directly.

## Raw investigation reports

### Reveal logic

The toolbar stays revealed because the omnibox still has keyboard focus. Chromium's Mac full-screen controller holds the toolbar open for as long as focus is inside the toolbar or tab strip (ImmersiveModeControllerMac::OnDidChangeFocus, immersive_mode_controller_mac.mm:347-358). Clicking into the page moves focus out, which is why it hides when Tirth clicks the palette input.

Every reveal source in current Chromium main:
- focus inside the toolbar or tab strip (held indefinitely);
- a 1-second timed lock on every active-tab change, skipped with vertical tabs (browser_view.cc:2069-2071, 4467-4491);
- temporary locks while focusing the omnibox or toolbar;
- the app menu, tab drags and the download bubble;
- any child window of the overlay (find bar, bubbles anchored in the toolbar, omnibox popup, page dialogs such as alert(), tab hover cards);
- the mouse at the top edge (handled by macOS, not Chromium).

Adding, closing or switching to a new-tab page reveals nothing on its own. The only tab-strip reveal is the 1-second lock on a tab switch.

**Successful hand-off (⌘T over a web tab):** when Margin switches back to the previous tab, Chrome clears focus and restores the page's saved focus, which is the page itself. That releases the focus lock, so only the 1-second timer is left and the toolbar should hide about a second later. Chromium's own Mac test checks exactly this (immersive_mode_controller_mac_interactive_uitest.mm:682-719). On Linux, with a real Ctrl+T, the keys I typed afterwards reached the page.

**Palette-on-new-tab-page path:** this is what Tirth's report matches. Margin opens the palette on the chrome://newtab tab itself when:
- he presses ⌘N (a new window has no web tab), or
- he presses ⌘T but the previous tab has no live Margin script (background.js:306-307). This happens for tabs open before the extension was installed, updated or reloaded, because Margin never injects into them.

In that state the omnibox keeps focus, so the toolbar stays until a click. On Linux I measured that typed keys went to the omnibox: pressing Enter ran a Google search for them.

**Workaround:** replace the chrome://newtab tab with a tab that has the extension's own URL. `tabs.create({url: chrome.runtime.getURL('newtab/newtab.html#launcher'), index: ntp.index + 1, active: true})` followed by `tabs.remove(ntp.id)` was the only action that moved focus into the page. Margin's existing launcher path already opens this URL. These did not work: windows.update, re-activating the same tab, switching to another tab and back, changing the URL in place, reload, and window.focus().

The toolbar will still flash on every ⌘T or ⌘N, because the new tab and the omnibox focus reveal it before any extension code runs.

Notes are in artifacts/c-reveal/NOTES.md.

- *verified*: Focus inside the toolbar or tab strip holds the toolbar revealed indefinitely. When the focused view is inside top_container (omnibox, toolbar) or tab_overlay_view (tab strip), OnDidChangeFocus takes a reveal lock (focus_lock_). Moving focus anywhere else, including to null, releases it. No timeout applies.  
  Evidence: src/immersive_mode_controller_mac.mm:347-358. The listener is registered on the browser widget's FocusManager at :183. The overlay widgets are child=true, so they share that FocusManager (src/immersive_mode_overlay_views_mac.mm:27-34). Locks are sent to AppKit at :286-292 and released at :386-390.
- *verified*: On the Cocoa side, any lock count above zero forces the toolbar visible. When the count returns to zero it goes back to autohide. Separately, the mouse at the top edge reveals it through AppKit's revealAmount, which Chromium does not control.  
  Evidence: src/immersive_mode_controller_cocoa.mm:514-562 (lock count, RevealLocked/RevealUnlocked), 96-111 (setVisibility), 564-571 (IsToolbarRevealed = fullScreenMinHeight > 0 || revealAmount > 0). Tabbed variant: src/immersive_mode_tabbed_controller_cocoa.mm:225-274.
- *verified*: Every active-tab change reveals the toolbar for 1 second with horizontal tabs, through a timed lock. Inserting or closing a tab, or opening a new-tab page, takes no lock of its own.  
  Evidence: src/browser_view.cc:2069-2071 (called from OnActiveTabChanged) and 4467-4491 (kDefaultDelay = base::Seconds(1); skipped for vertical tabs). BrowserView::OnTabStripModelChanged (3573-3620) takes no lock.
- *likely*: Other reveal sources: temporary locks while focusing the omnibox or toolbar, the app menu, tab drags, the download bubble, and every child window of the overlay or tab-overlay window. That includes the find bar, bubbles anchored in the toolbar, the omnibox popup, page dialogs such as alert(), glic and tab hover cards.  
  Evidence: omnibox_view_views.cc:522-540; browser_view.cc:2428-2439 and 3229-3232; browser_tab_strip_controller.cc:473-487; download_toolbar_ui_controller.cc:638-645; immersive_mode_controller_cocoa.mm:481-512; immersive_mode_controller_mac.mm:430-485 (ShouldMoveChild); immersive_mode_tabbed_controller_cocoa.mm:142. Callers in files I did not read (extension popups, permission prompts) are unchecked because GitHub code search was unavailable.
- *verified*: On ⌘T the toolbar is revealed before any extension code runs. Activating the new tab takes the 1-second lock. The new-tab page then has no saved focus, so Chrome falls back to the omnibox, because the overridden page's address is still chrome://newtab. Omnibox focus takes the focus lock.  
  Evidence: browser_view.cc:2000-2005, 2069-2071, 2125-2136; web_contents_view_mac.mm:306-331 (RestoreFocus falls back to SetInitialFocus); browser_web_contents_delegate.cc:923-960 (ShouldFocusLocationBarByDefault is true for a chrome://newtab virtual URL).
- *likely*: After a successful hand-off (Margin activates the previous web tab, then closes the new-tab page), nothing should keep the toolbar revealed except the 1-second timer and the mouse. The tab switch clears focus, releasing the focus lock, then restores the page's saved focus to the page itself.  
  Evidence: browser_view.cc:2040-2048 (ClearFocus), 2125-2136 (RestoreFocus); focus_helper.cc:97-147. Restoring requires the window to be key (2016-2031; kMacActivateWidgetOnFocusRequest is on by default, views_features.cc:67-68), and Chrome keeps the browser window key in immersive mode (browser_native_widget_window_mac.mm:191-199). Chromium's test RevealOnTabChangeWithVerticalTabs expects the toolbar hidden within 3 s after switching from the new-tab page to a web tab (immersive_mode_controller_mac_interactive_uitest.mm:682-719). Measured on Linux with a real Ctrl+T (exp/results-1.txt): the palette opened over page1 and the typed "ab" reached page1.
- *likely*: When Margin opens the palette on the new-tab page itself, the omnibox keeps focus, so the toolbar stays until a click moves focus into the page. This happens on every ⌘N, and on ⌘T when the previous tab's Margin script does not answer. It matches Tirth's report.  
  Evidence: extension/background.js:300-307 returns openPalette when there is no web tab or the ping fails. Measured on Linux (exp/results-1.txt, exp/results-3.txt): the typed "ab" did not reach the new-tab page, and pressing Enter navigated to google.com/search?q=ab, so the keys were in the omnibox. palette.js input.focus() cannot take focus from the omnibox.
- *likely*: While the tab is still chrome://newtab, no extension call moves focus out of the omnibox. These failed: windows.update({focused:true}), re-activating the same tab, switching to another tab and back (the omnibox is the saved focus and gets restored), tabs.update to the explicit extension URL, tabs.reload, and window.focus().  
  Evidence: exp/results-2.txt: typed "cd" never reached the page for windows-update, reactivate, bounce, navigate, reload or focus-js. For URL updates, focus_tab_after_navigation_helper.cc skips navigations started by the extension API (PAGE_TRANSITION_FROM_API).
- *likely*: What does release it: replace the new-tab page with a tab opened at the extension's own URL. tabs.create({url: chrome.runtime.getURL('newtab/newtab.html#launcher'), index: ntp.index + 1, active: true}) followed by tabs.remove(ntp.id) puts keyboard focus in the page. With focus out of the omnibox, the focus lock should release on Mac too, leaving only the 1-second tab-switch timer.  
  Evidence: exp/results-2.txt 'recreate': typed "cd" landed in the page's INPUT. The explicit URL is not chrome://newtab, so ShouldFocusLocationBarByDefault returns false (browser_web_contents_delegate.cc:923-960). Margin's openLauncher (background.js:288-290) already opens this URL. The Mac effect is inferred from immersive_mode_controller_mac.mm:347-358, not measured.
- *likely*: The initial flash on ⌘T or ⌘N cannot be avoided from the extension. The new tab and the omnibox focus reveal the toolbar before the new-tab override page runs.  
  Evidence: Ordering from browser_view.cc:1990-2136 plus immersive_mode_controller_mac.mm:347-358. Extensions cannot intercept ⌘T or ⌘N.

### Focus hand-off

On Chromium 153 (Linux, real browser window, real keypresses via xdotool, no Playwright), I found two things. First, where focus lands after Margin's ⌘T hand-off depends only on what had focus in the previous tab when the new tab opened. If the page had focus, Chrome gives it back: Margin's real build received the typed text in its palette and the toolbar did not change. If the address bar had focus (Ctrl+L, then Ctrl+T), Chrome gives focus back to the address bar. The palette is drawn but keys go to the omnibox, and no ordering, chrome.windows.update or window.focus() call changes that. Second, Margin's ⌘N path, which opens the palette on the new-tab page itself, always leaves focus in the omnibox (measured). That matches the report: in Mac full screen, Chrome keeps the toolbar shown while focus is in the toolbar (immersive_mode_controller_mac.mm:347-357), until a click moves focus into the page. One extension-side mechanism does put focus in the page. The new-tab page navigates itself, from its own script, to a different URL (location.replace to newtab.html?focus or another extension page), or a new extension-page tab is opened with chrome.tabs.create and the new-tab page is closed. A 5-line change to a scratch copy of Margin's newtab.js fixed ⌘N in the real build. For ⌘T this means keeping the palette in the new tab rather than over the previous page. chrome.tabs.update(ntp,{url}) does NOT work: Chrome marks that navigation as API-initiated so focus stays in the omnibox (tabs_api.cc:1708-1712). Not verified on macOS: whether the ⌘T hand-off restores page focus there. Chrome also shows the toolbar for 1 s on every tab switch in Mac full screen (browser_view.cc:2070 and 4467-4489), and no focus fix removes that. Measurements used a private Xvfb on :93, not :99, because other agents' Chromium processes were running on the machine. The repo is unchanged (git status is clean).

- *verified*: Why a new tab focuses the omnibox: ⌘T calls chrome::NewTab, which adds chrome://newtab as a foreground tab. When the tab is inserted, BrowserView::OnActiveTabChanged saves the old tab's focus and calls RestoreFocus on the new one. The new tab has nothing saved, so it falls back to SetInitialFocus, which focuses the location bar when FocusLocationBarByDefault() is true. That is true when the entry's URL or virtual URL is chrome://newtab. An extension's newtab override keeps the virtual URL chrome://newtab because of the URL-override rewrite.  
  Evidence: browser_commands.cc:1370-1411 (NewTab); browser_tabstrip.cc:44-67 (AddAndReturnTabAt with GetNewTabURL, kNewForegroundTab, TYPED). browser_view.cc:1999-2004 (old_contents->StoreFocus) and 2127-2131 (new_contents->RestoreFocus). web_contents_view_aura.cc:952-971 and web_contents_view_mac.mm:306-326 (RestoreFocus falls back to SetInitialFocus, which calls SetFocusToLocationBar if FocusLocationBarByDefault). web_contents_impl.cc:8039-8047. browser_web_contents_delegate.cc:923-955 (true for chrome://newtab URL or virtual URL). extension_url_overrides.cc:457 (forward) and 480-521 (reverse, prefix StartsWith). All files are under c-focus/src, Chromium main 158.0.8124.0. Measured: the override new-tab page reported document.hasFocus()=false at load in every run (e.g. out/mini-margin.jsonl t=4089).
- *verified*: Where focus lands after Margin's hand-off (tabs.update active, then windows.update if needed, then tabs.remove): it is whatever view the previous tab had saved when ⌘T deactivated it. If that was the page, focus goes back to the page; if it was the omnibox, it goes back to the omnibox. Removing the new tab, which is not the active tab at that point, does not change focus.  
  Evidence: chrome_web_contents_view_focus_helper.cc:97-123 (StoreFocus saves the FocusManager's focused view), 125-133 (RestoreFocus calls RequestFocus on it), 139-146 (only if it is focusable and still in the focus manager). browser_view.cc:2017-2031 (will_restore_focus needs the widget visible and active, which on Mac is gated by kMacActivateWidgetOnFocusRequest, on by default per views_features.cc:67-68), and 2132-2136 / 4199-4212 (otherwise restore is deferred until the window is activated). Measured, Margin's real build: margin-ctrl-t ended with page:A hasFocus=true, active=margin-palette-host, keydowns q/z/x reached the page, and toolbar diff was 0 (out/margin-ctrl-t-2-typed.png shows 'qzx' in Margin's palette).
- *verified*: Failure mode: if the previous tab's address bar had focus before ⌘T (for example after ⌘L), Margin's hand-off returns focus to the omnibox. The palette is open and is the page's activeElement, but document.hasFocus() is false and typed keys go to the omnibox.  
  Evidence: Measured: margin-ctrl-t-omnibox-first ended with page:A hasFocus=false, active=margin-palette-host, no page keydowns, toolbar band changed by 6702 px. out/margin-ctrl-t-omnibox-first-2-typed.png shows 'qzx' in the omnibox dropdown with Margin's palette empty underneath. The mini replica behaves the same (mini-margin-omnibox-first).
- *likely*: Margin's ⌘N path, which opens the palette on the new-tab page itself (openPalette), leaves keyboard focus in the omnibox. In Mac immersive full screen, Chrome holds a toolbar reveal for as long as the focused view is inside the top container. Together these produce exactly the symptom: the toolbar stays until the user clicks into the palette.  
  Evidence: Measured: margin-ctrl-n-2-typed.png shows 'qzx' in the omnibox and Margin's palette input empty. mini-ctrl-n-ntp-focus-input shows the new-tab page with input#q as activeElement but hasFocus=false and no keydowns. Calling window.focus() in the new-tab page does not help (mini-window-focus-ntp). Source: immersive_mode_controller_mac.mm:347-357 (OnDidChangeFocus takes focus_lock_ while top_container()->Contains(focused_now) and resets it otherwise). The Mac reveal part is from source only; I did not measure it.
- *verified*: Candidates (a) chrome.tabs.update(ntpId, {url}), (b) removing the new tab before activating the previous one, and (c) chrome.windows.update(winId, {focused:true}), plus window.focus() from the content script: none of them changes the result. With page focus saved, all of them work, as the baseline does. With omnibox focus saved, all of them leave keys in the omnibox. (a) leaves the new-tab page itself without focus.  
  Evidence: Measured: mini-remove-first, mini-winfocus, mini-cs-window-focus and mini-tabsupdate-url all sent keys to page:A input#mp-input. Their *-omnibox-first versions sent no page keydowns and changed the toolbar by 6702 px. In mini-tabsupdate-url the page it navigated to (ntp2) reported hasFocus=false. Source: tabs_api.cc:1708-1712 ('Marking the navigation as initiated via an API means that the focus will stay in the omnibox', PAGE_TRANSITION_FROM_API); focus_tab_after_navigation_helper.cc:76-80.
- *verified*: Candidate (d) works: when the new-tab page navigates itself from its own script (location.replace or location.href) to a different URL, Chrome moves keyboard focus from the omnibox into the page. A palette input focused afterwards receives typing. The target can be newtab.html?x or another extension page. It works for ⌘T and ⌘N and regardless of where the previous tab's focus was. A hash-only change or a replace to the same URL does not trigger it.  
  Evidence: Measured: in mini-location-replace-stay, mini-location-href-stay, mini-location-replace-other-stay, mini-ctrl-n-location-replace-other-stay and mini-location-replace-other-stay-omnibox-first, keydowns landed in the extension page's input and the toolbar diff was 0. The old new-tab document got window-focus about 18 ms after location.replace (out/mini-location-replace-stay.jsonl t=4101 to 4119). Controls: replacing to the identical URL kept the omnibox focused (mini-location-replace-same-stay), and on an ordinary http page with the omnibox focused, location.replace did not move focus (control-http-omnibox-then-replace). Both match FocusTabAfterNavigationHelper (focus_tab_after_navigation_helper.cc:25-38, which runs at ReadyToCommit for cross-document navigations only, and 61-91, which covers renderer-initiated navigations started at the NTP, not FROM_API, to a URL other than the rewritten NTP URL).
- *verified*: Candidate (e) works: opening a new tab with chrome.tabs.create({url: extension page, active:true}) and closing the original new-tab page gives keyboard focus to the created page. Chrome does not treat that tab as a new-tab page, so SetInitialFocus focuses the contents. This holds even for newtab.html?x URLs created this way; the omnibox then shows the chrome-extension:// URL instead of being blank.  
  Evidence: Measured: mini-create-ext-tab, mini-create-ext-tab-omnibox-first, mini-ctrl-n-create-ext-tab and mini-create-ext-tab-ntpprefix all ended with hasFocus=true in the created tab, keydowns q/z/x reaching it, and toolbar diff 0. out/toolbar-compare.png shows the omnibox displaying the chrome-extension URL after both the hop and the create.
- *likely*: No extension API I tested moves keyboard focus out of the omnibox into the page of a tab that already exists. Chrome restores that tab's saved view as-is. Keeping the palette over the live previous page therefore cannot be made reliable whenever that tab last had omnibox focus.  
  Evidence: Measured, all *-omnibox-first variants: remove-first, winfocus, cs-window-focus, and location-replace followed by the hand-off. All failed, while in the same runs the new tab or created tab received focus. Source: focus_helper.cc:125-146 restores the saved view as-is. I did not test every extension API.
- *likely*: Even with focus in the page, every change of active tab in Mac immersive full screen reveals the toolbar for 1 s. Margin's hand-off causes two such changes (the ⌘T insertion and the switch back). Keeping the palette in the new tab (d or e) causes one, the insertion, and the extension cannot avoid that one. The exception is when Chrome's own vertical tab strip is shown: then tab changes do not reveal the toolbar.  
  Evidence: browser_view.cc:2069-2071 (OnActiveTabChanged calls RevealTopContainerIfNeeded) and 4467-4489 (takes a reveal lock and releases it after kDefaultDelay of 1 s; returns early when ShouldDisplayVerticalTabs(), lines 4477-4481). Source only; I could not measure this because Linux full screen has no immersive mode.
- *uncertain*: Possible Mac-only reason the ⌘T hand-off might fail even when the page had focus (UNVERIFIED). On Mac, BrowserView restores the saved focus only if the browser widget is active (key window). In immersive full screen the toolbar is hosted in AppKit's NSToolbarFullScreenWindow. If the omnibox focus on the new-tab page makes that window key instead of the browser window, Chrome skips RestoreFocus and the omnibox keeps focus. The source also says that window shares the browser window's first responder, so this may not happen.  
  Evidence: browser_view.cc:2020-2028 (Mac: will_restore_focus &= GetWidget()->IsActive()); native_widget_mac.mm:834-836 (IsActive is IsWindowKey); immersive_mode_controller_cocoa.mm:240-245 ('allow the NSToolbarFullScreenWindow to become key when interacting with top chrome'); native_widget_mac_nswindow.mm:949-953 ('NSToolbarFullScreenWindow is a child window that shares this window's first responder'). Not measurable on Linux.
- *verified*: Playwright cannot be used to measure page focus: it enables CDP focus emulation on every page, so document.hasFocus() always returns true. That is why the harness launches Chrome directly and drives it with xdotool.  
  Evidence: /opt/node-tools/node_modules/playwright-core/lib/coreBundle.js:37638: Emulation.setFocusEmulationEnabled {enabled:true} for every main frame unless noDefaults.
- *verified*: The focus-hop change was demonstrated on Margin's real Chrome build (in a scratch copy). After ⌘N, typing went into Margin's palette and the omnibox was not touched.  
  Evidence: c-focus/margin-ext-fix/newtab/newtab.js: if the URL has ?focus, call palette.open(); otherwise, on a fresh page with openPalette, call location.replace(api.runtime.getURL('newtab/newtab.html?focus')). Result for marginfix-ctrl-n: toolbar band diff 0, and out/marginfix-ctrl-n-2-typed.png shows 'qzx' in Margin's palette with the omnibox showing chrome-extension://…/newtab.html?focus, unfocused.
