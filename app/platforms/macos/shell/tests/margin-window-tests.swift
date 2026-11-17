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
    // Always full screen and not in: asked only when macOS would take it (Margin active, its window on the current
    // Space), looked at again with a back-off until it's in.
    var retry = FullScreenRetry()
    func ask(_ r: FullScreenRetry, inFullScreen: Bool = false, entering: Bool = false, closed: Bool = false, firstAsked: Bool = true, ready: Bool = true, since: TimeInterval = .infinity) -> Bool {
        r.shouldAsk(inFullScreen: inFullScreen, entering: entering, closed: closed, firstAsked: firstAsked, ready: ready, sinceLastAsk: since)
    }
    check("hosted: full screen: never asked before its first ask, while it's in, on its way in, or once closed", !ask(retry, firstAsked: false) && !ask(retry, inFullScreen: true) && !ask(retry, entering: true) && !ask(retry, closed: true))
    check("hosted: full screen: not asked while macOS wouldn't take it (Margin not active, or its window not on the current Space yet: opened from another app's full-screen Space)", !ask(retry, ready: false))
    check("hosted: full screen: asked once it would, and not twice within a quarter of a second", ask(retry) && !ask(retry, since: 0.1) && ask(retry, since: 0.3))
    let looks = (0..<7).map { _ in retry.nextLook() }
    check("hosted: full screen: looked at again after 0.3 s, doubling, then every 5 s, for as long as it isn't in (no end: Margin is always full screen)", looks == [0.3, 0.6, 1.2, 2.4, 5, 5, 5], "\(looks)")
    retry.takeable()
    check("hosted: full screen: macOS would take it after a wait: its looks from the shortest delay again (an ask still refused is made again soon)", retry.nextLook() == 0.3 && retry.nextLook() == 0.6)
    let forwards = [Double.infinity, 0.4, 1, 1.5, 60, 60].map { retry.shouldForward(sinceLast: $0) }
    check("hosted: full screen: while macOS wouldn't take it, Margin and its window brought forward a second apart, three times at most (never taking another app's keys look after look)",
          forwards == [true, false, true, true, false, false], "\(forwards)")
    retry.entered()
    check("hosted: full screen: in: the back-off and the forwards from the start again the next time", retry.nextLook() == 0.3 && retry.shouldForward(sinceLast: .infinity))
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

    // ---- a theme's settings changed in Margin's window (the sidebar's width, dragged) last across launches ----
    do {
        var stored: [String: JSONObject] = ["arcadia": ["sidebarWidth": 300]]
        var writes = 0
        let keeper = ThemeSettingsKeeper(read: { stored }, write: { stored = $0; writes += 1 })
        func source() -> DataSetWindowSource { DataSetWindowSource(data: DataSync(store: DataStore(root: tempFolder("window-theme-settings"))), pick: { nil }, keeper: keeper) }
        func width(_ s: DataSetWindowSource, _ theme: String) -> Any? { (((s.snapshot()["settings"] as? JSONObject)?["themes"] as? JSONObject)?[theme] as? JSONObject)?["sidebarWidth"] }
        let first = source()
        check("theme settings: what was kept is the theme's setting from the start", int(width(first, "arcadia")) == 300 && writes == 0)
        first.perform("updateThemeSettings", ["themeId": "arcadia", "patch": ["sidebarWidth": 342], "windowId": 1])
        first.perform("updateThemeSettings", ["themeId": "pixel", "patch": ["sidebarWidth": "280px"], "windowId": 1])
        check("theme settings: a width dragged is written as it's saved, each theme its own", writes == 2 && int(stored["arcadia"]?["sidebarWidth"]) == 342 && stored["pixel"]?["sidebarWidth"] as? String == "280px", "\(stored)")
        let next = source()
        check("theme settings: the next launch draws the width that was dragged", int(width(next, "arcadia")) == 342 && width(next, "pixel") as? String == "280px")
        let plain = DataSetWindowSource(data: DataSync(store: DataStore(root: tempFolder("window-theme-settings-none"))), pick: { nil })
        plain.perform("updateThemeSettings", ["themeId": "arcadia", "patch": ["sidebarWidth": 500], "windowId": 1])
        check("theme settings: no keeper (a test's, the harness's): in memory only, nothing written", writes == 2 && int(width(plain, "arcadia")) == 500)
        let cleaned = ThemeSettingsKeeper.clean(["arcadia": ["sidebarWidth": 300, "name": "x", "on": true, "list": [1, 2], "nested": ["a": 1], "long": String(repeating: "x", count: 201)], "bad": "not settings", "empty": [String: Any]()])
        check("theme settings: only numbers, short strings and switches are kept, per theme", Set(cleaned.keys) == ["arcadia"] && Set(cleaned["arcadia"]?.keys.map { $0 } ?? []) == ["sidebarWidth", "name", "on"], "\(cleaned)")
    }

    // ---- the window's ground with the page area cut out of it (WindowGroundView): Margin's window in front of what it hosts ----
    do {
        let ground = WindowGroundView(frame: NSRect(x: 0, y: 0, width: 1512, height: 949))
        check("ground: hidden, nothing drawn, while nothing shows through (the window's own background fills it)", !ground.isShown && ground.isHidden && !ground.fills(CGPoint(x: 700, y: 400)) && ground.hitTest(NSPoint(x: 10, y: 10)) == nil)
        // The hosted window at the page area beside a 260 pt sidebar, top left in the content; the card's corners 10 pt.
        let hosted = CGRect(x: 260, y: 8, width: 1244, height: 933)
        ground.show(color: .gray, hole: hosted, radii: [10, 10, 10, 10])
        check("ground: the hosted window's bounds cut out (it shows through there), the ground everywhere else of the content",
              ground.isShown && !ground.fills(CGPoint(x: 700, y: 400)) && !ground.fills(CGPoint(x: 261, y: 400)) && ground.fills(CGPoint(x: 250, y: 400)) && ground.fills(CGPoint(x: 700, y: 4))
              && ground.fills(CGPoint(x: 1508, y: 400)) && ground.fills(CGPoint(x: 700, y: 945)) && ground.hole == hosted && ground.color == .gray)
        check("ground: the hole's corners rounded as the page card's: outside the curve is the ground's, inside it the hosted window's",
              ground.fills(CGPoint(x: 261, y: 9)) && ground.fills(CGPoint(x: 1503, y: 9)) && ground.fills(CGPoint(x: 1503, y: 940)) && ground.fills(CGPoint(x: 261, y: 940))
              && !ground.fills(CGPoint(x: 264, y: 12)) && !ground.fills(CGPoint(x: 1500, y: 937)))
        let draws = ground.draws
        ground.show(color: .gray, hole: hosted, radii: [10, 10, 10, 10])
        check("ground: shown as it is already: not drawn again", ground.draws == draws)
        // A hosted window kept at a frame it had (the sidebar narrower now): square where it doesn't meet the card's corners.
        ground.show(color: .gray, hole: hosted, radii: [0, 10, 10, 0])
        check("ground: a corner of the hole that isn't the page card's is square", !ground.fills(CGPoint(x: 261, y: 9)) && !ground.fills(CGPoint(x: 261, y: 940)) && ground.fills(CGPoint(x: 1503, y: 9)) && ground.draws == draws + 1)
        // What it draws (its layer rendered): clear in the hole, the colour around it and outside the corner's curve.
        ground.show(color: NSColor(srgbRed: 156 / 255, green: 157 / 255, blue: 161 / 255, alpha: 1), hole: hosted, radii: [10, 10, 10, 10])
        if let layer = ground.layer, let ctx = CGContext(data: nil, width: 1512, height: 949, bitsPerComponent: 8, bytesPerRow: 1512 * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                                         bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
            layer.render(in: ctx)
            let data = Array(UnsafeBufferPointer(start: ctx.data!.assumingMemoryBound(to: UInt8.self), count: 1512 * 949 * 4))
            // (x, y from the top left, as the content; memory's first row is the top.)
            func pixel(_ x: Int, _ y: Int) -> [Int] { let i = (y * 1512 + x) * 4; return [Int(data[i]), Int(data[i + 1]), Int(data[i + 2]), Int(data[i + 3])] }
            let grey = [156, 157, 161, 255]
            func near(_ a: [Int], _ b: [Int]) -> Bool { zip(a, b).allSatisfy { abs($0 - $1) <= 2 } }
            check("ground drawn: nothing in the hole (alpha 0 at its middle, just inside each edge and inside each corner's curve)",
                  [pixel(880, 470), pixel(262, 470), pixel(1502, 470), pixel(880, 10), pixel(880, 939), pixel(265, 13), pixel(1499, 936)].allSatisfy { $0[3] == 0 }, "\(pixel(880, 470)) \(pixel(265, 13))")
            check("ground drawn: its colour around the hole and outside each corner's curve (the page card's rounded corners are never see-through)",
                  [pixel(100, 470), pixel(880, 3), pixel(1508, 470), pixel(880, 945), pixel(260, 8), pixel(1503, 8), pixel(1503, 940), pixel(260, 940)].allSatisfy { near($0, grey) }, "\(pixel(260, 8)) \(pixel(1503, 940))")
        } else { check("ground drawn: its layer renders", false) }
        ground.clear()
        check("ground: cleared: hidden again, nothing kept", !ground.isShown && ground.color == nil && ground.hole == nil && !ground.fills(CGPoint(x: 250, y: 400)))
    }

    // ---- the ground's colour from what the page says it draws around the card's corners (PageFill) ----
    do {
        let grey = PageFill.color("rgb(156, 157, 161)"), gutter = PageFill.color("rgb(240, 236, 228)"), ink = PageFill.color("rgb(17, 17, 17)")
        check("page fill: a computed colour read (rgb, rgba, color(srgb …)); none for a see-through one or anything else",
              grey == NSColor(srgbRed: 156 / 255, green: 157 / 255, blue: 161 / 255, alpha: 1) && PageFill.color("rgba(0, 0, 0, 0.5)")?.alphaComponent == 0.5
              && PageFill.color("color(srgb 0.801961 0.768627 0.939216)") != nil && PageFill.color("rgba(0, 0, 0, 0)") == nil && PageFill.color("red") == nil && PageFill.color("") == nil)
        check("page fill: the colour most corners have (Neubrutalism's ink shadow at one corner aside), none for none",
              PageFill.common([gutter, gutter, ink, gutter].compactMap { $0 }) == gutter && PageFill.common([ink, grey].compactMap { $0 }) == ink && PageFill.common([]) == nil)
        check("front: the raised level is one above normal and below floating (a hosted app's panels, menus and tooltips still come above Margin's window)",
              FrontMechanism.raised.rawValue == NSWindow.Level.normal.rawValue + 1 && FrontMechanism.raised.rawValue < NSWindow.Level.floating.rawValue)
    }
}
