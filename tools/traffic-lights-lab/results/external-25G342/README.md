# External protected-app cover and direct server message, 25G342

Accepted cases are Chrome attempt 6, Edge attempt 1 and TextEdit attempt 1. Every case has 23 actual
composited screen crops. This is visual concealment by a controller-owned private WindowServer surface;
the target's native controls remain drawn underneath and exposed to Accessibility. No target library
loading, modification, signing change or protection change. `signatures.json` records strict bundle
verification passing for all three installed protected apps, and SIP enabled.

Each case directory contains cover events, target and second-app lifecycle/cleanup, capture-request
timestamps and independent source-PNG/raw-H264 pixel checks. Covered/moved/resized/reactivated display
samples have zero traffic-light color pixels; baseline/restoration and app-only capture underneath
have all three colors. Pointer queries select the cover in four covered states and the target at
baseline/restore. This checks pointer targeting, not actual click delivery or AX-action suppression.
AX confirms windowed state; deactivation and the cover's ordered-out state are independently read.

The prototype responds to AX geometry/focus/activation events and three bounded activation-settle
checks. WS event-808 registrations returned success but delivered no observed callbacks in the failed
attempts; they are excluded from the accepted implementation. `failed-attempts.json` retains their
registration/failure/cleanup summaries. Full failed Chrome attempts 1–5, actual PNGs and exact tested
source/binary snapshots remain local. The initial unbundled occluder was not a valid true app-switch
control; subsequent tests use a separate real disposable app and confirm deactivation.

Color-managed strip drawing fixes an early RGB-space mismatch in Chrome. TextEdit's glass still
shows a rectangular patch. This does not establish seamless material matching; an opaque Margin
theme surface is the product candidate. Sampling is only about 1.4 fps. Timestamps mark screenshot
requests; acquisition occurs during each subprocess. No continuous-drag, flicker-free, timing-bound,
same-app-sheet, Mission Control/Spaces, other-display/build or crash-recovery acceptance is claimed.
The raw video preserves measured request intervals; annotations/magnification stay outside original
captured pixels. Initial VFR verifier time-seeking selected the next frame at phase boundaries; the
accepted verifier explicitly selects corresponding decoded samples by index.

`wire-compact.json` is the independently owned-child direct global-clip message experiment, not an
experiment on installed browser windows. The exact 0x7614 message layout bypasses the exported setter's
local mapped-window guard. A valid owner clip changes 1008/2072 transparent samples and restores to
zero; the same foreign message leaves zero transparent samples. All send results are only transport
success. Source checks build, architecture, image UUID and descriptor layout; static excerpts retain
the serialized-region message path. No universal impossibility claim follows from this one route.

`final-readback.json` checks exact accepted target/patch window IDs and root/occluder PIDs after the
runs, without dumping any unrelated window titles. Saved source/executable/evidence/media hashes are
in `manifest.json`. Source snapshots identify tested code independently of future repository edits.

Local recordings and all failures: `test-results/traffic-lights-external-2026-11-16/`.
Run `python3 tools/traffic-lights-lab/verify-cover.py ABSOLUTE_CASE_DIRECTORY` to independently check
saved pixels, pointer queries, delivered lifecycle events, restoration and cleanup. Reproduction and
the current architectural findings are in the lab README and `docs/TRAFFIC-LIGHTS-RESEARCH.md`.

Fresh unit tests: 1031 pass. Full E2E was attempted and bounded after missing pinned WebKit 2388 setup
failures/pending teardown; Chromium 1254 also absent. No browser download or full-suite pass. Native
Swift/C compile with warnings as errors. No shipping app behavior changes.
