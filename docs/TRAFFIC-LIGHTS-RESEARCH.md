# Hiding window traffic lights without fullscreen

The target is the three close, minimise and zoom/fullscreen buttons, leaving the macOS menu bar,
window title and other application chrome alone. Research is restricted to Accessibility and private
macOS APIs for control. No product behavior is changed by this spike.

**There is a tested private AppKit solution when code runs inside the window-owning process. No
working general external solution was found for another application's native buttons.** Accessibility
permission enables inspection and actions; the tested setters did not provide native view visibility
control. This is a measured limit of the tested routes, not proof that no undiscovered private route exists.

The distinction matters for Margin: a successful call inside a helper's own window does not establish
that Margin can change Safari's NSButton objects. The recommended shipping decision is to keep native
buttons for unsupported external apps, and use an actual in-process backend only for cooperating hosts.
Covering the button region remains a separate possible visual treatment, with different guarantees.

## Environment and method

The actual host reported **macOS 26.7.3, build 25G342, arm64**, with SIP enabled and an ordinary
non-root caller (UID 503). Previous repository experiments used
26B131; their results are not reused as evidence for this build. AX access was initially absent and
was successfully rechecked after the permission was granted.

The investigation combined primary-source reading, runtime method/encoding inspection, local
cache-aware disassembly, an independently controlled child process, native view/hit-test readback,
WindowServer region readback, and one normal Chromium window. Tools were `swiftc`, Objective-C runtime
APIs, `dlsym`, `dyld_info` and `codesign`. No live application debugger attachment was performed.

The owned fixture is fully transparent and off every screen. Its AppKit getters and fixture IPC are
measurement infrastructure. Its successful button lookup/hide path uses private selectors. The browser
test launched **Chromium/Google Chrome for Testing 156.0.8078.4**, from the already installed Playwright
cache, in a disposable profile with no extension or CDP. Only its own blank window was manipulated.
Browser launching/profile isolation are setup, not a proposed method of hiding buttons.

Raw observations, executable/source hashes and reproduction commands are in
[`tools/traffic-lights-lab`](../tools/traffic-lights-lab/README.md). Native probes are not automatically
included in the app or ordinary test suite.

## Observations

| Route | Actual observation | Conclusion |
| --- | --- | --- |
| AX button discovery | Close/minimise/zoom handles found in the owned NSWindow; Chromium also exposes AXFullScreenButton | Useful identities and actions; a handle is not a remote NSButton pointer |
| AX visibility and enable writes | Settable query returns false. AXHidden and AXEnabled writes nevertheless return zero. Independent owned-process readback shows all three buttons unchanged | Return-code success is insufficient; the tested AX path does not hide them |
| AX in Chromium | AXHidden read remains attributeUnsupported; AXEnabled remains true after a false write, despite successful write/restore codes | Same false-success pattern; no demonstrated external visibility control |
| Private AppKit reveal | `NSThemeFrame.setButtonRevealAmount(0)` changes all three button alphas to zero and disables them; survives resize, restores to alpha one/enabled | Works in-process but also targets other titlebar objects |
| Private individual view hide | `_findStandardWindowButton:` then `_setHidden:setNeedsDisplay:` produces hidden=true and nativeHit=false for all three, including after resize; restoration returns original state | Narrower tested in-process solution |
| External WindowServer clip | `SLSSetWindowClipShape` returns zero; independently copied region remains 600×430 | No cross-process effect in this controlled ordinary client |
| Owner WindowServer clip | Same function in child changes clip to `{0,50,600,380}`, restores correctly | Positive control confirms the region/call/readback path works for the owner |

The owned experiment records actual NSView hidden state, alpha, enabled state and native hit testing
**during** each successful external AX write, before restoration. In all six close/minimise/zoom
AXHidden/AXEnabled attempts the native button state equals baseline. The initial version only observed
after restoration; it was insufficient and was replaced with this stronger experiment.

AXFullScreenButton is absent on the generic fixture and present in Chromium. There are still only
three physical traffic lights; a fullscreen attribute should not be assumed to denote a fourth button.
Actions such as AXPress or AXShowMenu operate the control; they do not expose a hide operation.

All recorded fixture phases stay outside native fullscreen. The Chromium window reports fullscreen=false
before and after its tests, its AX close action succeeds, the launched process exits, its temporary
profile is removed, and restoring the previous foreground app returns success. These are metadata
observations from the initial spike; the visual follow-up below adds independently decoded pixels.

## The private method that works, and its boundary

For a window whose process is under our control:

1. On the AppKit main thread, resolve `-[NSWindow _findStandardWindowButton:]` and check its encoding
   (`@24@0:8Q16` on this build). Query button kinds 0, 1 and 2.
2. Save each exact button object's original hidden state. Check
   `-[NSView _setHidden:setNeedsDisplay:]` has encoding `v24@0:8B16B20`.
3. Call that private method on each button with `(true, true)`. Do not change the window style mask
   or enter fullscreen. The test confirms the buttons become hidden and stop winning hit tests.
4. Restore the original per-button state when relinquishing control. Do not blindly unhide a button
   that the host had already hidden. Reacquire objects if the application rebuilds the titlebar.

The executable probe contains the actual ABI-checked implementation, rather than pseudocode that
casts a remote AX handle to an Objective-C view. Public AppKit getters in the probe independently
verify the result. The hide operation itself and its button lookup are private.

`setButtonRevealAmount:` is a useful positive control but a poorer candidate for this precise request.
Local disassembly shows it applying alpha to other titlebar objects, including the title field,
document/file-related controls and other widgets. Its successful traffic-light result should not be
interpreted as preserving everything else in an arbitrary app's titlebar.

**The missing capability is executing that code inside an unmodified third-party app.** Loading AppKit
in Margin creates access to Margin's objects, not Safari's. AX identifies remote accessibility elements
and dispatches supported accessibility requests. Merely discovering a private NSView selector does not
give an external client a general remote Objective-C invocation facility.

An existing [traffic-light hiding plugin implementation](https://github.com/shishkabibal/StopStoplightLight/blob/main/StopStoplightLight/StopStoplightLight.m)
demonstrates the same process boundary: it swizzles the host's NSWindow ordering method and hides the
host's buttons from inside that host. This supports the architecture, not a claim of modern protected
Safari compatibility. Its actual hiding uses a public NSButton property, so it is not itself the
private-only implementation tested here. [Electron's own traffic-light controls](https://github.com/electron/electron/blob/main/docs/tutorial/custom-title-bar.md)
also concern windows owned by the Electron application.

Local signature/entitlement inspection found library validation on installed Safari, Chrome and Edge.
Chrome/Edge also show hardened-runtime flags; none of the three main executables exposes a
disable-library-validation, allow-dyld-environment-variables or get-task-allow exception in the inspected
entitlements. This is evidence against treating arbitrary plugin loading as an ordinary deployment path;
it is not an exhaustive exploit or entitlement-chain analysis. Apple's
[library validation documentation](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-library-validation)
explains the signing boundary. AX permission does not remove it. No binary was patched, re-signed or
injected, and no system protection was changed in this research.

## Why the other private calls are not a substitute

Local disassembly of `SLSSetWindowClipShape` obtains a mapped window implementation through the caller's
main connection. When none is obtained, it still reaches a zero return. That matches the independent
foreign-window readback: the call looks successful but does nothing. The child-owned positive control
changes and restores the same kind of region correctly. This bounds the conclusion to the tested
function/connection/OS; privileged connections and other transaction APIs were not proven equivalent.

Even successful clipping would remove pixels from the window region, rather than make the app redraw
its titlebar background in place of the buttons. Event geometry, shadows and application layout would
still need verification. Whole-window opacity, shape and tags are not a demonstrated per-button hide API.
Historical [CoreGraphics window declarations](https://github.com/NUIKit/CGSInternal/blob/master/CGSWindow.h)
describe the owner restriction on most window-property changes; current local readback is stronger
evidence here than assuming historical headers establish today's behavior.

The exported names `SLSAddButtonRegionInWindow` and `SLSClearButtonRegionInWindow` are tempting. Their
local disassembly dispatches to region setters/subregion operations, not a demonstrated AppKit view
visibility mutation. No visual-hiding capability is inferred from the word “Button.” They were not
called on user windows. No blind window-tag/property-key brute force was performed.

## A concrete architecture for Margin

Use a capability result that distinguishes **native hidden**, **visually covered**, **unsupported**
and **failed/restored**. Do not persist a boolean “hidden” merely because an AX call returned zero.

- **In-process native backend:** useful only where we own the app/window or have an explicitly supported
  host integration. Resolve/check selectors once per process/build, bind each window's actual button
  objects, save original state, hide only those buttons, and restore on detach. Revalidate when the
  titlebar is recreated. A cooperating component can report state to Margin, but it must already have
  a legitimate execution path inside the host. No such Safari integration was established.
- **External AX controller:** identify each window by live owner PID plus process lifetime and native
  window number (`_AXUIElementGetWindow`), observe creation/destruction/geometry changes, and use button
  geometry for any UI that needs it. Revoke capabilities on process restart, stale elements, unknown
  identity or failed reads. An AX handle alone never selects the native backend.
- **Optional visual cover:** integrate an opaque patch into a Margin-owned titlebar/theme surface and
  keep it positioned above the exact target window. This can conceal pixels and intercept clicks; it
  does not remove native controls or their AX semantics. A transparent overlay cannot erase the
  buttons. Matching a translucent/glass titlebar with a small flat patch is unreliable. Cover stacking,
  occlusion, drag/resize, Mission Control and display changes need a separate native experiment. This
  backend was neither implemented nor validated here, and is not presented as exact native hiding.

For arbitrary unmodified Safari/Chrome/Edge, **unsupported is the honest current result for native
button removal**. The viable exact solution is a cooperating in-process implementation. If the product
goal only requires that users not see/click the original lights under Margin's own opaque chrome, the
cover design is the next bounded research target. That is a different guarantee and must be labelled.

## Verification still required

The visual follow-up now checks the owned private solution on screen with the complete titlebar intact
and restoration through resize. It still needs repeated titlebar reconstruction/tabbing, active/inactive
and hover behavior, and crash/detach restoration in a real cooperating host. The follow-up supplies pixels
for Chrome, Edge and TextEdit. Real Safari behavior remains untested.
Other macOS builds, multiple displays, Spaces/Mission Control, RTL layouts, scaled displays and custom
traffic-light implementations remain unvalidated. The current implementation stays research-only.

The three main limitations are the **process-execution boundary**, **private-ABI/host-specific behavior**,
and **lack of a working native hide backend in unmodified third-party apps**.

## Repository validation

Both Swift probes compile with warnings as errors, and the saved-evidence validator passes its native
state, restoration, cleanup and false-success rejection checks. `npm test` passes all **1,031** tests
after restoring the locked dependencies with `npm ci --ignore-scripts` (the initial environment lacked
Node type definitions).

`npm run test:e2e` was attempted but cannot complete in this installation: the pinned Playwright needs
Chromium revision 1254 and WebKit revision 2388, neither of which is installed. The run was terminated
after setup failures and stalled teardown; it is not a passing full-suite run. No browser was downloaded.
The existing WebKit 2287 was tried separately and fails protocol negotiation at
`Page.overrideSetting: Unknown setting: PushAPIEnabled`; it is not a valid fallback for this client.

Using only an uncommitted temporary executable-path adapter, the existing Chromium 1248 successfully
runs the Chromium-only `chrome-build.test.ts` and `site.test.ts`: **19/19 pass**. This is a partial run
with installed Chromium 156.0.8078.4, not equivalent to the complete 150-test suite and not validation
of native hiding. The adapter changes only Playwright launch executable paths; source/lockfiles and
test assertions are unchanged. No production browser behavior was modified to make tests pass.

## Visual follow-up (2026-11-16)

Four accepted recordings now show baseline, hide request, resize and restoration on the same 25G342
host. Native state or successful AXFullScreen reads confirm all recorded phases stay windowed.

| App | Control path | Accepted visual result |
| --- | --- | --- |
| Native AppKit test app | Private in-process button lookup/hidden setter | Three controls disappear, stay hidden through resize and return; the title stays |
| Google Chrome 157.0.8103.79 | External AXHidden=true on each button | All three controls remain visible in every phase |
| Microsoft Edge 157.0.4341.57 | Same external AX request | Controls remain visible in every phase |
| TextEdit 1.20 | Same external AX request | Controls remain visible in every phase |

The first Chrome setup could not discover its disposable window and stopped. The follow-up binds the
exact directly launched browser PID instead of relying on the running-app list. That setup failure is
retained and is not a button-control result.

Recording also introduced an observer effect: external window SCK streams replaced the traffic lights
with macOS's sharing capsule before any AX write. Neither child inclusion nor a display-bound window
filter restored the baseline. Those recordings are unsuitable for judging visibility and remain separate.
No privacy indicator, persistent setting or system protection was disabled.

Accepted external clips use permission-checked `SLSHWCaptureWindowList` snapshots of only the exact
owned test window, verifying owner PID before every frame. The declaration is also used by
[yabai](https://github.com/asmvik/yabai/blob/master/src/misc/extern.h); `0x0200` nominal resolution is
specified in [WebKit's SPI header](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/PAL/pal/spi/cg/CoreGraphicsSPI.h).
Local stub/common-path disassembly was checked first. Real PNGs and monotonic timestamps are retained,
and playback uses measured sample intervals (about seven captures/second). These are sampled window
recordings, not 30 fps performance or physical-display continuity measurements. The native case uses
an SCK stream at 30 fps and has a separate recorded source snapshot.

Visual inspection confirms controls in each accepted real-app baseline and attempt. Independent
video decoding finds red, yellow and green pixels in the titlebar region in all twelve real-app phases.
The native baseline-versus-hidden crop changes 1,891 pixels above a per-channel threshold of 18;
baseline-versus-restored changes zero. Native hidden/hit readback agrees. These bounded checks do not
establish behavior in every app, window state or OS version.

The native clip has 329 SCK complete frames; Chrome/Edge/TextEdit have 75/79/78 timestamped acquired
frames. The early sampled logs call this field `completeFrames`; it is an acquired-PNG count there,
not an SCFrameStatus assertion. All owned windows/processes and temporary profiles/documents are
cleaned up. No existing app window is used or mutated.

Local media: `test-results/traffic-lights-visual-2026-11-16/`. The combined clip presents native, Chrome,
Edge, then TextEdit. Presentation labels and enlarged recorded-pixel crops sit outside the window;
raw sources remain. Metadata, pixel checks, hashes and instructions are in
`tools/traffic-lights-lab/results/visual-25G342/` and its README. No product behavior changes.
