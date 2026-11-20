// Margin's ownerless Space (DECISIONS.md "Margin's Space owned by a helper with no Dock icon", 2026-11-19).
//
// macOS makes a full-screen Space's owner the active app whenever the menu bar comes down there (its own reveal, Wi-Fi,
// Bluetooth, battery), and only an app with a Dock icon can be an owner. Margin has one: owning its Space, it took the
// keyboard from the app it hosts at every hover of the top edge. So each Margin window's Space is started by an
// invisible window of Margin Space.app (app/platforms/macos/stage/, LSUIElement: no Dock icon), and Margin's window,
// panel and backdrop join it as plain members (StageCalls.add): nobody owns the Space, the hosted app keeps the
// keyboard, and Margin shows the real menu bar itself (MarginMenuBar.swift).
//
// - The helper is Margin's child process, started once, the first time a window asks; its standard input and output
//   carry one line per message (stage/main.swift lists them). If Margin dies, its end of the pipe closes and the helper
//   quits at once, its Spaces with it.
// - Each Margin window asks for its own stage (`open`): the helper's window for it, into full screen; once it's there,
//   `full` with the window's number. The window's controller then joins that Space (MarginWindowController `joinStage`).
// - Fallback, never a dead end: no helper in the bundle, the calls off (StageCalls), `MarginOwnerlessSpace` NO, the
//   helper not starting, a stage not in full screen within `fullWithin`, or the helper ended three times in a run:
//   `usable` is false, and Margin's window takes AppKit's full screen and owns its Space as before.
// - Costs: the helper about 12 MB, no CPU while idle (it has no timers); Margin reads nothing on a timer for it.

import AppKit

@MainActor
final class MarginStage {
    enum Event: Equatable {
        case window(Int) // the helper's window for it exists (its number)
        case full // it's in full screen (its own Space)
        case left // macOS took it out of full screen (it goes back in by itself)
        case failed(String) // given up: the caller falls back to AppKit's full screen
        case resized(CGSize) // its size changed (a tile change in its Space)
        case gone // the helper ended
    }

    static let key = "MarginOwnerlessSpace" // `defaults write com.unibox.margin MarginOwnerlessSpace -bool NO`: owned by Margin, as before
    static let fullWithin: TimeInterval = 6
    static let maxEnds = 3

    let calls: StageCalls
    private let executable: URL?
    private var process: Process?
    private var input: FileHandle?
    private var pending = ""
    private var handlers: [Int: (Event) -> Void] = [:]
    private var windows: [Int: Int] = [:] // Margin window id → the helper's window number
    private var deadlines: [Int: DispatchWorkItem] = [:]
    private(set) var ends = 0 // times the helper ended while Margin ran
    private(set) var offReason: String?

    init(calls: StageCalls, executable: URL? = MarginStage.bundledExecutable) {
        self.calls = calls
        self.executable = executable
        if UserDefaults.standard.object(forKey: Self.key) as? Bool == false { offReason = "\(Self.key) is NO" }
        else if !calls.availability.space { offReason = "its calls are off (\(calls.availability.reasons["space"] ?? "not checked"))" }
        else if !calls.availability.menuBar { offReason = "the menu bar call is off (\(calls.availability.reasons["menu bar"] ?? "not checked"))" }
        else if executable.map({ FileManager.default.isExecutableFile(atPath: $0.path) }) != true { offReason = "Margin Space.app isn't in Margin's bundle" }
        Diagnostics.note(offReason.map { "ownerless Space: off (\($0)): Margin owns its Space, as before" } ?? "ownerless Space: on (Margin Space.app owns Margin's Spaces)")
    }

    nonisolated static var bundledExecutable: URL? {
        Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/Margin Space.app/Contents/MacOS/margin-space")
    }

    var usable: Bool { offReason == nil }

    // The helper's window for a Margin window (its number, once said).
    func stageWindow(for id: Int) -> Int? { windows[id] }

    // A stage for Margin window `id` on `display`; its events to `handle` (on the main queue). False: not usable now.
    @discardableResult
    func open(id: Int, display: CGDirectDisplayID, handle: @escaping (Event) -> Void) -> Bool {
        guard usable, startHelper() else { return false }
        handlers[id] = handle
        windows[id] = nil
        send("open \(id) \(display)")
        let deadline = DispatchWorkItem { [weak self] in
            guard let self, self.deadlines[id] != nil else { return }
            self.deadlines[id] = nil
            self.handlers[id]?(.failed("not in full screen within \(Int(Self.fullWithin)) s"))
        }
        deadlines[id]?.cancel()
        deadlines[id] = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.fullWithin, execute: deadline)
        return true
    }

    // A stage that didn't come: no more for this run (each try would hold a window up `fullWithin`), said once.
    func giveUp(_ why: String) {
        guard offReason == nil else { return }
        offReason = why
        Diagnostics.warn("ownerless Space: \(why): Margin owns its Space from now on, as before")
    }

    // Its stage closed (the window closing, or falling back): its Space goes with it.
    func close(id: Int) {
        deadlines.removeValue(forKey: id)?.cancel()
        handlers[id] = nil
        windows[id] = nil
        if process?.isRunning == true { send("close \(id)") }
    }

    // Margin's own windows into the stage's Space, and out of every other Space they're in. True: asked, and the first
    // window reads in it.
    func join(_ numbers: [Int], space: UInt64) -> Bool {
        let list = numbers.filter { $0 > 0 }
        guard !list.isEmpty, calls.add(list, to: space) else { return false }
        for n in list {
            let others = (calls.spaces(of: n) ?? []).filter { $0 != space }
            if !others.isEmpty { calls.remove([n], from: others) }
        }
        return calls.spaces(of: list[0])?.contains(space) == true
    }

    // The full-screen Space a window is in (its stage's), nil: none.
    func fullScreenSpace(of window: Int) -> UInt64? {
        calls.spaces(of: window)?.first { calls.spaceType($0) == ManagedSpace.fullScreenType }
    }

    // ---- the helper ----

    private func startHelper() -> Bool {
        if process?.isRunning == true { return true }
        guard let executable, usable else { return false }
        let p = Process()
        p.executableURL = executable
        let toHelper = Pipe(), fromHelper = Pipe()
        p.standardInput = toHelper
        p.standardOutput = fromHelper
        p.standardError = FileHandle.nullDevice
        fromHelper.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            if data.isEmpty { h.readabilityHandler = nil }
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.read(data) } }
        }
        p.terminationHandler = { [weak self] ended in
            let status = ended.terminationStatus
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.ended(status) } }
        }
        do { try p.run() } catch {
            offReason = "Margin Space.app didn't start (\(error.localizedDescription))"
            Diagnostics.warn("ownerless Space: \(offReason ?? ""): Margin owns its Space, as before")
            return false
        }
        process = p
        input = toHelper.fileHandleForWriting
        Diagnostics.note("ownerless Space: Margin Space.app started (pid \(p.processIdentifier))")
        return true
    }

    private func send(_ line: String) {
        guard let input else { return }
        do { try input.write(contentsOf: Data((line + "\n").utf8)) } catch {
            Diagnostics.warn("ownerless Space: a message to Margin Space.app didn't go (\(error.localizedDescription))")
        }
    }

    private func read(_ data: Data) {
        guard !data.isEmpty else { return }
        pending += String(decoding: data, as: UTF8.self)
        while let end = pending.firstIndex(of: "\n") {
            let line = String(pending[..<end])
            pending = String(pending[pending.index(after: end)...])
            heard(line)
        }
    }

    private func heard(_ line: String) {
        let parts = line.split(separator: " ").map(String.init)
        guard let verb = parts.first else { return }
        if verb == "ready" { return }
        guard parts.count >= 2, let id = Int(parts[1]), let handle = handlers[id] else { return }
        switch verb {
        case "window":
            if parts.count >= 3, let n = Int(parts[2]) { windows[id] = n; handle(.window(n)) }
        case "full":
            deadlines.removeValue(forKey: id)?.cancel()
            handle(.full)
        case "left":
            handle(.left)
        case "failed":
            deadlines.removeValue(forKey: id)?.cancel()
            handle(.failed("macOS didn't take its stage to full screen"))
        case "resized":
            if parts.count >= 4, let w = Double(parts[2]), let h = Double(parts[3]) { handle(.resized(CGSize(width: w, height: h))) }
        default:
            break
        }
    }

    private func ended(_ status: Int32) {
        process = nil
        input = nil
        pending = ""
        ends += 1
        for d in deadlines.values { d.cancel() }
        deadlines = [:]
        windows = [:]
        let gone = handlers
        handlers = [:]
        if ends >= Self.maxEnds, offReason == nil {
            offReason = "Margin Space.app ended \(ends) times"
            Diagnostics.warn("ownerless Space: \(offReason ?? ""): Margin owns its Space from now on, as before")
        } else {
            Diagnostics.warn("ownerless Space: Margin Space.app ended (status \(status), \(ends) of \(Self.maxEnds)): started again when a window asks")
        }
        for h in gone.values { h(.gone) }
    }

    // ---- Margin's other windows while a Margin window is in its stage's Space ----

    // AppKit puts any window Margin opens on Margin's own Desktop, out of sight from a Space Margin doesn't own: a menu's
    // windows (the menu bar's, its UI's pop-ups and context menus: one per menu and submenu, made as it opens, often
    // placed again after) and a window made key (the quit prompt, the About panel). Each is added to the stage's Space
    // of the Margin window on the current Space as it appears (a menu's every 10 ms while it tracks: an in-process list,
    // no reads of the window server), and a menu's taken out again once it's closed (left in the Space, an ordered-out
    // menu window kept the pointer from what was under it: the kit, 2026-11-19).
    var currentSpace: () -> UInt64? = { nil } // the stage Space of the Margin window on the current Space (MarginWindows)
    private var watching: [NSObjectProtocol] = []
    private var menuTimer: Timer?
    private var menuWindows = Set<Int>()
    private var menuSpace: UInt64 = 0
    private var tracking = 0

    func watchOwnWindows() {
        guard watching.isEmpty, usable else { return }
        let c = NotificationCenter.default
        watching = [
            c.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.menuBegan() } },
            c.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.menuEnded() } },
            c.addObserver(forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main) { [weak self] note in
                MainActor.assumeIsolated { if let w = note.object as? NSWindow { self?.adopt(w) } }
            },
        ]
    }

    private func menuBegan() {
        tracking += 1
        guard tracking == 1, let space = currentSpace() else { return }
        menuSpace = space
        let before = Set(NSApp.windows.filter { $0.level.rawValue >= Self.menuLevel && !$0.isVisible }.map(\.windowNumber))
        let t = Timer(timeInterval: 0.01, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let now = NSApp.windows.filter { $0.level.rawValue >= Self.menuLevel && $0.windowNumber > 0 && (!before.contains($0.windowNumber) || $0.isVisible) }.map(\.windowNumber)
                guard !now.isEmpty else { return }
                self.calls.add(now, to: space) // (idempotent: AppKit may place a menu window again after it opened)
                self.menuWindows.formUnion(now)
            }
        }
        RunLoop.main.add(t, forMode: .common)
        menuTimer = t
        t.fire()
    }

    private func menuEnded() {
        tracking = max(0, tracking - 1)
        guard tracking == 0 else { return }
        menuTimer?.invalidate()
        menuTimer = nil
        let space = menuSpace
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.tracking == 0 else { return }
                let gone = self.menuWindows.filter { n in !NSApp.windows.contains { $0.windowNumber == n && $0.isVisible } }
                self.menuWindows.subtract(gone)
                if !gone.isEmpty, space > 0 { self.calls.remove(Array(gone), from: [space]) }
            }
        }
    }

    private static let menuLevel = Int(CGWindowLevelForKey(.popUpMenuWindow))

    private func adopt(_ w: NSWindow) {
        guard w.level.rawValue < Self.menuLevel, w.windowNumber > 0, let space = currentSpace(),
              NSApp.windows.contains(where: { $0 === w }), calls.spaces(of: w.windowNumber)?.contains(space) == false else { return }
        if join([w.windowNumber], space: space) { Diagnostics.note("ownerless Space: a window of Margin's made key brought into Margin's Space") }
    }

    // Margin quitting: the helper told to close everything (it quits as Margin's end of the pipe closes anyway).
    func stop() {
        for o in watching { NotificationCenter.default.removeObserver(o) }
        watching = []
        menuTimer?.invalidate()
        for id in Array(handlers.keys) { close(id: id) }
        try? input?.close()
        input = nil
    }
}
