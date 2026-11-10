# Margin for Windows

Two programs, side by side in one folder (docs/windows/BRIEF.md):

- **`margin.exe`** (this crate, `margin-windows`): the app. It follows Chrome's and Edge's windows, draws the overlay
  page over them, holds Margin's keys, keeps the lasting data, and links to each copy of Margin's extension over the
  copy's own WebSocket to `127.0.0.1`, as Margin.app does on the Mac (`margin_core::shell`, driven by `src/host.rs`).
- **`margin-connector.exe`** (`app/shared/connector/`, the same program on every OS): the browsers' native-messaging
  host. Chrome or Edge starts it for the extension; it finds the running app over its named pipe and hands the copy
  the link (the port, a token, a key). It never carries the link itself. The app runs `margin-connector.exe
  --install` at each launch, which writes the browsers' host file and registry keys.

The Rust is one workspace at the repo's root (`Cargo.toml`): `margin-core` (`app/shared/core/`, OS-neutral, tested on
any OS), `margin-connector`, `margin-chromium` (`app/engines/chromium/`, where each browser looks for host files) and
`margin-windows`. macOS stays Swift (`app/platforms/macos/`).

## Building and running on Windows

Nothing of it runs on the Mac: there it's compile-checked (`npm run test:rust` runs clippy for
`x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc`) and its OS-neutral modules are unit-tested
(`cargo test -p margin-windows`, the link's listener among them, on real sockets). On Windows:

1. **Tools.** Rust (rustup, from rustup.rs) and the Visual Studio 2022 Build Tools with "Desktop development with C++"
   (the MSVC v143 tools and a Windows 11 SDK). Then the target, if it isn't the default:
   `rustup target add x86_64-pc-windows-msvc` (an Arm PC: `aarch64-pc-windows-msvc`). Node for the overlay page and
   the extension: one that runs `.ts` files directly (`npm run build` is `node scripts/build.ts`; Node 23.6 or later,
   as on the Mac).
2. **The overlay page and the extension.** From the repo's root: `npm ci`, then `npm run build`. It makes `dist/app/`
   (`overlay.html`, `overlay.js`, `arcadia.js`) and `dist/chromium/` (the extension for Chrome, Edge and the other
   Chromium browsers).
3. **Both programs.** From the repo's root: `cargo build --release -p margin-windows -p margin-connector`. They're
   `target\release\margin.exe` and `target\release\margin-connector.exe` (the WebView2 loader is linked in; no DLL to
   copy). Optionally `set MARGIN_APP_VERSION=<version>` first, in the same terminal: both then say that version, and a
   connector of another build exits when the app answers it (the browser starts the new one next time); built without
   it, the connector says none and isn't checked.
4. **Put them together.** `margin-connector.exe` must be **beside `margin.exe`** (the app lets only that connector into
   its pipe, and the connector only that app); `margin.exe` serves the overlay's files from a folder `app` beside
   itself, read once at start. For example:

   ```bat
   mkdir "%LOCALAPPDATA%\Programs\Margin"
   copy target\release\margin.exe "%LOCALAPPDATA%\Programs\Margin\"
   copy target\release\margin-connector.exe "%LOCALAPPDATA%\Programs\Margin\"
   xcopy /E /I /Y dist\app "%LOCALAPPDATA%\Programs\Margin\app"
   ```

   The WebView2 Runtime comes with Windows 11 (and current Windows 10); if it's missing, the log says the environment
   didn't start: install the Evergreen Runtime from Microsoft.
5. **The extension.** Load `dist\chromium` unpacked in `chrome://extensions` (or `edge://extensions`, Developer mode).
   Its manifest's `key` gives it Margin's id (`njeebbcmlenfopaecfbphgcfihbdmkec`), the one the host file allows
   (`app/engines/chromium/src/lib.rs` `EXTENSION_IDS`), and it has `nativeMessaging`.
6. **Start it.** Run `margin.exe` (no arguments). It has no window of its own: it runs the connector's install, listens
   on its pipe and on 127.0.0.1, and once a linked Chrome or Edge is in front follows its windows and draws the overlay
   over each one: over the whole window in full screen (F11), as Margin.app does over full-screen Safari, and over the
   page area, under the tabs and toolbar, of a window that isn't. A second launch exits at once; so does a `margin.exe`
   started by a browser as its host (an older registration, before the connector). To quit it: Task Manager, or
   `taskkill /im margin.exe`. The connector starts the app when a copy asks for it and it isn't running.

### The host registration

`margin-connector.exe --install` (the app runs it at each launch, in the background, with no console window) writes
`%LOCALAPPDATA%\Margin\com.unibox.margin.json` (its `path` is the connector, `allowed_origins` Margin's extension only)
and points the default value of these keys at it: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.unibox.margin`
(Chrome, and its Beta, Dev and Canary), `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.unibox.margin`,
`HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.unibox.margin` and
`HKCU\Software\Chromium\NativeMessagingHosts\com.unibox.margin`. Check with
`reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.unibox.margin /ve`; run it by hand with
`margin-connector.exe --install` (it prints what it wrote). The log says `the browsers' host files written: N`.

### The link, step by step

The copy calls `connectNative('com.unibox.margin')` (its lasting port) and `sendNativeMessage` (`wantLink`); Chrome
starts `margin-connector.exe chrome-extension://<id>/` through `cmd.exe` for each. The connector connects to
`\\.\pipe\Margin-<SID>`, says its hello (the browser and its process), and passes each message on; the app answers it
as Safari's handler does and dispatches the `link` into that browser's connectors. The copy then opens
`ws://127.0.0.1:<port>/?t=<token>`, checks the app's `welcome` carries the key, and says `hello`. margin.log shows
`relay N: Margin's connector (pid …) connected`, `wantLink: link handed to Chrome (port …, #1)`, `link #1 reached the
extension`, `socket open`, `hello: chrome:p-…`.

### The log

`%LOCALAPPDATA%\Margin\logs\margin.log`, kept to about 1 MiB (then renamed to `margin.1.log`). It never holds addresses
or titles. Follow it live with `Get-Content -Wait "$env:LOCALAPPDATA\Margin\logs\margin.log"` in PowerShell.

### Data folders

All under `%LOCALAPPDATA%\Margin`: `data`, `themes`, `logs` and `WebView2` (the overlay's web view's user data), and
the connector's host file. Opening at sign-in is the value `Margin` of
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (`"<margin.exe>" --login`), which the shell turns on and off.

What couldn't be checked without Windows: `docs/windows/UNVERIFIED.md`.
