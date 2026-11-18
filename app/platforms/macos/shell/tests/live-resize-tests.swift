// Live resize (docs/HOSTING-CORE.md "Live resize: tiles in Margin's Space"), part of tests.swift's run: the host engine
// against the stand-in world with its tiles on (host-tests.swift `FakeHostWorld`, `tilesOn`), as the kit measured them
// on the real Mac (2026-11-17, /tmp/margin-toolbar-test/live-resize/opt4): a hosted window's own tile moved into
// Margin's Space past its tile limit isn't taken; a tile moved in or taken out lays the first two of the layout out
// again (Margin's own window and the first hosted one as a split's halves); a tile's rect sizes its window, shown or
// parked; an app killed leaves a placeholder tile; Margin killed leaves its Space with no owner and the hosted tiles.
import AppKit
import Foundation

func liveResizeTests() {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-live-resize-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    var made = 0
    func world(tiles: Bool = true, early: Bool = false) -> (FakeHostWorld, HostEngine, URL) {
        made += 1
        let w = FakeHostWorld()
        w.tilesOn = tiles
        let url = folder.appendingPathComponent("\(made)/\(HostMarker.fileName)")
        let e = HostEngine(system: w, marker: url, pid: 1)
        e.options.privateRetire = 0
        e.options.earlyFullScreen = early
        return (w, e, url)
    }
    func page(_ left: CGFloat) -> CGRect { CGRect(x: left, y: 41, width: 1512 - 8 - left, height: 933) }
    func tileFor(_ left: CGFloat) -> CGRect { CGRect(x: left, y: 8, width: 1512 - 8 - left, height: 966) } // (its tile: the band above the window)
    func placed(_ left: CGFloat) -> HostPlacement { HostPlacement(page: page(left), area: FakeHostWorld.display) }
    let textEdit = HostTarget.app("com.apple.TextEdit"), notes = HostTarget.app("com.apple.Notes")
    func open(_ e: HostEngine, _ t: HostTarget, _ left: CGFloat = 276) -> HostResult? {
        hostRun { await e.open(app: t, in: placed(left), marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
    }
    func show(_ e: HostEngine, _ t: HostTarget) -> HostResult? { hostRun { await e.show(t.id) } }
    func settle(_ e: HostEngine, _ left: CGFloat) { for _ in 0..<6 { _ = hostRun { await e.pageRectChanged(placed(left)) } } } // (the queue's work waited for)
    func window(_ w: FakeHostWorld, _ bundle: String) -> Int { w.running(bundleId: bundle).first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0 }
    func pid(_ w: FakeHostWorld, _ bundle: String) -> pid_t { w.running(bundleId: bundle).first?.pid ?? 0 }
    func clean(_ w: FakeHostWorld) -> Bool { w.listsMarginOnly && w.ownerlessFullScreenSpaces() == [] && w.dropped == 0 && w.destroyedWithWindows == 0 && !w.frozen }
    func count(_ w: FakeHostWorld, _ prefix: String, since: Int = 0) -> Int { w.calls.dropFirst(since).filter { $0.hasPrefix(prefix) }.count }
    func marginWhole(_ w: FakeHostWorld) -> Bool { w.bounds(window: FakeHostWorld.marginWindow) == FakeHostWorld.display && (w.tileRects[FakeHostWorld.marginTile] ?? FakeHostWorld.tileDisplay) == FakeHostWorld.tileDisplay }
    final class Lines { var all: [String] = [] }
    func listen() -> (Lines, () -> Void) {
        let l = Lines()
        let was = Diagnostics.echo
        Diagnostics.echo = { l.all.append($0) }
        return (l, { Diagnostics.echo = was })
    }

    // ---- the first open: its tile into Margin's Space, sized to the page area, under the freeze; its own Space destroyed ----
    do {
        let (w, e, marker) = world()
        let r = open(e, textEdit)
        let edit = window(w, "com.apple.TextEdit")
        let tile = w.tileOf(edit)
        check("live resize: a first open with the tiles on: shown, its window's own tile in Margin's Space (after Margin's own), at the page area, still full screen",
              r == .shown(textEdit.id, placed: true) && tile != nil && w.tiles[FakeHostWorld.marginSpace] == [FakeHostWorld.marginTile, tile ?? 0]
              && w.bounds(window: edit) == page(276) && w.tileRects[tile ?? 0] == tileFor(276) && w.wins[edit]?.fullScreen == true && w.wins[edit]?.tiled == true
              && e.hosts[textEdit.id]?.tile == tile && e.hosts[textEdit.id]?.member == true, "\(String(describing: r)) \(w.calls.filter { $0.hasPrefix("moveTile") || $0.hasPrefix("tileRect") })")
        check("live resize: its tile moved, never its window alone as a member; its own Space destroyed after: Mission Control lists Margin's Space only, nothing reserved on Margin's",
              count(w, "moveTile") == 1 && !w.calls.contains("move \(edit) \(FakeHostWorld.marginSpace)") && clean(w) && (w.reservation[FakeHostWorld.marginSpace] ?? .zero).isZero, "\(w.calls)")
        check("live resize: Margin's own window laid out as a split's half by the move, set back to the display's whole (its tile's rect) under the freeze",
              w.relaid >= 1 && marginWhole(w) && w.freezes >= 1 && w.freezes == w.reveals, "relaid \(w.relaid) margin \(String(describing: w.bounds(window: FakeHostWorld.marginWindow))) freezes \(w.freezes)/\(w.reveals)")
        let m = HostMarker.read(marker)
        check("live resize: the marker has its tile and Margin's own (a crash's recovery needs them)", m?.windows.first?.tile == tile && m?.marginTile == FakeHostWorld.marginTile && m?.marginSpace == FakeHostWorld.marginSpace, "\(String(describing: m))")

        // A second app: Margin's Space's limit raised first (3 tiles), its tile in; the first's rect, wiped by the re-layout
        // (it's the second of the layout), set back.
        let mark = w.calls.count
        let r2 = open(e, notes)
        let n = window(w, "com.apple.Notes")
        let raise = w.calls.dropFirst(mark).firstIndex { $0 == "maxTiles \(FakeHostWorld.marginSpace) 3" } ?? -1
        let move = w.calls.dropFirst(mark).firstIndex { $0.hasPrefix("moveTile") } ?? -1
        check("live resize: a second app: Margin's Space's tile limit raised to 3 before its tile's move",
              r2 == .shown(notes.id, placed: true) && raise >= 0 && move > raise && w.maxTileConfig[FakeHostWorld.marginSpace] == 3, "\(w.calls.dropFirst(mark))")
        let editTile = w.tileOf(edit) ?? 0
        check("live resize: …Margin's window whole and the new one at the page area; the parked one (laid out again as the layout's second) left so, its rect not sent again (a parked tile sized makes its app draw a window whose close lays the first two out again: the blinking loop)",
              marginWhole(w) && w.bounds(window: n) == page(276) && w.bounds(window: edit) != page(276) && w.spaces(window: edit) == [] && w.tiles[FakeHostWorld.marginSpace]?.count == 3
              && count(w, "tileRect \(editTile) ", since: move) == 0 && clean(w),
              "\(String(describing: w.bounds(window: edit))) \(String(describing: w.bounds(window: n))) \(w.calls.dropFirst(mark))")
        // (A tile change Margin didn't make while it's parked, Margin's window laid out as a split's half: its rect still
        // not sent; Margin's own and the one shown set back.)
        let mRelay = w.calls.count
        w.relayFirstTwo(FakeHostWorld.marginSpace)
        e.marginNarrowed()
        _ = hostRun { await e.pageRectChanged(placed(276)) }
        check("live resize: a re-layout Margin didn't make, the parked one second: Margin's window and the one shown set back, the parked one's rect never sent (no loop)",
              marginWhole(w) && w.bounds(window: n) == page(276) && count(w, "tileRect \(editTile) ", since: mRelay) == 0, "\(w.calls.dropFirst(mRelay))")
        // (Shown: sized first, out of sight: its first frame at the page area.)
        var firstFrame: CGRect?
        e.hostedWindow = { if $0 == edit { firstFrame = w.bounds(window: edit) } }
        let mShow = w.calls.count
        let rEdit = show(e, textEdit)
        check("live resize: …a switch to it: its tile sized before it's shown (never the split's size), no full-screen change",
              rEdit == .shown(textEdit.id, placed: true) && firstFrame == page(276) && count(w, "fullScreen", since: mShow) == 0 && count(w, "tileRect \(editTile) ", since: mShow) >= 1,
              "\(w.calls.dropFirst(mShow)) \(String(describing: firstFrame))")
        e.hostedWindow = nil
        _ = show(e, notes)

        // ---- a change of the page area (a drag's end, a theme): the one shown sized by its tile's rect at once, no
        // full-screen change, no loader; the parked one after it, by the reconciler, out of sight ----
        var loading: [HostID?] = []
        e.loading = { loading.append($0) }
        let m2 = w.calls.count
        let placedNow = hostRun { await e.pageRectChanged(placed(340)) }
        let shownAt = w.calls.dropFirst(m2).firstIndex { $0.hasPrefix("tileRect \(w.tileOf(n) ?? 0)") } ?? -1
        check("live resize: the page area changed: the one shown at the new page area by its tile's rect alone (no full-screen exit or entry, no reservation, no loader)",
              placedNow == true && w.bounds(window: n) == page(340) && count(w, "fullScreen", since: m2) == 0 && count(w, "reserve", since: m2) == 0 && loading.isEmpty && shownAt >= 0,
              "\(w.calls.dropFirst(m2)) \(loading)")
        settle(e, 340)
        let parkedAt = w.calls.dropFirst(m2).firstIndex { $0.hasPrefix("tileRect \(w.tileOf(edit) ?? 0)") } ?? -1
        check("live resize: …then the parked one, sized out of sight (still parked, in no user Space), after the one shown",
              w.bounds(window: edit) == page(340) && w.spaces(window: edit) == [] && parkedAt > shownAt && e.hosts[textEdit.id]?.placedPage == page(340) && clean(w),
              "\(w.calls.dropFirst(m2)) \(String(describing: w.bounds(window: edit)))")

        // ---- a switch after it: the first frame at the new size, no full-screen change ----
        var boundsAtShow: CGRect?
        e.hostedWindow = { if $0 == edit { boundsAtShow = w.bounds(window: edit) } }
        let m3 = w.calls.count
        let r3 = show(e, textEdit)
        check("live resize: a switch to the one sized out of sight: at the new page area as it's shown, no full-screen change, nothing sized again",
              r3 == .shown(textEdit.id, placed: true) && boundsAtShow == page(340) && count(w, "fullScreen", since: m3) == 0 && count(w, "tileRect", since: m3) == 0, "\(w.calls.dropFirst(m3))")

        // ---- a switch asked before the background sizing: the target sized first (jumps the queue) ----
        let m4 = w.calls.count
        _ = hostRun { await e.pageRectChanged(placed(300)) } // (the one shown, TextEdit; Notes waits for the reconciler)
        boundsAtShow = nil
        e.hostedWindow = { if $0 == n { boundsAtShow = w.bounds(window: n) } }
        let r4 = show(e, notes)
        check("live resize: a switch asked before its tile was sized in the background: sized first, out of sight, then shown at the new page area (never the old size), no full-screen change",
              r4 == .shown(notes.id, placed: true) && boundsAtShow == page(300) && count(w, "fullScreen", since: m4) == 0, "\(w.calls.dropFirst(m4)) \(String(describing: boundsAtShow))")
        settle(e, 300)

        // ---- a drag of the sidebar's edge: the one shown follows each page area live; nothing parked sized until it's over ----
        let m5 = w.calls.count
        let follows = e.dragging(true)
        var everyStep = true
        for left in stride(from: 300.0, through: 360.0, by: 6) {
            e.follow(placed(CGFloat(left)))
            _ = hostRun { await w.sleep(0.009); return true }
            if w.bounds(window: n) != page(CGFloat(left)) { everyStep = false }
        }
        let parkedDuring = count(w, "tileRect \(w.tileOf(edit) ?? 0)", since: m5)
        check("live resize: a drag: the one shown follows every step (its tile's rect at each page area within the frame), Margin's Space told a live resize is under way",
              follows && everyStep && w.liveResizing[FakeHostWorld.marginSpace] == true && w.calls.dropFirst(m5).first == "liveResizing \(FakeHostWorld.marginSpace) true", "\(w.calls.dropFirst(m5).prefix(6))")
        check("live resize: …nothing else sized during it, nothing out of or into full screen, no page area of Margin's changed yet",
              parkedDuring == 0 && count(w, "fullScreen", since: m5) == 0 && e.pageRect == page(300), "\(parkedDuring)")
        // Five changes in one frame: the newest wins, at most one in flight.
        let sentBefore = count(w, "tileRect \(w.tileOf(n) ?? 0)", since: m5)
        for left in [362.0, 364, 366, 368, 370] { e.follow(placed(CGFloat(left))) }
        _ = hostRun { await w.sleep(0.05); return true }
        let sentAfter = count(w, "tileRect \(w.tileOf(n) ?? 0)", since: m5)
        check("live resize: changes coalesced: five in one frame, at most two sent (one in flight, the newest after it), at the newest",
              sentAfter - sentBefore <= 2 && sentAfter - sentBefore >= 1 && w.bounds(window: n) == page(370), "\(sentAfter - sentBefore) sent, at \(String(describing: w.bounds(window: n)))")
        _ = e.dragging(false)
        check("live resize: the drag over: Margin's Space told so (LiveResizing false, never taken away)", w.liveResizing[FakeHostWorld.marginSpace] == false && w.calls.last == "liveResizing \(FakeHostWorld.marginSpace) false")
        _ = hostRun { await e.pageRectChanged(placed(370)) }
        settle(e, 370)
        check("live resize: …its page area Margin's: the one shown checked there, the parked one sized after it, nothing in or out of full screen all along",
              w.bounds(window: n) == page(370) && w.bounds(window: edit) == page(370) && count(w, "fullScreen", since: m5) == 0 && e.pageRect == page(370) && clean(w) && marginWhole(w))

        // ---- a row's close: its window out of full screen, its tile with it; every rect set again under the freeze ----
        let m6 = w.calls.count
        let freezes = w.freezes
        _ = hostRun { await e.close(notes.id); return true }
        check("live resize: a row closed: its window given back out of full screen (its tile gone from Margin's Space), Margin's window whole again and the other at the page area, under the freeze",
              w.wins[n] == nil || w.wins[n]?.fullScreen == false) // (its app quit)
        check("live resize: …Margin's Space: its own tile and the parked one's; Margin's window whole; the parked one, laid out again, left so until it's shown",
              w.tiles[FakeHostWorld.marginSpace] == [FakeHostWorld.marginTile, w.tileOf(edit) ?? 0] && marginWhole(w) && w.freezes > freezes && !w.frozen && clean(w),
              "\(String(describing: w.tiles[FakeHostWorld.marginSpace])) \(w.calls.dropFirst(m6))")

        // ---- Margin quits: everything given back, nothing of it left in Margin's Space (a window out of full screen leaves
        // its tile there, empty, until its app quits: TextEdit slow to quit here, as Chameleon on the real Mac) ----
        w.quitsAfter["com.apple.TextEdit"] = 3
        _ = hostRun { await e.quitAll(); return true }
        check("live resize: Margin's quit: its hosts given back out of full screen, the empty tiles they left destroyed before Margin's window goes (Margin's Space never outlives it), their apps asked to quit",
              w.tiles[FakeHostWorld.marginSpace] == [FakeHostWorld.marginTile] && w.wins[edit]?.fullScreen != true && clean(w),
              "\(String(describing: w.tiles[FakeHostWorld.marginSpace])) \(w.calls.suffix(8))")
        _ = hostRun { await w.sleep(3.5); return true }
        check("live resize: …its app quit after, the marker gone", w.running(bundleId: "com.apple.TextEdit").isEmpty && !FileManager.default.fileExists(atPath: marker.path))
    }

    // ---- the early path (the real Mac's pacing, `staged`): its tile moved once macOS has brought the window into its own Space ----
    do {
        let (w, e, _) = world(early: true)
        w.staged = true
        let r = open(e, textEdit)
        let edit = window(w, "com.apple.TextEdit")
        check("live resize: the early path: its tile moved into Margin's Space after macOS brought the window into its own (never before), at the page area, its own Space destroyed, under the freeze",
              r == .shown(textEdit.id, placed: true) && w.tileOf(edit) != nil && w.tiles[FakeHostWorld.marginSpace]?.count == 2 && w.bounds(window: edit) == page(276)
              && w.movedBeforeDelivery == 0 && w.lateDrops == 0 && clean(w) && marginWhole(w), "\(String(describing: r)) \(w.calls.filter { $0.hasPrefix("moveTile") || $0.hasPrefix("destroy") })")
    }

    // ---- an app killed while hosted: its placeholder tile destroyed at the next look, every rect set again ----
    do {
        let (w, e, _) = world()
        _ = open(e, textEdit)
        _ = open(e, notes)
        let editTile = w.tileOf(window(w, "com.apple.TextEdit"))
        w.killApp(pid(w, "com.apple.TextEdit"))
        let placeholder = editTile.map { w.placeholders.contains($0) } ?? false
        w.clock += 0.25
        e.poll()
        settle(e, 276)
        check("live resize: a hosted app killed: its tile left as a placeholder, destroyed at the next look; Margin's window whole again, the other at the page area",
              placeholder && editTile.map { t in !(w.tiles[FakeHostWorld.marginSpace] ?? []).contains(t) } == true && marginWhole(w)
              && w.bounds(window: window(w, "com.apple.Notes")) == page(276) && clean(w) && e.hosts[textEdit.id] == nil,
              "\(String(describing: w.tiles[FakeHostWorld.marginSpace])) \(w.calls.suffix(8))")
    }

    // ---- a hosted window closed by its app (no operation of Margin's): its tile goes, Margin's window is a split's half
    // and says so (MarginWindowController `onNarrowed`): every rect set again at once ----
    do {
        let (w, e, _) = world()
        _ = open(e, textEdit)
        _ = open(e, notes)
        let edit = window(w, "com.apple.TextEdit"), n = window(w, "com.apple.Notes")
        w.closeLeavesPlaceholder = false // (its tile taken out with it: the layout laid out again)
        w.closeWindow(edit)
        let narrowed = !marginWhole(w)
        e.marginNarrowed()
        _ = hostRun { await e.pageRectChanged(placed(276)) } // (the queue's turn waited for)
        check("live resize: a parked window closed by its app: Margin's window laid out as a split's half, told, every rect set again at once (no poll needed)",
              narrowed && marginWhole(w) && w.bounds(window: n) == page(276) && w.tiles[FakeHostWorld.marginSpace]?.count == 2, "\(w.calls.suffix(6))")
    }

    // ---- a switch that lays the first two tiles out again (the second's window coming back): Margin's window says it's
    // narrowed (MarginWindowController `onNarrowed`), every rect sent again at once, even mid-operation ----
    do {
        let (w, e, _) = world()
        _ = open(e, textEdit) // (the layout's second tile)
        _ = open(e, notes)
        let edit = window(w, "com.apple.TextEdit")
        _ = show(e, textEdit) // (the first switch after the tiles came in: watched under the freeze, see below)
        _ = show(e, notes)
        w.rejoinRelays = true
        var narrowedSeen = false, fixedInTheSwitch = false
        e.hostedWindow = { n in
            guard n == edit else { return }
            narrowedSeen = !marginWhole(w) || w.bounds(window: edit) != page(276)
            e.marginNarrowed() // (as Margin's window says it, from its own resize)
            fixedInTheSwitch = marginWhole(w) && w.bounds(window: edit) == page(276)
        }
        _ = show(e, textEdit)
        check("live resize: a switch that lays the first two tiles out again (seen: the window shown at a split's width): every rect sent again at once, mid-switch, nothing waits for a poll",
              narrowedSeen && fixedInTheSwitch && marginWhole(w) && w.bounds(window: edit) == page(276), "narrowed \(narrowedSeen) fixed \(fixedInTheSwitch) \(w.calls.suffix(6))")
    }

    // ---- the first switch after a tile change, which lays the first two tiles out again as the second's window comes
    // back (the real Mac, 23:52:23): under the freeze, every rect set again before it's revealed; later switches unfrozen ----
    do {
        let (w, e, _) = world()
        _ = open(e, textEdit)
        _ = open(e, notes)
        let edit = window(w, "com.apple.TextEdit")
        w.rejoinRelaysOnce = true
        var atReveal: [Bool] = []
        w.onReveal = { atReveal.append(marginWhole(w) && w.bounds(window: edit) == page(276)) }
        let freezes = w.freezes
        let r1 = show(e, textEdit)
        let firstFrozen = w.freezes == freezes + 1 && atReveal.last == true && !w.frozen
        _ = show(e, notes)
        let f2 = w.freezes
        _ = show(e, textEdit)
        check("live resize: the first switch after a tile change laid out again under the freeze, every rect set again before the reveal (never seen); later switches not frozen",
              r1 == .shown(textEdit.id, placed: true) && firstFrozen && w.freezes == f2 && marginWhole(w) && w.bounds(window: edit) == page(276), "\(String(describing: r1)) first frozen \(firstFrozen) freezes \(w.freezes - freezes) at reveal \(atReveal) margin \(marginWhole(w)) edit \(String(describing: w.bounds(window: edit)))")
    }

    // ---- the window shown closed by its app (windowless): its tile keeps a placeholder window of its app's at the tile's
    // rect, never adopted; the item closes, the placeholder tile destroyed ----
    do {
        // (As on the real Mac: Accessibility's notifications followed (the model's kinds), the closed NSWindow kept listed
        // by the window server, the placeholder its app's only window then: main-looking.)
        made += 1
        let w = FakeHostWorld()
        w.tilesOn = true
        w.keepsClosed = ["com.apple.Notes"]
        let e = HostEngine(system: w, marker: nil, pid: 1, observation: FakeObservation(w))
        e.options.privateRetire = 0
        e.options.earlyFullScreen = false
        _ = open(e, textEdit)
        _ = open(e, notes)
        let n = window(w, "com.apple.Notes"), tile = w.tileOf(n)
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        w.closeWindow(n)
        let placeholder = tile.flatMap { w.tileWindow[$0] }
        for _ in 0..<12 { w.clock += 0.25; e.poll(); _ = hostRun { await e.pageRectChanged(placed(276)) } }
        check("live resize: the window shown closed by its app: its tile's placeholder window never adopted, its item closed, the placeholder tile destroyed, Margin's window whole",
              placeholder != nil && placeholder != n && events.contains(.windowClosed(notes.id)) && e.hosts[notes.id] == nil && tile.map { t in !(w.tiles[FakeHostWorld.marginSpace] ?? []).contains(t) } == true
              && marginWhole(w) && clean(w), "\(events) \(String(describing: w.tiles[FakeHostWorld.marginSpace])) \(w.calls.suffix(6))")
    }

    // ---- Margin killed: at the next launch its marker's windows out of full screen, the tiles left destroyed, its old Space with them ----
    do {
        let (w, e, marker) = world()
        _ = open(e, textEdit)
        _ = open(e, notes)
        let edit = window(w, "com.apple.TextEdit"), n = window(w, "com.apple.Notes")
        w.marginKilled()
        let split = w.bounds(window: edit) != page(276) || w.bounds(window: n) != page(276) // (the first two laid out as a split, seen)
        let again = HostEngine(system: w, marker: marker, pid: 2)
        again.options.privateRetire = 0
        _ = hostRun { await again.recover(); return true }
        let fullScreenLeft = [edit, n].contains { w.wins[$0]?.fullScreen == true }
        check("live resize: Margin killed with two tiles in its Space: they fall into a split; at the next launch both out of full screen (given back), their apps quit, Margin's old Space gone, nothing listed, the marker gone",
              split && !fullScreenLeft && w.tiles[FakeHostWorld.marginSpace] == nil && w.running(bundleId: "com.apple.TextEdit").isEmpty && w.running(bundleId: "com.apple.Notes").isEmpty
              && w.listsMarginOnly && w.ownerlessFullScreenSpaces() == [] && !FileManager.default.fileExists(atPath: marker.path),
              "\(String(describing: w.tiles[FakeHostWorld.marginSpace])) \(w.calls.suffix(10))")
    }

    // ---- the fallback: no tiles, a limit that doesn't take, a rect that doesn't take: today's way, said once ----
    do {
        let (w, e, _) = world(tiles: false)
        _ = open(e, textEdit)
        let edit = window(w, "com.apple.TextEdit")
        let m = w.calls.count
        _ = hostRun { await e.pageRectChanged(placed(340)) }
        check("live resize: no tiles (the part off): a plain member as before; a change of the page area places it again out of full screen and in",
              w.tileOf(edit) == nil && e.hosts[textEdit.id]?.tile == nil && count(w, "moveTile") == 0 && count(w, "fullScreen false \(edit)", since: m) == 1 && w.bounds(window: edit) == page(340) && clean(w))
        check("live resize: …and a drag isn't followed (the session holds it, as before)", !e.dragging(true))
    }
    do {
        let (w, e, _) = world()
        w.limitIgnored = true
        let (l, restore) = listen()
        _ = open(e, textEdit) // (2 tiles: the default limit)
        _ = open(e, notes) // (3: the limit doesn't take)
        restore()
        let n = window(w, "com.apple.Notes")
        check("live resize: Margin's Space's limit doesn't take: the tile isn't moved, the window comes in as a member (today's way), the tiles off for the run, said once",
              e.hosts[notes.id]?.tile == nil && e.hosts[notes.id]?.member == true && w.bounds(window: n) == page(276) && e.tilesOff != nil
              && l.all.filter { $0.contains("live resize off for this run") }.count == 1 && clean(w) && marginWhole(w), "\(l.all.filter { $0.contains("live resize") })")
    }
    do {
        let (w, e, _) = world()
        w.rectsIgnored = true
        let r = open(e, textEdit)
        let edit = window(w, "com.apple.TextEdit")
        check("live resize: a tile's rect doesn't take: backed out (its tile out of Margin's Space), the tiles off for the run, the app shown all the same, nothing left listed",
              r.map { if case .shown = $0 { return true }; return false } == true && e.tilesOff != nil && e.hosts[textEdit.id]?.tile == nil && w.tileOf(edit) == nil && w.listsMarginOnly && !w.frozen,
              "\(String(describing: r)) \(String(describing: e.tilesOff))")
    }
    do {
        let (w, e, _) = world()
        w.tileWindow[FakeHostWorld.marginTile] = 999 // (Margin's own tile not found by its window)
        _ = open(e, textEdit)
        check("live resize: Margin's own tile not found at the check: the tiles off for the run, the app a plain member", e.tilesOff != nil && e.hosts[textEdit.id]?.tile == nil && e.hosts[textEdit.id]?.member == true && clean(w))
    }

    // ---- a window-mode app: followed live by Accessibility, one frame in flight ----
    do {
        let (w, e, _) = world()
        let ft = HostTarget.app("com.apple.FaceTime")
        _ = open(e, ft)
        let f = window(w, "com.apple.FaceTime")
        let m = w.calls.count
        let follows = e.dragging(true)
        for left in [290.0, 300, 310] { e.follow(placed(CGFloat(left))); _ = hostRun { await w.sleep(0.02); return true } }
        _ = e.dragging(false)
        check("live resize: a window-mode app follows a drag by Accessibility (no tile, nothing in or out of full screen, Margin's Space not told: it has no tile)",
              follows && w.bounds(window: f) == page(310) && count(w, "frame \(f)", since: m) >= 1 && count(w, "liveResizing", since: m) == 0 && count(w, "fullScreen", since: m) == 0, "\(w.calls.dropFirst(m))")
    }
}
