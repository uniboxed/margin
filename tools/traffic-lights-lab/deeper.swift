// Isolated cross-process research. Only this executable's own child window is affected.
import AppKit
import ApplicationServices
import ImageIO
import Darwin
import ObjectiveC.runtime

@_silgen_name("margin_wire_clip") private func wireClip(_ connection: UInt32, _ window: UInt32, _ region: UnsafeMutableRawPointer) -> Int32
@_silgen_name("_AXUIElementGetWindow") private func axWindowNumber(_ element: AXUIElement, _ number: UnsafeMutablePointer<UInt32>) -> AXError

setbuf(stdout, nil)
let args = CommandLine.arguments
func emit(_ row: [String: Any]) { print(String(decoding: try! JSONSerialization.data(withJSONObject: row, options: .sortedKeys), as: UTF8.self)) }
guard args.contains("--run") || args.contains("--child") else {
    emit(["plan": "One visible owned child window. --launch-observe --corners observes startup/AX resize/restore only; --override-corners adds private NSConvolutionOverride1/2=0.01 only to child launch arguments. No preferences written. Other modes: --buttons, --proxy-clips, --corners, --corner-mask/--storage-control. Saves actual pixels and cleans up. No browser, user window or system setting changed."]); exit(0)
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
func cornerMaskMetadata(_ wid: UInt32) -> [String: Any] {
    typealias CopyMask = @convention(c) (UInt32, UnsafeMutablePointer<UInt32>, UnsafeMutablePointer<CGRect>) -> Unmanaged<CGImage>?
    var flags: UInt32 = 0, center = CGRect.zero
    guard let mask = fn(sky, "SLSCopyWindowCornerMask", CopyMask.self)(wid, &flags, &center)?.takeRetainedValue() else { return ["present": false] }
    var samplesBelow128 = -1
    if mask.bitsPerPixel == 8, mask.isMask || mask.alphaInfo == .alphaOnly, let data = mask.dataProvider?.data {
        let bytes = CFDataGetBytePtr(data)!
        samplesBelow128 = (0..<mask.height).reduce(0) { total, y in total + (0..<mask.width).filter { bytes[y * mask.bytesPerRow + $0] < 128 }.count }
    }
    return ["present": true, "width": mask.width, "height": mask.height, "flags": flags,
            "center": NSStringFromRect(center), "samplesBelow128": samplesBelow128, "bitsPerPixel": mask.bitsPerPixel,
            "isMask": mask.isMask, "alphaInfo": mask.alphaInfo.rawValue]
}
func directCornerMask(_ wid: UInt32, image: Bool) -> Int32 {
    typealias SetMask = @convention(c) (UInt32, CGImage?, UInt32, CGRect) -> Int32
    var mask: CGImage?
    if image {
        guard let context = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 256,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(2) }
        context.setFillColor(gray: 1, alpha: 1)
        context.addPath(CGPath(roundedRect: CGRect(x: 0, y: 0, width: 64, height: 64), cornerWidth: 24, cornerHeight: 24, transform: nil))
        context.fillPath(); mask = context.makeImage()
        guard mask != nil else { exit(2) }
    }
    // Current AppKit uses flags 0xf for an image defining the corner/shadow shape.
    return fn(sky, "SLSSetWindowCornerMask", SetMask.self)(wid, mask, image ? 0xf : 0,
        image ? CGRect(x: 0.375, y: 0.375, width: 0.25, height: 0.25) : .null)
}
func prepareCornerImage(_ wid: UInt32) {
    typealias Clear = @convention(c) (CFTypeRef, UInt32) -> Void
    typealias Path = @convention(c) (CFTypeRef, UInt32, CGPath?) -> Void
    guard let transaction = fn(sky, "SLSTransactionCreate", Create.self)(cid)?.takeRetainedValue() else { exit(2) }
    for name in ["SLSTransactionClearWindowCornerRadius", "SLSTransactionClearWindowSystemCornerRadius"] {
        fn(sky, name, Clear.self)(transaction, wid)
    }
    fn(sky, "SLSTransactionSetWindowBoundsPath", Path.self)(transaction, wid, nil)
    fn(sky, "SLSTransactionCommit", Commit.self)(transaction, 1)
}
func setCornerRadius(_ wid: UInt32, _ radius: Double) {
    typealias Radius = @convention(c) (CFTypeRef, UInt32, Double) -> Void
    typealias Path = @convention(c) (CFTypeRef, UInt32, CGPath?) -> Void
    typealias Mask = @convention(c) (CFTypeRef, UInt32, CGImage?, UInt32, CGRect) -> Void
    guard let transaction = fn(sky, "SLSTransactionCreate", Create.self)(cid)?.takeRetainedValue() else { exit(2) }
    fn(sky, "SLSTransactionSetWindowBoundsPath", Path.self)(transaction, wid, nil)
    fn(sky, "SLSTransactionSetWindowCornerMask", Mask.self)(transaction, wid, nil, 0, .null)
    fn(sky, "SLSTransactionSetWindowCornerRadius", Radius.self)(transaction, wid, radius)
    fn(sky, "SLSTransactionSetWindowSystemCornerRadius", Radius.self)(transaction, wid, radius)
    fn(sky, "SLSTransactionCommit", Commit.self)(transaction, 1)
}
func setSystemCornerRadiusOnly(_ wid: UInt32, _ radius: Double) {
    typealias Radius = @convention(c) (CFTypeRef, UInt32, Double) -> Void
    guard let transaction = fn(sky, "SLSTransactionCreate", Create.self)(cid)?.takeRetainedValue() else { exit(2) }
    fn(sky, "SLSTransactionSetWindowSystemCornerRadius", Radius.self)(transaction, wid, radius)
    fn(sky, "SLSTransactionCommit", Commit.self)(transaction, 1)
}
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
    func nativeRadius(_ value: Double? = nil) -> Double {
        let selector = NSSelectorFromString(value == nil ? "_cornerRadius" : "_setCornerRadius:")
        guard let method = class_getInstanceMethod(type(of: window), selector) else { exit(2) }
        let encoding = String(cString: method_getTypeEncoding(method)!)
        if let value {
            guard encoding == "v24@0:8d16" else { emit(["refusedCornerABI": encoding]); exit(2) }
            typealias Set = @convention(c) (AnyObject, Selector, Double) -> Void
            unsafeBitCast(method_getImplementation(method), to: Set.self)(window, selector, value)
            return value
        }
        guard encoding == "d16@0:8" else { emit(["refusedCornerABI": encoding]); exit(2) }
        typealias Get = @convention(c) (AnyObject, Selector) -> Double
        return unsafeBitCast(method_getImplementation(method), to: Get.self)(window, selector)
    }
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    let originalRadius = args.contains("--corners") || args.contains("--corner-mask") ? nativeRadius() : 0
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
        var liveBounds = bounds
        if args.contains("--launch-observe") { _ = fn(sky, "SLSGetWindowBounds", Bounds.self)(cid, wid, &liveBounds) }
        let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].map { type -> [String: Any] in
            let b = window.standardWindowButton(type)!
            return ["type": type.rawValue, "hidden": b.isHiddenOrHasHiddenAncestor, "alpha": b.alphaValue, "enabled": b.isEnabled,
                    "hit": b.superview?.hitTest(NSPoint(x: b.frame.midX, y: b.frame.midY)) === b]
        }
        return ["window": wid, "pid": getpid(), "bounds": [liveBounds.minX, liveBounds.minY, liveBounds.width, liveBounds.height],
                "windowed": !window.styleMask.contains(.fullScreen), "buttons": buttons,
                "buttonRegion": buttonMetadata(wid), "windowRights": windowRights(wid),
                "nativeCornerRadius": args.contains("--corners") || args.contains("--corner-mask") ? nativeRadius() : -1,
                "cornerMask": args.contains("--corner-mask") ? cornerMaskMetadata(wid) : [:],
                "bundles": (Bundle.allBundles + Bundle.allFrameworks).compactMap { $0.bundleIdentifier }.sorted()]
    }
    saveJSON(snapshot(), directory.appendingPathComponent("ready.json"))
    let deadline = Date().addingTimeInterval(27)
    while Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        let request = directory.appendingPathComponent("request.json")
        guard let data = try? Data(contentsOf: request), let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let name = command["name"] as? String else { continue }
        try? FileManager.default.removeItem(at: request)
        if name == "mask-prepare" { prepareCornerImage(wid) }
        if name == "mask-image" || name == "mask-clear" {
            emit(["ownerDirectMaskSend": directCornerMask(wid, image: name == "mask-image"), "operation": name])
        }
        if name == "corner-native-zero" { _ = nativeRadius(0) }
        if name == "system-zero" { setSystemCornerRadiusOnly(wid, 0) }
        if name == "system-large" { setSystemCornerRadiusOnly(wid, 32) }
        if name == "corner-native-small" { _ = nativeRadius(0.01) }
        if name == "corner-zero" { setCornerRadius(wid, 0) }
        if name == "corner-large" { setCornerRadius(wid, 32) }
        if name == "corner-restore" { _ = nativeRadius(originalRadius); setCornerRadius(wid, originalRadius) }
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
child.arguments = ["--child", "--output", directory.path] + ["--wire", "--buttons", "--proxy-clips", "--corners", "--corner-mask", "--system-only", "--launch-observe"].filter { args.contains($0) }
if args.contains("--override-corners") {
    child.arguments! += ["-NSConvolutionOverride1", "0.01", "-NSConvolutionOverride2", "0.01"]
}
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
    var imageInfo: [String: Any] = ["width": image.width, "height": image.height, "transparentSamples": transparent, "samples": count]
    if args.contains("--corner-mask") {
        imageInfo["transparentCornerPixels"] = [(0, 0), (image.width-40, 0), (0, image.height-40), (image.width-40, image.height-40)].map { x0, y0 in
            (y0..<(y0+40)).reduce(0) { total, y in total + (x0..<(x0+40)).filter { (bitmap.colorAt(x: $0, y: y)?.alphaComponent ?? 0) < 0.5 }.count }
        }
    }
    let row: [String: Any] = ["stage": name, "native": native, "image": imageInfo]
    saveJSON(row, directory.appendingPathComponent(name + ".json")); emit(row)
    return row
}
let baseline = observe("baseline")
if args.contains("--launch-observe") {
    var value: CFTypeRef?
    let app = AXUIElementCreateApplication(child.processIdentifier)
    guard AXUIElementCopyAttributeValue(app, "AXWindows" as CFString, &value) == .success,
          let windows = value as? [AXUIElement], let target = windows.first(where: { window in
              var number: UInt32 = 0; return axWindowNumber(window, &number) == .success && number == wid
          }) else { emit(["refused": "exact AX fixture window not found"]); finish(2) }
    for (name, size) in [("resized", CGSize(width: bounds.width + 80, height: bounds.height + 40)),
                         ("size-restored", bounds.size)] {
        var size = size
        guard let axSize = AXValueCreate(.cgSize, &size), AXUIElementSetAttributeValue(target, "AXSize" as CFString, axSize) == .success else { emit(["refused": "AX resize failed"]); finish(2) }
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        let row = observe(name), actual = (row["native"] as! [String: Any])["bounds"] as! [Double]
        guard abs(actual[2] - size.width) < 1, abs(actual[3] - size.height) < 1 else { emit(["refused": "resize readback mismatch"]); finish(2) }
    }
    _ = request("quit"); child.waitUntilExit(); finish(child.terminationStatus)
}
if args.contains("--corner-mask") {
    guard (initial["cornerMask"] as? [String: Any])?["present"] as? Bool == false else { emit(["refused": "fixture already has image mask"]); finish(2) }
    _ = request("mask-prepare"); let prepared = observe("owner-prepared-image-path")
    _ = request("mask-image"); let positive = observe("owner-mask-image")
    let before = (prepared["image"] as! [String: Any])["transparentCornerPixels"] as! [Int]
    let changed = (positive["image"] as! [String: Any])["transparentCornerPixels"] as! [Int]
    let mask = (positive["native"] as! [String: Any])["cornerMask"] as! [String: Any]
    let storageControl = args.contains("--storage-control")
    emit(["controlKind": storageControl ? "nonuniform stored image mask; no content rendering claim" : "content corner pixels"])
    guard (storageControl || zip(changed, before).allSatisfy({ $0 > $1 + 20 })),
          mask["present"] as? Bool == true, mask["width"] as? Int == 64, mask["height"] as? Int == 64,
          !storageControl || ((mask["samplesBelow128"] as? Int ?? -1) > 100 && (mask["samplesBelow128"] as? Int ?? 4096) < 4000) else {
        emit(["refused": "owner mask had no positive pixel effect; foreign test skipped"]); finish(2)
    }
    emit(["foreignDirectMaskSend": directCornerMask(wid, image: false), "operation": "clear"])
    _ = observe("foreign-clear-owner-mask")
    _ = request("mask-clear"); let restored = observe("owner-mask-cleared")
    guard ((restored["image"] as! [String: Any])["transparentCornerPixels"] as! [Int]) == before else { emit(["refused": "owner restoration failed"]); finish(2) }
    emit(["foreignDirectMaskSend": directCornerMask(wid, image: true), "operation": "image"])
    _ = observe("foreign-mask-image")
    emit(["foreignDirectMaskSend": directCornerMask(wid, image: false), "operation": "clear"])
    _ = observe("foreign-mask-cleared")
    _ = request("mask-clear"); _ = request("corner-restore"); _ = observe("final-mask-restored")
    _ = request("quit"); child.waitUntilExit(); finish(child.terminationStatus)
}
if args.contains("--corners") {
    if args.contains("--system-only") {
        for name in ["system-zero", "system-large"] { _ = request(name); _ = observe("owner-" + name) }
        _ = request("corner-large"); _ = observe("owner-corner-large-control")
        _ = request("corner-restore"); _ = observe("owner-corner-restored-control")
        setSystemCornerRadiusOnly(wid, 0); _ = observe("foreign-system-zero")
        setSystemCornerRadiusOnly(wid, 32); _ = observe("foreign-system-large")
        _ = request("corner-restore"); _ = observe("final-corner-restored")
        _ = request("quit"); child.waitUntilExit(); finish(child.terminationStatus)
    }
    for name in ["corner-native-zero", "corner-restore", "corner-native-small", "corner-restore", "corner-zero", "corner-large", "corner-restore"] {
        _ = request(name); _ = observe("owner-" + name + "-\(UUID().uuidString)")
    }
    setCornerRadius(wid, 0); _ = observe("foreign-corner-zero")
    setCornerRadius(wid, 32); _ = observe("foreign-corner-large")
    _ = request("corner-restore"); _ = observe("final-corner-restored")
    _ = request("quit"); child.waitUntilExit(); finish(child.terminationStatus)
}
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
