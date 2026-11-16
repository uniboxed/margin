# Window traffic-light research lab

The request is to hide close, minimise and zoom/fullscreen buttons while keeping third-party apps
in ordinary windowed mode, using Accessibility and private macOS APIs. This spike is isolated from
Margin.app. Read the findings and proposed architecture in [the research report](../../docs/TRAFFIC-LIGHTS-RESEARCH.md).

**Finding:** private AppKit hiding works in the owned window and now in real Chrome for Testing through
a temporary launch-loaded library, with verified pixels, resize and restoration. Installed protected
Chrome did not load that library. AX writes and foreign clipping did not change the native controls.
This is a bounded Chromium backend, not general external Safari/Chrome/Edge support.

## Real Chromium launch-loaded backend

```sh
clang -dynamiclib -fobjc-arc -Wall -Wextra -Werror -framework AppKit tools/traffic-lights-lab/launch-hook.m -o /tmp/margin-launch-hook.dylib
swiftc -parse-as-library -warnings-as-errors tools/traffic-lights-lab/visual.swift -o /tmp/margin-launch-visual
/tmp/margin-launch-visual --case launch --library /tmp/margin-launch-hook.dylib --output /absolute/new/run
/tmp/margin-launch-visual --case launch --library /tmp/margin-launch-hook.dylib --output /absolute/new/run --run
python3 tools/traffic-lights-lab/verify-launch.py /absolute/new/run
```

The first invocation prints a plan. The opt-in run requires 25G342, AX and capture access, and the
already installed `~/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app`.
It refuses an already running target. The observed bundle ID is `com.google.chrome.for.testing`.
No browser is downloaded. The temporary dylib is explicitly inserted at launch; the browser bundle,
signature and system protections are unchanged. The native button lookup/hide calls are private APIs.
This mode requires a binary that permits loading; the same library did not load in installed Chrome.

The library binds the exact executable, clears its insertion environment before helper launches,
validates selector ABIs, saves original states, operates on the selected native window, reapplies on
its resize, and restores on command or a 45-second deadline. It does not swizzle. Main-thread file
polling is bounded research instrumentation. The accepted video proves hide/resize/restore only;
titlebar replacement, crashes and general browser stability remain unvalidated.

Raw PNGs/timestamps/MP4, annotated `launch.mp4` and the initial failed bundle-discovery run remain at
`test-results/traffic-lights-launch-2026-11-16/`. Committed evidence and hashes are in
`results/launch-25G342/`. The verifier independently decodes raw-video titlebar pixels and checks native
hidden/hit states, matching process/window identity, windowed state, restoration, resize and cleanup.
Use the existing `video-bands.swift` build plus `render-recordings.py RUN BANDS_EXECUTABLE` to annotate.

## Deeper AX loader and transaction ownership probes

```sh
swiftc -warnings-as-errors tools/traffic-lights-lab/deeper.swift -o /tmp/margin-deeper
/tmp/margin-deeper
/tmp/margin-deeper --run --output /absolute/nonexistent/directory
swiftc -warnings-as-errors tools/traffic-lights-lab/bundle-policy.swift -o /tmp/margin-bundle-policy
/tmp/margin-bundle-policy
/tmp/margin-bundle-policy --run
```

The first probe creates one visible owned fixture, requests remote accessibility-bundle loading,
then compares owner and foreign transaction clipping with independent native state and pixels. It
requires positive settled geometry agreeing with AppKit and successful owner restoration before
attempting foreign clipping. Only the owned child is affected; there is a bounded emergency exit.
Run-1/run-2 were invalid due to zero initial geometry; run-3 has a valid partial owner clip and no
foreign effect. The requirement decoder is read-only and refuses other builds/architectures; its
cache-relative offset and expected bytes are specific to this host. It decodes `anchor apple`, not a
general entitlement bypass. Disassembly excerpts and compact observations accompany the saved result.

## Reproduce the owned-process experiment

```sh
swiftc -warnings-as-errors tools/traffic-lights-lab/probe.swift -o /tmp/margin-buttons-probe
/tmp/margin-buttons-probe             # dry run; no windows
/tmp/margin-buttons-probe --run       # requires AX access; exactly one owned invisible window
```

The probe refuses builds other than **25G342**. It checks selector encodings before calling private
methods. An owned child finishes AppKit launch, creates a transparent, off-screen window, and serves
native-state observations while the parent tries AX writes. Parent and child independently use
WindowServer clip readback; ownership is checked against the exact child PID. The parent then permits
the child to test private reveal and individual-button hiding, resize, restore and close. Instrumentation
uses public AppKit getters/window creation; the proposed native hiding operations and button lookup
use private selectors. Fixture IPC provides observations, not a way to execute code inside another app.

The fixture overrides AppKit's frame constraint and checks transparency/off-screen placement before
and after ordering and each observation. It never requests activation, capture, a real browser, a Space
switch, a setting change or screen-control privileges. The child has a 12-second wait for the controller;
each process has a 20-second emergency exit. A controlled refusal terminates the owned child.

## Reproduce the browser attribute observation

```sh
swiftc -warnings-as-errors tools/traffic-lights-lab/browser-probe.swift -o /tmp/margin-buttons-browser
/tmp/margin-buttons-browser --executable /absolute/path/to/Chromium
/tmp/margin-buttons-browser --executable /absolute/path/to/Chromium --run
```

The first command invocation prints the plan; the second opens **one visible about:blank window** in a
new temporary profile. Use a test Chromium executable, not a command that redirects to an existing
user session. It requires exactly one AX window belonging to its launched PID, queries attributes,
attempts AXHidden/AXEnabled and restores them, closes the owned window through AX, terminates the exact
launched PID, removes its profile and requests restoration of the former foreground app through AX.
By default no extension, browser automation protocol or injection is used. The optional
`--launch-library /absolute/hook.dylib` argument tests loader acceptance in the owned browser, writes
child-specific DYLD environment variables and checks a PID-bound loaded marker after discovery plus
one second; it sends no component commands. There is an eight-second window
discovery bound and an 18-second termination timer. Run once and stop on a refusal; inspect the evidence
before changing setup. The recorded run completed normally. The runner is not a general browser manager.

## Recorded evidence

- `results/owned-25G342.jsonl`: completed current owned-process probe; native state and hit testing.
- `results/chromium-25G342.jsonl`: one Chromium 156.0.8078.4 window; AX observations and cleanup.
- `results/failed-discovery-25G342.jsonl`: earlier failed fixture discovery, retained as failure.
- `results/manifest.json`: hashes and environment for the completed observations.
- `python3 tools/traffic-lights-lab/verify.py`: checks the saved state, restoration and cleanup and
  confirms that a fabricated native change is rejected. It does not run desktop experiments.

Earlier geometry guards rejected initial fixture placement: ordinary AppKit construction/ordering
constrained the frame back onto a display, despite the requested negative coordinates. Alpha was zero.
The final fixture override fixes the setup rather than removing the guard. The separate failed AX
discovery run had not finished AppKit launching; it stopped before mutation. `finishLaunching()` and
normal NSWindow construction made that owned window discoverable. These failures are not positive results.

Disassembly was performed with Apple's cache-aware `dyld_info`, and selector/type enumeration with
Objective-C runtime APIs. Hopper/REA were not available in this session. For example:

```sh
xcrun dyld_info -exports /System/Library/PrivateFrameworks/SkyLight.framework/SkyLight
xcrun dyld_info -disassemble /System/Library/PrivateFrameworks/SkyLight.framework/SkyLight
xcrun dyld_info -disassemble /System/Library/Frameworks/AppKit.framework/AppKit
```

Inspect `SLSSetWindowClipShape`, `SLSCopyWindowClipShape`, `-[NSThemeFrame setButtonRevealAmount:]`,
`-[NSView _setHidden:setNeedsDisplay:]` and `-[NSWindow _findStandardWindowButton:]`. A symbol's presence
is not evidence of cross-process authority. Neither return code zero nor an AX readback alone proves
visual disappearance. The initial probe does not capture pixels. The visual follow-up below adds
actual recordings, including a negative external AX result in Edge.

## Visual follow-up: native demo, Chrome, Edge and TextEdit

```sh
swiftc -parse-as-library -warnings-as-errors tools/traffic-lights-lab/visual.swift -o /tmp/margin-buttons-visual
/tmp/margin-buttons-visual --case chrome --output /absolute/new/output/directory
/tmp/margin-buttons-visual --case chrome --output /absolute/new/output/directory --run
```

Original cases are `native`, `chrome`, `edge`, and `textedit`; default is dry run. External apps must not already
be running. Browser profiles are temporary. TextEdit gets one temporary text file in a fresh instance
with restoration suppressed only by its launch argument. Each case shows baseline, hide request,
resize while held, and restoration, then closes only its owned window/process. `/usr/bin/open` is used
only to launch the TextEdit document; external hiding and resizing use AX. No browser extension,
automation protocol, plugin or injected code is used.

SCK window sharing replaced the external apps' traffic lights with a sharing capsule before any AX
mutation. Child-window inclusion and a display-bound window filter did not fix this observer effect.
Those invalid-baseline recordings are retained separately, never counted as button hiding or as valid
negative visibility evidence. No privacy indicator or setting was disabled.

Accepted external recordings instead sample only the exact owned window with `SLSHWCaptureWindowList`,
option `0x0200` (nominal resolution), after checking Screen Recording permission. Every frame rechecks
its owner PID. Every PNG and monotonic timestamp is retained; ffmpeg encodes the measured durations.
Actual sampling rates are about seven fps, not a 30 fps performance claim. The native positive control
uses a 30 fps exact-window SCK stream. No audio or full desktop is captured. Public SCK and AppKit
getters/fixture creation are instrumentation; the hiding mechanism remains AX/private AppKit only.

The local media is under `test-results/traffic-lights-visual-2026-11-16/` (ignored by Git).
`comparison.mp4` joins native, Chrome, Edge and TextEdit. The four named `.mp4` files are individual
presentations; labels and a magnifier are outside the original window pixels. Raw recordings, PNGs,
timestamps and recorded source snapshots are retained. Native recording-start callback timing is not
frame-perfect synchronization; no latency measurement is claimed.

```sh
swiftc -warnings-as-errors tools/traffic-lights-lab/video-bands.swift -o /tmp/margin-video-bands
python3 tools/traffic-lights-lab/render-recordings.py /absolute/run/directory /tmp/margin-video-bands
python3 tools/traffic-lights-lab/verify-visual.py /absolute/run/directory
```

The renderer expects the native source at the root and accepted external sources under `sampled/`.
The verifier checks native hidden/hit states, decoded pixel differences, red/yellow/green pixels in
every external phase, windowed state, timestamps and cleanup. It is scoped to these fixtures, not a
general image classifier. Committed metadata and hashes are under `results/visual-25G342/`.
The native recording predates external capture corrections; its original source snapshot is preserved.
Earlier failed discovery and sharing-capsule recordings remain separate. All accepted external clips
show controls remaining visible under AXHidden, including through resize; private native hiding works
only in the owned test app.
