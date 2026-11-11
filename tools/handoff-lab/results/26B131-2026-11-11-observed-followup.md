# Observed-switch and close-fallback follow-up, 2026-11-11

User approval: install the verified candidate, setup/restoration restarts and
up to three Test A/Test B switches: two observed normal live switches and one
guarded close-fallback check. One active display. No lock/sleep/display-change
run, capture, default-on promotion or PR is authorized by this follow-up.

Installed app: the diagnostic candidate from `ba2d2631`, with unchanged
`ead23cd8` production handoff/renderer behavior, same Apple Development team
VSNN5UW99X/hardened runtime and deep/strict verified. Main executable SHA-256:
`609d6c59ecd80809e1584240e232cbdba754b63033f6167c08c47e08ceba871b`.

## Setup mistakes retained

1. The prepared COMPARE sequence assumed Test A, but the actual guarded dump
   identified Test B. Its same-target notification was refused: no browser
   transition occurred, and the original absent/off flag was restored. The
   subsequent runner selects the existing forward/reverse order from a fresh
   complete metadata dump rather than assuming the current profile.
2. The revised runner wrote the opt-in flag but omitted its explicit setup
   restart when reusing the already installed candidate. The running app still
   had no native cover. One actual switch therefore used **freeze**, and the
   mechanism check correctly failed/stopped. Restore the absent/off flag and
   restart. This is an operator/instrumentation error, not a passing live check.
   This actual switch consumes one of the three approved switches.

Preserve both failed attempts in ignored
`build/2026-11-11-observed-fallback/` and
`build/2026-11-11-observed-fallback-retry/`, including native reports/raw traces.
Outer scripts/logs are `/tmp/margin-observed-fallback[-retry]-20261111.*`.

## Remaining two switches: passed state/cleanup checks

After the diagnosed restart correction, the lab adds explicit `COMPARE --runs 1`
support, clamped to one or two requests. Default comparison stays two, existing
return-only stays one. Six bound/direction fixtures pass; no product code changes.
The remaining runner explicitly quits/restarts the opted-in app and requires a
fresh actual clean native-cover audit, no caps/faults, idle state and no session
interruption before sending anything. Select direction from current metadata.

The corrected process is PID 42311. Exactly two further actual switches run:

| Case | Request to reveal | Independently verified completion | Result |
|---|---:|---:|---|
| One normal live A → B, new target | 1,029 ms | 1,521 ms, including lab overhead | On time; target fullscreen/active/front, source parked |
| One suppressed-park B → A, parked target | 1,419 ms | final native readiness/source-gone/cleanup verified | On time; actual source closed |

Before the fault, the **real guarded draft observation** answers twice for the
same source/native/browser/caller/tab set: one tab, zero drafts and zero unknown,
at 66 and 73 ms. This establishes positive actual transport for the advisory
observation. The production handoff independently checks drafts again; its
timeout/unknown protection is unchanged. The intentionally failed park reaches
the close fallback and independently removes native source window 16519.
Destination is native 16482/Test A, fullscreen/active/front. No forced closure or
draft override is used. This does not change the earlier failed 50-request
MATCHED result, whose newly created source had two unknown tabs.

Both preparations log `renderer: shared`. Final independent audit: **2 created,
2 disposed**, state idle, zero windows/views/Spaces/presentation leases/timers/
cleanup failures, last cover window 16530 absent, zero pending calls and no caps/
faults. Parking is intentionally demoted by the injected park failure; the outer
runner restarts Margin after restoring the original absent/off preference.

Fresh restored dump independently verifies idle, zero pending calls/handoffs,
no caps/faults, parking on, no session interruption and no parked entries. Native
cover audit is unavailable because this launch is off. The dump's separate
`live cover session: on` means **not demoted**, not that a cover was allocated or
the launch opt-in is enabled. Do not use that word alone as a capability proof.

Evidence: ignored `build/2026-11-11-observed-fallback-remaining/` (native report,
COMPARE/FALLBACK logs, dry-run plans and raw app trace),
`/tmp/margin-observed-fallback-remaining-20261111.{sh,sha256,runner.log,flag-original}`
and `/tmp/margin-observed-followup-restored-dump.log`. There is no resource capture
or performance grade here. Two individual timings with changed window topology
cannot revise the earlier same-process comparison.

## Allowance and remaining scope

All **three actual switches** are consumed: one mismatched freeze, one normal
live, one live fault. There was also one earlier same-target notification that
the app refused without a browser transition. The planned second normal live
switch was not repeated beyond the approved limit; the successful fault switch
is not relabelled normal. No further on-screen action is authorized.

The user confirms the final two live transitions were **continuous and aligned**.
This is a scoped human observation of one normal live switch and one live fault,
not independent pixel/camera capture or the originally planned two normal live
observations. Logs separately establish state/cleanup. Actual user-assisted OS lock,
sleep, display changes and multi-display degraded behavior remain open. The
launch flag remains off; no PR.

Afterward, lab preflight also requires actual audit availability/cleanliness
(not the persisted preference or logical session word alone), correct source
direction, zero pending calls and no interruption. Post-switch live checks
require clean audit and independent last-cover-window disappearance. The final
lab build and 89 parser/plan checks pass off screen; these additional guards
were not used to retroactively promote a failed attempt. The product app remains
the same verified installed binary.
