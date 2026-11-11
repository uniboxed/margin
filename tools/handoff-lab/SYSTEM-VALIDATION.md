# Prepared real-system follow-up

This is a plan, **not a result or approval**. The production live-cover preference
stays off outside an approved phase. The app binary is unchanged; these gates
are lab tools. The latest observed normal/live-fault follow-up passes its stated
scope; see [results](results/26B131-2026-11-11-observed-followup.md).

The [runbook](README.md) requires **“Ask before any run on screen.”** A new
approval covers at most **seven** Test A/Test B switches across these three
phases, with six setup/restoration Margin restarts. No previous allowance is
reused. Start with one active built-in display, Test A/Test B prepared without
work in use, a foreground full-screen test window and the external monitor
disconnected but ready to connect in extended-display mode. The person alone
locks/unlocks, closes/reopens the lid and connects the monitor. No test code
initiates those OS actions.

| Phase | Preparatory request | Interrupted request | Expected real evidence |
|---|---|---|---|
| EVLOCK | At most one normal live switch | One suppressed-fullscreen switch | Real screen-locked callback while cover shown, then unlocked; original source restored |
| EVSLEEP | At most one normal live switch | One suppressed-fullscreen switch | Real will-sleep callback while cover shown, then wake; original source restored |
| EVDISPLAY | At most one normal live switch | One suppressed-fullscreen switch | Actual display callback while cover shown; original source restored with two displays |
| MULTI, after EVDISPLAY | None | One ordinary switch | Explicit multiple-display degraded log; live allocation refused; final native target/source state and cleanup |

The preparation leaves a real target parked. There is no browser pre-creation
outside the normal product mechanism. After preparation the outer runner writes
`prepared` and waits: obtain the person's **timing readiness**, then create that
phase's `continue` file. This cue is not another switch approval and cannot
extend the seven-switch limit. It expires after 120 seconds without a cue;
do not rerun preparation automatically if time is missed.

After the cue there is a five-second return-to-Safari delay. The next cover is
the interrupted trial. Let its animation run **one second**, then:

1. EVLOCK: press Control-Command-Q, then unlock and return to the same Safari
   test window. Never send the password through a tool.
2. EVSLEEP: with the external display still disconnected, close the MacBook lid,
   wait five to ten seconds, reopen, unlock if needed, and return to the same
   test window. Actual `will sleep` plus `woke` is required; screen sleep alone
   cannot pass.
3. EVDISPLAY: connect the prepared monitor, keep Safari in front and leave both
   displays connected. The single MULTI degraded check follows only if display
   recovery passes. No further phase starts automatically.

The fullscreen fault makes the covered window long enough for the action; it
does not delay a normal production switch. Each OS gate sends only one request.
It requires one active display, actual available/clean native cover, no pending
calls/interruption/caps/faults, original native source fullscreen/active/front,
and exactly one parked entry. Fault arming is acknowledged before switching.
Both source and destination are still guarded by Margin's exact Test A/B hook.

Shown proof combines the production audit with an **independent WindowServer
read** of the actual cover number/PID, onscreen state, positive alpha and display
bounds. The existing app trace records callbacks before Shell dispatch. Read
only its five newest regular metadata files, bounded to 6 MiB each (the writer
rotates at 5 MiB before its next row); ignore incomplete final rows. Require the
named callback after the shown observation and before the matching interrupted
summary, with real unlock/wake where applicable. Stale/missing/malformed or
future timestamps cannot pass. No capture or new app observer is added.

Within 120 seconds, including the person's return, require the matching recovery
reason, actual live/parked-target/fullscreen-fault mechanism, unchanged app PID,
exact original source/profile fullscreen/active/front, expected display count,
no interruption/pending calls and independent balanced native cleanup/last-window
disappearance. The outer owned-process deadline is 180 seconds; no wake/unlock
is forced. A missed action or failed proof stops the phase, rather than being
reclassified as successful. Genuine capability demotions are not reset to finish
the comparison.

MULTI requires two actual displays and a prepared opt-in app/native cover but
must create **no** cover: native creation count stays unchanged. Require the
explicit degraded log, no live mechanism/freeze, target readiness and the
declared two-display keep choice, with source independently retained in its
real fullscreen Space. A freeze/late reveal here is unexpected and fails the
case. Public slide/keep remains a degraded mode, never live-goal acceptance.
These are metadata/state/cleanup
checks, not an energy, performance or physical-pixel grade.

Default/dry runs are read-only:

```sh
tools/handoff-lab/build/handoff-lab evlock evsleep evdisplay multi --dry-run --person --app "$HOME/Applications/Margin.app"
bash /tmp/margin-system-case-20261111.sh --dry-run
```

The host-specific prepared outer runner is frozen with candidate/lab/sender
hashes before approval. Only afterward, run one phase at a time:

```sh
# New batch approval must already be recorded; this marker is not approval.
bash /tmp/margin-system-case-20261111.sh --go --approved-os-phase EVLOCK
# EVSLEEP, then EVDISPLAY (includes MULTI), each only after its own timing cue.
```

The runner preserves unique per-phase plans/raw trace/native reports, requires
final `recorded` markers (exit zero alone is insufficient), stops on failure or
refusal and restores the original preference/app on normal exit, signal and
deadline. It never installs, closes a browser, creates a lab cover or resets a
genuine demotion during a phase. Excluded from `all`: EVLOCK/EVSLEEP/EVDISPLAY/MULTI.

Off-screen evidence checks (no app/window/OS action):

```sh
swiftc -parse-as-library tools/handoff-lab/SystemEvidence.swift tools/handoff-lab/tests/system-evidence-tests.swift -o /tmp/margin-system-evidence-tests
/tmp/margin-system-evidence-tests
```
