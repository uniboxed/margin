// margin-helper: the one part of Margin that runs all the time (decided 2026-11-10: not the whole app). Started at
// login by launchd (Margin.app registers it: SMAppService.agent, com.unibox.margin.helper.plist), it waits for a
// browser Margin works in to open, and then starts Margin.app in the background, so Margin is up (about 0.3 s)
// long before the browser's extension asks for its link (about 3 s after the browser opens). The resident process
// never connects to the window server: no windows, no polling, no WebKit. For a browser just opening it spawns
// this executable's short-lived --splash mode alongside Margin.app. Only that child pays AppKit's window cost;
// it exits when the app draws, the browser goes, the person switches away, or after six seconds at most.
// Margin.app quits by itself when no browser needs it (AppDelegate.swift).
//
// Margin.app is this program's bundle: …/Margin.app/Contents/Helpers/margin-helper. MARGIN_HELPER_APP and
// MARGIN_HELPER_BROWSERS (comma-separated bundle ids) are for the app's tests only.

import AppKit
import os

let logger = Logger(subsystem: "com.unibox.margin", category: "helper")
func log(_ line: String) {
    logger.notice("\(line, privacy: .public)")
    FileHandle.standardError.write(Data("margin-helper: \(line)\n".utf8))
}

// Cosmetic handoff only: browser pid, no profile, page title, URL or link credentials. The query handles the
// app drawing before the splash has installed its listener. Same names as HelperSplash in Overlay.swift.
// A window the size of a display: a full-screen one. Margin draws only over those, so a splash over a window in a
// window would show its 6 s with nothing after it (2026-11-11: Safari opened in a normal window).
func fillsADisplay(_ bounds: CGRect) -> Bool {
    NSScreen.screens.contains { abs($0.frame.width - bounds.width) < 1 && abs($0.frame.height - bounds.height) < 1 }
}
let splashReady = Notification.Name("com.unibox.margin.startup.ready")
let splashQuery = Notification.Name("com.unibox.margin.startup.query")

// The browsers Margin works in (AppDelegate.swift `browsers`: the same list).
let browsers: Set<String> = ProcessInfo.processInfo.environment["MARGIN_HELPER_BROWSERS"].map { Set($0.split(separator: ",").map(String.init)) }
    ?? ["com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.google.Chrome", "com.microsoft.edgemac"]

func runSplash(browser: NSRunningApplication) -> Never {
    let began = ProcessInfo.processInfo.systemUptime
    let testing = ProcessInfo.processInfo.environment["MARGIN_HELPER_SPLASH_TEST"] == "1"
    let center = DistributedNotificationCenter.default()
    // Register before connecting to AppKit or making a window. A ready message queued meanwhile will be
    // delivered once the run loop starts; the query below also covers a ready message sent before we started.
    var windowNumber: Int?
    var drawnWindows: Set<Int> = []
    let ready = center.addObserver(forName: splashReady, object: nil, queue: .main) { note in
        guard let object = note.object as? String, object.hasPrefix("\(browser.processIdentifier):"),
              let number = Int(object.split(separator: ":").last ?? "") else { return }
        drawnWindows.insert(number)
        guard windowNumber == number else { return }
        log("splash ended: app drew, \(Int((ProcessInfo.processInfo.systemUptime - began) * 1000)) ms")
        exit(0)
    }
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    let size = NSSize(width: 440, height: 190)
    let panel = NSPanel(contentRect: NSRect(origin: NSPoint(x: -20000, y: -20000), size: size),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.isReleasedWhenClosed = false
    panel.hidesOnDeactivate = false
    panel.ignoresMouseEvents = true
    panel.animationBehavior = .none
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = true
    let view = NSView(frame: NSRect(origin: .zero, size: size))
    view.wantsLayer = true
    view.layer?.cornerRadius = 16
    let dark = application.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    view.layer?.backgroundColor = NSColor(calibratedWhite: dark ? 0.11 : 0.96, alpha: 1).cgColor
    func label(_ text: String, y: CGFloat, font: NSFont, color: NSColor) {
        let field = NSTextField(labelWithString: text)
        field.font = font
        field.textColor = color
        field.alignment = .center
        field.frame = NSRect(x: 20, y: y, width: size.width - 40, height: 28)
        view.addSubview(field)
    }
    label("Margin", y: 132, font: .systemFont(ofSize: 13, weight: .semibold), color: .secondaryLabelColor)
    label("Getting things ready for you", y: 91, font: .systemFont(ofSize: 20, weight: .semibold), color: .labelColor)
    let progress = NSProgressIndicator(frame: NSRect(x: size.width / 2 - 10, y: 47, width: 20, height: 20))
    progress.style = .spinning
    progress.isIndeterminate = true
    progress.isDisplayedWhenStopped = true
    view.addSubview(progress)
    if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { progress.startAnimation(nil) }
    panel.contentView = view
    var shown = false
    let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
        let elapsed = ProcessInfo.processInfo.systemUptime - began
        if browser.isTerminated || elapsed >= 6 || (shown && !testing && NSWorkspace.shared.frontmostApplication?.processIdentifier != browser.processIdentifier) {
            log("splash ended: \(browser.isTerminated ? "browser quit" : elapsed >= 6 ? "timeout" : "switched away"), \(Int(elapsed * 1000)) ms")
            exit(0)
        }
        guard testing || NSWorkspace.shared.frontmostApplication?.processIdentifier == browser.processIdentifier,
              let list = CGWindowListCopyWindowInfo(testing ? [.optionAll, .excludeDesktopElements] : [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              let window = list.first(where: {
                  ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == browser.processIdentifier
                      && ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
                      && ($0[kCGWindowBounds as String] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) }.map(fillsADisplay) == true
              }), let bounds = (window[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) }),
              let number = (window[kCGWindowNumber as String] as? NSNumber)?.intValue else { return }
        windowNumber = number
        if drawnWindows.contains(number) { log("splash ended: app drew before its window was found"); exit(0) }
        // Window metadata only, no Accessibility or Screen Recording permission. A small passive card before
        // profile identification; the app owns the profile-specific full-window cover and the final layout.
        let frame = NSRect(x: bounds.midX - size.width / 2,
                           y: (NSScreen.screens.first?.frame.height ?? 0) - bounds.midY - size.height / 2,
                           width: size.width, height: size.height)
        if testing && NSScreen.screens.contains(where: { $0.frame.intersects(frame) }) { log("splash test refused an on-screen frame"); exit(2) }
        if panel.frame != frame { panel.setFrame(frame, display: false) }
        panel.order(.above, relativeTo: number)
        if !shown {
            panel.displayIfNeeded()
            log("splash shown in \(Int((ProcessInfo.processInfo.systemUptime - began) * 1000)) ms (pid \(ProcessInfo.processInfo.processIdentifier))")
            if testing, let path = ProcessInfo.processInfo.environment["MARGIN_HELPER_SPLASH_SHOT"],
               let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                view.cacheDisplay(in: view.bounds, to: bitmap)
                try? bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
            }
        }
        shown = true
    }
    center.postNotificationName(splashQuery, object: String(browser.processIdentifier), userInfo: nil, deliverImmediately: true)
    withExtendedLifetime((ready, timer, panel)) { application.run() }
    exit(0)
}

if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--splash",
   let pid = pid_t(CommandLine.arguments[2]), pid > 0, let browser = NSRunningApplication(processIdentifier: pid),
   browser.bundleIdentifier.map(browsers.contains) == true {
    runSplash(browser: browser)
}
guard CommandLine.arguments.count == 1 else { exit(2) }

// (Its own path as the system knows it: launchd starts it by the agent's BundleProgram, a path relative to the
// bundle, so argv[0] is no way to find Margin.app.)
let app: URL = ProcessInfo.processInfo.environment["MARGIN_HELPER_APP"].map { URL(fileURLWithPath: $0) }
    ?? URL(fileURLWithPath: Bundle.main.executablePath ?? CommandLine.arguments[0]).standardizedFileURL.resolvingSymlinksInPath()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent() // Helpers → Contents → Margin.app
let appId = Bundle(url: app)?.bundleIdentifier ?? "com.unibox.margin"

// Margin.app, in the background (never activated, no window: --background), unless it's running already. One
// start at a time: LaunchServices hands a second open of a starting app the instance that's starting.
var startedAt = Date.distantPast
var splashProcess: Process?
func startMargin(_ why: String, browser: NSRunningApplication, splash: Bool) {
    guard NSRunningApplication.runningApplications(withBundleIdentifier: appId).allSatisfy(\.isTerminated),
          Date().timeIntervalSince(startedAt) > 2 else { return }
    startedAt = Date()
    if splash {
        if splashProcess?.isRunning == true { splashProcess?.terminate() }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: Bundle.main.executablePath ?? CommandLine.arguments[0])
        child.arguments = ["--splash", String(browser.processIdentifier)]
        child.standardInput = FileHandle.nullDevice
        do { try child.run(); splashProcess = child; log("started splash pid \(child.processIdentifier) for browser \(browser.processIdentifier)") }
        catch { log("couldn't start the splash: \(error.localizedDescription)") }
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.addsToRecentItems = false
    configuration.promptsUserIfNeeded = false
    configuration.arguments = ["--background"]
    NSWorkspace.shared.openApplication(at: app, configuration: configuration) { running, error in
        if let error { log("couldn't start Margin.app (\(why)): \(error.localizedDescription)") }
        else { log("started Margin.app (\(why)), pid \(running?.processIdentifier ?? 0)") }
    }
}

// Not inside Margin.app: nothing to start, and a clean exit (the agent's KeepAlive starts it again only after a crash).
guard app.pathExtension == "app" else {
    log("not inside Margin.app (\(app.path)): nothing to start")
    exit(0)
}
// A browser open already (the helper started after it, or launchd started it again): at once.
if let open = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier.map(browsers.contains) ?? false }) {
    startMargin("\(open.bundleIdentifier ?? "a browser") is open", browser: open,
                splash: open.launchDate.map { Date().timeIntervalSince($0) < 10 } ?? false)
}
// Each app that starts (NSWorkspace's runningApplications, observed: its launch notifications reach only a process
// connected as an app, which would cost this one 50 MB; this costs nothing between launches).
var seen = Set(NSWorkspace.shared.runningApplications.map(\.processIdentifier))
let observer = NSWorkspace.shared.observe(\.runningApplications, options: [.new]) { _, change in
    let list = change.newValue ?? []
    DispatchQueue.main.async { MainActor.assumeIsolated {
        let new = list.filter { !seen.contains($0.processIdentifier) && $0.bundleIdentifier.map(browsers.contains) == true }
        seen = Set(list.map(\.processIdentifier))
        guard let browser = new.first else { return }
        startMargin("\(browser.bundleIdentifier ?? "a browser") opened", browser: browser, splash: true)
    } }
}
log("watching for browser launches")
withExtendedLifetime(observer) { RunLoop.main.run() }
