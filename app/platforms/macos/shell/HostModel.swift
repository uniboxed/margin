// The hosting core's observed model (docs/HOSTING-CORE.md, principle 1; stage 2): what Margin sees of every app it
// hosts or started and every window of it, kept current by HostObserver (HostObserver.swift) from the window server
// (the poll's own reads) and Accessibility (its notifications and a read when a window first appears). Value types
// only: the observer fills them in, WindowKinds.classify gives each window its kind. Nothing here is acted on yet:
// stage 2 only logs it (`host: model: …`) and says it in the dev hook's `front` line.
//
// Never a window's title or a page's address: numbers, bounds, Spaces, roles and kinds only. Accessibility's
// identifier (an app's own name for a kind of window, never the person's content) is kept and never logged.

import AppKit

// Accessibility's word on one window (HostObservation.read): nil fields didn't read.
nonisolated struct HostAXWindow: Equatable, Sendable {
    var role: String? = nil
    var subrole: String? = nil
    var identifier: String? = nil
    var fullScreen: Bool? = nil
    var canFullScreen: Bool? = nil // AXFullScreen settable
    var resizable: Bool? = nil // AXSize settable
    var minimized: Bool? = nil
}

// One read of an app by Accessibility: its main and focused windows (their numbers) and the windows asked for that it
// lists (only the current Space's: one on another Space isn't in it).
nonisolated struct HostAXRead: Equatable, Sendable {
    var main: Int? = nil
    var focused: Int? = nil
    var windows: [Int: HostAXWindow] = [:]
}

nonisolated struct HostModelWindow: Equatable, Sendable {
    let number: Int
    var layer = 0
    var bounds = CGRect.zero // top-left coordinates, the window server's
    var alpha = 1.0
    var onScreen: Bool? = nil // by the poll's on-screen list (nil: none read since it was first seen)
    var spaces: [UInt64]? = nil // its user Spaces, mask 7 (nil: unread; []: in none)
    var privateSpace: UInt64? = nil // the private Space Margin parked it in, by Margin's own record (mask 7 lists none)
    var place = WindowPlace.unread
    var everPlaced = false
    var ax: HostAXWindow? = nil // nil: Accessibility hasn't read it (on another Space, or not asked yet)
    var axMain = false
    var axFocused = false
    var firstSeen: Double
    var lastChanged: Double
    var misses = 0 // polls in a row its bounds didn't read (gone at two: one read can miss mid-transition)
    var kind = WindowKind.transient
    var why = ""

    init(number: Int, at now: Double) {
        self.number = number
        firstSeen = now
        lastChanged = now
    }

    var classified: WindowKinds.Window {
        WindowKinds.Window(number: number, layer: layer, bounds: bounds, alpha: alpha, onScreen: onScreen, place: place, everPlaced: everPlaced,
                           role: ax?.role, subrole: ax?.subrole, fullScreen: ax?.fullScreen, canFullScreen: ax?.canFullScreen,
                           minimized: ax?.minimized, axMain: axMain, axFocused: axFocused)
    }

    // Where it is, from its Spaces (mask 7), the private Space Margin parked it in, Margin's Space and each Space's type.
    static func place(spaces: [UInt64]?, parkedIn: UInt64?, marginSpace: UInt64, type: (UInt64) -> Int?) -> WindowPlace {
        guard let spaces else { return .unread }
        if spaces.isEmpty { return parkedIn != nil ? .parked : .nowhere }
        if spaces.count > 1 { return .several }
        let s = spaces[0]
        if s == marginSpace { return .margin }
        switch type(s) {
        case ManagedSpace.desktopType?: return .desktop
        case ManagedSpace.fullScreenType?: return .fullScreen
        default: return .unread
        }
    }

    // Its place as the log says it: the place and its Spaces' numbers.
    var placeText: String {
        switch place {
        case .unread: return "Spaces unread"
        case .nowhere: return "in no Space"
        case .parked: return "parked"
        default: return "in \(spaces.map { "\($0)" } ?? "[]") (\(place.text))"
        }
    }
}

// An app Margin hosts or started: the process, and every window of it the window server has.
nonisolated struct HostModelApp: Equatable, Sendable {
    let pid: pid_t
    var bundleId: String
    var launchedByMargin: Bool
    var running = true // its process (kill(pid, 0)), whatever NSWorkspace says
    var policy: HostPolicy? = nil
    var hidden: Bool? = nil
    var hosted: [Int: String] = [:] // the windows Margin hosts → their host (HostID's log name)
    var woken: Set<Int> = [] // windows Margin opened only to wake it
    var launchWindows: Set<Int> = [] // its windows as the first show of a window of it ended (an app Margin started)
    var since: Double // when the observer started following it
    var axMain: Int? = nil
    var axFocused: Int? = nil
    var axReadAt: Double? = nil
    var windows: [Int: HostModelWindow] = [:]

    init(pid: pid_t, bundleId: String, launchedByMargin: Bool, since: Double) {
        self.pid = pid
        self.bundleId = bundleId
        self.launchedByMargin = launchedByMargin
        self.since = since
    }

    var mains: [Int] { windows.values.filter { $0.kind == .main }.map(\.number).sorted() }
    var name: String { "\(bundleId) (pid \(pid))" }

    // Every window's kind again (WindowKinds.classify), the last mains kept for a tie. The change in its lastChanged.
    mutating func classify(in placement: HostPlacement, at now: Double) {
        let app = WindowKinds.App(launchedByMargin: launchedByMargin, hosted: Set(hosted.keys), woken: woken, previousMains: Set(mains), launchWindows: launchWindows)
        let verdicts = WindowKinds.classify(windows.values.map(\.classified), app: app, in: placement)
        for (n, v) in verdicts {
            guard var w = windows[n] else { continue }
            if w.kind != v.kind { w.lastChanged = now }
            w.kind = v.kind
            w.why = v.why
            windows[n] = w
        }
    }

    // What the log follows of it: each window that isn't transient, its kind, place and whether it's on screen.
    struct Seen: Equatable, Sendable {
        var kind: WindowKind
        var place: String
        var onScreen: Bool?
    }
    var seen: [Int: Seen] {
        var out: [Int: Seen] = [:]
        for w in windows.values where w.kind != .transient { out[w.number] = Seen(kind: w.kind, place: w.placeText, onScreen: w.onScreen) }
        return out
    }

    // The log line's body for what changed since `before` (nil: nothing to say). Numbers and kinds only.
    func change(from before: [Int: Seen], mainsBefore: [Int]) -> String? {
        let now = seen
        var parts: [String] = []
        func screen(_ s: Bool?) -> String { s.map { $0 ? "on screen" : "off screen" } ?? "on screen unread" }
        for n in Set(before.keys).union(now.keys).sorted() {
            let why = windows[n].map { " (\($0.why))" } ?? ""
            switch (before[n], now[n]) {
            case (nil, let s?):
                parts.append("\(n) \(s.kind.rawValue)\(why), \(s.place), \(screen(s.onScreen))")
            case (let b?, nil):
                if let w = windows[n] {
                    var bits = ["\(b.kind.rawValue) → \(w.kind.rawValue)\(why)"]
                    if b.place != w.placeText { bits.append("\(b.place) → \(w.placeText)") }
                    if b.onScreen != w.onScreen { bits.append("\(screen(b.onScreen)) → \(screen(w.onScreen))") }
                    parts.append("\(n) " + bits.joined(separator: ", "))
                } else { parts.append("\(n) gone (was \(b.kind.rawValue))") }
            case (let b?, let s?):
                var bits: [String] = []
                if b.kind != s.kind { bits.append("\(b.kind.rawValue) → \(s.kind.rawValue)\(why)") }
                if b.place != s.place { bits.append("\(b.place) → \(s.place)") }
                if b.onScreen != s.onScreen { bits.append("\(screen(b.onScreen)) → \(screen(s.onScreen))") }
                if !bits.isEmpty { parts.append("\(n) " + bits.joined(separator: ", ")) }
            default: break
            }
        }
        let mainsNow = mains
        if mainsNow != mainsBefore {
            func list(_ m: [Int]) -> String { m.isEmpty ? "none" : m.map(String.init).joined(separator: ", ") }
            parts.insert("main \(list(mainsBefore)) → \(list(mainsNow))", at: 0)
        }
        return parts.isEmpty ? nil : parts.joined(separator: "; ")
    }

    // One line for the dev hook: its mains (where, on screen) and how many windows of each other kind.
    var summary: String {
        let main = mains.compactMap { windows[$0] }.map { "\($0.number) \($0.placeText)\($0.onScreen.map { $0 ? " on screen" : " off screen" } ?? "")" }
        var counts: [String] = []
        for k in WindowKind.allCases where k != .main {
            let c = windows.values.filter { $0.kind == k }.count
            if c > 0 { counts.append("\(k.rawValue) \(c)") }
        }
        return "\(bundleId) main \(main.isEmpty ? "none" : main.joined(separator: ", "))" + (counts.isEmpty ? "" : " (\(counts.joined(separator: ", ")))")
            + (running ? "" : ", its process gone") + (hidden == true ? ", hidden" : "")
    }
}

nonisolated struct HostModel: Equatable, Sendable {
    var apps: [pid_t: HostModelApp] = [:]
}
