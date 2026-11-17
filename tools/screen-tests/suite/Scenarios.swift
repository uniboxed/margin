// The scenarios, as data: a name, the Chameleon copies and switches it needs, its steps (each with its assertions).
// The runner (Runner.swift) does each step; `--dry-run` prints them. A part is the scenarios one process runs under one
// 10-minute limit, from one Margin launch, with its own record and restore.
import Foundation

enum Target: Equatable {
  case copy(Int), app(String)
  var id: String { switch self { case .copy(let n): return copies[n - 1].id; case .app(let b): return b } }
  var text: String { switch self { case .copy(let n): return "Chameleon \(n)"; case .app(let b): return realApps.first { $0.bundle == b }?.name ?? b } }
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
  var text: String {
    "\(target.text): one main window \(framed ? "inside" : "at") the page area, on screen, in Margin's Space only, under Margin's panel; no leftover in any user Space; no strip; the sidebar never covered\(auxiliary ? "; its auxiliary window allowed if not over the sidebar" : "")"
  }
}
enum Expect: Equatable {
  case desired(Desired)
  case running(Target, Bool)          // still running, still Margin's (no termination seen by NSWorkspace)
  case said(Int, String)              // the copy's own log says it (its switch reached it)
  case givenBack([String])            // after Margin's quit: those that weren't running quit, the others with a normal window
  var text: String {
    switch self {
    case .desired(let d): return d.text
    case .running(let t, let on): return "\(t.text) \(on ? "still running (NSWorkspace too)" : "not running")"
    case .said(let n, let w): return "Chameleon \(n)'s log says \"\(w)\""
    case .givenBack(let ids): return "given back after Margin quit (\(ids.count) app(s)): those that weren't running before quit, those that were still running with a normal window and a Dock icon"
    }
  }
}
enum Step: Equatable {
  // check10's steps, ported (each with check10's assertions and names)
  case openMargin                                 // L, 0
  case firstHost(Int)                             // d1 d2 a1 m1
  case activateAbove(Int)                         // a2
  case clicks(Int)                                // b1 a3 b2 k1
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

  var text: String {
    switch self {
    case .openMargin: return "open the built Margin (MarginDevHooks YES, MarginPrepareBrowser NO, MarginResumeLast NO), bring it to the front: L Margin in full screen; 0 the page card empty and painted"
    case .firstHost(let n): return "host Chameleon \(n) (dev hook `app`): d1 the card opaque while loading, see-through once shown; d2 the hole is its window; a1 Margin's panel above it; m1 on screen in Margin's Space only a second later"
    case .activateAbove(let n): return "activate Chameleon \(n): a2 Margin's panel still above it"
    case .clicks(let n): return "click in Chameleon \(n)'s content, on Margin's frame, on an empty spot of the sidebar (only where the window list says it's theirs): b1 b2 a3 k1"
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
struct Part { let name: String; let scenarios: [Scenario]; let realApps: Bool }

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
func behaviour(_ name: String, _ title: String, _ switches: [String: String], framed: Bool = false, auxiliary: Bool = false, prime: Bool = false, then: [Step] = []) -> Scenario {
  let d = Desired(target: .copy(3), framed: framed, auxiliary: auxiliary)
  var steps: [Step] = [.setSwitches(3, switches)]
  if prime { steps.append(.prime(3)) }
  // (It read its switches: its launch line names them, as Switches.swift writes them.)
  let on = ChameleonSwitches.parse(switches).on.joined(separator: " ")
  steps += [.host(.copy(3)), .expect(.said(3, "options pid")), .expect(.said(3, " on \(on)")), .expect(.desired(d))]
  steps += then
  steps += [.hold(.desired(d), seconds: hold), .forget(.copy(3))]
  return Scenario(name: name, title: title, copies: [3], steps: steps, estimate: 22 + hold + (prime ? 15 : 0) + then.reduce(0) { $0 + $1.estimate })
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
  behaviour("windowless", "closes its own window 8 s after it's shown and runs on with none (Maps)", ["windowless": "close:8"], then: [.wait(10, "its window closed by itself")]),
  behaviour("autoTerminate-attempt", "parked, attempts termination after 5 s and runs on (UIKit's, Maps)", ["autoTerminate": "attempt:5"], then: parkAndBack),
  behaviour("autoTerminate-system", "AppKit's automatic termination on, parked (Margin launches it with -NSDisableAutomaticTermination YES)", ["autoTerminate": "system"], then: parkAndBack),
  behaviour("dialogMain", "its main window is an AXDialog (the Phone's)", ["dialogMain": "YES"]),
  behaviour("ordersOut-untilActive", "never orders its window in until it's activated (the Phone's)", ["ordersOut": "untilActive"]),
  behaviour("ordersOut-after", "orders its shown window out 3 s after it's first on screen", ["ordersOut": "after:3"]),
  behaviour("replacesWindow-every", "closes and remakes its main window at the same frame every 4 s (Messages)", ["replacesWindow": "every:4"]),
  behaviour("replacesWindow-twin", "keeps a twin window at its main window's frame (Messages)", ["replacesWindow": "twin"]),
  behaviour("axBusy", "Accessibility busy (-25200) for 2.5 s as its window first shows (Mail)", ["axBusy": "2.5"]),
  behaviour("strip", "a full-width toolbar strip of its own while in full screen, left after an exit (Mail)", ["strip": "linger"]),
  behaviour("auxiliary-settings", "a settings window beside its main one (Mail)", ["auxiliary": "settings"], auxiliary: true),
  behaviour("auxiliary-sidebar", "a window of its own over Margin's sidebar 3 s after launch (Mail)", ["auxiliary": "sidebar,at:3"], auxiliary: true),
  behaviour("noFullScreen", "can't go full screen (Calculator, Phone)", ["noFullScreen": "YES"]),
  behaviour("fixedSize", "a fixed-size window that can't go full screen (Calculator)", ["fixedSize": "400x300", "noFullScreen": "YES"], framed: true),
  behaviour("extraWindow", "opens another window on demand, like Safari's profile wake", ["extraWindow": "menu"], then: [.trigger(3), .wait(3, "its extra window made")]),
]
// The part every behaviour part starts with: Margin open, Chameleon 1 hosted plain (what a park shows instead).
let behaviourSetup = Scenario(name: "setup", title: "Margin open, Chameleon 1 hosted plain", copies: [1], steps: [.setSwitches(1, [:]), .openMargin, .host(.copy(1)), .expect(.desired(Desired(target: .copy(1))))], estimate: 45)

// ---- the person's own apps (opt-in) ----
func realAppsScenario(_ apps: [RealApp]) -> Scenario {
  var steps: [Step] = [.openMargin]
  for a in apps { steps += [.host(.app(a.bundle)), .hold(.desired(Desired(target: .app(a.bundle), framed: a.framedOnly)), seconds: hold)] }
  for a in apps { steps.append(.show(.app(a.bundle), maxMs: 99)) }
  steps += [.quitMargin, .expect(.givenBack(apps.map(\.bundle)))]
  return Scenario(name: "real-apps", title: "the person's own apps hosted through Margin's dev hook only: no click or key ever posted into them", copies: [], steps: steps,
                  estimate: 40 + Double(apps.count) * (12 + hold) + Double(apps.count) * 4 + 30)
}

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
  if withReal { out.append(Part(name: "real-apps", scenarios: [realAppsScenario(installedRealApps())], realApps: true)) }
  return out
}
