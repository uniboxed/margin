// Checks of Margin.app's shell logic (app/platforms/macos/shell/), with no browser, no window
// on screen and no link: the link's messages as margin-core reads and writes them, mapped for the app
// (LinkMessage.swift; the rules themselves, the WebSocket, the chunks and the session are the core's tests:
// app/shared/core/src/protocol.rs, websocket.rs, chunks.rs, link.rs, socket.rs, link_hub.rs; a copy's state is the
// core's too: mirror.rs, link_hub.rs), what the core says a state message did (LinkMessage.State), pass-through decisions
// (PassThrough.swift), layout reports (PageLayout), shortcuts and their gating
// (Shortcuts.swift, against a stand-in for Carbon), the coordinate flips, and
// the lasting data (data-tests.swift: the data messages, through margin-core's
// data sync); then each part's own suite (the host, Margin's window, the library, ...).
// tools/app-tests/run.sh
// builds and runs them (and the end-to-end check, e2e.swift).
import AppKit
import Carbon
import Foundation
import WebKit

var failures = 0
var passed = 0
func check(_ label: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
  if ok { passed += 1 } else { failures += 1; print("FAIL \(label)" + (detail().isEmpty ? "" : ": \(detail())")) }
}
func object(_ text: String?) -> JSONObject? {
  text.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONSerialization.jsonObject(with: $0) as? JSONObject }
}
func object(_ data: Data?) -> JSONObject? { data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? JSONObject } }
func same(_ a: Any?, _ b: Any?) -> Bool {
  guard let a, let b else { return a == nil && b == nil }
  return NSDictionary(dictionary: ["v": a]).isEqual(to: ["v": b])
}
let hello = LinkMessage.Hello(epoch: "e1", profile: "P1", browser: "safari", ext: "2.0", owner: true, instanceId: "i", origin: "o", since: 5, pid: nil)

final class FakeRegistrar: HotKeyRegistrar {
  var onHit: ((UInt32) -> Void)?
  var onRelease: ((UInt32) -> Void)?
  var held: [UInt32: Combo] = [:]
  var taken: Set<Combo> = [] // another app's
  var registrations = 0
  func register(_ combo: Combo, id: UInt32) -> Bool {
    registrations += 1
    guard !taken.contains(combo) else { return false }
    held[id] = combo
    return true
  }
  func unregister(id: UInt32) { held[id] = nil }
}

@main enum Tests {
  static func main() {
    let started = Date()
    linkMessages()
    appMessages()
    stateMessages()
    linkUp()
    layouts()
    frameRate()
    systemAppearance()
    passThrough()
    shortcuts()
    geometry()
    pointerWant()
    dataSync()
    dataCarry() // data-tests.swift (the merge's vectors and the files: margin-core's tests)
    libraryTests() // library-tests.swift: the app's own spaces, its rules in JavaScriptCore
    profilesTests()
    safariProfilesTests() // safari-profiles-tests.swift
    oneMargin()
    idleQuit()
    privateCallsTests() // private-calls-tests.swift
    hostTests() // host-tests.swift: the host engine against a stand-in window manager, and its calls' check
    hostModelTests() // host-model-tests.swift: the hosting core's window kinds, its observed model and its observer
    hostedTests() // hosted-tests.swift: the library, the host engine and the Safari copies joined 
    marginWindowTests() // margin-window-tests.swift: Margin's own window 
    devHooksTests() // devhooks-tests.swift (DEV-HOOK: removed with the hook)
    themeTests() // theme-tests.swift
    appsTests() // apps-tests.swift: installed apps for the palette, fake bundles in a temporary folder
    relayTests() // relay-tests.swift: Chrome's and Edge's relay, the real helper
    behaviourWorldTests() // behaviour-world.swift: Chameleon's switches and their stand-ins (tools/screen-tests)
    hostReconcilerTests() // host-reconciler-tests.swift: the hosting core's reconciler, a table row per case
    hostBehaviourTests() // host-behaviour-tests.swift: every behaviour class hosted by the engine, the desired state reached
    liveResizeTests() // live-resize-tests.swift: the hosted windows' tiles in Margin's Space, sized live (docs/HOSTING-CORE.md)
    multiHostTests() // multi-host-tests.swift: several visible hosts per Margin window, each at its rect (docs/PEEK-SPLIT.md §1)
    multiHostSessionTests() // multi-host-session-tests.swift: a Margin window's layout of library items, each web item's window in its role
    peekSessionTests() // peek-session-tests.swift: the preview card and Quick Tab, the session's side (docs/PEEK-SPLIT.md §2, §3)
    peekSplitTests() // peek-split-tests.swift: the preview card over a split, both kept (docs/PEEK-SPLIT.md §2, §4)
    splitTests() // split-tests.swift: a split shown whole by the session, its panes at the page's rects, ⌘W, a drag, idle pane windows (docs/PEEK-SPLIT.md §4)
    screenCardTests() // screen-card-tests.swift: the real screen's finds of 2026-11-21 with the preview card over a split (the window server's order)
    splitRealUseTests() // split-real-use-tests.swift: split view as Tirth used it on the real screen, 2026-11-21 (a pane born in full screen, its room, its failure, its raise, a drag of two)
    paneFrontingTests() // pane-fronting-tests.swift: a split pane's first open as the real screen had it, 2026-11-21 14:30 (fronted once, revealed once its toolbar rests)
    screenEngineTests() // screen-engine-tests.swift: the real screen's finds of 2026-11-21 (a layout held through a lone placing, a window out of full screen by itself, Remove from Split View)
    loopGuardTests() // loop-guard-tests.swift: the hosting core's loop guard against Weather's loop (docs/ARCHITECTURE-PLAN.md)
    paneClickTests() // pane-click-tests.swift: the first click in another pane goes through (the tap's decision, its hold, the engine's bookkeeping)
    panesActiveTests() // panes-active-tests.swift: every pane of a split draws active (the records, their launch check, the keeper, the engine's exits)
    print(failures == 0 ? "all \(passed) checks passed" : "\(failures) of \(passed + failures) checks failed", String(format: "(%.2f s)", Date().timeIntervalSince(started)))
    exit(failures == 0 ? 0 : 1)
  }

  static func linkMessages() {
    if case .hello(let h)? = LinkMessage.decode(#"{"k":"hello","v":2,"epoch":"e1","profile":"P-1","browser":"safari","origin":"safari-web-extension://A","since":1761800000000,"ext":"2.0","owner":true,"instanceId":"i"}"#) {
      check("hello", h.epoch == "e1" && h.profile == "P-1" && h.browser == "safari" && h.key == "safari:P-1" && h.origin == "safari-web-extension://A" && h.since == 1761800000000 && h.ext == "2.0" && h.owner && h.instanceId == "i" && h.pid == nil)
    } else { check("hello decodes", false) }
    if case .hello(let h)? = LinkMessage.decode(#"{"k":"hello","v":2,"epoch":"e1","profile":"p","browser":"chrome","pid":4321}"#) { check("hello: not the owner unless it says so; a pid", !h.owner && h.pid == 4321) } else { check("bare hello decodes", false) }
    check("hello of version 1 (the native panel's): not one", LinkMessage.decode(#"{"k":"hello","v":1,"epoch":"e1","owner":true,"profile":"p","browser":"safari"}"#) == nil)
    check("hello with no profile: not one", LinkMessage.decode(#"{"k":"hello","v":2,"epoch":"e1","browser":"safari"}"#) == nil)
    check("hello with a profile that isn't a plain id: not one", LinkMessage.decode(#"{"k":"hello","v":2,"epoch":"e1","browser":"safari","profile":"a/b"}"#) == nil)
    check("hello from a browser not known: not one", LinkMessage.decode(#"{"k":"hello","v":2,"epoch":"e1","browser":"lynx","profile":"p"}"#) == nil)
    check("not JSON", LinkMessage.decode("{k:") == nil)
    check("no kind", LinkMessage.decode(#"{"epoch":"e"}"#) == nil)
    check("a snapshot needs its epoch", LinkMessage.decode(#"{"k":"snapshot","seq":1,"state":{}}"#) == nil)
    check("a seq that isn't a whole number: not one", LinkMessage.decode(#"{"k":"windows","epoch":"e","seq":1.5,"list":[]}"#) == nil)
    // (A snapshot, a delta and a window list are applied by the core as it reads them: stateMessages; the reads here.)
    let snapshot = LinkMessage.read(#"{"k":"snapshot","epoch":"e","seq":1,"state":{"spaces":[{"id":"a"}]},"windows":[{"windowId":3,"focused":true}]}"#)
    check("snapshot", snapshot?["epoch"] as? String == "e" && int(snapshot?["seq"]) == 1 && same((snapshot?["state"] as? JSONObject)?["spaces"], [["id": "a"]])
          && ((snapshot?["windows"] as? [JSONObject])?.first?["windowId"] as? Int) == 3)
    let delta = LinkMessage.read(#"{"k":"delta","epoch":"e","seq":2,"changes":{"pins":{"newValue":[]},"folders":{}},"favicons":{"set":{"https://a.example":{"icon":"data:x"}},"del":["https://b.example"]}}"#)
    let changes = delta?["changes"] as? JSONObject
    check("delta: a key's new value, a key removed (no newValue)", int(delta?["seq"]) == 2 && same((changes?["pins"] as? JSONObject)?["newValue"], [Any]())
          && (changes?["folders"] as? JSONObject)?["newValue"] == nil)
    let favicons = delta?["favicons"] as? JSONObject
    check("delta: site icons as a diff", favicons?["del"] as? [String] == ["https://b.example"] && same((favicons?["set"] as? JSONObject)?["https://a.example"], ["icon": "data:x"]))
    let windows = LinkMessage.read(#"{"k":"windows","epoch":"e","seq":3,"list":[{"windowId":1},{"windowId":2}]}"#)
    check("windows", int(windows?["seq"]) == 3 && (windows?["list"] as? [Any])?.count == 2)
    if case .push(_, let windowId, let msg)? = LinkMessage.decode(#"{"k":"push","epoch":"e","windowId":4,"msg":{"type":"switching","tabId":5}}"#) {
      check("push for a window", windowId == 4 && msg["type"] as? String == "switching")
    } else { check("push decodes", false) }
    // (A theme's pieces are put together by the core, per link, and come whole: link_hub.rs, chunks.rs.)
    check("a chunk past its parts: not one", LinkMessage.decode(#"{"k":"theme","epoch":"e","id":"a","transfer":"\#(String(repeating: "a", count: 64))","part":3,"parts":3,"size":1,"data":""}"#) == nil)
    if case .hello(let h)? = LinkMessage.decode(#"{"k":"hello","v":2,"epoch":"e1","profile":"p","browser":"safari","owner":1}"#) { check("hello: owner 1 is true, as Swift read it", h.owner) } else { check("hello with owner 1 decodes", false) }
    if case .push(_, let windowId, let msg)? = LinkMessage.decode(#"{"k":"push","epoch":"e","msg":{"type":"parkedActivity","why":"hover"}}"#) {
      check("a malformed parkedActivity: a plain push, as it came", windowId == nil && msg["why"] as? String == "hover")
    } else { check("a malformed parkedActivity decodes", false) }
    if case .reply(let id, let body)? = LinkMessage.decode(#"{"k":"reply","id":7,"ok":false,"error":"x","stale":true}"#) {
      check("reply: its id, the answer without k and id", id == 7 && body["ok"] as? Bool == false && body["stale"] as? Bool == true && body["k"] == nil && body["id"] == nil)
    } else { check("reply decodes", false) }
    if case .tock? = LinkMessage.decode(#"{"k":"tock","at":1}"#) { check("tock", true) } else { check("tock decodes", false) }
    if case .bye(let why)? = LinkMessage.decode(#"{"k":"bye","why":"turned off"}"#) { check("bye", why == "turned off") } else { check("bye decodes", false) }
    if case .other(let k)? = LinkMessage.decode(#"{"k":"later"}"#) { check("a kind not known: other", k == "later") } else { check("unknown kind decodes", false) }
    if case .keys(let epoch, let bindings)? = LinkMessage.decode(#"{"k":"keys","epoch":"e","bindings":{"next-tab":["Alt+Meta+ArrowDown","Ctrl+Meta+ArrowDown",3],"palette":["Meta+KeyT"],"odd":"x"}}"#) {
      check("keys: each command's combinations (strings only)", epoch == "e" && bindings["next-tab"] == ["Alt+Meta+ArrowDown", "Ctrl+Meta+ArrowDown"] && bindings["palette"] == ["Meta+KeyT"] && bindings["odd"] == nil)
    } else { check("keys decodes", false) }
    check("keys need their epoch", LinkMessage.decode(#"{"k":"keys","bindings":{}}"#) == nil)
  }

  static func appMessages() {
    // (The link's own, welcome, tick, req and bye, and the theme's pieces: the core's tests.)
    let drawn = object(AppMessage.drawn(epoch: "e", windowId: 7, on: false).encode())
    check("drawn: the window and whether it's drawn", drawn?["k"] as? String == "drawn" && drawn?["epoch"] as? String == "e" && drawn?["windowId"] as? Int == 7 && drawn?["on"] as? Bool == false
          && (drawn?["at"] as? Double ?? 0) > 1.7e12)
    check("resync", object(AppMessage.resync(epoch: "e").encode())?["epoch"] as? String == "e")
    check("a payload that isn't JSON: nothing", AppMessage.data(kind: "data.changes", body: ["d": Date()]).encode() == nil)
    let big = String(repeating: "x", count: LinkProtocol.maxAppMessage)
    check("nothing over 1 MB goes from the app", AppMessage.data(kind: "data.changes", body: ["big": big]).encode() == nil)
    let almost = String(repeating: "x", count: LinkProtocol.maxAppMessage - 200)
    check("just under 1 MB goes", AppMessage.data(kind: "data.changes", body: ["big": almost]).encode() != nil)
    let state = HandoffRequest.setWindowState(windowId: 90, state: .fullscreen, focused: true, notAfter: 1_800_000_002_000.4)
    check("setWindowState: the copy's window, full screen, focused, its notAfter, answered once asked (land: false)", state.type == "setWindowState"
          && same(state.payload, ["windowId": 90, "state": "fullscreen", "focused": true, "notAfter": 1_800_000_002_000, "land": false]), "\(state.payload)")
    check("setWindowState out: never focused", same(HandoffRequest.setWindowState(windowId: 90, state: .normal, notAfter: 5).payload, ["windowId": 90, "state": "normal", "notAfter": 5, "land": false]))
    check("a windows call's answers", WindowCallAnswer(["windowId": 90, "state": "fullscreen", "asked": true]) == .asked(windowId: 90, state: "fullscreen")
          && WindowCallAnswer(["busy": true]) == .busy && !WindowCallAnswer(["busy": true]).called && WindowCallAnswer(["refused": "late", "pastMs": 3]) == .refused(why: "late", pastMs: 3)
          && WindowCallAnswer([:]) == .done(state: nil) && WindowCallAnswer(["windowId": 4, "state": "normal", "landedAt": 9]) == .landed(windowId: 4, state: "normal", at: 9))
    check("newWindow's answer: the window and its bounds", SpaceWindowAnswer(["windowId": 5, "bounds": ["left": 1, "top": 2, "width": 3, "height": 4]]) == SpaceWindowAnswer(["windowId": 5, "bounds": ["left": 1, "top": 2, "width": 3, "height": 4]])
          && SpaceWindowAnswer(["windowId": 5, "bounds": ["left": 1, "top": 2, "width": 3, "height": 4]])?.bounds == CGRect(x: 1, y: 2, width: 3, height: 4)
          && SpaceWindowAnswer(["windowId": 5])?.bounds == nil && SpaceWindowAnswer(["state": "normal"]) == nil)
  }

  // What the core says a state message did (link_hub.rs StateApplied, as ffi/link.rs writes it), read for the app; the
  // mirror's rules themselves (epochs, numbers, gaps, icons, values) are the core's tests: mirror.rs, link_hub.rs.
  static func stateMessages() {
    let applied = LinkMessage.State(core: ["do": "state", "kind": "delta", "epoch": "e1", "seq": 2, "outcome": "applied", "keys": ["openTabs", "spaces"], "hasState": true, "resyncing": false])
    check("state: a delta applied, its keys", applied?.kind == .delta && applied?.outcome == .applied && applied?.seq == 2 && applied?.keys == ["openTabs", "spaces"]
          && applied?.windows == nil && applied?.hasState == true && applied?.resyncing == false)
    let gap = LinkMessage.State(core: ["kind": "windows", "epoch": "e1", "seq": 5, "outcome": "gap", "expected": 4, "got": 5, "keys": [], "hasState": true, "resyncing": true])
    check("state: a gap, what was next and what came", gap?.outcome == .gap(expected: 4, got: 5) && gap?.resyncing == true)
    check("state: not a kind known: none", LinkMessage.State(core: ["kind": "later", "outcome": "applied"]) == nil)
    let m = StateMirror { key in key == "spaces" ? Data(#"[{"id":"a"}]"#.utf8) : key == "n" ? Data("3".utf8) : nil }
    check("mirror: nothing before the core says so", !m.hasState && !m.isResyncing && m.windows.isEmpty)
    m.applied(LinkMessage.State(core: ["kind": "snapshot", "epoch": "e1", "seq": 1, "outcome": "applied", "keys": ["spaces"], "windows": [["windowId": 1]], "hasState": true, "resyncing": false])!)
    check("mirror: a snapshot: its state and windows", m.hasState && !m.isResyncing && m.windows.count == 1)
    m.applied(gap!)
    check("mirror: a gap: resyncing, the windows as they were", m.isResyncing && m.windows.count == 1)
    check("mirror: values read from the core's text (a fragment too)", same(m.value("spaces"), [["id": "a"]]) && int(m.value("n")) == 3 && m.value("none") == nil)
  }

  static func linkUp() {
    // A copy's hello naming a browser process no connector named: trusted, logged once at link up.
    let chrome = { (pid: Int?) in LinkMessage.Hello(epoch: "c1", profile: "p-b", browser: "chrome", ext: nil, owner: true, instanceId: nil, origin: nil, since: nil, pid: pid) }
    check("link up: a process no connector named is logged, in margin-core's words",
          Shell.unheardPid("chrome:p-b", chrome(777), heard: { $0 == 42 }) == "chrome:p-b: its hello says browser process 777, which no connector has named: trusted, as on the Mac")
    check("link up: a process a connector named, none said, or Safari's: nothing", Shell.unheardPid("chrome:p-b", chrome(42), heard: { $0 == 42 }) == nil
          && Shell.unheardPid("chrome:p-b", chrome(nil), heard: { _ in false }) == nil && Shell.unheardPid("safari:P1", hello, heard: { _ in false }) == nil)
  }

  static func layouts() {
    let g: JSONObject = ["insets": ["left": 260.3, "top": 8, "right": 8, "bottom": 8.26], "radius": 6.25, "radii": [6.25, 6.25, 6.25, 6.25], "container": ["width": 1280, "height": 800], "mode": "fullscreen", "outer": [:]]
    guard let l = PageLayout(geometry: g) else { return check("a layout report", false) }
    check("a layout report", l.left == 260.3 && l.bottom == 8.26 && l.width == 1280 && l.radius == 6.25 && l.mode == "fullscreen")
    var hostedGeometry = g
    hostedGeometry["pageHosted"] = true
    check("a layout report: measured hosting (pageHosted), or not (the launcher's)", !l.hosted && PageLayout(geometry: hostedGeometry)?.hosted == true)
    check("not a report: no insets", PageLayout(geometry: ["container": ["width": 1, "height": 1]]) == nil)
    check("not a report: no size", PageLayout(geometry: ["insets": ["left": 0, "top": 0, "right": 0, "bottom": 0], "container": ["width": 0, "height": 10]]) == nil)
    check("not a report: a number that's a boolean", PageLayout(geometry: ["insets": ["left": true, "top": 0, "right": 0, "bottom": 0], "container": ["width": 10, "height": 10]]) == nil)
  }

  static func passThrough() {
    let frame = CGRect(x: 100, y: 50, width: 1280, height: 800)
    let layout = PageLayout(left: 260, top: 8, right: 8, bottom: 8, radius: 10, radii: [10, 10, 10, 10], width: 1280, height: 800, mode: "fullscreen")
    let slot = PassThrough.slot(in: frame, layout: layout)
    check("the slot from the insets, in screen points", slot.rect == CGRect(x: 360, y: 58, width: 1012, height: 784), "\(slot.rect)")
    check("over the page: the page's", PassThrough.pageGets(CGPoint(x: 800, y: 400), slot))
    check("over the sidebar: Margin's", !PassThrough.pageGets(CGPoint(x: 200, y: 400), slot))
    check("on the frame above the page: Margin's", !PassThrough.pageGets(CGPoint(x: 800, y: 54), slot))
    check("just inside the slot's corner: Margin's (rounded)", !PassThrough.pageGets(CGPoint(x: 361, y: 59), slot))
    check("inside the rounding: the page's", PassThrough.pageGets(CGPoint(x: 364, y: 62), slot))
    check("along an edge, past the corner: the page's", PassThrough.pageGets(CGPoint(x: 361, y: 400), slot))
    check("no slot reported: Margin's everywhere", !PassThrough.pageGets(CGPoint(x: 800, y: 400), nil))
    let palette = PassThrough.slot(in: frame, layout: layout, hits: [CGRect(x: 400, y: 100, width: 480, height: 300)])
    check("over the palette (drawn over the page): Margin's", !PassThrough.pageGets(CGPoint(x: 600, y: 200), palette))
    check("beside the palette: the page's", PassThrough.pageGets(CGPoint(x: 1200, y: 600), palette))
    var all = slot
    all.captureAll = true
    check("too much over the page to list: Margin's everywhere", !PassThrough.pageGets(CGPoint(x: 800, y: 400), all))
    check("a button held keeps what it was: a drag from the page stays the page's", PassThrough.decide(CGPoint(x: 200, y: 400), slot, buttonsDown: true, ignoring: true))
    check("a drag from Margin stays Margin's", !PassThrough.decide(CGPoint(x: 800, y: 400), slot, buttonsDown: true, ignoring: false))
    check("let go: decided again", PassThrough.decide(CGPoint(x: 800, y: 400), slot, buttonsDown: false, ignoring: false))
    // What the overlay's fill and its catcher take whatever the pointer-following says (CatchRegion): exactly what isn't the page's.
    let region = CatchRegion.of(frame: frame, slot: slot)
    let local = { (p: CGPoint) in CGPoint(x: p.x - frame.minX, y: p.y - frame.minY) }
    let probes = [CGPoint(x: 800, y: 400), CGPoint(x: 200, y: 400), CGPoint(x: 800, y: 54), CGPoint(x: 361, y: 59), CGPoint(x: 364, y: 62), CGPoint(x: 361, y: 400), CGPoint(x: 1300, y: 845)]
    check("caught: the sidebar and the frame, never the page (the same as the pointer-following's answer)", !region.all
          && probes.allSatisfy { region.contains(local($0), in: frame.size) == !PassThrough.pageGets($0, slot) }
          && region.contains(local(CGPoint(x: 200, y: 400)), in: frame.size) && !region.contains(local(CGPoint(x: 800, y: 400)), in: frame.size), "\(region)")
    let paletteRegion = CatchRegion.of(frame: frame, slot: palette)
    check("caught: the palette drawn over the page too", paletteRegion.contains(local(CGPoint(x: 600, y: 200)), in: frame.size) && !paletteRegion.contains(local(CGPoint(x: 1200, y: 600)), in: frame.size))
    check("caught: everything before the page says where the slot is, or when it asks for the whole window", CatchRegion.of(frame: frame, slot: nil).all && CatchRegion.of(frame: frame, slot: all).all)
    check("caught: nothing outside the overlay", !region.contains(CGPoint(x: -1, y: 10), in: frame.size))
    // Drawn: each point once at alpha 0.01, where boxes overlap (a box over the page within another, partly over the
    // frame) as where one is (2026-11-20: laid over each other, a space swipe's boxes made a grey band over the page).
    let view = CatchView(frame: CGRect(x: 0, y: 0, width: 200, height: 100))
    view.region = CatchRegion(all: false, hole: CGRect(x: 50, y: 0, width: 150, height: 100), radius: 0,
                              hits: [CGRect(x: 40, y: 10, width: 60, height: 60), CGRect(x: 45, y: 20, width: 40, height: 20), CGRect(x: 60, y: 30, width: 80, height: 30)])
    let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
    view.cacheDisplay(in: view.bounds, to: rep)
    let alpha = { (x: Int, y: Int) in Int((rep.colorAt(x: x * rep.pixelsWide / 200, y: y * rep.pixelsHigh / 100)?.alphaComponent ?? -1) * 255 + 0.5) }
    let once = alpha(20, 50)
    check("caught, drawn: the frame at alpha 0.01 (\(once)/255)", once >= 2 && once <= 3)
    check("caught, drawn: one box over the page, two, three, and over the frame: the same alpha", [alpha(90, 15), alpha(70, 35), alpha(65, 35), alpha(47, 25), alpha(120, 45)].allSatisfy { $0 == once },
          "\([alpha(90, 15), alpha(70, 35), alpha(65, 35), alpha(47, 25), alpha(120, 45)])")
    check("caught, drawn: the page left clear", alpha(170, 80) == 0 && alpha(120, 80) == 0)
  }

  static func shortcuts() {
    check("⌃⌘↓", Combo.parse("Ctrl+Meta+ArrowDown") == Combo(keyCode: 125, modifiers: UInt32(0x1000 | 0x0100)))
    check("⌘T", Combo.parse("Meta+KeyT")?.keyCode == 17)
    check("no modifier: not one", Combo.parse("KeyT") == nil && Combo.parse("Shift+KeyT") == nil)
    check("a key not known: not one", Combo.parse("Meta+Banana") == nil)
    check("a modifier twice: not one", Combo.parse("Meta+Meta+KeyT") == nil)
    check("its name", Combo.parse("Ctrl+Meta+ArrowRight")?.description == "⌃⌘ArrowRight")
    let defaultCount = AppCommand.allCases.count
    check("default keys cover every command (⌘N a new Margin window, docs/BROWSER-WINDOWS.md §5)", ShortcutSet.bindings.count == defaultCount && ShortcutSet.bindings[Combo.parse("Meta+KeyN")!] == .newWindow && Set(ShortcutSet.bindings.values) == Set(AppCommand.allCases))
    let fromCopy = ShortcutSet.bindings(from: ["next-tab": ["Alt+Meta+ArrowDown", "Ctrl+Meta+ArrowDown"], "toggle-sidebar": ["Alt+KeyK"], "palette": [], "prev-space": ["Banana"]])
    check("the copy's keys: both of a command's combinations", fromCopy[Combo.parse("Alt+Meta+ArrowDown")!] == .nextTab && fromCopy[Combo.parse("Ctrl+Meta+ArrowDown")!] == .nextTab)
    check("the copy's keys: the sidebar's own", fromCopy[Combo.parse("Alt+KeyK")!] == .toggleSidebar && fromCopy[Combo.parse("Alt+KeyS")!] == nil)
    check("the copy's keys: the palette is always ⌘T", fromCopy[Combo.parse("Meta+KeyT")!] == .palette)
    check("the copy's keys: a command not named keeps its default", fromCopy[Combo.parse("Alt+Meta+ArrowUp")!] == .prevTab)
    check("the copy's keys: a combination that isn't one: none for it", !fromCopy.values.contains(.prevSpace))
    check("the copy's keys: one combination, one command", ShortcutSet.bindings(from: ["next-tab": ["Meta+KeyT"]])[Combo.parse("Meta+KeyT")!] == .nextTab)
    let ownKeys = ShortcutSet.bindings(from: ["toggle-pin": [], "item-1": ["Alt+Meta+Digit1"], "space-2": []])
    check("the copy's keys: one of Margin.app's own turned off ([]) has none", !ownKeys.values.contains(.togglePin) && ownKeys[Combo.parse("Meta+KeyD")!] == nil && !ownKeys.values.contains(.space2))
    check("the copy's keys: a numbered one moved", ownKeys[Combo.parse("Alt+Meta+Digit1")!] == .item1 && ownKeys[Combo.parse("Meta+Digit1")!] == nil && ownKeys[Combo.parse("Meta+Digit2")!] == .item2)
    // Which keys are held: a hosted native app keeps ⌘L, ⌘D, ⌘1–9 and its sidebar key; a browser (Safari's window,
    // Chrome's or Edge's, any channel) gives Margin the browser ones; a number with nothing behind it isn't held.
    let browsers: Set<String> = ["com.apple.Safari", "com.google.Chrome", "com.microsoft.edgemac"]
    check("a browser host: Safari's window, Chrome, Chrome Beta, Edge", ShortcutSet.hostIsBrowser(target: .safariWindow(nil), safariWindow: nil, bundles: browsers)
          && ShortcutSet.hostIsBrowser(target: .app("com.google.Chrome"), safariWindow: nil, bundles: browsers)
          && ShortcutSet.hostIsBrowser(target: .app("com.google.Chrome.beta"), safariWindow: nil, bundles: browsers)
          && ShortcutSet.hostIsBrowser(target: .app("com.microsoft.edgemac"), safariWindow: nil, bundles: browsers))
    check("not a browser host: Notes, Terminal", !ShortcutSet.hostIsBrowser(target: .app("com.apple.Notes"), safariWindow: nil, bundles: browsers)
          && !ShortcutSet.hostIsBrowser(target: .app("com.apple.Terminal"), safariWindow: nil, bundles: browsers))
    let allKeys = ShortcutSet.bindings
    let heldNative = ShortcutSet.held(allKeys, marginInFront: false, browser: false, spaces: 3, items: 5)
    check("a native app in front: its ⌘L, ⌘D, ⌘1 and sidebar key stay its own", heldNative[Combo.parse("Meta+KeyL")!] == nil && heldNative[Combo.parse("Meta+KeyD")!] == nil
          && heldNative[Combo.parse("Meta+Digit1")!] == nil && heldNative[Combo.parse("Alt+KeyS")!] == nil)
    check("a native app in front: Margin's space keys and Add Split still Margin's (up to its spaces)", heldNative[Combo.parse("Ctrl+Digit3")!] == .space3 && heldNative[Combo.parse("Ctrl+Digit4")!] == nil
          && heldNative[Combo.parse("Ctrl+Shift+Equal")!] == .addSplit && heldNative[Combo.parse("Alt+Meta+KeyN")!] == .littleArc)
    let heldChrome = ShortcutSet.held(allKeys, marginInFront: false, browser: true, spaces: 3, items: 5)
    check("a browser in front: ⌘D, ⌘L and ⌘1–5 Margin's, ⌘6–9 the browser's", heldChrome[Combo.parse("Meta+KeyD")!] == .togglePin && heldChrome[Combo.parse("Meta+KeyL")!] == .focusAddress
          && heldChrome[Combo.parse("Meta+Digit5")!] == .item5 && heldChrome[Combo.parse("Meta+Digit6")!] == nil && heldChrome[Combo.parse("Alt+KeyS")!] == nil)
    let heldOwn = ShortcutSet.held(allKeys, marginInFront: true, browser: false, spaces: nil, items: nil)
    check("Margin in front, counts not said yet: every key held", heldOwn.count == allKeys.count)
    check("Margin in front, no rows: no ⌘digit held", ShortcutSet.held(allKeys, marginInFront: true, browser: false, spaces: 1, items: 0).values.allSatisfy { $0.itemNumber == nil && ($0.spaceNumber ?? 1) <= 1 })
    check("keys Settings can record: punctuation and F keys", Combo.parse("Alt+Comma") != nil && Combo.parse("Ctrl+F5") != nil && Combo.parse("Meta+Backquote") != nil)
    // The core's Mac key codes against Carbon's own constants, every key Margin's keys can be (the table the Swift
    // side kept before the rules moved to margin-core).
    let carbonCodes: [String: Int] = [
        "ArrowDown": kVK_DownArrow, "ArrowUp": kVK_UpArrow, "ArrowLeft": kVK_LeftArrow, "ArrowRight": kVK_RightArrow,
        "KeyA": kVK_ANSI_A, "KeyB": kVK_ANSI_B, "KeyC": kVK_ANSI_C, "KeyD": kVK_ANSI_D, "KeyE": kVK_ANSI_E, "KeyF": kVK_ANSI_F,
        "KeyG": kVK_ANSI_G, "KeyH": kVK_ANSI_H, "KeyI": kVK_ANSI_I, "KeyJ": kVK_ANSI_J, "KeyK": kVK_ANSI_K, "KeyL": kVK_ANSI_L,
        "KeyM": kVK_ANSI_M, "KeyN": kVK_ANSI_N, "KeyO": kVK_ANSI_O, "KeyP": kVK_ANSI_P, "KeyQ": kVK_ANSI_Q, "KeyR": kVK_ANSI_R,
        "KeyS": kVK_ANSI_S, "KeyT": kVK_ANSI_T, "KeyU": kVK_ANSI_U, "KeyV": kVK_ANSI_V, "KeyW": kVK_ANSI_W, "KeyX": kVK_ANSI_X,
        "KeyY": kVK_ANSI_Y, "KeyZ": kVK_ANSI_Z, "Space": kVK_Space, "F19": kVK_F19,
        "Digit0": kVK_ANSI_0, "Digit1": kVK_ANSI_1, "Digit2": kVK_ANSI_2, "Digit3": kVK_ANSI_3, "Digit4": kVK_ANSI_4,
        "Digit5": kVK_ANSI_5, "Digit6": kVK_ANSI_6, "Digit7": kVK_ANSI_7, "Digit8": kVK_ANSI_8, "Digit9": kVK_ANSI_9,
        "Enter": kVK_Return, "Backquote": kVK_ANSI_Grave, "Minus": kVK_ANSI_Minus, "Equal": kVK_ANSI_Equal,
        "BracketLeft": kVK_ANSI_LeftBracket, "BracketRight": kVK_ANSI_RightBracket, "Backslash": kVK_ANSI_Backslash,
        "Semicolon": kVK_ANSI_Semicolon, "Quote": kVK_ANSI_Quote, "Comma": kVK_ANSI_Comma, "Period": kVK_ANSI_Period, "Slash": kVK_ANSI_Slash,
        "F1": kVK_F1, "F2": kVK_F2, "F3": kVK_F3, "F4": kVK_F4, "F5": kVK_F5, "F6": kVK_F6,
        "F7": kVK_F7, "F8": kVK_F8, "F9": kVK_F9, "F10": kVK_F10, "F11": kVK_F11, "F12": kVK_F12,
    ]
    let wrongCodes = carbonCodes.filter { Combo.parse("Meta+\($0.key)")?.keyCode != UInt32($0.value) }.map(\.key).sorted()
    check("margin-core's Mac key codes are Carbon's, all 66 keys", carbonCodes.count == 66 && wrongCodes.isEmpty, "\(wrongCodes)")
    check("margin-core's modifier bits are Carbon's", Combo.parse("Ctrl+Alt+Shift+Meta+KeyA")?.modifiers == UInt32(cmdKey | controlKey | optionKey | shiftKey)
          && Combo.parse("Ctrl+KeyA")?.modifiers == UInt32(controlKey) && Combo.parse("Alt+KeyA")?.modifiers == UInt32(optionKey))
    // Hosting: Margin itself, or an app it hosts with a Margin window on the current Space.
    check("hosted gate: Margin in front with a window", ShortcutSet.hostedActive(frontPid: 1, ownPid: 1, hostedPids: [], marginWindowOpen: true, marginOnCurrentSpace: false))
    check("hosted gate: a hosted app in front, Margin's window on the current Space", ShortcutSet.hostedActive(frontPid: 20, ownPid: 1, hostedPids: [20, 21], marginWindowOpen: true, marginOnCurrentSpace: true))
    check("hosted gate: a hosted app in front, Margin's window on another Space: let go", !ShortcutSet.hostedActive(frontPid: 20, ownPid: 1, hostedPids: [20], marginWindowOpen: true, marginOnCurrentSpace: false))
    check("hosted gate: an app Margin doesn't host: let go", !ShortcutSet.hostedActive(frontPid: 30, ownPid: 1, hostedPids: [20], marginWindowOpen: true, marginOnCurrentSpace: true))
    check("hosted gate: no Margin window open, or no app in front: let go", !ShortcutSet.hostedActive(frontPid: 1, ownPid: 1, hostedPids: [], marginWindowOpen: false, marginOnCurrentSpace: true)
          && !ShortcutSet.hostedActive(frontPid: nil, ownPid: 1, hostedPids: [20], marginWindowOpen: true, marginOnCurrentSpace: true))
    let fake = FakeRegistrar()
    let keys = AppShortcuts(registrar: fake)
    var ran: [AppCommand] = []
    keys.onCommand = { command, _ in ran.append(command) }
    check("not held at first", fake.held.isEmpty && !keys.isActive)
    keys.set(active: true)
    check("held while active", fake.held.count == defaultCount && keys.isActive)
    keys.set(active: true)
    check("not registered twice", fake.registrations == defaultCount)
    let nextTab = fake.held.first { $0.value == Combo.parse("Alt+Meta+ArrowDown") }!.key
    fake.onHit?(nextTab)
    check("a key: its command", ran == [.nextTab])
    keys.set(active: false)
    check("let go", fake.held.isEmpty && !keys.isActive)
    fake.onHit?(nextTab)
    check("a stray hit after letting go: nothing", ran == [.nextTab])
    fake.taken = [Combo.parse("Meta+KeyT")!]
    keys.set(active: true)
    check("one another app holds: the rest still Margin's", fake.held.count == defaultCount - 1 && keys.unavailable == [Combo.parse("Meta+KeyT")!])
    fake.taken = []
    keys.rebind(fromCopy)
    check("new keys while held: the new ones held at once", keys.isActive && Set(fake.held.values) == Set(fromCopy.keys) && fake.held.count == fromCopy.count)
    let toggle = fake.held.first { $0.value == Combo.parse("Alt+KeyK") }!.key
    ran = []
    fake.onHit?(toggle)
    check("a new key: its command", ran == [.toggleSidebar])
    let before = fake.registrations
    keys.rebind(fromCopy)
    check("the same keys again: nothing registered again", fake.registrations == before)
    keys.set(active: false)
    check("let go after a rebind: none held", fake.held.isEmpty)

    func reloadEvent(_ characters: String, _ modifiers: NSEvent.ModifierFlags, type: NSEvent.EventType = .keyDown) -> NSEvent {
        NSEvent.keyEvent(with: type, location: .zero, modifierFlags: modifiers, timestamp: 0, windowNumber: 0,
                        context: nil, characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: 15)!
    }
    check("focused layout reload: plain ⌘R, including Caps Lock", OverlayWebView.isBrowserReload(reloadEvent("r", .command))
          && OverlayWebView.isBrowserReload(reloadEvent("R", [.command, .capsLock])))
    check("focused layout reload: typing and other modifier combinations stay untouched",
          !OverlayWebView.isBrowserReload(reloadEvent("r", []))
          && !OverlayWebView.isBrowserReload(reloadEvent("r", [.command, .shift]))
          && !OverlayWebView.isBrowserReload(reloadEvent("r", [.command, .option]))
          && !OverlayWebView.isBrowserReload(reloadEvent("r", [.command, .control]))
          && !OverlayWebView.isBrowserReload(reloadEvent("l", .command))
          && !OverlayWebView.isBrowserReload(reloadEvent("r", .command, type: .keyUp)))
    check("quit prompt: Return or Enter quits, Escape cancels, ⌘Q again quits, other keys nothing",
          QuitPrompt.choice(keyCode: 36, command: false) == .quit && QuitPrompt.choice(keyCode: 76, command: false) == .quit
          && QuitPrompt.choice(keyCode: 53, command: false) == .cancel && QuitPrompt.choice(keyCode: 12, command: true) == .quit
          && QuitPrompt.choice(keyCode: 12, command: false) == nil && QuitPrompt.choice(keyCode: 0, command: false) == nil)
    // When ⌘Q is Margin's first: it asks before quitting, isn't quitting, and Margin or an app it hosts is in front.
    func guards(asks: Bool = true, quitting: Bool = false, front: pid_t? = 20, hosted: Set<pid_t> = [20, 21], open: Bool = true, here: Bool = true) -> Bool {
        ShortcutSet.guardsQuit(asks: asks, quitting: quitting, frontPid: front, ownPid: 1, hostedPids: hosted, marginWindowOpen: open, marginOnCurrentSpace: here)
    }
    check("quit guard: held with an app Margin hosts in front (Margin's window on the current Space), and with Margin itself in front", guards() && guards(front: 1, hosted: []) && guards(front: 1, here: false))
    check("quit guard: an app Margin doesn't host in front: never held (⌘Q is that app's)", !guards(front: 30) && !guards(front: nil))
    check("quit guard: a hosted app's process in front on another Space (the person's own window of it): never held", !guards(here: false))
    check("quit guard: no Margin window open: never held", !guards(open: false) && !guards(front: 1, open: false))
    check("quit guard: asking off (after Always quit): still held with a hosted app in front (it quits Margin, never the hosted app alone), let go with Margin itself in front (its own Quit) and for an app Margin doesn't host",
          guards(asks: false) && !guards(asks: false, front: 1) && !guards(asks: false, front: 30) && !guards(asks: false, here: false))
    check("quit guard: Margin already quitting: let go", !guards(quitting: true))
    // What the prompt says: numbers and Margin's own words.
    check("quit prompt: what quitting closes, in numbers: tabs and apps", QuitSummary(tabs: 3, apps: 2, kept: 0).note
          == "Margin will close 3 open tabs and quit 2 apps it opened. Your tabs stay in their spaces, but unsaved work may be lost.", QuitSummary(tabs: 3, apps: 2, kept: 0).note)
    check("quit prompt: one of each, singular", QuitSummary(tabs: 1, apps: 1, kept: 0).note == "Margin will close 1 open tab and quit 1 app it opened. Your tabs stay in their spaces, but unsaved work may be lost."
          && QuitSummary(tabs: 1, apps: 0, kept: 0).note == "Margin will close 1 open tab. It stays in its space, but unsaved work may be lost."
          && QuitSummary(tabs: 0, apps: 1, kept: 0).note == "Margin will quit 1 app it opened. Unsaved work may be lost.")
    check("quit prompt: tabs only, apps only", QuitSummary(tabs: 4, apps: 0, kept: 0).note == "Margin will close 4 open tabs. They stay in their spaces, but unsaved work may be lost."
          && QuitSummary(tabs: 0, apps: 3, kept: 0).note == "Margin will quit 3 apps it opened. Unsaved work may be lost.")
    check("quit prompt: apps the person opened themselves stay open, said so", QuitSummary(tabs: 0, apps: 1, kept: 1).note == "Margin will quit 1 app it opened. Unsaved work may be lost. 1 app you opened yourself stays open."
          && QuitSummary(tabs: 0, apps: 0, kept: 2).note == "Nothing Margin opened is running. 2 apps you opened yourself stay open.")
    check("quit prompt: nothing hosted", QuitSummary().note == "Nothing Margin opened is running.")
    do {
        let prompt = QuitPrompt(note: QuitSummary(tabs: 3, apps: 2, kept: 1).note, harness: true)
        let view = prompt.view
        check("quit prompt: it asks about Margin, with what it closes below; three buttons", view?.title.stringValue == "Are you sure you want to quit Margin?"
              && view?.note.stringValue == QuitSummary(tabs: 3, apps: 2, kept: 1).note && view?.buttons.map(\.title) == ["Always quit", "Cancel", "Quit"])
        let short = QuitPrompt(note: "Nothing Margin opened is running.", harness: true)
        check("quit prompt: as tall as its note's lines need (a long one wraps, nothing cut off)", prompt.frame.height > short.frame.height && short.frame.height == 236
              && (view?.note.frame.height ?? 0) >= 30 && prompt.frame.width == QuitPrompt.width, "\(prompt.frame.size) \(short.frame.size) note \(String(describing: view?.note.frame))")
        check("quit prompt: above a hosted window and Margin's own window in front of it (its raised level), in a full-screen Space, joining the current Space, never in the window cycle",
              prompt.level == .modalPanel && prompt.level.rawValue > FrontMechanism.raised.rawValue && prompt.level.rawValue > NSWindow.Level.normal.rawValue
              && prompt.collectionBehavior.contains(.fullScreenAuxiliary) && prompt.collectionBehavior.contains(.moveToActiveSpace) && prompt.collectionBehavior.contains(.ignoresCycle)
              && !prompt.collectionBehavior.contains(.fullScreenPrimary) && prompt.styleMask.contains(.nonactivatingPanel) && prompt.canBecomeKey && !prompt.canBecomeMain)
        // (Margin's full-screen window: the display, top left 0,33.)
        let over = QuitPrompt.frame(over: CGRect(x: 0, y: 33, width: 1512, height: 949), size: CGSize(width: 460, height: 236))
        check("quit prompt: centred on Margin's window, a little above the middle", over == CGRect(x: 526, y: 350, width: 460, height: 236), "\(over)")
        // Light and dark: nothing forces an appearance; its colours are the appearance's it's drawn in.
        func white(_ c: NSColor, dark: Bool) -> CGFloat { QuitPromptStyle.resolved(c, dark: dark).usingColorSpace(.deviceGray)?.whiteComponent ?? -1 }
        check("quit prompt: follows light and dark: a light card with dark text in light, a dark card with light text in dark; no appearance forced",
              prompt.appearance == nil && view?.appearance == nil && white(QuitPromptStyle.card, dark: false) > 0.9 && white(QuitPromptStyle.card, dark: true) < 0.2
              && white(view?.title.textColor ?? .clear, dark: false) < 0.3 && white(view?.title.textColor ?? .clear, dark: true) > 0.7
              && white(view?.note.textColor ?? .clear, dark: false) < 0.5 && white(view?.note.textColor ?? .clear, dark: true) > 0.5,
              "card \(white(QuitPromptStyle.card, dark: false)) / \(white(QuitPromptStyle.card, dark: true)), title \(white(view?.title.textColor ?? .clear, dark: false)) / \(white(view?.title.textColor ?? .clear, dark: true))")
        var chose: [QuitChoice] = []
        prompt.onChoice = { chose.append($0) }
        prompt.show(over: CGRect(x: 0, y: 33, width: 1512, height: 949))
        check("quit prompt: a test's is up without being ordered in or taking the keys", prompt.isUp && !prompt.isVisible && !prompt.isKeyWindow)
        view?.buttons.first { $0.title == "Cancel" }?.press()
        view?.buttons.first { $0.title == "Quit" }?.press()
        check("quit prompt: one choice, once; then it's down", chose == [.cancel] && !prompt.isUp, "\(chose)")
    }
    var quits: [Bool] = []
    keys.onQuit = { quits.append($0) }
    keys.setQuitGuard(active: true)
    let q = fake.held.first { $0.value == Combo.parse("Meta+KeyQ") }?.key, oq = fake.held.first { $0.value == Combo.parse("Alt+Meta+KeyQ") }?.key
    check("quit guard: ⌘Q and ⌥⌘Q held, apart from Margin's keys (none held now)", q != nil && oq != nil && fake.held.count == 2 && !keys.isActive)
    if let q, let oq { fake.onHit?(q); fake.onHit?(oq) }
    check("quit guard: each press says which of the two it was", quits == [false, true], "\(quits)")
    keys.set(active: true)
    keys.set(active: false)
    check("quit guard: Margin's keys coming and going leave it held", fake.held.count == 2 && keys.guardsQuit)
    keys.setQuitGuard(active: false)
    if let q { fake.onHit?(q) }
    check("quit guard: let go, ⌘Q is the front app's again", fake.held.isEmpty && quits.count == 2)

    // A hosted app's own keys that would undo its hosting (⌘W, ⇧⌘W, ⌥⌘W, ⌘M, ⌘H, ⌥⌘H, ⌃⌘F): Margin's only while an app
    // it hosts is in front, never while Margin itself is (its own menu has them) or another app is.
    func appKeys(quitting: Bool = false, front: pid_t? = 20, hosted: Set<pid_t> = [20, 21], open: Bool = true, here: Bool = true) -> Bool {
        ShortcutSet.guardsAppKeys(quitting: quitting, frontPid: front, ownPid: 1, hostedPids: hosted, marginWindowOpen: open, marginOnCurrentSpace: here)
    }
    check("app keys: held with an app Margin hosts in front, Margin's window on the current Space", appKeys() && appKeys(front: 21))
    check("app keys: never with Margin itself in front (its menu's Close Tab, Close Window, Minimize, Hide), another app in front, no Margin window, another Space, or quitting",
          !appKeys(front: 1) && !appKeys(front: 30) && !appKeys(front: nil) && !appKeys(open: false) && !appKeys(here: false) && !appKeys(quitting: true))
    check("app keys: the seven combinations, each a key with ⌘", AppShortcuts.appKeyCombos.map(\.combo) == ["Meta+KeyW", "Shift+Meta+KeyW", "Alt+Meta+KeyW", "Meta+KeyM", "Meta+KeyH", "Alt+Meta+KeyH", "Ctrl+Meta+KeyF"].compactMap(Combo.parse)
          && AppShortcuts.appKeyCombos.allSatisfy { $0.combo.modifiers & Combo.parse("Meta+KeyA")!.modifiers != 0 })
    var appKeyHits: [AppKey] = []
    keys.onAppKey = { appKeyHits.append($0) }
    keys.setAppKeyGuard(active: true)
    let w = fake.held.first { $0.value == Combo.parse("Meta+KeyW") }?.key, m = fake.held.first { $0.value == Combo.parse("Meta+KeyM") }?.key
    check("app keys: all seven held, apart from Margin's keys and the quit guard", fake.held.count == AppKey.allCases.count && w != nil && m != nil && !keys.isActive && !keys.guardsQuit)
    if let w, let m { fake.onHit?(w); fake.onHit?(m) }
    check("app keys: each press says which key it was", appKeyHits == [.closeTab, .minimize], "\(appKeyHits)")
    keys.setQuitGuard(active: true)
    keys.set(active: true)
    keys.set(active: false)
    keys.setQuitGuard(active: false)
    check("app keys: Margin's keys and the quit guard coming and going leave them held", fake.held.count == AppKey.allCases.count && keys.guardsAppKeys)
    keys.setAppKeyGuard(active: false)
    if let w { fake.onHit?(w) }
    check("app keys: let go, they're the front app's again", fake.held.isEmpty && appKeyHits.count == 2)

    // A held key repeats at the Mac's repeat (a test clock), until let go.
    var waits: [(TimeInterval, () -> Void)] = []
    var mods = true
    var rep = KeyRepeat()
    rep.delay = { 0.4 }
    rep.interval = { 0.05 }
    rep.after = { seconds, run in
      var live = true
      waits.append((seconds, { if live { run() } }))
      return { live = false }
    }
    rep.now = { 0 } // (a test's clock: each repeat runs at its due time, the waits say the gaps)
    rep.modifiers = { mods ? 0x1B00 : 0 }
    let fake2 = FakeRegistrar()
    let held = AppShortcuts(registrar: fake2, keyRepeat: rep)
    var ran2: [AppCommand] = []
    var repeats2: [Bool] = []
    held.onCommand = { command, isRepeat in ran2.append(command); repeats2.append(isRepeat) }
    held.set(active: true)
    let down = fake2.held.first { $0.value == Combo.parse("Alt+Meta+ArrowDown") }!.key
    func runNext() { if !waits.isEmpty { waits.removeFirst().1() } }
    fake2.onHit?(down)
    check("held: once at the press", ran2 == [.nextTab] && waits.first?.0 == 0.4)
    runNext(); runNext(); runNext()
    check("held: again after the delay, then at the rate", ran2.count == 4 && abs((waits.first?.0 ?? 0) - 0.05) < 1e-9, "\(ran2.count) \(waits.map(\.0))")
    check("held: the press is a press, the rest repeats", repeats2 == [false, true, true, true])
    fake2.onRelease?(down)
    runNext()
    check("let go: no more", ran2.count == 4)
    fake2.onHit?(down)
    mods = false
    runNext()
    check("the release missed, the modifiers up: it stops", ran2.count == 5 && waits.isEmpty)
    mods = true
    let palette = fake2.held.first { $0.value == Combo.parse("Meta+KeyT") }!.key
    ran2 = []
    fake2.onHit?(palette)
    check("the palette key doesn't repeat", ran2 == [.palette] && waits.isEmpty)
    fake2.onHit?(down)
    held.set(active: false)
    runNext()
    check("keys let go (another app in front): the repeat stops", ran2 == [.palette, .nextTab])
    keys.rebind(ShortcutSet.bindings)
    check("new keys while let go: none held", fake.held.isEmpty && !keys.isActive)

    // A held ⌃⌘→ repeats too (Margin's window takes each as the next space: overlay.ts).
    waits = []
    mods = true
    let reg = FakeRegistrar()
    let spaceKeys = AppShortcuts(registrar: reg, keyRepeat: rep)
    var spaceRepeats = 0
    spaceKeys.onCommand = { command, isRepeat in if command == .nextSpace, isRepeat { spaceRepeats += 1 } }
    spaceKeys.set(active: true)
    let right = reg.held.first { $0.value == Combo.parse("Alt+Meta+ArrowRight") }!.key
    reg.onHit?(right)
    for _ in 0..<8 { runNext() }
    reg.onRelease?(right)
    spaceKeys.set(active: false)
    check("held next space: it repeats", spaceRepeats == 8)
    // Carbon itself, with a key no one uses (held for a moment, never pressed).
    let carbon = CarbonHotKeys()
    let odd = Combo.parse("Ctrl+Alt+Shift+Meta+F19")!
    check("Carbon: a key registered and let go", carbon.register(odd, id: 99))
    carbon.unregister(id: 99)
    check("Carbon: again after letting go", carbon.register(odd, id: 99))
    carbon.unregister(id: 99)
  }

  static func geometry() {
    check("window server to AppKit: flipped on the main display", ScreenGeometry.appKitRect(CGRect(x: 10, y: 20, width: 300, height: 200), mainHeight: 1000) == CGRect(x: 10, y: 780, width: 300, height: 200))
    check("and back", ScreenGeometry.appKitRect(CGRect(x: 10, y: 780, width: 300, height: 200), mainHeight: 1000) == CGRect(x: 10, y: 20, width: 300, height: 200))
    check("off screen stays off screen", ScreenGeometry.appKitRect(CGRect(x: -20000, y: -20000, width: 1280, height: 800), mainHeight: 982).minY == 982 + 20000 - 800)
    check("a pointer flipped", ScreenGeometry.topLeftPoint(CGPoint(x: 5, y: 990), mainHeight: 1000) == CGPoint(x: 5, y: 10))
  }

  // When Margin.app quits by itself (IdleQuit.swift, AppDelegate.swift's 30 s check): never once the person opened
  // it or while anything is hosted; started in the background and never opened, after 60 s with nothing to do.
  static func idleQuit() {
    let idle = IdleQuit.State(startedInBackground: true, shown: false, hosting: false, linked: false, browserOpen: false)
    let t0 = Date(timeIntervalSince1970: 1_000_000)
    check("idle quit: started in the background, never opened, nothing hosted, no copy, no browser: idle", IdleQuit.idle(idle))
    var s = idle; s.startedInBackground = false
    check("idle quit: opened by the person: never", !IdleQuit.idle(s) && IdleQuit.check(s, since: t0, now: t0 + 3600) == (nil, false))
    s = idle; s.shown = true
    check("idle quit: a window of Margin's shown since (even closed again): never", !IdleQuit.idle(s) && !IdleQuit.check(s, since: t0, now: t0 + 86_400).quit)
    s = idle; s.hosting = true
    check("idle quit: something hosted: never", !IdleQuit.idle(s) && !IdleQuit.check(s, since: t0, now: t0 + 86_400).quit)
    s = idle; s.linked = true
    check("idle quit: a copy linked: not idle", !IdleQuit.idle(s))
    s = idle; s.browserOpen = true
    check("idle quit: a browser open: not idle", !IdleQuit.idle(s))
    let first = IdleQuit.check(idle, since: nil, now: t0)
    check("idle quit: first seen idle: counted from now, no quit yet", first.since == t0 && !first.quit)
    check("idle quit: 30 s idle: not yet", IdleQuit.check(idle, since: t0, now: t0 + 30) == (t0, false))
    check("idle quit: 60 s idle: quits", IdleQuit.check(idle, since: t0, now: t0 + 60) == (t0, true) && IdleQuit.after == 60)
    // A browser opened in between: the count starts again.
    let broken = IdleQuit.check(s, since: t0, now: t0 + 45)
    let again = IdleQuit.check(idle, since: broken.since, now: t0 + 75)
    check("idle quit: a break (a browser opened for a moment) starts the minute again", broken.since == nil && again.since == t0 + 75 && !again.quit
          && IdleQuit.check(idle, since: again.since, now: t0 + 135).quit)
  }

  // One Margin.app at a time (BundleWatch.swift, AppDelegate.swift): a new instance ends the others of its bundle.
  static func oneMargin() {
    let here = "/Users/t/Applications/Margin.app"
    let running = [BundleWatch.Running(pid: 10, bundlePath: here), BundleWatch.Running(pid: 11, bundlePath: here + "/"),
                   BundleWatch.Running(pid: 12, bundlePath: here + ".old"), BundleWatch.Running(pid: 13, bundlePath: "/Users/t/Projects/margin/xcode/build/Build/Products/Release/Margin.app"),
                   BundleWatch.Running(pid: 14, bundlePath: nil), BundleWatch.Running(pid: 15, bundlePath: "/Users/t/Library/Developer/Xcode/DerivedData/Margin-x/Build/Products/Debug/Margin.app")]
    check("one Margin.app: the others of this bundle (and one an update moved aside) end, never this one", BundleWatch.othersToEnd(running, me: 10, bundlePath: here) == [11, 12])
    check("never a build folder's or Xcode's copy, nor one whose bundle isn't known", !BundleWatch.othersToEnd(running, me: 99, bundlePath: here).contains { [13, 14, 15].contains($0) })
    check("alone: nothing to end", BundleWatch.othersToEnd([BundleWatch.Running(pid: 10, bundlePath: here)], me: 10, bundlePath: here).isEmpty)
    // The registered copies that go: build folders', the Trash's, gone ones; never this one or another real install.
    let me = URL(fileURLWithPath: "/Users/u/Applications/Margin.app")
    let registered = [me, URL(fileURLWithPath: "/Users/u/Projects/margin/xcode/build/Build/Products/Release/Margin.app"),
                      URL(fileURLWithPath: "/Users/u/Library/Developer/Xcode/DerivedData/Margin-x/Build/Products/Debug/Margin.app"),
                      URL(fileURLWithPath: "/Users/u/.Trash/Margin.app"), URL(fileURLWithPath: "/private/tmp/t/Margin.app"),
                      URL(fileURLWithPath: "/Applications/Margin.app"), URL(fileURLWithPath: "/Users/u/Old/Margin.app"),
                      URL(fileURLWithPath: "/Users/u/Projects/margin/xcode/build/Build/Products/Release/Margin.app")]
    let gone: Set<String> = ["/Users/u/Old/Margin.app"]
    let strays = BundleWatch.strays(registered, me: me, exists: { !gone.contains($0.path) }).map(\.path)
    check("registration: a build folder's, DerivedData's, the Trash's, a temporary folder's and a gone copy are strays, once each",
          strays == ["/Users/u/Projects/margin/xcode/build/Build/Products/Release/Margin.app",
                     "/Users/u/Library/Developer/Xcode/DerivedData/Margin-x/Build/Products/Debug/Margin.app",
                     "/Users/u/.Trash/Margin.app", "/private/tmp/t/Margin.app", "/Users/u/Old/Margin.app"], "\(strays)")
    check("registration: never this copy, nor another install in an Applications folder", !strays.contains(me.path) && !strays.contains("/Applications/Margin.app"))
    // The executable's identity, read from a real file (in a temporary folder) as scripts/safari.sh swaps the bundle.
    let fm = FileManager.default
    let dir = fm.temporaryDirectory.appendingPathComponent("margin-bundle-\(UUID().uuidString)", isDirectory: true)
    defer { try? fm.removeItem(at: dir) }
    try? fm.createDirectory(at: dir.appendingPathComponent("Margin.app/Contents/MacOS"), withIntermediateDirectories: true)
    let exe = dir.appendingPathComponent("Margin.app/Contents/MacOS/Margin")
    try? Data("old build".utf8).write(to: exe)
    let first = FileIdentity.of(exe)
    check("an executable's identity: read, and the same when nothing changed", first != nil && FileIdentity.of(exe) == first)
    try? fm.createDirectory(at: dir.appendingPathComponent("Margin.app.new/Contents/MacOS"), withIntermediateDirectories: true)
    try? Data("new build".utf8).write(to: dir.appendingPathComponent("Margin.app.new/Contents/MacOS/Margin"))
    try? fm.moveItem(at: dir.appendingPathComponent("Margin.app"), to: dir.appendingPathComponent("Margin.app.old"))
    check("mid-swap (the bundle moved aside): can't be read", FileIdentity.of(exe) == nil)
    try? fm.moveItem(at: dir.appendingPathComponent("Margin.app.new"), to: dir.appendingPathComponent("Margin.app"))
    check("the new bundle in its place: another file at the same path", FileIdentity.of(exe) != nil && FileIdentity.of(exe) != first)
    var quit = 0
    let watch = BundleWatch(read: { FileIdentity.of(exe) }, quit: { quit += 1 })
    try? fm.removeItem(at: dir.appendingPathComponent("Margin.app.old"))
    check("its own build in place: no quit", !watch.check("test") && quit == 0)
  }

  static func pointerWant() {
    let size = CGSize(width: 1280, height: 800)
    let edges = PointerWant(["mode": "edges", "edges": ["left"], "zone": 24])
    check("pointer: the reveal zone only while hidden", edges.wants(CGPoint(x: 3, y: 400), in: size) && edges.wants(CGPoint(x: 24, y: 400), in: size) && !edges.wants(CGPoint(x: 25, y: 400), in: size) && !edges.wants(CGPoint(x: 1279, y: 400), in: size))
    check("a right-hand theme's", PointerWant(["mode": "edges", "edges": ["right"], "zone": 10]).wants(CGPoint(x: 1275, y: 1), in: size))
    check("none while docked", !PointerWant(["mode": "none"]).wants(CGPoint(x: 0, y: 0), in: size))
    check("all while out, and before the page says", PointerWant(["mode": "all"]).wants(CGPoint(x: 600, y: 400), in: size) && PointerWant([:]).mode == .all)
  }
}

// The overlay's frame rate (issue #14): WebKit's 60 fps feature turned off where it exists, and the probe's script
// posts to the page's bridge. The feature is WebKit's own (private): if a macOS drops it, `uncap` says so and the
// overlay keeps WebKit's rate, which this lets through.
@MainActor func frameRate() {
    let preferences = WKPreferences()
    let said = OverlayFrameRate.uncap(preferences)
    check("frame rate: the 60 fps feature off, or a reason it's kept", said.hasPrefix("the display's rate") || said.hasPrefix("kept near 60 fps"), said)
    if ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26 {
        check("frame rate: on macOS 26 and later, WebKit has the feature and it turns off", said.hasPrefix("the display's rate"), said)
    }
    check("frame rate: the probe posts its numbers as an overlay log", OverlayFrameRate.probe.contains("op: 'log'") && OverlayFrameRate.probe.contains("frame probe"))
}

// A theme's system materials (Liquid Glass): WebKit's system appearance turned on for one web view and off again,
// kept off by the defaults key, and each outcome said. The switch is WebKit's own (private): if a macOS drops it,
// `set` says so, nothing changes, and the theme draws its plain fills, which this lets through.
@MainActor func systemAppearance() {
    let view = WKWebView(frame: .zero)
    let on = OverlaySystemAppearance.set(true, for: view)
    check("system appearance: on, or a reason it stays off", on == "on" || on.hasPrefix("off: "), on)
    if ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26 {
        check("system appearance: on macOS 26 and later, WebKit has the switch and it turns on", on == "on", on)
        let read = view.value(forKey: "_useSystemAppearance") as? Bool
        check("system appearance: the web view reads it back", read == true, "\(String(describing: read))")
        let other = WKWebView(frame: .zero)
        check("system appearance: one web view's, not every web view's", other.value(forKey: "_useSystemAppearance") as? Bool == false)
    }
    let off = OverlaySystemAppearance.set(false, for: view)
    check("system appearance: off again for a theme that doesn't ask", off == "off" || off.hasPrefix("off: WebKit has no"), off)
    let kept = OverlaySystemAppearance.set(true, for: view, allowed: false)
    check("system appearance: MarginSystemAppearance NO keeps it off", kept.hasPrefix("off: "), kept)
    if on == "on" { check("system appearance: and says the defaults key did", kept == "off: MarginSystemAppearance is NO", kept) }
}
