// The hosting core's observer (docs/HOSTING-CORE.md, principle 1; stage 2): keeps the observed model (HostModel.swift)
// current for every app Margin hosts or started, and logs each change of its windows' kinds, main window, Spaces or
// on-screen state (`host: model: <app>: …`, numbers and kinds only). Logging only: nothing in HostEngine reads it to
// decide anything.
//
// What it reads, and when (its cost):
// - The window server: no list of its own. At each poll (HostEngine.poll) it takes the poll's on-screen list, when the
//   poll read one, and the lists of an app's windows on every Space the engine read since the last poll (its own
//   operations: the window choice, Safari's new window, the woken windows), so a window that came up off screen before
//   the app was hosted (a restored full-screen one) is known. Then per window it follows (layer 0, at least 100 pt on a
//   side, or hosted): its bounds and its Spaces (mask 7), one call each. A menu, a tooltip or another layer's window is
//   followed by the on-screen list alone, never read one by one.
// - Accessibility: a watch per app (an AXObserver: a window created, destroyed, moved, resized, minimized or not, the
//   focused or main window changed), started when the app is first followed and stopped when it's given back. Read
//   (role, subrole, full screen, minimized, the app's main and focused windows) only when a window first appears, when
//   a notification names it, or when it comes to Margin's Space (Accessibility lists only the current Space's windows),
//   coalesced per app (`axDelay`), on a queue of its own: never the engine's elements (HostAX), so nothing the engine
//   reads changes. There's no notification for full screen: a resize comes with it, and its AXFullScreen is read then.
// Everything here runs on the main thread; Accessibility's reads and its watch's set-up on their own queue.

import AppKit
import ApplicationServices

nonisolated enum HostAXNote: String, Sendable {
    case created, destroyed, moved, resized, miniaturized, deminiaturized
    case focused = "focused window changed"
    case main = "main window changed"
}

// Accessibility for the observer: an app's notifications, and one read of its windows. The system's
// (RealHostObservation), or a test's stand-in.
protocol HostObservation: AnyObject {
    // Each notification of the app's, heard on the main thread, with its window's number when it has one. True: watched.
    func watch(pid: pid_t, _ heard: @escaping (HostAXNote, Int?) -> Void) -> Bool
    func unwatch(pid: pid_t)
    // The app's main and focused windows, and these windows as it lists them (only the current Space's). Nil: unread.
    func read(pid: pid_t, windows: [Int]) async -> HostAXRead?
}

final class HostObserver {
    // What the engine says of an app it hosts or started (HostEngine.observed).
    struct Tracked: Equatable {
        var pid: pid_t
        var bundleId: String
        var launchedByMargin: Bool
        var hosted: [Int: String] = [:] // its windows Margin hosts → their host's log name
        var parked: [Int: UInt64] = [:] // its windows in a private Space Margin made → that Space
        var woken: Set<Int> = [] // windows it opened only so Margin could wake it
        var launchWindows: Set<Int> = [] // its windows when the first show of a window of it ended (an app Margin started)
    }

    // What it costs (the tests and the dev hook say it).
    struct Cost: Equatable {
        var updates = 0
        var seconds = 0.0 // wall time in `update`, all of them
        var boundsReads = 0
        var spacesReads = 0
        var typeReads = 0
        var axReads = 0
        var notes = 0
    }

    private let sys: HostSystem
    private let source: HostObservation?
    private(set) var model = HostModel()
    private(set) var cost = Cost()
    var say: (String) -> Void = { Diagnostics.note($0) }
    // Accessibility's reads coalesced per app this long; `schedule` runs one later (a test runs it at once).
    var axDelay = 0.1
    var schedule: (Double, @escaping () -> Void) -> Void = { delay, run in DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: run) }
    private var placement = HostPlacement.zero
    private var marginSpace: UInt64 = 0
    private var watching: Set<pid_t> = []
    private var axWanted: [pid_t: Set<Int>] = [:]
    private var axScheduled: Set<pid_t> = []
    private var axTried: [pid_t: [Int: WindowPlace]] = [:] // where each window was when Accessibility was last asked for it
    private var created: [pid_t: Set<Int>] = [:] // windows a notification named, not in the model yet
    private var spaceTypes: [UInt64: Int] = [:]

    init(system: HostSystem, source: HostObservation?) {
        sys = system
        self.source = source
    }

    var watched: Set<pid_t> { watching }

    // The apps followed: new ones added (watched by Accessibility, read once), the ones given back dropped. No reads.
    func sync(_ tracked: [Tracked]) {
        let now = sys.now()
        let pids = Set(tracked.map(\.pid))
        for t in tracked where model.apps[t.pid] == nil {
            model.apps[t.pid] = HostModelApp(pid: t.pid, bundleId: t.bundleId, launchedByMargin: t.launchedByMargin, since: now)
            let pid = t.pid
            if let source, source.watch(pid: pid, { [weak self] note, number in self?.heard(pid: pid, note, number) }) { watching.insert(pid) }
            requestAX(pid, [])
        }
        for pid in model.apps.keys.sorted() where !pids.contains(pid) {
            if watching.remove(pid) != nil { source?.unwatch(pid: pid) }
            if let app = model.apps.removeValue(forKey: pid) { say("host: model: \(app.name): given back, no longer followed") }
            axWanted[pid] = nil
            axTried[pid] = nil
            created[pid] = nil
        }
    }

    // The poll's: every followed app's windows read again (see the top), classified, each change logged.
    // `onScreen`: the poll's on-screen list, nil when it didn't read one. `seen`: lists of an app's windows on every
    // Space the engine read since the last poll.
    func update(_ tracked: [Tracked], onScreen: [ServerWindow]?, seen: [pid_t: [ServerWindow]], placement: HostPlacement, marginSpace: UInt64) {
        let started = DispatchTime.now().uptimeNanoseconds
        defer {
            cost.updates += 1
            cost.seconds += Double(DispatchTime.now().uptimeNanoseconds - started) / 1e9
        }
        self.placement = placement
        self.marginSpace = marginSpace
        sync(tracked)
        let now = sys.now()
        for t in tracked {
            guard var app = model.apps[t.pid] else { continue }
            let before = app.seen, mainsBefore = app.mains
            app.bundleId = t.bundleId
            app.launchedByMargin = t.launchedByMargin
            app.hosted = t.hosted
            app.woken = t.woken
            app.launchWindows = t.launchWindows
            app.running = sys.processRuns(pid: t.pid)
            app.policy = sys.policy(pid: t.pid)
            app.hidden = sys.isHidden(pid: t.pid)
            var listed: [Int: ServerWindow] = [:]
            for w in seen[t.pid] ?? [] where w.pid == t.pid { listed[w.number] = w }
            let screen = onScreen?.filter { $0.pid == t.pid } ?? []
            for w in screen { listed[w.number] = w } // (the on-screen list is the newer read)
            let shown = Set(screen.map(\.number))
            let numbers = Set(app.windows.keys).union(listed.keys).union(t.hosted.keys).union(t.woken).union(created.removeValue(forKey: t.pid) ?? [])
            var askAX: Set<Int> = []
            for n in numbers.sorted() {
                let known = app.windows[n]
                var w = known ?? HostModelWindow(number: n, at: now)
                let was = (w.place, w.onScreen, w.bounds)
                if let l = listed[n] {
                    w.layer = l.layer
                    w.alpha = l.alpha
                    w.bounds = l.bounds
                }
                // (On screen only by this poll's list: the engine's lists are from earlier in its operation. No list this
                // poll: what the last one said, unread for a window first seen now.)
                if onScreen != nil { w.onScreen = shown.contains(n) }
                // (A menu, a tooltip, another layer's window: followed by the lists alone, while it's on screen. One no list
                // has, its bounds not known yet, is read as any other.)
                let light = t.hosted[n] == nil && w.bounds != .zero && (w.layer != 0 || ((w.bounds.width < WindowKinds.tinySide || w.bounds.height < WindowKinds.tinySide) && !WindowKinds.isStrip(w.bounds, in: placement)))
                if light {
                    if w.onScreen != true || listed[n] == nil && onScreen != nil { app.windows[n] = nil; continue }
                    w.place = .unread
                    app.windows[n] = w
                    continue
                }
                cost.boundsReads += 1
                guard let b = sys.bounds(window: n) else {
                    // (Unread: gone at the second poll in a row; meanwhile kept as it was last read.)
                    guard var kept = known, kept.misses < 1 else { app.windows[n] = nil; continue }
                    kept.misses += 1
                    app.windows[n] = kept
                    continue
                }
                w.bounds = b
                w.misses = 0
                cost.spacesReads += 1
                w.spaces = sys.spaces(window: n)
                w.privateSpace = w.spaces == [] ? t.parked[n] : nil
                w.place = HostModelWindow.place(spaces: w.spaces, parkedIn: w.privateSpace, marginSpace: marginSpace, type: spaceType)
                if w.place.placed || w.onScreen == true { w.everPlaced = true }
                w.axMain = app.axMain == n
                w.axFocused = app.axFocused == n
                if was.0 != w.place || was.1 != w.onScreen || was.2 != w.bounds { w.lastChanged = now }
                // (Accessibility asked when it first appears, and again when it comes where Accessibility lists windows.)
                if w.ax == nil, axTried[t.pid]?[n] != w.place, known == nil || w.place == .margin || w.place == .desktop {
                    askAX.insert(n)
                    axTried[t.pid, default: [:]][n] = w.place
                }
                app.windows[n] = w
            }
            if let tried = axTried[t.pid] { axTried[t.pid] = tried.filter { app.windows[$0.key] != nil } }
            app.closed = app.closed.filter { app.windows[$0] != nil }
            app.classify(in: placement, at: now)
            model.apps[t.pid] = app
            if let line = app.change(from: before, mainsBefore: mainsBefore) { say("host: model: \(app.name): \(line)") }
            if !askAX.isEmpty { requestAX(t.pid, askAX) }
        }
    }

    // (A Space's type never changes: read once.)
    private func spaceType(_ space: UInt64) -> Int? {
        if let t = spaceTypes[space] { return t }
        cost.typeReads += 1
        let t = sys.spaceType(space)
        if let t { spaceTypes[space] = t }
        return t
    }

    // ---- Accessibility ----

    // A notification of a followed app's: what it names read (coalesced); a new window followed from the next poll.
    func heard(pid: pid_t, _ note: HostAXNote, _ number: Int?) {
        guard model.apps[pid] != nil else { return }
        cost.notes += 1
        var windows: Set<Int> = []
        if let number, number > 0 {
            switch note {
            case .created:
                model.apps[pid]?.closed.remove(number)
                if model.apps[pid]?.windows[number] == nil { created[pid, default: []].insert(number) }
                windows.insert(number)
            case .moved, .resized, .miniaturized, .deminiaturized, .focused, .main: windows.insert(number)
            case .destroyed:
                // (Closed. The window server may list it a while yet: an NSWindow its app keeps after its close.)
                if model.apps[pid]?.closed.insert(number).inserted == true, model.apps[pid]?.windows[number] != nil {
                    say("host: model: \(model.apps[pid]?.name ?? "\(pid)"): \(number) closed (Accessibility: destroyed)")
                }
                return
            }
        }
        requestAX(pid, windows)
    }

    private func requestAX(_ pid: pid_t, _ windows: Set<Int>) {
        guard source != nil else { return }
        axWanted[pid, default: []].formUnion(windows)
        guard axScheduled.insert(pid).inserted else { return }
        schedule(axDelay) { [weak self] in Task { await self?.flush(pid) } }
    }

    // Accessibility's read of one app now (the coalesced one): its main and focused windows, the windows asked for.
    func flush(_ pid: pid_t) async {
        axScheduled.remove(pid)
        guard let source, model.apps[pid] != nil else { return }
        let wanted = (axWanted.removeValue(forKey: pid) ?? []).sorted()
        cost.axReads += 1
        let read = await source.read(pid: pid, windows: wanted)
        guard var app = model.apps[pid], let read else { return }
        let before = app.seen, mainsBefore = app.mains
        let now = sys.now()
        app.axMain = read.main
        app.axFocused = read.focused
        app.axReadAt = now
        for (n, ax) in read.windows {
            if app.windows[n] == nil {
                // (A window a notification named before the next poll: followed from now.)
                cost.boundsReads += 1
                guard let b = sys.bounds(window: n) else { continue }
                var w = HostModelWindow(number: n, at: now)
                w.bounds = b
                cost.spacesReads += 1
                w.spaces = sys.spaces(window: n)
                w.place = HostModelWindow.place(spaces: w.spaces, parkedIn: nil, marginSpace: marginSpace, type: spaceType)
                w.everPlaced = w.place.placed
                app.windows[n] = w
                created[pid]?.remove(n)
            }
            app.windows[n]?.ax = ax
            app.closed.remove(n) // (listed: not closed)
        }
        for n in app.windows.keys {
            app.windows[n]?.axMain = read.main == n
            app.windows[n]?.axFocused = read.focused == n
        }
        app.classify(in: placement, at: now)
        model.apps[pid] = app
        if let line = app.change(from: before, mainsBefore: mainsBefore) { say("host: model: \(app.name): \(line)") }
    }

    // ---- what it says ----

    // The dev hook's: one app's mains and its other windows' kinds (nil: not followed).
    func summary(of pid: pid_t) -> String? { model.apps[pid]?.summary }

    var summary: String {
        let windows = model.apps.values.reduce(0) { $0 + $1.windows.count }
        let perPoll = cost.updates > 0 ? String(format: ", %.0f µs a poll", cost.seconds / Double(cost.updates) * 1e6) : ""
        return "\(model.apps.count) app\(model.apps.count == 1 ? "" : "s"), \(windows) window\(windows == 1 ? "" : "s")\(perPoll)"
    }
}

// ---- the real one ----

@_silgen_name("_AXUIElementGetWindow") nonisolated private func observedWindowNumber(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

final class RealHostObservation: HostObservation {
    private let ax = HostAXWatch()
    func watch(pid: pid_t, _ heard: @escaping (HostAXNote, Int?) -> Void) -> Bool { ax.watch(pid: pid, heard) }
    func unwatch(pid: pid_t) { ax.unwatch(pid: pid) }
    func read(pid: pid_t, windows: [Int]) async -> HostAXRead? { await ax.read(pid: pid, windows: windows) }
}

// Accessibility's notifications and reads for the observer, on a queue of its own (an app answers on its main thread,
// which may be busy), every element its own: nothing shared with the engine's (HostAX). The run loop source of each
// app's AXObserver is on the main run loop, so its callbacks come there; each window's number is found on the queue.
// As window managers do (yabai): the app's element watched for created, moved, resized, focused and main window
// changed; each window's element for destroyed and minimized or not (registered as the window is created, or listed
// at the start: Accessibility lists only the current Space's windows, so one elsewhere is followed by the poll alone).
nonisolated final class HostAXWatch: @unchecked Sendable {
    private let queue = DispatchQueue(label: "margin.host.observe", qos: .utility)
    let refuses = PrivateCalls.inTests

    // (An element handed to the queue: only ever used there.)
    private struct Held: @unchecked Sendable { let element: AXUIElement }

    final class Entry: @unchecked Sendable {
        let pid: pid_t
        let heard: (HostAXNote, Int?) -> Void // (called on the main thread only)
        weak var owner: HostAXWatch?
        var observer: AXObserver? // (on the queue, then the main thread at its end)
        var windows: [(element: AXUIElement, number: Int)] = [] // on the queue only
        init(pid: pid_t, heard: @escaping (HostAXNote, Int?) -> Void, owner: HostAXWatch) {
            self.pid = pid
            self.heard = heard
            self.owner = owner
        }
    }
    private var entries: [pid_t: Entry] = [:] // on the main thread only

    private static let appNotes: [(String, HostAXNote)] = [
        (kAXWindowCreatedNotification, .created), (kAXWindowMovedNotification, .moved), (kAXWindowResizedNotification, .resized),
        (kAXFocusedWindowChangedNotification, .focused), (kAXMainWindowChangedNotification, .main),
    ]
    private static let windowNotes: [(String, HostAXNote)] = [
        (kAXUIElementDestroyedNotification, .destroyed), (kAXWindowMiniaturizedNotification, .miniaturized), (kAXWindowDeminiaturizedNotification, .deminiaturized),
    ]

    private static let callback: AXObserverCallback = { _, element, notification, refcon in
        guard let refcon else { return }
        let entry = Unmanaged<Entry>.fromOpaque(refcon).takeUnretainedValue()
        entry.owner?.received(entry, element, notification as String)
    }

    private func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
        var v: AnyObject?
        return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
    }

    private func settable(_ e: AXUIElement, _ name: String) -> Bool {
        var settable: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(e, name as CFString, &settable) == .success && settable.boolValue
    }

    private func number(_ e: AXUIElement) -> Int? {
        var n: CGWindowID = 0
        return observedWindowNumber(e, &n) == .success && n > 0 ? Int(n) : nil
    }

    private func element(_ v: AnyObject?) -> AXUIElement? {
        guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    // (main thread)
    func watch(pid: pid_t, _ heard: @escaping (HostAXNote, Int?) -> Void) -> Bool {
        guard !refuses, AXIsProcessTrusted(), entries[pid] == nil else { return entries[pid] != nil }
        let entry = Entry(pid: pid, heard: heard, owner: self)
        entries[pid] = entry
        queue.async {
            var observer: AXObserver?
            guard AXObserverCreate(pid, Self.callback, &observer) == .success, let observer else { return }
            let refcon = Unmanaged.passUnretained(entry).toOpaque()
            let app = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(app, 0.5)
            for (name, _) in Self.appNotes { _ = AXObserverAddNotification(observer, app, name as CFString, refcon) }
            for w in (self.attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] { self.follow(w, entry, observer) }
            entry.observer = observer
            let source = AXObserverGetRunLoopSource(observer)
            DispatchQueue.main.async {
                // (Unwatched meanwhile: never added.)
                guard self.entries[pid] === entry else { return }
                CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
            }
        }
        return true
    }

    // (main thread) Its source off the main run loop after the queue's set-up is over: no callback after this.
    func unwatch(pid: pid_t) {
        guard let entry = entries.removeValue(forKey: pid) else { return }
        queue.async {
            guard let observer = entry.observer else { return }
            DispatchQueue.main.async {
                CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
                entry.observer = nil
            }
        }
    }

    // (queue) A window's own notifications, and its number kept for when it's destroyed (its element can't say then).
    private func follow(_ w: AXUIElement, _ entry: Entry, _ observer: AXObserver) {
        guard let n = number(w), !entry.windows.contains(where: { $0.number == n }) else { return }
        entry.windows.append((w, n))
        let refcon = Unmanaged.passUnretained(entry).toOpaque()
        for (name, _) in Self.windowNotes { _ = AXObserverAddNotification(observer, w, name as CFString, refcon) }
    }

    // (main thread, the callback) Its window's number found on the queue, then told on the main thread.
    fileprivate func received(_ entry: Entry, _ element: AXUIElement, _ name: String) {
        guard let note = (Self.appNotes + Self.windowNotes).first(where: { $0.0 == name })?.1 else { return }
        let held = Held(element: element)
        queue.async {
            let element = held.element
            var n = self.number(element)
            if n == nil, let kept = entry.windows.first(where: { CFEqual($0.element, element) }) { n = kept.number }
            if note == .destroyed { entry.windows.removeAll { CFEqual($0.element, element) } }
            if note == .created, let observer = entry.observer { self.follow(element, entry, observer) }
            let number = n
            DispatchQueue.main.async { MainActor.assumeIsolated { if self.entries[entry.pid] === entry { entry.heard(note, number) } } }
        }
    }

    func read(pid: pid_t, windows: [Int]) async -> HostAXRead? {
        guard !refuses, AXIsProcessTrusted() else { return nil }
        let entry = entries[pid]
        return await withCheckedContinuation { c in queue.async { c.resume(returning: self.readNow(pid, windows, entry)) } }
    }

    // (queue) Each window it lists that was asked for is followed from now too (its destroyed notification: its close),
    // if it wasn't: one on another Space as the watch started isn't.
    private func readNow(_ pid: pid_t, _ wanted: [Int], _ entry: Entry?) -> HostAXRead {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.5)
        var out = HostAXRead()
        out.main = element(attr(app, kAXMainWindowAttribute)).flatMap(number)
        out.focused = element(attr(app, kAXFocusedWindowAttribute)).flatMap(number)
        let want = Set(wanted)
        guard !want.isEmpty else { return out }
        func describe(_ e: AXUIElement) -> HostAXWindow {
            HostAXWindow(role: attr(e, kAXRoleAttribute) as? String, subrole: attr(e, kAXSubroleAttribute) as? String, identifier: attr(e, kAXIdentifierAttribute) as? String,
                         fullScreen: attr(e, "AXFullScreen") as? Bool, canFullScreen: settable(e, "AXFullScreen"), resizable: settable(e, kAXSizeAttribute),
                         minimized: attr(e, kAXMinimizedAttribute) as? Bool)
        }
        let list = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        for e in list {
            guard let n = number(e), want.contains(n) else { continue }
            out.windows[n] = describe(e)
            if let entry, let observer = entry.observer { follow(e, entry, observer) }
        }
        // (A sheet is a child of its window, not one of the app's windows.)
        if out.windows.count < want.count {
            for e in list {
                for c in (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] where (attr(c, kAXRoleAttribute) as? String) == kAXSheetRole {
                    if let n = number(c), want.contains(n) { out.windows[n] = describe(c) }
                }
            }
        }
        return out
    }
}
