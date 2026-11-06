# Private APIs

Every private macOS call, class, selector, key and file format Margin.app uses. Keep it up to date with every change to one of them. The design is in `app/HANDOFF.md` §4 and §8.2. The code is `app/shell/PrivateCalls.swift`.

## The rule

**No private call without a fallback and a launch check.**

- Each call is looked up at launch, before the shell starts (`PrivateCalls.check`, called from `AppDelegate.startShell` through `Shell.checkPrivateCalls`).
- Anything missing, or a type encoding that changed, turns that part off for the whole run. The person gets no notice. The log gets one line.
- Every real call is verified when it's used (`app/HANDOFF.md` §4.3). A call that didn't land is retried once at most, then the part is off for the session.
- Every Copy function is declared as returning `Unmanaged<CFArray>?`. Nil means "unknown", never a crash.
- Tests never call a real private function and never freeze the screen:
  - the real resolver (`RealPrivateResolver`) is made only in `Shell.forApp()`;
  - it and every wrapper (`SkyLight`) refuse to run when `MARGIN_APP_TESTS` is set, and `tools/app-tests/run.sh` sets it;
  - tests use a fake resolver whose "functions" are their own (`tools/app-tests/private-calls-tests.swift`).
- The log holds names, counts, results and milliseconds only. Never a title, an address or a page's words. Nothing is sent anywhere.

## The parts

| Part | Needs | Off means |
|---|---|---|
| **freeze** | rows 1-4 | the switch runs without a freeze: the person sees macOS's slide |
| **spaces** | rows 1, 5-7 | no readiness reads and no parking: today's close-based switch |
| **park** | spaces, rows 8-12, both encodings | `close` (drafts permitting) or `keep` (`app/HANDOFF.md` §1.1) |
| **enumerator** | row 13, and gate G5 passed | no orphan check of private Spaces (`app/HANDOFF.md` §4.4 invariant 3) |

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
| 1 | `SLSMainConnectionID` (function) | `() -> UInt32` | - | every wrapper (`connection()`) | `dlsym` | nonzero | every part off | low | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab |
| 2 | `SLSNewTransition` (function) | `(UInt32 cid, UnsafeRawPointer spec, UnsafeMutablePointer<Int32> handle) -> Int32`. Spec `{UInt32 version 0, UInt32 type 1, UInt32 option 0, UInt32 window 0, Float* color nil}` (`TransitionSpec`) | - | `SkyLight.freeze()`; `Freezer.swift` `RealFreezer` | `dlsym` | result 0 and a handle | this switch unfrozen; two in a row: freeze off for the session | medium | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab (4 handoffs) |
| 3 | `SLSInvokeTransition` (function) | `(UInt32 cid, Int32 handle, Float duration) -> Int32`, duration 0 | - | `SkyLight.reveal(_:)`; `RealFreezer` and its watchdog (`FreezeCore`, off the main thread) | `dlsym` | result 0 | `SLSReleaseTransition`, freeze off for the session | medium | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab |
| 4 | `SLSReleaseTransition` (function) | `(UInt32 cid, Int32 handle) -> Int32` | - | `SkyLight.release(_:)`; `RealFreezer` after a failed reveal | `dlsym` | result 0, logged | logged only: macOS lets go of a freeze at about 2 s | medium | 27.2 (26B123) | 2026-11-05, 26B123, freeze lab |
| 5 | `SLSGetActiveSpace` (function) | `(UInt32 cid) -> UInt64` | - | `SkyLight.activeSpace()` (0 reads as unknown); `SpaceReads.swift` `SkyLightSpaces.activeSpace` (where to show, R1) | `dlsym` | nonzero | spaces off | low | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab |
| 6 | `SLSCopySpacesForWindows` (function) | `(UInt32 cid, Int32 mask, CFArray windows) -> Unmanaged<CFArray>?`, mask 7 | - | `SkyLight.spaces(forWindows:mask:)` (nil or not numbers reads as unknown); `SpaceReads.swift` `SkyLightSpaces.spaces(of:)`, one window per call (the parker's verify, R1) | `dlsym` | a list of numbers | unknown: that poll tells nothing | low | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab |
| 7 | `SLSCopyManagedDisplaySpaces` (function) | `(UInt32 cid) -> Unmanaged<CFArray>?` (displays: `Display Identifier`, `Spaces` with `id64` and `type`, `Current Space`) | - | `SkyLight.managedDisplaySpaces()`; `SpaceReads.swift` `SkyLightSpaces.displays` (`parseDisplays`; any odd entry makes the read unknown): type-4 Spaces, each display's Desktop, the display count | `dlsym` | a list of dictionaries | unknown; a display count that doesn't read means no freeze for that switch | low | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab |
| 8 | `SLSSpaceCreate` (function) | `(UInt32 cid, Int32 kind, CFDictionary? options) -> UInt64`, called `(cid, 1, nil)` | - | `SkyLight.createSpace()` (0 reads as failed); `BridgeParker.swift` `SpaceParker.park`, one per parked window | `dlsym` | nonzero id | park off for the session | medium | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab |
| 9 | `SLSSpaceDestroy` (function) | `(UInt32 cid, UInt64 space) -> Void` | - | `SkyLight.destroySpace(_:)`; `BridgeParker.swift` `SpaceParker` after a verified show or return, and `destroySpace(of:)` | `dlsym` | none (returns nothing). Gate G5 checks an empty one goes | an empty private Space is left; logged | medium | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab |
| 10 | `SLSBridgedSpaceAddWindowsAndRemoveFromSpacesOperation` (class), `-initWithSpaceID:windows:options:` | `(UInt64 space, NSArray<NSNumber> windows, UInt32 options) -> instancetype`, options 7 | `@36@0:8Q16@24I32` | `SkyLight.bridgeAdd(windows:toSpace:options:)`; `BridgeParker.swift` `SpaceParker` park, show and return (through `SkyLightSpaces.add`) | `NSClassFromString`, `instancesRespond(to:)`, `method_getTypeEncoding` equal to the encoding | park: in no user Space and off screen within 300 ms; show: in the active Space within 300 ms; return: in its display's Desktop within 300 ms | retry once; then park off for the session (`app/HANDOFF.md` §4.3, §4.4) | **high**: Apple closed similar tricks in macOS 14.5 and 15 | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab |
| 11 | `SLSBridgedRemoveWindowsFromSpacesOperation` (class), `-initWithWindows:spaces:` | `(NSArray<NSNumber> windows, NSArray<NSNumber> spaces) -> instancetype` | `@32@0:8@16@24` | `SkyLight.bridgeRemove(windows:fromSpaces:)`; `BridgeParker.swift` `SpaceParker` show and return, out of the private Space (through `SkyLightSpaces.remove`) | the same as row 10 | the same as row 10 | the same as row 10 | **high** | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab |
| 12 | `-performWithWMBridgeDelegate` (selector, on both classes) | `() -> Void` | `v16@0:8` on each class | sends rows 10 and 11 (`bridgeAdd`, `bridgeRemove`) | `dlopen` of `WindowManagement.framework` (`/System/Library/PrivateFrameworks/WindowManagement.framework/WindowManagement`), `instancesRespond(to:)` and the encoding on each class | as rows 10 and 11 | park off | **high** | 27.2 (26B123) | 2026-11-06, 26B123, STP handoff lab |
| 13? | a read listing a private Space's windows (candidate `SLSCopyWindowsWithOptionsAndTags`), or a mask of `SLSCopySpacesForWindows` that includes private Spaces (function) | unknown until gate G5: never called | - | none yet (the parking registry's orphan check, WP4, once G5 passes) | `dlsym` of the candidate, logged as "candidate found"; the part stays off until `PrivateCalls.enumeratorPassedG5` is true | - | no orphan check | unknown | - | not run (G5) |

Notes on the rows:

- **Row 12's selector is SkyLight's.** Both classes and their `-performWithWMBridgeDelegate` are implemented in SkyLight (read with `class_getImageName` and `dladdr` on 26B123). `WindowManagement.framework` is still opened and checked: every lab that parked had it loaded, and whether the bridge's delegate needs it hasn't been tested.
- **The bridge's operations are asynchronous** (their superclass is `SLSAsynchronousBridgedWindowManagementOperation`). The labs never released them. `SkyLight` keeps the last 16 alive (`KeptOperations`) instead of leaking every one.
- **The initializers are called through their implementation** (`method_getImplementation`), with the receiver as a raw pointer: `init` consumes the object `+alloc` made, and may return another. They're never called when the encoding changed: the wrapper is only filled in for parts the check passed.
- **The launch line** says what was found: `private calls on macOS 27.2 (26B123): freeze ok, spaces ok, park ok (9/9 functions, 2/2 classes, 4/4 selectors, encodings ok); enumerator off (candidate found, gate G5) in 0.4 ms`. An off part says why: `park off: -initWithSpaceID:windows:options: encoding changed (…, expected @36@0:8Q16@24I32)`. "4 selectors" counts the perform selector once on each class.
- **The macOS build** (`kern.osversion`) is kept in `UserDefaults` as `MarginPrivateCallsBuild`. A new one adds `private calls: macOS build changed from 26B123 to 26C45: private calls checked again`. Every launch checks everything anyway.
- **The cross-process self-test** at launch (`Margin --park-probe`, `app/HANDOFF.md` §4.2, `ParkSelfTest` in `BridgeParker.swift`) checks that rows 5-12 really move another process's window: it parks, shows, parks again and returns a hidden 1×1 window of a child copy of Margin, each step verified. Until it passes, parking is off (`Shell.parkingOn`). A failure keeps it off for the run, with one log line: `private calls: park off: the cross-process self-test failed: …`.
- **The freeze can't be verified by the product**: whether the screen really holds still needs a screen capture, and screen recording is ruled out of the mechanism. The lab tool checks it on each macOS beta.

## Also used, not part of the handoff

| Name (kind) | Where | Used for | Check today | Fallback | Risk |
|---|---|---|---|---|---|
| `drawsBackground` (WebKit KVC key on `WKWebView`) | `app/shell/OverlayWebView.swift` `makeWebView` | a see-through overlay web view | **none**: set unconditionally. `app/HANDOFF.md` §4.1 says a `responds`/`value(forKey:)` check at launch, logged: still to add | to add: an opaque overlay is better than a crash on an unknown key | low: long-standing and widely used |
| Safari's `SafariTabs.db` (file format, SQLite) | `app/shell/SafariProfiles.swift` `read` | Safari's profile names | its schema checked on each read; read only | the names typed in Margin | medium: undocumented schema |
| each profile's `Extensions.plist` (file format, property list) | `app/shell/SafariProfiles.swift` `marginEntries` | which Safari profile a Margin copy is | its keys checked on each read; read only | no names for that copy | medium |
| Safari's `CloudTabs.db` (file format, SQLite) | `app/shell/CloudTabs.swift` | iCloud Tabs | its schema checked on each read; read only | no iCloud Tabs folder | medium |

## Considered, not used

- `SLSManagedDisplaySetCurrentSpace`: jumping to B's new Space under the freeze returned 0 but didn't shorten the entry (`RESULTS.md`, 2026-11-05).
- `SLSOrderWindow`, `SLSMoveWindow`, `SLSSetWindowAlpha`, `SLSSetWindowLevel`, `SLSSetWindowTags` and other direct window calls on another process's window: refused across processes with error 1000, or silently ignored (the cross-process lab, `xp.swift`, 2026-11-06).
- `SLSAddWindowsToSpaces`, `SLSRemoveWindowsFromSpaces`, `SLSMoveWindowsToManagedSpace`, `SLSSpaceAddWindowsAndRemoveFromSpaces`, `SLSSetWindowListWorkspace` (the direct, non-bridged Space calls): tried in the same lab. The bridge (rows 10-12) is the form every later lab used to move Safari's windows.
- `SLSBridgedMoveWindowsToManagedSpaceOperation`: replaced by rows 10-11, which give each parked window its own private Space.
- Minimizing, Desktop parking, Accessibility, AppleScript, and screen recording in the mechanism: ruled out by Tirth (`app/HANDOFF.md` §0).

## Running the lab on a macOS beta

The lab tool is `tools/handoff-lab/` (WP13; not built yet). It compiles `PrivateCalls.swift`'s declarations, so it tests what ships. Its gates are `app/HANDOFF.md` §10.4.

1. **Ask Tirth first.** The lab drives windows on screen. Only with his go-ahead, only in Safari Technology Preview or in release Safari's Test A and Test B profiles, never another profile.
2. **One dry run first** (`--dry-run` prints the plan and touches nothing). Then run one gate at a time, and **abort on the first failure**.
3. **G1 first**: the freeze and a cross-process bridge park and show from a Developer-ID, hardened Margin.app build, with Screen Recording and Accessibility denied. If it fails, the freeze and parking stay off.
4. **The freeze-holds check**: the lab records frames with ScreenCaptureKit (Screen Recording for the lab tool only, never for Margin.app) and counts changed frames while frozen. The product can't do this.
5. **Each run writes** `tools/handoff-lab/results/<build>-<date>.md`: per gate, pass or fail and the numbers. Update this file's "Seen working" and "Last lab run" columns from it, and link the newest report below.
6. **A changed encoding or a missing call** on a beta: record the new encoding here, find whether the call's arguments changed (the lab's probe), and only then change `PrivateCalls.selectors`. Never just copy the new encoding in.

Latest lab reports: none in the repo yet. The scratchpad labs of 2026-11-05 and 2026-11-06 (freeze, park and STP handoff labs on 26B123) are summarised in `app/HANDOFF.md`.

## What to watch

- The **yabai** and **Hammerspoon** trackers: they use the same SkyLight calls and hear first when a macOS beta breaks them.
- **macOS beta release notes**, for window management, Spaces and full screen.
- Margin's own log on each new build: `/usr/bin/log show --predicate 'subsystem == "io.tirth.margin"' --last 1h | grep 'private calls'`.
