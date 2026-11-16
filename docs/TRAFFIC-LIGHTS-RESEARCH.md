# Hiding window traffic lights without fullscreen

The target is the three close, minimise and zoom/fullscreen buttons, leaving the macOS menu bar,
window title and other application chrome alone. Research is restricted to Accessibility and private
macOS APIs for control. No product behavior is changed by this spike.

**An external private WindowServer surface now visually conceals the controls in protected installed
Chrome, Edge and TextEdit, without loading code into those apps.** Sampled display pixels, pointer
target queries, move/resize, app deactivation/reactivation and restoration pass on 25G342. This is a
cover: the original buttons remain in each app and are still exposed through Accessibility. It is not
native removal, seamless titlebar matching or a flicker-free production result. See the latest section.

The private AppKit solution also works in a real third-party Chromium browser through a temporary
launch-loaded library. Its three buttons disappear, stay hidden through resize and return, while the
browser remains windowed. This was verified in Chrome for Testing 156.0.8078.4 on 25G342; the same
library did **not** load in installed Google Chrome 157.0.8103.79. There is still no demonstrated general
external solution for arbitrary protected applications. Accessibility
permission enables inspection and actions; the tested setters did not provide native view visibility
control. This is a measured limit of the tested routes, not proof that no undiscovered private route exists.

The distinction matters for Margin: a successful call inside a helper's own window does not establish
that Margin can change Safari's NSButton objects. The recommended shipping decision is to keep native
buttons for unsupported external apps, and use an actual in-process backend for owned, cooperating or
explicitly tested launch-loadable hosts. The launch mechanism and limits are detailed below.
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

**The key capability is executing that code inside the third-party app.** The later launch experiment
establishes one such path for a loader-permissive Chromium build, without changing its application files.
Loading AppKit
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
injected in the initial experiments, and no system protection was changed. The separately labelled
launch experiment below does deliberately load a temporary research library into Chrome for Testing.

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

- **In-process native backend:** use where we own the app/window, have an explicitly supported host
  integration, or have verified that the exact build permits a launch-loaded component. Resolve/check
  selectors once per process/build, bind each window's actual button
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
  backend now has the bounded protected-app prototype documented below. It is not exact native hiding.

For the installed protected Safari/Chrome/Edge builds, **no working native removal backend was
established**. The viable exact solution is an in-process implementation, now also demonstrated through
launch loading in Chrome for Testing. If the product
goal only requires that users not see/click the original lights under Margin's own opaque chrome, the
cover prototype is now a concrete candidate for further validation. That is a different guarantee and
must be labelled.

## Verification still required

The visual follow-up now checks the owned private solution on screen with the complete titlebar intact
and restoration through resize. It still needs repeated titlebar reconstruction/tabbing, active/inactive
and hover behavior, and crash/detach restoration in a real cooperating host. The follow-up supplies pixels
for Chrome, Edge and TextEdit. Real Safari behavior remains untested.
Other macOS builds, multiple displays, Spaces/Mission Control, RTL layouts, scaled displays and custom
traffic-light implementations remain unvalidated. The current implementation stays research-only.

The three main limitations are the **process-execution boundary**, **private-ABI/host-specific behavior**,
and **relaunch/loader restrictions for third-party deployment**.

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

## Deeper investigation: a working third-party launch path (2026-11-16)

The earlier own-window success was insufficient to establish third-party support. A new experiment
loads `launch-hook.m` as a temporary dylib into the existing **Chrome for Testing 156.0.8078.4** at launch
with child-specific `DYLD_INSERT_LIBRARIES`. This is launch-time code injection, explicitly part of the
experiment. The browser's executable, signature and bundle are not patched or re-signed. SIP stays
enabled. The actual hide operations remain the two checked private AppKit selectors above; AX supplies
window identification, resize and cleanup. `DYLD_INSERT_LIBRARIES` supplies execution, not a remote AX
visibility setter. If the constraint excludes any code loading, this result is outside that narrower
constraint; it does not establish a purely external AX/private-IPC solution.

The installed test build has ad-hoc/linker-signed flags `0x20002`, without the inspected protected
Chrome's restriction/library-validation/runtime flags. The test-build bundle has no sealed resources
and fails whole-bundle `codesign --verify --strict`
with “code has no resources but signature indicates they must be present”; the protected Chrome
bundle passes that check. Both results are retained. No claim of a production-valid test-build bundle
signature is made, and no signing repair was attempted. The library matches its exact main-executable
path before starting, then removes the insertion variable so browser helpers do not inherit it.
On the main thread, it accepts nonce-bearing commands for the exact test window number, saves the
original button states in a weak-key map, and hides only kinds 0–2. A scoped resize observer reapplies
the state for that window. Restore and a 45-second automatic deadline return saved states. There is no
swizzling or persistent component. This bounded polling/file protocol is lab infrastructure, not a
proposed resident production architecture.

The accepted recording has **76 actual sampled frames over 10.924 seconds**, with baseline, hide,
resize and restore. Native readback reports all three hidden=true/hit=false after hiding and resizing,
then hidden=false/hit=true after restoration, alpha=1 throughout. AX confirms no fullscreen transition.
Independent decoding of a 180×80 titlebar crop finds these traffic-light color counts:

| Phase | Red | Yellow | Green |
| --- | ---: | ---: | ---: |
| Baseline | 138 | 144 | 153 |
| Hidden | 0 | 0 | 0 |
| Resized while hidden | 0 | 0 | 0 |
| Restored | 140 | 145 | 152 |

The moving CSS page indicator remains visible; this checks basic page drawing, not browser-wide
stability. Browser stderr records a helper MachPort rendezvous error near shutdown; it is preserved,
and no causal conclusion is drawn. The owned process exits and its temporary profile is removed.
Private exact-window capture avoids the SCK sharing-capsule baseline problem; this is sampled window
output, not a physical-display/high-frame-rate continuity test. Raw PNGs, timestamps and unannotated
video are retained. Labels and the magnifier are outside original window pixels.

As a matched deployment control, the same library, expected-executable gate and fresh-profile launch
were requested for **installed Google Chrome 157.0.8103.79**. Chrome opened its owned window, but the
library's loaded marker was absent after window discovery plus one second. The controller reports
componentLoaded=false, sends no component commands, and cleans up. This is a bounded negative loader
observation, consistent with its inspected flags, rather than proof of every possible injection path.
Firefox's disable-library-validation entitlement alone is not evidence that it honors this launch
variable; no Firefox runtime result is claimed. Safari and Edge launch loading were not tested.

Additional routes were examined rather than inferring authority from exported names:

- `_AXUIElementLoadAccessibilityBundles` is genuine remote IPC and returns zero in the owned child.
  No button changes follow. Bundle snapshots differ only by `com.apple.RawCamera.bundle`; this is not
  attributed to custom loading. AccessibilityBundles loader disassembly checks protected search roots
  and an embedded signing requirement. A read-only decoder resolves its 16-byte requirement to
  **`anchor apple`**. This is not an arbitrary user-dylib loader. The unbundled inspector's default
  AXBBundleManager is nil, so no usable manager instance or custom-load capability is claimed.
- AX setter dispatch checks accessibility support/settable status and generated accessibility setter
  methods. It does not turn an arbitrary selector string into general remote Objective-C execution.
- `SLSTransactionSetWindowGlobalClipShape` reaches a newer transaction path. With validated nonzero
  native bounds, an owner positive control clips about half the fixture (1,008/2,072 sampled pixels
  transparent), then restores to zero. The identical proven region from the foreign process leaves
  zero transparent pixels: no visible foreign effect. Native button state stays unchanged throughout.
  Earlier runs accepted a transient successful zero bounds result, producing invalid empty geometry;
  both are retained as invalid. The corrected probe waits for positive bounds agreeing with AppKit.
- `NSThemeFrame._updateObscuredStateOfButtonsForWindowSharingSession` ties all three button cells'
  obscured state to `showsWindowSharingTitlebarButton`. This explains the sharing capsule observation;
  it does not establish a clean external hiding switch. No privacy-indicator suppression was invoked.
- The inspected WindowManagement style-mask setter is a model property; no path from it to mutating
  another process's actual titlebar was established. Export/method existence is not a working bridge.

The first launch recording attempt used a wrong assumed bundle identifier and stopped before capture;
the accepted retry uses the observed `com.google.chrome.for.testing`. Failures and source/binary hashes
are retained separately. Reproduction, static excerpts, compact transaction observations, the matched
protected-loader log and pixel checks are in `tools/traffic-lights-lab/results/launch-25G342/`.
Local video: `test-results/traffic-lights-launch-2026-11-16/retry/launch.mp4`.

For Margin, this provides a concrete optional backend for a deliberately supported load-permissive
browser build. A production version should negotiate exact process/window identity, use event-driven
lifecycle handling, revalidate ABI/titlebar reconstruction and restore on detach. It should never infer
support merely from AX permission. Existing protected Safari/Chrome/Edge still require a different
established execution path or a separately validated visual cover. No shipping behavior was changed.

Fresh `npm test` passes 1,031 tests. Full `npm run test:e2e` was attempted again and stopped after its
missing pinned WebKit 2388 setup failures and pending teardown (Chromium 1254 is also absent). No
browser download or full-suite pass is claimed. Changed/new native probes compile with warnings as
errors; independent saved-video/native-state verification passes. Still unverified: other OS builds,
titlebar reconstruction, repeated open/close, crash restoration, hover/inactive/Spaces behavior and
protected-browser support. The positive Chromium result does not close those acceptance items.

## External protected-app prototype and direct server control (2026-11-16)

The user's objection to permissive host loading is valid for a general product. This follow-up removes
that dependency entirely for **visual concealment**, while continuing to test native compositor routes.
No target app is patched, re-signed, injected or given a new entitlement. SIP remains enabled.

### Checking beyond client-side ownership guards

Disassembly shows `SLSSetWindowListGlobalClipShape` checking its local mapped-window cache before
serializing a request. A successful/no-effect exported call therefore does not alone locate the
boundary at the server. `wire-clip.c` reconstructs its observed **0x7614** list-global-clip message,
with one valid serialized region and one exact disposable-child window. The descriptor layout is
checked at compile time. A read-only, nonexported connection-port getter is resolved at image+0x5b04,
only after checking build 25G342, arm64 and SkyLight UUID D422F0A4-1C28-35B7-A6F5-9EB7BBE0801E.
There is no message-ID guessing, memory patching, target attachment or protection change.

The owner sends this same wire format and clips 1,008/2,072 sampled pixels, then restores to zero.
The parent sends it directly for the verified child's window, bypassing the exported function's local
guard, and sees zero transparent samples. All transport results are zero, and all native button states
stay unchanged. This establishes no foreign clipping effect even after getting past the client guard;
it does not establish every server handler's authorization policy or prove all private APIs impossible.
Original region logs, native states, screenshots and cleanup are retained. Only owned test processes
are involved; this direct-message experiment is not sent to the installed browsers.

### The external surface that does work

`cover.swift` creates a tiny **controller-owned raw WindowServer window** over the AX-reported union of
the three controls, expanded by two points. For Chrome the patch is 66×21 points. Allocation uses
`SLSNewWindow`, a private `SLWindowContextCreate` drawing context, private flush/opacity/tags, and
`SLSOrderWindow` relative to the exact target. It stays at normal window level. Opaque event tags mean
it becomes the WindowServer pointer target in that region. It never changes the target's NSButton
objects, style mask or signing state. Public CoreGraphics drawing and owned AppKit fixtures are setup;
the concealment surface's creation, movement and ordering use private APIs. AX supplies target geometry
and lifecycle observations. Public screenshot capture is measurement infrastructure.

The prototype repeats an adjacent one-pixel background strip across the patch, retaining the source
image's color profile. An initial manual device-RGB conversion produced a visible bright rectangle;
drawing the color-managed image fixes that mismatch in Chrome. TextEdit's glass/translucent titlebar
still has a visible rectangular patch. This is a real limit: copying one nearby column cannot
reconstruct arbitrary material, wallpaper tinting, hover effects or spatially varying titlebar content.
For Margin, an intentionally opaque theme surface is the stronger design, with no need to reproduce
the original titlebar's material. Continuous target capture is not part of the prototype's mechanism;
only the initial strip is sampled once, using the already granted capture permission.

AX move/resize notifications update geometry. App activation/focus events check exact target ownership,
live bounds and AX frontmost state; another window above the button center makes the cover withdraw
rather than raising it over that window. Activation schedules three additional checks after successive
80/120/250 ms waits, superseded by a newer event or shutdown. These are bounded event-triggered checks,
not a resident timer. Screenshot subprocesses can delay their actual execution, so these delays do not
establish a display-latency bound. Unsupported geometry or failed reads withdraw/revoke the cover.

Ordering required real negative controls. Chrome attempts 1–5 conceal controls and follow geometry,
but fail the reactivation pointer check. Activation can precede completion of the other app's closing
and Chrome's own raise. Attempt 1 also uses an unbundled owned occluder that does not establish a real
app switch. Later tests use a fresh real TextEdit/Chrome process and independently confirm target
deactivation. Global and connection-specific WindowServer event-808 registrations return zero but
produce **no observed reorder callbacks** in these harness attempts, including event-port draining
and a separate notification connection. They are not counted as a working observer or retained in the
accepted implementation. The final AX-driven bounded-settle variant is Chrome attempt 6.

### Accepted recordings and independent checks

| Target | Actual samples | Display result after settling | Underlying app-only capture |
| --- | ---: | --- | --- |
| Google Chrome 157.0.8103.79 | 23 | Controls concealed through move, resize and app reactivation; visible after restore | All three native controls still drawn |
| Microsoft Edge 157.0.4341.57 | 23 | Same bounded sequence passes | All three still drawn |
| TextEdit 1.20 | 23 | Same sequence passes; glass patch remains visibly imperfect | All three still drawn |

Each test has a separate blank owned backdrop below the target and records only that disposable
canvas using actual **composited screen crops**, not a browser-only image with an artificial patch
added afterward. The capture uses `screencapture -R`; it did not introduce the SCK sharing capsule.
Original PNGs and monotonic **capture-request** timestamps are retained. Acquisition occurs during
each screenshot subprocess, not at an asserted exact presentation instant. Sampling is roughly
1.4 frames/second. VFR raw clips follow the recorded intervals; presentation clips duplicate frames
to add labels and a magnifier outside original pixels. No continuous-drag or flicker-free claim.

Independent checks decode both source PNGs and corresponding raw H.264 samples. Chrome's native-button
crop has red/yellow/green counts **608/608/616** at baseline and restoration, and **0/0/0** after cover,
move, resize and reactivation. Edge and TextEdit pass the same color-presence/absence checks. The
private capture of each app alone while covered still contains every native traffic-light color,
independently proving this is not native hiding. `SLSFindWindowAndOwner` selects the cover at all three
button centers in four covered states, then the browser/document at baseline and restore. This tests
pointer targeting, not delivery of an actual click or accessibility-action blocking. All six states
remain AX-confirmed windowed. The real second app deactivates the target and the cover is independently
read as ordered out. The second app, test target and temporary profile/document are cleaned up.

Source snapshots, early failures, raw PNGs/times and videos remain local at
`test-results/traffic-lights-external-2026-11-16/`. Reproduction and hashes, accepted state/pixel logs,
compact direct-message observations and the failed observer outcomes are in
`tools/traffic-lights-lab/results/external-25G342/` and the lab README.

The private surface declarations and event numbers were cross-checked against primary implementations
in [JankyBorders' declarations](https://github.com/FelixKratz/JankyBorders/blob/main/src/misc/extern.h)
and [event handling](https://github.com/FelixKratz/JankyBorders/blob/main/src/events.c), then inspected
in this host's disassembly. Their presence or prior use is not substituted for the current tests.

### Architecture decision and remaining acceptance

For a visual product result, put the cover inside Margin's own opaque chrome, bind PID/process lifetime
plus window number, and observe exact window geometry and application/focus state. Keep capability
states distinct: native-hidden, visually-covered, withdrawn, unsupported. Native AX actions can still
operate the underlying controls. Revoke on destruction/minimization, uncertain identity or geometry;
show the original controls on failure. A production backend still needs real click/hover tests,
continuous dragging, repeated windows/titlebar reconstruction, same-app occlusion/sheets, Spaces,
Mission Control, multi-display/scale changes, independent crash cleanup and other macOS builds.
The 50-second lab watchdog releases controller surfaces on exit and terminates known owned test PIDs;
it is not a production crash-recovery acceptance test. Safari was not tested.

This establishes an external visual solution in three protected apps. **Strict native removal in
arbitrary protected apps remains unestablished.** The direct server test strengthens that negative
finding without claiming a mathematical impossibility. No shipping Margin behavior changes.

Fresh unit tests pass 1,031. Full E2E is reattempted and bounded after missing pinned WebKit 2388 setup
failures/pending teardown; pinned Chromium 1254 also remains absent. No download or full-suite pass.
Swift/C compile with warnings as errors, all three saved PNG/raw-video/pointer/lifecycle verifiers pass,
and the earlier native/AX/launch evidence remains separately scoped.
