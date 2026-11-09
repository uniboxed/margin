# Margin's native shells

`native/` is a Cargo workspace (native/BRIEF.md): `margin-core` (OS-neutral, tested on any OS) and `margin-windows`
(the Windows shell, `margin.exe`). macOS stays Swift (`app/shell/`).

## margin-windows: building and running on Windows

Nothing of it runs on the Mac: there it's compile-checked
(`cargo check -p margin-windows --target x86_64-pc-windows-msvc`) and its OS-neutral modules are unit-tested
(`cargo test -p margin-windows`). On Windows:

1. **Tools.** Rust (rustup, from rustup.rs) and the Visual Studio 2022 Build Tools with "Desktop development with C++"
   (the MSVC v143 tools and a Windows 11 SDK). Then the target, if it isn't the default:
   `rustup target add x86_64-pc-windows-msvc` (an Arm PC: `aarch64-pc-windows-msvc`). Node for the overlay page: one that runs `.ts` files directly (`npm run build` is `node scripts/build.ts`; Node 23.6
   or later, as on the Mac).
2. **The overlay page.** From the repo's root: `npm ci`, then `npm run build`. It makes `dist/app/` (`overlay.html`,
   `overlay.js`, `arcadia.js`).
3. **The executable.** `cd native`, then `cargo build --release -p margin-windows`. It's
   `native\target\release\margin.exe` (the WebView2 loader is linked in; no DLL to copy).
4. **Put them together.** `margin.exe` serves the overlay's files from a folder `app` beside itself, read once at
   start. For example:

   ```bat
   mkdir "%LOCALAPPDATA%\Programs\Margin"
   copy native\target\release\margin.exe "%LOCALAPPDATA%\Programs\Margin\"
   xcopy /E /I /Y dist\app "%LOCALAPPDATA%\Programs\Margin\app"
   ```

   The WebView2 Runtime comes with Windows 11 (and current Windows 10); if it's missing, the log says the environment
   didn't start: install the Evergreen Runtime from Microsoft.
5. **The extension's id.** No id is fixed in the repo yet (`margin-windows/src/install.rs` `EXTENSION_IDS`, a TODO for
   Tirth). For an unpacked build: load it in `chrome://extensions` (or `edge://extensions`), copy its id, and set
   `setx MARGIN_EXTENSION_IDS <id>` (several: commas) in a new terminal before starting `margin.exe`. The Chrome build
   doesn't have the `nativeMessaging` permission or the Chromium link yet (BRIEF.md, "The plan" step 2): until it
   lands, add `"nativeMessaging"` to the unpacked build's `manifest.json` by hand to try the relay.
6. **Start it.** Run `margin.exe` (no arguments). It has no window of its own: it registers the host, listens on its
   pipe, and once a linked Chrome or Edge is in front follows its windows and draws the overlay over each full-screen
   one (F11), as Margin.app does over full-screen Safari (`margin_core::shell`, driven by `margin-windows/src/host.rs`).
   A second launch exits at once. To quit it: Task Manager, or `taskkill /im margin.exe`.

### The host registration

At every launch the app writes `%LOCALAPPDATA%\Margin\NativeMessagingHosts\io.tirth.margin.json` (its `path` is the
running `margin.exe`, `allowed_origins` the ids above) and points the default value of these keys at it:
`HKCU\Software\Google\Chrome\NativeMessagingHosts\io.tirth.margin` (Chrome, and its Beta, Dev and Canary),
`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\io.tirth.margin`,
`HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\io.tirth.margin` and
`HKCU\Software\Chromium\NativeMessagingHosts\io.tirth.margin`. Check with
`reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\io.tirth.margin /ve`.

To see the relay link: in the extension's service worker console, `chrome.runtime.connectNative('io.tirth.margin')`.
Chrome starts `margin.exe chrome-extension://<id>/ --parent-window=0`, which starts the app if it isn't running and
links to it; the app's log says `relay 1 linked: chrome (pid …)`.

### The log

`%LOCALAPPDATA%\Margin\logs\margin.log` (the app) and `relay.log` (every relay), each kept to about 1 MiB (then
renamed to `margin.1.log` / `relay.1.log`). They never hold addresses or titles. Follow one live with
`Get-Content -Wait "$env:LOCALAPPDATA\Margin\logs\margin.log"` in PowerShell.

### Data folders

All under `%LOCALAPPDATA%\Margin`: `data`, `themes`, `logs`, `WebView2` (the overlay's web view's user data) and
`NativeMessagingHosts`. Opening at sign-in is the value `Margin` of `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
(`"<margin.exe>" --login`), which the shell turns on and off.

What couldn't be checked without Windows: `native/UNVERIFIED.md`.
