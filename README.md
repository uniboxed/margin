# Margin

An Arc-style sidebar for Safari, built as a Safari Web Extension (prototype).

## Building for Safari (local, macOS)

The Xcode project is generated locally and not committed (`xcode/` is git-ignored). From the repo root:

```sh
xcrun safari-web-extension-converter extension --project-location xcode --app-name Margin --bundle-identifier io.tirth.margin --macos-only --swift --no-open
```

Then open `xcode/Margin/Margin.xcodeproj`, choose the **Margin (macOS)** scheme, and Run. Setup steps in Safari are in [TESTING.md](TESTING.md).

**After pulling new changes:** the converter references the files in `extension/` rather than copying them, so for edits to existing files just Run again in Xcode, then reload the page in Safari. If files were **added or removed** under `extension/` (check `git diff --stat HEAD@{1} -- extension`), regenerate the project: `rm -rf xcode` and re-run the converter command above, then Run.

## New tab page

Margin replaces the new-tab page with a launcher: search or enter an address, your active space's pins as tiles, and recently archived tabs. Choose it in Safari → Settings → General → **New tabs open with** → Margin.

**Focus:** Safari focuses its own address bar on a new tab, so the launcher's search field usually doesn't get keyboard focus. That's expected. Click the field, or just type in the address bar.

## Development

```sh
npm test            # unit tests (node --test)
npm run test:e2e    # Playwright + headless Chromium
```
