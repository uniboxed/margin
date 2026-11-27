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
    screenTilesLateTests()
    screenLayoutHeldTests()
    screenLeftFullScreenTests()
    screenDragLineTests()
}

// ---- the log's line for a drag (bug D): what's dragged, and how many hosted windows follow it ----
private func screenDragLineTests() {
    check("screen: a drag's line: the sidebar's edge, one window following live (as before)",
          HostedSession.dragLine(divider: false, window: 1, following: true, (1, 1)) == "the sidebar's edge dragged in Margin's window 1: the hosted window follows it live")
    check("screen: a drag's line: a split's divider, every pane following live, counted",
          HostedSession.dragLine(divider: true, window: 2, following: true, (3, 3)) == "a split's divider dragged in Margin's window 2: 3 hosted windows follow it live")
    check("screen: a drag's line: some follow live, the plain members placed again at the release",
          HostedSession.dragLine(divider: true, window: 1, following: true, (1, 3)) == "a split's divider dragged in Margin's window 1: 1 of 3 hosted windows follow it live, the others placed again when it's let go")
    check("screen: a drag's line: none follow (held until it's let go)",
          HostedSession.dragLine(divider: false, window: 1, following: false, (0, 1)) == "the sidebar's edge dragged in Margin's window 1: the page area's changes held until it's let go (1 hosted window placed again then)")
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

    // ---- a re-entry held by the loop guard's per-second hold, in the tiles' sizing after a page change: asked again
    // once, when the hold ends (the core's time), never again and again at once (a spin while the hold lasts) ----
    do {
        let (w, e, _) = world()
        _ = hostRun { await e.open(app: notes, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        _ = hostRun { await e.open(app: textEdit, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        let edit = window(w, "com.apple.TextEdit")
        w.clock += 5
        polls(w, e, 4)
        let set = e.hosts[textEdit.id]?.tile != nil && e.hosts[notes.id]?.tile != nil && e.hosts[notes.id]?.phase == .parked && e.shown == textEdit.id
        // The page area moves: the one shown placed, then the parked one's tile sized (`sizeTilesSoon`). While that one is
        // sized, the one shown leaves full screen by itself, its page taken for stale (its tile next in the sizing), and
        // the loop guard's second fills: eleven reactions beside the parked one's sizing, so the re-entry is the
        // thirteenth (held, the hold starting then).
        let moved = HostPlacement(page: CGRect(x: 248, y: 41, width: 1256, height: 933), area: FakeHostWorld.display)
        var filled: Double?
        var heldAt: [Double] = [], backAt: [Double] = [], lines: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { line in
            echo?(line)
            lines.append(line)
            if filled == nil, line.contains("\(notes.id): parked"), line.contains("size its tile") {
                filled = w.clock
                leaves(w, edit)
                e.hosts[textEdit.id]?.placedPage = nil
                for i in 0..<11 { _ = e.core.react(now: w.clock, host: "test:\(i)", key: "k") }
            }
            if line.contains("\(textEdit.id): back into full screen held") { heldAt.append(w.clock) }
            if line.contains("\(textEdit.id): its window left full screen by itself") { backAt.append(w.clock) }
        }
        _ = hostRun { await e.pageRectChanged(moved) }
        _ = hostRun { await w.pass(3); return true } // (in frames: the retry's work at the hold's end runs then, not 2 s on)
        Diagnostics.echo = echo
        let end = heldAt.first.map { $0 + 1 } ?? -1 // (the hold starts at its refusal: a second from it)
        check("screen: set up: two tiled hosts, the parked one's tile sized after a page change, the one shown out of full screen then, the guard's second full",
              set && filled != nil, "\(String(describing: filled)) \(lines.suffix(6))")
        check("screen: a re-entry held by the loop guard's hold: asked once, again only when the hold ends (no spin), then back in full screen",
              heldAt.count == 1 && backAt.count == 1 && backAt[0] + 1e-9 >= end && backAt[0] < end + 0.05 && w.wins[edit]?.fullScreen == true,
              "held \(heldAt.count) at \(heldAt.prefix(3)), back at \(backAt), the hold's end \(end); \(lines.suffix(10))")
    }
}

// ---- Margin's own window back at its width later than `tileWait` after a tile came in (the real Mac under load,
// 2026-11-21 15:09: "live resize off for this run: a tile's rect didn't take (… its window is at 240,41 1264×933, not
// 240,41 1264×933)" — the window was there; Margin's own was still a split's half): one more look, tiles kept. ----
private func screenTilesLateTests() {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-screen-tiles-late-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let page = CGRect(x: 240, y: 41, width: 1264, height: 933)
    let placement = HostPlacement(page: page, area: FakeHostWorld.display)
    let textEdit = HostTarget.app("com.apple.TextEdit")
    func run(late: Double) -> (FakeHostWorld, HostEngine) {
        let w = FakeHostWorld()
        w.tilesOn = true
        w.marginBackAfter = late
        let e = HostEngine(system: w, marker: folder.appendingPathComponent("\(late)/\(HostMarker.fileName)"), pid: 1)
        e.options.privateRetire = 0
        _ = hostRun { await e.open(app: textEdit, in: placement, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        return (w, e)
    }
    let (w1, e1) = run(late: e1Late)
    check("screen: Margin's own window back at its width 0.4 s after a tile came in (past tileWait): one more look, tiles kept for the run, the window in its tile at the page area",
          e1.tilesOff == nil && e1.hosts[textEdit.id]?.tile != nil && w1.bounds(window: w1.running(bundleId: "com.apple.TextEdit").first.flatMap { w1.apps[$0.pid]?.windows.first } ?? 0) == page,
          "tiles off: \(e1.tilesOff ?? "no") tile \(String(describing: e1.hosts[textEdit.id]?.tile))")
    let (_, e2) = run(late: 5)
    check("screen: …Margin's own window never back within both looks: tiles off for the run, as before, the message naming Margin's own window",
          e2.tilesOff?.contains("Margin's own window at") == true, "\(e2.tilesOff ?? "nil")")
}
private let e1Late = 0.4
