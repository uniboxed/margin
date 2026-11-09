// What macOS says about Spaces, for the profile handoff (docs/HANDOFF.md §3.2,
// §6.7, §4.3): the active Space, each window's Spaces, every display's Spaces
// (the full-screen ones, the Desktops, and how many displays are managed), and
// the window server's own read of one window.
//
// - The Spaces come from SkyLight's private reads (PrivateCalls.swift, rows 5-7
//   of docs/PRIVATE-APIS.md), behind SkyLight's wrappers. Each read is optional: nil
//   is "unknown" (a call refused, a nil Copy result, a shape that isn't the one
//   macOS 27.2 gives), never a guess. An empty list of a window's Spaces is a
//   real answer: the window is in no user Space (parked, or gone).
// - A window's Spaces are read one window at a time: SLSCopySpacesForWindows
//   answers the union of the windows it's given.
// - Mask 7 (every kind, as every lab read them) doesn't list a private Space:
//   that's how a parked window reads as "in no user Space".
// - Space types: 0 a Desktop (a user Space), 4 a full-screen Space.
// - The window read is CGWindowListCopyWindowInfo(.optionIncludingWindow, n):
//   public, no permission, nil when the window isn't listed.
// - SkyLightSpaces refuses under MARGIN_APP_TESTS (every read nil, every
//   bridge call false), as SkyLight's own wrappers do. FakeSpaceWorld is the
//   tests' and the harness's: Spaces and windows in memory, the bridge's ops
//   landing on a SwitchClock.
// - Nothing here logs a title or an address: there are only numbers.

import AppKit
import CoreGraphics

nonisolated struct ManagedSpace: Equatable, Sendable {
    static let desktopType = 0
    static let fullScreenType = 4
    let id: UInt64
    let type: Int
}

// One display's Spaces, from SLSCopyManagedDisplaySpaces.
nonisolated struct DisplaySpaces: Equatable, Sendable {
    let display: String // "Display Identifier": a display's UUID, or "Main" when one set of Spaces spans every display
    let current: UInt64? // "Current Space"
    let spaces: [ManagedSpace]

    var desktops: [UInt64] { spaces.filter { $0.type == ManagedSpace.desktopType }.map(\.id) }
    var fullScreen: [UInt64] { spaces.filter { $0.type == ManagedSpace.fullScreenType }.map(\.id) }
    // Where a window returns to on this display (§2.1 returnToDesktop): the Desktop showing, or,
    // while a full-screen Space shows, the first Desktop (the one Mission Control lists first).
    var desktop: UInt64? {
        if let current, desktops.contains(current) { return current }
        return desktops.first
    }
}

protocol SpaceReads: AnyObject {
    // SLSGetActiveSpace: the active display's current Space.
    func activeSpace() -> UInt64?
    // One window's Spaces, mask 7. []: in no user Space. nil: unknown.
    func spaces(of window: Int) -> [UInt64]?
    // Every managed display's Spaces. One entry per display (mirrored displays are one).
    func displays() -> [DisplaySpaces]?
    // The window server's read of one window; nil when it isn't listed (gone, or never was).
    func window(_ number: Int) -> ServerWindow?
    // The "Display Identifier" of the display holding this rect's centre (top-left coordinates).
    func display(at bounds: CGRect) -> String?
}

extension SpaceReads {
    // Every full-screen Space, on every display (R1's "a type-4 Space").
    func fullScreenSpaces() -> Set<UInt64>? {
        displays().map { Set($0.flatMap(\.fullScreen)) }
    }

    /// The Space showing on the display holding a window (by its bounds' centre): each display has its own when
    /// "Displays have separate Spaces" is on. One display (or that setting off), or a window or display that doesn't
    /// read: the active Space, as before.
    func showing(onDisplayOf window: Int) -> UInt64? {
        if let displays = displays(), displays.count > 1, let bounds = self.window(window)?.bounds, let id = display(at: bounds),
           let d = displays.first(where: { $0.display.caseInsensitiveCompare(id) == .orderedSame }), let current = d.current {
            return current
        }
        return activeSpace()
    }

    /// Every display's Space showing (one display: the active Space).
    func showingAll() -> [UInt64] {
        if let displays = displays(), displays.count > 1 { return displays.compactMap(\.current).sorted() }
        return activeSpace().map { [$0] } ?? []
    }

    // How many displays macOS manages Spaces for (§6.7: more than one, no freeze for that switch).
    // Not NSScreen.screens.count: mirrored displays count once, and "Displays have separate
    // Spaces" off gives one entry for all of them.
    func managedDisplayCount() -> Int? { displays()?.count }

    // The Desktop a window goes back to: its display's (from its bounds), else the only display's,
    // else the display showing the active Space, else the first display's. Nil when the displays
    // don't read or none has a Desktop.
    func desktop(for window: Int) -> UInt64? {
        guard let displays = displays(), !displays.isEmpty else { return nil }
        if displays.count == 1 { return displays[0].desktop }
        if let bounds = self.window(window)?.bounds, let id = display(at: bounds),
           let d = displays.first(where: { $0.display.caseInsensitiveCompare(id) == .orderedSame }), let desktop = d.desktop { return desktop }
        if let active = activeSpace(), let d = displays.first(where: { $0.current == active || $0.spaces.contains { $0.id == active } }), let desktop = d.desktop { return desktop }
        return displays.lazy.compactMap(\.desktop).first
    }

    // Parked, as §4.3 verifies it: in no user Space and off screen. A window the window server
    // doesn't list reads as off screen, as the labs read it (whether a parked window is listed is
    // gate G6's). Nil when the Spaces don't read.
    func readsParked(_ number: Int) -> Bool? {
        guard let spaces = spaces(of: number) else { return nil }
        return spaces.isEmpty && window(number)?.onScreen != true
    }

    // SLSCopyManagedDisplaySpaces' answer, as macOS 27.2 gives it. Any entry that isn't a display
    // with an identifier and a list of Spaces makes the whole read unknown: the display count
    // decides whether a switch freezes, so a half-read list isn't trusted.
    static func parseDisplays(_ raw: [[String: Any]]) -> [DisplaySpaces]? {
        var out: [DisplaySpaces] = []
        for entry in raw {
            guard let id = entry["Display Identifier"] as? String, let list = entry["Spaces"] as? [[String: Any]] else { return nil }
            var spaces: [ManagedSpace] = []
            for s in list {
                guard let space = (s["id64"] as? NSNumber)?.uint64Value, let type = (s["type"] as? NSNumber)?.intValue else { return nil }
                spaces.append(ManagedSpace(id: space, type: type))
            }
            let current = ((entry["Current Space"] as? [String: Any])?["id64"] as? NSNumber)?.uint64Value
            out.append(DisplaySpaces(display: id, current: current, spaces: spaces))
        }
        return out
    }

    // One window from CGWindowListCopyWindowInfo's list, as CGWindowSource reads them.
    static func parseWindow(_ list: [[String: Any]], number: Int) -> ServerWindow? {
        for w in list {
            guard (w[kCGWindowNumber as String] as? NSNumber)?.intValue == number,
                  let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                  let raw = w[kCGWindowBounds as String] as? NSDictionary, let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary) else { continue }
            return ServerWindow(number: number, pid: pid, layer: (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0, bounds: bounds,
                                onScreen: (w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
                                alpha: (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1)
        }
        return nil
    }
}

// The private Spaces and the bridge (rows 8-12), as the parker uses them. True or an id means
// the call was made; whether it landed is the parker's to verify (§4.3).
protocol SpaceBridge: AnyObject {
    var canPark: Bool { get } // the launch check passed parking, and nothing refuses
    func createSpace() -> UInt64? // SLSSpaceCreate(cid, 1, nil); nil when it answered 0
    func destroySpace(_ space: UInt64) -> Bool // SLSSpaceDestroy
    func add(_ window: Int, to space: UInt64) -> Bool // the add/remove op, options 7: into `space`, out of every other
    func remove(_ window: Int, from space: UInt64) -> Bool // out of `space` (a show or return, out of the private Space)
}

// ---- the real one ----

// SkyLight's reads and bridge, behind its wrappers (which already fill in only what the launch
// check passed). Made only by Shell.checkPrivateCalls, from the real resolver.
final class SkyLightSpaces: SpaceReads, SpaceBridge {
    private let sky: SkyLight
    private let availability: PrivateCalls.Availability
    let refuses: Bool

    // refusing: always true under MARGIN_APP_TESTS, except in a test that runs it against its own
    // fake functions.
    init(sky: SkyLight, availability: PrivateCalls.Availability, refusing: Bool = PrivateCalls.inTests) {
        self.sky = sky
        self.availability = availability
        refuses = refusing
    }

    var canPark: Bool { !refuses && availability.park }

    func activeSpace() -> UInt64? { refuses ? nil : sky.activeSpace() }

    func spaces(of window: Int) -> [UInt64]? {
        guard !refuses, let n = UInt32(exactly: window), n > 0 else { return nil }
        return sky.spaces(forWindows: [n], mask: 7)
    }

    func displays() -> [DisplaySpaces]? {
        guard !refuses, let raw = sky.managedDisplaySpaces() else { return nil }
        return Self.parseDisplays(raw)
    }

    // Public, and no private call: still refused in tests, so a test never reads the real screen.
    func window(_ number: Int) -> ServerWindow? {
        guard !refuses, let n = CGWindowID(exactly: number), n > 0,
              let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], n) as? [[String: Any]] else { return nil }
        return Self.parseWindow(list, number: number)
    }

    func display(at bounds: CGRect) -> String? {
        guard !refuses, !bounds.isNull else { return nil }
        var id: CGDirectDisplayID = 0
        var count: UInt32 = 0
        guard CGGetDisplaysWithPoint(CGPoint(x: bounds.midX, y: bounds.midY), 1, &id, &count) == .success, count > 0,
              let uuid = CGDisplayCreateUUIDFromDisplayID(id)?.takeRetainedValue() else { return nil }
        return CFUUIDCreateString(nil, uuid) as String?
    }

    func createSpace() -> UInt64? { canPark ? sky.createSpace() : nil }
    func destroySpace(_ space: UInt64) -> Bool { canPark && sky.destroySpace(space) }

    func add(_ window: Int, to space: UInt64) -> Bool {
        guard canPark, let n = UInt32(exactly: window), n > 0 else { return false }
        return sky.bridgeAdd(windows: [n], toSpace: space, options: 7)
    }

    func remove(_ window: Int, from space: UInt64) -> Bool {
        guard canPark, let n = UInt32(exactly: window), n > 0 else { return false }
        return sky.bridgeRemove(windows: [n], fromSpaces: [space])
    }
}

// ---- the stand-in ----

// The tests' and the harness's Spaces: windows, displays and the active Space in memory. A bridge
// op lands `lag` seconds after it's sent, on the clock, unless it's scripted not to. A window in a
// private Space reads as in no user Space and off screen, as mask 7 reads it.
final class FakeSpaceWorld: SpaceReads, SpaceBridge {
    struct Window {
        var pid: pid_t
        var bounds: CGRect
        var spaces: [UInt64] // every Space it's in, private ones too
    }

    var canPark = true
    var active: UInt64?
    var displayList: [DisplaySpaces]?
    var windows: [Int: Window] = [:]
    var displayOf: [String: CGRect] = [:] // display identifier → its frame (top left), for display(at:)
    var lag: Double = 0.004
    var dropNext = 0 // the next ops sent don't land at all (counted down per op)
    var refuseAdds: [Bool] = [] // each add takes the next: true, its op couldn't be made (nothing sent)
    var unknown = false // every Space read answers nil
    var nextSpace: UInt64 = 2431
    var createFails = false
    private(set) var made: [UInt64] = [] // private Spaces made, in order
    private(set) var destroyed: [UInt64] = []
    private(set) var calls: [String] = [] // "create 2431", "add 5 → 2431", "remove 5 from 2431", "destroy 2431"

    private let clock: SwitchClock

    init(clock: SwitchClock) { self.clock = clock }

    var privateSpaces: Set<UInt64> { Set(made).subtracting(destroyed) }

    func activeSpace() -> UInt64? { unknown ? nil : active }

    func spaces(of window: Int) -> [UInt64]? {
        guard !unknown else { return nil }
        guard let w = windows[window] else { return [] }
        let hidden = Set(made)
        return w.spaces.filter { !hidden.contains($0) }
    }

    func displays() -> [DisplaySpaces]? { unknown ? nil : displayList }

    func window(_ number: Int) -> ServerWindow? {
        guard let w = windows[number] else { return nil }
        let onScreen = active.map { w.spaces.contains($0) } ?? false
        return ServerWindow(number: number, pid: w.pid, bounds: w.bounds, onScreen: onScreen)
    }

    func display(at bounds: CGRect) -> String? {
        displayOf.first { $0.value.contains(CGPoint(x: bounds.midX, y: bounds.midY)) }?.key
    }

    func createSpace() -> UInt64? {
        guard canPark, !createFails else { return nil }
        let space = nextSpace
        nextSpace += 1
        made.append(space)
        calls.append("create \(space)")
        return space
    }

    func destroySpace(_ space: UInt64) -> Bool {
        guard canPark else { return false }
        destroyed.append(space)
        calls.append("destroy \(space)")
        // A window still in it is left in no Space at all, as SkyLight would leave it.
        for (n, var w) in windows where w.spaces.contains(space) {
            w.spaces.removeAll { $0 == space }
            windows[n] = w
        }
        return true
    }

    func add(_ window: Int, to space: UInt64) -> Bool {
        guard canPark else { return false }
        if !refuseAdds.isEmpty, refuseAdds.removeFirst() {
            calls.append("add \(window) → \(space) refused")
            return false
        }
        calls.append("add \(window) → \(space)")
        land { w in w.spaces = [space] } (window)
        return true
    }

    func remove(_ window: Int, from space: UInt64) -> Bool {
        guard canPark else { return false }
        calls.append("remove \(window) from \(space)")
        land { w in w.spaces.removeAll { $0 == space } } (window)
        return true
    }

    // A window coming back by itself (Margin.app gone, a Dock restart): into `space`, out of the rest.
    func comeBack(_ number: Int, to space: UInt64) { windows[number]?.spaces = [space] }

    private func land(_ change: @escaping (inout Window) -> Void) -> (Int) -> Void {
        { [weak self] number in
            guard let self else { return }
            if self.dropNext > 0 { self.dropNext -= 1; return }
            self.clock.after(self.lag) { [weak self] in
                guard let self, var w = self.windows[number] else { return }
                change(&w)
                self.windows[number] = w
            }
        }
    }
}
