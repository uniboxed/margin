// The hosting core's reconciler (docs/HOSTING-CORE.md, principle 4; stage 3): what each hosted app should be
// (`HostDesired`), what Margin sees of it now (`HostSituation`, built by HostEngine from its own host and the observed
// model, HostModel.swift), and the corrections from a fixed menu that bring the one to the other (`HostCorrection`),
// most urgent first. Pure: `HostReconciler.step` is the hosting core's (margin-core, Rust:
// app/shared/core/src/host/reconciler.rs, a table row per case the baseline real-screen run and the real sessions
// showed); this file keeps the values and asks the core (HostCore.swift). HostEngine applies the
// corrections one at a time, serialised, each through the primitives it already had (the early full screen under the
// freeze, the edge reservation, the bridged moves, the private Spaces, Accessibility's framing, the quit and give-back),
// with a budget per app per show, and logs one line per correction:
//   host: <app>: <observed> → <correction> (<budget left>)
//
// The menu (each idempotent: asked again, it does nothing more than once):
//   launch             not running                                   started with no Dock icon (an app Margin hosts)
//   reopen             running with no window Margin can host        a Dock-icon click (kAEReopenApplication), then waited:
//                      only as an item is shown (its app runs with no window: Maps windowless at its show), never
//                      because the window shown went (Tirth, 2026-11-17: closing it closes the item)
//   unhide             hidden (no window listed while it is)         NSRunningApplication.unhide, never activated
//   wait               nothing to do yet (a window still coming, macOS's own transition still running)
//   placeFromOwnSpace  its main window in a full-screen Space of its own: reserved, moved in, that Space destroyed
//   outThenAsk         full screen with no Space of its own (moved into another's): out of it on the current Space, then asked
//   askFullScreen      a normal window that can go full screen: asked where macOS takes it (the early path, else the slow one)
//   frameWindow        one that can't: window mode, framed into the page area (a fixed size centred, the page card around it)
//   putBack            shown, its window out of Margin's Space (another Space, none): back in, after macOS's transition
//   bringForward       shown, in Margin's Space (current) and off screen (window mode; a member once its show's late watch is
//                      over: its app ordered it out): its app forward, then looked at
//                      again, a rung at a time: activate (unhide, AXFrontmost, raise), reopen (a Dock-icon click). Never a
//                      Space made current or a window moved for it (2026-11-17 14:05: each was a jump). A member off
//                      screen in place is placed again (HostEngine.backOnScreen), as before.
//   closeItem          shown, its window closed (by the person: ⌘W, its close button; or by its app) and no other main
//                      window came within `goneGrace`: its item closed (the row's page goes, its app left running), as
//                      before stage 3; never a window reopened for it (Tirth, 2026-11-17)
//   placeAgain         shown, a member not at the page area for two reads (its app moved it: a second window of its
//                      going full screen re-laid it out): placed again (out of full screen, asked again), once per 30 s
//   sizeTile           live resize (docs/HOSTING-CORE.md): a hosted window's tile in Margin's Space not at the page area
//                      (Margin's page area changed: a drag's end, a theme, the display; or found off it twice: a tile
//                      change laid it out again): its rect set to the page area's, its window seen there, the one shown
//                      first, the parked ones one at a time after it (each its own turn in the queue: a show asked
//                      meanwhile goes between them, and sizes its own first); its budget spent, the one shown is placed
//                      again the old way (`placeAgain`), a parked one at its next show
//   adopt              the app replaced its window (a new main-kind window at its frame, the old one gone or in no
//                      Space), or made a new one after its own went: the new one hosted; the app is never fought
//   closeLeftover      a leftover Margin may close (its app discards windows at quit, Accessibility reads it): its own
//                      close button; not gone: parked instead
//   parkLeftover       any other leftover (restored, made as it launched, opened only to wake it): parked in a private
//                      Space (its own emptied full-screen Space destroyed), given back to its Desktop at the end
//   parkStrip          a strip on screen or in a user Space while its window is shown: parked, never let in front
//   putAway            the person's own window (an app they opened, made before the one Margin hosts) in Margin's Space
//                      (its app's activation ordered it in under the one shown, the real Mac 2026-11-26): back on its
//                      Desktop (the one it was last read in, else Margin's display's), never closed or parked
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
    case activate // unhide, AXFrontmost (its app activates itself), raise
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
    case putAway(Int, UInt64?) // the person's own window back on its Desktop (that one; nil: the Desktop of Margin's display)
    case parkAgain
    case closeItem
    case placeAgain
    case sizeTile
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
        case .putAway: return "put away"
        case .parkAgain: return "park again"
        case .closeItem: return "close its item"
        case .placeAgain: return "place again"
        case .sizeTile: return "size its tile"
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
        case .putAway(let n, let home): return home.map { "put away \(n) (back on its Desktop \($0))" } ?? "put away \(n) (onto the Desktop of Margin's display)"
        case .fallback(let why): return "fallback (\(why))"
        default: return name
        }
    }
    // Its budget's key: per window for the ones that act on one.
    var key: String {
        switch self {
        case .closeLeftover(let n), .parkLeftover(let n): return "leftover \(n)"
        case .parkStrip(let n): return "strip \(n)"
        case .putAway(let n, _): return "own \(n)"
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
    // The person's own window only: the Desktop it was last read in (nil: never read on one).
    var home: UInt64? = nil

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
    var goneFor: Double? = nil // ...this long ago (the grace for a replacement main window)
    var place = WindowPlace.unread // where it is (the model's)
    var onScreen: Bool? = nil
    var offScreenReads = 0 // polls in a row it was in Margin's Space, the current one, and off the on-screen list (its own read too)
    var strayReads = 0 // polls in a row a parked one was found in a user Space (one read can miss mid-transition)
    var atPage: Bool? = nil // a window-mode window where `frameWindow` puts it (the page area, or its own size centred in it)
    var offPageReads = 0 // polls in a row a shown member's bounds weren't the page area (its app moved it)
    // Live resize: its window's own tile is in Margin's Space (sized by its rect), and that rect isn't the page area's
    // (placed for another page area, or its window found off it twice). `dragging`: a drag of the sidebar's edge under way
    // (the one shown follows it live: nothing sized until it's over).
    var tile = false
    var tileStale = false
    var dragging = false
    var fullScreen: Bool? = nil // Accessibility's AXFullScreen
    var canFullScreen: Bool? = nil // AXFullScreen settable
    var ownFullScreenSpace: UInt64? = nil // a full-screen Space of its app's it's in (not Margin's)
    var marginCurrent = true // Margin's Space the current one of its display, Margin's window in it
    var busy = false // an operation (macOS's transition, an open) still running for it

    // The app's other windows, by the model's kinds.
    var replacement: Int? = nil // a main-kind window that replaced the hosted one (or the only one after it went)
    var leftovers: [HostOther] = []
    var strips: [HostOther] = []
    var ownWindows: [HostOther] = [] // the person's own windows of its app (kinds' `own`): one in Margin's Space is put away

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
        if tile, tileStale { parts.append("its tile not at the page area") }
        let left = leftovers.filter(\.inUserSpace)
        if !left.isEmpty { parts.append("leftover\(left.count == 1 ? "" : "s") \(left.map { "\($0.number) (\($0.place.text)\($0.onScreen == true ? ", on screen" : ""))" }.joined(separator: ", "))") }
        let st = strips.filter { $0.inUserSpace || $0.onScreen == true }
        if !st.isEmpty { parts.append("strip\(st.count == 1 ? "" : "s") \(st.map { "\($0.number)" }.joined(separator: ", "))") }
        let own = ownWindows.filter { $0.place == .margin }
        if !own.isEmpty { parts.append("the person's own window\(own.count == 1 ? "" : "s") \(own.map { "\($0.number)" }.joined(separator: ", ")) in Margin's Space") }
        if !marginCurrent { parts.append("Margin's Space not current") }
        return parts.joined(separator: "; ")
    }
}

nonisolated enum HostReconciler {
    // Each correction's budget per show (tries), the core's; `bringForward`'s rungs once each, then the fallback.
    static func budget(of c: HostCorrection) -> Int {
        let family: String
        switch c {
        case .closeLeftover, .parkLeftover: family = "leftover"
        case .parkStrip: family = "strip"
        case .adopt: family = "adopt"
        case .bringForward: family = "bring forward"
        default: family = c.name
        }
        return HostCore.shared.budget(family) ?? 1
    }
    // Reads in a row a shown window has to be off screen before it's brought forward.
    static var offScreenAfter: Int { Int(HostCore.shared.constant("offScreenAfter") ?? 2) }
    // How long a shown window that went is given for its app to show another main window before its item is closed.
    static var goneGrace: Double { HostCore.shared.constant("goneGrace") ?? 1.0 }
    // Reads in a row a shown member has to be off the page area before it's placed again.
    static var offPageAfter: Int { Int(HostCore.shared.constant("offPageAfter") ?? 2) }

    // The corrections that bring `s` to `d`, most urgent first (the engine applies the first, then looks again).
    // Empty: settled (or the core refused the request, said in the log).
    static func step(_ s: HostSituation, _ d: HostDesired) -> [HostCorrection] {
        let answer = HostCore.shared.call(["type": "step", "situation": s.coreJSON, "desired": d.coreName])
        return (answer["corrections"] as? [[String: Any]] ?? []).compactMap(HostCorrection.init(coreJSON:))
    }
}

nonisolated extension HostDesired {
    var coreName: String {
        switch self {
        case .shown: return "shown"
        case .parked: return "parked"
        case .givenBack: return "givenBack"
        }
    }
}

nonisolated extension HostSituation {
    var coreJSON: [String: Any] {
        var d: [String: Any] = [
            "running": running, "launchedByMargin": launchedByMargin, "phase": phase.rawValue, "mode": mode == .window ? "window" : "fullScreen",
            "member": member, "windowGone": windowGone, "place": place.coreName, "offScreenReads": offScreenReads, "strayReads": strayReads,
            "offPageReads": offPageReads, "tile": tile, "tileStale": tileStale, "dragging": dragging, "marginCurrent": marginCurrent, "busy": busy,
            "leftovers": leftovers.map(\.coreJSON), "strips": strips.map(\.coreJSON), "ownWindows": ownWindows.map(\.coreJSON), "tries": tries,
        ]
        if let hidden { d["hidden"] = hidden }
        if let window { d["window"] = window }
        if let goneFor { d["goneFor"] = goneFor }
        if let onScreen { d["onScreen"] = onScreen }
        if let atPage { d["atPage"] = atPage }
        if let fullScreen { d["fullScreen"] = fullScreen }
        if let canFullScreen { d["canFullScreen"] = canFullScreen }
        if let own = ownFullScreenSpace { d["ownFullScreenSpace"] = own }
        if let replacement { d["replacement"] = replacement }
        return d
    }
}

nonisolated extension HostOther {
    var coreJSON: [String: Any] {
        var d: [String: Any] = ["number": number, "place": place.coreName, "closable": closable]
        if let onScreen { d["onScreen"] = onScreen }
        if let home { d["home"] = home }
        return d
    }
}

nonisolated extension HostCorrection {
    // As the core reads it (the decoder's inverse).
    var coreJSON: [String: Any] {
        switch self {
        case .launch: return ["type": "launch"]
        case .reopen: return ["type": "reopen"]
        case .unhide: return ["type": "unhide"]
        case .wait(let why): return ["type": "wait", "why": why]
        case .placeFromOwnSpace(let sp): return ["type": "placeFromOwnSpace", "space": sp]
        case .outThenAsk: return ["type": "outThenAsk"]
        case .askFullScreen: return ["type": "askFullScreen"]
        case .frameWindow: return ["type": "frameWindow"]
        case .putBack: return ["type": "putBack"]
        case .bringForward(let f): return ["type": "bringForward", "rung": f.rawValue]
        case .adopt(let w): return ["type": "adopt", "window": w]
        case .closeLeftover(let w): return ["type": "closeLeftover", "window": w]
        case .parkLeftover(let w): return ["type": "parkLeftover", "window": w]
        case .parkStrip(let w): return ["type": "parkStrip", "window": w]
        case .putAway(let w, let home):
            var d: [String: Any] = ["type": "putAway", "window": w]
            if let home { d["home"] = home }
            return d
        case .parkAgain: return ["type": "parkAgain"]
        case .closeItem: return ["type": "closeItem"]
        case .placeAgain: return ["type": "placeAgain"]
        case .sizeTile: return ["type": "sizeTile"]
        case .fallback(let why): return ["type": "fallback", "why": why]
        }
    }
    init?(coreJSON d: [String: Any]) {
        func n(_ k: String) -> Int? { (d[k] as? NSNumber)?.intValue }
        switch d["type"] as? String {
        case "launch": self = .launch
        case "reopen": self = .reopen
        case "unhide": self = .unhide
        case "wait": self = .wait(d["why"] as? String ?? "")
        case "placeFromOwnSpace": guard let sp = (d["space"] as? NSNumber)?.uint64Value else { return nil }; self = .placeFromOwnSpace(sp)
        case "outThenAsk": self = .outThenAsk
        case "askFullScreen": self = .askFullScreen
        case "frameWindow": self = .frameWindow
        case "putBack": self = .putBack
        case "bringForward": guard let f = (d["rung"] as? String).flatMap(HostForward.init(rawValue:)) else { return nil }; self = .bringForward(f)
        case "adopt": guard let w = n("window") else { return nil }; self = .adopt(w)
        case "closeLeftover": guard let w = n("window") else { return nil }; self = .closeLeftover(w)
        case "parkLeftover": guard let w = n("window") else { return nil }; self = .parkLeftover(w)
        case "parkStrip": guard let w = n("window") else { return nil }; self = .parkStrip(w)
        case "putAway": guard let w = n("window") else { return nil }; self = .putAway(w, (d["home"] as? NSNumber)?.uint64Value)
        case "parkAgain": self = .parkAgain
        case "closeItem": self = .closeItem
        case "placeAgain": self = .placeAgain
        case "sizeTile": self = .sizeTile
        case "fallback": self = .fallback(d["why"] as? String ?? "")
        default: return nil
        }
    }
}
