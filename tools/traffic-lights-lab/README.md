# Window traffic-light research lab

The request is to hide close, minimise and zoom/fullscreen buttons while keeping third-party apps
in ordinary windowed mode, using Accessibility and private macOS APIs. This spike is isolated from
Margin.app. Read the findings and proposed architecture in [the research report](../../docs/TRAFFIC-LIGHTS-RESEARCH.md).

**Finding:** a private in-process AppKit path works on the tested owned window. An external AX client
did not change its native buttons. External clipping returned success without changing the clip.
This is not a working external Safari/Chrome/Edge button-hiding feature.

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
No extension, browser automation protocol or injection is used. There is an eight-second window
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
visual disappearance. No pixel capture or real Safari/Edge hiding is claimed.
