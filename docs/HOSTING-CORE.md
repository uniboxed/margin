# The hosting core (design, 2026-11-17)

Asked by Tirth on 2026-11-17, after a day of app-by-app fixes: "if we keep having these issues with every
app, this is not going to work. We have to address each issue properly and generically, and create a better
framework to address these issues."

This document is the contract for two pieces built against it:

1. **The hosting core**: how Margin keeps a hosted app in the state it wants, for any app, with no app names in
   the code.
2. **The behaviour test framework**: how every way a real app has misbehaved becomes a reproducible behaviour
   of a test app, checked off screen and on the real screen.

## Why the current engine keeps breaking

`HostEngine` hosts an app as a fixed sequence: launch, find a window, full screen, reserve, move into Margin's
Space, destroy its own Space, show. Each step assumes the app behaves as the last app we tested did. Real apps
don't, and every surprise has needed its own patch:

| Seen | What the app did | What the sequence assumed |
|---|---|---|
| Safari, 2026-11-17 15:19 | restored two windows into full-screen Spaces of their own and one on the Desktop | a Safari Margin started has only the windows Margin asks for |
| Safari, 14:05 | a window opened to wake a profile stayed in Margin's Space | every window Margin opens is closed by the step that opened it |
| Maps, 07:52 | restored its window already in full screen, in a Space the Dock made before Margin looked | a new window is a normal window |
| Maps, 14:05 / 15:19 | tried to terminate while parked; later ran with a Dock icon and no window at all | an app runs with a window, or quits |
| Phone, 14:05 / 15:21 | its only window (a dialog) stayed off screen while in Margin's current Space | a window in the current Space is on screen |
| Messages, 15:20 | its shown window left every Space every few seconds; a second window at the same frame | a shown window stays where it was put |
| Mail, 14:06 | refused AX (-25200) while launching; left a 1512×88 toolbar strip after a backed-out full screen | AX answers at once; a full-screen exit leaves nothing behind |
| WhatsApp, Mail, 15:19 | restored in full screen (handled since 9c2e840c) | — |

Each row was fixed where it hurt, and the next app found the next gap.

## Principles

1. **Observe, don't assume.** Margin keeps a live model of every window of every app it hosts, from the window
   server (numbers, owners, layers, bounds, on-screen, alpha, Spaces) and Accessibility (role, subrole,
   full-screen, main, focused, minimised) plus Accessibility's notifications (window created, destroyed, moved,
   resized, miniaturized, focused, full-screen changed). Nothing is believed because a call returned.
2. **Classify generically.** Each window gets a kind from rules on role, subrole, size, position, layer and
   history (never a bundle id): `main`, `auxiliary` (settings, inspectors, small panels), `dialog` (alerts,
   sheets), `strip` (a full-screen toolbar or title band: full width, short), `leftover` (restored from an
   earlier session, or one Margin opened only to wake something), `transient` (menus, tooltips, popovers:
   above layer 0 or tiny). The rules live in one pure function with its own tests.
3. **One desired state per app,** written down as data:
   - shown: exactly one `main` window, at the page area (full screen as a member of Margin's Space, or a
     window placed in the page area), on screen, under Margin's panel; `dialog`s of that app on top of it;
     small `auxiliary` windows allowed in front of Margin only if they don't cover the sidebar; no `strip`
     visible; no `leftover` anywhere (closed, or parked until closed).
   - parked: the `main` window in a private Space, nothing of the app on any user Space, the app running.
   - given back (Margin quits or the row closes): apps Margin started quit; apps the person opened left
     running with a normal window where it was.
4. **Reconcile, don't sequence.** A single reconciler compares the observed model with the desired state
   whenever an observation changes (and at a slow heartbeat), and applies the smallest correction from a fixed
   menu, each one idempotent, bounded (tries and time per app per show), logged once with what was observed:

   | Observed vs desired | Correction |
   |---|---|
   | no `main` window, app running | ask the app to reopen (as a Dock-icon click: `kAEReopenApplication` / LaunchServices open), then wait for one |
   | app not running | launch it (no Dock icon) |
   | `main` in its own full-screen Space | place it from there (reserve, move, destroy) |
   | `main` full screen with no Space of its own | take it out, then ask again |
   | `main` not full screen and the app can go full screen | ask, from a Space where macOS takes it |
   | `main` can't go full screen | window mode: frame it into the page area |
   | `main` in no Space / another Space while shown | put it back in Margin's Space (after macOS's transition is over) |
   | `main` in Margin's current Space but off screen | bring the app forward (activate, raise), then look again |
   | `main` replaced (a new `main`-kind window appeared, the old one went or is ordered out) | adopt the new one; never fight the app |
   | `leftover` anywhere | close it (its app's own close; a Safari window through its copy), parked until closed |
   | `strip` visible | take its window fully out of full screen / wait for it to go; never let it in front |
   | AX busy (-25200, refusals) during launch | retry with backoff up to a bound |
   | correction budget used up | the fallback below |

5. **Fallback is predictable.** If an app can't reach the desired state within its budget (a few seconds), it
   is shown in window mode if it can be framed, else the page card says so in Margin's words and keeps the item.
   It never flickers, jumps between Spaces, covers the sidebar or vanishes.
6. **One way in.** `host(app)` first normalises whatever the app is doing (not running, running with windows,
   running with none, restored its own state, hidden, full screen elsewhere) through the same reconciler. There
   is no separate path for "an app the person opened" beyond what the desired state says about giving back.
7. **No app names.** No bundle id appears in the core's rules. An app-specific need is a new behaviour class
   (below) with a generic rule.

## Shape in the code

- `HostModel` (new): the observed model, per app: its windows with their attributes and kinds, its process
  state, its Spaces. Fed by `HostObserver` (window-server reads at the poll + AX notifications per hosted pid,
  coalesced). Pure value types; testable without a screen.
- `WindowKinds.classify(_:)` (new, pure): the classification rules.
- `HostDesired` (new): what each hosted app should be now (shown in which Margin window and page area, parked,
  given back).
- `HostReconciler` (new): `step(model, desired) -> [Correction]`, pure; the engine applies the corrections
  through the existing `HostSystem` calls, one at a time, serialised, with budgets and logging.
- `HostEngine` keeps its public API (`open`, `show`, `close`, `pageRectChanged`, `parkShown`, `quitAll`, the
  events) so `HostedSession`, the shell and the UI don't change; its internals become: update desired →
  reconcile until settled or budget spent → emit events. The existing primitives (early path, freeze, edge
  reservation, bridged moves, private Spaces, AX framing) stay as the corrections' building blocks.
- Logging: one line per correction (`host: <app>: <observed> → <correction> (<budget left>)`) and one per
  settle/fallback, so a real session's log reads as a story.

## Behaviour classes and the test framework

Every behaviour a real app has shown becomes a **behaviour class** with:

1. a switch in the **behaviour test app** (`tools/screen-tests/apps/Chameleon`, built from source in the repo;
   two or more copies with their own bundle ids so they can run side by side): one per class, set through the
   app's own defaults before it launches;
2. a model of it in the **stand-in world** used by `tools/app-tests` (so the reconciler is tested off screen
   against the same behaviour);
3. a **scenario** in the real-screen suite.

Classes from the table above, to start:

| Class | Chameleon switch | Seen in |
|---|---|---|
| restores windows (normal / full screen / both, n of them) | `restore` | Safari, Maps, WhatsApp, Mail |
| outlives its window (runs with none after its window closes) | `windowless` | Maps |
| attempts automatic termination when hidden | `autoTerminate` | Maps |
| main window is a dialog-role window | `dialogMain` | Phone |
| orders its window out / never orders it in until activated | `ordersOut` | Phone |
| replaces its main window periodically / keeps a twin | `replacesWindow` | Messages |
| AX busy for N s after launch | `axBusy` | Mail |
| leaves a toolbar strip after full screen | `strip` | Mail |
| extra auxiliary window (settings) / over the sidebar | `auxiliary` | Mail |
| can't go full screen / fixed size | `noFullScreen`, `fixedSize` | Calculator, Phone |
| opens extra windows on demand (like a profile wake) | `extraWindow` | Safari |

The **real-screen suite** moves from `/tmp/margin-toolbar-test/hosted/check10.swift` into the repo as
`tools/screen-tests/` (`npm run test:screen`):

- scenarios as data: a list of steps (launch Margin from a given Space, host a Chameleon with given switches,
  switch, resize, swipe, quit, relaunch) and assertions read from the window server, Margin's dev hook and the
  test app's own log;
- the safety rules of check10, kept: an idle gate, own test apps only, a watchdog with a full restore on any
  exit or signal, the starting Space put back, no modifier keys left held;
- required before every install; never in CI (it needs a real screen); a later stage runs it inside a macOS VM
  so it doesn't need the person away.

Rule from now on: **a real-screen bug isn't fixed until its behaviour class exists in Chameleon, the stand-in
world and the suite, and the suite fails without the fix.**

## A smoke run on the person's own apps

Some behaviours will only ever show with real apps. With Tirth's OK (not given yet), a separate, opt-in run
hosts a fixed list of his apps while he's away, after recording each app's saved window state
(`defaults read <id>`) and puts it back after. Until he says yes, only Chameleon is used.

## Stages (each ends green: gate + the real-screen suite)

1. **Framework first:** Chameleon with the classes above, the stand-in world's models of them, the suite in
   the repo with check10's scenarios ported. The suite run against today's engine should fail on exactly the
   known-broken classes (that's the baseline).
2. **Observer + classifier**, logging only, no behaviour change: real sessions start telling us each window's
   kind.
3. **Reconciler** for shown/parked/given back, replacing the sequence inside `HostEngine` behind the same API;
   the suite's known-broken classes turn green.
4. Delete the special cases the reconciler made redundant (woken-window parking, the restored-window sweep,
   the various "found out of Margin's Space" paths), one at a time, the suite green after each.

Not in scope here: live resize during a sidebar drag (separate research), the privileged route question
(the bridged operations; awaiting Tirth), the sidebar click's brief key flicker.
