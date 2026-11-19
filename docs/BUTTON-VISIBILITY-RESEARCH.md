# Button visibility through Accessibility

**Later follow-up:** the user authorized capture for independent testing and a
disposable Safari window. Recorded browser validation, notification/CPU trials and
motion-guard results are in [the recorded report](RECORDED-BUTTON-VISIBILITY-RESEARCH.md).
The implementation still receives no pixels or recording permission dependency.

2026-11-18. The user now permits Accessibility (AX), while retaining the restriction
against Screen Recording and pixel capture. This supersedes the no-AX constraint
for this research only. No Margin.app behavior changes.

**AX gives us a useful, externally readable indication of native button hit
participation. It is stronger than a button reference or child-list membership,
but it is not a universal rendered-visibility oracle.** An app-specific AX hit-test
matched the separate fixture's native hidden/alpha/reveal state in the tested
settled windowed cases. It also continued working through our own opaque cover.
Fresh installed Chrome and Edge windows expose the same button hit-testing path,
including fullscreen. Those browser observations are metadata, not independently
verified pixels. Native removal and flicker-free tracking remain separate problems.

## Environment and evidence

Actual host: macOS **27.2.1 / 26B131**, arm64, current AX trust true. This is a
different build from the earlier 25G342 cover tests; those binaries/results are
not reused as current-build evidence. SkyLight UUID:
`1AD26AFB-B313-3086-95F0-43FC18B8FBCA`. Native probes refuse other builds.

Sources are in `tools/traffic-lights-lab/`: `ax-button-visibility.m`,
`run-ax-visibility.py`, `visibility-inspect.m`, `verify-ax-visibility.py`.
Compact observations/native truth, hashes and verification are in
[the evidence directory](../tools/traffic-lights-lab/results/visibility-26B131/README.md).
Raw archive: `test-results/button-visibility-2026-11-18/`, including every attempted
source/binary, failed build/setup logs, browser logs and inspection output.

Native warnings-as-errors builds, offline evidence checks and all 1,031 unit
tests pass. The full E2E command was attempted and bounded at 60 seconds after
missing pinned WebKit 2388 setup failures. No browser download or E2E pass is claimed.

No capture/permission-request API is called. No images or recordings are made.
No injection, browser re-signing, saved user preferences, Automation or Full Disk
Access is used. Only a disposable native window and absent browsers launched with
new temporary profiles are changed. No Safari launch or acceptance is claimed.

## What was tested

The controller is a different process from the AppKit fixture. It matches the
fixture's actual window number with private `_AXUIElementGetWindow`, then reads:

- `AXCloseButton`, `AXMinimizeButton`, `AXZoomButton`, `AXFullScreenButton`;
- role/subrole, enabled, frame, position/size, direct children and visible children;
- `AXUIElementCopyElementAtPosition(targetApplication, centerX, centerY, ...)`,
  comparing the result with the expected button using `CFEqual`.

The fixture alone changes its native controls. A separate file records native
`hiddenOrHasHiddenAncestor`, alpha, private reveal amount, enabled and local
hit-test before and after the controller's sample. These files never inform the
controller's hit-test. The verifier compares the two streams afterward and checks
that sampled native fields did not change during each AX query.

| Fixture state | Button references | Direct child membership | App-specific AX hit matches |
|---|---|---|---|
| Normal | All present | All present | All three |
| Disabled | All present | All present | All three |
| Hidden | All present | None | None |
| Only close shown | All present | Close only | Close only |
| Alpha zero | All present | All present | None |
| Private reveal amount zero | All present | All present | None |
| Private reveal amount 0.5 | All present | All present | All three |
| Ancestor hidden | All present | None | None |
| Restored | All present | All present | All three |
| Settled native fullscreen | All present | None | None; rectangles outside displays |
| Returned from fullscreen | All present | All present | All three |

`AXHidden`, `AXVisible` and `AXVisibleChildren` return unsupported (-25205) in the
fixture. A retained relationship is therefore insufficient. Children alone miss
the transparent/reveal-zero cases. `AXEnabled=false` is not a hidden signal:
disabled controls remain native/AX hit targets. Setting alpha/reveal to zero also
disabled the fixture controls as a native side effect; the disabled-only control
distinguishes these cases.

The fullscreen fixture's AX frames start at x=8/31/54, y=-24 and lie outside both
active displays, not merely above the main one. The second display starts at
(265,-1080), so treating all negative y coordinates as off-screen would be wrong.
That comparison uses run-1 AX frames with subsequent run-4 display metadata from
the same session; run-1 predates the display logging. Local native hit-testing
still matches in fullscreen and does not establish global rendered visibility.

`AXFullScreenButton` equals the `AXZoomButton` reference in run-4 and both browser
runs. Deduplicate these; there are three physical controls, not four.

## Cover feedback check

Run-4 places an owned opaque, mouse-intercepting floating panel over the exact AX
button union. Private bounds equal the requested rectangle; the on-screen window
list places the panel before the target; `SLSFindWindowAndOwner` independently
reports the panel at the union center. All underlying app-specific AX button hits
still match. This tests the essential feedback concern: our cover does not itself
make this fixture's button hit-test disappear.

Runs 2/3 stop at the first failed ordering check. Run-3 diagnostics show that the
normal-level panel was actually behind the target, despite a successful order
return. It cannot be counted as an occlusion experiment. Raising the owned panel
to floating level resolves the verified setup in run-4. Both failed source/binary
versions are retained. The initial compile failure (a C helper-name collision and
indentation warning) was fixed and rebuilt before any window opened.

This does not establish behavior for translucent, mouse-ignoring, off-Space or
other apps' covers, nor correct cover lifecycle/z-order in a product.

## Installed browsers

Chrome **158.0.8127.37** and Edge **157.0.4341.60** each run once, sequentially.
The harness refuses an already running target browser, uses its own temporary
profile and `about:blank`, verifies the AX PID/window, and takes three metadata
snapshots: windowed, settled fullscreen, returned to windowed. Fullscreen changes
use AX only. Both exit gracefully, original foreground focus is restored, and
their temporary profiles are removed after no matching helper remains.

Both browsers give the same result:

| State | Three button hit matches | In the window's direct AX children |
|---|---|---|
| Windowed | Yes | Yes |
| Settled fullscreen | Yes | No |
| Returned to windowed | Yes | Yes |

The fullscreen frames are on-screen at (12,12), (35,12), (58,12). Consequently,
`AXFullScreen=true` and missing direct children are **not** reasons to hide a
cover automatically. These are initial-profile default browser configurations;
different toolbar/fullscreen settings and pointer-hover reveal are untested.
No claim is made that AX matching proves that each browser actually drew a disc.
The prior read-only scan found no running allowed app windows; that scan adds
no browser acceptance evidence.

## Proposed detector and integration boundary

Use AX as an optional research backend behind explicit permission, retaining the
existing private window-geometry/tracking backend. Keep detection separate from
cover presentation and native removal. A conservative detector should:

1. Resolve PID and exact native window identity, acquire standard button
   relationships, verify expected roles and deduplicate aliases. Reacquire after
   window/titlebar/fullscreen changes or stale AX elements.
2. Read finite, positive button rectangles and compare against every active
   display. Missing/unsupported metadata and AX timeouts become **unknown**.
3. Hit-test each distinct button center against the **target app**, avoiding the
   system-wide hit-test that would normally select our covering window. Preserve
   disabled controls. Child membership is diagnostic, not a required predicate.
4. Report **AX-hit-confirmed**, **off-display**, **not-hit**, or **unknown**.
   Map `not-hit` to inferred hidden only for a validated app/control adapter and
   stable geometry. Another same-app window, a sheet, a stale frame or a custom AX
   implementation can also cause a miss. An unsupported relationship means
   unknown, not proof that no buttons are drawn.
5. Gate cover presentation separately on window/Space ownership and occlusion,
   ignoring our own cover when appropriate. Retain the tested app-specific hit
   source while the cover is up. Do not toggle a visible cover solely because a
   system-wide hit selects that cover.

No complete live detector is integrated in Margin by this spike. The metadata
probe is diagnostic, enumerating more attributes than a production poll should.
Its full four-relationship snapshots in run-1 took about 3.2–13 ms on this host;
this is not a sustained CPU or worst-case RPC benchmark.

Successful AX observer registration did **not** produce hide/alpha/reveal-change
events: run-4 sees only destruction, and run-1 sees fullscreen resize/move plus
destruction. Event-only visibility detection is unsupported by these tests.
Use lifecycle/geometry notifications plus bounded polling of the relevant active
window on a serial worker, with timeouts, stale-result rejection and an explicit
unknown state. A 30 Hz initial target would already permit roughly 33 ms plus RPC
delay; it is a design starting point, not measured acceptance or a no-flicker
promise. Polling must be benchmarked before choosing a shipping rate.

## Remaining acceptance

Three material limitations remain:

1. AX models hit participation, not compositor pixels. Custom apps, stale or
   overridden AX relationships, overlapping same-app windows and app-specific
   fullscreen reveal behavior require per-app validation. Safari remains manual.
2. Realtime transition latency, hover reveal, sustained CPU, minimization/Spaces,
   display rearrangement and loss of AX permission are not accepted yet.
3. This does not remove native controls or repair cover tracking flicker. The
   earlier cross-process cover exposure result remains unchanged.

Manual verification should observe standard and autohide toolbars in the target
apps, their settings, fullscreen-hover/exit, resize and occlusion while logging
the detector states. That observation can be done by the user without recording;
no extra capture permission is proposed.

The hit-test contract is documented in Apple's
[AXUIElementCopyElementAtPosition reference](https://developer.apple.com/documentation/applicationservices/1462077-axuielementcopyelementatposition)
and the installed `AXUIElement.h`. The app-scoped cover result above is measured
evidence for this fixture, not a guarantee inferred from the API name.
