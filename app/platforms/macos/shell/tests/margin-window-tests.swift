// Margin's own window (MarginWindow.swift, MarginWindowController.swift, ShellHosted.swift), part of
// tests.swift's run, with nothing on screen: the page area from the UI's layout and the window's frame
// (windowed and full screen), where the pointer passes through to the window behind, the buttons'
// place, the menu bar's items and what each does, and the stand-in source's state from a data set.
import AppKit
import Foundation

func marginWindowTests() {
    func layout(_ l: Double, _ t: Double, _ r: Double, _ b: Double, w: Double, h: Double, radius: Double = 0) -> PageLayout {
        PageLayout(left: l, top: t, right: r, bottom: b, radius: radius, radii: [radius, radius, radius, radius], width: w, height: h, mode: "windowed")
    }

    // ---- the page area ----
    let main: CGFloat = 1117
    // A 1200 × 800 window, its AppKit frame's bottom-left at (100, 117): its top left at (100, 200).
    let windowed = MarginWindowGeometry.content(of: CGRect(x: 100, y: 117, width: 1200, height: 800), mainHeight: main)
    check("hosted: the content from the window's frame, top left (drawn under the title bar: the whole window)", windowed == CGRect(x: 100, y: 200, width: 1200, height: 800), "\(windowed)")
    let sidebar = layout(260, 8, 8, 8, w: 1200, h: 800, radius: 10)
    check("hosted: windowed, the page area is the content less the sidebar and the frame's insets, on screen",
          MarginWindowGeometry.pageRect(layout: sidebar, content: windowed) == CGRect(x: 360, y: 208, width: 932, height: 784))
    // Full screen: the content is the whole display (its own Space), the page measured at that size.
    let display = MarginWindowGeometry.content(of: CGRect(x: 0, y: 0, width: 1512, height: 982), mainHeight: 982)
    check("hosted: full screen, the content is the display", display == CGRect(x: 0, y: 0, width: 1512, height: 982))
    check("hosted: full screen, the page area from a layout measured at the display's size",
          MarginWindowGeometry.pageRect(layout: layout(248, 8, 8, 8, w: 1512, h: 982), content: display) == CGRect(x: 248, y: 8, width: 1256, height: 966))
    check("hosted: a layout from before the window went full screen (the old size) gives no area yet",
          MarginWindowGeometry.pageRect(layout: sidebar, content: display) == nil)
    check("hosted: the sidebar hidden, the page fills the window",
          MarginWindowGeometry.pageRect(layout: layout(0, 0, 0, 0, w: 1200, h: 800), content: windowed) == windowed)
    check("hosted: half a point off the content's size still counts as measured at it",
          MarginWindowGeometry.pageRect(layout: layout(260, 8, 8, 8, w: 1200.4, h: 799.6), content: windowed) != nil)
    check("hosted: insets that leave nothing: no area", MarginWindowGeometry.pageRect(layout: layout(700, 0, 600, 0, w: 1200, h: 800), content: windowed) == nil)
    // The window moved: the same layout, the area moves with it.
    let moved = MarginWindowGeometry.content(of: CGRect(x: 300, y: 17, width: 1200, height: 800), mainHeight: main)
    check("hosted: the window moved: the area follows it", MarginWindowGeometry.pageRect(layout: sidebar, content: moved) == CGRect(x: 560, y: 308, width: 932, height: 784))

    // ---- where the pointer goes through to the window behind ----
    let palette = CGRect(x: 400, y: 100, width: 500, height: 300) // the palette, over the page (in the content)
    let slot = PassThrough.slot(in: windowed, layout: sidebar, hits: [palette])
    check("hosted: the pass-through's slot is the page area", slot.rect == MarginWindowGeometry.pageRect(layout: sidebar, content: windowed))
    check("hosted: over the page area: the window behind gets it", PassThrough.pageGets(CGPoint(x: 900, y: 700), slot))
    check("hosted: over the sidebar: Margin's", !PassThrough.pageGets(CGPoint(x: 200, y: 500), slot))
    check("hosted: over the palette drawn over the page: Margin's", !PassThrough.pageGets(CGPoint(x: 700, y: 400), slot))
    check("hosted: in a rounded corner of the page area: Margin's (the frame drawn there)", !PassThrough.pageGets(CGPoint(x: 361, y: 209), slot))
    check("hosted: outside the window: never the page's", !PassThrough.pageGets(CGPoint(x: 50, y: 50), slot))
    check("hosted: a held button keeps what it had", PassThrough.decide(CGPoint(x: 200, y: 500), slot, buttonsDown: true, ignoring: true))
    let region = CatchRegion.of(frame: windowed, slot: slot)
    check("hosted: the fill under the UI has the page area as its hole (in the content)", region.hole == CGRect(x: 260, y: 8, width: 932, height: 784) && !region.all)
    check("hosted: the fill covers what the theme draws over the hole", region.contains(CGPoint(x: 700, y: 300), in: windowed.size) && !region.contains(CGPoint(x: 1000, y: 700), in: windowed.size))
    check("hosted: no layout yet: the whole window is Margin's", CatchRegion.of(frame: windowed, slot: nil).all)

    // ---- the buttons where the theme draws its window controls ----
    let origins = MarginWindowGeometry.buttonOrigins(controls: CGRect(x: 6, y: 7, width: 60, height: 14), button: CGSize(width: 14, height: 16), step: 20)
    check("hosted: the three buttons centred in the theme's box, their own step apart", origins == [CGPoint(x: 9, y: 6), CGPoint(x: 29, y: 6), CGPoint(x: 49, y: 6)], "\(origins)")
    let narrow = MarginWindowGeometry.buttonOrigins(controls: CGRect(x: 10, y: 40, width: 30, height: 20), button: CGSize(width: 14, height: 14), step: 20)
    check("hosted: a box narrower than the buttons: from its left", narrow.first == CGPoint(x: 10, y: 43), "\(narrow)")
    check("hosted: no box (hidden in full screen): AppKit's own place", MarginWindowGeometry.buttonOrigins(controls: .zero, button: CGSize(width: 14, height: 14), step: 20).isEmpty)
    check("hosted: a drag region", MarginWindowGeometry.inDragRegion(CGPoint(x: 100, y: 10), [CGRect(x: 80, y: 0, width: 180, height: 28)])
          && !MarginWindowGeometry.inDragRegion(CGPoint(x: 100, y: 40), [CGRect(x: 80, y: 0, width: 180, height: 28)]))

    // ---- Margin's menu bar ----
    let target = MarginMenuTarget()
    var ran: [MarginMenuAction] = []
    target.handle = { ran.append($0) }
    let bar = MarginMenu.build(target: target)
    check("hosted: the menu bar: Margin, File, Edit, View, Window", bar.items.map(\.title) == ["Margin", "File", "Edit", "View", "Window"], "\(bar.items.map(\.title))")
    func key(_ action: MarginMenuAction) -> (String, NSEvent.ModifierFlags)? { MarginMenu.item(action, in: bar).map { ($0.keyEquivalent, $0.keyEquivalentModifierMask) } }
    check("hosted: New Tab is ⌘T", key(.newTab).map { $0 == ("t", .command) } == true)
    check("hosted: New Window is ⌘N", key(.newWindow).map { $0 == ("n", .command) } == true)
    check("hosted: Close Tab is ⌘W", key(.closeTab).map { $0 == ("w", .command) } == true)
    check("hosted: Toggle Sidebar is ⌃⌘S", key(.toggleSidebar).map { $0 == ("s", [.command, .control]) } == true)
    let items = bar.items.flatMap { $0.submenu?.items ?? [] }
    let fullScreen = items.first { $0.action == #selector(NSWindow.toggleFullScreen(_:)) }
    check("hosted: Enter Full Screen is the window's own (⌃⌘F, titled by AppKit), no target", fullScreen?.keyEquivalent == "f" && fullScreen?.keyEquivalentModifierMask == [.command, .control] && fullScreen?.target == nil)
    // (Tirth, 2026-11-15) while hosting is on Margin is always full screen: no item to leave it, no ⌃⌘F.
    let always = MarginMenu.build(target: target, fullScreenItem: false).items.flatMap { $0.submenu?.items ?? [] }
    check("hosted: always full screen: no Enter/Exit Full Screen item, no ⌃⌘F, Toggle Sidebar still there", !always.contains { $0.action == #selector(NSWindow.toggleFullScreen(_:)) }
          && !always.contains { $0.keyEquivalent == "f" && $0.keyEquivalentModifierMask == [.command, .control] } && always.contains { $0.representedObject as? String == MarginMenuAction.toggleSidebar.rawValue })
    check("hosted: Margin's windows are always full screen by default", MarginWindows.Options().alwaysFullScreen && !MarginWindowController.Options().alwaysFullScreen)
    // Its toggle ignored (Margin opened by a script, not active): asked again once per activation, never looping.
    var retry = FullScreenRetry()
    check("hosted: full screen: never asked again before its first ask", !retry.shouldAsk(inFullScreen: false, entering: false, closed: false, firstAsked: false))
    check("hosted: full screen: not in after its first ask: asked again once", retry.shouldAsk(inFullScreen: false, entering: false, closed: false, firstAsked: true))
    check("hosted: full screen: its window key or main again in the same activation: not asked again (no loop)", !retry.shouldAsk(inFullScreen: false, entering: false, closed: false, firstAsked: true))
    retry.activated()
    check("hosted: full screen: on its way in, or closed, when Margin activates: not asked, the activation's ask kept",
          !retry.shouldAsk(inFullScreen: false, entering: true, closed: false, firstAsked: true) && !retry.shouldAsk(inFullScreen: false, entering: false, closed: true, firstAsked: true))
    check("hosted: full screen: Margin active again, still not in: asked once more, then not", retry.shouldAsk(inFullScreen: false, entering: false, closed: false, firstAsked: true)
          && !retry.shouldAsk(inFullScreen: false, entering: false, closed: false, firstAsked: true))
    retry.activated()
    check("hosted: full screen: already in when Margin activates: not asked", !retry.shouldAsk(inFullScreen: true, entering: false, closed: false, firstAsked: true))
    check("hosted: the standard app menu: About, Hide, Hide Others, Show All, Quit ⌘Q",
          [#selector(NSApplication.orderFrontStandardAboutPanel(_:)), #selector(NSApplication.hide(_:)), #selector(NSApplication.hideOtherApplications(_:)),
           #selector(NSApplication.unhideAllApplications(_:)), #selector(NSApplication.terminate(_:))].allSatisfy { sel in bar.items[0].submenu?.items.contains { $0.action == sel } == true }
          && bar.items[0].submenu?.items.last?.keyEquivalent == "q")
    check("hosted: Edit's keys for the UI's fields (copy, paste, select all)",
          [#selector(NSText.copy(_:)), #selector(NSText.paste(_:)), #selector(NSText.cut(_:)), #selector(NSText.selectAll(_:))].allSatisfy { sel in items.contains { $0.action == sel } })
    check("hosted: ⌘W closes the tab, ⇧⌘W the window", items.contains { $0.action == #selector(NSWindow.performClose(_:)) && $0.keyEquivalent == "w" && $0.keyEquivalentModifierMask == [.command, .shift] })
    for action in MarginMenuAction.allCases {
        guard let item = MarginMenu.item(action, in: bar), let selector = item.action, let to = item.target as? MarginMenuTarget, to === target else { check("hosted: an item for \(action), to Margin's target", false); continue }
        _ = to.perform(selector, with: item) // as AppKit sends a chosen item's action to its target
    }
    check("hosted: each of Margin's items says its own action", ran == MarginMenuAction.allCases, "\(ran)")
    target.enabled = { $0 == .newWindow }
    check("hosted: an item is enabled as the windows say (no window: only New Window)",
          MarginMenu.item(.newWindow, in: bar).map(target.validateMenuItem) == true && MarginMenu.item(.newTab, in: bar).map(target.validateMenuItem) == false)
    check("hosted: New Tab opens the palette (the same word as ⌘T)", MarginMenuAction.newTab.effect == .page(#"{"type":"command","name":"palette"}"#))
    check("hosted: Toggle Sidebar is the UI's", MarginMenuAction.toggleSidebar.effect == .page(#"{"type":"command","name":"toggle-sidebar"}"#))
    check("hosted: Close Tab is the source's (it knows the tab in front)", MarginMenuAction.closeTab.effect == .source("closeTab"))
    check("hosted: New Window makes a window", MarginMenuAction.newWindow.effect == .newWindow)

    // ---- the stand-in source: a data set as the state pages draw ----
    var values: [String: [String: Any]] = [
        "spaces": ["work": ["name": "Work", "emoji": "💼", "color": "#00f", "order": 1], "home": ["name": "Home", "emoji": "🏠", "color": "#f00", "order": 0]],
        "pins": ["p1": ["spaceId": "home", "url": "https://a.example/", "title": "A", "folderId": "f1", "pos": 2], "p2": ["spaceId": "work", "url": "https://b.example/", "title": "B", "folderId": NSNull(), "pos": 0]],
        "folders": ["f1": ["spaceId": "home", "name": "Reading", "open": false, "pos": 1]],
        "tabs": ["t-aaaaaaaaaa": ["spaceId": "work", "url": "https://c.example/", "title": "C", "icon": "", "order": 5, "lastUsed": 1000, "selected": true],
                 "t-bbbbbbbbbb": ["spaceId": "gone", "url": "https://d.example/", "title": "D", "order": 1, "lastUsed": 10]],
        "archive": ["a1": ["url": "https://old.example/", "title": "Old", "spaceId": "home", "closedAt": 5], "a2": ["url": "https://new.example/", "title": "New", "spaceId": "home", "closedAt": 9]],
        "settings": ["theme": "arcadia", "sidebarPinnedOpen": true],
        "themeSettings": ["arcadia": ["sidebarWidth": 280]],
    ]
    let state = DataSetWindowSource.state(values: { values[$0] ?? [:] }, active: [1: "work", 2: "gone"])
    check("hosted source: spaces in their order", (state["spaces"] as? [JSONObject])?.compactMap { $0["id"] as? String } == ["home", "work"])
    let pins = (state["pins"] as? [JSONObject]) ?? []
    check("hosted source: pins, a folder's kept and none for none", pins.first { $0["id"] as? String == "p1" }?["folderId"] as? String == "f1" && pins.first { $0["id"] as? String == "p2" }?["folderId"] == nil)
    check("hosted source: folders", (state["folders"] as? [JSONObject])?.first?["open"] as? Bool == false)
    let kept = state["keptTabs"] as? JSONObject ?? [:]
    check("hosted source: Margin's tabs are kept tabs (nothing open in its window yet), only of known spaces",
          kept.keys.sorted() == ["t-aaaaaaaaaa"] && (kept["t-aaaaaaaaaa"] as? JSONObject)?["wasActive"] as? Bool == true && (kept["t-aaaaaaaaaa"] as? JSONObject)?["lastActive"] as? Double == 1000)
    check("hosted source: no open tabs", (state["tabs"] as? JSONObject)?.isEmpty == true)
    check("hosted source: the archive newest first", (state["archive"] as? [JSONObject])?.compactMap { $0["id"] as? String } == ["a2", "a1"])
    check("hosted source: settings, each theme's own under themes", (state["settings"] as? JSONObject)?["theme"] as? String == "arcadia"
          && ((state["settings"] as? JSONObject)?["themes"] as? JSONObject)?["arcadia"] != nil)
    check("hosted source: each window's space, one that's gone left out", same(state["activeSpaceByWindow"], ["1": "work"]))
    values = [:]
    let empty = DataSetWindowSource.state(values: { values[$0] ?? [:] }, active: [:])
    check("hosted source: no data set yet: Personal, empty", (empty["spaces"] as? [JSONObject])?.first?["id"] as? String == "personal" && (empty["pins"] as? [Any])?.isEmpty == true)
    check("hosted source: as JSON", jsonString(state) != nil)

    // Choosing a space in a window is kept by the source, and drawn again; what it can't do changes nothing.
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-hosted-tests-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: folder) }
    let sync = DataSync(store: DataStore(root: folder, background: false))
    var shellHeard = 0
    sync.onChange = { _, _ in shellHeard += 1 }
    let source = DataSetWindowSource(data: sync, pick: { nil })
    var changed = 0
    source.onChange = { changed += 1 }
    let echo = Diagnostics.echo
    Diagnostics.echo = { _ in }
    source.perform("setSpace", ["spaceId": "personal", "windowId": 3])
    source.perform("pinTab", ["tabId": 4, "windowId": 3])
    source.perform("pinTab", ["tabId": 5, "windowId": 3])
    Diagnostics.echo = echo
    check("hosted source: a space chosen: drawn again, that window shows it", changed == 1 && same(source.snapshot()["activeSpaceByWindow"], ["3": "personal"]))
    check("hosted source: a request it can't do yet is counted, nothing drawn", source.unhandled["pinTab"] == 2 && changed == 1)
    source.perform("updateSettings", ["patch": ["sidebarPinnedOpen": false], "windowId": 3])
    source.perform("updateThemeSettings", ["themeId": "arcadia", "patch": ["sidebarWidth": 300], "windowId": 3])
    let settings = source.snapshot()["settings"] as? JSONObject
    check("hosted source: the sidebar kept open or not, and its width, kept in memory and drawn",
          changed == 3 && settings?["sidebarPinnedOpen"] as? Bool == false && ((settings?["themes"] as? JSONObject)?["arcadia"] as? JSONObject)?["sidebarWidth"] as? Int == 300)
    sync.onChange?(DataProfile(browser: "safari", profile: "P"), ["spaces"])
    check("hosted source: the shell still hears the data set's changes (the source's comes after)", shellHeard == 1)

    // ---- the page card's corners over a hosted window (HostCorners) ----
    do {
        let page = CGRect(x: 276, y: 41, width: 1228, height: 933)
        let squares = HostCorners.squares(page: page, radii: [6.25, 6.25, 6.25, 6.25])
        check("corners: one 7 pt square per corner, at the page area's corners (top left, clockwise)", squares.map(\.rect) == [
            CGRect(x: 276, y: 41, width: 7, height: 7), CGRect(x: 1497, y: 41, width: 7, height: 7),
            CGRect(x: 1497, y: 967, width: 7, height: 7), CGRect(x: 276, y: 967, width: 7, height: 7)] && squares.map(\.corner) == [0, 1, 2, 3] && squares.allSatisfy { $0.radius == 6.25 }, "\(squares)")
        check("corners: none for a square corner, a radius kept within half the page", HostCorners.squares(page: page, radii: [0, 15, 0, 0]).map(\.corner) == [1]
              && HostCorners.squares(page: CGRect(x: 0, y: 0, width: 20, height: 20), radii: [50, 50, 50, 50]).allSatisfy { $0.rect.width == 10 })
        // The mask: the corner's own point filled, the point just inside the curve not, for each corner (AppKit's y up).
        for corner in 0..<4 {
            let path = HostCorners.path(size: 7, radius: 6.25, corner: corner)
            let outer = CGPoint(x: corner == 0 || corner == 3 ? 0.3 : 6.7, y: corner == 0 || corner == 1 ? 6.7 : 0.3)
            let inner = CGPoint(x: corner == 0 || corner == 3 ? 6.5 : 0.5, y: corner == 0 || corner == 1 ? 0.5 : 6.5)
            check("corners: corner \(corner)'s mask fills the page's corner and leaves the curve's inside clear", path.contains(outer, using: .evenOdd) && !path.contains(inner, using: .evenOdd))
        }
        // A border's band: between the page area's curve and the card's outer edge; outside that, the card's fill.
        let band = HostCorners.band(size: 15, radius: 15, corner: 0, width: 3), out = HostCorners.path(size: 15, radius: 15, corner: 0, out: 3)
        let r = 15.0 / 2.0.squareRoot() // (a point on the diagonal `d` from the curve's centre: 15 - d/√2 in from the corner)
        func diagonal(_ d: Double) -> CGPoint { CGPoint(x: 15 - d / 2.0.squareRoot(), y: d / 2.0.squareRoot()) }
        check("corners: a border's band and the fill beyond it, the inside clear", band.contains(diagonal(16.5), using: .evenOdd) && !band.contains(diagonal(14), using: .evenOdd) && !band.contains(diagonal(19), using: .evenOdd)
              && out.contains(diagonal(19.5), using: .evenOdd) && !out.contains(diagonal(16.5), using: .evenOdd) && r > 0)
        let ink = HostCorners.color("rgb(17, 17, 17)"), frame = HostCorners.color("rgba(156, 157, 161, 0.5)"), srgb = HostCorners.color("color(srgb 1 0.5 0 / 1)")
        check("corners: the page's computed colours read (rgb, rgba, color(srgb))", abs((ink?.redComponent ?? 0) - 17.0 / 255) < 0.001 && frame?.alphaComponent == 0.5 && srgb?.greenComponent == 0.5)
        check("corners: a see-through or unknown colour isn't one", HostCorners.color("rgba(0, 0, 0, 0)") == nil && HostCorners.color("transparent") == nil && HostCorners.color("hsl(1 2 3)") == nil)
        let corners = HostCorners(harness: true)
        corners.show(page: CGRect(x: -20000, y: -20000, width: 800, height: 600), radii: [6.25, 6.25, 6.25, 6.25], fills: [.gray, .gray, .gray, .gray], edge: nil)
        let drawn = corners.draws
        corners.show(page: CGRect(x: -20000, y: -20000, width: 800, height: 600), radii: [6.25, 6.25, 6.25, 6.25], fills: [.gray, .gray, .gray, .gray], edge: nil)
        check("corners: shown off every display, four panels above normal windows that never take the mouse; the same again draws nothing",
              corners.isShown && corners.frames.count == 4 && corners.draws == drawn && corners.panels.allSatisfy { $0.level == .floating && $0.ignoresMouseEvents && $0.collectionBehavior == HostCorners.behavior })
        corners.show(page: CGRect(x: -20000, y: -20000, width: 900, height: 600), radii: [6.25, 6.25, 6.25, 6.25], fills: [.gray, .gray, .gray, .gray], edge: nil)
        check("corners: a new page area: drawn again, there", corners.draws == drawn + 1 && corners.frames[1].maxX == -20000 + 900)
        corners.hide()
        check("corners: hidden: none ordered in", !corners.isShown && corners.frames.isEmpty && corners.panels.allSatisfy { !$0.isVisible })
    }

    // ---- the corners where the real screen showed them wrong (2026-11-15: TestPane hosted in Arcadia, the page area
    // 250,41 1254×933 in a 1512×982 display): each panel's screen frame, its radius, and what it draws, pixel by pixel ----
    do {
        let page = CGRect(x: 250, y: 41, width: 1254, height: 933)
        let frames = HostCorners.panelFrames(page: page, radii: [6.25, 6.25, 6.25, 6.25], mainHeight: 982)
        // (AppKit's frames are bottom left: the top corners near y = 982 - 41 - 7, the bottom ones near 982 - 974.)
        check("corners on screen: the four panels' AppKit frames at the page area's own corners (top ones at the top, bottom ones at the bottom)", frames.map(\.frame) == [
            CGRect(x: 250, y: 934, width: 7, height: 7), CGRect(x: 1497, y: 934, width: 7, height: 7),
            CGRect(x: 1497, y: 8, width: 7, height: 7), CGRect(x: 250, y: 8, width: 7, height: 7)] && frames.map(\.corner) == [0, 1, 2, 3], "\(frames.map(\.frame))")
        check("corners on screen: back in the window server's coordinates, each touches its page corner exactly; each at the card's radius (6.25 pt, points not pixels)",
              frames.map { ScreenGeometry.appKitRect($0.frame, mainHeight: 982) }.enumerated().allSatisfy { i, r in
                  (i == 0 || i == 3 ? r.minX == page.minX : r.maxX == page.maxX) && (i == 0 || i == 1 ? r.minY == page.minY : r.maxY == page.maxY) } && frames.allSatisfy { $0.radius == 6.25 })
        check("corners on screen: the colours Arcadia's page reports for its frame read as its grey, all four",
              ["rgb(156, 157, 161)", "rgb(156, 157, 161)", "rgb(156, 157, 161)", "rgb(156, 157, 161)"].compactMap(HostCorners.color).allSatisfy { abs($0.redComponent * 255 - 156) < 0.5 && abs($0.greenComponent * 255 - 157) < 0.5 && abs($0.blueComponent * 255 - 161) < 0.5 })

        // What each panel draws (its layers rendered, at 4×): the corner's own point the fill, the curve's inside clear, the
        // border's band its colour; the layers' coordinates as the screen's (nothing flipped on the way up).
        func rendered(_ panel: NSPanel, scale: CGFloat = 4) -> (pixel: (CGFloat, CGFloat) -> [Int], flipped: Bool)? {
            guard let layer = panel.contentView?.layer else { return nil }
            let side = Int((panel.frame.width * scale).rounded())
            guard let ctx = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
            ctx.scaleBy(x: scale, y: scale)
            layer.render(in: ctx)
            var flipped = false
            for l in sequence(first: layer as CALayer?, next: { $0?.superlayer }) { if l?.isGeometryFlipped == true { flipped.toggle() } }
            let data = Array(UnsafeBufferPointer(start: ctx.data!.assumingMemoryBound(to: UInt8.self), count: side * side * 4)) // (copied: the context's goes with it)
            // (x, y in points, AppKit's y up; memory's first row is the top.)
            return ({ x, y in
                let px = min(side - 1, Int(x * scale)), py = min(side - 1, Int(y * scale))
                let i = (side - 1 - py) * side * 4 + px * 4
                return [Int(data[i]), Int(data[i + 1]), Int(data[i + 2]), Int(data[i + 3])]
            }, flipped)
        }
        let grey = HostCorners.color("rgb(156, 157, 161)")!
        let arcadia = HostCorners(harness: true)
        let off = CGRect(x: -20000, y: -20000, width: page.width, height: page.height)
        arcadia.show(page: off, radii: [6.25, 6.25, 6.25, 6.25], fills: [grey, grey, grey, grey], edge: nil)
        let want = HostCorners.panelFrames(page: off, radii: [6.25, 6.25, 6.25, 6.25])
        check("corners shown: each panel's frame is the computed one", arcadia.panels.prefix(4).map(\.frame) == want.map(\.frame), "\(arcadia.panels.map(\.frame))")
        for (i, panel) in arcadia.panels.prefix(4).enumerated() {
            guard let r = rendered(panel) else { check("corners drawn: corner \(i) renders", false); continue }
            // The page's corner point (outside the curve) and a point inside it, in the panel's own points (y up).
            let left = i == 0 || i == 3, top = i == 0 || i == 1
            let cornerPoint = (left ? 0.2 : 6.8, top ? 6.8 : 0.2), inside = (left ? 6.0 : 1.0, top ? 1.0 : 6.0)
            let c = r.pixel(cornerPoint.0, cornerPoint.1), clear = r.pixel(inside.0, inside.1)
            check("corners drawn: \(["top left", "top right", "bottom right", "bottom left"][i]): the frame's grey at the page's corner, clear inside the curve, nothing flipped",
                  abs(c[0] - 156) <= 2 && abs(c[1] - 157) <= 2 && abs(c[2] - 161) <= 2 && c[3] == 255 && clear[3] == 0 && !r.flipped, "\(c) \(clear)")
        }
        arcadia.hide()
        // Neubrutalism: a 3 pt ink border round a 12 pt card, its offset ink shadow at the bottom right, the gutter elsewhere.
        let ink = HostCorners.color("rgb(17, 17, 17)")!, gutter = HostCorners.color("rgb(240, 236, 228)")!
        let nb = HostCorners(harness: true)
        nb.show(page: off, radii: [9, 9, 9, 9], fills: [gutter, gutter, ink, gutter], edge: HostCorners.Edge(width: 3, color: ink))
        for (i, panel) in nb.panels.prefix(4).enumerated() {
            guard let r = rendered(panel) else { check("corners drawn (Neubrutalism): corner \(i) renders", false); continue }
            let left = i == 0 || i == 3, top = i == 0 || i == 1
            // (Along the diagonal from the curve's centre, 9 in from the corner: d < 9 the page, 9-12 the border, beyond the fill.)
            func at(_ d: CGFloat) -> [Int] {
                let o = d / 2.0.squareRoot()
                return r.pixel(left ? 9 - o : panel.frame.width - 9 + o, top ? panel.frame.height - 9 + o : 9 - o)
            }
            let fill = i == 2 ? [17, 17, 17] : [240, 236, 228]
            let page = at(7), band = at(10.5), beyond = at(12.6)
            check("corners drawn (Neubrutalism): \(["top left", "top right", "bottom right", "bottom left"][i]): clear inside, the ink border in its band, \(i == 2 ? "the ink shadow" : "the gutter") beyond",
                  page[3] == 0 && band[0] <= 20 && band[3] == 255 && zip(beyond.prefix(3), fill).allSatisfy { abs($0 - $1) <= 3 } && beyond[3] == 255, "\(page) \(band) \(beyond)")
        }
        nb.hide()
        // A square corner (Pixel): nothing drawn.
        let pixel = HostCorners(harness: true)
        pixel.show(page: off, radii: [0, 0, 0, 0], fills: [grey, grey, grey, grey], edge: nil)
        check("corners: square corners (Pixel): no panel", !pixel.isShown && pixel.panels.allSatisfy { !$0.isVisible })
        // A panel no longer shown (ordered in while another Space was current, gone with it): ordered in again though nothing changed.
        let again = HostCorners(harness: true)
        again.show(page: off, radii: [6.25, 6.25, 6.25, 6.25], fills: [grey, grey, grey, grey], edge: nil)
        again.panels[0].orderOut(nil)
        let draws = again.draws
        again.show(page: off, radii: [6.25, 6.25, 6.25, 6.25], fills: [grey, grey, grey, grey], edge: nil)
        check("corners: one gone from the screen is ordered in again (not drawn again)", again.panels[0].isVisible && again.reorders == 1 && again.draws == draws)
        again.hide()
        check("corners: the colour most corners have (Neubrutalism's ink shadow at one corner aside), none for none",
              HostCorners.common([gutter, gutter, ink, gutter]) == gutter && HostCorners.common([ink, grey]) == ink && HostCorners.common([]) == nil)
    }
}
