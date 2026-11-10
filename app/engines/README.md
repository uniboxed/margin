# The app's engines

What differs per browser on Margin.app's side, by engine. The rest of `app/` is what every browser shares (`shared/`) and each OS's own code (`platforms/`: `macos/`, `windows/`). The extension's side of each engine is in `extension/engines/`.

| Folder | What it holds | Built into |
|---|---|---|
| `webkit/safari/` | Safari's side of the Mac app (Swift): its Accessibility tree, its files and profile names, iCloud Tabs, the startup covers, keeping its sidebar closed, the edge stop, the dev hooks; `handler/`, its extension handler (the extension's target, copied by `scripts/make-xcode.sh`); `tests/`, its checks (`tools/app-tests/run.sh`) | Margin.app: every `*.swift` of the folders `app/platforms/macos/swift-sources.txt` lists, this one among them (its own files only, not `handler/` or `tests/`) |
| `chromium/` | Chromium's side, every OS (Rust, crate `margin-chromium`): its browsers (Chrome, Edge, their channels, Brave, Chromium), where their native-messaging host files go and what they say | the connector (`app/shared/connector/`, `margin-connector --install`), a crate of the root `Cargo.toml` |

Only these folders may ask which browser this is; the rest of the app asks what it can do.
