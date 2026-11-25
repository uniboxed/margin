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
          down && drag && dragOut && up && f.log == ["deliver 1 to 6 at 120,467", "deliver 6 to 6 at 130,477", "deliver 6 to 6 at 900,467", "deliver 2 to 6 at 130,477"], "\(f.log)")
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
    check("panel press: a right click on the sidebar (its menu): delivered and taken", rd && ru && f.log == ["deliver 3 to 6 at 120,467", "deliver 4 to 6 at 120,467"], "\(f.log)")
    // Another button pressed during a press on the panel: the panel's too; the press under way ends with the last.
    f.log = []
    let a = core.event(.leftMouseDown, ev(.leftMouseDown, inSidebar))
    let b = core.event(.rightMouseDown, ev(.rightMouseDown, inPage, .right))
    let c = core.event(.leftMouseUp, ev(.leftMouseUp, inSidebar))
    let d = core.event(.rightMouseDragged, ev(.rightMouseDragged, inPage, .right))
    let e = core.event(.rightMouseUp, ev(.rightMouseUp, inPage, .right))
    let g = core.event(.leftMouseDragged, ev(.leftMouseDragged, inSidebar))
    check("panel press: another button's press during one on the panel: the panel's too, the press under way over at the last release",
          a && b && c && d && e && !g && f.log == ["deliver 1 to 6 at 120,467", "deliver 3 to 6 at 900,467", "deliver 2 to 6 at 120,467", "deliver 7 to 6 at 900,467", "deliver 4 to 6 at 900,467"], "\(f.log)")
    // A press under way whose release the tap never heard (macOS turned it off a moment): dropped at the next press,
    // which is decided afresh.
    f.log = []
    _ = core.event(.leftMouseDown, ev(.leftMouseDown, inSidebar))
    core.buttonHeld = { _ in false }
    let fresh = core.event(.leftMouseDown, ev(.leftMouseDown, inPage))
    let freshUp = core.event(.leftMouseUp, ev(.leftMouseUp, inPage))
    check("panel press: a press under way whose release was never heard: dropped at the next press, decided afresh (through the hole: as it came)",
          !fresh && !freshUp && f.log == ["deliver 1 to 6 at 120,467"], "\(f.log)")
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
    h.delivers = false
    let core2 = PaneClickCore(focuser: h, report: { _ in })
    core2.buttonHeld = { _ in true }
    core2.update(panelScene())
    check("panel press: no records: the press goes on as it came (routed, handed back as before), nothing claimed",
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
}
