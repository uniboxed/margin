// Opt-in visual research. Only owned/disposable windows are recorded or mutated.
// Public ScreenCaptureKit is measurement infrastructure; hiding uses AX/private AppKit only.
import AppKit
import ApplicationServices
import ObjectiveC.runtime
import ScreenCaptureKit
import AVFoundation
import ImageIO
import Darwin

@_silgen_name("_AXUIElementGetWindow") private func windowNumber(_ element: AXUIElement, _ number: UnsafeMutablePointer<UInt32>) -> AXError

struct Failure: Error, CustomStringConvertible {
    let description: String
    init(_ text: String) { description = text }
}
func check(_ condition: Bool, _ message: String) throws { if !condition { throw Failure(message) } }
func pause(_ seconds: Double) async throws { try await Task.sleep(nanoseconds: UInt64(seconds * 1e9)) }
func read(_ element: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
    var value: CFTypeRef?
    return (AXUIElementCopyAttributeValue(element, name as CFString, &value), value)
}

@MainActor protocol VisualCapture: AnyObject {
    var state: (Double?, Bool, String?, Int) { get }
    func start(pid: pid_t, number: UInt32, url: URL) async throws
    func stop() async throws
}

final class Capture: NSObject, VisualCapture, SCRecordingOutputDelegate, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var began: Double?, ended = false, failure: String?, complete = 0
    private var stream: SCStream?
    private var recording: SCRecordingOutput?
    var state: (Double?, Bool, String?, Int) { lock.lock(); defer { lock.unlock() }; return (began, ended, failure, complete) }
    func recordingOutputDidStartRecording(_ output: SCRecordingOutput) {
        lock.lock(); began = ProcessInfo.processInfo.systemUptime; lock.unlock()
    }
    func recordingOutputDidFinishRecording(_ output: SCRecordingOutput) {
        lock.lock(); ended = true; lock.unlock()
    }
    func recordingOutput(_ output: SCRecordingOutput, didFailWithError error: Error) {
        lock.lock(); failure = String(describing: error); lock.unlock()
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock(); failure = String(describing: error); lock.unlock()
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, buffer.isValid else { return }
        let attachments = (CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first
        guard (attachments?[.status] as? Int) == SCFrameStatus.complete.rawValue else { return }
        lock.lock(); complete += 1; lock.unlock()
    }
    @MainActor func start(pid: pid_t, number: UInt32, url: URL) async throws {
        let shareable = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let window = shareable.windows.first(where: { $0.windowID == number && $0.owningApplication?.processID == pid }) else { throw Failure("exact owned window is not shareable") }
        let config = SCStreamConfiguration()
        config.width = 1800; config.height = 1200
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.queueDepth = 5; config.showsCursor = false
        config.capturesAudio = false; config.captureMicrophone = false
        config.ignoreShadowsSingleWindow = true; config.includeChildWindows = true
        let filter: SCContentFilter
        if pid == getpid() {
            filter = SCContentFilter(desktopIndependentWindow: window)
        } else {
            guard let display = shareable.displays.first(where: { CGDisplayBounds($0.displayID).contains(window.frame) }) else { throw Failure("window must fit on one display") }
            filter = SCContentFilter(display: display, including: [window])
            filter.includeMenuBar = false
            let displayFrame = CGDisplayBounds(display.displayID)
            config.sourceRect = window.frame.offsetBy(dx: -displayFrame.minX, dy: -displayFrame.minY)
            config.width = Int(window.frame.width * 2) / 2 * 2
            config.height = Int(window.frame.height * 2) / 2 * 2
            config.ignoreShadowsDisplay = true
        }
        let recordingConfig = SCRecordingOutputConfiguration()
        recordingConfig.outputURL = url; recordingConfig.videoCodecType = .h264; recordingConfig.outputFileType = .mp4
        let output = SCRecordingOutput(configuration: recordingConfig, delegate: self)
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addRecordingOutput(output)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "traffic-lights.visual.frames"))
        self.stream = stream; self.recording = output
        try await stream.startCapture()
        let deadline = ProcessInfo.processInfo.systemUptime + 6
        while ProcessInfo.processInfo.systemUptime < deadline {
            let current = state
            if let error = current.2 { throw Failure(error) }
            if current.0 != nil && current.3 > 0 { return }
            try await pause(0.05)
        }
        throw Failure("recorder did not acknowledge recording and a complete frame")
    }
    @MainActor func stop() async throws {
        guard let stream else { return }
        try await stream.stopCapture()
        let deadline = ProcessInfo.processInfo.systemUptime + 6
        while !state.1 && state.2 == nil && ProcessInfo.processInfo.systemUptime < deadline { try await pause(0.05) }
        self.stream = nil; recording = nil
        if let error = state.2 { throw Failure(error) }
        try check(state.1 && state.3 >= 3, "recording did not finish with enough complete frames")
    }
}

// SCK window sharing replaces other apps' controls with a sharing capsule on this host.
// This sampler records only the verified test window, with real per-frame timestamps.
@MainActor final class FrameCapture: VisualCapture {
    private var began: Double?, ended = false, failure: String?
    private var frames: [(Double, String)] = []
    private var task: Task<Void, Never>?
    private var output: URL?, frameDirectory: URL?
    var state: (Double?, Bool, String?, Int) { (began, ended, failure, frames.count) }
    func start(pid: pid_t, number: UInt32, url: URL) async throws {
        let handle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)!
        func resolve<T>(_ name: String, _ type: T.Type) throws -> T {
            guard let symbol = dlsym(handle, name) else { throw Failure("missing " + name) }
            return unsafeBitCast(symbol, to: type)
        }
        typealias Main = @convention(c) () -> UInt32
        typealias Snapshot = @convention(c) (UInt32, UnsafePointer<UInt32>, Int32, UInt32) -> Unmanaged<CFArray>?
        typealias Owner = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>) -> Int32
        typealias PID = @convention(c) (UInt32, UnsafeMutablePointer<pid_t>) -> Int32
        let cid = try resolve("SLSMainConnectionID", Main.self)()
        let capture = try resolve("SLSHWCaptureWindowList", Snapshot.self)
        let owner = try resolve("SLSGetWindowOwner", Owner.self), ownerPID = try resolve("SLSConnectionGetPID", PID.self)
        output = url
        let directory = url.deletingPathExtension().appendingPathExtension("frames")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        frameDirectory = directory
        func take() throws {
            var connection: UInt32 = 0, foundPID: pid_t = 0, wid = number
            try check(owner(cid, wid, &connection) == 0 && ownerPID(connection, &foundPID) == 0 && foundPID == pid, "capture target ownership changed")
            let stamp = ProcessInfo.processInfo.systemUptime
            guard let images = capture(cid, &wid, 1, 0x0200)?.takeRetainedValue(), CFArrayGetCount(images) == 1 else { throw Failure("private window capture unavailable") }
            let image = unsafeBitCast(CFArrayGetValueAtIndex(images, 0), to: CGImage.self)
            try check(CFGetTypeID(image) == CGImage.typeID && image.width > 100 && image.height > 100, "invalid private capture image")
            let file = String(format: "frame-%05d.png", frames.count)
            guard let destination = CGImageDestinationCreateWithURL(directory.appendingPathComponent(file) as CFURL, "public.png" as CFString, 1, nil) else { throw Failure("cannot create frame") }
            CGImageDestinationAddImage(destination, image, nil)
            try check(CGImageDestinationFinalize(destination), "cannot save frame")
            if began == nil { began = stamp }
            frames.append((stamp, file))
        }
        try take()
        task = Task { @MainActor in
            while !Task.isCancelled {
                do { try await pause(0.1); if Task.isCancelled { return }; try take() }
                catch is CancellationError { return }
                catch { failure = String(describing: error); return }
            }
        }
    }
    func stop() async throws {
        guard !ended, let directory = frameDirectory, let output else { return }
        task?.cancel(); await task?.value; task = nil
        if let failure { throw Failure(failure) }
        try check(frames.count >= 3, "not enough sampled frames")
        let stop = ProcessInfo.processInfo.systemUptime
        var concat = "ffconcat version 1.0\n"
        for index in frames.indices {
            let next = index + 1 < frames.count ? frames[index + 1].0 : stop
            concat += "file '\(frames[index].1)'\noption framerate 1000\nduration \(max(0.001, next - frames[index].0))\n"
        }
        concat += "file '\(frames.last!.1)'\noption framerate 1000\n"
        let list = directory.appendingPathComponent("frames.ffconcat")
        try concat.write(to: list, atomically: true, encoding: .utf8)
        try JSONSerialization.data(withJSONObject: frames.map { ["uptime": $0.0, "file": $0.1] }, options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent("timestamps.json"))
        let encoder = Process()
        encoder.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/ffmpeg")
        encoder.arguments = ["-hide_banner", "-loglevel", "error", "-safe", "0", "-i", list.path, "-vf", "scale=900:650:force_original_aspect_ratio=decrease,pad=900:650:0:0:black", "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output.path]
        try encoder.run(); encoder.waitUntilExit()
        try check(encoder.terminationStatus == 0, "frame encoding failed")
        ended = true
    }
}

@MainActor final class VisualRun {
    let name: String, directory: URL
    let capture: any VisualCapture
    var events: [[String: Any]] = []
    var native: NSWindow?, status: NSTextField?
    var launched: Process?, targetPID: pid_t?, axWindow: AXUIElement?, originalSize: CFTypeRef?
    var restoreValues: [(AXUIElement, CFTypeRef)] = []
    var ownedDirectory: URL?
    let former = NSWorkspace.shared.frontmostApplication?.processIdentifier
    init(name: String, directory: URL) { self.name = name; self.directory = directory; self.capture = name == "native" ? Capture() : FrameCapture() }
    func log(_ event: String, _ values: [String: Any] = [:]) {
        var row = values
        row["event"] = event; row["uptime"] = ProcessInfo.processInfo.systemUptime
        if let start = capture.state.0 { row["videoSeconds"] = ProcessInfo.processInfo.systemUptime - start }
        events.append(row)
        print(String(decoding: try! JSONSerialization.data(withJSONObject: row, options: .sortedKeys), as: UTF8.self))
        try? JSONSerialization.data(withJSONObject: events, options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent(name + ".json"), options: .atomic)
    }
    func phase(_ text: String) { status?.stringValue = text; log("phase", ["label": text]) }
    func snapshot(_ label: String) {
        if let native {
            let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].map { kind -> [String: Any] in
                let button = native.standardWindowButton(kind)!
                return ["type": kind.rawValue, "hidden": button.isHiddenOrHasHiddenAncestor, "alpha": button.alphaValue,
                        "hit": button.superview?.hitTest(NSPoint(x: button.frame.midX, y: button.frame.midY)) === button]
            }
            log("snapshot", ["label": label, "windowed": !native.styleMask.contains(.fullScreen), "frame": NSStringFromRect(native.frame), "buttons": buttons])
        } else if let window = axWindow {
            let (result, fullscreen) = read(window, "AXFullScreen")
            log("snapshot", ["label": label, "fullscreenRead": result.rawValue, "fullscreen": fullscreen as? Bool ?? false])
        }
    }
    func createNative() throws -> UInt32 {
        NSApplication.shared.setActivationPolicy(.accessory)
        NSApplication.shared.finishLaunching()
        let window = NSWindow(contentRect: NSRect(x: 150, y: 160, width: 900, height: 570),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Native AppKit positive control — windowed"
        let view = window.contentView!
        let heading = NSTextField(labelWithString: "Native AppKit test app")
        heading.font = .systemFont(ofSize: 30, weight: .bold); heading.frame = NSRect(x: 45, y: 450, width: 800, height: 50)
        view.addSubview(heading)
        let label = NSTextField(labelWithString: "Preparing recording")
        label.font = .systemFont(ofSize: 24, weight: .medium); label.frame = NSRect(x: 45, y: 365, width: 810, height: 45)
        view.addSubview(label); status = label
        let description = NSTextField(wrappingLabelWithString: "Positive control: private APIs run INSIDE this test app.\nThe title bar stays visible. Only its three buttons are hidden.\nThis does not demonstrate hiding buttons in an unmodified browser.")
        description.font = .systemFont(ofSize: 19); description.frame = NSRect(x: 45, y: 195, width: 790, height: 125)
        view.addSubview(description)
        let progress = NSProgressIndicator(frame: NSRect(x: 45, y: 130, width: 710, height: 18))
        progress.isIndeterminate = true; progress.style = .bar; progress.startAnimation(nil); view.addSubview(progress)
        window.makeKeyAndOrderFront(nil); NSApplication.shared.activate()
        native = window; targetPID = getpid()
        return UInt32(window.windowNumber)
    }
    func privateButtons(_ hidden: Bool) throws {
        guard let native else { throw Failure("native host missing") }
        let find = NSSelectorFromString("_findStandardWindowButton:"), hide = NSSelectorFromString("_setHidden:setNeedsDisplay:")
        guard let findMethod = class_getInstanceMethod(type(of: native), find) else { throw Failure("private button lookup missing") }
        try check(String(cString: method_getTypeEncoding(findMethod)!) == "@24@0:8Q16", "button lookup ABI differs")
        typealias Find = @convention(c) (AnyObject, Selector, UInt) -> Unmanaged<AnyObject>?
        typealias Hide = @convention(c) (AnyObject, Selector, Bool, Bool) -> Void
        let lookup = unsafeBitCast(method_getImplementation(findMethod), to: Find.self)
        for index in UInt(0)...2 {
            guard let button = lookup(native, find, index)?.takeUnretainedValue(),
                  let method = class_getInstanceMethod(type(of: button), hide) else { throw Failure("button or hidden setter missing") }
            try check(String(cString: method_getTypeEncoding(method)!) == "v24@0:8B16B20", "hidden setter ABI differs")
            unsafeBitCast(method_getImplementation(method), to: Hide.self)(button, hide, hidden, true)
        }
        log("private-hide", ["hidden": hidden])
    }
    func createExternal() async throws -> UInt32 {
        let bundle = name == "chrome" ? "com.google.Chrome" : name == "edge" ? "com.microsoft.edgemac" : "com.apple.TextEdit"
        try check(!NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == bundle }, "target app already running; refusing to touch existing windows")
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("margin-visual-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: false)
        ownedDirectory = temporary
        let process = Process()
        let started = Date()
        if name == "textedit" {
            let file = temporary.appendingPathComponent("Traffic-light visual test.txt")
            try "TEXTEDIT — EXTERNAL ACCESSIBILITY TEST\n\nOnly this temporary document is recorded.\n\nThe red, yellow and green buttons are the actual controls.\nThe recording shows baseline, AXHidden request, window resize and restoration.\n\nNo plugin or code is running inside TextEdit.\n".write(to: file, atomically: true, encoding: .utf8)
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = ["-n", "-W", "-a", "/System/Applications/TextEdit.app", file.path, "--args", "-ApplePersistenceIgnoreState", "YES"]
        } else {
            let app = name == "chrome" ? "Google Chrome" : "Microsoft Edge"
            process.executableURL = URL(fileURLWithPath: "/Applications/\(app).app/Contents/MacOS/\(app)")
            let file = temporary.appendingPathComponent("test.html")
            try """
            <!doctype html><meta charset="utf-8"><title>Traffic-light visual test</title>
            <style>body{font:22px -apple-system;background:#eff4f9;color:#172a3c;margin:50px}h1{font-size:34px}p{line-height:1.6}small{font-size:17px}.track{height:9px;background:#dae2ed;margin-top:45px;overflow:hidden}.pulse{height:100%;width:90px;background:#3073c7;animation:slide 2s linear infinite alternate}@keyframes slide{to{transform:translateX(500px)}}</style>
            <h1>\(app) — external AX test</h1><p>The three buttons above are the actual native window controls.</p><p>Baseline → AXHidden request → resize → restoration</p><small>No extension, browser automation protocol, plugin or injected code.<br>This temporary page contains no JavaScript or network resources.</small><div class="track"><div class="pulse"></div></div>
            """.write(to: file, atomically: true, encoding: .utf8)
            process.arguments = ["--user-data-dir=" + temporary.appendingPathComponent("profile").path, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--disable-default-apps", "--disable-extensions", "--window-size=900,650", "--new-window", file.absoluteString]
        }
        let errors = directory.appendingPathComponent(name + "-launch.stderr")
        FileManager.default.createFile(atPath: errors.path, contents: nil)
        process.standardOutput = FileHandle.nullDevice; process.standardError = try FileHandle(forWritingTo: errors)
        try process.run(); launched = process
        log("launched", ["pid": process.processIdentifier])
        let deadline = ProcessInfo.processInfo.systemUptime + 12
        while ProcessInfo.processInfo.systemUptime < deadline {
            let candidate = name == "textedit"
                ? NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundle && ($0.launchDate ?? .distantPast) >= started.addingTimeInterval(-1) })
                : NSRunningApplication(processIdentifier: process.processIdentifier)
            if let app = candidate {
                try check(app.bundleIdentifier == bundle, "target bundle identity differs")
                if name != "textedit" { try check(app.processIdentifier == process.processIdentifier, "browser redirected to another process") }
                targetPID = app.processIdentifier
                let application = AXUIElementCreateApplication(app.processIdentifier)
                AXUIElementSetMessagingTimeout(application, 0.5)
                let windows = read(application, "AXWindows").1 as? [AXUIElement] ?? []
                if !windows.isEmpty {
                    try check(windows.count == 1, "expected exactly one disposable test window")
                    let window = windows[0]
                    var number: UInt32 = 0
                    try check(windowNumber(window, &number) == .success && number != 0, "cannot bind native window number")
                    let (fr, fullscreen) = read(window, "AXFullScreen")
                    try check(fr == .success && fullscreen as? Bool == false, "window is not confirmed windowed")
                    axWindow = window; originalSize = read(window, "AXSize").1
                    func rectDescription(_ element: AXUIElement) -> [String: String] {
                        var result: [String: String] = [:]
                        if let value = read(element, "AXPosition").1, CFGetTypeID(value) == AXValueGetTypeID() {
                            var point = CGPoint.zero
                            if AXValueGetValue(value as! AXValue, .cgPoint, &point) { result["position"] = NSStringFromPoint(point) }
                        }
                        if let value = read(element, "AXSize").1, CFGetTypeID(value) == AXValueGetTypeID() {
                            var size = CGSize.zero
                            if AXValueGetValue(value as! AXValue, .cgSize, &size) { result["size"] = NSStringFromSize(size) }
                        }
                        return result
                    }
                    log("window-geometry", rectDescription(window))
                    for key in ["AXCloseButton", "AXMinimizeButton", "AXZoomButton"] {
                        if let value = read(window, key).1, CFGetTypeID(value) == AXUIElementGetTypeID() {
                            let button = value as! AXUIElement
                            var record = rectDescription(button); var buttonWindow: UInt32 = 0
                            record["numberResult"] = String(windowNumber(button, &buttonWindow).rawValue)
                            record["window"] = String(buttonWindow); record["button"] = key
                            log("button-geometry", record)
                        }
                    }
                    _ = AXUIElementSetAttributeValue(application, "AXFrontmost" as CFString, kCFBooleanTrue)
                    _ = AXUIElementPerformAction(window, "AXRaise" as CFString)
                    log("target", ["pid": app.processIdentifier, "window": number, "bundle": bundle])
                    try await pause(1)
                    return number
                }
            }
            try await pause(0.1)
        }
        log("discovery-timeout", ["launchedRunning": process.isRunning, "launchedExit": process.isRunning ? -1 : process.terminationStatus])
        throw Failure("disposable app window did not appear")
    }
    func hideExternal() throws {
        guard let window = axWindow else { throw Failure("external window missing") }
        for name in ["AXCloseButton", "AXMinimizeButton", "AXZoomButton"] {
            let (br, value) = read(window, name)
            try check(br == .success && value != nil && CFGetTypeID(value!) == AXUIElementGetTypeID(), "missing button " + name)
            let button = value as! AXUIElement
            let original = read(button, "AXHidden").1 ?? kCFBooleanFalse!
            var writable: DarwinBoolean = false
            let sr = AXUIElementIsAttributeSettable(button, "AXHidden" as CFString, &writable)
            let result = AXUIElementSetAttributeValue(button, "AXHidden" as CFString, kCFBooleanTrue)
            if result == .success { restoreValues.append((button, original)) }
            log("ax-hide", ["button": name, "settableResult": sr.rawValue, "settable": writable.boolValue, "result": result.rawValue])
        }
    }
    func restoreExternal() {
        for (button, value) in restoreValues { log("ax-restore", ["result": AXUIElementSetAttributeValue(button, "AXHidden" as CFString, value).rawValue]) }
        restoreValues = []
        if let window = axWindow, let size = originalSize { log("size-restore", ["result": AXUIElementSetAttributeValue(window, "AXSize" as CFString, size).rawValue]) }
    }
    func resizeExternal() throws {
        guard let window = axWindow, let value = originalSize, CFGetTypeID(value) == AXValueGetTypeID() else { throw Failure("original size missing") }
        var size = CGSize.zero
        try check(AXValueGetValue(value as! AXValue, .cgSize, &size), "size decode")
        size.width += 80; size.height += 45
        let result = AXUIElementSetAttributeValue(window, "AXSize" as CFString, AXValueCreate(.cgSize, &size)!)
        log("resize", ["result": result.rawValue]); try check(result == .success, "resize rejected")
    }
    func cleanup() async {
        if native != nil { try? privateButtons(false); native?.close(); native = nil }
        restoreExternal()
        if let window = axWindow, let value = read(window, "AXCloseButton").1, CFGetTypeID(value) == AXUIElementGetTypeID() {
            log("close-owned-window", ["result": AXUIElementPerformAction(value as! AXUIElement, "AXPress" as CFString).rawValue])
        }
        if let pid = targetPID, pid != getpid(), let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated {
            _ = kill(pid, SIGTERM)
            for _ in 0..<20 { if app.isTerminated { break }; try? await pause(0.1) }
            if !app.isTerminated { _ = kill(pid, SIGKILL) }
        }
        if let launched, launched.isRunning { launched.terminate() }
        if let temporary = ownedDirectory { try? FileManager.default.removeItem(at: temporary) }
        if let former, former != getpid() { _ = AXUIElementSetAttributeValue(AXUIElementCreateApplication(former), "AXFrontmost" as CFString, kCFBooleanTrue) }
        let gone = targetPID == nil || targetPID == getpid() || NSRunningApplication(processIdentifier: targetPID!)?.isTerminated != false
        log("cleanup", ["targetGone": gone, "profileRemoved": ownedDirectory.map { !FileManager.default.fileExists(atPath: $0.path) } ?? true])
    }
    func run() async throws {
        let number = try await (name == "native" ? createNative() : createExternal())
        try await capture.start(pid: targetPID!, number: number, url: directory.appendingPathComponent(name + "-raw.mp4"))
        log("recording-started", ["pid": targetPID!, "window": number, "scope": name == "native" ? "desktop-independent exact window; no audio" : "SLSHWCaptureWindowList exact-window sampled frames, 0x0200 nominal resolution; actual timestamps; no audio"])
        phase("Baseline — buttons visible"); snapshot("baseline"); try await pause(2.5)
        if name == "native" {
            try privateButtons(true); phase("Private API — three buttons hidden")
        } else {
            try hideExternal(); phase("External AXHidden request held")
        }
        snapshot("hide-attempt"); try await pause(3)
        if let native { native.setContentSize(NSSize(width: 980, height: 615)) } else { try resizeExternal() }
        phase("Resize while hide request remains active"); snapshot("resized"); try await pause(2.5)
        if let native { try privateButtons(false); native.setContentSize(NSSize(width: 900, height: 570)) } else { restoreExternal() }
        phase("Restored — original buttons and size"); snapshot("restored"); try await pause(2.5)
        try await capture.stop()
        log("recording-finished", ["completeFrames": capture.state.3, "video": name + "-raw.mp4"])
    }
}

@main struct Main {
    @MainActor static func main() async {
        setbuf(stdout, nil)
        let args = CommandLine.arguments
        guard let ci = args.firstIndex(of: "--case"), args.count > ci + 1,
              let oi = args.firstIndex(of: "--output"), args.count > oi + 1,
              ["native", "chrome", "edge", "textedit"].contains(args[ci + 1]) else {
            print("Usage: visual --case native|chrome|edge|textedit --output /absolute/directory [--run]"); return
        }
        let name = args[ci + 1], directory = URL(fileURLWithPath: args[oi + 1], isDirectory: true)
        guard args.contains("--run") else {
            print("DRY RUN: one \(name) test window, exact-window recording without audio; baseline/hide/resize/restore; owned cleanup. No existing app window is changed."); return
        }
        do {
            try check(AXIsProcessTrusted() && CGPreflightScreenCaptureAccess(), "AX and Screen Recording permission required")
            var size = 0; sysctlbyname("kern.osversion", nil, &size, nil, 0)
            var bytes = [CChar](repeating: 0, count: size); sysctlbyname("kern.osversion", &bytes, &size, nil, 0)
            try check(String(cString: bytes) == "25G342", "private selectors checked only on 25G342")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try check(!FileManager.default.fileExists(atPath: directory.appendingPathComponent(name + "-raw.mp4").path), "output already exists; preserve prior run")
            if name != "native" { NSApplication.shared.setActivationPolicy(.accessory); NSApplication.shared.finishLaunching() }
            let run = VisualRun(name: name, directory: directory)
            do { try await run.run(); await run.cleanup() }
            catch { run.log("failure", ["description": String(describing: error)]); try? await run.capture.stop(); await run.cleanup(); exit(2) }
        } catch { print("REFUSED: \(error)"); exit(2) }
    }
}
