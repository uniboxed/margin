# WebKit host

A small stand-in for Safari, for testing Margin on Safari's own extension engine without opening or automating Safari.

It is a macOS command-line program (`host.swift`) built on WebKit's `WKWebView` (the page engine) and `WKWebExtensionController` (the extension engine Safari uses: content scripts, the background service worker, `browser.*` APIs, registered scripts). It loads Margin's Safari build (`dist/safari`) into one window with a few tabs, plays a scenario (open tabs, install or update Margin, switch tabs, put a tab to sleep, run JavaScript in a page, take a screenshot), and checks the results. The window is off screen and the program never becomes the active app, so nothing appears while it runs.

## Running it

```sh
npm run build                         # the host tests dist/safari
tools/webkit-host/run.sh all          # every scenario; exits 1 if a check failed
tools/webkit-host/run.sh switching    # one scenario
npm run test:webkit                   # the same as `run.sh all`
```

Needs macOS with Xcode's command-line tools (`swiftc`) and Node. `run.sh` compiles the host into `build/` when `host.swift` changes, copies `dist/safari` to `build/ext` with a small hook (`hook.js`) that sends Margin's console output to the test server, starts the server (`server.mjs`, port 47811, serving the test pages), runs the scenario and prints both logs: the host's steps with each check's `PASS`/`FAIL`, then Margin's console.

## Scenarios

In `scenarios.mjs`, each a list of steps (documented at the top of the file). A check (`check` in Margin's content-script world, `checkPage` in the page's) waits until its JavaScript returns `true`, up to a timeout, so scenarios don't depend on fixed waits.

| Scenario | What it covers |
| --- | --- |
| `switching` | Pages open at install get Margin (WebKit adds the core, the background the theme); switching through Margin, including to a tab Safari unloaded |
| `update` | Margin updated while a page with a typed draft is open: the new copy takes over, the draft stays, one sidebar shows |
| `fitted` | "Keep open" with the fitted layout, then a tab Safari unloaded is shown |
| `newtab` | The new-tab page loads the active theme's module and draws the launcher |
| `screenshot` | A fitted page, saved to `build/screenshot.png` to look at |

## Real websites

`open` also takes a full URL (`https://…`). The host logs every navigation (`nav <tab> top go <url>`, `committed`, `loaded`), so redirects and reload loops show. Each page's own console errors, warnings, uncaught errors and CSP violations are kept in `window.__pageLog` (read with a `page` step); Margin's log lines in the content-script world in `globalThis.__marginLog` (a `check`/`eval` step), since a site's CSP can block sending them to the server. Run a one-off scenario file with `./run.sh path/to/scenario.json`. Several runs can go at once with their own `MARGIN_HOST_PORT` and `MARGIN_HOST_BUILD` (a folder); `MARGIN_HOST_TIMEOUT` sets the time limit in seconds. The host has no signed-in accounts.

## Limits

- It isn't Safari. Everything around the engine is this program's: tabs, the window, sleeping tabs, launching and relaunching. That's where it can differ from Safari (it once loaded a hidden tab on `tabs.reload`, which Safari never does), so confirm tab and window behavior in Safari's own log (`/usr/bin/log show`, passively) or in Safari itself.
- Where it follows Safari on purpose (2026-10-29): `tabs.reload` leaves a tab asleep alone; a tab asleep is shown Safari's way, its web view into the window before it has a process and its load 30 ms later (Safari restores it after its session storage is back), so WebKit doesn't count that first moment in the window; selecting a tab takes 2 ms of the main thread (Safari's own selection turn lasts 2–74 ms in its log), so a second tab change sent with the first lands in the same run loop turn, as in Safari; the `deferLoads` step loads a tab asleep only if it's still the one shown once the turn is over (Safari can put a selected tab's load off until its selection update is done), and makes its web view as it's selected all the same, as Safari does (a script there then gets an error in place of a result, rather than failing).
- Margin's background (a service worker) stops about 5 s after it starts, whatever the build, and nothing starts it again: every message after that gets an empty answer (`browser.runtime.sendMessage` resolves to undefined at once). Neither page messages nor tab events keep it running, and `loadBackgroundContent` takes it as still loaded. Safari keeps it running while it's needed and wakes it for a message. So a scenario does what needs the background within about 4 s of `install` (or splits into several scenarios); a step later than that fails, at random near the edge. To check, send 30 × `getZoom` from a page and look for `undefined`.
- No real trackpad: gestures, pinch zoom and pull-to-refresh aren't covered here.
- The engine is the one in the installed macOS, which may be newer or older than a user's Safari.
