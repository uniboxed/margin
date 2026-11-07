// The window map: step 1 of the window module (Tirth, 2026-11-07: "create a separate module that would do all the
// window related stuff and it know what window is where … when i test in multiple screen").
//
// One place that knows every window Margin cares about, as one snapshot: the browsers' windows and Margin's own
// (overlays, covers, catchers), each with its bounds, whether it's on screen, its place in the window server's
// order, its display, its Spaces, and, for Safari's, its profile and full screen as Accessibility read them; and
// every display, with its frame, the Space it shows and its full-screen Spaces. Each display has its own current
// Space ("Displays have separate Spaces"): there's no single "active Space" in it.
//
// Fed by the shell's reads (Shell.track: the window server's list, already made) and by what it hears (a Space
// change, a display change, Safari's Accessibility events). Each update says what changed (`MapChange`). Nothing
// here decides what Margin shows: the planner (step 2) will, from snapshots only.
//
// Spaces are the costly part (one SkyLight read per window): read for a window when it's new, when it goes on or off
// screen or moves, after a Space or display change, and at least every second; the displays after a Space or
// display change and at least every second. Without the reads (no SkyLight: tests, refused calls), Spaces stay
// nil (unknown), never a guess.
//
// Only numbers: window numbers, pids, Space ids, display ids, rects. No title, no address.

import AppKit
import CoreGraphics

nonisolated struct MapWindow: Equatable, Sendable, Codable {
    enum Owner: String, Sendable, Codable { case browser, margin, other }
    let number: Int
    let pid: pid_t
    let owner: Owner
    let layer: Int
    let bounds: CGRect // top-left origin
    let onScreen: Bool
    let order: Int // front to back in the window server's list
    var spaces: [UInt64]? // nil: not read (or unknown); []: in no user Space (parked, or gone)
    var display: String? // the display holding its centre
    var fullScreen: Bool? // Accessibility's (Safari's windows)
    var link: String? // the profile its title named (Safari's windows)
}

nonisolated struct MapDisplay: Equatable, Sendable, Codable {
    let id: String // "Display Identifier"
    let frame: CGRect? // top-left origin; nil when it isn't one of the screens (or "Main" spanning them)
    let current: UInt64? // the Space it shows
    let desktops: [UInt64]
    let fullScreen: [UInt64]
}

nonisolated struct WindowSnapshot: Equatable, Sendable {
    var at: Double = 0
    var windows: [Int: MapWindow] = [:]
    var displays: [MapDisplay] = []
    var frontPid: pid_t?

    /// The Spaces showing now, one per display.
    var showing: Set<UInt64> { Set(displays.compactMap(\.current)) }
    func display(_ id: String?) -> MapDisplay? { id.flatMap { id in displays.first { $0.id.caseInsensitiveCompare(id) == .orderedSame } } }
}

nonisolated enum MapChange: Equatable, Sendable {
    case appeared(Int)
    case gone(Int)
    case onScreen(Int, Bool)
    case bounds(Int, CGRect)
    case spaces(Int, [UInt64]?)
    case display(Int, String?)
    case fullScreen(Int, Bool?)
    case link(Int, String?)
    case front(pid_t?)
    case displays([MapDisplay])
}

final class WindowMap {
    private(set) var snapshot = WindowSnapshot()
    /// SkyLight's Space reads; nil: Spaces unknown.
    var reads: SpaceReads?
    /// Each display's frame by its identifier (top-left origin). Nil: the screens' (screenFrames).
    var frames: (() -> [String: CGRect])?
    private var spacesReadAt: Double = -.infinity
    private var displaysReadAt: Double = -.infinity
    private var dirtySince: Double = -.infinity // a Space or display change heard

    static let spacesEvery: Double = 1

    /// A Space or display change heard: the next update reads Spaces and displays again.
    func spacesChanged(at now: Double) { dirtySince = now }

    /// One read of the window server (`list`, nil when it gave none: the windows kept as they were), with who
    /// owns what and what Accessibility knows. The changes, in a stable order.
    @discardableResult
    func update(now: Double, list: [ServerWindow]?, browserPids: Set<pid_t>, marginPid: pid_t, front: pid_t?,
                ax: AXKnown = AXKnown()) -> [MapChange] {
        let before = snapshot
        var next = WindowSnapshot(at: now, windows: before.windows, displays: before.displays, frontPid: front)
        if let list {
            var windows: [Int: MapWindow] = [:]
            for w in list {
                let owner: MapWindow.Owner = browserPids.contains(w.pid) ? .browser : (w.pid == marginPid ? .margin : .other)
                let old = before.windows[w.number]
                var m = MapWindow(number: w.number, pid: w.pid, owner: owner, layer: w.layer, bounds: w.bounds, onScreen: w.onScreen, order: w.order,
                                  spaces: old?.spaces, display: old?.display, fullScreen: nil, link: nil)
                if owner == .browser { m.fullScreen = ax.fullScreen[w.number]; m.link = ax.profiles[w.number] }
                windows[w.number] = m
            }
            next.windows = windows
        }

        // Displays: after a change heard, or every second.
        let displaysDue = dirtySince > displaysReadAt || now - displaysReadAt >= Self.spacesEvery
        if displaysDue, let reads {
            displaysReadAt = now
            if let read = reads.displays() {
                let frames = frames?() ?? Self.screenFrames()
                next.displays = read.map { d in
                    MapDisplay(id: d.display, frame: frames.first { $0.key.caseInsensitiveCompare(d.display) == .orderedSame }?.value,
                               current: d.current, desktops: d.desktops, fullScreen: d.fullScreen)
                }
            }
        }
        // Each window's display, from its centre and the displays' frames.
        for (n, w) in next.windows {
            let c = CGPoint(x: w.bounds.midX, y: w.bounds.midY)
            next.windows[n]?.display = next.displays.first { $0.frame?.contains(c) == true }?.id ?? (next.displays.count == 1 ? next.displays[0].id : nil)
        }
        // Spaces: for the windows that are new or changed, after a change heard, or every second (only the browsers'
        // and Margin's own: another app's Spaces aren't Margin's business).
        if let reads {
            let all = dirtySince > spacesReadAt || now - spacesReadAt >= Self.spacesEvery
            if all { spacesReadAt = now }
            for (n, w) in next.windows where w.owner != .other {
                let old = before.windows[n]
                guard all || old == nil || old?.onScreen != w.onScreen || old?.bounds != w.bounds else { continue }
                next.windows[n]?.spaces = reads.spaces(of: n)
            }
        }
        snapshot = next
        return Self.changes(from: before, to: next)
    }

    static func changes(from a: WindowSnapshot, to b: WindowSnapshot) -> [MapChange] {
        var out: [MapChange] = []
        if a.frontPid != b.frontPid { out.append(.front(b.frontPid)) }
        if a.displays != b.displays { out.append(.displays(b.displays)) }
        for n in Set(a.windows.keys).union(b.windows.keys).sorted() {
            switch (a.windows[n], b.windows[n]) {
            case (nil, let w?):
                out.append(.appeared(n))
                out.append(.onScreen(n, w.onScreen))
                out.append(.bounds(n, w.bounds))
                if w.spaces != nil { out.append(.spaces(n, w.spaces)) }
                if w.display != nil { out.append(.display(n, w.display)) }
                if w.fullScreen != nil { out.append(.fullScreen(n, w.fullScreen)) }
                if w.link != nil { out.append(.link(n, w.link)) }
            case (_?, nil):
                out.append(.gone(n))
            case (let o?, let w?):
                if o.onScreen != w.onScreen { out.append(.onScreen(n, w.onScreen)) }
                if o.bounds != w.bounds { out.append(.bounds(n, w.bounds)) }
                if o.spaces != w.spaces { out.append(.spaces(n, w.spaces)) }
                if o.display != w.display { out.append(.display(n, w.display)) }
                if o.fullScreen != w.fullScreen { out.append(.fullScreen(n, w.fullScreen)) }
                if o.link != w.link { out.append(.link(n, w.link)) }
            case (nil, nil):
                break
            }
        }
        return out
    }

    /// Every screen's frame (top-left origin, as the window server's bounds), by its display's identifier.
    static func screenFrames() -> [String: CGRect] {
        var out: [String: CGRect] = [:]
        for screen in NSScreen.screens {
            guard let id = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value,
                  let uuid = CGDisplayCreateUUIDFromDisplayID(id)?.takeRetainedValue(),
                  let key = CFUUIDCreateString(nil, uuid) as String? else { continue }
            out[key] = CGDisplayBounds(id)
        }
        return out
    }
}
