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
}

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
    case orphans([UInt64]) // ownerless full-screen Spaces found (Mission Control would list them)
}

nonisolated enum HostPolicy: Equatable, Sendable { case regular, accessory, prohibited }

// A running app, as the engine needs it: `launchedAt` (seconds since 1970) tells a pid used again from the one marked.
nonisolated struct HostApp: Equatable, Sendable {
    let pid: pid_t
    let bundleId: String
    let launchedAt: Double?
}

// One of an app's windows that can go full screen (Accessibility's AXFullScreen is settable).
nonisolated struct HostWindow: Equatable, Sendable {
    let number: Int
    let fullScreen: Bool
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
        var appLaunchedAt: Double? = nil
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

// The page area's other edges, worked out from what the window manager has laid out now: Margin's tile on the left
// (its window's width is its content's max width, the sidebar's), the hosted window's tile beside it.
nonisolated enum HostLayout {
    // `margin`, `hosted`: both windows' bounds now; `reserved` the Space's reservation now; `page` where the hosted
    // window must be (top-left coordinates, as the window server's bounds). Nil: the page can't be reached that way
    // (it starts before Margin's tile ends, or leaves less than a point).
    static func plan(margin: CGRect, hosted: CGRect, reserved: SlotEdges, page: CGRect) -> (edges: SlotEdges, spacing: Double)? {
        let area = CGRect(x: margin.minX - reserved.left, y: hosted.minY - reserved.top,
                          width: hosted.maxX + reserved.right - (margin.minX - reserved.left),
                          height: hosted.maxY + reserved.bottom - (hosted.minY - reserved.top))
        let edges = SlotEdges(left: reserved.left, right: area.maxX - page.maxX, top: page.minY - area.minY, bottom: area.maxY - page.maxY).whole
        let spacing = (page.minX - (area.minX + edges.left + margin.width)).rounded()
        guard edges.usable, spacing >= 0, page.width >= 1, page.height >= 1 else { return nil }
        return (edges, spacing)
    }

    static func near(_ a: CGRect, _ b: CGRect, within: CGFloat = 1) -> Bool {
        abs(a.minX - b.minX) <= within && abs(a.minY - b.minY) <= within && abs(a.width - b.width) <= within && abs(a.height - b.height) <= within
    }
}
