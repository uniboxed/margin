# Live profile cover validation — 2026-11-10

The corrected live path passes its real Safari reliability observation on this
Mac. The matched freeze/live experiment failed and performance acceptance stays
open. `MarginLiveProfileCover` is restored to its original absent/off setting.
No PR is created.

## Build and method

- macOS 27.2.1 (26B131), arm64, one display, Release Margin.app signed with
  Apple Development team VSNN5UW99X; deep/strict signature verification passed.
  Developer ID release acceptance is separate.
- Exact Test A/Test B profiles only, through Margin's guarded hook; no external
  cover, capture or browser pre-creation. Development hooks/window tracing were
  enabled. Final state and cleanup were independently checked after each pass.
- Original maximum: 50 requests. Actual total: **40**. Request 1 exposed the
  binder race; the corrected matched run used requests 2–4, then stopped at its
  late freeze control. A separate live-only observation used requests 5–40.
  A source-precondition refusal sent zero requests. Ten remain unused.
- Live-only process: PID 7195, one PID/start identity throughout. Two excluded
  live warmups, 30 normal measured live switches, pre/post idle intervals, then
  four fault/close cases. Normal data excludes every warmup and fault/close case.
- The sampler stopped before the original preference was restored and Margin
  restarted. The installed correction remains available with live cover off.

## Reliability

| Check | Result |
|---|---|
| Normal live switching | **30/30**, no unexpected recovery, late reveal, freeze fallback or session demotion |
| Destination/source | Every normal destination full screen, active/frontmost, correct profile; outgoing source parked |
| Suppressed fullscreen | Covered recovery passed; original source remained full screen/frontmost; final checks 6,444 ms |
| Close mode, parked destination | Passed; outgoing source independently gone |
| Close mode, new destination | Passed; outgoing source independently gone |
| Suppressed park | Close fallback passed; outgoing source independently gone |
| Cover cleanup | All 36 live-only requests checked: final audit idle; 0 windows/views/Spaces/presentation leases/timers/failures; **36 created / 36 disposed**; last panel independently absent |
| Contradictory AX rebinding | **0** contradictory AX drops in the live-only trace, versus 177 bind/drop pairs before the correction |

The first failed freeze request was a real identity bug: the newly created
full-screen target was assigned to the older normal extension window before
the new report arrived. Four off-screen replay assertions failed on the old
matcher. The correction requires geometry agreement and makes confirmed
profile identity constrain weaker rules. An unprefixed title is provisional,
so it cannot falsely veto a named profile's independent binding. Named evidence
can upgrade that provisional entry without increasing event/scan cadence.

The later freeze control reached B steady at 1,584 ms. Its existing budget
guard correctly deferred A's exit until after the watchdog: held 1,685 ms,
request-to-reveal 1,763 ms, then a successful late landing. The matched run
stopped there. Neither failed control is reclassified as a pass or used for a
speed comparison, and the freeze deadline is unchanged.

## Descriptive live timing and resources

| Metric | Observation |
|---|---|
| Request to reveal, 30 normal live switches | Median **1,487 ms**; descriptive nearest-rank p95 **1,922 ms**; range **1,337–1,963 ms** |
| Request through independent final checks | Median **2,003 ms**; p95 **2,412 ms**; range **1,856–2,469 ms**; includes lab verification overhead |
| Combined app/attributed-WebKit footprint during switches | Median sampled per-switch peak **601 MiB**, maximum **623 MiB** |
| Peak above immediately preceding sample | Median **188 MiB**, range **163–232 MiB** |
| Combined idle footprint, pre → post | Median **361.9 → 375.9 MiB**; about **14 MiB retained** after 30 switches |
| App-only idle footprint, pre → post | Median **186.8 → 188.3 MiB** |
| Attributed WebKit idle footprint, pre → post | Median **175.1 → 187.6 MiB**; 2 WebContent processes both intervals; 2–3 during switches |
| Combined summed resident bytes, pre → post | Median **398.5 → 444.5 MiB**; not unique physical RAM |
| Idle app CPU, pre → post | Observed **2,009 / 63,305 ms → 1,995 / 63,745 ms**, approximately **3.17% → 3.13%** of one core |
| Idle attributed-WebKit CPU, pre → post | Observed **277 → 219 ms** over those intervals |
| Login helper | Median **3.16 MiB footprint / 8.89 MiB resident** both intervals; observed CPU about **0.07 ms** each interval |

All **800/800** samples have complete app/WebKit and exact-helper attribution;
the idle intervals contain 200 and 201 complete samples. No normal resource
window has missing coverage or CPU identity/counter flags. The mean observed
normal-step CPU is about 438 ms for the app and 156 ms for attributed WebKit.
An additional **3.82 seconds** of first-observed WebKit lifetime CPU is explicitly
unassigned across the 30 steps; exited final CPU can be missed. These are sampled
observations, not exact switch CPU cost, energy usage or a freeze comparison.

The installed Python runtime reports process-relative monotonic timestamps,
whereas native events use system uptime. The capture's preserved wall stamps
allow correlation: wall-minus-monotonic offset variation is **1.34 ms** for
events and **1.36 ms** for samples; no larger jump is observed. The corrected
report explicitly uses wall alignment and keeps its clock/read-skew warning.
The sampler now calls raw Mach time with the host's 125/3 timebase. A read-only
native check confirms the new timestamps bracket `ProcessInfo.systemUptime`.
Synthetic tests reject mismatched origins and clock-jump eligibility.

## Acceptance and limits

Functional readiness, recovery, close fallback and per-request resource cleanup
pass for this live-only run. The approximately 14 MiB retained footprint and
transient third WebContent process need further performance review; this run
does not prove long-term leak freedom or unchanged resource cost. Normal idle
CPU did not increase in the two observed intervals. Safari/WindowServer usage,
GPU energy and sub-sample peaks are outside the attributed totals.

Matched performance acceptance remains **open** because its control failed.
The same app/attributed-WebKit totals are not a whole-system RAM or battery
measurement. Metadata does not establish pixel-perfect coverage or physical
smoothness. Physical-camera, real lock/sleep/display changes, multi-display,
other OS builds and the complete real 20-second Native watchdog remain separate
checks; earlier fake tests/component probes do not replace them.

Final local checks: **1,031 unit**, **150 browser**, **2,251 native logic**,
**545 native integration**, **303 Rust workspace** tests; Rust formatting and
warning-free host/Windows-target checks; **52** pure lab plan/parser and **22**
sampler/report tests. The signed native code is the same correction used in the
passing live observation.

Metadata event files: `build/validation-1794367680099.jsonl` (failed initial
control), `build/validation-1794369254785.jsonl` (two live warmups and late
control), `build/validation-1794369564714.jsonl` (36-request live-only observation).
Raw resource capture and corrected report are local temporary artifacts:
`/tmp/margin-validation-live-only-20261110.memory.jsonl` and
`/tmp/margin-validation-live-only-20261110.report.json`. No page titles, URLs or
contents are included in this report.
