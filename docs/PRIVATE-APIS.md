# Private APIs

Every private macOS call, class, selector, key and file format Margin.app uses. Keep it up to date with every change to one of them. The design is in `docs/HANDOFF.md` §4 and §8.2. The code is `app/platforms/macos/private/PrivateCalls.swift`.

## The rule

**No private call without a fallback and a launch check.**

- Each call is looked up at launch, before the shell starts (`PrivateCalls.check`, called from `AppDelegate.startShell` through `Shell.checkPrivateCalls`).
- Anything missing, or a type encoding that changed, turns that part off for the whole run. The person gets no notice. The log gets one line.
- Every real call is verified when it's used (`docs/HANDOFF.md` §4.3). A call that didn't land is retried once at most, then the part is off for the session.
- Every Copy function is declared as returning `Unmanaged<CFArray>?`. Nil means "unknown", never a crash.
- Tests never call a real private function and never freeze the screen:
  - the real resolver (`RealPrivateResolver`) is made only in `Shell.forApp()`;
  - it and every wrapper (`SkyLight`) refuse to run when `MARGIN_APP_TESTS` is set, and `tools/app-tests/run.sh` sets it;
  - tests use a fake resolver whose "functions" are their own (`app/platforms/macos/private/tests/private-calls-tests.swift`).
- The log holds names, counts, results and milliseconds only. Never a title, an address or a page's words. Nothing is sent anywhere.

## The parts

| Part | Needs | Off means |
|---|---|---|
| **freeze** | rows 1-4 | the switch runs without a freeze: the person sees macOS's slide |
| **spaces** | rows 1, 5-7 | no readiness reads and no parking: today's close-based switch |
| **park** | spaces, rows 8-12, both encodings | `close` (drafts permitting) or `keep` (`docs/HANDOFF.md` §1.1) |
| **enumerator** | row 13, and gate G5 passed | no orphan check of private Spaces (`docs/HANDOFF.md` §4.4 invariant 3) |

## The calls

All from `SkyLight.framework` (`/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight`) unless the row says otherwise. `cid` is `SLSMainConnectionID()`.

Columns:

- **Signature**: as Margin declares it (`SkyLight` typealiases in `PrivateCalls.swift`).
- **Encoding**: the Objective-C type encoding checked at launch, read on macOS 27.2 (26B123). Functions have none.
- **Caller**: the wrapper in `PrivateCalls.swift`, then who uses it. Files marked *planned* come with later work packages.
- **Launch check**, **Verified by** (on each use), **Fallback**, **Risk**.
- **Seen working**: macOS builds. **Last lab run**: date, build and what ran.

| # | Name (kind) | Signature | Encoding | Caller | Launch check | Verified by | Fallback | Risk | Seen working | Last lab run |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `SLSMainConnectionID` (function) | `() -> UInt32` | - | every wrapper (`connection()`) | `dlsym` | nonzero | every part off | low | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab; 2026-11-06, 26B123, handoff lab: holds, G1 (lab half), G5, G6, G15 |
| 2 | `SLSNewTransition` (function) | `(UInt32 cid, UnsafeRawPointer spec, UnsafeMutablePointer<Int32> handle) -> Int32`. Spec `{UInt32 version 0, UInt32 type 1, UInt32 option 0, UInt32 window 0, Float* color nil}` (`TransitionSpec`) | - | `SkyLight.freeze()`; `Freezer.swift` `RealFreezer` | `dlsym` | result 0 and a handle | this switch unfrozen; two in a row: freeze off for the session | medium | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab (4 handoffs); 2026-11-06, 26B123, handoff lab: holds pass (no complete frame while frozen), G1 (lab half), G15 |
| 3 | `SLSInvokeTransition` (function) | `(UInt32 cid, Int32 handle, Float duration) -> Int32`, duration 0 | - | `SkyLight.reveal(_:)`; `RealFreezer` and its watchdog (`FreezeCore`, off the main thread) | `dlsym` | result 0 | `SLSReleaseTransition`, freeze off for the session | medium | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab; 2026-11-06, 26B123, handoff lab: holds pass, including the watchdog's reveal from the freezer's own queue |
| 4 | `SLSReleaseTransition` (function) | `(UInt32 cid, Int32 handle) -> Int32` | - | `SkyLight.release(_:)`; `RealFreezer` after a failed reveal | `dlsym` | result 0, logged | logged only: macOS lets go of a freeze at about 2 s | medium | 27.2 (26B123) | 2026-11-05, 26B123, freeze lab |
| 5 | `SLSGetActiveSpace` (function) | `(UInt32 cid) -> UInt64` | - | `SkyLight.activeSpace()` (0 reads as unknown); `SpaceReads.swift` `SkyLightSpaces.activeSpace` (where to show, R1) | `dlsym` | nonzero | spaces off | low | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab; 2026-11-06, 26B123, handoff lab: G15 (every active Space seen during two switches) |
| 6 | `SLSCopySpacesForWindows` (function) | `(UInt32 cid, Int32 mask, CFArray windows) -> Unmanaged<CFArray>?`, mask 7 | - | `SkyLight.spaces(forWindows:mask:)` (nil or not numbers reads as unknown); `SpaceReads.swift` `SkyLightSpaces.spaces(of:)`, one window per call (the parker's verify, R1) | `dlsym` | a list of numbers | unknown: that poll tells nothing | low | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab; 2026-11-06, 26B123, handoff lab: G5, G6, G15 |
| 7 | `SLSCopyManagedDisplaySpaces` (function) | `(UInt32 cid) -> Unmanaged<CFArray>?` (displays: `Display Identifier`, `Spaces` with `id64` and `type`, `Current Space`) | - | `SkyLight.managedDisplaySpaces()`; `SpaceReads.swift` `SkyLightSpaces.displays` (`parseDisplays`; any odd entry makes the read unknown): type-4 Spaces, each display's Desktop, the display count | `dlsym` | a list of dictionaries | unknown; a display count that doesn't read means no freeze for that switch | low | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab; 2026-11-06, 26B123, handoff lab: G5 (displays unchanged after 20 empty Spaces), G15 |
| 8 | `SLSSpaceCreate` (function) | `(UInt32 cid, Int32 kind, CFDictionary? options) -> UInt64`, called `(cid, 1, nil)` | - | `SkyLight.createSpace()` (0 reads as failed); `BridgeParker.swift` `SpaceParker.park`, one per parked window | `dlsym` | nonzero id | park off for the session | medium | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab; 2026-11-06, 26B123, handoff lab: G5 pass (20 empty Spaces, median 1 ms; one per window) |
| 9 | `SLSSpaceDestroy` (function) | `(UInt32 cid, UInt64 space) -> Void` | - | `SkyLight.destroySpace(_:)`; `BridgeParker.swift` `SpaceParker` after a verified show or return, and `destroySpace(of:)` | `dlsym` | none (returns nothing). Gate G5 checks an empty one goes | an empty private Space is left; logged | medium | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab; 2026-11-06, 26B123, handoff lab: G5 pass (destroying an empty one disturbs nothing) |
| 10 | `SLSBridgedSpaceAddWindowsAndRemoveFromSpacesOperation` (class), `-initWithSpaceID:windows:options:` | `(UInt64 space, NSArray<NSNumber> windows, UInt32 options) -> instancetype`, options 7 | `@36@0:8Q16@24I32` | `SkyLight.bridgeAdd(windows:toSpace:options:)`; `BridgeParker.swift` `SpaceParker` park, show and return (through `SkyLightSpaces.add`) | `NSClassFromString`, `instancesRespond(to:)`, `method_getTypeEncoding` equal to the encoding | park: in no user Space and off screen within 300 ms; show: in the active Space within 300 ms; return: in its display's Desktop within 300 ms | retry once; then park off for the session (`docs/HANDOFF.md` §4.3, §4.4) | **high**: Apple closed similar tricks in macOS 14.5 and 15 | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab; 2026-11-06, 26B123, handoff lab: G1 self-test (cross-process), G5, G6, G15 |
| 11 | `SLSBridgedRemoveWindowsFromSpacesOperation` (class), `-initWithWindows:spaces:` | `(NSArray<NSNumber> windows, NSArray<NSNumber> spaces) -> instancetype` | `@32@0:8@16@24` | `SkyLight.bridgeRemove(windows:fromSpaces:)`; `BridgeParker.swift` `SpaceParker` show and return, out of the private Space (through `SkyLightSpaces.remove`) | the same as row 10 | the same as row 10 | the same as row 10 | **high** | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab; 2026-11-06, 26B123, handoff lab: G1 self-test, G5, G6, G15 |
| 12 | `-performWithWMBridgeDelegate` (selector, on both classes) | `() -> Void` | `v16@0:8` on each class | sends rows 10 and 11 (`bridgeAdd`, `bridgeRemove`) | `dlopen` of `WindowManagement.framework` (`/System/Library/PrivateFrameworks/WindowManagement.framework/WindowManagement`), `instancesRespond(to:)` and the encoding on each class | as rows 10 and 11 | park off | **high** | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab; 2026-11-06, 26B123, handoff lab: G1 self-test, G5, G6, G15 |
| 13? | a read listing a private Space's windows (candidate `SLSCopyWindowsWithOptionsAndTags`), or a mask of `SLSCopySpacesForWindows` that includes private Spaces (function) | unknown until gate G5: never called | - | none yet (the parking registry's orphan check, WP4, once G5 passes) | `dlsym` of the candidate, logged as "candidate found"; the part stays off until `PrivateCalls.enumeratorPassedG5` is true | - | no orphan check | unknown | listing found on 27.2 (26B123), not adopted | 2026-11-06, 26B123, handoff lab G5: `SLSCopySpacesForWindows` with any mask that has bit 3 (0xF and up; 0x8 alone doesn't), and `SLSCopyWindowsWithOptionsAndTags` (the lab's declaration, options 0, 2 and 7), list a private Space's window. Mask 7 doesn't, as the verify needs. `PrivateCalls.enumeratorPassedG5` stays false until it's reviewed |

Notes on the rows:

- **Row 12's selector is SkyLight's.** Both classes and their `-performWithWMBridgeDelegate` are implemented in SkyLight (read with `class_getImageName` and `dladdr` on 26B123). `WindowManagement.framework` is still opened and checked: every lab that parked had it loaded, and whether the bridge's delegate needs it hasn't been tested.
- **The bridge's operations are asynchronous** (their superclass is `SLSAsynchronousBridgedWindowManagementOperation`). The labs never released them. `SkyLight` keeps each one for 10 s after it's sent (`KeptOperations`), far past its step's end (two tries of 300 ms), instead of leaking every one. Never by count: a burst (quit's returns, two ops per window) can't release one still in flight. What releasing one mid-flight does is untested.
- **The initializers are called through their implementation** (`method_getImplementation`), with the receiver as a raw pointer: `init` consumes the object `+alloc` made, and may return another. They're never called when the encoding changed: the wrapper is only filled in for parts the check passed.
- **The launch line** says what was found: `private calls on macOS 27.2 (26B123): freeze ok, spaces ok, park ok (9/9 functions, 2/2 classes, 4/4 selectors, encodings ok); enumerator off (candidate found, gate G5) in 0.4 ms`. An off part says why: `park off: -initWithSpaceID:windows:options: encoding changed (…, expected @36@0:8Q16@24I32)`. "4 selectors" counts the perform selector once on each class.
- **The macOS build** (`kern.osversion`) is kept in `UserDefaults` as `MarginPrivateCallsBuild`. A new one adds `private calls: macOS build changed from 26B123 to 26C45: private calls checked again`. Every launch checks everything anyway.
- **The cross-process self-test** at launch (`Margin --park-probe`, `docs/HANDOFF.md` §4.2, `ParkSelfTest` in `BridgeParker.swift`) checks that rows 5-12 really move another process's window: it parks, shows, parks again and returns a hidden 1×1 window of a child copy of Margin, each step verified. Until it passes, parking is off (`Shell.parkingOn`). A failure keeps it off for the run, with one log line: `private calls: park off: the cross-process self-test failed: …`.
- **The freeze can't be verified by the product**: whether the screen really holds still needs a screen capture, and screen recording is ruled out of the mechanism. The lab tool checks it on each macOS beta.

## Also used, not part of the handoff

| Name (kind) | Where | Used for | Check today | Fallback | Risk |
|---|---|---|---|---|---|
| `drawsBackground` (WebKit KVC key on `WKWebView`) | `app/platforms/macos/shell/OverlayWebView.swift` `makeWebView` | a see-through overlay web view | **none**: set unconditionally. `docs/HANDOFF.md` §4.1 says a `responds`/`value(forKey:)` check at launch, logged: still to add | to add: an opaque overlay is better than a crash on an unknown key | low: long-standing and widely used |
| `_AXUIElementGetWindow` (Accessibility function) | `app/engines/webkit/safari/SafariAX.swift` `number(of:)` | a Safari window's Accessibility element → its window-server number (exact binding) | an error or 0 reads as unknown | the window matched by its pages and focus (WindowBinder's other rules) | low: unchanged since about macOS 10.6, used by yabai, Hammerspoon, AltTab |
| `_AXUIElementCreateWithRemoteToken` (Accessibility function), a 20-byte token (pid, 0, "coco", element id) | `app/engines/webkit/safari/SafariAX.swift` `scan(pid:)` | reaching Safari windows on other Spaces | nil or not a window reads as nothing found; 1 s cap | since 2026-11-07 only once per Safari launch, and for a window still unknown 2 s after it's listed, at most every 5 s (`shouldScan`): Safari's Accessibility events give every later window's element; without them, every 0.5 s while one is unknown | medium: an internal token format |
| Safari's `SafariTabs.db` (file format, SQLite) | `app/engines/webkit/safari/SafariProfiles.swift` `read` | Safari's profile names | its schema checked on each read; read only | the names typed in Margin | medium: undocumented schema |
| each profile's `Extensions.plist` (file format, property list) | `app/engines/webkit/safari/SafariProfiles.swift` `marginEntries` | which Safari profile a Margin copy is | its keys checked on each read; read only | no names for that copy | medium |
| Safari's `CloudTabs.db` (file format, SQLite) | `app/engines/webkit/safari/CloudTabs.swift` | iCloud Tabs | its schema checked on each read; read only | no iCloud Tabs folder | medium |

## Considered, not used

- `SLSManagedDisplaySetCurrentSpace`: jumping to B's new Space under the freeze returned 0 but didn't shorten the entry (`RESULTS.md`, 2026-11-05).
- `SLSOrderWindow`, `SLSMoveWindow`, `SLSSetWindowAlpha`, `SLSSetWindowLevel`, `SLSSetWindowTags` and other direct window calls on another process's window: refused across processes with error 1000, or silently ignored (the cross-process lab, `xp.swift`, 2026-11-06).
- `SLSAddWindowsToSpaces`, `SLSRemoveWindowsFromSpaces`, `SLSMoveWindowsToManagedSpace`, `SLSSpaceAddWindowsAndRemoveFromSpaces`, `SLSSetWindowListWorkspace` (the direct, non-bridged Space calls): tried in the same lab. The bridge (rows 10-12) is the form every later lab used to move Safari's windows.
- `SLSBridgedMoveWindowsToManagedSpaceOperation`: replaced by rows 10-11, which give each parked window its own private Space.
- Minimizing, Desktop parking, Accessibility, AppleScript, and screen recording in the mechanism: ruled out (`docs/HANDOFF.md` §0).

## Running the lab on a macOS beta

The lab tool is `tools/handoff-lab/`. Its `README.md` is the runbook. It compiles Margin.app's own `PrivateCalls.swift`, `Freezer.swift`, `SpaceReads.swift` and `BridgeParker.swift`, so it tests what ships. Its gates are `docs/HANDOFF.md` §10.4, plus `holds`.

1. **Ask first.** The lab drives windows on screen. It drives them only in Safari Technology Preview, and only windows it opened itself. Release Safari is reached only through Margin.app's dev hook, which refuses any profile but Test A and Test B. Never another profile.
2. **One dry run first:** `tools/handoff-lab/build/handoff-lab <gates> --dry-run` prints the plan and read-only checks and touches nothing. Nothing runs without `--go`. Then run one gate at a time, and **abort on the first failure** (the lab stops by itself).
3. **`holds` and G1 first.**
   - `holds` checks that the freeze still holds the screen, which the product can't check.
   - G1 is the lab's launch check, the real cross-process self-test, and `holds`. Then Margin.app's half: its signature, its own launch and self-test lines, and with `--dev-hook` one switch. Margin.app must have neither Screen Recording nor Accessibility; that part is checked by hand.
   - If either fails, the freeze and parking stay off.
4. **The freeze-holds check:** the lab records frames with ScreenCaptureKit (the terminal's Screen Recording, the lab only, never Margin.app). While frozen, with a window changing every frame underneath, it must see no complete frame that changed.
5. **Each run appends** to `tools/handoff-lab/results/<build>-<date>.md`: per gate, its status and its numbers. Update this file's "Seen working" and "Last lab run" columns from it, and link the newest report below.
6. **A changed encoding or a missing call** on a beta: record the new encoding here, find whether the call's arguments changed, and only then change `PrivateCalls.selectors`. Never just copy the new encoding in.

The lab makes one call Margin.app doesn't: G5's enumerator search calls row 13's candidate, `SLSCopyWindowsWithOptionsAndTags`, as `(UInt32 cid, UInt32 owner, CFArray spaces, UInt32 options, UInt64 *setTags, UInt64 *clearTags) -> CFArray?`, the signature the window managers that use it declare. It's in `tools/handoff-lab/lab.swift` only.

Latest lab report: [`tools/handoff-lab/results/26B123-2026-11-06.md`](tools/handoff-lab/results/26B123-2026-11-06.md). It covers `holds`, G1's lab half, G5, G6 and G15 on the lab's own and child windows, while the lab was built. No STP or Safari gate has run yet. The earlier scratchpad labs of 2026-11-05 and 2026-11-06 (freeze, park and STP handoff labs on 26B123) are summarised in `docs/HANDOFF.md`.

## What to watch

- The **yabai** and **Hammerspoon** trackers: they use the same SkyLight calls and hear first when a macOS beta breaks them.
- **macOS beta release notes**, for window management, Spaces and full screen.
- Margin's own log on each new build: `/usr/bin/log show --predicate 'subsystem == "com.unibox.margin"' --last 1h | grep 'private calls'`.
