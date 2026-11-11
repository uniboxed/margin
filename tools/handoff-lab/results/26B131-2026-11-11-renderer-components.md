# Cover renderer component validation, 2026-11-11

Experimental candidate on macOS 27.2.1 (26B131), arm64. The main live-cover
launch default remains **off**. These entirely owned, offscreen experiments
control no browser or installed Margin process. They do not replace the real
MATCHED gate, physical composition, real watchdog or OS-event checks.

## Actual Native prepare/end allocation

`cover-memory-probe.swift`, compiled with both `MARGIN_THEMED_COVER_PROBE` and
`MARGIN_NATIVE_PREPARED_MEMORY_PROBE`, instantiates the production
NativeHandoffCover, OverlayPages, CoverPresentation and CoverRenderer. Two
synthetic real Arcadia layout pages form the baseline. Each mode runs in a
fresh standalone process: eight prepared covers, three seconds prepared and
three seconds after each disposal, then 30 seconds idle. Never calls activate;
no real Space mutation callbacks exist. Panels are independently outside every
actual AppKit/CG display. Prepared cover panels remain hidden.

| Observed metric | Existing isolated allocation | Related owned renderer |
|---|---:|---:|
| Successful prepare/end cycles | 8/8 | 8/8 |
| Median begin-to-ready, including probe JS/PID assertions | 115.7 ms | 51.3 ms |
| Median per-cycle sampled combined footprint peak | 186.0 MiB | 155.2 MiB |
| Largest per-cycle sampled peak | 190.6 MiB | 165.9 MiB |
| Initial idle median combined footprint | 122.8 MiB | 123.9 MiB |
| Post-idle median combined footprint | 117.4 MiB | 127.5 MiB |
| Complete resource samples within baseline→complete | 277/277 | 276/276 |
| Measured device pixel ratio / backing scale | 1 / 1 | 1 / 1 |

The reusable source and cover have the same positive actual WebContent PID
only in related mode; source B remains separate. All covers have no opener,
source JS globals remain distinct, and every end returns the bridge count to
two. Every disposable cover view disappears through a weak reference within
two seconds. Every Native audit reports zero windows/views/Spaces/presentation/
timers/failures and balanced created/disposed counts, ending at 8/8.

The descriptive median sampled peak is about 31 MiB lower and preparation about
64 ms faster here. The related process retains about 10 MiB more post-idle
footprint. Neither result establishes a full application saving, retina-display
cost, long-term cache bound, whole-system energy change or production switch
speed. Eight rounds, fresh separate processes, 250 ms sampling and sequential
resource reads have limited precision. A view disappearing is not proof that
WebKit returns its cached memory immediately.

Earlier four-cycle per-mode component experiments using all three real themes
also reduced median sampled peaks (Arcadia 188→166, Neubrutalism 183→157,
Pixel 188→157 MiB) and shortened preparation, with retained caches. Those used
the theme pages directly rather than the actual Native prepare lifecycle. An
initial simple-HTML control did **not** show a memory saving; fewer processes
alone is not sufficient evidence.

Evidence: ignored `tools/handoff-lab/build/2026-11-11-renderer-evidence/` holds
native events, raw Mach-clock resource samples and the analysis-time binary
hash. The initial temporary runner did not pre-stamp its inputs; this limitation
is preserved. The checked-in default-dry-run wrapper adds prospective input/
binary/asset stamping for reproducible later captures. No captured pixels or
real profile/page data are in this experiment.

## Actual shared-WebContent crash

`shared-renderer-crash.sh --go` passes after its fixed dry run and three pure
identity-refusal tests. Two actual production OverlayControllers A/B load a
synthetic fixture entirely offscreen with alpha zero. The production cover
prepares, never activates, and its verified renderer PID equals A, differs from
B. A direct child guard rechecks exact owner executable, exact system
WebContent executable, matching positive resource coalition and both birth
identities before sending one SIGKILL to that exact owned WebContent PID.
No installed Margin or browser is queried as a kill target.

Observed production delegate order: Native emergency disposal first, A's page
crash notification next, then A reload/layout/hits/ready. Exactly one emergency
and A crash occur. A gets a new PID and document time origin; B retains its PID,
time origin and JS marker, with no crash. The bridge count is 2→3→2→0; real
per-view settings restore both inner and outer original leases; the weak cover
view is gone; all known owned windows disappear. Native final audit has zero
resources/failures and 1 created/1 disposed. Supervisor exits 0, no timeout,
independently verifies no owned windows after exit.

The test establishes real production component recovery from a shared-process
crash on this host. The source sidebar and cover do share crash lifetime;
document globals and bridge owners being separate do not provide process
isolation. It does not establish a real Safari handoff's final recovery or
physical coverage during that failure.

Raw crash manifest, independent guard receipt and native/outer results are in
`build/2026-11-11-renderer-evidence/crash/`. The original evidence directory was
`/var/folders/_g/lk5vkl_50hj4b1qqxxv3w2680000gn/T/margin-owned-renderer-crash-7twaof8k`.

## Acceptance still open

The prospective MATCHED protocol explicitly distinguishes known degraded
freeze controls from live success; old failed controls remain failed. The
actual production 20-second watchdog and cancel/reuse probes have been built
and dry-run, but have not appeared on screen. Real user-assisted lock, sleep,
display change, multiple-display fallback/restoration and physical smoothness
remain outstanding. The user confirms a second monitor is available; a read-only
lab preflight currently sees two displays, while MATCHED requires one.

## Subsequent source review

The final candidate copies the qualifying owned source configuration rather
than the common base configuration. This preserves WebKit's required related
process-pool compatibility without using its deprecated public pool accessor.
The original allocation figures above precede that hardening; a new stamped
matrix on the final sources is recorded separately when completed.

The OS-event review also finds and corrects a pre-cover topology race. A request
waiting for a link/profile/pending call could retain single-display freeze/park
choices after connecting another monitor. Every active handoff is now
invalidated on display/Dock changes: untouched preparation cancels, moved windows
use existing bounded restoration, and queued targets are dropped. Real Shell
event routing over independent fake browser/Space state has new regressions;
this does not replace the actual monitor connect/disconnect check.

Independent source review then hardens interruption ownership: pending space
selection may already move focus; late legacy park failure/close retries must
not close the source recovery is restoring; old source aftercare must not park
it after relinking. Sleep/lock now clears the queue and cancels waiting-profile
continuations, retaining the sleep gate until allowed wake. These changes reuse
existing bounded recovery and add no poller/timer. Both reviewers find no source
blocker; full final native execution and physical checks follow separately.

## Final stamped allocation repeat and local gates

After the configuration compatibility and interruption fixes, rebuilt all
standalone binaries and the signed Release candidate serially. Ran the
prospectively stamped `cover-memory-native.sh` matrix **related first**, then
isolated, eight cycles per mode and 30 seconds post-idle. Both modes exit 0,
all 568 samples are complete (283 related/285 isolated), every baseline/ready/
post-idle phase independently includes the pinned A/B source census, all 70
native events are framed/validated, and no owned windows remain after exit.
All 16 disposable views deallocate and each mode ends with an 8/8 zero-resource
Native audit. Actual measured DPR/backing scale remains 1.

| Final repeat metric | Isolated | Related |
|---|---:|---:|
| Median component begin→ready | 117.9 ms | 48.6 ms |
| Median per-cycle sampled footprint peak | 186.9 MiB | 155.3 MiB |
| Largest per-cycle sampled peak | 192.7 MiB | 168.6 MiB |
| Initial idle median footprint | 124.7 MiB | 124.3 MiB |
| Post-idle median footprint | 117.7 MiB | 128.1 MiB |

The final repeat supports about 31.6 MiB lower transient sampled median peak and
69.3 ms shorter component preparation, with about 10.4 MiB more post-idle
footprint. This is the same tradeoff observed in the preceding order. It still
is **not** a retina/whole-app/matched-freeze/energy result or a long-term cache
bound. No heavy test or compilation runs during either resource capture.
The complete source/binary/fixture/asset stamps, raw events/samples and analysis
are in ignored `build/2026-11-11-final-native-matrix/`.

The actual guarded shared-renderer crash also passes on the final sources:
exit 0, independent post-exit window cleanup, actual A reload/B continuity,
bridge 2→3→2→0, original presentation settings restored, weak cover gone and
balanced zero-resource Native audit. Current raw evidence:
`/var/folders/_g/lk5vkl_50hj4b1qqxxv3w2680000gn/T/margin-owned-renderer-crash-5qqiekp1`.

Final local checks pass: 1,031 JS unit, 150 browser, 305 theme/security, 2,299
native unit (including the new interruption regressions), 555 native integration,
82 pure validation-plan/parser and 46 Python resource/guard tests. The native
sources pass Xcode-setting warning checks. One new focus regression initially
had a false setup condition because both fake windows shared A's Space; the
corrected fixture gives B its own fake full-screen Space before the actual
setSpace focus. The full suite is rerun; no failed assertion is waived.

The actual Release app verifies deep/strict signatures, hardened runtime and
the installed copy's same team VSNN5UW99X (local Apple Development certificate,
not a notarized distribution claim). The candidate is built **not installed**;
the original absent/off launch preference is unchanged. No on-screen run or
PR is created. Real MATCHED, actual 20 s watchdog/cancel-reuse and user-assisted
OS/physical-display acceptance remain pending approval.
