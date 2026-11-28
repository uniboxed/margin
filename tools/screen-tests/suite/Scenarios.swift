// The scenarios, as data: a name, the Chameleon copies and switches it needs, its steps (each with its assertions).
// The runner (Runner.swift) does each step; `--dry-run` prints them. A part is the scenarios one process runs under one
// 10-minute limit, from one Margin launch, with its own record and restore.
import Foundation

enum Target: Equatable {
  case copy(Int), app(String)
  var id: String { switch self { case .copy(let n): return copies[n - 1].id; case .app(let b): return b } }
  var text: String { switch self { case .copy(let n): return "Chameleon \(n)"; case .app(let b): return (realApps + [weather]).first { $0.bundle == b }?.name ?? b } }
}
// The design's desired state for a shown app (docs/HOSTING-CORE.md, principle 3), read from the window server:
// exactly one main window at the page area (full screen as a member of Margin's Space, or a window placed there), on
// screen, in Margin's Space only, under Margin's panel; no leftover in any user Space; no strip; nothing of the app over
// the sidebar in front of Margin's panel. `framed`: the app can't fill the page (a fixed size): its main window inside
// the page area is enough. `auxiliary`: small windows of its own allowed beside it (never over the sidebar).
struct Desired: Equatable {
  var target: Target
  var framed = false
  var auxiliary = false
  // A read within this long of the copy's last line saying it (its own change: a window replaced) isn't counted: the
  // design leaves the moment between an app's change and its adoption to the app ("never fight the app").
  var settles: (String, Double)? = nil
  static func == (a: Desired, b: Desired) -> Bool { a.target == b.target && a.framed == b.framed && a.auxiliary == b.auxiliary && a.settles?.0 == b.settles?.0 && a.settles?.1 == b.settles?.1 }
  var text: String {
    "\(target.text): one main window \(framed ? "inside" : "at") the page area, on screen, in Margin's Space only, under Margin's panel; no leftover in any user Space; no strip; the sidebar never covered\(auxiliary ? "; its auxiliary window allowed if not over the sidebar" : "")"
  }
}
enum Expect: Equatable {
  case desired(Desired)
  case running(Target, Bool)          // still running, still Margin's (no termination seen by NSWorkspace)
  case said(Int, String)              // the copy's own log says it (its switch reached it)
  case givenBack([String])            // after Margin's quit: those that weren't running quit, the others with a normal window
  // Its window closed (by itself, as the person's ⌘W would) and no other came: Margin closed its item (Tirth, 2026-11-17):
  // the page card empty, nothing of it on screen in a user Space, no reopen asked of it after its close.
  case itemClosed(Int)
  var text: String {
    switch self {
    case .desired(let d): return d.text
    case .running(let t, let on): return "\(t.text) \(on ? "still running (NSWorkspace too)" : "not running")"
    case .said(let n, let w): return "Chameleon \(n)'s log says \"\(w)\""
    case .itemClosed(let n): return "Chameleon \(n)'s window closed and no other came: its item closed (Margin says its window closed; the page card empty; nothing of it on screen in a user Space; never reopened after)"
    case .givenBack(let ids): return "given back after Margin quit (\(ids.count) app(s)): those that weren't running before quit, those that were still running with a normal window and a Dock icon"
    }
  }
}
enum Step: Equatable {
  // check10's steps, ported (each with check10's assertions and names)
  case openMargin                                 // L, 0
  case firstHost(Int)                             // d1 d2 a1 m1
  case activateAbove(Int)                         // a2
  case clicks(Int)                                // b1 a3 b2 k1 k2 k3
  case palette(Int)                               // c1 c1b c2
  case secondHost(Int)                            // d3 a4
  case switchBack(Int)                            // d4 m2
  case sidebarDrags(Int, [Int])                   // e1…
  case frontMechanism                             // f
  case spaceSwipes(hosted: Int, own: Int, times: Int) // s0…s5
  case freshHost(Int)                             // w
  case busyWithExtras(Int)                        // x1 x2
  case relaunch(Int)                              // R
  // the behaviour scenarios' verbs
  case setSwitches(Int, [String: String])
  case prime(Int)
  case host(Target)
  case show(Target, maxMs: Int?)                  // a switch to an item already prepared (its time asserted if given)
  case trigger(Int)                               // the copy's extra window, asked by its notification
  case wait(Double, String)
  case expect(Expect)
  case hold(Expect, seconds: Double)
  case forget(Target)
  case quitMargin
  // live resize (docs/HOSTING-CORE.md "Live resize: tiles in Margin's Space")
  case liveDrag(Int, dx: Int, steps: Int, parked: [Int]) // drag-live; background-sized
  case liveDragApp(Target, dx: Int, steps: Int, parked: [Target]) // ...with any app
  case switchSized(Int)                           // switch-after-resize
  case listedOnly(String)                         // mission-control
  case killCopy(Int, shown: Int)                  // hosted-app-crash
  case marginQuitTiles([Int])                     // margin-quit with tiles
  case killMargin([Int])                          // margin-crash recovery
  case memory(String)                             // Margin's, WindowServer's and the copies' resident memory, said
  // a window's own minimum size (MinSize.swift)
  case tileMin(Target, expect: CGSize?)           // tile-min
  case minDrag(Target, dx: Int, steps: Int, endsAt: Int?, parked: [Target]) // min-drag
  case overflow(Target, seconds: Double)          // overflow
  case sidebarWidth(Int)                         // the sidebar that wide first (dev hook `sidebar`): a known start
  // the loop guard (the hosting core's guard.rs: docs/ARCHITECTURE-PLAN.md)
  case settled(Target, seconds: Double)           // settled: no re-layout loop
  // the budgets (docs/ARCHITECTURE-PLAN.md "Scheduler and budgets")
  case idleCost(String, seconds: Double)          // idle-cost: Margin's CPU, wakeups and footprint with nothing happening
  case animations(String)                         // what Margin's page keeps redrawing for (dev hook `say animations`), said
  // the first click in another pane (PaneClicks.swift; Margin's PaneClickTap.swift)
  case splitWith(Int, adding: Int)                // a split of two hosted copies (dev hook `ui split.add`)
  case paneClick(Int, PaneClickKind)              // a first click of that kind in that copy's pane without the keys
  case paneClickTimes(Int, Int, times: Int)       // grid clicks back and forth, timed; then one in the pane with the keys
  case cutPaneEdge(Int, other: Int, minWidth: CGFloat, seconds: Double) // a cut pane at the display's edge: past it, held
  case paneOpens(Int, other: Int, minWidth: CGFloat) // the pointer resting on a cut pane: opened to fit its app, the other folded
  case paneBack(Int, other: Int)                  // the pointer on the sidebar: the split back at its sizes
  case foldedCardOpens(Int, other: Int, minWidth: CGFloat) // the pointer resting on a folded pane's card: that one opened
  // a sidebar row dropped on the page (SplitDrop.swift; docs/FLEX-SPLIT.md step 2)
  case rowDrop(Int, RowDrop, expect: [Int])       // that copy's row dragged from the sidebar and dropped there: the split then
  // every pane of a split draws active (PanesActive.swift; Margin's PanesActive.swift)
  case panesActive(Int, Int)                      // both copies active, each its pane's window key; the focused one the front app
  case panesActiveFlips(Int, Int, times: Int)     // clicks back and forth: both active after each, the inactive gaps timed
  case panesActiveHidden(Int, Int, alone: Int)    // the split hidden: the kept one let go after the grace
  case panesActiveQuit(Int, Int)                  // Margin quits: the kept one let go before the copies quit
  case panesActiveCrash(Int, Int)                 // Margin killed: the kept one still active; opened again: let go first

  var text: String {
    switch self {
    case .openMargin: return "open the built Margin (MarginDevHooks YES, MarginPrepareBrowser NO, MarginResumeLast NO), bring it to the front: L Margin in full screen; 0 the page card empty and painted"
    case .firstHost(let n): return "host Chameleon \(n) (dev hook `app`): d1 the card opaque while loading, see-through once shown; d2 the hole is its window; a1 Margin's panel above it; m1 on screen in Margin's Space only a second later"
    case .activateAbove(let n): return "activate Chameleon \(n): a2 Margin's panel still above it"
    case .clicks(let n): return "click in Chameleon \(n)'s content, on Margin's frame, on an empty spot of the sidebar (only where the window list says it's theirs), a double-click on that spot and in the pane: b1 b2 a3 k1 k2 k3"
    case .palette(let n): return "Margin's palette key over Chameleon \(n), three plain letters, Escape, a plain key: c1 c1b c2"
    case .secondHost(let n): return "host Chameleon \(n) as a second app: d3 the card opaque all through its opening; a4 Margin's panel above it"
    case .switchBack(let n): return "switch back to Chameleon \(n), prepared: d4 no loader; m2 on screen in Margin's Space only"
    case .sidebarDrags(let n, let o): return "the sidebar's edge moved \(o.count) times (dev hook `sidebar`, widths +\(o.map(String.init).joined(separator: ", +"))): e1…e\(o.count) one placing each, Chameleon \(n) at the page area, in Margin's Space"
    case .frontMechanism: return "f: how Margin's window stays in front (its level held by the window server, or its order)"
    case .spaceSwipes(let h, let own, let t): return "quit Chameleon \(own), open it ON ITS OWN in full screen beside Margin's Space, ⌃←/⌃→ there and back \(t + 1) times (only if Mission Control's keys are the default and only Desktops are between), Control checked released after each: s0…s\(t + 1) Margin above Chameleon \(h) each time; s\(t + 2) the palette after"
    case .freshHost(let n): return "quit Chameleon \(n) and ask for it again with Margin's Space current: w full screen at the page area within 2 s of its first window, never window mode"
    case .busyWithExtras(let n): return "Chameleon \(n) fresh with axBusy 2.5, strip at:6,for:5, auxiliary sidebar,at:6,for:5,borderless: x1 full screen at the page area, never window mode; x2 neither extra window in front of Margin's panel"
    case .relaunch(let n): return "quit Margin and open it again (MarginResumeLast as shipped), only if its last item is Chameleon \(n): R shown again by itself behind the loading card"
    case .setSwitches(let n, let s): return "Chameleon \(n)'s switches: \(s.isEmpty ? "none" : s.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))"
    case .prime(let n): return "prime Chameleon \(n)'s restored windows: open it on its own (its windows on screen, its full-screen ones in Spaces of their own), let it quit keeping them; back to Margin's Space"
    case .host(let t): return "host \(t.text) through Margin's dev hook (`app \(t.id)`); wait for shown, window mode or failure (30 s)"
    case .show(let t, let ms): return "show \(t.text) again (a switch)\(ms.map { ": switched in \($0) ms or less" } ?? "")"
    case .trigger(let n): return "ask Chameleon \(n) for an extra window (its notification, no permission)"
    case .wait(let s, let why): return "wait \(Int(s)) s (\(why))"
    case .expect(let e): return "expect: \(e.text)"
    case .hold(let e, let s): return "for \(Int(s)) s (a read every 0.5 s), stays: \(e.text); the same windows and page state all along (predictable)"
    case .forget(let t): return "remove \(t.text)'s item from Margin's library (dev hook `forget`), quit it if it still runs"
    case .quitMargin: return "quit Margin"
    case .liveDrag(let n, let dx, let st, let parked): return "drag-live: the sidebar's edge dragged \(dx > 0 ? "+" : "")\(dx) pt over \(st) display frames (dev hook `drag`: the page's own handle, no event posted to the system), Chameleon \(n)'s window's model bounds read every ms: it follows each step; background-sized: Chameleon \(parked.map(String.init).joined(separator: ", ")) at the new page area within 1 s of the release; CPU of Margin, WindowServer and the copies said"
    case .liveDragApp(let t, let dx, let st, let parked): return "drag-live: the sidebar's edge dragged \(dx > 0 ? "+" : "")\(dx) pt over \(st) display frames (Margin's dev hook only), \(t.text) shown: it follows each step; background-sized: \(parked.map(\.text).joined(separator: ", ")) at the new page area within 1 s"
    case .switchSized(let n): return "switch: show Chameleon \(n) (parked; after a resize: sized in the background): its first frame on screen and every frame for 300 ms at the page area, Margin's window whole, 99 ms or less"
    case .listedOnly(let why): return "mission-control (\(why)): only Margin's Space listed beside the run's first Spaces"
    case .killCopy(let n, let shown): return "hosted-app-crash: Chameleon \(n) killed (SIGKILL, the suite's own test app): its tile gone from Margin's Space, Margin's window whole, Chameleon \(shown) at the page area"
    case .marginQuitTiles(let ns): return "margin-quit with tiles: quit Margin; Chameleon \(ns.map(String.init).joined(separator: ", ")) given back and quit, nothing listed but the run's first Spaces"
    case .killMargin(let ns): return "margin-crash recovery: Margin killed (SIGKILL) with Chameleon \(ns.map(String.init).joined(separator: ", ")) in tiles of its Space, opened again: its recovery gives them back (quit), its old Space and the tiles destroyed"
    case .memory(let label): return "memory (\(label)): Margin's, WindowServer's and the copies' resident memory, said"
    case .tileMin(let t, let e): return "tile-min: \(t.text)'s tile in Margin's Space says the minimum its app gave it (the window server's SizeConstraints, read only)\(e.map { ": about \(Int($0.width))x\(Int($0.height))" } ?? "")"
    case .minDrag(let t, let dx, let st, let ends, let parked): return "min-drag: the sidebar's edge dragged \(dx > 0 ? "+" : "")\(dx) pt over \(st) display frames (dev hook `drag`), \(t.text) shown\(parked.isEmpty ? "" : ", \(parked.map(\.text).joined(separator: ", ")) parked"), every window's bounds and Spaces read every ms: never out of Margin's Space, never narrower than its minimum, the page area \(ends.map { "\($0)" } ?? "as dragged (its minimum the floor)") wide at the end\(parked.isEmpty ? "" : "; the parked ones at the page area or at their minimum width, right edge aligned, never in a user Space")"
    case .sidebarWidth(let w): return "the sidebar \(w) wide first (dev hook `sidebar`, as a drag that ends there): the page area \(1504 - w) wide"
    case .overflow(let t, let s): return "overflow: \(t.text), wider by its own minimum than the page area, held \(Int(s)) s in Margin's Space at its minimum width, its right edge the page area's"
    case .animations(let label): return "animations (\(label)): Margin's page's running animations and its own frame requests in a second (dev hook), said"
    case .idleCost(let label, let s): return "idle-cost (\(label)): nothing done for \(Int(s)) s: Margin's CPU time, its idle wakeups a second and its memory footprint (the kernel's own counts), said; the budget: under 0.5% CPU"
    case .splitWith(let main, let adding): return "split: Chameleon \(adding) added beside Chameleon \(main) (each shown once for its item id, dev hook `ui split.add`, as the row's menu): side by side in Margin's Space, Margin says `pane clicks: on` (the press tap, running since the first app was hosted, in its split mode)"
    case .paneClick(let n, let kind):
      let what: String
      switch kind {
      case .grid: what = "its grid (an NSView that refuses the first mouse, as WebKit does): its click and release logged by it"
      case .button: what = "its button (it takes the first mouse anyway: unchanged)"
      case .field: what = "its field, then a plain key (a), only if the copy is the front app and no field of Margin's has the keys: the field's length up by one"
      case .double: what = "a double-click on its grid (counts 1 and 2 posted): clicks with counts 1 and 2"
      case .drag: what = "a drag from its grid (a press, 10 drags 16 ms apart, a release): its press, drags and release, in order"
      }
      return "pane click (\(kind.rawValue)): a first click in Chameleon \(n)'s pane while the other has the keys (the other's grid clicked first if needed), only where the window list says Margin's panel then the copy are under the point: \(what); its window key, Margin's focus on it, Margin's `a click in its pane … the click delivered` line"
    case .cutPaneEdge(let n, let o, let w, let s): return "cut pane: Chameleon \(n)'s window at its minimum (\(Int(w))) from its pane's start, the rest past the display's edge, in Margin's Space, nothing of it over Chameleon \(o)'s pane, its right its one arrow (Margin's `cut panes`); held \(Int(s)) s, a read every 0.5 s: never moved, never out of its tile"
    case .paneOpens(let n, let o, let w): return "split opens: the pointer resting on Chameleon \(n)'s cut pane (in its hole, the copy's): after the pause Margin's page opens it to its app's minimum (\(Int(w))), its window at its pane now (no longer cut), Chameleon \(o)'s pane folded with its window at its own minimum and blurred behind its card (Margin's `folded panes blurred`), both in Margin's Space"
    case .paneBack(let n, let o): return "split back: the pointer moved onto Margin's sidebar: after its pause the split goes back to its own sizes (Chameleon \(n)'s and \(o)'s panes even again), no pane folded (Margin's `no pane folded`)"
    case .foldedCardOpens(let n, let o, let w): return "split opens: the pointer resting on Chameleon \(n)'s folded card (Margin's to take: no hole there): that pane opens to its app's minimum (\(Int(w))), Chameleon \(o)'s folds and is blurred"
    case .rowDrop(let n, let k, let e): return "split drop: Chameleon \(n)'s row pressed in Margin's sidebar, dragged over the page (the pointer Margin's over the holes while held) and let go \(k): the split then \(e) left to right, each copy's window in Margin's Space"
    case .paneClickTimes(let a, let b, let t): return "pane click times: \(t) grid clicks back and forth between Chameleon \(a) and \(b), each in the pane without the keys: every one delivered, Margin's key time (median, most; under the 120 ms cap) and the press's post to the copy's click; then a click in the pane with the keys: straight through, Margin says nothing"
    case .panesActive(let a, let b): return "panes active: Chameleon \(a) and \(b) each asked its state (its notification: AppKit's own word): both active, each its pane's window key, the focused one the window server's front app"
    case .panesActiveFlips(let a, let b, let t): return "panes active flips: \(t) grid clicks back and forth between Chameleon \(a) and \(b) (each a pane click, posted as pane-clicks posts them): both active after every one; the one that had the keys inactive for a moment only (its own resign and activation times)"
    case .panesActiveHidden(let a, let b, let alone): return "panes active: Chameleon \(alone) shown alone (dev hook): the kept one of Chameleon \(a) and \(b) let go after the grace (1 s), inactive"
    case .panesActiveQuit(let a, let b): return "panes active: quit Margin with Chameleon \(a) and \(b) in a split: Margin's `(Margin quits` let-go line, the kept copy's own resign logged before it's quit"
    case .panesActiveCrash(let a, let b): return "panes active: Margin killed (SIGKILL) with Chameleon \(a) and \(b) in a split: the kept copy still says it's active; Margin opened again: `a crashed Margin kept 1 app active: 1 let go`, the copy's resign logged before its quit"
    case .settled(let t, let s): return "settled: \(t.text) shown and left alone \(Int(s)) s: Margin's Space's tiles laid out again by a change Margin didn't make at most 3 times (the loop guard's limit; 2026-11-18 13:30: 54 times in 18 s), \(t.text) at the page area in Margin's Space at the end"
    }
  }
}
struct Scenario {
  let name: String
  let title: String
  let copies: [Int]
  let steps: [Step]
  let estimate: Double // seconds, for splitting into parts
}
struct Part {
  let name: String; let scenarios: [Scenario]; let realApps: Bool
  var apps: [RealApp]? = nil // the person's apps it hosts (nil: every installed one of RealApps.swift's list)
  var personsApps: [RealApp] { apps ?? installedRealApps() }
}

// ---- check10's steps, ported (copies 1 and 2 as its two test panes) ----
let core = Scenario(name: "core", title: "check10's steps: Margin's window in front of what it hosts, clicks, palette, switches, sidebar drags, Space swipes, a fresh launch, a busy app with extra windows, a relaunch",
                    copies: [1, 2], steps: [
  .setSwitches(1, [:]), .setSwitches(2, [:]),
  .openMargin, .firstHost(1), .activateAbove(1), .clicks(1), .palette(1), .secondHost(2), .switchBack(1),
  .sidebarDrags(1, [60, 20, 80, 40, 10, 0]), .frontMechanism, .spaceSwipes(hosted: 1, own: 2, times: 3), .freshHost(2), .busyWithExtras(2), .relaunch(1),
], estimate: 420)

// ---- one scenario per behaviour class (docs/HOSTING-CORE.md's table): Chameleon 3 hosted with that switch, Chameleon 1
// hosted plain first (the item a park shows instead) ----
let hold = 30.0
func behaviour(_ name: String, _ title: String, _ switches: [String: String], framed: Bool = false, auxiliary: Bool = false, prime: Bool = false, settles: (String, Double)? = nil, then: [Step] = [], closesItem: Bool = false, copy n: Int = 3) -> Scenario {
  let d = Desired(target: .copy(n), framed: framed, auxiliary: auxiliary, settles: settles)
  var steps: [Step] = [.setSwitches(n, switches)]
  if prime { steps.append(.prime(n)) }
  // (It read its switches: its launch line names them, as Switches.swift writes them.)
  let on = ChameleonSwitches.parse(switches).on.joined(separator: " ")
  steps += [.host(.copy(n)), .expect(.said(n, "options pid")), .expect(.said(n, " on \(on)"))]
  // (Primed: AppKit restored exactly the windows the switch made, nothing an earlier scenario left.)
  if prime, let r = ChameleonSwitches.parse(switches).restore { steps.append(.expect(.said(n, " restored \(r.count) "))) }
  steps += [.expect(.desired(d))]
  steps += then
  // (Its window closed for good: the item closed, and still so 10 s later; else the desired state held.)
  steps += closesItem ? [.expect(.itemClosed(n)), .wait(10, "nothing reopened meanwhile"), .expect(.itemClosed(n)), .forget(.copy(n))] : [.hold(.desired(d), seconds: hold), .forget(.copy(n))]
  return Scenario(name: name, title: title, copies: [n], steps: steps, estimate: 22 + (closesItem ? 14 : hold) + (prime ? 15 : 0) + then.reduce(0) { $0 + $1.estimate })
}
extension Step {
  var estimate: Double {
    switch self { case .wait(let s, _): return s; case .hold(_, let s): return s; case .host: return 10; case .show: return 4; default: return 2 }
  }
}
let parkAndBack: [Step] = [.show(.copy(1), maxMs: nil), .wait(15, "parked: its windows in no user Space"), .expect(.running(.copy(3), true)), .show(.copy(3), maxMs: 99)]
let behaviours: [Scenario] = [
  behaviour("restore-normal", "restores 2 normal windows (AppKit's state restoration, primed)", ["restore": "2:normal"], prime: true),
  behaviour("restore-fullscreen", "restores its window in full screen, in a Space the Dock made as it launched (Maps)", ["restore": "1:fullscreen"], prime: true),
  behaviour("restore-both", "restores 3 windows, one in full screen (Safari's 15:19)", ["restore": "3:both"], prime: true),
  behaviour("restore-code", "makes 2 windows and asks both into full screen as it launches", ["restore": "2:fullscreen:code"]),
  // (Its window closed as the person's ⌘W would close it: its item closes, its window never reopened (Tirth, 2026-11-17).)
  behaviour("windowless", "closes its own window 8 s after it's shown and runs on with none (Maps); its item closes", ["windowless": "close:8"], then: [.wait(10, "its window closed by itself")], closesItem: true),
  behaviour("autoTerminate-attempt", "parked, attempts termination after 5 s and runs on (UIKit's, Maps)", ["autoTerminate": "attempt:5"], then: parkAndBack),
  behaviour("autoTerminate-system", "AppKit's automatic termination on, parked (Margin launches it with -NSDisableAutomaticTermination YES)", ["autoTerminate": "system"], then: parkAndBack),
  behaviour("dialogMain", "its main window is an AXDialog (the Phone's)", ["dialogMain": "YES"]),
  behaviour("ordersOut-untilActive", "never orders its window in until it's activated (the Phone's)", ["ordersOut": "untilActive"]),
  behaviour("ordersOut-after", "orders its shown window out 3 s after it's first on screen", ["ordersOut": "after:3"]),
  // (Each new window adopted as a window in the page area, the design's way for a replacement (fast, no full-screen
  // change): AppKit keeps a window's top below the menu bar's band, so inside the page area, not at it.)
  behaviour("replacesWindow-every", "closes and remakes its main window at the same frame every 4 s (Messages)", ["replacesWindow": "every:4"], framed: true, settles: ("replaced ", 1.0)),
  behaviour("replacesWindow-twin", "keeps a twin window at its main window's frame (Messages)", ["replacesWindow": "twin"]),
  behaviour("axBusy", "Accessibility busy (-25200) for 2.5 s as its window first shows (Mail)", ["axBusy": "2.5"]),
  behaviour("strip", "a full-width toolbar strip of its own while in full screen, left after an exit (Mail)", ["strip": "linger"]),
  behaviour("auxiliary-settings", "a settings window beside its main one (Mail)", ["auxiliary": "settings"], auxiliary: true),
  behaviour("auxiliary-sidebar", "a window of its own over Margin's sidebar 3 s after launch (Mail)", ["auxiliary": "sidebar,at:3"], auxiliary: true),
  // (Inside the page area, as the real window-mode apps are: AppKit keeps a resizable window to the screen's visible
  // frame, the menu bar's and the Dock's bands out (1154×869 asked 1154×933, 2026-11-17 19:15), and Margin centres it.)
  behaviour("noFullScreen", "can't go full screen (Calculator, Phone)", ["noFullScreen": "YES"], framed: true),
  behaviour("fixedSize", "a fixed-size window that can't go full screen (Calculator)", ["fixedSize": "400x300", "noFullScreen": "YES"], framed: true),
  // (The extra window is the person's, asked of the app: kept beside the main one, never over the sidebar in front.)
  behaviour("extraWindow", "opens another window on demand, like Safari's profile wake", ["extraWindow": "menu"], auxiliary: true, then: [.trigger(3), .wait(3, "its extra window made")]),
  // (Started with no Dock icon its window can't go full screen; Margin gives it its Dock icon in place and shows it full
  // screen (the hosting core's docked.rs, 2026-11-28). Last, and on copy 2: Margin remembers what a Dock icon did per copy and version (noFullScreen teaches it "no" for copy 3), so it never decides another scenario's start.)
  behaviour("implicitFullScreen", "goes full screen only with its Dock icon (Music, Reminders, App Store): given it, shown full screen", ["implicitFullScreen": "YES"], copy: 2),
]
// The part every behaviour part starts with: Margin open, Chameleon 1 hosted plain (what a park shows instead).
let behaviourSetup = Scenario(name: "setup", title: "Margin open, Chameleon 1 hosted plain", copies: [1], steps: [.setSwitches(1, [:]), .openMargin, .host(.copy(1)), .expect(.desired(Desired(target: .copy(1))))], estimate: 45)

// ---- the person's own apps (opt-in) ----
func realAppsScenario(_ apps: [RealApp]) -> Scenario {
  var steps: [Step] = [.openMargin]
  for a in apps { steps += [.host(.app(a.bundle)), .hold(.desired(Desired(target: .app(a.bundle), framed: a.framedOnly)), seconds: hold)] }
  for a in apps { steps.append(.show(.app(a.bundle), maxMs: 99)) }
  // (Live resize: a drag of Margin's own sidebar with the last one shown, the others parked: only Margin's page is
  // touched, through its dev hook; nothing is posted to the system or to the apps.)
  if let last = apps.last { steps += [.liveDragApp(.app(last.bundle), dx: 80, steps: 60, parked: apps.dropLast().map { .app($0.bundle) }), .liveDragApp(.app(last.bundle), dx: -80, steps: 60, parked: apps.dropLast().map { .app($0.bundle) }), .listedOnly("the person's apps hosted")] }
  steps += [.quitMargin, .expect(.givenBack(apps.map(\.bundle)))]
  return Scenario(name: "real-apps", title: "the person's own apps hosted through Margin's dev hook only: no click or key ever posted into them", copies: [], steps: steps,
                  estimate: 40 + Double(apps.count) * (12 + hold) + Double(apps.count) * 4 + 30)
}

// ---- live resize (docs/HOSTING-CORE.md "Live resize: tiles in Margin's Space"): three copies hosted, drags followed
// live, the parked ones sized after, switches after, a hosted app killed, Margin's quit; then, from a launch of its own,
// Margin killed with tiles in its Space and opened again ----
let liveResize = Scenario(name: "live-resize", title: "a sidebar drag followed live, the parked ones sized after it, a switch after it, Mission Control, a hosted app killed, Margin's quit with tiles in its Space",
                          copies: [1, 2, 3], steps: [
  .setSwitches(1, [:]), .setSwitches(2, [:]), .setSwitches(3, [:]),
  .openMargin, .host(.copy(1)), .host(.copy(2)), .host(.copy(3)), .expect(.desired(Desired(target: .copy(3)))), .listedOnly("three hosted"), .memory("three hosted, at rest"),
  .switchSized(1), .switchSized(2), .switchSized(3), .switchSized(1), .switchSized(3),
  .liveDrag(3, dx: 120, steps: 120, parked: [1, 2]), .switchSized(1), .expect(.desired(Desired(target: .copy(1)))),
  .liveDrag(1, dx: -120, steps: 120, parked: [2, 3]), .switchSized(2), .expect(.desired(Desired(target: .copy(2)))),
  .liveDrag(2, dx: 60, steps: 30, parked: [1, 3]), .liveDrag(2, dx: -60, steps: 30, parked: [1, 3]), .memory("after the drags"),
  .switchSized(1), .switchSized(3), .switchSized(2),
  .killCopy(3, shown: 2), .listedOnly("after a hosted app was killed"), .expect(.desired(Desired(target: .copy(2)))),
  .marginQuitTiles([1, 2]),
], estimate: 200)
let liveResizeCrash = Scenario(name: "live-resize-crash", title: "Margin killed with tiles in its Space, opened again: everything given back by its recovery", copies: [1, 2], steps: [
  .setSwitches(1, [:]), .setSwitches(2, [:]),
  .openMargin, .host(.copy(1)), .host(.copy(2)), .liveDrag(2, dx: 60, steps: 60, parked: [1]), .killMargin([1, 2]), .listedOnly("after the recovery"),
], estimate: 110)

// ---- a window's own minimum size (MinSize.swift; docs/HOSTING-CORE.md "A window's minimum size"): Chameleon 3 can't
// be narrower than 1100 (its `minSize`), Chameleon 1 has no minimum. Arcadia's sidebar: 160-500 wide, 260 by default
// in steps of 10, set to 260 first (the page area 1244 wide on the 1512 display; 1004 at the sidebar's widest). A drag
// past the minimum stops at it (the sidebar 404, the page area 1100) and lets go at the step under it (400: 1104). Slow and fast drags past its minimum
// (the edge stops there), fast drags above it, Chameleon 3 parked while the page area goes narrower than it (sized at
// its minimum width, right edge aligned, never in a user Space), shown so (its overflow under Margin's sidebar) and
// dragged wider again ----
let minWide = CGSize(width: 1100, height: 500)
let liveResizeMin = Scenario(name: "live-resize-min", title: "drags of the sidebar's edge past a hosted window's own minimum: the edge stops there, the window never leaves Margin's Space, a parked one wider than the page area sized at its minimum",
                             copies: [1, 3], steps: [
  .setSwitches(1, [:]), .setSwitches(3, ["minSize": "1100x500"]),
  .openMargin, .host(.copy(1)), .sidebarWidth(260), .host(.copy(3)), .expect(.desired(Desired(target: .copy(3)))), .tileMin(.copy(3), expect: minWide),
  .minDrag(.copy(3), dx: 240, steps: 240, endsAt: nil, parked: [.copy(1)]),   // slow, past its minimum: stops at 1100, lets go at 1104 (the step)
  .minDrag(.copy(3), dx: -144, steps: 60, endsAt: nil, parked: [.copy(1)]),
  .minDrag(.copy(3), dx: 240, steps: 12, endsAt: nil, parked: [.copy(1)]),    // fast (0.1 s), past it
  .minDrag(.copy(3), dx: -60, steps: 6, endsAt: nil, parked: []), .minDrag(.copy(3), dx: 50, steps: 4, endsAt: nil, parked: []), .minDrag(.copy(3), dx: -50, steps: 4, endsAt: nil, parked: []), // fast, above it
  .minDrag(.copy(3), dx: 300, steps: 3, endsAt: nil, parked: []),             // a flick far past it
  .minDrag(.copy(3), dx: -144, steps: 30, endsAt: nil, parked: [.copy(1)]),
  .show(.copy(1), maxMs: nil),
  .minDrag(.copy(1), dx: 240, steps: 30, endsAt: nil, parked: [.copy(3)]),    // Chameleon 3 parked: the page area under its minimum
  .show(.copy(3), maxMs: 99), .overflow(.copy(3), seconds: 5),
  .minDrag(.copy(3), dx: -240, steps: 60, endsAt: nil, parked: [.copy(1)]),   // wider again from under its minimum
  .listedOnly("after the drags past a minimum"),
  .marginQuitTiles([1, 3]),
], estimate: 150)
// The person's Weather (opt-in, `--real-apps`): its own minimum (about 1048 wide, 2026-11-14) is the real case.
func realMinScenario(_ a: RealApp) -> Scenario {
  Scenario(name: "real-apps-min", title: "\(a.name), the person's own, dragged past its own minimum through Margin's dev hook only: no click or key ever posted into it", copies: [], steps: [
    .openMargin, .host(.app(a.bundle)), .sidebarWidth(260), .tileMin(.app(a.bundle), expect: nil),
    .minDrag(.app(a.bundle), dx: 240, steps: 240, endsAt: nil, parked: []), .minDrag(.app(a.bundle), dx: -240, steps: 60, endsAt: nil, parked: []),
    .minDrag(.app(a.bundle), dx: 240, steps: 12, endsAt: nil, parked: []), .minDrag(.app(a.bundle), dx: -240, steps: 12, endsAt: nil, parked: []),
    .minDrag(.app(a.bundle), dx: 300, steps: 3, endsAt: nil, parked: []), .minDrag(.app(a.bundle), dx: -300, steps: 30, endsAt: nil, parked: []),
    .listedOnly("\(a.name) dragged past its minimum"),
    .quitMargin, .expect(.givenBack([a.bundle])),
  ], estimate: 120)
}
let weather = RealApp(name: "Weather", bundle: "com.apple.weather", framedOnly: false)
// Weather's loop (2026-11-18 13:30): opened first, its tile the layout's second (the one a re-layout wipes), Maps beside
// it, a drag, switches; then left alone and watched. The person's own apps, through Margin's dev hook only.
func realLoopScenario(_ first: RealApp, _ second: RealApp) -> Scenario {
  let a = Target.app(first.bundle), b = Target.app(second.bundle)
  return Scenario(name: "real-apps-loop", title: "\(first.name) opened first (its tile the layout's second), \(second.name) beside it, a drag and switches, then left alone: no re-layout loop (the loop guard), no click or key ever posted into them", copies: [], steps: [
    .openMargin, .host(a), .sidebarWidth(260), .host(b), .show(a, maxMs: nil),
    .liveDragApp(a, dx: 80, steps: 30, parked: [b]), .settled(a, seconds: 15),
    .show(b, maxMs: nil), .show(a, maxMs: nil), .settled(a, seconds: 15),
    .liveDragApp(a, dx: -80, steps: 30, parked: [b]), .settled(a, seconds: 10),
    .listedOnly("after \(first.name)'s loop watch"),
    .quitMargin, .expect(.givenBack([first.bundle, second.bundle])),
  ], estimate: 160)
}
let maps = RealApp(name: "Maps", bundle: "com.apple.Maps", framedOnly: false)
// The soak (docs/ARCHITECTURE-PLAN.md "Testing"): the person's own apps hosted together, then switched through three
// times, each left alone a moment and watched for a loop, with sidebar drags between rounds; every check the read-only
// steps' own (Margin's dev hook only: nothing clicked or typed into the apps). Safari never: the suite doesn't launch it.
func realSoakScenario(_ apps: [RealApp]) -> Scenario {
  let list = apps.filter { $0.bundle != "com.apple.Safari" }
  var steps: [Step] = [.openMargin, .sidebarWidth(260)]
  for a in list { steps += [.host(.app(a.bundle)), .expect(.desired(Desired(target: .app(a.bundle), framed: a.framedOnly)))] }
  for round in 0..<3 {
    for a in list { steps += [.show(.app(a.bundle), maxMs: nil), .expect(.desired(Desired(target: .app(a.bundle), framed: a.framedOnly))), .settled(.app(a.bundle), seconds: 3)] }
    if let last = list.last, !last.framedOnly {
      let others = list.dropLast().filter { !$0.framedOnly }.map { Target.app($0.bundle) }
      steps.append(.liveDragApp(.app(last.bundle), dx: round % 2 == 0 ? 80 : -80, steps: 40, parked: others))
    }
  }
  steps += [.listedOnly("after the soak"), .memory("after the soak"), .quitMargin, .expect(.givenBack(list.map(\.bundle)))]
  return Scenario(name: "real-apps-soak", title: "the person's own apps hosted together, switched through three times, watched for loops, dragged between rounds: through Margin's dev hook only",
                  copies: [], steps: steps, estimate: 40 + Double(list.count) * 15 + 3 * Double(list.count) * 7 + 3 * 6 + 30)
}

// What Margin costs when nothing happens (the plan's budget: under 0.5% CPU idle, under ~150 MB): with nothing hosted,
// then three copies hosted and left alone.
let idleCost = Scenario(name: "idle-cost", title: "Margin left alone, with nothing hosted and with three hosted: its CPU, wakeups and memory", copies: [1, 2, 3], steps: [
  .setSwitches(1, [:]), .setSwitches(2, [:]), .setSwitches(3, [:]),
  .openMargin, .wait(8, "Margin settled after its launch"), .idleCost("nothing hosted", seconds: 30),
  .host(.copy(1)), .host(.copy(2)), .host(.copy(3)), .expect(.desired(Desired(target: .copy(3)))), .wait(5, "the show's extra polls over"),
  .idleCost("three hosted, one shown", seconds: 60),
  .marginQuitTiles([1, 2, 3]),
], estimate: 150)

// What Margin's page keeps redrawing for at rest (the idle cost's web-view part), with nothing hosted and one hosted.
let pageFrames = Scenario(name: "page-frames", title: "Margin's page at rest: its running animations and frame requests", copies: [1], steps: [
  .setSwitches(1, [:]), .openMargin, .wait(8, "settled"), .animations("nothing hosted"), .host(.copy(1)), .wait(5, "settled"), .animations("one hosted"), .marginQuitTiles([1]),
], estimate: 60)

// Margin held idle with three hosted for a profile taken from outside (`sample`), nothing checked.
let idleProfile = Scenario(name: "idle-profile", title: "Margin idle with three hosted, 90 s, for a profile", copies: [1, 2, 3], steps: [
  .setSwitches(1, [:]), .setSwitches(2, [:]), .setSwitches(3, [:]),
  .openMargin, .wait(20, "nothing hosted, for a profile"), .host(.copy(1)), .host(.copy(2)), .host(.copy(3)), .wait(70, "three hosted, for a profile"), .marginQuitTiles([1, 2, 3]),
], estimate: 150)

// The first click in another pane (PaneClicks.swift; Margin's PaneClickTap.swift): a split of Chameleon 1 and 2, first
// clicks of each kind in the pane without the keys, the times, Margin's idle cost with the tap on.
let paneClicks = Scenario(name: "pane-clicks", title: "a split of two copies: a first click in the pane without the keys reaches its content (grid, button, field, double-click, drag), timed; the pane with the keys untouched; idle cost with the tap on",
                          copies: [1, 2], steps: [
  .setSwitches(1, [:]), .setSwitches(2, [:]),
  .openMargin, .host(.copy(1)), .host(.copy(2)), .splitWith(2, adding: 1),
  .paneClick(2, .grid), .paneClick(1, .grid), .paneClick(2, .button), .paneClick(1, .field), .paneClick(2, .double), .paneClick(1, .drag),
  .paneClickTimes(1, 2, times: 8),
  .idleCost("a split up, the pane click tap on", seconds: 30),
  .marginQuitTiles([1, 2]),
], estimate: 150)

// A cut pane (CutPanes.swift; docs/PEEK-SPLIT.md §4b): Chameleon 1 (its minimum 800 wide) beside Chameleon 2 at the
// page area's end: past the display's edge and held; slid under Chameleon 2's pane by its arrow, a click into it
// delivered without a raise, slid back; Margin's idle cost with it up.
let cutPanes = Scenario(name: "cut-panes", title: "a split whose pane at the display's edge is narrower than its window: the window past the edge, held; the pointer resting on it opens it to fit its app, the other folded and blurred; the sidebar puts it back; resting on the folded card opens that one",
                        copies: [1, 2], steps: [
  .setSwitches(1, ["minSize": "800x300"]), .setSwitches(2, ["minSize": "700x300"]),
  .openMargin, .host(.copy(1)), .host(.copy(2)), .splitWith(2, adding: 1),
  .cutPaneEdge(1, other: 2, minWidth: 800, seconds: 6),
  .paneOpens(1, other: 2, minWidth: 800),
  .paneBack(1, other: 2),
  .paneOpens(1, other: 2, minWidth: 800),
  .foldedCardOpens(2, other: 1, minWidth: 700),
  .paneBack(2, other: 1),
  .idleCost("a split up, a cut pane past the display's edge", seconds: 20),
  .marginQuitTiles([1, 2]),
], estimate: 120)

// A sidebar row dropped on the page (SplitDrop.swift; docs/FLEX-SPLIT.md steps 2, 3): Chameleon 2's row on the right
// edge of Chameleon 1 shown alone (a new split), 3's on 2's pane (in its place), 2's on the gap between 1 and 3 (beside
// the nearer: between them), 4's near 2's bottom edge (2 and 4 stacked in 2's place: the split's tree).
let splitDrop = Scenario(name: "split-drop", title: "sidebar rows dropped on the page: beside the page shown (a new split), on a pane (in its place), between two panes, below a pane (a tree)",
                         copies: [1, 2, 3, 4], steps: [
  .setSwitches(1, [:]), .setSwitches(2, [:]), .setSwitches(3, [:]), .setSwitches(4, [:]),
  .openMargin, .host(.copy(4)), .host(.copy(3)), .host(.copy(2)), .host(.copy(1)),
  .rowDrop(2, .side(1), expect: [1, 2]),
  .rowDrop(3, .over(2), expect: [1, 3]),
  .rowDrop(2, .between(1, 3), expect: [1, 2, 3]),
  .rowDrop(4, .below(2), expect: [1, 3]),
  .marginQuitTiles([1, 2, 3, 4]),
], estimate: 150)

// Every pane of a split draws active (PanesActive.swift; Margin's PanesActive.swift): a split of Chameleon 1 and 2, both
// active, clicks back and forth, a key after a click, another app in front, the split hidden, Margin's quit; then, from a
// launch of its own, Margin killed with the split up and opened again.
let panesActiveScenario = Scenario(name: "panes-active", title: "a split of two copies: both draw active (each its own word), the keys the clicked one's; another app in front, the split hidden, Margin's quit and crash let the kept one go",
                                   copies: [1, 2, 3], steps: [
  .setSwitches(1, [:]), .setSwitches(2, [:]), .setSwitches(3, [:]),
  .openMargin, .host(.copy(3)), .host(.copy(1)), .host(.copy(2)), .splitWith(2, adding: 1),
  .panesActive(1, 2),
  .paneClick(1, .grid), .panesActive(1, 2),
  .paneClick(2, .field), .panesActive(1, 2),
  .panesActiveFlips(1, 2, times: 6),
  .idleCost("a split up, both panes active", seconds: 30),
  .panesActiveHidden(1, 2, alone: 3),
  .show(.copy(2), maxMs: nil), .panesActive(1, 2),
  .panesActiveQuit(1, 2),
], estimate: 150)
let panesActiveCrashScenario = Scenario(name: "panes-active-crash", title: "Margin killed with a split up: the kept copy left active; Margin opened again lets it go first",
                                        copies: [1, 2], steps: [
  .setSwitches(1, [:]), .setSwitches(2, [:]),
  .openMargin, .host(.copy(1)), .host(.copy(2)), .splitWith(2, adding: 1), .panesActive(1, 2),
  .panesActiveCrash(1, 2),
], estimate: 90)

// The parts: core; the behaviour scenarios in parts of about 6 minutes each (each from its own Margin launch);
// the real apps' (opt-in).
func parts(realApps withReal: Bool) -> [Part] {
  var out = [Part(name: "core", scenarios: [core], realApps: false)]
  // (As many parts as 6 minutes each need, in order: room under the 10-minute limit for slow log reads.)
  let room = 360 - behaviourSetup.estimate
  var chunk: [Scenario] = [], budget = 0.0
  for s in behaviours {
    if budget + s.estimate > room, !chunk.isEmpty { out.append(Part(name: "behaviours-\(out.count)", scenarios: [behaviourSetup] + chunk, realApps: false)); chunk = []; budget = 0 }
    chunk.append(s); budget += s.estimate
  }
  if !chunk.isEmpty { out.append(Part(name: "behaviours-\(out.count)", scenarios: [behaviourSetup] + chunk, realApps: false)) }
  out.append(Part(name: "live-resize", scenarios: [liveResize], realApps: false))
  out.append(Part(name: "live-resize-crash", scenarios: [liveResizeCrash], realApps: false))
  out.append(Part(name: "live-resize-min", scenarios: [liveResizeMin], realApps: false))
  out.append(Part(name: "idle-cost", scenarios: [idleCost], realApps: false))
  out.append(Part(name: "idle-profile", scenarios: [idleProfile], realApps: false))
  out.append(Part(name: "page-frames", scenarios: [pageFrames], realApps: false))
  out.append(Part(name: "pane-clicks", scenarios: [paneClicks], realApps: false))
  out.append(Part(name: "panes-active", scenarios: [panesActiveScenario], realApps: false))
  out.append(Part(name: "panes-active-crash", scenarios: [panesActiveCrashScenario], realApps: false))
  out.append(Part(name: "cut-panes", scenarios: [cutPanes], realApps: false))
  out.append(Part(name: "split-drop", scenarios: [splitDrop], realApps: false))
  if withReal { out.append(Part(name: "real-apps", scenarios: [realAppsScenario(installedRealApps())], realApps: true)) }
  if withReal, isInstalled(weather.bundle) { out.append(Part(name: "real-apps-min", scenarios: [realMinScenario(weather)], realApps: true, apps: [weather])) }
  if withReal, isInstalled(weather.bundle), isInstalled(maps.bundle) { out.append(Part(name: "real-apps-loop", scenarios: [realLoopScenario(weather, maps)], realApps: true, apps: [weather, maps])) }
  if withReal {
    let soak = installedRealApps().filter { $0.bundle != "com.apple.Safari" } + (isInstalled(weather.bundle) ? [weather] : [])
    out.append(Part(name: "real-apps-soak", scenarios: [realSoakScenario(soak)], realApps: true, apps: soak))
  }
  return out
}
