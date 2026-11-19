# Recorded validation of AX button detection

2026-11-18, macOS 27.2.1 / 26B131, arm64. This follows the
[metadata-only pass](BUTTON-VISIBILITY-RESEARCH.md). The user now permits Screen
Recording **for testing only**, and explicitly authorized a disposable Safari
window despite the earlier SPEC restriction. No production app behavior changes.

**The practical detection path is now backed by recorded pixels in Safari,
Chrome and Edge. It is still an app-validated heuristic, not an all-app rendering
oracle.** The recordings also confirm that tightly fitted covers slip during
motion. A larger guard trades more covered area for better motion tolerance;
the precise footprint and results are below. Native removal remains unestablished.

## Separation of implementation and measurement

`tools/traffic-lights-lab/ax-live-detector.m` is the research backend. It reads AX
button relationships/frames, performs app-specific AX center hit-tests, checks
display geometry and tracks private WindowServer 806/807 move/resize events.
It draws an owned opaque panel. It never imports/links ScreenCaptureKit, calls a
capture/recording permission API, reads an image, receives pixels or launches a
recorder. Its only file reads check the owned-root marker and stop-file existence.
The default backend is runnable while no recorder exists, as in the CPU trials.

`visibility-recorder.swift` is a separate executable used only by test runners.
Its ready/finished handshake controls test scheduling; it feeds no visibility,
geometry or pixel results into the backend. Pixel analysis runs offline afterward.
Static source/linkage checks and binary/source hashes are retained. Standard Cocoa
is used for the test windows and owned panel; foreign observation/tracking uses
AX and private WindowServer metadata. No injection, re-signing of browsers, SIP
changes, Automation or Full Disk Access is used.

The test recorder uses an owned-backdrop **display crop**, with audio, microphone
and cursor recording off. An earlier app-filtered recording visibly placed a
sharing control over the traffic lights and is excluded from ordinary-visibility
acceptance. Capture is not assumed to be a passive observer: the recorded scene,
focus, native state and source versions are checked.

Raw archive: `test-results/button-visibility-recorded-2026-11-18/`. Compact metrics,
hashes, selected original logs and reproduction are in
[the evidence directory](../tools/traffic-lights-lab/results/recorded-visibility-26B131/README.md).
Full raw recordings stay local. Presentation copies crop and enlarge the relevant
corner 2× with nearest-pixel scaling; they preserve original frame count and PTS,
with no frame interpolation. The Safari presentation is a small upper-left crop;
its full raw private-window recording stays local.

## Rendered visibility and actual browsers

| Installed app | Version | Recorded settled samples | Result |
|---|---|---:|---|
| Google Chrome | 158.0.8127.37 | 11 | AX hit state agrees with measured button discs |
| Microsoft Edge | 157.0.4341.60 | 11 | Same; minimized/disabled gray disc checked too |
| Safari | 27.2 | 13 | Same in a new private window, including hide-attribute attempts |

Each browser is initially absent. Chrome/Edge use new temporary profiles and
`about:blank`. Safari uses a newly created private window; its installed start-page
extension remains present. Only the owned window is changed. AX drives fullscreen,
toolbar menu actions and restoration. Inspected private mouse-move calls generate
top-edge hover/away stimuli. The trial samples windowed, fullscreen, toolbar-hidden,
hover-revealed and restored states. Both toolbar toggles complete, cursor position
is restored, owned browsers quit, recorded PIDs exit and temporary Chromium profiles
are removed. No Safari profile directory or data files are deleted.

The 35 samples are **settled checks**, 200 ms after the driver's already-settled
metadata snapshot. They do not establish every intermediate animation frame.
Pixels independently locate a red/green disc pair and check the intervening gray
or yellow disc by local center/ring contrast; AX rectangles are not supplied to
that analyzer. Selected original frames were also visually inspected. Fixed
brightness alone was insufficient for Edge's dark gray fullscreen minimize disc.

Chrome/Edge's hidden controls move above the display; their frames/hits restore
on top-edge hover. Safari also demonstrates an important stronger case: rectangles
can remain on-screen while actual controls and AX button hits disappear. Safari's
controls can remain revealed after an away move; the recording agrees with the
AX result, so a fixed pointer-away timeout must not define visibility.

A separate native fixture changes native hidden state, alpha, private reveal amount,
disabled state and individual button presence. Ten settled endpoints agree across
native truth, AX hits and recorded discs. Initial/final and continuous native
truth/geometry are logged independently. At alpha zero, title text shifts into former button positions: a naive
brightness-only image test falsely detects buttons there. The finite-fixture
analyzer distinguishes colored discs or a substantially filled gray disc, and the
negative control is checked visually. Fade intermediates are retained, not graded
as a universal binary alpha threshold.

**The all-app limitation is real.** A synthetic custom AX implementation deliberately
keeps standard button references and app hit-tests alive while its actual native
controls are hidden/faded. Every AX sample still reports hits; the recording shows
the absence. This is an intentional counterexample, not a claim that Safari,
Chrome or Edge has that bug. It demonstrates why the backend needs validated app
adapters and an unknown state. App-scoped AX also deliberately ignores our covering
app and cannot by itself establish external occlusion or compositor presentation.

## Polling, notifications and CPU

The new observer instrument registers eight notifications on **five scopes**:
application, exact window, close, minimize and zoom. All 40 registrations succeed.
It actively services the CFRunLoop. Two intentional native moves generate four
`AXMoved` callbacks, one per app/window scope per move. Hide/alpha/reveal changes
generate no callbacks among these subscriptions. Thus the earlier result was not
merely a window-level observer missing app/button notifications. This tests the
listed notifications, not every private event or every custom app's posting policy.

At 30 Hz, seven discrete native transitions reach the next correct completed poll
in **10.2 ms median, 28.3 ms maximum**, in this run. This measures time from the
fixture's logged completed native mutation, not from its first compositor pixel.
Partial fades, cover presentation delay and arbitrary apps' worst-case response
times are not bounded by that result.

A separate **conditional-cover** recording at 30 Hz, with the 32-point overflow
guard, exposes colored controls in **3 of 201 original frames** (81, 108, 171)
during reveal/fade changes. The last logged cover flag is already true in these
frames. That flag records intent; it is not compositor readback. Poll scheduling,
AppKit ordering and presentation latency are not isolated from each other here.
The original frame inspection confirms exposed native controls, so this is an
end-to-end failure, not a successful zero-exposure reveal test. It uses colored
disc evidence to avoid confusing reflowed white title text with buttons.

Recorder-free six-second steady-window trials, one pass at each rate:

| Poll rate | Completed polls | Detector CPU, % of one core | Mean query | p95 query | Missed deadlines |
|---|---:|---:|---:|---:|---:|
| 15 Hz | 91 | 1.78% | 3.82 ms | 7.32 ms | 0 |
| 30 Hz | 181 | 3.21% | 4.13 ms | 7.73 ms | 0 |
| 60 Hz | 361 | 4.68% | 3.00 ms | 6.18 ms | 0 |

These CPU numbers include the detector's diagnostic JSON logging and reference
refreshes. They do not include an isolated WindowServer cost or predict battery
life. The target has substantial independent truth instrumentation: its baseline
is 10.24% of one core, versus 12.95/13.41/14.95% during the polling trials. Do not
interpret that fixture as an otherwise idle real browser or simply attribute its
entire cost to AX. Idle trials require an active app but do not require a key window;
they are CPU/RPC measurements, not visual acceptance. A failed stricter key gate
was retained and excluded before the measured reruns.

30 Hz is a reasonable prototype starting point. Use geometry callbacks for motion,
app/window lifecycle events for invalidation, and bounded polling for reveal state.
Do not poll every window at 60 Hz. Reacquire stale controls, deduplicate zoom/fullscreen
aliases, serialize requests, bound AX timeouts and reject stale results. The current
prototype refreshes references every 500 ms; apps that recreate controls can have
additional detection delay and need explicit invalidation/app-specific handling.

## Motion: what the recordings actually show

The separate native target follows a timed fast waveform. It supplies identity only
to the backend; its truth/trajectory never drives cover placement. This is
**programmatic ordinary owner movement**, not accepted physical dragging/resizing.

The final clipped-guard candidate preserves a validated local layout during motion,
reads fresh private bounds before moving the cover, and keeps AppKit ordering state
consistent with private ordering. Its 16-point guard is clipped to the target
window. Even then, **31 of 260 original frames expose bright button pixels in the
expanded 7.5-point disc mask**. Earlier 6-point interior sampling counted 28; the
larger footprint catches additional edges. This is not a flicker-free result.
The full mask samples a 7.5-point radius around each independently reported
14-point native widget, located afresh from the teal body in every frame, and
counts pixels with a channel above 120. It is a documented finite-fixture metric,
not a universal visual classifier or a proof about every physical display refresh.

Clipping explains part of the weakness: the first button is only about eight
points inside the target, leaving limited leading-edge protection regardless of
the nominal requested padding. The overflow-guard tests intentionally permit the
opaque panel to extend past the native window. Their complete results are recorded
in the full-footprint comparison in `verification.json`.

| Final guard variant | Full-footprint exposure frames | Cost |
|---|---:|---|
| 16 points, clipped to window | 31 / 260 | Leading-edge guard is reduced by clipping |
| 24 points, extends outside window | 1 / 260 | Requested 110×64-point opaque corner |
| 32 points, extends outside window | **0 / 259** | Requested **126×80-point** opaque corner |

The last rectangle extends approximately **24 points beyond the native window's
left/top edges** and into its title/page area. It passes this bounded fast-motion
recording, not every possible speed or future frame. The native controls remain
unhidden, active and key in all native truth samples, and the independently located
target stays visible throughout all 259 original frames. This is a covering result,
not native removal. The extra area is a material design trade-off, not a free fix.
It applies to motion with the cover already present; the separate conditional
reveal failure above still applies.

Earlier candidates are preserved rather than cherry-picked: tight cover 82/202
interior-exposure frames, initial clipped larger cover 21/203, layout-cache candidate
183/201. Another candidate orders the panel out through AppKit despite a logically
visible private-order flag; all 216 frames remain uncovered from the start and it is
excluded from motion acceptance. Correcting AppKit/private ordering restores a
valid stationary baseline but does not eliminate cross-process motion slips.

An initially promising 24-point overflow guard has zero **interior** exposures, but
full-footprint inspection catches five red pixels in one original frame. The two
masks and original frames remain separate. A near-zero count must not be called zero
without checking the native control's outer footprint.

Movement-group authority was rechecked on this build with AX **enabled**. Same-owner
positive control follows +40,+20. Foreign joining returns zero, but actual readback
shows target delta +128,-37 while the member remains at +0,+0, with no controller
following. This disproves automatic following for that tested ordinary-owner path;
it does not prove the call was denied or that every group/owner path is impossible.
A synthetic titlebar-drag variant produces zero target movement and is rejected
by its stimulus check; its apparent zero/zero match is **not** coupling evidence.
Interactive movement-group following remains unvalidated.

## Native removal

In Safari's owned private window, each physical button reports `AXHidden` as
non-settable. All three `AXHidden=true` writes nevertheless return success.
`AXVisible=false` returns unsupported (-25205). The actual recorded controls and
AX hits remain present. Restoration calls complete afterward. This is direct
current-build evidence that a zero setter return does not establish native hiding.
It is not a proof that no undiscovered private route exists.

Screen Recording permission helps measure these experiments; it supplies no native
view-mutation authority to the implementation. In-process/cooperating apps can hide
their own native controls, as the fixture's pixel-checked native hide demonstrates.
General native removal from protected uncooperative apps is still unestablished.

## Architecture decision and remaining work

Use an opt-in AX adapter for individually validated apps/windows. Classify hit,
not-hit, off-display and unknown separately, and gate cover presentation on actual
window identity, active Space and occlusion independently. Preserve disabled
controls and do not infer hiding from fullscreen state or a missing child list.
Unknown/stale states need a bounded fallback, not a claim that no controls exist.

If Margin's design reserves a larger opaque corner/frame region, an overflow guard
is a candidate for reducing observed motion exposure. It covers more of the title,
page and space outside the native window. It is not equivalent to removing only
three controls. A tightly fitted invisible patch cannot currently be sold as
flicker-free. A universal guarantee would need a demonstrated compositor coupling
or owner cooperation; neither is established by these tests.

A reserved region kept present through native fades also differs from reactively
showing a cover after detection. It is a candidate design trade-off, not tested
production acceptance. The current prototype passes mouse events through its mask;
input blocking/drag forwarding and a proper shipping event/presentation lifecycle
need separate implementation and validation. Native controls remain underneath.

Remaining acceptance includes physical drags and live resize, other displays/scales,
Spaces/Mission Control, sheets and same-app overlap, custom frames, loss of AX,
long-running lifecycle/energy measurements and other OS/browser versions. Browser
steady-state/hover evidence and the finite native polling timings do not establish
first-pixel onset or every animation frame. No production backend is installed.

Warnings-as-errors native builds, source/linkage audit, Python parsing, raw-evidence
verification and 1,031 unit tests pass. The full E2E command was attempted and bounded
at 60 seconds after missing pinned WebKit 2388 setup errors; no download/full E2E pass.

Primary API references: Apple's
[AX hit-test contract](https://developer.apple.com/documentation/applicationservices/1462077-axuielementcopyelementatposition)
and [display/window filter documentation](https://developer.apple.com/documentation/screencapturekit/sccontentfilter).
Private ABI observations and measured behavior above are scoped to 26B131.
