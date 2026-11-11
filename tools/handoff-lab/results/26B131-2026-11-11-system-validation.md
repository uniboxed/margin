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
