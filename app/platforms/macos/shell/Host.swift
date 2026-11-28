// The host (docs/MARGIN-APP.md phase 3): another app's window shown in Margin's page area. Its types, its
// marker and its options; the engine is HostEngine.swift, the system it runs on HostSystem.swift.
//
// Off unless the host's private calls passed their check (HostCalls.swift). Off, nothing of it runs.

import AppKit
import MarginCore

// What's hosted: an app by its bundle id, or a Safari window (a profile's; nil the default one) in a role
// (docs/PEEK-SPLIT.md §1): the profile's main window (the item shown, as before), its card (the preview card and Quick Tab) or a
// split's pane (1...3: a split's web panes of one profile after the first, which uses the main window).
nonisolated enum HostTarget: Hashable, Sendable {
    case app(String)
    case safariWindow(String?, SafariRole = .main)

    var id: HostID {
        switch self {
        case .app(let bundle): return HostID(raw: "app:" + bundle)
        case .safariWindow(let profile, let role): return HostID(raw: "safari:" + (profile ?? "") + role.suffix)
        }
    }
}

// Which of a profile's Safari windows: its main one (one per profile, as before), its card, or a split's pane.
nonisolated enum SafariRole: Hashable, Sendable, CustomStringConvertible {
    case main, card
    case pane(Int) // 1...3
    // In the host's id: nothing for main (its id, markers, routes and logs as before), else `#card`, `#pane1`...
    var suffix: String {
        switch self {
        case .main: return ""
        case .card: return "#card"
        case .pane(let n): return "#pane\(n)"
        }
    }
    var description: String { self == .main ? "main" : String(suffix.dropFirst()) }
    // A split's pane window (docs/PEEK-SPLIT.md §4).
    var isPane: Bool { if case .pane = self { return true }; return false }
    // From an id's suffix (`card`, `pane2`); nil: not a role.
    init?(suffix s: Substring) {
        if s == "card" { self = .card; return }
        if s.hasPrefix("pane"), let n = Int(s.dropFirst(4)), (1...3).contains(n) { self = .pane(n); return }
        return nil
    }
}

// One host. Logged as its bundle id, or "safari:default" / "safari:p<number>" (`#card`, `#pane1`... after it for a
// window in another role): never a profile's name.
nonisolated struct HostID: Hashable, Sendable, Codable, CustomStringConvertible {
    let raw: String
    var description: String {
        guard raw.hasPrefix("safari:") else { return raw }
        let (profile, role) = safariParts
        let suffix = role?.suffix ?? ""
        guard !profile.isEmpty else { return "safari:default" + suffix }
        return "safari:p\(profile.utf8.reduce(UInt32(5381)) { ($0 &* 33) &+ UInt32($1) } % 10000)" + suffix
    }
    // A Safari host's profile (as in its id) and its role (nil: main).
    private var safariParts: (profile: String, role: SafariRole?) {
        let rest = raw.dropFirst("safari:".count)
        guard let hash = rest.lastIndex(of: "#"), let role = SafariRole(suffix: rest[rest.index(after: hash)...]) else { return (String(rest), nil) }
        return (String(rest[..<hash]), role)
    }
    // Its Safari role (main for an app's, and for a main window's id).
    var safariRole: SafariRole { raw.hasPrefix("safari:") ? safariParts.role ?? .main : .main }
    // The id of its profile's main window (itself for main and for an app's): what routes are kept by, so a card that
    // loops demotes its Safari as a whole, as an app's rule does.
    var main: HostID { raw.hasPrefix("safari:") && safariParts.role != nil ? HostID(raw: "safari:" + safariParts.profile) : self }
}

// A visible host's role in a Margin window's page area (docs/PEEK-SPLIT.md "Words"): `main` (the item shown, at the
// page area unless a split gives it a pane's rect), `pane` (a split's other panes), `card` (the preview card's and Quick Tab's,
// above the rest).
nonisolated enum HostRole: String, Hashable, Sendable { case main, pane, card }

// A host visible in Margin's page area now, as the engine holds it (docs/PEEK-SPLIT.md §1): its rect (nil: the page
// area), its role, its place back to front (`z`, 0 the backmost).
nonisolated struct HostVisible: Equatable, Sendable {
    var rect: CGRect?
    var role: HostRole
    var z: Int
}

// One of a layout's hosts other than main, as it's asked for (`HostEngine.setLayout`): its target, its role, its rect.
nonisolated struct HostExtra: Equatable, Sendable {
    var target: HostTarget
    var role: HostRole
    var rect: CGRect
}

// A visible host's window, as Margin's window is told it (`HostEngine.hostedWindows`): its window, where it should be
// (its rect), its role, its place back to front, whether it's in place (shown at its rect: its hole may open).
// A cut pane's sides (docs/PEEK-SPLIT.md §4b): each one where part of its window is hidden that its arrow slides into
// its pane (its tile's rect: past the display's edge too); none that would put it over a cut pane lying over it.
nonisolated enum PaneSide: String, Sendable, CaseIterable { case left, right, up, down }
nonisolated struct PaneCut: Equatable, Sendable {
    var sides: Set<PaneSide> = []
}

// A cut pane's window slid by its arrow (docs/PEEK-SPLIT.md §4b): the pane it was slid in, its alignment along each axis
// (true: its end at the pane's end; nil: away from the other panes).
nonisolated struct PaneSlide: Equatable, Sendable {
    var pane: CGRect
    var endX: Bool?
    var endY: Bool?
}

nonisolated struct HostShownWindow: Equatable, Sendable {
    var window: Int
    var rect: CGRect // its pane (its hole); the page area for one shown alone
    var role: HostRole
    var z: Int
    var focused: Bool
    // Its window's frame: wider or taller than `rect` for a cut pane (docs/PEEK-SPLIT.md §4b); `rect` otherwise.
    var frame: CGRect = .zero
    // Cut and lying under another pane: kept behind it (a press on it delivered to its window without a raise:
    // PaneClickTap.swift).
    var tucked = false
    var cut: PaneCut? // its sides' arrows (nil: not cut)
}

nonisolated enum HostStep: String, Sendable, Codable {
    case margin = "Margin's Space" // Margin's window isn't in a full-screen Space of its own
    case launch, window
    case fullScreen = "full screen"
    case sidebar, destroy, place, park, unpark
    case member = "into Margin's Space" // its full-screen window moved into Margin's Space as a member
    case exitFullScreen = "exit full screen"
    case quit
    case windowMode = "window mode" // its window into Margin's Space as a window (one that can't go full screen)
    case superseded // its first open given up while its window was awaited: another item was picked in the meantime
    // Given its Dock icon for full screen and still unable (docked.rs): quit and opened again with none (an app with a Dock
    // icon whose window can't go full screen isn't shown in Margin's full-screen Space: seen 2026-11-28). Never said:
    // the open goes on at once.
    case redock = "opened again with no Dock icon"
}

// How a host is shown, Margin's window its whole width below it either way. `fullScreen`: its window full screen in a
// Space of its own, sized to the page area by that Space's edge reservation, then moved into Margin's full-screen Space
// as a plain member and its own Space destroyed (DECISIONS.md "Hosted apps as members of Margin's Space"); parked and
// shown again by moving it, still full screen. `window`: its normal window (one that can't go full screen: AXFullScreen
// not settable, or its full screen failed), moved into Margin's full-screen Space as a window and placed in the page
// area by Accessibility (DECISIONS.md "Almost every app in Margin: window mode").
nonisolated enum HostMode: String, Codable, Sendable { case fullScreen = "full screen", window }

nonisolated enum HostResult: Equatable, Sendable {
    case shown(HostID, placed: Bool) // placed: its window fits the page area (within 1 pt)
    case failed(HostStep, String)
}

nonisolated enum HostEvent: Equatable, Sendable {
    case opened(HostID, ms: Int)
    case shown(HostID, ms: Int)
    case revealed(HostID) // its window in Margin's Space at the page area mid-way through its show: Margin's window opens onto it
    case parked(HostID)
    case failed(HostID, HostStep, String)
    case outsideOpen(HostID) // LaunchServices heard someone open the app from outside (659)
    case promoted(HostID) // the no-Dock instance became a normal app with a Dock icon (561, or its policy read)
    case quitByUser(HostID) // the app quit, not by Margin
    case windowClosed(HostID) // its window went, its app still running
    case closed(HostID)
    case unshown(HostID) // the one shown parked with nothing in its place (Margin's window left full screen, its window strayed)
    case orphans([UInt64]) // ownerless full-screen Spaces found (Mission Control would list them)
    case listed([UInt64]) // a hosted window's own full-screen Space still listed after an operation (Mission Control shows it)
}

nonisolated enum HostPolicy: Equatable, Sendable { case regular, accessory, prohibited }

// A running app, as the engine needs it: `launchedAt` (seconds since 1970) tells a pid used again from the one marked.
// How Safari lays out a hosted window's shown page, its own word (content/page-scale.ts `layout`): its scale (below 1:
// drawn shrunk to fit), its layout width (CSS px), whether what was asked for was met.
nonisolated struct HostPageLayout: Equatable, Sendable {
    var scale: Double
    var inner: Double
    var met: Bool
}

nonisolated struct HostApp: Equatable, Sendable {
    let pid: pid_t
    let bundleId: String
    let launchedAt: Double?
}

// One of an app's windows, as Accessibility lists it (a standard window, or one whose AXFullScreen is settable).
nonisolated struct HostWindow: Equatable, Sendable {
    let number: Int
    let fullScreen: Bool
    var canFullScreen = true // AXFullScreen settable (no: shown in window mode)
    var resizable = true // AXSize settable (no: a fixed-size window, only moved)
    // Its green button there and enabled (AXZoomButton or AXFullScreenButton): a titled window AppKit's own full-screen
    // rule looks at (a dialog or panel has none). An app with no Dock icon reports its main window as an AXDialog, so
    // the subrole can't tell (seen 2026-11-28, the real-screen suite's implicitFullScreen).
    var zoomable = true
    var minimized = false
    var role: String? = nil // its role and subrole, when found by its number (for the log)
}

// A Safari window a profile's copy made for Margin (its `newWindow` answer): the copy's id for it, and its bounds as
// the copy's `windows` list has them (top-left coordinates, as the window server's), if it said.
nonisolated struct HostSafariWindow: Equatable, Sendable {
    let id: Int
    let bounds: CGRect?
}

// Safari's own sidebar in a hosted window: it must be hidden there (with it open, the window doesn't take the page
// area's size). Read from its View menu's item (SafariAX).
nonisolated enum HostSidebar: Equatable, Sendable { case open, closed, unknown }

// The crash marker (hosted.json): the apps this Margin started and the windows it hosts, with
// the Spaces it made or was leaving. Numbers, bundle ids and launch times only.
nonisolated struct HostMarker: Codable, Equatable, Sendable {
    static let fileName = "hosted.json"
    struct App: Codable, Equatable, Sendable {
        var pid: Int32
        var bundleId: String
        var launchedAt: Double?
        // Asked to quit (as Margin quit, or by its row's close) and still running then (Margin doesn't wait for an app's
        // exit): the next launch asks again only if that same launch still runs (it didn't quit: unsaved work), and says so.
        var quitAsked: Bool? = nil
    }
    struct Window: Codable, Equatable, Sendable {
        var number: Int
        var pid: Int32
        var ownSafariWindow: Bool // a window Margin made in a Safari it didn't start: never quit, only out of full screen
        var privateSpace: UInt64?
        var fullScreenSpace: UInt64?
        // A Safari window a copy made for Margin: the copy's id for it, its profile (the copy's own id), and when
        // that Safari started (a pid used again by another Safari is never taken for it).
        var safariWindow: Int? = nil
        var profile: String? = nil
        var appLaunchedAt: Double? = nil // (also an app the person opened: a pid used again is never taken for it)
        // Window mode and the person's own apps (2026-11-15): what giving the window back needs after a crash.
        var mode: HostMode? = nil // nil: full screen (a marker from before)
        var bundleId: String? = nil
        var personApp: Bool? = nil // an app the person opened (its Dock icon, running before Margin hosted it): never quit
        var frame: CGRect? = nil // its frame before Margin moved it (top-left coordinates)
        var originalSpace: UInt64? = nil // the Space it was in before (a Desktop)
        var frameChanged: Bool? = nil // Margin set its frame and hasn't put it back yet
        var resizable: Bool? = nil
        // A full-screen window moved into Margin's Space as a member (its own Space destroyed): still full screen,
        // shown there or parked in `privateSpace`; given back by leaving full screen on the current Space.
        var member: Bool? = nil
        // Live resize: its own tile, in Margin's Space (`marginSpace`): a member there, sized by the tile's rect. After a
        // crash Margin's Space has no owner and its first two tiles fall into a visible split: each window is taken out of
        // full screen (its tile goes with it), the tiles left destroyed, then that Space.
        var tile: UInt64? = nil
    }
    // A Safari window Margin asked a copy for and whose close wasn't confirmed: closed by that copy later (the poll,
    // the next launch's recovery). `number`: the window server's, when it was found.
    struct SafariWindow: Codable, Equatable, Sendable {
        var safariWindow: Int
        var profile: String?
        var pid: Int32
        var appLaunchedAt: Double?
        var number: Int?
    }
    // An app a split's pane kept active (PanesActive.swift): deactivated by the next launch after a crash if it still
    // takes itself for the active app (that same launch, not the front one).
    struct Kept: Codable, Equatable, Sendable {
        var pid: Int32
        var window: Int
        var bundleId: String?
        var launchedAt: Double?
    }
    var pid: Int32 // this Margin's
    var marginSpace: UInt64?
    var apps: [App] = []
    var windows: [Window] = []
    var leftSpaces: [UInt64] = [] // emptied full-screen Spaces a destroy didn't take yet
    var leftSafariWindows: [SafariWindow]? = nil // (optional: a marker from before them reads)
    // Live resize: Margin's own tile in `marginSpace`, and hosted tiles whose host went, not destroyed yet.
    var marginTile: UInt64? = nil
    var goneTiles: [UInt64]? = nil
    var anchors: [UInt64]? = nil // Margin's own empty tiles at its Space's front (a killed Margin leaves them there)
    var keptActive: [Kept]? = nil // (optional: a marker from before them reads)

    var isEmpty: Bool { apps.isEmpty && windows.isEmpty && leftSpaces.isEmpty && (leftSafariWindows ?? []).isEmpty && marginSpace == nil && (goneTiles ?? []).isEmpty && (anchors ?? []).isEmpty && (keptActive ?? []).isEmpty }

    static func read(_ url: URL) -> HostMarker? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(HostMarker.self, from: data)
    }

    func write(_ url: URL) -> Bool {
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            try encoder.encode(self).write(to: url, options: .atomic)
            return true
        } catch { return false }
    }
}

// Where a hosted window goes, as Margin's window works it out (top-left coordinates, as the window server's bounds):
// `page`, the page area (from Margin's own layout, its window its whole width: the theme's frame drawn around it);
// `area`, the display's full-screen area (its frame below the camera housing), which a full-screen window's own Space
// lays its window out in. `display`: that display's whole frame (zero: not known), which a hosted window's tile in
// Margin's Space is laid out in (its rect from the display's top left, the menu bar's band included: `HostLayout.tile`).
nonisolated struct HostPlacement: Equatable, Sendable {
    var page: CGRect
    var area: CGRect
    var display: CGRect = .zero
    static let zero = HostPlacement(page: .zero, area: .zero)
    var text: String {
        func r(_ c: CGRect) -> String { "\(Int(c.minX)),\(Int(c.minY)) \(Int(c.width))×\(Int(c.height))" }
        return "page \(r(page)) in \(r(area))"
    }
}

// The edges a hosted window's own full-screen Space reserves so its window is the page area: the page's distances from
// the area's four edges, whole points. From the placement alone, never from the windows' bounds (seen 2026-11-15: a plan
// read from bounds mid-transition counted a reservation twice and grew at every step), so the same placement always
// gives the same reservation.
nonisolated enum HostLayout {
    // The hosting core's (margin-core: app/shared/core/src/host/layout.rs), through its typed calls (no JSON: a drag
    // asks every frame). Nil: the page can't be reached that way (it passes the area, or leaves less than a point).
    static func plan(_ p: HostPlacement) -> SlotEdges? {
        var pl = p.margin
        var e = MarginEdges()
        guard margin_layout_plan(&pl, &e) else { return nil }
        return SlotEdges(left: e.left, right: e.right, top: e.top, bottom: e.bottom)
    }

    // A hosted window's tile rect in Margin's Space that puts its full-screen window at the page area: `home` (Margin's
    // own tile, the display's from its top left, the menu bar's band included) less the plan's edges. The kit
    // (2026-11-17): home 0,0 1512×982, page 248,41 1256×933 in 0,33 1512×949 → tile 248,8 1256×966.
    static func tile(_ p: HostPlacement, home: CGRect) -> CGRect? {
        var pl = p.margin
        var out = MarginRect()
        guard margin_layout_tile(&pl, home.marginRect, &out) else { return nil }
        return CGRect(out)
    }

    // Where a window that can't be smaller than `min` goes for a page area: the page area itself when it's at least
    // that big; else that minimum (within the area), its right edge and top the page area's (what's wider lies under
    // the sidebar). Never a size the window can't take (2026-11-18: Weather left its tile sent 2 pt under its minimum).
    static func fit(_ page: CGRect, min: CGSize?, in area: CGRect) -> CGRect {
        CGRect(margin_layout_fit(page.marginRect, Double(min?.width ?? 0), Double(min?.height ?? 0), area.marginRect))
    }

    // A split pane's window frame (docs/PEEK-SPLIT.md §4b): the pane itself when its window can be that small, else the
    // window at its own minimum, at its start (left, top) or end (right, bottom) along each axis, nil away from the other
    // panes of `page` (the split's page area): margin-core's `cut`. The rest of it past the display's edge, under Margin's
    // window or under a neighbour pane.
    static func cut(_ pane: CGRect, min: CGSize?, in area: CGRect, page: CGRect, endX: Bool?, endY: Bool?) -> CGRect {
        func end(_ v: Bool?) -> Int8 { v.map { $0 ? 1 : 0 } ?? -1 }
        return CGRect(margin_layout_cut(pane.marginRect, Double(min?.width ?? 0), Double(min?.height ?? 0), area.marginRect, page.marginRect, end(endX), end(endY)))
    }

    // A frame held within the area, moved, never resized (margin-core's `within`): a cut pane's window while it isn't a
    // tile in Margin's Space (its own Space's reservation can't pass the display).
    static func within(_ frame: CGRect, _ area: CGRect) -> CGRect { CGRect(margin_layout_within(frame.marginRect, area.marginRect)) }

    // Margin's own tile: the display's whole frame, from its top left (nil: the display isn't known).
    static func home(_ p: HostPlacement) -> CGRect? {
        var pl = p.margin
        var out = MarginRect()
        guard margin_layout_home(&pl, &out) else { return nil }
        return CGRect(out)
    }

    // Each of x, y, width and height within `within` points, the edge included (margin-core's `near`, typed: the waits
    // ask it every few milliseconds).
    static func near(_ a: CGRect, _ b: CGRect, within: CGFloat = 1) -> Bool { margin_layout_near(a.marginRect, b.marginRect, Double(within)) }

    // A window-mode window (margin-core's `inside`, `window_frame`, `at_page_area`): its own size centred in its page
    // area at whole points; its frame from where it is now (nil: there already, or placed before and at its own limits
    // centred); whether its bounds are where that puts it.
    static func inside(_ page: CGRect, _ size: CGSize) -> CGRect { CGRect(margin_layout_inside(page.marginRect, Double(size.width), Double(size.height))) }
    static func windowFrame(_ page: CGRect, now: CGRect, resizable: Bool, placedBefore: Bool, within: CGFloat) -> CGRect? {
        var out = MarginRect()
        return margin_layout_window_frame(page.marginRect, now.marginRect, resizable, placedBefore, Double(within), &out) ? CGRect(out) : nil
    }
    static func atPageArea(_ bounds: CGRect, _ area: CGRect, within: CGFloat) -> Bool { margin_layout_at_page_area(bounds.marginRect, area.marginRect, Double(within)) }

    // A full-screen window's room above it for its own toolbar window (margin-core's `TOOLBAR_ROOM`: 52 pt).
    static var toolbarRoom: CGFloat { CGFloat(margin_layout_toolbar_room()) }
}

// Which of an app's windows is hosted. Seen 2026-11-15 (a stand-alone probe of Dictionary started with no Dock icon):
// the app makes three server windows of the same size and a smaller one, only one of them ordered in (on screen);
// before its activation Accessibility lists all three (AXDialog), after it only the real one (AXStandardWindow), which is
// also its main and focused window. The window server's front window was a spare: moved into Margin's Space, it was
// never listed and the open failed. So, with no per-app rule, in this order:
//   1. Accessibility's main window, else its focused one (their numbers), when readable;
//   2. the window server's window that's on screen (the current Space's, ordered in);
//   3. a window Accessibility lists as a standard one (or one that can go full screen);
//   4. one in a Space (a spare never ordered in is in none);
//   5. the window server's front one (its only one, or nothing tells them apart: said so).
// Never an off-screen window while an on-screen one of the same size is there. Rules 2, 4 and 5 (the window server's
// alone) only when `serverAllowed` (the engine's timing: an app Margin started may still be making its window).
nonisolated enum HostWindowChoice {
    enum Rule: String, Equatable, Sendable {
        case main = "Accessibility's main window"
        case focused = "Accessibility's focused window"
        case onScreen = "the window server's one on screen"
        case standard = "a standard window as Accessibility lists it"
        case inSpace = "the one in a Space (the others in none: never ordered in)"
        case front = "the window server's front one (nothing else told them apart)"
        case only = "its only window by the window server"
        case fullScreen = "its one window already in a full-screen Space of its own"

        init?(core: String) {
            switch core {
            case "main": self = .main
            case "focused": self = .focused
            case "onScreen": self = .onScreen
            case "standard": self = .standard
            case "inSpace": self = .inSpace
            case "front": self = .front
            case "only": self = .only
            default: return nil
            }
        }
    }

    // An app's windows Margin could host, by the window server: layer 0, drawn, at least 100×100, not `excluded`
    // (hosted already, or minimized), front first (the core's rule).
    static func candidates(_ server: [ServerWindow], pid: pid_t, excluded: (Int) -> Bool = { _ in false }) -> [ServerWindow] {
        let mine = server.filter { $0.pid == pid }
        guard !mine.isEmpty else { return [] }
        let answer = HostCore.shared.call(["type": "candidates", "server": mine.map(\.coreJSON), "pid": Int(pid), "excluded": mine.map(\.number).filter(excluded)])
        let numbers = (answer["candidates"] as? [NSNumber] ?? []).map(\.intValue)
        let byNumber = Dictionary(mine.map { ($0.number, $0) }, uniquingKeysWith: { a, _ in a })
        return numbers.compactMap { byNumber[$0] }
    }

    // `candidates` (front first; empty: the window server's list didn't read), whether each is in a Space (asked only
    // when the rule that needs it is reached), Accessibility's main and focused windows, the windows it lists as
    // hostable (`standard`). Nil: none chosen (yet).
    static func choose(candidates: [ServerWindow], inSpace: (Int) -> Bool, main: Int?, focused: Int?, standard: [Int], serverAllowed: Bool) -> (number: Int, rule: Rule)? {
        // (Which are in a Space: read only when the last rules can be reached, as the rules read it last.)
        let spaces = serverAllowed && candidates.count > 1 ? candidates.map(\.number).filter(inSpace) : []
        var request: [String: Any] = ["type": "choose", "server": candidates.map(\.coreJSON), "pid": Int(candidates.first?.pid ?? 0), "inSpace": spaces,
                                      "standard": standard, "serverAllowed": serverAllowed, "main": coreOptional(main), "focused": coreOptional(focused)]
        if candidates.isEmpty { request["pid"] = 0 }
        let answer = HostCore.shared.call(request)
        guard let c = answer["choice"] as? [String: Any], let n = (c["number"] as? NSNumber)?.intValue, let rule = (c["rule"] as? String).flatMap(Rule.init(core:)) else { return nil }
        return (n, rule)
    }
}
