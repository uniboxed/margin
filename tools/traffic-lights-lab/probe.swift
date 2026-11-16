// Research only. Never linked into Margin.app. See README.md for ABI and evidence limits.
import AppKit
import ApplicationServices
import ObjectiveC.runtime
import Darwin

setbuf(stdout, nil)
var ownedChild: Process?
func emit(_ row: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
}
func require(_ condition: Bool, _ reason: String) {
    if !condition {
        emit(["kind": "refused", "reason": reason])
        if let child = ownedChild, child.isRunning { child.terminate(); child.waitUntilExit() }
        exit(2)
    }
}
let arguments = CommandLine.arguments
guard arguments.contains("--run") || arguments.contains("--fixture") else {
    emit(["kind": "plan", "description": "Create one transparent, nonactivating off-screen window in an owned child; inspect and attempt AX button attributes; compare foreign/owner clip readback; test private AppKit reveal; restore and close. No browser or user window is changed."])
    exit(0)
}
// Signatures/disassembly were checked on this exact build. Do not silently extend this gate.
var buildSize = 0
sysctlbyname("kern.osversion", nil, &buildSize, nil, 0)
var buildBytes = [CChar](repeating: 0, count: max(1, buildSize))
sysctlbyname("kern.osversion", &buildBytes, &buildSize, nil, 0)
require(String(cString: buildBytes) == "25G342", "private ABI checked only on 25G342")
DispatchQueue.global().asyncAfter(deadline: .now() + 20) { _exit(3) }
let sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)!
let cg = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW)!
let axLibrary = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_NOW)!
func fn<T>(_ handle: UnsafeMutableRawPointer, _ name: String, _ type: T.Type) -> T {
    guard let symbol = dlsym(handle, name) else { emit(["kind": "refused", "symbol": name]); exit(2) }
    return unsafeBitCast(symbol, to: type)
}
typealias Main = @convention(c) () -> UInt32
typealias CopyClip = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UnsafeMutableRawPointer?>) -> Int32
typealias SetClip = @convention(c) (UInt32, UInt32, UnsafeMutableRawPointer?) -> Int32
typealias NewRegion = @convention(c) (UnsafePointer<CGRect>, UnsafeMutablePointer<UnsafeMutableRawPointer?>) -> Int32
typealias Bounds = @convention(c) (UnsafeMutableRawPointer, UnsafeMutablePointer<CGRect>) -> Int32
typealias Release = @convention(c) (UnsafeMutableRawPointer) -> Void
let cid = fn(sky, "SLSMainConnectionID", Main.self)()
let copyClip = fn(sky, "SLSCopyWindowClipShape", CopyClip.self)
let setClip = fn(sky, "SLSSetWindowClipShape", SetClip.self)
let newRegion = fn(cg, "CGSNewRegionWithRect", NewRegion.self)
let bounds = fn(cg, "CGSGetRegionBounds", Bounds.self)
let release = fn(cg, "CGRegionRelease", Release.self)
func clip(_ wid: UInt32) -> [String: Any] {
    var region: UnsafeMutableRawPointer?
    let result = copyClip(cid, wid, &region)
    var row: [String: Any] = ["result": result, "region": region != nil]
    if let region {
        defer { release(region) }
        var rect = CGRect.zero
        row["boundsResult"] = bounds(region, &rect)
        row["bounds"] = NSStringFromRect(rect)
    }
    return row
}
func region() -> UnsafeMutableRawPointer {
    // Deliberately excludes the top 50 pt: a shape control, not selective button hiding.
    var rect = CGRect(x: 0, y: 50, width: 600, height: 380)
    var value: UnsafeMutableRawPointer?
    require(newRegion(&rect, &value) == 0 && value != nil, "create region")
    return value!
}
func read(_ element: AXUIElement, _ key: String) -> (AXError, CFTypeRef?) {
    var value: CFTypeRef?
    return (AXUIElementCopyAttributeValue(element, key as CFString, &value), value)
}

if let flag = arguments.firstIndex(of: "--fixture"), arguments.count > flag + 1 {
    let marker = arguments[flag + 1]
    class FixtureWindow: NSWindow {
        override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
    }
    NSApplication.shared.setActivationPolicy(.accessory)
    NSApplication.shared.finishLaunching()
    let window = FixtureWindow(contentRect: NSRect(x: -20000, y: -20000, width: 600, height: 400),
        styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.alphaValue = 0
    window.ignoresMouseEvents = true
    window.animationBehavior = .none
    window.setFrame(NSRect(x: -20000, y: -20000, width: 600, height: 430), display: false)
    func geometry() {
        require(window.alphaValue == 0 && NSScreen.screens.allSatisfy { !$0.frame.intersects(window.frame) }, "fixture must remain invisible and off screen")
    }
    geometry(); window.orderFront(nil); geometry()
    let wid = UInt32(window.windowNumber)
    let frame = window.contentView!.superview!
    let set = NSSelectorFromString("setButtonRevealAmount:"), get = NSSelectorFromString("buttonRevealAmount")
    require(frame.responds(to: set) && frame.responds(to: get), "private reveal selectors absent")
    let setter = class_getInstanceMethod(type(of: frame), set)!, getter = class_getInstanceMethod(type(of: frame), get)!
    require(String(cString: method_getTypeEncoding(setter)!) == "v24@0:8d16", "private setter ABI changed")
    require(String(cString: method_getTypeEncoding(getter)!) == "d16@0:8", "private getter ABI changed")
    typealias Set = @convention(c) (AnyObject, Selector, Double) -> Void
    typealias Get = @convention(c) (AnyObject, Selector) -> Double
    let setReveal = unsafeBitCast(method_getImplementation(setter), to: Set.self)
    let getReveal = unsafeBitCast(method_getImplementation(getter), to: Get.self)
    let original = getReveal(frame, get)
    func snapshot(_ phase: String) {
        RunLoop.main.run(until: Date().addingTimeInterval(0.1)); geometry()
        let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].map { type -> [String: Any] in
            let button = window.standardWindowButton(type)!
            return ["type": type.rawValue, "alpha": button.alphaValue, "hidden": button.isHiddenOrHasHiddenAncestor,
                    "enabled": button.isEnabled, "frame": NSStringFromRect(button.frame),
                    "nativeHit": button.superview?.hitTest(NSPoint(x: button.frame.midX, y: button.frame.midY)) === button]
        }
        emit(["kind": "fixture", "phase": phase, "window": wid, "pid": getpid(), "windowed": !window.styleMask.contains(.fullScreen),
              "frameClass": NSStringFromClass(type(of: frame)), "reveal": getReveal(frame, get), "buttons": buttons, "clip": clip(wid)])
    }
    snapshot("ready")
    let deadline = Date().addingTimeInterval(12)
    let request = URL(fileURLWithPath: marker + "-request"), response = URL(fileURLWithPath: marker + "-response")
    while !FileManager.default.fileExists(atPath: marker) && Date() < deadline {
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        if let command = try? String(contentsOf: request, encoding: .utf8) {
            try? FileManager.default.removeItem(at: request)
            snapshot(command)
            try! Data(command.utf8).write(to: response, options: .atomic)
        }
    }
    guard FileManager.default.fileExists(atPath: marker) else { window.close(); emit(["kind": "fixture-timeout"]); exit(2) }
    snapshot("after-external-attempts")
    setReveal(frame, set, 0); snapshot("private-reveal-zero")
    window.setContentSize(NSSize(width: 650, height: 430)); snapshot("private-reveal-zero-resized")
    setReveal(frame, set, original); snapshot("private-reveal-restored")
    // A narrower private setter: hide just the three NSButton views, preserving the title.
    let hide = NSSelectorFromString("_setHidden:setNeedsDisplay:")
    typealias Hide = @convention(c) (AnyObject, Selector, Bool, Bool) -> Void
    let find = NSSelectorFromString("_findStandardWindowButton:")
    guard let findMethod = class_getInstanceMethod(type(of: window), find) else { require(false, "private button lookup absent"); exit(2) }
    require(String(cString: method_getTypeEncoding(findMethod)!) == "@24@0:8Q16", "private button lookup ABI changed")
    typealias Find = @convention(c) (AnyObject, Selector, UInt) -> Unmanaged<AnyObject>?
    let findButton = unsafeBitCast(method_getImplementation(findMethod), to: Find.self)
    let buttons = [UInt(0), 1, 2].map { number -> NSButton in
        guard let button = findButton(window, find, number)?.takeUnretainedValue() as? NSButton else { require(false, "private button lookup failed"); exit(2) }
        return button
    }
    let oldHidden = buttons.map { $0.isHidden }
    for button in buttons {
        guard let method = class_getInstanceMethod(type(of: button), hide) else { require(false, "private hidden setter missing"); exit(2) }
        require(String(cString: method_getTypeEncoding(method)!) == "v24@0:8B16B20", "private hidden setter ABI changed")
        unsafeBitCast(method_getImplementation(method), to: Hide.self)(button, hide, true, true)
    }
    snapshot("private-buttons-hidden")
    window.setContentSize(NSSize(width: 700, height: 450)); snapshot("private-buttons-hidden-resized")
    for (button, wasHidden) in zip(buttons, oldHidden) {
        let method = class_getInstanceMethod(type(of: button), hide)!
        unsafeBitCast(method_getImplementation(method), to: Hide.self)(button, hide, wasHidden, true)
    }
    snapshot("private-buttons-restored")
    var saved: UnsafeMutableRawPointer?
    require(copyClip(cid, wid, &saved) == 0, "save owner clip")
    let mask = region()
    let result = setClip(cid, wid, mask)
    snapshot("owner-clip-set")
    emit(["kind": "owner-clip-call", "result": result])
    let restore = setClip(cid, wid, saved)
    snapshot("owner-clip-restored")
    emit(["kind": "owner-clip-restore-call", "result": restore])
    release(mask); if let saved { release(saved) }
    window.close()
    emit(["kind": "fixture-cleanup", "windowClosed": !window.isVisible])
    exit(0)
}

require(AXIsProcessTrusted(), "Accessibility permission required; no prompt requested")
emit(["kind": "environment", "os": ProcessInfo.processInfo.operatingSystemVersionString, "trusted": AXIsProcessTrusted()])
let directory = FileManager.default.temporaryDirectory.appendingPathComponent("margin-traffic-lights-" + UUID().uuidString)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
defer { try? FileManager.default.removeItem(at: directory) }
let marker = directory.appendingPathComponent("continue").path
let child = Process(), output = Pipe()
child.executableURL = URL(fileURLWithPath: arguments[0]).standardizedFileURL
child.arguments = ["--fixture", marker]; child.standardOutput = output
try child.run()
ownedChild = child
defer { if child.isRunning { child.terminate(); child.waitUntilExit() } }
let first = output.fileHandleForReading.availableData
guard let row = try? JSONSerialization.jsonObject(with: first) as? [String: Any], row["phase"] as? String == "ready",
      let wid = row["window"] as? UInt32 else { emit(["kind": "bad-fixture", "output": String(decoding: first, as: UTF8.self)]); exit(2) }
print(String(decoding: first, as: UTF8.self), terminator: "")
typealias Owner = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>) -> Int32
typealias PID = @convention(c) (UInt32, UnsafeMutablePointer<pid_t>) -> Int32
var owner: UInt32 = 0, ownerPid: pid_t = 0
require(fn(sky, "SLSGetWindowOwner", Owner.self)(cid, wid, &owner) == 0 &&
        fn(sky, "SLSConnectionGetPID", PID.self)(owner, &ownerPid) == 0 && ownerPid == child.processIdentifier,
        "foreign window must belong to the exact child")
let application = AXUIElementCreateApplication(child.processIdentifier)
AXUIElementSetMessagingTimeout(application, 0.5)
let (wr, values) = read(application, "AXWindows")
emit(["kind": "ax-discovery", "result": wr.rawValue, "count": (values as? [AXUIElement])?.count ?? 0])
typealias AXWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<UInt32>) -> AXError
let getWindow = fn(axLibrary, "_AXUIElementGetWindow", AXWindow.self)
let window = (values as? [AXUIElement] ?? []).first { var number: UInt32 = 0; return getWindow($0, &number) == .success && number == wid }
require(wr == .success && window != nil, "exact fixture AX window unavailable")
let w = window!
func targetSnapshot(_ phase: String) {
    let request = URL(fileURLWithPath: marker + "-request"), response = URL(fileURLWithPath: marker + "-response")
    try? FileManager.default.removeItem(at: response)
    try! Data(phase.utf8).write(to: request, options: .atomic)
    let deadline = Date().addingTimeInterval(1.5)
    while Date() < deadline {
        if (try? String(contentsOf: response, encoding: .utf8)) == phase { return }
        Thread.sleep(forTimeInterval: 0.01)
    }
    require(false, "native fixture readback timed out")
}
for name in ["AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"] {
    let (result, value) = read(w, name)
    guard result == .success, let value, CFGetTypeID(value) == AXUIElementGetTypeID() else {
        emit(["kind": "ax-button-absent", "button": name, "result": result.rawValue]); continue
    }
    let button = value as! AXUIElement
    var attributes: CFArray?, actions: CFArray?
    let ar = AXUIElementCopyAttributeNames(button, &attributes), acr = AXUIElementCopyActionNames(button, &actions)
    emit(["kind": "ax-button", "button": name, "attributesResult": ar.rawValue, "attributes": attributes as? [String] ?? [],
          "actionsResult": acr.rawValue, "actions": actions as? [String] ?? []])
    for key in ["AXHidden", "AXVisible", "AXEnabled", "AXPosition", "AXSize", "AXValue", "AXAlpha"] {
        var settable: DarwinBoolean = false
        let sr = AXUIElementIsAttributeSettable(button, key as CFString, &settable)
        let (rr, original) = read(button, key)
        var state: [String: Any] = ["kind": "ax-attribute", "button": name, "attribute": key, "settableResult": sr.rawValue,
                                  "settable": settable.boolValue, "readResult": rr.rawValue]
        // Only this owned disposable target: attempt visibility/enable changes even if reported unsupported.
        if key == "AXHidden" || key == "AXVisible" || key == "AXEnabled" {
            let desired = key == "AXHidden"
            let write = AXUIElementSetAttributeValue(button, key as CFString, desired ? kCFBooleanTrue : kCFBooleanFalse)
            state["writeResult"] = write.rawValue
            if write == .success {
                targetSnapshot("external-\(name)-\(key)")
                let restoreValue = original ?? (key == "AXHidden" ? kCFBooleanFalse : kCFBooleanTrue)!
                state["restoreResult"] = AXUIElementSetAttributeValue(button, key as CFString, restoreValue).rawValue
                targetSnapshot("restored-\(name)-\(key)")
            }
        }
        emit(state)
    }
}
var windowAttributes: CFArray?
_ = AXUIElementCopyAttributeNames(w, &windowAttributes)
emit(["kind": "ax-window-attributes", "attributes": windowAttributes as? [String] ?? []])
let before = clip(wid), mask = region()
let foreignResult = setClip(cid, wid, mask)
let after = clip(wid)
release(mask)
emit(["kind": "foreign-clip", "result": foreignResult, "before": before, "after": after])
try Data().write(to: URL(fileURLWithPath: marker))
let rest = output.fileHandleForReading.readDataToEndOfFile()
print(String(decoding: rest, as: UTF8.self), terminator: "")
child.waitUntilExit()
emit(["kind": "cleanup", "childExit": child.terminationStatus, "childRunning": child.isRunning])
require(child.terminationStatus == 0, "fixture failed; preserve this run as failed")
