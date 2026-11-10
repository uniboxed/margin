// The placer's check: step 3 of the window module (WindowMap.swift has the plan). The planner decides where each
// overlay goes; the shell carries it out (Shell.track, `place`); this checks, on the next map, that macOS did it.
// Before (2026-11-07), a shown overlay was taken as on screen over its window: an overlay macOS left in another
// Space, ordered out, or behind its window stayed so until something else moved.
//
// What's recorded at each show (`PlacedOverlay`): the overlay's window, the window it's over, the frame asked, the
// window's bounds then. What the next maps are asked, in order, for an overlay over a window on screen at those
// bounds (a window moving or sliding isn't judged: nothing's settled):
//   1. its Spaces: not its window's single showing Space → moved into it (`.join`);
//   2. on screen: not, while its window is → ordered in again over it (`.reorder`);
//   3. its frame: not the one asked → said (the show path sets it again on each read).
// (Not its order against its window: the window list's order isn't front to back between Margin's windows and
// Safari's, a real session's trace 2026-11-07: an overlay in front read 136 against its window's 1.)
// Each only once the placement is `grace` old and on two maps in a row (a map read just after an order can lag).
// Pure: every case is a test, and a real session's trace replays through it.

import CoreGraphics

struct PlacedOverlay: Equatable {
    let overlay: Int // its panel's window number
    let window: Int // the window it's shown over
    let frame: CGRect // asked (top-left origin)
    let windowBounds: CGRect // its window's bounds then
    let at: Double
}

enum PlacementFix: Equatable {
    case join(UInt64)
    case reorder(String) // why
    case frame(CGRect) // what the map has instead (only said)
}

enum PlacementCheck {
    static let grace: Double = 0.2

    /// What's wrong with a placement on this map, if anything (`misses`: how many maps in a row it was already
    /// wrong on; a fix comes on the second).
    static func check(_ p: PlacedOverlay, map: WindowSnapshot, now: Double, canMove: Bool, misses: Int) -> (wrong: Bool, fix: PlacementFix?) {
        guard now - p.at >= grace, let w = map.windows[p.window], w.onScreen, w.bounds == p.windowBounds,
              let o = map.windows[p.overlay] else { return (false, nil) }
        if canMove, let to = OverlayPlanner.spaceToJoin(overlay: o.spaces, window: w.spaces, windowOnScreen: true, showing: map.showing) {
            return (true, misses >= 1 ? .join(to) : nil)
        }
        if !o.onScreen { return (true, misses >= 1 ? .reorder("not on screen while its window is") : nil) }
        if abs(o.bounds.minX - p.frame.minX) > 1 || abs(o.bounds.minY - p.frame.minY) > 1
            || abs(o.bounds.width - p.frame.width) > 1 || abs(o.bounds.height - p.frame.height) > 1 {
            return (true, misses >= 1 ? .frame(o.bounds) : nil)
        }
        return (false, nil)
    }
}
