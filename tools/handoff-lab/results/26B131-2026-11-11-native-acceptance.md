# Native acceptance follow-up, 2026-11-11

User approval covered three passive corner appearances and up to 50 guarded
Test A/Test B requests, with installation, setup/restoration restarts and
resource sampling. One-display preflight passed on macOS 27.2.1 (26B131).
Installed candidate: `ead23cd8`, same hardened-runtime signing team as before.
No PR or default-on promotion.

## Actual production watchdog: pass

The unchanged NativeHandoffCover 20 s watchdog runs while its standalone main
thread is deliberately blocked 22 s. Background alpha hide returns true at
add+20.004s. The independent observer child sees alpha 0 at add+20.030s,
**before** that main thread resumes. Exactly one emergency callback follows.
Cleanup verifies original per-view settings, detached bridge, zero levels for
created Spaces, disappeared window and Native zero resources/failures with
1 created/1 disposed. Outer supervisor exits 0, no timeout, independently finds
no windows for the owned PID.

## Cancel/reuse across old timer deadline: pass

Two further corner appearances use the same Native object. First cancellation
cleans everything. The second panel remains visible after the first cancelled
20s deadline, with zero emergency callbacks. Final cleanup verifies original
settings/bridge/levels and zero resources/failures with 2 created/2 disposed;
independent post-exit window check also passes.

This establishes the real native watchdog and generation/cancellation path on
this host. It is metadata/component evidence, not captured physical pixels or
the production Shell's browser recovery during real sleep/lock/display changes.
Raw manifests/native/observer/outer results are preserved in ignored
`tools/handoff-lab/build/2026-11-11-live-acceptance/{watchdog,cancel-reuse}/`.

## MATCHED attempt: aborted instrumentation, not a performance result

The installed candidate passes four native warmups (freeze/live/live/freeze),
including all independent final-state and cleanup checks. During pre-idle the
operator detects that its outer shell script incorrectly requested a 1200 s
sampler duration; memory.py only supports up to 600 s, so it exited before
producing any data. The gate is signalled to stop, caps clean up, the original
absent launch flag is restored, and Margin restarts with the feature off.
Fresh dump verifies idle, zero pending calls, no caps/faults and no parked entry.

Exact event proof: `build/validation-1794377857538.jsonl` contains **four
requests, four successful warmups and pre-idle begin only**. No measured normal
request, idle end or validation end occurs. The memory file is empty. This
attempt cannot provide a timing/resource comparison or acceptance. Preserve it
as aborted for an instrumentation defect, not a pass or a product failure.

Approval consumed: all 3 corner appearances and 4/50 browser requests; 46 remain.
The fixed protocol needs 50 fresh requests in one app process, so repeating it
requires explicit approval of 4 additional requests. Do not silently repeat the
four warmups, weaken the protocol or reuse this run's incomplete resource data.
Original outer evidence is `/tmp/margin-matched-final-20261111.*`.

## Corrected capture supervision

`validation-capture.py` uses the supported 600 s bound, requires two complete
stable PID/birth samples before launching the gate, and stops its owned gate
if sampling exits, stalls, becomes invalid/incomplete or changes app identity.
Parsed resource JSONL contains complete validated rows; raw bytes are separately
preserved. It never installs/restarts Margin or changes flags; the outer caller
still owns restoring the original preference/app and the gate restores caps.
Default is a fixed dry run. `--check` is read-only and cannot launch a gate.

All 54 Python guard/resource tests pass, including eight new supervision tests
with tiny child stand-ins and actual rejection of the erroneous duration before
native sampling. A real read-only `--check` passes with two healthy samples,
zero gate starts and owned sampler cleanup. Evidence:
`build/2026-11-11-capture-preflight-final/`. No further browser request runs
while preparing the correction. A retry script is prepared at
`/tmp/margin-matched-retry-20261111.sh`, pending the additional four-request
approval. It reuses the installed tested candidate, restarts for opt-in, runs
the supervised gate, then restores the original flag and restarts afterward.

## Fresh MATCHED capture: normal sequence complete, final fault case fails

After explicit approval of four additional requests, the corrected supervisor
runs a fresh 50 in one installed `ead23cd8` app process (PID 27522, birth
1165561905006), with one active display. All 54 approved browser requests are
now consumed: four in the aborted capture, 50 in this capture. No allowance
remains. All three approved corner appearances are also consumed.

Four warmups pass. All **42 measured normal requests** finish with independently
verified destination/source/cleanup/topology checks: 12 freeze controls and 30
live requests, including 12 direction-balanced matched live observations.
The suppressed-fullscreen recovery and both actual-close cases pass. The final
suppressed-park request keeps A because the fresh draft answer is **0 drafts,
2 unknown**. The close-fallback classifier correctly fails and stops; unknown
tabs are never forced closed. The overall MATCHED gate is **failed**, with no
validation-end event. Completed normal observations remain descriptive evidence,
not a passing full acceptance batch or permission to enable the default.

The final source was newly created in the preceding close case. Its draft answer
arrived after 403 ms against the existing 400 ms per-frame wait. Aggregate logs
cannot identify which frames timed out or distinguish permission/unavailable
content; fresh-page timing is plausible, not proven. The product's protection
and timeout stay unchanged. A separately approved narrow follow-up must first
observe real draft readiness, then retain the handoff's fresh independent check.

### Descriptive comparison

The following medians use the 12 eligible observations per mode from the same
process/prospective protocol; warmups and fault/close cases are excluded.

| Measurement | Freeze | Live cover |
|---|---:|---:|
| Request to reveal | 1,417 ms | 1,971 ms |
| Descriptive p95 request to reveal | 1,768 ms | 2,127 ms |
| Independently verified completion, including lab overhead | 1,916 ms | 2,473 ms |
| Sampled per-request peak app + attributed WebKit footprint | 550.8 MiB | 577.8 MiB |
| Peak footprint minus immediately preceding sample | 79.7 MiB | 98.6 MiB |
| Sampled per-request peak resident sum | 356.1 MiB | 357.6 MiB |
| Observed app + attributed WebKit CPU per request | 438.8 ms | 687.2 ms |

Freeze has 11 on-time controls and **one degraded watchdog control with an early
reveal hazard (A not started)**. Live has 12 on-time matched controls, no hazard;
all 30 normal live requests are on time (median reveal 1,906 ms). The comparison
does not certify freeze's early reveal as ready. Twelve observations make p95
equal to that group's maximum; it is not a stable tail estimate. Serial cache
carryover, sequential sample boundaries and unobserved sub-sample peaks remain.
Live is slower and costs more transient footprint/CPU in this capture; no speed,
equal-cost or default-on claim is justified.

All 958 resource samples are complete, one unchanged app identity, no attribution
or clock warnings. Both streams use raw Mach boot time (origin difference 3.6 µs).
All 36 actual cover preparations log `shared`; normal WebContent count stays
two, with no third cover renderer. The last independent audit, after request 49,
has 35 created/35 disposed, zero resources/failures and last-window disappearance.
Request 50 fails classification before its independent final audit, so do not
claim 36 independently verified cleanups. The outer runner stops sampling,
restores the absent/off launch preference and restarts Margin. Fresh dump is idle,
zero pending calls, no caps/faults or parked entry.

The two approximately 64-second idles retain two WebContent processes. Median
app + attributed WebKit footprint is 471.7 → 405.4 MiB; app 255.2 → 189.8 and
WebKit 216.5 → 215.5. Cache/accounting changed, so the 66 MiB drop is not an
optimization benefit or proof against leaks. Resident sum rises 323.3 → 382.3
MiB. App CPU is 3.23% → 3.08% of one core, app + attributed WebKit 3.66% → 3.50%.
Helper footprint remains 3.27 MiB, resident about 8.9 MiB, with zero observed idle
CPU. Footprint/resident sums are not unique physical RAM; attribution includes
WebKit GPU/network processes, not whole-system GPU activity/energy, WindowServer
or Safari's own processes. Effective sampling spacing is about 0.31 seconds.

Read-only timing analysis finds the extra native A-exit proof wait after Safari's
normal-state reply (approximately 364 vs 37 ms in the available trace subset).
The extension's normal-state API call itself is similar (52.5 vs 55.5 ms).
Native bounds AND departure from A's former fullscreen Space remain necessary;
no safe proven shortcut was found. Cover preparation is about 125 ms and already
overlaps other setup. These observations do not isolate the compositor cause.

Evidence: `build/validation-1794378966437.jsonl`, the generated failed native
report `results/26B131-2026-11-11.md`, and ignored
`build/2026-11-11-matched-capture-retry/` (manifest, raw/validated resource stream,
gate log, capture-result and resource-report JSON). Restoration trace and runner
are `/tmp/margin-matched-retry-20261111.*`. No build/test ran during sampling.

### Remaining scope

User reported they were not watching closely: physical cover continuity and
sidebar alignment remain **unverified**. User-assisted actual lock/sleep/display
delivery and multi-display degraded behavior remain open. A narrow draft-ready
close-fallback retest must not replace/promote the failed 50-request batch. No
further on-screen run is authorized. The launch default stays off; no PR.

The diagnostic/tooling follow-up passes 1,031 JS unit, 150 browser, 2,345 native
unit, 555 native integration, 82 existing plan/parser, 20 draft-parser and 54
Python resource/guard checks. Native compiler warning checks are clean. The
Release candidate is built **without installation**, deep/strict verified and
Apple Development signed with hardened runtime, same team VSNN5UW99X as installed
(not a notarized Developer ID distribution build).

Prepared next approval is limited to installing this candidate and three new
requests: two actual product-cover switches with the user watching (COMPARE
--live-ui, no external panel), then one FALLBACK request. The outer plan stops on
any unexpected failure/refusal, bounds each owned gate at 75 s, restores the
original launch preference and restarts Margin afterward. Candidate/lab/sender/
runner hashes are frozen in `/tmp/margin-observed-fallback-20261111.sha256`.
The runner's default is dry-run; no further switch, install or restart has run.
Actual OS-event/display cases remain separate, not silently included.
