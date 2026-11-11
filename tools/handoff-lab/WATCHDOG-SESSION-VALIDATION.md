# Native watchdog and OS-event acceptance

Prepared procedure, not a result or approval. The experimental launch default
stays off. No browser is controlled by the standalone probe.

The [lab runbook](README.md) requires **“Ask before any run on screen.”** The
standalone cover is physically on screen, even though small and passive. Obtain
approval for the exact modes/corner appearances and any user-assisted OS action
below. Build and inspect the fixed dry run first; compile only when root has
serialized native compilation. The `--approved-corner` argument records that
precondition; it does not grant approval itself.

## Current evidence

The recorded live-only observation passed 30 normal Safari switches and four
fault/close cases, plus independent per-request cleanup, on this host/build.
Its failed freeze controls still prevent matched-performance acceptance.
See [the actual report](results/26B131-2026-11-10-live-validation.md).

`cleanup-probe.swift` tests the actual owned Space/presentation components,
including a background alpha write while its own main thread is blocked. It
does not instantiate the complete production `NativeHandoffCover` watchdog.
The existing off-screen Native integration prepares/disposes the real page
with injected Space/presentation IO; it cannot establish physical activation.

## Production sources exercised unchanged

- `app/platforms/macos/shell/LiveHandoffCover.swift`: real renderer, 20-second
  DispatchSource watchdog, background lease.hide, generation guard, native
  end/bridge teardown and validation audit.
- `app/platforms/macos/private/LiveCoverSpace.swift`: real own-Space creation,
  mask15 readiness, level400, own-window alpha and retained verified cleanup.
- `app/platforms/macos/private/CoverPresentation.swift`: real checked per-view
  getter/setter and restoration lease.
- `app/platforms/macos/shell/OverlayWebView.swift`: actual no-network scheme,
  page configuration, bridge registration/unregistration and WKWebView.
- `app/platforms/macos/shell/WindowServer.swift`: real WorkspaceApps observers
  for the session-observation mode. The standalone safety callback is explicitly
  separate from Shell.appsChanged/browser recovery.

No source seam is required. The probe wraps real IO closures to record owned
identifiers/timestamps and delegates each operation unchanged. Presentation reads
temporarily retain the actual disposable cover view so its original setting and
post-cleanup bridge refusal can be checked, then release that reference. This
inspection retention must not be used as a product memory measurement.

## Build, default dry run and fixed boundaries

~~~sh
# Root only, after confirming no other native compilation:
bash tools/handoff-lab/native-cover-probe.sh --build
# No NSApplication, window, private write or app launch:
bash tools/handoff-lab/native-cover-probe.sh --dry-run
~~~

Build compiles production files from the same swift-sources.txt folder list,
plus native-cover-probe.swift. It does not compile startup/AppDelegate.swift,
start Margin, build dist, install anything or read Safari profile files.
The theme fixture is generated from repository test fixtures/built-in Arcadia;
profile IDs, tab data and URLs are synthetic. The renderer files come from the
explicit built app-page root, default dist/app, whose hashes are recorded.
The source/binary stamp refuses stale binaries; it never recompiles on `--go`.

The only visible surface is a 320×180 passive, click-through corner panel,
12 points inside the lower-right visible area of one display. Native's real
visibility gate checks that actual rectangle; `onScreen=false` is never treated
as a physical pass. Multiple displays or unavailable/locked sessions refuse.
No browser switch, screen capture, freeze, app restart, launch-default change,
injected foreign operation or automatic lock/sleep/display change is performed.

Every invocation gets a fresh /tmp/margin-native-cover-* directory, source/asset
manifest, native metadata JSONL, independent observer-child JSONL and outer
result. The outer supervisor has a 50-second deadline and terminates only its
owned standalone probe on failure/interruption. After exit it independently
verifies that PID has no remaining windows. The child observes only its parent's
exact owned window number/PID and exits when that window disappears or its
parent exits. It never calls private mutation functions.

## Mode 1: actual production watchdog

After approval for **one** corner-panel appearance:

~~~sh
bash tools/handoff-lab/native-cover-probe.sh --go --approved-corner --mode watchdog
~~~

1. Real page/bridge prepares, real Native activate checks Space membership,
   level400, visible window geometry/alpha and the page's double-rAF message.
2. Independent observer child must first record this owned window on screen
   with positive alpha. Record the add-return time just before production's
   watchdog arm and the subsequent shown/block times.
3. Block only the standalone probe main thread for 22 seconds. The computer,
   Safari and production Margin main thread are not blocked. The unmodified
   Native timer must execute at its real 20-second limit.
4. Before yielding the main actor to its queued cleanup, read child evidence:
   alpha must reach zero during the block, between add+19.8 and add+20.75 seconds.
   Record actual timing; this tolerance is a measurement assertion, never a
   production readiness timeout bypass. Missing/late evidence fails the run.
5. Let main-actor Native cleanup run. Require one emergency callback, expected
   failed-watchdog state, actual panel disappearance, real original presentation
   setting, level0 for every created Space, no retained leases/timers/resources,
   and created/disposed counts balanced in the Native audit.
6. On the deliberately retained old cover view, an actual bridge hello must
   reject with “no overlay”. Release that inspection reference afterward.

This proves the real native watchdog/component lifecycle on this host. Metadata
alpha is not physical pixel/animation evidence. A camera can independently
observe the corner without changing the probe or adding screen-capture load.

## Mode 2: cancel and reuse across the cancelled deadline

After approval for **two** corner-panel appearances:

~~~sh
bash tools/handoff-lab/native-cover-probe.sh --go --approved-corner --mode cancel-reuse
~~~

Show the first real cover; cancel after 250ms and verify all cleanup. Wait five
seconds, then prepare/activate the same NativeHandoffCover object again. Keep
the second cover shown until first-add+20.5s, comfortably before its own later
watchdog deadline. Require the new owned panel to remain visible, no emergency
callback, then cancel and verify cleanup. This checks cancellation/deadline and
generation reuse. It does not deliberately manufacture an already-queued old
main-actor callback; fake stale-callback tests remain a separate evidence type.

## Mode 3: actual OS delivery, owned-panel safety only

One corner appearance per requested event. The probe prints USER ACTION READY;
the user initiates that action within the 15-second window. No command below
initiates an OS transition. Stop if the requested event is absent or unexpected
events interfere; do not retry automatically.

~~~sh
# After approval and with the user ready to unlock:
bash tools/handoff-lab/native-cover-probe.sh --go --approved-corner --mode session --event 'screen locked'
# After approval and with the user ready to wake the Mac promptly:
bash tools/handoff-lab/native-cover-probe.sh --go --approved-corner --mode session --event 'will sleep'
# Only if a safe real display change is available and approved:
bash tools/handoff-lab/native-cover-probe.sh --go --approved-corner --mode session --event 'displays changed'
~~~

Actual WorkspaceApps event names are recorded with sessionAllows. The first
sleep/lock/session-inactive/display-change event immediately ends this probe's
own panel for safety. Only observing the requested actual event plus physical
cleanup counts as that component check; a synthetic notification does not.
The main thread remains responsive in this mode. The normal watchdog is still
armed; a watchdog outcome is a failed OS-delivery observation.

| Requested observation | User action and exact evidence | Boundary |
|---|---|---|
| Lock | User presses Control-Command-Q once READY and unlocks normally. Record actual distributed screen-locked/session-inactive event, disposal, zero resources, and session refusal while locked. | No automated unlock or authentication. Absence of a private lock key is not proof of unlocked state; report dictionary/event availability. |
| Actual sleep | User chooses Sleep once READY and wakes promptly. Record will-sleep, disposal before sleep, wake/session-active events and post-wake cleanup. | Screen-sleep alone is not system sleep. Metadata sampling pauses while the Mac sleeps; do not claim continuous coverage or watchdog latency through sleep. |
| Display change | Starting with one display, user connects a test display, or performs an explicitly approved real display-mode change. Record did-change-screen-parameters and disposal. | Requires hardware or an actual supported display configuration operation. This probe refuses a multi-display start, so disconnect-from-two-displays needs a separately prepared case. Fabricated notifications prove only routing; this does not establish a multi-display overlay result. |

The standalone mode tests actual observer delivery plus Native disposal. Its
safety callback is lab code, so it does not certify the full production Shell
path, active browser identity, parked-window restoration or post-unlock UI.

## Production OS-event follow-up for a bundled approval

Prepare the signed candidate and a guarded, isolated Test A/Test B run first;
keep the persistent launch default off and restore the original preference
afterward. Group these exact counts/actions with the root's prepared sharing/
comparison and physical-visual cases. New approval must explicitly cover corner
appearances and lock/sleep/display actions; unused older switch counts do not
implicitly authorize them.

For each user-assisted event, have one known Test A full-screen source and a
known destination, record native readiness/audit/window IDs, and begin one
deliberately covered recovery case that leaves enough time for the user's
gesture. Use an existing logged one-shot suppressed-fullscreen test fault,
not a production timeout increase. The user acts when the real product cover
is confirmed shown. Stop at the first unexpected failure.

Check actual WorkspaceApps event -> Shell.appsChanged -> revealNow chain:

- will-sleep/screen-sleep/screen-locked/session-inactive: `.sleep` immediate
  disposal, no queued cover/freeze started, original per-view settings restored;
  noFreeze persists until a genuine allowed wake/unlock/session-active event.
- display change/Dock restart: `.aborted` disposal and bounded recovery; no
  stale old-screen cover/panel/frame retained. Do not restart the Dock as a
  substitute for a hardware/display test without separate authorization.
- wake/unlock: SessionVisibility must permit the session before the sleep gate
  clears. Verify a real visible source/destination and correct Space, then a
  later ordinary profile switch only if its count was included in approval.

Real hardware multi-display layout, locked-screen physical composition, session
switching, animation smoothness and other OS builds remain separate checks if
not actually exercised. Never promote event injection, component passes or
successful browser switches into those claims.

## Prepared but not yet verified

The standalone source/script is compiled, ad hoc signed and its fixed no-window
dry run passes on 26B131 (2026-11-11). The synthetic fixture also prepares the
real cover in the separate offscreen allocation/crash probes. No watchdog or
session mode has appeared on screen; those require the specific approval above. No result in
this document closes the default-off acceptance gate.
