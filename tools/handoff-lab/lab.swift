// The handoff lab (docs/HANDOFF.md §10.3, §10.4): one mode per gate G1-G18, plus `holds`, the
// freeze-holds check the product can't do. Each gate is a run on screen whose result decides what
// the build turns on. README.md is the runbook; run nothing here without approval.
//
// - Built by build.sh with Margin.app's own files (PrivateCalls.swift, Freezer.swift,
//   SpaceReads.swift, BridgeParker.swift): every freeze is RealFreezer's, with its own watchdog,
//   every park, show and return is SpaceParker's, with a private Space per window, verified and
//   retried once, and the launch check is PrivateCalls.check. So a gate tests what ships. Only
//   G5's enumerator search declares a call the product doesn't make (lab only, marked).
// - Safety: nothing runs on screen without --go (without it, or with --dry-run, the lab prints
//   the plan and its read-only checks and touches no window). One gate after another; the first
//   failure stops the run. At the end, and on ⌃C, every window the lab parked comes back, a live
//   freeze is revealed, and the lab's own windows, children and STP windows are closed.
// - Browsers: the lab drives windows only in Safari Technology Preview, and only the windows it
//   opened itself through its temporary extension (ext/). It never touches release Safari's
//   windows: G1's Margin half and G16 go through Margin.app itself (WP12's dev hook, which
//   refuses any profile but Test A and Test B), and the lab only reads Margin's log.
// - Frames come from ScreenCaptureKit, with the terminal's Screen Recording grant: the lab tool
//   only, never Margin.app. Without the grant (checked, never asked for) a gate's frame counts
//   say "not measured".
// - Everything kept or written is ids, window numbers, Space ids, counts and milliseconds. Never
//   a page's address, title or words.
// - Each run appends to results/<build>-<date>.md, which docs/PRIVATE-APIS.md links.
//
//   handoff-lab list
//   handoff-lab <gate…> [--dry-run] [--go] [--person] [--runs N] [--stp] [--dock-restart]
//                       [--dev-hook] [--app PATH] [--results DIR]
//   gates: holds g1 … g18, or own (the gates on the lab's own windows), stp, all
//   (child modes, started by the lab itself: --park-probe, target, hold N, freeze-child)

import AppKit
import CoreMedia
import ScreenCaptureKit
import WebKit

// MARK: - Time, the lab's log, waits

nonisolated func epochMs() -> Double { Date().timeIntervalSince1970 * 1000 }
let labT0 = epochMs()
var labLog: [String] = []

func note(_ line: String) {
    let l = String(format: "%8.0f ms  ", epochMs() - labT0) + line
    labLog.append(l)
    print(l)
    fflush(stdout)
}

nonisolated struct Fail: Error, CustomStringConvertible {
    let why: String
    init(_ why: String) { self.why = why }
    var description: String { why }
}

func pause(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1e9)) }

// Polls `p` every `step` seconds until it holds or `seconds` pass; the last poll's answer.
func waitFor(_ seconds: Double, every step: Double = 0.004, _ p: () -> Bool) async -> Bool {
    let end = epochMs() + seconds * 1000
    while epochMs() < end {
        if p() { return true }
        await pause(step)
    }
    return p()
}

func ms(_ v: Double?) -> String { v.map { String(Int($0.rounded())) } ?? "-" }
func fills(_ r: CGRect?) -> Bool { r.map { !$0.isNull && ScreenGeometry.fillsDisplay($0) } ?? false }
func size(_ r: CGRect?) -> String { r.map { $0.isNull ? "none" : "\(Int($0.width))×\(Int($0.height)) at \(Int($0.minX)),\(Int($0.minY))" } ?? "none" }
func stats(_ xs: [Double]) -> String {
    guard !xs.isEmpty else { return "none" }
    let s = xs.sorted()
    func q(_ p: Double) -> Double { s[min(s.count - 1, Int((Double(s.count - 1) * p).rounded()))] }
    return "n \(s.count), min \(ms(s.first)), median \(ms(q(0.5))), p90 \(ms(q(0.9))), max \(ms(s.last))"
}

// MARK: - The private calls, as Margin.app makes them

final class Calls: FreezerDelegate {
    let availability: PrivateCalls.Availability
    let version: String
    let build: String
    let sky: SkyLight
    let spaces: SkyLightSpaces
    let parker: SpaceParker
    let freezer: RealFreezer
    let clock = RunLoopClock()
    private(set) var reports: [(at: Double, report: FreezeReport)] = []

    init() {
        let resolver = RealPrivateResolver()
        availability = PrivateCalls.check(resolver: resolver, defaults: nil)
        version = resolver.version
        build = resolver.build ?? "unknown-build"
        sky = SkyLight(resolver: resolver, availability: availability)
        spaces = SkyLightSpaces(sky: sky, availability: availability)
        parker = SpaceParker(reads: spaces, bridge: spaces, clock: clock)
        freezer = RealFreezer(skyLight: sky)
        freezer.delegate = self
    }

    var line: String { availability.line(version: version, build: build) }

    func freezer(_ freezer: Freezer, reported: FreezeReport) { reports.append((epochMs(), reported)) }

    // ---- the freeze ----

    @discardableResult func freeze(watchdog: Double = FreezerOptions().watchdog) throws -> Int32 {
        switch freezer.freeze(watchdog: watchdog) {
        case .frozen(let handle): return handle
        case .failed(let result): throw Fail("SLSNewTransition answered \(result)")
        case .unavailable(let why): throw Fail("no freeze: \(why)")
        }
    }

    // The reveal and how long the screen was held; `late`: the watchdog had already revealed.
    @discardableResult func reveal(_ why: RevealWhy = .ready) -> (late: Bool, heldMs: Int?, failed: Int32?) {
        let result = freezer.reveal(why)
        let held = lastHeld()
        switch result {
        case .revealed: return (false, held, nil)
        case .notLive: return (true, held, nil)
        case .failed(let r, _): return (false, held, r)
        }
    }

    func lastHeld() -> Int? {
        for (_, r) in reports.reversed() {
            if case .revealed(_, _, let held) = r { return held }
            if case .revealFailed(_, _, _, _, let held) = r { return held }
        }
        return nil
    }

    // Waits for the freezer's watchdog report (it reaches the main actor a moment after the reveal).
    func waitWatchdog(_ seconds: Double) async -> Int? {
        let since = reports.count
        var held: Int?
        _ = await waitFor(seconds, every: 0.005) {
            for (_, r) in reports.dropFirst(since) { if case .revealed(_, .watchdog, let h) = r { held = h; return true } }
            return false
        }
        return held
    }

    // ---- the parker (SpaceParker), awaited ----

    func park(_ n: Int) async -> ParkOutcome { await withCheckedContinuation { c in parker.park(n) { c.resume(returning: $0) } } }
    func show(_ n: Int) async -> ParkOutcome { await withCheckedContinuation { c in parker.show(n) { c.resume(returning: $0) } } }
    func returnToDesktop(_ n: Int) async -> ParkOutcome { await withCheckedContinuation { c in parker.returnToDesktop(n) { c.resume(returning: $0) } } }

    // ---- reads ----

    func active() -> UInt64 { spaces.activeSpace() ?? 0 }
    func spacesOf(_ n: Int) -> [UInt64] { spaces.spaces(of: n) ?? [] }
    func fullScreen() -> Set<UInt64> { spaces.fullScreenSpaces() ?? [] }
    func server(_ n: Int) -> ServerWindow? { spaces.window(n) }
    func parked(_ n: Int) -> Bool { spaces.readsParked(n) == true }
    func describe(_ n: Int) -> String {
        let w = server(n)
        return "spaces \(spacesOf(n)), on screen \(w.map { "\($0.onScreen)" } ?? "unlisted"), \(size(w?.bounds))"
    }
    func describe(_ o: ParkOutcome) -> String {
        o.ok ? "\(o.step.rawValue) \(o.ms) ms (\(o.tries) tr\(o.tries == 1 ? "y" : "ies"))" : "\(o.step.rawValue) \(ParkSelfTest.describe(o.failure)) after \(o.ms) ms"
    }

    // Everything the lab parked comes back, and a live freeze is revealed.
    func bringBack() async {
        if freezer.isLive { reveal(.quit) }
        for n in parker.privateSpaces.keys.sorted() {
            if server(n) != nil {
                let o = await returnToDesktop(n)
                note("cleanup: window \(n) \(describe(o))")
            }
            parker.destroySpace(of: n)
        }
    }
}

// MARK: - Frames (ScreenCaptureKit, the lab only)

nonisolated struct Tint: Sendable {
    let name: String
    let r: Int, g: Int, b: Int
    init(_ name: String, _ hex: Int) { self.name = name; r = (hex >> 16) & 0xFF; g = (hex >> 8) & 0xFF; b = hex & 0xFF }
    var nsColor: NSColor { NSColor(srgbRed: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1) }
    var hex: String { String(format: "%02x%02x%02x", r, g, b) }
}

nonisolated struct Frame: Sendable {
    let t: Double // epoch ms, when it arrived
    let state: String // a tint's name filling the middle of the screen, MIXED, or OTHER
    let sig: UInt64 // a hash of the watched part, to count changed frames
}

// Only complete frames count: ScreenCaptureKit repeats old buffers while the screen is still
// (S/handoff/RESULTS.md "Screen capture misleads").
nonisolated final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let tints: [Tint]
    let watch: CGRect? // the part whose changes count (0-1 of the display, top left); nil: all of it
    let wide: Bool // the live-cover gate checks the grid over 90% of the display
    private let lock = NSLock()
    private var kept: [Frame] = []
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "handoff-lab.recorder")

    init(tints: [Tint], watch: CGRect? = nil, wide: Bool = false) {
        self.tints = tints
        self.watch = watch
        self.wide = wide
    }

    // Checked, never asked for: asking would show a prompt.
    static var allowed: Bool { CGPreflightScreenCaptureAccess() }

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else { throw Fail("no display to record") }
        let cfg = SCStreamConfiguration()
        cfg.width = display.width / 2
        cfg.height = display.height / 2
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 120)
        cfg.queueDepth = 6
        cfg.showsCursor = false
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        let s = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await s.startCapture()
        stream = s
    }

    func stop() async {
        try? await stream?.stopCapture()
        stream = nil
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {}

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid else { return }
        let info = (CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first
        guard (info?[.status] as? Int) == SCFrameStatus.complete.rawValue, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        let t = epochMs()
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let raw = CVPixelBufferGetBaseAddress(pb) else { return }
        let base = raw.assumingMemoryBound(to: UInt8.self)
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb), stride = CVPixelBufferGetBytesPerRow(pb)
        func pixel(_ fx: Double, _ fy: Double) -> (Int, Int, Int) {
            let x = min(w - 1, max(0, Int(Double(w) * fx))), y = min(h - 1, max(0, Int(Double(h) * fy)))
            let p = base + y * stride + x * 4
            return (Int(p[2]), Int(p[1]), Int(p[0]))
        }
        // The middle of the screen: which tint fills it.
        var counts = [Int](repeating: 0, count: tints.count)
        var n = 0
        for row in 0..<24 {
            for col in 0..<40 {
                let (r, g, b) = pixel((wide ? 0.05 : 0.25) + Double(col) * (wide ? 0.9 : 0.5) / 40,
                                      (wide ? 0.05 : 0.25) + Double(row) * (wide ? 0.9 : 0.5) / 24)
                n += 1
                var best = -1, bestD = Int.max
                for (i, tint) in tints.enumerated() {
                    let d = (r - tint.r) * (r - tint.r) + (g - tint.g) * (g - tint.g) + (b - tint.b) * (b - tint.b)
                    if d < bestD { bestD = d; best = i }
                }
                if best >= 0, bestD < 70 * 70 { counts[best] += 1 }
            }
        }
        var state = "OTHER"
        if let i = counts.firstIndex(where: { Double($0) / Double(n) > (wide ? 0.999 : 0.9) }) {
            state = tints[i].name
        } else if counts.filter({ Double($0) / Double(n) > 0.02 }).count >= 2 {
            state = "MIXED"
        }
        // The watched part's hash (FNV-1a over coarse colours).
        let area = watch ?? CGRect(x: 0, y: 0, width: 1, height: 1)
        var sig: UInt64 = 0xcbf29ce484222325
        for row in 0..<16 {
            for col in 0..<24 {
                let (r, g, b) = pixel(area.minX + Double(col) * area.width / 24, area.minY + Double(row) * area.height / 16)
                for v in [r >> 3, g >> 3, b >> 3] { sig = (sig ^ UInt64(v)) &* 0x100000001b3 }
            }
        }
        lock.lock()
        kept.append(Frame(t: t, state: state, sig: sig))
        lock.unlock()
    }

    func frames(_ from: Double = 0, _ to: Double = .infinity) -> [Frame] {
        lock.lock()
        defer { lock.unlock() }
        return kept.filter { $0.t >= from && $0.t <= to }
    }

    // Frames in [from, to] whose watched part differs from the last frame before `from`.
    func changed(_ from: Double, _ to: Double) -> (changed: Int, frames: Int) {
        lock.lock()
        defer { lock.unlock() }
        guard let before = kept.last(where: { $0.t < from }) else { return (0, 0) }
        let inside = kept.filter { $0.t >= from && $0.t <= to }
        return (inside.filter { $0.sig != before.sig }.count, inside.count)
    }

    func summary(_ from: Double, _ to: Double) -> String {
        var c: [String: Int] = [:]
        for f in frames(from, to) { c[f.state, default: 0] += 1 }
        return c.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", ")
    }

    func bad(_ from: Double, _ to: Double, allowed: Set<String>) -> Int { frames(from, to).filter { !allowed.contains($0.state) }.count }
}

// The tints the gates tell apart (S/handoff/park.swift's, and the STP pages' backgrounds).
let tintA = Tint("A", 0x173D9E), tintB = Tint("B", 0x9E1A33), tintC = Tint("C", 0x1A8C3C)
let stpTintA = Tint("A", 0x1E3A8A), stpTintB = Tint("B", 0x9F1239)

// MARK: - The lab's own windows

final class PaintView: NSView {
    var color: NSColor
    var tick = 0
    var flips = false // `holds`: the whole view changes colour every frame
    init(_ color: NSColor) { self.color = color; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError("not used") }
    override var isOpaque: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        if flips {
            NSColor(hue: CGFloat(tick % 12) / 12, saturation: 0.7, brightness: 0.8, alpha: 1).setFill()
            bounds.fill()
            return
        }
        color.setFill()
        bounds.fill()
        NSColor.white.setFill()
        NSRect(x: 20 + CGFloat(tick % 60) * 3, y: bounds.height - 60, width: 30, height: 30).fill()
    }
}

final class OwnWindow: NSObject, NSWindowDelegate {
    let window: NSWindow
    let name: String
    let view: PaintView
    private var timer: Timer?
    var entered: Double?, exited: Double?

    init(_ tint: Tint, frame: NSRect, animate: Bool = false, flips: Bool = false) {
        name = tint.name
        window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        view = PaintView(tint.nsColor)
        super.init()
        window.title = "Lab " + tint.name
        window.isReleasedWhenClosed = false
        window.backgroundColor = tint.nsColor
        window.collectionBehavior = [.fullScreenPrimary]
        // Safari's windows don't use AppKit window tabs (S/handoff/RESULTS-park.md: a trap).
        window.tabbingMode = .disallowed
        window.delegate = self
        view.flips = flips
        window.contentView = view
        if animate || flips {
            timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.nudge() }
            }
        }
    }

    var number: Int { window.windowNumber }
    var isFull: Bool { window.styleMask.contains(.fullScreen) }

    func nudge() { view.tick += 1; view.needsDisplay = true }
    // Changed frames for a while (S/handoff/RESULTS.md step 4: clears the entry's leftover image).
    func nudge(frames: Int) async { for _ in 0..<frames { nudge(); window.display(); await pause(0.008) } }

    func windowDidEnterFullScreen(_ notification: Notification) { entered = epochMs() }
    func windowDidExitFullScreen(_ notification: Notification) { exited = epochMs() }

    func close() {
        timer?.invalidate()
        timer = nil
        window.delegate = nil
        window.close()
    }
}

// A panel as Margin's overlay is made in its own Space (Overlay.swift ownSpaceBehavior), with a
// web view when a gate measures its rAF (G2's R4 question).
final class LabPanel: NSObject, WKScriptMessageHandler {
    let panel: NSPanel
    private(set) var web: WKWebView?
    private(set) var rafs: [Double] = []

    init(frame: NSRect, color: NSColor, web withWeb: Bool) {
        panel = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.collectionBehavior = [.managed, .fullScreenAuxiliary, .ignoresCycle]
        panel.level = .normal
        panel.backgroundColor = color
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        if withWeb {
            let cfg = WKWebViewConfiguration()
            cfg.userContentController.add(self, name: "lab")
            let w = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: cfg)
            w.loadHTMLString("<body style='margin:0;background:#334155'><script>(function f(){webkit.messageHandlers.lab.postMessage(Date.now());requestAnimationFrame(f)})()</script>", baseURL: nil)
            panel.contentView = w
            web = w
        }
    }

    var number: Int { panel.windowNumber }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if let t = message.body as? Double { rafs.append(t) } else if let t = message.body as? Int { rafs.append(Double(t)) }
        if rafs.count > 2000 { rafs.removeFirst(1000) }
    }

    func firstFrame(after t: Double) -> Double? { rafs.first { $0 > t } }

    func close() {
        web?.configuration.userContentController.removeScriptMessageHandler(forName: "lab")
        panel.orderOut(nil)
        panel.close()
    }
}

// MARK: - Children (this binary in another process: a window that isn't the lab's own)

nonisolated final class LineBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    private var lines: [String] = []
    func add(_ chunk: Data) {
        lock.lock()
        defer { lock.unlock() }
        data.append(chunk)
        while let end = data.firstIndex(of: 0x0A) {
            lines.append(String(decoding: data[data.startIndex..<end], as: UTF8.self))
            data = Data(data[data.index(after: end)...])
        }
    }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return lines }
}

let labExecutable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()

final class Child {
    let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    let buffer = LineBuffer()

    init(_ arguments: [String], executable: URL = labExecutable) throws {
        process.executableURL = executable
        process.arguments = arguments
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        let buffer = self.buffer
        output.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil } else { buffer.add(chunk) }
        }
        try process.run()
    }

    var pid: pid_t { process.processIdentifier }

    func line(_ prefix: String, within seconds: Double) async -> String? {
        var found: String?
        _ = await waitFor(seconds, every: 0.01) {
            found = buffer.all.first { $0.hasPrefix(prefix) }
            return found != nil
        }
        return found
    }

    // The number after `prefix` in the child's first such line.
    func number(_ prefix: String, within seconds: Double) async -> Int? {
        guard let l = await line(prefix, within: seconds) else { return nil }
        return Int(l.dropFirst(prefix.count).split(separator: " ").first ?? "")
    }

    func send(_ line: String) { try? input.fileHandleForWriting.write(contentsOf: Data((line + "\n").utf8)) }

    // Its stdin closed: it ends by itself; still running a second later, it's ended.
    func end() {
        try? input.fileHandleForWriting.close()
        let p = process
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { if p.isRunning { p.terminate() } }
    }

    func killNow() {
        guard process.isRunning else { return }
        kill(process.processIdentifier, SIGKILL)
        process.waitUntilExit()
    }
}

enum ChildModes {
    static var targetWindow: NSWindow?

    // `target`: one ordinary titled window (as Safari's are), far off screen at alpha 0, in an
    // accessory app that never activates. It prints its number and takes `out`, `front` and
    // `quit` on stdin; it ends at stdin's end, or after two minutes whatever happens.
    static func runTarget() -> Never {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let w = NSWindow(contentRect: NSRect(x: -3000, y: -3000, width: 800, height: 500), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        w.alphaValue = 0
        w.isReleasedWhenClosed = false
        w.tabbingMode = .disallowed
        w.isExcludedFromWindowsMenu = true
        w.collectionBehavior = [.managed, .ignoresCycle]
        w.orderFrontRegardless()
        w.setFrameOrigin(NSPoint(x: -3000, y: -3000))
        targetWindow = w
        print("target window \(w.windowNumber)")
        fflush(stdout)
        readCommands { line in
            switch line {
            case "out": targetWindow?.orderOut(nil)
            case "front": targetWindow?.orderFrontRegardless()
            case "quit": exit(0)
            default: break
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 120) { exit(0) }
        app.run()
        exit(0)
    }

    // `hold N`: parks window N in a private Space of its own (SpaceParker), says so, and waits:
    // the parker that dies (G13). At stdin's end it returns the window first.
    static var holdCalls: Calls?
    static func runHold(_ number: Int) -> Never {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let calls = Calls()
        holdCalls = calls
        calls.parker.park(number) { o in
            print("held \(o.ok ? 1 : 0) \(o.space ?? 0)")
            fflush(stdout)
        }
        readCommands { _ in }
        app.run()
        exit(0)
    }

    // `freeze-child`: freezes (RealFreezer, a 4 s watchdog: macOS's own release comes first) and
    // waits to be killed (G13). At stdin's end it reveals and ends.
    static func runFreezeChild() -> Never {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let calls = Calls()
        holdCalls = calls
        let result = (try? calls.freeze(watchdog: 4)).map { _ in "0" } ?? "failed"
        print("frozen \(result)")
        fflush(stdout)
        readCommands { _ in }
        app.run()
        exit(0)
    }

    // stdin's lines on the main actor; its end ends the child (the hold returns its window first).
    static func readCommands(_ handle: @escaping @MainActor (String) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine() {
                let text = line.trimmingCharacters(in: .whitespaces)
                DispatchQueue.main.async { MainActor.assumeIsolated { handle(text) } }
            }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let calls = holdCalls else { exit(0) }
                    if calls.freezer.isLive { calls.reveal(.quit) }
                    let keys = Array(calls.parker.privateSpaces.keys)
                    guard let n = keys.first else { exit(0) }
                    calls.parker.returnToDesktop(n) { _ in exit(0) }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { exit(0) }
                }
            }
        }
    }
}

// MARK: - Safari Technology Preview, through the lab's extension and server

struct StpWin {
    let ext: Int // the extension's window id
    let number: Int // the window server's
    let name: String
    let page: String // the page's ?id=
    let tab: Int?
}

final class Stp {
    static let bundle = "com.apple.SafariTechnologyPreview"
    let port: Int
    let labDir: URL
    private var server: Process?
    // The lab's own calls to its server carry this, made per run: no other page can (server.py).
    private let token = UUID().uuidString + UUID().uuidString
    private(set) var created: [StpWin] = []
    private var commands = 0
    var base: String { "http://127.0.0.1:\(port)" }

    init(port: Int, labDir: URL) {
        self.port = port
        self.labDir = labDir
    }

    static var app: NSRunningApplication? { NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first }

    func start() async throws {
        guard Stp.app != nil else { throw Fail("Safari Technology Preview isn't running: start it, add the lab's temporary extension (README), then run again") }
        let state = labDir.appendingPathComponent("build/server-state.json").path
        try? FileManager.default.createDirectory(at: labDir.appendingPathComponent("build"), withIntermediateDirectories: true)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        p.arguments = ["-I", labDir.appendingPathComponent("server.py").path, labDir.appendingPathComponent("www").path, state, String(port)]
        p.environment = (ProcessInfo.processInfo.environment).merging(["LAB_TOKEN": token]) { $1 }
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
        server = p
        var up = false
        for _ in 0..<50 where !up {
            up = await http("GET", "/state").0 == 200
            if !up { await pause(0.1) }
        }
        guard up else { throw Fail("the lab's server didn't start on port \(port) (is another lab running?)") }
        note("stp: server on port \(port); waiting for the lab's extension (open \(base)/s.html in STP for the steps)")
        var waited = 0.0
        while await reports()["ext"] == nil {
            await pause(0.5)
            waited += 0.5
            if waited >= 180 { throw Fail("the lab's extension didn't report in 3 minutes: is it added as a temporary extension in STP?") }
        }
        note("stp: the extension is there")
    }

    func stop() {
        server?.terminate()
        server = nil
    }

    // ---- the server ----

    func http(_ method: String, _ path: String, _ body: Any? = nil) async -> (Int, Any?) {
        guard let url = URL(string: base + path) else { return (0, nil) }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.cachePolicy = .reloadIgnoringLocalCacheData
        r.timeoutInterval = 3
        r.setValue(token, forHTTPHeaderField: "X-Lab-Token")
        if let body { r.httpBody = try? JSONSerialization.data(withJSONObject: body) }
        guard let (data, resp) = try? await URLSession.shared.data(for: r) else { return (0, nil) }
        return ((resp as? HTTPURLResponse)?.statusCode ?? 0, try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]))
    }

    func reports() async -> [String: [String: Any]] { (await http("GET", "/state").1 as? [String: [String: Any]]) ?? [:] }
    func report(_ id: String) async -> [String: Any]? { await reports()[id] }

    // A command for a page (`for` its id) or the extension (`ext`); the extension's answer.
    @discardableResult func send(_ cmd: [String: Any], to who: String = "ext") async -> String {
        commands += 1
        let id = "c\(commands)"
        var c = cmd
        c["cid"] = id
        c["for"] = who
        _ = await http("POST", "/enqueue", c)
        return id
    }

    func ext(_ cmd: [String: Any], within seconds: Double = 5) async -> Any? {
        let id = await send(cmd)
        let end = epochMs() + seconds * 1000
        while epochMs() < end {
            let (code, j) = await http("GET", "/result?id=\(id)")
            if code == 200, let d = j as? [String: Any] { return d["res"] }
            await pause(0.005)
        }
        return nil
    }

    static func error(_ r: Any?) -> String? { (r as? [String: Any])?["error"] as? String }

    func update(_ w: StpWin, _ props: [String: Any]) async -> Any? { await ext(["op": "update", "id": w.ext, "props": props]) }
    func state(_ w: StpWin) async -> String? { (await ext(["op": "get", "id": w.ext]) as? [String: Any])?["state"] as? String }

    // ---- STP's windows, by number: layer 0 and a real size (its 500×500 helper left out) ----

    func numbers() -> [Int: CGRect] {
        guard let pid = Stp.app?.processIdentifier,
              let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return [:] }
        var out: [Int: CGRect] = [:]
        for w in list where (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
            guard let n = (w[kCGWindowNumber as String] as? NSNumber)?.intValue, let raw = w[kCGWindowBounds as String] as? NSDictionary,
                  let b = CGRect(dictionaryRepresentation: raw as CFDictionary), b.width > 300, b.height > 200, !(b.width == 500 && b.height == 500) else { continue }
            out[n] = b
        }
        return out
    }

    // Every window of STP's on screen, any layer (G8's dialogs and sheets).
    func everyOnScreen() -> [(number: Int, layer: Int, bounds: CGRect)] {
        guard let pid = Stp.app?.processIdentifier,
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return [] }
        return list.compactMap { w in
            guard (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid, let n = (w[kCGWindowNumber as String] as? NSNumber)?.intValue,
                  let raw = w[kCGWindowBounds as String] as? NSDictionary, let b = CGRect(dictionaryRepresentation: raw as CFDictionary) else { return nil }
            return (n, (w[kCGWindowLayer as String] as? Int) ?? 0, b)
        }
    }

    // A new window of the lab's own, normal, with one of its pages.
    func open(_ name: String, page: String, query: String, at frame: CGRect) async throws -> StpWin {
        let before = Set(numbers().keys)
        let url = base + "/" + page + "?" + query
        guard let r = await ext(["op": "create", "props": ["url": url, "focused": false, "state": "normal", "left": Int(frame.minX), "top": Int(frame.minY), "width": Int(frame.width), "height": Int(frame.height)]]) as? [String: Any],
              let id = r["id"] as? Int else { throw Fail("STP didn't make window \(name)") }
        var number: Int?
        _ = await waitFor(5, every: 0.02) {
            number = Set(numbers().keys).subtracting(before).first
            return number != nil
        }
        guard let number else { throw Fail("window \(name)'s number didn't show up") }
        let pageId = query.split(separator: "&").first { $0.hasPrefix("id=") }.map { String($0.dropFirst(3)) } ?? name.lowercased()
        let w = StpWin(ext: id, number: number, name: name, page: pageId, tab: r["tabId"] as? Int)
        created.append(w)
        return w
    }

    // The lab's own windows only: out of full screen, then closed (a parked one is brought back
    // by Calls.bringBack first).
    func closeAll() async {
        for w in created {
            if await state(w) == "fullscreen" { _ = await update(w, ["state": "normal"]); await pause(1.2) }
        }
        for w in created { _ = await ext(["op": "remove", "id": w.ext]) }
        created = []
    }
}

// MARK: - Margin.app (G1's second half, G16): its signature, its log, its dev hook

enum Margin {
    static let bundle = "com.unibox.margin"
    static var running: NSRunningApplication? { NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first }
    static var devHooksOn: Bool { UserDefaults(suiteName: bundle)?.bool(forKey: "MarginDevHooks") ?? false }

    static func run(_ tool: String, _ args: [String]) -> (status: Int32, out: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        guard (try? p.run()) != nil else { return (-1, "") }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(decoding: data, as: UTF8.self))
    }

    // Developer ID, the hardened runtime, and no library-validation exemption.
    static func signature(_ app: String) -> [String] {
        var out: [String] = []
        let (status, text) = run("/usr/bin/codesign", ["-dv", "--verbose=4", app])
        guard status == 0 else { return ["signature: not readable (codesign \(status))"] }
        let devID = text.contains("Authority=Developer ID Application")
        let hardened = text.range(of: #"flags=0x[0-9a-f]+\([^)]*runtime"#, options: .regularExpression) != nil
        let ents = run("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", app]).out
        let noLV = ents.contains("disable-library-validation")
        out.append("signature: Developer ID \(devID ? "yes" : "NO"), hardened runtime \(hardened ? "yes" : "NO"), library-validation exemption \(noLV ? "YES (not wanted)" : "none")")
        return out
    }

    // Margin's own lines from its log: only "private calls" and "handoff:" lines, which hold ids,
    // numbers and milliseconds only (HANDOFF.md §8.1).
    static func logLines(last: String) -> [String] {
        let (_, text) = run("/usr/bin/log", ["show", "--style", "compact", "--last", last, "--predicate", "subsystem == \"com.unibox.margin\" AND process == \"Margin\""])
        return text.split(separator: "\n").compactMap { l in
            guard let r = l.range(of: "private calls") ?? l.range(of: "handoff:") else { return nil }
            return String(l[r.lowerBound...])
        }
    }

    // The same, live, from now on.
    static func stream() throws -> (Process, LineBuffer) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/log")
        p.arguments = ["stream", "--style", "compact", "--predicate", "subsystem == \"com.unibox.margin\" AND process == \"Margin\""]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        let buffer = LineBuffer()
        pipe.fileHandleForReading.readabilityHandler = { h in
            let chunk = h.availableData
            if chunk.isEmpty { h.readabilityHandler = nil } else { buffer.add(chunk) }
        }
        try p.run()
        return (p, buffer)
    }

    // WP12's dev hook (HANDOFF.md §9): a switch from the front window, as a key press would.
    // Margin refuses any profile not named exactly "Test A" or "Test B".
    static func devSwitch(to profile: String) {
        // DEV-HOOK: goes with the hook before production (tools/handoff-lab/devswitch.swift is its sender for people).
        DistributedNotificationCenter.default().postNotificationName(NSNotification.Name("com.unibox.margin.dev.switch"), object: nil,
                                                                      userInfo: ["to": profile, "pid": String(ProcessInfo.processInfo.processIdentifier)], deliverImmediately: true)
    }

    static func dev(_ kind: String, _ fields: [String: String] = [:]) {
        var fields = fields
        fields["pid"] = String(ProcessInfo.processInfo.processIdentifier)
        DistributedNotificationCenter.default().postNotificationName(NSNotification.Name("com.unibox.margin.dev." + kind), object: nil,
                                                                      userInfo: fields, deliverImmediately: true)
    }
}

// MARK: - The lab: options, what it opened, cleanup

struct LabOptions {
    var gates: [String] = []
    var dryRun = false
    var go = false
    var person = false
    var runs: Int?
    var stp = false
    var dockRestart = false
    var devHook = false
    var liveReturnToA = false // finish only an already-approved remaining B → A switch
    var compareLive = false // COMPARE: require the real themed cover, not a freeze fallback
    var compareReverse = false // COMPARE: start from Test B, request Test A then Test B
    var validationAfterFailedWarmup: String? // VALIDATE: proof of one consumed failed first freeze warmup
    var validationAfterFreezeWatchdog: String? // separate live-only observation, no matched acceptance
    var appPath = "/Applications/Margin.app"
    var port = 47944
    var labDir = labExecutable.deletingLastPathComponent().deletingLastPathComponent()
    var resultsDir: URL?
}

final class Lab {
    let o: LabOptions
    private var madeCalls: Calls?
    private var madeStp: Stp?
    private var windows: [OwnWindow] = []
    private var panels: [LabPanel] = []
    private var children: [Child] = []
    private var recorders: [Recorder] = []
    var liveCover: LabLiveCover?
    var restoreCoverMode = false
    var restoreValidationMode = false
    let previousApp = NSWorkspace.shared.frontmostApplication

    init(_ o: LabOptions) { self.o = o }

    var calls: Calls {
        if let madeCalls { return madeCalls }
        let c = Calls()
        madeCalls = c
        return c
    }

    func stp() async throws -> Stp {
        if let madeStp { return madeStp }
        let s = Stp(port: o.port, labDir: o.labDir)
        try await s.start()
        madeStp = s
        return s
    }

    func runs(_ fallback: Int) -> Int { max(1, o.runs ?? fallback) }

    // ---- own windows, panels, children, recorders: all closed by cleanup ----

    func window(_ tint: Tint, _ frame: NSRect, animate: Bool = false, flips: Bool = false) -> OwnWindow {
        let w = OwnWindow(tint, frame: frame, animate: animate, flips: flips)
        windows.append(w)
        return w
    }

    func panel(_ frame: NSRect, color: NSColor, web: Bool = false) -> LabPanel {
        let p = LabPanel(frame: frame, color: color, web: web)
        panels.append(p)
        return p
    }

    func child(_ args: [String]) throws -> Child {
        let c = try Child(args)
        children.append(c)
        return c
    }

    // A child's hidden window (the stand-in for another process's window): its number.
    func target() async throws -> (Child, Int) {
        let c = try child(["target"])
        guard let n = await c.number("target window ", within: 5) else { throw Fail("the target child gave no window number") }
        guard await waitFor(0.5, { !calls.spacesOf(n).isEmpty }) else { throw Fail("the target's window \(n) was in no Space") }
        return (c, n)
    }

    // Frames, or nil without Screen Recording (never asked for).
    func recorder(_ tints: [Tint], watch: CGRect? = nil, wide: Bool = false) async -> Recorder? {
        guard Recorder.allowed else { return nil }
        let r = Recorder(tints: tints, watch: watch, wide: wide)
        do { try await r.start() } catch { note("frames: the recorder didn't start (\(error))"); return nil }
        recorders.append(r)
        await pause(0.3)
        return r
    }

    // The lab as a regular app in front, for gates that take its own windows into full screen.
    func comeForward() async {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
        await pause(0.3)
    }

    // After each gate, and at the end (`final`: the server stops too; between gates it stays, so
    // the extension keeps its place in the queue).
    func cleanup(final: Bool) async {
        if restoreValidationMode { Margin.dev("mode", ["freeze": "on", "cover": "on", "old": "park"]); restoreValidationMode = false }
        if let liveCover, !liveCover.close() { note("live cover cleanup: Space destruction did not verify") }
        liveCover = nil
        if restoreCoverMode { Margin.dev("mode", ["freeze": "on"]); restoreCoverMode = false }
        if let madeCalls { await madeCalls.bringBack() }
        if let madeStp {
            await madeStp.closeAll()
            if final { madeStp.stop(); self.madeStp = nil }
        }
        for w in windows where w.isFull {
            w.window.toggleFullScreen(nil)
            _ = await waitFor(3) { !w.isFull }
            await pause(0.5)
        }
        for w in windows { w.close() }
        windows = []
        for p in panels { p.close() }
        panels = []
        for c in children { c.end() }
        children = []
        for r in recorders { await r.stop() }
        recorders = []
        NSApp.setActivationPolicy(.accessory)
        previousApp?.activate()
    }
}

// MARK: - Gates

enum Needs: String {
    case own = "the lab's own windows on screen (full screen, Space slides)"
    case small = "a small lab window on screen (bottom left, no full screen)"
    case child = "a hidden window of a child process (off screen, alpha 0)"
    case stp = "Safari Technology Preview with the lab's temporary extension (ext/)"
    case margin = "Margin.app, a Developer-ID hardened build, with Safari's Test A and Test B"
    case devHook = "WP12's dev hook in Margin.app (defaults write com.unibox.margin MarginDevHooks -bool YES)"
    case person = "a person at the Mac for the guided steps (--person)"
    case frames = "Screen Recording for the terminal (frame counts; not asked for)"
    case displays = "a second display (a Sidecar iPad is enough)"
}

enum Status: String { case pass, fail, partial, recorded, notRun = "not run" }

struct Outcome {
    var status: Status
    var lines: [String] = []
}

struct Gate {
    let id: String
    let title: String
    let decides: String
    let needs: [Needs]
    let freezes: String
    let plan: [String]
    let run: @MainActor (Lab) async throws -> Outcome
}

// The middle of the main display, top left, for the lab's own windows.
func displayFrame() -> NSRect { NSScreen.screens.first?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900) }
func centered(_ w: CGFloat, _ h: CGFloat, dx: CGFloat = 0) -> NSRect {
    let d = displayFrame()
    return NSRect(x: d.midX - w / 2 + dx, y: d.midY - h / 2 - dx / 2, width: w, height: h)
}

// MARK: holds (and G1's lab half): the freeze holds the screen, and a watchdog reveal off the main thread

func freezeHolds(_ lab: Lab, lines: inout [String]) async throws -> Status {
    let c = lab.calls
    guard c.availability.freeze else { lines.append("the freeze calls are off: \(c.availability.reasons["freeze"] ?? "?")"); return .fail }
    let d = displayFrame()
    let frame = NSRect(x: d.minX + 40, y: d.minY + 40, width: 260, height: 180)
    let w = lab.window(tintA, frame, flips: true)
    w.window.orderFrontRegardless()
    await pause(0.4)
    // The watched part: the window, from the display's top left (0-1).
    let watch = CGRect(x: (frame.minX - d.minX + 20) / d.width, y: (d.maxY - frame.maxY + 40) / d.height, width: (frame.width - 40) / d.width, height: (frame.height - 60) / d.height)
    guard let rec = await lab.recorder([tintA], watch: watch) else {
        lines.append("frames not measured: no Screen Recording for the terminal; the freeze calls ran but whether they hold is unknown")
        _ = try c.freeze(watchdog: 0.5)
        _ = await c.waitWatchdog(1.2)
        lines.append("freeze and watchdog reveal (off the main thread) answered 0; held \(ms(c.lastHeld().map(Double.init))) ms")
        w.close()
        return .partial
    }
    var status = Status.pass
    // 1. A reveal on the main thread.
    await pause(0.3)
    let t0 = epochMs()
    try c.freeze()
    await pause(0.6)
    let t1 = epochMs()
    let r = c.reveal(.ready)
    await pause(0.3)
    let before = rec.changed(t0 - 300, t0 - 20)
    let during = rec.changed(t0 + 20, t1 - 5)
    let after = rec.changed(t1 + 30, t1 + 300)
    lines.append("main-thread reveal: changed/complete frames before \(before.changed)/\(before.frames), frozen \(during.changed)/\(during.frames), after \(after.changed)/\(after.frames); held \(r.heldMs.map(String.init) ?? "-") ms, reveal \(r.failed.map { "answered \($0)" } ?? "0")")
    if before.changed == 0 || after.changed == 0 { lines.append("the recorder saw no changes outside the freeze: it can't judge"); status = .partial }
    if during.changed > 0 { lines.append("FAIL: the screen changed under the freeze"); status = .fail }
    // 2. The watchdog's reveal, from the freezer's own queue (HANDOFF.md §4.3 Built (WP2): untried on screen).
    await pause(0.4)
    let t2 = epochMs()
    try c.freeze(watchdog: 0.5)
    let held = await c.waitWatchdog(1.5)
    await pause(0.3)
    let frozen = rec.changed(t2 + 20, t2 + 480)
    let freed = rec.changed(t2 + 560, t2 + 800)
    lines.append("watchdog reveal off the main thread at \(held.map(String.init) ?? "?") ms: changed/complete frames frozen \(frozen.changed)/\(frozen.frames), after \(freed.changed)/\(freed.frames)")
    if held == nil { lines.append("FAIL: no watchdog report"); status = .fail }
    if frozen.changed > 0 { lines.append("FAIL: the screen changed under the second freeze"); status = .fail }
    if freed.changed == 0 && status == .pass { lines.append("nothing changed after the watchdog's reveal: was it revealed?"); status = .fail }
    w.close()
    return status
}

let holdsGate = Gate(
    id: "holds", title: "The freeze holds the screen (each macOS beta)",
    decides: "whether the freeze still holds: the check the product can't make (HANDOFF.md §4.3)",
    needs: [.small, .frames], freezes: "0.6 s, then 0.5 s",
    plan: ["a small lab window at the bottom left changes colour every frame",
           "freeze 0.6 s (RealFreezer), reveal on the main thread: no changed frame while frozen, changes before and after",
           "freeze again with a 0.5 s watchdog: the watchdog reveals from the freezer's queue; no change while frozen, changes after"],
    run: { lab in
        var lines: [String] = []
        let s = try await freezeHolds(lab, lines: &lines)
        return Outcome(status: s, lines: lines)
    })

// MARK: G1: the mechanism from a hardened Developer-ID build, without Screen Recording or Accessibility

let g1 = Gate(
    id: "G1", title: "The freeze and a cross-process park from a hardened Developer-ID Margin.app, Screen Recording and Accessibility denied",
    decides: "the whole mechanism; fails: freeze and park off",
    needs: [.small, .child, .margin, .devHook, .frames], freezes: "0.6 s and 0.5 s (the lab), one switch (Margin, with --dev-hook)",
    plan: ["the lab (hardened, ad hoc): the launch check (PrivateCalls.check) and its line",
           "the lab: the real cross-process self-test (ParkSelfTest, this binary as `--park-probe`): park, show, park again, return",
           "the lab: `holds` (the freeze holds; a watchdog reveal off the main thread)",
           "Margin.app (--app, default /Applications/Margin.app): Developer ID, hardened runtime, no library-validation exemption",
           "Margin.app's log (last 2 h): its launch line with freeze, spaces and park ok, and its self-test line passing",
           "with --dev-hook: a switch to Test B through the dev hook; its summary line's freeze answered 0",
           "by hand (README): Margin.app has neither Screen Recording nor Accessibility in System Settings"],
    run: { lab in
        var lines: [String] = []
        var status = Status.pass
        let c = lab.calls
        lines.append("lab launch check: " + c.line)
        if !(c.availability.freeze && c.availability.park) { status = .fail }
        // The self-test, as Margin.app runs it.
        let probe = ProcessProbeChild(executable: labExecutable)
        let test = ParkSelfTest(parker: c.parker, reads: c.spaces, child: probe, clock: c.clock)
        let outcome: ParkSelfTest.Outcome = await withCheckedContinuation { k in test.run { k.resume(returning: $0) } }
        lines.append("lab self-test: " + ParkSelfTest.line(outcome, pid: test.childPid))
        if !outcome.passed { status = .fail }
        var holds: [String] = []
        let h = try await freezeHolds(lab, lines: &holds)
        lines += holds.map { "holds: " + $0 }
        if h == .fail { status = .fail } else if h == .partial, status == .pass { status = .partial }
        // Margin.app.
        let app = lab.o.appPath
        guard FileManager.default.fileExists(atPath: app) else {
            lines.append("Margin.app not found at \(app): its half not run")
            return Outcome(status: status == .fail ? .fail : .partial, lines: lines)
        }
        let sig = Margin.signature(app)
        lines += sig
        if sig.contains(where: { $0.contains("NO") || $0.contains("YES (not wanted)") || $0.contains("not readable") }) { status = .fail }
        let log = Margin.logLines(last: "2h")
        let launch = log.last { $0.hasPrefix("private calls on macOS") }
        let selfTest = log.last { $0.contains("cross-process self-test") }
        lines.append("Margin's launch line: \(launch ?? "none in the last 2 h (start Margin.app first)")")
        lines.append("Margin's self-test line: \(selfTest ?? "none")")
        if let launch, !(launch.contains("freeze ok") && launch.contains("park ok")) { status = .fail }
        if let selfTest, selfTest.contains("failed") { status = .fail }
        if launch == nil || selfTest == nil, status == .pass { status = .partial }
        if lab.o.devHook {
            guard Margin.running != nil, Margin.devHooksOn else {
                lines.append("dev hook: Margin isn't running or MarginDevHooks isn't YES")
                return Outcome(status: status == .fail ? .fail : .partial, lines: lines)
            }
            let (p, buf) = try Margin.stream()
            await pause(0.5)
            Margin.devSwitch(to: "Test B")
            var line: String?
            _ = await waitFor(8, every: 0.1) {
                line = buf.all.compactMap { l in l.range(of: "handoff:").map { String(l[$0.lowerBound...]) } }.first { $0.contains("frozen") || $0.contains("→") }
                return line != nil
            }
            p.terminate()
            lines.append("Margin's switch: \(line ?? "no summary line in 8 s")")
            if let line, !line.contains("result 0") { status = .fail }
            if line == nil, status == .pass { status = .partial }
        } else {
            lines.append("Margin's own freeze: not run (needs WP12's dev hook: --dev-hook)")
            if status == .pass { status = .partial }
        }
        lines.append("by hand: Margin.app must have neither Screen Recording nor Accessibility (System Settings → Device Control and Data Access)")
        return Outcome(status: status, lines: lines)
    })

// MARK: The handoff itself (HANDOFF.md §1.3), in STP or on the lab's own windows

struct LabHandoffRun {
    var t: [String: Double] = [:] // ms from the freeze
    var late = false
    var failure: String?
    var notes: [String] = []
    var seen: [String] = [] // G15: the active Spaces, in order
    var held: Int?
    var frozenAt = 0.0, endedAt = 0.0

    func line(_ label: String) -> String {
        let order = ["shown", "duplicate", "newFullScreenSpace", "R1", "R2", "overlayShown", "A asked", "A normal", "A parked", "settled", "A closed", "revealed"]
        let parts = order.compactMap { k in t[k].map { "\(k) \(ms($0))" } }
        return "\(label): " + parts.joined(separator: ", ") + "; held \(held.map(String.init) ?? "-") ms" + (late ? " (late: the watchdog revealed)" : "")
            + (failure.map { "; FAILED: \($0)" } ?? "") + (notes.isEmpty ? "" : "; " + notes.joined(separator: "; "))
    }
}

struct HandoffPlan {
    var watchdog = FreezerOptions().watchdog
    var probe = false // G2: R3's probe sent at R1
    var overlay: LabPanel? // G2: R4's web view shown at R2
    var duplicateAt: Double? // G4: a second full-screen request, seconds after the first
    var trace = false // G15: every active Space seen
    var keepA = false // G3 two-freeze form: reveal at R2, A untouched
    var closeA = false // G3 one-freeze form: A closed inside the freeze
    var revealAt: RevealPoint = .ready // G17
    enum RevealPoint { case ready, midExit, settle }
}

// What a window is to the handoff: how to ask it to full screen or normal, how to close it.
struct Side {
    let number: Int
    let name: String
    let full: () async -> Void
    let normal: () async -> Void
    let close: () async -> Void
    let isFullNow: () -> Bool? // AppKit's own word, for the lab's windows; nil in STP
}

// One handoff x → y (y parked), as §1.3 orders it: freeze, show y, y full screen once, R1+R2,
// x to normal (latest start 1.15 s), x parked once normal and out of its Space, the settle, reveal.
func handoff(_ lab: Lab, _ x: Side, _ y: Side, _ plan: HandoffPlan) async -> LabHandoffRun {
    let c = lab.calls
    var run = LabHandoffRun()
    let xSpace = c.active()
    let fsBefore = c.fullScreen()
    let t0 = epochMs()
    run.frozenAt = t0
    func at(_ k: String) { run.t[k] = epochMs() - t0 }
    func spaceWord(_ s: UInt64) -> String {
        if s == xSpace { return "\(s) (A's)" }
        if c.fullScreen().contains(s) { return c.spacesOf(y.number).contains(s) ? "\(s) (B's, full screen)" : "\(s) (another full-screen Space)" }
        return "\(s) (not full screen)"
    }
    do { try c.freeze(watchdog: plan.watchdog) } catch { run.failure = "\(error)"; return run }
    let shown = await c.show(y.number)
    at("shown")
    guard shown.ok else {
        run.failure = "\(y.name)'s show: \(c.describe(shown))"
        let r = c.reveal(.failed)
        run.held = r.heldMs
        return run
    }
    let requested = epochMs()
    Task { await y.full() }
    var r1 = false, last = CGRect.null, steady = 0, duplicated = false
    let ready = await waitFor(1.5, every: 0.008) {
        if let d = plan.duplicateAt, !duplicated, epochMs() - requested >= d * 1000 {
            duplicated = true
            at("duplicate")
            Task { await y.full() }
        }
        let a = c.active()
        if plan.trace, run.seen.last != spaceWord(a) { run.seen.append(spaceWord(a)) }
        if run.t["newFullScreenSpace"] == nil, !c.fullScreen().subtracting(fsBefore).isEmpty { at("newFullScreenSpace") }
        guard a != xSpace, c.spacesOf(y.number).contains(a), c.fullScreen().contains(a) else { steady = 0; return false }
        if !r1 {
            r1 = true
            at("R1")
            if plan.probe { lab.onR1?() }
        }
        let b = c.server(y.number)?.bounds ?? .null
        if fills(b) && b == last { steady += 1 } else { steady = 0 }
        last = b
        return steady >= 3
    }
    guard ready else {
        run.failure = "\(y.name) not full screen in time: \(c.describe(y.number))"
        let r = c.reveal(.failed)
        run.held = r.heldMs
        run.late = r.late
        return run
    }
    at("R2")
    if let p = plan.overlay, let b = c.server(y.number)?.bounds {
        let f = ScreenGeometry.appKitRect(b)
        p.panel.setFrame(NSRect(x: f.minX + 24, y: f.maxY - 84, width: 240, height: 60), display: false)
        p.panel.order(.above, relativeTo: y.number)
        at("overlayShown")
    }
    if plan.keepA {
        if let own = lab.ownOf(y.number) { await own.nudge(frames: 10) }
        let r = c.reveal(.ready)
        at("revealed")
        (run.held, run.late) = (r.heldMs, r.late)
        run.endedAt = epochMs()
        return run
    }
    if plan.closeA {
        Task { await x.close() }
        at("A asked")
        let gone = await waitFor(1.0, every: 0.008) { c.server(x.number) == nil }
        at("A closed")
        var since = 0.0
        let settled = await waitFor(0.5, every: 0.008) {
            guard c.active() != xSpace, c.spacesOf(y.number).contains(c.active()) else { since = 0; return false }
            if since == 0 { since = epochMs() }
            return epochMs() - since >= 120
        }
        if !gone { run.notes.append("\(x.name) not gone") }
        if !settled { run.notes.append("the active Space wasn't \(y.name)'s for 120 ms (\(spaceWord(c.active())))") }
        let r = c.reveal(.ready)
        at("revealed")
        (run.held, run.late) = (r.heldMs, r.late)
        run.endedAt = epochMs()
        return run
    }
    // x to normal: from R1+R2, latest start 1.15 s after the freeze (HANDOFF.md §1.4).
    var revealed = false
    if epochMs() - t0 > 1150 {
        run.notes.append("\(x.name) not started under this freeze (\(y.name) steady after 1.15 s)")
        let r = c.reveal(.ready)
        at("revealed")
        (run.held, run.late, revealed) = (r.heldMs, r.late, true)
    }
    Task { await x.normal() }
    at("A asked")
    if plan.revealAt == .midExit, !revealed {
        await pause(0.02)
        let r = c.reveal(.watchdog)
        at("revealed")
        (run.held, run.late, revealed) = (r.heldMs, r.late, true)
    }
    let left = await waitFor(1.5, every: 0.008) { !fills(c.server(x.number)?.bounds) && !c.spacesOf(x.number).contains(xSpace) && (x.isFullNow() ?? false) == false }
    at("A normal")
    guard left else {
        run.failure = "\(x.name) didn't leave full screen: \(c.describe(x.number))"
        if !revealed { let r = c.reveal(.failed); (run.held, run.late) = (r.heldMs, r.late) }
        return run
    }
    let exitedAt = epochMs()
    let parked = await c.park(x.number)
    at("A parked")
    guard parked.ok else {
        run.failure = "\(x.name)'s park: \(c.describe(parked))"
        if !revealed { let r = c.reveal(.failed); (run.held, run.late) = (r.heldMs, r.late) }
        return run
    }
    if plan.revealAt == .settle, !revealed {
        await pause(0.03)
        let r = c.reveal(.watchdog)
        at("revealed")
        (run.held, run.late, revealed) = (r.heldMs, r.late, true)
    }
    _ = await waitFor(0.4, every: 0.008) { epochMs() - exitedAt >= 130 && c.server(x.number)?.onScreen != true }
    at("settled")
    if !revealed {
        if let own = lab.ownOf(y.number) { await own.nudge(frames: 10) }
        let r = c.reveal(.ready)
        at("revealed")
        (run.held, run.late) = (r.heldMs, r.late)
        if let own = lab.ownOf(y.number) { await own.nudge(frames: 2) }
    }
    // G6 in passing: does the liveness read list the parked window?
    if let w = c.server(x.number) { run.notes.append("parked \(x.name) listed by .optionIncludingWindow (on screen \(w.onScreen), \(size(w.bounds)))") } else { run.notes.append("parked \(x.name) not listed by .optionIncludingWindow") }
    run.endedAt = epochMs()
    return run
}

extension Lab {
    // G2's R1 hook: set by the gate for the run in progress.
    static var r1Hook: (() -> Void)?
    var onR1: (() -> Void)? { Lab.r1Hook }
    // The lab's own window with this number, to nudge it before a reveal (as park.swift did).
    func ownOf(_ number: Int) -> OwnWindow? { ownList.first { $0.number == number } }
}

// The lab's own windows a handoff drives in the current gate.
var ownList: [OwnWindow] = []

func side(_ w: OwnWindow) -> Side {
    Side(number: w.number, name: w.name,
         // A window shown while its app is full screen may go full screen by itself: asked only if
         // it hasn't within 350 ms (S/handoff/park.swift), so a request never toggles it back out.
         full: {
             w.window.makeKeyAndOrderFront(nil)
             if !(await waitFor(0.35) { w.isFull }) { w.window.toggleFullScreen(nil) }
         },
         normal: { if w.isFull { w.window.toggleFullScreen(nil) } },
         close: { w.window.close() },
         isFullNow: { w.isFull })
}

func side(_ w: StpWin, _ stp: Stp) -> Side {
    Side(number: w.number, name: w.name,
         full: { _ = await stp.update(w, ["state": "fullscreen", "focused": true]) },
         normal: { _ = await stp.update(w, ["state": "normal"]) },
         close: { _ = await stp.ext(["op": "remove", "id": w.ext]) },
         isFullNow: { nil })
}

// ---- set-ups: one window full screen, the others parked ----

// The lab's own: A full screen, the rest parked (each in its own private Space).
func ownSet(_ lab: Lab, _ tints: [Tint]) async throws -> [OwnWindow] {
    await lab.comeForward()
    let c = lab.calls
    var ws: [OwnWindow] = []
    for (i, t) in tints.enumerated() {
        let w = lab.window(t, centered(800, 520, dx: CGFloat(i) * 40))
        ws.append(w)
        ownList.append(w)
    }
    for w in ws.dropFirst() {
        w.window.orderFront(nil)
        await pause(0.2)
        let o = await c.park(w.number)
        guard o.ok else { throw Fail("couldn't park \(w.name): \(c.describe(o))") }
    }
    let a = ws[0]
    a.window.makeKeyAndOrderFront(nil)
    NSApp.activate()
    await pause(0.3)
    a.window.toggleFullScreen(nil)
    guard await waitFor(5, { a.isFull && c.spacesOf(a.number).contains(c.active()) && fills(c.server(a.number)?.bounds) }) else { throw Fail("\(a.name) didn't enter full screen") }
    await pause(0.8)
    return ws
}

// STP's: A (the page given) full screen, B parked.
func stpPair(_ lab: Lab, a: (page: String, query: String), b: (page: String, query: String)) async throws -> (Stp, StpWin, StpWin) {
    let stp = try await lab.stp()
    let c = lab.calls
    let A = try await stp.open("A", page: a.page, query: a.query, at: CGRect(x: 200, y: 80, width: 1100, height: 720))
    let B = try await stp.open("B", page: b.page, query: b.query, at: CGRect(x: 260, y: 120, width: 1000, height: 680))
    await pause(0.8)
    let o = await c.park(B.number)
    guard o.ok else { throw Fail("couldn't park STP's B: \(c.describe(o))") }
    Stp.app?.activate()
    await pause(0.5)
    if let e = Stp.error(await stp.update(A, ["state": "fullscreen", "focused": true])) { throw Fail("A to full screen: \(e)") }
    guard await waitFor(5, { fills(c.server(A.number)?.bounds) && c.fullScreen().contains(c.active()) && c.spacesOf(A.number).contains(c.active()) }) else { throw Fail("STP's A didn't enter full screen") }
    await pause(1.0)
    return (stp, A, B)
}

func stillQuery(_ id: String, _ tint: Tint) -> String { "id=\(id)&bg=\(tint.hex)" }

// MARK: G2: R3's signal with still pages, and R4's overlay rAF

let g2 = Gate(
    id: "G2", title: "STP handoffs with still pages: rAF and visibilitychange against R1/R2, the overlay web view's rAF, frames after the reveal",
    decides: "R3's signal (rAF, visibilitychange, or off) and R4",
    needs: [.stp, .frames], freezes: "about 1.1-1.4 s per handoff, 4 handoffs (--runs)",
    plan: ["STP: windows A and B with still pages (www/still.html), B parked, A full screen",
           "each handoff: both pages' probes armed (every rAF and visibilitychange kept, ext/probe.js)",
           "R3's probe (frames 6, nudge 80 ms) sent to the target's page at R1",
           "a lab panel with a web view (Margin's overlay's kind of window) shown over the target at R2: its first rAF after",
           "after the reveal: 400 ms of frames, the target's colour or not (a leftover image)",
           "per run: the target's first rAF after R1, its visibilitychange to visible, the probe's answer, the panel's first rAF, all against the reveal",
           "the suggestion: R3 = rAF if it ran before the reveal every time, else visibilitychange if that did, else off"],
    run: { lab in
        let (stp, A, B) = try await stpPair(lab, a: ("still.html", stillQuery("a", stpTintA)), b: ("still.html", stillQuery("b", stpTintB)))
        let rec = await lab.recorder([stpTintA, stpTintB])
        let overlay = lab.panel(NSRect(x: 0, y: 0, width: 240, height: 60), color: .darkGray, web: true)
        var lines: [String] = []
        var rafBefore = 0, visBefore = 0, n = 0, leftovers = 0
        var x = A, y = B
        for i in 1...lab.runs(4) {
            await stp.send(["op": "arm"], to: "probe-" + y.page)
            await pause(0.4)
            let target = y
            Lab.r1Hook = { Task { await stp.send(["op": "probe", "frames": 6, "nudgeMs": 80, "timeoutMs": 400, "n": i], to: "probe-" + target.page) } }
            var plan = HandoffPlan()
            plan.probe = true
            plan.overlay = overlay
            let r = await handoff(lab, side(x, stp), side(y, stp), plan)
            Lab.r1Hook = nil
            await pause(0.5)
            overlay.panel.orderOut(nil)
            await stp.send(["op": "dump", "n": i], to: "probe-" + y.page)
            await pause(0.5)
            let t0 = r.frozenAt
            @MainActor func rel(_ v: Any?) -> String { ms((v as? Double).map { $0 - t0 }) }
            let rev = r.t["revealed"].map { t0 + $0 }
            // When rAF resumed and the page turned visible (ext/probe.js `dump`).
            let dump = await stp.report("dump-" + y.page)
            let fresh = (dump?["dump"] as? Int) == i
            let rafs = fresh ? ((dump?["raf"] as? [Double]) ?? []) : []
            let firstRaf = rafs.first { $0 >= t0 }
            let vis = fresh ? ((dump?["vis"] as? [[Any]]) ?? []).first { ($0.last as? String) == "visible" && (($0.first as? Double) ?? 0) >= t0 }?.first as? Double : nil
            // R3's probe: its answer, sent at R1.
            let answer = await stp.report("probe-" + y.page)
            let probeWords: String
            if let a = answer, (a["probe"] as? Int) == i {
                probeWords = a["none"] != nil ? "none (\(a["none"] ?? "?"))" : "frames \(a["frames"] ?? "?") from \(rel(a["firstAt"])) to \(rel(a["lastAt"])), width \(a["width"] ?? "?"), focus \(a["hasFocus"] ?? "?"), visible \(a["visible"] ?? "?")"
            } else {
                probeWords = "no answer"
            }
            let leftover = rec.map { $0.bad((rev ?? t0) + 10, (rev ?? t0) + 400, allowed: [y.name]) }
            let overlayRaf = overlay.firstFrame(after: t0 + (r.t["overlayShown"] ?? 0))
            if let f = firstRaf, let rev, f < rev { rafBefore += 1 }
            if let v = vis, let rev, v < rev { visBefore += 1 }
            if let l = leftover, l > 0 { leftovers += 1 }
            n += 1
            lines.append(r.line("\(x.name)→\(y.name) run \(i)"))
            lines.append("  \(y.name)'s page: first rAF \(rel(firstRaf)), visible at \(rel(vis)), reveal \(rel(rev)); probe \(probeWords); panel's first rAF \(rel(overlayRaf)); frames after the reveal not \(y.name)'s: \(leftover.map(String.init) ?? "not measured")")
            if let f = r.failure { lines.append("stopped: \(f)"); return Outcome(status: .fail, lines: lines) }
            swap(&x, &y)
            await pause(1.0)
        }
        let suggestion = rafBefore == n ? "R3 = rAF (it ran before the reveal in \(n) of \(n))"
            : visBefore == n ? "R3 = visibilitychange (rAF before the reveal in \(rafBefore) of \(n), visible in \(visBefore) of \(n))"
            : "R3 off (rAF before the reveal in \(rafBefore) of \(n), visibilitychange in \(visBefore) of \(n)): write the risk in TESTING.md"
        lines.append("suggestion: " + suggestion + "; runs with a leftover after the reveal: \(rec == nil ? "not measured" : String(leftovers))")
        return Outcome(status: .recorded, lines: lines)
    })

// MARK: G3: the close handoff, two freezes against one

let g3 = Gate(
    id: "G3", title: "The close handoff in STP: two freezes (§4.5) against one",
    decides: "close mode's form and timings",
    needs: [.stp, .frames], freezes: "about 1.1 s + 0.15 s per two-freeze run, about 1.3 s per one-freeze run; 4 runs (--runs)",
    plan: ["STP: A full screen, B parked",
           "two-freeze runs: freeze 1 to B ready and reveal with A untouched; 300 ms; freeze 2 (1.0 s watchdog): A closed by its copy, A gone, B's Space active 120 ms, one focus if macOS dropped to the Desktop; reveal",
           "one-freeze runs: A closed inside the first freeze after B is ready",
           "frames: any that are neither A's nor B's, from the first freeze to 300 ms after the last reveal",
           "between runs: the shown window normal, a new parked window made, the shown window full screen again"],
    run: { lab in
        let (stp, A0, B0) = try await stpPair(lab, a: ("still.html", stillQuery("a", stpTintA)), b: ("still.html", stillQuery("b", stpTintB)))
        let c = lab.calls
        let rec = await lab.recorder([stpTintA, stpTintB])
        var lines: [String] = []
        var x = A0, y = B0
        for i in 1...lab.runs(4) {
            let two = i % 2 == 1
            let start = epochMs()
            if two {
                var plan = HandoffPlan()
                plan.keepA = true
                let r1 = await handoff(lab, side(x, stp), side(y, stp), plan)
                if let f = r1.failure { lines.append(r1.line("run \(i) freeze 1")); lines.append("stopped: \(f)"); return Outcome(status: .fail, lines: lines) }
                await pause(0.3)
                let t2 = epochMs()
                try c.freeze(watchdog: FreezerOptions().closeWatchdog)
                _ = await stp.ext(["op": "remove", "id": x.ext])
                let gone = await waitFor(0.8, every: 0.008) { c.server(x.number) == nil }
                var since = 0.0, dropped = false
                let shown = y
                let settled = await waitFor(0.6, every: 0.008) {
                    let a = c.active()
                    if !c.spacesOf(shown.number).contains(a) {
                        since = 0
                        if !dropped, !c.fullScreen().contains(a) { dropped = true; Task { _ = await stp.update(shown, ["focused": true]) } }
                        return false
                    }
                    if since == 0 { since = epochMs() }
                    return epochMs() - since >= 120
                }
                let r2 = c.reveal(.ready)
                let bad = rec.map { $0.bad(start, epochMs() + 300, allowed: [x.name, y.name]) }
                lines.append("run \(i) (two freezes): freeze 1 held \(r1.held.map(String.init) ?? "-") ms\(r1.late ? " (late)" : ""); freeze 2 held \(r2.heldMs.map(String.init) ?? "-") ms\(r2.late ? " (late)" : ""), A gone \(gone) in \(ms(epochMs() - t2)) ms, settled \(settled), Desktop drop \(dropped); frames neither A nor B: \(bad.map(String.init) ?? "not measured")")
            } else {
                var plan = HandoffPlan()
                plan.closeA = true
                let r = await handoff(lab, side(x, stp), side(y, stp), plan)
                await pause(0.3)
                let bad = rec.map { $0.bad(start, epochMs() + 300, allowed: [x.name, y.name]) }
                lines.append(r.line("run \(i) (one freeze)") + "; frames neither A nor B: \(bad.map(String.init) ?? "not measured")")
                if let f = r.failure { lines.append("stopped: \(f)"); return Outcome(status: .fail, lines: lines) }
            }
            // The next pair: y normal, a new window parked, y full screen again.
            guard i < lab.runs(4) else { break }
            _ = await stp.update(y, ["state": "normal"])
            _ = await waitFor(2) { !fills(c.server(y.number)?.bounds) }
            await pause(0.8)
            let nextName = x.name
            let next = try await stp.open(nextName, page: "still.html", query: stillQuery(nextName.lowercased() + "\(i)", nextName == "A" ? stpTintA : stpTintB), at: CGRect(x: 240, y: 100, width: 1000, height: 680))
            await pause(0.8)
            let o = await c.park(next.number)
            guard o.ok else { lines.append("couldn't park the next window: \(c.describe(o))"); return Outcome(status: .fail, lines: lines) }
            _ = await stp.update(y, ["state": "fullscreen", "focused": true])
            guard await waitFor(5, { fills(c.server(y.number)?.bounds) && c.fullScreen().contains(c.active()) }) else { lines.append("\(y.name) didn't go back to full screen"); return Outcome(status: .fail, lines: lines) }
            await pause(1.0)
            x = y
            y = next
        }
        return Outcome(status: .recorded, lines: lines)
    })

// MARK: G4: a duplicate full-screen request mid-entry, and when a new type-4 Space appears

let g4 = Gate(
    id: "G4", title: "A duplicate full-screen update mid-entry in STP, and when a new full-screen Space first appears",
    decides: "Options.fullScreenRetry and its evidence (§3.4)",
    needs: [.stp], freezes: "about 1.1-1.7 s per run, 3 runs (duplicate at 100, 250, 400 ms; --runs repeats them)",
    plan: ["STP: A full screen, B parked",
           "each run: the handoff A→B with a second {state: 'fullscreen'} sent 100, 250 or 400 ms after the first",
           "per poll (8 ms): when a new full-screen Space first appears, R1, R2",
           "400 ms after the request: the copy's windows.get state, and whether B's bounds and Spaces were unchanged since the show (the retry rule's evidence)",
           "after: whether B ended full screen or toggled back out; a B left normal is parked again",
           "between runs a plain handoff back"],
    run: { lab in
        let (stp, A, B) = try await stpPair(lab, a: ("still.html", stillQuery("a", stpTintA)), b: ("still.html", stillQuery("b", stpTintB)))
        let c = lab.calls
        var lines: [String] = []
        let offsets = [0.1, 0.25, 0.4]
        let x = A, y = B
        for i in 0..<(offsets.count * lab.runs(1)) {
            let d = offsets[i % offsets.count]
            var plan = HandoffPlan()
            plan.duplicateAt = d
            let shownBounds = c.server(y.number)?.bounds
            let stateAt400 = Task { () -> String? in
                await pause(0.4 + 0.015)
                return await stp.state(y)
            }
            let r = await handoff(lab, side(x, stp), side(y, stp), plan)
            let at400 = await stateAt400.value
            await pause(1.2)
            let end = await stp.state(y)
            lines.append(r.line("duplicate at \(Int(d * 1000)) ms") + "; copy's state at 400 ms \(at400 ?? "?"), at the end \(end ?? "?"); bounds at the show \(size(shownBounds))")
            if r.failure != nil {
                // B toggled out or never entered: A is still full screen. B back to its parked place.
                if end == "fullscreen" { _ = await stp.update(y, ["state": "normal"]); await pause(1.5) }
                let o = await c.park(y.number)
                lines.append("  recovered: \(y.name) parked again: \(c.describe(o))")
                guard o.ok else { return Outcome(status: .fail, lines: lines) }
                continue
            }
            await pause(0.8)
            let back = await handoff(lab, side(y, stp), side(x, stp), HandoffPlan())
            lines.append(back.line("  back"))
            if let f = back.failure { lines.append("stopped: \(f)"); return Outcome(status: .fail, lines: lines) }
            await pause(0.8)
        }
        return Outcome(status: .recorded, lines: lines)
    })

// MARK: G5: per-window private Spaces, an empty one destroyed, the enumerator search, the Dock

// Lab only, not in the product: SkyLight's window list for given Spaces, with the signature the
// window managers that use it declare (yabai). §4.1 row 13's candidate.
typealias CopyWindowsWithOptionsAndTags = @convention(c) (UInt32, UInt32, CFArray, UInt32, UnsafeMutablePointer<UInt64>, UnsafeMutablePointer<UInt64>) -> Unmanaged<CFArray>?
typealias MainConnection = @convention(c) () -> UInt32

let g5 = Gate(
    id: "G5", title: "Per-window private Spaces: create and destroy cost, an empty one destroyed, a read that lists a private Space's windows, the Dock restarting",
    decides: "per-window Spaces, the enumerator (§4.1 row 13), §6.8",
    needs: [.child], freezes: "none",
    plan: ["20 empty private Spaces made and destroyed (SLSSpaceCreate, SLSSpaceDestroy): each one's ms; the displays' Spaces and the active Space unchanged after",
           "three child windows, each parked in its own private Space by SpaceParker, shown, parked again and returned; no private Space left",
           "one child window parked: SLSCopySpacesForWindows with masks 1-0xFFFF, and SLSCopyWindowsWithOptionsAndTags for its Space (lab only): which ones list it",
           "with --dock-restart: the Dock restarted (killall Dock) with a window parked: still parked after? its Space still takes a show?"],
    run: { lab in
        let c = lab.calls
        var lines: [String] = []
        var status = Status.pass
        guard c.availability.park else { return Outcome(status: .fail, lines: ["parking is off: \(c.availability.reasons["park"] ?? "?")"]) }
        // 1. Empty Spaces.
        let displaysBefore = c.spaces.displays()
        let activeBefore = c.active()
        var creates: [Double] = [], destroys: [Double] = []
        for _ in 0..<20 {
            var t = epochMs()
            guard let s = c.sky.createSpace() else { lines.append("SLSSpaceCreate answered 0"); status = .fail; break }
            creates.append(epochMs() - t)
            t = epochMs()
            _ = c.sky.destroySpace(s)
            destroys.append(epochMs() - t)
        }
        await pause(0.3)
        let undisturbed = c.spaces.displays() == displaysBefore && c.active() == activeBefore
        lines.append("empty private Spaces: create \(stats(creates)); destroy \(stats(destroys)); displays and active Space unchanged \(undisturbed)")
        if !undisturbed { status = .fail }
        // 2. A Space per window.
        var targets: [Int] = []
        for _ in 0..<3 { targets.append(try await lab.target().1) }
        var times: [String] = []
        for n in targets {
            for step in ["park", "show", "park", "return"] {
                let o: ParkOutcome
                switch step {
                case "park": o = await c.park(n)
                case "show": o = await c.show(n)
                default: o = await c.returnToDesktop(n)
                }
                times.append("\(n) \(c.describe(o))")
                if !o.ok { status = .fail }
            }
        }
        lines.append("three windows, each its own Space: " + times.joined(separator: "; "))
        lines.append("private Spaces left with the parker: \(c.parker.privateSpaces.count)")
        if !c.parker.privateSpaces.isEmpty { status = .fail }
        // 3. The enumerator search.
        let n = targets[0]
        let parked = await c.park(n)
        guard parked.ok, let space = parked.space else { lines.append("couldn't park for the search: \(c.describe(parked))"); return Outcome(status: .fail, lines: lines) }
        var found: [String] = []
        for mask: Int32 in [1, 2, 4, 7, 8, 0xF, 0x10, 0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0xFFFF] {
            if let list = c.sky.spaces(forWindows: [UInt32(n)], mask: mask), list.contains(space) { found.append("SLSCopySpacesForWindows mask \(String(mask, radix: 16))") }
        }
        if let sky = dlopen(PrivateFramework.skyLight.path, RTLD_LAZY), let sym = dlsym(sky, PrivateCalls.enumeratorCandidate), let cidSym = dlsym(sky, "SLSMainConnectionID") {
            let copy = unsafeBitCast(sym, to: CopyWindowsWithOptionsAndTags.self)
            let cid = unsafeBitCast(cidSym, to: MainConnection.self)()
            for options: UInt32 in [0, 2, 7] {
                var set: UInt64 = 0, clear: UInt64 = 0
                if let list = copy(cid, 0, [NSNumber(value: space)] as CFArray, options, &set, &clear)?.takeRetainedValue() as? [NSNumber], list.contains(where: { $0.intValue == n }) {
                    found.append("\(PrivateCalls.enumeratorCandidate) options \(options)")
                }
            }
        } else {
            lines.append("\(PrivateCalls.enumeratorCandidate) not found")
        }
        lines.append("a read listing the private Space's window: \(found.isEmpty ? "none found" : found.joined(separator: ", "))")
        // 4. The Dock.
        if lab.o.dockRestart {
            let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first?.processIdentifier
            _ = Margin.run("/usr/bin/killall", ["Dock"])
            _ = await waitFor(8, every: 0.2) { NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first.map { $0.processIdentifier != dock } ?? false }
            await pause(3)
            lines.append("after the Dock restarted: window \(n) \(c.describe(n)), parked \(c.parked(n))")
            let shown = await c.show(n)
            lines.append("its show from the old private Space: \(c.describe(shown))")
            if !shown.ok { status = .fail }
        } else {
            let o = await c.returnToDesktop(n)
            lines.append("the Dock restart: not run (--dock-restart); window returned: \(c.describe(o))")
        }
        return Outcome(status: status, lines: lines)
    })

// MARK: G6: the liveness read on a parked window

let g6 = Gate(
    id: "G6", title: "Whether .optionAll and .optionIncludingWindow list a parked window, and with what bounds",
    decides: "the liveness read (§2.1) and the binder's inputs",
    needs: [.child], freezes: "none",
    plan: ["a child's window (titled, 800×500, off screen at alpha 0) read normal, then parked by SpaceParker",
           "every 250 ms for 3 s: .optionIncludingWindow (listed, bounds, on screen), .optionAll (listed), .optionOnScreenOnly (listed)",
           "then shown and returned; every read compared with the one before the park"],
    run: { lab in
        let c = lab.calls
        let (_, n) = try await lab.target()
        @MainActor func reads() -> String {
            let one = c.server(n)
            let all = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []).contains { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == n }
            let on = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []).contains { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == n }
            return "including-window \(one.map { "listed, on screen \($0.onScreen), \(size($0.bounds))" } ?? "not listed"); all \(all ? "listed" : "not listed"); on-screen-only \(on ? "listed" : "not listed")"
        }
        var lines = ["normal: " + reads()]
        let before = c.server(n)?.bounds
        let o = await c.park(n)
        guard o.ok else { return Outcome(status: .fail, lines: lines + ["park: \(c.describe(o))"]) }
        var listedAll = true, sameBounds = true, seen: [String] = []
        for _ in 0..<12 {
            await pause(0.25)
            let r = reads()
            if seen.last != r { seen.append(r) }
            if c.server(n) == nil { listedAll = false }
            if c.server(n)?.bounds != before { sameBounds = false }
        }
        lines += seen.map { "parked: " + $0 }
        let shown = await c.show(n)
        lines.append("shown: " + c.describe(shown) + "; " + reads())
        let back = await c.returnToDesktop(n)
        lines.append("returned: " + c.describe(back))
        lines.append("answer: the liveness read \(listedAll ? "lists" : "does NOT list") a parked window\(listedAll ? (sameBounds ? ", with its bounds unchanged" : ", with other bounds") : "")")
        return Outcome(status: shown.ok && back.ok ? .recorded : .fail, lines: lines)
    })

// MARK: G7: a second freeze soon after a watchdog reveal; rapid switches

let g7 = Gate(
    id: "G7", title: "A second freeze 0.15, 0.3, 0.6 and 1 s after a watchdog reveal; rapid A→B→A",
    decides: "the cooldown (§1.5)",
    needs: [.small, .frames], freezes: "4 × (1.7 s + 0.4 s); with --stp, 3 rapid pairs of handoffs",
    plan: ["a small lab window changes colour every frame",
           "for each gap: freeze until the watchdog reveals (1.7 s), wait the gap, freeze again: its answer, and whether it holds for 400 ms",
           "with --stp: STP's A and B, handoffs back and forth with only the 300 ms since the last reveal between them"],
    run: { lab in
        let c = lab.calls
        var lines: [String] = []
        var status = Status.recorded
        let d = displayFrame()
        let frame = NSRect(x: d.minX + 40, y: d.minY + 40, width: 260, height: 180)
        let w = lab.window(tintA, frame, flips: true)
        w.window.orderFrontRegardless()
        await pause(0.4)
        let watch = CGRect(x: (frame.minX - d.minX + 20) / d.width, y: (d.maxY - frame.maxY + 40) / d.height, width: (frame.width - 40) / d.width, height: (frame.height - 60) / d.height)
        let rec = await lab.recorder([tintA], watch: watch)
        for gap in [0.15, 0.3, 0.6, 1.0] {
            try c.freeze()
            let held = await c.waitWatchdog(2.5)
            await pause(gap)
            let t = epochMs()
            let second: String
            do { try c.freeze(); second = "0" } catch { second = "\(error)" }
            await pause(0.4)
            let r = c.reveal(.ready)
            await pause(0.2)
            let ch = rec?.changed(t + 20, t + 390)
            lines.append("gap \(Int(gap * 1000)) ms: watchdog at \(held.map(String.init) ?? "?") ms; second freeze \(second), held \(r.heldMs.map(String.init) ?? "-") ms, changed frames while held \(ch.map { "\($0.changed)/\($0.frames)" } ?? "not measured")")
            if let ch, ch.changed > 0 { lines.append("  the second freeze didn't hold") }
            await pause(0.6)
        }
        w.close()
        if lab.o.stp {
            let (stp, A, B) = try await stpPair(lab, a: ("still.html", stillQuery("a", stpTintA)), b: ("still.html", stillQuery("b", stpTintB)))
            var x = A, y = B
            for i in 1...(lab.runs(3) * 2) {
                let r = await handoff(lab, side(x, stp), side(y, stp), HandoffPlan())
                lines.append(r.line("rapid \(i) \(x.name)→\(y.name)"))
                if r.failure != nil { status = .fail; break }
                swap(&x, &y)
                await pause(0.3)
            }
        }
        return Outcome(status: status, lines: lines)
    })

// MARK: G8: Safari's prompts in A at switch time

let g8 = Gate(
    id: "G8", title: "alert(), confirm(), a permission prompt, \"leave page?\" and a detached Web Inspector in A at switch time",
    decides: "§1.10's blocker rule",
    needs: [.stp, .person], freezes: "none",
    plan: ["STP: A (www/dialog.html) full screen, B parked",
           "each prompt opened in A in turn: alert, confirm, geolocation, notifications, \"leave page?\" (A's tab sent elsewhere), a Web Inspector the person opens detached",
           "1.2 s later: every STP window on screen besides A, any layer, its size and whether it sits inside A's bounds: what §1.10's rule (a layer-0 window of Safari's inside A, not A's toolbar) would see",
           "the person dismisses each prompt, then presses Enter"],
    run: { lab in
        guard lab.o.person else { return Outcome(status: .notRun, lines: ["needs a person at the Mac to dismiss each prompt (--person)"]) }
        let (stp, A, _) = try await stpPair(lab, a: ("dialog.html", "id=d"), b: ("still.html", stillQuery("b", stpTintB)))
        let c = lab.calls
        var lines: [String] = []
        let known = Set(stp.created.map(\.number))
        for kind in ["alert", "confirm", "geo", "notify", "leave", "inspector"] {
            if kind == "inspector" {
                guard await Person.ask("In STP: Develop → Show Web Inspector, then detach it into its own window. Press Enter when it's open.") else { break }
            } else if kind == "leave" {
                await stp.send(["op": "leave"], to: "d")
                guard await Person.ask("Click once inside the DIALOG TEST page (so \"leave page?\" may show), then press Enter.") else { break }
                if let tab = A.tab { _ = await stp.ext(["op": "call", "api": "tabs", "fn": "update", "args": [tab, ["url": stp.base + "/n.html"]]]) }
            } else {
                await stp.send(["op": kind], to: "d")
            }
            await pause(1.2)
            let aBounds = c.server(A.number)?.bounds ?? .null
            let others = stp.everyOnScreen().filter { $0.number != A.number && !known.subtracting([A.number]).contains($0.number) }
            let described = others.map { w in "\(w.number) layer \(w.layer) \(Int(w.bounds.width))×\(Int(w.bounds.height)) \(aBounds.contains(w.bounds) ? "inside A" : "not inside A")" }
            let rule = others.contains { $0.layer == 0 && aBounds.contains($0.bounds) && $0.bounds != aBounds }
            lines.append("\(kind): STP windows on screen besides A: \(described.isEmpty ? "none" : described.joined(separator: "; ")); the rule sees a blocker: \(rule)")
            guard await Person.ask("Dismiss the \(kind == "inspector" ? "Web Inspector (close it)" : "prompt") in STP if one showed, then press Enter.") else { break }
            if kind == "leave" { await stp.send(["op": "stay"], to: "d") }
        }
        return Outcome(status: .recorded, lines: lines)
    })

// MARK: G9: the person's ways back to a parked window

let g9 = Gate(
    id: "G9", title: "⌘`, the Window menu, the Dock's window list, ⌘H then unhide, Bring All to Front, a Dock click with every window parked",
    decides: "§2.6 (focus is the person's signal) and §6.2",
    needs: [.stp, .person], freezes: "none",
    plan: ["STP: A full screen, B parked (its page's title is \"Still\"; the lab names it in each step)",
           "the person does one thing at a time: ⌘`; the Window menu's B; the Dock icon's window list; ⌘H then the Dock icon; Window → Bring All to Front",
           "after each: B's Spaces and on-screen state, A's, the extension's focus events (window ids, times), any new STP window; B parked again if it came back",
           "then A parked too (every window parked) and the person clicks STP's Dock icon: what shows, a new window or a parked one"],
    run: { lab in
        guard lab.o.person else { return Outcome(status: .notRun, lines: ["needs a person at the Mac (--person)"]) }
        let (stp, A, B) = try await stpPair(lab, a: ("still.html", stillQuery("a", stpTintA)), b: ("still.html", stillQuery("b", stpTintB)))
        let c = lab.calls
        var lines: [String] = []
        let steps = ["Press ⌘` (Command-backtick) once.",
                     "Open STP's Window menu and pick the second window titled \"Still\" (window B).",
                     "Right-click STP's Dock icon and pick window B in its list.",
                     "Press ⌘H to hide STP, then click its Dock icon.",
                     "In STP: Window → Bring All to Front."]
        @MainActor func observe(_ label: String, since: Double) async {
            let events = ((await stp.report("events"))?["list"] as? [[String: Any]] ?? []).filter { ($0["at"] as? Double ?? 0) >= since }
            let words = events.map { "\($0["k"] ?? "?") \($0["windowId"] ?? "?")\(($0["tabId"]).map { " tab \($0)" } ?? "") at \(ms(($0["at"] as? Double).map { $0 - since }))" }
            let fresh = Set(stp.numbers().keys).subtracting(stp.created.map(\.number))
            lines.append("\(label): B \(c.describe(B.number)); A \(c.describe(A.number)); events [\(words.joined(separator: ", "))]; new STP windows \(fresh.count)")
        }
        for (i, s) in steps.enumerated() {
            let since = epochMs()
            guard await Person.ask("Step \(i + 1): \(s) Then press Enter.") else { break }
            await pause(1.5)
            await observe("step \(i + 1)", since: since)
            if !c.parked(B.number) {
                if await stp.state(B) == "fullscreen" { _ = await stp.update(B, ["state": "normal"]); await pause(1.5) }
                let o = await c.park(B.number)
                lines.append("  B parked again: \(c.describe(o))")
            }
            Stp.app?.activate()
            await pause(0.5)
        }
        // Every window parked.
        _ = await stp.update(A, ["state": "normal"])
        _ = await waitFor(2) { !fills(c.server(A.number)?.bounds) }
        await pause(0.5)
        let o = await c.park(A.number)
        lines.append("A parked too: \(c.describe(o))")
        let since = epochMs()
        if await Person.ask("Every lab window is parked. Click STP's Dock icon once, then press Enter.") {
            await pause(1.5)
            await observe("Dock click, all parked", since: since)
        }
        return Outcome(status: .recorded, lines: lines)
    })

// MARK: G10: parking a window mid-entry and just after entry

let g10 = Gate(
    id: "G10", title: "Parking a window mid-entry and just after entry",
    decides: "recovery (§4.4): parked again only once normal",
    needs: [.own], freezes: "none",
    plan: ["a lab window (normal) asked into full screen; SpaceParker parks it 100 ms in, 300 ms in, and 50 ms after didEnterFullScreen",
           "1.5 s later: where it is (Spaces, on screen, AppKit's full-screen flag), and full-screen Spaces against before",
           "recovery: shown from its private Space, out of full screen if it is: back to a normal window on the Desktop with no full-screen Space left over"],
    run: { lab in
        await lab.comeForward()
        let c = lab.calls
        var lines: [String] = []
        var status = Status.recorded
        let w = lab.window(tintB, centered(800, 520))
        ownList.append(w)
        w.window.makeKeyAndOrderFront(nil)
        await pause(0.6)
        for offset in ["100", "300", "after"] {
            let fsBefore = c.fullScreen().count
            w.entered = nil
            let t = epochMs()
            w.window.toggleFullScreen(nil)
            if offset == "after" {
                _ = await waitFor(3) { w.entered != nil }
                await pause(0.05)
            } else {
                await pause(Double(offset)! / 1000)
            }
            let o = await c.park(w.number)
            await pause(1.5)
            lines.append("parked at \(offset == "after" ? "didEnter+50" : offset + " ms") (\(ms(epochMs() - t)) ms in): \(c.describe(o)); then \(c.describe(w.number)), AppKit full screen \(w.isFull), full-screen Spaces \(fsBefore) → \(c.fullScreen().count)")
            // Recovery.
            if c.parker.privateSpaces[w.number] != nil { let s = await c.show(w.number); lines.append("  shown: \(c.describe(s))") }
            if w.isFull { w.window.toggleFullScreen(nil) }
            _ = await waitFor(4) { !w.isFull }
            await pause(1.2)
            let ok = !w.isFull && c.fullScreen().count == fsBefore && c.server(w.number)?.onScreen == true
            lines.append("  recovered: normal \(!w.isFull), on screen \(c.server(w.number)?.onScreen ?? false), full-screen Spaces \(c.fullScreen().count)")
            if !ok { status = .fail; lines.append("  not recovered: stopping"); break }
        }
        return Outcome(status: status, lines: lines)
    })

// MARK: G11: two displays

let g11 = Gate(
    id: "G11", title: "Two displays (a Sidecar iPad): a parked window's bounds moved by its copy, then shown",
    decides: "§6.7",
    needs: [.stp, .displays], freezes: "none",
    plan: ["needs two managed displays (SLSCopyManagedDisplaySpaces); else not run",
           "STP: A full screen on the main display, B parked",
           "B moved onto the second display while parked (windows.update {left, top}): its bounds after, still parked?",
           "B shown (into the active Space): which display it lands on; then moved back and parked again"],
    run: { lab in
        let c = lab.calls
        guard let count = c.spaces.managedDisplayCount(), count >= 2, NSScreen.screens.count >= 2 else {
            return Outcome(status: .notRun, lines: ["one managed display (\(c.spaces.managedDisplayCount().map(String.init) ?? "unknown")): connect a second (Sidecar) and run again"])
        }
        let (stp, _, B) = try await stpPair(lab, a: ("still.html", stillQuery("a", stpTintA)), b: ("still.html", stillQuery("b", stpTintB)))
        var lines: [String] = []
        let second = ScreenGeometry.appKitRect(NSScreen.screens[1].frame) // top left, as windows.update takes it
        let before = c.server(B.number)?.bounds
        let r = await stp.update(B, ["left": Int(second.minX) + 60, "top": Int(second.minY) + 60])
        await pause(0.8)
        lines.append("moved while parked: \(Stp.error(r) ?? "ok"); bounds \(size(before)) → \(size(c.server(B.number)?.bounds)); parked \(c.parked(B.number))")
        let shown = await c.show(B.number)
        await pause(0.8)
        let on = c.server(B.number).flatMap { c.spaces.display(at: $0.bounds) }
        lines.append("shown: \(c.describe(shown)); on display \(on ?? "unknown"); \(c.describe(B.number))")
        _ = await stp.update(B, ["left": 260, "top": 120])
        await pause(0.8)
        let o = await c.park(B.number)
        lines.append("moved back and parked: \(c.describe(o))")
        return Outcome(status: o.ok ? .recorded : .fail, lines: lines)
    })

// MARK: G12: the bridge's frames with no other lab window around

let g12 = Gate(
    id: "G12", title: "Bridge parking's frames (S/handoff/park.swift PARK=bridge) with the webkit-host window gone",
    decides: "the bridge's frame evidence",
    needs: [.own, .frames], freezes: "about 0.7-1.3 s per switch, 6 switches (--runs)",
    plan: ["refuses while the WebKit host (tools/webkit-host) has a window",
           "three lab windows A, B, C (blue, red, green): A full screen, B and C parked",
           "enter-first switches A→B→C→A…, each under one freeze: show, full screen, ready, the old one out of full screen and parked, the settle, reveal",
           "frames from 100 ms before each freeze to its end: any that are neither the old nor the new window's colour"],
    run: { lab in
        let hosts = NSWorkspace.shared.runningApplications.filter { $0.executableURL?.path.contains("webkit-host") == true }
        guard hosts.isEmpty else { return Outcome(status: .notRun, lines: ["the WebKit host is running (pid \(hosts.map { String($0.processIdentifier) }.joined(separator: ", "))): let it finish first"]) }
        guard let rec = await lab.recorder([tintA, tintB, tintC]) else { return Outcome(status: .notRun, lines: ["frames not measured: no Screen Recording for the terminal"]) }
        let ws = try await ownSet(lab, [tintA, tintB, tintC])
        var lines: [String] = []
        var status = Status.pass
        var cur = 0
        for i in 1...lab.runs(6) {
            let next = (cur + 1) % ws.count
            let r = await handoff(lab, side(ws[cur]), side(ws[next]), HandoffPlan())
            await pause(0.3)
            let bad = rec.bad(r.frozenAt - 100, epochMs(), allowed: [ws[cur].name, ws[next].name])
            lines.append(r.line("switch \(i) \(ws[cur].name)→\(ws[next].name)") + "; bad frames \(bad) [\(rec.summary(r.frozenAt - 100, epochMs()))]")
            if r.failure != nil || bad > 0 { status = .fail }
            if r.failure != nil { break }
            cur = next
            await pause(0.5)
        }
        return Outcome(status: status, lines: lines)
    })

// MARK: G13: the freezing process killed; the parker killed with a full-screen Space active

let g13 = Gate(
    id: "G13", title: "Killing the freezing process mid-freeze; where windows land when the parker dies with a full-screen Space active",
    decides: "§4.3 (the watchdog's limits), §6.4",
    needs: [.small, .own, .child, .frames], freezes: "up to 2 s (the child's freeze, until macOS lets go)",
    plan: ["a small lab window changes colour every frame",
           "a child freezes (RealFreezer) and is killed (SIGKILL) 300 ms later: how long until the screen changes again (at once, or macOS's own ~2 s)",
           "a lab window full screen; a child's hidden window parked by another child (`hold`), which is killed: where the window lands (Spaces, on screen) and how soon"],
    run: { lab in
        let c = lab.calls
        var lines: [String] = []
        let d = displayFrame()
        let frame = NSRect(x: d.minX + 40, y: d.minY + 40, width: 260, height: 180)
        let w = lab.window(tintA, frame, flips: true)
        w.window.orderFrontRegardless()
        await pause(0.4)
        let watch = CGRect(x: (frame.minX - d.minX + 20) / d.width, y: (d.maxY - frame.maxY + 40) / d.height, width: (frame.width - 40) / d.width, height: (frame.height - 60) / d.height)
        let rec = await lab.recorder([tintA], watch: watch)
        let fc = try lab.child(["freeze-child"])
        guard let said = await fc.line("frozen ", within: 5) else { return Outcome(status: .fail, lines: ["the freezing child said nothing"]) }
        let frozenAt = epochMs()
        await pause(0.3)
        fc.killNow()
        let killedAt = epochMs()
        await pause(2.5)
        let held = rec?.changed(frozenAt + 20, killedAt)
        let lastHeld = rec?.frames(0, killedAt).last?.sig
        let firstChange = rec?.frames(killedAt, killedAt + 2500).first { $0.sig != lastHeld }
        lines.append("child \(said); held until the kill: changed \(held.map { "\($0.changed)/\($0.frames)" } ?? "not measured"); first change after the kill \(firstChange.map { ms($0.t - killedAt) } ?? "none seen in 2.5 s") ms")
        w.close()
        // The parker dies.
        let ws = try await ownSet(lab, [tintA])
        let (_, n) = try await lab.target()
        let holder = try lab.child(["hold", String(n)])
        guard let held2 = await holder.line("held ", within: 5), held2.hasPrefix("held 1") else { return Outcome(status: .fail, lines: lines + ["the holder didn't park window \(n)"]) }
        lines.append("window \(n) parked by the holder (pid \(holder.pid)): \(c.describe(n))")
        let fsSpace = c.active()
        holder.killNow()
        let t = epochMs()
        let back = await waitFor(3) { !c.spacesOf(n).isEmpty }
        let landed = c.spacesOf(n)
        lines.append("holder killed: back \(back) after \(ms(epochMs() - t)) ms, in \(landed) (the full-screen Space \(fsSpace) \(landed.contains(fsSpace) ? "yes" : "no")); \(c.describe(n))")
        _ = ws
        return Outcome(status: back ? .recorded : .fail, lines: lines)
    })

// MARK: G14: an own-Space panel in a full-screen Space that's destroyed

let g14 = Gate(
    id: "G14", title: "An own-Space panel (Margin's overlay's behaviour) in a full-screen Space that's destroyed",
    decides: "§2.3 (A's overlay out before A's Space goes)",
    needs: [.own], freezes: "none",
    plan: ["a lab window full screen, a panel made as Margin's own-Space overlay ([.managed, .fullScreenAuxiliary, .ignoresCycle], level normal) ordered just above it",
           "left in: the window leaves full screen (its Space goes): where the panel is after (Spaces, on screen, visible)",
           "ordered out first: the same with the panel ordered out before the exit, then ordered in again: which Space it joins"],
    run: { lab in
        let c = lab.calls
        var lines: [String] = []
        let ws = try await ownSet(lab, [tintA])
        let w = ws[0]
        let p = lab.panel(NSRect(x: 0, y: 0, width: 320, height: 200), color: tintC.nsColor)
        for variant in ["left in", "ordered out first"] {
            if !w.isFull {
                w.window.toggleFullScreen(nil)
                _ = await waitFor(5) { w.isFull && c.fullScreen().contains(c.active()) }
                await pause(0.8)
            }
            let f = w.window.frame
            p.panel.setFrame(NSRect(x: f.midX - 160, y: f.midY - 100, width: 320, height: 200), display: true)
            p.panel.order(.above, relativeTo: w.number)
            await pause(0.4)
            let fs = c.active()
            lines.append("\(variant): panel in \(c.spacesOf(p.number)) with the window's Space \(fs)")
            if variant == "ordered out first" { p.panel.orderOut(nil) }
            w.window.toggleFullScreen(nil)
            _ = await waitFor(4) { !w.isFull }
            await pause(1.0)
            lines.append("  after the exit: panel \(c.describe(p.number)), visible \(p.panel.isVisible), on the active Space \(p.panel.isOnActiveSpace); the full-screen Space still there \(c.fullScreen().contains(fs))")
            if variant == "ordered out first" {
                p.panel.orderFront(nil)
                await pause(0.4)
                lines.append("  ordered in again: \(c.describe(p.number)), active Space \(c.active())")
            }
            p.panel.orderOut(nil)
        }
        return Outcome(status: .recorded, lines: lines)
    })

// MARK: G15: the active Space during the entry; a swipe during a freeze

let g15 = Gate(
    id: "G15", title: "The active Space during the entry, polled; a trackpad swipe during a freeze",
    decides: "§1.2's foreign-Space abort rule",
    needs: [.own, .person], freezes: "about 0.7-1.3 s per switch, 4 switches; with --person one more 1.7 s freeze",
    plan: ["the lab's A and B (with --stp: STP's): handoffs back and forth, every active Space seen during each (A's, B's full-screen Space, or another)",
           "the rule holds if no run passed through another Space",
           "with --person: the screen freezes 1.7 s after a 3 s warning; the person swipes to another Space during it; the active Space read every 4 ms"],
    run: { lab in
        let c = lab.calls
        var lines: [String] = []
        var foreign = 0
        var plan = HandoffPlan()
        plan.trace = true
        if lab.o.stp {
            let (stp, A, B) = try await stpPair(lab, a: ("still.html", stillQuery("a", stpTintA)), b: ("still.html", stillQuery("b", stpTintB)))
            var x = A, y = B
            for i in 1...lab.runs(4) {
                let r = await handoff(lab, side(x, stp), side(y, stp), plan)
                lines.append(r.line("STP \(i) \(x.name)→\(y.name)") + "; Spaces seen: " + r.seen.joined(separator: " → "))
                if r.seen.contains(where: { $0.contains("another") || $0.contains("not full screen") }) { foreign += 1 }
                if r.failure != nil { return Outcome(status: .fail, lines: lines) }
                swap(&x, &y)
                await pause(0.8)
            }
        } else {
            let ws = try await ownSet(lab, [tintA, tintB])
            var x = ws[0], y = ws[1]
            for i in 1...lab.runs(4) {
                let r = await handoff(lab, side(x), side(y), plan)
                lines.append(r.line("own \(i) \(x.name)→\(y.name)") + "; Spaces seen: " + r.seen.joined(separator: " → "))
                if r.seen.contains(where: { $0.contains("another") || $0.contains("not full screen") }) { foreign += 1 }
                if r.failure != nil { return Outcome(status: .fail, lines: lines) }
                swap(&x, &y)
                await pause(0.8)
            }
        }
        lines.append("runs through another Space: \(foreign)")
        if lab.o.person {
            print("\nIn 3 s the screen freezes for 1.7 s. During it, swipe to another Space (three or four fingers). Then swipe back.\n")
            await pause(3)
            let before = c.active()
            var seen: [UInt64] = [before]
            try c.freeze()
            let start = epochMs()
            _ = await waitFor(1.75, every: 0.004) {
                let a = c.active()
                if seen.last != a { seen.append(a) }
                return !c.freezer.isLive
            }
            lines.append("swipe under the freeze: active Spaces \(seen) in \(ms(epochMs() - start)) ms (moved \(seen.count > 1))")
        } else {
            lines.append("the swipe: not run (--person)")
        }
        return Outcome(status: foreign == 0 ? .pass : .recorded, lines: lines)
    })

// Issue #15's first gate: an independent live cover over the real, unfrozen Test A/B handoff.
final class LabLivePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class LabLiveCover {
    static let tint = Tint("COVER", 0x19416e)
    let panel: NSPanel
    let lease: LiveCoverSpace
    init(_ sky: SkyLight) async throws {
        panel = LabLivePanel(contentRect: displayFrame(), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.stationary, .ignoresCycle]
        panel.animationBehavior = .none
        panel.isOpaque = true
        panel.backgroundColor = NSColor(calibratedRed: 25 / 255, green: 65 / 255, blue: 110 / 255, alpha: 1)
        panel.alphaValue = 0
        let view = NSView(frame: NSRect(origin: .zero, size: displayFrame().size))
        view.wantsLayer = true
        view.layer?.backgroundColor = panel.backgroundColor.cgColor
        panel.contentView = view
        panel.orderFrontRegardless()
        panel.displayIfNeeded()
        CATransaction.flush() // registration must reach WindowServer before the ownership read
        switch LiveCoverSpace.open(window: UInt32(panel.windowNumber), io: .real(sky)) {
        case .success(let lease): self.lease = lease
        case .failure(let why): panel.orderOut(nil); panel.close(); throw Fail("live cover setup \(why.rawValue)")
        }
        guard await waitFor(0.5, every: 0.02, { lease.isReady }) else {
            panel.orderOut(nil); CATransaction.flush(); _ = lease.close(); panel.close()
            throw Fail("live cover Space membership/level did not verify")
        }
        let pulse = CABasicAnimation(keyPath: "backgroundColor")
        pulse.fromValue = panel.backgroundColor.cgColor
        pulse.toValue = NSColor(calibratedRed: 45 / 255, green: 85 / 255, blue: 130 / 255, alpha: 1).cgColor
        pulse.duration = 0.5; pulse.autoreverses = true; pulse.repeatCount = .infinity
        view.layer?.add(pulse, forKey: "lab-cover-pulse")
        panel.alphaValue = 1
        panel.displayIfNeeded()
        CATransaction.flush()
    }
    @discardableResult func close() -> Bool { panel.orderOut(nil); CATransaction.flush(); panel.close(); return lease.close() }
}

let liveCoverGate = Gate(
    id: "LIVE", title: "Live cover over real Test A/Test B profile handoffs (issue #15)",
    decides: "whether the special Space keeps an own animated panel above actual Safari transitions; not product acceptance",
    needs: [.margin, .devHook, .frames], freezes: "none; an animated blue cover during two profile switches (about 15-30 s)",
    plan: ["requires one display, Test A shown and Test B prepared, handoff/parking on, no dev-hook caps or armed faults",
           "read-only dump must be accepted by Margin's Test A/Test B guard before any panel is shown",
           "disable freeze for Test A/Test B only; restore that cap on every normal, failure and signal cleanup",
           "show one nonactivating pass-through own panel in a temporary level-400 Space; Core Animation keeps its colour pulse live",
           "ask Margin's dev hook for Test B, then Test A; --return-to-a performs only the one remaining return to Test A; every other profile is refused",
           "keep the cover until the handoff summary and fresh reads prove B full screen, active and frontmost, and A parked or gone",
           "40×24 samples over 90% of the display must all be COVER; changed complete frames establish animation; unavailable capture is partial, never pass",
           "order out the owned panel before destroying its Space; stop on the first failure; a physical-camera check is still required"],
    run: { lab in
        guard Margin.running != nil, Margin.devHooksOn, NSScreen.screens.count == 1, lab.calls.availability.liveCover else {
            return Outcome(status: .notRun, lines: ["requires running Margin, enabled dev hook, one display and checked live-cover calls"])
        }
        let (process, buffer) = try Margin.stream()
        defer { process.terminate() }
        await pause(0.4)
        @MainActor func dump() async -> String {
            let before = buffer.all.count
            Margin.dev("dump")
            _ = await waitFor(2, every: 0.02) { buffer.all.dropFirst(before).contains { $0.contains("dev hook: dump: the last") || $0.contains("dev hook:") && $0.contains("refused:") } }
            return buffer.all.dropFirst(before).joined(separator: "\n")
        }
        let before = await dump()
        guard before.contains("handoff on, parking on"), before.contains("switch: idle"), before.contains("no caps; no faults armed"),
              before.contains("close windows off; displays 1"), !before.contains("refused:"), var source = liveShownNumber(before) else {
            return Outcome(status: .fail, lines: ["preflight dump did not establish idle, guarded Test A/Test B with parking, one display and no caps; nothing shown"])
        }
        guard let current = lab.calls.server(source), current.onScreen, fills(current.bounds),
              let active = lab.calls.spaces.showing(onDisplayOf: source), lab.calls.fullScreen().contains(active), lab.calls.spacesOf(source).contains(active),
              WindowMatcher.candidates(CGWindowSource().windows(of: [current.pid]), pids: [current.pid]).filter(\.onScreen).min(by: { $0.order < $1.order })?.number == source else {
            return Outcome(status: .notRun, lines: ["source test window must be full screen, active and frontmost; nothing shown or switched"])
        }
        let capStart = buffer.all.count
        Margin.dev("mode", ["freeze": "off"])
        guard await waitFor(2, every: 0.02, { buffer.all.dropFirst(capStart).contains { $0.contains("mode freeze off for Test A and Test B") } }) else { throw Fail("freeze-off cap not acknowledged; nothing shown") }
        lab.restoreCoverMode = true
        var lines: [String] = []
        let recorder = await lab.recorder([LabLiveCover.tint], wide: true)
        for i in 1...(lab.o.liveReturnToA ? 1 : min(2, lab.runs(2))) {
            let cover = try await LabLiveCover(lab.calls.sky)
            lab.liveCover = cover
            await pause(0.2)
            guard lab.calls.server(cover.panel.windowNumber)?.onScreen == true else { throw Fail("own cover is not on screen") }
            if let recorder {
                guard await waitFor(1, every: 0.02, { recorder.frames(epochMs() - 300).last?.state == "COVER" }) else { throw Fail("no complete cover frame before asking Safari to switch") }
            }
            let first = buffer.all.count, started = epochMs()
            Margin.devSwitch(to: lab.o.liveReturnToA ? "Test A" : (i == 1 ? "Test B" : "Test A"))
            var summary: String?
            guard await waitFor(10, every: 0.02, {
                let fresh = buffer.all.dropFirst(first)
                summary = fresh.first(where: liveSwitchSummary)
                return summary != nil || fresh.contains { $0.contains("dev hook:") && $0.contains("refused:") }
            }), let summary, !summary.contains("frozen "), !summary.contains("recovered"), !summary.contains("aborted"), !summary.contains("failed") else {
                throw Fail("real profile handoff refused, frozen, failed, or no summary in 10 s")
            }
            let state = await dump()
            guard state.contains("switch: idle"), let target = liveShownNumber(state), target != source,
                  let window = lab.calls.server(target), window.onScreen, fills(window.bounds),
                  let active = lab.calls.spaces.showing(onDisplayOf: target), lab.calls.fullScreen().contains(active), lab.calls.spacesOf(target).contains(active),
                  WindowMatcher.candidates(CGWindowSource().windows(of: [window.pid]), pids: [window.pid]).filter(\.onScreen).min(by: { $0.order < $1.order })?.number == target,
                  lab.calls.server(source) == nil || lab.calls.parked(source) else { throw Fail("final B readiness or A parking/gone check failed; stop") }
            let ended = epochMs()
            let frames = recorder?.frames(started, ended) ?? []
            let changed = recorder?.changed(started, ended).changed ?? 0
            let leaks = frames.filter { $0.state != "COVER" }.count
            let measured = "run \(i): \(Int(ended - started)) ms; B full screen/active/frontmost, A parked/gone; \(frames.count) complete frames, \(changed) changes, \(leaks) uncovered; no freeze"
            lines.append(measured)
            note(measured) // keep completed-run evidence even if a later run fails
            let cleaned = cover.close(); lab.liveCover = nil
            guard cleaned else { throw Fail("own cover Space cleanup did not verify; stop") }
            guard leaks == 0, recorder == nil || !frames.isEmpty && changed > 1 else { throw Fail("frame coverage or animation check failed; stop") }
            source = target
            await pause(0.5)
        }
        lines.append("capture \(recorder == nil ? "unavailable: frame coverage and animation NOT MEASURED" : "measured, grid over 90% of display"); physical-camera verification still pending")
        return Outcome(status: recorder == nil ? .partial : .pass, lines: lines)
    })

// A bounded comparison through the same guarded hook, without a lab panel that
// could hide a product failure. Two requests by default; --runs 1 keeps a
// remaining single-request allowance single. First failure stops it.
let compareCoverGate = Gate(
    id: "COMPARE", title: "Current freeze or actual themed-cover timing through Margin.app",
    decides: "up to two successful guarded switches and their mode/timing; not physical-display or pixel-coverage acceptance",
    needs: [.margin, .devHook], freezes: "current freeze normally; --live-ui requires the actual animated product cover with no freeze",
    plan: ["Test A shown, Test B prepared; one display, parking on, close off, idle and no caps/faults",
           "the installed MarginLiveProfileCover default must be off for baseline, on for --live-ui; configure/restart separately before this gate",
           "ask only Test B then Test A (--reverse: Test A then Test B; --return-to-a: only Test A; --runs 1: only the first request); no lab panel, no mode caps, no browser pre-creation",
           "accept only a fresh successful summary in the requested mode; any fallback, failure, refusal or timeout stops before another request",
           "after each, independently verify native full screen, active/front browser identity and the source parked/gone",
           "record timing and summary; memory.py can sample the app and its attributed WebKit processes separately; no frame coverage is claimed"],
    run: { lab in
        guard Margin.running != nil, Margin.devHooksOn else { return Outcome(status: .notRun, lines: ["requires running Margin and guarded dev hook"] ) }
        let flag = LiveCoverPolicy.requested(UserDefaults(suiteName: "com.unibox.margin") ?? .standard)
        guard flag == lab.o.compareLive else { return Outcome(status: .notRun, lines: ["installed feature default does not match requested comparison; nothing switched"]) }
        let (process, buffer) = try Margin.stream()
        defer { process.terminate() }
        await pause(0.4)
        @MainActor func dump() async -> String {
            let at = buffer.all.count
            Margin.dev("dump")
            _ = await waitFor(2, every: 0.02) { buffer.all.dropFirst(at).contains { $0.contains("dev hook: dump: the last") || $0.contains("dev hook:") && $0.contains("refused:") } }
            return buffer.all.dropFirst(at).joined(separator: "\n")
        }
        @MainActor func ready(_ number: Int) -> Bool {
            guard let w = lab.calls.server(number), w.onScreen, fills(w.bounds),
                  let active = lab.calls.spaces.showing(onDisplayOf: number), lab.calls.fullScreen().contains(active), lab.calls.spacesOf(number).contains(active) else { return false }
            return WindowMatcher.candidates(CGWindowSource().windows(of: [w.pid]), pids: [w.pid]).filter(\.onScreen).min(by: { $0.order < $1.order })?.number == number
        }
        let before = await dump()
        let targets = liveCompareTargets(returnToA: lab.o.liveReturnToA, reverse: lab.o.compareReverse, limit: lab.runs(2))
        guard before.contains("handoff on, parking on"), before.contains("switch: idle"), before.contains("no caps; no faults armed"),
              before.contains("close windows off; displays 1"), !before.contains("refused:"), var source = liveShownNumber(before), ready(source),
              let sourceName = validationTestProfile(before), sourceName != targets.first,
              !lab.o.compareLive || (before.contains("live cover session: on") && validationAuditIsClean(before)
                  && before.contains("session interruption: none") && before.contains("0 windows calls pending")) else {
            return Outcome(status: .notRun, lines: ["guarded source/preconditions not ready; nothing switched"])
        }
        let mode = lab.o.compareLive ? "themed live cover" : "freeze baseline"
        var lines: [String] = []
        for (index, targetName) in targets.enumerated() {
            let i = index + 1
            let first = buffer.all.count, started = epochMs()
            Margin.devSwitch(to: targetName)
            var summary: String?
            guard await waitFor(20, every: 0.02, {
                let fresh = buffer.all.dropFirst(first)
                summary = fresh.first(where: liveSwitchSummary)
                return summary != nil || fresh.contains { $0.contains("dev hook:") && $0.contains("refused:") }
            }), let summary, !summary.contains("recovered"), !summary.contains("aborted"), !summary.contains("failed"), !summary.contains("late (") else {
                return Outcome(status: .fail, lines: lines + [
                    "stopped at run \(i): \(mode) summary refused, failed, late or timed out; no further request",
                    summary ?? "no fresh handoff summary received"
                ])
            }
            let hasFreeze = summary.contains("frozen ")
            guard lab.o.compareLive ? summary.contains("live cover ") && !hasFreeze : hasFreeze && !summary.contains("live cover ") else {
                return Outcome(status: .fail, lines: lines + ["requested \(mode) did not run (fallback or mismatched app launch); stop", summary])
            }
            let state = await dump()
            guard state.contains("switch: idle"), let target = liveShownNumber(state), target != source, ready(target),
                  !lab.o.compareLive || (validationAuditIsClean(state) && state.contains("0 windows calls pending")
                    && validationNumber(state, after: "last window ").map({ $0 == 0 || lab.calls.server($0) == nil }) == true),
                  lab.calls.server(source) == nil || lab.calls.parked(source) else {
                return Outcome(status: .fail, lines: lines + ["\(mode) final destination/source state did not verify; stop", summary])
            }
            let measured = "\(mode) run \(i): \(Int(epochMs() - started)) ms through final verified state; " + summary
            lines.append(measured); note(measured)
            source = target
            await pause(1)
        }
        lines.append("no lab cover or recorder; actual physical-display smoothness still requires observation")
        return Outcome(status: .recorded, lines: lines)
    })

// MARK: G16: the acceptance, through Margin.app

let g16 = Gate(
    id: "G16", title: "At least 30 handoffs in release Safari (Test A/Test B) with Margin's extension, real sites, R3/R4 on",
    decides: "the honest numbers, Options.watchdog, the step-5 limit; the build's acceptance, once approved",
    needs: [.margin, .devHook], freezes: "about 1.0-1.5 s per handoff, 30 handoffs (--runs)",
    plan: ["needs Margin.app running with MarginDevHooks YES, and Safari's Test A and Test B each with a window (Margin shows one, the other parked)",
           "the lab never touches Safari: it posts com.unibox.margin.dev.switch (to: Test B, then Test A, …) every 3 s, which Margin refuses for any other profile",
           "Margin's own summary line for each (its log, ids and ms only): frozen ms, late, recovered or aborted",
           "the reveal-time distribution and the late-reveal rate; passes when every switch landed with none recovered or aborted (the late rate is the maintainer's call)"],
    run: { lab in
        guard Margin.running != nil else { return Outcome(status: .notRun, lines: ["Margin.app isn't running"]) }
        guard Margin.devHooksOn else { return Outcome(status: .notRun, lines: ["MarginDevHooks isn't YES (WP12's dev hook; README)"]) }
        let (p, buf) = try Margin.stream()
        defer { p.terminate() }
        await pause(0.5)
        var lines: [String] = []
        var frozen: [Double] = []
        var late = 0, bad = 0, missing = 0
        for i in 1...lab.runs(30) {
            let seenBefore = buf.all.count
            Margin.devSwitch(to: i % 2 == 1 ? "Test B" : "Test A")
            var line: String?
            _ = await waitFor(8, every: 0.1) {
                line = buf.all.dropFirst(seenBefore).compactMap { l in l.range(of: "handoff:").map { String(l[$0.lowerBound...]) } }.first { $0.contains("→") }
                return line != nil
            }
            guard let line else { missing += 1; lines.append("switch \(i): no summary line in 8 s"); continue }
            if let r = line.range(of: #"frozen (\d+) ms"#, options: .regularExpression) {
                frozen.append(Double(line[r].split(separator: " ")[1]) ?? 0)
            }
            if line.contains("late") { late += 1 }
            if line.contains("recovered") || line.contains("aborted") || line.contains("failed") { bad += 1 }
            lines.append("switch \(i): " + line)
            await pause(3)
        }
        lines.append("frozen: \(stats(frozen)); late \(late) of \(frozen.count); recovered or aborted \(bad); no line \(missing)")
        return Outcome(status: bad == 0 && missing == 0 ? .pass : .fail, lines: lines)
    })

// MARK: G17: a watchdog reveal during A's exit, and during the settle

let g17 = Gate(
    id: "G17", title: "A watchdog reveal during A's exit, and during the settle",
    decides: "§1.4's claim that nothing shows",
    needs: [.own, .frames], freezes: "about 0.7-1 s per case, 2 cases plus a plain switch back after each",
    plan: ["the lab's A full screen, B parked",
           "mid-exit: the handoff A→B, revealed (as the watchdog would) 20 ms after A is asked to leave full screen",
           "settle: the same, revealed 30 ms after A is parked, inside the 130 ms settle",
           "frames for 800 ms after each reveal: any that are A's colour, mixed or neither"],
    run: { lab in
        guard let rec = await lab.recorder([tintA, tintB]) else { return Outcome(status: .notRun, lines: ["frames not measured: no Screen Recording for the terminal"]) }
        let ws = try await ownSet(lab, [tintA, tintB])
        var lines: [String] = []
        var status = Status.pass
        for point in [HandoffPlan.RevealPoint.midExit, .settle] {
            var plan = HandoffPlan()
            plan.revealAt = point
            let r = await handoff(lab, side(ws[0]), side(ws[1]), plan)
            await pause(0.9)
            let rev = r.frozenAt + (r.t["revealed"] ?? 0)
            let bad = rec.bad(rev + 5, rev + 800, allowed: [ws[1].name])
            lines.append(r.line(point == .midExit ? "mid-exit" : "settle") + "; frames after the reveal not B's: \(bad) [\(rec.summary(rev + 5, rev + 800))]")
            if r.failure != nil { status = .fail; break }
            if bad > 0 { status = .fail }
            let back = await handoff(lab, side(ws[1]), side(ws[0]), HandoffPlan())
            lines.append(back.line("  back"))
            if back.failure != nil { status = .fail; break }
            await pause(0.8)
        }
        return Outcome(status: status, lines: lines)
    })

// MARK: G18: the bridge on a minimized window

let g18 = Gate(
    id: "G18", title: "The bridge on a minimized window",
    decides: "§1.5 rule 6 (minimized windows aren't targets in the first build)",
    needs: [.own], freezes: "none",
    plan: ["a lab window minimized (the genie plays in the Dock)",
           "on the Desktop: SpaceParker's show (the add op into the active Space, no private Space): minimized after? on screen? its Spaces",
           "then over a full-screen lab window: the same into the full-screen Space",
           "each time it's taken out of the Dock again (deminiaturize) to clean up"],
    run: { lab in
        await lab.comeForward()
        let c = lab.calls
        var lines: [String] = []
        let m = lab.window(tintB, centered(700, 460, dx: 60))
        ownList.append(m)
        m.window.makeKeyAndOrderFront(nil)
        await pause(0.5)
        for place in ["the Desktop", "a full-screen Space"] {
            var a: OwnWindow?
            if place == "a full-screen Space" { a = try await ownSet(lab, [tintA]).first }
            m.window.miniaturize(nil)
            _ = await waitFor(3) { m.window.isMiniaturized }
            await pause(0.6)
            lines.append("\(place): minimized: \(c.describe(m.number))")
            let o = await c.show(m.number)
            await pause(1.0)
            lines.append("  show: \(c.describe(o)); still minimized \(m.window.isMiniaturized); \(c.describe(m.number))")
            if m.window.isMiniaturized { m.window.deminiaturize(nil); _ = await waitFor(3) { !m.window.isMiniaturized } }
            await pause(0.5)
            if let a, a.isFull { a.window.toggleFullScreen(nil); _ = await waitFor(4) { !a.isFull }; await pause(0.8) }
        }
        return Outcome(status: .recorded, lines: lines)
    })

let allGates: [Gate] = [holdsGate, g1, g2, g3, g4, g5, g6, g7, g8, g9, g10, g11, g12, g13, g14, g15, g16, g17, g18, liveCoverGate, compareCoverGate, profileValidationGate, matchedProfileValidationGate, closeFallbackGate, realLockGate, realSleepGate, realDisplayGate, realMultiDisplayGate]
let ownGates = ["holds", "G5", "G6", "G7", "G10", "G12", "G13", "G14", "G15", "G17", "G18"]
let stpGates = ["G2", "G3", "G4", "G8", "G9", "G11"]

// MARK: - A person at the Mac

enum Person {
    // Enter: true; stdin's end or 5 minutes: false.
    static func ask(_ prompt: String) async -> Bool {
        print("\n>>> " + prompt)
        fflush(stdout)
        return await withCheckedContinuation { k in
            let once = Once()
            DispatchQueue.global(qos: .userInitiated).async {
                let got = readLine() != nil
                if once.take() { k.resume(returning: got) }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 300) { if once.take() { k.resume(returning: false) } }
        }
    }
}

nonisolated final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var taken = false
    func take() -> Bool { lock.lock(); defer { lock.unlock() }; if taken { return false }; taken = true; return true }
}

// MARK: - The run: plan, preflight, gates, results

enum Runner {
    static let usage = """
    handoff-lab: the handoff's gates (docs/HANDOFF.md §10.4). README.md is the runbook.
      handoff-lab list                       the gates
      handoff-lab <gate…> --dry-run          the plan and read-only checks; touches nothing
      handoff-lab <gate…> --go               runs them on screen (approval first)
    gates: holds, g1 … g18, LIVE, COMPARE, VALIDATE, MATCHED, FALLBACK, EVLOCK, EVSLEEP, EVDISPLAY, MULTI, own, stp, all
    MATCHED: new 50-request prospective protocol; explicit selection and separate approval required; excluded from all
    FALLBACK: one separately approved live park-failure close fallback after guarded draft readiness; excluded from all
    EVLOCK/EVSLEEP/EVDISPLAY/MULTI: separately approved user-initiated physical checks, --person required; excluded from all
    options: --person (guided steps), --runs N, --stp (G7/G15 in STP too), --dock-restart (G5),
             --dev-hook (G1's Margin switch), --app PATH (default /Applications/Margin.app),
             --results DIR (default tools/handoff-lab/results)
    """

    static func parse(_ args: [String]) -> LabOptions? {
        var o = LabOptions()
        var i = 1
        while i < args.count {
            let a = args[i]
            switch a {
            case "--dry-run": o.dryRun = true
            case "--go": o.go = true
            case "--person": o.person = true
            case "--stp": o.stp = true
            case "--dock-restart": o.dockRestart = true
            case "--dev-hook": o.devHook = true
            case "--return-to-a": o.liveReturnToA = true
            case "--live-ui": o.compareLive = true
            case "--reverse": o.compareReverse = true
            case "--after-failed-warmup":
                i += 1
                guard i < args.count else { return nil }
                o.validationAfterFailedWarmup = args[i]
            case "--live-after-freeze-watchdog":
                i += 1
                guard i < args.count else { return nil }
                o.validationAfterFreezeWatchdog = args[i]
            case "--runs": i += 1; o.runs = i < args.count ? Int(args[i]) : nil
            case "--app": i += 1; if i < args.count { o.appPath = args[i] }
            case "--results": i += 1; if i < args.count { o.resultsDir = URL(fileURLWithPath: args[i]) }
            case "-h", "--help", "help": return nil
            default:
                if a.hasPrefix("-") { print("unknown option \(a)"); return nil }
                o.gates.append(a)
            }
            i += 1
        }
        return o
    }

    static func select(_ names: [String]) -> [Gate]? {
        var ids: [String] = []
        for n in names {
            switch n.lowercased() {
            case "all": ids += allGates.filter { !["MATCHED", "FALLBACK", "EVLOCK", "EVSLEEP", "EVDISPLAY", "MULTI"].contains($0.id) }.map(\.id)
            case "own": ids += ownGates
            case "stp": ids += stpGates
            default:
                guard let g = allGates.first(where: { $0.id.lowercased() == n.lowercased() }) else { print("no gate \(n): see handoff-lab list"); return nil }
                ids.append(g.id)
            }
        }
        var seen = Set<String>()
        return ids.filter { seen.insert($0).inserted }.compactMap { id in allGates.first { $0.id == id } }
    }

    static func printPlan(_ g: Gate) {
        print("\n\(g.id): \(g.title)")
        print("  decides: \(g.decides)")
        print("  needs: " + g.needs.map(\.rawValue).joined(separator: "; "))
        print("  screen held still: \(g.freezes)")
        for (i, step) in g.plan.enumerated() { print("  \(i + 1). \(step)") }
    }

    // Read-only: lookups, permission checks without asking, what's running. No window touched.
    static func preflight(_ o: LabOptions, _ gates: [Gate]) -> [String] {
        let calls = Calls()
        var out = ["lab launch check: " + calls.line]
        out.append("Screen Recording for the terminal: \(Recorder.allowed ? "yes" : "no (frame counts not measured)")")
        out.append("managed displays: \(calls.spaces.managedDisplayCount().map(String.init) ?? "unknown")")
        let needs = Set(gates.flatMap(\.needs).map(\.rawValue))
        if needs.contains(Needs.stp.rawValue) {
            out.append("Safari Technology Preview: \(Stp.app != nil ? "running" : "not running")")
            out.append("the lab's pages and extension: \(FileManager.default.fileExists(atPath: o.labDir.appendingPathComponent("www/still.html").path) ? "found in \(o.labDir.lastPathComponent)/" : "NOT found (--lab-dir)")")
        }
        if needs.contains(Needs.margin.rawValue) {
            out.append("Margin.app: \(Margin.running != nil ? "running" : "not running"); at \(o.appPath): \(FileManager.default.fileExists(atPath: o.appPath) ? "yes" : "no"); MarginDevHooks \(Margin.devHooksOn ? "YES" : "off")")
        }
        let hosts = NSWorkspace.shared.runningApplications.filter { $0.executableURL?.path.contains("webkit-host") == true }
        if !hosts.isEmpty { out.append("the WebKit host is running: G12 won't run until it's done") }
        return out
    }

    static func start(_ args: [String]) -> Never {
        guard let o = parse(args), !o.gates.isEmpty else { print(usage); exit(0) }
        if o.gates == ["list"] {
            for g in allGates { print("\(g.id.padding(toLength: 6, withPad: " ", startingAt: 0)) \(g.title)\n       needs: \(g.needs.map(\.rawValue).joined(separator: "; "))") }
            exit(0)
        }
        guard !PrivateCalls.inTests else { print("refusing: MARGIN_APP_TESTS is set (the private calls refuse under it)"); exit(2) }
        guard let gates = select(o.gates) else { exit(2) }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        Task { exit(await run(o, gates)) }
        app.run()
        exit(0)
    }

    static var signals: [DispatchSourceSignal] = []

    static func run(_ o: LabOptions, _ gates: [Gate]) async -> Int32 {
        if let path = o.validationAfterFreezeWatchdog {
            guard o.validationAfterFailedWarmup == nil, gates.count == 1, gates[0].id == "VALIDATE",
                  let data = try? Data(contentsOf: URL(fileURLWithPath: path)), validationFreezeWatchdogPID(data) != nil else {
                print("refusing: live-only remainder requires the two passed live warmups and diagnosed late freeze control; nothing switched")
                return 2
            }
        }
        if let path = o.validationAfterFailedWarmup {
            guard gates.count == 1, gates[0].id == "VALIDATE",
                  let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
                  validationFailedFirstWarmupPID(data) != nil else {
                print("refusing: remaining validation requires proof of exactly one diagnosed failed first freeze warmup; nothing switched")
                return 2
            }
        }
        if o.dryRun || !o.go {
            print(o.dryRun ? "Dry run: the plan, and read-only checks. Nothing on screen is touched." : "Not run: add --go to run these on screen (approval first; README.md).")
            for g in gates { printPlan(g) }
            if o.liveReturnToA { print("\nOverride: only ONE remaining Test B → Test A return; no Test B request.") }
            if o.compareLive { print("\nCOMPARE override: actual themed live cover required; a freeze/slide fallback fails the gate.") }
            if o.compareReverse { print("\nCOMPARE order: Test A then Test B, starting from Test B; still at most TWO requests.") }
            if o.validationAfterFailedWarmup != nil {
                print("\nVALIDATE remaining: request 1 failed and remains excluded; only requests 2–50 may run (49 maximum), with THREE fresh warmups before pre-idle. All 42 normal measurements and four fault/close requests remain. Fresh corrected candidate/process required; any unexpected failure stops again.")
            }
            if o.validationAfterFreezeWatchdog != nil {
                print("\nVALIDATE live-only observation: matched comparison remains FAILED. Four requests already consumed; at most 36 more (requests 5–40): two excluded live warmups, pre-idle, 30 measured live switches, post-idle, fullscreen recovery, two close requests, suppressed park. No freeze control or matched speed claim. Fresh process/capture required; first unexpected failure stops again.")
            }
            print("\nChecks:")
            for l in preflight(o, gates) { print("  " + l) }
            return 0
        }
        let lab = Lab(o)
        Diagnostics.echo = { note("shell: " + $0) }
        for sig in [SIGINT, SIGTERM] {
            signal(sig, SIG_IGN)
            let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            s.setEventHandler {
                MainActor.assumeIsolated {
                    note("stopped (signal): cleaning up")
                    Task { await lab.cleanup(final: true); exit(130) }
                }
            }
            s.resume()
            signals.append(s)
        }
        note("handoff lab: " + lab.calls.line)
        let started = Date()
        var done: [(Gate, Outcome)] = []
        for g in gates {
            note("== \(g.id): \(g.title)")
            var out: Outcome
            do { out = try await g.run(lab) } catch { out = Outcome(status: .fail, lines: ["stopped: \(error)"]) }
            for l in out.lines { note("  " + l) }
            note("== \(g.id): \(out.status.rawValue)")
            done.append((g, out))
            if out.status == .fail { note("abort: \(g.id) failed, so nothing after it runs"); break }
            await lab.cleanup(final: false)
            ownList = []
            await pause(0.8)
        }
        await lab.cleanup(final: true)
        ownList = []
        if let path = write(lab, done, started: started) { note("results: \(path)") }
        return done.contains { $0.1.status == .fail } ? 1 : 0
    }

    static func write(_ lab: Lab, _ done: [(Gate, Outcome)], started: Date) -> String? {
        guard !done.isEmpty else { return nil }
        let dir = lab.o.resultsDir ?? lab.o.labDir.appendingPathComponent("results")
        let day = DateFormatter()
        day.dateFormat = "yyyy-MM-dd"
        day.locale = Locale(identifier: "en_US_POSIX")
        let time = DateFormatter()
        time.dateFormat = "HH:mm"
        time.locale = Locale(identifier: "en_US_POSIX")
        let c = lab.calls
        let url = dir.appendingPathComponent("\(c.build)-\(day.string(from: started)).md")
        var text = ""
        if !FileManager.default.fileExists(atPath: url.path) {
            text += "# Handoff lab: macOS \(c.version) (\(c.build)), \(day.string(from: started))\n\n"
            text += "Written by `tools/handoff-lab` (`docs/HANDOFF.md` §10.4), one section per run. Ids, window numbers, Space ids, counts and milliseconds only.\n"
        }
        text += "\n## Run at \(time.string(from: started)): \(done.map(\.0.id).joined(separator: ", "))\n\n"
        text += "- Launch check: \(c.line)\n"
        text += "- Screen Recording for the lab: \(Recorder.allowed ? "yes" : "no")\n"
        let flags = [lab.o.person ? "--person" : nil, lab.o.stp ? "--stp" : nil, lab.o.runs.map { "--runs \($0)" }, lab.o.dockRestart ? "--dock-restart" : nil, lab.o.devHook ? "--dev-hook" : nil, lab.o.liveReturnToA ? "--return-to-a (one switch only)" : nil, lab.o.compareLive ? "--live-ui (actual themed cover required)" : nil, lab.o.compareReverse ? "--reverse (Test A then Test B)" : nil].compactMap { $0 }
        text += "- Options: \(flags.isEmpty ? "none" : flags.joined(separator: " "))\n"
        for (g, out) in done {
            text += "\n### \(g.id): \(out.status.rawValue)\n\n\(g.title). Decides: \(g.decides).\n\n"
            for l in out.lines { text += "- " + l.trimmingCharacters(in: .whitespaces) + "\n" }
        }
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            if let h = try? FileHandle(forWritingTo: url) {
                h.seekToEndOfFile()
                h.write(Data(text.utf8))
                try h.close()
            } else {
                try text.write(to: url, atomically: true, encoding: .utf8)
            }
            return url.path
        } catch {
            note("results not written: \(error)")
            return nil
        }
    }
}

// MARK: - main

@main
struct HandoffLabMain {
    static func main() {
        let args = CommandLine.arguments
        // The self-test's child, as Margin.app's own binary is one (BridgeParker.swift ParkProbe).
        if ParkProbe.isChild(args) { ParkProbe.runChild() }
        if args.count > 1 {
            switch args[1] {
            case "target": ChildModes.runTarget()
            case "hold": ChildModes.runHold(args.count > 2 ? Int(args[2]) ?? 0 : 0)
            case "freeze-child": ChildModes.runFreezeChild()
            default: break
            }
        }
        Runner.start(args)
    }
}
