// What macOS says about Spaces, for the host (HostSystem.swift): each window's Spaces and every display's Spaces
// (the full-screen ones, the Desktops, the one showing), and the private Spaces and bridge the host parks and moves
// hosted windows with.
//
// - The Spaces come from SkyLight's private reads (PrivateCalls.swift; docs/PRIVATE-APIS.md), behind SkyLight's
//   wrappers. Each read is optional: nil is "unknown" (a call refused, a nil Copy result, a shape that isn't the one
//   macOS 27.2 gives), never a guess. An empty list of a window's Spaces is a real answer: the window is in no user
//   Space (parked, or gone).
// - A window's Spaces are read one window at a time: SLSCopySpacesForWindows
//   answers the union of the windows it's given.
// - Mask 7 (every kind, as every lab read them) doesn't list a private Space:
//   that's how a parked window reads as "in no user Space".
// - Space types: 0 a Desktop (a user Space), 4 a full-screen Space.
// - SkyLightSpaces refuses under MARGIN_APP_TESTS (every read nil, every
//   bridge call false), as SkyLight's own wrappers do.
// - Nothing here logs a title or an address: there are only numbers.

import Foundation

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

    // SLSCopyManagedDisplaySpaces' answer, as macOS 27.2 gives it. Any entry that isn't a display
    // with an identifier and a list of Spaces makes the whole read unknown: a half-read list isn't trusted.
    static func parse(_ raw: [[String: Any]]) -> [DisplaySpaces]? {
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
}

// SkyLight's reads and bridge, behind its wrappers (which already fill in only what the launch
// check passed). Made only by Shell.checkPrivateCalls, from the real resolver. True or an id means
// the call was made; whether it landed is the host's to verify.
final class SkyLightSpaces {
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

    var canPark: Bool { !refuses && availability.park } // the launch check passed parking, and nothing refuses

    // One window's Spaces, mask 7. []: in no user Space. nil: unknown.
    func spaces(of window: Int) -> [UInt64]? {
        guard !refuses, let n = UInt32(exactly: window), n > 0 else { return nil }
        return sky.spaces(forWindows: [n], mask: 7)
    }

    // Every managed display's Spaces. One entry per display (mirrored displays are one).
    func displays() -> [DisplaySpaces]? {
        guard !refuses, let raw = sky.managedDisplaySpaces() else { return nil }
        return DisplaySpaces.parse(raw)
    }

    func createSpace() -> UInt64? { canPark ? sky.createSpace() : nil } // SLSSpaceCreate(cid, 1, nil); nil when it answered 0
    func destroySpace(_ space: UInt64) -> Bool { canPark && sky.destroySpace(space) } // SLSSpaceDestroy

    // The add/remove op, options 7: into `space`, out of every other.
    func add(_ window: Int, to space: UInt64) -> Bool {
        guard canPark, let n = UInt32(exactly: window), n > 0 else { return false }
        return sky.bridgeAdd(windows: [n], toSpace: space, options: 7)
    }
}
