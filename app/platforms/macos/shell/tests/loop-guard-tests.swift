// The loop guard (the hosting core's guard.rs and causes.rs; docs/ARCHITECTURE-PLAN.md "Reconciler"), part of
// tests.swift's run: the host engine against the stand-in world with its tiles on, an app that answers each sizing of
// its tile with a window of its own whose close lays the tiles out again (TextEdit playing Weather on the real Mac, 2026-11-18 13:30:
// 54 rounds in 18 s, seen as a line, a black page and an empty one, again and again). The guard stops it within three
// rounds and moves that app alone to a plain member; the person's own changes are never a loop.
import AppKit
import Foundation

func loopGuardTests() {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-loop-guard-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    func world(_ name: String, guarded: Bool = true) -> (FakeHostWorld, HostEngine) {
        let w = FakeHostWorld()
        w.tilesOn = true
        let e = HostEngine(system: w, marker: folder.appendingPathComponent("\(name)/\(HostMarker.fileName)"), pid: 1)
        e.options.privateRetire = 0
        e.options.earlyFullScreen = false
        e.options.loopGuard = guarded
        // (As Margin's window and the observer hear it on the real Mac.)
        w.onRelaid = { e.marginNarrowed() }
        w.onDestroyed = { pid, n in e.observer.heard(pid: pid, .destroyed, n) }
        return (w, e)
    }
    func page(_ left: CGFloat) -> CGRect { CGRect(x: left, y: 41, width: 1512 - 8 - left, height: 933) }
    func placed(_ left: CGFloat) -> HostPlacement { HostPlacement(page: page(left), area: FakeHostWorld.display) }
    func marginWhole(_ w: FakeHostWorld) -> Bool { w.bounds(window: FakeHostWorld.marginWindow) == FakeHostWorld.display && (w.tileRects[FakeHostWorld.marginTile] ?? FakeHostWorld.tileDisplay) == FakeHostWorld.tileDisplay }
    let weather = HostTarget.app("com.apple.TextEdit"), notes = HostTarget.app("com.apple.Notes")
    func open(_ e: HostEngine, _ t: HostTarget) -> HostResult? {
        hostRun { await e.open(app: t, in: placed(276), marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
    }
    func window(_ w: FakeHostWorld, _ bundle: String) -> Int { w.running(bundleId: bundle).first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0 }
    // `seconds` of the world's time at the poll's pace (every 0.25 s), the engine's queue run between.
    func run(_ w: FakeHostWorld, _ e: HostEngine, _ seconds: Double) {
        let end = w.clock + seconds
        var next = w.clock
        while w.clock + 1e-9 < end {
            w.clock += 0.05
            w.advance()
            if w.clock + 1e-9 >= next { e.poll(); next += 0.25 }
            _ = hostRun { await w.sleep(0.001); return true }
        }
    }
    final class Lines { var all: [String] = [] }
    func listen() -> (Lines, () -> Void) {
        let l = Lines()
        let was = Diagnostics.echo
        Diagnostics.echo = { l.all.append($0) }
        return (l, { Diagnostics.echo = was })
    }

    // ---- without the guard: the stand-in loops, as the real Mac did (the case is the real one) ----
    do {
        let (w, e) = world("unguarded", guarded: false)
        w.answersResize = ["com.apple.TextEdit"]
        _ = open(e, weather)
        _ = hostRun { await e.pageRectChanged(placed(340)) }
        let before = w.helpersMade
        run(w, e, 6)
        check("loop guard: off, the stand-in plays Weather's loop (every sizing of its tile answered by a window whose close lays the tiles out again): it never ends",
              w.helpersMade - before >= 8, "\(w.helpersMade - before) rounds in 6 s")
    }

    // ---- with it: stopped within three rounds, that app alone a plain member, the page area whole ----
    do {
        let (w, e) = world("guarded")
        w.answersResize = ["com.apple.TextEdit"]
        let (lines, done) = listen()
        defer { done() }
        // (Weather was the first app opened that day: its tile the layout's second, after Margin's own, the one a
        // re-layout wipes. A third tile isn't laid out again by it.)
        _ = open(e, weather)
        _ = open(e, notes)
        _ = hostRun { await e.show(weather.id) }
        _ = hostRun { await e.pageRectChanged(placed(340)) }
        let before = w.helpersMade, relaid = w.relaid, callsBefore = w.calls.count, linesBefore = lines.all.count
        run(w, e, 6)
        let host = e.hosts[weather.id], n = window(w, "com.apple.TextEdit")
        // (Its tile's rect sent in answer to a re-layout: two let through, the third stopped. The helpers counted include
        // the answers to the person's own show and drag, which come as the world's clock runs.)
        let tile = w.calls.dropFirst(callsBefore).filter { $0.hasPrefix("tileRect ") && !$0.hasPrefix("tileRect \(FakeHostWorld.marginTile) ") }
        check("loop guard: Weather's loop stopped at its third re-layout: two of its tile's rects sent in answer, none after, its answers to the person's show and drag the only others",
              tile.count <= 2 && w.helpersMade - before <= 4 && w.relaid - relaid <= 5, "\(tile) \(w.helpersMade - before) rounds, \(w.relaid - relaid) re-layouts")
        check("loop guard: …Weather moved to a plain member (out of its tile, held there), still shown at the page area, Margin's window whole",
              host?.tile == nil && host?.noTiles == true && host?.phase == .shown && e.shown == weather.id && w.bounds(window: n) == page(340) && marginWhole(w),
              "tile \(String(describing: host?.tile)) noTiles \(String(describing: host?.noTiles)) phase \(String(describing: host?.phase)) at \(String(describing: w.bounds(window: n)))")
        check("loop guard: …the other app still a tile (only the app that fought its tile moved)",
              e.hosts[notes.id]?.tile != nil && e.hosts[notes.id]?.noTiles == false, "\(String(describing: e.hosts[notes.id]?.tile))")
        check("loop guard: …said in the log, its cause the host whose window went",
              lines.all.contains { $0.contains("app:com.apple.TextEdit: Margin's Space's tiles laid out again 3 times within 5 s") && $0.contains("moved from tiles to members") },
              "\(lines.all.filter { $0.contains("moved") || $0.contains("laid out") }.suffix(6))")
        let routes = (try? String(contentsOf: folder.appendingPathComponent("guarded/routes.json"), encoding: .utf8)) ?? ""
        check("loop guard: …remembered for this version of the app (routes.json)", routes.contains("com.apple.TextEdit") && routes.contains("members"), routes)
        // A later show: never a tile again this run; settled, no more rounds.
        let mark = w.helpersMade
        _ = hostRun { await e.show(notes.id) }
        _ = hostRun { await e.show(weather.id) }
        run(w, e, 3)
        check("loop guard: …shown again after another: a member, never a tile, no rounds", e.hosts[weather.id]?.tile == nil && w.helpersMade == mark,
              "\(String(describing: e.hosts[weather.id]?.tile)) \(w.helpersMade - mark)")

        // The next run (a new engine, the routes read back): held at members from its first open.
        let (w2, e2) = world("guarded")
        w2.answersResize = ["com.apple.TextEdit"]
        _ = open(e2, weather)
        run(w2, e2, 2)
        check("loop guard: the next run, the same version: a member from its first open, never a tile", e2.hosts[weather.id]?.tile == nil && e2.hosts[weather.id]?.noTiles == true && w2.helpersMade == 0,
              "\(String(describing: e2.hosts[weather.id]?.tile)) helpers \(w2.helpersMade)")
    }

    // ---- the person's own changes: never a loop ----
    do {
        let (w, e) = world("person")
        _ = open(e, notes)
        for left in [300, 320, 340, 360, 300, 280] as [CGFloat] { _ = hostRun { await e.pageRectChanged(placed(left)) } }
        run(w, e, 1)
        check("loop guard: six page area changes in a second (the person's drags): every one sized, nothing stopped, still a tile",
              e.hosts[notes.id]?.tile != nil && e.hosts[notes.id]?.noTiles == false && w.bounds(window: window(w, "com.apple.Notes")) == page(280),
              "\(String(describing: e.hosts[notes.id]?.tile)) \(String(describing: w.bounds(window: window(w, "com.apple.Notes"))))")
    }

    // ---- the anchors: Margin's own two empty tiles at its Space's front; a re-layout lays only them out ----
    do {
        let (w, e) = world("anchors")
        w.anchorsOn = true
        w.answersResize = ["com.apple.TextEdit"]
        let marker = folder.appendingPathComponent("anchors/\(HostMarker.fileName)")
        _ = open(e, weather)
        let list = w.tiles[FakeHostWorld.marginSpace] ?? []
        let anchors = e.anchorTiles
        check("anchors: the first open makes Margin's two empty tiles, its Space's layout's first two (no window), Margin's own tile third, the hosted one after",
              anchors.count == 2 && Array(list.prefix(2)) == anchors && list.count == 4 && list[2] == FakeHostWorld.marginTile && anchors.allSatisfy { w.tileWindow[$0] == nil }
              && marginWhole(w), "\(list) anchors \(anchors) margin \(String(describing: w.bounds(window: FakeHostWorld.marginWindow)))")
        check("anchors: …in the crash marker (a killed Margin's next launch destroys them)", HostMarker.read(marker)?.anchors == anchors, "\(String(describing: HostMarker.read(marker)?.anchors))")
        _ = open(e, notes)
        _ = hostRun { await e.show(weather.id) }
        let n = window(w, "com.apple.TextEdit")
        let calls = w.calls.count, relaid = w.relaid
        _ = hostRun { await e.pageRectChanged(placed(340)) }
        run(w, e, 6)
        let answers = w.calls.dropFirst(calls).filter { $0.hasPrefix("tileRect ") && !$0.hasPrefix("tileRect \(FakeHostWorld.marginTile) ") }
        check("anchors: Weather's case (its every sizing answered by a window whose close lays the tiles out): only the anchors laid out again, Weather's tile never wiped, none of its rects sent in answer (only the drag's own), still a tile, no loop",
              answers.count <= 2 && e.hosts[weather.id]?.tile != nil && e.hosts[weather.id]?.noTiles == false && w.bounds(window: n) == page(340) && marginWhole(w) && w.relaid > relaid,
              "\(answers) relaid \(w.relaid - relaid) noTiles \(String(describing: e.hosts[weather.id]?.noTiles)) at \(String(describing: w.bounds(window: n)))")
        // A re-layout Margin didn't make (an app's tile taken out, a window closed): Margin's window and the hosted ones untouched.
        let rects = w.tileRects
        w.relayFirstTwo(FakeHostWorld.marginSpace)
        let touched = (w.tiles[FakeHostWorld.marginSpace] ?? []).filter { w.tileRects[$0] != rects[$0] }
        check("anchors: a re-layout touches only the anchors", Set(touched).isSubset(of: Set(anchors)) && marginWhole(w), "\(touched)")
        _ = hostRun { await e.quitAll(); return true }
        check("anchors: Margin's quit destroys them (Margin's Space left with none of its tiles)",
              e.anchorTiles.isEmpty && !(w.tiles[FakeHostWorld.marginSpace] ?? []).contains(where: { anchors.contains($0) }), "\(String(describing: w.tiles[FakeHostWorld.marginSpace]))")
    }
    do {
        let (w, e) = world("anchors-off")
        w.anchorsOn = true
        w.createRefused = true
        _ = open(e, notes)
        check("anchors: none made (the bridge took the call, made nothing): the tiles as before, Margin's own first",
              e.anchorTiles.isEmpty && w.tiles[FakeHostWorld.marginSpace]?.first == FakeHostWorld.marginTile && e.hosts[notes.id]?.tile != nil, "\(String(describing: w.tiles[FakeHostWorld.marginSpace]))")
    }
}
