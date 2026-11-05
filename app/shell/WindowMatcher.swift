// Which window server window is which of the extension's windows (PLAN.md
// §5), as lasting bindings learned from evidence, never guessed
// (WindowBinder), and whether an overlay is stacked just above its browser
// window (WindowMatcher.stackedAbove).
//
// The extension knows its windows by id (per copy, so per profile), with
// their bounds, state, which one its copy calls focused, and when its copy
// heard each one focused and created (`focusedAt`, `createdAt`: the same
// machine's clock). The window server knows them by number, with bounds,
// whether each is on screen and the order front to back, but not whose they
// are: every Safari profile's windows are one process's. Two full-screen
// windows on one display have the same bounds, and copies' `focused` flags lag
// and disagree while a Space changes (Tirth's log, 2026-11-05: two profiles'
// windows swapped for 650 ms when focus broke the tie). So:
//
//  - A binding, once made, holds while both windows exist. It never changes
//    on a focus flag. It goes when the extension's window closes, the window
//    server's goes, the copy goes (or a new copy of Margin starts, whose ids
//    may be new), and it moves only on strong evidence: two separate focus
//    changes both saying so, or its bounds matching one other free window
//    alone, steadily, while its own don't.
//  - Bindings are learned only from evidence, between windows not bound yet:
//    made by Margin (the app's own request, the profile switch's
//    openSpaceWindow, answered with its id, and the one new window server
//    window since); created together (a copy's windows.onCreated and a new window server
//    window, each alone at that time); focus moved (a copy's onFocusChanged
//    and the browser's front window changing at about that time, each alone);
//    the only free window with its bounds (on both sides); settled focus (the
//    only window its copies call focused, the same front window for a while,
//    and as many browser windows with those bounds as the copies report).
//  - A window it can't tell yet gets no binding, so no overlay is drawn over
//    it (it says so in the log, once per reason) rather than the wrong one.
//
// Every binding made, moved or dropped is one log line with why.

import CoreGraphics
import Foundation

// One of an extension copy's windows: its link (Hello.key) and its id there.
nonisolated struct WindowKey: Hashable, Comparable, CustomStringConvertible {
    let link: String
    let windowId: Int
    static func < (a: WindowKey, b: WindowKey) -> Bool { (a.link, a.windowId) < (b.link, b.windowId) }
    var description: String { "\(link)#\(windowId)" }
}

// A window as the extension reports it (`windows`, app/PROTOCOL.md).
struct ExtWindow: Equatable {
    let key: WindowKey
    let bounds: CGRect?
    let state: String // normal, fullscreen, maximized, minimized
    let focused: Bool
    let activeTabId: Int?
    // Seconds since 1970 (the copy's Date.now(), the same clock as the app's): when its copy last heard
    // windows.onFocusChanged name it, and windows.onCreated (nil: not heard since the copy started).
    var focusedAt: Double?
    var createdAt: Double?

    init(key: WindowKey, bounds: CGRect?, state: String, focused: Bool, activeTabId: Int?, focusedAt: Double? = nil, createdAt: Double? = nil) {
        (self.key, self.bounds, self.state, self.focused, self.activeTabId, self.focusedAt, self.createdAt) = (key, bounds, state, focused, activeTabId, focusedAt, createdAt)
    }

    static func parse(_ list: [JSONObject], link: String) -> [ExtWindow] {
        list.compactMap { w in
            guard let id = int(w["windowId"] ?? w["id"]) else { return nil }
            var bounds: CGRect?
            if let l = num(w["left"]), let t = num(w["top"]), let width = num(w["width"]), let height = num(w["height"]), width > 0, height > 0 {
                bounds = CGRect(x: l, y: t, width: width, height: height)
            }
            let ms = { (v: Any?) in num(v).flatMap { $0 > 0 ? $0 / 1000 : nil } }
            return ExtWindow(key: WindowKey(link: link, windowId: id), bounds: bounds, state: w["state"] as? String ?? "normal",
                             focused: w["focused"] as? Bool ?? false, activeTabId: int(w["activeTabId"]),
                             focusedAt: ms(w["focusedAt"]), createdAt: ms(w["createdAt"]))
        }
    }
}

enum WindowMatcher {
    // How far each edge may be off (points): browsers round, and a window being animated lags a poll.
    static let tolerance: CGFloat = 8
    // The smallest window that can be a browser window (not a popover, a sheet, a tooltip).
    static let minSize: CGFloat = 120

    static func close(_ a: CGRect, _ b: CGRect, tolerance: CGFloat = tolerance) -> Bool {
        abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance && abs(a.maxX - b.maxX) <= tolerance && abs(a.maxY - b.maxY) <= tolerance
    }

    // The browser's windows a binding can be: normal ones (layer 0), drawn, browser-sized.
    static func candidates(_ server: [ServerWindow], pids: Set<pid_t>) -> [ServerWindow] {
        server.filter { pids.contains($0.pid) && $0.layer == 0 && $0.alpha > 0 && $0.bounds.width >= minSize && $0.bounds.height >= minSize }
    }

    /// Whether `overlay` is just above `browser` in the window server's list:
    /// both on screen, the overlay nearer the front, and no other normal or
    /// higher window (any app's, another overlay) between them.
    static func stackedAbove(_ list: [ServerWindow], overlay: Int, browser: Int) -> Bool {
        let shown = list.filter(\.onScreen).sorted { $0.order < $1.order }
        guard let o = shown.firstIndex(where: { $0.number == overlay }), let b = shown.firstIndex(where: { $0.number == browser }), o < b else { return false }
        let browserPid = shown[b].pid
        // The browser's own small windows (a popover above its window) don't count.
        return !shown[(o + 1)..<b].contains { $0.layer >= 0 && $0.alpha > 0 && !($0.pid == browserPid && $0.layer > 0) && $0.bounds.intersects(shown[b].bounds) }
    }

    static func describe(_ r: CGRect) -> String { "\(Int(r.minX)),\(Int(r.minY)) \(Int(r.width))×\(Int(r.height))" }

    // A time as the log shows it (local, to the millisecond).
    static func clock(_ t: Double) -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f.string(from: Date(timeIntervalSince1970: t))
    }
}

/// One browser's bindings (Safari's, Chrome's): each extension window to the
/// number of the window server window it is. `update` once per read of the
/// window server; it returns every binding.
final class WindowBinder {
    struct Timing {
        // A focus or a creation and the window server's change it goes with: this far apart at most (seconds),
        // beyond the reads either side of the change.
        var slack: Double = 0.5
        // Nothing else of the kind this near it (another focus, another front window, another new window).
        var alone: Double = 1.0
        // A change seen across a longer gap between reads says too little about when it happened.
        var maxGap: Double = 1.0
        // A copy's report may come this late (a busy background): an event is weighed only once this has passed
        // after `alone`, so the others near it have come.
        var reportLag: Double = 1.0
        // Settled focus: the same only-focused window and front window this long…
        var settle: Double = 1.0
        // …with the front window the same this long (copies' flags may lag a switch by about a second).
        var quiet: Double = 5.0
        // A new window's bounds may take this long to agree with its new extension window's (full screen opening).
        var created: Double = 5.0
        // A bound window whose bounds match another free window, not its own, this long (both still): moved.
        var moved: Double = 2.0
        // A focus change against a binding is remembered this long, for a second one to move it.
        var conflict: Double = 120
        // Events kept this long.
        var history: Double = 20
    }

    struct Binding: Equatable {
        let number: Int
        let why: String
        let at: Double
    }

    let browser: String
    var timing: Timing
    var log: (String) -> Void
    private(set) var bindings: [WindowKey: Binding] = [:]

    private struct Seen { let at: Double; let after: Double; let before: Bool } // first listed between `after` and `at`; `before`: there at the first read
    private struct Change { let at: Double; let after: Double; let number: Int? }
    // `contradicted`: the copy's report that carried it called another of its windows focused.
    private struct Event { let key: WindowKey; let at: Double; var contradicted = false; var decided = false }
    private struct Pending { let key: WindowKey; let number: Int; let until: Double; let why: String }

    private var reads = 0
    private var lastRead: Double = 0
    private var seen: [Int: Seen] = [:]
    private var retired: Set<Int> = [] // a window server window whose extension window closed: never bound again
    private var serverMoved: [Int: (bounds: CGRect, at: Double)] = [:]
    private var extMoved: [WindowKey: (bounds: CGRect, at: Double)] = [:]
    private var front: Int?
    private var frontSince: Double? // when the front window last changed (the first read, for one in front from before)
    private var changes: [Change] = []
    private var focusHeard: [WindowKey: Double] = [:]
    private var createHeard: [WindowKey: Double] = [:]
    private var focusEvents: [Event] = []
    private var createEvents: [Event] = []
    private var pending: [Pending] = []
    private var conflicts: [WindowKey: (number: Int, at: Double)] = [:]
    private var settling: (key: WindowKey, number: Int, since: Double)?
    private var drift: [WindowKey: (number: Int, since: Double)] = [:]
    private struct Made { let key: WindowKey; let since: Double; let until: Double; let why: String }
    private var made: [Made] = [] // windows Margin's own request made (the profile switch's openSpaceWindow)
    private var copyOf: [String: String] = [:] // each link's copy (instanceId), last seen
    private var waitingSaid: [WindowKey: String] = [:]

    init(browser: String, timing: Timing = Timing(), log: @escaping (String) -> Void = { Diagnostics.note($0) }) {
        self.browser = browser
        self.timing = timing
        self.log = log
    }

    var numbers: [WindowKey: Int] { bindings.mapValues(\.number) }

    /// The app's own request made this window (asked at `since`, answered `now` with its id): it's bound
    /// to the one new window the window server lists from about then, once their bounds agree.
    func expect(_ key: WindowKey, since: Double, now: Double, why: String) {
        guard bindings[key] == nil else { return }
        made.removeAll { $0.key == key }
        made.append(Made(key: key, since: since, until: now + timing.created, why: why))
    }

    /// - now: seconds since 1970 (the extension's clock).
    /// - ext: the windows of the copies that report (their state is here).
    /// - reporting: those copies' links; `copies`: each one's identity (its
    ///   instanceId): a new one may have new window ids, so its bindings go.
    /// - held: links whose bindings stay as they are though they say nothing
    ///   now (dropped a moment ago, or linked again without their state yet).
    /// - server: the window server's list; `pids`: the browser's processes;
    ///   `browserInFront`: it's the active app.
    @discardableResult
    func update(now: Double, ext: [ExtWindow], reporting: Set<String>, copies: [String: String] = [:], held: Set<String> = [],
                server: [ServerWindow], pids: Set<pid_t>, browserInFront: Bool) -> [WindowKey: Int] {
        let first = reads == 0
        let after = first ? now : lastRead
        reads += 1
        defer { lastRead = now }
        let T = timing

        // ---- the window server's side ----
        let mine = server.filter { pids.contains($0.pid) && $0.layer == 0 }
        var present: [Int: ServerWindow] = [:]
        for w in mine where present[w.number] == nil { present[w.number] = w }
        let candidates = WindowMatcher.candidates(server, pids: pids)
        for w in mine where seen[w.number] == nil { seen[w.number] = Seen(at: now, after: after, before: first) }
        seen = seen.filter { present[$0.key] != nil }
        retired = retired.filter { present[$0] != nil }
        for w in mine where serverMoved[w.number]?.bounds != w.bounds { serverMoved[w.number] = (w.bounds, now) }
        serverMoved = serverMoved.filter { present[$0.key] != nil }

        let nowFront = browserInFront ? candidates.filter(\.onScreen).min(by: { $0.order < $1.order })?.number : nil
        if first {
            // In front since before the first read: when isn't known, so taken as now (settled focus waits `quiet`).
            front = nowFront
            frontSince = now
            // When it came to the front isn't known: a change at some time before, which no focus can be told against.
            if nowFront != nil { changes.append(Change(at: now, after: now - T.history, number: nowFront)) }
        } else if nowFront != front {
            changes.append(Change(at: now, after: after, number: nowFront))
            front = nowFront
            frontSince = now
        }

        // ---- the extension's side ----
        var byKey: [WindowKey: ExtWindow] = [:]
        for e in ext where reporting.contains(e.key.link) { byKey[e.key] = e }
        let byKeyList = byKey.values.sorted { $0.key < $1.key }
        for e in byKeyList {
            if let b = e.bounds, extMoved[e.key]?.bounds != b { extMoved[e.key] = (b, now) }
            if let t = e.focusedAt, focusHeard[e.key] != t {
                focusHeard[e.key] = t
                let other = byKeyList.contains { $0.key.link == e.key.link && $0.key != e.key && $0.focused }
                focusEvents.append(Event(key: e.key, at: t, contradicted: other))
            }
            if let t = e.createdAt, createHeard[e.key] != t { createHeard[e.key] = t; createEvents.append(Event(key: e.key, at: t)) }
        }
        let gone = { (key: WindowKey) in reporting.contains(key.link) && byKey[key] == nil }
        extMoved = extMoved.filter { !gone($0.key) }
        focusHeard = focusHeard.filter { !gone($0.key) }
        createHeard = createHeard.filter { !gone($0.key) }
        changes.removeAll { $0.at < now - T.history }
        focusEvents.removeAll { $0.at < now - T.history }
        createEvents.removeAll { $0.at < now - T.history }

        // ---- bindings that no longer hold ----
        for (link, copy) in copies where reporting.contains(link) {
            if let before = copyOf[link], before != copy {
                for key in bindings.keys.sorted() where key.link == link { drop(key, "a new copy of Margin started in its profile (its window ids may be new)") }
            }
            copyOf[link] = copy
        }
        for (key, b) in bindings.sorted(by: { $0.key < $1.key }) {
            if !reporting.contains(key.link) && !held.contains(key.link) {
                drop(key, "its copy isn't linked")
            } else if gone(key) {
                retired.insert(b.number)
                drop(key, "closed in the browser")
            } else if present[b.number] == nil {
                drop(key, "window \(b.number) is gone from the window server")
            }
        }
        conflicts = conflicts.filter { byKey[$0.key] != nil && now - $0.value.at < T.conflict }

        // Free: not bound, not a closed window's.
        var bound: Set<Int> { Set(bindings.values.map(\.number)) }
        func freeServer() -> [ServerWindow] { let b = bound; return candidates.filter { !b.contains($0.number) && !retired.contains($0.number) } }
        func freeExt() -> [ExtWindow] { byKey.values.filter { bindings[$0.key] == nil && $0.state != "minimized" && $0.bounds != nil }.sorted { $0.key < $1.key } }
        func fits(_ e: ExtWindow, _ w: ServerWindow) -> Bool { e.bounds.map { WindowMatcher.close($0, w.bounds) } ?? false }

        // ---- moved: a bound window whose bounds match one other free window alone, steadily ----
        for (key, b) in bindings.sorted(by: { $0.key < $1.key }) {
            guard let e = byKey[key], e.state != "minimized", let eb = e.bounds, let own = present[b.number] else { drift[key] = nil; continue }
            if WindowMatcher.close(eb, own.bounds) { drift[key] = nil; continue }
            let others = freeServer().filter { WindowMatcher.close(eb, $0.bounds) }
            guard others.count == 1, let other = others.first, freeExt().allSatisfy({ !fits($0, other) }) else { drift[key] = nil; continue }
            guard let d = drift[key], d.number == other.number else { drift[key] = (other.number, now); continue }
            let still = now - (extMoved[key]?.at ?? now) >= T.moved && now - (serverMoved[other.number]?.at ?? now) >= T.moved
            guard now - d.since >= T.moved, still else { continue }
            drift[key] = nil
            bindings[key] = nil
            bind(key, other.number, now, "its bounds (\(WindowMatcher.describe(eb))) have matched window \(other.number) alone for \(Int(T.moved)) s, not window \(b.number)'s (\(WindowMatcher.describe(own.bounds)))", was: b.number)
        }

        // ---- made by Margin's own request ----
        for m in made where bindings[m.key] == nil {
            guard let e = byKey[m.key] else { continue } // its copy's list may lag the answer
            let new = freeServer().filter { w in seen[w.number].map { !$0.before && $0.at >= m.since - T.slack } ?? false }
            let rivals = made.filter { $0.key != m.key && bindings[$0.key] == nil && now < $0.until }
            guard new.count == 1, rivals.isEmpty, let w = new.first, fits(e, w) else { continue }
            bind(m.key, w.number, now, "\(m.why) at \(WindowMatcher.clock(m.since)), and window \(w.number), first listed at \(WindowMatcher.clock(seen[w.number]!.at)), is the only new window since")
        }
        for m in made where bindings[m.key] == nil && now >= m.until {
            log("\(m.key): \(m.why), but no one new window with its bounds came in \(Int(T.created)) s: left to the other rules")
        }
        made.removeAll { bindings[$0.key] != nil || now >= $0.until || (gone($0.key) && now > $0.since + T.alone + T.reportLag) }

        // ---- created together ----
        for i in createEvents.indices where !createEvents[i].decided && now >= createEvents[i].at + T.alone + T.reportLag {
            createEvents[i].decided = true
            let ev = createEvents[i]
            guard bindings[ev.key] == nil, byKey[ev.key] != nil else { continue }
            let bound = bound
            let new = seen.filter { !$0.value.before && $0.value.at - $0.value.after <= T.maxGap && !bound.contains($0.key) && !retired.contains($0.key) }
            let near = new.filter { ev.at >= $0.value.after - T.alone && ev.at <= $0.value.at + T.alone }
            let at = near.filter { ev.at >= $0.value.after - T.slack && ev.at <= $0.value.at + T.slack }
            let others = createEvents.filter { $0.key != ev.key && abs($0.at - ev.at) <= T.alone }
            guard near.count == 1, at.count == 1, others.isEmpty, let (number, s) = at.first.map({ ($0.key, $0.value) }) else {
                if !near.isEmpty || !others.isEmpty {
                    log("\(ev.key): created at \(WindowMatcher.clock(ev.at)) with \(near.count) new window(s) and \(others.count) other new browser window(s) about then: not told apart that way")
                }
                continue
            }
            pending.append(Pending(key: ev.key, number: number, until: now + T.created,
                                   why: "created together: its copy heard it created at \(WindowMatcher.clock(ev.at)), and window \(number) was first listed by \(WindowMatcher.clock(s.at)), each alone then"))
        }
        for p in pending {
            guard bindings[p.key] == nil, !bound.contains(p.number), let e = byKey[p.key], let w = present[p.number], !retired.contains(p.number) else { continue }
            if candidates.contains(where: { $0.number == p.number }), fits(e, w) {
                bind(p.key, p.number, now, p.why)
            } else if now >= p.until {
                log("\(p.key): created with window \(p.number), but their bounds never agreed (\(e.bounds.map(WindowMatcher.describe) ?? "none") and \(WindowMatcher.describe(w.bounds))): not bound")
            }
        }
        pending.removeAll { p in bindings[p.key] != nil || bound.contains(p.number) || byKey[p.key] == nil || present[p.number] == nil || retired.contains(p.number) || now >= p.until }

        // ---- focus moved ----
        for i in focusEvents.indices where !focusEvents[i].decided && now >= focusEvents[i].at + T.alone + T.reportLag {
            focusEvents[i].decided = true
            let ev = focusEvents[i]
            guard let e = byKey[ev.key], e.state != "minimized", !ev.contradicted else { continue }
            let usable = changes.filter { $0.at - $0.after <= T.maxGap }
            let near = changes.filter { ev.at >= $0.after - T.alone && ev.at <= $0.at + T.alone }
            let at = usable.filter { $0.number != nil && ev.at >= $0.after - T.slack && ev.at <= $0.at + T.slack }
            let others = focusEvents.filter { $0.key != ev.key && abs($0.at - ev.at) <= T.alone }
            guard at.count == 1, near.count == 1, others.isEmpty, let change = at.first, let number = change.number, let w = present[number], !retired.contains(number) else { continue }
            guard fits(e, w) else { continue }
            let why = "focus moved to it at \(WindowMatcher.clock(ev.at)) and window \(number) came to the front by \(WindowMatcher.clock(change.at)), each alone then"
            let holder = bindings.first { $0.value.number == number && $0.key != ev.key }?.key
            if bindings[ev.key]?.number == number {
                conflicts[ev.key] = nil
            } else if bindings[ev.key] == nil && holder == nil {
                bind(ev.key, number, now, why)
            } else if let c = conflicts[ev.key], c.number == number, ev.at - c.at > T.alone {
                conflicts[ev.key] = nil
                let was = bindings[ev.key]?.number
                if let holder { drop(holder, "two focus changes say window \(number) is \(ev.key)'s") }
                bindings[ev.key] = nil
                bind(ev.key, number, now, "two focus changes said so (\(WindowMatcher.clock(c.at)), \(WindowMatcher.clock(ev.at))); the last: " + why, was: was)
            } else {
                conflicts[ev.key] = (number, ev.at)
                let mine = bindings[ev.key].map { "it is window \($0.number)" } ?? "it isn't bound"
                log("\(ev.key): \(why), but \(mine)\(holder.map { " and window \(number) is \($0)'s" } ?? ""): kept (a second focus change saying so would move it)")
            }
        }

        // ---- the only free window with its bounds ----
        func eliminate() {
            var changed = true
            while changed {
                changed = false
                let server = freeServer(), free = freeExt()
                for e in free {
                    let windows = server.filter { fits(e, $0) }
                    guard windows.count == 1, let w = windows.first, free.filter({ fits($0, w) }).count == 1 else { continue }
                    let others = bindings.values.filter { n in present[n.number].map { WindowMatcher.close($0.bounds, w.bounds) } ?? false }.count
                    bind(e.key, w.number, now, "the only free window with its bounds (\(WindowMatcher.describe(w.bounds)))" + (others > 0 ? "; \(others) other(s) with them already bound" : ""))
                    changed = true
                    break
                }
            }
        }
        eliminate()

        // ---- settled focus ----
        let focused = byKey.values.filter { $0.focused && $0.state != "minimized" }
        if browserInFront, held.isEmpty, let f = front, let fw = present[f], !bound.contains(f), !retired.contains(f),
           focused.count == 1, let x = focused.first, bindings[x.key] == nil, fits(x, fw) {
            let sameServer = candidates.filter { WindowMatcher.close($0.bounds, fw.bounds) }.count
            let sameExt = byKey.values.filter { $0.state != "minimized" && fits($0, fw) }.count
            let recent = frontSince.map { now - $0 < T.quiet } ?? false
            // A flag a newer focus (any copy's) contradicts is stale.
            let newest = byKey.values.compactMap(\.focusedAt).max()
            let latest = newest == nil || x.focusedAt == newest
            if sameServer == sameExt, latest {
                if let s = settling, s.key == x.key, s.number == f {
                    if now - s.since >= T.settle, !recent {
                        bind(x.key, f, now, "settled focus: the only window its copies call focused for \(String(format: "%.1f", now - s.since)) s, window \(f) in front for \(String(format: "%.1f", now - (frontSince ?? now))) s (\(sameServer) window(s) with its bounds, all reported)")
                        settling = nil
                    }
                } else {
                    settling = (x.key, f, now)
                }
            } else {
                settling = nil
            }
        } else {
            settling = nil
        }
        eliminate()

        // ---- what can't be told yet ----
        let server = freeServer()
        for e in freeExt() {
            let windows = server.filter { fits(e, $0) }.map(\.number).sorted()
            let reason = windows.isEmpty ? "no free window of the browser has its bounds"
                : windows.count == 1 ? "window \(windows[0]) has its bounds, but so does another of the extension's windows"
                : "\(windows.count) windows have its bounds (\(windows.map(String.init).joined(separator: ", "))): waiting for a focus change or a creation to tell them apart"
            if waitingSaid[e.key] != reason {
                waitingSaid[e.key] = reason
                log("\(e.key) (\(e.state), \(WindowMatcher.describe(e.bounds!))) isn't bound: \(reason); nothing drawn over it")
            }
        }
        waitingSaid = waitingSaid.filter { byKey[$0.key] != nil && bindings[$0.key] == nil }
        return numbers
    }

    private func bind(_ key: WindowKey, _ number: Int, _ now: Double, _ why: String, was: Int? = nil) {
        bindings[key] = Binding(number: number, why: why, at: now)
        conflicts[key] = nil
        drift[key] = nil
        waitingSaid[key] = nil
        pending.removeAll { $0.key == key || $0.number == number }
        log("\(key) is window \(number)\(was.map { " (was \($0))" } ?? ""): \(why)")
    }

    private func drop(_ key: WindowKey, _ why: String) {
        guard let b = bindings.removeValue(forKey: key) else { return }
        conflicts[key] = nil
        drift[key] = nil
        log("\(key) is no longer window \(b.number): \(why)")
    }
}
