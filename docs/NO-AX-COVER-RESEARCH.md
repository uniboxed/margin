# Cover tracking without Accessibility

2026-11-17. The user reopens adaptive-cover research and requests testing without
Accessibility. No product behavior changes. **A controller with AX denied can
track and cover a calibrated separate-process AppKit window, but this implementation
is not reliably flicker-free.** Fast motion exposes a button in 3 of 235 original
recorded frames. Automatic button visibility detection remains unestablished.

## Permission and measurement controls

Checked macOS 26.7.3/25G342, arm64; SkyLight UUID
`D422F0A4-1C28-35B7-A6F5-9EB7BBE0801E`. Each attempt uses a new ad-hoc-signed app
identity launched through LaunchServices, with controller parent PID 1 and a
separate child/WindowServer connection. Every controller and child reports
**AXIsProcessTrusted=false**. The controller's intentional negative-control AX
window-list request returns **-25211 / kAXErrorAPIDisabled**. It refuses to continue
if AX succeeds. No AX reads/actions/observers drive covering after that check.
No private entitlement, permission grant/reset, FDA, Automation, injection,
existing-app re-signing, real browser or user window is used.

The child supplies PID/window ID for target bootstrap only; private owner/PID
queries verify them. Native button geometry/hidden flags go to separate truth
files that the controller never reads. Placement instead uses a **local standard
AppKit calibration window**: its three button rectangles give a 64×18-point patch
with a seven-point top-left inset. This is a known-layout fixture, not automatic
foreign geometry discovery or a universal Safari/Chrome/Edge layout contract.
Child-owned movement is a stimulus, not a proposed external movement API.

An independent measurer uses the host's already granted **Screen Recording**
permission. It neither uses AX nor moves/orders the target; acknowledgments only
coordinate capture start. The cover backend uses no screenshots or video input.
Measurement and mechanism permissions must remain separate in product claims.

## Results

| Test | Actual observation |
|---|---|
| Private foreign bounds | SLSGetWindowBounds succeeds with AX denied |
| Private notifications | Actual four-byte 806 move and 807 resize callbacks arrive for the exact target after registration/per-window subscription |
| Opaque cover | A real controller-owned WindowServer surface conceals the buttons; native button flags remain unhidden |
| Legacy movement grouping | Own-window control follows +40,+20; foreign join returns 1001 and patch stays behind |
| Transaction grouping | Own-window control follows; foreign transaction also produces no following movement on readback |
| Event tracking | Move/resize checkpoints align and original composited PNGs conceal all three button discs |
| Slow motion | 0 exposed button frames among 269 decoded original frames |
| Fast repeated direction changes | 3 exposed frames among 235 decoded original frames; extracted originals visually confirm left/right buttons outside the patch |
| Legacy button-region getter | Nil externally, including after retaining NSCGSWindow proxy; unchanged in owner across actual native hide/show |

The owner's legacy region `{9,9,37,14}` covers only the first two measured controls;
the three-button union is `{9,9,60,14}`. Neither a nonempty region nor AX presence
can be promoted to an authoritative drawing/visibility contract from these tests.

The event backend retains one cover. Valid 806/807 messages dispatch a private
bounds read and private movement of the cover on the main queue. There is no
repeating window-position poller in that backend. Harness IPC polling and child
motion timers are measurement infrastructure. Event 723's larger payload is logged
as a raw prefix/length, never interpreted as a target-window ID or used for tracking.
The two grouping failures are bounded results, not proof against every possible
compositor binding. A successful transaction commit alone is not acceptance.

Declarations/event numbers were cross-checked against installed code and primary
[JankyBorders declarations](https://github.com/FelixKratz/JankyBorders/blob/main/src/misc/extern.h),
[dispatch](https://github.com/FelixKratz/JankyBorders/blob/main/src/events.c) and
[event numbers](https://github.com/FelixKratz/JankyBorders/blob/main/src/events.h).
That project's success is not substituted for the local measurements.

## Video and verification

The recorder captures an actual fixed display crop over an owned backdrop, with
no individual-window sharing filter, artificial patch, audio or frame interpolation.
The dark patch intentionally represents Margin chrome; it does not imitate glass.
Requested cadence is 60 fps, but the originals are variable-rate: **269 frames /
5.332 s** (slow) and **235 frames / 5.205 s** (fast). Median complete-frame interval
is about 16.67 ms; maximum gaps are **50 ms**. No claim covers every physical refresh.

Offline analysis independently locates the teal fixture content in each decoded
frame and checks the three native button discs using the child's truth geometry
and known 32-point titlebar. It handles gray inactive buttons as well. Baseline and
deliberately untracked movement fail coverage; covered/tracked move/resize PNGs
pass. Decoder count must match original MP4 count. This fixture-specific classifier
is a verifier, not a universal visibility detector. Fast exposed indices are
**16, 28, 113** (zero-based); all three extracted frames were visually inspected.

Raw slow video: `test-results/traffic-lights-no-ax-2026-11-17/run-4/motion.mp4`.
Raw fast video: `test-results/traffic-lights-no-ax-2026-11-17/run-5/motion.mp4`.
Examples: `run-5/exposed-01.png` through `exposed-03.png`. These local ignored
artifacts retain original pixels/timing and are indexed by committed hashes.

## Retained attempts

1. Run 1 passes permission/bounds controls, then stops before covering because the
   calibration window was never ordered and has no usable server geometry. Fix
   that owned-window setup before retrying; retain the failed source/binary/log.
2. Run 2 verifies static covering and actual private move/resize callbacks. Own
   grouping works, foreign legacy grouping fails; no event tracker exists yet.
3. Run 3 adds tracking; numeric checkpoints align, but an extra activation step
   leaves the backdrop above the fixture. Captures are gray and video correctly
   contains one static frame. Exclude visual/timing claims. Remove that activation
   and require visible fixture pixels in still captures. Also fix runner grading
   to require measurement success, rather than native completion alone. Retain
   its original permissive runner/result; do not relabel this attempt as a pass.
4. Run 4 is a valid slow sequence. Initial offline FFmpeg decoding duplicates
   frames to 320 outputs. An MP4 count cross-check catches this; use explicit
   `-fps_mode passthrough`, retain the first output, and analyze the true 269 frames.
   This decoder fix does not require another UI run.
5. Run 5 uses fast motion with the same callback backend. Three real exposure frames
   are a negative result for flicker-free behavior, not a rejected measurement.
6. Run 6 tests the transaction grouping variant with its own positive control.
   Foreign following still fails; no grouped-motion recording is claimed.

All twelve controller/child PIDs are absent at independent cleanup checks.
Per-run source, signed-app snapshots, original runners, failures, PNGs/video,
capture metadata and independent verification remain under the ignored raw root.

## Decision and remaining acceptance

This proves an AX-free **tracking/calibrated-cover primitive**, not a universally
adaptive, flicker-free product. Do not infer button visibility from fullscreen
state alone. Unsupported layouts/unknown visibility must stay explicit.

Remaining: automatic per-app button geometry/visibility; same-frame following
under fast motion, activation/occlusion and fullscreen; real protected-browser,
multi-display/scale/OS/lifecycle validation. Safari is untested under SPEC's
Safari-execution rule. No shipping backend is added.

Native controller/recorder/analyzer builds pass warnings-as-errors; independent
verification covers original PNG/video pixels, permission controls, owner/native
state, both grouping controls and PID cleanup. Repository unit tests: **1,031 pass**.
Full E2E attempted/bounded at 15 seconds after missing pinned WebKit 2388; no download
or full-suite pass. See lab README and
[compact evidence](../tools/traffic-lights-lab/results/no-ax-25G342/summary.json).
