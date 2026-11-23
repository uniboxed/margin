// Every pane of a split draws active (decided by Tirth 2026-11-21, polish on the pane click tap; DECISIONS.md "Every
// pane of a split draws active", docs/PEEK-SPLIT.md §4).
//
// In a split, only the window server's front app was active: the other panes drew inactive (Safari's grey toolbar and
// selection, no caret, document.hasFocus() false). AppKit decides inside each app whether it's active, from event
// records the window server hands it; Margin sends a pane's app the records that say it was activated and that its
// pane's window was made key (PaneRecords.swift, `SLPSPostEventRecordTo`, as yabai and AltTab do). That app then draws
// and behaves as the active app (its key window, its caret and selection, WebKit's focus and :focus), while the window
// server's front process, the pane last clicked (the pane click tap makes it so), keeps the real keyboard and the menu
// bar. A deactivated record gives it back. The research, 2026-11-21 (the scratchpad's allfocus/, e1-e6): held 10 s and
// more, timers and requestAnimationFrame unthrottled either way (only visibility throttles them).
//
// Who: in a split shown in Margin's hosting window on the current Space (the scene the pane click tap is told,
// MarginWindowController `paneScene`), every visible pane whose app isn't the front one (Margin itself in front: the
// focused pane's app counts as the front one), one window per app (AppKit has one key window per app: two panes of
// the same app can't both be active, never tried; the one focused last in it, else its frontmost pane). Never Margin,
// an app Margin doesn't host, one quitting, or one whose window isn't shown. An app with a sheet or an alert up is kept
// as any other (its sheet draws active with its window: the keys are still only the front app's, the ring says
// where). A preview card open: nothing kept or let go for it (its dim covers the split; the card is the front app's),
// the split's apps left as they were until it closes.
//
// When: told the scene as it changes and each change of the front app (NSWorkspace's activation, the tap's focus),
// applied once per main-queue turn; nothing at rest, nothing per pointer move, no polling. An app the window server
// deactivated since (it was the front one, another is now) is kept again; one kept and still kept is never sent a
// record again. Let go (a deactivated record): its pane gone from the scene for `grace` (1 s, the tap's: a layout's
// change takes the panes away for a moment), at once when another app that Margin doesn't host is in front, when its
// app quits (nothing sent), when Margin quits (sent before it ends), and after a crash (the marker: the next launch
// deactivates each app still kept that reads active and isn't the front one).
//
// Off: the part's calls or its records' layout (HostCalls.swift's launch line), `defaults write com.unibox.margin
// MarginPanesActive -bool NO`, a record refused once (said once, off for the run). Then only the focused pane draws
// active, as before.

import AppKit

// The window server's front process, read and set, from any thread (the pane click tap's, the engine's).
nonisolated protocol PaneFronting: AnyObject, Sendable {
    func frontProcess() -> pid_t? // nil: unread
    // The app made the window server's front process (the keyboard's, the menu bar's) and `window` made its key one,
    // whatever AppKit in it believes (an app kept active takes its own activation for done). True: taken.
    func makeFront(pid: pid_t, window: Int) -> Bool
    // The same, its windows left where they are in the window server's order (never raised over the panes it lies under:
    // a split's cut pane, docs/PEEK-SPLIT.md §4b). True: taken.
    func focusWithoutRaise(pid: pid_t, window: Int) -> Bool
    // A mouse event delivered to `window` of `pid` as its own record, at its point less `origin` (the window's top left),
    // never routed by the window server (which would raise it). True: taken.
    func deliver(_ event: CGEvent, pid: pid_t, window: Int, origin: CGPoint) -> Bool
}

nonisolated struct PaneWindow: Hashable, Sendable, CustomStringConvertible {
    var pid: pid_t
    var window: Int
    var description: String { "window \(window) (pid \(pid))" }
}

// Which windows to keep active, from a split's panes (back to front), its focused window, the front app.
nonisolated enum PanesActive {
    struct Wanted: Equatable, Sendable {
        var windows: [pid_t: Int] = [:]
        var away = false // another app (not Margin, not one it hosts) is in front: nothing kept, let go at once
        var front: pid_t? // the app taken as the front one (the window server's, or the focused pane's for Margin)
    }

    // `hosted`: the app is one Margin hosts (its window maybe not in this split: a layout's newcomer). `allowed`: this
    // pane may be kept (hosted, shown, its app not quitting). `lastKey`: each app's window focused last.
    static func wanted(panes: [PaneClickScene.Pane], focused: Int?, front: pid_t?, margin: pid_t,
                       hosted: (pid_t) -> Bool, allowed: (PaneClickScene.Pane) -> Bool, lastKey: [pid_t: Int]) -> Wanted {
        var out = Wanted()
        let pids = Set(panes.map(\.pid))
        if let front, front != margin, front > 0, !pids.contains(front), !hosted(front) { out.away = true; return out }
        guard panes.count > 1, !panes.contains(where: \.card) else { return out }
        var f = front
        if f == nil || f == margin || !pids.contains(f!) { f = focused.flatMap { w in panes.first { $0.window == w }?.pid } }
        guard let f, pids.contains(f) else { return out }
        out.front = f
        var each: [pid_t: [Int]] = [:]
        for p in panes where p.pid != f && p.pid != margin && p.pid > 0 && p.window > 0 && allowed(p) { each[p.pid, default: []].append(p.window) }
        for (pid, list) in each { out.windows[pid] = lastKey[pid].flatMap { list.contains($0) ? $0 : nil } ?? list.last }
        return out
    }
}

// The kept set and what each change sends (its own state machine: the engine runs its actions, HostEngine.swift "all
// panes active").
final class PanesActiveKeeper {
    enum Action: Equatable, CustomStringConvertible {
        case keep(PaneWindow) // activated and its window made key
        case move(PaneWindow, from: Int) // another window of an app kept: the old one's app deactivated, then the new one's activated and key
        case release(PaneWindow, why: String) // deactivated
        var description: String {
            switch self {
            case .keep(let w): return "keep \(w.pid) \(w.window)"
            case .move(let w, let from): return "move \(w.pid) \(from)→\(w.window)"
            case .release(let w, _): return "release \(w.pid) \(w.window)"
            }
        }
    }
    var grace = 1.0
    // A loop's guard: an app kept again more than `limit` times within `limitWindow` s is left alone for the run (said
    // once): the front app never changed that often by a person.
    var limit = 60
    var limitWindow = 10.0
    private(set) var kept: [pid_t: Int] = [:] // sent active, its window: believed active now
    // The marker's: apps sent active since they were last let go (kept, or the front one since while still in the
    // split): after a crash each that still reads active and isn't the front one is deactivated.
    private(set) var touched: [pid_t: Int] = [:]
    private(set) var due: Double? // a let-go waiting for its grace (nil: none)
    private(set) var stopped: Set<pid_t> = [] // apps the loop's guard took out
    private var unwantedSince: [pid_t: Double] = [:]
    private var activated: Set<pid_t> = [] // apps made the front one since the last step (they're deactivated by the next)
    private var lastFront: pid_t?
    private var lastKey: [pid_t: Int] = [:]
    private var keeps: [pid_t: [Double]] = [:]

    // An app made the window server's front one (NSWorkspace's activation, the tap's focus; only one that really is).
    func heardFront(_ pid: pid_t) { activated.insert(pid) }

    // Its app quit: forgotten, nothing sent.
    func gone(_ pid: pid_t) {
        kept[pid] = nil
        touched[pid] = nil
        unwantedSince[pid] = nil
        lastKey[pid] = nil
        keeps[pid] = nil
        activated.remove(pid)
    }

    // Everything let go at once (Margin quits, the part off): each kept window's release.
    func releaseAll(why: String) -> [Action] {
        let out = kept.sorted { $0.key < $1.key }.map { Action.release(PaneWindow(pid: $0.key, window: $0.value), why: why) }
        kept = [:]
        touched = [:]
        unwantedSince = [:]
        due = nil
        return out
    }

    // One step: the scene's panes (back to front; none: no split shown), its focused window, the window server's front
    // app (nil: unread), Margin's pid. What to send, in order.
    // `allowed`: a pane that may be kept now (its window hosted and shown); one that isn't for a moment (an operation
    // moving it) is let go only after the grace. `ending`: its app quitting (asked to quit, Margin's quit): let go at once.
    func step(panes: [PaneClickScene.Pane], focused: Int?, front: pid_t?, margin: pid_t, hosted: (pid_t) -> Bool,
              allowed: (PaneClickScene.Pane) -> Bool, ending: (pid_t) -> Bool = { _ in false }, now: Double) -> [Action] {
        if let f = focused, let p = panes.first(where: { $0.window == f }), !p.card { lastKey[p.pid] = f }
        let card = panes.contains(where: \.card)
        let want = PanesActive.wanted(panes: panes, focused: focused, front: front, margin: margin, hosted: hosted, allowed: { allowed($0) && !ending($0.pid) }, lastKey: lastKey)
        // The front app is active for real (nothing sent to it); an app the window server deactivated since isn't any more.
        var lost = activated
        if let lastFront { lost.insert(lastFront) }
        if let front { lost.remove(front); kept[front] = nil; unwantedSince[front] = nil }
        for pid in lost { kept[pid] = nil }
        activated = []
        if front != nil { lastFront = front }
        var out: [Action] = []
        due = nil
        let shown = Set(panes.map(\.pid))
        // A card open: the split's apps left as they are (only another app in front lets them go).
        for (pid, window) in kept.sorted(by: { $0.key < $1.key }) where want.windows[pid] == nil && (!card || want.away) {
            let w = PaneWindow(pid: pid, window: window)
            if want.away { out.append(release(w, why: "another app in front")); continue }
            if ending(pid) { out.append(release(w, why: "its app quitting")); continue }
            if pid == want.front { continue } // (the focused pane's app while Margin's in front: left as it is, still kept)
            let since = unwantedSince[pid] ?? now
            unwantedSince[pid] = since
            if now - since >= grace { out.append(release(w, why: shown.contains(pid) ? "its pane not shown" : "its pane gone")) } else { due = min(due ?? .infinity, since + grace) }
        }
        if !card {
            for (pid, window) in want.windows.sorted(by: { $0.key < $1.key }) where !stopped.contains(pid) {
                unwantedSince[pid] = nil
                if kept[pid] == window { continue }
                let w = PaneWindow(pid: pid, window: window)
                guard admit(pid, now) else { continue }
                if let old = kept[pid] { out.append(.move(w, from: old)) } else { out.append(.keep(w)) }
                kept[pid] = window
                touched[pid] = window
            }
        }
        // (No longer in the split nor kept, or another app in front, which deactivated every app of the split that wasn't
        // kept: nothing of it left to give back after a crash.)
        for pid in Array(touched.keys) where kept[pid] == nil && (want.away || !shown.contains(pid)) { touched[pid] = nil }
        return out
    }

    private func release(_ w: PaneWindow, why: String) -> Action {
        kept[w.pid] = nil
        touched[w.pid] = nil
        unwantedSince[w.pid] = nil
        return .release(w, why: why)
    }

    private func admit(_ pid: pid_t, _ now: Double) -> Bool {
        var list = (keeps[pid] ?? []).filter { now - $0 < limitWindow }
        list.append(now)
        keeps[pid] = list
        guard list.count > limit else { return true }
        stopped.insert(pid)
        Diagnostics.warn("panes active: pid \(pid) kept active \(list.count) times in \(Int(limitWindow)) s (a loop?): left alone for the run")
        return false
    }
}

// The system's: records sent on a queue of their own (never the main thread's), the front process read and set inline.
// A record is never sent to the window server's front app (it's active for real: a deactivated record would take its
// keys' window from it, an activated one could move its key window).
nonisolated final class PaneActivator: PaneFronting, @unchecked Sendable {
    private let calls: HostPrivate
    private let queue = DispatchQueue(label: "margin.panes-active", qos: .userInteractive)
    // (yabai's: an app deactivated and activated again at once confuses some apps; 40 ms between.)
    var moveGap = 0.04
    private let lock = NSLock()
    private var refusedCode: Int32?
    private let said: @Sendable (String) -> Void

    init(calls: HostPrivate, said: @escaping @Sendable (String) -> Void) {
        self.calls = calls
        self.said = said
    }

    // A record refused once: off for the run.
    var refused: Bool {
        lock.lock()
        defer { lock.unlock() }
        return refusedCode != nil
    }

    func frontProcess() -> pid_t? { calls.frontProcess() }

    func makeFront(pid: pid_t, window: Int) -> Bool {
        guard calls.setFront(pid: pid, window: window) else { return false }
        _ = send(PaneRecords.makeKey(window: window, down: true), to: pid)
        _ = send(PaneRecords.makeKey(window: window, down: false), to: pid)
        return true
    }

    func focusWithoutRaise(pid: pid_t, window: Int) -> Bool {
        guard calls.setFront(pid: pid, window: window, options: HostPrivate.noWindows) else { return false }
        _ = send(PaneRecords.makeKey(window: window, down: true), to: pid)
        _ = send(PaneRecords.makeKey(window: window, down: false), to: pid)
        return true
    }

    func deliver(_ event: CGEvent, pid: pid_t, window: Int, origin: CGPoint) -> Bool {
        let p = event.location
        guard !refused, let own = calls.record(of: event),
              let r = PaneRecords.delivered(own, window: window, local: CGPoint(x: p.x - origin.x, y: p.y - origin.y)) else { return false }
        return send(r, to: pid)
    }

    func keep(_ w: PaneWindow) { queue.async { self.keepNow(w) } }
    func release(_ w: PaneWindow) { queue.async { self.releaseNow(w) } }
    func move(_ w: PaneWindow, from: Int) {
        queue.async {
            guard self.calls.frontProcess() != w.pid else { return }
            _ = self.send(PaneRecords.activation(window: from, activated: false), to: w.pid)
            usleep(useconds_t(self.moveGap * 1_000_000))
            self.keepNow(w)
        }
    }
    // At once, waited for (Margin quits): every one sent before this returns.
    func releaseAll(_ list: [PaneWindow]) { queue.sync { for w in list { self.releaseNow(w) } } }

    private func keepNow(_ w: PaneWindow) {
        guard !refused, calls.frontProcess() != w.pid else { return }
        guard send(PaneRecords.activation(window: w.window, activated: true), to: w.pid) else { return }
        _ = send(PaneRecords.makeKey(window: w.window, down: true), to: w.pid)
        _ = send(PaneRecords.makeKey(window: w.window, down: false), to: w.pid)
    }

    private func releaseNow(_ w: PaneWindow) {
        guard calls.frontProcess() != w.pid else { return }
        _ = send(PaneRecords.activation(window: w.window, activated: false), to: w.pid)
    }

    // (Nil: not sent, its process gone. A code: refused by the window server: said once, off for the run.)
    private func send(_ record: [UInt8], to pid: pid_t) -> Bool {
        guard let code = calls.post(record, to: pid) else { return false }
        guard code != 0 else { return true }
        lock.lock()
        let first = refusedCode == nil
        if first { refusedCode = code }
        lock.unlock()
        if first { said("panes active: the window server refused a record (error \(code)): off for the run, only the focused pane draws active") }
        return false
    }
}
