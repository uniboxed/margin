// The first click in another pane goes through (PaneClickTap.swift), part of tests.swift's run: the tap's decision for
// every kind of press (a pane without the keys, the one with them, Margin's own UI over the page, a card open, ⌘ and ⌃,
// another button held, a field of Margin's with the keys, another window over the pane); the hold on a stand-in
// focuser and a pipe of events as the window server hands them (the press let go only once its window is key, every
// event once and in order: a click, a double-click, a drag from the other pane; the cap; a window key already; across
// apps; covered; the claims the monitor's press is matched by); the tap's mask (left presses only); and the engine's
// bookkeeping for a press the tap focused (its window key already: nothing fronted, the one shown and the holes' focus
// follow). The tap's life in a real Margin window (made at two visible, gone at one, on a Space change, at quit) is
// e2e-split.swift's.
import AppKit
import Foundation

// A stand-in for Accessibility's quick focus, on a clock of its own: each read costs `readCost`, a focus asked takes
// `keyAfter` to make its window key (nil: never), and the log has each focus ask (the pipe adds each event delivered).
final class FakePaneFocus: PaneFocusing, @unchecked Sendable {
    var clock = 100.0
    var front: pid_t = 501
    var focusedOf: [pid_t: Int] = [501: 10]
    var keyAfter: Double? = 0.006
    var readCost = 0.0003
    var unread = false
    var cover: PaneClickCover?
    var log: [String] = []
    private(set) var keyReads = 0
    private(set) var coverAsks = 0
    private(set) var warmed: [[Int]] = []
    private var asked: (at: Double, pid: pid_t, window: Int)?
    func now() -> Double { clock }
    func pause(_ seconds: Double) { clock += seconds }
    // All panes active: apps kept active by records (AppKit in them says it's active: AXFrontmost true), the window
    // server's front process (nil: no such read, Accessibility's word alone).
    var axActive: Set<pid_t> = []
    var serverFront: pid_t?
    func keyState(pid: pid_t, until: Double) -> (front: Bool, window: Int?)? {
        keyReads += 1
        clock += readCost
        if let a = asked, let after = keyAfter, clock - a.at >= after { front = a.pid; focusedOf[a.pid] = a.window; if serverFront != nil { serverFront = a.pid } }
        return unread ? nil : (front == pid || axActive.contains(pid), focusedOf[pid])
    }
    func frontProcess() -> pid_t? { serverFront }
    func makeFront(pid: pid_t, window: Int) -> Bool {
        log.append("makeFront \(window)")
        clock += 0.0003
        front = pid
        if serverFront != nil { serverFront = pid }
        focusedOf[pid] = window
        return true
    }
    func focus(pid: pid_t, window: Int, frontmost: Bool, until: Double) -> Bool {
        log.append("focus \(window)\(frontmost ? " frontmost" : "")")
        asked = (clock, pid, window)
        clock += 0.0005
        return true
    }
    func cover(at point: CGPoint, above window: Int, except: [Int]) -> PaneClickCover? {
        coverAsks += 1
        return cover.flatMap { except.contains($0.window) ? nil : $0 }
    }
    func warm(_ panes: [PaneClickScene.Pane]) { warmed.append(panes.map(\.window)) }
    // A cut pane's (docs/PEEK-SPLIT.md §4b): focus without a raise (its window key `keyAfter` later, as a focus), each
    // event delivered as a record (`delivers` false: no records, routed as before), the window's top left.
    var delivers = true
    var origins: [Int: CGPoint] = [:]
    func focusWithoutRaise(pid: pid_t, window: Int) -> Bool {
        log.append("focusWithoutRaise \(window)")
        asked = (clock, pid, window)
        clock += 0.0003
        return true
    }
    func deliver(_ event: CGEvent, pid: pid_t, window: Int, origin: CGPoint) -> Bool {
        guard delivers else { return false }
        log.append("deliver \(event.type.rawValue) to \(window) at \(Int(event.location.x - origin.x)),\(Int(event.location.y - origin.y))")
        return true
    }
    func windowOrigin(_ window: Int) -> CGPoint? { origins[window] }
    // A press on Margin's own panel (panel-press-tests.swift): an event made afresh (`PanelEvents.make`, checked made),
    // logged at its point in the panel (top left); `panelDelivers` false: refused.
    var panelDelivers = true
    func deliverToPanel(_ event: CGEvent, pid: pid_t, window: Int, content: CGRect) -> Bool {
        guard panelDelivers, PanelEvents.make(from: event, window: window, content: content) != nil else { return false }
        log.append("panel \(event.type.rawValue) to \(window) at \(Int(event.location.x - content.minX)),\(Int(event.location.y - content.minY))")
        return true
    }
}

nonisolated final class PaneBox<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}

func paneClickTests() {
    paneClickTuckTests()
    panelPressTests() // panel-press-tests.swift: a press on Margin's own panel never takes the keyboard (docs/SIDEBAR-PRESS.md)
    paneClickDecisionTests()
    paneClickHoldTests()
    paneClickKeptTests()
    paneClickEngineTests()
}

// A split of two side by side in a 1228×933 page area at 276,41: the left pane (window 10, pid 501) has the keys, the
// right one (window 20) is Safari's too (pid 501) or another app's (pid 502); the divider's 8 pt in the gap is Margin's.
private let page = CGRect(x: 276, y: 41, width: 1228, height: 933)
private let left = CGRect(x: 276, y: 41, width: 610, height: 933), right = CGRect(x: 894, y: 41, width: 610, height: 933)
private let divider = CGRect(x: 886, y: 41, width: 8, height: 933)
private func scene(rightPid: pid_t = 501, focused: Int? = 10, hits: [CGRect] = [divider], captureAll: Bool = false, field: Bool = false) -> PaneClickScene {
    PaneClickScene(panes: [.init(rect: left, pid: 501, window: 10), .init(rect: right, pid: rightPid, window: 20)], focused: focused,
                   slot: Slot(rect: page, radius: 12, hits: hits, captureAll: captureAll, holes: [left, right]), marginWindows: [5, 6], fieldHasKeys: field)
}
private let inRight = CGPoint(x: 1200, y: 500), inLeft = CGPoint(x: 500, y: 500)

private func paneClickDecisionTests() {
    // (Overlays at the assistive-technology level and above let the pointer through: never a cover. The real Mac,
    // 2026-11-21: a keep-awake app's full-screen windows at layer 2147483628 had every held press let go.)
    check("pane click: a window at an overlay's level (assistive tech and above: 1500, shielding 2147483628, cursor 2147483630) is never a cover; a menu (101), a sheet (3), the Dock (20) or a system dialog (1000) is",
          PaneClick.overlay(layer: 2147483628) && PaneClick.overlay(layer: 2147483630) && PaneClick.overlay(layer: Int(CGWindowLevelForKey(.assistiveTechHighWindow)))
          && !PaneClick.overlay(layer: 101) && !PaneClick.overlay(layer: 3) && !PaneClick.overlay(layer: 20) && !PaneClick.overlay(layer: 1000) && !PaneClick.overlay(layer: 0),
          "overlay from \(PaneClick.overlayLayer)")
    var coverAsks = 0
    func decide(_ p: CGPoint, _ s: PaneClickScene?, flags: CGEventFlags = [], buttons: Bool = false, focused: Int?? = nil, cover: PaneClickCover? = nil) -> PaneClick.Decision {
        PaneClick.decide(p, flags: flags, otherButtons: buttons, scene: s, focused: focused ?? s?.focused) { _ in coverAsks += 1; return cover }
    }
    let rightPane = PaneClickScene.Pane(rect: right, pid: 501, window: 20)
    check("pane click: a press in the pane without the keys: held, its window made key (the one under the point, its app's pid)", decide(inRight, scene()) == .hold(rightPane))
    coverAsks = 0
    check("pane click: …in the pane with the keys: passes (it has them), nothing read", decide(inLeft, scene()) == .pass(.focused) && coverAsks == 0)
    check("pane click: …another app's pane: held with that app's pid", decide(inRight, scene(rightPid: 502)) == .hold(.init(rect: right, pid: 502, window: 20)))
    check("pane click: Shift+click and ⌥-click in the other pane: held (Shift+click's Preview takes one click now)",
          decide(inRight, scene(), flags: .maskShift) == .hold(rightPane) && decide(inRight, scene(), flags: .maskAlternate) == .hold(rightPane))
    check("pane click: ⌘-click and ⌃-click: pass as before (Safari takes them in a window without the keys already)",
          decide(inRight, scene(), flags: .maskCommand) == .pass(.modifier) && decide(inRight, scene(), flags: [.maskControl, .maskShift]) == .pass(.modifier))
    check("pane click: another button held (a right drag, a chord): passes", decide(inRight, scene(), buttons: true) == .pass(.button))
    check("pane click: a field of Margin's has the keys (the palette): passes as before", decide(inRight, scene(field: true)) == .pass(.field))
    check("pane click: on the divider (Margin's hit in the gap), its drag included: Margin's, passes", decide(CGPoint(x: 890, y: 500), scene()) == .pass(.margin))
    check("pane click: on a hit of Margin's over a pane (a menu, the card's bar, a notice): passes",
          decide(inRight, scene(hits: [divider, CGRect(x: 1100, y: 400, width: 300, height: 200)])) == .pass(.margin))
    check("pane click: the sidebar, the frame outside the page area: passes", decide(CGPoint(x: 100, y: 500), scene()) == .pass(.margin) && decide(CGPoint(x: 1200, y: 20), scene()) == .pass(.margin))
    check("pane click: the palette or a menu over the whole window (captureAll): passes", decide(inRight, scene(captureAll: true)) == .pass(.margin))
    check("pane click: a rounded corner of the page card outside it: passes", decide(CGPoint(x: 1503, y: 973), scene()) == .pass(.margin))
    // (Stacked: the 52 pt band above the lower pane isn't a hole.)
    let top = CGRect(x: 276, y: 41, width: 1228, height: 430), bottom = CGRect(x: 276, y: 531, width: 1228, height: 443)
    let stacked = PaneClickScene(panes: [.init(rect: top, pid: 501, window: 10), .init(rect: bottom, pid: 501, window: 20)], focused: 10,
                                 slot: Slot(rect: page, radius: 0, hits: [], holes: [top, bottom]), marginWindows: [5])
    check("pane click: stacked: the band between the panes passes (Margin's), the lower pane held",
          decide(CGPoint(x: 700, y: 500), stacked) == .pass(.margin) && decide(CGPoint(x: 700, y: 700), stacked) == .hold(.init(rect: bottom, pid: 501, window: 20)))
    check("pane click: no split up (no scene, no panes): passes", decide(inRight, nil) == .pass(.noPanes) && decide(inRight, PaneClickScene()) == .pass(.noPanes))
    check("pane click: the tap's own word ahead of Margin's (the window it just gave the keys): that pane passes, the other is held",
          decide(inRight, scene(), focused: .some(20)) == .pass(.focused) && decide(inLeft, scene(), focused: .some(20)) == .hold(.init(rect: left, pid: 501, window: 10)))
    check("pane click: nothing known to have the keys: a pane press is held (its window's read says)", decide(inLeft, scene(focused: nil)) == .hold(.init(rect: left, pid: 501, window: 10)))
    var noPid = scene()
    noPid.panes[1].pid = 0
    check("pane click: a pane whose app isn't known: passes", decide(inRight, noPid) == .pass(.margin))
    // Another window over the pane at the point (a menu or popup of any app, a sheet, the Dock, a banner): as before.
    coverAsks = 0
    let menu = PaneClickCover(window: 77, pid: 501, layer: 101)
    check("pane click: a menu or popup over the other pane at the point: passes as before (asked only for a press it would hold)",
          decide(inRight, scene(), cover: menu) == .covered(rightPane, menu) && coverAsks == 1)
    _ = decide(inLeft, scene(), cover: menu)
    _ = decide(CGPoint(x: 890, y: 500), scene(), cover: menu)
    _ = decide(inRight, scene(), flags: .maskCommand, cover: menu)
    check("pane click: …never read for a press that passes anyway (the focused pane, Margin's UI, ⌘)", coverAsks == 1)

    // A card open over the split (docs/PEEK-SPLIT.md §2): only the card's page counts; the dim around it is Margin's.
    let card = CGRect(x: 500, y: 150, width: 800, height: 700)
    let withCard = PaneClickScene(panes: [.init(rect: left, pid: 501, window: 10), .init(rect: right, pid: 501, window: 20), .init(rect: card, pid: 501, window: 30, card: true)],
                                  focused: 10, slot: Slot(rect: page, radius: 12, hits: [CGRect(x: 500, y: 110, width: 800, height: 40)], holes: [card]), marginWindows: [5])
    check("pane click: a card open: a press in its page with main's keys: held (the card's window)", decide(CGPoint(x: 900, y: 500), withCard) == .hold(.init(rect: card, pid: 501, window: 30, card: true)))
    check("pane click: …the dim around it (Margin's, it closes the card) and the card's bar: pass",
          decide(CGPoint(x: 300, y: 500), withCard) == .pass(.margin) && decide(CGPoint(x: 1400, y: 900), withCard) == .pass(.margin) && decide(CGPoint(x: 900, y: 120), withCard) == .pass(.margin))
    var cardOnly = withCard
    cardOnly.slot?.holes = nil
    check("pane click: …only the card's page counts even if a pane's rect is listed under it", decide(CGPoint(x: 300, y: 500), cardOnly) == .pass(.margin))
    var cardFocused = withCard
    cardFocused.focused = 30
    check("pane click: …the card with the keys: passes", decide(CGPoint(x: 900, y: 500), cardFocused) == .pass(.focused))
}

private func paneClickHoldTests() {
    func core(_ f: FakePaneFocus, _ said: PaneBox<[PaneClickResult]>) -> PaneClickCore {
        let c = PaneClickCore(focuser: f, report: { r in said.value.append(r) })
        c.update(scene())
        return c
    }
    func press(_ p: CGPoint, number: Int = 0, flags: CGEventFlags = []) -> PaneClickCore.Press { .init(point: p, flags: flags, number: number, otherButtons: false) }

    // ---- within one app (Safari and Safari): its window made its app's main one, no front app asked ----
    do {
        let f = FakePaneFocus(), said = PaneBox<[PaneClickResult]>([])
        let c = core(f, said)
        let t0 = f.clock
        let r = c.pressed(press(inRight, number: 41))
        check("pane click hold: in one app: its window made key (no front app asked), the press let go once it is, in about the time it took",
              f.log == ["focus 20"] && r?.outcome == .delivered(already: false) && r?.crossApp == false && r?.window == 20 && (r?.ms ?? 0) >= 6 && (r?.ms ?? 99) < 9
              && f.clock - t0 < 0.01 && said.value == [r!], "\(f.log) \(String(describing: r))")
        check("pane click hold: …its press claimed (the monitor's own path leaves it) once, by its event number", c.claimed(number: 41, at: .zero) && !c.claimed(number: 41, at: inRight))
        check("pane click hold: …a press it didn't hold isn't claimed", !c.claimed(number: 42, at: inRight))
    }
    // ---- across apps (Notes had the keys): its app made the front app too ----
    do {
        let f = FakePaneFocus(), said = PaneBox<[PaneClickResult]>([])
        f.front = 502
        f.focusedOf = [502: 99, 501: 10]
        let c = core(f, said)
        c.update(scene(rightPid: 501, focused: 99))
        let r = c.pressed(press(inRight))
        check("pane click hold: across apps: its app made the front app, its window made key, then let go", f.log == ["focus 20 frontmost"] && r?.outcome == .delivered(already: false) && r?.crossApp == true,
              "\(f.log) \(String(describing: r))")
    }
    // ---- key already (Margin's word behind): let go at once, nothing asked ----
    do {
        let f = FakePaneFocus(), said = PaneBox<[PaneClickResult]>([])
        f.focusedOf = [501: 20]
        let c = core(f, said)
        let r = c.pressed(press(inRight, number: 7))
        check("pane click hold: its window key already: let go at once, nothing asked, Margin told (its word was behind)",
              f.log.isEmpty && r?.outcome == .delivered(already: true) && f.keyReads == 1 && (r?.ms ?? 99) < 1 && c.claimed(number: 7, at: .zero), "\(f.log) \(String(describing: r))")
    }
    // ---- never key: the cap, then as before ----
    do {
        let f = FakePaneFocus(), said = PaneBox<[PaneClickResult]>([])
        f.keyAfter = nil
        let c = core(f, said)
        let t0 = f.clock
        let r = c.pressed(press(inRight, number: 9))
        let held = f.clock - t0
        check("pane click hold: not key within the cap (120 ms): let go as before, said, not claimed (the monitor's press focuses it the usual way)",
              r?.outcome == .notKey && held >= 0.12 && held < 0.122 && !c.claimed(number: 9, at: inRight) && said.value.count == 1 && f.log == ["focus 20"], "\(held) \(String(describing: r))")
        check("pane click hold: …the key read every 1 ms meanwhile (about 120 reads, never a busy loop)", f.keyReads > 80 && f.keyReads < 130, "\(f.keyReads)")
    }
    do {
        let f = FakePaneFocus(), said = PaneBox<[PaneClickResult]>([])
        f.unread = true
        let c = core(f, said)
        let r = c.pressed(press(inRight))
        check("pane click hold: Accessibility unreadable (its app busy): its app asked to the front too, then the cap, as before",
              f.log == ["focus 20 frontmost"] && r?.outcome == .notKey, "\(f.log) \(String(describing: r))")
    }
    // ---- covered, passes ----
    do {
        let f = FakePaneFocus(), said = PaneBox<[PaneClickResult]>([])
        f.cover = PaneClickCover(window: 77, pid: 501, layer: 101)
        let c = core(f, said)
        let r = c.pressed(press(inRight, number: 3))
        check("pane click hold: a menu over the pane at the point: let go at once, nothing asked, said (its window, pid, layer), not claimed",
              r?.outcome == .covered(PaneClickCover(window: 77, pid: 501, layer: 101)) && f.log.isEmpty && f.keyReads == 0 && !c.claimed(number: 3, at: inRight) && said.value.count == 1)
        f.cover = PaneClickCover(window: 6, pid: 1, layer: 0)
        check("pane click hold: …Margin's own windows over the panes never count as a cover", c.pressed(press(inRight))?.outcome == .delivered(already: false))
    }
    do {
        let f = FakePaneFocus(), said = PaneBox<[PaneClickResult]>([])
        let c = core(f, said)
        let none = [c.pressed(press(inLeft)), c.pressed(press(CGPoint(x: 890, y: 500))), c.pressed(press(inRight, flags: .maskCommand)), c.pressed(press(CGPoint(x: 100, y: 100)))]
        check("pane click hold: the focused pane, the divider, ⌘, the sidebar: let go untouched, nothing read, nothing said",
              none.allSatisfy { $0 == nil } && f.keyReads == 0 && f.coverAsks == 0 && f.log.isEmpty && said.value.isEmpty)
        c.update(nil)
        check("pane click hold: no split up any more (nil): every press passes", c.pressed(press(inRight)) == nil && f.log.isEmpty)
    }

    // ---- the pipe: events as the window server hands them through the tap (only presses reach it, each held in place) ----
    enum Event { case down(CGPoint, Int), drag(CGPoint), up(CGPoint) }
    func pipe(_ c: PaneClickCore, _ f: FakePaneFocus, _ events: [Event]) {
        for (i, e) in events.enumerated() {
            switch e {
            case .down(let p, let n): c.pressed(press(p, number: n)); f.log.append("down \(i)")
            case .drag: f.clock += 0.008; f.log.append("drag \(i)")
            case .up: f.clock += 0.008; f.log.append("up \(i)")
            }
        }
    }
    do {
        let f = FakePaneFocus(), said = PaneBox<[PaneClickResult]>([])
        let c = core(f, said)
        pipe(c, f, [.down(inRight, 11), .up(inRight), .down(inRight, 12), .up(inRight)])
        check("pane click pipe: a double-click in the other pane: its window key before the first press goes on, the second press straight through (no second focus), every event once and in order",
              f.log == ["focus 20", "down 0", "up 1", "down 2", "up 3"] && said.value.count == 1 && c.claimed(number: 11, at: .zero) && !c.claimed(number: 12, at: .zero), "\(f.log)")
    }
    do {
        let f = FakePaneFocus(), said = PaneBox<[PaneClickResult]>([])
        let c = core(f, said)
        pipe(c, f, [.down(inRight, 1), .drag(CGPoint(x: 1210, y: 510)), .drag(CGPoint(x: 1300, y: 600)), .drag(CGPoint(x: 1400, y: 700)), .up(CGPoint(x: 1400, y: 700))])
        check("pane click pipe: a drag from the other pane (text selection): held at its press only, every drag and the release after it, in order",
              f.log == ["focus 20", "down 0", "drag 1", "drag 2", "drag 3", "up 4"], "\(f.log)")
    }
    do {
        let f = FakePaneFocus(), said = PaneBox<[PaneClickResult]>([])
        let c = core(f, said)
        pipe(c, f, [.down(inRight, 1), .up(inRight)])
        // (Margin's word still the old one, a hole's change published before its bookkeeping: the window given the keys still counts.)
        c.update(scene(focused: 10))
        pipe(c, f, [.down(inRight, 2), .up(inRight)])
        check("pane click pipe: a scene published before Margin's word caught up: the window just given the keys still has them (no second focus)", f.log.filter { $0.hasPrefix("focus") } == ["focus 20"], "\(f.log)")
        c.update(scene(focused: 20))
        pipe(c, f, [.down(inLeft, 3), .up(inLeft)])
        check("pane click pipe: Margin's word caught up, then a click back in the first pane: that one held and made key", f.log.filter { $0.hasPrefix("focus") } == ["focus 20", "focus 10"], "\(f.log)")
        f.clock += 3
        c.update(scene(focused: 20))
        f.focusedOf[501] = 10
        pipe(c, f, [.down(inLeft, 4)])
        check("pane click pipe: …its own word only for 2 s: after that Margin's again", f.log.filter { $0.hasPrefix("focus") } == ["focus 20", "focus 10"] && said.value.last?.outcome == .delivered(already: true), "\(f.log)")
    }
    // ---- the claims: by number, by point when there's none, gone after a second ----
    do {
        let f = FakePaneFocus(), said = PaneBox<[PaneClickResult]>([])
        let c = core(f, said)
        c.pressed(press(inRight, number: 0))
        check("pane click claims: a press with no event number matched by its point (within 4 pt), once", !c.claimed(number: 0, at: CGPoint(x: 1210, y: 500)) && c.claimed(number: 0, at: CGPoint(x: 1202, y: 502)) && !c.claimed(number: 0, at: inRight))
        c.update(scene(focused: 10))
        f.clock += 3
        c.pressed(press(inRight, number: 5))
        f.clock += 1.5
        check("pane click claims: one never heard by the monitor forgotten after a second", !c.claimed(number: 5, at: inRight))
    }
    // ---- the panes' elements looked up ahead as the panes change, not for a focus change ----
    do {
        let f = FakePaneFocus()
        let c = PaneClickCore(focuser: f, report: { _ in })
        c.update(scene())
        c.update(scene(focused: 20))
        c.update(nil)
        check("pane click: the panes' windows warmed as they change (not at a focus change), dropped with the split", f.warmed == [[10, 20], []], "\(f.warmed)")
    }
    let buttons: [CGEventType] = [.leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown, .rightMouseUp, .rightMouseDragged, .otherMouseDown, .otherMouseUp, .otherMouseDragged]
    let never: [CGEventType] = [.mouseMoved, .scrollWheel, .keyDown, .keyUp, .flagsChanged]
    check("pane click tap: its mask is every button's presses, drags and releases (a cut pane's press goes on as records); moves, scrolls and keys never reach it",
          buttons.allSatisfy { PaneClickTap.mask & (CGEventMask(1) << CGEventMask($0.rawValue)) != 0 } && never.allSatisfy { PaneClickTap.mask & (CGEventMask(1) << CGEventMask($0.rawValue)) == 0 })
    // (The monitor's press is matched by its event number: AppKit's eventNumber is the event's mouseEventNumber. Made
    // here, never posted.)
    if let cg = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: CGPoint(x: 10, y: 10), mouseButton: .left) {
        cg.setIntegerValueField(.mouseEventNumber, value: 4321)
        check("pane click claims: a press's AppKit event number is its mouseEventNumber (how the monitor's press is matched)", NSEvent(cgEvent: cg)?.eventNumber == 4321,
              "\(String(describing: NSEvent(cgEvent: cg)?.eventNumber))")
    } else { check("pane click claims: (a press event made)", false) }
    // What a press that passes costs the tap (the common case: a click in the focused pane, on Margin's own UI).
    do {
        let f = FakePaneFocus()
        let c = PaneClickCore(focuser: f, report: { _ in })
        c.update(scene())
        let n = 200_000
        let t0 = Date()
        for i in 0..<n { _ = c.pressed(press(i % 2 == 0 ? inLeft : CGPoint(x: 890, y: 500))) }
        let us = Date().timeIntervalSince(t0) / Double(n) * 1e6
        print("  (pane click: a press that passes (the focused pane, the divider) costs \(String(format: "%.2f", us)) µs in the tap's decision on the stand-in, \(n) presses; nothing read, nothing said)")
        check("pane click: a press that passes costs the tap's decision under 20 µs (the stand-in)", us < 20 && f.keyReads == 0 && f.coverAsks == 0, "\(us)")
    }
}

// The engine's side of a press the tap focused: Margin's word follows (the one shown, the holes' focus), nothing fronted.
// All panes active (PanesActive.swift): a press on a pane whose app is kept active by records (AppKit in it says it's
// active, its pane's window focused: Accessibility reads "key already") while the window server's front process is
// another app: never "key already"; the window server makes it the front one (AppKit's own activation may be taken for
// done), Accessibility its window main and raised, and the press goes on once the window server says so.
private func paneClickKeptTests() {
    func press(_ p: CGPoint, number: Int = 0) -> PaneClickCore.Press { .init(point: p, flags: [], number: number, otherButtons: false) }
    func kept(_ pids: Set<pid_t>, focused: Int? = 10) -> PaneClickScene { var s = scene(rightPid: 502, focused: focused); s.kept = pids; return s }
    func focuser(server: pid_t?, front: pid_t, active: Set<pid_t>) -> FakePaneFocus {
        let f = FakePaneFocus()
        f.front = front
        f.serverFront = server
        f.axActive = active
        f.focusedOf = [501: 10, 502: 20]
        return f
    }
    // ---- the window server reads: Notes (502) kept active, TextEdit (501) the front one ----
    do {
        let f = focuser(server: 501, front: 501, active: [502]), said = PaneBox<[PaneClickResult]>([])
        let c = PaneClickCore(focuser: f, report: { said.value.append($0) })
        c.update(kept([502]))
        let r = c.pressed(press(inRight, number: 5))
        check("pane click kept: a press on a kept app's pane (Accessibility: active, its window focused): not 'key already'; the window server makes it the front one, then its window main and raised (no AXFrontmost), let go once the window server says so",
              f.log == ["makeFront 20", "focus 20"] && r?.outcome == .delivered(already: false) && r?.crossApp == true && r?.server == true && f.serverFront == 502 && c.claimed(number: 5, at: .zero),
              "\(f.log) \(String(describing: r))")
    }
    // ---- the kept set not told to the tap yet: Accessibility and the window server disagree ----
    do {
        let f = focuser(server: 501, front: 501, active: [502]), said = PaneBox<[PaneClickResult]>([])
        let c = PaneClickCore(focuser: f, report: { said.value.append($0) })
        c.update(kept([]))
        let r = c.pressed(press(inRight))
        check("pane click kept: an app that says it's active while the window server's front one is another (the tap not told yet): the window server's way too",
              f.log == ["makeFront 20", "focus 20"] && r?.server == true && r?.outcome == .delivered(already: false), "\(f.log) \(String(describing: r))")
    }
    // ---- the window server unread: the kept set alone says it isn't the front one ----
    do {
        let f = focuser(server: nil, front: 501, active: [502]), said = PaneBox<[PaneClickResult]>([])
        let c = PaneClickCore(focuser: f, report: { said.value.append($0) })
        c.update(kept([502]))
        let r = c.pressed(press(inRight))
        check("pane click kept: the window server unread, the app kept: never 'key already' (made the front one; unconfirmed: the cap, then let go as before)",
              f.log.first == "makeFront 20" && r?.outcome == .notKey && r?.server == true, "\(f.log) \(String(describing: r))")
    }
    // ---- the front app's own pane: still the fast path ----
    do {
        let f = focuser(server: 502, front: 502, active: [501]), said = PaneBox<[PaneClickResult]>([])
        let c = PaneClickCore(focuser: f, report: { said.value.append($0) })
        c.update(kept([501], focused: 10))
        let r = c.pressed(press(inRight))
        check("pane click kept: a press on the front app's own pane (Margin's word behind): key already for both Accessibility and the window server, nothing asked",
              f.log.isEmpty && r?.outcome == .delivered(already: true), "\(f.log) \(String(describing: r))")
    }
    // ---- an app not kept, across apps: AXFrontmost as before ----
    do {
        let f = focuser(server: 501, front: 501, active: []), said = PaneBox<[PaneClickResult]>([])
        let c = PaneClickCore(focuser: f, report: { said.value.append($0) })
        c.update(kept([]))
        let r = c.pressed(press(inRight))
        check("pane click kept: an app not kept, across apps: made the front one by Accessibility, as before (the window server's way never asked)",
              f.log == ["focus 20 frontmost"] && r?.server == false && r?.outcome == .delivered(already: false) && f.serverFront == 502, "\(f.log) \(String(describing: r))")
    }
    // ---- a press at no finite point (a make-key record's) ----
    check("pane click kept: a press at no finite point (a make-key record's, never a person's) passes",
          PaneClick.decide(CGPoint(x: CGFloat.nan, y: CGFloat.nan), flags: [], otherButtons: false, scene: scene(rightPid: 502), focused: 10) { _ in nil } == .pass(.margin))
}

private func paneClickEngineTests() {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-pane-click-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let placement = HostPlacement(page: page, area: FakeHostWorld.display)
    let textEdit = HostTarget.app("com.apple.TextEdit"), notes = HostTarget.app("com.apple.Notes")
    let w = FakeHostWorld()
    w.tilesOn = true
    let e = HostEngine(system: w, marker: folder.appendingPathComponent(HostMarker.fileName), pid: 1)
    e.options.privateRetire = 0
    e.options.earlyFullScreen = false
    var told: [[HostShownWindow]] = []
    e.hostedWindows = { told.append($0) }
    _ = hostRun { await e.open(app: textEdit, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
    _ = hostRun { await e.setLayout(main: textEdit, mainRect: left, extras: [HostExtra(target: notes, role: .pane, rect: right)], focused: textEdit.id, in: placement,
                                    marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
    let n = e.hosts[notes.id]?.window ?? 0
    check("pane click engine: (a split of TextEdit and Notes, TextEdit focused)", e.shown == textEdit.id && e.visible.count == 2 && n > 0)
    var mark = w.calls.count
    let done = hostRun { await e.focus(notes.id, fronted: true) } ?? false
    let calls = Array(w.calls.dropFirst(mark))
    check("pane click engine: a press the tap focused: Notes the one shown from now, nothing fronted (no app made the front one, no window raised)",
          done && e.shown == notes.id && !calls.contains { $0.hasPrefix("activate") || $0.hasPrefix("frontmost") }, "\(calls)")
    check("pane click engine: …Margin's window told Notes' window has the focus (its holes, its order above it)", told.last?.first { $0.window == n }?.focused == true, "\(String(describing: told.last))")
    mark = w.calls.count
    _ = hostRun { await e.focus(textEdit.id) }
    check("pane click engine: a press the usual way (the tap off, or its focus not in time): the visible ones fronted as before", w.calls.dropFirst(mark).contains { $0.hasPrefix("activate") } && e.shown == textEdit.id,
          "\(w.calls.dropFirst(mark))")
}


// A cut pane under another (docs/PEEK-SPLIT.md §4b): the right pane's window (20, Notes' 700 at 804…1504) lies under the
// left pane: every press on it, its drags and its release are delivered to its window as records (never routed: routed,
// its window would be raised over the left pane), after its window is made key without a raise when it isn't.
private func paneClickTuckTests() {
    func tucked(focused: Int? = 10) -> PaneClickScene {
        var sc = scene(rightPid: 502, focused: focused)
        sc.panes[1].tucked = true
        sc.panes[1].frame = CGRect(x: 804, y: 41, width: 700, height: 933)
        return sc
    }
    func ev(_ t: CGEventType, _ p: CGPoint, _ b: CGMouseButton = .left) -> CGEvent { CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: b)! }
    let inRight = CGPoint(x: 1200, y: 500), inLeft = CGPoint(x: 500, y: 500)
    // The decision: tucked even with the keys or ⌘ held; covered by another window there: let go as before.
    let d = PaneClick.decide(inRight, flags: .maskCommand, otherButtons: false, scene: tucked(focused: 20), focused: 20) { _ in nil }
    check("pane click tuck: a press on a cut pane under another is taken (its window's as records), with the keys and ⌘ held too", d == .tuck(tucked().panes[1]), "\(d)")
    let covered = PaneClickCover(window: 99, pid: 9, layer: 101)
    let dc = PaneClick.decide(inRight, flags: [], otherButtons: false, scene: tucked(), focused: 10) { _ in covered }
    check("pane click tuck: …a window over it there (a menu): let go as before", dc == .covered(tucked().panes[1], covered), "\(dc)")
    check("pane click tuck: a press on the other pane: as before", PaneClick.decide(inLeft, flags: [], otherButtons: false, scene: tucked(), focused: 20) { _ in nil } == .hold(tucked().panes[0]))
    // A click: its window key without a raise, then the press, its drags and the release delivered (at its window's
    // own point), each taken; then a drag that isn't its own goes on.
    let f = FakePaneFocus()
    f.origins[20] = CGPoint(x: 804, y: 41)
    let results = PaneBox<[PaneClickResult]>([])
    let core = PaneClickCore(focuser: f, report: { results.value.append($0) })
    core.update(tucked())
    let tookDown = core.event(.leftMouseDown, ev(.leftMouseDown, inRight))
    let tookDrag = core.event(.leftMouseDragged, ev(.leftMouseDragged, CGPoint(x: 1210, y: 500)))
    let tookUp = core.event(.leftMouseUp, ev(.leftMouseUp, CGPoint(x: 1210, y: 500)))
    let tookAfter = core.event(.leftMouseDragged, ev(.leftMouseDragged, inLeft))
    check("pane click tuck: its window made key without a raise (never Accessibility's raising focus), then the press, a drag and the release delivered at its window's point, each taken",
          tookDown && tookDrag && tookUp && f.log == ["focusWithoutRaise 20", "deliver 1 to 20 at 396,459", "deliver 6 to 20 at 406,459", "deliver 2 to 20 at 406,459"], "\(f.log)")
    check("pane click tuck: …once released, the next drag goes on as it came", !tookAfter, "\(tookAfter)")
    check("pane click tuck: …said once, delivered, its app made the front one (Margin's bookkeeping follows, nothing fronted)",
          results.value.count == 1 && results.value[0].tucked && results.value[0].outcome == .delivered(already: false) && results.value[0].crossApp, "\(results.value)")
    // Its window key already: nothing asked, delivered at once.
    f.log = []
    _ = core.event(.leftMouseDown, ev(.leftMouseDown, inRight))
    _ = core.event(.leftMouseUp, ev(.leftMouseUp, inRight))
    check("pane click tuck: its window key already: no focus asked, the click delivered", f.log == ["deliver 1 to 20 at 396,459", "deliver 2 to 20 at 396,459"], "\(f.log)")
    // A right click on it too (a context menu), its own button's release only.
    f.log = []
    let rd = core.event(.rightMouseDown, ev(.rightMouseDown, inRight, .right))
    let leftUpMeanwhile = core.event(.leftMouseUp, ev(.leftMouseUp, inRight))
    let ru = core.event(.rightMouseUp, ev(.rightMouseUp, inRight, .right))
    check("pane click tuck: a right click on it delivered too; another button's release meanwhile goes on", rd && ru && !leftUpMeanwhile && f.log == ["deliver 3 to 20 at 396,459", "deliver 4 to 20 at 396,459"], "\(f.log)")
    // Not a tucked pane: a right press goes on, untouched.
    f.log = []
    core.update(scene(rightPid: 502))
    check("pane click tuck: a right press on a pane that isn't cut goes on untouched", !core.event(.rightMouseDown, ev(.rightMouseDown, inRight, .right)) && f.log.isEmpty, "\(f.log)")
    // No records (delivery refused): the press routed as before (held, focused the usual way).
    let g = FakePaneFocus()
    g.delivers = false
    let core2 = PaneClickCore(focuser: g, report: { _ in })
    core2.update(tucked())
    let routed = core2.event(.leftMouseDown, ev(.leftMouseDown, inRight))
    check("pane click tuck: no records: the press goes on as before (not taken)", !routed && g.log.first == "focusWithoutRaise 20", "\(routed) \(g.log)")
}
