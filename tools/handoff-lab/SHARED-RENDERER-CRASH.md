# Owned shared-renderer crash validation

The owned offscreen crash check passes on 26B131 (2026-11-11);
see [the bounded result](results/26B131-2026-11-11-renderer-components.md).
The production launch flag stays off.
No normal Margin process, browser, profile, physical display surface or Space
mutation is involved. Root serializes compilation and decides when to run.

~~~sh
# Root only, after reserving the native compiler:
bash tools/handoff-lab/shared-renderer-crash.sh --build
# Default/fixed dry run: no NSApplication, native inventory, window or signal:
bash tools/handoff-lab/shared-renderer-crash.sh --dry-run
# Only after root reviews source/guard/dry run:
bash tools/handoff-lab/shared-renderer-crash.sh --go
~~~

The standalone binary compiles the actual production source folders and a new
main entry point. It uses repository-generated synthetic Arcadia hello/state,
actual no-network OverlayPages and two actual OverlayControllers with the seven
delegate methods implemented by a lab delegate. Harness mode is on; edge width
is zero. Neither OverlayController.show nor NativeHandoffCover.activate is
called. Only alpha-zero source panels at -20000 are ordered, after their AppKit
bounds are checked against every display. Listed CG windows must belong to this
probe, remain alpha zero and have bounds outside the actual displays.

Real CoverPresentation temporarily disables only those owned views' occlusion
detection, permitting their renderer readiness. The Native cover is prepared
using real CoverRenderer and a recording presentation wrapper with a weak cover
reference. Its Space IO has no real mutation callbacks because activation never
occurs. This is a renderer/delegate lifecycle check, not a private Space test.

Before the crash require:

- Both real source pages ready, source A and B with distinct actual WebContent
  PIDs, and bridge registration count2.
- Prepared Native cover with renderer detail `shared`, actual PID equal to A and
  different from B; registration count3.
- Cover has no opener and no source document's JS marker; source A/B time
  origins and source B marker are retained as independent controls.

The Swift probe then launches the Python guard as its direct child, passing
only A's observed exact PID. The guard never searches for a process to kill.
Before one SIGKILL it independently checks:

1. Its PPID is the claimed owner, whose proc_pidpath equals the exact resolved
   tools/handoff-lab/build/shared-renderer-crash executable.
2. Target differs from owner and guard and has the exact system WebContent
   executable suffix, excluding GPU, networking, development and other kinds.
3. Positive resource coalition[0] matches the owned probe.
4. Owner and target both have positive birth identities. Paths, coalition and
   both birth identities are independently reread and must remain identical
   immediately before signaling. Missing/changing identity refuses the action.

Actual production delegates must then run. Record their observed order without
requiring one callback ordering. Require exactly one A crash notification and
one Native emergency, real A reload/isReady with a new PID/timeOrigin, unchanged
B PID/timeOrigin/marker and no B crash. Native cleanup must restore the inner
lease's original `false` values while the outer test lease remains held, restore
the disposable cover's original value, unregister its bridge entry (3→2),
dispose its window and report zero resources with balanced created/disposed
counts. The cover WebView must actually disappear through its weak reference.
Finally restore the outer lease's true/original values, close the two source
controllers, require bridge count0 and verify all known owned window numbers
are absent.

The wrapper records source/binary stamps and evidence in a fresh
/tmp/margin-owned-renderer-crash-* directory. The kill guard emits its verified
identity/action receipt separately from native callback JSONL. The supervisor
has a 25-second deadline, terminates only the owned probe on failure/interruption,
and independently checks that PID has no windows after exit. A stale binary,
unavailable SPI, source-process policy mismatch, refused guard, missing callback,
unexpected reload or cleanup failure is a failure/refusal, never an inferred
pass. Source/binary changes require a new root-serialized build.

Pure refusal tests are in tests/test_shared_crash.py; they never load native
process metadata or send a signal. Root serialized compilation and ran the fixed dry run, all three pure guard
tests and one actual owned crash; all passed.

This establishes an actual owned shared-process crash and the production Native/
Overlay delegate lifecycle on this host only. It does not establish Safari
window recovery, physical coverage, the watchdog's on-screen alpha deadline,
lock/sleep/display delivery, process isolation between the shared pages or
whole-system memory/energy acceptance.
