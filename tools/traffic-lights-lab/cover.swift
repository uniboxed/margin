// External research only. The target's native buttons remain intact underneath an owned surface.
// Link with visual.swift using -D COVER_LAB. No code is loaded into the target process.
import AppKit
import ApplicationServices
import ImageIO
import Darwin

final class CoverDeadline: @unchecked Sendable {
    private let lock = NSLock()
    private var targets: Set<pid_t> = []
    func bind(_ pid: pid_t?) { lock.lock(); if let pid { targets.insert(pid) } else { targets.removeAll() }; lock.unlock() }
    func release(_ pid: pid_t) { lock.lock(); targets.remove(pid); lock.unlock() }
    func expire() {
        lock.lock(); let pids = targets; lock.unlock()
        for pid in pids { _ = kill(pid, SIGTERM) }
        _exit(3) // WindowServer releases this controller's own surfaces on process exit.
    }
}

@MainActor final class ExternalCover {
    let sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)!
    let cg = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW)!
    let run: VisualRun
    var cid: UInt32 = 0, target: UInt32 = 0, patch: UInt32 = 0
    var context: CGContext?, backdrop: NSWindow?, occluder: NSWindow?
    var observer: AXObserver?, activationObserver: NSObjectProtocol?
    var refreshEpoch = 0
    var window: AXUIElement?, originalPosition: CFTypeRef?
    var canvas = CGRect.zero, patchFrame = CGRect.zero
    var palette: CGImage?, occluderRun: VisualRun?
    var active = false, began = ProcessInfo.processInfo.systemUptime
    var events: [[String: Any]] = [], frames: [[String: Any]] = []
    let directory: URL
    let deadline: CoverDeadline
    init(_ run: VisualRun, _ directory: URL, _ deadline: CoverDeadline) { self.run = run; self.directory = directory; self.deadline = deadline }
    func fn<T>(_ library: UnsafeMutableRawPointer, _ name: String, _: T.Type) throws -> T {
        guard let symbol = dlsym(library, name) else { throw Failure("missing " + name) }
        return unsafeBitCast(symbol, to: T.self)
    }
    func fn<T>(_ name: String, _ type: T.Type) throws -> T { try fn(sky, name, type) }
    func log(_ name: String, _ values: [String: Any] = [:]) {
        var row = values; row["event"] = name; row["seconds"] = ProcessInfo.processInfo.systemUptime - began
        events.append(row)
        print(String(decoding: try! JSONSerialization.data(withJSONObject: row, options: .sortedKeys), as: UTF8.self))
        try? JSONSerialization.data(withJSONObject: events, options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent("cover.json"), options: .atomic)
    }
    func bounds(_ id: UInt32) throws -> CGRect {
        if id == target, let pid = run.targetPID {
            typealias Owner = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>) -> Int32
            typealias PID = @convention(c) (UInt32, UnsafeMutablePointer<pid_t>) -> Int32
            var owner: UInt32 = 0, actual: pid_t = 0
            try check(try fn("SLSGetWindowOwner", Owner.self)(cid, id, &owner) == 0 && fn("SLSConnectionGetPID", PID.self)(owner, &actual) == 0 && actual == pid, "target ownership changed")
        }
        typealias Bounds = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<CGRect>) -> Int32
        var rect = CGRect.zero
        try check(try fn("SLSGetWindowBounds", Bounds.self)(cid, id, &rect) == 0 && rect.width.isFinite && rect.height.isFinite && rect.width > 0 && rect.height > 0, "invalid native bounds")
        return rect
    }
    func buttons() throws -> [CGRect] {
        guard let window else { throw Failure("AX window missing") }
        return try ["AXCloseButton", "AXMinimizeButton", "AXZoomButton"].map { key in
            guard let value = read(window, key).1, CFGetTypeID(value) == AXUIElementGetTypeID() else { throw Failure("button missing") }
            let button = value as! AXUIElement
            guard let position = read(button, "AXPosition").1, let size = read(button, "AXSize").1,
                  CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { throw Failure("button geometry missing") }
            var point = CGPoint.zero, dimensions = CGSize.zero
            try check(AXValueGetValue(position as! AXValue, .cgPoint, &point) && AXValueGetValue(size as! AXValue, .cgSize, &dimensions), "button geometry invalid")
            return CGRect(origin: point, size: dimensions)
        }
    }
    func frame() throws -> CGRect {
        let targetBounds = try bounds(target), rects = try buttons()
        let rect = rects.reduce(CGRect.null) { $0.union($1) }.insetBy(dx: -2, dy: -2).integral
        try check(rect.width > 30 && rect.width < 160 && rect.height > 10 && rect.height < 50 && targetBounds.contains(rect), "unexpected button group")
        return rect
    }
    func targetPixels(_ name: String) throws -> CGImage {
        typealias Capture = @convention(c) (UInt32, UnsafePointer<UInt32>, Int32, UInt32) -> Unmanaged<CFArray>?
        var id = target
        guard let list = try fn("SLSHWCaptureWindowList", Capture.self)(cid, &id, 1, 0x0200)?.takeRetainedValue(), CFArrayGetCount(list) == 1 else { throw Failure("target snapshot failed") }
        let image = unsafeBitCast(CFArrayGetValueAtIndex(list, 0), to: CGImage.self)
        try save(image, directory.appendingPathComponent(name + ".png")); return image
    }
    func save(_ image: CGImage, _ path: URL) throws {
        guard let destination = CGImageDestinationCreateWithURL(path as CFURL, "public.png" as CFString, 1, nil) else { throw Failure("PNG destination") }
        CGImageDestinationAddImage(destination, image, nil)
        try check(CGImageDestinationFinalize(destination), "PNG write")
    }
    func order(_ id: UInt32, _ mode: Int32, _ relative: UInt32 = 0) throws {
        typealias Order = @convention(c) (UInt32, UInt32, Int32, UInt32) -> Int32
        try check(try fn("SLSOrderWindow", Order.self)(cid, id, mode, relative) == 0, "order failed")
    }
    func hide() { if patch != 0 { try? order(patch, 0) } }
    func closePatch() {
        context = nil
        if patch != 0 {
            typealias Release = @convention(c) (UInt32, UInt32) -> Int32
            _ = try? fn("SLSReleaseWindow", Release.self)(cid, patch); patch = 0
        }
    }
    func pointerWindow(_ point: CGPoint) throws -> UInt32 {
        typealias Find = @convention(c) (UInt32, UInt32, Int32, Int32, UnsafeMutablePointer<CGPoint>, UnsafeMutablePointer<CGPoint>, UnsafeMutablePointer<UInt32>, UnsafeMutablePointer<UInt32>) -> Int32
        var screen = point, local = CGPoint.zero
        var window: UInt32 = 0, owner: UInt32 = 0
        try check(try fn("SLSFindWindowAndOwner", Find.self)(cid, 0, 1, 0, &screen, &local, &window, &owner) == 0, "pointer query failed")
        return window
    }
    func update() throws {
        guard active else { return }
        guard read(AXUIElementCreateApplication(run.targetPID!), "AXFrontmost").1 as? Bool == true else { hide(); return }
        let next = try frame()
        if patch == 0 || next.size != patchFrame.size {
            closePatch()
            typealias Region = @convention(c) (UnsafePointer<CGRect>, UnsafeMutablePointer<UnsafeMutableRawPointer?>) -> Int32
            typealias FreeRegion = @convention(c) (UnsafeMutableRawPointer) -> Void
            typealias New = @convention(c) (UInt32, Int32, Float, Float, UnsafeMutableRawPointer, UnsafeMutablePointer<UInt32>) -> Int32
            typealias Tags = @convention(c) (UInt32, UInt32, UnsafePointer<UInt64>, Int32) -> Int32
            typealias Opaque = @convention(c) (UInt32, UInt32, Bool) -> Int32
            typealias Context = @convention(c) (UInt32, UInt32, CFDictionary?) -> Unmanaged<CGContext>?
            var rect = CGRect(origin: .zero, size: next.size), region: UnsafeMutableRawPointer?
            try check(try fn(cg, "CGSNewRegionWithRect", Region.self)(&rect, &region) == 0 && region != nil, "cover region")
            defer { try? fn(cg, "CGRegionRelease", FreeRegion.self)(region!) }
            try check(try fn("SLSNewWindow", New.self)(cid, 2, Float(next.minX), Float(next.minY), region!, &patch) == 0 && patch != 0, "cover allocation")
            // Shadowless, opaque to pointer events, nonactivating, excluded from cycling.
            var tags: UInt64 = (1 << 3) | (1 << 10) | (1 << 15) | (1 << 16) | (1 << 18)
            try check(try fn("SLSSetWindowTags", Tags.self)(cid, patch, &tags, 64) == 0, "cover tags")
            try check(try fn("SLSSetWindowOpacity", Opaque.self)(cid, patch, true) == 0, "cover opacity")
            context = try fn("SLWindowContextCreate", Context.self)(cid, patch, nil)?.takeRetainedValue()
            guard let context, let palette else { throw Failure("cover drawing context") }
            context.clear(rect)
            context.interpolationQuality = .none
            context.draw(palette, in: rect)
            context.flush()
            typealias Flush = @convention(c) (UInt32, UInt32, UnsafeRawPointer?) -> Int32
            try check(try fn("SLSFlushWindowContentRegion", Flush.self)(cid, patch, nil) == 0, "cover flush")
        } else if next.origin != patchFrame.origin {
            typealias Move = @convention(c) (UInt32, UInt32, UnsafePointer<CGPoint>) -> Int32
            var point = next.origin
            try check(try fn("SLSMoveWindow", Move.self)(cid, patch, &point) == 0, "cover move")
        }
        patchFrame = next
        let top = try pointerWindow(CGPoint(x: next.midX, y: next.midY))
        if top != patch {
            if top != target { hide(); log("cover-occluded", ["otherWindow": top]); return }
            try order(patch, 1, target)
        }
        log("cover-position", ["window": patch, "frame": NSStringFromRect(next)])
    }
    func notify(_ notification: String) {
        log("ax-notification", ["name": notification])
        if notification == "AXUIElementDestroyed" || notification == "AXWindowMiniaturized" { active = false; hide(); return }
        do { try update() } catch { active = false; hide(); log("cover-revoked", ["reason": String(describing: error)]) }
        if notification != "AXMoved" && notification != "AXResized" { settle() }
    }
    func settle() {
        refreshEpoch += 1; let epoch = refreshEpoch
        Task { @MainActor [weak self] in
            for delay in [0.08, 0.12, 0.25] {
                try? await pause(delay)
                guard let self, self.active, self.refreshEpoch == epoch else { return }
                do { try self.update(); self.log("activation-settle", ["epoch": epoch]) }
                catch { self.active = false; self.hide(); self.log("cover-revoked", ["reason": String(describing: error)]); return }
            }
        }
    }
    func setup() async throws {
        typealias Main = @convention(c) () -> UInt32
        cid = try fn("SLSMainConnectionID", Main.self)()
        target = try await run.createExternal()
        guard let window = run.axWindow, let pid = run.targetPID else { throw Failure("target discovery") }
        deadline.bind(pid)
        self.window = window; originalPosition = read(window, "AXPosition").1
        let initial = try bounds(target)
        canvas = CGRect(x: initial.minX - 4, y: initial.minY - 4, width: initial.width + 160, height: initial.height + 130).integral
        try check(CGDisplayBounds(CGMainDisplayID()).contains(canvas), "test canvas must fit main display")
        // Own blank backdrop confines every recorded pixel to disposable research surfaces.
        let cocoa = CGRect(x: canvas.minX, y: NSScreen.screens[0].frame.maxY - canvas.maxY, width: canvas.width, height: canvas.height)
        let back = NSWindow(contentRect: cocoa, styleMask: .borderless, backing: .buffered, defer: false)
        back.isReleasedWhenClosed = false; back.backgroundColor = NSColor(calibratedWhite: 0.12, alpha: 1)
        back.hasShadow = false; back.ignoresMouseEvents = true; back.orderFront(nil); backdrop = back
        try order(UInt32(back.windowNumber), -1, target)
        began = ProcessInfo.processInfo.systemUptime
        log("binding", ["pid": pid, "window": target, "canvas": NSStringFromRect(canvas), "kind": "external compositor cover; native buttons unchanged"])
        let image = try targetPixels("target-baseline"), p = try frame()
        let sx = Double(image.width) / initial.width, sy = Double(image.height) / initial.height
        let sampleX = Int((p.maxX - initial.minX + 4) * sx)
        try check(sampleX + 2 < image.width, "palette sample outside target")
        palette = image.cropping(to: CGRect(x: sampleX, y: Int((p.minY - initial.minY) * sy), width: 1, height: Int(p.height * sy)))
        try check(palette != nil, "palette crop unavailable")
        log("palette", ["sourceColorSpace": image.colorSpace?.name as String? ?? "unknown", "x": sampleX])
        let callback: AXObserverCallback = { _, _, notification, context in
            guard let context else { return }
            MainActor.assumeIsolated { Unmanaged<ExternalCover>.fromOpaque(context).takeUnretainedValue().notify(notification as String) }
        }
        var observer: AXObserver?
        try check(AXObserverCreate(pid, callback, &observer) == .success && observer != nil, "observer allocation")
        self.observer = observer
        for name in ["AXMoved", "AXResized", "AXUIElementDestroyed", "AXWindowMiniaturized"] {
            let result = AXObserverAddNotification(observer!, window, name as CFString, Unmanaged.passUnretained(self).toOpaque())
            log("observer-registration", ["name": name, "result": result.rawValue])
            if name == "AXMoved" || name == "AXResized" { try check(result == .success, "required observer unavailable") }
        }
        for name in ["AXApplicationActivated", "AXApplicationDeactivated", "AXFocusedWindowChanged", "AXMainWindowChanged"] {
            let result = AXObserverAddNotification(observer!, AXUIElementCreateApplication(pid), name as CFString, Unmanaged.passUnretained(self).toOpaque())
            log("observer-registration", ["name": name, "result": result.rawValue])
            try check(result == .success, "required activation/focus observer unavailable")
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer!), .commonModes)
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            let activePID = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
            MainActor.assumeIsolated {
                guard let self, self.active else { return }
                self.log("activation", ["pid": activePID ?? -1])
                if activePID == self.run.targetPID { try? self.update(); self.settle() } else { self.refreshEpoch += 1; self.hide() }
            }
        }
    }
    func hits(_ label: String, expected: UInt32) throws {
        typealias Find = @convention(c) (UInt32, UInt32, Int32, Int32, UnsafeMutablePointer<CGPoint>, UnsafeMutablePointer<CGPoint>, UnsafeMutablePointer<UInt32>, UnsafeMutablePointer<UInt32>) -> Int32
        for rect in try buttons() {
            var screen = CGPoint(x: rect.midX, y: rect.midY), local = CGPoint.zero
            var window: UInt32 = 0, owner: UInt32 = 0
            let result = try fn("SLSFindWindowAndOwner", Find.self)(cid, 0, 1, 0, &screen, &local, &window, &owner)
            log("pointer-target", ["label": label, "result": result, "window": window, "expected": expected, "owner": owner])
            try check(result == 0 && window == expected, "pointer target disagrees")
        }
        if let window {
            let fullscreen = read(window, "AXFullScreen")
            try check(fullscreen.0 == .success && fullscreen.1 as? Bool == false, "window no longer windowed")
            log("windowed", ["label": label, "buttons": try buttons().map(NSStringFromRect)])
        }
    }
    func hold(_ label: String, _ seconds: Double) async throws {
        log("phase", ["label": label]); let end = ProcessInfo.processInfo.systemUptime + seconds
        while ProcessInfo.processInfo.systemUptime < end {
            try await pause(0.12)
            let path = directory.appendingPathComponent(String(format: "screen-%04d.png", frames.count))
            let stamp = ProcessInfo.processInfo.systemUptime - began
            let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            process.arguments = ["-x", "-t", "png", "-R", "\(Int(canvas.minX)),\(Int(canvas.minY)),\(Int(canvas.width)),\(Int(canvas.height))", path.path]
            process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
            try process.run(); process.waitUntilExit()
            try check(process.terminationStatus == 0 && FileManager.default.fileExists(atPath: path.path), "composited screen capture failed")
            frames.append(["seconds": stamp, "file": path.lastPathComponent])
        }
    }
    func experiment() async throws {
        try await setup()
        try hits("baseline", expected: target); try await hold("Baseline — protected app, native controls visible", 2)
        active = true; try update(); try await pause(0.2)
        try hits("covered", expected: patch); _ = try targetPixels("target-under-cover")
        try await hold("Covered externally — native controls remain underneath", 2)
        guard let window, let position = originalPosition else { throw Failure("position missing") }
        var point = CGPoint.zero
        try check(AXValueGetValue(position as! AXValue, .cgPoint, &point), "position decode")
        point.x += 65; point.y += 45
        let moved = AXUIElementSetAttributeValue(window, "AXPosition" as CFString, AXValueCreate(.cgPoint, &point)!)
        log("move-request", ["result": moved.rawValue]); try check(moved == .success, "move rejected")
        try await hold("Moved — cover follows Accessibility notifications", 1.5)
        try hits("moved", expected: patch)
        try run.resizeExternal(); try await hold("Resized — cover follows Accessibility notifications", 1.5)
        try hits("resized", expected: patch)
        let otherDirectory = directory.appendingPathComponent("occluder", isDirectory: true)
        try FileManager.default.createDirectory(at: otherDirectory, withIntermediateDirectories: false)
        let other = VisualRun(name: run.name == "textedit" ? "chrome" : "textedit", directory: otherDirectory)
        other.externalCaption = "Disposable occlusion control for the external-cover experiment."
        occluderRun = other
        _ = try await other.createExternal()
        deadline.bind(other.targetPID)
        try check(read(AXUIElementCreateApplication(run.targetPID!), "AXFrontmost").1 as? Bool == false, "occluder did not deactivate target")
        log("deactivated-confirmed", ["otherPID": other.targetPID!])
        try await hold("Different app in front — cover is withdrawn", 1.5)
        typealias Ordered = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<Bool>) -> Int32
        var visible = true
        let ordered = try fn("SLSWindowIsOrderedIn", Ordered.self)(cid, patch, &visible)
        log("deactivated-cover", ["result": ordered, "visible": visible])
        try check(ordered == 0 && !visible, "cover did not withdraw")
        await other.cleanup(); if let pid = other.targetPID { deadline.release(pid) }; occluderRun = nil
        _ = AXUIElementSetAttributeValue(AXUIElementCreateApplication(run.targetPID!), "AXFrontmost" as CFString, kCFBooleanTrue)
        _ = AXUIElementPerformAction(window, "AXRaise" as CFString)
        try await hold("Browser active again — cover restored", 1.5)
        try hits("reactivated", expected: patch)
        active = false; hide(); run.restoreExternal()
        try check(AXUIElementSetAttributeValue(window, "AXPosition" as CFString, position) == .success, "position restore")
        try await pause(0.3); try hits("restored", expected: target)
        try await hold("Restored — original controls and geometry", 2)
        log("finished", ["frames": frames.count])
    }
    func cleanup() async {
        refreshEpoch += 1
        active = false; closePatch(); occluder?.close(); backdrop?.close()
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes) }
        if let activationObserver { NSWorkspace.shared.notificationCenter.removeObserver(activationObserver) }
        if let occluderRun { await occluderRun.cleanup(); self.occluderRun = nil }
        if let window, let originalPosition { _ = AXUIElementSetAttributeValue(window, "AXPosition" as CFString, originalPosition) }
        try? JSONSerialization.data(withJSONObject: frames, options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent("timestamps.json"))
        await run.cleanup()
        deadline.bind(nil)
        log("cleanup", ["patchReleased": patch == 0, "targetGone": run.targetPID.map { NSRunningApplication(processIdentifier: $0)?.isTerminated != false } ?? true])
    }
}

@main struct CoverMain {
    @MainActor static func main() async {
        setbuf(stdout, nil)
        let args = CommandLine.arguments
        guard let ci = args.firstIndex(of: "--case"), args.count > ci + 1, ["chrome", "edge", "textedit"].contains(args[ci + 1]),
              let oi = args.firstIndex(of: "--output"), args.count > oi + 1 else {
            print("cover --case chrome|edge|textedit --output /absolute/new/directory [--run]"); return
        }
        guard args.contains("--run") else { print("DRY RUN: one disposable protected target app plus a disposable second app for occlusion; own blank backdrop and private opaque cover over three controls; AX move/resize/activation with three bounded activation-settle checks; composited screen crops confined to the test canvas; restore/cleanup. No code loading, original app modification or system changes."); return }
        let directory = URL(fileURLWithPath: args[oi + 1], isDirectory: true)
        do {
            var size = 0; sysctlbyname("kern.osversion", nil, &size, nil, 0)
            var build = [CChar](repeating: 0, count: size); sysctlbyname("kern.osversion", &build, &size, nil, 0)
            try check(String(cString: build) == "25G342" && AXIsProcessTrusted() && CGPreflightScreenCaptureAccess(), "requires checked build and AX/capture access")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
            NSApplication.shared.setActivationPolicy(.accessory); NSApplication.shared.finishLaunching()
            let run = VisualRun(name: args[ci + 1], directory: directory)
            run.externalCaption = "An external private-API surface covers the native controls. No code is loaded into this protected browser."
            let deadline = CoverDeadline()
            DispatchQueue.global().asyncAfter(deadline: .now() + 50) { deadline.expire() }
            let cover = ExternalCover(run, directory, deadline)
            do { try await cover.experiment(); await cover.cleanup() }
            catch { cover.log("failure", ["reason": String(describing: error)]); await cover.cleanup(); exit(2) }
        } catch { print("REFUSED: \(error)"); exit(2) }
    }
}
