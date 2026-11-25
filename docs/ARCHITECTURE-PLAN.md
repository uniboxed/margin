# Margin's next architecture (plan, awaiting approval)

Status: approved 2026-11-18, in progress on `refactor/host-core` (progress at the end). New features are paused until this is done.

## What we're fixing

The bugs since live resize (blinking parked tiles, the push-out of a window below its minimum size, Weather's loop)
share one shape: Margin corrects the screen, the app or macOS reacts, Margin corrects again. Each fix closed one path
into the loop, not the loop itself. The engine is also Mac-only Swift (HostEngine.swift, 4,580 lines), so Windows
would need it written again.

## Decisions (Tirth, 2026-11-18)

| Topic | Decision |
|---|---|
| Platforms | Mac now. Windows ready by design (only its window layer left), done next. Linux: door kept open, no work. |
| Shared core | Rust (`margin-core`, app/shared/core), shared by every OS. Each OS adds a thin adapter that reads and moves windows. |
| Private calls | Only where public APIs can't do the job. Each one checked at launch, each with a public fallback. |
| Background sizing | Measure tiles vs members on the real apps first (step 1), then Tirth picks. |
| Browsers | Safari, Chrome and Edge first-class. |
| Tabs | One hosted browser window per space; tab switches happen inside it. |
| Budget | Margin's own processes: idle under 0.5% CPU with no timers firing, under ~150 MB, a switch under 16 ms of Margin's work. Enforced by tests. |
| On failure | Quiet fallback to a safer hosting route at once, with a small themed note in the sidebar (details on click). Always logged. |
| Split view and overlays | The layout is a tree of panes from day one (one pane today). Built later. |
| An app's other windows | One main window fills the pane. Real extra windows (compose, documents) become items under the app. Panels and sheets float over the page area. Helper windows (like Weather's) are ignored by the layout. |
| Across spaces | Any app can be in several spaces. Its one window is shown in whichever Margin window is in focus; the others show it faded. |
| Permissions | Accessibility only, no Screen Recording. A faded app is drawn as a themed card (icon and name). A faded browser tab uses the browser's own tab capture, which needs no permission. |
| Relaunch | Each Margin window reopens on its space and starts only the item it showed; everything else starts on first pick. Exception: the default browser chosen in Margin always starts with Margin. A "Getting you started" loader shows until it's ready, so ⌘T and a search work at once. |
| Migration | Step by step. Margin stays usable and installable after every step. |
| Screen tests | Tirth's Mac while he's away (the rules as now), plus the test app taught every quirk found. |

## The shape

```
 themed UI (web view, unchanged)  ── intents ──▶  ┌───────────────── margin-core (Rust) ─────────────────┐
           ▲                                       │ model: windows, spaces, items, pane tree, hosts      │
           └──────────── state ───────────────────│ policy: classify windows, choose a route per app      │
                                                   │ reconciler: desired vs seen, one action in flight     │
 browser extensions (Safari, Chrome, Edge) ◀──────▶│ loop guard, scheduler (events, deadlines, no polling) │
                                                   └───────────────▲───────────────────────────────────────┘
                                                                   │ small C interface: events in, actions out
                                       ┌───────────────────────────┴─────────────┐
                                       │ OS adapter: macOS (Swift), Windows (Rust) │
                                       │ list/observe windows, move, size, park,   │
                                       │ hosting routes, covers                    │
                                       └───────────────────────────────────────────┘
```

### 1. Model and intents (core)
- One source of truth: Margin windows → spaces → items (app, browser tab) → a pane tree → hosts (the real window
  behind an item).
- The UI and the extensions send intents (switch, close, resize, move to space). The core answers with state; the
  sidebar's pending-intents layer stays as it is.

### 2. Reconciler (core), the main fix
- **Desired vs seen.** The core keeps the layout it wants. It acts only when what it sees differs.
- **Evidence, not timers.** Every action carries its expected result and a deadline. It's done when the OS reports
  that result (bounds, Space, focus), not after a fixed wait. A missed deadline is an event the core handles.
- **One action in flight per host,** changes coalesced. The drag stays the fast path: the shown pane follows frame by
  frame and the drag's end is an ordinary change.
- **Cause tracking.** Every change seen is attributed: ours (the expected result of an action in flight), the
  person's, the app's, or the OS reacting to something (a window closed in Margin's Space, a tile re-layout). A
  reaction to a known trigger, such as a helper window closing, is answered once and never re-fed.
- **Loop guard (generic).** The same correction for the same host three times within 5 s → stop, mark that host
  unstable, demote its route (below), show the note. A global cap on actions per second backs it up. Today's Weather
  loop and yesterday's blinking would both stop at the third round.

### 3. Policy: window classes and hosting routes (core)
- **Window classes:** main, extra (compose, document → an item), panel or sheet (floats), helper (short-lived, the
  tile's size, or never shown on its own → ignored), transient. Decided from what the window does (size, lifetime,
  role), never an app list.
- **Routes** behind one contract, each declaring what it gives (live background sizing, hidden from Mission Control
  and the Dock, a full-screen look):
  - Mac: **tiles** (in Margin's Space, live background sizing), **members** (full screen, sized at switch under a
    cover), **window mode** (plain window that follows the page area through Accessibility, for apps that can't go
    full screen without a Dock icon, like Music).
  - Windows: its own routes later, same contract.
- **Fallback ladder:** an app that fails or loops on its route drops to the next, chosen by behaviour and remembered
  per app version. It's retried after an app update.

### 4. Shared app across Margin windows
- One real window. The Margin window in focus owns it; the move happens under a cover when focus changes.
- Every other Margin window showing that item draws it faded: a themed card for apps, the extension's last tab capture
  for browser tabs.

### 5. Browsers
- One hosted browser window per space. Tabs, back, forward, reload and the address field are driven by Margin
  through the extensions (Safari: webkit engine; Chrome and Edge: chromium engine and the Rust connector).
- The browser's tab-swap blink is covered by Margin's cover.
- The default browser chosen in Margin starts with Margin, behind the "Getting you started" loader.

### 6. Scheduler and budgets
- Event-driven. When nothing changes, nothing wakes. A watchdog runs only while an action waits for evidence.
- Budgets checked by tests: idle CPU sampled over 60 s, memory after 20 switches, Margin's work per switch.
- Snapshots kept only for faded items and covers, capped by count and size.

## Testing
- **Core (Rust, any OS, seconds):** a simulated OS that replays recorded quirks: Weather's helper windows, minimum
  sizes, tile re-layouts, placeholders, slow redraws, Safari's tab blink. Plus a randomized test: any sequence of
  events must settle with no loop and within the action budget.
- **Adapter (Mac):** the screen suite on the test app, which learns each quirk the soak finds.
- **Soak (real apps, while Tirth is away):** minutes of switches, drags and opens per app, Safari included, with the
  screen recorded. It fails on a repeated correction, a black or empty frame, a window outside its place, or a blown
  budget. Saved state recorded and restored as now.

## Steps (each one leaves Margin usable and installable)
1. **Measure tiles vs members** on the real apps, Safari included: the switch after a resize, CPU, memory, loops.
   Numbers to Tirth, who picks the default route.
2. **Core model and reconciler in Rust** with the simulated OS and its tests. Nothing on the Mac changes yet.
3. **Link margin-core into Margin.app** (a universal static library with a small C interface, built by safari.sh).
   The Swift engine reads the Rust model first; nothing else changes.
4. **Move the decisions over** one at a time: reconciler and loop guard, then window classes, then routes and the
   fallback ladder. Swift keeps only the window calls (HostSystem as the adapter). Old HostEngine parts deleted as
   each one moves.
5. **Browsers:** one window per space; real Chrome and Edge checks.
6. **Shared apps across Margin windows** and the default-browser start with its loader.
7. **Budgets and soak** become part of the gate.
8. **Windows readiness:** the Windows shell's adapter compiled against the same contract and passing the simulated-OS
   tests (a real-Windows check stays in docs/windows/UNVERIFIED.md).

## Risks
- The Rust library in the Mac build: universal (arm64 and x86_64) and signed with the app. Steps 2–3 prove it before
  anything depends on it.
- The private tile and member calls stay private. Each is checked at launch and has its fallback route.
- Classifying windows by behaviour can misjudge a new kind of app. A wrong class shows up in the soak and the loop
  guard, not as a loop on someone's screen.

## Progress

- 2026-11-18: phases 1-2 done. margin-core's `host` module (layout, kinds with the helper kind, choice, reconciler,
  loop guard, causes, routes, one JSON call), margin-ffi linked into Margin.app, the Swift engine deciding through it;
  the loop guard wired into the reconciler, the re-layouts and the strays; routes.json per app version. Installed.
  Real screen: no regression in live-resize (30/31, the miss a known first-switch quirk), no loop with Weather. See
  DECISIONS.md "The hosting core in Rust, the loop guard".
- 2026-11-18: the anchors (two empty tiles of Margin's own at its Space's front: a tile change lays only them out
  again) and the event-driven scheduler (three hosted at rest 4.02% → 0.42% of a CPU). The start: the default browser
  first behind "Getting you started", then the item shown last. The note when an app moves to a simpler way.
  Installed. Full screen suite: behaviours 122/122, live-resize 31/31, crash 10/10, min 27/27.
- Decided while he was away (to confirm): one Safari window per profile, not per space (spaces sharing a profile share
  it: fewer windows, less memory, tab switches inside it as chosen). Each OS's step-by-step operations (full screen,
  tiles, parking) stay in its adapter: the core decides what, the adapter how.
- 2026-11-18 evening: an item in another Margin window (its card, faded, every theme; that window in front takes it
  back); tiles against members measured (tiles stay the default: DECISIONS.md); the soak on his own apps, 82 of 82;
  margin-core's reconcile driver against an OS adapter (`host::driver`, `HostAdapter`) and the Windows adapter for it
  (window mode, compile- and unit-checked, docs/windows/UNVERIFIED.md).
- 2026-11-18 night: a web item's card in another Margin window shows its page's picture, faded (the Safari copy's
  `hostPicture` as its window leaves: `tabs.captureVisibleTab`, at most 1600 px wide, memory only, never logged), every
  theme. The Mac engine's corrections now go through the core's loop in parts (`decide`, then `admit`: the tries, the
  guard and a stop's step down are the core's, `host::driver`), the same loop the Windows adapter runs whole. Which
  window of the shown app is let in front of Margin's window is the core's too (`host::front`).
- Left: Windows hosting needs Margin's own window there first (the Windows shell still draws over Chrome's and Edge's
  windows, the old way): the hosted design ported (its window, its page area, the library), then the adapter driven
  from it and run on a real PC. The core and the adapter are ready for it.
