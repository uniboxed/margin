// Explicitly approved, owned corner-panel validation of the unchanged production
// NativeHandoffCover. Default dry run creates no NSApplication or windows.
import AppKit
import WebKit

nonisolated final class NativeProbeLog: @unchecked Sendable {
    private let lock = NSLock()
    private let file: FileHandle
    init(_ path: String) throws {
        guard !FileManager.default.fileExists(atPath: path), FileManager.default.createFile(atPath: path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
        file = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
    }
    func event(_ name: String, _ fields: [String: Any] = [:]) {
        var row = fields
        row["event"] = name; row["t"] = ProcessInfo.processInfo.systemUptime
        row["pid"] = ProcessInfo.processInfo.processIdentifier
        guard var data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { return }
        data.append(10)
        lock.lock(); defer { lock.unlock() }
        try? file.write(contentsOf: data)
    }
}

nonisolated final class NativeProbeLedger: @unchecked Sendable {
    private let lock = NSLock()
    private var ids: [UInt64] = []
    private var addTimes: [Double] = []
    func created(_ id: UInt64) { lock.lock(); ids.append(id); lock.unlock() }
    func added() { lock.lock(); addTimes.append(ProcessInfo.processInfo.systemUptime); lock.unlock() }
    var spaces: [UInt64] { lock.lock(); defer { lock.unlock() }; return ids }
    var lastAdd: Double? { lock.lock(); defer { lock.unlock() }; return addTimes.last }
}

@MainActor final class NativeProbeRun {
    let log: NativeProbeLog
    let ledger = NativeProbeLedger()
    let sky: SkyLight
    let settings = CoverPresentationIO.real()
    let pages: OverlayPages
    let observerPath: String
    let context: LiveCoverContext
    var retained: [ObjectIdentifier: (view: WKWebView, original: Bool)] = [:]
    var observers: [Process] = []
    var observerFiles: [String] = []
    var windows: [Int] = []
    var emergencyCount = 0
    var observerIndex = 0
    lazy var presentation = CoverPresentation(io: CoverPresentationIO(reason: settings.reason, read: { [weak self] object in
        guard let self, let view = object as? WKWebView, let value = self.settings.read(view) else { return nil }
        let id = ObjectIdentifier(view)
        if self.retained[id] == nil { self.retained[id] = (view, value) }
        return value
    }, write: { [weak self] object, value in self?.settings.write(object, value) ?? false }))
    lazy var cover: NativeHandoffCover = {
        let base = LiveCoverSpaceIO.real(self.sky), ledger = self.ledger, log = self.log
        let io = LiveCoverSpaceIO(owns: base.owns, create: {
            let id = base.create()
            if let id { ledger.created(id); log.event("space-created", ["space": id]) }
            return id
        }, level: base.level, readLevel: base.readLevel, add: { window, space in
            let result = base.add(window, space)
            ledger.added(); log.event("add-returned-before-watchdog-arm", ["window": window, "space": space])
            return result
        }, show: base.show, hide: base.hide, hideWindow: { window in
            log.event("watchdog-alpha-write-start", ["window": window])
            let result = base.hideWindow(window)
            log.event("watchdog-alpha-write-return", ["window": window, "ok": result])
            return result
        }, destroy: base.destroy, spaces: base.spaces)
        let value = NativeHandoffCover(pages: pages, io: io, presentation: presentation)
        value.onEmergency = { [weak self] in
            guard let self else { return }
            self.emergencyCount += 1
            self.log.event("native-emergency-callback", ["audit": self.cover.validationStatus])
        }
        return value
    }()

    init(root: URL, hello: String, log: NativeProbeLog, observerPath: String, sky: SkyLight) throws {
        guard NSScreen.screens.count == 1, let screen = NSScreen.screens.first, SessionVisibility.allowsCover else { throw CocoaError(.featureUnsupported) }
        self.log = log; self.sky = sky; self.observerPath = observerPath
        pages = OverlayPages(root: root)
        // AppKit coordinates, wholly inside the single display's visible area.
        let visible = screen.visibleFrame
        let corner = CGRect(x: visible.maxX - 332, y: visible.minY + 12, width: 320, height: 180)
        guard visible.contains(corner) else { throw CocoaError(.featureUnsupported) }
        context = LiveCoverContext(hello: hello, display: corner, viewport: CGRect(origin: .zero, size: corner.size))
    }

    func until(_ seconds: Double, _ predicate: () -> Bool) async -> Bool {
        let end = ProcessInfo.processInfo.systemUptime + seconds
        while !predicate(), ProcessInfo.processInfo.systemUptime < end { try? await Task.sleep(nanoseconds: 10_000_000) }
        return predicate()
    }

    func show() async -> Bool {
        guard settings.reason == nil else { log.event("refused", ["reason": settings.reason ?? "unknown"]); return false }
        cover.prepare(context)
        guard await until(4, { self.cover.state == .prepared }) else { log.event("preparation-failed", ["audit": cover.validationStatus]); return false }
        var answer: Bool?
        cover.activate { answer = $0 }
        guard await until(1, { answer != nil }), answer == true, cover.state == .shown,
              let number = cover.windowNumbers.first, cover.windowNumbers.count == 1,
              let space = ledger.spaces.last, sky.coverLevel(space) == 400,
              sky.spaces(forWindows: [UInt32(number)], mask: 15) == [space] else { return false }
        windows.append(number)
        log.event("native-shown", ["window": number, "space": space, "audit": cover.validationStatus,
                                    "watchdogSeconds": NativeHandoffCover.hardLimit])
        print("READY owned corner panel \(number); no browser is controlled", terminator: "\n")
        fflush(stdout)
        return await startObserver(number, space)
    }

    func startObserver(_ number: Int, _ space: UInt64) async -> Bool {
        observerIndex += 1
        let path = observerPath + "-\(observerIndex).jsonl"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        process.arguments = ["--observe", "--window", String(number), "--owner", String(ProcessInfo.processInfo.processIdentifier),
                             "--space", String(space), "--output", path]
        do { try process.run() } catch { return false }
        observers.append(process)
        observerFiles.append(path)
        return await until(1, {
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)), let text = String(data: data, encoding: .utf8) else { return false }
            return text.contains("\"event\":\"observer-visible\"")
        })
    }

    func bridgeDetached(_ view: WKWebView) async -> Bool {
        var detached: Bool?
        view.callAsyncJavaScript("return await window.webkit.messageHandlers.margin.postMessage({op:'hello'}).then(() => false, e => String(e).includes('no overlay'));",
                                 arguments: [:], in: nil, in: .page) { result in
            if case .success(let value) = result { detached = value as? Bool } else { detached = false }
        }
        return await until(2, { detached != nil }) && detached == true
    }

    func clean(_ why: RevealWhy) async -> Bool {
        let ended = cover.end(why)
        let gone = await until(2, {
            self.windows.allSatisfy { number in
                CGWindowListCopyWindowInfo(.optionIncludingWindow, UInt32(number)).flatMap { $0 as? [[String: Any]] }?.contains {
                    ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == number
                } != true
            }
        })
        var restored = true, detached = true
        for entry in retained.values {
            restored = settings.read(entry.view) == entry.original && restored
            let answer = await bridgeDetached(entry.view)
            detached = answer && detached
        }
        let levels = ledger.spaces.allSatisfy { sky.coverLevel($0) == 0 }
        let audit = cover.validationStatus
        let zero = cover.windowNumbers.isEmpty && presentation.count == 0
            && audit.contains("windows 0, views 0, spaces 0, presentation 0, timers 0, cleanup failures 0")
            && audit.contains("created \(windows.count), disposed \(windows.count),")
        log.event("cleanup", ["end": ended, "windowsGone": gone, "levelsZero": levels, "restored": restored,
                               "bridgeDetached": detached, "zero": zero, "audit": cover.validationStatus])
        retained = [:] // inspection deliberately retained views until getter/bridge verification
        return ended && gone && levels && restored && detached && zero
    }

    func blockOwnMainThread(_ seconds: Double) { Thread.sleep(forTimeInterval: seconds) }

    func watchdog() async -> Bool {
        guard await show() else { return false }
        let before = ProcessInfo.processInfo.systemUptime
        log.event("own-main-block-start", ["seconds": 22, "lastAdd": ledger.lastAdd ?? 0])
        // Only this standalone process's main thread; no screen freeze or foreign process.
        blockOwnMainThread(22)
        let resumed = ProcessInfo.processInfo.systemUptime
        log.event("own-main-block-end", ["elapsed": resumed - before])
        // Read the CHILD's independent evidence synchronously before yielding to
        // the main-actor cleanup queued by the real watchdog. A later orderOut
        // must not be mistaken for off-main-thread protection.
        let lines = observerFiles.last.flatMap { try? String(contentsOfFile: $0, encoding: .utf8) }?.split(separator: "\n") ?? []
        let rows = lines.compactMap { line -> [String: Any]? in
            try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
        }
        let hiddenAt = rows.first { ($0["alpha"] as? NSNumber)?.doubleValue == 0 }?["t"] as? Double
        let physicallyHidden = hiddenAt.map { t in
            t > before && t < resumed && t >= (ledger.lastAdd ?? resumed) + 19.8 && t <= (ledger.lastAdd ?? 0) + 20.75
        } ?? false
        log.event("independent-hide-verification", ["ok": physicallyHidden, "firstZeroAt": hiddenAt ?? -1,
                                                    "observedBeforeMainUnblock": hiddenAt.map { $0 < resumed } ?? false])
        guard physicallyHidden else { return false }
        guard await until(2, { self.emergencyCount == 1 }), cover.state == .failed("emergency watchdog") else { return false }
        return await clean(.watchdog)
    }

    func cancelReuse() async -> Bool {
        guard await show(), let firstAdd = ledger.lastAdd else { return false }
        try? await Task.sleep(nanoseconds: 250_000_000)
        guard await clean(.cancelled) else { return false }
        // Keep a clear interval between the first cancelled deadline and the next
        // live deadline; don't rely on a few milliseconds of scheduler ordering.
        try? await Task.sleep(nanoseconds: 5_000_000_000)
        guard await show(), let number = cover.windowNumbers.first else { return false }
        while ProcessInfo.processInfo.systemUptime < firstAdd + NativeHandoffCover.hardLimit + 0.5 {
            guard cover.state == .shown, emergencyCount == 0 else { return false }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        let row = CGWindowListCopyWindowInfo(.optionIncludingWindow, UInt32(number)) as? [[String: Any]]
        let visible = row?.contains { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == number
            && ($0[kCGWindowAlpha as String] as? NSNumber)?.doubleValue == 1
            && ($0[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true } == true
        log.event("old-deadline-crossed", ["newWindowVisible": visible, "emergencies": emergencyCount, "audit": cover.validationStatus])
        let cleaned = await clean(.cancelled)
        return visible && emergencyCount == 0 && cleaned
    }

    func session(_ wanted: String) async -> Bool {
        let apps = WorkspaceApps()
        var matched = false, interrupted = false, woke = false, deniedWhileLocked = false
        let interruption = Set(["will sleep", "screen sleep", "screen locked", "session inactive", "displays changed"])
        apps.onChange = { [weak self] why in
            guard let self else { return }
            self.log.event("workspace-event", ["why": why, "sessionAllows": SessionVisibility.allowsCover])
            if why == wanted { matched = true }
            if matched && why == "woke" { woke = true }
            if matched && wanted == "screen locked" && !SessionVisibility.allowsCover { deniedWhileLocked = true }
            if interruption.contains(why), !interrupted {
                interrupted = true
                // Safety for this standalone panel. This is not Shell's routing
                // or a browser-recovery result; those require the product run.
                _ = self.cover.end(why == "displays changed" ? .aborted : .sleep)
                self.log.event("own-corner-ended-for-session", ["why": why, "audit": self.cover.validationStatus])
            }
        }
        apps.start(); defer { apps.stop() }
        guard await show() else { return false }
        print("USER ACTION READY: \(wanted). This probe never initiates that action."); fflush(stdout)
        let heard = await until(15, {
            if matched && wanted == "screen locked" && !SessionVisibility.allowsCover { deniedWhileLocked = true }
            return (matched && (wanted != "screen locked" || deniedWhileLocked)) || self.emergencyCount > 0
        })
        var wakeVerified = true
        if wanted == "will sleep" {
            if heard && matched { wakeVerified = await until(20, { woke }) }
            else { wakeVerified = false }
        }
        let cleaned = await clean(.cancelled)
        log.event("session-observation-result", ["wanted": wanted, "matched": matched, "interrupted": interrupted,
                                                "heardWithinWindow": heard, "deniedWhileLocked": deniedWhileLocked,
                                                "wakeVerified": wakeVerified, "productRoutingTested": false])
        return heard && matched && interrupted && wakeVerified && emergencyCount == 0 && cleaned
    }
}

@main enum NativeCoverProbe {
    nonisolated static func value(_ name: String) -> String? {
        guard let i = CommandLine.arguments.firstIndex(of: name), i + 1 < CommandLine.arguments.count else { return nil }
        return CommandLine.arguments[i + 1]
    }
    nonisolated static func observe() -> Int32 {
        guard let text = value("--window"), let window = UInt32(text), let textPID = value("--owner"), let owner = Int32(textPID),
              let path = value("--output"), let log = try? NativeProbeLog(path),
              let textSpace = value("--space"), let space = UInt64(textSpace), owner == getppid() else { return 2 }
        let end = ProcessInfo.processInfo.systemUptime + 38
        var seen = false, lastAlpha: Double?, loggedAt = 0.0
        while ProcessInfo.processInfo.systemUptime < end, kill(owner, 0) == 0 {
            let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, window) as? [[String: Any]] ?? []
            guard let row = rows.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == window }) else {
                if seen { log.event("observer-window-gone", ["window": window, "space": space]); return 0 }
                Thread.sleep(forTimeInterval: 0.04); continue
            }
            guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == owner else { log.event("observer-owner-mismatch"); return 1 }
            let alpha = (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? -1
            let now = ProcessInfo.processInfo.systemUptime
            if !seen || alpha != lastAlpha || now - loggedAt >= 1 {
                let onScreen = (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
                log.event(!seen && alpha > 0 && onScreen ? "observer-visible" : "observer-alpha", ["window": window, "space": space,
                    "alpha": alpha, "onScreen": (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false])
                loggedAt = now
            }
            seen = true; lastAlpha = alpha
            Thread.sleep(forTimeInterval: 0.04)
        }
        log.event("observer-deadline-or-parent-exit", ["seen": seen]); return 1
    }
    @MainActor static func main() {
        if CommandLine.arguments.contains("--observe") { exit(observe()) }
        guard CommandLine.arguments.contains("--go"), CommandLine.arguments.contains("--approved-corner") else {
            print("DRY RUN: no NSApplication/window/private write. Modes: watchdog (one320×180corner, real20s timer, own main blocked22s), cancel-reuse (two corners, cross cancelled deadline), session (one corner; user initiates requested OS event). --go --approved-corner requires prior explicit approval. No browser/default/app restart.")
            return
        }
        guard ProcessInfo.processInfo.environment["MARGIN_APP_TESTS"] == nil,
              let mode = value("--mode"), ["watchdog", "cancel-reuse", "session"].contains(mode),
              let root = value("--root"), let helloPath = value("--hello"), let output = value("--output"),
              let hello = try? String(contentsOfFile: helloPath, encoding: .utf8),
              FileManager.default.fileExists(atPath: root + "/handoff-cover.html"),
              let log = try? NativeProbeLog(output) else { exit(2) }
        let wanted = value("--event") ?? "screen locked"
        guard ["screen locked", "will sleep", "displays changed"].contains(wanted) else { exit(2) }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        Task { @MainActor in
            let resolver = RealPrivateResolver()
            let availability = PrivateCalls.check(resolver: resolver, defaults: nil)
            guard availability.liveCover else { log.event("not-measured", ["reason": "private cover capability unavailable"]); exit(2) }
            let sky = SkyLight(resolver: resolver, availability: availability)
            guard let run = try? NativeProbeRun(root: URL(fileURLWithPath: root), hello: hello, log: log, observerPath: output + ".observer", sky: sky) else { exit(2) }
            log.event("probe-start", ["mode": mode, "parentPID": getppid(), "hardLimit": NativeHandoffCover.hardLimit])
            let ok: Bool
            switch mode {
            case "watchdog": ok = await run.watchdog()
            case "cancel-reuse": ok = await run.cancelReuse()
            default: ok = await run.session(wanted)
            }
            if !ok { _ = await run.clean(.failed) }
            let observersEnded = await run.until(1, { run.observers.allSatisfy { !$0.isRunning } })
            let observersPassed = observersEnded && run.observers.allSatisfy { $0.terminationReason == .exit && $0.terminationStatus == 0 }
            for observer in run.observers where observer.isRunning { observer.terminate() }
            log.event("probe-result", ["ok": ok, "audit": run.cover.validationStatus,
                                       "observersPassed": observersPassed,
                                       "scope": "owned standalone Native cover; no browser/physical pixel/Shell recovery claim"])
            exit(ok && observersPassed ? 0 : 1)
        }
        app.run()
    }
}
