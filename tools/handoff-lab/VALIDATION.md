# Issue #15 validation

The production flag stays off while this work is incomplete. This document
defines the prepared experiment, not a result or permission to run it.

## Evidence and boundaries

| Area | Check |
|---|---|
| Readiness/recovery | Real state machine with independent clocks/browser/Space fakes: R1–R5, selection, drafts, delayed replies, disconnect, cancellation, session loss and fallbacks. |
| Actual page/bridge | Off-screen WKWebView integration, including persistent failed restoration, retained cleanup and refusal of another allocation while cleanup is unverified. |
| Private components | Owned off-screen probe: actual membership/level400, background alpha hide while its own main thread is blocked, level0, restored view setting and removed window; three rounds, no browser. |
| Real Safari | The original strict VALIDATE gate and the separately prepared prospective MATCHED gate below, on this Mac/build only. |
| Physical display | Observe animation, flashes and final alignment. Metadata cannot establish pixel coverage or physical smoothness; a camera remains independent evidence. |
| Lock/sleep/displays | Fake event routing/capability refusal are automated. Actual OS lock delivery, physical sleep/display changes, several displays and other macOS builds are not inferred. |
| Emergency watchdog | The owned off-main-thread hide primitive is tested; the complete real 20-second NativeHandoffCover/watchdog path is not inferred from the component probe. |

## Original strict gate (VALIDATE)

VALIDATE requests **at most 50** switches between Safari's exact Test A/Test B
profiles, with no external lab cover that could hide a product failure. It
requires one display, a foreground full-screen test window with Margin shown,
parking enabled, the close setting off, and no pre-existing test caps/faults.
The launch opt-in and tested binary remain fixed in one app process.

1. Four excluded warmups: freeze, live, live, freeze.
2. Sixty seconds of comparative pre-idle, after both paths are warm.
3. Six freeze/live/live/freeze blocks, alternating actual test profiles:
   twelve measured controls and twelve live switches, balanced by direction.
4. Eighteen more live switches, giving thirty measured normal live requests.
5. Sixty seconds of comparative post-idle **before** cases changing window topology.
6. One suppressed-fullscreen request that must exercise covered recovery.
7. Two close-mode requests; the outgoing test window must actually be gone.
8. One suppressed-park request that must exercise the existing close fallback.

The control uses a subtractive, Test A/Test B-only cover cap, not a relaunch or
different binary. Removing the cap cannot enable a missing launch capability.
Every summary must confirm the actual mechanism. A capability demotion is
never reset to finish the experiment. Every request checks final full-screen/
active/front identity, outgoing-window handling, no pending call, zero cover
views/windows/Spaces/presentation leases/timers, balanced created/disposed counts,
and disappearance of the last cover window.

An unexpected refusal, fallback, recovery, invalid measurement or cleanup failure
stops all remaining requests. Intentional faults must reach their named operation
and meet their specific final-state checks. No drafts are forced closed. Test
caps restore on normal exit, failure and signal cleanup; the outer runner restores
the original launch default and restarts Margin afterward, including after the
intentional parking demotion.

The [runbook](README.md) requires **“Ask before any run on screen.”** Prepare the
signed candidate and off-screen checks first, obtain approval for this exact
bounded batch, then run its dry run before anything is shown:

~~~sh
tools/handoff-lab/build.sh
tools/handoff-lab/build/handoff-lab validate --dry-run --app "$HOME/Applications/Margin.app"
# Only after that batch has been approved, sample alongside the gate:
python3 tools/handoff-lab/memory.py --duration 600 > /tmp/margin-validation-memory.jsonl &
validation_sampler_pid=$!
tools/handoff-lab/build/handoff-lab validate --go --app "$HOME/Applications/Margin.app"
# The outer runner also restores the launch preference/app and traps failures:
kill "$validation_sampler_pid"
wait "$validation_sampler_pid" || true
~~~

The gate prints its metadata-only events JSONL path under build/. The outer
runner owns/stops its sampler and restores the preference; do not leave the
ten-minute sampler running merely to fill the file.

After the first freeze warmup failed with the diagnosed window-binding race,
`--after-failed-warmup build/validation-EPOCH.jsonl` permits only the remaining
requests 2–50 after the correction passes local checks. The proof file must
contain exactly that one failed freeze warmup, no other request or injected
fault, and a different app PID. A live/later failure cannot resume this way.
The failed request remains a failure in its original report. The corrected
process runs three fresh excluded warmups (live/live/freeze), warming both paths
before pre-idle; all 24 balanced matched, 18 repeated and four fault/close
requests remain. Timing/resources use only the corrected process's new capture.
This consumes the existing maximum 50-request approval without adding requests
or resetting genuine capability demotions. Stop again on any new unexpected
failure; dry-run this explicit remaining plan before installation.

The corrected live warmups passed, but the first fresh freeze-control warmup
landed late through its watchdog. That **matched experiment remains failed**.
`--live-after-freeze-watchdog build/validation-EPOCH.jsonl` accepts only proof
of those two passed live warmups followed by that successful-reveal, late
freeze control (no recovery or injected failure). A separate fresh-process
**live-only observation** may then consume 36 more requests: two excluded live
warmups, pre-idle, 30 measured live switches, post-idle, the same four fault/close
cases. Request numbers remain 5–40, within the original 50 maximum. Every native
readiness/cleanup/session guard remains unchanged and the next unexpected
failure stops this observation. Later/live failures cannot use either restart
option. The failed controls remain recorded and no matched comparison, speed
advantage or performance acceptance can be inferred from the live-only capture.

## Prospective matched gate (MATCHED)

`MATCHED` is a **new, unrun 50-request experiment**, protocol
`matched-v2-degraded-freeze`. It requires a new approval for the complete batch;
the ten unused requests from the original allowance do not authorize it. The
original failed runs remain failed, their proof parsers and strict `VALIDATE`
behavior are unchanged, and neither legacy resume option is accepted by
`MATCHED`. Select it explicitly; `all` excludes it. The live-cover launch flag
remains off outside an approved experiment.

The original control exposed a known degraded baseline: its successful freeze
watchdog reveal can occur while A's exit has not started, followed by a correct
late landing. A comparison that stops at every occurrence cannot describe that
baseline's eventual completion or resource cost. This prospectively defined
protocol records that outcome as a **degraded freeze control**, with an early
reveal hazard retained. It does not extend the freeze deadline, call the early
reveal ready, or promote a historical failure.

Only this narrow normal freeze outcome is eligible: a fresh actual
`(park+freeze, …), frozen N ms (result 0), request to reveal N ms` summary,
numeric settled time, `focus ok`, and exactly one final
`late (watchdog at N ms, waiting for A not started); dev hook: cover off` suffix.
Another wait reason, failed release, abort, recovery, leftover/kept source,
missing mechanism, or live late transition still stops the run. A candidate
summary alone is insufficient. Before recording success, the runner independently
checks native destination full-screen/active/front identity and the selected
test profile, the original source parked and still present, no pending calls,
zero cover resources/failures, balanced created/disposed counts, and disappearance
of the last cover window. Real parking/freeze/live-cover demotions are never
reset to complete the comparison. The intentional final park-fault demotion
remains confined to its existing fault case.

Only the declared live/fullscreen fault step with `recovers: true` bypasses
normal successful-transition classification, because its intended recovery can
log `settled -`. It must still use the actual live mechanism, reach the fullscreen
fault marker, report recovery without late/abort, and independently restore the
original native source/profile/front state with clean resources. The park fault
does not receive this exception.

The request plan stays four excluded freeze/live/live/freeze warmups, six
direction-balanced ABBA blocks (12 controls and 12 live), 18 further live
requests, then the same four fault/close cases. Native Test A/Test B window IDs
are remembered during warmup and must remain fixed through the normal sequence:
one shown and one parked, with no normal close fallback. Both 60-second idle
intervals use the same no-cap, cover-enabled, old-window-park mode and that same
topology. Post-idle still precedes all fault/close cases. Keep the installed
candidate and renderer allocation policy fixed throughout; evaluate another
candidate/policy in its own approved capture.

The runner emits the protocol on every event and records `transition`,
`degraded_control`, `early_reveal_hazard`, actual-summary reveal/held times,
`final_verified_ms`, and independent mechanism/final/cleanup/topology/capability
verification fields. `capabilities_preserved` is deliberately false for the
last intentional demotion case; fault/close phases never enter matched results.
The reporter requires the new begin/request/settled protocol context, parsed
actual mechanism and matching timing/classification fields, successful gate
outcome, native verification fields and valid sampled continuity. Protocol and
booleans alone cannot establish an eligible degraded control.

Report on-time and degraded control counts separately, including every observed
early reveal hazard. Show native request-to-reveal, independently verified final
completion, on-time/degraded completion subsets and sampled resource costs.
The final completion metric includes lab verification overhead; the freeze's
early reveal metric can precede readiness. Twelve controls yield a descriptive
nearest-rank p95 equal to that group's maximum, not a stable tail estimate.
Same PID and balanced direction do not eliminate serial cache/carryover or
WebKit process-lifetime uncertainty. `matched_data_available` means both modes
have eligible observations; it does not certify that all 50 requests completed.
The reporter assigns no performance grade.

After the candidate/off-screen checks and approval of this new batch, use the
existing outer launch-preference restoration and owned-sampler cleanup workflow
with an explicit gate selection. Its read-only plan command is:

~~~sh
tools/handoff-lab/build/handoff-lab matched --dry-run --app "$HOME/Applications/Margin.app"
~~~

No new on-screen approval has been given. A second monitor is available for
separate physical/multiple-display observations, but `MATCHED` still requires
one active display. Do not attach/configure it or infer multi-display acceptance
from this batch; prepare and approve those cases separately, including the
expected capability refusal and cleanup behavior.

## Measurement

Events have wall and monotonic timestamps for requests, verified final states
and idle intervals. The sampler records process-start identities, sample/per-read
boundaries, host/timebase/schema, exact installed-helper executable identity,
attribution failures and observed resources. Helper launch argv0 can be relative;
proc_pidpath verifies its actual executable.

Monotonic values must share an origin before correlation. This Mac's installed
Python runtime offsets its clock per process, so older captures require explicit
wall alignment and a clock/read-skew warning; the reporter checks wall-minus-mono
offsets and rejects matched eligibility when fallback offsets vary by over
100 ms. Preserve both raw streams. New sampler stamps use raw Mach boot time
with the host timebase, independently checked against native system uptime.

~~~sh
python3 tools/handoff-lab/memory_report.py \
  --events tools/handoff-lab/build/validation-EPOCH.jsonl \
  --samples /tmp/margin-validation-memory.jsonl > /tmp/margin-validation-report.json
python3 -m unittest discover -s tools/handoff-lab/tests -p 'test_memory.py'
swiftc -parse-as-library tools/handoff-lab/LiveLog.swift \
  tools/handoff-lab/ValidationPlan.swift tools/handoff-lab/tests/live-log-tests.swift \
  -o /tmp/margin-validation-plan-tests
/tmp/margin-validation-plan-tests
tools/handoff-lab/cleanup-probe.sh --go
~~~

Report individual results, median/range and descriptive p95; twelve controls
cannot establish a stable tail-latency distribution. Keep warmups, failures,
close mode and unexpected recovery out of matched statistics. Report request-
to-reveal and request-to-final-verified-state separately. The latter includes
identical lab verification overhead in both modes.

Memory is sampled footprint/resident, not unique physical RAM; short peaks can
be missed. App, attributed WebKit and helper CPU are separate. New-process
first-observed lifetime CPU is explicitly unassigned; exited final CPU can be
missed. PID/start changes and counter resets invalidate continuity rather than
being clamped to zero. Unknown helper identity means unknown CPU, not zero.
The normal post-idle precedes faults/close mode and has its own label.

Do not grade performance from earlier unequal-process comparisons. Inspect
matched latency, transient cost, process births/exits and idle recovery.
Persistent unexplained tails, extra idle rendering or timing regression need
investigation before enabling the cover. Passing this batch establishes its
state/cleanup scope here, not blanket multi-display/OS/camera acceptance.
