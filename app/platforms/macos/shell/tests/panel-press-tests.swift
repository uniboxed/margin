// A press on Margin's own panel never takes the keyboard from the hosted app (docs/SIDEBAR-PRESS.md, GitHub #29), part
// of pane-click-tests.swift's run: which presses the press tap delivers to Margin's panel (the core's way over the
// scene's copy of the slot: Margin's UI, an app shown, no field of Margin's; never through the hole, the window's own
// buttons, outside, with another button held, covered by another window, with no records); the pipe of a press, its
// drags and its release delivered in order at the panel's own points and taken, then the next drag going on; a right
// click; another button pressed meanwhile; a stale press under way dropped; a split's divider delivered while a pane's
// press is still held; and the claim `pressEnded` reads. The tap's life in a real Margin window is e2e-glue.swift's.
import AppKit
import Foundation

// One Margin window's panel (number 6, Margin's pid 300) over a 1512×982 content at 0,33: the page area a hole at
// 276,41 1228×933 with its rounded corners (the sidebar and the frame Margin's), an app shown, no field of Margin's.
private let content = CGRect(x: 0, y: 33, width: 1512, height: 949)
private let hole = CGRect(x: 276, y: 41, width: 1228, height: 933)
private func panel(keysStay: Bool = true, slot: Slot? = Slot(rect: hole, radius: 12), controls: CGRect? = nil, fullScreen: Bool = true) -> PaneClickScene.Panel {
    PaneClickScene.Panel(window: 6, pid: 300, content: content, slot: slot, controls: controls, fullScreen: fullScreen, keysStay: keysStay)
}
private func panelScene(_ p: PaneClickScene.Panel = panel()) -> PaneClickScene {
    var s = PaneClickScene()
    s.panels = [p]
    s.marginWindows = [5, 6, 7]
    return s
}
private let inSidebar = CGPoint(x: 120, y: 500), inPage = CGPoint(x: 900, y: 500)

func panelPressTests() {
    panelPressDecisionTests()
    panelPressPipeTests()
    panelEventTests()
    panelTapLineTests()
}

// One tap, two modes said apart (the screen suite reads them: PaneClicks.swift `splitWith`): `pane clicks: on` only
// while the tap runs and its scene has a split's panes, `off` once either is over, each once. A tap made, never started:
// its thread's word (`splitSaid(running:)`) given by hand.
private func panelTapLineTests() {
    let lines = PaneBox<[String]>([])
    let tap = PaneClickTap(core: PaneClickCore(focuser: FakePaneFocus(), report: { _ in }), said: { lines.value.append($0) })
    let left = CGRect(x: 276, y: 41, width: 610, height: 933), right = CGRect(x: 894, y: 41, width: 610, height: 933)
    var split = PaneClickScene(panes: [.init(rect: left, pid: 501, window: 10), .init(rect: right, pid: 502, window: 20)], focused: 10, slot: Slot(rect: hole, radius: 12, holes: [left, right]))
    split.panels = [panel()]
    tap.update(panelScene())
    tap.update(split)
    let beforeRunning = lines.value
    tap.splitSaid(running: true)
    let started = lines.value
    tap.update(split)
    tap.update(panelScene())
    let alone = lines.value
    tap.update(split)
    tap.stop()
    let stopped = lines.value
    check("press tap: `pane clicks: on` only once it runs with a split's panes (not for the sidebar alone, not before it runs), said once; `off` as the split goes and as the tap stops",
          beforeRunning.isEmpty && started.count == 1 && started[0].hasPrefix("pane clicks: on (")
            && alone.count == 2 && alone[1].hasPrefix("pane clicks: off (") && stopped.count == 4 && stopped[2].hasPrefix("pane clicks: on (") && stopped[3].hasPrefix("pane clicks: off ("),
          "\(stopped)")
}

// The event made afresh for the panel (PaneClickTap.swift `PanelEvents`): the press's own public fields, the panel's
// window and its point there; never the window server's record (which keyed the panel and took Margin for active in
// AppKit on the real screen, 2026-11-24). Made here, never posted.
private func panelEventTests() {
    func ev(_ t: CGEventType, _ p: CGPoint, _ b: CGMouseButton = .left) -> CGEvent { CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: b)! }
    let down = ev(.leftMouseDown, inSidebar)
    down.setIntegerValueField(.mouseEventClickState, value: 2)
    down.setIntegerValueField(.mouseEventNumber, value: 41)
    down.flags = [.maskShift]
    let made = PanelEvents.make(from: down, window: 6, content: content)
    let ns = made.flatMap { NSEvent(cgEvent: $0) }
    check("panel event: a press made afresh for the panel: its type, the panel's window, its click count, its event number (how pressEnded knows it), its modifiers",
          ns?.type == .leftMouseDown && ns?.windowNumber == 6 && ns?.clickCount == 2 && ns?.eventNumber == 41 && ns?.modifierFlags.contains(.shift) == true && made !== down,
          "\(String(describing: ns))")
    check("panel event: …its point in the panel (AppKit's, from its bottom left): the press's less the content's top left",
          ns.map { abs($0.locationInWindow.x - 120) < 0.5 && abs($0.locationInWindow.y - (content.height - 467)) < 0.5 } == true,
          "\(String(describing: ns?.locationInWindow))")
    let other = ev(.otherMouseDown, inSidebar, .center)
    other.setIntegerValueField(.mouseEventButtonNumber, value: 3)
    let drag = ev(.leftMouseDragged, inSidebar)
    drag.setIntegerValueField(.mouseEventDeltaX, value: 7)
    drag.setIntegerValueField(.mouseEventDeltaY, value: -4)
    let madeOther = PanelEvents.make(from: other, window: 6, content: content), madeDrag = PanelEvents.make(from: drag, window: 6, content: content)
    check("panel event: another button's press keeps its button (a mouse's fourth), a drag its movement",
          madeOther?.getIntegerValueField(.mouseEventButtonNumber) == 3 && madeOther?.type == .otherMouseDown
            && madeDrag?.getIntegerValueField(.mouseEventDeltaX) == 7 && madeDrag?.getIntegerValueField(.mouseEventDeltaY) == -4 && madeDrag?.type == .leftMouseDragged)
    let key = CGEvent(keyboardEventSource: nil, virtualKey: 7, keyDown: true)!
    check("panel event: never a key, a move or a scroll; never for no window", PanelEvents.make(from: key, window: 6, content: content) == nil
          && PanelEvents.make(from: ev(.mouseMoved, inSidebar), window: 6, content: content) == nil && PanelEvents.make(from: down, window: 0, content: content) == nil
          && !PanelEvents.post(down, pid: 0, window: 6, content: content))
}

private func panelPressDecisionTests() {
    func target(_ p: CGPoint, _ s: PaneClickScene?, buttons: Bool = false) -> Int? { PanelPress.target(p, scene: s, otherButtons: buttons)?.window }
    check("panel press: a press on the sidebar, an app shown and no field of Margin's: Margin's panel's, the keyboard staying (the core's way: ui)",
          target(inSidebar, panelScene()) == 6 && PanelPress.way(inSidebar, panel()) == .ui)
    check("panel press: …the frame beside the page area and over its rounded corner: the panel's too",
          target(CGPoint(x: 1508, y: 500), panelScene()) == 6 && target(CGPoint(x: 277, y: 42), panelScene()) == 6)
    check("panel press: a press through the hole (the hosted app's): as before", target(inPage, panelScene()) == nil && PanelPress.way(inPage, panel()) == .through)
    check("panel press: a field of Margin's has the keys (the palette, a rename): as before (routed)",
          target(inSidebar, panelScene(panel(keysStay: false))) == nil && PanelPress.way(inSidebar, panel(keysStay: false)) == .routed)
    check("panel press: outside the window's content: as before", target(CGPoint(x: 100, y: 10), panelScene()) == nil && PanelPress.way(CGPoint(x: 100, y: 10), panel()) == .outside)
    check("panel press: another button held: as before", target(inSidebar, panelScene(), buttons: true) == nil)
    check("panel press: no scene, no panel in it: as before", target(inSidebar, nil) == nil && target(inSidebar, PaneClickScene()) == nil)
    // Windowed: the window's own buttons under the theme's controls are the base window's.
    let controls = CGRect(x: 10, y: 10, width: 60, height: 16)
    check("panel press: windowed, on the window's own buttons (under the theme's controls): as before; full screen there: the panel's",
          target(CGPoint(x: 20, y: 51), panelScene(panel(controls: controls, fullScreen: false))) == nil
          && target(CGPoint(x: 20, y: 51), panelScene(panel(controls: controls, fullScreen: true))) == 6)
    check("panel press: no slot (nothing shows through): the panel's everywhere in its content", target(inPage, panelScene(panel(slot: nil))) == 6)
    // Two Margin windows (two displays): the one whose content holds the point.
    var two = panelScene()
    two.panels.append(PaneClickScene.Panel(window: 16, pid: 300, content: CGRect(x: 1512, y: 0, width: 1920, height: 1080), slot: nil, controls: nil, fullScreen: true, keysStay: true))
    check("panel press: two Margin windows: the press's own one", target(CGPoint(x: 1600, y: 500), two) == 16 && target(inSidebar, two) == 6)
}

private func panelPressPipeTests() {
    func ev(_ t: CGEventType, _ p: CGPoint, _ b: CGMouseButton = .left, number: Int64 = 0) -> CGEvent {
        let e = CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: b)!
        if number != 0 { e.setIntegerValueField(.mouseEventNumber, value: number) }
        return e
    }
    // A click on the sidebar: the press, a drag (out over the page area too) and the release delivered to the panel at
    // its own points (the content's top left its origin), each taken; the next drag goes on as it came.
    let f = FakePaneFocus()
    let core = PaneClickCore(focuser: f, report: { _ in })
    core.buttonHeld = { _ in true }
    core.update(panelScene())
    let down = core.event(.leftMouseDown, ev(.leftMouseDown, inSidebar, number: 41))
    let drag = core.event(.leftMouseDragged, ev(.leftMouseDragged, CGPoint(x: 130, y: 510)))
    let dragOut = core.event(.leftMouseDragged, ev(.leftMouseDragged, inPage))
    let up = core.event(.leftMouseUp, ev(.leftMouseUp, CGPoint(x: 130, y: 510), number: 41))
    let after = core.event(.leftMouseDragged, ev(.leftMouseDragged, inSidebar))
    check("panel press: a click on the sidebar: the press, its drags (one out over the page area) and its release delivered to Margin's panel at the panel's own points, in order, each taken",
          down && drag && dragOut && up && f.log == ["panel 1 to 6 at 120,467", "panel 6 to 6 at 130,477", "panel 6 to 6 at 900,467", "panel 2 to 6 at 130,477"], "\(f.log)")
    check("panel press: …the window server's list read once, for the press (whatever's over the panel there)", f.coverAsks == 1, "\(f.coverAsks)")
    check("panel press: …once released, the next drag goes on as it came", !after)
    check("panel press: …the claim pressEnded reads: its number, once", core.claimedPanel(number: 41) && !core.claimedPanel(number: 41) && core.panelPresses == 1)
    check("panel press: …nothing reported as a pane's press (the split's bookkeeping untouched)", f.log.allSatisfy { !$0.hasPrefix("focus") })
    // A press through the hole: not taken, nothing delivered, no list read.
    f.log = []
    let asksBefore = f.coverAsks
    check("panel press: a press through the hole: goes on as it came (the hosted app's), nothing delivered, nothing read",
          !core.event(.leftMouseDown, ev(.leftMouseDown, inPage)) && !core.event(.leftMouseUp, ev(.leftMouseUp, inPage)) && f.log.isEmpty && f.coverAsks == asksBefore, "\(f.log)")
    // A right click on the sidebar (its menu): delivered too.
    f.log = []
    let rd = core.event(.rightMouseDown, ev(.rightMouseDown, inSidebar, .right))
    let ru = core.event(.rightMouseUp, ev(.rightMouseUp, inSidebar, .right))
    check("panel press: a right click on the sidebar (its menu): delivered and taken", rd && ru && f.log == ["panel 3 to 6 at 120,467", "panel 4 to 6 at 120,467"], "\(f.log)")
    // Another button pressed during a press on the panel: the panel's too; the press under way ends with the last.
    f.log = []
    let a = core.event(.leftMouseDown, ev(.leftMouseDown, inSidebar))
    let b = core.event(.rightMouseDown, ev(.rightMouseDown, inPage, .right))
    let c = core.event(.leftMouseUp, ev(.leftMouseUp, inSidebar))
    let d = core.event(.rightMouseDragged, ev(.rightMouseDragged, inPage, .right))
    let e = core.event(.rightMouseUp, ev(.rightMouseUp, inPage, .right))
    let g = core.event(.leftMouseDragged, ev(.leftMouseDragged, inSidebar))
    check("panel press: another button's press during one on the panel: the panel's too, the press under way over at the last release",
          a && b && c && d && e && !g && f.log == ["panel 1 to 6 at 120,467", "panel 3 to 6 at 900,467", "panel 2 to 6 at 120,467", "panel 7 to 6 at 900,467", "panel 4 to 6 at 900,467"], "\(f.log)")
    // A press under way whose release the tap never heard (macOS turned it off a moment): dropped at the next press,
    // which is decided afresh.
    f.log = []
    _ = core.event(.leftMouseDown, ev(.leftMouseDown, inSidebar))
    core.buttonHeld = { _ in false }
    let fresh = core.event(.leftMouseDown, ev(.leftMouseDown, inPage))
    let freshUp = core.event(.leftMouseUp, ev(.leftMouseUp, inPage))
    check("panel press: a press under way whose release was never heard: dropped at the next press, decided afresh (through the hole: as it came)",
          !fresh && !freshUp && f.log == ["panel 1 to 6 at 120,467"], "\(f.log)")
    core.buttonHeld = { _ in true }
    // Covered there by another window (a hosted app's menu, the Dock, a notification): as before.
    f.log = []
    f.cover = PaneClickCover(window: 99, pid: 9, layer: 101)
    check("panel press: another window over the panel at the point: goes on as it came (that window's), nothing delivered",
          !core.event(.leftMouseDown, ev(.leftMouseDown, inSidebar)) && !core.event(.leftMouseUp, ev(.leftMouseUp, inSidebar)) && f.log.isEmpty, "\(f.log)")
    f.cover = nil
    // A field of Margin's has the keys: as before (routed: the panel takes the press and keeps the keys).
    core.update(panelScene(panel(keysStay: false)))
    check("panel press: a field of Margin's has the keys: goes on as it came", !core.event(.leftMouseDown, ev(.leftMouseDown, inSidebar)) && f.log.isEmpty, "\(f.log)")
    _ = core.event(.leftMouseUp, ev(.leftMouseUp, inSidebar))
    // No records (delivery refused): as before, today's hand-back after it.
    let h = FakePaneFocus()
    h.panelDelivers = false
    let core2 = PaneClickCore(focuser: h, report: { _ in })
    core2.buttonHeld = { _ in true }
    core2.update(panelScene())
    check("panel press: its delivery refused (no such process): the press goes on as it came (routed, handed back as before), nothing claimed",
          !core2.event(.leftMouseDown, ev(.leftMouseDown, inSidebar, number: 9)) && !core2.event(.leftMouseUp, ev(.leftMouseUp, inSidebar, number: 9)) && !core2.claimedPanel(number: 9))
    // A split up: the divider (Margin's) delivered to the panel; a press in the pane without the keys still held.
    let left = CGRect(x: 276, y: 41, width: 610, height: 933), right = CGRect(x: 894, y: 41, width: 610, height: 933)
    let divider = CGRect(x: 886, y: 41, width: 8, height: 933)
    var split = PaneClickScene(panes: [.init(rect: left, pid: 501, window: 10), .init(rect: right, pid: 502, window: 20)], focused: 10,
                               slot: Slot(rect: hole, radius: 12, hits: [divider], holes: [left, right]), marginWindows: [5, 6, 7])
    split.panels = [panel(slot: split.slot)]
    let k = FakePaneFocus()
    let core3 = PaneClickCore(focuser: k, report: { _ in })
    core3.buttonHeld = { _ in true }
    core3.update(split)
    let onDivider = core3.event(.leftMouseDown, ev(.leftMouseDown, CGPoint(x: 890, y: 500)))
    _ = core3.event(.leftMouseUp, ev(.leftMouseUp, CGPoint(x: 890, y: 500)))
    k.log = []
    let inOther = core3.event(.leftMouseDown, ev(.leftMouseDown, CGPoint(x: 1200, y: 500)))
    check("panel press: a split up: a press on its divider (Margin's) delivered to the panel; one in the pane without the keys still held while its window is made key, then let go",
          onDivider && !inOther && k.log.first == "focus 20 frontmost", "\(k.log)")
    _ = core3.event(.leftMouseUp, ev(.leftMouseUp, CGPoint(x: 1200, y: 500)))
    // What the tap's own work costs per event (the stand-in's delivery and window list: the record posted and the window
    // server's list are the OS's, timed apart): a click on the sidebar (its press and release, taken), a click through
    // the hole (passed), and a drag of a press it took.
    do {
        let s = FakePaneFocus()
        let c = PaneClickCore(focuser: s, report: { _ in })
        c.buttonHeld = { _ in true }
        c.update(panelScene())
        let n = 50_000
        let down = ev(.leftMouseDown, inSidebar, number: 5), up = ev(.leftMouseUp, inSidebar, number: 5), drag = ev(.leftMouseDragged, inSidebar)
        let through = ev(.leftMouseDown, inPage), throughUp = ev(.leftMouseUp, inPage)
        func per(_ body: () -> Void) -> Double {
            let t0 = Date()
            for _ in 0..<n { body() }
            return Date().timeIntervalSince(t0) / Double(n) * 1e6
        }
        let click = per { _ = c.event(.leftMouseDown, down); _ = c.event(.leftMouseUp, up); s.log.removeAll(keepingCapacity: true) }
        let pass = per { _ = c.event(.leftMouseDown, through); _ = c.event(.leftMouseUp, throughUp) }
        _ = c.event(.leftMouseDown, down)
        let drags = per { _ = c.event(.leftMouseDragged, drag); s.log.removeAll(keepingCapacity: true) }
        _ = c.event(.leftMouseUp, up)
        print("  (panel press: the tap's own work on the stand-in: a sidebar click (press and release taken) \(String(format: "%.2f", click)) µs, a click through the hole (passed) \(String(format: "%.2f", pass)) µs, a drag of a press it took \(String(format: "%.2f", drags)) µs per event; \(n) each)")
    }
}
