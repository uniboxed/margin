// The parked windows (app/HANDOFF.md §2.1, §2.5, §2.6, §6.4, and Tirth's
// answers in §13): which of Safari's windows Margin keeps out of sight in a
// private Space of their own, keyed by the window server's number.
//
// - The number is the key, not the copy's window id: a link that drops, a link
//   reconnecting or a new copy of Margin (new window ids) never loses a parked
//   window. After a new copy the entry keeps its number with no window id
//   until `rebind` finds it again (by elimination, then by bounds).
// - An entry is forgotten only when the window is gone: its per-number
//   window-server read is empty for 3 s while Safari's pid runs, or that pid
//   is gone, or the same copy (not a new one) stops listing its window id. Or
//   after Margin's own show or return of it, verified.
// - Hard rule: nothing stops tracking a window that's still alive. `forget`
//   is the only way out, and it refuses (a debug assertion) a window that
//   isn't gone and wasn't shown or returned first.
// - Every call Margin makes for a window carries a Cause, marked before the
//   call. Only the person's own focus on a parked window that came back is
//   reported as theirs; a return the system caused (a wake, a display change,
//   the Dock restarting, or a window back with no focus on it) is parked again
//   quietly, or returned to the Desktop when parking is off. It never starts a
//   handoff.
// - Quit (§13.1): every parked window is closed by its own copy, with no
//   drafts check; one whose copy can't be asked is returned to its Desktop.
//   300 ms in all; a window still parked after that comes back by itself as
//   Margin exits.
// - The crash marker (parked.json, in Application Support/Margin; a harness's
//   or a test's own folder otherwise): written at the first park, kept up to
//   date, removed at a clean quit. It holds numbers, link keys, copy ids,
//   bounds and pids only, never a title or an address. At the next launch,
//   windows of the same Safari process that are still there are parked again
//   (§13.2); the rest are left as normal windows.
// - It logs one line per window (parked, shown, returned, rebound, back), with
//   numbers, link keys, Space ids and milliseconds only.

import AppKit

// Who made a window move (§2.6). Margin's own causes are marked before the call, so the move they
// make is never taken for the person's.
nonisolated enum Cause: Equatable, Sendable, CustomStringConvertible {
    case handoff, recovery, quit, aftercare
    case system(String) // "a wake", "a display change", "the Dock restarting", "no focus on it"
    case person

    var isMargin: Bool {
        switch self {
        case .system, .person: false
        default: true
        }
    }

    var description: String {
        switch self {
        case .handoff: "a handoff"
        case .recovery: "a recovery"
        case .quit: "quit"
        case .aftercare: "the aftercare"
        case .system(let why): why
        case .person: "the person"
        }
    }
}

struct ParkedWindow: Equatable {
    enum Phase: String {
        case parking, parked, showing, returning, closing
        // Still tracked, not in its private Space: a re-park or show that didn't land (its Space
        // destroyed after a show, §4.4), or a park whose return to the Desktop didn't land either.
        case out
    }

    let number: Int // the window server's (CGWindowID): the key
    var link: String // the profile's link key: kept across relinks and new copies
    var windowId: Int? // its copy's id; nil after a new copy until rebound (§2.2)
    var copy: String? // the copy (its instanceId) that id belongs to
    let pid: pid_t // Safari's process
    var space: UInt64? // its own private Space; nil once destroyed after a show that didn't land
    var bounds: CGRect // its normal bounds when parked, for rebinding
    var since: Double // when it was last parked
    var phase: Phase
    var cause: Cause? // the call Margin is making for it, marked before it's made

    var key: WindowKey? { windowId.map { WindowKey(link: link, windowId: $0) } }
    var label: String { "\(link)#\(windowId.map(String.init) ?? "?")" }
    var stepping: Bool { [.parking, .showing, .returning, .closing].contains(phase) }
}

// Why an entry stopped being tracked. The first four mean the window is gone; the next two need
// Margin's own show or return verified first (the hard rule).
nonisolated enum Forget: String, Equatable, Sendable {
    case notListed = "the window server hasn't listed it for 3 s"
    case pidGone = "Safari's process is gone"
    case closedInCopy = "closed in Safari"
    case closedByCopy = "closed by its copy"
    case shown = "shown"
    case returned = "returned to a user Space"
    case neverParked = "its park sent nothing"

    var gone: Bool { [.notListed, .pidGone, .closedInCopy, .closedByCopy].contains(self) }
}

// One read, as the sweep gets it from Shell.track (§2.5).
struct SweepRead {
    var pids: Set<pid_t> // Safari's processes
    var ext: [ExtWindow] // the windows of the copies that report
    var reporting: Set<String> // those copies' links
    var copies: [String: String] = [:] // each reporting link's copy (instanceId)
    var held: Set<String> = [] // links held: dropped a moment ago, or linked again without their state yet
    var moving: Set<Int> = [] // numbers a switch is moving now (its A and B)
}

nonisolated enum SystemStep: Equatable, Sendable {
    case parkAgain
    case returnToDesktop // parking is off
    case wait(String) // nothing done yet (not normal, or a step under way)
}

enum SweepFinding: Equatable {
    case gone(number: Int, link: String, why: Forget) // forgotten
    case held(number: Int, link: String) // its link held or down: nothing changes
    case newCopy(number: Int, link: String) // its window id is nil until rebound
    case returned(number: Int, link: String) // found in a user Space after a step that didn't land: forgotten
    case system(number: Int, link: String, why: String, then: SystemStep) // back by the system: never a handoff
    case person(number: Int, key: WindowKey) // back with the person's focus on it: theirs
}

nonisolated struct ParkingOptions: Sendable {
    var goneAfter: Double = 3 // §2.1: the liveness read empty this long
    var systemWindow: Double = 3 // §2.6: after a wake, a display change or the Dock restarting
    var marginCallGrace: Double = 1 // §2.6: focus this close to Margin's own call for the window is Margin's
    var rebindWithin: CGFloat = 2 // §2.2: bounds that fit the stored ones within this (points)
    var quitWithin: Double = 0.3 // §6.4: every parked window closed or returned within this, in all
}

// The crash marker (§6.4, §13.2).
nonisolated struct ParkingMarker: Codable, Equatable, Sendable {
    nonisolated struct Window: Codable, Equatable, Sendable {
        var number: Int
        var link: String
        var windowId: Int?
        var copy: String?
        var pid: Int32 // Safari's
        var bounds: [Double] // left, top, width, height
    }
    nonisolated struct Shown: Codable, Equatable, Sendable {
        var link: String
        var number: Int
    }

    static let fileName = "parked.json"

    var pid: Int32 // Margin.app's: a marker of a Margin that's still running isn't a crash's
    var build: String? // the macOS build (kern.osversion)
    var at: Double // when it was written, ms since 1970
    var count: Int
    var windows: [Window]
    var shown: [Shown] // each profile's window Margin last showed

    // Application Support/Margin, beside the lasting data's folder (DataStore.appRoot's parent).
    @MainActor static var appRoot: URL { DataStore.appRoot.deletingLastPathComponent() }

    static func read(_ url: URL) -> ParkingMarker? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(ParkingMarker.self, from: data)
    }
}

// What closing or returning every parked window came to.
struct ParkingEnd: Equatable {
    var closed = 0 // by their copies
    var returned = 0 // to their Desktops
    var left = 0 // not done in time, or failed: they come back by themselves as Margin exits
    var ms = 0
}

final class ParkingRegistry {
    private(set) var entries: [Int: ParkedWindow] = [:]
    // Per link: the window number Margin last showed for that profile, its home window (§1.5, §13.11).
    private(set) var lastShown: [String: Int] = [:]
    let options: ParkingOptions
    // Whether parking is on now (the shell's parkingOn): off, a window back by itself is returned.
    var parkingOn: () -> Bool
    // The hard rule's debug assertion; a test records it instead.
    var strandCheck: (String) -> Void = { assertionFailure($0) }

    private let parker: BridgeParker
    private let reads: SpaceReads
    private let clock: SwitchClock
    private let markerURL: URL?
    private let build: String?
    private var markerOn = false // written since the first park, until a clean quit
    private var missingSince: [Int: Double] = [:]
    // Numbers the liveness read has listed since they were parked. Until it has, an empty read
    // proves nothing: whether the window server lists a parked window at all is gate G6's.
    private var listedParked: Set<Int> = []
    private var verifiedOut: Set<Int> = [] // shown or returned, verified: may be forgotten
    private var lastCall: [Int: (cause: Cause, at: Double)] = [:]
    private var systemUntil: Double = -.infinity
    private var systemWhy = ""
    private var personSaid: [Int: Double] = [:] // the focus already reported as the person's
    private var copyOf: [String: String] = [:] // each link's copy, last seen
    private var unboundSaid: [Int: Int] = [:] // how many fit, as last said, for a window left unbound

    init(parker: BridgeParker, reads: SpaceReads, clock: SwitchClock, marker: URL?, build: String?,
         options: ParkingOptions = ParkingOptions(), parkingOn: (() -> Bool)? = nil) {
        self.parker = parker
        self.reads = reads
        self.clock = clock
        markerURL = marker
        self.build = build
        self.options = options
        self.parkingOn = parkingOn ?? { [parker] in parker.isAvailable }
    }

    var numbers: Set<Int> { Set(entries.keys) }
    func isParked(_ number: Int) -> Bool { entries[number] != nil }
    func entries(of link: String) -> [ParkedWindow] { entries.values.filter { $0.link == link }.sorted { $0.since > $1.since } }

    // A switch landed on this window without a park or show (made, or the focus variant).
    func noteShown(link: String, number: Int) {
        guard lastShown[link] != number else { return }
        lastShown[link] = number
        saveMarker()
    }

    // A windows call Margin made for this window itself (setWindowState, focusWindow): focus that
    // follows it within a second is Margin's, not the person's.
    func noteCall(_ number: Int, cause: Cause) { lastCall[number] = (cause, clock.now()) }

    // A wake, a display change, or a com.apple.dock launch (§6.8): for 3 s, any window found back is
    // the system's.
    func systemEvent(_ why: String) {
        systemUntil = clock.now() + options.systemWindow
        systemWhy = why
    }

    // ---- Margin's steps ----

    struct ParkResult {
        let park: ParkOutcome
        var returned: ParkOutcome? // a park that didn't land, then returned to its Desktop (§4.4)
    }

    // Hides the window in a private Space of its own, verified. A park that didn't land is returned
    // to its display's Desktop (the window may be in that Space); one that sent nothing isn't
    // tracked. An entry already parked answers at once.
    // `copy`: the copy the window id belongs to, when the caller knows better than the last read (a
    // crash's marker).
    func park(number: Int, link: String, windowId: Int?, copy: String? = nil, pid: pid_t, bounds: CGRect, cause: Cause,
              done: @escaping (ParkResult) -> Void = { _ in }) {
        if let e = entries[number], e.stepping || e.phase == .parked {
            let failure: ParkFailure? = e.phase == .parked ? nil : .busy
            return done(ParkResult(park: ParkOutcome(number: number, step: .park, failure: failure, ms: 0, tries: 0, space: e.space)))
        }
        let before = entries[number]
        var e = before ?? ParkedWindow(number: number, link: link, windowId: windowId, copy: windowId == nil ? nil : copy ?? copyOf[link], pid: pid,
                                       space: nil, bounds: bounds, since: clock.now(), phase: .parking)
        if before != nil {
            // Back by itself, or out after a step: the copy's word may have moved on.
            e.bounds = bounds
            if let windowId, e.windowId != windowId { (e.windowId, e.copy) = (windowId, copy ?? copyOf[link]) }
        }
        e.phase = .parking
        mark(&e, cause)
        entries[number] = e
        parker.park(number) { [weak self] o in
            guard let self, var e = self.entries[number] else { return done(ParkResult(park: o)) }
            e.cause = nil
            if o.ok {
                e.phase = .parked
                e.space = o.space
                e.since = self.clock.now()
                self.entries[number] = e
                self.missingSince[number] = nil
                self.listedParked.remove(number)
                Diagnostics.note("handoff: parked window \(number) (\(e.label)) in its Space \(o.space.map(String.init) ?? "?") in \(o.ms) ms (\(cause))")
                self.markerOn = true
                self.saveMarker()
                return done(ParkResult(park: o))
            }
            let landedNowhere = if case .notLanded = o.failure { true } else { false }
            guard landedNowhere else {
                // Nothing reached the window: a new entry isn't tracked; one that was out stays out.
                if before == nil {
                    self.forget(number, .neverParked, sent: false)
                } else {
                    e.phase = .out
                    self.entries[number] = e
                }
                Diagnostics.note("handoff: window \(number) (\(e.label)) not parked: \(ParkSelfTest.describe(o.failure))")
                return done(ParkResult(park: o))
            }
            // It may be in its private Space: back to its Desktop, verified, before it's let go.
            e.phase = .out
            self.entries[number] = e
            self.returnToDesktop(number: number, cause: .recovery) { r in done(ParkResult(park: o, returned: r)) }
        }
    }

    // Into the active Space, out of its private Space, verified; then that Space destroyed and the
    // entry forgotten. A show that didn't land destroys that window's Space only (§4.4); the entry
    // stays, out, until it's found back in a user Space or gone.
    func show(number: Int, cause: Cause, done: @escaping (ParkOutcome) -> Void = { _ in }) {
        guard var e = entries[number], !e.stepping else {
            return done(ParkOutcome(number: number, step: .show, failure: entries[number] == nil ? .gone : .busy, ms: 0, tries: 0, space: nil))
        }
        let was = e.phase
        e.phase = .showing
        mark(&e, cause)
        entries[number] = e
        parker.show(number) { [weak self] o in
            guard let self, var e = self.entries[number] else { return done(o) }
            e.cause = nil
            if o.ok {
                self.verifiedOut.insert(number)
                self.lastShown[e.link] = number
                Diagnostics.note("handoff: shown window \(number) (\(e.label)) in \(o.ms) ms (\(cause))")
                self.forget(number, .shown)
                return done(o)
            }
            if case .notLanded = o.failure {
                let space = e.space
                self.parker.destroySpace(of: number)
                e.space = nil
                e.phase = .out
                self.entries[number] = e
                Diagnostics.note("handoff: window \(number) (\(e.label)) wasn't shown: its own Space \(space.map(String.init) ?? "?") destroyed, the others left")
            } else {
                e.phase = was
                self.entries[number] = e
            }
            done(o)
        }
    }

    // To its display's Desktop (type 0), out of its private Space, verified; then forgotten. One that
    // didn't land stays tracked.
    func returnToDesktop(number: Int, cause: Cause, done: @escaping (ParkOutcome) -> Void = { _ in }) {
        guard var e = entries[number], !e.stepping else {
            return done(ParkOutcome(number: number, step: .returnToDesktop, failure: entries[number] == nil ? .gone : .busy, ms: 0, tries: 0, space: nil))
        }
        let was = e.phase
        e.phase = .returning
        mark(&e, cause)
        entries[number] = e
        parker.returnToDesktop(number) { [weak self] o in
            guard let self, var e = self.entries[number] else { return done(o) }
            e.cause = nil
            if o.ok {
                self.verifiedOut.insert(number)
                Diagnostics.note("handoff: returned window \(number) (\(e.label)) to the Desktop \(o.space.map(String.init) ?? "?") in \(o.ms) ms (\(cause))")
                self.forget(number, .returned)
            } else {
                e.phase = was == .parked ? .parked : .out
                self.entries[number] = e
            }
            done(o)
        }
    }

    // ---- quit, and the shown window closed (§13.1, §13.8) ----

    // Asks a window's copy to close it: false when it can't be asked (its copy isn't linked, or its
    // window id isn't known); otherwise `closed` is called once with whether the copy closed it.
    typealias Closer = (ParkedWindow, @escaping (Bool) -> Void) -> Bool

    // Every parked window closed by its copy (or returned to its Desktop when its copy can't close
    // it), all at once, for `within` in all. A window not done by then stays tracked.
    func endAll(cause: Cause, within: Double, close: Closer?, done: @escaping (ParkingEnd) -> Void) {
        let began = clock.now()
        var end = ParkingEnd()
        var waiting = Set(entries.keys)
        var finished = false
        func finish() {
            guard !finished else { return }
            finished = true
            end.left = waiting.count
            end.ms = Int(((clock.now() - began) * 1000).rounded())
            done(end)
        }
        func settled(_ number: Int, _ outcome: WritableKeyPath<ParkingEnd, Int>?) {
            guard !finished, waiting.remove(number) != nil else { return }
            if let outcome { end[keyPath: outcome] += 1 }
            if waiting.isEmpty { finish() }
        }
        guard !waiting.isEmpty else { return finish() }
        clock.after(within) { finish() }
        for number in waiting.sorted() {
            guard let e = entries[number] else { settled(number, nil); continue }
            let back = { [weak self] in
                guard let self else { return }
                self.returnToDesktop(number: number, cause: cause) { o in settled(number, o.ok ? \.returned : nil) }
            }
            guard let close, !e.stepping else { back(); continue }
            var asking = e
            asking.phase = .closing
            mark(&asking, cause)
            entries[number] = asking
            let asked = close(e) { [weak self] closed in
                guard let self, var e = self.entries[number], e.phase == .closing else { return }
                e.cause = nil
                if closed {
                    self.parker.destroySpace(of: number)
                    self.forget(number, .closedByCopy)
                    settled(number, \.closed)
                } else {
                    e.phase = .parked
                    self.entries[number] = e
                    back()
                }
            }
            if !asked {
                if var e = entries[number], e.phase == .closing {
                    e.phase = .parked
                    e.cause = nil
                    entries[number] = e
                }
                back()
            }
        }
    }

    // Every parked window back on its Desktop (a copy that can't be reached; WP9's returns).
    func returnAll(cause: Cause = .quit, within: Double? = nil, done: @escaping (ParkingEnd) -> Void) {
        endAll(cause: cause, within: within ?? options.quitWithin, close: nil, done: done)
    }

    // A clean quit (§6.4, §13.1): every parked window closed by its own copy (no drafts check), or
    // returned when its copy can't be asked; 300 ms in all; then the crash marker removed.
    func quit(close: Closer?, done: @escaping (ParkingEnd) -> Void) {
        let count = entries.count
        endAll(cause: .quit, within: options.quitWithin, close: close) { [weak self] end in
            self?.removeMarker()
            if count > 0 {
                var parts: [String] = []
                if end.closed > 0 { parts.append("closed \(end.closed) parked window\(end.closed == 1 ? "" : "s")") }
                if end.returned > 0 { parts.append("returned \(end.returned) parked window\(end.returned == 1 ? "" : "s") to the Desktop") }
                if end.left > 0 { parts.append("left \(end.left) to come back by \(end.left == 1 ? "itself" : "themselves")") }
                Diagnostics.note("handoff: \(parts.joined(separator: ", ")) at quit (\(end.ms) ms)")
            }
            done(end)
        }
    }

    // ---- each read (§2.5) ----

    func sweep(_ read: SweepRead) -> [SweepFinding] {
        let now = clock.now()
        var found: [SweepFinding] = []
        for (link, copy) in read.copies where read.reporting.contains(link) { copyOf[link] = copy }
        let ext = Dictionary(read.ext.filter { read.reporting.contains($0.key.link) }.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
        for number in entries.keys.sorted() {
            guard var e = entries[number] else { continue }
            // Gone: Safari's process, then the window server's per-number read.
            guard read.pids.contains(e.pid) else {
                forget(number, .pidGone)
                found.append(.gone(number: number, link: e.link, why: .pidGone))
                continue
            }
            let server = reads.window(number)
            if let server, server.pid == e.pid {
                missingSince[number] = nil
                listedParked.insert(number)
            } else if server != nil || listedParked.contains(number) {
                // Another process's window has its number now, or the read that listed it stopped.
                let since = server != nil ? now - options.goneAfter : missingSince[number] ?? now
                missingSince[number] = since
                if now - since >= options.goneAfter - 1e-9 {
                    forget(number, .notListed)
                    found.append(.gone(number: number, link: e.link, why: .notListed))
                    continue
                }
            }
            // Its copy: held or down changes nothing; a new copy unbinds it; the same copy no longer
            // listing it closed it.
            guard read.reporting.contains(e.link) else {
                found.append(.held(number: number, link: e.link))
                continue
            }
            let copy = read.copies[e.link]
            if let id = e.windowId {
                let listed = ext[WindowKey(link: e.link, windowId: id)] != nil
                // A new copy: its ids may be new. So is a copy never seen with this id (parked before
                // any read named its copy) that doesn't list it. "Closed" needs the same copy's word.
                let newCopy = if let before = e.copy { copy != nil && copy != before } else { !listed }
                if newCopy {
                    e.windowId = nil
                    e.copy = nil
                    entries[number] = e
                    Diagnostics.note("handoff: window \(number) (\(e.link)#\(id)): a new copy of Margin in its profile, rebinding")
                    found.append(.newCopy(number: number, link: e.link))
                    saveMarker()
                } else {
                    if e.copy == nil, let copy { e.copy = copy; entries[number] = e }
                    if !listed, !e.stepping {
                        forget(number, .closedInCopy)
                        found.append(.gone(number: number, link: e.link, why: .closedInCopy))
                        continue
                    }
                }
            }
            // Back in a user Space or on screen, with no step or switch of Margin's moving it.
            guard !e.stepping, !read.moving.contains(number) else { continue }
            let spaces = reads.spaces(of: number)
            let inUserSpace = spaces.map { !$0.isEmpty }
            guard inUserSpace == true || server?.onScreen == true else { continue }
            if e.phase == .out {
                // A step that didn't land, then found in a user Space: an ordinary window again.
                guard inUserSpace == true else { continue }
                parker.destroySpace(of: number)
                verifiedOut.insert(number)
                Diagnostics.note("handoff: window \(number) (\(e.label)) back in a user Space: no longer parked")
                forget(number, .returned)
                found.append(.returned(number: number, link: e.link))
                continue
            }
            let mine = e.key.flatMap { ext[$0] }
            let why: String
            if now < systemUntil {
                why = systemWhy
            } else if let mine, let key = e.key, personFocused(mine, e) {
                if personSaid[number] != mine.focusedAt {
                    personSaid[number] = mine.focusedAt
                    Diagnostics.note("handoff: window \(number) (\(e.label)) back with focus on it: the person's")
                    found.append(.person(number: number, key: key))
                }
                continue
            } else {
                why = Self.noFocus
            }
            if let mine, mine.state != "normal" {
                found.append(.system(number: number, link: e.link, why: why, then: .wait("it's \(mine.state)")))
                continue
            }
            let again = parkingOn()
            let how = why == Self.noFocus ? "with no focus on it" : "after \(why)"
            Diagnostics.note("handoff: window \(number) (\(e.label)) back \(how): \(again ? "parked again" : "returned to the Desktop (parking is off)")")
            found.append(.system(number: number, link: e.link, why: why, then: again ? .parkAgain : .returnToDesktop))
            // Out of its private Space now: a park or return that doesn't land leaves it out, and the
            // next read lets it go as the ordinary window it is (never a loop of tries).
            e.phase = .out
            entries[number] = e
            if again {
                park(number: number, link: e.link, windowId: e.windowId, pid: e.pid, bounds: server?.bounds ?? e.bounds, cause: .system(why))
            } else {
                returnToDesktop(number: number, cause: .system(why))
            }
        }
        return found
    }

    static let noFocus = "no focus on it" // a window found back with no focus on it: the system's

    // §2.6: focus its copy heard after it was parked, and not within a second of Margin's own call.
    private func personFocused(_ w: ExtWindow, _ e: ParkedWindow) -> Bool {
        guard w.focused, let at = w.focusedAt, at > e.since else { return false }
        if let call = lastCall[e.number], call.cause.isMargin, abs(at - call.at) < options.marginCallGrace { return false }
        return true
    }

    // ---- rebinding after a new copy (§2.2) ----

    // The link's parked windows with no window id, against that copy's windows no binding has: one
    // normal window and one such number binds by elimination; otherwise each binds to the one normal
    // window whose bounds fit its own within 2 pt, when no other fits either. Anything else stays
    // unbound (§1.5 covers a target with no id).
    @discardableResult
    func rebind(link: String, unbound: [ExtWindow]) -> [WindowKey: Int] {
        let waiting = entries.values.filter { $0.link == link && $0.windowId == nil }.sorted { $0.number < $1.number }
        guard !waiting.isEmpty else { return [:] }
        let taken = Set(entries.values.compactMap(\.key))
        let normal = unbound.filter { $0.key.link == link && $0.state == "normal" && !taken.contains($0.key) }
        var bound: [WindowKey: Int] = [:]
        if waiting.count == 1, normal.count == 1 {
            bind(waiting[0].number, to: normal[0].key, "by elimination")
            bound[normal[0].key] = waiting[0].number
            return bound
        }
        let fits = { (e: ParkedWindow, w: ExtWindow) in w.bounds.map { WindowMatcher.close($0, e.bounds, tolerance: self.options.rebindWithin) } ?? false }
        for e in waiting {
            let mine = normal.filter { fits(e, $0) }
            if mine.count == 1, !waiting.contains(where: { $0.number != e.number && fits($0, mine[0]) }) {
                bind(e.number, to: mine[0].key, "by bounds")
                bound[mine[0].key] = e.number
            } else if unboundSaid[e.number] != mine.count {
                unboundSaid[e.number] = mine.count
                Diagnostics.note("handoff: window \(e.number) (\(link)) left unbound: \(mine.count) of the copy's windows fit")
            }
        }
        return bound
    }

    private func bind(_ number: Int, to key: WindowKey, _ how: String) {
        guard var e = entries[number] else { return }
        e.windowId = key.windowId
        e.copy = copyOf[key.link]
        entries[number] = e
        unboundSaid[number] = nil
        Diagnostics.note("handoff: window \(number) rebound to \(key) (a new copy; \(how))")
        saveMarker()
    }

    // ---- the only way out (§2.1's hard rule) ----

    // Stops tracking a window: only when it's gone, or after Margin's own show or return of it was
    // verified, or a park that sent nothing. Anything else is a bug that would strand a window: it's
    // refused, and the debug build stops.
    func forget(_ number: Int, _ why: Forget, sent: Bool = true) {
        guard let e = entries[number] else { return }
        let allowed: Bool
        switch why {
        case .notListed, .pidGone, .closedInCopy, .closedByCopy: allowed = true
        case .shown, .returned: allowed = verifiedOut.contains(number)
        case .neverParked: allowed = !sent && e.phase == .parking
        }
        guard allowed else {
            strandCheck("handoff: window \(number) (\(e.label)) would stop being tracked (\(why.rawValue)) while it's still alive and parked")
            return
        }
        entries[number] = nil
        verifiedOut.remove(number)
        missingSince[number] = nil
        listedParked.remove(number)
        personSaid[number] = nil
        unboundSaid[number] = nil
        lastCall[number] = nil
        if why.gone {
            // Its private Space has nothing left to hold.
            parker.destroySpace(of: number)
            if lastShown[e.link] == number { lastShown[e.link] = nil }
            Diagnostics.note("handoff: forgot parked window \(number) (\(e.label)): \(why.rawValue)")
        }
        saveMarker()
    }

    private func mark(_ e: inout ParkedWindow, _ cause: Cause) {
        e.cause = cause
        lastCall[e.number] = (cause, clock.now())
    }

    // ---- the crash marker ----

    var marker: ParkingMarker {
        let windows = entries.values.sorted { $0.number < $1.number }.map { e in
            ParkingMarker.Window(number: e.number, link: e.link, windowId: e.windowId, copy: e.copy, pid: e.pid,
                                 bounds: [e.bounds.minX, e.bounds.minY, e.bounds.width, e.bounds.height].map(Double.init))
        }
        return ParkingMarker(pid: ProcessInfo.processInfo.processIdentifier, build: build, at: (clock.now() * 1000).rounded(),
                             count: windows.count, windows: windows,
                             shown: lastShown.sorted { $0.key < $1.key }.map { ParkingMarker.Shown(link: $0.key, number: $0.value) })
    }

    private func saveMarker() {
        guard markerOn, let markerURL else { return }
        do {
            try FileManager.default.createDirectory(at: markerURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            try encoder.encode(marker).write(to: markerURL, options: .atomic)
        } catch {
            Diagnostics.warn("handoff: the crash marker wasn't written (\((error as NSError).code))")
        }
    }

    private func removeMarker() {
        markerOn = false
        guard let markerURL else { return }
        try? FileManager.default.removeItem(at: markerURL)
    }

    // At launch: the marker a crashed Margin left, taken (the file removed, so a second crash never
    // reads it again). One whose Margin is still running isn't a crash's: left alone, nil.
    func takeMarker(running: (pid_t) -> Bool) -> ParkingMarker? {
        guard let markerURL, let marker = ParkingMarker.read(markerURL) else { return nil }
        guard marker.pid == ProcessInfo.processInfo.processIdentifier || !running(marker.pid) else { return nil }
        try? FileManager.default.removeItem(at: markerURL)
        return marker
    }

    // §13.2: each window of the marker that's still there in the same Safari process, with the
    // bounds it had, is parked again (no freeze, no handoff). Safari restarted, gone or moved: left
    // as a normal window. Parking off: all left. `done` gets how many were parked again.
    func adoptAfterCrash(_ marker: ParkingMarker, safariPids: Set<pid_t>, done: @escaping (Int) -> Void = { _ in }) {
        var restarted = 0, gone = 0, moved = 0
        var again: [ParkingMarker.Window] = []
        let on = parkingOn()
        for w in marker.windows {
            guard safariPids.contains(w.pid) else { restarted += 1; continue }
            guard let server = reads.window(w.number), server.pid == w.pid else { gone += 1; continue }
            guard w.bounds.count == 4, WindowMatcher.close(server.bounds, CGRect(x: w.bounds[0], y: w.bounds[1], width: w.bounds[2], height: w.bounds[3]),
                                                         tolerance: options.rebindWithin) else { moved += 1; continue }
            again.append(w)
        }
        // The shown window stays as it is, and stays each profile's home window while Safari's the same.
        for s in marker.shown where lastShown[s.link] == nil && reads.window(s.number).map({ safariPids.contains($0.pid) }) == true {
            lastShown[s.link] = s.number
        }
        var left: [String] = []
        if restarted > 0 { left.append("\(restarted) of an earlier Safari") }
        if gone > 0 { left.append("\(gone) gone") }
        if moved > 0 { left.append("\(moved) moved") }
        if !on, !again.isEmpty { left.append("\(again.count) with parking off") }
        Diagnostics.note("handoff: Margin.app didn't quit cleanly with \(marker.count) parked window\(marker.count == 1 ? "" : "s"): "
                         + "\(on ? again.count : 0) parked again" + (left.isEmpty ? "" : ", left as normal windows: " + left.joined(separator: ", ")))
        guard on, !again.isEmpty else { return done(0) }
        var parked = 0, waiting = again.count
        for w in again {
            // The copy the marker had: the sweep finds out whether it's still the one reporting.
            park(number: w.number, link: w.link, windowId: w.windowId, copy: w.copy, pid: w.pid,
                 bounds: CGRect(x: w.bounds[0], y: w.bounds[1], width: w.bounds[2], height: w.bounds[3]), cause: .recovery) { r in
                if r.park.ok { parked += 1 }
                waiting -= 1
                if waiting == 0 { done(parked) }
            }
        }
    }
}

extension Shell {
    // Where the crash marker lives: Application Support/Margin for the app; a harness's (or a
    // test's) own data folder otherwise, so a test never touches the real one.
    var parkingMarkerURL: URL {
        let root = options.harness || options.dataRoot != nil ? data.store.root : ParkingMarker.appRoot
        return root.appendingPathComponent(ParkingMarker.fileName)
    }

    // At launch, once the self-test has answered: a crash's marker read and taken, and its windows
    // parked again when parking is on (§13.2). A marker of a Margin that's still running is left.
    func recoverParked() {
        guard let parking else { return }
        let me = Bundle.main.bundleIdentifier
        guard let marker = parking.takeMarker(running: { pid in
            guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return false }
            return me != nil && app.bundleIdentifier == me
        }) else { return }
        parking.adoptAfterCrash(marker, safariPids: apps.pids(of: safariIdentifier))
    }
}
