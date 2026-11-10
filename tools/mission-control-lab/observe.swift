// Bounded read-only metadata fixture. No window creation, UI events, titles, pixels or browser data.
import AppKit
import CoreGraphics
import Darwin

if !CommandLine.arguments.contains("--observe") {
    print("Dry run: --observe samples Safari/Margin/WindowManager geometry for 90 seconds in an accessory NSApplication. No windows, captures, UI events or external mutations.")
    exit(0)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let start = ProcessInfo.processInfo.systemUptime
let lock = NSLock()
func emit(_ kind: String, _ value: [String: Any]) {
    lock.lock(); defer { lock.unlock() }
    var row = value
    row["kind"] = kind
    row["ms"] = Int((ProcessInfo.processInfo.systemUptime - start) * 1000)
    if let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
}
let handle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)
func lookup<T>(_ name: String, _ type: T.Type) -> T? {
    guard let handle, let p = dlsym(handle, name) else { return nil }
    return unsafeBitCast(p, to: type)
}
typealias MainConnection = @convention(c) () -> UInt32
typealias Notify = @convention(c) (UInt32, UnsafeMutableRawPointer?, UInt32, UnsafeMutableRawPointer?, UInt32) -> Void
typealias Register = @convention(c) (UInt32, Notify, UInt32, UnsafeMutableRawPointer?) -> Int32
let notify: Notify = { event, _, size, _, _ in emit("notification", ["event": event, "length": size]) }
let cid = lookup("SLSMainConnectionID", MainConnection.self)?() ?? 0
if let register = lookup("CGSRegisterConnectionNotifyProc", Register.self), cid != 0 {
    for code: UInt32 in [1204, 1327, 1328] { emit("registration", ["event": code, "result": register(cid, notify, code, nil)]) }
}
typealias Bounds = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<CGRect>) -> Int32
typealias Transform = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<CGAffineTransform>) -> Int32
let getBounds = lookup("SLSGetWindowBounds", Bounds.self)
let getTransform = lookup("SLSGetWindowTransform", Transform.self)
func rect(_ r: CGRect) -> [Double] { [r.minX, r.minY, r.width, r.height].map { (Double($0) * 100).rounded() / 100 } }
var previous: Data?
var axObservers: [AXObserver] = []
for bundle in ["com.apple.dock", "com.apple.WindowManager"] {
    for running in NSRunningApplication.runningApplications(withBundleIdentifier: bundle) {
        var observer: AXObserver?
        let result = AXObserverCreate(running.processIdentifier, { _, _, notification, _ in emit("accessibility", ["notification": notification as String]) }, &observer)
        if result == .success, let observer {
            axObservers.append(observer)
            let element = AXUIElementCreateApplication(running.processIdentifier)
            for name in ["AXExposeShowAllWindows", "AXExposeShowFrontWindows", "AXExposeShowDesktop", "AXExposeExit"] {
                emit("ax-registration", ["bundle": bundle, "notification": name, "result": AXObserverAddNotification(observer, element, name as CFString, nil).rawValue])
            }
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        } else { emit("ax-unavailable", ["bundle": bundle, "result": result.rawValue]) }
    }
}
let timer = Timer(timeInterval: 0.05, repeats: true) { _ in
    guard let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], 0) as? [[String: Any]] else { return }
    var rows: [[String: Any]] = []
    for w in list {
        guard let owner = w[kCGWindowOwnerName as String] as? String,
              ["Safari", "Margin", "WindowManager"].contains(owner),
              let raw = w[kCGWindowBounds as String], let r = CGRect(dictionaryRepresentation: raw as! CFDictionary),
              let id = w[kCGWindowNumber as String] as? NSNumber else { continue }
        let layer = (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
        if owner == "WindowManager" { if layer != 19 && layer != 14 { continue } } else if layer != 0 || r.width < 100 || r.height < 80 { continue }
        var rawBounds = CGRect.zero, transform = CGAffineTransform.identity
        let boundsResult = getBounds?(cid, id.uint32Value, &rawBounds) ?? -1
        let transformResult = getTransform?(cid, id.uint32Value, &transform) ?? -1
        rows.append(["baseBounds": rect(rawBounds), "boundsResult": boundsResult, "transformResult": transformResult,
                     "transform": [transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty].map { (Double($0) * 10000).rounded() / 10000 }, "id": id, "owner": owner, "layer": layer, "rect": rect(r),
                     "onScreen": (w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
                     "alpha": (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1])
        if rows.count >= 64 { break }
    }
    let data = try? JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
    if data != previous { previous = data; emit("geometry", ["windows": rows]) }
}
RunLoop.main.add(timer, forMode: .common)
let end = Timer(timeInterval: 90, repeats: false) { _ in
    timer.invalidate()
    emit("finished", ["externalMutations": 0, "createdWindows": 0])
    _exit(0)
}
RunLoop.main.add(end, forMode: .common)
DispatchQueue.global().asyncAfter(deadline: .now() + 95) { _exit(3) }
emit("ready", ["durationSeconds": 90, "pid": ProcessInfo.processInfo.processIdentifier, "uptime": ProcessInfo.processInfo.systemUptime, "windowManager": NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.WindowManager").map { $0.processIdentifier } ])
app.run()
