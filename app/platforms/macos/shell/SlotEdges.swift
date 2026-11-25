// A full-screen Space's reserved edges (docs/PRIVATE-APIS.md rows 21-22): every full-screen Space lays its window
// out in a tile and can reserve room at its edges; with the page area's insets reserved, the window manager lays the
// tile out again and the hosted app sizes its own full-screen window to what's left (Host.swift HostLayout.plan,
// HostSystem.swift reserve). A reservation outlives the process that set it: the host gives every one back at quit,
// and its marker (hosted.json) covers a crash.

import AppKit

nonisolated struct SlotEdges: Equatable, Sendable {
    var left = 0.0, right = 0.0, top = 0.0, bottom = 0.0
    static let zero = SlotEdges()

    var isZero: Bool { left == 0 && right == 0 && top == 0 && bottom == 0 }
    // Whole points: a fractional reservation makes AppKit leave full screen.
    var whole: SlotEdges { SlotEdges(left: left.rounded(), right: right.rounded(), top: top.rounded(), bottom: bottom.rounded()) }
    var usable: Bool { [left, right, top, bottom].allSatisfy { $0.isFinite && $0 >= 0 } }
    // The frame less these edges (top-left coordinates).
    func inset(_ frame: CGRect) -> CGRect {
        CGRect(x: frame.minX + left, y: frame.minY + top, width: frame.width - left - right, height: frame.height - top - bottom)
    }
    // The frame these edges were taken from.
    func outset(_ frame: CGRect) -> CGRect {
        CGRect(x: frame.minX - left, y: frame.minY - top, width: frame.width + left + right, height: frame.height + top + bottom)
    }
    var text: String { "\(Int(left))/\(Int(top))/\(Int(right))/\(Int(bottom))" } // left/top/right/bottom
}

// The Space side: the system's (SkyLightSlots), or a test's.
protocol SlotSpaces: AnyObject {
    // True: sent. Whether it landed is the keeper's to verify.
    func reserve(_ edges: SlotEdges, space: UInt64) -> Bool
    // What the Space reserves now; nil: unknown, or not a Space that lays a window out (a Desktop).
    func reserved(space: UInt64) -> SlotEdges?
}

final class SkyLightSlots: SlotSpaces {
    private let sky: SkyLight
    init(sky: SkyLight) { self.sky = sky }
    func reserve(_ edges: SlotEdges, space: UInt64) -> Bool {
        sky.reserveEdges(of: space, left: edges.left, right: edges.right, top: edges.top, bottom: edges.bottom)
    }
    func reserved(space: UInt64) -> SlotEdges? {
        sky.reservedEdges(of: space).map { SlotEdges(left: $0.left, right: $0.right, top: $0.top, bottom: $0.bottom) }
    }
}
