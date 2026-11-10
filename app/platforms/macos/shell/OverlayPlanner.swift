// The planner: step 2 of the window module (WindowMap.swift has the plan). What each overlay should do on a read,
// decided from facts only (`OverlayFacts`), never from the screen: a pure function, so every case is a test, and a
// real session's trace can be replayed through it.
//
// This first version decides exactly what Shell.track's overlay loop decided before (2026-11-07): the same rules in
// the same order, with the same words for the log. The shell gathers the facts, asks, and carries the decision out
// (the placer, step 3, will take that part). Rules move here from the shell, and change here, with a test each.

import CoreGraphics

struct OverlayFacts: Equatable {
    // Its window, as its copy and the switch say.
    var full = false // in full screen (or windowed overlays allowed)
    var hasTheme = false // its copy's theme is here
    var parked = false
    var target = false // a profile switch's target
    var early = false // the window a switch is making (its overlay's page loads while it goes full screen)
    var leaving = false // the window the switch leaves, held out
    var targetReady = false // a target the switch has shown (R2)
    // Its window, as the window server says.
    var bound: Int? // the window server's window it's bound to
    var absent = false // bound, but missing from this read
    var absentConfirmed = false // an already shown own-Space overlay independently confirmed with its live window
    var window: ServerWindow?
    var modelPresentation = false // a fresh independent model read matches the previously shown full-size window
    var fills = false // the window fills its display (or the harness, or windowed overlays allowed)
    // The overlay as it is (a fresh one if it isn't made yet).
    var ownSpace = false // in its window's own Space, not every Space
    var shown = false
    var over: Int?
    var windowFrame: CGRect? // its window's bounds when it was last shown
    var aheadPending = false // placed in its window's Space ahead of a visit, not on screen yet
    var overlayOnScreen = false // its own window listed on screen
    // Spaces, from the window map (nil: not known).
    var overlaySpaces: [UInt64]?
    var windowSpaces: [UInt64]?
    var canMove = false // the Space bridge can move Margin's windows into a Space
    // The checks.
    var canSuspect = false // the own-Space check can suspect it (on, no fallback, no Space change for a second, no switch moving it)
    var spaceChanged = false // the active Space changed in the last second (for the log's words)
}

enum OverlayDecision: Equatable {
    case notWanted(String) // put away if it's made (not made for this)
    case parked // its window is parked: put away if made, no suspicion kept
    case leaving // the window a switch leaves: put away if made
    case hide(String) // put away
    case conceal // kept where it is, unseen (its window missing from one read)
    case reveal // kept in its window's Space, which isn't showing
    case misplaced // placed ahead, but on screen while its window isn't: put away, not placed ahead for 30 s
    case suspect // in its own Space, on screen while its window isn't: put away, looked at again (judgeOwnSpace)
    case placeAhead(orHide: String) // placed in its window's Space ahead of a visit, else put away
    case keep // sliding with its window's Space: left as it is
    case join(UInt64) // kept in its window's Space, but in another: moved into that Space (the Space bridge)
    case show(Int) // shown over that window

    /// Whether the overlay is made for it (the first three put away only one that's made).
    var needsOverlay: Bool {
        switch self {
        case .notWanted, .parked, .leaving: return false
        default: return true
        }
    }
    /// Whether the read went past the switch's held-out check (a key held out but no longer leaving is let go then).
    var pastHeldOut: Bool {
        switch self {
        case .notWanted, .parked: return false
        default: return true
        }
    }
}

enum OverlayPlanner {
    static func decide(_ f: OverlayFacts) -> OverlayDecision {
        let wanted = (f.full || f.parked || f.target) && f.hasTheme
        guard wanted || f.early else { return .notWanted(f.hasTheme ? "its window isn't in full screen" : "no theme yet") }
        if f.parked, !f.target { return .parked }
        if f.leaving { return .leaving }
        // Never shown over a window that isn't bound, isn't on screen, or doesn't fill its display yet.
        guard f.full || f.targetReady else { return .hide("its window is still being made") }
        guard let number = f.bound else { return .hide("its window isn't bound to one of the window server's") }
        // Mission Control transforms both surfaces. Do not resize/order the native overlay from the
        // transformed rectangle, which would apply the scale twice. An absent/foreign/changed model
        // never gets this fact; real exits from full screen still take the conservative hide path.
        if f.modelPresentation, f.ownSpace, f.shown, f.over == number, let server = f.window,
           f.windowFrame.map({ sameSize($0, server.bounds) }) == true { return .keep }
        if f.absent { return f.absentConfirmed ? .reveal : .conceal }
        guard let server = f.window else { return .hide("its window is gone from the window server") }
        // Kept where it is over its window in its own Space: shown over this window, at its size (a slide moves the
        // window, it doesn't resize it).
        let kept = f.ownSpace && f.shown && f.over == number && f.windowFrame.map { sameSize($0, server.bounds) } == true
        if !server.onScreen {
            if kept {
                // Its Spaces known and not its window's (one Space): moved there now, not suspected a second later
                // (a real session's trace 2026-11-07 11:33:03: the sidebar sat on the Desktop for a second).
                if f.canMove, let ws = f.windowSpaces, ws.count == 1, let os = f.overlaySpaces, os != ws { return .join(ws[0]) }
                if f.aheadPending, f.overlayOnScreen { return .misplaced }
                // On screen while its window isn't: a guess at the wrong Space, only when the Spaces can't say (with
                // them, the rule above has moved it if it was; the same Spaces is a stale on-screen read).
                let spacesKnown = f.canMove && f.overlaySpaces != nil && f.windowSpaces != nil
                if f.canSuspect, f.overlayOnScreen, !spacesKnown { return .suspect }
                return .reveal
            }
            guard f.fills else { return .hide("its off-screen window doesn't fill its display yet") }
            return .placeAhead(orHide: f.spaceChanged ? "the active Space changed and its window isn't on screen" : "its window isn't on screen")
        }
        guard f.fills else { return kept ? .keep : .hide("its window doesn't fill its display (going into or out of full screen)") }
        return .show(number)
    }

    /// The Space an overlay shown over a window must be moved into, or nil when it's where it should be (or that
    /// can't be told): its window on screen, in exactly one Space, one of the Spaces showing, and the overlay's
    /// Spaces known and not just that one. (Checked by the shell right after a show, with Spaces read then.)
    static func spaceToJoin(overlay: [UInt64]?, window: [UInt64]?, windowOnScreen: Bool, showing: Set<UInt64>) -> UInt64? {
        guard windowOnScreen, let window, window.count == 1, let space = window.first, showing.contains(space), let overlay else { return nil }
        return overlay == [space] ? nil : space
    }

    /// Whether a first show is checked a moment later for its overlay on screen with its window, every overlay joining
    /// every Space if not (Shell.checkOwnSpace): only without the Space bridge. With it, an overlay out of its
    /// window's Space is moved there, alone (spaceToJoin, `.join`), and the others are left as they are.
    static func checksOwnSpace(canMove: Bool) -> Bool { !canMove }

    // Whether two bounds have the same size (to a point): a window offset in a slide is the same window.
    static func sameSize(_ a: CGRect, _ b: CGRect) -> Bool { abs(a.width - b.width) <= 1 && abs(a.height - b.height) <= 1 }
}
