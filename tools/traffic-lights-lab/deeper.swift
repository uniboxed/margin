// Isolated cross-process research. Only this executable's own child window is affected.
import AppKit
import ApplicationServices
import ImageIO
import Darwin
import ObjectiveC.runtime

@_silgen_name("margin_wire_clip") private func wireClip(_ connection: UInt32, _ window: UInt32, _ region: UnsafeMutableRawPointer) -> Int32

setbuf(stdout, nil)
let args = CommandLine.arguments
func emit(_ row: [String: Any]) { print(String(decoding: try! JSONSerialization.data(withJSONObject: row, options: .sortedKeys), as: UTF8.self)) }
guard args.contains("--run") || args.contains("--child") else {
    emit(["plan": "One visible owned child window. Default: AX bundle request and owner/foreign clipping (--wire selects direct message). --buttons instead tests private button-region metadata with owner/foreign empty/sentinel regions, native-hide pixel positive control, window rights/proxy readback, restoration and cleanup. Add --proxy-clips for matched owner/foreign local/global clips with a retained foreign proxy and verified restoration. No browser, user window or system setting changed."]); exit(0)
}
var buildSize = 0; sysctlbyname("kern.osversion", nil, &buildSize, nil, 0)
var build = [CChar](repeating: 0, count: buildSize); sysctlbyname("kern.osversion", &build, &buildSize, nil, 0)
guard String(cString: build) == "25G342", AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else { emit(["refused": "requires 25G342 plus AX/recording access"]); exit(2) }
DispatchQueue.global().asyncAfter(deadline: .now() + 35) { _exit(3) }
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.finishLaunching()
let sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)!
let cg = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW)!
let ax = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_NOW)!
func fn<T>(_ handle: UnsafeMutableRawPointer, _ name: String, _ type: T.Type) -> T {
    guard let symbol = dlsym(handle, name) else { emit(["refusedSymbol": name]); exit(2) }
    return unsafeBitCast(symbol, to: type)
}
typealias Main = @convention(c) () -> UInt32
typealias NewRegion = @convention(c) (UnsafePointer<CGRect>, UnsafeMutablePointer<UnsafeMutableRawPointer?>) -> Int32
typealias Release = @convention(c) (UnsafeMutableRawPointer) -> Void
typealias Create = @convention(c) (UInt32) -> Unmanaged<CFTypeRef>?
typealias GlobalClip = @convention(c) (CFTypeRef, UInt32, UnsafeMutableRawPointer) -> Void
typealias Commit = @convention(c) (CFTypeRef, Int32) -> Void
let cid = fn(sky, "SLSMainConnectionID", Main.self)()
typealias LegacyButtons = @convention(c) (UInt32) -> UnsafeMutableRawPointer?
typealias EmptyRegion = @convention(c) () -> UnsafeMutableRawPointer?
typealias CopyRegion = @convention(c) (UnsafeMutableRawPointer) -> UnsafeMutableRawPointer?
var keptProxies: [UInt32: AnyObject] = [:]
func buttonMetadata(_ wid: UInt32) -> [String: Any] {
    guard let region = fn(sky, "SLSGetButtonRegionLegacy", LegacyButtons.self)(wid) else { return ["present": false] }
    typealias RegionBounds = @convention(c) (UnsafeMutableRawPointer, UnsafeMutablePointer<CGRect>) -> Int32
    var rect = CGRect.zero
    let result = fn(cg, "CGSGetRegionBounds", RegionBounds.self)(region, &rect)
    return ["present": true, "boundsResult": result, "bounds": NSStringFromRect(rect)]
}
func windowRights(_ wid: UInt32) -> [String: Any] {
    typealias Rights = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>, UnsafeMutablePointer<UInt32>, UnsafeMutablePointer<UInt32>) -> Int32
    var a: UInt32 = 0, b: UInt32 = 0, c: UInt32 = 0
    let result = fn(sky, "SLSConnectionGetHeldWindowRights", Rights.self)(cid, wid, &a, &b, &c)
    return ["result": result, "rawOutputs": [a, b, c]]
}
func proxy(_ wid: UInt32) -> [String: Any] {
    guard let cls = NSClassFromString("NSCGSWindow"), let method = class_getClassMethod(cls, NSSelectorFromString("windowWithWindowID:")) else { return ["available": false] }
    let encoding = String(cString: method_getTypeEncoding(method)!)
    guard encoding == "@20@0:8I16" else { return ["available": true, "encoding": encoding, "refusedABI": true] }
    typealias Lookup = @convention(c) (AnyObject, Selector, UInt32) -> Unmanaged<AnyObject>?
    let object = unsafeBitCast(method_getImplementation(method), to: Lookup.self)(cls as AnyObject, NSSelectorFromString("windowWithWindowID:"), wid)?.takeUnretainedValue()
    if let object { keptProxies[wid] = object }
    return ["available": true, "encoding": encoding, "created": object != nil]
}
func setButtons(_ wid: UInt32, region: UnsafeMutableRawPointer?) {
    typealias Set = @convention(c) (CFTypeRef, UInt32, UnsafeMutableRawPointer?) -> Void
    guard let transaction = fn(sky, "SLSTransactionCreate", Create.self)(cid)?.takeRetainedValue() else { exit(2) }
    fn(sky, "SLSTransactionSetWindowButtonRegion", Set.self)(transaction, wid, region)
    fn(sky, "SLSTransactionCommit", Commit.self)(transaction, 1)
}
func apply(_ wid: UInt32, _ rect: CGRect) {
    var rect = rect, region: UnsafeMutableRawPointer?
    guard fn(cg, "CGSNewRegionWithRect", NewRegion.self)(&rect, &region) == 0, let region,
          let transaction = fn(sky, "SLSTransactionCreate", Create.self)(cid)?.takeRetainedValue() else { exit(2) }
    defer { fn(cg, "CGRegionRelease", Release.self)(region) }
    if args.contains("--wire") {
        emit(["wireSend": wireClip(cid, wid, region), "window": wid]); return
    }
    fn(sky, "SLSTransactionSetWindowGlobalClipShape", GlobalClip.self)(transaction, wid, region)
    fn(sky, "SLSTransactionCommit", Commit.self)(transaction, 1)
}
func saveJSON(_ row: [String: Any], _ path: URL) { try! JSONSerialization.data(withJSONObject: row, options: [.prettyPrinted, .sortedKeys]).write(to: path, options: .atomic) }
func waitJSON(_ path: URL, seconds: Double) -> [String: Any]? {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
        if let data = try? Data(contentsOf: path), let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { return row }
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    return nil
}
guard let oi = args.firstIndex(of: "--output"), args.count > oi + 1 else { emit(["refused": "--output directory required"]); exit(2) }
let directory = URL(fileURLWithPath: args[oi + 1], isDirectory: true)

if args.contains("--child") {
    let window = NSWindow(contentRect: NSRect(x: 180, y: 180, width: 680, height: 420),
        styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false; window.title = "Owned deeper-API fixture — windowed"
    window.contentView!.wantsLayer = true; window.contentView!.layer!.backgroundColor = NSColor.systemTeal.cgColor
    let label = NSTextField(labelWithString: "Owned cross-process research fixture\nNo browser or user window is modified")
    label.font = .systemFont(ofSize: 23, weight: .semibold); label.frame = NSRect(x: 35, y: 220, width: 610, height: 100)
    window.contentView!.addSubview(label)
    window.makeKeyAndOrderFront(nil); NSApplication.shared.activate()
    let wid = UInt32(window.windowNumber)
    var originalButtons: UnsafeMutableRawPointer?
    typealias CopyClip = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UnsafeMutableRawPointer?>) -> Int32
    typealias ClientClip = @convention(c) (UInt32, UInt32, UnsafeMutableRawPointer?) -> Int32
    var originalClip: UnsafeMutableRawPointer?
    if args.contains("--buttons") {
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        if let value = fn(sky, "SLSGetButtonRegionLegacy", LegacyButtons.self)(wid) { originalButtons = fn(cg, "CGRegionCreateCopy", CopyRegion.self)(value) }
    }
    typealias Bounds = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<CGRect>) -> Int32
    var bounds = CGRect.zero
    let geometryDeadline = Date().addingTimeInterval(2)
    repeat {
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        bounds = .zero
        _ = fn(sky, "SLSGetWindowBounds", Bounds.self)(cid, wid, &bounds)
    } while (bounds.width <= 0 || bounds.height <= 0) && Date() < geometryDeadline
    guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0,
          abs(bounds.width - window.frame.width) < 1, abs(bounds.height - window.frame.height) < 1 else {
        saveJSON(["refused": "positive native geometry did not agree", "privateBounds": NSStringFromRect(bounds), "appKit": NSStringFromRect(window.frame)], directory.appendingPathComponent("ready.json"))
        window.close(); exit(2)
    }
    if args.contains("--proxy-clips") {
        typealias RegionBounds = @convention(c) (UnsafeMutableRawPointer, UnsafeMutablePointer<CGRect>) -> Int32
        let deadline = Date().addingTimeInterval(2)
        var valid = false
        repeat {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            if let previous = originalClip { fn(cg, "CGRegionRelease", Release.self)(previous) }; originalClip = nil
            if fn(sky, "SLSCopyWindowClipShape", CopyClip.self)(cid, wid, &originalClip) == 0, let clip = originalClip {
                var rect = CGRect.zero
                valid = fn(cg, "CGSGetRegionBounds", RegionBounds.self)(clip, &rect) == 0 && rect.width > 0 && rect.height > 0 &&
                    abs(rect.width - bounds.width) < 1 && abs(rect.height - bounds.height) < 1
            }
        } while !valid && Date() < deadline
        guard valid else { emit(["refused": "saved clip did not match settled full window"]); window.close(); exit(2) }
    }
    func snapshot() -> [String: Any] {
        let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].map { type -> [String: Any] in
            let b = window.standardWindowButton(type)!
            return ["type": type.rawValue, "hidden": b.isHiddenOrHasHiddenAncestor, "alpha": b.alphaValue, "enabled": b.isEnabled,
                    "hit": b.superview?.hitTest(NSPoint(x: b.frame.midX, y: b.frame.midY)) === b]
        }
        return ["window": wid, "pid": getpid(), "bounds": [bounds.minX, bounds.minY, bounds.width, bounds.height],
                "windowed": !window.styleMask.contains(.fullScreen), "buttons": buttons,
                "buttonRegion": buttonMetadata(wid), "windowRights": windowRights(wid),
                "bundles": (Bundle.allBundles + Bundle.allFrameworks).compactMap { $0.bundleIdentifier }.sorted()]
    }
    saveJSON(snapshot(), directory.appendingPathComponent("ready.json"))
    let deadline = Date().addingTimeInterval(27)
    while Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        let request = directory.appendingPathComponent("request.json")
        guard let data = try? Data(contentsOf: request), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let name = command["name"] as? String else { continue }
        try? FileManager.default.removeItem(at: request)
        if name == "buttons-empty", let empty = fn(cg, "CGRegionCreateEmptyRegion", EmptyRegion.self)() {
            setButtons(wid, region: empty); fn(cg, "CGRegionRelease", Release.self)(empty)
        }
        if name == "buttons-sentinel" {
            var rect = CGRect(x: 0, y: 0, width: 4, height: 4), region: UnsafeMutableRawPointer?
            guard fn(cg, "CGSNewRegionWithRect", NewRegion.self)(&rect, &region) == 0, let region else { exit(2) }
            setButtons(wid, region: region); fn(cg, "CGRegionRelease", Release.self)(region)
        }
        if name == "buttons-restore" { setButtons(wid, region: originalButtons) }
        if name == "client-clip" {
            var rect = CGRect(x: 0, y: 50, width: window.frame.width, height: window.frame.height - 50), region: UnsafeMutableRawPointer?
            guard fn(cg, "CGSNewRegionWithRect", NewRegion.self)(&rect, &region) == 0, let region else { exit(2) }
            emit(["ownerClientClip": fn(sky, "SLSSetWindowClipShape", ClientClip.self)(cid, wid, region)])
            fn(cg, "CGRegionRelease", Release.self)(region)
        }
        if name == "client-restore" { emit(["ownerClientRestore": fn(sky, "SLSSetWindowClipShape", ClientClip.self)(cid, wid, originalClip)]) }
        if name == "native-hide" || name == "native-restore" {
            let selector = NSSelectorFromString("_setHidden:setNeedsDisplay:")
            typealias Hide = @convention(c) (AnyObject, Selector, Bool, Bool) -> Void
            for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
                let button = window.standardWindowButton(kind)!
                guard let method = class_getInstanceMethod(type(of: button), selector), String(cString: method_getTypeEncoding(method)!) == "v24@0:8B16B20" else { exit(2) }
                unsafeBitCast(method_getImplementation(method), to: Hide.self)(button, selector, name == "native-hide", true)
            }
        }
        if name == "proxy" { emit(["ownerProxy": proxy(wid)]) }
        if name == "owner-global" { apply(wid, bounds.insetBy(dx: 0, dy: bounds.height / 4)) }
        if name == "owner-local" { apply(wid, CGRect(x: 0, y: bounds.height / 4, width: bounds.width, height: bounds.height / 2)) }
        if name == "owner-full" { apply(wid, bounds) }
        if name == "owner-region", let coordinates = command["rect"] as? [Double], coordinates.count == 4 {
            apply(wid, CGRect(x: coordinates[0], y: coordinates[1], width: coordinates[2], height: coordinates[3]))
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.15))
        saveJSON(snapshot(), directory.appendingPathComponent("response.json"))
        if name == "quit" { window.close(); exit(0) }
    }
    window.close(); exit(3)
}

guard !FileManager.default.fileExists(atPath: directory.path) else { emit(["refused": "output exists; preserve earlier evidence"]); exit(2) }
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
let former = NSWorkspace.shared.frontmostApplication?.processIdentifier
let child = Process()
child.executableURL = URL(fileURLWithPath: args[0]).standardizedFileURL
child.arguments = ["--child", "--output", directory.path] + ["--wire", "--buttons", "--proxy-clips"].filter { args.contains($0) }
try child.run()
func finish(_ code: Int32) -> Never {
    if child.isRunning { child.terminate(); child.waitUntilExit() }
    if let former, former != getpid() { _ = AXUIElementSetAttributeValue(AXUIElementCreateApplication(former), "AXFrontmost" as CFString, kCFBooleanTrue) }
    emit(["cleanup": true, "childRunning": child.isRunning, "exit": code]); exit(code)
}
guard let initial = waitJSON(directory.appendingPathComponent("ready.json"), seconds: 5),
      let wid = initial["window"] as? UInt32, initial["pid"] as? pid_t == child.processIdentifier,
      let components = initial["bounds"] as? [Double], components.count == 4 else { emit(["refused": "child discovery"]); finish(2) }
let bounds = CGRect(x: components[0], y: components[1], width: components[2], height: components[3])
typealias Owner = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>) -> Int32
typealias PID = @convention(c) (UInt32, UnsafeMutablePointer<pid_t>) -> Int32
var owner: UInt32 = 0, ownerPID: pid_t = 0
guard fn(sky, "SLSGetWindowOwner", Owner.self)(cid, wid, &owner) == 0,
      fn(sky, "SLSConnectionGetPID", PID.self)(owner, &ownerPID) == 0, ownerPID == child.processIdentifier else { finish(2) }
func request(_ name: String, rect: CGRect? = nil) -> [String: Any] {
    try? FileManager.default.removeItem(at: directory.appendingPathComponent("response.json"))
    var command: [String: Any] = ["name": name]
    if let rect { command["rect"] = [rect.minX, rect.minY, rect.width, rect.height] }
    saveJSON(command, directory.appendingPathComponent("request.json"))
    guard let response = waitJSON(directory.appendingPathComponent("response.json"), seconds: 2) else { emit(["refused": "child request timeout", "name": name]); finish(2) }
    return response
}
typealias Capture = @convention(c) (UInt32, UnsafePointer<UInt32>, Int32, UInt32) -> Unmanaged<CFArray>?
let capture = fn(sky, "SLSHWCaptureWindowList", Capture.self)
func observe(_ name: String) -> [String: Any] {
    let native = request("snapshot")
    var id = wid
    guard let images = capture(cid, &id, 1, 0x0200)?.takeRetainedValue(), CFArrayGetCount(images) == 1 else { emit(["refused": "capture unavailable"]); finish(2) }
    let image = unsafeBitCast(CFArrayGetValueAtIndex(images, 0), to: CGImage.self)
    let png = directory.appendingPathComponent(name + ".png")
    guard let target = CGImageDestinationCreateWithURL(png as CFURL, "public.png" as CFString, 1, nil) else { finish(2) }
    CGImageDestinationAddImage(target, image, nil)
    guard CGImageDestinationFinalize(target) else { finish(2) }
    let bitmap = NSBitmapImageRep(cgImage: image)
    var transparent = 0, count = 0
    for y in stride(from: 10, to: bitmap.pixelsHigh, by: 12) {
        for x in stride(from: 10, to: bitmap.pixelsWide, by: 12) { count += 1; if (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) < 0.5 { transparent += 1 } }
    }
    let row: [String: Any] = ["stage": name, "native": native, "image": ["width": image.width, "height": image.height, "transparentSamples": transparent, "samples": count]]
    saveJSON(row, directory.appendingPathComponent(name + ".json")); emit(row)
    return row
}
_ = observe("baseline")
if args.contains("--buttons") {
    emit(["foreignRights": windowRights(wid), "foreignProxy": proxy(wid)])
    emit(["foreignRightsAfterRetainedProxy": windowRights(wid)])
    _ = request("proxy")
    for name in ["buttons-empty", "buttons-restore", "buttons-sentinel", "buttons-restore"] {
        _ = request(name); _ = observe("owner-" + name + (name == "buttons-restore" ? "-\(UUID().uuidString)" : ""))
    }
    if let empty = fn(cg, "CGRegionCreateEmptyRegion", EmptyRegion.self)() {
        setButtons(wid, region: empty); _ = observe("foreign-buttons-empty")
        fn(cg, "CGRegionRelease", Release.self)(empty)
    }
    var rect = CGRect(x: 0, y: 0, width: 4, height: 4), sentinel: UnsafeMutableRawPointer?
    guard fn(cg, "CGSNewRegionWithRect", NewRegion.self)(&rect, &sentinel) == 0, let sentinel else { finish(2) }
    setButtons(wid, region: sentinel); _ = observe("foreign-buttons-sentinel")
    fn(cg, "CGRegionRelease", Release.self)(sentinel)
    _ = request("buttons-restore"); _ = observe("restored-buttons")
    if args.contains("--proxy-clips") {
        _ = request("client-clip"); _ = observe("owner-client-clip")
        _ = request("client-restore"); let restored = observe("owner-client-restored")["image"] as! [String: Int]
        guard restored["width"] == Int(bounds.width) && restored["height"] == Int(bounds.height) && restored["transparentSamples"] == 0 else { emit(["refused": "owner restore failed; no foreign clipping attempted"]); finish(2) }
        typealias ClientClip = @convention(c) (UInt32, UInt32, UnsafeMutableRawPointer?) -> Int32
        var local = CGRect(x: 0, y: 50, width: bounds.width, height: bounds.height - 50), region: UnsafeMutableRawPointer?
        guard fn(cg, "CGSNewRegionWithRect", NewRegion.self)(&local, &region) == 0, let region else { finish(2) }
        emit(["foreignClientClipAfterProxy": fn(sky, "SLSSetWindowClipShape", ClientClip.self)(cid, wid, region)])
        _ = observe("foreign-client-clip-after-proxy")
        fn(cg, "CGRegionRelease", Release.self)(region)
        _ = request("client-restore"); _ = observe("foreign-client-restored")
        _ = request("owner-region", rect: bounds.insetBy(dx: 0, dy: bounds.height / 4)); _ = observe("owner-global-control-after-proxy")
        _ = request("owner-region", rect: CGRect(x: -10000, y: -10000, width: 20000, height: 20000)); _ = observe("owner-global-control-restored")
        apply(wid, bounds.insetBy(dx: 0, dy: bounds.height / 4))
        _ = observe("foreign-global-clip-after-proxy")
        _ = request("owner-region", rect: CGRect(x: -10000, y: -10000, width: 20000, height: 20000))
        _ = request("client-restore"); _ = observe("foreign-global-restored")
    }
    _ = request("native-hide"); _ = observe("native-hidden-control")
    _ = request("native-restore"); _ = observe("native-restored-control")
    _ = request("quit"); child.waitUntilExit(); finish(child.terminationStatus)
}
typealias LoadAX = @convention(c) (AXUIElement) -> Int32
let application = AXUIElementCreateApplication(child.processIdentifier)
AXUIElementSetMessagingTimeout(application, 0.5)
let loaded = fn(ax, "_AXUIElementLoadAccessibilityBundles", LoadAX.self)(application)
emit(["axBundleRequest": loaded])
let afterLoad = observe("after-ax-load")
let beforeBundles = Set(initial["bundles"] as? [String] ?? [])
let afterBundles = Set((afterLoad["native"] as? [String: Any])?["bundles"] as? [String] ?? [])
emit(["loadedBundleDifference": Array(afterBundles.subtracting(beforeBundles)).sorted()])
// Restore to a broad region on this disposable fixture only; verify pixels after every attempt.
let wide = CGRect(x: -10000, y: -10000, width: 20000, height: 20000)
let scale = NSScreen.main?.backingScaleFactor ?? 1
let backing = CGRect(x: bounds.minX * scale, y: bounds.minY * scale, width: bounds.width * scale, height: bounds.height * scale)
let candidates: [(String, CGRect)] = [
    ("logical-screen", bounds.insetBy(dx: 0, dy: bounds.height / 4)),
    ("backing-screen", backing.insetBy(dx: 0, dy: backing.height / 4)),
    ("backing-window", CGRect(x: 0, y: backing.height / 4, width: backing.width, height: backing.height / 2))
]
var proven: (String, CGRect)?
for (name, rect) in candidates {
    _ = request("owner-region", rect: rect)
    let row = observe("owner-" + name)
    let image = row["image"] as! [String: Int]
    _ = request("owner-region", rect: wide)
    let restored = observe("restored-" + name)["image"] as! [String: Int]
    guard restored["transparentSamples"]! < restored["samples"]! / 50 else {
        emit(["invalidControl": "restoration failed; foreign test skipped", "candidate": name]); _ = request("quit"); finish(2)
    }
    let ratio = Double(image["transparentSamples"]!) / Double(image["samples"]!)
    if ratio > 0.1 && ratio < 0.9 { proven = (name, rect); break }
}
if let (name, rect) = proven {
    emit(["provenCoordinates": name, "rect": [rect.minX, rect.minY, rect.width, rect.height], "scale": scale])
    apply(wid, rect); _ = observe("foreign-global")
    apply(wid, wide)
    _ = request("owner-region", rect: wide); _ = observe("foreign-restored")
} else { emit(["inconclusive": "no partially clipped owner control; foreign test skipped"]) }
_ = request("quit")
child.waitUntilExit()
finish(child.terminationStatus)
