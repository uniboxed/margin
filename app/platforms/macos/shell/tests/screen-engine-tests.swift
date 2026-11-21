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
    screenLeftFullScreenTests()
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

// ---- a hosted window out of full screen by itself (bug B): Safari's Esc in its page exits its window's full screen (the
// real screen, 2026-11-21, twice): its toolbar strip gone, its window at its own normal frame (0,46 667×865) still in
// Margin's Space, its tile left empty. Before: "size its tile" three times (its window never in it), then "moved from
// tiles to members for this version of its app" saved in routes.json, then placed again. Now: a "left full screen"
// event: back into full screen at its rect, no tile sizing tried, no route moved, nothing saved. ----
private func screenLeftFullScreenTests() {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-screen-left-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let page = CGRect(x: 276, y: 41, width: 1228, height: 933)
    let placement = HostPlacement(page: page, area: FakeHostWorld.display)
    let normal = CGRect(x: 0, y: 46, width: 667, height: 865) // (its own frame as a window, as the log had it)
    let textEdit = HostTarget.app("com.apple.TextEdit"), notes = HostTarget.app("com.apple.Notes")
    var made = 0
    func world() -> (FakeHostWorld, HostEngine, URL) {
        made += 1
        let w = FakeHostWorld()
        w.tilesOn = true
        w.toolbarAbove.insert("com.apple.TextEdit") // (its own toolbar window above its frame in full screen, as Safari's)
        let url = folder.appendingPathComponent("\(made)/\(HostMarker.fileName)")
        let e = HostEngine(system: w, marker: url, pid: 1)
        e.options.privateRetire = 0
        e.options.earlyFullScreen = false
        return (w, e, url)
    }
    func window(_ w: FakeHostWorld, _ bundle: String) -> Int { w.running(bundleId: bundle).first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0 }
    func polls(_ w: FakeHostWorld, _ e: HostEngine, _ n: Int) { for _ in 0..<n { w.clock += 0.25; e.poll(); _ = hostRun { await w.sleep(0.001); return true } } }
    // Out of full screen by itself as the real Mac did it: its own toolbar gone, its tile left empty in Margin's Space,
    // the window a normal one at its own frame, still in Margin's Space.
    func leaves(_ w: FakeHostWorld, _ n: Int) {
        guard let pid = w.wins[n]?.pid else { return }
        w.applyFullScreen(pid: pid, window: n, false)
        w.wins[n]?.spaces = [FakeHostWorld.marginSpace]
        w.wins[n]?.frame = normal
    }
    final class Lines { var all: [String] = [] }
    func listen() -> (Lines, () -> Void) {
        let l = Lines()
        let was = Diagnostics.echo
        Diagnostics.echo = { l.all.append($0) }
        return (l, { Diagnostics.echo = was })
    }

    // ---- alone at the page area ----
    do {
        let (w, e, marker) = world()
        var routes: [String] = []
        e.onRoute = { routes.append("\($0) \($1)") }
        _ = hostRun { await e.open(app: textEdit, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        let edit = window(w, "com.apple.TextEdit")
        let tiled = e.hosts[textEdit.id]?.tile != nil && w.bounds(window: edit) == page && w.toolbarOf[edit] != nil
        w.clock += 5
        polls(w, e, 4) // (its own toolbar seen as its own)
        let (l, restore) = listen()
        leaves(w, edit)
        polls(w, e, 40)
        restore()
        let routesFile = marker.deletingLastPathComponent().appendingPathComponent("routes.json")
        let saved = (try? String(contentsOf: routesFile, encoding: .utf8)) ?? ""
        check("screen: set up: a tiled host at the page area, its own toolbar above it", tiled)
        check("screen: a hosted window out of full screen by itself: back in full screen at the page area, in Margin's Space, shown",
              w.wins[edit]?.fullScreen == true && w.bounds(window: edit) == page && w.spaces(window: edit) == [FakeHostWorld.marginSpace] && e.shown == textEdit.id
              && e.hosts[textEdit.id]?.phase == .shown,
              "\(String(describing: w.wins[edit]?.fullScreen)) \(String(describing: w.bounds(window: edit))) \(String(describing: w.spaces(window: edit)))")
        check("screen: …said as a window out of full screen, never a tile's fight: no tile sizing tried, its route not moved down, nothing saved for its version",
              l.all.contains { $0.contains("left full screen") } && !l.all.contains { $0.contains("size its tile") } && routes.isEmpty
              && !l.all.contains { $0.contains("moved from tiles to members") } && !saved.contains("com.apple.TextEdit"),
              "\(routes) \(l.all.filter { $0.contains("TextEdit") }.suffix(8))")
        check("screen: …and back on its tiles route (a tile of its own again in Margin's Space)",
              e.hosts[textEdit.id]?.tile != nil && e.hosts[textEdit.id]?.noTiles == false && w.tileOf(edit) != nil, "\(String(describing: e.hosts[textEdit.id]?.tile))")
        // A real fight with its tile (its window full screen in it, the rect not taken) is still the loop guard's.
        w.rectsIgnored = true
        if let t = w.tileOf(edit) { w.tileRects[t] = CGRect(x: 0, y: 0, width: 750, height: 982) }
        let (l2, restore2) = listen()
        polls(w, e, 60)
        restore2()
        check("screen: …while a real fight with its tile (full screen in it, its rect not taken) is still sized, and moved down a route by the loop guard",
              l2.all.contains { $0.contains("size its tile") } && !l2.all.contains { $0.contains("left full screen") } && routes.contains { $0.hasPrefix(textEdit.id.description) },
              "\(routes) \(l2.all.filter { $0.contains("TextEdit") }.suffix(6))")
    }

    // ---- main of a split: back at its pane's rect, the split kept ----
    do {
        let (w, e, _) = world()
        var routes: [String] = []
        e.onRoute = { routes.append("\($0) \($1)") }
        let left = CGRect(x: 276, y: 41, width: 610, height: 933), right = CGRect(x: 894, y: 41, width: 610, height: 933)
        _ = hostRun { await e.open(app: textEdit, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        _ = hostRun { await e.setLayout(main: textEdit, mainRect: left, extras: [HostExtra(target: notes, role: .pane, rect: right)], focused: nil, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        let edit = window(w, "com.apple.TextEdit"), n = window(w, "com.apple.Notes")
        w.clock += 5
        polls(w, e, 4)
        let (l, restore) = listen()
        leaves(w, edit)
        polls(w, e, 40)
        restore()
        check("screen: a split's main out of full screen by itself: back in full screen at its pane's rect, the other pane where it was, the split kept, nothing moved down",
              w.wins[edit]?.fullScreen == true && w.bounds(window: edit) == left && w.bounds(window: n) == right && e.visible.count == 2 && e.visible[textEdit.id]?.rect == left
              && routes.isEmpty && !l.all.contains { $0.contains("size its tile") },
              "\(String(describing: w.bounds(window: edit))) \(String(describing: w.bounds(window: n))) \(e.visible) \(routes) \(l.all.filter { $0.contains("TextEdit") }.suffix(8))")
    }

    // ---- a plain member (tiles off): its own toolbar gone is the sign; placed back in full screen, never "placed again"
    // out of a full screen it isn't in (that waited for an exit that never came, and kept it at its normal frame) ----
    do {
        let (w, e, _) = world()
        w.tilesOn = false
        _ = hostRun { await e.open(app: textEdit, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        let edit = window(w, "com.apple.TextEdit")
        w.clock += 5
        polls(w, e, 4)
        let (l, restore) = listen()
        leaves(w, edit)
        w.wins[edit]?.member = false
        polls(w, e, 40)
        restore()
        check("screen: a plain member out of full screen by itself (its own toolbar gone): back in full screen at the page area, a member of Margin's Space again",
              w.wins[edit]?.fullScreen == true && w.bounds(window: edit) == page && w.spaces(window: edit) == [FakeHostWorld.marginSpace] && e.hosts[textEdit.id]?.member == true
              && l.all.contains { $0.contains("left full screen by itself (its own toolbar window") } && !l.all.contains { $0.contains("kept as it was") },
              "\(String(describing: w.bounds(window: edit))) \(l.all.filter { $0.contains("TextEdit") }.suffix(8))")
    }
}
