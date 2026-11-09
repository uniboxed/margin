// Margin's relay helper (docs/PROTOCOL.md "Transport (Chrome and Edge, on the Mac)"): Chrome and Edge start it for
// Margin's extension through native messaging (the host file Margin.app writes, engines/chromium/app/ChromiumHosts.swift),
// one per native port and one per one-off message. It passes the browser's messages to the running Margin.app over
// its relay socket (app/macos/shell/RelayLink.swift) and Margin.app's back, as Safari's extension handler does for
// Safari: the link itself is then the copy's WebSocket to the app, as Safari's.
//
// The browser's framing on stdin and stdout: a 4-byte length in the Mac's byte order, then that much UTF-8 JSON.
// To the app: JSON lines, its hello first. Margin.app not running: started (in the background, never activated),
// and each message answered here as Safari's handler does then; a native port's relay waits for the app, and says
// so in its hello once in (the app then says `appUp` to it). A Margin.app of another version answers: this relay
// exits (the browser starts the new one with the next port or message).
//
// Built into Margin.app/Contents/Helpers/margin-relay by scripts/safari.sh, signed as io.tirth.margin.relay.
// For the tests: MARGIN_RELAY_SOCKET (another socket path), MARGIN_RELAY_NO_LAUNCH (never start the app),
// MARGIN_RELAY_BROWSER and MARGIN_RELAY_VERSION (what it says it is).

import AppKit
import Foundation

let environment = ProcessInfo.processInfo.environment
let socketPath = environment["MARGIN_RELAY_SOCKET"]
    ?? (FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("Margin/relay.sock").path
        ?? NSHomeDirectory() + "/Library/Application Support/Margin/relay.sock")

// Margin.app/Contents/Helpers/margin-relay → Margin.app.
let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
let appBundle = executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
let version: String = {
    if let forced = environment["MARGIN_RELAY_VERSION"] { return forced } // (the tests)
    let info = appBundle.appendingPathComponent("Contents/Info.plist")
    guard let plist = NSDictionary(contentsOf: info) else { return "" }
    return plist["CFBundleVersion"] as? String ?? ""
}()

// The browser that started it: its parent process (Chrome's and Edge's browser process starts native hosts).
let parent = getppid()
let browser: String = {
    if let forced = environment["MARGIN_RELAY_BROWSER"], forced == "chrome" || forced == "edge" { return forced }
    let id = NSRunningApplication(processIdentifier: parent)?.bundleIdentifier ?? ""
    return id.lowercased().contains("edge") ? "edge" : "chrome"
}()

// A browser that closed its end (a one-off message answered, the dispatch after it arriving late): writes fail,
// never a signal.
signal(SIGPIPE, SIG_IGN)
let outLock = NSLock()
func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { raw -> Bool in
        var at = 0
        while at < raw.count {
            let n = write(fd, raw.baseAddress! + at, raw.count - at)
            if n <= 0 { return false }
            at += n
        }
        return true
    }
}
// One message to the browser.
func toBrowser(_ json: Data) {
    var length = UInt32(json.count)
    outLock.lock()
    defer { outLock.unlock() }
    if !writeAll(STDOUT_FILENO, Data(bytes: &length, count: 4) + json) { exit(0) } // the browser's end is gone
}
func toBrowser(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object) { toBrowser(data) }
}

// ---- the app's socket ----

let appLock = NSLock()
var appFD: Int32 = -1
var waited = false
var launchedAt: Date?

func connectToApp() -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return -1 }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(socketPath.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { close(fd); return -1 }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in for (i, b) in bytes.enumerated() { raw[i] = b } }
    let ok = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    if ok != 0 { close(fd); return -1 }
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    return fd
}

func writeLine(_ fd: Int32, _ object: [String: Any]) -> Bool {
    guard var data = try? JSONSerialization.data(withJSONObject: object) else { return false }
    data.append(0x0A)
    return writeAll(fd, data)
}

// Margin.app, started in the background (as Safari's handler starts it), at most once per 10 s.
func launchApp() -> Bool {
    if environment["MARGIN_RELAY_NO_LAUNCH"] != nil { return false }
    if let at = launchedAt, Date().timeIntervalSince(at) < 10 { return true }
    guard appBundle.pathExtension == "app" else { return false }
    launchedAt = Date()
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.addsToRecentItems = false
    configuration.promptsUserIfNeeded = false
    NSWorkspace.shared.openApplication(at: appBundle, configuration: configuration) { _, _ in }
    return true
}

// Linked to the app: hello, then its welcome read (a version that isn't this one's: exit). The reader thread
// passes the app's lines to the browser from then on. False if the app isn't there.
func link() -> Bool {
    let fd = connectToApp()
    guard fd >= 0 else { return false }
    guard writeLine(fd, ["k": "relay", "v": 1, "version": version, "pid": Int(parent), "browser": browser, "waited": waited]) else { close(fd); return false }
    appLock.lock()
    appFD = fd
    appLock.unlock()
    Thread.detachNewThread { readApp(fd) }
    return true
}

func readApp(_ fd: Int32) {
    var buffer = [UInt8](repeating: 0, count: 65536)
    var pending = Data()
    var welcomed = false
    while true {
        let n = read(fd, &buffer, buffer.count)
        if n <= 0 { break }
        pending.append(buffer, count: n)
        while let end = pending.firstIndex(of: 0x0A) {
            let line = Data(pending[pending.startIndex..<end])
            pending = Data(pending[pending.index(after: end)...])
            if !welcomed {
                welcomed = true
                let welcome = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
                if welcome?["k"] as? String == "relayWelcome" {
                    let theirs = welcome?["version"] as? String ?? ""
                    if !theirs.isEmpty, !version.isEmpty, theirs != version { exit(0) } // another Margin.app: the browser starts the new relay
                    continue
                }
            }
            toBrowser(line)
        }
    }
    // The app went (it quit, or was replaced): waited for again.
    appLock.lock()
    if appFD == fd { appFD = -1 }
    appLock.unlock()
    close(fd)
    waited = true
}

// The app's socket, or -1. Tried again on each message, and every 250 ms by the waiting thread: one at a time.
let linking = NSLock()
func appSocket() -> Int32 {
    linking.lock()
    defer { linking.unlock() }
    appLock.lock()
    let fd = appFD
    appLock.unlock()
    if fd >= 0 { return fd }
    guard link() else { return -1 }
    appLock.lock()
    defer { appLock.unlock() }
    return appFD
}

// ---- the browser's messages ----

func readExactly(_ count: Int) -> Data? {
    var data = Data()
    while data.count < count {
        let chunk = FileHandle.standardInput.readData(ofLength: count - data.count)
        if chunk.isEmpty { return nil }
        data.append(chunk)
    }
    return data
}

// While the app isn't linked: what Safari's handler answers then (the copy asks again; the app says appUp once in).
func answerWithoutApp(_ message: [String: Any]) {
    let launching = message["type"] as? String == "wantLink" ? launchApp() : false
    waited = true
    toBrowser(["ok": true, "appOpen": false, "launching": launching, "browser": browser, "pid": Int(parent)])
}

// The app, waited for in the background while the browser keeps this relay (its native port).
Thread.detachNewThread {
    while true {
        _ = appSocket()
        Thread.sleep(forTimeInterval: 0.25)
    }
}

while let header = readExactly(4) {
    let length = header.withUnsafeBytes { Int($0.loadUnaligned(as: UInt32.self)) }
    guard length > 0, length <= 64 << 20, let body = readExactly(length) else { break }
    guard let message = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { continue }
    let fd = appSocket()
    if fd < 0 || !writeLine(fd, ["msg": message]) { answerWithoutApp(message) }
}
// The browser closed its end (the port went, or a one-off message was answered).
exit(0)
