// An opt-in browser attribute test. All mutations are AX calls against one disposable browser PID.
import AppKit
import ApplicationServices
import Darwin

setbuf(stdout, nil)
func emit(_ row: [String: Any]) {
    print(String(decoding: try! JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), as: UTF8.self))
}
let args = CommandLine.arguments
guard let executableIndex = args.firstIndex(of: "--executable"), args.count > executableIndex + 1 else {
    emit(["kind": "usage", "description": "Pass --executable /absolute/path/to/browser [--run]. Default is dry run."]); exit(0)
}
let executable = URL(fileURLWithPath: args[executableIndex + 1]).standardizedFileURL
let libraryIndex = args.firstIndex(of: "--launch-library")
let launchLibrary = libraryIndex.flatMap { args.count > $0 + 1 ? args[$0 + 1] : nil }
guard args.contains("--run") else {
    emit(["kind": "plan", "executable": executable.path, "launchLibrary": launchLibrary ?? "none", "description": "Launch once with a temporary profile and about:blank; inspect/restore AX attributes; close only the owned window/PID and restore focus. Default has no injected code; optional --launch-library separately tests launch-loader acceptance without sending component commands."])
    exit(0)
}
guard AXIsProcessTrusted(), FileManager.default.isExecutableFile(atPath: executable.path) else {
    emit(["kind": "refused", "reason": "AX permission and browser executable required"]); exit(2)
}
let former = NSWorkspace.shared.frontmostApplication?.processIdentifier
let directory = FileManager.default.temporaryDirectory.appendingPathComponent("margin-button-browser-" + UUID().uuidString)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
let browser = Process()
browser.executableURL = executable
browser.arguments = ["--user-data-dir=" + directory.path, "--no-first-run", "--no-default-browser-check",
                     "--disable-background-networking", "--disable-sync", "--disable-default-apps", "--disable-extensions",
                     "--window-size=800,600", "--new-window", "about:blank"]
browser.standardOutput = FileHandle.nullDevice; browser.standardError = FileHandle.nullDevice
if let launchLibrary {
    guard FileManager.default.isReadableFile(atPath: launchLibrary) else { emit(["kind": "refused", "reason": "launch library missing"]); exit(2) }
    var environment = ProcessInfo.processInfo.environment
    environment["DYLD_INSERT_LIBRARIES"] = launchLibrary
    environment["MARGIN_BUTTONS_TARGET_EXECUTABLE"] = executable.path
    environment["MARGIN_BUTTONS_DIR"] = directory.path
    browser.environment = environment
}
try browser.run()
// Bound cleanup, including abnormal control-flow exits. Only the exact launched process is signalled.
let ownedPID = browser.processIdentifier
DispatchQueue.global().asyncAfter(deadline: .now() + 18) {
    if browser.isRunning { browser.terminate() }
}
func read(_ element: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
    var value: CFTypeRef?
    return (AXUIElementCopyAttributeValue(element, name as CFString, &value), value)
}
func finish(_ status: Int32) -> Never {
    if browser.isRunning { browser.terminate(); browser.waitUntilExit() }
    if let former, former != ownedPID {
        let app = AXUIElementCreateApplication(former)
        AXUIElementSetMessagingTimeout(app, 0.5)
        emit(["kind": "focus-restore", "result": AXUIElementSetAttributeValue(app, "AXFrontmost" as CFString, kCFBooleanTrue).rawValue])
    }
    try? FileManager.default.removeItem(at: directory)
    emit(["kind": "cleanup", "pid": ownedPID, "browserRunning": browser.isRunning, "profileRemoved": !FileManager.default.fileExists(atPath: directory.path), "status": status])
    exit(status)
}
let app = AXUIElementCreateApplication(ownedPID)
AXUIElementSetMessagingTimeout(app, 0.5)
let deadline = Date().addingTimeInterval(8)
var windows: [AXUIElement] = []
while browser.isRunning && Date() < deadline {
    windows = read(app, "AXWindows").1 as? [AXUIElement] ?? []
    if !windows.isEmpty { break }
    Thread.sleep(forTimeInterval: 0.1)
}
guard windows.count == 1 else { emit(["kind": "refused", "reason": "expected exactly one owned window", "windows": windows.count]); finish(2) }
let window = windows[0]
if launchLibrary != nil {
    Thread.sleep(forTimeInterval: 1)
    let marker = directory.appendingPathComponent("hook-loaded.json")
    let data = try? Data(contentsOf: marker)
    let row = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    emit(["kind": "launch-loader", "requested": true, "componentLoaded": row?["pid"] as? pid_t == ownedPID])
}
emit(["kind": "browser", "pid": ownedPID, "executable": executable.path, "windowCount": windows.count,
      "fullscreen": read(window, "AXFullScreen").1 as? Bool ?? false, "os": ProcessInfo.processInfo.operatingSystemVersionString])
for name in ["AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"] {
    let (result, value) = read(window, name)
    guard result == .success, let value, CFGetTypeID(value) == AXUIElementGetTypeID() else {
        emit(["kind": "button-absent", "button": name, "result": result.rawValue]); continue
    }
    let button = value as! AXUIElement
    var attributes: CFArray?, actions: CFArray?
    _ = AXUIElementCopyAttributeNames(button, &attributes); _ = AXUIElementCopyActionNames(button, &actions)
    emit(["kind": "button", "button": name, "attributes": attributes as? [String] ?? [], "actions": actions as? [String] ?? []])
    for key in ["AXHidden", "AXEnabled", "AXPosition", "AXSize", "AXValue", "AXAlpha"] {
        var writable: DarwinBoolean = false
        let sr = AXUIElementIsAttributeSettable(button, key as CFString, &writable)
        let (rr, original) = read(button, key)
        var row: [String: Any] = ["kind": "attribute", "button": name, "attribute": key, "settable": writable.boolValue,
                                 "settableResult": sr.rawValue, "readResult": rr.rawValue]
        if key == "AXHidden" || key == "AXEnabled" {
            let wr = AXUIElementSetAttributeValue(button, key as CFString, key == "AXHidden" ? kCFBooleanTrue : kCFBooleanFalse)
            row["writeResult"] = wr.rawValue
            Thread.sleep(forTimeInterval: 0.1)
            let (ar, after) = read(button, key)
            row["afterReadResult"] = ar.rawValue
            if let after = after as? Bool { row["afterBool"] = after }
            if wr == .success {
                let restore = original ?? (key == "AXHidden" ? kCFBooleanFalse : kCFBooleanTrue)!
                let restored = AXUIElementSetAttributeValue(button, key as CFString, restore)
                row["restoreResult"] = restored.rawValue
                guard restored == .success else { emit(row); finish(2) }
            }
        }
        emit(row)
    }
}
emit(["kind": "after", "windowCount": (read(app, "AXWindows").1 as? [AXUIElement])?.count ?? 0,
      "fullscreen": read(window, "AXFullScreen").1 as? Bool ?? false])
if let close = read(window, "AXCloseButton").1, CFGetTypeID(close) == AXUIElementGetTypeID() {
    emit(["kind": "close-owned-window", "result": AXUIElementPerformAction(close as! AXUIElement, "AXPress" as CFString).rawValue])
}
finish(0)
