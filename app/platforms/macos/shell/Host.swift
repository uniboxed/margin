// The host (docs/MARGIN-APP.md phase 3): another app's window shown in Margin's page area. Its types, its
// marker and its options; the engine is HostEngine.swift, the system it runs on HostSystem.swift.
//
// Off unless `MarginHosted` is set (Shell.Options.hosted, from forApp) and the host's private calls passed their
// check (HostCalls.swift). Off, nothing of it runs, except a crashed run's marker being cleaned up at launch.

import AppKit

// What's hosted: an app by its bundle id, or a Safari window (a profile's; nil the default one).
nonisolated enum HostTarget: Hashable, Sendable {
    case app(String)
    case safariWindow(String?)

    var id: HostID {
        switch self {
        case .app(let bundle): return HostID(raw: "app:" + bundle)
        case .safariWindow(let profile): return HostID(raw: "safari:" + (profile ?? ""))
        }
    }
}

// One host. Logged as its bundle id, or "safari:default" / "safari:p<number>": never a profile's name.
nonisolated struct HostID: Hashable, Sendable, Codable, CustomStringConvertible {
    let raw: String
    var description: String {
        guard raw.hasPrefix("safari:") else { return raw }
        let profile = raw.dropFirst("safari:".count)
        guard !profile.isEmpty else { return "safari:default" }
        return "safari:p\(profile.utf8.reduce(UInt32(5381)) { ($0 &* 33) &+ UInt32($1) } % 10000)"
    }
}

nonisolated enum HostStep: String, Sendable, Codable {
    case margin = "Margin's Space" // Margin's window isn't in a full-screen Space of its own
    case launch, window
    case fullScreen = "full screen"
    case sidebar, tile, destroy, place, park, unpark
    case exitFullScreen = "exit full screen"
    case quit
    case windowMode = "window mode" // its window into Margin's Space as a window (one that can't go full screen)
}

// How a host is shown. `fullScreen`: its window full screen, its tile beside Margin's (the sidebar's) in Margin's
// Space. `window`: its normal window (one that can't go full screen: AXFullScreen not settable, or its full screen
// failed), moved into Margin's full-screen Space as a window and placed in the page area by Accessibility, Margin's
// window its whole width below it (DECISIONS.md "Apps that can't go full screen: window mode").
nonisolated enum HostMode: String, Codable, Sendable { case fullScreen = "full screen", window }

nonisolated enum HostResult: Equatable, Sendable {
    case shown(HostID, placed: Bool) // placed: its window fits the page area (within 1 pt)
    case failed(HostStep, String)
}

nonisolated enum HostEvent: Equatable, Sendable {
    case opened(HostID, ms: Int)
    case shown(HostID, ms: Int)
    case parked(HostID)
    case failed(HostID, HostStep, String)
    case outsideOpen(HostID) // LaunchServices heard someone open the app from outside (659)
    case promoted(HostID) // the no-Dock instance became a normal app with a Dock icon (561, or its policy read)
    case quitByUser(HostID) // the app quit, not by Margin
    case windowClosed(HostID) // its window went, its app still running
    case closed(HostID)
    case unshown(HostID) // the one shown parked with nothing in its place (Margin's window left full screen, its window strayed)
    case orphans([UInt64]) // ownerless full-screen Spaces found (Mission Control would list them)
}

nonisolated enum HostPolicy: Equatable, Sendable { case regular, accessory, prohibited }

// A running app, as the engine needs it: `launchedAt` (seconds since 1970) tells a pid used again from the one marked.
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

// The crash marker (hosted.json, beside parked.json): the apps this Margin started and the windows it hosts, with
// the Spaces it made or was leaving. Numbers, bundle ids and launch times only.
nonisolated struct HostMarker: Codable, Equatable, Sendable {
    static let fileName = "hosted.json"
    struct App: Codable, Equatable, Sendable {
        var pid: Int32
        var bundleId: String
        var launchedAt: Double?
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
    var pid: Int32 // this Margin's
    var marginSpace: UInt64?
    var apps: [App] = []
    var windows: [Window] = []
    var leftSpaces: [UInt64] = [] // emptied full-screen Spaces a destroy didn't take yet
    var leftSafariWindows: [SafariWindow]? = nil // (optional: a marker from before them reads)

    var isEmpty: Bool { apps.isEmpty && windows.isEmpty && leftSpaces.isEmpty && (leftSafariWindows ?? []).isEmpty && marginSpace == nil }

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
// `page`, the page area; `area`, the display's full-screen area the tiles divide (its frame below the camera housing);
// `tileWidth`, Margin's own tile (the sidebar's: its window's content max width), flush with the area's left edge.
// `windowed`: Margin's window its whole width (a window-mode host above it), `page` from its own layout, no tile.
nonisolated struct HostPlacement: Equatable, Sendable {
    var page: CGRect
    var area: CGRect
    var tileWidth: CGFloat
    var windowed = false
    static let zero = HostPlacement(page: .zero, area: .zero, tileWidth: 0)
    var text: String {
        func r(_ c: CGRect) -> String { "\(Int(c.minX)),\(Int(c.minY)) \(Int(c.width))×\(Int(c.height))" }
        return windowed ? "page \(r(page)) in \(r(area)), Margin's window its whole width" : "page \(r(page)) in \(r(area)), Margin's tile \(Int(tileWidth))"
    }
}

// The page area's edges and the tiles' spacing, from the placement alone: Margin's tile at the area's left edge (left
// 0), the page's other edges reserved at the Space's edges, the gap from Margin's tile to the page the spacing. Never
// from the windows' bounds now: right after a tile move the hosted window still has its full-screen frame while a
// reservation is already set, and a plan from that counted the reservation twice, growing it at every step (seen
// 2026-11-15: 0/7/8/8, then 0/14/16/16, then 0/21/24/24). The same placement always gives the same plan.
nonisolated enum HostLayout {
    // Nil: the page can't be reached that way (it starts before Margin's tile ends, passes the area, or leaves less
    // than a point).
    static func plan(_ p: HostPlacement) -> (edges: SlotEdges, spacing: Double)? {
        let edges = SlotEdges(left: 0, right: p.area.maxX - p.page.maxX, top: p.page.minY - p.area.minY, bottom: p.area.maxY - p.page.maxY).whole
        let spacing = Double(p.page.minX - (p.area.minX + p.tileWidth)).rounded()
        guard edges.usable, spacing >= 0, p.tileWidth >= 1, p.page.width >= 1, p.page.height >= 1, p.area.width >= 1 else { return nil }
        return (edges, spacing)
    }

    static func near(_ a: CGRect, _ b: CGRect, within: CGFloat = 1) -> Bool {
        abs(a.minX - b.minX) <= within && abs(a.minY - b.minY) <= within && abs(a.width - b.width) <= within && abs(a.height - b.height) <= within
    }
}
