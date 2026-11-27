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
        var tiled: [Bool] = []
        e.hostedTile = { tiled.append($0) }
        let r = open(e, textEdit)
        let edit = window(w, "com.apple.TextEdit")
        let tile = w.tileOf(edit)
        check("live resize: Margin's window told the one shown lies in a tile (its page area may pass the window's edge: page_slides)",
              tiled.last == true, "\(tiled)")
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
        // The tiles off during a drag (another app's tile rect didn't take): Margin's Space still told the drag is over
        // (never left in a live resize its windows would keep).
        let (w, e, _) = world()
        _ = open(e, textEdit)
        let follows = e.dragging(true)
        let begun = w.liveResizing[FakeHostWorld.marginSpace] == true
        w.rectsIgnored = true
        _ = open(e, notes)
        let off = e.tilesOff != nil
        _ = e.dragging(false)
        check("live resize: the tiles off during a drag: Margin's Space still told it's over",
              follows && begun && off && w.liveResizing[FakeHostWorld.marginSpace] == false && w.calls.last == "liveResizing \(FakeHostWorld.marginSpace) false",
              "\(follows) \(begun) \(off) \(w.calls.suffix(4))")
    }
    do {
        // A drag that narrows a Safari tile over many frames leaves its tab laid out at the width it began at, shrunk to
        // fit (Safari's own, the real Mac 2026-11-26): the drag over, the tile set at its widest width in the drag and back
        // at its own in one step, under the freeze, so Safari lays the page out again at the width it ends at. A drag that
        // only widens it, and another app's tile, aren't touched.
        let (w, e, _) = world()
        w.start("com.apple.Safari", policy: .regular, windows: 0)
        let copy = FakeSafariCopy(w) { w.running(bundleId: "com.apple.Safari").first?.pid }
        copy.wire(e)
        let r = open(e, .safariWindow("Work"))
        let n = copy.windowOf[7914] ?? 0
        let tile = w.tileOf(n) ?? 0
        settle(e, 276)
        func drag(_ from: CGFloat, _ to: CGFloat) {
            _ = e.dragging(true)
            for left in Array(stride(from: from, to: to, by: from < to ? 6 : -6)) + [to] {
                e.follow(placed(left))
                _ = hostRun { await w.sleep(0.009); return true }
            }
            _ = e.dragging(false)
            _ = hostRun { await w.sleep(0.3); return true } // (the queue's work after it)
        }
        func rect(_ left: CGFloat) -> String { let t = tileFor(left); return "tileRect \(tile) \(Int(t.minX)),\(Int(t.minY)) \(Int(t.width))×\(Int(t.height))" }
        let (l, restore) = listen()
        let m = w.calls.count
        let freezes = w.freezes
        drag(276, 400)
        let after = Array(w.calls.dropFirst(m))
        let lastLive = after.lastIndex(of: "liveResizing \(FakeHostWorld.marginSpace) false") ?? -1
        let relay = after.dropFirst(lastLive + 1).filter { $0.hasPrefix("tileRect \(tile) ") }
        check("live resize: a drag narrowing a Safari tile: over, its tile at its widest width in the drag (as it began) and back at its own in one step, under the freeze",
              tile != 0 && lastLive >= 0 && relay == [rect(276), rect(400)] && w.freezes == freezes + 1 && w.reveals == w.freezes && !w.frozen
              && w.bounds(window: n)?.width == page(400).width && l.all.contains { $0.contains("laid out again at \(Int(tileFor(400).width)) pt after a drag that narrowed it from \(Int(tileFor(276).width))") && $0.contains("under the freeze") },
              "\(String(describing: r)) \(relay) \(after.suffix(6)) \(l.all.filter { $0.contains("laid out again") })")
        let m2 = w.calls.count
        let freezes2 = w.freezes
        drag(400, 300)
        check("live resize: …a drag that only widens it: nothing more after it",
              w.calls.dropFirst(m2).drop { $0 != "liveResizing \(FakeHostWorld.marginSpace) false" }.filter { $0.hasPrefix("tileRect \(tile) ") }.isEmpty && w.freezes == freezes2 && w.bounds(window: n)?.width == page(300).width)
        restore()
        let (w2, e2, _) = world()
        _ = open(e2, textEdit)
        let edit = window(w2, "com.apple.TextEdit")
        settle(e2, 276)
        let freezes3 = w2.freezes
        _ = e2.dragging(true)
        for left in Array(stride(from: 276.0, to: 400.0, by: 6)) + [400] { e2.follow(placed(CGFloat(left))); _ = hostRun { await w2.sleep(0.009); return true } }
        _ = e2.dragging(false)
        _ = hostRun { await w2.sleep(0.3); return true }
        check("live resize: …another app's tile narrowed: not touched (Safari's alone)", w2.freezes == freezes3 && w2.bounds(window: edit)?.width == page(400).width && w2.calls.last == "liveResizing \(FakeHostWorld.marginSpace) false", "\(w2.calls.suffix(4))")
    }
    do {
        // Safari's own scaling of its full-screen pages turned off (SafariScaling.swift): a Safari started since lays its
        // page out as the drag narrows it, so nothing after the drag; one started before it was turned off still scales,
        // and its tile is laid out again as before.
        func run(offSince: (Double) -> Double) -> (relayed: Bool, freezes: Int, width: CGFloat?, tile: UInt64) {
            let (w, e, _) = world()
            w.start("com.apple.Safari", policy: .regular, windows: 0)
            let pid = w.running(bundleId: "com.apple.Safari").first?.pid ?? 0
            e.options.safariScalingOffSince = offSince(w.apps[pid]?.launchedAt ?? 0)
            let copy = FakeSafariCopy(w) { w.running(bundleId: "com.apple.Safari").first?.pid }
            copy.wire(e)
            _ = open(e, .safariWindow("Work"))
            let n = copy.windowOf[7914] ?? 0
            let tile = w.tileOf(n) ?? 0
            settle(e, 276)
            let m = w.calls.count
            let freezes = w.freezes
            _ = e.dragging(true)
            for left in Array(stride(from: 276.0, to: 400.0, by: 6)) + [400] { e.follow(placed(CGFloat(left))); _ = hostRun { await w.sleep(0.009); return true } }
            _ = e.dragging(false)
            _ = hostRun { await w.sleep(0.3); return true }
            let after = Array(w.calls.dropFirst(m))
            let lastLive = after.lastIndex(of: "liveResizing \(FakeHostWorld.marginSpace) false") ?? after.count
            let relayed = after.dropFirst(lastLive + 1).contains { $0.hasPrefix("tileRect \(tile) ") }
            return (relayed, w.freezes - freezes, w.bounds(window: n)?.width, tile)
        }
        let since = run { $0 - 1 }
        check("live resize: Safari's scaling off before this Safari started: a narrowing drag over, nothing more (no freeze, no tile set)",
              since.tile != 0 && !since.relayed && since.freezes == 0 && since.width == page(400).width, "\(since)")
        let before = run { $0 + 1 }
        check("live resize: …turned off after this Safari started: its tile laid out again after the drag, as before",
              before.tile != 0 && before.relayed && before.freezes == 1 && before.width == page(400).width, "\(before)")
    }
    do {
        // The relay held by the page's own word (`safariPageLayout`), never a guessed time: asked first whether it's drawn
        // shrunk (whole: nothing laid out again, no freeze); shrunk, the tile set at its wider width and held until the
        // page says it's drawn whole there, then at its own and held until it says it's laid out narrower than that, the
        // screen let go then. A page that never answers: each wait capped (`relayCap`), the screen let go all the same.
        typealias Ask = (whole: Bool, below: Double?, width: CGFloat, frozen: Bool, at: Double)
        func run(_ page: @escaping (FakeHostWorld, Int, Bool, Double?) async -> HostPageLayout?) -> (asks: [Ask], relayed: Bool, freezes: Int, frozen: Bool, lines: [String], end: Double, dragEnd: Double) {
            let (w, e, _) = world()
            w.start("com.apple.Safari", policy: .regular, windows: 0)
            let copy = FakeSafariCopy(w) { w.running(bundleId: "com.apple.Safari").first?.pid }
            copy.wire(e)
            var asks: [Ask] = []
            var n = 0
            e.safariPageLayout = { _, _, whole, below, _ in
                asks.append((whole, below, w.bounds(window: n)?.width ?? 0, w.frozen, w.clock))
                return await page(w, n, whole, below)
            }
            _ = open(e, .safariWindow("Work"))
            n = copy.windowOf[7914] ?? 0
            let tile = w.tileOf(n) ?? 0
            settle(e, 276)
            let (l, restore) = listen()
            defer { restore() }
            let m = w.calls.count
            let freezes = w.freezes
            _ = e.dragging(true)
            for left in Array(stride(from: 276.0, to: 400.0, by: 6)) + [400] { e.follow(placed(CGFloat(left))); _ = hostRun { await w.sleep(0.009); return true } }
            _ = e.dragging(false)
            let dragEnd = w.clock
            _ = hostRun { await w.sleep(5); return true }
            let after = Array(w.calls.dropFirst(m))
            let lastLive = after.lastIndex(of: "liveResizing \(FakeHostWorld.marginSpace) false") ?? after.count
            let relayed = after.dropFirst(lastLive + 1).contains { $0.hasPrefix("tileRect \(tile) ") }
            return (asks, relayed, w.freezes - freezes, w.frozen, l.all.filter { $0.contains("laid out again") }, w.clock, dragEnd)
        }
        // (Safari's own: shrunk until its window is as wide as the widest of the drag, then whole at any width.)
        var relaid = false
        let shrunk = run { w, n, whole, below in
            let width = Double(w.bounds(window: n)?.width ?? 0)
            if !whole && below == nil { return HostPageLayout(scale: relaid ? 1 : 0.87, inner: relaid ? width : 1392, met: true) }
            if below == nil {
                if width >= 1100 { relaid = true }
                return HostPageLayout(scale: relaid ? 1 : 0.87, inner: relaid ? width : 1392, met: relaid)
            }
            return HostPageLayout(scale: 1, inner: width, met: width < below!)
        }
        let a = shrunk.asks
        check("live resize: a page drawn shrunk after the drag: asked, at its wider width until it says it's whole, at its own until it's laid out narrower, under the freeze, let go then",
              a.count == 3 && !a[0].whole && a[0].below == nil && !a[0].frozen
              && a[1].whole && a[1].below == nil && a[1].frozen && a[1].width > a[0].width
              && a[2].whole && a[2].below == Double(a[1].width) - 0.5 && a[2].frozen && a[2].width == a[0].width
              && shrunk.relayed && shrunk.freezes == 1 && !shrunk.frozen
              && shrunk.lines.contains { $0.contains("its page drawn whole at the wider width: 1 of 1, at its own: 1 of 1") },
              "\(a) \(shrunk.lines)")
        let whole = run { w, n, _, _ in HostPageLayout(scale: 1, inner: Double(w.bounds(window: n)?.width ?? 0), met: true) }
        check("live resize: …a page drawn whole after it: asked once, nothing laid out again, no freeze",
              whole.asks.count == 1 && !whole.relayed && whole.freezes == 0 && whole.lines.contains { $0.contains("drawn whole after a drag that narrowed it, nothing laid out again") },
              "\(whole.asks) \(whole.lines)")
        let silent = run { w, _, _, _ in await w.sleep(100); return nil }
        check("live resize: …a page that never answers: laid out again as it may be shrunk, each wait capped, the screen let go",
              silent.asks.count == 3 && silent.relayed && silent.freezes == 1 && !silent.frozen
              && silent.lines.contains { $0.contains("at the wider width: 0 of 1, at its own: 0 of 1") }
              && silent.asks[1].at - silent.asks[0].at < 1.1 && silent.asks[2].at - silent.asks[1].at < 1.2,
              "\(silent.asks) \(silent.lines)")
    }
    do {
        let (w, e, _) = world()
        w.tileWindow[FakeHostWorld.marginTile] = 999 // (Margin's own tile not found by its window)
        _ = open(e, textEdit)
        check("live resize: Margin's own tile not found at the check: the tiles off for the run, the app a plain member", e.tilesOff != nil && e.hosts[textEdit.id]?.tile == nil && e.hosts[textEdit.id]?.member == true && clean(w))
    }

    // ---- a window's own minimum (docs/HOSTING-CORE.md "A window's minimum size"): the real Mac, 2026-11-18, Weather's
    // window left Margin's Space for a full-screen Space of its own 24 ms after its tile was sent narrower than its
    // minimum (1046 < 1048, its tile's SizeConstraints); the stand-in plays that (`ejectsBelowMinimum`) ----
    do {
        let page1100 = CGRect(x: 404, y: 41, width: 1100, height: 933) // (Notes at its minimum, its right edge the page area's)
        check("min size: HostLayout.fit: the page area when it's big enough; else the minimum, its right edge and top the page area's; never past the area",
              HostLayout.fit(page(276), min: CGSize(width: 1100, height: 500), in: FakeHostWorld.display) == page(276)
              && HostLayout.fit(page(500), min: CGSize(width: 1100, height: 500), in: FakeHostWorld.display) == page1100
              && HostLayout.fit(page(500), min: nil, in: FakeHostWorld.display) == page(500)
              && HostLayout.fit(page(500), min: CGSize(width: 1600, height: 500), in: FakeHostWorld.display) == CGRect(x: 0, y: 41, width: 1512, height: 933)
              && HostLayout.fit(page(276), min: CGSize(width: 900, height: 1000), in: FakeHostWorld.display) == CGRect(x: 276, y: 41, width: 1228, height: 941))
        let (w, e, _) = world()
        w.minSize["com.apple.Notes"] = CGSize(width: 1100, height: 500)
        var said: [CGFloat?] = []
        e.onMinimum = { said.append($0) }
        _ = open(e, textEdit)
        let (l, restore) = listen()
        _ = open(e, notes)
        restore()
        let n = window(w, "com.apple.Notes"), edit = window(w, "com.apple.TextEdit")
        let tile = w.tileOf(n) ?? 0
        check("min size: its window's minimum read from its tile as it comes into Margin's Space (said once), told to Margin's window while it's shown",
              e.hosts[notes.id]?.minSize == CGSize(width: 1100, height: 500) && e.shownMinimumWidth == 1100 && said.last == .some(1100)
              && l.all.filter { $0.contains("its window's own minimum 1100×500") }.count == 1, "\(String(describing: e.hosts[notes.id]?.minSize)) \(said)")

        // A drag past it, slow then fast: never a rect narrower than its minimum, never out of Margin's Space.
        let m = w.calls.count
        _ = e.dragging(true)
        for left in stride(from: 276.0, through: 500.0, by: 4) { e.follow(placed(CGFloat(left))); _ = hostRun { await w.sleep(0.009); return true } }
        for left in [300.0, 480, 320, 500] { e.follow(placed(CGFloat(left))); _ = hostRun { await w.sleep(0.002); return true } }
        _ = hostRun { await w.sleep(0.05); return true }
        let narrowest = w.calls.dropFirst(m).filter { $0.hasPrefix("tileRect \(tile) ") }.compactMap { c in c.split(separator: " ").last?.split(separator: "×").first.flatMap { Int($0) } }.min() ?? 0
        check("min size: a drag past its minimum (slow, then fast): every rect sent at least its minimum wide, its window never out of Margin's Space, at its minimum with its right edge the page area's",
              w.belowMinimum == 0 && w.ejections == 0 && narrowest == 1100 && w.spaces(window: n) == [FakeHostWorld.marginSpace] && w.bounds(window: n) == page1100,
              "narrowest \(narrowest), below \(w.belowMinimum), ejections \(w.ejections), at \(String(describing: w.bounds(window: n)))")
        _ = e.dragging(false)
        let placedEnd = hostRun { await e.pageRectChanged(placed(500)) }
        settle(e, 500)
        check("min size: the drag's end under its minimum (a page area narrower than it): kept at its minimum, right edge aligned, no full-screen change, never out of Margin's Space",
              placedEnd == true && w.ejections == 0 && w.bounds(window: n) == page1100 && count(w, "fullScreen", since: m) == 0 && clean(w) && marginWhole(w), "\(w.calls.dropFirst(m).suffix(6))")
        check("min size: …the parked one with no minimum at the page area itself", w.bounds(window: edit) == page(500) && w.spaces(window: edit) == [])

        // Parked while the page area goes under its minimum: sized at its minimum, never out of sight's place (its tile
        // saying no minimum while it's parked: the one read before kept).
        w.minUnreadParked = true
        _ = show(e, textEdit)
        check("min size: another shown: none told", said.last == .some(nil) && e.shownMinimumWidth == nil, "\(said)")
        _ = hostRun { await e.pageRectChanged(placed(276)) }
        settle(e, 276)
        let m2 = w.calls.count
        _ = hostRun { await e.pageRectChanged(placed(500)) }
        settle(e, 500)
        check("min size: parked as the page area goes narrower than its minimum: sized at its minimum, its right edge the page area's, still in no user Space, never out of its tile",
              w.ejections == 0 && w.bounds(window: n) == page1100 && w.spaces(window: n) == [] && w.belowMinimum == 0 && count(w, "tileRect \(tile) ", since: m2) == 1, "\(w.calls.dropFirst(m2))")
        var first: CGRect?
        e.hostedWindow = { if $0 == n { first = w.bounds(window: n) } }
        let m3 = w.calls.count
        let r = show(e, notes)
        e.hostedWindow = nil
        check("min size: …shown so: its first frame at its minimum (what's wider than the page area under Margin's sidebar), no full-screen change, its minimum told again",
              r == .shown(notes.id, placed: true) && first == page1100 && count(w, "fullScreen", since: m3) == 0 && w.ejections == 0 && said.last == .some(1100), "\(String(describing: first)) \(said)")
        // Wider again: at the page area.
        _ = e.dragging(true)
        for left in stride(from: 500.0, through: 276.0, by: -8) { e.follow(placed(CGFloat(left))); _ = hostRun { await w.sleep(0.009); return true } }
        _ = e.dragging(false)
        _ = hostRun { await e.pageRectChanged(placed(276)) }
        check("min size: …dragged wider from under its minimum: at the page area again", w.bounds(window: n) == page(276) && w.ejections == 0 && clean(w))
    }
    do {
        // No minimum readable from its tile: it leaves the first tile narrower than its minimum, once. Brought back into
        // its tile in Margin's Space at once (no full-screen exit or entry, no loader), not followed again for the rest of
        // that drag, the narrowest it held taken for its minimum: never again, the drag's end included.
        let (w, e, _) = world()
        w.minSize["com.apple.Notes"] = CGSize(width: 1100, height: 500)
        w.minUnread = true
        _ = open(e, textEdit)
        _ = open(e, notes)
        let n = window(w, "com.apple.Notes")
        var loading: [HostID?] = []
        e.loading = { loading.append($0) }
        let m = w.calls.count
        _ = e.dragging(true)
        for left in stride(from: 276.0, through: 500.0, by: 6) {
            e.follow(placed(CGFloat(left)))
            _ = hostRun { await w.sleep(0.009); return true }
            if w.ejections > 0, e.hosts[notes.id]?.phase == .shown { w.clock += 0.25; e.poll(); _ = hostRun { await w.sleep(0.01); return true } }
        }
        let duringDrag = w.ejections
        _ = e.dragging(false)
        _ = hostRun { await e.pageRectChanged(placed(500)) }
        settle(e, 500)
        w.clock += 0.25
        e.poll()
        settle(e, 500)
        let learnt = e.hosts[notes.id]?.minSize?.width ?? 0
        check("min size, none readable: it left its tile once in the drag, brought back into a tile of Margin's Space with no full-screen exit or entry and no loader, still shown; not followed again in that drag",
              duringDrag == 1 && w.ejections == 1 && count(w, "fullScreen", since: m) == 0 && loading.allSatisfy { $0 == nil } && e.shown == notes.id && w.tileOf(n) != nil
              && w.spaces(window: n) == [FakeHostWorld.marginSpace] && w.listsMarginOnly && w.ownerlessFullScreenSpaces() == [],
              "ejections \(duringDrag)/\(w.ejections) fullScreen \(count(w, "fullScreen", since: m)) loading \(loading) \(w.calls.dropFirst(m).filter { !$0.hasPrefix("tileRect") }.suffix(12))")
        check("min size, none readable: …the narrowest it held taken for its minimum (above the rect it left), the drag's end at it, never left again",
              learnt >= 1100 && learnt < 1228 && w.bounds(window: n).map { abs($0.maxX - page(500).maxX) < 1 && $0.width == learnt } == true && clean(w) && marginWhole(w),
              "learnt \(learnt), at \(String(describing: w.bounds(window: n)))")
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

    // ---- another display (a bigger monitor connected, the lid closed, another resolution): Margin's own tile laid out for
    // it, never put back to the old display's (Tirth, 2026-11-25: Margin's window stayed at the laptop's size on the
    // monitor, the rest blank) ----
    do {
        let (w, e, _) = world()
        let laptop = FakeHostWorld.tileDisplay
        _ = hostRun { await e.open(app: textEdit, in: HostPlacement(page: page(276), area: FakeHostWorld.display, display: laptop), marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        let mark = w.calls.count
        _ = hostRun { await e.pageRectChanged(HostPlacement(page: page(276), area: FakeHostWorld.display, display: laptop)) }
        check("live resize: the same display: Margin's own tile left as it is (no rect sent for it)",
              count(w, "tileRect \(FakeHostWorld.marginTile) ", since: mark) == 0 && w.tileRects[FakeHostWorld.marginTile].map { $0 == laptop } ?? true, "\(w.calls.dropFirst(mark))")
        let monitor = CGRect(x: 0, y: 0, width: 1800, height: 1169)
        let area = CGRect(x: 0, y: 33, width: 1800, height: 1136), bigPage = CGRect(x: 276, y: 41, width: 1800 - 8 - 276, height: 1120)
        let (lines, done) = listen()
        let m2 = w.calls.count
        _ = hostRun { await e.pageRectChanged(HostPlacement(page: bigPage, area: area, display: monitor)) }
        done()
        check("live resize: another display: Margin's own tile laid out for it (its whole), not put back to the old display's, said",
              w.tileRects[FakeHostWorld.marginTile] == monitor && count(w, "tileRect \(FakeHostWorld.marginTile) 0,0 1800×1169", since: m2) >= 1
              && lines.all.contains { $0.contains("Margin's display changed") }, "\(String(describing: w.tileRects[FakeHostWorld.marginTile])) \(w.calls.dropFirst(m2))")
        let m3 = w.calls.count
        _ = hostRun { await e.pageRectChanged(HostPlacement(page: bigPage, area: area, display: monitor)) }
        check("live resize: …and that display again: nothing more for Margin's own tile",
              count(w, "tileRect \(FakeHostWorld.marginTile) ", since: m3) == 0 && w.tileRects[FakeHostWorld.marginTile] == monitor, "\(w.calls.dropFirst(m3))")
    }

    // ---- …as it happens on the Mac: Margin's window says its display changed, then the window manager's re-layout of
    // Margin's Space for it is answered (`marginNarrowed`): Margin's own tile at the new display's size, never put back
    // at the old one's (the real Mac, 2026-11-25: the page measured narrower than its display sent no placement, and the
    // watcher held Margin's window at 1512 pt on an 1800 pt display) ----
    do {
        let (w, e, _) = world()
        let laptop = FakeHostWorld.tileDisplay, monitor = CGRect(x: 0, y: 0, width: 1800, height: 1169)
        _ = hostRun { await e.open(app: textEdit, in: HostPlacement(page: page(276), area: FakeHostWorld.display, display: laptop), marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        e.displayChanged(laptop, marginWindow: FakeHostWorld.marginWindow) // (the same display: nothing)
        let other = w.calls.count
        e.displayChanged(monitor, marginWindow: FakeHostWorld.marginWindow + 1) // (another window's: not Margin's hosting one)
        check("live resize: a display change of a window that isn't the hosting one, or the same display: nothing",
              count(w, "tileRect \(FakeHostWorld.marginTile) ", since: other) == 0, "\(w.calls.dropFirst(other))")
        let m = w.calls.count
        e.displayChanged(monitor, marginWindow: FakeHostWorld.marginWindow)
        e.marginNarrowed()
        settle(e, 276) // (the queue's work waited for)
        check("live resize: Margin's window on another display: its own tile laid out for it at once, the re-layout's answer too, not put back at the old display's",
              w.tileRects[FakeHostWorld.marginTile] == monitor && !w.calls.dropFirst(m).contains("tileRect \(FakeHostWorld.marginTile) 0,0 1512×982"),
              "\(String(describing: w.tileRects[FakeHostWorld.marginTile])) \(w.calls.dropFirst(m).filter { $0.hasPrefix("tileRect") })")
    }

    // ---- back to the smaller display, as the real Mac did it (2026-11-25): the window manager set Margin's own tile's
    // rect for it but left the window at the bigger display's width: its rect sent again (it reads right, the window
    // isn't) ----
    do {
        let (w, e, _) = world()
        let laptop = FakeHostWorld.tileDisplay, monitor = CGRect(x: 0, y: 0, width: 1800, height: 1169)
        let small = HostPlacement(page: page(276), area: FakeHostWorld.display, display: laptop)
        let big = HostPlacement(page: CGRect(x: 276, y: 41, width: 1800 - 8 - 276, height: 1120), area: CGRect(x: 0, y: 33, width: 1800, height: 1136), display: monitor)
        _ = hostRun { await e.open(app: textEdit, in: small, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        let grow = e.displayChanged(monitor, marginWindow: FakeHostWorld.marginWindow)
        _ = hostRun { await grow?.value }
        for _ in 0..<6 { _ = hostRun { await e.pageRectChanged(big) } }
        let grown = w.tileRects[FakeHostWorld.marginTile] == monitor
        w.tileRects[FakeHostWorld.marginTile] = laptop
        w.lagging[FakeHostWorld.marginWindow] = (CGRect(x: 0, y: 33, width: 1800, height: 1136), .greatestFiniteMagnitude)
        let m = w.calls.count
        let queued = e.displayChanged(laptop, marginWindow: FakeHostWorld.marginWindow)
        _ = hostRun { await queued?.value }
        check("live resize: back to the smaller display, its tile's rect reading right and its window still the bigger one's width: the rect sent again",
              grown && w.calls.dropFirst(m).contains("tileRect \(FakeHostWorld.marginTile) 0,0 1512×982"), "grown \(grown) \(w.calls.dropFirst(m).filter { $0.hasPrefix("tileRect") })")
    }
}
