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
