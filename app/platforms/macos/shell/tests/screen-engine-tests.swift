// What the real screen found on 2026-11-21 (Margin's log, split view and Peek on real Safari), part of tests.swift's run,
// against the stand-in world (host-tests.swift `FakeHostWorld`) and the session on it:
// - a visible host placed again on its own (the reconciler's `placeAgain`, a route moved down) while a split is shown:
//   the layout held, each one at its own rect (the engine's layout had become main alone at the page area while main
//   was still placed at its old pane's rect, "reserved 240/8/8/635");
// - a hosted window that left full screen by itself (Safari's own Esc in its page): back into full screen at its rect,
//   never counted as a fight with its tile, its route never moved down (routes.json kept it a member for that version);
// - the log's line for a split's divider drag (not the sidebar's edge), with how many windows follow it;
// - Remove from Split View on an app's pane of a split of two, as the pane's menu sends it (the row's number).
import AppKit
import Foundation

func screenEngineTests() {
    screenLayoutHeldTests()
}

// ---- a visible host placed again on its own: the layout held (bug C) ----
private func screenLayoutHeldTests() {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-screen-engine-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let page = CGRect(x: 276, y: 41, width: 1228, height: 933)
    let placement = HostPlacement(page: page, area: FakeHostWorld.display)
    // A stacked split: main on top, the pane under it (Margin's 8 pt gap).
    let top = CGRect(x: 276, y: 41, width: 1228, height: 306), bottom = CGRect(x: 276, y: 355, width: 1228, height: 619)
    let textEdit = HostTarget.app("com.apple.TextEdit"), notes = HostTarget.app("com.apple.Notes")
    let w = FakeHostWorld()
    let e = HostEngine(system: w, marker: folder.appendingPathComponent(HostMarker.fileName), pid: 1)
    e.options.privateRetire = 0
    e.options.earlyFullScreen = false
    func open(_ t: HostTarget) { _ = hostRun { await e.open(app: t, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) } }
    func window(_ bundle: String) -> Int { w.running(bundleId: bundle).first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0 }
    func polls(_ n: Int) { for _ in 0..<n { w.clock += 0.25; e.poll(); _ = hostRun { await w.sleep(0.001); return true } } }
    open(textEdit)
    _ = hostRun { await e.setLayout(main: textEdit, mainRect: top, extras: [HostExtra(target: notes, role: .pane, rect: bottom)], focused: nil, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
    let edit = window("com.apple.TextEdit"), n = window("com.apple.Notes")
    check("screen: set up: a stacked split of two plain members (tiles off), each at its rect, main focused",
          w.bounds(window: edit) == top && w.bounds(window: n) == bottom && e.visible.count == 2 && e.shown == textEdit.id, "\(e.visible)")
    // Main's window re-laid out by its app (off its pane's rect, still in Margin's Space): the reconciler places it again.
    w.wins[edit]?.memberFrame = FakeHostWorld.display
    w.clock += 5 // (past the show's late watch)
    polls(8)
    check("screen: a split's main placed again on its own (the reconciler): the layout held, main back at its pane's rect, the pane at its own, the focus kept",
          e.visible.count == 2 && e.visible[textEdit.id]?.rect == top && e.visible[notes.id]?.rect == bottom && w.bounds(window: edit) == top && w.bounds(window: n) == bottom
          && e.shown == textEdit.id && w.spaces(window: n) == [FakeHostWorld.marginSpace],
          "\(e.visible) \(String(describing: e.shown)) \(String(describing: w.bounds(window: edit))) \(String(describing: w.bounds(window: n)))")
    // Then main shown alone (an item outside the split): at the page area, the pane parked; a change of the page area
    // after it places it there, never at the old pane's rect.
    open(textEdit)
    check("screen: …then main alone: at the page area, the pane parked", e.visible.count == 1 && e.visible[textEdit.id]?.rect == nil && e.hosts[textEdit.id]?.rect == nil
          && w.bounds(window: edit) == page && w.spaces(window: n) == [], "\(e.visible) \(String(describing: w.bounds(window: edit)))")
    var moved = placement
    moved.page = CGRect(x: 316, y: 41, width: 1188, height: 933)
    _ = hostRun { await e.pageRectChanged(moved) }
    check("screen: …and a page area change places it at the page area (its current rect), never its pane's", w.bounds(window: edit) == moved.page, "\(String(describing: w.bounds(window: edit)))")
}
