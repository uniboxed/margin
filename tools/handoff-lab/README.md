# The handoff lab

The test tool for the profile handoff's private calls (`app/HANDOFF.md` §10.3, §10.4). It has one mode per gate, G1-G18, plus `holds`, the check that the freeze still holds the screen. Each gate is a run on screen, and its result decides what the build turns on. Run it on every macOS beta. `PRIVATE-APIS.md` keeps the results.

It isn't part of `npm test` or `npm run test:app`. Nothing runs it automatically.

## The rules

- **Tirth's go-ahead first.** The lab moves windows, takes them into full screen and freezes the screen. Ask before any run on screen.
- **Browsers:**
  - The lab drives windows only in **Safari Technology Preview**, and only the windows it opened itself, through its temporary extension (`ext/`).
  - It never touches release Safari's windows. G1's Margin half and G16 go through Margin.app (WP12's dev hook). Margin refuses any profile not named exactly "Test A" or "Test B", and the lab only reads Margin's log.
  - Never use another profile, and never any of Tirth's own windows.
- **One dry run first:** `--dry-run` prints the plan and the read-only checks, and touches nothing. Without `--go` the lab does the same and runs nothing.
- **One gate at a time** while you learn a new beta. The first failure stops the run (`abort: … failed`). Don't rerun past a failure without finding out why.
- **Screen Recording** is for the lab only, through the terminal's existing grant. The lab checks it but never asks for it. Without it, frame counts say "not measured". Margin.app never gets Screen Recording.
- **Nothing private is kept.** The lab writes ids, window numbers, Space ids, counts and milliseconds only. Never a page's address, title or words.

## Build

```sh
tools/handoff-lab/build.sh          # build/handoff-lab, only when a source changed (--force: always)
```

- The lab compiles Margin.app's own files with the app target's settings, so a gate tests what ships:
  - `PrivateCalls.swift`: the launch check and the SkyLight wrappers;
  - `Freezer.swift`: `RealFreezer` and its watchdog;
  - `SpaceReads.swift`: the Space reads and the bridge;
  - `BridgeParker.swift`: `SpaceParker` and the cross-process self-test;
  - and what those need.
- `BridgeParker.swift`'s `extension Shell` is left out of a copy in `build/`, because the lab has no shell.
- The binary is signed ad hoc with the hardened runtime.
- It never runs under `MARGIN_APP_TESTS`: the private calls refuse there.

## Commands

```sh
L=tools/handoff-lab/build/handoff-lab
$L list                      # the gates and what each needs
$L g5 --dry-run              # the plan and the read-only checks
$L g5 --go                   # run it
$L holds g5 g6 --go          # several, in order; the first failure stops the rest
$L own --dry-run             # the gates on the lab's own windows; `stp`: the STP gates; `all`
```

Options:

- `--person`: someone is at the Mac for the guided steps (G8, G9, the swipe in G15). Each step waits for Enter.
- `--runs N`: how many handoffs or rounds (each gate has its own default).
- `--stp`: G7 and G15 also run in STP.
- `--dock-restart`: G5 restarts the Dock (`killall Dock`) with a window parked.
- `--dev-hook`: G1 also asks Margin.app for one switch through the dev hook.
- `--app PATH`: Margin.app's path (default `/Applications/Margin.app`).
- `--results DIR`: where the report goes (default `tools/handoff-lab/results`).

## The gates

| Gate | Where | Needs | Look at |
|---|---|---|---|
| `holds` | a small lab window | frames | no complete frame while frozen; changes before and after; the watchdog's reveal off the main thread |
| G1 | the lab, then Margin.app | frames; Margin.app; `--dev-hook` | the lab's launch line and self-test; `holds`; Margin's signature (Developer ID, hardened runtime, no library-validation exemption), launch line and self-test line; its switch's `result 0` |
| G2 | STP, still pages | frames | per run: the target page's first rAF and `visibilitychange` against R1/R2 and the reveal; the probe's answer; the panel's first rAF; frames after the reveal. Its suggestion for R3 |
| G3 | STP | frames | two freezes against one: held times, Desktop drops, frames that are neither window's |
| G4 | STP | | a duplicate full-screen request at 100, 250 and 400 ms: does B toggle out? When does the new full-screen Space appear? The copy's state at 400 ms |
| G5 | hidden child windows | | create and destroy times; nothing disturbed; a Space per window; which reads list a private Space's window; with `--dock-restart`, the Dock |
| G6 | a hidden child window | | whether the liveness read lists a parked window, and its bounds |
| G7 | a small lab window; `--stp` for STP | frames | a second freeze 150, 300, 600 and 1000 ms after a watchdog reveal: its answer, and whether it holds; rapid switches in STP |
| G8 | STP | `--person` | each prompt's windows: layer, size, inside A or not; what §1.10's rule sees |
| G9 | STP | `--person` | where B is after ⌘`, the Window menu, the Dock's list, ⌘H, Bring All to Front; focus events; a Dock click with every window parked |
| G10 | the lab's windows | | parking mid-entry (100 ms, 300 ms, just after): where the window ends up, and whether recovery leaves no full-screen Space behind |
| G11 | STP, two displays | a second display | a parked window moved by its copy, then shown: which display it lands on |
| G12 | the lab's windows | frames; no WebKit host running | bad frames per switch: must be 0 |
| G13 | a small lab window, children | frames | how soon the screen moves after the freezing process is killed; where a parked window lands when its parker dies |
| G14 | the lab's windows | | where an own-Space panel ends up when its full-screen Space goes, left in or ordered out first |
| G15 | the lab's windows; `--stp` for STP | `--person` for the swipe | every active Space seen during each switch: never another Space |
| G16 | Margin.app with Test A and Test B | the dev hook | 30 switches: the frozen-time distribution, the late rate, none recovered or aborted |
| G17 | the lab's windows | frames | a reveal mid-exit and in the settle: no frame that isn't B's |
| G18 | the lab's windows | | a minimized window shown by the bridge: still minimized? Where is it? |

Each result is one of:

- **pass**: the gate's condition held.
- **fail**: it didn't, or a step broke. The run stops there.
- **partial**: part of it couldn't run (Margin.app missing, no dev hook, no frames).
- **recorded**: an observation gate. Its lines are the answer, and the decision is made by reading them.
- **not run**: something it needs is missing (one display, no `--person`).

## The runbook

### Before

1. Ask Tirth. Say which gates, how long, and that the screen will freeze for about 1-2 s at a time.
2. Build: `tools/handoff-lab/build.sh`.
3. Dry run what you'll run: `$L <gates> --dry-run`. Check the read-only lines:
   - the launch check says `freeze ok, spaces ok, park ok`;
   - Screen Recording says yes;
   - the display count;
   - STP running, or Margin.app.
4. Close or move away anything you don't want covered. The own-window gates put the lab's windows in full screen.

### The lab's own windows (no browser)

Run `holds`, then G5, G6, G10, G12, G13, G14, G15, G17 and G18, one at a time: `$L holds --go`, and so on.

- Nothing in Safari is touched.
- G12 refuses while the WebKit host (`tools/webkit-host`) is running.
- The own-window handoffs include up to 350 ms for AppKit's own full-screen entry before the lab asks for it (as `S/handoff/park.swift` did). Their times are slower than STP's for that reason. Compare them with each other, not with Safari.

### Safari Technology Preview (G2, G3, G4, G7 `--stp`, G8, G9, G11, G15 `--stp`)

1. Start STP with no windows of your own that matter. Turn on **Develop → Developer Settings → Allow unsigned extensions** if needed.
2. Start the gate, for example `$L g2 --go`. It starts its server on 127.0.0.1:47944, then waits up to 3 minutes for the extension.
3. In STP, open `http://127.0.0.1:47944/s.html`. Then **Develop → Developer Settings → Add Temporary Extension…** and pick `tools/handoff-lab/ext`.
4. Leave the keyboard and mouse alone unless the lab asks (`>>>` lines, with `--person`).
5. When the run ends, the lab returns every window it parked, takes its windows out of full screen and closes them. Your own STP windows stay as they were.
6. A temporary extension goes when STP quits. Add it again next time.

G8 and G9 need `--person`: someone dismisses each prompt and does each step, then presses Enter.

### Margin.app (G1's second half, G16)

1. Install the Developer-ID, hardened build of Margin.app. In System Settings → Device Control and Data Access, check that Margin has **neither Screen Recording nor Accessibility** (G1 says "by hand").
2. In release Safari, use only the **Test A** and **Test B** profiles, with one window each. Margin shows one and parks the other.
3. Turn on the dev hook (WP12): `defaults write io.tirth.margin MarginDevHooks -bool YES`. Turn it off afterwards.
4. `$L g1 --dev-hook --go`, then `$L g16 --go` (30 switches, about 2 minutes).
5. Turn the dev hook off: `defaults delete io.tirth.margin MarginDevHooks`.

### After

1. The report is `results/<build>-<date>.md`. Each run adds a section with the launch line, whether Screen Recording was there, the options, and each gate's status and lines.
2. Update `PRIVATE-APIS.md`: the "Seen working" and "Last lab run" columns, and the link to the newest report.
3. A gate that decides a setting (G2's R3, G4's retry, G5's enumerator, G7's cooldown, G16's numbers) is changed in the code only after the result has been read. Never automatically.
4. Commit the report with the change it led to.

## Files

- `lab.swift`: the gates, the handoff they share (`handoff()`, §1.3's order), the frame recorder, the lab's own windows and panel, the children, and the STP and Margin drivers.
- `build.sh`: builds `build/handoff-lab`.
- `ext/`: the temporary extension for STP.
  - `bg.js` runs the lab's windows and tabs commands, as Margin's copy would, and reports focus and new tabs (ids and times).
  - `probe.js` is R3's frame probe (§3.2) in every lab page. It also keeps every rAF and `visibilitychange` time when armed.
- `www/`: the lab's pages, served by `server.py`.
  - `still.html` draws nothing after it loads (G2-G4, G7, G9, G11, G15).
  - `dialog.html` opens prompts (G8).
  - `a.html`, `b.html`, `n.html` and `video.mp4` are the earlier STP lab's pages with sound and PiP.
  - `p.html` is the park lab's page.
  - `s.html` gives the setup steps.
- `server.py`: the local server, a command queue for the extension and each page, and the pages' reports. Run with `python3 -I`.
- `results/`: one report per macOS build and day.

## Limits

- **G1's lab half isn't free of permissions.** It runs under the terminal, which has Screen Recording. The case without permissions is Margin.app's own launch line, its self-test, and its switch through the dev hook.
- **G2's probe is the lab's own `probe.js`.** It answers in the shape §3.2 gives. Once WP6's content script exists, run G2 again on Margin's own probe through G16's setup.
- **G5's enumerator search** calls `SLSCopyWindowsWithOptionsAndTags` with the signature the window managers that use it declare. It's the lab's only call that Margin.app doesn't make, so `PRIVATE-APIS.md` row 13 holds its result, not its use.
- **Child windows** (G5, G6, G13) are titled 800×500 windows at alpha 0 that macOS keeps mostly off screen. They're never seen, but they are real windows of another process, as Safari's are.
- **Frames:** only complete frames count, because ScreenCaptureKit repeats old buffers while the screen is still. With no complete frame at all while frozen and a window changing every frame underneath, the screen held. A camera is still the only independent proof.
