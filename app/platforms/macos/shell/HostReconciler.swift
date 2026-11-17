// The hosting core's reconciler (docs/HOSTING-CORE.md, principle 4; stage 3): what each hosted app should be
// (`HostDesired`), what Margin sees of it now (`HostSituation`, built by HostEngine from its own host and the observed
// model, HostModel.swift), and the corrections from a fixed menu that bring the one to the other (`HostCorrection`),
// most urgent first. Pure: `HostReconciler.step` is a function of the two, tested on its own (a table row per case the
// baseline real-screen run and the real sessions showed: tests/host-reconciler-tests.swift). HostEngine applies the
// corrections one at a time, serialised, each through the primitives it already had (the early full screen under the
// freeze, the edge reservation, the bridged moves, the private Spaces, Accessibility's framing, the quit and give-back),
// with a budget per app per show, and logs one line per correction:
//   host: <app>: <observed> → <correction> (<budget left>)
//
// The menu (each idempotent: asked again, it does nothing more than once):
//   launch             not running                                   started with no Dock icon (an app Margin hosts)
//   reopen             running with no window Margin can host        a Dock-icon click (kAEReopenApplication), then waited
//   unhide             hidden (no window listed while it is)         NSRunningApplication.unhide, never activated
//   wait               nothing to do yet (a window still coming, macOS's own transition still running)
//   placeFromOwnSpace  its main window in a full-screen Space of its own: reserved, moved in, that Space destroyed
//   outThenAsk         full screen with no Space of its own (moved into another's): out of it on the current Space, then asked
//   askFullScreen      a normal window that can go full screen: asked where macOS takes it (the early path, else the slow one)
//   frameWindow        one that can't: window mode, framed into the page area (a fixed size centred, the page card around it)
//   putBack            shown, its window out of Margin's Space (another Space, none): back in, after macOS's transition
//   bringForward       shown in window mode, in Margin's Space (current) and off screen: its app forward, then looked at
//                      again, a rung at a time: activate (unhide, activate, raise), reopen (a Dock-icon click). Never a
//                      Space made current or a window moved for it (2026-11-17 14:05: each was a jump). A member off
//                      screen in place is placed again (HostEngine.backOnScreen), as before.
//   adopt              the app replaced its window (a new main-kind window at its frame, the old one gone or in no
//                      Space), or made a new one after its own went: the new one hosted; the app is never fought
//   closeLeftover      a leftover Margin may close (its app discards windows at quit, Accessibility reads it): its own
//                      close button; not gone: parked instead
//   parkLeftover       any other leftover (restored, made as it launched, opened only to wake it): parked in a private
//                      Space (its own emptied full-screen Space destroyed), given back to its Desktop at the end
//   parkStrip          a strip on screen or in a user Space while its window is shown: parked, never let in front
//   parkAgain          parked, found in a user Space: parked again
//   fallback           a correction's budget used up: window mode if it can be framed, else parked with nothing shown and
//                      the page card says so; never a flicker, a jump between Spaces, the sidebar covered
// The first open's placement (launch → window → place) and every steady-state correction come from here; the windows
// Margin shows are only ever moved by the engine's existing steps. No bundle id anywhere.

import AppKit

// What an app should be now.
nonisolated enum HostDesired: Equatable, Sendable {
    case shown(HostPlacement) // its main window at the page area of Margin's window, on screen, under its panel
    case parked // its main window in a private Space, nothing of it on any user Space, the app running
    case givenBack // Margin quits or its row closes (HostEngine.closeNow: its frame and Space back, quit if Margin's)
}

// The rungs of `bringForward`, in order.
nonisolated enum HostForward: String, Equatable, Sendable, CaseIterable {
    case activate // unhide, activate, raise
    case reopen // a Dock-icon click (kAEReopenApplication)
}

nonisolated enum HostCorrection: Equatable, Sendable {
    case launch
    case reopen
    case unhide
    case wait(String)
    case placeFromOwnSpace(UInt64)
    case outThenAsk
    case askFullScreen
    case frameWindow
    case putBack
    case bringForward(HostForward)
    case adopt(Int)
    case closeLeftover(Int)
    case parkLeftover(Int)
    case parkStrip(Int)
    case parkAgain
    case fallback(String)

    // Its name in the log and its budget's key.
    var name: String {
        switch self {
        case .launch: return "launch"
        case .reopen: return "reopen"
        case .unhide: return "unhide"
        case .wait: return "wait"
        case .placeFromOwnSpace: return "place from its own Space"
        case .outThenAsk: return "out of full screen, then ask"
        case .askFullScreen: return "ask full screen"
        case .frameWindow: return "window mode"
        case .putBack: return "put back"
        case .bringForward(let f): return "bring forward (\(f.rawValue))"
        case .adopt: return "adopt"
        case .closeLeftover: return "close leftover"
        case .parkLeftover: return "park leftover"
        case .parkStrip: return "park strip"
        case .parkAgain: return "park again"
        case .fallback: return "fallback"
        }
    }
    var text: String {
        switch self {
        case .wait(let why): return "wait (\(why))"
        case .placeFromOwnSpace(let s): return "place from its own Space \(s)"
        case .adopt(let n): return "adopt \(n)"
        case .closeLeftover(let n): return "close leftover \(n)"
        case .parkLeftover(let n): return "park leftover \(n)"
        case .parkStrip(let n): return "park strip \(n)"
        case .fallback(let why): return "fallback (\(why))"
        default: return name
        }
    }
    // Its budget's key: per window for the ones that act on one.
    var key: String {
        switch self {
        case .closeLeftover(let n), .parkLeftover(let n): return "leftover \(n)"
        case .parkStrip(let n): return "strip \(n)"
        case .adopt(let n): return "adopt \(n)"
        default: return name
        }
    }
}

// One window other than the main one that the reconciler acts on (a leftover, a strip), as the model has it.
nonisolated struct HostOther: Equatable, Sendable {
    var number: Int
    var place: WindowPlace
    var onScreen: Bool?
    // A leftover only: whether Margin may close it (its app discards its windows at quit, so closing changes nothing its
    // next launch reopens; Accessibility reads it on the current Space; never one Margin opened only to wake its app,
    // which its own close handles).
    var closable = false

    var inUserSpace: Bool { place == .margin || place == .desktop || place == .fullScreen || place == .several }
}

// What Margin sees of one host (or of an app it's about to host), built by HostEngine from its host and the model.
nonisolated struct HostSituation: Equatable, Sendable {
    enum Phase: String, Equatable, Sendable { case none, preparing, shown, parked }

    // The app.
    var running = true
    var hidden: Bool? = nil
    var launchedByMargin = false

    // The host: none yet (the first open), being placed, shown or parked.
    var phase = Phase.none
    var mode = HostMode.fullScreen
    var member = false
    var window: Int? = nil // the window Margin hosts (nil: none chosen yet)
    var windowGone = false // its bounds didn't read twice in a row: closed
    var place = WindowPlace.unread // where it is (the model's)
    var onScreen: Bool? = nil
    var offScreenReads = 0 // polls in a row it was in Margin's Space, the current one, and off the on-screen list (its own read too)
    var strayReads = 0 // polls in a row a parked one was found in a user Space (one read can miss mid-transition)
    var atPage: Bool? = nil // a window-mode window where `frameWindow` puts it (the page area, or its own size centred in it)
    var fullScreen: Bool? = nil // Accessibility's AXFullScreen
    var canFullScreen: Bool? = nil // AXFullScreen settable
    var ownFullScreenSpace: UInt64? = nil // a full-screen Space of its app's it's in (not Margin's)
    var marginCurrent = true // Margin's Space the current one of its display, Margin's window in it
    var busy = false // an operation (macOS's transition, an open) still running for it

    // The app's other windows, by the model's kinds.
    var replacement: Int? = nil // a main-kind window that replaced the hosted one (or the only one after it went)
    var leftovers: [HostOther] = []
    var strips: [HostOther] = []

    // Corrections tried this show, by key (`HostCorrection.key`), and the budget of each.
    var tries: [String: Int] = [:]
    func tried(_ c: HostCorrection) -> Int { tries[c.key] ?? 0 }

    // One line of what's observed, for the log (numbers and kinds only).
    var text: String {
        var parts: [String] = []
        if !running { parts.append("not running") }
        if hidden == true { parts.append("hidden") }
        if let window {
            parts.append("\(phase.rawValue), \(mode == .window ? "window mode" : member ? "a member" : "full screen asked") window \(window)"
                         + (windowGone ? " gone" : " \(place.text)\(onScreen.map { $0 ? ", on screen" : ", off screen" } ?? "")\(offScreenReads > 1 ? " (\(offScreenReads) reads)" : "")"))
            if let s = ownFullScreenSpace { parts.append("in a full-screen Space of its own (\(s))") }
            if fullScreen == true, ownFullScreenSpace == nil, !member { parts.append("full screen with no Space of its own") }
        } else {
            parts.append("no window")
        }
        if let r = replacement { parts.append("its app's main window now \(r)") }
        let left = leftovers.filter(\.inUserSpace)
        if !left.isEmpty { parts.append("leftover\(left.count == 1 ? "" : "s") \(left.map { "\($0.number) (\($0.place.text)\($0.onScreen == true ? ", on screen" : ""))" }.joined(separator: ", "))") }
        let st = strips.filter { $0.inUserSpace || $0.onScreen == true }
        if !st.isEmpty { parts.append("strip\(st.count == 1 ? "" : "s") \(st.map { "\($0.number)" }.joined(separator: ", "))") }
        if !marginCurrent { parts.append("Margin's Space not current") }
        return parts.joined(separator: "; ")
    }
}

nonisolated enum HostReconciler {
    // Each correction's budget per show (tries); `bringForward`'s rungs once each, then the fallback.
    static let budget: [String: Int] = [
        "launch": 1, "reopen": 2, "unhide": 2, "adopt": 20, "window mode": 2, "put back": 3, "park again": 3,
        "leftover": 2, "strip": 3, "bring forward": 1,
    ]
    static func budget(of c: HostCorrection) -> Int {
        switch c {
        case .closeLeftover, .parkLeftover: return budget["leftover"]!
        case .parkStrip: return budget["strip"]!
        case .adopt: return budget["adopt"]!
        case .bringForward: return budget["bring forward"]!
        default: return budget[c.name] ?? 1
        }
    }
    // Reads in a row a shown window has to be off screen before it's brought forward (one read can miss mid-transition).
    static let offScreenAfter = 2

    // The corrections that bring `s` to `d`, most urgent first (the engine applies the first, then looks again).
    // Empty: settled. A correction whose budget is used up is skipped; the first open's path ends in `fallback`.
    static func step(_ s: HostSituation, _ d: HostDesired) -> [HostCorrection] {
        var out: [HostCorrection] = []
        func add(_ c: HostCorrection) { if s.tried(c) < budget(of: c) { out.append(c) } }
        switch d {
        case .givenBack:
            return [] // (HostEngine.closeNow: its own sequence of give-back steps)
        case .parked:
            // (Its window gone while it's parked: its next show reopens it, behind the loader, never now: a window its app
            // opens would come up in the current Space, over what's shown.)
            guard s.running, s.window != nil, !s.windowGone else { return [] }
            // Replaced by its app meanwhile (one Margin started): the new one adopted (and parked with it). The person's
            // app's new window while it's parked is theirs (they may be using the app outside Margin): never taken.
            if let r = s.replacement, s.launchedByMargin { add(.adopt(r)); if !out.isEmpty { return out } }
            // Nothing of it on any user Space: its window, its leftovers, its strips.
            if s.place.placed, s.place != .parked, s.strayReads >= 2, !s.busy { add(.parkAgain) }
            for l in s.leftovers where l.inUserSpace { add(.parkLeftover(l.number)) }
            for st in s.strips where st.inUserSpace { add(.parkStrip(st.number)) }
            return out
        case .shown:
            break
        }
        // 1. The app: running, unhidden, with a window.
        if !s.running {
            add(.launch)
            return out.isEmpty ? [.fallback("it doesn't start")] : out
        }
        if s.window == nil || s.windowGone {
            if let r = s.replacement { add(.adopt(r)); if !out.isEmpty { return out } }
            if s.hidden == true { add(.unhide) }
            add(.reopen)
            return out.isEmpty ? [.fallback("no window to host")] : out
        }
        // 2. Replaced by its app: the new one hosted, never fought.
        if let r = s.replacement { add(.adopt(r)); if !out.isEmpty { return out } }
        // 3. The main window where it should be.
        if s.busy { return [.wait("macOS's transition is still running")] }
        switch s.phase {
        case .none, .preparing:
            // The first placement: from where it is.
            out.append(firstPlacement(s))
            return out
        case .parked:
            return out // (shown by HostEngine.bringIn: a switch)
        case .shown:
            if s.marginCurrent {
                if s.place != .margin, s.place != .unread {
                    add(.putBack)
                } else if s.place == .margin, s.offScreenReads >= offScreenAfter {
                    let rung = HostForward.allCases.first { s.tried(.bringForward($0)) < 1 }
                    if let rung { out.append(.bringForward(rung)) } else { out.append(.fallback("its window stays off screen in Margin's Space")) }
                    return out
                } else if s.place == .margin, s.mode == .window, s.atPage == false {
                    // (A window-mode window not where it was framed: an adoption's frame not taken, its app moved it.)
                    add(.frameWindow)
                }
            }
        }
        // 4. Nothing else of it in sight: leftovers closed or parked, strips parked.
        for l in s.leftovers where l.inUserSpace { add(l.closable ? .closeLeftover(l.number) : .parkLeftover(l.number)) }
        for st in s.strips where st.inUserSpace || st.onScreen == true { add(.parkStrip(st.number)) }
        return out
    }

    // How a window not placed yet is placed, from where it is (the first open, or after a placing again backed out).
    static func firstPlacement(_ s: HostSituation) -> HostCorrection {
        if let own = s.ownFullScreenSpace, s.fullScreen != false { return .placeFromOwnSpace(own) }
        if s.mode == .window || s.canFullScreen == false { return .frameWindow }
        if s.fullScreen == true, !s.member { return .outThenAsk }
        return .askFullScreen
    }
}
