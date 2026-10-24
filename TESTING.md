# Testing Margin

## Automated (cloud / any machine with Node 22)

```sh
npm test            # unit tests: node --test tests/*.test.js
npm run test:e2e    # Playwright, headless Chromium, loads extension/ unpacked
```

Everything below this line is **manual, in Safari on macOS**. The automated tests only prove the extension works in Chromium.

## Safari behaviors to confirm first

| # | Check | How to tell | If false |
|---|-------|-------------|----------|
| 0 | The background service worker loads as an ES module (`"type": "module"`) | Develop → Web Extension Background Content → Margin shows no errors, and the console shows `[margin] installed` | See DECISIONS.md M1 |
| 2 | `tab.favIconUrl` is populated | Sidebar rows show site favicons, not only colored letters | Letter avatars are the built-in fallback; nothing to do |
| 5 | Background unload and wake | Leave Safari idle for 5+ minutes, then hover the left edge on an already-open page and click a tab | If clicks do nothing, the worker didn't wake on `sendMessage`. Note it in DECISIONS.md |
| 6 | Sidebar CSS loads inside the shadow root on a strict-CSP site (e.g. github.com) | The sidebar is styled, not raw HTML | See DECISIONS.md M2 (constructable stylesheet, `<style>` fallback) |

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
