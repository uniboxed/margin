# The handoff lab

The test tool for the profile handoff's private calls (`docs/HANDOFF.md` §10.3, §10.4). It has one mode per gate, G1-G18, plus `holds`, the check that the freeze still holds the screen. Each gate is a run on screen, and its result decides what the build turns on. Run it on every macOS beta. `docs/PRIVATE-APIS.md` keeps the results.

It isn't part of `npm test` or `npm run test:app`. Nothing runs it automatically.

## The rules

- **Approval first.** The lab moves windows, takes them into full screen and freezes the screen. Ask before any run on screen.
- **Browsers:**
  - The lab drives windows only in **Safari Technology Preview**, and only the windows it opened itself, through its temporary extension (`ext/`).
  - It never touches release Safari's windows. G1's Margin half and G16 go through Margin.app (WP12's dev hook). Margin refuses any profile not named exactly "Test A" or "Test B", and the lab only reads Margin's log.
  - Never use another profile, and never any windows in real use.
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

The live gate's pure log-parser checks run off screen, with no windows or private calls:

```sh
swiftc -parse-as-library tools/handoff-lab/LiveLog.swift tools/handoff-lab/ValidationPlan.swift tools/handoff-lab/tests/live-log-tests.swift -o /tmp/margin-live-log-tests
/tmp/margin-live-log-tests
```

The separately approved one-request `FALLBACK` follow-up is excluded from
`all`; its advisory real-draft preflight never authorizes a close. Read the
prepared protocol and actual failed batch in [VALIDATION.md](VALIDATION.md)
before selecting it. Its metadata parser checks run without an app or window:

```sh
swiftc -parse-as-library tools/handoff-lab/DraftLog.swift tools/handoff-lab/tests/draft-log-tests.swift -o /tmp/margin-draft-log-tests
/tmp/margin-draft-log-tests
```

## The gates

The separately approved, user-initiated real lock/sleep/display and two-display
checks are prepared in [SYSTEM-VALIDATION.md](SYSTEM-VALIDATION.md). They require
`--person`, are excluded from `all`, and never initiate an OS lock/sleep/display
change. Their default/dry-run paths switch nothing.

The prepared issue #15 VALIDATE gate and resource protocol are in
[VALIDATION.md](VALIDATION.md). It is a separately approved, fixed maximum of
50 guarded requests, outside earlier two/four-switch approvals. Do not use the
older freeze-only G16 parser as live-cover acceptance.

### LIVE: issue #15's live-cover experiment

`build/handoff-lab live --dry-run --app "$HOME/Applications/Margin.app"` prints the exact plan and launch checks without showing or moving anything. After approval, the same command with `--go --runs 2` uses only the guarded Test A/Test B dev hook. Prepare Test A in front and Test B as in G16; handoff/parking must be on, close-windows off, and no dev-hook caps or faults armed. An accepted read-only dump establishes those preconditions before any cover appears.

The lab temporarily caps the freeze off for those two profiles, shows its own animated blue panel in a temporary level-400 Space, then asks Margin for Test B and Test A. It keeps that cover until each handoff ends and fresh reads verify the destination is full screen, active and frontmost and the source is parked or gone. It restores the cap, orders out its panel and destroys its own Space on completion, failure and SIGINT/SIGTERM. No browser is pre-created by this gate, no foreign window is written by its cover calls, and it stops at the first failure.

If an approved two-switch run completes Test A → Test B but stops before returning, `live --return-to-a --dry-run` describes **one** remaining Test B → Test A return. After diagnosing the failure, `--go --return-to-a` consumes only that remaining approval, never another Test B request. The flag is included in the report. Do not count a successful browser transition as a frame-check pass if the recorder's counts were not saved.

The log parser excludes replayed `dev hook: dump:` lines but accepts the legitimate `dev hook: cap` suffix on actual handoff summaries. Browser-front checks reuse `WindowMatcher.candidates`: `CGWindowSource` intentionally includes other apps' on-screen windows, so a raw first-window test would mistake Margin's own cover/layout for Safari.

The optional recorder tests all 960 grid points over 90% of the display and counts changing complete frames. Unavailable capture produces **partial**, never a visual pass. A physical-camera check is separate. This pulse is a lab marker, not product UI; the product cover uses Margin's theme renderer and its own cached target-space data.

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

1. Ask first. Say which gates, how long, and that the screen will freeze for about 1-2 s at a time.
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

### Margin.app with the dev hook (G1's second half, G16)

These two run through Margin.app, never the lab's own calls. The lab posts WP12's dev hook (`app/engines/webkit/safari/DevHooks.swift`) and reads Margin's log. Margin refuses the hook unless `MarginDevHooks` is YES, and unless the window it shows and the target are Safari's own **Test A** and **Test B** (exact names, read from Safari's files with Full Disk Access). It can't reach any other profile.

Before:

1. Approval first. Each handoff holds the screen still for about 1-1.5 s.
2. Install the Developer-ID, hardened build of Margin.app. In System Settings → Device Control and Data Access, check that Margin has **neither Screen Recording nor Accessibility** (G1 checks this by hand). It needs **Full Disk Access**, for Safari's profile names.
3. Turn the handoff and the hook on, then quit and reopen Margin.app (the handoff's gate is read at launch):
   ```sh
   defaults write com.unibox.margin MarginHandoff -bool YES
   defaults write com.unibox.margin MarginDevHooks -bool YES
   ```
4. In release Safari, use only **Test A** and **Test B**: one window each, Test A's in full screen with Margin's sidebar. Switch to Test B and back once by hand, so Test B's window is parked and Test A's is shown.
5. Check the hook from a terminal, with nothing moving:
   ```sh
   swift tools/handoff-lab/devswitch.swift dump
   /usr/bin/log show --last 1m --style compact --predicate 'subsystem == "com.unibox.margin"' | grep 'dev hook'
   ```
   - The dump says `handoff on, parking on (self-test passed)`, `freeze ok, spaces ok, park ok`, `displays 1` and `1 parked`.
   - `refused: …` names what's missing (the default, a name, no window shown).
   - Stop there if anything is off.

G1, Margin's half (one switch):

1. `$L g1 --dev-hook --dry-run`, then `$L g1 --dev-hook --go`.
2. The lab posts one `dev.switch` to Test B and waits up to 8 s for Margin's summary line.
3. Pass: Margin's launch line says `freeze ok … park ok`, its self-test passed, its signature is Developer ID with the hardened runtime, and the switch's line has `(park+freeze, parked target), frozen N ms (result 0)`.
4. You see the cover ("Switching to Test B…"), about a second of still screen, then Test B in full screen. Test A's window is parked: it isn't in Mission Control.

G16 (at least 30 handoffs):

1. Test A shown, Test B parked (the first switch goes to Test B). Leave the keyboard and mouse alone.
2. `$L g16 --dry-run`, then `$L g16 --go` (30 switches, every 3 s, about 2 minutes; `--runs N` for more).
3. Each switch is one Margin summary line in the report: its frozen ms, `late` if the watchdog revealed, `recovered` or `aborted` if it didn't land.
4. Pass: every switch has a line, none recovered or aborted. The report gives the frozen-time distribution and the late rate. Whether the late rate is acceptable is then decided, and the numbers replace TESTING.md's estimates.
5. Abort with ⌃C at the first switch that looks wrong (a black screen, a window in the wrong place). The lab stops posting, and Margin's own recovery runs.
6. Without the lab, the same loop by hand: `swift tools/handoff-lab/devswitch.swift alternate 30 --every 4`, with the log open.

The hook's other kinds (for TESTING.md's live checklist, not the gates): `mode --freeze off` or `--old close|keep` caps Test A and Test B's switches for the session; `fail show|park|reveal|fullscreen` makes the next such step count as not landed, to see §4.4's recovery on purpose. A `fail` or `mode` lasts until Margin.app quits.

After:

1. Turn the hook off: `defaults delete com.unibox.margin MarginDevHooks`. The next notification is refused, with no relaunch.
2. `defaults delete com.unibox.margin MarginHandoff` too, unless the build is meant to keep the handoff on, then quit and reopen Margin.app.
3. The hook goes before production: `git grep DEV-HOOK` lists every part of it (TESTING.md, "Before production").

### After

1. The report is `results/<build>-<date>.md`. Each run adds a section with the launch line, whether Screen Recording was there, the options, and each gate's status and lines.
2. Update `docs/PRIVATE-APIS.md`: the "Seen working" and "Last lab run" columns, and the link to the newest report.
3. A gate that decides a setting (G2's R3, G4's retry, G5's enumerator, G7's cooldown, G16's numbers) is changed in the code only after the result has been read. Never automatically.
4. Commit the report with the change it led to.

## Files

- `lab.swift`: the gates, the handoff they share (`handoff()`, §1.3's order), the frame recorder, the lab's own windows and panel, the children, and the STP and Margin drivers.
- `build.sh`: builds `build/handoff-lab`.
- `devswitch.swift`: the dev hook's sender (`swift tools/handoff-lab/devswitch.swift …`), for G16 by hand and TESTING.md's live checklist. It goes with the hook before production (`DEV-HOOK`).
- `ext/`: the temporary extension for STP.
  - `bg.js` runs the lab's windows and tabs commands, as Margin's copy would, and reports focus and new tabs (ids and times).
  - `probe.js` is R3's frame probe (§3.2) in every lab page. It also keeps every rAF and `visibilitychange` time when armed.
- `www/`: the lab's pages, served by `server.py`.
  - `still.html` draws nothing after it loads (G2-G4, G7, G9, G11, G15).
  - `dialog.html` opens prompts (G8).
  - `a.html`, `b.html`, `n.html` and `video.mp4` are the earlier STP lab's pages with sound and PiP.
  - `p.html` is the park lab's page.
  - `s.html` gives the setup steps.
- `server.py`: the local server, a command queue for the extension and each page, and the pages' reports. Run with `python3 -I`, by the lab only.
  - Any web page on the Mac can reach 127.0.0.1, so the lab's own calls carry a token made per run (`LAB_TOKEN`, sent as `X-Lab-Token`). Requests from other origins or host names are refused, and no answer allows every origin.
  - `bg.js` runs only what the lab sends: its windows calls, windows of the lab's own pages, and `tabs.update` to a lab page. No answer holds an address, a title or an icon.
- `results/`: one report per macOS build and day.

## Limits

- **G1's lab half isn't free of permissions.** It runs under the terminal, which has Screen Recording. The case without permissions is Margin.app's own launch line, its self-test, and its switch through the dev hook.
- **G2's probe is the lab's own `probe.js`.** It answers in the shape §3.2 gives. Once WP6's content script exists, run G2 again on Margin's own probe through G16's setup.
- **G5's enumerator search** calls `SLSCopyWindowsWithOptionsAndTags` with the signature the window managers that use it declare. It's the lab's only call that Margin.app doesn't make, so `docs/PRIVATE-APIS.md` row 13 holds its result, not its use.
- **Child windows** (G5, G6, G13) are titled 800×500 windows at alpha 0 that macOS keeps mostly off screen. They're never seen, but they are real windows of another process, as Safari's are.
- **Frames:** only complete frames count, because ScreenCaptureKit repeats old buffers while the screen is still. With no complete frame at all while frozen and a window changing every frame underneath, the screen held. A camera is still the only independent proof.


## Themed cover comparison and read-only memory samples

`compare --dry-run` describes exactly two guarded Test A → Test B → Test A requests, with no external lab panel. `compare --go` requires the installed feature default off and fresh freeze summaries. `compare --live-ui --dry-run` / `--go` requires the feature default on and actual `live cover` summaries; a fallback fails immediately before another request. Configure/restart the app separately, within the approval for that comparison. `--return-to-a` limits either comparison to one already-approved remaining return. Results are **recorded**: these state/timing checks do not establish physical-display smoothness or pixel coverage.

If preflight finds Test B already shown, `compare --reverse` changes only the order to Test B → Test A → Test B. It still makes at most two requests, with the same guards and first-failure stop. `--return-to-a` takes precedence and remains exactly one request even with `--reverse`. The pure log/plan checks cover all four combinations (14 total checks); options and dry-run output retain the chosen order. This flag does not authorize more switches.

`python3 tools/handoff-lab/memory.py --duration 25 > /tmp/margin-memory.jsonl` samples only metadata. It finds the unique installed Margin process, attributes WebKit GPU/network/content processes through XNU's resource coalition, and reports process-footprint/resident-byte sums, CPU counters and the login helper separately. It reads no process memory contents, browser pages or titles. Unknown coalition/ABI or unread members yield errors/incomplete totals. The cohort was independently distinct from Safari on the current host. These sums include compressed footprint and are not a claim of exclusively resident RAM; compare like window states and include idle samples after cleanup. The sampler is lab-only and adds no product work.

The private metadata schema comes from [Apple's proc_info_private.h](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h) (`PROC_PIDCOALITIONINFO`, 40 bytes), [coalition.h](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/coalition.h) (resource index zero) and the installed SDK's public `rusage_info_v0` (96 bytes). Byte-count checks refuse changed/unknown reads; CPU Mach ticks use the host timebase.

CPU units were independently calibrated in an owned Python process on 26B131: three 0.4-second arithmetic loops compared its `proc_pid_rusage` deltas with `time.process_time_ns()`. The host timebase was 125/3; converted counters matched within 0.006%, while treating the raw values as nanoseconds would undercount by 41.667×. Apple's current [task rusage implementation](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/bsd_kern.c) obtains task-power counters from [Recount Mach-time metrics](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/recount.h). That open-source revision is supporting evidence; the calibration establishes this host's units.

The COMPARE gate preserves completed rows and a failing summary before stopping, so a failure on the return does not erase the first request's measurements from the report. A live-only readiness timeout also records cached R1–R5 progress in Margin's log. When window tracing is enabled, failed stacking checks retain the existing exact above-window metadata at most once per second, with up to 24 rows and the total count; no extra OS queries or page data are collected.

### Owned off-screen WebKit presentation probe

```sh
swiftc -swift-version 5 -default-isolation MainActor -parse-as-library app/platforms/macos/private/CoverPresentation.swift tools/handoff-lab/presentation-probe.swift -o /tmp/margin-cover-presentation-probe
/tmp/margin-cover-presentation-probe
```

This diagnostic creates only its own alpha-zero panel at (-20000,-20000), with two constant counter pages. It never drives a browser or shows a window. The production per-view wrapper checks getter/setter encodings, disables occlusion only on one owned view, reads back the write, then restores it. On 26B131 the normal view stayed at zero rAF callbacks; the held view advanced 60 in a second; restoration succeeded with zero outstanding leases. Unit tests never call the real SPI (`MARGIN_APP_TESTS` refuses it); this explicit owned diagnostic is separate.

### Owned native prepared-allocation matrix

`cover-memory-native.sh` wraps **only** the production `NativeHandoffCover`
prepared variant of `cover-memory-probe.swift`. Its no-argument/default and
`--dry-run` paths print a plan without building, loading native libraries,
generating a fixture, sampling resources or creating an application/window:

```sh
tools/handoff-lab/cover-memory-native.sh --dry-run --rounds 8 --idle 30
```

The coordinator must serialize the following build with all native compilation
and timing captures. `--build` generates a synthetic Arcadia fixture, compiles
every Swift source named by `app/platforms/macos/swift-sources.txt` with `-O`,
both `MARGIN_THEMED_COVER_PROBE` and `MARGIN_NATIVE_PREPARED_MEMORY_PROBE`, and
`-j` from `sysctl hw.ncpu` (fallback 4), then signs ad hoc with the hardened
runtime and verifies the signature. It never builds dist assets or launches
the resulting executable:

```sh
tools/handoff-lab/cover-memory-native.sh --build
```

The separate `build/cover-memory-native/` binary, fixture and stamp leave prior
probe binaries/captures alone. The stamp covers the complete Swift inventory,
wrapper/sampler/fixture inputs, theme files/fonts/images, built overlay/cover
asset tree, fixture and signed binary. Changed, added, missing or symlink inputs
refuse the next run until a fresh serialized build; a failed build removes the
old stamp. The wrapper lock prevents concurrent invocations of this wrapper,
but cannot serialize unrelated compiler commands. The coordinator still owns
that boundary.

Only explicit `--go` launches the matrix, with no automatic build or installed
Margin/browser control. Use a new output directory (existing paths refuse):

```sh
tools/handoff-lab/cover-memory-native.sh --go --rounds 8 --idle 30 \
  --output /tmp/margin-native-prepared-YYYYMMDD-HHMMSS
```

Default order is isolated then related; `--order related-isolated` reverses it.
Rounds are 1–30, post-idle 4–60 seconds, sampling interval 0.1–2 seconds (default
0.25). Each mode has its own exact owned executable/PID/start identity and an
outer deadline of `30 + 15 × rounds + idle` seconds, at most 540 seconds per mode.
The probe warms two off-screen layout pages, then prepares/cancels the actual
native cover each round, verifies cleanup, and observes post-idle. It never
shows the prepared cover or assigns it a private Space. The expected measured
cover DPR/backing scale is 1; another scale refuses this component protocol.

Related mode uses the production renderer's copy of a qualifying source view's
configuration, preserving the identical WebKit process pool/data store required
by the related-view constructor. Source configuration changes therefore require
a new binary stamp, even if earlier probes passed. Native events must prove
actual cover/source PID sharing in related mode, separation in isolated mode,
unchanged layout PIDs, isolated page globals and clean balanced native audits.
This wrapper does not inject source-process crashes or certify their recovery;
the separately owned crash probe and native cancellation/session tests cover
their own stated scopes.

Each mode preserves `manifest.json`, parsed `events.jsonl`, raw `stdout.log`,
`stderr.log`, `samples.jsonl` and `result.json`; the parent directory retains
matrix provenance/results. All stdout is drained and validated in the supervisor's
main loop. Malformed/truncated/non-finite JSON, failed/missing/out-of-order events,
wrong process grouping/scale, cleanup failure, nonzero exit, timeout or incomplete
resource capture stops the matrix before another mode. Parse failures retain
remaining raw stdout after terminating only the owned child. SIGINT/TERM/HUP
also clean up that exact child; no process-name kill or browser restart is used.
The public window observer checks only that exited child's windows are gone.

Resources reuse `memory.py` accounting, with the root selected by exact owned
PID/start/executable path, independent of argv0. Other WebKit candidates receive
only coalition checks before attributed rusage. No installed-app/helper rusage
is included. A WebKit member born at/before the owned root cannot belong to this
new probe: retain it as unread contamination, withhold totals and fail the
measurement. At least one complete census must include both A/B source PIDs in
each stable baseline, cover-ready round and post-idle interval; transition-edge
samples need not independently prove that census. These checks add no additional
process reads beyond the sampler's existing inventory/rusage calls.

This is **off-screen DPR1 component evidence**, with separate process/cache
cohorts per mode. Footprint/resident sums, missed sub-sample peaks and exiting
process CPU retain `memory.py`'s limitations. The matrix is not a full-app
performance grade, physical display/high-DPI result, live shown-cover/Space
composition check, or permission for on-screen Safari cases. It changes no
launch default and does not enable the main cover flag.

Pure guard tests use fake native readers/processes; they never compile or run
the probe:

```sh
python3 -m unittest discover -s tools/handoff-lab/tests -p 'test_cover_memory_native.py'
```
