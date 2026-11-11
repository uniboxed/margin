# Real-system validation, 2026-11-11

Installed app remains the verified diagnostic candidate from `ba2d2631`;
production handoff/renderer behavior is unchanged from `ead23cd8`. No app
reinstall, capture, automatic lock/sleep/display operation, default-on or PR.

Initial approval: up to seven Test A/Test B switches and six setup/restoration
Margin restarts, with user timing cues. Every phase restores the original
absent/off preference. Preserve unsuccessful attempts separately.

## First lock phase: failed, retained

The preparatory normal live switch passes (1,681 ms request-to-reveal, 2,185 ms
through independent final checks). The interrupted request shows the real cover
but logs `recovered: the switch was interrupted (aborted)`, not the gate's
expected sleep reason. The gate stops before its final independent audit.
Safari also exits during the sequence; the user is unsure whether they quit it.
Do not assign a cause or call this a successful lock case.

The native trace shows foreground changes, then a real screen-locked callback,
then unlock. The public lock callback follows cover removal by about 180 ms.
The first lab also has a clock error: WindowTrace uses
`Diagnostics.now()`/`ProcessInfo.systemUptime`, while its reader/filter and shown
observation used Unix time. Its earlier read-only zero-event result did not
establish a common clock. Additionally, summary receipt follows recovery and is
not the moment the cover hid. Preserve this original failed protocol; no
retroactive pass. The outer runner restores the original flag/app.

Evidence: ignored `build/2026-11-11-system-case-EVLOCK/`, including native report,
raw app trace, original outer runner/hash, and the exact `e9609b34` lab sources.
Two actual switches and two restarts consumed.

## Corrected evidence protocol, before further on-screen work

Use native boot uptime throughout trace filtering/observations. Reject Unix-time
filters or trace rows explicitly instead of quietly returning no evidence.
Derive cover removal from the **unique matching native switch-start trace** and
the summary's request-to-reveal duration. Allow only 5 ms for rounded summary/
read timing; a late recovery summary cannot extend the cover interval.

Keep direct named-callback proof. Prospectively add two separately labelled
OS-ordering paths: secure login activation just before the public lock callback,
or screen sleep followed by actual will-sleep/wake. The former requires an
independent secure-login app observation within tight bounds of cover removal,
a real subsequent lock/unlock, unchanged Safari PID and exact restored source.
An arbitrary foreign activation, unrelated late lock or screen sleep alone
cannot pass. Retain final recovery/cleanup evidence even when classification
fails; do not discard it at the reason check. After user return, allow at most
10 seconds within the overall 120-second trial bound for native final readiness.

All 48 pure evidence checks pass, including mismatched clocks, actual cover-end
vs late summary, duplicate/mismatched starts, missing/late auth and OS callbacks,
screen sleep without actual system sleep, malformed data/timestamps and partial
rows. Native lab build passes. A read-only check now finds the real lock/unlock
records using the correct boot clock; it does not promote the failed first run.
The product app is unchanged.

## Explicitly requested lock repeat: recorded

The user explicitly asks to repeat the lock test, adding at most two switches
and two setup/restoration restarts. The repeated preparation passes (1,157 ms
reveal, 1,657 ms independent final state). The interrupted request then records
the **secure-login activation before public lock callback** path:

- Boot times: request 78576.4429125, independently shown 78576.6482256,
  derived cover end 78579.0278377, secure login observed 78579.0394569.
- Cover held 2,423 ms; request-to-reveal 2,584 ms. Recovery is classified aborted,
  as expected for the early focus protection, followed by actual lock/unlock.
- Safari PID 47122 remains unchanged. Original native source 16859/Test B is
  independently fullscreen/active/front after unlock; zero pending calls and
  cleared interruption gate.
- Native audit: 2 created/2 disposed, zero cover windows/views/Spaces/leases/
  timers/failures, last cover window 16872 absent. One bounded target aftercare
  watch remains at that snapshot; its natural expiry is not certified because
  the approved preference restoration/app restart follows.

This is the corrected prospective path, not a pass for the original failed run
or a claim that the public lock notification arrived while the cover remained.
The original flag is restored off. Evidence:
`build/2026-11-11-system-v2-case-EVLOCK/` and
`/tmp/margin-system-v2-case-20261111-EVLOCK.*`.

## Actual lid sleep/wake: recorded

Using the original allowance, the preparatory live request passes (1,000 ms
reveal, 1,524 ms independent final state). The user closes/reopens the lid with
one display. Actual will-sleep and wake callbacks satisfy the **direct sleep**
path. Boot times: request 78809.3675613, shown 78809.5739155, cover end
78812.0391557. Cover held 2,493 ms, request-to-reveal 2,670 ms; named sleep recovery.

Unchanged Safari PID and exact original source/profile return fullscreen/
active/front, no interruption/pending calls, zero aftercare watches. Native
audit 2 created/2 disposed and zero cover resources/failures; last cover window
16920 absent. Original flag restored off. Evidence:
`build/2026-11-11-system-v2-case-EVSLEEP/` and matching `/tmp/` outer logs.

## Monitor preparation: refused, then coordination timeout

The first monitor preparation sends **zero** browser switches: at the guard,
ChatGPT is front in Space 36 while the identified Safari window is offscreen
in fullscreen Space 1286. Its native audit/capabilities are clean, but its active
source precondition correctly fails. The initial commentary's toolbar diagnosis
is wrong: the 52-point companion is already excluded by the 120-point candidate
minimum. Exact-time trace review corrects that conclusion; no window predicate
or production behavior is relaxed. Two setup/restoration restarts consumed.

The user approves two further restarts, retaining the three unused switches.
Preparation then passes (1,340 ms reveal, 1,841 ms independent final state), but
no timing reply arrives during the 120-second cue window. The runner stops
before the display-interruption request and MULTI, restores off and restarts.
No connection/double-display result is established. Preserve
`build/2026-11-11-system-v2-case-EVDISPLAY/` and
`build/2026-11-11-system-display-retry-EVDISPLAY/` separately.

Current accounting: **seven actual switches, ten Margin restarts consumed**.
Two browser switches remain approved/unused. Completing the monitor phase needs
one fresh preparation switch and two additional restarts; a prepared new request
asks for exactly those additions. Its idle human timing window is ten minutes;
the product's cover/emergency and actual OS-trial bounds are unchanged. There
is no active runner or cover while that new approval is pending.

These are per-host metadata/source-recovery/cleanup results. Physical pixel
coverage, energy/unique RAM and a new performance comparison are not inferred.
The earlier full MATCHED capture stays failed, and its slower/higher-transient-
cost live measurements remain the applicable comparison. Default stays off.

Final local follow-up checks: 1,031 JS unit and 150 headless browser tests pass;
48 corrected system-evidence and 89 existing plan/parser checks pass. Native lab
build and read-only plans pass. Installed app main executable/signature is
unchanged; its prior 2,345 native unit/555 integration results are not rerun or
claimed as new results. No further on-screen action runs while monitor retry
approval is pending.


## Monitor follow-up: real connection recorded; MULTI checker stopped

The next approved preparation and interrupted request consume two switches/two
restarts but do not establish a monitor connection: no real display event occurs
inside the cover interval. The fullscreen fault times out and restores the
source; two native covers are disposed. Preserve this failed attempt in
`build/2026-11-11-system-monitor-final-EVDISPLAY/`.
The user subsequently confirms they did not plug the monitor in and explicitly
requests a repeat, authorizing the new preparation/interruption and two restarts
with the unused MULTI request. A host reboot has occurred in between.

Before repeating, scope metadata trace files to the current app launch's file
creation cohort. Old-boot uptime rows are incomparable after reboot; they must
not invalidate the new run or be treated as current events. Apply the cohort
filter before choosing the five newest files, while preserving clock/size/type
checks. Two additional pure fixtures cover exclusion of an old-boot future-uptime
file and rejection when the requested cohort has no files (50 total checks).
No app behavior or observer changes.

The fresh preparation records 1,312 ms request-to-reveal (1,106 ms live cover).
The person actually connects the monitor during the next cover. EVDISPLAY passes
the **direct display callback** path:

- Native boot times: request 715.7768969583, independently shown 715.984895875,
  derived cover end 721.1829980417, summary observed 721.5742543333.
- Cover held 5,235 ms; request-to-reveal 5,404 ms under the deliberate fullscreen
  fault. The summary explicitly restores the source on the current displays.
- Safari PID 1787 is unchanged. Exact source Test B/native 348 returns fullscreen,
  active and front with two displays, no pending calls or interruption.
- Native audit: 2 created/2 disposed; zero windows, views, Spaces, presentation
  leases, timers and cleanup failures; last native cover 362 independently gone.
  One bounded target aftercare watch remains at the snapshot (9.6 seconds);
  natural expiry is not certified before the restoration restart.

The subsequent MULTI request uses the expected public slide/keep mechanism,
with explicit multiple-display degradation, no live-cover/freeze summary and
`A kept (2 displays: kept in its own Space)`. However, the lab incorrectly expects
the keep reason in the headline mode token too. It fails before collecting its
final independent audit. Preserve this failure; do not promote it to a pass.
The corrected matcher checks the actual `(keep, parked target)` headline plus
the separate kept-source reason, with 11 new positive/negative regressions
(100 parser/plan checks total). MULTI now also retains final diagnostics when
summary classification fails. Production code and installed signed app remain
unchanged. Evidence: `build/2026-11-11-system-monitor-repeat-EVDISPLAY/`.

All **12 browser switches and 14 Margin restarts** authorized through this
repeat are consumed. Original absent/off preference and app were restored;
both displays remain connected. A frozen MULTI-only runner prepares exactly
one new switch/two restarts, no preparation switch or cable action, pending
new approval. It will require independent target/source readiness, unchanged
native allocation count and clean final audit. Default remains off; prior
performance comparisons and failed matched capture are unchanged.


## Separately approved corrected MULTI: recorded

The user approves one additional two-display switch and two setup/restoration
Margin restarts, with both monitors kept connected. No preparation switch,
installation or cable action. The frozen corrected runner/hash manifest and
outer log are retained alongside `multi.log`, `multi-plan.log`, metadata trace
and native report in `build/2026-11-11-multi-final-MULTI/`.

The single request records the expected `(keep, new window)` mode and explicit
multiple-display degraded log; no live cover or freeze. Target Test B/native
618 is independently fullscreen, active and front; original source native 221
is independently retained in a real fullscreen Space. Same app PID 5046 throughout
the trial, two displays, idle switch, no pending calls/interruption/faults or
capability demotion. Native cover creation/disposal counters remain **0/0**;
zero cover windows, views, Spaces, presentation leases, timers, cleanup failures
and aftercare watches. This is a **public slide/keep degraded fallback pass**,
not a claim of the live-cover goal on multiple displays. The earlier failed
MULTI classifier run remains failed.

All **13 actual switches and 16 Margin restarts** now authorized are consumed.
Original absent/off preference and normal app are restored, owned gate/trace
stopped, and both displays remain connected. Fresh local checks pass: 1,031 JS
unit tests, 150 headless browser tests, 50 system-evidence checks and 100
parser/plan checks; native lab build, read-only plan, signature/hash checks and
diff whitespace checks pass. No app source changes, app rebuild/install, new
native app test claim or PR. The earlier MATCHED batch remains failed and its
slower/higher-transient-cost live figures remain applicable. These OS safety
checks do not justify enabling the preference by default.
